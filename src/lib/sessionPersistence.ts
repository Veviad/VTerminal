/**
 * Continuous session snapshotting.
 *
 * WHY CONTINUOUS RATHER THAN "SAVE ON QUIT": there is no reliable quit hook to
 * build on. VTerminal's custom macOS Quit item and window close now route
 * through a preventable backend coordinator, but Dock Quit/OS termination can
 * still reach `WindowEvent::Destroyed` after the webview (and its xterm
 * buffers) is gone, and nothing covers force-quit, SIGKILL, or a Rust panic.
 * The backbone therefore remains a debounced write on every change; the strict
 * coordinated-exit barrier is the final optimization.
 *
 * Worst case after `kill -9`: tabs, order, active tab and directories correct
 * to within ~750ms; scrollback correct as of the last completed command.
 */

import {
  getCurrentWindow,
  type CloseRequestedEvent,
} from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as api from "./tauri";
import { useAppStore, type AppState } from "../stores/appStore";
import { getTerm, serializeSession, subscribeTerm } from "./termRegistry";
import { archiveTranscriptOnly, buildArchiveRow } from "./sessionArchive";
import type { SessionSnapshotInput } from "./types";
import { isRunbookTerminalProtected } from "./runbookTerminalPrivacy";
import {
  __resetArchiveWriteTrackerForTests,
  freezeArchiveMutations,
  freezeArchiveWrites,
  resumeArchiveMutations,
  waitForArchiveMutations,
  waitForArchiveWrites,
} from "./archiveWriteTracker";

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

const APP_QUIT_EVENT = "vterminal-app-quit-requested";

let started = false;
let unsubscribeStore: (() => void) | null = null;
let unlistenClose: UnlistenFn | null = null;
let unlistenQuit: UnlistenFn | null = null;
let exitHookGeneration = 0;
let activeQuitToken: number | null = null;
let quitTask: Promise<void> | null = null;
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
/** Agent checkpoints are sparse (one per completed round), so they bypass the
 *  slow transcript timer. A set coalesces a newer checkpoint that arrives while
 *  the previous archive IPC is still in flight. */
const dirtyAgentCheckpoints = new Set<string>();
let agentCheckpointDrain: Promise<void> | null = null;
let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
let transcriptMaxTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialized on the last active-tab switch away, round-robin cursor. */
let sweepCursor = 0;
let lastFingerprint = "";
/** Tracked separately from the fingerprint so "which tab did we just leave?" is
 *  a plain lookup rather than string surgery on a packed key. */
let lastActiveId: string | null = null;
let routineFlushInFlight: Promise<void> | null = null;
let routineFlushInFlightStrict = false;
let pausedForExit = false;
let exitPrepared = false;
let exitPreparation: Promise<void> | null = null;
let cleanExitCommit: Promise<void> | null = null;
let exitMarkedClean = false;
let resumeInFlight: Promise<void> | null = null;
/** True when provisional final archive payloads committed and may need their
 * pending supersede mappings cleared after an abandoned exit. */
let archivePreparedForExit = false;

/** Every persistence IPC started by a timer/idle callback or routine caller. */
const inFlightWrites = new Set<Promise<void>>();

type IdleTask =
  | { kind: "idle"; handle: number }
  | { kind: "timeout"; handle: ReturnType<typeof setTimeout> };
const idleTasks = new Set<IdleTask>();

function persistenceActive(): boolean {
  return started && !pausedForExit;
}

function trackWrite(promise: Promise<void>): Promise<void> {
  let tracked: Promise<void>;
  tracked = promise.finally(() => inFlightWrites.delete(tracked));
  inFlightWrites.add(tracked);
  return tracked;
}

function startBackgroundWrite(promise: Promise<void>): void {
  void trackWrite(promise).catch((err) => {
    console.warn("background persistence failed:", err);
  });
}

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
  if (!persistenceActive()) return;
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
  if (!persistenceActive()) return;
  dirtyTranscript.add(sessionId);
  scheduleTranscript();
}

