/**
 * Turning a live session into an archive row.
 *
 * WHY THIS IS NOT PART OF sessionPersistence: the two stores have different
 * lifetimes and different jobs. A snapshot describes the workspace as it is NOW
 * so the next boot can rebuild it, and it is swept the moment a tab closes. An
 * archive row is the tombstone of a finished run, kept until a retention limit
 * bites. The snapshot is written constantly and read once; the archive is written
 * at the end and read on demand.
 *
 * The row is built from LIVE state rather than copied out of `session_snapshots`.
 * Two reasons: a stored snapshot's blob is up to 15s stale and its metadata up to
 * 5s (see the debounce constants next door), and a user reopening a session
 * expects what was on screen when it closed — not what happened to be captured
 * fifteen seconds earlier. Copying would also couple the archive to the
 * mark-and-sweep, which deletes the row within ~750ms of a close.
 */

import * as api from "./tauri";
import { useAppStore } from "../stores/appStore";
import { getTerm, serializeSession } from "./termRegistry";
import type { AiMessage, ArchiveMessageInput, ArchiveSessionInput } from "./types";
import { isRunbookTerminalProtected } from "./runbookTerminalPrivacy";

/**
 * Budget for the archive write on the close path.
 *
 * `closeSession` awaits this before disposing the terminal, so a slow write is a
 * tab that will not close. `archive_put` contends for the same DB mutex as the
 * ~750ms snapshot tick, so contention is normal rather than exceptional. Losing
 * one archive row beats a UI that hangs — the same trade the final-flush watchdog
 * already makes at quit.
 */
const CLOSE_BUDGET_MS = 500;

/** What the model saw, per card, matching MODEL_TAIL in ptyExec.ts. */
const CARD_OUTPUT_TAIL = 8_192;

/**
 * `AiMessage[]` -> the archive's display shape.
 *
 * Pure and exported for its own test. Note it keeps `content: ""` command cards:
 * their payload lives in `command`, and dropping them would archive an agent run
 * as a conversation in which no commands were ever proposed.
 */
export function toArchiveMessages(messages: AiMessage[]): ArchiveMessageInput[] {
  return messages.map((m) => ({
    role: m.role,
    kind: m.kind ?? "text",
    content: m.content,
    thinking: m.thinking ?? null,
    command: m.command
      ? {
          command: m.command.command,
          // Tail, not head: the end of a command's output is what says whether it
          // worked. Rust caps this again — that is the guarantee, this is the
          // courtesy that keeps the IPC payload small.
          output: m.command.output.slice(-CARD_OUTPUT_TAIL),
          exit_code: m.command.exitCode,
          status: m.command.status,
          note: m.command.note ?? null,
        }
      : null,
    // Metadata and the disk path only. `data`/`text` are deliberately absent:
    // the bytes are already on disk (written by `attachment_put` at send time)
    // and a text file's contents were folded into `content`, so sending either
    // here would duplicate the transcript inside a 500ms close budget.
    attachments: m.attachments?.length
      ? m.attachments.map((a) => ({
          kind: a.kind,
          name: a.name,
          media_type: a.mediaType,
          bytes: a.bytes,
          path: a.path ?? null,
          width: a.width ?? null,
          height: a.height ?? null,
        }))
      : null,
    created_at: m.createdAt,
  }));
}

interface BuildOpts {
  /** false on close/quit, true for the periodic transcript tick. */
  isOpen: boolean;
  closeReason: "closed" | "quit" | "crash" | null;
  /** Capture the terminal buffer. Skipped by the transcript-only tick, which
   *  would otherwise serialize megabytes every few seconds for nothing. */
  withScrollback: boolean;
  /** Include the AI transcript. Both halves are independently optional so each
   *  writer ships only what it actually knows. */
  withTranscript: boolean;
}

/**
 * Build one archive row from live state. Returns null if the session is gone.
 *
 * `null` for `scrollback` / `messages` / `model_transcript` means "keep whatever
 * is stored" on the Rust side — the same COALESCE contract `workspace_snapshot`
 * uses, and what lets the cheap tick and the full close write share a table.
 */
