import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace, isNearChatBottom } from "../components/chat/ChatWorkspace";
import type { ChatDetail } from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const detail: ChatDetail = {
  summary: {
    id: "chat-a",
    title: "Autoscroll test",
    title_source: "fallback",
    created_at: "2026-08-23T10:00:00Z",
    updated_at: "2026-08-23T10:00:00Z",
    archived_at: null,
    message_count: 1,
    first_prompt: "Question",
  },
  messages: [{
    id: "message-a",
    sort_order: 0,
    role: "user",
    content: "Question",
    thinking: null,
    model: null,
    prompt_tokens: null,
    completion_tokens: null,
    citations: [],
    attachments: [],
    created_at: "2026-08-23T10:00:00Z",
  }],
  model_transcript: [],
  model_transcript_version: 1,
  attached_bucket_refs: [],
};

describe("Chat workspace autoscroll", () => {
  beforeEach(() => {
    Element.prototype.scrollTo = vi.fn();
    useAppStore.setState({
      catalog: [],
      activeModelId: "local/none",
      docsEnabled: false,
      aiWebAccess: false,
      modelEffort: {},
    });
    useChatStore.setState({
      summaries: [detail.summary],
      current: detail,
      stream: {
        status: "streaming",
        requestId: "request-a",
        content: "",
        thinking: "",
        model: null,
        citations: [],
        lastError: null,
      },
      pendingAttachments: [],
      attachError: null,
      attachStatus: null,
      knowledgeWarning: null,
    });
  });

  it("classifies only viewports within the bottom threshold as sticky", () => {
    expect(isNearChatBottom({ scrollHeight: 1_000, clientHeight: 300, scrollTop: 652 })).toBe(true);
    expect(isNearChatBottom({ scrollHeight: 1_000, clientHeight: 300, scrollTop: 600 })).toBe(false);
  });

  it("renders while chat initialization has not selected a current chat yet", () => {
    useChatStore.setState({
      initialized: false,
      summaries: [],
      current: null,
    });

    expect(() => render(<ChatWorkspace />)).not.toThrow();
    expect(screen.getByRole("heading", { name: "Start a chat" })).toBeInTheDocument();
  });

  it("does not pull a reader back to the bottom while tokens stream", () => {
    render(<ChatWorkspace />);
    const timeline = screen.getByTestId("chat-timeline");
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    const scrollTo = Element.prototype.scrollTo as ReturnType<typeof vi.fn>;
    scrollTo.mockClear();

    fireEvent.scroll(timeline);
    act(() => {
      useChatStore.setState((state) => ({
        stream: { ...state.stream, content: "First token" },
      }));
    });
    expect(scrollTo).not.toHaveBeenCalled();

    timeline.scrollTop = 660;
    fireEvent.scroll(timeline);
    act(() => {
      useChatStore.setState((state) => ({
        stream: { ...state.stream, content: "First token, second token" },
      }));
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "auto" });
  });
});
