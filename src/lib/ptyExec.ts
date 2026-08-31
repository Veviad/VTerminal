import * as api from "./tauri";
import type { IDisposable, IMarker } from "@xterm/xterm";
import { getTerm, subscribeTerm, type TermEvent } from "./termRegistry";
import { readLineRangeResult, type ReadRangeResult } from "./terminalSnapshot";
import { useAppStore } from "../stores/appStore";
import {
  PRIVATE_OUTPUT_NOTICE,
  type CommandStall,
  type OutputPolicy,
  type RemoteContext,
} from "./types";
import { protectPrivateTerminal } from "./runbookTerminalPrivacy";
import {
  canSentinel,
  dialectFromProbe,
  hardenCommand,
  parsePrivateToken,
  prefixCommandEnvironment,
  probeFor,
  sanitizeCommand,
  sentinelSuffix,
  suppressPrivateOutput,
  type HardenedCommand,
  type ExecMode,
  type PrivateToken,
  type ShellDialect,
} from "./ptyExecShell";

// Running an approved agent command in the user's LIVE terminal.
//
// The backend cannot do this itself: it never inspects PTY bytes (all OSC
// parsing is frontend-side, because xterm reassembles sequences split across
// chunk boundaries). So Rust asks, via StreamEvent::RunInTerminal, and we type
// the command, watch for it to finish, and report back.
//
// Two completion modes, picked per command:
//   integrated — the local shell runs our zsh hooks: bind to the real Block and
//                take its exit code from OSC 133;D.
//   sentinel   — a remote or deterministic caller appends a `printf` carrying
//                the command status and a fresh per-command nonce. Remote
//                commands must also prove that a shell — not a pager or a REPL
//                — is reading the terminal; that proof is a separately-bound
//                nonce probe, and it is reused for as long as the terminal
//                epoch it was taken in is provably unchanged (`ShellProof`).
//
// While a job is in flight the terminal is also WATCHED, because a command that
// hangs is otherwise indistinguishable from one that is working: `hardenCommand`
// prevents the pager and stdin hangs it can, and `classifyStall` catches the rest
// from bytes we already parse. Only one signal is acted on automatically — see
// the invariants.
//
// Invariants worth keeping:
//   * The COMMAND is typed AT MOST ONCE per job, and never at all if the gate
//     never opens. Retrying a command in someone's live shell is not recoverable.
//   * A wall-clock timeout NEVER kills anything. Missing completion is not proof
//     that the command is still running; the result remains unknown until the
//     user verifies the terminal.
//   * Idle alone NEVER interrupts. `aide --init` emits nothing for ten minutes
//     and must survive untouched; only the alternate-screen flip is unambiguous
//     enough to earn an automatic Ctrl-C, and only because the pre-flight gate
//     proved we were at a shell prompt before we typed.
//   * Control bytes are only ever written by `interrupt`, never from model text
//     (`sanitizeCommand` still rejects every control char on the command path).
//   * Exactly one resolve per job (`settled`), so the caller submits one result.

export type ExecError =
  | "timeout"
  | "terminal_busy"
  | "terminal_closed"
  | "not_a_shell"
  | "command_not_observed"
  | "unsafe_command"
  | "interrupted"
  | "interrupt_failed"
  | "target_changed"
  | "cancelled";

export interface PtyExecOutcome {
  exitCode: number | null;
  output: string;
  durationMs: number;
  mode: ExecMode | null;
  error?: ExecError;
  /** Model-facing explanation, prepended to the tool result. */
  note?: string;
  /** Explicit local tail-capture metadata, before evidence reaches Rust. */
  outputTruncated?: boolean;
  outputObservedBytes?: number;
  outputCapturedBytes?: number;
}

interface Job {
  approvalId: string;
  /** What the model proposed and the user approved — model-facing text. */
  command: string;
  /**
   * What was actually typed, minus any sentinel. Integrated mode binds a block
   * by comparing this against the command OSC 6973;CMD reports, so it MUST be
   * the hardened line: matching on `command` binds nothing once hardening adds
   * an env prefix, and every run dies as `command_not_observed`.
   */
  typed: string;
  mode: ExecMode;
  nonce: string;
  startedAt: number;
  startLine: number;
  /** Live anchor for sentinel output. Its disposal proves scrollback loss. */
  startMarker: IMarker | null;
  startMarkerListener: IDisposable | null;
  boundBlockId: string | null;
  foreignBlocks: number;
  /** Scrollback was trimmed before capture; byte count is then a lower bound. */
  outputLost: boolean;
  injected: boolean;
  settled: boolean;
  /** Live hang classification, republished to the card on every refresh tick. */
  stall: CommandStall | null;
  /** Wall-clock spent waiting for the USER (a password prompt), excluded from
   *  the timeout: that is not time the command spent hanging. */
  pausedMs: number;
  lastTickAt: number;
  /** Why the terminal was interrupted, for the model-facing note. */
  interruptedBy: "tui" | "user" | null;
  userInterruptPending: boolean;
  interruptGracePending: boolean;
  ladderRunning: boolean;
  finish(outcome: PtyExecOutcome): void;
  /** Hand the terminal back to the shell. `tui` escalates; `user` sends only
   *  SIGINT (extra keys would land on the user's prompt as stray text). */
  interrupt(trigger: "tui" | "user"): boolean;
}

const jobs = new Map<string, Job>();
/** Synchronous ownership from the first preflight check until the live Job
 * settles. This closes the async gap before `jobs.set`, where two callers could
 * otherwise probe and dispatch into the same terminal concurrently. */
const preflightReservations = new Map<string, string>();
interface ResolvedExecMode {
  mode: ExecMode;
  dialect: ShellDialect;
}

interface ApprovalPromptSnapshot {
  sessionId: string;
  entry: NonNullable<ReturnType<typeof getTerm>>;
  bufferType: string;
  row: number;
  cursorX: number;
  lastDataAt: number;
  lastUserInputAt: number;
  capturedAt: number;
}

/** Opaque, one-shot bindings from an operator's approval click to the exact
 * terminal epoch they attested. They never cross IPC or enter persistence. */
const approvalPromptBindings = new Map<string, ApprovalPromptSnapshot>();
const APPROVAL_PROMPT_TTL_MS = 30_000;

const IDLE_WAIT_MAX_MS = 20_000;
const IDLE_POLL_MS = 100;
const QUIESCENCE_MS = 600;
const BLOCK_BIND_MS = 5_000;
const PROBE_WAIT_MS = 2_000;
const CARD_REFRESH_MS = 750;
const MODEL_TAIL = 8_192;
const CARD_TAIL = 4_096;

/** How long output must stop before a running command counts as stalled. */
const STALL_IDLE_MS = 30_000;
/** Pause between rungs of the interrupt ladder. */
const LADDER_STEP_MS = 400;
/** Time allowed for the shell's ordinary completion signal after user SIGINT. */
const USER_INTERRUPT_GRACE_MS = 1_000;
/** Time allowed for the PTY bridge to confirm that it accepted user SIGINT. */
const USER_INTERRUPT_DELIVERY_TIMEOUT_MS = 1_000;
/**
 * Absolute frontend reporting slack. Logical command time still pauses at a
 * password prompt, but the webview must settle before Rust's 30-second
 * watchdog grace can expire and discard the result channel.
 */