export function buildArchiveRow(
  sessionId: string,
  opts: BuildOpts,
): ArchiveSessionInput | null {
  const state = useAppStore.getState();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return null;

  const ui = state.sessionUi[sessionId];
  const stream = state.aiStreams[sessionId];
  const entry = getTerm(sessionId);
  const maxLines = state.restoreScrollbackLines;

  let scrollback: string | null = null;
  let scrollbackLines: number | null = null;
  if (opts.withScrollback && isRunbookTerminalProtected(sessionId)) {
    // Empty actively clears any older archived blob. `null` would preserve it
    // through the Rust COALESCE update and undermine the sticky privacy gate.
    scrollback = "";
    scrollbackLines = 0;
  } else if (opts.withScrollback && maxLines > 0) {
    // Deliberately NOT gated on quiescence. That guard exists so the periodic
    // snapshot never captures mid-`cat`; at close there is no later chance, so a
    // slightly ragged capture beats no capture at all.
    const captured = serializeSession(sessionId, Math.min(maxLines, state.scrollbackLines));
    if (captured) {
      scrollback = captured.data;
      scrollbackLines = captured.lines;
    }
  }

  const messages = opts.withTranscript ? toArchiveMessages(stream?.messages ?? []) : null;
  const modelTranscript = opts.withTranscript ? (stream?.modelTranscript ?? []) : null;

  return {
    session_id: sessionId,
    // The same sticky-name-only rule as the snapshot: a derived label is stored
    // as "" so it is re-derived on reopen rather than pinned forever.
    title: session.userTitle ?? session.aiTitle ?? session.hostLabel ?? "",
    shell: session.shell,
    cwd: session.cwd,
    host_id: session.hostId,
    // For the reopen banner and the row's icon; never replayed as a connection.
    remote_kind: ui?.remote?.kind ?? null,
    remote_target: ui?.remote?.target ?? null,
    cols: entry?.term.cols ?? 80,
    rows: entry?.term.rows ?? 24,
    script_version: null,
    scrollback,
    scrollback_lines: scrollbackLines,
    opened_at: session.createdAt,
    is_open: opts.isOpen,
    close_reason: opts.closeReason,
    messages,
    // `model` labels the transcript, so it only means anything alongside one.
    model: opts.withTranscript ? (stream?.model ?? "") : null,
    model_transcript: modelTranscript,
    // Collapse the row this tab was reopened from, but only once the run is
    // actually over: doing it on the periodic tick would delete the archived
    // original while the user might still want to reopen it again.
    supersedes: opts.isOpen ? null : (session.archivedFrom ?? null),
  };
}

/**
 * Archive a session that is closing. Never throws.
 *
 * Called from `closeSession` between `ptyKill` and `disposeTerm` — the only
 * window where the shell's last bytes are in the buffer, the buffer still exists,
 * and `aiStreams[id]` has not yet been dropped by `removeSession`. The transcript
 * exists nowhere else, so getting this order wrong loses it silently.
 */
export async function archiveOnClose(sessionId: string): Promise<void> {
  const row = buildArchiveRow(sessionId, {
    isOpen: false,
    closeReason: "closed",
    withScrollback: true,
    withTranscript: true,
  });
  if (!row) return;
  try {
    await Promise.race([
      api.archivePut(row),
      new Promise((resolve) => setTimeout(resolve, CLOSE_BUDGET_MS)),
    ]);
  } catch (err) {
    console.warn(`archiving ${sessionId} failed:`, err);
  }
}

/**
 * Persist the AI transcript of a session that is still open.
 *
 * The crash net. Terminals already survive `kill -9` through session restore, but
 * a conversation lives only in the store — so without this, a hard quit loses
 * every transcript while every terminal comes back, which reads as the feature
 * being broken. The row is written with `is_open: 1` and flipped to a crashed
 * archive entry by `reap_open_sessions` at the next boot.
 *
 * Metadata-and-transcript only: no blob, so this stays cheap enough to run on a
 * timer.
 */
export async function archiveTranscriptOnly(sessionId: string): Promise<void> {
  const stream = useAppStore.getState().aiStreams[sessionId];
  // Nothing said yet: writing an empty open row would put a live tab in the
  // archive with nothing to show for it.
  if (!stream || stream.messages.length === 0) return;
  const row = buildArchiveRow(sessionId, {
    isOpen: true,
    closeReason: null,
    withScrollback: false,
    withTranscript: true,
  });
  if (!row) return;
  try {
    await api.archivePut(row);
  } catch (err) {
    console.warn(`archiving the transcript of ${sessionId} failed:`, err);
  }
}
