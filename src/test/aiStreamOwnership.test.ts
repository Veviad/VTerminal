import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Attachment,
  ChatMessage,
  KnowledgeBucketRef,
  Session,
  StreamEvent,
} from "../lib/types";

const api = vi.hoisted(() => ({
  aiSuggest: vi.fn(),
  aiExplain: vi.fn(),
  aiAsk: vi.fn(),
  agentStart: vi.fn(),
  agentSteer: vi.fn(),
  respondToApproval: vi.fn(),
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

import { useAiStream } from "../hooks/useAiStream";
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
