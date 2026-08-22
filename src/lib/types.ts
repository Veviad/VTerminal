// Shared types — the TS mirror of the Rust serde enums and structs.
// Wire casing: Rust emits snake_case fields inside tagged unions (Cowork convention).

// ---------- Sessions & blocks ----------

// The tab label is DERIVED, never stored — `resolveSessionTitle` in
// lib/sessionTitle.ts folds the fields below together with the live
// `SessionUiState`. Storing it is what produced the "every tab is called
// maholick" bug: OSC 7 wrote basename($PWD) into a `title` field, and a fresh
// shell starts in $HOME.
export interface Session {
  id: string;
  shell: string;
  cwd: string | null;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
  /** Saved SSH host this tab was opened for — PROVENANCE, not liveness.
   *  Survives an `exit` back to the local shell and survives a restore; it is
   *  what powers the tab label and the Reconnect affordance. The live "we are
   *  inside ssh right now" signal is `sessionUi.remote`. */
  hostId: string | null;
  /** Label of the saved host this tab was opened for. Outlives the connection
   *  (same provenance rule as `hostId`), so a tab whose ssh exited still reads
   *  as that host's tab. */
  hostLabel: string | null;
  /** Explicit rename. Beats every derived source, including a live remote —
   *  once a human names a tab, nothing may quietly rename it. */
  userTitle: string | null;
  /** Model-generated name. Ranks below the host identity but above anything
   *  derived from cwd or the running command. */
  aiTitle: string | null;
  /** Stable tab number for the last-resort label. Assigned as the smallest
   *  unused positive integer, NOT a monotonic counter, so closing tabs never
   *  renumbers the survivors. Load-bearing when shell integration is off:
   *  without OSC 7 there is no cwd, so this is the only label a tab ever gets. */
  ordinal: number;
  /** Archive row this tab was reopened from, if any. When the tab is later
   *  closed, its own archive write collapses that row into the new one — so
   *  reopening the same work repeatedly stays ONE entry rather than a chain of
   *  near-duplicates that evicts unrelated sessions from the retention budget.
   *
   *  Optional rather than required-nullable (unlike its neighbours): only reopen
   *  ever sets it, so absent and "not reopened from anything" mean the same
   *  thing, and every existing fixture stays valid. */
  archivedFrom?: string | null;
}

/** Everything a new tab can be told to start as. One shape serves the three
 *  callers that need it: a plain new tab (all defaults), a saved-host connect,
 *  and session restore. */
export interface LaunchSpec {
  /** Local directory to start in. Ignored (with a log line) if it does not
   *  resolve to a readable directory on THIS machine — never fatal. */
  cwd?: string | null;
  /** Shell override on macOS; Windows always uses the fixed WSL2/Bash backend. */
  shell?: string | null;
  hostId?: string | null;
  /** Becomes `Session.hostLabel` — the saved-host identity, not a rename. */
  title?: string | null;
  /** Becomes `Session.userTitle`. Set by restore, to give a tab back the name
   *  the user gave it last run. */
  userTitle?: string | null;
  /** Becomes `Session.archivedFrom`. Set only by reopen. */
  archivedFrom?: string | null;
  /** Typed at the FIRST prompt, with `\r`. Never model-authored — must pass
   *  `sanitizeCommand`. Deliberately frontend-side rather than in SpawnParams:
   *  Rust writing to the master before zsh's first prompt races shell init. */
  initialCommand?: string | null;
  /** false during a multi-tab restore, so activation happens once at the end
   *  instead of churning a WebGL context per tab. */
  activate?: boolean;
  /** Seed dims for a tab whose container is not laid out yet (restore) —
   *  without this, background tabs spawn at 80x24 and reflow on first view. */
  dims?: { cols: number; rows: number };
  /** Serialized scrollback, written BEFORE the shell spawns. */
  replay?: string | null;
}

export type BlockState = "running" | "done" | "trimmed";

export interface Block {
  id: string;
  sessionId: string;
  command: string;
  state: BlockState;
  exitCode: number | null;
  /** Absolute buffer line of the command's first output row (marker at OSC 133;C). */
  startLine: number;
  endLine: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Who typed it. Agent-run commands are real shell commands (they land in
   *  history like any other) — this only makes them attributable in the UI. */
  origin: "user" | "agent";
}

// ---------- PTY events (lifecycle channel; data plane is the raw channel) ----------

export type PtyEvent =
  | { type: "Spawned"; pid: number }
  | { type: "Exit"; exit_code: number | null }
  | { type: "Error"; message: string }
  | { type: "Warning"; message: string };

// ---------- AI streaming ----------

export type AgentTargetRole = "local" | "remote";

