import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useRunbooks", () => ({
  buildRunbookTargetContext: () => ({ kind: "active-terminal", session_id: "terminal", shell: "zsh", observed_at: "now" }),
  describeRunbookTarget: () => "Local terminal",
}));

import { RunbookPreflight } from "../components/runbooks/RunbookPreflight";
import type { RunbookDefinition } from "../lib/runbooks";
import { useAppStore } from "../stores/appStore";

const definition: RunbookDefinition = {
  kind: "Runbook",
  metadata: { id: "inputs", version: "1.0.0", title: "Inputs" },
  spec: {
    target: { kind: "active-terminal" },
    inputs: {
      confirm: { type: "boolean", required: true },
      count: { type: "integer" },
      choice: { type: "enum", values: ["one", "two"] },
    },
    steps: [],
  },
};

function renderPreflight(onStart = vi.fn()) {
  render(<RunbookPreflight definition={definition} sessionId="terminal" packageDigest={null} busy={false} onBack={() => {}} onStart={onStart} />);
  return onStart;
}

describe("runbook preflight inputs", () => {
  beforeEach(() => {
    useAppStore.setState({ runbooksOutputRecording: "none" });
  });

  it("sends false for an unchecked required boolean", () => {
    const onStart = renderPreflight();
    fireEvent.click(screen.getByRole("button", { name: "Start runbook" }));
    expect(onStart).toHaveBeenCalledWith({ confirm: false }, "none");
  });

  it("omits optional number and enum values after they are cleared", () => {
    const onStart = renderPreflight();
    fireEvent.change(screen.getByLabelText(/count/), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText(/count/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/choice/), { target: { value: "one" } });
    fireEvent.change(screen.getByLabelText(/choice/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Start runbook" }));
    expect(onStart).toHaveBeenCalledWith({ confirm: false }, "none");
  });

  it("rejects a fractional integer rather than silently rounding it", () => {
    const onStart = renderPreflight();
    fireEvent.change(screen.getByLabelText(/count/), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Start runbook" }));
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a whole number/)).toBeTruthy();
  });
});
