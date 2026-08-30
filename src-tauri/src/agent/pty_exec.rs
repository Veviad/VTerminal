use tauri::ipc::Channel;

use super::exec::ExecResult;
use super::{AgentTargetRole, OutputPolicy, PtyExecState, StreamEvent};

/// Slack added to the frontend's own timeout before the backend gives up.
///
/// The frontend owns the timeout decision (it is the only side that can see the
/// terminal). If both used the same budget the backend could drop the oneshot
/// microseconds before the frontend's result arrived, turning a completed
/// command into a lost one.
// The webview has a 15-second absolute reporting grace beyond its logical
// command deadline. Keep another 15 seconds for the result to cross IPC, so the
// backend watchdog can never win the normal frontend settlement race.
const BACKEND_GRACE_SECS: u64 = 30;
const FRONTEND_TIMEOUT: &str = "frontend_timeout";
const COMPLETION_UNKNOWN_OUTPUT: &str = "[Completion unknown: the frontend did not report a terminal completion pulse or interrupt result before its deadline.]";

fn frontend_timeout_result(duration_ms: u64) -> ExecResult {
    ExecResult {
        exit_code: -1,
        duration_ms,
        output_tail: COMPLETION_UNKNOWN_OUTPUT.to_string(),
        timed_out: true,
        // The foreground process is unknown. Fence the agent before it can
        // propose another command against the same terminal.
        cancelled: true,
    }
}

fn result_flags(error: Option<&str>, exit_code: Option<i32>) -> (bool, bool) {
    match error {
        // A PTY observation timeout does not kill the foreground command. Its
        // literal timeout flag is preserved, and the agent is fenced because
        // terminal ownership is now unknown.
        Some("timeout" | "frontend_timeout") => (true, true),
        // The terminal may still be occupied. Ending the loop prevents a second
        // command from being proposed against an unknown foreground process.
        Some("interrupt_failed" | "command_not_observed" | "terminal_closed") => (false, true),
        Some("interrupted") if exit_code.is_none() => (false, true),
        Some("cancelled") => (false, true),
        // These fail before a command is dispatched, so the Agent can rewrite
        // or wait without treating the terminal as an unknown foreground job.
        Some("terminal_busy" | "unsafe_command" | "not_a_shell" | "target_changed") => {
            (false, false)
        }
        // A confirmed completion after SIGINT is an ordinary interrupted step.
        Some("interrupted") => (false, false),
        // Future or malformed machine codes are conservative by default. If no
        // explicit safe mapping exists, do not dispatch another terminal step.
        Some(_) => (false, true),
        None if exit_code.is_none() => (false, true),
        None => (false, false),
    }
}

/// Runs an approved command in the user's VISIBLE terminal by asking the
/// frontend to type it, then waiting for the observed result.
///
/// Unlike `exec::run_command`, nothing is spawned here: the command runs in
/// whatever shell the user's selected tab is currently in — including a remote
/// host reached over ssh. That is the entire point; it also means we cannot
/// kill it, so a timeout reports completion as unknown rather than pretending
/// the command is still running or has been cleaned up.
pub async fn run_in_terminal(
    session_id: &str,
    target_role: Option<AgentTargetRole>,
    command: &str,
    explanation: &str,
    approval_id: &str,
    request_id: &str,
    timeout_secs: u64,
    output_policy: OutputPolicy,
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
        output_policy,
        target_role,
        target_session_id: target_role.map(|_| session_id.to_string()),
    });

    let outcome = tokio::select! {
        r = rx => r.map_err(|_| FRONTEND_TIMEOUT.to_string()),
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
            Err(FRONTEND_TIMEOUT.to_string())
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(
            timeout_secs.saturating_add(BACKEND_GRACE_SECS),
        )) => {
            pty_exec.drain_for_request(request_id);
            Err(FRONTEND_TIMEOUT.to_string())
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;
    let result = match outcome {
        Ok(r) => r,
        Err(_) => {
            let _ = on_event.send(StreamEvent::CommandResult {
                approval_id: approval_id.to_string(),
                exit_code: None,
                duration_ms,
                error: Some(FRONTEND_TIMEOUT.to_string()),
                target_role,
                target_session_id: target_role.map(|_| session_id.to_string()),
            });
            return Ok(frontend_timeout_result(duration_ms));
        }
    };

    let (timed_out, cancelled) = result_flags(result.error.as_deref(), result.exit_code);
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
        cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        frontend_timeout_result, result_flags, BACKEND_GRACE_SECS, COMPLETION_UNKNOWN_OUTPUT,
    };

    #[test]
    fn interrupt_failure_is_unknown_and_stops_the_agent_loop() {
        assert_eq!(result_flags(Some("interrupt_failed"), None), (false, true));
        assert_eq!(result_flags(Some("timeout"), None), (true, true));
        assert_eq!(result_flags(Some("frontend_timeout"), None), (true, true));
        assert_eq!(
            result_flags(Some("command_not_observed"), None),
            (false, true)
        );
        assert_eq!(result_flags(Some("terminal_closed"), None), (false, true));
        assert_eq!(result_flags(None, None), (false, true));
        assert_eq!(result_flags(Some("interrupted"), None), (false, true));
        assert_eq!(result_flags(Some("interrupted"), Some(130)), (false, false));
        for error in [
            "terminal_busy",
            "unsafe_command",
            "not_a_shell",
            "target_changed",
        ] {
            assert_eq!(result_flags(Some(error), None), (false, false), "{error}");
        }
        assert_eq!(result_flags(Some("future_error"), None), (false, true));
        assert_eq!(result_flags(Some("cancelled"), None), (false, true));
    }

    #[test]
    fn missing_frontend_result_is_completion_unknown_and_fenced() {
        let result = frontend_timeout_result(42);
        assert_eq!(result.exit_code, -1);
        assert_eq!(result.duration_ms, 42);
        assert_eq!(result.output_tail, COMPLETION_UNKNOWN_OUTPUT);
        assert!(result.timed_out);
        assert!(result.cancelled);
        assert_eq!(BACKEND_GRACE_SECS, 30);
    }
}