const FRONTEND_WATCHDOG_GRACE_MS = 15_000;

/**
 * Escalating attempts to return a hijacked terminal to its shell.
 *
 * SIGINT first (it is enough for most things and never types visible text), then
 * `q` for the pagers and `top`/`man` family, then vim's own escape hatch. A
 * stray `q` typed at a vim in insert mode is discarded by the `:q!` that
 * follows, so the order is safe in both directions.
 */
const LADDER = ["\x03", "q", "\x1b:q!\r"];

const PASSWORD_ROW = /(?:password|passphrase)[^:]*:\s*$/i;
/**
 * Rows that mean a program is waiting for a keystroke. Only consulted after
 * STALL_IDLE_MS, which is what makes the loose ones safe: `(END)`, a lone `:`
 * and `lines N-M` are systemd's pager, which sets `LESS=FRSXMK` — the `X` keeps
 * it OFF the alternate screen, so it is invisible to the TUI signal.
 */
const CONFIRM_ROW =
  /\[y\/n\]|\(yes\/no|press (?:enter|any key)|continue\?|overwrite\?|\(END\)|^\s*:\s*$|^\s*lines \d+-\d+/i;

export function isBusy(sessionId: string): boolean {
  return jobs.has(sessionId) || preflightReservations.has(sessionId);
}

/** Capture the exact visible terminal state the operator is attesting. A human
 * still establishes that this is a POSIX prompt; the binding proves only that
 * the row did not change between that gesture and the eventual PTY write. */
export function captureApprovalPromptBinding(sessionId: string): string | null {
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) return null;
  const buffer = entry.term.buffer.active;
  if (buffer.type !== "normal") return null;
  const row = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
  if (buffer.cursorX <= 0 || row.trim().length === 0) return null;
  const token = `${sessionId}:${Date.now()}:${makeNonce()}`;
  approvalPromptBindings.set(token, {
    sessionId,
    entry,
    bufferType: buffer.type,
    row: buffer.baseY + buffer.cursorY,
    cursorX: buffer.cursorX,
    lastDataAt: entry.lastDataAt,
    lastUserInputAt: entry.lastUserInputAt,
    capturedAt: Date.now(),
  });
  setTimeout(() => approvalPromptBindings.delete(token), APPROVAL_PROMPT_TTL_MS + 1_000);
  return token;
}

export function releaseApprovalPromptBinding(token: string): void {
  approvalPromptBindings.delete(token);
}

/** Capture a binding once the terminal has been quiet for `quiescenceMs`.
 *
 * `promptMatchesApproval` compares `lastDataAt`/`lastUserInputAt` for EXACT
 * equality, and `runInTerminal` consumes the binding before its own tolerant
 * quiescence wait — so a binding taken while the shell is still painting its
 * prompt is invalid by the time it is used, and the attempt settles unknown with
 * `target_changed`. A human clicking Approve is always already at a quiet
 * prompt; run-level auto-approve is not, because it answers `ApprovalRequested`
 * milliseconds after the previous command finished. Hence the wait, and hence it
 * lives here rather than in `runInTerminal`.
 *
 * Resolves null on timeout, a closed terminal, or the alternate screen. The
 * timeout stays well under `APPROVAL_PROMPT_TTL_MS` so a returned token always
 * has time left to be consumed.
 */
export function awaitApprovalPromptBinding(
  sessionId: string,
  opts: { quiescenceMs?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const quiescenceMs = opts.quiescenceMs ?? QUIESCENCE_MS;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const tick = () => {
      const entry = getTerm(sessionId);
      if (!entry || entry.disposed) {
        resolve(null);
        return;
      }
      const now = Date.now();
      if (
        now - entry.lastDataAt >= quiescenceMs &&
        now - entry.lastUserInputAt >= quiescenceMs
      ) {
        resolve(captureApprovalPromptBinding(sessionId));
        return;
      }
      if (now >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, IDLE_POLL_MS);
    };
    tick();
  });
}

function consumeApprovalPromptBinding(
  token: string | undefined,
  sessionId: string,
): ApprovalPromptSnapshot | null {
  if (!token) return null;
  const snapshot = approvalPromptBindings.get(token) ?? null;
  approvalPromptBindings.delete(token);
  if (
    !snapshot
    || snapshot.sessionId !== sessionId
    || Date.now() - snapshot.capturedAt > APPROVAL_PROMPT_TTL_MS
  ) return null;
  return snapshot;
}

function promptMatchesApproval(snapshot: ApprovalPromptSnapshot): boolean {
  const entry = getTerm(snapshot.sessionId);
  const buffer = entry?.term.buffer.active;
  return !!entry
    && entry === snapshot.entry
    && !entry.disposed
    && buffer?.type === snapshot.bufferType
    && buffer.type === "normal"
    && buffer.baseY + buffer.cursorY === snapshot.row
    && buffer.cursorX === snapshot.cursorX
    && entry.lastDataAt === snapshot.lastDataAt
    && entry.lastUserInputAt === snapshot.lastUserInputAt;
}

/**
 * Hand the terminal back to the shell, on the user's own gesture.
 *
 * Exported for the command card's Interrupt button: the `input` and `idle`
 * stalls are heuristics, so the app surfaces them and the user decides.
 */
export function interruptJob(sessionId: string, expectedApprovalId: string): boolean {
  const job = jobs.get(sessionId);
  if (!job || job.approvalId !== expectedApprovalId) {
    return false;
  }
  return job.interrupt("user");
}

/**
 * Forget a session's remote shell proof.
 *
 * Called when the nested block ends (the local shell is back in the foreground,
 * so the proof describes a shell that no longer exists) and when the tab closes.
 */
export function forgetShellProof(sessionId: string): void {
  shellProofs.delete(sessionId);
}

/** Release a pending command without touching the terminal. */
export function abortSession(
  sessionId: string,
  reason: "cancelled" | "closed" = "cancelled",
  expectedApprovalId?: string,
): boolean {
  const job = jobs.get(sessionId);
  if (!job || (expectedApprovalId !== undefined && job.approvalId !== expectedApprovalId)) return false;
  job.finish({
    exitCode: null,
    output: "",
    durationMs: Date.now() - job.startedAt,
    mode: job.mode,
    error: reason === "closed" ? "terminal_closed" : "cancelled",
  });
  return true;
}

export interface RunOptions {
  timeoutMs?: number;
  idleWaitMs?: number;
  tailLimit?: number;
  /** Validated, non-secret values scoped to this one command invocation. */
  environment?: Record<string, string>;
  /** Runbooks set this false because Rust already owns and records the guards. */
  harden?: boolean;
  /** Atomic backend dispatch authorization. Remote deterministic runs acquire
   *  it before their authorized probe; other runs acquire it before dispatch. */
  beforeWrite?: () => boolean | Promise<boolean>;
  /** Final synchronous target/feature guard, checked immediately before write. */
  canWrite?: () => boolean;
  /** Require a fresh per-command completion token even when shell integration exists. */
  nonceCompletion?: boolean;
  /** One-shot terminal epoch captured by the operator's Runbook approval. */
  approvalPromptBinding?: string;
  /** Discard stdout and stderr before either can be harvested into app state. */
  outputPolicy?: OutputPolicy;
}

