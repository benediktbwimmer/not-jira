import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  createServices,
  createSqliteStore,
  defaultUnblockConfigPath,
  defaultUnblockDbPath,
  formatExplain,
  instructionQueryGrammar,
  MigrationService,
  UnblockError,
  publicUnblockConfig,
  readUnblockConfig,
  updateUnblockConfig,
  type ComputedStatus,
  type Lifecycle,
  type Priority,
  type TaskListFilters,
  type TaskSize,
  type TaskSort
} from "@unblock/core";

export interface ServerOptions {
  databasePath?: string | undefined;
  configPath?: string | undefined;
}

export function createApp(options: ServerOptions = {}) {
  const app = new Hono();
  app.use("*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/config", async (c) => {
    const result = await readUnblockConfig(options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
    return c.json({
      ...publicUnblockConfig(result.config),
      issues: result.issues
    });
  });
  app.patch("/api/config", async (c) => {
    const body = await c.req.json<{ identity?: { machine?: string; actor?: string } }>();
    const result = await updateUnblockConfig({
      identity: {
        machine: body.identity?.machine?.trim() ?? "",
        actor: body.identity?.actor?.trim() ?? ""
      }
    }, options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
    return c.json({
      ...publicUnblockConfig(result.config),
      issues: result.issues
    });
  });

  app.use("/api/*", async (c, next) => {
    const store = createSqliteStore(defined({ databasePath: options.databasePath, autoMigrate: true }));
    c.set("services", createServices(store));
    c.set("store", store);
    c.set("configPath", options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
    try {
      await next();
    } finally {
      await store.close?.();
    }
  });

  app.onError((error, c) => {
    if (error instanceof UnblockError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.code === "not_found" ? 404 : 400);
    }
    return c.json({ error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }, 500);
  });

  app.get("/api/db/status", async (c) => {
    const migration = new MigrationService(c.get("store"));
    return c.json(await migration.status());
  });

  app.post("/api/db/migrate", async (c) => {
    const migration = new MigrationService(c.get("store"));
    return c.json(await migration.migrate());
  });

  app.get("/api/projects", async (c) => c.json(await c.get("services").projects.list()));
  app.post("/api/projects", async (c) => c.json(await (await globalMutationServices(c)).projects.add(await c.req.json()), 201));
  app.post("/api/projects/:id/archive", async (c) => c.json(await (await globalMutationServices(c)).projects.archive(c.req.param("id"))));
  app.post("/api/projects/:id/restore", async (c) => c.json(await (await globalMutationServices(c)).projects.restore(c.req.param("id"))));

  app.get("/api/tasks", async (c) => {
    const services = await scopedServices(c);
    const query = c.req.query();
    const filters = defined({
      search: query.search,
      status: query.status as ComputedStatus | "open" | undefined,
      lifecycle: query.lifecycle as Lifecycle | undefined,
      priorityMin: parseOptionalPriority(query.priorityMin),
      priorityMax: parseOptionalPriority(query.priorityMax),
      size: query.size as TaskSize | undefined,
      parentTaskId: query.parent === undefined ? undefined : query.parent === "root" ? null : query.parent,
      sourceDoc: query.sourceDoc,
      sourceSection: query.sourceSection,
      tag: query.tag,
      assignedActor: query.actor,
      includeFinished: query.includeFinished === "true",
      includeArchived: query.includeArchived === "true",
      where: query.where,
      sort: query.sort as TaskSort | undefined
    }) as TaskListFilters;
    return c.json(await services.query.list(filters));
  });

  app.get("/api/query", async (c) => {
    const services = await scopedServices(c);
    const where = c.req.query("where") ?? "";
    const limit = parseRequiredInteger(c.req.query("limit"), "limit");
    const filters = defined({
      includeFinished: c.req.query("includeFinished") === "true",
      includeArchived: c.req.query("includeArchived") === "true",
      sort: c.req.query("sort") as TaskSort | undefined
    }) as Omit<TaskListFilters, "where">;
    return c.json(await services.query.match(where, limit, filters));
  });

  app.post("/api/tasks", async (c) => {
    const services = await scopedServices(c);
    return c.json(await services.tasks.add(await c.req.json()), 201);
  });

  app.get("/api/tasks/:id", async (c) => {
    const services = await scopedServices(c);
    const tasks = await services.query.list({ includeFinished: true, includeArchived: true });
    const task = tasks.find((item) => item.id === c.req.param("id").toUpperCase());
    if (!task) {
      throw new UnblockError("not_found", `task not found: ${c.req.param("id")}`);
    }
    return c.json(task);
  });

  app.patch("/api/tasks/:id", async (c) => c.json(await (await scopedServices(c)).tasks.edit(c.req.param("id"), await c.req.json())));
  app.delete("/api/tasks/:id", async (c) => {
    await (await scopedServices(c)).tasks.delete(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/tasks/:id/archive", async (c) => c.json(await (await scopedServices(c)).tasks.archive(c.req.param("id"))));
  app.post("/api/tasks/:id/restore", async (c) => c.json(await (await scopedServices(c)).tasks.restore(c.req.param("id"))));
  app.post("/api/tasks/:id/start", async (c) => c.json(await (await scopedServices(c)).tasks.start(c.req.param("id"))));
  app.post("/api/tasks/:id/finish", async (c) => c.json(await (await scopedServices(c)).tasks.finish(c.req.param("id"))));
  app.post("/api/tasks/:id/reopen", async (c) => c.json(await (await scopedServices(c)).tasks.reopen(c.req.param("id"))));

  app.get("/api/tasks/:id/explain", async (c) => {
    const explanation = await (await scopedServices(c)).query.explain(c.req.param("id"));
    if (c.req.query("format") === "text") {
      return c.text(formatExplain(explanation));
    }
    return c.json(explanation);
  });

  app.put("/api/tasks/:id/dependencies", async (c) => {
    const body = await c.req.json<{ dependencyIds: string[] }>();
    return c.json(await (await scopedServices(c)).dependencies.set(c.req.param("id"), body.dependencyIds ?? []));
  });
  app.post("/api/tasks/:id/dependencies/:dependencyId", async (c) => c.json(await (await scopedServices(c)).dependencies.add(c.req.param("id"), c.req.param("dependencyId"))));
  app.delete("/api/tasks/:id/dependencies/:dependencyId", async (c) => {
    await (await scopedServices(c)).dependencies.remove(c.req.param("id"), c.req.param("dependencyId"));
    return c.json({ ok: true });
  });

  app.get("/api/tags", async (c) => c.json(await (await scopedServices(c)).tags.list()));
  app.post("/api/tags", async (c) => c.json(await (await scopedServices(c)).tags.add(await c.req.json()), 201));
  app.patch("/api/tags/:id", async (c) => c.json(await (await scopedServices(c)).tags.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/tags/:id/archive", async (c) => c.json(await (await scopedServices(c)).tags.archive(c.req.param("id"))));
  app.post("/api/tasks/:id/tags/:tagId", async (c) => {
    await (await scopedServices(c)).tags.assign(c.req.param("id"), [c.req.param("tagId")]);
    return c.json({ ok: true });
  });
  app.delete("/api/tasks/:id/tags/:tagId", async (c) => {
    await (await scopedServices(c)).tags.remove(c.req.param("id"), c.req.param("tagId"));
    return c.json({ ok: true });
  });

  app.get("/api/tracks", async (c) => c.json(await (await scopedServices(c)).tracks.list()));
  app.post("/api/tracks", async (c) => c.json(await (await scopedServices(c)).tracks.add(await c.req.json()), 201));
  app.patch("/api/tracks/:id", async (c) => {
    const body = await c.req.json<{ name: string }>();
    return c.json(await (await scopedServices(c)).tracks.rename(c.req.param("id"), body.name));
  });
  app.post("/api/tracks/:id/archive", async (c) => c.json(await (await scopedServices(c)).tracks.archive(c.req.param("id"))));
  app.post("/api/tracks/:id/assignments", async (c) => {
    const body = await c.req.json<{ taskId: string }>();
    return c.json(await (await scopedServices(c)).tracks.assign(c.req.param("id"), body.taskId), 201);
  });
  app.delete("/api/tracks/:id/assignments/:taskId", async (c) => {
    await (await scopedServices(c)).tracks.unassign(c.req.param("id"), c.req.param("taskId"));
    return c.json({ ok: true });
  });

  app.get("/api/activity", async (c) => c.json(await (await scopedServices(c)).activity.list(Number(c.req.query("limit") ?? 100))));
  app.get("/api/instructions/grammar", (c) => c.json(instructionQueryGrammar()));
  app.get("/api/instructions", async (c) => c.json(await (await scopedServices(c)).instructions.list(c.req.query("includeArchived") === "true")));
  app.post("/api/instructions", async (c) => c.json(await (await scopedServices(c)).instructions.add(await c.req.json()), 201));
  app.get("/api/instructions/suggest", async (c) => {
    const field = c.req.query("field") ?? "";
    const limit = Number(c.req.query("limit"));
    const input: { prefix?: string; limit: number } = { limit };
    const prefix = c.req.query("prefix");
    if (prefix !== undefined) {
      input.prefix = prefix;
    }
    return c.json(await (await scopedServices(c)).instructions.suggest(field, input));
  });
  app.get("/api/instructions/:id", async (c) => c.json(await (await scopedServices(c)).instructions.get(c.req.param("id"))));
  app.patch("/api/instructions/:id", async (c) => c.json(await (await scopedServices(c)).instructions.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/instructions/:id/archive", async (c) => c.json(await (await scopedServices(c)).instructions.archive(c.req.param("id"))));
  app.post("/api/instructions/:id/restore", async (c) => c.json(await (await scopedServices(c)).instructions.restore(c.req.param("id"))));
  app.post("/api/instructions/preview", async (c) => {
    const body = await c.req.json<{ query: string }>();
    return c.json(await (await scopedServices(c)).instructions.preview(body.query ?? ""));
  });
  app.get("/api/tasks/:id/instructions", async (c) => c.json(await (await scopedServices(c)).instructions.matchesForTask(c.req.param("id"))));
  app.get("/api/views", async (c) => c.json(await (await scopedServices(c)).views.list(c.req.query("includeArchived") === "true")));
  app.post("/api/views", async (c) => c.json(await (await scopedServices(c)).views.add(await c.req.json()), 201));
  app.get("/api/views/:id", async (c) => c.json(await (await scopedServices(c)).views.get(c.req.param("id"))));
  app.patch("/api/views/:id", async (c) => c.json(await (await scopedServices(c)).views.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/views/:id/archive", async (c) => c.json(await (await scopedServices(c)).views.archive(c.req.param("id"))));
  app.post("/api/views/:id/restore", async (c) => c.json(await (await scopedServices(c)).views.restore(c.req.param("id"))));
  app.get("/api/views/:id/tasks", async (c) => c.json(await (await scopedServices(c)).views.tasks(c.req.param("id"), parseOptionalInteger(c.req.query("limit")))));
  app.get("/api/feeds", async (c) => c.json(await (await scopedServices(c)).feeds.list(c.req.query("includeArchived") === "true")));
  app.post("/api/feeds", async (c) => c.json(await (await scopedServices(c)).feeds.add(await c.req.json()), 201));
  app.get("/api/feeds/:id", async (c) => c.json(await (await scopedServices(c)).feeds.get(c.req.param("id"))));
  app.patch("/api/feeds/:id", async (c) => c.json(await (await scopedServices(c)).feeds.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/feeds/:id/archive", async (c) => c.json(await (await scopedServices(c)).feeds.archive(c.req.param("id"))));
  app.post("/api/feeds/:id/restore", async (c) => c.json(await (await scopedServices(c)).feeds.restore(c.req.param("id"))));
  app.get("/api/feeds/:id/tasks", async (c) => c.json(await (await scopedServices(c)).feeds.tasks(c.req.param("id"), parseOptionalInteger(c.req.query("limit")))));
  app.post("/api/import/markdown", async (c) => {
    const body = await c.req.json<{ filePath: string; markdown: string; dryRun?: boolean }>();
    return c.json(await (await scopedServices(c)).imports.markdown(body.filePath, body.markdown, Boolean(body.dryRun)));
  });
  app.post("/api/export/json", async (c) => c.json(await (await scopedServices(c)).exports.json(c.req.query("includeActivity") === "true")));
  app.post("/api/export/markdown", async (c) => c.text(await (await scopedServices(c)).exports.markdown(defined({ where: c.req.query("where"), limit: parseOptionalInteger(c.req.query("limit")) }) as { where?: string; limit?: number })));
  app.get("/api/source-coverage", async (c) => c.json(await (await scopedServices(c)).query.sourceCoverage()));
  app.get("/api/tag-coverage", async (c) => c.json(await (await scopedServices(c)).query.tagCoverage()));
  app.get("/api/ready", async (c) => c.json(await (await scopedServices(c)).query.list({ status: "ready" })));

  return app;
}

async function scopedServices(c: Context): Promise<ReturnType<typeof createServices>> {
  const projectId = requireProjectId(c);
  if (!await c.get("store").projects.get(projectId)) {
    throw new UnblockError("not_found", `project not found: ${projectId}`);
  }
  if (c.req.method === "GET" || c.req.path.startsWith("/api/export/")) {
    return createServices(c.get("store"), { projectId });
  }
  const { machine, actor } = await requireConfigIdentity(c);
  return createServices(c.get("store"), { projectId, machine, actor });
}

async function globalMutationServices(c: Context): Promise<ReturnType<typeof createServices>> {
  const { machine, actor } = await requireConfigIdentity(c);
  return createServices(c.get("store"), { machine, actor });
}

async function requireConfigIdentity(c: Context): Promise<{ machine: string; actor: string }> {
  const config = await readUnblockConfig(c.get("configPath"));
  const machine = config.config.identity.machine.trim();
  const actor = config.config.identity.actor.trim();
  if (!machine || !actor) {
    throw new UnblockError("validation", "Machine and actor must be set in config before mutating.");
  }
  return { machine, actor };
}

function requireProjectId(c: Context): string {
  const projectId = c.req.query("projectId")?.trim();
  if (!projectId) {
    throw new UnblockError("validation", "projectId is required for this endpoint.");
  }
  return projectId;
}

declare module "hono" {
  interface ContextVariableMap {
    services: ReturnType<typeof createServices>;
    store: ReturnType<typeof createSqliteStore>;
    configPath: string;
  }
}

function parseOptionalPriority(value: string | undefined): Priority | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4) {
    return parsed;
  }
  return undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new UnblockError("validation", `Invalid integer: ${value}`);
  }
  return parsed;
}

function parseRequiredInteger(value: string | undefined, name: string): number {
  const parsed = parseOptionalInteger(value);
  if (parsed === undefined) {
    throw new UnblockError("validation", `${name} is required.`);
  }
  return parsed;
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  serve({
    fetch: createApp({
      databasePath: process.env.UNBLOCK_DB ?? defaultUnblockDbPath(),
      configPath: process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath()
    }).fetch,
    port
  });
  console.log(`unblock API listening on http://localhost:${port}`);
}
