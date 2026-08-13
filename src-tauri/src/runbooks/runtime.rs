//! In-memory coordination for durable runs.
//!
//! SQLite remains the source of truth. This layer prevents two async tasks from
//! driving one terminal, validates phase-scoped agent completions, and owns the
//! one-shot approval / PTY / cancellation rendezvous used by Tauri commands.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::Mutex;

use super::state::{
    ApprovalDecision, PauseDecision, RunStatus, RunbookPhase, StepStatus, TargetBinding,
    VerificationAssurance, Waiver,
};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum RunbookEvent {
    RunStarted {
        run_id: String,
        session_id: String,
    },
    StepChanged {
        run_id: String,
        step_id: String,
        status: StepStatus,
        phase: Option<RunbookPhase>,
    },
    ApprovalRequested {
        run_id: String,
        approval_id: String,
        step_id: String,
        phase: RunbookPhase,
        command: String,
        explanation: String,
        read_only: bool,
        network: bool,
        privileged: bool,
        opaque: bool,
    },
    RunInTerminal {
        run_id: String,
        attempt_id: String,
        approval_id: Option<String>,
        session_id: String,
        command: String,
        timeout_secs: u64,
        environment: HashMap<String, String>,
    },
    OperatorDecisionRequired {
        run_id: String,
        step_id: Option<String>,
        reason: String,
        choices: Vec<PauseDecision>,
        #[serde(skip_serializing_if = "Option::is_none")]
        manual: Option<ManualRequest>,
        #[serde(skip_serializing_if = "Option::is_none")]
        requested_at: Option<String>,
    },
    ReportReady {
        run_id: String,
    },
    RunFinished {
        run_id: String,
        status: RunStatus,
    },
    Error {
        run_id: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StepSnapshot {
    pub id: String,
    pub status: StepStatus,
    pub waiver: Option<Waiver>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunSnapshot {
    pub run_id: String,
    pub status: RunStatus,
    pub target: TargetBinding,
    pub active_step_id: Option<String>,
    pub active_phase: Option<RunbookPhase>,
    pub pending_approval_id: Option<String>,
    pub pause_reason: Option<String>,
    pub steps: Vec<StepSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub command: String,
    pub explanation: String,
    pub read_only: bool,
    pub network: bool,
    pub privileged: bool,
    pub opaque: bool,
}

impl ApprovalRequest {
    /// Native v1 drives an existing interactive PTY whose shell state is not
    /// attested. Every phase therefore requires a fresh operator approval and
    /// prompt-trust attestation, regardless of textual command classification.
    pub fn requires_approval(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub decision: ApprovalDecision,
    pub actor: String,
    pub reason: Option<String>,
    pub edited_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedApproval {
    pub approval_id: String,
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub proposed_command: String,
    pub executed_command: Option<String>,
    pub decision: ApprovalDecision,
    pub actor: String,
    pub reason: Option<String>,
    pub edited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhaseResult {
    Compliant,
    Noncompliant,
    Applied,
    Verified,
    Failed,
    Unknown,
}

/// The only completion primitive made available to a step-scoped agent. It has
/// no run-level success value, and the coordinator rejects a mismatched active
/// run, step or phase.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PhaseCompletion {
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub result: PhaseResult,
    pub assurance: Option<VerificationAssurance>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedPtyResult {
    /// `None` means the command timed out or otherwise has an unknown outcome.
    pub exit_code: Option<i32>,
    pub output_tail: String,
    #[serde(default)]
    pub output_truncated: bool,
    #[serde(default)]
    pub output_observed_bytes: u64,
    #[serde(default)]
    pub output_captured_bytes: u64,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualOutcome {
    Compliant,
    Noncompliant,
    Applied,
    Verified,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualResponse {
    pub outcome: ManualOutcome,
    pub actor: String,
    pub comment: String,
    /// Small textual evidence supplied by the operator. The engine applies the
    /// same redaction and capture limits as terminal evidence before storage.
    pub evidence: Option<String>,
    /// Fresh frontend observation captured when the operator submits the
    /// attestation. The engine compares it to the immutable run binding.
    pub target: TargetBinding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualRequest {
    pub request_id: String,
    pub run_id: String,
    pub step_id: String,
    pub title: String,
    pub phase: RunbookPhase,
    pub instructions: String,
}

impl ManualResponse {
    pub fn validate(&self) -> Result<(), String> {
        if self.actor.trim().is_empty() {
            return Err("manual response actor is required".into());
        }
        if self.comment.trim().is_empty() {
            return Err("manual response comment is required".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct CoordinatorState {
    runs: HashMap<String, ManagedRun>,
    session_locks: HashMap<String, String>,
}

struct ManagedRun {
    status: RunStatus,
    target: TargetBinding,
    active_step_id: Option<String>,
    active_phase: Option<RunbookPhase>,
    steps: HashMap<String, StepStatus>,
    waivers: HashMap<String, Waiver>,
    step_order: Vec<String>,
    pending_approval: Option<ApprovalRequest>,
    declined_commands: HashSet<(String, RunbookPhase, String)>,
    pause_reason: Option<String>,
}

#[derive(Default)]
pub struct RunCoordinator {
    inner: Mutex<CoordinatorState>,
}

impl RunCoordinator {
    pub fn register_run(
        &self,
        run_id: &str,
        target: TargetBinding,
        step_ids: &[String],
    ) -> Result<RunSnapshot, String> {
        if run_id.trim().is_empty() {
            return Err("run id is required".into());
        }
        if target.session_id.trim().is_empty() {
            return Err("target session id is required".into());
        }
        let mut unique = HashSet::new();
        if let Some(duplicate) = step_ids.iter().find(|step| !unique.insert(step.as_str())) {
            return Err(format!("duplicate runtime step id: {duplicate}"));
        }

        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        if state.runs.contains_key(run_id) {
            return Err(format!("run already registered: {run_id}"));
        }
        if let Some(owner) = state.session_locks.get(&target.session_id) {
            return Err(format!(
                "terminal session {} is already owned by run {owner}",
                target.session_id
            ));
        }
        state
            .session_locks
            .insert(target.session_id.clone(), run_id.to_string());
        state.runs.insert(
            run_id.to_string(),
            ManagedRun {
                status: RunStatus::Created,
                target,
                active_step_id: None,
                active_phase: None,
                steps: step_ids
                    .iter()
                    .map(|id| (id.clone(), StepStatus::Pending))
                    .collect(),
                waivers: HashMap::new(),
                step_order: step_ids.to_vec(),
                pending_approval: None,
                declined_commands: HashSet::new(),
                pause_reason: None,
            },
        );
        snapshot(&state, run_id)
    }

    /// Reconstruct the in-memory coordinator after an interrupted durable run
    /// has been explicitly rebound. In-flight phase states are never accepted:
    /// startup reconciliation must first persist them as `unknown` so no
    /// mutation can be replayed blindly.
    pub fn register_restored_run(
        &self,
        run_id: &str,
        target: TargetBinding,
        steps: &[(String, StepStatus)],
    ) -> Result<RunSnapshot, String> {
        if run_id.trim().is_empty() || target.session_id.trim().is_empty() {
            return Err("run id and target session id are required".into());
        }
        if steps.is_empty() {
            return Err("a restored run requires at least one step".into());
        }
        let mut unique = HashSet::new();
        for (step_id, status) in steps {
            if !unique.insert(step_id.as_str()) {
                return Err(format!("duplicate runtime step id: {step_id}"));
            }
            if matches!(
                status,
                StepStatus::Checking | StepStatus::Applying | StepStatus::Verifying
            ) {
                return Err(format!(
                    "restored step {step_id} is still in-flight ({status}); reconcile it to unknown first"
                ));
            }
        }

        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        if state.runs.contains_key(run_id) {
            return Err(format!("run already registered: {run_id}"));
        }
        if let Some(owner) = state.session_locks.get(&target.session_id) {
            return Err(format!(
                "terminal session {} is already owned by run {owner}",
                target.session_id
            ));
        }
        state
            .session_locks
            .insert(target.session_id.clone(), run_id.to_string());
        state.runs.insert(
            run_id.to_string(),
            ManagedRun {
                status: RunStatus::Ready,
                target,
                active_step_id: None,
                active_phase: None,
                steps: steps.iter().cloned().collect(),
                waivers: HashMap::new(),
                step_order: steps.iter().map(|(id, _)| id.clone()).collect(),
                pending_approval: None,
                declined_commands: HashSet::new(),
                pause_reason: None,
            },
        );
        snapshot(&state, run_id)
    }

    pub fn snapshot(&self, run_id: &str) -> Result<RunSnapshot, String> {
        let state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        snapshot(&state, run_id)
    }

    /// Remove an in-process run after a fatal startup/engine error and release
    /// its terminal lock. Durable state remains authoritative and is settled by
    /// the caller before this cleanup is used.
    pub fn abort_run(&self, run_id: &str, _reason: &str) -> Result<(), String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = state
            .runs
            .remove(run_id)
            .ok_or_else(|| format!("unknown run: {run_id}"))?;
        if state
            .session_locks
            .get(&run.target.session_id)
            .is_some_and(|owner| owner == run_id)
        {
            state.session_locks.remove(&run.target.session_id);
        }
        Ok(())
    }

    pub fn transition_run(&self, run_id: &str, next: RunStatus) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let release_session = {
            let run = state
                .runs
                .get_mut(run_id)
                .ok_or_else(|| format!("unknown run: {run_id}"))?;
            if !run.status.can_transition_to(next) {
                return Err(format!(
                    "invalid run transition for {run_id}: {} -> {next}",
                    run.status
                ));
            }
            run.status = next;
            if next != RunStatus::Paused {
                run.pause_reason = None;
            }
            if next.is_terminal() || next == RunStatus::Interrupted {
                run.pending_approval = None;
                Some(run.target.session_id.clone())
            } else {
                None
            }
        };
        if let Some(session_id) = release_session {
            state.session_locks.remove(&session_id);
        }
        snapshot(&state, run_id)
    }

    pub fn begin_phase(
        &self,
        run_id: &str,
        step_id: &str,
        phase: RunbookPhase,
    ) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = running_mut(&mut state, run_id)?;
        let current = *run
            .steps
            .get(step_id)
            .ok_or_else(|| format!("unknown step {step_id} in run {run_id}"))?;
        let next = match phase {
            RunbookPhase::Check => StepStatus::Checking,
            RunbookPhase::Apply => StepStatus::Applying,
            RunbookPhase::Verify => StepStatus::Verifying,
        };
        // Apply completion transitions the state to Verifying before the verify
        // executor dispatches, so beginning that phase can be an idempotent
        // phase-marker update but never a mutation replay.
        if current != next {
            if !current.can_transition_to(next) {
                return Err(format!(
                    "cannot begin {phase} for {step_id}: step is {current}"
                ));
            }
            run.steps.insert(step_id.to_string(), next);
        }
        run.active_step_id = Some(step_id.to_string());
        run.active_phase = Some(phase);
        snapshot(&state, run_id)
    }

    pub fn complete_phase(&self, completion: &PhaseCompletion) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = running_mut(&mut state, &completion.run_id)?;
        if run.active_step_id.as_deref() != Some(&completion.step_id)
            || run.active_phase != Some(completion.phase)
        {
            return Err(format!(
                "phase completion does not match active run/step/phase for {}",
                completion.run_id
            ));
        }
        let current = *run
            .steps
            .get(&completion.step_id)
            .ok_or_else(|| format!("unknown step: {}", completion.step_id))?;
        let next = match (completion.phase, &completion.result) {
            (RunbookPhase::Check, PhaseResult::Compliant) => StepStatus::AlreadyCompliant,
            (RunbookPhase::Check, PhaseResult::Noncompliant) => StepStatus::NeedsAction,
            (RunbookPhase::Apply, PhaseResult::Applied) => StepStatus::Verifying,
            (RunbookPhase::Verify, PhaseResult::Verified) => StepStatus::RemediatedVerified,
            (_, PhaseResult::Failed) => StepStatus::Paused,
            (_, PhaseResult::Unknown) => StepStatus::Unknown,
            _ => {
                return Err(format!(
                    "result {:?} is invalid for {} phase",
                    completion.result, completion.phase
                ))
            }
        };
        if !current.can_transition_to(next) {
            return Err(format!(
                "phase completion cannot transition step {} from {current} to {next}",
                completion.step_id
            ));
        }
        run.steps.insert(completion.step_id.clone(), next);
        if next == StepStatus::Paused || next == StepStatus::Unknown {
            run.status = RunStatus::WaitingOperator;
            run.pause_reason = Some(match next {
                StepStatus::Unknown => "command outcome is unknown; reconcile before retry".into(),
                _ => "step phase failed".into(),
            });
        }
        run.active_phase = None;
        if next.is_checked() {
            run.active_step_id = None;
        }
        snapshot(&state, &completion.run_id)
    }

    pub fn request_approval(&self, request: ApprovalRequest) -> Result<RunSnapshot, String> {
        debug_assert!(request.requires_approval());
        if request.command.trim().is_empty() {
            return Err("approval command is required".into());
        }
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = running_mut(&mut state, &request.run_id)?;
        if run.active_step_id.as_deref() != Some(&request.step_id)
            || run.active_phase != Some(request.phase)
        {
            return Err("approval does not match the active step and phase".into());
        }
        if run.pending_approval.is_some() {
            return Err(format!(
                "run {} already has a pending approval",
                request.run_id
            ));
        }
        let fingerprint = command_fingerprint(&request.command);
        if run
            .declined_commands
            .contains(&(request.step_id.clone(), request.phase, fingerprint))
        {
            return Err(
                "this command was already declined; an operator retry decision is required".into(),
            );
        }
        run.pending_approval = Some(request.clone());
        run.status = RunStatus::WaitingApproval;
        snapshot(&state, &request.run_id)
    }

    pub fn resolve_approval(
        &self,
        approval_id: &str,
        response: ApprovalResponse,
    ) -> Result<ResolvedApproval, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let (run_id, _) = state
            .runs
            .iter()
            .find(|(_, run)| {
                run.pending_approval
                    .as_ref()
                    .is_some_and(|pending| pending.approval_id == approval_id)
            })
            .map(|(id, run)| (id.clone(), run.status))
            .ok_or_else(|| format!("no pending runbook approval: {approval_id}"))?;
        let run = state.runs.get_mut(&run_id).expect("found above");
        if run.status != RunStatus::WaitingApproval {
            return Err(format!("run {run_id} is not waiting for approval"));
        }
        let pending = run.pending_approval.take().expect("found above");
        let proposed = pending.command.clone();
        let executed = match response.decision {
            ApprovalDecision::Approve => Some(
                response
                    .edited_command
                    .filter(|command| !command.trim().is_empty())
                    .unwrap_or_else(|| proposed.clone()),
            ),
            ApprovalDecision::Decline => None,
        };
        let edited = executed.as_deref().is_some_and(|value| value != proposed);
        match response.decision {
            ApprovalDecision::Approve => run.status = RunStatus::Running,
            ApprovalDecision::Decline => {
                run.declined_commands.insert((
                    pending.step_id.clone(),
                    pending.phase,
                    command_fingerprint(&proposed),
                ));
                run.steps
                    .insert(pending.step_id.clone(), StepStatus::Paused);
                run.status = RunStatus::Paused;
                run.pause_reason = Some("operator declined the proposed command".into());
            }
        }
        Ok(ResolvedApproval {
            approval_id: pending.approval_id,
            run_id,
            step_id: pending.step_id,
            phase: pending.phase,
            proposed_command: proposed,
            executed_command: executed,
            decision: response.decision,
            actor: response.actor,
            reason: response.reason,
            edited,
        })
    }

    pub fn require_operator_decision(
        &self,
        run_id: &str,
        reason: &str,
    ) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = state
            .runs
            .get_mut(run_id)
            .ok_or_else(|| format!("unknown run: {run_id}"))?;
        if !matches!(run.status, RunStatus::Running | RunStatus::Paused) {
            return Err(format!(
                "run {run_id} cannot wait for an operator from {}",
                run.status
            ));
        }
        run.status = RunStatus::WaitingOperator;
        run.pause_reason = Some(reason.to_string());
        snapshot(&state, run_id)
    }

    pub fn resolve_operator_decision(
        &self,
        run_id: &str,
        decision: PauseDecision,
    ) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let release_session = {
            let run = state
                .runs
                .get_mut(run_id)
                .ok_or_else(|| format!("unknown run: {run_id}"))?;
            if !matches!(run.status, RunStatus::Paused | RunStatus::WaitingOperator) {
                return Err(format!("run {run_id} is not waiting for an operator"));
            }
            match decision {
                PauseDecision::Retry | PauseDecision::Skip | PauseDecision::Waive => {
                    run.status = RunStatus::Running;
                    run.pause_reason = None;
                    None
                }
                PauseDecision::Stop => {
                    run.status = RunStatus::Failed;
                    Some(run.target.session_id.clone())
                }
            }
        };
        if let Some(session) = release_session {
            state.session_locks.remove(&session);
        }
        snapshot(&state, run_id)
    }

    /// Settle the active failed/unknown step and resume sequential execution.
    ///
    /// Retry deliberately resets the step to `pending`: a fresh check is the
    /// reconciliation boundary even when the unknown command was an apply. It
    /// also clears declined-command fingerprints, but only after this explicit
    /// operator choice. Skip and waive remain unchecked terminal step states.
    pub fn resolve_step_decision(
        &self,
        run_id: &str,
        step_id: &str,
        decision: PauseDecision,
        waiver: Option<Waiver>,
    ) -> Result<RunSnapshot, String> {
        if decision == PauseDecision::Waive {
            waiver
                .as_ref()
                .ok_or("a waiver decision requires actor, reason and timestamp")?
                .validate()?;
        } else if waiver.is_some() {
            return Err("waiver metadata is only valid for a waiver decision".into());
        }

        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let release_session = {
            let run = state
                .runs
                .get_mut(run_id)
                .ok_or_else(|| format!("unknown run: {run_id}"))?;
            if !matches!(run.status, RunStatus::Paused | RunStatus::WaitingOperator) {
                return Err(format!("run {run_id} is not waiting for an operator"));
            }
            if run.active_step_id.as_deref() != Some(step_id) {
                return Err(format!(
                    "step {step_id} is not the active step for run {run_id}"
                ));
            }
            let current = *run
                .steps
                .get(step_id)
                .ok_or_else(|| format!("unknown step: {step_id}"))?;
            if !matches!(
                current,
                StepStatus::Paused
                    | StepStatus::Unknown
                    | StepStatus::NeedsAction
                    | StepStatus::Failed
                    | StepStatus::Blocked
            ) {
                return Err(format!(
                    "step {step_id} cannot be decided while it is {current}"
                ));
            }

            match decision {
                PauseDecision::Retry => {
                    run.steps.insert(step_id.to_string(), StepStatus::Pending);
                    run.waivers.remove(step_id);
                    run.declined_commands
                        .retain(|(declined_step, _, _)| declined_step != step_id);
                    run.status = RunStatus::Running;
                    run.active_step_id = None;
                    run.active_phase = None;
                    run.pause_reason = None;
                    None
                }
                PauseDecision::Skip => {
                    run.steps.insert(step_id.to_string(), StepStatus::Skipped);
                    run.waivers.remove(step_id);
                    run.status = RunStatus::Running;
                    run.active_step_id = None;
                    run.active_phase = None;
                    run.pause_reason = None;
                    None
                }
                PauseDecision::Waive => {
                    run.steps.insert(step_id.to_string(), StepStatus::Waived);
                    run.waivers
                        .insert(step_id.to_string(), waiver.expect("validated above"));
                    run.status = RunStatus::Running;
                    run.active_step_id = None;
                    run.active_phase = None;
                    run.pause_reason = None;
                    None
                }
                PauseDecision::Stop => {
                    run.steps.insert(step_id.to_string(), StepStatus::Failed);
                    run.status = RunStatus::Failed;
                    run.active_phase = None;
                    run.pause_reason = Some("operator stopped the run".into());
                    Some(run.target.session_id.clone())
                }
            }
        };
        if let Some(session) = release_session {
            state.session_locks.remove(&session);
        }
        snapshot(&state, run_id)
    }

    /// `onFailure: continue` records an unchecked failure and advances without
    /// relabelling it as an operator skip.
    pub fn continue_failed_step(&self, run_id: &str, step_id: &str) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = state
            .runs
            .get_mut(run_id)
            .ok_or_else(|| format!("unknown run: {run_id}"))?;
        if !matches!(run.status, RunStatus::Paused | RunStatus::WaitingOperator) {
            return Err(format!("run {run_id} is not paused after a failure"));
        }
        if run.active_step_id.as_deref() != Some(step_id) {
            return Err(format!(
                "step {step_id} is not the active step for run {run_id}"
            ));
        }
        let current = *run
            .steps
            .get(step_id)
            .ok_or_else(|| format!("unknown step: {step_id}"))?;
        if !matches!(
            current,
            StepStatus::Paused
                | StepStatus::Unknown
                | StepStatus::Blocked
                | StepStatus::NeedsAction
        ) {
            return Err(format!(
                "step {step_id} cannot continue as failed from {current}"
            ));
        }
        run.steps.insert(step_id.to_string(), StepStatus::Failed);
        run.waivers.remove(step_id);
        run.status = RunStatus::Running;
        run.active_step_id = None;
        run.active_phase = None;
        run.pause_reason = None;
        snapshot(&state, run_id)
    }

    /// Finish an assessment-only step whose check found work to do. The
    /// `needs_action` status is preserved so the final checklist remains
    /// unchecked and the run becomes `completed_with_exceptions` when required.
    pub fn continue_assessment_step(
        &self,
        run_id: &str,
        step_id: &str,
    ) -> Result<RunSnapshot, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = running_mut(&mut state, run_id)?;
        if run.active_step_id.as_deref() != Some(step_id) {
            return Err(format!(
                "step {step_id} is not the active step for run {run_id}"
            ));
        }
        let current = run
            .steps
            .get(step_id)
            .ok_or_else(|| format!("unknown step: {step_id}"))?;
        if *current != StepStatus::NeedsAction {
            return Err(format!(
                "assessment step {step_id} is {current}, not needs_action"
            ));
        }
        run.active_step_id = None;
        run.active_phase = None;
        snapshot(&state, run_id)
    }

    /// Re-check target identity immediately before every dispatch. Drift pauses
    /// the run and clears any approval tied to the old target.
    pub fn observe_target(&self, run_id: &str, observed: &TargetBinding) -> Result<bool, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let run = state
            .runs
            .get_mut(run_id)
            .ok_or_else(|| format!("unknown run: {run_id}"))?;
        if run.target.same_execution_context(observed) {
            run.target.cwd = observed.cwd.clone();
            run.target.observed_at = observed.observed_at.clone();
            return Ok(true);
        }
        if run.status.is_active() {
            run.status = RunStatus::Paused;
            run.pending_approval = None;
            if let Some(step_id) = &run.active_step_id {
                if run.steps.get(step_id).is_some_and(|status| {
                    matches!(
                        status,
                        StepStatus::Checking | StepStatus::Applying | StepStatus::Verifying
                    )
                }) {
                    run.steps.insert(step_id.clone(), StepStatus::Unknown);
                }
            }
            run.active_phase = None;
            run.pause_reason = Some("terminal target or remote context changed".into());
        }
        Ok(false)
    }

    pub fn interrupt_all(&self) -> Result<Vec<String>, String> {
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        let mut interrupted = Vec::new();
        for (run_id, run) in &mut state.runs {
            if run.status.is_active() {
                run.status = RunStatus::Interrupted;
                run.pending_approval = None;
                run.pause_reason = Some("application process ended during the run".into());
                interrupted.push(run_id.clone());
            }
        }
        state.session_locks.clear();
        Ok(interrupted)
    }

    pub fn rebind_interrupted(
        &self,
        run_id: &str,
        target: TargetBinding,
        operator_confirmed: bool,
    ) -> Result<RunSnapshot, String> {
        if !operator_confirmed {
            return Err("explicit operator confirmation is required to rebind a run".into());
        }
        let mut state = self.inner.lock().map_err(|_| "run coordinator poisoned")?;
        if let Some(owner) = state.session_locks.get(&target.session_id) {
            if owner != run_id {
                return Err(format!(
                    "terminal session {} is already owned by run {owner}",
                    target.session_id
                ));
            }
        }
        let run = state
            .runs
            .get_mut(run_id)
            .ok_or_else(|| format!("unknown run: {run_id}"))?;
        if run.status != RunStatus::Interrupted {
            return Err(format!("run {run_id} is not interrupted"));
        }
        run.target = target.clone();
        run.status = RunStatus::Ready;
        run.pause_reason = None;
        state
            .session_locks
            .insert(target.session_id, run_id.to_string());
        snapshot(&state, run_id)
    }
}

fn running_mut<'a>(
    state: &'a mut CoordinatorState,
    run_id: &str,
) -> Result<&'a mut ManagedRun, String> {
    let run = state
        .runs
        .get_mut(run_id)
        .ok_or_else(|| format!("unknown run: {run_id}"))?;
    if run.status != RunStatus::Running {
        return Err(format!(
            "run {run_id} is not running (it is {})",
            run.status
        ));
    }
    Ok(run)
}

fn snapshot(state: &CoordinatorState, run_id: &str) -> Result<RunSnapshot, String> {
    let run = state
        .runs
        .get(run_id)
        .ok_or_else(|| format!("unknown run: {run_id}"))?;
    Ok(RunSnapshot {
        run_id: run_id.to_string(),
        status: run.status,
        target: run.target.clone(),
        active_step_id: run.active_step_id.clone(),
        active_phase: run.active_phase,
        pending_approval_id: run
            .pending_approval
            .as_ref()
            .map(|approval| approval.approval_id.clone()),
        pause_reason: run.pause_reason.clone(),
        steps: run
            .step_order
            .iter()
            .map(|id| StepSnapshot {
                id: id.clone(),
                status: *run
                    .steps
                    .get(id)
                    .expect("step order and map are created together"),
                waiver: run.waivers.get(id).cloned(),
            })
            .collect(),
    })
}

fn command_fingerprint(command: &str) -> String {
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = Sha256::digest(normalized.as_bytes());
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// Pending approval responses. Kept separate from the normal AI approval map so
/// `Auto all` and cancelling an AI request cannot settle a runbook gate.
#[derive(Default)]
pub struct RunbookApprovalState {
    pending: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<ApprovalResponse>)>>,
}

impl RunbookApprovalState {
    pub fn register(
        &self,
        approval_id: &str,
        run_id: &str,
    ) -> Result<tokio::sync::oneshot::Receiver<ApprovalResponse>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "runbook approvals poisoned")?;
        if pending.contains_key(approval_id) {
            return Err(format!("approval already pending: {approval_id}"));
        }
        pending.insert(approval_id.to_string(), (run_id.to_string(), tx));
        Ok(rx)
    }

    pub fn respond(&self, approval_id: &str, response: ApprovalResponse) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "runbook approvals poisoned")?
            .remove(approval_id)
            .map(|(_, tx)| tx)
            .ok_or_else(|| format!("no pending runbook approval: {approval_id}"))?;
        sender
            .send(response)
            .map_err(|_| "runbook approval waiter ended".to_string())
    }

    pub fn drain_run(&self, run_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, (owner, _)| owner != run_id);
        }
    }
}

