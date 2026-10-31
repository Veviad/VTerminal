import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduleCreate: vi.fn(),
  scheduleUpdate: vi.fn(),
  scheduleValidate: vi.fn(),
  scheduleRunsList: vi.fn(),
  scheduleRunNow: vi.fn(),
  scheduleRunGet: vi.fn(),
  schedulesList: vi.fn(),
}));

vi.mock("../lib/schedules", async () => ({
  ...await vi.importActual<typeof import("../lib/schedules")>("../lib/schedules"),
  ...mocks,
}));
vi.mock("../hooks/useAiStream", () => ({ useAiStream: () => ({ cancel: vi.fn() }) }));

import { useSchedules } from "../hooks/useSchedules";
import { emptyScheduleInput, type ScheduleAction, type ScheduleRun, type ScheduleValidationIssue } from "../lib/schedules";
import { useScheduleStore } from "../stores/scheduleStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function action(name = "Saved name"): ScheduleAction {
  return { ...emptyScheduleInput(), id: "a1", name, steps_sha256: "sha", created_at: "t", updated_at: "t" };
}

function run(status: ScheduleRun["status"] = "running"): ScheduleRun {
  return {
    id: "r1", action_id: "a1", action_name: "nightly", plan_sha256: "sha",
    trigger: "manual", execution_mode: "headless", permission_mode: "auto_read",
    target_kind: "local_shell", target_label: "local shell", status,
    web_access: false, app_version: "0.6.13", scheduled_for: "t", created_at: "t",
    prompt_tokens: 0, completion_tokens: 0, attempts: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleStore.getState().reset();
  mocks.schedulesList.mockResolvedValue([]);
});

it("keeps typing during create and updates that same schedule on the next save", async () => {
  const pending = deferred<ScheduleAction>();
  mocks.scheduleCreate.mockReturnValue(pending.promise);
  mocks.scheduleUpdate.mockResolvedValue(action("New typing"));
  useScheduleStore.getState().beginDraft(null);
  useScheduleStore.getState().patchDraft({ name: "Saved name" });
  const { result } = renderHook(() => useSchedules());
  let saving!: Promise<ScheduleAction | null>;
  act(() => { saving = result.current.saveDraft(); });
  act(() => { useScheduleStore.getState().patchDraft({ name: "New typing" }); });
  await act(async () => { pending.resolve(action()); await saving; });
  expect(useScheduleStore.getState().draft?.input.name).toBe("New typing");
  expect(useScheduleStore.getState().draft?.actionId).toBe("a1");
  expect(useScheduleStore.getState().draftDirty).toBe(true);
  expect(useScheduleStore.getState().view).toBe("editor");
  await act(async () => { await result.current.saveDraft(); });
  expect(mocks.scheduleCreate).toHaveBeenCalledTimes(1);
  expect(mocks.scheduleUpdate).toHaveBeenCalledWith("a1", expect.objectContaining({ name: "New typing" }));
  expect(useScheduleStore.getState().draft).toBeNull();
});

it("does not discard or navigate away from a new draft when an older save completes", async () => {
  const pending = deferred<ScheduleAction>();
  mocks.scheduleCreate.mockReturnValue(pending.promise);
  useScheduleStore.getState().beginDraft(null);
  const { result } = renderHook(() => useSchedules());
  let saving!: Promise<ScheduleAction | null>;
  act(() => { saving = result.current.saveDraft(); });
  act(() => {
    useScheduleStore.getState().discardDraft();
    useScheduleStore.getState().beginDraft(null);
    useScheduleStore.getState().patchDraft({ name: "Different schedule" });
  });
  await act(async () => { pending.resolve(action()); await saving; });
  expect(useScheduleStore.getState().draft?.input.name).toBe("Different schedule");
  expect(useScheduleStore.getState().draft?.actionId).toBeNull();
  expect(useScheduleStore.getState().selectedActionId).toBeNull();
  expect(useScheduleStore.getState().view).toBe("editor");
});

it("does not create a schedule twice when save is repeated while pending", async () => {
  const pending = deferred<ScheduleAction>();
  mocks.scheduleCreate.mockReturnValue(pending.promise);
  useScheduleStore.getState().beginDraft(null);
  const { result } = renderHook(() => useSchedules());
  let saves!: Promise<unknown>;
  act(() => { saves = Promise.all([result.current.saveDraft(), result.current.saveDraft()]); });
  await act(async () => { pending.resolve(action()); await saves; });
  expect(mocks.scheduleCreate).toHaveBeenCalledTimes(1);
});

it("keeps a failed draft retryable without putting its error on another draft", async () => {
  const pending = deferred<ScheduleAction>();
  mocks.scheduleCreate.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(action("Retry"));
  useScheduleStore.getState().beginDraft(null);
  const { result } = renderHook(() => useSchedules());
  let saving!: Promise<ScheduleAction | null>;
  act(() => { saving = result.current.saveDraft(); });
  act(() => { useScheduleStore.getState().patchDraft({ name: "Retry" }); });
  await act(async () => { pending.reject(new Error("Save unavailable")); await saving; });
  expect(useScheduleStore.getState().draft?.input.name).toBe("Retry");
  expect(useScheduleStore.getState().error).toBe("Error: Save unavailable");
  await act(async () => { await result.current.saveDraft(); });
  expect(mocks.scheduleCreate).toHaveBeenCalledTimes(2);
  expect(useScheduleStore.getState().draft).toBeNull();
});

