//! Durable storage for Scheduled Actions.
//!
//! Two disciplines carry over from `runbooks::db::migrate_v6`, and both are what
//! make crash recovery honest:
//!
//! * every attempt row is written `pending` with `intent_at` set BEFORE anything
//!   executes, so "we may have started this" is a fact on disk;
//! * every status is a CHECK-constrained string whose spelling is the same one
//!   `string_enum!` puts on the wire.
//!
//! The third discipline is this feature's own: **inserting a run row and rolling
//! `next_fire_at` forward happen in ONE transaction**, and a partial unique index
//! refuses a second in-flight run per action. Together those are what make a
//! double fire across a crash unrepresentable rather than merely unlikely.

use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

use super::types::{
    ExecutionMode, MissedRunPolicy, Recurrence, RunTrigger, ScheduledAction, ScheduledActionInput,
    ScheduledRun, ScheduledRunStatus, ScheduledStep, ScheduledTarget, StepAttempt,
    StepAttemptStatus, StepKind, TimeOfDay, Weekday,
};
use crate::agent::PermissionMode;
use crate::knowledge::KnowledgeBucketRef;
use crate::mcp::config::McpChatSelection;

/// Kept as a `const` rather than inlined so `types.rs` can assert that the wire
/// tags and the CHECK constraints are the same strings. Two enforcement points
/// for one literal is the whole point; a test that reads the SQL is how they stay
/// that way.
pub const MIGRATION_V20_SQL: &str = r#"
BEGIN;

CREATE TABLE scheduled_actions (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    enabled               INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),

    target_kind           TEXT NOT NULL CHECK(target_kind IN ('local_shell','ssh_host')),
    -- RESTRICT, not SET NULL: a scheduled action is a persisted authorization
    -- bound to one host identity. Letting the binding dangle turns a remote
    -- schedule into a silently broken row, so `ssh_hosts_delete` gains a
    -- pre-check that names the blocking actions instead.
    target_host_id        TEXT REFERENCES ssh_hosts(id) ON DELETE RESTRICT,
    target_cwd            TEXT,

    execution_mode        TEXT NOT NULL CHECK(execution_mode IN ('tab','headless')),
    -- 'full' is deliberately ABSENT. `agent::run::policy_auto_runs` returns true
    -- for Full BEFORE the privileged/opaque/sensitive-read checks, which is
    -- defensible for a session a human is watching and not for 03:00. Absent
    -- from the constraint means a hand-edited database cannot smuggle it in
    -- either. See `scheduled::validate::clamp_for_schedule`.
    permission_mode       TEXT NOT NULL DEFAULT 'ask'
                          CHECK(permission_mode IN ('ask','auto_read','auto_smart','auto_all')),
    -- When the mode above was armed, and over what. Editing steps, the target or
    -- the attachments resets the mode to 'ask'; a hash mismatch at fire time
    -- means something bypassed that reset, and the run must not proceed.
    armed_at              TEXT,
    steps_sha256          TEXT NOT NULL,

    recurrence_kind       TEXT NOT NULL
                          CHECK(recurrence_kind IN ('interval','daily','weekly','once')),
    every_minutes         INTEGER CHECK(every_minutes IS NULL OR
                                        every_minutes BETWEEN 1 AND 40320),
    at_hour               INTEGER CHECK(at_hour   IS NULL OR at_hour   BETWEEN 0 AND 23),
    at_minute             INTEGER CHECK(at_minute IS NULL OR at_minute BETWEEN 0 AND 59),
    -- Bit 0 = Monday. An empty selection is unrepresentable, which is what stops
    -- a weekly rule that can never fire from being stored at all.
    weekday_mask          INTEGER CHECK(weekday_mask IS NULL OR
                                        weekday_mask BETWEEN 1 AND 127),
    once_at               TEXT,
    timezone              TEXT NOT NULL,
    -- "Every 30 minutes" phases from the last real fire, not a fixed epoch grid,
    -- so editing an action does not re-phase it.
    interval_anchor_at    TEXT,

    missed_run_policy     TEXT NOT NULL DEFAULT 'skip'
                          CHECK(missed_run_policy IN ('skip','catch_up_once')),

    mcp_selection_json    TEXT NOT NULL DEFAULT '{}',
    doc_buckets_json      TEXT NOT NULL DEFAULT '[]',
    -- Per-action and default OFF, intersected with the global ai_web_access and
    -- never unioned with it: under a schedule, egress is the primary injection
    -- vector, and a user who turned the web on for a daytime research session
    -- must not thereby widen every action they saved months ago.
    web_access            INTEGER NOT NULL DEFAULT 0 CHECK(web_access IN (0,1)),

    max_iterations        INTEGER NOT NULL DEFAULT 10
                          CHECK(max_iterations BETWEEN 1 AND 100),
    command_timeout_secs  INTEGER NOT NULL DEFAULT 120
                          CHECK(command_timeout_secs BETWEEN 1 AND 86400),
    max_run_secs          INTEGER NOT NULL DEFAULT 3600
                          CHECK(max_run_secs BETWEEN 30 AND 86400),
    close_tab_when_done   INTEGER NOT NULL DEFAULT 0 CHECK(close_tab_when_done IN (0,1)),

    next_fire_at          TEXT,
    last_fire_at          TEXT,
    -- No FK: runs are prunable and history must not pin them.
    last_run_id           TEXT,
    last_status           TEXT CHECK(last_status IS NULL OR last_status IN
                            ('pending','awaiting_target','running','succeeded',
                             'failed','cancelled','skipped','interrupted')),
    last_error            TEXT,

    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,

    -- The discriminant and its payload must agree, or a "local" action could
    -- carry a host id the editor never showed.
    CHECK(
      (target_kind = 'ssh_host'    AND target_host_id IS NOT NULL AND target_cwd IS NULL) OR
      (target_kind = 'local_shell' AND target_host_id IS NULL)
    ),
    -- Each recurrence carries exactly its own fields and no others, so a
    -- half-edited rule is a constraint failure rather than something
    -- `next_fire_after` has to guess at.
    CHECK(
      (recurrence_kind='interval' AND every_minutes IS NOT NULL
         AND at_hour IS NULL AND at_minute IS NULL
         AND weekday_mask IS NULL AND once_at IS NULL) OR
      (recurrence_kind='daily'    AND every_minutes IS NULL
         AND at_hour IS NOT NULL AND at_minute IS NOT NULL
         AND weekday_mask IS NULL AND once_at IS NULL) OR
      (recurrence_kind='weekly'   AND every_minutes IS NULL
         AND at_hour IS NOT NULL AND at_minute IS NOT NULL
         AND weekday_mask IS NOT NULL AND once_at IS NULL) OR
      (recurrence_kind='once'     AND every_minutes IS NULL
         AND at_hour IS NULL AND at_minute IS NULL
         AND weekday_mask IS NULL AND once_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX idx_scheduled_actions_name
    ON scheduled_actions(name COLLATE NOCASE);
-- The scheduler's only hot query.
CREATE INDEX idx_scheduled_actions_due
    ON scheduled_actions(enabled, next_fire_at);
CREATE INDEX idx_scheduled_actions_host
    ON scheduled_actions(target_host_id);

CREATE TABLE scheduled_steps (
    action_id           TEXT NOT NULL
                        REFERENCES scheduled_actions(id) ON DELETE CASCADE,
    step_id             TEXT NOT NULL,
    sort_order          INTEGER NOT NULL CHECK(sort_order >= 0),
    title               TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK(kind IN ('command','prompt')),
    text                TEXT NOT NULL,
    continue_on_failure INTEGER NOT NULL DEFAULT 0
                        CHECK(continue_on_failure IN (0,1)),
    PRIMARY KEY(action_id, step_id),
    UNIQUE(action_id, sort_order)
);
CREATE INDEX idx_scheduled_steps_order ON scheduled_steps(action_id, sort_order);

CREATE TABLE scheduled_runs (
    id                 TEXT PRIMARY KEY,
    -- SET NULL, not CASCADE: deleting an action must not erase the record of
    -- what it already did on the user's machines.
    action_id          TEXT REFERENCES scheduled_actions(id) ON DELETE SET NULL,
    -- Frozen at fire time. The action is mutable; "what was authorized when this
    -- ran?" must never be answered by re-reading an edited row.
    action_name        TEXT NOT NULL,
    plan_json          TEXT NOT NULL,
    plan_sha256        TEXT NOT NULL,

    trigger            TEXT NOT NULL CHECK(trigger IN ('schedule','catch_up','manual')),
    execution_mode     TEXT NOT NULL CHECK(execution_mode IN ('tab','headless')),
    permission_mode    TEXT NOT NULL
                       CHECK(permission_mode IN ('ask','auto_read','auto_smart','auto_all')),
    target_kind        TEXT NOT NULL CHECK(target_kind IN ('local_shell','ssh_host')),
    target_label       TEXT NOT NULL,
    target_host_id     TEXT,
    -- Tab mode only, written at attach.
    session_id         TEXT,
    -- A background tab never fits, so its geometry is fixed at spawn. Recording
    -- it is what makes "the model read truncated output as fact" diagnosable.
    cols               INTEGER CHECK(cols IS NULL OR cols > 0),
    rows               INTEGER CHECK(rows IS NULL OR rows > 0),

    status             TEXT NOT NULL CHECK(status IN
                         ('pending','awaiting_target','running','succeeded',
                          'failed','cancelled','skipped','interrupted')),
    skip_reason        TEXT,
    error              TEXT,
    model              TEXT,
    web_access         INTEGER NOT NULL DEFAULT 0 CHECK(web_access IN (0,1)),
    app_version        TEXT NOT NULL,

    scheduled_for      TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    started_at         TEXT,
    finished_at        TEXT,
    updated_at         TEXT NOT NULL,

    prompt_tokens      INTEGER NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0),
    completion_tokens  INTEGER NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0),

    CHECK((status = 'skipped') = (skip_reason IS NOT NULL))
);
CREATE INDEX idx_scheduled_runs_history ON scheduled_runs(created_at DESC);
CREATE INDEX idx_scheduled_runs_action  ON scheduled_runs(action_id, created_at DESC);
-- Engine memory is the friendly error; this is the durable backstop, and it is
-- what makes "insert the run and roll next_fire_at forward in ONE transaction"
-- sufficient to prevent a double fire across a crash. NULL action_ids compare
-- distinct in SQLite, so orphaned in-flight rows from a deleted action are
-- permitted; startup marks them interrupted.
CREATE UNIQUE INDEX idx_scheduled_runs_one_inflight
    ON scheduled_runs(action_id)
    WHERE status IN ('pending','awaiting_target','running');

