import { useEffect, useRef, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { Archive, Check, ChevronDown, CircleDot, Edit3, GitBranch, ListTree, MessageSquare, MoreHorizontal, Plus, RefreshCw, UserRound, X } from "lucide-react";
import { CommentChip, DependencyItem, MarkdownContent, Metric, Progress, StatusDot, TagChip } from "../components/common";
import type { CommentRecord, ComputedStatus, CreateTaskDraft, DependencyCandidateState, DependencyMode, Explanation, RollupStatus, TagRecord, TaskAction, TaskView, TrackRecord } from "../types";
import { formatActorRef, formatShortDateTime } from "../utils/format";

export function CreateTaskRow({
  draft,
  depth,
  onChange,
  onSubmit,
  onCancel
}: {
  draft: CreateTaskDraft;
  depth: number;
  onChange: Dispatch<SetStateAction<CreateTaskDraft | null>>;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const idInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    idInputRef.current?.focus();
  }, [draft.parentTaskId]);

  const patchDraft = (patch: Partial<CreateTaskDraft>) => onChange((current) => current ? { ...current, ...patch } : current);
  const canCreate = draft.id.trim().length > 0 && draft.title.trim().length > 0;
  return (
    <div
      className="task-create-row"
      style={{ paddingLeft: `${12 + depth * 22}px` }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
    >
      <span className="create-disclosure-spacer" />
      <StatusDot status="ready" />
      <div className="create-main">
        <input ref={idInputRef} value={draft.id} onChange={(event) => patchDraft({ id: event.target.value })} placeholder="ID" />
        <input value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="Task title" />
        <select value={draft.priority} onChange={(event) => patchDraft({ priority: event.target.value })} aria-label="Priority">
          <option value="4">Urgent</option>
          <option value="3">High</option>
          <option value="2">Normal</option>
          <option value="1">Low</option>
          <option value="0">Someday</option>
        </select>
      </div>
      <span />
      <div className="create-actions">
        <button className="primary-button" disabled={!canCreate} onClick={onSubmit}><Plus size={15} /> Add</button>
        <button onClick={onCancel}><X size={15} /></button>
      </div>
    </div>
  );
}

export interface TreeNode {
  task: TaskView;
  children: TreeNode[];
}

export function buildTaskTree(tasks: TaskView[]): TreeNode[] {
  const nodeById = new Map(tasks.map((task) => [task.id, { task, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const task of tasks) {
    const node = nodeById.get(task.id);
    if (!node) {
      continue;
    }
    const parent = task.parentTaskId ? nodeById.get(task.parentTaskId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function flattenVisibleTaskIds(nodes: TreeNode[], collapsedTaskIds: Set<string>): string[] {
  const result: string[] = [];
  const visit = (node: TreeNode) => {
    result.push(node.task.id);
    if (!collapsedTaskIds.has(node.task.id)) {
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return result;
}

export function getSelectionRange(visibleTaskIds: string[], anchorId: string, taskId: string): string[] {
  const anchorIndex = visibleTaskIds.indexOf(anchorId);
  const taskIndex = visibleTaskIds.indexOf(taskId);
  if (anchorIndex === -1 || taskIndex === -1) {
    return [taskId];
  }
  const start = Math.min(anchorIndex, taskIndex);
  const end = Math.max(anchorIndex, taskIndex);
  return visibleTaskIds.slice(start, end + 1);
}

export function getSubtreeTaskIds(taskId: string, tasks: TaskView[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) {
      continue;
    }
    childrenByParent.set(task.parentTaskId, [...(childrenByParent.get(task.parentTaskId) ?? []), task.id]);
  }
  const result = [taskId];
  const stack = [...(childrenByParent.get(taskId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || result.includes(current)) {
      continue;
    }
    result.push(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }
  return result;
}

export function isTaskDescendant(taskId: string, possibleDescendantId: string, tasks: TaskView[]): boolean {
  return getSubtreeTaskIds(taskId, tasks).slice(1).includes(possibleDescendantId);
}

export function getDependencyCandidateState(candidateId: string, mode: DependencyMode, tasks: TaskView[]): DependencyCandidateState {
  const selected = mode.targetIds.some((targetId) => mode.draftByTaskId[targetId]?.includes(candidateId));
  if (mode.loading) {
    return { selected, disabled: true, reason: "Loading dependency graph." };
  }
  if (mode.targetIds.includes(candidateId)) {
    return { selected, disabled: true, reason: "A target task cannot depend on itself." };
  }
  for (const targetId of mode.targetIds) {
    if (isTaskDescendant(targetId, candidateId, tasks)) {
      return { selected, disabled: true, reason: "Hierarchy descendants cannot be dependencies." };
    }
    if (isTaskDescendant(candidateId, targetId, tasks)) {
      return { selected, disabled: true, reason: "Hierarchy ancestors cannot be dependencies." };
    }
    const graph = { ...mode.dependencyMap, ...mode.draftByTaskId };
    if (hasDependencyPath(candidateId, targetId, graph)) {
      return { selected, disabled: true, reason: "This dependency would create a cycle." };
    }
  }
  return { selected, disabled: false, reason: null };
}

export function getDependencyPreview(task: TaskView, mode: DependencyMode | null, tasks: TaskView[]): { status: ComputedStatus; unfinishedDependenciesCount: number } {
  if (!mode || mode.loading || !mode.targetIds.includes(task.id)) {
    return { status: task.computedStatus, unfinishedDependenciesCount: task.unfinishedDependenciesCount };
  }
  if (task.archivedAt) {
    return { status: "archived", unfinishedDependenciesCount: task.unfinishedDependenciesCount };
  }
  if (task.lifecycle === "finished") {
    return { status: "finished", unfinishedDependenciesCount: 0 };
  }
  if (task.lifecycle === "started") {
    return { status: "started", unfinishedDependenciesCount: 0 };
  }
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const draftDependencies = mode.draftByTaskId[task.id] ?? [];
  const unfinishedDependenciesCount = draftDependencies.filter((id) => taskById.get(id)?.lifecycle !== "finished").length;
  return {
    status: unfinishedDependenciesCount > 0 ? "blocked" : "ready",
    unfinishedDependenciesCount
  };
}

function formatPreviewStatus(task: TaskView, preview: { status: ComputedStatus; unfinishedDependenciesCount: number }): string {
  if (task.computedStatus === preview.status && task.unfinishedDependenciesCount === preview.unfinishedDependenciesCount) {
    return preview.status;
  }
  const dependencyText = preview.unfinishedDependenciesCount > 0 ? `, ${preview.unfinishedDependenciesCount} deps` : "";
  return `${task.computedStatus} -> ${preview.status}${dependencyText}`;
}

function hasDependencyPath(startId: string, targetId: string, dependencyMap: Record<string, string[]>): boolean {
  const stack = [...(dependencyMap[startId] ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    if (current === targetId) {
      return true;
    }
    visited.add(current);
    stack.push(...(dependencyMap[current] ?? []));
  }
  return false;
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function TaskNode({
  node,
  selectedId,
  selectedIds,
  collapsedTaskIds,
  dependencyMode,
  createDraft,
  tasks,
  onSelect,
  onSelectSubtree,
  onStartCreateSubtask,
  onOpenComments,
  onCreateDraftChange,
  onCreateDraftSubmit,
  onCreateDraftCancel,
  onToggleExpanded,
  onTransition
}: {
  node: TreeNode;
  selectedId: string | null;
  selectedIds: Set<string>;
  collapsedTaskIds: Set<string>;
  dependencyMode: DependencyMode | null;
  createDraft: CreateTaskDraft | null;
  tasks: TaskView[];
  onSelect: (id: string, event: MouseEvent<HTMLDivElement>) => void;
  onSelectSubtree: (id: string) => void;
  onStartCreateSubtask: (parentTaskId: string) => void;
  onOpenComments: (id: string) => void;
  onCreateDraftChange: Dispatch<SetStateAction<CreateTaskDraft | null>>;
  onCreateDraftSubmit: () => void;
  onCreateDraftCancel: () => void;
  onToggleExpanded: (id: string) => void;
  onTransition: (task: TaskView, action: TaskAction) => Promise<void>;
}) {
  const task = node.task;
  const expanded = !collapsedTaskIds.has(task.id);
  const unfinishedDependencies = task.unfinishedDependenciesCount;
  const unfinishedDescendants = getUnfinishedDescendantsCount(task);
  const progress = task.descendantsCount > 0 ? task.subtreeProgress : task.lifecycle === "finished" ? 100 : 0;
  const dependencyCandidate = dependencyMode ? getDependencyCandidateState(task.id, dependencyMode, tasks) : null;
  const dependencyPreview = getDependencyPreview(task, dependencyMode, tasks);
  const previewChanged = dependencyPreview.status !== task.computedStatus || dependencyPreview.unfinishedDependenciesCount !== task.unfinishedDependenciesCount;
  const rowClassName = [
    "task-row",
    selectedIds.has(task.id) ? "selected" : "",
    selectedId === task.id ? "focused" : "",
    dependencyCandidate ? "dependency-candidate" : "",
    dependencyCandidate?.selected ? "dependency-selected" : "",
    dependencyCandidate?.disabled ? "dependency-disabled" : ""
  ].filter(Boolean).join(" ");
  return (
    <div className="task-node">
      <div className={rowClassName} style={{ paddingLeft: `${12 + task.hierarchyDepth * 22}px` }} onClick={(event) => onSelect(task.id, event)} title={dependencyCandidate?.reason ?? undefined}>
        <button className="disclosure" onClick={(event) => { event.stopPropagation(); onToggleExpanded(task.id); }} disabled={node.children.length === 0} title={expanded ? "Collapse" : "Expand"}>
          {node.children.length > 0 ? <ChevronDown size={15} className={expanded ? "" : "rotated"} /> : <span />}
        </button>
        <StatusDot status={dependencyPreview.status} />
        <div className="task-main">
          <div className="task-title-line">
            <span>{task.title}</span>
            <strong>{task.id}</strong>
          </div>
          <div className="task-meta">
            <span className={`status-chip ${dependencyPreview.status}`}>{previewChanged ? formatPreviewStatus(task, dependencyPreview) : task.computedStatus}</span>
            <span>P{task.priority}</span>
            {dependencyPreview.unfinishedDependenciesCount > 0 ? <span className="blocked-chip">{dependencyPreview.unfinishedDependenciesCount} deps</span> : null}
            {previewChanged ? <span className="preview-chip">preview</span> : null}
            {task.transitiveDependentsCount > 0 ? <span>unblocks {task.transitiveDependentsCount}</span> : null}
            {task.childrenCount > 0 ? <span>{task.childrenCount} children</span> : null}
            {unfinishedDescendants > 0 && getRollupStatus(task) === "blocked-by-children" ? <span className="rollup-chip">{unfinishedDescendants} child blockers</span> : null}
            {task.assignedTrack ? <span>{formatActorRef(task.assignedTrack)}</span> : null}
            {task.tags.length > 0 ? task.tags.slice(0, 2).map((tag) => <TagChip key={tag.id} tag={tag} />) : null}
            {task.tags.length > 2 ? <span>+{task.tags.length - 2} tags</span> : null}
            {task.commentCount > 0 ? (
              <button
                className={task.recentCommentCount > 0 ? "comment-chip recent" : "comment-chip"}
                title={`${task.commentCount} ${task.commentCount === 1 ? "comment" : "comments"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenComments(task.id);
                }}
              >
                <span>{task.commentCount}</span>
                <MessageSquare size={13} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="task-signals">
          {progress > 0 || task.descendantsCount > 0 ? <Progress value={progress} /> : null}
          {task.descendantsCount > 0 ? <span>{progress}%</span> : null}
        </div>
        <div className="row-actions">
          {task.archivedAt ? (
            <button title="Restore" onClick={(event) => { event.stopPropagation(); void onTransition(task, "restore"); }}><RefreshCw size={15} /></button>
          ) : task.lifecycle !== "finished" ? (
            <button title="Finish" onClick={(event) => { event.stopPropagation(); void onTransition(task, "finish"); }}><Check size={15} /></button>
          ) : (
            <button title="Reopen" onClick={(event) => { event.stopPropagation(); void onTransition(task, "reopen"); }}><RefreshCw size={15} /></button>
          )}
          <button className="row-secondary" title="Start" onClick={(event) => { event.stopPropagation(); void onTransition(task, "start"); }} disabled={task.lifecycle !== "open"}><CircleDot size={15} /></button>
          <button className="row-secondary" title="Add subtask" onClick={(event) => { event.stopPropagation(); onStartCreateSubtask(task.id); }} disabled={Boolean(task.archivedAt)}><Plus size={15} /></button>
          {!task.archivedAt ? <button className="row-secondary" title="Archive" onClick={(event) => { event.stopPropagation(); void onTransition(task, "archive"); }}><Archive size={15} /></button> : null}
          <button className="row-secondary" title="Select subtree" onClick={(event) => { event.stopPropagation(); onSelectSubtree(task.id); }} disabled={task.childrenCount === 0}><ListTree size={15} /></button>
          <span className="row-more" title="More actions"><MoreHorizontal size={15} /></span>
        </div>
      </div>
      {createDraft?.parentTaskId === task.id ? (
        <CreateTaskRow
          draft={createDraft}
          depth={task.hierarchyDepth + 1}
          onChange={onCreateDraftChange}
          onSubmit={onCreateDraftSubmit}
          onCancel={onCreateDraftCancel}
        />
      ) : null}
      {expanded ? node.children.map((child) => (
        <TaskNode
          key={child.task.id}
          node={child}
          selectedId={selectedId}
          selectedIds={selectedIds}
          collapsedTaskIds={collapsedTaskIds}
          dependencyMode={dependencyMode}
          createDraft={createDraft}
          tasks={tasks}
          onSelect={onSelect}
          onSelectSubtree={onSelectSubtree}
          onStartCreateSubtask={onStartCreateSubtask}
          onOpenComments={onOpenComments}
          onCreateDraftChange={onCreateDraftChange}
          onCreateDraftSubmit={onCreateDraftSubmit}
          onCreateDraftCancel={onCreateDraftCancel}
          onToggleExpanded={onToggleExpanded}
          onTransition={onTransition}
        />
      )) : null}
    </div>
  );
}

export function BulkTaskDetails({
  tasks,
  tracks,
  tags,
  onAssign,
  onUnassign,
  onAssignTag,
  onTransition,
  onEditDependencies,
  onClear
}: {
  tasks: TaskView[];
  tracks: TrackRecord[];
  tags: TagRecord[];
  onAssign: (track: TrackRecord) => void;
  onUnassign: () => void;
  onAssignTag: (tagId: string) => void;
  onTransition: (action: TaskAction) => void;
  onEditDependencies: () => void;
  onClear: () => void;
}) {
  const [tagToAssign, setTagToAssign] = useState("");
  const statusCounts = countBy(tasks, (task) => task.computedStatus);
  const activeTasks = tasks.filter((task) => !task.archivedAt);
  const assignableTasks = tasks.filter((task) => !task.assignedTrack && !task.archivedAt && task.lifecycle !== "finished");
  const assignedTasks = tasks.filter((task) => task.assignedTrack);
  const archivedTasks = tasks.filter((task) => task.archivedAt);
  const activeTags = tags.filter((tag) => !tag.archivedAt);
  return (
    <aside className="details-panel bulk-panel">
      <div className="details-header">
        <ListTree size={18} />
        <div className="details-title">
          <h2>{tasks.length} tasks selected</h2>
          <div className="details-meta">
            <span>{statusCounts.ready ?? 0} ready</span>
            <span>{statusCounts.blocked ?? 0} blocked</span>
            <span>{statusCounts.started ?? 0} started</span>
            <span>{statusCounts.finished ?? 0} finished</span>
          </div>
        </div>
      </div>

      <div className="details-actions primary-actions">
        <button onClick={onEditDependencies}><GitBranch size={15} /> Edit dependencies</button>
        <button onClick={() => onTransition("start")}><CircleDot size={15} /> Start {activeTasks.filter((task) => task.lifecycle === "open").length}</button>
        <button className="primary-button" onClick={() => onTransition("finish")}><Check size={15} /> Finish {activeTasks.filter((task) => task.lifecycle !== "finished").length}</button>
        <button className="subtle-button" onClick={() => onTransition("archive")}><Archive size={15} /> Archive {activeTasks.length}</button>
        <button disabled={archivedTasks.length === 0} onClick={() => onTransition("restore")}><RefreshCw size={15} /> Restore {archivedTasks.length}</button>
        <button onClick={onClear}>Clear selection</button>
      </div>

      <section className="detail-section">
        <h3>Assign Actor</h3>
        <p>{assignableTasks.length} selected tasks can receive an actor queue.</p>
        <div className="assign-buttons">
          {tracks.filter((track) => !track.archivedAt).map((track) => (
            <button key={track.id} disabled={assignableTasks.length === 0} onClick={() => onAssign(track)}>
              <UserRound size={15} /> Assign {assignableTasks.length} to {formatActorRef(track)}
            </button>
          ))}
          <button disabled={assignedTasks.length === 0} onClick={onUnassign}>Unassign {assignedTasks.length}</button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Assign Tag</h3>
        <div className="tag-assign-row">
          <select value={tagToAssign} onChange={(event) => setTagToAssign(event.target.value)}>
            <option value="">Assign tag...</option>
            {activeTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
          <button disabled={!tagToAssign} onClick={() => { onAssignTag(tagToAssign); setTagToAssign(""); }}>Assign to {tasks.length}</button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Selected Tasks</h3>
        <div className="dependency-list">
          {tasks.slice(0, 12).map((task) => <DependencyItem key={task.id} task={task} />)}
          {tasks.length > 12 ? <p>{tasks.length - 12} more selected.</p> : null}
        </div>
      </section>
    </aside>
  );
}

export function DependencyModePanel({
  mode,
  tasks,
  onSave,
  onCancel
}: {
  mode: DependencyMode;
  tasks: TaskView[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const targets = mode.targetIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is TaskView => Boolean(task));
  const targetPreviews = targets.map((task) => ({ task, preview: getDependencyPreview(task, mode, tasks) }));
  const previewCounts = countBy(targetPreviews, (item) => item.preview.status);
  const changedPreviewCount = targetPreviews.filter((item) => item.task.computedStatus !== item.preview.status || item.task.unfinishedDependenciesCount !== item.preview.unfinishedDependenciesCount).length;
  const unionDependencyIds = [...new Set(mode.targetIds.flatMap((id) => mode.draftByTaskId[id] ?? []))].sort();
  const commonDependencyIds = unionDependencyIds.filter((id) => mode.targetIds.every((targetId) => mode.draftByTaskId[targetId]?.includes(id)));
  return (
    <aside className="details-panel dependency-mode-panel">
      <div className="details-header">
        <GitBranch size={18} />
        <div className="details-title">
          <h2>Edit dependencies</h2>
          <div className="details-meta">
            <span>{targets.length} target{targets.length === 1 ? "" : "s"}</span>
            <span>{unionDependencyIds.length} selected dependencies</span>
            <span>{changedPreviewCount} status changes</span>
          </div>
        </div>
      </div>

      <div className="details-actions primary-actions">
        <button className="primary-button" disabled={mode.loading} onClick={onSave}>Save dependencies</button>
        <button onClick={onCancel}>Cancel</button>
      </div>

      <section className="detail-section">
        <h3>Targets</h3>
        <div className="details-meta preview-summary">
          <span>{previewCounts.ready ?? 0} ready</span>
          <span>{previewCounts.blocked ?? 0} blocked</span>
          <span>{previewCounts.started ?? 0} started</span>
          <span>{previewCounts.finished ?? 0} finished</span>
        </div>
        <div className="dependency-list">
          {targetPreviews.map(({ task, preview }) => {
            const changed = task.computedStatus !== preview.status || task.unfinishedDependenciesCount !== preview.unfinishedDependenciesCount;
            return changed
              ? <DependencyItem key={task.id} task={task} meta={formatPreviewStatus(task, preview)} statusOverride={preview.status} />
              : <DependencyItem key={task.id} task={task} statusOverride={preview.status} />;
          })}
        </div>
      </section>

      <section className="detail-section">
        <h3>Pick Dependencies</h3>
        <p>{mode.loading ? "Loading dependency graph..." : "Click task rows in the list to toggle dependencies for every target."}</p>
        <p>Disabled rows are the target tasks themselves, hierarchy ancestors or descendants, or tasks that would create a cycle.</p>
      </section>

      <section className="detail-section">
        <h3>Selected Dependencies</h3>
        {unionDependencyIds.length ? (
          <div className="dependency-list">
            {unionDependencyIds.map((id) => {
              const task = tasks.find((candidate) => candidate.id === id);
              const label = commonDependencyIds.includes(id) ? "all targets" : "some targets";
              return task ? <DependencyItem key={id} task={task} meta={label} /> : <p key={id}>{id} ({label})</p>;
            })}
          </div>
        ) : <p>No dependencies selected.</p>}
      </section>
    </aside>
  );
}

export function TaskDetails({
  task,
  explanation,
  comments,
  commentDraft,
  commentsFocusNonce,
  identityReady,
  tracks,
  tags,
  onCommentDraftChange,
  onAddComment,
  onArchiveComment,
  onAssign,
  onUnassign,
  onAssignTag,
  onRemoveTag,
  onUpdate,
  onTransition,
  onRelease,
  onEditDependencies,
  onSelectSubtree,
  onStartCreateSubtask
}: {
  task: TaskView | null;
  explanation: Explanation | null;
  comments: CommentRecord[];
  commentDraft: string;
  commentsFocusNonce: number;
  identityReady: boolean;
  tracks: TrackRecord[];
  tags: TagRecord[];
  onCommentDraftChange: Dispatch<SetStateAction<string>>;
  onAddComment: (task: TaskView) => void;
  onArchiveComment: (comment: CommentRecord) => void;
  onAssign: (track: TrackRecord, task: TaskView) => void;
  onUnassign: (task: TaskView) => void;
  onAssignTag: (task: TaskView, tagId: string) => void;
  onRemoveTag: (task: TaskView, tagId: string) => void;
  onUpdate: (task: TaskView, input: { title: string; description: string }) => void;
  onTransition: (task: TaskView, action: TaskAction) => void;
  onRelease: (task: TaskView, reason: string) => void;
  onEditDependencies: (task: TaskView) => void;
  onSelectSubtree: (task: TaskView) => void;
  onStartCreateSubtask: (task: TaskView) => void;
}) {
  const [tagToAssign, setTagToAssign] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isReleaseOpen, setIsReleaseOpen] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const commentsSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setIsEditing(false);
    setIsReleaseOpen(false);
    setReleaseReason("");
    setDraftTitle(task?.title ?? "");
    setDraftDescription(task?.description ?? "");
  }, [task?.id, task?.title, task?.description]);

  useEffect(() => {
    if (commentsFocusNonce > 0) {
      commentsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [commentsFocusNonce]);

  if (!task) {
    return <aside className="details-panel empty">No task selected</aside>;
  }
  const assignableTags = tags.filter((tag) => !tag.archivedAt && !task.tags.some((taskTag) => taskTag.id === tag.id));
  const contentChanged = draftTitle.trim() !== task.title || draftDescription !== task.description;
  const unfinishedDependencies = explanation?.unfinishedDependencies ?? [];
  const finishedDependencies = explanation?.finishedDependencies ?? [];
  const directDependents = explanation?.directDependents ?? [];
  const instructionMatches = explanation?.instructions ?? [];
  return (
    <aside className="details-panel">
      <div className="details-header">
        <StatusDot status={task.computedStatus} />
        <div className="details-title">
          <h2>{task.title}</h2>
          <div className="details-meta">
            <span>{task.id}</span>
            <span className={`status-chip ${task.computedStatus}`}>{task.computedStatus}</span>
            <span>P{task.priority}</span>
          </div>
        </div>
      </div>

      <div className="details-actions primary-actions">
        {!isEditing ? <button disabled={Boolean(task.archivedAt)} onClick={() => setIsEditing(true)}><Edit3 size={15} /> Edit</button> : null}
        {task.archivedAt ? <button className="primary-button" onClick={() => onTransition(task, "restore")}><RefreshCw size={15} /> Restore</button> : null}
        <button disabled={Boolean(task.archivedAt)} onClick={() => onStartCreateSubtask(task)}><Plus size={15} /> Add subtask</button>
        <button disabled={Boolean(task.archivedAt)} onClick={() => onEditDependencies(task)}><GitBranch size={15} /> Edit dependencies</button>
        {task.childrenCount > 0 ? <button onClick={() => onSelectSubtree(task)}><ListTree size={15} /> Select subtree</button> : null}
        {!task.archivedAt && task.lifecycle === "open" ? <button onClick={() => onTransition(task, "start")}><CircleDot size={15} /> Start</button> : null}
        {!task.archivedAt && task.lifecycle === "started" ? <button onClick={() => setIsReleaseOpen((value) => !value)}><X size={15} /> Release</button> : null}
        {!task.archivedAt && task.lifecycle !== "finished" ? <button className="primary-button" onClick={() => onTransition(task, "finish")}><Check size={15} /> Finish</button> : null}
        {!task.archivedAt && task.lifecycle === "finished" ? <button onClick={() => onTransition(task, "reopen")}><RefreshCw size={15} /> Reopen</button> : null}
        {!task.archivedAt ? <button className="subtle-button" onClick={() => onTransition(task, "archive")}><Archive size={15} /> Archive</button> : null}
      </div>

      {isReleaseOpen ? (
        <section className="detail-section release-panel">
          <h3>Release Task</h3>
          <textarea value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} placeholder="Why is this no longer actively being worked?" />
          <div className="editor-actions">
            <button
              className="primary-button"
              disabled={!releaseReason.trim()}
              onClick={() => {
                onRelease(task, releaseReason.trim());
                setReleaseReason("");
                setIsReleaseOpen(false);
              }}
            >
              Release
            </button>
            <button onClick={() => { setReleaseReason(""); setIsReleaseOpen(false); }}>Cancel</button>
          </div>
        </section>
      ) : null}

      {isEditing ? (
        <section className="detail-section content-editor">
          <h3>Edit Task</h3>
          <label>
            <span>Title</span>
            <input className="title-input" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
          </label>
          <label>
            <span>Description</span>
            <textarea className="description-textarea" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="Add implementation notes, acceptance criteria, links, or context." />
          </label>
          <div className="editor-actions">
            <button
              className="primary-button"
              disabled={!contentChanged || !draftTitle.trim()}
              onClick={() => {
                onUpdate(task, { title: draftTitle.trim(), description: draftDescription });
                setIsEditing(false);
              }}
            >
              Save
            </button>
            <button onClick={() => { setDraftTitle(task.title); setDraftDescription(task.description); setIsEditing(false); }}>Cancel</button>
          </div>
        </section>
      ) : (
        <section className="detail-section detail-summary">
          <h3>Description</h3>
          {task.description.trim() ? <MarkdownContent value={task.description} /> : <p>No description yet.</p>}
        </section>
      )}

      <div className="detail-grid">
        <Metric label="Status" value={task.computedStatus} />
        <Metric label="Priority" value={`P${task.priority}`} />
        <Metric label="Depth" value={String(task.dependencyDepth)} />
        <Metric label="Unblocks" value={String(task.transitiveDependentsCount)} />
        <Metric label="Children" value={String(task.childrenCount)} />
        <Metric label="Progress" value={`${task.subtreeProgress}%`} />
      </div>
      {task.descendantsCount > 0 || task.lifecycle === "finished" ? <Progress value={task.subtreeProgress} large /> : null}

      <section className="detail-section">
        <h3>Dependencies</h3>
        <div className="dependency-list">
          {unfinishedDependencies.length ? unfinishedDependencies.map((dependency) => (
            <DependencyItem key={dependency.id} task={dependency} tone="blocked" />
          )) : <p>No unfinished dependencies.</p>}
          {finishedDependencies.length ? (
            <details className="dependency-more">
              <summary>{finishedDependencies.length} finished {finishedDependencies.length === 1 ? "dependency" : "dependencies"}</summary>
              <div className="dependency-list nested-list">
                {finishedDependencies.slice(0, 8).map((dependency) => <DependencyItem key={dependency.id} task={dependency} />)}
              </div>
            </details>
          ) : null}
        </div>
        <p className={explanation?.assignable ? "assignable yes" : "assignable no"}>{explanation?.reason ?? "Loading explanation..."}</p>
      </section>

      <section className="detail-section">
        <h3>Hierarchy</h3>
        <div className="info-list">
          <p><span>Parent</span>{task.parent ? `${task.parent.id} ${task.parent.title}` : "Root task"}</p>
          <p><span>Leaf progress</span>{task.finishedLeafDescendantsCount}/{task.leafDescendantsCount} finished</p>
          <p className={getRollupStatus(task) === "blocked-by-children" ? "rollup-warning" : undefined}><span>Rollup</span>{formatRollupStatus(task)}</p>
        </div>
        {getCriticalChildPath(task).length > 0 ? (
          <div className="critical-path">
            {getCriticalChildPath(task).map((child) => (
              <span key={child.id}>{child.id} [{child.computedStatus}{child.unfinishedDependenciesCount > 0 ? `, ${child.unfinishedDependenciesCount} deps` : ""}]</span>
            ))}
          </div>
        ) : null}
      </section>

      {directDependents.length ? (
        <section className="detail-section">
          <h3>Unblocks</h3>
          <div className="dependency-list">
            {directDependents.slice(0, 5).map((dependent) => <DependencyItem key={dependent.id} task={dependent} />)}
          </div>
        </section>
      ) : null}

      {instructionMatches.length ? (
        <section className="detail-section">
          <h3>Instructions</h3>
          <div className="instruction-match-stack">
            {instructionMatches.map((match) => (
              <div className="instruction-card" key={match.instruction.id}>
                <div className="instruction-card-header">
                  <strong>{match.instruction.name}</strong>
                  <span>{match.reasons.join(", ") || "matched"}</span>
                </div>
                <MarkdownContent value={match.instruction.body} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="detail-section comments-section" ref={commentsSectionRef}>
        <h3>Comments</h3>
        <div className="comment-list">
          {comments.length > 0 ? comments.map((comment) => (
            <article className="comment-card" key={comment.id}>
              <div className="comment-meta">
                <span>{formatActorRef(comment)}</span>
                <span>{formatShortDateTime(comment.createdAt)}</span>
                {comment.updatedAt !== comment.createdAt ? <span>edited</span> : null}
                <button className="text-button" disabled={!identityReady} onClick={() => onArchiveComment(comment)}>Archive</button>
              </div>
              <MarkdownContent value={comment.body} />
            </article>
          )) : <p>No comments yet.</p>}
        </div>
        <div className="comment-form">
          <textarea
            value={commentDraft}
            onChange={(event) => onCommentDraftChange(event.target.value)}
            placeholder="Add a markdown comment..."
          />
          <button className="primary-button" disabled={!identityReady || !commentDraft.trim()} onClick={() => onAddComment(task)}>
            <Plus size={15} /> Comment
          </button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Assignment</h3>
        <p>{task.assignedTrack ? formatActorRef(task.assignedTrack) : "Unassigned"}</p>
        <div className="assign-buttons">
          {tracks.filter((track) => !track.archivedAt).map((track) => (
            <button key={track.id} disabled={task.archivedAt !== null || task.lifecycle === "finished" || Boolean(task.assignedTrack)} onClick={() => onAssign(track, task)}>
              <UserRound size={15} /> {formatActorRef(track)}
            </button>
          ))}
          {task.assignedTrack ? <button onClick={() => onUnassign(task)}>Unassign</button> : null}
          {tracks.filter((track) => !track.archivedAt).length === 0 ? <p>No actor queues yet. Add one in Queues.</p> : null}
        </div>
      </section>

      <section className="detail-section">
        <h3>Tags</h3>
        <div className="tag-editor-list">
          {task.tags.length > 0 ? task.tags.map((tag) => (
            <button key={tag.id} className="tag-remove" onClick={() => onRemoveTag(task, tag.id)} title={`Remove ${tag.name}`}>
              <TagChip tag={tag} />
              <X size={13} />
            </button>
          )) : <p>No tags assigned.</p>}
        </div>
        <div className="tag-assign-row">
          <select value={tagToAssign} onChange={(event) => setTagToAssign(event.target.value)}>
            <option value="">Assign tag...</option>
            {assignableTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
          <button disabled={!tagToAssign} onClick={() => { onAssignTag(task, tagToAssign); setTagToAssign(""); }}>Assign</button>
        </div>
      </section>

      {(task.sourceDoc || task.sourceSection) ? (
        <section className="detail-section">
          <h3>Source</h3>
          <p>{task.sourceDoc ?? "No source doc"}</p>
          <p>{task.sourceSection ?? "No source section"}</p>
        </section>
      ) : null}
    </aside>
  );
}

export function formatRollupStatus(task: TaskView): string {
  const rollupStatus = getRollupStatus(task);
  if (rollupStatus === "leaf") {
    return "leaf task";
  }
  if (rollupStatus === "complete") {
    return "child rollup complete";
  }
  const unfinishedDescendantsCount = getUnfinishedDescendantsCount(task);
  return `blocked by ${unfinishedDescendantsCount} unfinished ${unfinishedDescendantsCount === 1 ? "descendant" : "descendants"}`;
}

export function getRollupStatus(task: TaskView): RollupStatus {
  if (task.rollupStatus) {
    return task.rollupStatus;
  }
  if (task.childrenCount === 0) {
    return "leaf";
  }
  return getUnfinishedDescendantsCount(task) === 0 ? "complete" : "blocked-by-children";
}

export function getUnfinishedDescendantsCount(task: TaskView): number {
  return task.unfinishedDescendantsCount ?? Math.max(0, task.descendantsCount - task.subtreeFinishedCount);
}

export function getCriticalChildPath(task: TaskView): NonNullable<TaskView["criticalChildPath"]> {
  return task.criticalChildPath ?? [];
}
