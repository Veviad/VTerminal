import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Attachment,
  ChatMessage,
  KnowledgeBucketRef,
  Session,
  StreamEvent,
} from "../lib/types";
import type { PtyExecOutcome } from "../lib/ptyExec";

const api = vi.hoisted(() => ({
  aiSuggest: vi.fn(),
  aiExplain: vi.fn(),
  aiAsk: vi.fn(),
  agentStart: vi.fn(),
  agentSteer: vi.fn(),
  respondToApproval: vi.fn(),
  respondToMcpApproval: vi.fn(),
  aiCancel: vi.fn(),
  submitCommandResult: vi.fn(),
  attachmentPut: vi.fn(),
  visionDescribe: vi.fn(),
  knowledgeSearchDetailed: vi.fn(),
}));

const persistence = vi.hoisted(() => ({
  markTranscriptCheckpoint: vi.fn(),
  markTranscriptDirty: vi.fn(),
}));
const pty = vi.hoisted(() => ({
  abortSession: vi.fn(),
  runInTerminal: vi.fn(),
  captureApprovalPromptBinding: vi.fn(() => "prompt-binding"),
  releaseApprovalPromptBinding: vi.fn(),
}));
const terminalRegistry = vi.hoisted(() => ({
  entries: new Map<string, { disposed: boolean }>(),
}));

vi.mock("../lib/tauri", () => api);
vi.mock("../lib/sessionNaming", () => ({ nameSession: vi.fn() }));
vi.mock("../lib/sessionPersistence", () => persistence);
vi.mock("../lib/aiPanel", () => ({ setAiPanelOpen: vi.fn() }));
vi.mock("../lib/ptyExec", () => pty);
vi.mock("../lib/termRegistry", () => ({
  getTerm: (sessionId: string) => terminalRegistry.entries.get(sessionId),
}));
vi.mock("../lib/terminalSnapshot", () => ({
  readLineRange: () => "",
  readScreenTail: () => "",
}));

import {
  cardStatus,
  commandOutcomeFence,
  commandResultPresentation,
  useAiStream,
} from "../hooks/useAiStream";
import { useAppStore } from "../stores/appStore";

const SID = "ai-owner";
const REMOTE_SID = "ssh-prod";

