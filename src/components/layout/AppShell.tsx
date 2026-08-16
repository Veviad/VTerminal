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
import { useRunbookStore } from "../../stores/runbookStore";

export function AppShell() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const sessionBrowserOpen = useAppStore((s) => s.sessionBrowserOpen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const runbooksEnabled = useAppStore((s) => s.runbooksEnabled);
  const runbooksOpen = useRunbookStore((s) => s.workspaceOpen);
  useGlobalShortcuts();

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header />
      <div className="relative flex min-h-0 flex-1">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {sessions.map((s) => (
            <TerminalPane key={s.id} sessionId={s.id} active={s.id === activeSessionId} />
          ))}
          {sessions.length === 0 && <EmptyState />}
        </main>
        {/* Gated on settingsLoaded, not on the open flag: the store defaults to
            open, so rendering before hydration would flash the panel open for
            anyone who left it collapsed. AiPanel itself renders the rail. */}
        {settingsLoaded && runbooksEnabled && runbooksOpen ? (
          <RunbooksWorkspace sessionId={activeSessionId} />
        ) : (
          settingsLoaded && <AiPanel sessionId={activeSessionId} />
        )}
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
