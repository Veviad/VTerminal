import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Frontend contract for the experimental Scheduled Actions subsystem.
 *
 * Deliberately outside `lib/tauri.ts`, following the same reasoning `lib/runbooks.ts`
 * gives for itself: a scheduled run is durable and outlives the component and
 * often the process, while `tauri.ts`'s wrappers serve state that belongs to a
 * mounted panel. Keeping the contracts apart is also what makes it structurally
 * impossible for an agent approval or a runbook gate to answer a scheduled run's
 * lease.
 *
 * The boundary rule: **this file owns `scheduled_*` commands and nothing else.**
 * `agentStart`, the `pty*` family, `sshHostsGet` / `sshHostsList` and
 * `saveSettings` are imported from `tauri.ts` and stay there. That is what keeps
 * this a second front door for one subsystem rather than a second IPC layer.
 */

// ---------- wire enums ----------
//
// Every literal below is pinned on the Rust side by
// `every_scheduled_enum_serializes_as_its_own_str`. `catch_up_once`,
// `awaiting_target` and `local_shell` are exactly the multi-word shapes that
// shipped as `open_ai` against a frontend expecting `openai`.

export type ScheduleExecutionMode = "tab" | "headless";
export type ScheduleMissedPolicy = "skip" | "catch_up_once";
export type ScheduleStepKind = "command" | "prompt";
export type ScheduleRunTrigger = "schedule" | "catch_up" | "manual";
export type ScheduleRecurrenceKind = "interval" | "daily" | "weekly" | "once";
export type ScheduleTargetKind = "local_shell" | "ssh_host";
export type ScheduleWeekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** ISO-8601 order, which is also the bit order Rust stores. Display order is a
 *  locale decision made in the editor; this is the storage order. */
export const SCHEDULE_WEEKDAYS: readonly ScheduleWeekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export type ScheduleRunStatus =
  | "pending"
  | "awaiting_target"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "interrupted";

export type ScheduleStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "unknown"
  | "cancelled";

/** Mirrors `agent::PermissionMode` minus `full`, which a schedule may not hold.
 *  Enforced in Rust and in the v20 CHECK constraint, not here. */
export type SchedulePermissionMode = "ask" | "auto_read" | "auto_smart" | "auto_all";

export const SCHEDULE_PERMISSION_MODES: readonly SchedulePermissionMode[] = [
  "ask",
  "auto_read",
  "auto_smart",
  "auto_all",
];

const TERMINAL_RUN_STATUSES: readonly ScheduleRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "interrupted",
];