it("does not apply a discarded draft's save error to its replacement", async () => {
  const pending = deferred<ScheduleAction>();
  mocks.scheduleCreate.mockReturnValue(pending.promise);
  useScheduleStore.getState().beginDraft(null);
  const { result } = renderHook(() => useSchedules());
  let saving!: Promise<ScheduleAction | null>;
  act(() => { saving = result.current.saveDraft(); });
  act(() => { useScheduleStore.getState().beginDraft(null); });
  await act(async () => { pending.reject(new Error("Old failure")); await saving; });
  expect(useScheduleStore.getState().error).toBeNull();
});

it("does not repopulate the scheduler after feature teardown while saving and loading", async () => {
  const pendingSave = deferred<ScheduleAction>();
  const pendingActions = deferred<ScheduleAction[]>();
  const pendingHistory = deferred<ScheduleRun[]>();
  mocks.scheduleCreate.mockReturnValue(pendingSave.promise);
  mocks.schedulesList.mockReturnValue(pendingActions.promise);
  mocks.scheduleRunsList.mockReturnValue(pendingHistory.promise);
  useScheduleStore.getState().beginDraft(null);
  const { result } = renderHook(() => useSchedules());
  let requests!: Promise<unknown>;
  act(() => {
    requests = Promise.all([result.current.saveDraft(), result.current.refreshActions(), result.current.refreshHistory()]);
    useScheduleStore.getState().reset();
  });
  await act(async () => {
    pendingSave.resolve(action());
    pendingActions.resolve([action()]);
    pendingHistory.resolve([run()]);
    await requests;
  });
  expect(useScheduleStore.getState().actions).toEqual([]);
  expect(useScheduleStore.getState().history).toEqual([]);
  expect(useScheduleStore.getState().runsById).toEqual({});
});

it.each(["success", "failure"])("ignores stale validation %s after newer typing was validated", async (outcome) => {
  const pending = deferred<ScheduleValidationIssue[]>();
  mocks.scheduleValidate.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([
    { field: "name", message: "Current error", blocking: true },
  ]);
  useScheduleStore.getState().beginDraft(null);
  const { result } = renderHook(() => useSchedules());
  let first!: Promise<void>;
  act(() => { first = result.current.validateDraft(useScheduleStore.getState().draft!.input); });
  act(() => { useScheduleStore.getState().patchDraft({ name: "New typing" }); });
  await act(async () => { await result.current.validateDraft(useScheduleStore.getState().draft!.input); });
  await act(async () => {
    if (outcome === "success") pending.resolve([]);
    else pending.reject(new Error("Old failure"));
    await first;
  });
  expect(useScheduleStore.getState().issues).toEqual([{ field: "name", message: "Current error", blocking: true }]);
});

it("history loading cannot resurrect a run completed by a newer notice", async () => {
  const pending = deferred<ScheduleRun[]>();
  mocks.scheduleRunsList.mockReturnValue(pending.promise);
  useScheduleStore.getState().upsertRun(run());
  const { result } = renderHook(() => useSchedules());
  let loading!: Promise<void>;
  act(() => { loading = result.current.refreshHistory(); });
  act(() => { useScheduleStore.getState().noteRunEvent({ run_id: "r1", action_id: "a1", status: "succeeded" }); });
  await act(async () => { pending.resolve([run()]); await loading; });
  expect(useScheduleStore.getState().runsById.r1.status).toBe("succeeded");
  expect(useScheduleStore.getState().history[0].status).toBe("succeeded");
});

it("Run now's pending snapshot cannot undo a completion notice", async () => {
  const pending = deferred<ScheduleRun>();
  mocks.scheduleRunNow.mockResolvedValue("r1");
  mocks.scheduleRunGet.mockReturnValue(pending.promise);
  useScheduleStore.getState().upsertRun(run());
  const { result } = renderHook(() => useSchedules());
  let starting!: Promise<string | null>;
  await act(async () => { starting = result.current.runNow("a1"); await Promise.resolve(); });
  act(() => { useScheduleStore.getState().noteRunEvent({ run_id: "r1", action_id: "a1", status: "succeeded" }); });
  await act(async () => { pending.resolve(run()); await starting; });
  expect(useScheduleStore.getState().runsById.r1.status).toBe("succeeded");
});

it("keeps the newest history query when requests resolve out of order", async () => {
  const pending = deferred<ScheduleRun[]>();
  mocks.scheduleRunsList.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
  const { result } = renderHook(() => useSchedules());
  let oldRead!: Promise<void>;
  act(() => { oldRead = result.current.refreshHistory(); });
  await act(async () => { await result.current.refreshHistory(); });
  await act(async () => { pending.resolve([run()]); await oldRead; });
  expect(useScheduleStore.getState().history).toEqual([]);
});
