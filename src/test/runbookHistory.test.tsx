import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteRun: vi.fn(),
  loadHistory: vi.fn(),
  loadReport: vi.fn(),
  openHistoryRun: vi.fn(),
  selectSource: vi.fn(),
}));

vi.mock("../hooks/useRunbooks", () => ({
  useRunbooks: () => mocks,
}));

import { RunbookHistory } from "../components/runbooks/RunbookHistory";
import { useRunbookStore } from "../stores/runbookStore";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.deleteRun.mockResolvedValue(null);
  mocks.loadHistory.mockResolvedValue([]);
  mocks.loadReport.mockResolvedValue(undefined);
  mocks.openHistoryRun.mockResolvedValue(undefined);
  mocks.selectSource.mockResolvedValue(undefined);

  useRunbookStore.getState().reset();
  useRunbookStore.getState().setHistory([
    {
      run_id: "run-failed",
      source_id: "source-1",
      definition_id: "baseline",
      definition_version: "1.0.0",
      definition_title: "Baseline",
      state: "failed",
      target_label: "session-1",
      started_at: "2026-08-13T12:00:00Z",
      finished_at: "2026-08-13T12:01:00Z",
      duration_ms: 60_000,
      checked_steps: 0,
      total_steps: 1,
    },
  ]);
  useRunbookStore.getState().selectHistoryRun("run-failed");
});

describe("RunbookHistory", () => {
  it("settles on the empty state without automatically loading again", async () => {
    useRunbookStore.getState().setHistory([]);
    useRunbookStore.getState().selectHistoryRun(null);

    render(<RunbookHistory />);

    expect(await screen.findByText("No run history")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(mocks.loadHistory).not.toHaveBeenCalled();
  });

  it("shows the pending state for an initial history load without starting another request", () => {
    useRunbookStore.getState().setHistory([]);
    useRunbookStore.getState().selectHistoryRun(null);
    useRunbookStore.getState().setLoading("history", true);

    render(<RunbookHistory />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No run history")).not.toBeInTheDocument();
    expect(mocks.loadHistory).not.toHaveBeenCalled();
  });

  it("loads history exactly once for an explicit refresh", async () => {
    useRunbookStore.getState().setHistory([]);
    useRunbookStore.getState().selectHistoryRun(null);

    render(<RunbookHistory />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));

    await waitFor(() => expect(mocks.loadHistory).toHaveBeenCalledTimes(1));
  });

  it("requires a second explicit click before deleting a terminal run", async () => {
    render(<RunbookHistory />);

    fireEvent.click(screen.getByRole("button", { name: "Delete run" }));
    expect(mocks.deleteRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete run" }));
    await waitFor(() => expect(mocks.deleteRun).toHaveBeenCalledWith("run-failed"));
  });
});
