import { create } from "zustand";
import type {
  AiMessage,
  Attachment,
  Block,
  CatalogEntry,
  ChatMessage,
  SettledCommandStatus,
  CommandStall,
  DocBucket,
  Effort,
  KnowledgeBucketDescriptor,
  KnowledgeBucketRef,
  LocalAccelerationInfo,
  LocalModel,
  ModelState,
  McpChatSelection,
  McpServerView,
  McpToolResultView,
  OutputPolicy,
  RemoteContext,
  Session,
  VisionCatalogEntry,
} from "../lib/types";
import { PRIVATE_OUTPUT_NOTICE } from "../lib/types";
import type { EvidenceRecordingPolicy } from "../lib/runbooks";
import {
  normalizeKnowledgeBucketRef,
  sameKnowledgeBucket,
} from "../lib/knowledge";
import { MAX_ATTACHMENTS } from "../lib/attachments";
import type { Phase } from "../lib/osc133";
import type { PermissionMode } from "../lib/permissionMode";
import { PANEL_DEFAULT_RATIO, clampPanelRatio } from "../lib/panelRatio";
import {
  ownRecordValue,
  withRecordValue,
  withoutRecordKey,
} from "../lib/records";
import { S } from "../lib/strings";
import { DEFAULT_THEME_ID } from "../lib/themes";
import {
  captureSidecarRemoteIdentity,
  clampSidecarRatio,
  createSidecarBinding,
  inspectCurrentSidecarHealth,
  resolveAiOwner as resolveSidecarAiOwner,
  roleForSession,
  sameRemoteIdentity,
  sessionIdForRole,
  sidecarForSession as findSidecarForSession,
  validateSidecarTarget,
  type AgentTargetRole,
  type SidecarBinding,
  type SidecarDegradation,
  type SidecarHealth,
  type SidecarRemoteIdentity,
  type SidecarSplitOrientation,
  type SidecarStartResult,
} from "../lib/sidecar";

// Per-session UI state (Cowork convStreams pattern — per-entity map, no
// global-sync mirroring; components read sessionUi[activeSessionId]).
export interface SessionUiState {
  blocks: Block[];
  runningBlockId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  /** Shell phase from OSC 133 (idle→prompt→input→output). Drives the agent's
   *  "is it safe to type into this terminal" gate. */
  phase: Phase;
  /** Set while the tab is inside a nested shell (ssh, docker exec, …), during
   *  which `cwd`/`gitBranch` describe a different machine and must not be sent
   *  to the model as current. */
  remote: RemoteContext | null;
  /** Block whose lifetime IS the nested session — when it ends we are back on
   *  the local shell and `remote` must clear. */
  nestedBlockId: string | null;
  /** The saved host behind the CURRENT nested session, when the connect came
   *  from the app's host list. Cleared with `remote`. A hand-typed `ssh` still
   *  sets `remote` but leaves this null. Distinct from `Session.hostId`, which
   *  is provenance and outlives the connection. */
  remoteHost: { id: string; label: string; color: string | null } | null;
  /** Host last reported by OSC 7. */
  host: string | null;
  /** Label for a command that has been running long enough to be worth naming
   *  the tab after. Set on a delay (see LONG_RUNNING_MS) so that `ls` and `cat`
   *  never get to flicker the tab — only dev servers, builds and editors do. */
  longRunningCommand: string | null;
  /** True once any OSC 133 mark has arrived — i.e. integration is really live. */
  integrationActive: boolean;
  searchOpen: boolean;
  composerOpen: boolean;
  composerStatus: "idle" | "generating" | "proposal" | "error";
  composerProposal: { command: string; explanation: string } | null;
  composerError: string | null;
  composerRequestId: string | null;
}

export type AiMode = "ask" | "explain" | "agent";

export type SettingsTab =
  | "models"
  | "statistics"
  | "mcp"
  | "agent"
  | "instructions"
  | "docs"
  | "runbooks"
  | "appearance"
  | "terminal"
  | "hosts"
  | "updates"
  | "about";

export interface CommandTargetMeta {
  role: AgentTargetRole;
  sessionId: string;
  label: string;
}

export interface AiStreamState {
  mode: AiMode;
  status:
    | "idle"
    | "streaming"
    | "awaiting_approval"
    | "executing"
    | "error"
    | "paused";
  requestId: string | null;
  /** Stable owner for every asynchronous continuation belonging to a run.
   * It survives Done until the agent promise resolves, but fences/new runs
   * clear or replace it so late callbacks cannot mutate finalized state. */
  generationId: string | null;
  messages: AiMessage[];
  streamingContent: string;
  /** Live reasoning stream (thinking mode); folded into the message on finish. */
  thinkingContent: string;
  /** Model serving THIS request, from StreamEvent::Started. */
  model: string | null;
  /** The MODEL's own view of this conversation, as returned by `agent_start` and
   *  passed straight back on the next turn — which is what makes agent mode
   *  remember anything across turns at all. Opaque: see `ChatMessage`. Empty
   *  until the first agent turn finishes; ask/explain turns do not produce one. */
  modelTranscript: ChatMessage[];
  /** Set when this panel was hydrated from the archive: the ISO time the
   *  transcript was captured. Rendered as one dim line above the messages —
   *  deliberately NOT a synthetic message, which would be fed back to the model
   *  as if the user had said it. */
  restoredAt: string | null;
  /** Backend assessment for a command that still requires a real click. */
  pendingProposal: {
    approvalId: string;
    command: string;
    explanation: string;
    readOnly: boolean;
    network: boolean;
    outputPolicy: OutputPolicy;
    assessment?: import("../lib/types").CommandAssessment;
    askReason?: string;
    targetRole?: AgentTargetRole;
    targetSessionId?: string;
  } | null;
  pendingMcpProposal: {
    approvalId: string;
    serverId: string;
    serverName: string;
    toolName: string;
    title?: string;
    description?: string;
    arguments: unknown;
    schemaHash: string;
  } | null;
  /** Snapshot of global defaults when this conversation was created. */
  mcpSelection: McpChatSelection;
  /** How much this agent run may do without asking. Per-session, never
   *  persisted, never inherited — see `restoreAiTranscript` and
   *  `newAiConversation`. Widened from a boolean `autoAccept`; the safety
   *  property is unchanged, a fresh tab is still never pre-armed. */
  permissionMode: PermissionMode;
  /** Set when the run stopped at a guard rail instead of finishing.
   *
   *  Deliberately separate from `lastError`: the transcript is intact,
   *  tool-pair-complete and already resumable, so this renders as a calm banner
   *  with a Continue button rather than the red error line. Cleared by
   *  `initAiStream`, which the Continue itself goes through.
   *
   *  Not a synthetic transcript message and not archived, for the same reason
   *  `restoredAt` is neither — and a restored Continue button would offer to
   *  dispatch a run against a transcript the user has not looked at. */
  pause: {
    reason: "step_limit" | "context_limit";
    steps: number;
    limit: number;
  } | null;
  /** Steering messages typed mid-run that the backend has NOT yet confirmed
   *  delivering. Only StreamEvent::SteerDelivered removes an entry, so anything
   *  left here is something the model never saw. */
  steerQueue: { id: string; text: string }[];
  attachedBlockIds: string[];
  /** Document buckets attached to this session.
   *
   *  Standing context like `attachedBlockIds`, not per-message like
   *  `pendingAttachments`: a bucket stays attached across every turn until the user
   *  detaches it, and an EMPTY list is what stops the run being offered `search_docs`
   *  at all.
   *
   *  In-memory and never persisted, so a reopened session starts with nothing attached
   *  — `restoreAiTranscript` runs on a session `createSession` just made, so there is
   *  nothing to carry over and nothing to reset. `newAiConversation` clears it along
   *  with everything else by spreading `emptyAiStream()`.
   *
   *  Worth being clear about how this differs from `permissionMode`, since both are
   *  per-session and both change what a run can do. Arming a permission mode decides
   *  which commands skip a human; attaching a bucket grants a lookup tool and no
   *  authority whatsoever — every command the model proposes still goes through the
   *  same approval path, whatever it read. That is why this needs no equivalent of the
   *  "must not arrive pre-armed" rule. */
  attachedBucketIds: string[];
  /** Source-qualified successor to `attachedBucketIds`. The legacy list is kept in
   * sync for local buckets while older backends remain supported; all new retrieval
   * and rendering code reads this list. */
  attachedBucketRefs: KnowledgeBucketRef[];
  /** Files staged for the NEXT turn.
   *
   *  Deliberately unlike `attachedBlockIds`: a block is standing context and
   *  survives every turn, an attachment belongs to one message. Consumed in the
   *  send path once it has been stamped onto the user `AiMessage` — never in
   *  `initAiStream`, so a send that fails to start does not eat the files. */
  pendingAttachments: Attachment[];
  /** Why the last attach was refused, for a line under the chip strip. Kept out
   *  of `lastError`, which is the RUN's error and renders in the message list. */
  attachError: string | null;
  /** Progress while an attach is doing slow work — reading a scanned PDF page by
   *  page on-device is seconds of otherwise-silent time after a drop. Separate from
   *  `attachError` deliberately: that field is styled as an error and its
   *  clear-then-set ordering is load-bearing. */
  attachStatus: string | null;
  /** Non-fatal retrieval failure. The answer still streams, but the user can
   * see that only some (or none) of the attached knowledge sources contributed. */
  knowledgeWarning: string | null;
  lastError: string | null;
}

