import { beforeEach, describe, expect, it } from "vitest";
import {
  captureSidecarRemoteIdentity,
  clampSidecarRatio,
  inspectSidecarHealth,
  validateSidecarTarget,
  type SidecarRemoteIdentity,
} from "../lib/sidecar";
import type { AiMessage, Session } from "../lib/types";
import { useAppStore } from "../stores/appStore";

function makeSession(id: string, hostLabel: string | null = null): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: null,
    createdAt: "2026-08-22T12:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: hostLabel ? `host-${id}` : null,
    hostLabel,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
  };
}

function addLocal(id = "local"): void {
  useAppStore.getState().addSession(makeSession(id), false);
}

function addRemote(
  id = "remote",
  target = "deploy@example.test",
  hostId: string | null = `saved-${id}`,
  label = "Production",
): SidecarRemoteIdentity {
  useAppStore.getState().addSession(makeSession(id, label), false);
  useAppStore.getState().updateSessionUi(id, {
    remote: { kind: "ssh", target },
    nestedBlockId: `ssh-${id}`,
    runningBlockId: `ssh-${id}`,
    remoteHost: hostId ? { id: hostId, label, color: null } : null,
  });
  const state = useAppStore.getState();
  const identity = captureSidecarRemoteIdentity(
    state.sessions.find((session) => session.id === id),
    state.sessionUi[id],
  );
  if (!identity) throw new Error("remote fixture did not produce an identity");
  return identity;
}

function start(owner = "local", local = "local", remote = "remote") {
  const state = useAppStore.getState();
  const identity = captureSidecarRemoteIdentity(
    state.sessions.find((session) => session.id === remote),
    state.sessionUi[remote],
  );
  if (!identity) throw new Error("remote fixture did not produce an identity");
  const result = state.startSidecar(owner, local, remote, identity);
  if (!result.ok) throw new Error(result.reason);
  return result.binding;
}

beforeEach(() => {
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    sidecars: {},
  });
});

describe("sidecar target validation", () => {
  it("requires a local prompt and a verifiable live SSH session", () => {
    addLocal();
    const identity = addRemote();
    const state = useAppStore.getState();

    expect(validateSidecarTarget(state, "local", "local")).toEqual({ ok: true });
    expect(validateSidecarTarget(state, "remote", "remote")).toEqual({ ok: true });
    expect(identity).toEqual({
      kind: "ssh",
      target: "deploy@example.test",
      hostId: "saved-remote",
      label: "Production",
    });

    state.updateSessionUi("local", { runningBlockId: "build" });
    expect(validateSidecarTarget(useAppStore.getState(), "local", "local")).toEqual({
      ok: false,
      reason: "Local terminal is busy.",
    });
  });

  it("can include terminal-registry availability in popover eligibility", () => {
    addLocal();
    const state = useAppStore.getState();
    expect(
      validateSidecarTarget(state, "local", "local", {
        terminalAvailable: () => false,
      }),
    ).toEqual({ ok: false, reason: "Terminal is not available." });
  });

  it("rejects an SSH context with no stable saved-host id or parsed target", () => {
    addLocal("unknown");
    useAppStore.getState().updateSessionUi("unknown", {
      remote: { kind: "ssh", target: null },
      nestedBlockId: "ssh-unknown",
      runningBlockId: "ssh-unknown",
    });
    const state = useAppStore.getState();
    expect(captureSidecarRemoteIdentity(state.sessions[0], state.sessionUi.unknown)).toBeNull();
    expect(validateSidecarTarget(state, "unknown", "remote").ok).toBe(false);
  });
});

