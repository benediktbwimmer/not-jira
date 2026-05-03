import type { AppStore } from "./store.js";
import { priorityLabel, type JsonExport, type TaskView } from "./types.js";

export async function exportStoreJson(store: AppStore, includeActivity = false): Promise<JsonExport> {
  const [tasks, dependencies, tags, taskTags, tracks, assignments, activity] = await Promise.all([
    store.tasks.list(),
    store.dependencies.list(),
    store.tags.list(),
    store.tags.listTaskTags(),
    store.tracks.list(),
    store.tracks.listAssignments(),
    includeActivity ? store.activity.list(Number.MAX_SAFE_INTEGER) : Promise.resolve(undefined)
  ]);
  const result: JsonExport = {
    tasks,
    dependencies,
    tags,
    taskTags,
    tracks,
    assignments
  };
  if (activity) {
    result.activity = activity;
  }
  return result;
}

export function exportMarkdown(tasks: TaskView[], data: JsonExport): string {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dependenciesByTask = groupBy(data.dependencies, (dependency) => dependency.taskId);
  const dependentsByTask = groupBy(data.dependencies, (dependency) => dependency.dependsOnTaskId);
  const assignmentsByTrack = groupBy(data.assignments, (assignment) => assignment.trackId);
  const assignmentByTask = new Map(data.assignments.map((assignment) => [assignment.taskId, assignment]));
  const trackById = new Map(data.tracks.map((track) => [track.id, track]));
  const activeTasks = tasks.filter((task) => !task.archivedAt);
  const lines: string[] = ["# Not Jira Export", ""];

  lines.push("## Summary", "");
  lines.push(`- Tasks: ${tasks.length}`);
  lines.push(`- Active tasks: ${activeTasks.length}`);
  lines.push(`- Ready: ${tasks.filter((task) => task.computedStatus === "ready").length}`);
  lines.push(`- Blocked: ${tasks.filter((task) => task.computedStatus === "blocked").length}`);
  lines.push(`- Started: ${tasks.filter((task) => task.computedStatus === "started").length}`);
  lines.push(`- Finished: ${tasks.filter((task) => task.computedStatus === "finished").length}`);
  lines.push(`- Archived: ${tasks.filter((task) => task.computedStatus === "archived").length}`);
  lines.push(`- Dependencies: ${data.dependencies.length}`);
  lines.push(`- Tags: ${data.tags.length}`);
  lines.push(`- Actor queues: ${data.tracks.length}`);
  lines.push("");

  lines.push("## Tasks", "");
  if (tasks.length === 0) {
    lines.push("No tasks.", "");
  }

  for (const task of tasks) {
    const dependencyEdges = dependenciesByTask.get(task.id) ?? [];
    const dependentEdges = dependentsByTask.get(task.id) ?? [];
    const assignment = assignmentByTask.get(task.id);
    const track = assignment ? trackById.get(assignment.trackId) : null;
    const tags = task.tags.map((tag) => tag.name).join(", ");
    const source = formatSource(task);

    lines.push(`### \`${task.id}\` ${escapeInline(task.title)}`, "");
    lines.push(`- Status: ${task.computedStatus}`);
    lines.push(`- Lifecycle: ${task.lifecycle}`);
    lines.push(`- Priority: ${priorityLabel(task.priority)} (${task.priority})`);
    lines.push(`- Size: ${task.size ?? "none"}`);
    lines.push(`- Parent: ${task.parent ? `${task.parent.id} ${escapeInline(task.parent.title)}` : "root"}`);
    lines.push(`- Assignment: ${track ? track.actor : "unassigned"}`);
    lines.push(`- Tags: ${tags || "none"}`);
    lines.push(`- Source: ${source}`);
    lines.push(`- Progress: ${task.subtreeProgress}% (${task.finishedLeafDescendantsCount}/${task.leafDescendantsCount} leaf descendants finished)`);
    lines.push(`- Dependency depth: ${task.dependencyDepth}`);
    lines.push(`- Dependencies: ${formatTaskRefs(dependencyEdges.map((edge) => edge.dependsOnTaskId), taskById)}`);
    lines.push(`- Blocks directly: ${formatTaskRefs(dependentEdges.map((edge) => edge.taskId), taskById)}`);
    lines.push(`- Unblocks transitively: ${task.transitiveDependentsCount}`);
    if (task.completionBar) {
      lines.push(`- Completion bar: ${escapeInline(task.completionBar)}`);
    }
    lines.push("");
    lines.push("Description:");
    lines.push("");
    lines.push(formatDescription(task.description));
    lines.push("");
  }

  lines.push("## Dependencies", "");
  if (data.dependencies.length === 0) {
    lines.push("No dependencies.", "");
  } else {
    for (const dependency of data.dependencies) {
      const task = taskById.get(dependency.taskId);
      const dependsOn = taskById.get(dependency.dependsOnTaskId);
      lines.push(`- \`${dependency.taskId}\` ${task ? escapeInline(task.title) : ""} depends on \`${dependency.dependsOnTaskId}\` ${dependsOn ? escapeInline(dependsOn.title) : ""}`.trim());
    }
    lines.push("");
  }

  lines.push("## Actor Queues", "");
  if (data.tracks.length === 0) {
    lines.push("No actor queues.", "");
  } else {
    for (const track of data.tracks) {
      lines.push(`### ${escapeInline(track.actor)}`, "");
      if (track.name) {
        lines.push(`Name: ${escapeInline(track.name)}`, "");
      }
      const assignments = [...(assignmentsByTrack.get(track.id) ?? [])].sort((a, b) => a.position.localeCompare(b.position));
      if (assignments.length === 0) {
        lines.push("No assigned tasks.", "");
      } else {
        for (const assignment of assignments) {
          const task = taskById.get(assignment.taskId);
          lines.push(`- \`${assignment.taskId}\`${task ? ` ${escapeInline(task.title)} [${task.computedStatus}]` : ""}`);
        }
        lines.push("");
      }
    }
  }

  lines.push("## Tags", "");
  if (data.tags.length === 0) {
    lines.push("No tags.", "");
  } else {
    for (const tag of data.tags) {
      const taggedTasks = tasks.filter((task) => task.tags.some((taskTag) => taskTag.id === tag.id));
      lines.push(`### ${escapeInline(tag.name)}`, "");
      lines.push(`- ID: ${tag.id}`);
      lines.push(`- Color: ${tag.color ?? "none"}`);
      lines.push(`- Description: ${tag.description ? escapeInline(tag.description) : "none"}`);
      lines.push(`- Tasks: ${taggedTasks.length > 0 ? taggedTasks.map((task) => `\`${task.id}\``).join(", ") : "none"}`);
      lines.push("");
    }
  }

  if (data.activity) {
    lines.push("## Activity", "");
    if (data.activity.length === 0) {
      lines.push("No activity.", "");
    } else {
      for (const activity of data.activity) {
        lines.push(`- ${activity.createdAt} ${activity.type}: ${escapeInline(activity.message)}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function formatDescription(description: string): string {
  if (!description.trim()) {
    return "_No description._";
  }
  return description.trimEnd();
}

function formatSource(task: TaskView): string {
  if (!task.sourceDoc && !task.sourceSection && !task.sourceLine) {
    return "none";
  }
  const line = task.sourceLine ? `:${task.sourceLine}` : "";
  const section = task.sourceSection ? ` - ${task.sourceSection}` : "";
  return `${task.sourceDoc ?? "unknown"}${line}${section}`;
}

function formatTaskRefs(ids: string[], taskById: Map<string, TaskView>): string {
  if (ids.length === 0) {
    return "none";
  }
  return ids.map((id) => {
    const task = taskById.get(id);
    return task ? `\`${id}\` ${escapeInline(task.title)} [${task.computedStatus}]` : `\`${id}\``;
  }).join(", ");
}

function escapeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = result.get(key) ?? [];
    existing.push(item);
    result.set(key, existing);
  }
  return result;
}