function session(): Session {
  return {
    id: SID,
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

function pastedText(body: string): Attachment {
  return {
    id: "pasted-text-1",
    kind: "text",
    name: "pasted-text-1.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode(body).length,
    text: body,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPreflight(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.aiSuggest.mockResolvedValue(undefined);
  api.aiExplain.mockResolvedValue(undefined);
  api.aiAsk.mockResolvedValue(undefined);
  api.agentStart.mockResolvedValue([]);
  api.agentSteer.mockResolvedValue(undefined);
  api.respondToApproval.mockResolvedValue(undefined);
  api.respondToMcpApproval.mockResolvedValue(undefined);
  api.aiCancel.mockResolvedValue(undefined);
  api.submitCommandResult.mockResolvedValue(undefined);
  api.attachmentPut.mockResolvedValue({ path: "/tmp/attachment" });
  api.visionDescribe.mockResolvedValue("description");
  api.knowledgeSearchDetailed.mockResolvedValue({ hits: [], warnings: [], partial: false });
  pty.runInTerminal.mockResolvedValue({
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    mode: "integrated",
  });
  terminalRegistry.entries.clear();

  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    sidecars: {},
    catalog: [],
    activeModelId: "test-model",
  });
  useAppStore.getState().addSession(session());
});

describe("steering with attachments", () => {
  it.each(["allow_once", "deny"] as const)("restores a pending MCP %s decision for retry when submission fails", async (decision) => {
    let emit!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      emit = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    api.respondToMcpApproval.mockRejectedValueOnce(new Error("IPC unavailable"));
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "Read calendar"));
    act(() => emit({ type: "McpToolProposal", approval_id: "retry-mcp", server_id: "calendar", server_name: "Calendar",
      tool_name: "list_events", arguments: {}, schema_hash: "schema" }));

    await act(async () => result.current.respondToMcpProposal(SID, decision));

    const failed = useAppStore.getState().aiStreams[SID];
    expect(failed.pendingMcpProposal?.approvalId).toBe("retry-mcp");
    expect(failed.status).toBe("awaiting_approval");
    expect(failed.messages.find((message) => message.mcp?.approvalId === "retry-mcp")?.mcp?.status).toBe("awaiting");
    expect(failed.lastError).toContain("IPC unavailable");
    await act(async () => result.current.respondToMcpProposal(SID, decision));
    expect(api.respondToMcpApproval).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().aiStreams[SID].pendingMcpProposal).toBeNull();
  });

  it.each(["cancelled", "started", "next-proposal"] as const)("does not restore a failed MCP decision after the request has %s", async (progress) => {
    let emit!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      emit = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const submission = deferred<void>();
    api.respondToMcpApproval.mockImplementationOnce(() => submission.promise);
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "Read calendar"));
    const proposal: StreamEvent = { type: "McpToolProposal", approval_id: "old-mcp", server_id: "calendar", server_name: "Calendar",
      tool_name: "list_events", arguments: {}, schema_hash: "schema" };
    act(() => emit(proposal));
    let responding!: Promise<void>;
    act(() => { responding = result.current.respondToMcpProposal(SID, "allow_once"); });
    if (progress === "cancelled") await act(async () => result.current.cancel(SID));
    else if (progress === "started") act(() => emit({ type: "McpToolStarted", approval_id: "old-mcp", server_id: "calendar", server_name: "Calendar", tool_name: "list_events", arguments: {} }));
    else act(() => emit({ ...proposal, approval_id: "new-mcp" }));
    await act(async () => { submission.reject(new Error("Already resolved")); await responding; });

    const live = useAppStore.getState().aiStreams[SID];
    expect(live.pendingMcpProposal?.approvalId ?? null).toBe(progress === "next-proposal" ? "new-mcp" : null);
    expect(live.lastError).toBeNull();
    if (progress === "started") expect(live.messages.find((message) => message.mcp?.approvalId === "old-mcp")?.mcp?.status).toBe("running");
  });

  it.each(["done", "error", "cancelled"] as const)("streams activity and final text before completion and settles %s truthfully", async (outcome) => {
    const agent = deferred<ChatMessage[]>();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return agent.promise;
    });
    const { result } = renderHook(() => useAiStream());
    let run!: Promise<void>;
    act(() => { run = result.current.startAgent(SID, "research"); });
    await flushPreflight();
    act(() => {
      onEvent({ type: "Activity", activity: { id: "web-1", kind: "web_search", status: "running" } });
      onEvent({ type: "ThinkingDelta", content: "Thoughts" });
      onEvent({ type: "Delta", content: "First answer words" });
    });
    expect(useAppStore.getState().aiStreams[SID].streamingContent).toBe("First answer words");
    expect(useAppStore.getState().aiStreams[SID].requestId).toBeTruthy();
    expect(useAppStore.getState().aiStreams[SID].messages.find((m) => m.activity)?.activity?.status).toBe("running");
    act(() => {
      if (outcome === "done") {
        onEvent({ type: "Activity", activity: { id: "web-1", kind: "web_search", status: "done" } });
        onEvent({ type: "Done", prompt_tokens: 1, completion_tokens: 2 });
      } else if (outcome === "error") onEvent({ type: "Error", message: "provider failed" });
      else onEvent({ type: "Cancelled" });
    });
    agent.resolve([]);
    await act(async () => run);
    const messages = useAppStore.getState().aiStreams[SID].messages;
    expect(messages.filter((m) => m.activity)).toHaveLength(1);
    expect(messages.find((m) => m.activity)?.activity?.status).toBe(outcome);
    expect(messages.find((m) => m.content === "First answer words")).toBeTruthy();
  });

  it("replaces captured output snapshots while preserving append events and private output", async () => {
    const agent = deferred<ChatMessage[]>();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return agent.promise;
    });
    const { result } = renderHook(() => useAiStream());
    let run!: Promise<void>;
    act(() => { run = result.current.startAgent(SID, "read progress"); });
    await flushPreflight();
    act(() => {
      onEvent({ type: "CommandStarted", approval_id: "public", command: "progress", explanation: "", output_policy: "normal" });
      onEvent({ type: "CommandOutput", approval_id: "public", is_stderr: false, chunk: "0%" });
      onEvent({ type: "CommandOutput", approval_id: "public", is_stderr: false, chunk: "100%", replace: true });
      onEvent({ type: "CommandOutput", approval_id: "public", is_stderr: false, chunk: " done" });
      onEvent({ type: "CommandStarted", approval_id: "private", command: "read secret", explanation: "", output_policy: "private" });
      onEvent({ type: "CommandOutput", approval_id: "private", is_stderr: false, chunk: "PRIVATE", replace: true });
    });
    const messages = useAppStore.getState().aiStreams[SID].messages;
    expect(messages.find((m) => m.id === "cmd-public")?.command?.output).toBe("100% done");
    expect(messages.find((m) => m.id === "cmd-private")?.command?.output).toBe("");
    agent.resolve([]);
    await act(async () => run);
  });
  it("separates the next response from the rest of the previous response while delivery is pending", async () => {
    const agent = deferred<ChatMessage[]>();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return agent.promise;
    });
    const { result } = renderHook(() => useAiStream());
    let run!: Promise<void>;
    act(() => { run = result.current.startAgent(SID, "original question"); });
    await flushPreflight();
    act(() => onEvent({ type: "Delta", content: "first part " }));
    act(() => { useAppStore.getState().attachFilesToAi(SID, [pastedText("TOKEN-73Q9")]); });
    await act(async () => result.current.steer(SID, "read attachment"));
    const steerId = useAppStore.getState().aiStreams[SID].steerQueue[0].id;
    act(() => onEvent({ type: "Delta", content: "remaining first response" }));
    act(() => onEvent({ type: "SteerProcessing", ids: [steerId] }));
    expect(useAppStore.getState().aiStreams[SID].steerQueue).toHaveLength(1);
    expect(useAppStore.getState().aiStreams[SID].messages.find((m) => m.steer)?.steer).toBe("queued");
    act(() => onEvent({ type: "Delta", content: "TOKEN-73Q9" }));
    act(() => onEvent({ type: "SteerDelivered", ids: [steerId] }));
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.steerQueue).toHaveLength(0);
    expect(stream.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "original question"],
      ["assistant", "first part "],
      ["user", expect.stringContaining("read attachment")],
      ["assistant", "remaining first response"],
      ["assistant", "TOKEN-73Q9"],
    ]);
    agent.resolve([]);
    await act(async () => run);
  });

  it.each(["failure", "cancellation"] as const)(
    "keeps a processed attachment retryable after %s",
    async (termination) => {
      const agent = deferred<ChatMessage[]>();
      let onEvent!: (event: StreamEvent) => void;
      api.agentStart.mockImplementationOnce((...args: unknown[]) => {
        onEvent = args[6] as (event: StreamEvent) => void;
        return agent.promise;
      });
      const { result } = renderHook(() => useAiStream());
      let run!: Promise<void>;
      act(() => { run = result.current.startAgent(SID, "original question"); });
      await flushPreflight();
      act(() => onEvent({ type: "Delta", content: "prior answer" }));
      const file = pastedText("RETRY-CONTENT-42");
      act(() => { useAppStore.getState().attachFilesToAi(SID, [file]); });
      await act(async () => result.current.steer(SID, "inspect this"));
      const id = useAppStore.getState().aiStreams[SID].steerQueue[0].id;
      act(() => onEvent({ type: "SteerProcessing", ids: [id] }));
      if (termination === "failure") {
        act(() => onEvent({ type: "Error", message: "provider failed" }));
      } else {
        await act(async () => result.current.cancel(SID));
      }
      agent.resolve([]);
      await act(async () => run);
      const message = useAppStore.getState().aiStreams[SID].messages.find((m) => m.steer);
      expect(message?.steer).toBe("undelivered");
      expect(message?.attachments).toEqual([file]);
      expect(message?.content).toContain("RETRY-CONTENT-42");
      expect(useAppStore.getState().aiStreams[SID].messages.some(
        (m) => m.role === "assistant" && m.content === "prior answer",
      )).toBe(true);

      // SteerBadge retries the preserved folded text as a new run.
      await act(async () => result.current.startAgent(SID, message!.content, []));
      expect(api.agentStart).toHaveBeenCalledTimes(2);
      expect(api.agentStart.mock.calls[1][1]).toContain("RETRY-CONTENT-42");
    },
  );

  it("keeps newly staged files when the opening agent turn finishes saving its image", async () => {
    useAppStore.setState({ catalog: [{ id: "test-model", supports_vision: true } as never] });
    const write = deferred<{ path: string }>();
    const agent = deferred<ChatMessage[]>();
    api.attachmentPut.mockImplementationOnce(() => write.promise);
    api.agentStart.mockImplementationOnce(() => agent.promise);
    useAppStore.getState().attachFilesToAi(SID, [{ id: "img", kind: "image", name: "screen.png", mediaType: "image/png", bytes: 4, data: "AAAA" }]);
    const { result } = renderHook(() => useAiStream());
    let run!: Promise<void>;
    act(() => { run = result.current.startAgent(SID, "first"); });
    const later = pastedText("next message");
    act(() => { useAppStore.getState().attachFilesToAi(SID, [later]); });
    write.resolve({ path: "/tmp/screen.png" });
    await flushPreflight();
    expect(useAppStore.getState().aiStreams[SID].pendingAttachments).toEqual([later]);
    agent.resolve([]);
    await act(async () => run);
  });

  it("sends text and images with the queued message and removes only those chips", async () => {
    useAppStore.setState({ catalog: [{ id: "test-model", supports_vision: true } as never] });
    useAppStore.getState().initAiStream(SID, "agent", "running-agent");
    const file = pastedText("diagnostic log");
    const image: Attachment = { id: "img", kind: "image", name: "screen.png", mediaType: "image/png", bytes: 4, data: "AAAA" };
    useAppStore.getState().attachFilesToAi(SID, [file, image]);
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.steer(SID, "look at these"));
    expect(api.agentSteer).toHaveBeenCalledWith("running-agent", expect.any(String), "look at these", expect.stringContaining("diagnostic log"), [{ media_type: "image/png", data: "AAAA" }]);
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.pendingAttachments).toEqual([]);
    const message = stream.messages[stream.messages.length - 1];
    expect(message?.attachments?.map((a) => a.id)).toEqual([file.id, image.id]);
    expect(message?.steer).toBe("queued");
  });

  it("keeps attachments on an undelivered message when the backend rejects it", async () => {
    useAppStore.getState().initAiStream(SID, "agent", "running-agent");
    const file = pastedText("keep this log");
    useAppStore.getState().attachFilesToAi(SID, [file]);
    api.agentSteer.mockRejectedValueOnce(new Error("run ended"));
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.steer(SID, "inspect"));
    const messages = useAppStore.getState().aiStreams[SID].messages;
    const message = messages[messages.length - 1];
    expect(message?.steer).toBe("undelivered");
    expect(message?.attachments).toEqual([file]);
    expect(message?.content).toContain("keep this log");
  });

  it("delivers queued messages in order when image persistence is slow", async () => {
    useAppStore.setState({ catalog: [{ id: "test-model", supports_vision: true } as never] });
    useAppStore.getState().initAiStream(SID, "agent", "running-agent");
    const write = deferred<{ path: string }>();
    api.attachmentPut.mockImplementationOnce(() => write.promise);
    useAppStore.getState().attachFilesToAi(SID, [{ id: "img", kind: "image", name: "screen.png", mediaType: "image/png", bytes: 4, data: "AAAA" }]);
    const { result } = renderHook(() => useAiStream());
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.steer(SID, "first");
      second = result.current.steer(SID, "second");
    });
    await flushPreflight();
    expect(api.agentSteer).not.toHaveBeenCalled();
    write.resolve({ path: "/tmp/screen.png" });
    await act(async () => { await Promise.all([first, second]); });
    expect(api.agentSteer.mock.calls.map((call) => call[2])).toEqual(["first", "second"]);
  });

  it("retains an image saved after its run ended and a new run started", async () => {
    useAppStore.setState({ catalog: [{ id: "test-model", supports_vision: true } as never] });
    useAppStore.getState().initAiStream(SID, "agent", "old-agent");
    const write = deferred<{ path: string }>();
    api.attachmentPut.mockImplementationOnce(() => write.promise);
    useAppStore.getState().attachFilesToAi(SID, [{ id: "img", kind: "image", name: "screen.png", mediaType: "image/png", bytes: 4, data: "AAAA" }]);
    const { result } = renderHook(() => useAiStream());
    let pending!: Promise<void>;
    act(() => { pending = result.current.steer(SID, "look"); });
    await flushPreflight();
    act(() => {
      useAppStore.getState().finishAiStream(SID, undefined, undefined, "old-agent");
      useAppStore.getState().initAiStream(SID, "agent", "new-agent");
    });
    write.resolve({ path: "/tmp/saved-screen.png" });
    await act(async () => pending);
    const message = useAppStore.getState().aiStreams[SID].messages.find((m) => m.steer === "undelivered");
    expect(message?.attachments?.[0].path).toBe("/tmp/saved-screen.png");
    expect(api.agentSteer).not.toHaveBeenCalled();
  });
});