export type StreamEvent =
  | { type: "Started"; request_id: string; model: string }
  | { type: "Delta"; content: string }
  | { type: "ThinkingDelta"; content: string }
  /** `read_only` / `network` are `agent::policy`'s verdict on the command text.
   *  The backend classifies, the frontend owns the permission mode and applies
   *  `autoRuns` — see lib/permissionMode.ts. */
  | {
      type: "CommandProposal";
      approval_id: string;
      command: string;
      explanation: string;
      read_only: boolean;
      network: boolean;
      /** Present only for a linked Sidecar run. */
      target_role?: AgentTargetRole;
      target_session_id?: string;
    }
  /** Policy refused a command outright: never proposed, never run, no approval
   *  gate to settle. Rendered through the existing `"blocked"` command status. */
  | {
      type: "CommandBlocked";
      command: string;
      reason: string;
      target_role?: AgentTargetRole;
      target_session_id?: string;
    }
  /** Backend asks the FRONTEND to run this in the session's live PTY and report
   *  back via submitCommandResult — the backend cannot see PTY bytes itself. */
  | {
      type: "RunInTerminal";
      approval_id: string;
      /** Guards against a stale run driving the wrong tab. */
      session_id: string;
      command: string;
      timeout_secs: number;
      /** Repeated from the proposal: an auto-run command never drew a card, so
       *  this is the only place its justification reaches the transcript. */
      explanation: string;
      target_role?: AgentTargetRole;
      target_session_id?: string;
    }
  | {
      type: "CommandStarted";
      approval_id: string;
      command: string;
      explanation: string;
      target_role?: AgentTargetRole;
      target_session_id?: string;
    }
  | { type: "CommandOutput"; approval_id: string; chunk: string; is_stderr: boolean }
  /** exit_code is null when the command outlived its timeout — it is still
   *  running in the user's terminal and was NOT killed. */
  | {
      type: "CommandResult";
      approval_id: string;
      exit_code: number | null;
      duration_ms: number;
      error?: string | null;
      target_role?: AgentTargetRole;
      target_session_id?: string;
    }
  /** The loop appended these queued steering messages to the transcript. This is
   *  the ONLY thing that clears a message's "queued" badge — one that never gets
   *  a SteerDelivered is one the model never saw. */
  | { type: "SteerDelivered"; ids: string[] }
  /** Storage-safe model history emitted only at stable round boundaries. It has
   *  tool-call ids/results needed for continuation, but no system prompt or
   *  image bytes. Opaque for the same reason as ChatMessage below. */
  | { type: "Checkpoint"; sequence: number; transcript: ChatMessage[] }
  | { type: "Done"; prompt_tokens: number; completion_tokens: number }
  /** The loop stopped at a guard rail instead of finishing. NOT an error: the
   *  transcript is intact and resumable, so this renders as a calm banner with a
   *  Continue button. Note the two casing conventions — `StreamEvent` is tagged
   *  with no `rename_all` so the tag is PascalCase, while `reason` comes from
   *  `PauseReason`, which is snake_case. Both are pinned by Rust tests. */
  | {
      type: "Paused";
      reason: "step_limit" | "context_limit";
      /** May EXCEED `limit`: a mid-run steer extends the budget up to 3x. */
      steps: number;
      /** The value in Settings → Agent, never the extended budget. */
      limit: number;
      prompt_tokens: number;
      completion_tokens: number;
      /** 0 when the guard was off (remote servers, or a provider that reported no
       *  usage) — never render this as the model's window. */
      context_used: number;
      context_limit: number;
    }
  | { type: "Cancelled" }
  | { type: "Error"; message: string };

export type ApprovalDecision = "run" | "skip" | "stop";

export interface BlockSummary {
  command: string;
  exit_code: number | null;
  output_tail: string;
}

/** The visible tab is inside a nested shell (ssh, docker exec, …). While this
 *  is set the local cwd/branch describe a DIFFERENT machine and must not be
 *  presented to the model as current. */
export interface RemoteContext {
  kind: string;
  target: string | null;
}

export interface TerminalContext {
  session_id: string;
  cwd: string | null;
  shell: string;
  git_branch: string | null;
  os: string;
  recent_blocks: BlockSummary[];
  remote: RemoteContext | null;
  /** Capped tail of what is actually on screen — the only grounding that
   *  survives a shell emitting no OSC markers at all. */
  screen_tail: string;
  /** Whether OSC 133 marks are actually arriving for this session. */
  shell_integration: boolean;
}

/** Optional second execution environment for a Sidecar Agent turn. */
export interface SidecarAgentTargets {
  local: TerminalContext;
  remote: TerminalContext;
}

/**
 * The MODEL's view of a conversation, mirroring Rust's `provider::ChatMessage`.
 *
 * Distinct from `AiMessage`, which is what the panel renders — and neither is
 * derivable from the other. This one has tool-call ids and the tool-result text
 * the model actually saw; that one has `thinking`, command-card status, and the
 * output the USER saw.
 *
 * Treat values of this type as OPAQUE: never reorder, never edit a `content`, and
 * never drop an element. Dropping an assistant turn that carries `tool_calls`
 * orphans its tool result, which Anthropic answers with a 400. Rust owns all
 * trimming and repair.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  tool_call_id?: string;
  /** Present only on the turn being sent. Rust strips these from every history
   *  turn (`HISTORY_IMAGE_TURNS`), so a round-tripped transcript never has them. */
  images?: ImagePart[];
}

/** The WIRE shape of an image, mirroring Rust's `provider::ImagePart`.
 *
 *  Narrower than `Attachment` on purpose: name, size and dimensions are for the
 *  panel, and putting them in every request body would be pure weight. */
