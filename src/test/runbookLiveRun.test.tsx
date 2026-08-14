import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The live-run panel is rendered while `view === "run"` and stays mounted across
// run selection and the report/definition sub-views. Every one of those
// transitions changes which early return fires, so this file exists to keep the
// component's hook count constant: a hook added below an early return throws
// React's "rendered more/fewer hooks than expected" invariant, and the repo has
// no ESLint to catch it statically.

const mocks = vi.hoisted(() => ({
  loadReport: vi.fn(async () => {}),
  runbooksGetDefinition: vi.fn(),
  cancel: vi.fn(async (_runId: string) => {}),
}));

vi.mock("../hooks/useRunbooks", () => ({
  useRunbooks: () => ({
    cancel: mocks.cancel,
    resume: vi.fn(),
    respondApproval: vi.fn(),
    approveAllPendingSteps: vi.fn(),
    cancelApproveAll: vi.fn(),
    decide: vi.fn(),
    submitManual: vi.fn(),
    loadReport: mocks.loadReport,
  }),
  describeRunbookTarget: () => "Local /srv/app",
}));

vi.mock("../lib/runbooks", async () => {
  const actual = await vi.importActual<typeof import("../lib/runbooks")>(
    "../lib/runbooks",
  );
  return { ...actual, runbooksGetDefinition: mocks.runbooksGetDefinition };
});

import { RunbookLiveRun } from "../components/runbooks/RunbookLiveRun";
import type { RunbookRun, RunbookRunState } from "../lib/runbooks";
import { useRunbookStore } from "../stores/runbookStore";

function liveRun(status: RunbookRunState): RunbookRun {
  return {
    run_id: "run-1",
    status,
    source_id: "source-1",
    definition_id: "example",
    definition_version: "1.0.0",
    target: {
      kind: "active-terminal",
      session_id: "session-1",
      observed_at: "2026-08-13T12:00:00Z",
    },
    active_step_id: "one",
    active_phase: null,
    pending_approval_id: null,
    pause_reason: null,
    report_ready: true,
    steps: [{ id: "one", status: "remediated_verified" }],
  } as RunbookRun;
}

describe("RunbookLiveRun view transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRunbookStore.getState().reset();
  });

  it("keeps a stable hook count when a run becomes active", () => {
    render(<RunbookLiveRun sessionId="session-1" />);
    expect(screen.getByText(/No run selected/i)).toBeTruthy();

    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("running"));
    });

    expect(
      screen.getByRole("button", { name: /Review runbook/i }),
    ).toBeTruthy();
  });

  it("returns to the Library once an abort has actually stopped the run", async () => {
    mocks.cancel.mockImplementation(async (runId: string) => {
      useRunbookStore
        .getState()
        .setActiveRun({ ...liveRun("cancelled"), run_id: runId });
    });
    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("running"));
      useRunbookStore.getState().setView("run");
    });
    render(<RunbookLiveRun sessionId="session-1" />);

    // Two clicks: the first arms the confirmation, the second aborts.
    fireEvent.click(screen.getByRole("button", { name: /Abort run/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirm abort/i }));
    });

    expect(mocks.cancel).toHaveBeenCalledWith("run-1");
    expect(useRunbookStore.getState().view).toBe("library");
  });

  it("stays on a run whose abort did not take", async () => {
    // `cancel` reports failure by setting the store error, not by throwing, so
    // navigating unconditionally would hide a run that is still going.
    mocks.cancel.mockImplementation(async () => {
      useRunbookStore.getState().setError("could not reach the terminal");
    });
    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("running"));
      useRunbookStore.getState().setView("run");
    });
    render(<RunbookLiveRun sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Abort run/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirm abort/i }));
    });

    expect(useRunbookStore.getState().view).toBe("run");
  });

  it("keeps a stable hook count when the selected run goes away", () => {
    // The other direction of the same early return: a run deleted from History
    // while it is open sets `activeRun` to null (`deleteHistoryRun`), so the
    // next render of this mounted instance takes the "No run selected" branch.
    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("running"));
    });
    render(<RunbookLiveRun sessionId="session-1" />);
    expect(screen.getByRole("button", { name: /Review runbook/i })).toBeTruthy();

    act(() => {
      useRunbookStore.getState().setActiveRun(null);
    });

    expect(screen.getByText(/No run selected/i)).toBeTruthy();
  });

  it("keeps a stable hook count when the report view opens and closes", async () => {
    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("succeeded"));
      useRunbookStore.getState().setReport({
        run_id: "run-1",
        result: "succeeded",
        definition: {
          id: "example",
          version: "1.0.0",
          yaml_sha256: "a".repeat(64),
          canonical_json_sha256: "b".repeat(64),
        },
        executive_summary: "",
        checklist: [],
        approvals: [],
        resumes: [],
        deviations: [],
        exceptions: [],
        unresolved_risks: [],
        duration_ms: 1_000,
        started_at: "2026-08-13T12:00:00Z",
        finished_at: "2026-08-13T12:01:00Z",
      } as never);
    });
    render(<RunbookLiveRun sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: /View report/i }));
    const back = await screen.findByRole("button", { name: /Checklist/i });

    fireEvent.click(back);
    expect(screen.getByRole("button", { name: /View report/i })).toBeTruthy();
  });

  it("keeps a stable hook count when the definition review opens and closes", async () => {
    mocks.runbooksGetDefinition.mockResolvedValue({
      metadata: { id: "example", version: "1.0.0", title: "Example" },
      spec: { steps: [] },
    });
    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("running"));
    });
    render(<RunbookLiveRun sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Review runbook/i }));
    const back = await screen.findByRole("button", { name: /Checklist/i });

    fireEvent.click(back);
    expect(
      screen.getByRole("button", { name: /Review runbook/i }),
    ).toBeTruthy();
  });

  it("resets the definition review when the selected run changes", async () => {
    mocks.runbooksGetDefinition.mockResolvedValue({
      metadata: { id: "example", version: "1.0.0", title: "Example" },
      spec: { steps: [] },
    });
    act(() => {
      useRunbookStore.getState().setActiveRun(liveRun("running"));
    });
    render(<RunbookLiveRun sessionId="session-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Review runbook/i }));
    await screen.findByRole("button", { name: /Checklist/i });

    await act(async () => {
      useRunbookStore
        .getState()
        .setActiveRun({ ...liveRun("running"), run_id: "run-2" });
    });

    expect(
      screen.getByRole("button", { name: /Review runbook/i }),
    ).toBeTruthy();
  });
});
