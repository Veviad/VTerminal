//! Durable runbook storage in the main hardened database.
//!
//! The schema stores immutable definition snapshots beside mutable executions.
//! Every dispatch writes an attempt in `intent` state before the terminal is
//! asked to run it; every observed result updates that attempt and appends an
//! event in the same transaction. This is what makes crash recovery honest.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(any(not(target_os = "windows"), test))]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use super::redact::{sanitize_output_tail, sha256_hex, FULL_EVIDENCE_BYTES, OUTPUT_TAIL_BYTES};
use super::report::{
    ReportApproval, ReportAttempt, ReportChecklistItem, ReportDefinition, ReportDeviation,
    ReportEnvironment, ReportEvidence, ReportResumeEnvironment, ReportTarget, ReportTiming,
    RunbookReport, MAX_REPORT_ATTEMPTS, MAX_REPORT_EVIDENCE_BYTES, MAX_REPORT_EVIDENCE_ITEMS,
    MAX_REPORT_PERSISTED_OUTPUT_BYTES, REPORT_API_VERSION,
};
use super::state::{
    ApprovalDecision, ApprovalStatus, AttemptStatus, EvidenceAvailability, EvidenceCaptureMode,
    RunStatus, RunbookPhase, StepStatus, TargetBinding, VerificationAssurance, Waiver,
};

type StoredReportColumns = (String, Option<String>, Option<String>, Option<String>);

/// Main-database migration v6. `database::migrations::run` must call this only
/// when its recorded version is below 6; the migration itself is append-only.
pub fn migrate_v6(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;

        CREATE TABLE runbook_sources (
            id                  TEXT PRIMARY KEY,
            package_path        TEXT NOT NULL UNIQUE,
            definition_id       TEXT NOT NULL,
            definition_version  TEXT NOT NULL,
            title               TEXT NOT NULL,
            source_sha256       TEXT NOT NULL,
            canonical_sha256    TEXT NOT NULL,
            valid               INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1)),
            validation_error    TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        );
        CREATE INDEX idx_runbook_sources_definition
            ON runbook_sources(definition_id, definition_version);

        CREATE TABLE runbook_runs (
            id                    TEXT PRIMARY KEY,
            source_id             TEXT REFERENCES runbook_sources(id) ON DELETE SET NULL,
            definition_id         TEXT NOT NULL,
            definition_version    TEXT NOT NULL,
            definition_title      TEXT NOT NULL,
            source_yaml           TEXT NOT NULL,
            canonical_json        TEXT NOT NULL,
            source_sha256         TEXT NOT NULL,
            canonical_sha256      TEXT NOT NULL,
            target_json           TEXT NOT NULL,
            target_session_id     TEXT NOT NULL,
            inputs_json           TEXT NOT NULL,
            evidence_mode         TEXT NOT NULL DEFAULT 'tail'
                                  CHECK(evidence_mode IN ('none','tail','full')),
            status                TEXT NOT NULL
                                  CHECK(status IN (
                                    'created','ready','running','waiting_approval',
                                    'waiting_operator','paused','succeeded',
                                    'completed_with_exceptions','failed','cancelled',
                                    'interrupted')),
            active_step_id        TEXT,
            active_phase          TEXT CHECK(active_phase IS NULL OR active_phase IN
                                      ('check','apply','verify')),
            pause_reason          TEXT,
            app_version           TEXT NOT NULL,
            model                 TEXT,
            created_at            TEXT NOT NULL,
            started_at            TEXT,
            finished_at           TEXT,
            updated_at            TEXT NOT NULL,
            report_json           TEXT,
            report_sha256         TEXT,
            report_generated_at   TEXT
        );
        CREATE INDEX idx_runbook_runs_history
            ON runbook_runs(created_at DESC);
        CREATE INDEX idx_runbook_runs_definition
            ON runbook_runs(definition_id, definition_version, created_at DESC);
        -- Engine memory is the friendly error; this is the durable backstop.
        CREATE UNIQUE INDEX idx_runbook_runs_active_session
            ON runbook_runs(target_session_id)
            WHERE status IN ('created','ready','running','waiting_approval',
                             'waiting_operator','paused');

    CREATE TABLE runbook_steps (
            run_id             TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
            step_id            TEXT NOT NULL,
            sort_order         INTEGER NOT NULL,
            title              TEXT NOT NULL,
            required           INTEGER NOT NULL CHECK(required IN (0,1)),
            status             TEXT NOT NULL
                               CHECK(status IN (
                                 'pending','checking','already_compliant','needs_action',
                                 'applying','verifying','remediated_verified','paused',
                                 'failed','skipped','waived','blocked','unknown')),
            changed            INTEGER NOT NULL DEFAULT 0 CHECK(changed IN (0,1)),
            assurance          TEXT CHECK(assurance IS NULL OR assurance IN
                                   ('deterministic_shell','shell_observed','agent_assisted',
                                    'ansible_runner','operator_attested')),
            summary            TEXT,
            operator_comment   TEXT,
            waiver_actor       TEXT,
            waiver_reason      TEXT,
            waiver_at          TEXT,
            updated_at         TEXT NOT NULL,
            PRIMARY KEY(run_id, step_id),
            UNIQUE(run_id, sort_order),
            CHECK(
              (status = 'waived' AND waiver_actor IS NOT NULL
                                  AND waiver_reason IS NOT NULL AND waiver_at IS NOT NULL)
              OR
              (status <> 'waived' AND waiver_actor IS NULL
                                   AND waiver_reason IS NULL AND waiver_at IS NULL)
            )
        );
        CREATE INDEX idx_runbook_steps_status ON runbook_steps(run_id, status);

        CREATE TABLE runbook_attempts (
            id                    TEXT PRIMARY KEY,
            run_id                TEXT NOT NULL,
            step_id               TEXT NOT NULL,
            phase                 TEXT NOT NULL CHECK(phase IN ('check','apply','verify')),
            sequence              INTEGER NOT NULL,
            executor              TEXT NOT NULL,
            status                TEXT NOT NULL
                                  CHECK(status IN ('intent','waiting_approval','running',
                                                   'succeeded','failed','unknown','cancelled',
                                                   'declined')),
            proposed_command      TEXT,
            executed_command      TEXT,
            exit_code             INTEGER,
            duration_ms           INTEGER,
            output_tail           TEXT,
            output_observed_bytes INTEGER CHECK(output_observed_bytes IS NULL OR output_observed_bytes >= 0),
            output_captured_bytes INTEGER CHECK(output_captured_bytes IS NULL OR output_captured_bytes >= 0),
            output_redacted       INTEGER NOT NULL DEFAULT 0 CHECK(output_redacted IN (0,1)),
            output_truncated      INTEGER NOT NULL DEFAULT 0 CHECK(output_truncated IN (0,1)),
            error                 TEXT,
            intent_at             TEXT NOT NULL,
            started_at            TEXT,
            result_at             TEXT,
            FOREIGN KEY(run_id, step_id) REFERENCES runbook_steps(run_id, step_id)
                ON DELETE CASCADE,
            UNIQUE(run_id, step_id, phase, sequence),
            CHECK(
              (output_observed_bytes IS NULL AND output_captured_bytes IS NULL)
              OR
              (output_observed_bytes IS NOT NULL AND output_captured_bytes IS NOT NULL
               AND output_observed_bytes >= output_captured_bytes)
            )
        );
        CREATE INDEX idx_runbook_attempts_run
            ON runbook_attempts(run_id, step_id, phase, sequence);
        CREATE UNIQUE INDEX idx_runbook_attempts_one_inflight
            ON runbook_attempts(run_id)
            WHERE executor != 'agent'
              AND status IN ('intent','waiting_approval','running');

        CREATE TABLE runbook_approvals (
            id                    TEXT PRIMARY KEY,
            attempt_id            TEXT NOT NULL REFERENCES runbook_attempts(id) ON DELETE CASCADE,
            run_id                TEXT NOT NULL,
            step_id               TEXT NOT NULL,
            phase                 TEXT NOT NULL CHECK(phase IN ('check','apply','verify')),
            status                TEXT NOT NULL CHECK(status IN
                                      ('pending','approved','declined','cancelled')),
            proposed_command      TEXT,
            executed_command      TEXT,
            read_only             INTEGER NOT NULL CHECK(read_only IN (0,1)),
            network               INTEGER NOT NULL CHECK(network IN (0,1)),
            privileged            INTEGER NOT NULL CHECK(privileged IN (0,1)),
            opaque                INTEGER NOT NULL CHECK(opaque IN (0,1)),
            actor                 TEXT,
            reason                TEXT,
            requested_at          TEXT NOT NULL,
            decided_at            TEXT,
            edited                INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)),
            FOREIGN KEY(run_id, step_id) REFERENCES runbook_steps(run_id, step_id)
                ON DELETE CASCADE
        );
        CREATE INDEX idx_runbook_approvals_run
            ON runbook_approvals(run_id, requested_at);
        CREATE UNIQUE INDEX idx_runbook_approvals_pending_attempt
            ON runbook_approvals(attempt_id) WHERE status = 'pending';

        CREATE TABLE runbook_events (
            id              TEXT PRIMARY KEY,
            run_id          TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
            sequence        INTEGER NOT NULL,
            event_type      TEXT NOT NULL,
            step_id         TEXT,
            attempt_id      TEXT,
            payload_json    TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            UNIQUE(run_id, sequence)
        );
        CREATE INDEX idx_runbook_events_run
            ON runbook_events(run_id, sequence);

        CREATE TABLE runbook_evidence (
            id              TEXT PRIMARY KEY,
            attempt_id      TEXT NOT NULL REFERENCES runbook_attempts(id) ON DELETE CASCADE,
            run_id          TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
            mode            TEXT NOT NULL CHECK(mode IN ('none','tail','full')),
            availability    TEXT NOT NULL DEFAULT 'complete'
                            CHECK(availability IN ('pending','complete','missing')),
            relative_path   TEXT,
            bytes           INTEGER NOT NULL CHECK(bytes >= 0),
            sha256          TEXT NOT NULL,
            redacted        INTEGER NOT NULL DEFAULT 0 CHECK(redacted IN (0,1)),
            truncated       INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
            created_at      TEXT NOT NULL
        );
        CREATE INDEX idx_runbook_evidence_run ON runbook_evidence(run_id, attempt_id);

        INSERT INTO schema_version (version) VALUES (6);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v6 failed: {e}"))
}

/// Main-database migration v8. Existing package registrations are user-owned;
/// bundled registrations are introduced only by startup reconciliation after
/// this migration has completed.
pub fn migrate_v8(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        ALTER TABLE runbook_sources
          ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'user'
            CHECK(source_kind IN ('user','builtin'));
        ALTER TABLE runbook_sources
          ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));
        ALTER TABLE runbook_sources
          ADD COLUMN builtin_order INTEGER CHECK(builtin_order IS NULL OR builtin_order >= 0);
        CREATE INDEX idx_runbook_sources_library
          ON runbook_sources(hidden, source_kind, builtin_order, title);
        INSERT INTO schema_version (version) VALUES (8);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v8 failed: {e}"))
}

/// Main-database migration v9. Draft JSON is intentionally separate from
/// runnable sources: incomplete authoring state can never be executed.
pub fn migrate_v9(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        CREATE TABLE runbook_drafts (
            id                              TEXT PRIMARY KEY,
            revision                        INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
            document_json                   TEXT NOT NULL,
            published_source_id             TEXT REFERENCES runbook_sources(id) ON DELETE SET NULL,
            last_published_version          TEXT,
            last_published_document_sha256  TEXT,
            last_published_source_sha256    TEXT,
            last_published_readme_sha256    TEXT,
            created_at                      TEXT NOT NULL,
            updated_at                      TEXT NOT NULL
        );
        CREATE INDEX idx_runbook_drafts_updated ON runbook_drafts(updated_at DESC);
        INSERT INTO schema_version (version) VALUES (9);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v9 failed: {e}"))
}

/// Main-database migration v10 introduces:
/// - Structured per-attempt outcomes in the durable attempt row.
/// - Approval digests bound to the exact project/inventory state.
pub fn migrate_v10(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        ALTER TABLE runbook_attempts
          ADD COLUMN structured_outcomes TEXT;
        ALTER TABLE runbook_approvals
          ADD COLUMN project_digest TEXT;
        ALTER TABLE runbook_approvals
          ADD COLUMN inventory_digest TEXT;
        COMMIT;
        "#,
    )
    .map_err(|e| format!("migration v10 failed: {e}"))?;

    // Databases created at the legacy v6/v9 shape cannot persist
    // ansible_runner in step assurance without this repair.
    let steps_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='runbook_steps'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect runbook steps schema: {error}"))?;
    if !steps_sql.contains("ansible_runner") {
        repair_v6_runbook_steps_assurance(conn)?;
    }

    conn.execute_batch("INSERT INTO schema_version (version) VALUES (10);")
        .map_err(|error| format!("record schema v10: {error}"))?;

    Ok(())
}

/// Main-database migration v16 records the reproducible source of app-managed
/// Ansible imports without changing ordinary user package registrations.
pub fn migrate_v16(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        CREATE TABLE runbook_ansible_imports (
            source_id            TEXT PRIMARY KEY
                                 REFERENCES runbook_sources(id) ON DELETE CASCADE,
            origin_project_path  TEXT NOT NULL,
            spec_json            TEXT NOT NULL,
            created_at           TEXT NOT NULL,
            updated_at           TEXT NOT NULL
        );
        INSERT INTO schema_version (version) VALUES (16);
        COMMIT;
        "#,
    )
    .map_err(|error| format!("migration v16 failed: {error}"))
}

