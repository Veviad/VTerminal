import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  cancelAgent: vi.fn(),
  abort: vi.fn(),
  interrupt: vi.fn(),
}));

vi.mock("../lib/schedules", () => ({ scheduleRunCancel: mocks.cancelRun }));
vi.mock("../lib/ptyExec", () => ({ abortSession: mocks.abort, interruptJob: mocks.interrupt }));
vi.mock("../hooks/useAiStream", () => ({ useAiStream: () => ({ cancel: mocks.cancelAgent }) }));

import { useSchedules } from "../hooks/useSchedules";
import { isScheduleRunRevoked, registerLiveScheduleJob, resetScheduleLiveJobsForTests } from "../lib/scheduleLiveJobs";
import { useScheduleStore } from "../stores/scheduleStore";
import { useAppStore } from "../stores/appStore";

beforeEach(() => {
  vi.clearAllMocks();
  resetScheduleLiveJobsForTests();
  useScheduleStore.getState().reset();
  useAppStore.setState({ aiStreams: {} });
  mocks.cancelRun.mockResolvedValue(undefined);
  mocks.cancelAgent.mockResolvedValue(undefined);
});

it("revokes and stops the active scheduled agent before requesting backend cancellation", async () => {
  useAppStore.setState({ aiStreams: { s1: { requestId: "request-1" } as never } });
  registerLiveScheduleJob({ runId: "r1", attemptId: "a1", sessionId: "s1", kind: "prompt", requestId: "request-1" });
  mocks.cancelRun.mockImplementation(async () => {
    expect(isScheduleRunRevoked("r1")).toBe(true);
    expect(mocks.cancelAgent).toHaveBeenCalledWith("s1");
  });
  const { result } = renderHook(() => useSchedules());
  await act(async () => { await result.current.cancelRun("r1"); });
  expect(mocks.interrupt).toHaveBeenCalledWith("s1", "a1");
  expect(mocks.abort).toHaveBeenCalledWith("s1", "cancelled", "a1");
  expect(mocks.cancelRun).toHaveBeenCalledWith("r1");
});

it("does not cancel a newer human request in the same terminal", async () => {
  useAppStore.setState({ aiStreams: { s1: { requestId: "human-request" } as never } });
  registerLiveScheduleJob({ runId: "r1", attemptId: "a1", sessionId: "s1", kind: "prompt", requestId: "old-scheduled-request" });
  const { result } = renderHook(() => useSchedules());
  await act(async () => { await result.current.cancelRun("r1"); });
  expect(mocks.cancelAgent).not.toHaveBeenCalled();
});
