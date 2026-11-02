import { beforeEach, describe, expect, it, vi } from "vitest";

// The whole point of startNewChat is that a conversation is preserved before it
// is dropped, so these tests assert on the IPC payload rather than on the store
// alone: the split-off row and the blanked live row have to leave together, in
// one call, or a crash between them duplicates or loses the chat.
const archivePutManyMock = vi.fn(async (_rows: ArchiveSessionInput[]) => {});
const aiCancelMock = vi.fn(async (_requestId: string) => {});
const mcpDisconnectMock = vi.fn(async (_conversationId: string) => {});
const clearTerminalMock = vi.fn(async (_term: unknown, onCleared?: () => void) => onCleared?.());
const persistClearedMock = vi.fn(async (_ids: string[]) => {});
const entries = new Map<string, {
  disposed: boolean;
  term: { cols: number; rows: number };
  blockMarkers: Map<string, { start: { dispose(): void }; end: { dispose(): void } | null }>;
}>();

vi.mock("../lib/tauri", () => ({
  archivePutMany: (rows: unknown) => archivePutManyMock(rows as ArchiveSessionInput[]),
  aiCancel: (id: string) => aiCancelMock(id),
  mcpDisconnect: (id: string) => mcpDisconnectMock(id),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: (id: string) => {
    if (!entries.has(id)) entries.set(id, {
      disposed: false,
      term: { cols: 120, rows: 40 },
      blockMarkers: new Map(),
    });
    return entries.get(id);
  },
  serializeSession: (_id: string, lines: number) => ({ data: "SCREEN", lines }),
}));

vi.mock("../lib/terminalClear", () => ({
  clearTerminalBuffer: (term: unknown, onCleared?: () => void) => clearTerminalMock(term, onCleared),
}));

vi.mock("../lib/sessionPersistence", () => ({
  markScrollbackDirty: vi.fn(),
  markTranscriptDirty: vi.fn(),
  persistClearedScrollback: (ids: string[]) => persistClearedMock(ids),
}));

const abortSessionMock = vi.fn();
vi.mock("../lib/ptyExec", () => ({
  abortSession: (id: string, reason: string) => abortSessionMock(id, reason),
}));

import { chatArchiveId, hasConversation, startNewChat } from "../lib/newChat";
import { freezeArchiveMutations, resumeArchiveMutations } from "../lib/archiveWriteTracker";
import { captureSidecarRemoteIdentity } from "../lib/sidecar";
import { emptyAiStream, emptySessionUi, useAppStore } from "../stores/appStore";
import type { AiMessage, ArchiveSessionInput, ChatMessage, Session } from "../lib/types";

function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: "/Users/me/proj",
    createdAt: "2026-08-01T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: "my tab",
    aiTitle: null,
    ordinal: 1,
    ...over,
  };
}

const msg = (id: string, role: "user" | "assistant", at: string): AiMessage => ({
  id,
  role,
  content: `content of ${id}`,
  createdAt: at,
});

const MESSAGES: AiMessage[] = [
  msg("m1", "user", "2026-08-02T10:00:00.000Z"),
  msg("m2", "assistant", "2026-08-02T10:00:05.000Z"),
];

const TRANSCRIPT: ChatMessage[] = [
  { role: "user", content: "goal" },
  { role: "assistant", content: "done" },
];

function seed(session: Session, over: Partial<ReturnType<typeof emptyAiStream>> = {}) {
  useAppStore.setState({
    sessions: [session],
    activeSessionId: session.id,
    sessionUi: { [session.id]: emptySessionUi() },
    aiStreams: {
      [session.id]: {
        ...emptyAiStream(),
        messages: MESSAGES,
        modelTranscript: TRANSCRIPT,
        model: "Claude Opus 5",
        ...over,
      },
    },
    sidecars: {},
    restoreScrollbackLines: 1000,
    scrollbackLines: 10000,
    restoreSessionsOnStart: true,
    archiveEnabled: true,
    clearTerminalOnNewChat: true,
  });
}

