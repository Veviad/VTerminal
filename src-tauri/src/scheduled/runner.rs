//! The impure half of the tick: read, decide, commit, spawn.
//!
//! `scheduler::evaluate_due` does all the reasoning; this file only moves it in
//! and out of SQLite and hands a committed run to the engine. Two rules govern
//! everything here:
//!
//! * **The database guard is never held across an `.await`.** Decisions are read
//!   into owned values, the guard is dropped, and only then is anything spawned.
//!   The compiler enforces it (a `MutexGuard` is not `Send` and
//!   `tauri::async_runtime::spawn` requires `Send`), but the code is written so it
//!   never comes up.
//! * **A fire is one transaction.** `db::commit_run` inserts the run row and rolls
//!   `next_fire_at` forward together, and a partial unique index refuses a second
//!   in-flight run per action. Either both happened or neither did.

use chrono::{DateTime, Local, TimeZone};
use std::time::Duration;
use tauri::{Emitter, Manager, Wry};

use super::db;
use super::scheduler::{self, DueDecision, DueInputs, SchedulerState};
use super::types::{
    ExecutionMode, RunTrigger, ScheduledAction, ScheduledRunStatus, ScheduledTarget,
};
use super::validate::{self, HostFacts};
use crate::database::{queries, DbState};

/// Emitted to the webview when a run needs a terminal tab. The frontend opens an
/// unfocused tab, connects it if the target is a saved host, and calls
/// `scheduled_run_attach`.
pub const FIRE_EVENT: &str = "scheduled://fire";
/// Emitted when a run reaches a terminal state, so the panel and the header badge
/// refresh without polling.
pub const RUN_EVENT: &str = "scheduled://run";

/// A tab-mode run that nobody attaches is a run that will never happen. Fail it
/// with a reason rather than holding the action's slot indefinitely.
pub const ATTACH_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, serde::Serialize)]
pub struct ScheduledFire {
    pub run_id: String,
    pub action_id: String,
    pub action_name: String,
    pub execution_mode: ExecutionMode,
    pub target_kind: String,
    pub target_label: String,
    pub target_host_id: Option<String>,
    pub target_cwd: Option<String>,
}

#[derive(Clone, serde::Serialize)]
pub struct ScheduledRunNotice {
    pub run_id: String,
    pub action_id: Option<String>,
    pub status: ScheduledRunStatus,
}

pub fn host_facts(conn: &rusqlite::Connection, host_id: &str) -> Option<HostFacts> {
    let host = queries::get_ssh_host(conn, host_id).ok().flatten()?;
    Some(HostFacts {
        id: host.id.clone(),
        label: host.label.clone(),
        has_password: host.has_password,
        has_identity_file: host
            .identity_file
            .as_deref()
            .is_some_and(|p| !p.trim().is_empty()),
        extra_args: host.extra_args.clone(),
    })
}

/// A human-readable target, snapshotted onto the run so history survives a host
/// rename or deletion.
pub fn target_label(conn: &rusqlite::Connection, target: &ScheduledTarget) -> String {
    match target {
        ScheduledTarget::LocalShell { cwd } => match cwd {
            Some(dir) => format!("local shell in {dir}"),
            None => "local shell".to_string(),
        },
        ScheduledTarget::SshHost { host_id } => queries::get_ssh_host(conn, host_id)
            .ok()
            .flatten()
            .map(|h| h.label)
            .unwrap_or_else(|| format!("saved host {host_id}")),
    }
}

/// One committed fire, ready to hand to the engine once the guard is dropped.
pub struct PendingRun {
    pub run_id: String,
    pub action: ScheduledAction,
    pub trigger: RunTrigger,
    pub target_label: String,
}

