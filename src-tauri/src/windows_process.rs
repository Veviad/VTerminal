//! Background subprocesses must never allocate a visible Windows console.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::process::{Child, Command, Output};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &mut command;
    command
}

pub fn background_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    tokio::process::Command::from(background_command(program))
}

// Keep diagnostic memory bounded while continuing to drain larger pipe output.
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

fn drain(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<io::Result<Vec<u8>>> {
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (|| {
            let mut captured = Vec::new();
            let mut chunk = [0; 8192];
            loop {
                let count = pipe.read(&mut chunk)?;
                if count == 0 {
                    return Ok(captured);
                }
                let retain = count.min(MAX_CAPTURE_BYTES.saturating_sub(captured.len()));
                captured.extend_from_slice(&chunk[..retain]);
            }
        })();
        let _ = send.send(result);
    });
    receive
}

fn timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "background command timed out")
}

fn terminate(mut child: Child) {
    let _ = child.kill();
    // Do not turn a failed kill or delayed process teardown into an unbounded
    // wait on the caller. The reaper owns the handle until the process exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// The caller supplies one deadline for its complete multi-command operation.
/// Stdin must be null or supplied by the caller without a blocking pipe write.
pub fn command_output_until(command: &mut Command, deadline: Instant) -> io::Result<Output> {
    if Instant::now() >= deadline {
        return Err(timeout_error());
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(
                    Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            Ok(None) => {
                terminate(child);
                return Err(timeout_error());
            }
            Err(error) => {
                terminate(child);
                return Err(error);
            }
        }
    };
    let receive = |pipe: Option<mpsc::Receiver<io::Result<Vec<u8>>>>| {
        let Some(pipe) = pipe else {
            return Ok(Vec::new());
        };
        pipe.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => timeout_error(),
                mpsc::RecvTimeoutError::Disconnected => {
                    io::Error::other("background command output reader stopped")
                }
            })?
    };
    Ok(Output {
        status,
        stdout: receive(stdout)?,
        stderr: receive(stderr)?,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn drains_large_output_without_unbounded_capture() {
        let mut command = background_command("/bin/sh");
        command
            .args(["-c", "dd if=/dev/zero bs=1048576 count=8 2>/dev/null"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output =
            command_output_until(&mut command, Instant::now() + Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), MAX_CAPTURE_BYTES);
    }

    #[test]
    fn shared_deadline_prevents_a_second_command_from_starting() {
        let mut command = background_command("/path/that/does/not/exist");
        let error = command_output_until(&mut command, Instant::now()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn inherited_output_cannot_extend_the_deadline() {
        let mut command = background_command("/bin/sh");
        command
            .args(["-c", "sleep 1 & exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();
        let error =
            command_output_until(&mut command, started + Duration::from_millis(40)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Stdio;

    // Query the child process itself. Inspecting command flags alone would
    // miss a regression where the flags were lost before process creation.
    const CONSOLE_PROBE: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class VTerminalConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
[Console]::Out.WriteLine([VTerminalConsoleProbe]::GetConsoleWindow().ToInt64())
"#;

    fn powershell() -> PathBuf {
        PathBuf::from(std::env::var_os("SystemRoot").expect("Windows provides SystemRoot"))
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    }

    fn assert_no_console(output: Output) {
        assert!(
            output.status.success(),
            "console probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    #[test]
    fn standard_background_child_has_no_console_window() {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut command = background_command(powershell());
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", CONSOLE_PROBE])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        assert_no_console(
            command_output_until(&mut command, deadline)
                .expect("the Windows console probe must finish within 10 seconds"),
        );
    }

    #[tokio::test]
    async fn tokio_background_child_has_no_console_window() {
        let mut command = background_tokio_command(powershell());
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", CONSOLE_PROBE])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        assert_no_console(
            tokio::time::timeout(Duration::from_secs(10), command.output())
                .await
                .expect("the Windows console probe must finish within 10 seconds")
                .expect("start the Windows console probe"),
        );
    }
}
