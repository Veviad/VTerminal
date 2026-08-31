import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() =>
  vi.fn(async (_name: string, _cb: (event: { payload: unknown }) => void) => () => {}),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import {
  emptyScheduleInput,
  isTerminalScheduleRunStatus,
  machineTimezone,
  newStepId,
  onScheduleFire,
  onScheduleRunNotice,
  SCHEDULE_PERMISSION_MODES,
  scheduleCreate,
  scheduleDelete,
  scheduleGet,
  schedulePreview,
  scheduleRunAttach,
  scheduleRunCancel,
  scheduleRunFinish,
  scheduleRunGet,
  scheduleRunIsActive,
  scheduleRunNow,
  scheduleRunsList,
  scheduleRunsPrune,
  scheduleSetEnabled,
  scheduleStepBegin,
  scheduleStepFinish,
  schedulesList,
  scheduleUpdate,
  scheduleValidate,
  toScheduleInput,
  type ScheduleAction,
} from "../lib/schedules";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  listenMock.mockClear();
});

/** Every `scheduled_*` command is `rename_all = "snake_case"` in Rust, while
 *  Tauri's default is camelCase. Getting this backwards is SILENT: the parameter
 *  simply arrives as its serde default, which for an id means an empty string. */
describe("schedules API argument casing", () => {
  it("sends snake_case keys for every id-bearing command", async () => {
    const cases: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [() => scheduleGet("a1"), "scheduled_action_get", { id: "a1" }],
      [
        () => scheduleSetEnabled("a1", false),
        "scheduled_action_set_enabled",
        { id: "a1", enabled: false },
      ],
      [() => scheduleDelete("a1"), "scheduled_action_delete", { id: "a1" }],
      [() => scheduleRunNow("a1"), "scheduled_action_run_now", { id: "a1" }],
      [() => scheduleRunCancel("r1"), "scheduled_run_cancel", { run_id: "r1" }],
      [() => scheduleRunGet("r1"), "scheduled_run_get", { run_id: "r1" }],
      [
        () => scheduleRunsList("a1", 10),
        "scheduled_runs_list",
        { action_id: "a1", limit: 10 },
      ],
      [
        () => scheduleRunsPrune("2026-01-01T00:00:00Z"),
        "scheduled_runs_prune",
        { before: "2026-01-01T00:00:00Z" },
      ],
      [
        () => scheduleRunAttach("r1", "s1", "h1", 120, 40),
        "scheduled_run_attach",
        { run_id: "r1", session_id: "s1", remote_host_id: "h1", cols: 120, rows: 40 },
      ],
      [
        () => scheduleStepBegin("r1", "s1", 2, "command", "Step 3"),
        "scheduled_step_begin",
        { run_id: "r1", step_id: "s1", sort_order: 2, kind: "command", title: "Step 3" },
      ],
      [
        () => scheduleStepFinish("r1", "att1", { status: "succeeded" }),
        "scheduled_step_finish",
        { run_id: "r1", attempt_id: "att1", result: { status: "succeeded" } },
      ],
      [
        () => scheduleRunFinish("r1", "failed", "boom"),
        "scheduled_run_finish",
        { run_id: "r1", status: "failed", error: "boom" },
      ],
      [
        () => scheduleRunIsActive("r1"),
        "scheduled_run_is_active",
        { run_id: "r1" },
      ],
    ];
    for (const [call, command, args] of cases) {
      invokeMock.mockClear();
      await call();
      expect(invokeMock).toHaveBeenCalledWith(command, args);
    }
  });

  it("sends the recurrence under its own parameter name for the preview", async () => {
    invokeMock.mockResolvedValue([]);
    await schedulePreview({ kind: "interval", every_minutes: 30 }, 5);
    expect(invokeMock).toHaveBeenCalledWith("scheduled_action_preview", {
      recurrence_rule: { kind: "interval", every_minutes: 30 },
      count: 5,
    });
  });

  it("passes the whole input object for create, update and validate", async () => {
    const input = emptyScheduleInput();
    await scheduleCreate(input);
    expect(invokeMock).toHaveBeenCalledWith("scheduled_action_create", { input });
    await scheduleUpdate("a1", input);
    expect(invokeMock).toHaveBeenCalledWith("scheduled_action_update", { id: "a1", input });
    await scheduleValidate(input);
    expect(invokeMock).toHaveBeenCalledWith("scheduled_action_validate", { input });
  });

  it("takes no arguments to list", async () => {
    invokeMock.mockResolvedValue([]);
    await schedulesList();
    expect(invokeMock).toHaveBeenCalledWith("scheduled_actions_list");
  });

  it("defaults the run list to every action", async () => {
    invokeMock.mockResolvedValue([]);
    await scheduleRunsList();
    expect(invokeMock).toHaveBeenCalledWith("scheduled_runs_list", {
      action_id: null,
      limit: 50,
    });
  });
});