/** Persist a stable Agent round immediately.
 *
 * Unlike streamed text, checkpoints arrive only after the backend has completed
 * a model/tool boundary. Writing each newest boundary is cheap and closes the
 * crash window where a command changed the machine but its model-visible result
 * existed only in webview memory.
 */
export function markTranscriptCheckpoint(sessionId: string): void {
  if (!persistenceActive()) return;
  dirtyAgentCheckpoints.add(sessionId);
  startAgentCheckpointDrain();
}

function startAgentCheckpointDrain(): void {
  if (!persistenceActive() || agentCheckpointDrain) return;

  let operation: Promise<void>;
  operation = (async () => {
    while (persistenceActive() && dirtyAgentCheckpoints.size > 0) {
      const ready = [...dirtyAgentCheckpoints];
      dirtyAgentCheckpoints.clear();
      for (const sessionId of ready) {
        const saved = await archiveTranscriptOnly(sessionId);
        // A failed immediate checkpoint gets one bounded retry on the existing
        // slow transcript timer. Do not re-add it to this drain: that would spin
        // against a persistent disk/IPC failure and starve later sessions.
        if (!saved && persistenceActive()) {
          dirtyTranscript.add(sessionId);
          scheduleTranscript();
        }
      }
    }
  })().finally(() => {
    if (agentCheckpointDrain === operation) agentCheckpointDrain = null;
    if (persistenceActive() && dirtyAgentCheckpoints.size > 0) {
      startAgentCheckpointDrain();
    }
  });
  agentCheckpointDrain = operation;
  startBackgroundWrite(operation);
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

async function write(withScrollback: Set<string>, strict = false): Promise<void> {
  // `buildSnapshot` claims captured blobs by removing their ids from the dirty
  // set. Keep the pre-write set so a rejected IPC cannot silently discard the
  // only signal that those bytes still need a durable retry.
  const dirtyBeforeWrite = new Set(dirtyScrollback);
  try {
    const snapshot = buildSnapshot(withScrollback);
    await api.workspaceSnapshot(snapshot);
  } catch (err) {
    const liveSessions = new Set(useAppStore.getState().sessions.map((session) => session.id));
    for (const sessionId of dirtyBeforeWrite) {
      if (liveSessions.has(sessionId)) dirtyScrollback.add(sessionId);
    }
    if (persistenceActive() && dirtyBeforeWrite.size > 0) scheduleBlob();
    console.warn("session snapshot failed:", err);
    if (strict) throw err;
  }
}

function clearTimer(t: ReturnType<typeof setTimeout> | null) {
  if (t !== null) clearTimeout(t);
  return null;
}

function scheduleMeta(): void {
  if (!persistenceActive()) return;
  metaTimer = clearTimer(metaTimer);
  metaTimer = setTimeout(() => {
    metaTimer = null;
    metaMaxTimer = clearTimer(metaMaxTimer);
    if (persistenceActive()) startBackgroundWrite(write(new Set()));
  }, META_DEBOUNCE_MS);
  // Max-wait so a continuous stream of changes still gets written.
  if (!metaMaxTimer) {
    metaMaxTimer = setTimeout(() => {
      metaMaxTimer = null;
      metaTimer = clearTimer(metaTimer);
      if (persistenceActive()) startBackgroundWrite(write(new Set()));
    }, META_MAX_WAIT_MS);
  }
}

function scheduleBlob(): void {
  if (!persistenceActive()) return;
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
  if (!persistenceActive()) return;
  transcriptTimer = clearTimer(transcriptTimer);
  transcriptTimer = setTimeout(() => {
    transcriptTimer = null;
    transcriptMaxTimer = clearTimer(transcriptMaxTimer);
    if (persistenceActive()) startBackgroundWrite(flushDirtyTranscripts());
  }, BLOB_DEBOUNCE_MS);
  if (!transcriptMaxTimer) {
    transcriptMaxTimer = setTimeout(() => {
      transcriptMaxTimer = null;
      transcriptTimer = clearTimer(transcriptTimer);
      if (persistenceActive()) startBackgroundWrite(flushDirtyTranscripts());
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
  if (!persistenceActive()) return;
  if (dirtyScrollback.size === 0) return;
  const ready = new Set([...dirtyScrollback].filter(isQuiescent));
  if (ready.size === 0) {
    // Still busy — try again on the next slow tick rather than blocking here.
    scheduleBlob();
    return;
  }
  runWhenIdle(() => startBackgroundWrite(write(ready)));
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
  if (!persistenceActive()) return;
  const idleApi = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (idleApi.requestIdleCallback && idleApi.cancelIdleCallback) {
    const task: IdleTask = { kind: "idle", handle: 0 };
    task.handle = idleApi.requestIdleCallback(() => {
      idleTasks.delete(task);
      if (persistenceActive()) fn();
    }, { timeout: IDLE_TIMEOUT_MS });
    idleTasks.add(task);
    return;
  }

  let task: IdleTask;
  const handle = setTimeout(() => {
    idleTasks.delete(task);
    if (persistenceActive()) fn();
  }, 0);
  task = { kind: "timeout", handle };
  idleTasks.add(task);
}

function archiveRows(isOpen: boolean, finalCapture = false) {
  return useAppStore
    .getState()
    .sessions.map((s) =>
      buildArchiveRow(s.id, {
        isOpen,
        closeReason: isOpen ? null : "quit",
        withScrollback: finalCapture || !isOpen,
        withTranscript: true,
        stageSupersedes: isOpen && finalCapture,
      }),
    )
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

function failureFrom(reasons: unknown[], message: string): unknown | null {
  if (reasons.length === 0) return null;
  if (reasons.length === 1) return reasons[0];
  return new AggregateError(reasons, message);
}

async function waitForInFlightWrites(): Promise<void> {
  const failures: unknown[] = [];
  while (inFlightWrites.size > 0) {
    const results = await Promise.allSettled([...inFlightWrites]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  const failure = failureFrom(failures, "persistence writes failed while preparing to exit");
  if (failure) throw failure;
}

async function flushRoutine(strict: boolean): Promise<void> {
  if (pausedForExit) return;
  if (routineFlushInFlight) {
    if (!strict || routineFlushInFlightStrict) return routineFlushInFlight;
    // A strict caller cannot inherit an ordinary write that swallows errors.
    await routineFlushInFlight;
    return flushRoutine(true);
  }

  const all = new Set(useAppStore.getState().sessions.map((session) => session.id));
  routineFlushInFlightStrict = strict;
  const operation = trackWrite(write(all, strict));
  routineFlushInFlight = operation;
  try {
    await operation;
  } finally {
    if (routineFlushInFlight === operation) {
      routineFlushInFlight = null;
      routineFlushInFlightStrict = false;
    }
  }
}

function pausePersistenceForExit(): void {
  if (pausedForExit) return;
  pausedForExit = true;
  freezeArchiveMutations();
  detachActivitySources();
}

async function finalizePersistenceForExit(): Promise<void> {
  await waitForInFlightWrites();
  await waitForArchiveMutations();
  freezeArchiveWrites();
  await waitForArchiveWrites();

  // Fence every stream generation before constructing plain archive rows.
  // finishAiStream folds an active request's already-visible partial answer into
  // `messages`; fenceAiGeneration also covers the narrow agent gap where Done has
  // cleared requestId but agentStart has not returned its model transcript yet.
  // Cancellation IPCs run alongside the durable writes; a cancellation error
  // cannot reopen the fence or make a post-barrier tail safe to persist.
  const store = useAppStore.getState();
  const cancellations: Promise<unknown>[] = [];
  for (const session of store.sessions) {
    const requestId = useAppStore.getState().aiStreams[session.id]?.requestId;
    if (requestId) {
      store.finishAiStream(session.id);
      cancellations.push(api.aiCancel(requestId));
    } else {
      store.flushAiStreaming(session.id);
    }
    store.fenceAiGeneration(session.id);
  }

  const all = new Set(useAppStore.getState().sessions.map((session) => session.id));
  // Keep rows provisionally open. The backend closes them as `quit` in the
  // same SQLite transaction that sets clean_exit, so a watchdog/kill between
  // these writes is recovered honestly as a crash on the next boot.
  const rows = archiveRows(true, true);
  const cancellationSettled = Promise.allSettled(cancellations);
  const results = await Promise.allSettled([
    write(all, true),
    rows.length > 0 ? api.archivePutManyForExit(rows) : Promise.resolve(),
    cancellationSettled,
  ]);

  if (rows.length > 0 && results[1].status === "fulfilled") {
    archivePreparedForExit = true;
  }
  const barrierFailure = failureFrom(
    results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason),
    "final workspace/archive persistence failed",
  );
  if (barrierFailure) throw barrierFailure;
  exitPrepared = true;
}

async function rollbackPreparedExit(): Promise<void> {
  const shouldReopenArchive = archivePreparedForExit;
  // This is also needed after a recoverable updater failure: the backend may
  // have reached its planned-exit transaction before an installer error.
  const rows = shouldReopenArchive ? archiveRows(true) : [];
  const results = await Promise.allSettled([
    api.workspaceMarkRunning(),
    shouldReopenArchive && rows.length > 0
      ? api.archivePutManyForExit(rows)
      : Promise.resolve(),
  ]);

  if (shouldReopenArchive && results[1].status === "fulfilled") {
    archivePreparedForExit = false;
  }
  exitPrepared = false;
  exitMarkedClean = false;
  resumeArchiveMutations();
  pausedForExit = false;

  let attachFailure: unknown | null = null;
  if (started) {
    try {
      attachActivitySources(true);
    } catch (err) {
      attachFailure = err;
    }
  }

  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (attachFailure) failures.push(attachFailure);
  const failure = failureFrom(failures, "could not restore persistence after a failed exit");
  if (failure) throw failure;
}

/**
 * Quiesce routine writers and commit the final workspace/archive data barrier.
 *
 * If any part fails, this function restores the running marker and activity
 * subscriptions before rejecting. Once it resolves, the caller owns rollback
 * through `resumePersistenceAfterFailedExit` if the exit itself is abandoned.
 * It deliberately does not mark the process clean: updater commands do that at
 * their backend irreversible boundaries, after this preparation has completed.
 */
export function preparePersistenceForExit(): Promise<void> {
  if (exitPrepared) return Promise.resolve();
  if (exitPreparation) return exitPreparation;

  let operation: Promise<void>;
  operation = (async () => {
    try {
      pausePersistenceForExit();
      await finalizePersistenceForExit();
    } catch (error) {
      try {
        await rollbackPreparedExit();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "exit persistence failed and could not be fully restored",
        );
      }
      throw error;
    }
  })().finally(() => {
    if (exitPreparation === operation) exitPreparation = null;
  });
  exitPreparation = operation;
  return operation;
}

/** Mark a prepared ordinary close clean, rolling the preparation back on error. */
function completePreparedCleanExit(): Promise<void> {
  if (exitMarkedClean) return Promise.resolve();
  if (cleanExitCommit) return cleanExitCommit;

  let operation: Promise<void>;
  operation = (async () => {
    await preparePersistenceForExit();
    try {
      // Nothing durable may follow this marker. Callers either complete their
      // close immediately or let the backend updater own this boundary.
      await api.workspaceMarkCleanExit();
      exitMarkedClean = true;
    } catch (error) {
      try {
        await rollbackPreparedExit();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "clean-exit marking failed and persistence could not be fully restored",
        );
      }
      throw error;
    }
  })().finally(() => {
    if (cleanExitCommit === operation) cleanExitCommit = null;
  });
  cleanExitCommit = operation;
  return operation;
}

/** Restore normal persistence when update apply/restart fails after prepare. */
export async function resumePersistenceAfterFailedExit(): Promise<void> {
  if (exitPreparation) await exitPreparation;
  if (cleanExitCommit) await cleanExitCommit;
  if (!pausedForExit && !exitPrepared && !archivePreparedForExit) return;
  if (resumeInFlight) return resumeInFlight;

  let operation: Promise<void>;
  operation = rollbackPreparedExit().finally(() => {
    if (resumeInFlight === operation) resumeInFlight = null;
  });
  resumeInFlight = operation;
  return operation;
}

/** Write everything now. Final callers use the strict transactional barrier. */
export function flushAll(opts: { final?: boolean; strict?: boolean } = {}): Promise<void> {
  if (opts.final) return completePreparedCleanExit();
  return flushRoutine(opts.strict ?? false);
}

function cancelScheduledWrites(): void {
  metaTimer = clearTimer(metaTimer);
  metaMaxTimer = clearTimer(metaMaxTimer);
  blobTimer = clearTimer(blobTimer);
  blobMaxTimer = clearTimer(blobMaxTimer);
  transcriptTimer = clearTimer(transcriptTimer);
  transcriptMaxTimer = clearTimer(transcriptMaxTimer);

  const idleApi = globalThis as { cancelIdleCallback?: (handle: number) => void };
  for (const task of idleTasks) {
    if (task.kind === "idle") idleApi.cancelIdleCallback?.(task.handle);
    else clearTimeout(task.handle);
  }
  idleTasks.clear();
}

function attachActivitySources(scheduleInitialWrite: boolean): void {
  if (!persistenceActive()) return;
  const initial = useAppStore.getState();
  lastFingerprint = fingerprint(initial);
  lastActiveId = initial.activeSessionId;

  unsubscribeStore = useAppStore.subscribe((state) => {
    if (!persistenceActive()) return;
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

  if (scheduleInitialWrite) scheduleMeta();
  if (dirtyScrollback.size > 0) scheduleBlob();
  if (dirtyTranscript.size > 0) scheduleTranscript();
  if (dirtyAgentCheckpoints.size > 0) startAgentCheckpointDrain();

  sweepTimer = setInterval(() => {
    if (!persistenceActive()) return;
    const sessions = useAppStore.getState().sessions;
    if (sessions.length === 0) return;
    // One tab per tick, round-robin — bounded work regardless of tab count.
    sweepCursor = (sweepCursor + 1) % sessions.length;
    markScrollbackDirty(sessions[sweepCursor].id);
  }, SWEEP_INTERVAL_MS);
}

function detachActivitySources(): void {
  unsubscribeStore?.();
  unsubscribeStore = null;
  for (const un of unsubscribeTerms) un();
  unsubscribeTerms = [];
  if (onBlur) window.removeEventListener("blur", onBlur);
  onBlur = null;
  if (sweepTimer !== null) clearInterval(sweepTimer);
  sweepTimer = null;
  cancelScheduledWrites();
}

export function startPersistence(): void {
  if (started) return;
  started = true;
  pausedForExit = false;
  exitPrepared = false;

  // Write the boot state once, immediately. Without this the run is persisted
  // only if something later CHANGES — so a window left untouched (or a shell
  // that never emits OSC 7) would leave the previous generation's rows as the
  // newest thing on disk, and this run's tabs would never be restorable.
  attachActivitySources(true);

  void installExitHooks();
}

/** Subscribe to a session's block stream. Safe to call for a session that has
 *  no term entry yet — subscribeTerm returns a no-op unsubscribe. */
export function watchSession(sessionId: string): () => void {
  return subscribeTerm(sessionId, (e) => {
    if (e.type === "blockEnd") markScrollbackDirty(sessionId);
  });
}

export function trackSession(sessionId: string): void {
  if (!persistenceActive()) return;
  unsubscribeTerms.push(watchSession(sessionId));
}

type AppQuitTicket = {
  token: number;
  origin: "menu" | "windowClose" | "exitRequested";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finishQuit(ticket: AppQuitTicket): Promise<void> {
  if (activeQuitToken !== null) return quitTask ?? Promise.resolve();
  activeQuitToken = ticket.token;

  let operation: Promise<void>;
  operation = (async () => {
    try {
      await preparePersistenceForExit();
      await api.appQuitCommit(ticket.token);
    } catch (error) {
      console.warn("final persistence barrier failed; forcing an unclean quit:", error);
      try {
        await api.appQuitForce(ticket.token, errorMessage(error));
      } catch (forceError) {
        // The Rust watchdog remains armed even if the webview/backend channel
        // disappears while reporting the barrier failure.
        console.error("could not request the unclean quit fallback:", forceError);
      }
    }
  })().finally(() => {
    // Keep the token claimed. A resolved invoke can race the event-loop exit;
    // accepting another close gesture here would start a second barrier.
    if (quitTask !== operation) return;
  });
  quitTask = operation;
  return operation;
}

async function installExitHooks(): Promise<void> {
  const generation = ++exitHookGeneration;
  try {
    // Install the app-wide listener first. Rust also prevents CloseRequested,
    // so a close in the small gap before the window listener still has a live
    // webview and is handled through this event.
    const quitUnlisten = await listen<AppQuitTicket>(APP_QUIT_EVENT, (event) => {
      void finishQuit(event.payload);
    });
    if (!started || generation !== exitHookGeneration) {
      quitUnlisten();
      return;
    }
    unlistenQuit = quitUnlisten;

    const win = getCurrentWindow();
    const closeUnlisten = await win.onCloseRequested((event: CloseRequestedEvent) => {
      // Tauri's JavaScript close listener has its own synchronous veto channel;
      // use it before the first await/IPC as well as Rust's prevent_close hook.
      // Never destroy the webview here: it owns the strict persistence barrier.
      event.preventDefault();
      void api
        .appQuitBegin("windowClose")
        .then((ticket) => finishQuit(ticket))
        .catch((error) => console.warn("could not begin coordinated quit:", error));
    });
    if (!started || generation !== exitHookGeneration) {
      closeUnlisten();
      return;
    }
    unlistenClose = closeUnlisten;
  } catch (err) {
    // Not fatal: Rust also intercepts the menu, window, and ExitRequested paths
    // and its bounded watchdog exits unclean if no frontend listener responds.
    console.warn("could not install coordinated exit hooks:", err);
  }
}

export function stopPersistence(): void {
  started = false;
  exitHookGeneration += 1;
  detachActivitySources();
  resumeArchiveMutations();
  unlistenClose?.();
  unlistenClose = null;
  unlistenQuit?.();
  unlistenQuit = null;
  dirtyScrollback.clear();
  dirtyTranscript.clear();
  dirtyAgentCheckpoints.clear();
  pausedForExit = false;
  exitPrepared = false;
  exitMarkedClean = false;
  archivePreparedForExit = false;
  activeQuitToken = null;
  quitTask = null;
}

/** Test seam. */
export function __resetPersistenceForTests(): void {
  stopPersistence();
  __resetArchiveWriteTrackerForTests();
  lastFingerprint = "";
  lastActiveId = null;
  sweepCursor = 0;
  routineFlushInFlight = null;
  routineFlushInFlightStrict = false;
  agentCheckpointDrain = null;
  exitPreparation = null;
  cleanExitCommit = null;
  exitMarkedClean = false;
  resumeInFlight = null;
  activeQuitToken = null;
  quitTask = null;
  inFlightWrites.clear();
  idleTasks.clear();
}

/** Test seam for event-driven quit coordination. */
export function __waitForQuitForTests(): Promise<void> {
  return quitTask ?? Promise.resolve();
}
