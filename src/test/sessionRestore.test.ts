import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const restoreMock = vi.fn();
const scrollbackMock = vi.fn(async (_id: string) => null as string | null);
const spawnMock = vi.fn(async () => 1234);

vi.mock("../lib/tauri", () => ({
  workspaceRestore: () => restoreMock(),
  workspaceScrollback: (id: string) => scrollbackMock(id),
  ptySpawn: () => spawnMock(),
  ptyWrite: async () => {},
  ptyResize: async () => {},
  ptyAck: async () => {},
  ptyKill: async () => {},
  releasePtyChannels: () => {},
  aiCancel: async () => {},
  historyRecord: async () => "",
  sshHostsTouch: async () => {},
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
  disposeTerm: () => {},
  releaseWebgl: () => {},
  acquireWebgl: () => {},
  replayScrollback: async () => {},
}));

vi.mock("../lib/sessionPersistence", () => ({
  trackSession: () => {},
  startPersistence: () => {},
}));

import { useSessions } from "../hooks/useSessions";
import { useAppStore } from "../stores/appStore";
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
  spawnMock.mockClear();
  useAppStore.setState({ sessions: [], activeSessionId: null, sessionUi: {}, aiStreams: {} });
});

afterEach(() => {
  vi.useRealTimers();
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
