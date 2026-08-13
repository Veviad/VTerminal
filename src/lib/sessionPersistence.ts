/**
 * Continuous session snapshotting.
 *
 * WHY CONTINUOUS RATHER THAN "SAVE ON QUIT": there is no reliable quit hook to
 * build on. `WindowEvent::Destroyed` fires after the webview is gone (so the
 * xterm buffers we would serialize no longer exist), macOS ⌘Q goes through
 * `NSApp terminate:` with no preventable window, and none of it covers
 * force-quit, SIGKILL, a Rust panic, or OS logout. So the backbone is a
 * debounced write on every change, and the close hook is only an optimization.
 *
 * Worst case after `kill -9`: tabs, order, active tab and directories correct
 * to within ~750ms; scrollback correct as of the last completed command.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./tauri";
import { useAppStore, type AppState } from "../stores/appStore";
import { getTerm, serializeSession, subscribeTerm } from "./termRegistry";
import { archiveTranscriptOnly, buildArchiveRow } from "./sessionArchive";
import type { SessionSnapshotInput } from "./types";
import { isRunbookTerminalProtected } from "./runbookTerminalPrivacy";

/** Metadata debounce: quiet enough not to write on every keystroke-driven cwd
 *  change, tight enough that a crash costs at most this much. */
const META_DEBOUNCE_MS = 750;
const META_MAX_WAIT_MS = 5_000;

/** Scrollback is expensive, so it rides a slower timer. */
const BLOB_DEBOUNCE_MS = 3_000;
const BLOB_MAX_WAIT_MS = 15_000;

/** Background sweep for tabs that changed but never hit another trigger. */
const SWEEP_INTERVAL_MS = 60_000;

/** Never serialize mid-`cat`: output must have stopped for this long. */
const QUIESCENCE_MS = 750;

/** Upper bound on how long an idle-scheduled capture may be deferred. */
const IDLE_TIMEOUT_MS = 1_000;

/** Budget for the final flush before we force the window closed anyway. */
const FINAL_FLUSH_BUDGET_MS = 1_500;
const FINAL_FLUSH_WATCHDOG_MS = 2_000;

let started = false;
let unsubscribeStore: (() => void) | null = null;
let unlistenClose: UnlistenFn | null = null;
let unsubscribeTerms: (() => void)[] = [];
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let metaTimer: ReturnType<typeof setTimeout> | null = null;
let metaMaxTimer: ReturnType<typeof setTimeout> | null = null;
let blobTimer: ReturnType<typeof setTimeout> | null = null;
let blobMaxTimer: ReturnType<typeof setTimeout> | null = null;
let onBlur: (() => void) | null = null;

/** Sessions whose scrollback has changed since it was last written. */
const dirtyScrollback = new Set<string>();
/** Sessions whose AI transcript has changed since it was last archived. */
const dirtyTranscript = new Set<string>();
let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
let transcriptMaxTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialized on the last active-tab switch away, round-robin cursor. */
let sweepCursor = 0;
let lastFingerprint = "";
/** Tracked separately from the fingerprint so "which tab did we just leave?" is
 *  a plain lookup rather than string surgery on a packed key. */
let lastActiveId: string | null = null;
let flushInFlight: Promise<void> | null = null;
let flushInFlightStrict = false;

/**
 * Cheap change detector. The store has no middleware, so `subscribeWithSelector`
 * is unavailable — compare a packed string instead of deep-diffing every set().
 * Separators are control characters, which cannot occur in a path or a title.
 */
function fingerprint(s: AppState): string {
  return s.sessions
    // Only the STICKY name is folded in. Derived labels (cwd leaf, running
    // command) are not persisted, so including them would schedule a snapshot
    // write on every `cd` and every command start.
    .map((x) =>
      [
        x.id,
        x.userTitle ?? "",
        x.aiTitle ?? "",
        x.hostLabel ?? "",
        x.cwd ?? "",
        x.shell,
        x.hostId ?? "",
      ].join("\u0001"))
    .join("\u0002");
}

/** A tab is safe to serialize only when nothing is actively writing to it. */
function isQuiescent(sessionId: string): boolean {
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) return false;
  if (Date.now() - entry.lastDataAt < QUIESCENCE_MS) return false;
  return useAppStore.getState().sessionUi[sessionId]?.runningBlockId == null;
}