describe("terminal command result classification", () => {
  it("presents unavailable integration as definitely not run without fencing the agent", () => {
    const outcome: PtyExecOutcome = {
      exitCode: null,
      output: "",
      durationMs: 1000,
      mode: null,
      error: "integration_unavailable",
    };
    expect(cardStatus(outcome)).toBe("blocked");
    expect(commandOutcomeFence(outcome)).toBeUndefined();
    expect(commandResultPresentation(outcome.error, outcome.exitCode)).toEqual({
      status: "blocked",
      note: expect.stringContaining("shell integration did not initialize"),
    });
  });

  it("distinguishes pre-dispatch closure from post-dispatch uncertainty", () => {
    const beforeDispatch = {
      exitCode: null,
      output: "",
      durationMs: 1,
      mode: null,
      error: "terminal_closed" as const,
    };
    const afterDispatch = { ...beforeDispatch, mode: "sentinel" as const };
    expect(cardStatus(beforeDispatch)).toBe("blocked");
    expect(commandOutcomeFence(beforeDispatch)).toBeUndefined();
    expect(cardStatus(afterDispatch)).toBe("timeout");
    expect(commandOutcomeFence(afterDispatch)).toContain("stopped");
  });

  it("fences every completion-unknown result but not a confirmed interrupt", () => {
    const confirmed = commandResultPresentation("interrupted", 130);
    expect(confirmed.status).toBe("interrupted");
    expect(confirmed).not.toHaveProperty("fence");
    expect(commandResultPresentation("interrupted", null)).toMatchObject({
      status: "interrupted",
      note: expect.stringContaining("exit status is unknown"),
      fence: expect.stringContaining("stopped"),
    });
    expect(commandResultPresentation("cancelled", null)).toMatchObject({
      status: "timeout",
      note: expect.stringContaining("Completion unknown"),
      fence: expect.stringContaining("stopped"),
    });
    expect(commandResultPresentation("frontend_timeout", null)).toMatchObject({
      status: "timeout",
      fence: expect.stringContaining("stopped"),
    });
    expect(commandResultPresentation("timeout", null)).toHaveProperty("fence");
    expect(
      commandResultPresentation("command_not_observed", null),
    ).toHaveProperty("fence");
    expect(commandResultPresentation("terminal_closed", null)).toHaveProperty(
      "fence",
    );
  });
});

