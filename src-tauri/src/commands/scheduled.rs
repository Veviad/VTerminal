//! IPC for Scheduled Actions.
//!
//! Every command starts with `gate(&app)`. That is not UI sugar: a frontend flag
//! hides a button, while this is what keeps the backend capability unreachable on
//! a default install — including from a stale or tampered webview. Same shape as
//! `commands::runbooks::gate`.

use tauri::{State, Wry};

use crate::database::DbState;
use crate::scheduled::{db, recurrence, runner, scheduler, types::*, validate};

fn gate(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if crate::commands::settings::read_bool(app, crate::scheduled::SETTING_ENABLED, false) {
        Ok(())
    } else {
        Err("scheduled actions are switched off — enable them in Settings → Schedules".into())
    }
}

/// The list-view row. Deliberately the whole action: the editor needs every field
/// anyway, and a second summary shape would be a second place for a wire literal
/// to drift.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_actions_list(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
) -> Result<Vec<ScheduledAction>, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::list_actions(&conn)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_get(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    id: String,
) -> Result<Option<ScheduledAction>, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::get_action(&conn, &id)
}

/// Live editor feedback. Same rules as create/update, no writes.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_validate(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    input: ScheduledActionInput,
) -> Result<Vec<ScheduledValidationIssue>, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let host = input
        .target
        .host_id()
        .and_then(|id| runner::host_facts(&conn, id));
    Ok(validate::validate(&input, host.as_ref()))
}

/// The next `count` fire times, rendered. Makes DST and weekday arithmetic
/// inspectable before anything is saved, and shares ONE implementation with the
/// scheduler so a preview can never disagree with what actually happens.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_preview(
    app: tauri::AppHandle<Wry>,
    recurrence_rule: Recurrence,
    count: u32,
) -> Result<Vec<String>, String> {
    gate(&app)?;
    let now = chrono::Local::now();
    Ok(
        recurrence::preview(&recurrence_rule, None, now, count.clamp(1, 10) as usize)
            .into_iter()
            .map(|dt| dt.to_rfc3339())
            .collect(),
    )
}

/// Whether saving this input should keep the armed permission mode.
///
/// Any change to the steps, the target or the attachments resets the mode to
/// `ask` and requires re-arming as an explicit act. The codebase's own model of
/// authorization is gesture-bound (`permissionMode.ts`: "Explicitly selecting
/// Full may release the exact approval already on screen as part of that user
/// gesture"), and a mode that silently carries over onto different steps is not a
/// gesture the user made.
fn resolve_arming(
    previous: Option<&ScheduledAction>,
    input: &ScheduledActionInput,
    fingerprint: &str,
    now: &str,
) -> (crate::agent::PermissionMode, Option<String>) {
    if input.permission_mode == crate::agent::PermissionMode::Ask {
        return (crate::agent::PermissionMode::Ask, None);
    }
    match previous {
        // Unchanged authorization surface, same mode: keep the original arming
        // timestamp so an audit shows when the user actually chose it.
        Some(prev)
            if prev.steps_sha256 == fingerprint
                && prev.input.permission_mode == input.permission_mode
                && prev.armed_at.is_some() =>
        {
            (input.permission_mode, prev.armed_at.clone())
        }
        // Everything else — a new action, edited steps, a retarget, a changed
        // mode — is a fresh arming, made now, by this save.
        _ => (input.permission_mode, Some(now.to_string())),
    }
}