CREATE TABLE scheduled_step_attempts (
    id                    TEXT PRIMARY KEY,
    run_id                TEXT NOT NULL
                          REFERENCES scheduled_runs(id) ON DELETE CASCADE,
    step_id               TEXT NOT NULL,
    sort_order            INTEGER NOT NULL CHECK(sort_order >= 0),
    kind                  TEXT NOT NULL CHECK(kind IN ('command','prompt')),
    title                 TEXT NOT NULL,
    status                TEXT NOT NULL CHECK(status IN
                            ('pending','running','succeeded','failed',
                             'skipped','blocked','unknown','cancelled')),

    executed_command      TEXT,
    exit_code             INTEGER,
    output_tail           TEXT,
    output_redacted       INTEGER NOT NULL DEFAULT 0 CHECK(output_redacted IN (0,1)),
    output_truncated      INTEGER NOT NULL DEFAULT 0 CHECK(output_truncated IN (0,1)),

    termination           TEXT,
    summary               TEXT,
    commands_executed     INTEGER NOT NULL DEFAULT 0 CHECK(commands_executed >= 0),
    -- Auto-skipped proposals. Under a schedule this is the interesting number: it
    -- is everything the run wanted to do and was not authorized to.
    commands_skipped      INTEGER NOT NULL DEFAULT 0 CHECK(commands_skipped >= 0),
    commands_blocked      INTEGER NOT NULL DEFAULT 0 CHECK(commands_blocked >= 0),
    prompt_tokens         INTEGER NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0),
    completion_tokens     INTEGER NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0),

    error                 TEXT,
    -- Written BEFORE dispatch. A row with intent_at and no finished_at is exactly
    -- the "we may have started this" fact a crash must preserve.
    intent_at             TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    duration_ms           INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
    UNIQUE(run_id, sort_order)
);
CREATE INDEX idx_scheduled_attempts_run
    ON scheduled_step_attempts(run_id, sort_order);

CREATE TABLE scheduled_events (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES scheduled_runs(id) ON DELETE CASCADE,
    sequence      INTEGER NOT NULL,
    event_type    TEXT NOT NULL,
    step_id       TEXT,
    payload_json  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE(run_id, sequence)
);
CREATE INDEX idx_scheduled_events_run ON scheduled_events(run_id, sequence);

INSERT INTO schema_version (version) VALUES (20);
COMMIT;
"#;

/// Main-database migration v20. Append-only; `migrations::run` calls this only
/// when the recorded version is below 20.
pub fn migrate_v20(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MIGRATION_V20_SQL)
        .map_err(|e| format!("migration v20 failed: {e}"))
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A fingerprint over exactly the fields that must invalidate an arming.
///
/// Deliberately NOT `serde_json::to_string` of the whole input: CLAUDE.md's
/// `skip_serializing_if` lesson cuts both ways, and a future optional field that
/// serialises when unset would silently invalidate every armed action. Writing
/// the fields out means a new field is a deliberate decision about whether it
/// belongs in the hash.
pub fn steps_fingerprint(
    target: &ScheduledTarget,
    steps: &[ScheduledStep],
    mcp: &McpChatSelection,
    buckets: &[KnowledgeBucketRef],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"v1\x1ftarget\x1f");
    hasher.update(target.kind_str().as_bytes());
    hasher.update(b"\x1f");
    hasher.update(target.host_id().unwrap_or("").as_bytes());
    hasher.update(b"\x1f");
    hasher.update(target.local_cwd().unwrap_or("").as_bytes());
    for step in steps {
        hasher.update(b"\x1estep\x1f");
        hasher.update(step.kind.as_str().as_bytes());
        hasher.update(b"\x1f");
        hasher.update(step.text.as_bytes());
        hasher.update(b"\x1f");
        hasher.update(if step.continue_on_failure { b"1" } else { b"0" });
    }
    // Server ids and disabled tools are sorted so a reordered selection is the
    // same authorization, while an added server is not.
    let mut server_ids = mcp.server_ids.clone();
    server_ids.sort();
    for id in &server_ids {
        hasher.update(b"\x1emcp\x1f");
        hasher.update(id.as_bytes());
        let mut disabled = mcp.disabled_tools.get(id).cloned().unwrap_or_default();
        disabled.sort();
        for tool in disabled {
            hasher.update(b"\x1f");
            hasher.update(tool.as_bytes());
        }
    }
    let mut bucket_keys: Vec<String> = buckets
        .iter()
        .map(|b| match b {
            KnowledgeBucketRef::Local { bucket_id } => format!("local/{bucket_id}"),
            KnowledgeBucketRef::Qdrant {
                connection_id,
                collection,
            } => format!("qdrant/{connection_id}/{collection}"),
        })
        .collect();
    bucket_keys.sort();
    for key in bucket_keys {
        hasher.update(b"\x1ebucket\x1f");
        hasher.update(key.as_bytes());
    }
    hex(&hasher.finalize())
}

