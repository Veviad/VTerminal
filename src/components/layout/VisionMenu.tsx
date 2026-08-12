import { useEffect, useRef } from "react";
import { Check, ScanText, Settings2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { refreshModels, selectVisionModel } from "../../lib/selectModel";
import { formatBytes } from "../settings/ModelRow";
import { S } from "../../lib/strings";
import type { VisionCatalogEntry } from "../../lib/types";

/**
 * The image-reader chip's dropdown — the twin of `ModelMenu`.
 *
 * Differs from that one in what it shows and why. `ModelMenu` lists only models
 * that can answer right now, because offering an unusable one is offering a choice
 * that silently fails. Here the unusable rows are worth SHOWING but disabled: the
 * whole set is three curated models, the reasons they are unavailable are
 * actionable ("not downloaded", "will not fit beside your chat model"), and hiding
 * them would make the menu look like the feature does not exist.
 */
export function VisionMenu({ onClose }: { onClose: () => void }) {
  const entries = useAppStore((s) => s.visionCatalog);
  const selected = useAppStore((s) => s.visionModelId);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshModels().catch(() => {});
  }, []);

  // Identical dismissal contract to ModelMenu, including `mousedown` rather than
  // `click` — the chip's own click would otherwise immediately re-open it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const pick = (entry: VisionCatalogEntry) => {
    onClose();
    // Through selectVisionModel so the same reconcile runs as in Settings: persist,
    // then unload whatever else was resident rather than holding gigabytes for a
    // model nothing will call.
    void selectVisionModel(entry.id).catch(() => {});
  };

  const why = (entry: VisionCatalogEntry): string | null => {
    if (!entry.downloaded) return S.vision.notDownloaded;
    if (!entry.fits) return S.visionMenu.wontFit(entry.required_ram_gb);
    return null;
  };

  return (
    <div
      ref={ref}
      className="absolute end-0 top-9 z-50 w-72 overflow-hidden rounded-lg border border-border-subtle bg-bg-card shadow-lg"
    >
      <p className="border-b border-border-subtle px-3 py-2 text-[10px] font-medium uppercase tracking-widest text-text-muted">
        {S.visionMenu.title}
      </p>
      <div className="max-h-[320px] overflow-y-auto py-1">
        {entries.length === 0 && (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-text-muted">
            {S.visionMenu.empty}
          </p>
        )}
        {entries.map((entry) => {
          const active = entry.id === selected;
          const blocked = why(entry);
          return (
            <button
              key={entry.id}
              onClick={() => pick(entry)}
              disabled={!!blocked}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-start transition-colors duration-100 ${
                active ? "bg-accent-subtle" : "hover:bg-bg-hover"
              } ${blocked ? "opacity-60" : ""}`}
            >
              <ScanText size={12} className={active ? "text-accent" : "text-text-muted"} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12px] ${
                    active ? "text-accent" : "text-text-primary"
                  }`}
                >
                  {entry.label}
                </span>
                <span className="block truncate text-[10px] text-text-muted">
                  {blocked ?? formatBytes(entry.total_bytes)}
                </span>
              </span>
              {active && <Check size={12} className="shrink-0 text-accent" />}
            </button>
          );
        })}
        {/* Turning it OFF is a real choice, not just an absence — a chat model with
            native vision does not need a reader, and one loaded anyway costs
            gigabytes for nothing. */}
        {selected && (
          <button
            onClick={() => {
              onClose();
              void selectVisionModel(null).catch(() => {});
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-[11px] text-text-muted transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
          >
            <span className="w-3" />
            {S.visionMenu.turnOff}
          </button>
        )}
      </div>
      <button
        onClick={() => {
          onClose();
          setSettingsOpen(true);
        }}
        className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-start text-[11px] text-text-secondary transition-colors duration-100 hover:bg-bg-hover"
      >
        <Settings2 size={12} />
        {S.visionMenu.manage}
      </button>
    </div>
  );
}
