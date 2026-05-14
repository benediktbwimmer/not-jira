import pg from "pg";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createServices } from "./services.js";
import { createSqliteStore } from "./sqlite-store.js";
import { createPostgresStore } from "./postgres-store.js";
import type { AppStore } from "./store.js";
import type { Activity, InboxEvent, OutboxEvent, Task } from "./types.js";
import { nowIso } from "./types.js";

interface StoreHandle {
  store: AppStore;
  cleanup(): Promise<void>;
}

interface StoreCase {
  name: string;
  create(): Promise<StoreHandle>;
}

const postgresUrl = process.env.UNBLOCK_TEST_POSTGRES_URL;
const handles: StoreHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()?.cleanup();
  }
});

const storeCases: StoreCase[] = [
  {
    name: "sqlite",
    async create() {
      const dir = await mkdtemp(join(tmpdir(), "unblock-parity-sqlite-"));
      const store = createSqliteStore({ databasePath: join(dir, "unblock.sqlite") });
      return track({ store, cleanup: async () => { await store.close?.(); } });
    }
  }
];

if (postgresUrl) {
  storeCases.push({
    name: "postgres",
    async create() {
      return track(await createTemporaryPostgresStore(postgresUrl));
    }
  });
}

describe.each(storeCases)("storage parity: $name", ({ name, create }) => {
  it("preserves the core service contract", async () => {
    const { store } = await create();
    const projectId = `P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const global = createServices(store, { machine: `${name}-machine`, actor: "codex-e" });
    await global.projects.add({ id: projectId, name: `${name} parity` });

    const services = createServices(store, { projectId, machine: `${name}-machine`, actor: "codex-e" });
    await services.tasks.add({ id: "API", title: "API work" });
    await services.tasks.add({ id: "DB", title: "Database work" });
    await services.tasks.add({ id: "API-CHILD", parentTaskId: "API", title: "API child" });
    await services.dependencies.add("API-CHILD", "DB");
    await services.tags.add({ id: "BACKEND", name: "backend" });
    await services.tags.assign("API", ["backend"]);
    await services.tracks.add({ actor: "codex-e", name: "Codex E" });
    await services.tracks.assign("codex-e", "DB");
    await services.instructions.add({ id: "BACKEND-INST", name: "Backend instruction", query: "tag = backend", body: "Use storage parity semantics." });
    await services.comments.add("API", { body: `${name} parity smoke.` });
    await services.views.add({ id: "BACKEND-VIEW", name: "Backend view", query: "tag = backend" });
    await services.feeds.add({ id: "READY-FEED", name: "Ready feed", query: "status = ready" });

    expect((await services.query.match("tag = backend", 10)).map((task) => task.id)).toEqual(["API"]);
    expect(await services.dependencies.list("API-CHILD")).toMatchObject([{ taskId: "API-CHILD", dependsOnTaskId: "DB" }]);
    expect((await services.instructions.matchesForTask("API")).map((match) => match.instruction.id)).toEqual(["BACKEND-INST"]);
    expect(await services.comments.list("API")).toHaveLength(1);
    expect((await services.tracks.list()).map((track) => track.actor)).toEqual(["codex-e"]);
    expect((await services.views.tasks("BACKEND-VIEW", 10)).map((task) => task.id)).toEqual(["API"]);
    expect((await services.feeds.tasks("READY-FEED", 10)).some((task) => task.id === "DB")).toBe(true);
    expect(await services.activity.list({ limit: 20 })).not.toHaveLength(0);
  });

  it("rolls back failed transactional writes", async () => {
    const { store } = await create();
    const projectId = `P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    await createServices(store, { machine: `${name}-machine`, actor: "codex-e" }).projects.add({ id: projectId, name: `${name} rollback` });

    const task = makeTask(projectId, "ROLLBACK");
    const activity = makeActivity(projectId, "rollback.activity");
    await expect(store.transaction(async (repos) => {
      await repos.tasks.create(task);
      await repos.activity.append(activity);
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");

    expect(await store.tasks.get(projectId, "ROLLBACK")).toBeNull();
    expect((await store.activity.list(projectId, 10)).map((item) => item.id)).not.toContain(activity.id);
  });

  it("rejects stale optimistic task mutations", async () => {
    const { store } = await create();
    const projectId = `P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const services = createServices(store, { projectId, machine: `${name}-machine`, actor: "codex-e" });
    await createServices(store, { machine: `${name}-machine`, actor: "codex-e" }).projects.add({ id: projectId, name: `${name} stale writes` });
    await services.tasks.add({ id: "RACE", title: "Race task" });

    const previous = await store.tasks.get(projectId, "RACE");
    expect(previous).not.toBeNull();
    const first = { ...previous!, title: "First writer", updatedAt: nowIso(), version: previous!.version + 1 };
    const second = { ...previous!, title: "Second writer", updatedAt: nowIso(), version: previous!.version + 1 };

    await store.transaction(async (repos) => {
      await repos.tasks.updateWithPrevious?.(previous!, first);
    });
    await expect(store.transaction(async (repos) => {
      await repos.tasks.updateWithPrevious?.(previous!, second);
    })).rejects.toThrow(/version conflict/i);

    expect(await store.tasks.get(projectId, "RACE")).toMatchObject({ title: "First writer", version: first.version });
  });

  it.runIf(name === "postgres")("supports hosted outbox and inbox idempotency plus retry state", async () => {
    const { store } = await create();
    expect(store.capabilities?.outboxInbox).toBe(true);
    expect(store.outbox).toBeDefined();
    expect(store.inbox).toBeDefined();
    const projectId = `P${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    await createServices(store, { machine: `${name}-machine`, actor: "codex-e" }).projects.add({ id: projectId, name: `${name} outbox` });

    const now = nowIso();
    const outboxEvent = makeOutboxEvent(projectId, now);
    const enqueued = await store.outbox!.enqueue(outboxEvent);
    const duplicate = await store.outbox!.enqueue({ ...outboxEvent, id: `${outboxEvent.id}-DUP` });
    expect(duplicate.id).toBe(enqueued.id);
    expect((await store.outbox!.listReady(10, now)).map((event) => event.id)).toEqual([enqueued.id]);

    const claimed = await store.outbox!.claim(enqueued.id, nowIso());
    expect(claimed).toMatchObject({ status: "claimed", attemptCount: 1 });
    const failed = await store.outbox!.markFailed(enqueued.id, { code: "rate_limited" }, nowIso(), { flowRunRef: "flow-1" });
    expect(failed).toMatchObject({ status: "failed", error: { code: "rate_limited" }, evidence: { flowRunRef: "flow-1" } });
    expect(await store.outbox!.markProcessed(enqueued.id, nowIso(), { externalId: "gh-1" })).toMatchObject({ status: "processed" });

    const inboxEvent = makeInboxEvent(projectId, now);
    const received = await store.inbox!.receive(inboxEvent);
    const replay = await store.inbox!.receive({ ...inboxEvent, id: `${inboxEvent.id}-DUP` });
    expect(received.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.event.id).toBe(received.event.id);
    await expect(store.inbox!.markApplying(received.event.id)).resolves.toMatchObject({ status: "applying" });
    await expect(store.inbox!.markApplied(received.event.id, nowIso(), { localTaskId: "API" })).resolves.toMatchObject({
      status: "applied",
      evidence: { localTaskId: "API" }
    });
  });
});

if (!postgresUrl) {
  describe("storage parity: postgres", () => {
    it.skip("set UNBLOCK_TEST_POSTGRES_URL to run Postgres parity tests", () => {});
  });
}

function track(handle: StoreHandle): StoreHandle {
  handles.push(handle);
  return handle;
}

async function createTemporaryPostgresStore(baseConnectionString: string): Promise<StoreHandle> {
  const databaseName = `unblock_test_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`create database ${databaseName}`);
  await admin.end();

  const store = await createPostgresStore({ connectionString: databaseUrl.toString(), autoMigrate: true });
  return {
    store,
    async cleanup() {
      await store.close?.();
      const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${databaseName} with (force)`);
      await cleanup.end();
    }
  };
}

function makeTask(projectId: string, id: string): Task {
  const now = nowIso();
  return {
    projectId,
    id,
    parentTaskId: null,
    title: id,
    description: "",
    lifecycle: "open",
    priority: 2,
    size: null,
    sourceDoc: null,
    sourceSection: null,
    sourceAnchor: null,
    sourceLine: null,
    sourceText: null,
    completionBar: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    version: 1
  };
}

function makeActivity(projectId: string, type: string): Activity {
  return {
    projectId,
    id: randomUUID(),
    type,
    subjectType: "task",
    subjectId: "ROLLBACK",
    message: "Rollback test",
    data: {},
    machine: "parity",
    actor: "codex-e",
    createdAt: nowIso()
  };
}

function makeOutboxEvent(projectId: string, now: string): OutboxEvent {
  return {
    projectId,
    id: randomUUID(),
    eventType: "task.changed",
    subjectType: "task",
    subjectId: "API",
    payload: { taskId: "API" },
    idempotencyKey: `${projectId}:task:API:1`,
    status: "pending",
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    claimedAt: null,
    processedAt: null,
    error: null,
    evidence: {}
  };
}

function makeInboxEvent(projectId: string, now: string): InboxEvent {
  return {
    projectId,
    id: randomUUID(),
    source: "github",
    externalEventId: `${projectId}:delivery:1`,
    eventType: "issue.updated",
    payload: { issueNumber: 1 },
    status: "received",
    appliedAt: null,
    createdAt: now,
    error: null,
    evidence: {}
  };
}
