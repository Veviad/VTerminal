//! Session restore storage.
//!
//! Design notes that are easy to get wrong later:
//!
//! * **Generations.** `workspace_state.generation` is bumped once per boot, in
//!   `restore`. Restore reads the PREVIOUS generation's rows; snapshots write
//!   the new one. Two generations are retained so a boot that dies before its
//!   first snapshot does not lose the previous run.
//! * **COALESCE on scrollback.** The cheap metadata snapshot fires every ~750ms
//!   and sends `scrollback: None`; the expensive one fires rarely. The upsert
//!   must therefore never overwrite a stored blob with NULL.
//! * **restore_attempts, not clean_exit, is the safety net.** `clean_exit` only
//!   picks the banner wording — recovering a crashed run is the whole feature.
//!   The crash-loop counter is what stops bad state from bricking startup.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Restore is skipped and the table wiped once this many boots in a row have
/// tried to restore without ever reaching `mark_healthy`.
const MAX_RESTORE_ATTEMPTS: i64 = 2;

/// Metadata for one tab. Deliberately excludes the scrollback blob — the boot
/// path fetches those lazily per session so the first IPC stays small.
#[derive(Debug, Serialize)]
pub struct SessionSnapshotMeta {
    pub session_id: String,
    pub tab_index: i64,
    pub title: String,
    pub shell: String,
    pub cwd: Option<String>,
    pub host_id: Option<String>,
    pub remote_kind: Option<String>,
    pub remote_target: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub script_version: Option<String>,
    pub scrollback_lines: i64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SessionSnapshotInput {
    pub session_id: String,
    pub tab_index: i64,
    pub title: String,
    pub shell: String,
    pub cwd: Option<String>,
    pub host_id: Option<String>,
    pub remote_kind: Option<String>,
    pub remote_target: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub script_version: Option<String>,
    /// `None` means "leave whatever is stored alone" — see the COALESCE note.
    pub scrollback: Option<String>,
    pub scrollback_lines: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceSnapshotInput {
    pub active_session_id: Option<String>,
    pub sessions: Vec<SessionSnapshotInput>,
    /// Set by the final flush at quit; flips `clean_exit`.
    #[serde(default)]
    pub final_flush: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceRestore {
    pub sessions: Vec<SessionSnapshotMeta>,
    pub active_session_id: Option<String>,
    /// The previous run ended without a final flush (crash, SIGKILL, ⌘Q).
    pub crashed: bool,
    /// Restore was skipped: disabled, env-overridden, or the crash-loop guard.
    pub skipped: bool,
}

const SNAPSHOT_COLS: &str = "session_id, tab_index, title, shell, cwd, host_id, remote_kind, \
     remote_target, cols, rows, script_version, scrollback_lines, updated_at";

fn row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSnapshotMeta> {
    Ok(SessionSnapshotMeta {
        session_id: row.get(0)?,
        tab_index: row.get(1)?,
        title: row.get(2)?,
        shell: row.get(3)?,
        cwd: row.get(4)?,
        host_id: row.get(5)?,
        remote_kind: row.get(6)?,
        remote_target: row.get(7)?,
        cols: row.get(8)?,
        rows: row.get(9)?,
        script_version: row.get(10)?,
        scrollback_lines: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

/// Bump the generation, hand back the previous run's tabs, and arm the
/// crash-loop guard. Called exactly once per boot.
pub fn restore(
    conn: &mut Connection,
    enabled: bool,
    max_tabs: usize,
    app_version: &str,
) -> Result<WorkspaceRestore, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (current_gen, active, clean_exit, attempts): (i64, Option<String>, i64, i64) = tx
        .query_row(
            "SELECT generation, active_session_id, clean_exit, restore_attempts
             FROM workspace_state WHERE id = 'default'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("read workspace state: {e}"))?;

    let new_gen = current_gen + 1;
    let now = chrono::Utc::now().to_rfc3339();

    // Disabled means the user does not want captured terminal output retained,
    // not merely "skip restore this once" — so drop everything.
    if !enabled {
        tx.execute("DELETE FROM session_snapshots", [])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE workspace_state SET generation = ?1, clean_exit = 0, restore_attempts = 0,
                 app_version = ?2, updated_at = ?3 WHERE id = 'default'",
            params![new_gen, app_version, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(WorkspaceRestore {
            sessions: vec![],
            active_session_id: None,
            crashed: false,
            skipped: true,
        });
    }

    // Two failed boots in a row: the saved state is the prime suspect. Wipe it
    // and reset, so relaunching twice heals the app with no support ticket.
    if attempts >= MAX_RESTORE_ATTEMPTS {
        log::warn!("skipping session restore after {attempts} failed attempts — clearing state");
        tx.execute("DELETE FROM session_snapshots", [])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE workspace_state SET generation = ?1, clean_exit = 0, restore_attempts = 0,
                 active_session_id = NULL, app_version = ?2, updated_at = ?3 WHERE id = 'default'",
            params![new_gen, app_version, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(WorkspaceRestore {
            sessions: vec![],
            active_session_id: None,
            crashed: true,
            skipped: true,
        });
    }

    // Read the newest generation that actually HAS rows, not blindly the
    // previous one: a boot that dies before its first snapshot still advanced
    // the generation, and reading `prev_gen` would hand back nothing while the
    // run before it sits intact one generation down. Surviving exactly that
    // crash is the point of the feature.
    let read_gen: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(generation), 0) FROM session_snapshots",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sessions = {
        let sql = format!(
            "SELECT {SNAPSHOT_COLS} FROM session_snapshots
             WHERE generation = ?1 ORDER BY tab_index ASC LIMIT ?2"
        );
        let mut stmt = tx.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![read_gen, max_tabs as i64], row_to_meta)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    tx.execute(
        "UPDATE workspace_state SET generation = ?1, clean_exit = 0,
             restore_attempts = restore_attempts + 1, app_version = ?2, updated_at = ?3
         WHERE id = 'default'",
        params![new_gen, app_version, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(WorkspaceRestore {
        sessions,
        active_session_id: active,
        crashed: clean_exit == 0,
        skipped: false,
    })
}

/// Write the current tab set. Mark-and-sweep rather than a dynamic `IN (…)`:
/// rusqlite has no `array` feature here, and this is one statement either way.
pub fn snapshot(conn: &mut Connection, input: &WorkspaceSnapshotInput) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let gen: i64 = tx
        .query_row("SELECT generation FROM workspace_state WHERE id = 'default'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();

    // 1. Tombstone this generation's rows.
    tx.execute(
        "UPDATE session_snapshots SET tab_index = -1 WHERE generation = ?1",
        params![gen],
    )
    .map_err(|e| e.to_string())?;

    // 2. Upsert the live tabs back to a real index.
    for s in &input.sessions {
        tx.execute(
            "INSERT INTO session_snapshots
                (session_id, generation, tab_index, title, shell, cwd, host_id, remote_kind,
                 remote_target, cols, rows, script_version, format_version, scrollback,
                 scrollback_lines, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13,
                     COALESCE(?14, 0), ?15, ?15)
             ON CONFLICT(session_id) DO UPDATE SET
                generation = excluded.generation,
                tab_index = excluded.tab_index,
                title = excluded.title,
                shell = excluded.shell,
                cwd = excluded.cwd,
                host_id = excluded.host_id,
                remote_kind = excluded.remote_kind,
                remote_target = excluded.remote_target,
                cols = excluded.cols,
                rows = excluded.rows,
                script_version = excluded.script_version,
                -- NULL means 'metadata-only snapshot' — keep the stored blob.
                scrollback = COALESCE(?13, session_snapshots.scrollback),
                scrollback_lines = COALESCE(?14, session_snapshots.scrollback_lines),
                updated_at = excluded.updated_at",
            params![
                s.session_id,
                gen,
                s.tab_index,
                s.title,
                s.shell,
                s.cwd,
                s.host_id,
                s.remote_kind,
                s.remote_target,
                s.cols,
                s.rows,
                s.script_version,
                s.scrollback,
                s.scrollback_lines,
                now,
            ],
        )
        .map_err(|e| format!("snapshot session {}: {e}", s.session_id))?;
    }

    // 3. Sweep tabs the user closed.
    tx.execute(
        "DELETE FROM session_snapshots WHERE generation = ?1 AND tab_index < 0",
        params![gen],
    )
    .map_err(|e| e.to_string())?;

    // 4. Prune old generations, keeping ONE of slack: deleting `< gen` on the
    //    first snapshot would race the lazy blob fetches still running during
    //    restore.
    tx.execute(
        "DELETE FROM session_snapshots WHERE generation < ?1",
        params![gen - 1],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE workspace_state SET active_session_id = ?1, updated_at = ?2, clean_exit = ?3
         WHERE id = 'default'",
        params![input.active_session_id, now, i64::from(input.final_flush)],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())
}

pub fn scrollback(conn: &Connection, session_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT scrollback FROM session_snapshots WHERE session_id = ?1",
        params![session_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|outer| outer.flatten())
    .map_err(|e| e.to_string())
}

/// Called once the run has survived long enough to be considered good. Doing
/// this at boot instead would defeat the crash-loop guard entirely.
pub fn mark_healthy(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE workspace_state SET restore_attempts = 0 WHERE id = 'default'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM session_snapshots", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE workspace_state SET active_session_id = NULL, restore_attempts = 0
         WHERE id = 'default'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::database::migrations::run(&conn).unwrap();
        conn
    }

    fn tab(id: &str, index: i64) -> SessionSnapshotInput {
        SessionSnapshotInput {
            session_id: id.into(),
            tab_index: index,
            title: format!("tab {index}"),
            shell: "/bin/zsh".into(),
            cwd: Some("/tmp".into()),
            host_id: None,
            remote_kind: None,
            remote_target: None,
            cols: 120,
            rows: 40,
            script_version: Some("4".into()),
            scrollback: None,
            scrollback_lines: None,
        }
    }

    fn snap(conn: &mut Connection, sessions: Vec<SessionSnapshotInput>, active: &str) {
        snapshot(
            conn,
            &WorkspaceSnapshotInput {
                active_session_id: Some(active.into()),
                sessions,
                final_flush: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn restore_bumps_generation_and_returns_tabs_in_order() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        snap(&mut conn, vec![tab("b", 1), tab("a", 0)], "a");

        let got = restore(&mut conn, true, 24, "test").unwrap();
        assert_eq!(
            got.sessions.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(got.active_session_id.as_deref(), Some("a"));
        assert_eq!(got.sessions[0].cols, 120);
        assert!(!got.skipped);
    }

    #[test]
    fn a_metadata_only_snapshot_preserves_the_stored_blob() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();

        let mut with_blob = tab("a", 0);
        with_blob.scrollback = Some("PAYLOAD".into());
        with_blob.scrollback_lines = Some(42);
        snap(&mut conn, vec![with_blob], "a");

        // The 750ms metadata tick sends scrollback: None over and over.
        snap(&mut conn, vec![tab("a", 0)], "a");

        assert_eq!(scrollback(&conn, "a").unwrap().as_deref(), Some("PAYLOAD"));
        let lines: i64 = conn
            .query_row("SELECT scrollback_lines FROM session_snapshots WHERE session_id='a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(lines, 42);
    }

    #[test]
    fn snapshot_deletes_rows_for_closed_tabs() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        snap(&mut conn, vec![tab("a", 0), tab("b", 1)], "a");
        snap(&mut conn, vec![tab("a", 0)], "a");

        let got = restore(&mut conn, true, 24, "test").unwrap();
        assert_eq!(got.sessions.len(), 1);
        assert_eq!(got.sessions[0].session_id, "a");
    }

    /// A boot that reaches `mark_healthy` — what every non-crashing run does
    /// five seconds in. Without it the crash-loop guard trips after two boots.
    fn healthy_restore(conn: &mut Connection) -> WorkspaceRestore {
        let got = restore(conn, true, 24, "test").unwrap();
        mark_healthy(conn).unwrap();
        got
    }

    #[test]
    fn pruning_keeps_one_generation_of_slack() {
        let mut conn = mem();
        healthy_restore(&mut conn); // gen 1
        snap(&mut conn, vec![tab("gen1", 0)], "gen1");

        healthy_restore(&mut conn); // gen 2
        snap(&mut conn, vec![tab("gen2", 0)], "gen2");
        // gen 1's row survives its successor's first snapshot, so a lazy blob
        // fetch mid-restore cannot read a deleted row.
        assert!(scrollback(&conn, "gen1").is_ok());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);

        healthy_restore(&mut conn); // gen 3
        snap(&mut conn, vec![tab("gen3", 0)], "gen3");
        let remaining: Vec<String> = conn
            .prepare("SELECT session_id FROM session_snapshots ORDER BY session_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec!["gen2".to_string(), "gen3".to_string()]);
    }

    #[test]
    fn crashed_is_reported_when_there_was_no_final_flush() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        snap(&mut conn, vec![tab("a", 0)], "a");
        assert!(restore(&mut conn, true, 24, "test").unwrap().crashed);
    }

    #[test]
    fn a_final_flush_marks_a_clean_exit() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        snapshot(
            &mut conn,
            &WorkspaceSnapshotInput {
                active_session_id: Some("a".into()),
                sessions: vec![tab("a", 0)],
                final_flush: true,
            },
        )
        .unwrap();
        assert!(!restore(&mut conn, true, 24, "test").unwrap().crashed);
    }

    #[test]
    fn the_crash_loop_guard_wipes_state_after_two_unhealthy_boots() {
        let mut conn = mem();
        healthy_restore(&mut conn);
        snap(&mut conn, vec![tab("a", 0)], "a");

        // Two boots in a row that never reach mark_healthy still restore —
        // one bad launch should not cost the user their tabs.
        assert_eq!(restore(&mut conn, true, 24, "test").unwrap().sessions.len(), 1);
        assert_eq!(restore(&mut conn, true, 24, "test").unwrap().sessions.len(), 1);

        // The third bails out and clears, so relaunching heals the app.
        let third = restore(&mut conn, true, 24, "test").unwrap();
        assert!(third.skipped);
        assert!(third.sessions.is_empty());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn mark_healthy_resets_the_attempt_counter() {
        let mut conn = mem();
        healthy_restore(&mut conn);
        snap(&mut conn, vec![tab("a", 0)], "a");

        // Many boots, each marked good — the guard must never trip.
        for _ in 0..5 {
            let got = healthy_restore(&mut conn);
            assert!(!got.skipped);
            assert_eq!(got.sessions.len(), 1);
            snap(&mut conn, vec![tab("a", 0)], "a");
        }
    }

    #[test]
    fn a_boot_that_never_snapshots_does_not_lose_the_previous_run() {
        let mut conn = mem();
        healthy_restore(&mut conn);
        snap(&mut conn, vec![tab("a", 0)], "a");

        // Boot 2 restores but crashes before its first snapshot — it still
        // advanced the generation. Boot 3 must find boot 1's tabs anyway.
        let boot2 = restore(&mut conn, true, 24, "test").unwrap();
        assert_eq!(boot2.sessions.len(), 1);
        mark_healthy(&conn).unwrap();

        let boot3 = restore(&mut conn, true, 24, "test").unwrap();
        assert_eq!(boot3.sessions.len(), 1);
        assert_eq!(boot3.sessions[0].session_id, "a");
    }

    #[test]
    fn the_guard_resets_after_it_fires() {
        let mut conn = mem();
        healthy_restore(&mut conn);
        snap(&mut conn, vec![tab("a", 0)], "a");
        restore(&mut conn, true, 24, "test").unwrap();
        restore(&mut conn, true, 24, "test").unwrap();
        assert!(restore(&mut conn, true, 24, "test").unwrap().skipped);

        // Counter is back to zero, so the next run persists and restores again.
        snap(&mut conn, vec![tab("b", 0)], "b");
        let got = restore(&mut conn, true, 24, "test").unwrap();
        assert!(!got.skipped);
        assert_eq!(got.sessions.len(), 1);
        assert_eq!(got.sessions[0].session_id, "b");
    }

    #[test]
    fn disabling_restore_wipes_stored_output() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        let mut t = tab("a", 0);
        t.scrollback = Some("secret output".into());
        snap(&mut conn, vec![t], "a");

        let got = restore(&mut conn, false, 24, "test").unwrap();
        assert!(got.skipped);
        assert!(got.sessions.is_empty());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn max_tabs_bounds_the_restore() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        snap(&mut conn, (0..10).map(|i| tab(&format!("s{i}"), i)).collect(), "s0");
        let got = restore(&mut conn, true, 3, "test").unwrap();
        assert_eq!(got.sessions.len(), 3);
        assert_eq!(got.sessions[0].session_id, "s0");
    }

    #[test]
    fn clear_removes_everything_and_resets_attempts() {
        let mut conn = mem();
        restore(&mut conn, true, 24, "test").unwrap();
        snap(&mut conn, vec![tab("a", 0)], "a");
        clear(&conn).unwrap();
        let got = restore(&mut conn, true, 24, "test").unwrap();
        assert!(got.sessions.is_empty());
        assert_eq!(got.active_session_id, None);
    }

    #[test]
    fn scrollback_of_an_unknown_session_is_none() {
        let conn = mem();
        assert_eq!(scrollback(&conn, "nope").unwrap(), None);
    }
}
