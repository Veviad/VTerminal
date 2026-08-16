import * as api from "./tauri";
import type { IDisposable, IMarker } from "@xterm/xterm";
import { getTerm, subscribeTerm, type TermEvent } from "./termRegistry";
import { readLineRangeResult, type ReadRangeResult } from "./terminalSnapshot";
import { useAppStore } from "../stores/appStore";
import type { CommandStall } from "./types";
import {
  PROBE,
  canSentinel,
  hardenCommand,
  installerFor,
  parsePrivateToken,
  prefixCommandEnvironment,
  sanitizeCommand,
  sentinelSuffix,
  shellFromProbe,
  type HardenedCommand,
  type ExecMode,
  type PrivateToken,
} from "./ptyExecShell";

// Running an approved agent command in the user's LIVE terminal.
//
// The backend cannot do this itself: it never inspects PTY bytes (all OSC
// parsing is frontend-side, because xterm reassembles sequences split across
// chunk boundaries). So Rust asks, via StreamEvent::RunInTerminal, and we type
// the command, watch for it to finish, and report back.
//
// Three completion modes, picked per session:
//   integrated — the local shell runs our zsh hooks: bind to the real Block and
//                take its exit code from OSC 133;D.
//   hook       — a remote shell we taught (in memory only) to emit a private
//                OSC 6973;RD token from its prompt hook.
//   sentinel   — no usable prompt hook: append a `printf` carrying $? and a
//                per-command nonce.
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
//   * A wall-clock timeout NEVER kills anything. The command is still running in
//     front of the user; killing it is their call, not ours.
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
  /** Live anchor for hook/sentinel output. Its disposal proves scrollback loss. */
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
  ladderRunning: boolean;
  finish(outcome: PtyExecOutcome): void;
  /** Hand the terminal back to the shell. `tui` escalates; `user` sends only
   *  SIGINT (extra keys would land on the user's prompt as stray text). */
  interrupt(trigger: "tui" | "user"): void;
}

const jobs = new Map<string, Job>();
/** Resolved exec mode per session; cleared when a nested session exits. */
const sessionModes = new Map<string, ExecMode>();

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
const HANDSHAKE_WAIT_MS = 2_500;
const CARD_REFRESH_MS = 750;
const MODEL_TAIL = 8_192;
const CARD_TAIL = 4_096;

/** How long output must stop before a running command counts as stalled. */
const STALL_IDLE_MS = 30_000;
/** Pause between rungs of the interrupt ladder. */
const LADDER_STEP_MS = 400;

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
  return jobs.has(sessionId);
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
export function interruptJob(sessionId: string, expectedApprovalId?: string): boolean {
  const job = jobs.get(sessionId);
  if (!job || (expectedApprovalId !== undefined && job.approvalId !== expectedApprovalId)) {
    return false;
  }
  job.interrupt("user");
  return true;
}

