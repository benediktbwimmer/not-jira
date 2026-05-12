import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { fetchJson, withProject } from "../api";
import { TaskMini } from "../components/common";
import type { QueueFeedRecord, TaskView, TrackRecord } from "../types";
import { formatActorRef } from "../utils/format";

export function QueuesView({
  tracks,
  tasks,
  feeds,
  projectId,
  newTrack,
  setNewTrack,
  createTrack,
  onAssign,
  onOpenTask
}: {
  tracks: TrackRecord[];
  tasks: TaskView[];
  feeds: QueueFeedRecord[];
  projectId: string;
  newTrack: string;
  setNewTrack: (value: string) => void;
  createTrack: () => void;
  onAssign: (track: TrackRecord, task: TaskView) => void;
  onOpenTask: (task: TaskView) => void;
}) {
  const ready = tasks.filter((task) => task.ready && !task.assignedTrack);
  const activeTracks = tracks.filter((track) => !track.archivedAt);
  const [feedTasks, setFeedTasks] = useState<Record<string, TaskView[]>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadFeedTasks() {
      const entries = await Promise.all(feeds.filter((feed) => !feed.archivedAt).map(async (feed) => {
        const candidates = await fetchJson<TaskView[]>(withProject(`/api/feeds/${feed.id}/tasks?limit=5`, projectId));
        return [feed.id, candidates] as const;
      }));
      if (!cancelled) {
        setFeedTasks(Object.fromEntries(entries));
      }
    }
    if (feeds.length === 0) {
      setFeedTasks({});
      return undefined;
    }
    void loadFeedTasks();
    return () => {
      cancelled = true;
    };
  }, [feeds, projectId]);

  return (
    <section className="wide-view">
      <div className="view-heading">
        <h1>Actor Queues</h1>
        <div className="inline-create"><input value={newTrack} onChange={(event) => setNewTrack(event.target.value)} placeholder="actor or machine:actor" /><button onClick={createTrack}><Plus size={16} /> Add queue</button></div>
      </div>
      {feeds.filter((feed) => !feed.archivedAt).length > 0 ? (
        <div className="feed-strip">
          {feeds.filter((feed) => !feed.archivedAt).map((feed) => (
            <div className="feed-card" key={feed.id}>
              <h2>{feed.name}</h2>
              <p className="muted">{feed.query}</p>
              {(feedTasks[feed.id] ?? []).map((task) => <TaskMini key={task.id} task={task} onClick={() => onOpenTask(task)} />)}
              {(feedTasks[feed.id] ?? []).length === 0 ? <p className="muted">No ready candidates</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="queue-grid">
        {activeTracks.map((track) => {
          const assigned = tasks.filter((task) => task.assignedTrack?.trackId === track.id);
          const assignedByStatus = groupQueueTasksByStatus(assigned);
          const activeAssignedCount = assignedByStatus.ready.length + assignedByStatus.blocked.length + assignedByStatus.started.length;
          return (
            <div className="queue-column" key={track.id}>
              <div className="queue-heading">
                <h2>{track.name ?? formatActorRef(track)}</h2>
                <span>{activeAssignedCount} active</span>
              </div>
              <QueueTaskSection label="Started" tasks={assignedByStatus.started} onOpenTask={onOpenTask} />
              <QueueTaskSection label="Ready" tasks={assignedByStatus.ready} onOpenTask={onOpenTask} />
              <QueueTaskSection label="Blocked" tasks={assignedByStatus.blocked} onOpenTask={onOpenTask} />
              {activeAssignedCount === 0 ? <p className="muted">No active assigned tasks</p> : null}
              {ready.length > 0 ? (
                <div className="queue-candidates">
                  <h3>Ready unassigned</h3>
                  <div className="queue-ready">
                    {ready.slice(0, 5).map((task) => <button key={task.id} onClick={() => onAssign(track, task)}>Assign {task.id}</button>)}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {activeTracks.length === 0 ? <p className="muted">No actor queues yet.</p> : null}
      </div>
    </section>
  );
}

function QueueTaskSection({ label, tasks, onOpenTask }: { label: string; tasks: TaskView[]; onOpenTask: (task: TaskView) => void }) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <div className="queue-section">
      <h3>{label} <span>{tasks.length}</span></h3>
      <div className="queue-section-list">
        {tasks.map((task) => <TaskMini key={task.id} task={task} onClick={() => onOpenTask(task)} />)}
      </div>
    </div>
  );
}

function groupQueueTasksByStatus(tasks: TaskView[]): Record<"ready" | "blocked" | "started", TaskView[]> {
  return {
    ready: tasks.filter((task) => task.computedStatus === "ready"),
    blocked: tasks.filter((task) => task.computedStatus === "blocked"),
    started: tasks.filter((task) => task.computedStatus === "started")
  };
}
