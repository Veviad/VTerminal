import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Server, TerminalSquare, Zap, Cpu } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useSessions } from "../../hooks/useSessions";
import { useSettings } from "../../hooks/useSettings";
import * as api from "../../lib/tauri";
import { getTerm } from "../../lib/termRegistry";
import { THEMES } from "../../lib/themes";
import { canConnectHere, connectToHost } from "../../lib/sshConnect";
import { renameSessionWithAi } from "../../lib/sessionNaming";
import { isUsable } from "../../lib/selectModel";
import { toggleAiPanel } from "../../lib/aiPanel";
import { describeSshTarget } from "../../lib/ssh";
import { S } from "../../lib/strings";
import type { HistoryEntry, SshHost } from "../../lib/types";
import { useRunbookStore } from "../../stores/runbookStore";
import { shortcutFor, usesAlternateAction } from "../../lib/keymap";

interface PaletteItem {
  id: string;
  section: "actions" | "hosts" | "history" | "models";
  label: string;
  hint?: string;
  /** Extra text the filter matches — a host must be findable by its hostname,
   *  not only by the label the user gave it. */
  keywords?: string;
  run(): void;
  /** History: ⌘⏎ runs instead of inserting. Hosts: ⌘⏎ uses the current tab. */
  runAlt?(): void;
}

