import type { Session } from "../lib/types";

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    shell: "/bin/zsh",
    cwd: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
    ...overrides,
  };
}
