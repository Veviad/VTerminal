import { useCallback } from "react";
import * as api from "../lib/tauri";
import { useAppStore, type CommandTargetMeta } from "../stores/appStore";
import { getTerm } from "../lib/termRegistry";
import { readLineRange, readScreenTail } from "../lib/terminalSnapshot";
import { abortSession, runInTerminal, type PtyExecOutcome } from "../lib/ptyExec";
import { nameSession } from "../lib/sessionNaming";
import {
  markTranscriptCheckpoint,
  markTranscriptDirty,
} from "../lib/sessionPersistence";
import { setAiPanelOpen } from "../lib/aiPanel";
import {
  DOC_INJECT_LIMIT,
  buildOutgoing,
  foldRetrievedPassages,
  ocrAvailable,
  persistAttachments,
  stripDocBlocks,
  transcribeImages,
} from "../lib/attachInput";
import { S } from "../lib/strings";
import type {
  AgentTargetRole,
  AiMessage,
  Block,
  SidecarAgentTargets,
  StreamEvent,
  TerminalContext,
} from "../lib/types";
import { normalizeKnowledgeBucketRef } from "../lib/knowledge";
import { ownRecordValue } from "../lib/records";
import { defaultShell, localOsLabel } from "../lib/platform";
import { sessionIdForRole } from "../lib/sidecar";
import { collapseHome, resolveSessionTitle } from "../lib/sessionTitle";
import { isTerminalOutputProtected } from "../lib/runbookTerminalPrivacy";
import { PRIVATE_OUTPUT_NOTICE } from "../lib/types";

let requestCounter = 1;

function newRequestId(): string {
  return `req-${Date.now()}-${requestCounter++}`;
}

let steerCounter = 1;

function newSteerId(): string {
  return `st-${Date.now()}-${steerCounter++}`;
}

const OUTPUT_TAIL_LIMIT = 2048;
/** Blocks whose output tails ride along with every request. Kept small: the
 *  local model's context window is the binding constraint. */
const CONTEXT_BLOCKS = 3;

/** Read a block's output tail from the live xterm buffer. Uses the LIVE
 *  markers (lines shift with scrollback trimming/reflow); the end marker sits
 *  on the next prompt's row, so it is treated as EXCLUSIVE. */
export function readBlockOutput(sessionId: string, block: Block, limit = OUTPUT_TAIL_LIMIT): string {
  if (isTerminalOutputProtected(sessionId)) return "";
  const entry = getTerm(sessionId);
  if (!entry) return "";
  const markers = entry.blockMarkers.get(block.id);
  const startLine =
    markers && !markers.start.isDisposed ? markers.start.line : block.startLine;
  const endLine = markers?.end && !markers.end.isDisposed ? markers.end.line : block.endLine;
  if (endLine === null || endLine === undefined) return "";
  return readLineRange(sessionId, startLine, endLine - 1, { limit }).trim();
}

export function buildTerminalContext(sessionId: string): TerminalContext {
  const s = useAppStore.getState();
  const ui = s.sessionUi[sessionId];
  const session = s.sessions.find((x) => x.id === sessionId);
  const remote = ui?.remote ?? null;
  const terminalOutputProtected = isTerminalOutputProtected(sessionId);
  const recentBlocks = terminalOutputProtected ? [] : (ui?.blocks ?? [])
    // Agent-run commands are already in the model's own message history; sending
    // them back as "recent commands" just doubles them up.
    .filter((b) => b.state === "done" && b.command.trim() && b.origin !== "agent")
    .slice(-CONTEXT_BLOCKS)
    .map((b) => ({
      command: b.command,
      exit_code: b.exitCode,
      output_tail: readBlockOutput(sessionId, b),
    }));
  if (!s.sendContextToAi) {
    return {
      session_id: sessionId,
      cwd: null,
      shell: session?.shell ?? defaultShell(),
      git_branch: null,
      os: localOsLabel(),
      recent_blocks: [],
      remote: null,
      screen_tail: "",
      shell_integration: false,
    };
  }
  return {
    session_id: sessionId,
    // While nested, the last OSC 7 report describes the LOCAL machine and the
    // remote cwd is unknown. Sending the stale local path is worse than null:
    // the model would reason confidently about the wrong filesystem.
    cwd: remote ? null : (ui?.cwd ?? null),
    shell: session?.shell ?? defaultShell(),
    git_branch: remote ? null : (ui?.gitBranch ?? null),
    os: remote ? "unknown (remote host)" : localOsLabel(),
    recent_blocks: recentBlocks,
    remote: remote ? { ...remote, host_id: ui?.remoteHost?.id ?? null } : null,
    screen_tail: terminalOutputProtected ? "" : readScreenTail(sessionId),
    shell_integration: (ui?.integrationActive ?? false) && !remote,
  };
}

