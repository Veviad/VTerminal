import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunbookApprovalCard } from "../components/runbooks/RunbookApprovalCard";

describe("RunbookApprovalCard", () => {
  it("approves a shell approval from one explicit action with valid command", () => {
    const onRespond = vi.fn();
    render(
      <RunbookApprovalCard
        approval={{
          approval_id: "approval-1",
          run_id: "run-1",
          step_id: "check-host",
          phase: "check",
          command: "/usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c 'true'",
          explanation: "Observe the configured check in the visible terminal.",
          classification: {
            read_only: false,
            network: false,
            privileged: false,
            opaque: true,
          },
        }}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={onRespond}
      />,
    );

    const command = "/usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c 'true'";
    const approve = screen.getByRole("button", { name: /acknowledge and approve step/i });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(onRespond).toHaveBeenCalledWith(
      true,
      command,
      true,
    );
  });

  it("requires a valid shell command before enabling approval", () => {
    const onRespond = vi.fn();
    render(
      <RunbookApprovalCard
        approval={{
          approval_id: "approval-1",
          run_id: "run-1",
          step_id: "check-host",
          phase: "check",
          command: "printf hi",
          explanation: "Observe the configured check in the visible terminal.",
          classification: {
            read_only: false,
            network: false,
            privileged: false,
            opaque: true,
          },
        }}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={onRespond}
      />,
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "line-one\nline-two" } });
    const approve = screen.getByRole("button", { name: /acknowledge and approve/i });
    expect(approve).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "" } });
    expect(approve).toBeDisabled();
  });

  it("launches approve-all callback for run-scoped bulk acknowledgment", () => {
    const onApproveAll = vi.fn();
    render(
      <RunbookApprovalCard
        approval={{
          approval_id: "approval-1",
          run_id: "run-1",
          step_id: "check-host",
          phase: "check",
          command: "printf hi",
          explanation: "Observe the configured check in the visible terminal.",
          classification: {
            read_only: false,
            network: false,
            privileged: false,
            opaque: true,
          },
        }}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={vi.fn()}
        onApproveAll={onApproveAll}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /approve all remaining steps/i }));
    expect(onApproveAll).toHaveBeenCalledOnce();
  });

  it("stops bulk approval when requested", () => {
    const onRespond = vi.fn();
    const onCancelApproveAll = vi.fn();
    render(
      <RunbookApprovalCard
        approval={{
          approval_id: "approval-1",
          run_id: "run-1",
          step_id: "check-host",
          phase: "check",
          command: "printf hi",
          explanation: "Observe the configured check in the visible terminal.",
          classification: {
            read_only: false,
            network: false,
            privileged: false,
            opaque: true,
          },
        }}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={onRespond}
        onApproveAll={() => {}}
        onCancelApproveAll={onCancelApproveAll}
        autoApproving={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /stop auto-approve/i }));
    expect(onCancelApproveAll).toHaveBeenCalledOnce();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("does not present shell attestation for a model-only approval", () => {
    render(
      <RunbookApprovalCard
        approval={{
          approval_id: "approval-model",
          run_id: "run-1",
          step_id: "agent-check",
          phase: "check",
          command: "model://configured-agent/check",
          explanation: "Allow bounded model processing.",
          classification: {
            read_only: false,
            network: true,
            privileged: false,
            opaque: true,
          },
        }}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={vi.fn()}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: /allow model once/i })).toBeEnabled();
  });
});
