import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ApprovalDecision,
  AgentTargetRole,
  ArchiveDetail,
  ArchiveSessionInput,
  ArchiveSummary,
  CatalogEntry,
  ChatDetail,
  ChatSaveInput,
  ChatSummary,
  ChatMessage,
  DocBucket,
  DocFile,
  DocPutOutcome,
  DocPutPage,
  DocScanSummary,
  DocSearchPreview,
  DownloadEvent,
  EmbeddingInstallEvent,
  EmbeddingCatalogEntry,
  EmbeddingModelStatus,
  Effort,
  HistoryEntry,
  HistoryEntryInput,
  ImagePart,
  KnowledgeBucketDescriptor,
  KnowledgeBucketRef,
  KnowledgeDocumentIngestInput,
  KnowledgeDocumentMetadataUpdate,
  KnowledgeDocumentPage,
  KnowledgeJob,
  KnowledgePointId,
  KnowledgeSearchHit,
  KnowledgeSearchResponse,
  LoadEvent,
  LocalModel,
  ModelStatus,
  McpChatSelection,
  McpSandboxStatus,
  McpServerConfig,
  McpServerView,
  McpToolResultView,
  McpToolView,
  PtyEvent,
  QdrantConnection,
  QdrantConnectionConfig,
  QdrantConnectionInput,
  RemoteModel,
  RemoteProbeResult,
  RemoteServer,
  RemoteServerInput,
  Settings,
  SettingsPatch,
  SidecarAgentTargets,
  SshConfigCandidate,
  SshHost,
  SshHostInput,
  StreamEvent,
  TerminalContext,
  TurboQuantConfig,
  UpdateDownloadEvent,
  UpdateMetadata,
  VisionCatalogEntry,
  WorkspaceRestore,
  WorkspaceSnapshotInput,
} from "./types";
import type { PermissionMode } from "./permissionMode";
import {
  localBucketDescriptor,
  normalizeKnowledgeBucketRef,
} from "./knowledge";
import {
  trackArchiveWrite,
  trackExitArchiveWrite,
} from "./archiveWriteTracker";

// RETAINED-CHANNEL GOTCHA (same as Cowork's realtimeChannels map):
// a Channel must stay referenced for as long as Rust will send on it, or GC
// kills delivery after invoke() resolves. Map.set/delete are observable side
// effects — bundlers can't tree-shake them.
const ptyDataChannels = new Map<string, Channel<ArrayBuffer>>();
const ptyEventChannels = new Map<string, Channel<PtyEvent>>();
const aiChannels = new Map<string, Channel<StreamEvent>>();
const downloadChannels = new Map<string, Channel<DownloadEvent>>();
const loadChannels = new Map<string, Channel<LoadEvent>>();
const updateChannels = new Set<Channel<UpdateDownloadEvent>>();
const embeddingInstallChannels = new Map<
  string,
  Channel<EmbeddingInstallEvent | DownloadEvent>
>();
const embeddingDownloadIds = new Map<string, string>();

// ---------- PTY ----------

export async function ptySpawn(
  sessionId: string,
  opts: {
    cols: number;
    rows: number;
    cwd?: string | null;
    shell?: string | null;
  },
  onData: (buf: ArrayBuffer) => void,
  onEvent: (e: PtyEvent) => void,
): Promise<number> {
  const dataChannel = new Channel<ArrayBuffer>();
  dataChannel.onmessage = onData;
  const eventChannel = new Channel<PtyEvent>();
  eventChannel.onmessage = onEvent;
  ptyDataChannels.set(sessionId, dataChannel);
  ptyEventChannels.set(sessionId, eventChannel);
  try {
    return await invoke<number>("pty_spawn", {
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? null,
      shell: opts.shell ?? null,
      onData: dataChannel,
      onEvent: eventChannel,
    });
  } catch (e) {
    ptyDataChannels.delete(sessionId);
    ptyEventChannels.delete(sessionId);
    throw e;
  }
}

export const ptyWrite = (sessionId: string, data: string) =>
  invoke<void>("pty_write", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { sessionId, cols, rows });

export const ptyAck = (sessionId: string, bytes: number) =>
  invoke<void>("pty_ack", { sessionId, bytes });

export async function ptyKill(sessionId: string): Promise<void> {
  try {
    await invoke<void>("pty_kill", { sessionId });
  } finally {
    ptyDataChannels.delete(sessionId);
    ptyEventChannels.delete(sessionId);
  }
}

export const ptyList = () => invoke<string[]>("pty_list");

/** Called when the backend reports Exit — releases the retained channels. */
export function releasePtyChannels(sessionId: string): void {
  ptyDataChannels.delete(sessionId);
  ptyEventChannels.delete(sessionId);
}

// ---------- AI ----------

export async function aiSuggest(
  requestId: string,
  prompt: string,
  context: TerminalContext,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  aiChannels.set(requestId, channel);
  try {
    await invoke<void>("ai_suggest", {
      requestId,
      prompt,
      context,
      onEvent: channel,
    });
  } finally {
    aiChannels.delete(requestId);
  }
}

export async function aiExplain(
  requestId: string,
  command: string,
  outputTail: string,
  exitCode: number,
  context: TerminalContext,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  aiChannels.set(requestId, channel);
  try {
    await invoke<void>("ai_explain", {
      requestId,
      command,
      outputTail,
      exitCode,
      context,
      onEvent: channel,
    });
  } finally {
    aiChannels.delete(requestId);
  }
}