function seedSidecar(over: Partial<ReturnType<typeof emptyAiStream>> = {}) {
  const ownerId = "sess-1-0";
  const remoteId = "sess-remote";
  seed(makeSession(ownerId));
  const store = useAppStore.getState();
  store.addSession(makeSession(remoteId, { hostId: "host-prod", hostLabel: "Production" }), false);
  useAppStore.getState().updateSessionUi(remoteId, {
    remote: { kind: "ssh", target: "deploy@prod" },
    nestedBlockId: "ssh-prod",
    runningBlockId: "ssh-prod",
    remoteHost: { id: "host-prod", label: "Production", color: null },
  });
  const live = useAppStore.getState();
  const identity = captureSidecarRemoteIdentity(
    live.sessions.find((session) => session.id === remoteId),
    live.sessionUi[remoteId],
  );
  if (!identity) throw new Error("sidecar fixture has no SSH identity");
  const started = live.startSidecar(ownerId, ownerId, remoteId, identity);
  if (!started.ok) throw new Error(started.reason);
  useAppStore.setState((state) => ({
    aiStreams: {
      ...state.aiStreams,
      [ownerId]: { ...state.aiStreams[ownerId], ...over },
    },
  }));
  return { ownerId, remoteId };
}

const rowsOf = (call: number) => archivePutManyMock.mock.calls[call][0];
const split = (call = 0) => rowsOf(call).find((r) => r.session_id.includes("#"))!;
const blanked = (call = 0) => rowsOf(call).find((r) => !r.session_id.includes("#"))!;

beforeEach(() => {
  archivePutManyMock.mockClear();
  archivePutManyMock.mockResolvedValue(undefined);
  aiCancelMock.mockClear();
  mcpDisconnectMock.mockClear();
  abortSessionMock.mockClear();
  clearTerminalMock.mockClear();
  persistClearedMock.mockClear();
  entries.clear();
  seed(makeSession("sess-1-0"));
});

describe("chatArchiveId", () => {
  it("cannot collide with a live session id", () => {
    // Live ids are `sess-<ms>-<counter>` and contain no '#'.
    expect(chatArchiveId("sess-1-0", 1234)).toBe("sess-1-0#1234");
  });
});

describe("hasConversation", () => {
  it("is false for an empty panel and for an unknown session", () => {
    seed(makeSession("sess-1-0"), { messages: [], modelTranscript: [] });
    expect(hasConversation("sess-1-0")).toBe(false);
    expect(hasConversation("nope")).toBe(false);
  });

  it("is true for a restored-but-empty panel", () => {
    // The "Reopened transcript from …" line is state worth clearing even though
    // no message rendered under it.
    seed(makeSession("sess-1-0"), {
      messages: [],
      modelTranscript: [],
      restoredAt: "2026-08-01T00:00:00.000Z",
    });
    expect(hasConversation("sess-1-0")).toBe(true);
  });

  it("is true while a stream is in flight", () => {
    seed(makeSession("sess-1-0"), { messages: [], modelTranscript: [], status: "streaming" });
    expect(hasConversation("sess-1-0")).toBe(true);
  });
});

