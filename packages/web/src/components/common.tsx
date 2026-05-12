import ReactMarkdown from "react-markdown";
import { MessageSquare } from "lucide-react";
import remarkGfm from "remark-gfm";
import type { ComputedStatus, TagRecord, TaskView } from "../types";

export function MarkdownContent({ value }: { value: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

export function DependencyItem({ task, tone, meta, statusOverride }: { task: TaskView; tone?: "blocked"; meta?: string; statusOverride?: ComputedStatus }) {
  const status = statusOverride ?? task.computedStatus;
  return (
    <div className={tone === "blocked" ? "dependency-item blocked" : "dependency-item"}>
      <StatusDot status={status} />
      <div>
        <strong>{task.title}</strong>
        <span>{task.id} / {status}{task.unfinishedDependenciesCount > 0 ? ` / ${task.unfinishedDependenciesCount} deps` : ""}{meta ? ` / ${meta}` : ""}</span>
      </div>
    </div>
  );
}

export function TaskMini({ task, onClick }: { task: TaskView; onClick?: () => void }) {
  const content = (
    <>
      <StatusDot status={task.computedStatus} />
      <div>
        <strong>{task.id}</strong>
        <span>{task.title}</span>
        {task.commentCount > 0 ? <CommentChip task={task} /> : null}
      </div>
    </>
  );
  return onClick ? (
    <button className="task-mini clickable" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="task-mini">
      {content}
    </div>
  );
}

export function CommentChip({ task }: { task: TaskView }) {
  return (
    <span className={task.recentCommentCount > 0 ? "comment-chip recent" : "comment-chip"} title={`${task.commentCount} ${task.commentCount === 1 ? "comment" : "comments"}`}>
      <span>{task.commentCount}</span>
      <MessageSquare size={13} />
    </span>
  );
}

export function TagChip({ tag }: { tag: TagRecord }) {
  return (
    <span className="tag-chip">
      <span className="tag-dot" style={{ background: tag.color ?? "#64748b" }} />
      <span>{tag.name}</span>
    </span>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-box"><span>{label}</span><strong>{value}</strong></div>;
}

export function Progress({ value, large = false }: { value: number; large?: boolean }) {
  return <div className={large ? "progress large" : "progress"}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function StatusDot({ status }: { status: ComputedStatus }) {
  return <span className={`status-dot ${status}`} title={status} />;
}
