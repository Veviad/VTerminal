import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommandApprovalCard } from "../components/ai/CommandApprovalCard";
import {
  SidecarPairingPopover,
  type SidecarTerminalChoice,
} from "../components/sidecar/SidecarPairingPopover";
import { S } from "../lib/strings";

const localChoices: readonly SidecarTerminalChoice[] = [
  { id: "local-1", label: "Project", detail: "~/code/project" },
  { id: "local-2", label: "Ops", detail: "~/code/ops" },
];

const remoteChoices: readonly SidecarTerminalChoice[] = [
  { id: "remote-1", label: "Production", detail: "deploy@prod-01" },
  { id: "remote-2", label: "Staging", detail: "deploy@stage-01" },
];

function renderPairingPopover({
  local = localChoices,
  remote = remoteChoices,
  defaultLocalId = "local-2",
  defaultRemoteId = "remote-2",
  onStart = vi.fn(() => null),
  onOpenHosts = vi.fn(),
  onClose = vi.fn(),
}: {
  local?: readonly SidecarTerminalChoice[];
  remote?: readonly SidecarTerminalChoice[];
  defaultLocalId?: string | null;
  defaultRemoteId?: string | null;
  onStart?: (localSessionId: string, remoteSessionId: string) => string | null;
  onOpenHosts?: () => void;
  onClose?: () => void;
} = {}) {
  render(
    <SidecarPairingPopover
      localChoices={local}
      remoteChoices={remote}
      defaultLocalId={defaultLocalId}
      defaultRemoteId={defaultRemoteId}
      onStart={onStart}
      onOpenHosts={onOpenHosts}
      onClose={onClose}
    />,
  );
}

describe("SidecarPairingPopover", () => {
  it("exposes an accessible dialog and labelled terminal selectors", () => {
    renderPairingPopover();

    expect(
      screen.getByRole("dialog", { name: S.aiPanel.sidecar.title }),
    ).toBeInTheDocument();

    const local = screen.getByRole("combobox", {
      name: S.aiPanel.sidecar.localTerminal,
    });
    const remote = screen.getByRole("combobox", {
      name: S.aiPanel.sidecar.sshTerminal,
    });
    expect(local).toHaveValue("local-2");
    expect(remote).toHaveValue("remote-2");
    expect(
      screen.getByRole("button", { name: "Close Sidecar setup" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: S.aiPanel.sidecar.start }),
    ).toBeEnabled();
  });

  it("keeps the popover open and announces a start-time validation race inline", () => {
    const onStart = vi.fn(
      () => "Production disconnected while Sidecar was being created.",
    );
    const onClose = vi.fn();
    renderPairingPopover({ onStart, onClose });

    fireEvent.click(
      screen.getByRole("button", { name: S.aiPanel.sidecar.start }),
    );

    expect(onStart).toHaveBeenCalledWith("local-2", "remote-2");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Production disconnected while Sidecar was being created.",
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByRole("combobox", { name: S.aiPanel.sidecar.sshTerminal }),
      { target: { value: "remote-1" } },
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers SSH host setup and prevents starting without a remote terminal", () => {
    const onOpenHosts = vi.fn();
    const onClose = vi.fn();
    const onStart = vi.fn(() => null);
    renderPairingPopover({
      remote: [],
      defaultRemoteId: null,
      onOpenHosts,
      onClose,
      onStart,
    });

    expect(screen.getByText(S.aiPanel.sidecar.noRemote)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: S.aiPanel.sidecar.start }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: S.aiPanel.sidecar.openHosts }),
    );
    expect(onOpenHosts).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("CommandApprovalCard Sidecar destinations", () => {
  it("announces and labels a remote command with its exact destination", () => {
    const onRespond = vi.fn();
    render(
      <CommandApprovalCard
        command="docker compose config"
        explanation="Validate the remote Compose file."
        target="ssh deploy@prod-01"
        remote={true}
        targetRole="remote"
        onRespond={onRespond}
      />,
    );

    expect(
      screen.getByLabelText(
        "Remote command approval for ssh deploy@prod-01",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("ssh deploy@prod-01")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Run on deploy@prod-01" }),
    );
    expect(onRespond).toHaveBeenCalledWith("run", undefined);
  });

  it("announces a local destination and uses an unambiguous local run action", () => {
    const onRespond = vi.fn();
    render(
      <CommandApprovalCard
        command="gh issue view 42"
        explanation="Read the issue with local GitHub credentials."
        target="~/code/project"
        remote={false}
        targetRole="local"
        onRespond={onRespond}
      />,
    );

    expect(
      screen.getByLabelText("Local command approval for ~/code/project"),
    ).toBeInTheDocument();
    expect(screen.getByText("~/code/project")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run locally" }));
    expect(onRespond).toHaveBeenCalledWith("run", undefined);
  });
});
