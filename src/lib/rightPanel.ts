import { useAppStore } from "../stores/appStore";
import { useRunbookStore } from "../stores/runbookStore";
import { useScheduleStore } from "../stores/scheduleStore";

/**
 * Which surface owns the right-hand slot of the terminal workspace.
 *
 * `AiPanel`, `RunbooksWorkspace` and `SchedulesWorkspace` are all `<aside>`s in
 * the same flex slot and only one can be mounted. Two independent booleans make
 * "both open" representable and let a render-order accident decide the winner,
 * so the choice is resolved by ONE total function and every opener closes the
 * others — the same discipline `Header.tsx` already applies by calling
 * `setSettingsOpen(false)` before opening Runbooks.
 *
 * Deliberately NOT a third `workspaceMode`: that value is persisted and hides
 * the terminal, and the whole point of tab-mode scheduled runs is that you may
 * want to watch one land in a tab while this panel is open.
 */
export type RightPanel = "ai" | "runbooks" | "schedules";

export interface RightPanelInput {
  runbooksEnabled: boolean;
  runbooksOpen: boolean;
  schedulesEnabled: boolean;
  schedulesOpen: boolean;
}

/** Total, and deterministic when both are somehow open. Runbooks wins that tie
 *  only because it is the older surface; the point is that the answer is stated
 *  rather than decided by whichever branch a JSX ternary reaches first. */
export function resolveRightPanel(input: RightPanelInput): RightPanel {
  if (input.runbooksEnabled && input.runbooksOpen) return "runbooks";
  if (input.schedulesEnabled && input.schedulesOpen) return "schedules";
  return "ai";
}

export function currentRightPanel(): RightPanel {
  const app = useAppStore.getState();
  return resolveRightPanel({
    runbooksEnabled: app.runbooksEnabled,
    runbooksOpen: useRunbookStore.getState().workspaceOpen,
    schedulesEnabled: app.schedulesEnabled,
    schedulesOpen: useScheduleStore.getState().workspaceOpen,
  });
}

/** Open one panel and close the others, so "both open" is unreachable in
 *  practice as well as resolvable in principle. */
export function openRightPanel(panel: RightPanel): void {
  useRunbookStore.getState().setWorkspaceOpen(panel === "runbooks");
  useScheduleStore.getState().setWorkspaceOpen(panel === "schedules");
  if (panel !== "ai") useAppStore.getState().setSettingsOpen(false);
}

export function toggleRightPanel(panel: Exclude<RightPanel, "ai">): void {
  openRightPanel(currentRightPanel() === panel ? "ai" : panel);
}

/** Subscribing hook. Reads both stores so a change in either re-renders the
 *  slot; the resolution itself stays in the pure function above. */
export function useRightPanel(): RightPanel {
  const runbooksEnabled = useAppStore((s) => s.runbooksEnabled);
  const schedulesEnabled = useAppStore((s) => s.schedulesEnabled);
  const runbooksOpen = useRunbookStore((s) => s.workspaceOpen);
  const schedulesOpen = useScheduleStore((s) => s.workspaceOpen);
  return resolveRightPanel({
    runbooksEnabled,
    runbooksOpen,
    schedulesEnabled,
    schedulesOpen,
  });
}
