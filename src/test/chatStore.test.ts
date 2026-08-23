import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogEntry,
  ChatDetail,
  ChatMessage,
  ChatSaveInput,
  ChatSummary,
  StreamEvent,
} from "../lib/types";

const mocks = vi.hoisted(() => ({
  chatList: vi.fn(),
  chatGet: vi.fn(),
  chatSave: vi.fn(),
  chatSetArchived: vi.fn(),
  chatUpdateTitle: vi.fn(),
  chatDelete: vi.fn(),
  chatStart: vi.fn(),
  aiNameChat: vi.fn(),
  aiCancel: vi.fn(),
  knowledgeSearchDetailed: vi.fn(),
  attachmentPut: vi.fn(),
  attachmentRead: vi.fn(),
  visionDescribe: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  ...mocks,
  knowledgeBucketsList: vi.fn(async () => []),
}));

import { useChatStore } from "../stores/chatStore";
import { useAppStore } from "../stores/appStore";

function summary(id: string, archived = false, messages = 1): ChatSummary {
  return {
    id,
    title: id,
    title_source: messages ? "fallback" : "placeholder",
    created_at: "2026-08-23T10:00:00Z",
    updated_at: id === "newest" ? "2026-08-23T12:00:00Z" : "2026-08-23T11:00:00Z",
    archived_at: archived ? "2026-08-23T13:00:00Z" : null,
    message_count: messages,
    first_prompt: messages ? "Question" : null,
  };
}

function detail(value: ChatSummary): ChatDetail {
  return {
    summary: value,
    messages: [],
    model_transcript: [],
    model_transcript_version: 1,
    attached_bucket_refs: [],
  };
}

function chatModel(): CatalogEntry {
  return {
    id: "anthropic/chat-test",
    provider: "anthropic",
    tier: "balanced",
    label: "Chat Test",
    description: "",
    wire_model: "chat-test",
    context_tokens: 100_000,
    efforts: ["off"],
    default_effort: "off",
    supports_temperature: true,
    supports_tools: true,
    native_web_search: true,
    native_web_fetch: true,
    supports_vision: true,
    local: null,
    remote: null,
    fits: true,
    downloaded: false,
    configured: true,
    effort: "off",
  };
}

describe("Chat workspace store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatSave.mockResolvedValue(undefined);
    mocks.chatSetArchived.mockResolvedValue(undefined);
    mocks.chatUpdateTitle.mockResolvedValue(false);
    mocks.aiNameChat.mockResolvedValue("Generated title");
    mocks.saveSettings.mockResolvedValue(undefined);
    useAppStore.setState({
      catalog: [chatModel()],
      activeModelId: "anthropic/chat-test",
      docsEnabled: false,
    });
    useChatStore.setState({
      initialized: false,
      workspaceMode: "terminal",
      summaries: [],
      current: null,
      search: "",
      archivedOpen: false,
      stream: { status: "idle", requestId: null, content: "", thinking: "", model: null, citations: [], lastError: null },
      pendingAttachments: [],
      attachError: null,
      attachStatus: null,
      knowledgeWarning: null,
    });
  });

  it("falls back from a missing remembered chat to the newest active chat", async () => {
    const archived = summary("archived", true);
    const newest = summary("newest");
    mocks.chatList.mockResolvedValue([newest, archived]);
    mocks.chatGet.mockResolvedValue(detail(newest));

    await useChatStore.getState().initialize("chat", "missing");

    expect(useChatStore.getState().current?.summary.id).toBe("newest");
    expect(useChatStore.getState().workspaceMode).toBe("chat");
    expect(mocks.saveSettings).toHaveBeenCalledWith({ active_chat_id: "newest" });
  });

  it("reuses an existing empty active chat", async () => {
    const empty = summary("empty", false, 0);
    mocks.chatList.mockResolvedValue([empty]);
    mocks.chatGet.mockResolvedValue(detail(empty));
    await useChatStore.getState().initialize("chat", empty.id);
    mocks.chatSave.mockClear();

    await useChatStore.getState().createChat();

    expect(useChatStore.getState().summaries).toHaveLength(1);
    expect(mocks.chatSave).not.toHaveBeenCalled();
  });

  it("does not archive while a response is running", async () => {
    const active = summary("active");
    useChatStore.setState({
      current: detail(active),
      summaries: [active],
      stream: { status: "streaming", requestId: "request", content: "", thinking: "", model: null, citations: [], lastError: null },
    });

    await useChatStore.getState().archive(true);

    expect(mocks.chatSetArchived).not.toHaveBeenCalled();
    expect(useChatStore.getState().current?.summary.archived_at).toBeNull();
  });

  it("persists the user turn, tool checkpoint, and streamed assistant response", async () => {
    const active = summary("active", false, 0);
    useChatStore.setState({ current: detail(active), summaries: [active] });
    const checkpoint: ChatMessage[] = [
      { role: "user", content: "Explain this" },
      { role: "assistant", content: "", tool_calls: [{ id: "tool-1", name: "search_docs", arguments: "{}" }] },
      { role: "tool", content: "Reference", tool_call_id: "tool-1" },
    ];
    const transcript: ChatMessage[] = [
      ...checkpoint,
      { role: "assistant", content: "A grounded answer" },
    ];
    mocks.chatStart.mockImplementation(async (
      _requestId: string,
      _prompt: string,
      _history: ChatMessage[],
      _images: unknown[],
      _buckets: unknown[],
      onEvent: (event: StreamEvent) => void,
    ) => {
      expect(mocks.chatSave).toHaveBeenCalledTimes(1);
      onEvent({ type: "Started", request_id: "request", model: "Chat Test" });
      onEvent({ type: "ThinkingDelta", content: "Checking sources" });
      onEvent({ type: "Delta", content: "A grounded answer" });
      onEvent({
        type: "WebCitation",
        url: "https://example.com/source",
        title: "Source",
        cited_text: "Evidence",
      });
      onEvent({ type: "Checkpoint", sequence: 1, transcript: checkpoint });
      onEvent({ type: "Done", prompt_tokens: 12, completion_tokens: 5 });
      return transcript;
    });

    await useChatStore.getState().send("Explain this");

    const saves = mocks.chatSave.mock.calls.map(([value]) => value as ChatSaveInput);
    expect(saves[0].messages.map((message) => message.role)).toEqual(["user"]);
    expect(saves.some((value) => value.model_transcript === checkpoint)).toBe(true);
    const final = saves[saves.length - 1]!;
    expect(final.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(final.messages[1]).toMatchObject({
      content: "A grounded answer",
      thinking: "Checking sources",
      model: "Chat Test",
      prompt_tokens: 12,
      completion_tokens: 5,
      citations: [{ url: "https://example.com/source", title: "Source", cited_text: "Evidence" }],
    });
    expect(final.model_transcript).toBe(transcript);
    expect(useChatStore.getState().stream.status).toBe("idle");
  });
});
