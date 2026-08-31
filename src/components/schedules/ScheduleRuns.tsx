import { Ban, ExternalLink, Trash2 } from "lucide-react";
import { useEffect } from "react";

import { ownRecordValue } from "../../lib/records";
import { S } from "../../lib/strings";
import { useSchedules } from "../../hooks/useSchedules";
import { isTerminalScheduleRunStatus, type ScheduleRun } from "../../lib/schedules";
import { useScheduleStore } from "../../stores/scheduleStore";
import { useAppStore } from "../../stores/appStore";
import {
  dangerButton,
  formatDuration,
  formatFireTime,
  humanizeScheduleState,
  scheduleRunTone,
  scheduleStepTone,
  secondaryButton,
} from "./scheduleUi";

export function ScheduleRuns() {
  const history = useScheduleStore((s) => s.history);
  const runsById = useScheduleStore((s) => s.runsById);
  const activeRunId = useScheduleStore((s) => s.activeRunId);
  const selectRun = useScheduleStore((s) => s.selectRun);
  const loading = useScheduleStore((s) => s.loadingHistory);
  const { refreshHistory, refreshRun, cancelRun, deleteRun } = useSchedules();
  // Prefer the durable registry over the history snapshot: a live run's status
  // arrives by notice, and the history list is only re-read on demand.
  const selected = activeRunId ? (ownRecordValue(runsById, activeRunId) ?? null) : null;

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (activeRunId) void refreshRun(activeRunId);
  }, [activeRunId, refreshRun]);

  const rows = history.map((run) => runsById[run.id] ?? run);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-48 shrink-0 flex-col border-e border-border-subtle">
        <div className="shrink-0 border-b border-border-subtle px-2 py-1.5 text-[9px] uppercase tracking-wide text-text-muted">
          {S.schedules.runsTitle}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loading && rows.length === 0 && (
            <p className="px-2 py-3 text-[10px] text-text-muted">{S.schedules.runsEmpty}</p>
          )}
          {rows.map((run) => (
            <button
              key={run.id}
              onClick={() => selectRun(run.id)}
              className={`flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-2 py-1.5 text-start transition-colors ${
                activeRunId === run.id ? "bg-bg-hover" : "hover:bg-bg-hover/50"
              }`}
            >
              <span className="w-full truncate text-[11px] text-text-primary">
                {run.action_name}
              </span>
              <span className="text-[9px] text-text-muted">
                {humanizeScheduleState(run.status)} · {formatFireTime(run.scheduled_for)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selected ? (
          <RunDetail
            run={selected}
            onCancel={() => void cancelRun(selected.id)}
            onDelete={() => void deleteRun(selected.id)}
          />
        ) : (
          <p className="text-[11px] text-text-muted">{S.schedules.runsEmpty}</p>
        )}
      </div>
    </div>
  );
}

function RunDetail({
  run,
  onCancel,
  onDelete,
}: {
  run: ScheduleRun;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const sessions = useAppStore((s) => s.sessions);
  const revealable =
    run.session_id && sessions.some((session) => session.id === run.session_id);
  const live = !isTerminalScheduleRunStatus(run.status);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-[13px] font-medium text-text-primary">{run.action_name}</h2>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className={`rounded border px-1.5 py-0.5 ${scheduleRunTone(run.status)}`}>
            {humanizeScheduleState(run.status)}
          </span>
          <span className="text-text-muted">{S.schedules.runTrigger[run.trigger]}</span>
          <span className="text-text-muted">· {run.target_label}</span>
          {run.model && <span className="text-text-muted">· {run.model}</span>}
        </div>
        <p className="text-[10px] text-text-muted">
          {formatFireTime(run.scheduled_for)}
          {run.finished_at && run.started_at
            ? ` · ${formatDuration(Date.parse(run.finished_at) - Date.parse(run.started_at))}`
            : ""}
          {run.cols && run.rows ? ` · ${run.cols}×${run.rows}` : ""}
        </p>
      </div>

      {run.skip_reason && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] text-warning">
          {S.schedules.skipped}: {run.skip_reason}
        </p>
      )}
      {run.error && (
        <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[10px] text-error">
          {run.error}
        </p>
      )}

      <ol className="space-y-1.5">
        {run.attempts.map((attempt) => (
          <li
            key={attempt.id}
            className="space-y-1 rounded-md border border-border-subtle bg-bg-card p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="text-[10px] text-text-muted">{attempt.sort_order + 1}.</span>
                <span className="truncate text-[11px] text-text-secondary">
                  {attempt.title}
                </span>
              </span>
              <span
                className={`shrink-0 text-[10px] ${scheduleStepTone(attempt.status)}`}
              >
                {humanizeScheduleState(attempt.status)}
              </span>
            </div>

            {attempt.executed_command && (
              <p className="break-all font-mono text-[10px] text-text-muted">
                {attempt.executed_command}
              </p>
            )}
            {attempt.summary && (
              <p className="whitespace-pre-wrap text-[11px] text-text-secondary">
                {attempt.summary}
              </p>
            )}
            {attempt.output_tail && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border-subtle bg-bg-primary p-1.5 font-mono text-[10px] text-text-muted">
                {attempt.output_tail}
              </pre>
            )}
            {attempt.output_truncated && (
              <p className="text-[9px] text-text-muted">{S.schedules.outputTruncated}</p>
            )}

            <div className="flex flex-wrap gap-2 text-[9px] text-text-muted">
              {attempt.exit_code !== null && attempt.exit_code !== undefined && (
                <span>exit {attempt.exit_code}</span>
              )}
              {attempt.duration_ms !== null && attempt.duration_ms !== undefined && (
                <span>{formatDuration(attempt.duration_ms)}</span>
              )}
              {attempt.commands_executed > 0 && <span>{attempt.commands_executed} ran</span>}
              {/* The interesting number under a schedule: everything the run
                  wanted to do and was not authorized to. */}
              {attempt.commands_skipped > 0 && (
                <span className="text-warning">
                  {S.schedules.commandsSkipped(attempt.commands_skipped)}
                </span>
              )}
              {attempt.commands_blocked > 0 && (
                <span className="text-error">
                  {S.schedules.commandsBlocked(attempt.commands_blocked)}
                </span>
              )}
            </div>

            {attempt.status === "unknown" && (
              <p className="text-[10px] text-warning">{S.schedules.unknownStep}</p>
            )}
            {attempt.termination === "step_limit" && (
              <p className="text-[10px] text-warning">{S.schedules.pausedStep}</p>
            )}
            {attempt.error && attempt.status !== "unknown" && (
              <p className="text-[10px] text-error">{attempt.error}</p>
            )}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-1.5 pb-2">
        {live && (
          <button onClick={onCancel} className={secondaryButton}>
            <Ban size={11} /> {S.schedules.cancel}
          </button>
        )}
        {revealable && (
          <button
            onClick={() => run.session_id && setActiveSession(run.session_id)}
            className={secondaryButton}
          >
            <ExternalLink size={11} /> {S.schedules.revealTab}
          </button>
        )}
        {!live && (
          <button onClick={onDelete} className={dangerButton}>
            <Trash2 size={11} /> {S.schedules.remove}
          </button>
        )}
      </div>
    </div>
  );
}
