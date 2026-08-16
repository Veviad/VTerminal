use serde::Serialize;
#[cfg(any(target_os = "windows", test))]
use std::io::Read;
#[cfg(target_os = "windows")]
use std::io::Write;
use std::path::PathBuf;
#[cfg(any(target_os = "windows", test))]
use std::time::{Duration, Instant};
use tauri::{Manager, Wry};

/// Bump when any generated file changes — the zdotdir is rewritten whenever
/// the version marker in the existing vterminal.zsh differs.
const SCRIPT_VERSION: &str = "7";

#[derive(Serialize)]
pub struct ShellIntegrationInfo {
    pub enabled: bool,
    pub zdotdir_path: Option<String>,
    pub integration_path: Option<String>,
    pub shell_family: String,
    pub script_version: String,
}

/// Bash integration is installed inside the default WSL distribution rather
/// than in the Windows filesystem. The wrapper deliberately sources the normal
/// distro and user rc files before adding VTerminal hooks, and it never edits a
/// user's dotfiles.
#[cfg(any(target_os = "windows", test))]
const VTERMINAL_BASH: &str = r#"# vterminal bash integration (version: __VERSION__)
# This file is used as --rcfile. Re-sourcing it in one shell is a no-op, while
# an interactive child shell still installs its own hooks (the function is not
# exported, unlike the public integration marker).
if declare -F __vterminal_preexec >/dev/null 2>&1; then
  return
fi

# Reproduce Bash login initialization before layering VTerminal on top. A
# normal interactive login shell reads /etc/profile and the first readable
# user profile; the distro/user profiles decide whether to source bashrc.
[[ -r /etc/profile ]] && source /etc/profile
if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi

export VTERMINAL_INTEGRATION=1

__vterminal_osc7() {
  local LC_ALL=C encoded="" ch hex i
  for ((i = 0; i < ${#PWD}; i++)); do
    ch="${PWD:i:1}"
    case "$ch" in
      [A-Za-z0-9/_.~-]) encoded+="$ch" ;;
      *) printf -v hex '%%%02X' "'$ch"; encoded+="$hex" ;;
    esac
  done
  printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-wsl}" "$encoded"
}

__vterminal_command_finished() {
  local exit_code=$?
  if [[ -n "${__vterminal_cmd_started:-}" ]]; then
    printf '\e]133;D;%s\e\\' "$exit_code"
    unset __vterminal_cmd_started
  fi
  # Preserve the user's status for the first pre-existing PROMPT_COMMAND hook.
  return "$exit_code"
}

__vterminal_prompt_ready() {
  __vterminal_osc7
  printf '\e]133;A\e\\'
  # PS1 stores Bash prompt escapes, not the bytes they later expand to. The
  # final three backslashes are significant: one terminates OSC (ESC \\) and
  # the last starts Bash's non-printing-span closer (\\]).
  if [[ "$PS1" != *'\e]133;B'* && "$PS1" != *$'\e]133;B'* ]]; then
    PS1="${PS1}"'\[\e]133;B\e\\\]'
  fi
  __vterminal_at_prompt=1
}

__vterminal_preexec() {
  [[ "${__vterminal_at_prompt:-0}" == 1 ]] || return
  __vterminal_at_prompt=0
  __vterminal_cmd_started=1
  local command
  command="$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)"
  if [[ "$command" =~ ^[[:space:]]*[0-9]+[[:space:]][[:space:]] ]]; then
    command="${command:${#BASH_REMATCH[0]}}"
  else
    command="$1"
  fi
  printf '\e]6973;CMD;%s\e\\' "$(printf '%s' "$command" | base64 | tr -d '\n')"
  printf '\e]133;C\e\\'
}

# Run the finish hook first so it receives the user's exit status. Run the
# ready hook last so custom prompt frameworks finish changing PS1 before the
# OSC 133 prompt-end marker is appended. DEBUG stays gated until that point,
# so preserved PROMPT_COMMAND entries are never mistaken for typed commands.
if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
  PROMPT_COMMAND=(__vterminal_command_finished "${PROMPT_COMMAND[@]}" __vterminal_prompt_ready)
