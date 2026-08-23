pub mod archive;
pub mod chat;
pub mod migrations;
pub mod queries;
pub mod workspace;

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub struct DbState(pub Mutex<Connection>);

/// Open a database in `app_data_dir` with the app's standard hardening, and
/// nothing else — no migrations, no reaping.
///
/// Shared with `docs::db`, which keeps its own file and its own migration chain
/// but must not re-derive the permission handling: getting the chmod ORDER wrong
/// is silent, and the comment below is the whole reason this is one function.
pub fn open_hardened(app_data_dir: &Path, file_name: &str) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    let db_path = app_data_dir.join(file_name);
    let conn = Connection::open(&db_path).map_err(|e| format!("open db: {e}"))?;
    // Runbooks on different visible sessions use separate connections. Wait
    // through ordinary short WAL commits rather than failing immediately; this
    // is lock handling only and never replays an engine action.
    conn.busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|e| format!("configure db busy timeout: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("db pragmas: {e}"))?;
    // AFTER the WAL pragma: SQLite creates -wal/-shm on open, and both inherit
    // 0644 from the umask. The DB holds command history, saved hosts, and (once
    // session restore lands) captured terminal output — none of it should be
    // world-readable in a synced or backed-up home directory.
    restrict_permissions(app_data_dir, &db_path);
    Ok(conn)
}

pub fn init(app_data_dir: &Path) -> Result<Connection, String> {
    let mut conn = open_hardened(app_data_dir, "veviad-shell.db")?;
    migrations::run(&conn)?;
    // A live run owns a visible PTY rendezvous that cannot survive a process
    // restart. Preserve the audit trail, mark every in-flight attempt unknown,
    // and require an explicit operator rebind before the engine may continue.
    // This is fail-closed: starting with a stale "running" mutation is less
    // safe than refusing startup with an actionable database error.
    crate::runbooks::db::interrupt_active_runs(&mut conn)?;
    // Full evidence crosses SQLite and the filesystem. Reconcile every pending
    // reservation before rebuilding reports so only size/hash-verified,
    // durably renamed artifacts can be described as available.
    crate::runbooks::db::reconcile_pending_evidence(&mut conn, app_data_dir)?;
    crate::runbooks::db::reconcile_report_evidence_availability(&mut conn)?;
    // A process can disappear after committing a terminal status but before
    // the write-once canonical report. Rebuild that deterministic projection
    // from durable rows before serving history/report IPC.
    crate::runbooks::db::recover_missing_reports(&mut conn)?;
    // Sessions still flagged open belong to a run that died without closing them.
    // Deliberately non-fatal: `init`'s error becomes an io::Error in `setup` and
    // would brick startup, and a missed reap costs one mislabelled archive row.
    if let Err(e) = archive::reap_open_sessions(&mut conn) {
        log::warn!("could not reap open archived sessions: {e}");
    }
    Ok(conn)
}

#[cfg(unix)]
fn restrict_permissions(app_data_dir: &Path, db_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let chmod = |path: &Path, mode: u32| {
        if !path.exists() {
            return;
        }
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) {
            log::warn!("could not chmod {path:?} to {mode:o}: {e}");
        }
    };

    chmod(app_data_dir, 0o700);
    for suffix in ["", "-wal", "-shm"] {
        let mut path = db_path.as_os_str().to_owned();
        path.push(suffix);
        chmod(Path::new(&path), 0o600);
    }
}

#[cfg(target_os = "windows")]
fn restrict_permissions(app_data_dir: &Path, _db_path: &Path) {
    if let Err(error) = crate::windows_fs::restrict_to_current_user(app_data_dir) {
        log::warn!("could not restrict Windows app-data ACLs: {error}");
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn restrict_permissions(_app_data_dir: &Path, _db_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn hardened_connections_wait_for_a_short_writer_instead_of_failing_busy() {
        let root =
            std::env::temp_dir().join(format!("veviad-busy-timeout-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let first = open_hardened(&root, "busy.db").unwrap();
        first
            .execute_batch("CREATE TABLE values_table(value INTEGER NOT NULL);")
            .unwrap();
        let second = open_hardened(&root, "busy.db").unwrap();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let writer = thread::spawn(move || {
            first.execute_batch("BEGIN IMMEDIATE;").unwrap();
            first
                .execute("INSERT INTO values_table(value) VALUES (1)", [])
                .unwrap();
            locked_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            first.execute_batch("COMMIT;").unwrap();
        });
        locked_rx.recv().unwrap();
        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            release_tx.send(()).unwrap();
        });

        let started = Instant::now();
        second
            .execute("INSERT INTO values_table(value) VALUES (2)", [])
            .unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(50),
            "the second writer did not wait for the lock holder"
        );
        let count: i64 = second
            .query_row("SELECT COUNT(*) FROM values_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        releaser.join().unwrap();
        writer.join().unwrap();
        drop(second);
        fs::remove_dir_all(&root).unwrap();
    }
}
