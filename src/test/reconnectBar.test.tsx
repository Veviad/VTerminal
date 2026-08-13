import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  atPrompt: false,
  connectToHost: vi.fn(async () => "s1" as string | null),
  createSession: vi.fn(async () => "new-session"),
  sshHostsGet: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  sshHostsGet: mocks.sshHostsGet,
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({ createSession: mocks.createSession }),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => ({
    disposed: false,
    tracker: { isAtPromptColumn: () => mocks.atPrompt },
  }),
}));

vi.mock("../lib/sshConnect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sshConnect")>();
  return { ...actual, connectToHost: mocks.connectToHost };
});

import { ReconnectBar } from "../components/terminal/ReconnectBar";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import type { Session, SshHost } from "../lib/types";

const session: Session = {
  id: "s1",
  shell: "/bin/zsh",
  cwd: null,
  createdAt: "2026-08-13T00:00:00.000Z",
  exited: false,
  exitCode: null,
  hostId: "host-1",
  hostLabel: "Cluster 2",
  userTitle: null,
  aiTitle: null,
  ordinal: 1,
};

const host: SshHost = {
  id: "host-1",
  label: "Cluster 2",
  hostname: "cluster2.maholick.com",
  username: "ansible",
  port: null,
  identity_file: null,
  jump_host: null,
  extra_args: null,
  remote_dir: null,
  post_connect: null,
  tag: null,
  color: null,
  source: "manual",
  config_alias: null,
  use_count: 0,
  last_used_at: null,
  created_at: "2026-08-13T00:00:00.000Z",
  updated_at: "2026-08-13T00:00:00.000Z",
};

describe("ReconnectBar", () => {
  beforeEach(() => {
    mocks.atPrompt = false;
    mocks.connectToHost.mockClear();
    mocks.createSession.mockClear();
    mocks.sshHostsGet.mockReset();
    mocks.sshHostsGet.mockResolvedValue(host);
    useAppStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      sessionUi: {
        [session.id]: {
          ...emptySessionUi(),
          phase: "output",
          integrationActive: true,
        },
      },
      aiStreams: {},
    });
  });

  it("enables after the local prompt returns and reconnects in the same tab", async () => {
    render(<ReconnectBar sessionId={session.id} />);

    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    const bar = reconnect.parentElement;
    expect(bar).toHaveClass("pointer-events-auto", "z-20");
    expect(reconnect).toBeDisabled();

    mocks.atPrompt = true;
    act(() => {
      useAppStore.getState().updateSessionUi(session.id, { phase: "input" });
    });

    expect(reconnect).toBeEnabled();
    fireEvent.click(reconnect);

    await waitFor(() => {
      expect(mocks.connectToHost).toHaveBeenCalledWith(host, "current-tab", mocks.createSession);
    });
  });

  it("stays disabled while the shell is busy or the user is mid-command", async () => {
    render(<ReconnectBar sessionId={session.id} />);

    const reconnect = await screen.findByRole("button", { name: "Reconnect" });
    expect(reconnect).toBeDisabled();
    expect(reconnect).toHaveClass("disabled:cursor-not-allowed");

    act(() => {
      useAppStore.getState().updateSessionUi(session.id, { phase: "input" });
    });

    expect(reconnect).toBeDisabled();
    expect(reconnect).toHaveAttribute("title", "this tab is busy or you're mid-command");
    fireEvent.click(reconnect);
    expect(mocks.connectToHost).not.toHaveBeenCalled();
  });
});