export function isTerminalScheduleRunStatus(status: ScheduleRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

// ---------- wire shapes ----------

export type ScheduleTarget =
  | { kind: "local_shell"; cwd?: string | null }
  | { kind: "ssh_host"; host_id: string };

export interface ScheduleTimeOfDay {
  hour: number;
  minute: number;
}

export type ScheduleRecurrence =
  | { kind: "interval"; every_minutes: number }
  | { kind: "daily"; at: ScheduleTimeOfDay }
  | { kind: "weekly"; weekdays: ScheduleWeekday[]; at: ScheduleTimeOfDay }
  /** RFC3339 **with offset**. A recurring rule sends wall-clock fields and a
   *  zone instead — a precomputed UTC instant is how a 09:00 backup starts
   *  running at 08:00 in November. A one-off genuinely IS a single instant. */
  | { kind: "once"; at: string };

export interface ScheduleStep {
  id: string;
  sort_order: number;
  title: string;
  kind: ScheduleStepKind;
  /** The literal shell command, or the agent goal. `kind` decides. */
  text: string;
  continue_on_failure: boolean;
}

export interface ScheduleMcpSelection {
  server_ids: string[];
  disabled_tools: Record<string, string[]>;
}

export type ScheduleBucketRef =
  | { source: "local"; bucket_id: string }
  | { source: "qdrant"; connection_id: string; collection: string };

/** What the editor sends. Derived fields (`next_fire_at`, `armed_at`, the
 *  `last_*` projection) are the engine's to write and are never accepted here. */
export interface ScheduleActionInput {
  name: string;
  enabled: boolean;
  target: ScheduleTarget;
  steps: ScheduleStep[];
  execution_mode: ScheduleExecutionMode;
  permission_mode: SchedulePermissionMode;
  recurrence: ScheduleRecurrence;
  missed_run_policy: ScheduleMissedPolicy;
  /** IANA zone id from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timezone: string;
  mcp_selection: ScheduleMcpSelection;
  doc_buckets: ScheduleBucketRef[];
  web_access: boolean;
  max_iterations: number;
  command_timeout_secs: number;
  max_run_secs: number;
  close_tab_when_done: boolean;
}

/** Rust flattens `ScheduledActionInput` into the action, so the stored shape is
 *  the input plus the engine's own fields. */
export interface ScheduleAction extends ScheduleActionInput {
  id: string;
  armed_at?: string | null;
  steps_sha256: string;
  next_fire_at?: string | null;
  interval_anchor_at?: string | null;
  last_fire_at?: string | null;
  last_run_id?: string | null;
  last_status?: ScheduleRunStatus | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleStepAttempt {
  id: string;
  run_id: string;
  step_id: string;
  sort_order: number;
  kind: ScheduleStepKind;
  title: string;
  status: ScheduleStepStatus;
  executed_command?: string | null;
  exit_code?: number | null;
  output_tail?: string | null;
  output_redacted: boolean;
  output_truncated: boolean;
  termination?: string | null;
  summary?: string | null;
  commands_executed: number;
  /** Everything the run wanted to do and was not authorized to. Under a
   *  schedule this is the interesting number. */
  commands_skipped: number;
  commands_blocked: number;
  prompt_tokens: number;
  completion_tokens: number;
  error?: string | null;
  intent_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
}

export interface ScheduleRun {
  id: string;
  action_id?: string | null;
  /** Snapshotted at fire time, so history survives an edit or a delete. */
  action_name: string;
  plan_sha256: string;
  trigger: ScheduleRunTrigger;
  execution_mode: ScheduleExecutionMode;
  permission_mode: SchedulePermissionMode;
  target_kind: ScheduleTargetKind;
  target_label: string;
  target_host_id?: string | null;
  session_id?: string | null;
  status: ScheduleRunStatus;
  skip_reason?: string | null;
  error?: string | null;
  model?: string | null;
  web_access: boolean;
  app_version: string;
  cols?: number | null;
  rows?: number | null;
  scheduled_for: string;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  attempts: ScheduleStepAttempt[];
}

export interface ScheduleValidationIssue {
  field: string;
  message: string;
  /** Blocking issues refuse the save. The rest are surfaced and saved anyway —
   *  a command step is the user's own text, so classification flags, never
   *  filters. */
  blocking: boolean;
}

// ---------- app-level events ----------

/** A tab-mode run needs a terminal. Emitted globally rather than over a
 *  per-run Channel because the driver subscribes ONCE at app level: an action
 *  fires whether or not any panel is mounted. */
export interface ScheduleFireEvent {
  run_id: string;
  action_id: string;
  action_name: string;
  execution_mode: ScheduleExecutionMode;
  target_kind: ScheduleTargetKind;
  target_label: string;
  target_host_id: string | null;
  target_cwd: string | null;
}

export interface ScheduleRunNotice {
  run_id: string;
  action_id: string | null;
  status: ScheduleRunStatus;
}

const FIRE_EVENT = "scheduled://fire";
const RUN_EVENT = "scheduled://run";

export function onScheduleFire(
  handler: (event: ScheduleFireEvent) => void,
): Promise<UnlistenFn> {
  return listen<ScheduleFireEvent>(FIRE_EVENT, (e) => handler(e.payload));
}

export function onScheduleRunNotice(
  handler: (event: ScheduleRunNotice) => void,
): Promise<UnlistenFn> {
  return listen<ScheduleRunNotice>(RUN_EVENT, (e) => handler(e.payload));
}

// ---------- commands ----------
//
// Every command is `rename_all = "snake_case"` on the Rust side, so argument
// keys are snake_case here too. Tauri's default is camelCase, and getting this
// backwards is silent: the parameter simply arrives as its serde default.

export function schedulesList(): Promise<ScheduleAction[]> {
  return invoke<ScheduleAction[]>("scheduled_actions_list");
}

export function scheduleGet(id: string): Promise<ScheduleAction | null> {
  return invoke<ScheduleAction | null>("scheduled_action_get", { id });
}

export function scheduleValidate(
  input: ScheduleActionInput,
): Promise<ScheduleValidationIssue[]> {
  return invoke<ScheduleValidationIssue[]>("scheduled_action_validate", { input });
}

/** The next `count` fire times, computed by the SAME function the scheduler
 *  uses. Two implementations of "when does this fire" would drift, and the one
 *  the user reads has to be the one that acts. */
export function schedulePreview(
  recurrence: ScheduleRecurrence,
  count = 3,
): Promise<string[]> {
  return invoke<string[]>("scheduled_action_preview", {
    recurrence_rule: recurrence,
    count,
  });
}

export function scheduleCreate(input: ScheduleActionInput): Promise<ScheduleAction> {
  return invoke<ScheduleAction>("scheduled_action_create", { input });
}

export function scheduleUpdate(
  id: string,
  input: ScheduleActionInput,
): Promise<ScheduleAction> {
  return invoke<ScheduleAction>("scheduled_action_update", { id, input });
}

export function scheduleSetEnabled(
  id: string,
  enabled: boolean,
): Promise<ScheduleAction> {
  return invoke<ScheduleAction>("scheduled_action_set_enabled", { id, enabled });
}

export function scheduleDelete(id: string): Promise<void> {
  return invoke<void>("scheduled_action_delete", { id });
}

/** Fire now, on a human's gesture. Recorded with `trigger: "manual"`, because a
 *  run the user asked for at 15:04 is a different fact from one the clock did. */
export function scheduleRunNow(id: string): Promise<string> {
  return invoke<string>("scheduled_action_run_now", { id });
}

export function scheduleRunCancel(runId: string): Promise<void> {
  return invoke<void>("scheduled_run_cancel", { run_id: runId });
}

export function scheduleRunsList(
  actionId?: string | null,
  limit = 50,
): Promise<ScheduleRun[]> {
  return invoke<ScheduleRun[]>("scheduled_runs_list", {
    action_id: actionId ?? null,
    limit,
  });
}

export function scheduleRunGet(runId: string): Promise<ScheduleRun | null> {
  return invoke<ScheduleRun | null>("scheduled_run_get", { run_id: runId });
}

export function scheduleRunDelete(runId: string): Promise<void> {
  return invoke<void>("scheduled_run_delete", { run_id: runId });
}

export function scheduleRunsPrune(before: string): Promise<number> {
  return invoke<number>("scheduled_runs_prune", { before });
}

// ---------- tab-mode execution ----------
//
// A tab run is driven from here, and the backend still owns the record. The
// lease discipline mirrors `runbooksClaimTerminalDispatch`: `scheduleStepBegin`
// mints the attempt id and `scheduleStepFinish` refuses one it did not mint, so
// this webview can never submit a result for work it was not handed.

export function scheduleRunAttach(
  runId: string,
  sessionId: string,
  remoteHostId: string | null,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("scheduled_run_attach", {
    run_id: runId,
    session_id: sessionId,
    remote_host_id: remoteHostId,
    cols,
    rows,
  });
}

export function scheduleStepBegin(
  runId: string,
  stepId: string,
  sortOrder: number,
  kind: ScheduleStepKind,
  title: string,
): Promise<string> {
  return invoke<string>("scheduled_step_begin", {
    run_id: runId,
    step_id: stepId,
    sort_order: sortOrder,
    kind,
    title,
  });
}

export interface ScheduleStepResult {
  status: ScheduleStepStatus | string;
  executed_command?: string | null;
  exit_code?: number | null;
  output_tail?: string | null;
  output_truncated?: boolean;
  termination?: string | null;
  summary?: string | null;
  commands_executed?: number;
  commands_skipped?: number;
  commands_blocked?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  error?: string | null;
  duration_ms?: number | null;
}

export function scheduleStepFinish(
  runId: string,
  attemptId: string,
  result: ScheduleStepResult,
): Promise<void> {
  return invoke<void>("scheduled_step_finish", {
    run_id: runId,
    attempt_id: attemptId,
    result,
  });
}

export function scheduleRunFinish(
  runId: string,
  status: string,
  error: string | null,
): Promise<void> {
  return invoke<void>("scheduled_run_finish", { run_id: runId, status, error });
}

/** Polled before each dispatch: false once the run is cancelled, finished, or
 *  the feature has been switched off. */
export function scheduleRunIsActive(runId: string): Promise<boolean> {
  return invoke<boolean>("scheduled_run_is_active", { run_id: runId });
}

// ---------- helpers ----------

export function machineTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function newStepId(): string {
  return `step-${crypto.randomUUID()}`;
}

/** A blank action, for the editor's "new" path. `headless` is the default on
 *  purpose: tab mode depends on webview timers that are throttled while the
 *  window is backgrounded, which is precisely when a schedule fires. */
export function emptyScheduleInput(): ScheduleActionInput {
  return {
    name: "",
    enabled: true,
    target: { kind: "local_shell", cwd: null },
    steps: [
      {
        id: newStepId(),
        sort_order: 0,
        title: "Step 1",
        kind: "command",
        text: "",
        continue_on_failure: false,
      },
    ],
    execution_mode: "headless",
    // `ask` authorizes nothing, so a brand-new action is a dry report until the
    // user deliberately arms it. That is the whole point of the arming gesture.
    permission_mode: "ask",
    recurrence: { kind: "daily", at: { hour: 3, minute: 0 } },
    missed_run_policy: "skip",
    timezone: machineTimezone(),
    mcp_selection: { server_ids: [], disabled_tools: {} },
    doc_buckets: [],
    web_access: false,
    max_iterations: 10,
    command_timeout_secs: 120,
    max_run_secs: 3600,
    close_tab_when_done: false,
  };
}

/** Strip an action back to its input shape, so the editor never accidentally
 *  round-trips an engine-owned field back through create/update. */
export function toScheduleInput(action: ScheduleAction): ScheduleActionInput {
  return {
    name: action.name,
    enabled: action.enabled,
    target: action.target,
    steps: action.steps.map((step, index) => ({ ...step, sort_order: index })),
    execution_mode: action.execution_mode,
    permission_mode: action.permission_mode,
    recurrence: action.recurrence,
    missed_run_policy: action.missed_run_policy,
    timezone: action.timezone,
    mcp_selection: action.mcp_selection,
    doc_buckets: action.doc_buckets,
    web_access: action.web_access,
    max_iterations: action.max_iterations,
    command_timeout_secs: action.command_timeout_secs,
    max_run_secs: action.max_run_secs,
    close_tab_when_done: action.close_tab_when_done,
  };
}
