import { Plus } from "lucide-react";
import type { TagRecord, TaskView } from "../types";

export function TagsView({ tags, tasks, newTag, setNewTag, createTag }: { tags: TagRecord[]; tasks: TaskView[]; newTag: string; setNewTag: (value: string) => void; createTag: () => void }) {
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
