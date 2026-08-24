import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { prefixCommandEnvironment } from "./ptyExecShell";

/**
 * Frontend contract for the experimental Runbooks subsystem.
 *
 * Runbooks intentionally do not share the agent stream's event or approval
 * types. A run is durable and can outlive the component (or the process), while
 * an AI stream belongs to one mounted session panel. Keeping the contracts
 * separate makes it impossible for agent Full mode or a stale chat approval to
 * answer a runbook gate.
 */

export type RunbookSourceState = "valid" | "invalid" | "missing";
export type RunbookSourceKind = "user" | "builtin";
export type EvidenceMode = "none" | "tail" | "full";
/** Ordered least- to most-retaining; the preflight picker renders this order. */
export const EVIDENCE_MODES: readonly EvidenceMode[] = ["none", "tail", "full"];
/** Operator policy from Settings → Runbooks. Deliberately a different set of
 * spellings from `EvidenceMode`: `runbook` is not a capture mode and both
 * SQLite columns would reject it. */
export type EvidenceRecordingPolicy = "none" | "runbook" | "all";
export type OnFailure = "pause" | "stop" | "continue";
export type RunbookActionKind = "shell" | "agent" | "manual" | "ansible.playbook";
export type RunbookDraftPlatform = "macos13" | "linux" | "any";

export interface RunbookDraftInput {
  id: string;
  type: RunbookInputType;
  description: string;
  required: boolean;
  default: string | number | boolean | null;
  values: string[];
}

export type RunbookDraftCheck =
  | {
      kind: "shell";
      command: string;
      env: Record<string, string>;
      compliantExitCodes: number[];
      noncompliantExitCodes: number[];
    }
  | { kind: "manual"; instructions: string };

/** Remediation. Its exit codes mean "the work succeeded", not "compliant". */
export type RunbookDraftApply =
  | {
      kind: "shell";
      command: string;
      env: Record<string, string>;
      successExitCodes: number[];
    }
  | { kind: "manual"; instructions: string };

/** Proof the remediation worked. Required whenever `apply` is present. */
export type RunbookDraftVerify =
  | {
      kind: "shell";
      command: string;
      env: Record<string, string>;
      passExitCodes: number[];
    }
  | { kind: "manual"; instructions: string };

export interface RunbookDraftStep {
  id: string;
  title: string;
  required: boolean;
  onFailure: OnFailure | null;
  check: RunbookDraftCheck;
  /** Null for an assessment-only step. */
  apply: RunbookDraftApply | null;
  /** The backend REJECTS an apply without one, so the two move together. */
  verify: RunbookDraftVerify | null;
}

export interface RunbookDraftDocument {
  definitionId: string;
  version: string;
  title: string;
  description: string;
  tags: string[];
  platform: RunbookDraftPlatform;
  network: boolean;
  privilege: "none" | "root";
  defaultOnFailure: OnFailure;
  /** Absolute paths the runbook may write to, disclosed in preflight. */
  writes: string[];
  inputs: RunbookDraftInput[];
  steps: RunbookDraftStep[];
}

