import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  Check,
  ChevronDown,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Server,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useAppStore, type SessionUiState } from "../../stores/appStore";
import { useSessions } from "../../hooks/useSessions";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { resolveSessionTitle } from "../../lib/sessionTitle";
import { isNaming, renameSessionWithAi } from "../../lib/sessionNaming";
import { S } from "../../lib/strings";
import type { Session } from "../../lib/types";
import {
  roleForSession,
  sidecarForSession,
  type SidecarBinding,
} from "../../lib/sidecar";

interface ScrollState {
  overflowing: boolean;
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

interface TabMenuState {
  sessionId: string;
  left: number;
  top: number;
}

const INITIAL_SCROLL_STATE: ScrollState = {
  overflowing: false,
  canScrollLeft: false,
  canScrollRight: false,
};

export function TabStrip() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const sessionUi = useAppStore((s) => s.sessionUi);
  const sidecars = useAppStore((s) => s.sidecars);
  const renamingSessionId = useAppStore((s) => s.renamingSessionId);
  const setRenamingSession = useAppStore((s) => s.setRenamingSession);
  const { createSession, closeSession } = useSessions();
  const [menuFor, setMenuFor] = useState<TabMenuState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [scrollState, setScrollState] = useState(INITIAL_SCROLL_STATE);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overflowLayerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const overflowListId = useId();

  const closeOverflow = useCallback(() => setOverflowOpen(false), []);
  useDismissibleLayer(overflowLayerRef, closeOverflow, overflowOpen);

