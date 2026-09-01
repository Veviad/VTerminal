import { beforeEach, describe, expect, it } from "vitest";

import {
  blockingIssues,
  selectLiveScheduleRun,
  selectLiveScheduleRuns,
  selectOverdueActions,
  useScheduleStore,
} from "../stores/scheduleStore";
import { emptyScheduleInput, type ScheduleAction, type ScheduleRun } from "../lib/schedules";

function action(overrides: Partial<ScheduleAction> = {}): ScheduleAction {
  return {
    ...emptyScheduleInput(),
    id: "a1",
    name: "nightly",
    steps_sha256: "sha",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: "r1",
    action_id: "a1",
    action_name: "nightly",
    plan_sha256: "sha",
    trigger: "schedule",
    execution_mode: "headless",
    permission_mode: "auto_read",
    target_kind: "local_shell",
    target_label: "local shell",
    status: "running",
    web_access: false,
    app_version: "0.5.7",
    scheduled_for: "2026-06-02T01:00:00Z",
    created_at: "2026-06-02T01:00:00Z",
    prompt_tokens: 0,
    completion_tokens: 0,
    attempts: [],
    ...overrides,
  };
}

describe("schedule store", () => {
  beforeEach(() => {
    useScheduleStore.getState().reset();
  });

  /** The runbook lesson, transplanted: a snapshot is of the moment it was
   *  ISSUED but applied whenever it comes back. */
  it("drops a run snapshot older than the newest notice", () => {
    const store = useScheduleStore.getState();
    store.upsertRun(run({ status: "running" }));
    const issuedAt = store.revisionOf("r1");

    // A terminal notice lands while the read is in flight.
    store.noteRunEvent({ run_id: "r1", action_id: "a1", status: "succeeded" });
    expect(useScheduleStore.getState().runsById.r1.status).toBe("succeeded");

    // The stale read must NOT erase it.
    useScheduleStore.getState().upsertRun(run({ status: "running" }), issuedAt);
    expect(useScheduleStore.getState().runsById.r1.status).toBe("succeeded");

    // A read issued after the notice is applied normally.
    const fresh = useScheduleStore.getState().revisionOf("r1");
    useScheduleStore.getState().upsertRun(run({ status: "failed" }), fresh);
    expect(useScheduleStore.getState().runsById.r1.status).toBe("failed");
  });

  it("an unversioned upsert always applies", () => {
    const store = useScheduleStore.getState();
    store.noteRunEvent({ run_id: "r1", action_id: "a1", status: "succeeded" });
    store.upsertRun(run({ status: "cancelled" }));
    expect(useScheduleStore.getState().runsById.r1.status).toBe("cancelled");
  });

  it("never lets a terminal run hold the live badge", () => {
    const store = useScheduleStore.getState();
    store.upsertRun(run({ id: "done", status: "succeeded" }));
    store.selectRun("done");
    expect(selectLiveScheduleRun("done", useScheduleStore.getState().runsById)).toBeNull();

    useScheduleStore.getState().upsertRun(run({ id: "live", status: "running" }));
    const runs = useScheduleStore.getState().runsById;
    expect(selectLiveScheduleRun("done", runs)?.id).toBe("live");
    expect(selectLiveScheduleRuns(runs).map((r) => r.id)).toEqual(["live"]);
  });

  it("keeps terminal runs in the registry so their detail stays openable", () => {
    const store = useScheduleStore.getState();
    store.upsertRun(run({ id: "done", status: "succeeded" }));
    expect(useScheduleStore.getState().runsById.done).toBeTruthy();
  });

  it("edits the draft without touching the stored actions", () => {
    const store = useScheduleStore.getState();
    const stored = action({ name: "nightly" });
    store.setActions([stored]);
    store.beginDraft(stored);
    useScheduleStore.getState().patchDraft({ name: "renamed" });
    expect(useScheduleStore.getState().draft?.input.name).toBe("renamed");
    expect(useScheduleStore.getState().actions[0].name).toBe("nightly");
    expect(useScheduleStore.getState().draftDirty).toBe(true);
  });

  /** Indexes as React keys plus reorder is the classic bug where a textarea
   *  keeps the previous row's text; the ids have to survive the move. */
  it("reorders steps while preserving their content and ids", () => {
    const store = useScheduleStore.getState();
    store.beginDraft(null);
    useScheduleStore.getState().addStep("prompt");
    useScheduleStore.getState().patchStep(0, { text: "first" });
    useScheduleStore.getState().patchStep(1, { text: "second" });
    const ids = useScheduleStore.getState().draft!.input.steps.map((s) => s.id);

    useScheduleStore.getState().moveStep(0, 1);
    const steps = useScheduleStore.getState().draft!.input.steps;
    expect(steps.map((s) => s.text)).toEqual(["second", "first"]);
    expect(steps.map((s) => s.id)).toEqual([ids[1], ids[0]]);
    // `sort_order` is renumbered, because it is what SQLite's UNIQUE relies on.
    expect(steps.map((s) => s.sort_order)).toEqual([0, 1]);
  });

  it("ignores an out-of-range move rather than dropping a step", () => {
    const store = useScheduleStore.getState();
    store.beginDraft(null);
    useScheduleStore.getState().moveStep(0, -1);
    expect(useScheduleStore.getState().draft!.input.steps).toHaveLength(1);
    useScheduleStore.getState().moveStep(0, 5);
    expect(useScheduleStore.getState().draft!.input.steps).toHaveLength(1);
  });

  it("renumbers after a removal", () => {
    const store = useScheduleStore.getState();
    store.beginDraft(null);
    useScheduleStore.getState().addStep("command");
    useScheduleStore.getState().addStep("command");
    useScheduleStore.getState().removeStep(1);
    expect(
      useScheduleStore.getState().draft!.input.steps.map((s) => s.sort_order),
    ).toEqual([0, 1]);
  });

  it("a new draft starts at `ask`, so it authorizes nothing until armed", () => {
    useScheduleStore.getState().beginDraft(null);
    expect(useScheduleStore.getState().draft?.input.permission_mode).toBe("ask");
  });

  it("reports overdue actions from the clock, and only enabled ones", () => {
    const now = Date.parse("2026-06-02T09:00:00Z");
    const overdue = action({ id: "late", next_fire_at: "2026-06-02T03:00:00Z" });
    const future = action({ id: "soon", next_fire_at: "2026-06-02T12:00:00Z" });
    const off = action({
      id: "off",
      enabled: false,
      next_fire_at: "2026-06-02T03:00:00Z",
    });
    const unscheduled = action({ id: "none", next_fire_at: null });
    expect(
      selectOverdueActions([overdue, future, off, unscheduled], now).map((a) => a.id),
    ).toEqual(["late"]);
  });

  it("separates blocking issues from advisories", () => {
    const issues = [
      { field: "name", message: "required", blocking: true },
      { field: "steps.0", message: "reaches the network", blocking: false },
    ];
    expect(blockingIssues(issues).map((i) => i.field)).toEqual(["name"]);
  });

  it("reset clears the revision map as well as the rows", () => {
    const store = useScheduleStore.getState();
    store.noteRunEvent({ run_id: "r1", action_id: "a1", status: "running" });
    expect(store.revisionOf("r1")).toBeGreaterThan(0);
    useScheduleStore.getState().reset();
    expect(useScheduleStore.getState().revisionOf("r1")).toBe(0);
    expect(useScheduleStore.getState().runsById).toEqual({});
  });
});
