import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Hourglass,
  Image as ImageIcon,
  KeyRound,
  Keyboard,
  MessageSquarePlus,
  MonitorX,
  Paperclip,
  ScanText,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Zap,
} from "lucide-react";
import { useAppStore, type AiMode } from "../../stores/appStore";
import {
  beginPanelResize,
  commitAiPanelRatio,
  endPanelResize,
  setAiPanelOpen,
} from "../../lib/aiPanel";
import { panelWidthCss, ratioFromDrag } from "../../lib/panelRatio";
import { useAiStream } from "../../hooks/useAiStream";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { AiMessageView } from "./AiMessageView";
import { BlockContextChip } from "./BlockContextChip";
import { BucketChip, BucketPicker } from "./BucketPicker";
import { CommandApprovalCard } from "./CommandApprovalCard";
import { describeRemote } from "../../lib/nesting";
import {
  selectArchiveWillKeepChats,
  startNewChat,
  streamHasConversation,
} from "../../lib/newChat";
import { interruptJob } from "../../lib/ptyExec";
import { askReason, autoRuns, PERMISSION_MODES } from "../../lib/permissionMode";
import { relativeTime } from "../../lib/relativeTime";
import { S } from "../../lib/strings";
import { Dropdown } from "../ui/Dropdown";
import { EffortPicker } from "../ui/EffortPicker";
import * as api from "../../lib/tauri";
import { AttachmentChip } from "./AttachmentChip";
import { thumbnailSrc } from "../../lib/attachments";
import {
  knowledgeBucketKey,
  normalizeKnowledgeBucketRef,
  sameKnowledgeBucket,
} from "../../lib/knowledge";
import {
  inputsFromClipboard,
  inputsFromFileList,
  splitFoldedBlocks,
  stageInputs,
  type FoldedBlock,
} from "../../lib/attachInput";
import type { AiMessage, Attachment, Block, CommandStall } from "../../lib/types";

/** Stable fallback for the blocks selector.
 *
 *  Zustand v5 compares snapshots by identity, so a selector that builds a fresh
 *  `[]` on the miss path returns a new value on every call — React then
 *  re-renders forever ("Maximum update depth exceeded") and unmounts the tree,
 *  which presents as a completely blank window. The miss path is real: a
 *  restored tab sets `activeSessionId` before `sessionUi` has an entry for it.
 */
const NO_BLOCKS: Block[] = [];
/** Same identity-stability reason as NO_BLOCKS. */
const NO_ATTACHMENTS: Attachment[] = [];

/** Dragging selected TEXT across the panel also fires the drag events. Checking
 *  for the `Files` kind keeps the overlay from flashing on a text selection —
 *  `dataTransfer.files` is empty until `drop`, so the type list is the only
 *  thing that answers this during the drag. */
function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

