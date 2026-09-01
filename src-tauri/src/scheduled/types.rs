//! Every Scheduled Actions type that crosses IPC or SQLite.
//!
//! Each enum below goes through `string_enum!` (exported from
//! `crate::runbooks::state`) so its serde spelling, its SQLite CHECK value and
//! its `as_str()` are one literal declared once. Every multi-word variant here
//! — `catch_up_once`, `awaiting_target`, `local_shell` — is a live instance of
//! the bug where `ProviderId::OpenAi` shipped as `"open_ai"` against a frontend
//! that said `"openai"`, with no error anywhere.

use serde::{Deserialize, Serialize};

use crate::agent::PermissionMode;
use crate::knowledge::KnowledgeBucketRef;
use crate::mcp::config::McpChatSelection;
use crate::string_enum;

/// A weekly rule may not select more days than exist, and a step list must stay
/// reviewable in one screen.
pub const MAX_STEPS: usize = 64;
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_STEP_TITLE_CHARS: usize = 120;
pub const MAX_COMMAND_CHARS: usize = 4_096;
pub const MAX_PROMPT_CHARS: usize = 8_192;
/// 28 days. Longer than this and a recurrence should be `weekly` or `daily`.
pub const MAX_INTERVAL_MINUTES: u32 = 40_320;

string_enum! {
    /// Where a run's commands actually execute.
    pub enum ExecutionMode {
        Tab => "tab",
        Headless => "headless",
    }
}

string_enum! {
    /// What to do about an occurrence that came due while the app was closed.
    pub enum MissedRunPolicy {
        Skip => "skip",
        CatchUpOnce => "catch_up_once",
    }
}

string_enum! {
    /// How a step's `text` is interpreted.
    pub enum StepKind {
        Command => "command",
        Prompt => "prompt",
    }
}

string_enum! {
    /// Why this run exists. Surfaced in the run detail because a backup that ran
    /// at 09:14 instead of 03:00 is a fact the operator needs.
    pub enum RunTrigger {
        Schedule => "schedule",
        CatchUp => "catch_up",
        Manual => "manual",
    }
}

string_enum! {
    pub enum RecurrenceKind {
        Interval => "interval",
        Daily => "daily",
        Weekly => "weekly",
        Once => "once",
    }
}

string_enum! {
    /// `awaiting_target` is tab mode only: the run exists and is leased, but the
    /// frontend has not yet handed back a session to drive.
    pub enum ScheduledRunStatus {
        Pending => "pending",
        AwaitingTarget => "awaiting_target",
        Running => "running",
        Succeeded => "succeeded",
        Failed => "failed",
        Cancelled => "cancelled",
        Skipped => "skipped",
        Interrupted => "interrupted",
    }
}

impl ScheduledRunStatus {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Skipped | Self::Interrupted
        )
    }

    /// The three statuses the partial unique index treats as "in flight". Kept
    /// beside `is_terminal` so the SQL predicate and the Rust one cannot drift.
    pub const fn is_in_flight(self) -> bool {
        matches!(self, Self::Pending | Self::AwaitingTarget | Self::Running)
    }
}

string_enum! {
    /// `unknown` is load-bearing: it is what a dispatched attempt becomes after a
    /// crash. "We may have started this" must be representable and must never
    /// decay into either `failed` or `succeeded`.
    pub enum StepAttemptStatus {
        Pending => "pending",
        Running => "running",
        Succeeded => "succeeded",
        Failed => "failed",
        Skipped => "skipped",
        Blocked => "blocked",
        Unknown => "unknown",
        Cancelled => "cancelled",
    }
}

string_enum! {
    /// Our own weekday, deliberately not `chrono::Weekday`, whose serde spelling
    /// is `"Mon"` — a wire literal we would not control and could not change.
    pub enum Weekday {
        Monday => "monday",
        Tuesday => "tuesday",
        Wednesday => "wednesday",
        Thursday => "thursday",
        Friday => "friday",
        Saturday => "saturday",
        Sunday => "sunday",
    }
}

