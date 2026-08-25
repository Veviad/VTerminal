import { create } from "zustand";

import * as api from "../lib/tauri";
import {
  buildOutgoing,
  DOC_INJECT_LIMIT,
  foldRetrievedPassages,
  ocrAvailable,
  persistAttachments,
  transcribeImages,
} from "../lib/attachInput";
import type { Outgoing } from "../lib/attachInput";
import { base64FromBytes, MAX_ATTACHMENTS } from "../lib/attachments";
import type {
  Attachment,
  ChatDetail,
  ChatDisplayMessage,
  ChatMcpCall,
  ChatSaveInput,
  ChatStreamState,
  ChatSummary,
  ChatTitleSource,
  KnowledgeBucketRef,
  McpChatSelection,
  StreamEvent,
  WebCitation,
  WorkspaceMode,
} from "../lib/types";
import { sameKnowledgeBucket } from "../lib/knowledge";
import { useAppStore } from "./appStore";

const idleStream = (): ChatStreamState => ({
  status: "idle",
  requestId: null,
  content: "",
  thinking: "",
  model: null,
  citations: [],
  mcpCalls: [],
  pendingMcpProposal: null,
  lastError: null,
});

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function fallbackTitle(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  const words = text.split(" ").slice(0, 7).join(" ");
  return words.length > 56 ? `${words.slice(0, 55).trimEnd()}…` : words;
}

function ordered(summaries: ChatSummary[]): ChatSummary[] {
  return [...summaries].sort((a, b) => {
    if (Boolean(a.archived_at) !== Boolean(b.archived_at)) return a.archived_at ? 1 : -1;
    return b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id);
  });
}

function defaultMcpSelection(): McpChatSelection {
  return {
    server_ids: useAppStore.getState().mcpServers
      .filter((server) => server.enabled && server.default_for_new_chats)
      .map((server) => server.id),
    disabled_tools: {},
  };
}

function blankChat(): ChatDetail {
  const now = new Date().toISOString();
  const summary: ChatSummary = {
    id: id("chat"),
    title: "New chat",
    title_source: "placeholder",
    created_at: now,
    updated_at: now,
    archived_at: null,
    message_count: 0,
    first_prompt: null,
  };
  return {
    summary,
    messages: [],
    model_transcript: [],
    model_transcript_version: 1,
    attached_bucket_refs: [],
    mcp_selection: defaultMcpSelection(),
  };
}

function saveInput(detail: ChatDetail): ChatSaveInput {
  return {
    id: detail.summary.id,
    title: detail.summary.title,
    title_source: detail.summary.title_source,
    created_at: detail.summary.created_at,
    updated_at: detail.summary.updated_at,
    archived_at: detail.summary.archived_at,
    messages: detail.messages.map(({ sort_order: _sortOrder, ...message }) => message),
    model_transcript: detail.model_transcript,
    model_transcript_version: detail.model_transcript_version,
    attached_bucket_refs: detail.attached_bucket_refs,
    mcp_selection: detail.mcp_selection,
  };
}

async function hydrateImages(detail: ChatDetail): Promise<ChatDetail> {
  const messages = await Promise.all(detail.messages.map(async (message) => ({
    ...message,
    attachments: await Promise.all(message.attachments.map(async (attachment) => {
      if (attachment.kind !== "image" || !attachment.path) return attachment;
      try {
        const bytes = await api.attachmentRead(attachment.path);
        return { ...attachment, data: base64FromBytes(new Uint8Array(bytes)) } as typeof attachment & { data: string };
      } catch {
        return attachment;
      }
    })),
  })));
  return { ...detail, messages };
}

function displayToAttachment(attachment: ChatDisplayMessage["attachments"][number]): Attachment {
  const withData = attachment as typeof attachment & { data?: string };
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mediaType: attachment.media_type,
    bytes: attachment.bytes,
    path: attachment.path ?? undefined,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
    data: withData.data,
  };
}

function attachmentToDisplay(attachment: Attachment) {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    media_type: attachment.mediaType,
    bytes: attachment.bytes,
    path: attachment.path ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
  };
}

