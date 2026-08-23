import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDetail, ChatSummary } from "../lib/types";

const mocks = vi.hoisted(() => ({
  chatList: vi.fn(),
  chatGet: vi.fn(),
  chatSave: vi.fn(),
  chatSetArchived: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  ...mocks,
  attachmentRead: vi.fn(),
  knowledgeBucketsList: vi.fn(async () => []),
  chatUpdateTitle: vi.fn(),
  chatDelete: vi.fn(),
  aiCancel: vi.fn(),
  chatStart: vi.fn(),
  aiNameChat: vi.fn(),
  knowledgeSearchDetailed: vi.fn(),
  attachmentPut: vi.fn(),
  visionDescribe: vi.fn(),
}));

import { useChatStore } from "../stores/chatStore";

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

describe("Chat workspace store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatSave.mockResolvedValue(undefined);
    mocks.chatSetArchived.mockResolvedValue(undefined);
    mocks.saveSettings.mockResolvedValue(undefined);
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
});