impl Weekday {
    pub const ALL: [Weekday; 7] = [
        Weekday::Monday,
        Weekday::Tuesday,
        Weekday::Wednesday,
        Weekday::Thursday,
        Weekday::Friday,
        Weekday::Saturday,
        Weekday::Sunday,
    ];

    /// Monday is bit 0, matching ISO-8601 ordering. The mask is what SQLite
    /// stores, so an empty selection is unrepresentable there (`BETWEEN 1 AND 127`).
    pub const fn bit(self) -> u8 {
        1 << self.index()
    }

    pub const fn index(self) -> u8 {
        match self {
            Self::Monday => 0,
            Self::Tuesday => 1,
            Self::Wednesday => 2,
            Self::Thursday => 3,
            Self::Friday => 4,
            Self::Saturday => 5,
            Self::Sunday => 6,
        }
    }

    pub fn to_chrono(self) -> chrono::Weekday {
        match self {
            Self::Monday => chrono::Weekday::Mon,
            Self::Tuesday => chrono::Weekday::Tue,
            Self::Wednesday => chrono::Weekday::Wed,
            Self::Thursday => chrono::Weekday::Thu,
            Self::Friday => chrono::Weekday::Fri,
            Self::Saturday => chrono::Weekday::Sat,
            Self::Sunday => chrono::Weekday::Sun,
        }
    }

    pub fn from_chrono(day: chrono::Weekday) -> Self {
        match day {
            chrono::Weekday::Mon => Self::Monday,
            chrono::Weekday::Tue => Self::Tuesday,
            chrono::Weekday::Wed => Self::Wednesday,
            chrono::Weekday::Thu => Self::Thursday,
            chrono::Weekday::Fri => Self::Friday,
            chrono::Weekday::Sat => Self::Saturday,
            chrono::Weekday::Sun => Self::Sunday,
        }
    }

    pub fn mask_of(days: &[Weekday]) -> u8 {
        days.iter().fold(0u8, |acc, day| acc | day.bit())
    }

    pub fn from_mask(mask: u8) -> Vec<Weekday> {
        Self::ALL
            .into_iter()
            .filter(|day| mask & day.bit() != 0)
            .collect()
    }
}

/// Local wall-clock time. Never an offset: "daily at 09:00" means 09:00 on the
/// clock in the room, which is not a fixed UTC offset across a DST boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeOfDay {
    pub hour: u8,
    pub minute: u8,
}

impl TimeOfDay {
    pub fn to_naive(self) -> Option<chrono::NaiveTime> {
        chrono::NaiveTime::from_hms_opt(self.hour as u32, self.minute as u32, 0)
    }
}

/// Internally tagged, mirroring `KnowledgeBucketRef`, so the frontend receives
/// `{ kind: "ssh_host", host_id }` rather than serde's default external tagging.
/// The two tags are the same strings the v20 `target_kind` CHECK enumerates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduledTarget {
    LocalShell {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    SshHost {
        host_id: String,
    },
}

impl ScheduledTarget {
    pub const fn kind_str(&self) -> &'static str {
        match self {
            Self::LocalShell { .. } => "local_shell",
            Self::SshHost { .. } => "ssh_host",
        }
    }

    pub fn host_id(&self) -> Option<&str> {
        match self {
            Self::SshHost { host_id } => Some(host_id.as_str()),
            Self::LocalShell { .. } => None,
        }
    }

    pub fn local_cwd(&self) -> Option<&str> {
        match self {
            Self::LocalShell { cwd } => cwd.as_deref(),
            Self::SshHost { .. } => None,
        }
    }

    /// The scope a saved command-policy rule is evaluated in. A rule the user
    /// saved for `local` must never silently cover a remote schedule.
    pub fn policy_scope(&self) -> String {
        match self {
            Self::LocalShell { .. } => "local".to_string(),
            Self::SshHost { host_id } => format!("remote:{host_id}"),
        }
    }
}

