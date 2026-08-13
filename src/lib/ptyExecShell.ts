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
export const PROBE = `/usr/bin/printf '\\033]6973;RS;%s;%s;%s;%s\\007' "$ZSH_VERSION" "$BASH_VERSION" "$FISH_VERSION" "$VV_RX"`;

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
      `[ -n "$VV_RX" ] || { __vv_pc(){ /usr/bin/printf '\\033]6973;RD;%s;%s\\007' "$?" "$PWD"; }; ` +
      `precmd_functions=(__vv_pc ${"${precmd_functions:#__vv_pc}"}); VV_RX=1; }; ` +
      `/usr/bin/printf '\\033]6973;RH;${nonce};zsh\\007'`
    );
  }
  return (
    `[ -n "$VV_RX" ] || { __vv_pc(){ local e=$?; /usr/bin/printf '\\033]6973;RD;%s;%s\\007' "$e" "$PWD"; return $e; }; ` +
    // bash 5.1 allows an ARRAY PROMPT_COMMAND; assigning a string would destroy it.
    `case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in *"declare -a"*) PROMPT_COMMAND=(__vv_pc "\${PROMPT_COMMAND[@]}");; ` +
    `*) PROMPT_COMMAND="__vv_pc\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac; VV_RX=1; }; ` +
    `/usr/bin/printf '\\033]6973;RH;${nonce};bash\\007'`
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
  return `; /usr/bin/printf '\\033]6973;RD;%s;${nonce}\\007' ${status}`;
}

/** Commands whose own pager environment is safer than a global `PAGER=cat`. */
const SYSTEMD_PAGER_COMMANDS = new Set([
  "busctl",
  "coredumpctl",
  "hostnamectl",
  "journalctl",
  "localectl",
  "loginctl",
  "machinectl",
  "networkctl",
  "resolvectl",
  "systemctl",
  "systemd-analyze",
  "timedatectl",
]);

/** Debian tools that may invoke debconf while an AI command owns the TTY. */
const DEBIAN_COMMANDS = new Set(["apt", "apt-get", "aptitude", "dpkg"]);

/** Reserved words the pager guard cannot precede — `A=1 if …` is a syntax error. */
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
 * Attach validated Runbook inputs to a child shell without mutating the user's
 * interactive shell. Argument expansion in the parent happens before temporary
 * assignments take effect, so `VRUN_X=v command "$VRUN_X"` is incorrect. The
 * child-shell wrapper also works when the approved command begins with `if`.
 */
export function prefixCommandEnvironment(
  command: string,
  environment: Record<string, string>,
): string {
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return command;
  const assignments = entries.map(([name, value]) => {
    if (!/^VRUN_[A-Za-z0-9_]+$/.test(name)) {
      throw new Error(`Invalid runbook environment variable: ${name}`);
    }
    if (/[\0-\x1f\x7f]/.test(value)) {
      throw new Error(`Runbook environment value for ${name} contains control characters.`);
    }
    return `${name}='${value.replaceAll("'", `'"'"'`)}'`;
  });
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const line = `env ${assignments.join(" ")} /bin/sh -c ${quote(command)}`;
  if (line.length > 4_096) {
    throw new Error("Runbook command plus its input environment exceeds 4,096 characters.");
  }
  return line;
}

/**
 * Wrap an approved command so the two avoidable TTY hangs cannot happen.
 *
 * Both guards attach to ONE command, which is why the exclusions look fussy: an
 * env prefix binds to the first command of a chain and a trailing redirect binds
 * to the last, so `a && b` can only ever be half-covered. A simple command gets
 * both guards; a pipeline may get an environment guard on its first stage but
 * never a trailing redirect, which would sever the pipe (see
 * `canRedirectStdin`). Anything else is left verbatim for the mid-flight
 * detector to handle.
 */
export function hardenCommand(command: string): HardenedCommand {
  const applied: HardenedCommand["applied"] = [];
  let line = command;

  const env = hardeningEnv(command);
  if (env) {
    line = `${env} ${line}`;
    applied.push("pager");
  }
  if (canRedirectStdin(command)) {
    line = `${line} < /dev/null`;
    applied.push("stdin");
  }
  return { line, applied };
}

/**
 * Return the smallest environment guard needed by the first command, or null.
 *
 * An environment assignment before a pipeline applies only to its first stage,
 * so that is the only stage classified here. Compound command lists are left
 * alone: a prefix would cover only one branch while making the visible command
 * look fully guarded. `sudo` is deliberately not unwrapped because its
 * `env_reset` commonly discards caller-provided values; the agent prompt tells
 * it to use explicit `--no-pager` and non-interactive flags in that case.
 */
function hardeningEnv(command: string): string | null {
  const head = command.trimStart();
  if (head.startsWith("(") || head.startsWith("{")) return null;
  if (command.includes(";") || command.includes("&&") || command.includes("||")) return null;
  if (BARE_AMP.test(command)) return null;

  const first = /^[^\s;|&<>]+/.exec(head)?.[0] ?? "";
  if (!first || SHELL_KEYWORDS.has(first)) return null;
  // The command already opens with its own assignment. Prefixing an
  // assignment-only line (`FOO=bar`) would leak the guard into the user's shell
  // permanently, and `FOO=bar cmd` means the model is managing env itself.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;

  const executable = first.slice(first.lastIndexOf("/") + 1);
  if (executable === "git") return "GIT_PAGER=cat";
  if (SYSTEMD_PAGER_COMMANDS.has(executable)) return "SYSTEMD_PAGER=cat";
  if (DEBIAN_COMMANDS.has(executable) || executable.startsWith("debconf-")) {
    return "DEBIAN_FRONTEND=noninteractive";
  }
  return null;
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