export function markScrollbackDirty(sessionId: string): void {
  if (!started) return;
  dirtyScrollback.add(sessionId);
  scheduleBlob();
}

/**
 * An AI turn ended — archive the transcript so a hard quit does not lose it.
 *
 * Deliberately NOT folded into `fingerprint()`. That detector runs on every
 * store change, and `appendAiDelta` calls `set()` once per streamed token, so
 * including transcript state there would schedule a write per token. This is
 * event-driven for the same reason `markScrollbackDirty` is: the caller knows
 * when something worth persisting actually finished.
 */
export function markTranscriptDirty(sessionId: string): void {
  if (!started) return;
  dirtyTranscript.add(sessionId);
  scheduleTranscript();
}

function buildSnapshot(withScrollback: Set<string>): {
  active_session_id: string | null;
  sessions: SessionSnapshotInput[];
} {
  const state = useAppStore.getState();
  const maxLines = state.restoreScrollbackLines;

  const sessions = state.sessions.map((session, index) => {
    const ui = state.sessionUi[session.id];
    const entry = getTerm(session.id);

    // `scrollback: null` means "leave the stored blob alone" — that COALESCE is
    // what lets the cheap metadata tick run constantly without shipping bytes.
    let scrollback: string | null = null;
    let scrollbackLines: number | null = null;
    if (isRunbookTerminalProtected(session.id)) {
      // Empty, rather than null, actively clears an older raw snapshot.
      scrollback = "";
      scrollbackLines = 0;
      dirtyScrollback.delete(session.id);
    } else if (maxLines > 0 && withScrollback.has(session.id) && isQuiescent(session.id)) {
      const captured = serializeSession(session.id, Math.min(maxLines, state.scrollbackLines));
      if (captured) {
        scrollback = captured.data;
        scrollbackLines = captured.lines;
        dirtyScrollback.delete(session.id);
      }
    }

    return {
      session_id: session.id,
      tab_index: index,
      // ONLY a sticky name — a rename, a model-given name, or a host identity.
      // Derived labels (cwd leaf, running command) are deliberately persisted as
      // "" so they are re-derived next run instead of being pinned forever; the
      // old code stored the cwd basename here, which is how a tab opened in
      // $HOME came back permanently named after the user.
      title: session.userTitle ?? session.aiTitle ?? session.hostLabel ?? "",
      shell: session.shell,
      // `session.cwd` is guarded against remote OSC 7 in useSessions — only a
      // path on THIS machine ever reaches here.
      cwd: session.cwd,
      host_id: session.hostId,
      // Recorded for the restore separator; never replayed as a live connection.
      remote_kind: ui?.remote?.kind ?? null,
      remote_target: ui?.remote?.target ?? null,
      cols: entry?.term.cols ?? 80,
      rows: entry?.term.rows ?? 24,
      script_version: null,
      scrollback,
      scrollback_lines: scrollbackLines,
    } satisfies SessionSnapshotInput;
  });

  return { active_session_id: state.activeSessionId, sessions };
}

async function write(
  withScrollback: Set<string>,
  finalFlush: boolean,
  strict = false,
): Promise<void> {
  const snapshot = buildSnapshot(withScrollback);
  try {
    await api.workspaceSnapshot({ ...snapshot, final_flush: finalFlush });
  } catch (err) {
    console.warn("session snapshot failed:", err);
    if (strict) throw err;
  }
}

function clearTimer(t: ReturnType<typeof setTimeout> | null) {
  if (t) clearTimeout(t);
  return null;
}

function scheduleMeta(): void {
  metaTimer = clearTimer(metaTimer);
  metaTimer = setTimeout(() => {
    metaTimer = null;
    metaMaxTimer = clearTimer(metaMaxTimer);
    void write(new Set(), false);
  }, META_DEBOUNCE_MS);
  // Max-wait so a continuous stream of changes still gets written.
  if (!metaMaxTimer) {
    metaMaxTimer = setTimeout(() => {
      metaMaxTimer = null;
      metaTimer = clearTimer(metaTimer);
      void write(new Set(), false);
    }, META_MAX_WAIT_MS);
  }
}

