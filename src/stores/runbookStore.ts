import { create } from "zustand";

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
  getRunById(runId: string): RunbookRun | null;
  /** Runs whose remaining approvals the operator pre-authorized. Per run,
   *  frontend-only, never persisted and never inherited by another run — the
   *  same stance as `aiStreams[id].permissionMode` in appStore. Deliberately
   *  NOT the agent's permission mode: `RunbookApprovalState` is kept separate
   *  in Rust so agent `Auto all` can never settle a runbook gate. */
  autoApproveRuns: Map<string, RunbookAutoApproveState>;
  hasAutoApproveRun(runId: string): boolean;
  getAutoApproveRunState(
    runId: string,
  ): RunbookAutoApproveState | undefined;
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
  upsertRun(run: RunbookRun): void;
  updateStep(step: RunbookStepRun): void;
  setHistory(history: RunbookHistoryEntry[]): void;
  deleteHistoryRun(runId: string): void;
  selectHistoryRun(runId: string | null): void;
  setReport(report: RunbookReport | null): void;
  dispatchEvent(event: RunbookEvent): void;
  setLoading(key: LoadingKey, loading: boolean): void;
  setAutoApprove(runId: string, on: boolean): void;
  noteAutoApproved(runId: string, approvalId: string): void;
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
  /** Runs whose remaining approvals the operator pre-authorized. Per run,
   *  frontend-only, never persisted and never inherited by another run — the
   *  same stance as `aiStreams[id].permissionMode` in appStore. Deliberately
   *  NOT the agent's permission mode: `RunbookApprovalState` is kept separate
   *  in Rust so agent `Auto all` can never settle a runbook gate. */
  autoApproveRuns: Map<string, RunbookAutoApproveState>;
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

/** Live state of run-level auto-approve. Its presence IS the armed flag; the
 *  ids are the approvals it has already granted, so a replayed
 *  `ApprovalRequested` cannot be answered twice. */
export interface RunbookAutoApproveState {
  grantedApprovalIds: string[];
}

const emptyState = (): RunbookStoreData => ({
  workspaceOpen: false,
  view: "library",
  sources: [],
  selectedSourceId: null,
  definition: null,
  runsById: {},
  activeRun: null,
  autoApproveRuns: new Map(),
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
  getRunById: (runId) => {
    const state = useRunbookStore.getState();
    const activeRun = state.activeRun;
    return (
      Object.values(state.runsById).find((item) => item.run_id === runId) ??
      (activeRun?.run_id === runId ? activeRun : null)
    );
  },
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
  upsertRun: (run) =>
    set((state) => {
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

      const withRun = (next: RunbookRun) => ({
        events,
        runsById: { ...state.runsById, [next.run_id]: next },
        activeRun: state.activeRun?.run_id === next.run_id ? next : state.activeRun,
      });

      switch (event.type) {
        case "RunStarted":
          return {
            events,
            error: null,
          };
        case "StepChanged": {
          if (!run || run.run_id !== event.run_id) return { events };
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
          if (!run || run.run_id !== event.run_id) return { events };
          return withRun({
              ...run,
              status: "waiting_approval",
              pending_approval_id: event.approval_id,
              pending_approval: event,
          });
        case "RunInTerminal":
          return { events };
        case "OperatorDecisionRequired":
          if (!run || run.run_id !== event.run_id) return { events };
          return withRun({
              ...run,
              status: "waiting_operator",
              pause_reason: event.reason,
              pending_operator: event,
              pending_manual: event.manual ?? run.pending_manual,
          });
        case "ReportReady":
          if (!run || run.run_id !== event.run_id) return { events };
          return withRun({ ...run, report_ready: true });
        case "RunFinished":
          if (!run || run.run_id !== event.run_id) return { events };
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
          return { events, error: event.message };
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
  hasAutoApproveRun: (runId) =>
    useRunbookStore.getState().autoApproveRuns.has(runId),
  getAutoApproveRunState: (runId) =>
    useRunbookStore.getState().autoApproveRuns.get(runId),
  setAutoApprove: (runId, on) =>
    set((state) => {
      if (!on) {
        if (!state.autoApproveRuns.has(runId)) return {};
        const next = new Map(state.autoApproveRuns);
        next.delete(runId);
        return { autoApproveRuns: next };
      }
      if (state.autoApproveRuns.has(runId)) return {};
      return {
        autoApproveRuns: new Map(state.autoApproveRuns).set(runId, {
          grantedApprovalIds: [],
        }),
      };
    }),
  noteAutoApproved: (runId, approvalId) =>
    set((state) => {
      const current = state.autoApproveRuns.get(runId);
      if (!current || current.grantedApprovalIds.includes(approvalId)) return {};
      const next = new Map(state.autoApproveRuns);
      next.set(runId, {
        grantedApprovalIds: [...current.grantedApprovalIds, approvalId],
      });
      return {
        autoApproveRuns: next,
      };
    }),
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

function replaceStep(steps: RunbookStepRun[], next: RunbookStepRun): RunbookStepRun[] {
  const found = steps.some((step) => step.id === next.id);
  return found
    ? steps.map((step) => (step.id === next.id ? next : step))
    : [...steps, next];
}

export const EMPTY_RUNBOOK_SOURCES: RunbookSource[] = [];
export const EMPTY_RUNBOOK_HISTORY: RunbookHistoryEntry[] = [];
