//! Deciding what is due, and the task that asks.
//!
//! The decision is a **pure function of an action and a moment**
//! (`evaluate_due`), so every rule below is testable without a clock, a database
//! or a Tauri runtime. The loop around it does three things and no reasoning.
//!
//! ## Timezones
//!
//! Wall-clock rules resolve in `chrono::Local` — the machine's zone — which is
//! what a desktop scheduler means by "daily at 09:00" and which handles DST
//! correctly because `from_local_datetime` returns a `LocalResult` this code
//! always matches on. The action's stored IANA id is therefore not used to
//! *resolve* a fire; it records the zone the schedule was authored in, so that a
//! machine which has since moved can be noticed (rule 3) instead of silently
//! reporting every rule as a missed run.
//!
//! ## Why there is no launch special case
//!
//! Rolling `next_fire_at` forward past `now` on every fire and every skip is what
//! collapses sixteen missed slots into one occurrence. That makes "catch up
//! exactly once" structural rather than a flag somebody has to remember to
//! clear, and it makes app-was-closed and laptop-was-asleep the same code path —
//! which is also how the user thinks about them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, TimeZone};
use tauri::{Manager, Wry};

use super::recurrence::next_fire_after;
use super::types::{MissedRunPolicy, Recurrence, RunTrigger, ScheduledAction, ScheduledRunStatus};
use super::validate;

/// Never sleep to a deadline. `tokio::time::sleep` is monotonic and does not
/// advance across macOS sleep, so a lid closed at 01:00 would fire the 02:00
/// occurrence at 09:00 believing it was on time. Waking at least once a minute
/// and re-reading the wall clock is what makes sleep, an NTP step and a manual
/// clock change all visible within a minute.
pub const TICK_MAX: Duration = Duration::from_secs(60);

/// Past this, an occurrence was missed rather than merely late — the process was
/// not running when it came due — and the per-action policy decides.
const FRESH_WINDOW_SECS: i64 = 120;

/// A catch-up older than this is history, not work. Firing a week-old backup at
/// 09:00 on a Monday is never what anyone meant.
const CATCH_UP_MAX_AGE_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq)]
pub enum DueDecision<Tz: TimeZone> {
    /// Nothing to do.
    None,
    /// Persist a recomputed `next_fire_at`. Never fires — an action is never run
    /// on the first sight of its rule.
    Reschedule {
        next_fire_at: Option<DateTime<Tz>>,
        reason: &'static str,
    },
    /// Record a real `skipped` run so the history shows the gap, and roll forward.
    Skip {
        reason: String,
        scheduled_for: DateTime<Tz>,
        next_fire_at: Option<DateTime<Tz>>,
        interval_anchor_at: Option<DateTime<Tz>>,
    },
    Fire {
        trigger: RunTrigger,
        scheduled_for: DateTime<Tz>,
        next_fire_at: Option<DateTime<Tz>>,
        interval_anchor_at: Option<DateTime<Tz>>,
    },
}

/// Everything `evaluate_due` needs that is not on the action itself.
#[derive(Debug, Clone)]
pub struct DueInputs {
    /// How long this process has been up. Gates catch-up: the app's most fragile
    /// and least observed moment is not when to start executing commands.
    pub app_uptime_secs: u64,
    /// The machine's current IANA zone, if it can be determined.
    pub machine_timezone: Option<String>,
    /// True while a run of this action is already in flight. The partial unique
    /// index is the durable backstop; this is the friendly one.
    pub has_run_in_flight: bool,
}

fn parse_in<Tz: TimeZone>(value: Option<&str>, tz: &Tz) -> Option<DateTime<Tz>> {
    let parsed = DateTime::parse_from_rfc3339(value?).ok()?;
    Some(tz.from_utc_datetime(&parsed.naive_utc()))
}