elif [[ -n "${PROMPT_COMMAND:-}" ]]; then
  PROMPT_COMMAND=(__vterminal_command_finished "$PROMPT_COMMAND" __vterminal_prompt_ready)
else
  PROMPT_COMMAND=(__vterminal_command_finished __vterminal_prompt_ready)
fi

# `trap -p` returns the handler as one valid shell-quoted word. Decode that
# word, then append the handler to ours so an existing DEBUG hook is preserved
# byte-for-byte instead of being silently replaced.
__vterminal_prior_debug_spec="$(trap -p DEBUG)"
__vterminal_prior_debug_command=""
if [[ -n "$__vterminal_prior_debug_spec" ]]; then
  __vterminal_prior_debug_spec="${__vterminal_prior_debug_spec% DEBUG}"
  __vterminal_prior_debug_spec="${__vterminal_prior_debug_spec#trap -- }"
  builtin eval "__vterminal_prior_debug_command=$__vterminal_prior_debug_spec"
fi
__vterminal_debug_command='__vterminal_preexec "$BASH_COMMAND"'
if [[ -n "$__vterminal_prior_debug_command" ]]; then
  __vterminal_debug_command+="; $__vterminal_prior_debug_command"
fi
trap "$__vterminal_debug_command" DEBUG
unset __vterminal_debug_command __vterminal_prior_debug_spec
"#;

#[cfg(any(target_os = "windows", test))]
const WSL_BASH_WRAPPER: &str = r#"#!/bin/sh
exec /bin/bash --noprofile --rcfile "$HOME/.local/share/vterminal/bashrc-v7" -i
"#;

#[cfg(target_os = "windows")]
pub const WSL_INTEGRATION_PATH: &str = "~/.local/share/vterminal/bashrc-v7";

#[cfg(any(target_os = "windows", test))]
const WSL_WRITE_BASHRC: &str = "umask 077; dir=\"$HOME/.local/share/vterminal\"; mkdir -p \"$dir\" || exit; tmp=\"$dir/.bashrc-v7.$$\"; trap 'rm -f \"$tmp\"' EXIT HUP INT TERM; cat > \"$tmp\" && chmod 600 \"$tmp\" && mv -f \"$tmp\" \"$dir/bashrc-v7\"";

#[cfg(any(target_os = "windows", test))]
const WSL_WRITE_WRAPPER: &str = "umask 077; dir=\"$HOME/.local/share/vterminal\"; mkdir -p \"$dir\" || exit; tmp=\"$dir/.vterminal-bash.$$\"; trap 'rm -f \"$tmp\"' EXIT HUP INT TERM; cat > \"$tmp\" && chmod 700 \"$tmp\" && mv -f \"$tmp\" \"$dir/vterminal-bash\"";

/// The integration script: emits OSC 133 semantic-prompt marks (A/B/C/D;exit),
/// a percent-encoded OSC 7 cwd report, and the typed command as a base64 OSC
/// 6973 payload (buffer-scraping the command is unreliable with RPROMPT/PS2).
/// Guarded against double-injection; coexists with starship/p10k.
const VTERMINAL_ZSH: &str = r#"# vterminal integration (version: __VERSION__)
if [[ -n "$VTERMINAL_INTEGRATION" ]]; then
  return
fi
export VTERMINAL_INTEGRATION=1

autoload -Uz add-zsh-hook

