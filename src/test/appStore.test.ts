import { beforeEach, describe, expect, it } from "vitest";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import type { Block, McpServerView, Session } from "../lib/types";

function makeSession(id: string): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: null,
    createdAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
  };
}

function makeBlock(id: string, sessionId: string): Block {
  return {
    id,
    sessionId,
    command: "echo hi",
    state: "running",
    exitCode: null,
    startLine: 0,
    endLine: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    origin: "user",
  };
}

function makeMcpServer(id: string, isDefault: boolean): McpServerView {
  return {
    version: 1,
    id,
    name: id,
    enabled: true,
    auto_start: false,
    default_for_new_chats: isDefault,
    revision: 1,
    transport: {
      type: "streamable_http",
      url: "https://mcp.example.test",
      auth: { mode: "none", scopes: [] },
      headers: [],
    },
    timeouts: { startup_ms: 10_000, list_ms: 30_000, call_ms: 60_000 },
    disabled_tools: [],
    trust_hash: null,
    trusted: true,
    missing_secret_slots: [],
    runtime: { connected: false, log_bytes: 0, tool_count: null },
    oauth: null,
  };
}

beforeEach(() => {
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    mcpServers: [],
  });
});

describe("session lifecycle", () => {
  it("addSession activates and seeds per-session state", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    const state = useAppStore.getState();
    expect(state.activeSessionId).toBe("a");
    expect(state.sessionUi["a"]).toBeDefined();
    expect(state.aiStreams["a"]).toBeDefined();
  });

  it("addSession(s, false) does not steal the active tab", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    // Restore adds every tab but the first with activate:false — otherwise each
    // one momentarily becomes active and churns a WebGL context.
    useAppStore.getState().addSession(makeSession("b"), false);
    useAppStore.getState().addSession(makeSession("c"), false);
    const state = useAppStore.getState();
    expect(state.activeSessionId).toBe("a");
    expect(state.sessions.map((x) => x.id)).toEqual(["a", "b", "c"]);
    // Per-session state is still seeded for the inactive tabs.
    expect(state.sessionUi["c"]).toBeDefined();
    expect(state.aiStreams["c"]).toBeDefined();
  });

  it("addSession(s, false) still activates when there is no active tab", () => {
    useAppStore.getState().addSession(makeSession("a"), false);
    expect(useAppStore.getState().activeSessionId).toBe("a");
  });

  it("reorderSessions applies the given order", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().addSession(makeSession("b"), false);
    useAppStore.getState().addSession(makeSession("c"), false);
    useAppStore.getState().reorderSessions(["c", "a", "b"]);
    expect(useAppStore.getState().sessions.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("reorderSessions ignores unknown ids and keeps omitted sessions", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().addSession(makeSession("b"), false);
    useAppStore.getState().addSession(makeSession("c"), false);
    // A partially-failed restore names only the tabs that came back — the rest
    // must survive at the end rather than being dropped.
    useAppStore.getState().reorderSessions(["c", "ghost"]);
    expect(useAppStore.getState().sessions.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("removeSession activates a neighbor and drops per-session state", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    s.addSession(makeSession("b"));
    s.addSession(makeSession("c"));
    useAppStore.getState().setActiveSession("b");
    useAppStore.getState().removeSession("b");
    const state = useAppStore.getState();
    expect(state.sessions.map((x) => x.id)).toEqual(["a", "c"]);
    expect(state.activeSessionId).toBe("c");
    expect(state.sessionUi["b"]).toBeUndefined();
    expect(state.aiStreams["b"]).toBeUndefined();
  });

  it("removing the last session leaves no active session", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("only"));
    useAppStore.getState().removeSession("only");
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });
});

describe("block lifecycle", () => {
  it("start → finish transitions state and clears runningBlockId", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().startBlock("a", makeBlock("b1", "a"));
    expect(useAppStore.getState().sessionUi["a"].runningBlockId).toBe("b1");
    useAppStore.getState().finishBlock("a", "b1", 2, 10);
    const ui = useAppStore.getState().sessionUi["a"];
    expect(ui.runningBlockId).toBeNull();
    expect(ui.blocks[0].state).toBe("done");
    expect(ui.blocks[0].exitCode).toBe(2);
    expect(ui.blocks[0].endLine).toBe(10);
  });

  it("caps blocks per session at 200", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    for (let i = 0; i < 210; i++) {
      useAppStore.getState().startBlock("a", makeBlock(`b${i}`, "a"));
    }
    expect(useAppStore.getState().sessionUi["a"].blocks).toHaveLength(200);
    expect(useAppStore.getState().sessionUi["a"].blocks[0].id).toBe("b10");
  });

  it("trimBlock marks blocks as trimmed", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().startBlock("a", makeBlock("b1", "a"));
    useAppStore.getState().trimBlock("a", "b1");
    expect(useAppStore.getState().sessionUi["a"].blocks[0].state).toBe("trimmed");
  });
});

