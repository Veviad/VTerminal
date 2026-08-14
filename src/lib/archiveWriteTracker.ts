/** Archive mutations can start well before their IPC (PTY kill / AI cancel). */
const activeArchiveMutations = new Set<Promise<unknown>>();
const inFlightArchiveWrites = new Set<Promise<unknown>>();
const capturedArchiveWriteFailures: unknown[] = [];
let mutationsFrozen = false;
let writesFrozen = false;
let captureArchiveWriteFailures = false;

function trackOperation<T>(
  operations: Set<Promise<unknown>>,
  operation: () => Promise<T>,
  onFailure?: (error: unknown) => void,
): Promise<T> {
  // Register a placeholder before invoking the factory. That makes acquisition
  // synchronous even when the operation reaches an await before its archive IPC.
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const pending = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let tracked: Promise<T>;
  tracked = pending
    .catch((error) => {
      onFailure?.(error);
      throw error;
    })
    .finally(() => operations.delete(tracked));
  operations.add(tracked);
  try {
    operation().then(resolve, reject);
  } catch (error) {
    reject(error);
  }
  return tracked;
}

/**
 * Lease an entire close/New-chat mutation from entry through its archive write.
 * Once exit preparation freezes new leases, callers receive their no-op result.
 */
export function trackArchiveMutation<T>(
  operation: () => Promise<T>,
  frozenResult: T,
): Promise<T> {
  if (mutationsFrozen) return Promise.resolve(frozenResult);
  return trackOperation(activeArchiveMutations, operation);
}

/** Central wrapper for ordinary archive mutation IPCs. */
export function trackArchiveWrite<T>(write: () => Promise<T>): Promise<T> {
  if (writesFrozen) {
    return Promise.reject(new Error("archive changes are paused while the app prepares to exit"));
  }
  return trackOperation(inFlightArchiveWrites, write, (error) => {
    if (captureArchiveWriteFailures) capturedArchiveWriteFailures.push(error);
  });
}

/** Privileged final/rollback archive write while ordinary writes are frozen. */
export function trackExitArchiveWrite<T>(write: () => Promise<T>): Promise<T> {
  return trackOperation(inFlightArchiveWrites, write);
}

export function freezeArchiveMutations(): void {
  mutationsFrozen = true;
  // Begin a fresh strict-exit epoch. Old failures were already surfaced to
  // their callers; failures from writes that overlap this barrier must also be
  // surfaced even if their promises leave the in-flight set before the drain.
  capturedArchiveWriteFailures.length = 0;
  captureArchiveWriteFailures = true;
}

export function freezeArchiveWrites(): void {
  writesFrozen = true;
}

export function resumeArchiveMutations(): void {
  mutationsFrozen = false;
  writesFrozen = false;
  captureArchiveWriteFailures = false;
  capturedArchiveWriteFailures.length = 0;
}

async function waitFor(operations: Set<Promise<unknown>>): Promise<void> {
  while (operations.size > 0) {
    await Promise.allSettled([...operations]);
  }
}

export const waitForArchiveMutations = () => waitFor(activeArchiveMutations);

/** Wait for the set to become empty, including writes chained by completion. */
export async function waitForArchiveWrites(): Promise<void> {
  await waitFor(inFlightArchiveWrites);
  const failures = capturedArchiveWriteFailures.splice(0);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "archive writes failed while preparing to exit");
  }
}

/** Test seam: discard tracker state left by an interrupted/fake-timer test. */
export function __resetArchiveWriteTrackerForTests(): void {
  activeArchiveMutations.clear();
  inFlightArchiveWrites.clear();
  capturedArchiveWriteFailures.length = 0;
  mutationsFrozen = false;
  writesFrozen = false;
  captureArchiveWriteFailures = false;
}
