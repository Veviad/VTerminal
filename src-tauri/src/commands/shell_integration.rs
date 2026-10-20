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

/// Bump when generated files change. Every bundled asset is also content-checked
/// so interrupted writes or missing files repair without a version change.
pub(crate) const SCRIPT_VERSION: &str = "10";

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
export -n VTERMINAL_SHELL_SCOPE
if declare -F __vterminal_preexec >/dev/null 2>&1; then
  unset VTERMINAL_SHELL_SCOPE
  return
fi

# Consume the native-provisioned scope before any user initialization can
# launch children or forward environment variables. Manual sourcing can still
# initialize a standalone scope when no native token was supplied.
__vterminal_shell_token="${VTERMINAL_SHELL_SCOPE:-}"
unset VTERMINAL_SHELL_SCOPE
if [[ ! "$__vterminal_shell_token" =~ ^[a-f0-9]{32}$ ]]; then
  __vterminal_shell_token="$(LC_ALL=C command od -An -N16 -tx1 /dev/urandom | command tr -d ' \n')"
fi
export -n __vterminal_shell_token

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
exec /bin/bash --noprofile --rcfile "$HOME/.local/share/vterminal/bashrc-v10" -i
"#;

#[cfg(target_os = "windows")]
pub const WSL_INTEGRATION_PATH: &str = "~/.local/share/vterminal/bashrc-v10";

/// The integration script: emits OSC 133 semantic-prompt marks (A/B/C/D;exit),
/// a percent-encoded OSC 7 cwd report, and the typed command as a base64 OSC
/// 6973 payload (buffer-scraping the command is unreliable with RPROMPT/PS2).
/// Guarded against double-injection; coexists with starship/p10k.
#[cfg(not(target_os = "windows"))]
const VTERMINAL_ZSH: &str = r#"# vterminal integration (version: __VERSION__)
typeset +x VTERMINAL_SHELL_SCOPE
typeset +x VTERMINAL_SHELL_SCOPE_FILE
if (( $+functions[__vterminal_preexec] )); then
  unset VTERMINAL_SHELL_SCOPE
  return
fi
export VTERMINAL_INTEGRATION=1

__vterminal_shell_token=""
if [[ -n "${VTERMINAL_SHELL_SCOPE_FILE:-}" && -r "$VTERMINAL_SHELL_SCOPE_FILE" ]]; then
  IFS= read -r __vterminal_shell_token < "$VTERMINAL_SHELL_SCOPE_FILE" || :
fi
unset VTERMINAL_SHELL_SCOPE
if [[ ! "$__vterminal_shell_token" =~ ^[a-f0-9]{32}$ ]]; then
  __vterminal_shell_token="$(LC_ALL=C command od -An -N16 -tx1 /dev/urandom | command tr -d ' \n')"
fi
typeset +x __vterminal_shell_token
__vterminal_scope_ready=0
typeset +x __vterminal_scope_ready
if [[ ! "$__vterminal_shell_token" =~ ^[a-f0-9]{32}$ ]]; then
  printf 'VTerminal shell integration: secure token unavailable\n' >&2
  return
fi
__vterminal_emit() {
  printf '\e]6973;SHELL;%s;%s;%s\e\\' "$__vterminal_shell_token" "$1" "$2"
}
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
  # A startup tool may replace the shell while loading a profile. Bind only
  # the shell that actually reaches a prompt, after every startup file ran.
  if [[ "${__vterminal_scope_ready:-0}" != 1 ]]; then
    __vterminal_scope_ready=1
    printf '\e]6973;SHELL;%s;READY\e\\' "$__vterminal_shell_token"
  fi
  if [[ -n "${VTERMINAL_USER_ZDOTDIR:-}" ]]; then
    ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
  fi
  unset VTERMINAL_ZDOTDIR VTERMINAL_USER_ZDOTDIR VTERMINAL_SHELL_SCOPE VTERMINAL_SHELL_SCOPE_FILE
  unset __vterminal_exec_saved __vterminal_exec_present __vterminal_exec_bridge
  unfunction __vterminal_begin_user_init __vterminal_end_user_init 2>/dev/null
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
/// interactive login shell. All four generated stubs chain the user's real
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
typeset +x VTERMINAL_SHELL_SCOPE
typeset +x VTERMINAL_SHELL_SCOPE_FILE
VTERMINAL_ZDOTDIR="$ZDOTDIR"
if [[ -n "$VTERMINAL_ORIG_ZDOTDIR" ]]; then
  ZDOTDIR="$VTERMINAL_ORIG_ZDOTDIR"