  const measureViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const tolerance = 1;
    const overflowing = viewport.scrollWidth - viewport.clientWidth > tolerance;
    const next: ScrollState = {
      overflowing,
      canScrollLeft: overflowing && viewport.scrollLeft > tolerance,
      canScrollRight:
        overflowing &&
        viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - tolerance,
    };
    setScrollState((current) =>
      current.overflowing === next.overflowing &&
      current.canScrollLeft === next.canScrollLeft &&
      current.canScrollRight === next.canScrollRight
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    measureViewport();
    const observer = new ResizeObserver(measureViewport);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener("scroll", measureViewport, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", measureViewport);
    };
  }, [measureViewport, sessions.length]);

  useLayoutEffect(() => {
    if (!activeSessionId) return;
    tabRefs.current.get(activeSessionId)?.scrollIntoView?.({
      behavior: "auto",
      block: "nearest",
      inline: "nearest",
    });
    measureViewport();
  }, [activeSessionId, measureViewport, sessions.length]);

  useEffect(() => {
    if (!scrollState.overflowing) setOverflowOpen(false);
  }, [scrollState.overflowing]);

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      viewport.scrollWidth <= viewport.clientWidth ||
      Math.abs(event.deltaY) <= Math.abs(event.deltaX)
    ) {
      return;
    }
    const before = viewport.scrollLeft;
    viewport.scrollLeft += event.deltaY;
    if (viewport.scrollLeft !== before) event.preventDefault();
  };

  if (sessions.length === 0) return null;

  const activeBinding = activeSessionId
    ? sidecarForSession(sidecars, activeSessionId)
    : null;
  const menuSession = menuFor
    ? sessions.find((candidate) => candidate.id === menuFor.sessionId)
    : null;

  return (
    <div className="flex w-full min-w-0 items-center rounded-lg border border-border-subtle bg-bg-secondary p-0.5">
      <div className="relative min-w-0 flex-1 self-stretch">
        <div
          ref={viewportRef}
          onWheel={handleWheel}
          className="tab-strip-scroll flex h-full min-w-0 overflow-x-auto overscroll-x-contain"
        >
          <div ref={contentRef} className="flex min-w-max items-center">
            {sessions.map((session) => {
              const active = session.id === activeSessionId;
              const binding = sidecarForSession(sidecars, session.id);
              const inActiveWorkspace =
                Boolean(binding) && binding?.ownerSessionId === activeBinding?.ownerSessionId;
              const ui = sessionUi[session.id];
              // Derived at render time, never stored. See lib/sessionTitle.ts for
              // the full precedence. Nothing here can be clobbered by OSC 7.
              const label = resolveSessionTitle(session, ui);
              const editing = renamingSessionId === session.id;
              return (
                <div key={session.id} className="relative flex shrink-0">
                  <button
                    ref={(node) => {
                      if (node) tabRefs.current.set(session.id, node);
                      else tabRefs.current.delete(session.id);
                    }}
                    type="button"
                    onClick={() => setActiveSession(session.id)}
                    onDoubleClick={() => setRenamingSession(session.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setActiveSession(session.id);
                      const rect = e.currentTarget.getBoundingClientRect();
                      setMenuFor({
                        sessionId: session.id,
                        left: Math.max(4, Math.min(rect.left, window.innerWidth - 184)),
                        top: rect.bottom + 4,
                      });
                    }}
                    className={`group flex min-w-0 items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-all duration-150 ${
                      active
                        ? "bg-bg-hover text-text-primary shadow-sm"
                        : inActiveWorkspace
                          ? "bg-accent/5 text-text-secondary ring-1 ring-inset ring-accent/20"
                          : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    <SessionIndicators session={session} ui={ui} binding={binding} />
                    {editing ? (
                      <RenameInput session={session} current={label} />
                    ) : (
                      <span
                        // The label truncates at 120px, so without this a long
                        // name is unrecoverable.
                        title={`${label}${session.userTitle ? "" : ` — ${S.tabs.renameHint}`}`}
                        // Struck through rather than dimmed. An inactive tab is
                        // already text-muted, which sits at the AA threshold.
                        // Strikethrough carries the same "this one is done"
                        // signal at full contrast in both tab states.
                        className={`max-w-[120px] truncate ${session.exited ? "line-through decoration-1" : ""}`}
                      >
                        {label}
                      </span>
                    )}
                    {isNaming(session.id) && (
                      <Loader2 size={10} className="shrink-0 animate-spin" />
                    )}
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
                </div>
              );
            })}
          </div>
        </div>
        {scrollState.canScrollLeft && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 start-0 w-5 bg-gradient-to-r from-bg-secondary to-transparent"
          />
        )}
        {scrollState.canScrollRight && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 end-0 w-5 bg-gradient-to-l from-bg-secondary to-transparent"
          />
        )}
      </div>
      {menuFor && menuSession && (
        <TabMenu
          session={menuSession}
          left={menuFor.left}
          top={menuFor.top}
          onClose={() => setMenuFor(null)}
          onRename={() => setRenamingSession(menuSession.id)}
        />
      )}
      <div ref={overflowLayerRef} className="relative shrink-0">
        <button
          type="button"
          aria-label={S.tabs.allOpenHint(sessions.length)}
          aria-haspopup="listbox"
          aria-expanded={scrollState.overflowing ? overflowOpen : false}
          aria-controls={overflowOpen ? overflowListId : undefined}
          aria-hidden={!scrollState.overflowing}
          tabIndex={scrollState.overflowing ? 0 : -1}
          onClick={() => setOverflowOpen((open) => !open)}
          className={`rounded-md p-1 text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary ${
            scrollState.overflowing ? "" : "invisible pointer-events-none"
          }`}
          title={S.tabs.allOpenHint(sessions.length)}
        >
          <ChevronDown size={13} />
        </button>
        {overflowOpen && scrollState.overflowing && (
          <AllTerminalsMenu
            id={overflowListId}
            sessions={sessions}
            activeSessionId={activeSessionId}
            sessionUi={sessionUi}
            sidecars={sidecars}
            onSelect={(sessionId) => {
              setActiveSession(sessionId);
              setOverflowOpen(false);
            }}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => void createSession().catch(() => {})}
        className="shrink-0 rounded-md p-1 text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        title={S.header.newTab}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function SessionIndicators({
  session,
  ui,
  binding,
}: {
  session: Session;
  ui: SessionUiState | undefined;
  binding: SidecarBinding | null;
}) {
  const running = ui?.runningBlockId != null;
  const lastBlock = ui?.blocks[ui.blocks.length - 1];
  const failed =
    !running && lastBlock?.state === "done" && (lastBlock.exitCode ?? 0) !== 0;
  const linkedRole = binding ? roleForSession(binding, session.id) : null;
  // Filled means connected now. Hollow means the tab belongs to a saved host,
  // but the connection is gone.
  const connected = ui?.remote != null;
  const forHost = session.hostId != null;

  return (
    <>
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
    </>
  );
}

function AllTerminalsMenu({
  id,
  sessions,
  activeSessionId,
  sessionUi,
  sidecars,
  onSelect,
}: {
  id: string;
  sessions: readonly Session[];
  activeSessionId: string | null;
  sessionUi: Readonly<Record<string, SessionUiState | undefined>>;
  sidecars: Readonly<Record<string, SidecarBinding>>;
  onSelect: (sessionId: string) => void;
}) {
  const activeOptionRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeSessionId]);

  return (
    <div
      id={id}
      role="listbox"
      aria-label={S.tabs.allOpen}
      className="absolute end-0 top-full z-50 mt-1 max-h-[320px] w-64 overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-lg"
    >
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        const ui = sessionUi[session.id];
        const binding = sidecarForSession(sidecars, session.id);
        const label = resolveSessionTitle(session, ui);
        return (
          <button
            key={session.id}
            ref={active ? activeOptionRef : undefined}
            type="button"
            role="option"
            aria-selected={active}
            title={label}
            onClick={() => onSelect(session.id)}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-[11px] transition-colors duration-100 ${
              active
                ? "bg-accent/15 text-accent"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            <Terminal size={11} className="shrink-0" />
            <SessionIndicators session={session} ui={ui} binding={binding} />
            <span
              className={`min-w-0 flex-1 truncate ${
                session.exited ? "line-through decoration-1" : ""
              }`}
            >
              {label}
            </span>
            {active && <Check size={11} className="shrink-0" />}
          </button>
        );
      })}
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
  left,
  top,
  onClose,
  onRename,
}: {
  session: Session;
  left: number;
  top: number;
  onClose: () => void;
  onRename: () => void;
}) {
  const { closeSession } = useSessions();
  const [naming, setNaming] = useState(false);
  const [namingError, setNamingError] = useState<string | null>(null);

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
      <div
        className="fixed z-50 min-w-[176px] overflow-hidden rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-lg"
        style={{ left, top }}
      >
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
          disabled={naming}
          onClick={() => {
            setNaming(true);
            setNamingError(null);
            void renameSessionWithAi(session.id)
              .then(onClose)
              .catch((reason) => {
                setNamingError(reason instanceof Error ? reason.message : String(reason));
              })
              .finally(() => {
                setNaming(false);
              });
          }}
        >
          {naming ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          {naming ? S.tabs.naming : S.tabs.renameWithAi}
        </button>
        {namingError && (
          <p role="alert" className="px-2.5 py-1 text-[10px] leading-snug text-error">
            {namingError}
          </p>
        )}
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
