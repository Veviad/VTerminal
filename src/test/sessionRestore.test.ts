import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const restoreMock = vi.fn();
const scrollbackMock = vi.fn(async (_id: string) => null as string | null);
const ptyEventHandlers = new Map<string, (event: { type: string; exit_code?: number | null }) => void>();
const spawnMock = vi.fn(
  async (
    sessionId: string,
    _params: unknown,
    _onData: unknown,
    onEvent: (event: { type: string; exit_code?: number | null }) => void,
  ) => {
    ptyEventHandlers.set(sessionId, onEvent);
    return 1234;
  },
);
const aiCancelMock = vi.fn(async (_requestId: string) => {});
const ptyKillMock = vi.fn(async (_sessionId: string) => {});
const abortSessionMock = vi.fn();
const archiveOnCloseMock = vi.fn(async (_sessionId: string) => {});
const disposeTermMock = vi.fn();
const releaseWebglMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  workspaceRestore: () => restoreMock(),
  workspaceScrollback: (id: string) => scrollbackMock(id),
  ptySpawn: (
    sessionId: string,
    params: unknown,
    onData: unknown,
    onEvent: (event: { type: string; exit_code?: number | null }) => void,
  ) => spawnMock(sessionId, params, onData, onEvent),
  ptyWrite: async () => {},
  ptyResize: async () => {},
  ptyAck: async () => {},
  ptyKill: (sessionId: string) => ptyKillMock(sessionId),
  releasePtyChannels: () => {},
  aiCancel: (requestId: string) => aiCancelMock(requestId),
  historyRecord: async () => "",
  sshHostsTouch: async () => {},
}));

vi.mock("../lib/ptyExec", () => ({
  abortSession: (sessionId: string, reason: string) => abortSessionMock(sessionId, reason),
  isBusy: () => false,
  resetSessionMode: vi.fn(),
}));

vi.mock("../lib/sessionArchive", () => ({
  archiveOnClose: (sessionId: string) => archiveOnCloseMock(sessionId),
}));

const fakeTerm = {
  cols: 144,
  rows: 36,
  write: (_d: unknown, cb?: () => void) => cb?.(),
  resize: vi.fn(),
  onData: () => ({ dispose() {} }),
  onResize: () => ({ dispose() {} }),
  onSelectionChange: () => ({ dispose() {} }),
  hasSelection: () => false,
  getSelection: () => "",
  focus: () => {},
};

vi.mock("../lib/termRegistry", () => ({
  getOrCreateTerm: () => ({
    term: fakeTerm,
    fit: { fit: vi.fn() },
    // offsetParent null models an inactive/hidden pane.
    container: { offsetParent: {} },
    disposed: false,
    unackedBytes: 0,
    blockMarkers: new Map(),
    tracker: { isAtPromptColumn: () => true },
  }),
  getTerm: () => ({
    term: fakeTerm,
    fit: { fit: vi.fn() },
    container: { offsetParent: {} },
    disposed: false,
  }),
  subscribeTerm: () => () => {},
  emitTerm: () => {},
  disposeTerm: (sessionId: string) => disposeTermMock(sessionId),
  releaseWebgl: (entry: unknown) => releaseWebglMock(entry),
  acquireWebgl: () => {},
  replayScrollback: async () => {},
}));

vi.mock("../lib/sessionPersistence", () => ({
  trackSession: () => {},
  startPersistence: () => {},
  markTranscriptDirty: () => {},
}));

import { useSessions } from "../hooks/useSessions";
import { useAppStore } from "../stores/appStore";
import { captureSidecarRemoteIdentity } from "../lib/sidecar";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";
import type { SessionSnapshotMeta } from "../lib/types";