function scheduleBlob(): void {
  blobTimer = clearTimer(blobTimer);
  blobTimer = setTimeout(() => {
    blobTimer = null;
    blobMaxTimer = clearTimer(blobMaxTimer);
    void flushDirtyScrollback();
  }, BLOB_DEBOUNCE_MS);
  if (!blobMaxTimer) {
    blobMaxTimer = setTimeout(() => {
      blobMaxTimer = null;
      blobTimer = clearTimer(blobTimer);
      void flushDirtyScrollback();
    }, BLOB_MAX_WAIT_MS);
  }
}

/** Transcripts ride the slow timer too: they are small, but a burst of turn-end
 *  events should coalesce into one write. */
function scheduleTranscript(): void {
  transcriptTimer = clearTimer(transcriptTimer);
  transcriptTimer = setTimeout(() => {
    transcriptTimer = null;
    transcriptMaxTimer = clearTimer(transcriptMaxTimer);
    void flushDirtyTranscripts();
  }, BLOB_DEBOUNCE_MS);
  if (!transcriptMaxTimer) {
    transcriptMaxTimer = setTimeout(() => {
      transcriptMaxTimer = null;
      transcriptTimer = clearTimer(transcriptTimer);
      void flushDirtyTranscripts();
    }, BLOB_MAX_WAIT_MS);
  }
}

async function flushDirtyTranscripts(): Promise<void> {
  if (dirtyTranscript.size === 0) return;
  const ready = [...dirtyTranscript];
  dirtyTranscript.clear();
  // No quiescence gate and no idle wrapper: this ships a few KB of JSON, not a
  // serialized terminal buffer.
  for (const sessionId of ready) {
    await archiveTranscriptOnly(sessionId);
  }
}

/** Serialize whatever is dirty AND quiet, inside an idle callback so a big
 *  buffer never lands in the middle of a frame. */
function flushDirtyScrollback(): void {
  if (dirtyScrollback.size === 0) return;
  const ready = new Set([...dirtyScrollback].filter(isQuiescent));
  if (ready.size === 0) {
    // Still busy — try again on the next slow tick rather than blocking here.
    scheduleBlob();
    return;
  }
  runWhenIdle(() => void write(ready, false));
}

/**
 * Serialize off the critical path, but never at the cost of not running at all.
 *
 * The `timeout` is load-bearing: WKWebView starves idle callbacks while the
 * window is occluded or unfocused, which is precisely when we most want to
 * capture (the user just switched away, or is about to quit). Without it the
 * blur- and sweep-driven captures simply never fire in a background window.
 */
function runWhenIdle(fn: () => void): void {
  const ric = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (ric) ric(fn, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(fn, 0);
}

/** Write everything now. Used by the close hook and by tab-blur handoff. */
export async function flushAll(opts: { final?: boolean; strict?: boolean } = {}): Promise<void> {
  // Concurrent callers share one write — the close hook and a timer can race.
  const strict = opts.strict ?? false;
  if (flushInFlight) {
    if (!strict || flushInFlightStrict) return flushInFlight;
    // A restart may not inherit an ordinary flush that deliberately swallows
    // errors. Let it settle, then perform its own strict final snapshot.
    await flushInFlight;
    return flushAll(opts);
  }
  const all = new Set(useAppStore.getState().sessions.map((s) => s.id));
  const final = opts.final ?? false;
  flushInFlightStrict = strict;
  flushInFlight = (async () => {
    // At quit, snapshot and archive CONCURRENTLY rather than in sequence. Both
    // serialize the same buffers and both contend for the same DB mutex, and the
    // whole flush lives inside a 1.5s budget — doing them one after the other is
    // how the archive half silently never happens on a machine with many tabs.
    if (final) {
      await Promise.all([write(all, true, strict), archiveAllOnQuit()]);
    } else {
      await write(all, false, strict);
    }
  })().finally(() => {
    flushInFlight = null;
    flushInFlightStrict = false;
  });
  return flushInFlight;
}

/** Archive every open tab as a cleanly-quit session. Never throws. */
async function archiveAllOnQuit(): Promise<void> {
  const rows = useAppStore
    .getState()
    .sessions.map((s) =>
      buildArchiveRow(s.id, {
        isOpen: false,
        closeReason: "quit",
        withScrollback: true,
        withTranscript: true,
      }),
    )
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length === 0) return;
  try {
    await api.archivePutMany(rows);
  } catch (err) {
    console.warn("archiving at quit failed:", err);
  }
}

