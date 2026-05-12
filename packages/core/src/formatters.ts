import { priorityLabel, type Activity, type DependencyExplanation, type TaskView } from "./types.js";

export function formatTaskTable(tasks: TaskView[]): string {
  const rows = tasks.map((task) => [
    task.id,
    task.computedStatus,
    priorityLabel(task.priority),
    String(task.dependencyDepth),
    String(task.transitiveDependentsCount),
    String(task.commentCount),
    task.descendantsCount > 0 ? `${task.subtreeProgress}%` : "",
    task.rollupStatus === "blocked-by-children" ? `${task.unfinishedDescendantsCount} child blockers` : "",
    task.parentTaskId ?? "",
    task.assignedTrack ? formatActorRef(task.assignedTrack) : "",
    `${"  ".repeat(task.hierarchyDepth)}${task.title}`
  ]);
  return table(["ID", "Status", "Priority", "Depth", "Unblocks", "Comments", "Progress", "Rollup", "Parent", "Actor", "Title"], rows);
}

export function formatTaskMarkdown(tasks: TaskView[]): string {
  const lines = ["| ID | Status | Priority | Depth | Unblocks | Comments | Progress | Rollup | Parent | Actor | Title |", "| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |"];
  for (const task of tasks) {
    const rollup = task.rollupStatus === "blocked-by-children" ? `${task.unfinishedDescendantsCount} child blockers` : "";
    lines.push(`| ${task.id} | ${task.computedStatus} | ${priorityLabel(task.priority)} | ${task.dependencyDepth} | ${task.transitiveDependentsCount} | ${task.commentCount} | ${task.descendantsCount > 0 ? `${task.subtreeProgress}%` : ""} | ${rollup} | ${task.parentTaskId ?? ""} | ${task.assignedTrack ? formatActorRef(task.assignedTrack) : ""} | ${task.title.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n");
}

export function formatExplain(explanation: DependencyExplanation): string {
  const task = explanation.task;
  const lines = [
    `${task.id} ${task.title}`,
    "",
    `Status: ${task.computedStatus}`,
    `Lifecycle: ${task.lifecycle}`,
    `Priority: ${priorityLabel(task.priority)}`,
    `Depth: ${task.dependencyDepth}`,
    `Unblocks: ${task.transitiveDependentsCount} tasks`,
    `Parent: ${task.parent ? `${task.parent.id} ${task.parent.title}` : "root"}`,
    `Subtree: ${task.subtreeProgress}% (${task.finishedLeafDescendantsCount}/${task.leafDescendantsCount} leaf tasks finished)`,
    `Rollup: ${formatRollup(task)}`,
    `Source: ${task.sourceDoc ?? "none"}${task.sourceSection ? `#${task.sourceSection}` : ""}`,
    `Assigned: ${task.assignedTrack ? formatActorRef(task.assignedTrack) : "none"}`,
    "",
    "Blocked by:"
  ];

  if (explanation.unfinishedDependencies.length === 0) {
    lines.push("- none");
  } else {
    for (const dependency of explanation.unfinishedDependencies) {
      lines.push(`- ${dependency.id} ${dependency.title} [${dependency.lifecycle}]`);
    }
  }

  if (task.criticalChildPath.length > 0) {
    lines.push("", "Critical child path:");
    for (const child of task.criticalChildPath) {
      const dependencyNote = child.unfinishedDependenciesCount > 0 ? `, ${child.unfinishedDependenciesCount} unfinished deps` : "";
      lines.push(`- ${child.id} ${child.title} [${child.computedStatus}${dependencyNote}]`);
    }
  }

  lines.push("", `Assignable: ${explanation.assignable ? "yes" : "no"}`, `Reason: ${explanation.reason}`);
  if (explanation.instructions.length > 0) {
    lines.push("", "Instructions:");
    for (const match of explanation.instructions) {
      lines.push(`- ${match.instruction.name} (${match.reasons.join(", ") || "matched"})`);
      if (match.instruction.body.trim()) {
        lines.push(indent(match.instruction.body.trim(), "  "));
      }
    }
  }
  return lines.join("\n");
}

export function formatActivity(activity: Activity[]): string {
  return table(["Created", "Actor", "Type", "Subject", "Message"], activity.map((item) => [
    item.createdAt,
    formatActorRef(item),
    item.type,
    `${item.subjectType}:${item.subjectId ?? ""}`,
    item.message
  ]));
}

function formatActorRef(identity: { machine: string; actor: string }): string {
  return `${identity.machine}:${identity.actor}`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)));
  const renderRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => "-".repeat(width))), ...rows.map(renderRow)].join("\n");
}

function indent(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function formatRollup(task: TaskView): string {
  if (task.rollupStatus === "leaf") {
    return "leaf task";
  }
  if (task.rollupStatus === "complete") {
    return "child rollup complete";
  }
  return `blocked by ${task.unfinishedDescendantsCount} unfinished ${task.unfinishedDescendantsCount === 1 ? "descendant" : "descendants"}`;
}
