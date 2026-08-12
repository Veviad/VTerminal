import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ApprovalDecision,
  ArchiveDetail,
  ArchiveSessionInput,
  ArchiveSummary,
  CatalogEntry,
  ChatMessage,
  DownloadEvent,
  Effort,
  HistoryEntry,
  HistoryEntryInput,
  ImagePart,
  LoadEvent,
  LocalModel,
  ModelStatus,
  PtyEvent,
  RemoteModel,
  RemoteProbeResult,
  RemoteServer,
  RemoteServerInput,
  Settings,
  SettingsPatch,
  SshConfigCandidate,
  SshHost,
  SshHostInput,
  StreamEvent,
  TerminalContext,
  VisionCatalogEntry,
  WorkspaceRestore,
  WorkspaceSnapshotInput,
} from "./types";

// RETAINED-CHANNEL GOTCHA (same as Cowork's realtimeChannels map):
// a Channel must stay referenced for as long as Rust will send on it, or GC
// kills delivery after invoke() resolves. Map.set/delete are observable side
// effects — bundlers can't tree-shake them.
const ptyDataChannels = new Map<string, Channel<ArrayBuffer>>();
const ptyEventChannels = new Map<string, Channel<PtyEvent>>();
const aiChannels = new Map<string, Channel<StreamEvent>>();
const downloadChannels = new Map<string, Channel<DownloadEvent>>();
const loadChannels = new Map<string, Channel<LoadEvent>>();

// ---------- PTY ----------

export async function ptySpawn(
  sessionId: string,
  opts: { cols: number; rows: number; cwd?: string | null; shell?: string | null },
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
    await invoke<void>("ai_suggest", { requestId, prompt, context, onEvent: channel });
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
  history: { role: string; content: string; image_count?: number }[],
  images: ImagePart[],
  context: TerminalContext,
  onEvent: (e: StreamEvent) => void,
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
  onEvent: (e: StreamEvent) => void,
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
      onEvent: channel,
    });
  } finally {
    aiChannels.delete(requestId);
  }
}

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

export const aiCancel = (requestId: string) => invoke<void>("ai_cancel", { requestId });

/** Collected, not streamed — the result is a single short label, so there is no
 *  channel to retain. Rust sanitizes and rejects unusable output, so a resolved
 *  value is always safe to render. */
export const aiNameSession = (requestId: string, digest: string) =>
  invoke<string>("ai_name_session", { requestId, digest });

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
export const getModelEffort = () => invoke<Record<string, Effort>>("get_model_effort");

export const setModelEffort = (modelId: string, effort: Effort) =>
  invoke<void>("set_model_effort", { model_id: modelId, effort });

// ---------- History ----------

export const historyRecord = (entry: HistoryEntryInput) =>
  invoke<string>("history_record", { entry });

export const historySearch = (query: string, limit = 50, offset = 0) =>
  invoke<HistoryEntry[]>("history_search", { query, limit, offset });

export const historyRecent = (limit = 50) => invoke<HistoryEntry[]>("history_recent", { limit });

/** Wipe recorded commands. `command_history` is never pruned automatically, so
 *  this is the only way it shrinks. */
export const historyClear = () => invoke<void>("history_clear");

// ---------- Remote inference servers ----------
//
// Every command here is `rename_all = "snake_case"` on the Rust side, so the
// payload keys are snake_case throughout.

/** The configured servers. Never touches the network. */
export const remoteServersList = () => invoke<RemoteServer[]>("remote_servers_list");

/** Returns the new server's id. `apiKey` may be sent HERE and only here: create
 *  is the one call where "leave the stored token alone" cannot arise, because
 *  there is nothing stored. Afterwards the token has exactly one mutation path,
 *  so an untouched password field can never silently clear one. */
export const remoteServersCreate = (server: RemoteServerInput, apiKey: string | null) =>
  invoke<string>("remote_servers_create", { server, api_key: apiKey });

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
export const sshHostsGet = (id: string) => invoke<SshHost | null>("ssh_hosts_get", { id });

export const sshHostsCreate = (host: SshHostInput) => invoke<string>("ssh_hosts_create", { host });

export const sshHostsUpdate = (id: string, host: SshHostInput) =>
  invoke<void>("ssh_hosts_update", { id, host });

export const sshHostsDelete = (id: string) => invoke<void>("ssh_hosts_delete", { id });

/** Frecency bump — called when a connect command actually reaches a shell. */
export const sshHostsTouch = (id: string) => invoke<void>("ssh_hosts_touch", { id });

/** Read-only scan of ~/.ssh/config. The app never writes to that file. */
export const sshHostsScanConfig = () =>
  invoke<SshConfigCandidate[]>("ssh_hosts_scan_config");

/** Insert the reviewed rows; returns how many were actually added. */
export const sshHostsImport = (hosts: SshHostInput[]) =>
  invoke<number>("ssh_hosts_import", { hosts });

// ---------- Workspace / session restore ----------

/** Metadata only — bumps the generation and arms the crash-loop guard.
 *  Call exactly once per boot. */
export const workspaceRestore = () => invoke<WorkspaceRestore>("workspace_restore");

export const workspaceSnapshot = (snapshot: WorkspaceSnapshotInput) =>
  invoke<void>("workspace_snapshot", { snapshot });

/** Fetched lazily per tab so a multi-megabyte payload stays off the boot path. */
export const workspaceScrollback = (sessionId: string) =>
  invoke<string | null>("workspace_scrollback", { sessionId });

/** Resets the crash-loop counter once a run has survived a few seconds. */
export const workspaceMarkHealthy = () => invoke<void>("workspace_mark_healthy");

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
  invoke<void>("archive_put", { session });

/** One transaction. Used by the quit path, which archives every tab at once
 *  inside a hard time budget. */
export const archivePutMany = (sessions: ArchiveSessionInput[]) =>
  invoke<void>("archive_put_many", { sessions });

export const archiveDelete = (sessionId: string) =>
  invoke<void>("archive_delete", { sessionId });

export const archiveClear = () => invoke<void>("archive_clear");

/** Returns how many rows went. Called after a retention limit is lowered, so the
 *  change takes effect immediately rather than at the next archive write. */
export const archivePrune = () => invoke<number>("archive_prune");

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

export const getSystemInfo = () =>
  invoke<{ total_ram_bytes: number; os: string; arch: string }>("get_system_info");

// ---------- On-device vision sidecar ----------

export const visionCatalog = () => invoke<VisionCatalogEntry[]>("vision_catalog");

/** Two files under ONE download_id. Rust rebases the byte counts so this looks
 *  like any other download to `DownloadProgress`/`ActiveDownloads`. */
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
export const visionDescribe = (requestId: string, imageBase64: string, prompt?: string) =>
  invoke<string>("vision_describe", {
    request_id: requestId,
    image_base64: imageBase64,
    prompt: prompt ?? null,
  });