struct PendingPtyAttempt {
    run_id: String,
    claimed: bool,
    expires_at: std::time::Instant,
    sender: tokio::sync::oneshot::Sender<ObservedPtyResult>,
}

#[derive(Default)]
pub struct RunbookPtyState {
    pending: Mutex<HashMap<String, PendingPtyAttempt>>,
}

/// Operator responses to explicit manual actions. This is separate from pause
/// decisions because a manual check/apply/verify is definition-authored work,
/// not error recovery.
#[derive(Default)]
pub struct RunbookManualState {
    pending: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<ManualResponse>)>>,
}

impl RunbookManualState {
    pub fn register(
        &self,
        request_id: &str,
        run_id: &str,
    ) -> Result<tokio::sync::oneshot::Receiver<ManualResponse>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "runbook manual state poisoned")?;
        if pending.contains_key(request_id) {
            return Err(format!("manual action already pending: {request_id}"));
        }
        pending.insert(request_id.to_string(), (run_id.to_string(), tx));
        Ok(rx)
    }

    pub fn respond(&self, request_id: &str, response: ManualResponse) -> Result<(), String> {
        response.validate()?;
        let sender = self
            .pending
            .lock()
            .map_err(|_| "runbook manual state poisoned")?
            .remove(request_id)
            .map(|(_, tx)| tx)
            .ok_or_else(|| format!("no pending manual action: {request_id}"))?;
        sender
            .send(response)
            .map_err(|_| "runbook manual-action waiter ended".to_string())
    }

    pub fn drain_run(&self, run_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, (owner, _)| owner != run_id);
        }
    }
}