/// How far ahead a stored `next_fire_at` can plausibly sit for its own rule.
/// Beyond it, the clock moved (NTP corrected a wildly wrong clock, or somebody
/// set the date by hand) and the stored value is meaningless.
fn plausible_horizon_days(rule: &Recurrence) -> Option<i64> {
    match rule {
        Recurrence::Interval { every_minutes } => Some((*every_minutes as i64 / (24 * 60)) + 2),
        Recurrence::Daily { .. } => Some(2),
        Recurrence::Weekly { .. } => Some(9),
        // A one-off legitimately sits years out.
        Recurrence::Once { .. } => None,
    }
}

/// The one place that decides whether an action runs.
pub fn evaluate_due<Tz: TimeZone>(
    action: &ScheduledAction,
    now: DateTime<Tz>,
    inputs: &DueInputs,
) -> DueDecision<Tz> {
    if !action.input.enabled {
        return DueDecision::None;
    }
    let tz = now.timezone();
    let anchor = parse_in(action.interval_anchor_at.as_deref(), &tz);
    let roll = |from: DateTime<Tz>, new_anchor: Option<DateTime<Tz>>| {
        next_fire_after(
            &action.input.recurrence,
            new_anchor.clone().or_else(|| anchor.clone()),
            from,
        )
    };

    let Some(next_fire_at) = parse_in(action.next_fire_at.as_deref(), &tz) else {
        return DueDecision::Reschedule {
            next_fire_at: roll(now, None),
            reason: "no next occurrence was stored",
        };
    };

    // Rule 3: the machine moved. A `next_fire_at` computed in one zone is simply
    // wrong in another, and treating the difference as a missed run would report
    // a gap that never happened.
    if let Some(machine) = inputs.machine_timezone.as_deref() {
        let stored = action.input.timezone.trim();
        if !stored.is_empty() && !machine.is_empty() && stored != machine {
            return DueDecision::Reschedule {
                next_fire_at: roll(now, None),
                reason: "the machine's timezone changed since this was scheduled",
            };
        }
    }

    // A clock that jumped backwards leaves every stored fire implausibly far
    // ahead. Recompute rather than sleeping for a year.
    if let Some(days) = plausible_horizon_days(&action.input.recurrence) {
        if next_fire_at.clone().signed_duration_since(now.clone()) > chrono::Duration::days(days) {
            return DueDecision::Reschedule {
                next_fire_at: roll(now, None),
                reason: "the stored next occurrence is implausibly far ahead",
            };
        }
    }

    if next_fire_at > now {
        return DueDecision::None;
    }

    // An overlapping fire is skipped, never queued. Queueing is how a
    // five-minute action whose run takes six minutes becomes an unbounded
    // backlog of shells.
    if inputs.has_run_in_flight {
        return DueDecision::Skip {
            reason: "the previous run of this action was still going".to_string(),
            scheduled_for: next_fire_at,
            next_fire_at: roll(now.clone(), Some(now)),
            interval_anchor_at: None,
        };
    }

    let overdue = now.clone().signed_duration_since(next_fire_at.clone());
    if overdue.num_seconds() <= FRESH_WINDOW_SECS {
        // On time. Anchor to the SLOT, not to `now`, so an interval grid does not
        // drift by up to two minutes on every fire.
        return DueDecision::Fire {
            trigger: RunTrigger::Schedule,
            scheduled_for: next_fire_at.clone(),
            next_fire_at: roll(now, Some(next_fire_at.clone())),
            interval_anchor_at: Some(next_fire_at),
        };
    }

    match action.input.missed_run_policy {
        MissedRunPolicy::Skip => DueDecision::Skip {
            reason: "the app was not running at the scheduled time".to_string(),
            scheduled_for: next_fire_at,
            next_fire_at: roll(now.clone(), Some(now)),
            interval_anchor_at: None,
        },
        MissedRunPolicy::CatchUpOnce => {
            if overdue > chrono::Duration::days(CATCH_UP_MAX_AGE_DAYS) {
                return DueDecision::Skip {
                    reason: format!(
                        "the missed run was more than {CATCH_UP_MAX_AGE_DAYS} days ago"
                    ),
                    scheduled_for: next_fire_at,
                    next_fire_at: roll(now.clone(), Some(now)),
                    interval_anchor_at: None,
                };
            }
            if !validate::catch_up_allowed(MissedRunPolicy::CatchUpOnce, inputs.app_uptime_secs) {
                // Deliberately `None`, not `Skip`: the occurrence is still owed.
                // Consuming it here would turn "catch up once" into "never catch
                // up", because the settle window always elapses after launch.
                return DueDecision::None;
            }
            DueDecision::Fire {
                trigger: RunTrigger::CatchUp,
                scheduled_for: next_fire_at,
                // A catch-up re-phases an interval from the moment it actually
                // ran; pretending otherwise would fire again immediately.
                next_fire_at: roll(now.clone(), Some(now.clone())),
                interval_anchor_at: Some(now),
            }
        }
    }
}