/// Read every enabled action, decide, and commit. Returns the runs to spawn.
///
/// Called with the guard taken and released inside; nothing here awaits.
fn commit_due_decisions(
    app: &tauri::AppHandle<Wry>,
    now: DateTime<Local>,
    inputs_base: &DueInputs,
) -> Vec<PendingRun> {
    let Some(db) = app.try_state::<DbState>() else {
        return Vec::new();
    };
    let Ok(mut conn) = db.0.lock() else {
        log::warn!("scheduled actions: database mutex poisoned; skipping this tick");
        return Vec::new();
    };
    let actions = match db::enabled_actions(&conn) {
        Ok(actions) => actions,
        Err(e) => {
            log::warn!("scheduled actions: could not read actions: {e}");
            return Vec::new();
        }
    };
    let in_flight = db::in_flight_run_ids(&conn).unwrap_or_default();
    let in_flight_actions: std::collections::HashSet<String> = in_flight
        .iter()
        .filter_map(|id| db::get_run(&conn, id).ok().flatten())
        .filter_map(|run| run.action_id)
        .collect();
    let app_version = app.package_info().version.to_string();
    let mut pending = Vec::new();

    for action in actions {
        let inputs = DueInputs {
            has_run_in_flight: in_flight_actions.contains(&action.id),
            ..inputs_base.clone()
        };
        let decision = scheduler::evaluate_due(&action, now, &inputs);
        let now_iso = db::now_rfc3339();
        match decision {
            DueDecision::None => {}
            DueDecision::Reschedule {
                next_fire_at,
                reason,
            } => {
                let next = next_fire_at.map(|dt| dt.to_utc().to_rfc3339());
                if next.as_deref() != action.next_fire_at.as_deref() {
                    log::info!(
                        "scheduled actions: rescheduling {} — {reason}",
                        action.input.name
                    );
                    let _ = db::set_next_fire(&conn, &action.id, next.as_deref(), &now_iso);
                }
            }
            DueDecision::Skip {
                reason,
                scheduled_for,
                next_fire_at,
                interval_anchor_at,
            } => {
                // An overlap skip is bookkeeping about a run that is still going,
                // so it must not become the action's `last_run_id`.
                let overlaps = inputs.has_run_in_flight;
                let label = target_label(&conn, &action.input.target);
                let plan = serde_json::to_string(&action.input).unwrap_or_else(|_| "{}".into());
                let run_id = uuid::Uuid::new_v4().to_string();
                let next_iso = next_fire_at.map(|dt| dt.to_utc().to_rfc3339());
                let anchor_iso = interval_anchor_at.map(|dt| dt.to_utc().to_rfc3339());
                let commit = db::RunCommit {
                    run_id: &run_id,
                    action: &action,
                    trigger: RunTrigger::Schedule,
                    status: ScheduledRunStatus::Skipped,
                    skip_reason: Some(&reason),
                    target_label: &label,
                    plan_json: &plan,
                    scheduled_for: &scheduled_for.to_utc().to_rfc3339(),
                    next_fire_at: next_iso.as_deref(),
                    interval_anchor_at: anchor_iso.as_deref(),
                    app_version: &app_version,
                    now: &now_iso,
                    advance_projection: !overlaps,
                };
                if let Err(e) = db::commit_run(&mut conn, commit) {
                    log::warn!("scheduled actions: could not record a skipped run: {e}");
                }
            }
            DueDecision::Fire {
                trigger,
                scheduled_for,
                next_fire_at,
                interval_anchor_at,
            } => {
                // Fire-time re-validation. The world moved since the save: a host
                // can gain a password, and an arming can be bypassed by a stale
                // frontend. A refusal here is a recorded failure, not a silent
                // no-op — otherwise the action looks like it simply never ran.
                let host = action
                    .input
                    .target
                    .host_id()
                    .and_then(|id| host_facts(&conn, id));
                let live_sha = db::steps_fingerprint(
                    &action.input.target,
                    &action.input.steps,
                    &action.input.mcp_selection,
                    &action.input.doc_buckets,
                );
                let gate = validate::check_before_fire(
                    &action.input,
                    &action.steps_sha256,
                    &live_sha,
                    action.armed_at.as_deref(),
                    host.as_ref(),
                );
                let tab_allowed = action.input.execution_mode != ExecutionMode::Tab
                    || crate::commands::settings::read_bool(
                        app,
                        super::SETTING_TAB_EXECUTION,
                        false,
                    );
                let refusal = match (&gate, tab_allowed) {
                    (Err(reason), _) => Some(reason.clone()),
                    (Ok(()), false) => Some(
                        "this action runs in a terminal tab, which is switched off in \
                         Settings → Schedules"
                            .to_string(),
                    ),
                    (Ok(()), true) => None,
                };

                let label = target_label(&conn, &action.input.target);
                let plan = serde_json::to_string(&action.input).unwrap_or_else(|_| "{}".into());
                let run_id = uuid::Uuid::new_v4().to_string();
                let next_iso = next_fire_at.map(|dt| dt.to_utc().to_rfc3339());
                let anchor_iso = interval_anchor_at.map(|dt| dt.to_utc().to_rfc3339());
                let status = if refusal.is_some() {
                    ScheduledRunStatus::Skipped
                } else if action.input.execution_mode == ExecutionMode::Tab {
                    ScheduledRunStatus::AwaitingTarget
                } else {
                    ScheduledRunStatus::Pending
                };
                let commit = db::RunCommit {
                    run_id: &run_id,
                    action: &action,
                    trigger,
                    status,
                    skip_reason: refusal.as_deref(),
                    target_label: &label,
                    plan_json: &plan,
                    scheduled_for: &scheduled_for.to_utc().to_rfc3339(),
                    next_fire_at: next_iso.as_deref(),
                    interval_anchor_at: anchor_iso.as_deref(),
                    app_version: &app_version,
                    now: &now_iso,
                    advance_projection: true,
                };
                if let Err(e) = db::commit_run(&mut conn, commit) {
                    // The partial unique index is the durable backstop; landing
                    // here means it did its job.
                    log::warn!(
                        "scheduled actions: could not start {}: {e}",
                        action.input.name
                    );
                    continue;
                }
                if let Some(reason) = refusal {
                    log::warn!(
                        "scheduled actions: refused to run {} — {reason}",
                        action.input.name
                    );
                    continue;
                }
                pending.push(PendingRun {
                    run_id,
                    action,
                    trigger,
                    target_label: label,
                });
            }
        }
    }
    drop(conn);
    pending
}