interface ChatState {
  initialized: boolean;
  workspaceMode: WorkspaceMode;
  summaries: ChatSummary[];
  current: ChatDetail | null;
  search: string;
  archivedOpen: boolean;
  stream: ChatStreamState;
  pendingAttachments: Attachment[];
  attachError: string | null;
  attachStatus: string | null;
  knowledgeWarning: string | null;
  initialize(mode: WorkspaceMode, rememberedId: string | null): Promise<void>;
  setWorkspaceMode(mode: WorkspaceMode): Promise<void>;
  setSearch(search: string): void;
  setArchivedOpen(open: boolean): void;
  createChat(): Promise<void>;
  selectChat(chatId: string): Promise<void>;
  rename(title: string, chatId?: string): Promise<void>;
  regenerateTitle(chatId?: string, allowManualOverride?: boolean): Promise<void>;
  archive(archived: boolean, chatId?: string): Promise<void>;
  deleteChat(chatId?: string): Promise<void>;
  attachBuckets(ref: KnowledgeBucketRef): Promise<void>;
  detachBucket(ref: KnowledgeBucketRef): Promise<void>;
  setMcpSelection(selection: McpChatSelection): Promise<void>;
  respondToMcpProposal(decision: "allow_once" | "always_allow" | "deny"): Promise<void>;
  addAttachments(attachments: Attachment[]): Attachment[];
  removeAttachment(attachmentId: string): void;
  setAttachError(message: string | null): void;
  setAttachStatus(message: string | null): void;
  send(prompt: string): Promise<void>;
  stop(): Promise<void>;
}

const persistQueues = new Map<string, Promise<void>>();

async function persist(detail: ChatDetail): Promise<void> {
  const previous = persistQueues.get(detail.summary.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => api.chatSave(saveInput(detail)));
  persistQueues.set(detail.summary.id, next);
  try {
    await next;
  } finally {
    if (persistQueues.get(detail.summary.id) === next) persistQueues.delete(detail.summary.id);
  }
}

function updateCurrentSummary(state: ChatState, summary: ChatSummary) {
  return {
    current: state.current?.summary.id === summary.id
      ? { ...state.current, summary }
      : state.current,
    summaries: ordered(state.summaries.map((chat) => chat.id === summary.id ? summary : chat)),
  };
}

function completedTitlePairs(messages: ChatDisplayMessage[]) {
  const pairs: Array<{ question: string; answer: string }> = [];
  let question: string | null = null;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;
    if (message.role === "user") {
      question = content;
    } else if (message.role === "assistant" && question) {
      pairs.push({ question, answer: content });
      question = null;
    }
  }
  return pairs;
}

interface PreparedTurn {
  outgoing: Outgoing;
  staged: Attachment[];
  knowledgeWarning: string | null;
}

async function prepareTurn(
  detail: ChatDetail,
  prompt: string,
  pending: Attachment[],
  requestId: string,
): Promise<PreparedTurn> {
  let outgoing = buildOutgoing(prompt, pending);
  const app = useAppStore.getState();
  const model = app.catalog.find((entry) => entry.id === app.activeModelId);
  if (outgoing.images.length > 0 && model?.supports_vision === false && ocrAvailable()) {
    const transcribed = await transcribeImages(requestId, outgoing.prompt, pending);
    if (transcribed === null) {
      throw new Error("The image reader could not read this attachment.");
    }
    outgoing = { prompt: transcribed, images: [] };
  }

  let knowledgeWarning: string | null = null;
  if (app.docsEnabled && detail.attached_bucket_refs.length > 0 && model?.supports_tools === false) {
    try {
      const response = await api.knowledgeSearchDetailed(
        detail.attached_bucket_refs,
        prompt,
        DOC_INJECT_LIMIT,
      );
      const folded = foldRetrievedPassages(outgoing.prompt, response.hits);
      outgoing = { ...outgoing, prompt: folded.prompt };
      if (response.partial) {
        knowledgeWarning = response.warnings.map((warning) => warning.message).join(" · ");
      }
    } catch {
      knowledgeWarning = "Attached Knowledge could not be searched for this turn.";
    }
  }

  return {
    outgoing,
    staged: await persistAttachments(detail.summary.id, pending),
    knowledgeWarning,
  };
}