describe("ai stream lifecycle", () => {
  it("streams deltas then flushes into a message on finish", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().initAiStream("a", "ask", "req-1");
    useAppStore.getState().appendAiDelta("a", "Hello ");
    useAppStore.getState().appendAiDelta("a", "world");
    useAppStore.getState().finishAiStream("a");
    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.status).toBe("idle");
    expect(stream.streamingContent).toBe("");
    expect(stream.messages).toHaveLength(1);
    expect(stream.messages[0].content).toBe("Hello world");
  });

  it("records errors without losing partial content", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().initAiStream("a", "explain", "req-2");
    useAppStore.getState().appendAiDelta("a", "partial");
    useAppStore.getState().finishAiStream("a", "boom");
    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.status).toBe("error");
    expect(stream.lastError).toBe("boom");
    expect(stream.messages[0].content).toBe("partial");
  });

  it("newAiConversation wipes the conversation but keeps the mode", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().setAiMode("a", "agent");
    useAppStore.getState().setPermissionMode("a", "auto_all");
    useAppStore.getState().attachBlockToAi("a", "b1");
    useAppStore.getState().initAiStream("a", "agent", "req-3");
    useAppStore.getState().appendAiDelta("a", "an answer");
    useAppStore.getState().finishAiStream("a");
    useAppStore.getState().setModelTranscript("a", [{ role: "user", content: "goal" }]);
    useAppStore.getState().restoreAiTranscript("a", [], [], "2026-08-01T00:00:00.000Z");
    useAppStore.getState().setAiMode("a", "agent");

    useAppStore.getState().newAiConversation("a");

    const stream = useAppStore.getState().aiStreams["a"];
    expect(stream.messages).toEqual([]);
    expect(stream.modelTranscript).toEqual([]);
    expect(stream.restoredAt).toBeNull();
    expect(stream.requestId).toBeNull();
    expect(stream.pendingProposal).toBeNull();
    expect(stream.lastError).toBeNull();
    expect(stream.streamingContent).toBe("");
    expect(stream.thinkingContent).toBe("");
    expect(stream.status).toBe("idle");
    expect(stream.attachedBlockIds).toEqual([]);
    // Per-session, never inherited — the same stance restoreAiTranscript takes.
    expect(stream.permissionMode).toBe("ask");
    // The one thing that carries over.
    expect(stream.mode).toBe("agent");
  });

  it("newAiConversation cannot resurrect a closed tab", () => {
    useAppStore.getState().newAiConversation("gone");
    expect(useAppStore.getState().aiStreams["gone"]).toBeUndefined();
  });

  it("snapshots MCP defaults for each new conversation without mutating existing chats", () => {
    const first = makeMcpServer("11111111-1111-4111-8111-111111111111", true);
    const second = makeMcpServer("22222222-2222-4222-8222-222222222222", false);
    useAppStore.getState().setMcpServers([first, second]);
    useAppStore.getState().addSession(makeSession("a"));
    expect(useAppStore.getState().aiStreams.a.mcpSelection.server_ids).toEqual([first.id]);

    useAppStore.getState().setMcpServers([
      { ...first, default_for_new_chats: false },
      { ...second, default_for_new_chats: true },
    ]);
    expect(useAppStore.getState().aiStreams.a.mcpSelection.server_ids).toEqual([first.id]);

    useAppStore.getState().setMcpSelection("a", {
      server_ids: [],
      disabled_tools: {},
    });
    useAppStore.getState().setMcpServers([
      { ...first, default_for_new_chats: false },
      { ...second, default_for_new_chats: true },
    ]);
    expect(useAppStore.getState().aiStreams.a.mcpSelection.server_ids).toEqual([]);

    useAppStore.getState().addSession(makeSession("b"));
    expect(useAppStore.getState().aiStreams.b.mcpSelection.server_ids).toEqual([second.id]);
    useAppStore.getState().newAiConversation("a");
    expect(useAppStore.getState().aiStreams.a.mcpSelection.server_ids).toEqual([second.id]);
  });

  it("restores an archived MCP selection while old archives restore with none", () => {
    const selection = {
      server_ids: ["11111111-1111-4111-8111-111111111111"],
      disabled_tools: {
        "11111111-1111-4111-8111-111111111111": ["dangerous_tool"],
      },
    };
    useAppStore.getState().addSession(makeSession("a"));
    useAppStore
      .getState()
      .restoreAiTranscript("a", [], [], "2026-08-01T00:00:00.000Z", selection);
    expect(useAppStore.getState().aiStreams.a.mcpSelection).toEqual(selection);

    useAppStore.getState().restoreAiTranscript(
      "a",
      [],
      [],
      "2026-08-01T00:00:00.000Z",
      null,
    );
    expect(useAppStore.getState().aiStreams.a.mcpSelection).toEqual({
      server_ids: [],
      disabled_tools: {},
    });
  });

  it("attach/detach block context ids", () => {
    const s = useAppStore.getState();
    s.addSession(makeSession("a"));
    useAppStore.getState().attachBlockToAi("a", "b1");
    useAppStore.getState().attachBlockToAi("a", "b1"); // idempotent
    expect(useAppStore.getState().aiStreams["a"].attachedBlockIds).toEqual(["b1"]);
    useAppStore.getState().detachBlockFromAi("a", "b1");
    expect(useAppStore.getState().aiStreams["a"].attachedBlockIds).toEqual([]);
  });
});

describe("emptySessionUi", () => {
  it("starts idle", () => {
    const ui = emptySessionUi();
    expect(ui.composerStatus).toBe("idle");
    expect(ui.blocks).toEqual([]);
  });
});
