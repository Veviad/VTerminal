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

  it("switches views from the tab strip", async () => {
    await mount();
    await act(async () => {
      screen.getByText(S.schedules.views.runs).click();
    });
    expect(useScheduleStore.getState().view).toBe("runs");
  });
});
