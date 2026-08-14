//! Session restore commands.
//!
//! Metadata and scrollback blobs are deliberately SEPARATE commands: the boot
//! path needs the tab list instantly, and a multi-megabyte JSON deserialize on
//! that path would be the single worst thing in this design.

use tauri::{State, Wry};

use crate::commands::settings;
use crate::database::{workspace, DbState};

/// Beyond this the restore is a spawn storm, not a convenience.
const MAX_TABS_PERSISTED: usize = 24;

/// The last-resort escape hatch when a bad saved state stops the app starting —
/// the one thing you can tell someone over chat.
const DISABLE_ENV: &str = "VTERMINAL_NO_RESTORE";

#[tauri::command]
pub fn workspace_restore(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
) -> Result<workspace::WorkspaceRestore, String> {
    let env_disabled = std::env::var(DISABLE_ENV).is_ok_and(|v| !v.is_empty() && v != "0");
    let enabled = !env_disabled && settings::read_bool(&app, "restore_sessions_on_start", true);
    let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
    workspace::restore(
        &mut conn,
        enabled,
        MAX_TABS_PERSISTED,
        env!("CARGO_PKG_VERSION"),
    )
}

#[tauri::command]
pub fn workspace_snapshot(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    snapshot: workspace::WorkspaceSnapshotInput,
) -> Result<(), String> {
    // Honored here as well as in the frontend: turning restore off must stop
    // new terminal output reaching the disk immediately, not at next launch.
    if !settings::read_bool(&app, "restore_sessions_on_start", true) {
        return Ok(());
    }
    let mut snapshot = snapshot;
    snapshot.sessions.truncate(MAX_TABS_PERSISTED);
    if settings::read_u32(&app, "restore_scrollback_lines", 1000) == 0 {
        // Scrollback capture is off: drop any payload rather than trusting the
        // frontend to have checked, and blank what is already stored.
        for s in &mut snapshot.sessions {
            s.scrollback = Some(String::new());
            s.scrollback_lines = Some(0);
        }
    }
    let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
    workspace::snapshot(&mut conn, &snapshot)
}

#[tauri::command]
pub fn workspace_scrollback(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    workspace::scrollback(&conn, &session_id)
}

#[tauri::command]
pub fn workspace_mark_healthy(db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    workspace::mark_healthy(&conn)
}

#[tauri::command]
pub fn workspace_mark_clean_exit(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
) -> Result<(), String> {
    commit_clean_exit(&app, &db)
}

/// Shared irreversible boundary for ordinary quits and updater exits. The
/// returned success means archive finalization, retention, and the workspace
/// clean marker committed together; attachment removal is best-effort after
/// that transaction.
pub(crate) fn commit_clean_exit(app: &tauri::AppHandle<Wry>, db: &DbState) -> Result<(), String> {
    let removed = {
        let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
        workspace::commit_clean_exit(&mut conn, super::archive::retention(app))?
    };
    super::archive::remove_archived_attachments(app, removed);
    Ok(())
}

#[tauri::command]
pub fn workspace_mark_running(db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    workspace::mark_running(&conn)
}

#[tauri::command]
pub fn workspace_clear(db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    workspace::clear(&conn)
}