export interface RunbookDraft {
  id: string;
  revision: number;
  document: RunbookDraftDocument;
  publishedSourceId: string | null;
  lastPublishedVersion: string | null;
  dirty: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunbookDraftSummary {
  id: string;
  revision: number;
  title: string;
  definitionId: string;
  version: string;
  publishedSourceId: string | null;
  lastPublishedVersion: string | null;
  dirty: boolean;
  updatedAt: string;
}

export interface RunbookDraftPreview {
  definition: RunbookDefinition | null;
  sourceYaml: string | null;
  readme: string | null;
  issues: Array<{ path: string; message: string }>;
}

export interface RunbookValidationIssue {
  path: string | null;
  message: string;
}

export interface RunbookSource {
  source_id: string;
  source_kind: RunbookSourceKind;
  package_path: string;
  definition_id: string | null;
  version: string | null;
  title: string | null;
  digest_sha256: string | null;
  state: RunbookSourceState;
  validation_issues: RunbookValidationIssue[];
  imported_at: string;
  refreshed_at: string;
}

export interface RunbookSourceWire {
  id: string;
  source_kind: RunbookSourceKind;
  package_path: string;
  definition_id: string;
  definition_version: string;
  title: string;
  source_sha256: string;
  canonical_sha256: string;
  valid: boolean;
  validation_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunbookMetadata {
  id: string;
  version: string;
  title: string;
  description?: string | null;
  tags?: string[];
}

export type RunbookInputType = "string" | "path" | "integer" | "boolean" | "enum";

export interface RunbookInputDefinition {
  type: RunbookInputType;
  description?: string | null;
  required?: boolean;
  default?: string | number | boolean | null;
  values?: string[];
  env?: string | null;
}

export interface RunbookCapabilities {
  network?: boolean;
  privilege?: "none" | "user" | "root" | string;
  writes?: string[];
}

export interface ShellAction {
  uses: "shell";
  with: {
    command: string;
    env?: Record<string, string>;
  };
  outcomes?: {
    compliantExitCodes?: number[];
    noncompliantExitCodes?: number[];
    compliant_exit_codes?: number[];
    noncompliant_exit_codes?: number[];
  };
  passExitCodes?: number[];
  pass_exit_codes?: number[];
}

export interface AgentAction {
  uses: "agent";
  instructions: string;
}

export interface ManualAction {
  uses: "manual";
  instructions: string;
}

export interface AnsibleAction {
  uses: "ansible.playbook";
  with: {
    playbook: string;
    inventory?: string | null;
    limit?: string | null;
    inputVars?: Record<string, string>;
  };
}

export type RunbookAction = ShellAction | AgentAction | ManualAction | AnsibleAction;

/** What a step must achieve, and the conditions the ENGINE runs to decide it
 * did. A model's own summary is narration; these exit codes are the verdict. */
export interface RunbookGoal {
  intent: string;
  checks: { command: string; env?: Record<string, string>; expect: number[] }[];
}

/** Per-step bounds on an agent phase. Every field narrows; nothing here can
 * widen what the operator already allows. Best-effort in the same way the agent
 * panel's command checks are — not a sandbox. */
export interface RunbookConstraints {
  maxCommands?: number | null;
  maxSeconds?: number | null;
  maxRounds?: number | null;
  network?: boolean | null;
  privilege?: "none" | "root" | null;
}

/** What a step's agent phase is allowed to know. Nothing is implicit. */
export interface RunbookStepContext {
  inputs?: string[];
  priorSteps?: boolean;
}

export interface RunbookDiscoveryProbe {
  name: string;
  command: string;
  env?: Record<string, string>;
}

export interface RunbookStepDefinition {
  id: string;
  title: string;
  description?: string | null;
  required: boolean;
  /** Absent when `goal.checks` supplies the check phase instead. */
  check?: RunbookAction | null;
  apply?: RunbookAction | null;
  verify?: RunbookAction | null;
  goal?: RunbookGoal | null;
  constraints?: RunbookConstraints | null;
  context?: RunbookStepContext | null;
  onFailure?: OnFailure;
  on_failure?: OnFailure;
}

export interface RunbookDefinition {
  apiVersion?: string;
  api_version?: string;
  kind: "Runbook";
  metadata: RunbookMetadata;
  spec: {
    target: { kind: "active-terminal" | "ansible_inventory" };
    inputs?: Record<string, RunbookInputDefinition>;
    declaredCapabilities?: RunbookCapabilities;
    declared_capabilities?: RunbookCapabilities;
    defaults?: { onFailure?: OnFailure; on_failure?: OnFailure };
    /** What the package asks the operator to keep. A request, not a grant:
     * Settings → Runbooks supplies the floor and can only raise this. */
    audit?: { recordOutput?: EvidenceMode | null } | null;
    /** Target facts gathered once, before the first step, and shown to every
     * agent phase in the run. */
    context?: { discover?: RunbookDiscoveryProbe[] } | null;
    steps: RunbookStepDefinition[];
  };
  source_id?: string;
  source_digest_sha256?: string;
}

export type RunbookRunState =
  | "created"
  | "ready"
  | "running"
  | "waiting_approval"
  | "waiting_operator"
  | "paused"
  | "succeeded"
  | "completed_with_exceptions"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunbookStepState =
  | "pending"
  | "checking"
  | "already_compliant"
  | "needs_action"
  | "applying"
  | "verifying"
  | "remediated_verified"
  | "paused"
  | "failed"
  | "skipped"
  | "waived"
  | "blocked"
  | "unknown";

export type RunbookPhase = "check" | "apply" | "verify";
export type Assurance =
  | "deterministic_shell"
  | "shell_observed"
  | "agent_assisted"
  | "operator_attested"
  | "ansible_runner";

export interface RunbookAttempt {
  attempt_id: string;
  step_id: string;
  phase: RunbookPhase;
  executor: string;
  status:
    | "intent"
    | "waiting_approval"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "cancelled"
    | "declined";
  proposed_command?: string | null;
  executed_command?: string | null;
  exit_code?: number | null;
  output_tail?: string | null;
  output_observed_bytes?: number;
  output_captured_bytes?: number;
  output_truncated?: boolean;
  output_redacted?: boolean;
  duration_ms?: number | null;
  error?: string | null;
  structured_outcomes?: unknown | null;
  started_at: string;
  finished_at?: string | null;
}

export interface RunbookStepRun {
  id: string;
  status: RunbookStepState;
  title?: string;
  required?: boolean;
  index?: number;
  phase?: RunbookPhase | null;
  assurance?: Assurance | null;
  summary?: string | null;
  operator_comment?: string | null;
  exception?: string | null;
  attempts?: RunbookAttempt[];
}

export interface RunbookCommandClassification {
  read_only: boolean;
  network: boolean;
  privileged: boolean;
  opaque: boolean;
}

export interface RunbookApprovalRequest {
  approval_id: string;
  run_id: string;
  step_id: string;
  phase: RunbookPhase;
  command: string;
  explanation: string;
  classification: RunbookCommandClassification;
  requested_at?: string;
  project_digest?: string | null;
  inventory_digest?: string | null;
}

export type RunbookDecisionKind = "retry" | "skip" | "waive" | "stop";

export interface RunbookOperatorRequest {
  run_id: string;
  step_id: string | null;
  reason: string;
  choices: RunbookDecisionKind[];
  message?: string;
  requested_at?: string;
}

export interface RunbookManualRequest {
  request_id?: string;
  run_id: string;
  step_id: string;
  title: string;
  instructions: string;
  phase: RunbookPhase;
}

export interface RunbookTargetContext {
  kind: "active-terminal";
  session_id: string;
  shell?: string | null;
  cwd?: string | null;
  remote_kind?: string | null;
  remote_target?: string | null;
  context_marker?: string | null;
  observed_at: string;
}

export interface RunbookRun {
  run_id: string;
  status: RunbookRunState;
  target: RunbookTargetContext;
  active_step_id: string | null;
  active_phase: RunbookPhase | null;
  pending_approval_id: string | null;
  pause_reason: string | null;
  steps: RunbookStepRun[];
  source_id?: string;
  definition_id?: string;
  definition_version?: string;
  definition_title?: string;
  inputs?: Record<string, string | number | boolean>;
  evidence_mode?: EvidenceMode;
  pending_approval?: RunbookApprovalRequest | null;
  pending_operator?: RunbookOperatorRequest | null;
  pending_manual?: RunbookManualRequest | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  report_ready?: boolean;
}

export interface RunbookHistoryEntry {
  run_id: string;
  source_id: string | null;
  definition_id: string;
  definition_version: string;
  definition_title: string;
  state: RunbookRunState;
  target_label: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  checked_steps: number;
  total_steps: number;
}

export interface RunbookHistoryWire {
  id: string;
  source_id?: string | null;
  definition_id: string;
  definition_version: string;
  definition_title: string;
  target_session_id: string;
  status: RunbookRunState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  report_ready: boolean;
  checked_steps?: number;
  total_steps?: number;
}

export interface RunbookReportChecklistItem {
  step_id: string;
  title: string;
  required: boolean;
  state: RunbookStepState;
  checked: boolean;
  changed: boolean;
  assurance: Assurance | null;
  summary: string | null;
  operator_comment: string | null;
  exception: string | null;
  waiver: { actor: string; reason: string; created_at: string } | null;
  evidence: RunbookReportEvidence[];
  exceptions: string[];
  unresolved_risks: string[];
  attempts: RunbookAttempt[];
}

export interface RunbookReportEvidence {
  id: string;
  attempt_id: string;
  mode: string;
  availability: "pending" | "complete" | "missing";
  relative_path: string | null;
  bytes: number;
  sha256: string;
  redacted: boolean;
  truncated: boolean;
}

/** One recorded artifact read back for review. `available: false` is a normal
 * answer — the file can be deleted or altered after the run, and the digest is
 * re-verified on every read, so what is shown is always what was recorded. */
export interface RunbookEvidenceContent {
  evidence_id: string;
  available: boolean;
  text: string;
  bytes: number;
  redacted: boolean;
  truncated: boolean;
}

export interface RunbookReportResumeEnvironment {
  resumed_at: string;
  app_version: string;
  model: string | null;
  previous_target: Omit<RunbookTargetContext, "observed_at">;
  target: Omit<RunbookTargetContext, "observed_at">;
}

export interface RunbookReport {
  /** Exact validated report returned by Rust and written to report.json. */
  canonical: RunbookReportWire;
  schema_version: string;
  run_id: string;
  result: RunbookRunState;
  definition: {
    id: string;
    version: string;
    title: string;
    yaml_sha256: string;
    canonical_json_sha256: string;
  };
  target: Omit<RunbookTargetContext, "observed_at">;
  inputs: unknown;
  app_version: string;
  model: string | null;
  resumes: RunbookReportResumeEnvironment[];
  created_at: string;
  started_at: string | null;
  finished_at: string;
  duration_ms: number;
  executive_summary: string;
  checklist: RunbookReportChecklistItem[];
  approvals: Array<{
    approval_id: string;
    step_id: string;
    phase: RunbookPhase;
    decision: string;
    proposed_command: string | null;
    executed_command: string | null;
    actor: string | null;
    reason: string | null;
    requested_at: string;
    decided_at: string | null;
    read_only: boolean;
    network: boolean;
    privileged: boolean;
    opaque: boolean;
    edited: boolean;
    project_digest: string | null;
    inventory_digest: string | null;
  }>;
  deviations: Array<{
    step_id: string;
    message: string;
    proposed_command: string | null;
    executed_command: string | null;
  }>;
  exceptions: string[];
  unresolved_risks: string[];
}

/** Exact canonical Rust report. Kept distinct so UI conveniences (flattened
 * approvals, renamed digest fields) can never be mistaken for export data. */
export interface RunbookReportWire {
  api_version: string;
  run_id: string;
  status: RunbookRunState;
  definition: {
    id: string;
    version: string;
    title: string;
    source_sha256: string;
    canonical_sha256: string;
  };
  target: Omit<RunbookTargetContext, "observed_at">;
  inputs: unknown;
  environment: {
    app_version: string;
    model: string | null;
    resumes?: RunbookReportResumeEnvironment[];
  };
  timing: { created_at: string; started_at: string | null; finished_at: string; duration_ms: number };
  checklist: Array<{
    id: string;
    title: string;
    required: boolean;
    status: RunbookStepState;
    checked: boolean;
    changed: boolean;
    assurance: Assurance | null;
    summary: string | null;
    operator_comment: string | null;
    waiver: { actor: string; reason: string; created_at: string } | null;
    attempts: Array<{
      id: string;
      phase: RunbookPhase;
      executor: string;
      status: string;
      proposed_command: string | null;
      executed_command: string | null;
      exit_code: number | null;
      duration_ms: number | null;
      output_tail: string | null;
      output_observed_bytes: number;
      output_captured_bytes: number;
      output_redacted: boolean;
      output_truncated: boolean;
      error: string | null;
      structured_outcomes?: unknown | null;
      intent_at: string;
      result_at: string | null;
    }>;
    approvals: Array<{
      id: string;
      phase: RunbookPhase;
      status: string;
      proposed_command: string | null;
      executed_command: string | null;
      read_only: boolean;
      network: boolean;
      privileged: boolean;
      opaque: boolean;
      project_digest?: string | null;
      inventory_digest?: string | null;
      actor: string | null;
      reason: string | null;
      requested_at: string;
      decided_at: string | null;
      edited: boolean;
    }>;
    deviations: Array<{
      kind: string;
      detail: string;
      proposed_command: string | null;
      executed_command: string | null;
    }>;
    evidence: RunbookReportEvidence[];
    exceptions: string[];
    unresolved_risks: string[];
  }>;
  executive_summary: string;
  exceptions: string[];
  unresolved_risks: string[];
}

export interface RunbookStartRequest {
  source_id: string;
  session_id: string;
  target_context: RunbookTargetContext;
  inputs: Record<string, string | number | boolean>;
  evidence_mode: EvidenceMode;
}

export interface RunbookTerminalResult {
  exit_code: number | null;
  output_tail: string;
  output_truncated?: boolean;
  output_observed_bytes?: number;
  output_captured_bytes?: number;
  duration_ms: number;
  error: string | null;
  execution_mode: string | null;
  target_context: RunbookTargetContext | null;
}

export interface RunbookOperatorDecision {
  kind: RunbookDecisionKind;
  step_id?: string | null;
  actor?: string | null;
  reason?: string | null;
  session_id?: string | null;
  target_context?: RunbookTargetContext | null;
}

export interface RunbookExportResult {
  destination: string;
  files: string[];
}

export interface RunbookEvidenceCleanupResult {
  expected: number;
  deleted: number;
  missing: number;
  errors: string[];
  complete: boolean;
}

export interface RunbookDeleteResult {
  run_id: string;
  database_deleted: boolean;
  evidence_cleanup: RunbookEvidenceCleanupResult;
}

export type RunbookEvent =
  | { type: "RunStarted"; run_id: string; session_id: string }
  | { type: "StepChanged"; run_id: string; step_id: string; status: RunbookStepState; phase: RunbookPhase | null }
  | ({ type: "ApprovalRequested" } & RunbookApprovalRequest)
  | {
      type: "RunInTerminal";
      run_id: string;
      attempt_id: string;
      approval_id: string | null;
      session_id: string;
      command: string;
      timeout_ms: number;
      environment: Record<string, string>;
    }
  | ({ type: "OperatorDecisionRequired" } & RunbookOperatorRequest & {
        manual?: RunbookManualRequest | null;
      })
  | { type: "ReportReady"; run_id: string }
  | { type: "RunFinished"; run_id: string; state: RunbookRunState }
  | { type: "Error"; run_id?: string | null; message: string; recoverable: boolean };

export interface RunbookEventBuffer {
  /** Channel callback. Run-scoped events remain queued until activate(). */
  handle(event: RunbookEvent): void;
  /** Mark the durable run installed, then deliver every queued event in order. */
  activate(runId: string): void;
  /** Drop queued events when the start/resume invoke itself fails. */
  discard(runId?: string): void;
}

/**
 * A Tauri Channel can deliver before the invoke that created it resolves. Keep
 * those events run-scoped until the caller has installed the returned durable
 * run (including its evidence mode and target), then replay them synchronously
 * in channel order. Global errors have no run to install and are delivered
 * immediately.
 */
export function createRunbookEventBuffer(
  deliver: (event: RunbookEvent) => void,
): RunbookEventBuffer {
  const queues = new Map<string, RunbookEvent[]>();
  const active = new Set<string>();
  const finished = new Set<string>();

  const deliverOne = (event: RunbookEvent) => {
    deliver(event);
    if (event.type === "RunFinished") {
      active.delete(event.run_id);
      finished.add(event.run_id);
      queues.delete(event.run_id);
    }
  };

  return {
    handle(event) {
      const runId = event.run_id ?? null;
      if (!runId) {
        deliver(event);
        return;
      }
      if (finished.has(runId)) return;
      if (active.has(runId)) {
        deliverOne(event);
        return;
      }
      const queue = queues.get(runId) ?? [];
      queue.push(event);
      queues.set(runId, queue);
    },
    activate(runId) {
      if (finished.has(runId)) return;
      active.add(runId);
      const queued = queues.get(runId) ?? [];
      queues.delete(runId);
      for (const event of queued) deliverOne(event);
    },
    discard(runId) {
      if (runId) {
        queues.delete(runId);
        active.delete(runId);
        finished.add(runId);
      } else {
        queues.clear();
        active.clear();
        finished.clear();
      }
    },
  };
}

type RunbookWireEvent =
  | { type: "RunStarted"; run_id: string; session_id: string }
  | { type: "StepChanged"; run_id: string; step_id: string; status: RunbookStepState; phase: RunbookPhase | null }
  | {
      type: "ApprovalRequested";
      run_id: string;
      approval_id: string;
      step_id: string;
      phase: RunbookPhase;
      command: string;
      explanation: string;
      read_only: boolean;
      network: boolean;
      privileged: boolean;
      opaque: boolean;
      project_digest?: string | null;
      inventory_digest?: string | null;
    }
  | {
      type: "RunInTerminal";
      run_id: string;
      attempt_id: string;
      approval_id: string | null;
      session_id: string;
      command: string;
      timeout_secs: number;
      environment: Record<string, string>;
    }
  | { type: "OperatorDecisionRequired"; run_id: string; step_id: string | null; reason: string; choices: RunbookDecisionKind[]; message?: string; requested_at?: string; manual?: RunbookManualRequest | null }
  | { type: "ReportReady"; run_id: string }
  | { type: "RunFinished"; run_id: string; status: RunbookRunState }
  | { type: "Error"; run_id?: string | null; message: string };

const runChannels = new Map<string, Channel<RunbookWireEvent>>();
const channelAliases = new Map<string, Set<string>>();

function releaseRunbookChannel(key: string): void {
  const aliases = channelAliases.get(key) ?? new Set([key]);
  for (const alias of aliases) {
    runChannels.delete(alias);
    channelAliases.delete(alias);
  }
}

function eventChannel(
  key: string,
  onEvent: (event: RunbookEvent) => void,
): Channel<RunbookWireEvent> {
  const channel = new Channel<RunbookWireEvent>();
  channel.onmessage = (wireEvent) => {
    const event = normalizeRunbookEvent(wireEvent);
    onEvent(event);
    // A run-scoped fatal error is followed by canonical report settlement and
    // RunFinished on the same channel. Keep it alive until that terminal event.
    if (event.type === "RunFinished" || (event.type === "Error" && !event.run_id)) {
      releaseRunbookChannel(key);
    }
  };
  runChannels.set(key, channel);
  return channel;
}

function normalizeRunbookEvent(event: RunbookWireEvent): RunbookEvent {
  switch (event.type) {
    case "ApprovalRequested":
      return {
        type: event.type,
        run_id: event.run_id,
        approval_id: event.approval_id,
        step_id: event.step_id,
        phase: event.phase,
        command: event.command,
        explanation: event.explanation,
        classification: {
          read_only: event.read_only,
          network: event.network,
          privileged: event.privileged,
          opaque: event.opaque,
        },
        project_digest: event.project_digest ?? null,
        inventory_digest: event.inventory_digest ?? null,
      };
    case "RunInTerminal":
      return { ...event, timeout_ms: event.timeout_secs * 1_000 };
    case "OperatorDecisionRequired":
      return {
        ...event,
        message: event.message ?? event.reason,
        requested_at: event.requested_at ?? new Date().toISOString(),
      };
    case "RunFinished":
      return { type: event.type, run_id: event.run_id, state: event.status };
    case "Error":
      return { ...event, recoverable: false };
    case "RunStarted":
    case "StepChanged":
    case "ReportReady":
      return event;
  }
}

export const runbooksImport = (path: string) =>
  invoke<RunbookSourceWire>("runbooks_import", { path }).then(normalizeRunbookSource);

export const runbooksRefresh = (sourceId: string) =>
  invoke<RunbookSourceWire>("runbooks_refresh", { source_id: sourceId }).then(normalizeRunbookSource);

export const runbooksList = () =>
  invoke<RunbookSourceWire[]>("runbooks_list").then((sources) => sources.map(normalizeRunbookSource));

export const runbooksRemove = (sourceId: string) =>
  invoke<void>("runbooks_remove", { source_id: sourceId });

export const runbooksRestoreBuiltins = () =>
  invoke<RunbookSourceWire[]>("runbooks_restore_builtins").then((sources) =>
    sources.map(normalizeRunbookSource)
  );

export const runbooksDraftsList = () =>
  invoke<RunbookDraftSummary[]>("runbooks_drafts_list");

export const runbooksDraftCreate = (initial?: RunbookDraftDocument) =>
  invoke<RunbookDraft>("runbooks_draft_create", { initial: initial ?? null });

export const runbooksDraftGet = (draftId: string) =>
  invoke<RunbookDraft>("runbooks_draft_get", { draft_id: draftId });

export const runbooksDraftSave = (
  draftId: string,
  expectedRevision: number,
  document: RunbookDraftDocument,
) =>
  invoke<RunbookDraft>("runbooks_draft_save", {
    draft_id: draftId,
    expected_revision: expectedRevision,
    document,
  });

export const runbooksDraftValidate = (draftId: string) =>
  invoke<RunbookDraftPreview>("runbooks_draft_validate", { draft_id: draftId });

/**
 * Author a draft with the active model. Collected, not streamed: a partial JSON
 * object is nothing the operator can be shown.
 *
 * Nothing is stored — the caller passes the result to `runbooksDraftCreate`, so
 * a generated runbook enters the wizard by the same path a hand-written one
 * does. Cancel with the shared `aiCancel(requestId)`.
 */
export const runbooksAiGenerate = (
  requestId: string,
  requirements: string,
  terminalContext: string | null,
) =>
  invoke<RunbookDraftDocument>("runbooks_ai_generate", {
    request_id: requestId,
    requirements,
    terminal_context: terminalContext,
  });

export const runbooksDraftPublish = (draftId: string, expectedRevision: number) =>
  invoke<RunbookSourceWire>("runbooks_draft_publish", {
    draft_id: draftId,
    expected_revision: expectedRevision,
  }).then(normalizeRunbookSource);

export const runbooksDraftDiscard = (draftId: string) =>
  invoke<void>("runbooks_draft_discard", { draft_id: draftId });

export const runbooksGetDefinition = (sourceId: string) =>
  invoke<RunbookDefinition>("runbooks_get_definition", { source_id: sourceId });

export async function runbooksStart(
  request: RunbookStartRequest,
  onEvent: (event: RunbookEvent) => void,
): Promise<RunbookRun> {
  const key = `start:${request.source_id}:${request.session_id}:${Date.now()}`;
  const on_event = eventChannel(key, onEvent);
  try {
    const run = await invoke<RunbookRun>("runbooks_start", { request, on_event });
    // A backend may return as soon as it has allocated the durable run. Retain
    // the same Channel under the durable id so cancellation/recovery can release it.
    const channel = runChannels.get(key);
    if (channel && !isTerminalRunState(run.status)) {
      runChannels.set(run.run_id, channel);
      const aliases = new Set([key, run.run_id]);
      channelAliases.set(key, aliases);
      channelAliases.set(run.run_id, aliases);
    }
    runChannels.delete(key);
    return run;
  } catch (error) {
    releaseRunbookChannel(key);
    throw error;
  }
}

export const runbooksGet = (runId: string) =>
  invoke<RunbookRun>("runbooks_get", { run_id: runId });

export async function runbooksResume(
  runId: string,
  sessionId: string,
  targetContext: RunbookTargetContext,
  onEvent: (event: RunbookEvent) => void,
): Promise<RunbookRun> {
  const on_event = eventChannel(runId, onEvent);
  try {
    return await invoke<RunbookRun>("runbooks_resume", {
      run_id: runId,
      session_id: sessionId,
      target_context: targetContext,
      on_event,
    });
  } catch (error) {
    releaseRunbookChannel(runId);
    throw error;
  }
}

export async function runbooksCancel(runId: string): Promise<void> {
  // Cancellation is a request, not terminal settlement. The engine still emits
  // ReportReady and RunFinished; releasing here loses exactly those events.
  await invoke<void>("runbooks_cancel", { run_id: runId });
}

export interface RunbookTerminalPollOptions {
  maxAttempts?: number;
  intervalMs?: number;
  onObservation?: (run: RunbookRun) => void;
}

/** Bounded reconciliation used after cancellation. A single immediate get can
 * still be running/waiting while Rust marks attempts unknown and writes the
 * canonical cancelled report. */
export async function runbooksWaitForTerminal(
  runId: string,
  options: RunbookTerminalPollOptions = {},
): Promise<RunbookRun> {
  return pollRunbookUntilTerminal(runId, runbooksGet, options);
}

export async function pollRunbookUntilTerminal(
  runId: string,
  getRun: (runId: string) => Promise<RunbookRun>,
  options: RunbookTerminalPollOptions = {},
): Promise<RunbookRun> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 40, 100));
  const intervalMs = Math.max(0, Math.min(options.intervalMs ?? 100, 1_000));
  let last: RunbookRun | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    last = await getRun(runId);
    options.onObservation?.(last);
    if (isTerminalRunState(last.status)) return last;
    if (attempt + 1 < maxAttempts) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(
    `Run ${runId} did not reach a terminal state after cancellation (last state: ${last?.status ?? "unknown"}).`,
  );
}

