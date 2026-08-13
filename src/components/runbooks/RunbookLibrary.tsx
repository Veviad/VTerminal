import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useRunbooks } from "../../hooks/useRunbooks";
import { chooseRunbookPackage, type EvidenceMode } from "../../lib/runbooks";
import { useRunbookStore } from "../../stores/runbookStore";
import { RunbookDefinitionPreview } from "./RunbookDefinitionPreview";
import { RunbookPreflight } from "./RunbookPreflight";
import { secondaryButton } from "./runbookUi";

export function RunbookLibrary({ sessionId }: { sessionId: string | null }) {
  const sources = useRunbookStore((state) => state.sources);
  const selectedSourceId = useRunbookStore((state) => state.selectedSourceId);
  const definition = useRunbookStore((state) => state.definition);
  const loadingLibrary = useRunbookStore((state) => state.loadingLibrary);
  const loadingDefinition = useRunbookStore((state) => state.loadingDefinition);
  const busyAction = useRunbookStore((state) => state.busyAction);
  const {
    loadLibrary,
    importPackage,
    selectSource,
    refreshSource,
    removeSource,
    start,
  } = useRunbooks();
  const [screen, setScreen] = useState<"definition" | "preflight">("definition");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => setScreen("definition"), [selectedSourceId]);

  const selected = sources.find((source) => source.source_id === selectedSourceId) ?? null;

  const pickAndImport = async () => {
    const path = await chooseRunbookPackage();
    if (path) await importPackage(path);
  };

  const begin = async (
    inputs: Record<string, string | number | boolean>,
    evidence: EvidenceMode,
  ) => {
    if (!selected || !sessionId) return;
    await start(selected.source_id, sessionId, inputs, evidence);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-48 shrink-0 flex-col border-e border-border-subtle bg-bg-primary">
        <div className="flex items-center gap-1 border-b border-border-subtle p-2">
          <button onClick={() => void pickAndImport()} className={`${secondaryButton} min-w-0 flex-1`}>
            <FolderOpen size={12} /> Import
          </button>
          <button
            onClick={() => void loadLibrary()}
            disabled={loadingLibrary}
            title="Refresh library"
            aria-label="Refresh library"
            className="rounded-md border border-border-subtle p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40"
          >
            <RefreshCw size={12} className={loadingLibrary ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loadingLibrary && sources.length === 0 && (
            <p className="flex items-center justify-center gap-1.5 px-2 py-5 text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </p>
          )}
          {!loadingLibrary && sources.length === 0 && (
            <div className="space-y-1 px-3 py-5 text-center">
              <p className="text-[11px] text-text-secondary">No runbooks imported</p>
              <p className="text-[10px] leading-relaxed text-text-muted">
                Choose a folder containing one root runbook.vrun.yaml.
              </p>
            </div>
          )}
          {sources.map((source) => {
            const active = source.source_id === selectedSourceId;
            return (
              <button
                key={source.source_id}
                onClick={() => void selectSource(source.source_id)}
                className={`group flex w-full items-start gap-2 px-2.5 py-2 text-start transition-colors ${
                  active ? "bg-bg-hover" : "hover:bg-bg-card"
                }`}
              >
                {source.state === "valid" ? (
                  <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-error" />
                )}
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[11px] ${active ? "text-text-primary" : "text-text-secondary"}`}>
                    {source.title ?? source.definition_id ?? "Invalid package"}
                  </span>
                  <span className="block truncate font-mono text-[9px] text-text-muted">
                    {source.version ? `v${source.version}` : source.state}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        {!selected && !loadingLibrary && (
          <div className="flex h-full min-h-52 items-center justify-center text-center">
            <div className="max-w-64 space-y-2">
              <FolderOpen size={24} className="mx-auto text-text-muted" />
              <p className="text-[12px] text-text-secondary">Select or import a runbook</p>
              <p className="text-[10px] leading-relaxed text-text-muted">
                Definitions remain reusable. Every execution gets a separate immutable snapshot and checklist.
              </p>
            </div>
          </div>
        )}

        {selected && (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-card p-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-[9px] text-text-muted" title={selected.package_path}>
                  {selected.package_path}
                </p>
                {selected.digest_sha256 && (
                  <p className="truncate font-mono text-[9px] text-text-muted" title={selected.digest_sha256}>
                    sha256:{selected.digest_sha256}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  onClick={() => void refreshSource(selected.source_id)}
                  disabled={busyAction !== null}
                  title="Revalidate from disk"
                  className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40"
                >
                  <RefreshCw
                    size={12}
                    className={busyAction === `refresh:${selected.source_id}` ? "animate-spin" : ""}
                  />
                </button>
                <button
                  onClick={() => {
                    if (confirmRemove === selected.source_id) {
                      setConfirmRemove(null);
                      void removeSource(selected.source_id);
                    } else {
                      setConfirmRemove(selected.source_id);
                    }
                  }}
                  onBlur={() => setConfirmRemove(null)}
                  disabled={busyAction !== null}
                  title={confirmRemove === selected.source_id ? "Click again to remove" : "Remove registration"}
                  className={`rounded p-1.5 hover:bg-bg-hover disabled:opacity-40 ${
                    confirmRemove === selected.source_id ? "text-error" : "text-text-muted hover:text-error"
                  }`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {selected.state !== "valid" ? (
              <ValidationFailure sourceId={selected.source_id} />
            ) : loadingDefinition ? (
              <p className="flex items-center justify-center gap-1.5 py-8 text-[11px] text-text-muted">
                <Loader2 size={12} className="animate-spin" /> Loading definition…
              </p>
            ) : definition && screen === "preflight" ? (
              <RunbookPreflight
                definition={definition}
                sessionId={sessionId}
                busy={busyAction === "start"}
                onBack={() => setScreen("definition")}
                onStart={(inputs, evidence) => void begin(inputs, evidence)}
              />
            ) : definition ? (
              <RunbookDefinitionPreview
                definition={definition}
                startDisabled={!sessionId}
                onStart={() => setScreen("preflight")}
              />
            ) : (
              <p className="py-8 text-center text-[11px] text-text-muted">
                The validated definition could not be loaded.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ValidationFailure({ sourceId }: { sourceId: string }) {
  const source = useRunbookStore((state) =>
    state.sources.find((item) => item.source_id === sourceId),
  );
  if (!source) return null;
  return (
    <section className="space-y-2 rounded-md border border-error/30 bg-error/10 p-3">
      <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-error">
        <AlertTriangle size={12} /> Package validation failed
      </h3>
      {source.validation_issues.length === 0 ? (
        <p className="text-[10px] text-text-secondary">
          The package is missing or no longer readable. Refresh after restoring it.
        </p>
      ) : (
        <ul className="space-y-1 text-[10px] leading-relaxed text-text-secondary">
          {source.validation_issues.map((issue, index) => (
            <li key={`${issue.path ?? "root"}-${index}`}>
              {issue.path && <code className="me-1 text-error">{issue.path}</code>}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
