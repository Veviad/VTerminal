import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import type { ChatSummary } from "../../lib/types";
import { useChatStore } from "../../stores/chatStore";

function MenuButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-bg-hover disabled:opacity-35 ${
        danger ? "text-danger" : "text-text-secondary"
      }`}
    >
      {icon}{label}
    </button>
  );
}

export function ChatActions({
  chat,
  placement,
}: {
  chat: ChatSummary;
  placement: "sidebar" | "toolbar";
}) {
  const [open, setOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const streaming = useChatStore((state) => state.stream.status === "streaming");
  const busy = useChatStore(
    (state) => state.current?.summary.id === chat.id && state.stream.status === "streaming",
  );
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissibleLayer(ref, dismiss, open);

  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  const sidebar = placement === "sidebar";

  return (
    <>
      <div ref={ref} className={sidebar ? "relative mr-1 shrink-0" : "relative"}>
        <button
          type="button"
          aria-label={`${sidebar ? "Chat list actions" : "Chat actions"} for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={open}
          className="rounded-md p-1.5 text-text-muted hover:bg-bg-elevated hover:text-text-primary"
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={sidebar ? 14 : 15} />
        </button>
        {open && (
          <div
            role="menu"
            className={`absolute z-40 w-44 rounded-md border border-border-subtle bg-bg-card p-1 shadow-lg ${
              sidebar ? "right-0 top-8" : "right-0 top-9"
            }`}
          >
            {busy && (
              <p className="px-2 py-1.5 text-[10px] leading-snug text-text-muted">
                Stop the running response before changing this chat.
              </p>
            )}
            <MenuButton
              disabled={busy}
              icon={<Pencil size={12} />}
              label="Rename"
              onClick={() => act(() => setRenameOpen(true))}
            />
            <MenuButton
              icon={<RefreshCw size={12} />}
              label="Regenerate title"
              disabled={streaming || chat.message_count < 2}
              onClick={() => act(() => void useChatStore.getState().regenerateTitle(chat.id, true))}
            />
            <MenuButton
              disabled={busy}
              icon={chat.archived_at ? <ArchiveRestore size={12} /> : <Archive size={12} />}
              label={chat.archived_at ? "Unarchive" : "Archive"}
              onClick={() => act(() => void useChatStore.getState().archive(!chat.archived_at, chat.id))}
            />
            <MenuButton
              disabled={busy}
              danger
              icon={<Trash2 size={12} />}
              label="Delete"
              onClick={() => act(() => setDeleteOpen(true))}
            />
          </div>
        )}
      </div>
      {renameOpen && <RenameChatDialog chat={chat} onClose={() => setRenameOpen(false)} />}
      {deleteOpen && <DeleteChatDialog chat={chat} onClose={() => setDeleteOpen(false)} />}
    </>
  );
}

function RenameChatDialog({ chat, onClose }: { chat: ChatSummary; onClose(): void }) {
  const [title, setTitle] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(panelRef, onClose);

  const save = async () => {
    const clean = title.trim();
    if (!clean || saving) return;
    setSaving(true);
    setError(null);
    try {
      await useChatStore.getState().rename(clean, chat.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`rename-${chat.id}`}
        className="w-full max-w-sm rounded-xl border border-border-subtle bg-bg-card p-4 shadow-2xl"
      >
        <h3 id={`rename-${chat.id}`} className="text-sm font-medium text-text-primary">
          Rename chat
        </h3>
        <form className="mt-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <input
            autoFocus
            aria-label="Chat title"
            maxLength={80}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none focus:border-accent"
          />
          {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover">
              Cancel
            </button>
            <button type="submit" disabled={!title.trim() || saving} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary disabled:opacity-40">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteChatDialog({ chat, onClose }: { chat: ChatSummary; onClose(): void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer(panelRef, onClose, !deleting);

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await useChatStore.getState().deleteChat(chat.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-6">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`delete-${chat.id}`}
        aria-describedby={`delete-description-${chat.id}`}
        className="w-full max-w-sm rounded-xl border border-border-subtle bg-bg-card p-4 shadow-2xl"
      >
        <h3 id={`delete-${chat.id}`} className="text-sm font-medium text-text-primary">
          Delete chat?
        </h3>
        <p id={`delete-description-${chat.id}`} className="mt-2 text-xs leading-relaxed text-text-secondary">
          “{chat.title}” will be permanently deleted. This action cannot be undone.
        </p>
        {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={deleting} onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40">
            Cancel
          </button>
          <button type="button" autoFocus disabled={deleting} onClick={() => void remove()} className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
