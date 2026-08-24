import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace, isNearChatBottom } from "../components/chat/ChatWorkspace";
import type { ChatDetail } from "../lib/types";
import * as api from "../lib/tauri";
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

  afterEach(() => vi.restoreAllMocks());

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

  it("refreshes a local generation fallback while the response is streaming", async () => {
    useAppStore.setState({
      activeModelId: "local/qwen-test",
      loadedModelId: "local/qwen-test",
      modelState: "ready",
      localAcceleration: {
        backend: "metal",
        device_name: "Apple GPU",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "mtp",
        generation_fallback_reason: null,
      },
    });
    vi.spyOn(api, "modelStatus").mockResolvedValue({
      loaded: "local/qwen-test",
      state: "ready",
      available: true,
      acceleration: {
        backend: "metal",
        device_name: "Apple GPU",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "standard",
        generation_fallback_reason: "MTP speculative operation failed",
      },
    });

    render(<ChatWorkspace />);

    await waitFor(() => {
      expect(useAppStore.getState().localAcceleration?.generation_mode).toBe("standard");
    });
    expect(api.modelStatus).toHaveBeenCalled();
  });

  it("dismisses the Knowledge source menu on an outside pointer press", () => {
    useAppStore.setState({
      docsEnabled: true,
      knowledgeBuckets: [{
        ref: { source: "local", bucket_id: "handbook" },
        label: "Engineering handbook",
        connection_label: null,
        profile: null,
        compatibility: "managed_compatible",
        compatibility_reason: null,
        attachable: true,
        writable: true,
        manageable: true,
        file_count: 1,
        chunk_count: 12,
        pending_count: 0,
        stale: false,
        error: null,
      }],
    });
    useChatStore.setState((state) => ({
      stream: { ...state.stream, status: "idle", requestId: null },
    }));
    render(<ChatWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(screen.getByRole("menu", { name: "Knowledge sources" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("chat-timeline"));
    expect(screen.queryByRole("menu", { name: "Knowledge sources" })).toBeNull();
  });

  it("opens a working rename dialog from the sidebar chat action menu", async () => {
    useChatStore.setState((state) => ({
      stream: { ...state.stream, status: "idle", requestId: null },
    }));
    const rename = vi.spyOn(useChatStore.getState(), "rename").mockResolvedValue(undefined);
    render(<ChatWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chat title" }), {
      target: { value: "A better chat title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(rename).toHaveBeenCalledWith("A better chat title", "chat-a"));
  });

  it("blocks renaming the active chat while a response is streaming", () => {
    render(<ChatWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
  });

  it("keeps the menu open and reports title regeneration failures", async () => {
    const completed: ChatDetail = {
      ...detail,
      summary: { ...detail.summary, message_count: 2 },
      messages: [
        ...detail.messages,
        {
          id: "answer-a",
          sort_order: 1,
          role: "assistant",
          content: "Answer",
          thinking: null,
          model: "Chat Test",
          prompt_tokens: 1,
          completion_tokens: 1,
          citations: [],
          attachments: [],
          created_at: "2026-08-23T10:01:00Z",
        },
      ],
    };
    useChatStore.setState({
      summaries: [completed.summary],
      current: completed,
      stream: {
        status: "idle",
        requestId: null,
        content: "",
        thinking: "",
        model: null,
        citations: [],
        lastError: null,
      },
    });
    let rejectRegeneration!: (reason: Error) => void;
    const regeneration = new Promise<void>((_resolve, reject) => {
      rejectRegeneration = reject;
    });
    const regenerate = vi.spyOn(useChatStore.getState(), "regenerateTitle")
      .mockReturnValue(regeneration);
    render(<ChatWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate title" }));

    expect(screen.getByRole("menuitem", { name: "Regenerating…" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    rejectRegeneration(new Error("The model repeated the current title."));
    expect(await screen.findByRole("alert")).toHaveTextContent("The model repeated the current title.");
    expect(regenerate).toHaveBeenCalledWith("chat-a", true);
    expect(screen.getByRole("menuitem", { name: "Regenerate title" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirms sidebar deletion in an in-app dialog", async () => {
    useChatStore.setState((state) => ({
      stream: { ...state.stream, status: "idle", requestId: null },
    }));
    const deleteChat = vi.spyOn(useChatStore.getState(), "deleteChat").mockResolvedValue(undefined);
    render(<ChatWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog", { name: "Delete chat?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteChat).toHaveBeenCalledWith("chat-a"));
  });
});