// ------------------------------------------------------------------ state ----

/// Managed state for the scheduler task.
pub struct SchedulerState {
    running: AtomicBool,
    started_at: Instant,
    wake: tokio::sync::Notify,
    /// Serializes runs across actions. A launch with eight owed catch-ups is a
    /// queue, not a thundering herd.
    permits: tokio::sync::Semaphore,
    cancels: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    /// The last wall-clock moment a tick observed, so a backwards jump is
    /// detectable rather than merely surprising.
    last_tick: Mutex<Option<DateTime<Local>>>,
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            started_at: Instant::now(),
            wake: tokio::sync::Notify::new(),
            permits: tokio::sync::Semaphore::new(1),
            cancels: Mutex::new(HashMap::new()),
            last_tick: Mutex::new(None),
        }
    }
}

impl SchedulerState {
    pub fn uptime_secs(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    /// Wake the loop after a CRUD write, so a schedule saved for ten seconds out
    /// fires on time instead of up to a minute late.
    pub fn wake(&self) {
        self.wake.notify_waiters();
    }

    pub fn register_cancel(&self, run_id: &str) -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(run_id.to_string(), tx);
        }
        rx
    }

    pub fn release_cancel(&self, run_id: &str) {
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(run_id);
        }
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        if let Ok(map) = self.cancels.lock() {
            if let Some(tx) = map.get(run_id) {
                let _ = tx.send(true);
                return true;
            }
        }
        false
    }

    /// Turning the feature off must DISARM, not merely hide: a disabled feature
    /// whose task is still ticking is worse than either state.
    pub fn cancel_all(&self) -> Vec<String> {
        let Ok(map) = self.cancels.lock() else {
            return Vec::new();
        };
        for tx in map.values() {
            let _ = tx.send(true);
        }
        map.keys().cloned().collect()
    }

    pub fn is_cancelled(&self, run_id: &str) -> bool {
        self.cancels
            .lock()
            .ok()
            .and_then(|map| map.get(run_id).map(|tx| *tx.borrow()))
            .unwrap_or(false)
    }

    /// `Some(true)` when the wall clock moved backwards since the previous tick.
    fn note_tick(&self, now: DateTime<Local>) -> bool {
        let Ok(mut last) = self.last_tick.lock() else {
            return false;
        };
        let went_backwards = last.as_ref().is_some_and(|prev| now < *prev);
        *last = Some(now);
        went_backwards
    }
}

pub fn state(app: &tauri::AppHandle<Wry>) -> Option<std::sync::Arc<SchedulerState>> {
    app.try_state::<std::sync::Arc<SchedulerState>>()
        .map(|s| s.inner().clone())
}

pub fn gate_open(app: &tauri::AppHandle<Wry>) -> bool {
    crate::commands::settings::read_bool(app, super::SETTING_ENABLED, false)
}

pub fn machine_timezone() -> Option<String> {
    iana_time_zone::get_timezone().ok()
}

/// Start the tick loop if the feature is on and it is not already running.
///
/// Called from `setup` and again from `save_settings` when the flag flips —
/// exactly the shape of `knowledge::ingest::wake_job_runner`, `AtomicBool` swap
/// guard and all.
pub fn start_if_enabled(app: &tauri::AppHandle<Wry>) {
    if !gate_open(app) {
        return;
    }
    let Some(state) = state(app) else {
        log::warn!("scheduled actions: scheduler state is unavailable");
        return;
    };
    if state.running.swap(true, Ordering::AcqRel) {
        state.wake();
        return;
    }
    let run_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tick_loop(run_app, state.clone()).await;
        state.running.store(false, Ordering::Release);
    });
}

