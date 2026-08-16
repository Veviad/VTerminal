import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunbookApprovalCard } from "../components/runbooks/RunbookApprovalCard";

function shellApproval(command: string) {
  return {
    approval_id: "approval-1",
    run_id: "run-1",
    step_id: "check-host",
    phase: "check" as const,
    command,
    explanation: "Observe the configured check in the visible terminal.",
    classification: {
      read_only: false,
      network: false,
      privileged: false,
      opaque: true,
    },
  };
}

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
    const approve = screen.getByRole("button", { name: /approve this step/i });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(onRespond).toHaveBeenCalledWith(true, command, true);
  });

  it("carries the operator's edit into the bulk approval", () => {
    // The bulk button used to take no arguments, so the hook fell back to the
    // model's original proposal and the report recorded it as un-edited.
    const onApproveAll = vi.fn();
    render(
      <RunbookApprovalCard
        approval={shellApproval("printf original")}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={vi.fn()}
        onApproveAll={onApproveAll}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "printf narrowed" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /every later step unseen/i }),
    );
    expect(onApproveAll).toHaveBeenCalledWith("printf narrowed");
  });

  it("refuses a bulk approval for a command the single step would refuse", () => {
    const onApproveAll = vi.fn();
    render(
      <RunbookApprovalCard
        approval={shellApproval("printf hi")}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={vi.fn()}
        onApproveAll={onApproveAll}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "line-one\nline-two" },
    });
    expect(
      screen.getByRole("button", { name: /every later step unseen/i }),
    ).toBeDisabled();
    // "Approve every later step unseen" shares no prefix with the primary
    // action any more, so this query is unambiguous.
    expect(
      screen.getByRole("button", { name: /approve this/i }),
    ).toBeDisabled();
  });

  it("says that later steps are approved without being displayed", () => {
    render(
      <RunbookApprovalCard
        approval={shellApproval("printf hi")}
        busy={false}
        targetLabel="Local /srv/app"
        onRespond={vi.fn()}
        onApproveAll={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/approved without being shown to you/i),
    ).toBeTruthy();
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
    const approve = screen.getByRole("button", { name: /approve this/i });
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

    fireEvent.click(
      screen.getByRole("button", { name: /every later step unseen/i }),
    );
    expect(onApproveAll).toHaveBeenCalledWith("printf hi");
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
    expect(
      screen.getByRole("button", { name: /allow model once/i }),
    ).toBeEnabled();
  });
});
