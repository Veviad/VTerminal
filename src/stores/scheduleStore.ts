import { create } from "zustand";

import { ownRecordValue } from "../lib/records";

import {
  emptyScheduleInput,
  isTerminalScheduleRunStatus,
  newStepId,
  toScheduleInput,
  type ScheduleAction,
  type ScheduleActionInput,
  type ScheduleRun,
  type ScheduleRunNotice,
  type ScheduleStep,
  type ScheduleStepKind,
  type ScheduleValidationIssue,
} from "../lib/schedules";

export type SchedulesView = "list" | "editor" | "runs";

/** The editor's working copy. Never the store's `actions` entry: a half-typed
 *  recurrence must not become the thing the backend fires on. */
export interface ScheduleDraft {
  /** null while creating. */
  actionId: string | null;
  input: ScheduleActionInput;
  /** The mode the stored action already had, so the editor can say when saving
   *  will re-arm rather than preserve an existing authorization. */
  storedPermissionMode: ScheduleActionInput["permission_mode"] | null;
  storedStepsSha256: string | null;
}

export interface ScheduleStoreState {
  workspaceOpen: boolean;
  view: SchedulesView;

  actions: ScheduleAction[];
  selectedActionId: string | null;
  loadingActions: boolean;

  draft: ScheduleDraft | null;
  draftDirty: boolean;
  issues: ScheduleValidationIssue[];

  /** Durable run registry. Terminal runs stay here so their detail remains
   *  openable — membership is NOT liveness, which is what
   *  `selectLiveScheduleRun` is for. */
  runsById: Record<string, ScheduleRun>;
  activeRunId: string | null;
  /** Bumped by every notice that names a run.
   *
   *  A `scheduled_run_get` is a snapshot of the moment it was ISSUED but applied
   *  whenever it happens to come back, so a read issued before a step started
   *  can land afterwards and erase it. Callers capture this before the request
   *  and hand it back; a snapshot older than the newest notice is dropped.
   *
   *  Improved on the runbook original in one place: it is applied on selection
   *  as well as on merge. `runbookStore.setActiveRun` merges unconditionally,
   *  which is the same hole `upsertRun` was hardened against — and it is more
   *  reachable here, because scheduled runs arrive with no gesture at all.
   *
   *  A `Map` rather than a record: the key is a backend id, and a plain object
   *  indexed by one is both a lint sink and reachable by `__proto__`. */
  runRevisions: ReadonlyMap<string, number>;
  history: ScheduleRun[];
  loadingHistory: boolean;

  busyAction: string | null;
  error: string | null;
  notice: string | null;

  setWorkspaceOpen(open: boolean): void;
  setView(view: SchedulesView): void;

  setActions(actions: ScheduleAction[]): void;
  upsertAction(action: ScheduleAction): void;
  removeAction(actionId: string): void;
  selectAction(actionId: string | null): void;
  setLoadingActions(loading: boolean): void;

  beginDraft(action: ScheduleAction | null): void;
  patchDraft(patch: Partial<ScheduleActionInput>): void;
  patchStep(index: number, patch: Partial<ScheduleStep>): void;
  addStep(kind: ScheduleStepKind): void;
  removeStep(index: number): void;
  moveStep(from: number, to: number): void;
  setIssues(issues: ScheduleValidationIssue[]): void;
  discardDraft(): void;

  upsertRun(run: ScheduleRun, issuedAtRevision?: number): void;
  revisionOf(runId: string): number;
  noteRunEvent(notice: ScheduleRunNotice): void;
  selectRun(runId: string | null): void;
  setHistory(runs: ScheduleRun[]): void;
  setLoadingHistory(loading: boolean): void;

  setBusyAction(action: string | null): void;
  setError(error: string | null): void;
  setNotice(notice: string | null): void;
  reset(): void;
}

function bump(
  revisions: ReadonlyMap<string, number>,
  runId: string,
): ReadonlyMap<string, number> {
  const next = new Map(revisions);
  next.set(runId, (next.get(runId) ?? 0) + 1);
  return next;
}

const initial = {
  workspaceOpen: false,
  view: "list" as SchedulesView,
  actions: [] as ScheduleAction[],
  selectedActionId: null as string | null,
  loadingActions: false,
  draft: null as ScheduleDraft | null,
  draftDirty: false,
  issues: [] as ScheduleValidationIssue[],
  runsById: {} as Record<string, ScheduleRun>,
  activeRunId: null as string | null,
  runRevisions: new Map<string, number>() as ReadonlyMap<string, number>,
  history: [] as ScheduleRun[],
  loadingHistory: false,
  busyAction: null as string | null,
  error: null as string | null,
  notice: null as string | null,
};

