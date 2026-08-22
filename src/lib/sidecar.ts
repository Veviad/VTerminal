import type { PermissionMode } from "./permissionMode";
import type { AgentTargetRole, RemoteContext, Session } from "./types";

/** The two execution environments exposed to a linked agent conversation. */
export type { AgentTargetRole } from "./types";

export type SidecarSplitOrientation = "horizontal" | "vertical";

export interface SidecarRemoteIdentity {
  /** V1 only links an SSH-like nested shell (`ssh`, `mosh`, or `et`). */
  kind: "ssh";
  /** The target parsed from the command that opened the nested shell. */
  target: string | null;
  /** Strong identity for connections launched from the saved-host list. */
  hostId: string | null;
  /** Stable human label archived on command cards and shown in target chips. */
  label: string;
}

export type SidecarDegradedReason =
  | "session_missing"
  | "shell_exited"
  | "terminal_unavailable"
  | "local_became_remote"
  | "remote_disconnected"
  | "remote_identity_changed";

export interface SidecarDegradation {
  role: AgentTargetRole;
  reason: SidecarDegradedReason;
}

export interface SidecarBinding {
  /** Owns the one AI transcript shared by both linked tabs. */
  ownerSessionId: string;
  localSessionId: string;
  remoteSessionId: string;
  remoteIdentity: SidecarRemoteIdentity;
  permissions: Record<AgentTargetRole, PermissionMode>;
  /** Presentation order only. Roles and command routing never swap. */
  paneOrder: readonly [AgentTargetRole, AgentTargetRole];
  splitRatio: number;
  splitOrientation: SidecarSplitOrientation;
  focusedSessionId: string;
  /** Sticky until explicit replacement/recovery, so a reconnect cannot silently
   *  authorize a session whose identity has not been reviewed. */
  degraded: SidecarDegradation | null;
}

/** The subset of SessionUiState needed by this dependency-free domain layer. */
export interface SidecarSessionUi {
  runningBlockId: string | null;
  remote: RemoteContext | null;
  nestedBlockId: string | null;
  remoteHost: { id: string; label: string; color: string | null } | null;
}

export interface SidecarStateView {
  sessions: readonly Session[];
  sessionUi: Readonly<Record<string, SidecarSessionUi | undefined>>;
  aiStreams?: Readonly<Record<string, { status: string } | undefined>>;
}

export interface SidecarRuntimeView {
  /** Omit when no terminal registry is available (for example, store tests). */
  terminalAvailable?: (sessionId: string) => boolean;
}

export type SidecarValidation = { ok: true } | { ok: false; reason: string };

export type SidecarStartResult =
  | { ok: true; binding: SidecarBinding }
  | { ok: false; reason: string };

export interface SidecarHealth {
  status: "active" | "degraded";
  degradation: SidecarDegradation | null;
}

export const SIDECAR_DEFAULT_RATIO = 0.5;
export const SIDECAR_MIN_RATIO = 0.3;
export const SIDECAR_MAX_RATIO = 0.7;

export function clampSidecarRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SIDECAR_DEFAULT_RATIO;
  return Math.min(SIDECAR_MAX_RATIO, Math.max(SIDECAR_MIN_RATIO, ratio));
}

export function sessionIdForRole(
  binding: SidecarBinding,
  role: AgentTargetRole,
): string {
  return role === "local" ? binding.localSessionId : binding.remoteSessionId;
}

export function roleForSession(
  binding: SidecarBinding,
  sessionId: string,
): AgentTargetRole | null {
  if (binding.localSessionId === sessionId) return "local";
  if (binding.remoteSessionId === sessionId) return "remote";
  return null;
}

/** Find a binding from its owner or either member. The store prevents overlap,
 *  so there can be at most one result. */
export function sidecarForSession(
  sidecars: Readonly<Record<string, SidecarBinding>>,
  sessionId: string,
): SidecarBinding | null {
  return (
    Object.values(sidecars).find(
      (binding) =>
        binding.ownerSessionId === sessionId ||
        binding.localSessionId === sessionId ||
        binding.remoteSessionId === sessionId,
    ) ?? null
  );
}

