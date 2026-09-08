/**
 * Starting a fresh conversation in a tab that stays open.
 *
 * The mirror image of `sessionReopen.ts`: that turns an archive row into a live
 * tab, this turns a live tab's conversation into an archive row. Same reason for
 * living in `lib/` rather than in the panel — it is a multi-store sequence with a
 * load-bearing order, not a click handler.
 *
 * WHY THE CONVERSATION IS ARCHIVED RATHER THAN DROPPED: an AI conversation lives
 * only in `aiStreams[sessionId]`, so clearing that map entry is the one and only
 * copy gone. Writing it to the archive first makes "New chat" recoverable through
 * the past-session browser, which is also what lets the button act on a single
 * click instead of asking for confirmation.
 *
 * THE TWO ROWS. A tab cannot hand its own `session_id` to the split-off chat —
 * that id is load-bearing for the PTY, the restore snapshot and `command_history`
 * — and `archived_sessions.session_id` is the primary key. So the outgoing chat
 * gets a synthetic id and the live tab's own row is blanked in the same
 * transaction. Blanking is not optional: the periodic transcript tick has very
 * likely already written an `is_open = 1` row holding the OLD conversation, and
 * `reap_open_sessions` would resurrect it as a second, crashed copy at the next
 * boot.
 */

import * as api from "./tauri";
import { trackArchiveMutation } from "./archiveWriteTracker";
import {
  useAppStore,
  type AiStreamState,
  type AppState,
} from "../stores/appStore";
import { buildArchiveRow, pauseTranscriptArchiving } from "./sessionArchive";
import { abortSession } from "./ptyExec";
import { S } from "./strings";
import { getTerm } from "./termRegistry";
import { clearTerminalBuffer } from "./terminalClear";
import { markScrollbackDirty, markTranscriptDirty, persistClearedScrollback } from "./sessionPersistence";
import type { ArchiveSessionInput } from "./types";

const newChatsInFlight = new Map<string, Promise<boolean>>();

/**
 * Archive id for a chat split off an open tab.
 *
 * Live ids are `sess-<ms>-<counter>` (see `useSessions.createSession`) and never
 * contain `#`, so this cannot collide with a real session — present or future.
 * The millisecond makes it unique per tab; two clicks inside one millisecond are
 * not reachable by hand.
 */
export function chatArchiveId(sessionId: string, now = Date.now()): string {
  return `${sessionId}#${now}`;
}

/**
 * Would the archive actually accept the outgoing chat?
 *
 * Mirrors `writes_allowed` in `commands/archive.rs`, which silently returns Ok(())
 * when either toggle is off. Without checking, "New chat" would quietly become
 * destructive for anyone who turned session restore off — so the button asks for
 * a second click in that case instead.
 *
 * Exported as a selector as well, so the button can subscribe to it rather than
 * reading a snapshot that never re-renders when the setting changes.
 */
export const selectArchiveWillKeepChats = (s: AppState): boolean =>
  s.restoreSessionsOnStart && s.archiveEnabled;

export function archiveWillKeepChats(): boolean {
  return selectArchiveWillKeepChats(useAppStore.getState());
}

/** Is there anything in this panel worth preserving? One definition, used both
 *  reactively (the button's disabled state) and imperatively (the action itself),
 *  so the two cannot disagree about whether there is a chat. */
export function streamHasConversation(
  stream: AiStreamState | undefined,
): boolean {
  if (!stream) return false;
  return (
    stream.messages.length > 0 ||
    stream.restoredAt !== null ||
    stream.status === "streaming" ||
    stream.status === "awaiting_approval" ||
    stream.status === "executing"
  );
}

export function hasConversation(sessionId: string): boolean {
  const store = useAppStore.getState();
  return streamHasConversation(
    store.aiStreams[store.resolveAiOwner(sessionId)],
  );
}

/**
 * Archive the current conversation and empty the panel. Never throws.
 *
 * Returns false when nothing happened — either there was nothing to clear, or the
 * archive write was refused and the conversation was deliberately left in place.
 */