function meta(id: string, index: number, over: Partial<SessionSnapshotMeta> = {}): SessionSnapshotMeta {
  return {
    session_id: id,
    tab_index: index,
    title: `tab-${index}`,
    shell: "/bin/zsh",
    cwd: `/dir/${index}`,
    host_id: null,
    remote_kind: null,
    remote_target: null,
    cols: 120,
    rows: 40,
    script_version: "4",
    scrollback_lines: 0,
    updated_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  restoreMock.mockReset();
  scrollbackMock.mockReset();
  scrollbackMock.mockResolvedValue(null);
  ptyEventHandlers.clear();
  spawnMock.mockReset();
  spawnMock.mockImplementation(
    async (
      sessionId: string,
      _params: unknown,
      _onData: unknown,
      onEvent: (event: { type: string; exit_code?: number | null }) => void,
    ) => {
      ptyEventHandlers.set(sessionId, onEvent);
      return 1234;
    },
  );
  aiCancelMock.mockClear();
  aiCancelMock.mockResolvedValue(undefined);
  ptyKillMock.mockClear();
  ptyKillMock.mockResolvedValue(undefined);
  abortSessionMock.mockClear();
  archiveOnCloseMock.mockClear();
  disposeTermMock.mockClear();
  releaseWebglMock.mockClear();
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    sidecars: {},
  });
  useUpdateStore.setState({ ...initialUpdateState });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session creation update barrier", () => {
  it("refuses to add or spawn a terminal after durable update saving begins", async () => {
    useUpdateStore.setState({ status: "saving" });
    const { result } = renderHook(() => useSessions());

    await expect(result.current.createSession()).rejects.toThrow(/applying an update/i);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessions).toHaveLength(0);
  });
});

