/**
 * Process-local ownership for PTY work dispatched by Scheduled Actions.
 *
 * Adapted from `runbookLiveJobs.ts`, and for the same reason its header gives:
 * the panel's event list is capped for presentation and must never be used as an
 * execution registry, because an older still-running attempt can drop off that
 * list while it still owns a foreground PTY job. Keep this uncapped and remove
 * entries only when the async dispatch settles.
 *
 * Two things live here that Runbooks does not need, both because a schedule
 * fires with no gesture and can collide with the user:
 *
 * * **Session claims.** A schedule never writes into a tab the user owns, and
 *   never has two runs in one tab.
 * * **A sticky tab per action.** An hourly action reuses one tab all day rather
 *   than opening twenty-four — and for an ssh target the reused tab is already
 *   connected, so the connect step is skipped entirely.
 */
export interface LiveSchedulePtyJob {
  runId: string;
  attemptId: string;
  sessionId: string;
}

export interface LiveSchedulePtyJobLease extends LiveSchedulePtyJob {
  readonly registration: symbol;
}

interface LiveJobEntry {
  job: LiveSchedulePtyJob;
  registrations: Set<symbol>;
}

const liveJobs = new Map<string, LiveJobEntry>();
const revokedRunIds = new Set<string>();
/** sessionId -> runId that owns it. */
const sessionClaims = new Map<string, string>();
/** actionId -> the tab it used last. */
const actionSessions = new Map<string, string>();

function jobKey(job: LiveSchedulePtyJob): string {
  // JSON preserves component boundaries even if an identifier unexpectedly
  // contains a separator character.
  return JSON.stringify([job.runId, job.attemptId, job.sessionId]);
}

export function registerLiveScheduleJob(
  job: LiveSchedulePtyJob,
): LiveSchedulePtyJobLease {
  const key = jobKey(job);
  const registration = Symbol(key);
  const existing = liveJobs.get(key);
  if (existing) {
    existing.registrations.add(registration);
  } else {
    liveJobs.set(key, { job: { ...job }, registrations: new Set([registration]) });
  }
  return { ...job, registration };
}

export function unregisterLiveScheduleJob(lease: LiveSchedulePtyJobLease): void {
  const key = jobKey(lease);
  const existing = liveJobs.get(key);
  if (!existing) return;
  existing.registrations.delete(lease.registration);
  if (existing.registrations.size === 0) liveJobs.delete(key);
}

export function listLiveScheduleJobs(runId?: string): LiveSchedulePtyJob[] {
  return [...liveJobs.values()]
    .map(({ job }) => ({ ...job }))
    .filter((job) => runId === undefined || job.runId === runId);
}

/** Revoke a run before any asynchronous backend cancellation begins. */
export function revokeScheduleRun(runId: string): LiveSchedulePtyJob[] {
  revokedRunIds.add(runId);
  return listLiveScheduleJobs(runId);
}

/** Revoke every live run and return the exact owned jobs to abort. Used when the
 *  feature flag goes off, where the mirror must close before persistence yields. */
export function revokeAllLiveScheduleRuns(): LiveSchedulePtyJob[] {
  const jobs = listLiveScheduleJobs();
  for (const job of jobs) revokedRunIds.add(job.runId);
  return jobs;
}

export function isScheduleRunRevoked(runId: string): boolean {
  return revokedRunIds.has(runId);
}

export function clearScheduleRunRevocation(runId: string): void {
  revokedRunIds.delete(runId);
}

/**
 * Take exclusive ownership of a session for one run.
 *
 * Exclusive rather than reference-counted: two runs sharing a tab would race in
 * `runInTerminal`, which refuses a session that already has a job — and the user
 * would see one of their scheduled actions fail with `terminal_busy` for reasons
 * they could never reconstruct.
 */
export function claimScheduleSession(runId: string, sessionId: string): boolean {
  const owner = sessionClaims.get(sessionId);
  if (owner && owner !== runId) return false;
  sessionClaims.set(sessionId, runId);
  return true;
}

export function releaseScheduleSession(sessionId: string): void {
  sessionClaims.delete(sessionId);
}

export function scheduleOwnerOf(sessionId: string): string | null {
  return sessionClaims.get(sessionId) ?? null;
}

export function rememberActionSession(actionId: string, sessionId: string): void {
  actionSessions.set(actionId, sessionId);
}

export function recallActionSession(actionId: string): string | null {
  return actionSessions.get(actionId) ?? null;
}

export function forgetActionSession(sessionId: string): void {
  for (const [actionId, id] of actionSessions) {
    if (id === sessionId) actionSessions.delete(actionId);
  }
  sessionClaims.delete(sessionId);
}

export function resetScheduleLiveJobsForTests(): void {
  liveJobs.clear();
  revokedRunIds.clear();
  sessionClaims.clear();
  actionSessions.clear();
}