impl RunbookPtyState {
    pub fn register(
        &self,
        attempt_id: &str,
        run_id: &str,
        claim_timeout: std::time::Duration,
    ) -> Result<tokio::sync::oneshot::Receiver<ObservedPtyResult>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "runbook PTY state poisoned")?;
        if pending.contains_key(attempt_id) {
            return Err(format!("terminal attempt already pending: {attempt_id}"));
        }
        pending.insert(
            attempt_id.to_string(),
            PendingPtyAttempt {
                run_id: run_id.to_string(),
                claimed: false,
                expires_at: std::time::Instant::now() + claim_timeout,
                sender: tx,
            },
        );
        Ok(rx)
    }

    /// Atomically lease this dispatch to one webview handler. A replayed
    /// RunInTerminal event cannot type the same mutation again, even when the
    /// frontend's in-memory state was lost during a webview recovery.
    pub fn claim_dispatch(&self, attempt_id: &str, run_id: &str) -> Result<bool, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "runbook PTY state poisoned")?;
        let Some(attempt) = pending.get_mut(attempt_id) else {
            return Ok(false);
        };
        if attempt.run_id != run_id {
            return Err("terminal attempt belongs to a different run".into());
        }
        if std::time::Instant::now() >= attempt.expires_at {
            pending.remove(attempt_id);
            return Ok(false);
        }
        if attempt.claimed {
            return Ok(false);
        }
        attempt.claimed = true;
        Ok(true)
    }

    pub fn respond(&self, attempt_id: &str, result: ObservedPtyResult) -> Result<(), String> {
        let sender = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "runbook PTY state poisoned")?;
            let attempt = pending
                .get(attempt_id)
                .ok_or_else(|| format!("no pending runbook terminal attempt: {attempt_id}"))?;
            if !attempt.claimed {
                return Err(format!(
                    "terminal attempt {attempt_id} has not acquired its one-time dispatch lease"
                ));
            }
            pending
                .remove(attempt_id)
                .expect("pending terminal attempt was checked above")
                .sender
        };
        sender
            .send(result)
            .map_err(|_| "runbook terminal waiter ended".to_string())
    }

    pub fn drain_run(&self, run_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, attempt| attempt.run_id != run_id);
        }
    }

    /// Cancel-side linearization point shared with `claim_dispatch`. Once this
    /// returns, a frontend still waiting on prompt detection cannot acquire a
    /// stale lease for the cancelled run.
    pub fn cancel_run(&self, run_id: &str) {
        self.drain_run(run_id);
    }

    /// Feature-disable linearization point. Drop every terminal sender under
    /// the same mutex used by `claim_dispatch`, so no later claim can succeed.
    pub fn cancel_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}