describe("schedules event subscriptions", () => {
  it("subscribes to the app-level fire and run events", async () => {
    await onScheduleFire(() => {});
    expect(listenMock).toHaveBeenCalledWith("scheduled://fire", expect.any(Function));
    await onScheduleRunNotice(() => {});
    expect(listenMock).toHaveBeenCalledWith("scheduled://run", expect.any(Function));
  });

  it("unwraps the payload for the handler", async () => {
    const handlers: ((e: { payload: unknown }) => void)[] = [];
    listenMock.mockImplementation(async (_name, cb) => {
      handlers.push(cb);
      return () => {};
    });
    const seen: unknown[] = [];
    await onScheduleRunNotice((notice) => seen.push(notice));
    handlers[0]({ payload: { run_id: "r1", action_id: "a1", status: "succeeded" } });
    expect(seen).toEqual([{ run_id: "r1", action_id: "a1", status: "succeeded" }]);
  });
});

describe("schedules helpers", () => {
  /** `full` is absent from the union AND from the v20 CHECK constraint. A
   *  schedule may not hold the mode that authorizes privileged and unreviewable
   *  commands with nobody watching. */
  it("never offers the Full permission mode", () => {
    expect(SCHEDULE_PERMISSION_MODES).not.toContain("full" as never);
    expect(SCHEDULE_PERMISSION_MODES).toEqual([
      "ask",
      "auto_read",
      "auto_smart",
      "auto_all",
    ]);
  });

  it("defaults a new action to headless and to authorizing nothing", () => {
    const input = emptyScheduleInput();
    // Headless by default because tab mode depends on webview timers that are
    // throttled exactly when a schedule fires.
    expect(input.execution_mode).toBe("headless");
    expect(input.permission_mode).toBe("ask");
    expect(input.web_access).toBe(false);
    expect(input.missed_run_policy).toBe("skip");
    expect(input.timezone).toBe(machineTimezone());
    expect(input.steps).toHaveLength(1);
  });

  it("mints distinct step ids", () => {
    expect(newStepId()).not.toBe(newStepId());
  });

  it("classifies terminal run statuses", () => {
    for (const status of ["succeeded", "failed", "cancelled", "skipped", "interrupted"] as const) {
      expect(isTerminalScheduleRunStatus(status)).toBe(true);
    }
    for (const status of ["pending", "awaiting_target", "running"] as const) {
      expect(isTerminalScheduleRunStatus(status)).toBe(false);
    }
  });

  /** Round-tripping an engine-owned field back through create/update is how a
   *  frontend accidentally claims authority it does not have. */
  it("strips engine-owned fields when an action becomes an input", () => {
    const action: ScheduleAction = {
      ...emptyScheduleInput(),
      id: "a1",
      name: "nightly",
      steps_sha256: "sha",
      armed_at: "2026-01-01T00:00:00Z",
      next_fire_at: "2026-06-02T01:00:00Z",
      last_status: "succeeded",
      created_at: "t",
      updated_at: "t",
    };
    const input = toScheduleInput(action) as unknown as Record<string, unknown>;
    for (const key of [
      "id",
      "armed_at",
      "steps_sha256",
      "next_fire_at",
      "last_status",
      "created_at",
      "updated_at",
    ]) {
      expect(input[key]).toBeUndefined();
    }
    expect(input.name).toBe("nightly");
  });

  it("renumbers steps when converting to an input", () => {
    const action: ScheduleAction = {
      ...emptyScheduleInput(),
      id: "a1",
      steps_sha256: "sha",
      created_at: "t",
      updated_at: "t",
      steps: [
        { id: "b", sort_order: 7, title: "B", kind: "command", text: "b", continue_on_failure: false },
        { id: "a", sort_order: 3, title: "A", kind: "prompt", text: "a", continue_on_failure: true },
      ],
    };
    expect(toScheduleInput(action).steps.map((s) => s.sort_order)).toEqual([0, 1]);
  });
});
