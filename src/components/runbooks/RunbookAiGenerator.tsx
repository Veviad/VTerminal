import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { aiCancel } from "../../lib/tauri";
import {
  blocksOf,
  collectSessionBlocks,
  contextAvailability,
  renderContext,
  type RunbookContextBlock,
} from "../../lib/runbookAiContext";
import { runbooksAiGenerate, runbooksDraftCreate, type RunbookDraft } from "../../lib/runbooks";
import { resolveSessionTitle } from "../../lib/sessionTitle";
import { useAppStore } from "../../stores/appStore";
import { secondaryButton } from "./runbookUi";

const fieldClass =
  "mt-1 w-full rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent";
const labelClass = "block text-[9px] text-text-muted";

let requestCounter = 1;

/**
 * Author a Runbook from what the operator wants plus, optionally, the session
 * where they already did it by hand.
 *
 * The result is an ordinary draft. It is created through `runbooksDraftCreate`
 * like any other, so nothing downstream — autosave, validation, publish, run —
 * knows or cares that a model wrote it, and the operator edits it in the same
 * stages before deciding to save.
 *
 * The terminal payload is shown in full and stays editable. That is not a
 * nicety: a session is the richest source of secrets a user has, and this asks
 * a model to read all of it. Nothing leaves the machine that the operator has
 * not seen in the box below the checkboxes.
 */
