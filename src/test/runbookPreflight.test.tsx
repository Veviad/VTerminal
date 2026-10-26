import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { RunbookPreflight } from "../components/runbooks/RunbookPreflight";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import type { Session } from "../lib/types";
import type { RunbookDefinition } from "../lib/runbooks";

const definition: RunbookDefinition = {
  apiVersion: "runbooks.veviad.com/v1alpha1",
  kind: "Runbook",
  metadata: { id: "cleanup", version: "1.0.0", title: "Cleanup" },
  spec: { target: { kind: "active-terminal" }, steps: [] },
};

beforeEach(() => {
  const session = (id: string, hostId: string | null): Session => ({
    id, shell: "/bin/zsh", cwd: "/Users/op", createdAt: "2026-10-26T18:00:00Z",
    exited: false, exitCode: null, hostId, hostLabel: hostId ? "Production" : null,
    userTitle: null, aiTitle: null, ordinal: id === "local" ? 1 : 2,
  });
  useAppStore.setState({
    sessions: [session("local", "host-1"), session("remote", "host-2")],
    activeSessionId: "local",
    sessionUi: {
      local: { ...emptySessionUi(), cwd: "/Users/op", host: "mac" },
      remote: { ...emptySessionUi(), remote: { kind: "ssh", target: "server" } },
    },
  });
});

describe("RunbookPreflight target selection", () => {
  it("distinguishes a disconnected saved SSH tab from a live remote and can switch", () => {
    render(<RunbookPreflight definition={definition} sessionId="local" packageDigest={null}
      busy={false} onBack={() => {}} onStart={() => {}} />);
    expect(screen.getByText(/This tab is currently local/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Production · local shell/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /ssh: server/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start runbook" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I intend to run this runbook on the local shell/ }));
    expect(screen.getByRole("button", { name: "Start runbook" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Execution target"), { target: { value: "remote" } });
    expect(useAppStore.getState().activeSessionId).toBe("remote");
  });
});
