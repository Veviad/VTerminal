import { beforeEach, describe, expect, it } from "vitest";

import {
  isRunbookRunRevoked,
  listLiveRunbookPtyJobs,
  registerLiveRunbookPtyJob,
  resetRunbookLiveJobsForTests,
  revokeRunbookRun,
  unregisterLiveRunbookPtyJob,
} from "../lib/runbookLiveJobs";

describe("Runbook live PTY ownership", () => {
  beforeEach(() => resetRunbookLiveJobsForTests());

  it("retains a duplicate job until every async registration settles", () => {
    const job = {
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
    };
    const first = registerLiveRunbookPtyJob(job);
    const duplicate = registerLiveRunbookPtyJob(job);

    expect(listLiveRunbookPtyJobs()).toEqual([job]);
    unregisterLiveRunbookPtyJob(first);
    expect(listLiveRunbookPtyJobs()).toEqual([job]);
    unregisterLiveRunbookPtyJob(duplicate);
    expect(listLiveRunbookPtyJobs()).toEqual([]);
  });

  it("revokes and returns only jobs owned by the requested run", () => {
    const selected = {
      runId: "run-selected",
      attemptId: "attempt-selected",
      sessionId: "session-selected",
    };
    const concurrent = {
      runId: "run-concurrent",
      attemptId: "attempt-concurrent",
      sessionId: "session-concurrent",
    };
    registerLiveRunbookPtyJob(selected);
    registerLiveRunbookPtyJob(concurrent);

    expect(revokeRunbookRun(selected.runId)).toEqual([selected]);
    expect(isRunbookRunRevoked(selected.runId)).toBe(true);
    expect(isRunbookRunRevoked(concurrent.runId)).toBe(false);
    expect(listLiveRunbookPtyJobs()).toEqual([selected, concurrent]);
  });
});