function installSidecar(): void {
  const remote: Session = {
    ...session(),
    id: REMOTE_SID,
    hostId: "saved-prod",
    hostLabel: "Production",
    ordinal: 2,
  };
  const store = useAppStore.getState();
  store.addSession(remote, false);
  store.updateSessionUi(SID, {
    cwd: "/Users/me/project",
    gitBranch: "main",
    integrationActive: true,
  });
  store.updateSessionUi(REMOTE_SID, {
    remote: { kind: "ssh", target: "deploy@prod-01" },
    nestedBlockId: "ssh-block",
    runningBlockId: "ssh-block",
    remoteHost: { id: "saved-prod", label: "Production", color: null },
  });
  terminalRegistry.entries.set(SID, { disposed: false });
  terminalRegistry.entries.set(REMOTE_SID, { disposed: false });
  const result = store.startSidecar(SID, SID, REMOTE_SID, {
    kind: "ssh",
    target: "deploy@prod-01",
    hostId: "saved-prod",
    label: "Production",
  });
  if (!result.ok) throw new Error(result.reason);
}

describe("AI generation ownership", () => {
  it("sends an attachment-only Ask turn with the complete fenced text", async () => {
    const body = "START-OF-PASTE\n```embedded fence```\nEND-OF-PASTE";
    const attachment = pastedText(body);
    useAppStore.getState().attachFilesToAi(SID, [attachment]);
    const { result } = renderHook(() => useAiStream());

    await act(async () => result.current.ask(SID, ""));

    const expected = `Attached file — pasted-text-1.txt:\n\`\`\`\`\n${body}\n\`\`\`\``;
    expect(api.aiAsk).toHaveBeenCalledOnce();
    expect(api.aiAsk.mock.calls[0][1]).toBe(expected);
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.messages[0]).toMatchObject({
      role: "user",
      content: expected,
      attachments: [attachment],
    });
    expect(stream.pendingAttachments).toEqual([]);
  });

  it("sends an attachment-only Agent goal with the complete fenced text", async () => {
    const body = "START-OF-PASTE\nagent context\nEND-OF-PASTE";
    const attachment = pastedText(body);
    useAppStore.getState().attachFilesToAi(SID, [attachment]);
    const { result } = renderHook(() => useAiStream());

    await act(async () => result.current.startAgent(SID, ""));

    const expected = `Attached file — pasted-text-1.txt:\n\`\`\`\n${body}\n\`\`\``;
    expect(api.agentStart).toHaveBeenCalledOnce();
    expect(api.agentStart.mock.calls[0][1]).toBe(expected);
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.messages[0]).toMatchObject({
      role: "user",
      content: expected,
      attachments: [attachment],
    });
    expect(stream.pendingAttachments).toEqual([]);
  });

  it("forwards attached Qdrant buckets when starting an agent run", async () => {
    const bucket: KnowledgeBucketRef = {
      source: "qdrant",
      connection_id: "connection-1",
      collection: "manuals",
    };
    useAppStore.getState().attachBucketToAi(SID, bucket);
    const { result } = renderHook(() => useAiStream());

    await act(async () => result.current.startAgent(SID, "search the manuals"));

    expect(api.agentStart).toHaveBeenCalledOnce();
    expect(api.agentStart.mock.calls[0][5]).toEqual([bucket]);
  });

  it("accepts an agent transcript after Done clears requestId", async () => {
    const backend = deferred<ChatMessage[]>();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return backend.promise;
    });
    const { result } = renderHook(() => useAiStream());

    let run!: Promise<void>;
    act(() => {
      run = result.current.startAgent(SID, "inspect the project");
    });
    await flushPreflight();

    act(() => {
      onEvent({ type: "Done", prompt_tokens: 3, completion_tokens: 5 });
    });
    const afterDone = useAppStore.getState().aiStreams[SID];
    expect(afterDone.requestId).toBeNull();
    expect(afterDone.generationId).not.toBeNull();

    const transcript: ChatMessage[] = [{ role: "user", content: "inspect the project" }];
    backend.resolve(transcript);
    await act(async () => run);

    expect(useAppStore.getState().aiStreams[SID].modelTranscript).toEqual(transcript);
  });

  it("stores and persists a checkpoint without settling the active run", async () => {
    const backend = deferred<ChatMessage[]>();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return backend.promise;
    });
    const { result } = renderHook(() => useAiStream());

    let run!: Promise<void>;
    act(() => {
      run = result.current.startAgent(SID, "inspect the project");
    });
    await flushPreflight();

    const checkpoint: ChatMessage[] = [
      { role: "user", content: "inspect the project" },
      { role: "assistant", content: "working" },
    ];
    act(() => onEvent({ type: "Checkpoint", sequence: 1, transcript: checkpoint }));

    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.modelTranscript).toEqual(checkpoint);
    expect(stream.status).toBe("streaming");
    expect(stream.requestId).not.toBeNull();
    expect(persistence.markTranscriptCheckpoint).toHaveBeenCalledWith(SID);

    act(() => onEvent({ type: "Done", prompt_tokens: 1, completion_tokens: 1 }));
    backend.resolve(checkpoint);
    await act(async () => run);
  });

  it("keeps a failed run's returned transcript after the Error event settles it", async () => {
    const backend = deferred<ChatMessage[]>();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return backend.promise;
    });
    const { result } = renderHook(() => useAiStream());

    let run!: Promise<void>;
    act(() => {
      run = result.current.startAgent(SID, "run then fail");
    });
    await flushPreflight();

    act(() => onEvent({ type: "Error", message: "provider failed" }));
    expect(useAppStore.getState().aiStreams[SID].status).toBe("error");

    const transcript: ChatMessage[] = [
      { role: "user", content: "run then fail" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "run_command", arguments: "{}" }] },
      { role: "tool", content: "exit code: 0", tool_call_id: "c1" },
    ];
    backend.resolve(transcript);
    await act(async () => run);

    expect(useAppStore.getState().aiStreams[SID].modelTranscript).toEqual(transcript);
    expect(persistence.markTranscriptDirty).toHaveBeenCalledWith(SID);
  });

  it("ignores an old agent result after an exit fence and a rollback/new run", async () => {
    const oldBackend = deferred<ChatMessage[]>();
    const newBackend = deferred<ChatMessage[]>();
    let oldEvent!: (event: StreamEvent) => void;
    let newEvent!: (event: StreamEvent) => void;
    api.agentStart
      .mockImplementationOnce((...args: unknown[]) => {
        oldEvent = args[6] as (event: StreamEvent) => void;
        return oldBackend.promise;
      })
      .mockImplementationOnce((...args: unknown[]) => {
        newEvent = args[6] as (event: StreamEvent) => void;
        return newBackend.promise;
      });
    const { result } = renderHook(() => useAiStream());

    let oldRun!: Promise<void>;
    act(() => {
      oldRun = result.current.startAgent(SID, "old run");
    });
    await flushPreflight();
    const oldGeneration = useAppStore.getState().aiStreams[SID].generationId;

    // This is the synchronous stream fence used by exit preparation. A failed
    // update may then roll persistence back and let the user start another run.
    act(() => useAppStore.getState().finishAiStream(SID));

    let newRun!: Promise<void>;
    act(() => {
      newRun = result.current.startAgent(SID, "new run");
    });
    await flushPreflight();
    const newGeneration = useAppStore.getState().aiStreams[SID].generationId;
    expect(newGeneration).not.toBe(oldGeneration);

    oldEvent({
      type: "Checkpoint",
      sequence: 99,
      transcript: [{ role: "assistant", content: "stale checkpoint" }],
    });
    expect(useAppStore.getState().aiStreams[SID].modelTranscript).toEqual([]);
    expect(persistence.markTranscriptCheckpoint).not.toHaveBeenCalled();

    oldBackend.resolve([{ role: "assistant", content: "stale transcript" }]);
    await act(async () => oldRun);
    expect(useAppStore.getState().aiStreams[SID].modelTranscript).toEqual([]);
    expect(useAppStore.getState().aiStreams[SID].generationId).toBe(newGeneration);

    act(() => newEvent({ type: "Done", prompt_tokens: 1, completion_tokens: 1 }));
    const current = [{ role: "assistant", content: "current transcript" }] satisfies ChatMessage[];
    newBackend.resolve(current);
    await act(async () => newRun);
    expect(useAppStore.getState().aiStreams[SID].modelTranscript).toEqual(current);
  });

  it("fences an attachment preflight before it can dispatch or write a transcript", async () => {
    const attachment = deferred<{ path: string }>();
    api.attachmentPut.mockImplementationOnce(() => attachment.promise);
    useAppStore.getState().attachFilesToAi(SID, [
      {
        id: "image-1",
        kind: "image",
        name: "screen.png",
        mediaType: "image/png",
        bytes: 4,
        data: "AAAA",
      },
    ]);
    const { result } = renderHook(() => useAiStream());

    let run!: Promise<void>;
    act(() => {
      run = result.current.ask(SID, "what is shown?");
    });
    expect(useAppStore.getState().aiStreams[SID].requestId).not.toBeNull();
    expect(api.attachmentPut).toHaveBeenCalledTimes(1);

    // Exit preparation sees the preflight's requestId and retires its generation
    // before taking the final archive snapshot.
    act(() => useAppStore.getState().finishAiStream(SID));
    attachment.resolve({ path: "/tmp/screen.png" });
    await act(async () => run);

    const stream = useAppStore.getState().aiStreams[SID];
    expect(api.aiAsk).not.toHaveBeenCalled();
    expect(stream.messages).toEqual([]);
    expect(stream.requestId).toBeNull();
    expect(stream.generationId).toBeNull();
    expect(stream.pendingAttachments).toHaveLength(1);
  });

  it("settles an owned preflight failure instead of leaving the session streaming", async () => {
    const brokenAttachment = {
      id: "broken",
      get kind(): "image" {
        throw new Error("attachment preflight failed");
      },
      name: "broken.png",
      mediaType: "image/png",
      bytes: 4,
      data: "AAAA",
    } as Attachment;
    const current = useAppStore.getState().aiStreams[SID];
    useAppStore.setState({
      aiStreams: {
        ...useAppStore.getState().aiStreams,
        [SID]: { ...current, pendingAttachments: [brokenAttachment] },
      },
    });
    const { result } = renderHook(() => useAiStream());

    await act(async () => result.current.ask(SID, "will not dispatch"));

    const stream = useAppStore.getState().aiStreams[SID];
    expect(api.aiAsk).not.toHaveBeenCalled();
    expect(stream.status).toBe("error");
    expect(stream.requestId).toBeNull();
    expect(stream.lastError).toContain("attachment preflight failed");
    expect(stream.messages).toEqual([]);
  });

  it("does not send an ask without an attached image whose data is unavailable", async () => {
    useAppStore.setState({ catalog: [{ id: "test-model", supports_vision: true } as never] });
    const image: Attachment = {
      id: "missing-image", kind: "image", name: "missing.png",
      mediaType: "image/png", bytes: 4, path: "/tmp/missing.png",
    };
    useAppStore.getState().attachFilesToAi(SID, [image]);
    const { result } = renderHook(() => useAiStream());

    await act(async () => result.current.ask(SID, "what is shown?"));

    const stream = useAppStore.getState().aiStreams[SID];
    expect(api.aiAsk).not.toHaveBeenCalled();
    expect(stream.status).toBe("error");
    expect(stream.requestId).toBeNull();
    expect(stream.pendingAttachments).toEqual([image]);
    expect(stream.messages).toEqual([]);
  });

  it("a delayed cancel and old rejection cannot clobber a newer ask", async () => {
    const oldBackend = deferred<void>();
    const newBackend = deferred<void>();
    const cancelBackend = deferred<void>();
    let oldEvent!: (event: StreamEvent) => void;
    let newEvent!: (event: StreamEvent) => void;
    api.aiAsk
      .mockImplementationOnce((...args: unknown[]) => {
        oldEvent = args[6] as (event: StreamEvent) => void;
        return oldBackend.promise;
      })
      .mockImplementationOnce((...args: unknown[]) => {
        newEvent = args[6] as (event: StreamEvent) => void;
        return newBackend.promise;
      });
    api.aiCancel.mockImplementationOnce(() => cancelBackend.promise);
    const { result } = renderHook(() => useAiStream());

    let oldRun!: Promise<void>;
    act(() => {
      oldRun = result.current.ask(SID, "old question");
    });
    await flushPreflight();
    const oldRequest = useAppStore.getState().aiStreams[SID].requestId;

    let cancellation!: Promise<void>;
    act(() => {
      cancellation = result.current.cancel(SID);
    });
    expect(api.aiCancel).toHaveBeenCalledWith(oldRequest);
    expect(useAppStore.getState().aiStreams[SID].generationId).toBeNull();

    let newRun!: Promise<void>;
    act(() => {
      newRun = result.current.ask(SID, "new question");
    });
    await flushPreflight();
    const newRequest = useAppStore.getState().aiStreams[SID].requestId;
    expect(newRequest).not.toBe(oldRequest);

    oldEvent({ type: "Delta", content: "stale" });
    oldBackend.reject(new Error("old request cancelled late"));
    await act(async () => oldRun);
    let stream = useAppStore.getState().aiStreams[SID];
    expect(stream.requestId).toBe(newRequest);
    expect(stream.status).toBe("streaming");
    expect(stream.lastError).toBeNull();
    expect(stream.streamingContent).toBe("");

    act(() => {
      newEvent({ type: "Delta", content: "fresh" });
      newEvent({ type: "Done", prompt_tokens: 2, completion_tokens: 1 });
    });
    newBackend.resolve();
    cancelBackend.resolve();
    await act(async () => Promise.all([newRun, cancellation]));

    stream = useAppStore.getState().aiStreams[SID];
    expect(stream.status).toBe("idle");
    expect(stream.lastError).toBeNull();
    expect(stream.messages[stream.messages.length - 1]?.content).toBe("fresh");
  });
});