export function useAiStream() {
  /** NL→command in the composer: streams into composerProposal, never runs anything. */
  const generateCommand = useCallback(async (sessionId: string, prompt: string) => {
    const store = useAppStore.getState();
    const requestId = newRequestId();
    store.updateSessionUi(sessionId, {
      composerStatus: "generating",
      composerProposal: null,
      composerError: null,
      composerRequestId: requestId,
    });
    let accumulated = "";
    // Drop events from an abandoned request (user closed the composer and the
    // cancel raced) — otherwise a stale proposal resurrects into a fresh UI.
    const isCurrent = () =>
      useAppStore.getState().sessionUi[sessionId]?.composerRequestId === requestId;
    try {
      await api.aiSuggest(requestId, prompt, buildTerminalContext(sessionId), (e: StreamEvent) => {
        if (!isCurrent()) return;
        if (e.type === "Delta") {
          accumulated += e.content;
          const parsed = parseSuggestion(accumulated);
          useAppStore.getState().updateSessionUi(sessionId, { composerProposal: parsed });
        } else if (e.type === "Done") {
          const parsed = parseSuggestion(accumulated);
          useAppStore.getState().updateSessionUi(sessionId, {
            composerStatus: parsed.command ? "proposal" : "error",
            composerProposal: parsed,
            composerError: parsed.command ? null : "No command in model response",
          });
        } else if (e.type === "Error") {
          useAppStore.getState().updateSessionUi(sessionId, {
            composerStatus: "error",
            composerError: e.message,
          });
        } else if (e.type === "Cancelled") {
          useAppStore.getState().updateSessionUi(sessionId, { composerStatus: "idle" });
        }
      });
    } catch (err) {
      if (isCurrent()) {
        useAppStore.getState().updateSessionUi(sessionId, {
          composerStatus: "error",
          composerError: String(err),
        });
      }
    }
    return requestId;
  }, []);

  /** Explain a failed block in the AI panel. */
  const explainBlock = useCallback(async (sessionId: string, block: Block) => {
    const store = useAppStore.getState();
    if (isSessionBusy(sessionId)) return; // never clobber an in-flight run
    const requestId = newRequestId();
    setAiPanelOpen(true);
    store.setAiMode(sessionId, "explain");
    const userMsg: AiMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: `Explain why this failed (exit ${block.exitCode}):\n\`\`\`\n${block.command}\n\`\`\``,
      createdAt: new Date().toISOString(),
    };
    store.pushAiMessage(sessionId, userMsg);
    store.initAiStream(sessionId, "explain", requestId);
    const outputTail = readBlockOutput(sessionId, block);
    try {
      await api.aiExplain(
        requestId,
        block.command,
        outputTail,
        block.exitCode ?? 1,
        buildTerminalContext(sessionId),
        (e) => dispatchPanelEvent(sessionId, requestId, e),
      );
    } catch (err) {
      if (ownsActiveRequest(sessionId, requestId)) {
        useAppStore.getState().finishAiStream(sessionId, String(err), undefined, requestId);
      }
    }
  }, []);

  /** Free-form ask in the AI panel (with optional attached blocks as context). */
  const ask = useCallback(async (sessionId: string, prompt: string) => {
    const store = useAppStore.getState();
    if (isSessionBusy(sessionId)) return;
    const requestId = newRequestId();
    const stream = store.aiStreams[sessionId];
    // Claim the generation before the first await. Attachment persistence and
    // knowledge retrieval are preflight work, but an exit/new-chat fence still
    // has to see and retire them before it snapshots the transcript.
    store.initAiStream(sessionId, "ask", requestId);
    // Resolve attached blocks into the context
    const context = buildTerminalContext(sessionId);
    if (stream?.attachedBlockIds.length) {
      const ui = store.sessionUi[sessionId];
      for (const blockId of stream.attachedBlockIds) {
        const block = ui?.blocks.find((b) => b.id === blockId);
        if (block) {
          const tail = readBlockOutput(sessionId, block);
          context.recent_blocks.push({
            command: block.command,
            exit_code: block.exitCode,
            output_tail: tail,
          });
        }
      }
    }
    // `image_count`, not the images: an image rides only on the turn it was
    // attached to, and Rust turns the count back into a note so a replayed turn
    // does not read as if nothing had been attached.
    //
    // Retrieved passages get the same treatment via `stripDocBlocks`, and for a sharper
    // reason: they arrive on EVERY turn, so across the 12 turns ask mode replays they
    // would compound into the whole context budget. Attached files deliberately still
    // ride along — someone who attached a log to turn one expects a follow-up about it
    // to work.
    const history = (stream?.messages ?? []).map((m) => {
      const stripped = stripDocBlocks(m.content);
      return {
        role: m.role,
        content: stripped.content,
        image_count: (m.attachments ?? []).filter((a) => a.kind === "image").length,
        doc_count: stripped.count,
      };
    });

    let staged: Awaited<ReturnType<typeof persistAttachments>>;
    try {
      staged = await persistAttachments(sessionId, stream?.pendingAttachments ?? []);
    } catch (err) {
      if (ownsActiveRequest(sessionId, requestId)) {
        useAppStore.getState().finishAiStream(sessionId, String(err), undefined, requestId);
      }
      return;
    }
    if (!ownsActiveRequest(sessionId, requestId)) return;
    let outgoing = buildOutgoing(prompt, staged);

    // The chat model cannot see, but a sidecar is loaded: transcribe on-device and
    // send TEXT. The panel blocks Send when there is no sidecar, so reaching here
    // with images and no vision means one is ready.
    const canSee = store.catalog.find((m) => m.id === store.activeModelId)?.supports_vision;
    if (outgoing.images.length > 0 && !canSee) {
      if (!ocrAvailable()) {
        useAppStore
          .getState()
          .finishAiStream(sessionId, S.vision.readFailed, undefined, requestId);
        return;
      }
      // Stream FIRST, transcription second. On-device OCR is seconds on a large
      // screenshot, and without this the panel sits inert with no Stop button —
      // indistinguishable from a hang. `vision_describe` registers on the same
      // cancel registry as a chat turn, so Stop really reaches it.
      const folded = await transcribeImages(requestId, outgoing.prompt, staged);
      if (!ownsActiveRequest(sessionId, requestId)) return;
      if (folded === null) {
        // Deliberately NOT sent, and the stream is closed again: an answer about
        // an image the model never received is indistinguishable from one about an
        // image it did. The files stay staged so the user can retry.
        useAppStore
          .getState()
          .finishAiStream(sessionId, S.vision.readFailed, undefined, requestId);
        return;
      }
      outgoing = { prompt: folded, images: [] };
    }

    // Retrieval, before the turn goes out. Ask mode has no tool loop, so this is the
    // only place documents can reach it — and it runs only when the session has a bucket
    // attached, so a session without one pays nothing.
    //
    // After the OCR branch above, so `initAiStream` has already run in the case that
    // needs it, and the query is the user's own words. A failure is deliberately NOT
    // fatal, unlike a failed transcription: an image the model never saw makes its answer
    // meaningless, while missing passages just make it a normal ungrounded answer — and
    // refusing to send would strand the user's message over an optional lookup.
    let docsUsed = 0;
    const bucketRefs =
      stream?.attachedBucketRefs ??
      (stream?.attachedBucketIds ?? []).map(normalizeKnowledgeBucketRef);
    store.setKnowledgeWarning(sessionId, null);
    if (bucketRefs.length > 0) {
      try {
        const response = await api.knowledgeSearchDetailed(
          bucketRefs,
          prompt,
          DOC_INJECT_LIMIT,
        );
        if (!ownsActiveRequest(sessionId, requestId)) return;
        const folded = foldRetrievedPassages(outgoing.prompt, response.hits);
        outgoing = { ...outgoing, prompt: folded.prompt };
        docsUsed = folded.count;
        if (response.partial) {
          const details = response.warnings.map((warning) => warning.message).join(" · ");
          store.setKnowledgeWarning(
            sessionId,
            details
              ? `Some attached knowledge could not be searched: ${details}`
              : "Some attached knowledge could not be searched for this turn.",
          );
        }
      } catch {
        if (!ownsActiveRequest(sessionId, requestId)) return;
        store.setKnowledgeWarning(
          sessionId,
          "Attached knowledge could not be searched for this turn. The answer may be ungrounded.",
        );
      }
    }

    store.pushAiMessage(sessionId, {
      id: `msg-${Date.now()}`,
      role: "user",
      // The FOLDED prompt, so the transcript shows exactly what the model was
      // given rather than a version with the file contents hidden.
      content: outgoing.prompt,
      attachments: staged.length > 0 ? staged : undefined,
      createdAt: new Date().toISOString(),
    });
    // Only now, once the files are on the outgoing message: clearing any earlier
    // would let a send that never starts eat them.
    if (staged.length > 0) store.clearPendingAttachments(sessionId);
    try {
      await api.aiAsk(
        requestId,
        outgoing.prompt,
        history,
        outgoing.images,
        context,
        docsUsed > 0,
        (e) => dispatchPanelEvent(sessionId, requestId, e),
      );
    } catch (err) {
      if (ownsActiveRequest(sessionId, requestId)) {
        useAppStore.getState().finishAiStream(sessionId, String(err), undefined, requestId);
      }
    }
  }, []);

  /** Agent mode: the model proposes commands one at a time; each is gated by
   *  a Run/Skip/Stop card (or auto-accepted when the toggle is armed). */
  const startAgent = useCallback(async (sessionId: string, goal: string) => {
    const store = useAppStore.getState();
    const ownerSessionId = store.resolveAiOwner(sessionId);
    if (isSessionBusy(ownerSessionId)) return;
    const initialSidecar = store.sidecarForSession(ownerSessionId);
    if (initialSidecar && store.refreshSidecarHealth(ownerSessionId)?.status !== "active") return;
    const requestId = newRequestId();
    // Like ask mode, own the session before attachment persistence yields. This
    // makes a shutdown fence authoritative even while no backend request exists.
    store.initAiStream(ownerSessionId, "agent", requestId);
    let staged: Awaited<ReturnType<typeof persistAttachments>>;
    try {
      staged = await persistAttachments(
        ownerSessionId,
        ownRecordValue(store.aiStreams, ownerSessionId)?.pendingAttachments ?? [],
      );
    } catch (err) {
      if (ownsActiveRequest(ownerSessionId, requestId)) {
        useAppStore
          .getState()
          .finishAiStream(ownerSessionId, String(err), undefined, requestId);
      }
      return;
    }
    if (!ownsActiveRequest(ownerSessionId, requestId)) return;

    // Pairing is conversation-scoped and may be ended by New Chat, a target
    // disconnect, or a tab close while attachment preflight is awaiting disk.
    // Never silently turn an intended two-target run into a single-target one.
    const liveStore = useAppStore.getState();
    const liveSidecar = liveStore.sidecarForSession(ownerSessionId);
    if (
      initialSidecar &&
      (!liveSidecar ||
        liveSidecar.localSessionId !== initialSidecar.localSessionId ||
        liveSidecar.remoteSessionId !== initialSidecar.remoteSessionId)
    ) {
      liveStore.finishAiStream(
        ownerSessionId,
        "Sidecar targets changed before the agent started.",
        undefined,
        requestId,
      );
      return;
    }
    if (liveSidecar && liveStore.refreshSidecarHealth(ownerSessionId)?.status !== "active") {
      liveStore.finishAiStream(
        ownerSessionId,
        "Sidecar target is no longer available.",
        undefined,
        requestId,
      );
      return;
    }

    const outgoing = buildOutgoing(goal, staged);
    liveStore.pushAiMessage(ownerSessionId, {
      id: `msg-${Date.now()}`,
      role: "user",
      content: outgoing.prompt,
      attachments: staged.length > 0 ? staged : undefined,
      createdAt: new Date().toISOString(),
    });
    if (staged.length > 0) liveStore.clearPendingAttachments(ownerSessionId);
    // Read at dispatch time, not captured earlier: a reopened session's archived
    // transcript is written into the store asynchronously, and this is what turns
    // agent mode from single-shot into an actual conversation.
    const history =
      ownRecordValue(useAppStore.getState().aiStreams, ownerSessionId)?.modelTranscript ?? [];
    // Read at dispatch time for the same reason as `history`: the user may attach or
    // detach a bucket between turns, and each turn is a fresh run whose tool vector is
    // decided from this list.
    const activeStream = ownRecordValue(useAppStore.getState().aiStreams, ownerSessionId);
    const docBuckets =
      activeStream?.attachedBucketRefs ??
      (activeStream?.attachedBucketIds ?? []).map(normalizeKnowledgeBucketRef);
    const sidecarTargets: SidecarAgentTargets | undefined = liveSidecar
      ? {
          local: buildTerminalContext(liveSidecar.localSessionId),
          remote: buildTerminalContext(liveSidecar.remoteSessionId),
        }
      : undefined;
    const permissionModes = liveSidecar
      ? {
          single: "ask" as const,
          local: liveSidecar.permissions.local,
          remote: liveSidecar.permissions.remote,
        }
      : {
          single: activeStream?.permissionMode ?? ("ask" as const),
          local: "ask" as const,
          remote: "ask" as const,
        };
    try {
      const transcript = await api.agentStart(
        requestId,
        outgoing.prompt,
        buildTerminalContext(ownerSessionId),
        history,
        outgoing.images,
        docBuckets,
        (e) => {
          dispatchPanelEvent(ownerSessionId, requestId, e);
        },
        sidecarTargets,
        permissionModes,
      );
      // Done/Paused clears requestId before agentStart resolves. generationId
      // intentionally survives that event, but is replaced by a new run and
      // cleared by exit/cancel fences.
      useAppStore
        .getState()
        .setModelTranscriptForGeneration(ownerSessionId, requestId, transcript);
    } catch (err) {
      if (ownsActiveRequest(ownerSessionId, requestId)) {
        useAppStore
          .getState()
          .finishAiStream(ownerSessionId, String(err), undefined, requestId);
      }
    }
  }, []);

  /** Resume a run that paused at a guard rail, with a fresh step budget.
   *
   *  MUST stay a human click, and structurally is one: nothing polls the paused
   *  state, the `Paused` arm of `dispatchPanelEvent` never reads `permissionMode`,
   *  and this is the only caller. Auto-firing it under an armed auto mode would
   *  turn the step cap into no cap at all, unattended — the single property the
   *  pause exists to protect.
   *
   *  Resumption needs no new backend plumbing: the pause path returns the
   *  transcript normally, so `startAgent` picks it up as `history` and the backend
   *  starts a fresh budget from iteration 0. The continuation goes in as a real
   *  user turn because the wire requires one (`history::normalize`'s
   *  post-condition is that the last message is a user goal) and because it keeps
   *  the transcript honest about why the run carried on. */
  const continueRun = useCallback(
    async (sessionId: string) => {
      // Idempotent against a double click and against a button left over from a
      // pause that has already been resumed.
      if (useAppStore.getState().aiStreams[sessionId]?.status !== "paused") return;
      await startAgent(sessionId, S.aiPanel.continueGoal);
    },
    [startAgent],
  );

  /** Redirect an agent run that is already going, without cancelling it.
   *
   *  The message is QUEUED, not injected: the backend appends it at the next
   *  round boundary, since a user turn between an assistant's tool_calls and
   *  their results is a 400 on OpenAI and Anthropic and is silently dropped by
   *  Gemma 4's template. While the run is parked on an approval card or a long
   *  command it therefore waits — the panel says so rather than pretending
   *  otherwise. */
  const steer = useCallback(
    async (sessionId: string, text: string) => {
      const body = text.trim();
      if (!body) return;
      const initialStore = useAppStore.getState();
      const ownerSessionId = initialStore.resolveAiOwner(sessionId);
      const stream = ownRecordValue(initialStore.aiStreams, ownerSessionId);
      // Nothing to steer — this is an ordinary Send. Covers the race where the
      // run ended between the panel rendering and the user hitting Enter.
      if (!stream?.requestId || stream.mode !== "agent") {
        void startAgent(ownerSessionId, body);
        return;
      }
      const steerId = newSteerId();
      const generationId = stream.generationId;
      useAppStore.getState().queueSteer(ownerSessionId, steerId, body);
      try {
        await api.agentSteer(stream.requestId, steerId, body);
      } catch {
        // The run ended between the check and the call, or the backend refused
        // it (too long, too many queued). The message stays in the transcript
        // flagged undelivered with its own Send button, rather than vanishing.
        if (generationId && ownsGeneration(ownerSessionId, generationId)) {
          useAppStore.getState().markSteerUndelivered(ownerSessionId, steerId);
        }
      }
    },
    [startAgent],
  );

  const respondToProposal = useCallback(
    async (sessionId: string, decision: "run" | "skip" | "stop", editedCommand?: string) => {
      const initialStore = useAppStore.getState();
      const ownerSessionId = initialStore.resolveAiOwner(sessionId);
      const stream = ownRecordValue(initialStore.aiStreams, ownerSessionId);
      const proposal = stream?.pendingProposal;
      if (!proposal) return;
      if (decision === "skip") {
        useAppStore.getState().setPendingProposal(ownerSessionId, null, "streaming");
      } else if (decision === "stop") {
        useAppStore.getState().setPendingProposal(ownerSessionId, null, "streaming");
      }
      await api.respondToApproval(proposal.approvalId, decision, editedCommand).catch(() => {});
    },
    [],
  );

  const cancel = useCallback(async (sessionId: string) => {
    const initialStore = useAppStore.getState();
    const ownerSessionId = initialStore.resolveAiOwner(sessionId);
    const stream = ownRecordValue(initialStore.aiStreams, ownerSessionId);
    const binding = initialStore.sidecarForSession(ownerSessionId);
    // Release a command we are still awaiting in the terminal. This never
    // interrupts the command itself — it is running in the user's own shell,
    // in front of them, and killing it is their decision.
    if (binding) {
      abortSession(binding.localSessionId, "cancelled");
      abortSession(binding.remoteSessionId, "cancelled");
    } else {
      abortSession(ownerSessionId, "cancelled");
    }
    if (stream?.requestId) {
      const requestId = stream.requestId;
      // Retire ownership synchronously. aiCancel can be delayed, and during
      // preflight there may not even be a registered backend operation yet.
      // Waiting for a Cancelled event would let that old continuation resume or
      // overwrite a new run started in the meantime.
      useAppStore.getState().finishAiStream(ownerSessionId);
      markTranscriptDirty(ownerSessionId);
      await api.aiCancel(requestId).catch(() => {});
    }
  }, []);

  return {
    generateCommand,
    explainBlock,
    ask,
    startAgent,
    continueRun,
    steer,
    respondToProposal,
    cancel,
  };
}

