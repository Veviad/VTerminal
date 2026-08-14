/**
 * Turning an archive row back into a live tab.
 *
 * ORDERING IS THE WHOLE FILE. `withAiStream` no-ops for a session id that is not
 * in `sessions` (a deliberate guard so late stream callbacks cannot resurrect a
 * closed tab), so the transcript can only be written AFTER `createSession` has
 * resolved. Writing it first drops the entire conversation silently — no throw,
 * no log, just an empty panel.
 *
 * Shaped like `sshConnect.ts`, with `createSession` injected because it comes
 * from the `useSessions` hook and this module must stay importable from anywhere.
 */

import * as api from "./tauri";
import { useAppStore } from "../stores/appStore";
import { getTerm } from "./termRegistry";
import { setAiPanelOpen } from "./aiPanel";
import { hydrateAttachments } from "./attachInput";
import { replayBanner } from "./replayBanner";
import { archiveTranscriptOnly } from "./sessionArchive";
import type { AiMessage, ArchivedMessage, LaunchSpec } from "./types";

/** Archive rows -> the panel's shape. */
function toAiMessages(rows: ArchivedMessage[]): AiMessage[] {
  return rows.map((r) => ({
    // Ids are regenerated from the stable sort order rather than reused: this is
    // a NEW session, and the compaction bookkeeping positions entries by id.
    id: `arch-${r.sort_order}`,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    thinking: r.thinking ?? undefined,
    kind: r.kind === "command" ? "command" : "text",
    command: r.command
      ? {
          command: r.command.command,
          output: r.command.output,
          exitCode: r.command.exit_code,
          status: r.command.status,
          note: r.command.note ?? undefined,
        }
      : undefined,
    // Metadata only — `data` stays absent, so `AttachmentStrip` renders a named
    // chip until `hydrateAttachments` has read the bytes back off disk. Loading
    // every image inline here would block the reopen on N file reads.
    attachments: r.attachments.length
      ? r.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          mediaType: a.media_type,
          bytes: a.bytes,
          width: a.width ?? undefined,
          height: a.height ?? undefined,
          path: a.path ?? undefined,
        }))
      : undefined,
  }));
}

export interface ReopenOptions {
  /** false replays nothing — reopen the DIRECTORY only, with a clean screen. */
  replayOutput?: boolean;
}

/**
 * Reopen an archived session. Returns the new session id, or null on failure.
 *
 * Never throws: the caller is a click handler in a modal that must stay usable.
 */
export async function reopenSession(
  archiveId: string,
  createSession: (spec?: LaunchSpec) => Promise<string>,
  opts: ReopenOptions = {},
): Promise<string | null> {
  let detail;
  try {
    detail = await api.archiveGet(archiveId);
  } catch (err) {
    console.warn(`archive read failed (${archiveId}):`, err);
    return null;
  }
  // Pruned between the list render and the click.
  if (!detail) return null;
  const { summary, messages } = detail;

  const wantsOutput = opts.replayOutput !== false && summary.scrollback_lines > 0;
  const [scrollback, transcript] = await Promise.all([
    wantsOutput ? api.archiveScrollback(archiveId).catch(() => null) : Promise.resolve(null),
    summary.has_model_transcript
      ? api.archiveTranscript(archiveId).catch(() => [])
      : Promise.resolve([]),
  ]);

  // The LIVE grid, so the banner is padded to the real width and the replay does
  // not reflow the instant the pane is laid out.
  const dims = useAppStore.getState().termDims;

  const replay = scrollback
    ? scrollback +
      replayBanner(
        {
          kind: "reopened",
          when: summary.closed_at,
          remoteKind: summary.remote_kind,
          remoteTarget: summary.remote_target,
          hadTranscript: messages.length > 0,
        },
        dims.cols,
      )
    : // No banner over an empty screen: there is nothing above it to separate,
      // and the row already said "no output saved".
      null;

  const sessionId = await createSession({
    cwd: summary.cwd,
    // The session may predate a shell-path change.
    shell: summary.shell,
    // This alone is what makes Reconnect appear, via ReconnectBar.
    hostId: summary.host_id,
    // Restore's split, for restore's reason: a host tab's stored label IS its
    // host identity; anything else was a name a human chose (or the model chose
    // and the human kept).
    title: summary.host_id ? summary.title || null : null,
    userTitle: summary.host_id ? null : summary.title || null,
    replay,
    dims,
    archivedFrom: archiveId,
    // NO initialCommand, ever. Nothing auto-runs at launch — a reopened ssh tab
    // offers Reconnect, it never reconnects itself.
  });

  if (messages.length > 0) {
    useAppStore
      .getState()
      .restoreAiTranscript(sessionId, toAiMessages(messages), transcript, summary.closed_at);
    // Register the live replacement before handing it back to the browser. Its
    // attachment paths are shared with the source archive, and archive cleanup
    // decides whether those bytes are still owned from the surviving DB rows.
    // Without this open row, closing/pruning one of two reopens can delete the
    // source directory while the other live tab still references it.
    await archiveTranscriptOnly(sessionId);
    // Not awaited: the panel is usable with named chips straight away, and
    // blocking the reopen on N file reads would make a long conversation feel
    // broken. Thumbnails fill in as the reads land.
    void hydrateAttachments(sessionId);
    // A transcript restored into a collapsed panel is a transcript the user
    // cannot see. Through lib/aiPanel so the change survives quit.
    setAiPanelOpen(true);
  }
  getTerm(sessionId)?.term.focus();
  return sessionId;
}
