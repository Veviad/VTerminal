import { CalendarClock, Play, Plus, SquareTerminal } from "lucide-react";
import { useMemo } from "react";

import { S } from "../../lib/strings";
import { useSchedules } from "../../hooks/useSchedules";
import { selectOverdueActions, useScheduleStore } from "../../stores/scheduleStore";
import type { ScheduleAction } from "../../lib/schedules";
import {
  dangerButton,
  describeRecurrence,
  formatFireTime,
  formatRelativeFire,
  humanizeScheduleState,
  primaryButton,
  scheduleRunTone,
  secondaryButton,
} from "./scheduleUi";

export function ScheduleList() {
  const actions = useScheduleStore((s) => s.actions);
  const selectedId = useScheduleStore((s) => s.selectedActionId);
  const selectAction = useScheduleStore((s) => s.selectAction);
  const beginDraft = useScheduleStore((s) => s.beginDraft);
  const busy = useScheduleStore((s) => s.busyAction);
  const { setEnabled, remove, duplicate, runNow } = useSchedules();
  const selected = actions.find((a) => a.id === selectedId) ?? null;
  // Derived, never stored: a stored "is overdue" is stale the second after it is
  // written, and this drives a banner that has to be true when it is read.
  const overdue = useMemo(() => selectOverdueActions(actions, Date.now()), [actions]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-48 shrink-0 flex-col border-e border-border-subtle">
        <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border-subtle px-2 py-1.5">
          <span className="text-[9px] uppercase tracking-wide text-text-muted">
            {S.schedules.views.list}
          </span>
          <button
            onClick={() => beginDraft(null)}
            className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            title={S.schedules.newAction}
            aria-label={S.schedules.newAction}
          >
            <Plus size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {actions.length === 0 && (
            <p className="px-2 py-3 text-[10px] text-text-muted">{S.schedules.empty}</p>
          )}
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={() => selectAction(action.id)}
              className={`flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-2 py-1.5 text-start transition-colors ${
                selectedId === action.id ? "bg-bg-hover" : "hover:bg-bg-hover/50"
              }`}
            >
              <span className="flex w-full items-center gap-1">
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    action.enabled ? "bg-accent" : "bg-text-muted/40"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-primary">
                  {action.name}
                </span>
              </span>
              <span className="ps-2.5 text-[9px] text-text-muted">
                {action.enabled
                  ? formatRelativeFire(action.next_fire_at)
                  : S.schedules.notScheduled}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {overdue.length > 0 && (
          <div className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[10px] text-warning">
            {S.schedules.overdue(overdue.length)}
          </div>
        )}
        {!selected ? (
          <div className="space-y-1">
            <p className="text-[12px] text-text-secondary">{S.schedules.empty}</p>
            <p className="text-[10px] text-text-muted">{S.schedules.emptyHint}</p>
            <button onClick={() => beginDraft(null)} className={`${primaryButton} mt-2`}>
              <Plus size={11} /> {S.schedules.newAction}
            </button>
          </div>
        ) : (
          <ActionDetail
            action={selected}
            busy={busy}
            onEdit={() => beginDraft(selected)}
            onToggle={(enabled) => void setEnabled(selected.id, enabled)}
            onDuplicate={() => void duplicate(selected.id)}
            onDelete={() => void remove(selected.id)}
            onRunNow={() => void runNow(selected.id)}
          />
        )}
      </div>
    </div>
  );
}

function ActionDetail({
  action,
  busy,
  onEdit,
  onToggle,
  onDuplicate,
  onDelete,
  onRunNow,
}: {
  action: ScheduleAction;
  busy: string | null;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRunNow: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-[13px] font-medium text-text-primary">{action.name}</h2>
        <p className="flex items-center gap-1.5 text-[10px] text-text-muted">
          {action.execution_mode === "tab" ? (
            <SquareTerminal size={10} />
          ) : (
            <CalendarClock size={10} />
          )}
          {action.execution_mode === "tab"
            ? S.schedules.executionTab
            : S.schedules.executionHeadless}
          {" · "}
          {action.target.kind === "ssh_host" ? S.schedules.targetHost : S.schedules.targetLocal}
        </p>
      </div>

      <dl className="space-y-1 text-[11px]">
        <Detail label={S.schedules.recurrence} value={describeRecurrence(action.recurrence)} />
        <Detail
          label={S.schedules.nextRun}
          value={
            action.enabled
              ? action.next_fire_at
                ? formatFireTime(action.next_fire_at)
                : S.schedules.neverRuns
              : S.schedules.notScheduled
          }
        />
        <Detail
          label={S.schedules.permission}
          value={S.schedules.permissionOptions[action.permission_mode]}
        />
        <Detail
          label={S.schedules.lastRun}
          value={
            action.last_status
              ? `${humanizeScheduleState(action.last_status)}${
                  action.last_fire_at ? ` · ${formatFireTime(action.last_fire_at)}` : ""
                }`
              : S.schedules.noRunsYet
          }
        />
      </dl>

      {action.last_error && (
        <p
          className={`rounded-md border px-2 py-1.5 text-[10px] ${scheduleRunTone(
            action.last_status ?? "failed",
          )}`}
        >
          {action.last_error}
        </p>
      )}

      <ol className="space-y-1">
        {action.steps.map((step, index) => (
          <li
            key={step.id}
            className="rounded-md border border-border-subtle bg-bg-card px-2 py-1.5"
          >
            <p className="flex items-center gap-1.5 text-[10px] text-text-muted">
              <span>{index + 1}.</span>
              <span className="uppercase tracking-wide">
                {step.kind === "command" ? S.schedules.stepCommand : S.schedules.stepPrompt}
              </span>
              {step.continue_on_failure && <span>· {S.schedules.stepContinue}</span>}
            </p>
            <p className="mt-0.5 break-words font-mono text-[11px] text-text-secondary">
              {step.text || "—"}
            </p>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={onRunNow}
          className={primaryButton}
          disabled={busy === `run:${action.id}`}
        >
          <Play size={11} /> {S.schedules.runNow}
        </button>
        <button onClick={onEdit} className={secondaryButton}>
          {S.schedules.edit}
        </button>
        <button
          onClick={() => {
            onToggle(!action.enabled);
          }}
          className={secondaryButton}
          disabled={busy === `enable:${action.id}`}
        >
          {action.enabled ? S.schedules.disable : S.schedules.enable}
        </button>
        <button onClick={onDuplicate} className={secondaryButton}>
          {S.schedules.duplicate}
        </button>
        <button
          onClick={onDelete}
          className={dangerButton}
          disabled={busy === `delete:${action.id}`}
        >
          {S.schedules.remove}
        </button>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 text-end text-text-secondary">{value}</dd>
    </div>
  );
}
