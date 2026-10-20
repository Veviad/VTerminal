use serde::Serialize;
#[cfg(all(test, unix))]
use std::io::Read;
#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
#[cfg(all(test, unix))]
use std::time::{Duration, Instant};
#[cfg(not(target_os = "windows"))]
use tauri::Manager;
use tauri::Wry;

/// Bump when any generated file changes — the zdotdir is rewritten whenever
/// the version marker in the existing vterminal.zsh differs.
pub(crate) const SCRIPT_VERSION: &str = "9";

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
pub(crate) const VTERMINAL_BASH: &str = r#"# vterminal bash integration (version: __VERSION__)
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

# Keep the token private to this shell, including when SSH forwards environment
# variables. Standard prompt markers are also emitted for other integrations;
# VTerminal uses the scoped copy to distinguish local and remote shell output.
__vterminal_shell_token="$(LC_ALL=C command od -An -N16 -tx1 /dev/urandom | command tr -d ' \n')"
export -n __vterminal_shell_token
if [[ ! "$__vterminal_shell_token" =~ ^[a-f0-9]{32}$ ]]; then
  printf 'VTerminal shell integration: secure token unavailable\n' >&2
  return
fi
__vterminal_emit() {
  printf '\e]6973;SHELL;%s;%s;%s\e\\' "$__vterminal_shell_token" "$1" "$2"
}
printf '\e]6973;SHELL;%s;READY\e\\' "$__vterminal_shell_token"

__vterminal_osc7() {
  local LC_ALL=C encoded="" ch hex i
  for ((i = 0; i < ${#PWD}; i++)); do
    ch="${PWD:i:1}"
    case "$ch" in
      [A-Za-z0-9/_.~-]) encoded+="$ch" ;;
      *) printf -v hex '%%%02X' "'$ch"; encoded+="$hex" ;;
    esac
  done
  __vterminal_emit 7 "file://${HOSTNAME:-wsl}${encoded}"
  printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-wsl}" "$encoded"
}

__vterminal_command_finished() {
  local exit_code=$?
  if [[ -n "${__vterminal_cmd_started:-}" ]]; then
    __vterminal_emit 133 "D;$exit_code"
    printf '\e]133;D;%s\e\\' "$exit_code"
    unset __vterminal_cmd_started
  fi
  # Preserve the user's status for the first pre-existing PROMPT_COMMAND hook.
  return "$exit_code"
}

__vterminal_prompt_ready() {
  __vterminal_osc7
  __vterminal_emit 133 A
  printf '\e]133;A\e\\'
  # PS1 stores Bash prompt escapes, not the bytes they later expand to. The
  # final three backslashes are significant: one terminates OSC (ESC \\) and
  # the last starts Bash's non-printing-span closer (\\]).
  if [[ "$PS1" != *"6973;SHELL;${__vterminal_shell_token};133;B"* ]]; then
    PS1="${PS1}"'\[\e]6973;SHELL;'"${__vterminal_shell_token}"';133;B\e\\\]\[\e]133;B\e\\\]'
  fi
  # The prompt now contains our private scope, even if the user exported PS1.
  export -n PS1
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
  local encoded_command="$(printf '%s' "$command" | base64 | tr -d '\n')"
  __vterminal_emit CMD "$encoded_command"
  printf '\e]6973;CMD;%s\e\\' "$encoded_command"
  __vterminal_emit 133 C
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
pub(crate) const WSL_BASH_WRAPPER: &str = r#"#!/bin/sh
exec /bin/bash --noprofile --rcfile "$HOME/.local/share/vterminal/bashrc-v9" -i
"#;

#[cfg(target_os = "windows")]
pub const WSL_INTEGRATION_PATH: &str = "~/.local/share/vterminal/bashrc-v9";

/// The integration script: emits OSC 133 semantic-prompt marks (A/B/C/D;exit),
/// a percent-encoded OSC 7 cwd report, and the typed command as a base64 OSC
/// 6973 payload (buffer-scraping the command is unreliable with RPROMPT/PS2).
/// Guarded against double-injection; coexists with starship/p10k.
#[cfg(not(target_os = "windows"))]
const VTERMINAL_ZSH: &str = r#"# vterminal integration (version: __VERSION__)
if (( $+functions[__vterminal_preexec] )); then
  return
fi
export VTERMINAL_INTEGRATION=1

__vterminal_shell_token="$(LC_ALL=C command od -An -N16 -tx1 /dev/urandom | command tr -d ' \n')"
typeset +x __vterminal_shell_token
if [[ ! "$__vterminal_shell_token" =~ ^[a-f0-9]{32}$ ]]; then
  printf 'VTerminal shell integration: secure token unavailable\n' >&2
  return
fi
__vterminal_emit() {
  printf '\e]6973;SHELL;%s;%s;%s\e\\' "$__vterminal_shell_token" "$1" "$2"
}
printf '\e]6973;SHELL;%s;READY\e\\' "$__vterminal_shell_token"

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
  __vterminal_emit 7 "file://${HOST}${url}"
  printf '\e]7;file://%s%s\e\\' "$HOST" "$url"
}

