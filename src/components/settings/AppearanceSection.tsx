import { THEMES } from "../../lib/themes";
import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import { S } from "../../lib/strings";

export function AppearanceSection() {
  const theme = useAppStore((s) => s.theme);
  const { save } = useSettings();

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          {S.settings.appearance.theme}
        </h3>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => void save({ theme: t.id })}
              className={`flex items-center gap-3 rounded-lg border p-3 text-start transition-all duration-150 ${
                theme === t.id
                  ? "border-accent bg-accent-subtle"
                  : "border-border-subtle bg-bg-card hover:bg-bg-hover"
              }`}
            >
              {/* Sample text in the PREVIEWED theme's own colors. The swatch used
                  to show background and accent only, which says nothing about
                  legibility — the one axis a theme can get wrong. Decorative: the
                  name and description beside it carry the meaning. */}
              <span
                aria-hidden
                className="flex h-8 w-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-subtle"
                style={{ backgroundColor: t.preview.bg }}
              >
                <span
                  className="text-[11px] font-medium leading-none"
                  style={{ color: t.preview.text }}
                >
                  Aa
                </span>
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: t.preview.accent }}
                />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-medium text-text-primary">
                  {t.name}
                </span>
                <span className="block truncate text-[10px] text-text-muted">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
