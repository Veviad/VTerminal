use tauri::ipc::Channel;

use super::exec::ExecResult;
use super::{AgentTargetRole, PtyExecState, StreamEvent};

/// Slack added to the frontend's own timeout before the backend gives up.
///
/// The frontend owns the timeout decision (it is the only side that can see the
/// terminal). If both used the same budget the backend could drop the oneshot
/// microseconds before the frontend's result arrived, turning a completed
/// command into a lost one.
const BACKEND_GRACE_SECS: u64 = 15;

/// Runs an approved command in the user's VISIBLE terminal by asking the
/// frontend to type it, then waiting for the observed result.
///
/// Unlike `exec::run_command`, nothing is spawned here: the command runs in
/// whatever shell the user's selected tab is currently in — including a remote
/// host reached over ssh. That is the entire point; it also means we cannot
/// kill it, so a timeout reports "still running" rather than pretending to
/// have cleaned up.
pub async fn run_in_terminal(
    session_id: &str,
    target_role: Option<AgentTargetRole>,
    command: &str,
    explanation: &str,
    approval_id: &str,
    request_id: &str,
    timeout_secs: u64,
    pty_exec: &PtyExecState,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    on_event: &Channel<StreamEvent>,
) -> Result<ExecResult, String> {
    let started = std::time::Instant::now();
    let rx = pty_exec.register(approval_id, request_id);

    let _ = on_event.send(StreamEvent::RunInTerminal {
        approval_id: approval_id.to_string(),
        session_id: session_id.to_string(),
        command: command.to_string(),
        timeout_secs,
        explanation: explanation.to_string(),
        target_role,
        target_session_id: target_role.map(|_| session_id.to_string()),
    });

    let outcome = tokio::select! {
        r = rx => r.map_err(|_| "terminal command was abandoned".to_string()),
        _ = cancel.changed() => {
            if *cancel.borrow() {
                pty_exec.drain_for_request(request_id);
                return Ok(ExecResult {
                    exit_code: -1,
                    duration_ms: started.elapsed().as_millis() as u64,
                    output_tail: String::new(),
                    timed_out: false,
                    cancelled: true,
                });
            }
            Err("cancel channel closed".to_string())
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(
            timeout_secs.saturating_add(BACKEND_GRACE_SECS),
        )) => {
            pty_exec.drain_for_request(request_id);
            Err("the terminal never reported back".to_string())
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    let result = match outcome {
        Ok(r) => r,
        Err(message) => {
            let _ = on_event.send(StreamEvent::CommandResult {
                approval_id: approval_id.to_string(),
                exit_code: None,
                duration_ms,
                error: Some(message.clone()),
                target_role,
                target_session_id: target_role.map(|_| session_id.to_string()),
            });
            return Ok(ExecResult {
                exit_code: -1,
                duration_ms,
                output_tail: format!("[{message}]"),
                timed_out: true,
                cancelled: false,
            });
        }
    };

    let timed_out = result.error.as_deref() == Some("timeout");
    let _ = on_event.send(StreamEvent::CommandResult {
        approval_id: approval_id.to_string(),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        error: result.error.clone(),
        target_role,
        target_session_id: target_role.map(|_| session_id.to_string()),
    });

    Ok(ExecResult {
        // The model-facing tool result prints this; -1 reads as "unknown", and
        // the note in output_tail explains why.
        exit_code: result.exit_code.unwrap_or(-1),
        duration_ms: result.duration_ms,
        output_tail: result.output_tail,
        timed_out,
        cancelled: result.error.as_deref() == Some("cancelled"),
    })
}