pub fn plan_fingerprint(plan_json: &str) -> String {
    hex(&Sha256::digest(plan_json.as_bytes()))
}

// ---------------------------------------------------------------- actions ----

fn recurrence_columns(
    rule: &Recurrence,
) -> (
    &'static str,
    Option<u32>,
    Option<u8>,
    Option<u8>,
    Option<u8>,
    Option<String>,
) {
    match rule {
        Recurrence::Interval { every_minutes } => {
            ("interval", Some(*every_minutes), None, None, None, None)
        }
        Recurrence::Daily { at } => ("daily", None, Some(at.hour), Some(at.minute), None, None),
        Recurrence::Weekly { weekdays, at } => (
            "weekly",
            None,
            Some(at.hour),
            Some(at.minute),
            Some(Weekday::mask_of(weekdays)),
            None,
        ),
        Recurrence::Once { at } => ("once", None, None, None, None, Some(at.clone())),
    }
}

fn recurrence_from_row(row: &Row<'_>) -> rusqlite::Result<Recurrence> {
    let kind: String = row.get("recurrence_kind")?;
    let hour: Option<u8> = row.get("at_hour")?;
    let minute: Option<u8> = row.get("at_minute")?;
    let at = || TimeOfDay {
        hour: hour.unwrap_or(0),
        minute: minute.unwrap_or(0),
    };
    Ok(match kind.as_str() {
        "interval" => Recurrence::Interval {
            every_minutes: row.get::<_, Option<u32>>("every_minutes")?.unwrap_or(60),
        },
        "daily" => Recurrence::Daily { at: at() },
        "weekly" => Recurrence::Weekly {
            weekdays: Weekday::from_mask(row.get::<_, Option<u8>>("weekday_mask")?.unwrap_or(0)),
            at: at(),
        },
        _ => Recurrence::Once {
            at: row.get::<_, Option<String>>("once_at")?.unwrap_or_default(),
        },
    })
}