function isSessionBusy(sessionId: string): boolean {
  const store = useAppStore.getState();
  const ownerSessionId = store.resolveAiOwner(sessionId);
  const status = ownRecordValue(store.aiStreams, ownerSessionId)?.status;
  return status === "streaming" || status === "awaiting_approval" || status === "executing";
}

function ownsGeneration(sessionId: string, generationId: string): boolean {
  return ownRecordValue(useAppStore.getState().aiStreams, sessionId)?.generationId === generationId;
}

function ownsActiveRequest(sessionId: string, requestId: string): boolean {
  const stream = ownRecordValue(useAppStore.getState().aiStreams, sessionId);
  return stream?.generationId === requestId && stream.requestId === requestId;
}

type TargetedCommandEvent = {
  target_role?: AgentTargetRole;
  target_session_id?: string;
};

type CommandTargetResolution =
  | { ok: true; sessionId: string; meta?: CommandTargetMeta }
  | { ok: false; reason: string };

/** Resolve backend metadata only through the live conversation binding. Focus,
 * tab order, and labels are presentation state and can never redirect a run. */
function resolveCommandTarget(
  ownerSessionId: string,
  event: TargetedCommandEvent,
): CommandTargetResolution {
  const store = useAppStore.getState();
  const binding = store.sidecarForSession(ownerSessionId);
  if (!binding) {
    if (event.target_role !== undefined || event.target_session_id !== undefined) {
      return { ok: false, reason: "The Sidecar binding ended before command dispatch." };
    }
    return { ok: true, sessionId: ownerSessionId };
  }

  const health = store.refreshSidecarHealth(ownerSessionId);
  const current = useAppStore.getState().sidecarForSession(ownerSessionId);
  if (!current || health?.status !== "active") {
    return { ok: false, reason: "A Sidecar target is disconnected or changed identity." };
  }
  if (!event.target_role || !event.target_session_id) {
    return { ok: false, reason: "The agent did not identify a Sidecar command target." };
  }

  const expectedSessionId = sessionIdForRole(current, event.target_role);
  if (event.target_session_id !== expectedSessionId) {
    return { ok: false, reason: "The agent command target does not match the Sidecar binding." };
  }
  const entry = getTerm(expectedSessionId);
  if (!entry || entry.disposed) {
    store.markSidecarDegraded(ownerSessionId, {
      role: event.target_role,
      reason: "terminal_unavailable",
    });
    return { ok: false, reason: "The selected Sidecar terminal is no longer available." };
  }

  const targetSession = store.sessions.find((session) => session.id === expectedSessionId);
  const targetUi = ownRecordValue(store.sessionUi, expectedSessionId);
  const label =
    event.target_role === "remote"
      ? current.remoteIdentity.label
      : targetUi?.cwd
        ? collapseHome(targetUi.cwd)
        : targetSession
          ? resolveSessionTitle(targetSession, targetUi)
          : expectedSessionId;
  return {
    ok: true,
    sessionId: expectedSessionId,
    meta: { role: event.target_role, sessionId: expectedSessionId, label },
  };
}

