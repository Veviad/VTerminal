import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const restoreMock = vi.fn();
const scrollbackMock = vi.fn(async (_id: string) => null as string | null);
const archiveListMock = vi.fn();
const archiveGetMock = vi.fn();
const archiveTranscriptMock = vi.fn();
const archiveTranscriptOnlyMock = vi.fn(async (_sessionId: string) => true);
const hydrateAttachmentsMock = vi.fn(async (_sessionId: string) => {});
const setAiPanelOpenMock = vi.fn();
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
  archiveList: (limit?: number, offset?: number) =>
    archiveListMock(limit, offset),
  archiveGet: (id: string) => archiveGetMock(id),
  archiveTranscript: (id: string) => archiveTranscriptMock(id),
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
  forgetShellProof: vi.fn(),
}));

vi.mock("../lib/sessionArchive", () => ({
  archiveOnClose: (sessionId: string) => archiveOnCloseMock(sessionId),
  archiveTranscriptOnly: (sessionId: string) =>
    archiveTranscriptOnlyMock(sessionId),
}));

vi.mock("../lib/attachInput", () => ({
  hydrateAttachments: (sessionId: string) => hydrateAttachmentsMock(sessionId),
}));

vi.mock("../lib/aiPanel", () => ({
  setAiPanelOpen: (open: boolean) => setAiPanelOpenMock(open),
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
import type {
  ArchiveDetail,
  ChatMessage,
  SessionSnapshotMeta,
} from "../lib/types";

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

function archivedDetail(id: string): ArchiveDetail {
  return {
    summary: {
      session_id: id,
      title: "saved chat",
      shell: "/bin/zsh",
      cwd: "/dir/0",
      host_id: null,
      remote_kind: null,
      remote_target: null,
      opened_at: "2026-08-01T00:00:00.000Z",
      closed_at: "2026-08-01T01:00:00.000Z",
      close_reason: "quit",
      scrollback_lines: 20,
      message_count: 2,
      agent_command_count: 0,
      history_command_count: 0,
      model: "local-balanced",
      has_model_transcript: true,
      first_prompt: "diagnose this",
    },
    messages: [
      {
        id: `${id}:0`,
        sort_order: 0,
        role: "user",
        kind: "text",
        content: "diagnose this",
        thinking: null,
        command: null,
        attachments: [],
        created_at: "2026-08-01T00:00:01.000Z",
      },
      {
        id: `${id}:1`,
        sort_order: 1,
        role: "assistant",
        kind: "text",
        content: "The service is healthy.",
        thinking: null,
        command: null,
        attachments: [],
        created_at: "2026-08-01T00:00:02.000Z",
      },
    ],
    mcp_selection: { server_ids: ["docs"], disabled_tools: {} },
  };
}

function restoreWorkspace(
  sessions: SessionSnapshotMeta[],
  activeSessionId: string | null = sessions[0]?.session_id ?? null,
): void {
  restoreMock.mockResolvedValue({
    sessions,
    active_session_id: activeSessionId,
    crashed: false,
    skipped: false,
  });
}

function mockArchivedChat(
  detail: ArchiveDetail,
  modelTranscript: ChatMessage[],
): void {
  archiveListMock.mockResolvedValueOnce([detail.summary]);
  archiveGetMock.mockResolvedValueOnce(detail);
  archiveTranscriptMock.mockResolvedValueOnce(modelTranscript);
}

beforeEach(() => {
  restoreMock.mockReset();
  scrollbackMock.mockReset();
  scrollbackMock.mockResolvedValue(null);
  archiveListMock.mockReset();
  archiveListMock.mockResolvedValue([]);
  archiveGetMock.mockReset();
  archiveGetMock.mockResolvedValue(null);
  archiveTranscriptMock.mockReset();
  archiveTranscriptMock.mockResolvedValue([]);
  archiveTranscriptOnlyMock.mockClear();
  archiveTranscriptOnlyMock.mockResolvedValue(true);
  hydrateAttachmentsMock.mockClear();
  setAiPanelOpenMock.mockClear();
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
    restoreWorkspace([]);
    const { result } = renderHook(() => useSessions());
    await expect(result.current.restoreSessions()).resolves.toBe(0);
  });

  it("returns 0 rather than throwing when the backend fails", async () => {
    restoreMock.mockRejectedValue(new Error("db poisoned"));
    const { result } = renderHook(() => useSessions());
    await expect(result.current.restoreSessions()).resolves.toBe(0);
  });

  it("rebuilds tabs in saved order with fresh ids and the saved cwd", async () => {
    restoreWorkspace([meta("old-b", 1), meta("old-a", 0)], "old-a");
    const { result } = renderHook(() => useSessions());
    const n = await result.current.restoreSessions();

    expect(n).toBe(2);
    const state = useAppStore.getState();
    expect(state.sessions.map((s) => s.cwd)).toEqual(["/dir/0", "/dir/1"]);
    // Fresh ids: reusing them would merge two runs in command_history.
    expect(state.sessions.map((s) => s.id)).not.toContain("old-a");
    expect(state.activeSessionId).toBe(state.sessions[0].id);
  });

  it("restores the saved Ask/Agent conversation with its terminal", async () => {
    const archived = archivedDetail("old");
    const modelTranscript: ChatMessage[] = [
      { role: "user", content: "diagnose this" },
      { role: "assistant", content: "The service is healthy." },
    ];
    mockArchivedChat(archived, modelTranscript);
    restoreWorkspace([meta("old", 0, { scrollback_lines: 20 })]);

    const { result } = renderHook(() => useSessions());
    await expect(result.current.restoreSessions()).resolves.toBe(1);

    const state = useAppStore.getState();
    const restored = state.sessions[0];
    const stream = state.aiStreams[restored.id];
    expect(restored.archivedFrom).toBe("old");
    expect(stream.messages.map((message) => message.content)).toEqual([
      "diagnose this",
      "The service is healthy.",
    ]);
    expect(stream.modelTranscript).toEqual(modelTranscript);
    expect(stream.mode).toBe("ask");
    expect(stream.permissionMode).toBe("ask");
    expect(stream.restoredAt).toBe(archived.summary.closed_at);
    expect(stream.mcpSelection).toEqual(archived.mcp_selection);
    expect(archiveTranscriptOnlyMock).toHaveBeenCalledWith(restored.id);
    expect(hydrateAttachmentsMock).toHaveBeenCalledWith(restored.id);
    expect(setAiPanelOpenMock).not.toHaveBeenCalled();
  });

  it("still restores the terminal when its archived chat cannot be read", async () => {
    archiveListMock.mockRejectedValueOnce(new Error("archive index unavailable"));
    archiveGetMock.mockRejectedValueOnce(new Error("archive unavailable"));
    restoreWorkspace([meta("old", 0)]);
    const { result } = renderHook(() => useSessions());

    await expect(result.current.restoreSessions()).resolves.toBe(1);
    const state = useAppStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.aiStreams[state.sessions[0].id].messages).toEqual([]);
  });

  it("does not fetch archive details for terminal-only tabs", async () => {
    restoreWorkspace([meta("old", 0)]);
    const { result } = renderHook(() => useSessions());

    await expect(result.current.restoreSessions()).resolves.toBe(1);
    expect(archiveListMock).toHaveBeenCalledOnce();
    expect(archiveGetMock).not.toHaveBeenCalled();
    expect(archiveTranscriptMock).not.toHaveBeenCalled();
  });

  it("finds saved chat beyond the first archive metadata page", async () => {
    const archived = archivedDetail("old");
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      ...archived.summary,
      session_id: `unrelated-${index}`,
      message_count: 0,
    }));
    archiveListMock
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([archived.summary]);
    archiveGetMock.mockResolvedValueOnce(archived);
    restoreWorkspace([meta("old", 0)]);

    const { result } = renderHook(() => useSessions());
    await expect(result.current.restoreSessions()).resolves.toBe(1);

    expect(archiveListMock.mock.calls).toEqual([
      [200, 0],
      [200, 200],
    ]);
    expect(archiveGetMock).toHaveBeenCalledWith("old");
    expect(useAppStore.getState().sessions[0].archivedFrom).toBe("old");
  });

  it("carries the saved host through so the tab can offer Reconnect", async () => {
    restoreWorkspace([
      meta("old", 0, {
        host_id: "h1",
        title: "prod-01",
        remote_kind: "ssh",
      }),
    ]);
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
    restoreWorkspace([meta("old", 0, { host_id: null, title: "my tab" })]);
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();

    const s = useAppStore.getState().sessions[0];
    expect(s.userTitle).toBe("my tab");
    expect(s.hostLabel).toBeNull();
  });

  it("does not pin a label for a tab that was never named", async () => {
    restoreWorkspace([meta("old", 0, { host_id: null, title: "" })]);
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();

    const s = useAppStore.getState().sessions[0];
    expect(s.userTitle).toBeNull();
    expect(s.hostLabel).toBeNull();
  });

  it("skips the scrollback fetch when nothing was stored", async () => {
    restoreWorkspace([meta("old", 0, { scrollback_lines: 0 })]);
    const { result } = renderHook(() => useSessions());
    await result.current.restoreSessions();
    expect(scrollbackMock).not.toHaveBeenCalled();
  });

  it("fetches scrollback when a blob was stored", async () => {
    scrollbackMock.mockResolvedValue("PAYLOAD");
    restoreWorkspace([meta("old", 0, { scrollback_lines: 500 })]);
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
    restoreWorkspace([meta("a", 0), meta("b", 1), meta("c", 2)], "a");
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
      restoreWorkspace([meta("a", 0), meta("b", 1)], "a");
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