describe("startNewChat", () => {
  it("writes the split-off chat and the blanked live row in one transaction", async () => {
    await expect(startNewChat("sess-1-0")).resolves.toBe(true);
    expect(mcpDisconnectMock).toHaveBeenCalledWith("sess-1-0");

    expect(archivePutManyMock).toHaveBeenCalledTimes(1);
    expect(rowsOf(0)).toHaveLength(2);

    // The outgoing chat: a closed archive row under a synthetic id, carrying both
    // representations of the conversation plus the screen it happened on.
    expect(split().session_id).toBe(`sess-1-0#${split().session_id.split("#")[1]}`);
    expect(split().is_open).toBe(false);
    expect(split().close_reason).toBe("closed");
    expect(split().messages).toHaveLength(2);
    expect(split().model_transcript).toEqual(TRANSCRIPT);
    expect(split().scrollback).toBe("SCREEN");
    expect(split().title).toBe("my tab");
    // The chat's own start, not the tab's — a long-lived tab's later chats would
    // otherwise all claim the same opened_at.
    expect(split().opened_at).toBe("2026-08-02T10:00:00.000Z");

    // The live tab keeps its real id, stays open, and its stored transcript is
    // explicitly emptied. `[]` not null: null means "keep the stored rows", which
    // would leave reap_open_sessions a second copy of the chat to resurrect.
    expect(blanked().session_id).toBe("sess-1-0");
    expect(blanked().is_open).toBe(true);
    expect(blanked().messages).toEqual([]);
    expect(blanked().model_transcript).toEqual([]);
    expect(blanked().scrollback).toBe("");
    expect(blanked().scrollback_lines).toBe(0);
    expect(blanked().supersedes).toBeNull();
  });

  it("clears the panel and leaves the tab open", async () => {
    await startNewChat("sess-1-0");
    const stream = useAppStore.getState().aiStreams["sess-1-0"];
    expect(stream.messages).toEqual([]);
    expect(stream.modelTranscript).toEqual([]);
    expect(useAppStore.getState().sessions.map((s) => s.id)).toEqual(["sess-1-0"]);
    expect(clearTerminalMock).toHaveBeenCalledOnce();
    expect(persistClearedMock).toHaveBeenCalledWith(["sess-1-0"]);
  });

  it("keeps terminal history when clearing on new chat is disabled", async () => {
    useAppStore.setState({ clearTerminalOnNewChat: false });
    await expect(startNewChat("sess-1-0")).resolves.toBe(true);
    expect(clearTerminalMock).not.toHaveBeenCalled();
    expect(persistClearedMock).not.toHaveBeenCalled();
    expect(blanked().scrollback).toBeNull();
    expect(blanked().scrollback_lines).toBeNull();
    expect(useAppStore.getState().aiStreams["sess-1-0"].messages).toEqual([]);
  });

  it("waits for the outgoing archive before clearing and coalesces duplicate clicks", async () => {
    let finishArchive!: () => void;
    archivePutManyMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishArchive = resolve; }));
    const first = startNewChat("sess-1-0");
    const second = startNewChat("sess-1-0");
    expect(second).toBe(first);
    expect(useAppStore.getState().aiStreams["sess-1-0"].newChatPending).toBe(true);
    useAppStore.getState().setPermissionMode("sess-1-0", "auto_all");
    expect(useAppStore.getState().aiStreams["sess-1-0"].permissionMode).toBe("ask");
    expect(clearTerminalMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().aiStreams["sess-1-0"].messages).toHaveLength(2);
    for (let i = 0; i < 5 && !finishArchive; i++) await Promise.resolve();
    finishArchive();
    await expect(first).resolves.toBe(true);
    expect(archivePutManyMock).toHaveBeenCalledOnce();
    expect(clearTerminalMock).toHaveBeenCalledOnce();
    expect(archivePutManyMock.mock.invocationCallOrder[0]).toBeLessThan(clearTerminalMock.mock.invocationCallOrder[0]);
    expect(useAppStore.getState().aiStreams["sess-1-0"].newChatPending).toBe(false);
    useAppStore.getState().setPermissionMode("sess-1-0", "auto_all");
    expect(useAppStore.getState().aiStreams["sess-1-0"].permissionMode).toBe("auto_all");
  });

  it("acquires the operation before publishing a state change that reenters New Chat", async () => {
    let reentered: Promise<boolean> | undefined;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.aiStreams["sess-1-0"].newChatPending && !reentered) {
        reentered = startNewChat("sess-1-0");
      }
    });
    const operation = startNewChat("sess-1-0");
    unsubscribe();
    expect(reentered).toBe(operation);
    await expect(operation).resolves.toBe(true);
    expect(archivePutManyMock).toHaveBeenCalledOnce();
  });

  it("keeps the reset fence after publishing the fresh conversation until persistence finishes", async () => {
    let finishPersistence!: () => void;
    persistClearedMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishPersistence = resolve; }));
    const operation = startNewChat("sess-1-0");
    await vi.waitFor(() => expect(persistClearedMock).toHaveBeenCalledOnce());
    const fresh = useAppStore.getState().aiStreams["sess-1-0"];
    expect(fresh.messages).toEqual([]);
    expect(fresh.status).toBe("idle");
    expect(fresh.newChatPending).toBe(true);
    useAppStore.getState().setPermissionMode("sess-1-0", "auto_all");
    expect(useAppStore.getState().aiStreams["sess-1-0"].permissionMode).toBe("ask");
    expect(startNewChat("sess-1-0")).toBe(operation);
    finishPersistence();
    await expect(operation).resolves.toBe(true);
    expect(useAppStore.getState().aiStreams["sess-1-0"].newChatPending).toBe(false);
  });

  it("fences both Sidecar permission roles while the shared conversation is archived", async () => {
    const { ownerId, remoteId } = seedSidecar();
    useAppStore.getState().setSidecarPermission(ownerId, "local", "auto_all");
    useAppStore.getState().setSidecarPermission(ownerId, "remote", "auto_all");
    let finishArchive!: () => void;
    archivePutManyMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishArchive = resolve; }));
    const operation = startNewChat(remoteId);
    await vi.waitFor(() => expect(archivePutManyMock).toHaveBeenCalledOnce());
    const permissions = useAppStore.getState().sidecarForSession(ownerId)!.permissions;
    useAppStore.getState().setSidecarPermission(remoteId, "local", "auto_read");
    useAppStore.getState().setSidecarPermission(ownerId, "remote", "auto_read");
    useAppStore.getState().setPermissionMode(remoteId, "auto_all");
    expect(useAppStore.getState().sidecarForSession(ownerId)!.permissions).toEqual(permissions);
    useAppStore.getState().setSidecarPermission(remoteId, "remote", "ask");
    expect(useAppStore.getState().sidecarForSession(ownerId)!.permissions.remote).toBe("ask");
    expect(useAppStore.getState().aiStreams[remoteId].permissionMode).toBe("ask");
    expect(startNewChat(ownerId)).toBe(operation);
    finishArchive();
    await expect(operation).resolves.toBe(true);
  });

  it("releases the reset fence when exit preparation refuses the archive lease", async () => {
    freezeArchiveMutations();
    try {
      await expect(startNewChat("sess-1-0")).resolves.toBe(false);
      expect(useAppStore.getState().aiStreams["sess-1-0"].newChatPending).toBe(false);
      expect(useAppStore.getState().aiStreams["sess-1-0"].messages).toHaveLength(2);
      expect(archivePutManyMock).not.toHaveBeenCalled();
    } finally {
      resumeArchiveMutations();
    }
  });

  it("hands the reopened row's supersede to the chat, not to the tab", async () => {
    seed(makeSession("sess-1-0", { archivedFrom: "old-archive-row" }));
    await startNewChat("sess-1-0");

    expect(split().supersedes).toBe("old-archive-row");
    // Cleared, or the tab's own close would try to collapse a row this chat
    // already absorbed — its next close ends a NEW thread of work.
    expect(useAppStore.getState().sessions[0].archivedFrom).toBeNull();
  });

  it("stops an in-flight stream first", async () => {
    seed(makeSession("sess-1-0"), { status: "streaming", requestId: "req-9" });
    await startNewChat("sess-1-0");

    expect(abortSessionMock).toHaveBeenCalledWith("sess-1-0", "cancelled");
    expect(aiCancelMock).toHaveBeenCalledWith("req-9");
    expect(useAppStore.getState().aiStreams["sess-1-0"].requestId).toBeNull();
  });

  it("resolves a companion tab to the owner, cancels both waiters, and ends only the pairing", async () => {
    const { ownerId, remoteId } = seedSidecar({
      status: "streaming",
      requestId: "sidecar-request",
      generationId: "sidecar-request",
    });

    await expect(startNewChat(remoteId)).resolves.toBe(true);

    expect(abortSessionMock.mock.calls).toEqual([
      [ownerId, "cancelled"],
      [remoteId, "cancelled"],
    ]);
    expect(aiCancelMock).toHaveBeenCalledWith("sidecar-request");
    expect(split().session_id.startsWith(`${ownerId}#`)).toBe(true);
    expect(blanked().session_id).toBe(ownerId);
    expect(useAppStore.getState().sidecars).toEqual({});
    // Ending Sidecar is presentation/conversation state only: both live PTYs
    // remain open and the companion's own hidden conversation remains intact.
    expect(useAppStore.getState().sessions.map((session) => session.id)).toEqual([
      ownerId,
      remoteId,
    ]);
    expect(useAppStore.getState().aiStreams[ownerId].messages).toEqual([]);
    expect(useAppStore.getState().aiStreams[remoteId].messages).toEqual([]);
    expect(clearTerminalMock).toHaveBeenCalledTimes(2);
    expect(persistClearedMock).toHaveBeenCalledWith([ownerId, remoteId]);
    expect(useAppStore.getState().sessionUi[remoteId].remote?.target).toBe("deploy@prod");
    expect(useAppStore.getState().sessionUi[remoteId].nestedBlockId).toBe("ssh-prod");
    const remoteArchive = rowsOf(0).find((row) => row.session_id.startsWith(`${remoteId}#`));
    expect(remoteArchive?.scrollback).toBe("SCREEN");
    expect(remoteArchive?.messages).toBeNull();
  });

  it("fences the Done-to-agent-result gap for a linked conversation", async () => {
    const { remoteId } = seedSidecar({
      status: "idle",
      requestId: null,
      generationId: "late-agent-result",
    });

    await startNewChat(remoteId);

    expect(useAppStore.getState().sidecars).toEqual({});
    expect(useAppStore.getState().aiStreams["sess-1-0"].generationId).toBeNull();
  });

  it("archives a partial answer that was still streaming", async () => {
    // The partial lives in `streamingContent`, which the archive row does not
    // read — without a flush first, cancelling mid-answer would save the
    // conversation with the last reply missing.
    seed(makeSession("sess-1-0"), {
      status: "streaming",
      requestId: "req-9",
      streamingContent: "half an ans",
      thinkingContent: "reasoning so far",
    });
    await startNewChat("sess-1-0");

    const archived = split().messages!;
    expect(archived).toHaveLength(3);
    expect(archived[2].content).toBe("half an ans");
    expect(archived[2].thinking).toBe("reasoning so far");
  });

  it("clears without archiving when the archive is switched off", async () => {
    useAppStore.setState({ archiveEnabled: false });
    await expect(startNewChat("sess-1-0")).resolves.toBe(true);

    // Rust would have dropped the write silently; the button asked for a second
    // click instead, so the clear is deliberate.
    expect(archivePutManyMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().aiStreams["sess-1-0"].messages).toEqual([]);
  });

  it("keeps the conversation when the archive write is refused", async () => {
    useAppStore.getState().setPermissionMode("sess-1-0", "auto_all");
    archivePutManyMock.mockRejectedValue(new Error("db locked"));
    const operation = startNewChat("sess-1-0");
    // A cancelled scheduled run must still be able to disarm its permission
    // while New Chat is pending, even when that archive will fail.
    useAppStore.getState().setPermissionMode("sess-1-0", "ask");
    await expect(operation).resolves.toBe(false);

    // Losing a conversation to a database error is worse than a click that
    // reports why it did nothing.
    const stream = useAppStore.getState().aiStreams["sess-1-0"];
    expect(stream.messages).toHaveLength(2);
    expect(stream.modelTranscript).toEqual(TRANSCRIPT);
    expect(stream.lastError).toBeTruthy();
    expect(stream.newChatPending).toBe(false);
    expect(stream.permissionMode).toBe("ask");
    expect(clearTerminalMock).not.toHaveBeenCalled();
    expect(persistClearedMock).not.toHaveBeenCalled();

    archivePutManyMock.mockResolvedValue(undefined);
    await expect(startNewChat("sess-1-0")).resolves.toBe(true);
    expect(useAppStore.getState().aiStreams["sess-1-0"].newChatPending).toBe(false);
  });

  it("does nothing for an empty panel or an unknown session", async () => {
    seed(makeSession("sess-1-0"), { messages: [], modelTranscript: [] });
    await expect(startNewChat("sess-1-0")).resolves.toBe(false);
    await expect(startNewChat("nope")).resolves.toBe(false);
    expect(archivePutManyMock).not.toHaveBeenCalled();
  });
});