function canDispatchToTarget(
  ownerSessionId: string,
  requestId: string,
  event: TargetedCommandEvent,
  expectedSessionId: string,
): boolean {
  const store = useAppStore.getState();
  if (ownRecordValue(store.aiStreams, ownerSessionId)?.requestId !== requestId) return false;
  const target = resolveCommandTarget(ownerSessionId, event);
  return target.ok && target.sessionId === expectedSessionId;
}

function rejectTargetedRun(
  ownerSessionId: string,
  requestId: string,
  reason: string,
  approvalId?: string,
): void {
  if (approvalId) void api.respondToApproval(approvalId, "stop").catch(() => {});
  const store = useAppStore.getState();
  if (ownRecordValue(store.aiStreams, ownerSessionId)?.requestId !== requestId) return;
  store.finishAiStream(ownerSessionId, `Sidecar safety check stopped this run: ${reason}`);
  markTranscriptDirty(ownerSessionId);
  void api.aiCancel(requestId).catch(() => {});
}

function rejectTerminalDispatch(
  ownerSessionId: string,
  requestId: string,
  approvalId: string,
  reason: string,
): void {
  const result = `Nothing was executed: ${reason}`;
  void api
    .submitCommandResult(approvalId, null, result, 0, "target_changed")
    .catch(() => {});
  rejectTargetedRun(ownerSessionId, requestId, reason);
}

