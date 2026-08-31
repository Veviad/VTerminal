import { beforeEach, describe, expect, it } from "vitest";

import {
  claimScheduleSession,
  clearScheduleRunRevocation,
  forgetActionSession,
  isScheduleRunRevoked,
  listLiveScheduleJobs,
  recallActionSession,
  registerLiveScheduleJob,
  releaseScheduleSession,
  rememberActionSession,
  resetScheduleLiveJobsForTests,
  revokeAllLiveScheduleRuns,
  revokeScheduleRun,
  scheduleOwnerOf,
  unregisterLiveScheduleJob,
} from "../lib/scheduleLiveJobs";

describe("schedule live jobs", () => {
  beforeEach(() => resetScheduleLiveJobsForTests());

  it("registers and unregisters a job", () => {
    const lease = registerLiveScheduleJob({
      runId: "r1",
      attemptId: "a1",
      sessionId: "s1",
    });
    expect(listLiveScheduleJobs("r1")).toHaveLength(1);
    unregisterLiveScheduleJob(lease);
    expect(listLiveScheduleJobs()).toHaveLength(0);
  });

  /** Uncapped and reference-counted, because the panel's event list is capped
   *  for presentation and an older still-running attempt must not fall off the
   *  registry that owns the PTY. */
  it("keeps a job alive until every registration is released", () => {
    const job = { runId: "r1", attemptId: "a1", sessionId: "s1" };
    const first = registerLiveScheduleJob(job);
    const second = registerLiveScheduleJob(job);
    unregisterLiveScheduleJob(first);
    expect(listLiveScheduleJobs()).toHaveLength(1);
    unregisterLiveScheduleJob(second);
    expect(listLiveScheduleJobs()).toHaveLength(0);
  });

  it("revokes a run and returns exactly the jobs it owns", () => {
    registerLiveScheduleJob({ runId: "r1", attemptId: "a1", sessionId: "s1" });
    registerLiveScheduleJob({ runId: "r2", attemptId: "a2", sessionId: "s2" });
    const revoked = revokeScheduleRun("r1");
    expect(revoked.map((j) => j.sessionId)).toEqual(["s1"]);
    expect(isScheduleRunRevoked("r1")).toBe(true);
    expect(isScheduleRunRevoked("r2")).toBe(false);
    clearScheduleRunRevocation("r1");
    expect(isScheduleRunRevoked("r1")).toBe(false);
  });

  it("revokes every live run when the feature is switched off", () => {
    registerLiveScheduleJob({ runId: "r1", attemptId: "a1", sessionId: "s1" });
    registerLiveScheduleJob({ runId: "r2", attemptId: "a2", sessionId: "s2" });
    const all = revokeAllLiveScheduleRuns();
    expect(all).toHaveLength(2);
    expect(isScheduleRunRevoked("r1")).toBe(true);
    expect(isScheduleRunRevoked("r2")).toBe(true);
  });

  /** Exclusive, not shared: two runs in one tab would race in `runInTerminal`,
   *  and the loser would fail with `terminal_busy` for reasons nobody could
   *  reconstruct. */
  it("gives a session to exactly one run at a time", () => {
    expect(claimScheduleSession("r1", "s1")).toBe(true);
    expect(scheduleOwnerOf("s1")).toBe("r1");
    expect(claimScheduleSession("r2", "s1")).toBe(false);
    // Re-claiming for the SAME run is idempotent.
    expect(claimScheduleSession("r1", "s1")).toBe(true);
    releaseScheduleSession("s1");
    expect(scheduleOwnerOf("s1")).toBeNull();
    expect(claimScheduleSession("r2", "s1")).toBe(true);
  });

  it("remembers one tab per action, so an hourly schedule reuses it", () => {
    rememberActionSession("a1", "s1");
    expect(recallActionSession("a1")).toBe("s1");
    expect(recallActionSession("a2")).toBeNull();
    rememberActionSession("a1", "s2");
    expect(recallActionSession("a1")).toBe("s2");
  });

  it("forgets an action's tab and its claim when that session goes away", () => {
    rememberActionSession("a1", "s1");
    claimScheduleSession("r1", "s1");
    forgetActionSession("s1");
    expect(recallActionSession("a1")).toBeNull();
    expect(scheduleOwnerOf("s1")).toBeNull();
  });
});