describe("single-terminal command routing", () => {
  it("does not turn an SSH proposal into a local command after disconnect", async () => {
    useAppStore.getState().updateSessionUi(SID, {
      remote: { kind: "ssh", target: "prod-01" }, nestedBlockId: "ssh-block",
    });
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect remote"));
    act(() => onEvent({
      type: "CommandProposal", approval_id: "ssh-disconnect", command: "pwd",
      explanation: "Inspect remote directory", read_only: true, network: false,
      output_policy: "normal",
    }));
    expect(useAppStore.getState().aiStreams[SID].pendingProposal).toMatchObject({
      proposedRemote: true,
      proposedTargetLabel: "ssh prod-01",
    });
    act(() => useAppStore.getState().updateSessionUi(SID, { remote: null, nestedBlockId: null }));
    expect(result.current.proposalTargetIsCurrent(SID)).toBe(false);
    await act(async () => result.current.respondToProposal(SID, "run"));
    expect(api.respondToApproval).toHaveBeenCalledWith("ssh-disconnect", "skip");
    expect(pty.runInTerminal).not.toHaveBeenCalled();
    expect(useAppStore.getState().aiStreams[SID].messages.some(
      (message) => message.command?.note?.includes("terminal target changed"),
    )).toBe(true);
  });

  it("rejects a remote command when SSH disconnects between approval and dispatch", async () => {
    useAppStore.getState().updateSessionUi(SID, {
      remote: { kind: "ssh", target: "prod-01" }, nestedBlockId: "ssh-block",
    });
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect remote"));
    act(() => onEvent({
      type: "CommandProposal", approval_id: "ssh-after-approval", command: "pwd",
      explanation: "Inspect remote directory", read_only: true, network: false,
      output_policy: "normal",
    }));
    act(() => expect(result.current.attestProposalPrompt(SID, true)).toBe(true));
    await act(async () => result.current.respondToProposal(SID, "run"));
    act(() => useAppStore.getState().updateSessionUi(SID, { remote: null, nestedBlockId: null }));
    act(() => onEvent({
      type: "RunInTerminal", approval_id: "ssh-after-approval", session_id: SID,
      command: "pwd", timeout_secs: 30, explanation: "Inspect remote directory", output_policy: "normal",
    }));
    expect(pty.runInTerminal).not.toHaveBeenCalled();
    expect(api.submitCommandResult).toHaveBeenCalledWith("ssh-after-approval", null,
      expect.stringContaining("terminal target changed"), 0, "target_changed");
  });
  it("accepts an ordinary approval and dispatch without treating it as Sidecar", async () => {
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "clone the project"));

    act(() => {
      onEvent({
        type: "CommandProposal",
        approval_id: "single-approval",
        command: "git clone https://example.test/project.git",
        explanation: "Clone the requested project",
        read_only: false,
        network: true,
        output_policy: "normal",
      });
    });

    expect(useAppStore.getState().aiStreams[SID].pendingProposal).toMatchObject({
      approvalId: "single-approval",
      command: "git clone https://example.test/project.git",
    });
    expect(useAppStore.getState().aiStreams[SID].lastError).toBeNull();
    expect(api.aiCancel).not.toHaveBeenCalled();

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "single-approval",
        session_id: SID,
        command: "git clone https://example.test/project.git",
        timeout_secs: 120,
        explanation: "Clone the requested project",
        output_policy: "normal",
      });
    });
    await flushPreflight();

    expect(pty.runInTerminal).toHaveBeenCalledWith(
      SID,
      "single-approval",
      "git clone https://example.test/project.git",
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    expect(useAppStore.getState().aiStreams[SID].lastError).toBeNull();
    expect(api.aiCancel).not.toHaveBeenCalled();
  });

  it("surfaces and fences a command-result submission failure", async () => {
    api.submitCommandResult.mockRejectedValueOnce(new Error("IPC closed"));
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect packages"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "submit-fails",
        session_id: SID,
        command: "apt list --upgradable",
        timeout_secs: 120,
        explanation: "Inspect available package updates",
        output_policy: "normal",
      });
    });

    await vi.waitFor(() => expect(api.aiCancel).toHaveBeenCalledWith(requestId));
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.status).toBe("error");
    expect(stream.requestId).toBeNull();
    expect(stream.generationId).toBeNull();
    expect(stream.lastError).toContain("could not report this terminal outcome");
  });

  it("marks interrupt failure unknown and stops the Agent before another command", async () => {
    pty.runInTerminal.mockResolvedValueOnce({
      exitCode: null,
      output: "partial",
      durationMs: 1_000,
      mode: "sentinel",
      error: "interrupt_failed",
    });
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect packages"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "interrupt-fails",
        session_id: SID,
        command: "apt list --upgradable",
        timeout_secs: 120,
        explanation: "Inspect available package updates",
        output_policy: "normal",
      });
    });

    await vi.waitFor(() => expect(api.aiCancel).toHaveBeenCalledWith(requestId));
    const stream = useAppStore.getState().aiStreams[SID];
    const command = stream.messages.find(
      (message) => message.id === "cmd-interrupt-fails",
    )?.command;
    expect(command?.status).toBe("timeout");
    expect(command?.note).toContain("Completion unknown");
    expect(stream.lastError).toContain("could not confirm");
  });

  it("stops the Agent after a post-dispatch completion timeout", async () => {
    pty.runInTerminal.mockResolvedValueOnce({
      exitCode: null,
      output: "partial",
      durationMs: 120_000,
      mode: "sentinel",
      error: "timeout",
    });
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect packages"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "completion-unknown",
        session_id: SID,
        command: "apt list --upgradable",
        timeout_secs: 120,
        explanation: "Inspect available package updates",
        output_policy: "normal",
      });
    });

    await vi.waitFor(() => expect(api.aiCancel).toHaveBeenCalledWith(requestId));
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.status).toBe("error");
    expect(stream.lastError).toContain("completion could not be confirmed");
    expect(
      stream.messages.find(
        (message) => message.id === "cmd-completion-unknown",
      )?.command?.status,
    ).toBe("timeout");
  });

  it("releases a backend-timed-out PTY waiter without submitting a duplicate result", async () => {
    const waiter = deferred<PtyExecOutcome>();
    pty.runInTerminal.mockReturnValueOnce(waiter.promise);
    pty.abortSession.mockImplementationOnce(() => {
      waiter.resolve({
        exitCode: null,
        output: "",
        durationMs: 135_000,
        mode: "sentinel",
        error: "cancelled",
      });
      return true;
    });
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect packages"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "backend-timeout",
        session_id: SID,
        command: "apt list --upgradable",
        timeout_secs: 120,
        explanation: "Inspect available package updates",
        output_policy: "normal",
      });
    });
    expect(pty.runInTerminal).toHaveBeenCalledOnce();

    act(() => {
      onEvent({
        type: "CommandResult",
        approval_id: "backend-timeout",
        exit_code: null,
        duration_ms: 135_000,
        error: "frontend_timeout",
      });
    });
    await flushPreflight();

    expect(pty.abortSession).toHaveBeenCalledOnce();
    expect(pty.abortSession).toHaveBeenCalledWith(
      SID,
      "cancelled",
      "backend-timeout",
    );
    expect(api.aiCancel).toHaveBeenCalledWith(requestId);
    expect(api.submitCommandResult).not.toHaveBeenCalled();
    const stream = useAppStore.getState().aiStreams[SID];
    expect(stream.requestId).toBeNull();
    expect(stream.generationId).toBeNull();
    expect(stream.status).toBe("error");
    expect(stream.lastError).toContain("completion could not be confirmed");
    expect(
      stream.messages.find(
        (message) => message.id === "cmd-backend-timeout",
      )?.command?.status,
    ).toBe("timeout");
  });

  it("does not cancel a live waiter for an ordinary backend result echo", async () => {
    pty.runInTerminal.mockReturnValueOnce(deferred<PtyExecOutcome>().promise);
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect packages"));

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "ordinary-result",
        session_id: SID,
        command: "apt list --upgradable",
        timeout_secs: 120,
        explanation: "Inspect available package updates",
        output_policy: "normal",
      });
      onEvent({
        type: "CommandResult",
        approval_id: "ordinary-result",
        exit_code: 0,
        duration_ms: 42,
        error: null,
      });
    });

    expect(pty.abortSession).not.toHaveBeenCalled();
    const command = useAppStore
      .getState()
      .aiStreams[SID].messages.find(
        (message) => message.id === "cmd-ordinary-result",
      )?.command;
    expect(command?.status).toBe("done");
    expect(command?.exitCode).toBe(0);
  });
});