export function RunbookAiGenerator({
  onGenerated,
  disabled,
}: {
  onGenerated: (draft: RunbookDraft) => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const cancelledRequestRef = useRef<string | null>(null);

  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionUi = useAppStore((state) => state.sessionUi);
  // Subscribed, not read through getState: turning context off in Settings
  // while this panel is open must disable the attachment immediately.
  const sendContextToAi = useAppStore((state) => state.sendContextToAi);
  const [sessionId, setSessionId] = useState<string | null>(activeSessionId);
  const chosenSession = sessionId ?? activeSessionId ?? sessions[0]?.id ?? null;

  const availability = useMemo(
    () => contextAvailability(chosenSession, sendContextToAi),
    [chosenSession, sendContextToAi],
  );
  // Driven by `sessions`, which is in tab order — iterating the sessionUi record
  // instead would list the picker in whatever order that object happens to hold.
  // The Map is what keeps the lookup off a variable bracket index, which reads
  // as an object-injection sink to static analysis.
  const sessionOptions = useMemo(() => {
    const ui = new Map(Object.entries(sessionUi));
    return sessions.map((session) => ({
      id: session.id,
      label: resolveSessionTitle(session, ui.get(session.id)),
    }));
  }, [sessions, sessionUi]);

  const storedBlocks = blocksOf(sessionUi, chosenSession);
  const blocks = useMemo(
    () => (chosenSession && attach ? collectSessionBlocks(chosenSession) : []),
    [chosenSession, attach, storedBlocks],
  );

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const included = blocks.filter((block) => !excluded.has(block.id));

  // `null` until the operator types. After that the text is verbatim and NOTHING
  // regenerates it implicitly — not a checkbox, not the session picker.
  //
  // This is the one rule that makes hand-redaction trustworthy. Rebuilding the
  // payload when a box is ticked would reintroduce a secret the operator had
  // already deleted, silently, at the moment they were still editing. Going back
  // to the generated text is possible but has to be asked for.
  const [edited, setEdited] = useState<string | null>(null);
  const payload = edited ?? renderContext(included);

  useEffect(() => {
    if (!busy) {
      setElapsedSeconds(0);
      return;
    }
    const started = Date.now();
    const update = () => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1_000));
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [busy]);

  // Closing the parent wizard must not leave an invisible generation consuming
  // the model and later creating a draft the operator explicitly abandoned.
  useEffect(
    () => () => {
      const id = activeRequestRef.current;
      if (id) void aiCancel(id).catch(() => undefined);
    },
    [],
  );

  const reset = () => {
    setRequirements("");
    setAttach(false);
    setEdited(null);
    setExcluded(new Set());
    setError(null);
  };

  const generate = async () => {
    const id = `runbook-gen-${Date.now()}-${requestCounter++}`;
    activeRequestRef.current = id;
    cancelledRequestRef.current = null;
    setBusy(true);
    setStopping(false);
    setError(null);
    try {
      const context = attach && availability.available && payload.trim() ? payload : null;
      const document = await runbooksAiGenerate(id, requirements, context);
      if (cancelledRequestRef.current === id) return;
      const draft = await runbooksDraftCreate(document);
      await onGenerated(draft);
      setOpen(false);
      reset();
    } catch (reason) {
      if (cancelledRequestRef.current !== id) setError(String(reason));
    } finally {
      if (activeRequestRef.current === id) {
        activeRequestRef.current = null;
        cancelledRequestRef.current = null;
        setBusy(false);
        setStopping(false);
      }
    }
  };

  const cancel = () => {
    const id = activeRequestRef.current;
    if (!id || stopping) return;
    cancelledRequestRef.current = id;
    setStopping(true);
    setError(null);
    void aiCancel(id).catch((reason) => {
      if (activeRequestRef.current !== id) return;
      cancelledRequestRef.current = null;
      setStopping(false);
      setError(`Could not stop generation: ${String(reason)}`);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          setOpen(true);
        }}
        className="mb-4 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-subtle px-3 py-3 text-[11px] text-text-secondary hover:border-accent/50 hover:text-accent disabled:opacity-50"
      >
        <Sparkles size={12} /> Generate with AI
      </button>
    );
  }

  return (
    <section className="mb-4 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] text-text-primary">
          <Sparkles size={12} className="text-accent" /> Generate with AI
        </h3>
        <button
          type="button"
          onClick={() => {
            if (busy) {
              cancel();
              return;
            }
            setOpen(false);
            reset();
          }}
          className="text-[9px] text-text-muted hover:text-text-primary"
        >
          Cancel
        </button>
      </div>

      <label className={labelClass}>
        What should this runbook do?
        <textarea
          className={`${fieldClass} min-h-20`}
          autoFocus
          placeholder="Install and configure nginx the way I just did, and check it on other machines."
          value={requirements}
          onChange={(event) => {
            setRequirements(event.target.value);
          }}
        />
      </label>

      <label className="mt-3 flex items-center gap-1.5 text-[10px] text-text-secondary">
        <input
          type="checkbox"
          checked={attach}
          disabled={!availability.available}
          onChange={(event) => {
            setAttach(event.target.checked);
          }}
        />
        Use a terminal session as context
      </label>
      {!availability.available && (
        <p className="mt-1 text-[9px] text-warning">{availability.reason}</p>
      )}

      {attach && availability.available && (
        <div className="mt-2 space-y-2">
          <label className={labelClass}>
            Session
            <select
              className={fieldClass}
              value={chosenSession ?? ""}
              onChange={(event) => {
                setSessionId(event.target.value);
                setExcluded(new Set());
              }}
            >
              {sessionOptions.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          {blocks.length === 0 ? (
            <p className="rounded border border-dashed border-border-subtle p-3 text-center text-[9px] text-text-muted">
              No finished commands in this tab yet.
            </p>
          ) : (
            <div className="max-h-40 overflow-auto rounded border border-border-subtle bg-bg-card p-2">
              {blocks.map((block) => (
                <BlockRow
                  key={block.id}
                  block={block}
                  checked={!excluded.has(block.id)}
                  onToggle={(on) => {
                    setExcluded((previous) => {
                      const next = new Set(previous);
                      if (on) next.delete(block.id);
                      else next.add(block.id);
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          )}

          <label className={labelClass}>
            Exactly this text is sent to the model — edit it to remove anything private
            <textarea
              className={`${fieldClass} min-h-32 font-mono`}
              value={payload}
              onChange={(event) => {
                setEdited(event.target.value);
              }}
            />
          </label>
          {edited !== null && (
            // Says out loud what the checkboxes no longer do. Without this the
            // selection above looks live while the payload has stopped tracking
            // it, and the operator cannot tell which one is being sent.
            <p className="flex items-center justify-between gap-2 text-[9px] text-text-muted">
              <span>Edited by hand. The selection above no longer changes this text.</span>
              <button
                type="button"
                onClick={() => {
                  setEdited(null);
                }}
                className="shrink-0 text-accent hover:underline"
              >
                Discard edits
              </button>
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-[9px] text-error">{error}</p>}

      {busy && (
        <p role="status" aria-live="polite" className="mt-2 text-[9px] text-text-muted">
          {stopping
            ? "Stopping generation…"
            : elapsedSeconds < 10
              ? "Drafting the runbook, then checking it before opening Review…"
              : `Still working (${formatElapsed(elapsedSeconds)}). Complex runbooks can take a few minutes.`}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {busy && (
          <button type="button" disabled={stopping} onClick={cancel} className={secondaryButton}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        <button
          type="button"
          disabled={busy || !requirements.trim()}
          onClick={() => void generate()}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[10px] text-white disabled:opacity-50"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          {busy ? "Generating…" : "Generate draft"}
        </button>
      </div>
      <p className="mt-2 text-[8px] text-text-muted">
        You review and edit the result before anything is saved, and every command is approved
        again when the runbook runs.
      </p>
    </section>
  );
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function BlockRow({
  block,
  checked,
  onToggle,
}: {
  block: RunbookContextBlock;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const lines = block.output ? block.output.split("\n").length : 0;
  return (
    <label className="flex items-start gap-1.5 py-0.5 text-[9px]">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(event) => {
          onToggle(event.target.checked);
        }}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-text-secondary" title={block.command}>
        $ {block.command}
      </span>
      <span className="shrink-0 text-text-muted">
        {block.outputUnavailable
          ? "output gone"
          : `${lines} line${lines === 1 ? "" : "s"}`}
        {block.exitCode !== null && block.exitCode !== 0 && (
          <span className="ml-1 text-error">exit {block.exitCode}</span>
        )}
      </span>
    </label>
  );
}