function appendUserTurn(
  detail: ChatDetail,
  prompt: string,
  prepared: PreparedTurn,
): { detail: ChatDetail; isFirst: boolean } {
  const now = new Date().toISOString();
  const isFirst = detail.messages.length === 0;
  const title = isFirst
    ? fallbackTitle(prompt || prepared.staged[0]?.name || "New chat")
    : detail.summary.title;
  const titleSource: ChatTitleSource = isFirst ? "fallback" : detail.summary.title_source;
  const userMessage: ChatDisplayMessage = {
    id: id("message"),
    sort_order: detail.messages.length,
    role: "user",
    content: prepared.outgoing.prompt,
    thinking: null,
    model: null,
    prompt_tokens: null,
    completion_tokens: null,
    citations: [],
    mcp_calls: [],
    attachments: prepared.staged.map(attachmentToDisplay),
    created_at: now,
  };
  return {
    isFirst,
    detail: {
      ...detail,
      summary: {
        ...detail.summary,
        title,
        title_source: titleSource,
        updated_at: now,
        message_count: detail.messages.length + 1,
        first_prompt: detail.summary.first_prompt ?? prompt,
      },
      messages: [...detail.messages, userMessage],
    },
  };
}

type ChatSet = (
  update: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

/** Apply MCP lifecycle events without coupling them to the provider stream loop. */
function handleMcpStreamEvent(event: StreamEvent, set: ChatSet): boolean {
  if (event.type === "McpToolProposal") {
    const call: ChatMcpCall = {
      approval_id: event.approval_id,
      server_id: event.server_id,
      server_name: event.server_name,
      tool_name: event.tool_name,
      arguments: event.arguments,
      status: "awaiting",
      result: null,
      error: null,
    };
    set((state) => ({
      stream: {
        ...state.stream,
        mcpCalls: [
          ...state.stream.mcpCalls.filter(
            (candidate) => candidate.approval_id !== event.approval_id,
          ),
          call,
        ],
        pendingMcpProposal: {
          approvalId: event.approval_id,
          serverId: event.server_id,
          serverName: event.server_name,
          toolName: event.tool_name,
          title: event.title,
          description: event.description,
          arguments: event.arguments,
          schemaHash: event.schema_hash,
        },
      },
    }));
    return true;
  }

  if (event.type === "McpToolStarted") {
    set((state) => ({
      stream: {
        ...state.stream,
        pendingMcpProposal:
          state.stream.pendingMcpProposal?.approvalId === event.approval_id
            ? null
            : state.stream.pendingMcpProposal,
        mcpCalls: state.stream.mcpCalls.some(
          (call) => call.approval_id === event.approval_id,
        )
          ? state.stream.mcpCalls.map((call) =>
              call.approval_id === event.approval_id
                ? { ...call, status: "running" as const }
                : call,
            )
          : [
              ...state.stream.mcpCalls,
              {
                approval_id: event.approval_id,
                server_id: event.server_id,
                server_name: event.server_name,
                tool_name: event.tool_name,
                arguments: event.arguments,
                status: "running" as const,
                result: null,
                error: null,
              },
            ],
      },
    }));
    return true;
  }

  if (event.type === "McpToolResult") {
    set((state) => ({
      stream: {
        ...state.stream,
        pendingMcpProposal:
          state.stream.pendingMcpProposal?.approvalId === event.approval_id
            ? null
            : state.stream.pendingMcpProposal,
        mcpCalls: state.stream.mcpCalls.map((call) =>
          call.approval_id === event.approval_id
            ? {
                ...call,
                status:
                  event.error || event.result.is_error
                    ? ("error" as const)
                    : ("done" as const),
                result: event.result,
                error: event.error ?? null,
              }
            : call,
        ),
      },
    }));
    return true;
  }

  if (event.type === "McpServerProblem") {
    set({ knowledgeWarning: `MCP: ${event.message}` });
    return true;
  }

  return false;
}

async function streamTurn(
  requestId: string,
  outgoing: Outgoing,
  initial: ChatDetail,
  get: () => ChatState,
  set: ChatSet,
): Promise<{ detail: ChatDetail; transcript: ChatDetail["model_transcript"]; usage: { prompt: number; completion: number } }> {
  let detail = initial;
  let transcript = detail.model_transcript;
  let usage = { prompt: 0, completion: 0 };
  try {
    transcript = await api.chatStart(
      requestId,
      detail.summary.id,
      outgoing.prompt,
      transcript,
      outgoing.images,
      detail.attached_bucket_refs,
      detail.mcp_selection,
      (event: StreamEvent) => {
        if (get().stream.requestId !== requestId) return;
        if (handleMcpStreamEvent(event, set)) return;
        if (event.type === "Started") {
          set((state) => ({ stream: { ...state.stream, model: event.model } }));
        }
        if (event.type === "Delta") {
          set((state) => ({ stream: { ...state.stream, content: state.stream.content + event.content } }));
        }
        if (event.type === "ThinkingDelta") {
          set((state) => ({ stream: { ...state.stream, thinking: state.stream.thinking + event.content } }));
        }
        if (event.type === "WebCitation") {
          const citation: WebCitation = {
            url: event.url,
            title: event.title,
            cited_text: event.cited_text,
          };
          set((state) => ({
            stream: {
              ...state.stream,
              citations: [
                ...state.stream.citations.filter((item) => item.url !== citation.url),
                citation,
              ],
            },
          }));
        }
        if (event.type === "Checkpoint") {
          detail = { ...detail, model_transcript: event.transcript };
          void persist(detail);
        }
        if (event.type === "Done") {
          usage = { prompt: event.prompt_tokens, completion: event.completion_tokens };
        }
        if (event.type === "Error") {
          set((state) => ({
            stream: {
              ...state.stream,
              status: "error",
              pendingMcpProposal: null,
              mcpCalls: state.stream.mcpCalls.map((call) =>
                call.status === "awaiting" || call.status === "running"
                  ? { ...call, status: "error" as const, error: event.message }
                  : call,
              ),
              lastError: event.message,
            },
          }));
        }
        if (event.type === "Cancelled") {
          set((state) => ({
            stream: {
              ...state.stream,
              pendingMcpProposal: null,
              mcpCalls: state.stream.mcpCalls.map((call) =>
                call.status === "awaiting" || call.status === "running"
                  ? { ...call, status: "error" as const, error: "Cancelled" }
                  : call,
              ),
            },
          }));
        }
      },
    );
  } catch (error) {
    set((state) => ({
      stream: { ...state.stream, status: "error", lastError: String(error) },
    }));
  }
  return { detail, transcript, usage };
}

function completeTurn(
  detail: ChatDetail,
  stream: ChatStreamState,
  transcript: ChatDetail["model_transcript"],
  usage: { prompt: number; completion: number },
): ChatDetail {
  if (!stream.content && !stream.thinking && stream.mcpCalls.length === 0) {
    return { ...detail, model_transcript: transcript };
  }
  const finished = new Date().toISOString();
  const assistant: ChatDisplayMessage = {
    id: id("message"),
    sort_order: detail.messages.length,
    role: "assistant",
    content: stream.content,
    thinking: stream.thinking || null,
    model: stream.model,
    prompt_tokens: usage.prompt,
    completion_tokens: usage.completion,
    citations: stream.citations,
    mcp_calls: stream.mcpCalls,
    attachments: [],
    created_at: finished,
  };
  return {
    ...detail,
    summary: {
      ...detail.summary,
      updated_at: finished,
      message_count: detail.messages.length + 1,
    },
    messages: [...detail.messages, assistant],
    model_transcript: transcript,
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  initialized: false,
  workspaceMode: "terminal",
  summaries: [],
  current: null,
  search: "",
  archivedOpen: false,
  stream: idleStream(),
  pendingAttachments: [],
  attachError: null,
  attachStatus: null,
  knowledgeWarning: null,

  initialize: async (workspaceMode, rememberedId) => {
    const summaries = await api.chatList();
    const remembered = rememberedId ? summaries.find((chat) => chat.id === rememberedId) : null;
    const selected = remembered ?? summaries.find((chat) => !chat.archived_at) ?? null;
    let detail = selected ? await api.chatGet(selected.id) : null;
    if (!detail) {
      detail = blankChat();
      await persist(detail);
    }
    detail = await hydrateImages(detail);
    let knowledgeWarning: string | null = null;
    if (detail.attached_bucket_refs.length > 0 && useAppStore.getState().docsEnabled) {
      try {
        const buckets = await api.knowledgeBucketsList();
        useAppStore.getState().setKnowledgeBuckets(buckets);
        const available = detail.attached_bucket_refs.filter((ref) =>
          buckets.some((bucket) => sameKnowledgeBucket(bucket.ref, ref)),
        );
        if (available.length !== detail.attached_bucket_refs.length) {
          detail = { ...detail, attached_bucket_refs: available };
          knowledgeWarning = "Some Knowledge sources attached to this chat are no longer available and were removed.";
          await persist(detail);
        }
      } catch {
        knowledgeWarning = "Attached Knowledge sources could not be checked during restore.";
      }
    }
    const nextSummaries = selected ? summaries : [detail.summary, ...summaries];
    set({ initialized: true, workspaceMode, summaries: nextSummaries, current: detail, knowledgeWarning });
    await api.saveSettings({ active_chat_id: detail.summary.id });
  },

  setWorkspaceMode: async (workspaceMode) => {
    set({ workspaceMode });
    await api.saveSettings({ workspace_mode: workspaceMode });
  },
  setSearch: (search) => set({ search }),
  setArchivedOpen: (archivedOpen) => set({ archivedOpen }),

  createChat: async () => {
    const state = get();
    const empty = state.summaries.find((chat) => !chat.archived_at && chat.message_count === 0);
    if (empty) return state.selectChat(empty.id);
    const detail = blankChat();
    await persist(detail);
    set((current) => ({
      summaries: [detail.summary, ...current.summaries],
      current: detail,
      pendingAttachments: [],
      stream: idleStream(),
    }));
    await api.saveSettings({ active_chat_id: detail.summary.id });
  },

  selectChat: async (chatId) => {
    if (get().stream.status === "streaming") return;
    const detail = await api.chatGet(chatId);
    if (!detail) return;
    set({ current: await hydrateImages(detail), pendingAttachments: [], stream: idleStream() });
    await api.saveSettings({ active_chat_id: chatId });
  },

  rename: async (title, chatId) => {
    const state = get();
    const targetId = chatId ?? state.current?.summary.id;
    const clean = title.trim();
    const existing = state.summaries.find((chat) => chat.id === targetId);
    if (!targetId || !existing || !clean) return;
    await api.chatUpdateTitle(targetId, clean, "manual");
    const summary = { ...existing, title: clean, title_source: "manual" as ChatTitleSource, updated_at: new Date().toISOString() };
    set((state) => updateCurrentSummary(state, summary));
  },

  regenerateTitle: async (chatId, allowManualOverride = false) => {
    const state = get();
    const targetId = chatId ?? state.current?.summary.id;
    if (!targetId || state.stream.status === "streaming") return;
    const detail = state.current?.summary.id === targetId
      ? state.current
      : await api.chatGet(targetId);
    if (!detail) {
      if (allowManualOverride) throw new Error("This chat no longer exists.");
      return;
    }
    if (detail.summary.title_source === "manual" && !allowManualOverride) return;
    const pairs = completedTitlePairs(detail.messages);
    const context = allowManualOverride ? pairs[pairs.length - 1] : pairs[0];
    if (!context) {
      if (allowManualOverride) {
        throw new Error("A completed question and answer are needed to regenerate the title.");
      }
      return;
    }
    const expected = detail.summary.title;
    const title = await api.aiNameChat(
      id("name-chat"),
      context.question,
      context.answer,
      allowManualOverride ? expected : undefined,
    );
    const changed = await api.chatUpdateTitle(
      detail.summary.id,
      title,
      "generated",
      expected,
      allowManualOverride,
    );
    if (!changed) {
      if (allowManualOverride) {
        throw new Error("The title changed while its replacement was being generated. Try again.");
      }
      return;
    }
    const latest = get().summaries.find((chat) => chat.id === targetId) ?? detail.summary;
    const summary = { ...latest, title, title_source: "generated" as ChatTitleSource, updated_at: new Date().toISOString() };
    set((state) => updateCurrentSummary(state, summary));
  },

  archive: async (archived, chatId) => {
    const state = get();
    const targetId = chatId ?? state.current?.summary.id;
    const existing = state.summaries.find((chat) => chat.id === targetId);
    if (!targetId || !existing || (state.current?.summary.id === targetId && state.stream.status === "streaming")) return;
    const archivedAt = archived ? new Date().toISOString() : null;
    await api.chatSetArchived(targetId, archivedAt);
    if (archived) void api.mcpDisconnect(targetId).catch(() => {});
    const summary = { ...existing, archived_at: archivedAt, updated_at: new Date().toISOString() };
    set((state) => updateCurrentSummary(state, summary));
  },

  deleteChat: async (chatId) => {
    const state = get();
    const targetId = chatId ?? state.current?.summary.id;
    if (!targetId || (state.current?.summary.id === targetId && state.stream.status === "streaming")) return;
    await api.chatDelete(targetId);
    void api.mcpDisconnect(targetId).catch(() => {});
    const remaining = get().summaries.filter((chat) => chat.id !== targetId);
    if (state.current?.summary.id !== targetId) {
      set({ summaries: remaining });
      return;
    }
    set({ summaries: remaining, current: null, pendingAttachments: [] });
    const next = remaining.find((chat) => !chat.archived_at);
    if (next) await get().selectChat(next.id);
    else await get().createChat();
  },

  attachBuckets: async (ref) => {
    const detail = get().current;
    if (!detail || detail.summary.archived_at) return;
    if (detail.attached_bucket_refs.some((candidate) => sameKnowledgeBucket(candidate, ref))) return;
    const next = { ...detail, attached_bucket_refs: [...detail.attached_bucket_refs, ref] };
    set({ current: next });
    await persist(next);
  },
  detachBucket: async (ref) => {
    const detail = get().current;
    if (!detail || detail.summary.archived_at) return;
    const next = {
      ...detail,
      attached_bucket_refs: detail.attached_bucket_refs.filter((candidate) => !sameKnowledgeBucket(candidate, ref)),
    };
    set({ current: next });
    await persist(next);
  },

  setMcpSelection: async (selection) => {
    const state = get();
    const detail = state.current;
    if (!detail || detail.summary.archived_at || state.stream.status === "streaming") return;
    const server_ids = selection.server_ids.filter(
      (serverId, index, all) => all.indexOf(serverId) === index,
    );
    const disabled_tools = Object.fromEntries(
      Object.entries(selection.disabled_tools)
        .filter(([serverId]) => server_ids.includes(serverId))
        .map(([serverId, names]) => [
          serverId,
          names.filter((name, index, all) => all.indexOf(name) === index),
        ]),
    );
    const nextSelection = { server_ids, disabled_tools };
    const removed = detail.mcp_selection.server_ids.filter(
      (serverId) => !server_ids.includes(serverId),
    );
    const next = { ...detail, mcp_selection: nextSelection };
    set({ current: next });
    await persist(next);
    for (const serverId of removed) {
      void api.mcpDisconnect(detail.summary.id, serverId).catch(() => {});
    }
  },

  respondToMcpProposal: async (decision) => {
    const proposal = get().stream.pendingMcpProposal;
    if (!proposal) return;
    set((state) => ({
      stream: {
        ...state.stream,
        pendingMcpProposal: null,
        mcpCalls: state.stream.mcpCalls.map((call) =>
          call.approval_id === proposal.approvalId && decision === "deny"
            ? { ...call, status: "denied" as const, error: "Denied by user" }
            : call,
        ),
      },
    }));
    await api.respondToMcpApproval(proposal.approvalId, decision).catch((error) => {
      set((state) => ({
        stream: {
          ...state.stream,
          pendingMcpProposal: proposal,
          mcpCalls: state.stream.mcpCalls.map((call) =>
            call.approval_id === proposal.approvalId
              ? { ...call, status: "awaiting" as const, error: null }
              : call,
          ),
          lastError: String(error),
        },
      }));
    });
  },

  addAttachments: (attachments) => {
    const room = Math.max(0, MAX_ATTACHMENTS - get().pendingAttachments.length);
    const accepted = attachments.slice(0, room);
    set((state) => ({ pendingAttachments: [...state.pendingAttachments, ...accepted] }));
    return accepted;
  },
  removeAttachment: (attachmentId) => set((state) => ({
    pendingAttachments: state.pendingAttachments.filter((attachment) => attachment.id !== attachmentId),
  })),
  setAttachError: (attachError) => set({ attachError }),
  setAttachStatus: (attachStatus) => set({ attachStatus }),

  send: async (rawPrompt) => {
    const detail = get().current;
    const prompt = rawPrompt.trim();
    if (!detail || detail.summary.archived_at || get().stream.status === "streaming") return;
    const pending = get().pendingAttachments;
    if (!prompt && pending.length === 0) return;

    const requestId = id("chat-request");
    let prepared: PreparedTurn;
    try {
      prepared = await prepareTurn(detail, prompt, pending, requestId);
    } catch (error) {
      set({
        knowledgeWarning: null,
        stream: {
          ...idleStream(),
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    set({ knowledgeWarning: prepared.knowledgeWarning });
    const appended = appendUserTurn(detail, prompt, prepared);
    let live = appended.detail;
    await persist(live);
    set((state) => ({
      current: live,
      pendingAttachments: [],
      stream: { ...idleStream(), status: "streaming", requestId },
      summaries: ordered(state.summaries.map((chat) => chat.id === live.summary.id ? live.summary : chat)),
    }));

    const streamed = await streamTurn(requestId, prepared.outgoing, live, get, set);
    live = completeTurn(streamed.detail, get().stream, streamed.transcript, streamed.usage);
    await persist(live);
    set((state) => {
      const summary = state.current?.summary.id === live.summary.id && state.current.summary.title_source === "manual"
        ? state.current.summary
        : live.summary;
      return {
        current: { ...live, summary },
        summaries: ordered(state.summaries.map((chat) => chat.id === summary.id ? summary : chat)),
      };
    });
    set((state) => ({ stream: { ...idleStream(), lastError: state.stream.lastError } }));
    if (useAppStore.getState().activeModelId.startsWith("local/")) {
      void api.modelStatus().then((status) => {
        useAppStore.getState().setModelStatus(
          status.loaded,
          status.state,
          status.available,
          status.acceleration,
        );
      }).catch(() => {});
    }
    if (appended.isFirst && live.summary.title_source === "fallback" && live.messages.some((message) => message.role === "assistant")) {
      void get().regenerateTitle(live.summary.id).catch(() => {});
    }
  },

  stop: async () => {
    const requestId = get().stream.requestId;
    if (requestId) await api.aiCancel(requestId);
  },
}));

export function chatAttachmentTarget() {
  return {
    setError: useChatStore.getState().setAttachError,
    setStatus: useChatStore.getState().setAttachStatus,
    attach: useChatStore.getState().addAttachments,
  };
}

export function attachmentForChatDisplay(attachment: ChatDisplayMessage["attachments"][number]): Attachment {
  return displayToAttachment(attachment);
}
