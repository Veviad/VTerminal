import { Header } from "./Header";
import { StatusBar } from "./StatusBar";
import { TerminalPane } from "../terminal/TerminalPane";
import { AiPanel } from "../ai/AiPanel";
import { CommandPalette } from "../palette/CommandPalette";
import { SessionBrowser } from "../sessions/SessionBrowser";
import { SettingsPage } from "../settings/SettingsPage";
import { UpdateModal } from "../updates/UpdateModal";
import { useAppStore } from "../../stores/appStore";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";
import { S } from "../../lib/strings";
import { Kbd } from "../ui/Kbd";
import { shortcutFor } from "../../lib/keymap";
import { RunbooksWorkspace } from "../runbooks";
import { useRightPanel } from "../../lib/rightPanel";
import { SchedulesWorkspace } from "../schedules";
import { useScheduledActions } from "../../hooks/useScheduledActions";
import { resolveAiOwner, sidecarForSession } from "../../lib/sidecar";
import { SidecarWorkspace } from "../sidecar/SidecarWorkspace";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import { useChatStore } from "../../stores/chatStore";

export function AppShell() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sidecars = useAppStore((s) => s.sidecars);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const sessionBrowserOpen = useAppStore((s) => s.sessionBrowserOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const workspaceMode = useChatStore((s) => s.workspaceMode);
  const rightPanel = useRightPanel();
  useGlobalShortcuts();
  // Mounted unconditionally and gated internally. Runbooks can initialise on
  // panel mount because its runs are user-started; a scheduled action fires with
  // the panel closed, so its driver cannot live inside the panel.
  useScheduledActions();
  const sidecar = activeSessionId ? sidecarForSession(sidecars, activeSessionId) : null;
  const aiSessionId = activeSessionId ? resolveAiOwner(sidecars, activeSessionId) : null;
  const linkedIds = sidecar
    ? new Set([sidecar.localSessionId, sidecar.remoteSessionId])
    : null;

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header />
      <div className="relative flex min-h-0 flex-1">
        <div
          className="absolute inset-0 flex"
          style={{ visibility: workspaceMode === "terminal" ? "visible" : "hidden" }}
          aria-hidden={workspaceMode !== "terminal"}
        >
          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {sessions.map((s) =>
              linkedIds?.has(s.id) ? null : (
                <TerminalPane key={s.id} sessionId={s.id} active={s.id === activeSessionId} />
              ),
            )}
            {sidecar && <SidecarWorkspace binding={sidecar} />}
            {sessions.length === 0 && <EmptyState />}
          </main>
          {settingsLoaded &&
            (rightPanel === "runbooks" ? (
              <RunbooksWorkspace sessionId={activeSessionId} />
            ) : rightPanel === "schedules" ? (
              // No `sessionId`: a scheduled target is a local shell or a saved
              // host, never "the tab that happens to be active".
              <SchedulesWorkspace />
            ) : (
              <AiPanel sessionId={aiSessionId} />
            ))}
        </div>
        <div
          className="absolute inset-0"
          style={{ visibility: workspaceMode === "chat" ? "visible" : "hidden" }}
          aria-hidden={workspaceMode !== "chat"}
        >
          <ChatWorkspace />
        </div>
        {/* Settings is an overlay, NOT an early return — terminals must stay mounted. */}
        {settingsOpen && (
          <div className="absolute inset-0 z-40 bg-bg-primary">
            <SettingsPage />
          </div>
        )}
      </div>
      <StatusBar />
      {paletteOpen && <CommandPalette />}
      {/* A sibling of the palette, not a child of the content row: unlike
          Settings (which is `absolute inset-0` INSIDE that row and so leaves the
          header clickable), this is a modal and must cover the header and status
          bar too. It supplies its own backdrop at z-50. */}
      {sessionBrowserOpen && <SessionBrowser />}
      <UpdateModal />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-bg-terminal">
      <img src="/vterminal-mark.svg" alt="" className="h-10 w-7 opacity-40" />
      <p className="text-[13px] text-text-muted">{S.empty.title}</p>
      <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <Kbd>{shortcutFor("new-tab")}</Kbd> {S.empty.openTerminal}
      </p>
    </div>
  );
}
