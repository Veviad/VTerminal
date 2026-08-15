import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  FilePlus2,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  runbooksDraftCreate,
  runbooksDraftDiscard,
  runbooksDraftGet,
  runbooksDraftPublish,
  runbooksDraftSave,
  runbooksDraftValidate,
  runbooksDraftsList,
  type OnFailure,
  type RunbookDraft,
  type RunbookDraftDocument,
  type RunbookDraftInput,
  type RunbookDraftPreview,
  type RunbookDraftStep,
  type RunbookDraftSummary,
  type RunbookInputType,
  type RunbookSource,
} from "../../lib/runbooks";
import { RunbookAiGenerator } from "./RunbookAiGenerator";
import { fieldClass, labelClass, parseCodes, parseMappings, TextField } from "./runbookFields";
import { Remediation } from "./RunbookRemediationFields";
import { secondaryButton } from "./runbookUi";

const stages = ["Basics", "Inputs", "Checks", "Review"] as const;

export function NewRunbookWizard({
  onPublished,
}: {
  onPublished: (source: RunbookSource) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [summaries, setSummaries] = useState<RunbookDraftSummary[]>([]);
  const [draft, setDraft] = useState<RunbookDraft | null>(null);
  const [document, setDocument] = useState<RunbookDraftDocument | null>(null);
  const [stage, setStage] = useState(0);
  const [preview, setPreview] = useState<RunbookDraftPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);
  const savedJsonRef = useRef("");
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const loadSummaries = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSummaries(await runbooksDraftsList());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open && !draft) void loadSummaries();
  }, [draft, loadSummaries, open]);

  /** `atStage` exists for the AI path: a generated draft is fully populated, so
   *  Basics is the wrong place to land — the issue list on Review is what the
   *  operator needs to see before they trust any of it. */
  const installDraft = (next: RunbookDraft, atStage = 0) => {
    setDraft(next);
    setDocument(next.document);
    revisionRef.current = next.revision;
    savedJsonRef.current = JSON.stringify(next.document);
    setPreview(null);
    setStage(atStage);
  };

  const enqueueSave = useCallback((snapshot: RunbookDraftDocument, draftId: string) => {
    const serialized = JSON.stringify(snapshot);
    if (serialized === savedJsonRef.current) return saveChainRef.current;
    saveChainRef.current = saveChainRef.current.catch(() => undefined).then(async () => {
      if (serialized === savedJsonRef.current) return;
      setSaving(true);
      try {
        const saved = await runbooksDraftSave(draftId, revisionRef.current, snapshot);
        revisionRef.current = saved.revision;
        savedJsonRef.current = serialized;
        setDraft((current) => (current ? { ...saved, document: current.document } : saved));
        setError(null);
      } catch (reason) {
        setError(String(reason));
        throw reason;
      } finally {
        setSaving(false);
      }
    });
    return saveChainRef.current;
  }, []);

  useEffect(() => {
    if (!draft || !document) return;
    const timeout = window.setTimeout(() => {
      void enqueueSave(document, draft.id).catch(() => undefined);
    }, 650);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [document, draft, enqueueSave]);

  const flushSave = async () => {
    if (!draft || !document) return;
    await enqueueSave(document, draft.id);
    await saveChainRef.current;
  };

  const close = useCallback(() => {
    if (draft && document) void enqueueSave(document, draft.id).catch(() => undefined);
    setOpen(false);
    setDraft(null);
    setDocument(null);
    setPreview(null);
    setError(null);
  }, [document, draft, enqueueSave]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, open]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      installDraft(await runbooksDraftCreate());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  /**
   * A generated draft opens on Review, already validated.
   *
   * Landing on Basics would ask the operator to page through four stages before
   * seeing whether the thing is even publishable. The preview is fetched here
   * rather than by calling `review()` because that reads `draft` from state,
   * which has not committed yet on this tick.
   */
  const installGenerated = async (created: RunbookDraft) => {
    installDraft(created, 3);
    setBusy(true);
    setError(null);
    try {
      setPreview(await runbooksDraftValidate(created.id));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resume = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      installDraft(await runbooksDraftGet(id));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const discard = async (summary: RunbookDraftSummary) => {
    const detail = summary.publishedSourceId
      ? "The published runbook remains in the Library, but it will no longer be editable in the wizard."
      : "This incomplete draft will be deleted.";
    if (!window.confirm(`Discard “${summary.title || "Untitled runbook"}”? ${detail}`)) return;
    setBusy(true);
    try {
      await runbooksDraftDiscard(summary.id);
      await loadSummaries();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await flushSave();
      setPreview(await runbooksDraftValidate(draft.id));
      setStage(3);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await flushSave();
      const checked = await runbooksDraftValidate(draft.id);
      setPreview(checked);
      if (checked.issues.length > 0) return;
      const source = await runbooksDraftPublish(draft.id, revisionRef.current);
      await onPublished(source);
      close();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const focusIssue = (path: string) => {
    let nextStage = 0;
    let target = "wizard-definition-id";
    if (path.startsWith("spec.inputs")) {
      nextStage = 1;
      target = "wizard-input-id-0";
    } else if (path.startsWith("spec.steps")) {
      nextStage = 2;
      const match = path.match(/^spec\.steps\[(\d+)\]/);
      const guardOffset = document?.platform === "any" ? 0 : 1;
      const index = Math.max(0, Number(match?.[1] ?? guardOffset) - guardOffset);
      target = `wizard-step-id-${index}`;
    } else if (path.startsWith("spec.declaredCapabilities.writes")) {
      target = "wizard-writes";
    } else if (path === "metadata.version") {
      target = "wizard-version";
    } else if (path === "metadata.title") {
      target = "wizard-title";
    }
    setStage(nextStage);
    window.requestAnimationFrame(() => {
      window.document.getElementById(target)?.focus();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className={`${secondaryButton} min-w-0 flex-1`}
      >
        <FilePlus2 size={12} /> New
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-10">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-runbook-title"
        className="flex max-h-[calc(100vh-5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-elevated shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <h2 id="new-runbook-title" className="text-[14px] font-medium text-text-primary">
              {draft ? "New runbook wizard" : "Runbook drafts"}
            </h2>
            <p className="text-[9px] text-text-muted">
              Checks and remediation · saved locally · every command approved when run
            </p>
          </div>
          <button type="button" autoFocus onClick={close} aria-label="Close wizard" className="text-text-muted hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        {!draft || !document ? (
          <DraftChooser
            summaries={summaries}
            busy={busy}
            error={error}
            onCreate={() => void create()}
            onGenerated={installGenerated}
            onResume={(id) => void resume(id)}
            onDiscard={(summary) => void discard(summary)}
          />
        ) : (
          <>
            <nav aria-label="Wizard progress" className="grid grid-cols-4 border-b border-border-subtle">
              {stages.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    if (index === 3) void review();
                    else setStage(index);
                  }}
                  className={`px-2 py-2 text-[10px] ${index === stage ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-bg-hover"}`}
                >
                  <span className="me-1 font-mono text-[8px]">{index + 1}</span>{label}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {stage === 0 && <Basics document={document} onChange={setDocument} />}
              {stage === 1 && <Inputs document={document} onChange={setDocument} />}
              {stage === 2 && <Checks document={document} onChange={setDocument} />}
              {stage === 3 && <Review preview={preview} document={document} onIssue={focusIssue} />}
            </div>
            <footer className="flex items-center justify-between gap-2 border-t border-border-subtle px-4 py-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1 text-[9px] text-text-muted">
                  {saving ? <Loader2 size={9} className="animate-spin" /> : <Save size={9} />}
                  {saving ? "Saving draft…" : "Draft saved locally"}
                </p>
                {error && <p className="max-w-xl truncate text-[9px] text-error" title={error}>{error}</p>}
              </div>
              <div className="flex gap-1.5">
                {stage > 0 && (
                  <button type="button" onClick={() => {
                    setStage(stage - 1);
                  }} className={secondaryButton}>
                    <ArrowLeft size={11} /> Back
                  </button>
                )}
                {stage < 2 && (
                  <button type="button" onClick={() => {
                    setStage(stage + 1);
                  }} className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[10px] text-white">
                    Next <ArrowRight size={11} />
                  </button>
                )}
                {stage === 2 && (
                  <button type="button" disabled={busy} onClick={() => void review()} className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[10px] text-white disabled:opacity-50">
                    {busy && <Loader2 size={10} className="animate-spin" />} Review
                  </button>
                )}
                {stage === 3 && (
                  <button type="button" disabled={busy || !preview || preview.issues.length > 0} onClick={() => void publish()} className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[10px] text-white disabled:opacity-50">
                    {busy ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />} Publish to Library
                  </button>
                )}
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function DraftChooser({ summaries, busy, error, onCreate, onGenerated, onResume, onDiscard }: {
  summaries: RunbookDraftSummary[];
  busy: boolean;
  error: string | null;
  onCreate: () => void;
  onGenerated: (draft: RunbookDraft) => Promise<void>;
  onResume: (id: string) => void;
  onDiscard: (summary: RunbookDraftSummary) => void;
}) {
  return (
    <div className="min-h-64 overflow-y-auto p-4">
      <button type="button" disabled={busy} onClick={onCreate} className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-accent/50 bg-accent/5 px-3 py-4 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-50">
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Start from scratch
      </button>
      {/* Sibling of the manual path, not a mode: a generated draft is an
          ordinary draft, and both land in the same stages. */}
      <RunbookAiGenerator disabled={busy} onGenerated={onGenerated} />
      {summaries.length === 0 && !busy ? <p className="py-6 text-center text-[10px] text-text-muted">No saved drafts yet.</p> : null}
      <div className="space-y-2">
        {summaries.map((summary) => (
          <article key={summary.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-card p-3">
            <div className="min-w-0">
              <p className="truncate text-[11px] text-text-primary">{summary.title || "Untitled runbook"}</p>
              <p className="truncate font-mono text-[9px] text-text-muted">{summary.definitionId || "No ID"} · v{summary.version}</p>
              <p className="mt-1 text-[8px] text-text-muted">{summary.publishedSourceId ? (summary.dirty ? "Unpublished changes" : "Published") : "Draft"}</p>
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={() => {
                onResume(summary.id);
              }} className={secondaryButton}>Resume</button>
              <button type="button" onClick={() => {
                onDiscard(summary);
              }} aria-label={`Discard ${summary.title || "draft"}`} className="rounded p-1.5 text-text-muted hover:bg-error/10 hover:text-error"><Trash2 size={12} /></button>
            </div>
          </article>
        ))}
      </div>
      {error && <p className="mt-3 text-[9px] text-error">{error}</p>}
    </div>
  );
}

function Basics({ document, onChange }: EditorProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <TextField inputId="wizard-definition-id" label="Runbook ID" value={document.definitionId} placeholder="workstation-health" onChange={(definitionId) => {
          onChange({ ...document, definitionId });
        }} />
        <TextField inputId="wizard-version" label="Semantic version" value={document.version} placeholder="1.0.0" onChange={(version) => {
          onChange({ ...document, version });
        }} />
      </div>
      <TextField inputId="wizard-title" label="Title" value={document.title} placeholder="Workstation Health Assessment" onChange={(title) => {
        onChange({ ...document, title });
      }} />
      <label className={labelClass}>Description<textarea className={`${fieldClass} min-h-24 resize-y`} value={document.description} onChange={(event) => {
        onChange({ ...document, description: event.target.value });
      }} /></label>
      <TextField label="Tags (comma separated)" value={document.tags.join(", ")} placeholder="macos, security, assessment" onChange={(value) => {
        onChange({ ...document, tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) });
      }} />
      <div className="grid grid-cols-2 gap-3">
        <label className={labelClass}>Target platform<select className={fieldClass} value={document.platform} onChange={(event) => {
          onChange({ ...document, platform: event.target.value as RunbookDraftDocument["platform"] });
        }}><option value="macos13">macOS 13+</option><option value="linux">Linux</option><option value="any">Any active terminal</option></select></label>
        <label className={labelClass}>Default on failure<select className={fieldClass} value={document.defaultOnFailure} onChange={(event) => {
          onChange({ ...document, defaultOnFailure: event.target.value as OnFailure });
        }}><option value="continue">Continue collecting</option><option value="pause">Pause for operator</option><option value="stop">Stop run</option></select></label>
      </div>
      {document.platform === "any" && <p className="rounded border border-warning/30 bg-warning/10 p-2 text-[9px] text-warning">No operating-system guard will be generated. Every command must be portable or handle platform differences itself.</p>}
      <fieldset className="rounded-lg border border-border-subtle p-3">
        <legend className="px-1 text-[9px] text-text-muted">Declared capabilities</legend>
        <div className="flex flex-wrap gap-4 text-[10px] text-text-secondary">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={document.network} onChange={(event) => {
            onChange({ ...document, network: event.target.checked });
          }} /> Uses network</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={document.privilege === "root"} onChange={(event) => {
            onChange({ ...document, privilege: event.target.checked ? "root" : "none" });
          }} /> Requires root privilege</label>
        </div>
        <div className="mt-2">
          <TextField inputId="wizard-writes" label="Paths this runbook writes to (comma separated, absolute)" value={document.writes.join(", ")} placeholder="/etc/nginx, /usr/local/etc" onChange={(value) => {
            onChange({ ...document, writes: value.split(",").map((path) => path.trim()).filter(Boolean) });
          }} />
        </div>
        {/* Shown before anything runs, so an omission is a broken promise
            rather than a cosmetic gap. Only relevant once a step remediates. */}
        <p className="mt-2 text-[8px] text-text-muted">{document.steps.some((step) => step.apply) ? "This runbook changes the target. Every path it writes to belongs here — the operator sees this list before the first command runs." : "Leave empty for a check-only assessment."}</p>
      </fieldset>
    </div>
  );
}

function Inputs({ document, onChange }: EditorProps) {
  const add = () => {
    onChange({ ...document, inputs: [...document.inputs, { id: "", type: "string", description: "", required: false, default: null, values: [] }] });
  };
  const update = (index: number, input: RunbookDraftInput) => {
    onChange({ ...document, inputs: document.inputs.map((item, itemIndex) => itemIndex === index ? input : item) });
  };
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="flex items-center justify-between"><div><h3 className="text-[12px] text-text-primary">Runtime inputs</h3><p className="text-[9px] text-text-muted">Shell commands receive inputs only through explicit VRUN_* mappings.</p></div><button type="button" onClick={add} className={secondaryButton}><Plus size={11} /> Add input</button></div>
      {document.inputs.length === 0 && <Empty>No inputs are required for this assessment.</Empty>}
      {document.inputs.map((input, index) => (
        <article key={index} className="rounded-lg border border-border-subtle bg-bg-card p-3">
          <div className="grid grid-cols-[1fr_10rem_auto] gap-2">
            <TextField inputId={`wizard-input-id-${index}`} label="Input ID" value={input.id} onChange={(id) => {
              update(index, { ...input, id });
            }} />
            <label className={labelClass}>Type<select className={fieldClass} value={input.type} onChange={(event) => {
              update(index, { ...input, type: event.target.value as RunbookInputType, default: null, values: [] });
            }}>{["string", "integer", "boolean", "path", "enum"].map((type) => <option key={type}>{type}</option>)}</select></label>
            <button type="button" aria-label="Remove input" onClick={() => {
              onChange({ ...document, inputs: document.inputs.filter((_, itemIndex) => itemIndex !== index) });
            }} className="mt-4 rounded p-1.5 text-text-muted hover:text-error"><Trash2 size={12} /></button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <TextField label="Description" value={input.description} onChange={(description) => {
              update(index, { ...input, description });
            }} />
            {input.type === "enum" ? <TextField label="Allowed values (comma separated)" value={input.values.join(", ")} onChange={(value) => {
              update(index, { ...input, values: value.split(",").map((item) => item.trim()).filter(Boolean) });
            }} /> : <DefaultField input={input} onChange={(value) => {
              update(index, { ...input, default: value });
            }} />}
          </div>
          {input.type === "enum" && <label className={`${labelClass} mt-2`}>Default<select className={fieldClass} value={typeof input.default === "string" ? input.default : ""} onChange={(event) => {
            update(index, { ...input, default: event.target.value || null });
          }}><option value="">No default</option>{input.values.map((value) => <option key={value}>{value}</option>)}</select></label>}
          <label className="mt-2 flex items-center gap-1.5 text-[9px] text-text-muted"><input type="checkbox" checked={input.required} onChange={(event) => {
            update(index, { ...input, required: event.target.checked });
          }} /> Required when no default is present</label>
        </article>
      ))}
    </div>
  );
}

function Checks({ document, onChange }: EditorProps) {
  const add = () => {
    onChange({ ...document, steps: [...document.steps, { id: "", title: "", required: true, onFailure: null, check: { kind: "shell", command: "", env: {}, compliantExitCodes: [0], noncompliantExitCodes: [1] }, apply: null, verify: null }] });
  };
  const update = (index: number, step: RunbookDraftStep) => {
    onChange({ ...document, steps: document.steps.map((item, itemIndex) => itemIndex === index ? step : item) });
  };
  const move = (index: number, delta: number) => { const steps = [...document.steps]; const [step] = steps.splice(index, 1); steps.splice(index + delta, 0, step); onChange({ ...document, steps }); };
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="flex items-center justify-between"><div><h3 className="text-[12px] text-text-primary">Steps</h3><p className="text-[9px] text-text-muted">A check decides whether work is needed. Add remediation to also do it. Every command still requires operator approval when run.</p></div><button type="button" onClick={add} className={secondaryButton}><Plus size={11} /> Add step</button></div>
      {document.steps.length === 0 && <Empty>Add at least one shell or manual check.</Empty>}
      {document.steps.map((step, index) => (
        <article key={index} className="rounded-lg border border-border-subtle bg-bg-card p-3">
          <div className="mb-2 flex items-center justify-between"><span className="font-mono text-[9px] text-text-muted">Check {index + 1}</span><div className="flex"><IconButton label="Move up" disabled={index === 0} onClick={() => {
            move(index, -1);
          }}><ArrowUp size={11} /></IconButton><IconButton label="Move down" disabled={index === document.steps.length - 1} onClick={() => {
            move(index, 1);
          }}><ArrowDown size={11} /></IconButton><IconButton label="Remove check" onClick={() => {
            onChange({ ...document, steps: document.steps.filter((_, itemIndex) => itemIndex !== index) });
          }}><Trash2 size={11} /></IconButton></div></div>
          <div className="grid grid-cols-2 gap-2"><TextField inputId={`wizard-step-id-${index}`} label="Stable step ID" value={step.id} onChange={(id) => {
            update(index, { ...step, id });
          }} /><TextField label="Title" value={step.title} onChange={(title) => {
            update(index, { ...step, title });
          }} /></div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <label className={labelClass}>Check type<select className={fieldClass} value={step.check.kind} onChange={(event) => {
              update(index, { ...step, check: event.target.value === "manual" ? { kind: "manual", instructions: "" } : { kind: "shell", command: "", env: {}, compliantExitCodes: [0], noncompliantExitCodes: [1] } });
            }}><option value="shell">Shell</option><option value="manual">Manual</option></select></label>
            <label className={labelClass}>On failure<select className={fieldClass} value={step.onFailure ?? ""} onChange={(event) => {
              update(index, { ...step, onFailure: (event.target.value || null) as OnFailure | null });
            }}><option value="">Use runbook default</option><option value="continue">Continue</option><option value="pause">Pause</option><option value="stop">Stop</option></select></label>
            <label className="mt-5 flex items-center gap-1.5 text-[9px] text-text-muted"><input type="checkbox" checked={step.required} onChange={(event) => {
              update(index, { ...step, required: event.target.checked });
            }} /> Required control</label>
          </div>
          {step.check.kind === "shell" ? <ShellCheck check={step.check} onChange={(check) => {
            update(index, { ...step, check });
          }} /> : <label className={`${labelClass} mt-2`}>Operator instructions<textarea className={`${fieldClass} min-h-24`} value={step.check.instructions} onChange={(event) => {
            update(index, { ...step, check: { kind: "manual", instructions: event.target.value } });
          }} /></label>}
          <Remediation step={step} onChange={(next) => {
            update(index, next);
          }} />
        </article>
      ))}
    </div>
  );
}

function ShellCheck({ check, onChange }: { check: Extract<RunbookDraftStep["check"], { kind: "shell" }>; onChange: (check: Extract<RunbookDraftStep["check"], { kind: "shell" }>) => void }) {
  return <div className="mt-2 space-y-2"><label className={labelClass}>Single-line command<textarea className={`${fieldClass} min-h-16 font-mono`} value={check.command} onChange={(event) => {
    onChange({ ...check, command: event.target.value });
  }} /></label><label className={labelClass}>Input mappings (one <code>VRUN_NAME=inputId</code> per line)<textarea className={`${fieldClass} min-h-14 font-mono`} value={Object.entries(check.env).map(([name, id]) => `${name}=${id}`).join("\n")} onChange={(event) => {
    onChange({ ...check, env: parseMappings(event.target.value) });
  }} /></label><details><summary className="cursor-pointer text-[9px] text-text-muted">Advanced exit codes</summary><div className="mt-2 grid grid-cols-2 gap-2"><TextField label="Compliant codes" value={check.compliantExitCodes.join(", ")} onChange={(value) => {
    onChange({ ...check, compliantExitCodes: parseCodes(value) });
  }} /><TextField label="Non-compliant codes" value={check.noncompliantExitCodes.join(", ")} onChange={(value) => {
    onChange({ ...check, noncompliantExitCodes: parseCodes(value) });
  }} /></div></details></div>;
}

function Review({ preview, document, onIssue }: { preview: RunbookDraftPreview | null; document: RunbookDraftDocument; onIssue: (path: string) => void }) {
  if (!preview) return <p className="py-10 text-center text-[10px] text-text-muted">Saving and validating preview…</p>;
  return <div className="mx-auto max-w-3xl space-y-3"><div className={`rounded-lg border p-3 ${preview.issues.length ? "border-error/30 bg-error/10" : "border-success/30 bg-success/10"}`}><p className="text-[11px] font-medium text-text-primary">{preview.issues.length ? `${preview.issues.length} issue${preview.issues.length === 1 ? "" : "s"} must be fixed` : "Ready to publish"}</p>{preview.issues.map((issue, index) => <button type="button" key={`${issue.path}:${index}`} onClick={() => {
    onIssue(issue.path);
  }} className="mt-1 block text-start text-[9px] text-error hover:underline"><code>{issue.path}</code>: {issue.message}</button>)}</div><div className="grid grid-cols-3 gap-2 text-[9px]"><Summary label="Platform" value={document.platform === "macos13" ? "macOS 13+" : document.platform === "linux" ? "Linux" : "Any"} /><Summary label="Inputs" value={String(document.inputs.length)} /><Summary label="Steps" value={`${document.steps.length + (document.platform === "any" ? 0 : 1)}${document.steps.some((step) => step.apply) ? ` · ${document.steps.filter((step) => step.apply).length} remediating` : ""}`} /></div>{preview.sourceYaml && <details open><summary className="cursor-pointer text-[10px] text-text-secondary">Generated runbook.vrun.yaml</summary><pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border-subtle bg-bg-primary p-3 text-[9px] text-text-muted">{preview.sourceYaml}</pre></details>}</div>;
}

type EditorProps = { document: RunbookDraftDocument; onChange: (document: RunbookDraftDocument) => void };
function DefaultField({ input, onChange }: { input: RunbookDraftInput; onChange: (value: string | number | boolean | null) => void }) { if (input.type === "boolean") return <label className={labelClass}>Default<select className={fieldClass} value={input.default == null ? "" : String(input.default)} onChange={(event) => {
  onChange(event.target.value === "" ? null : event.target.value === "true");
}}><option value="">No default</option><option value="false">false</option><option value="true">true</option></select></label>; return <TextField label="Default (optional)" value={input.default == null ? "" : String(input.default)} onChange={(value) => {
  onChange(value === "" ? null : input.type === "integer" ? Number(value) : value);
}} />; }
function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) { return <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-30">{children}</button>; }
function Empty({ children }: { children: ReactNode }) { return <p className="rounded-lg border border-dashed border-border-subtle p-5 text-center text-[10px] text-text-muted">{children}</p>; }
function Summary({ label, value }: { label: string; value: string }) { return <div className="rounded border border-border-subtle bg-bg-card p-2"><p className="text-text-muted">{label}</p><p className="mt-1 text-text-primary">{value}</p></div>; }
