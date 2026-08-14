import { FileText, History, Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useRunbooks } from "../../hooks/useRunbooks";
import { isTerminalRunState } from "../../lib/runbooks";
import { relativeTime } from "../../lib/relativeTime";
import { useRunbookStore } from "../../stores/runbookStore";
import { RunbookReportViewer } from "./RunbookReportViewer";
import {
  formatRunbookDuration,
  humanizeRunbookState,
  runStateTone,
  secondaryButton,
} from "./runbookUi";

export function RunbookHistory() {
  const history = useRunbookStore((state) => state.history);
  const sources = useRunbookStore((state) => state.sources);
  const selectedRunId = useRunbookStore((state) => state.selectedHistoryRunId);
  const report = useRunbookStore((state) => state.report);
  const loadingHistory = useRunbookStore((state) => state.loadingHistory);
  const loadingReport = useRunbookStore((state) => state.loadingReport);
  const busyAction = useRunbookStore((state) => state.busyAction);
  const setView = useRunbookStore((state) => state.setView);
  const { loadHistory, loadReport, openHistoryRun, selectSource, deleteRun } = useRunbooks();
  const [confirmDeleteRunId, setConfirmDeleteRunId] = useState<string | null>(null);

  useEffect(() => {
    setConfirmDeleteRunId(null);
  }, [selectedRunId]);

  const selected = history.find((entry) => entry.run_id === selectedRunId) ?? null;

  const rerun = async () => {
    if (!selected) return;
    const source = selected.source_id
      ? sources.find((item) => item.source_id === selected.source_id)
      : undefined;
    if (!source || source.state !== "valid") return;
    await selectSource(source.source_id);
    setView("library");
  };

  const requestDelete = async () => {
    if (!selected || !isTerminalRunState(selected.state)) return;
    if (confirmDeleteRunId !== selected.run_id) {
      setConfirmDeleteRunId(selected.run_id);
      return;
    }
    setConfirmDeleteRunId(null);
    await deleteRun(selected.run_id);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col border-e border-border-subtle bg-bg-primary">
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            <History size={11} /> Runs
          </span>
          <button
            onClick={() => void loadHistory()}
            disabled={loadingHistory}
            title="Refresh history"
            aria-label="Refresh history"
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40"
          >
            <RefreshCw size={11} className={loadingHistory ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loadingHistory && history.length === 0 && (
            <p className="flex items-center justify-center gap-1.5 px-2 py-5 text-[11px] text-text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </p>
          )}
          {!loadingHistory && history.length === 0 && (
            <div className="space-y-1 px-3 py-5 text-center">
              <p className="text-[11px] text-text-secondary">No run history</p>
              <p className="text-[10px] leading-relaxed text-text-muted">
                Completed runs retain reports; interrupted and active runs reopen in the live recovery view.
              </p>
            </div>
          )}
          {history.map((entry) => {
            const active = entry.run_id === selectedRunId;
            const when = entry.finished_at ?? entry.started_at;
            return (
              <button
                key={entry.run_id}
                onClick={() => void openHistoryRun(entry.run_id)}
                className={`w-full px-3 py-2 text-start transition-colors ${active ? "bg-bg-hover" : "hover:bg-bg-card"}`}
              >
                <span className={`block truncate text-[11px] ${active ? "text-text-primary" : "text-text-secondary"}`}>
                  {entry.definition_title}
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2 text-[9px]">
                  <span className={runStateTone(entry.state).split(" ").filter((part) => part.startsWith("text-")).join(" ")}>
                    {humanizeRunbookState(entry.state)}
                  </span>
                  <span className="shrink-0 text-text-muted">{when ? relativeTime(when) : "earlier"}</span>
                </span>
                <span className="mt-0.5 block font-mono text-[9px] text-text-muted">
                  {entry.checked_steps}/{entry.total_steps} checked · {formatRunbookDuration(entry.duration_ms)}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        {selected && isTerminalRunState(selected.state) && (
          <div className="mb-3 flex justify-end border-b border-border-subtle pb-3">
            <button
              onClick={() => void requestDelete()}
              disabled={busyAction === `delete-run:${selected.run_id}`}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] disabled:opacity-40 ${
                confirmDeleteRunId === selected.run_id
                  ? "border-error/40 bg-error/10 text-error"
                  : "border-border-subtle text-text-muted hover:border-error/30 hover:text-error"
              }`}
              aria-label={confirmDeleteRunId === selected.run_id ? "Confirm delete run" : "Delete run"}
              title="Delete this run, its report, and captured evidence"
            >
              {busyAction === `delete-run:${selected.run_id}` ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Trash2 size={10} />
              )}
              {confirmDeleteRunId === selected.run_id ? "Confirm delete" : "Delete run"}
            </button>
          </div>
        )}
        {!selectedRunId && (
          <div className="flex h-full min-h-52 items-center justify-center text-center">
            <div className="max-w-64 space-y-2">
              <FileText size={23} className="mx-auto text-text-muted" />
              <p className="text-[12px] text-text-secondary">Select a run report</p>
              <p className="text-[10px] leading-relaxed text-text-muted">
                Reports are generated from canonical JSON and retain approvals, evidence metadata, deviations and operator comments.
              </p>
            </div>
          </div>
        )}
        {selectedRunId && loadingReport && report?.run_id !== selectedRunId && (
          <p className="flex items-center justify-center gap-1.5 py-8 text-[11px] text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading report…
          </p>
        )}
        {selectedRunId && report?.run_id === selectedRunId && (
          <RunbookReportViewer
            report={report}
            onRerun={
              selected && sources.some((source) => source.source_id === selected.source_id && source.state === "valid")
                ? () => void rerun()
                : undefined
            }
          />
        )}
        {selected && !sources.some((source) => source.source_id === selected.source_id) && report?.run_id === selectedRunId && (
          <p className="mt-3 flex items-center gap-1.5 text-[10px] text-text-muted">
            <RotateCcw size={10} /> Re-run is unavailable because the package registration was removed or hidden. The historical report is retained.
          </p>
        )}
        {selectedRunId && !loadingReport && !report && (
          <button onClick={() => void loadReport(selectedRunId)} className={secondaryButton}>
            Retry loading report
          </button>
        )}
      </div>
    </div>
  );
}
