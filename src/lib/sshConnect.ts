/**
 * Connecting to a saved host — the side-effectful half of the ssh feature
 * (`ssh.ts` holds the pure string logic).
 *
 * Why we type `ssh …` into the local shell rather than spawning ssh as the
 * tab's process: a real login shell underneath means the tab survives `exit`,
 * shell integration keeps working, OSC 133 blocks keep being emitted, and
 * `detectNesting` gives us remote awareness for free. Spawning ssh directly
 * would buy a slightly shorter path and lose all four.
 */

import * as api from "./tauri";
import { useAppStore } from "../stores/appStore";
import { getTerm, subscribeTerm } from "./termRegistry";
import { isBusy } from "./ptyExec";
import { sanitizeCommand } from "./ptyExecShell";
import { buildSshCommand, shQuote } from "./ssh";
import { waitForFirstPrompt } from "./terminalReady";
import type { LaunchSpec, SshHost } from "./types";

export type ConnectTarget = "current-tab" | "new-tab";

export type Gate = { ok: true } | { ok: false; reason: string };

/** A connect we have typed but not yet seen come back as a block. Bound by
 *  exact command text so a simultaneous Enter from the user cannot claim it. */
export interface PendingConnect {
  hostId: string;
  label: string;
  color: string | null;
  command: string;
  at: number;
}

const pending = new Map<string, PendingConnect>();

interface PendingPasswordAutofill {
  attemptId: string;
  hostname: string;
  username: string;
  decoder: TextDecoder;
  tail: string;
  expiresAt: number;
}

const passwordAutofill = new Map<string, PendingPasswordAutofill>();
const passwordGenerations = new Map<string, symbol>();
const passwordObservers = new Map<string, () => void>();

type PasswordPreparation =
  | { kind: "armed"; generation: symbol; attemptId: string }
  | { kind: "manual"; generation: symbol }
  | { kind: "cancelled" };

/** Long enough to survive a slow prompt, short enough that an abandoned connect
 *  cannot label an unrelated ssh five minutes later. */
const PENDING_TTL_MS = 30_000;
const PASSWORD_AUTOFILL_TTL_MS = 60_000;

export function notePendingConnect(sessionId: string, p: PendingConnect): void {
  pending.set(sessionId, p);
}

/**
 * Claim the pending connect for a block, but ONLY when the command text matches
 * exactly — the same rule ptyExec uses for block binding, and for the same
 * reason: the user may have hit Enter at the same instant. A non-matching block
 * leaves the entry in place so the real one can still bind.
 */
export function takePendingConnect(sessionId: string, command: string): PendingConnect | null {
  const p = pending.get(sessionId);
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(sessionId);
    return null;
  }
  if (p.command.trim() !== command.trim()) return null;
  pending.delete(sessionId);
  return p;
}

export function clearPendingConnect(sessionId: string): void {
  pending.delete(sessionId);
  passwordGenerations.delete(sessionId);
  passwordObservers.get(sessionId)?.();
  passwordObservers.delete(sessionId);
  const attempt = passwordAutofill.get(sessionId);
  passwordAutofill.delete(sessionId);
  if (attempt) void api.sshHostsCancelPassword(sessionId, attempt.attemptId).catch(() => {});
}

function beginConnection(sessionId: string): symbol {
  clearPendingConnect(sessionId);
  const generation = Symbol();
  passwordGenerations.set(sessionId, generation);
  passwordObservers.set(sessionId, subscribeTerm(sessionId, (event) => {
    if (event.type === "userInput" || event.type === "disposed") clearPendingConnect(sessionId);
  }));
  return generation;
}

function stillOwnsConnection(sessionId: string, preparation: PasswordPreparation): preparation is Exclude<PasswordPreparation, { kind: "cancelled" }> {
  return preparation.kind !== "cancelled" && passwordGenerations.get(sessionId) === preparation.generation;
}

/** Prompt matching is an IPC trigger only; native independently verifies the
 * launch, destination, terminal input mode and foreground process. */
export function isSshPasswordPrompt(
  text: string,
  hostname: string,
  username: string,
): boolean {
  const visible = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = visible.split(/[\r\n]/);
  const line = lines[lines.length - 1] ?? "";
  return Boolean(hostname && username) && line.trim() === `${username}@${hostname}'s password:`;
}

