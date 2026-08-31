import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  schedulesList: vi.fn(),
  scheduleRunsList: vi.fn(),
  sshHostsList: vi.fn(),
}));

vi.mock("../lib/schedules", async () => {
  const actual = await vi.importActual<typeof import("../lib/schedules")>("../lib/schedules");
  return {
    ...actual,
    schedulesList: mocks.schedulesList,
    scheduleRunsList: mocks.scheduleRunsList,
    scheduleRunGet: vi.fn(async () => null),
    scheduleValidate: vi.fn(async () => []),
    schedulePreview: vi.fn(async () => []),
  };
});

vi.mock("../lib/tauri", () => ({ sshHostsList: mocks.sshHostsList }));

import { SchedulesWorkspace } from "../components/schedules";
import { emptyScheduleInput, type ScheduleAction } from "../lib/schedules";
import { S } from "../lib/strings";
import { useRunbookStore } from "../stores/runbookStore";
import { useScheduleStore } from "../stores/scheduleStore";

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleStore.getState().reset();
  useRunbookStore.getState().setWorkspaceOpen(false);
  mocks.schedulesList.mockResolvedValue([]);
  mocks.scheduleRunsList.mockResolvedValue([]);
  mocks.sshHostsList.mockResolvedValue([]);
});

async function mount() {
  const view = render(<SchedulesWorkspace />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

function action(id: string, name: string): ScheduleAction {
  return {
    ...emptyScheduleInput(),
    id,
    name,
    steps_sha256: "sha",
    next_fire_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: "t",
    updated_at: "t",
  };
}

describe("SchedulesWorkspace", () => {
  it("renders the three sections and the empty state", async () => {
    await mount();
    // "Actions" labels both the tab and the left column, so match all.
    expect(screen.getAllByText(S.schedules.views.list).length).toBeGreaterThan(0);
    expect(screen.getByText(S.schedules.views.editor)).toBeTruthy();
    expect(screen.getByText(S.schedules.views.runs)).toBeTruthy();
    expect(screen.getAllByText(S.schedules.empty).length).toBeGreaterThan(0);
  });

  /** `RunbooksWorkspace` calls `setWorkspaceOpen(true)` on mount, which is
   *  idempotent there because it only renders when already open. With a resolver
   *  deciding the slot, a self-opening panel can resurrect itself after
   *  `openRightPanel("runbooks")` in a re-mount race. */
  it("does not open itself on mount", async () => {
    const view = await mount();
    expect(useScheduleStore.getState().workspaceOpen).toBe(false);
    view.unmount();
    expect(useScheduleStore.getState().workspaceOpen).toBe(false);
  });

  it("takes no sessionId — a scheduled target is never 'the active tab'", () => {
    // A compile-time property, asserted structurally: the component accepts no
    // props at all.
    expect(SchedulesWorkspace.length).toBe(0);
  });

  it("hydrates the library and the run history exactly once per mount", async () => {
    await mount();
    expect(mocks.schedulesList).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRunsList).toHaveBeenCalledTimes(1);
  });

  it("shows and dismisses the error strip", async () => {
    await mount();
    await act(async () => {
      useScheduleStore.getState().setError("something went wrong");
    });
    expect(screen.getByText("something went wrong")).toBeTruthy();
    await act(async () => {
      screen.getByLabelText("Dismiss error").click();
    });
    expect(screen.queryByText("something went wrong")).toBeNull();
  });

  /** The panel used to render "No scheduled actions yet" in the detail pane
   *  whenever nothing was selected — including beside a populated list, where it
   *  is simply false and invites the reader to trust the pane over the list. */
  it("selects the first action so the detail pane is never falsely empty", async () => {
    mocks.schedulesList.mockResolvedValue([action("a1", "Nightly"), action("a2", "Weekly")]);
    await mount();
    expect(useScheduleStore.getState().selectedActionId).toBe("a1");
    expect(screen.queryByText(S.schedules.empty)).toBeNull();
    // The detail pane is showing the selected action.
    expect(screen.getByRole("heading", { name: "Nightly" })).toBeTruthy();
  });

  it("still says so, and offers a first action, when there genuinely are none", async () => {
    mocks.schedulesList.mockResolvedValue([]);
    await mount();
    expect(useScheduleStore.getState().selectedActionId).toBeNull();
    expect(screen.getAllByText(S.schedules.empty).length).toBeGreaterThan(0);
    expect(screen.getByText(S.schedules.emptyHint)).toBeTruthy();
  });

  it("selects the first run rather than claiming none were recorded", async () => {
    mocks.scheduleRunsList.mockResolvedValue([
      {
        id: "r1",
        action_id: "a1",
        action_name: "Nightly",
        plan_sha256: "sha",
        trigger: "schedule",
        execution_mode: "headless",
        permission_mode: "auto_read",
        target_kind: "local_shell",
        target_label: "local shell",
        status: "succeeded",
        web_access: false,
        app_version: "0.5.7",
        scheduled_for: "2026-08-30T01:00:00Z",
        created_at: "2026-08-30T01:00:00Z",
        prompt_tokens: 0,
        completion_tokens: 0,
        attempts: [],
      },
    ]);
    await mount();
    await act(async () => {
      screen.getByText(S.schedules.views.runs).click();
      await Promise.resolve();
    });
    expect(useScheduleStore.getState().activeRunId).toBe("r1");
    expect(screen.queryByText(S.schedules.runsEmpty)).toBeNull();
  });

  it("switches views from the tab strip", async () => {
    await mount();
    await act(async () => {
      screen.getByText(S.schedules.views.runs).click();
    });
    expect(useScheduleStore.getState().view).toBe("runs");
  });
});
