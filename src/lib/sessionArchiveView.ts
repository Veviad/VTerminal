/**
 * How an archived session reads in a list.
 *
 * Separate from `sessionArchive.ts` (which writes) and from the component (which
 * renders) so the formatting rules are unit-testable without a DOM. They are
 * rules, not cosmetics: what identifies a session at a glance, and what must NOT
 * be shown because it would be a lie.
 */

import { S } from "./strings";
import type { ArchiveSummary } from "./types";

/** `/Users/me/Code/proj` -> `~/Code/proj`. */
export function collapseHome(path: string): string {
  // No `os.homedir()` in a browser context, and the archive stores absolute
  // paths, so match the shape rather than the actual home directory.
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(path);
  return m ? `~${m[1] ?? ""}` : path;
}

/** The last path segment, for the fallback label. */
function leaf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/**
 * The row's title.
 *
 * The fallback chain is not optional: a derived label is deliberately stored as
 * `""` (so it is re-derived on reopen rather than pinned forever), which means
 * most rows arrive with no title at all.
 */
export function sessionLabel(r: ArchiveSummary): string {
  if (r.title) return r.title;
  if (r.remote_target) return r.remote_target;
  if (r.cwd) return leaf(r.cwd);
  return S.sessions.untitled;
}

/**
 * The row's second line: `~/Code/proj · 12 cmds · 8 AI · 1420 lines · Opus 5`
 *
 * `modelLabel` is passed in rather than looked up, so this stays pure.
 */
export function metaLine(r: ArchiveSummary, modelLabel: string | null): string {
  const parts: string[] = [];

  // Where it ran is the strongest identifier — but for a remote session the
  // stored cwd describes ANOTHER MACHINE, so it is withheld in favour of the
  // target. Same rule the AI context and the session title already follow.
  if (r.remote_target) parts.push(`${r.remote_kind ?? "ssh"} ${r.remote_target}`);
  else if (r.cwd) parts.push(collapseHome(r.cwd));

  if (r.history_command_count > 0) parts.push(`${r.history_command_count} ${S.sessions.commands}`);
  if (r.message_count > 0) parts.push(`${r.message_count} ${S.sessions.aiMessages}`);
  else parts.push(S.sessions.noAiChat);

  // Never conditional: the ABSENCE of output is what the user needs to know
  // BEFORE clicking Reopen, not after the screen comes back empty. Plain text
  // rather than a warning colour — capture being off is a setting, not a fault.
  parts.push(
    r.scrollback_lines > 0 ? `${r.scrollback_lines} ${S.sessions.lines}` : S.sessions.noOutput,
  );

  if (r.close_reason === "crash") parts.push(S.sessions.crashed);

  // Last, so it is the first thing `truncate` eats — and only when there is a
  // transcript, because the model that answered is part of what a transcript IS.
  if (modelLabel && r.message_count > 0) parts.push(modelLabel);

  return parts.join(" · ");
}