export interface ImagePart {
  media_type: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

/**
 * Why a still-running command looks stuck, classified from live PTY bytes.
 *
 * `tui` is the only one the app acts on by itself (a full-screen program has the
 * terminal and the agent cannot press `q`). `password` hands the terminal back to
 * the user and pauses the agent's clocks. `input` and `idle` only surface a
 * button — `idle` in particular is the shape of legitimately slow work like
 * `aide --init`, which produces no output for many minutes and must not be
 * killed.
 */
export type CommandStall = "tui" | "password" | "input" | "idle";

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Folded reasoning from a thinking-enabled run (rendered collapsible). */
  thinking?: string;
  /** Which model produced this. Recorded per message so switching models
   *  mid-conversation does not relabel everything said before it. */
  model?: string;
  /** Tokens this exchange cost, once the stream finished. */
  usage?: { prompt: number; completion: number };
  /** Set on a message typed while an agent run was already in flight.
   *  "queued" = waiting for the next round boundary; "undelivered" = the run
   *  ended before the loop picked it up. Absent once the model has seen it.
   *  Not archived — `sessionArchive` maps fields explicitly. */
  steer?: "queued" | "undelivered";
  /** Files sent with THIS turn. Stamped in the send path from the pending list.
   *  Archived as metadata plus a disk path, never as inline bytes — see
   *  `sessionArchive`, which maps fields explicitly. */
  attachments?: Attachment[];
  /** "command" messages render as terminal-output cards in agent transcripts. */
  kind?: "text" | "command";
  command?: {
    command: string;
    output: string;
    exitCode: number | null;
    /** "timeout" = still running in the terminal, never killed.
     *  "blocked" = never executed (the terminal was busy, or policy refused it —
     *  see `agent::policy` and StreamEvent::CommandBlocked). */
    status: "running" | "done" | "skipped" | "timeout" | "blocked";
    /** Short human note shown under the card (why it timed out / was blocked). */
    note?: string;
    /** The model's one-sentence reason for running this. Shown on the card —
     *  which matters most for a command that auto-ran, since there was no
     *  approval card to read it on. Not archived: `sessionArchive` maps command
     *  fields explicitly, and a restored transcript shows the command alone. */
    explanation?: string;
    /** Live hang classification while `status === "running"`. Never archived —
     *  `sessionArchive` maps command fields explicitly and skips this. */
    stall?: CommandStall;
    /** The line actually typed, when `hardenCommand` changed it. Shown so the
     *  user can see the env prefix they did not approve. Not archived. */
    typed?: string;
    /** Persisted display provenance for Sidecar command timelines. */
    targetRole?: AgentTargetRole;
    targetSessionId?: string;
    targetLabel?: string;
  };
}

/**
 * A file the user attached to a chat turn.
 *
 * The panel's DISPLAY type, camelCase like `AiMessage`. The shape sent to a
 * provider is narrower — `{media_type, data}`, mirroring Rust's `ImagePart` —
 * and keeping the two separate is what lets this one carry a name, dimensions
 * and a disk path without putting any of them into every request body.
 */
export interface Attachment {
  id: string;
  kind: "image" | "text";
  name: string;
  mediaType: string;
  /** Present only when composer text was promoted to an attachment on paste. */
  origin?: "pasted-text";
  /** Logical lines in that original paste; terminal newlines do not add lines. */
  lineCount?: number;
  /** Size AFTER normalization (downscale + re-encode), not the file on disk. */
  bytes: number;
  /** Images: base64, no `data:` prefix. Absent on a transcript restored from the
   *  archive until `attachment_read` refills it — the archive stores the path. */
  data?: string;
  /** Images: post-downscale dimensions, so the thumbnail box can reserve space. */
  width?: number;
  height?: number;
  /** Text: the UTF-8 body, already capped. Folded into the prompt at send time,
   *  never sent as an image part. */
  text?: string;
  truncated?: boolean;
  /** Where Rust persisted the bytes. Set once `attachment_put` has run. */
  path?: string;
}

// ---------- Models ----------

export type DownloadEvent =
  | { type: "Started"; download_id: string; total_bytes: number | null; resumed_from: number }
  | { type: "Progress"; downloaded: number; total_bytes: number | null; bytes_per_sec: number }
  | { type: "Completed"; model_id: string; path: string }
  | { type: "Cancelled" }
  | { type: "Error"; message: string };

export type LoadEvent =
  | { type: "Phase"; name: string }
  | { type: "Ready"; context_len: number }
  | { type: "Error"; message: string };

export interface LocalModel {
  id: string;
  repo_id: string;
  filename: string;
  path: string;
  size_bytes: number;
  quant: string;
  downloaded_at: string;
}

/** Normalized reasoning-effort ladder. Mirrors `models::catalog::Effort`. */
export type Effort = "off" | "low" | "medium" | "high" | "max";

export const EFFORT_ORDER: Effort[] = ["off", "low", "medium", "high", "max"];

/** Providers with a built-in catalog row. Each non-local one has exactly one API
 *  key field in Settings, hence exactly one section in ModelsSettings. */
export type BuiltInProviderId = "local" | "anthropic" | "openai" | "mistral";

/** `"remote"` covers every user-configured server. The PRODUCT is not a provider:
 *  it only decides which endpoint a probe asks for a model list, so it lives on
 *  the server record (`RemoteRef.kind`) rather than in this union. Keeping it out
 *  is what stops the settings UI from growing an empty section per kind. */
export type ProviderId = BuiltInProviderId | "remote";

