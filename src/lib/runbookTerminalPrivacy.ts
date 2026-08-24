/**
 * Private execution evidence is redacted, while xterm scrollback is raw. Once a
 * session crosses either a Runbook or Agent private-output boundary, suppress
 * optional terminal evidence for the rest of that terminal's lifetime.
 */
const protectedSessions = new Set<string>();

export const protectRunbookTerminal = (sessionId: string): void => {
  protectedSessions.add(sessionId);
};

export const protectPrivateTerminal = protectRunbookTerminal;

export const isTerminalOutputProtected = (sessionId: string): boolean =>
  protectedSessions.has(sessionId);

export const isRunbookTerminalProtected = (sessionId: string): boolean =>
  isTerminalOutputProtected(sessionId);

export const forgetRunbookTerminal = (sessionId: string): void => {
  protectedSessions.delete(sessionId);
};

export const resetRunbookTerminalPrivacyForTests = (): void => {
  protectedSessions.clear();
};
