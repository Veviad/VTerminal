//! One shared, bounded WSL preparation attempt for this application launch.

#[cfg(any(target_os = "windows", test))]
use futures::future::{BoxFuture, FutureExt, Shared};
use serde::Serialize;
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::Wry;

use crate::commands::settings::WslStatus;

#[derive(Clone, Debug, Serialize)]
pub struct WindowsTerminalPreparation {
    pub wsl_status: WslStatus,
    pub wsl_distribution: Option<String>,
    pub message: Option<String>,
}

impl WindowsTerminalPreparation {
    #[cfg(any(target_os = "windows", test))]
    fn error(message: impl Into<String>) -> Self {
        Self {
            wsl_status: WslStatus::Error,
            wsl_distribution: None,
            message: Some(message.into()),
        }
    }
}

#[cfg(any(target_os = "windows", test))]
type Attempt = Shared<BoxFuture<'static, WindowsTerminalPreparation>>;

#[cfg(any(target_os = "windows", test))]
#[derive(Default)]
pub struct WindowsTerminalState {
    // The integration preference is part of the cache key. Enabling it after
    // startup must prepare the scripts before the first integrated shell.
    attempt: tokio::sync::Mutex<Option<(bool, Attempt)>>,
}

#[cfg(any(target_os = "windows", test))]
impl WindowsTerminalState {
    async fn prepare_with<F>(
        &self,
        integration: bool,
        retry: bool,
        run: F,
    ) -> WindowsTerminalPreparation
    where
        F: FnOnce(bool) -> WindowsTerminalPreparation + Send + 'static,
    {
        loop {
            let mut cache = self.attempt.lock().await;
            if let Some((previous_integration, attempt)) = &*cache {
                if *previous_integration != integration && attempt.peek().is_none() {
                    // A settings change waits for the old attempt instead of
                    // launching concurrent writers into the same WSL home.
                    let pending = attempt.clone();
                    drop(cache);
                    pending.await;
                    continue;
                }
                let failed = attempt
                    .peek()
                    .is_some_and(|value| value.wsl_status != WslStatus::Ready);
                if *previous_integration == integration && !(retry && failed) {
                    let pending = attempt.clone();
                    drop(cache);
                    return pending.await;
                }
            }
            let attempt = async move {
                tokio::task::spawn_blocking(move || run(integration))
                    .await
                    .unwrap_or_else(|error| {
                        WindowsTerminalPreparation::error(format!(
                            "Terminal preparation stopped: {error}"
                        ))
                    })
            }
            .boxed()
            .shared();
            *cache = Some((integration, attempt.clone()));
            drop(cache);
            return attempt.await;
        }
    }
}

#[tauri::command]
pub async fn windows_terminal_prepare(
    app: tauri::AppHandle<Wry>,
    retry: Option<bool>,
) -> WindowsTerminalPreparation {
    prepare(&app, retry.unwrap_or(false)).await
}

pub async fn prepare(app: &tauri::AppHandle<Wry>, retry: bool) -> WindowsTerminalPreparation {
    #[cfg(target_os = "windows")]
    {
        let integration =
            crate::commands::settings::read_bool(app, "shell_integration_enabled", true);
        prepare_for_integration(app, integration, retry).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, retry);
        WindowsTerminalPreparation {
            wsl_status: WslStatus::NotApplicable,
            wsl_distribution: None,
            message: None,
        }
    }
}