export interface DownloadProgress {
  /** Stable UI owner. Repository/filename are display metadata and are not
   * unique: two catalog entries may legitimately share either. */
  kind: "chat" | "vision";
  modelId: string;
  repoId: string;
  filename: string;
  downloaded: number;
  total: number | null;
  bps: number;
}

const MAX_BLOCKS_PER_SESSION = 200;

const attachLimitMessage = (dropped: number) =>
  S.attachments.limit(dropped, MAX_ATTACHMENTS);

export function emptySessionUi(): SessionUiState {
  return {
    blocks: [],
    runningBlockId: null,
    cwd: null,
    gitBranch: null,
    phase: "idle",
    remote: null,
    nestedBlockId: null,
    remoteHost: null,
    host: null,
    longRunningCommand: null,
    integrationActive: false,
    searchOpen: false,
    composerOpen: false,
    composerStatus: "idle",
    composerProposal: null,
    composerError: null,
    composerRequestId: null,
  };
}

export function emptyAiStream(): AiStreamState {
  return {
    mode: "ask",
    status: "idle",
    requestId: null,
    generationId: null,
    messages: [],
    streamingContent: "",
    thinkingContent: "",
    model: null,
    modelTranscript: [],
    restoredAt: null,
    pendingProposal: null,
    pendingMcpProposal: null,
    mcpSelection: { server_ids: [], disabled_tools: {} },
    permissionMode: "ask",
    pause: null,
    steerQueue: [],
    attachedBlockIds: [],
    attachedBucketIds: [],
    attachedBucketRefs: [],
    pendingAttachments: [],
    attachError: null,
    attachStatus: null,
    knowledgeWarning: null,
    lastError: null,
  };
}

export interface AppState {
  // Sessions / tabs
  sessions: Session[];
  activeSessionId: string | null;
  sessionUi: Record<string, SessionUiState>;
  /** Live, conversation-scoped terminal pairings. In-memory only: settings and
   *  workspace persistence map explicit fields and never serialize this map. */
  sidecars: Record<string, SidecarBinding>;
  /** Either member resolves to the transcript-owning session. */
  resolveAiOwner(sessionId: string): string;
  sidecarForSession(sessionId: string): SidecarBinding | null;
  sidecarHealth(sessionId: string): SidecarHealth | null;
  startSidecar(
    ownerSessionId: string,
    localSessionId: string,
    remoteSessionId: string,
    remoteIdentity: SidecarRemoteIdentity,
  ): SidecarStartResult;
  endSidecar(sessionId: string): void;
  swapSidecarPanes(sessionId: string): void;
  setSidecarRatio(sessionId: string, ratio: number): void;
  setSidecarOrientation(
    sessionId: string,
    orientation: SidecarSplitOrientation,
  ): void;
  setSidecarFocusedSession(sessionId: string, focusedSessionId: string): void;
  setSidecarPermission(
    sessionId: string,
    role: AgentTargetRole,
    mode: PermissionMode,
  ): void;
  replaceSidecarTarget(
    sessionId: string,
    role: AgentTargetRole,
    replacementSessionId: string,
    remoteIdentity?: SidecarRemoteIdentity,
  ): SidecarStartResult;
  markSidecarDegraded(sessionId: string, degradation: SidecarDegradation): void;
  /** Re-evaluate session/SSH identity after state changes. This never clears a
   *  sticky degradation; Replace is the explicit recovery path. */
  refreshSidecarHealth(sessionId: string): SidecarHealth | null;
  /** `activate: false` during a multi-tab restore — otherwise every restored
   *  tab momentarily becomes active and acquires/releases a WebGL context. */
  addSession(s: Session, activate?: boolean): void;
  removeSession(id: string): void;
  setActiveSession(id: string): void;
  /** Apply a saved tab order. Unknown ids are ignored; sessions omitted from
   *  `ids` keep their relative order at the end, so a partially-failed restore
   *  can never drop a tab. */
  reorderSessions(ids: string[]): void;
  updateSession(id: string, u: Partial<Session>): void;
  updateSessionUi(id: string, u: Partial<SessionUiState>): void;

  // Blocks (driven by BlockTracker callbacks)
  startBlock(sessionId: string, block: Block): void;
  finishBlock(
    sessionId: string,
    blockId: string,
    exitCode: number,
    endLine: number | null,
  ): void;
  trimBlock(sessionId: string, blockId: string): void;
  markBlockOrigin(
    sessionId: string,
    blockId: string,
    origin: Block["origin"],
  ): void;

  // AI panel. `aiPanelOpen`/`aiPanelRatio` are part of the persisted settings
  // mirror below — prefer lib/aiPanel.ts over these raw setters, so the change
  // is written through to settings.json instead of being lost on quit.
  aiPanelOpen: boolean;
  setAiPanelOpen(open: boolean): void;
  /** A SHARE of the window, not pixels — see lib/aiPanel.ts. */
  aiPanelRatio: number;
  setAiPanelRatio(ratio: number): void;
  aiStreams: Record<string, AiStreamState>;
  initAiStream(sessionId: string, mode: AiMode, requestId: string): void;
  pushAiMessage(sessionId: string, msg: AiMessage): void;
  appendAiDelta(sessionId: string, content: string): void;
  appendThinking(sessionId: string, content: string): void;
  setPendingProposal(
    sessionId: string,
    proposal: AiStreamState["pendingProposal"],
    status?: AiStreamState["status"],
  ): void;
  setPendingMcpProposal(
    sessionId: string,
    proposal: AiStreamState["pendingMcpProposal"],
  ): void;
  setMcpSelection(sessionId: string, selection: McpChatSelection): void;
  beginMcpTool(
    sessionId: string,
    approvalId: string,
    serverId: string,
    serverName: string,
    toolName: string,
    args: unknown,
  ): void;
  finishMcpTool(
    sessionId: string,
    approvalId: string,
    result: McpToolResultView | undefined,
    error?: string,
  ): void;
  setPermissionMode(sessionId: string, mode: PermissionMode): void;
  noteBlockedCommand(
    sessionId: string,
    command: string,
    note: string,
    target?: CommandTargetMeta,
  ): void;
  /** Record a message typed mid-run, pending backend confirmation. */
  queueSteer(sessionId: string, id: string, text: string): void;
  /** The loop appended these — clear their badges and drop them from the queue. */
  markSteersDelivered(sessionId: string, ids: string[]): void;
  /** The backend refused this one (run already over, too long, too many). */
  markSteerUndelivered(sessionId: string, id: string): void;
  /** Flush streamed text (+ thinking) into a message; used at command boundaries too. */
  flushAiStreaming(sessionId: string): void;
  beginCommand(
    sessionId: string,
    approvalId: string,
    command: string,
    explanation?: string,
    target?: CommandTargetMeta,
    outputPolicy?: OutputPolicy,
  ): void;
  appendCommandOutput(
    sessionId: string,
    approvalId: string,
    chunk: string,
  ): void;
  /** REPLACE the card's output. The PTY path re-reads the live terminal tail
   *  instead of receiving incremental chunks, so appending would duplicate. */
  setCommandOutput(sessionId: string, approvalId: string, output: string): void;
  /** Live hang classification for a running command; null clears it. */
  setCommandStall(
    sessionId: string,
    approvalId: string,
    stall: CommandStall | null,
  ): void;
  /** The line actually typed, when hardening changed it from the approved one. */
  setCommandTyped(sessionId: string, approvalId: string, typed: string): void;
  finishCommand(
    sessionId: string,
    approvalId: string,
    exitCode: number | null,
    status?: SettledCommandStatus,
    note?: string,
    durationMs?: number,
  ): void;
  finishAiStream(
    sessionId: string,
    error?: string,
    usage?: { prompt: number; completion: number },
    generationId?: string,
  ): void;
  /** Retire every continuation for the current run. */
  fenceAiGeneration(sessionId: string): void;
  /** Settle a run that stopped at a guard rail rather than finishing. Leaves
   *  `lastError` null and the transcript resumable — see `AiStreamState.pause`. */
  pauseAiStream(
    sessionId: string,
    pause: NonNullable<AiStreamState["pause"]>,
    usage?: { prompt: number; completion: number },
    generationId?: string,
  ): void;
  /** Record which model is serving the in-flight request. */
  setAiStreamModel(sessionId: string, model: string): void;
  /** Store the transcript an agent turn produced, to hand back on the next one.
   *  Replaces wholesale: the returned array already contains the prior turns. */
  setModelTranscript(sessionId: string, transcript: ChatMessage[]): void;
  /** Accept the agent promise result only while this generation still owns the session. */
  setModelTranscriptForGeneration(
    sessionId: string,
    generationId: string,
    transcript: ChatMessage[],
  ): void;
  /** Hydrate a reopened session's panel from the archive.
   *
   *  ONE action rather than N pushAiMessage calls: fifty messages would be fifty
   *  set()s and fifty renders of a conversation assembling itself in front of the
   *  user. Must be called AFTER the session exists — withAiStream no-ops for an
   *  unknown id, which would drop the whole transcript in silence. */
  restoreAiTranscript(
    sessionId: string,
    messages: AiMessage[],
    modelTranscript: ChatMessage[],
    capturedAt: string,
    mcpSelection?: McpChatSelection | null,
  ): void;
  /** Start a fresh conversation in a tab that stays open.
   *
   *  Clears the panel AND `modelTranscript` — both halves, or ask mode forgets
   *  while agent mode keeps replaying the old run. The caller is responsible for
   *  preserving the outgoing conversation first (`lib/newChat.ts` archives it);
   *  this action itself is a pure wipe. */
  newAiConversation(sessionId: string): void;
  attachBlockToAi(sessionId: string, blockId: string): void;
  detachBlockFromAi(sessionId: string, blockId: string): void;
  attachBucketToAi(
    sessionId: string,
    bucket: string | KnowledgeBucketRef,
  ): void;
  detachBucketFromAi(
    sessionId: string,
    bucket: string | KnowledgeBucketRef,
  ): void;
  /** Stage files for the next turn, return the accepted subset, and set
   *  `attachError` when the limit drops any — silently dropping is worse. */
  attachFilesToAi(sessionId: string, attachments: Attachment[]): Attachment[];
  detachFileFromAi(sessionId: string, attachmentId: string): void;
  /** Called by the send path AFTER the files are on the outgoing message. */
  clearPendingAttachments(sessionId: string): void;
  setAttachError(sessionId: string, message: string | null): void;
  setAttachStatus(sessionId: string, message: string | null): void;
  setKnowledgeWarning(sessionId: string, message: string | null): void;
  /** Fill in the bytes of an already-sent attachment, read back off disk after a
   *  reopen. Addressed by message + attachment id rather than by index because
   *  the transcript can grow while the reads are in flight. */
  setAttachmentData(
    sessionId: string,
    messageId: string,
    attachmentId: string,
    data: string,
  ): void;
  setAiMode(sessionId: string, mode: AiMode): void;