export const useScheduleStore = create<ScheduleStoreState>((set, get) => ({
  ...initial,

  setWorkspaceOpen: (workspaceOpen) => set({ workspaceOpen }),
  setView: (view) => set({ view }),

  setActions: (actions) => set({ actions }),
  upsertAction: (action) =>
    set((state) => {
      const index = state.actions.findIndex((a) => a.id === action.id);
      const actions =
        index === -1
          ? [...state.actions, action]
          : state.actions.map((a) => (a.id === action.id ? action : a));
      actions.sort((a, b) => a.name.localeCompare(b.name));
      return { actions };
    }),
  removeAction: (actionId) =>
    set((state) => ({
      actions: state.actions.filter((a) => a.id !== actionId),
      selectedActionId:
        state.selectedActionId === actionId ? null : state.selectedActionId,
      draft: state.draft?.actionId === actionId ? null : state.draft,
    })),
  selectAction: (selectedActionId) => set({ selectedActionId }),
  setLoadingActions: (loadingActions) => set({ loadingActions }),

  beginDraft: (action) =>
    set({
      draft: {
        actionId: action?.id ?? null,
        input: action ? toScheduleInput(action) : emptyScheduleInput(),
        storedPermissionMode: action?.permission_mode ?? null,
        storedStepsSha256: action?.steps_sha256 ?? null,
      },
      draftDirty: false,
      issues: [],
      view: "editor",
    }),
  patchDraft: (patch) =>
    set((state) =>
      state.draft
        ? {
            draft: { ...state.draft, input: { ...state.draft.input, ...patch } },
            draftDirty: true,
          }
        : {},
    ),
  patchStep: (index, patch) =>
    set((state) => {
      if (!state.draft) return {};
      const steps = state.draft.input.steps.map((step, i) =>
        i === index ? { ...step, ...patch } : step,
      );
      return {
        draft: { ...state.draft, input: { ...state.draft.input, steps } },
        draftDirty: true,
      };
    }),
  addStep: (kind) =>
    set((state) => {
      if (!state.draft) return {};
      const steps = [...state.draft.input.steps];
      steps.push({
        id: newStepId(),
        sort_order: steps.length,
        title: `Step ${steps.length + 1}`,
        kind,
        text: "",
        continue_on_failure: false,
      });
      return {
        draft: { ...state.draft, input: { ...state.draft.input, steps } },
        draftDirty: true,
      };
    }),
  removeStep: (index) =>
    set((state) => {
      if (!state.draft) return {};
      const steps = state.draft.input.steps
        .filter((_, i) => i !== index)
        .map((step, i) => ({ ...step, sort_order: i }));
      return {
        draft: { ...state.draft, input: { ...state.draft.input, steps } },
        draftDirty: true,
      };
    }),
  moveStep: (from, to) =>
    set((state) => {
      if (!state.draft) return {};
      const steps = [...state.draft.input.steps];
      if (from < 0 || to < 0 || from >= steps.length || to >= steps.length) return {};
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      return {
        draft: {
          ...state.draft,
          input: {
            ...state.draft.input,
            steps: steps.map((step, i) => ({ ...step, sort_order: i })),
          },
        },
        draftDirty: true,
      };
    }),
  setIssues: (issues) => set({ issues }),
  discardDraft: () => set({ draft: null, draftDirty: false, issues: [] }),

  upsertRun: (run, issuedAtRevision) =>
    set((state) => {
      if (
        issuedAtRevision !== undefined &&
        issuedAtRevision < (state.runRevisions.get(run.id) ?? 0)
      ) {
        // Stale snapshot: a notice landed after this read was issued, so applying
        // it would erase whatever that notice reported.
        return {};
      }
      return { runsById: { ...state.runsById, [run.id]: run } };
    }),
  revisionOf: (runId) => get().runRevisions.get(runId) ?? 0,
  noteRunEvent: (notice) =>
    set((state) => {
      const existing = state.runsById[notice.run_id];
      return {
        runRevisions: bump(state.runRevisions, notice.run_id),
        runsById: existing
          ? {
              ...state.runsById,
              [notice.run_id]: { ...existing, status: notice.status },
            }
          : state.runsById,
      };
    }),
  selectRun: (activeRunId) => set({ activeRunId, view: "runs" }),
  setHistory: (history) =>
    set((state) => {
      // Merge into the durable registry too, so opening a run from history and
      // then receiving a notice for it does not have to re-fetch.
      const runsById = { ...state.runsById };
      for (const run of history) runsById[run.id] = run;
      return { history, runsById };
    }),
  setLoadingHistory: (loadingHistory) => set({ loadingHistory }),

  setBusyAction: (busyAction) => set({ busyAction }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  reset: () => set({ ...initial, runRevisions: new Map() }),
}));

/** Runs that are genuinely still going. Membership in `runsById` is not
 *  liveness: a terminal run stays there so its detail remains openable. */
export function selectLiveScheduleRuns(
  runsById: Record<string, ScheduleRun>,
): ScheduleRun[] {
  return Object.values(runsById).filter(
    (run) => !isTerminalScheduleRunStatus(run.status),
  );
}

/** The one run the header badge may light up for. `activeRunId` is a UI
 *  selection that outlives its run, so a terminal-state selection must not hold
 *  the badge — the lesson `selectLiveRunbookRun` records. */
export function selectLiveScheduleRun(
  activeRunId: string | null,
  runsById: Record<string, ScheduleRun>,
): ScheduleRun | null {
  const selected = activeRunId ? ownRecordValue(runsById, activeRunId) : undefined;
  if (selected && !isTerminalScheduleRunStatus(selected.status)) return selected;
  return selectLiveScheduleRuns(runsById)[0] ?? null;
}

/** Actions whose next occurrence is already in the past because the app was
 *  closed. Derived, never stored: a stored "is overdue" goes stale by the
 *  second, and the banner it drives has to be true when it is read. */
export function selectOverdueActions(
  actions: ScheduleAction[],
  now: number,
): ScheduleAction[] {
  return actions.filter((action) => {
    if (!action.enabled || !action.next_fire_at) return false;
    const at = Date.parse(action.next_fire_at);
    return Number.isFinite(at) && at < now;
  });
}

export function blockingIssues(
  issues: ScheduleValidationIssue[],
): ScheduleValidationIssue[] {
  return issues.filter((issue) => issue.blocking);
}
