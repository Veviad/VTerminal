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
import { base64FromBytes, MAX_ATTACHMENTS } from "../lib/attachments";
import type {
  Attachment,
  ChatDetail,
  ChatDisplayMessage,
  ChatSaveInput,
  ChatStreamState,
  ChatSummary,
  ChatTitleSource,
  KnowledgeBucketRef,
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
  rename(title: string): Promise<void>;
  regenerateTitle(): Promise<void>;
  archive(archived: boolean): Promise<void>;
  deleteCurrent(): Promise<void>;
  attachBuckets(ref: KnowledgeBucketRef): Promise<void>;
  detachBucket(ref: KnowledgeBucketRef): Promise<void>;
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

  rename: async (title) => {
    const detail = get().current;
    const clean = title.trim();
    if (!detail || !clean) return;
    await api.chatUpdateTitle(detail.summary.id, clean, "manual");
    const summary = { ...detail.summary, title: clean, title_source: "manual" as ChatTitleSource, updated_at: new Date().toISOString() };
    set((state) => ({
      current: { ...detail, summary },
      summaries: ordered(state.summaries.map((chat) => chat.id === summary.id ? summary : chat)),
    }));
  },

  regenerateTitle: async () => {
    const detail = get().current;
    if (!detail || detail.summary.title_source === "manual" || get().stream.status === "streaming") return;
    const question = detail.messages.find((message) => message.role === "user")?.content;
    const answer = detail.messages.find((message) => message.role === "assistant")?.content;
    if (!question || !answer) return;
    const expected = detail.summary.title;
    const title = await api.aiNameChat(id("name-chat"), question, answer);
    const changed = await api.chatUpdateTitle(detail.summary.id, title, "generated", expected);
    if (!changed) return;
    const summary = { ...detail.summary, title, title_source: "generated" as ChatTitleSource, updated_at: new Date().toISOString() };
    set((state) => ({
      current: state.current?.summary.id === summary.id ? { ...state.current, summary } : state.current,
      summaries: ordered(state.summaries.map((chat) => chat.id === summary.id ? summary : chat)),
    }));
  },

  archive: async (archived) => {
    const detail = get().current;
    if (!detail || get().stream.status === "streaming") return;
    const archivedAt = archived ? new Date().toISOString() : null;
    await api.chatSetArchived(detail.summary.id, archivedAt);
    const summary = { ...detail.summary, archived_at: archivedAt, updated_at: new Date().toISOString() };
    set((state) => ({
      current: { ...detail, summary },
      summaries: ordered(state.summaries.map((chat) => chat.id === summary.id ? summary : chat)),
    }));
  },

  deleteCurrent: async () => {
    const detail = get().current;
    if (!detail || get().stream.status === "streaming") return;
    await api.chatDelete(detail.summary.id);
    const remaining = get().summaries.filter((chat) => chat.id !== detail.summary.id);
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
    if (!prompt && get().pendingAttachments.length === 0) return;

    const requestId = id("chat-request");
    const staged = await persistAttachments(detail.summary.id, get().pendingAttachments);
    let outgoing = buildOutgoing(prompt, staged);
    const app = useAppStore.getState();
    const model = app.catalog.find((entry) => entry.id === app.activeModelId);
    if (outgoing.images.length > 0 && model?.supports_vision === false && ocrAvailable()) {
      const transcribed = await transcribeImages(requestId, outgoing.prompt, staged);
      if (transcribed === null) {
        set({ stream: { ...idleStream(), status: "error", lastError: "The image reader could not read this attachment." } });
        return;
      }
      outgoing = { prompt: transcribed, images: [] };
    }

    set({ knowledgeWarning: null });
    if (app.docsEnabled && detail.attached_bucket_refs.length > 0 && model?.supports_tools === false) {
      try {
        const response = await api.knowledgeSearchDetailed(detail.attached_bucket_refs, prompt, DOC_INJECT_LIMIT);
        const folded = foldRetrievedPassages(outgoing.prompt, response.hits);
        outgoing = { ...outgoing, prompt: folded.prompt };
        if (response.partial) set({ knowledgeWarning: response.warnings.map((warning) => warning.message).join(" · ") });
      } catch {
        set({ knowledgeWarning: "Attached Knowledge could not be searched for this turn." });
      }
    }

    const now = new Date().toISOString();
    const isFirst = detail.messages.length === 0;
    const title = isFirst ? fallbackTitle(prompt || staged[0]?.name || "New chat") : detail.summary.title;
    const source: ChatTitleSource = isFirst ? "fallback" : detail.summary.title_source;
    const userMessage: ChatDisplayMessage = {
      id: id("message"),
      sort_order: detail.messages.length,
      role: "user",
      content: outgoing.prompt,
      thinking: null,
      model: null,
      prompt_tokens: null,
      completion_tokens: null,
      citations: [],
      attachments: staged.map(attachmentToDisplay),
      created_at: now,
    };
    let live: ChatDetail = {
      ...detail,
      summary: { ...detail.summary, title, title_source: source, updated_at: now, message_count: detail.messages.length + 1, first_prompt: detail.summary.first_prompt ?? prompt },
      messages: [...detail.messages, userMessage],
    };
    await persist(live);
    set((state) => ({
      current: live,
      pendingAttachments: [],
      stream: { ...idleStream(), status: "streaming", requestId },
      summaries: ordered(state.summaries.map((chat) => chat.id === live.summary.id ? live.summary : chat)),
    }));

    let transcript = live.model_transcript;
    let usage = { prompt: 0, completion: 0 };
    try {
      transcript = await api.chatStart(requestId, outgoing.prompt, transcript, outgoing.images, live.attached_bucket_refs, (event: StreamEvent) => {
        if (get().stream.requestId !== requestId) return;
        if (event.type === "Started") set((state) => ({ stream: { ...state.stream, model: event.model } }));
        if (event.type === "Delta") set((state) => ({ stream: { ...state.stream, content: state.stream.content + event.content } }));
        if (event.type === "ThinkingDelta") set((state) => ({ stream: { ...state.stream, thinking: state.stream.thinking + event.content } }));
        if (event.type === "WebCitation") {
          const citation: WebCitation = { url: event.url, title: event.title, cited_text: event.cited_text };
          set((state) => ({ stream: { ...state.stream, citations: [...state.stream.citations.filter((item) => item.url !== citation.url), citation] } }));
        }
        if (event.type === "Checkpoint") {
          live = { ...live, model_transcript: event.transcript };
          void persist(live);
        }
        if (event.type === "Done") usage = { prompt: event.prompt_tokens, completion: event.completion_tokens };
        if (event.type === "Error") set((state) => ({ stream: { ...state.stream, status: "error", lastError: event.message } }));
      });
    } catch (error) {
      set((state) => ({ stream: { ...state.stream, status: "error", lastError: String(error) } }));
    }

    const stream = get().stream;
    if (stream.content || stream.thinking) {
      const finished = new Date().toISOString();
      const assistant: ChatDisplayMessage = {
        id: id("message"),
        sort_order: live.messages.length,
        role: "assistant",
        content: stream.content,
        thinking: stream.thinking || null,
        model: stream.model,
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        citations: stream.citations,
        attachments: [],
        created_at: finished,
      };
      live = {
        ...live,
        summary: { ...live.summary, updated_at: finished, message_count: live.messages.length + 1 },
        messages: [...live.messages, assistant],
        model_transcript: transcript,
      };
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
    } else {
      live = { ...live, model_transcript: transcript };
      await persist(live);
      set((state) => ({
        current: state.current?.summary.id === live.summary.id && state.current.summary.title_source === "manual"
          ? { ...live, summary: state.current.summary }
          : live,
      }));
    }
    set((state) => ({ stream: { ...idleStream(), lastError: state.stream.lastError } }));
    if (isFirst && live.summary.title_source === "fallback" && live.messages.some((message) => message.role === "assistant")) {
      void get().regenerateTitle().catch(() => {});
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