/**
 * `history` carries `image_count` rather than the images themselves: an image
 * rides only on the turn it was attached to, and Rust renders the count back as a
 * note so a replayed turn does not read as if nothing had been attached.
 *
 * `images` is therefore THIS turn's images only.
 */
export async function aiAsk(
  requestId: string,
  prompt: string,
  history: {
    role: string;
    content: string;
    image_count?: number;
    doc_count?: number;
  }[],
  images: ImagePart[],
  context: TerminalContext,
  /** Whether `prompt` carries passages folded in from the user's document buckets. Only
   *  selects the prompt tier — the passages themselves are already in `prompt`. */
  docs: boolean,
  onEvent: (e: StreamEvent) => void,
  mcpSelection: McpChatSelection = { server_ids: [], disabled_tools: {} },
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  aiChannels.set(requestId, channel);
  try {
    await invoke<void>("ai_ask", {
      requestId,
      prompt,
      history,
      images,
      context,
      docs,
      mcpSelection,
      onEvent: channel,
    });
  } finally {
    aiChannels.delete(requestId);
  }
}

/**
 * Run one agent turn. Resolves with the model-visible transcript.
 *
 * `history` is that transcript from the previous turn — pass it back and the run
 * continues the same conversation; omit it and the agent starts from scratch,
 * which is what it did for every turn before this existed.
 *
 * The array is OPAQUE. Never reorder it, never edit a `content`, and above all
 * never drop an element: dropping an assistant turn that carries `tool_calls`
 * orphans its tool result, and Anthropic answers that with a 400. Rust owns all
 * trimming and repair (`agent::history::normalize`).
 */
export async function agentStart(
  requestId: string,
  goal: string,
  context: TerminalContext,
  history: ChatMessage[],
  images: ImagePart[],
  /** Buckets attached to this session. Rust drops them when `docs_enabled` is off,
   *  and an empty list means the run is never offered a `search_docs` tool at all. */
  docBuckets: KnowledgeBucketRef[],
  onEvent: (e: StreamEvent) => void,
  /** Optional immutable local/SSH target pair for a linked Agent turn. */
  sidecarTargets?: SidecarAgentTargets,
  permissionModes: {
    single: PermissionMode;
    local: PermissionMode;
    remote: PermissionMode;
  } = {
    single: "ask",
    local: "ask",
    remote: "ask",
  },
  mcpSelection: McpChatSelection = { server_ids: [], disabled_tools: {} },
): Promise<ChatMessage[]> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  aiChannels.set(requestId, channel);
  try {
    return await invoke<ChatMessage[]>("agent_start", {
      requestId,
      goal,
      context,
      history,
      images,
      // `agent_start` uses Tauri's default camelCase argument mapping. Sending
      // `doc_buckets` here silently deserializes the optional Rust argument as
      // `None`, which removes `search_docs` from the agent's tool vector.
      docBuckets,
      permissionModes,
      mcpSelection,
      sidecarTargets: sidecarTargets ?? null,
      onEvent: channel,
    });
  } finally {
    aiChannels.delete(requestId);
  }
}

export const agentSetPermissionMode = (
  requestId: string,
  mode: PermissionMode,
  targetRole?: AgentTargetRole,
) =>
  invoke<void>("agent_set_permission_mode", {
    request_id: requestId,
    target_role: targetRole ?? null,
    mode,
  });

export const respondToApproval = (
  approvalId: string,
  decision: ApprovalDecision,
  editedCommand?: string,
) =>
  invoke<void>("respond_to_approval", {
    approval_id: approvalId,
    decision,
    edited_command: editedCommand ?? null,
  });

export type McpApprovalDecision = "allow_once" | "always_allow" | "deny";
export const respondToMcpApproval = (
  approvalId: string,
  decision: McpApprovalDecision,
) =>
  invoke<void>("respond_to_mcp_approval", {
    approval_id: approvalId,
    decision,
  });

// ---------- MCP ----------

export const mcpServersList = () => invoke<McpServerView[]>("mcp_servers_list");

export const mcpServerUpsert = (
  server: McpServerConfig,
  values: Record<string, string> = {},
) => invoke<string>("mcp_servers_upsert", { server, secrets: { values } });

export const mcpServerDelete = (id: string) =>
  invoke<void>("mcp_servers_delete", { id });

export const mcpServerSetSecret = (id: string, slot: string, value: string) =>
  invoke<void>("mcp_servers_set_secret", { id, slot, value });

export const mcpServerTrust = (id: string) =>
  invoke<void>("mcp_servers_trust", { id });

export const mcpOauthStart = (id: string) =>
  invoke<import("./types").McpOAuthStartView>("mcp_oauth_start", { id });

export const mcpOauthFinish = (id: string) =>
  invoke<{ authenticated: boolean; granted_scopes: string[] }>(
    "mcp_oauth_finish",
    { id },
  );

export const mcpOauthRevoke = (id: string) =>
  invoke<import("./types").McpOAuthRevokeView>("mcp_oauth_revoke", { id });

export const mcpServerTest = (id: string) =>
  invoke<McpToolView[]>("mcp_servers_test", { id });

export const mcpServerConnect = (id: string) =>
  invoke<McpToolView[]>("mcp_server_connect", { id });

export const mcpServerDisconnect = (id: string) =>
  invoke<void>("mcp_server_disconnect", { id });

