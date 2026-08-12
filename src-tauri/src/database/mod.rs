pub mod archive;
pub mod migrations;
pub mod queries;
pub mod workspace;

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct DbState(pub Mutex<Connection>);

pub fn init(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("create app data dir: {e}"))?;
    let db_path = app_data_dir.join("veviad-shell.db");
    let conn = Connection::open(&db_path).map_err(|e| format!("open db: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("db pragmas: {e}"))?;
    // AFTER the WAL pragma: SQLite creates -wal/-shm on open, and both inherit
    // 0644 from the umask. The DB holds command history, saved hosts, and (once
    // session restore lands) captured terminal output — none of it should be
    // world-readable in a synced or backed-up home directory.
    restrict_permissions(app_data_dir, &db_path);
    migrations::run(&conn)?;
    // Sessions still flagged open belong to a run that died without closing them.
    // Deliberately non-fatal: `init`'s error becomes an io::Error in `setup` and
    // would brick startup, and a missed reap costs one mislabelled archive row.
    if let Err(e) = archive::reap_open_sessions(&conn) {
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

#[cfg(not(unix))]
fn restrict_permissions(_app_data_dir: &Path, _db_path: &Path) {}