/** Quality level. Every provider offers exactly one model per tier. */
export type Tier = "fast" | "balanced" | "max";

export type LocalFamily = "qwen" | "gemma";

export interface LocalSpec {
  repo_id: string;
  filename: string;
  size_bytes: number;
  min_ram_gb: number;
  family: LocalFamily;
}

// ---------- Remote inference servers ----------

export type RemoteServerKind = "ollama" | "lmstudio" | "openai_compatible";

/** Which configured server serves a catalog row. */
export interface RemoteRef {
  server_id: string;
  /** Denormalized on purpose: the server list is component-local state, so the
   *  model menu has no way to look this up. */
  server_label: string;
  kind: RemoteServerKind;
  /** Agent mode needs tool calling. True when the server did not say, since most
   *  do not and refusing on silence would block working setups. */
  supports_tools: boolean;
}

/** What the settings form sends. Note what is absent: the token. Secrets travel
 *  on their own write path (`remoteServersSetApiKey`), because an update payload
 *  cannot tell "leave it alone" from "clear it". */
export interface RemoteServerInput {
  kind: RemoteServerKind;
  label: string;
  /** Server ROOT — scheme, host, port, optional path prefix. Never an API path:
   *  the backend appends its own. */
  base_url: string;
}

/** One enabled model. Sent straight back from a probe candidate, so enabling
 *  costs no second round trip. */
export interface RemoteModel {
  /** What goes on the wire. May itself contain `/`. */
  wire_model: string;
  label: string;
  context_tokens: number;
  supports_vision: boolean;
  supports_tools: boolean;
}

export interface RemoteServer extends RemoteServerInput {
  id: string;
  /** Presence only. The token itself never crosses back. */
  has_api_key: boolean;
  models: RemoteModel[];
}

/** One model a server reported. */
export interface RemoteProbeCandidate extends RemoteModel {
  /** False when `context_tokens` is an assumed default, not something the server
   *  said. The picker renders the difference. */
  enriched: boolean;
  /** "chat" | "embedding" | "rerank" | "unknown" — a hint, not a filter. The
   *  picker pre-unchecks anything that is not chat. */
  role: string;
  /** LM Studio only: "loaded" | "not-loaded". */
  state: string | null;
  /** Already enabled — the picker pre-checks these. Plays the role
   *  `SshConfigCandidate.existing_id` plays for the ssh importer. */
  already_enabled: boolean;
}

export interface RemoteProbeResult {
  base_url: string;
  /** The URL actually asked for the model list. */
  endpoint: string;
  models: RemoteProbeCandidate[];
  /** Non-fatal notes. A hard failure is a rejected promise, not a field. */
  warnings: string[];
}

/** One row of the allowlist, flattened together with this machine's reality. */
export interface CatalogEntry {
  id: string;
  provider: ProviderId;
  tier: Tier;
  label: string;
  description: string;
  wire_model: string;
  context_tokens: number;
  /** The ONLY rungs this model accepts — render exactly these, nothing else. */
  efforts: Effort[];
  default_effort: Effort;
  supports_temperature: boolean;
  /** Whether this model can reach the web via the PROVIDER's own server-side
   *  tools during a single request. */
  native_web_fetch: boolean;
  /** Whether this model can be sent images. False for every local entry — a
   *  claim about this app's engine, not about the weights: `chat_template.rs`
   *  renders content as a plain string and llama.cpp needs an mmproj projector
   *  the registry does not download. */
  supports_vision: boolean;
  local: LocalSpec | null;
  /** Remote only: which configured server serves this. Mutually exclusive with
   *  `local`, and the grouping key for the per-server sections in Settings. */
  remote: RemoteRef | null;
  /** Local only: fits this machine's memory. */
  fits: boolean;
  /** Local only: the GGUF is already on disk. */
  downloaded: boolean;
  /** API only: a key is stored for this provider. */
  configured: boolean;
  /** Effective effort: the stored choice clamped, or the model default. */
  effort: Effort;
}

// ---------- On-device vision sidecar ----------

export type VisionArch = "qwen3_vl" | "paddle_ocr";

/** Mirrors `models::vision::VisionModel`. Deliberately narrower than
 *  `CatalogEntry`: a transcriber has no tier, no effort ladder and no temperature. */
export interface VisionModel {
  id: string;
  label: string;
  description: string;
  repo_id: string;
  filename: string;
  size_bytes: number;
  mmproj_filename: string;
  mmproj_size_bytes: number;
  min_ram_gb: number;
  context_tokens: number;
  arch: VisionArch;
  default_prompt: string;
}

export interface VisionCatalogEntry extends VisionModel {
  /** Weights + projector. Always use this, never `size_bytes`. */
  total_bytes: number;
  /** Fits ALONGSIDE the active chat model, not in isolation. */
  fits: boolean;
  /** What the pair needs, so the UI can name a number instead of "too big". */
  required_ram_gb: number;
  /** Both files present, not just the weights. */
  downloaded: boolean;
  selected: boolean;
}

export type ModelState = "idle" | "loading" | "ready";

export interface ModelStatus {
  loaded: string | null;
  state: ModelState;
  available: boolean;
  acceleration?: LocalAccelerationInfo;
}

export interface LocalAccelerationInfo {
  backend: string;
  device_name: string | null;
  device_memory_bytes: number | null;
  fallback_reason: string | null;
}

