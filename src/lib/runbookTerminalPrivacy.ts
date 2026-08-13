/**
 * Runbook evidence is redacted, while xterm scrollback is raw. Once a session
 * executes a Runbook line, suppress its optional scrollback blobs for the rest
 * of that terminal's lifetime so generic restore/archive persistence cannot
 * bypass the Runbook privacy boundary.
 */
const protectedSessions = new Set<string>();

export const protectRunbookTerminal = (sessionId: string): void => {
  protectedSessions.add(sessionId);
};

export const isRunbookTerminalProtected = (sessionId: string): boolean =>
  protectedSessions.has(sessionId);

export const forgetRunbookTerminal = (sessionId: string): void => {
  protectedSessions.delete(sessionId);
};

export const resetRunbookTerminalPrivacyForTests = (): void => {
  protectedSessions.clear();
};
