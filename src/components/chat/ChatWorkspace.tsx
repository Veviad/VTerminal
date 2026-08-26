import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Globe2,
  Paperclip,
  Plus,
  Search,
  Send,
  Square,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useChatStore, attachmentForChatDisplay, chatAttachmentTarget } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { AiMessageView } from "../ai/AiMessageView";
import { AttachmentChip } from "../ai/AttachmentChip";
import { AttachmentStrip, FoldedBlockSection } from "../ai/MessageContent";
import { EffortPicker } from "../ui/EffortPicker";
import { inputsFromFileList, splitFoldedBlocks, stageInputs } from "../../lib/attachInput";
import { refreshKnowledgeBuckets } from "../../lib/docsIndex";
import { knowledgeBucketKey, sameKnowledgeBucket } from "../../lib/knowledge";
import { sanitizeExternalWebUrl } from "../../lib/externalUrl";
import * as api from "../../lib/tauri";
import type {
  ChatDisplayMessage,
  ChatSummary,
  KnowledgeBucketRef,
  WebCitation,
} from "../../lib/types";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { GenerationModeBadge } from "../layout/GenerationModeBadge";
import { ChatActions } from "./ChatActions";
import { McpApprovalCard } from "../ai/McpApprovalCard";
import { McpPicker } from "../ai/McpPicker";
import { McpToolGroup } from "../ai/McpToolCard";

const CHAT_BOTTOM_THRESHOLD_PX = 48;
const GENERATION_STATUS_POLL_MS = 500;
const NO_ATTACHED_BUCKETS: readonly KnowledgeBucketRef[] = [];

export function isNearChatBottom(
  viewport: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
}