/** Resolve UI events from either linked pane onto the shared transcript owner. */
export function resolveAiOwner(
  sidecars: Readonly<Record<string, SidecarBinding>>,
  sessionId: string,
): string {
  return sidecarForSession(sidecars, sessionId)?.ownerSessionId ?? sessionId;
}

export function captureSidecarRemoteIdentity(
  session: Session | undefined,
  ui: SidecarSessionUi | undefined,
): SidecarRemoteIdentity | null {
  if (!session || !ui || ui.remote?.kind !== "ssh") return null;
  const target = normalizedTarget(ui.remote.target);
  const hostId = ui.remoteHost?.id ?? null;
  // Without either proof a disconnect/reconnect cannot be distinguished from
  // an entirely different host, so the session is not eligible for pairing.
  if (!target && !hostId) return null;
  const label =
    ui.remoteHost?.label?.trim() ||
    ui.remote.target?.trim() ||
    session.hostLabel?.trim() ||
    "SSH session";
  return {
    kind: "ssh",
    target,
    hostId,
    label,
  };
}

/** Pairing-popover eligibility. A remote SSH session legitimately owns one
 *  long-running local `ssh` block, so that block is not treated as busy. */
export function validateSidecarTarget(
  view: SidecarStateView,
  sessionId: string,
  role: AgentTargetRole,
  runtime: SidecarRuntimeView = {},
): SidecarValidation {
  const session = view.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return { ok: false, reason: "Terminal no longer exists." };
  if (session.exited) return { ok: false, reason: "Terminal shell has exited." };
  if (runtime.terminalAvailable && !runtime.terminalAvailable(sessionId)) {
    return { ok: false, reason: "Terminal is not available." };
  }

  const ui = view.sessionUi[sessionId];
  if (!ui) return { ok: false, reason: "Terminal is still starting." };

  const aiStatus = view.aiStreams?.[sessionId]?.status;
  if (aiStatus === "streaming" || aiStatus === "awaiting_approval" || aiStatus === "executing") {
    return { ok: false, reason: "Agent activity is already in progress in this terminal." };
  }

  if (role === "local") {
    if (ui.remote) return { ok: false, reason: "Local target is inside a nested session." };
    if (ui.runningBlockId) return { ok: false, reason: "Local terminal is busy." };
    return { ok: true };
  }

  if (ui.remote?.kind !== "ssh") {
    return { ok: false, reason: "Remote target is not inside a live SSH session." };
  }
  if (!ui.nestedBlockId || ui.runningBlockId !== ui.nestedBlockId) {
    return { ok: false, reason: "Remote terminal is busy or its SSH session cannot be verified." };
  }
  if (!captureSidecarRemoteIdentity(session, ui)) {
    return { ok: false, reason: "Remote SSH identity cannot be verified." };
  }
  return { ok: true };
}

export function createSidecarBinding(
  view: SidecarStateView,
  sidecars: Readonly<Record<string, SidecarBinding>>,
  ownerSessionId: string,
  localSessionId: string,
  remoteSessionId: string,
  remoteIdentity: SidecarRemoteIdentity,
  runtime: SidecarRuntimeView = {},
): SidecarStartResult {
  if (localSessionId === remoteSessionId) {
    return { ok: false, reason: "Choose two different terminals." };
  }
  if (ownerSessionId !== localSessionId && ownerSessionId !== remoteSessionId) {
    return { ok: false, reason: "The conversation owner must be one of the linked terminals." };
  }
  if (sidecarForSession(sidecars, ownerSessionId)) {
    return { ok: false, reason: "The conversation already belongs to a sidecar." };
  }
  if (sidecarForSession(sidecars, localSessionId) || sidecarForSession(sidecars, remoteSessionId)) {
    return { ok: false, reason: "One of these terminals already belongs to another sidecar." };
  }

  const local = validateSidecarTarget(view, localSessionId, "local", runtime);
  if (!local.ok) return local;
  const remote = validateSidecarTarget(view, remoteSessionId, "remote", runtime);
  if (!remote.ok) return remote;

  const liveIdentity = captureSidecarRemoteIdentity(
    view.sessions.find((session) => session.id === remoteSessionId),
    view.sessionUi[remoteSessionId],
  );
  if (!liveIdentity || !sameRemoteIdentity(liveIdentity, remoteIdentity)) {
    return { ok: false, reason: "The SSH target changed while the sidecar was being created." };
  }

  return {
    ok: true,
    binding: {
      ownerSessionId,
      localSessionId,
      remoteSessionId,
      remoteIdentity: liveIdentity,
      permissions: { local: "ask", remote: "ask" },
      paneOrder: ["local", "remote"],
      splitRatio: SIDECAR_DEFAULT_RATIO,
      splitOrientation: "horizontal",
      focusedSessionId: ownerSessionId,
      degraded: null,
    },
  };
}