export async function runInTerminal(
  sessionId: string,
  approvalId: string,
  rawCommand: string,
  opts: RunOptions = {},
): Promise<PtyExecOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const idleWaitMs = opts.idleWaitMs ?? IDLE_WAIT_MAX_MS;
  const tailLimit = opts.tailLimit ?? MODEL_TAIL;
  const privateOutput = opts.outputPolicy === "private";
  const startedAt = Date.now();
  const remoteAtStart = useAppStore.getState().sessionUi[sessionId]?.remote ?? null;
  const authorizedRemoteProbe = !!opts.nonceCompletion && !!remoteAtStart;

  const sanitized = sanitizeCommand(rawCommand);
  if (!sanitized.ok) {
    return {
      exitCode: null,
      output: "",
      durationMs: 0,
      mode: null,
      error: "unsafe_command",
      note: `Nothing was executed: ${sanitized.reason}. Rewrite it as a single line without control characters.`,
    };
  }
  const command = sanitized.command;

  if (jobs.has(sessionId) || preflightReservations.has(sessionId)) {
    return busyOutcome(startedAt, null, "another command is still being awaited in this terminal");
  }
  if (!liveEntry(sessionId)) {
    return closedOutcome(startedAt, null);
  }
  // Remote execution and deterministic callers are known up front to require a
  // suffix. Reject structurally unsafe input before a lease is claimed or any
  // capability probe is written to the terminal.
  if ((remoteAtStart || opts.nonceCompletion) && !canSentinel(command)) {
    return unsafeSentinelOutcome(startedAt);
  }

  preflightReservations.set(sessionId, approvalId);
  try {
    return await runReservedInTerminal({
      sessionId,
      approvalId,
      command,
      opts,
      timeoutMs,
      idleWaitMs,
      tailLimit,
      privateOutput,
      startedAt,
      remoteAtStart,
      authorizedRemoteProbe,
    });
  } finally {
    if (preflightReservations.get(sessionId) === approvalId) {
      preflightReservations.delete(sessionId);
    }
  }
}

interface ReservedRun {
  sessionId: string;
  approvalId: string;
  command: string;
  opts: RunOptions;
  timeoutMs: number;
  idleWaitMs: number;
  tailLimit: number;
  privateOutput: boolean;
  startedAt: number;
  remoteAtStart: RemoteContext | null;
  authorizedRemoteProbe: boolean;
}

