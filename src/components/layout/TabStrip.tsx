import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link2, Loader2, Pencil, Plus, Server, Sparkles, Terminal, X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useSessions } from "../../hooks/useSessions";
import { resolveSessionTitle } from "../../lib/sessionTitle";
import { isNaming, nameSession } from "../../lib/sessionNaming";
import { S } from "../../lib/strings";
import type { Session } from "../../lib/types";
import { roleForSession, sidecarForSession } from "../../lib/sidecar";

export function TabStrip() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const sessionUi = useAppStore((s) => s.sessionUi);
  const sidecars = useAppStore((s) => s.sidecars);
  const renamingSessionId = useAppStore((s) => s.renamingSessionId);
  const setRenamingSession = useAppStore((s) => s.setRenamingSession);
  const { createSession, closeSession } = useSessions();
  const [menuFor, setMenuFor] = useState<string | null>(null);

  if (sessions.length === 0) return null;

  return (
    <div className="flex min-w-0 items-center rounded-lg bg-bg-secondary p-0.5 border border-border-subtle">
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        const binding = sidecarForSession(sidecars, session.id);
        const activeBinding = activeSessionId ? sidecarForSession(sidecars, activeSessionId) : null;
        const linkedRole = binding ? roleForSession(binding, session.id) : null;
        const inActiveWorkspace =
          Boolean(binding) && binding?.ownerSessionId === activeBinding?.ownerSessionId;
        const ui = sessionUi[session.id];
        const running = ui?.runningBlockId != null;
        const lastBlock = ui?.blocks[ui.blocks.length - 1];
        const failed = !running && lastBlock?.state === "done" && (lastBlock.exitCode ?? 0) !== 0;
        // Derived at render time, never stored — see lib/sessionTitle.ts for the
        // full precedence. Nothing here can be clobbered by OSC 7.
        const label = resolveSessionTitle(session, ui);
        // Filled = connected right now. Hollow = this tab belongs to a host but
        // the connection is gone (a restored tab, or one where ssh exited).
        const connected = ui?.remote != null;
        const forHost = session.hostId != null;
        const editing = renamingSessionId === session.id;
        return (
          <div key={session.id} className="relative flex min-w-0">
            <button
              onClick={() => setActiveSession(session.id)}
              onDoubleClick={() => setRenamingSession(session.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setActiveSession(session.id);
                setMenuFor(session.id);
              }}
              className={`group flex min-w-0 items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-all duration-150 ${
                active
                  ? "bg-bg-hover text-text-primary shadow-sm"
                  : inActiveWorkspace
                    ? "bg-accent/5 text-text-secondary ring-1 ring-inset ring-accent/20"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {running && (
                <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              )}
              {failed && (
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-error" />
              )}
              {linkedRole && (
                <span
                  className={`flex shrink-0 items-center gap-0.5 ${
                    linkedRole === "remote" ? "text-warning" : "text-accent"
                  }`}
                  title={`${linkedRole === "remote" ? "SSH" : "Local"} Sidecar target`}
                >
                  <Link2 size={9} />
                  {linkedRole === "remote" ? <Server size={9} /> : <Terminal size={9} />}
                </span>
              )}
              {connected && (
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                  title={S.tabs.connected}
                />
              )}
              {!connected && forHost && (
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full border border-text-muted"
                  title={S.tabs.disconnected}
                />
              )}
              {editing ? (
                <RenameInput session={session} current={label} />
              ) : (
                <span
                  // The label truncates at 120px, so without this a long name is
                  // unrecoverable.
                  title={`${label}${session.userTitle ? "" : ` — ${S.tabs.renameHint}`}`}
                  // Struck through rather than dimmed. An inactive tab is already
                  // text-muted, which sits AT the AA threshold, so ANY alpha on
                  // top lands under it — no opacity value clears 4.5:1 here, and
                  // the tab is still clickable, so it is not an exempt disabled
                  // control. Strikethrough carries the same "this one is done"
                  // signal at full contrast, in both the active and inactive
                  // states (dimming was invisible on an already-muted tab).
                  className={`max-w-[120px] truncate ${session.exited ? "line-through decoration-1" : ""}`}
                >
                  {label}
                </span>
              )}
              {isNaming(session.id) && <Loader2 size={10} className="shrink-0 animate-spin" />}
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeSession(session.id);
                }}
                className="rounded p-0.5 opacity-0 transition-opacity duration-100 hover:bg-bg-elevated group-hover:opacity-100"
                title={
                  binding
                    ? "Close target and preserve Sidecar scrollback"
                    : S.header.closeTab
                }
              >
                <X size={11} />
              </span>
            </button>
            {menuFor === session.id && (
              <TabMenu
                session={session}
                onClose={() => setMenuFor(null)}
                onRename={() => setRenamingSession(session.id)}
              />
            )}
          </div>
        );
      })}
      <button
        onClick={() => void createSession().catch(() => {})}
        className="rounded-md p-1 text-text-muted transition-colors duration-150 hover:text-text-secondary"
        title={S.header.newTab}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

/** Inline label editor. Seeded with the CURRENT label (derived or not) so the
 *  user edits what they see rather than an empty box. Submitting an empty value
 *  clears the override and hands the tab back to automatic naming. */
function RenameInput({ session, current }: { session: Session; current: string }) {
  const setRenamingSession = useAppStore((s) => s.setRenamingSession);
  const updateSession = useAppStore((s) => s.updateSession);
  const [value, setValue] = useState(session.userTitle ?? current);
  const ref = useRef<HTMLInputElement>(null);
  // Layout effect, not effect: select before the browser paints, so the text
  // never appears unselected for a frame.
  useLayoutEffect(() => {
    ref.current?.select();
  }, []);

  const commit = () => {
    const next = value.trim();
    // An AI name is a suggestion the user has now overruled either way, so it
    // goes too — otherwise "clear the name" would silently fall back to it.
    updateSession(session.id, { userTitle: next || null, aiTitle: null });
    setRenamingSession(null);
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The terminal and the global shortcut layer both listen on window;
        // neither may see keystrokes meant for this box.
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setRenamingSession(null);
      }}
      placeholder={S.tabs.renamePlaceholder}
      spellCheck={false}
      className="w-[120px] rounded bg-bg-primary px-1 text-[12px] text-text-primary outline-none ring-1 ring-accent"
    />
  );
}

function TabMenu({
  session,
  onClose,
  onRename,
}: {
  session: Session;
  onClose: () => void;
  onRename: () => void;
}) {
  const { closeSession } = useSessions();
  const aiReady = useAppStore((s) => s.aiReady());

  // Escape closes too — a menu that only dismisses on click is a trap for
  // keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2 px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-60 disabled:hover:bg-transparent";

  return (
    <>
      {/* Click-away backdrop, same approach as the command palette. */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={onClose} />
      <div className="absolute start-0 top-full z-50 mt-1 min-w-[176px] overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-lg">
        <button
          className={item}
          onClick={() => {
            onRename();
            onClose();
          }}
        >
          <Pencil size={11} /> {S.tabs.rename}
        </button>
        <button
          className={item}
          disabled={!aiReady}
          onClick={() => {
            nameSession(session.id, { force: true });
            onClose();
          }}
        >
          <Sparkles size={11} /> {S.tabs.renameWithAi}
        </button>
        {(session.userTitle || session.aiTitle) && (
          <button
            className={item}
            onClick={() => {
              useAppStore.getState().updateSession(session.id, {
                userTitle: null,
                aiTitle: null,
              });
              onClose();
            }}
          >
            {S.tabs.resetName}
          </button>
        )}
        <button
          className={item}
          onClick={() => {
            void closeSession(session.id);
            onClose();
          }}
        >
          <X size={11} /> {S.header.closeTab}
        </button>
      </div>
    </>
  );
}