# OSC 7 cwd report with percent-encoded path (%, #, ?, spaces, unicode…)
__vterminal_osc7() {
  local LC_ALL=C
  local url="" ch i
  for (( i = 1; i <= ${#PWD}; i++ )); do
    ch="${PWD[i]}"
    case "$ch" in
      [A-Za-z0-9/_.~-]) url+="$ch" ;;
      *) url+=$(printf '%%%02X' "'$ch") ;;
    esac
  done
  printf '\e]7;file://%s%s\e\\' "$HOST" "$url"
}

__vterminal_precmd() {
  local exit_code=$?
  if [[ -n "$__vterminal_cmd_started" ]]; then
    printf '\e]133;D;%s\e\\' "$exit_code"
    unset __vterminal_cmd_started
  fi
  __vterminal_osc7
  printf '\e]133;A\e\\'
  # 133;B (prompt end / input start) belongs at the very end of the prompt.
  # Re-append every cycle: prompt frameworks (starship, p10k) rewrite PS1 in
  # their own precmd, which runs before ours (we were registered last).
  if [[ "$PS1" != *$'\e]133;B'* ]]; then
    PS1="${PS1}%{$(printf '\e]133;B\e\\')%}"
  fi
}

__vterminal_preexec() {
  __vterminal_cmd_started=1
  # Ship the exact typed command out-of-band; buffer scraping picks up
  # RPROMPT/PS2 decorations.
  printf '\e]6973;CMD;%s\e\\' "$(printf '%s' "$1" | base64 | tr -d '\n')"
  printf '\e]133;C\e\\'
}

add-zsh-hook precmd __vterminal_precmd
add-zsh-hook preexec __vterminal_preexec
"#;

/// zsh reads $ZDOTDIR/{.zshenv,.zprofile,.zshrc,.zlogin} in that order for an
/// interactive login shell. All three generated stubs chain the user's real
/// files (skipping any would silently drop PATH/env — e.g. Homebrew's
/// `brew shellenv` lives in ~/.zprofile).
///
/// Every user file is sourced with ZDOTDIR pointing at the USER'S dir (their
/// dotfiles legitimately reference $ZDOTDIR, e.g. HISTFILE=$ZDOTDIR/.zsh_history);
/// ZDOTDIR is flipped back to our stub dir only between files, so zsh finds
/// the next stub.
///
/// .zshenv runs FIRST and may itself relocate ZDOTDIR — honor that.
const ZSHENV: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
VTERMINAL_ZDOTDIR="$ZDOTDIR"
if [[ -n "$VTERMINAL_ORIG_ZDOTDIR" ]]; then
  ZDOTDIR="$VTERMINAL_ORIG_ZDOTDIR"
else
  ZDOTDIR="$HOME"
fi
unset VTERMINAL_ORIG_ZDOTDIR
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

const ZPROFILE: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

/// .zshrc: chain the user's (with their ZDOTDIR), layer the integration on
/// top, and LEAVE ZDOTDIR as the user's — .zlogin and anything else that
/// inspects it later sees the real value.
const ZSHRC: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
source "$VTERMINAL_ZDOTDIR/vterminal.zsh"
# macOS /etc/zshrc runs while ZDOTDIR still points at this stub dir and sets
# HISTFILE=${ZDOTDIR}/.zsh_history — remap it to the user's dir unless their
# own zshrc chose something else.
if [[ "$HISTFILE" == "$VTERMINAL_ZDOTDIR"/* ]]; then
  HISTFILE="$VTERMINAL_USER_ZDOTDIR${HISTFILE#$VTERMINAL_ZDOTDIR}"
fi
unset VTERMINAL_ZDOTDIR VTERMINAL_USER_ZDOTDIR
"#;

pub fn ensure_zdotdir(app: &tauri::AppHandle<Wry>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zdotdir");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create zdotdir: {e}"))?;

    let version_marker = format!("(version: {SCRIPT_VERSION})");
    let script_path = dir.join("vterminal.zsh");
    let needs_write = std::fs::read_to_string(&script_path)
        .map(|content| !content.contains(&version_marker))
        .unwrap_or(true);
    if needs_write {
        let write = |name: &str, content: &str| {
            std::fs::write(
                dir.join(name),
                content.replace("__VERSION__", SCRIPT_VERSION),
            )
            .map_err(|e| format!("write {name}: {e}"))
        };
        write("vterminal.zsh", VTERMINAL_ZSH)?;
        write(".zshenv", ZSHENV)?;
        write(".zprofile", ZPROFILE)?;
        write(".zshrc", ZSHRC)?;
    }
    Ok(dir)
}

#[cfg(any(target_os = "windows", test))]
fn wait_for_child_bounded(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, String), String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    pipe.read_to_string(&mut stderr)
                        .map_err(|error| format!("could not read process stderr: {error}"))?;
                }
                return Ok((status, stderr));
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "process did not finish within {} seconds",
                    timeout.as_secs()
                ));
            }
            Err(error) => return Err(format!("could not wait for process: {error}")),
        }
    }
}

#[cfg(target_os = "windows")]
fn write_wsl_integration_file(command: &str, content: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("wsl.exe")
        .args(["--exec", "/bin/sh", "-c", command])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start WSL: {error}"))?;
    let write_result = (|| {
        child
            .stdin
            .take()
            .ok_or_else(|| "WSL integration writer has no stdin".to_string())?
            .write_all(content.as_bytes())
            .map_err(|error| format!("could not send the Bash integration to WSL: {error}"))
    })();
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let (status, stderr) = wait_for_child_bounded(&mut child, Duration::from_secs(15))
        .map_err(|error| format!("WSL integration setup failed: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        let detail = stderr.trim().to_string();
        Err(if detail.is_empty() {
            "WSL could not install the Bash integration".into()
        } else {
            format!("WSL could not install the Bash integration: {detail}")
        })
    }
}

#[cfg(target_os = "windows")]
pub fn ensure_wsl_bash_integration() -> Result<(), String> {
    let bash = VTERMINAL_BASH.replace("__VERSION__", SCRIPT_VERSION);
    write_wsl_integration_file(WSL_WRITE_BASHRC, &bash)?;
    write_wsl_integration_file(WSL_WRITE_WRAPPER, WSL_BASH_WRAPPER)
}

pub fn ensure_platform_integration(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        ensure_wsl_bash_integration()
    }
    #[cfg(not(target_os = "windows"))]
    {
        ensure_zdotdir(app).map(|_| ())
    }
}

#[tauri::command]
pub fn shell_integration_status(
    app: tauri::AppHandle<Wry>,
) -> Result<ShellIntegrationInfo, String> {
    let enabled = super::settings::read_bool(&app, "shell_integration_enabled", true);
    #[cfg(target_os = "windows")]
    let (zdotdir_path, integration_path, shell_family) = if enabled {
        ensure_wsl_bash_integration()?;
        (None, Some(WSL_INTEGRATION_PATH.into()), "bash".into())
    } else {
        (None, None, "bash".into())
    };
    #[cfg(not(target_os = "windows"))]
    let (zdotdir_path, integration_path, shell_family) = if enabled {
        let path = ensure_zdotdir(&app)
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        (path.clone(), path, "zsh".into())
    } else {
        (None, None, "zsh".into())
    };
    Ok(ShellIntegrationInfo {
        enabled,
        zdotdir_path,
        integration_path,
        shell_family,
        script_version: SCRIPT_VERSION.to_string(),
    })
}

#[cfg(test)]
mod windows_tests {
    use super::{
        wait_for_child_bounded, VTERMINAL_BASH, WSL_BASH_WRAPPER, WSL_WRITE_BASHRC,
        WSL_WRITE_WRAPPER,
    };
    use std::time::Duration;

    #[cfg(unix)]
    fn run_bash(script: &str) -> std::process::Output {
        use std::io::Write;

        let home = std::env::temp_dir().join(format!(
            "vterminal-bash-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&home).unwrap();
        let mut child = std::process::Command::new("/bin/bash")
            .args(["--noprofile", "--norc", "-s"])
            .env("HOME", &home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        std::fs::remove_dir_all(home).ok();
        output
    }

    #[test]
    fn bash_rc_preserves_profiles_and_reports_command_lifecycle() {
        for required in [
            "source /etc/profile",
            "source \"$HOME/.bash_profile\"",
            "]133;A",
            "]133;B",
            "]133;C",
            "]133;D;",
            "]6973;CMD;",
            "]7;file://",
        ] {
            assert!(VTERMINAL_BASH.contains(required), "missing {required}");
        }
        assert!(WSL_BASH_WRAPPER.contains("--noprofile --rcfile"));
        assert!(WSL_BASH_WRAPPER.contains("bashrc-v7"));
    }

    #[cfg(unix)]
    #[test]
    fn provisioning_commands_are_valid_posix_shell_and_atomic() {
        for command in [WSL_WRITE_BASHRC, WSL_WRITE_WRAPPER] {
            let status = std::process::Command::new("/bin/sh")
                .args(["-n", "-c", command])
                .status()
                .unwrap();
            assert!(status.success());
            assert!(command.contains("mv -f"));
            assert!(command.contains("trap 'rm -f"));
        }
    }

    #[test]
    fn bash_rc_preserves_existing_prompt_and_debug_hooks() {
        assert!(VTERMINAL_BASH.contains(
            "PROMPT_COMMAND=(__vterminal_command_finished \"${PROMPT_COMMAND[@]}\" __vterminal_prompt_ready)"
        ));
        assert!(VTERMINAL_BASH.contains("trap -p DEBUG"));
        assert!(VTERMINAL_BASH.contains("; $__vterminal_prior_debug_command"));
    }

    #[test]
    fn bash_prompt_marker_closes_osc_and_the_nonprinting_span() {
        assert!(VTERMINAL_BASH.contains(r#"'\[\e]133;B\e\\\]'"#));
        assert!(!VTERMINAL_BASH.contains(r#"PS1=\"${PS1}\\[\e]133;B\e\\\\]\""#));
    }

    #[cfg(unix)]
    #[test]
    fn generated_bash_script_is_valid_and_prompt_marker_is_idempotent() {
        let script = format!(
            "{}\ntrap - DEBUG\nPS1='prompt>'\n__vterminal_prompt_ready >/dev/null\n__vterminal_prompt_ready >/dev/null\nprintf '%s' \"$PS1\"\nfalse\n__vterminal_command_finished >/dev/null\nprintf ':%s' \"$?\"\n",
            VTERMINAL_BASH.replace("__VERSION__", "test")
        );
        let output = run_bash(&script);
        assert!(
            output.status.success(),
            "bash failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.ends_with(br"prompt>\[\e]133;B\e\\\]:1"));
    }

    #[cfg(unix)]
    #[test]
    fn generated_bash_script_runs_the_first_login_profile() {
        let script = format!(
            "printf 'PROFILE_MARKER=profile\\n' > \"$HOME/.bash_profile\"\nprintf 'PROFILE_MARKER=wrong\\n' > \"$HOME/.profile\"\n{}\ntrap - DEBUG\nprintf '%s' \"$PROFILE_MARKER\"\n",
            VTERMINAL_BASH.replace("__VERSION__", "test")
        );
        let output = run_bash(&script);
        assert!(
            output.status.success(),
            "bash failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.ends_with(b"profile"));
    }

    #[cfg(unix)]
    #[test]
    fn generated_bash_script_reports_exact_history_and_keeps_debug_trap() {
        let script = format!(
            r#"set -o history
trap 'printf "PRIOR:%s\n" "$BASH_COMMAND" >&2' DEBUG
{}
__vterminal_at_prompt=1
printf exact  two
trap - DEBUG
"#,
            VTERMINAL_BASH.replace("__VERSION__", "test")
        );
        let output = run_bash(&script);
        assert!(
            output.status.success(),
            "bash failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        // base64("printf exact  two") -- including the two typed spaces.
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("]6973;CMD;cHJpbnRmIGV4YWN0ICB0d28="),
            "unexpected stdout: {:?}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("PRIOR:printf exact"),
            "unexpected stderr: {:?}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_child_wait_terminates_a_stuck_process() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "while :; do :; done"])
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let error = wait_for_child_bounded(&mut child, Duration::from_millis(40)).unwrap_err();
        assert!(error.contains("did not finish"));
        assert!(child.try_wait().unwrap().is_some());
    }
}