export function CommandPalette() {
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const { createSession, closeSession } = useSessions();
  const { save } = useSettings();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void api.historyRecent(50).then(setHistory).catch(() => {});
    void api.sshHostsList().then(setHosts).catch(() => {});
  }, []);

  // Evaluated once per palette open: this is transient UI, and the answer the
  // user needs is "can ⌘⏎ work right now", which cannot change while they read.
  const gate = useMemo(() => canConnectHere(useAppStore.getState().activeSessionId), []);

  const close = () => {
    setPaletteOpen(false);
    const s = useAppStore.getState();
    if (s.activeSessionId) getTerm(s.activeSessionId)?.term.focus();
  };

  const items = useMemo<PaletteItem[]>(() => {
    // run() callbacks read the store AT CLICK TIME — a snapshot captured when
    // the memo built would act on whatever tab was active back then.
    const live = () => useAppStore.getState();
    const actions: PaletteItem[] = [
      {
        id: "act-new-tab",
        section: "actions",
        label: "New tab",
        hint: shortcutFor("new-tab"),
        run: () => void createSession().catch(() => {}),
      },
      {
        id: "act-close-tab",
        section: "actions",
        label: "Close tab",
        hint: shortcutFor("close-tab"),
        run: () => {
          const s = live();
          if (s.activeSessionId) void closeSession(s.activeSessionId);
        },
      },
      {
        id: "act-rename-tab",
        section: "actions",
        label: S.tabs.rename,
        run: () => {
          const s = live();
          if (s.activeSessionId) s.setRenamingSession(s.activeSessionId);
        },
      },
      {
        id: "act-rename-tab-ai",
        section: "actions",
        label: S.tabs.renameWithAi,
        run: () => {
          const s = live();
          if (s.activeSessionId) {
            // The palette closes as soon as an item runs, so the tab-menu error
            // line is not available here. Keep the failure in diagnostics; the
            // context-menu action provides the interactive retry/error surface.
            void renameSessionWithAi(s.activeSessionId).catch((reason) => {
              console.warn("AI tab rename failed:", reason);
            });
          }
        },
      },
      {
        id: "act-clear",
        section: "actions",
        label: "Clear terminal",
        hint: "⌃L",
        run: () => {
          const s = live();
          if (s.activeSessionId) getTerm(s.activeSessionId)?.term.clear();
        },
      },
      {
        id: "act-ai-panel",
        section: "actions",
        label: "Toggle AI panel",
        hint: shortcutFor("toggle-ai-panel"),
        run: () => toggleAiPanel(),
      },
      {
        id: "act-composer",
        section: "actions",
        label: "AI command suggestion",
        hint: shortcutFor("toggle-composer"),
        run: () => {
          const s = live();
          if (s.activeSessionId) {
            s.updateSessionUi(s.activeSessionId, { composerOpen: true });
          }
        },
      },
      {
        id: "act-session-browser",
        section: "actions",
        label: S.sessions.title,
        hint: shortcutFor("session-browser"),
        keywords: "archive reopen closed tabs recent",
        run: () => live().setSessionBrowserOpen(true),
      },
      ...(live().runbooksEnabled
        ? [
            {
              id: "act-runbooks",
              section: "actions" as const,
              label: "Open Runbooks",
              keywords: "checklist automation security install infrastructure",
              run: () => useRunbookStore.getState().setWorkspaceOpen(true),
            },
          ]
        : []),
      {
        id: "act-settings",
        section: "actions",
        label: "Open settings",
        hint: shortcutFor("open-settings"),
        run: () => live().setSettingsOpen(true),
      },
      {
        id: "act-manage-hosts",
        section: "actions",
        label: S.palette.manageHosts,
        run: () => live().setSettingsOpen(true),
      },
      ...THEMES.map((t) => ({
        id: `act-theme-${t.id}`,
        section: "actions" as const,
        label: `Theme: ${t.name}`,
        run: () => void save({ theme: t.id }),
      })),
    ];

    const hostItems: PaletteItem[] = hosts.map((h) => ({
      id: `host-${h.id}`,
      section: "hosts",
      label: h.label,
      keywords: `${describeSshTarget(h)} ${h.tag ?? ""} ${h.config_alias ?? ""}`,
      // The gate's answer is delivered here, on the item the user is looking at
      // as they choose — the app has no toast channel and does not need one.
      hint: gate.ok
        ? describeSshTarget(h)
        : `${describeSshTarget(h)} · ${shortcutFor("command-palette").replace(/K$/, "Enter")} ${gate.reason}`,
      // ⏎ is the safe one: a fresh tab, nothing existing can be clobbered.
      run: () => void connectToHost(h, "new-tab", createSession),
      // ⌘⏎ acts on your live shell — the same gradient as the history section.
      runAlt: gate.ok ? () => void connectToHost(h, "current-tab", createSession) : undefined,
    }));

    const historyItems: PaletteItem[] = history.map((h, i) => ({
      id: `hist-${i}`,
      section: "history",
      label: h.command,
      hint: h.exit_code === 0 ? undefined : `exit ${h.exit_code}`,
      run: () => {
        const s = live();
        if (s.activeSessionId) void api.ptyWrite(s.activeSessionId, h.command);
      },
      runAlt: () => {
        const s = live();
        if (s.activeSessionId) void api.ptyWrite(s.activeSessionId, `${h.command}\r`);
      },
    }));

    const modelItems: PaletteItem[] = [
      // Only runnable on-device models can be loaded from here; an API model is
      // switched to in Settings, not loaded. `isUsable` is what keeps a GGUF
      // left over from an earlier local-llm build out of this list — loading it
      // in a build without the engine only produces an error.
      ...useAppStore
        .getState()
        .catalog.filter(
          (m) => m.local && isUsable(m) && m.id !== useAppStore.getState().loadedModelId,
        )
        .map((m) => ({
          id: `model-${m.id}`,
          section: "models" as const,
          label: `${S.palette.loadModel} ${m.label}`,
          run: () => {
            void api.modelLoad(m.id, () => {}).then(async () => {
              const st = await api.modelStatus();
              useAppStore
                .getState()
                .setModelStatus(st.loaded, st.state, st.available, st.acceleration);
            });
            useAppStore.getState().setModelStatus(m.id, "loading", true);
          },
        })),
      {
        id: "model-manage",
        section: "models",
        label: S.palette.manageModels,
        run: () => useAppStore.getState().setSettingsOpen(true),
      },
    ];

    return [...actions, ...hostItems, ...historyItems, ...modelItems];
  }, [history, hosts, gate, createSession, closeSession, save]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((i) => `${i.label} ${i.keywords ?? ""}`.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

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
      if (item) {
        if (usesAlternateAction(e.nativeEvent) && item.runAlt) item.runAlt();
        else item.run();
        close();
      }
    } else if (e.key === "Escape") {
      // Consume it — the window-level Escape handler would otherwise also
      // close the next overlay in the same keypress.
      e.stopPropagation();
      close();
    }
  };

  // Hosts sit above history: few items, high intent.
  const sections: { key: PaletteItem["section"]; label: string }[] = [
    { key: "actions", label: S.palette.actions },
    { key: "hosts", label: S.palette.hosts },
    { key: "history", label: S.palette.history },
    { key: "models", label: S.palette.models },
  ];

  const hintText =
    filtered[selected]?.section === "hosts" ? S.palette.hostsHint : S.palette.runHint;

  return (
    <div className="fixed inset-0 z-50 bg-black/50" onMouseDown={close}>
      <div
        className="mx-auto mt-24 w-[560px] overflow-hidden rounded-lg border border-border-subtle bg-bg-card shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3">
          <Search size={14} className="text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={S.palette.placeholder}
            /* Autofocused the moment the dialog opens, and the only control in
               it — a focus ring here is noise, not a wayfinding aid. */
            className="w-full bg-transparent py-2.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:outline-none"
          />
          <span className="shrink-0 text-[9px] text-text-muted">{hintText}</span>
        </div>
        <div ref={listRef} className="max-h-[320px] overflow-y-auto pb-1">
          {filtered.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-text-muted">
              {S.palette.noResults}
            </p>
          )}
          {sections.map(({ key, label }) => {
            const sectionItems = filtered.filter((i) => i.section === key);
            if (!sectionItems.length) return null;
            return (
              <div key={key}>
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                  {label}
                </p>
                {sectionItems.map((item) => {
                  const idx = filtered.indexOf(item);
                  const active = idx === selected;
                  return (
                    <button
                      key={item.id}
                      data-index={idx}
                      onClick={() => {
                        item.run();
                        close();
                      }}
                      onMouseMove={() => setSelected(idx)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-start text-[12px] transition-colors duration-75 ${
                        active ? "bg-bg-hover text-text-primary" : "text-text-secondary"
                      }`}
                    >
                      {key === "actions" && <Zap size={12} className="shrink-0 text-text-muted" />}
                      {key === "hosts" && (
                        <Server size={12} className="shrink-0 text-text-muted" />
                      )}
                      {key === "history" && (
                        <TerminalSquare size={12} className="shrink-0 text-text-muted" />
                      )}
                      {key === "models" && <Cpu size={12} className="shrink-0 text-text-muted" />}
                      <span className={`min-w-0 flex-1 truncate ${key === "history" ? "font-mono text-[11px]" : ""}`}>
                        {item.label}
                      </span>
                      {item.hint && (
                        <span className="shrink-0 font-mono text-[10px] text-text-muted">
                          {item.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
