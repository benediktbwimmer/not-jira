import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Activity,
  Archive,
  Blocks,
  Check,
  ChevronDown,
  CircleDot,
  Filter,
  GitBranch,
  ListTree,
  Plus,
  RefreshCw,
  Search,
  Tags,
  UserRound,
  X
} from "lucide-react";
import "./styles.css";

type Lifecycle = "open" | "started" | "finished";
type ComputedStatus = "ready" | "blocked" | "started" | "finished" | "archived";
type RollupStatus = "leaf" | "complete" | "blocked-by-children";
type Size = "XS" | "S" | "M" | "L" | "XL";
type Priority = 0 | 1 | 2 | 3 | 4;

interface TagRecord {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
}

interface TrackRecord {
  id: string;
  actor: string;
  name: string | null;
  archivedAt: string | null;
}

interface TaskView {
  id: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  lifecycle: Lifecycle;
  computedStatus: ComputedStatus;
  priority: Priority;
  size: Size | null;
  sourceDoc: string | null;
  sourceSection: string | null;
  completionBar: string | null;
  archivedAt: string | null;
  ready: boolean;
  blocked: boolean;
  unfinishedDependenciesCount: number;
  finishedDependenciesCount: number;
  dependencyDepth: number;
  dependentsCount: number;
  transitiveDependentsCount: number;
  parent: { id: string; title: string; lifecycle: Lifecycle } | null;
  childrenCount: number;
  descendantsCount: number;
  leafDescendantsCount: number;
  finishedLeafDescendantsCount: number;
  subtreeProgress: number;
  subtreeOpenCount: number;
  subtreeReadyCount: number;
  subtreeBlockedCount: number;
  subtreeStartedCount: number;
  subtreeFinishedCount: number;
  hierarchyDepth: number;
  rollupStatus?: RollupStatus;
  unfinishedDescendantsCount?: number;
  criticalChildPath?: Array<{
    id: string;
    title: string;
    lifecycle: Lifecycle;
    computedStatus: ComputedStatus;
    unfinishedDependenciesCount: number;
  }>;
  assignedTrack: { trackId: string; actor: string; name: string | null; position: string } | null;
  tags: TagRecord[];
}

interface Explanation {
  task: TaskView;
  dependencies: TaskView[];
  unfinishedDependencies: TaskView[];
  finishedDependencies: TaskView[];
  directDependents: TaskView[];
  transitiveDependentsCount: number;
  assignable: boolean;
  reason: string;
}

interface ActivityRecord {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string | null;
  message: string;
  createdAt: string;
}

interface SourceCoverage {
  sourceDoc: string | null;
  sourceSection: string | null;
  total: number;
  open: number;
  ready: number;
  blocked: number;
  started: number;
  finished: number;
  archived: number;
}

type ViewMode = "tasks" | "queues" | "tags" | "coverage" | "activity";
type StatusFilter = ComputedStatus | "all";

interface AppConfig {
  ui: {
    refreshIntervalMs: number;
    persistState: boolean;
  };
  issues?: string[];
}

interface UiState {
  mode: ViewMode;
  selectedId: string | null;
  status: StatusFilter;
  search: string;
  includeFinished: boolean;
  includeArchived: boolean;
  collapsedTaskIds: string[];
  scrollPositions: Record<string, number>;
  newTaskDraft: {
    id: string;
    title: string;
    parentTaskId: string;
    priority: string;
  };
  newTrackDraft: string;
  newTagDraft: string;
}

interface RefreshOptions {
  silent?: boolean;
}

const UI_STATE_KEY = "not-jira.ui-state.v1";
const DEFAULT_APP_CONFIG: AppConfig = {
  ui: {
    refreshIntervalMs: 5000,
    persistState: true
  },
  issues: []
};
const DEFAULT_UI_STATE: UiState = {
  mode: "tasks",
  selectedId: null,
  status: "all",
  search: "",
  includeFinished: false,
  includeArchived: false,
  collapsedTaskIds: [],
  scrollPositions: {},
  newTaskDraft: { id: "", title: "", parentTaskId: "", priority: "2" },
  newTrackDraft: "",
  newTagDraft: ""
};