export function AiPanel({ sessionId }: { sessionId: string | null }) {
  const collapsed = !useAppStore((s) => s.aiPanelOpen);
  const stream = useAppStore((s) => (sessionId ? s.aiStreams[sessionId] : undefined));
  const blocks = useAppStore((s) =>
    sessionId ? (s.sessionUi[sessionId]?.blocks ?? NO_BLOCKS) : NO_BLOCKS,
  );
  const remote = useAppStore((s) => (sessionId ? (s.sessionUi[sessionId]?.remote ?? null) : null));
  const cwd = useAppStore((s) => (sessionId ? (s.sessionUi[sessionId]?.cwd ?? null) : null));
  const aiReady = useAppStore((s) => s.aiReady());
  const aiBlockedReason = useAppStore((s) => s.aiBlockedReason());
  const activeModelId = useAppStore((s) => s.activeModelId);
  const catalog = useAppStore((s) => s.catalog);
  const modelEffort = useAppStore((s) => s.modelEffort);
  const detachBlockFromAi = useAppStore((s) => s.detachBlockFromAi);
  const detachBucketFromAi = useAppStore((s) => s.detachBucketFromAi);
  const knowledgeBuckets = useAppStore((s) => s.knowledgeBuckets);
  const detachFileFromAi = useAppStore((s) => s.detachFileFromAi);
  const setAiMode = useAppStore((s) => s.setAiMode);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const { ask, startAgent, continueRun, steer, respondToProposal, cancel } = useAiStream();
  const chatIsKept = useAppStore(selectArchiveWillKeepChats);
  const [input, setInput] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [panelWidth, setPanelWidth] = useState(0);
  // Depth, not a boolean: dragenter/dragleave fire for every child element the
  // cursor crosses, so a flag flickers the overlay off mid-drag.
  const [dragDepth, setDragDepth] = useState(0);
  const ratio = useAppStore((s) => s.aiPanelRatio);

  // A SHARE of the panel, not a fixed 120px: the same number is too small on a
  // tall window and too greedy on a short one. The composer is `shrink-0` and
  // the message list is `flex-1 min-h-0 overflow-y-auto`, so whatever the box
  // takes is absorbed by the list with no other layout change.
  const composerMax =
    panelHeight > 0 ? Math.min(320, Math.max(88, Math.round(panelHeight * 0.4))) : 120;
  // MEASURED width, not the stored ratio: CSS resolves the ratio against the
  // window, so a window resize changes our width without changing the ratio. The
  // re-fit still has to happen — rewrapping changes the line count without
  // changing a character.
  useAutoGrow(inputRef, composerMax, [input, panelWidth]);

  const activeEntry = catalog.find((m) => m.id === activeModelId);
  const mode: AiMode = stream?.mode ?? "ask";
  const messages = stream?.messages ?? [];
  const busy =
    stream?.status === "streaming" ||
    stream?.status === "awaiting_approval" ||
    stream?.status === "executing";
  const streamingContent = stream?.streamingContent ?? "";
  const thinkingContent = stream?.thinkingContent ?? "";
  const pendingProposal = stream?.pendingProposal ?? null;
  const permissionMode = stream?.permissionMode ?? "ask";
  const attachedBlocks = (stream?.attachedBlockIds ?? [])
    .map((id) => blocks.find((b) => b.id === id))
    .filter((b) => b !== undefined);
  const pendingAttachments = stream?.pendingAttachments ?? NO_ATTACHMENTS;
  // Resolved against the live bucket list, so a bucket deleted in Settings while it was
  // attached simply stops rendering instead of showing a chip for something gone.
  const attachedBucketRefs =
    stream?.attachedBucketRefs ??
    (stream?.attachedBucketIds ?? []).map(normalizeKnowledgeBucketRef);
  const attachedBuckets = attachedBucketRefs
    .map((ref) => knowledgeBuckets.find((bucket) => sameKnowledgeBucket(bucket.ref, ref)))
    .filter((b) => b !== undefined);
  const attachError = stream?.attachError ?? null;
  const attachStatus = stream?.attachStatus ?? null;
  const knowledgeWarning = stream?.knowledgeWarning ?? null;
  const hasChat = streamHasConversation(stream);

  // Text files cost nothing special on any model — they are folded into the
  // prompt as text. Only images need a reader.
  const pendingImages = pendingAttachments.filter((a) => a.kind === "image");
  // The ONE definition of who reads images, shared with the header chip and with
  // `attachInput.ocrAvailable`.
  //
  // Selected as a PRIMITIVE, not as the object: `imageReader()` builds a fresh
  // `{kind, label}` every call, and zustand v5 compares snapshots by identity — so
  // selecting the object re-renders forever ("The result of getSnapshot should be
  // cached"). Exactly the trap NO_BLOCKS above documents.
  const readerKind = useAppStore((s) => s.imageReader().kind);
  const imagesBlocked = pendingImages.length > 0 && readerKind === "none";
  const imagesViaOcr = pendingImages.length > 0 && readerKind === "sidecar";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, streamingContent, thinkingContent, pendingProposal]);

  // Feeds `composerMax` and the composer's re-fit. Both axes: height for the
  // former, width for the latter, and only width changes on a window resize now
  // that the ratio is resolved by CSS. Re-runs on `collapsed` because the rail
  // replaces the aside entirely, so the observed node goes away and comes back.
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const measure = () => {
      setPanelHeight(el.clientHeight);
      setPanelWidth(el.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  // One panel serves every tab, so an armed confirmation would otherwise follow
  // the user to the next one and discard a conversation they never clicked on.
  useEffect(() => setConfirmClear(false), [sessionId]);

  const agentMode = mode === "agent";
  // Agent mode is steerable mid-run; ask mode is one provider call with no round
  // boundary to inject into, so it stays locked while it streams.
  const steering = busy && agentMode;
  const queuedSteers = stream?.steerQueue.length ?? 0;

  const submit = () => {
    if (!sessionId || !input.trim() || !aiReady) return;
    // Blocked, never silently stripped: an answer about an image the model never
    // received is indistinguishable from an answer about one it did.
    if (imagesBlocked) return;
    if (busy) {
      if (!steering) return;
      void steer(sessionId, input.trim());
    } else if (agentMode) {
      void startAgent(sessionId, input.trim());
    } else {
      void ask(sessionId, input.trim());
    }
    setInput("");
  };

  // Collapsed keeps the panel MOUNTED behind a rail rather than unmounting it:
  // the slide-in animation would otherwise replay on every reopen, and any
  // in-flight stream would lose its scroll position.
  if (collapsed) return <CollapsedRail busy={busy} />;

  return (
    <aside
      ref={asideRef}
      style={{ width: panelWidthCss(ratio) }}
      className="relative flex shrink-0 flex-col border-s border-border-subtle bg-bg-secondary animate-slide-in-right"
      onDragEnter={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragOver={(e) => {
        // Without preventDefault the webview navigates AWAY to the dropped file,
        // which unmounts the whole app.
        if (hasFiles(e.dataTransfer)) e.preventDefault();
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDragDepth(0);
        if (sessionId) void stageInputs(sessionId, inputsFromFileList(e.dataTransfer.files));
      }}
    >
      <ResizeHandle />
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-none border-2 border-dashed border-accent bg-bg-primary/80">
          <span className="text-[12px] font-medium text-accent">{S.attachments.dropHere}</span>
        </div>
      )}
      {/* Header */}
      {/* `gap-1` and `min-w-0` on both clusters: this row has no wrap and no scroll, so
          without them a narrow panel clips whatever is furthest right — the collapse
          chevron — instead of letting the dropdown triggers shorten. */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-border-subtle px-2">
        <div className="flex min-w-0 items-center rounded-lg bg-bg-primary p-0.5 border border-border-subtle">
          {(["ask", "agent"] as const).map((m) => (
            <button
              key={m}
              onClick={() => sessionId && setAiMode(sessionId, m)}
              disabled={busy}
              className={`flex items-center gap-1 rounded-md px-2.5 py-0.5 text-[11px] font-medium transition-all duration-150 ${
                (mode === m || (mode === "explain" && m === "ask"))
                  ? m === "agent"
                    ? "bg-accent/15 text-accent shadow-sm"
                    : "bg-bg-hover text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-secondary"
              } ${busy ? "opacity-50" : ""}`}
            >
              {m === "agent" && <Zap size={10} />}
              {m === "agent" ? S.aiPanel.titleAgent : S.aiPanel.titleAsk}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-0.5">
          {/* First in the cluster deliberately: Auto-accept appears and vanishes
              with the mode, and a button that moves under the cursor is a button
              you misclick. */}
          <button
            onClick={() => {
              if (!sessionId) return;
              // The one path where the chat is really discarded is the one path
              // that asks. Everywhere else it lands in Past sessions.
              if (!chatIsKept && !confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              setInput("");
              void startNewChat(sessionId);
            }}
            onBlur={() => setConfirmClear(false)}
            disabled={!sessionId || !hasChat}
            className={`rounded-md p-1 transition-colors duration-100 hover:bg-bg-hover ${
              confirmClear ? "text-error" : "text-text-muted hover:text-text-secondary"
            } ${!sessionId || !hasChat ? "opacity-50" : ""}`}
            title={
              confirmClear
                ? S.aiPanel.newChatDiscard
                : chatIsKept
                  ? S.aiPanel.newChatHint
                  : S.aiPanel.newChat
            }
            aria-label={S.aiPanel.newChat}
          >
            <MessageSquarePlus size={14} />
          </button>
          {/* A dropdown rather than a segmented control, because three segmented
              controls plus two buttons need ~510px and this panel defaults to 420px and
              floors at 320px, in a fixed-height row with no wrap and no scroll.

              Collapsing a SAFETY control is only acceptable because the trigger still
              renders the current mode in its own tone — "All" stays warning-coloured —
              and the auto_all banner below this row is untouched. Hiding the options is
              fine; hiding the state would break the promise that arming auto-accept is a
              deliberate, visible act. The per-mode explanations also read better here:
              as a segmented control they were tooltips nobody hovered. */}
          {agentMode && sessionId && (
            <Dropdown
              value={permissionMode}
              options={PERMISSION_MODES.map((m) => ({
                value: m,
                label: S.aiPanel.permission[m],
                title: S.aiPanel.permissionHint[m],
                tone: m === "auto_all" ? ("warning" as const) : ("accent" as const),
              }))}
              onChange={(next) => {
                useAppStore.getState().setPermissionMode(sessionId, next);
                // Switching to a mode that WOULD have auto-run the card already
                // on screen must run it — the control promises that. Unlike the
                // boolean it replaces, the promise is now command-dependent, so
                // arming "Reads" over an `rm -rf` card correctly leaves it up.
                if (pendingProposal && autoRuns(next, pendingProposal)) {
                  void respondToProposal(sessionId, "run");
                }
              }}
              ariaLabel={S.aiPanel.permissionLabel}
              hint={S.aiPanel.permissionLabel}
              size="sm"
              icon={<ShieldCheck size={10} className="shrink-0 opacity-70" />}
            />
          )}
          {/* Ask AND agent, by different mechanisms: agent mode gets a `search_docs`
              tool it calls when it wants, while ask mode has no tool loop and instead
              gets the best-matching passages folded into the turn. Not in Explain,
              which is one-shot on a block the user already picked. Renders nothing when
              the feature is off or no bucket has been indexed. */}
          {(agentMode || mode === "ask") && sessionId && <BucketPicker sessionId={sessionId} />}
          {/* Reasoning depth for the model in use. The rungs come from that
              model's own capabilities, so this is not a fixed on/off switch — and
              `layout="dropdown"` because five of them at ~150px is the single widest
              thing in this row, for the setting changed least often. Still renders
              nothing below two rungs. */}
          {activeEntry && (
            <EffortPicker
              value={modelEffort[activeEntry.id] ?? activeEntry.effort}
              available={activeEntry.efforts}
              size="sm"
              layout="dropdown"
              onChange={(e: import("../../lib/types").Effort) => {
                useAppStore.getState().setModelEffortLocal(activeEntry.id, e);
                void api.setModelEffort(activeEntry.id, e).catch(() => {});
              }}
            />
          )}
          <button
            onClick={() => setAiPanelOpen(false)}
            className="rounded-md p-1 text-text-muted transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
            title={S.aiPanel.collapse}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {agentMode && permissionMode === "auto_all" && (
        <div className="shrink-0 border-b border-border-subtle bg-warning/10 px-3 py-1 text-[10px] text-warning">
          {S.aiPanel.autoAllWarning}
        </div>
      )}
      {agentMode && permissionMode === "auto_read" && (
        <div className="shrink-0 border-b border-border-subtle px-3 py-1 text-[10px] text-text-muted">
          {S.aiPanel.autoReadNote}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !busy && (
          <p className="pt-6 text-center text-[12px] text-text-muted">
            {aiReady
              ? agentMode
                ? S.aiPanel.agentPlaceholder
                : S.aiPanel.placeholder
              : S.composer.blocked[aiBlockedReason ?? "load"]}
          </p>
        )}
        {/* The panel-side twin of the terminal's replay banner. Deliberately not a
            synthetic message — a message would be fed back to the model on the
            next turn as if the user had said it. */}
        {stream?.restoredAt && (
          <p className="pb-2 text-center text-[10px] text-text-muted">
            {S.aiPanel.restoredTranscript} {relativeTime(stream.restoredAt)}
          </p>
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} sessionId={sessionId} />
        ))}
        {/* Live thinking stream */}
        {thinkingContent && (
          <ThinkingSection content={thinkingContent} live={stream?.status === "streaming"} />
        )}
        {/* Live answer stream */}
        {streamingContent && (
          <div className="text-text-primary">
            <AiMessageView content={streamingContent} />
          </div>
        )}
        {busy && !streamingContent && !thinkingContent && !pendingProposal && (
          <span className="flex items-center gap-1.5 text-[12px] text-text-muted">
            <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent" />
            {S.aiPanel.thinking}
          </span>
        )}
        {/* Approval gate */}
        {pendingProposal && sessionId && (
          <CommandApprovalCard
            key={pendingProposal.approvalId}
            command={pendingProposal.command}
            explanation={pendingProposal.explanation}
            remote={!!remote}
            target={describeRemote(remote) ?? cwd}
            queuedSteers={queuedSteers}
            // Why this is asking despite an armed auto mode. Null in Confirm,
            // where no explanation is owed.
            askedBecause={askReason(permissionMode, pendingProposal)}
            onRespond={(decision, edited) => void respondToProposal(sessionId, decision, edited)}
          />
        )}
        {/* A guard rail, not a failure: the transcript is intact and resumable, so
            this gets the neutral treatment and a real control rather than the red
            error line. Mutually exclusive with the error banner by construction —
            `pauseAiStream` leaves `lastError` null. */}
        {stream?.pause && sessionId && !busy && (
          <div className="rounded-lg border border-border-subtle px-3 py-2 text-[11px] text-text-muted">
            <p>
              {stream.pause.reason === "context_limit"
                ? S.aiPanel.pausedContextLimit(stream.pause.steps)
                : S.aiPanel.pausedStepLimit(stream.pause.steps, stream.pause.limit)}
            </p>
            <p className="mt-0.5">{S.aiPanel.pausedHint}</p>
            <button
              type="button"
              onClick={() => void continueRun(sessionId)}
              className="mt-1.5 rounded-md bg-accent px-3 py-1 text-[11px] font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover"
            >
              {S.aiPanel.pausedContinue}
            </button>
          </div>
        )}
        {stream?.lastError && (
          <p className="rounded-lg bg-error-subtle px-3 py-2 text-[11px] text-error">
            {S.aiPanel.errorPrefix}: {stream.lastError}
          </p>
        )}
      </div>

      {/* The active model cannot read what is staged. Blocking, with the two ways
          out named — the warning treatment is the auto-accept banner's, so "this
          needs a decision from you" looks the same everywhere in the panel. */}
      {imagesBlocked && (
        <div className="shrink-0 border-t border-border-subtle bg-warning/10 px-3 py-1.5 text-[10px] text-warning">
          {S.attachments.noVision(activeEntry?.label ?? "This model")} —{" "}
          {S.attachments.noVisionFix}{" "}
          {/* A real control, not prose telling you where to go. This state is the
              one place the app admits it cannot do the thing you just asked for,
              so the fix should be one click away. */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="underline decoration-dotted underline-offset-2 hover:text-text-primary"
          >
            {S.attachments.noVisionSetUp}
          </button>
        </div>
      )}
      {/* Says what will actually happen, rather than letting the user believe the
          chat model is looking at the picture. */}
      {imagesViaOcr && (
        <div className="shrink-0 border-t border-border-subtle px-3 py-1.5 text-[10px] text-text-muted">
          {S.attachments.viaOcr(activeEntry?.label ?? "This model")}
        </div>
      )}

      {/* Attached blocks and staged files share one strip: both are "context for
          the next turn", and two stacked rows would eat the message list. */}
      {(attachedBlocks.length > 0 ||
        attachedBuckets.length > 0 ||
        pendingAttachments.length > 0 ||
        attachError ||
        attachStatus ||
        knowledgeWarning) &&
        sessionId && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle px-3 py-2">
          {attachedBlocks.map((b) => (
            <BlockContextChip
              key={b.id}
              block={b}
              onRemove={() => detachBlockFromAi(sessionId, b.id)}
            />
          ))}
          {attachedBuckets.map((b) => (
            <BucketChip
              key={knowledgeBucketKey(b.ref)}
              label={b.label}
              source={b.ref.source}
              connectionLabel={b.connection_label}
              chunkCount={b.chunk_count}
              onRemove={() => detachBucketFromAi(sessionId, b.ref)}
            />
          ))}
          {pendingAttachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => detachFileFromAi(sessionId, a.id)}
            />
          ))}
          {/* Progress outranks the error line visually by being calm: this is work
              in flight, not a problem. */}
          {attachStatus && (
            <span className="flex w-full items-center gap-1.5 text-[10px] text-text-muted">
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent" />
              {attachStatus}
            </span>
          )}
          {attachError && <span className="w-full text-[10px] text-error">{attachError}</span>}
          {knowledgeWarning && (
            <span className="w-full text-[10px] text-warning">{knowledgeWarning}</span>
          )}
        </div>
      )}

      {/* Input */}
      <div className="shrink-0 border-t border-border-subtle p-2">
        <div className="flex items-end gap-1.5 rounded-2xl border border-border-subtle bg-bg-card p-1.5">
          {/* A real file input, not the dialog plugin: `openDialog` returns a
              PATH and there is no fs plugin, so that route would need a Rust
              reader for something the webview already hands over as bytes. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (sessionId) void stageInputs(sessionId, inputsFromFileList(e.target.files));
              // Reset, or picking the same file twice in a row is a no-op.
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy && !steering}
            title={S.attachments.attach}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60"
          >
            <Paperclip size={13} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const inputs = inputsFromClipboard(e.clipboardData?.items ?? null);
              if (inputs.length === 0) return; // ordinary text paste
              e.preventDefault();
              if (sessionId) void stageInputs(sessionId, inputs);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={busy && !steering}
            placeholder={
              steering
                ? S.aiPanel.steerPlaceholder
                : agentMode
                  ? S.aiPanel.agentPlaceholder
                  : S.aiPanel.placeholder
            }
            /* Height and overflow are owned by useAutoGrow as inline styles — a
               `max-h-*` class here would be dead, and `resize` has to go or the
               native corner grip fights the JS sizing. */
            className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] text-text-primary placeholder:text-text-muted disabled:opacity-50"
          />
          {/* Stop stays put for the whole run — it is the only way out, and
              swapping it for a mode-dependent button breaks that muscle memory.
              While steering, Send appears ALONGSIDE it. */}
          {busy && (
            <button
              onClick={() => sessionId && void cancel(sessionId)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-error/15 text-error transition-colors duration-150 hover:bg-error/25"
              title={S.aiPanel.stop}
            >
              <Square size={13} />
            </button>
          )}
          {(!busy || steering) && (
            <button
              onClick={submit}
              disabled={!input.trim() || !aiReady || imagesBlocked}
              title={
                imagesBlocked
                  ? S.attachments.noVision(activeEntry?.label ?? "This model")
                  : steering
                    ? S.aiPanel.steerHint
                    : undefined
              }
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent text-bg-primary transition-colors duration-150 hover:bg-accent-hover disabled:opacity-60"
            >
              <Send size={13} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Collapsed state: a narrow strip that keeps the AI one click away instead of
 *  vanishing. Without it, a closed panel is only recoverable if you happen to
 *  know about ⌘J or the header button. */
function CollapsedRail({ busy }: { busy: boolean }) {
  return (
    <aside className="flex w-9 shrink-0 flex-col items-center gap-2 border-s border-border-subtle bg-bg-secondary py-2">
      <button
        onClick={() => setAiPanelOpen(true)}
        className="rounded-md p-1.5 text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        title={`${S.aiPanel.expand} (⌘J)`}
      >
        <Sparkles size={14} />
      </button>
      {/* Otherwise a collapsed panel hides the fact that it is still working. */}
      {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
    </aside>
  );
}

/** Drag handle on the panel's leading edge.
 *
 *  The ratio is committed to settings ONCE, on pointer-up: the terminal's
 *  ResizeObserver already refits on every frame of the drag, and a settings
 *  write per frame would be gratuitous. */
function ResizeHandle() {
  const setAiPanelRatio = useAppStore((s) => s.setAiPanelRatio);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const el = e.currentTarget;
        // Measured from the DOM, not from the store: CSS owns the current width
        // (a `clamp()` over the row), so the stored ratio is not necessarily what
        // is on screen — at the 320px floor it is not. Starting the drag from the
        // rendered edge is what keeps the handle under the pointer.
        const panel = el.closest("aside");
        const startWidth = panel?.getBoundingClientRect().width ?? 0;
        // The flex row that owns the split, i.e. what the ratio is a share OF.
        const containerWidth = panel?.parentElement?.clientWidth ?? 0;
        // Pointer capture, not window listeners: the pointer will travel over
        // the xterm canvas, which would otherwise swallow the move events.
        el.setPointerCapture(e.pointerId);
        beginPanelResize();

        const onMove = (ev: PointerEvent) => {
          // Dragging left (negative delta) widens a right-hand panel.
          setAiPanelRatio(ratioFromDrag(startWidth - (ev.clientX - startX), containerWidth));
        };
        const onUp = () => {
          el.releasePointerCapture(e.pointerId);
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("pointercancel", onUp);
          endPanelResize();
          commitAiPanelRatio(useAppStore.getState().aiPanelRatio);
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
      }}
      className="absolute inset-y-0 start-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
    />
  );
}

function MessageRow({ message, sessionId }: { message: AiMessage; sessionId: string | null }) {
  if (message.kind === "command" && message.command) {
    return <CommandMessage message={message} sessionId={sessionId} />;
  }
  if (message.role === "user") {
    return (
      <div
        className={`ms-6 rounded-lg border bg-bg-card px-3 py-2 text-[12px] text-text-secondary ${
          message.steer === "undelivered" ? "border-warning/40" : "border-border-subtle"
        }`}
      >
        <AttachmentStrip message={message} />
        {/* The folded blocks come back OUT of `content` for display — the field
            itself keeps them, because it is what was sent and what is archived. */}
        {(() => {
          const { prompt, blocks } = splitFoldedBlocks(message.content);
          return (
            <>
              {prompt && <AiMessageView content={prompt} />}
              {blocks.map((block, i) => (
                <FoldedBlockSection key={`${block.kind}-${block.name}-${i}`} block={block} />
              ))}
            </>
          );
        })()}
        <SteerBadge message={message} sessionId={sessionId} />
      </div>
    );
  }
  return (
    <div className="text-text-primary">
      {message.thinking && <ThinkingSection content={message.thinking} live={false} />}
      {message.content && <AiMessageView content={message.content} />}
      <MessageMeta message={message} />
    </div>
  );
}

/** A block that was folded into the message text, shown collapsed.
 *
 *  Same treatment as `ThinkingSection`, for the same reason: an OCR transcript or a
 *  dropped log is machinery the MODEL needed, and rendering it as a full-width
 *  monospace wall makes the user's own question a footnote to it. `content` still
 *  carries the text — see `splitFoldedBlocks` — so this is purely presentation.
 *
 *  Always starts collapsed: unlike thinking there is no "live" phase during which
 *  watching it stream is the point.
 */
function FoldedBlockSection({ block }: { block: FoldedBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 rounded-lg border border-border-subtle bg-bg-primary/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] font-medium uppercase tracking-widest text-text-muted"
      >
        <span className="shrink-0">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <span className="shrink-0">
          {block.kind === "transcript" ? (
            <ScanText size={11} />
          ) : block.kind === "docs" ? (
            <BookOpen size={11} />
          ) : (
            <FileText size={11} />
          )}
        </span>
        {/* `shrink-0 whitespace-nowrap`, not a bare text node. Uppercase plus
            `tracking-widest` makes even a short label wide, and as a shrinkable flex item
            it wrapped onto a second line and left a gap the filename was pushed across.

            Dropped entirely for a passage: the book icon already distinguishes it from a
            file or a transcript, and at this tracking the word cost ~75px that a long
            source filename needs more — three passages from one document are told apart
            by their page, and the filename is what says WHICH document. */}
        {block.kind !== "docs" && (
          <span className="shrink-0 whitespace-nowrap">
            {block.kind === "transcript"
              ? S.attachments.blockTranscript
              : S.attachments.blockFile}
          </span>
        )}
        {/* The filename, model and page are data, not a section title — drop the
            uppercase treatment for them or a path becomes unreadable.
            `flex-1` so this is the element that absorbs the truncation. */}
        <span className="min-w-0 flex-1 truncate font-normal normal-case tracking-normal">
          {block.name}
          {block.model ? ` ${S.attachments.blockReadBy(block.model)}` : ""}
        </span>
        {/* The page is the LAST thing that should be lost. Folded into the filename it
            was truncated away first — and for three passages from one document the page
            is the only thing telling them apart. Capped so a long heading cannot squeeze
            the filename out entirely. */}
        {block.locator && (
          <span className="max-w-[45%] shrink-0 truncate font-normal normal-case tracking-normal">
            {block.locator}
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 pb-2 text-[11px] leading-relaxed text-text-muted">
          {block.body}
          {block.truncated && (
            <p className="mt-1.5 italic">{S.attachments.blockTruncated}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** What was attached to a turn, above its text.
 *
 *  Rendered from the message rather than from the pending list, so a scrolled-back
 *  turn still shows what the model was actually given. A restored transcript has
 *  the metadata but not the bytes until `attachment_read` refills them, hence the
 *  named fallback instead of a broken image.
 */
function AttachmentStrip({ message }: { message: AiMessage }) {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {attachments.map((a) => {
        const src = a.kind === "image" ? thumbnailSrc(a) : null;
        return src ? (
          <img
            key={a.id}
            src={src}
            alt={a.name}
            title={a.name}
            className="h-24 max-w-full rounded-lg border border-border-subtle object-cover"
          />
        ) : (
          <span
            key={a.id}
            className="flex items-center gap-1 rounded-md border border-border-subtle bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-secondary"
          >
            {a.kind === "image" ? <ImageIcon size={9} /> : <FileText size={9} />}
            {a.name}
          </span>
        );
      })}
    </div>
  );
}

/** Delivery state of a message typed mid-run.
 *
 *  Absent once the loop confirms it via SteerDelivered — so "queued" that never
 *  clears becomes "undelivered" when the run ends, and the user is never left
 *  believing the model read something it did not. Undelivered offers a Send, not
 *  an auto-retry: starting a fresh run is the user's call. */
function SteerBadge({ message, sessionId }: { message: AiMessage; sessionId: string | null }) {
  const { startAgent } = useAiStream();
  if (!message.steer) return null;
  if (message.steer === "queued") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
        <Hourglass size={9} />
        {S.aiPanel.steerQueued}
      </p>
    );
  }
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-warning">
      <span>{S.aiPanel.steerUndelivered}</span>
      {sessionId && (
        <button
          onClick={() => void startAgent(sessionId, message.content)}
          className="rounded-md border border-warning/40 px-1.5 py-0.5 text-warning transition-colors duration-150 hover:bg-warning/10"
        >
          {S.aiPanel.steerSend}
        </button>
      )}
    </p>
  );
}

/** Who wrote this and what it cost.
 *
 *  Per message rather than per panel: the model can be switched mid-thread, and
 *  a single global chip would retroactively relabel everything above it. */
function MessageMeta({ message }: { message: AiMessage }) {
  if (!message.model && !message.usage) return null;
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
      {message.model && <span>{message.model}</span>}
      {message.model && message.usage && <span aria-hidden>·</span>}
      {message.usage && (
        <span title={S.aiPanel.usageHint}>
          {message.usage.prompt.toLocaleString()} in ·{" "}
          {message.usage.completion.toLocaleString()} out
        </span>
      )}
    </p>
  );
}

/** Per-stall copy plus whether the user is offered the interrupt. */
const STALL_UI: Record<CommandStall, { label: string; icon: typeof KeyRound; offer: boolean }> = {
  // Handled automatically: the ladder is already running, so no button.
  tui: { label: S.aiPanel.stallTui, icon: MonitorX, offer: false },
  // The user's keyboard is the fix, not a signal.
  password: { label: S.aiPanel.stallPassword, icon: KeyRound, offer: false },
  input: { label: S.aiPanel.stallInput, icon: Keyboard, offer: true },
  idle: { label: S.aiPanel.stallIdle, icon: Hourglass, offer: true },
};

function CommandMessage({
  message,
  sessionId,
}: {
  message: AiMessage;
  sessionId: string | null;
}) {
  const cmd = message.command;
  if (!cmd) return null;
  const failed = cmd.status === "done" && (cmd.exitCode ?? 0) !== 0;
  const stall = cmd.status === "running" && cmd.stall ? STALL_UI[cmd.stall] : null;
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle">
      <div className="flex items-center justify-between gap-2 bg-bg-hover px-2.5 py-1">
        <code className="min-w-0 truncate font-mono text-[11px] text-text-primary">
          $ {cmd.command}
        </code>
        {cmd.status === "running" ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-accent">
            <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent" />
            {S.aiPanel.running}
          </span>
        ) : cmd.status === "skipped" ? (
          <span className="shrink-0 rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-text-secondary">
            {S.aiPanel.skipped}
          </span>
        ) : cmd.status === "timeout" ? (
          // The command was NOT killed — it is still running in the terminal.
          <span className="flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">
            <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-warning" />
            {S.aiPanel.stillRunning}
          </span>
        ) : cmd.status === "blocked" ? (
          <span className="shrink-0 rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-[9px] text-text-secondary">
            {S.aiPanel.notRun}
          </span>
        ) : (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] ${
              failed ? "bg-error-subtle text-error" : "bg-accent/10 text-accent"
            }`}
          >
            {S.blocks.exit} {cmd.exitCode ?? "?"}
          </span>
        )}
      </div>
      {/* Why it ran. Matters most for a command that auto-ran under a permission
          mode: there was no approval card to read this on. */}
      {cmd.explanation && (
        <p className="bg-bg-elevated px-2.5 py-1 text-[10px] text-text-muted">{cmd.explanation}</p>
      )}
      {/* What actually went in. The user approved `systemctl status x`; the
          terminal echoes an env prefix and a redirect they never saw. */}
      {cmd.typed && (
        <p className="truncate bg-bg-elevated px-2.5 py-1 font-mono text-[10px] text-text-secondary">
          {S.aiPanel.ranAs} {cmd.typed}
        </p>
      )}
      {stall && (
        <div className="flex items-center gap-2 bg-warning/10 px-2.5 py-1 text-[10px] text-warning">
          <stall.icon size={11} className="shrink-0" />
          <span className="min-w-0 flex-1">{stall.label}</span>
          {stall.offer && sessionId && (
            <button
              onClick={() => interruptJob(sessionId)}
              title={S.aiPanel.interruptHint}
              className="shrink-0 rounded border border-warning/40 px-1.5 py-0.5 font-medium transition-colors duration-150 hover:bg-warning/20"
            >
              {S.aiPanel.interrupt}
            </button>
          )}
        </div>
      )}
      {cmd.note && (
        <p className="bg-bg-elevated px-2.5 py-1 text-[10px] text-text-secondary">{cmd.note}</p>
      )}
      {cmd.output && (
        <pre className="max-h-48 overflow-y-auto bg-bg-terminal px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary">
          {cmd.output}
        </pre>
      )}
    </div>
  );
}

function ThinkingSection({ content, live }: { content: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  // Auto-collapse when the live stream transitions into the answer.
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary/50">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-widest text-text-muted"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Brain size={11} />
        {S.aiPanel.thinkingLabel}
        {live && <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-accent" />}
      </button>
      {open && (
        <div className="max-h-40 overflow-y-auto px-3 pb-2 text-[11px] leading-relaxed text-text-muted">
          {content}
        </div>
      )}
    </div>
  );
}
