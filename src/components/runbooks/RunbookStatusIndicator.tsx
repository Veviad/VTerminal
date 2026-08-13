import { CheckCircle2, ListChecks, Loader2, PauseCircle, TriangleAlert } from "lucide-react";

import { isCheckedStepState, isTerminalRunState } from "../../lib/runbooks";
import { useRunbookStore } from "../../stores/runbookStore";
import { humanizeRunbookState, runStateTone } from "./runbookUi";

/** Compact companion for the header/status bar while the workspace is closed. */
export function RunbookStatusIndicator({
  className = "",
  onOpen,
}: {
  className?: string;
  onOpen?(): void;
}) {
  const open = useRunbookStore((state) => state.workspaceOpen);
  const selectedRun = useRunbookStore((state) => state.activeRun);
  const runsById = useRunbookStore((state) => state.runsById);
  const setWorkspaceOpen = useRunbookStore((state) => state.setWorkspaceOpen);
  const setActiveRun = useRunbookStore((state) => state.setActiveRun);
  const liveRuns = Object.values(runsById).filter((candidate) => !isTerminalRunState(candidate.status));
  const run = selectedRun ?? liveRuns[0] ?? null;
  if (open || !run) return null;

  const checked = run.steps.filter((step) => isCheckedStepState(step.status)).length;
  const icon = isTerminalRunState(run.status) ? (
    run.status === "succeeded" ? <CheckCircle2 size={11} /> : <TriangleAlert size={11} />
  ) : run.status === "paused" || run.status === "waiting_approval" || run.status === "waiting_operator" || run.status === "interrupted" ? (
    <PauseCircle size={11} />
  ) : (
    <Loader2 size={11} className="animate-spin" />
  );

  return (
    <button
      onClick={() => {
        setActiveRun(run);
        setWorkspaceOpen(true);
        onOpen?.();
      }}
      title={`Open Runbooks — ${humanizeRunbookState(run.status)}`}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors hover:bg-bg-hover ${runStateTone(run.status)} ${className}`}
    >
      {icon}
      <span className="max-w-32 truncate">{run.definition_title ?? "Runbook"}</span>
      <span className="font-mono opacity-80">{checked}/{run.steps.length}</span>
      {liveRuns.length > 1 && <span className="font-mono opacity-80">+{liveRuns.length - 1}</span>}
    </button>
  );
}

/** Always-available neutral launcher for integration points that do not have a
 * run yet (for example the main header or command palette). */
export function RunbooksLauncher({ className = "" }: { className?: string }) {
  const setWorkspaceOpen = useRunbookStore((state) => state.setWorkspaceOpen);
  return (
    <button
      onClick={() => setWorkspaceOpen(true)}
      title="Open Runbooks"
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] text-text-muted hover:bg-bg-hover hover:text-text-secondary ${className}`}
    >
      <ListChecks size={12} /> Runbooks
    </button>
  );
}
