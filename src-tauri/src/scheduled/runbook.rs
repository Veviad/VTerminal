//! Scheduled runbooks reuse the native check/apply/verify engine and its durable
//! report, with captured subprocesses instead of a user-owned interactive PTY.
//! The saved digest, resolved inputs and explicit approval policy are the grant.

use super::types::{
    RunbookApprovalPolicy, ScheduledAction, ScheduledActionInput, ScheduledRunStatus,
    ScheduledTarget,
};
use crate::agent::run::CommandWrapper;
use crate::database::DbState;
use crate::runbooks::{db as runbook_db, engine, package, runtime, state};
use std::sync::{Arc, Mutex};
use tauri::{Manager, Wry};

pub fn validate_package(
    conn: &rusqlite::Connection,
    input: &ScheduledActionInput,
) -> Result<package::ValidatedPackage, String> {
    let reference = input.runbook.as_ref().ok_or("no runbook selected")?;
    let source = runbook_db::get_source(conn, &reference.source_id)?
        .ok_or("the selected runbook no longer exists")?;
    if source.hidden || !source.valid {
        return Err(
            "the selected runbook is unavailable or invalid; refresh it in the library".into(),
        );
    }
    let package = package::load_package(&source.package_path).map_err(|e| e.to_string())?;
    if package.root.to_str() != Some(source.package_path.as_str())
        || package.definition.metadata.id != source.definition_id
        || package.definition.metadata.version != source.definition_version
        || package.snapshot.canonical_sha256 != reference.canonical_sha256
        || source.canonical_sha256 != reference.canonical_sha256
        || source.source_sha256 != package.snapshot.source_sha256
    {
        return Err("the runbook changed after it was selected; review and select its current version before saving or running".into());
    }
    if package.definition.spec.target.kind
        != crate::runbooks::definition::TargetKind::ActiveTerminal
    {
        return Err("scheduled runbooks currently require an active-terminal definition; Ansible inventory runs are not supported".into());
    }
    let inputs = package
        .definition
        .resolve_inputs(&reference.inputs)
        .map_err(|errors| format!("invalid runbook inputs: {errors:?}"))?;
    let serialized = serde_json::to_string(&inputs).map_err(|e| e.to_string())?;
    if crate::runbooks::redact::redact_sensitive(&serialized).1 {
        return Err("runbook inputs contain sensitive values; use environment or credential references instead".into());
    }
    Ok(package)
}

#[derive(Default)]
struct Runtime {
    coordinator: runtime::RunCoordinator,
    approvals: runtime::RunbookApprovalState,
    pty: runtime::RunbookPtyState,
    manual: runtime::RunbookManualState,
    manual_index: engine::RunbookManualIndex,
    decisions: engine::RunbookDecisionState,
    cancellations: runtime::RunbookCancellationState,
    commands_executed: std::sync::atomic::AtomicU32,
    commands_blocked: std::sync::atomic::AtomicU32,
}

struct EventQueue(tokio::sync::mpsc::UnboundedSender<runtime::RunbookEvent>);
impl engine::RunbookEventSink for EventQueue {
    fn emit(&self, event: runtime::RunbookEvent) {
        let _ = self.0.send(event);
    }
}
struct FixedTarget(state::TargetBinding);
impl engine::TargetObserver for FixedTarget {
    fn observe(&self, session_id: &str) -> Result<state::TargetBinding, String> {
        if self.0.session_id() != Some(session_id) {
            return Err("scheduled target identity changed".into());
        }
        Ok(self.0.clone())
    }
}

fn may_approve(
    policy: RunbookApprovalPolicy,
    read_only: bool,
    network: bool,
    privileged: bool,
    opaque: bool,
) -> bool {
    match policy {
        RunbookApprovalPolicy::None => false,
        RunbookApprovalPolicy::ReadOnly => read_only && !network && !privileged && !opaque,
        RunbookApprovalPolicy::All => true,
    }
}

