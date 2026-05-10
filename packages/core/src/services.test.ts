import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStore, createServices, ensureNotJiraConfig, NotJiraError, readNotJiraConfig } from "./index.js";

describe("not-jira core services", () => {
  it("creates and validates the user config file with safe defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "not-jira-config-"));
    const configPath = join(dir, "config.json");

    const created = await ensureNotJiraConfig(configPath);
    expect(created.exists).toBe(true);
    expect(created.config.ui.refreshIntervalMs).toBe(5000);
    expect(created.config.ui.persistState).toBe(true);

    await writeFile(configPath, JSON.stringify({ ui: { refreshIntervalMs: 2500, persistState: false } }), "utf8");
    const custom = await readNotJiraConfig(configPath);
    expect(custom.config.ui.refreshIntervalMs).toBe(2500);
    expect(custom.config.ui.persistState).toBe(false);

    await writeFile(configPath, JSON.stringify({ ui: { refreshIntervalMs: 10 } }), "utf8");
    const invalid = await readNotJiraConfig(configPath);
    expect(invalid.config.ui.refreshIntervalMs).toBe(5000);
    expect(invalid.issues.length).toBeGreaterThan(0);
  });

  it("keeps readiness dependency-first while computing hierarchy progress", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "AUTH", title: "Auth work" });
    await services.tasks.add({ id: "AUTH-001", parentTaskId: "AUTH", title: "Registry" });
    await services.tasks.add({ id: "AUTH-002", parentTaskId: "AUTH", title: "Object surfaces" });
    await services.tasks.add({ id: "AUTH-003", parentTaskId: "AUTH", title: "Behavior capture" });
    await services.dependencies.add("AUTH-003", "AUTH-001");

    await services.tasks.finish("AUTH-001");
    const tasks = await services.query.list({ includeFinished: true });
    const parent = tasks.find((task) => task.id === "AUTH");
    const capture = tasks.find((task) => task.id === "AUTH-003");

    expect(parent?.computedStatus).toBe("ready");
    expect(parent?.rollupStatus).toBe("blocked-by-children");
    expect(parent?.subtreeProgress).toBe(33);
    expect(parent?.unfinishedDescendantsCount).toBe(2);
    expect(parent?.finishedLeafDescendantsCount).toBe(1);
    expect(parent?.leafDescendantsCount).toBe(3);
    expect(parent?.criticalChildPath.map((task) => task.id)).toEqual(["AUTH-002"]);
    expect(capture?.computedStatus).toBe("ready");
  });

  it("sorts ready work by downstream unblock count before priority by default", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "Critical root", priority: 2 });
    await services.tasks.add({ id: "B", title: "High standalone", priority: 4 });
    await services.tasks.add({ id: "C", title: "Downstream 1" });
    await services.tasks.add({ id: "D", title: "Downstream 2" });
    await services.dependencies.add("C", "A");
    await services.dependencies.add("D", "C");

    const ready = await services.query.list({ status: "ready" });
    expect(ready.map((task) => task.id).slice(0, 2)).toEqual(["A", "B"]);
    expect(ready[0]?.transitiveDependentsCount).toBe(2);
  });

  it("rejects parent cycles", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", parentTaskId: "A", title: "B" });

    await expect(services.tasks.edit("A", { parentTaskId: "B" })).rejects.toBeInstanceOf(NotJiraError);
  });

  it("rejects dependencies on descendants to keep hierarchy and readiness clear", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", parentTaskId: "A", title: "B" });

    await expect(services.dependencies.add("A", "B")).rejects.toBeInstanceOf(NotJiraError);
  });

  it("keeps parents open until descendants are finished without making children dependencies", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "P", title: "Parent project" });
    await services.tasks.add({ id: "C", parentTaskId: "P", title: "Child task" });

    await expect(services.tasks.finish("P")).rejects.toBeInstanceOf(NotJiraError);

    const explanation = await services.query.explain("P");
    expect(explanation.task.computedStatus).toBe("ready");
    expect(explanation.task.rollupStatus).toBe("blocked-by-children");
    expect(explanation.task.criticalChildPath.map((task) => task.id)).toEqual(["C"]);
    expect(explanation.unfinishedDependencies).toHaveLength(0);

    await services.tasks.finish("C");
    const afterChildFinish = await services.query.explain("P");
    expect(afterChildFinish.task.rollupStatus).toBe("complete");
    expect(afterChildFinish.task.subtreeProgress).toBe(100);

    await expect(services.tasks.finish("P")).resolves.toMatchObject({ id: "P", lifecycle: "finished" });
  });

  it("allows assignment when dependencies are unfinished", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "Dependency" });
    await services.tasks.add({ id: "B", title: "Blocked task" });
    await services.dependencies.add("B", "A");
    await services.tracks.add({ actor: "codex-a" });

    await expect(services.tracks.assign("codex-a", "B")).resolves.toMatchObject({ taskId: "B" });
    const explanation = await services.query.explain("B");
    expect(explanation.assignable).toBe(true);
    expect(explanation.task.blocked).toBe(true);
    expect(explanation.reason).toBe("Task can be assigned, but 1 dependency is unfinished.");
  });

  it("exports markdown as a complete readable graph report", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({
      id: "ROOT",
      title: "Root task",
      description: "Root description body"
    });
    await services.tasks.add({
      id: "A",
      parentTaskId: "ROOT",
      title: "Dependency task",
      description: "Dependency details\nwith a second line"
    });
    await services.tasks.add({
      id: "B",
      parentTaskId: "ROOT",
      title: "Blocked task",
      description: "Blocked task description",
      sourceDoc: "docs/design.md",
      sourceSection: "Export"
    });
    await services.dependencies.add("B", "A");
    await services.tags.add({ id: "UI", name: "ui", color: "#22b889" });
    await services.tags.assign("B", ["UI"]);
    await services.tracks.add({ actor: "codex-a" });
    await services.tracks.assign("codex-a", "A");

    const markdown = await services.exports.markdown();

    expect(markdown).toContain("# Not Jira Export");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("### `B` Blocked task");
    expect(markdown).toContain("Blocked task description");
    expect(markdown).toContain("- Parent: ROOT Root task");
    expect(markdown).toContain("- Tags: ui");
    expect(markdown).toContain("- Source: docs/design.md - Export");
    expect(markdown).toContain("- Rollup: blocked by 2 unfinished descendants");
    expect(markdown).toContain("- Critical child path: `B` Blocked task [blocked, 1 unfinished deps]");
    expect(markdown).toContain("- Dependencies: `A` Dependency task [ready]");
    expect(markdown).toContain("- `B` Blocked task depends on `A` Dependency task");
    expect(markdown).toContain("### codex-a");
    expect(markdown).toContain("- `A` Dependency task [ready]");
    expect(markdown).not.toContain("| Done |");
  });

  it("imports a full JSON graph in one service call", async () => {
    const store = createMemoryStore();
    const services = createServices(store);
    const now = "2026-05-02T00:00:00.000Z";

    const result = await services.imports.json("fixture.json", {
      tasks: [
        {
          id: "ROOT",
          parentTaskId: null,
          title: "Root",
          description: "",
          lifecycle: "open",
          priority: 2,
          size: null,
          sourceDoc: "docs/design.md",
          sourceSection: "Root",
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
        },
        {
          id: "A",
          parentTaskId: "ROOT",
          title: "Dependency",
          description: "",
          lifecycle: "open",
          priority: 2,
          size: null,
          sourceDoc: "docs/design.md",
          sourceSection: "A",
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
        },
        {
          id: "B",
          parentTaskId: "ROOT",
          title: "Blocked",
          description: "",
          lifecycle: "open",
          priority: 3,
          size: "M",
          sourceDoc: "docs/design.md",
          sourceSection: "B",
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
        }
      ],
      dependencies: [{ taskId: "B", dependsOnTaskId: "A", createdAt: now }],
      tags: [{ id: "COMPILER", name: "compiler", color: "#00f", description: null, sortOrder: 0, createdAt: now, updatedAt: now, archivedAt: null }],
      taskTags: [{ taskId: "B", tagId: "COMPILER", createdAt: now }],
      tracks: [],
      assignments: []
    });

    expect(result.tasksCreated).toBe(3);
    expect(result.dependenciesAdded).toBe(1);
    expect(result.taskTagsAdded).toBe(1);

    const tasks = await services.query.list({ includeFinished: true });
    expect(tasks.find((task) => task.id === "B")?.blocked).toBe(true);
    expect(tasks.find((task) => task.id === "B")?.tags.map((tag) => tag.name)).toEqual(["compiler"]);
  });
});