/// One step. `kind` decides how `text` is read; there is exactly one payload and
/// it is a string either way, so a flattened tagged payload would buy two
/// nullable columns and a two-way CHECK for nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledStep {
    pub id: String,
    pub sort_order: u32,
    pub title: String,
    pub kind: StepKind,
    /// The literal shell command, or the agent goal.
    pub text: String,
    #[serde(default)]
    pub continue_on_failure: bool,
}

impl ScheduledStep {
    pub fn as_command(&self) -> Option<&str> {
        (self.kind == StepKind::Command).then_some(self.text.as_str())
    }

    pub fn as_prompt(&self) -> Option<&str> {
        (self.kind == StepKind::Prompt).then_some(self.text.as_str())
    }
}

/// Structured, one variant per row of the picker. No cron: an expression would
/// reopen the parsing and DST surface these fields close, and `preview` would
/// become the only way anyone could tell what a string meant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recurrence {
    /// Minutes only. "Every N hours" is `N * 60`; a unit enum would be a second
    /// wire literal to keep in step for zero expressive gain.
    Interval {
        every_minutes: u32,
    },
    Daily {
        at: TimeOfDay,
    },
    Weekly {
        weekdays: Vec<Weekday>,
        at: TimeOfDay,
    },
    /// RFC3339 **with offset**. A bare naive string would be re-resolved against
    /// whatever zone the machine happened to be in when it fired.
    Once {
        at: String,
    },
}

impl Recurrence {
    pub const fn kind(&self) -> RecurrenceKind {
        match self {
            Self::Interval { .. } => RecurrenceKind::Interval,
            Self::Daily { .. } => RecurrenceKind::Daily,
            Self::Weekly { .. } => RecurrenceKind::Weekly,
            Self::Once { .. } => RecurrenceKind::Once,
        }
    }

    pub const fn is_once(&self) -> bool {
        matches!(self, Self::Once { .. })
    }
}

/// What the editor sends. Deliberately separate from `ScheduledAction`: the
/// derived fields (`next_fire_at`, `last_*`, timestamps, the armed snapshot) are
/// the engine's to write and must never be accepted over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledActionInput {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub target: ScheduledTarget,
    pub steps: Vec<ScheduledStep>,
    pub execution_mode: ExecutionMode,
    /// Clamped: `Full` is refused. See `validate::clamp_for_schedule`.
    #[serde(default)]
    pub permission_mode: PermissionMode,
    pub recurrence: Recurrence,
    #[serde(default = "default_missed_run_policy")]
    pub missed_run_policy: MissedRunPolicy,
    /// IANA zone id, e.g. `"Europe/Berlin"`. The frontend reads it from
    /// `Intl.DateTimeFormat().resolvedOptions().timeZone`.
    pub timezone: String,
    #[serde(default)]
    pub mcp_selection: McpChatSelection,
    #[serde(default)]
    pub doc_buckets: Vec<KnowledgeBucketRef>,
    /// Per-action and default OFF, intersected with the global `ai_web_access`
    /// and never unioned with it. Under a schedule, egress is the primary
    /// injection vector, so the global setting must not be able to widen this.
    #[serde(default)]
    pub web_access: bool,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    #[serde(default = "default_command_timeout_secs")]
    pub command_timeout_secs: u32,
    /// Wall-clock ceiling for the whole run, so a step waiting on something that
    /// never arrives cannot hold the action's in-flight slot forever.
    #[serde(default = "default_max_run_secs")]
    pub max_run_secs: u32,
    /// Only offered for a `once` recurrence, where "run it and clean up" is the
    /// honest expectation. Otherwise the tab is reused on the next fire.
    #[serde(default)]
    pub close_tab_when_done: bool,
}

