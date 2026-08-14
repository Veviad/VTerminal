import { create } from "zustand";

import { isTerminalRunState } from "../lib/runbooks";
import type {
  RunbookDefinition,
  RunbookEvent,
  RunbookHistoryEntry,
  RunbookReport,
  RunbookRun,
  RunbookSource,
  RunbookStepRun,
} from "../lib/runbooks";

export type RunbooksView = "library" | "run" | "history";

export interface RunbookStoreState {
  workspaceOpen: boolean;
  view: RunbooksView;
  sources: RunbookSource[];
  selectedSourceId: string | null;
  definition: RunbookDefinition | null;
  /** Durable live-run registry. `activeRun` is only the run selected in the UI. */
  runsById: Record<string, RunbookRun>;
  activeRun: RunbookRun | null;
  /** Bumped by every event that names a run.
   *
   * A durable `runbooks_get` is a snapshot of the moment it was ISSUED, but it
   * is applied whenever it happens to come back. Without this, a read issued
   * before an approval existed lands after `ApprovalRequested` and erases it —
   * the run then sits on a spinner while the engine waits for a click the
   * operator can no longer make. Callers capture this before the request and
   * hand it back, and a snapshot older than the newest event is dropped.
   *
   * A `Map` rather than a record: the key is a run id from the backend, and a
   * plain object indexed by it is both a lint sink and reachable by
   * `__proto__`. */
  runRevisions: ReadonlyMap<string, number>;
  history: RunbookHistoryEntry[];
  selectedHistoryRunId: string | null;
  report: RunbookReport | null;
  events: RunbookEvent[];
  loadingLibrary: boolean;
  loadingDefinition: boolean;
  loadingHistory: boolean;
  loadingReport: boolean;
  busyAction: string | null;
  error: string | null;
  notice: string | null;

  setWorkspaceOpen(open: boolean): void;
  setView(view: RunbooksView): void;
  setSources(sources: RunbookSource[]): void;
  upsertSource(source: RunbookSource): void;
  deleteSource(sourceId: string): void;
  selectSource(sourceId: string | null): void;
  setDefinition(definition: RunbookDefinition | null): void;
  setActiveRun(run: RunbookRun | null): void;
  /** `issuedAtRevision` makes the write conditional: pass the value
   * `runRevisions[runId]` held when the fetch started and the snapshot is
   * discarded if any event has landed since. Omit it for an operator-initiated
   * read, which is authoritative by definition. */
  upsertRun(run: RunbookRun, issuedAtRevision?: number): void;
  updateStep(step: RunbookStepRun): void;
  setHistory(history: RunbookHistoryEntry[]): void;
  deleteHistoryRun(runId: string): void;
  selectHistoryRun(runId: string | null): void;
  setReport(report: RunbookReport | null): void;
  dispatchEvent(event: RunbookEvent): void;
  setLoading(key: LoadingKey, loading: boolean): void;
  setBusyAction(action: string | null): void;
  setError(error: string | null): void;
  setNotice(notice: string | null): void;
  reset(): void;
}

type LoadingKey = "library" | "definition" | "history" | "report";

interface RunbookStoreData {
  workspaceOpen: boolean;
  view: RunbooksView;
  sources: RunbookSource[];
  selectedSourceId: string | null;
  definition: RunbookDefinition | null;
  runsById: Record<string, RunbookRun>;
  activeRun: RunbookRun | null;
  runRevisions: ReadonlyMap<string, number>;
  history: RunbookHistoryEntry[];
  selectedHistoryRunId: string | null;
  report: RunbookReport | null;
  events: RunbookEvent[];
  loadingLibrary: boolean;
  loadingDefinition: boolean;
  loadingHistory: boolean;
  loadingReport: boolean;
  busyAction: string | null;
  error: string | null;
  notice: string | null;
}

const emptyState = (): RunbookStoreData => ({
  workspaceOpen: false,
  view: "library",
  sources: [],
  selectedSourceId: null,
  definition: null,
  runsById: {},
  activeRun: null,
  runRevisions: new Map<string, number>(),
  history: [],
  selectedHistoryRunId: null,
  report: null,
  events: [],
  loadingLibrary: false,
  loadingDefinition: false,
  loadingHistory: false,
  loadingReport: false,
  busyAction: null,
  error: null,
  notice: null,
});

const MAX_EVENTS = 200;

