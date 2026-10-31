import { Profiler, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));

import { StatusBar } from "../components/layout/StatusBar";
import { TerminalSection } from "../components/settings/TerminalSection";
import { AgentSection } from "../components/settings/AgentSection";
import { InstructionsSection } from "../components/settings/InstructionsSection";
import { emptyAiStream, emptySessionUi, useAppStore } from "../stores/appStore";
import { makeSession } from "./factories";
import { idleStream, useChatStore } from "../stores/chatStore";

function countRenders(children: ReactNode) {
  const rendered = vi.fn();
  render(<Profiler id="surface" onRender={rendered}>{children}</Profiler>);
  rendered.mockClear();
  return rendered;
}

function streamAgentTokens() {
  // Separate arrivals reproduce native IPC events rather than one React batch.
  for (let i = 0; i < 100; i++) {
    act(() => useAppStore.getState().appendAiDelta("terminal", "token "));
  }
}

beforeEach(() => {
  useAppStore.setState({
    sessions: [makeSession({ id: "terminal" })],
    activeSessionId: "terminal",
    sessionUi: { terminal: emptySessionUi() },
    aiStreams: { terminal: { ...emptyAiStream(), status: "streaming", requestId: "run" } },
  });
  useChatStore.setState({ workspaceMode: "terminal", current: null, stream: idleStream() });
});

afterEach(cleanup);

describe("application surfaces during streaming", () => {
  it.each([
    ["terminal settings", TerminalSection],
    ["agent settings", AgentSection],
    ["instruction editors", InstructionsSection],
  ] as const)("does not rerender %s for agent tokens", (_name, Component) => {
    const rendered = countRenders(<Component />);
    streamAgentTokens();
    expect(rendered).not.toHaveBeenCalled();
  });

  it("does not rerender terminal status for token text or inactive chat tokens", () => {
    const rendered = countRenders(<StatusBar />);
    streamAgentTokens();
    for (let i = 0; i < 100; i++) {
      act(() => useChatStore.setState((state) => ({ stream: { ...state.stream, content: `${state.stream.content}token ` } })));
    }
    expect(rendered).not.toHaveBeenCalled();
    act(() => useAppStore.getState().updateSessionUi("terminal", { gitBranch: "current-branch" }));
    expect(screen.getByText("current-branch")).toBeInTheDocument();
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("updates chat status settings without rerendering for text or background terminal output", () => {
    useChatStore.setState({ workspaceMode: "chat", stream: { ...idleStream(), status: "streaming" } });
    useAppStore.setState({ aiWebAccess: false });
    const rendered = countRenders(<StatusBar />);
    for (let i = 0; i < 100; i++) {
      act(() => useChatStore.setState((state) => ({ stream: { ...state.stream, content: `${state.stream.content}token ` } })));
      act(() => useAppStore.getState().updateSessionUi("terminal", { gitBranch: `background-${i}` }));
    }
    expect(rendered).not.toHaveBeenCalled();
    expect(screen.getByText("web off")).toBeInTheDocument();
    act(() => useAppStore.setState({ aiWebAccess: true }));
    expect(screen.queryByText("web off")).not.toBeInTheDocument();
  });
});
