import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type {
  CatalogEntry,
  ChatDetail,
  ChatMessage,
  ChatSaveInput,
  ChatSummary,
  StreamEvent,
} from "../lib/types";
import { createMockMcpServer } from "./mcpTestUtils";

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
  mcpDisconnect: vi.fn(),
  respondToMcpApproval: vi.fn(),
  knowledgeSearchDetailed: vi.fn(),
  attachmentPut: vi.fn(),
  attachmentRead: vi.fn(),
  visionDescribe: vi.fn(),
  saveSettings: vi.fn(),
  modelStatus: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  ...mocks,
  knowledgeBucketsList: vi.fn(async () => []),
}));

import { useChatStore, idleStream } from "../stores/chatStore";
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
    mcp_selection: { server_ids: [], disabled_tools: {} },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Chat workspace store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatSave.mockResolvedValue(undefined);
    mocks.chatSetArchived.mockResolvedValue(undefined);
    mocks.chatUpdateTitle.mockResolvedValue(false);
    mocks.chatDelete.mockResolvedValue(undefined);
    mocks.aiNameChat.mockResolvedValue("Generated title");
    mocks.mcpDisconnect.mockResolvedValue(undefined);
    mocks.respondToMcpApproval.mockResolvedValue(undefined);
    mocks.aiCancel.mockResolvedValue(undefined);
    mocks.saveSettings.mockResolvedValue(undefined);
    mocks.modelStatus.mockResolvedValue({
      loaded: null,
      state: "idle",
      available: true,
      acceleration: undefined,
    });
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
      stream: idleStream(),
      pendingAttachments: [],
      mutatingChatIds: [],
      attachError: null,
      attachStatus: null,
      knowledgeWarning: null,
    });
  });

  it("reserves preparation synchronously and preserves attachments staged during a save", async () => {
    const active = summary("prepare", false, 0);
    const saving = deferred<void>();
    mocks.chatSave.mockImplementationOnce(() => saving.promise);
    mocks.chatStart.mockResolvedValue([]);
    useChatStore.setState({ current: detail(active), summaries: [active] });
    const first = useChatStore.getState().send("first");
    await useChatStore.getState().send("duplicate");
    await waitFor(() => expect(mocks.chatSave).toHaveBeenCalledTimes(1));
    useChatStore.getState().addAttachments([{
      id: "later", kind: "text", name: "later.txt", mediaType: "text/plain", bytes: 5, text: "later",
    }]);
    saving.resolve();
    await first;
    expect(mocks.chatStart).toHaveBeenCalledTimes(1);
    expect(mocks.chatStart.mock.calls[0][2]).toBe("first");
    expect(useChatStore.getState().pendingAttachments.map((item) => item.id)).toEqual(["later"]);
  });

  it("keeps the latest rapid chat selection when an older read finishes last", async () => {
    const older = deferred<ChatDetail>();
    const a = summary("a");
    const b = summary("b");
    useChatStore.setState({ current: detail(summary("initial")), summaries: [a, b] });
    mocks.chatGet.mockImplementationOnce(() => older.promise).mockResolvedValueOnce(detail(b));
    const first = useChatStore.getState().selectChat("a");
    await useChatStore.getState().selectChat("b");
    older.resolve(detail(a));
    await first;
    expect(useChatStore.getState().current!.summary.id).toBe("b");
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ active_chat_id: "b" });
  });

  it("does not restore an older selection after delayed attachment hydration", async () => {
    const bytes = deferred<number[]>();
    const a = detail(summary("images"));
    a.messages = [{ id: "image-message", sort_order: 0, role: "user", content: "image", thinking: null,
      model: null, prompt_tokens: null, completion_tokens: null, citations: [], mcp_calls: [],
      attachments: [{ id: "image", kind: "image", name: "test.png", media_type: "image/png", bytes: 3,
        path: "/tmp/test.png", width: null, height: null }], created_at: "now" }];
    const b = detail(summary("text"));
    mocks.chatGet.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    mocks.attachmentRead.mockImplementationOnce(() => bytes.promise);
    const first = useChatStore.getState().selectChat(a.summary.id);
    await waitFor(() => expect(mocks.attachmentRead).toHaveBeenCalledTimes(1));
    await useChatStore.getState().selectChat(b.summary.id);
    bytes.resolve([1, 2, 3]);
    await first;
    expect(useChatStore.getState().current!.summary.id).toBe(b.summary.id);
  });

  it("orders remembered-selection writes so a slow earlier save cannot become the final preference", async () => {
    const save = deferred<void>();
    const a = detail(summary("a"));
    const b = detail(summary("b"));
    mocks.chatGet.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    mocks.saveSettings.mockImplementationOnce(() => save.promise);
    const first = useChatStore.getState().selectChat("a");
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    const second = useChatStore.getState().selectChat("b");
    await waitFor(() => expect(useChatStore.getState().current!.summary.id).toBe("b"));
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    save.resolve();
    await Promise.all([first, second]);
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ active_chat_id: "b" });
  });

  it.each(["select", "create"] as const)("does not let a delayed %s abandon a request started in the current chat", async (operation) => {
    const active = summary("current", false, 1);
    const read = deferred<ChatDetail>();
    const save = deferred<void>();
    const provider = deferred<ChatMessage[]>();
    useChatStore.setState({ current: detail(active), summaries: [active] });
    mocks.chatStart.mockImplementationOnce((...args: unknown[]) => {
      (args[7] as (event: StreamEvent) => void)({ type: "Delta", content: "Current response" });
      return provider.promise;
    });
    if (operation === "select") mocks.chatGet.mockImplementationOnce(() => read.promise);
    else mocks.chatSave.mockImplementationOnce(() => save.promise);
    const selection = operation === "select" ? useChatStore.getState().selectChat("other") : useChatStore.getState().createChat();
    if (operation === "create") await waitFor(() => expect(mocks.chatSave).toHaveBeenCalledTimes(1));
    const run = useChatStore.getState().send("continue here");
    await waitFor(() => expect(mocks.chatStart).toHaveBeenCalledTimes(1));
    const requestId = useChatStore.getState().stream.requestId;
    read.resolve(detail(summary("other")));
    save.resolve();
    await selection;
    expect(useChatStore.getState().current!.summary.id).toBe("current");
    expect(useChatStore.getState().stream.requestId).toBe(requestId);
    expect(useChatStore.getState().stream.content).toBe("Current response");
    provider.resolve([]);
    await run;
  });

  it("keeps a newly selected chat when an earlier delete finishes", async () => {
    const deletion = deferred<void>();
    const a = summary("delete-me");
    const b = summary("keep-me");
    useChatStore.setState({ current: detail(a), summaries: [a, b] });
    mocks.chatDelete.mockImplementationOnce(() => deletion.promise);
    mocks.chatGet.mockResolvedValueOnce(detail(b));
    const deleting = useChatStore.getState().deleteChat(a.id);
    await useChatStore.getState().selectChat(b.id);
    deletion.resolve();
    await deleting;
    expect(useChatStore.getState().current!.summary.id).toBe(b.id);
    expect(mocks.chatGet).toHaveBeenCalledTimes(1);
  });

  it.each(["archive", "delete"] as const)("reserves %s before awaiting and keeps an unsent attachment retryable on failure", async (operation) => {
    const active = summary("mutating");
    const mutation = deferred<void>();
    const attachment = { id: "draft-file", kind: "text" as const, name: "draft.txt", mediaType: "text/plain", bytes: 5, text: "draft" };
    useChatStore.setState({ current: detail(active), summaries: [active], pendingAttachments: [attachment] });
    if (operation === "archive") mocks.chatSetArchived.mockImplementationOnce(() => mutation.promise);
    else mocks.chatDelete.mockImplementationOnce(() => mutation.promise);
    const changing = operation === "archive" ? useChatStore.getState().archive(true) : useChatStore.getState().deleteChat();
    expect(useChatStore.getState().mutatingChatIds).toEqual([active.id]);
    await useChatStore.getState().send("keep my draft");
    expect(mocks.chatStart).not.toHaveBeenCalled();
    expect(mocks.chatSave).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment]);
    mutation.reject(new Error("mutation failed"));
    await expect(changing).rejects.toThrow("mutation failed");
    expect(useChatStore.getState().mutatingChatIds).toEqual([]);
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment]);
    mocks.chatStart.mockResolvedValue([]);
    await useChatStore.getState().send("keep my draft");
    expect(mocks.chatStart.mock.calls[0][2]).toContain("draft");
  });

  it("preserves staged draft attachments when a successful deletion selects the next chat", async () => {
    const a = summary("delete-me");
    const b = summary("keep-me");
    const attachment = { id: "unsent", kind: "text" as const, name: "draft.txt", mediaType: "text/plain", bytes: 5, text: "draft" };
    useChatStore.setState({ current: detail(a), summaries: [a, b], pendingAttachments: [attachment] });
    mocks.chatGet.mockResolvedValueOnce(detail(b));
    await useChatStore.getState().deleteChat();
    expect(useChatStore.getState().current!.summary.id).toBe(b.id);
    expect(useChatStore.getState().pendingAttachments).toEqual([attachment]);
    expect(useChatStore.getState().mutatingChatIds).toEqual([]);
  });

  it("fences a cancelled preflight so its delayed save cannot start a provider or reset a retry", async () => {
    const active = summary("preflight-cancel", false, 0);
    const saving = deferred<void>();
    mocks.chatSave.mockImplementationOnce(() => saving.promise);
    mocks.chatStart.mockResolvedValue([]);
    useChatStore.setState({ current: detail(active), summaries: [active] });
    const first = useChatStore.getState().send("cancel this");
    await waitFor(() => expect(mocks.chatSave).toHaveBeenCalledTimes(1));
    await useChatStore.getState().stop();
    const second = useChatStore.getState().send("retry");
    saving.resolve();
    await Promise.all([first, second]);
    expect(mocks.chatStart).toHaveBeenCalledTimes(1);
    expect(mocks.chatStart.mock.calls[0][2]).toBe("retry");
    expect(useChatStore.getState().current!.messages[0].content).toBe("retry");
  });

  it.each(["resolve", "reject"] as const)("ignores a superseded provider's late %s and keeps an Error busy until settlement", async (completion) => {
    const active = summary("old", false, 0);
    const old = deferred<ChatMessage[]>();
    const fresh = deferred<ChatMessage[]>();
    let oldEvent!: (event: StreamEvent) => void;
    mocks.chatStart.mockImplementationOnce((...args: unknown[]) => {
      oldEvent = args[7] as (event: StreamEvent) => void;
      return old.promise;
    }).mockImplementationOnce((...args: unknown[]) => {
      (args[7] as (event: StreamEvent) => void)({ type: "Delta", content: "New answer" });
      return fresh.promise;
    });
    useChatStore.setState({ current: detail(active), summaries: [active] });
    const oldRun = useChatStore.getState().send("old request");
    await waitFor(() => expect(mocks.chatStart).toHaveBeenCalledTimes(1));
    oldEvent({ type: "Error", message: "old failed" });
    await useChatStore.getState().send("premature retry");
    expect(mocks.chatStart).toHaveBeenCalledTimes(1);
    // Recovery/reinitialization can replace the whole selected conversation.
    const newer = summary("new", false, 0);
    useChatStore.setState({ current: detail(newer), summaries: [newer], stream: idleStream() });
    const newRun = useChatStore.getState().send("new request");
    await waitFor(() => expect(mocks.chatStart).toHaveBeenCalledTimes(2));
    const newRequestId = useChatStore.getState().stream.requestId;
    if (completion === "reject") old.reject(new Error("late old rejection"));
    else old.resolve([]);
    await oldRun;
    expect(useChatStore.getState().stream.requestId).toBe(newRequestId);
    expect(useChatStore.getState().stream.content).toBe("New answer");
    expect(useChatStore.getState().stream.lastError).toBeNull();
    fresh.resolve([]);
    await newRun;
    expect(useChatStore.getState().current!.summary.id).toBe("new");
    expect(useChatStore.getState().current!.messages[1].content).toBe("New answer");
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

  it("snapshots current MCP defaults only when a new Chat thread is created", async () => {
    useAppStore.setState({
      mcpServers: [
        createMockMcpServer("default"),
        createMockMcpServer("optional", { defaultForNewChats: false }),
      ],
    });
    mocks.chatList.mockResolvedValue([]);

    await useChatStore.getState().initialize("chat", null);

    expect(useChatStore.getState().current?.mcp_selection).toEqual({
      server_ids: ["default"],
      disabled_tools: {},
    });
    expect((mocks.chatSave.mock.calls[0]?.[0] as ChatSaveInput).mcp_selection.server_ids)
      .toEqual(["default"]);

    useAppStore.setState({ mcpServers: [createMockMcpServer("new-default")] });
    expect(useChatStore.getState().current?.mcp_selection.server_ids).toEqual(["default"]);
  });

  it("persists per-chat MCP changes and disconnects removed servers", async () => {
    const active = detail(summary("active"));
    active.mcp_selection = {
      server_ids: ["one", "two"],
      disabled_tools: { two: ["write"] },
    };
    useChatStore.setState({ current: active, summaries: [active.summary] });

    await useChatStore.getState().setMcpSelection({
      server_ids: ["two", "two"],
      disabled_tools: { two: ["read", "read"], one: ["old"] },
    });

    expect(useChatStore.getState().current?.mcp_selection).toEqual({
      server_ids: ["two"],
      disabled_tools: { two: ["read"] },
    });
    expect(mocks.mcpDisconnect).toHaveBeenCalledWith("active", "one");
    expect((mocks.chatSave.mock.calls[mocks.chatSave.mock.calls.length - 1]?.[0] as ChatSaveInput).mcp_selection)
      .toEqual({ server_ids: ["two"], disabled_tools: { two: ["read"] } });
  });

  it("does not archive while a response is running", async () => {
    const active = summary("active");
    useChatStore.setState({
      current: detail(active),
      summaries: [active],
      stream: { ...idleStream(), status: "streaming", requestId: "request" },
    });

    await useChatStore.getState().archive(true);

    expect(mocks.chatSetArchived).not.toHaveBeenCalled();
    expect(useChatStore.getState().current?.summary.archived_at).toBeNull();
  });

  it("renames a chat selected from the sidebar without changing the current chat", async () => {
    const current = summary("current");
    const other = summary("other");
    mocks.chatUpdateTitle.mockResolvedValue(true);
    useChatStore.setState({ current: detail(current), summaries: [current, other] });

    await useChatStore.getState().rename("Manual title", other.id);

    expect(mocks.chatUpdateTitle).toHaveBeenCalledWith(other.id, "Manual title", "manual");
    expect(useChatStore.getState().current?.summary.id).toBe(current.id);
    expect(useChatStore.getState().summaries.find((chat) => chat.id === other.id)).toMatchObject({
      title: "Manual title",
      title_source: "manual",
    });
  });

  it("deletes a non-current chat without changing the current chat", async () => {
    const current = summary("current");
    const other = summary("other");
    useChatStore.setState({ current: detail(current), summaries: [current, other] });

    await useChatStore.getState().deleteChat(other.id);

    expect(mocks.chatDelete).toHaveBeenCalledWith(other.id);
    expect(useChatStore.getState().current?.summary.id).toBe(current.id);
    expect(useChatStore.getState().summaries).toEqual([current]);
  });

  it("lets an explicit regeneration replace a manual title safely", async () => {
    const manual = { ...summary("manual"), title: "My title", title_source: "manual" as const, message_count: 2 };
    const conversation = detail(manual);
    conversation.messages = [
      {
        id: "question",
        sort_order: 0,
        role: "user",
        content: "How does MTP work?",
        thinking: null,
        model: null,
        prompt_tokens: null,
        completion_tokens: null,
        citations: [],
        mcp_calls: [],
        attachments: [],
        created_at: manual.created_at,
      },
      {
        id: "answer",
        sort_order: 1,
        role: "assistant",
        content: "It drafts multiple tokens.",
        thinking: null,
        model: "Chat Test",
        prompt_tokens: 4,
        completion_tokens: 5,
        citations: [],
        mcp_calls: [],
        attachments: [],
        created_at: manual.updated_at,
      },
    ];
    mocks.chatUpdateTitle.mockResolvedValue(true);
    useChatStore.setState({ current: conversation, summaries: [manual] });

    await useChatStore.getState().regenerateTitle(manual.id, true);

    expect(mocks.aiNameChat).toHaveBeenCalledWith(
      expect.stringMatching(/^name-chat-/),
      "How does MTP work?",
      "It drafts multiple tokens.",
      "My title",
    );
    expect(mocks.chatUpdateTitle).toHaveBeenCalledWith(
      manual.id,
      "Generated title",
      "generated",
      "My title",
      true,
    );
    expect(useChatStore.getState().current?.summary).toMatchObject({
      title: "Generated title",
      title_source: "generated",
    });
  });

  it("uses the latest completed turn when explicitly regenerating a title", async () => {
    const generated = { ...summary("generated"), title: "Old topic", title_source: "generated" as const, message_count: 4 };
    const conversation = detail(generated);
    conversation.messages = [
      {
        id: "question-1",
        sort_order: 0,
        role: "user",
        content: "What is the original topic?",
        thinking: null,
        model: null,
        prompt_tokens: null,
        completion_tokens: null,
        citations: [],
        mcp_calls: [],
        attachments: [],
        created_at: generated.created_at,
      },
      {
        id: "answer-1",
        sort_order: 1,
        role: "assistant",
        content: "The original topic is setup.",
        thinking: null,
        model: "Chat Test",
        prompt_tokens: 4,
        completion_tokens: 5,
        citations: [],
        mcp_calls: [],
        attachments: [],
        created_at: generated.created_at,
      },
      {
        id: "question-2",
        sort_order: 2,
        role: "user",
        content: "How should MTP fallback work?",
        thinking: null,
        model: null,
        prompt_tokens: null,
        completion_tokens: null,
        citations: [],
        mcp_calls: [],
        attachments: [],
        created_at: generated.updated_at,
      },
      {
        id: "answer-2",
        sort_order: 3,
        role: "assistant",
        content: "Continue with standard decoding.",
        thinking: null,
        model: "Chat Test",
        prompt_tokens: 5,
        completion_tokens: 6,
        citations: [],
        mcp_calls: [],
        attachments: [],
        created_at: generated.updated_at,
      },
    ];
    mocks.chatUpdateTitle.mockResolvedValue(true);
    useChatStore.setState({ current: conversation, summaries: [generated] });

    await useChatStore.getState().regenerateTitle(generated.id, true);

    expect(mocks.aiNameChat).toHaveBeenCalledWith(
      expect.stringMatching(/^name-chat-/),
      "How should MTP fallback work?",
      "Continue with standard decoding.",
      "Old topic",
    );
  });

  it("does not let automatic naming replace a manual title", async () => {
    const manual = { ...summary("manual"), title: "My title", title_source: "manual" as const };
    useChatStore.setState({ current: detail(manual), summaries: [manual] });

    await useChatStore.getState().regenerateTitle(manual.id);

    expect(mocks.aiNameChat).not.toHaveBeenCalled();
    expect(mocks.chatUpdateTitle).not.toHaveBeenCalled();
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
      conversationId: string,
      _prompt: string,
      _history: ChatMessage[],
      _images: unknown[],
      _buckets: unknown[],
      mcpSelection: unknown,
      onEvent: (event: StreamEvent) => void,
    ) => {
      expect(conversationId).toBe("active");
      expect(mcpSelection).toEqual({ server_ids: [], disabled_tools: {} });
      expect(mocks.chatSave).toHaveBeenCalledTimes(1);
      onEvent({ type: "Started", request_id: "request", model: "Chat Test" });
      onEvent({
        type: "McpToolProposal",
        approval_id: "mcp-approval",
        server_id: "calendar",
        server_name: "Calendar MCP",
        tool_name: "list_events",
        title: "List events",
        description: "Lists upcoming events",
        arguments: { limit: 5 },
        schema_hash: "schema-a",
      });
      onEvent({
        type: "McpToolStarted",
        approval_id: "mcp-approval",
        server_id: "calendar",
        server_name: "Calendar MCP",
        tool_name: "list_events",
        arguments: { limit: 5 },
      });
      onEvent({
        type: "McpToolResult",
        approval_id: "mcp-approval",
        server_id: "calendar",
        server_name: "Calendar MCP",
        tool_name: "list_events",
        result: {
          content: [{ type: "text", text: "No events" }],
          structured_content: { events: [] },
          is_error: false,
          model_text: "No events",
          truncated: false,
        },
      });
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
      mcp_calls: [{
        approval_id: "mcp-approval",
        server_id: "calendar",
        tool_name: "list_events",
        status: "done",
      }],
    });
    expect(final.model_transcript).toBe(transcript);
    expect(useChatStore.getState().stream.status).toBe("idle");
  });

  it.each(["done", "error", "cancelled", "interrupted"] as const)("persists native activity as %s and streams text before the provider completes", async (status) => {
    const active = summary("activity", false, 0);
    useChatStore.setState({ current: detail(active), summaries: [active] });
    mocks.chatStart.mockImplementation(async (...args: unknown[]) => {
      const onEvent = args[7] as (event: StreamEvent) => void;
      onEvent({ type: "Activity", activity: { id: "native-1", kind: "web_search", status: "running" } });
      onEvent({ type: "Delta", content: "First words" });
      expect(useChatStore.getState().stream.content).toBe("First words");
      expect(useChatStore.getState().stream.status).toBe("streaming");
      expect(useChatStore.getState().stream.activities[0].status).toBe("running");
      if (status === "done") onEvent({ type: "Activity", activity: { id: "native-1", kind: "web_search", status: "done" } });
      if (status === "cancelled") onEvent({ type: "Cancelled" });
      if (status === "error") throw new Error("provider failed");
      return [];
    });
    await useChatStore.getState().send("search");
    const response = useChatStore.getState().current!.messages[1];
    expect(response.activities).toEqual([{ id: "native-1", kind: "web_search", status }]);
    expect(response.content).toBe("First words");
    const saved = mocks.chatSave.mock.calls[mocks.chatSave.mock.calls.length - 1][0] as ChatSaveInput;
    expect(saved.messages[1].activities).toEqual(response.activities);
  });
});
