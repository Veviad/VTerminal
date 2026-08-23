use tauri::{State, Wry};

use crate::database::{chat, DbState};

#[tauri::command]
pub fn chat_list(db: State<'_, DbState>) -> Result<Vec<chat::ChatSummary>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    chat::list(&conn)
}

#[tauri::command]
pub fn chat_get(
    db: State<'_, DbState>,
    chat_id: String,
) -> Result<Option<chat::ChatDetail>, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    chat::get(&conn, &chat_id)
}

#[tauri::command]
pub fn chat_save(db: State<'_, DbState>, chat: chat::ChatSaveInput) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
    crate::database::chat::save(&mut conn, &chat)
}

#[tauri::command]
pub fn chat_set_archived(
    db: State<'_, DbState>,
    chat_id: String,
    archived_at: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    chat::set_archived(&conn, &chat_id, archived_at.as_deref())
}

#[tauri::command]
pub fn chat_update_title(
    db: State<'_, DbState>,
    chat_id: String,
    title: String,
    source: String,
    expected_title: Option<String>,
) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    chat::update_title(&conn, &chat_id, &title, &source, expected_title.as_deref())
}

#[tauri::command]
pub fn chat_delete(
    app: tauri::AppHandle<Wry>,
    db: State<'_, DbState>,
    chat_id: String,
) -> Result<(), String> {
    let removed = {
        let mut conn = db.0.lock().map_err(|_| "db poisoned")?;
        chat::delete(&mut conn, &chat_id)?
    };
    crate::commands::attachments::remove_chat_attachments(&app, &removed.attachment_paths);
    Ok(())
}
