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

export type ExecMode = "integrated" | "sentinel";
export type ShellDialect = "posix" | "fish";

/**
 * Group a private command in the current interactive shell and discard both
 * output streams. Grouping is deliberate: exports and other shell mutations
 * remain available to later private commands in the same session.
 */
export function suppressPrivateOutput(command: string, dialect: ShellDialect): string {
  const quoted = `'${command.replaceAll("'", `'"'"'`)}'`;
  return dialect === "fish"
    ? `begin; eval ${quoted}; end >/dev/null 2>/dev/null`
    : `{ eval ${quoted}; } >/dev/null 2>/dev/null`;
}

/** Private OSC 6973 subtypes. `CMD;` is the shell integration's own and is
 *  handled by BlockTracker; everything here is the remote-exec channel. */
export type PrivateToken =
  | { t: "RP"; nonce: string; zsh: string; bash: string; fish: string }
  | { t: "RD"; exit: number; arg: string };

/**
 * Build a nonce-bound probe line. Valid syntax in zsh, bash, dash/sh AND fish,
 * so it cannot spray a syntax error into the user's terminal. Its real job is
 * binary: if no matching RP comes back, there is no shell in the foreground at
 * all (a pager, a REPL, a half-finished quote) and we must not type a command.
 *
 * `\033`/`\007` rather than `\e`/`ESC \`: `\e` is not POSIX printf, and BEL
 * avoids the doubled-backslash ST terminator entirely.
 */
export function probeFor(nonce: string): string {
  assertNonce(nonce);
  // Prefix each value so fish preserves an argument for unset variables. Fish
  // otherwise expands a quoted unset list variable to zero arguments, which
  // would shift FISH_VERSION into the zsh field.
  return `printf '\\033]6973;RP;${nonce};%s;%s;%s\\007' "z$ZSH_VERSION" "b$BASH_VERSION" "f$FISH_VERSION"`;
}

/**
 * Completion suffix for a remote shell. It is appended to the command itself,
 * so it is visible on the command line. `$?` expands before printf runs, so it
 * is the command's status, not printf's.
 */
export function sentinelSuffix(kind: "posix" | "fish", nonce: string): string {
  assertNonce(nonce);
  const status = kind === "fish" ? "$status" : "$?";
  return `; printf '\\033]6973;RD;%s;${nonce}\\007' ${status}`;
}

function assertNonce(nonce: string): void {
  if (!isNonce(nonce)) {
    throw new Error("PTY protocol nonces must be 128-bit lowercase hexadecimal values.");
  }
}