/// Cancellation registry intentionally independent of the AI stream registry.
pub struct RunbookCancellationState {
    inner: Mutex<RunbookCancellationInner>,
}

#[derive(Default)]
struct RunbookCancellationInner {
    pending: HashMap<String, tokio::sync::watch::Sender<bool>>,
    pre_cancelled: HashSet<String>,
    accepting: bool,
}

impl Default for RunbookCancellationState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RunbookCancellationInner {
                pending: HashMap::new(),
                pre_cancelled: HashSet::new(),
                accepting: true,
            }),
        }
    }
}

impl RunbookCancellationState {
    pub fn register(&self, run_id: &str) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "runbook cancellation state poisoned")?;
        if inner.pending.contains_key(run_id) {
            return Err(format!("run cancellation already registered: {run_id}"));
        }
        let cancelled = !inner.accepting || inner.pre_cancelled.remove(run_id);
        let (tx, rx) = tokio::sync::watch::channel(cancelled);
        inner.pending.insert(run_id.to_string(), tx);
        Ok(rx)
    }

    pub fn cancel(&self, run_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(sender) = inner.pending.remove(run_id) {
                let _ = sender.send(true);
            } else {
                inner.pre_cancelled.insert(run_id.to_string());
            }
        }
    }

    /// Stop every in-process run when the experimental feature is disabled.
    /// Receivers observe cancellation before another terminal dispatch.
    pub fn cancel_all(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.accepting = false;
            for (_, sender) in inner.pending.drain() {
                let _ = sender.send(true);
            }
        }
    }

    /// Re-open registration after the user explicitly enables Runbooks again.
    pub fn enable(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.accepting = true;
            inner.pre_cancelled.clear();
        }
    }

    pub fn finish(&self, run_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending.remove(run_id);
            inner.pre_cancelled.remove(run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(session: &str, remote: &str) -> TargetBinding {
        TargetBinding {
            kind: "active-terminal".into(),
            session_id: session.into(),
            shell: Some("zsh".into()),
            cwd: Some("/srv".into()),
            remote_kind: Some("ssh".into()),
            remote_target: Some(remote.into()),
            context_marker: Some(format!("ctx-{remote}")),
            observed_at: "now".into(),
        }
    }

    fn running(coordinator: &RunCoordinator) {
        coordinator
            .register_run("r1", target("s1", "prod"), &["step1".into()])
            .unwrap();
        coordinator.transition_run("r1", RunStatus::Ready).unwrap();
        coordinator
            .transition_run("r1", RunStatus::Running)
            .unwrap();
    }

    #[test]
    fn one_terminal_cannot_be_driven_by_two_runs() {
        let coordinator = RunCoordinator::default();
        coordinator
            .register_run("r1", target("s1", "prod"), &["one".into()])
            .unwrap();
        let error = coordinator
            .register_run("r2", target("s1", "prod"), &["one".into()])
            .unwrap_err();
        assert!(error.contains("already owned"));
        coordinator
            .transition_run("r1", RunStatus::Cancelled)
            .unwrap();
        coordinator
            .register_run("r2", target("s1", "prod"), &["one".into()])
            .unwrap();
    }

    #[test]
    fn agent_cannot_complete_wrong_phase_or_skip_verify() {
        let coordinator = RunCoordinator::default();
        running(&coordinator);
        coordinator
            .begin_phase("r1", "step1", RunbookPhase::Check)
            .unwrap();
        let wrong = PhaseCompletion {
            run_id: "r1".into(),
            step_id: "step1".into(),
            phase: RunbookPhase::Apply,
            result: PhaseResult::Applied,
            assurance: None,
            summary: "changed".into(),
        };
        assert!(coordinator.complete_phase(&wrong).is_err());

        let compliant = PhaseCompletion {
            phase: RunbookPhase::Check,
            result: PhaseResult::Noncompliant,
            ..wrong.clone()
        };
        coordinator.complete_phase(&compliant).unwrap();
        coordinator
            .begin_phase("r1", "step1", RunbookPhase::Apply)
            .unwrap();
        let applied = PhaseCompletion {
            phase: RunbookPhase::Apply,
            result: PhaseResult::Applied,
            ..wrong
        };
        let snapshot = coordinator.complete_phase(&applied).unwrap();
        assert_eq!(snapshot.steps[0].status, StepStatus::Verifying);
        assert!(!snapshot.steps[0].status.is_checked());
    }

    #[test]
    fn mutations_are_always_approval_gated_and_decline_pauses() {
        let coordinator = RunCoordinator::default();
        running(&coordinator);
        coordinator
            .begin_phase("r1", "step1", RunbookPhase::Check)
            .unwrap();
        coordinator
            .complete_phase(&PhaseCompletion {
                run_id: "r1".into(),
                step_id: "step1".into(),
                phase: RunbookPhase::Check,
                result: PhaseResult::Noncompliant,
                assurance: Some(VerificationAssurance::DeterministicShell),
                summary: "needs change".into(),
            })
            .unwrap();
        coordinator
            .begin_phase("r1", "step1", RunbookPhase::Apply)
            .unwrap();
        let request = ApprovalRequest {
            approval_id: "a1".into(),
            run_id: "r1".into(),
            step_id: "step1".into(),
            phase: RunbookPhase::Apply,
            command: "sed -i change /etc/file".into(),
            explanation: "apply baseline".into(),
            read_only: true, // classifier mistakes do not bypass apply approval
            network: false,
            privileged: false,
            opaque: false,
        };
        assert!(request.requires_approval());
        coordinator.request_approval(request).unwrap();
        let result = coordinator
            .resolve_approval(
                "a1",
                ApprovalResponse {
                    decision: ApprovalDecision::Decline,
                    actor: "operator".into(),
                    reason: Some("wrong target".into()),
                    edited_command: None,
                },
            )
            .unwrap();
        assert_eq!(result.decision, ApprovalDecision::Decline);
        assert_eq!(
            coordinator.snapshot("r1").unwrap().status,
            RunStatus::Paused
        );
    }

    #[test]
    fn target_drift_pauses_before_dispatch() {
        let coordinator = RunCoordinator::default();
        running(&coordinator);
        assert!(!coordinator
            .observe_target("r1", &target("s1", "staging"))
            .unwrap());
        let snapshot = coordinator.snapshot("r1").unwrap();
        assert_eq!(snapshot.status, RunStatus::Paused);
        assert!(snapshot.pause_reason.unwrap().contains("changed"));
    }

    #[test]
    fn interrupted_run_requires_confirmation_and_rebind_before_running() {
        let coordinator = RunCoordinator::default();
        running(&coordinator);
        assert_eq!(coordinator.interrupt_all().unwrap(), vec!["r1"]);
        assert!(coordinator
            .rebind_interrupted("r1", target("s2", "prod"), false)
            .is_err());
        let rebound = coordinator
            .rebind_interrupted("r1", target("s2", "prod"), true)
            .unwrap();
        assert_eq!(rebound.status, RunStatus::Ready);
    }

    #[test]
    fn explicit_retry_clears_decline_and_reconciles_with_a_fresh_check() {
        let coordinator = RunCoordinator::default();
        running(&coordinator);
        coordinator
            .begin_phase("r1", "step1", RunbookPhase::Check)
            .unwrap();
        let request = ApprovalRequest {
            approval_id: "a1".into(),
            run_id: "r1".into(),
            step_id: "step1".into(),
            phase: RunbookPhase::Check,
            command: "curl -fsS https://example.test/status".into(),
            explanation: "networked check".into(),
            read_only: true,
            network: true,
            privileged: false,
            opaque: false,
        };
        coordinator.request_approval(request.clone()).unwrap();
        coordinator
            .resolve_approval(
                "a1",
                ApprovalResponse {
                    decision: ApprovalDecision::Decline,
                    actor: "operator".into(),
                    reason: Some("review target first".into()),
                    edited_command: None,
                },
            )
            .unwrap();
        assert_eq!(
            coordinator.snapshot("r1").unwrap().steps[0].status,
            StepStatus::Paused
        );

        let retried = coordinator
            .resolve_step_decision("r1", "step1", PauseDecision::Retry, None)
            .unwrap();
        assert_eq!(retried.status, RunStatus::Running);
        assert_eq!(retried.steps[0].status, StepStatus::Pending);
        assert!(retried.active_step_id.is_none());

        coordinator
            .begin_phase("r1", "step1", RunbookPhase::Check)
            .unwrap();
        coordinator
            .request_approval(ApprovalRequest {
                approval_id: "a2".into(),
                ..request
            })
            .expect("explicit retry permits the same command to be proposed again");
    }

    #[test]
    fn cancellation_is_sticky_before_registration_and_while_disabled() {
        let cancellations = RunbookCancellationState::default();
        cancellations.cancel("before-register");
        assert!(*cancellations.register("before-register").unwrap().borrow());

        cancellations.cancel_all();
        assert!(*cancellations.register("while-disabled").unwrap().borrow());
        cancellations.enable();
        assert!(!*cancellations.register("after-enable").unwrap().borrow());
    }

    #[test]
    fn aborting_a_run_releases_its_terminal_lock() {
        let coordinator = RunCoordinator::default();
        coordinator
            .register_run("r1", target("s1", "prod"), &["one".into()])
            .unwrap();
        coordinator.abort_run("r1", "startup failed").unwrap();
        coordinator
            .register_run("r2", target("s1", "prod"), &["one".into()])
            .expect("the terminal lock must be released");
    }

    #[test]
    fn restored_runs_reject_inflight_steps_and_keep_durable_outcomes() {
        let coordinator = RunCoordinator::default();
        assert!(coordinator
            .register_restored_run(
                "bad",
                target("s1", "prod"),
                &[("one".into(), StepStatus::Applying)],
            )
            .is_err());

        let snapshot = coordinator
            .register_restored_run(
                "restored",
                target("s1", "prod"),
                &[
                    ("done".into(), StepStatus::AlreadyCompliant),
                    ("uncertain".into(), StepStatus::Unknown),
                ],
            )
            .unwrap();
        assert_eq!(snapshot.status, RunStatus::Ready);
        assert_eq!(snapshot.steps[0].status, StepStatus::AlreadyCompliant);
        assert_eq!(snapshot.steps[1].status, StepStatus::Unknown);
    }

    #[test]
    fn one_terminal_dispatch_can_only_be_claimed_once() {
        let state = RunbookPtyState::default();
        let _receiver = state
            .register("attempt-1", "run-1", std::time::Duration::from_secs(60))
            .unwrap();
        assert!(state.claim_dispatch("attempt-1", "run-1").unwrap());
        assert!(!state.claim_dispatch("attempt-1", "run-1").unwrap());
        assert!(state.claim_dispatch("attempt-1", "other-run").is_err());
    }

    #[test]
    fn expired_terminal_dispatch_cannot_be_claimed() {
        let state = RunbookPtyState::default();
        let _receiver = state
            .register("attempt-expired", "run-1", std::time::Duration::ZERO)
            .unwrap();
        assert!(!state.claim_dispatch("attempt-expired", "run-1").unwrap());
        assert!(!state.claim_dispatch("attempt-expired", "run-1").unwrap());
    }

    #[test]
    fn terminal_result_requires_claim_and_unclaimed_attempt_remains_pending() {
        let state = RunbookPtyState::default();
        let mut receiver = state
            .register("attempt-1", "run-1", std::time::Duration::from_secs(60))
            .unwrap();
        let result = ObservedPtyResult {
            exit_code: Some(0),
            output_tail: "ok".into(),
            output_truncated: false,
            output_observed_bytes: 2,
            output_captured_bytes: 2,
            duration_ms: 1,
            error: None,
        };

        assert!(state.respond("attempt-1", result.clone()).is_err());
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(state.claim_dispatch("attempt-1", "run-1").unwrap());
        state.respond("attempt-1", result.clone()).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), result);
    }
}
