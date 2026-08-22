import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

type QuitTicket = {
  token: number;
  origin: "menu" | "windowClose" | "exitRequested";
};

const exitHooks = vi.hoisted(() => ({
  quitHandler: null as ((event: { payload: QuitTicket }) => void) | null,
  closeHandler: null as ((event: { preventDefault: () => void }) => void) | null,
  unlistenQuit: vi.fn(),
  unlistenClose: vi.fn(),
  destroyWindow: vi.fn(),
}));
const quitBeginMock = vi.hoisted(() => vi.fn<() => Promise<QuitTicket>>());
const quitCommitMock = vi.hoisted(() => vi.fn<(token: number) => Promise<void>>());
const quitForceMock = vi.hoisted(() =>
  vi.fn<(token: number, reason?: string) => Promise<void>>(),
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: QuitTicket }) => void) => {
    exitHooks.quitHandler = handler;
    return exitHooks.unlistenQuit;
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: { preventDefault: () => void }) => void) => {
      exitHooks.closeHandler = handler;
      return exitHooks.unlistenClose;
    },
    destroy: exitHooks.destroyWindow,
  }),
}));

const snapshotMock = vi.fn(async (_snapshot: WorkspaceSnapshotInput) => {});
const serializeMock = vi.fn((_id: string, lines: number) => ({ data: "PAYLOAD", lines }));
const archivePutManyMock = vi.fn(async (_rows: ArchiveSessionInput[]) => {});
const archivePutMock = vi.fn(async (_row: ArchiveSessionInput) => {});
const markCleanExitMock = vi.fn(async () => {});
const markRunningMock = vi.fn(async () => {});
const ptyKillMock = vi.fn(async (_sessionId: string) => {});
const aiCancelMock = vi.fn(async (_requestId: string) => {});

vi.mock("../lib/tauri", async () => {
  const tracker = await vi.importActual<typeof import("../lib/archiveWriteTracker")>(
    "../lib/archiveWriteTracker",
  );
  return {
    workspaceSnapshot: (s: unknown) => snapshotMock(s as WorkspaceSnapshotInput),
    archivePutMany: (rows: unknown) =>
      tracker.trackArchiveWrite(() => archivePutManyMock(rows as ArchiveSessionInput[])),
    archivePutManyForExit: (rows: unknown) =>
      tracker.trackExitArchiveWrite(() => archivePutManyMock(rows as ArchiveSessionInput[])),
    archivePut: (row: unknown) =>
      tracker.trackArchiveWrite(() => archivePutMock(row as ArchiveSessionInput)),
    workspaceMarkCleanExit: () => markCleanExitMock(),
    workspaceMarkRunning: () => markRunningMock(),
    ptyKill: (sessionId: string) => ptyKillMock(sessionId),
    aiCancel: (requestId: string) => aiCancelMock(requestId),
    appQuitBegin: () => quitBeginMock(),
    appQuitCommit: (token: number) => quitCommitMock(token),
    appQuitForce: (token: number, reason?: string) => quitForceMock(token, reason),
  };
});

// A term entry that is idle and has a live buffer, i.e. safe to serialize.
// `streaming` models a tab that keeps receiving output (lastDataAt never goes
// stale), which is the only way to stay non-quiescent across a debounce.
const termEntry = {
  disposed: false,
  streaming: false,
  get lastDataAt() {
    return this.streaming ? Date.now() : 0;
  },
  term: { cols: 120, rows: 40 },
  container: {},
};

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => termEntry,
  serializeSession: (id: string, lines: number) => serializeMock(id, lines),
  subscribeTerm: () => () => {},
  releaseWebgl: () => {},
  disposeTerm: () => {},
  acquireWebgl: () => {},
}));

import {
  __resetPersistenceForTests,
  __waitForQuitForTests,
  flushAll,
  markScrollbackDirty,
  markTranscriptCheckpoint,
  markTranscriptDirty,
  preparePersistenceForExit,
  resumePersistenceAfterFailedExit,
  startPersistence,
  stopPersistence,
} from "../lib/sessionPersistence";
import { archiveOnClose } from "../lib/sessionArchive";
import { startNewChat } from "../lib/newChat";
import { useSessions } from "../hooks/useSessions";
import {
  protectRunbookTerminal,
  resetRunbookTerminalPrivacyForTests,
} from "../lib/runbookTerminalPrivacy";
import { useAppStore, emptyAiStream, emptySessionUi } from "../stores/appStore";
import type { ArchiveSessionInput, Session, WorkspaceSnapshotInput } from "../lib/types";