// ---------- History ----------

export interface HistoryEntryInput {
  session_id: string;
  cwd: string;
  command: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_tail: string | null;
  git_branch: string | null;
  started_at: string;
}

export interface HistoryEntry extends HistoryEntryInput {
  id: string;
  shell: string;
  ended_at: string | null;
}

// ---------- SSH hosts ----------

/** A saved server. Note what is absent: no password, no passphrase, no key
 *  material — `identity_file` is a PATH. Auth is keys and ssh-agent. */
export interface SshHostInput {
  label: string;
  hostname: string;
  username: string | null;
  port: number | null;
  identity_file: string | null;
  /** `-J` ProxyJump target, e.g. `jump@bastion:2222`. */
  jump_host: string | null;
  /** Free-text extra ssh flags. Tokenized and re-quoted per token, and every
   *  token must be a flag — a bare word there would be read as the hostname. */
  extra_args: string | null;
  /** `cd` into this on connect (quoted for the REMOTE shell). */
  remote_dir: string | null;
  /** Run on connect, verbatim, so operators like `||` work. */
  post_connect: string | null;
  tag: string | null;
  color: string | null;
  source?: "manual" | "ssh_config";
  config_alias?: string | null;
}

/** One `Host` block from ~/.ssh/config, pre-checked against the saved list. */
export interface SshConfigCandidate {
  host: SshHostInput;
  /** Row this would duplicate — the review UI pre-unchecks these. */
  existing_id: string | null;
}