#[cfg(target_os = "windows")]
pub async fn prepare_for_integration(
    app: &tauri::AppHandle<Wry>,
    integration: bool,
    retry: bool,
) -> WindowsTerminalPreparation {
    app.state::<WindowsTerminalState>()
        .prepare_with(integration, retry, prepare_blocking)
        .await
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn preparation_script(integration: bool) -> String {
    use crate::commands::{
        settings::WSL_REQUIRED_TOOLS_PROBE,
        shell_integration::{SCRIPT_VERSION, VTERMINAL_BASH, WSL_BASH_WRAPPER},
    };
    let mut script = format!(
        r#"test -x /bin/bash || exit 40
/bin/bash --noprofile --norc -c 'exit 0' || exit 40
if ! ( {WSL_REQUIRED_TOOLS_PROBE} ); then exit 41; fi
"#
    );
    if !integration {
        return script;
    }
    // These heredoc bodies are bundled application assets, never user input.
    script.push_str(
        r#"for tool in cat chmod mkdir mv rm cmp; do command -v "$tool" >/dev/null || exit 42; done
umask 077
dir="$HOME/.local/share/vterminal"
mkdir -p "$dir" || exit 42
bash_tmp="$dir/.bashrc-v8.$$"
wrapper_tmp="$dir/.vterminal-bash.$$"
trap 'rm -f "$bash_tmp" "$wrapper_tmp"' EXIT HUP INT TERM
cat > "$bash_tmp" <<'VTERMINAL_BUNDLED_BASH_EOF'
"#,
    );
    script.push_str(&VTERMINAL_BASH.replace("__VERSION__", SCRIPT_VERSION));
    script.push_str("\nVTERMINAL_BUNDLED_BASH_EOF\n[ $? -eq 0 ] || exit 42\n");
    script.push_str("cat > \"$wrapper_tmp\" <<'VTERMINAL_BUNDLED_WRAPPER_EOF'\n");
    script.push_str(WSL_BASH_WRAPPER);
    script.push_str(r#"
VTERMINAL_BUNDLED_WRAPPER_EOF
[ $? -eq 0 ] || exit 42
chmod 600 "$bash_tmp" && chmod 700 "$wrapper_tmp" || exit 42
if ! cmp -s "$bash_tmp" "$dir/bashrc-v8"; then mv -f "$bash_tmp" "$dir/bashrc-v8" || exit 42; fi
if ! cmp -s "$wrapper_tmp" "$dir/vterminal-bash"; then mv -f "$wrapper_tmp" "$dir/vterminal-bash" || exit 42; fi
chmod 600 "$dir/bashrc-v8" && chmod 700 "$dir/vterminal-bash" || exit 42
"#);
    script
}

#[cfg(any(target_os = "windows", test))]
fn guest_result(code: Option<i32>, distribution: Option<String>) -> WindowsTerminalPreparation {
    let (wsl_status, message) = match code {
        Some(0) => (WslStatus::Ready, None),
        Some(40) => (WslStatus::MissingBash, Some("The default WSL distribution could not start Bash.".into())),
        Some(41) => (WslStatus::MissingTools, Some("The default WSL distribution is missing required terminal tools.".into())),
        Some(42) => (WslStatus::Error, Some("Shell integration could not be prepared in your WSL home directory. Check available disk space and permissions, then retry.".into())),
        _ => (WslStatus::Error, Some("The default WSL distribution could not complete terminal preparation. Retry after WSL has started.".into())),
    };
    WindowsTerminalPreparation {
        wsl_status,
        wsl_distribution: distribution,
        message,
    }
}

#[cfg(target_os = "windows")]
fn prepare_blocking(integration: bool) -> WindowsTerminalPreparation {
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let result = prepare_with_runner(
        integration,
        started + Duration::from_secs(15),
        crate::windows_process::command_output_until,
    );
    log::info!(
        "Windows terminal preparation: {:?} in {} ms",
        result.wsl_status,
        started.elapsed().as_millis()
    );
    result
}

#[cfg(any(target_os = "windows", test))]
fn prepare_with_runner(
    integration: bool,
    deadline: std::time::Instant,
    mut execute: impl FnMut(
        &mut std::process::Command,
        std::time::Instant,
    ) -> std::io::Result<std::process::Output>,
) -> WindowsTerminalPreparation {
    use crate::{
        commands::settings::{decode_windows_command_output, parse_default_wsl_list},
        windows_process::background_command,
    };
    use std::process::Stdio;
    let mut list = background_command("wsl.exe");
    list.args(["--list", "--verbose"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = match execute(&mut list, deadline) {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return WindowsTerminalPreparation {
                wsl_status: WslStatus::Missing,
                wsl_distribution: None,
                message: None,
            }
        }
        Err(error) => return preparation_error(error, None),
    };
    if !output.status.success() {
        return WindowsTerminalPreparation {
            wsl_status: WslStatus::Missing,
            wsl_distribution: None,
            message: None,
        };
    }
    let (status, distribution) =
        parse_default_wsl_list(&decode_windows_command_output(&output.stdout));
    if status != WslStatus::Ready {
        return WindowsTerminalPreparation {
            wsl_status: status,
            wsl_distribution: distribution,
            message: None,
        };
    }
    let mut guest = background_command("wsl.exe");
    guest
        .args(["--exec", "/bin/sh", "-c"])
        .arg(preparation_script(integration))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match execute(&mut guest, deadline) {
        Ok(output) => guest_result(output.status.code(), distribution),
        Err(error) => preparation_error(error, distribution),
    }
}

#[cfg(any(target_os = "windows", test))]
fn preparation_error(
    error: std::io::Error,
    distribution: Option<String>,
) -> WindowsTerminalPreparation {
    let message = if error.kind() == std::io::ErrorKind::TimedOut {
        "WSL took longer than 15 seconds to start. Wait for it to finish starting, then retry."
            .into()
    } else {
        format!("WSL terminal preparation failed: {error}")
    };
    WindowsTerminalPreparation {
        wsl_status: WslStatus::Error,
        wsl_distribution: distribution,
        message: Some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn ready() -> WindowsTerminalPreparation {
        guest_result(Some(0), Some("Ubuntu".into()))
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_preparation_and_reuse_success() {
        let state = WindowsTerminalState::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let run = |calls: Arc<AtomicUsize>| {
            move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                ready()
            }
        };
        let (first, second) = tokio::join!(
            state.prepare_with(true, false, run(calls.clone())),
            state.prepare_with(true, false, run(calls.clone()))
        );
        assert_eq!(first.wsl_status, WslStatus::Ready);
        assert_eq!(second.wsl_status, WslStatus::Ready);
        state.prepare_with(true, true, run(calls.clone())).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failures_require_retry_and_preference_changes_invalidate_success() {
        let state = WindowsTerminalState::default();
        state
            .prepare_with(false, false, |_| {
                WindowsTerminalPreparation::error("temporary failure")
            })
            .await;
        assert_eq!(
            state
                .prepare_with(false, false, |_| panic!("failure must stay cached"))
                .await
                .wsl_status,
            WslStatus::Error
        );
        assert_eq!(
            state
                .prepare_with(false, true, |_| ready())
                .await
                .wsl_status,
            WslStatus::Ready
        );
        assert_eq!(
            state
                .prepare_with(true, false, |enabled| {
                    assert!(enabled);
                    ready()
                })
                .await
                .wsl_status,
            WslStatus::Ready
        );
    }

    fn success_output(stdout: &[u8]) -> std::process::Output {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: stdout.to_vec(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn preparation_uses_two_commands_with_one_overall_deadline() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut calls = 0;
        let result = prepare_with_runner(true, deadline, |command, command_deadline| {
            assert_eq!(command_deadline, deadline);
            assert_eq!(command.get_program(), "wsl.exe");
            let args: Vec<_> = command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            calls += 1;
            if calls == 1 {
                assert_eq!(args, ["--list", "--verbose"]);
                Ok(success_output(b"* Ubuntu Stopped 2\r\n"))
            } else {
                assert_eq!(&args[..3], ["--exec", "/bin/sh", "-c"]);
                assert!(args[3].contains("VTERMINAL_BUNDLED_BASH_EOF"));
                Ok(success_output(b""))
            }
        });
        assert_eq!(calls, 2);
        assert_eq!(result.wsl_status, WslStatus::Ready);
    }

    #[test]
    fn missing_wsl_skips_guest_and_guest_timeout_stays_retryable() {
        let deadline = std::time::Instant::now();
        let mut calls = 0;
        let missing = prepare_with_runner(true, deadline, |_, _| {
            calls += 1;
            Err(std::io::ErrorKind::NotFound.into())
        });
        assert_eq!(calls, 1);
        assert_eq!(missing.wsl_status, WslStatus::Missing);
        calls = 0;
        let timeout = prepare_with_runner(false, deadline, |_, _| {
            calls += 1;
            if calls == 1 {
                Ok(success_output(b"* Ubuntu Stopped 2\n"))
            } else {
                Err(std::io::ErrorKind::TimedOut.into())
            }
        });
        assert_eq!(timeout.wsl_status, WslStatus::Error);
        assert_eq!(timeout.wsl_distribution.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn timeouts_are_retryable_errors_not_missing_prerequisites() {
        let result = preparation_error(std::io::ErrorKind::TimedOut.into(), Some("Ubuntu".into()));
        assert_eq!(result.wsl_status, WslStatus::Error);
        assert_eq!(result.wsl_distribution.as_deref(), Some("Ubuntu"));
        assert_eq!(
            guest_result(Some(40), None).wsl_status,
            WslStatus::MissingBash
        );
        assert_eq!(
            guest_result(Some(41), None).wsl_status,
            WslStatus::MissingTools
        );
    }

    #[cfg(unix)]
    #[test]
    fn provisioning_is_atomic_idempotent_and_disabled_means_no_files() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let home = tempfile::tempdir().unwrap();
        let run = |enabled| {
            std::process::Command::new("/bin/sh")
                .args(["-c", &preparation_script(enabled)])
                .env("HOME", home.path())
                .status()
                .unwrap()
        };
        // macOS has no /usr/bin/setsid. Exercise the actual provisioner after
        // the probe, which has separate status-classification tests.
        let run_provisioner = || {
            let script = preparation_script(true);
            let provisioner = &script[script.find("for tool in cat").unwrap()..];
            std::process::Command::new("/bin/sh")
                .args(["-c", provisioner])
                .env("HOME", home.path())
                .status()
                .unwrap()
        };
        let _ = run(false);
        assert!(!home.path().join(".local").exists());
        assert!(run_provisioner().success());
        let bash = home.path().join(".local/share/vterminal/bashrc-v8");
        let before = std::fs::metadata(&bash).unwrap();
        assert_eq!(before.permissions().mode() & 0o777, 0o600);
        assert!(run_provisioner().success());
        assert_eq!(before.ino(), std::fs::metadata(&bash).unwrap().ino());
        std::fs::write(&bash, "outdated").unwrap();
        assert!(run_provisioner().success());
        assert!(std::fs::read_to_string(bash)
            .unwrap()
            .contains("(version: 8)"));
        assert_eq!(
            std::fs::read_dir(home.path().join(".local/share/vterminal"))
                .unwrap()
                .count(),
            2
        );
    }
}