export const mcpToolsList = (conversationId: string, serverIds: string[]) =>
  invoke<McpToolView[]>("mcp_tools_list", {
    conversation_id: conversationId,
    server_ids: serverIds,
  });

export const mcpToolsRefresh = (conversationId: string, serverId: string) =>
  invoke<McpToolView[]>("mcp_tools_refresh", {
    conversation_id: conversationId,
    server_id: serverId,
  });

export const mcpToolCall = (
  conversationId: string,
  serverId: string,
  toolName: string,
  args: unknown,
) =>
  invoke<McpToolResultView>("mcp_tools_call", {
    conversation_id: conversationId,
    server_id: serverId,
    tool_name: toolName,
    arguments: args,
  });

export const mcpDisconnect = (conversationId: string, serverId?: string) =>
  invoke<void>("mcp_disconnect", {
    conversation_id: conversationId,
    server_id: serverId ?? null,
  });

export const mcpLogs = (serverId: string) =>
  invoke<string>("mcp_logs", { server_id: serverId });

export const mcpSandboxStatus = () =>
  invoke<McpSandboxStatus>("mcp_sandbox_status");

export const mcpDefaultServerIds = () =>
  invoke<string[]>("mcp_default_server_ids");

export const mcpForgetApprovals = (serverId?: string) =>
  invoke<void>("mcp_forget_approvals", { server_id: serverId ?? null });

export const mcpExportRedacted = () => invoke<unknown>("mcp_export_redacted");

/** Report a PTY-executed command back to the waiting agent loop. Snake_case
 *  like respond_to_approval — both are `rename_all = "snake_case"` on the Rust
 *  side. Safe to call for an approval the backend already gave up on. */
export const submitCommandResult = (
  approvalId: string,
  exitCode: number | null,
  outputTail: string,
  durationMs: number,
  error: string | null,
) =>
  invoke<void>("submit_command_result", {
    approval_id: approvalId,
    exit_code: exitCode,
    output_tail: outputTail,
    duration_ms: durationMs,
    error,
  });

/** Hand a message to a RUNNING agent turn without cancelling it.
 *
 *  Queued, not injected: the loop appends it at the next ROUND boundary, because
 *  a user turn between an assistant's tool_calls and their results is a 400 on
 *  OpenAI and Anthropic and is silently dropped by Gemma 4's template. A run
 *  parked on an approval card or a long command picks it up when that step ends.
 *
 *  Rejects once the run is over — the caller turns that into an undelivered
 *  badge rather than losing what the user typed. Snake_case like the other two
 *  agent-adjacent commands. */
export const agentSteer = (requestId: string, steerId: string, text: string) =>
  invoke<void>("agent_steer", {
    request_id: requestId,
    steer_id: steerId,
    text,
  });

export const aiCancel = (requestId: string) =>
  invoke<void>("ai_cancel", { requestId });

/** Collected, not streamed — the result is a single short label, so there is no
 *  channel to retain. Rust sanitizes and rejects unusable output, so a resolved
 *  value is always safe to render. */
export const aiNameSession = (requestId: string, digest: string) =>
  invoke<string>("ai_name_session", { requestId, digest });

/** Terminal-free Chat workspace turn. The returned transcript is opaque and
 * must be persisted exactly as received. */
export async function chatStart(
  requestId: string,
  conversationId: string,
  prompt: string,
  history: ChatMessage[],
  images: ImagePart[],
  docBuckets: KnowledgeBucketRef[],
  mcpSelection: McpChatSelection,
  onEvent: (event: StreamEvent) => void,
): Promise<ChatMessage[]> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  aiChannels.set(requestId, channel);
  try {
    return await invoke<ChatMessage[]>("chat_start", {
      requestId,
      conversationId,
      prompt,
      history,
      images,
      docBuckets,
      mcpSelection,
      onEvent: channel,
    });
  } finally {
    aiChannels.delete(requestId);
  }
}

export const aiNameChat = (
  requestId: string,
  prompt: string,
  answer: string,
  currentTitle?: string,
) => invoke<string>("ai_name_chat", {
  requestId,
  prompt,
  answer,
  currentTitle: currentTitle ?? null,
});

export const chatList = () => invoke<ChatSummary[]>("chat_list");
export const chatGet = (chatId: string) => invoke<ChatDetail | null>("chat_get", { chatId });
export const chatSave = (chat: ChatSaveInput) =>
  trackArchiveWrite(() => invoke<void>("chat_save", { chat }));
export const chatSetArchived = (chatId: string, archivedAt: string | null) =>
  trackArchiveWrite(() => invoke<void>("chat_set_archived", { chatId, archivedAt }));
export const chatUpdateTitle = (
  chatId: string,
  title: string,
  source: ChatSaveInput["title_source"],
  expectedTitle?: string,
  allowManualOverride = false,
) => trackArchiveWrite(() => invoke<boolean>("chat_update_title", {
  chatId,
  title,
  source,
  expectedTitle: expectedTitle ?? null,
  allowManualOverride,
}));
export const chatDelete = (chatId: string) =>
  trackArchiveWrite(() => invoke<void>("chat_delete", { chatId }));

// ---------- Models ----------

/** The whole allowlist, joined with download/config state and stored effort. */
export const modelsCatalog = () => invoke<CatalogEntry[]>("models_catalog");

