// Shell strings and token parsing for running agent commands in the live PTY.
//
// Pure and dependency-free on purpose: everything here is a string in, string
// out, so it can be unit-tested without xterm, Tauri, or a real shell.
//
// SECURITY NOTE (the reason sanitizeCommand exists): bytes we write to the PTY
// are echoed by the tty and parsed by xterm on the way back. A command
// containing a raw OSC sequence could therefore FORGE its own completion token
// and make the agent believe a command succeeded when it never ran. Control
// characters are rejected outright rather than escaped.

export type ExecMode = "integrated" | "hook" | "sentinel";

/** Private OSC 6973 subtypes. `CMD;` is the shell integration's own and is
 *  handled by BlockTracker; everything here is the remote-exec channel. */
export type PrivateToken =
  | { t: "RS"; zsh: string; bash: string; fish: string; installed: boolean }
  | { t: "RH"; nonce: string; shell: string }
  | { t: "RD"; exit: number | null; arg: string };

/**
 * Probe line. Valid syntax in zsh, bash, dash/sh AND fish, so it cannot spray a
 * syntax error into the user's terminal. Its real job is binary: if no RS comes
 * back, there is no shell in the foreground at all (a pager, a REPL, a
 * half-finished quote) and we must not type a command.
 *
 * `\033`/`\007` rather than `\e`/`ESC \`: `\e` is not POSIX printf, and BEL
 * avoids the doubled-backslash ST terminator entirely.
 */
export const PROBE = `printf '\\033]6973;RS;%s;%s;%s;%s\\007' "$ZSH_VERSION" "$BASH_VERSION" "$FISH_VERSION" "$VV_RX"`;

/**
 * One-time, in-memory exit-code hook for a remote shell. Writes NOTHING to the
 * remote host's disk and dies with the session.
 *
 * Deliberate choices:
 *  - Emits ONLY a private OSC 6973 token, never OSC 133/OSC 7. A remote `133;A`
 *    would close the enclosing `ssh` block in the local BlockTracker (exit 0,
 *    bogus history row) and remote OSC 7 would overwrite the local cwd.
 *  - Never touches PS1 — that is what breaks powerlevel10k/starship.
 *  - PREPENDS itself to the hook list, so `$?` is the user's command status
 *    rather than whatever the previously-registered hook returned.
 *  - `VV_RX` is intentionally NOT exported: a nested shell installs its own.
 *  - No literal ESC byte appears in the line; `printf` builds it at runtime, so
 *    the echo of this line cannot be mistaken for a real handshake.
 */
export function installerFor(shell: "zsh" | "bash", nonce: string): string {
  if (shell === "zsh") {
    return (
      `[ -n "$VV_RX" ] || { __vv_pc(){ printf '\\033]6973;RD;%s;%s\\007' "$?" "$PWD"; }; ` +
      `precmd_functions=(__vv_pc ${"${precmd_functions:#__vv_pc}"}); VV_RX=1; }; ` +
      `printf '\\033]6973;RH;${nonce};zsh\\007'`
    );
  }
  return (
    `[ -n "$VV_RX" ] || { __vv_pc(){ local e=$?; printf '\\033]6973;RD;%s;%s\\007' "$e" "$PWD"; return $e; }; ` +
    // bash 5.1 allows an ARRAY PROMPT_COMMAND; assigning a string would destroy it.
    `case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in *"declare -a"*) PROMPT_COMMAND=(__vv_pc "\${PROMPT_COMMAND[@]}");; ` +
    `*) PROMPT_COMMAND="__vv_pc\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; VV_RX=1; }; ` +
    `printf '\\033]6973;RH;${nonce};bash\\007'`
  );
}

/**
 * Fallback for shells with no usable prompt hook (sh/dash, fish). Appended to
 * the command itself, so it is visible on the command line — the cost of
 * working anywhere. `$?` expands before printf runs, so it is the command's
 * status, not printf's.
 */
export function sentinelSuffix(kind: "posix" | "fish", nonce: string): string {
  const status = kind === "fish" ? "$status" : "$?";
  return `; printf '\\033]6973;RD;%s;${nonce}\\007' ${status}`;
}

/**
 * Environment that makes a TTY-attached command behave like a piped one.
 *
 * The pager is the biggest self-inflicted agent hang: `git log`, `journalctl`
 * and `systemctl status` all page when stdout is a TTY, and the agent has no way
 * to press `q`. `LESS=FRX` covers tools that invoke `less` directly — quit if it
 * fits one screen, keep colour, and skip the termcap init so nothing is stranded
 * on the alternate screen.
 *
 * KNOWN LIMIT: sudo's `env_reset` drops all of this, so `sudo systemctl status`
 * can still page. That case is caught downstream instead — the stall classifier
 * surfaces it and `prompts::AGENT` asks for `--no-pager`.
 */
const HARDEN_ENV =
  "PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat SYSTEMD_PAGELESS=1 LESS=FRX DEBIAN_FRONTEND=noninteractive";

/** Reserved words a `VAR=v ` prefix cannot precede — `A=1 if …` is a syntax error. */
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "function", "select", "time", "coproc", "!",
]);

/** A `&` that is neither `&&` nor an fd-dup (`2>&1`): job control. */
const BARE_AMP = /(^|[^&>])&(?!&)/;

