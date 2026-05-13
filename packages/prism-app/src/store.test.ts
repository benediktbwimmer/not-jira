import { describe, expect, it } from "vitest";
import { lowerMatcherQueryToPrismFragment } from "./matcher-fragment.js";
import { createPrismStore, type PrismRuntimeClient, type PrismSemanticOperation, type PrismTagAssignment } from "./store.js";

class RecordingClient implements PrismRuntimeClient {
  readonly batches: Array<{
    projectId: string;
    shardId: string;
    appId: string;
    actorId: string;
    idempotencyKey: string;
    operations: PrismSemanticOperation[];
  }> = [];
  surfaces = new Map<string, Record<string, unknown>[]>();
  tags = new Map<string, PrismTagAssignment[]>();

  async submitSemanticCommit(batch: {
    projectId: string;
    shardId: string;
    appId: string;
    actorId: string;
    idempotencyKey: string;
    operations: PrismSemanticOperation[];
  }): Promise<void> {
    this.batches.push(batch);
  }

  async readMaterializedSurface<T extends Record<string, unknown>>(input: { surfaceId: string }): Promise<T[]> {
    return (this.surfaces.get(input.surfaceId) ?? []) as T[];
  }

  async query<T extends Record<string, unknown>>(input: { surfaceId: string }): Promise<T[]> {
    return (this.surfaces.get(input.surfaceId) ?? []) as T[];
  }

  async readSubjectTags(input: { subjectRef: string; tagId?: string }): Promise<PrismTagAssignment[]> {
    return (this.tags.get(input.subjectRef) ?? []).filter((tag) => !input.tagId || tag.tagId === input.tagId);
  }

  async findSubjectsByTag(input: { tagId: string; valueKey?: string }): Promise<PrismTagAssignment[]> {
    return [...this.tags.values()].flat().filter((tag) =>
      tag.tagId === input.tagId && (!input.valueKey || tag.valueKey === input.valueKey)
    );
  }
}

describe("PrismStore", () => {
  it("emits Prism object and hierarchy mutations for tasks", async () => {
    const client = new RecordingClient();
    const store = createPrismStore({ client, projectId: "test-project", shardId: "P", actorId: "test" });

    await store.tasks.create(task({ id: "ROOT", parentTaskId: null }));
    await store.tasks.create(task({ id: "CHILD", parentTaskId: "ROOT" }));

    expect(client.batches.flatMap((batch) => batch.operations)).toEqual([
      expect.objectContaining({ family: "object", operation: { Create: expect.objectContaining({ object_kind: "Task", object_id: "ROOT" }) } }),
      expect.objectContaining({ family: "object", operation: { Create: expect.objectContaining({ object_kind: "Task", object_id: "CHILD" }) } }),
      expect.objectContaining({
        family: "relation",
        operation: {
          Link: expect.objectContaining({
            relation_kind: "TaskContainsTask",
            from_ref: "object:Task:ROOT",
            to_ref: "object:Task:CHILD",
          }),
        },
      }),
    ]);
  });

  it("emits dependency and label tag mutations", async () => {
    const client = new RecordingClient();
    const store = createPrismStore({ client, offline: false });
    const now = new Date("2026-05-13T00:00:00.000Z").toISOString();

    await store.tags.create({
      projectId: "P",
      id: "BACKEND",
      name: "backend",
      color: "#00f",
      description: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    await store.tags.addTaskTag({ projectId: "P", taskId: "API", tagId: "BACKEND", createdAt: now });
    await store.dependencies.add({ projectId: "P", taskId: "API", dependsOnTaskId: "SCHEMA", createdAt: now });

    expect(client.batches.flatMap((batch) => batch.operations)).toEqual([
      expect.objectContaining({
        family: "tag",
        operation: { Set: expect.objectContaining({ subject_ref: "object:Project:P", tag_id: "project.label_definition", value_key: "BACKEND" }) },
      }),
      expect.objectContaining({
        family: "tag",
        operation: { Set: expect.objectContaining({ subject_ref: "object:Task:API", tag_id: "task.label", value_key: "BACKEND" }) },
      }),
      expect.objectContaining({
        family: "relation",
        operation: {
          Link: expect.objectContaining({
            relation_kind: "TaskDependsOnTask",
            from_ref: "object:Task:API",
            to_ref: "object:Task:SCHEMA",
          }),
        },
      }),
    ]);
  });

  it("buffers repository mutations into one transaction batch", async () => {
    const client = new RecordingClient();
    const store = createPrismStore({ client });

    await store.transaction(async (repos) => {
      await repos.tasks.create(task({ id: "A", parentTaskId: null }));
      await repos.tasks.create(task({ id: "B", parentTaskId: "A" }));
    });

    expect(client.batches).toHaveLength(1);
    expect(client.batches[0]?.operations).toHaveLength(3);
  });

  it("lowers matcher queries to Prism fragment source and executes the fragment by id", async () => {
    const fragment = lowerMatcherQueryToPrismFragment("tag = backend and depends on API depth <= 2");
    expect(fragment.source).toContain(".from(taskMatcherReadModel)");
    expect(fragment.source).toContain(".leftJoin(taskLabelRows");
    expect(fragment.source).toContain(".leftJoin(taskDependencyClosure");

    const client = new RecordingClient();
    client.surfaces.set(fragment.fragmentId, [{ project_id: "P", task_id: "WORK" }]);
    const store = createPrismStore({ client });

    await expect(store.matcher.matchTaskIds("P", "tag = backend and depends on API depth <= 2")).resolves.toEqual(["WORK"]);
  });
});

function task(input: { id: string; parentTaskId: string | null }) {
  const now = new Date("2026-05-13T00:00:00.000Z").toISOString();
  return {
    projectId: "P",
    id: input.id,
    parentTaskId: input.parentTaskId,
    title: input.id,
    description: "",
    lifecycle: "open" as const,
    priority: 2 as const,
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
    version: 1,
  };
}