export async function notePasswordAutofill(sessionId: string, host: SshHost, command = buildSshCommand(host), generation = beginConnection(sessionId)): Promise<PasswordPreparation> {
  const manual = (): PasswordPreparation => passwordGenerations.get(sessionId) === generation
    ? { kind: "manual", generation } : { kind: "cancelled" };
  if (passwordGenerations.get(sessionId) !== generation) return { kind: "cancelled" };
  // Unsupported authentication is deliberately manual. Native validates this
  // again against the saved host and its own observed local shell prompt.
  if (!host.has_password || !host.username || [host.identity_file, host.jump_host, host.extra_args, host.remote_dir, host.post_connect, host.config_alias].some((value) => value?.trim())) return manual();
  let attemptId: string;
  try {
    attemptId = await api.sshHostsBeginPassword(host.id, sessionId, command);
  } catch {
    return manual(); // A refusal permits manual entry only while this launch still owns the tab.
  }
  if (passwordGenerations.get(sessionId) !== generation) {
    void api.sshHostsCancelPassword(sessionId, attemptId).catch(() => {});
    return { kind: "cancelled" };
  }
  passwordAutofill.set(sessionId, {
    attemptId,
    hostname: host.hostname,
    username: host.username,
    decoder: new TextDecoder(),
    tail: "",
    expiresAt: Date.now() + PASSWORD_AUTOFILL_TTL_MS,
  });
  return { kind: "armed", generation, attemptId };
}

/** Inspect terminal output for one matching prompt. The frontend observes only
 *  prompt text. The backend resolves and writes the secret directly to the PTY. */
export function observeSshPasswordPrompt(sessionId: string, bytes: Uint8Array): void {
  const pendingPassword = passwordAutofill.get(sessionId);
  if (!pendingPassword) return;
  if (Date.now() > pendingPassword.expiresAt) {
    clearPendingConnect(sessionId);
    return;
  }
  pendingPassword.tail = `${pendingPassword.tail}${pendingPassword.decoder.decode(bytes, { stream: true })}`.slice(
    -1024,
  );
  if (
    !isSshPasswordPrompt(
      pendingPassword.tail,
      pendingPassword.hostname,
      pendingPassword.username,
    )
  ) {
    return;
  }

  // Consume before invoking so duplicate chunks or React lifecycle work can
  // never submit the same password twice after a failed authentication.
  passwordAutofill.delete(sessionId);
  passwordObservers.get(sessionId)?.();
  passwordObservers.delete(sessionId);
  void api
    .sshHostsWritePassword(pendingPassword.attemptId, sessionId)
    .catch((error) => console.error(`SSH password autofill failed (${sessionId}):`, error));
}

/**
 * Whether it is safe to type a connect into this tab right now.
 *
 * Note the prompt check uses `isAtPromptColumn()`, not `phase === "prompt"`:
 * OSC 133;A sets "prompt" but 133;B — emitted at the very end of PS1 — moves it
 * straight to "input", so the resting state at an empty prompt is "input" and a
 * phase check would reject essentially always.
 */
export function canConnectHere(sessionId: string | null): Gate {
  if (!sessionId) return { ok: false, reason: "there is no open terminal" };

  const state = useAppStore.getState();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return { ok: false, reason: "there is no open terminal" };
  if (session.exited) return { ok: false, reason: "this tab's shell has exited" };

  if (isBusy(sessionId)) return { ok: false, reason: "the agent is running a command here" };

  const ui = state.sessionUi[sessionId];
  if (ui?.remote) {
    // Connecting inside an existing ssh session would send this machine's
    // identity-file path to the remote host's ssh. Always a new tab instead.
    return { ok: false, reason: "this tab is already connected to a remote host" };
  }

  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) return { ok: false, reason: "this tab's shell has exited" };

  // With shell integration off there is no phase signal at all, so
  // isAtPromptColumn() is permanently false — type blind, exactly as the
  // palette's history ⌘⏎ path already does.
  if (ui?.integrationActive && !entry.tracker.isAtPromptColumn()) {
    return { ok: false, reason: "this tab is busy or you're mid-command" };
  }

  return { ok: true };
}

/**
 * Open (or reuse) a tab and connect. Returns the session it acted on, or null
 * when the command could not be built or the target tab refused it.
 *
 * `createSession` is injected rather than imported because it comes from the
 * `useSessions` hook.
 */
