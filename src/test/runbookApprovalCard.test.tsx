import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RunbookApprovalCard } from "../components/runbooks/RunbookApprovalCard";

describe("RunbookApprovalCard", () => {
  it("requires an explicit shell-prompt trust attestation", () => {
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

    const approve = screen.getByRole("button", { name: /confirm prompt & approve/i });
    expect(approve).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /visible prompt is on the bound target/i }),
    );
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(onRespond).toHaveBeenCalledWith(
      true,
      "/usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c 'true'",
      true,
    );
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