export interface HardenedCommand {
  /** What to type. Never has a sentinel appended — that is the caller's job. */
  line: string;
  /** Which guards were applied, for the UI note. Empty when nothing changed. */
  applied: ("pager" | "stdin")[];
}

/**
 * Wrap an approved command so the two avoidable TTY hangs cannot happen.
 *
 * Both guards attach to ONE command, which is why the exclusions look fussy: an
 * env prefix binds to the first command of a chain and a trailing redirect binds
 * to the last, so `a && b` can only ever be half-covered. A simple command gets
 * both guards; a pipeline gets the pager guard only (its first stage is the one
 * that could page, and a trailing redirect would sever the pipe — see
 * `canRedirectStdin`); anything else is left verbatim for the mid-flight
 * detector to handle.
 */
export function hardenCommand(command: string): HardenedCommand {
  const applied: HardenedCommand["applied"] = [];
  let line = command;

  if (canPrefixEnv(command)) {
    line = `${HARDEN_ENV} ${line}`;
    applied.push("pager");
  }
  if (canRedirectStdin(command)) {
    line = `${line} < /dev/null`;
    applied.push("stdin");
  }
  return { line, applied };
}

/** Whether a `VAR=v ` prefix is valid AND has no side effect on the shell. */
function canPrefixEnv(command: string): boolean {
  const head = command.trimStart();
  // A compound command's env has to be set inside it, not in front of it.
  if (head.startsWith("(") || head.startsWith("{")) return false;
  const first = /^[^\s;|&<>]+/.exec(head)?.[0] ?? "";
  if (SHELL_KEYWORDS.has(first)) return false;
  // The command already opens with its own assignment. Prefixing an
  // assignment-ONLY line (`FOO=bar`) would leak PAGER=cat into the user's shell
  // permanently, and `FOO=bar cmd` means the model is managing env itself.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return false;
  return true;
}

/** Whether `< /dev/null` can be appended without changing what it binds to. */
function canRedirectStdin(command: string): boolean {
  if (command.includes("<") || command.includes(";")) return false;
  if (command.includes("&&") || command.includes("||")) return false;
  // A trailing redirect binds to a pipeline's LAST stage — the one stage that
  // MUST read the pipe. In bash/sh/dash the explicit redirect wins and the
  // pipeline silently produces nothing; zsh happens to let the pipe win, which
  // is the only reason this ever looked fine locally (VTerminal spawns zsh,
  // but the agent's commands run in whatever shell the tab is in — over ssh
  // that is usually bash). Nothing is lost by skipping it: the guard exists to
  // stop a command waiting on the TTY, and a pipeline's last stage reads the
  // pipe, never the TTY.
  if (command.includes("|")) return false;
  if (BARE_AMP.test(command)) return false;
  // Same structural hazards as appending a sentinel: heredocs, line
  // continuations, unbalanced quotes.
  return canSentinel(command);
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const MAX_COMMAND_LEN = 4096;

export type SanitizeResult =
  | { ok: true; command: string }
  | { ok: false; reason: string };

/**
 * Gate every byte before it reaches the PTY.
 *
 * Rejections, and why each one matters here specifically:
 *  - ESC: could forge a completion token (see file header).
 *  - \n / \r: split one approved command into several unapproved ones.
 *  - \t: triggers shell completion instead of typing a tab.
 *  - \x03 etc.: Ctrl-C and friends are signals, not text.
 */
export function sanitizeCommand(raw: string): SanitizeResult {
  const command = raw.trim();
  if (!command) return { ok: false, reason: "the command was empty" };
  if (command.length > MAX_COMMAND_LEN) {
    return { ok: false, reason: `the command exceeds ${MAX_COMMAND_LEN} characters` };
  }
  if (CONTROL_CHARS.test(command)) {
    return {
      ok: false,
      reason:
        "the command contains control characters (newline, tab, or an escape sequence), which cannot be typed into a live terminal safely",
    };
  }
  return { ok: true, command };
}

/**
 * Whether `; printf …` can be appended safely. A heredoc would swallow the
 * sentinel into its body and hang forever waiting for the delimiter; a trailing
 * backslash or an unbalanced quote would splice it into the command instead.
 */
export function canSentinel(command: string): boolean {
  if (command.includes("<<")) return false;
  if (/\\$/.test(command)) return false;
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && double) {
      i++;
      continue;
    }
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
  }
  return !single && !double;
}

/** Parse an OSC 6973 payload that is not `CMD;`. Returns null when unknown. */
export function parsePrivateToken(payload: string): PrivateToken | null {
  const parts = payload.split(";");
  switch (parts[0]) {
    case "RS":
      return {
        t: "RS",
        zsh: parts[1] ?? "",
        bash: parts[2] ?? "",
        fish: parts[3] ?? "",
        installed: (parts[4] ?? "") !== "",
      };
    case "RH":
      return { t: "RH", nonce: parts[1] ?? "", shell: parts[2] ?? "" };
    case "RD": {
      const exit = Number.parseInt(parts[1] ?? "", 10);
      return { t: "RD", exit: Number.isNaN(exit) ? null : exit, arg: parts[2] ?? "" };
    }
    default:
      return null;
  }
}

/** Which installer (if any) suits the shell the probe reported. */
export function shellFromProbe(rs: Extract<PrivateToken, { t: "RS" }>): "zsh" | "bash" | null {
  if (rs.zsh) return "zsh";
  if (rs.bash) return "bash";
  return null;
}