function isNonce(nonce: string): boolean {
  return /^[a-f0-9]{32}$/.test(nonce);
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
    if (/[\0-\x1f\x7f-\x9f]/.test(value)) {
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

// C0, DEL, and C1. C1 includes the single-byte OSC/ST forms, which xterm can
// interpret just like ESC ] / ESC \\ when the terminal is in an 8-bit mode.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;
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
 * sentinel into its body and hang forever waiting for the delimiter; an
 * unquoted comment could hide the sentinel; a trailing operator, backslash, or
 * unbalanced quote would splice it into the command instead. A background job
 * is also unsafe because the shell reports launch status, not process exit.
 */
export function canSentinel(command: string): boolean {
  if (command.includes("<<")) return false;
  if (/\\$/.test(command)) return false;
  if (CONTROL_CHARS.test(command)) return false;

  const scopes = scanShellStructure(command);
  if (!scopes) return false;
  return scopes.every((scope, index) => (
    hasCompleteTail(scope, index !== 0) && hasCompleteControlGrammar(scope)
  ));
}

type QuoteState = "single" | "double" | null;

interface ShellContext {
  close: ")" | "}" | "`";
  kind: "group" | "command" | "parameter" | "arithmetic" | "backtick";
  restoreQuote: QuoteState;
  restoreScope: number | null;
}

/**
 * Validate the shell constructs whose missing terminator would leave an
 * interactive shell waiting for more input. Each command substitution gets a
 * separate grammar scope so an unfinished `if` inside `$(...)` cannot hide
 * behind an otherwise complete outer command.
 */
function scanShellStructure(command: string): string[] | null {
  const scopes = [""];
  const contexts: ShellContext[] = [];
  let scope: number | null = 0;
  let quote: QuoteState = null;

  const append = (value: string) => {
    if (scope !== null) scopes[scope] += value;
  };
  const open = (
    close: ShellContext["close"],
    kind: ShellContext["kind"],
    nextScope: number | null,
  ) => {
    contexts.push({ close, kind, restoreQuote: quote, restoreScope: scope });
    quote = null;
    scope = nextScope;
  };
  const openCommandScope = (close: ")" | "`") => {
    append("q"); // The substitution is one ordinary word in its outer scope.
    const nested = scopes.push("") - 1;
    open(close, close === "`" ? "backtick" : "command", nested);
  };
  const close = (expected: ShellContext["close"]): boolean => {
    const context = contexts[contexts.length - 1];
    if (!context || context.close !== expected) return false;
    contexts.pop();
    if (context.kind === "group") append(expected);
    quote = context.restoreQuote;
    scope = context.restoreScope;
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";

    if (quote === "single") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === "double") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "`") {
        openCommandScope("`");
        continue;
      }
      if (ch === "$" && command[i + 1] === "(") {
        if (command[i + 2] === "(") {
          append("q");
          const outerScope = scope;
          open(")", "arithmetic", null);
          contexts.push({
            close: ")",
            kind: "arithmetic",
            restoreQuote: null,
            restoreScope: null,
          });
          // Only the outer arithmetic marker restores the quoted scope.
          contexts[contexts.length - 2]!.restoreScope = outerScope;
          i += 2;
        } else {
          openCommandScope(")");
          i++;
        }
        continue;
      }
      if (ch === "$" && command[i + 1] === "{") {
        append("q");
        open("}", "parameter", null);
        i++;
      }
      continue;
    }

    if (ch === "\\") {
      append("q");
      i++;
      continue;
    }
    if (ch === "'") {
      append("q");
      quote = "single";
      continue;
    }
    if (ch === '"') {
      append("q");
      quote = "double";
      continue;
    }
    if (ch === "`") {
      if (contexts[contexts.length - 1]?.close === "`") {
        if (!close("`")) return null;
      } else {
        openCommandScope("`");
      }
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      if (command[i + 2] === "(") {
        append("q");
        const outerScope = scope;
        open(")", "arithmetic", null);
        contexts.push({
          close: ")",
          kind: "arithmetic",
          restoreQuote: null,
          restoreScope: null,
        });
        contexts[contexts.length - 2]!.restoreScope = outerScope;
        i += 2;
      } else {
        openCommandScope(")");
        i++;
      }
      continue;
    }
    if (ch === "$" && command[i + 1] === "{") {
      append("q");
      open("}", "parameter", null);
      i++;
      continue;
    }
    if (
      ch === "#"
      && (i === 0 || /[\s;&|()<>]/.test(command[i - 1] ?? ""))
    ) {
      return null;
    }
    if (ch === "&") {
      const previous = command[i - 1] ?? "";
      const next = command[i + 1] ?? "";
      if (next === ">") return null;
      if (next === "&") {
        append("&&");
        i++;
        continue;
      }
      if (previous !== ">" && previous !== "<") return null;
    }
    if (ch === "(") {
      append(ch);
      open(")", "group", scope);
      continue;
    }
    if (ch === ")") {
      if (!close(")")) return null;
      continue;
    }
    if (ch === "{") {
      // Inside a parameter/arithmetic expression, braces still need balancing
      // even though their contents are not shell control grammar.
      if (scope === null || isStandaloneBrace(command, i)) {
        append(ch);
        open("}", scope === null ? "parameter" : "group", scope);
      } else {
        append(ch);
      }
      continue;
    }
    if (ch === "}") {
      if (contexts[contexts.length - 1]?.close === "}") {
        if (!close("}")) return null;
      } else if (isStandaloneBrace(command, i)) {
        return null;
      } else {
        append(ch);
      }
      continue;
    }
    append(ch);
  }

  return quote === null && contexts.length === 0 ? scopes : null;
}

function isStandaloneBrace(command: string, index: number): boolean {
  const boundary = (value: string | undefined) => value === undefined || /[\s;&|(){}<>]/.test(value);
  return boundary(command[index - 1]) && boundary(command[index + 1]);
}

/** Preserve the previous trailing-operator gate in each structural scope. */
function hasCompleteTail(command: string, allowTrailingSemicolon: boolean): boolean {
  let trailingOperator: "semicolon" | "other" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (/\s/.test(ch)) continue;
    if (ch === "&") {
      const previous = command[i - 1] ?? "";
      const next = command[i + 1] ?? "";
      if (next === "&") {
        trailingOperator = "other";
        i++;
      } else if (previous === ">" || previous === "<") {
        trailingOperator = "other";
      } else {
        return false;
      }
      continue;
    }
    if (ch === "|") {
      trailingOperator = "other";
      if (command[i + 1] === "|") i++;
      continue;
    }
    if (ch === ";") {
      trailingOperator = "semicolon";
      continue;
    }
    if (ch === ">" || ch === "<") {
      trailingOperator = "other";
      continue;
    }
    if (ch === ")" || ch === "}") {
      if (trailingOperator === "semicolon") trailingOperator = null;
    } else {
      trailingOperator = null;
    }
  }
  return trailingOperator === null || (allowTrailingSemicolon && trailingOperator === "semicolon");
}