__vterminal_precmd() {
  local exit_code=$?
  # A cancelled input line never reaches preexec. Do not reuse its capture.
  unset __vterminal_pending_command
  if [[ -n "$__vterminal_cmd_started" ]]; then
    __vterminal_emit 133 "D;$exit_code"
    printf '\e]133;D;%s\e\\' "$exit_code"
    unset __vterminal_cmd_started
  fi
  __vterminal_osc7
  __vterminal_emit 133 A
  printf '\e]133;A\e\\'
  # 133;B (prompt end / input start) belongs at the very end of the prompt.
  # Re-append every cycle: prompt frameworks (starship, p10k) rewrite PS1 in
  # their own precmd, which runs before ours (we were registered last).
  if [[ "$PS1" != *"6973;SHELL;${__vterminal_shell_token};133;B"* ]]; then
    PS1="${PS1}%{$(printf '\e]6973;SHELL;%s;133;B\e\\\e]133;B\e\\' "$__vterminal_shell_token")%}"
  fi
  typeset +x PS1 PROMPT
}

# This hook sees the accepted line before history options such as
# HIST_REDUCE_BLANKS rewrite it. preexec's $1 comes from that rewritten history
# and can differ from the command VTerminal typed, preventing block binding.
# Only remove the final history newline; quoted and repeated spaces matter.
__vterminal_zshaddhistory() {
  __vterminal_pending_command="${1%$'\n'}"
  return 0
}

__vterminal_preexec() {
  __vterminal_cmd_started=1
  local command="${__vterminal_pending_command-$1}"
  unset __vterminal_pending_command
  # Ship the accepted command out-of-band; buffer scraping picks up
  # RPROMPT/PS2 decorations. Keep preexec's argument as a fallback when another
  # integration invokes this hook without an interactive history event.
  local encoded_command="$(printf '%s' "$command" | base64 | tr -d '\n')"
  __vterminal_emit CMD "$encoded_command"
  printf '\e]6973;CMD;%s\e\\' "$encoded_command"
  __vterminal_emit 133 C
  printf '\e]133;C\e\\'
}

add-zsh-hook zshaddhistory __vterminal_zshaddhistory
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
#[cfg(not(target_os = "windows"))]
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

#[cfg(not(target_os = "windows"))]
const ZPROFILE: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

/// .zshrc: chain the user's (with their ZDOTDIR), layer the integration on
/// top, and LEAVE ZDOTDIR as the user's — .zlogin and anything else that
/// inspects it later sees the real value.
#[cfg(not(target_os = "windows"))]
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

#[cfg(not(target_os = "windows"))]
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

#[cfg(all(test, unix))]
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

#[cfg(not(target_os = "windows"))]
pub fn ensure_platform_integration(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    ensure_zdotdir(app).map(|_| ())
}