  // Global MCP configuration cache. Secrets never cross this boundary.
  mcpServers: McpServerView[];
  setMcpServers(servers: McpServerView[]): void;

  // UI chrome
  /** Tab whose label is currently being edited inline. Lives here rather than
   *  in TabStrip's local state so the command palette and the tab context menu
   *  can both open the editor. */
  renamingSessionId: string | null;
  setRenamingSession(id: string | null): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  /** Past-session browser. Transient like the palette, deliberately NOT part of
   *  the persisted settings mirror: reopening a modal over the user's terminals
   *  at boot is not a preference anyone holds. */
  sessionBrowserOpen: boolean;
  setSessionBrowserOpen(open: boolean): void;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  settingsTab: SettingsTab;
  setSettingsTab(tab: SettingsTab): void;
  activeRenderer: "webgl" | "dom";
  setActiveRenderer(r: "webgl" | "dom"): void;
  termDims: { cols: number; rows: number };
  setTermDims(cols: number, rows: number): void;

  // Settings mirror (persisted via Rust; no localStorage)
  settingsLoaded: boolean;
  theme: string;
  fontSize: number;
  scrollbackLines: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  copyOnSelect: boolean;
  shellPath: string | null;
  shellIntegrationEnabled: boolean;
  temperature: number;
  activeModelId: string;
  /** Presence only. The Hugging Face token is never held frontend-side. */
  hasHfToken: boolean;
  credentialStoreStatus: "ready" | "blocked";
  historyEnabled: boolean;
  historyCaptureOutput: boolean;
  sendContextToAi: boolean;
  aiSessionNaming: boolean;
  restoreSessionsOnStart: boolean;
  /** 0 = restore tabs and directories but capture no terminal output. */
  restoreScrollbackLines: number;
  archiveEnabled: boolean;
  archiveMaxSessions: number;
  /** No zero: for an age limit 0 would have to mean "unlimited", the opposite of
   *  what it means for restoreScrollbackLines. Rust clamps it to >= 1. */
  archiveMaxAgeDays: number;
  autoLoadModelOnStart: boolean;
  // The on-device vision sidecar. Separate from the chat-model state throughout:
  // it is a SECOND resident model, and conflating the two is how "which one is
  // loaded" becomes unanswerable.
  visionModelId: string | null;
  visionPrompt: string | null;
  visionAutoLoadOnStart: boolean;
  agentMaxIterations: number;
  agentCommandTimeoutSecs: number;
  agentCommandPolicyRules: import("../lib/types").CommandPolicyRule[];
  aiWebAccess: boolean;
  /** Standing instructions appended to the system prompt. Mirrors only — the
   *  composition, the cap and the framing all live in Rust
   *  (`agent::instructions`), so editing these frontend-side changes what the
   *  Settings screen shows and nothing about what a model receives. */
  customInstructions: string;
  agentCustomInstructions: string;
  chatCustomInstructions: string;
  autoUpdateEnabled: boolean;
  /** Document buckets, EXPERIMENTAL. A mirror of the setting for rendering only —
   *  the capability itself is gated in Rust, which withholds the `search_docs`
   *  tool and refuses every `docs_*` command while it is false. Flipping this
   *  frontend-side therefore reveals UI, never a capability. */
  docsEnabled: boolean;
  /** Experimental Runbooks capability mirror. Enforcement lives in Rust. */
  runbooksEnabled: boolean;
  /** Retention FLOOR for runbook terminal output. Preflight may raise a single
   *  run above it; `runbooks_start` re-clamps, so this mirror only shapes the
   *  choices offered and never decides what is actually kept. */
  runbooksOutputRecording: EvidenceRecordingPolicy;
  /** The bucket list, refreshed from Rust. Global rather than per-session: a bucket
   *  exists once and is attached by reference. */
  docBuckets: DocBucket[];
  /** Local and remote buckets returned by the unified knowledge service. */
  knowledgeBuckets: KnowledgeBucketDescriptor[];
  /** Progress of an in-flight indexing pass, keyed by bucket id. Absent means idle.
   *  `cancel` flips to true to stop the loop between files — never mid-file, so a
   *  cancelled pass leaves no half-written bucket. */
  docsIndexing: Record<
    string,
    { done: number; total: number; current: string | null; cancel: boolean }
  >;
  docsError: string | null;
  setDocBuckets(buckets: DocBucket[]): void;
  setKnowledgeBuckets(buckets: KnowledgeBucketDescriptor[]): void;
  setDocsIndexing(
    bucketId: string,
    progress: { done: number; total: number; current: string | null } | null,
  ): void;
  cancelDocsIndexing(bucketId: string): void;
  setDocsError(message: string | null): void;
  hydrateSettings(patch: Partial<AppState>): void;
  setTheme(theme: string): void;
  setFontSize(px: number): void;

  // Models
  visionCatalog: VisionCatalogEntry[];
  setVisionCatalog(entries: VisionCatalogEntry[]): void;
  visionLoadedModelId: string | null;
  visionState: ModelState;
  visionAcceleration: LocalAccelerationInfo | null;
  setVisionStatus(
    loaded: string | null,
    state: ModelState,
    acceleration?: LocalAccelerationInfo | null,
  ): void;
  visionLoadError: string | null;
  setVisionLoadError(message: string | null): void;
  localModels: LocalModel[];
  setLocalModels(m: LocalModel[]): void;
  loadedModelId: string | null;
  modelState: ModelState;
  /** Whether THIS BUILD carries the on-device engine (`--features local-llm`).
   *  Tri-state on purpose: null until `model_status` has answered. A build that
   *  does have the engine is indistinguishable from one that does not until
   *  then, so treating the initial value as "missing" would flash "no on-device
   *  engine" over the model list on every local-llm launch. */
  modelAvailable: boolean | null;
  localAcceleration: LocalAccelerationInfo | null;
  modelLoadError: string | null;
  setModelStatus(
    loaded: string | null,
    state: ModelState,
    available: boolean,
    acceleration?: LocalAccelerationInfo,
  ): void;
  setModelLoadError(message: string | null): void;
  /** True only once the backend has CONFIRMED this build has no on-device
   *  engine. Every local-only affordance (download, load, select) is dead in
   *  that build — `model_load` is a stub that only errors — so the UI has to
   *  stop offering them rather than let the error be how you find out. */
  localEngineMissing(): boolean;
  /** The allowlist, as returned by models_catalog. */
  catalog: CatalogEntry[];
  setCatalog(c: CatalogEntry[]): void;
  /** Per-model effort, kept in sync with the backend map. */
  modelEffort: Record<string, Effort>;
  setModelEffortLocal(modelId: string, effort: Effort): void;
  setModelEffortMap(m: Record<string, Effort>): void;
  /** Presence of each provider's API key (never the key itself). */
  hasApiKey: Record<string, boolean>;
  setHasApiKey(provider: string, present: boolean): void;
  downloads: Record<string, DownloadProgress>;
  updateDownload(id: string, p: DownloadProgress): void;
  clearDownload(id: string): void;
  downloadErrors: Record<string, string>;
  setDownloadError(
    kind: DownloadProgress["kind"],
    modelId: string,
    message: string | null,
  ): void;