/** The payload of the most recent workspaceSnapshot call. */
function lastSnapshot(): WorkspaceSnapshotInput {
  const calls = snapshotMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: "/Users/me/proj",
    createdAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
    ...over,
  };
}

function seed(sessions: Session[], activeId: string | null) {
  useAppStore.setState({
    sessions,
    activeSessionId: activeId,
    sessionUi: Object.fromEntries(sessions.map((s) => [s.id, emptySessionUi()])),
    aiStreams: {},
    restoreScrollbackLines: 1000,
    scrollbackLines: 10000,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForExitHooks(): Promise<void> {
  for (let i = 0; i < 5 && (!exitHooks.quitHandler || !exitHooks.closeHandler); i += 1) {
    await Promise.resolve();
  }
  expect(exitHooks.quitHandler).not.toBeNull();
  expect(exitHooks.closeHandler).not.toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  snapshotMock.mockClear();
  snapshotMock.mockResolvedValue(undefined);
  serializeMock.mockClear();
  archivePutManyMock.mockClear();
  archivePutManyMock.mockResolvedValue(undefined);
  archivePutMock.mockClear();
  archivePutMock.mockResolvedValue(undefined);
  markCleanExitMock.mockClear();
  markCleanExitMock.mockResolvedValue(undefined);
  markRunningMock.mockClear();
  markRunningMock.mockResolvedValue(undefined);
  ptyKillMock.mockClear();
  ptyKillMock.mockResolvedValue(undefined);
  aiCancelMock.mockClear();
  aiCancelMock.mockResolvedValue(undefined);
  quitBeginMock.mockReset();
  quitBeginMock.mockResolvedValue({ token: 7, origin: "windowClose" });
  quitCommitMock.mockReset();
  quitCommitMock.mockResolvedValue(undefined);
  quitForceMock.mockReset();
  quitForceMock.mockResolvedValue(undefined);
  exitHooks.quitHandler = null;
  exitHooks.closeHandler = null;
  exitHooks.unlistenQuit.mockClear();
  exitHooks.unlistenClose.mockClear();
  exitHooks.destroyWindow.mockClear();
  termEntry.streaming = false;
  termEntry.disposed = false;
  __resetPersistenceForTests();
  resetRunbookTerminalPrivacyForTests();
  seed([makeSession("a")], "a");
});

afterEach(() => {
  __resetPersistenceForTests();
  resetRunbookTerminalPrivacyForTests();
  vi.useRealTimers();
});

describe("metadata snapshots", () => {
  it("captures tab order, active tab, cwd, title and shell", async () => {
    seed([makeSession("a"), makeSession("b", { userTitle: "logs", cwd: "/var/log" })], "b");
    startPersistence();
    await flushAll();

    const arg = lastSnapshot();
    expect(arg.active_session_id).toBe("b");
    expect(arg.sessions.map((s) => s.session_id)).toEqual(["a", "b"]);
    expect(arg.sessions.map((s) => s.tab_index)).toEqual([0, 1]);
    expect(arg.sessions[1].title).toBe("logs");
    expect(arg.sessions[1].cwd).toBe("/var/log");
  });

  it("persists no title for a tab that was never named, so a derived label is not pinned", async () => {
    // Regression: the cwd basename used to be stored here, which is how a tab
    // opened in $HOME came back permanently named after the user.
    seed([makeSession("a", { cwd: "/Users/me" })], "a");
    startPersistence();
    await flushAll();
    expect(lastSnapshot().sessions[0].title).toBe("");
  });

  it("records the terminal's real dimensions, not 80x24", async () => {
    startPersistence();
    await flushAll();
    const arg = lastSnapshot();
    expect(arg.sessions[0].cols).toBe(120);
    expect(arg.sessions[0].rows).toBe(40);
  });

  it("persists the host label for a saved-host tab", async () => {
    seed([makeSession("a", { hostLabel: "prod-01", hostId: "h1" })], "a");
    startPersistence();
    await flushAll();
    const arg = lastSnapshot();
    expect(arg.sessions[0].title).toBe("prod-01");
    expect(arg.sessions[0].host_id).toBe("h1");
  });

  it("prefers an explicit rename over the host label and the model's name", async () => {
    seed(
      [makeSession("a", { userTitle: "mine", aiTitle: "guessed", hostLabel: "prod-01" })],
      "a",
    );
    startPersistence();
    await flushAll();
    expect(lastSnapshot().sessions[0].title).toBe("mine");
  });

  it("sends scrollback: null on a store-change tick so the stored blob survives", async () => {
    startPersistence();
    useAppStore.getState().updateSession("a", { cwd: "/somewhere/else" });
    await vi.advanceTimersByTimeAsync(800);

    expect(snapshotMock).toHaveBeenCalledTimes(1);
    const arg = lastSnapshot();
    expect(arg.sessions[0].scrollback).toBeNull();
    expect(serializeMock).not.toHaveBeenCalled();
  });

  it("writes the boot state even if nothing ever changes", async () => {
    // Regression: persistence used to write only on CHANGE, so a window the
    // user never touched left the previous run as the newest thing on disk.
    startPersistence();
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().sessions[0].session_id).toBe("a");
  });

  it("coalesces a burst of changes into one write", async () => {
    startPersistence();
    for (const cwd of ["/a", "/b", "/c", "/d", "/e"]) {
      useAppStore.getState().updateSession("a", { cwd });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(snapshotMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
  });

  it("still writes during a continuous stream of changes (max-wait)", async () => {
    startPersistence();
    for (let i = 0; i < 20; i++) {
      useAppStore.getState().updateSession("a", { cwd: `/dir${i}` });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(snapshotMock).toHaveBeenCalled();
  });

  it("ignores store changes that do not affect any persisted field", async () => {
    startPersistence();
    // Let the boot write land, then assert nothing FURTHER is written.
    await vi.advanceTimersByTimeAsync(1000);
    snapshotMock.mockClear();

    useAppStore.setState({ aiPanelOpen: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it("persists an exited tab so it restores as a live shell in the same directory", async () => {
    seed([makeSession("a", { exited: true, exitCode: 1 })], "a");
    startPersistence();
    await flushAll();
    const arg = lastSnapshot();
    expect(arg.sessions).toHaveLength(1);
  });
});

describe("scrollback capture", () => {
  it("actively clears stored scrollback and never serializes a Runbook-bound terminal", async () => {
    startPersistence();
    protectRunbookTerminal("a");
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(3500);

    expect(serializeMock).not.toHaveBeenCalled();
    const arg = lastSnapshot();
    expect(arg.sessions[0].scrollback).toBe("");
    expect(arg.sessions[0].scrollback_lines).toBe(0);
  });

  it("serializes a dirty, quiet session", async () => {
    startPersistence();
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(3500);

    expect(serializeMock).toHaveBeenCalledWith("a", 1000);
    const arg = lastSnapshot();
    expect(arg.sessions[0].scrollback).toBe("PAYLOAD");
    expect(arg.sessions[0].scrollback_lines).toBe(1000);
  });

  it("never asks for more lines than the terminal actually keeps", async () => {
    useAppStore.setState({ scrollbackLines: 200 });
    startPersistence();
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(3500);
    expect(serializeMock).toHaveBeenCalledWith("a", 200);
  });

  it("skips a session that is mid-command", async () => {
    useAppStore.getState().updateSessionUi("a", { runningBlockId: "blk-1" });
    startPersistence();
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(serializeMock).not.toHaveBeenCalled();
  });

  it("never serializes a tab that keeps producing output", async () => {
    // A `tail -f` or a long build: capturing mid-stream would store a torn
    // frame, so the capture must keep deferring until the output stops.
    termEntry.streaming = true;
    startPersistence();
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(serializeMock).not.toHaveBeenCalled();
  });

  it("captures once the output finally settles", async () => {
    termEntry.streaming = true;
    startPersistence();
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(serializeMock).not.toHaveBeenCalled();

    termEntry.streaming = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(serializeMock).toHaveBeenCalledWith("a", 1000);
  });

  it("captures nothing when the user set scrollback restore to Off", async () => {
    useAppStore.setState({ restoreScrollbackLines: 0 });
    startPersistence();
    markScrollbackDirty("a");
    await vi.advanceTimersByTimeAsync(3500);
    expect(serializeMock).not.toHaveBeenCalled();
  });

  it("captures the tab you switch away from", async () => {
    seed([makeSession("a"), makeSession("b")], "a");
    startPersistence();
    useAppStore.getState().setActiveSession("b");
    await vi.advanceTimersByTimeAsync(3500);
    expect(serializeMock).toHaveBeenCalledWith("a", 1000);
  });
});

describe("flushAll", () => {
  it("marks the exit clean only after the final data writes", async () => {
    startPersistence();
    await flushAll({ final: true });
    const arg = lastSnapshot();
    expect(arg).not.toHaveProperty("final_flush");
    expect(markCleanExitMock).toHaveBeenCalledTimes(1);
    expect(snapshotMock.mock.invocationCallOrder[0]).toBeLessThan(
      markCleanExitMock.mock.invocationCallOrder[0],
    );
    expect(archivePutManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      markCleanExitMock.mock.invocationCallOrder[0],
    );
  });

  it("includes every session's scrollback", async () => {
    startPersistence();
    await flushAll({ final: true });
    expect(serializeMock).toHaveBeenCalledWith("a", 1000);
  });

  it("stages every tab open until the backend atomically commits the clean quit", async () => {
    // Both stores are written on the same flush. Without this the archive half
    // is silently absent on a normal ⌘Q — the commonest way a session ends.
    startPersistence();
    await flushAll({ final: true });
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    const rows = archivePutManyMock.mock.calls[0][0];
    expect(rows.map((r) => r.session_id)).toEqual(["a"]);
    expect(rows[0].close_reason).toBeNull();
    expect(rows[0].is_open).toBe(true);
    expect(rows[0].scrollback).toBe("PAYLOAD");
  });

  it("does not archive on a routine non-final flush", async () => {
    // The ~750ms tick must not write archive rows for tabs that are still open —
    // that is what the separate transcript path is for.
    startPersistence();
    await flushAll();
    expect(archivePutManyMock).not.toHaveBeenCalled();
  });

  it("collapses concurrent callers into a single write", async () => {
    startPersistence();
    await Promise.all([flushAll(), flushAll(), flushAll()]);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
  });

  it("survives a failing backend without throwing", async () => {
    snapshotMock.mockRejectedValueOnce(new Error("db poisoned"));
    startPersistence();
    await expect(flushAll()).resolves.toBeUndefined();
  });

  it("surfaces a failing backend when a restart requires a durable snapshot", async () => {
    snapshotMock.mockRejectedValueOnce(new Error("db poisoned"));
    startPersistence();
    await expect(flushAll({ final: true, strict: true })).rejects.toThrow("db poisoned");
  });
});

describe("transactional exit persistence", () => {
  it("keeps routine snapshots data-only", async () => {
    startPersistence();
    await flushAll();
    expect(lastSnapshot()).not.toHaveProperty("final_flush");
    expect(markCleanExitMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent prepare callers without marking the run clean", async () => {
    startPersistence();
    await Promise.all([
      preparePersistenceForExit(),
      preparePersistenceForExit(),
      preparePersistenceForExit(),
    ]);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    expect(markCleanExitMock).not.toHaveBeenCalled();
  });

  it("prepare alone saves strictly but leaves planned-exit marking to the caller", async () => {
    startPersistence();
    await preparePersistenceForExit();

    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    expect(markCleanExitMock).not.toHaveBeenCalled();
  });

  it("drains an in-flight transcript before writing the provisional final archive", async () => {
    useAppStore.setState({
      aiStreams: {
        a: {
          ...emptyAiStream(),
          messages: [
            {
              id: "m1",
              role: "user",
              content: "keep this",
              createdAt: "2026-08-14T12:00:00.000Z",
            },
          ],
        },
      },
    });
    const openWrite = deferred<void>();
    archivePutMock.mockReturnValueOnce(openWrite.promise);

    startPersistence();
    markTranscriptDirty("a");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(archivePutMock).toHaveBeenCalledTimes(1);

    const preparing = preparePersistenceForExit();
    await Promise.resolve();
    expect(archivePutManyMock).not.toHaveBeenCalled();
    expect(markCleanExitMock).not.toHaveBeenCalled();

    openWrite.resolve();
    await preparing;
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock.mock.calls[0][0][0].is_open).toBe(true);
    expect(markCleanExitMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(archivePutMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
  });

  it("writes Agent checkpoints immediately and follows an in-flight write with the newest one", async () => {
    useAppStore.setState({
      aiStreams: {
        a: {
          ...emptyAiStream(),
          messages: [
            {
              id: "m1",
              role: "user",
              content: "checkpoint me",
              createdAt: "2026-08-14T12:00:00.000Z",
            },
          ],
          modelTranscript: [{ role: "user", content: "checkpoint one" }],
        },
      },
    });
    const firstWrite = deferred<void>();
    archivePutMock.mockReturnValueOnce(firstWrite.promise);

    startPersistence();
    markTranscriptCheckpoint("a");
    expect(archivePutMock).toHaveBeenCalledTimes(1);

    useAppStore.getState().setModelTranscript("a", [
      { role: "user", content: "checkpoint two" },
    ]);
    markTranscriptCheckpoint("a");
    expect(archivePutMock).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    for (let i = 0; i < 10 && archivePutMock.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }

    expect(archivePutMock).toHaveBeenCalledTimes(2);
    expect(archivePutMock.mock.calls[1][0].model_transcript).toEqual([
      { role: "user", content: "checkpoint two" },
    ]);
  });

  it("retries a failed Agent checkpoint once on the slow transcript timer", async () => {
    useAppStore.setState({
      aiStreams: {
        a: {
          ...emptyAiStream(),
          messages: [
            {
              id: "m1",
              role: "user",
              content: "checkpoint me",
              createdAt: "2026-08-14T12:00:00.000Z",
            },
          ],
          modelTranscript: [{ role: "user", content: "checkpoint retry" }],
        },
      },
    });
    archivePutMock.mockRejectedValueOnce(new Error("disk unavailable"));

    startPersistence();
    markTranscriptCheckpoint("a");
    expect(archivePutMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(archivePutMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(archivePutMock).toHaveBeenCalledTimes(2);
  });

  it("waits for a tab-close archive IPC even after its UI budget expires", async () => {
    const closeWrite = deferred<void>();
    archivePutMock.mockReturnValueOnce(closeWrite.promise);
    startPersistence();

    const closing = archiveOnClose("a");
    expect(archivePutMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    await closing;

    const preparing = preparePersistenceForExit();
    await Promise.resolve();

    expect(archivePutManyMock).not.toHaveBeenCalled();
    closeWrite.resolve();
    await Promise.all([closing, preparing]);

    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    expect(archivePutMock.mock.invocationCallOrder[0]).toBeLessThan(
      archivePutManyMock.mock.invocationCallOrder[0],
    );
  });

  it("rejects the strict barrier when a timed-out tab-close archive later fails", async () => {
    const closeWrite = deferred<void>();
    archivePutMock.mockReturnValueOnce(closeWrite.promise);
    startPersistence();

    const closing = archiveOnClose("a");
    await vi.advanceTimersByTimeAsync(500);
    await closing;

    const preparing = preparePersistenceForExit();
    await Promise.resolve();
    closeWrite.reject(new Error("close archive unavailable"));

    await expect(preparing).rejects.toThrow("close archive unavailable");
    expect(archivePutManyMock).not.toHaveBeenCalled();
    expect(markRunningMock).toHaveBeenCalledTimes(1);
  });

  it("leases closeSession before its deferred PTY kill so the final snapshot cannot restore it", async () => {
    const kill = deferred<void>();
    ptyKillMock.mockReturnValueOnce(kill.promise);
    const { result } = renderHook(() => useSessions());
    startPersistence();

    const closing = result.current.closeSession("a");
    expect(ptyKillMock).toHaveBeenCalledWith("a");
    const preparing = preparePersistenceForExit();
    await Promise.resolve();
    expect(snapshotMock).not.toHaveBeenCalled();

    kill.resolve();
    await Promise.all([closing, preparing]);

    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(lastSnapshot().sessions).toEqual([]);
    expect(archivePutMock.mock.invocationCallOrder[0]).toBeLessThan(
      snapshotMock.mock.invocationCallOrder[0],
    );
  });

  it("leases New chat before deferred AI cancellation and orders its archive before quit rows", async () => {
    useAppStore.setState({
      restoreSessionsOnStart: true,
      archiveEnabled: true,
      aiStreams: {
        a: {
          ...emptyAiStream(),
          requestId: "request-1",
          status: "streaming",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "old conversation",
              createdAt: "2026-08-14T12:00:00.000Z",
            },
          ],
        },
      },
    });
    const cancellation = deferred<void>();
    aiCancelMock.mockReturnValueOnce(cancellation.promise);
    startPersistence();

    const newChat = startNewChat("a");
    expect(aiCancelMock).toHaveBeenCalledWith("request-1");
    const preparing = preparePersistenceForExit();
    await Promise.resolve();
    expect(archivePutManyMock).not.toHaveBeenCalled();

    cancellation.resolve();
    await Promise.all([newChat, preparing]);

    expect(archivePutManyMock).toHaveBeenCalledTimes(2);
    expect(archivePutManyMock.mock.calls[0][0]).toHaveLength(2);
    expect(archivePutManyMock.mock.calls[1][0]).toHaveLength(1);
    expect(archivePutManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      archivePutManyMock.mock.invocationCallOrder[1],
    );
  });

  it("folds visible streaming text into the final quit archive", async () => {
    useAppStore.setState({
      aiStreams: {
        a: {
          ...emptyAiStream(),
          status: "streaming",
          requestId: "request-1",
          model: "test-model",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "question",
              createdAt: "2026-08-14T12:00:00.000Z",
            },
          ],
          streamingContent: "PARTIAL ANSWER",
          thinkingContent: "partial reasoning",
          modelTranscript: [{ role: "user", content: "earlier model context" }],
        },
      },
    });
    startPersistence();

    await preparePersistenceForExit();

    const rows = archivePutManyMock.mock.calls[0][0];
    expect(rows[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "PARTIAL ANSWER",
          thinking: "partial reasoning",
        }),
      ]),
    );
    expect(rows[0].model_transcript).toEqual([
      { role: "user", content: "earlier model context" },
    ]);
    expect(useAppStore.getState().aiStreams.a.streamingContent).toBe("");
    expect(useAppStore.getState().aiStreams.a.requestId).toBeNull();
    expect(aiCancelMock).toHaveBeenCalledWith("request-1");
  });

  it("fences the Done-to-agent-promise gap before the final archive snapshot", async () => {
    useAppStore.setState({
      aiStreams: {
        a: {
          ...emptyAiStream(),
          mode: "agent",
          status: "idle",
          // Done has already settled the visible stream, but agentStart has not
          // resolved with its model transcript yet.
          requestId: null,
          generationId: "agent-generation-1",
          modelTranscript: [{ role: "user", content: "durable history" }],
        },
      },
    });
    startPersistence();

    await preparePersistenceForExit();

    expect(useAppStore.getState().aiStreams.a.generationId).toBeNull();
    expect(archivePutManyMock.mock.calls[0][0][0].model_transcript).toEqual([
      { role: "user", content: "durable history" },
    ]);

    // Model the delayed agentStart success continuation. Its conditional store
    // action must be a no-op after the exit generation fence.
    useAppStore.getState().setModelTranscriptForGeneration("a", "agent-generation-1", [
      { role: "assistant", content: "too late for the final archive" },
    ]);
    expect(useAppStore.getState().aiStreams.a.modelTranscript).toEqual([
      { role: "user", content: "durable history" },
    ]);
  });

  it("rolls back and resumes activity before rejecting a failed final barrier", async () => {
    archivePutManyMock.mockRejectedValueOnce(new Error("archive unavailable"));
    startPersistence();

    await expect(preparePersistenceForExit()).rejects.toThrow("archive unavailable");
    expect(markCleanExitMock).not.toHaveBeenCalled();
    expect(markRunningMock).toHaveBeenCalledTimes(1);

    const writesAfterFailure = snapshotMock.mock.calls.length;
    useAppStore.getState().updateSession("a", { cwd: "/after-failure" });
    await vi.advanceTimersByTimeAsync(800);
    expect(snapshotMock.mock.calls.length).toBeGreaterThan(writesAfterFailure);
  });

  it("clears provisional archive state when another final write fails", async () => {
    snapshotMock.mockRejectedValueOnce(new Error("snapshot unavailable"));
    startPersistence();

    await expect(preparePersistenceForExit()).rejects.toThrow("snapshot unavailable");
    expect(archivePutManyMock).toHaveBeenCalledTimes(2);
    expect(archivePutManyMock.mock.calls[0][0][0].is_open).toBe(true);
    expect(archivePutManyMock.mock.calls[1][0][0].is_open).toBe(true);
    expect(markRunningMock).toHaveBeenCalledTimes(1);
  });

  it("retries a dirty blob after a strict final snapshot fails and persistence resumes", async () => {
    snapshotMock.mockRejectedValueOnce(new Error("snapshot unavailable"));
    startPersistence();
    markScrollbackDirty("a");

    await expect(preparePersistenceForExit()).rejects.toThrow("snapshot unavailable");
    expect(snapshotMock.mock.calls[0][0].sessions[0].scrollback).toBe("PAYLOAD");

    await vi.advanceTimersByTimeAsync(3_500);
    const resumedSnapshots = snapshotMock.mock.calls.slice(1).map((call) => call[0]);
    expect(
      resumedSnapshots.some((snapshot) => snapshot.sessions[0].scrollback === "PAYLOAD"),
    ).toBe(true);
  });

  it("restores running state when the clean marker itself fails", async () => {
    markCleanExitMock.mockRejectedValueOnce(new Error("marker unavailable"));
    startPersistence();

    await expect(flushAll({ final: true, strict: true })).rejects.toThrow("marker unavailable");
    expect(markRunningMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock).toHaveBeenCalledTimes(2);
    expect(archivePutManyMock.mock.calls[1][0][0].is_open).toBe(true);

    const writesAfterFailure = snapshotMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(800);
    expect(snapshotMock.mock.calls.length).toBeGreaterThan(writesAfterFailure);
  });

  it("stays paused after prepare and resumes explicitly after an abandoned exit", async () => {
    startPersistence();
    await preparePersistenceForExit();
    const writesAtBarrier = snapshotMock.mock.calls.length;

    useAppStore.getState().updateSession("a", { cwd: "/while-paused" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(snapshotMock).toHaveBeenCalledTimes(writesAtBarrier);

    await resumePersistenceAfterFailedExit();
    expect(markRunningMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock).toHaveBeenCalledTimes(2);
    expect(archivePutManyMock.mock.calls[1][0][0].is_open).toBe(true);

    await vi.advanceTimersByTimeAsync(800);
    expect(snapshotMock.mock.calls.length).toBeGreaterThan(writesAtBarrier);
  });

  it("stages a reopened source only for prepare and clears it on rollback", async () => {
    seed([makeSession("a", { archivedFrom: "source-archive" })], "a");
    startPersistence();

    await preparePersistenceForExit();
    expect(archivePutManyMock.mock.calls[0][0][0]).toMatchObject({
      is_open: true,
      supersedes: "source-archive",
    });

    await resumePersistenceAfterFailedExit();
    expect(archivePutManyMock.mock.calls[1][0][0]).toMatchObject({
      is_open: true,
      supersedes: null,
    });
  });
});

describe("coordinated application quit", () => {
  it("commits through Rust only after the strict frontend barrier", async () => {
    startPersistence();
    await waitForExitHooks();

    exitHooks.quitHandler?.({ payload: { token: 7, origin: "menu" } });
    await __waitForQuitForTests();

    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    expect(quitCommitMock).toHaveBeenCalledWith(7);
    expect(markCleanExitMock).not.toHaveBeenCalled();
    expect(quitForceMock).not.toHaveBeenCalled();
    expect(archivePutManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      quitCommitMock.mock.invocationCallOrder[0],
    );
  });

  it("coalesces the Rust event and native window-close callback", async () => {
    startPersistence();
    await waitForExitHooks();

    exitHooks.quitHandler?.({ payload: { token: 7, origin: "windowClose" } });
    const preventDefault = vi.fn();
    exitHooks.closeHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(preventDefault.mock.invocationCallOrder[0]).toBeLessThan(
      quitBeginMock.mock.invocationCallOrder[0],
    );
    expect(exitHooks.destroyWindow).not.toHaveBeenCalled();
    await __waitForQuitForTests();
    await Promise.resolve();

    expect(quitBeginMock).toHaveBeenCalledTimes(1);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(quitCommitMock).toHaveBeenCalledTimes(1);
  });

  it("forces an honestly unclean exit when the strict barrier fails", async () => {
    snapshotMock.mockRejectedValueOnce(new Error("snapshot unavailable"));
    startPersistence();
    await waitForExitHooks();

    exitHooks.quitHandler?.({ payload: { token: 7, origin: "exitRequested" } });
    await __waitForQuitForTests();

    expect(quitCommitMock).not.toHaveBeenCalled();
    expect(quitForceMock).toHaveBeenCalledWith(7, "snapshot unavailable");
    expect(markRunningMock).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes both exit hooks without ever destroying the webview", async () => {
    startPersistence();
    await waitForExitHooks();
    stopPersistence();

    expect(exitHooks.unlistenQuit).toHaveBeenCalledTimes(1);
    expect(exitHooks.unlistenClose).toHaveBeenCalledTimes(1);
  });
});