fn default_true() -> bool {
    true
}
fn default_missed_run_policy() -> MissedRunPolicy {
    MissedRunPolicy::Skip
}
fn default_max_iterations() -> u32 {
    10
}
fn default_command_timeout_secs() -> u32 {
    120
}
fn default_max_run_secs() -> u32 {
    3_600
}

/// A stored action as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledAction {
    pub id: String,
    #[serde(flatten)]
    pub input: ScheduledActionInput,
    /// When the current `permission_mode` was armed, and over which step list.
    /// Editing steps, the target or the attachments resets the mode to `ask`, so
    /// a hash mismatch at fire time means something bypassed that reset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armed_at: Option<String>,
    pub steps_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fire_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_anchor_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fire_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<ScheduledRunStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One run. Every field the action contributed is SNAPSHOTTED here at fire time:
/// the action is mutable, and "what was authorized when this ran?" must never be
/// answered by re-reading an edited row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledRun {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    pub action_name: String,
    pub plan_sha256: String,
    pub trigger: RunTrigger,
    pub execution_mode: ExecutionMode,
    pub permission_mode: PermissionMode,
    pub target_kind: String,
    pub target_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub status: ScheduledRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub web_access: bool,
    pub app_version: String,
    /// Recorded because a background tab never fits, so its geometry is fixed at
    /// spawn — and truncated output the model read as fact is only diagnosable
    /// afterwards if the columns are on the record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u32>,
    pub scheduled_for: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    #[serde(default)]
    pub attempts: Vec<StepAttempt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepAttempt {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub sort_order: u32,
    pub kind: StepKind,
    pub title: String,
    pub status: StepAttemptStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
    pub output_redacted: bool,
    pub output_truncated: bool,
    /// How a prompt step ended, in the agent loop's own words — including
    /// `paused_step_limit`, which is a terminal outcome for the step and never a
    /// cue to start a fresh budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub commands_executed: u32,
    /// Auto-skipped proposals. Under a schedule this is the interesting number:
    /// it is everything the run wanted to do and was not authorized to.
    pub commands_skipped: u32,
    pub commands_blocked: u32,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Written BEFORE dispatch. A row with `intent_at` and no `finished_at` is
    /// exactly the "we may have started this" fact a crash must preserve.
    pub intent_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}

/// Editor feedback. `blocking` issues refuse the save; the rest are shown and
/// saved anyway — a command step is the user's own text, so classification
/// flags, it never filters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledValidationIssue {
    pub field: String,
    pub message: String,
    pub blocking: bool,
}