fn save(
    app: &tauri::AppHandle<Wry>,
    db_state: &State<'_, DbState>,
    id: String,
    mut input: ScheduledActionInput,
) -> Result<ScheduledAction, String> {
    input.name = input.name.trim().to_string();
    input.permission_mode = validate::clamp_for_schedule(input.permission_mode)?;
    for (index, step) in input.steps.iter_mut().enumerate() {
        step.sort_order = index as u32;
        step.text = step.text.trim().to_string();
        if step.title.trim().is_empty() {
            step.title = format!("Step {}", index + 1);
        }
    }

    let mut conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let host = input
        .target
        .host_id()
        .and_then(|hid| runner::host_facts(&conn, hid));
    let issues = validate::validate(&input, host.as_ref());
    if let Some(blocking) = issues.iter().find(|issue| issue.blocking) {
        return Err(blocking.message.clone());
    }

    let previous = db::get_action(&conn, &id)?;
    let fingerprint = db::steps_fingerprint(
        &input.target,
        &input.steps,
        &input.mcp_selection,
        &input.doc_buckets,
    );
    let now = db::now_rfc3339();
    let (mode, armed_at) = resolve_arming(previous.as_ref(), &input, &fingerprint, &now);
    input.permission_mode = mode;

    // Recompute from `now` rather than carrying the old value: the recurrence may
    // have changed, and an action is never fired on the first sight of a rule.
    let anchor = previous.as_ref().and_then(|p| {
        p.interval_anchor_at
            .as_deref()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|dt| dt.with_timezone(&chrono::Local))
    });
    let next_fire = if input.enabled {
        recurrence::next_fire_after(&input.recurrence, anchor, chrono::Local::now())
            .map(|dt| dt.to_utc().to_rfc3339())
    } else {
        None
    };
    let anchor_iso = previous.as_ref().and_then(|p| p.interval_anchor_at.clone());

    db::upsert_action(
        &mut conn,
        &id,
        &input,
        &fingerprint,
        armed_at.as_deref(),
        next_fire.as_deref(),
        anchor_iso.as_deref(),
        &now,
    )?;
    let saved = db::get_action(&conn, &id)?
        .ok_or_else(|| "the action could not be read back after saving".to_string())?;
    drop(conn);

    // Wake the loop so a schedule saved for ten seconds out fires on time rather
    // than up to a minute late.
    scheduler::start_if_enabled(app);
    if let Some(state) = scheduler::state(app) {
        state.wake();
    }
    Ok(saved)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_create(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    input: ScheduledActionInput,
) -> Result<ScheduledAction, String> {
    gate(&app)?;
    let id = uuid::Uuid::new_v4().to_string();
    save(&app, &db_state, id, input)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_update(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    id: String,
    input: ScheduledActionInput,
) -> Result<ScheduledAction, String> {
    gate(&app)?;
    save(&app, &db_state, id, input)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_set_enabled(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    id: String,
    enabled: bool,
) -> Result<ScheduledAction, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let action = db::get_action(&conn, &id)?.ok_or_else(|| "no such action".to_string())?;
    let now = db::now_rfc3339();
    db::set_enabled(&conn, &id, enabled, &now)?;
    // Enabling recomputes; disabling clears, so a re-enable is never treated as a
    // pile of missed occurrences.
    let next = if enabled {
        recurrence::next_fire_after(&action.input.recurrence, None, chrono::Local::now())
            .map(|dt| dt.to_utc().to_rfc3339())
    } else {
        None
    };
    db::set_next_fire(&conn, &id, next.as_deref(), &now)?;
    let saved = db::get_action(&conn, &id)?
        .ok_or_else(|| "the action could not be read back".to_string())?;
    drop(conn);
    if let Some(state) = scheduler::state(&app) {
        state.wake();
    }
    Ok(saved)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_delete(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    gate(&app)?;
    // Cancel first: deleting the row while a run of it is in flight would leave
    // an orphaned in-flight run with no action to report against.
    if let Some(state) = scheduler::state(&app) {
        let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
        let in_flight = db::in_flight_run_ids(&conn).unwrap_or_default();
        let mine: Vec<String> = in_flight
            .into_iter()
            .filter(|run_id| {
                db::get_run(&conn, run_id)
                    .ok()
                    .flatten()
                    .and_then(|r| r.action_id)
                    .as_deref()
                    == Some(id.as_str())
            })
            .collect();
        drop(conn);
        for run_id in mine {
            state.cancel(&run_id);
        }
    }
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::delete_action(&conn, &id)
}

/// Fire now, on a human's gesture. `trigger = manual` on the record, because a
/// run at 15:04 that the user asked for is a different fact from one the clock
/// asked for.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_action_run_now(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    id: String,
) -> Result<String, String> {
    gate(&app)?;
    let state = scheduler::state(&app).ok_or("the scheduler is not running")?;
    let mut conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let action = db::get_action(&conn, &id)?.ok_or_else(|| "no such action".to_string())?;

    let host = action
        .input
        .target
        .host_id()
        .and_then(|hid| runner::host_facts(&conn, hid));
    let live = db::steps_fingerprint(
        &action.input.target,
        &action.input.steps,
        &action.input.mcp_selection,
        &action.input.doc_buckets,
    );
    validate::check_before_fire(
        &action.input,
        &action.steps_sha256,
        &live,
        action.armed_at.as_deref(),
        host.as_ref(),
    )?;
    if action.input.execution_mode == ExecutionMode::Tab
        && !crate::commands::settings::read_bool(
            &app,
            crate::scheduled::SETTING_TAB_EXECUTION,
            false,
        )
    {
        return Err(
            "tab execution is switched off — enable it in Settings → Schedules, or set this \
             action to run headless"
                .into(),
        );
    }

    let label = runner::target_label(&conn, &action.input.target);
    let plan = serde_json::to_string(&action.input).map_err(|e| e.to_string())?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let now = db::now_rfc3339();
    let status = if action.input.execution_mode == ExecutionMode::Tab {
        ScheduledRunStatus::AwaitingTarget
    } else {
        ScheduledRunStatus::Pending
    };
    // `next_fire_at` is unchanged: a manual run is not an occurrence, and moving
    // the schedule because someone pressed a button would be surprising.
    db::commit_run(
        &mut conn,
        db::RunCommit {
            run_id: &run_id,
            action: &action,
            trigger: RunTrigger::Manual,
            status,
            skip_reason: None,
            target_label: &label,
            plan_json: &plan,
            scheduled_for: &now,
            next_fire_at: action.next_fire_at.as_deref(),
            interval_anchor_at: None,
            app_version: &app.package_info().version.to_string(),
            now: &now,
            advance_projection: true,
        },
    )?;
    drop(conn);

    runner::spawn_run(
        &app,
        &state,
        runner::PendingRun {
            run_id: run_id.clone(),
            action,
            trigger: RunTrigger::Manual,
            target_label: label,
        },
    );
    Ok(run_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_run_cancel(app: tauri::AppHandle<Wry>, run_id: String) -> Result<(), String> {
    gate(&app)?;
    let state = scheduler::state(&app).ok_or("the scheduler is not running")?;
    if !state.cancel(&run_id) {
        return Err("that run is no longer active".into());
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_runs_list(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    action_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ScheduledRun>, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::list_runs(&conn, action_id.as_deref(), limit.unwrap_or(50))
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_run_get(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
) -> Result<Option<ScheduledRun>, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::get_run(&conn, &run_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_run_delete(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
) -> Result<(), String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::delete_run(&conn, &run_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_runs_prune(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    before: String,
) -> Result<u32, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    db::prune_runs(&conn, &before)
}

// ---------------------------------------------------- tab-mode execution ----
//
// A tab-mode run is driven by the frontend, and deliberately so: `startAgent`
// already runs the agent loop with `ExecTarget::Pty` and already round-trips
// `RunInTerminal` through `lib/ptyExec.ts`, so a prompt step in a tab is the
// existing, tested machinery with a seeded permission mode. What the backend
// still owns is the RECORD — and the intent row it writes before each dispatch
// is what makes a crash mid-step legible afterwards.
//
// The lease discipline: `scheduled_step_begin` mints the attempt id, and
// `scheduled_step_finish` refuses one it did not mint for that run. A webview
// can therefore never submit a result for work the backend did not hand it.

/// What the frontend observed for one step.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct StepResultInput {
    pub status: String,
    #[serde(default)]
    pub executed_command: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub output_tail: Option<String>,
    #[serde(default)]
    pub output_truncated: bool,
    #[serde(default)]
    pub termination: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub commands_executed: u32,
    #[serde(default)]
    pub commands_skipped: u32,
    #[serde(default)]
    pub commands_blocked: u32,
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

/// Bind a run to the tab the frontend opened for it.
///
/// The target check is not optional: a bug or a stale frontend could otherwise
/// attach a LOCAL tab to a remote-scoped schedule, and every saved remote policy
/// rule would then be evaluated against the wrong machine while
/// `policy_scope_single` still claimed `remote:<id>`.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_run_attach(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
    session_id: String,
    remote_host_id: Option<String>,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let run = db::get_run(&conn, &run_id)?.ok_or_else(|| "no such run".to_string())?;
    if run.status != ScheduledRunStatus::AwaitingTarget {
        return Err("that run is not waiting for a terminal".into());
    }
    if run.execution_mode != ExecutionMode::Tab {
        return Err("that run does not execute in a terminal tab".into());
    }
    if run.target_host_id.as_deref() != remote_host_id.as_deref() {
        return Err(format!(
            "this run targets {}, but the terminal offered is {}",
            run.target_host_id.as_deref().unwrap_or("the local machine"),
            remote_host_id.as_deref().unwrap_or("the local machine"),
        ));
    }
    // The same guard `engine::execute_run` applies before a headless run.
    // `createSession` deliberately treats an unresolvable cwd as non-fatal and
    // logs it, which is right when a person opens a tab and wrong for an
    // unattended run — that would silently execute in whatever directory the
    // shell landed in. Checked from the stored action rather than from anything
    // the webview sent.
    if let Some(action_id) = run.action_id.as_deref() {
        if let Some(action) = db::get_action(&conn, action_id)? {
            if let Some(dir) = action.input.target.local_cwd() {
                if !std::path::Path::new(dir).is_dir() {
                    return Err(format!(
                        "the working directory {dir} no longer exists on this machine"
                    ));
                }
            }
        }
    }
    let now = db::now_rfc3339();
    db::set_run_target(&conn, &run_id, &session_id, cols.max(1), rows.max(1), &now)?;
    db::set_run_status(&conn, &run_id, ScheduledRunStatus::Running, None, &now)?;
    Ok(())
}

/// Write the intent row and lease its id to the caller. Called BEFORE dispatch,
/// which is the whole crash-recovery contract.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_step_begin(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
    step_id: String,
    sort_order: u32,
    kind: String,
    title: String,
) -> Result<String, String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let run = db::get_run(&conn, &run_id)?.ok_or_else(|| "no such run".to_string())?;
    if run.status != ScheduledRunStatus::Running {
        return Err("that run is not executing".into());
    }
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let now = db::now_rfc3339();
    let attempt = StepAttempt {
        id: attempt_id.clone(),
        run_id: run_id.clone(),
        step_id,
        sort_order,
        kind: kind.parse().map_err(|_| "unknown step kind".to_string())?,
        title,
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
        intent_at: now.clone(),
        started_at: None,
        finished_at: None,
        duration_ms: None,
    };
    db::insert_attempt(&conn, &attempt)?;
    db::mark_attempt_running(&conn, &attempt_id, &now)?;
    Ok(attempt_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_step_finish(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
    attempt_id: String,
    result: StepResultInput,
) -> Result<(), String> {
    gate(&app)?;
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    let run = db::get_run(&conn, &run_id)?.ok_or_else(|| "no such run".to_string())?;
    // Never accept a result for work this backend did not lease to this webview.
    let existing = run
        .attempts
        .iter()
        .find(|a| a.id == attempt_id)
        .ok_or_else(|| "that step was not dispatched by this run".to_string())?;
    let status: StepAttemptStatus = result
        .status
        .parse()
        .map_err(|_| "unknown step status".to_string())?;
    let now = db::now_rfc3339();
    let finished = StepAttempt {
        status,
        executed_command: result.executed_command,
        exit_code: result.exit_code,
        output_tail: result.output_tail,
        output_truncated: result.output_truncated,
        termination: result.termination,
        summary: result.summary,
        commands_executed: result.commands_executed,
        commands_skipped: result.commands_skipped,
        commands_blocked: result.commands_blocked,
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        error: result.error,
        finished_at: Some(now.clone()),
        duration_ms: result.duration_ms,
        ..existing.clone()
    };
    db::finish_attempt(&conn, &finished)?;
    if finished.prompt_tokens > 0 || finished.completion_tokens > 0 {
        db::add_run_usage(
            &conn,
            &run_id,
            finished.prompt_tokens,
            finished.completion_tokens,
            &now,
        )?;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_run_finish(
    app: tauri::AppHandle<Wry>,
    run_id: String,
    status: String,
    error: Option<String>,
) -> Result<(), String> {
    gate(&app)?;
    let status: ScheduledRunStatus = status
        .parse()
        .map_err(|_| "unknown run status".to_string())?;
    if !status.is_terminal() {
        return Err("a run may only be finished with a terminal status".into());
    }
    // `skipped` carries a reason column with a CHECK that pairs the two, and this
    // path has no reason to give — so a frontend must not claim it.
    if status == ScheduledRunStatus::Skipped {
        return Err("a tab run cannot report itself skipped".into());
    }
    let action_id = runner::current_action_id(&app, &run_id);
    runner::finish_run(&app, &run_id, action_id, status, error.as_deref());
    if let Some(state) = scheduler::state(&app) {
        state.release_cancel(&run_id);
        state.wake();
    }
    Ok(())
}

/// Whether the run the frontend is driving has been revoked — by a cancel, or by
/// the feature being switched off. Polled before each dispatch, the same shape as
/// the runbook driver's `canWrite` guard.
#[tauri::command(rename_all = "snake_case")]
pub fn scheduled_run_is_active(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
) -> Result<bool, String> {
    if gate(&app).is_err() {
        return Ok(false);
    }
    if scheduler::state(&app).is_some_and(|state| state.is_cancelled(&run_id)) {
        return Ok(false);
    }
    let conn = db_state.0.lock().map_err(|_| "db poisoned")?;
    Ok(db::get_run(&conn, &run_id)?.is_some_and(|run| run.status == ScheduledRunStatus::Running))
}

/// Names the scheduled actions that keep an ssh host alive.
///
/// `ON DELETE RESTRICT` on `scheduled_actions.target_host_id` is the enforcement;
/// this exists so the user gets "3 scheduled actions target this host" instead of
/// a raw SQLite foreign-key error.
pub fn blocking_actions_for_host(
    conn: &rusqlite::Connection,
    host_id: &str,
) -> Result<Vec<String>, String> {
    db::actions_targeting_host(conn, host_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::PermissionMode;
    use crate::mcp::config::McpChatSelection;

    fn action(mode: PermissionMode, sha: &str, armed: Option<&str>) -> ScheduledAction {
        ScheduledAction {
            id: "a1".into(),
            input: input(mode),
            armed_at: armed.map(str::to_string),
            steps_sha256: sha.into(),
            next_fire_at: None,
            interval_anchor_at: None,
            last_fire_at: None,
            last_run_id: None,
            last_status: None,
            last_error: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    fn input(mode: PermissionMode) -> ScheduledActionInput {
        ScheduledActionInput {
            name: "nightly".into(),
            enabled: true,
            target: ScheduledTarget::LocalShell { cwd: None },
            steps: vec![ScheduledStep {
                id: "s1".into(),
                sort_order: 0,
                title: "step".into(),
                kind: StepKind::Command,
                text: "df -h".into(),
                continue_on_failure: false,
            }],
            execution_mode: ExecutionMode::Headless,
            permission_mode: mode,
            recurrence: Recurrence::Daily {
                at: TimeOfDay { hour: 3, minute: 0 },
            },
            missed_run_policy: MissedRunPolicy::Skip,
            timezone: "Europe/Berlin".into(),
            mcp_selection: McpChatSelection::default(),
            doc_buckets: Vec::new(),
            web_access: false,
            max_iterations: 10,
            command_timeout_secs: 120,
            max_run_secs: 3600,
            close_tab_when_done: false,
        }
    }

    #[test]
    fn a_new_action_with_a_mode_is_armed_by_the_save_that_created_it() {
        let (mode, armed) = resolve_arming(None, &input(PermissionMode::AutoRead), "sha", "now");
        assert_eq!(mode, PermissionMode::AutoRead);
        assert_eq!(armed.as_deref(), Some("now"));
    }

    #[test]
    fn ask_needs_no_arming_at_all() {
        let (mode, armed) = resolve_arming(None, &input(PermissionMode::Ask), "sha", "now");
        assert_eq!(mode, PermissionMode::Ask);
        assert!(
            armed.is_none(),
            "`ask` authorizes nothing, so there is nothing to arm"
        );
    }

    #[test]
    fn an_unchanged_save_keeps_the_original_arming_timestamp() {
        let prev = action(PermissionMode::AutoRead, "sha", Some("january"));
        let (_, armed) =
            resolve_arming(Some(&prev), &input(PermissionMode::AutoRead), "sha", "june");
        assert_eq!(
            armed.as_deref(),
            Some("january"),
            "an audit must show when the user actually chose the mode"
        );
    }

    /// The property that matters: a persisted mode must never silently carry over
    /// onto steps the user did not authorize it for.
    #[test]
    fn editing_the_steps_re_arms_so_the_timestamp_moves() {
        let prev = action(PermissionMode::AutoRead, "sha-old", Some("january"));
        let (_, armed) = resolve_arming(
            Some(&prev),
            &input(PermissionMode::AutoRead),
            "sha-new",
            "june",
        );
        assert_eq!(armed.as_deref(), Some("june"));
    }

    #[test]
    fn raising_the_mode_re_arms_even_when_the_steps_are_identical() {
        let prev = action(PermissionMode::AutoRead, "sha", Some("january"));
        let (mode, armed) =
            resolve_arming(Some(&prev), &input(PermissionMode::AutoAll), "sha", "june");
        assert_eq!(mode, PermissionMode::AutoAll);
        assert_eq!(armed.as_deref(), Some("june"));
    }

    #[test]
    fn a_previously_unarmed_action_is_armed_on_the_next_save() {
        let prev = action(PermissionMode::AutoRead, "sha", None);
        let (_, armed) =
            resolve_arming(Some(&prev), &input(PermissionMode::AutoRead), "sha", "june");
        assert_eq!(armed.as_deref(), Some("june"));
    }
}