/// Refresh the one v6 partial index whose predicate changed during the
/// unreleased experimental cycle. Fresh databases already have this shape;
/// existing developer/test v6 databases are repaired without altering data.
pub fn ensure_v6_runtime_indexes(conn: &Connection) -> Result<(), String> {
    // Runbooks v1 is still experimental, so v6 is repaired in place for local
    // developer databases. Existing tail rows are complete because SQLite is
    // their storage boundary. Existing full rows are conservatively pending
    // until startup reconciliation verifies the external artifact.
    let has_availability = {
        let mut statement = conn
            .prepare("PRAGMA table_info(runbook_evidence)")
            .map_err(|error| format!("inspect runbook evidence schema: {error}"))?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("query runbook evidence schema: {error}"))?;
        let mut found = false;
        for column in columns {
            if column.map_err(|error| format!("read runbook evidence schema: {error}"))?
                == "availability"
            {
                found = true;
                break;
            }
        }
        found
    };
    if !has_availability {
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             ALTER TABLE runbook_evidence
               ADD COLUMN availability TEXT NOT NULL DEFAULT 'complete'
                 CHECK(availability IN ('pending','complete','missing'));
             UPDATE runbook_evidence SET availability='pending' WHERE mode='full';
             COMMIT;",
        )
        .map_err(|error| format!("repair runbook evidence availability: {error}"))?;
    }

    let has_observed_bytes = table_has_column(conn, "runbook_attempts", "output_observed_bytes")?;
    let has_captured_bytes = table_has_column(conn, "runbook_attempts", "output_captured_bytes")?;
    if !has_observed_bytes || !has_captured_bytes {
        let mut sql = String::from("BEGIN IMMEDIATE;");
        if !has_observed_bytes {
            sql.push_str(
                "ALTER TABLE runbook_attempts ADD COLUMN output_observed_bytes INTEGER
                 CHECK(output_observed_bytes IS NULL OR output_observed_bytes >= 0);",
            );
        }
        if !has_captured_bytes {
            sql.push_str(
                "ALTER TABLE runbook_attempts ADD COLUMN output_captured_bytes INTEGER
                 CHECK(output_captured_bytes IS NULL OR output_captured_bytes >= 0);",
            );
        }
        sql.push_str(
            "UPDATE runbook_attempts
             SET output_observed_bytes=length(CAST(COALESCE(output_tail,'') AS BLOB)),
                 output_captured_bytes=length(CAST(COALESCE(output_tail,'') AS BLOB))
             WHERE output_observed_bytes IS NULL OR output_captured_bytes IS NULL;
             COMMIT;",
        );
        conn.execute_batch(&sql)
            .map_err(|error| format!("repair runbook attempt byte counts: {error}"))?;
    }

    let steps_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='runbook_steps'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect runbook step schema: {error}"))?;
    if !steps_sql.contains("shell_observed") || !steps_sql.contains("ansible_runner") {
        repair_v6_runbook_steps_assurance(conn)?;
    }

    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master
             WHERE type='index' AND name='idx_runbook_attempts_one_inflight'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("inspect runbook v6 indexes: {e}"))?;
    if !sql
        .as_deref()
        .is_some_and(|value| value.contains("executor != 'agent'"))
    {
        conn.execute_batch(
            "BEGIN;
             DROP INDEX IF EXISTS idx_runbook_attempts_one_inflight;
             CREATE UNIQUE INDEX idx_runbook_attempts_one_inflight
               ON runbook_attempts(run_id)
               WHERE executor != 'agent'
                 AND status IN ('intent','waiting_approval','running');
             COMMIT;",
        )
        .map_err(|e| format!("refresh runbook v6 indexes: {e}"))?;
    }
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    if !table
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("unsafe SQLite table identifier".into());
    }
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("inspect {table} schema: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("query {table} schema: {error}"))?;
    for found in columns {
        if found.map_err(|error| format!("read {table} schema: {error}"))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn repair_v6_runbook_steps_assurance(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;")
        .map_err(|error| format!("prepare runbook step schema repair: {error}"))?;
    let result = conn.execute_batch(
        r#"
        BEGIN IMMEDIATE;
        DROP INDEX IF EXISTS idx_runbook_steps_status;
        ALTER TABLE runbook_steps RENAME TO runbook_steps_v6_old;
        CREATE TABLE runbook_steps (
            run_id             TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
            step_id            TEXT NOT NULL,
            sort_order         INTEGER NOT NULL,
            title              TEXT NOT NULL,
            required           INTEGER NOT NULL CHECK(required IN (0,1)),
            status             TEXT NOT NULL
                               CHECK(status IN (
                                 'pending','checking','already_compliant','needs_action',
                                 'applying','verifying','remediated_verified','paused',
                                 'failed','skipped','waived','blocked','unknown')),
            changed            INTEGER NOT NULL DEFAULT 0 CHECK(changed IN (0,1)),
            assurance          TEXT CHECK(assurance IS NULL OR assurance IN
                                   ('deterministic_shell','shell_observed','agent_assisted',
                                    'ansible_runner','operator_attested')),
            summary            TEXT,
            operator_comment   TEXT,
            waiver_actor       TEXT,
            waiver_reason      TEXT,
            waiver_at          TEXT,
            updated_at         TEXT NOT NULL,
            PRIMARY KEY(run_id, step_id),
            UNIQUE(run_id, sort_order),
            CHECK(
              (status = 'waived' AND waiver_actor IS NOT NULL
                                  AND waiver_reason IS NOT NULL AND waiver_at IS NOT NULL)
              OR
              (status <> 'waived' AND waiver_actor IS NULL
                                   AND waiver_reason IS NULL AND waiver_at IS NULL)
            )
        );
        INSERT INTO runbook_steps
          (run_id,step_id,sort_order,title,required,status,changed,assurance,summary,
           operator_comment,waiver_actor,waiver_reason,waiver_at,updated_at)
        SELECT run_id,step_id,sort_order,title,required,status,changed,assurance,summary,
               operator_comment,waiver_actor,waiver_reason,waiver_at,updated_at
        FROM runbook_steps_v6_old;
        DROP TABLE runbook_steps_v6_old;
        CREATE INDEX idx_runbook_steps_status ON runbook_steps(run_id, status);
        COMMIT;
        "#,
    );
    if result.is_err() {
        let _ = conn.execute_batch("ROLLBACK;");
    }
    let restore = conn.execute_batch("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;");
    result
        .map_err(|error| format!("repair runbook step assurance schema: {error}"))
        .and_then(|_| {
            restore.map_err(|error| format!("restore SQLite foreign-key mode: {error}"))
        })?;
    let violations: Option<(String, i64, String)> = conn
        .query_row("PRAGMA foreign_key_check", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .optional()
        .map_err(|error| format!("check repaired runbook foreign keys: {error}"))?;
    if let Some((table, row, parent)) = violations {
        return Err(format!(
            "runbook step schema repair left a foreign-key violation in {table} row {row} referencing {parent}"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    User,
    Builtin,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Builtin => "builtin",
        }
    }
}

impl FromStr for SourceKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "user" => Ok(Self::User),
            "builtin" => Ok(Self::Builtin),
            _ => Err(format!("unknown runbook source kind: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRegistration {
    pub id: String,
    pub package_path: String,
    pub definition_id: String,
    pub definition_version: String,
    pub title: String,
    pub source_sha256: String,
    pub canonical_sha256: String,
    pub valid: bool,
    pub validation_error: Option<String>,
    pub source_kind: SourceKind,
    #[serde(skip_serializing, default)]
    pub hidden: bool,
    #[serde(skip_serializing, default)]
    pub builtin_order: Option<u32>,
    pub created_at: String,
    pub updated_at: String,
    pub managed_ansible: bool,
}

#[derive(Debug, Clone)]
pub struct SourceRegistrationInput {
    pub package_path: String,
    pub definition_id: String,
    pub definition_version: String,
    pub title: String,
    pub source_sha256: String,
    pub canonical_sha256: String,
    pub valid: bool,
    pub validation_error: Option<String>,
    pub source_kind: SourceKind,
    pub hidden: bool,
    pub builtin_order: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnsibleImportRecord {
    pub source_id: String,
    pub origin_project_path: String,
    pub spec_json: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn upsert_ansible_import(
    conn: &Connection,
    source_id: &str,
    origin_project_path: &str,
    spec_json: &str,
) -> Result<AnsibleImportRecord, String> {
    let timestamp = now();
    conn.execute(
        "INSERT INTO runbook_ansible_imports
           (source_id, origin_project_path, spec_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(source_id) DO UPDATE SET
           origin_project_path=excluded.origin_project_path,
           spec_json=excluded.spec_json,
           updated_at=excluded.updated_at",
        params![source_id, origin_project_path, spec_json, timestamp],
    )
    .map_err(|error| format!("save Ansible import metadata: {error}"))?;
    get_ansible_import(conn, source_id)?
        .ok_or_else(|| "saved Ansible import metadata disappeared".into())
}

pub fn get_ansible_import(
    conn: &Connection,
    source_id: &str,
) -> Result<Option<AnsibleImportRecord>, String> {
    conn.query_row(
        "SELECT source_id, origin_project_path, spec_json, created_at, updated_at
         FROM runbook_ansible_imports WHERE source_id=?1",
        [source_id],
        |row| {
            Ok(AnsibleImportRecord {
                source_id: row.get(0)?,
                origin_project_path: row.get(1)?,
                spec_json: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|error| format!("load Ansible import metadata: {error}"))
}

pub fn upsert_source(
    conn: &Connection,
    input: &SourceRegistrationInput,
) -> Result<SourceRegistration, String> {
    match (input.source_kind, input.builtin_order) {
        (SourceKind::User, None) | (SourceKind::Builtin, Some(_)) => {}
        (SourceKind::User, Some(_)) => {
            return Err("user runbook sources cannot have a built-in order".into())
        }
        (SourceKind::Builtin, None) => {
            return Err("built-in runbook sources require a stable order".into())
        }
    }
    if input.source_kind == SourceKind::User && input.hidden {
        return Err("user runbook sources cannot be hidden".into());
    }

    let existing: Option<(String, String, SourceKind, bool)> = conn
        .query_row(
            "SELECT id, created_at, source_kind, hidden
             FROM runbook_sources WHERE package_path = ?1",
            [&input.package_path],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    parse_enum::<SourceKind>(&row.get::<_, String>(2)?).map_err(text_sql_error)?,
                    row.get(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("find runbook source: {e}"))?;
    let now = now();
    let (id, created_at, hidden) = match existing {
        Some((id, created_at, SourceKind::Builtin, hidden))
            if input.source_kind == SourceKind::Builtin =>
        {
            (id, created_at, hidden)
        }
        Some((_, _, SourceKind::Builtin, _)) => {
            return Err(
                "the app-owned built-in runbook path cannot be imported as a user source".into(),
            )
        }
        Some((id, created_at, _, _)) => (id, created_at, input.hidden),
        None => (uuid::Uuid::new_v4().to_string(), now.clone(), input.hidden),
    };
    conn.execute(
        "INSERT INTO runbook_sources
           (id, package_path, definition_id, definition_version, title, source_sha256,
            canonical_sha256, valid, validation_error, source_kind, hidden, builtin_order,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(package_path) DO UPDATE SET
           definition_id=excluded.definition_id,
           definition_version=excluded.definition_version,
           title=excluded.title,
           source_sha256=excluded.source_sha256,
           canonical_sha256=excluded.canonical_sha256,
           valid=excluded.valid,
           validation_error=excluded.validation_error,
           source_kind=excluded.source_kind,
           hidden=excluded.hidden,
           builtin_order=excluded.builtin_order,
           updated_at=excluded.updated_at",
        params![
            id,
            input.package_path,
            input.definition_id,
            input.definition_version,
            input.title,
            input.source_sha256,
            input.canonical_sha256,
            input.valid,
            input.validation_error,
            input.source_kind.as_str(),
            hidden,
            input.builtin_order,
            created_at,
            now,
        ],
    )
    .map_err(|e| format!("save runbook source: {e}"))?;
    get_source(conn, &id)?.ok_or_else(|| "saved runbook source disappeared".into())
}

pub fn get_source(conn: &Connection, id: &str) -> Result<Option<SourceRegistration>, String> {
    conn.query_row(
        "SELECT id, package_path, definition_id, definition_version, title, source_sha256,
                canonical_sha256, valid, validation_error, source_kind, hidden, builtin_order,
                created_at, updated_at,
                EXISTS(SELECT 1 FROM runbook_ansible_imports ai WHERE ai.source_id=runbook_sources.id)
         FROM runbook_sources WHERE id = ?1",
        [id],
        source_row,
    )
    .optional()
    .map_err(|e| format!("load runbook source: {e}"))
}

pub fn get_source_by_package_path(
    conn: &Connection,
    package_path: &str,
) -> Result<Option<SourceRegistration>, String> {
    conn.query_row(
        "SELECT id, package_path, definition_id, definition_version, title, source_sha256,
                canonical_sha256, valid, validation_error, source_kind, hidden, builtin_order,
                created_at, updated_at,
                EXISTS(SELECT 1 FROM runbook_ansible_imports ai WHERE ai.source_id=runbook_sources.id)
         FROM runbook_sources WHERE package_path = ?1",
        [package_path],
        source_row,
    )
    .optional()
    .map_err(|e| format!("load runbook source by package path: {e}"))
}

pub fn list_sources(conn: &Connection) -> Result<Vec<SourceRegistration>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, package_path, definition_id, definition_version, title, source_sha256,
                    canonical_sha256, valid, validation_error, source_kind, hidden, builtin_order,
                    created_at, updated_at,
                    EXISTS(SELECT 1 FROM runbook_ansible_imports ai WHERE ai.source_id=runbook_sources.id)
             FROM runbook_sources
             WHERE hidden = 0
             ORDER BY CASE source_kind WHEN 'builtin' THEN 0 ELSE 1 END,
                      builtin_order, title COLLATE NOCASE, package_path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], source_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn remove_source(conn: &Connection, id: &str) -> Result<bool, String> {
    let source_kind = conn
        .query_row(
            "SELECT source_kind FROM runbook_sources WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("load runbook source before removal: {e}"))?;
    match source_kind.as_deref() {
        Some("builtin") => conn
            .execute(
                "UPDATE runbook_sources SET hidden = 1, updated_at = ?2 WHERE id = ?1",
                params![id, now()],
            )
            .map(|count| count > 0)
            .map_err(|e| format!("hide built-in runbook source: {e}")),
        Some("user") => conn
            .execute("DELETE FROM runbook_sources WHERE id = ?1", [id])
            .map(|count| count > 0)
            .map_err(|e| format!("remove runbook source: {e}")),
        Some(value) => Err(format!("unknown stored runbook source kind: {value}")),
        None => Ok(false),
    }
}

pub fn restore_builtin_sources(conn: &Connection) -> Result<Vec<SourceRegistration>, String> {
    conn.execute(
        "UPDATE runbook_sources
         SET hidden = 0, updated_at = ?1
         WHERE source_kind = 'builtin' AND hidden = 1",
        [now()],
    )
    .map_err(|e| format!("restore built-in runbook sources: {e}"))?;
    list_sources(conn)
}

fn source_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRegistration> {
    Ok(SourceRegistration {
        id: row.get(0)?,
        package_path: row.get(1)?,
        definition_id: row.get(2)?,
        definition_version: row.get(3)?,
        title: row.get(4)?,
        source_sha256: row.get(5)?,
        canonical_sha256: row.get(6)?,
        valid: row.get(7)?,
        validation_error: row.get(8)?,
        source_kind: parse_enum::<SourceKind>(&row.get::<_, String>(9)?).map_err(text_sql_error)?,
        hidden: row.get(10)?,
        builtin_order: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        managed_ansible: row.get(14)?,
    })
}

#[derive(Debug, Clone)]
pub struct StoredRunbookDraft {
    pub draft: super::drafts::RunbookDraft,
    pub document_json: String,
    pub last_published_document_sha256: Option<String>,
    pub last_published_source_sha256: Option<String>,
    pub last_published_readme_sha256: Option<String>,
}

pub fn create_runbook_draft(
    conn: &Connection,
    document: &super::drafts::RunbookDraftDocument,
) -> Result<StoredRunbookDraft, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let document_json = super::drafts::document_json(document)?;
    let timestamp = now();
    conn.execute(
        "INSERT INTO runbook_drafts
           (id, revision, document_json, created_at, updated_at)
         VALUES (?1, 1, ?2, ?3, ?3)",
        params![id, document_json, timestamp],
    )
    .map_err(|error| format!("create runbook draft: {error}"))?;
    get_runbook_draft(conn, &id)?.ok_or_else(|| "created runbook draft disappeared".into())
}

pub fn get_runbook_draft(
    conn: &Connection,
    id: &str,
) -> Result<Option<StoredRunbookDraft>, String> {
    conn.query_row(
        "SELECT id, revision, document_json, published_source_id,
                last_published_version, last_published_document_sha256,
                last_published_source_sha256, last_published_readme_sha256,
                created_at, updated_at
         FROM runbook_drafts WHERE id = ?1",
        [id],
        runbook_draft_row,
    )
    .optional()
    .map_err(|error| format!("load runbook draft: {error}"))
}

pub fn list_runbook_drafts(
    conn: &Connection,
) -> Result<Vec<super::drafts::RunbookDraftSummary>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, revision, document_json, published_source_id,
                    last_published_version, last_published_document_sha256,
                    last_published_source_sha256, last_published_readme_sha256,
                    created_at, updated_at
             FROM runbook_drafts ORDER BY updated_at DESC, id",
        )
        .map_err(|error| format!("prepare runbook draft list: {error}"))?;
    let rows = statement
        .query_map([], runbook_draft_row)
        .map_err(|error| format!("query runbook drafts: {error}"))?;
    let mut summaries = Vec::new();
    for row in rows {
        let stored = row.map_err(|error| format!("read runbook draft: {error}"))?;
        let document = &stored.draft.document;
        summaries.push(super::drafts::RunbookDraftSummary {
            id: stored.draft.id,
            revision: stored.draft.revision,
            title: document.title.clone(),
            definition_id: document.definition_id.clone(),
            version: document.version.clone(),
            published_source_id: stored.draft.published_source_id,
            last_published_version: stored.draft.last_published_version,
            dirty: stored.draft.dirty,
            updated_at: stored.draft.updated_at,
        });
    }
    Ok(summaries)
}

pub fn save_runbook_draft(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    document: &super::drafts::RunbookDraftDocument,
) -> Result<StoredRunbookDraft, String> {
    let document_json = super::drafts::document_json(document)?;
    let updated = conn
        .execute(
            "UPDATE runbook_drafts
             SET document_json = ?3, revision = revision + 1, updated_at = ?4
             WHERE id = ?1 AND revision = ?2",
            params![id, expected_revision, document_json, now()],
        )
        .map_err(|error| format!("save runbook draft: {error}"))?;
    if updated == 0 {
        return if get_runbook_draft(conn, id)?.is_some() {
            Err("runbook draft changed in another window; reload it before saving".into())
        } else {
            Err(format!("unknown runbook draft: {id}"))
        };
    }
    get_runbook_draft(conn, id)?.ok_or_else(|| "saved runbook draft disappeared".into())
}

pub struct PublishedDraftHashes<'a> {
    pub version: &'a str,
    pub document_sha256: &'a str,
    pub source_sha256: &'a str,
    pub readme_sha256: &'a str,
    pub source_id: &'a str,
}

pub fn mark_runbook_draft_published(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
    hashes: PublishedDraftHashes<'_>,
) -> Result<StoredRunbookDraft, String> {
    let updated = conn
        .execute(
            "UPDATE runbook_drafts
             SET published_source_id = ?3,
                 last_published_version = ?4,
                 last_published_document_sha256 = ?5,
                 last_published_source_sha256 = ?6,
                 last_published_readme_sha256 = ?7,
                 updated_at = ?8
             WHERE id = ?1 AND revision = ?2",
            params![
                id,
                expected_revision,
                hashes.source_id,
                hashes.version,
                hashes.document_sha256,
                hashes.source_sha256,
                hashes.readme_sha256,
                now(),
            ],
        )
        .map_err(|error| format!("mark runbook draft published: {error}"))?;
    if updated == 0 {
        return Err("runbook draft changed before publication completed".into());
    }
    get_runbook_draft(conn, id)?.ok_or_else(|| "published runbook draft disappeared".into())
}

pub fn discard_runbook_draft(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM runbook_drafts WHERE id = ?1", [id])
        .map(|count| count > 0)
        .map_err(|error| format!("discard runbook draft: {error}"))
}

fn runbook_draft_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRunbookDraft> {
    let document_json: String = row.get(2)?;
    let document = super::drafts::decode_document(&document_json).map_err(text_sql_error)?;
    let last_published_document_sha256: Option<String> = row.get(5)?;
    let dirty = last_published_document_sha256
        .as_deref()
        .is_none_or(|digest| digest != sha256_hex(document_json.as_bytes()));
    Ok(StoredRunbookDraft {
        draft: super::drafts::RunbookDraft {
            id: row.get(0)?,
            revision: row.get(1)?,
            document,
            published_source_id: row.get(3)?,
            last_published_version: row.get(4)?,
            dirty,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        },
        document_json,
        last_published_document_sha256,
        last_published_source_sha256: row.get(6)?,
        last_published_readme_sha256: row.get(7)?,
    })
}

#[derive(Debug, Clone)]
pub struct RunCreation {
    pub source_id: Option<String>,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_title: String,
    pub source_yaml: String,
    pub canonical_json: String,
    pub source_sha256: String,
    pub canonical_sha256: String,
    pub target: TargetBinding,
    pub inputs: Value,
    pub evidence_mode: EvidenceCaptureMode,
    pub app_version: String,
    pub model: Option<String>,
    pub steps: Vec<StepSeed>,
}

#[derive(Debug, Clone)]
pub struct StepSeed {
    pub id: String,
    pub title: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub source_id: Option<String>,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_title: String,
    pub source_yaml: String,
    pub canonical_json: String,
    pub source_sha256: String,
    pub canonical_sha256: String,
    pub target: TargetBinding,
    pub inputs: Value,
    pub evidence_mode: EvidenceCaptureMode,
    pub status: RunStatus,
    pub active_step_id: Option<String>,
    pub active_phase: Option<RunbookPhase>,
    pub pause_reason: Option<String>,
    pub app_version: String,
    pub model: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
    pub report_sha256: Option<String>,
    pub report_generated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub id: String,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_title: String,
    pub target_session_id: String,
    pub status: RunStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub report_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRecord {
    pub run_id: String,
    pub step_id: String,
    pub sort_order: u32,
    pub title: String,
    pub required: bool,
    pub status: StepStatus,
    pub changed: bool,
    pub assurance: Option<VerificationAssurance>,
    pub summary: Option<String>,
    pub operator_comment: Option<String>,
    pub waiver: Option<Waiver>,
    pub updated_at: String,
}

pub fn create_run(conn: &mut Connection, input: &RunCreation) -> Result<RunRecord, String> {
    if input.steps.is_empty() {
        return Err("a run must contain at least one step".into());
    }
    serde_json::from_str::<Value>(&input.canonical_json)
        .map_err(|e| format!("canonical definition is not JSON: {e}"))?;
    let target_json = serde_json::to_string(&input.target).map_err(|e| e.to_string())?;
    let inputs_json = serde_json::to_string(&input.inputs).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO runbook_runs
           (id, source_id, definition_id, definition_version, definition_title, source_yaml,
            canonical_json, source_sha256, canonical_sha256, target_json, target_session_id,
            inputs_json, evidence_mode, status, app_version, model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'created',
                 ?14, ?15, ?16, ?16)",
        params![
            id,
            input.source_id,
            input.definition_id,
            input.definition_version,
            input.definition_title,
            input.source_yaml,
            input.canonical_json,
            input.source_sha256,
            input.canonical_sha256,
            target_json,
            input.target.lock_key(),
            inputs_json,
            input.evidence_mode.as_str(),
            input.app_version,
            input.model,
            timestamp,
        ],
    )
    .map_err(|e| format!("create runbook run: {e}"))?;
    for (index, step) in input.steps.iter().enumerate() {
        tx.execute(
            "INSERT INTO runbook_steps
               (run_id, step_id, sort_order, title, required, status, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
            params![
                id,
                step.id,
                index as i64,
                step.title,
                step.required,
                timestamp
            ],
        )
        .map_err(|e| format!("create runbook step {}: {e}", step.id))?;
    }
    append_event_tx(
        &tx,
        &id,
        "run_created",
        None,
        None,
        &serde_json::json!({"status":"created"}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_run(conn, &id)?.ok_or_else(|| "created run disappeared".into())
}

pub fn get_run(conn: &Connection, id: &str) -> Result<Option<RunRecord>, String> {
    conn.query_row(
        "SELECT id, source_id, definition_id, definition_version, definition_title, source_yaml,
                canonical_json, source_sha256, canonical_sha256, target_json, inputs_json,
                evidence_mode, status, active_step_id, active_phase, pause_reason, app_version,
                model, created_at, started_at, finished_at, updated_at, report_sha256,
                report_generated_at
         FROM runbook_runs WHERE id = ?1",
        [id],
        run_row,
    )
    .optional()
    .map_err(|e| format!("load runbook run: {e}"))
}

pub fn list_runs(conn: &Connection, limit: u32, offset: u32) -> Result<Vec<RunSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, definition_id, definition_version, definition_title, target_session_id,
                    status, created_at, started_at, finished_at, report_json IS NOT NULL
             FROM runbook_runs ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.min(500), offset], |row| {
            let status: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                status,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, bool>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (
            id,
            definition_id,
            definition_version,
            definition_title,
            target_session_id,
            status,
            created_at,
            started_at,
            finished_at,
            report_ready,
        ) = row.map_err(|e| e.to_string())?;
        Ok(RunSummary {
            id,
            definition_id,
            definition_version,
            definition_title,
            target_session_id,
            status: parse_enum(&status)?,
            created_at,
            started_at,
            finished_at,
            report_ready,
        })
    })
    .collect()
}

/// Immutable metadata needed to verify and remove protected evidence artifacts
/// before deleting the corresponding durable history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeletedRun {
    pub id: String,
    pub evidence: Vec<EvidenceRecord>,
}

/// Inspect one completed run without modifying its durable history. Callers use
/// this snapshot to finish verified artifact cleanup before requesting deletion,
/// so a filesystem failure remains retryable.
pub fn inspect_terminal_run(conn: &Connection, run_id: &str) -> Result<DeletedRun, String> {
    let status: String = conn
        .query_row(
            "SELECT status FROM runbook_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("load runbook before deletion: {error}"))?
        .ok_or_else(|| format!("unknown runbook run: {run_id}"))?;
    let status: RunStatus = parse_enum(&status)?;
    if !status.is_terminal() {
        return Err(format!(
            "run {run_id} is {status}; only completed run history can be deleted"
        ));
    }
    Ok(DeletedRun {
        id: run_id.to_string(),
        evidence: list_evidence(conn, run_id)?,
    })
}

/// Explicitly delete one completed run and every child audit row. Package
/// registrations are independent and are intentionally retained. Active,
/// paused and interrupted runs are rejected: their engine/session ownership
/// must be settled before history can disappear.
pub fn delete_terminal_run(conn: &mut Connection, run_id: &str) -> Result<DeletedRun, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let snapshot = inspect_terminal_run(&tx, run_id)?;

    let deleted = tx
        .execute("DELETE FROM runbook_runs WHERE id=?1", [run_id])
        .map_err(|error| format!("delete runbook history: {error}"))?;
    if deleted != 1 {
        return Err(format!("run {run_id} disappeared during deletion"));
    }
    tx.commit()
        .map_err(|error| format!("commit runbook history deletion: {error}"))?;
    Ok(snapshot)
}

/// Begin explicit history deletion by durably making every filesystem-backed
/// artifact unavailable and rewriting the canonical terminal report in the
/// same transaction. Cleanup therefore cannot get ahead of report truth: if a
/// later file or database delete fails, retained history says `missing` and
/// export will not read the tombstoned artifact.
pub fn tombstone_evidence_for_deletion(
    conn: &mut Connection,
    run_id: &str,
) -> Result<DeletedRun, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    inspect_terminal_run(&tx, run_id)?;
    let changed = tx
        .execute(
            "UPDATE runbook_evidence SET availability='missing'
             WHERE run_id=?1 AND mode='full' AND availability!='missing'",
            [run_id],
        )
        .map_err(|error| format!("tombstone runbook evidence: {error}"))?;
    if changed == 0 {
        tx.commit()
            .map_err(|error| format!("commit evidence deletion tombstone: {error}"))?;
        return inspect_terminal_run(conn, run_id);
    }

    let (stored_report, stored_hash): (Option<String>, Option<String>) = tx
        .query_row(
            "SELECT report_json,report_sha256 FROM runbook_runs WHERE id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| format!("load report before evidence tombstone: {error}"))?;
    let executive_summary = match (stored_report, stored_hash) {
        (Some(raw), Some(hash)) => {
            if sha256_hex(raw.as_bytes()) != hash {
                return Err("stored report failed its SHA-256 check before deletion".into());
            }
            serde_json::from_str::<Value>(&raw)
                .map_err(|error| format!("parse report before evidence tombstone: {error}"))?
                .get("executive_summary")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        }
        (None, None) => String::new(),
        _ => return Err("stored report metadata is incomplete before deletion".into()),
    };
    let prior_status: String = tx
        .query_row(
            "SELECT status FROM runbook_runs WHERE id=?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("load run status before evidence tombstone: {error}"))?;
    if prior_status == RunStatus::Succeeded.as_str() {
        tx.execute(
            "UPDATE runbook_runs SET status='completed_with_exceptions' WHERE id=?1",
            [run_id],
        )
        .map_err(|error| format!("downgrade run with deleted evidence: {error}"))?;
    }
    let report = assemble_report(&tx, run_id, &executive_summary)?;
    let canonical = report.canonical_json()?;
    let hash = sha256_hex(canonical.as_bytes());
    let timestamp = now();
    tx.execute(
        "UPDATE runbook_runs
         SET report_json=?2,report_sha256=?3,report_generated_at=?4,updated_at=?4
         WHERE id=?1",
        params![run_id, canonical, hash, timestamp],
    )
    .map_err(|error| format!("store evidence-tombstoned report: {error}"))?;
    append_event_tx(
        &tx,
        run_id,
        "evidence_tombstoned_for_deletion",
        None,
        None,
        &serde_json::json!({"count": changed, "report_sha256": hash}),
        &timestamp,
    )?;
    if prior_status == RunStatus::Succeeded.as_str() {
        append_event_tx(
            &tx,
            run_id,
            "run_status_changed",
            None,
            None,
            &serde_json::json!({
                "from": RunStatus::Succeeded,
                "to": RunStatus::CompletedWithExceptions,
                "reason": "requested evidence became unavailable during explicit history deletion"
            }),
            &timestamp,
        )?;
    }
    tx.commit()
        .map_err(|error| format!("commit evidence deletion tombstone: {error}"))?;
    inspect_terminal_run(conn, run_id)
}

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunRecord> {
    let target_json: String = row.get(9)?;
    let inputs_json: String = row.get(10)?;
    let evidence_mode: String = row.get(11)?;
    let status: String = row.get(12)?;
    let phase: Option<String> = row.get(14)?;
    Ok(RunRecord {
        id: row.get(0)?,
        source_id: row.get(1)?,
        definition_id: row.get(2)?,
        definition_version: row.get(3)?,
        definition_title: row.get(4)?,
        source_yaml: row.get(5)?,
        canonical_json: row.get(6)?,
        source_sha256: row.get(7)?,
        canonical_sha256: row.get(8)?,
        target: serde_json::from_str(&target_json).map_err(json_sql_error)?,
        inputs: serde_json::from_str(&inputs_json).map_err(json_sql_error)?,
        evidence_mode: parse_enum(&evidence_mode).map_err(text_sql_error)?,
        status: parse_enum(&status).map_err(text_sql_error)?,
        active_step_id: row.get(13)?,
        active_phase: phase
            .map(|value| parse_enum(&value).map_err(text_sql_error))
            .transpose()?,
        pause_reason: row.get(15)?,
        app_version: row.get(16)?,
        model: row.get(17)?,
        created_at: row.get(18)?,
        started_at: row.get(19)?,
        finished_at: row.get(20)?,
        updated_at: row.get(21)?,
        report_sha256: row.get(22)?,
        report_generated_at: row.get(23)?,
    })
}

pub fn transition_run(
    conn: &mut Connection,
    run_id: &str,
    expected: RunStatus,
    next: RunStatus,
    pause_reason: Option<&str>,
) -> Result<RunRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    transition_run_tx(&tx, run_id, expected, next, pause_reason)?;
    tx.commit().map_err(|e| e.to_string())?;
    get_run(conn, run_id)?.ok_or_else(|| "transitioned run disappeared".into())
}

/// The run-status half of a transition, inside a caller-owned transaction.
///
/// Split out so a status change can be committed together with the approval row
/// that causes it. A reader on another connection must never observe
/// `waiting_approval` with no pending approval, or `running` with one: the
/// runbook panel drives its whole approval UI off exactly that pair.
fn transition_run_tx(
    tx: &Transaction<'_>,
    run_id: &str,
    expected: RunStatus,
    next: RunStatus,
    pause_reason: Option<&str>,
) -> Result<(), String> {
    if !expected.can_transition_to(next) {
        return Err(format!("invalid run transition: {expected} -> {next}"));
    }
    let actual: String = tx
        .query_row(
            "SELECT status FROM runbook_runs WHERE id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown run: {run_id}"))?;
    if actual != expected.as_str() {
        return Err(format!("run {run_id} is {actual}, expected {expected}"));
    }
    let timestamp = now();
    let started_at = (next == RunStatus::Running).then_some(timestamp.as_str());
    let finished_at = next.is_terminal().then_some(timestamp.as_str());
    tx.execute(
        "UPDATE runbook_runs SET status=?2,
             started_at=COALESCE(started_at, ?3), finished_at=COALESCE(?4, finished_at),
             pause_reason=?5, updated_at=?6 WHERE id=?1 AND status=?7",
        params![
            run_id,
            next.as_str(),
            started_at,
            finished_at,
            pause_reason,
            timestamp,
            expected.as_str()
        ],
    )
    .map_err(|e| format!("transition run: {e}"))?;
    append_event_tx(
        tx,
        run_id,
        "run_status_changed",
        None,
        None,
        &serde_json::json!({"from":expected,"to":next,"reason":pause_reason}),
        &timestamp,
    )?;
    Ok(())
}

pub fn list_steps(conn: &Connection, run_id: &str) -> Result<Vec<StepRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT run_id, step_id, sort_order, title, required, status, changed, assurance,
                    summary, operator_comment, waiver_actor, waiver_reason, waiver_at, updated_at
             FROM runbook_steps WHERE run_id=?1 ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let raw = stmt
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, bool>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    raw.map(|row| {
        let (
            run_id,
            step_id,
            sort_order,
            title,
            required,
            status,
            changed,
            assurance,
            summary,
            operator_comment,
            waiver_actor,
            waiver_reason,
            waiver_at,
            updated_at,
        ) = row.map_err(|e| e.to_string())?;
        let waiver = match (waiver_actor, waiver_reason, waiver_at) {
            (Some(actor), Some(reason), Some(created_at)) => Some(Waiver {
                actor,
                reason,
                created_at,
            }),
            (None, None, None) => None,
            _ => return Err(format!("step {step_id} has incomplete waiver data")),
        };
        Ok(StepRecord {
            run_id,
            step_id,
            sort_order: sort_order as u32,
            title,
            required,
            status: parse_enum(&status)?,
            changed,
            assurance: assurance.map(|value| parse_enum(&value)).transpose()?,
            summary,
            operator_comment,
            waiver,
            updated_at,
        })
    })
    .collect()
}

#[derive(Debug, Default)]
pub struct StepUpdate<'a> {
    pub changed: bool,
    pub assurance: Option<VerificationAssurance>,
    pub summary: Option<&'a str>,
    pub operator_comment: Option<&'a str>,
    pub waiver: Option<&'a Waiver>,
}

pub fn transition_step(
    conn: &mut Connection,
    run_id: &str,
    step_id: &str,
    expected: StepStatus,
    next: StepStatus,
    update: StepUpdate<'_>,
) -> Result<StepRecord, String> {
    if !expected.can_transition_to(next) {
        return Err(format!("invalid step transition: {expected} -> {next}"));
    }
    if next == StepStatus::Waived {
        update
            .waiver
            .ok_or("a waived step requires waiver metadata")?
            .validate()?;
    } else if update.waiver.is_some() {
        return Err("waiver metadata is only valid for a waived step".into());
    }
    if next == StepStatus::RemediatedVerified && !update.changed {
        return Err("a remediated_verified step must be marked changed".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let (waiver_actor, waiver_reason, waiver_at) = update
        .waiver
        .map(|w| {
            (
                Some(w.actor.as_str()),
                Some(w.reason.as_str()),
                Some(w.created_at.as_str()),
            )
        })
        .unwrap_or((None, None, None));
    let count = tx
        .execute(
            "UPDATE runbook_steps SET status=?3, changed=?4, assurance=?5, summary=?6,
                 operator_comment=?7, waiver_actor=?8, waiver_reason=?9, waiver_at=?10,
                 updated_at=?11 WHERE run_id=?1 AND step_id=?2 AND status=?12",
            params![
                run_id,
                step_id,
                next.as_str(),
                update.changed,
                update.assurance.map(|v| v.as_str()),
                update.summary,
                update.operator_comment,
                waiver_actor,
                waiver_reason,
                waiver_at,
                timestamp,
                expected.as_str()
            ],
        )
        .map_err(|e| format!("transition runbook step: {e}"))?;
    if count != 1 {
        return Err(format!(
            "step {step_id} was not in expected state {expected}"
        ));
    }
    tx.execute(
        "UPDATE runbook_runs SET active_step_id=?2, active_phase=?3, updated_at=?4 WHERE id=?1",
        params![
            run_id,
            step_id,
            phase_for_step(next).map(|v| v.as_str()),
            timestamp
        ],
    )
    .map_err(|e| e.to_string())?;
    append_event_tx(
        &tx,
        run_id,
        "step_status_changed",
        Some(step_id),
        None,
        &serde_json::json!({"from":expected,"to":next}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    list_steps(conn, run_id)?
        .into_iter()
        .find(|step| step.step_id == step_id)
        .ok_or_else(|| "transitioned step disappeared".into())
}

fn phase_for_step(status: StepStatus) -> Option<RunbookPhase> {
    match status {
        StepStatus::Checking => Some(RunbookPhase::Check),
        StepStatus::Applying => Some(RunbookPhase::Apply),
        StepStatus::Verifying => Some(RunbookPhase::Verify),
        _ => None,
    }
}

/// Persist the engine cursor independently of a step transition. Passing no
/// step and no phase advances to the next ordered checklist item while keeping
/// the completed/exception status intact (notably assessment-only
/// `needs_action`). A phase without a step is never valid.
pub fn set_run_cursor(
    conn: &mut Connection,
    run_id: &str,
    step_id: Option<&str>,
    phase: Option<RunbookPhase>,
) -> Result<(), String> {
    if phase.is_some() && step_id.is_none() {
        return Err("a runbook phase requires an active step".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if let Some(step_id) = step_id {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM runbook_steps WHERE run_id=?1 AND step_id=?2)",
                params![run_id, step_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("unknown step {step_id} in run {run_id}"));
        }
    }
    let timestamp = now();
    let count = tx
        .execute(
            "UPDATE runbook_runs SET active_step_id=?2,active_phase=?3,updated_at=?4 WHERE id=?1",
            params![
                run_id,
                step_id,
                phase.map(|value| value.as_str()),
                timestamp
            ],
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err(format!("unknown run: {run_id}"));
    }
    append_event_tx(
        &tx,
        run_id,
        "run_cursor_changed",
        step_id,
        None,
        &serde_json::json!({"step_id":step_id,"phase":phase}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())
}

/// Persist an explicit retry decision. A fresh check is mandatory, so this is
/// intentionally the only helper allowed to move an uncertain/paused step back
/// to pending rather than relaxing the ordinary forward-only transition table.
pub fn reset_step_for_retry(
    conn: &mut Connection,
    run_id: &str,
    step_id: &str,
) -> Result<StepRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let count = tx
        .execute(
            "UPDATE runbook_steps SET status='pending',assurance=NULL,summary=NULL,
                 operator_comment=NULL,waiver_actor=NULL,waiver_reason=NULL,waiver_at=NULL,
                 updated_at=?3 WHERE run_id=?1 AND step_id=?2 AND status IN
                 ('paused','unknown','blocked','needs_action','failed')",
            params![run_id, step_id, timestamp],
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err(format!("step {step_id} is not eligible for retry"));
    }
    let run_count = tx
        .execute(
            "UPDATE runbook_runs SET status='running',active_step_id=NULL,active_phase=NULL,
             pause_reason=NULL,updated_at=?2 WHERE id=?1 AND active_step_id=?3
             AND status IN ('paused','waiting_operator')",
            params![run_id, timestamp, step_id],
        )
        .map_err(|e| e.to_string())?;
    if run_count != 1 {
        return Err(format!(
            "run {run_id} is not paused on step {step_id}; retry was not persisted"
        ));
    }
    append_event_tx(
        &tx,
        run_id,
        "step_retry_requested",
        Some(step_id),
        None,
        &serde_json::json!({"reconcile_from":"check"}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    step_by_id(conn, run_id, step_id)?.ok_or_else(|| "reset step disappeared".into())
}

/// Persist skip/waive/stop after an operator decision. The run returns to
/// `running` even when the engine intends to stop: terminal status and its
/// report are committed later by `finalize_run` in one transaction.
pub fn settle_exception_step(
    conn: &mut Connection,
    run_id: &str,
    step_id: &str,
    next: StepStatus,
    operator_comment: Option<&str>,
    waiver: Option<&Waiver>,
    continue_run: bool,
) -> Result<StepRecord, String> {
    if !matches!(
        next,
        StepStatus::Skipped | StepStatus::Waived | StepStatus::Failed | StepStatus::Blocked
    ) {
        return Err(format!("{next} is not an exception settlement"));
    }
    if next == StepStatus::Waived {
        waiver.ok_or("waiver metadata is required")?.validate()?;
    } else if waiver.is_some() {
        return Err("waiver metadata is only valid for waived status".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let (actor, reason, waiver_at) = waiver
        .map(|value| {
            (
                Some(value.actor.as_str()),
                Some(value.reason.as_str()),
                Some(value.created_at.as_str()),
            )
        })
        .unwrap_or((None, None, None));
    let count = tx
        .execute(
            "UPDATE runbook_steps SET status=?3,operator_comment=?4,waiver_actor=?5,
                 waiver_reason=?6,waiver_at=?7,updated_at=?8 WHERE run_id=?1 AND step_id=?2
                 AND status IN ('paused','unknown','blocked','needs_action','failed')",
            params![
                run_id,
                step_id,
                next.as_str(),
                operator_comment,
                actor,
                reason,
                waiver_at,
                timestamp
            ],
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err(format!("step {step_id} is not eligible for settlement"));
    }
    let run_count = tx
        .execute(
            "UPDATE runbook_runs SET status='running',active_step_id=NULL,active_phase=NULL,
             pause_reason=NULL,updated_at=?2 WHERE id=?1 AND active_step_id=?3
             AND status IN ('paused','waiting_operator')",
            params![run_id, timestamp, step_id],
        )
        .map_err(|e| e.to_string())?;
    if run_count != 1 {
        return Err(format!(
            "run {run_id} is not paused on step {step_id}; settlement was not persisted"
        ));
    }
    append_event_tx(
        &tx,
        run_id,
        "step_exception_settled",
        Some(step_id),
        None,
        &serde_json::json!({"status":next,"continue_run":continue_run}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    step_by_id(conn, run_id, step_id)?.ok_or_else(|| "settled step disappeared".into())
}

fn step_by_id(
    conn: &Connection,
    run_id: &str,
    step_id: &str,
) -> Result<Option<StepRecord>, String> {
    Ok(list_steps(conn, run_id)?
        .into_iter()
        .find(|step| step.step_id == step_id))
}

/// Attach engine- or operator-produced detail after the outcome is fixed. This
/// never changes status, so a summarizer cannot promote a failed step or alter
/// the checklist result.
pub fn update_step_details(
    conn: &Connection,
    run_id: &str,
    step_id: &str,
    changed: bool,
    assurance: Option<VerificationAssurance>,
    summary: Option<&str>,
    operator_comment: Option<&str>,
) -> Result<StepRecord, String> {
    let timestamp = now();
    let count = conn
        .execute(
            "UPDATE runbook_steps SET changed=?3,assurance=?4,summary=?5,
                 operator_comment=?6,updated_at=?7 WHERE run_id=?1 AND step_id=?2",
            params![
                run_id,
                step_id,
                changed,
                assurance.map(|value| value.as_str()),
                summary,
                operator_comment,
                timestamp
            ],
        )
        .map_err(|e| format!("update runbook step details: {e}"))?;
    if count != 1 {
        return Err(format!("unknown step {step_id} in run {run_id}"));
    }
    step_by_id(conn, run_id, step_id)?.ok_or_else(|| "updated step disappeared".into())
}

#[derive(Debug, Clone)]
pub struct AttemptIntent {
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub executor: String,
    pub proposed_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptRecord {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub sequence: u32,
    pub executor: String,
    pub status: AttemptStatus,
    pub proposed_command: Option<String>,
    pub executed_command: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output_tail: Option<String>,
    pub output_observed_bytes: u64,
    pub output_captured_bytes: u64,
    pub output_redacted: bool,
    pub output_truncated: bool,
    pub structured_outcomes: Option<Value>,
    pub error: Option<String>,
    pub intent_at: String,
    pub started_at: Option<String>,
    pub result_at: Option<String>,
}

pub fn create_attempt_intent(
    conn: &mut Connection,
    input: &AttemptIntent,
) -> Result<AttemptRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let run_status: String = tx
        .query_row(
            "SELECT status FROM runbook_runs WHERE id=?1",
            [&input.run_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown run: {}", input.run_id))?;
    if run_status != RunStatus::Running.as_str() {
        return Err(format!("run {} is not running", input.run_id));
    }
    let attempt_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM runbook_attempts WHERE run_id=?1",
            [&input.run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("count runbook attempts: {e}"))?;
    if usize::try_from(attempt_count).unwrap_or(usize::MAX) >= MAX_REPORT_ATTEMPTS {
        return Err(format!(
            "run {} reached the {MAX_REPORT_ATTEMPTS}-attempt audit limit",
            input.run_id
        ));
    }
    let sequence: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM runbook_attempts
             WHERE run_id=?1 AND step_id=?2 AND phase=?3",
            params![input.run_id, input.step_id, input.phase.as_str()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    tx.execute(
        "INSERT INTO runbook_attempts
           (id, run_id, step_id, phase, sequence, executor, status, proposed_command, intent_at)
         VALUES (?1,?2,?3,?4,?5,?6,'intent',?7,?8)",
        params![
            id,
            input.run_id,
            input.step_id,
            input.phase.as_str(),
            sequence,
            input.executor,
            input.proposed_command,
            timestamp
        ],
    )
    .map_err(|e| format!("record runbook intent: {e}"))?;
    append_event_tx(
        &tx,
        &input.run_id,
        "attempt_intent",
        Some(&input.step_id),
        Some(&id),
        &serde_json::json!({"phase":input.phase,"executor":input.executor}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_attempt(conn, &id)?.ok_or_else(|| "attempt disappeared".into())
}

pub fn start_attempt(
    conn: &mut Connection,
    attempt_id: &str,
    executed_command: Option<&str>,
) -> Result<AttemptRecord, String> {
    update_attempt_status(
        conn,
        attempt_id,
        &[AttemptStatus::Intent, AttemptStatus::WaitingApproval],
        AttemptStatus::Running,
        executed_command,
        None,
    )
}

#[derive(Debug)]
pub struct AttemptResult<'a> {
    pub status: AttemptStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output: Option<&'a str>,
    /// Total UTF-8 bytes observed at the execution boundary before any
    /// transport cap. Non-PTY executors use the raw output length.
    pub output_observed_bytes: u64,
    /// UTF-8 bytes delivered in `output` before persistence sanitization.
    pub output_captured_bytes: u64,
    /// The visible-terminal bridge may have already tail-capped its capture.
    pub source_truncated: bool,
    pub structured_outcomes: Option<Value>,
    pub error: Option<&'a str>,
}

pub fn finish_attempt(
    conn: &mut Connection,
    attempt_id: &str,
    result: AttemptResult<'_>,
) -> Result<AttemptRecord, String> {
    if !result.status.is_terminal() {
        return Err(format!(
            "{} is not a terminal attempt result",
            result.status
        ));
    }
    let actual_captured = result.output.map_or(0, |output| output.len() as u64);
    if result.output_captured_bytes != actual_captured {
        return Err(format!(
            "attempt capture byte count does not match its UTF-8 output (reported {}, received {actual_captured})",
            result.output_captured_bytes
        ));
    }
    if result.output_observed_bytes < result.output_captured_bytes {
        return Err("attempt observed byte count is smaller than its captured output".into());
    }
    if !result.source_truncated && result.output_observed_bytes != result.output_captured_bytes {
        return Err(
            "attempt has uncaptured output without marking the source capture truncated".into(),
        );
    }
    let observed_bytes = i64::try_from(result.output_observed_bytes)
        .map_err(|_| "attempt observed byte count is too large")?;
    let captured_bytes = i64::try_from(result.output_captured_bytes)
        .map_err(|_| "attempt captured byte count is too large")?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (run_id, step_id, current, evidence_mode): (String, String, String, String) = tx
        .query_row(
            "SELECT a.run_id,a.step_id,a.status,r.evidence_mode
             FROM runbook_attempts a JOIN runbook_runs r ON r.id=a.run_id
             WHERE a.id=?1",
            [attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown attempt: {attempt_id}"))?;
    let current: AttemptStatus = parse_enum(&current)?;
    let evidence_mode: EvidenceCaptureMode = parse_enum(&evidence_mode)?;
    if !current.is_in_flight() {
        return Err(format!("attempt {attempt_id} is already {current}"));
    }
    let sanitized = if evidence_mode == EvidenceCaptureMode::None {
        None
    } else {
        result.output.map(sanitize_output_tail)
    };
    let structured_outcomes = if let Some(value) = result.structured_outcomes {
        Some(
            serde_json::to_string(&value)
                .map_err(|error| format!("attempt structured_outcomes: {error}"))?,
        )
    } else {
        None
    };
    // The database is the final persistence boundary. Callers sanitize for
    // their own in-memory/UI state, but a missed or future caller must not be
    // able to store an unbounded terminal error or credential material.
    let sanitized_error = result.error.map(|error| sanitize_output_tail(error).text);
    let current_output_bytes: i64 = tx
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(output_tail AS BLOB))),0)
             FROM runbook_attempts WHERE run_id=?1",
            [&run_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("measure persisted runbook output: {e}"))?;
    let current_output_bytes = u64::try_from(current_output_bytes)
        .map_err(|_| "persisted runbook output byte count is invalid")?;
    let additional_output_bytes = sanitized
        .as_ref()
        .map_or(0, |value| value.text.len() as u64);
    if current_output_bytes
        .checked_add(additional_output_bytes)
        .is_none_or(|total| total > MAX_REPORT_PERSISTED_OUTPUT_BYTES)
    {
        return Err(format!(
            "runbook output exceeds the {MAX_REPORT_PERSISTED_OUTPUT_BYTES}-byte aggregate audit limit"
        ));
    }
    let timestamp = now();
    tx.execute(
        "UPDATE runbook_attempts SET status=?2, exit_code=?3, duration_ms=?4, output_tail=?5,
             output_observed_bytes=?6, output_captured_bytes=?7, output_redacted=?8,
             output_truncated=?9, structured_outcomes=?10, error=?11, result_at=?12
             WHERE id=?1",
        params![
            attempt_id,
            result.status.as_str(),
            result.exit_code,
            result.duration_ms.map(|v| v as i64),
            sanitized.as_ref().map(|v| v.text.as_str()),
            observed_bytes,
            captured_bytes,
            sanitized.as_ref().is_some_and(|v| v.redacted),
            result.source_truncated || sanitized.as_ref().is_some_and(|v| v.truncated),
            structured_outcomes.as_deref(),
            sanitized_error.as_deref(),
            timestamp,
        ],
    )
    .map_err(|e| format!("finish runbook attempt: {e}"))?;
    append_event_tx(
        &tx,
        &run_id,
        "attempt_result",
        Some(&step_id),
        Some(attempt_id),
        &serde_json::json!({
            "status":result.status,
            "exit_code":result.exit_code,
            "output_observed_bytes":result.output_observed_bytes,
            "output_captured_bytes":result.output_captured_bytes,
        }),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_attempt(conn, attempt_id)?.ok_or_else(|| "finished attempt disappeared".into())
}

fn update_attempt_status(
    conn: &mut Connection,
    attempt_id: &str,
    expected: &[AttemptStatus],
    next: AttemptStatus,
    executed_command: Option<&str>,
    error: Option<&str>,
) -> Result<AttemptRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (run_id, step_id, phase, executor, current): (String, String, String, String, String) = tx
        .query_row(
            "SELECT run_id, step_id, phase, executor, status FROM runbook_attempts WHERE id=?1",
            [attempt_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown attempt: {attempt_id}"))?;
    if !expected.iter().any(|value| value.as_str() == current) {
        return Err(format!(
            "attempt {attempt_id} is {current}, not an expected state"
        ));
    }
    let timestamp = now();
    tx.execute(
        "UPDATE runbook_attempts SET status=?2, executed_command=COALESCE(?3,executed_command),
             error=?4, started_at=CASE WHEN ?2='running' THEN COALESCE(started_at,?5)
                                   ELSE started_at END WHERE id=?1",
        params![
            attempt_id,
            next.as_str(),
            executed_command,
            error,
            timestamp
        ],
    )
    .map_err(|e| e.to_string())?;
    // Crossing the mutation boundary means dispatching concrete executable
    // bytes, or handing an apply action to a human. An agent parent attempt is
    // only a model/orchestration envelope; its nested shell attempts carry the
    // actual commands and must be the records that flip this monotonic bit.
    if next == AttemptStatus::Running
        && phase == RunbookPhase::Apply.as_str()
        && (executed_command.is_some() || executor == "manual")
    {
        let changed = tx
            .execute(
                "UPDATE runbook_steps SET changed=1,updated_at=?3
                 WHERE run_id=?1 AND step_id=?2",
                params![run_id, step_id, timestamp],
            )
            .map_err(|e| format!("mark dispatched apply as changed: {e}"))?;
        if changed != 1 {
            return Err(format!(
                "attempt {attempt_id} has no owning step at apply dispatch"
            ));
        }
    }
    append_event_tx(
        &tx,
        &run_id,
        "attempt_status_changed",
        Some(&step_id),
        Some(attempt_id),
        &serde_json::json!({"from":current,"to":next}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_attempt(conn, attempt_id)?.ok_or_else(|| "updated attempt disappeared".into())
}

pub fn get_attempt(conn: &Connection, id: &str) -> Result<Option<AttemptRecord>, String> {
    conn.query_row(
        "SELECT id, run_id, step_id, phase, sequence, executor, status, proposed_command,
                executed_command, exit_code, duration_ms, output_tail, output_observed_bytes,
                output_captured_bytes, output_redacted, output_truncated, structured_outcomes,
                error, intent_at, started_at, result_at
         FROM runbook_attempts WHERE id=?1",
        [id],
        attempt_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_attempts(conn: &Connection, run_id: &str) -> Result<Vec<AttemptRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, run_id, step_id, phase, sequence, executor, status, proposed_command,
                executed_command, exit_code, duration_ms, output_tail, output_observed_bytes,
                output_captured_bytes, output_redacted, output_truncated, structured_outcomes,
                error, intent_at, started_at, result_at
         FROM runbook_attempts WHERE run_id=?1 ORDER BY intent_at, sequence",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], attempt_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn attempt_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttemptRecord> {
    let phase: String = row.get(3)?;
    let status: String = row.get(6)?;
    let duration: Option<i64> = row.get(10)?;
    let observed_bytes: Option<i64> = row.get(12)?;
    let captured_bytes: Option<i64> = row.get(13)?;
    let structured_outcomes: Option<String> = row.get(16)?;
    let structured_outcomes = structured_outcomes
        .map(|value| serde_json::from_str(&value).map_err(json_sql_error))
        .transpose()?;
    Ok(AttemptRecord {
        id: row.get(0)?,
        run_id: row.get(1)?,
        step_id: row.get(2)?,
        phase: parse_enum(&phase).map_err(text_sql_error)?,
        sequence: row.get::<_, i64>(4)? as u32,
        executor: row.get(5)?,
        status: parse_enum(&status).map_err(text_sql_error)?,
        proposed_command: row.get(7)?,
        executed_command: row.get(8)?,
        exit_code: row.get(9)?,
        duration_ms: duration.map(|v| v as u64),
        output_tail: row.get(11)?,
        output_observed_bytes: observed_bytes.unwrap_or(0).try_into().map_err(|_| {
            rusqlite::Error::IntegralValueOutOfRange(12, observed_bytes.unwrap_or_default())
        })?,
        output_captured_bytes: captured_bytes.unwrap_or(0).try_into().map_err(|_| {
            rusqlite::Error::IntegralValueOutOfRange(13, captured_bytes.unwrap_or_default())
        })?,
        output_redacted: row.get(14)?,
        output_truncated: row.get(15)?,
        structured_outcomes,
        error: row.get(17)?,
        intent_at: row.get(18)?,
        started_at: row.get(19)?,
        result_at: row.get(20)?,
    })
}

#[derive(Debug, Clone)]
pub struct ApprovalIntent {
    pub id: String,
    pub attempt_id: String,
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub proposed_command: Option<String>,
    pub read_only: bool,
    pub network: bool,
    pub privileged: bool,
    pub opaque: bool,
    pub project_digest: Option<String>,
    pub inventory_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRecord {
    pub id: String,
    pub attempt_id: String,
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub status: ApprovalStatus,
    pub proposed_command: Option<String>,
    pub executed_command: Option<String>,
    pub read_only: bool,
    pub network: bool,
    pub privileged: bool,
    pub opaque: bool,
    pub actor: Option<String>,
    pub reason: Option<String>,
    pub requested_at: String,
    pub decided_at: Option<String>,
    pub project_digest: Option<String>,
    pub inventory_digest: Option<String>,
    pub edited: bool,
}

pub fn request_approval(
    conn: &mut Connection,
    input: &ApprovalIntent,
) -> Result<ApprovalRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    request_approval_tx(&tx, input)?;
    tx.commit().map_err(|e| e.to_string())?;
    get_approval(conn, &input.id)?.ok_or_else(|| "approval disappeared".into())
}

/// Record a pending approval and move the run to `waiting_approval` in ONE
/// transaction.
///
/// Two commits let a reader on the command-side connection observe the run as
/// `running` while a pending approval already exists — the runbook panel reads
/// that pair as "no approval to show" and sits on a spinner while the engine
/// waits for a click that has nowhere to be made.
pub fn request_approval_awaiting(
    conn: &mut Connection,
    input: &ApprovalIntent,
) -> Result<ApprovalRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    request_approval_tx(&tx, input)?;
    transition_run_tx(
        &tx,
        &input.run_id,
        RunStatus::Running,
        RunStatus::WaitingApproval,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_approval(conn, &input.id)?.ok_or_else(|| "approval disappeared".into())
}

fn request_approval_tx(tx: &Transaction<'_>, input: &ApprovalIntent) -> Result<(), String> {
    // Native v1 never auto-dispatches into an existing interactive shell. Even
    // a textually read-only check needs the operator's prompt/session trust
    // attestation, so every phase legitimately reaches this durable gate.
    let timestamp = now();
    let count = tx
        .execute(
            "UPDATE runbook_attempts SET status='waiting_approval' WHERE id=?1 AND run_id=?2
         AND step_id=?3 AND phase=?4 AND status='intent'",
            params![
                input.attempt_id,
                input.run_id,
                input.step_id,
                input.phase.as_str()
            ],
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err("approval does not match an intent attempt".into());
    }
    tx.execute(
        "INSERT INTO runbook_approvals
           (id,attempt_id,run_id,step_id,phase,status,proposed_command,read_only,network,
            privileged,opaque,project_digest,inventory_digest,requested_at)
         VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            input.id,
            input.attempt_id,
            input.run_id,
            input.step_id,
            input.phase.as_str(),
            input.proposed_command,
            input.read_only,
            input.network,
            input.privileged,
            input.opaque,
            input.project_digest,
            input.inventory_digest,
            timestamp
        ],
    )
    .map_err(|e| format!("record runbook approval: {e}"))?;
    append_event_tx(
        tx,
        &input.run_id,
        "approval_requested",
        Some(&input.step_id),
        Some(&input.attempt_id),
        &serde_json::json!({"approval_id":input.id,"phase":input.phase}),
        &timestamp,
    )?;
    Ok(())
}

pub fn decide_approval(
    conn: &mut Connection,
    approval_id: &str,
    decision: ApprovalDecision,
    actor: &str,
    reason: Option<&str>,
    executed_command: Option<&str>,
) -> Result<ApprovalRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    decide_approval_tx(&tx, approval_id, decision, actor, reason, executed_command)?;
    tx.commit().map_err(|e| e.to_string())?;
    get_approval(conn, approval_id)?.ok_or_else(|| "approval disappeared".into())
}

/// Approve an approval and resume the run in ONE transaction.
///
/// The mirror of `request_approval_awaiting`. Two commits let a reader see the
/// run still `waiting_approval` with the approval already decided, i.e. a state
/// that says "waiting for a click" with nothing to click — which is what the
/// panel used to report as "Runbook approval state is missing."
pub fn approve_and_resume(
    conn: &mut Connection,
    run_id: &str,
    approval_id: &str,
    actor: &str,
    reason: Option<&str>,
    executed_command: Option<&str>,
) -> Result<ApprovalRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    decide_approval_tx(
        &tx,
        approval_id,
        ApprovalDecision::Approve,
        actor,
        reason,
        executed_command,
    )?;
    transition_run_tx(
        &tx,
        run_id,
        RunStatus::WaitingApproval,
        RunStatus::Running,
        None,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_approval(conn, approval_id)?.ok_or_else(|| "approval disappeared".into())
}

fn decide_approval_tx(
    tx: &Transaction<'_>,
    approval_id: &str,
    decision: ApprovalDecision,
    actor: &str,
    reason: Option<&str>,
    executed_command: Option<&str>,
) -> Result<(), String> {
    if actor.trim().is_empty() {
        return Err("approval actor is required".into());
    }
    let (attempt_id, run_id, step_id, proposed): (String, String, String, Option<String>) = tx
        .query_row(
            "SELECT attempt_id,run_id,step_id,proposed_command FROM runbook_approvals
         WHERE id=?1 AND status='pending'",
            [approval_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no pending approval: {approval_id}"))?;
    let status = match decision {
        ApprovalDecision::Approve => ApprovalStatus::Approved,
        ApprovalDecision::Decline => ApprovalStatus::Declined,
    };
    let executed = if decision == ApprovalDecision::Approve {
        executed_command
            .map(str::to_string)
            .or_else(|| proposed.clone())
    } else {
        None
    };
    let edited = executed
        .as_deref()
        .zip(proposed.as_deref())
        .is_some_and(|(a, b)| a != b);
    let timestamp = now();
    tx.execute(
        "UPDATE runbook_approvals SET status=?2,executed_command=?3,actor=?4,reason=?5,
         decided_at=?6,edited=?7 WHERE id=?1 AND status='pending'",
        params![
            approval_id,
            status.as_str(),
            executed,
            actor,
            reason,
            timestamp,
            edited
        ],
    )
    .map_err(|e| e.to_string())?;
    let attempt_status = if decision == ApprovalDecision::Approve {
        AttemptStatus::Intent
    } else {
        AttemptStatus::Declined
    };
    tx.execute(
        "UPDATE runbook_attempts SET status=?2,executed_command=?3,result_at=?4
         WHERE id=?1 AND status='waiting_approval'",
        params![
            attempt_id,
            attempt_status.as_str(),
            executed,
            (decision == ApprovalDecision::Decline).then_some(timestamp.as_str())
        ],
    )
    .map_err(|e| e.to_string())?;
    append_event_tx(
        tx,
        &run_id,
        "approval_decided",
        Some(&step_id),
        Some(&attempt_id),
        &serde_json::json!({"approval_id":approval_id,"decision":decision,"edited":edited}),
        &timestamp,
    )?;
    Ok(())
}

/// Settle every pending gate before a run is cancelled. In-flight commands are
/// marked unknown rather than cancelled: visible-terminal cancellation cannot
/// prove that a command stopped, so only a not-yet-dispatched intent is safely
/// `cancelled`.
pub fn cancel_pending_approvals_for_run(
    conn: &mut Connection,
    run_id: &str,
) -> Result<u32, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let approval_count = tx
        .execute(
            "UPDATE runbook_approvals SET status='cancelled',reason='run cancelled',decided_at=?2
             WHERE run_id=?1 AND status='pending'",
            params![run_id, timestamp],
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE runbook_attempts SET status='cancelled',error='cancelled before dispatch',result_at=?2
         WHERE run_id=?1 AND status IN ('intent','waiting_approval')",
        params![run_id, timestamp],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE runbook_steps SET changed=1,updated_at=?2
         WHERE run_id=?1 AND EXISTS (
           SELECT 1 FROM runbook_attempts
           WHERE runbook_attempts.run_id=runbook_steps.run_id
             AND runbook_attempts.step_id=runbook_steps.step_id
             AND runbook_attempts.phase='apply'
             AND runbook_attempts.started_at IS NOT NULL
         )",
        params![run_id, timestamp],
    )
    .map_err(|e| format!("preserve cancelled apply state: {e}"))?;
    tx.execute(
        "UPDATE runbook_attempts SET status='unknown',error='cancellation requested while command may still be running',result_at=?2
         WHERE run_id=?1 AND status='running'",
        params![run_id, timestamp],
    )
    .map_err(|e| e.to_string())?;
    if approval_count > 0 {
        append_event_tx(
            &tx,
            run_id,
            "approvals_cancelled",
            None,
            None,
            &serde_json::json!({"count":approval_count}),
            &timestamp,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(approval_count as u32)
}

pub fn get_approval(conn: &Connection, id: &str) -> Result<Option<ApprovalRecord>, String> {
    conn.query_row(
        "SELECT id,attempt_id,run_id,step_id,phase,status,proposed_command,executed_command,
                read_only,network,privileged,opaque,actor,reason,requested_at,decided_at,
                project_digest,inventory_digest,edited
         FROM runbook_approvals WHERE id=?1",
        [id],
        approval_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn list_approvals(conn: &Connection, run_id: &str) -> Result<Vec<ApprovalRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,attempt_id,run_id,step_id,phase,status,proposed_command,executed_command,
                read_only,network,privileged,opaque,actor,reason,requested_at,decided_at,
                project_digest,inventory_digest,edited
         FROM runbook_approvals WHERE run_id=?1 ORDER BY requested_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], approval_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn approval_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalRecord> {
    let phase: String = row.get(4)?;
    let status: String = row.get(5)?;
    Ok(ApprovalRecord {
        id: row.get(0)?,
        attempt_id: row.get(1)?,
        run_id: row.get(2)?,
        step_id: row.get(3)?,
        phase: parse_enum(&phase).map_err(text_sql_error)?,
        status: parse_enum(&status).map_err(text_sql_error)?,
        proposed_command: row.get(6)?,
        executed_command: row.get(7)?,
        read_only: row.get(8)?,
        network: row.get(9)?,
        privileged: row.get(10)?,
        opaque: row.get(11)?,
        actor: row.get(12)?,
        reason: row.get(13)?,
        requested_at: row.get(14)?,
        decided_at: row.get(15)?,
        project_digest: row.get(16)?,
        inventory_digest: row.get(17)?,
        edited: row.get(18)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRecord {
    pub id: String,
    pub attempt_id: String,
    pub run_id: String,
    pub mode: EvidenceCaptureMode,
    pub availability: EvidenceAvailability,
    pub relative_path: Option<String>,
    pub bytes: u64,
    pub sha256: String,
    pub redacted: bool,
    pub truncated: bool,
    pub created_at: String,
}

/// Preflight an evidence artifact before it is written. `add_evidence` repeats
/// the check transactionally, so this helper is an allocation/write guard and
/// not the sole enforcement boundary.
pub fn ensure_evidence_budget(
    conn: &Connection,
    run_id: &str,
    additional_bytes: u64,
) -> Result<(), String> {
    match evidence_budget_headroom(conn, run_id, additional_bytes)? {
        EvidenceBudget::Available => Ok(()),
        EvidenceBudget::ItemsExhausted => Err(format!(
            "run reached the {MAX_REPORT_EVIDENCE_ITEMS}-item evidence audit limit"
        )),
        EvidenceBudget::BytesExhausted => Err(format!(
            "runbook evidence exceeds the {MAX_REPORT_EVIDENCE_BYTES}-byte aggregate audit limit"
        )),
    }
}

/// Why a run can no longer keep full artifacts, or that it still can.
///
/// Separate from `ensure_evidence_budget` because the two callers want opposite
/// things from the same measurement. A reservation must fail closed — writing
/// past the cap is not an option. But an ATTEMPT that merely wanted a full
/// artifact should not die because the run is out of budget: the command
/// already ran in the operator's terminal, and turning "we kept less evidence
/// than you asked for" into a failed step loses the step's result as well as
/// its output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceBudget {
    Available,
    ItemsExhausted,
    BytesExhausted,
}

pub fn evidence_budget_headroom(
    conn: &Connection,
    run_id: &str,
    additional_bytes: u64,
) -> Result<EvidenceBudget, String> {
    let (count, bytes): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM runbook_evidence WHERE run_id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("measure runbook evidence budget: {e}"))?;
    let count = usize::try_from(count).map_err(|_| "runbook evidence count is invalid")?;
    let bytes = u64::try_from(bytes).map_err(|_| "runbook evidence byte count is invalid")?;
    if count >= MAX_REPORT_EVIDENCE_ITEMS {
        return Ok(EvidenceBudget::ItemsExhausted);
    }
    if bytes
        .checked_add(additional_bytes)
        .is_none_or(|total| total > MAX_REPORT_EVIDENCE_BYTES)
    {
        return Ok(EvidenceBudget::BytesExhausted);
    }
    Ok(EvidenceBudget::Available)
}

/// Reserve the final evidence identity, size, digest and confined path before
/// any artifact bytes are written. A process loss can therefore leave only a
/// tracked missing/partial artifact: export fails its size/hash check, while
/// history deletion can still enumerate the reserved path.
pub fn reserve_evidence(conn: &Connection, evidence: &EvidenceRecord) -> Result<(), String> {
    for (label, value) in [
        ("evidence id", evidence.id.as_str()),
        ("evidence attempt id", evidence.attempt_id.as_str()),
        ("evidence run id", evidence.run_id.as_str()),
    ] {
        if !safe_evidence_component(value) {
            return Err(format!("{label} is not a safe path component"));
        }
    }
    if evidence.sha256.len() != 64
        || !evidence
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("evidence SHA-256 must be 64 lowercase hexadecimal characters".into());
    }
    let attempt_owner: Option<String> = conn
        .query_row(
            "SELECT run_id FROM runbook_attempts WHERE id=?1",
            [&evidence.attempt_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("load evidence attempt owner: {e}"))?;
    match attempt_owner {
        Some(owner) if owner == evidence.run_id => {}
        Some(_) => return Err("evidence attempt does not belong to its run".into()),
        None => return Err(format!("unknown evidence attempt: {}", evidence.attempt_id)),
    }
    match evidence.mode {
        EvidenceCaptureMode::None if evidence.bytes != 0 || evidence.relative_path.is_some() => {
            return Err("none evidence cannot contain bytes or an artifact path".into());
        }
        EvidenceCaptureMode::Tail if evidence.bytes > OUTPUT_TAIL_BYTES as u64 => {
            return Err(format!(
                "tail evidence exceeds the {} byte limit",
                OUTPUT_TAIL_BYTES
            ));
        }
        EvidenceCaptureMode::Full if evidence.bytes > FULL_EVIDENCE_BYTES as u64 => {
            return Err(format!(
                "full evidence exceeds the {} byte limit",
                FULL_EVIDENCE_BYTES
            ));
        }
        _ => {}
    }
    match (evidence.mode, evidence.availability) {
        (EvidenceCaptureMode::Full, EvidenceAvailability::Pending)
        | (EvidenceCaptureMode::None | EvidenceCaptureMode::Tail, EvidenceAvailability::Complete) =>
            {}
        (EvidenceCaptureMode::Full, _) => {
            return Err("full evidence must be reserved with pending availability".into());
        }
        _ => return Err("inline evidence must be recorded as complete".into()),
    }
    match (evidence.mode, evidence.relative_path.as_deref()) {
        (EvidenceCaptureMode::None | EvidenceCaptureMode::Tail, None) => {}
        (EvidenceCaptureMode::Full, Some(relative))
            if relative == format!("runbooks/{}/{}.log", evidence.run_id, evidence.attempt_id) => {}
        _ => {
            return Err(
                "evidence path must exactly match its capture mode, run, and attempt".into(),
            );
        }
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin runbook evidence transaction: {e}"))?;
    ensure_evidence_budget(&tx, &evidence.run_id, evidence.bytes)?;
    tx.execute(
        "INSERT INTO runbook_evidence
         (id,attempt_id,run_id,mode,availability,relative_path,bytes,sha256,redacted,truncated,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            evidence.id,
            evidence.attempt_id,
            evidence.run_id,
            evidence.mode.as_str(),
            evidence.availability.as_str(),
            evidence.relative_path,
            evidence.bytes as i64,
            evidence.sha256,
            evidence.redacted,
            evidence.truncated,
            evidence.created_at
        ],
    )
    .map_err(|e| format!("record runbook evidence: {e}"))?;
    tx.commit()
        .map_err(|e| format!("commit runbook evidence: {e}"))?;
    Ok(())
}

/// Remove only an exact live reservation when artifact creation failed in the
/// same process. Ownership is part of the predicate so callers cannot use an
/// evidence ID to delete metadata belonging to another run/attempt.
pub fn remove_evidence_reservation(
    conn: &Connection,
    evidence_id: &str,
    run_id: &str,
    attempt_id: &str,
) -> Result<(), String> {
    for (label, value) in [
        ("evidence id", evidence_id),
        ("evidence run id", run_id),
        ("evidence attempt id", attempt_id),
    ] {
        if !safe_evidence_component(value) {
            return Err(format!("{label} is not a safe path component"));
        }
    }
    let deleted = conn
        .execute(
            "DELETE FROM runbook_evidence
             WHERE id=?1 AND run_id=?2 AND attempt_id=?3 AND availability='pending'",
            params![evidence_id, run_id, attempt_id],
        )
        .map_err(|e| format!("remove failed evidence reservation: {e}"))?;
    if deleted != 1 {
        return Err("evidence reservation does not match its run and attempt".into());
    }
    Ok(())
}

/// Compatibility name for non-artifact evidence capture. Full artifacts should
/// call `reserve_evidence` explicitly before writing their file.
pub fn add_evidence(conn: &Connection, evidence: &EvidenceRecord) -> Result<(), String> {
    reserve_evidence(conn, evidence)
}

pub fn mark_evidence_complete(
    conn: &Connection,
    evidence_id: &str,
    run_id: &str,
    attempt_id: &str,
) -> Result<(), String> {
    transition_evidence_availability(
        conn,
        evidence_id,
        run_id,
        attempt_id,
        EvidenceAvailability::Complete,
    )
}

pub fn mark_evidence_missing(
    conn: &Connection,
    evidence_id: &str,
    run_id: &str,
    attempt_id: &str,
) -> Result<(), String> {
    transition_evidence_availability(
        conn,
        evidence_id,
        run_id,
        attempt_id,
        EvidenceAvailability::Missing,
    )
}

fn transition_evidence_availability(
    conn: &Connection,
    evidence_id: &str,
    run_id: &str,
    attempt_id: &str,
    next: EvidenceAvailability,
) -> Result<(), String> {
    if !matches!(
        next,
        EvidenceAvailability::Complete | EvidenceAvailability::Missing
    ) {
        return Err("pending is only valid at evidence reservation".into());
    }
    for (label, value) in [
        ("evidence id", evidence_id),
        ("evidence run id", run_id),
        ("evidence attempt id", attempt_id),
    ] {
        if !safe_evidence_component(value) {
            return Err(format!("{label} is not a safe path component"));
        }
    }
    let updated = conn
        .execute(
            "UPDATE runbook_evidence SET availability=?1
             WHERE id=?2 AND run_id=?3 AND attempt_id=?4
               AND mode='full' AND availability='pending'",
            params![next.as_str(), evidence_id, run_id, attempt_id],
        )
        .map_err(|error| format!("update evidence availability: {error}"))?;
    if updated != 1 {
        return Err("pending evidence does not match its run and attempt".into());
    }
    Ok(())
}

/// The staging file is deterministic so a reservation also identifies every
/// possible artifact left by a crash. It is never exported as captured data.
pub fn evidence_staging_relative_path(evidence: &EvidenceRecord) -> Result<String, String> {
    if evidence.mode != EvidenceCaptureMode::Full
        || !safe_evidence_component(&evidence.run_id)
        || !safe_evidence_component(&evidence.attempt_id)
    {
        return Err("only confined full evidence has a staging path".into());
    }
    let expected = format!("runbooks/{}/{}.log", evidence.run_id, evidence.attempt_id);
    if evidence.relative_path.as_deref() != Some(expected.as_str()) {
        return Err("full evidence path does not match its run and attempt".into());
    }
    Ok(format!("{expected}.pending"))
}

/// Verify the reserved final artifact through the same confinement, size and
/// digest checks used by startup recovery. The engine calls this after its
/// synced rename and before committing `complete`.
pub fn verify_complete_evidence_artifact(
    evidence_root: &Path,
    evidence: &EvidenceRecord,
) -> Result<bool, String> {
    let Some((_parent, final_path, _staging_path)) =
        confined_pending_evidence_paths(evidence_root, evidence)?
    else {
        return Ok(false);
    };
    evidence_artifact_matches(&final_path, evidence)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvidenceReconcileOutcome {
    pub completed: usize,
    pub missing: usize,
}

/// Reconcile reservations before interrupted-run/report recovery. A pending
/// row becomes complete only after a confined regular file matches both the
/// reserved size and SHA-256. A fully synced staging file can be promoted by
/// atomic rename; partial, absent, symlinked, or mismatched artifacts become
/// explicitly missing and are never described as captured by a report.
pub fn reconcile_pending_evidence(
    conn: &mut Connection,
    evidence_root: &Path,
) -> Result<EvidenceReconcileOutcome, String> {
    let pending = list_pending_evidence(conn)?;
    let mut outcome = EvidenceReconcileOutcome::default();
    for evidence in pending {
        let paths = confined_pending_evidence_paths(evidence_root, &evidence)?;
        let complete = match paths {
            Some((parent, final_path, staging_path)) => {
                if evidence_artifact_matches(&final_path, &evidence)? {
                    true
                } else if !path_exists_without_following(&final_path)?
                    && evidence_artifact_matches(&staging_path, &evidence)?
                {
                    promote_pending_evidence(&staging_path, &final_path)?;
                    sync_directory(&parent)?;
                    evidence_artifact_matches(&final_path, &evidence)?
                } else {
                    false
                }
            }
            None => false,
        };
        if complete {
            mark_evidence_complete(conn, &evidence.id, &evidence.run_id, &evidence.attempt_id)?;
            outcome.completed += 1;
        } else {
            mark_evidence_missing(conn, &evidence.id, &evidence.run_id, &evidence.attempt_id)?;
            outcome.missing += 1;
        }
    }
    Ok(outcome)
}

/// Repair only reports whose evidence availability is absent (an earlier
/// experimental v6 shape) or differs from the now-reconciled durable rows.
/// Other canonical reports remain byte-identical. This runs before history is
/// served, so an upgraded developer database cannot expose a stale capture
/// claim between schema repair and report loading.
pub fn reconcile_report_evidence_availability(conn: &mut Connection) -> Result<usize, String> {
    let candidates: Vec<(String, String, String)> = {
        let mut statement = conn
            .prepare(
                "SELECT id,report_json,report_sha256 FROM runbook_runs
                 WHERE report_json IS NOT NULL AND report_sha256 IS NOT NULL
                 ORDER BY created_at,id",
            )
            .map_err(|error| format!("prepare evidence report reconciliation: {error}"))?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|error| format!("query evidence report reconciliation: {error}"))?
            .collect::<Result<_, _>>()
            .map_err(|error| format!("load evidence report reconciliation: {error}"))?;
        rows
    };
    let mut repaired = 0usize;
    for (run_id, raw, stored_hash) in candidates {
        if sha256_hex(raw.as_bytes()) != stored_hash {
            return Err(format!(
                "stored report for run {run_id} failed its SHA-256 check during evidence reconciliation"
            ));
        }
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("parse report for evidence reconciliation: {error}"))?;
        let evidence = list_evidence(conn, &run_id)?;
        let mut reported = std::collections::HashMap::<String, Option<String>>::new();
        if let Some(checklist) = value.get("checklist").and_then(Value::as_array) {
            for step in checklist {
                if let Some(items) = step.get("evidence").and_then(Value::as_array) {
                    for item in items {
                        let Some(id) = item.get("id").and_then(Value::as_str) else {
                            return Err(format!(
                                "stored report for run {run_id} has evidence without an ID"
                            ));
                        };
                        reported.insert(
                            id.to_string(),
                            item.get("availability")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                        );
                    }
                }
            }
        }
        let needs_repair = reported.len() != evidence.len()
            || evidence.iter().any(|item| {
                reported.get(&item.id).and_then(|value| value.as_deref())
                    != Some(item.availability.as_str())
            });
        if !needs_repair {
            continue;
        }
        let summary = value
            .get("executive_summary")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let tx = conn
            .transaction()
            .map_err(|error| format!("begin evidence report reconciliation: {error}"))?;
        let status: String = tx
            .query_row(
                "SELECT status FROM runbook_runs WHERE id=?1",
                [&run_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("load run status for evidence reconciliation: {error}"))?;
        let unavailable = evidence
            .iter()
            .any(|item| item.availability != EvidenceAvailability::Complete);
        if unavailable && status == RunStatus::Succeeded.as_str() {
            tx.execute(
                "UPDATE runbook_runs SET status='completed_with_exceptions' WHERE id=?1",
                [&run_id],
            )
            .map_err(|error| format!("downgrade run with unavailable evidence: {error}"))?;
        }
        let report = assemble_report(&tx, &run_id, summary)?;
        let canonical = report.canonical_json()?;
        let hash = sha256_hex(canonical.as_bytes());
        let timestamp = now();
        tx.execute(
            "UPDATE runbook_runs
             SET report_json=?2,report_sha256=?3,report_generated_at=?4,updated_at=?4
             WHERE id=?1 AND report_json=?5 AND report_sha256=?6",
            params![run_id, canonical, hash, timestamp, raw, stored_hash],
        )
        .map_err(|error| format!("store reconciled evidence report: {error}"))?;
        append_event_tx(
            &tx,
            &run_id,
            "report_evidence_reconciled",
            None,
            None,
            &serde_json::json!({"sha256": hash}),
            &timestamp,
        )?;
        tx.commit()
            .map_err(|error| format!("commit evidence report reconciliation: {error}"))?;
        repaired += 1;
    }
    Ok(repaired)
}

fn list_pending_evidence(conn: &Connection) -> Result<Vec<EvidenceRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id,attempt_id,run_id,mode,availability,relative_path,bytes,sha256,
                    redacted,truncated,created_at
             FROM runbook_evidence
             WHERE mode='full' AND availability='pending'
             ORDER BY created_at,id",
        )
        .map_err(|error| format!("prepare pending evidence recovery: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, bool>(9)?,
                row.get::<_, String>(10)?,
            ))
        })
        .map_err(|error| format!("query pending evidence recovery: {error}"))?;
    rows.map(|row| {
        let (
            id,
            attempt_id,
            run_id,
            mode,
            availability,
            relative_path,
            bytes,
            sha256,
            redacted,
            truncated,
            created_at,
        ) = row.map_err(|error| format!("load pending evidence recovery: {error}"))?;
        Ok(EvidenceRecord {
            id,
            attempt_id,
            run_id,
            mode: parse_enum(&mode)?,
            availability: parse_enum(&availability)?,
            relative_path,
            bytes: u64::try_from(bytes).map_err(|_| "evidence byte count is invalid")?,
            sha256,
            redacted,
            truncated,
            created_at,
        })
    })
    .collect()
}

fn confined_pending_evidence_paths(
    root: &Path,
    evidence: &EvidenceRecord,
) -> Result<Option<(PathBuf, PathBuf, PathBuf)>, String> {
    let staging_relative = evidence_staging_relative_path(evidence)?;
    #[cfg(target_os = "windows")]
    let canonical_root = crate::windows_fs::validate_local_ntfs_path(root)?;
    #[cfg(not(target_os = "windows"))]
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("resolve evidence recovery root: {error}"))?;
    let root_metadata = fs::symlink_metadata(&canonical_root)
        .map_err(|error| format!("inspect evidence recovery root: {error}"))?;
    if !root_metadata.is_dir() {
        return Err("evidence recovery root is not a directory".into());
    }
    let parent = canonical_root.join("runbooks").join(&evidence.run_id);
    let parent_metadata = match fs::symlink_metadata(&parent) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect evidence recovery directory: {error}")),
    };
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("evidence recovery directory is a symlink or non-directory".into());
    }
    #[cfg(target_os = "windows")]
    if crate::windows_fs::is_reparse(&parent_metadata) {
        return Err("evidence recovery directory is a reparse point".into());
    }
    #[cfg(target_os = "windows")]
    let canonical_parent = crate::windows_fs::validate_local_ntfs_path(&parent)?;
    #[cfg(not(target_os = "windows"))]
    let canonical_parent = fs::canonicalize(&parent)
        .map_err(|error| format!("resolve evidence recovery directory: {error}"))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("evidence recovery directory escapes protected app data".into());
    }
    let final_path = canonical_root.join(
        evidence
            .relative_path
            .as_deref()
            .ok_or("pending evidence has no final path")?,
    );
    let staging_path = canonical_root.join(staging_relative);
    if final_path.parent() != Some(canonical_parent.as_path())
        || staging_path.parent() != Some(canonical_parent.as_path())
    {
        return Err("evidence recovery paths escape their run directory".into());
    }
    Ok(Some((canonical_parent, final_path, staging_path)))
}

fn path_exists_without_following(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("inspect evidence artifact: {error}")),
    }
}

fn evidence_artifact_matches(path: &Path, evidence: &EvidenceRecord) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("inspect evidence artifact: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != evidence.bytes
        || evidence.bytes > FULL_EVIDENCE_BYTES as u64
    {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    if crate::windows_fs::is_reparse(&metadata) {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    let file = match crate::windows_fs::open_no_reparse(path, false) {
        Ok(file) => file,
        Err(_) if !path.exists() => return Ok(false),
        Err(error) => return Err(format!("open evidence artifact for recovery: {error}")),
    };
    #[cfg(not(target_os = "windows"))]
    let file = {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("open evidence artifact for recovery: {error}")),
        }
    };
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("inspect opened evidence artifact: {error}"))?;
    if !opened_metadata.is_file() || opened_metadata.len() != evidence.bytes {
        return Ok(false);
    }
    let read_limit = evidence
        .bytes
        .checked_add(1)
        .ok_or("evidence byte count is too large")?;
    let mut bytes = Vec::with_capacity(evidence.bytes as usize);
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read evidence artifact for recovery: {error}"))?;
    Ok(bytes.len() as u64 == evidence.bytes && sha256_hex(&bytes) == evidence.sha256)
}

/// Read one complete evidence artifact back for in-app review.
///
/// The digest is re-verified on every read rather than trusted from the row.
/// The whole point of this artifact is to be shown as proof of what a step did,
/// so returning bytes that no longer match what was recorded would be worse
/// than returning nothing: the operator cannot tell the difference by looking.
/// `Ok(None)` means there is nothing trustworthy to show — absent, resized,
/// symlinked, or altered — and is deliberately not distinguished further, since
/// each case is reported to the operator the same way.
///
/// Confinement is `confined_pending_evidence_paths`, the same helper recovery
/// uses, so a traversal or symlinked path is rejected identically on both.
pub fn read_complete_evidence_artifact(
    evidence_root: &Path,
    evidence: &EvidenceRecord,
) -> Result<Option<Vec<u8>>, String> {
    if evidence.availability != EvidenceAvailability::Complete {
        return Ok(None);
    }
    let Some((_parent, final_path, _staging)) =
        confined_pending_evidence_paths(evidence_root, evidence)?
    else {
        return Ok(None);
    };
    let metadata = match fs::symlink_metadata(&final_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect evidence artifact: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != evidence.bytes
        || evidence.bytes > FULL_EVIDENCE_BYTES as u64
    {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(&final_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("open evidence artifact: {error}")),
    };
    let opened_metadata = file
        .metadata()
        .map_err(|error| format!("inspect opened evidence artifact: {error}"))?;
    if !opened_metadata.is_file() || opened_metadata.len() != evidence.bytes {
        return Ok(None);
    }
    // Read one byte past the recorded size so a file that GREW between the
    // metadata check and the read is caught by the length comparison below
    // rather than silently truncated into a plausible-looking artifact.
    let read_limit = evidence
        .bytes
        .checked_add(1)
        .ok_or("evidence byte count is too large")?;
    let mut bytes = Vec::with_capacity(evidence.bytes as usize);
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read evidence artifact: {error}"))?;
    if bytes.len() as u64 != evidence.bytes || sha256_hex(&bytes) != evidence.sha256 {
        return Ok(None);
    }
    Ok(Some(bytes))
}

pub fn find_evidence(
    conn: &Connection,
    run_id: &str,
    evidence_id: &str,
) -> Result<Option<EvidenceRecord>, String> {
    Ok(list_evidence(conn, run_id)?
        .into_iter()
        .find(|item| item.id == evidence_id))
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::windows_fs::sync_directory(path)
            .map_err(|error| format!("sync evidence directory: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync evidence directory: {error}"))
}

#[cfg(target_os = "windows")]
fn promote_pending_evidence(source: &Path, destination: &Path) -> Result<(), String> {
    crate::windows_fs::promote_new_file(source, destination)
        .map_err(|error| format!("promote pending evidence artifact: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn promote_pending_evidence(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("promote pending evidence artifact: {error}"))
}

fn safe_evidence_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn list_evidence(conn: &Connection, run_id: &str) -> Result<Vec<EvidenceRecord>, String> {
    let mut stmt=conn.prepare(
        "SELECT id,attempt_id,run_id,mode,availability,relative_path,bytes,sha256,redacted,truncated,created_at
         FROM runbook_evidence WHERE run_id=?1 ORDER BY created_at,id"
    ).map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, bool>(8)?,
                r.get::<_, bool>(9)?,
                r.get::<_, String>(10)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (
            id,
            attempt_id,
            run_id,
            mode,
            availability,
            relative_path,
            bytes,
            sha256,
            redacted,
            truncated,
            created_at,
        ) = row.map_err(|e| e.to_string())?;
        Ok(EvidenceRecord {
            id,
            attempt_id,
            run_id,
            mode: parse_enum(&mode)?,
            availability: parse_enum(&availability)?,
            relative_path,
            bytes: bytes as u64,
            sha256,
            redacted,
            truncated,
            created_at,
        })
    })
    .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRecord {
    pub id: String,
    pub run_id: String,
    pub sequence: u64,
    pub event_type: String,
    pub step_id: Option<String>,
    pub attempt_id: Option<String>,
    pub payload: Value,
    pub created_at: String,
}

pub fn append_event(
    conn: &mut Connection,
    run_id: &str,
    event_type: &str,
    step_id: Option<&str>,
    attempt_id: Option<&str>,
    payload: &Value,
) -> Result<EventRecord, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let event = append_event_tx(
        &tx, run_id, event_type, step_id, attempt_id, payload, &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(event)
}

pub fn list_events(conn: &Connection, run_id: &str) -> Result<Vec<EventRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,run_id,sequence,event_type,step_id,attempt_id,payload_json,created_at
         FROM runbook_events WHERE run_id=?1 ORDER BY sequence",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, run_id, sequence, event_type, step_id, attempt_id, payload, created_at) =
            row.map_err(|e| e.to_string())?;
        Ok(EventRecord {
            id,
            run_id,
            sequence: sequence as u64,
            event_type,
            step_id,
            attempt_id,
            payload: serde_json::from_str(&payload).map_err(|e| e.to_string())?,
            created_at,
        })
    })
    .collect()
}

fn append_event_tx(
    tx: &Transaction<'_>,
    run_id: &str,
    event_type: &str,
    step_id: Option<&str>,
    attempt_id: Option<&str>,
    payload: &Value,
    created_at: &str,
) -> Result<EventRecord, String> {
    let sequence: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM runbook_events WHERE run_id=?1",
            [run_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let payload_json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO runbook_events(id,run_id,sequence,event_type,step_id,attempt_id,payload_json,created_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
               params![id,run_id,sequence,event_type,step_id,attempt_id,payload_json,created_at])
        .map_err(|e|format!("append runbook event: {e}"))?;
    Ok(EventRecord {
        id,
        run_id: run_id.into(),
        sequence: sequence as u64,
        event_type: event_type.into(),
        step_id: step_id.map(str::to_string),
        attempt_id: attempt_id.map(str::to_string),
        payload: payload.clone(),
        created_at: created_at.into(),
    })
}

/// On process startup, active durable runs become interrupted and all in-flight
/// attempts become unknown. Nothing here re-dispatches a command.
pub fn interrupt_active_runs(conn: &mut Connection) -> Result<Vec<String>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let run_ids: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT id FROM runbook_runs WHERE status IN
          ('created','ready','running','waiting_approval','waiting_operator','paused')
          ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let timestamp = now();
    for run_id in &run_ids {
        // Any apply whose execution started crossed the dispatch boundary
        // before the process disappeared. This includes a result committed
        // just before a crash but before its step transition. Preserve that
        // monotonic "may have changed" fact; a later compliant retry must
        // report remediated_verified, never already_compliant.
        tx.execute(
            "UPDATE runbook_steps SET changed=1,updated_at=?2
             WHERE run_id=?1 AND EXISTS (
               SELECT 1 FROM runbook_attempts
               WHERE runbook_attempts.run_id=runbook_steps.run_id
                 AND runbook_attempts.step_id=runbook_steps.step_id
                 AND runbook_attempts.phase='apply'
                 AND runbook_attempts.started_at IS NOT NULL
             )",
            params![run_id, timestamp],
        )
        .map_err(|e| format!("preserve interrupted apply state: {e}"))?;
        tx.execute("UPDATE runbook_attempts SET status='unknown',error='application interrupted before outcome was reconciled',
                    result_at=?2 WHERE run_id=?1 AND status IN ('intent','waiting_approval','running')",params![run_id,timestamp])
            .map_err(|e|e.to_string())?;
        tx.execute("UPDATE runbook_approvals SET status='cancelled',reason='application interrupted',decided_at=?2
                    WHERE run_id=?1 AND status='pending'",params![run_id,timestamp]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE runbook_steps SET status='unknown',updated_at=?2 WHERE run_id=?1
                    AND status IN ('checking','applying','verifying')",
            params![run_id, timestamp],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE runbook_runs SET status='interrupted',pause_reason='application interrupted; explicit rebind required',
                    updated_at=?2 WHERE id=?1",params![run_id,timestamp]).map_err(|e|e.to_string())?;
        append_event_tx(
            &tx,
            run_id,
            "run_interrupted",
            None,
            None,
            &serde_json::json!({"reason":"process_restart"}),
            &timestamp,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(run_ids)
}

pub fn rebind_interrupted_run(
    conn: &mut Connection,
    run_id: &str,
    target: &TargetBinding,
    operator_confirmed: bool,
    resume_app_version: &str,
    resume_model: Option<&str>,
) -> Result<RunRecord, String> {
    if !operator_confirmed {
        return Err("explicit operator confirmation is required".into());
    }
    if resume_app_version.trim().is_empty() || resume_app_version.chars().any(char::is_control) {
        return Err("resume app version must be one printable line".into());
    }
    if resume_model
        .is_some_and(|model| model.trim().is_empty() || model.chars().any(char::is_control))
    {
        return Err("resume model must be one printable line".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    let target_json = serde_json::to_string(target).map_err(|e| e.to_string())?;
    let previous_target_json: String = tx
        .query_row(
            "SELECT target_json FROM runbook_runs WHERE id=?1 AND status='interrupted'",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("run {run_id} is not interrupted"))?;
    let previous_target: TargetBinding = serde_json::from_str(&previous_target_json)
        .map_err(|e| format!("stored target for run {run_id} is invalid: {e}"))?;
    let count = tx
        .execute(
            "UPDATE runbook_runs SET status='ready',target_json=?2,target_session_id=?3,
                          pause_reason=NULL,updated_at=?4 WHERE id=?1 AND status='interrupted'",
            params![run_id, target_json, target.lock_key(), timestamp],
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err(format!("run {run_id} is not interrupted"));
    }
    append_event_tx(
        &tx,
        run_id,
        "run_rebound",
        None,
        None,
        &serde_json::json!({
            "session_id":target.session_id(),
            "target_label":target.label(),
            "environment": {
                "app_version": resume_app_version,
                "model": resume_model,
            },
            "previous_target": previous_target,
            "target": target,
        }),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    get_run(conn, run_id)?.ok_or_else(|| "rebound run disappeared".into())
}

pub fn save_report(conn: &mut Connection, report: &RunbookReport) -> Result<String, String> {
    let canonical = report.canonical_json()?;
    let hash = sha256_hex(canonical.as_bytes());
    let timestamp = now();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (status, stored_json, stored_hash, stored_generated_at): StoredReportColumns = tx
        .query_row(
            "SELECT status,report_json,report_sha256,report_generated_at
             FROM runbook_runs WHERE id=?1",
            [&report.run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown run: {}", report.run_id))?;
    if status != report.status.as_str() {
        return Err(format!(
            "report status {} does not match stored run status {status}",
            report.status
        ));
    }
    match (stored_json, stored_hash, stored_generated_at) {
        (Some(existing), Some(existing_hash), Some(_)) => {
            let actual_existing_hash = sha256_hex(existing.as_bytes());
            if actual_existing_hash != existing_hash {
                return Err(format!(
                    "stored report for run {} failed its SHA-256 check",
                    report.run_id
                ));
            }
            if existing != canonical || existing_hash != hash {
                return Err(format!(
                    "report for run {} is immutable and already contains different bytes",
                    report.run_id
                ));
            }
            // Byte-identical retry is an idempotent success. Do not mutate the
            // generation timestamp or append a second report_ready event.
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(hash);
        }
        (None, None, None) => {}
        _ => {
            return Err(format!(
                "stored report metadata for run {} is incomplete",
                report.run_id
            ));
        }
    }
    let updated = tx
        .execute(
            "UPDATE runbook_runs
         SET report_json=?2,report_sha256=?3,report_generated_at=?4,updated_at=?4
         WHERE id=?1 AND report_json IS NULL AND report_sha256 IS NULL
                    AND report_generated_at IS NULL",
            params![report.run_id, canonical, hash, timestamp],
        )
        .map_err(|e| e.to_string())?;
    if updated != 1 {
        return Err(format!(
            "report for run {} was concurrently finalized",
            report.run_id
        ));
    }
    append_event_tx(
        &tx,
        &report.run_id,
        "report_ready",
        None,
        None,
        &serde_json::json!({"sha256":hash}),
        &timestamp,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(hash)
}

/// Assemble the canonical report strictly from rows visible on `conn`.
/// Callers decide whether it is stored by the same transaction or by the
/// legacy recovery path after an already-terminal row is found.
fn assemble_report(
    conn: &Connection,
    run_id: &str,
    executive_summary: &str,
) -> Result<RunbookReport, String> {
    let run = get_run(conn, run_id)?.ok_or_else(|| format!("unknown run: {run_id}"))?;
    if !run.status.is_terminal() {
        return Err(format!(
            "cannot finalize a report while run {run_id} is {}",
            run.status
        ));
    }
    let finished_at = run
        .finished_at
        .clone()
        .ok_or_else(|| format!("terminal run {run_id} has no finished_at timestamp"))?;
    let start_for_duration = run.started_at.as_deref().unwrap_or(&run.created_at);
    let duration_ms = timestamp_duration_ms(start_for_duration, &finished_at)?;

    let steps = list_steps(conn, run_id)?;
    let attempts = list_attempts(conn, run_id)?;
    let approvals = list_approvals(conn, run_id)?;
    let evidence = list_evidence(conn, run_id)?;
    let environment = report_environment(conn, &run)?;

    let mut checklist = Vec::with_capacity(steps.len());
    for step in steps {
        let step_attempts: Vec<ReportAttempt> = attempts
            .iter()
            .filter(|attempt| attempt.step_id == step.step_id)
            .map(|attempt| ReportAttempt {
                id: attempt.id.clone(),
                phase: attempt.phase,
                executor: attempt.executor.clone(),
                status: attempt.status,
                proposed_command: attempt.proposed_command.clone(),
                executed_command: attempt.executed_command.clone(),
                exit_code: attempt.exit_code,
                duration_ms: attempt.duration_ms,
                output_tail: attempt.output_tail.clone(),
                output_observed_bytes: attempt.output_observed_bytes,
                output_captured_bytes: attempt.output_captured_bytes,
                output_redacted: attempt.output_redacted,
                output_truncated: attempt.output_truncated,
                structured_outcomes: attempt.structured_outcomes.clone(),
                error: attempt.error.clone(),
                intent_at: attempt.intent_at.clone(),
                result_at: attempt.result_at.clone(),
            })
            .collect();
        let step_approvals: Vec<ReportApproval> = approvals
            .iter()
            .filter(|approval| approval.step_id == step.step_id)
            .map(|approval| ReportApproval {
                id: approval.id.clone(),
                phase: approval.phase,
                status: approval.status,
                proposed_command: approval.proposed_command.clone(),
                executed_command: approval.executed_command.clone(),
                read_only: approval.read_only,
                network: approval.network,
                privileged: approval.privileged,
                opaque: approval.opaque,
                project_digest: approval.project_digest.clone(),
                inventory_digest: approval.inventory_digest.clone(),
                actor: approval.actor.clone(),
                reason: approval.reason.clone(),
                requested_at: approval.requested_at.clone(),
                decided_at: approval.decided_at.clone(),
                edited: approval.edited,
            })
            .collect();
        let attempt_ids: std::collections::HashSet<&str> = step_attempts
            .iter()
            .map(|attempt| attempt.id.as_str())
            .collect();
        let step_evidence: Vec<ReportEvidence> = evidence
            .iter()
            .filter(|item| attempt_ids.contains(item.attempt_id.as_str()))
            .map(|item| ReportEvidence {
                id: item.id.clone(),
                attempt_id: item.attempt_id.clone(),
                mode: item.mode.as_str().to_string(),
                availability: item.availability,
                relative_path: item.relative_path.clone(),
                bytes: item.bytes,
                sha256: item.sha256.clone(),
                redacted: item.redacted,
                truncated: item.truncated,
            })
            .collect();

        let mut deviations = Vec::new();
        for approval in &step_approvals {
            if approval.edited {
                deviations.push(ReportDeviation {
                    kind: "edited_command".into(),
                    detail: format!(
                        "The approved command for {} was edited before execution.",
                        approval.phase
                    ),
                    proposed_command: approval.proposed_command.clone(),
                    executed_command: approval.executed_command.clone(),
                });
            }
            if approval.status == ApprovalStatus::Approved
                && approval.phase != RunbookPhase::Apply
                && (!approval.read_only
                    || approval.network
                    || approval.privileged
                    || approval.opaque)
            {
                let reason = approval
                    .reason
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("no reason recorded");
                deviations.push(ReportDeviation {
                    kind: "phase_deviation".into(),
                    detail: format!(
                        "Approved {} action classification: read_only={}, network={}, privileged={}, opaque={}; reason: {reason}.",
                        approval.phase,
                        approval.read_only,
                        approval.network,
                        approval.privileged,
                        approval.opaque,
                    ),
                    proposed_command: approval.proposed_command.clone(),
                    executed_command: approval.executed_command.clone(),
                });
            }
        }
        // An executor may persist an executed command before an approval row
        // exists (automatic local read-only checks). Preserve that deviation too.
        for attempt in &step_attempts {
            if let (Some(proposed), Some(executed)) =
                (&attempt.proposed_command, &attempt.executed_command)
            {
                if proposed != executed
                    && !deviations.iter().any(|deviation| {
                        deviation.proposed_command.as_deref() == Some(proposed)
                            && deviation.executed_command.as_deref() == Some(executed)
                    })
                {
                    deviations.push(ReportDeviation {
                        kind: "executed_command_changed".into(),
                        detail: format!(
                            "The executed {} command differed from the proposed command.",
                            attempt.phase
                        ),
                        proposed_command: Some(proposed.clone()),
                        executed_command: Some(executed.clone()),
                    });
                }
            }
        }

        // Attempt errors are immutable audit history. Only the final step
        // status determines whether an error remains an exception: a
        // successful retry must not keep a resolved attempt error in the
        // run's exception summary.
        let exceptions = step_status_exceptions(step.status);
        let mut unresolved_risks = step_status_risks(step.status);
        for unavailable in step_evidence
            .iter()
            .filter(|item| item.availability != EvidenceAvailability::Complete)
        {
            unresolved_risks.push(format!(
                "Evidence {} is {} and no verified artifact is available.",
                unavailable.id, unavailable.availability
            ));
        }

        checklist.push(ReportChecklistItem {
            id: step.step_id,
            title: step.title,
            required: step.required,
            status: step.status,
            checked: step.status.is_checked(),
            changed: step.changed,
            assurance: step.assurance,
            summary: step.summary,
            operator_comment: step.operator_comment,
            waiver: step.waiver,
            attempts: step_attempts,
            approvals: step_approvals,
            deviations,
            evidence: step_evidence,
            exceptions,
            unresolved_risks,
        });
    }

    let mut global_exceptions: Vec<String> = checklist
        .iter()
        .filter(|step| step.required)
        .flat_map(|step| {
            step.exceptions
                .iter()
                .map(move |detail| format!("{}: {detail}", step.title))
        })
        .collect();
    if matches!(run.status, RunStatus::Failed | RunStatus::Cancelled) {
        global_exceptions.insert(0, format!("Run ended with status {}.", run.status));
    }
    let unavailable_evidence = checklist
        .iter()
        .flat_map(|step| &step.evidence)
        .filter(|item| item.availability != EvidenceAvailability::Complete)
        .count();
    if unavailable_evidence > 0 {
        global_exceptions.push(format!(
            "{unavailable_evidence} requested evidence artifact(s) are unavailable."
        ));
    }
    let global_risks = checklist
        .iter()
        .filter(|step| step.required)
        .flat_map(|step| {
            step.unresolved_risks
                .iter()
                .map(move |risk| format!("{}: {risk}", step.title))
        })
        .collect();

    let report = RunbookReport {
        api_version: REPORT_API_VERSION.into(),
        run_id: run.id,
        status: run.status,
        definition: ReportDefinition {
            id: run.definition_id,
            version: run.definition_version,
            title: run.definition_title,
            source_sha256: run.source_sha256,
            canonical_sha256: run.canonical_sha256,
        },
        target: ReportTarget::from(&run.target),
        inputs: run.inputs,
        environment,
        timing: ReportTiming {
            created_at: run.created_at,
            started_at: run.started_at,
            finished_at,
            duration_ms,
        },
        checklist,
        executive_summary: if unavailable_evidence > 0 {
            format!(
                "{} {unavailable_evidence} requested evidence artifact(s) are unavailable.",
                if executive_summary.trim().is_empty() {
                    deterministic_executive_summary(run.status)
                } else {
                    executive_summary.trim().to_string()
                }
            )
        } else if executive_summary.trim().is_empty() {
            deterministic_executive_summary(run.status)
        } else {
            executive_summary.trim().to_string()
        },
        exceptions: global_exceptions,
        unresolved_risks: global_risks,
    };
    report.validate()?;
    Ok(report)
}

/// Build and write a report for an already-terminal legacy/recovery row.
///
/// New execution paths must use `finalize_run`, which makes the terminal CAS
/// and report write indivisible. This helper remains for startup repair and
/// for byte-identical write-once retries of rows created before that invariant.
pub fn build_report(
    conn: &mut Connection,
    run_id: &str,
    executive_summary: &str,
) -> Result<RunbookReport, String> {
    let report = assemble_report(conn, run_id, executive_summary)?;
    save_report(conn, &report)?;
    Ok(report)
}

/// Atomically choose a terminal status and persist the canonical report that
/// describes it. If report assembly, validation, hashing, event insertion, or
/// the final write fails, SQLite rolls the status transition back with it.
/// This is the only finalization API for live execution; `build_report` exists
/// solely to repair legacy terminal rows whose report is completely absent.
pub fn finalize_run(
    conn: &mut Connection,
    run_id: &str,
    expected: RunStatus,
    terminal: RunStatus,
    pause_reason: Option<&str>,
    executive_summary: &str,
) -> Result<RunbookReport, String> {
    if !terminal.is_terminal() {
        return Err(format!("{terminal} is not a terminal run status"));
    }
    if !expected.can_transition_to(terminal) {
        return Err(format!(
            "invalid run finalization transition: {expected} -> {terminal}"
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (actual, report_json, report_sha256, report_generated_at): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = tx
        .query_row(
            "SELECT status,report_json,report_sha256,report_generated_at
             FROM runbook_runs WHERE id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("unknown run: {run_id}"))?;
    if actual != expected.as_str() {
        return Err(format!("run {run_id} is {actual}, expected {expected}"));
    }
    if report_json.is_some() || report_sha256.is_some() || report_generated_at.is_some() {
        return Err(format!(
            "run {run_id} already has report metadata before terminal finalization"
        ));
    }

    let timestamp = now();
    let updated = tx
        .execute(
            "UPDATE runbook_runs
             SET status=?2,finished_at=?3,pause_reason=?4,updated_at=?3
             WHERE id=?1 AND status=?5 AND report_json IS NULL
               AND report_sha256 IS NULL AND report_generated_at IS NULL",
            params![
                run_id,
                terminal.as_str(),
                timestamp,
                pause_reason,
                expected.as_str()
            ],
        )
        .map_err(|e| format!("atomically transition final run status: {e}"))?;
    if updated != 1 {
        return Err(format!(
            "run {run_id} was concurrently changed before finalization"
        ));
    }
    append_event_tx(
        &tx,
        run_id,
        "run_status_changed",
        None,
        None,
        &serde_json::json!({"from":expected,"to":terminal,"reason":pause_reason}),
        &timestamp,
    )?;

    let report = assemble_report(&tx, run_id, executive_summary)?;
    let canonical = report.canonical_json()?;
    let hash = sha256_hex(canonical.as_bytes());
    let stored = tx
        .execute(
            "UPDATE runbook_runs
             SET report_json=?2,report_sha256=?3,report_generated_at=?4,updated_at=?4
             WHERE id=?1 AND status=?5 AND report_json IS NULL
               AND report_sha256 IS NULL AND report_generated_at IS NULL",
            params![run_id, canonical, hash, timestamp, terminal.as_str()],
        )
        .map_err(|e| format!("store atomically finalized report: {e}"))?;
    if stored != 1 {
        return Err(format!(
            "run {run_id} changed while its report was being finalized"
        ));
    }
    append_event_tx(
        &tx,
        run_id,
        "report_ready",
        None,
        None,
        &serde_json::json!({"sha256":hash}),
        &timestamp,
    )?;
    tx.commit()
        .map_err(|e| format!("commit atomically finalized report: {e}"))?;
    Ok(report)
}

/// The run row remains the immutable creation environment. Every process-loss
/// rebind appends its actual environment to `runbook_events`; the canonical
/// report projects the full ordered history so it never implies that resumed
/// work ran under the original app/model.
fn report_environment(conn: &Connection, run: &RunRecord) -> Result<ReportEnvironment, String> {
    let mut resumes = Vec::<ReportResumeEnvironment>::new();
    for event in list_events(conn, &run.id)? {
        if event.event_type != "run_rebound" {
            continue;
        }
        let environment = event.payload.get("environment").ok_or_else(|| {
            format!(
                "resume event {} has no durable execution environment",
                event.id
            )
        })?;
        let app_version = environment
            .get("app_version")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("resume event {} has no app version", event.id))?;
        let model = match environment.get("model") {
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
            Some(Value::Null) => None,
            _ => return Err(format!("resume event {} has an invalid model", event.id)),
        };
        let previous_target: TargetBinding = serde_json::from_value(
            event
                .payload
                .get("previous_target")
                .cloned()
                .ok_or_else(|| format!("resume event {} has no previous target", event.id))?,
        )
        .map_err(|e| format!("resume event {} has invalid previous target: {e}", event.id))?;
        let target: TargetBinding = serde_json::from_value(
            event
                .payload
                .get("target")
                .cloned()
                .ok_or_else(|| format!("resume event {} has no rebound target", event.id))?,
        )
        .map_err(|e| format!("resume event {} has invalid rebound target: {e}", event.id))?;
        resumes.push(ReportResumeEnvironment {
            resumed_at: event.created_at,
            app_version: app_version.to_string(),
            model,
            previous_target: report_target(previous_target),
            target: report_target(target),
        });
    }
    Ok(ReportEnvironment {
        app_version: run.app_version.clone(),
        model: run.model.clone(),
        resumes,
    })
}

fn report_target(target: TargetBinding) -> ReportTarget {
    ReportTarget::from(&target)
}

fn timestamp_duration_ms(start: &str, finish: &str) -> Result<u64, String> {
    let start = chrono::DateTime::parse_from_rfc3339(start)
        .map_err(|e| format!("invalid run start timestamp: {e}"))?;
    let finish = chrono::DateTime::parse_from_rfc3339(finish)
        .map_err(|e| format!("invalid run finish timestamp: {e}"))?;
    Ok((finish - start).num_milliseconds().max(0) as u64)
}

fn deterministic_executive_summary(status: RunStatus) -> String {
    match status {
        RunStatus::Succeeded => "All required runbook steps completed successfully.".into(),
        RunStatus::CompletedWithExceptions => {
            "The runbook completed with one or more required exceptions.".into()
        }
        RunStatus::Failed => "The runbook stopped after a failure.".into(),
        RunStatus::Cancelled => "The runbook was cancelled before completion.".into(),
        _ => unreachable!("build_report checks terminal status"),
    }
}

fn step_status_exceptions(status: StepStatus) -> Vec<String> {
    let detail = match status {
        StepStatus::NeedsAction => Some("The check found remediation is still required."),
        StepStatus::Paused => Some("The step remained paused when the run ended."),
        StepStatus::Failed => Some("The step failed."),
        StepStatus::Skipped => Some("The step was explicitly skipped."),
        StepStatus::Waived => Some("The step was explicitly waived."),
        StepStatus::Blocked => Some("The step was blocked."),
        StepStatus::Unknown => Some("The step outcome is unknown."),
        StepStatus::Pending
        | StepStatus::Checking
        | StepStatus::Applying
        | StepStatus::Verifying => Some("The step did not reach a terminal outcome."),
        StepStatus::AlreadyCompliant | StepStatus::RemediatedVerified => None,
    };
    detail.map(|value| vec![value.into()]).unwrap_or_default()
}

fn step_status_risks(status: StepStatus) -> Vec<String> {
    match status {
        StepStatus::NeedsAction => vec!["The target remains noncompliant.".into()],
        StepStatus::Unknown => vec![
            "A command may have changed the target; perform a fresh check before retrying.".into(),
        ],
        StepStatus::Blocked => vec!["The blocked requirement remains unresolved.".into()],
        StepStatus::Skipped => {
            vec!["The skipped requirement was not evaluated or enforced.".into()]
        }
        StepStatus::Waived => vec!["The waived requirement remains an accepted risk.".into()],
        StepStatus::Failed | StepStatus::Paused => {
            vec!["The requirement was not verified as satisfied.".into()]
        }
        _ => vec![],
    }
}

/// Repair the narrow crash window after a terminal run transition committed
/// but before its canonical report did. Only a completely absent report is
/// rebuilt; partially populated metadata is treated as corruption and fails
/// startup rather than overwriting ambiguous audit bytes.
pub fn recover_missing_reports(conn: &mut Connection) -> Result<Vec<String>, String> {
    let missing: Vec<StoredReportColumns> = {
        let mut statement = conn
            .prepare(
                "SELECT id,report_json,report_sha256,report_generated_at
                 FROM runbook_runs
                 WHERE status IN ('succeeded','completed_with_exceptions','failed','cancelled')
                   AND (report_json IS NULL OR report_sha256 IS NULL
                        OR report_generated_at IS NULL)
                 ORDER BY created_at,id",
            )
            .map_err(|e| format!("prepare missing report recovery: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|e| format!("query missing report recovery: {e}"))?
            .collect::<Result<_, _>>()
            .map_err(|e| format!("load missing report recovery: {e}"))?;
        rows
    };
    let mut recovered = Vec::with_capacity(missing.len());
    for (run_id, report_json, report_sha256, generated_at) in missing {
        if report_json.is_some() || report_sha256.is_some() || generated_at.is_some() {
            return Err(format!(
                "terminal run {run_id} has incomplete report metadata"
            ));
        }
        build_report(conn, &run_id, "")?;
        recovered.push(run_id);
    }
    Ok(recovered)
}

pub fn load_report(conn: &Connection, run_id: &str) -> Result<Option<RunbookReport>, String> {
    let stored: Option<StoredReportColumns> = conn
        .query_row(
            "SELECT status,report_json,report_sha256,report_generated_at
             FROM runbook_runs WHERE id=?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((status, raw, stored_hash, generated_at)) = stored else {
        return Ok(None);
    };
    let (raw, stored_hash) = match (raw, stored_hash, generated_at) {
        (None, None, None) => return Ok(None),
        (Some(raw), Some(stored_hash), Some(_)) => (raw, stored_hash),
        _ => {
            return Err(format!(
                "stored report metadata for run {run_id} is incomplete"
            ));
        }
    };
    let actual_hash = sha256_hex(raw.as_bytes());
    if actual_hash != stored_hash {
        return Err(format!(
            "stored report for run {run_id} failed its SHA-256 check"
        ));
    }
    let report: RunbookReport =
        serde_json::from_str(&raw).map_err(|e| format!("stored runbook report is invalid: {e}"))?;
    if report.run_id != run_id {
        return Err(format!(
            "stored report run id {} does not match requested run {run_id}",
            report.run_id
        ));
    }
    if report.status.as_str() != status {
        return Err(format!(
            "stored report status {} does not match durable run status {status}",
            report.status
        ));
    }
    let canonical = report.canonical_json()?;
    if canonical != raw {
        return Err(format!(
            "stored report for run {run_id} is not canonical JSON"
        ));
    }
    Ok(Some(report))
}

fn parse_enum<T: FromStr<Err = String>>(value: &str) -> Result<T, String> {
    T::from_str(value)
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn text_sql_error(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}
fn json_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON; CREATE TABLE schema_version(version INTEGER PRIMARY KEY);",
        )
        .unwrap();
        migrate_v6(&conn).unwrap();
        migrate_v8(&conn).unwrap();
        migrate_v9(&conn).unwrap();
        migrate_v10(&conn).unwrap();
        migrate_v16(&conn).unwrap();
        conn
    }
    fn target(session: &str) -> TargetBinding {
        TargetBinding::active_terminal(
            session.into(),
            Some("zsh".into()),
            Some("/srv".into()),
            Some("ssh".into()),
            Some("prod".into()),
            Some("ctx".into()),
            "now".into(),
        )
    }
    fn creation(session: &str) -> RunCreation {
        RunCreation {
            source_id: None,
            definition_id: "baseline".into(),
            definition_version: "1.0.0".into(),
            definition_title: "Baseline".into(),
            source_yaml: "kind: Runbook".into(),
            canonical_json: "{\"kind\":\"Runbook\"}".into(),
            source_sha256: "a".repeat(64),
            canonical_sha256: "b".repeat(64),
            target: target(session),
            inputs: serde_json::json!({}),
            evidence_mode: EvidenceCaptureMode::Tail,
            app_version: "test".into(),
            model: None,
            steps: vec![StepSeed {
                id: "one".into(),
                title: "One".into(),
                required: true,
            }],
        }
    }

    fn pending_full_evidence(
        conn: &mut Connection,
        session: &str,
        contents: &[u8],
    ) -> (RunRecord, AttemptRecord, EvidenceRecord) {
        let run = create_run(conn, &creation(session)).unwrap();
        transition_run(conn, &run.id, RunStatus::Created, RunStatus::Ready, None).unwrap();
        transition_run(conn, &run.id, RunStatus::Ready, RunStatus::Running, None).unwrap();
        transition_step(
            conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(conn, &attempt.id, Some("check")).unwrap();
        finish_attempt(
            conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(1),
                output: Some("ok"),
                output_observed_bytes: 2,
                output_captured_bytes: 2,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        let evidence = EvidenceRecord {
            id: format!("evidence-{}", session.replace('_', "-")),
            attempt_id: attempt.id.clone(),
            run_id: run.id.clone(),
            mode: EvidenceCaptureMode::Full,
            availability: EvidenceAvailability::Pending,
            relative_path: Some(format!("runbooks/{}/{}.log", run.id, attempt.id)),
            bytes: contents.len() as u64,
            sha256: sha256_hex(contents),
            redacted: false,
            truncated: false,
            created_at: now(),
        };
        reserve_evidence(conn, &evidence).unwrap();
        (run, attempt, evidence)
    }

    #[test]
    fn migration_is_v16_and_enforces_one_active_run_per_target() {
        let mut conn = db();
        let first = create_run(&mut conn, &creation("s1")).unwrap();
        assert_eq!(first.status, RunStatus::Created);
        assert_eq!(first.definition_id, "baseline");
        assert_eq!(first.definition_version, "1.0.0");
        assert_eq!(first.definition_title, "Baseline");
        assert_eq!(first.source_yaml, "kind: Runbook");
        assert_eq!(first.canonical_json, "{\"kind\":\"Runbook\"}");
        assert_eq!(first.source_sha256, "a".repeat(64));
        assert_eq!(first.canonical_sha256, "b".repeat(64));
        assert_eq!(first.target.session_id(), Some("s1"));
        assert_eq!(first.inputs, serde_json::json!({}));
        assert_eq!(first.evidence_mode, EvidenceCaptureMode::Tail);
        assert_eq!(first.app_version, "test");
        assert!(create_run(&mut conn, &creation("s1"))
            .unwrap_err()
            .contains("UNIQUE"));
        transition_run(
            &mut conn,
            &first.id,
            RunStatus::Created,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();
        create_run(&mut conn, &creation("s1")).unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 16);
        assert!(table_has_column(&conn, "runbook_attempts", "structured_outcomes").unwrap());
        assert!(table_has_column(&conn, "runbook_approvals", "project_digest").unwrap());
        assert!(table_has_column(&conn, "runbook_approvals", "inventory_digest").unwrap());
        let steps_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='runbook_steps'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(steps_sql.contains("ansible_runner"));
    }

    #[test]
    fn ansible_import_metadata_is_linked_to_an_ordinary_user_source() {
        let conn = db();
        let source = upsert_source(
            &conn,
            &SourceRegistrationInput {
                package_path: "/tmp/managed-ansible".into(),
                definition_id: "managed-ansible".into(),
                definition_version: "1.0.0".into(),
                title: "Managed Ansible".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
                valid: true,
                validation_error: None,
                source_kind: SourceKind::User,
                hidden: false,
                builtin_order: None,
            },
        )
        .unwrap();
        assert!(!source.managed_ansible);
        upsert_ansible_import(
            &conn,
            &source.id,
            "/original/project",
            r#"{"projectPath":"/original/project"}"#,
        )
        .unwrap();
        let linked = get_source(&conn, &source.id).unwrap().unwrap();
        assert_eq!(linked.source_kind, SourceKind::User);
        assert!(linked.managed_ansible);
        let import = get_ansible_import(&conn, &source.id).unwrap().unwrap();
        assert_eq!(import.origin_project_path, "/original/project");
        assert!(remove_source(&conn, &source.id).unwrap());
        assert!(get_ansible_import(&conn, &source.id).unwrap().is_none());
    }

    #[test]
    fn existing_experimental_v6_index_is_refreshed_for_agent_envelopes() {
        let conn = db();
        conn.execute_batch(
            "DROP INDEX idx_runbook_attempts_one_inflight;
             CREATE UNIQUE INDEX idx_runbook_attempts_one_inflight
               ON runbook_attempts(run_id)
               WHERE status IN ('intent','waiting_approval','running');",
        )
        .unwrap();
        ensure_v6_runtime_indexes(&conn).unwrap();
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type='index' AND name='idx_runbook_attempts_one_inflight'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(sql.contains("executor != 'agent'"));
    }

    #[test]
    fn existing_experimental_v6_schema_is_repaired_before_runtime_queries() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=ON;
            CREATE TABLE runbook_runs(id TEXT PRIMARY KEY);
            CREATE TABLE runbook_steps (
              run_id TEXT NOT NULL REFERENCES runbook_runs(id) ON DELETE CASCADE,
              step_id TEXT NOT NULL,
              sort_order INTEGER NOT NULL,
              title TEXT NOT NULL,
              required INTEGER NOT NULL CHECK(required IN (0,1)),
              status TEXT NOT NULL,
              changed INTEGER NOT NULL DEFAULT 0 CHECK(changed IN (0,1)),
              assurance TEXT CHECK(assurance IS NULL OR assurance IN
                ('deterministic_shell','agent_assisted','operator_attested')),
              summary TEXT, operator_comment TEXT, waiver_actor TEXT, waiver_reason TEXT,
              waiver_at TEXT, updated_at TEXT NOT NULL,
              PRIMARY KEY(run_id,step_id), UNIQUE(run_id,sort_order)
            );
            CREATE INDEX idx_runbook_steps_status ON runbook_steps(run_id,status);
            CREATE TABLE runbook_attempts (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL,
              executor TEXT NOT NULL, status TEXT NOT NULL, output_tail TEXT,
              FOREIGN KEY(run_id,step_id) REFERENCES runbook_steps(run_id,step_id)
                ON DELETE CASCADE
            );
            CREATE UNIQUE INDEX idx_runbook_attempts_one_inflight
              ON runbook_attempts(run_id)
              WHERE status IN ('intent','waiting_approval','running');
            CREATE TABLE runbook_evidence (
              id TEXT PRIMARY KEY, mode TEXT NOT NULL, bytes INTEGER NOT NULL
            );
            INSERT INTO runbook_runs(id) VALUES ('run');
            INSERT INTO runbook_steps
              (run_id,step_id,sort_order,title,required,status,changed,updated_at)
              VALUES ('run','step',0,'Step',1,'already_compliant',0,'now');
            INSERT INTO runbook_attempts
              (id,run_id,step_id,executor,status,output_tail)
              VALUES ('attempt','run','step','shell','succeeded','é');
            INSERT INTO runbook_evidence(id,mode,bytes) VALUES ('tail','tail',2);
            "#,
        )
        .unwrap();

        ensure_v6_runtime_indexes(&conn).unwrap();
        assert!(table_has_column(&conn, "runbook_attempts", "output_observed_bytes").unwrap());
        assert!(table_has_column(&conn, "runbook_attempts", "output_captured_bytes").unwrap());
        let steps_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='runbook_steps'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(steps_sql.contains("ansible_runner"));
        let counts: (i64, i64) = conn
            .query_row(
                "SELECT output_observed_bytes,output_captured_bytes
                 FROM runbook_attempts WHERE id='attempt'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts, (2, 2));
        conn.execute(
            "UPDATE runbook_steps SET assurance='shell_observed' WHERE step_id='step'",
            [],
        )
        .unwrap();
        let availability: String = conn
            .query_row(
                "SELECT availability FROM runbook_evidence WHERE id='tail'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(availability, "complete");
        assert_eq!(
            conn.query_row("PRAGMA foreign_key_check", [], |_| Ok(1))
                .optional()
                .unwrap(),
            None
        );
    }

    #[test]
    fn source_removal_preserves_immutable_run_snapshot() {
        let mut conn = db();
        let source = upsert_source(
            &conn,
            &SourceRegistrationInput {
                package_path: "/tmp/runbook".into(),
                definition_id: "baseline".into(),
                definition_version: "1.0.0".into(),
                title: "Baseline".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
                valid: true,
                validation_error: None,
                source_kind: SourceKind::User,
                hidden: false,
                builtin_order: None,
            },
        )
        .unwrap();
        let mut input = creation("s1");
        input.source_id = Some(source.id.clone());
        let run = create_run(&mut conn, &input).unwrap();
        remove_source(&conn, &source.id).unwrap();
        let loaded = get_run(&conn, &run.id).unwrap().unwrap();
        assert!(loaded.source_id.is_none());
        assert_eq!(loaded.source_yaml, "kind: Runbook");
        assert_eq!(list_runs(&conn, 10, 0).unwrap()[0].id, run.id);
    }

    #[test]
    fn builtin_removal_hides_registration_and_restore_preserves_run_reference() {
        let mut conn = db();
        let source = upsert_source(
            &conn,
            &SourceRegistrationInput {
                package_path: "/tmp/builtin-runbook".into(),
                definition_id: "builtin-baseline".into(),
                definition_version: "1.0.0".into(),
                title: "Built-in baseline".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
                valid: true,
                validation_error: None,
                source_kind: SourceKind::Builtin,
                hidden: false,
                builtin_order: Some(0),
            },
        )
        .unwrap();
        let mut input = creation("builtin-session");
        input.source_id = Some(source.id.clone());
        let run = create_run(&mut conn, &input).unwrap();

        assert!(remove_source(&conn, &source.id).unwrap());
        assert!(list_sources(&conn).unwrap().is_empty());
        let hidden = get_source(&conn, &source.id).unwrap().unwrap();
        assert!(hidden.hidden);
        assert_eq!(hidden.source_kind, SourceKind::Builtin);
        assert_eq!(
            get_run(&conn, &run.id).unwrap().unwrap().source_id,
            Some(source.id.clone())
        );

        let restored = restore_builtin_sources(&conn).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, source.id);
        assert!(!restored[0].hidden);
    }

    #[test]
    fn builtin_path_cannot_be_demoted_by_importing_it_as_a_user_source() {
        let conn = db();
        let mut input = SourceRegistrationInput {
            package_path: "/tmp/app-owned-builtin".into(),
            definition_id: "builtin".into(),
            definition_version: "1.0.0".into(),
            title: "Built-in".into(),
            source_sha256: "a".repeat(64),
            canonical_sha256: "b".repeat(64),
            valid: true,
            validation_error: None,
            source_kind: SourceKind::Builtin,
            hidden: false,
            builtin_order: Some(0),
        };
        let builtin = upsert_source(&conn, &input).unwrap();
        input.source_kind = SourceKind::User;
        input.builtin_order = None;
        let error = upsert_source(&conn, &input).unwrap_err();
        assert!(
            error.contains("cannot be imported as a user source"),
            "{error}"
        );
        let unchanged = get_source(&conn, &builtin.id).unwrap().unwrap();
        assert_eq!(unchanged.source_kind, SourceKind::Builtin);
        assert_eq!(unchanged.builtin_order, Some(0));
    }

    #[test]
    fn drafts_are_revision_checked_resumable_and_detach_from_published_sources() {
        let conn = db();
        let document = super::super::drafts::RunbookDraftDocument {
            definition_id: "draft-health".into(),
            version: "1.0.0".into(),
            title: "Draft Health".into(),
            ..Default::default()
        };
        let created = create_runbook_draft(&conn, &document).unwrap();
        assert_eq!(created.draft.revision, 1);
        assert!(created.draft.dirty);
        let mut changed = document.clone();
        changed.title = "Changed Health".into();
        let saved = save_runbook_draft(&conn, &created.draft.id, 1, &changed).unwrap();
        assert_eq!(saved.draft.revision, 2);
        assert_eq!(saved.draft.document.title, "Changed Health");
        assert!(save_runbook_draft(&conn, &created.draft.id, 1, &document)
            .unwrap_err()
            .contains("another window"));

        let source = upsert_source(
            &conn,
            &SourceRegistrationInput {
                package_path: "/tmp/draft-source".into(),
                definition_id: "draft-health".into(),
                definition_version: "1.0.0".into(),
                title: "Changed Health".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
                valid: true,
                validation_error: None,
                source_kind: SourceKind::User,
                hidden: false,
                builtin_order: None,
            },
        )
        .unwrap();
        let document_json = super::super::drafts::document_json(&changed).unwrap();
        let published = mark_runbook_draft_published(
            &conn,
            &created.draft.id,
            2,
            PublishedDraftHashes {
                version: "1.0.0",
                document_sha256: &sha256_hex(document_json.as_bytes()),
                source_sha256: &"a".repeat(64),
                readme_sha256: &"c".repeat(64),
                source_id: &source.id,
            },
        )
        .unwrap();
        assert!(!published.draft.dirty);
        assert_eq!(
            published.draft.published_source_id.as_deref(),
            Some(source.id.as_str())
        );
        remove_source(&conn, &source.id).unwrap();
        let detached = get_runbook_draft(&conn, &created.draft.id)
            .unwrap()
            .unwrap();
        assert!(detached.draft.published_source_id.is_none());
        assert_eq!(
            detached.draft.last_published_version.as_deref(),
            Some("1.0.0")
        );
        assert!(discard_runbook_draft(&conn, &created.draft.id).unwrap());
    }

    #[test]
    fn discarding_a_published_draft_keeps_its_library_source() {
        let conn = db();
        let document = super::super::drafts::RunbookDraftDocument {
            definition_id: "keep-source".into(),
            version: "1.0.0".into(),
            title: "Keep Source".into(),
            ..Default::default()
        };
        let draft = create_runbook_draft(&conn, &document).unwrap();
        let source = upsert_source(
            &conn,
            &SourceRegistrationInput {
                package_path: "/tmp/keep-source".into(),
                definition_id: "keep-source".into(),
                definition_version: "1.0.0".into(),
                title: "Keep Source".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
                valid: true,
                validation_error: None,
                source_kind: SourceKind::User,
                hidden: false,
                builtin_order: None,
            },
        )
        .unwrap();
        let json = super::super::drafts::document_json(&document).unwrap();
        mark_runbook_draft_published(
            &conn,
            &draft.draft.id,
            1,
            PublishedDraftHashes {
                version: "1.0.0",
                document_sha256: &sha256_hex(json.as_bytes()),
                source_sha256: &"a".repeat(64),
                readme_sha256: &"c".repeat(64),
                source_id: &source.id,
            },
        )
        .unwrap();

        assert!(discard_runbook_draft(&conn, &draft.draft.id).unwrap());
        assert!(get_runbook_draft(&conn, &draft.draft.id).unwrap().is_none());
        assert_eq!(
            get_source(&conn, &source.id).unwrap().unwrap().id,
            source.id
        );
    }

    #[test]
    fn explicit_history_deletion_requires_a_terminal_run_and_returns_artifacts() {
        let mut conn = db();
        let source = upsert_source(
            &conn,
            &SourceRegistrationInput {
                package_path: "/tmp/delete-runbook".into(),
                definition_id: "baseline".into(),
                definition_version: "1.0.0".into(),
                title: "Baseline".into(),
                source_sha256: "a".repeat(64),
                canonical_sha256: "b".repeat(64),
                valid: true,
                validation_error: None,
                source_kind: SourceKind::User,
                hidden: false,
                builtin_order: None,
            },
        )
        .unwrap();
        let mut input = creation("delete-session");
        input.source_id = Some(source.id.clone());
        input.evidence_mode = EvidenceCaptureMode::Full;
        let run = create_run(&mut conn, &input).unwrap();
        assert!(delete_terminal_run(&mut conn, &run.id)
            .unwrap_err()
            .contains("only completed"));
        assert!(get_run(&conn, &run.id).unwrap().is_some());

        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check")).unwrap();
        finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Unknown,
                exit_code: None,
                duration_ms: Some(1),
                output: Some("unknown"),
                output_observed_bytes: 7,
                output_captured_bytes: 7,
                source_truncated: false,
                error: Some("interrupted"),
                structured_outcomes: None,
            },
        )
        .unwrap();
        add_evidence(
            &conn,
            &EvidenceRecord {
                id: "evidence-one".into(),
                attempt_id: attempt.id.clone(),
                run_id: run.id.clone(),
                mode: EvidenceCaptureMode::Full,
                availability: EvidenceAvailability::Pending,
                relative_path: Some(format!("runbooks/{}/{}.log", run.id, attempt.id)),
                bytes: 7,
                sha256: sha256_hex(b"unknown"),
                redacted: false,
                truncated: false,
                created_at: now(),
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::Unknown,
            StepUpdate::default(),
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();

        let deleted = delete_terminal_run(&mut conn, &run.id).unwrap();
        assert_eq!(deleted.id, run.id);
        assert_eq!(deleted.evidence.len(), 1);
        assert_eq!(deleted.evidence[0].id, "evidence-one");
        assert!(get_run(&conn, &run.id).unwrap().is_none());
        assert!(list_steps(&conn, &run.id).unwrap().is_empty());
        assert!(list_attempts(&conn, &run.id).unwrap().is_empty());
        assert!(list_evidence(&conn, &run.id).unwrap().is_empty());
        assert!(get_source(&conn, &source.id).unwrap().is_some());
    }

    #[test]
    fn intent_and_result_are_audited_and_output_is_redacted() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("s1")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check")).unwrap();
        let done = finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(4),
                output: Some("PASSWORD=do-not-store\nok"),
                output_observed_bytes: 24,
                output_captured_bytes: 24,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        assert!(done.output_redacted);
        assert!(!done.output_tail.unwrap().contains("do-not-store"));
        let events = list_events(&conn, &run.id).unwrap();
        assert!(events.iter().any(|e| e.event_type == "attempt_intent"));
        assert!(events.iter().any(|e| e.event_type == "attempt_result"));
    }

    #[test]
    fn none_capture_persists_counts_but_no_output_bytes() {
        let mut conn = db();
        let mut input = creation("none-capture");
        input.evidence_mode = EvidenceCaptureMode::None;
        let run = create_run(&mut conn, &input).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check")).unwrap();
        let done = finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(1),
                output: Some("secret"),
                output_observed_bytes: 6,
                output_captured_bytes: 6,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        assert_eq!(done.output_observed_bytes, 6);
        assert_eq!(done.output_captured_bytes, 6);
        assert!(done.output_tail.is_none());
        assert!(!done.output_redacted);
        assert!(list_evidence(&conn, &run.id).unwrap().is_empty());
    }

    #[test]
    fn capture_counts_require_byte_accurate_truncation_metadata() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("bad-capture")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id,
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check")).unwrap();
        let error = finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: None,
                output: Some("é"),
                output_observed_bytes: 3,
                output_captured_bytes: 2,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("without marking"));
    }

    #[test]
    fn restart_marks_inflight_attempt_unknown_without_replay() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("s1")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Apply,
                executor: "shell".into(),
                proposed_command: Some("mutate".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("mutate")).unwrap();
        assert!(
            step_by_id(&conn, &run.id, "one").unwrap().unwrap().changed,
            "apply dispatch is the durable may-have-mutated boundary"
        );
        assert_eq!(
            interrupt_active_runs(&mut conn).unwrap(),
            vec![run.id.clone()]
        );
        assert_eq!(
            get_run(&conn, &run.id).unwrap().unwrap().status,
            RunStatus::Interrupted
        );
        assert_eq!(
            get_attempt(&conn, &attempt.id).unwrap().unwrap().status,
            AttemptStatus::Unknown
        );
        assert!(
            step_by_id(&conn, &run.id, "one").unwrap().unwrap().changed,
            "a dispatched apply may have mutated the target before process loss"
        );
    }

    #[test]
    fn only_concrete_or_manual_apply_dispatch_marks_the_step_changed() {
        for (executor, command, expected_changed) in [
            ("agent", None, false),
            ("shell", Some("mutate"), true),
            ("manual", None, true),
        ] {
            let mut conn = db();
            let run =
                create_run(&mut conn, &creation(&format!("apply-boundary-{executor}"))).unwrap();
            transition_run(
                &mut conn,
                &run.id,
                RunStatus::Created,
                RunStatus::Ready,
                None,
            )
            .unwrap();
            transition_run(
                &mut conn,
                &run.id,
                RunStatus::Ready,
                RunStatus::Running,
                None,
            )
            .unwrap();
            let attempt = create_attempt_intent(
                &mut conn,
                &AttemptIntent {
                    run_id: run.id.clone(),
                    step_id: "one".into(),
                    phase: RunbookPhase::Apply,
                    executor: executor.into(),
                    proposed_command: command.map(str::to_string),
                },
            )
            .unwrap();
            start_attempt(&mut conn, &attempt.id, command).unwrap();
            assert_eq!(
                step_by_id(&conn, &run.id, "one").unwrap().unwrap().changed,
                expected_changed,
                "unexpected apply mutation boundary for {executor}"
            );
        }
    }

    #[test]
    fn agent_parent_allows_exactly_one_nested_non_agent_attempt() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("agent-nested-attempt")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let parent = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "agent".into(),
                proposed_command: None,
            },
        )
        .unwrap();
        start_attempt(&mut conn, &parent.id, None).unwrap();

        let nested = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "agent_shell".into(),
                proposed_command: Some("check-one".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &nested.id, Some("check-one")).unwrap();
        let second = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "agent_shell".into(),
                proposed_command: Some("check-two".into()),
            },
        )
        .unwrap_err();
        assert!(
            second.contains("UNIQUE"),
            "second nested attempt was not rejected: {second}"
        );
        assert_eq!(
            get_attempt(&conn, &parent.id).unwrap().unwrap().status,
            AttemptStatus::Running
        );
        assert_eq!(
            get_attempt(&conn, &nested.id).unwrap().unwrap().status,
            AttemptStatus::Running
        );
    }

    #[test]
    fn restart_does_not_claim_an_undispatched_apply_changed_the_target() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("intent-only")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Apply,
                executor: "shell".into(),
                proposed_command: Some("mutate".into()),
            },
        )
        .unwrap();

        interrupt_active_runs(&mut conn).unwrap();
        assert!(!step_by_id(&conn, &run.id, "one").unwrap().unwrap().changed);
    }

    #[test]
    fn restart_preserves_apply_change_when_result_committed_before_step_transition() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("apply-result-crash")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Apply,
                executor: "shell".into(),
                proposed_command: Some("mutate".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("mutate")).unwrap();
        finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(1),
                output: Some("done"),
                output_observed_bytes: 4,
                output_captured_bytes: 4,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();

        interrupt_active_runs(&mut conn).unwrap();
        assert_eq!(
            get_attempt(&conn, &attempt.id).unwrap().unwrap().status,
            AttemptStatus::Succeeded
        );
        assert!(step_by_id(&conn, &run.id, "one").unwrap().unwrap().changed);
    }

    #[test]
    fn resume_environment_and_target_history_are_append_only_in_report() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("resume-original")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        interrupt_active_runs(&mut conn).unwrap();
        let rebound_target = target("resume-actual");
        rebind_interrupted_run(
            &mut conn,
            &run.id,
            &rebound_target,
            true,
            "2.0.0",
            Some("resume-model"),
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();
        let report = build_report(&mut conn, &run.id, "").unwrap();
        assert_eq!(report.environment.app_version, "test");
        assert_eq!(report.environment.resumes.len(), 1);
        let resume = &report.environment.resumes[0];
        assert_eq!(resume.app_version, "2.0.0");
        assert_eq!(resume.model.as_deref(), Some("resume-model"));
        assert_eq!(resume.previous_target.session_id, "resume-original");
        assert_eq!(resume.target.session_id, "resume-actual");
    }

    #[test]
    fn retry_and_settlement_cannot_mutate_a_step_after_its_run_is_terminal() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("s1")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::Paused,
            StepUpdate::default(),
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Paused,
            Some("operator decision required"),
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Paused,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();

        assert!(reset_step_for_retry(&mut conn, &run.id, "one").is_err());
        assert!(settle_exception_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Failed,
            None,
            None,
            false,
        )
        .is_err());
        assert_eq!(
            list_steps(&conn, &run.id).unwrap()[0].status,
            StepStatus::Paused,
            "the failed transaction must roll its step update back"
        );
    }

    #[test]
    fn successful_retry_preserves_changed_and_resolves_historical_attempt_errors() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("retry-session")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::NeedsAction,
            StepUpdate::default(),
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::NeedsAction,
            StepStatus::Applying,
            StepUpdate::default(),
        )
        .unwrap();
        let uncertain_apply = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Apply,
                executor: "shell".into(),
                proposed_command: Some("mutate".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &uncertain_apply.id, Some("mutate")).unwrap();
        finish_attempt(
            &mut conn,
            &uncertain_apply.id,
            AttemptResult {
                status: AttemptStatus::Unknown,
                exit_code: None,
                duration_ms: Some(5),
                output: None,
                output_observed_bytes: 0,
                output_captured_bytes: 0,
                source_truncated: false,
                error: Some("terminal response was lost"),
                structured_outcomes: None,
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Applying,
            StepStatus::Unknown,
            StepUpdate {
                changed: true,
                ..StepUpdate::default()
            },
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::WaitingOperator,
            Some("operator decision required"),
        )
        .unwrap();

        let reset = reset_step_for_retry(&mut conn, &run.id, "one").unwrap();
        assert_eq!(reset.status, StepStatus::Pending);
        assert!(
            reset.changed,
            "retry must retain that an earlier apply may have mutated the target"
        );

        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate {
                changed: true,
                ..StepUpdate::default()
            },
        )
        .unwrap();
        let retry_check = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &retry_check.id, Some("check")).unwrap();
        finish_attempt(
            &mut conn,
            &retry_check.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(1),
                duration_ms: Some(2),
                output: Some("still needs action"),
                output_observed_bytes: 18,
                output_captured_bytes: 18,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::NeedsAction,
            StepUpdate {
                changed: true,
                ..StepUpdate::default()
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::NeedsAction,
            StepStatus::Applying,
            StepUpdate {
                changed: true,
                ..StepUpdate::default()
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Applying,
            StepStatus::Verifying,
            StepUpdate {
                changed: true,
                ..StepUpdate::default()
            },
        )
        .unwrap();
        let verify = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Verify,
                executor: "shell".into(),
                proposed_command: Some("verify".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &verify.id, Some("verify")).unwrap();
        finish_attempt(
            &mut conn,
            &verify.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(3),
                output: Some("compliant"),
                output_observed_bytes: 9,
                output_captured_bytes: 9,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Verifying,
            StepStatus::RemediatedVerified,
            StepUpdate {
                changed: true,
                assurance: Some(VerificationAssurance::DeterministicShell),
                summary: Some("The retry verified the remediation."),
                ..StepUpdate::default()
            },
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Succeeded,
            None,
        )
        .unwrap();

        let report = build_report(&mut conn, &run.id, "").unwrap();
        let item = &report.checklist[0];
        assert!(item.changed);
        assert!(item.checked);
        assert!(item.exceptions.is_empty());
        assert!(report.exceptions.is_empty());
        assert_eq!(
            item.attempts[0].error.as_deref(),
            Some("terminal response was lost"),
            "resolved errors remain in the immutable attempt audit trail"
        );
    }

    #[test]
    fn atomic_finalization_rolls_back_status_when_report_validation_fails() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("atomic-finalize")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        let event_count = list_events(&conn, &run.id).unwrap().len();

        // A succeeded report cannot contain a pending required step. The
        // report validation error must roll back the preceding terminal CAS
        // and its event rather than leaving a terminal row without a report.
        let error = finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Succeeded,
            None,
            "incorrect success",
        )
        .unwrap_err();
        assert!(error.contains("required exceptions"));
        let after_failure = get_run(&conn, &run.id).unwrap().unwrap();
        assert_eq!(after_failure.status, RunStatus::Running);
        assert!(after_failure.finished_at.is_none());
        assert!(after_failure.report_sha256.is_none());
        assert!(load_report(&conn, &run.id).unwrap().is_none());
        assert_eq!(list_events(&conn, &run.id).unwrap().len(), event_count);

        let report = finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Cancelled,
            Some("operator cancelled"),
            "cancelled after validation test",
        )
        .unwrap();
        let finalized = get_run(&conn, &run.id).unwrap().unwrap();
        assert_eq!(finalized.status, RunStatus::Cancelled);
        assert_eq!(
            finalized.finished_at.as_deref(),
            Some(report.timing.finished_at.as_str())
        );
        assert_eq!(finalized.report_generated_at, finalized.finished_at);
        assert_eq!(load_report(&conn, &run.id).unwrap(), Some(report));
        let terminal_events = list_events(&conn, &run.id).unwrap();
        assert_eq!(
            terminal_events
                .iter()
                .filter(|event| event.event_type == "report_ready")
                .count(),
            1
        );
    }

    #[test]
    fn attempt_error_is_redacted_and_capped_at_the_database_boundary() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("secret-error")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check")).unwrap();
        let raw_error = format!("{} PASSWORD=hunter2", "x".repeat(OUTPUT_TAIL_BYTES + 500));
        let stored_attempt = finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Failed,
                exit_code: Some(1),
                duration_ms: Some(1),
                output: None,
                output_observed_bytes: 0,
                output_captured_bytes: 0,
                source_truncated: false,
                error: Some(&raw_error),
                structured_outcomes: None,
            },
        )
        .unwrap();
        let stored_error = stored_attempt.error.as_deref().unwrap();
        assert!(stored_error.len() <= OUTPUT_TAIL_BYTES);
        assert!(stored_error.contains("[REDACTED]"));
        assert!(!stored_error.contains("hunter2"));
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::Failed,
            StepUpdate::default(),
        )
        .unwrap();
        let report = finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Failed,
            Some("check failed"),
            "run failed",
        )
        .unwrap();
        assert_eq!(
            report.checklist[0].attempts[0].error.as_deref(),
            Some(stored_error)
        );
        assert!(!report.canonical_json().unwrap().contains("hunter2"));
    }

    #[test]
    fn evidence_reservation_precedes_artifact_and_removal_is_owner_bound() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("reserved-evidence")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check")).unwrap();
        finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(1),
                output: Some("ok"),
                output_observed_bytes: 2,
                output_captured_bytes: 2,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        let reservation = EvidenceRecord {
            id: "evidence-reservation".into(),
            attempt_id: attempt.id.clone(),
            run_id: run.id.clone(),
            mode: EvidenceCaptureMode::Full,
            availability: EvidenceAvailability::Pending,
            relative_path: Some(format!("runbooks/{}/{}.log", run.id, attempt.id)),
            bytes: 2,
            sha256: sha256_hex(b"ok"),
            redacted: false,
            truncated: false,
            created_at: now(),
        };
        reserve_evidence(&conn, &reservation).unwrap();
        assert_eq!(
            list_evidence(&conn, &run.id).unwrap(),
            vec![reservation.clone()]
        );
        assert!(
            remove_evidence_reservation(&conn, &reservation.id, "different-run", &attempt.id)
                .is_err()
        );
        assert_eq!(list_evidence(&conn, &run.id).unwrap().len(), 1);
        remove_evidence_reservation(&conn, &reservation.id, &run.id, &attempt.id).unwrap();
        assert!(list_evidence(&conn, &run.id).unwrap().is_empty());
    }

    /// A root holding one complete artifact at the canonical relative path.
    fn evidence_fixture(label: &str, contents: &[u8]) -> (PathBuf, EvidenceRecord) {
        let root =
            std::env::temp_dir().join(format!("runbook-evidence-{label}-{}", uuid::Uuid::new_v4()));
        let directory = root.join("runbooks").join("run-1");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("attempt-1.log"), contents).unwrap();
        (
            root,
            EvidenceRecord {
                id: "evidence-1".into(),
                attempt_id: "attempt-1".into(),
                run_id: "run-1".into(),
                mode: EvidenceCaptureMode::Full,
                availability: EvidenceAvailability::Complete,
                relative_path: Some("runbooks/run-1/attempt-1.log".into()),
                bytes: contents.len() as u64,
                sha256: sha256_hex(contents),
                redacted: false,
                truncated: false,
                created_at: now(),
            },
        )
    }

    /// Set a run up to the point where a check phase is about to ask for
    /// approval: running, step one checking, one intent attempt.
    fn run_awaiting_first_approval(conn: &mut Connection, session: &str) -> (RunRecord, String) {
        let run = create_run(conn, &creation(session)).unwrap();
        transition_run(conn, &run.id, RunStatus::Created, RunStatus::Ready, None).unwrap();
        transition_run(conn, &run.id, RunStatus::Ready, RunStatus::Running, None).unwrap();
        transition_step(
            conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check".into()),
            },
        )
        .unwrap();
        (run, attempt.id)
    }

    fn approval_intent(run_id: &str, attempt_id: &str, id: &str) -> ApprovalIntent {
        ApprovalIntent {
            id: id.into(),
            attempt_id: attempt_id.into(),
            run_id: run_id.into(),
            step_id: "one".into(),
            phase: RunbookPhase::Check,
            proposed_command: Some("check".into()),
            read_only: false,
            network: false,
            privileged: false,
            opaque: true,
            project_digest: None,
            inventory_digest: None,
        }
    }

    /// A reader must never see a run that is waiting on an approval that does
    /// not exist, or running with one that does.
    ///
    /// The engine holds its own connection, so anything it commits in two steps
    /// is observable in between by `runbooks_get`. Rollback is the property
    /// that proves these are one transaction: make the second half fail and the
    /// first half must be gone too.
    #[test]
    fn an_approval_and_its_run_status_move_together() {
        let mut conn = db();
        let (run, attempt_id) = run_awaiting_first_approval(&mut conn, "approval-atomicity");

        request_approval_awaiting(&mut conn, &approval_intent(&run.id, &attempt_id, "a-1"))
            .unwrap();
        assert_eq!(
            get_run(&conn, &run.id).unwrap().unwrap().status,
            RunStatus::WaitingApproval
        );
        assert_eq!(
            get_approval(&conn, "a-1").unwrap().unwrap().status,
            ApprovalStatus::Pending
        );

        approve_and_resume(&mut conn, &run.id, "a-1", "operator", None, None).unwrap();
        assert_eq!(
            get_run(&conn, &run.id).unwrap().unwrap().status,
            RunStatus::Running
        );
        assert_eq!(
            get_approval(&conn, "a-1").unwrap().unwrap().status,
            ApprovalStatus::Approved
        );
    }

    #[test]
    fn a_failed_run_transition_takes_the_approval_row_with_it() {
        let mut conn = db();
        let (run, attempt_id) = run_awaiting_first_approval(&mut conn, "approval-rollback");

        // Both attempts while the run is still `running` — `create_attempt_intent`
        // requires that. `agent` executor for the second because the
        // one-in-flight unique index excludes it.
        let second = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "agent".into(),
                proposed_command: Some("check again".into()),
            },
        )
        .expect("an agent attempt may coexist with the in-flight shell attempt");

        request_approval_awaiting(&mut conn, &approval_intent(&run.id, &attempt_id, "a-1"))
            .unwrap();

        // The approval half SUCCEEDS (that attempt is still `intent`) and only
        // the status half fails, because the run is now `waiting_approval`.
        let error =
            request_approval_awaiting(&mut conn, &approval_intent(&run.id, &second.id, "a-2"))
                .expect_err("the run is not running, so the status half must fail");
        assert!(error.contains("expected running"), "{error}");
        assert!(
            get_approval(&conn, "a-2").unwrap().is_none(),
            "the approval row must not survive a failed run transition",
        );
        assert_eq!(
            get_run(&conn, &run.id).unwrap().unwrap().status,
            RunStatus::WaitingApproval
        );
    }

    #[test]
    fn an_exhausted_evidence_budget_is_reported_rather_than_thrown() {
        // The reservation path must still fail closed, but an attempt that only
        // WANTED a full artifact has to be able to carry on with a tail: the
        // command already ran in the operator's terminal, and a retry-heavy run
        // reaches the aggregate cap legitimately.
        let mut conn = db();
        let (run, attempt, _) = pending_full_evidence(&mut conn, "budget-headroom", b"captured");

        assert_eq!(
            evidence_budget_headroom(&conn, &run.id, 1024).unwrap(),
            EvidenceBudget::Available
        );

        // Fill the run exactly to its aggregate cap. Raw insert because
        // `reserve_evidence` caps a single row at the 1 MiB per-artifact limit,
        // and the point here is the run-wide total. The fixture already holds
        // one small row, so the remainder is measured rather than assumed.
        let held: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(bytes),0) FROM runbook_evidence WHERE run_id=?1",
                [&run.id],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO runbook_evidence
             (id,attempt_id,run_id,mode,availability,relative_path,bytes,sha256,redacted,truncated,created_at)
             VALUES ('bulk',?1,?2,'full','complete',NULL,?3,'digest',0,0,?4)",
            rusqlite::params![
                attempt.id,
                run.id,
                MAX_REPORT_EVIDENCE_BYTES as i64 - held,
                now()
            ],
        )
        .unwrap();

        assert_eq!(
            evidence_budget_headroom(&conn, &run.id, 1).unwrap(),
            EvidenceBudget::BytesExhausted
        );
        // Zero further bytes still fits, so the boundary is "would exceed",
        // not "has reached".
        assert_eq!(
            evidence_budget_headroom(&conn, &run.id, 0).unwrap(),
            EvidenceBudget::Available
        );
        assert!(ensure_evidence_budget(&conn, &run.id, 1).is_err());
    }

    #[test]
    fn a_recorded_artifact_reads_back_only_while_it_still_matches() {
        let (root, evidence) = evidence_fixture("readback", b"permitrootlogin no\n");
        assert_eq!(
            read_complete_evidence_artifact(&root, &evidence).unwrap(),
            Some(b"permitrootlogin no\n".to_vec()),
        );

        // Altered on disk. The row still says complete, so trusting it would
        // present someone else's bytes as this step's proof.
        fs::write(
            root.join("runbooks/run-1/attempt-1.log"),
            b"permitrootlogin yes",
        )
        .unwrap();
        assert_eq!(
            read_complete_evidence_artifact(&root, &evidence).unwrap(),
            None
        );

        // Truncated to a prefix: same leading bytes, wrong length and digest.
        fs::write(
            root.join("runbooks/run-1/attempt-1.log"),
            b"permitrootlogin no",
        )
        .unwrap();
        assert_eq!(
            read_complete_evidence_artifact(&root, &evidence).unwrap(),
            None
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unavailable_or_missing_artifact_reads_as_nothing_rather_than_erroring() {
        let (root, complete) = evidence_fixture("unavailable", b"output");

        let mut pending = complete.clone();
        pending.availability = EvidenceAvailability::Pending;
        assert_eq!(
            read_complete_evidence_artifact(&root, &pending).unwrap(),
            None
        );
        let mut missing = complete.clone();
        missing.availability = EvidenceAvailability::Missing;
        assert_eq!(
            read_complete_evidence_artifact(&root, &missing).unwrap(),
            None
        );

        fs::remove_file(root.join("runbooks/run-1/attempt-1.log")).unwrap();
        assert_eq!(
            read_complete_evidence_artifact(&root, &complete).unwrap(),
            None
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_or_escaping_artifact_is_never_read() {
        let (root, evidence) = evidence_fixture("confinement", b"output");
        let secret = root.join("private-key");
        fs::write(&secret, b"-----BEGIN PRIVATE KEY-----").unwrap();

        // Swapped for a symlink pointing at a file outside the run directory.
        let artifact = root.join("runbooks/run-1/attempt-1.log");
        fs::remove_file(&artifact).unwrap();
        std::os::unix::fs::symlink(&secret, &artifact).unwrap();
        assert_eq!(
            read_complete_evidence_artifact(&root, &evidence).unwrap(),
            None
        );

        // A traversal in the stored path is refused by the shared confinement
        // helper before any file is opened.
        let mut escaping = evidence.clone();
        escaping.relative_path = Some("runbooks/run-1/../../private-key".into());
        assert!(read_complete_evidence_artifact(&root, &escaping).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn crash_after_full_evidence_reservation_becomes_explicitly_missing() {
        let mut conn = db();
        let root = std::env::temp_dir().join(format!(
            "runbook-evidence-reservation-crash-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let (run, _attempt, evidence) =
            pending_full_evidence(&mut conn, "reservation-crash", b"captured");

        let outcome = reconcile_pending_evidence(&mut conn, &root).unwrap();
        assert_eq!(outcome.completed, 0);
        assert_eq!(outcome.missing, 1);
        let stored = list_evidence(&conn, &run.id).unwrap();
        assert_eq!(stored[0].id, evidence.id);
        assert_eq!(stored[0].availability, EvidenceAvailability::Missing);

        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::Unknown,
            StepUpdate::default(),
        )
        .unwrap();
        let report = finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Failed,
            Some("simulated crash"),
            "Recovery recorded unavailable evidence.",
        )
        .unwrap();
        assert_eq!(
            report.checklist[0].evidence[0].availability,
            EvidenceAvailability::Missing
        );
        assert!(report.checklist[0]
            .unresolved_risks
            .iter()
            .any(|risk| risk.contains("no verified artifact is available")));
        assert!(report.markdown().unwrap().contains("availability: missing"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recovered_missing_evidence_prevents_later_checked_run_from_succeeding() {
        let mut conn = db();
        let (run, _attempt, evidence) =
            pending_full_evidence(&mut conn, "missing-then-checked", b"captured");
        mark_evidence_missing(&conn, &evidence.id, &run.id, &evidence.attempt_id).unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::AlreadyCompliant,
            StepUpdate {
                changed: false,
                assurance: Some(VerificationAssurance::ShellObserved),
                ..StepUpdate::default()
            },
        )
        .unwrap();
        assert!(finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Succeeded,
            None,
            "A later check passed.",
        )
        .unwrap_err()
        .contains("unavailable evidence"));
        assert_eq!(
            get_run(&conn, &run.id).unwrap().unwrap().status,
            RunStatus::Running
        );
        let report = finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::CompletedWithExceptions,
            None,
            "A later check passed.",
        )
        .unwrap();
        assert_eq!(report.status, RunStatus::CompletedWithExceptions);
        assert!(report
            .executive_summary
            .contains("requested evidence artifact(s) are unavailable"));
    }

    #[test]
    fn partial_staging_artifact_recovers_as_missing_not_captured() {
        let mut conn = db();
        let root = std::env::temp_dir().join(format!(
            "runbook-evidence-partial-crash-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let (run, _attempt, evidence) =
            pending_full_evidence(&mut conn, "partial-crash", b"complete evidence");
        let staging = root.join(evidence_staging_relative_path(&evidence).unwrap());
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        fs::write(&staging, b"partial").unwrap();

        let outcome = reconcile_pending_evidence(&mut conn, &root).unwrap();
        assert_eq!(outcome.completed, 0);
        assert_eq!(outcome.missing, 1);
        assert_eq!(
            list_evidence(&conn, &run.id).unwrap()[0].availability,
            EvidenceAvailability::Missing
        );
        assert!(
            staging.exists(),
            "recovery must not silently delete crash residue"
        );
        let final_path = root.join(evidence.relative_path.as_deref().unwrap());
        assert!(!final_path.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn complete_staging_artifact_is_atomically_promoted_during_recovery() {
        let mut conn = db();
        let root = std::env::temp_dir().join(format!(
            "runbook-evidence-promote-crash-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let contents = b"complete evidence";
        let (run, _attempt, evidence) = pending_full_evidence(&mut conn, "promote-crash", contents);
        let staging = root.join(evidence_staging_relative_path(&evidence).unwrap());
        fs::create_dir_all(staging.parent().unwrap()).unwrap();
        let mut file = File::create(&staging).unwrap();
        use std::io::Write as _;
        file.write_all(contents).unwrap();
        file.sync_all().unwrap();
        drop(file);

        let outcome = reconcile_pending_evidence(&mut conn, &root).unwrap();
        assert_eq!(outcome.completed, 1);
        assert_eq!(outcome.missing, 0);
        assert_eq!(
            list_evidence(&conn, &run.id).unwrap()[0].availability,
            EvidenceAvailability::Complete
        );
        let final_path = root.join(evidence.relative_path.as_deref().unwrap());
        assert_eq!(fs::read(&final_path).unwrap(), contents);
        assert!(!staging.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deletion_tombstone_keeps_report_truthful_when_database_delete_fails() {
        let mut conn = db();
        let (run, _attempt, evidence) =
            pending_full_evidence(&mut conn, "delete-failure", b"captured");
        mark_evidence_complete(&conn, &evidence.id, &run.id, &evidence.attempt_id).unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::AlreadyCompliant,
            StepUpdate {
                changed: false,
                assurance: Some(VerificationAssurance::ShellObserved),
                ..StepUpdate::default()
            },
        )
        .unwrap();
        finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Succeeded,
            None,
            "Run completed.",
        )
        .unwrap();
        assert_eq!(
            load_report(&conn, &run.id).unwrap().unwrap().checklist[0].evidence[0].availability,
            EvidenceAvailability::Complete
        );

        tombstone_evidence_for_deletion(&mut conn, &run.id).unwrap();
        let retained = load_report(&conn, &run.id).unwrap().unwrap();
        assert_eq!(
            retained.checklist[0].evidence[0].availability,
            EvidenceAvailability::Missing
        );
        assert!(retained.checklist[0]
            .unresolved_risks
            .iter()
            .any(|risk| risk.contains("no verified artifact is available")));

        conn.execute_batch(
            "CREATE TRIGGER reject_runbook_delete
             BEFORE DELETE ON runbook_runs
             BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END;",
        )
        .unwrap();
        assert!(delete_terminal_run(&mut conn, &run.id).is_err());
        let after_failure = load_report(&conn, &run.id).unwrap().unwrap();
        assert_eq!(
            after_failure.checklist[0].evidence[0].availability,
            EvidenceAvailability::Missing
        );
    }

    #[test]
    fn approved_non_apply_risk_is_a_reported_phase_deviation() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("phase-deviation")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "agent".into(),
                proposed_command: Some("remote model invocation".into()),
            },
        )
        .unwrap();
        request_approval(
            &mut conn,
            &ApprovalIntent {
                id: "approval-phase-deviation".into(),
                attempt_id: attempt.id.clone(),
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                proposed_command: Some("remote model invocation".into()),
                read_only: false,
                network: true,
                privileged: false,
                opaque: true,
                project_digest: Some("project-sha256:1".into()),
                inventory_digest: Some("inventory-sha256:2".into()),
            },
        )
        .unwrap();
        decide_approval(
            &mut conn,
            "approval-phase-deviation",
            ApprovalDecision::Approve,
            "operator",
            Some("approved remote analysis"),
            None,
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, None).unwrap();
        finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: None,
                duration_ms: Some(1),
                output: None,
                output_observed_bytes: 0,
                output_captured_bytes: 0,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::AlreadyCompliant,
            StepUpdate {
                assurance: Some(VerificationAssurance::AgentAssisted),
                ..StepUpdate::default()
            },
        )
        .unwrap();
        let report = finalize_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Succeeded,
            None,
            "verified",
        )
        .unwrap();
        let deviation = report.checklist[0]
            .deviations
            .iter()
            .find(|item| item.kind == "phase_deviation")
            .expect("approved risky check must be reported as a deviation");
        assert!(deviation.detail.contains("read_only=false"));
        assert!(deviation.detail.contains("network=true"));
        assert!(deviation.detail.contains("opaque=true"));
        assert!(deviation.detail.contains("approved remote analysis"));
        assert_eq!(
            deviation.proposed_command.as_deref(),
            Some("remote model invocation")
        );
        assert_eq!(
            deviation.executed_command.as_deref(),
            Some("remote model invocation")
        );
    }

    #[test]
    fn report_is_built_from_durable_rows_and_saved_only_after_terminal_status() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("s1")).unwrap();
        assert!(build_report(&mut conn, &run.id, "")
            .unwrap_err()
            .contains("created"));
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Ready,
            None,
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Ready,
            RunStatus::Running,
            None,
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Pending,
            StepStatus::Checking,
            StepUpdate::default(),
        )
        .unwrap();
        let attempt = create_attempt_intent(
            &mut conn,
            &AttemptIntent {
                run_id: run.id.clone(),
                step_id: "one".into(),
                phase: RunbookPhase::Check,
                executor: "shell".into(),
                proposed_command: Some("check baseline".into()),
            },
        )
        .unwrap();
        start_attempt(&mut conn, &attempt.id, Some("check baseline")).unwrap();
        finish_attempt(
            &mut conn,
            &attempt.id,
            AttemptResult {
                status: AttemptStatus::Succeeded,
                exit_code: Some(0),
                duration_ms: Some(12),
                output: Some("compliant"),
                output_observed_bytes: 9,
                output_captured_bytes: 9,
                source_truncated: false,
                error: None,
                structured_outcomes: None,
            },
        )
        .unwrap();
        transition_step(
            &mut conn,
            &run.id,
            "one",
            StepStatus::Checking,
            StepStatus::AlreadyCompliant,
            StepUpdate {
                assurance: Some(VerificationAssurance::ShellObserved),
                summary: Some("The target was already compliant."),
                ..StepUpdate::default()
            },
        )
        .unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Running,
            RunStatus::Succeeded,
            None,
        )
        .unwrap();

        let report = build_report(&mut conn, &run.id, "").unwrap();
        assert_eq!(report.status, RunStatus::Succeeded);
        assert_eq!(report.checklist.len(), 1);
        assert!(report.checklist[0].checked);
        assert_eq!(
            report.checklist[0].assurance,
            Some(VerificationAssurance::ShellObserved)
        );
        assert_eq!(report.checklist[0].attempts.len(), 1);
        assert_eq!(
            report.executive_summary,
            "All required runbook steps completed successfully."
        );
        let stored = load_report(&conn, &run.id).unwrap().unwrap();
        assert_eq!(stored, report);
        let run = get_run(&conn, &run.id).unwrap().unwrap();
        assert!(run.report_sha256.is_some());
        assert!(list_events(&conn, &run.id)
            .unwrap()
            .iter()
            .any(|event| event.event_type == "report_ready"));

        let events_before = list_events(&conn, &run.id).unwrap().len();
        let hash = save_report(&mut conn, &report).unwrap();
        assert_eq!(Some(hash), run.report_sha256);
        assert_eq!(list_events(&conn, &run.id).unwrap().len(), events_before);

        let mut replacement = report.clone();
        replacement.executive_summary = "different bytes".into();
        assert!(save_report(&mut conn, &replacement)
            .unwrap_err()
            .contains("immutable"));
    }

    #[test]
    fn report_load_recomputes_sha256_and_rejects_noncanonical_storage() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("report-integrity")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();
        let report = build_report(&mut conn, &run.id, "").unwrap();
        conn.execute(
            "UPDATE runbook_runs SET report_json=?2 WHERE id=?1",
            params![run.id, format!("{} ", report.canonical_json().unwrap())],
        )
        .unwrap();
        assert!(load_report(&conn, &run.id).unwrap_err().contains("SHA-256"));

        let pretty = report.pretty_json().unwrap();
        conn.execute(
            "UPDATE runbook_runs SET report_json=?2,report_sha256=?3 WHERE id=?1",
            params![
                run.id,
                pretty,
                sha256_hex(report.pretty_json().unwrap().as_bytes())
            ],
        )
        .unwrap();
        assert!(load_report(&conn, &run.id)
            .unwrap_err()
            .contains("not canonical"));
    }

    #[test]
    fn startup_recovers_terminal_status_committed_before_report() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("terminal-report-crash")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();
        assert!(load_report(&conn, &run.id).unwrap().is_none());

        assert_eq!(
            recover_missing_reports(&mut conn).unwrap(),
            vec![run.id.clone()]
        );
        let recovered = load_report(&conn, &run.id).unwrap().unwrap();
        assert_eq!(recovered.status, RunStatus::Cancelled);
        assert_eq!(
            recovered.executive_summary,
            "The runbook was cancelled before completion."
        );
        assert!(recover_missing_reports(&mut conn).unwrap().is_empty());
    }

    #[test]
    fn report_load_rejects_status_that_contradicts_durable_run() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("report-status-integrity")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();
        build_report(&mut conn, &run.id, "").unwrap();
        conn.execute(
            "UPDATE runbook_runs SET status='failed' WHERE id=?1",
            [&run.id],
        )
        .unwrap();
        assert!(load_report(&conn, &run.id)
            .unwrap_err()
            .contains("durable run status"));
    }

    #[test]
    fn startup_never_overwrites_partial_report_metadata() {
        let mut conn = db();
        let run = create_run(&mut conn, &creation("partial-report")).unwrap();
        transition_run(
            &mut conn,
            &run.id,
            RunStatus::Created,
            RunStatus::Cancelled,
            None,
        )
        .unwrap();
        conn.execute(
            "UPDATE runbook_runs SET report_sha256=?2 WHERE id=?1",
            params![run.id, "a".repeat(64)],
        )
        .unwrap();
        assert!(recover_missing_reports(&mut conn)
            .unwrap_err()
            .contains("incomplete report metadata"));
    }
}
