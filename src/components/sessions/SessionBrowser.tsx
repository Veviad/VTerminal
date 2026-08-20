/**
 * Past sessions: browse the archive and reopen one.
 *
 * Chrome is the command palette's (backdrop, search row, clamped arrow nav,
 * scroll-into-view) because that is the app's established transient-picker
 * idiom. Rows are SshHostsSection's (two-line metadata, a text action, and the
 * click-twice-to-confirm delete) because a session needs more than one line to
 * identify and a Delete affordance must never sit one keystroke from Enter.
 *
 * Two deliberate departures from both:
 *  - `rows === null` distinguishes LOADING from EMPTY. The palette can swallow a
 *    failed fetch because a missing History section is invisible; here the list is
 *    the whole feature, so "nothing saved" and "the read failed" must not look
 *    the same.
 *  - Rows are borderless. SshHostsSection gives each row a card border because it
 *    sits in a settings page; fifty bordered cards inside a scrolling picker is
 *    noise, so selection is the palette's full-bleed `bg-bg-hover` instead.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { History, Search, Server, TerminalSquare, Trash2 } from "lucide-react";
import * as api from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { getTerm } from "../../lib/termRegistry";
import { relativeTime } from "../../lib/relativeTime";
import { reopenSession } from "../../lib/sessionReopen";
import { metaLine, sessionLabel } from "../../lib/sessionArchiveView";
import { useSessions } from "../../hooks/useSessions";
import { S } from "../../lib/strings";
import { usesAlternateAction } from "../../lib/keymap";
import type { ArchiveSummary } from "../../lib/types";

export function SessionBrowser() {
  // Same as CommandPalette: the hook is stateless useCallbacks over the store, so
  // calling it here is cheaper than threading a prop down from AppShell.
  const { createSession } = useSessions();
  const setSessionBrowserOpen = useAppStore((s) => s.setSessionBrowserOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const catalog = useAppStore((s) => s.catalog);
  const archiveMaxSessions = useAppStore((s) => s.archiveMaxSessions);
  const archiveMaxAgeDays = useAppStore((s) => s.archiveMaxAgeDays);

  // null = still loading. See the header note.
  const [rows, setRows] = useState<ArchiveSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void api
      .archiveList()
      .then(setRows)
      .catch((e) => {
        setRows([]);
        setError(String(e));
      });
  }, []);

  const close = () => {
    setSessionBrowserOpen(false);
    const s = useAppStore.getState();
    if (s.activeSessionId) getTerm(s.activeSessionId)?.term.focus();
  };

  /** Catalog id -> the label a human recognises. */
  const modelLabel = (id: string): string | null =>
    id ? (catalog.find((m) => m.id === id)?.label ?? id) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !rows) return rows ?? [];
    // One substring test over everything that identifies a session, matching the
    // palette's rule. `first_prompt` is in here deliberately: "the session where
    // I asked about the flaky test" is how people actually remember them.
    return rows.filter((r) =>
      `${r.title} ${r.cwd ?? ""} ${r.remote_target ?? ""} ${r.first_prompt ?? ""} ${modelLabel(r.model) ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [query, rows, catalog]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const reopen = async (r: ArchiveSummary, replayOutput: boolean) => {
    setBusyId(r.session_id);
    setError(null);
    try {
      const id = await reopenSession(r.session_id, createSession, { replayOutput });
      if (id) close();
      else setError(S.sessions.reopenFailed);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (sessionId: string) => {
    setConfirmDelete(null);
    try {
      await api.archiveDelete(sessionId);
      setRows((prev) => (prev ?? []).filter((r) => r.session_id !== sessionId));
    } catch (e) {
      setError(String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[selected];
      // ⌘⏎ reopens the directory without replaying the old screen.
      if (item) void reopen(item, !usesAlternateAction(e.nativeEvent));
    } else if (e.key === "Escape") {
      // Consume it — the window-level handler would otherwise also close the
      // next overlay in the same keypress.
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50" onMouseDown={close}>
      <div
        className="mx-auto mt-16 flex max-h-[560px] w-[680px] flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-card shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3">
          <Search size={14} className="text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={S.sessions.placeholder}
            className="w-full bg-transparent py-2.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          <span className="shrink-0 text-[9px] text-text-muted">{S.sessions.reopenHint}</span>
        </div>

        {error && (
          <p className="mx-3 mt-2 rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
            {error}
          </p>
        )}

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto pb-1">
          {rows === null && (
            <p className="px-3 py-4 text-center text-[12px] text-text-muted">
              {S.sessions.loading}
            </p>
          )}
          {rows !== null && rows.length === 0 && !error && (
            <p className="px-3 py-4 text-center text-[12px] text-text-muted">{S.sessions.empty}</p>
          )}
          {rows !== null && rows.length > 0 && filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-text-muted">
              {S.sessions.noResults}
            </p>
          )}
          {filtered.map((r, idx) => {
            const active = idx === selected;
            return (
              <div
                key={r.session_id}
                data-index={idx}
                onMouseMove={() => setSelected(idx)}
                className={`flex items-center gap-2 px-3 py-2 transition-colors duration-75 ${
                  active ? "bg-bg-hover" : ""
                } ${busyId === r.session_id ? "opacity-50" : ""}`}
              >
                {r.host_id || r.remote_kind ? (
                  <Server size={12} className="shrink-0 text-text-muted" />
                ) : (
                  <TerminalSquare size={12} className="shrink-0 text-text-muted" />
                )}
                {/* A <button> takes phrasing content only, so these are spans
                    with `block` rather than the <p> SshHostsSection can use. */}
                <button
                  onClick={() => void reopen(r, true)}
                  onFocus={() => setSelected(idx)}
                  className="min-w-0 flex-1 text-start"
                >
                  <span
                    className={`block truncate text-[12px] ${
                      active ? "text-text-primary" : "text-text-secondary"
                    }`}
                  >
                    {sessionLabel(r)}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-text-muted">
                    {metaLine(r, modelLabel(r.model))}
                  </span>
                </button>
                <span className="shrink-0 font-mono text-[10px] text-text-muted">
                  {relativeTime(r.closed_at)}
                </span>
                <button
                  onClick={() => void reopen(r, true)}
                  disabled={busyId !== null}
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-accent hover:bg-bg-hover disabled:opacity-60"
                >
                  {S.sessions.reopen}
                </button>
                <button
                  onClick={() =>
                    confirmDelete === r.session_id
                      ? void remove(r.session_id)
                      : setConfirmDelete(r.session_id)
                  }
                  onBlur={() => setConfirmDelete(null)}
                  title={
                    confirmDelete === r.session_id ? S.sessions.confirmRemove : S.sessions.remove
                  }
                  className={`shrink-0 rounded-md p-1 hover:bg-bg-hover ${
                    confirmDelete === r.session_id
                      ? "text-error"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* The retention truth at the point of use — where this codebase puts
            disclosures, rather than in a docs page nobody opens. */}
        <div className="flex items-center justify-between border-t border-border-subtle px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-[10px] text-text-muted">
            <History size={10} />
            {S.sessions.retention
              .replace("{sessions}", String(archiveMaxSessions))
              .replace("{days}", String(archiveMaxAgeDays))}
          </span>
          <button
            onClick={() => {
              setSettingsOpen(true);
              close();
            }}
            className="rounded-md px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          >
            {S.sessions.manage}
          </button>
        </div>
      </div>
    </div>
  );
}
