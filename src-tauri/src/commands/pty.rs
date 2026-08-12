use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, Wry};

use crate::commands::settings;
use crate::commands::shell_integration;
use crate::pty::{session, PtyEvent, PtyManager};

/// `shell` is a per-tab override; it falls back to the `shell_path` setting and
/// then to /bin/zsh. `cwd` is validated by `session::resolve_cwd` — a stale or
/// deleted directory falls back to $HOME rather than failing the spawn.
#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle<Wry>,
    state: State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    {
        let sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
        if sessions.contains_key(&session_id) {
            return Err(format!("session {session_id} already exists"));
        }
    }

    let shell_path = shell
        .filter(|s| !s.trim().is_empty())
        .or_else(|| settings::read_string(&app, "shell_path"));
    let integration_enabled = settings::read_bool(&app, "shell_integration_enabled", true);
    let zdotdir = if integration_enabled {
        shell_integration::ensure_zdotdir(&app).ok()
    } else {
        None
    };

    let spawned = session::spawn(
        session::SpawnParams {
            session_id: session_id.clone(),
            cols,
            rows,
            cwd,
            shell_path,
            zdotdir,
        },
        on_data,
        on_event.clone(),
    )?;

    let pid = spawned.pid;
    let _ = on_event.send(PtyEvent::Spawned { pid });

    // The wait thread reports Exit to the frontend; the map entry is cleaned up
    // when the frontend calls pty_kill (or on app exit).
    let mut sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    sessions.insert(session_id, spawned);
    Ok(pid)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    session.write(&data)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    session.resize(cols, rows)
}

#[tauri::command]
pub fn pty_ack(state: State<'_, PtyManager>, session_id: String, bytes: u64) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "pty state poisoned")?;
    if let Some(session) = sessions.get(&session_id) {
        session.flow.ack(bytes);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    let session = state
        .remove(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    session.kill();
    Ok(())
}

#[tauri::command]
pub fn pty_list(state: State<'_, PtyManager>) -> Result<Vec<String>, String> {
    Ok(state.list())
}