export interface SshHost extends SshHostInput {
  id: string;
  source: "manual" | "ssh_config";
  config_alias: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------- Session restore ----------

/** Per-tab metadata. The scrollback blob is fetched separately so the boot path
 *  never deserializes megabytes before showing a terminal. */
export interface SessionSnapshotMeta {
  session_id: string;
  tab_index: number;
  title: string;
  shell: string;
  cwd: string | null;
  host_id: string | null;
  /** Recorded for the restore separator only — never replayed into
   *  `sessionUi.remote`, which would claim a connection that is dead. */
  remote_kind: string | null;
  remote_target: string | null;
  cols: number;
  rows: number;
  script_version: string | null;
  scrollback_lines: number;
  updated_at: string;
}

export interface SessionSnapshotInput {
  session_id: string;
  tab_index: number;
  title: string;
  shell: string;
  cwd: string | null;
  host_id: string | null;
  remote_kind: string | null;
  remote_target: string | null;
  cols: number;
  rows: number;
  script_version: string | null;
  /** null = metadata-only tick; the stored blob is preserved. */
  scrollback: string | null;
  scrollback_lines: number | null;
}

// ---------- Session archive ----------

/** One row of the browser list. No blobs: the scrollback and the model
 *  transcript are separate lazy fetches, so opening the browser stays instant. */
export interface ArchiveSummary {
  session_id: string;
  title: string;
  shell: string;
  cwd: string | null;
  host_id: string | null;
  /** Display and the reopen banner only — never replayed as a live connection. */
  remote_kind: string | null;
  remote_target: string | null;
  opened_at: string;
  closed_at: string;
  close_reason: "closed" | "quit" | "crash";
  scrollback_lines: number;
  message_count: number;
  agent_command_count: number;
  history_command_count: number;
  /** Catalog id of the model that produced the transcript, "" if there was none. */
  model: string;
  /** Lets a row promise AI continuity without fetching the transcript to check. */
  has_model_transcript: boolean;
  first_prompt: string | null;
}

export interface ArchivedMessage {
  id: string;
  sort_order: number;
  role: "user" | "assistant";
  kind: "text" | "command" | "compaction";
  content: string;
  thinking: string | null;
  command: {
    command: string;
    output: string;
    exit_code: number | null;
    status: "running" | "done" | "skipped" | "timeout" | "blocked";
    note: string | null;
    target_role: AgentTargetRole | null;
    target_label: string | null;
  } | null;
  /** Always present (empty when the turn had none) — Rust serializes a `Vec`. */
  attachments: ArchivedAttachment[];
  created_at: string;
}

export interface ArchivedAttachment {
  id: string;
  kind: "image" | "text";
  name: string;
  media_type: string;
  bytes: number;
  /** null when the disk write failed; the chip renders by name instead. */
  path: string | null;
  width: number | null;
  height: number | null;
}

export interface ArchiveDetail {
  summary: ArchiveSummary;
  messages: ArchivedMessage[];
}

/** Deliberately shaped like `SessionSnapshotInput` plus the archive-only fields,
 *  so one `buildSnapshot()` feeds both writers. */
export interface ArchiveSessionInput {
  session_id: string;
  title: string;
  shell: string;
  cwd: string | null;
  host_id: string | null;
  remote_kind: string | null;
  remote_target: string | null;
  cols: number;
  rows: number;
  script_version: string | null;
  /** null = this write carries no blob; the stored one is preserved. */
  scrollback: string | null;
  scrollback_lines: number | null;
  opened_at: string;
  /** true for the debounced turn-end tick, false for close/quit. */
  is_open: boolean;
  close_reason: "closed" | "quit" | "crash" | null;
  /** null = keep the stored rows. An array replaces them wholesale. */
  messages: ArchiveMessageInput[] | null;
  /** null = keep the stored transcript. */
  model_transcript: ChatMessage[] | null;
  model: string | null;
  /** The archive row this session was reopened from: collapsed into this one, so
   *  one thread of work stays one entry instead of a chain of near-duplicates. */
  supersedes: string | null;
}

export interface ArchiveMessageInput {
  role: "user" | "assistant";
  kind: "text" | "command" | "compaction" | null;
  content: string;
  thinking: string | null;
  command: {
    command: string;
    output: string;
    exit_code: number | null;
    status: string;
    note: string | null;
    target_role: AgentTargetRole | null;
    target_label: string | null;
  } | null;
  /** Metadata and a disk path, never the bytes. */
  attachments: ArchiveAttachmentInput[] | null;
  created_at: string;
}

export interface ArchiveAttachmentInput {
  kind: "image" | "text";
  name: string;
  media_type: string;
  bytes: number;
  path: string | null;
  width: number | null;
  height: number | null;
}

export interface WorkspaceSnapshotInput {
  active_session_id: string | null;
  sessions: SessionSnapshotInput[];
}

export interface WorkspaceRestore {
  sessions: SessionSnapshotMeta[];
  active_session_id: string | null;
  /** The previous run ended without completing the clean-exit barrier. */
  crashed: boolean;
  /** Restore was disabled, env-overridden, or bailed out by the crash guard. */
  skipped: boolean;
}

// ---------- Settings ----------

export interface Settings {
  theme: string;
  font_size: number;
  scrollback_lines: number;
  cursor_style: "block" | "bar" | "underline";
  cursor_blink: boolean;
  copy_on_select: boolean;
  shell_path: string | null;
  shell_integration_enabled: boolean;
  active_model_id: string;
  temperature: number;
  max_context_tokens: number;
  auto_load_model_on_start: boolean;
  /** Chosen on-device vision sidecar; null = none. */
  vision_model_id: string | null;
  /** null = use the chosen model's own default_prompt. */
  vision_prompt: string | null;
  vision_auto_load_on_start: boolean;
  /** Presence only; the token is write-only and never crosses IPC. */
  has_hf_token: boolean;
  models_dir: string | null;
  has_anthropic_api_key: boolean;
  has_openai_api_key: boolean;
  has_mistral_api_key: boolean;
  credential_store_status: "ready" | "blocked";
  history_enabled: boolean;
  history_capture_output: boolean;
  send_context_to_ai: boolean;
  ai_session_naming: boolean;
  restore_sessions_on_start: boolean;
  restore_scrollback_lines: number;
  archive_enabled: boolean;
  archive_max_sessions: number;
  archive_max_age_days: number;
  ai_panel_open: boolean;
  /** Share of the window, or null when never dragged — `useSettings` then
   *  migrates from the legacy `ai_panel_width`. */
  ai_panel_ratio: number | null;
  /** LEGACY, read-only. Never sent back; only the migration above reads it. */
  ai_panel_width: number;
  agent_max_iterations: number;
  agent_command_timeout_secs: number;
  /** Whether the AI may reach the web at all: gates the server-side fetch tool
   *  for models that have one, picks the agent/ask web prompt tier, and makes
   *  `agent::policy` refuse network commands before they are proposed. */
  ai_web_access: boolean;
  /** Opt-in experimental release checks. Installation always remains explicit. */
  auto_update_enabled: boolean;
  /** Document buckets, EXPERIMENTAL and off by default. Enforced in Rust: while
   *  false the agent is offered no `search_docs` tool and every `docs_*` command
   *  refuses, so this is the capability gate rather than a UI preference. */
  docs_enabled: boolean;
  /** Reusable Runbooks, EXPERIMENTAL and off by default. Rust gates every
   *  runbook command; this value is not merely a visibility preference. */
  runbooks_enabled: boolean;
  /** How much terminal output a runbook run keeps as an audit record. This is a
   *  FLOOR: preflight may raise a single run above it and can never drop below
   *  it, and `runbooks_start` re-applies the clamp so a stale frontend cannot
   *  lower the audit level. `runbook` defers to the package's own request.
   *  Spelled out rather than imported: this file is deliberately import-free.
   *  `EvidenceRecordingPolicy` in lib/runbooks.ts is the same union. */
  runbooks_output_recording: "none" | "runbook" | "all";
  log_level: string;
}

// ---------- Document buckets (experimental) ----------

/** Per-file indexing state. Mirrors the CHECK constraint in `docs.db` v1.
 *
 *  `stale` and `missing` are ordinary states, not errors: sources are referenced by
 *  path, so files WILL be edited, moved and deleted, and the UI reports that rather
 *  than failing an operation the user did not perform. */
export type DocFileState = "pending" | "indexed" | "stale" | "missing" | "failed";

export interface DocBucket {
  id: string;
  label: string;
  created_at: number;
  indexed_at: number | null;
  /** `null` until an embedding model indexes it. Stage 1 buckets are keyword-only. */
  embed_model_id: string | null;
  chunk_chars: number;
  chunk_overlap: number;
  /** Folders and exact file paths the bucket may read — its confinement boundary. */
  roots: string[];
  file_count: number;
  chunk_count: number;
  pending_count: number;
  stale_count: number;
  missing_count: number;
  failed_count: number;
}

export interface DocFile {
  id: string;
  bucket_id: string;
  path: string;
  name: string;
  media_type: string;
  size_bytes: number;
  mtime_ms: number;
  state: DocFileState;
  state_reason: string | null;
  page_count: number | null;
  chunk_count: number;
  indexed_at: number | null;
}

/** What a scan found and, just as importantly, what it refused. Every count is
 *  surfaced: a silent skip reads as "everything was indexed". */
export interface DocScanSummary {
  added: number;
  found: number;
  skipped_secret: number;
  skipped_symlink: number;
  skipped_noise: number;
  skipped_unsupported: number;
  skipped_too_large: number;
  skipped_unreadable: number;
  truncated: number;
}

export type DocPutOutcome =
  | { kind: "unchanged" }
  | { kind: "indexed"; chunks: number };

export interface DocSearchPreview {
  file_name: string;
  page: number | null;
  heading: string | null;
  text: string;
  score: number;
}

// ---------- Unified knowledge sources ----------

/** A stable, source-qualified bucket identity.
 *
 * Local ids deliberately keep their old value instead of being prefixed. This lets the
 * frontend migrate in-memory attachments without invalidating the established `docs_*`
 * compatibility commands, while Qdrant collections can never collide with them. */
export type KnowledgeBucketRef =
  | { source: "local"; bucket_id: string }
  | { source: "qdrant"; connection_id: string; collection: string };

export type KnowledgeCompatibility =
  | "managed_compatible"
  | "attach_only"
  | "requires_profile"
  | "unmanaged"
  | "legacy_import"
  | "upgrade_required"
  | "incompatible"
  | "unreadable";

export type EmbeddingProvider =
  | "local"
  | "openai"
  | "mistral"
  | "ollama"
  | "lm_studio";

export interface EmbeddingProfile {
  id: string;
  fingerprint: string;
  label: string;
  provider: EmbeddingProvider;
  model: string;
  revision: string | null;
  dimensions: number;
  pooling: "mean" | "last_token" | "cls" | "provider";
  normalized: boolean;
  query_prefix: string | null;
  document_prefix: string | null;
  max_tokens: number;
  distance: "cosine";
  available: boolean;
}

export type EmbeddingModelState =
  | "not_installed"
  | "downloading"
  | "verifying"
  | "loading"
  | "ready"
  | "error";

export interface EmbeddingModelStatus {
  id: string;
  state: EmbeddingModelState;
  installed: boolean;
  loaded: boolean;
  downloaded_bytes: number;
  total_bytes: number | null;
  error: string | null;
  profile_id: string | null;
  acceleration: LocalAccelerationInfo | null;
}

export interface EmbeddingCatalogEntry {
  id: string;
  label: string;
  description: string;
  provider: "local" | "openai" | "mistral" | "remote";
  model: string;
  dimensions: number[];
  default_dimension: number;
  context_tokens: number;
  download: {
    repo_id: string;
    filename: string;
    size_bytes: number;
    min_ram_gb: number;
    requires_license?: boolean;
  } | null;
  installed: boolean;
  available: boolean;
  unavailable_reason?: string | null;
  recommended: boolean;
  privacy: "local" | "cloud";
}

export type EmbeddingInstallEvent =
  | { type: "Started"; total_bytes: number | null; resumed_from: number }
  | { type: "Progress"; downloaded: number; total_bytes: number | null; bytes_per_sec: number }
  | { type: "Phase"; phase: "verifying" | "loading" }
  | { type: "Ready"; profile_id: string }
  | { type: "Cancelled" }
  | { type: "Error"; message: string };

export type QdrantConnectionStatus = "unchecked" | "checking" | "connected" | "stale" | "error";

/** The backend never serializes an API key. `has_api_key` is the only credential
 * information allowed back over IPC. */
export interface QdrantConnection {
  id: string;
  label: string;
  url: string;
  has_api_key: boolean;
  allow_insecure: boolean;
  status: QdrantConnectionStatus;
  server_version: string | null;
  last_checked_at: number | null;
  error: string | null;
  /** Accessible collections without a valid VTerminal collection contract are
   * deliberately hidden from the normal Knowledge UI. */
  hidden_unmanaged_count?: number;
  collections?: KnowledgeBucketDescriptor[];
}

export interface QdrantConnectionInput {
  id?: string;
  label: string;
  url: string;
  /** undefined means keep the stored key when editing; an empty string is accepted
   * only for a new, explicitly unauthenticated self-hosted connection. */
  api_key?: string;
  allow_insecure: boolean;
}

export interface QdrantConnectionConfig {
  label: string;
  url: string;
  allow_insecure: boolean;
}

export interface KnowledgeBucketDescriptor {
  ref: KnowledgeBucketRef;
  label: string;
  connection_label: string | null;
  profile: EmbeddingProfile | null;
  compatibility: KnowledgeCompatibility;
  compatibility_reason: string | null;
  attachable: boolean;
  writable: boolean;
  /** Discovery performs no surprise write probe. Unknown allows an explicit upload,
   * whose success or precise 403 teaches the backend the real capability. */
  write_capability?: "unknown" | "read_only" | "read_write";
  manageable: boolean;
  /** The backend verified this is an owned collection whose deletion may be
   * attempted. Qdrant still performs the actual permission check. */
  deletable?: boolean;
  file_count: number;
  chunk_count: number;
  pending_count: number;
  stale: boolean;
  error: string | null;
  quantization?:
    | { state: "off" }
    | { state: "turbo"; bits: TurboQuantBits; always_ram: boolean }
    | { state: "other"; kind: string };
  /** True when compatibility comes from an explicit local guided-import binding. */
  imported?: boolean;
  /** Remediation hints for a valid managed collection whose immutable profile
   * is not currently runnable on this client. */
  required_builtin_model_id?: string | null;
  required_provider?: EmbeddingProvider | null;
  /** Backend-derived capability; the command still enforces the version gate. */
  turbo_quant_supported?: boolean;
  server_version?: string | null;
}

/** Unified search hits remain structurally compatible with `DocSearchPreview`, so the
 * existing ask-mode prompt fencing can consume them without a second rendering path. */
export interface KnowledgeSearchHit extends DocSearchPreview {
  bucket: KnowledgeBucketRef;
  bucket_label: string;
  connection_label: string | null;
  document_id: string;
  revision: string;
  chunk_id: string;
  source_uri: string | null;
}

export interface KnowledgeSearchWarning {
  bucket: KnowledgeBucketRef | null;
  message: string;
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeSearchHit[];
  warnings: KnowledgeSearchWarning[];
  partial: boolean;
}

export type KnowledgePointId = string | number;

export interface KnowledgeDocumentManifest {
  document_id: string;
  source_id: string | null;
  revision: number;
  state: "staging" | "active";
  content_sha256: string;
  title: string;
  source_uri: string;
  mime_type: string;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocumentSummary {
  point_id: KnowledgePointId;
  manifest: KnowledgeDocumentManifest;
}

export interface KnowledgeDocumentPage {
  documents: KnowledgeDocumentSummary[];
  /** Qdrant cursors are opaque: pass this value back without parsing or incrementing. */
  next_cursor: KnowledgePointId | null;
  /** Exact active totals are included on first-page reads when counting succeeds. */
  file_count?: number;
  chunk_count?: number;
}

export interface KnowledgeDocumentMetadataUpdate {
  title: string;
  source_uri: string;
  mime_type: string;
  updated_at: string;
}

export interface KnowledgeDocumentIngestInput {
  bucket: KnowledgeBucketRef;
  title: string;
  source_uri: string;
  mime_type: string;
  pages: DocPutPage[];
  source_id?: string | null;
  size_bytes?: number | null;
  mtime_ms?: number | null;
  /** Present for replacement. The backend stages a new revision under this stable id. */
  document_id?: string;
}

export type KnowledgeJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

export interface KnowledgeJob {
  id: string;
  kind: string;
  target_ref: KnowledgeBucketRef;
  stage: string;
  status: KnowledgeJobStatus;
  completed_items: number;
  total_items: number | null;
  error: string | null;
  display_name?: string;
  queue_position?: number | null;
  waiting_reason?: string | null;
  created_at: number;
  updated_at: number;
}

export type TurboQuantBits = "bits4" | "bits2" | "bits1_5" | "bits1";

export interface TurboQuantConfig {
  bits: TurboQuantBits;
  always_ram: boolean;
}

/** One page of extracted text on its way to Rust. `page` is null for formats with
 *  no page structure (markdown, text, HTML). */
export interface DocPutPage {
  page: number | null;
  text: string;
}

export interface SettingsPatch {
  theme: string;
  font_size: number;
  scrollback_lines: number;
  cursor_style: string;
  cursor_blink: boolean;
  copy_on_select: boolean;
  /** Clearable strings: send "" to clear (JSON null is indistinguishable from
   *  "not provided" on the Rust side). */
  shell_path: string;
  shell_integration_enabled: boolean;
  /** Must be a catalog id; the backend rejects anything else. */
  active_model_id: string;
  temperature: number;
  max_context_tokens: number;
  auto_load_model_on_start: boolean;
  vision_model_id: string;
  vision_prompt: string;
  vision_auto_load_on_start: boolean;
  hf_token: string;
  models_dir: string;
  anthropic_api_key: string;
  openai_api_key: string;
  mistral_api_key: string;
  history_enabled: boolean;
  history_capture_output: boolean;
  send_context_to_ai: boolean;
  ai_session_naming: boolean;
  restore_sessions_on_start: boolean;
  restore_scrollback_lines: number;
  archive_enabled: boolean;
  archive_max_sessions: number;
  archive_max_age_days: number;
  ai_panel_open: boolean;
  ai_panel_ratio: number;
  agent_max_iterations: number;
  agent_command_timeout_secs: number;
  ai_web_access: boolean;
  auto_update_enabled: boolean;
  docs_enabled: boolean;
  runbooks_enabled: boolean;
  // Loose on the patch side, as `cursor_style` is: Rust parses and rejects an
  // unknown value rather than trusting the caller's type.
  runbooks_output_recording: string;
  log_level: string;
}

// ---------- Application updates ----------

export interface UpdateMetadata {
  current_version: string;
  version: string;
  notes: string;
  published_at: string | null;
  prerelease: boolean;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { totalBytes: number | null } }
  | { event: "Progress"; data: { downloadedBytes: number; totalBytes: number | null } }
  | { event: "Verifying" }
  | { event: "ReadyToInstall" };
