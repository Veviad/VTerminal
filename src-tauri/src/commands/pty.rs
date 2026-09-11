use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, Wry};

use crate::commands::settings;
#[cfg(not(target_os = "windows"))]
use crate::commands::shell_integration;
use crate::pty::{session, PtyEvent, PtyManager};

/// On macOS, `shell` is a per-tab override and cwd is host-validated. On
/// Windows the backend is fixed to the default WSL2 distro and Bash; cwd is a
/// Linux path passed as a separate `wsl.exe --cd` argument.
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle<Wry>,
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
    // Reserve the ID before any await or worker queue. Closing a pending tab
    // cancels this owned permit, so delayed preparation cannot create an orphan.
    let permit = app.state::<PtyManager>().begin_spawn(session_id.clone())?;
    #[cfg(target_os = "windows")]
    {
        let prepared =
            crate::windows_terminal::prepare_for_integration(&app, integration_enabled, false)
                .await;
        if prepared.wsl_status != settings::WslStatus::Ready {
            return Err(prepared
                .message
                .unwrap_or_else(|| "WSL terminal preparation is unavailable".into()));
        }
    }

    // All filesystem, WSL and ConPTY work stays off the IPC/event-loop thread.
    // The closure retains the app and the owned admission permit, which covers
    // preparation and OS creation through insertion even
    // if the invoking frontend stops waiting for this command.
    tokio::task::spawn_blocking(move || {
        let state = app.state::<PtyManager>();
        permit.check_active()?;
        #[cfg(not(target_os = "windows"))]
        let zdotdir = if integration_enabled {
            Some(shell_integration::ensure_zdotdir(&app)?)
        } else {
            None
        };
        #[cfg(target_os = "windows")]
        let zdotdir = None;
        permit.check_active()?;
        let spawned = session::spawn(
            session::SpawnParams {
                session_id,
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
        let pid = permit.insert(&state, spawned)?;
        let _ = on_event.send(PtyEvent::Spawned { pid });
        Ok(pid)
    })
    .await
    .map_err(|error| format!("terminal creation stopped: {error}"))?
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