async function runReservedInTerminal({
  sessionId,
  approvalId,
  command,
  opts,
  timeoutMs,
  idleWaitMs,
  tailLimit,
  privateOutput,
  startedAt,
  remoteAtStart,
  authorizedRemoteProbe,
}: ReservedRun): Promise<PtyExecOutcome> {
  let dispatchAuthorized = false;
  const commandDeadlineAt = startedAt + timeoutMs;
  const remainingCommandMs = (maximum = Number.POSITIVE_INFINITY): number =>
    Math.max(0, Math.min(maximum, commandDeadlineAt - Date.now()));

  const approvedPrompt = consumeApprovalPromptBinding(opts.approvalPromptBinding, sessionId);
  if (opts.approvalPromptBinding && (!approvedPrompt || !promptMatchesApproval(approvedPrompt))) {
    return {
      exitCode: null,
      output: "",
      outputTruncated: false,
      outputObservedBytes: 0,
      outputCapturedBytes: 0,
      durationMs: Date.now() - startedAt,
      mode: null,
      error: "target_changed",
      note: "Nothing was executed: the terminal changed after the operator attested the visible shell prompt.",
    };
  }

  const acquireDispatchAuthorization = async (): Promise<boolean> => {
    if (!opts.beforeWrite) return false;
    const remaining = remainingCommandMs();
    if (remaining <= 0) return false;
    try {
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (authorized: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(authorized);
        };
        timer = setTimeout(() => finish(false), remaining);
        Promise.resolve(opts.beforeWrite!()).then(
          (authorized) => finish(authorized),
          () => finish(false),
        );
      });
    } catch {
      return false;
    }
  };
  const authorizationUnavailable = (mode: ExecMode | null): PtyExecOutcome => ({
    exitCode: null,
    output: "",
    outputTruncated: false,
    outputObservedBytes: 0,
    outputCapturedBytes: 0,
    durationMs: Date.now() - startedAt,
    mode,
    error: "target_changed",
    note: "Nothing was executed: final backend dispatch authorization was unavailable.",
  });

  // A remote Runbook probe is itself a PTY write. Claim the one-shot backend
  // dispatch lease first, then recheck the operator-bound epoch before emitting
  // even this harmless capability challenge.
  if (authorizedRemoteProbe) {
    dispatchAuthorized = await acquireDispatchAuthorization();
    if (!dispatchAuthorized) return authorizationUnavailable(null);
    if (!remoteIdentityMatches(sessionId, remoteAtStart)) {
      return {
        exitCode: null,
        output: "",
        outputTruncated: false,
        outputObservedBytes: 0,
        outputCapturedBytes: 0,
        durationMs: Date.now() - startedAt,
        mode: null,
        error: "target_changed",
        note: "Nothing was executed: the remote target changed before the authorized shell probe.",
      };
    }
    if (approvedPrompt && !promptMatchesApproval(approvedPrompt)) {
      return {
        exitCode: null,
        output: "",
        outputTruncated: false,
        outputObservedBytes: 0,
        outputCapturedBytes: 0,
        durationMs: Date.now() - startedAt,
        mode: null,
        error: "target_changed",
        note: "Nothing was executed: the terminal changed before the authorized shell probe.",
      };
    }
  }

  // 1. Wait for the terminal to be safe to type into (never inject blind).
  // Local Runbooks can use the integrated prompt gate directly. Remote
  // Runbooks took their lease above and now perform the same fresh probe as any
  // other remote command.
  const resolvedMode = opts.nonceCompletion && !authorizedRemoteProbe
    ? await resolveSentinelPrompt(sessionId, idleWaitMs, remoteAtStart, commandDeadlineAt)
    : await resolveMode(sessionId, idleWaitMs, remoteAtStart, commandDeadlineAt);
  if (resolvedMode === "closed") return closedOutcome(startedAt, null);
  if (resolvedMode === "busy") {
    return busyOutcome(startedAt, null, "a program is in the foreground or the user is typing");
  }
  if (resolvedMode === "not_a_shell") {
    return {
      exitCode: null,
      output: "",
      durationMs: Date.now() - startedAt,
      mode: null,
      error: "not_a_shell",
      note: "Nothing was executed: the visible terminal is not sitting at a shell prompt (a pager, editor, or another program has it). Ask the user to return to a prompt.",
    };
  }
  if (resolvedMode === "target_changed") {
    return {
      exitCode: null,
      output: "",
      durationMs: Date.now() - startedAt,
      mode: null,
      error: "target_changed",
      note: "Nothing was executed: the terminal moved between local and remote shell identities during command preflight.",
    };
  }
  // Shell OSC/block markers describe ordinary interactive commands well, but
  // command output itself can forge them. Runbooks opt into a fresh nonce on
  // every attempt to reject stale/replayed completion output. The active shell
  // remains operator-trusted and the result is labelled shell-observed, not a
  // deterministic executor attestation.
  const mode = resolvedMode.mode;
  const dialect = resolvedMode.dialect;
  const readyEntry = getTerm(sessionId);
  if (!readyEntry || readyEntry.disposed) return closedOutcome(startedAt, mode);
  const readyBuffer = readyEntry.term.buffer.active;
  const promptSnapshot = {
    entry: readyEntry,
    bufferType: readyBuffer.type,
    row: readyBuffer.baseY + readyBuffer.cursorY,
    cursorX: readyBuffer.cursorX,
    lastDataAt: readyEntry.lastDataAt,
    lastUserInputAt: readyEntry.lastUserInputAt,
  };

  // 2. Build the exact line to type. Hardening comes first and the sentinel
  // last: `$?` in the sentinel must be the command's status, so nothing may be
  // appended after it.
  const nonce = makeNonce();
  if (mode === "sentinel" && !canSentinel(command)) {
    return unsafeSentinelOutcome(startedAt);
  }
  const hardened = opts.harden === false
    ? { line: command, applied: [] as HardenedCommand["applied"] }
    : hardenCommand(command);
  let typed: string;
  try {
    typed = prefixCommandEnvironment(hardened.line, opts.environment ?? {});
  } catch (error) {
    return {
      exitCode: null,
      output: "",
      durationMs: Date.now() - startedAt,
      mode,
      error: "unsafe_command",
      note: `Nothing was executed: ${String(error)}`,
    };
  }
  if (privateOutput) typed = suppressPrivateOutput(typed, dialect);
  const line = mode === "sentinel" ? typed + sentinelSuffix(dialect, nonce) : typed;
  if (line.length > 4_096) {
    return {
      exitCode: null,
      output: "",
      durationMs: Date.now() - startedAt,
      mode,
      error: "unsafe_command",
      note: "Nothing was executed: the guarded command and completion instrumentation exceed 4,096 characters.",
    };
  }
  if (opts.beforeWrite && !dispatchAuthorized) {
    dispatchAuthorized = await acquireDispatchAuthorization();
    if (!dispatchAuthorized) return authorizationUnavailable(mode);
  }

  // Preflight is part of the frontend command budget. Never dispatch at or
  // after its deadline, even if the final authorization arrived on the same
  // event-loop turn.
  if (remainingCommandMs() <= 0) {
    return busyOutcome(startedAt, mode, "the command deadline expired during terminal preflight");
  }

  // The backend claim above is asynchronous. Re-prove the exact prompt that
  // resolveMode accepted before yielding: a user keystroke, PTY output, cursor
  // move, buffer switch, terminal replacement, or lost prompt means the claim
  // is settled as unknown without typing into the new foreground program.
  const dispatchEntry = getTerm(sessionId);
  const dispatchBuffer = dispatchEntry?.term.buffer.active;
  const approvedEpochStillBound = !approvedPrompt || (
    authorizedRemoteProbe
      ? dispatchEntry === approvedPrompt.entry
        && !dispatchEntry?.disposed
        && dispatchBuffer?.type === approvedPrompt.bufferType
        && dispatchBuffer.type === "normal"
        && dispatchEntry.lastUserInputAt === approvedPrompt.lastUserInputAt
      : promptMatchesApproval(approvedPrompt)
  );
  const promptStillBound =
    remoteIdentityMatches(sessionId, remoteAtStart) &&
    approvedEpochStillBound &&
    dispatchEntry === promptSnapshot.entry &&
    !dispatchEntry?.disposed &&
    dispatchBuffer?.type === promptSnapshot.bufferType &&
    dispatchBuffer.type === "normal" &&
    dispatchBuffer.baseY + dispatchBuffer.cursorY === promptSnapshot.row &&
    dispatchBuffer.cursorX === promptSnapshot.cursorX &&
    dispatchEntry.lastDataAt === promptSnapshot.lastDataAt &&
    dispatchEntry.lastUserInputAt === promptSnapshot.lastUserInputAt &&
    (mode !== "integrated" ||
      dispatchEntry.tracker.isAtEmptyPrompt() ||
      dispatchEntry.tracker.isAtPromptColumn());
  if (!promptStillBound) {
    return {
      exitCode: null,
      output: "",
      outputTruncated: false,
      outputObservedBytes: 0,
      outputCapturedBytes: 0,
      durationMs: Date.now() - startedAt,
      mode,
      error: "target_changed",
      note: "Nothing was executed: the visible shell prompt changed while final dispatch authorization was being acquired.",
    };
  }

  return await new Promise<PtyExecOutcome>((resolve) => {
    const entry = getTerm(sessionId);
    if (!entry || entry.disposed) {
      resolve(closedOutcome(startedAt, mode));
      return;
    }
    const buf = entry.term.buffer.active;
    const job: Job = {
      approvalId,
      command,
      typed,
      mode,
      nonce,
      startedAt,
      startLine: buf.baseY + buf.cursorY,
      startMarker: null,
      startMarkerListener: null,
      boundBlockId: null,
      foreignBlocks: 0,
      outputLost: false,
      injected: false,
      settled: false,
      stall: null,
      pausedMs: 0,
      lastTickAt: startedAt,
      interruptedBy: null,
      userInterruptPending: false,
      interruptGracePending: false,
      ladderRunning: false,
      finish: () => {},
      interrupt: () => false,
    };

    const timers: ReturnType<typeof setTimeout>[] = [];
    let refresh: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let userInterruptWriteConfirmed = false;
    let userInterruptDeliveryTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingUserInterruptCompletion: PtyExecOutcome | null = null;
    /** Whether this job's own nonce-bound RD came back. Anything else — a
     *  timeout, an interrupt, a closed terminal, a line that never reached a
     *  shell — leaves a terminal nothing here can vouch for, so the next remote
     *  command re-probes rather than inheriting this one's proof. */
    let completionProved = false;
    job.finish = (outcome) => {
      if (job.settled) return;
      job.settled = true;
      if (remoteAtStart && mode === "sentinel" && !completionProved) {
        forgetShellProof(sessionId);
      }
      if (opts.nonceCompletion) {
        getTerm(sessionId)?.tracker.endRunbookOutputIsolation();
      }
      job.startMarkerListener?.dispose();
      job.startMarkerListener = null;
      job.startMarker?.dispose();
      job.startMarker = null;
      for (const t of timers) clearTimeout(t);
      if (refresh) clearInterval(refresh);
      unsubscribe();
      jobs.delete(sessionId);
      resolve(
        privateOutput
          ? {
              ...outcome,
              output: "",
              outputTruncated: false,
              outputObservedBytes: 0,
              outputCapturedBytes: 0,
              note: outcome.note
                ? `${PRIVATE_OUTPUT_NOTICE} ${outcome.note}`
                : PRIVATE_OUTPUT_NOTICE,
            }
          : outcome,
      );
    };
    jobs.set(sessionId, job);

    // Non-integrated modes anchor on the row we typed into, so skip it: it
    // holds the prompt plus the echoed command, not output.
    const captureStartLine = (): number =>
      job.startMarker && !job.startMarker.isDisposed ? job.startMarker.line : job.startLine;

    const harvest = (
      toInclusive: number,
      limit: number,
      from = captureStartLine() + 1,
    ): ReadRangeResult => {
      if (privateOutput) {
        return {
          text: "",
          truncated: false,
          observedBytes: 0,
          capturedBytes: 0,
        };
      }
      const captured = readLineRangeResult(sessionId, from, toInclusive, { limit });
      const text = captured.text.trimEnd();
      const capturedBytes = new TextEncoder().encode(text).length;
      return {
        ...captured,
        text,
        capturedBytes,
        truncated:
          captured.truncated || job.outputLost || capturedBytes < captured.capturedBytes,
      };
    };

    const cursorRow = (): number => {
      const e = getTerm(sessionId);
      if (!e || e.disposed) return job.startLine;
      const b = e.term.buffer.active;
      return b.baseY + b.cursorY;
    };

    const onAltScreen = (): boolean =>
      getTerm(sessionId)?.term.buffer.active.type === "alternate";

    /**
     * Why a still-running command looks stuck — or null if it looks fine.
     *
     * Deliberately ordered: a hijacked screen outranks everything, and a
     * password prompt outranks idleness because the fix is the user's keyboard,
     * not an interrupt. `idle` is the weakest and is informational only.
     */
    const classifyStall = (): CommandStall | null => {
      // `ladderRunning` keeps this pinned while we are still typing quit keys,
      // but NOT after that, so a shell we handed back reclassifies honestly.
      if (onAltScreen() || job.ladderRunning) return "tui";
      const e = getTerm(sessionId);
      if (!e || e.disposed) return null;
      const b = e.term.buffer.active;
      const row = b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? "";
      if (PASSWORD_ROW.test(row)) return "password";
      if (Date.now() - e.lastDataAt < STALL_IDLE_MS) return null;
      return CONFIRM_ROW.test(row) ? "input" : "idle";
    };

    const settleInterruptFailed = () => {
      if (job.settled) return;
      const captured = harvest(cursorRow(), tailLimit);
      job.finish({
        exitCode: null,
        output: captured.text,
        outputTruncated: captured.truncated,
        outputObservedBytes: captured.observedBytes,
        outputCapturedBytes: captured.capturedBytes,
        durationMs: Date.now() - job.startedAt,
        mode,
        error: "interrupt_failed",
        note: "VTerminal could not confirm that SIGINT was written to the terminal. The command may still control it. Do not re-run it. Ask the user to verify the terminal state.",
      });
    };

    const armUserInterruptDeliveryDeadline = () => {
      userInterruptDeliveryTimer = setTimeout(() => {
        userInterruptDeliveryTimer = null;
        if (!userInterruptWriteConfirmed) settleInterruptFailed();
      }, USER_INTERRUPT_DELIVERY_TIMEOUT_MS);
      timers.push(userInterruptDeliveryTimer);
    };

    const settleInterruptedUnknown = () => {
      if (job.settled) return;
      const captured = harvest(cursorRow(), tailLimit);
      const interruptAction = job.interruptedBy === "user"
        ? "The user requested an interrupt, and VTerminal sent SIGINT"
        : "VTerminal sent interrupt input to the full-screen program";
      job.finish({
        exitCode: null,
        output: captured.text,
        outputTruncated: captured.truncated,
        outputObservedBytes: captured.observedBytes,
        outputCapturedBytes: captured.capturedBytes,
        durationMs: Date.now() - job.startedAt,
        mode,
        error: "interrupted",
        note: `${interruptAction}, but no completion signal arrived within one second. The command may have stopped, or terminal integration may have been lost while it was finishing. Its exit code is unknown. Do not re-run it unchanged. Ask the user to verify the prompt and command state.`,
      });
    };

    const armInterruptedGrace = () => {
      if (job.settled || job.interruptGracePending) return;
      job.interruptGracePending = true;
      timers.push(setTimeout(settleInterruptedUnknown, USER_INTERRUPT_GRACE_MS));
    };

    job.interrupt = (trigger) => {
      if (job.settled) return false;

      if (trigger === "user") {
        // The approval id is checked by interruptJob. Repeated gestures for the
        // same command are acknowledged without sending repeated control bytes.
        if (job.userInterruptPending || job.ladderRunning || job.interruptGracePending) return true;
        job.userInterruptPending = true;
        job.interruptedBy = "user";
        let write: Promise<void>;
        try {
          write = api.ptyWrite(sessionId, "\x03");
        } catch {
          settleInterruptFailed();
          return true;
        }
        // Delivery and command completion use separate bounded phases. A shell
        // can report completion before the Tauri invoke acknowledgement reaches
        // this webview, so that result is buffered until the write is confirmed.
        armUserInterruptDeliveryDeadline();
        void write.then(
          () => {
            if (job.settled) return;
            userInterruptWriteConfirmed = true;
            if (userInterruptDeliveryTimer) {
              clearTimeout(userInterruptDeliveryTimer);
              userInterruptDeliveryTimer = null;
            }
            if (pendingUserInterruptCompletion) {
              const completion = pendingUserInterruptCompletion;
              pendingUserInterruptCompletion = null;
              job.finish(completion);
              return;
            }
            armInterruptedGrace();
          },
          () => settleInterruptFailed(),
        );
        return true;
      }

      if (job.ladderRunning || job.userInterruptPending || job.interruptGracePending) return false;
      job.ladderRunning = true;
      job.interruptedBy = "tui";
      void (async () => {
        for (const keys of LADDER) {
          if (job.settled) return;
          await api.ptyWrite(sessionId, keys).catch(() => {});
          // Deliberately NOT registered in `timers`: clearing it on finish would
          // leave this loop awaiting a promise that can never resolve.
          await new Promise((r) => setTimeout(r, LADDER_STEP_MS));
          // Back in the normal buffer: give the shell one bounded chance to
          // report ordinary completion. Never leave the card waiting forever if
          // terminal integration disappeared during the interrupt.
          if (job.settled || !onAltScreen()) {
            job.ladderRunning = false;
            if (!job.settled) armInterruptedGrace();
            return;
          }
        }
        job.finish({
          exitCode: null,
          // No output: the alternate screen holds the TUI's own rendering, and a
          // screenful of vim's `~` column would only mislead the model.
          output: "",
          durationMs: Date.now() - job.startedAt,
          mode,
          error: "interrupt_failed",
          note: "This command opened a full-screen program (an editor, pager, or TUI), and VTerminal could not close it. SIGINT, `q`, and `:q!` were all refused. It may still hold the user's terminal. Propose NOTHING further: tell the user to close it themselves, then stop.",
        });
      })();
      return true;
    };

    /** Prepended to a completion observed after VTerminal sent an interrupt. */
    const interruptNote = (): string | undefined => {
      if (job.interruptedBy === "tui") {
        return "VTerminal interrupted this command after it opened a full-screen program (editor, pager, or TUI), and the shell then reported completion. Treat the command as interrupted and do not assume it did its work. Re-run it only in a non-interactive form (add --no-pager, pipe through `| cat`, or use the tool's --non-interactive flag).";
      }
      if (job.interruptedBy === "user") {
        return "The user requested an interrupt, and the shell confirmed command completion after SIGINT. Do not re-run it unchanged. It was taking too long or waiting for input.";
      }
      return undefined;
    };

    const completionError = (): ExecError | undefined =>
      job.interruptedBy ? "interrupted" : undefined;

    const settleAuthoritativeCompletion = (outcome: PtyExecOutcome) => {
      if (
        job.interruptedBy === "user" &&
        job.userInterruptPending &&
        !userInterruptWriteConfirmed
      ) {
        pendingUserInterruptCompletion ??= outcome;
        return;
      }
      job.finish(outcome);
    };

    const completeWithBlock = (blockId: string, exitCode: number) => {
      const markers = getTerm(sessionId)?.blockMarkers.get(blockId);
      // The block's own markers are authoritative: xterm registered the start
      // at OSC 133;C (the first output row) and they track scrollback trimming.
      // The end marker sits on the NEXT prompt's row, so it is exclusive.
      const from =
        markers && !markers.start.isDisposed ? markers.start.line : job.startLine + 1;
      const end = markers?.end && !markers.end.isDisposed ? markers.end.line - 1 : cursorRow();
      const captured = harvest(end, tailLimit, from);
      settleAuthoritativeCompletion({
        exitCode,
        output: captured.text,
        outputTruncated: captured.truncated,
        outputObservedBytes: captured.observedBytes,
        outputCapturedBytes: captured.capturedBytes,
        durationMs: Date.now() - job.startedAt,
        mode,
        error: completionError(),
        note: interruptNote(),
      });
    };

    unsubscribe = subscribeTerm(sessionId, (e: TermEvent) => {
      if (job.settled || !job.injected) return;
      switch (e.type) {
        case "disposed":
          job.finish(closedOutcome(job.startedAt, mode));
          break;
        case "blockStart":
          if (mode !== "integrated" || job.boundBlockId) break;
          // Bind on TEXT MATCH, not on "the next block": the user may have hit
          // Enter at the same moment, and OSC 6973 gives us the exact command
          // they ran, so the two are always distinguishable. Match `typed`, not
          // `command` — see the field's comment.
          if (e.command.trim() === job.typed.trim()) {
            job.boundBlockId = e.blockId;
            useAppStore.getState().markBlockOrigin(sessionId, e.blockId, "agent");
          } else if (++job.foreignBlocks >= 2) {
            job.finish(notObservedOutcome(job.startedAt, mode));
          }
          break;
        case "blockEnd":
          if (mode === "integrated" && e.blockId === job.boundBlockId) {
            completeWithBlock(e.blockId, e.exitCode);
          }
          break;
        case "blockTrimmed":
          // Keep waiting for the exit code — it is the part that matters — but
          // the output is gone from scrollback.
          if (e.blockId === job.boundBlockId) {
            job.startLine = -1;
            job.outputLost = true;
          }
          break;
        case "osc": {
          if (mode === "integrated") break;
          const token = parsePrivateToken(e.payload);
          if (!token || token.t !== "RD") break;
          // In sentinel mode the nonce makes attribution exact, so a late token
          // from an abandoned command can never be misread as this one's.
          if (mode === "sentinel" && token.arg !== job.nonce) break;
          // Our own text ran to completion in the foreground shell and printed
          // this token: the epoch the probe attested is still the live one.
          completionProved = true;
          if (remoteAtStart) renewShellProof(sessionId);
          const captured = harvest(cursorRow(), tailLimit);
          settleAuthoritativeCompletion({
            exitCode: token.exit,
            output: captured.text,
            outputTruncated: captured.truncated,
            outputObservedBytes: captured.observedBytes,
            outputCapturedBytes: captured.capturedBytes,
            durationMs: Date.now() - job.startedAt,
            mode,
            error: completionError(),
            note: interruptNote(),
          });
          break;
        }
        case "bufferChange":
          // The ONE signal acted on without asking. The pre-flight gate proved
          // this session was at a shell prompt before we typed, and the job is
          // still open, so whatever seized the screen came from our own line.
          if (e.buffer === "alternate") {
            job.stall = "tui";
            useAppStore.getState().setCommandStall(sessionId, approvalId, "tui");
            job.interrupt("tui");
          }
          break;
      }
    });

    // 3. Type it. Exactly once, ever.
    if (opts.canWrite && !opts.canWrite()) {
      job.finish({
        exitCode: null,
        output: "",
        outputTruncated: false,
        outputObservedBytes: 0,
        outputCapturedBytes: 0,
        durationMs: Date.now() - job.startedAt,
        mode,
        error: "target_changed",
        note: "Nothing was executed: the runbook target stopped being the active visible terminal before dispatch.",
      });
      return;
    }
    // Sentinel jobs do not receive an authoritative OSC block marker.
    // Anchor their prompt row directly in xterm so ordinary line shifts remain
    // accurate and disposal tells us when low scrollback dropped early output.
    if (mode !== "integrated") {
      const marker = entry.term.registerMarker(0) ?? null;
      if (marker) {
        job.startMarker = marker;
        job.startLine = marker.line;
        job.startMarkerListener = marker.onDispose(() => {
          if (job.settled) return;
          job.startLine = -1;
          job.outputLost = true;
        });
      } else {
        // Failing to obtain an anchor makes completeness unknowable; retain the
        // available tail but never describe it as complete evidence.
        job.startLine = -1;
        job.outputLost = true;
      }
    }
    job.injected = true;
    if (privateOutput) protectPrivateTerminal(sessionId);
    if (opts.nonceCompletion) entry.tracker.beginRunbookOutputIsolation();
    // Show what the guards changed: the user approved `systemctl status x`, and
    // the terminal is about to echo an env prefix and a redirect they never saw.
    // `hardened.line` rather than `line` — the exit-code sentinel is plumbing,
    // not a change to what the command does.
    if (hardened.applied.length || Object.keys(opts.environment ?? {}).length > 0) {
      useAppStore.getState().setCommandTyped(sessionId, approvalId, typed);
    }
    void api.ptyWrite(sessionId, `${line}\r`).catch(() => {
      job.finish(closedOutcome(job.startedAt, mode));
    });

    // A block that never appears means the line did not reach a shell prompt.
    if (mode === "integrated") {
      timers.push(
        setTimeout(() => {
          if (!job.boundBlockId && !job.interruptedBy) {
            job.finish(notObservedOutcome(job.startedAt, mode));
          }
        }, BLOCK_BIND_MS),
      );
    }

    // Keep the panel card alive during long commands by re-reading the live tail
    // (replace semantics — appending would duplicate on every tick), and
    // reclassify the stall on the same beat rather than adding a second timer.
    refresh = setInterval(() => {
      if (job.settled) {
        clearInterval(refresh);
        return;
      }
      const e = getTerm(sessionId);
      if (!e || e.disposed) return;
      const store = useAppStore.getState();
      if (!privateOutput) {
        store.setCommandOutput(sessionId, approvalId, harvest(cursorRow(), CARD_TAIL).text);
      }

      const now = Date.now();
      // Charge the interval just elapsed to the pause budget if it was spent
      // waiting for the user to type a password.
      if (job.stall === "password") job.pausedMs += now - job.lastTickAt;
      job.lastTickAt = now;

      const stall = classifyStall();
      if (stall === job.stall) return;
      // First sight of a password prompt: bring the tab forward so the user can
      // simply type. Only the agent's own session is ever focused, and only once.
      if (stall === "password" && job.stall !== "password") {
        store.setActiveSession(sessionId);
        getTerm(sessionId)?.term.focus();
      }
      job.stall = stall;
      store.setCommandStall(sessionId, approvalId, stall);
    }, CARD_REFRESH_MS);

    const settleTimeout = () => {
      if (job.settled) return;
      const captured = harvest(cursorRow(), tailLimit);
      job.finish({
        exitCode: null,
        output: captured.text,
        outputTruncated: captured.truncated,
        outputObservedBytes: captured.observedBytes,
        outputCapturedBytes: captured.capturedBytes,
        durationMs: Date.now() - job.startedAt,
        mode,
        error: "timeout",
        note: `No completion signal arrived within ${Math.round(
          timeoutMs / 1000,
        )}s. The command may still be running, or it may have finished after terminal integration was lost. Its exit code is unknown. VTerminal did not interrupt it. Do not re-run it or assume it succeeded or failed. Ask the user to verify the terminal state.`,
      });
    };

    // Re-armed rather than fixed, so a password prompt does not immediately
    // burn the logical command budget. The initial delay is the budget left
    // after preflight, not a fresh timeout beginning after dispatch.
    const armDeadline = (ms: number) => {
      timers.push(
        setTimeout(() => {
          if (job.settled) return;
          // Once an interrupt is in flight, its bounded grace or escalation
          // owns the outcome. A nearly-expired command deadline must not race it
          // into a misleading timeout result.
          if (job.interruptedBy) return;
          const left = timeoutMs - (Date.now() - job.startedAt - job.pausedMs);
          if (left > 0) {
            armDeadline(left);
            return;
          }
          settleTimeout();
        }, ms),
      );
    };
    armDeadline(remainingCommandMs());

    // Password pauses and a stalled IPC write cannot postpone the frontend
    // forever. Rust waits another 30 seconds, leaving at least 15 seconds for
    // this result to cross the IPC boundary after this absolute cap fires.
    timers.push(
      setTimeout(() => {
        if (job.settled) return;
        if (job.interruptedBy === "user") {
          if (userInterruptWriteConfirmed) settleInterruptedUnknown();
          else settleInterruptFailed();
          return;
        }
        if (job.interruptedBy === "tui") {
          const captured = harvest(cursorRow(), tailLimit);
          job.finish({
            exitCode: null,
            output: captured.text,
            outputTruncated: captured.truncated,
            outputObservedBytes: captured.observedBytes,
            outputCapturedBytes: captured.capturedBytes,
            durationMs: Date.now() - job.startedAt,
            mode,
            error: "interrupt_failed",
            note: "VTerminal could not settle its full-screen interrupt before the frontend reporting deadline. The program may still control the terminal. Ask the user to verify the terminal state.",
          });
          return;
        }
        settleTimeout();
      }, Math.max(0, commandDeadlineAt + FRONTEND_WATCHDOG_GRACE_MS - Date.now())),
    );
  });
}

