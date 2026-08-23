import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToHost: vi.fn(async () => "remote" as string | null),
  connectToSshTarget: vi.fn(async () => "remote" as string | null),
  createSession: vi.fn(async () => "new-session"),
  sshHostsGet: vi.fn(),
}));

vi.mock("../lib/sshConnect", () => ({
  canConnectHere: () => ({ ok: true as const }),
  connectToHost: mocks.connectToHost,
  connectToSshTarget: mocks.connectToSshTarget,
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({ createSession: mocks.createSession }),
}));

vi.mock("../components/terminal/TerminalPane", () => ({
  TerminalPane: ({ sessionId }: { sessionId: string }) => <div>{sessionId}</div>,
}));

vi.mock("../lib/tauri", () => ({
  aiCancel: vi.fn(async () => undefined),
  sshHostsGet: mocks.sshHostsGet,
}));

import { SidecarWorkspace } from "../components/sidecar/SidecarWorkspace";
import type { SidecarBinding } from "../lib/sidecar";
import type { Session } from "../lib/types";
import { emptySessionUi, useAppStore } from "../stores/appStore";

const sessions: Session[] = ["local", "remote"].map((id, index) => ({
  id,
  shell: "/bin/zsh",
  cwd: null,
  createdAt: "2026-08-23T00:00:00.000Z",
  exited: false,
  exitCode: null,
  hostId: null,
  hostLabel: null,
  userTitle: null,
  aiTitle: null,
  ordinal: index + 1,
}));

const binding: SidecarBinding = {
  ownerSessionId: "local",
  localSessionId: "local",
  remoteSessionId: "remote",
  remoteIdentity: {
    kind: "ssh",
    target: "deploy@prod-01",
    hostId: null,
    label: "Production",
  },
  permissions: { local: "auto_read", remote: "auto_all" },
  paneOrder: ["local", "remote"],
  splitRatio: 0.5,
  splitOrientation: "horizontal",
  focusedSessionId: "local",
  degraded: { role: "remote", reason: "remote_disconnected" },
};

const savedHost = {
  id: "saved-prod",
  label: "Production",
  hostname: "prod-01",
  username: "deploy",
  port: 2222,
  identity_file: "~/.ssh/prod",
  jump_host: null,
  extra_args: null,
  remote_dir: null,
  post_connect: null,
  tag: null,
  color: null,
  source: "manual" as const,
  config_alias: null,
  use_count: 0,
  last_used_at: null,
  created_at: "2026-08-23T00:00:00.000Z",
  updated_at: "2026-08-23T00:00:00.000Z",
};

function savedBinding(): SidecarBinding {
  return {
    ...binding,
    remoteIdentity: { ...binding.remoteIdentity, hostId: savedHost.id },
  };
}

describe("Sidecar SSH reconnect", () => {
  beforeEach(() => {
    mocks.connectToHost.mockClear();
    mocks.connectToSshTarget.mockClear();
    mocks.sshHostsGet.mockReset();
    useAppStore.setState({
      sessions,
      activeSessionId: "local",
      sidecars: { local: binding },
      sessionUi: {
        local: emptySessionUi(),
        remote: emptySessionUi(),
      },
      aiStreams: {},
    });
  });

  it("waits for a saved host lookup and reconnects with its full configuration", async () => {
    let resolveHost: (host: typeof savedHost) => void = () => {};
    mocks.sshHostsGet.mockReturnValue(
      new Promise<typeof savedHost>((resolve) => {
        resolveHost = resolve;
      }),
    );
    const saved = savedBinding();
    useAppStore.setState({ sidecars: { local: saved } });
    render(<SidecarWorkspace binding={saved} />);

    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect).toBeDisabled();
    fireEvent.click(reconnect);
    expect(mocks.connectToHost).not.toHaveBeenCalled();
    expect(mocks.connectToSshTarget).not.toHaveBeenCalled();

    resolveHost(savedHost);
    await waitFor(() => {
      expect(reconnect).toBeEnabled();
    });
    fireEvent.click(reconnect);

    expect(mocks.connectToHost).toHaveBeenCalledWith(
      savedHost,
      "current-tab",
      mocks.createSession,
      "remote",
    );
    expect(mocks.connectToSshTarget).not.toHaveBeenCalled();
  });

  it("falls back to the frozen target only after a missing saved-host lookup finishes", async () => {
    mocks.sshHostsGet.mockRejectedValue(new Error("saved host deleted"));
    const saved = savedBinding();
    useAppStore.setState({ sidecars: { local: saved } });
    render(<SidecarWorkspace binding={saved} />);

    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect).toBeDisabled();
    await waitFor(() => {
      expect(reconnect).toBeEnabled();
    });
    fireEvent.click(reconnect);

    expect(mocks.connectToSshTarget).toHaveBeenCalledWith("deploy@prod-01", "remote");
    expect(mocks.connectToHost).not.toHaveBeenCalled();
  });

  it("reconnects an ad-hoc target in the remote pane and recovers the binding", async () => {
    render(<SidecarWorkspace binding={binding} />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(mocks.connectToSshTarget).toHaveBeenCalledWith("deploy@prod-01", "remote");
    expect(mocks.connectToHost).not.toHaveBeenCalled();

    act(() => {
      useAppStore.getState().updateSessionUi("remote", {
        remote: { kind: "ssh", target: "deploy@prod-01" },
        nestedBlockId: "ssh-block",
        runningBlockId: "ssh-block",
      });
    });

    await waitFor(() => {
      expect(useAppStore.getState().sidecars.local.degraded).toBeNull();
    });
    expect(useAppStore.getState().sidecars.local.permissions).toEqual({
      local: "ask",
      remote: "ask",
    });
  });
});
