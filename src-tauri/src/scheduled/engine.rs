//! Walking a run's steps.
//!
//! One engine serves both execution modes. The difference between `tab` and
//! `headless` reduces to which `ExecTarget` a prompt step gets and how a literal
//! command step reaches a shell; everything else — the attempt-row lifecycle,
//! ordering, the failure policy, cancellation, redaction — is identical and must
//! not be written twice. That is the `AgentCommandHost` lesson, applied.
//!
//! # The unattended rule, in one sentence
//!
//! **Auto-run exactly what the persisted permission mode allows, auto-skip
//! everything else immediately, and record both.**
//!
//! The alternative is what happens if you do nothing: `policy_auto_runs` returns
//! false for a privileged, opaque, sensitive-read or private-output command under
//! every mode a schedule can hold, `run_agent` registers an approval, and the run
//! sits on `APPROVAL_TIMEOUT_SECS` (600) before dying with `ApprovalTimeout`.
//! Ten minutes of nothing, then a failure, is a terrible way to say no — and with
//! several steps it is hours. Responding `Skip` the instant a proposal arrives
//! tells the model to find another way, keeps the run moving, and puts the
//! command, its `CommandAssessment` and the reason on the record for the morning.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, Wry};

use super::db;
use super::types::{
    ExecutionMode, RunTrigger, ScheduledAction, ScheduledRunStatus, ScheduledStep, ScheduledTarget,
    StepAttempt, StepAttemptStatus, StepKind,
};
use crate::agent::run::{AgentConfig, CommandWrapper, ExecTarget};
use crate::agent::{
    AgentPermissionModes, AgentPermissionState, ApprovalDecision, ApprovalResponse, ApprovalState,
    PtyExecState, SteerState,
};
use crate::database::DbState;

/// What one step produced, before it becomes an attempt row.
struct StepOutcome {
    status: StepAttemptStatus,
    executed_command: Option<String>,
    exit_code: Option<i32>,
    output_tail: Option<String>,
    output_redacted: bool,
    output_truncated: bool,
    termination: Option<String>,
    summary: Option<String>,
    commands_executed: u32,
    commands_skipped: u32,
    commands_blocked: u32,
    prompt_tokens: u32,
    completion_tokens: u32,
    error: Option<String>,
}

impl StepOutcome {
    fn failed(error: impl Into<String>) -> Self {
        Self {
            status: StepAttemptStatus::Failed,
            error: Some(error.into()),
            ..Self::empty()
        }
    }

    fn blocked(reason: impl Into<String>) -> Self {
        Self {
            status: StepAttemptStatus::Blocked,
            error: Some(reason.into()),
            commands_blocked: 1,
            ..Self::empty()
        }
    }

    fn empty() -> Self {
        Self {
            status: StepAttemptStatus::Unknown,
            executed_command: None,
            exit_code: None,
            output_tail: None,
            output_redacted: false,
            output_truncated: false,
            termination: None,
            summary: None,
            commands_executed: 0,
            commands_skipped: 0,
            commands_blocked: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            error: None,
        }
    }

    /// A step that did not succeed stops the run unless the step opted out.
    fn is_failure(&self) -> bool {
        !matches!(
            self.status,
            StepAttemptStatus::Succeeded | StepAttemptStatus::Skipped
        )
    }
}

/// Bounded output kept per attempt. Runbooks' full-evidence path costs a
/// filesystem reconciliation pass at every startup; this feature does not need
/// one, and 8 KiB is enough to answer "what did it say?".
const OUTPUT_TAIL_BYTES: usize = 8 * 1024;

fn tail(output: &str) -> (String, bool) {
    if output.len() <= OUTPUT_TAIL_BYTES {
        return (output.to_string(), false);
    }
    // Slice on a char boundary — a raw byte count would split a multibyte
    // character and produce a row that is not valid UTF-8 text.
    let mut start = output.len() - OUTPUT_TAIL_BYTES;
    while start < output.len() && !output.is_char_boundary(start) {
        start += 1;
    }
    (output[start..].to_string(), true)
}

