import { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AiPanel } from "../components/ai/AiPanel";
import { ChatWorkspace } from "../components/chat/ChatWorkspace";
import { emptyAiStream, useAppStore } from "../stores/appStore";
import { idleStream, useChatStore } from "../stores/chatStore";
import type { ChatDetail } from "../lib/types";

const markdownRenders = vi.hoisted(() => vi.fn());
const toolbarCommits = vi.hoisted(() => vi.fn());
vi.mock("../components/layout/GenerationModeBadge", () => ({
  GenerationModeBadge: () => <Profiler id="toolbar" onRender={toolbarCommits}><span>Generation mode</span></Profiler>,
}));
// Count parsing requests at the actual markdown boundary without making the
// regression depend on wall-clock timing or the syntax highlighter's machine.
vi.mock("react-markdown", () => ({ default: ({ children }: { children: string }) => {
  markdownRenders(children);
  return <span>{children}</span>;
} }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

beforeEach(() => {
  markdownRenders.mockClear();
  Element.prototype.scrollTo = vi.fn();
  useAppStore.setState({
    settingsLoaded: true, aiPanelOpen: true,
    sessions: ["s", "visible", "background"].map((id) => ({
      id, shell: "/bin/zsh", cwd: null, createdAt: "now", exited: false, exitCode: null,
      hostId: null, hostLabel: null, userTitle: null, aiTitle: null, ordinal: 1,
    })), sessionUi: {},
    aiStreams: {}, sidecars: {}, catalog: [], activeModelId: "cloud/test",
    defaultAiMode: "ask", lastAiMode: "ask", modelEffort: {}, docsEnabled: false,
  });
});

it("does not reparse completed Agent answers for each new streamed chunk", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `past-${index}`, role: "assistant" as const, content: `Past answer ${index}`,
    createdAt: "now",
  }));
  useAppStore.setState({ aiStreams: { s: {
    ...emptyAiStream(), requestId: "r", status: "streaming", messages,
  } } });
  render(<AiPanel sessionId="s" />);
  for (let index = 0; index < 50; index++) {
    act(() => useAppStore.getState().appendAiDelta("s", ` ${index}`));
  }
  const pastParses = markdownRenders.mock.calls.filter(([content]) => String(content).startsWith("Past answer"));
  expect(pastParses).toHaveLength(20);
  expect(screen.getByText(/0 1 2 3 4/)).toBeVisible();
});

it("does not reparse completed Chat answers for each new streamed chunk", () => {
  const detail: ChatDetail = {
    summary: { id: "chat", title: "History", title_source: "manual", created_at: "now", updated_at: "now",
      archived_at: null, message_count: 20, first_prompt: "Question" },
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `past-${index}`, sort_order: index, role: "assistant", content: `Past answer ${index}`,
      thinking: null, model: null, prompt_tokens: null, completion_tokens: null,
      citations: [], mcp_calls: [], attachments: [], created_at: "now",
    })),
    model_transcript: [], model_transcript_version: 1, attached_bucket_refs: [],
    mcp_selection: { server_ids: [], disabled_tools: {} },
  };
  useChatStore.setState({ current: detail, summaries: [detail.summary], pendingAttachments: [], mutatingChatIds: [],
    stream: { ...idleStream(), requestId: "r", status: "streaming" } });
  render(<ChatWorkspace />);
  for (let index = 0; index < 50; index++) {
    act(() => useChatStore.setState((state) => ({ stream: { ...state.stream, content: `${state.stream.content} ${index}` } })));
  }
  const pastParses = markdownRenders.mock.calls.filter(([content]) => String(content).startsWith("Past answer"));
  expect(pastParses).toHaveLength(20);
  expect(screen.getByText(/0 1 2 3 4/)).toBeVisible();
});

it("does not rerender the visible panel for text from a different Agent", () => {
  useAppStore.setState({ aiStreams: {
    visible: { ...emptyAiStream(), messages: [{ id: "answer", role: "assistant", content: "Visible answer", createdAt: "now" }] },
    background: { ...emptyAiStream(), requestId: "background-request", status: "streaming" },
  } });
  const commits = vi.fn();
  render(<Profiler id="panel" onRender={commits}><AiPanel sessionId="visible" /></Profiler>);
  commits.mockClear();
  for (let index = 0; index < 50; index++) {
    act(() => useAppStore.getState().appendAiDelta("background", " text"));
  }
  expect(commits).not.toHaveBeenCalled();
});


it("keeps unchanged toolbar work out of composer edits and foreground/background text streams", () => {
  const detail: ChatDetail = {
    summary: { id: "toolbar-chat", title: "Toolbar", title_source: "manual", created_at: "now", updated_at: "now",
      archived_at: null, message_count: 0, first_prompt: null },
    messages: [], model_transcript: [], model_transcript_version: 1, attached_bucket_refs: [],
    mcp_selection: { server_ids: [], disabled_tools: {} },
  };
  useAppStore.setState({ aiWebAccess: true, aiStreams: { background: { ...emptyAiStream(), status: "streaming", requestId: "background" } } });
  useChatStore.setState({ current: detail, summaries: [detail.summary], pendingAttachments: [], mutatingChatIds: [], stream: idleStream() });
  render(<ChatWorkspace />);
  toolbarCommits.mockClear();
  fireEvent.change(screen.getByPlaceholderText("Message VTerminal Chat…"), { target: { value: "Draft" } });
  expect(toolbarCommits).not.toHaveBeenCalled();
  act(() => useChatStore.setState({ stream: { ...idleStream(), requestId: "chat-request", status: "streaming" } }));
  toolbarCommits.mockClear();
  for (let index = 0; index < 25; index++) {
    act(() => {
      useChatStore.setState((state) => ({ stream: { ...state.stream, content: `${state.stream.content} text` } }));
      useAppStore.getState().appendAiDelta("background", " text");
    });
  }
  expect(toolbarCommits).not.toHaveBeenCalled();
  // Displayed provider state still refreshes immediately.
  act(() => useChatStore.setState((state) => ({ stream: { ...state.stream, lastError: "web search disabled by organization" } })));
  expect(screen.getByText("Web unavailable for provider")).toBeVisible();
  expect(toolbarCommits).toHaveBeenCalledTimes(1);
});