/** Live binding validation. Busy commands are deliberately not degradation:
 *  command execution is normal sidecar operation; disappearance or identity
 *  drift is what makes the binding unsafe. */
export function inspectSidecarHealth(
  binding: SidecarBinding,
  view: Pick<SidecarStateView, "sessions" | "sessionUi">,
  runtime: SidecarRuntimeView = {},
): SidecarHealth {
  if (binding.degraded) return { status: "degraded", degradation: binding.degraded };

  const localIssue = inspectMember(binding, "local", view, runtime);
  if (localIssue) return { status: "degraded", degradation: localIssue };
  const remoteIssue = inspectMember(binding, "remote", view, runtime);
  if (remoteIssue) return { status: "degraded", degradation: remoteIssue };
  return { status: "active", degradation: null };
}

/** Derive current liveness while ignoring a previously sticky degradation.
 *  Used by explicit Replace/Recover actions after the user has reviewed it. */
export function inspectCurrentSidecarHealth(
  binding: SidecarBinding,
  view: Pick<SidecarStateView, "sessions" | "sessionUi">,
  runtime: SidecarRuntimeView = {},
): SidecarHealth {
  return inspectSidecarHealth({ ...binding, degraded: null }, view, runtime);
}

export function sameRemoteIdentity(
  left: SidecarRemoteIdentity,
  right: SidecarRemoteIdentity,
): boolean {
  if (left.kind !== right.kind) return false;
  // A saved-host id is the strongest available proof and must agree on both
  // sides. A hand-typed connection falls back to its parsed SSH target.
  if (left.hostId !== null || right.hostId !== null) {
    return left.hostId !== null && left.hostId === right.hostId;
  }
  return normalizedTarget(left.target) === normalizedTarget(right.target);
}

function inspectMember(
  binding: SidecarBinding,
  role: AgentTargetRole,
  view: Pick<SidecarStateView, "sessions" | "sessionUi">,
  runtime: SidecarRuntimeView,
): SidecarDegradation | null {
  const sessionId = sessionIdForRole(binding, role);
  const session = view.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return { role, reason: "session_missing" };
  if (session.exited) return { role, reason: "shell_exited" };
  if (runtime.terminalAvailable && !runtime.terminalAvailable(sessionId)) {
    return { role, reason: "terminal_unavailable" };
  }

  const ui = view.sessionUi[sessionId];
  if (!ui) return { role, reason: "terminal_unavailable" };
  if (role === "local") {
    return ui.remote ? { role, reason: "local_became_remote" } : null;
  }

  if (ui.remote?.kind !== "ssh") return { role, reason: "remote_disconnected" };
  const identity = captureSidecarRemoteIdentity(session, ui);
  if (!identity || !sameRemoteIdentity(identity, binding.remoteIdentity)) {
    return { role, reason: "remote_identity_changed" };
  }
  return null;
}

function normalizedTarget(target: string | null): string | null {
  const normalized = target?.trim() ?? "";
  return normalized || null;
}
