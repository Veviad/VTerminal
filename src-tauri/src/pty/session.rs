use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
#[cfg(target_os = "windows")]
use std::io::Read;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

use super::PtyEvent;

/// Pause PTY reads above 1 MB of un-acked bytes in the webview...
pub const HIGH_WATERMARK: u64 = 1_048_576;
/// ...resume once the frontend has processed back down to 256 KB.
pub const LOW_WATERMARK: u64 = 262_144;

const READ_BUF_SIZE: usize = 65_536;
#[cfg(unix)]
const POLL_INTERVAL_MS: i32 = 250;

/// Backpressure shared between the reader thread (waits) and the ack command
/// (signals). Prevents `cat bigfile` from OOMing the webview: xterm.write
/// callbacks ack processed bytes; the reader blocks past the high watermark.
pub struct FlowControl {
    outstanding: Mutex<u64>,
    cond: Condvar,
    shutdown: AtomicBool,
}

impl FlowControl {
    fn new() -> Self {
        Self {
            outstanding: Mutex::new(0),
            cond: Condvar::new(),
            shutdown: AtomicBool::new(false),
        }
    }

    /// Blocks while outstanding >= HIGH until it drops to <= LOW or shutdown.
    /// Returns false when shutting down.
    fn wait_until_resumed(&self) -> bool {
        let mut outstanding = match self.outstanding.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        while *outstanding >= HIGH_WATERMARK {
            if self.shutdown.load(Ordering::Relaxed) {
                return false;
            }
            outstanding = match self
                .cond
                .wait_timeout(outstanding, std::time::Duration::from_millis(250))
            {
                Ok((g, _)) => g,
                Err(_) => return false,
            };
            if *outstanding <= LOW_WATERMARK {
                break;
            }
        }
        !self.shutdown.load(Ordering::Relaxed)
    }

    fn add_outstanding(&self, bytes: u64) {
        if let Ok(mut g) = self.outstanding.lock() {
            *g = g.saturating_add(bytes);
        }
    }

    pub fn ack(&self, bytes: u64) {
        if let Ok(mut g) = self.outstanding.lock() {
            *g = g.saturating_sub(bytes);
            if *g <= LOW_WATERMARK {
                self.cond.notify_all();
            }
        }
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.cond.notify_all();
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::Relaxed)
    }
}

pub struct PtySession {
    #[allow(dead_code)] // kept for debugging/logging
    pub id: String,
    pub pid: u32,
    // Field order matters: Rust drops fields in declaration order, and the
    // writer must drop BEFORE the master so the pty tears down cleanly.
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub master: Box<dyn MasterPty + Send>,
    pub child_killer: Box<dyn ChildKiller + Send + Sync>,
    pub flow: Arc<FlowControl>,
    /// Set by the wait thread once the shell has been reaped. Guards kill()
    /// against SIGHUP-ing a recycled pid hours later.
    pub exited: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    wsl_session_tag: String,
}

pub struct SpawnParams {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub shell_path: Option<String>,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub zdotdir: Option<std::path::PathBuf>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub integration_enabled: bool,
}

/// A requested cwd can be a directory that was deleted, renamed, or lives on an
/// unmounted volume — restoring a saved session makes that routine rather than
/// exotic. `cmd.cwd()` on a missing path fails at exec, so validate here and
/// fall back to $HOME instead of handing the caller a dead tab.
///
/// Note the shape: `Option::or_else` fires only on `None`, so `Some(bad_path)`
/// must be filtered out explicitly before the fallback can apply.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub fn resolve_cwd(requested: Option<String>) -> Option<std::path::PathBuf> {
    let requested = requested.filter(|s| !s.trim().is_empty());
    if let Some(path) = requested {
        let path = std::path::PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
        log::warn!("requested cwd {path:?} is not a directory — falling back to $HOME");
    }
    dirs::home_dir()
}

#[cfg(target_os = "windows")]
fn command_succeeds_bounded(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> bool {
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Err(_) => return false,
        }
    }
}