/// A user deny can name either the exact transport wrapper or its semantic
/// subject. Unwrapping must never erase either kind of prohibition.
fn denied_by_rules(
    command: &str,
    scope: &str,
    rules: &[crate::agent::policy::CommandPolicyRule],
) -> bool {
    [
        command.to_string(),
        engine::captured_command_subject(command),
    ]
    .iter()
    .any(|subject| {
        crate::agent::policy::evaluate_rules(subject, scope, rules).0
            == crate::agent::policy::RuleDecision::Deny
    })
}

fn rules_require_review(
    command: &str,
    scope: &str,
    rules: &[crate::agent::policy::CommandPolicyRule],
    policy: RunbookApprovalPolicy,
) -> bool {
    denied_by_rules(command, scope, rules)
        || (policy != RunbookApprovalPolicy::All
            && [
                command.to_string(),
                engine::captured_command_subject(command),
            ]
            .iter()
            .any(|subject| {
                crate::agent::policy::evaluate_rules(subject, scope, rules).0
                    == crate::agent::policy::RuleDecision::Ask
            }))
}

/// Drive one immutable runbook; the schedule's own history references the full
/// native report, so failures retain command evidence and per-phase outcomes.
pub async fn execute(
    app: &tauri::AppHandle<Wry>,
    schedule_run_id: &str,
    action: &ScheduledAction,
    mut external_cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<ScheduledRunStatus, String> {
    if !crate::commands::settings::read_bool(app, "runbooks_enabled", false) {
        return Err("runbooks are switched off in Settings → Runbooks".into());
    }
    if *external_cancel.borrow() {
        return Ok(ScheduledRunStatus::Cancelled);
    }
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(u64::from(action.input.max_run_secs));
    let reference = action.input.runbook.as_ref().ok_or("no runbook selected")?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let database = DbState(Mutex::new(crate::database::open_hardened(
        &app_data,
        "veviad-shell.db",
    )?));
    let (package, remote) = {
        let conn = database.0.lock().map_err(|_| "runbook database poisoned")?;
        // Revalidate at dispatch, even for a run that spent time in the queue.
        let package = validate_package(&conn, &action.input)?;
        let host_facts = action
            .input
            .target
            .host_id()
            .and_then(|id| super::runner::host_facts(&conn, id));
        super::validate::check_before_fire(
            &action.input,
            &action.steps_sha256,
            &super::db::action_fingerprint(&action.input),
            action.armed_at.as_deref(),
            host_facts.as_ref(),
        )?;
        let remote = match &action.input.target {
            ScheduledTarget::LocalShell { cwd } => {
                if cwd
                    .as_deref()
                    .is_some_and(|dir| !std::path::Path::new(dir).is_dir())
                {
                    return Err("the scheduled working directory no longer exists".into());
                }
                None
            }
            ScheduledTarget::SshHost { host_id } => {
                let host = crate::database::queries::get_ssh_host(&conn, host_id)?
                    .ok_or("the scheduled SSH host no longer exists")?;
                Some(super::ssh::RemoteBatchTarget::from_host(&host))
            }
        };
        (package, remote)
    };
    let inputs = package
        .definition
        .resolve_inputs(&reference.inputs)
        .map_err(|errors| format!("invalid runbook inputs: {errors:?}"))?;
    let target = state::TargetBinding::active_terminal(
        format!("schedule:{schedule_run_id}"),
        remote.is_none().then(|| "/bin/sh".into()),
        action.input.target.local_cwd().map(str::to_string),
        remote.as_ref().map(|_| "ssh".into()),
        remote.as_ref().map(|target| target.target()),
        Some(format!("scheduled:{}", action.steps_sha256)),
        super::db::now_rfc3339(),
    );
    let model = crate::commands::ai::active_model(app);
    let requires_model = package.definition.spec.steps.iter().any(|step| {
        use crate::runbooks::definition::{ApplyAction, CheckAction, VerifyAction};
        matches!(&step.check, Some(CheckAction::Agent { .. }))
            || matches!(&step.apply, Some(ApplyAction::Agent { .. }))
            || matches!(&step.verify, Some(VerifyAction::Agent { .. }))
    });
    let resolved = if requires_model {
        Some(tokio::select! {
            provider = crate::commands::ai::resolve_provider_for_model(app, model) => provider?,
            _ = external_cancel.changed() => return Ok(ScheduledRunStatus::Cancelled),
            _ = tokio::time::sleep_until(deadline) => return Err("scheduled runbook exceeded its time budget while preparing the model".into()),
        })
    } else {
        None
    };
    if *external_cancel.borrow() {
        return Ok(ScheduledRunStatus::Cancelled);
    }
    let recording_policy = crate::commands::settings::read_string(app, "runbooks_output_recording")
        .and_then(|value| value.parse::<state::EvidenceRecordingPolicy>().ok())
        .unwrap_or_default();
    let evidence = recording_policy.floor(
        package
            .definition
            .spec
            .audit
            .as_ref()
            .and_then(|audit| audit.record_output),
    );
    let creation = runbook_db::RunCreation {
        source_id: Some(reference.source_id.clone()),
        definition_id: package.definition.metadata.id.clone(),
        definition_version: package.definition.metadata.version.clone(),
        definition_title: package.definition.metadata.title.clone(),
        source_yaml: package.snapshot.source_yaml.clone(),
        canonical_json: package.snapshot.canonical_json.clone(),
        source_sha256: package.snapshot.source_sha256.clone(),
        canonical_sha256: package.snapshot.canonical_sha256.clone(),
        target: target.clone(),
        inputs: serde_json::to_value(&inputs).map_err(|e| e.to_string())?,
        evidence_mode: evidence,
        app_version: env!("CARGO_PKG_VERSION").into(),
        model: requires_model.then(|| model.id.to_string()),
        steps: package
            .definition
            .spec
            .steps
            .iter()
            .map(|step| runbook_db::StepSeed {
                id: step.id.clone(),
                title: step.title.clone(),
                required: step.required,
            })
            .collect(),
    };
    let record = {
        let mut conn = database.0.lock().map_err(|_| "runbook database poisoned")?;
        runbook_db::create_run(&mut conn, &creation)?
    };
    let runbook_id = record.id.clone();
    let mut summary_attempt =
        create_summary(&database, schedule_run_id, &runbook_id, &record.created_at)?;
    let started = std::time::Instant::now();
    let spec = engine::EngineRunSpec {
        run_id: runbook_id.clone(),
        definition: package.definition,
        definition_snapshot: package.snapshot,
        package_root: Some(package.root),
        target: target.clone(),
        inputs,
        evidence_mode: evidence,
        app_version: creation.app_version,
        model: creation.model,
        created_at: record.created_at,
    };
    let state = Arc::new(Runtime::default());
    let failure = Arc::new(Mutex::new(None::<String>));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let events = EventQueue(tx);
    let observer = FixedTarget(target);
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let worker = tauri::async_runtime::spawn(drive_events(
        app.clone(),
        action.clone(),
        runbook_id.clone(),
        state.clone(),
        failure.clone(),
        remote,
        rx,
        cancel_rx,
    ));
    let watch_state = state.clone();
    let watch_id = runbook_id.clone();
    let max_run_secs = action.input.max_run_secs;
    let timeout_failure = failure.clone();
    let watch_app = app.clone();
    let watcher = tauri::async_runtime::spawn(async move {
        let mut settings_poll = tokio::time::interval(std::time::Duration::from_secs(1));
        let reason = loop {
            if *external_cancel.borrow() {
                break None;
            }
            tokio::select! {
                _ = external_cancel.changed() => break None,
                _ = tokio::time::sleep_until(deadline) => break Some(format!("scheduled runbook exceeded its {max_run_secs}s budget")),
                _ = settings_poll.tick() => {
                    if !crate::commands::settings::read_bool(&watch_app, "runbooks_enabled", false) {
                        break Some("runbooks were switched off during execution".into());
                    }
                }
            }
        };
        if let Some(reason) = reason {
            if let Ok(mut failure) = timeout_failure.lock() {
                *failure = Some(reason);
            }
        }
        let _ = cancel_tx.send(true);
        watch_state.cancellations.cancel(&watch_id);
    });
    let context = engine::EngineContext {
        coordinator: &state.coordinator,
        approvals: &state.approvals,
        pty: &state.pty,
        manual: &state.manual,
        manual_index: &state.manual_index,
        decisions: &state.decisions,
        cancellations: &state.cancellations,
        events: &events,
        database: Some(&database),
        evidence_root: Some(&app_data),
        provider: resolved
            .as_ref()
            .map(|p| p.provider.as_ref() as &dyn crate::provider::Provider),
        target_observer: &observer,
        config: engine::EngineConfig {
            command_timeout_secs: u64::from(action.input.command_timeout_secs),
            response_timeout_secs: 10,
            agent_max_iterations: action.input.max_iterations,
            ..Default::default()
        },
    };
    let result = engine::execute_runbook(&context, spec).await;
    // Let captured commands observe cancellation and reap their process group
    // before releasing the scheduler's concurrency slot.
    drop(context);
    drop(events);
    let _ = worker.await;
    watcher.abort();
    let reason = failure.lock().ok().and_then(|reason| reason.clone());
    let native_status = result
        .as_ref()
        .map(|report| report.status)
        .unwrap_or(state::RunStatus::Failed);
    summary_attempt.status = match native_status {
        state::RunStatus::Succeeded => super::types::StepAttemptStatus::Succeeded,
        state::RunStatus::Cancelled => super::types::StepAttemptStatus::Cancelled,
        _ => super::types::StepAttemptStatus::Failed,
    };
    summary_attempt.commands_executed = state
        .commands_executed
        .load(std::sync::atomic::Ordering::Relaxed);
    summary_attempt.commands_blocked = state
        .commands_blocked
        .load(std::sync::atomic::Ordering::Relaxed);
    summary_attempt.termination = Some(native_status.to_string());
    summary_attempt.error = reason.clone().or_else(|| result.as_ref().err().cloned());
    summary_attempt.finished_at = Some(super::db::now_rfc3339());
    summary_attempt.duration_ms = Some(started.elapsed().as_millis().min(i64::MAX as u128) as i64);
    {
        let conn = database
            .0
            .lock()
            .map_err(|_| "schedule database poisoned")?;
        super::db::finish_attempt(&conn, &summary_attempt)?;
    }
    let report = result?;
    if let Some(reason) = reason {
        return Err(format!("{reason}. Runbook report: {runbook_id}"));
    }
    match report.status {
        state::RunStatus::Succeeded => Ok(ScheduledRunStatus::Succeeded),
        state::RunStatus::Cancelled => Ok(ScheduledRunStatus::Cancelled),
        other => Err(format!("runbook finished as {other}; report: {runbook_id}")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_events(
    app: tauri::AppHandle<Wry>,
    action: ScheduledAction,
    run_id: String,
    state: Arc<Runtime>,
    failure: Arc<Mutex<Option<String>>>,
    remote: Option<super::ssh::RemoteBatchTarget>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<runtime::RunbookEvent>,
    cancel: tokio::sync::watch::Receiver<bool>,
) {
    let policy = action
        .input
        .runbook
        .as_ref()
        .expect("runbook present")
        .approval;
    while let Some(event) = events.recv().await {
        match event {
            runtime::RunbookEvent::ApprovalRequested {
                approval_id,
                command,
                ..
            } => {
                let class = engine::classify_captured_command(&command);
                let rules = crate::commands::settings::read_command_policy_rules(&app);
                let denied = rules_require_review(
                    &command,
                    &action.input.target.policy_scope(),
                    &rules,
                    policy,
                );
                let allowed = may_approve(
                    policy,
                    class.read_only,
                    class.network,
                    class.privileged,
                    class.opaque,
                ) && !denied;
                let reason = if allowed {
                    "approved by the scheduled runbook policy"
                } else {
                    "the scheduled runbook policy or a saved deny rule requires operator review"
                };
                if !allowed {
                    state
                        .commands_blocked
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if let Ok(mut failure) = failure.lock() {
                        *failure = Some(reason.into());
                    }
                }
                let _ = state.approvals.respond(
                    &approval_id,
                    runtime::ApprovalResponse {
                        decision: if allowed {
                            state::ApprovalDecision::Approve
                        } else {
                            state::ApprovalDecision::Decline
                        },
                        actor: format!("schedule:{}", action.id),
                        reason: Some(reason.into()),
                        edited_command: None,
                    },
                );
            }
            runtime::RunbookEvent::RunInTerminal {
                attempt_id,
                command,
                timeout_secs,
                ..
            } => {
                if !state
                    .pty
                    .claim_dispatch(&attempt_id, &run_id)
                    .unwrap_or(false)
                {
                    continue;
                }
                let rules = crate::commands::settings::read_command_policy_rules(&app);
                let denied = rules_require_review(
                    &command,
                    &action.input.target.policy_scope(),
                    &rules,
                    policy,
                );
                let dispatch_refusal = if *cancel.borrow() {
                    Some("the scheduled runbook was cancelled before command dispatch")
                } else if !crate::commands::settings::read_bool(&app, "runbooks_enabled", false) {
                    Some("runbooks were switched off before command dispatch")
                } else if denied {
                    Some("a saved deny rule blocked this scheduled runbook command")
                } else {
                    None
                };
                if let Some(reason) = dispatch_refusal {
                    state
                        .commands_blocked
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if !*cancel.borrow() {
                        if let Ok(mut failure) = failure.lock() {
                            *failure = Some(reason.into());
                        }
                    }
                    let _ = state.pty.respond(
                        &attempt_id,
                        runtime::ObservedPtyResult {
                            exit_code: None,
                            output_tail: String::new(),
                            output_truncated: false,
                            output_observed_bytes: 0,
                            output_captured_bytes: 0,
                            duration_ms: 0,
                            error: Some(reason.into()),
                            command_dispatched: Some(false),
                        },
                    );
                    continue;
                }
                let observed = capture_command(
                    action.input.target.local_cwd(),
                    remote.as_ref(),
                    &command,
                    &attempt_id,
                    timeout_secs,
                    cancel.clone(),
                )
                .await;
                if observed.command_dispatched == Some(true) {
                    state
                        .commands_executed
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                let _ = state.pty.respond(&attempt_id, observed);
            }
            runtime::RunbookEvent::OperatorDecisionRequired {
                step_id,
                manual,
                reason,
                ..
            } => {
                if let Ok(mut failure) = failure.lock() {
                    if failure.is_none() {
                        *failure = Some(format!("scheduled runbook stopped: {reason}"));
                    }
                }
                if manual.is_some() {
                    state.cancellations.cancel(&run_id);
                } else if let Some(step_id) = step_id {
                    let _ = state.decisions.respond(
                        &run_id,
                        &step_id,
                        engine::OperatorDecisionResponse {
                            decision: state::PauseDecision::Stop,
                            waiver: None,
                            comment: Some(
                                "unattended runs stop when operator input is required".into(),
                            ),
                        },
                    );
                } else {
                    state.cancellations.cancel(&run_id);
                }
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn capture_command(
    cwd: Option<&str>,
    remote: Option<&super::ssh::RemoteBatchTarget>,
    command: &str,
    attempt_id: &str,
    timeout_secs: u64,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> runtime::ObservedPtyResult {
    let started = std::time::Instant::now();
    let dispatched = remote.map_or_else(|| Ok(command.to_string()), |remote| remote.wrap(&command));
    let wrapped = dispatched.is_ok();
    let result = match dispatched {
        Ok(command) => {
            let sink = tauri::ipc::Channel::new(|_| Ok(()));
            let agent_socket = remote.and_then(|_| std::env::var_os("SSH_AUTH_SOCK"));
            crate::agent::exec::run_clean_command(
                cwd,
                &command,
                attempt_id,
                timeout_secs,
                crate::agent::OutputPolicy::Normal,
                cancel.clone(),
                &sink,
                agent_socket.as_deref(),
            )
            .await
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(result) => {
            let bytes = result.output_tail.len() as u64;
            runtime::ObservedPtyResult {
                exit_code: (!result.timed_out && !result.cancelled).then_some(result.exit_code),
                output_tail: result.output_tail,
                output_truncated: bytes >= 8192,
                output_observed_bytes: bytes,
                output_captured_bytes: bytes,
                duration_ms: result.duration_ms,
                error: result
                    .timed_out
                    .then(|| "scheduled command timed out".into()),
                command_dispatched: Some(true),
            }
        }
        Err(error) => runtime::ObservedPtyResult {
            exit_code: None,
            output_tail: String::new(),
            output_truncated: false,
            output_observed_bytes: 0,
            output_captured_bytes: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(error.clone()),
            command_dispatched: if !wrapped || error.starts_with("spawn failed:") {
                Some(false)
            } else {
                None
            },
        },
    }
}

fn create_summary(
    database: &DbState,
    schedule_run_id: &str,
    runbook_id: &str,
    intent_at: &str,
) -> Result<super::types::StepAttempt, String> {
    let conn = database
        .0
        .lock()
        .map_err(|_| "schedule database poisoned")?;
    let attempt = super::types::StepAttempt {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: schedule_run_id.into(),
        step_id: "runbook".into(),
        sort_order: 0,
        kind: super::types::StepKind::Command,
        title: "Runbook".into(),
        status: super::types::StepAttemptStatus::Running,
        executed_command: None,
        exit_code: None,
        output_tail: None,
        output_redacted: false,
        output_truncated: false,
        termination: None,
        summary: Some(format!("Runbook report: {runbook_id}")),
        commands_executed: 0,
        commands_skipped: 0,
        commands_blocked: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        error: None,
        intent_at: intent_at.into(),
        started_at: Some(intent_at.into()),
        finished_at: None,
        duration_ms: None,
    };
    super::db::insert_attempt(&conn, &attempt)?;
    Ok(attempt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn captured_runbook_checks_applies_verifies_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("package");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("runbook.vrun.yaml"),
            r#"apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: captured-regression
  version: 1.0.0
  title: Captured regression
spec:
  target:
    kind: active-terminal
  inputs:
    marker:
      type: path
      required: true
  steps:
    - id: ready
      title: Marker is ready
      required: true
      check:
        uses: shell
        with:
          command: 'test -f "$VRUN_FILE"'
          env: { VRUN_FILE: marker }
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
      apply:
        uses: shell
        with:
          command: 'printf ready > "$VRUN_FILE"'
          env: { VRUN_FILE: marker }
        successExitCodes: [0]
      verify:
        uses: shell
        with:
          command: 'grep -q ready "$VRUN_FILE"'
          env: { VRUN_FILE: marker }
        passExitCodes: [0]
"#,
        )
        .unwrap();
        for expected_commands in [3, 1] {
            let package = package::load_package(&root).unwrap();
            let runtime = Arc::new(Runtime::default());
            let run_id = uuid::Uuid::new_v4().to_string();
            let target = state::TargetBinding::active_terminal(
                format!("schedule:{run_id}"),
                Some("/bin/sh".into()),
                None,
                None,
                None,
                Some("captured-test".into()),
                crate::scheduled::db::now_rfc3339(),
            );
            let spec = engine::EngineRunSpec {
                run_id: run_id.clone(),
                definition: package.definition,
                definition_snapshot: package.snapshot,
                package_root: Some(package.root),
                target: target.clone(),
                inputs: std::collections::BTreeMap::from([(
                    "marker".into(),
                    serde_json::json!(dir.path().join("ready").to_str().unwrap()),
                )]),
                evidence_mode: state::EvidenceCaptureMode::Tail,
                app_version: "test".into(),
                model: None,
                created_at: crate::scheduled::db::now_rfc3339(),
            };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let sink = EventQueue(tx);
            let driver_state = runtime.clone();
            let driver_run = run_id.clone();
            let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
            let driver = tokio::spawn(async move {
                let mut commands = 0;
                let _keep_cancel_alive = cancel_tx;
                while let Some(event) = rx.recv().await {
                    match event {
                        runtime::RunbookEvent::ApprovalRequested { approval_id, .. } => {
                            driver_state
                                .approvals
                                .respond(
                                    &approval_id,
                                    runtime::ApprovalResponse {
                                        decision: state::ApprovalDecision::Approve,
                                        actor: "schedule:test".into(),
                                        reason: Some("saved all policy".into()),
                                        edited_command: None,
                                    },
                                )
                                .unwrap();
                        }
                        runtime::RunbookEvent::RunInTerminal {
                            attempt_id,
                            command,
                            timeout_secs,
                            ..
                        } => {
                            assert!(driver_state
                                .pty
                                .claim_dispatch(&attempt_id, &driver_run)
                                .unwrap());
                            let observed = capture_command(
                                None,
                                None,
                                &command,
                                &attempt_id,
                                timeout_secs,
                                cancel_rx.clone(),
                            )
                            .await;
                            driver_state.pty.respond(&attempt_id, observed).unwrap();
                            commands += 1;
                        }
                        runtime::RunbookEvent::OperatorDecisionRequired { .. } => {
                            driver_state.cancellations.cancel(&driver_run);
                            panic!("a captured run unexpectedly needed an operator");
                        }
                        runtime::RunbookEvent::RunFinished { .. } => return commands,
                        _ => {}
                    }
                }
                commands
            });
            let observer = FixedTarget(target);
            let context = engine::EngineContext {
                coordinator: &runtime.coordinator,
                approvals: &runtime.approvals,
                pty: &runtime.pty,
                manual: &runtime.manual,
                manual_index: &runtime.manual_index,
                decisions: &runtime.decisions,
                cancellations: &runtime.cancellations,
                events: &sink,
                database: None,
                evidence_root: None,
                provider: None,
                target_observer: &observer,
                config: engine::EngineConfig {
                    command_timeout_secs: 5,
                    response_timeout_secs: 5,
                    ..Default::default()
                },
            };
            let report = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                engine::execute_runbook(&context, spec),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(report.status, state::RunStatus::Succeeded, "{report:?}");
            assert_eq!(driver.await.unwrap(), expected_commands);
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("ready")).unwrap(),
            "ready"
        );
    }

    #[test]
    fn deny_rules_cover_both_native_wrapper_and_semantic_command() {
        use crate::agent::policy::{CommandPolicyRule, PolicyRuleEffect};
        let guarded = "/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat SYSTEMD_PAGELESS=1 LESS=FRX DEBIAN_FRONTEND=noninteractive /bin/sh -c 'df -h' < /dev/null";
        let ask = CommandPolicyRule {
            id: "ask".into(),
            effect: PolicyRuleEffect::Ask,
            scope: "local".into(),
            argv: vec!["df".into(), "**".into()],
            enabled: true,
            description: String::new(),
        };
        assert!(rules_require_review(
            guarded,
            "local",
            &[ask.clone()],
            RunbookApprovalPolicy::ReadOnly
        ));
        assert!(!rules_require_review(
            guarded,
            "local",
            &[ask],
            RunbookApprovalPolicy::All
        ));
        for argv in [
            vec!["df".into(), "**".into()],
            vec!["/usr/bin/env".into(), "**".into()],
        ] {
            let rule = CommandPolicyRule {
                id: "deny".into(),
                effect: PolicyRuleEffect::Deny,
                scope: "local".into(),
                argv,
                enabled: true,
                description: String::new(),
            };
            assert!(denied_by_rules(guarded, "local", &[rule]));
        }
    }

    #[test]
    fn package_is_pinned_and_inputs_are_validated_before_execution() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::database::migrations::run(&conn).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let definition = include_str!(
            "../../../examples/runbooks/idempotent-software-install/runbook.vrun.yaml"
        );
        std::fs::write(dir.path().join("runbook.vrun.yaml"), definition).unwrap();
        let package = package::load_package(dir.path()).unwrap();
        let source = runbook_db::upsert_source(
            &conn,
            &runbook_db::SourceRegistrationInput {
                package_path: package.root.to_str().unwrap().into(),
                definition_id: package.definition.metadata.id.clone(),
                definition_version: package.definition.metadata.version.clone(),
                title: package.definition.metadata.title.clone(),
                source_sha256: package.snapshot.source_sha256.clone(),
                canonical_sha256: package.snapshot.canonical_sha256.clone(),
                valid: true,
                validation_error: None,
                source_kind: runbook_db::SourceKind::User,
                hidden: false,
                builtin_order: None,
            },
        )
        .unwrap();
        let mut input: ScheduledActionInput = serde_json::from_value(serde_json::json!({
            "name":"nightly", "enabled":true, "target":{"kind":"local_shell"}, "steps":[], "execution_mode":"headless",
            "recurrence":{"kind":"daily","at":{"hour":3,"minute":0}}, "timezone":"Europe/Berlin",
            "runbook":{"source_id": source.id, "canonical_sha256": package.snapshot.canonical_sha256, "inputs":{}, "approval":"all"},
        })).unwrap();
        assert!(validate_package(&conn, &input).is_ok());
        input
            .runbook
            .as_mut()
            .unwrap()
            .inputs
            .insert("packageName".into(), serde_json::json!(42));
        assert!(validate_package(&conn, &input)
            .unwrap_err()
            .contains("inputs"));
        input.runbook.as_mut().unwrap().inputs.clear();
        input.runbook.as_mut().unwrap().canonical_sha256 = "a".repeat(64);
        assert!(validate_package(&conn, &input)
            .unwrap_err()
            .contains("changed"));
        input.runbook.as_mut().unwrap().canonical_sha256 = package.snapshot.canonical_sha256;
        std::fs::write(
            dir.path().join("runbook.vrun.yaml"),
            format!("{definition}\n# changed on disk\n"),
        )
        .unwrap();
        assert!(validate_package(&conn, &input)
            .unwrap_err()
            .contains("changed"));
    }

    #[test]
    fn automatic_approval_obeys_the_explicit_policy() {
        assert!(!may_approve(
            RunbookApprovalPolicy::None,
            true,
            false,
            false,
            false
        ));
        assert!(may_approve(
            RunbookApprovalPolicy::ReadOnly,
            true,
            false,
            false,
            false
        ));
        for flags in [
            (false, false, false, false),
            (true, true, false, false),
            (true, false, true, false),
            (true, false, false, true),
        ] {
            assert!(!may_approve(
                RunbookApprovalPolicy::ReadOnly,
                flags.0,
                flags.1,
                flags.2,
                flags.3
            ));
        }
        assert!(may_approve(
            RunbookApprovalPolicy::All,
            false,
            true,
            true,
            true
        ));
    }
}