/** `modelId` is a catalog id — there is no free-form download path. */
export async function modelsDownload(
  downloadId: string,
  modelId: string,
  onEvent: (e: DownloadEvent) => void,
): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  downloadChannels.set(downloadId, channel);
  try {
    await invoke<void>("models_download", {
      download_id: downloadId,
      model_id: modelId,
      // snake_case like the other two keys — models_download is
      // rename_all = "snake_case" (see model_load above).
      on_event: channel,
    });
  } finally {
    downloadChannels.delete(downloadId);
  }
}

export const modelsCancelDownload = (downloadId: string) =>
  invoke<void>("models_cancel_download", { downloadId });

export const modelsListLocal = () => invoke<LocalModel[]>("models_list_local");

export const modelsDelete = (modelId: string) =>
  invoke<void>("models_delete", { model_id: modelId });

export async function modelLoad(
  modelId: string,
  onEvent: (e: LoadEvent) => void,
): Promise<void> {
  const channel = new Channel<LoadEvent>();
  channel.onmessage = onEvent;
  loadChannels.set(modelId, channel);
  try {
    // model_load is rename_all = "snake_case" on the Rust side, so BOTH keys
    // must be snake_case — `onEvent` here made every load fail with
    // "missing required key on_event".
    await invoke<void>("model_load", { model_id: modelId, on_event: channel });
  } finally {
    loadChannels.delete(modelId);
  }
}

export const modelUnload = () => invoke<void>("model_unload");

export const modelStatus = () => invoke<ModelStatus>("model_status");

/** Per-model reasoning effort, as `{ [catalogId]: Effort }`.
 *  Deliberately not part of saveSettings: a map there would turn every
 *  single-key write into a read-modify-write race. */
export const getModelEffort = () =>
  invoke<Record<string, Effort>>("get_model_effort");

export const setModelEffort = (modelId: string, effort: Effort) =>
  invoke<void>("set_model_effort", { model_id: modelId, effort });

// ---------- History ----------

export const historyRecord = (entry: HistoryEntryInput) =>
  invoke<string>("history_record", { entry });

export const historySearch = (query: string, limit = 50, offset = 0) =>
  invoke<HistoryEntry[]>("history_search", { query, limit, offset });

export const historyRecent = (limit = 50) =>
  invoke<HistoryEntry[]>("history_recent", { limit });

/** Wipe recorded commands. `command_history` is never pruned automatically, so
 *  this is the only way it shrinks. */
export const historyClear = () => invoke<void>("history_clear");

// ---------- Remote inference servers ----------
//
// Every command here is `rename_all = "snake_case"` on the Rust side, so the
// payload keys are snake_case throughout.

/** The configured servers. Never touches the network. */
export const remoteServersList = () =>
  invoke<RemoteServer[]>("remote_servers_list");

/** Returns the new server's id. `apiKey` may be sent HERE and only here: create
 *  is the one call where "leave the stored token alone" cannot arise, because
 *  there is nothing stored. Afterwards the token has exactly one mutation path,
 *  so an untouched password field can never silently clear one. */
export const remoteServersCreate = (
  server: RemoteServerInput,
  apiKey: string | null,
) => invoke<string>("remote_servers_create", { server, api_key: apiKey });

/** Deliberately cannot touch the token or the enabled models — see
 *  `remoteServersSetApiKey` and `remoteServersSetModels`. */
export const remoteServersUpdate = (id: string, server: RemoteServerInput) =>
  invoke<void>("remote_servers_update", { id, server });

/** Also clears the token and un-selects the model if it was this server's. */
export const remoteServersDelete = (id: string) =>
  invoke<void>("remote_servers_delete", { id });

/** Write-only, like every secret here: "" clears, and the value never reads back. */
export const remoteServersSetApiKey = (id: string, apiKey: string) =>
  invoke<void>("remote_servers_set_api_key", { id, api_key: apiKey });

/** THE only call in this file that reaches a user-named host. Collected rather
 *  than streamed — one bounded round trip, so there is no Channel to retain.
 *  Rejects with the backend's message verbatim; the form renders it, because
 *  "could not connect" without the reason is what sends people to the logs. */
export const remoteServersProbe = (id: string) =>
  invoke<RemoteProbeResult>("remote_servers_probe", { id });

/** Replaces the enabled set wholesale. An empty array is meaningful: it turns a
 *  server off without deleting it. */
export const remoteServersSetModels = (id: string, models: RemoteModel[]) =>
  invoke<void>("remote_servers_set_models", { id, models });

// ---------- SSH hosts ----------

export const sshHostsList = () => invoke<SshHost[]>("ssh_hosts_list");

/** Null when the row was deleted since — a restored tab can outlive its host. */
export const sshHostsGet = (id: string) =>
  invoke<SshHost | null>("ssh_hosts_get", { id });

/** Create can accept the initial password because no keep-vs-clear ambiguity exists yet. */
export const sshHostsCreate = (host: SshHostInput, password: string | null) =>
  invoke<string>("ssh_hosts_create", { host, password });

export const sshHostsUpdate = (id: string, host: SshHostInput) =>
  invoke<void>("ssh_hosts_update", { id, host });

/** Write-only. An empty value clears the password, and the secret never reads back. */
export const sshHostsSetPassword = (id: string, password: string) =>
  invoke<void>("ssh_hosts_set_password", { id, password });

/** Resolve a saved password in the backend and submit it directly to this PTY. */
export const sshHostsWritePassword = (id: string, sessionId: string) =>
  invoke<void>("ssh_hosts_write_password", { id, sessionId });

export const sshHostsDelete = (id: string) => invoke<void>("ssh_hosts_delete", { id });