function dispatchPanelEvent(sessionId: string, requestId: string, e: StreamEvent): void {
  const store = useAppStore.getState();
  // Ownership check: drop events from a superseded/cancelled request so a
  // stale stream can never mutate a newer run's state.
  if (ownRecordValue(store.aiStreams, sessionId)?.requestId !== requestId) return;
  switch (e.type) {
    case "Delta":
      store.appendAiDelta(sessionId, e.content);
      break;
    case "SteerDelivered":
      // The only thing that clears a "queued" badge: the loop has appended
      // these to the transcript, so the model is about to see them.
      store.markSteersDelivered(sessionId, e.ids);
      break;
    case "Checkpoint":
      // Rust has already removed system messages/images and repaired tool pairs.
      // Keep the array opaque and persist it without changing any visible state.
      store.setModelTranscriptForGeneration(sessionId, requestId, e.transcript);
      markTranscriptCheckpoint(sessionId);
      break;
    case "ThinkingDelta":
      store.appendThinking(sessionId, e.content);
      break;
    case "CommandProposal": {
      const target = resolveCommandTarget(sessionId, e);
      if (!target.ok) {
        rejectTargetedRun(sessionId, requestId, target.reason, e.approval_id);
        break;
      }
      // The backend owns auto-dispatch. Any command that reaches this event has
      // already been evaluated as requiring a real operator decision; the
      // frontend must never reinterpret the fields and auto-click the gate.
      store.setPendingProposal(
          sessionId,
          {
            approvalId: e.approval_id,
            command: e.command,
            explanation: e.explanation,
            readOnly: e.read_only,
            network: e.network,
            outputPolicy: e.output_policy,
            ...(e.assessment ? { assessment: e.assessment } : {}),
            ...(e.ask_reason ? { askReason: e.ask_reason } : {}),
            ...(target.meta
              ? {
                  targetRole: target.meta.role,
                  targetSessionId: target.meta.sessionId,
                }
              : {}),
          },
          "awaiting_approval",
        );
      break;
    }
    case "CommandBlocked": {
      const target = resolveCommandTarget(sessionId, e);
      if (!target.ok) {
        rejectTargetedRun(sessionId, requestId, target.reason);
        break;
      }
      store.noteBlockedCommand(sessionId, e.command, e.reason, target.meta);
      break;
    }
    case "CommandStarted": {
      const target = resolveCommandTarget(sessionId, e);
      if (!target.ok) {
        rejectTargetedRun(sessionId, requestId, target.reason, e.approval_id);
        break;
      }
      store.beginCommand(
        sessionId,
        e.approval_id,
        e.command,
        e.explanation,
        target.meta,
        e.output_policy,
      );
      break;
    }
    case "RunInTerminal": {
      const target = resolveCommandTarget(sessionId, e);
      if (!target.ok || e.session_id !== target.sessionId) {
        const reason = target.ok
          ? "The backend selected a terminal outside the approved Sidecar binding."
          : target.reason;
        rejectTerminalDispatch(sessionId, requestId, e.approval_id, reason);
        break;
      }
      store.beginCommand(
        sessionId,
        e.approval_id,
        e.command,
        e.explanation,
        target.meta,
        e.output_policy,
      );
      // Fire-and-forget: this dispatcher is the Channel callback and must return
      // synchronously. The command is awaited on its own timeline and reported
      // back through submitCommandResult exactly once.
      void runInTerminal(target.sessionId, e.approval_id, e.command, {
        timeoutMs: e.timeout_secs * 1000,
        outputPolicy: e.output_policy,
        // Revalidate after prompt probing and immediately before the one PTY
        // write. Pane focus is deliberately irrelevant; immutable session ids
        // and the live binding are the authority.
        canWrite: () => canDispatchToTarget(sessionId, requestId, e, target.sessionId),
      })
        .then((outcome) => {
          const s = useAppStore.getState();
          if (s.aiStreams[sessionId]?.requestId === requestId) {
            s.setCommandOutput(
              sessionId,
              e.approval_id,
              e.output_policy === "private" ? "" : outcome.output,
            );
            s.finishCommand(
              sessionId,
              e.approval_id,
              outcome.exitCode,
              cardStatus(outcome),
              e.output_policy === "private" ? PRIVATE_OUTPUT_NOTICE : outcome.note,
              outcome.durationMs,
            );
          }
          return api.submitCommandResult(
            e.approval_id,
            outcome.exitCode,
            modelResult(outcome, e.output_policy),
            outcome.durationMs,
            outcome.error ?? null,
          );
        })
        .catch(() => {});
      break;
    }
    case "CommandOutput":
      store.appendCommandOutput(sessionId, e.approval_id, e.chunk);
      break;
    case "CommandResult": {
      const target = resolveCommandTarget(sessionId, e);
      if (!target.ok) {
        rejectTargetedRun(sessionId, requestId, target.reason, e.approval_id);
        break;
      }
      store.finishCommand(
        sessionId,
        e.approval_id,
        e.exit_code,
        undefined,
        undefined,
        e.duration_ms,
      );
      break;
    }
    case "Started":
      // Previously dropped on the floor, which is why switching models
      // relabelled the whole scrollback: attribution has to be recorded when
      // the request starts, not read from settings at render time.
      store.setAiStreamModel(sessionId, e.model);
      break;
    case "Done":
      store.finishAiStream(sessionId, undefined, {
        prompt: e.prompt_tokens,
        completion: e.completion_tokens,
      }, requestId);
      // A completed exchange is the first moment there is anything worth naming
      // a tab after. Debounced and heavily gated (see lib/sessionNaming.ts) —
      // and deliberately after finishAiStream, so the session reads as idle and
      // the naming call cannot queue behind the answer the user is waiting for.
      nameSession(sessionId);
      markTranscriptDirty(sessionId);
      break;
    case "Paused":
      // Carries its own usage rather than being preceded by a Done: the Done arm
      // above sets status "idle" and would settle the run twice.
      store.pauseAiStream(
        sessionId,
        { reason: e.reason, steps: e.steps, limit: e.limit },
        { prompt: e.prompt_tokens, completion: e.completion_tokens },
        requestId,
      );
      // Named and archived like a completed exchange, because that is what it is
      // from the outside: real work happened in the terminal, and the user may
      // never click Continue. `canName` auto-names at most once per session, so
      // resuming will not spend a second inference on another title.
      nameSession(sessionId);
      markTranscriptDirty(sessionId);
      break;
    case "Cancelled":
      store.finishAiStream(sessionId, undefined, undefined, requestId);
      markTranscriptDirty(sessionId);
      break;
    case "Error":
      store.finishAiStream(sessionId, e.message, undefined, requestId);
      // Archived on failure too: a run that errored halfway still did real work
      // in the terminal, and that is exactly the transcript worth reopening.
      markTranscriptDirty(sessionId);
      break;
  }
}

