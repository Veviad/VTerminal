import { Settings, Cpu, History, ListChecks, ScanText } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { ModelMenu } from "./ModelMenu";
import { VisionMenu } from "./VisionMenu";
import { TabStrip } from "./TabStrip";
import { S } from "../../lib/strings";
import { RunbookStatusIndicator } from "../runbooks";
import { selectLiveRunbookRun, useRunbookStore } from "../../stores/runbookStore";
import { useChatStore } from "../../stores/chatStore";
import { getTerm } from "../../lib/termRegistry";

export function Header() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const sessionBrowserOpen = useAppStore((s) => s.sessionBrowserOpen);
  const setSessionBrowserOpen = useAppStore((s) => s.setSessionBrowserOpen);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visionMenuOpen, setVisionMenuOpen] = useState(false);
  const loadedModelId = useAppStore((s) => s.loadedModelId);
  const modelState = useAppStore((s) => s.modelState);
  const aiReady = useAppStore((s) => s.aiReady());
  const catalog = useAppStore((s) => s.catalog);
  const activeModelId = useAppStore((s) => s.activeModelId);
  // Primitives, not the object: `imageReader()` returns a fresh one each call and
  // zustand v5 compares by identity, so selecting it whole re-renders forever.
  const readerKind = useAppStore((s) => s.imageReader().kind);
  const readerLabel = useAppStore((s) => s.imageReader().label);
  const runbooksEnabled = useAppStore((s) => s.runbooksEnabled);
  const runbooksOpen = useRunbookStore((s) => s.workspaceOpen);
  const activeRun = useRunbookStore((s) => s.activeRun);
  const runsById = useRunbookStore((s) => s.runsById);
  const setRunbooksOpen = useRunbookStore((s) => s.setWorkspaceOpen);
  const visibleRun = selectLiveRunbookRun(activeRun, runsById);
  const workspaceMode = useChatStore((s) => s.workspaceMode);
  const switchWorkspace = (mode: "terminal" | "chat") => {
    void useChatStore.getState().setWorkspaceMode(mode);
    if (mode === "terminal") {
      requestAnimationFrame(() => {
        const sessionId = useAppStore.getState().activeSessionId;
        const entry = sessionId ? getTerm(sessionId) : undefined;
        entry?.fit.fit();
        entry?.term.focus();
      });
    }
  };

  // The chip names the model that will actually answer, which is the SELECTED
  // one — never the one that happens to still be resident. Preferring
  // loadedModelId here made switching to an API model look like a no-op while
  // requests were already going to it.
  const active = catalog.find((m) => m.id === activeModelId);
  const modelLabel =
    modelState === "loading" && loadedModelId === activeModelId
      ? S.header.loadingModel
      : active
        ? active.label
        : S.header.noModel;

  return (
    <header
      className="flex h-11 shrink-0 items-center justify-between border-b px-3 border-border-subtle bg-bg-primary"
      data-tauri-drag-region
    >
      {/* Left: traffic-light inset + logo. Standard OS decorations like Cowork,
          so no extra inset is needed — the native title bar sits above us. */}
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <img src="/vterminal-mark.svg" alt="" className="h-5 w-[14px]" />
        <span className="text-[13px] font-medium text-text-secondary">{S.app.name}</span>
      </div>

      {/* Center: workspace switch plus the active workspace's navigation. */}
      <div className="flex min-w-0 items-center gap-2 px-2">
        <div className="flex rounded-lg bg-bg-hover p-0.5 text-[10px]" data-tauri-drag-region="false">
          <button onClick={() => switchWorkspace("terminal")} className={`rounded-md px-2.5 py-1 ${workspaceMode === "terminal" ? "bg-bg-card text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}>Terminal</button>
          <button onClick={() => switchWorkspace("chat")} className={`rounded-md px-2.5 py-1 ${workspaceMode === "chat" ? "bg-bg-card text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}>Chat</button>
        </div>
        {workspaceMode === "terminal" && <TabStrip />}
      </div>

      {/* Right: model chip + past sessions + settings. The AI panel toggle lives
          on the panel itself (rail to expand, chevron to collapse) — a third
          control here sat inches from the rail's and did the same thing. */}
      <div className="relative flex items-center gap-1">
        {/* Only when a SECOND model is doing the reading. A chat model with native
            vision reads images itself, so there is nothing else to name and a
            second chip would be noise; the `none` case is deliberately silent here
            too — the panel says so at the moment an image is attached, which is
            where it matters, instead of nagging anyone who never attaches one. */}
        {readerKind === "sidecar" && (
          <button
            onClick={() => setVisionMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-bg-hover px-2.5 py-1 font-mono text-[11px] text-text-secondary transition-colors duration-150 hover:text-text-primary"
            title={S.header.imageReader(readerLabel ?? "")}
          >
            <ScanText size={12} />
            <span className="max-w-[130px] truncate">{readerLabel}</span>
          </button>
        )}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-[11px] transition-colors duration-150 ${
            aiReady
              ? "bg-accent/10 text-accent hover:bg-accent/15"
              : "bg-bg-hover text-text-secondary hover:text-text-primary"
          }`}
          title="Model"
        >
          <Cpu size={12} />
          <span className="max-w-[160px] truncate">{modelLabel}</span>
        </button>
        {visionMenuOpen && <VisionMenu onClose={() => setVisionMenuOpen(false)} />}
        {menuOpen && <ModelMenu onClose={() => setMenuOpen(false)} />}
        {runbooksEnabled && visibleRun && !runbooksOpen ? (
          <RunbookStatusIndicator />
        ) : runbooksEnabled ? (
          <button
            onClick={() => {
              setSettingsOpen(false);
              setRunbooksOpen(!runbooksOpen);
            }}
            className={`rounded-lg p-1.5 transition-colors duration-150 ${
              runbooksOpen
                ? "bg-accent/10 text-accent"
                : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            }`}
            title={runbooksOpen ? "Close Runbooks" : "Open Runbooks"}
            aria-label={runbooksOpen ? "Close Runbooks" : "Open Runbooks"}
          >
            <ListChecks size={16} />
          </button>
        ) : null}
        {/* Settings stays the trailing item — it is the one control people hit by
            muscle memory rather than by looking. Uses the neutral active
            treatment, not the accent one: accent means "the AI surface is live",
            and a list of past sessions is chrome. */}
        <button
          onClick={() => setSessionBrowserOpen(!sessionBrowserOpen)}
          className={`rounded-lg p-1.5 transition-colors duration-150 ${
            sessionBrowserOpen
              ? "bg-bg-hover text-text-primary"
              : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          }`}
          title={S.header.sessions}
        >
          <History size={16} />
        </button>
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className={`rounded-lg p-1.5 transition-colors duration-150 ${
            settingsOpen
              ? "bg-bg-hover text-text-primary"
              : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          }`}
          title={S.header.settings}
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}

export function displayModelName(idOrFile: string): string {
  // "unsloth/Qwen3.5-9B-GGUF::Qwen3.5-9B-Q4_K_M.gguf" or a bare filename
  const file = idOrFile.includes("::") ? idOrFile.split("::")[1] : idOrFile;
  return file
    .replace(/\.gguf$/i, "")
    .replace(/-(UD-)?(I?Q\d[_A-Z0-9]*)$/i, "")
    .replace(/-Instruct/i, "");
}
