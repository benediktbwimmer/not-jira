import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Archive, Check, Plus, RefreshCw, Search } from "lucide-react";
import { getKeyboardShortcuts, mutateJson, withProject } from "../api";
import { MarkdownContent, StatusDot } from "../components/common";
import { configureMatcherLanguage, MatcherGrammarPanel } from "../matcher/MatcherEditor";
import type { InstructionRecord, MatcherGrammarRecord, MatcherPreviewRecord, TaskView } from "../types";

interface InstructionDraft {
  id: string;
  name: string;
  query: string;
  body: string;
  enabled: boolean;
  archivedAt: string | null;
  isNew: boolean;
}

export function InstructionsView({
  projectId,
  instructions,
  grammar,
  tasks,
  onRefresh,
  onOpenTask
}: {
  projectId: string;
  instructions: InstructionRecord[];
  grammar: MatcherGrammarRecord | null;
  tasks: TaskView[];
  onRefresh: () => Promise<void>;
  onOpenTask: (task: TaskView) => void;
}) {
  const sortedInstructions = useMemo(() => [...instructions].sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || a.name.localeCompare(b.name)), [instructions]);
  const [selectedInstructionId, setSelectedInstructionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<InstructionDraft>(() => makeNewInstructionDraft());
  const [preview, setPreview] = useState<MatcherPreviewRecord | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const initializedSelectionRef = useRef(false);
  const shortcuts = useMemo(() => getKeyboardShortcuts(), []);
  const selectedInstruction = selectedInstructionId ? instructions.find((instruction) => instruction.id === selectedInstructionId) ?? null : null;
  const dirty = selectedInstruction
    ? draft.name.trim() !== selectedInstruction.name
      || draft.query.trim() !== selectedInstruction.query
      || draft.body !== selectedInstruction.body
      || draft.enabled !== selectedInstruction.enabled
    : draft.name.trim().length > 0 || draft.query.trim().length > 0 || draft.body.trim().length > 0;
  const previewMatches = preview?.matches ?? [];
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  useEffect(() => {
    initializedSelectionRef.current = false;
    setSelectedInstructionId(null);
    setDraft(makeNewInstructionDraft());
    setPreview(null);
  }, [projectId]);

  useEffect(() => {
    if (initializedSelectionRef.current) {
      return;
    }
    const firstActive = sortedInstructions.find((instruction) => !instruction.archivedAt);
    const first = firstActive ?? sortedInstructions[0] ?? null;
    if (first) {
      setSelectedInstructionId(first.id);
    }
    initializedSelectionRef.current = true;
  }, [sortedInstructions]);

  useEffect(() => {
    if (!selectedInstruction) {
      return;
    }
    setDraft({
      id: selectedInstruction.id,
      name: selectedInstruction.name,
      query: selectedInstruction.query,
      body: selectedInstruction.body,
      enabled: selectedInstruction.enabled,
      archivedAt: selectedInstruction.archivedAt,
      isNew: false
    });
    setPreview(null);
  }, [selectedInstruction]);

  function startNewInstruction() {
    setSelectedInstructionId(null);
    setDraft(makeNewInstructionDraft());
    setPreview(null);
  }

  async function saveInstruction() {
    const body = {
      id: draft.id.trim() || undefined,
      name: draft.name.trim(),
      query: draft.query.trim(),
      body: draft.body,
      enabled: draft.enabled
    };
    if (!body.name || !body.query) {
      return;
    }
    const saved = draft.isNew
      ? await mutateJson<InstructionRecord>(withProject("/api/instructions", projectId), { method: "POST", body })
      : await mutateJson<InstructionRecord>(withProject(`/api/instructions/${draft.id}`, projectId), { method: "PATCH", body });
    setSelectedInstructionId(saved.id);
    setDraft({
      id: saved.id,
      name: saved.name,
      query: saved.query,
      body: saved.body,
      enabled: saved.enabled,
      archivedAt: saved.archivedAt,
      isNew: false
    });
    await onRefresh();
    await previewInstruction(saved.query);
  }

  async function archiveInstruction() {
    if (draft.isNew) {
      return;
    }
    await mutateJson<InstructionRecord>(withProject(`/api/instructions/${draft.id}/archive`, projectId), { method: "POST" });
    await onRefresh();
  }

  async function restoreInstruction() {
    if (draft.isNew) {
      return;
    }
    const restored = await mutateJson<InstructionRecord>(withProject(`/api/instructions/${draft.id}/restore`, projectId), { method: "POST" });
    setSelectedInstructionId(restored.id);
    await onRefresh();
  }

  async function previewInstruction(query = draft.query) {
    setPreviewLoading(true);
    try {
      const result = await mutateJson<MatcherPreviewRecord>(withProject("/api/instructions/preview", projectId), { method: "POST", body: { query } });
      setPreview(result);
    } finally {
      setPreviewLoading(false);
    }
  }

  const handleInstructionEditorMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      editor.trigger("keyboard", "editor.action.triggerSuggest", {});
    });
  }, []);

  return (
    <section className="instruction-layout">
      <div className="instruction-list-panel">
        <div className="view-heading">
          <div>
            <h1>Instructions</h1>
            <p>Matched dynamically when tasks are shown. They are never copied onto tasks.</p>
          </div>
          <button onClick={startNewInstruction}><Plus size={16} /> New</button>
        </div>
        <div className="instruction-list">
          {sortedInstructions.map((instruction) => (
            <button
              key={instruction.id}
              className={selectedInstructionId === instruction.id ? "instruction-list-item active" : "instruction-list-item"}
              onClick={() => setSelectedInstructionId(instruction.id)}
            >
              <div>
                <strong>{instruction.name}</strong>
                <span>{instruction.query}</span>
              </div>
              <span className={instruction.enabled && !instruction.archivedAt ? "status-chip ready" : "status-chip archived"}>
                {instruction.archivedAt ? "archived" : instruction.enabled ? "enabled" : "disabled"}
              </span>
            </button>
          ))}
          {sortedInstructions.length === 0 ? <p className="muted">No instructions yet.</p> : null}
        </div>
      </div>

      <div className="instruction-editor-panel">
        <div className="instruction-editor-header">
          <div>
            <h1>{draft.isNew ? "New Instruction" : draft.name}</h1>
            <p>{draft.isNew ? "Create a matcher and body." : draft.id}</p>
          </div>
          <div className="details-actions">
            <button className="primary-button" disabled={!dirty || !draft.name.trim() || !draft.query.trim()} onClick={() => void saveInstruction()}>
              <Check size={15} /> Save
            </button>
            <button disabled={!draft.query.trim() || previewLoading} onClick={() => void previewInstruction()}>
              <Search size={15} /> {previewLoading ? "Checking" : "Show matching tasks"}
            </button>
            {!draft.isNew && !draft.archivedAt ? <button className="subtle-button" onClick={() => void archiveInstruction()}><Archive size={15} /> Archive</button> : null}
            {!draft.isNew && draft.archivedAt ? <button onClick={() => void restoreInstruction()}><RefreshCw size={15} /> Restore</button> : null}
          </div>
        </div>

        <div className="instruction-form">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Instruction name" />
          </label>
          <label>
            <span>ID</span>
            <input disabled={!draft.isNew} value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} placeholder="auto from name" />
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
            <span>Enabled</span>
          </label>
        </div>

        <div className="matcher-query-block">
          <div className="field-heading">
            <span>Matcher</span>
            <code>depends on TASK depth = 1 and tag = backend</code>
          </div>
          <p className="shortcut-hint"><kbd>{shortcuts.suggest}</kbd> show suggestions</p>
          <div className="monaco-shell">
            <Editor
              key={`${projectId}-${grammar ? "ready" : "loading"}`}
              height="340px"
              defaultLanguage="unblock-query"
              language="unblock-query"
              theme="unblock"
              beforeMount={configureMatcherLanguage}
              onMount={handleInstructionEditorMount}
              value={draft.query}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: "off",
                folding: false,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                overviewRulerLanes: 0,
                renderLineHighlight: "none"
              }}
              onChange={(value) => setDraft((current) => ({ ...current, query: value ?? "" }))}
            />
          </div>
        </div>

        <div className="instruction-body-block">
          <div className="field-heading">
            <span>Instruction Markdown</span>
          </div>
          <textarea value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} placeholder="Write the guidance that matching tasks should include." />
          {draft.body.trim() ? <MarkdownContent value={draft.body} /> : null}
        </div>

        {preview ? (
          <div className="instruction-preview">
            <div className="field-heading">
              <span>Matches</span>
              <strong>{preview.ok ? `${previewMatches.length} tasks` : `${preview.errors.length} errors`}</strong>
            </div>
            {!preview.ok ? (
              <div className="error compact">{preview.errors.join("; ")}</div>
            ) : (
              <div className="match-list">
                {previewMatches.map((match) => {
                  const task = taskById.get(match.task.id) ?? match.task;
                  return (
                    <button key={task.id} className="match-row" onClick={() => onOpenTask(task)}>
                      <StatusDot status={task.computedStatus} />
                      <div>
                        <strong>{task.id} {task.title}</strong>
                        <span>{match.reasons.join(", ") || "matched"}</span>
                      </div>
                    </button>
                  );
                })}
                {previewMatches.length === 0 ? <p className="muted">No tasks match this query.</p> : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <MatcherGrammarPanel grammar={grammar} />
    </section>
  );
}

function makeNewInstructionDraft(): InstructionDraft {
  return {
    id: "",
    name: "",
    query: "",
    body: "",
    enabled: true,
    archivedAt: null,
    isNew: true
  };
}