/** Forget the negotiated mode — called when `ssh` exits and we are local again. */
export function resetSessionMode(sessionId: string): void {
  sessionModes.delete(sessionId);
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
  /** Atomic backend dispatch authorization acquired after all asynchronous probing. */
  beforeWrite?: () => boolean | Promise<boolean>;
  /** Final synchronous target/feature guard, checked immediately before write. */
  canWrite?: () => boolean;
  /** Require a fresh per-command completion token even when shell integration exists. */
  nonceCompletion?: boolean;
  /** One-shot terminal epoch captured by the operator's Runbook approval. */
  approvalPromptBinding?: string;
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
  const startedAt = Date.now();

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

  if (jobs.has(sessionId)) {
    return busyOutcome(startedAt, null, "another command is still being awaited in this terminal");
  }
  if (!liveEntry(sessionId)) {
    return closedOutcome(startedAt, null);
  }

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

  // 1. Wait for the terminal to be safe to type into (never inject blind).
  // Runbooks always use a fresh sentinel and therefore must not install an
  // unapproved probe/prompt hook before acquiring their dispatch lease.
  const resolvedMode = opts.nonceCompletion
    ? await resolveSentinelPrompt(sessionId, idleWaitMs)
    : await resolveMode(sessionId, idleWaitMs);
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
  // Shell OSC/block markers describe ordinary interactive commands well, but
  // command output itself can forge them. Runbooks opt into a fresh nonce on
  // every attempt to reject stale/replayed completion output. The active shell
  // remains operator-trusted and the result is labelled shell-observed, not a
  // deterministic executor attestation.
  const mode: ExecMode = opts.nonceCompletion ? "sentinel" : resolvedMode;
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
    return {
      exitCode: null,
      output: "",
      durationMs: Date.now() - startedAt,
      mode,
      error: "unsafe_command",
      note: "Nothing was executed: this shell needs an exit-code sentinel appended, which is unsafe for commands using heredocs, line continuations, or unbalanced quotes. Rewrite it as a single self-contained command.",
    };
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
  const line = mode === "sentinel" ? typed + sentinelSuffix("posix", nonce) : typed;
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
  if (opts.beforeWrite) {
    let authorized = false;
    try {
      authorized = await opts.beforeWrite();
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return {
        exitCode: null,
        output: "",
        outputTruncated: false,
        outputObservedBytes: 0,
        outputCapturedBytes: 0,
        durationMs: Date.now() - startedAt,
        mode,
        error: "cancelled",
        note: "Nothing was executed: final backend dispatch authorization was unavailable.",
      };
    }
  }

  // The backend claim above is asynchronous. Re-prove the exact prompt that
  // resolveMode accepted before yielding: a user keystroke, PTY output, cursor
  // move, buffer switch, terminal replacement, or lost prompt means the claim
  // is settled as unknown without typing into the new foreground program.
  const dispatchEntry = getTerm(sessionId);
  const dispatchBuffer = dispatchEntry?.term.buffer.active;
  const promptStillBound =
    (!approvedPrompt || promptMatchesApproval(approvedPrompt)) &&
    dispatchEntry === promptSnapshot.entry &&
    !dispatchEntry?.disposed &&
    dispatchBuffer?.type === promptSnapshot.bufferType &&
    dispatchBuffer.type === "normal" &&
    dispatchBuffer.baseY + dispatchBuffer.cursorY === promptSnapshot.row &&
    dispatchBuffer.cursorX === promptSnapshot.cursorX &&
    dispatchEntry.lastDataAt === promptSnapshot.lastDataAt &&
    dispatchEntry.lastUserInputAt === promptSnapshot.lastUserInputAt &&
    (resolvedMode !== "integrated" ||
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
      ladderRunning: false,
      finish: () => {},
      interrupt: () => {},
    };

    const timers: ReturnType<typeof setTimeout>[] = [];
    let refresh: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    job.finish = (outcome) => {
      if (job.settled) return;
      job.settled = true;
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
      resolve(outcome);
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
      // `ladderRunning` keeps this pinned while we are still typing quit keys —
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

    job.interrupt = (trigger) => {
      if (job.settled || job.ladderRunning) return;
      job.ladderRunning = true;
      job.interruptedBy = trigger;
      // Only a hijacked screen earns the escalation: in a normal buffer the
      // later rungs would land on the user's prompt as stray text.
      const rungs = trigger === "tui" ? LADDER : LADDER.slice(0, 1);
      void (async () => {
        for (const keys of rungs) {
          if (job.settled) return;
          await api.ptyWrite(sessionId, keys).catch(() => {});
          // Deliberately NOT registered in `timers`: clearing it on finish would
          // leave this loop awaiting a promise that can never resolve.
          await new Promise((r) => setTimeout(r, LADDER_STEP_MS));
          // Back in the normal buffer: the shell is reaching its prompt, and the
          // hook will settle this job with the real exit code (130 for SIGINT).
          if (job.settled || !onAltScreen()) {
            job.ladderRunning = false;
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
          note: "This command opened a full-screen program (an editor, pager, or TUI) and VTerminal could not close it — SIGINT, `q` and `:q!` were all refused. It still holds the user's terminal. Propose NOTHING further: tell the user to close it themselves, then stop.",
        });
      })();
    };

    /** Prepended to a normal completion so the model knows 130 means SIGINT. */
    const interruptNote = (): string | undefined => {
      if (job.interruptedBy === "tui") {
        return "VTerminal sent SIGINT to this command: it opened a full-screen program (editor, pager, or TUI), which the agent cannot exit. Exit code 130 means interrupted, not failed — the command did not do its work. Re-run it in a non-interactive form (add --no-pager, pipe through `| cat`, or use the tool's --non-interactive flag).";
      }
      if (job.interruptedBy === "user") {
        return "The user interrupted this command (SIGINT). Exit code 130 means interrupted, not failed. Do not re-run it unchanged — it was taking too long or waiting for input.";
      }
      return undefined;
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
      job.finish({
        exitCode,
        output: captured.text,
        outputTruncated: captured.truncated,
        outputObservedBytes: captured.observedBytes,
        outputCapturedBytes: captured.capturedBytes,
        durationMs: Date.now() - job.startedAt,
        mode,
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
          const captured = harvest(cursorRow(), tailLimit);
          job.finish({
            exitCode: token.exit,
            output: captured.text,
            outputTruncated: captured.truncated,
            outputObservedBytes: captured.observedBytes,
            outputCapturedBytes: captured.capturedBytes,
            durationMs: Date.now() - job.startedAt,
            mode,
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
    // Hook/sentinel jobs do not receive an authoritative OSC block marker.
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
          if (!job.boundBlockId) job.finish(notObservedOutcome(job.startedAt, mode));
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
      store.setCommandOutput(sessionId, approvalId, harvest(cursorRow(), CARD_TAIL).text);

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

    // Re-armed rather than fixed, so a password prompt cannot burn the budget:
    // time the USER owns is not time the command spent hanging.
    const armDeadline = (ms: number) => {
      timers.push(
        setTimeout(() => {
          if (job.settled) return;
          const left = timeoutMs - (Date.now() - job.startedAt - job.pausedMs);
          if (left > 0) {
            armDeadline(left);
            return;
          }
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
            note: `The command was typed into the user's live terminal and is STILL RUNNING after ${Math.round(
              timeoutMs / 1000,
            )}s. It was NOT killed and its exit code is unknown. Do not re-run it and do not assume it succeeded or failed.`,
          });
        }, ms),
      );
    };
    armDeadline(timeoutMs);
  });
}

// ---------------------------------------------------------------------------

type ModeResolution = ExecMode | "busy" | "closed" | "not_a_shell";

async function resolveSentinelPrompt(
  sessionId: string,
  idleWaitMs: number,
): Promise<ModeResolution> {
  const remote = useAppStore.getState().sessionUi[sessionId]?.remote ?? null;
  const ready = await waitForPrompt(sessionId, idleWaitMs, remote ? "nested" : "integrated");
  return ready === "ok" ? "sentinel" : ready;
}

/** Wait for a safe prompt, then work out how this session reports exit codes. */
async function resolveMode(sessionId: string, idleWaitMs: number): Promise<ModeResolution> {
  const remote = useAppStore.getState().sessionUi[sessionId]?.remote ?? null;

  if (!remote) {
    const ready = await waitForPrompt(sessionId, idleWaitMs, "integrated");
    if (ready !== "ok") return ready;
    return "integrated";
  }

  const cached = sessionModes.get(sessionId);
  const ready = await waitForPrompt(sessionId, idleWaitMs, "nested");
  if (ready !== "ok") return ready;
  if (cached) return cached;

  // Probe first. A missing reply means there is no shell reading this terminal,
  // which is the one case where typing a command would be actively harmful.
  const rs = await sendAndAwait(sessionId, PROBE, PROBE_WAIT_MS, (t) => (t.t === "RS" ? t : null));
  if (!rs) return "not_a_shell";
  if (rs.installed) {
    sessionModes.set(sessionId, "hook");
    return "hook";
  }

  const shell = shellFromProbe(rs);
  if (!shell) {
    sessionModes.set(sessionId, "sentinel");
    return "sentinel";
  }
  const nonce = makeNonce();
  const rh = await sendAndAwait(
    sessionId,
    installerFor(shell, nonce),
    HANDSHAKE_WAIT_MS,
    (t) => (t.t === "RH" && t.nonce === nonce ? t : null),
  );
  const mode: ExecMode = rh ? "hook" : "sentinel";
  sessionModes.set(sessionId, mode);
  return mode;
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
  return Math.random().toString(36).slice(2, 10);
}

function busyOutcome(startedAt: number, mode: ExecMode | null, why: string): PtyExecOutcome {
  return {
    exitCode: null,
    output: "",
    durationMs: Date.now() - startedAt,
    mode,
    error: "terminal_busy",
    note: `Nothing was executed — ${why}. No state changed. Wait and propose a harmless check, or finish and tell the user.`,
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
