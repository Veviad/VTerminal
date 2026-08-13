import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { ModelsSettings } from "./ModelsSettings";
import { AppearanceSection } from "./AppearanceSection";
import { TerminalSection } from "./TerminalSection";
import { AgentSection } from "./AgentSection";
import { DocsSettings } from "./DocsSettings";
import { SshHostsSection } from "./SshHostsSection";
import { Row } from "../ui/Row";
import { S } from "../../lib/strings";

type Tab = "models" | "agent" | "docs" | "appearance" | "terminal" | "hosts" | "about";

// The Docs tab is listed even while the feature is off: its own toggle is the first
// thing inside it, and a tab that only appears once the feature is enabled leaves the
// switch nowhere to be found.
const TABS: { id: Tab; label: string }[] = [
  { id: "models", label: S.settings.tabs.models },
  { id: "agent", label: S.settings.tabs.agent },
  { id: "docs", label: S.settings.tabs.docs },
  { id: "appearance", label: S.settings.tabs.appearance },
  { id: "terminal", label: S.settings.tabs.terminal },
  { id: "hosts", label: S.settings.tabs.hosts },
  { id: "about", label: S.settings.tabs.about },
];

export function SettingsPage() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<Tab>("models");

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <button
          onClick={() => setSettingsOpen(false)}
          className="rounded-lg p-1.5 text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="text-[13px] font-medium text-text-primary">{S.settings.title}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="w-[180px] shrink-0 space-y-0.5 border-e border-border-subtle bg-bg-secondary p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full rounded-lg px-2.5 py-1.5 text-start text-[12px] font-medium transition-colors duration-150 ${
                tab === t.id
                  ? "bg-bg-hover text-text-primary"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-lg px-6 py-6">
            {tab === "models" && <ModelsSettings />}
            {tab === "agent" && <AgentSection />}
            {tab === "docs" && <DocsSettings />}
            {tab === "appearance" && <AppearanceSection />}
            {tab === "terminal" && <TerminalSection />}
            {tab === "hosts" && <SshHostsSection />}
            {tab === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AboutSection() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <img src="/vterminal-mark.svg" alt="" className="h-10 w-7" />
        <div>
          <p className="text-[14px] font-medium text-text-primary">{S.app.name}</p>
          <p className="text-[11px] text-text-muted">
            {S.settings.about.version} {__APP_VERSION__} · {S.settings.about.build} {__BUILD_NUMBER__} ·{" "}
            <span className="font-mono">{__GIT_HASH__}</span>
          </p>
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-text-secondary">
        {S.settings.about.description}
      </p>
      <div className="space-y-1.5 border-t border-border-subtle pt-4">
        <Row label={S.settings.about.author}>
          <span className="text-[12px] text-text-primary">{__APP_AUTHOR__}</span>
        </Row>
        <Row label={S.settings.about.publisher}>
          <span className="text-[12px] text-text-primary">{__APP_PUBLISHER__}</span>
        </Row>
      </div>
      <p className="text-[10px] text-text-muted">{__APP_COPYRIGHT__}</p>
    </div>
  );
}