  /** Whether the SELECTED model can answer right now.
   *  `modelState` alone is NOT this: it tracks the on-device ModelHost only, so
   *  it is permanently "idle" for an API model and gating on it disables the
   *  whole AI surface for anyone using one. */
  aiReady(): boolean;
  /** Why it can't answer, for the empty state. null when it can. "engine" is
   *  the unfixable one: no amount of loading or key-entering helps, the build
   *  itself has no local engine — only switching to an API model does. */
  aiBlockedReason(): "load" | "key" | "engine" | null;
  /** WHICH model will actually read an attached image.
   *
   *  One definition, three consumers (the header chip, the panel's notice, and
   *  `attachInput.ocrAvailable`) — the same "these must agree" discipline
   *  `lib/selectModel.ts` exists to enforce for the chat model.
   *
   *  `native` = the chat model reads images itself, so there is no second model to
   *  name. `sidecar` = a blind chat model plus a loaded on-device reader, the only
   *  case where two models serve one conversation. `none` = images cannot be read
   *  at all; the panel says so when one is attached (the header deliberately does
   *  not, since it would be noise for anyone who never attaches one). */
  imageReader(): { kind: "native" | "sidecar" | "none"; label: string | null };

  // AI streaming indicator (any session)
  anyAiStreaming(): boolean;
}

/** Fold streamed text + thinking into a finished assistant message. */
function flushStreaming(
  s: AiStreamState,
  usage?: { prompt: number; completion: number },
): AiStreamState {
  if (!s.streamingContent && !s.thinkingContent) return s;
  const messages = [
    ...s.messages,
    {
      id: `msg-${Date.now()}-${s.messages.length}`,
      role: "assistant" as const,
      content: s.streamingContent,
      createdAt: new Date().toISOString(),
      ...(s.thinkingContent ? { thinking: s.thinkingContent } : {}),
      // Stamped at flush, not read from settings at render: the model can be
      // switched while this very reply is still streaming.
      ...(s.model ? { model: s.model } : {}),
      ...(usage ? { usage } : {}),
    },
  ];
  return { ...s, messages, streamingContent: "", thinkingContent: "" };
}

// Both helpers no-op for unknown session ids: stream callbacks arriving after
// a tab was closed must not auto-vivify ghost entries for dead sessions.
function withSessionUi(
  state: AppState,
  sessionId: string,
  updater: (ui: SessionUiState) => SessionUiState,
): Partial<Pick<AppState, "sessionUi">> {
  if (!state.sessions.some((s) => s.id === sessionId)) return {};
  const current = state.sessionUi[sessionId] ?? emptySessionUi();
  return { sessionUi: { ...state.sessionUi, [sessionId]: updater(current) } };
}

function withAiStream(
  state: AppState,
  sessionId: string,
  updater: (s: AiStreamState) => AiStreamState,
): Partial<Pick<AppState, "aiStreams">> {
  if (!state.sessions.some((s) => s.id === sessionId)) return {};
  const current = state.aiStreams[sessionId] ?? emptyAiStream();
  return { aiStreams: { ...state.aiStreams, [sessionId]: updater(current) } };
}

/** Merge fields into one command card, addressed by its approval id. */
function patchCommand(
  state: AppState,
  sessionId: string,
  approvalId: string,
  patch: Partial<NonNullable<AiMessage["command"]>>,
): Partial<Pick<AppState, "aiStreams">> {
  return withAiStream(state, sessionId, (s) => ({
    ...s,
    messages: s.messages.map((m) =>
      m.id === `cmd-${approvalId}` && m.command
        ? { ...m, command: { ...m.command, ...patch } }
        : m,
    ),
  }));
}

/** A run may end without a PTY result after cancellation, shutdown, or a lost
 *  frontend callback. Never turn that uncertainty into a successful command. */
function settleOrphanedCommands(messages: AiMessage[]): AiMessage[] {
  return messages.map((message) =>
    message.command?.status === "running"
      ? {
          ...message,
          command: {
            ...message.command,
            status: "timeout" as const,
            note: message.command.note?.includes("Completion unknown")
              ? message.command.note
              : message.command.note
                ? `${message.command.note} ${S.aiPanel.orphanedCommand}`
                : S.aiPanel.orphanedCommand,
            stall: undefined,
          },
        }
      : message,
  );
}

function settleFencedMessages(messages: AiMessage[]): AiMessage[] {
  return settleOrphanedCommands(
    messages.map((message) =>
      message.steer === "queued"
        ? { ...message, steer: "undelivered" as const }
        : message,
    ),
  );
}

function reconcileSidecars(
  sidecars: Record<string, SidecarBinding>,
  sessions: Session[],
  sessionUi: Record<string, SessionUiState>,
): Record<string, SidecarBinding> {
  let changed = false;
  const next: Array<[string, SidecarBinding]> = [];
  for (const [owner, binding] of Object.entries(sidecars)) {
    // Degradation is sticky. Reconnect/replacement needs explicit review before
    // either target can execute again.
    if (binding.degraded) {
      next.push([owner, binding]);
      continue;
    }
    const health = inspectCurrentSidecarHealth(binding, {
      sessions,
      sessionUi,
    });
    if (health.degradation) {
      next.push([owner, { ...binding, degraded: health.degradation }]);
      changed = true;
    } else {
      next.push([owner, binding]);
    }
  }
  return changed ? Object.fromEntries(next) : sidecars;
}

function withoutSidecarForSession(
  sidecars: Record<string, SidecarBinding>,
  sessionId: string,
): Record<string, SidecarBinding> {
  const binding = findSidecarForSession(sidecars, sessionId);
  if (!binding) return sidecars;
  return withoutRecordKey(sidecars, binding.ownerSessionId);
}

function permissionReset(
  aiStreams: Record<string, AiStreamState>,
  ownerSessionId: string,
): Record<string, AiStreamState> {
  const stream = ownRecordValue(aiStreams, ownerSessionId);
  if (!stream || stream.permissionMode === "ask") {
    return aiStreams;
  }
  return withRecordValue<AiStreamState>(aiStreams, ownerSessionId, {
    ...stream,
    permissionMode: "ask",
  });
}

