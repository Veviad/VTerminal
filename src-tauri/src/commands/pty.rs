use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, Wry};

use crate::commands::settings;
use crate::commands::shell_integration;
use crate::pty::{session, PtyEvent, PtyManager};

/// On macOS, `shell` is a per-tab override and cwd is host-validated. On
/// Windows the backend is fixed to the default WSL2 distro and Bash; cwd is a
/// Linux path passed as a separate `wsl.exe --cd` argument.
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
    let shell_path = shell
        .filter(|s| !s.trim().is_empty())
        .or_else(|| settings::read_string(&app, "shell_path"));
    let integration_enabled = settings::read_bool(&app, "shell_integration_enabled", true);
    #[cfg(not(target_os = "windows"))]
    let zdotdir = if integration_enabled {
        Some(shell_integration::ensure_zdotdir(&app)?)
    } else {
        None
    };
    #[cfg(target_os = "windows")]
    let zdotdir = {
        if integration_enabled {
            shell_integration::ensure_wsl_bash_integration()?;
        }
        None
    };

    // Hold an admission permit across OS process creation. Verified shutdown
    // closes this gate and waits for every racing spawn before killing PTYs.
    let permit = state.begin_spawn(session_id.clone())?;
    let spawned = session::spawn(
        session::SpawnParams {
            session_id: session_id.clone(),
            cols,
            rows,
            cwd,
            shell_path,
            zdotdir,
            integration_enabled,
        },
        on_data,
        on_event.clone(),
    )?;

    let pid = permit.insert(spawned)?;
    let _ = on_event.send(PtyEvent::Spawned { pid });
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
    state.kill_session_verified(&session_id)
}

#[tauri::command]
pub fn pty_list(state: State<'_, PtyManager>) -> Result<Vec<String>, String> {
    Ok(state.list())
}