/// One tick: decide, commit, then spawn each committed run.
pub async fn tick(
    app: &tauri::AppHandle<Wry>,
    state: &std::sync::Arc<SchedulerState>,
    now: DateTime<Local>,
) {
    let inputs = DueInputs {
        app_uptime_secs: state.uptime_secs(),
        machine_timezone: scheduler::machine_timezone(),
        has_run_in_flight: false,
    };
    let pending = commit_due_decisions(app, now, &inputs);
    for run in pending {
        spawn_run(app, state, run);
    }
}

/// Recompute every stored occurrence without firing anything.
///
/// Used after a backwards wall-clock jump, where every persisted `next_fire_at`
/// is meaningless and firing the resulting "backlog" would be wrong.
pub fn reschedule_all(app: &tauri::AppHandle<Wry>, now: DateTime<Local>) {
    let Some(db) = app.try_state::<DbState>() else {
        return;
    };
    let Ok(conn) = db.0.lock() else { return };
    let Ok(actions) = db::enabled_actions(&conn) else {
        return;
    };
    let now_iso = db::now_rfc3339();
    for action in actions {
        let anchor = action
            .interval_anchor_at
            .as_deref()
            .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
            .map(|dt| now.timezone().from_utc_datetime(&dt.naive_utc()));
        let next = super::recurrence::next_fire_after(&action.input.recurrence, anchor, now)
            .map(|dt| dt.to_utc().to_rfc3339());
        let _ = db::set_next_fire(&conn, &action.id, next.as_deref(), &now_iso);
    }
}

/// How long until the earliest stored occurrence, so a quiet app is not spinning
/// once a second. Capped by the caller at `TICK_MAX`.
pub fn earliest_delay(app: &tauri::AppHandle<Wry>, now: DateTime<Local>) -> Option<Duration> {
    let db = app.try_state::<DbState>()?;
    let conn = db.0.lock().ok()?;
    let earliest: Option<String> = conn
        .query_row(
            "SELECT MIN(next_fire_at) FROM scheduled_actions
               WHERE enabled = 1 AND next_fire_at IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    drop(conn);
    let at = DateTime::parse_from_rfc3339(&earliest?).ok()?;
    let seconds = at.signed_duration_since(now).num_seconds();
    Some(Duration::from_secs(seconds.clamp(1, 3600) as u64))
}

/// Take the concurrency permit and drive one run to a terminal state.
///
/// The permit is held for the whole run, so a launch with several owed catch-ups
/// is a queue rather than a thundering herd. Tab mode emits its fire event and
/// waits for the frontend to attach.
pub fn spawn_run(
    app: &tauri::AppHandle<Wry>,
    state: &std::sync::Arc<SchedulerState>,
    pending: PendingRun,
) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let permit = scheduler::acquire_run_permit(&state).await;
        if permit.is_none() {
            finish_run(
                &app,
                &pending.run_id,
                Some(pending.action.id.clone()),
                ScheduledRunStatus::Failed,
                Some("the scheduler could not take a run slot"),
            );
            return;
        }
        let cancel = state.register_cancel(&pending.run_id);
        if pending.action.input.execution_mode == ExecutionMode::Tab {
            let fire = ScheduledFire {
                run_id: pending.run_id.clone(),
                action_id: pending.action.id.clone(),
                action_name: pending.action.input.name.clone(),
                execution_mode: ExecutionMode::Tab,
                target_kind: pending.action.input.target.kind_str().to_string(),
                target_label: pending.target_label.clone(),
                target_host_id: pending.action.input.target.host_id().map(|s| s.to_string()),
                target_cwd: pending
                    .action
                    .input
                    .target
                    .local_cwd()
                    .map(|s| s.to_string()),
            };
            if let Err(e) = app.emit(FIRE_EVENT, fire) {
                log::warn!("scheduled actions: could not emit the fire event: {e}");
            }
            // The frontend now owns the next move. `scheduled_run_attach` drives
            // the rest; this task holds the permit and enforces the two deadlines.
            super::runner::watch_tab_run(&app, &state, &pending).await;
        } else {
            let outcome = crate::scheduled::engine::execute_run(
                &app,
                &pending.run_id,
                &pending.action,
                pending.trigger,
                cancel,
            )
            .await;
            match outcome {
                Ok(status) => finish_run(
                    &app,
                    &pending.run_id,
                    Some(pending.action.id.clone()),
                    status,
                    None,
                ),
                Err(error) => finish_run(
                    &app,
                    &pending.run_id,
                    Some(pending.action.id.clone()),
                    ScheduledRunStatus::Failed,
                    Some(&error),
                ),
            }
        }
        state.release_cancel(&pending.run_id);
        state.wake();
    });
}