fn action_from_row(row: &Row<'_>, steps: Vec<ScheduledStep>) -> rusqlite::Result<ScheduledAction> {
    let target_kind: String = row.get("target_kind")?;
    let target = if target_kind == "ssh_host" {
        ScheduledTarget::SshHost {
            host_id: row.get("target_host_id")?,
        }
    } else {
        ScheduledTarget::LocalShell {
            cwd: row.get("target_cwd")?,
        }
    };
    let parse_enum = |value: String| -> String { value };
    let execution_mode: ExecutionMode = parse_enum(row.get("execution_mode")?)
        .parse()
        .unwrap_or(ExecutionMode::Headless);
    let permission_mode: PermissionMode = parse_enum(row.get("permission_mode")?)
        .parse()
        .unwrap_or(PermissionMode::Ask);
    let missed_run_policy: MissedRunPolicy = parse_enum(row.get("missed_run_policy")?)
        .parse()
        .unwrap_or(MissedRunPolicy::Skip);
    let last_status: Option<ScheduledRunStatus> = row
        .get::<_, Option<String>>("last_status")?
        .and_then(|v| v.parse().ok());
    let mcp_selection: McpChatSelection =
        serde_json::from_str(&row.get::<_, String>("mcp_selection_json")?).unwrap_or_default();
    let doc_buckets: Vec<KnowledgeBucketRef> =
        serde_json::from_str(&row.get::<_, String>("doc_buckets_json")?).unwrap_or_default();

    Ok(ScheduledAction {
        id: row.get("id")?,
        input: ScheduledActionInput {
            name: row.get("name")?,
            enabled: row.get::<_, i64>("enabled")? != 0,
            target,
            steps,
            execution_mode,
            permission_mode,
            recurrence: recurrence_from_row(row)?,
            missed_run_policy,
            timezone: row.get("timezone")?,
            mcp_selection,
            doc_buckets,
            web_access: row.get::<_, i64>("web_access")? != 0,
            max_iterations: row.get("max_iterations")?,
            command_timeout_secs: row.get("command_timeout_secs")?,
            max_run_secs: row.get("max_run_secs")?,
            close_tab_when_done: row.get::<_, i64>("close_tab_when_done")? != 0,
        },
        armed_at: row.get("armed_at")?,
        steps_sha256: row.get("steps_sha256")?,
        next_fire_at: row.get("next_fire_at")?,
        interval_anchor_at: row.get("interval_anchor_at")?,
        last_fire_at: row.get("last_fire_at")?,
        last_run_id: row.get("last_run_id")?,
        last_status,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn load_steps(conn: &Connection, action_id: &str) -> Result<Vec<ScheduledStep>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT step_id, sort_order, title, kind, text, continue_on_failure
               FROM scheduled_steps WHERE action_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![action_id], |row| {
            Ok(ScheduledStep {
                id: row.get("step_id")?,
                sort_order: row.get("sort_order")?,
                title: row.get("title")?,
                kind: row
                    .get::<_, String>("kind")?
                    .parse()
                    .unwrap_or(StepKind::Command),
                text: row.get("text")?,
                continue_on_failure: row.get::<_, i64>("continue_on_failure")? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

const ACTION_COLUMNS: &str = "id, name, enabled, target_kind, target_host_id, target_cwd,
     execution_mode, permission_mode, armed_at, steps_sha256, recurrence_kind, every_minutes,
     at_hour, at_minute, weekday_mask, once_at, timezone, interval_anchor_at, missed_run_policy,
     mcp_selection_json, doc_buckets_json, web_access, max_iterations, command_timeout_secs,
     max_run_secs, close_tab_when_done, next_fire_at, last_fire_at, last_run_id, last_status,
     last_error, created_at, updated_at";

pub fn list_actions(conn: &Connection) -> Result<Vec<ScheduledAction>, String> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM scheduled_actions ORDER BY name COLLATE NOCASE")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    ids.iter()
        .filter_map(|id| get_action(conn, id).transpose())
        .collect()
}

pub fn get_action(conn: &Connection, id: &str) -> Result<Option<ScheduledAction>, String> {
    let steps = load_steps(conn, id)?;
    let sql = format!("SELECT {ACTION_COLUMNS} FROM scheduled_actions WHERE id = ?1");
    conn.query_row(&sql, params![id], |row| action_from_row(row, steps.clone()))
        .optional()
        .map_err(|e| e.to_string())
}

/// Every enabled action with a computed or missing next fire. The scheduler reads
/// this once per tick and decides in pure code.
pub fn enabled_actions(conn: &Connection) -> Result<Vec<ScheduledAction>, String> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM scheduled_actions WHERE enabled = 1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    ids.iter()
        .filter_map(|id| get_action(conn, id).transpose())
        .collect()
}

pub fn actions_targeting_host(conn: &Connection, host_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM scheduled_actions WHERE target_host_id = ?1 ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![host_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Insert or replace an action and its steps in one transaction.
///
/// `armed_at` is passed in rather than derived: the caller decides whether this
/// write is an arming (the user explicitly chose a mode) or an edit that must
/// reset the mode to `ask`.
#[allow(clippy::too_many_arguments)]
pub fn upsert_action(
    conn: &mut Connection,
    id: &str,
    input: &ScheduledActionInput,
    steps_sha256: &str,
    armed_at: Option<&str>,
    next_fire_at: Option<&str>,
    interval_anchor_at: Option<&str>,
    now: &str,
) -> Result<(), String> {
    let (kind, every_minutes, at_hour, at_minute, weekday_mask, once_at) =
        recurrence_columns(&input.recurrence);
    let mcp_json = serde_json::to_string(&input.mcp_selection).map_err(|e| e.to_string())?;
    let buckets_json = serde_json::to_string(&input.doc_buckets).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO scheduled_actions (
            id, name, enabled, target_kind, target_host_id, target_cwd, execution_mode,
            permission_mode, armed_at, steps_sha256, recurrence_kind, every_minutes, at_hour,
            at_minute, weekday_mask, once_at, timezone, interval_anchor_at, missed_run_policy,
            mcp_selection_json, doc_buckets_json, web_access, max_iterations,
            command_timeout_secs, max_run_secs, close_tab_when_done, next_fire_at,
            created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?28
         )
         ON CONFLICT(id) DO UPDATE SET
            name = ?2, enabled = ?3, target_kind = ?4, target_host_id = ?5, target_cwd = ?6,
            execution_mode = ?7, permission_mode = ?8, armed_at = ?9, steps_sha256 = ?10,
            recurrence_kind = ?11, every_minutes = ?12, at_hour = ?13, at_minute = ?14,
            weekday_mask = ?15, once_at = ?16, timezone = ?17, interval_anchor_at = ?18,
            missed_run_policy = ?19, mcp_selection_json = ?20, doc_buckets_json = ?21,
            web_access = ?22, max_iterations = ?23, command_timeout_secs = ?24,
            max_run_secs = ?25, close_tab_when_done = ?26, next_fire_at = ?27, updated_at = ?28",
        params![
            id,
            input.name,
            input.enabled as i64,
            input.target.kind_str(),
            input.target.host_id(),
            input.target.local_cwd(),
            input.execution_mode.as_str(),
            input.permission_mode.as_str(),
            armed_at,
            steps_sha256,
            kind,
            every_minutes,
            at_hour,
            at_minute,
            weekday_mask,
            once_at,
            input.timezone,
            interval_anchor_at,
            input.missed_run_policy.as_str(),
            mcp_json,
            buckets_json,
            input.web_access as i64,
            input.max_iterations,
            input.command_timeout_secs,
            input.max_run_secs,
            input.close_tab_when_done as i64,
            next_fire_at,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM scheduled_steps WHERE action_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    for (index, step) in input.steps.iter().enumerate() {
        tx.execute(
            "INSERT INTO scheduled_steps
               (action_id, step_id, sort_order, title, kind, text, continue_on_failure)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                step.id,
                index as i64,
                step.title,
                step.kind.as_str(),
                step.text,
                step.continue_on_failure as i64,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn set_enabled(conn: &Connection, id: &str, enabled: bool, now: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_actions SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, enabled as i64, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

pub fn set_next_fire(
    conn: &Connection,
    id: &str,
    next_fire_at: Option<&str>,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_actions SET next_fire_at = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, next_fire_at, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

pub fn delete_action(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM scheduled_actions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())
        .map(|_| ())
}

// ------------------------------------------------------------------- runs ----

/// What a fire commits, in one transaction: the run row, the action's rolled
/// `next_fire_at`, and its `last_*` projection.
pub struct RunCommit<'a> {
    pub run_id: &'a str,
    pub action: &'a ScheduledAction,
    pub trigger: RunTrigger,
    pub status: ScheduledRunStatus,
    pub skip_reason: Option<&'a str>,
    pub target_label: &'a str,
    pub plan_json: &'a str,
    pub scheduled_for: &'a str,
    pub next_fire_at: Option<&'a str>,
    pub interval_anchor_at: Option<&'a str>,
    pub app_version: &'a str,
    pub now: &'a str,
    /// Whether this run becomes the action's `last_run_id` / `last_status`.
    ///
    /// False for an overlap skip. Otherwise the skip steals the projection from
    /// the run that is still executing, and when that run finishes
    /// `set_run_status`' `WHERE last_run_id = ?` no longer matches — so the list
    /// view would show "Skipped" permanently for an action whose run actually
    /// succeeded, with nothing to correct it.
    pub advance_projection: bool,
}

/// Insert the run and roll the schedule forward atomically.
///
/// If this transaction is interrupted, either both happened or neither did — and
/// the partial unique index refuses a second in-flight run for the action even if
/// the in-memory guard is somehow bypassed. Those two together are what make a
/// double fire across a crash unrepresentable.
pub fn commit_run(conn: &mut Connection, commit: RunCommit<'_>) -> Result<(), String> {
    let plan_sha = plan_fingerprint(commit.plan_json);
    let action = commit.action;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO scheduled_runs (
            id, action_id, action_name, plan_json, plan_sha256, trigger, execution_mode,
            permission_mode, target_kind, target_label, target_host_id, status, skip_reason,
            web_access, app_version, scheduled_for, created_at, started_at, finished_at,
            updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?17
         )",
        params![
            commit.run_id,
            action.id,
            action.input.name,
            commit.plan_json,
            plan_sha,
            commit.trigger.as_str(),
            action.input.execution_mode.as_str(),
            action.input.permission_mode.as_str(),
            action.input.target.kind_str(),
            commit.target_label,
            action.input.target.host_id(),
            commit.status.as_str(),
            commit.skip_reason,
            action.input.web_access as i64,
            commit.app_version,
            commit.scheduled_for,
            commit.now,
            // A skip never started and is finished the moment it is recorded.
            (!commit.status.is_terminal()).then_some(commit.now),
            commit.status.is_terminal().then_some(commit.now),
        ],
    )
    .map_err(|e| e.to_string())?;
    // The schedule always rolls forward — that is what collapses missed
    // occurrences — but the `last_*` projection only advances when this run is
    // the one the user should be reading about.
    if commit.advance_projection {
        tx.execute(
            "UPDATE scheduled_actions SET
                next_fire_at = ?2, interval_anchor_at = COALESCE(?3, interval_anchor_at),
                last_fire_at = ?4, last_run_id = ?5, last_status = ?6, last_error = NULL,
                updated_at = ?7
             WHERE id = ?1",
            params![
                action.id,
                commit.next_fire_at,
                commit.interval_anchor_at,
                commit.scheduled_for,
                commit.run_id,
                commit.status.as_str(),
                commit.now,
            ],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "UPDATE scheduled_actions SET
                next_fire_at = ?2, interval_anchor_at = COALESCE(?3, interval_anchor_at),
                updated_at = ?4
             WHERE id = ?1",
            params![
                action.id,
                commit.next_fire_at,
                commit.interval_anchor_at,
                commit.now,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    // A `once` rule has no next occurrence, so it disables itself in the same
    // transaction that records the run. Anything less and a double tick could
    // fire it twice.
    if action.input.recurrence.is_once() && commit.next_fire_at.is_none() {
        tx.execute(
            "UPDATE scheduled_actions SET enabled = 0, updated_at = ?2 WHERE id = ?1",
            params![action.id, commit.now],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn set_run_status(
    conn: &Connection,
    run_id: &str,
    status: ScheduledRunStatus,
    error: Option<&str>,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_runs SET
            status = ?2,
            error = COALESCE(?3, error),
            started_at = CASE WHEN ?2 = 'running' AND started_at IS NULL THEN ?4 ELSE started_at END,
            finished_at = CASE WHEN ?5 = 1 THEN ?4 ELSE finished_at END,
            updated_at = ?4
         WHERE id = ?1",
        params![run_id, status.as_str(), error, now, status.is_terminal() as i64],
    )
    .map_err(|e| e.to_string())?;
    // Keep the action's projection in step so the list view never disagrees with
    // the run it points at.
    conn.execute(
        "UPDATE scheduled_actions SET last_status = ?2, last_error = ?3, updated_at = ?4
           WHERE last_run_id = ?1",
        params![run_id, status.as_str(), error, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_run_target(
    conn: &Connection,
    run_id: &str,
    session_id: &str,
    cols: u32,
    rows: u32,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_runs SET session_id = ?2, cols = ?3, rows = ?4, updated_at = ?5
           WHERE id = ?1",
        params![run_id, session_id, cols, rows, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

pub fn set_run_model(
    conn: &Connection,
    run_id: &str,
    model: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_runs SET model = ?2, updated_at = ?3 WHERE id = ?1",
        params![run_id, model, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

/// Every terminal status must record usage. `Paused` taught this lesson on the
/// agent path: no `Done` fires there, so counters recorded only on success are
/// lost for the whole run.
pub fn add_run_usage(
    conn: &Connection,
    run_id: &str,
    prompt_tokens: u32,
    completion_tokens: u32,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_runs SET prompt_tokens = prompt_tokens + ?2,
            completion_tokens = completion_tokens + ?3, updated_at = ?4 WHERE id = ?1",
        params![run_id, prompt_tokens, completion_tokens, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

// --------------------------------------------------------------- attempts ----

/// Write the intent row BEFORE dispatch. This is the whole crash-recovery
/// contract: after the process disappears, a row with `intent_at` and no
/// `finished_at` means "this may have run", and `interrupt_active_runs` turns it
/// into `unknown` rather than guessing either way.
pub fn insert_attempt(conn: &Connection, attempt: &StepAttempt) -> Result<(), String> {
    conn.execute(
        "INSERT INTO scheduled_step_attempts
           (id, run_id, step_id, sort_order, kind, title, status, intent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            attempt.id,
            attempt.run_id,
            attempt.step_id,
            attempt.sort_order,
            attempt.kind.as_str(),
            attempt.title,
            attempt.status.as_str(),
            attempt.intent_at,
        ],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

pub fn mark_attempt_running(conn: &Connection, attempt_id: &str, now: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_step_attempts SET status = 'running', started_at = ?2 WHERE id = ?1",
        params![attempt_id, now],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

pub fn finish_attempt(conn: &Connection, attempt: &StepAttempt) -> Result<(), String> {
    conn.execute(
        "UPDATE scheduled_step_attempts SET
            status = ?2, executed_command = ?3, exit_code = ?4, output_tail = ?5,
            output_redacted = ?6, output_truncated = ?7, termination = ?8, summary = ?9,
            commands_executed = ?10, commands_skipped = ?11, commands_blocked = ?12,
            prompt_tokens = ?13, completion_tokens = ?14, error = ?15,
            started_at = COALESCE(started_at, ?16), finished_at = COALESCE(?16, finished_at),
            duration_ms = ?17
         WHERE id = ?1",
        params![
            attempt.id,
            attempt.status.as_str(),
            attempt.executed_command,
            attempt.exit_code,
            attempt.output_tail,
            attempt.output_redacted as i64,
            attempt.output_truncated as i64,
            attempt.termination,
            attempt.summary,
            attempt.commands_executed,
            attempt.commands_skipped,
            attempt.commands_blocked,
            attempt.prompt_tokens,
            attempt.completion_tokens,
            attempt.error,
            // The Option is passed through, not flattened to "": an empty string
            // is not a timestamp, and it sorts before every real one.
            attempt.finished_at,
            attempt.duration_ms,
        ],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

fn attempt_from_row(row: &Row<'_>) -> rusqlite::Result<StepAttempt> {
    Ok(StepAttempt {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        step_id: row.get("step_id")?,
        sort_order: row.get("sort_order")?,
        kind: row
            .get::<_, String>("kind")?
            .parse()
            .unwrap_or(StepKind::Command),
        title: row.get("title")?,
        status: row
            .get::<_, String>("status")?
            .parse()
            .unwrap_or(StepAttemptStatus::Unknown),
        executed_command: row.get("executed_command")?,
        exit_code: row.get("exit_code")?,
        output_tail: row.get("output_tail")?,
        output_redacted: row.get::<_, i64>("output_redacted")? != 0,
        output_truncated: row.get::<_, i64>("output_truncated")? != 0,
        termination: row.get("termination")?,
        summary: row.get("summary")?,
        commands_executed: row.get("commands_executed")?,
        commands_skipped: row.get("commands_skipped")?,
        commands_blocked: row.get("commands_blocked")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
        error: row.get("error")?,
        intent_at: row.get("intent_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
    })
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<ScheduledRun> {
    Ok(ScheduledRun {
        id: row.get("id")?,
        action_id: row.get("action_id")?,
        action_name: row.get("action_name")?,
        plan_sha256: row.get("plan_sha256")?,
        trigger: row
            .get::<_, String>("trigger")?
            .parse()
            .unwrap_or(RunTrigger::Schedule),
        execution_mode: row
            .get::<_, String>("execution_mode")?
            .parse()
            .unwrap_or(ExecutionMode::Headless),
        permission_mode: row
            .get::<_, String>("permission_mode")?
            .parse()
            .unwrap_or(PermissionMode::Ask),
        target_kind: row.get("target_kind")?,
        target_label: row.get("target_label")?,
        target_host_id: row.get("target_host_id")?,
        session_id: row.get("session_id")?,
        status: row
            .get::<_, String>("status")?
            .parse()
            .unwrap_or(ScheduledRunStatus::Interrupted),
        skip_reason: row.get("skip_reason")?,
        error: row.get("error")?,
        model: row.get("model")?,
        web_access: row.get::<_, i64>("web_access")? != 0,
        app_version: row.get("app_version")?,
        cols: row.get("cols")?,
        rows: row.get("rows")?,
        scheduled_for: row.get("scheduled_for")?,
        created_at: row.get("created_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
        attempts: Vec::new(),
    })
}

const RUN_COLUMNS: &str = "id, action_id, action_name, plan_sha256, trigger, execution_mode,
     permission_mode, target_kind, target_label, target_host_id, session_id, status, skip_reason,
     error, model, web_access, app_version, cols, rows, scheduled_for, created_at, started_at,
     finished_at, prompt_tokens, completion_tokens";

pub fn list_runs(
    conn: &Connection,
    action_id: Option<&str>,
    limit: u32,
) -> Result<Vec<ScheduledRun>, String> {
    let limit = limit.clamp(1, 500);
    let sql = match action_id {
        Some(_) => format!(
            "SELECT {RUN_COLUMNS} FROM scheduled_runs WHERE action_id = ?1
               ORDER BY created_at DESC LIMIT ?2"
        ),
        None => {
            format!("SELECT {RUN_COLUMNS} FROM scheduled_runs ORDER BY created_at DESC LIMIT ?1")
        }
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = match action_id {
        Some(id) => stmt.query_map(params![id, limit], run_from_row),
        None => stmt.query_map(params![limit], run_from_row),
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn get_run(conn: &Connection, run_id: &str) -> Result<Option<ScheduledRun>, String> {
    let sql = format!("SELECT {RUN_COLUMNS} FROM scheduled_runs WHERE id = ?1");
    let mut run = match conn
        .query_row(&sql, params![run_id], run_from_row)
        .optional()
        .map_err(|e| e.to_string())?
    {
        Some(run) => run,
        None => return Ok(None),
    };
    let mut stmt = conn
        .prepare(
            "SELECT id, run_id, step_id, sort_order, kind, title, status, executed_command,
                    exit_code, output_tail, output_redacted, output_truncated, termination,
                    summary, commands_executed, commands_skipped, commands_blocked,
                    prompt_tokens, completion_tokens, error, intent_at, started_at,
                    finished_at, duration_ms
               FROM scheduled_step_attempts WHERE run_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id], attempt_from_row)
        .map_err(|e| e.to_string())?;
    run.attempts = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(Some(run))
}

pub fn plan_json_for_run(conn: &Connection, run_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT plan_json FROM scheduled_runs WHERE id = ?1",
        params![run_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn in_flight_run_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM scheduled_runs
               WHERE status IN ('pending','awaiting_target','running') ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn delete_run(conn: &Connection, run_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM scheduled_runs WHERE id = ?1", params![run_id])
        .map_err(|e| e.to_string())
        .map(|_| ())
}

pub fn prune_runs(conn: &Connection, before: &str) -> Result<u32, String> {
    conn.execute(
        "DELETE FROM scheduled_runs WHERE finished_at IS NOT NULL AND finished_at < ?1",
        params![before],
    )
    .map_err(|e| e.to_string())
    .map(|n| n as u32)
}

pub fn append_event(
    conn: &Connection,
    run_id: &str,
    event_type: &str,
    step_id: Option<&str>,
    payload_json: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO scheduled_events (id, run_id, sequence, event_type, step_id, payload_json, created_at)
         VALUES (?1, ?2,
                 COALESCE((SELECT MAX(sequence) + 1 FROM scheduled_events WHERE run_id = ?2), 0),
                 ?3, ?4, ?5, ?6)",
        params![
            uuid::Uuid::new_v4().to_string(),
            run_id,
            event_type,
            step_id,
            payload_json,
            now
        ],
    )
    .map_err(|e| e.to_string())
    .map(|_| ())
}

// -------------------------------------------------------------- recovery ----

/// Reconcile at DATABASE OPEN, not at exit.
///
/// The app leaves via `libc::_exit(0)` on `RunEvent::Exit`, which runs no
/// destructors, and a crash runs nothing at all. A run left `running` forever
/// would also hold the partial unique index and silently disable its action
/// permanently, which is why this must happen on every open and not only after a
/// clean quit.
///
/// It never re-dispatches. An attempt that had dispatched becomes `unknown` —
/// preserving the monotonic "may have changed" fact — and the next scheduled fire
/// is the recovery path.
pub fn interrupt_active_runs(conn: &mut Connection) -> Result<Vec<String>, String> {
    let ids = in_flight_run_ids(conn)?;
    if ids.is_empty() {
        return Ok(ids);
    }
    let now = now_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE scheduled_step_attempts SET
            status = 'unknown',
            error = COALESCE(error, 'the application stopped before this step reported a result'),
            finished_at = COALESCE(finished_at, ?1)
         WHERE status IN ('pending','running')
           AND run_id IN (SELECT id FROM scheduled_runs
                            WHERE status IN ('pending','awaiting_target','running'))",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE scheduled_runs SET
            status = 'interrupted',
            error = COALESCE(error, 'the application stopped while this run was in flight'),
            finished_at = COALESCE(finished_at, ?1),
            updated_at = ?1
         WHERE status IN ('pending','awaiting_target','running')",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE scheduled_actions SET last_status = 'interrupted', updated_at = ?1
           WHERE last_run_id IN (SELECT id FROM scheduled_runs WHERE status = 'interrupted')
             AND last_status IN ('pending','awaiting_target','running')",
        params![now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    log::warn!(
        "marked {} scheduled run(s) interrupted after an unclean shutdown",
        ids.len()
    );
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled::types::TimeOfDay;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn step(id: &str, kind: StepKind, text: &str) -> ScheduledStep {
        ScheduledStep {
            id: id.into(),
            sort_order: 0,
            title: format!("step {id}"),
            kind,
            text: text.into(),
            continue_on_failure: false,
        }
    }

    fn input(name: &str, target: ScheduledTarget) -> ScheduledActionInput {
        ScheduledActionInput {
            name: name.into(),
            enabled: true,
            target,
            steps: vec![step("s1", StepKind::Command, "echo hi")],
            execution_mode: ExecutionMode::Headless,
            permission_mode: PermissionMode::AutoRead,
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

    fn save(conn: &mut Connection, id: &str, input: &ScheduledActionInput) {
        let sha = steps_fingerprint(
            &input.target,
            &input.steps,
            &input.mcp_selection,
            &input.doc_buckets,
        );
        upsert_action(
            conn,
            id,
            input,
            &sha,
            Some("2026-06-01T00:00:00Z"),
            Some("2026-06-02T01:00:00Z"),
            None,
            "2026-06-01T00:00:00Z",
        )
        .unwrap();
    }

    fn seed_host(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO ssh_hosts (id, label, hostname, source, created_at, updated_at)
             VALUES (?1, ?1, 'example.test', 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![id],
        )
        .unwrap();
    }

    fn commit_for(
        conn: &mut Connection,
        run_id: &str,
        action_id: &str,
        status: ScheduledRunStatus,
    ) {
        let action = get_action(conn, action_id).unwrap().unwrap();
        let plan = serde_json::to_string(&action.input).unwrap();
        commit_run(
            conn,
            RunCommit {
                run_id,
                action: &action,
                trigger: RunTrigger::Schedule,
                status,
                skip_reason: (status == ScheduledRunStatus::Skipped).then_some("app was closed"),
                target_label: "local shell",
                plan_json: &plan,
                scheduled_for: "2026-06-02T01:00:00Z",
                next_fire_at: Some("2026-06-03T01:00:00Z"),
                interval_anchor_at: None,
                app_version: "0.5.7",
                now: "2026-06-02T01:00:01Z",
                advance_projection: true,
            },
        )
        .unwrap();
    }

    #[test]
    fn migration_v20_creates_every_table_and_index() {
        let conn = memory_db();
        for name in [
            "scheduled_actions",
            "scheduled_steps",
            "scheduled_runs",
            "scheduled_step_attempts",
            "scheduled_events",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{name} is missing");
        }
        for name in [
            "idx_scheduled_actions_name",
            "idx_scheduled_actions_due",
            "idx_scheduled_runs_one_inflight",
            "idx_scheduled_attempts_run",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    params![name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{name} is missing");
        }
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert!(version >= 20);
    }

    #[test]
    fn an_action_round_trips_through_the_database() {
        let mut conn = memory_db();
        let mut spec = input(
            "nightly",
            ScheduledTarget::LocalShell {
                cwd: Some("/tmp".into()),
            },
        );
        spec.steps.push(ScheduledStep {
            sort_order: 1,
            ..step("s2", StepKind::Prompt, "summarise the disk usage")
        });
        spec.recurrence = Recurrence::Weekly {
            weekdays: vec![Weekday::Monday, Weekday::Friday],
            at: TimeOfDay {
                hour: 7,
                minute: 30,
            },
        };
        save(&mut conn, "a1", &spec);
        let stored = get_action(&conn, "a1").unwrap().unwrap();
        assert_eq!(stored.input.name, "nightly");
        assert_eq!(stored.input.steps.len(), 2);
        assert_eq!(stored.input.steps[1].kind, StepKind::Prompt);
        assert_eq!(stored.input.recurrence, spec.recurrence);
        assert_eq!(stored.input.target, spec.target);
        assert_eq!(stored.next_fire_at.as_deref(), Some("2026-06-02T01:00:00Z"));
        assert_eq!(list_actions(&conn).unwrap().len(), 1);
        // An edit replaces the step list rather than appending to it.
        let mut edited = spec.clone();
        edited.steps.truncate(1);
        save(&mut conn, "a1", &edited);
        assert_eq!(
            get_action(&conn, "a1").unwrap().unwrap().input.steps.len(),
            1
        );
    }

    #[test]
    fn only_one_run_per_action_may_be_in_flight() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Pending);
        let action = get_action(&conn, "a1").unwrap().unwrap();
        let plan = serde_json::to_string(&action.input).unwrap();
        let second = commit_run(
            &mut conn,
            RunCommit {
                run_id: "r2",
                action: &action,
                trigger: RunTrigger::Schedule,
                status: ScheduledRunStatus::Pending,
                skip_reason: None,
                target_label: "local shell",
                plan_json: &plan,
                scheduled_for: "2026-06-03T01:00:00Z",
                next_fire_at: Some("2026-06-04T01:00:00Z"),
                interval_anchor_at: None,
                app_version: "0.5.7",
                now: "2026-06-03T01:00:01Z",
                advance_projection: true,
            },
        );
        assert!(second.is_err(), "a second in-flight run must be refused");
        // Once the first is terminal, the next fire is allowed.
        set_run_status(
            &conn,
            "r1",
            ScheduledRunStatus::Succeeded,
            None,
            "2026-06-02T01:05:00Z",
        )
        .unwrap();
        commit_for(&mut conn, "r3", "a1", ScheduledRunStatus::Pending);
    }

    /// The bug this guards: an overlap skip that steals `last_run_id` from the
    /// run still executing. When that run finishes, `set_run_status`'
    /// `WHERE last_run_id = ?` no longer matches, so the action shows "Skipped"
    /// permanently for a run that actually succeeded — and nothing corrects it.
    #[test]
    fn an_overlap_skip_does_not_steal_the_live_runs_projection() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Running);

        // The next occurrence comes due while r1 is still going.
        let action = get_action(&conn, "a1").unwrap().unwrap();
        let plan = serde_json::to_string(&action.input).unwrap();
        commit_run(
            &mut conn,
            RunCommit {
                run_id: "r2",
                action: &action,
                trigger: RunTrigger::Schedule,
                status: ScheduledRunStatus::Skipped,
                skip_reason: Some("the previous run of this action was still going"),
                target_label: "local shell",
                plan_json: &plan,
                scheduled_for: "2026-06-02T01:01:00Z",
                next_fire_at: Some("2026-06-02T01:02:00Z"),
                interval_anchor_at: None,
                app_version: "0.5.7",
                now: "2026-06-02T01:01:01Z",
                advance_projection: false,
            },
        )
        .unwrap();

        // The schedule still rolled forward — that is what stops a backlog.
        let mid = get_action(&conn, "a1").unwrap().unwrap();
        assert_eq!(mid.next_fire_at.as_deref(), Some("2026-06-02T01:02:00Z"));
        // But the live run still owns the projection.
        assert_eq!(mid.last_run_id.as_deref(), Some("r1"));

        set_run_status(
            &conn,
            "r1",
            ScheduledRunStatus::Succeeded,
            None,
            "2026-06-02T01:05:00Z",
        )
        .unwrap();
        let after = get_action(&conn, "a1").unwrap().unwrap();
        assert_eq!(after.last_status, Some(ScheduledRunStatus::Succeeded));
        assert_eq!(after.last_run_id.as_deref(), Some("r1"));
        // And the skip is still in the history, so the gap is visible.
        assert_eq!(
            get_run(&conn, "r2").unwrap().unwrap().status,
            ScheduledRunStatus::Skipped
        );
    }

    /// `finished_at` is a timestamp column. An empty string is not one, and it
    /// sorts before every real value — which is exactly the wrong direction for
    /// anything that compares timestamps lexicographically.
    #[test]
    fn an_unfinished_attempt_keeps_a_null_finished_at_rather_than_an_empty_string() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Running);
        let mut attempt = StepAttempt {
            id: "att1".into(),
            run_id: "r1".into(),
            step_id: "s1".into(),
            sort_order: 0,
            kind: StepKind::Command,
            title: "step".into(),
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
            intent_at: "2026-06-02T01:00:02Z".into(),
            started_at: None,
            finished_at: None,
            duration_ms: None,
        };
        insert_attempt(&conn, &attempt).unwrap();
        // A caller that has no finishing timestamp must not write one.
        attempt.status = StepAttemptStatus::Unknown;
        finish_attempt(&conn, &attempt).unwrap();
        let stored = get_run(&conn, "r1").unwrap().unwrap().attempts.remove(0);
        assert_eq!(stored.status, StepAttemptStatus::Unknown);
        assert!(stored.finished_at.is_none(), "got {:?}", stored.finished_at);

        // And a real one is written normally.
        attempt.finished_at = Some("2026-06-02T01:00:09Z".into());
        finish_attempt(&conn, &attempt).unwrap();
        let stored = get_run(&conn, "r1").unwrap().unwrap().attempts.remove(0);
        assert_eq!(stored.finished_at.as_deref(), Some("2026-06-02T01:00:09Z"));
    }

    #[test]
    fn a_skipped_run_requires_a_reason_and_a_normal_run_forbids_one() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Skipped);
        let run = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(run.status, ScheduledRunStatus::Skipped);
        assert_eq!(run.skip_reason.as_deref(), Some("app was closed"));
        // A skip is finished the moment it is recorded and never started.
        assert!(run.finished_at.is_some());
        assert!(run.started_at.is_none());
    }

    #[test]
    fn deleting_an_action_keeps_its_run_history_and_its_snapshotted_name() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Succeeded);
        delete_action(&conn, "a1").unwrap();
        let run = get_run(&conn, "r1").unwrap().unwrap();
        assert!(
            run.action_id.is_none(),
            "the FK must be SET NULL, not CASCADE"
        );
        assert_eq!(run.action_name, "nightly");
        assert!(!run.plan_sha256.is_empty());
    }

    #[test]
    fn deleting_a_run_cascades_its_attempts_and_events() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Running);
        insert_attempt(
            &conn,
            &StepAttempt {
                id: "att1".into(),
                run_id: "r1".into(),
                step_id: "s1".into(),
                sort_order: 0,
                kind: StepKind::Command,
                title: "step s1".into(),
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
                intent_at: "2026-06-02T01:00:02Z".into(),
                started_at: None,
                finished_at: None,
                duration_ms: None,
            },
        )
        .unwrap();
        append_event(
            &conn,
            "r1",
            "StepChanged",
            Some("s1"),
            "{}",
            "2026-06-02T01:00:03Z",
        )
        .unwrap();
        delete_run(&conn, "r1").unwrap();
        let attempts: i64 = conn
            .query_row("SELECT COUNT(*) FROM scheduled_step_attempts", [], |r| {
                r.get(0)
            })
            .unwrap();
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM scheduled_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!((attempts, events), (0, 0));
    }

    #[test]
    fn deleting_an_ssh_host_that_a_schedule_targets_is_refused() {
        let mut conn = memory_db();
        seed_host(&conn, "h1");
        save(
            &mut conn,
            "a1",
            &input(
                "remote nightly",
                ScheduledTarget::SshHost {
                    host_id: "h1".into(),
                },
            ),
        );
        let deleted = conn.execute("DELETE FROM ssh_hosts WHERE id = 'h1'", []);
        assert!(deleted.is_err(), "ON DELETE RESTRICT must refuse this");
        assert_eq!(
            actions_targeting_host(&conn, "h1").unwrap(),
            vec!["remote nightly"]
        );
    }

    #[test]
    fn a_half_edited_recurrence_violates_the_shape_check() {
        let conn = memory_db();
        // 'daily' with an interval field set is exactly the half-edited state the
        // shape CHECK exists to make unrepresentable.
        let bad = conn.execute(
            "INSERT INTO scheduled_actions
               (id, name, target_kind, execution_mode, steps_sha256, recurrence_kind,
                every_minutes, at_hour, at_minute, timezone, created_at, updated_at)
             VALUES ('x','x','local_shell','headless','sha','daily',30,3,0,'UTC','t','t')",
            [],
        );
        assert!(bad.is_err());
        // A weekly rule with no weekdays cannot be stored at all.
        let empty_week = conn.execute(
            "INSERT INTO scheduled_actions
               (id, name, target_kind, execution_mode, steps_sha256, recurrence_kind,
                at_hour, at_minute, weekday_mask, timezone, created_at, updated_at)
             VALUES ('y','y','local_shell','headless','sha','weekly',3,0,0,'UTC','t','t')",
            [],
        );
        assert!(empty_week.is_err());
    }

    /// `'full'` is absent from the CHECK list precisely so a hand-edited database
    /// cannot smuggle the unattended-everything mode into a schedule.
    #[test]
    fn the_full_permission_mode_cannot_be_stored_on_an_action() {
        let conn = memory_db();
        let smuggled = conn.execute(
            "INSERT INTO scheduled_actions
               (id, name, target_kind, execution_mode, permission_mode, steps_sha256,
                recurrence_kind, at_hour, at_minute, timezone, created_at, updated_at)
             VALUES ('z','z','local_shell','headless','full','sha','daily',3,0,'UTC','t','t')",
            [],
        );
        assert!(smuggled.is_err());
        assert!(!MIGRATION_V20_SQL.contains("'auto_all','full'"));
    }

    #[test]
    fn a_local_action_cannot_carry_a_host_id() {
        let conn = memory_db();
        seed_host(&conn, "h1");
        let mismatched = conn.execute(
            "INSERT INTO scheduled_actions
               (id, name, target_kind, target_host_id, execution_mode, steps_sha256,
                recurrence_kind, at_hour, at_minute, timezone, created_at, updated_at)
             VALUES ('m','m','local_shell','h1','headless','sha','daily',3,0,'UTC','t','t')",
            [],
        );
        assert!(mismatched.is_err());
    }

    #[test]
    fn interrupt_active_runs_marks_in_flight_runs_interrupted_and_their_attempts_unknown() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Running);
        let dispatched = StepAttempt {
            id: "att1".into(),
            run_id: "r1".into(),
            step_id: "s1".into(),
            sort_order: 0,
            kind: StepKind::Command,
            title: "step s1".into(),
            status: StepAttemptStatus::Running,
            executed_command: Some("echo hi".into()),
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
            intent_at: "2026-06-02T01:00:02Z".into(),
            started_at: Some("2026-06-02T01:00:02Z".into()),
            finished_at: None,
            duration_ms: None,
        };
        insert_attempt(&conn, &dispatched).unwrap();
        conn.execute(
            "UPDATE scheduled_step_attempts SET status='running' WHERE id='att1'",
            [],
        )
        .unwrap();

        let interrupted = interrupt_active_runs(&mut conn).unwrap();
        assert_eq!(interrupted, vec!["r1".to_string()]);
        let run = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!(run.status, ScheduledRunStatus::Interrupted);
        assert!(run.finished_at.is_some());
        // `unknown`, never `failed`: a dispatched command may well have run.
        assert_eq!(run.attempts[0].status, StepAttemptStatus::Unknown);
        assert!(run.attempts[0].error.is_some());
        // And the action is fireable again — a stuck `running` row would hold the
        // partial unique index and disable the action permanently.
        commit_for(&mut conn, "r2", "a1", ScheduledRunStatus::Pending);
        // Idempotent: a second open changes nothing.
        set_run_status(&conn, "r2", ScheduledRunStatus::Succeeded, None, "t").unwrap();
        assert!(interrupt_active_runs(&mut conn).unwrap().is_empty());
    }

    /// The arming fingerprint must move when the authorization's meaning moves,
    /// and must not move for a reordering that changes nothing.
    #[test]
    fn the_steps_fingerprint_tracks_everything_that_invalidates_an_arming() {
        let target = ScheduledTarget::LocalShell { cwd: None };
        let steps = vec![step("s1", StepKind::Command, "echo hi")];
        let base = steps_fingerprint(&target, &steps, &McpChatSelection::default(), &[]);

        let edited = vec![step("s1", StepKind::Command, "rm -rf /tmp/x")];
        assert_ne!(
            base,
            steps_fingerprint(&target, &edited, &McpChatSelection::default(), &[])
        );
        // A step id is bookkeeping; the text and kind are the authorization.
        let renamed = vec![step("other-id", StepKind::Command, "echo hi")];
        assert_eq!(
            base,
            steps_fingerprint(&target, &renamed, &McpChatSelection::default(), &[])
        );
        // Retargeting is a different authorization entirely.
        assert_ne!(
            base,
            steps_fingerprint(
                &ScheduledTarget::SshHost {
                    host_id: "h1".into()
                },
                &steps,
                &McpChatSelection::default(),
                &[]
            )
        );
        // So is attaching a bucket or a server.
        assert_ne!(
            base,
            steps_fingerprint(
                &target,
                &steps,
                &McpChatSelection::default(),
                &[KnowledgeBucketRef::Local {
                    bucket_id: "b1".into()
                }]
            )
        );
        let mut selection = McpChatSelection::default();
        selection.server_ids = vec!["srv-b".into(), "srv-a".into()];
        let sorted = {
            let mut other = McpChatSelection::default();
            other.server_ids = vec!["srv-a".into(), "srv-b".into()];
            steps_fingerprint(&target, &steps, &other, &[])
        };
        assert_eq!(
            steps_fingerprint(&target, &steps, &selection, &[]),
            sorted,
            "a reordered server list is the same authorization"
        );
    }

    #[test]
    fn a_once_action_disables_itself_in_the_transaction_that_records_its_run() {
        let mut conn = memory_db();
        let mut spec = input("one shot", ScheduledTarget::LocalShell { cwd: None });
        spec.recurrence = Recurrence::Once {
            at: "2026-06-02T01:00:00+00:00".into(),
        };
        save(&mut conn, "a1", &spec);
        let action = get_action(&conn, "a1").unwrap().unwrap();
        let plan = serde_json::to_string(&action.input).unwrap();
        commit_run(
            &mut conn,
            RunCommit {
                run_id: "r1",
                action: &action,
                trigger: RunTrigger::Schedule,
                status: ScheduledRunStatus::Pending,
                skip_reason: None,
                target_label: "local shell",
                plan_json: &plan,
                scheduled_for: "2026-06-02T01:00:00Z",
                next_fire_at: None,
                interval_anchor_at: None,
                app_version: "0.5.7",
                now: "2026-06-02T01:00:01Z",
                advance_projection: true,
            },
        )
        .unwrap();
        let after = get_action(&conn, "a1").unwrap().unwrap();
        assert!(
            !after.input.enabled,
            "a fired `once` rule must disable itself"
        );
        assert!(after.next_fire_at.is_none());
    }

    #[test]
    fn run_usage_accumulates_and_pruning_only_removes_finished_runs() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        commit_for(&mut conn, "r1", "a1", ScheduledRunStatus::Running);
        add_run_usage(&conn, "r1", 100, 20, "t").unwrap();
        add_run_usage(&conn, "r1", 5, 1, "t").unwrap();
        let run = get_run(&conn, "r1").unwrap().unwrap();
        assert_eq!((run.prompt_tokens, run.completion_tokens), (105, 21));
        // Still in flight, so pruning must not touch it.
        assert_eq!(prune_runs(&conn, "2030-01-01T00:00:00Z").unwrap(), 0);
        set_run_status(
            &conn,
            "r1",
            ScheduledRunStatus::Succeeded,
            None,
            "2026-06-02T02:00:00Z",
        )
        .unwrap();
        assert_eq!(prune_runs(&conn, "2030-01-01T00:00:00Z").unwrap(), 1);
    }

    #[test]
    fn action_names_are_unique_case_insensitively() {
        let mut conn = memory_db();
        save(
            &mut conn,
            "a1",
            &input("Nightly", ScheduledTarget::LocalShell { cwd: None }),
        );
        let sha = "sha";
        let clash = upsert_action(
            &mut conn,
            "a2",
            &input("nightly", ScheduledTarget::LocalShell { cwd: None }),
            sha,
            None,
            None,
            None,
            "t",
        );
        assert!(clash.is_err());
    }
}
