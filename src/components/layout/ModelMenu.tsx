import { useEffect, useRef } from "react";
import { Check, Cpu, Settings2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { isUsable, refreshModels, selectModel } from "../../lib/selectModel";
import { S } from "../../lib/strings";
import type { CatalogEntry } from "../../lib/types";

/**
 * The model chip's dropdown.
 *
 * Deliberately NOT the command palette: a control labelled with a model name
 * should switch models, not surface SSH hosts and shell history. It lists only
 * models that can actually answer right now — anything else would offer a
 * choice that silently fails — and sends everything else to Settings.
 */
export function ModelMenu({ onClose }: { onClose: () => void }) {
  const catalog = useAppStore((s) => s.catalog);
  const activeModelId = useAppStore((s) => s.activeModelId);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const engineMissing = useAppStore((s) => s.localEngineMissing());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshModels().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // `mousedown`, not `click`: the chip's own click would otherwise re-open it.
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const usable = catalog.filter(isUsable);

  const pick = (entry: CatalogEntry) => {
    onClose();
    void selectModel(entry).catch(() => {});
  };

  return (
    <div
      ref={ref}
      className="absolute end-0 top-9 z-50 w-64 overflow-hidden rounded-lg border border-border-subtle bg-bg-card shadow-lg"
    >
      <div className="max-h-[320px] overflow-y-auto py-1">
        {usable.length === 0 && (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-text-muted">
            {/* Never suggest downloading an on-device model in a build that
                could not run one — `isUsable` has already filtered them out. */}
            {engineMissing ? S.modelMenu.emptyNoEngine : S.modelMenu.empty}
          </p>
        )}
        {usable.map((entry) => {
          const active = entry.id === activeModelId;
          return (
            <button
              key={entry.id}
              onClick={() => pick(entry)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-start transition-colors duration-100 ${
                active ? "bg-accent-subtle" : "hover:bg-bg-hover"
              }`}
            >
              <Cpu size={12} className={active ? "text-accent" : "text-text-muted"} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12px] ${
                    active ? "text-accent" : "text-text-primary"
                  }`}
                >
                  {entry.label}
                </span>
                <span className="block truncate text-[10px] text-text-muted">
                  {/* "API" would be wrong for a LAN box in the way that matters:
                      it implies per-token cost and prompts leaving the network.
                      The server's own label says more than any static word —
                      which is why `RemoteRef` carries it. */}
                  {entry.local
                    ? S.modelMenu.onDevice
                    : (entry.remote?.server_label ?? S.modelMenu.api)}
                </span>
              </span>
              {active && <Check size={12} className="shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
      <button
        onClick={() => {
          onClose();
          setSettingsOpen(true);
        }}
        className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-start text-[11px] text-text-secondary transition-colors duration-100 hover:bg-bg-hover"
      >
        <Settings2 size={12} />
        {S.modelMenu.configure}
      </button>
    </div>
  );
}
