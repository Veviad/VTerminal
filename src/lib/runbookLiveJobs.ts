/**
 * Process-local ownership for PTY work dispatched by Runbooks.
 *
 * The Runbook event list is intentionally capped for presentation. It must
 * never be used as an execution registry: an older, still-running attempt can
 * disappear from that list while it still owns a foreground PTY job. Keep this
 * registry uncapped and remove entries only when the async dispatch settles.
 */
export interface LiveRunbookPtyJob {
  runId: string;
  attemptId: string;
  sessionId: string;
}

export interface LiveRunbookPtyJobLease extends LiveRunbookPtyJob {
  readonly registration: symbol;
}

interface LiveJobEntry {
  job: LiveRunbookPtyJob;
  registrations: Set<symbol>;
}

const liveJobs = new Map<string, LiveJobEntry>();
const revokedRunIds = new Set<string>();

function jobKey(job: LiveRunbookPtyJob): string {
  // JSON preserves component boundaries even if an identifier unexpectedly
  // contains a separator character.
  return JSON.stringify([job.runId, job.attemptId, job.sessionId]);
}

export function registerLiveRunbookPtyJob(
  job: LiveRunbookPtyJob,
): LiveRunbookPtyJobLease {
  const key = jobKey(job);
  const registration = Symbol(key);
  const existing = liveJobs.get(key);
  if (existing) {
    existing.registrations.add(registration);
  } else {
    liveJobs.set(key, {
      job: { ...job },
      registrations: new Set([registration]),
    });
  }
  return { ...job, registration };
}

export function unregisterLiveRunbookPtyJob(lease: LiveRunbookPtyJobLease): void {
  const key = jobKey(lease);
  const existing = liveJobs.get(key);
  if (!existing) return;
  existing.registrations.delete(lease.registration);
  if (existing.registrations.size === 0) liveJobs.delete(key);
}

export function listLiveRunbookPtyJobs(runId?: string): LiveRunbookPtyJob[] {
  return [...liveJobs.values()]
    .map(({ job }) => ({ ...job }))
    .filter((job) => runId === undefined || job.runId === runId);
}

/** Revoke a run before any asynchronous backend cancellation begins. */
export function revokeRunbookRun(runId: string): LiveRunbookPtyJob[] {
  revokedRunIds.add(runId);
  return listLiveRunbookPtyJobs(runId);
}

/** Revoke every currently live run and return the exact owned jobs to abort. */
export function revokeAllLiveRunbookRuns(): LiveRunbookPtyJob[] {
  const jobs = listLiveRunbookPtyJobs();
  for (const job of jobs) revokedRunIds.add(job.runId);
  return jobs;
}

export function isRunbookRunRevoked(runId: string): boolean {
  return revokedRunIds.has(runId);
}

/** Explicit resume is the only operation allowed to reopen a revoked run ID. */
export function clearRunbookRunRevocation(runId: string): void {
  revokedRunIds.delete(runId);
}

export function resetRunbookLiveJobsForTests(): void {
  liveJobs.clear();
  revokedRunIds.clear();
}