// ---------------------------------------------------------------------------

type ModeResolution =
  | ResolvedExecMode
  | "busy"
  | "closed"
  | "not_a_shell"
  | "target_changed";

function sameRemoteIdentity(
  left: RemoteContext | null,
  right: RemoteContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.target === right.target &&
    (left.host_id ?? null) === (right.host_id ?? null)
  );
}

function remoteIdentityMatches(
  sessionId: string,
  expected: RemoteContext | null,
): boolean {
  const current = useAppStore.getState().sessionUi[sessionId]?.remote ?? null;
  return sameRemoteIdentity(current, expected);
}

/**
 * A remote shell capability proof, and the epoch it describes.
 *
 * The probe is not free: it is a whole extra command line in the user's
 * terminal, echoed by the remote shell like anything else typed there. Paying
 * it per command meant three agent steps over ssh printed three
 * `printf '\033]6973;RP;…'` lines nobody asked for, interleaved with the
 * commands the user actually approved.
 *
 * What it buys is a fact about the TERMINAL, not about the command: a
 * POSIX-ish shell rather than a pager, an editor or a REPL is reading this
 * input, and this is its dialect. So it survives exactly as long as that epoch
 * demonstrably does.
 */
interface ShellProof {
  /** The TermEntry object itself: a replaced terminal is a different epoch. */
  entry: NonNullable<ReturnType<typeof getTerm>>;
  remote: RemoteContext | null;
  dialect: ShellDialect;
  /**
   * `lastUserInputAt` AT PROBE TIME, never advanced by a renewal. The user's
   * keystrokes may still be sitting unread in the shell's input queue, so a
   * `python3\r` typed while our command was running becomes the foreground
   * program a moment later — the exact case the probe exists to catch.
   */
  lastUserInputAt: number;
  /** Last moment a nonce-bound token proved this shell alive. The TTL clock. */
  provenAt: number;
}

