use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, Wry};

/// Bump when any generated file changes — the zdotdir is rewritten whenever
/// the version marker in the existing vterminal.zsh differs.
const SCRIPT_VERSION: &str = "5";

#[derive(Serialize)]
pub struct ShellIntegrationInfo {
    pub enabled: bool,
    pub zdotdir_path: Option<String>,
    pub script_version: String,
}

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
            std::fs::write(dir.join(name), content.replace("__VERSION__", SCRIPT_VERSION))
                .map_err(|e| format!("write {name}: {e}"))
        };
        write("vterminal.zsh", VTERMINAL_ZSH)?;
        write(".zshenv", ZSHENV)?;
        write(".zprofile", ZPROFILE)?;
        write(".zshrc", ZSHRC)?;
    }
    Ok(dir)
}

#[tauri::command]
pub fn shell_integration_status(app: tauri::AppHandle<Wry>) -> Result<ShellIntegrationInfo, String> {
    let enabled = super::settings::read_bool(&app, "shell_integration_enabled", true);
    let zdotdir_path = if enabled {
        ensure_zdotdir(&app).ok().map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };
    Ok(ShellIntegrationInfo {
        enabled,
        zdotdir_path,
        script_version: SCRIPT_VERSION.to_string(),
    })
}