impl ScheduledValidationIssue {
    pub fn blocking(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
            blocking: true,
        }
    }

    pub fn advisory(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            message: message.into(),
            blocking: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CLAUDE.md mandate: a serialized enum name IS a frontend type. Assert
    /// every literal explicitly rather than trusting `rename_all`, which is what
    /// mangled `OpenAi` into `"open_ai"`.
    #[test]
    fn every_scheduled_enum_serializes_as_its_own_str() {
        // Grouped by type so `parse::<T>()` is named rather than inferred: an
        // inferred target would happily resolve to a DIFFERENT enum that happens
        // to accept the same literal, and the assertion would pass while proving
        // nothing about the one under test.
        macro_rules! check {
            ($ty:ty : $($variant:ident),+ $(,)?) => {
                $({
                    let v = <$ty>::$variant;
                    let wire = serde_json::to_string(&v).unwrap();
                    assert_eq!(wire, format!("\"{}\"", v.as_str()), "{:?}", v);
                    assert_eq!(v.as_str().parse::<$ty>().unwrap(), v);
                })+
            };
        }
        check!(ExecutionMode: Tab, Headless);
        check!(MissedRunPolicy: Skip, CatchUpOnce);
        check!(StepKind: Command, Prompt);
        check!(RunTrigger: Schedule, CatchUp, Manual);
        check!(RecurrenceKind: Interval, Daily, Weekly, Once);
        check!(ScheduledRunStatus:
            Pending, AwaitingTarget, Running, Succeeded, Failed, Cancelled, Skipped, Interrupted);
        check!(StepAttemptStatus:
            Pending, Running, Succeeded, Failed, Skipped, Blocked, Unknown, Cancelled);
        check!(Weekday: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday);

        // The spellings a `rename_all` default would have mangled, asserted
        // literally — this is the `ProviderId::OpenAi` → `"open_ai"` class of bug.
        assert_eq!(MissedRunPolicy::CatchUpOnce.as_str(), "catch_up_once");
        assert_eq!(
            ScheduledRunStatus::AwaitingTarget.as_str(),
            "awaiting_target"
        );
        assert_eq!(RunTrigger::CatchUp.as_str(), "catch_up");
        assert_eq!(StepAttemptStatus::Cancelled.as_str(), "cancelled");
        // And an unknown literal must fail rather than falling back to a default.
        assert!("auto".parse::<ExecutionMode>().is_err());
        assert!("Tab".parse::<ExecutionMode>().is_err());
        assert!("catchUpOnce".parse::<MissedRunPolicy>().is_err());
    }

    /// The internally-tagged target and the `target_kind` CHECK constraint are
    /// two enforcement points for one pair of strings.
    #[test]
    fn target_wire_tags_match_the_database_check_constraint() {
        let local = ScheduledTarget::LocalShell { cwd: None };
        let remote = ScheduledTarget::SshHost {
            host_id: "h1".into(),
        };
        assert_eq!(local.kind_str(), "local_shell");
        assert_eq!(remote.kind_str(), "ssh_host");
        let local_json = serde_json::to_value(&local).unwrap();
        assert_eq!(local_json["kind"], "local_shell");
        // `cwd: None` must not serialize, or a canonical hash over the plan would
        // change for every action stored before the field existed.
        assert!(local_json.get("cwd").is_none());
        assert_eq!(serde_json::to_value(&remote).unwrap()["kind"], "ssh_host");
        // Both tags appear verbatim in `db::migrate_v20`.
        let sql = crate::scheduled::db::MIGRATION_V20_SQL;
        assert!(sql.contains("target_kind IN ('local_shell','ssh_host')"));
    }

    #[test]
    fn weekday_bitmask_round_trips_and_monday_is_bit_zero() {
        assert_eq!(Weekday::Monday.bit(), 1);
        assert_eq!(Weekday::Sunday.bit(), 64);
        assert_eq!(Weekday::mask_of(&Weekday::ALL), 127);
        assert_eq!(Weekday::mask_of(&[]), 0);
        let days = vec![Weekday::Monday, Weekday::Wednesday, Weekday::Sunday];
        let mask = Weekday::mask_of(&days);
        assert_eq!(Weekday::from_mask(mask), days);
        for day in Weekday::ALL {
            assert_eq!(Weekday::from_chrono(day.to_chrono()), day);
        }
    }

    #[test]
    fn run_status_in_flight_and_terminal_partition_the_enum() {
        let all = [
            ScheduledRunStatus::Pending,
            ScheduledRunStatus::AwaitingTarget,
            ScheduledRunStatus::Running,
            ScheduledRunStatus::Succeeded,
            ScheduledRunStatus::Failed,
            ScheduledRunStatus::Cancelled,
            ScheduledRunStatus::Skipped,
            ScheduledRunStatus::Interrupted,
        ];
        for status in all {
            assert_ne!(
                status.is_in_flight(),
                status.is_terminal(),
                "{status} must be exactly one of in-flight or terminal"
            );
        }
        // The in-flight set is also the partial unique index's WHERE clause.
        let sql = crate::scheduled::db::MIGRATION_V20_SQL;
        assert!(sql.contains("WHERE status IN ('pending','awaiting_target','running')"));
    }
}
