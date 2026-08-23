import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SidecarBinding } from "../lib/sidecar";
import type { Session } from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

vi.mock("../components/layout/Header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("../components/layout/StatusBar", () => ({
  StatusBar: () => <footer data-testid="status-bar" />,
}));

vi.mock("../components/terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: string }) => (
    <div data-testid={`terminal-${sessionId}`} />
  ),
}));

vi.mock("../components/ai/AiPanel", () => ({
  AiPanel: ({ sessionId }: { sessionId: string | null }) => (
    <aside data-testid="ai-panel" data-session-id={sessionId ?? "none"} />
  ),
}));

vi.mock("../components/sidecar/SidecarWorkspace", () => ({
  SidecarWorkspace: ({ binding }: { binding: SidecarBinding }) => (
    <div
      data-testid="sidecar-workspace"
      data-owner-session-id={binding.ownerSessionId}
      data-focused-session-id={binding.focusedSessionId}
    />
  ),
}));

vi.mock("../components/chat/ChatWorkspace", () => ({
  ChatWorkspace: () => <section data-testid="chat-workspace" />,
}));

vi.mock("../components/palette/CommandPalette", () => ({
  CommandPalette: () => null,
}));

vi.mock("../components/sessions/SessionBrowser", () => ({
  SessionBrowser: () => null,
}));

vi.mock("../components/settings/SettingsPage", () => ({
  SettingsPage: () => null,
}));

vi.mock("../components/updates/UpdateModal", () => ({
  UpdateModal: () => null,
}));

vi.mock("../components/runbooks", () => ({
  RunbooksWorkspace: () => null,
}));

vi.mock("../hooks/useGlobalShortcuts", () => ({
  useGlobalShortcuts: () => undefined,
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({
    createSession: vi.fn(),
    closeSession: vi.fn(),
  }),
}));

import { AppShell } from "../components/layout/AppShell";
import { TabStrip } from "../components/layout/TabStrip";

function session(id: string, title: string, ordinal: number): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: title,
    aiTitle: null,
    ordinal,
  };
}

const binding: SidecarBinding = {
  ownerSessionId: "local",
  localSessionId: "local",
  remoteSessionId: "remote",
  remoteIdentity: {
    kind: "ssh",
    target: "deploy@prod-01",
    hostId: "prod-host",
    label: "Production",
  },
  permissions: { local: "ask", remote: "ask" },
  paneOrder: ["local", "remote"],
  splitRatio: 0.5,
  splitOrientation: "horizontal",
  focusedSessionId: "remote",
  degraded: null,
};

describe("Sidecar shell integration", () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [
        session("local", "Local project", 1),
        session("remote", "Production SSH", 2),
        session("other", "Unrelated", 3),
      ],
      activeSessionId: "remote",
      sidecars: { local: binding },
      sessionUi: {},
      aiStreams: {},
      settingsLoaded: true,
      settingsOpen: false,
      paletteOpen: false,
      sessionBrowserOpen: false,
      runbooksEnabled: false,
      renamingSessionId: null,
    });
    useChatStore.setState({ workspaceMode: "terminal" });
  });

  it("resolves either paired tab to one owner conversation without remounting the pair as ordinary panes", () => {
    render(<AppShell />);

    expect(screen.getByTestId("ai-panel")).toHaveAttribute(
      "data-session-id",
      "local",
    );
    expect(screen.getByTestId("sidecar-workspace")).toHaveAttribute(
      "data-owner-session-id",
      "local",
    );
    expect(screen.getByTestId("sidecar-workspace")).toHaveAttribute(
      "data-focused-session-id",
      "remote",
    );
    expect(screen.queryByTestId("terminal-local")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-remote")).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-other")).toBeInTheDocument();
  });

  it("marks both linked tabs and makes a tab click focus its corresponding pane", () => {
    render(<TabStrip />);

    expect(screen.getByTitle("Local Sidecar target")).toBeInTheDocument();
    expect(screen.getByTitle("SSH Sidecar target")).toBeInTheDocument();

    const localButton = screen.getByText("Local project").closest("button");
    expect(localButton).not.toBeNull();
    expect(localButton?.className).toContain("ring-accent/20");
    fireEvent.click(localButton!);

    expect(useAppStore.getState().activeSessionId).toBe("local");
    expect(useAppStore.getState().sidecars.local.focusedSessionId).toBe("local");

    const remoteButton = screen.getByText("Production SSH").closest("button");
    expect(remoteButton).not.toBeNull();
    fireEvent.click(remoteButton!);

    expect(useAppStore.getState().activeSessionId).toBe("remote");
    expect(useAppStore.getState().sidecars.local.focusedSessionId).toBe("remote");
  });

  it("keeps both workspace layers mounted while Chat hides the terminal layer", () => {
    render(<AppShell />);
    const terminal = screen.getByTestId("terminal-other");
    const chat = screen.getByTestId("chat-workspace");

    act(() => useChatStore.setState({ workspaceMode: "chat" }));

    expect(terminal).toBeInTheDocument();
    expect(chat).toBeInTheDocument();
    expect(terminal.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    expect(chat.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
  });
});
