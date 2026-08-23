import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectToHost: vi.fn(async () => "remote" as string | null),
  connectToSshTarget: vi.fn(async () => "remote" as string | null),
  createSession: vi.fn(async () => "new-session"),
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
  sshHostsGet: vi.fn(),
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

describe("Sidecar SSH reconnect", () => {
  beforeEach(() => {
    mocks.connectToHost.mockClear();
    mocks.connectToSshTarget.mockClear();
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
