import { getTerm, subscribeTerm } from "./termRegistry";

/** Waiting is only convenience: callers must re-check tab lifetime before
 * writing, and credential autofill still requires native shell proof. */
export function waitForFirstPrompt(sessionId: string, timeoutMs: number): Promise<void> {
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed || entry.tracker.phase === "input") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeTerm(sessionId, (event) => {
      if (event.type === "disposed" || (event.type === "phase" && event.phase === "input")) finish();
    });
  });
}