/** Card badge for a PTY outcome. */
function cardStatus(o: PtyExecOutcome): "done" | "timeout" | "blocked" {
  // "still running" is literally true for both: a command we could not kill, and
  // a full-screen program that refused every rung of the interrupt ladder.
  if (o.error === "timeout" || o.error === "interrupt_failed") return "timeout";
  // Never executed at all — the card must not imply the command ran.
  if (
    o.error === "terminal_busy" ||
    o.error === "unsafe_command" ||
    o.error === "not_a_shell" ||
    o.error === "terminal_closed"
  ) {
    return "blocked";
  }
  return "done";
}

/** What the model sees: the note (if any) explains an unknown exit code. */
function modelResult(o: PtyExecOutcome, outputPolicy: "normal" | "private" = "normal"): string {
  if (outputPolicy === "private") return PRIVATE_OUTPUT_NOTICE;
  const where = o.mode && o.mode !== "integrated" ? "(ran in the nested/remote shell) " : "";
  if (o.note) return `${where}${o.note}\n${o.output}`.trim();
  return `${where}${o.output}`.trim();
}

// The suggest prompt asks the model for a fenced command plus a one-line
// rationale; parse both out of the streamed text.
export function parseSuggestion(text: string): { command: string; explanation: string } {
  const fence = text.match(/```(?:\w+)?\n([\s\S]*?)(?:```|$)/);
  const command = fence ? fence[1].trim().split("\n")[0].trim() : "";
  const explanation = text
    .replace(/```(?:\w+)?\n[\s\S]*?(?:```|$)/, "")
    .trim()
    .split("\n")[0]
    .slice(0, 200);
  return { command, explanation };
}