export function startPersistence(): void {
  if (started) return;
  started = true;
  const initial = useAppStore.getState();
  lastFingerprint = fingerprint(initial);
  lastActiveId = initial.activeSessionId;

  unsubscribeStore = useAppStore.subscribe((state) => {
    const next = fingerprint(state);
    const nextActive = state.activeSessionId;
    const tabsChanged = next !== lastFingerprint;
    const activeChanged = nextActive !== lastActiveId;
    if (!tabsChanged && !activeChanged) return;

    // Switching away from a tab is a natural, invisible moment to capture it.
    if (activeChanged && lastActiveId) {
      dirtyScrollback.add(lastActiveId);
      scheduleBlob();
    }
    lastFingerprint = next;
    lastActiveId = nextActive;
    scheduleMeta();
  });

  // A finished command is the highest-value scrollback checkpoint there is:
  // it is exactly the state a user expects to come back to.
  unsubscribeTerms = useAppStore.getState().sessions.map((s) => watchSession(s.id));

  onBlur = () => {
    const active = useAppStore.getState().activeSessionId;
    if (active) markScrollbackDirty(active);
  };
  window.addEventListener("blur", onBlur);

  // Write the boot state once, immediately. Without this the run is persisted
  // only if something later CHANGES — so a window left untouched (or a shell
  // that never emits OSC 7) would leave the previous generation's rows as the
  // newest thing on disk, and this run's tabs would never be restorable.
  scheduleMeta();

  sweepTimer = setInterval(() => {
    const sessions = useAppStore.getState().sessions;
    if (sessions.length === 0) return;
    // One tab per tick, round-robin — bounded work regardless of tab count.
    sweepCursor = (sweepCursor + 1) % sessions.length;
    markScrollbackDirty(sessions[sweepCursor].id);
  }, SWEEP_INTERVAL_MS);

  void installCloseHook();
}

/** Subscribe to a session's block stream. Safe to call for a session that has
 *  no term entry yet — subscribeTerm returns a no-op unsubscribe. */
export function watchSession(sessionId: string): () => void {
  return subscribeTerm(sessionId, (e) => {
    if (e.type === "blockEnd") markScrollbackDirty(sessionId);
  });
}

export function trackSession(sessionId: string): void {
  if (!started) return;
  unsubscribeTerms.push(watchSession(sessionId));
}

async function installCloseHook(): Promise<void> {
  try {
    const win = getCurrentWindow();
    unlistenClose = await win.onCloseRequested(async () => {
      // Tauri auto-calls prevent_close() simply because a listener is
      // registered, so WE are now responsible for actually closing the window.
      // The watchdog and the finally are not optional: a throw here would
      // leave an app the user cannot quit.
      const watchdog = setTimeout(() => void win.destroy(), FINAL_FLUSH_WATCHDOG_MS);
      try {
        await Promise.race([
          flushAll({ final: true }),
          new Promise((r) => setTimeout(r, FINAL_FLUSH_BUDGET_MS)),
        ]);
      } catch (err) {
        console.warn("final snapshot failed:", err);
      } finally {
        clearTimeout(watchdog);
        // destroy(), not close() — close() re-fires CloseRequested.
        void win.destroy();
      }
    });
  } catch (err) {
    // Not fatal: the debounced writes are the backbone, this is the garnish.
    console.warn("could not install the close hook:", err);
  }
}

export function stopPersistence(): void {
  if (!started) return;
  started = false;
  unsubscribeStore?.();
  unsubscribeStore = null;
  unlistenClose?.();
  unlistenClose = null;
  for (const un of unsubscribeTerms) un();
  unsubscribeTerms = [];
  if (onBlur) window.removeEventListener("blur", onBlur);
  onBlur = null;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  metaTimer = clearTimer(metaTimer);
  metaMaxTimer = clearTimer(metaMaxTimer);
  blobTimer = clearTimer(blobTimer);
  blobMaxTimer = clearTimer(blobMaxTimer);
  transcriptTimer = clearTimer(transcriptTimer);
  transcriptMaxTimer = clearTimer(transcriptMaxTimer);
  dirtyScrollback.clear();
  dirtyTranscript.clear();
}

/** Test seam. */
export function __resetPersistenceForTests(): void {
  stopPersistence();
  lastFingerprint = "";
  lastActiveId = null;
  sweepCursor = 0;
  flushInFlight = null;
  flushInFlightStrict = false;
}
