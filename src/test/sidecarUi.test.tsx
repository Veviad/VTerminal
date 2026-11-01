import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandApprovalCard } from "../components/ai/CommandApprovalCard";
import {
  SidecarPairingPopover,
  type SidecarTerminalChoice,
} from "../components/sidecar/SidecarPairingPopover";
import { SidecarReplacementPopover } from "../components/sidecar/SidecarReplacementPopover";
import type { AgentTargetRole } from "../lib/sidecar";
import { S } from "../lib/strings";
import { APPROVAL_PROMPT_TTL_MS } from "../lib/approvalPrompt";
import * as terminalRegistry from "../lib/termRegistry";
import type { TermEvent } from "../lib/termRegistry";

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
  return render(
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

function renderReplacementPopover({
  defaultRole = "local",
  choices = { local: localChoices, remote: remoteChoices },
  onReplace = vi.fn(() => null),
  onBack = vi.fn(),
  onClose = vi.fn(),
}: {
  defaultRole?: AgentTargetRole;
  choices?: Record<AgentTargetRole, readonly SidecarTerminalChoice[]>;
  onReplace?: (role: AgentTargetRole, sessionId: string) => string | null;
  onBack?: () => void;
  onClose?: () => void;
} = {}) {
  return render(
    <SidecarReplacementPopover
      defaultRole={defaultRole}
      choices={choices}
      onReplace={onReplace}
      onBack={onBack}
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

  it("dismisses on Escape and a pointer outside, but not a pointer inside", () => {
    const onClose = vi.fn();
    renderPairingPopover({ onClose });

    fireEvent.pointerDown(
      screen.getByRole("dialog", { name: S.aiPanel.sidecar.title }),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("removes dismissal listeners when the popover unmounts", () => {
    const onClose = vi.fn();
    const { unmount } = renderPairingPopover({ onClose });

    unmount();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SidecarReplacementPopover", () => {
  it("switches roles using that role's choices and replaces the selected target", () => {
    const onReplace = vi.fn(() => null);
    renderReplacementPopover({ onReplace });

    fireEvent.click(screen.getByRole("button", { name: S.aiPanel.sidecar.remote }));
    expect(screen.getByRole("combobox", { name: "Replacement terminal" })).toHaveValue(
      "remote-1",
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Replacement terminal" }), {
      target: { value: "remote-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: S.aiPanel.sidecar.replace }));

    expect(onReplace).toHaveBeenCalledWith("remote", "remote-2");
  });

  it("keeps replacement disabled and never calls the handler when the role has no choices", () => {
    const onReplace = vi.fn(() => null);
    renderReplacementPopover({
      choices: { local: [], remote: [] },
      onReplace,
    });

    expect(screen.queryByRole("combobox", { name: "Replacement terminal" })).not.toBeInTheDocument();
    const replace = screen.getByRole("button", { name: S.aiPanel.sidecar.replace });
    expect(replace).toBeDisabled();

    fireEvent.click(replace);
    expect(onReplace).not.toHaveBeenCalled();
  });
});

afterEach(() => { vi.useRealTimers(); });

describe("CommandApprovalCard Sidecar destinations", () => {
  it("keeps the proposed remote destination and disables Run after its target changes", () => {
    render(<CommandApprovalCard command="pwd" explanation="" target="ssh prod-01" remote
      targetChanged outputPolicy="normal" onRespond={vi.fn()} />);
    expect(screen.getByLabelText("Remote command approval for ssh prod-01")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("terminal target changed");
    expect(screen.getByRole("button", { name: "Run on prod-01" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /empty shell prompt/i })).toBeDisabled();
  });
  it("clears remote prompt confirmation when the terminal receives input", () => {
    let listener!: (event: TermEvent) => void;
    const subscription = vi.spyOn(terminalRegistry, "subscribeTerm").mockImplementation((_id, callback) => {
      listener = callback;
      return () => {};
    });
    const onConfirm = vi.fn(() => true);
    render(<CommandApprovalCard command="pwd" explanation="" target="ssh host" remote
      outputPolicy="normal" remoteSessionId="remote-1" onConfirmPrompt={onConfirm} onRespond={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: /empty shell prompt/i });
    const run = screen.getByRole("button", { name: "Run on host" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(run).toBeEnabled();
    act(() => listener({ type: "userInput" }));
    expect(checkbox).not.toBeChecked();
    expect(run).toBeDisabled();
    expect(onConfirm).toHaveBeenLastCalledWith(false);
    subscription.mockRestore();
  });

  it("expires prompt confirmation at the execution binding deadline without renewing on rerender", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T20:00:00Z"));
    const firstConfirm = vi.fn(() => true);
    const latestConfirm = vi.fn(() => true);
    const onRespond = vi.fn();
    const view = render(<CommandApprovalCard command="cat /tmp/private-fixture" explanation="Inspect privately" target="ssh host" remote
      outputPolicy="private" remoteSessionId="remote-1" onConfirmPrompt={firstConfirm} onRespond={onRespond} />);
    const checkbox = screen.getByRole("checkbox", { name: /empty shell prompt/i });
    const run = screen.getByRole("button", { name: "Run on host" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(run).toBeEnabled();
    act(() => vi.advanceTimersByTime(APPROVAL_PROMPT_TTL_MS / 2));
    view.rerender(<CommandApprovalCard command="cat /tmp/private-fixture" explanation="Inspect privately" target="ssh host" remote
      outputPolicy="private" remoteSessionId="remote-1" onConfirmPrompt={latestConfirm} onRespond={onRespond} />);
    act(() => vi.advanceTimersByTime(APPROVAL_PROMPT_TTL_MS / 2));
    expect(checkbox).not.toBeChecked();
    expect(run).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Prompt confirmation expired");
    expect(latestConfirm).toHaveBeenLastCalledWith(false);
    expect(onRespond).not.toHaveBeenCalled();
    // Expiry releases trust; the next lease requires another explicit gesture.
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(run).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(run);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith("run", undefined);
  });

  it("rejects an expired Run click even before delayed timer callbacks are delivered", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T20:00:00Z"));
    const onConfirm = vi.fn(() => true);
    const onRespond = vi.fn();
    render(<CommandApprovalCard command="pwd" explanation="Inspect directory" target="ssh host" remote
      outputPolicy="normal" remoteSessionId="remote-1" onConfirmPrompt={onConfirm} onRespond={onRespond} />);
    const checkbox = screen.getByRole("checkbox", { name: /empty shell prompt/i });
    const run = screen.getByRole("button", { name: "Run on host" });
    fireEvent.click(checkbox);
    // setSystemTime changes wall time without firing timers, as when a webview
    // resumes with a stale enabled control after being occluded or suspended.
    vi.setSystemTime(new Date(Date.now() + APPROVAL_PROMPT_TTL_MS + 1));
    fireEvent.click(run);
    expect(onRespond).not.toHaveBeenCalled();
    expect(checkbox).not.toBeChecked();
    expect(run).toBeDisabled();
    expect(onConfirm).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("status")).toHaveTextContent("confirm again");
    expect(screen.getByRole("button", { name: S.aiPanel.skip })).toBeEnabled();
    fireEvent.click(checkbox);
    fireEvent.click(run);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith("run", undefined);
  });

  it("announces and labels a remote command with its exact destination", () => {
    const onRespond = vi.fn();
    render(
      <CommandApprovalCard
        command="docker compose config"
        explanation="Validate the remote Compose file."
        target="ssh deploy@prod-01"
        remote={true}
        targetRole="remote"
        outputPolicy="normal"
        onRespond={onRespond}
      />,
    );

    expect(
      screen.getByLabelText(
        "Remote command approval for ssh deploy@prod-01",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("ssh deploy@prod-01")).toBeInTheDocument();

    const run = screen.getByRole("button", { name: "Run on deploy@prod-01" });
    expect(run).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /empty shell prompt/i }));
    fireEvent.click(run);
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
        outputPolicy="normal"
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

  it("labels private output and does not offer a persistent allow rule", () => {
    render(
      <CommandApprovalCard
        command="umask 077; openssl rand -hex 32 > secret"
        explanation="Generate an opaque secret file."
        target="~/code/project"
        remote={false}
        outputPolicy="private"
        onRemember={vi.fn()}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText("Private output.")).toBeInTheDocument();
    expect(screen.queryByText("Always allow")).not.toBeInTheDocument();
  });
});