/** Frecency bump — called when a connect command actually reaches a shell. */
export const sshHostsTouch = (id: string) =>
  invoke<void>("ssh_hosts_touch", { id });

/** Read-only scan of ~/.ssh/config. The app never writes to that file. */
export const sshHostsScanConfig = () =>
  invoke<SshConfigCandidate[]>("ssh_hosts_scan_config");

/** Windows only: host-visible path to the default WSL user's ~/.ssh. */
export const sshWslIdentityRoot = () =>
  invoke<string | null>("ssh_wsl_identity_root");

/** Convert a file selected through \\wsl.localhost into a validated Linux path. */
export const sshWslPathFromHost = (path: string) =>
  invoke<string>("ssh_wsl_path_from_host", { path });

/** Insert the reviewed rows; returns how many were actually added. */
export const sshHostsImport = (hosts: SshHostInput[]) =>
  invoke<number>("ssh_hosts_import", { hosts });

// ---------- Workspace / session restore ----------

/** Metadata only — bumps the generation and arms the crash-loop guard.
 *  Call exactly once per boot. */
export const workspaceRestore = () =>
  invoke<WorkspaceRestore>("workspace_restore");

export const workspaceSnapshot = (snapshot: WorkspaceSnapshotInput) =>
  invoke<void>("workspace_snapshot", { snapshot });

/** Fetched lazily per tab so a multi-megabyte payload stays off the boot path. */
export const workspaceScrollback = (sessionId: string) =>
  invoke<string | null>("workspace_scrollback", { sessionId });

/** Resets the crash-loop counter once a run has survived a few seconds. */
export const workspaceMarkHealthy = () =>
  invoke<void>("workspace_mark_healthy");

/** Set only after the final workspace and archive writes are durable. */
export const workspaceMarkCleanExit = () =>
  invoke<void>("workspace_mark_clean_exit");

/** Re-arm crash reporting when a prepared exit is abandoned. */
export const workspaceMarkRunning = () =>
  invoke<void>("workspace_mark_running");

export const workspaceClear = () => invoke<void>("workspace_clear");

// ---------- Session archive ----------

/** The browser list: ended sessions, newest first, metadata only. */
export const archiveList = (limit = 200, offset = 0) =>
  invoke<ArchiveSummary[]>("archive_list", { limit, offset });

/** Metadata + the display transcript. Still no scrollback blob — that is
 *  `archiveScrollback`, fetched only for the row actually being reopened. */
export const archiveGet = (sessionId: string) =>
  invoke<ArchiveDetail | null>("archive_get", { sessionId });

export const archiveScrollback = (sessionId: string) =>
  invoke<string | null>("archive_scrollback", { sessionId });

/** The model's own transcript, already normalized and budget-trimmed by Rust.
 *  Treat it as OPAQUE — see `ChatMessage`. */
export const archiveTranscript = (sessionId: string) =>
  invoke<ChatMessage[]>("archive_transcript", { sessionId });

export const archivePut = (session: ArchiveSessionInput) =>
  trackArchiveWrite(() => invoke<void>("archive_put", { session }));

/** One transaction. Used by the quit path, which archives every tab at once
 *  inside a hard time budget. */
export const archivePutMany = (sessions: ArchiveSessionInput[]) =>
  trackArchiveWrite(() => invoke<void>("archive_put_many", { sessions }));

/** Exit-barrier-only variant; ordinary archive mutations are frozen by then. */
export const archivePutManyForExit = (sessions: ArchiveSessionInput[]) =>
  trackExitArchiveWrite(() => invoke<void>("archive_put_many", { sessions }));

export const archiveDelete = (sessionId: string) =>
  trackArchiveWrite(() => invoke<void>("archive_delete", { sessionId }));

export const archiveClear = () =>
  trackArchiveWrite(() => invoke<void>("archive_clear"));

/** Returns how many rows went. Called after a retention limit is lowered, so the
 *  change takes effect immediately rather than at the next archive write. */
export const archivePrune = () =>
  trackArchiveWrite(() => invoke<number>("archive_prune"));

// ---------- Attachments ----------

/** Write one attachment's bytes to disk and get back where they went.
 *
 *  Called from the SEND path, not from the drop handler: attaching and then
 *  removing a file would otherwise leave an orphan for a message never sent.
 *  `rename_all = "snake_case"` on the Rust side, so every key here is snake_case.
 */
export const attachmentPut = (
  sessionId: string,
  attachmentId: string,
  mediaType: string,
  dataBase64: string,
) =>
  invoke<{ path: string; bytes: number }>("attachment_put", {
    session_id: sessionId,
    attachment_id: attachmentId,
    media_type: mediaType,
    data_base64: dataBase64,
  });

/** Read stored bytes back for a thumbnail on a restored transcript. Raw, so this
 *  arrives as an ArrayBuffer with no base64 expansion — the `pty_spawn` pattern. */
export const attachmentRead = (path: string) =>
  invoke<ArrayBuffer>("attachment_read", { path });

// ---------- Settings ----------

export const getSettings = () => invoke<Settings>("get_settings");

export const saveSettings = (patch: Partial<SettingsPatch>) =>
  invoke<void>("save_settings", { ...patch });

export const rememberCommandPolicyRule = (
  command: string,
  effect: "allow" | "ask" | "deny",
  scope: string,
) =>
  invoke<import("./types").CommandPolicyRule[]>(
    "remember_command_policy_rule",
    {
      command,
      effect,
      scope,
    },
  );