function App() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [coverage, setCoverage] = useState<SourceCoverage[]>([]);
  const [appConfig, setAppConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [uiState, setUiState] = usePersistentUiState(appConfig.ui.persistState);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const taskTreeRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<((options?: RefreshOptions) => Promise<void>) | null>(null);
  const scrollPatchRef = useRef<Record<string, number>>({});
  const scrollFrameRef = useRef<number | null>(null);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === uiState.selectedId) ?? tasks[0] ?? null, [uiState.selectedId, tasks]);
  const roots = useMemo(() => buildTaskTree(tasks), [tasks]);
  const readyTasks = useMemo(() => tasks.filter((task) => task.ready), [tasks]);
  const collapsedTaskIds = useMemo(() => new Set(uiState.collapsedTaskIds), [uiState.collapsedTaskIds]);

  const updateUiState = useCallback((update: Partial<UiState> | ((current: UiState) => UiState)) => {
    setUiState((current) => typeof update === "function" ? update(current) : { ...current, ...update });
  }, [setUiState]);

  useEffect(() => {
    fetchJson<AppConfig>("/api/config")
      .then((config) => setAppConfig(normalizeAppConfig(config)))
      .catch(() => setAppConfig(DEFAULT_APP_CONFIG));
  }, []);

  useEffect(() => {
    if (!selectedTask) {
      setExplanation(null);
      return;
    }
    fetchJson<Explanation>(`/api/tasks/${selectedTask.id}/explain`).then(setExplanation).catch((reason) => setError(String(reason)));
  }, [selectedTask?.id, dataVersion]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("sort", "dependency");
      if (uiState.status !== "all") {
        params.set("status", uiState.status);
      }
      if (uiState.search.trim()) {
        params.set("search", uiState.search.trim());
      }
      if (uiState.includeFinished) {
        params.set("includeFinished", "true");
      }
      if (uiState.includeArchived) {
        params.set("includeArchived", "true");
      }
      const [taskData, trackData, tagData, activityData, coverageData] = await Promise.all([
        fetchJson<TaskView[]>(`/api/tasks?${params.toString()}`),
        fetchJson<TrackRecord[]>("/api/tracks"),
        fetchJson<TagRecord[]>("/api/tags"),
        fetchJson<ActivityRecord[]>("/api/activity?limit=40"),
        fetchJson<SourceCoverage[]>("/api/source-coverage")
      ]);
      setTasks(taskData);
      setTracks(trackData);
      setTags(tagData);
      setActivity(activityData);
      setCoverage(coverageData);
      updateUiState((current) => ({
        ...current,
        selectedId: current.selectedId && taskData.some((task) => task.id === current.selectedId)
          ? current.selectedId
          : taskData[0]?.id ?? null
      }));
      setDataVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }, [uiState.status, uiState.search, uiState.includeFinished, uiState.includeArchived, updateUiState]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    void refresh({ silent: false });
  }, []);

  useEffect(() => {
    const intervalMs = appConfig.ui.refreshIntervalMs;
    if (intervalMs <= 0) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      void refreshRef.current?.({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [appConfig.ui.refreshIntervalMs]);

  useEffect(() => {
    if (loading) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const taskTreeScroll = uiState.scrollPositions["tasks.tree"];
      if (taskTreeRef.current && taskTreeScroll !== undefined) {
        taskTreeRef.current.scrollTop = taskTreeScroll;
      }
      const windowScroll = uiState.scrollPositions[`window.${uiState.mode}`];
      if (windowScroll !== undefined) {
        window.scrollTo({ top: windowScroll });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, uiState.mode]);

  useEffect(() => {
    const onScroll = () => recordScrollPosition(`window.${uiState.mode}`, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [uiState.mode]);

  function recordScrollPosition(key: string, value: number) {
    scrollPatchRef.current[key] = value;
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const patch = scrollPatchRef.current;
      scrollPatchRef.current = {};
      scrollFrameRef.current = null;
      updateUiState((current) => ({
        ...current,
        scrollPositions: { ...current.scrollPositions, ...patch }
      }));
    });
  }

  function toggleTaskExpanded(taskId: string) {
    updateUiState((current) => {
      const collapsed = new Set(current.collapsedTaskIds);
      if (collapsed.has(taskId)) {
        collapsed.delete(taskId);
      } else {
        collapsed.add(taskId);
      }
      return { ...current, collapsedTaskIds: [...collapsed].sort() };
    });
  }

  async function createTask() {
    if (!uiState.newTaskDraft.id.trim() || !uiState.newTaskDraft.title.trim()) {
      return;
    }
    await runMutation(async () => {
      await mutate("/api/tasks", {
        method: "POST",
        body: {
          id: uiState.newTaskDraft.id,
          title: uiState.newTaskDraft.title,
          parentTaskId: uiState.newTaskDraft.parentTaskId.trim() || null,
          priority: Number(uiState.newTaskDraft.priority)
        }
      });
      updateUiState({ newTaskDraft: DEFAULT_UI_STATE.newTaskDraft });
      await refresh();
    });
  }

  async function transitionTask(task: TaskView, action: "start" | "finish" | "reopen" | "archive") {
    await runMutation(async () => {
      await mutate(`/api/tasks/${task.id}/${action}`, { method: "POST" });
      await refresh();
    });
  }

  async function updateTask(task: TaskView, input: { title: string; description: string }) {
    await runMutation(async () => {
      await mutate(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: {
          title: input.title,
          description: input.description
        }
      });
      await refresh();
    });
  }

  async function createTrack() {
    if (!uiState.newTrackDraft.trim()) {
      return;
    }
    await runMutation(async () => {
      await mutate("/api/tracks", { method: "POST", body: { actor: uiState.newTrackDraft.trim() } });
      updateUiState({ newTrackDraft: "" });
      await refresh();
    });
  }

  async function createTag() {
    if (!uiState.newTagDraft.trim()) {
      return;
    }
    await runMutation(async () => {
      await mutate("/api/tags", { method: "POST", body: { name: uiState.newTagDraft.trim() } });
      updateUiState({ newTagDraft: "" });
      await refresh();
    });
  }

  async function assignTask(track: TrackRecord, task: TaskView) {
    await runMutation(async () => {
      await mutate(`/api/tracks/${track.id}/assignments`, { method: "POST", body: { taskId: task.id } });
      await refresh();
    });
  }

  async function unassignTask(task: TaskView) {
    if (!task.assignedTrack) {
      return;
    }
    await runMutation(async () => {
      await mutate(`/api/tracks/${task.assignedTrack?.trackId}/assignments/${task.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  async function assignTag(task: TaskView, tagId: string) {
    if (!tagId) {
      return;
    }
    await runMutation(async () => {
      await mutate(`/api/tasks/${task.id}/tags/${tagId}`, { method: "POST" });
      await refresh();
    });
  }

  async function removeTag(task: TaskView, tagId: string) {
    await runMutation(async () => {
      await mutate(`/api/tasks/${task.id}/tags/${tagId}`, { method: "DELETE" });
      await refresh();
    });
  }

  async function runMutation(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <GitBranch size={22} />
          <span>not-jira</span>
        </div>
        <nav className="nav">
          <NavButton active={uiState.mode === "tasks"} icon={<ListTree size={17} />} label="Tasks" onClick={() => updateUiState({ mode: "tasks" })} />
          <NavButton active={uiState.mode === "queues"} icon={<UserRound size={17} />} label="Queues" onClick={() => updateUiState({ mode: "queues" })} />
          <NavButton active={uiState.mode === "tags"} icon={<Tags size={17} />} label="Tags" onClick={() => updateUiState({ mode: "tags" })} />
          <NavButton active={uiState.mode === "coverage"} icon={<Blocks size={17} />} label="Coverage" onClick={() => updateUiState({ mode: "coverage" })} />
          <NavButton active={uiState.mode === "activity"} icon={<Activity size={17} />} label="Activity" onClick={() => updateUiState({ mode: "activity" })} />
        </nav>
        <div className="ready-summary">
          <div>
            <span className="metric">{readyTasks.length}</span>
            <span className="label">ready</span>
          </div>
          <div>
            <span className="metric">{tasks.reduce((sum, task) => sum + (task.blocked ? 1 : 0), 0)}</span>
            <span className="label">blocked</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="toolbar">
          <div className="search-wrap">
            <Search size={17} />
            <input value={uiState.search} onChange={(event) => updateUiState({ search: event.target.value })} onKeyDown={(event) => event.key === "Enter" && void refresh()} placeholder="Search tasks, source text, docs" />
          </div>
          <select value={uiState.status} onChange={(event) => updateUiState({ status: event.target.value as StatusFilter })}>
            <option value="all">All active</option>
            <option value="ready">Ready</option>
            <option value="blocked">Blocked</option>
            <option value="started">Started</option>
            <option value="finished">Finished</option>
            <option value="archived">Archived</option>
          </select>
          <label className="toggle"><input type="checkbox" checked={uiState.includeFinished} onChange={(event) => updateUiState({ includeFinished: event.target.checked })} /> Finished</label>
          <label className="toggle"><input type="checkbox" checked={uiState.includeArchived} onChange={(event) => updateUiState({ includeArchived: event.target.checked })} /> Archived</label>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh"><RefreshCw size={17} /></button>
        </header>

        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="loading">Loading dependency graph...</div> : null}

        {appConfig.issues?.length ? <div className="warning">Config warning: {appConfig.issues.join("; ")}</div> : null}

        {uiState.mode === "tasks" ? (
          <section className="task-layout">
            <div className="task-list-panel">
              <div className="panel-heading">
                <div>
                  <h1>Dependency-First Tasks</h1>
                  <p>Default order ranks ready work by downstream tasks unblocked, then priority and graph depth.</p>
                </div>
                <Filter size={18} />
              </div>
              <QuickCreateTask value={uiState.newTaskDraft} tasks={tasks} onChange={(newTaskDraft) => updateUiState({ newTaskDraft })} onSubmit={() => void createTask()} />
              <div className="task-list-header">
                <span />
                <span />
                <span>Task</span>
                <span>Assignee</span>
                <span>Tags</span>
                <span>Progress</span>
                <span>Actions</span>
              </div>
              <div className="task-tree" ref={taskTreeRef} onScroll={(event) => recordScrollPosition("tasks.tree", event.currentTarget.scrollTop)}>
                {roots.map((node) => (
                  <TaskNode
                    key={node.task.id}
                    node={node}
                    selectedId={selectedTask?.id ?? null}
                    collapsedTaskIds={collapsedTaskIds}
                    onSelect={(selectedId) => updateUiState({ selectedId })}
                    onToggleExpanded={toggleTaskExpanded}
                    onTransition={transitionTask}
                  />
                ))}
              </div>
            </div>
            <TaskDetails
              task={selectedTask}
              explanation={explanation}
              tracks={tracks}
              tags={tags}
              onAssign={(track, task) => void assignTask(track, task)}
              onUnassign={(task) => void unassignTask(task)}
              onAssignTag={(task, tagId) => void assignTag(task, tagId)}
              onRemoveTag={(task, tagId) => void removeTag(task, tagId)}
              onUpdate={(task, input) => void updateTask(task, input)}
              onTransition={(task, action) => void transitionTask(task, action)}
            />
          </section>
        ) : null}

        {uiState.mode === "queues" ? (
          <QueuesView tracks={tracks} tasks={tasks} newTrack={uiState.newTrackDraft} setNewTrack={(newTrackDraft) => updateUiState({ newTrackDraft })} createTrack={() => void createTrack()} onAssign={(track, task) => void assignTask(track, task)} />
        ) : null}

        {uiState.mode === "tags" ? (
          <TagsView tags={tags} tasks={tasks} newTag={uiState.newTagDraft} setNewTag={(newTagDraft) => updateUiState({ newTagDraft })} createTag={() => void createTag()} />
        ) : null}

        {uiState.mode === "coverage" ? <CoverageView coverage={coverage} /> : null}
        {uiState.mode === "activity" ? <ActivityView activity={activity} /> : null}
      </main>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function QuickCreateTask({ value, tasks, onChange, onSubmit }: { value: { id: string; title: string; parentTaskId: string; priority: string }; tasks: TaskView[]; onChange: (value: { id: string; title: string; parentTaskId: string; priority: string }) => void; onSubmit: () => void }) {
  return (
    <div className="quick-create">
      <input value={value.id} onChange={(event) => onChange({ ...value, id: event.target.value })} placeholder="ID" />
      <input value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} placeholder="Task title" />
      <select value={value.parentTaskId} onChange={(event) => onChange({ ...value, parentTaskId: event.target.value })}>
        <option value="">Root</option>
        {tasks.map((task) => <option key={task.id} value={task.id}>{task.id} {task.title}</option>)}
      </select>
      <select value={value.priority} onChange={(event) => onChange({ ...value, priority: event.target.value })}>
        <option value="4">Urgent</option>
        <option value="3">High</option>
        <option value="2">Normal</option>
        <option value="1">Low</option>
        <option value="0">Someday</option>
      </select>
      <button onClick={onSubmit}><Plus size={16} /> Add</button>
    </div>
  );
}

interface TreeNode {
  task: TaskView;
  children: TreeNode[];
}

function buildTaskTree(tasks: TaskView[]): TreeNode[] {
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

function TaskNode({
  node,
  selectedId,
  collapsedTaskIds,
  onSelect,
  onToggleExpanded,
  onTransition
}: {
  node: TreeNode;
  selectedId: string | null;
  collapsedTaskIds: Set<string>;
  onSelect: (id: string) => void;
  onToggleExpanded: (id: string) => void;
  onTransition: (task: TaskView, action: "start" | "finish" | "reopen" | "archive") => Promise<void>;
}) {
  const task = node.task;
  const expanded = !collapsedTaskIds.has(task.id);
  return (
    <div className="task-node">
      <div className={selectedId === task.id ? "task-row selected" : "task-row"} style={{ paddingLeft: `${10 + task.hierarchyDepth * 22}px` }} onClick={() => onSelect(task.id)}>
        <button className="disclosure" onClick={(event) => { event.stopPropagation(); onToggleExpanded(task.id); }} disabled={node.children.length === 0} title={expanded ? "Collapse" : "Expand"}>
          {node.children.length > 0 ? <ChevronDown size={15} className={expanded ? "" : "rotated"} /> : <span />}
        </button>
        <StatusDot status={task.computedStatus} />
        <div className="task-main">
          <div className="task-title-line">
            <strong>{task.id}</strong>
            <span>{task.title}</span>
          </div>
          <div className="task-meta">
            <span>{task.computedStatus}</span>
            <span>P{task.priority}</span>
            <span>depth {task.dependencyDepth}</span>
            <span>unblocks {task.transitiveDependentsCount}</span>
            {task.descendantsCount > 0 ? <span>{task.subtreeProgress}% subtree</span> : null}
            {getRollupStatus(task) === "blocked-by-children" ? <span className="rollup-chip">{getUnfinishedDescendantsCount(task)} child blockers</span> : null}
          </div>
        </div>
        <div className={task.assignedTrack ? "assignee-cell assigned" : "assignee-cell"}>
          <UserRound size={14} />
          <span>{task.assignedTrack?.actor ?? "unassigned"}</span>
        </div>
        <div className="tag-cell">
          {task.tags.length > 0 ? task.tags.slice(0, 3).map((tag) => <TagChip key={tag.id} tag={tag} />) : <span className="empty-cell">no tags</span>}
          {task.tags.length > 3 ? <span className="more-chip">+{task.tags.length - 3}</span> : null}
        </div>
        <Progress value={task.descendantsCount > 0 ? task.subtreeProgress : task.lifecycle === "finished" ? 100 : 0} />
        <div className="row-actions">
          {task.lifecycle === "open" ? <button title="Start" onClick={(event) => { event.stopPropagation(); void onTransition(task, "start"); }}><CircleDot size={15} /></button> : null}
          {task.lifecycle !== "finished" ? <button title="Finish" onClick={(event) => { event.stopPropagation(); void onTransition(task, "finish"); }}><Check size={15} /></button> : <button title="Reopen" onClick={(event) => { event.stopPropagation(); void onTransition(task, "reopen"); }}><RefreshCw size={15} /></button>}
          <button title="Archive" onClick={(event) => { event.stopPropagation(); void onTransition(task, "archive"); }}><Archive size={15} /></button>
        </div>
      </div>
      {expanded ? node.children.map((child) => (
        <TaskNode
          key={child.task.id}
          node={child}
          selectedId={selectedId}
          collapsedTaskIds={collapsedTaskIds}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
          onTransition={onTransition}
        />
      )) : null}
    </div>
  );
}

function TaskDetails({
  task,
  explanation,
  tracks,
  tags,
  onAssign,
  onUnassign,
  onAssignTag,
  onRemoveTag,
  onUpdate,
  onTransition
}: {
  task: TaskView | null;
  explanation: Explanation | null;
  tracks: TrackRecord[];
  tags: TagRecord[];
  onAssign: (track: TrackRecord, task: TaskView) => void;
  onUnassign: (task: TaskView) => void;
  onAssignTag: (task: TaskView, tagId: string) => void;
  onRemoveTag: (task: TaskView, tagId: string) => void;
  onUpdate: (task: TaskView, input: { title: string; description: string }) => void;
  onTransition: (task: TaskView, action: "start" | "finish" | "reopen" | "archive") => void;
}) {
  const [tagToAssign, setTagToAssign] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

  useEffect(() => {
    setDraftTitle(task?.title ?? "");
    setDraftDescription(task?.description ?? "");
  }, [task?.id, task?.title, task?.description]);

  if (!task) {
    return <aside className="details-panel empty">No task selected</aside>;
  }
  const assignableTags = tags.filter((tag) => !tag.archivedAt && !task.tags.some((taskTag) => taskTag.id === tag.id));
  const contentChanged = draftTitle.trim() !== task.title || draftDescription !== task.description;
  return (
    <aside className="details-panel">
      <div className="details-header">
        <StatusDot status={task.computedStatus} />
        <div>
          <h2>{task.id}</h2>
          <p>{task.title}</p>
        </div>
      </div>
      <section className="detail-section content-editor">
        <h3>Content</h3>
        <label>
          <span>Title</span>
          <input className="title-input" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
        </label>
        <label>
          <span>Description</span>
          <textarea className="description-textarea" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="Add implementation notes, acceptance criteria, links, or context." />
        </label>
        <div className="editor-actions">
          <button disabled={!contentChanged || !draftTitle.trim()} onClick={() => onUpdate(task, { title: draftTitle.trim(), description: draftDescription })}>Save</button>
          <button disabled={!contentChanged} onClick={() => { setDraftTitle(task.title); setDraftDescription(task.description); }}>Reset</button>
        </div>
      </section>
      <div className="detail-grid">
        <Metric label="Status" value={task.computedStatus} />
        <Metric label="Priority" value={`P${task.priority}`} />
        <Metric label="Depth" value={String(task.dependencyDepth)} />
        <Metric label="Unblocks" value={String(task.transitiveDependentsCount)} />
        <Metric label="Children" value={String(task.childrenCount)} />
        <Metric label="Progress" value={`${task.subtreeProgress}%`} />
      </div>
      <Progress value={task.subtreeProgress} large />
      <section className="detail-section">
        <h3>Hierarchy</h3>
        <p>Parent: {task.parent ? `${task.parent.id} ${task.parent.title}` : "root"}</p>
        <p>{task.descendantsCount} descendants, {task.finishedLeafDescendantsCount}/{task.leafDescendantsCount} leaf tasks finished.</p>
        <p className={getRollupStatus(task) === "blocked-by-children" ? "rollup-warning" : undefined}>Rollup: {formatRollupStatus(task)}</p>
        {getCriticalChildPath(task).length > 0 ? (
          <div className="critical-path">
            {getCriticalChildPath(task).map((child) => (
              <span key={child.id}>{child.id} [{child.computedStatus}{child.unfinishedDependenciesCount > 0 ? `, ${child.unfinishedDependenciesCount} deps` : ""}]</span>
            ))}
          </div>
        ) : null}
      </section>
      <section className="detail-section">
        <h3>Dependencies</h3>
        {explanation?.unfinishedDependencies.length ? explanation.unfinishedDependencies.map((dependency) => (
          <p key={dependency.id} className="blocked-line">{dependency.id} {dependency.title} [{dependency.lifecycle}]</p>
        )) : <p>No unfinished dependencies.</p>}
        <p className={explanation?.assignable ? "assignable yes" : "assignable no"}>{explanation?.reason ?? "Loading explanation..."}</p>
      </section>
      <section className="detail-section">
        <h3>Assignment</h3>
        <p>Current: {task.assignedTrack?.actor ?? "unassigned"}</p>
        <div className="assign-buttons">
          {tracks.filter((track) => !track.archivedAt).map((track) => (
            <button key={track.id} disabled={task.archivedAt !== null || task.lifecycle === "finished" || Boolean(task.assignedTrack)} onClick={() => onAssign(track, task)}>
              <UserRound size={15} /> {track.actor}
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
      <section className="detail-section">
        <h3>Source</h3>
        <p>{task.sourceDoc ?? "No source doc"}</p>
        <p>{task.sourceSection ?? "No source section"}</p>
      </section>
      <div className="details-actions">
        {task.lifecycle === "open" ? <button onClick={() => onTransition(task, "start")}>Start</button> : null}
        {task.lifecycle !== "finished" ? <button onClick={() => onTransition(task, "finish")}>Finish</button> : <button onClick={() => onTransition(task, "reopen")}>Reopen</button>}
      </div>
    </aside>
  );
}

function QueuesView({ tracks, tasks, newTrack, setNewTrack, createTrack, onAssign }: { tracks: TrackRecord[]; tasks: TaskView[]; newTrack: string; setNewTrack: (value: string) => void; createTrack: () => void; onAssign: (track: TrackRecord, task: TaskView) => void }) {
  const ready = tasks.filter((task) => task.ready && !task.assignedTrack);
  return (
    <section className="wide-view">
      <div className="view-heading">
        <h1>Actor Queues</h1>
        <div className="inline-create"><input value={newTrack} onChange={(event) => setNewTrack(event.target.value)} placeholder="actor name" /><button onClick={createTrack}><Plus size={16} /> Add queue</button></div>
      </div>
      <div className="queue-grid">
        {tracks.map((track) => {
          const assigned = tasks.filter((task) => task.assignedTrack?.trackId === track.id);
          return (
            <div className="queue-column" key={track.id}>
              <h2>{track.name ?? track.actor}</h2>
              {assigned.map((task) => <TaskMini key={task.id} task={task} />)}
              {assigned.length === 0 ? <p className="muted">No assigned tasks</p> : null}
              <div className="queue-ready">
                {ready.slice(0, 5).map((task) => <button key={task.id} onClick={() => onAssign(track, task)}>Assign {task.id}</button>)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TagsView({ tags, tasks, newTag, setNewTag, createTag }: { tags: TagRecord[]; tasks: TaskView[]; newTag: string; setNewTag: (value: string) => void; createTag: () => void }) {
  return (
    <section className="wide-view">
      <div className="view-heading">
        <h1>Tags</h1>
        <div className="inline-create"><input value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="tag name" /><button onClick={createTag}><Plus size={16} /> Add tag</button></div>
      </div>
      <div className="tag-grid">
        {tags.map((tag) => {
          const tagged = tasks.filter((task) => task.tags.some((candidate) => candidate.id === tag.id));
          return (
            <div className="tag-row" key={tag.id}>
              <span className="tag-swatch" style={{ background: tag.color ?? "#64748b" }} />
              <strong>{tag.name}</strong>
              <span>{tagged.length} tasks</span>
              <span>{tagged.filter((task) => task.ready).length} ready</span>
              <span>{tagged.filter((task) => task.blocked).length} blocked</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CoverageView({ coverage }: { coverage: SourceCoverage[] }) {
  return (
    <section className="wide-view">
      <div className="view-heading"><h1>Source Coverage</h1></div>
      <div className="coverage-table">
        <div className="coverage-row header"><span>Source</span><span>Total</span><span>Ready</span><span>Blocked</span><span>Started</span><span>Finished</span></div>
        {coverage.map((row, index) => (
          <div className="coverage-row" key={`${row.sourceDoc ?? "none"}-${row.sourceSection ?? "none"}-${index}`}>
            <span>{row.sourceDoc ?? "No source"} / {row.sourceSection ?? "No section"}</span>
            <span>{row.total}</span>
            <span>{row.ready}</span>
            <span>{row.blocked}</span>
            <span>{row.started}</span>
            <span>{row.finished}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityView({ activity }: { activity: ActivityRecord[] }) {
  return (
    <section className="wide-view">
      <div className="view-heading"><h1>Activity</h1></div>
      <div className="activity-list">
        {activity.map((item) => (
          <div className="activity-row" key={item.id}>
            <span>{new Date(item.createdAt).toLocaleString()}</span>
            <strong>{item.type}</strong>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskMini({ task }: { task: TaskView }) {
  return (
    <div className="task-mini">
      <StatusDot status={task.computedStatus} />
      <div><strong>{task.id}</strong><span>{task.title}</span></div>
    </div>
  );
}

function TagChip({ tag }: { tag: TagRecord }) {
  return (
    <span className="tag-chip">
      <span className="tag-dot" style={{ background: tag.color ?? "#64748b" }} />
      <span>{tag.name}</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-box"><span>{label}</span><strong>{value}</strong></div>;
}

function Progress({ value, large = false }: { value: number; large?: boolean }) {
  return <div className={large ? "progress large" : "progress"}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

function StatusDot({ status }: { status: ComputedStatus }) {
  return <span className={`status-dot ${status}`} title={status} />;
}

function formatRollupStatus(task: TaskView): string {
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

function getRollupStatus(task: TaskView): RollupStatus {
  if (task.rollupStatus) {
    return task.rollupStatus;
  }
  if (task.childrenCount === 0) {
    return "leaf";
  }
  return getUnfinishedDescendantsCount(task) === 0 ? "complete" : "blocked-by-children";
}

function getUnfinishedDescendantsCount(task: TaskView): number {
  return task.unfinishedDescendantsCount ?? Math.max(0, task.descendantsCount - task.subtreeFinishedCount);
}

function getCriticalChildPath(task: TaskView): NonNullable<TaskView["criticalChildPath"]> {
  return task.criticalChildPath ?? [];
}

function normalizeAppConfig(input: unknown): AppConfig {
  const record = isRecord(input) ? input : {};
  const ui = isRecord(record.ui) ? record.ui : {};
  const refreshIntervalMs = typeof ui.refreshIntervalMs === "number" && Number.isFinite(ui.refreshIntervalMs)
    ? Math.max(1000, Math.min(600000, Math.trunc(ui.refreshIntervalMs)))
    : DEFAULT_APP_CONFIG.ui.refreshIntervalMs;
  const persistState = typeof ui.persistState === "boolean" ? ui.persistState : DEFAULT_APP_CONFIG.ui.persistState;
  const issues = Array.isArray(record.issues) ? record.issues.filter((issue): issue is string => typeof issue === "string") : [];
  return { ui: { refreshIntervalMs, persistState }, issues };
}

function usePersistentUiState(enabled: boolean): [UiState, Dispatch<SetStateAction<UiState>>] {
  const previousEnabledRef = useRef(enabled);
  const [state, setState] = useState<UiState>(() => {
    if (!enabled) {
      return DEFAULT_UI_STATE;
    }
    return readStoredUiState();
  });

  useEffect(() => {
    if (!enabled) {
      window.localStorage.removeItem(UI_STATE_KEY);
      if (previousEnabledRef.current) {
        setState(DEFAULT_UI_STATE);
      }
      previousEnabledRef.current = enabled;
      return;
    }
    previousEnabledRef.current = enabled;
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
  }, [enabled, state]);

  return [state, setState];
}

function readStoredUiState(): UiState {
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (!raw) {
      return DEFAULT_UI_STATE;
    }
    return normalizeUiState(JSON.parse(raw) as unknown);
  } catch {
    window.localStorage.removeItem(UI_STATE_KEY);
    return DEFAULT_UI_STATE;
  }
}

function normalizeUiState(input: unknown): UiState {
  const record = isRecord(input) ? input : {};
  const mode = isViewMode(record.mode) ? record.mode : DEFAULT_UI_STATE.mode;
  const status = isStatusFilter(record.status) ? record.status : DEFAULT_UI_STATE.status;
  const selectedId = typeof record.selectedId === "string" ? record.selectedId : null;
  const collapsedTaskIds = Array.isArray(record.collapsedTaskIds)
    ? [...new Set(record.collapsedTaskIds.filter((item): item is string => typeof item === "string"))]
    : [];
  return {
    mode,
    selectedId,
    status,
    search: typeof record.search === "string" ? record.search : "",
    includeFinished: typeof record.includeFinished === "boolean" ? record.includeFinished : false,
    includeArchived: typeof record.includeArchived === "boolean" ? record.includeArchived : false,
    collapsedTaskIds,
    scrollPositions: normalizeScrollPositions(record.scrollPositions),
    newTaskDraft: normalizeNewTaskDraft(record.newTaskDraft),
    newTrackDraft: typeof record.newTrackDraft === "string" ? record.newTrackDraft : "",
    newTagDraft: typeof record.newTagDraft === "string" ? record.newTagDraft : ""
  };
}

function normalizeScrollPositions(input: unknown): Record<string, number> {
  if (!isRecord(input)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeNewTaskDraft(input: unknown): UiState["newTaskDraft"] {
  if (!isRecord(input)) {
    return DEFAULT_UI_STATE.newTaskDraft;
  }
  return {
    id: typeof input.id === "string" ? input.id : "",
    title: typeof input.title === "string" ? input.title : "",
    parentTaskId: typeof input.parentTaskId === "string" ? input.parentTaskId : "",
    priority: typeof input.priority === "string" ? input.priority : "2"
  };
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "tasks" || value === "queues" || value === "tags" || value === "coverage" || value === "activity";
}

function isStatusFilter(value: unknown): value is StatusFilter {
  return value === "all" || value === "ready" || value === "blocked" || value === "started" || value === "finished" || value === "archived";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function mutate(url: string, options: { method: string; body?: unknown }): Promise<void> {
  const init: RequestInit = {
    method: options.method,
  };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
}

type NotJiraWindow = Window & typeof globalThis & { __notJiraRoot?: Root };

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element.");
}
const notJiraWindow = window as NotJiraWindow;
const root = notJiraWindow.__notJiraRoot ?? createRoot(rootElement);
notJiraWindow.__notJiraRoot = root;
root.render(<StrictMode><App /></StrictMode>);