/** How the operator arrived at an approval. Wire literals are pinned on the Rust
 *  side too — see `ApprovalAcknowledgement` in `commands/runbooks.rs`. */
export type RunbookApprovalAcknowledgement =
  | "acknowledged"
  | "pre_authorized"
  | "model_once";

export const runbooksRespondApproval = (
  runId: string,
  approvalId: string,
  approved: boolean,
  command: string | null,
  acknowledgement: RunbookApprovalAcknowledgement,
) =>
  invoke<void>("runbooks_respond_approval", {
    run_id: runId,
    approval_id: approvalId,
    approved,
    command,
    acknowledgement,
  });

export const runbooksDecide = (runId: string, decision: RunbookOperatorDecision) =>
  invoke<void>("runbooks_decide", { run_id: runId, decision });

/** Atomically leases a terminal dispatch in Rust. False means a replayed event
 * was already claimed and must never be typed again. */
export const runbooksClaimTerminalDispatch = (runId: string, attemptId: string) =>
  invoke<boolean>("runbooks_claim_terminal_dispatch", {
    run_id: runId,
    attempt_id: attemptId,
  });

export const runbooksSubmitTerminalResult = (
  runId: string,
  attemptId: string,
  result: RunbookTerminalResult,
) =>
  invoke<void>("runbooks_submit_terminal_result", {
    run_id: runId,
    attempt_id: attemptId,
    result,
  });

