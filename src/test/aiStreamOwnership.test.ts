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

const persistence = vi.hoisted(() => ({ markTranscriptDirty: vi.fn() }));

vi.mock("../lib/tauri", () => api);
vi.mock("../lib/sessionNaming", () => ({ nameSession: vi.fn() }));
vi.mock("../lib/sessionPersistence", () => persistence);
vi.mock("../lib/aiPanel", () => ({ setAiPanelOpen: vi.fn() }));
vi.mock("../lib/ptyExec", () => ({
  abortSession: vi.fn(),
  runInTerminal: vi.fn(),
}));
vi.mock("../lib/termRegistry", () => ({ getTerm: () => undefined }));
vi.mock("../lib/terminalSnapshot", () => ({
  readLineRange: () => "",
  readScreenTail: () => "",
}));

import { useAiStream } from "../hooks/useAiStream";
import { useAppStore } from "../stores/appStore";

const SID = "ai-owner";

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

  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    catalog: [],
    activeModelId: "test-model",
  });
  useAppStore.getState().addSession(session());
});

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

  it("ignores an old agent result after an exit fence and a rollback/new run", async () => {
    const oldBackend = deferred<ChatMessage[]>();
    const newBackend = deferred<ChatMessage[]>();
    let newEvent!: (event: StreamEvent) => void;
    api.agentStart
      .mockImplementationOnce(() => oldBackend.promise)
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