export interface SystemInfo {
  total_ram_bytes: number;
  os: string;
  arch: string;
  terminal_backend: "wsl_conpty" | "native_pty";
  shell_family: "bash" | "zsh";
  wsl_status:
    | "ready"
    | "missing"
    | "wsl1"
    | "missing_bash"
    | "missing_tools"
    | "error"
    | "not_applicable";
  wsl_distribution: string | null;
  local_acceleration: {
    backend: string;
    device_name: string | null;
    device_memory_bytes: number | null;
    fallback_reason: string | null;
  };
}

export const getSystemInfo = () => invoke<SystemInfo>("get_system_info");

// ---------- Application updates ----------

export const updateCheck = () => invoke<UpdateMetadata | null>("update_check");

export async function updateDownload(
  onEvent: (event: UpdateDownloadEvent) => void,
): Promise<string> {
  const channel = new Channel<UpdateDownloadEvent>();
  channel.onmessage = onEvent;
  updateChannels.add(channel);
  try {
    return await invoke<string>("update_download", { onEvent: channel });
  } finally {
    updateChannels.delete(channel);
  }
}

export const updateCancel = () => invoke<void>("update_cancel");

export const updateApply = (downloadId: string) =>
  invoke<void>("update_apply", { downloadId });

export const appRestart = () => invoke<void>("app_restart");

export type AppQuitOrigin = "menu" | "windowClose" | "exitRequested";
export type AppQuitTicket = { token: number; origin: AppQuitOrigin };

export const appQuitBegin = (origin: AppQuitOrigin) =>
  invoke<AppQuitTicket>("app_quit_begin", { origin });

export const appQuitCommit = (token: number) =>
  invoke<void>("app_quit_commit", { token });

export const appQuitForce = (token: number, reason?: string) =>
  invoke<void>("app_quit_force", { token, reason });

// ---------- On-device vision sidecar ----------

export const visionCatalog = () =>
  invoke<VisionCatalogEntry[]>("vision_catalog");

/** Two files under ONE download_id. Rust rebases the byte counts so the model
 * card can render one aggregate `DownloadProgress` stream. */
export async function visionDownload(
  downloadId: string,
  modelId: string,
  onEvent: (e: DownloadEvent) => void,
): Promise<void> {
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = onEvent;
  downloadChannels.set(downloadId, channel);
  try {
    await invoke<void>("vision_download", {
      download_id: downloadId,
      model_id: modelId,
      on_event: channel,
    });
  } finally {
    downloadChannels.delete(downloadId);
  }
}

export async function visionLoad(
  modelId: string,
  onEvent: (e: LoadEvent) => void,
): Promise<void> {
  const channel = new Channel<LoadEvent>();
  channel.onmessage = onEvent;
  loadChannels.set(modelId, channel);
  try {
    await invoke<void>("vision_load", { model_id: modelId, on_event: channel });
  } finally {
    loadChannels.delete(modelId);
  }
}

export const visionUnload = () => invoke<void>("vision_unload");

export const visionStatus = () => invoke<ModelStatus>("vision_status");

export const visionDelete = (modelId: string) =>
  invoke<void>("vision_delete", { model_id: modelId });

/** Transcribe one image on-device. Collected, not streamed — the result is folded
 *  into a chat turn before anything is rendered. `requestId` puts it on the same
 *  cancel registry as a chat turn, so Stop reaches it. */
export const visionDescribe = (
  requestId: string,
  imageBase64: string,
  prompt?: string,
) =>
  invoke<string>("vision_describe", {
    request_id: requestId,
    image_base64: imageBase64,
    prompt: prompt ?? null,
  });

// ---------- Document buckets (experimental) ----------
//
// Every one of these rejects unless `docs_enabled` is true. The check is in Rust, not
// here: a disabled toggle in the UI is a rendering decision, and the capability gate
// has to hold for a stale or tampered frontend too.

export const docsBucketsList = () => invoke<DocBucket[]>("docs_buckets_list");

export const docsBucketCreate = (label: string) =>
  invoke<string>("docs_bucket_create", { label });

export const docsBucketRename = (bucketId: string, label: string) =>
  invoke<void>("docs_bucket_rename", { bucket_id: bucketId, label });

export const docsBucketDelete = (bucketId: string) =>
  invoke<void>("docs_bucket_delete", { bucket_id: bucketId });

/** Mark every indexed file stale so the next pass re-extracts. Cheap: Rust compares
 *  the extracted text's hash and skips files whose content did not move. */
export const docsBucketReindex = (bucketId: string) =>
  invoke<number>("docs_bucket_reindex", { bucket_id: bucketId });

/** Walk `roots`, take `files` as explicit picks, register what is indexable.
 *
 *  The exclusion table (`.ssh`, `.aws`, `*.pem`, `node_modules`, …) is applied in Rust
 *  and is not overridable from here — an explicit pick reaches past hidden folders but
 *  never past secret material. */
export const docsScan = (bucketId: string, roots: string[], files: string[]) =>
  invoke<DocScanSummary>("docs_scan", { bucket_id: bucketId, roots, files });

export const docsFilesList = (bucketId: string) =>
  invoke<DocFile[]>("docs_files_list", { bucket_id: bucketId });

export const docsFilesNeedingWork = (bucketId: string, limit: number) =>
  invoke<DocFile[]>("docs_files_needing_work", { bucket_id: bucketId, limit });