#[cfg(target_os = "windows")]
fn resolve_wsl_cwd(requested: Option<&str>) -> (String, bool) {
    let Some(path) = requested.filter(|path| !path.trim().is_empty()) else {
        return ("~".into(), false);
    };
    let mut probe = std::process::Command::new("wsl.exe");
    probe
        .args(["--cd", path, "--exec", "/bin/true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let valid = command_succeeds_bounded(&mut probe, std::time::Duration::from_secs(10));
    if valid {
        (path.into(), false)
    } else {
        ("~".into(), true)
    }
}

#[cfg(any(target_os = "windows", test))]
fn wsl_command_args(cwd: &str, integration_enabled: bool, session_tag: &str) -> Vec<String> {
    let mut args = vec![
        "--cd".into(),
        cwd.into(),
        "--exec".into(),
        "/usr/bin/setsid".into(),
        "--wait".into(),
        "--ctty".into(),
        "/usr/bin/env".into(),
        "TERM=xterm-256color".into(),
        "COLORTERM=truecolor".into(),
        "TERM_PROGRAM=VTerminal".into(),
        format!("TERM_PROGRAM_VERSION={}", env!("CARGO_PKG_VERSION")),
        format!("VTERMINAL_SESSION_ID={session_tag}"),
    ];
    if integration_enabled {
        args.extend([
            "/bin/sh".into(),
            "-c".into(),
            "exec \"$HOME/.local/share/vterminal/vterminal-bash\"".into(),
        ]);
    } else {
        args.extend(["/bin/bash".into(), "-il".into()]);
    }
    args
}

#[cfg(any(target_os = "windows", test))]
const WSL_SESSION_CLEANUP: &str = r#"tag=$1

tagged_pids() {
  local env_file pid
  for env_file in /proc/[0-9]*/environ; do
    [[ -r "$env_file" ]] || continue
    if grep -z -F -x -q -- "VTERMINAL_SESSION_ID=$tag" "$env_file" 2>/dev/null; then
      pid=${env_file#/proc/}
      printf '%s\n' "${pid%/environ}"
    fi
  done
}

discover_session_ids() {
  local pid sid
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    sid=$(ps -o sid= -p "$pid" 2>/dev/null)
    sid=${sid//[[:space:]]/}
    [[ "$sid" =~ ^[0-9]+$ ]] && printf '%s\n' "$sid"
  done < <(tagged_pids)
}

session_pids() {
  local sid
  for sid in "${sids[@]}"; do
    ps -eo pid=,sid= | awk -v wanted="$sid" '$2 == wanted { print $1 }'
  done
}

mapfile -t tagged < <(tagged_pids | sort -un)
((${#tagged[@]} == 0)) && exit 0
mapfile -t sids < <(discover_session_ids | sort -un)
((${#sids[@]} == 0)) && exit 1
mapfile -t pids < <(session_pids | sort -un)
((${#pids[@]} == 0)) && exit 1
kill -TERM "${pids[@]}" 2>/dev/null || true
for _ in {1..10}; do
  sleep 0.1
  mapfile -t pids < <(session_pids | sort -un)
  ((${#pids[@]} == 0)) && break
done
if ((${#pids[@]} != 0)); then
  kill -KILL "${pids[@]}" 2>/dev/null || true
fi
for _ in {1..10}; do
  sleep 0.1
  [[ -z "$(session_pids)" && -z "$(tagged_pids)" ]] && exit 0
done
exit 1
"#;

#[cfg(any(target_os = "windows", test))]
fn wsl_cleanup_args(session_tag: &str) -> Vec<String> {
    vec![
        "--exec".into(),
        "/bin/bash".into(),
        "--noprofile".into(),
        "--norc".into(),
        "-c".into(),
        WSL_SESSION_CLEANUP.into(),
        "vterminal-cleanup".into(),
        session_tag.into(),
    ]
}

#[cfg(target_os = "windows")]
pub(crate) fn cleanup_wsl_session(session_tag: &str) -> bool {
    let mut cleanup = std::process::Command::new("wsl.exe");
    cleanup
        .args(wsl_cleanup_args(session_tag))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command_succeeds_bounded(&mut cleanup, std::time::Duration::from_secs(5))
}

pub fn spawn(
    params: SpawnParams,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: params.rows,
            cols: params.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    let shell = params
        .shell_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new(&shell);
    #[cfg(not(target_os = "windows"))]
    cmd.args(["-il"]);

    #[cfg(target_os = "windows")]
    let wsl_session_tag = format!("vt-{}", uuid::Uuid::new_v4());

    // The Windows app is intentionally WSL2/Bash-only. Omitting `-d` selects
    // the user's default distro. `--cd` and the command are separate argv
    // values so restored Linux paths never become shell source text.
    #[cfg(target_os = "windows")]
    let cmd = {
        let mut command = CommandBuilder::new("wsl.exe");
        let (cwd, fell_back) = resolve_wsl_cwd(params.cwd.as_deref());
        if fell_back {
            let _ = on_event.send(PtyEvent::Warning {
                message: "The restored WSL directory no longer exists; opened your WSL home directory instead.".into(),
            });
        }
        command.args(wsl_command_args(
            &cwd,
            params.integration_enabled,
            &wsl_session_tag,
        ));
        command
    };

    #[cfg(not(target_os = "windows"))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "VTerminal");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(zdotdir) = &params.zdotdir {
        // The generated zdotdir chains the user's real .zshenv/.zprofile/.zshrc
        // first (see shell_integration), then layers the OSC hooks on top.
        if shell.ends_with("zsh") {
            let orig = std::env::var("ZDOTDIR").unwrap_or_default();
            cmd.env("VTERMINAL_ORIG_ZDOTDIR", orig);
            cmd.env("ZDOTDIR", zdotdir);
        }
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(cwd) = resolve_cwd(params.cwd.clone()) {
        cmd.cwd(cwd);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    // Drop the slave immediately or the reader never sees EOF.
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let child_killer = child.clone_killer();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {e}"))?;

    // Own dup of the master fd for the Unix reader thread. The reader closes it
    // itself on exit, so there is no use-after-close/fd-reuse race with kill().
    #[cfg(unix)]
    let reader_fd = pair.master.as_raw_fd().ok_or("master pty has no raw fd")?;
    #[cfg(unix)]
    let reader_fd = unsafe { libc::dup(reader_fd) };
    #[cfg(unix)]
    if reader_fd < 0 {
        return Err("dup(master fd) failed".into());
    }

    // ConPTY exposes a cloneable pipe reader rather than a Unix fd. Closing the
    // pseudoconsole/master during PtySession::kill makes this blocking reader
    // return EOF; flow shutdown still wakes a reader paused by backpressure.
    #[cfg(target_os = "windows")]
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone ConPTY reader failed: {e}"))?;

    let flow = Arc::new(FlowControl::new());
    let exited = Arc::new(AtomicBool::new(false));

    // Unix reader pump — poll() with a timeout so the thread
    // also exits on shutdown even when a SIGHUP-immune process (nohup) keeps
    // the slave side open forever; a plain blocking read() would leak the
    // thread and the pty pair in that case.
    #[cfg(unix)]
    {
        let flow = Arc::clone(&flow);
        let session_id = params.session_id.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{session_id}"))
            .spawn(move || {
                let mut buf = [0u8; READ_BUF_SIZE];
                'outer: loop {
                    if !flow.wait_until_resumed() {
                        break;
                    }
                    // Wait for readable data, re-checking shutdown periodically.
                    loop {
                        let mut pfd = libc::pollfd {
                            fd: reader_fd,
                            events: libc::POLLIN,
                            revents: 0,
                        };
                        let rc = unsafe { libc::poll(&mut pfd, 1, POLL_INTERVAL_MS) };
                        if flow.is_shutdown() {
                            break 'outer;
                        }
                        if rc < 0 {
                            let errno = std::io::Error::last_os_error();
                            if errno.kind() == std::io::ErrorKind::Interrupted {
                                continue;
                            }
                            break 'outer;
                        }
                        if rc == 0 {
                            continue; // timeout — poll again
                        }
                        // POLLIN and/or POLLHUP: read() now returns without blocking
                        break;
                    }
                    let n = unsafe {
                        libc::read(
                            reader_fd,
                            buf.as_mut_ptr() as *mut libc::c_void,
                            READ_BUF_SIZE,
                        )
                    };
                    match n {
                        n if n > 0 => {
                            let n = n as usize;
                            flow.add_outstanding(n as u64);
                            if on_data
                                .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        0 => break, // EOF: every slave fd closed
                        _ => {
                            let errno = std::io::Error::last_os_error();
                            if errno.kind() == std::io::ErrorKind::Interrupted {
                                continue;
                            }
                            break;
                        }
                    }
                }
                unsafe { libc::close(reader_fd) };
            })
            .map_err(|e| format!("reader thread spawn failed: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        let flow = Arc::clone(&flow);
        let session_id = params.session_id.clone();
        std::thread::Builder::new()
            .name(format!("pty-read-{session_id}"))
            .spawn(move || {
                let mut buf = [0u8; READ_BUF_SIZE];
                loop {
                    if !flow.wait_until_resumed() {
                        break;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            flow.add_outstanding(n as u64);
                            if on_data
                                .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("ConPTY reader thread spawn failed: {e}"))?;
    }

    // Wait thread — reaps the child, marks it exited, and reports Exit.
    {
        let session_id = params.session_id.clone();
        let exited = Arc::clone(&exited);
        std::thread::Builder::new()
            .name(format!("pty-wait-{session_id}"))
            .spawn(move || {
                let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
                exited.store(true, Ordering::Relaxed);
                let _ = on_event.send(PtyEvent::Exit { exit_code });
            })
            .map_err(|e| format!("wait thread spawn failed: {e}"))?;
    }

    Ok(PtySession {
        id: params.session_id,
        pid,
        writer: Mutex::new(writer),
        master: pair.master,
        child_killer,
        flow,
        exited,
        #[cfg(target_os = "windows")]
        wsl_session_tag,
    })
}

impl PtySession {
    pub fn write(&self, data: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|_| "writer poisoned")?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("pty write failed: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {e}"))
    }

    /// Kill order: shutdown flag (stops the reader within one poll interval) →
    /// SIGHUP the shell ONLY if it is still alive (the wait thread reaps it on
    /// exit and its pid may have been recycled by an unrelated process) → drop
    /// writer/master with self.
    pub fn kill(mut self) {
        if let Err(error) = self.kill_verified() {
            log::warn!("PTY cleanup could not be verified: {error}");
        }
    }

    /// Tear down the PTY and, on Windows, prove that no tagged WSL process or
    /// session remains. Updater installation uses this fail-closed variant:
    /// NSIS may terminate the app immediately, so an unverified Linux process
    /// tree must prevent apply rather than becoming an orphan.
    pub fn kill_verified(&mut self) -> Result<(), String> {
        self.flow.shutdown();
        #[cfg(target_os = "windows")]
        {
            // Run tag-based cleanup even after the tracked Bash/wsl.exe has
            // exited: a detached/nohup Linux descendant may be the only thing
            // left, and it still carries the session tag.
            let exited = self.exited.load(Ordering::Relaxed);
            let cleanup_verified = cleanup_wsl_session(&self.wsl_session_tag);
            if !cleanup_verified && !exited && self.pid != 0 {
                // ConPTY owns host-side pipes, while WSL owns the Linux process
                // tree. A bounded WSL helper normally TERM/KILLs and verifies
                // the tagged Linux session first; taskkill is the fallback for
                // a damaged or unavailable distro helper.
                let mut taskkill = std::process::Command::new("taskkill.exe");
                taskkill
                    .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                let _ = command_succeeds_bounded(&mut taskkill, std::time::Duration::from_secs(5));
            }
            if !exited {
                let _ = self.child_killer.kill();
            }
            if !cleanup_verified {
                return Err(format!(
                    "could not verify cleanup of WSL session {}",
                    self.wsl_session_tag
                ));
            }
        }
        #[cfg(not(target_os = "windows"))]
        if !self.exited.load(Ordering::Relaxed) {
            let _ = self.child_killer.kill();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_cwd, wsl_cleanup_args, wsl_command_args, FlowControl, HIGH_WATERMARK,
        WSL_SESSION_CLEANUP,
    };
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn keeps_an_existing_directory() {
        let tmp = std::env::temp_dir();
        let got = resolve_cwd(Some(tmp.to_string_lossy().into_owned()));
        assert_eq!(got, Some(tmp));
    }

    #[test]
    fn falls_back_to_home_for_a_missing_directory() {
        // The regression: `Option::or_else` never fires for `Some(bad_path)`,
        // so this used to be handed straight to cmd.cwd() and killed the spawn.
        let got = resolve_cwd(Some("/definitely/not/a/real/path/xyzzy".into()));
        assert_eq!(got, dirs::home_dir());
    }

    #[test]
    fn falls_back_to_home_for_a_file() {
        let file = std::env::temp_dir().join("veviad-resolve-cwd-test");
        std::fs::write(&file, b"x").unwrap();
        let got = resolve_cwd(Some(file.to_string_lossy().into_owned()));
        std::fs::remove_file(&file).ok();
        assert_eq!(got, dirs::home_dir());
    }

    #[test]
    fn falls_back_to_home_for_none_or_blank() {
        assert_eq!(resolve_cwd(None), dirs::home_dir());
        assert_eq!(resolve_cwd(Some("   ".into())), dirs::home_dir());
    }

    #[test]
    fn wsl_launch_uses_structured_linux_environment_and_fixed_shell_source() {
        let args = wsl_command_args("/home/Casey/My Project", true, "vt-test-session");
        assert_eq!(
            &args[..7],
            [
                "--cd",
                "/home/Casey/My Project",
                "--exec",
                "/usr/bin/setsid",
                "--wait",
                "--ctty",
                "/usr/bin/env"
            ]
        );
        assert!(args.iter().any(|arg| arg == "TERM=xterm-256color"));
        assert!(args.iter().any(|arg| arg == "COLORTERM=truecolor"));
        assert!(args
            .iter()
            .any(|arg| arg == "VTERMINAL_SESSION_ID=vt-test-session"));
        assert_eq!(args[args.len() - 3], "/bin/sh");
        assert_eq!(args[args.len() - 2], "-c");
        assert_eq!(
            args.last().unwrap(),
            "exec \"$HOME/.local/share/vterminal/vterminal-bash\""
        );
        assert!(!args
            .iter()
            .any(|arg| arg.contains("My Project;") || arg.contains("My Project &&")));
    }

    #[test]
    fn wsl_launch_without_integration_is_login_bash() {
        let args = wsl_command_args("~", false, "vt-test-session");
        assert_eq!(&args[args.len() - 2..], ["/bin/bash", "-il"]);
    }

    #[test]
    fn wsl_cleanup_uses_a_fixed_script_and_a_separate_opaque_tag() {
        let args = wsl_cleanup_args("vt-test;not-shell-source");
        assert_eq!(args.last().unwrap(), "vt-test;not-shell-source");
        assert!(!WSL_SESSION_CLEANUP.contains("vt-test"));
        assert!(WSL_SESSION_CLEANUP.contains("kill -TERM"));
        assert!(WSL_SESSION_CLEANUP.contains("kill -KILL"));
        assert!(WSL_SESSION_CLEANUP.contains("tagged_pids"));
        assert!(WSL_SESSION_CLEANUP.contains("exit 1"));
    }

    #[test]
    fn backpressure_pauses_above_one_megabyte_and_resumes_after_ack() {
        let flow = Arc::new(FlowControl::new());
        flow.add_outstanding(HIGH_WATERMARK + 65_536);
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader_flow = Arc::clone(&flow);
        std::thread::spawn(move || sender.send(reader_flow.wait_until_resumed()).unwrap());

        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        flow.ack(HIGH_WATERMARK + 65_536);
        assert!(receiver.recv_timeout(Duration::from_secs(1)).unwrap());
    }

    #[test]
    fn shutdown_wakes_a_backpressured_reader() {
        let flow = Arc::new(FlowControl::new());
        flow.add_outstanding(HIGH_WATERMARK);
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader_flow = Arc::clone(&flow);
        std::thread::spawn(move || sender.send(reader_flow.wait_until_resumed()).unwrap());

        flow.shutdown();
        assert!(!receiver.recv_timeout(Duration::from_secs(1)).unwrap());
    }
}
