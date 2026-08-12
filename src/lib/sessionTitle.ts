// Tab labels are derived at render time, never stored. The old design wrote
// basename($PWD) into `Session.title` on every OSC 7, which named every fresh
// tab after the user's home directory — i.e. after the username.
import { describeRemote } from "./nesting";
import type { Session } from "./types";
import type { SessionUiState } from "../stores/appStore";

/** macOS-only app, so the home prefix is a constant rather than an env lookup. */
const HOME_PREFIX = "/Users/";

/** Runners whose first word says nothing on its own — `npm`, `git` and friends
 *  need their subcommand to be a useful tab label. */
const RUNNERS = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "git",
  "docker",
  "kubectl",
  "make",
  "python",
  "python3",
  "node",
  "go",
  "brew",
  "poetry",
  "uv",
]);

const MAX_COMMAND_LABEL = 20;

/** `/Users/me/src/app` → `~/src/app`, `/Users/me` → `~`. Shared with the status
 *  bar so the two surfaces can never disagree about what home looks like. */
export function collapseHome(path: string): string {
  if (!path.startsWith(HOME_PREFIX)) return path;
  const rest = path.slice(HOME_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? "~" : `~${rest.slice(slash)}`;
}

/** The directory component of a tab label: `~` at home, else the leaf. */
export function cwdLabel(cwd: string | null): string | null {
  if (!cwd) return null;
  const collapsed = collapseHome(cwd);
  if (collapsed === "~") return "~";
  const leaf = collapsed.split("/").filter(Boolean).pop();
  return leaf ?? "/";
}

/** Command → short tab label: `sudo FOO=1 npm run dev --port 3` → `npm run`.
 *  Env assignments and `sudo` carry no information about what is running. */
export function shortenCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && (tokens[i] === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
    i++;
  }
  const head = tokens[i];
  if (!head) return null;
  // A path invocation (./server, /usr/bin/vim) reads better as its basename.
  const name = head.includes("/") ? (head.split("/").filter(Boolean).pop() ?? head) : head;
  // Only take a second word for runners, and only if it is not a flag.
  const next = tokens[i + 1];
  const label =
    RUNNERS.has(name) && next && !next.startsWith("-") ? `${name} ${next}` : name;
  return label.length > MAX_COMMAND_LABEL ? label.slice(0, MAX_COMMAND_LABEL - 1) + "…" : label;
}

/** The one place a tab's label is decided. Priority, first non-empty wins:
 *
 *  1. `userTitle`        — an explicit rename outranks everything.
 *  2. live remote        — being inside `ssh prod-01` is the most important
 *                          thing about a tab while it lasts.
 *  3. `hostLabel`        — same identity, connection gone.
 *  4. `aiTitle`          — a name, so it beats derived state.
 *  5. running command    — only once it has run long enough to matter.
 *  6. cwd                — `~` at home, else the leaf directory.
 *  7. `Shell <ordinal>`  — no integration, no cwd, nothing else to say.
 */
export function resolveSessionTitle(session: Session, ui: SessionUiState | undefined): string {
  return (
    session.userTitle ||
    ui?.remoteHost?.label ||
    (ui?.remote ? describeRemote(ui.remote) : null) ||
    session.hostLabel ||
    session.aiTitle ||
    ui?.longRunningCommand ||
    cwdLabel(ui?.cwd ?? session.cwd) ||
    `Shell ${session.ordinal}`
  );
}

/** Smallest unused positive integer, so closing a tab never renumbers the rest. */
export function nextOrdinal(sessions: readonly Session[]): number {
  const used = new Set(sessions.map((s) => s.ordinal));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