describe("AI Sidecar routing", () => {
  it("sends separately grounded local and SSH contexts to agentStart", async () => {
    installSidecar();
    const { result } = renderHook(() => useAiStream());

    await act(async () => result.current.startAgent(REMOTE_SID, "inspect locally, deploy remotely"));

    expect(api.agentStart).toHaveBeenCalledOnce();
    const call = api.agentStart.mock.calls[0];
    expect(call[2]).toMatchObject({
      session_id: SID,
      cwd: "/Users/me/project",
      git_branch: "main",
      remote: null,
    });
    expect(call[7]).toEqual({
      local: expect.objectContaining({
        session_id: SID,
        cwd: "/Users/me/project",
        git_branch: "main",
        remote: null,
      }),
      remote: expect.objectContaining({
        session_id: REMOTE_SID,
        cwd: null,
        git_branch: null,
        remote: { kind: "ssh", target: "deploy@prod-01", host_id: "saved-prod" },
      }),
    });
  });

  it("never lets the frontend auto-click a backend approval proposal", async () => {
    installSidecar();
    useAppStore.getState().setSidecarPermission(SID, "local", "auto_all");
    // Remote deliberately remains `ask`.
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "compare both targets"));

    act(() => {
      onEvent({
        type: "CommandProposal",
        approval_id: "local-read",
        command: "gh issue view 42",
        explanation: "Read the issue with local credentials",
        read_only: true,
        network: true,
        output_policy: "normal",
        target_role: "local",
        target_session_id: SID,
      });
    });
    expect(api.respondToApproval).not.toHaveBeenCalled();
    expect(useAppStore.getState().aiStreams[SID].pendingProposal).toMatchObject({
      approvalId: "local-read",
      targetRole: "local",
      targetSessionId: SID,
    });
  });

  it("routes RunInTerminal by emitted session id even when the other pane is focused", async () => {
    installSidecar();
    useAppStore.getState().setSidecarFocusedSession(SID, SID);
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "restart the service"));

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "remote-run",
        session_id: REMOTE_SID,
        command: "docker compose up -d api",
        timeout_secs: 120,
        explanation: "Apply the requested service update",
        output_policy: "private",
        target_role: "remote",
        target_session_id: REMOTE_SID,
      });
    });

    expect(useAppStore.getState().activeSessionId).toBe(SID);
    expect(pty.runInTerminal).toHaveBeenCalledOnce();
    expect(pty.runInTerminal.mock.calls[0].slice(0, 3)).toEqual([
      REMOTE_SID,
      "remote-run",
      "docker compose up -d api",
    ]);
    expect(pty.runInTerminal.mock.calls[0][3]).toMatchObject({ outputPolicy: "private" });
  });

  it("releases the stored Sidecar waiter before rejecting stale timeout metadata", async () => {
    installSidecar();
    pty.runInTerminal.mockReturnValueOnce(deferred<PtyExecOutcome>().promise);
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "inspect remote packages"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "remote-backend-timeout",
        session_id: REMOTE_SID,
        command: "apt list --upgradable",
        timeout_secs: 120,
        explanation: "Inspect remote package updates",
        output_policy: "normal",
        target_role: "remote",
        target_session_id: REMOTE_SID,
      });
    });
    expect(pty.runInTerminal).toHaveBeenCalledOnce();

    act(() =>
      useAppStore.getState().markSidecarDegraded(SID, {
        role: "remote",
        reason: "remote_identity_changed",
      }),
    );
    act(() => {
      onEvent({
        type: "CommandResult",
        approval_id: "remote-backend-timeout",
        exit_code: null,
        duration_ms: 135_000,
        error: "frontend_timeout",
        // Neither field may select the PTY released by this event. The exact
        // validated target was captured on the command card before dispatch.
        target_role: "local",
        target_session_id: SID,
      });
    });

    expect(pty.abortSession).toHaveBeenCalledOnce();
    expect(pty.abortSession).toHaveBeenCalledWith(
      REMOTE_SID,
      "cancelled",
      "remote-backend-timeout",
    );
    expect(api.aiCancel).toHaveBeenCalledWith(requestId);
  });

  it("rejects mismatched backend target metadata before terminal dispatch", async () => {
    installSidecar();
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "deploy"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "mismatch",
        session_id: SID,
        command: "uname -a",
        timeout_secs: 30,
        explanation: "Inspect the remote host",
        output_policy: "normal",
        target_role: "remote",
        // A stale/corrupt event cannot redirect `remote` into the local PTY.
        target_session_id: SID,
      });
    });

    expect(pty.runInTerminal).not.toHaveBeenCalled();
    expect(api.submitCommandResult).toHaveBeenCalledWith(
      "mismatch",
      null,
      expect.stringContaining("Nothing was executed"),
      0,
      "target_changed",
    );
    expect(api.aiCancel).toHaveBeenCalledWith(requestId);
  });

  it("fails the final canWrite guard when a valid target becomes stale during preflight", async () => {
    installSidecar();
    const probe = deferred<void>();
    const terminalWrite = vi.fn();
    pty.runInTerminal.mockImplementationOnce(
      async (
        sessionId: string,
        _approvalId: string,
        _command: string,
        opts: { canWrite?: () => boolean },
      ) => {
        await probe.promise;
        const allowed = opts.canWrite?.() ?? true;
        if (allowed) terminalWrite(sessionId);
        return {
          exitCode: null,
          output: "",
          durationMs: 1,
          mode: "integrated",
          ...(allowed ? {} : { error: "target_changed" as const }),
        };
      },
    );
    let onEvent!: (event: StreamEvent) => void;
    api.agentStart.mockImplementationOnce((...args: unknown[]) => {
      onEvent = args[6] as (event: StreamEvent) => void;
      return Promise.resolve([]);
    });
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(SID, "deploy"));

    act(() => {
      onEvent({
        type: "RunInTerminal",
        approval_id: "stale-during-probe",
        session_id: REMOTE_SID,
        command: "pwd",
        timeout_secs: 30,
        explanation: "Confirm the deployment directory",
        output_policy: "normal",
        target_role: "remote",
        target_session_id: REMOTE_SID,
      });
    });
    expect(pty.runInTerminal).toHaveBeenCalledOnce();

    // Simulates End/Replace/identity degradation while ptyExec is probing the
    // shell. The guard passed to ptyExec is evaluated only immediately before
    // its one write.
    act(() => useAppStore.getState().endSidecar(SID));
    probe.resolve();
    await flushPreflight();

    expect(terminalWrite).not.toHaveBeenCalled();
    expect(api.submitCommandResult).toHaveBeenCalledWith(
      "stale-during-probe",
      null,
      "",
      1,
      "target_changed",
    );
  });

  it("cancelling from either pane aborts pending work in both terminals", async () => {
    installSidecar();
    const { result } = renderHook(() => useAiStream());
    await act(async () => result.current.startAgent(REMOTE_SID, "inspect both targets"));
    const requestId = useAppStore.getState().aiStreams[SID].requestId;

    await act(async () => result.current.cancel(REMOTE_SID));

    expect(pty.abortSession).toHaveBeenCalledTimes(2);
    expect(pty.abortSession).toHaveBeenNthCalledWith(1, SID, "cancelled");
    expect(pty.abortSession).toHaveBeenNthCalledWith(2, REMOTE_SID, "cancelled");
    expect(api.aiCancel).toHaveBeenCalledWith(requestId);
  });
});
