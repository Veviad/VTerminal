import type { RemoteContext } from "./types";

// Detecting "the visible tab is no longer talking to the local shell".
//
// This matters because the shell integration lives in the app's generated
// $ZDOTDIR and therefore only runs on the LOCAL shell. The moment the user runs
// `ssh host`, OSC 7/133 stop arriving, so `sessionUi.cwd` freezes at whatever
// local directory was last reported — and sending that to the model as the
// current working directory is worse than sending nothing.
//
// Detection is command-shape based: while a nesting command's block is open, we
// are inside it. That is exactly as long as the nested session lasts, because
// the local shell cannot print its next prompt until `ssh` exits.

interface NestingRule {
  kind: string;
  /** Matches the command word(s) that open a nested session. */
  pattern: RegExp;
  /** Args to skip past when hunting for the target (flags are skipped anyway). */
  skipWords: number;
}

const RULES: NestingRule[] = [
  { kind: "ssh", pattern: /^ssh$/, skipWords: 0 },
  { kind: "ssh", pattern: /^mosh$/, skipWords: 0 },
  { kind: "ssh", pattern: /^et$/, skipWords: 0 },
  { kind: "vagrant", pattern: /^vagrant$/, skipWords: 1 },
  { kind: "docker", pattern: /^(docker|podman|nerdctl)$/, skipWords: 1 },
  { kind: "kubectl", pattern: /^(kubectl|oc)$/, skipWords: 1 },
  { kind: "container", pattern: /^(distrobox|toolbox|lima|colima)$/, skipWords: 1 },
  { kind: "nix", pattern: /^(nix-shell|nix)$/, skipWords: 0 },
];

/** Subcommands that actually open an interactive session (vs. `docker ps`). */
const INTERACTIVE_SUBCOMMANDS = /^(exec|attach|run|shell|enter|ssh|login)$/;

/**
 * Returns the nested-session descriptor for a command line, or null if the
 * command runs locally. Deliberately conservative: a false positive would
 * suppress genuinely-correct local context.
 */
export function detectNesting(command: string): RemoteContext | null {
  const words = tokenizeCommand(command);
  if (words.length === 0) return null;

  // Skip leading env assignments (`FOO=bar ssh host`) and `sudo`/`command`.
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === "sudo")) {
    i++;
  }
  if (i >= words.length) return null;

  const head = words[i].split("/").pop() ?? words[i];
  const rule = RULES.find((r) => r.pattern.test(head));
  if (!rule) return null;

  const rest = words.slice(i + 1);
  if (rule.skipWords > 0) {
    // `docker exec -it web sh` nests; `docker ps` does not.
    const sub = rest.find((w) => !w.startsWith("-"));
    if (!sub || !INTERACTIVE_SUBCOMMANDS.test(sub)) return null;
  }

  return { kind: rule.kind, target: firstNonFlag(rest, rule.skipWords) };
}

/** ssh/scp short options that take a separate value (`-i key`, `-p 22`). Getting
 *  this wrong makes the key file look like the hostname. */
const VALUE_FLAGS = /^-[bcDEeFIiJLlmOopQRSWw]$/;

/** First bare argument after the subcommand, ignoring flags and their values.
 *
 *  Exported so `lib/ssh.ts` can validate a saved host's extra args with the
 *  SAME parser that will later read the assembled command line — "what we
 *  accept" and "what detectNesting understands" must not drift apart. */
export function firstNonFlag(words: string[], skipWords: number): string | null {
  let skipped = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      // `--user=root` carries its own value; `--user root` and `-i key` eat the
      // next word. Bundled short flags (`-it`) never do.
      const takesValue = w.includes("=")
        ? false
        : /^--/.test(w) || VALUE_FLAGS.test(w);
      if (takesValue && i + 1 < words.length) i++;
      continue;
    }
    if (skipped < skipWords) {
      skipped++;
      continue;
    }
    return w;
  }
  return null;
}

/** Split on whitespace, honoring simple quoting so `ssh "my host"` stays whole. */
export function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** Human label for the approval card / status bar, e.g. `ssh prod-01`. */
export function describeRemote(remote: RemoteContext | null): string | null {
  if (!remote) return null;
  return remote.target ? `${remote.kind} ${remote.target}` : remote.kind;
}
