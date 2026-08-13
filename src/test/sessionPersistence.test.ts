import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshotMock = vi.fn(async (_snapshot: WorkspaceSnapshotInput) => {});
const serializeMock = vi.fn((_id: string, lines: number) => ({ data: "PAYLOAD", lines }));
const archivePutManyMock = vi.fn(async (_rows: ArchiveSessionInput[]) => {});
const archivePutMock = vi.fn(async (_row: ArchiveSessionInput) => {});

vi.mock("../lib/tauri", () => ({
  workspaceSnapshot: (s: unknown) => snapshotMock(s as WorkspaceSnapshotInput),
  archivePutMany: (rows: unknown) => archivePutManyMock(rows as ArchiveSessionInput[]),
  archivePut: (row: unknown) => archivePutMock(row as ArchiveSessionInput),
}));

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
}));

import {
  __resetPersistenceForTests,
  flushAll,
  markScrollbackDirty,
  startPersistence,
} from "../lib/sessionPersistence";
import {
  protectRunbookTerminal,
  resetRunbookTerminalPrivacyForTests,
} from "../lib/runbookTerminalPrivacy";
import { useAppStore, emptySessionUi } from "../stores/appStore";
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

beforeEach(() => {
  vi.useFakeTimers();
  snapshotMock.mockClear();
  snapshotMock.mockResolvedValue(undefined);
  serializeMock.mockClear();
  archivePutManyMock.mockClear();
  archivePutManyMock.mockResolvedValue(undefined);
  archivePutMock.mockClear();
  archivePutMock.mockResolvedValue(undefined);
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
  it("marks the final flush so the next boot knows the exit was clean", async () => {
    startPersistence();
    await flushAll({ final: true });
    const arg = lastSnapshot();
    expect(arg.final_flush).toBe(true);
  });

  it("includes every session's scrollback", async () => {
    startPersistence();
    await flushAll({ final: true });
    expect(serializeMock).toHaveBeenCalledWith("a", 1000);
  });

  it("archives every tab at quit, as a clean quit", async () => {
    // Both stores are written on the same flush. Without this the archive half
    // is silently absent on a normal ⌘Q — the commonest way a session ends.
    startPersistence();
    await flushAll({ final: true });
    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    const rows = archivePutManyMock.mock.calls[0][0];
    expect(rows.map((r) => r.session_id)).toEqual(["a"]);
    expect(rows[0].close_reason).toBe("quit");
    expect(rows[0].is_open).toBe(false);
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