export function ChatWorkspace() {
  const current = useChatStore((state) => state.current);
  const stream = useChatStore((state) => state.stream);
  const pending = useChatStore((state) => state.pendingAttachments);
  const attachError = useChatStore((state) => state.attachError);
  const attachStatus = useChatStore((state) => state.attachStatus);
  const knowledgeWarning = useChatStore((state) => state.knowledgeWarning);
  const activeModelId = useAppStore((state) => state.activeModelId);
  const [composer, setComposer] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const archived = Boolean(current?.summary.archived_at);

  useEffect(() => {
    stickToBottomRef.current = true;
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight });
  }, [current?.summary.id]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !stickToBottomRef.current) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: stream.status === "streaming" ? "auto" : "smooth",
    });
  }, [current?.messages.length, stream.content, stream.thinking]);

  useEffect(() => {
    if (stream.status !== "streaming" || !activeModelId.startsWith("local/")) return;

    let active = true;
    let pending = false;
    const refreshGenerationStatus = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = await api.modelStatus();
        if (active) {
          useAppStore.getState().setModelStatus(
            status.loaded,
            status.state,
            status.available,
            status.acceleration,
          );
        }
      } catch {
        // Status visibility must never interrupt a response.
      } finally {
        pending = false;
      }
    };

    void refreshGenerationStatus();
    const timer = window.setInterval(refreshGenerationStatus, GENERATION_STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeModelId, stream.status]);

  const send = () => {
    if ((!composer.trim() && pending.length === 0) || archived) return;
    const text = composer;
    setComposer("");
    void useChatStore.getState().send(text);
  };

  return (
    <section className="absolute inset-0 z-10 flex bg-bg-primary" aria-label="Chat workspace">
      <ChatSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatToolbar />
        <div
          ref={scrollRef}
          data-testid="chat-timeline"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-7"
          onScroll={(event) => {
            stickToBottomRef.current = isNearChatBottom(event.currentTarget);
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {current?.messages.length ? (
              current.messages.map((message) => <Message key={message.id} message={message} />)
            ) : (
              <div className="flex min-h-[42vh] flex-col items-center justify-center gap-2 text-center">
                <img src="/vterminal-mark.svg" alt="" className="h-10 w-7 opacity-35" />
                <h1 className="text-lg font-medium text-text-primary">Start a chat</h1>
                <p className="max-w-md text-xs leading-relaxed text-text-muted">
                  Ask a question, attach a document or image, search Knowledge, or use supported web sources. This workspace never has terminal access.
                </p>
              </div>
            )}
            {stream.status === "streaming" && (
              <div className="rounded-xl border border-border-subtle bg-bg-card p-4 text-text-primary">
                {stream.thinking && (
                  <details className="mb-3 text-xs text-text-muted">
                    <summary className="cursor-pointer">Reasoning</summary>
                    <p className="mt-2 whitespace-pre-wrap">{stream.thinking}</p>
                  </details>
                )}
                {stream.content ? <AiMessageView content={stream.content} /> : <span className="text-xs text-text-muted">Thinking…</span>}
                {stream.mcpCalls.length > 0 && (
                  <div className="mt-3">
                    <McpToolGroup calls={stream.mcpCalls} />
                  </div>
                )}
                <Sources citations={stream.citations} />
              </div>
            )}
            {stream.pendingMcpProposal && (
              <McpApprovalCard
                key={stream.pendingMcpProposal.approvalId}
                server={stream.pendingMcpProposal.serverName}
                tool={stream.pendingMcpProposal.title ?? stream.pendingMcpProposal.toolName}
                description={stream.pendingMcpProposal.description}
                args={stream.pendingMcpProposal.arguments}
                onRespond={(decision) => void useChatStore.getState().respondToMcpProposal(decision)}
              />
            )}
            {stream.lastError && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{stream.lastError}</p>}
            {knowledgeWarning && <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{knowledgeWarning}</p>}
          </div>
        </div>

        <div className="shrink-0 px-5 pb-5 pt-2">
          <div className="mx-auto w-full max-w-3xl">
            {archived ? (
              <div className="flex items-center justify-between rounded-xl border border-border-subtle bg-bg-card px-4 py-3 text-xs text-text-secondary">
                <span>This chat is archived and read-only.</span>
                <button className="rounded-md bg-bg-hover px-2.5 py-1.5 text-text-primary hover:bg-bg-elevated" onClick={() => void useChatStore.getState().archive(false)}>
                  Unarchive to continue
                </button>
              </div>
            ) : (
              <div
                className="rounded-2xl border border-border-subtle bg-bg-card shadow-lg"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void stageInputs(current?.summary.id ?? "chat", inputsFromFileList(event.dataTransfer.files), chatAttachmentTarget());
                }}
              >
                {pending.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 border-b border-border-subtle px-3 py-2">
                    {pending.map((attachment) => (
                      <AttachmentChip key={attachment.id} attachment={attachment} onRemove={() => useChatStore.getState().removeAttachment(attachment.id)} />
                    ))}
                  </div>
                )}
                <textarea
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      send();
                    }
                  }}
                  disabled={stream.status === "streaming"}
                  rows={3}
                  placeholder="Message VTerminal Chat…"
                  className="block w-full resize-none bg-transparent px-4 pt-3 text-[13px] text-text-primary outline-none placeholder:text-text-muted"
                />
                <div className="flex items-center justify-between px-3 pb-3">
                  <div className="flex items-center gap-1.5">
                    <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => {
                      void stageInputs(current?.summary.id ?? "chat", inputsFromFileList(event.target.files), chatAttachmentTarget());
                      event.currentTarget.value = "";
                    }} />
                    <button type="button" onClick={() => fileRef.current?.click()} className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary" title="Attach files, PDFs, or images">
                      <Paperclip size={15} />
                    </button>
                    <KnowledgePicker />
                    {attachStatus && <span className="text-[10px] text-text-muted">{attachStatus}</span>}
                    {attachError && <span className="text-[10px] text-danger">{attachError}</span>}
                  </div>
                  {stream.status === "streaming" ? (
                    <button type="button" onClick={() => void useChatStore.getState().stop()} className="rounded-lg bg-text-primary p-2 text-bg-primary" title="Stop response"><Square size={13} fill="currentColor" /></button>
                  ) : (
                    <button type="button" onClick={send} disabled={!composer.trim() && pending.length === 0} className="rounded-lg bg-accent p-2 text-bg-primary disabled:opacity-30" title="Send"><Send size={14} /></button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ChatSidebar() {
  const summaries = useChatStore((state) => state.summaries);
  const currentId = useChatStore((state) => state.current?.summary.id ?? null);
  const query = useChatStore((state) => state.search);
  const archivedOpen = useChatStore((state) => state.archivedOpen);
  const filtered = summaries.filter((chat) => `${chat.title} ${chat.first_prompt ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const active = filtered.filter((chat) => !chat.archived_at);
  const archived = filtered.filter((chat) => chat.archived_at);
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary">
      <div className="p-3">
        <button className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-bg-primary" onClick={() => void useChatStore.getState().createChat()}>
          <Plus size={14} /> New chat
        </button>
        <label className="mt-2 flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-text-muted">
          <Search size={12} />
          <input value={query} onChange={(event) => useChatStore.getState().setSearch(event.target.value)} placeholder="Search chats" className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none" />
          {query && <button onClick={() => useChatStore.getState().setSearch("")}><X size={11} /></button>}
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {active.map((chat) => <ChatRow key={chat.id} chat={chat} selected={chat.id === currentId} />)}
        {archived.length > 0 && (
          <div className="mt-3 border-t border-border-subtle pt-2">
            <button className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted" onClick={() => useChatStore.getState().setArchivedOpen(!archivedOpen)}>
              {archivedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Archived <span className="ms-auto">{archived.length}</span>
            </button>
            {archivedOpen && archived.map((chat) => <ChatRow key={chat.id} chat={chat} selected={chat.id === currentId} />)}
          </div>
        )}
      </nav>
    </aside>
  );
}

function ChatRow({ chat, selected }: { chat: ChatSummary; selected: boolean }) {
  return (
    <div
      className={`group relative mb-0.5 flex w-full items-center rounded-md ${selected ? "bg-bg-hover text-text-primary" : "text-text-secondary hover:bg-bg-hover/60"}`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 px-2.5 py-2 text-left"
        onClick={() => void useChatStore.getState().selectChat(chat.id)}
      >
        <span className="block truncate text-xs">{chat.title}</span>
        <span className="mt-0.5 block truncate text-[9px] text-text-muted">{new Date(chat.updated_at).toLocaleDateString()}</span>
      </button>
      <ChatActions chat={chat} placement="sidebar" />
    </div>
  );
}

function ChatToolbar() {
  const detail = useChatStore((state) => state.current);
  const stream = useChatStore((state) => state.stream);
  const app = useAppStore();
  if (!detail) return <div className="h-11 border-b border-border-subtle" />;
  const model = app.catalog.find((entry) => entry.id === app.activeModelId);
  const effort = app.modelEffort[app.activeModelId] ?? model?.default_effort ?? "off";
  const providerRejectedWeb = Boolean(
    stream.lastError &&
      /web[_ ](?:search|fetch)/i.test(stream.lastError) &&
      /disabled|not enabled|organization|permission|unsupported/i.test(stream.lastError),
  );
  const web = !app.aiWebAccess
    ? "Web off"
    : providerRejectedWeb
      ? "Web unavailable for provider"
      : model?.native_web_search && model.native_web_fetch
        ? "Web search + fetch"
        : "Web unsupported";
  const busy = stream.status === "streaming";
  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-subtle px-4">
      <div className="min-w-0">
        <h2 className="truncate text-xs font-medium text-text-primary">{detail.summary.title}</h2>
        <p className="mt-0.5 flex items-center gap-2 text-[9px] text-text-muted">
          <span>{stream.model ?? model?.label ?? "No model"}</span>
          <GenerationModeBadge verbose />
          <span className="flex items-center gap-1"><Globe2 size={9} /> {web}</span>
          <span className="flex items-center gap-1"><BookOpen size={9} /> {detail.attached_bucket_refs.length ? `${detail.attached_bucket_refs.length} Knowledge` : "No Knowledge"}</span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <McpPicker
          conversationId={detail.summary.id}
          selection={detail.mcp_selection}
          disabled={busy || Boolean(detail.summary.archived_at)}
          onSelectionChange={(selection) =>
            void useChatStore.getState().setMcpSelection(selection)
          }
        />
        {model && <EffortPicker value={effort} available={model.efforts} layout="dropdown" size="sm" disabled={busy} onChange={(value) => {
          void api.setModelEffort(model.id, value).then(() => app.setModelEffortLocal(model.id, value));
        }} />}
        <ChatActions chat={detail.summary} placement="toolbar" />
      </div>
    </div>
  );
}

function KnowledgePicker() {
  const enabled = useAppStore((state) => state.docsEnabled);
  const buckets = useAppStore((state) => state.knowledgeBuckets);
  // `ChatWorkspace` mounts before the asynchronous Chat restore completes.
  // Keep the selector result stable while `current` is null: Zustand 5 passes
  // it through useSyncExternalStore, where allocating `[]` for every snapshot
  // is interpreted as a perpetual store change and hits React's update-depth
  // guard before the restored chat can arrive.
  const attached = useChatStore((state) => state.current?.attached_bucket_refs)
    ?? NO_ATTACHED_BUCKETS;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissibleLayer(ref, dismiss, open);
  useEffect(() => { if (enabled && buckets.length === 0) void refreshKnowledgeBuckets(); }, [enabled, buckets.length]);
  useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
  const attachable = useMemo(() => buckets.filter((bucket) => bucket.attachable), [buckets]);
  if (!enabled) return null;
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] ${attached.length ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-bg-hover"}`}><BookOpen size={13} />{attached.length || "Knowledge"}</button>
      {open && <div role="menu" aria-label="Knowledge sources" className="absolute bottom-8 left-0 z-30 max-h-64 w-72 overflow-y-auto rounded-md border border-border-subtle bg-bg-card p-1 shadow-lg">
        {attachable.length === 0 ? <p className="p-2 text-xs text-text-muted">No searchable Knowledge sources.</p> : attachable.map((bucket) => {
          const selected = attached.some((ref) => sameKnowledgeBucket(ref, bucket.ref));
          return <label key={knowledgeBucketKey(bucket.ref)} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-hover">
            <input type="checkbox" checked={selected} onChange={() => selected ? void useChatStore.getState().detachBucket(bucket.ref) : void useChatStore.getState().attachBuckets(bucket.ref)} />
            <span className="min-w-0 flex-1 truncate">{bucket.label}</span><span className="text-[9px] text-text-muted">{bucket.chunk_count}</span>
          </label>;
        })}
      </div>}
    </div>
  );
}

function Message({ message }: { message: ChatDisplayMessage }) {
  const user = message.role === "user";
  const displayed = user ? splitFoldedBlocks(message.content) : { prompt: message.content, blocks: [] };
  const attachments = message.attachments.map(attachmentForChatDisplay);
  return (
    <article className={user ? "ml-auto min-w-0 max-w-[86%] overflow-hidden rounded-2xl bg-bg-hover px-4 py-3 text-text-primary" : "min-w-0 max-w-full overflow-hidden rounded-xl border border-border-subtle bg-bg-card p-4 text-text-primary"}>
      <AttachmentStrip attachments={attachments} />
      {message.thinking && <details className="mb-3 text-xs text-text-muted"><summary className="cursor-pointer">Reasoning</summary><p className="mt-2 whitespace-pre-wrap">{message.thinking}</p></details>}
      <AiMessageView content={displayed.prompt} />
      {displayed.blocks.map((block, index) => <FoldedBlockSection key={`${block.kind}-${block.name}-${index}`} block={block} />)}
      {message.mcp_calls.length > 0 && (
        <div className="mt-3">
          <McpToolGroup calls={message.mcp_calls} />
        </div>
      )}
      <Sources citations={message.citations} />
      {!user && message.model && <p className="mt-2 text-[9px] text-text-muted">{message.model}{message.prompt_tokens !== null || message.completion_tokens !== null ? ` · ${(message.prompt_tokens ?? 0).toLocaleString()} in / ${(message.completion_tokens ?? 0).toLocaleString()} out` : ""}</p>}
    </article>
  );
}

function Sources({ citations }: { citations: WebCitation[] }) {
  if (!citations.length) return null;
  return <footer className="mt-4 border-t border-border-subtle pt-3"><p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">Sources</p><ol className="space-y-1 text-[10px] text-text-secondary">{citations.map((citation, index) => {
    const safe = sanitizeExternalWebUrl(citation.url);
    return <li key={`${citation.url}-${index}`} className="flex gap-1.5"><span className="text-text-muted">[{index + 1}]</span>{safe ? <button className="truncate text-left text-accent hover:underline" title={citation.cited_text || citation.url} onClick={() => void openUrl(safe)}>{citation.title || new URL(safe).hostname}</button> : <span className="truncate">{citation.title || "Unavailable source"}</span>}</li>;
  })}</ol></footer>;
}