else
  ZDOTDIR="$HOME"
fi
unset VTERMINAL_ORIG_ZDOTDIR

# Keep user startup files in their own ZDOTDIR context. A bounded alias carries
# the injection directory only across an exec during startup, including an
# assignment-prefixed exec -a used by terminal wrappers. Explicit alias bypasses,
# disabled alias expansion and environment-clearing wrappers remain unsupported;
# no remote is inferred when startup integration cannot be observed.
__vterminal_begin_user_init() {
  typeset -ga __vterminal_exec_saved __vterminal_exec_present __vterminal_exec_bridge
  __vterminal_exec_saved+=("${aliases[exec]-}")
  __vterminal_exec_present+=("${+aliases[exec]}")
  # Alias expansion is captured in user-defined function bodies. Keep that
  # expansion inert after startup: never forward our token from a later exec.
  # Carry only a local file path. Startup may exec ssh with broad SendEnv;
  # forwarding the raw nonce would let remote output impersonate our shell.
  __vterminal_exec_bridge+=('VTERMINAL_ORIG_ZDOTDIR="${VTERMINAL_ZDOTDIR:+$ZDOTDIR}" ZDOTDIR="${VTERMINAL_ZDOTDIR:-$ZDOTDIR}" VTERMINAL_SHELL_SCOPE_FILE="${VTERMINAL_ZDOTDIR:+${VTERMINAL_SHELL_SCOPE_FILE:-}}" '"${aliases[exec]-exec}")
  builtin alias exec="${__vterminal_exec_bridge[-1]}"
}
__vterminal_end_user_init() {
  # Restore only our alias: a replacement authored by the user must survive.
  if [[ "${aliases[exec]-}" == "${__vterminal_exec_bridge[-1]}" ]]; then
    if [[ "${__vterminal_exec_present[-1]}" == 1 ]]; then
      builtin alias exec="${__vterminal_exec_saved[-1]}"
    else
      builtin unalias exec
    fi
  fi
  __vterminal_exec_saved[-1]=()
  __vterminal_exec_present[-1]=()
  __vterminal_exec_bridge[-1]=()
  # A bare exec (no argv or redirections) retains prefix assignments until this
  # file boundary. Restore the context before the next startup file or prompt.
  if [[ "$ZDOTDIR" == "$VTERMINAL_ZDOTDIR" && -n "$VTERMINAL_ORIG_ZDOTDIR" ]]; then
    ZDOTDIR="$VTERMINAL_ORIG_ZDOTDIR"
  fi
  unset VTERMINAL_ORIG_ZDOTDIR
  typeset +x VTERMINAL_SHELL_SCOPE
  typeset +x VTERMINAL_SHELL_SCOPE_FILE
}
__vterminal_begin_user_init
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
__vterminal_end_user_init
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

#[cfg(not(target_os = "windows"))]
const ZPROFILE: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
__vterminal_begin_user_init
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
__vterminal_end_user_init
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

