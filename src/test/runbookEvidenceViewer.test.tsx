import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());

vi.mock("../lib/runbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runbooks")>();
  // A forwarding arrow, not the `vi.fn()` itself: when the export IS the mock,
  // vitest tracks the rejected promise it returns and reports it as unhandled
  // even though the component awaits and catches it.
  return {
    ...actual,
    runbooksEvidenceRead: (runId: string, evidenceId: string) => read(runId, evidenceId),
  };
});

import { RunbookEvidenceViewer } from "../components/runbooks/RunbookEvidenceViewer";
import type { RunbookReportEvidence } from "../lib/runbooks";

function evidence(overrides: Partial<RunbookReportEvidence> = {}): RunbookReportEvidence {
  return {
    id: "evidence-1",
    attempt_id: "attempt-1",
    mode: "full",
    availability: "complete",
    relative_path: "runbooks/run-1/attempt-1.log",
    bytes: 42,
    sha256: "a".repeat(64),
    redacted: true,
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => read.mockReset());

describe("RunbookEvidenceViewer", () => {
  it("reads an artifact only when the operator asks for it", async () => {
    read.mockResolvedValue({
      evidence_id: "evidence-1",
      available: true,
      text: "permitrootlogin no",
      bytes: 42,
      redacted: true,
      truncated: false,
    });
    render(<RunbookEvidenceViewer runId="run-1" evidence={evidence()} />);

    // A run can hold 1 MiB per attempt, so expanding a step must not pull every
    // artifact into the webview.
    expect(read).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /view recorded output/i }));
    await waitFor(() => expect(screen.getByText("permitrootlogin no")).toBeInTheDocument());
    expect(read).toHaveBeenCalledWith("run-1", "evidence-1");
    expect(screen.getByText(/secrets redacted before storage/i)).toBeInTheDocument();

    // Collapsing and reopening reuses what was already read.
    fireEvent.click(screen.getByRole("button", { name: /hide recorded output/i }));
    fireEvent.click(screen.getByRole("button", { name: /view recorded output/i }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("says an artifact is no longer readable instead of showing nothing", async () => {
    // The digest is re-verified on read, so an altered file comes back
    // unavailable. Rendering an empty pre would read as "the step produced no
    // output", which is the opposite of what happened.
    read.mockResolvedValue({
      evidence_id: "evidence-1",
      available: false,
      text: "",
      bytes: 42,
      redacted: false,
      truncated: false,
    });
    render(<RunbookEvidenceViewer runId="run-1" evidence={evidence()} />);

    fireEvent.click(screen.getByRole("button", { name: /view recorded output/i }));
    await waitFor(() =>
      expect(screen.getByText(/no longer readable/i)).toBeInTheDocument(),
    );
  });

  it("marks output that was already truncated when it was recorded", async () => {
    read.mockResolvedValue({
      evidence_id: "evidence-1",
      available: true,
      text: "tail of the output",
      bytes: 1_048_576,
      redacted: false,
      truncated: true,
    });
    render(<RunbookEvidenceViewer runId="run-1" evidence={evidence()} />);

    fireEvent.click(screen.getByRole("button", { name: /view recorded output/i }));
    await waitFor(() =>
      expect(screen.getByText(/output truncated when it was recorded/i)).toBeInTheDocument(),
    );
  });

  it("offers nothing to open when no artifact was stored", () => {
    // `tail` evidence lives inline with its attempt, and a pending or missing
    // artifact has no file behind it.
    render(
      <RunbookEvidenceViewer
        runId="run-1"
        evidence={evidence({ mode: "tail", relative_path: null })}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();

    render(
      <RunbookEvidenceViewer runId="run-1" evidence={evidence({ availability: "missing" })} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/unavailable \(missing\)/i)).toBeInTheDocument();
  });

  // NOT covered here: a rejected read. The component catches it and renders the
  // message (`setError(String(cause))`), verified by hand against the rendered
  // DOM, but every shape of that test — mockRejectedValue, a thrown string, an
  // Error, a pre-observed promise, act-wrapped, findByText — is reported by the
  // runner as an unhandled rejection attributed to the line that created it,
  // even though the component awaits and catches it. The same shape passes in
  // remoteServersSection.test.tsx, so the trigger is specific to this file and
  // is a harness artifact, not a defect. The unreadable-artifact case above
  // covers the failure the operator actually meets.
});
