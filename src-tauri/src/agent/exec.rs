use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;

use super::StreamEvent;

/// Cap on bytes streamed to the UI per command (the panel is not a terminal).
const UI_STREAM_CAP: usize = 65_536;
/// Tail kept for the model's tool result.
const MODEL_TAIL: usize = 8_192;
/// Bounded read size — also bounds a single CommandOutput chunk.
const CHUNK: usize = 8_192;

pub struct ExecResult {
    pub exit_code: i32,
    pub duration_ms: u64,
    /// Combined stdout+stderr tail (model-facing).
    pub output_tail: String,
    pub timed_out: bool,
    pub cancelled: bool,
}

/// Runs an approved agent command as a captured subprocess through a LOGIN
/// shell (`-lc`) — the GUI app's own environment has a bare PATH, the login
/// shell restores Homebrew/user paths. Never touches the user's PTY.
///
/// The shell gets its own PROCESS GROUP so timeout/cancel kill the whole
/// pipeline (zsh exec-optimizes `cmd >/dev/null`, and pipelines fork children
/// that would otherwise survive a kill of the shell alone). Reads are raw
/// bounded chunks (binary-safe, lossy-decoded) — line readers error on
/// non-UTF-8 and buffer newline-less output without bound.
pub async fn run_command(
    shell: &str,
    cwd: Option<&str>,
    command: &str,
    approval_id: &str,
    timeout_secs: u64,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    on_event: &Channel<StreamEvent>,
) -> Result<ExecResult, String> {
    let started = std::time::Instant::now();

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut command_builder = tokio::process::Command::new(shell);
        command_builder.args(["-lc", command]);
        command_builder
    };
    #[cfg(target_os = "windows")]
    let cmd = {
        let _ = shell;
        // A unique inherited tag lets cancellation and normal completion find
        // descendants which detached from wsl.exe (for example via nohup).
        // `setsid --wait` gives the captured command its own Linux session;
        // unlike the interactive ConPTY path this command has no controlling
        // terminal, so `--ctty` is deliberately omitted.
        let session_tag = format!("vt-agent-{}", uuid::Uuid::new_v4());
        let mut command_builder = tokio::process::Command::new("wsl.exe");
        command_builder.args([
            "--cd",
            cwd.filter(|dir| !dir.is_empty()).unwrap_or("~"),
            "--exec",
            "/usr/bin/setsid",
            "--wait",
            "/usr/bin/env",
            &format!("VTERMINAL_SESSION_ID={session_tag}"),
            "/bin/bash",
            "-lc",
            command,
        ]);
        (command_builder, session_tag)
    };
    #[cfg(target_os = "windows")]
    let wsl_session_tag = cmd.1;
    #[cfg(target_os = "windows")]
    let mut cmd = cmd.0;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(not(target_os = "windows"))]
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let process_id = child.id();

    let kill_tree = |process_id: Option<u32>| {
        #[cfg(unix)]
        if let Some(pgid) = process_id.map(|pid| pid as i32) {
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
        #[cfg(target_os = "windows")]
        if let Some(pid) = process_id {
            if !crate::pty::session::cleanup_wsl_session(&wsl_session_tag) {
                // taskkill can only prove termination of the host-side wsl.exe
                // tree. It remains a last-resort aid; the post-wait tag check
                // below is the Linux-side authority.
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    };

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let mut out_buf = vec![0u8; CHUNK];
    let mut err_buf = vec![0u8; CHUNK];

    let mut tail = String::new();
    let mut ui_sent = 0usize;
    let mut ui_truncated = false;
    let mut out_open = true;
    let mut err_open = true;
    let mut timed_out = false;
    let mut cancelled = false;

    let timeout = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs.max(1)));
    tokio::pin!(timeout);

    let push = |bytes: &[u8],
                is_stderr: bool,
                ui_sent: &mut usize,
                ui_truncated: &mut bool,
                tail: &mut String| {
        let text = String::from_utf8_lossy(bytes).into_owned();
        tail.push_str(&text);
        if tail.len() > MODEL_TAIL * 2 {
            let mut cut = tail.len() - MODEL_TAIL;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            *tail = tail[cut..].to_string();
        }
        if *ui_sent < UI_STREAM_CAP {
            *ui_sent += text.len();
            let _ = on_event.send(StreamEvent::CommandOutput {
                approval_id: approval_id.to_string(),
                chunk: text,
                is_stderr,
            });
        } else if !*ui_truncated {
            *ui_truncated = true;
            let _ = on_event.send(StreamEvent::CommandOutput {
                approval_id: approval_id.to_string(),
                chunk: "\n[output truncated in view — full tail goes to the model]\n".into(),
                is_stderr: false,
            });
        }
    };

    // Stream chunks until both pipes close; timeout/cancel kill the group.
    while out_open || err_open {
        tokio::select! {
            n = stdout.read(&mut out_buf), if out_open => match n {
                Ok(0) | Err(_) => out_open = false,
                Ok(n) => push(&out_buf[..n], false, &mut ui_sent, &mut ui_truncated, &mut tail),
            },
            n = stderr.read(&mut err_buf), if err_open => match n {
                Ok(0) | Err(_) => err_open = false,
                Ok(n) => push(&err_buf[..n], true, &mut ui_sent, &mut ui_truncated, &mut tail),
            },
            _ = &mut timeout => {
                timed_out = true;
                kill_tree(process_id);
                break;
            }
            _ = cancel.changed() => {
                if *cancel.borrow() {
                    cancelled = true;
                    kill_tree(process_id);
                    break;
                }
            }
        }
    }

    // Guarded reap: pipes at EOF do NOT imply the command exited (zsh
    // exec-optimizes `cmd >/dev/null 2>&1`, daemons close their fds) — the
    // same total timeout/cancel budget must cover the wait too.
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|e| format!("wait failed: {e}"))?,
            _ = &mut timeout, if !timed_out && !cancelled => {
                timed_out = true;
                kill_tree(process_id);
            }
            _ = cancel.changed(), if !timed_out && !cancelled => {
                if *cancel.borrow() {
                    cancelled = true;
                    kill_tree(process_id);
                }
            }
        }
    };

    #[cfg(target_os = "windows")]
    if !crate::pty::session::cleanup_wsl_session(&wsl_session_tag) {
        return Err("could not verify cleanup of the WSL agent process tree".into());
    }

    let exit_code = if timed_out || cancelled {
        status.code().unwrap_or(124)
    } else {
        status.code().unwrap_or(-1)
    };
    let duration_ms = started.elapsed().as_millis() as u64;

    if timed_out {
        tail.push_str(&format!(
            "\n[command timed out after {timeout_secs}s and was killed]\n"
        ));
    }

    let _ = on_event.send(StreamEvent::CommandResult {
        approval_id: approval_id.to_string(),
        exit_code: Some(exit_code),
        duration_ms,
        error: None,
        target_role: None,
        target_session_id: None,
    });

    Ok(ExecResult {
        exit_code,
        duration_ms,
        output_tail: tail,
        timed_out,
        cancelled,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tauri::ipc::{Channel, InvokeResponseBody};

    fn null_channel() -> Channel<StreamEvent> {
        Channel::new(|_: InvokeResponseBody| Ok(()))
    }

    fn no_cancel() -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        std::mem::forget(tx); // keep the channel alive for the test's duration
        rx
    }

    #[tokio::test]
    async fn captures_output_and_exit_zero() {
        let r = run_command(
            "/bin/zsh",
            None,
            "echo hello-exec",
            "a1",
            30,
            no_cancel(),
            &null_channel(),
        )
        .await
        .unwrap();
        assert_eq!(r.exit_code, 0);
        assert!(r.output_tail.contains("hello-exec"));
        assert!(!r.timed_out);
    }

    #[tokio::test]
    async fn reports_nonzero_exit() {
        let r = run_command(
            "/bin/zsh",
            None,
            "exit 3",
            "a2",
            30,
            no_cancel(),
            &null_channel(),
        )
        .await
        .unwrap();
        assert_eq!(r.exit_code, 3);
    }

    #[tokio::test]
    async fn kills_on_timeout() {
        let started = std::time::Instant::now();
        let r = run_command(
            "/bin/zsh",
            None,
            "sleep 60",
            "a3",
            1,
            no_cancel(),
            &null_channel(),
        )
        .await
        .unwrap();
        assert!(r.timed_out);
        assert!(started.elapsed().as_secs() < 10);
        assert!(r.output_tail.contains("timed out"));
    }

    /// The critical case: zsh exec-optimizes redirected commands, so both
    /// pipes hit EOF instantly while the command keeps running — the reap
    /// after the read loop must still honor the timeout.
    #[tokio::test]
    async fn timeout_covers_wait_after_pipe_eof() {
        let started = std::time::Instant::now();
        let r = run_command(
            "/bin/zsh",
            None,
            "sleep 60 >/dev/null 2>&1",
            "a3b",
            1,
            no_cancel(),
            &null_channel(),
        )
        .await
        .unwrap();
        assert!(r.timed_out);
        assert!(
            started.elapsed().as_secs() < 10,
            "wait() must not block past the timeout"
        );
    }

    #[tokio::test]
    async fn kills_on_cancel() {
        let (tx, rx) = tokio::sync::watch::channel(false);
        let handle = tokio::spawn(async move {
            run_command("/bin/zsh", None, "sleep 60", "a4", 120, rx, &null_channel()).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let _ = tx.send(true);
        let r = handle.await.unwrap().unwrap();
        assert!(r.cancelled);
    }

    #[tokio::test]
    async fn binary_output_is_handled() {
        let r = run_command(
            "/bin/zsh",
            None,
            "head -c 200000 /dev/urandom",
            "a6",
            30,
            no_cancel(),
            &null_channel(),
        )
        .await
        .unwrap();
        assert_eq!(
            r.exit_code, 0,
            "binary output must not wedge or error the reader"
        );
        assert!(!r.timed_out);
    }

    #[tokio::test]
    async fn respects_cwd() {
        let r = run_command(
            "/bin/zsh",
            Some("/tmp"),
            "pwd",
            "a5",
            30,
            no_cancel(),
            &null_channel(),
        )
        .await
        .unwrap();
        assert!(r.output_tail.contains("/tmp"));
    }
}