export async function connectToHost(
  hostRow: SshHost,
  target: ConnectTarget,
  createSession: (spec?: LaunchSpec) => Promise<string>,
  currentSessionId?: string,
  /** Extra launch options for the `"new-tab"` path, merged into the one
   *  `createSession` call. Added for scheduled runs, which need an UNFOCUSED tab
   *  with seeded dimensions — a background pane never fits, so without `dims`
   *  every command in the run would see 80×24 and truncate. Reimplementing the
   *  connect in the caller would fork `buildSshCommand` handling and lose
   *  password autofill, so it is widened here instead. */
  spec?: Pick<LaunchSpec, "activate" | "dims" | "userTitle">,
): Promise<string | null> {
  const gated = sanitizeCommand(buildSshCommand(hostRow));
  if (!gated.ok) {
    console.error(`cannot connect to "${hostRow.label}": ${gated.reason}`);
    return null;
  }

  const note: Omit<PendingConnect, "at"> = {
    hostId: hostRow.id,
    label: hostRow.label,
    color: hostRow.color,
    command: gated.command,
  };

  if (target === "new-tab") {
    const sessionId = await createSession({
      ...spec,
      hostId: hostRow.id,
      title: hostRow.label,
    });
    const generation = beginConnection(sessionId);
    await waitForFirstPrompt(sessionId, 8_000);
    if (passwordGenerations.get(sessionId) !== generation) return null;
    const gate = canConnectHere(sessionId);
    if (!gate.ok) { clearPendingConnect(sessionId); return null; }
    notePendingConnect(sessionId, { ...note, at: Date.now() });
    const preparation = await notePasswordAutofill(sessionId, hostRow, gated.command, generation);
    if (!stillOwnsConnection(sessionId, preparation)) return null;
    if (!canConnectHere(sessionId).ok) { clearPendingConnect(sessionId); return null; }
    try {
      await api.ptyWrite(sessionId, `${gated.command}\r`, preparation.kind === "armed" ? preparation.attemptId : undefined);
    } catch (error) {
      if (stillOwnsConnection(sessionId, preparation)) clearPendingConnect(sessionId);
      console.error(`connect write failed (${sessionId}):`, error);
      return null;
    }
    return sessionId;
  }

  const sessionId = currentSessionId ?? useAppStore.getState().activeSessionId;
  // Re-checked at write time, not just at render time: the palette computed its
  // gate when it opened, and a command may have started since.
  const gate = canConnectHere(sessionId);
  if (!sessionId || !gate.ok) {
    console.warn(`cannot connect here: ${gate.ok ? "no session" : gate.reason}`);
    return null;
  }

  const generation = beginConnection(sessionId);
  notePendingConnect(sessionId, { ...note, at: Date.now() });
  const preparation = await notePasswordAutofill(sessionId, hostRow, gated.command, generation);
  if (!stillOwnsConnection(sessionId, preparation)) return null;
  if (!canConnectHere(sessionId).ok) { clearPendingConnect(sessionId); return null; }
  useAppStore.getState().updateSession(sessionId, {
    hostId: hostRow.id,
    hostLabel: hostRow.label,
  });
  try {
    await api.ptyWrite(sessionId, `${gated.command}\r`, preparation.kind === "armed" ? preparation.attemptId : undefined);
  } catch (err) {
    if (stillOwnsConnection(sessionId, preparation)) clearPendingConnect(sessionId);
    console.error(`connect write failed (${sessionId}):`, err);
    return null;
  }
  return sessionId;
}

/** Re-enter an ad-hoc SSH target whose original command was not launched from
 * the saved-host list. Sidecar freezes the parsed target, but deliberately does
 * not retain arbitrary command text; quoting the target makes this a safe,
 * minimal `ssh host` reconnect instead of replaying an untrusted shell line. */
export async function connectToSshTarget(
  target: string,
  sessionId: string,
): Promise<string | null> {
  const command = sanitizeCommand(`ssh ${shQuote(target.trim())}`);
  if (!command.ok) return null;

  const gate = canConnectHere(sessionId);
  if (!gate.ok) return null;

  try {
    await api.ptyWrite(sessionId, `${command.command}\r`);
    return sessionId;
  } catch (err) {
    console.error(`reconnect write failed (${sessionId}):`, err);
    return null;
  }
}