export const runbooksSubmitManual = (
  runId: string,
  stepId: string,
  outcome: "passed" | "failed" | "not_applicable",
  comment: string,
  evidence: string | null,
  targetContext: RunbookTargetContext,
) =>
  invoke<void>("runbooks_submit_manual", {
    run_id: runId,
    step_id: stepId,
    outcome,
    comment,
    evidence,
    target_context: targetContext,
  });

export const runbooksHistory = () =>
  invoke<RunbookHistoryWire[]>("runbooks_history").then((runs) => runs.map(normalizeRunbookHistory));

export const runbooksReport = (runId: string) =>
  invoke<RunbookReportWire>("runbooks_report", { run_id: runId }).then(normalizeRunbookReport);

export const runbooksEvidenceRead = (runId: string, evidenceId: string) =>
  invoke<RunbookEvidenceContent>("runbooks_evidence_read", {
    run_id: runId,
    evidence_id: evidenceId,
  });

export const runbooksExport = (runId: string, destination: string) =>
  invoke<RunbookExportResult>("runbooks_export", { run_id: runId, destination });

export const runbooksExportPackage = (sourceId: string, destination: string) =>
  invoke<RunbookExportResult>("runbooks_export_package", {
    source_id: sourceId,
    destination,
  });

/** Historical deletion is always an explicit, confirmed UI gesture. Removing a
 * package registration remains a separate operation and never calls this. */