async fn tick_loop(app: tauri::AppHandle<Wry>, state: std::sync::Arc<SchedulerState>) {
    log::info!("scheduled actions: scheduler started");
    loop {
        if !gate_open(&app) {
            log::info!("scheduled actions: scheduler stopping — the feature was switched off");
            return;
        }
        let now = Local::now();
        if state.note_tick(now) {
            // A backwards jump invalidates every stored fire. Recompute and fire
            // nothing on this tick; the next one runs normally.
            log::info!("scheduled actions: the wall clock moved backwards — rescheduling");
            super::runner::reschedule_all(&app, now);
        } else {
            super::runner::tick(&app, &state, now).await;
        }
        let delay = super::runner::earliest_delay(&app, Local::now())
            .unwrap_or(TICK_MAX)
            .min(TICK_MAX);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = state.wake.notified() => {}
        }
    }
}

/// The permit that serializes runs. Held for the whole run.
pub async fn acquire_run_permit(
    state: &SchedulerState,
) -> Option<tokio::sync::SemaphorePermit<'_>> {
    state.permits.acquire().await.ok()
}

/// Whether a run status should hold the action's in-flight slot.
pub fn holds_slot(status: ScheduledRunStatus) -> bool {
    status.is_in_flight()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::PermissionMode;
    use crate::mcp::config::McpChatSelection;
    use crate::scheduled::types::{
        ExecutionMode, ScheduledActionInput, ScheduledStep, ScheduledTarget, StepKind, TimeOfDay,
    };
    use chrono::LocalResult;
    use chrono_tz::Europe::Berlin;
    use chrono_tz::Tz as TzId;

    fn berlin(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<TzId> {
        match Berlin.with_ymd_and_hms(y, m, d, h, min, 0) {
            LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => dt,
            LocalResult::None => panic!("no such instant"),
        }
    }

    fn action(recurrence: Recurrence, policy: MissedRunPolicy) -> ScheduledAction {
        ScheduledAction {
            id: "a1".into(),
            input: ScheduledActionInput {
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
                permission_mode: PermissionMode::AutoRead,
                recurrence,
                missed_run_policy: policy,
                timezone: "Europe/Berlin".into(),
                mcp_selection: McpChatSelection::default(),
                doc_buckets: Vec::new(),
                web_access: false,
                max_iterations: 10,
                command_timeout_secs: 120,
                max_run_secs: 3600,
                close_tab_when_done: false,
            },
            armed_at: Some("2026-06-01T00:00:00Z".into()),
            steps_sha256: "sha".into(),
            next_fire_at: None,
            interval_anchor_at: None,
            last_fire_at: None,
            last_run_id: None,
            last_status: None,
            last_error: None,
            created_at: "2026-06-01T00:00:00Z".into(),
            updated_at: "2026-06-01T00:00:00Z".into(),
        }
    }

    fn daily_at_three() -> ScheduledAction {
        action(
            Recurrence::Daily {
                at: TimeOfDay { hour: 3, minute: 0 },
            },
            MissedRunPolicy::Skip,
        )
    }

    fn settled() -> DueInputs {
        DueInputs {
            app_uptime_secs: 600,
            machine_timezone: Some("Europe/Berlin".into()),
            has_run_in_flight: false,
        }
    }

    fn with_next(mut a: ScheduledAction, at: DateTime<TzId>) -> ScheduledAction {
        a.next_fire_at = Some(at.to_utc().to_rfc3339());
        a
    }

    #[test]
    fn an_action_with_no_next_fire_at_is_scheduled_but_never_fired_on_sight() {
        let decision = evaluate_due(&daily_at_three(), berlin(2026, 6, 1, 9, 0), &settled());
        match decision {
            DueDecision::Reschedule { next_fire_at, .. } => {
                assert_eq!(next_fire_at.unwrap(), berlin(2026, 6, 2, 3, 0));
            }
            other => panic!("expected Reschedule, got {other:?}"),
        }
    }

    #[test]
    fn a_disabled_action_is_never_due() {
        let mut a = with_next(daily_at_three(), berlin(2026, 6, 1, 3, 0));
        a.input.enabled = false;
        assert_eq!(
            evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &settled()),
            DueDecision::None
        );
    }

    #[test]
    fn a_future_occurrence_is_not_due() {
        let a = with_next(daily_at_three(), berlin(2026, 6, 2, 3, 0));
        assert_eq!(
            evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &settled()),
            DueDecision::None
        );
    }

    #[test]
    fn an_on_time_fire_uses_the_schedule_trigger_and_anchors_to_the_slot() {
        let a = with_next(daily_at_three(), berlin(2026, 6, 1, 3, 0));
        match evaluate_due(&a, berlin(2026, 6, 1, 3, 1), &settled()) {
            DueDecision::Fire {
                trigger,
                scheduled_for,
                next_fire_at,
                interval_anchor_at,
            } => {
                assert_eq!(trigger, RunTrigger::Schedule);
                assert_eq!(scheduled_for, berlin(2026, 6, 1, 3, 0));
                assert_eq!(next_fire_at.unwrap(), berlin(2026, 6, 2, 3, 0));
                // The SLOT, not `now` — otherwise an interval grid drifts on
                // every fire by however late the tick happened to be.
                assert_eq!(interval_anchor_at.unwrap(), berlin(2026, 6, 1, 3, 0));
            }
            other => panic!("expected Fire, got {other:?}"),
        }
    }

    #[test]
    fn a_stale_fire_under_skip_records_a_skipped_run_and_rolls_forward() {
        let a = with_next(daily_at_three(), berlin(2026, 6, 1, 3, 0));
        match evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &settled()) {
            DueDecision::Skip {
                reason,
                scheduled_for,
                next_fire_at,
                ..
            } => {
                assert!(reason.contains("not running"), "{reason}");
                assert_eq!(scheduled_for, berlin(2026, 6, 1, 3, 0));
                assert_eq!(next_fire_at.unwrap(), berlin(2026, 6, 2, 3, 0));
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    /// Three occurrences elapsed while the app was closed. Exactly one run comes
    /// back, because the roll-forward collapses the rest.
    #[test]
    fn a_stale_fire_under_catch_up_once_produces_exactly_one_run() {
        let mut a = action(
            Recurrence::Interval { every_minutes: 30 },
            MissedRunPolicy::CatchUpOnce,
        );
        a.interval_anchor_at = Some(berlin(2026, 6, 1, 7, 0).to_utc().to_rfc3339());
        let a = with_next(a, berlin(2026, 6, 1, 7, 30));
        let now = berlin(2026, 6, 1, 9, 0);
        match evaluate_due(&a, now, &settled()) {
            DueDecision::Fire {
                trigger,
                scheduled_for,
                next_fire_at,
                interval_anchor_at,
            } => {
                assert_eq!(trigger, RunTrigger::CatchUp);
                assert_eq!(scheduled_for, berlin(2026, 6, 1, 7, 30));
                // One fire, and the next is half an hour from NOW — not the third
                // of four backlogged slots.
                assert_eq!(next_fire_at.unwrap(), berlin(2026, 6, 1, 9, 30));
                assert_eq!(interval_anchor_at.unwrap(), now);
            }
            other => panic!("expected Fire, got {other:?}"),
        }
    }

    /// CLAUDE.md says "nothing auto-runs at launch" three times over. The owed
    /// occurrence must be held, not consumed — consuming it would turn "catch up
    /// once" into "never catch up", since the settle window always elapses after
    /// launch.
    #[test]
    fn a_catch_up_waits_for_the_app_to_settle_without_consuming_the_occurrence() {
        let a = with_next(
            action(
                Recurrence::Daily {
                    at: TimeOfDay { hour: 3, minute: 0 },
                },
                MissedRunPolicy::CatchUpOnce,
            ),
            berlin(2026, 6, 1, 3, 0),
        );
        let fresh = DueInputs {
            app_uptime_secs: 5,
            ..settled()
        };
        assert_eq!(
            evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &fresh),
            DueDecision::None
        );
        // And once settled, the very same state fires.
        assert!(matches!(
            evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &settled()),
            DueDecision::Fire {
                trigger: RunTrigger::CatchUp,
                ..
            }
        ));
    }

    #[test]
    fn a_catch_up_older_than_the_max_age_is_skipped_with_a_stated_reason() {
        let a = with_next(
            action(
                Recurrence::Daily {
                    at: TimeOfDay { hour: 3, minute: 0 },
                },
                MissedRunPolicy::CatchUpOnce,
            ),
            berlin(2026, 6, 1, 3, 0),
        );
        match evaluate_due(&a, berlin(2026, 6, 20, 9, 0), &settled()) {
            DueDecision::Skip { reason, .. } => assert!(reason.contains("7 days"), "{reason}"),
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn an_action_with_a_run_in_flight_is_skipped_rather_than_queued() {
        let a = with_next(daily_at_three(), berlin(2026, 6, 1, 3, 0));
        let busy = DueInputs {
            has_run_in_flight: true,
            ..settled()
        };
        match evaluate_due(&a, berlin(2026, 6, 1, 3, 1), &busy) {
            DueDecision::Skip { reason, .. } => {
                assert!(reason.contains("still going"), "{reason}")
            }
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn a_backwards_clock_jump_recomputes_instead_of_sleeping_for_a_year() {
        // A stored fire a month out for a daily rule can only mean the clock
        // moved. Recompute; never fire on that tick.
        let a = with_next(daily_at_three(), berlin(2026, 7, 15, 3, 0));
        match evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &settled()) {
            DueDecision::Reschedule {
                next_fire_at,
                reason,
            } => {
                assert!(reason.contains("implausibly"), "{reason}");
                assert_eq!(next_fire_at.unwrap(), berlin(2026, 6, 2, 3, 0));
            }
            other => panic!("expected Reschedule, got {other:?}"),
        }
        // A one-off legitimately sits far out and must NOT be rescheduled.
        let once = with_next(
            action(
                Recurrence::Once {
                    at: "2027-01-01T09:00:00+01:00".into(),
                },
                MissedRunPolicy::Skip,
            ),
            berlin(2027, 1, 1, 9, 0),
        );
        assert_eq!(
            evaluate_due(&once, berlin(2026, 6, 1, 9, 0), &settled()),
            DueDecision::None
        );
    }

    #[test]
    fn a_timezone_change_reschedules_rather_than_reporting_a_missed_run() {
        let a = with_next(daily_at_three(), berlin(2026, 6, 1, 3, 0));
        let moved = DueInputs {
            machine_timezone: Some("Asia/Tokyo".into()),
            ..settled()
        };
        match evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &moved) {
            DueDecision::Reschedule { reason, .. } => {
                assert!(reason.contains("timezone"), "{reason}")
            }
            other => panic!("expected Reschedule, got {other:?}"),
        }
        // An unknown machine zone must not trigger it — that would reschedule
        // forever on a platform where the zone cannot be read.
        let unknown = DueInputs {
            machine_timezone: None,
            ..settled()
        };
        assert!(matches!(
            evaluate_due(&a, berlin(2026, 6, 1, 9, 0), &unknown),
            DueDecision::Skip { .. }
        ));
    }

    #[test]
    fn a_fired_once_rule_has_no_next_occurrence() {
        let once = with_next(
            action(
                Recurrence::Once {
                    at: "2026-06-01T03:00:00+02:00".into(),
                },
                MissedRunPolicy::Skip,
            ),
            berlin(2026, 6, 1, 3, 0),
        );
        match evaluate_due(&once, berlin(2026, 6, 1, 3, 1), &settled()) {
            DueDecision::Fire { next_fire_at, .. } => assert!(next_fire_at.is_none()),
            other => panic!("expected Fire, got {other:?}"),
        }
    }
}