type ControlFrame =
  | { kind: "if"; stage: "condition" | "body" }
  | { kind: "loop"; stage: "header" | "body" };

/** Reject incomplete multiline-style control grammar before it reaches a PTY. */
function hasCompleteControlGrammar(command: string): boolean {
  const tokens = command.match(/&&|\|\||[;|(){}<>]|[^\s;&|(){}<>]+/g) ?? [];
  if (tokens.some((token, index) => token === "(" && tokens[index + 1] === ")")) {
    // Empty parentheses are either an incomplete function declaration or an
    // invalid empty subshell. Both can keep an interactive parser at PS2.
    return false;
  }
  const frames: ControlFrame[] = [];
  let commandPosition = true;
  let conditionalTestOpen = false;

  for (const token of tokens) {
    if (conditionalTestOpen) {
      if (token === "]]") {
        conditionalTestOpen = false;
        commandPosition = false;
      }
      continue;
    }
    if ([";", "&&", "||", "|", "(", "{"].includes(token)) {
      commandPosition = true;
      continue;
    }
    if (token === ")" || token === "}") {
      commandPosition = false;
      continue;
    }
    if (token === "<" || token === ">") continue;
    if (!commandPosition) continue;

    const top = frames[frames.length - 1];
    switch (token) {
      case "[[":
        conditionalTestOpen = true;
        commandPosition = false;
        break;
      // `case` pattern closers are indistinguishable from grouping without a
      // full shell parser. Reject the construct conservatively so both complete
      // and unfinished forms are rewritten into a simpler one-line command.
      case "case":
      case "function":
      case "coproc":
      case "begin":
      case "switch":
      case "!":
      case "time":
        return false;
      case "if":
        frames.push({ kind: "if", stage: "condition" });
        commandPosition = true;
        break;
      case "then":
        if (!top || top.kind !== "if" || top.stage !== "condition") return false;
        top.stage = "body";
        commandPosition = true;
        break;
      case "elif":
        if (!top || top.kind !== "if" || top.stage !== "body") return false;
        top.stage = "condition";
        commandPosition = true;
        break;
      case "else":
        if (!top || top.kind !== "if" || top.stage !== "body") return false;
        commandPosition = true;
        break;
      case "fi":
        if (!top || top.kind !== "if" || top.stage !== "body") return false;
        frames.pop();
        commandPosition = false;
        break;
      case "for":
      case "select":
        frames.push({ kind: "loop", stage: "header" });
        commandPosition = false;
        break;
      case "while":
      case "until":
        frames.push({ kind: "loop", stage: "header" });
        commandPosition = true;
        break;
      case "do":
        if (!top || top.kind !== "loop" || top.stage !== "header") return false;
        top.stage = "body";
        commandPosition = true;
        break;
      case "done":
        if (!top || top.kind !== "loop" || top.stage !== "body") return false;
        frames.pop();
        commandPosition = false;
        break;
      default:
        commandPosition = false;
    }
  }
  return frames.length === 0 && !conditionalTestOpen;
}

/** Parse an OSC 6973 payload that is not `CMD;`. Returns null when unknown. */
export function parsePrivateToken(payload: string): PrivateToken | null {
  const parts = payload.split(";");
  switch (parts[0]) {
    case "RP": {
      if (parts.length !== 5 || !isNonce(parts[1] ?? "")) return null;
      if (
        !parts[2]?.startsWith("z") ||
        !parts[3]?.startsWith("b") ||
        !parts[4]?.startsWith("f")
      ) {
        return null;
      }
      return {
        t: "RP",
        nonce: parts[1],
        zsh: probeValue(parts[2], "z"),
        bash: probeValue(parts[3], "b"),
        fish: probeValue(parts[4], "f"),
      };
    }
    case "RD": {
      if (parts.length !== 3 || !/^(?:0|[1-9]\d{0,2})$/.test(parts[1] ?? "")) return null;
      const exit = Number(parts[1]);
      const nonce = parts[2] ?? "";
      if (exit > 255 || !isNonce(nonce)) return null;
      return { t: "RD", exit, arg: nonce };
    }
    default:
      return null;
  }
}

function probeValue(value: string | undefined, prefix: string): string {
  return value?.startsWith(prefix) ? value.slice(1) : "";
}

/** Which sentinel syntax suits the shell the nonce-bound probe reported. */
export function dialectFromProbe(
  probe: Extract<PrivateToken, { t: "RP" }>,
): ShellDialect {
  return probe.fish ? "fish" : "posix";
}