const shellProofs = new Map<string, ShellProof>();

/**
 * The one failure a proof cannot observe: an ssh link that dies SILENTLY
 * between two commands. A link that announces itself is already covered —
 * the local shell prints its prompt, the nested block ends, and
 * `forgetShellProof` fires from `useSessions`. Re-probing after a quiet
 * stretch costs one line the user will not see twice in a run.
 */
const PROOF_TTL_MS = 5 * 60_000;

/**
 * The live proof for this session, or null when one must be taken.
 *
 * Every miss deletes the stale entry rather than leaving it to be re-checked:
 * once any of these has failed, the recorded epoch is gone for good.
 */
function reusableShellProof(
  sessionId: string,
  expectedRemote: RemoteContext | null,
): ShellProof | null {
  const proof = shellProofs.get(sessionId);
  if (!proof) return null;
  const entry = getTerm(sessionId);
  const usable =
    !!entry &&
    !entry.disposed &&
    entry === proof.entry &&
    sameRemoteIdentity(proof.remote, expectedRemote) &&
    entry.lastUserInputAt === proof.lastUserInputAt &&
    Date.now() - proof.provenAt <= PROOF_TTL_MS;
  if (!usable) {
    shellProofs.delete(sessionId);
    return null;
  }
  return proof;
}