export function startNewChat(sessionId: string): Promise<boolean> {
  const owner = useAppStore.getState().resolveAiOwner(sessionId);
  const existing = newChatsInFlight.get(owner);
  if (existing) return existing;
  const operation = trackArchiveMutation(async () => {
    const store = useAppStore.getState();
    const ownerSessionId = store.resolveAiOwner(sessionId);
    const binding = store.sidecarForSession(sessionId);
    const targetSessionIds = binding
      ? [binding.localSessionId, binding.remoteSessionId]
      : [ownerSessionId];
    const clearTerminal = store.clearTerminalOnNewChat;
    // A closed/replaced terminal must not inherit a pending clear from the old
    // chat. Capture the objects before cancellation or archiving can yield.
    const terminalsToClear = clearTerminal
      ? targetSessionIds.map((id) => ({ id, entry: getTerm(id) }))
      : [];
    const session = store.sessions.find((s) => s.id === ownerSessionId);
    if (!session) return false;
    const stream = store.aiStreams[ownerSessionId];
    if (!stream || !hasConversation(ownerSessionId)) return false;

    const transcriptPause = pauseTranscriptArchiving(ownerSessionId);
    try {
      // Stop anything in flight first, exactly as the panel's Stop button does.
      // Releasing a PTY job never interrupts the command itself — it is running in
      // the user's own shell, in front of them. The synchronous finish/fence below
      // retires ownership before cancellation or archival can yield.
      for (const targetSessionId of new Set(targetSessionIds)) {
        abortSession(targetSessionId, "cancelled");
      }
      if (stream.requestId) {
        // Retire ownership synchronously, before waiting for cancellation. This
        // prevents a late sidecar round from acting on either terminal while the
        // archive write is pending, and folds partial output for the row below.
        useAppStore.getState().finishAiStream(ownerSessionId);
        await api.aiCancel(stream.requestId).catch(() => {});
      } else {
        // A Done event clears requestId before agentStart returns its transcript.
        // New Chat is still a hard conversation fence in that narrow gap.
        useAppStore.getState().flushAiStreaming(ownerSessionId);
        useAppStore.getState().fenceAiGeneration(ownerSessionId);
      }
      // Fold whatever had already streamed into a real message. `aiCancel` resolving
      // does not mean the Cancelled event has been dispatched yet, and a partial
      // answer lives in `streamingContent` — which the archive row does not read. Skip
      // this and cancelling mid-answer silently drops that text from the saved copy.
      // A no-op when the buffers are empty, and the late Cancelled event's own flush
      // is then a no-op too.
      useAppStore.getState().flushAiStreaming(ownerSessionId);

      await transcriptPause.drained;

      if (archiveWillKeepChats()) {
        // One build, two rows. buildArchiveRow snapshots live state synchronously
        // into plain objects, so nothing here races the clear that follows.
        const base = buildArchiveRow(ownerSessionId, {
          isOpen: false,
          closeReason: "closed",
          withScrollback: true,
          withTranscript: true,
        });
        if (!base) return false;

        const split = {
          ...base,
          session_id: chatArchiveId(ownerSessionId),
          // The chat began when the first thing was said, not when the tab opened —
          // otherwise every chat split off a long-lived tab claims the same start.
          opened_at: stream.messages[0]?.createdAt ?? base.opened_at,
          // `supersedes` comes from buildArchiveRow's isOpen:false branch: a tab
          // reopened from the archive collapses that row into THIS chat, which is the
          // one continuing its thread of work.
        };
        const blanked = {
          ...base,
          session_id: ownerSessionId,
          is_open: true,
          close_reason: null,
          // An empty blob retires the old screen; null preserves it when the
          // user chose to keep their terminal history across conversations.
          scrollback: clearTerminal ? "" : null,
          scrollback_lines: clearTerminal ? 0 : null,
          // Explicitly empty, NOT null: null means "keep the stored rows".
          messages: [],
          model_transcript: [],
          model: "",
          supersedes: null,
        };

        const rows: ArchiveSessionInput[] = [split, blanked];
        if (clearTerminal) {
          // A shared Sidecar conversation used both screens. Keep the companion
          // screen in Past sessions too, without duplicating the owner's chat or
          // clearing the companion's separate, hidden conversation.
          for (const id of targetSessionIds) {
            if (id === ownerSessionId) continue;
            const companion = buildArchiveRow(id, {
              isOpen: true,
              closeReason: null,
              withScrollback: true,
              withTranscript: false,
            });
            if (!companion) continue;
            rows.push({
              ...companion,
              session_id: chatArchiveId(id),
              is_open: false,
              close_reason: "closed",
              supersedes: null,
            }, {
              ...companion,
              scrollback: "",
              scrollback_lines: 0,
            });
          }
        }

        try {
          await api.archivePutMany(rows);
        } catch (err) {
          // Keep the conversation. Losing it to a database error would be strictly
          // worse than a click that reports why it did nothing.
          console.warn(`archiving the chat of ${ownerSessionId} failed:`, err);
          useAppStore
            .getState()
            .finishAiStream(ownerSessionId, S.aiPanel.newChatFailed);
          return false;
        }
      }

      // MCP stdio processes and logical HTTP sessions are conversation-scoped.
      // Close the old set only after its transcript has been durably archived.
      await api.mcpDisconnect(ownerSessionId).catch((error) => {
        console.warn(`closing MCP sessions for ${ownerSessionId} failed:`, error);
      });

      const clearedIds: string[] = [];
      for (const { id, entry } of terminalsToClear) {
        if (!entry || entry.disposed || getTerm(id) !== entry) continue;
        // Keep the live shell phase and nested connection identity. Only the old
        // command evidence is retired, so the new chat cannot retrieve it again.
        useAppStore.getState().updateSessionUi(id, { blocks: [], searchOpen: false });
        await clearTerminalBuffer(entry.term, () => {
          if (entry.disposed || getTerm(id) !== entry) return;
          for (const markers of entry.blockMarkers.values()) {
            markers.start.dispose();
            markers.end?.dispose();
          }
          entry.blockMarkers.clear();
          useAppStore.getState().updateSessionUi(id, { blocks: [] });
          markScrollbackDirty(id);
        });
        clearedIds.push(id);
      }

      // newAiConversation also removes the transient binding. The shell and SSH
      // connection stay alive even when the screen and scrollback were cleared.
      useAppStore.getState().newAiConversation(ownerSessionId);
      // The split row inherited the supersede, so the tab must stop claiming it:
      // its next close is the end of a NEW thread of work.
      if (session.archivedFrom) {
        useAppStore
          .getState()
          .updateSession(ownerSessionId, { archivedFrom: null });
      }
      if (clearedIds.length) await persistClearedScrollback(clearedIds);
      return true;
    } finally {
      transcriptPause.release();
      markTranscriptDirty(ownerSessionId);
    }
  }, false).finally(() => newChatsInFlight.delete(owner));
  newChatsInFlight.set(owner, operation);
  return operation;
}