/// Drive one committed run to a terminal status.
pub async fn execute_run(
    app: &tauri::AppHandle<Wry>,
    run_id: &str,
    action: &ScheduledAction,
    trigger: RunTrigger,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<ScheduledRunStatus, String> {
    let now = db::now_rfc3339();
    write(app, |conn| {
        db::set_run_status(conn, run_id, ScheduledRunStatus::Running, None, &now)
    });

    // Snapshot the remote transport once, at the start of the run. Re-reading the
    // host row per command would let a mid-run edit redirect the second half of a
    // run to a different machine.
    let remote: Option<Arc<super::ssh::RemoteBatchTarget>> = match &action.input.target {
        ScheduledTarget::SshHost { host_id } => {
            let host = read(app, |conn| {
                crate::database::queries::get_ssh_host(conn, host_id)
            })
            .unwrap_or(None);
            match host {
                Some(host) => Some(Arc::new(super::ssh::RemoteBatchTarget::from_host(&host))),
                None => {
                    return Err(format!(
                        "saved host {host_id} no longer exists, so this run has no target"
                    ))
                }
            }
        }
        ScheduledTarget::LocalShell { .. } => None,
    };

    // A local cwd that has moved must fail the run, never fall through to the
    // app's own working directory — `exec::run_command` applies `current_dir`
    // only `if let Some(dir)`, so a missing path silently relocates every command.
    if let Some(dir) = action.input.target.local_cwd() {
        let path = std::path::Path::new(dir);
        if !path.is_dir() {
            return Err(format!(
                "the working directory {dir} no longer exists on this machine"
            ));
        }
    }

    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(u64::from(action.input.max_run_secs));
    let mut worst = ScheduledRunStatus::Succeeded;

    for (index, step) in action.input.steps.iter().enumerate() {
        if *cancel.borrow() {
            return Ok(ScheduledRunStatus::Cancelled);
        }
        if tokio::time::Instant::now() >= deadline {
            record_skipped_remainder(
                app,
                run_id,
                action,
                index,
                "the run reached its time budget before this step started",
            );
            return Err(format!(
                "the run exceeded its {}s budget",
                action.input.max_run_secs
            ));
        }

        let attempt_id = uuid::Uuid::new_v4().to_string();
        let intent_at = db::now_rfc3339();
        // BEFORE dispatch. This row is the whole crash-recovery contract.
        let intent = StepAttempt {
            id: attempt_id.clone(),
            run_id: run_id.to_string(),
            step_id: step.id.clone(),
            sort_order: index as u32,
            kind: step.kind,
            title: step.title.clone(),
            status: StepAttemptStatus::Pending,
            intent_at: intent_at.clone(),
            ..empty_attempt(run_id, step, index, &intent_at)
        };
        write(app, |conn| db::insert_attempt(conn, &intent));
        let started = std::time::Instant::now();
        let started_at = db::now_rfc3339();
        write(app, |conn| {
            db::mark_attempt_running(conn, &attempt_id, &started_at)
        });

        let outcome = match step.kind {
            StepKind::Command => {
                run_command_step(app, action, step, remote.clone(), cancel.clone()).await
            }
            StepKind::Prompt => {
                run_prompt_step(
                    app,
                    run_id,
                    action,
                    step,
                    index,
                    remote.clone(),
                    cancel.clone(),
                )
                .await
            }
        };

        let finished_at = db::now_rfc3339();
        let row = StepAttempt {
            id: attempt_id.clone(),
            run_id: run_id.to_string(),
            step_id: step.id.clone(),
            sort_order: index as u32,
            kind: step.kind,
            title: step.title.clone(),
            status: outcome.status,
            executed_command: outcome.executed_command.clone(),
            exit_code: outcome.exit_code,
            output_tail: outcome.output_tail.clone(),
            output_redacted: outcome.output_redacted,
            output_truncated: outcome.output_truncated,
            termination: outcome.termination.clone(),
            summary: outcome.summary.clone(),
            commands_executed: outcome.commands_executed,
            commands_skipped: outcome.commands_skipped,
            commands_blocked: outcome.commands_blocked,
            prompt_tokens: outcome.prompt_tokens,
            completion_tokens: outcome.completion_tokens,
            error: outcome.error.clone(),
            intent_at,
            started_at: Some(started_at),
            finished_at: Some(finished_at.clone()),
            duration_ms: Some(started.elapsed().as_millis() as i64),
        };
        write(app, |conn| db::finish_attempt(conn, &row));
        if outcome.prompt_tokens > 0 || outcome.completion_tokens > 0 {
            write(app, |conn| {
                db::add_run_usage(
                    conn,
                    run_id,
                    outcome.prompt_tokens,
                    outcome.completion_tokens,
                    &finished_at,
                )
            });
        }

        if outcome.status == StepAttemptStatus::Cancelled {
            return Ok(ScheduledRunStatus::Cancelled);
        }
        if outcome.is_failure() {
            if !step.continue_on_failure {
                record_skipped_remainder(
                    app,
                    run_id,
                    action,
                    index + 1,
                    "an earlier step failed and this action stops on failure",
                );
                return Ok(ScheduledRunStatus::Failed);
            }
            worst = ScheduledRunStatus::Failed;
        }
    }
    let _ = trigger;
    Ok(worst)
}

fn empty_attempt(run_id: &str, step: &ScheduledStep, index: usize, intent_at: &str) -> StepAttempt {
    StepAttempt {
        id: String::new(),
        run_id: run_id.to_string(),
        step_id: step.id.clone(),
        sort_order: index as u32,
        kind: step.kind,
        title: step.title.clone(),
        status: StepAttemptStatus::Pending,
        executed_command: None,
        exit_code: None,
        output_tail: None,
        output_redacted: false,
        output_truncated: false,
        termination: None,
        summary: None,
        commands_executed: 0,
        commands_skipped: 0,
        commands_blocked: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        error: None,
        intent_at: intent_at.to_string(),
        started_at: None,
        finished_at: None,
        duration_ms: None,
    }
}

/// Steps after a stop are recorded `skipped`, not left absent.
///
/// An absent row reads as "the run had fewer steps", which is a different and
/// wrong story. The list of what did NOT happen is part of the record.
fn record_skipped_remainder(
    app: &tauri::AppHandle<Wry>,
    run_id: &str,
    action: &ScheduledAction,
    from: usize,
    reason: &str,
) {
    for (index, step) in action.input.steps.iter().enumerate().skip(from) {
        let now = db::now_rfc3339();
        let mut row = empty_attempt(run_id, step, index, &now);
        row.id = uuid::Uuid::new_v4().to_string();
        row.status = StepAttemptStatus::Skipped;
        row.error = Some(reason.to_string());
        row.finished_at = Some(now.clone());
        row.duration_ms = Some(0);
        let intent = row.clone();
        write(app, |conn| db::insert_attempt(conn, &intent));
        write(app, |conn| db::finish_attempt(conn, &row));
    }
}

/// A literal command step: the user's own text.
///
/// A saved **Deny** rule blocks it, because a deny rule is the user's most recent
/// word on the subject and must not be overridden by an older schedule. The
/// network refusal deliberately does NOT apply — the user typed `curl`, they
/// meant `curl`.
async fn run_command_step(
    app: &tauri::AppHandle<Wry>,
    action: &ScheduledAction,
    step: &ScheduledStep,
    remote: Option<Arc<super::ssh::RemoteBatchTarget>>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> StepOutcome {
    let Some(command) = step.as_command() else {
        return StepOutcome::failed("this step is not a command");
    };
    let scope = action.input.target.policy_scope();
    let rules = crate::commands::settings::read_command_policy_rules(app);
    let (decision, matched) = crate::agent::policy::evaluate_rules(command, &scope, &rules);
    if decision == crate::agent::policy::RuleDecision::Deny {
        return StepOutcome::blocked(match matched {
            Some(id) => format!("a saved policy rule ({id}) denies this command in {scope}"),
            None => format!("a saved policy rule denies this command in {scope}"),
        });
    }

    let dispatched = match &remote {
        Some(target) => match target.wrap(command) {
            Ok(line) => line,
            Err(reason) => return StepOutcome::failed(reason),
        },
        None => command.to_string(),
    };

    let shell = shell_for(app);
    let approval_id = format!("sched-cmd-{}", uuid::Uuid::new_v4());
    // A sink that discards: a command step's own text produces no events anyone
    // is listening to, and the captured result is what we record.
    let sink: Channel<crate::agent::StreamEvent> = Channel::new(|_| Ok(()));
    let outcome = crate::agent::exec::run_command(
        &shell,
        action.input.target.local_cwd(),
        &dispatched,
        &approval_id,
        u64::from(action.input.command_timeout_secs),
        crate::agent::OutputPolicy::Normal,
        cancel,
        &sink,
    )
    .await;

    match outcome {
        Ok(result) if result.cancelled => StepOutcome {
            status: StepAttemptStatus::Cancelled,
            executed_command: Some(dispatched),
            ..StepOutcome::empty()
        },
        Ok(result) => {
            let (kept, truncated) = tail(&result.output_tail);
            StepOutcome {
                status: if result.exit_code == 0 {
                    StepAttemptStatus::Succeeded
                } else {
                    StepAttemptStatus::Failed
                },
                executed_command: Some(dispatched),
                exit_code: Some(result.exit_code),
                output_tail: Some(kept),
                output_truncated: truncated,
                commands_executed: 1,
                error: (result.exit_code != 0)
                    .then(|| format!("the command exited with status {}", result.exit_code)),
                ..StepOutcome::empty()
            }
        }
        Err(error) => StepOutcome {
            status: StepAttemptStatus::Failed,
            executed_command: Some(dispatched),
            error: Some(error),
            ..StepOutcome::empty()
        },
    }
}

/// An AI prompt step: the agent loop, headless.
async fn run_prompt_step(
    app: &tauri::AppHandle<Wry>,
    run_id: &str,
    action: &ScheduledAction,
    step: &ScheduledStep,
    index: usize,
    remote: Option<Arc<super::ssh::RemoteBatchTarget>>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> StepOutcome {
    let Some(goal) = step.as_prompt() else {
        return StepOutcome::failed("this step is not a prompt");
    };
    let resolved = match crate::commands::ai::resolve_provider(app).await {
        Ok(resolved) => resolved,
        Err(error) => return StepOutcome::failed(error),
    };
    let model_label = resolved.model.label.to_string();
    let now = db::now_rfc3339();
    write(app, |conn| {
        db::set_run_model(conn, run_id, &model_label, &now)
    });

    // Intersected with the global setting, never unioned: a daytime research
    // session must not widen a schedule saved months ago. And intersected again
    // with what the model can actually do.
    let web_access =
        action.input.web_access && crate::commands::settings::read_bool(app, "ai_web_access", true);
    let native_web = web_access && resolved.model.native_web_fetch;

    // Same `&&` ordering as `agent_start`: an empty vector means `tools()` never
    // adds `search_docs`, so the capability is ABSENT rather than discouraged, and
    // a stale stored bucket list cannot reintroduce it after the flag went off.
    let docs_enabled = crate::commands::settings::read_bool(app, "docs_enabled", false);
    let doc_buckets = if docs_enabled {
        action.input.doc_buckets.clone()
    } else {
        if !action.input.doc_buckets.is_empty() {
            let now = db::now_rfc3339();
            write(app, |conn| {
                db::append_event(
                    conn,
                    run_id,
                    "KnowledgeUnavailable",
                    Some(&step.id),
                    "{\"reason\":\"docs_enabled is off\"}",
                    &now,
                )
            });
        }
        Vec::new()
    };
    let docs_attached = !doc_buckets.is_empty();

    let exec_target = match &remote {
        Some(target) => ExecTarget::SubprocessWrapped {
            wrapper: target.clone() as Arc<dyn CommandWrapper>,
        },
        None => ExecTarget::Subprocess,
    };
    let request_id = format!("sched-{run_id}-{}", step.id);

    // Run-LOCAL rendezvous state, deliberately not the app-managed ones. The
    // consequence is the desirable one: `agent_set_permission_mode` answers "no
    // active run" for a scheduled run, and `respond_to_approval` from the webview
    // cannot approve something this run's policy already skipped.
    let approvals = Arc::new(ApprovalState::default());
    let skipped = Arc::new(AtomicU32::new(0));
    let sink = auto_skip_sink(approvals.clone(), skipped.clone());

    // MCP, on the same terms as every other surface. `prepare_mcp_context`
    // returns `None` for an empty selection, so an action with no servers pays
    // nothing — and the conversation id is the ACTION id, not the run id, so an
    // hourly schedule reuses one warm session instead of paying a sandboxed
    // stdio launch on every fire.
    //
    // Safe to offer because the gate is unchanged: `mcp/chat.rs` checks
    // `grant_matches` before it registers anything, and `auto_skip_sink` denies
    // an `McpToolProposal` the instant one appears. So a tool the user has
    // pre-approved through the ordinary card works, and one they have not is
    // refused at once rather than waiting out the MCP gate's own timeout.
    let mcp_manager = app.state::<crate::mcp::client::McpManager>();
    let mcp_approvals = app.state::<crate::mcp::approval::McpApprovalState>();
    let mcp_context = match crate::agent::prepare_mcp_context(
        app,
        &mcp_manager,
        &mcp_approvals,
        &request_id,
        &action.id,
        &action.input.mcp_selection,
        resolved.model,
        &sink,
    )
    .await
    {
        Ok(context) => context,
        Err(error) => {
            // A server that cannot be reached fails THIS step, not the run: a
            // later step may not need it at all.
            return StepOutcome::failed(format!("the MCP servers could not be prepared: {error}"));
        }
    };
    let mcp_tools = mcp_context
        .as_ref()
        .map(crate::mcp::chat::McpRunContext::tool_defs)
        .unwrap_or_default();

    // One read for the window and both compaction knobs, so the pause guard and
    // the compactor cannot disagree about how big the window is.
    let compaction = crate::commands::ai::compaction_settings(app, resolved.model);
    let config = AgentConfig {
        request_id: request_id.clone(),
        shell: shell_for(app),
        cwd: action.input.target.local_cwd().map(str::to_string),
        temperature: crate::commands::settings::read_f64_opt(app, "temperature").map(|t| t as f32),
        effort: resolved.effort,
        max_iterations: action.input.max_iterations.clamp(1, 100),
        // Mirrors the on-device load clamp, not the raw catalog number: reading
        // `model.context_tokens` directly makes the guard inert, because the
        // default local model declares 262_144 and loads at 32_768.
        context_tokens: compaction.window_tokens,
        // A scheduled run compacts like an interactive one. It grants nothing:
        // enforcement is `policy_auto_runs` plus `auto_skip_sink`, neither of
        // which reads prose — so a summary of earlier steps rides along without
        // widening the one persisted execution authorization. It matters MORE
        // here: nobody is at the keyboard to click Continue on a pause, so a run
        // that fills its window at 03:00 otherwise records a step limit and stops.
        auto_compact: compaction.enabled,
        compact_threshold_percent: compaction.threshold_percent,
        command_timeout_secs: u64::from(action.input.command_timeout_secs),
        web_access,
        policy_rules: crate::commands::settings::read_command_policy_rules(app),
        // The target IS the scope, so a rule the user saved for `local` never
        // silently covers a remote schedule.
        policy_scope_single: action.input.target.policy_scope(),
        policy_scope_remote: "remote:unknown".into(),
        doc_buckets,
        mcp_tools,
        exec_target,
    };

    let context = super::context::ScheduledContext {
        action_name: &action.input.name,
        execution_mode: action.input.execution_mode,
        target: &action.input.target,
        target_description: remote.as_ref().map(|t| t.describe()),
        shell: &config.shell,
        os: std::env::consts::OS,
        step_count: action.input.steps.len(),
        step_index: index,
        step_title: &step.title,
    };
    let web_tier = match (web_access, native_web) {
        (true, true) => crate::agent::prompts::AGENT_WEB_NATIVE,
        (true, false) => crate::agent::prompts::AGENT_WEB_CURL,
        (false, _) => crate::agent::prompts::AGENT_WEB_NONE,
    };
    let mut system_prompt = format!(
        "{}\n\n{}\n\n{}\n\n{}",
        crate::agent::prompts::AGENT,
        crate::agent::prompts::SCHEDULED,
        web_tier,
        context.render()
    );
    if docs_attached {
        system_prompt.push_str(&format!("\n\n{}", crate::agent::prompts::AGENT_DOCS));
    }
    // LAST, after the scheduled tier, the web tier, the context and the docs
    // tier — so the user's own closing tag ends the prompt and nothing the app
    // writes can read as their text.
    //
    // A scheduled prompt step is an Agent run, and would otherwise be the only
    // Agent-class surface that ignored the user's standing instructions: Ask and
    // Chat both call this, and so does `agent_start`. It widens nothing this
    // module's doc bounds — the framing states in its own words that the text
    // authorises nothing, and enforcement is `policy_auto_runs` plus
    // `auto_skip_sink`, neither of which reads prose. What it buys is the fleet
    // knowledge ("these hosts are Debian", "never touch /srv") that an
    // unattended run most needs and can least ask for.
    crate::agent::instructions::append(
        app,
        crate::agent::instructions::Surface::Agent,
        &mut system_prompt,
    );

    let permissions = AgentPermissionState::default();
    let pty_exec = PtyExecState::default();
    let steers = SteerState::default();
    permissions.register(
        &request_id,
        AgentPermissionModes {
            single: action.input.permission_mode,
            local: action.input.permission_mode,
            remote: action.input.permission_mode,
        },
    );
    steers.register(&request_id);

    let outcome = crate::agent::run::run_agent(
        resolved.provider.as_ref(),
        config,
        system_prompt,
        goal.to_string(),
        Vec::new(),
        Vec::new(),
        &approvals,
        Some(&permissions),
        &pty_exec,
        &steers,
        Some(app),
        None,
        mcp_context.as_ref(),
        cancel,
        &sink,
    )
    .await;

    permissions.finish(&request_id);
    steers.drain_for_request(&request_id);
    approvals.drain_for_request(&request_id);

    // Metadata only. No goal text, no commands, no output, no provider error
    // bodies reach the durable log.
    log::info!(
        target: "vterminal::scheduled",
        "{}",
        outcome.metadata_log_line(&request_id, &model_label)
    );

    let termination = outcome.termination.as_str().to_string();
    let summary = last_assistant_text(&outcome.transcript);
    let status = match &outcome.termination {
        crate::agent::run::AgentTermination::Completed => StepAttemptStatus::Succeeded,
        crate::agent::run::AgentTermination::Cancelled => StepAttemptStatus::Cancelled,
        // A pause is this step's TERMINAL outcome. The run never starts a fresh
        // budget: CLAUDE.md is explicit that wiring an armed mode to Continue
        // would turn the step cap into no cap at all, unattended, and a person
        // resumes it from the run detail instead.
        crate::agent::run::AgentTermination::Paused { .. } => StepAttemptStatus::Failed,
        crate::agent::run::AgentTermination::Failed { .. } => StepAttemptStatus::Failed,
    };
    let error = match &outcome.termination {
        crate::agent::run::AgentTermination::Paused { .. } => Some(
            "the step reached its step limit and paused; resume it from the run detail".to_string(),
        ),
        crate::agent::run::AgentTermination::Failed { message, .. } => Some(message.clone()),
        _ => None,
    };

    StepOutcome {
        status,
        termination: Some(termination),
        summary,
        commands_executed: outcome.stats.commands_executed,
        commands_skipped: outcome
            .stats
            .commands_skipped
            .max(skipped.load(Ordering::Relaxed)),
        commands_blocked: outcome.stats.commands_blocked,
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        error,
        ..StepOutcome::empty()
    }
}

/// The event sink for a scheduled prompt step.
///
/// Its one job is the unattended rule: a `CommandProposal` only ever reaches this
/// closure when `policy_auto_runs` already said no, so answering `Skip`
/// immediately is the whole of "auto-skip everything the mode does not allow".
/// Waiting instead would burn `APPROVAL_TIMEOUT_SECS` per proposal with nobody
/// there to answer.
///
/// Parsing JSON here rather than taking a typed sink is the known wart of
/// `run_agent`'s `Channel` signature; `examples/smoke_agent.rs` does the same and
/// is the existing proof it works headlessly.
fn auto_skip_sink(
    approvals: Arc<ApprovalState>,
    skipped: Arc<AtomicU32>,
) -> Channel<crate::agent::StreamEvent> {
    Channel::new(move |body: InvokeResponseBody| {
        let InvokeResponseBody::Json(json) = body else {
            return Ok(());
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
            return Ok(());
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("CommandProposal") => {
                if let Some(id) = value.get("approval_id").and_then(|v| v.as_str()) {
                    skipped.fetch_add(1, Ordering::Relaxed);
                    let _ = approvals.respond(
                        id,
                        ApprovalResponse {
                            decision: ApprovalDecision::Skip,
                            edited_command: None,
                        },
                    );
                }
            }
            // An MCP proposal means a tool without a persisted grant reached
            // dispatch. Deny at once rather than letting the run sit on the MCP
            // gate's own 600-second timeout.
            Some("McpToolProposal") => {
                if let Some(id) = value.get("approval_id").and_then(|v| v.as_str()) {
                    let _ = approvals.respond(
                        id,
                        ApprovalResponse {
                            decision: ApprovalDecision::Skip,
                            edited_command: None,
                        },
                    );
                }
            }
            _ => {}
        }
        Ok(())
    })
}

fn last_assistant_text(transcript: &[crate::provider::ChatMessage]) -> Option<String> {
    transcript
        .iter()
        .rev()
        .find(|m| m.role == crate::provider::Role::Assistant && !m.content.trim().is_empty())
        .map(|m| {
            let (kept, _) = tail(&m.content);
            kept
        })
}

fn shell_for(app: &tauri::AppHandle<Wry>) -> String {
    crate::commands::settings::read_string(app, "shell_path")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::commands::settings::default_shell().into())
}

fn write<T>(
    app: &tauri::AppHandle<Wry>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) {
    let Some(db) = app.try_state::<DbState>() else {
        return;
    };
    let Ok(conn) = db.0.lock() else { return };
    if let Err(e) = f(&conn) {
        log::warn!("scheduled actions: database write failed: {e}");
    }
}

fn read<T>(
    app: &tauri::AppHandle<Wry>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Option<T> {
    let db = app.try_state::<DbState>()?;
    let conn = db.0.lock().ok()?;
    f(&conn).ok()
}

/// Used by the tab-mode attach path, which builds the same config with a
/// `Pty` exec target instead.
pub fn tab_exec_target(session_id: &str) -> ExecTarget {
    ExecTarget::Pty {
        session_id: session_id.to_string(),
    }
}

pub const fn is_tab(mode: ExecutionMode) -> bool {
    matches!(mode, ExecutionMode::Tab)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_output_tail_is_bounded_and_slices_on_a_char_boundary() {
        let (kept, truncated) = tail("short");
        assert_eq!(kept, "short");
        assert!(!truncated);

        // Multibyte throughout: a raw byte count would land mid-character and
        // produce a row that is not valid text.
        let wide = "é".repeat(OUTPUT_TAIL_BYTES);
        let (kept, truncated) = tail(&wide);
        assert!(truncated);
        assert!(kept.len() <= OUTPUT_TAIL_BYTES);
        assert!(kept.chars().all(|c| c == 'é'));
    }

    #[test]
    fn only_success_and_skip_are_not_failures() {
        for status in [StepAttemptStatus::Succeeded, StepAttemptStatus::Skipped] {
            let outcome = StepOutcome {
                status,
                ..StepOutcome::empty()
            };
            assert!(!outcome.is_failure(), "{status}");
        }
        for status in [
            StepAttemptStatus::Failed,
            StepAttemptStatus::Blocked,
            // `unknown` must count as a failure: it means a dispatched command's
            // result never came back, and treating that as success is the one
            // reading the crash-recovery design exists to prevent.
            StepAttemptStatus::Unknown,
            StepAttemptStatus::Cancelled,
            StepAttemptStatus::Pending,
            StepAttemptStatus::Running,
        ] {
            let outcome = StepOutcome {
                status,
                ..StepOutcome::empty()
            };
            assert!(outcome.is_failure(), "{status}");
        }
    }

    /// The regression this feature would otherwise ship with: a proposal the
    /// mode does not cover sitting on `APPROVAL_TIMEOUT_SECS` (600) with nobody
    /// there to answer, then failing the run. With several steps that is hours of
    /// a schedule doing nothing at 3 a.m.
    ///
    /// A `CommandProposal` only ever reaches this sink when `policy_auto_runs`
    /// has already said no, so answering `Skip` at once IS the whole unattended
    /// rule — and it lets the model try another way instead of dying.
    #[tokio::test]
    async fn an_unapprovable_proposal_is_skipped_immediately_not_after_the_timeout() {
        let approvals = Arc::new(ApprovalState::default());
        let skipped = Arc::new(AtomicU32::new(0));
        let sink = auto_skip_sink(approvals.clone(), skipped.clone());

        let rx = approvals.register("ap-1", "req-1");
        let started = std::time::Instant::now();
        // Exactly the shape `run_agent` emits, including the fields the run
        // record keeps.
        sink.send(crate::agent::StreamEvent::CommandProposal {
            approval_id: "ap-1".into(),
            command: "sudo rm -rf /tmp/cache".into(),
            explanation: "clear the cache".into(),
            read_only: false,
            network: false,
            output_policy: crate::agent::OutputPolicy::Normal,
            assessment: crate::agent::policy::assess("sudo rm -rf /tmp/cache"),
            ask_reason: "privileged commands always require approval".into(),
            target_role: None,
            target_session_id: None,
        })
        .unwrap();

        let response = tokio::time::timeout(std::time::Duration::from_secs(1), rx)
            .await
            .expect("the sink must answer at once, not after the approval timeout")
            .expect("the gate must be settled, not dropped");
        assert_eq!(response.decision, ApprovalDecision::Skip);
        assert!(response.edited_command.is_none());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        // Counted, so the run record can say what the schedule wanted to do and
        // was not authorized to.
        assert_eq!(skipped.load(Ordering::Relaxed), 1);
    }

    /// MCP has its own gate with its own 600-second timeout, and `Full` never
    /// bypasses it. A scheduled run pre-approves through the ordinary grant store
    /// or not at all, so an ungranted tool that somehow reaches dispatch must be
    /// refused at once rather than waiting.
    #[tokio::test]
    async fn an_ungranted_mcp_tool_is_refused_at_once_rather_than_waiting() {
        let approvals = Arc::new(ApprovalState::default());
        let sink = auto_skip_sink(approvals.clone(), Arc::new(AtomicU32::new(0)));
        let rx = approvals.register("mcp-1", "req-1");
        sink.send(crate::agent::StreamEvent::McpToolProposal {
            approval_id: "mcp-1".into(),
            server_id: "srv".into(),
            server_name: "Files".into(),
            tool_name: "write_file".into(),
            title: None,
            description: None,
            arguments: serde_json::json!({}),
            schema_hash: "hash".into(),
        })
        .unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), rx)
            .await
            .expect("no gate may be left open in an unattended run")
            .unwrap();
        assert_eq!(response.decision, ApprovalDecision::Skip);
    }

    /// Only the two proposal events settle a gate. An unrelated event must not
    /// answer one — least of all a `Delta`, which arrives constantly.
    #[tokio::test]
    async fn the_sink_ignores_events_that_are_not_proposals() {
        let approvals = Arc::new(ApprovalState::default());
        let skipped = Arc::new(AtomicU32::new(0));
        let sink = auto_skip_sink(approvals.clone(), skipped.clone());
        let mut rx = approvals.register("ap-1", "req-1");
        sink.send(crate::agent::StreamEvent::Delta {
            content: "thinking".into(),
        })
        .unwrap();
        assert!(
            rx.try_recv().is_err(),
            "a delta must not settle an approval"
        );
        assert_eq!(skipped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_blocked_step_counts_a_blocked_command_and_carries_its_reason() {
        let outcome = StepOutcome::blocked("a saved policy rule denies this");
        assert_eq!(outcome.status, StepAttemptStatus::Blocked);
        assert_eq!(outcome.commands_blocked, 1);
        assert!(outcome.error.unwrap().contains("policy rule"));
    }
}