function rememberShellProof(
  sessionId: string,
  remote: RemoteContext | null,
  dialect: ShellDialect,
): void {
  const entry = getTerm(sessionId);
  if (!entry || entry.disposed) return;
  shellProofs.set(sessionId, {
    entry,
    remote,
    dialect,
    lastUserInputAt: entry.lastUserInputAt,
    provenAt: Date.now(),
  });
}

/** A command that reported its own nonce-bound RD is a stronger liveness
 *  signal than the probe was, so it restarts the TTL — but never the
 *  keyboard-quiet snapshot, which is what makes queued user input safe. */
function renewShellProof(sessionId: string): void {
  const proof = shellProofs.get(sessionId);
  if (proof) proof.provenAt = Date.now();
}

function configuredShellDialect(sessionId: string): ShellDialect {
  const shell = useAppStore.getState().sessions.find((session) => session.id === sessionId)?.shell;
  return shell?.split("/").pop() === "fish" ? "fish" : "posix";
}

async function resolveSentinelPrompt(
  sessionId: string,
  idleWaitMs: number,
  expectedRemote: RemoteContext | null,
  commandDeadlineAt: number,
): Promise<ModeResolution> {
  if (!remoteIdentityMatches(sessionId, expectedRemote)) return "target_changed";
  const ready = await waitForPrompt(
    sessionId,
    Math.max(0, Math.min(idleWaitMs, commandDeadlineAt - Date.now())),
    expectedRemote ? "nested" : "integrated",
  );
  if (ready !== "ok") return ready;
  return remoteIdentityMatches(sessionId, expectedRemote)
    ? { mode: "sentinel", dialect: configuredShellDialect(sessionId) }
    : "target_changed";
}