export const useRunbookStore = create<RunbookStoreState>((set) => ({
  ...emptyState(),

  setWorkspaceOpen: (workspaceOpen) => set({ workspaceOpen }),
  setView: (view) => set({ view, error: null, notice: null }),
  setSources: (sources) => set({ sources }),
  upsertSource: (source) =>
    set((state) => {
      const found = state.sources.some((item) => item.source_id === source.source_id);
      const sources = found
        ? state.sources.map((item) => (item.source_id === source.source_id ? source : item))
        : [source, ...state.sources];
      // Imports remain newest-first within their group, while bundled examples
      // always retain the first positions supplied by the backend.
      return {
        sources: [...sources].sort(
          (left, right) => Number(left.source_kind === "user") - Number(right.source_kind === "user"),
        ),
      };
    }),
  deleteSource: (sourceId) =>
    set((state) => ({
      sources: state.sources.filter((source) => source.source_id !== sourceId),
      selectedSourceId:
        state.selectedSourceId === sourceId ? null : state.selectedSourceId,
      definition: state.selectedSourceId === sourceId ? null : state.definition,
    })),
  selectSource: (selectedSourceId) =>
    set({ selectedSourceId, definition: null, error: null, notice: null }),
  setDefinition: (definition) => set({ definition }),
  setActiveRun: (activeRun) =>
    set((state) => {
      if (!activeRun) return { activeRun: null };
      const current = state.runsById[activeRun.run_id] ??
        (state.activeRun?.run_id === activeRun.run_id ? state.activeRun : null);
      const merged = mergeRun(current, activeRun);
      return {
        activeRun: merged,
        runsById: { ...state.runsById, [merged.run_id]: merged },
      };
    }),
  upsertRun: (run, issuedAtRevision) =>
    set((state) => {
      if (
        issuedAtRevision !== undefined &&
        (state.runRevisions.get(run.run_id) ?? 0) !== issuedAtRevision
      ) {
        // An event landed while this snapshot was in flight, so it describes a
        // moment that has already been overtaken. Applying it would undo the
        // event — most visibly by clearing a pending approval that has just
        // arrived, which leaves the run spinning with nothing to approve.
        return state;
      }
      const current = state.runsById[run.run_id] ??
        (state.activeRun?.run_id === run.run_id ? state.activeRun : null);
      const merged = mergeRun(current, run);
      return {
        runsById: { ...state.runsById, [run.run_id]: merged },
        activeRun: state.activeRun?.run_id === run.run_id ? merged : state.activeRun,
      };
    }),
  updateStep: (step) =>
    set((state) => {
      if (!state.activeRun) return state;
      const nextRun = {
        ...state.activeRun,
        active_step_id: step.id,
        steps: state.activeRun.steps.map((item) =>
          item.id === step.id ? step : item,
        ),
      };
      return {
        activeRun: nextRun,
        runsById: { ...state.runsById, [nextRun.run_id]: nextRun },
      };
    }),
  setHistory: (history) => set({ history }),
  deleteHistoryRun: (runId) =>
    set((state) => {
      const runsById = { ...state.runsById };
      delete runsById[runId];
      return {
        history: state.history.filter((run) => run.run_id !== runId),
        selectedHistoryRunId:
          state.selectedHistoryRunId === runId ? null : state.selectedHistoryRunId,
        report: state.report?.run_id === runId ? null : state.report,
        activeRun: state.activeRun?.run_id === runId ? null : state.activeRun,
        runsById,
      };
    }),
  selectHistoryRun: (selectedHistoryRunId) =>
    set({ selectedHistoryRunId, report: null, error: null, notice: null }),
  setReport: (report) => set({ report }),
  dispatchEvent: (event) =>
    set((state) => {
      const events = [...state.events, event].slice(-MAX_EVENTS);
      const eventRunId = event.run_id ?? null;
      const run = eventRunId
        ? state.runsById[eventRunId] ??
          (state.activeRun?.run_id === eventRunId ? state.activeRun : null)
        : null;

      // Every event for a run advances its revision, including the ones that
      // change nothing here. A durable snapshot issued before this point is
      // stale whatever the event said, because the row it read has moved on.
      const runRevisions = eventRunId
        ? new Map(state.runRevisions).set(
            eventRunId,
            (state.runRevisions.get(eventRunId) ?? 0) + 1,
          )
        : state.runRevisions;

      const withRun = (next: RunbookRun) => ({
        events,
        runRevisions,
        runsById: { ...state.runsById, [next.run_id]: next },
        activeRun: state.activeRun?.run_id === next.run_id ? next : state.activeRun,
      });

      switch (event.type) {
        case "RunStarted":
          return {
            events,
            runRevisions,
            error: null,
          };
        case "StepChanged": {
          if (!run || run.run_id !== event.run_id) return { events, runRevisions };
          return withRun({
              ...run,
              active_step_id: event.step_id,
              active_phase: event.phase,
              steps: replaceStep(run.steps, {
                ...(run.steps.find((step) => step.id === event.step_id) ?? {
                  id: event.step_id,
                }),
                status: event.status,
                phase: event.phase,
              }),
          });
        }
        case "ApprovalRequested":
          if (!run || run.run_id !== event.run_id) return { events, runRevisions };
          return withRun({
              ...run,
              status: "waiting_approval",
              pending_approval_id: event.approval_id,
              pending_approval: event,
          });
        case "RunInTerminal":
          return { events, runRevisions };
        case "OperatorDecisionRequired":
          if (!run || run.run_id !== event.run_id) return { events, runRevisions };
          return withRun({
              ...run,
              status: "waiting_operator",
              pause_reason: event.reason,
              pending_operator: event,
              pending_manual: event.manual ?? run.pending_manual,
          });
        case "ReportReady":
          if (!run || run.run_id !== event.run_id) return { events, runRevisions };
          return withRun({ ...run, report_ready: true });
        case "RunFinished":
          if (!run || run.run_id !== event.run_id) return { events, runRevisions };
          return withRun({
              ...run,
              status: event.state,
              pending_approval_id: null,
              finished_at: run.finished_at ?? new Date().toISOString(),
              pending_approval: null,
              pending_operator: null,
              pending_manual: null,
          });
        case "Error":
          return { events, runRevisions, error: event.message };
      }
    }),
  setLoading: (key, loading) => {
    const field: Record<LoadingKey, keyof RunbookStoreData> = {
      library: "loadingLibrary",
      definition: "loadingDefinition",
      history: "loadingHistory",
      report: "loadingReport",
    };
    set({ [field[key]]: loading } as Partial<RunbookStoreState>);
  },
  setBusyAction: (busyAction) => set({ busyAction }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  reset: () => set(emptyState()),
}));

function mergeRun(current: RunbookRun | null, incoming: RunbookRun): RunbookRun {
  if (!current) return incoming;
  return {
    ...current,
    ...incoming,
    // Durable refreshes/resume responses from older backends may omit UI
    // preflight metadata. Never lose target/evidence data needed by another
    // concurrently running terminal dispatch.
    source_id: incoming.source_id ?? current.source_id,
    definition_id: incoming.definition_id ?? current.definition_id,
    definition_version: incoming.definition_version ?? current.definition_version,
    definition_title: incoming.definition_title ?? current.definition_title,
    inputs: incoming.inputs ?? current.inputs,
    evidence_mode: incoming.evidence_mode ?? current.evidence_mode,
    steps: incoming.steps.map((step) => ({
      ...current.steps.find((item) => item.id === step.id),
      ...step,
    })),
    pending_approval:
      incoming.pending_approval !== undefined
        ? incoming.pending_approval
        : incoming.pending_approval_id &&
            current.pending_approval?.approval_id === incoming.pending_approval_id
          ? current.pending_approval
          : null,
    pending_operator:
      incoming.pending_operator !== undefined
        ? incoming.pending_operator
        : incoming.status === "waiting_operator" &&
            current.pending_operator?.run_id === incoming.run_id &&
            current.pending_operator.step_id === incoming.active_step_id
          ? current.pending_operator
          : null,
    pending_manual:
      incoming.pending_manual !== undefined
        ? incoming.pending_manual
        : incoming.status === "waiting_operator" &&
            current.pending_manual?.run_id === incoming.run_id &&
            current.pending_manual.step_id === incoming.active_step_id
          ? current.pending_manual
          : null,
  };
}

/** Runs that are still going. Terminal runs stay in `runsById` so their report
 * remains openable, so membership there is NOT liveness. */
export function selectLiveRunbookRuns(
  runsById: Record<string, RunbookRun>,
): RunbookRun[] {
  return Object.values(runsById).filter((run) => !isTerminalRunState(run.status));
}

/** The one run allowed to occupy the header slot, or null for the neutral
 * launcher. `activeRun` is only the UI SELECTION and deliberately outlives its
 * run so the end-of-run report stays open — treating it as "a run is live" is
 * what pinned a finished run's pill to the header until the app restarted. */
export function selectLiveRunbookRun(
  activeRun: RunbookRun | null,
  runsById: Record<string, RunbookRun>,
): RunbookRun | null {
  if (activeRun && !isTerminalRunState(activeRun.status)) return activeRun;
  return selectLiveRunbookRuns(runsById)[0] ?? null;
}

function replaceStep(steps: RunbookStepRun[], next: RunbookStepRun): RunbookStepRun[] {
  const found = steps.some((step) => step.id === next.id);
  return found
    ? steps.map((step) => (step.id === next.id ? next : step))
    : [...steps, next];
}

export const EMPTY_RUNBOOK_SOURCES: RunbookSource[] = [];
export const EMPTY_RUNBOOK_HISTORY: RunbookHistoryEntry[] = [];
