import { beforeEach, describe, expect, it } from "vitest";

import {
  openRightPanel,
  resolveRightPanel,
  toggleRightPanel,
  type RightPanel,
} from "../lib/rightPanel";
import { useAppStore } from "../stores/appStore";
import { useRunbookStore } from "../stores/runbookStore";
import { useScheduleStore } from "../stores/scheduleStore";

describe("right panel resolution", () => {
  beforeEach(() => {
    useAppStore.setState({ runbooksEnabled: true, schedulesEnabled: true });
    useRunbookStore.getState().setWorkspaceOpen(false);
    useScheduleStore.getState().setWorkspaceOpen(false);
  });

  /** The point of a resolver: every combination has ONE stated answer, rather
   *  than whichever branch a JSX ternary happens to reach first. */
  it("is total and deterministic across every flag and open combination", () => {
    const seen = new Set<string>();
    for (const runbooksEnabled of [false, true]) {
      for (const runbooksOpen of [false, true]) {
        for (const schedulesEnabled of [false, true]) {
          for (const schedulesOpen of [false, true]) {
            const input = {
              runbooksEnabled,
              runbooksOpen,
              schedulesEnabled,
              schedulesOpen,
            };
            const panel: RightPanel = resolveRightPanel(input);
            expect(["ai", "runbooks", "schedules"]).toContain(panel);
            // Same input, same answer.
            expect(resolveRightPanel(input)).toBe(panel);
            seen.add(JSON.stringify(input));
          }
        }
      }
    }
    expect(seen.size).toBe(16);
  });

  it("never gives the slot to a disabled feature", () => {
    expect(
      resolveRightPanel({
        runbooksEnabled: false,
        runbooksOpen: true,
        schedulesEnabled: false,
        schedulesOpen: true,
      }),
    ).toBe("ai");
  });

  it("resolves the both-open case rather than leaving it to render order", () => {
    expect(
      resolveRightPanel({
        runbooksEnabled: true,
        runbooksOpen: true,
        schedulesEnabled: true,
        schedulesOpen: true,
      }),
    ).toBe("runbooks");
  });

  it("closes the other panel when one opens, so both-open is unreachable", () => {
    openRightPanel("schedules");
    expect(useScheduleStore.getState().workspaceOpen).toBe(true);
    expect(useRunbookStore.getState().workspaceOpen).toBe(false);

    openRightPanel("runbooks");
    expect(useRunbookStore.getState().workspaceOpen).toBe(true);
    expect(useScheduleStore.getState().workspaceOpen).toBe(false);

    openRightPanel("ai");
    expect(useRunbookStore.getState().workspaceOpen).toBe(false);
    expect(useScheduleStore.getState().workspaceOpen).toBe(false);
  });

  it("closes Settings when a panel opens, matching the existing Header discipline", () => {
    useAppStore.getState().setSettingsOpen(true);
    openRightPanel("schedules");
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });

  it("toggles back to the AI panel", () => {
    toggleRightPanel("schedules");
    expect(useScheduleStore.getState().workspaceOpen).toBe(true);
    toggleRightPanel("schedules");
    expect(useScheduleStore.getState().workspaceOpen).toBe(false);
  });
});