/// Hold a tab-mode run's permit and enforce its two deadlines.
///
/// Two, because the failure modes are different and only one of them has an
/// obvious owner:
///
/// * **Attach.** A run the frontend never picks up would otherwise sit in
///   `awaiting_target` forever.
/// * **The whole run.** Once attached, the frontend owns every step — and if the
///   webview goes away mid-run (a reload, a crash, a hung `runInTerminal`), the
///   row stays `running`. That is not merely untidy: `running` holds the partial
///   unique index that enforces one in-flight run per action, so the action would
///   be silently disabled until the next app start reconciled it. The wall-clock
///   budget the user set is the right ceiling to apply here.
///
/// Deliberately does NOT cancel the terminal's work. Commands run in the user's
/// own shell; the run stops claiming to be in progress, and anything still
/// executing is reported as unknown rather than pretended dead.
async fn watch_tab_run(
    app: &tauri::AppHandle<Wry>,
    state: &std::sync::Arc<SchedulerState>,
    pending: &PendingRun,
) {
    let attach_deadline = tokio::time::Instant::now() + ATTACH_TIMEOUT;
    let run_deadline = tokio::time::Instant::now()
        + Duration::from_secs(u64::from(pending.action.input.max_run_secs));
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if state.is_cancelled(&pending.run_id) {
            return;
        }
        let now = tokio::time::Instant::now();
        match current_status(app, &pending.run_id) {
            Some(ScheduledRunStatus::AwaitingTarget) => {
                if now >= attach_deadline {
                    finish_run(
                        app,
                        &pending.run_id,
                        Some(pending.action.id.clone()),
                        ScheduledRunStatus::Failed,
                        Some("no terminal was attached to this run"),
                    );
                    return;
                }
            }
            Some(ScheduledRunStatus::Running) => {
                if now >= run_deadline {
                    finish_run(
                        app,
                        &pending.run_id,
                        Some(pending.action.id.clone()),
                        ScheduledRunStatus::Failed,
                        Some(
                            "the run exceeded its time budget. Any command still executing in \
                             the terminal was left alone — it is your shell.",
                        ),
                    );
                    return;
                }
            }
            // Terminal, or the row is gone: not this task's business any more.
            _ => return,
        }
    }
}

pub fn current_action_id(app: &tauri::AppHandle<Wry>, run_id: &str) -> Option<String> {
    let db = app.try_state::<DbState>()?;
    let conn = db.0.lock().ok()?;
    db::get_run(&conn, run_id).ok().flatten()?.action_id
}

pub fn current_status(app: &tauri::AppHandle<Wry>, run_id: &str) -> Option<ScheduledRunStatus> {
    let db = app.try_state::<DbState>()?;
    let conn = db.0.lock().ok()?;
    db::get_run(&conn, run_id).ok().flatten().map(|r| r.status)
}

/// Write a terminal status and tell the webview. Every terminal path goes through
/// here so a status can never be recorded without the panel learning about it.
///
/// `action_id` is `None` once the action has been deleted — the run record
/// outlives it, and an empty string would read downstream as an action whose id
/// is the empty string.
pub fn finish_run(
    app: &tauri::AppHandle<Wry>,
    run_id: &str,
    action_id: Option<String>,
    status: ScheduledRunStatus,
    error: Option<&str>,
) {
    if let Some(db) = app.try_state::<DbState>() {
        if let Ok(conn) = db.0.lock() {
            let now = db::now_rfc3339();
            if let Err(e) = db::set_run_status(&conn, run_id, status, error, &now) {
                log::warn!("scheduled actions: could not record run status: {e}");
            }
        }
    }
    let _ = app.emit(
        RUN_EVENT,
        ScheduledRunNotice {
            run_id: run_id.to_string(),
            action_id,
            status,
        },
    );
    // Metadata only. No goal text, no commands, no output, no provider error
    // bodies reach the log file.
    log::info!("scheduled run {run_id} finished as {status}");
}