export const docsFileRemove = (fileId: string) =>
  invoke<void>("docs_file_remove", { file_id: fileId });

export const docsFileFailed = (fileId: string, reason: string) =>
  invoke<void>("docs_file_failed", { file_id: fileId, reason });

/** Re-stat a bucket's sources, flagging what changed or vanished. */
export const docsRefreshStates = (bucketId: string) =>
  invoke<number>("docs_refresh_states", { bucket_id: bucketId });

/** Read a registered source file's bytes so the frontend can extract it.
 *
 *  Extraction lives here rather than in Rust because `pdfText.ts` (pdf.js) is the only
 *  PDF reader in the app and there is no `fs` plugin — so Rust owns paths, hashes and
 *  the database, and the frontend owns turning bytes into text. Rust re-validates the
 *  path on every call: secret denylist, no symlinks, regular file, inside the bucket's
 *  roots. */
export const docsReadSource = async (fileId: string): Promise<Uint8Array> => {
  const bytes = await invoke<ArrayBuffer | number[]>("docs_read_source", {
    file_id: fileId,
  });
  return bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes);
};

export const docsPutText = (fileId: string, pages: DocPutPage[]) =>
  invoke<DocPutOutcome>("docs_put_text", { file_id: fileId, pages });

/** Search from Settings, for a "does this bucket answer my question" check.
 *
 *  Returns structured hits, NOT the text the agent receives: that carries a
 *  "treat this as data" preamble written for a model reading a tool result. */
export const docsSearch = (
  bucketIds: string[],
  query: string,
  limit?: number,
) =>
  invoke<DocSearchPreview[]>("docs_search", {
    bucket_ids: bucketIds,
    query,
    limit: limit ?? null,
  });

// ---------- Unified knowledge ----------

/** During the staged migration, production builds may still expose only the v1 local
 * document commands. Fall back only when the command itself is absent; a real backend
 * error (including a Qdrant permission failure) must reach the user unchanged. */
function commandIsUnavailable(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("unknown command") ||
    message.includes("command not found") ||
    message.includes("not registered")
  );
}

export async function knowledgeBucketsList(): Promise<
  KnowledgeBucketDescriptor[]
> {
  try {
    return await invoke<KnowledgeBucketDescriptor[]>("knowledge_buckets_list");
  } catch (error) {
    if (!commandIsUnavailable(error)) throw error;
    return (await docsBucketsList()).map(localBucketDescriptor);
  }
}

export async function knowledgeSearch(
  buckets: Array<string | KnowledgeBucketRef>,
  query: string,
  limit?: number,
): Promise<Array<DocSearchPreview | KnowledgeSearchHit>> {
  const refs = buckets.map(normalizeKnowledgeBucketRef);
  try {
    return await invoke<KnowledgeSearchHit[]>("knowledge_search", {
      buckets: refs,
      query,
      limit: limit ?? null,
    });
  } catch (error) {
    if (
      !commandIsUnavailable(error) ||
      refs.some((ref) => ref.source !== "local")
    )
      throw error;
    return docsSearch(
      refs.map((ref) => (ref.source === "local" ? ref.bucket_id : "")),
      query,
      limit,
    );
  }
}

export async function knowledgeSearchDetailed(
  buckets: Array<string | KnowledgeBucketRef>,
  query: string,
  limit?: number,
): Promise<KnowledgeSearchResponse> {
  const refs = buckets.map(normalizeKnowledgeBucketRef);
  try {
    return await invoke<KnowledgeSearchResponse>("knowledge_search_detailed", {
      buckets: refs,
      query,
      limit: limit ?? null,
    });
  } catch (error) {
    if (!commandIsUnavailable(error)) throw error;
    const hits = await knowledgeSearch(refs, query, limit);
    return { hits: hits as KnowledgeSearchHit[], warnings: [], partial: false };
  }
}

export async function knowledgeBucketCreate(
  name: string,
  options: { connectionId?: string; profileId?: string } = {},
): Promise<KnowledgeBucketDescriptor | string> {
  try {
    return await invoke<KnowledgeBucketDescriptor>("knowledge_buckets_create", {
      name,
      connection_id: options.connectionId ?? null,
      profile_id: options.profileId ?? null,
    });
  } catch (error) {
    if (
      !commandIsUnavailable(error) ||
      options.connectionId ||
      options.profileId
    )
      throw error;
    return docsBucketCreate(name);
  }
}

export const knowledgeBucketDelete = (bucket: KnowledgeBucketRef) =>
  invoke<void>("knowledge_buckets_delete", {
    bucket,
    confirmation: bucket.source === "qdrant" ? bucket.collection : null,
  });

export const knowledgeEmbeddingModelsList = () =>
  invoke<EmbeddingCatalogEntry[]>("knowledge_embedding_catalog");

/** Download, checksum-verify, load, and probe a catalogued embedding artifact. The
 * retained channel is essential: install continues after `invoke` has begun yielding
 * events, and allowing it to be collected loses the final Ready/Error transition. */
export async function knowledgeEmbeddingModelInstall(
  modelId: string,
  onEvent: (event: EmbeddingInstallEvent | DownloadEvent) => void,
  licenseAccepted = false,
): Promise<void> {
  const downloadId = `embedding-${modelId.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`;
  const channel = new Channel<EmbeddingInstallEvent | DownloadEvent>();
  channel.onmessage = onEvent;
  embeddingInstallChannels.set(downloadId, channel);
  embeddingDownloadIds.set(modelId, downloadId);
  try {
    await invoke<void>("knowledge_embedding_model_download", {
      download_id: downloadId,
      model_id: modelId,
      license_accepted: licenseAccepted,
      on_event: channel,
    });
  } finally {
    embeddingInstallChannels.delete(downloadId);
    embeddingDownloadIds.delete(modelId);
  }
}