describe("restoreSessions", () => {
  it("returns 0 when there is nothing saved, so App opens a fresh tab", async () => {
    restoreMock.mockResolvedValue({
      sessions: [],
      active_session_id: null,
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    await expect(result.current.restoreSessions()).resolves.toBe(0);
  });

  it("returns 0 rather than throwing when the backend fails", async () => {
    restoreMock.mockRejectedValue(new Error("db poisoned"));
    const { result } = renderHook(() => useSessions());
    await expect(result.current.restoreSessions()).resolves.toBe(0);
  });

  it("rebuilds tabs in saved order with fresh ids and the saved cwd", async () => {
    restoreMock.mockResolvedValue({
      sessions: [meta("old-b", 1), meta("old-a", 0)],
      active_session_id: "old-a",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    const n = await result.current.restoreSessions();

    expect(n).toBe(2);
    const state = useAppStore.getState();
    expect(state.sessions.map((s) => s.cwd)).toEqual(["/dir/0", "/dir/1"]);
    // Fresh ids: reusing them would merge two runs in command_history.
    expect(state.sessions.map((s) => s.id)).not.toContain("old-a");
    expect(state.activeSessionId).toBe(state.sessions[0].id);
  });

  it("carries the saved host through so the tab can offer Reconnect", async () => {
    restoreMock.mockResolvedValue({
      sessions: [meta("old", 0, { host_id: "h1", title: "prod-01", remote_kind: "ssh" })],
      active_session_id: "old",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();

    const s = useAppStore.getState().sessions[0];
    expect(s.hostId).toBe("h1");
    // A host tab's stored label is its host identity, not a rename.
    expect(s.hostLabel).toBe("prod-01");
    expect(s.userTitle).toBeNull();
    // The dead connection is NOT reinstated — that would be a lie.
    expect(useAppStore.getState().sessionUi[s.id]?.remote).toBeNull();
  });

  it("restores a hand-renamed tab as a rename, not as a host label", async () => {
    restoreMock.mockResolvedValue({
      sessions: [meta("old", 0, { host_id: null, title: "my tab" })],
      active_session_id: "old",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();

    const s = useAppStore.getState().sessions[0];
    expect(s.userTitle).toBe("my tab");
    expect(s.hostLabel).toBeNull();
  });

  it("does not pin a label for a tab that was never named", async () => {
    restoreMock.mockResolvedValue({
      sessions: [meta("old", 0, { host_id: null, title: "" })],
      active_session_id: "old",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();

    const s = useAppStore.getState().sessions[0];
    expect(s.userTitle).toBeNull();
    expect(s.hostLabel).toBeNull();
  });

  it("skips the scrollback fetch when nothing was stored", async () => {
    restoreMock.mockResolvedValue({
      sessions: [meta("old", 0, { scrollback_lines: 0 })],
      active_session_id: "old",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();
    expect(scrollbackMock).not.toHaveBeenCalled();
  });

  it("fetches scrollback when a blob was stored", async () => {
    scrollbackMock.mockResolvedValue("PAYLOAD");
    restoreMock.mockResolvedValue({
      sessions: [meta("old", 0, { scrollback_lines: 500 })],
      active_session_id: "old",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();
    expect(scrollbackMock).toHaveBeenCalledWith("old");
  });

  it("one failing tab does not abort the others", async () => {
    let call = 0;
    spawnMock.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("spawn failed");
      return 1234;
    });
    restoreMock.mockResolvedValue({
      sessions: [meta("a", 0), meta("b", 1), meta("c", 2)],
      active_session_id: "a",
      crashed: false,
      skipped: false,
    });
    const { result } = renderHook(() => useSessions());
    const n = await result.current.restoreSessions();
    // The failed spawn still leaves a visible (exited) tab rather than vanishing.
    expect(n).toBe(3);
    expect(useAppStore.getState().sessions).toHaveLength(3);
  });

  // Regression: boot used to await two chained requestAnimationFrames, which
  // WKWebView never services while the window is occluded — the whole boot
  // sequence hung and persistence never started.
  it("completes even when requestAnimationFrame never fires", async () => {
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as never;
    try {
      restoreMock.mockResolvedValue({
        sessions: [meta("a", 0), meta("b", 1)],
        active_session_id: "a",
        crashed: false,
        skipped: false,
      });
      const { result } = renderHook(() => useSessions());
      await expect(result.current.restoreSessions()).resolves.toBe(2);
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  }, 5000);
});

describe("sidecar terminal lifecycle", () => {
  async function createLinkedPair() {
    const { result } = renderHook(() => useSessions());
    const localId = await result.current.createSession();
    const remoteId = await result.current.createSession({
      hostId: "host-prod",
      title: "Production",
      activate: false,
    });
    useAppStore.getState().updateSessionUi(remoteId, {
      remote: { kind: "ssh", target: "deploy@prod" },
      nestedBlockId: "ssh-prod",
      runningBlockId: "ssh-prod",
      remoteHost: { id: "host-prod", label: "Production", color: null },
    });
    const state = useAppStore.getState();
    const identity = captureSidecarRemoteIdentity(
      state.sessions.find((session) => session.id === remoteId),
      state.sessionUi[remoteId],
    );
    if (!identity) throw new Error("sidecar fixture has no remote identity");
    const started = state.startSidecar(localId, localId, remoteId, identity);
    if (!started.ok) throw new Error(started.reason);
    useAppStore.getState().initAiStream(localId, "agent", "sidecar-request");
    return { result, localId, remoteId };
  }

  it("cancels the shared owner and both PTY waiters when either PTY exits", async () => {
    const { localId, remoteId } = await createLinkedPair();
    const onRemoteEvent = ptyEventHandlers.get(remoteId);
    expect(onRemoteEvent).toBeDefined();

    onRemoteEvent?.({ type: "Exit", exit_code: 255 });
    await Promise.resolve();

    expect(abortSessionMock.mock.calls).toEqual([
      [localId, "closed"],
      [remoteId, "closed"],
    ]);
    expect(aiCancelMock).toHaveBeenCalledWith("sidecar-request");
    expect(useAppStore.getState().aiStreams[localId]).toMatchObject({
      status: "idle",
      requestId: null,
      generationId: null,
    });
    expect(useAppStore.getState().sessions.find((session) => session.id === remoteId)).toMatchObject({
      exited: true,
      exitCode: 255,
    });
    expect(useAppStore.getState().sidecarForSession(localId)?.degraded).toEqual({
      role: "remote",
      reason: "shell_exited",
    });
  });

  it("awaits cancellation, then preserves the closed target and its scrollback as degraded", async () => {
    const { result, localId, remoteId } = await createLinkedPair();
    let releaseCancellation!: () => void;
    aiCancelMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseCancellation = resolve; }),
    );

    const closing = result.current.closeSession(remoteId);

    expect(useAppStore.getState().aiStreams[localId].requestId).toBeNull();
    expect(abortSessionMock.mock.calls).toEqual([
      [localId, "closed"],
      [remoteId, "closed"],
    ]);
    expect(ptyKillMock).not.toHaveBeenCalled();

    releaseCancellation();
    await closing;

    expect(ptyKillMock).toHaveBeenCalledWith(remoteId);
    expect(useAppStore.getState().sessions.map((session) => session.id)).toEqual([
      localId,
      remoteId,
    ]);
    expect(useAppStore.getState().sessions.find((session) => session.id === remoteId)).toMatchObject({
      exited: true,
    });
    expect(useAppStore.getState().sidecarForSession(localId)?.degraded).toEqual({
      role: "remote",
      reason: "shell_exited",
    });
    // A linked close is a degraded-workspace transition, not ordinary teardown:
    // destroying xterm here would also destroy the scrollback the user needs to
    // diagnose and replace the failed target.
    expect(releaseWebglMock).not.toHaveBeenCalled();
    expect(disposeTermMock).not.toHaveBeenCalled();
    expect(archiveOnCloseMock).not.toHaveBeenCalled();
  });
});