export const runbooksDelete = (runId: string) =>
  invoke<RunbookDeleteResult>("runbooks_delete", {
    run_id: runId,
    confirmed: true,
  });

export async function chooseRunbookPackage(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function chooseRunbookExportFolder(): Promise<string | null> {
  const selected = await openDialog({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export function isTerminalRunState(state: RunbookRunState): boolean {
  return ["succeeded", "completed_with_exceptions", "failed", "cancelled"].includes(state);
}

export function isCheckedStepState(state: RunbookStepState): boolean {
  return state === "already_compliant" || state === "remediated_verified";
}

export function definitionApiVersion(definition: RunbookDefinition): string {
  return definition.apiVersion ?? definition.api_version ?? "unknown";
}

export function definitionCapabilities(definition: RunbookDefinition): RunbookCapabilities {
  return definition.spec.declaredCapabilities ?? definition.spec.declared_capabilities ?? {};
}

/** Mirrors `EvidenceCaptureMode::retention_rank`. Declaration order in the
 * union is a wire detail, so the ranking is written out rather than derived. */
const EVIDENCE_RETENTION_RANK: Record<EvidenceMode, number> = { none: 0, tail: 1, full: 2 };

/** Mirrors `EvidenceRecordingPolicy::floor`.
 *
 * `runbooks_start` applies the same clamp server-side and is what actually
 * enforces the policy — this copy only decides which choices preflight offers,
 * so the operator is never shown a mode the backend would silently override. */
export function evidenceFloor(
  policy: EvidenceRecordingPolicy,
  declared: EvidenceMode | null | undefined,
): EvidenceMode {
  if (policy === "all") return "full";
  if (policy === "none") return "none";
  return declared ?? "tail";
}

/** Mirrors `EvidenceCaptureMode::at_least`: raise to the floor, never lower. */
export function atLeastEvidence(requested: EvidenceMode, floor: EvidenceMode): EvidenceMode {
  return EVIDENCE_RETENTION_RANK[requested] >= EVIDENCE_RETENTION_RANK[floor] ? requested : floor;
}

/** The modes an operator may still choose for one run under `floor`. */
export function evidenceModesAtOrAbove(floor: EvidenceMode): EvidenceMode[] {
  return EVIDENCE_MODES.filter((mode) => EVIDENCE_RETENTION_RANK[mode] >= EVIDENCE_RETENTION_RANK[floor]);
}

export function definitionRecordOutput(definition: RunbookDefinition): EvidenceMode | null {
  return definition.spec.audit?.recordOutput ?? null;
}

/** Bytes of terminal output to harvest for one attempt.
 *
 * Mirrors `OUTPUT_TAIL_BYTES` / `FULL_EVIDENCE_BYTES` in Rust's redact.rs. Zero
 * for `none` is the point: Rust discards that output anyway, so harvesting it
 * only moves bytes the operator declined to keep across the IPC boundary. An
 * unknown mode is treated as `tail`, which is also the run row's SQL default. */
export function evidenceTailLimit(mode: EvidenceMode | null | undefined): number {
  if (mode === "none") return 0;
  return mode === "full" ? 1_048_576 : 8_192;
}

export function defaultRunbookInputs(
  definition: RunbookDefinition,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const [name, input] of Object.entries(definition.spec.inputs ?? {})) {
    if (input.default !== null && input.default !== undefined) values[name] = input.default;
  }
  return values;
}

/** Attach validated runbook inputs to one command without mutating the user's
 * shell environment. Values are POSIX-quoted, keys are sorted for stable audit
 * output, and control bytes are rejected before the line reaches xterm. */
export function commandWithRunbookEnvironment(
  command: string,
  environment: Record<string, string>,
): string {
  return prefixCommandEnvironment(command, environment);
}

export function normalizeRunbookReport(report: RunbookReportWire): RunbookReport {
  return {
    canonical: report,
    schema_version: report.api_version,
    run_id: report.run_id,
    result: report.status,
    definition: {
      id: report.definition.id,
      version: report.definition.version,
      title: report.definition.title,
      yaml_sha256: report.definition.source_sha256,
      canonical_json_sha256: report.definition.canonical_sha256,
    },
    target: report.target,
    inputs: report.inputs,
    app_version: report.environment.app_version,
    model: report.environment.model,
    resumes: report.environment.resumes ?? [],
    created_at: report.timing.created_at,
    started_at: report.timing.started_at,
    finished_at: report.timing.finished_at,
    duration_ms: report.timing.duration_ms,
    executive_summary: report.executive_summary,
    checklist: report.checklist.map((step) => ({
      step_id: step.id,
      title: step.title,
      required: step.required,
      state: step.status,
      checked: step.checked,
      changed: step.changed,
      assurance: step.assurance,
      summary: step.summary,
      operator_comment: step.operator_comment,
      exception: [...step.exceptions, ...step.unresolved_risks][0] ?? null,
      waiver: step.waiver,
      evidence: step.evidence,
      exceptions: step.exceptions,
      unresolved_risks: step.unresolved_risks,
      attempts: step.attempts.map((attempt) => ({
        attempt_id: attempt.id,
        step_id: step.id,
        phase: attempt.phase,
        executor: attempt.executor,
        status: attempt.status as RunbookAttempt["status"],
        proposed_command: attempt.proposed_command,
        executed_command: attempt.executed_command,
        exit_code: attempt.exit_code,
        output_tail: attempt.output_tail,
        output_observed_bytes: attempt.output_observed_bytes,
        output_captured_bytes: attempt.output_captured_bytes,
        output_redacted: attempt.output_redacted,
        output_truncated: attempt.output_truncated,
        duration_ms: attempt.duration_ms,
        error: attempt.error,
        structured_outcomes: attempt.structured_outcomes,
        started_at: attempt.intent_at,
        finished_at: attempt.result_at,
      })),
    })),
    approvals: report.checklist.flatMap((step) =>
      step.approvals.map((approval) => ({
        approval_id: approval.id,
        step_id: step.id,
        phase: approval.phase,
        decision: approval.status,
        proposed_command: approval.proposed_command,
        executed_command: approval.executed_command,
        actor: approval.actor,
        reason: approval.reason,
        requested_at: approval.requested_at,
        decided_at: approval.decided_at,
        read_only: approval.read_only,
        network: approval.network,
        privileged: approval.privileged,
        opaque: approval.opaque,
        edited: approval.edited,
        project_digest: approval.project_digest ?? null,
        inventory_digest: approval.inventory_digest ?? null,
      })),
    ),
    deviations: report.checklist.flatMap((step) =>
      step.deviations.map((deviation) => ({
        step_id: step.id,
        message: `${deviation.kind}: ${deviation.detail}`,
        proposed_command: deviation.proposed_command,
        executed_command: deviation.executed_command,
      })),
    ),
    exceptions: report.exceptions,
    unresolved_risks: report.unresolved_risks,
  };
}

export function normalizeRunbookSource(source: RunbookSourceWire): RunbookSource {
  return {
    source_id: source.id,
    source_kind: source.source_kind ?? "user",
    package_path: source.package_path,
    definition_id: source.definition_id,
    version: source.definition_version,
    title: source.title,
    digest_sha256: source.source_sha256,
    state: source.valid ? "valid" : "invalid",
    validation_issues: source.validation_error
      ? [{ path: null, message: source.validation_error }]
      : [],
    imported_at: source.created_at,
    refreshed_at: source.updated_at,
  };
}

export function normalizeRunbookHistory(run: RunbookHistoryWire): RunbookHistoryEntry {
  const started = run.started_at ?? run.created_at;
  const duration = run.finished_at
    ? Math.max(0, Date.parse(run.finished_at) - Date.parse(started))
    : null;
  return {
    run_id: run.id,
    source_id: run.source_id ?? null,
    definition_id: run.definition_id,
    definition_version: run.definition_version,
    definition_title: run.definition_title,
    state: run.status,
    target_label: run.target_session_id,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: duration !== null && Number.isFinite(duration) ? duration : null,
    checked_steps: run.checked_steps ?? 0,
    total_steps: run.total_steps ?? 0,
  };
}