describe("sidecar store", () => {
  it("starts with safe defaults and resolves both tabs to one AI owner", () => {
    addLocal();
    addRemote();
    useAppStore.getState().setPermissionMode("local", "auto_all");
    useAppStore.getState().setPermissionMode("remote", "auto_read");

    const binding = start();

    expect(binding.permissions).toEqual({ local: "ask", remote: "ask" });
    expect(binding.paneOrder).toEqual(["local", "remote"]);
    expect(binding.splitRatio).toBe(0.5);
    expect(binding.splitOrientation).toBe("horizontal");
    expect(useAppStore.getState().resolveAiOwner("local")).toBe("local");
    expect(useAppStore.getState().resolveAiOwner("remote")).toBe("local");
    expect(useAppStore.getState().sidecarForSession("remote")?.ownerSessionId).toBe("local");
    // The owner loses stale single-terminal authority; the companion's hidden
    // conversation remains untouched and returns when the pairing ends.
    expect(useAppStore.getState().aiStreams.local.permissionMode).toBe("ask");
    expect(useAppStore.getState().aiStreams.remote.permissionMode).toBe("auto_read");
  });

  it("owns focus, ordering, responsive orientation, clamped ratio, and permissions", () => {
    addLocal();
    addRemote();
    start();

    const actions = useAppStore.getState();
    actions.setSidecarFocusedSession("local", "remote");
    actions.swapSidecarPanes("remote");
    actions.setSidecarRatio("local", 0.95);
    actions.setSidecarOrientation("remote", "vertical");
    actions.setSidecarPermission("local", "local", "auto_read");
    actions.setSidecarPermission("remote", "remote", "auto_all");

    const state = useAppStore.getState();
    const binding = state.sidecarForSession("local");
    expect(state.activeSessionId).toBe("remote");
    expect(binding?.focusedSessionId).toBe("remote");
    expect(binding?.paneOrder).toEqual(["remote", "local"]);
    expect(binding?.splitRatio).toBe(0.7);
    expect(binding?.splitOrientation).toBe("vertical");
    expect(binding?.permissions).toEqual({ local: "auto_read", remote: "auto_all" });

    state.setActiveSession("local");
    expect(useAppStore.getState().sidecarForSession("remote")?.focusedSessionId).toBe("local");
    expect(clampSidecarRatio(Number.NaN)).toBe(0.5);
  });

  it("prevents overlapping pairings", () => {
    addLocal();
    addRemote();
    addLocal("local-2");
    const remote2 = addRemote("remote-2");
    start();

    expect(
      useAppStore.getState().startSidecar("local-2", "local-2", "remote", remote2),
    ).toEqual({ ok: false, reason: "One of these terminals already belongs to another sidecar." });
  });

  it("marks SSH identity drift as sticky degradation", () => {
    addLocal();
    addRemote();
    start();

    useAppStore.getState().updateSessionUi("remote", {
      remote: { kind: "ssh", target: "other@example.test" },
      remoteHost: { id: "saved-other", label: "Other", color: null },
    });
    expect(useAppStore.getState().sidecarHealth("local")).toEqual({
      status: "degraded",
      degradation: { role: "remote", reason: "remote_identity_changed" },
    });

    // Returning signals to their old values is not enough: hand-typed or
    // changed-host reconnects need an explicit Replace/review action.
    useAppStore.getState().updateSessionUi("remote", {
      remote: { kind: "ssh", target: "deploy@example.test" },
      remoteHost: { id: "saved-remote", label: "Production", color: null },
    });
    expect(useAppStore.getState().sidecarForSession("remote")?.degraded).not.toBeNull();
  });

  it("replaces the companion target and resets both target permissions", () => {
    addLocal();
    addRemote();
    addRemote("remote-2", "deploy-2@example.test", "saved-remote-2", "Staging");
    start();
    useAppStore.getState().setSidecarPermission("local", "local", "auto_read");
    useAppStore.getState().setSidecarPermission("local", "remote", "auto_all");
    const state = useAppStore.getState();
    const identity = captureSidecarRemoteIdentity(
      state.sessions.find((session) => session.id === "remote-2"),
      state.sessionUi["remote-2"],
    );
    if (!identity) throw new Error("missing replacement identity");

    const result = state.replaceSidecarTarget("local", "remote", "remote-2", identity);

    expect(result.ok).toBe(true);
    expect(useAppStore.getState().sidecarForSession("local")).toMatchObject({
      remoteSessionId: "remote-2",
      permissions: { local: "ask", remote: "ask" },
      degraded: null,
    });
    expect(useAppStore.getState().resolveAiOwner("remote")).toBe("remote");
    expect(useAppStore.getState().resolveAiOwner("remote-2")).toBe("local");
  });

  it("preserves a recoverable degraded binding when the companion closes", () => {
    addLocal();
    addRemote();
    start();

    useAppStore.getState().removeSession("remote");

    expect(useAppStore.getState().sidecarForSession("local")?.degraded).toEqual({
      role: "remote",
      reason: "session_missing",
    });
    useAppStore.getState().removeSession("local");
    expect(useAppStore.getState().sidecars).toEqual({});
  });

  it("removes only the owning sidecar when unrelated pairings exist", () => {
    addLocal();
    addRemote();
    addLocal("local-2");
    addRemote("remote-2", "deploy-2@example.test", "saved-remote-2", "Staging");
    start();
    const unrelated = start("local-2", "local-2", "remote-2");

    useAppStore.getState().removeSession("local");

    expect(useAppStore.getState().sidecars).toEqual({ "local-2": unrelated });
    expect(useAppStore.getState().sidecarForSession("remote-2")?.ownerSessionId).toBe("local-2");
  });

  it("ends the binding and resets the owner when New Chat is invoked from either pane", () => {
    addLocal();
    addRemote();
    const companionMessage: AiMessage = {
      id: "companion",
      role: "user",
      content: "pre-existing remote chat",
      createdAt: "2026-08-22T12:00:00.000Z",
    };
    useAppStore.getState().pushAiMessage("local", { ...companionMessage, id: "owner" });
    useAppStore.getState().pushAiMessage("remote", companionMessage);
    useAppStore.getState().setAiMode("local", "agent");
    start();

    useAppStore.getState().newAiConversation("remote");

    expect(useAppStore.getState().sidecars).toEqual({});
    expect(useAppStore.getState().aiStreams.local.messages).toEqual([]);
    expect(useAppStore.getState().aiStreams.local.mode).toBe("agent");
    expect(useAppStore.getState().aiStreams.remote.messages).toEqual([companionMessage]);
  });

  it("never restores a transcript into a live pairing or with inherited authority", () => {
    addLocal();
    addRemote();
    start();
    useAppStore.getState().setPermissionMode("remote", "auto_all");

    useAppStore.getState().restoreAiTranscript(
      "remote",
      [{
        id: "restored",
        role: "user",
        content: "old work",
        createdAt: "2026-08-20T12:00:00.000Z",
      }],
      [],
      "2026-08-20T12:00:00.000Z",
    );

    expect(useAppStore.getState().sidecars).toEqual({});
    expect(useAppStore.getState().aiStreams.remote.permissionMode).toBe("ask");
  });

  it("health inspection can detect disposal without importing the terminal registry", () => {
    addLocal();
    addRemote();
    const binding = start();
    const health = inspectSidecarHealth(binding, useAppStore.getState(), {
      terminalAvailable: (sessionId) => sessionId !== "remote",
    });
    expect(health).toEqual({
      status: "degraded",
      degradation: { role: "remote", reason: "terminal_unavailable" },
    });
  });
});
