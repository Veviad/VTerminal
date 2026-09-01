import { useCallback } from "react";

import * as api from "../lib/schedules";
import { S } from "../lib/strings";
import { useScheduleStore } from "../stores/scheduleStore";
import type { ScheduleActionInput, ScheduleRecurrence } from "../lib/schedules";

/**
 * Data operations for the Scheduled Actions panel.
 *
 * Deliberately separate from `useScheduledActions`, which is the tab-execution
 * driver mounted once in `AppShell`: this hook is only used by the panel, and
 * mixing the two would put the driver's lifetime on the panel's mount — which is
 * exactly the coupling Runbooks can afford and a schedule cannot.
 */
export function useSchedules() {
  const store = useScheduleStore;

  const refreshActions = useCallback(async () => {
    store.getState().setLoadingActions(true);
    try {
      store.getState().setActions(await api.schedulesList());
    } catch (error) {
      store.getState().setError(String(error));
    } finally {
      store.getState().setLoadingActions(false);
    }
  }, [store]);

  const refreshHistory = useCallback(
    async (actionId?: string | null) => {
      store.getState().setLoadingHistory(true);
      try {
        store.getState().setHistory(await api.scheduleRunsList(actionId ?? null));
      } catch (error) {
        store.getState().setError(String(error));
      } finally {
        store.getState().setLoadingHistory(false);
      }
    },
    [store],
  );

  const initialize = useCallback(async () => {
    await Promise.all([refreshActions(), refreshHistory()]);
  }, [refreshActions, refreshHistory]);

  const validateDraft = useCallback(
    async (input: ScheduleActionInput) => {
      try {
        store.getState().setIssues(await api.scheduleValidate(input));
      } catch {
        // A validation call that fails is not itself an error worth showing —
        // the save will surface the real reason.
        store.getState().setIssues([]);
      }
    },
    [store],
  );

  const saveDraft = useCallback(async () => {
    const draft = store.getState().draft;
    if (!draft) return null;
    store.getState().setBusyAction("save");
    try {
      const saved = draft.actionId
        ? await api.scheduleUpdate(draft.actionId, draft.input)
        : await api.scheduleCreate(draft.input);
      store.getState().upsertAction(saved);
      store.getState().selectAction(saved.id);
      store.getState().discardDraft();
      store.getState().setView("list");
      store.getState().setNotice(null);
      return saved;
    } catch (error) {
      store.getState().setError(String(error));
      return null;
    } finally {
      store.getState().setBusyAction(null);
    }
  }, [store]);

  const setEnabled = useCallback(
    async (actionId: string, enabled: boolean) => {
      store.getState().setBusyAction(`enable:${actionId}`);
      try {
        store.getState().upsertAction(await api.scheduleSetEnabled(actionId, enabled));
      } catch (error) {
        store.getState().setError(String(error));
      } finally {
        store.getState().setBusyAction(null);
      }
    },
    [store],
  );

  const remove = useCallback(
    async (actionId: string) => {
      store.getState().setBusyAction(`delete:${actionId}`);
      try {
        await api.scheduleDelete(actionId);
        store.getState().removeAction(actionId);
        await refreshHistory();
      } catch (error) {
        store.getState().setError(String(error));
      } finally {
        store.getState().setBusyAction(null);
      }
    },
    [refreshHistory, store],
  );

  const duplicate = useCallback(
    async (actionId: string) => {
      const source = store.getState().actions.find((a) => a.id === actionId);
      if (!source) return;
      const input = api.toScheduleInput(source);
      store.getState().beginDraft(null);
      store.getState().patchDraft({
        ...input,
        name: `${input.name} copy`,
        enabled: false,
        // A duplicate authorizes nothing until the user arms it deliberately.
        // Carrying the original's mode across would hand a fresh action a
        // standing approval nobody granted it.
        permission_mode: "ask",
        steps: input.steps.map((step) => ({ ...step, id: api.newStepId() })),
      });
    },
    [store],
  );

  const runNow = useCallback(
    async (actionId: string) => {
      store.getState().setBusyAction(`run:${actionId}`);
      try {
        const runId = await api.scheduleRunNow(actionId);
        store.getState().selectRun(runId);
        const run = await api.scheduleRunGet(runId);
        if (run) store.getState().upsertRun(run);
        await refreshActions();
        return runId;
      } catch (error) {
        store.getState().setError(String(error));
        return null;
      } finally {
        store.getState().setBusyAction(null);
      }
    },
    [refreshActions, store],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      store.getState().setBusyAction(`cancel:${runId}`);
      try {
        await api.scheduleRunCancel(runId);
      } catch (error) {
        store.getState().setError(String(error));
      } finally {
        store.getState().setBusyAction(null);
      }
    },
    [store],
  );

  /** Re-read one run, guarding against a stale snapshot.
   *
   *  The revision is captured BEFORE the request and handed back with the
   *  result: a read issued before a step started can land after the notice that
   *  reported it, and applying it would erase that. */
  const refreshRun = useCallback(
    async (runId: string) => {
      const issuedAt = store.getState().revisionOf(runId);
      try {
        const run = await api.scheduleRunGet(runId);
        if (run) store.getState().upsertRun(run, issuedAt);
        return run;
      } catch (error) {
        store.getState().setError(String(error));
        return null;
      }
    },
    [store],
  );

  const deleteRun = useCallback(
    async (runId: string) => {
      try {
        await api.scheduleRunDelete(runId);
        await refreshHistory();
        if (store.getState().activeRunId === runId) store.getState().selectRun(null);
      } catch (error) {
        store.getState().setError(String(error));
      }
    },
    [refreshHistory, store],
  );

  /** The next fire times, from the SAME function the scheduler uses. Two
   *  implementations of "when does this fire" would drift, and the one the user
   *  reads has to be the one that acts. */
  const preview = useCallback(async (recurrence: ScheduleRecurrence) => {
    try {
      return await api.schedulePreview(recurrence, 3);
    } catch {
      return [];
    }
  }, []);

  return {
    initialize,
    refreshActions,
    refreshHistory,
    refreshRun,
    validateDraft,
    saveDraft,
    setEnabled,
    remove,
    duplicate,
    runNow,
    cancelRun,
    deleteRun,
    preview,
    labels: S.schedules,
  };
}