#[tauri::command]
pub async fn shell_integration_status(
    app: tauri::AppHandle<Wry>,
) -> Result<ShellIntegrationInfo, String> {
    let enabled = super::settings::read_bool(&app, "shell_integration_enabled", true);
    #[cfg(target_os = "windows")]
    let (zdotdir_path, integration_path, shell_family) = if enabled {
        let result = crate::windows_terminal::prepare_for_integration(&app, enabled, false).await;
        if result.wsl_status != super::settings::WslStatus::Ready {
            return Err(result
                .message
                .unwrap_or_else(|| "WSL terminal preparation is unavailable".into()));
        }
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

#[cfg(all(test, target_os = "macos"))]
mod zsh_tests {
    use super::{wait_for_child_bounded, SCRIPT_VERSION, VTERMINAL_ZSH};
    use base64::Engine;
    use std::io::{Read, Write};
    use std::time::Duration;

    fn run_zsh(setup: &str, commands: &str) -> (String, String) {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join(".zshrc"),
            format!(
                "HISTFILE=\"$ZDOTDIR/history\"\nHISTSIZE=100\nSAVEHIST=100\n{setup}\n{}",
                VTERMINAL_ZSH.replace("__VERSION__", SCRIPT_VERSION)
            ),
        )
        .unwrap();
        // Interactive stdin exercises real history/preexec ordering. Isolate
        // startup files so tests never source or modify the developer's rc.
        let mut child = std::process::Command::new("/bin/zsh")
            .arg("-di")
            .env("HOME", home.path())
            .env("ZDOTDIR", home.path())
            // An app or child shell can inherit the public integration marker.
            // The generated functions, not that exported marker, own injection.
            .env("VTERMINAL_INTEGRATION", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(commands.as_bytes())
            .unwrap();
        let (status, stderr) = wait_for_child_bounded(&mut child, Duration::from_secs(5)).unwrap();
        assert!(status.success(), "zsh failed: {stderr}");
        let mut stdout = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        let history = std::fs::read_to_string(home.path().join("history")).unwrap_or_default();
        (stdout, history)
    }

    fn lifecycle(stdout: &str) -> Vec<String> {
        stdout
            .split("\x1b]")
            .filter_map(|part| part.split_once("\x1b\\").map(|(payload, _)| payload))
            .filter_map(|payload| {
                if let Some(command) = payload.strip_prefix("6973;CMD;") {
                    Some(format!(
                        "CMD:{}",
                        String::from_utf8(
                            base64::engine::general_purpose::STANDARD
                                .decode(command)
                                .unwrap()
                        )
                        .unwrap()
                    ))
                } else if payload == "133;C" || payload.starts_with("133;D;") {
                    Some(payload.to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn zsh_reports_exact_commands_before_history_options_rewrite_them() {
        let commands = [
            "printf  'first  value\\n' < /dev/null",
            "printf  'first  value\\n' < /dev/null",
            " printf  ignored < /dev/null",
            "false  < /dev/null",
            "true < /dev/null",
        ];
        let (stdout, _) = run_zsh(
            "setopt HIST_REDUCE_BLANKS HIST_IGNORE_SPACE HIST_IGNORE_ALL_DUPS HIST_NO_STORE",
            &format!("{}\n", commands.join("\n")),
        );
        let expected: Vec<String> = commands
            .iter()
            .enumerate()
            .flat_map(|(index, command)| {
                [
                    format!("CMD:{command}"),
                    "133;C".into(),
                    format!("133;D;{}", u8::from(index == 3)),
                ]
            })
            .collect();
        assert_eq!(lifecycle(&stdout), expected);
    }

    #[test]
    fn zsh_reports_a_hardened_command_after_previous_completion() {
        // The shell function only prints text. No Docker binary is invoked.
        let (stdout, _) = run_zsh(
            "setopt HIST_REDUCE_BLANKS\ndocker() { printf 'stub output\\n'; }",
            "printf first < /dev/null\ndocker container prune -f < /dev/null\n",
        );
        assert_eq!(
            lifecycle(&stdout),
            [
                "CMD:printf first < /dev/null",
                "133;C",
                "133;D;0",
                "CMD:docker container prune -f < /dev/null",
                "133;C",
                "133;D;0",
            ]
        );
    }

    #[test]
    fn zsh_reports_commands_even_when_user_history_hook_rejects_saving() {
        let command = "printf  'quoted  spaces' < /dev/null";
        for status in [1, 2] {
            let (stdout, history) = run_zsh(
                &format!("setopt HIST_REDUCE_BLANKS\nzshaddhistory() {{ return {status}; }}"),
                &format!("{command}\n{command}\n"),
            );
            assert_eq!(
                lifecycle(&stdout),
                [
                    format!("CMD:{command}"),
                    "133;C".into(),
                    "133;D;0".into(),
                    format!("CMD:{command}"),
                    "133;C".into(),
                    "133;D;0".into(),
                ]
            );
            assert!(history.is_empty(), "user's history policy was overridden");
        }
    }

    #[test]
    fn zsh_discards_a_cancelled_capture_before_preexec_fallback() {
        let (stdout, _) = run_zsh(
            "",
            "__vterminal_zshaddhistory 'cancelled'; __vterminal_precmd; __vterminal_preexec 'fallback'\n",
        );
        assert!(lifecycle(&stdout).ends_with(&[
            "CMD:fallback".into(),
            "133;C".into(),
            "133;D;0".into(),
        ]));
        assert!(!lifecycle(&stdout).contains(&"CMD:cancelled".into()));
    }

    #[test]
    fn zsh_does_not_reuse_comments_or_blank_input_as_commands() {
        let (stdout, _) = run_zsh(
            "setopt INTERACTIVE_COMMENTS HIST_REDUCE_BLANKS",
            "printf  first < /dev/null\n# comment-only input\n\nprintf  second < /dev/null\n",
        );
        assert_eq!(
            lifecycle(&stdout),
            [
                "CMD:printf  first < /dev/null",
                "133;C",
                "133;D;0",
                "CMD:printf  second < /dev/null",
                "133;C",
                "133;D;0",
            ]
        );
    }

    #[test]
    fn zsh_scopes_lifecycle_to_a_fresh_non_exported_shell_token() {
        let (first, _) = run_zsh("export PS1='exported>'", "env < /dev/null\n");
        let (second, _) = run_zsh("", "true < /dev/null\n");
        let token = |stdout: &str| {
            stdout
                .split("\x1b]6973;SHELL;")
                .skip(1)
                .find_map(|event| {
                    event
                        .split_once(";READY\x1b\\")
                        .map(|(token, _)| token.to_owned())
                })
                .expect("local initialization")
        };
        let first_token = token(&first);
        assert_eq!(first_token.len(), 32);
        assert!(first_token.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(first_token, token(&second));
        assert!(!first
            .lines()
            .any(|line| line.starts_with("__vterminal_shell_token=")));
        assert!(!first.lines().any(|line| {
            (line.starts_with("PS1=") || line.starts_with("PROMPT=")) && line.contains(&first_token)
        }));
        for event in ["CMD;", "133;A", "133;C", "133;D;0", "7;file://"] {
            assert!(
                first.contains(&format!("6973;SHELL;{first_token};{event}")),
                "missing {event}"
            );
        }
    }
}

#[cfg(test)]
mod windows_tests {
    #[cfg(unix)]
    use super::wait_for_child_bounded;
    use super::{VTERMINAL_BASH, WSL_BASH_WRAPPER};
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    fn run_bash(script: &str) -> std::process::Output {
        use std::io::Write;

        let home = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new("/bin/bash")
            .args(["--noprofile", "--norc", "-s"])
            .env("HOME", home.path())
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
        child.wait_with_output().unwrap()
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
        assert!(WSL_BASH_WRAPPER.contains("bashrc-v9"));
    }

    #[cfg(unix)]
    #[test]
    fn provisioning_commands_are_valid_posix_shell_and_atomic() {
        let command = crate::windows_terminal::preparation_script(true);
        let status = std::process::Command::new("/bin/sh")
            .args(["-n", "-c", &command])
            .status()
            .unwrap();
        assert!(status.success());
        assert!(command.contains("mv -f"));
        assert!(command.contains("trap 'rm -f"));
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
        assert!(VTERMINAL_BASH.contains(r#"\[\e]133;B\e\\\]'"#));
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
        let stdout = String::from_utf8(output.stdout).unwrap();
        let prompt = stdout.rsplit("prompt>").next().unwrap();
        assert_eq!(prompt.matches(";133;B").count(), 1);
        assert!(prompt.starts_with(r"\[\e]6973;SHELL;"));
        assert!(prompt.ends_with(r"\[\e]133;B\e\\\]:1"));
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
    fn generated_bash_scopes_lifecycle_and_keeps_token_out_of_child_environment() {
        let script = format!(
            "{}\ntrap - DEBUG\nexport PS1='exported>'\n__vterminal_at_prompt=1\n__vterminal_preexec 'ssh example.invalid'\nfalse\n__vterminal_command_finished\n__vterminal_prompt_ready\n/usr/bin/env\n",
            VTERMINAL_BASH.replace("__VERSION__", "test")
        );
        let output = run_bash(&script);
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let token = stdout
            .split("\x1b]6973;SHELL;")
            .skip(1)
            .find_map(|event| {
                event
                    .split_once(";READY\x1b\\")
                    .map(|(token, _)| token.to_owned())
            })
            .expect("local initialization");
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(!stdout
            .lines()
            .any(|line| line.starts_with("__vterminal_shell_token=")));
        assert!(!stdout
            .lines()
            .any(|line| line.starts_with("PS1=") && line.contains(&token)));
        for event in ["CMD;", "133;A", "133;C", "133;D;1", "7;file://"] {
            assert!(
                stdout.contains(&format!("6973;SHELL;{token};{event}")),
                "missing {event}"
            );
        }
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
