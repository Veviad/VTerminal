use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
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
}

pub struct SpawnParams {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub shell_path: Option<String>,
    pub zdotdir: Option<std::path::PathBuf>,
}

/// A requested cwd can be a directory that was deleted, renamed, or lives on an
/// unmounted volume — restoring a saved session makes that routine rather than
/// exotic. `cmd.cwd()` on a missing path fails at exec, so validate here and
/// fall back to $HOME instead of handing the caller a dead tab.
///
/// Note the shape: `Option::or_else` fires only on `None`, so `Some(bad_path)`
/// must be filtered out explicitly before the fallback can apply.
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

    let shell = params
        .shell_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    // Login + interactive so /etc/zprofile's path_helper runs — GUI-launched
    // apps inherit a bare environment, this restores the user's real PATH.
    cmd.args(["-il"]);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "VTerminal");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    if let Some(zdotdir) = &params.zdotdir {
        // The generated zdotdir chains the user's real .zshenv/.zprofile/.zshrc
        // first (see shell_integration), then layers the OSC hooks on top.
        if shell.ends_with("zsh") {
            let orig = std::env::var("ZDOTDIR").unwrap_or_default();
            cmd.env("VTERMINAL_ORIG_ZDOTDIR", orig);
            cmd.env("ZDOTDIR", zdotdir);
        }
    }
    if let Some(cwd) = resolve_cwd(params.cwd) {
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

    // Own dup of the master fd for the reader thread. The reader closes it
    // itself on exit, so there is no use-after-close/fd-reuse race with kill().
    let reader_fd = pair.master.as_raw_fd().ok_or("master pty has no raw fd")?;
    let reader_fd = unsafe { libc::dup(reader_fd) };
    if reader_fd < 0 {
        return Err("dup(master fd) failed".into());
    }

    let flow = Arc::new(FlowControl::new());
    let exited = Arc::new(AtomicBool::new(false));

    // Reader pump — dedicated OS thread. poll() with a timeout so the thread
    // also exits on shutdown even when a SIGHUP-immune process (nohup) keeps
    // the slave side open forever; a plain blocking read() would leak the
    // thread and the pty pair in that case.
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
        self.flow.shutdown();
        if !self.exited.load(Ordering::Relaxed) {
            let _ = self.child_killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_cwd;

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
}
