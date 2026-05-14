import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createServices } from "./services.js";
import { MigrationService, sqliteMigrations } from "./migrations.js";
import { createSqliteStore } from "./sqlite-store.js";

describe("sqlite store contract", () => {
  it("migrates a fresh database and preserves the core service contract across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unblock-sqlite-"));
    const databasePath = join(dir, "unblock.sqlite");

    let store = createSqliteStore({ databasePath });
    expect(store.capabilities).toMatchObject({
      dialect: "sqlite",
      transactionalWrites: true,
      coreDomain: true,
      matcherQuery: "service",
      bulkOperations: true,
      outboxInbox: false
    });
    let migrationStatus = await new MigrationService(store).status();
    expect(migrationStatus.pending).toEqual([]);
    expect(migrationStatus.applied.map((migration) => migration.id)).toEqual(sqliteMigrations.map((migration) => migration.id));

    const services = createServices(store, { projectId: "DEFAULT", machine: "sqlite-test", actor: "codex-e" });
    await services.tasks.add({ id: "API", title: "API work" });
    await services.tasks.add({ id: "DB", title: "Database work" });
    await services.dependencies.add("API", "DB");
    await services.tags.add({ id: "BACKEND", name: "backend" });
    await services.tags.assign("API", ["backend"]);
    await services.tracks.add({ actor: "codex-e", name: "Codex E" });
    await services.tracks.assign("codex-e", "API");
    await services.instructions.add({ id: "BACKEND-INST", name: "Backend instruction", query: "tag = backend", body: "Use storage contract semantics." });
    await services.comments.add("API", { body: "SQLite contract smoke." });
    await store.close?.();

    store = createSqliteStore({ databasePath });
    const reopened = createServices(store, { projectId: "DEFAULT", machine: "sqlite-test", actor: "codex-e" });
    const matched = await reopened.query.match("tag = backend and assigned = codex-e", 10);
    expect(matched.map((task) => task.id)).toEqual(["API"]);
    expect(await reopened.dependencies.list("API")).toMatchObject([{ taskId: "API", dependsOnTaskId: "DB" }]);
    expect((await reopened.instructions.matchesForTask("API")).map((match) => match.instruction.id)).toEqual(["BACKEND-INST"]);
    expect(await reopened.comments.list("API")).toHaveLength(1);
    expect(await reopened.activity.list({ limit: 20 })).not.toHaveLength(0);

    migrationStatus = await new MigrationService(store).migrate();
    expect(migrationStatus.pending).toEqual([]);
    expect(migrationStatus.applied).toHaveLength(sqliteMigrations.length);
    await store.close?.();

    const db = new Database(databasePath, { readonly: true });
    try {
      const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((row) => (row as { name: string }).name));
      for (const table of [
        "projects",
        "tasks",
        "task_dependencies",
        "tags",
        "task_tags",
        "tracks",
        "track_assignments",
        "instructions",
        "saved_views",
        "queue_feeds",
        "comments",
        "activity",
        "migrations"
      ]) {
        expect(tables.has(table)).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
