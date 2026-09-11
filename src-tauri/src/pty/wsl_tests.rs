//! Exercise the Linux portion of the WSL launch command against a real Unix PTY.
//! This reproduces terminal ownership without requiring a Windows host; it does
//! not replace a Windows/ConPTY/WSL smoke test.

use super::wsl_command_args;
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

struct TestChild {
    child: Box<dyn Child + Send + Sync>,
    reaped: bool,
}

impl Drop for TestChild {
    fn drop(&mut self) {
        if !self.reaped && !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn assert_wsl_shell_keeps_its_terminal(integration_enabled: bool) {
    let home = tempfile::tempdir().unwrap();
    let cwd = home.path().join("project with spaces ; literal");
    std::fs::create_dir(&cwd).unwrap();
    let cwd = cwd.canonicalize().unwrap();
    // A private HOME and environment keep developer shell customizations out of
    // the test. The non-integration route still exercises Bash's actual -il args.
    std::fs::write(home.path().join(".bash_profile"), "PS1=\n").unwrap();
    let wrapper = home.path().join(".local/share/vterminal/vterminal-bash");
    std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
    std::fs::write(
        &wrapper,
        "#!/bin/sh\nexport VTERMINAL_TEST_WRAPPER=enabled\nexec /bin/bash --noprofile --norc -i\n",
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        home.path().join("probe.bash"),
        r#"[[ $- == *i* && $- == *m* ]] || exit 61
[[ -t 0 && -t 1 && -t 2 ]] || exit 62
[[ "$PWD" == "$VTERMINAL_TEST_CWD" ]] || exit 63
[[ "$VTERMINAL_SESSION_ID" == 'vt-test;literal-session' ]] || exit 64
[[ "$TERM" == xterm-256color && "$COLORTERM" == truecolor ]] || exit 65
[[ "$TERM_PROGRAM" == VTerminal && "$TERM_PROGRAM_VERSION" == "$VTERMINAL_TEST_VERSION" ]] || exit 66
[[ "${VTERMINAL_TEST_WRAPPER:-disabled}" == "$VTERMINAL_TEST_EXPECT_WRAPPER" ]] || exit 67
exec 3<>/dev/tty || exit 68
printf 'VT_TTY_%s\n' READY >&3
read -r tty_input <&3 || exit 69
[[ "$tty_input" == VT_TTY_INPUT ]] || exit 70
trap '[[ -z ${job:-} ]] || { kill -KILL "$job" 2>/dev/null; wait "$job" 2>/dev/null; }' EXIT
/bin/sh -c 'kill -STOP "$$"; exit 0' &
job=$!
wait "$job"
[[ $? -gt 128 ]] || exit 71
fg %1 || exit 72
job=
printf 'VT_PTY_%s\n' OK
exit 23
"#,
    )
    .unwrap();

    let args = wsl_command_args(
        cwd.to_str().unwrap(),
        integration_enabled,
        "vt-test;literal-session",
    );
    assert_eq!(&args[..3], ["--cd", cwd.to_str().unwrap(), "--exec"]);
    // portable-pty supplies the controlling terminal that WSL already owns.
    // Run the exact executable and arguments after wsl.exe's --exec boundary.
    let mut command = CommandBuilder::new(&args[3]);
    command.args(&args[4..]);
    command.cwd(&cwd);
    command.env_clear();
    command.env("HOME", home.path());
    command.env("PATH", "/usr/bin:/bin");
    command.env("BASH_SILENCE_DEPRECATION_WARNING", "1");
    command.env("VTERMINAL_TEST_CWD", &cwd);
    command.env("VTERMINAL_TEST_VERSION", env!("CARGO_PKG_VERSION"));
    command.env(
        "VTERMINAL_TEST_EXPECT_WRAPPER",
        if integration_enabled {
            "enabled"
        } else {
            "disabled"
        },
    );

    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut child = TestChild {
        child: pair.slave.spawn_command(command).unwrap(),
        reaped: false,
    };
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (sender, receiver) = mpsc::sync_channel(8);
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if sender.send(Ok(buffer[..count].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                // Linux reports EIO when the last slave closes; macOS reports EOF.
                Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });
    let mut writer = pair.master.take_writer().unwrap();
    writer
        .write_all(b". \"$HOME/probe.bash\"\nVT_TTY_INPUT\n")
        .unwrap();
    writer.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    loop {
        assert!(
            Instant::now() < deadline,
            "shell timed out: {}",
            String::from_utf8_lossy(&output)
        );
        // A channel deadline bounds the blocking reader without raw PTY FFI.
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Ok(bytes)) => output.extend_from_slice(&bytes),
            Ok(Err(error)) => panic!("PTY read failed: {error}"),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                panic!("shell timed out: {}", String::from_utf8_lossy(&output));
            }
        }
    }
    reader_thread.join().unwrap();

    let status = loop {
        if let Some(status) = child.child.try_wait().unwrap() {
            child.reaped = true;
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "shell timed out: {}",
            String::from_utf8_lossy(&output)
        );
        std::thread::sleep(Duration::from_millis(5));
    };

    let output = String::from_utf8_lossy(&output);
    assert_eq!(status.exit_code(), 23, "{output}");
    assert!(output.contains("VT_TTY_READY"), "{output}");
    assert!(output.contains("VT_PTY_OK"), "{output}");
}

#[test]
fn wsl_integration_shell_retains_controlling_terminal_and_job_control() {
    assert_wsl_shell_keeps_its_terminal(true);
}

#[test]
fn wsl_login_shell_retains_controlling_terminal_and_job_control() {
    assert_wsl_shell_keeps_its_terminal(false);
}