export const knowledgeEmbeddingModelCancel = (modelId: string) => {
  const downloadId = embeddingDownloadIds.get(modelId);
  return downloadId
    ? invoke<void>("knowledge_embedding_model_cancel", {
        download_id: downloadId,
      })
    : Promise.resolve();
};

export const knowledgeEmbeddingModelDelete = (modelId: string) =>
  invoke<void>("knowledge_embedding_model_delete", { model_id: modelId });

export const knowledgeEmbeddingModelStatus = () =>
  invoke<EmbeddingModelStatus[]>("knowledge_embedding_model_status");

export const knowledgeEmbeddingProfileCreateCloud = (
  provider: "openai" | "mistral",
  model: string,
  dimensions?: number,
) =>
  invoke<string>("knowledge_embedding_profile_create_cloud", {
    provider,
    model,
    dimensions: dimensions ?? null,
  });

export const knowledgeQdrantConnectionsList = () =>
  invoke<QdrantConnection[]>("knowledge_connections_list");

export async function knowledgeQdrantConnectionSave(
  input: QdrantConnectionInput,
): Promise<string> {
  const connection: QdrantConnectionConfig = {
    label: input.label,
    url: input.url,
    allow_insecure: input.allow_insecure,
  };
  if (input.id) {
    await invoke<void>("knowledge_connections_update", {
      id: input.id,
      connection,
      api_key: input.api_key ?? null,
    });
    return input.id;
  }
  return invoke<string>("knowledge_connections_create", {
    connection,
    api_key: input.api_key ?? null,
  });
}

export const knowledgeQdrantConnectionTest = (connectionId: string) =>
  invoke<QdrantConnection>("knowledge_connections_refresh", {
    id: connectionId,
  });

export const knowledgeQdrantConnectionDelete = (connectionId: string) =>
  invoke<void>("knowledge_connections_delete", { id: connectionId });

export const knowledgeQdrantConnectionClearKey = (connectionId: string) =>
  invoke<void>("knowledge_connections_set_api_key", {
    id: connectionId,
    api_key: "",
  });

export const knowledgeDocumentsList = (
  bucket: KnowledgeBucketRef,
  cursor?: KnowledgePointId | null,
  limit = 50,
) =>
  invoke<KnowledgeDocumentPage>("knowledge_documents_list", {
    bucket,
    cursor: cursor ?? null,
    limit,
  });

export const knowledgeDocumentIngest = (input: KnowledgeDocumentIngestInput) =>
  invoke<KnowledgeJob>("knowledge_document_ingest", {
    bucket: input.bucket,
    document: {
      document_id: input.document_id ?? null,
      source_id: input.source_id ?? null,
      title: input.title,
      source_uri: input.source_uri,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes ?? null,
      mtime_ms: input.mtime_ms ?? null,
    },
    pages: input.pages,
  });

export const knowledgeDocumentUpdate = (
  bucket: KnowledgeBucketRef,
  documentId: string,
  update: KnowledgeDocumentMetadataUpdate,
) =>
  invoke<void>("knowledge_document_update", {
    bucket,
    document_id: documentId,
    update,
  });

export const knowledgeDocumentDelete = (
  bucket: KnowledgeBucketRef,
  documentId: string,
) =>
  invoke<void>("knowledge_document_delete", {
    bucket,
    document_id: documentId,
  });

export const knowledgeJobsList = () =>
  invoke<KnowledgeJob[]>("knowledge_jobs_list");

export const knowledgeJobCancel = (jobId: string) =>
  invoke<KnowledgeJob>("knowledge_jobs_cancel", { id: jobId });

export const knowledgeJobRetry = (jobId: string) =>
  invoke<KnowledgeJob>("knowledge_jobs_retry", { id: jobId });

export const knowledgeBucketEmbed = (bucketId: string) =>
  invoke<KnowledgeJob>("knowledge_bucket_embed", { bucket_id: bucketId });

export const knowledgeBucketSemanticEnable = (
  bucketId: string,
  profileId: string,
) =>
  invoke<KnowledgeJob>("knowledge_bucket_semantic_enable", {
    bucket_id: bucketId,
    profile_id: profileId,
  });

export const knowledgeQdrantTurboQuantSet = (
  bucket: KnowledgeBucketRef,
  config: TurboQuantConfig | null,
) =>
  invoke<KnowledgeBucketDescriptor>("knowledge_qdrant_turbo_quant_set", {
    bucket,
    config,
  });

export const knowledgeQdrantImportRemove = (bucket: KnowledgeBucketRef) =>
  invoke<void>("knowledge_qdrant_import_remove", { bucket });

export const knowledgeCliInstall = () =>
  invoke<string>("knowledge_cli_install");
export interface KnowledgeCliStatus {
  installed: boolean;
  path_ready: boolean;
  path: string;
}
export const knowledgeCliStatus = () =>
  invoke<KnowledgeCliStatus>("knowledge_cli_status");

/** Delete `docs.db` outright. The payoff of a separate database file: this cannot
 *  touch command history, saved hosts or archived transcripts. */
export const docsDestroy = () => invoke<void>("docs_destroy");