function defaultMcpSelection(servers: McpServerView[]): McpChatSelection {
  return {
    server_ids: servers
      .filter((server) => server.enabled && server.default_for_new_chats)
      .map((server) => server.id),
    disabled_tools: {},
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sessionUi: {},
  sidecars: {},
  mcpServers: [],

  // Defaults are snapshots taken by addSession/newAiConversation. A settings
  // refresh must never reinterpret an intentionally empty existing selection.
  setMcpServers: (servers) => set({ mcpServers: servers }),

  resolveAiOwner: (sessionId) =>
    resolveSidecarAiOwner(get().sidecars, sessionId),

  sidecarForSession: (sessionId) =>
    findSidecarForSession(get().sidecars, sessionId),

  sidecarHealth: (sessionId) => {
    const state = get();
    const binding = findSidecarForSession(state.sidecars, sessionId);
    if (!binding) return null;
    if (binding.degraded)
      return { status: "degraded", degradation: binding.degraded };
    return inspectCurrentSidecarHealth(binding, state);
  },

  startSidecar: (
    ownerSessionId,
    localSessionId,
    remoteSessionId,
    remoteIdentity,
  ) => {
    const state = get();
    const result = createSidecarBinding(
      state,
      state.sidecars,
      ownerSessionId,
      localSessionId,
      remoteSessionId,
      remoteIdentity,
    );
    if (!result.ok) return result;
    set((current) => ({
      sidecars: {
        ...current.sidecars,
        [result.binding.ownerSessionId]: result.binding,
      },
      // A previous single-terminal mode must not leak authority into a newly
      // linked conversation. The companion stream remains untouched.
      aiStreams: permissionReset(
        current.aiStreams,
        result.binding.ownerSessionId,
      ),
    }));
    return result;
  },

  endSidecar: (sessionId) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding) return {};
      return {
        sidecars: withoutSidecarForSession(state.sidecars, sessionId),
        aiStreams: permissionReset(state.aiStreams, binding.ownerSessionId),
      };
    }),

  swapSidecarPanes: (sessionId) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding) return {};
      const [first, second] = binding.paneOrder;
      return {
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: {
            ...binding,
            paneOrder: [second, first] as const,
          },
        },
      };
    }),

  setSidecarRatio: (sessionId, ratio) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding) return {};
      return {
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: {
            ...binding,
            splitRatio: clampSidecarRatio(ratio),
          },
        },
      };
    }),

  setSidecarOrientation: (sessionId, splitOrientation) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding) return {};
      return {
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: { ...binding, splitOrientation },
        },
      };
    }),

  setSidecarFocusedSession: (sessionId, focusedSessionId) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding || !roleForSession(binding, focusedSessionId)) return {};
      return {
        activeSessionId: focusedSessionId,
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: { ...binding, focusedSessionId },
        },
      };
    }),

  setSidecarPermission: (sessionId, role, mode) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding || binding.degraded) return {};
      return {
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: {
            ...binding,
            permissions: { ...binding.permissions, [role]: mode },
          },
        },
      };
    }),

  replaceSidecarTarget: (
    sessionId,
    role,
    replacementSessionId,
    remoteIdentity,
  ) => {
    const state = get();
    const binding = findSidecarForSession(state.sidecars, sessionId);
    if (!binding)
      return {
        ok: false,
        reason: "This terminal does not belong to a sidecar.",
      };

    const currentTarget = sessionIdForRole(binding, role);
    if (
      currentTarget === binding.ownerSessionId &&
      replacementSessionId !== currentTarget
    ) {
      return {
        ok: false,
        reason:
          "The transcript-owning target cannot be replaced. End the sidecar and start it from the new terminal.",
      };
    }
    if (
      replacementSessionId ===
      sessionIdForRole(binding, role === "local" ? "remote" : "local")
    ) {
      return { ok: false, reason: "Choose two different terminals." };
    }
    const occupied = findSidecarForSession(
      state.sidecars,
      replacementSessionId,
    );
    if (occupied && occupied.ownerSessionId !== binding.ownerSessionId) {
      return {
        ok: false,
        reason: "That terminal already belongs to another sidecar.",
      };
    }

    const eligible = validateSidecarTarget(state, replacementSessionId, role);
    if (!eligible.ok) return eligible;

    let nextIdentity = binding.remoteIdentity;
    if (role === "remote") {
      const liveIdentity = captureSidecarRemoteIdentity(
        state.sessions.find((session) => session.id === replacementSessionId),
        ownRecordValue(state.sessionUi, replacementSessionId),
      );
      if (
        !liveIdentity ||
        (remoteIdentity && !sameRemoteIdentity(liveIdentity, remoteIdentity))
      ) {
        return {
          ok: false,
          reason: "The replacement SSH identity could not be verified.",
        };
      }
      nextIdentity = liveIdentity;
    }

    const replacement: SidecarBinding = {
      ...binding,
      localSessionId:
        role === "local" ? replacementSessionId : binding.localSessionId,
      remoteSessionId:
        role === "remote" ? replacementSessionId : binding.remoteSessionId,
      remoteIdentity: nextIdentity,
      focusedSessionId:
        binding.focusedSessionId === currentTarget
          ? replacementSessionId
          : binding.focusedSessionId,
      permissions: { local: "ask", remote: "ask" },
      degraded: null,
    };
    set((current) => ({
      sidecars: { ...current.sidecars, [binding.ownerSessionId]: replacement },
      aiStreams: permissionReset(current.aiStreams, binding.ownerSessionId),
    }));
    return { ok: true, binding: replacement };
  },

  markSidecarDegraded: (sessionId, degradation) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, sessionId);
      if (!binding || binding.degraded) return {};
      return {
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: { ...binding, degraded: degradation },
        },
      };
    }),

  refreshSidecarHealth: (sessionId) => {
    const state = get();
    const binding = findSidecarForSession(state.sidecars, sessionId);
    if (!binding) return null;
    if (binding.degraded)
      return { status: "degraded", degradation: binding.degraded };
    const health = inspectCurrentSidecarHealth(binding, state);
    if (health.degradation) {
      set((current) => ({
        sidecars: {
          ...current.sidecars,
          [binding.ownerSessionId]: {
            ...binding,
            degraded: health.degradation,
          },
        },
      }));
    }
    return health;
  },

  addSession: (s, activate = true) =>
    set((state) => {
      const stream = emptyAiStream();
      if (!s.archivedFrom)
        stream.mcpSelection = defaultMcpSelection(state.mcpServers);
      return {
        sessions: [...state.sessions, s],
        activeSessionId: activate ? s.id : (state.activeSessionId ?? s.id),
        sessionUi: { ...state.sessionUi, [s.id]: emptySessionUi() },
        aiStreams: { ...state.aiStreams, [s.id]: stream },
      };
    }),

  reorderSessions: (ids) =>
    set((state) => {
      const byId = new Map(state.sessions.map((s) => [s.id, s]));
      const ordered: Session[] = [];
      for (const id of ids) {
        const s = byId.get(id);
        if (s) {
          ordered.push(s);
          byId.delete(id);
        }
      }
      // Anything not named keeps its relative order at the end.
      for (const s of state.sessions) if (byId.has(s.id)) ordered.push(s);
      return { sessions: ordered };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const { [id]: _ui, ...sessionUi } = state.sessionUi;
      const { [id]: _ai, ...aiStreams } = state.aiStreams;
      const binding = findSidecarForSession(state.sidecars, id);
      let sidecars = state.sidecars;
      if (binding?.ownerSessionId === id) {
        sidecars = withoutSidecarForSession(sidecars, id);
      } else if (binding) {
        sidecars = {
          ...sidecars,
          [binding.ownerSessionId]: {
            ...binding,
            focusedSessionId: binding.ownerSessionId,
            degraded: binding.degraded ?? {
              role: roleForSession(binding, id) ?? "remote",
              reason: "session_missing",
            },
          },
        };
      }
      let activeSessionId = state.activeSessionId;
      if (activeSessionId === id) {
        const idx = state.sessions.findIndex((s) => s.id === id);
        activeSessionId =
          sessions[Math.min(idx, sessions.length - 1)]?.id ?? null;
      }
      return {
        sessions,
        sessionUi,
        aiStreams,
        sidecars,
        activeSessionId,
        // A closed tab must not leave the rename editor open over its neighbour.
        renamingSessionId:
          state.renamingSessionId === id ? null : state.renamingSessionId,
      };
    }),

  setActiveSession: (id) =>
    set((state) => {
      const binding = findSidecarForSession(state.sidecars, id);
      if (!binding || !roleForSession(binding, id))
        return { activeSessionId: id };
      return {
        activeSessionId: id,
        sidecars: {
          ...state.sidecars,
          [binding.ownerSessionId]: { ...binding, focusedSessionId: id },
        },
      };
    }),

  updateSession: (id, u) =>
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === id ? { ...s, ...u } : s,
      );
      return {
        sessions,
        sidecars: reconcileSidecars(state.sidecars, sessions, state.sessionUi),
      };
    }),

  updateSessionUi: (id, u) =>
    set((state) => {
      const patch = withSessionUi(state, id, (ui) => ({ ...ui, ...u }));
      if (!patch.sessionUi) return patch;
      return {
        ...patch,
        sidecars: reconcileSidecars(
          state.sidecars,
          state.sessions,
          patch.sessionUi,
        ),
      };
    }),

  startBlock: (sessionId, block) =>
    set((state) =>
      withSessionUi(state, sessionId, (ui) => {
        let blocks = [...ui.blocks, block];
        if (blocks.length > MAX_BLOCKS_PER_SESSION)
          blocks = blocks.slice(-MAX_BLOCKS_PER_SESSION);
        return { ...ui, blocks, runningBlockId: block.id };
      }),
    ),

  finishBlock: (sessionId, blockId, exitCode, endLine) =>
    set((state) =>
      withSessionUi(state, sessionId, (ui) => ({
        ...ui,
        blocks: ui.blocks.map((b) =>
          b.id === blockId
            ? {
                ...b,
                state: "done" as const,
                exitCode,
                endLine,
                endedAt: new Date().toISOString(),
              }
            : b,
        ),
        runningBlockId:
          ui.runningBlockId === blockId ? null : ui.runningBlockId,
      })),
    ),

  trimBlock: (sessionId, blockId) =>
    set((state) =>
      withSessionUi(state, sessionId, (ui) => ({
        ...ui,
        blocks: ui.blocks.map((b) =>
          b.id === blockId ? { ...b, state: "trimmed" as const } : b,
        ),
      })),
    ),

  markBlockOrigin: (sessionId, blockId, origin) =>
    set((state) =>
      withSessionUi(state, sessionId, (ui) => ({
        ...ui,
        blocks: ui.blocks.map((b) => (b.id === blockId ? { ...b, origin } : b)),
      })),
    ),

  // Must match the Rust inline defaults in commands/settings.rs — this is what
  // renders in the window between mount and hydrateSettings.
  aiPanelOpen: true,
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  // No Rust counterpart: the stored ratio is unset until the first drag, and
  // `useSettings` derives it from the legacy `ai_panel_width` (420) over the
  // current window. The default is that same 420px at ~1400px.
  aiPanelRatio: PANEL_DEFAULT_RATIO,
  setAiPanelRatio: (ratio) => set({ aiPanelRatio: clampPanelRatio(ratio) }),
  aiStreams: {},

  initAiStream: (sessionId, mode, requestId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        mode,
        status: "streaming",
        requestId,
        generationId: requestId,
        streamingContent: "",
        thinkingContent: "",
        // Cleared per request: Started will name the model actually serving it.
        model: null,
        pendingProposal: null,
        // A previous run's leftovers belong to that run — the new one has its own
        // mailbox on the backend and would never be handed them.
        steerQueue: [],
        lastError: null,
        // Clearing this is what retires the Continue button, and it matters that
        // it happens HERE: the Continue path dispatches through initAiStream, so
        // a second click cannot resume the same pause twice.
        pause: null,
      })),
    ),

  setAiStreamModel: (sessionId, model) =>
    set((state) => withAiStream(state, sessionId, (s) => ({ ...s, model }))),

  setModelTranscript: (sessionId, transcript) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        modelTranscript: transcript,
      })),
    ),

  setModelTranscriptForGeneration: (sessionId, generationId, transcript) =>
    set((state) =>
      withAiStream(state, sessionId, (s) =>
        s.generationId === generationId
          ? { ...s, modelTranscript: transcript }
          : s,
      ),
    ),

  restoreAiTranscript: (
    sessionId,
    messages,
    modelTranscript,
    capturedAt,
    mcpSelection,
  ) =>
    set((state) => ({
      ...withAiStream(state, sessionId, (s) => ({
        ...s,
        // Always "ask", never the archived mode: coming back to a tab silently
        // armed in agent mode is a surprise, and one click undoes it.
        mode: "ask",
        status: "idle",
        requestId: null,
        generationId: null,
        messages,
        modelTranscript,
        streamingContent: "",
        thinkingContent: "",
        pendingProposal: null,
        pendingMcpProposal: null,
        mcpSelection: mcpSelection ?? { server_ids: [], disabled_tools: {} },
        // Explicit rather than merely inherited from a new session: even a
        // direct restore into a live tab must not arrive pre-armed.
        permissionMode: "ask",
        //
        // Same stance for the pause: a Continue button surviving a restore would
        // offer to resume a finished run against a transcript the user has only
        // just reopened and has not read.
        pause: null,
        lastError: null,
        restoredAt: capturedAt,
      })),
      // Live terminal pairings are never reconstructed from archived state.
      sidecars: withoutSidecarForSession(state.sidecars, sessionId),
    })),

  newAiConversation: (sessionId) =>
    set((state) => {
      const ownerSessionId = resolveSidecarAiOwner(state.sidecars, sessionId);
      return {
        ...withAiStream(state, ownerSessionId, (s) => ({
          // Spread the zero value rather than listing fields: a field added to
          // AiStreamState later would otherwise silently survive the wipe.
          ...emptyAiStream(),
          // The only thing a new chat inherits is the mode you were working in.
          // Attached blocks, permissionMode and restoredAt deliberately do not
          // carry over — the same stance restoreAiTranscript takes.
          mode: s.mode,
          mcpSelection: defaultMcpSelection(state.mcpServers),
        })),
        // New Chat is the explicit conversation boundary for a sidecar.
        sidecars: withoutSidecarForSession(state.sidecars, sessionId),
      };
    }),

  pushAiMessage: (sessionId, msg) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        messages: [...s.messages, msg],
      })),
    ),

  appendAiDelta: (sessionId, content) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        streamingContent: s.streamingContent + content,
      })),
    ),

  appendThinking: (sessionId, content) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        thinkingContent: s.thinkingContent + content,
      })),
    ),

  setPendingProposal: (sessionId, proposal, status) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        pendingProposal: proposal,
        status: status ?? s.status,
      })),
    ),

  setPendingMcpProposal: (sessionId, proposal) =>
    set((state) =>
      withAiStream(state, sessionId, (stream) => ({
        ...stream,
        pendingMcpProposal: proposal,
        status: proposal
          ? "awaiting_approval"
          : stream.requestId
            ? "streaming"
            : "idle",
      })),
    ),

  setMcpSelection: (sessionId, selection) =>
    set((state) =>
      withAiStream(state, sessionId, (stream) => ({
        ...stream,
        mcpSelection: selection,
      })),
    ),

  beginMcpTool: (sessionId, approvalId, serverId, serverName, toolName, args) =>
    set((state) =>
      withAiStream(state, sessionId, (stream) => {
        const existing = stream.messages.some(
          (message) =>
            message.kind === "mcp_tool" &&
            message.mcp?.approvalId === approvalId,
        );
        const messages = existing
          ? stream.messages.map((message) =>
              message.kind === "mcp_tool" &&
              message.mcp?.approvalId === approvalId
                ? {
                    ...message,
                    mcp: { ...message.mcp, status: "running" as const },
                  }
                : message,
            )
          : [
              ...stream.messages,
              {
                id: `mcp-${approvalId}`,
                role: "assistant" as const,
                content: "",
                createdAt: new Date().toISOString(),
                kind: "mcp_tool" as const,
                mcp: {
                  approvalId,
                  serverId,
                  serverName,
                  toolName,
                  arguments: args,
                  status: "running" as const,
                },
              },
            ];
        return {
          ...stream,
          messages,
          pendingMcpProposal: null,
          status: "executing",
        };
      }),
    ),

  finishMcpTool: (sessionId, approvalId, result, error) =>
    set((state) =>
      withAiStream(state, sessionId, (stream) => ({
        ...stream,
        pendingMcpProposal:
          stream.pendingMcpProposal?.approvalId === approvalId
            ? null
            : stream.pendingMcpProposal,
        status: stream.requestId ? "streaming" : "idle",
        messages: stream.messages.map((message) =>
          message.kind === "mcp_tool" && message.mcp?.approvalId === approvalId
            ? {
                ...message,
                mcp: {
                  ...message.mcp,
                  status:
                    error === "Denied by user"
                      ? ("denied" as const)
                      : error || result?.is_error
                        ? ("error" as const)
                        : ("done" as const),
                  result,
                  error,
                },
              }
            : message,
        ),
      })),
    ),

  setPermissionMode: (sessionId, mode) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({ ...s, permissionMode: mode })),
    ),

  // A command policy refused. Appended already SETTLED, in one set(): there was
  // no approval gate and no execution, so routing it through
  // beginCommand/finishCommand would flash a transient "running" status and
  // render twice. `status: "blocked"` and `note` already exist for the
  // terminal-was-busy case, so this needs no new rendering.
  //
  // No approvalId: policy refuses BEFORE the gate is created, so there is no id
  // to key on. The message id is index-based instead, which is fine because
  // nothing ever updates it again.
  noteBlockedCommand: (sessionId, command, note, target) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        const flushed = flushStreaming(s);
        return {
          ...flushed,
          messages: [
            ...flushed.messages,
            {
              id: `blocked-${flushed.messages.length}-${command.slice(0, 24)}`,
              role: "assistant" as const,
              content: "",
              createdAt: new Date().toISOString(),
              kind: "command" as const,
              command: {
                command,
                output: "",
                exitCode: null,
                status: "blocked" as const,
                note,
                ...(target
                  ? {
                      targetRole: target.role,
                      targetSessionId: target.sessionId,
                      targetLabel: target.label,
                    }
                  : {}),
              },
            },
          ],
        };
      }),
    ),

  queueSteer: (sessionId, id, text) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        // Flush FIRST, exactly as beginCommand does. The assistant paragraph that
        // was mid-stream when the user interjected has to close above their
        // message — otherwise it folds into a bubble BELOW it, inverting the
        // order the user actually saw happen.
        const flushed = flushStreaming(s);
        return {
          ...flushed,
          steerQueue: [...flushed.steerQueue, { id, text }],
          messages: [
            ...flushed.messages,
            {
              id: `msg-steer-${id}`,
              role: "user" as const,
              content: text,
              createdAt: new Date().toISOString(),
              steer: "queued" as const,
            },
          ],
        };
      }),
    ),

  markSteersDelivered: (sessionId, ids) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        // Close the previous round's bubble before the next one opens. A no-op
        // when beginCommand already flushed, which is the common path.
        const flushed = flushStreaming(s);
        const delivered = new Set(ids);
        return {
          ...flushed,
          steerQueue: flushed.steerQueue.filter((q) => !delivered.has(q.id)),
          messages: flushed.messages.map((m) =>
            m.steer && delivered.has(m.id.replace(/^msg-steer-/, ""))
              ? { ...m, steer: undefined }
              : m,
          ),
        };
      }),
    ),

  markSteerUndelivered: (sessionId, id) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        steerQueue: s.steerQueue.filter((q) => q.id !== id),
        messages: s.messages.map((m) =>
          m.id === `msg-steer-${id}`
            ? { ...m, steer: "undelivered" as const }
            : m,
        ),
      })),
    ),

  flushAiStreaming: (sessionId) =>
    set((state) => withAiStream(state, sessionId, (s) => flushStreaming(s))),

  beginCommand: (
    sessionId,
    approvalId,
    command,
    explanation,
    target,
    outputPolicy = "normal",
  ) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        const flushed = flushStreaming(s);
        return {
          ...flushed,
          status: "executing",
          pendingProposal: null,
          messages: [
            ...flushed.messages,
            {
              id: `cmd-${approvalId}`,
              role: "assistant" as const,
              content: "",
              createdAt: new Date().toISOString(),
              kind: "command" as const,
              command: {
                approvalId,
                command,
                output: "",
                exitCode: null,
                status: "running" as const,
                outputPolicy,
                ...(outputPolicy === "private" ? { note: PRIVATE_OUTPUT_NOTICE } : {}),
                ...(explanation ? { explanation } : {}),
                ...(target
                  ? {
                      targetRole: target.role,
                      targetSessionId: target.sessionId,
                      targetLabel: target.label,
                    }
                  : {}),
              },
            },
          ],
        };
      }),
    ),

  appendCommandOutput: (sessionId, approvalId, chunk) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === `cmd-${approvalId}` &&
          m.command &&
          m.command.outputPolicy !== "private"
            ? {
                ...m,
                command: {
                  ...m.command,
                  // Raw append — chunks carry their own newlines.
                  output:
                    m.command.output.length < 131_072
                      ? m.command.output + chunk
                      : m.command.output,
                },
              }
            : m,
        ),
      })),
    ),

  setCommandOutput: (sessionId, approvalId, output) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id === `cmd-${approvalId}` &&
          m.command &&
          m.command.outputPolicy !== "private"
            ? { ...m, command: { ...m.command, output } }
            : m,
        ),
      })),
    ),

  setCommandStall: (sessionId, approvalId, stall) =>
    set((state) =>
      patchCommand(state, sessionId, approvalId, { stall: stall ?? undefined }),
    ),

  setCommandTyped: (sessionId, approvalId, typed) =>
    set((state) => patchCommand(state, sessionId, approvalId, { typed })),

  finishCommand: (sessionId, approvalId, exitCode, status, note, durationMs) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        let settled = false;
        const messages = s.messages.map((m) => {
          if (
            m.id !== `cmd-${approvalId}` ||
            !m.command ||
            m.command.status !== "running"
          ) {
            return m;
          }
          settled = true;
          const settledStatus =
            status ?? (exitCode === null ? "timeout" : "done");
          return {
            ...m,
            command: {
              ...m.command,
              exitCode,
              status: settledStatus,
              ...(note
                ? { note }
                : settledStatus === "timeout"
                  ? { note: S.aiPanel.completionUnknownNote }
                  : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              // A settled card must not keep offering to interrupt.
              stall: undefined,
            },
          };
        });
        return settled
          ? {
              ...s,
              status: "streaming",
              messages,
            }
          : s;
      }),
    ),

  finishAiStream: (sessionId, error, usage, generationId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        if (generationId !== undefined && s.generationId !== generationId)
          return s;
        const flushed = flushStreaming(s, usage);
        return {
          ...flushed,
          status: error ? "error" : "idle",
          requestId: null,
          generationId: generationId === undefined ? null : s.generationId,
          pendingProposal: null,
          lastError: error ?? null,
          attachedBlockIds: [],
          // steerQueue is deliberately NOT cleared here: this fires on Done,
          // before agent_start's promise resolves, and the messages below still
          // need to be reconcilable against it. initAiStream clears it.
          // No command card may outlive its run (e.g. spawn failures).
          messages: settleFencedMessages(flushed.messages),
        };
      }),
    ),

  fenceAiGeneration: (sessionId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        const flushed = flushStreaming(s);
        return {
          ...flushed,
          status:
            flushed.status === "error" || flushed.status === "paused"
              ? flushed.status
              : "idle",
          requestId: null,
          generationId: null,
          pendingProposal: null,
          attachedBlockIds: [],
          messages: settleFencedMessages(flushed.messages),
        };
      }),
    ),

  /** The run stopped at a guard rail. A near-copy of `finishAiStream` on purpose:
   *  everything about settling a run is identical, and only the outcome differs. */
  pauseAiStream: (sessionId, pause, usage, generationId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        if (generationId !== undefined && s.generationId !== generationId)
          return s;
        // Same flush as the finish path, or the model's last text never lands in
        // the panel.
        const flushed = flushStreaming(s, usage);
        return {
          ...flushed,
          status: "paused",
          requestId: null,
          generationId: generationId === undefined ? null : s.generationId,
          pendingProposal: null,
          // Stays null — this is the whole point. The red banner keys off it.
          lastError: null,
          pause,
          attachedBlockIds: [],
          messages: settleFencedMessages(flushed.messages),
        };
      }),
    ),

  attachBlockToAi: (sessionId, blockId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        attachedBlockIds: s.attachedBlockIds.includes(blockId)
          ? s.attachedBlockIds
          : [...s.attachedBlockIds, blockId],
      })),
    ),

  detachBlockFromAi: (sessionId, blockId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        attachedBlockIds: s.attachedBlockIds.filter((id) => id !== blockId),
      })),
    ),

  attachBucketToAi: (sessionId, bucket) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        const ref = normalizeKnowledgeBucketRef(bucket);
        const currentRefs =
          s.attachedBucketRefs ??
          s.attachedBucketIds.map(normalizeKnowledgeBucketRef);
        const refs = currentRefs.some((candidate) =>
          sameKnowledgeBucket(candidate, ref),
        )
          ? currentRefs
          : [...currentRefs, ref];
        const localId = ref.source === "local" ? ref.bucket_id : null;
        return {
          ...s,
          attachedBucketRefs: refs,
          attachedBucketIds:
            localId && !s.attachedBucketIds.includes(localId)
              ? [...s.attachedBucketIds, localId]
              : s.attachedBucketIds,
        };
      }),
    ),

  detachBucketFromAi: (sessionId, bucket) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        const ref = normalizeKnowledgeBucketRef(bucket);
        const currentRefs =
          s.attachedBucketRefs ??
          s.attachedBucketIds.map(normalizeKnowledgeBucketRef);
        return {
          ...s,
          attachedBucketRefs: currentRefs.filter(
            (candidate) => !sameKnowledgeBucket(candidate, ref),
          ),
          attachedBucketIds:
            ref.source === "local"
              ? s.attachedBucketIds.filter((id) => id !== ref.bucket_id)
              : s.attachedBucketIds,
        };
      }),
    ),

  attachFilesToAi: (sessionId, attachments) => {
    let accepted: Attachment[] = [];
    set((state) =>
      withAiStream(state, sessionId, (s) => {
        const room = MAX_ATTACHMENTS - s.pendingAttachments.length;
        accepted = attachments.slice(0, Math.max(0, room));
        const dropped = attachments.length - accepted.length;
        return {
          ...s,
          pendingAttachments: [...s.pendingAttachments, ...accepted],
          attachError:
            dropped > 0 ? attachLimitMessage(dropped) : s.attachError,
        };
      }),
    );
    return accepted;
  },

  detachFileFromAi: (sessionId, attachmentId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        pendingAttachments: s.pendingAttachments.filter(
          (a) => a.id !== attachmentId,
        ),
        // Removing a file is how the user reacts to a limit message, so the
        // message has to go with it or it lies.
        attachError: null,
      })),
    ),

  clearPendingAttachments: (sessionId) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        pendingAttachments: [],
        attachError: null,
      })),
    ),

  setAttachError: (sessionId, message) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({ ...s, attachError: message })),
    ),

  setAttachStatus: (sessionId, message) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({ ...s, attachStatus: message })),
    ),

  setKnowledgeWarning: (sessionId, message) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        knowledgeWarning: message,
      })),
    ),

  setAttachmentData: (sessionId, messageId, attachmentId, data) =>
    set((state) =>
      withAiStream(state, sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.id !== messageId || !m.attachments
            ? m
            : {
                ...m,
                attachments: m.attachments.map((a) =>
                  a.id === attachmentId ? { ...a, data } : a,
                ),
              },
        ),
      })),
    ),

  setAiMode: (sessionId, mode) =>
    set((state) => withAiStream(state, sessionId, (s) => ({ ...s, mode }))),

  renamingSessionId: null,
  setRenamingSession: (id) => set({ renamingSessionId: id }),
  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  sessionBrowserOpen: false,
  setSessionBrowserOpen: (open) => set({ sessionBrowserOpen: open }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  settingsTab: "models",
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  activeRenderer: "dom",
  setActiveRenderer: (r) => set({ activeRenderer: r }),
  termDims: { cols: 80, rows: 24 },
  setTermDims: (cols, rows) => set({ termDims: { cols, rows } }),

  settingsLoaded: false,
  theme: DEFAULT_THEME_ID,
  fontSize: 13,
  scrollbackLines: 10000,
  cursorStyle: "block",
  cursorBlink: true,
  copyOnSelect: false,
  shellPath: null,
  shellIntegrationEnabled: true,
  temperature: 0.7,
  activeModelId: "local/qwen3.5-9b",
  hasHfToken: false,
  credentialStoreStatus: "ready",
  historyEnabled: true,
  historyCaptureOutput: true,
  sendContextToAi: true,
  aiSessionNaming: true,
  restoreSessionsOnStart: true,
  restoreScrollbackLines: 1000,
  // These must match the inline defaults in Rust's get_settings, or the browser
  // footer states a retention policy the backend is not enforcing.
  archiveEnabled: true,
  archiveMaxSessions: 50,
  archiveMaxAgeDays: 30,
  autoLoadModelOnStart: false,
  visionModelId: null,
  visionPrompt: null,
  visionAutoLoadOnStart: true,
  agentMaxIterations: 10,
  agentCommandTimeoutSecs: 120,
  agentCommandPolicyRules: [],
  aiWebAccess: true,
  // Empty, not null: these are bound to textareas, and a controlled input whose
  // value is null is an uncontrolled input with a React warning.
  customInstructions: "",
  agentCustomInstructions: "",
  chatCustomInstructions: "",
  autoUpdateEnabled: false,
  docsEnabled: false,
  runbooksEnabled: false,
  runbooksOutputRecording: "runbook",
  docBuckets: [],
  knowledgeBuckets: [],
  docsIndexing: {},
  docsError: null,
  setDocBuckets: (docBuckets) => set({ docBuckets }),
  setKnowledgeBuckets: (knowledgeBuckets) => set({ knowledgeBuckets }),
  setDocsIndexing: (bucketId, progress) =>
    set((state) => {
      const next = { ...state.docsIndexing };
      if (progress === null) {
        delete next[bucketId];
      } else {
        // Preserve a cancel that arrived between two files: the loop reads this flag
        // after each file, and a progress update must not clear a stop the user asked
        // for.
        next[bucketId] = {
          ...progress,
          cancel: next[bucketId]?.cancel ?? false,
        };
      }
      return { docsIndexing: next };
    }),
  cancelDocsIndexing: (bucketId) =>
    set((state) => {
      const current = state.docsIndexing[bucketId];
      if (!current) return state;
      return {
        docsIndexing: {
          ...state.docsIndexing,
          [bucketId]: { ...current, cancel: true },
        },
      };
    }),
  setDocsError: (docsError) => set({ docsError }),
  hydrateSettings: (patch) => set({ ...patch, settingsLoaded: true }),
  setTheme: (theme) => set({ theme }),
  setFontSize: (px) => set({ fontSize: Math.min(20, Math.max(10, px)) }),

  visionCatalog: [],
  setVisionCatalog: (entries) => set({ visionCatalog: entries }),
  visionLoadedModelId: null,
  visionState: "idle",
  visionAcceleration: null,
  setVisionStatus: (loaded, state, acceleration) =>
    set({
      visionLoadedModelId: loaded,
      visionState: state,
      ...(acceleration !== undefined
        ? { visionAcceleration: acceleration }
        : {}),
    }),
  visionLoadError: null,
  setVisionLoadError: (message) => set({ visionLoadError: message }),
  localModels: [],
  setLocalModels: (m) => set({ localModels: m }),
  loadedModelId: null,
  modelState: "idle",
  modelAvailable: null,
  localAcceleration: null,
  modelLoadError: null,
  setModelStatus: (loaded, state, available, acceleration) =>
    set({
      loadedModelId: loaded,
      modelState: state,
      modelAvailable: available,
      ...(acceleration ? { localAcceleration: acceleration } : {}),
    }),
  setModelLoadError: (message) => set({ modelLoadError: message }),
  // `=== false`, never `!modelAvailable`: null means "not probed yet", and that
  // must read as "engine present" so nothing flickers as unavailable at boot.
  localEngineMissing: () => get().modelAvailable === false,
  catalog: [],
  setCatalog: (c) => set({ catalog: c }),
  modelEffort: {},
  setModelEffortLocal: (modelId, effort) =>
    set((s) => ({ modelEffort: { ...s.modelEffort, [modelId]: effort } })),
  setModelEffortMap: (m) => set({ modelEffort: m }),
  hasApiKey: {},
  setHasApiKey: (provider, present) =>
    set((s) => ({ hasApiKey: { ...s.hasApiKey, [provider]: present } })),
  downloads: {},
  updateDownload: (id, p) =>
    set((state) => ({ downloads: { ...state.downloads, [id]: p } })),
  clearDownload: (id) =>
    set((state) => {
      const { [id]: _d, ...downloads } = state.downloads;
      return { downloads };
    }),
  downloadErrors: {},
  setDownloadError: (kind, modelId, message) =>
    set((state) => {
      const key = `${kind}:${modelId}`;
      if (message !== null) {
        return { downloadErrors: { ...state.downloadErrors, [key]: message } };
      }
      const { [key]: _error, ...downloadErrors } = state.downloadErrors;
      return { downloadErrors };
    }),

  aiBlockedReason: () => {
    const s = get();
    const entry = s.catalog.find((m) => m.id === s.activeModelId);
    // A build without the local engine can never load an on-device model, so
    // "load a model" would point at a button that only errors. Say the real
    // reason instead — `resolve_provider` fails the same way on the backend.
    // Before the catalog lands, the id prefix is the only signal there is.
    const wantsLocal = entry
      ? !!entry.local
      : s.activeModelId.startsWith("local/");
    if (wantsLocal && s.localEngineMissing()) return "engine";
    // Before the catalog arrives, fall back to the on-device signal so a
    // local-first boot does not flash a misleading "add a key" message.
    if (!entry) return s.modelState === "ready" ? null : "load";
    if (entry.local) {
      return s.loadedModelId === entry.id && s.modelState === "ready"
        ? null
        : "load";
    }
    // A server the user configured themselves: the weights live over there, so
    // there is nothing to load, and most are keyless on a LAN, so there is
    // nothing to key. The row existing IS the precondition — and it does exist,
    // or `catalog.find` above would have missed.
    //
    // `hasApiKey` must NOT be consulted here. It is keyed by PROVIDER STRING, so
    // reaching it would let one token-bearing server decide readiness for every
    // keyless one. This branch makes that unreachable. Whether a server is
    // reachable RIGHT NOW is unknowable without touching the network, which is
    // what "nothing probes at startup" rules out — that failure surfaces on the
    // request instead, where the panel already renders it.
    if (entry.remote) return null;
    // hasApiKey updates the moment a key is saved; `configured` only refreshes
    // when the catalog is re-fetched, so prefer the live one.
    return (s.hasApiKey[entry.provider] ?? entry.configured) ? null : "key";
  },

  aiReady: () => get().aiBlockedReason() === null,

  imageReader: () => {
    const s = get();
    const chat = s.catalog.find((m) => m.id === s.activeModelId);
    if (chat?.supports_vision) return { kind: "native", label: chat.label };
    // Selected-but-not-LOADED is deliberately `none`: the transcription would fail
    // at send time, after the user had already pressed Send.
    if (s.visionModelId && s.visionLoadedModelId === s.visionModelId) {
      const sidecar = s.visionCatalog.find((m) => m.id === s.visionModelId);
      return { kind: "sidecar", label: sidecar?.label ?? s.visionModelId };
    }
    return { kind: "none", label: null };
  },

  anyAiStreaming: () => {
    const state = get();
    return Object.values(state.aiStreams).some((s) => s.status === "streaming");
  },
}));

// Convenience selectors
export const useActiveSessionUi = (): SessionUiState | null =>
  useAppStore((s) =>
    s.activeSessionId ? (s.sessionUi[s.activeSessionId] ?? null) : null,
  );

export const useActiveAiStream = (): AiStreamState | null =>
  useAppStore((s) =>
    s.activeSessionId ? (s.aiStreams[s.activeSessionId] ?? null) : null,
  );

// Vite HMR: hot-replacing this module builds a FRESH store with default state,
// including `settingsLoaded: false`. AppShell gates the AI panel on that flag,
// and nothing re-runs loadSettings() afterwards — so editing this file makes the
// panel silently vanish until a manual reload, while terminals (which live in
// termRegistry, not store state) keep working. Force the full reload rather than
// leave a half-initialised store behind.
if (import.meta.hot) {
  import.meta.hot.invalidate();
}