/** Wait for a safe prompt, then work out how this session reports exit codes. */
async function resolveMode(
  sessionId: string,
  idleWaitMs: number,
  expectedRemote: RemoteContext | null,
  commandDeadlineAt: number,
): Promise<ModeResolution> {
  if (!remoteIdentityMatches(sessionId, expectedRemote)) return "target_changed";

  if (!expectedRemote) {
    const ready = await waitForPrompt(
      sessionId,
      Math.max(0, Math.min(idleWaitMs, commandDeadlineAt - Date.now())),
      "integrated",
    );
    if (ready !== "ok") return ready;
    return remoteIdentityMatches(sessionId, expectedRemote)
      ? { mode: "integrated", dialect: configuredShellDialect(sessionId) }
      : "target_changed";
  }

  const ready = await waitForPrompt(
    sessionId,
    Math.max(0, Math.min(idleWaitMs, commandDeadlineAt - Date.now())),
    "nested",
  );
  if (ready !== "ok") return ready;
  // The probe is itself terminal input. Bind it to the same remote fingerprint
  // the command was approved against, with no async gap before `ptyWrite`.
  if (!remoteIdentityMatches(sessionId, expectedRemote)) return "target_changed";

  // Checked HERE rather than before the wait above: `waitForPrompt` can block
  // for `idleWaitMs`, and a keystroke during it must invalidate the proof.
  const proven = reusableShellProof(sessionId, expectedRemote);
  if (proven) return { mode: "sentinel", dialect: proven.dialect };

  // A fresh capability proves that this exact probe, rather than a cached or
  // delayed token, was executed by the current foreground shell. A missing
  // matching reply is the one case where typing the command would be harmful.
  const probeNonce = makeNonce();
  const probeWaitMs = Math.max(0, Math.min(PROBE_WAIT_MS, commandDeadlineAt - Date.now()));
  if (probeWaitMs <= 0) return "busy";
  const probe = await sendAndAwait(
    sessionId,
    probeFor(probeNonce),
    probeWaitMs,
    (token) => token.t === "RP" && token.nonce === probeNonce ? token : null,
  );
  if (!probe) return "not_a_shell";
  if (!remoteIdentityMatches(sessionId, expectedRemote)) return "target_changed";
  // RP is printed before the interactive shell redraws its prompt. Bind the
  // eventual command only after that prompt is visible and quiet, otherwise the
  // snapshot below can accidentally describe the probe's output row.
  const promptReady = await waitForPrompt(
    sessionId,
    Math.max(0, Math.min(idleWaitMs, commandDeadlineAt - Date.now())),
    "nested",
  );
  if (promptReady !== "ok") return promptReady;
  if (!remoteIdentityMatches(sessionId, expectedRemote)) return "target_changed";
  const dialect = dialectFromProbe(probe);
  // Recorded only now, so the keyboard-quiet snapshot is taken as late as
  // possible: anything the user typed while the prompt redrew is already in it.
  rememberShellProof(sessionId, expectedRemote, dialect);
  return { mode: "sentinel", dialect };
}

/** Write a setup line and wait for its private token. */
function sendAndAwait<T>(
  sessionId: string,
  line: string,
  timeoutMs: number,
  match: (t: PrivateToken) => T | null,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (value: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = subscribeTerm(sessionId, (e) => {
      if (e.type === "disposed") return settle(null);
      if (e.type !== "osc") return;
      const token = parsePrivateToken(e.payload);
      if (!token) return;
      const hit = match(token);
      if (hit) settle(hit);
    });
    const timer = setTimeout(() => settle(null), timeoutMs);
    void api.ptyWrite(sessionId, `${line}\r`).catch(() => settle(null));
  });
}

/**
 * Block until the terminal is safe to type into.
 *
 * Both modes first require the NORMAL buffer: if vim/less/top holds the
 * alternate screen, a typed line goes into that program, not a shell.
 */
function waitForPrompt(
  sessionId: string,
  timeoutMs: number,
  kind: "integrated" | "nested",
): Promise<"ok" | "busy" | "closed"> {
  const deadline = Date.now() + timeoutMs;
  const graceUntil = Date.now() + 1_500;
  return new Promise((resolve) => {
    const tick = () => {
      const entry = getTerm(sessionId);
      const session = useAppStore.getState().sessions.find((s) => s.id === sessionId);
      if (!entry || entry.disposed || session?.exited) return resolve("closed");
      if (entry.term.buffer.active.type === "normal") {
        if (kind === "integrated") {
          // isAtEmptyPrompt also demands "pristine", which xterm's automatic
          // DSR/DA replies can clear spuriously; after a grace period accept the
          // weaker cursor-at-input-column test instead of stalling forever.
          const ok =
            entry.tracker.isAtEmptyPrompt() ||
            (Date.now() > graceUntil && entry.tracker.isAtPromptColumn());
          if (ok) return resolve("ok");
        } else {
          const now = Date.now();
          const buf = entry.term.buffer.active;
          const row = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
          if (
            now - entry.lastDataAt >= QUIESCENCE_MS &&
            now - entry.lastUserInputAt >= QUIESCENCE_MS &&
            buf.cursorX > 0 &&
            row.trim().length > 0
          ) {
            return resolve("ok");
          }
        }
      }
      if (Date.now() >= deadline) return resolve("busy");
      setTimeout(tick, IDLE_POLL_MS);
    };
    tick();
  });
}

function liveEntry(sessionId: string): boolean {
  const entry = getTerm(sessionId);
  return !!entry && !entry.disposed;
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unsafeSentinelOutcome(startedAt: number): PtyExecOutcome {
  return {
    exitCode: null,
    output: "",
    durationMs: Date.now() - startedAt,
    mode: "sentinel",
    error: "unsafe_command",
    note: "Nothing was executed: this shell needs an exit-code sentinel appended, which is unsafe for commands using heredocs, unquoted comments, background jobs, trailing operators, line continuations, or unfinished shell syntax. Rewrite it as a single self-contained command.",
  };
}

function busyOutcome(startedAt: number, mode: ExecMode | null, why: string): PtyExecOutcome {
  return {
    exitCode: null,
    output: "",
    durationMs: Date.now() - startedAt,
    mode,
    error: "terminal_busy",
    note: `Nothing was executed: ${why}. No state changed. Wait and propose a harmless check, or finish and tell the user.`,
  };
}

function closedOutcome(startedAt: number, mode: ExecMode | null): PtyExecOutcome {
  return {
    exitCode: null,
    output: "",
    durationMs: Date.now() - startedAt,
    mode,
    error: "terminal_closed",
    note: "Nothing was executed: the terminal was closed or its shell exited.",
  };
}

function notObservedOutcome(startedAt: number, mode: ExecMode | null): PtyExecOutcome {
  return {
    exitCode: null,
    output: "",
    durationMs: Date.now() - startedAt,
    mode,
    error: "command_not_observed",
    note: "The command was typed into the terminal but the shell never reported starting it, so its result is unknown. Do not assume it ran.",
  };
}
