import { useCallback, useEffect, useMemo, useState } from "react";

import { S } from "../../lib/strings";
import * as tauri from "../../lib/tauri";
import { ownRecordValue } from "../../lib/records";
import { buildSshCommand } from "../../lib/ssh";
import { useSchedules } from "../../hooks/useSchedules";
import { blockingIssues, useScheduleStore } from "../../stores/scheduleStore";
import { useAppStore } from "../../stores/appStore";
import {
  SCHEDULE_PERMISSION_MODES,
  type ScheduleExecutionMode,
  type ScheduleMissedPolicy,
  type SchedulePermissionMode,
  type ScheduleRecurrence,
} from "../../lib/schedules";
import type { SshHost } from "../../lib/types";
import { Dropdown } from "../ui/Dropdown";
import { Field } from "../ui/Row";
import { Segmented } from "../ui/Segmented";
import { McpPicker } from "../ai/McpPicker";
import { BucketPicker } from "../ai/BucketPicker";
import { ScheduleRecurrenceEditor } from "./ScheduleRecurrenceEditor";
import { ScheduleStepList } from "./ScheduleStepList";
import { primaryButton, scheduleInputClass, secondaryButton } from "./scheduleUi";

export function ScheduleEditor() {
  const draft = useScheduleStore((s) => s.draft);
  const issues = useScheduleStore((s) => s.issues);
  const busy = useScheduleStore((s) => s.busyAction);
  const dirty = useScheduleStore((s) => s.draftDirty);
  const patchDraft = useScheduleStore((s) => s.patchDraft);
  const patchStep = useScheduleStore((s) => s.patchStep);
  const addStep = useScheduleStore((s) => s.addStep);
  const removeStep = useScheduleStore((s) => s.removeStep);
  const moveStep = useScheduleStore((s) => s.moveStep);
  const discardDraft = useScheduleStore((s) => s.discardDraft);
  const setView = useScheduleStore((s) => s.setView);
  const tabAllowed = useAppStore((s) => s.schedulesTabExecutionEnabled);
  const docsEnabled = useAppStore((s) => s.docsEnabled);
  const { validateDraft, saveDraft, preview } = useSchedules();
  const [hosts, setHosts] = useState<SshHost[]>([]);

  useEffect(() => {
    void tauri
      .sshHostsList()
      .then(setHosts)
      .catch(() => {
        setHosts([]);
      });
  }, []);

  // Debounced so every keystroke does not become an IPC round trip, but still
  // live: the classification advisories are most useful while typing.
  useEffect(() => {
    if (!draft) return;
    const handle = setTimeout(() => void validateDraft(draft.input), 250);
    return () => {
      clearTimeout(handle);
    };
  }, [draft, validateDraft]);

  const previewFor = useCallback(
    (recurrence: ScheduleRecurrence) => preview(recurrence),
    [preview],
  );

  const issueFor = useMemo(
    () => (field: string) => issues.find((i) => i.field === field)?.message,
    [issues],
  );

  if (!draft) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <p className="text-[11px] text-text-muted">{S.schedules.emptyHint}</p>
      </div>
    );
  }

  const input = draft.input;
  const blocking = blockingIssues(issues);
  const advisories = issues.filter((i) => !i.blocking && !i.field.startsWith("steps."));
  const target = input.target;
  const selectedHost =
    target.kind === "ssh_host" ? hosts.find((h) => h.id === target.host_id) : undefined;
  // Saying so BEFORE the click, rather than letting the arming timestamp move
  // silently. Deliberately approximate on the safe side: Rust decides for real,
  // by comparing a fingerprint over the target, the steps and the attachments,
  // and any edit at all is enough for this warning to be worth showing.
  const willReArm =
    input.permission_mode !== "ask" &&
    (draft.storedPermissionMode === null ||
      draft.storedPermissionMode !== input.permission_mode ||
      dirty);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <Field label="Name" error={issueFor("name")}>
        <input
          value={input.name}
          onChange={(e) => patchDraft({ name: e.target.value })}
          placeholder="Nightly checks"
          className={scheduleInputClass}
          aria-label="Action name"
        />
      </Field>

      <Field label={S.schedules.target} error={issueFor("target")}>
        <div className="space-y-2">
          <Segmented
            value={input.target.kind}
            options={[
              { value: "local_shell", label: S.schedules.targetLocal },
              { value: "ssh_host", label: S.schedules.targetHost },
            ]}
            onChange={(kind) =>
              patchDraft({
                target:
                  kind === "local_shell"
                    ? { kind: "local_shell", cwd: null }
                    : { kind: "ssh_host", host_id: hosts[0]?.id ?? "" },
              })
            }
            ariaLabel={S.schedules.target}
            size="sm"
          />
          {input.target.kind === "local_shell" ? (
            <div className="space-y-1">
              <input
                value={input.target.cwd ?? ""}
                onChange={(e) =>
                  patchDraft({
                    // Empty string is the clear sentinel over IPC everywhere in
                    // this app; null here means "not provided".
                    target: { kind: "local_shell", cwd: e.target.value || null },
                  })
                }
                placeholder="/Users/you/work/api"
                className={`${scheduleInputClass} font-mono text-[11px]`}
                aria-label={S.schedules.targetCwd}
              />
              <p className="text-[10px] text-text-muted">{S.schedules.targetCwdHint}</p>
            </div>
          ) : (
            <div className="space-y-1">
              <Dropdown
                value={input.target.host_id}
                options={hosts.map((host) => ({ value: host.id, label: host.label }))}
                onChange={(host_id) => patchDraft({ target: { kind: "ssh_host", host_id } })}
                ariaLabel={S.schedules.targetHost}
                size="sm"
                align="left"
              />
              {selectedHost && (
                <div className="space-y-0.5">
                  {/* The honesty requirement: the user is pre-authorizing a
                      connect they will not witness, so show the exact line. */}
                  <p className="text-[10px] text-text-muted">
                    {S.schedules.targetCommandPreview}
                  </p>
                  <p className="break-all rounded border border-border-subtle bg-bg-primary px-1.5 py-1 font-mono text-[10px] text-text-secondary">
                    {buildSshCommand(selectedHost)}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </Field>

      <Field
        label={S.schedules.executionMode}
        hint={S.schedules.executionHint}
        error={issueFor("execution_mode")}
      >
        <div className="space-y-1">
          <Segmented
            value={input.execution_mode}
            options={[
              { value: "headless", label: S.schedules.executionHeadless },
              {
                value: "tab",
                label: S.schedules.executionTab,
                tone: "warning",
                title: tabAllowed ? undefined : S.schedules.tabExecutionOff,
              },
            ]}
            onChange={(mode: ScheduleExecutionMode) => patchDraft({ execution_mode: mode })}
            ariaLabel={S.schedules.executionMode}
            size="sm"
          />
          {input.execution_mode === "tab" && !tabAllowed && (
            <p className="text-[10px] text-warning">{S.schedules.tabExecutionOff}</p>
          )}
        </div>
      </Field>

      <ScheduleRecurrenceEditor
        value={input.recurrence}
        onChange={(recurrence) => patchDraft({ recurrence })}
        previewFor={previewFor}
      />

      <Field label={S.schedules.missedRuns} hint={S.schedules.missedHint}>
        <Segmented
          value={input.missed_run_policy}
          options={[
            { value: "skip", label: S.schedules.missedSkip },
            { value: "catch_up_once", label: S.schedules.missedCatchUp },
          ]}
          onChange={(policy: ScheduleMissedPolicy) =>
            patchDraft({ missed_run_policy: policy })
          }
          ariaLabel={S.schedules.missedRuns}
          size="sm"
        />
      </Field>

      <ScheduleStepList
        steps={input.steps}
        onPatch={patchStep}
        onAdd={addStep}
        onRemove={removeStep}
        onMove={moveStep}
        issueFor={(index) => issueFor(`steps.${index}`)}
      />

      <Field
        label={S.schedules.permission}
        hint={S.schedules.permissionDescriptions[input.permission_mode]}
        error={issueFor("permission_mode")}
      >
        <div className="space-y-1">
          {/* The trigger always renders the current value with its tone, which is
              why a safety control can live in a Dropdown at all: hiding the
              options is fine, hiding the state is not. */}
          <Dropdown
            value={input.permission_mode}
            options={SCHEDULE_PERMISSION_MODES.map((mode) => ({
              value: mode,
              label: ownRecordValue(S.schedules.permissionOptions, mode) ?? mode,
              tone: mode === "auto_all" ? ("warning" as const) : ("accent" as const),
            }))}
            onChange={(mode: SchedulePermissionMode) => patchDraft({ permission_mode: mode })}
            ariaLabel={S.schedules.permission}
            size="sm"
            align="left"
          />
          <p className="text-[10px] text-text-muted">{S.schedules.permissionHint}</p>
          {willReArm && (
            <p className="text-[10px] text-warning">{S.schedules.permissionReArm}</p>
          )}
        </div>
      </Field>

      <Field label={S.schedules.context}>
        <div className="flex flex-wrap items-center gap-1.5">
          <McpPicker
            conversationId={`schedule:${draft.actionId ?? "new"}`}
            selection={input.mcp_selection}
            onSelectionChange={(mcp_selection) => patchDraft({ mcp_selection })}
            disabled={false}
          />
          {docsEnabled && (
            <BucketPicker
              attached={input.doc_buckets as never}
              onAttach={(ref) =>
                patchDraft({
                  doc_buckets: [...input.doc_buckets, ref as never],
                })
              }
              onDetach={(ref) =>
                patchDraft({
                  doc_buckets: input.doc_buckets.filter(
                    (b) => JSON.stringify(b) !== JSON.stringify(ref),
                  ),
                })
              }
            />
          )}
        </div>
      </Field>

      <details className="rounded-md border border-border-subtle bg-bg-card p-2">
        <summary className="cursor-pointer text-[11px] text-text-secondary">
          {S.schedules.advanced}
        </summary>
        <div className="mt-2 space-y-2">
          <NumberField
            label={S.schedules.maxIterations}
            value={input.max_iterations}
            min={1}
            max={100}
            error={issueFor("max_iterations")}
            onChange={(max_iterations) => patchDraft({ max_iterations })}
          />
          <NumberField
            label={S.schedules.commandTimeout}
            value={input.command_timeout_secs}
            min={1}
            max={86400}
            onChange={(command_timeout_secs) => patchDraft({ command_timeout_secs })}
          />
          <NumberField
            label={S.schedules.maxRunSecs}
            value={input.max_run_secs}
            min={30}
            max={86400}
            onChange={(max_run_secs) => patchDraft({ max_run_secs })}
          />
          <label className="flex items-start gap-1.5 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={input.web_access}
              onChange={(e) => patchDraft({ web_access: e.target.checked })}
              className="mt-0.5 accent-accent"
            />
            <span>
              {S.schedules.webAccess}
              <span className="block text-[10px] text-text-muted">
                {S.schedules.webAccessHint}
              </span>
            </span>
          </label>
          {input.recurrence.kind === "once" && input.execution_mode === "tab" && (
            <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={input.close_tab_when_done}
                onChange={(e) => patchDraft({ close_tab_when_done: e.target.checked })}
                className="accent-accent"
              />
              {S.schedules.closeTabWhenDone}
            </label>
          )}
        </div>
      </details>

      {advisories.length > 0 && (
        <ul className="space-y-1 rounded-md border border-warning/25 bg-warning/5 p-2">
          {advisories.map((issue) => (
            <li key={`${issue.field}:${issue.message}`} className="text-[10px] text-warning">
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {blocking.length > 0 && (
        <ul className="space-y-1 rounded-md border border-error/25 bg-error/5 p-2">
          {blocking.map((issue) => (
            <li key={`${issue.field}:${issue.message}`} className="text-[10px] text-error">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-1.5 pb-2">
        <button
          type="button"
          className={primaryButton}
          disabled={busy === "save" || blocking.length > 0}
          onClick={() => void saveDraft()}
        >
          {S.schedules.save}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            discardDraft();
            setView("list");
          }}
        >
          {S.schedules.discard}
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  error,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  error?: string;
  onChange: (next: number) => void;
}) {
  return (
    <Field label={label} error={error}>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
        className={`${scheduleInputClass} w-24`}
        aria-label={label}
      />
    </Field>
  );
}
