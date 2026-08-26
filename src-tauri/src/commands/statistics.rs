use tauri::State;

use crate::database::{statistics, DbState};

#[tauri::command]
pub fn token_statistics(db: State<'_, DbState>) -> Result<statistics::TokenStatistics, String> {
    let conn = db.0.lock().map_err(|_| "db poisoned")?;
    statistics::get(&conn)
}
