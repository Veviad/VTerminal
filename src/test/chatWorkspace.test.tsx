import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace, isNearChatBottom } from "../components/chat/ChatWorkspace";
import type { ChatDetail } from "../lib/types";
import * as api from "../lib/tauri";
import { useAppStore } from "../stores/appStore";
import { useChatStore, idleStream } from "../stores/chatStore";
import { createMockMcpServer } from "./mcpTestUtils";

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
    mcp_calls: [],
    attachments: [],
    created_at: "2026-08-23T10:00:00Z",
  }],
  model_transcript: [],
  model_transcript_version: 1,
  attached_bucket_refs: [],
  mcp_selection: { server_ids: [], disabled_tools: {} },
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
      stream: { ...idleStream(), status: "streaming", requestId: "request-a" },
      pendingAttachments: [],
      mutatingChatIds: [],
      attachError: null,
      attachStatus: null,
      knowledgeWarning: null,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("preserves composer text while deletion or initial loading has no selected chat", () => {
    useChatStore.setState({ stream: idleStream() });
    render(<ChatWorkspace />);
    const composer = screen.getByPlaceholderText("Message VTerminal Chat…");
    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    act(() => useChatStore.setState({ current: null }));
    expect(composer).toBeDisabled();
    expect(screen.getByTitle("Send")).toBeDisabled();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer).toHaveValue("Keep this draft");
    act(() => useChatStore.setState({ current: detail }));
    expect(composer).not.toBeDisabled();
    expect(composer).toHaveValue("Keep this draft");
  });

  it("keeps composer text and staged files while a destructive metadata change blocks Send", () => {
    render(<ChatWorkspace />);
    const composer = screen.getByPlaceholderText("Message VTerminal Chat…");
    act(() => useChatStore.setState({ stream: idleStream() }));
    fireEvent.change(composer, { target: { value: "Unsent draft" } });
    act(() => useChatStore.setState({ mutatingChatIds: [detail.summary.id], pendingAttachments: [{
      id: "pending", kind: "text", name: "draft.txt", mediaType: "text/plain", bytes: 5, text: "draft",
    }] }));
    expect(composer).toBeDisabled();
    expect(screen.getByTitle("Send")).toBeDisabled();
    fireEvent.click(screen.getByTitle("Send"));
    expect(composer).toHaveValue("Unsent draft");
    expect(screen.getByText("draft.txt")).toBeVisible();
    act(() => useChatStore.setState({ mutatingChatIds: [] }));
    expect(composer).not.toBeDisabled();
    expect(composer).toHaveValue("Unsent draft");
  });

  it("keeps a failed request busy until the provider settles instead of accepting an overlapping send", () => {
    useChatStore.setState((state) => ({ stream: { ...state.stream, status: "error", lastError: "Provider failed" } }));
    render(<ChatWorkspace />);
    expect(screen.getByTitle("Stop response")).toBeVisible();
    expect(screen.queryByTitle("Send")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chat list actions for Autoscroll test" }));
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
  });

  it("shows the actual running tool without a misleading thinking placeholder", () => {
    useChatStore.setState((state) => ({ stream: { ...state.stream, mcpCalls: [{
      approval_id: "mcp", server_id: "server", server_name: "Test MCP", tool_name: "read_items",
      arguments: { token: "PRIVATE-ARGUMENT" }, status: "running",
    }] } }));
    render(<ChatWorkspace />);
    expect(screen.getByText("Test MCP · read_items")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE-ARGUMENT/)).not.toBeInTheDocument();
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

  it.each([
    { label: "finish/summary", outer: "<finish>", inner: "<summary>", close: "</summary> </finish>" },
    { label: "invoke/parameter", outer: '<invoke name="finish">', inner: '<parameter name="summary">', close: "</parameter> </invoke>" },
  ])("cleans live and saved $label wrappers while preserving user markup literally", ({ outer, inner, close }) => {
    const envelope = (body: string) => `${outer} ${inner} ${body}\n${close}`;
    const withSavedAnswer: ChatDetail = {
      ...detail,
      summary: { ...detail.summary, message_count: 2 },
      messages: [
        { ...detail.messages[0], content: envelope("User literal") },
        {
          id: "answer-a",
          sort_order: 1,
          role: "assistant",
          content: envelope("Saved assistant"),
          thinking: null,
          model: "Chat Test",
          prompt_tokens: 1,
          completion_tokens: 1,
          citations: [],
          mcp_calls: [],
          attachments: [],
          created_at: "2026-08-23T10:01:00Z",
        },
      ],
    };
    useChatStore.setState((state) => ({
      current: withSavedAnswer,
      summaries: [withSavedAnswer.summary],
      stream: { ...state.stream, content: envelope("Live assistant") },
    }));

    const { container } = render(<ChatWorkspace />);
    const articles = screen.getAllByRole("article");

    expect(articles[0]).toHaveTextContent(outer);
    expect(articles[0]).toHaveTextContent("User literal");
    expect(articles[1]).not.toHaveTextContent(outer);
    expect(articles[1]).toHaveTextContent("Saved assistant");
    expect(screen.getByText("Live assistant")).toBeVisible();
    expect(container.textContent?.split(outer)).toHaveLength(2);
    expect(container.textContent?.split(inner)).toHaveLength(2);
  });

  it("does not pull a reader back to the bottom while tokens stream", async () => {
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
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: "auto" }));
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

  it.each(["response", "metadata change"] as const)("closes and disables Knowledge selection during a %s", (operation) => {
    useAppStore.setState({ docsEnabled: true });
    useChatStore.setState({ stream: idleStream() });
    render(<ChatWorkspace />);
    const picker = screen.getByRole("button", { name: "Knowledge" });
    fireEvent.click(picker);
    expect(screen.getByRole("menu", { name: "Knowledge sources" })).toBeInTheDocument();

    act(() => useChatStore.setState(operation === "response"
      ? { stream: { ...idleStream(), status: "streaming", requestId: "running" } }
      : { mutatingChatIds: [detail.summary.id] }));

    expect(picker).toBeDisabled();
    expect(screen.queryByRole("menu", { name: "Knowledge sources" })).not.toBeInTheDocument();
    act(() => useChatStore.setState({ stream: idleStream(), mutatingChatIds: [] }));
    expect(picker).not.toBeDisabled();
  });

  it("shows the current Chat thread's MCP selection in the toolbar", async () => {
    useAppStore.setState({
      mcpServers: [createMockMcpServer("calendar", { name: "Calendar MCP" })],
    });
    useChatStore.setState((state) => ({
      current: state.current
        ? {
            ...state.current,
            mcp_selection: { server_ids: ["calendar"], disabled_tools: {} },
          }
        : null,
      stream: { ...state.stream, status: "idle", requestId: null },
    }));
    vi.spyOn(api, "mcpToolsList").mockResolvedValue([]);

    render(<ChatWorkspace />);

    const picker = screen.getByTitle("Select MCP servers and tools for this chat");
    expect(picker).toHaveTextContent("MCP 1");
    fireEvent.click(picker);
    expect(await screen.findByText("Calendar MCP")).toBeInTheDocument();
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
          mcp_calls: [],
          attachments: [],
          created_at: "2026-08-23T10:01:00Z",
        },
      ],
    };
    useChatStore.setState({
      summaries: [completed.summary],
      current: completed,
      stream: idleStream(),
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