/// .zshrc: chain the user's (with their ZDOTDIR), layer the integration on
/// top. Keep the injection directory between startup files so .zlogin can use
/// the same bounded exec bridge; the user's ZDOTDIR is restored at the prompt.
#[cfg(not(target_os = "windows"))]
const ZSHRC: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
__vterminal_begin_user_init
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
__vterminal_end_user_init
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
source "$VTERMINAL_ZDOTDIR/vterminal.zsh"
# macOS /etc/zshrc runs while ZDOTDIR still points at this stub dir and sets
# HISTFILE=${ZDOTDIR}/.zsh_history — remap it to the user's dir unless their
# own zshrc chose something else.
if [[ "$HISTFILE" == "$VTERMINAL_ZDOTDIR"/* ]]; then
  HISTFILE="$VTERMINAL_USER_ZDOTDIR${HISTFILE#$VTERMINAL_ZDOTDIR}"
fi
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

#[cfg(not(target_os = "windows"))]
const ZLOGIN: &str = r#"# vterminal generated zdotdir (version: __VERSION__)
ZDOTDIR="$VTERMINAL_USER_ZDOTDIR"
__vterminal_begin_user_init
[[ -f "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
__vterminal_end_user_init
VTERMINAL_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$VTERMINAL_ZDOTDIR"
"#;

#[cfg(not(target_os = "windows"))]
pub fn ensure_zdotdir(app: &tauri::AppHandle<Wry>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("zdotdir");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create zdotdir: {e}"))?;

    write_zdotdir_assets(&dir)?;
    Ok(dir)
}

#[cfg(not(target_os = "windows"))]
fn write_zdotdir_assets(dir: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    // Verify every bundled asset, even when another file has the current
    // version marker. Interrupted writes and missing dotfiles must self-repair.
    for (name, source) in [
        ("vterminal.zsh", VTERMINAL_ZSH),
        (".zshenv", ZSHENV),
        (".zprofile", ZPROFILE),
        (".zshrc", ZSHRC),
        (".zlogin", ZLOGIN),
    ] {
        let expected = source.replace("__VERSION__", SCRIPT_VERSION);
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(expected.as_str()) {
            continue;
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(dir).map_err(|e| format!("prepare {name}: {e}"))?;
        temporary
            .write_all(expected.as_bytes())
            .map_err(|e| format!("write {name}: {e}"))?;
        temporary
            .persist(&path)
            .map_err(|e| format!("save {name}: {e}"))?;
    }
    Ok(())
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
    use super::{wait_for_child_bounded, write_zdotdir_assets, SCRIPT_VERSION, VTERMINAL_ZSH};
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
            .env_remove("VTERMINAL_SHELL_SCOPE")
            .env_remove("VTERMINAL_SHELL_SCOPE_FILE")
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

    fn run_startup(
        files: &[(&str, &str)],
        commands: &str,
        injected: bool,
    ) -> (std::process::ExitStatus, String, String) {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home with spaces");
        let user = root.path().join("custom dotfiles with spaces");
        let app = root.path().join("application stubs");
        for dir in [&home, &user, &app] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let scope_file = root.path().join("private native scope");
        std::fs::write(&scope_file, "0123456789abcdef0123456789abcdef").unwrap();
        write_zdotdir_assets(&app).unwrap();
        for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
            let body = files
                .iter()
                .find(|(file, _)| *file == name)
                .map_or("", |(_, body)| *body);
            std::fs::write(user.join(name), format!(
                "[[ \"$ZDOTDIR\" == \"$VT_EXPECTED_USER_DIR\" ]] || print BAD_USER_CONTEXT\nif /usr/bin/env | /usr/bin/grep -Eq '^(VTERMINAL_SHELL_SCOPE|VTERMINAL_SHELL_SCOPE_FILE|__vterminal_shell_token)=.+'; then print EXPORTED_PRIVATE_SCOPE; fi\n{body}\n"
            )).unwrap();
        }
        let mut child = std::process::Command::new("/bin/zsh")
            .arg("-il")
            .env("HOME", &home)
            .env("ZDOTDIR", if injected { &app } else { &user })
            .env("VTERMINAL_ORIG_ZDOTDIR", &user)
            .env("VT_EXPECTED_USER_DIR", &user)
            .env(
                "VTERMINAL_SHELL_SCOPE_FILE",
                if injected {
                    scope_file.as_os_str()
                } else {
                    std::ffi::OsStr::new("")
                },
            )
            .env_remove("VTERMINAL_SHELL_SCOPE")
            .env_remove("VT_FAKE_WRAPPED")
            .env_remove("VTERMINAL_INTEGRATION")
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
        let mut stdout = String::new();
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut stdout)
            .unwrap();
        (status, stdout, stderr)
    }

    #[test]
    fn generated_startup_survives_profile_rc_and_login_exec_handoffs() {
        for file in [".zprofile", ".zshrc", ".zlogin"] {
            for exec in [
                "exec /bin/zsh -il",
                "VT_WRAPPER_META=ok exec -a zsh /bin/zsh -il",
                "eval 'VT_WRAPPER_META=ok exec -a zsh /bin/zsh -il'",
            ] {
                let handoff = format!(
                    "if [[ -z \"$VT_FAKE_WRAPPED\" ]]; then export VT_FAKE_WRAPPED=1; {exec}; fi"
                );
                let (status, stdout, stderr) =
                    run_startup(&[(file, &handoff)], "printf WRAPPER_OK\n", true);
                assert!(status.success(), "{file}: {stderr}");
                assert!(!stdout.contains("BAD_USER_CONTEXT"), "{file}: {stdout}");
                assert!(
                    !stdout.contains("EXPORTED_PRIVATE_SCOPE"),
                    "{file}: {stdout}"
                );
                assert!(stdout.contains("SHELL;0123456789abcdef0123456789abcdef;READY"));
                assert_eq!(
                    stdout.matches(";READY\x1b\\").count(),
                    1,
                    "{file}: {stdout}"
                );
                assert_eq!(
                    lifecycle(&stdout),
                    ["CMD:printf WRAPPER_OK", "133;C", "133;D;0"]
                );
            }
        }
    }

    #[test]
    fn generated_startup_keeps_custom_zdotdir_and_removes_bridge_before_prompt() {
        let (status, stdout, stderr) = run_startup(&[],
            "[[ \"$ZDOTDIR\" == \"$VT_EXPECTED_USER_DIR\" ]] && print USER_CONTEXT_OK\nalias exec 2>/dev/null || print NO_EXEC_ALIAS\n", true);
        assert!(status.success(), "{stderr}");
        assert!(!stdout.contains("BAD_USER_CONTEXT"));
        assert!(stdout.contains("USER_CONTEXT_OK\n"));
        assert!(stdout.contains("NO_EXEC_ALIAS\n"));
        assert_eq!(stdout.matches(";READY\x1b\\").count(), 1);
    }

    #[test]
    fn generated_startup_composes_prior_alias_and_preserves_new_user_alias() {
        let handoff = "if [[ -z \"$VT_FAKE_WRAPPED\" ]]; then export VT_FAKE_WRAPPED=1; exec /bin/zsh -il; fi";
        let (status, stdout, stderr) = run_startup(
            &[
                (".zshenv", "alias exec='exec -a zsh'"),
                (".zprofile", handoff),
            ],
            "alias exec\n",
            true,
        );
        assert!(status.success(), "{stderr}");
        assert!(!stdout.contains("BAD_USER_CONTEXT"));
        assert!(stdout.contains("exec='exec -a zsh'"));
        assert_eq!(stdout.matches(";READY\x1b\\").count(), 1);

        let (status, stdout, stderr) = run_startup(
            &[(".zshrc", "alias exec='nocorrect exec'")],
            "alias exec\n",
            true,
        );
        assert!(status.success(), "{stderr}");
        assert!(stdout.contains("exec='nocorrect exec'"));
        assert!(!stdout.contains("VTERMINAL_ORIG_ZDOTDIR=\"$ZDOTDIR\""));
    }

    #[test]
    fn generated_startup_exec_honors_a_relocated_user_zdotdir() {
        let relocate = r#"mkdir -p "$HOME/relocated dotfiles"
printf '%s\n' 'if [[ -z "$VT_FAKE_WRAPPED" ]]; then export VT_FAKE_WRAPPED=1; exec /bin/zsh -il; fi' > "$HOME/relocated dotfiles/.zprofile"
printf '%s\n' '[[ "$ZDOTDIR" == "$VT_EXPECTED_USER_DIR" ]] || print BAD_USER_CONTEXT' > "$HOME/relocated dotfiles/.zshrc"
ZDOTDIR="$HOME/relocated dotfiles"
export VT_EXPECTED_USER_DIR="$ZDOTDIR"
"#;
        let (status, stdout, stderr) = run_startup(
            &[(".zshenv", relocate)],
            "[[ \"$ZDOTDIR\" == \"$VT_EXPECTED_USER_DIR\" ]] && print RELOCATED_CONTEXT_OK\n",
            true,
        );
        assert!(status.success(), "{stderr}");
        assert!(!stdout.contains("BAD_USER_CONTEXT"));
        assert!(stdout.contains("RELOCATED_CONTEXT_OK\n"));
        assert_eq!(stdout.matches(";READY\x1b\\").count(), 1);
    }

    #[test]
    fn startup_defined_exec_function_is_inert_after_the_first_prompt() {
        let function = r#"restart_shell() {
  exec /bin/zsh -dfc '[[ "$ZDOTDIR" == "$VT_EXPECTED_USER_DIR" ]] && print CHILD_USER_CONTEXT_OK; [[ -z "${VTERMINAL_ORIG_ZDOTDIR:-}${VTERMINAL_SHELL_SCOPE:-}${VTERMINAL_SHELL_SCOPE_FILE:-}${__vterminal_shell_token:-}" ]] && print CHILD_SCOPE_EMPTY'
}"#;
        let (status, stdout, stderr) =
            run_startup(&[(".zshrc", function)], "restart_shell\n", true);
        assert!(status.success(), "{stderr}");
        assert!(stdout.contains("CHILD_USER_CONTEXT_OK\n"));
        assert!(stdout.contains("CHILD_SCOPE_EMPTY\n"));
        assert!(!stdout.contains("EXPORTED_PRIVATE_SCOPE"));
        assert_eq!(stdout.matches(";READY\x1b\\").count(), 1);
    }

    #[test]
    fn generated_startup_restores_bare_exec_at_file_boundary_and_keeps_redirections() {
        for exec in ["exec", "exec 3>/dev/null; print REDIRECT_OK >&3"] {
            let (status, stdout, stderr) = run_startup(
                &[(".zprofile", exec)],
                "[[ \"$ZDOTDIR\" == \"$VT_EXPECTED_USER_DIR\" ]] && print CONTEXT_OK\n",
                true,
            );
            assert!(status.success(), "{exec}: {stderr}");
            assert!(!stdout.contains("BAD_USER_CONTEXT"), "{exec}: {stdout}");
            assert!(stdout.contains("CONTEXT_OK\n"));
        }
    }

    #[test]
    fn generated_startup_preserves_failed_exec_behavior() {
        let files = [(
            ".zprofile",
            "exec /vterminal-test-nonexistent-command; print AFTER_FAILED_EXEC",
        )];
        let (baseline, baseline_out, baseline_err) =
            run_startup(&files, "printf AFTER_STARTUP\n", false);
        let (injected, injected_out, injected_err) =
            run_startup(&files, "printf AFTER_STARTUP\n", true);
        assert_eq!(injected.code(), baseline.code());
        assert_eq!(
            injected_out.contains("AFTER_FAILED_EXEC"),
            baseline_out.contains("AFTER_FAILED_EXEC")
        );
        assert_eq!(
            injected_out.contains("AFTER_STARTUP"),
            baseline_out.contains("AFTER_STARTUP")
        );
        assert!(baseline_err.contains("vterminal-test-nonexistent-command"));
        assert!(injected_err.contains("vterminal-test-nonexistent-command"));
    }

    #[test]
    fn generated_assets_repair_every_file_even_with_current_version_markers() {
        let root = tempfile::tempdir().unwrap();
        write_zdotdir_assets(root.path()).unwrap();
        let script = std::fs::read_to_string(root.path().join("vterminal.zsh")).unwrap();
        for file in [".zshenv", ".zprofile", ".zshrc", ".zlogin", "vterminal.zsh"] {
            std::fs::write(
                root.path().join(file),
                format!("# version: {SCRIPT_VERSION}\ncorrupt"),
            )
            .unwrap();
            write_zdotdir_assets(root.path()).unwrap();
            assert!(!std::fs::read_to_string(root.path().join(file))
                .unwrap()
                .contains("corrupt"));
            std::fs::remove_file(root.path().join(file)).unwrap();
            write_zdotdir_assets(root.path()).unwrap();
            assert!(root.path().join(file).is_file());
        }
        assert_eq!(
            std::fs::read_to_string(root.path().join("vterminal.zsh")).unwrap(),
            script
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 5);
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
        assert!(WSL_BASH_WRAPPER.contains("bashrc-v10"));
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
    fn generated_bash_consumes_provisioned_scope_before_user_initialization() {
        let script = format!(
            r#"export VTERMINAL_SHELL_SCOPE=0123456789abcdef0123456789abcdef
printf '%s\n' 'if /usr/bin/env | /usr/bin/grep -Eq "^(VTERMINAL_SHELL_SCOPE|__vterminal_shell_token)=.+"; then printf EXPORTED_PRIVATE_SCOPE; fi' > "$HOME/.bash_profile"
{}
trap - DEBUG
__vterminal_prompt_ready
/usr/bin/env
"#,
            VTERMINAL_BASH.replace("__VERSION__", "test")
        );
        let output = run_bash(&script);
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("SHELL;0123456789abcdef0123456789abcdef;READY"));
        assert!(!stdout.contains("EXPORTED_PRIVATE_SCOPE"));
        assert!(!stdout
            .lines()
            .any(|line| line.starts_with("VTERMINAL_SHELL_SCOPE=")
                || line.starts_with("__vterminal_shell_token=")));
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
