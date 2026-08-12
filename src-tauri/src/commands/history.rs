use tauri::{State, Wry};

use crate::commands::settings;
use crate::database::{queries, DbState};

#[tauri::command]
pub fn history_record(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    entry: queries::HistoryEntryInput,
) -> Result<String, String> {
    if !settings::read_bool(&app, "history_enabled", true) {
        return Ok(String::new());
    }
    let mut entry = entry;
    if !settings::read_bool(&app, "history_capture_output", true) {
        entry.output_tail = None;
    }
    let shell = settings::read_string(&app, "shell_path").unwrap_or_else(|| "zsh".into());
    let shell_name = shell.rsplit('/').next().unwrap_or("zsh").to_string();
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::insert_history(&conn, &entry, &shell_name)
}

#[tauri::command]
pub fn history_recent(db: State<'_, DbState>, limit: u32) -> Result<Vec<queries::HistoryEntry>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::recent_history(&conn, limit.clamp(1, 500))
}

#[tauri::command]
pub fn history_search(
    db: State<'_, DbState>,
    query: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<queries::HistoryEntry>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::search_history(&conn, &query, limit.clamp(1, 500), offset)
}

#[tauri::command]
pub fn history_clear(db: State<'_, DbState>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    queries::clear_history(&conn)
}
