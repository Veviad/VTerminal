//! Session archive commands.
//!
//! Split the same way the restore commands are (`commands/workspace.rs`): the
//! list must be small and instant, so the scrollback blob and the model
//! transcript are SEPARATE lazy commands fetched only for the row actually being
//! reopened. Opening the browser deserializes metadata and nothing else.

use tauri::{State, Wry};

use crate::commands::settings;
use crate::database::{archive, DbState};
use crate::provider::ChatMessage;

/// Matches `history_recent`'s ceiling. The retention limit tops out at 1000, but
/// a list that long is a scrolling problem, not a browsing one.
const MAX_LIST: u32 = 200;

/// Beyond this a quit-time batch is a serialization storm — the same reasoning
/// (and the same number) as `MAX_TABS_PERSISTED`.
const MAX_BATCH: usize = 24;

fn retention(app: &tauri::AppHandle<Wry>) -> archive::Retention {
    archive::Retention {
        max_sessions: settings::read_u32(app, "archive_max_sessions", 50).min(1000),
        max_age_days: settings::read_u32(app, "archive_max_age_days", 30).clamp(1, 3650),
    }
}

/// Is the archive allowed to accept new writes?
///
/// Gated on `restore_sessions_on_start` as well as its own toggle, and for the
/// same reason `workspace_snapshot` is: the archive is a SECOND on-disk copy of
/// captured terminal output, so turning session restore off has to stop it
/// growing immediately, not at the next launch.
fn writes_allowed(app: &tauri::AppHandle<Wry>) -> bool {
    settings::read_bool(app, "restore_sessions_on_start", true)
        && settings::read_bool(app, "archive_enabled", true)
}

#[tauri::command]
pub fn archive_list(
    db: State<'_, DbState>,
    limit: u32,
    offset: u32,
) -> Result<Vec<archive::ArchiveSummary>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::list(&conn, limit.clamp(1, MAX_LIST), offset)
}

#[tauri::command]
pub fn archive_get(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Option<archive::ArchiveDetail>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::get(&conn, &session_id)
}

#[tauri::command]
pub fn archive_scrollback(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::scrollback(&conn, &session_id)
}

/// The model's own transcript, to hand straight back to `agent_start`.
///
/// The frontend must treat this array as OPAQUE: never reorder it, never edit a
/// `content`, and above all never drop an element — dropping an assistant turn
/// that carries `tool_calls` orphans its tool result, which Anthropic answers
/// with a 400. All trimming happens in Rust.
#[tauri::command]
pub fn archive_transcript(
    db: State<'_, DbState>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::transcript(&conn, &session_id)
}

#[tauri::command]
pub fn archive_put(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    session: archive::ArchiveSessionInput,
) -> Result<(), String> {
    archive_put_many(app, db, vec![session])
}

#[tauri::command]
pub fn archive_put_many(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    sessions: Vec<archive::ArchiveSessionInput>,
) -> Result<(), String> {
    if !writes_allowed(&app) {
        return Ok(());
    }
    let mut sessions = sessions;
    sessions.truncate(MAX_BATCH);
    if settings::read_u32(&app, "restore_scrollback_lines", 1000) == 0 {
        // Scrollback capture is off. Drop any payload rather than trusting the
        // frontend to have checked, and blank what is already stored — the same
        // belt-and-braces as workspace_snapshot.
        for s in &mut sessions {
            s.scrollback = Some(String::new());
            s.scrollback_lines = Some(0);
        }
    }
    let retention = retention(&app);
    let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
    archive::put_many(&mut conn, &sessions, retention)
}

// Each of the three removal paths below also drops the session's attachment
// FILES. `ON DELETE CASCADE` clears the `archived_attachments` rows, but the bytes
// live under <app_data>/attachments/ — nothing in SQLite can reach them, so a
// missing call here is a permanent disk leak rather than a visible bug.
// Best-effort by design: failing the user's delete because a file was already gone
// would be worse than the leak.

#[tauri::command]
pub fn archive_delete(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    session_id: String,
) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::delete(&conn, &session_id)?;
    }
    crate::commands::attachments::remove_session_attachments(&app, &session_id);
    Ok(())
}

#[tauri::command]
pub fn archive_clear(app: tauri::AppHandle<Wry>, db: State<'_, DbState>) -> Result<(), String> {
    {
        let conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::clear(&conn)?;
    }
    // Everything went, so the whole tree goes rather than one dir per session.
    if let Ok(root) = crate::commands::attachments::attachments_root(&app) {
        let _ = std::fs::remove_dir_all(root);
    }
    Ok(())
}

/// Returns how many rows went, so Settings can say what it removed.
#[tauri::command]
pub fn archive_prune(app: tauri::AppHandle<Wry>, db: State<'_, DbState>) -> Result<u32, String> {
    let retention = retention(&app);
    let removed = {
        let conn = db.0.lock().map_err(|_| "db poisoned")?;
        archive::prune(&conn, retention)?
    };
    for session_id in &removed {
        crate::commands::attachments::remove_session_attachments(&app, session_id);
    }
    Ok(removed.len() as u32)
}
