// Every theme's text has to stay readable. This measures the pairs the UI
// actually paints — not every possible combination — so a retune that looks fine
// on the default theme cannot quietly bury text on one of the other five.
//
// The thresholds are WCAG 2.1 contrast ratios: 4.5:1 is AA for body text, 3:1 is
// AA for large text and non-text UI. Most of this app's muted labels are 9-11px,
// so AA body is the bar that matters.
//
// Two floors here are deliberately below AA. Both are documented at the point of
// use and both were verified against real palettes rather than assumed — if you
// are here because one of them failed, the fix is almost certainly the token, not
// the floor.

import { describe, expect, it } from "vitest";
// Read off disk, not via a vite `?raw` import: vitest stubs CSS imports, so
// `import css from "../app.css?raw"` resolves to an empty string. The one fs
// signature used here is declared in src/vite-env.d.ts.
import { readFileSync } from "node:fs";
import { DEFAULT_THEME_ID, THEMES, type ThemeDefinition } from "../lib/themes";
import { ANSI_BY_THEME } from "../lib/xtermTheme";

// --- WCAG plumbing ---------------------------------------------------------

type Rgb = readonly [number, number, number];

/** Tokens are either `#rrggbb` or `rgba(r, g, b, a)` — the alpha ones are the
 *  tints, selection and focus ring. */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`unparseable color: ${value}`);
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function ratio(fg: string, bg: string): number {
  const a = luminance(parseColor(fg).rgb);
  const b = luminance(parseColor(bg).rgb);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** What the eye actually sees behind a Tailwind `/10` or `/15` tint. Contrast on
 *  a translucent fill is meaningless until it is composited over its ground. */
function tint(fg: string, alpha: number, bg: string): string {
  const f = parseColor(fg).rgb;
  const b = parseColor(bg).rgb;
  const hex = (i: number) =>
    Math.round(f[i] * alpha + b[i] * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}

// --- Token resolution ------------------------------------------------------

/** The `@theme` block in app.css IS the veviad-developer palette: that theme
 *  ships `variables: {}` and falls through to these defaults, because applyTheme
 *  only writes inline props when a theme declares some. Parsed rather than
 *  mirrored so an edit to either file is covered by this file. */
function readThemeDefaults(): Record<string, string> {
  // Relative to the vitest root, which is the project root.
  const css = readFileSync("src/app.css", "utf8");
  const block = /@theme\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!block) throw new Error("no @theme block found in src/app.css");
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--(color-[a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const DEFAULTS = readThemeDefaults();
const resolve = (t: ThemeDefinition): Record<string, string> => ({ ...DEFAULTS, ...t.variables });

const SURFACES = [
  "color-bg-primary",
  "color-bg-secondary",
  "color-bg-card",
  "color-bg-hover",
  "color-bg-elevated",
] as const;

/** Where the overwhelming majority of muted labels live. */
const MAIN_SURFACES = ["color-bg-primary", "color-bg-secondary", "color-bg-card"] as const;

const AA = 4.5;

/** text-muted is NOT held to AA on bg-hover/bg-elevated. Forcing it there would
 *  push it past text-secondary on Solarized Dark and flatten the three-step
 *  ramp, so the badges and pills that rest on those two surfaces use
 *  text-secondary instead and the token stays a distinct third step. */
const MUTED_ON_RAISED = 3.4;

/** Nord's bg-card is nord2 #434c5e — light for a dark theme. Its aurora red tops
 *  out near 3.9:1 there before it stops reading as Nord, so this one theme is
 *  held to AA-large. Asserted rather than skipped so the limit stays visible. */
const ERROR_FLOOR: Record<string, number> = { nord: 3.0 };

describe("the @theme block is the default theme's palette", () => {
  it("parses every token the themes override", () => {
    const overridden = new Set(THEMES.flatMap((t) => Object.keys(t.variables)));
    expect(overridden.size).toBeGreaterThan(0);
    for (const key of overridden) expect(DEFAULTS, `app.css is missing --${key}`).toHaveProperty(key);
  });

  it("is reached by fallback, not by duplication", () => {
    const dflt = THEMES.find((t) => t.id === DEFAULT_THEME_ID);
    expect(dflt).toBeDefined();
    expect(Object.keys(dflt!.variables)).toHaveLength(0);
  });
});

describe.each(THEMES.map((t) => [t.name, t] as const))("%s", (_name, theme) => {
  const v = resolve(theme);
  const bgPrimary = v["color-bg-primary"];
  const bgCard = v["color-bg-card"];

  it("renders primary and secondary text at AA on every surface", () => {
    for (const surface of SURFACES) {
      expect(
        ratio(v["color-text-primary"], v[surface]),
        `text-primary on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
      expect(
        ratio(v["color-text-secondary"], v[surface]),
        `text-secondary on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("renders muted text at AA on the main surfaces", () => {
    for (const surface of MAIN_SURFACES) {
      expect(
        ratio(v["color-text-muted"], v[surface]),
        `text-muted on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
    for (const surface of ["color-bg-hover", "color-bg-elevated"] as const) {
      expect(
        ratio(v["color-text-muted"], v[surface]),
        `text-muted on ${surface}`,
      ).toBeGreaterThanOrEqual(MUTED_ON_RAISED);
    }
  });

  it("keeps the primary > secondary > muted ramp distinct", () => {
    const primary = ratio(v["color-text-primary"], bgCard);
    const secondary = ratio(v["color-text-secondary"], bgCard);
    const muted = ratio(v["color-text-muted"], bgCard);
    expect(primary, "primary should out-contrast secondary").toBeGreaterThan(secondary);
    expect(secondary, "secondary should out-contrast muted").toBeGreaterThan(muted);
  });

  it("renders the accent as text, as a fill, and on its own tint at AA", () => {
    // Read as text — links in AI answers, active states, the connect action.
    expect(ratio(v["color-accent"], bgCard), "accent text on bg-card").toBeGreaterThanOrEqual(AA);
    expect(ratio(v["color-accent"], bgPrimary), "accent text on bg-primary").toBeGreaterThanOrEqual(
      AA,
    );
    // Filled accent buttons label themselves with text-bg-primary.
    expect(
      ratio(bgPrimary, v["color-accent"]),
      "text-bg-primary on an accent fill",
    ).toBeGreaterThanOrEqual(AA);
    // And accent-colored text on an accent-tinted chip, where both sides move
    // together and the alpha bounds how far apart they can get.
    expect(
      ratio(v["color-accent"], tint(v["color-accent"], 0.1, bgPrimary)),
      "accent on bg-accent/10",
    ).toBeGreaterThanOrEqual(AA);
    expect(
      ratio(v["color-accent"], tint(v["color-accent"], 0.15, bgCard)),
      "accent on bg-accent/15",
    ).toBeGreaterThanOrEqual(3.0);
  });

  it("renders warning and error text at AA on cards", () => {
    expect(ratio(v["color-warning"], bgCard), "warning on bg-card").toBeGreaterThanOrEqual(AA);
    expect(ratio(v["color-warning"], bgPrimary), "warning on bg-primary").toBeGreaterThanOrEqual(
      AA,
    );
    const errorFloor = ERROR_FLOOR[theme.id] ?? AA;
    expect(ratio(v["color-error"], bgCard), "error on bg-card").toBeGreaterThanOrEqual(errorFloor);
    expect(ratio(v["color-error"], bgPrimary), "error on bg-primary").toBeGreaterThanOrEqual(
      errorFloor,
    );
  });

  it("derives its alpha tokens from the accent and error it ships", () => {
    // These four are hand-maintained rgba() literals, so retuning an accent
    // without them leaves the tint, the selection and the focus ring on the old
    // hue — visible only as a faint mismatch, which is exactly what gets missed.
    const accent = parseColor(v["color-accent"]).rgb;
    for (const key of ["color-accent-subtle", "color-selection", "color-focus-ring"] as const) {
      expect(parseColor(v[key]).rgb, `${key} should carry the accent rgb`).toEqual(accent);
    }
    expect(
      parseColor(v["color-error-subtle"]).rgb,
      "color-error-subtle should carry the error rgb",
    ).toEqual(parseColor(v["color-error"]).rgb);
  });

  it("previews itself with its own colors in the theme picker", () => {
    expect(theme.preview.bg).toBe(v["color-bg-primary"]);
    expect(theme.preview.accent).toBe(v["color-accent"]);
    expect(theme.preview.text).toBe(v["color-text-primary"]);
  });
});

// --- Terminal palettes -----------------------------------------------------

const GREY_SLOTS = ["black", "brightBlack", "white", "brightWhite"] as const;
const HUED_SLOTS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

describe("terminal ANSI palettes", () => {
  it("defines a palette for every theme", () => {
    for (const theme of THEMES) expect(ANSI_BY_THEME, theme.id).toHaveProperty(theme.id);
  });

  // The light theme is the one palette this app authored from scratch, and the
  // one where "bright" fights the background: on a light ground lighter means
  // less contrast, so both rows have to be pulled down. An earlier version had
  // the grey slots inverted — white at 1.82:1 and brightWhite at 2.91:1 — which
  // made anything printing white text invisible.
  describe("light", () => {
    const bg = resolve(THEMES.find((t) => t.id === "light")!)["color-bg-terminal"];
    const ansi = ANSI_BY_THEME["light"] as unknown as Record<string, string>;

    it("keeps every slot legible on the terminal background", () => {
      for (const [slot, color] of Object.entries(ansi)) {
        // brightBlack is the dim slot tools reach for to de-emphasize, so it is
        // the single intentional exception.
        const floor = slot === "brightBlack" ? 3.0 : 4.4;
        expect(ratio(color, bg), `${slot} ${color} on ${bg}`).toBeGreaterThanOrEqual(floor);
      }
    });

    it("keeps each bright variant lighter than its normal counterpart", () => {
      for (const slot of HUED_SLOTS) {
        const normal = luminance(parseColor(ansi[slot]).rgb);
        const bright = luminance(
          parseColor(ansi[`bright${slot[0].toUpperCase()}${slot.slice(1)}`]).rgb,
        );
        expect(bright, `bright${slot} should read brighter than ${slot}`).toBeGreaterThan(normal);
      }
    });

    it("makes brightWhite the strongest slot and white a mid grey", () => {
      expect(ratio(ansi["brightWhite"], bg)).toBeGreaterThan(ratio(ansi["white"], bg));
    });
  });

  // The dark palettes are upstream Nord / Solarized / Tailwind ramps, and their
  // black and brightBlack are SUPPOSED to be near-invisible — that is the
  // universal terminal convention for the dim slots, which `ls` colors and
  // prompt themes depend on. So only the hued slots are checked, and at 3:1:
  // authentic Nord red measures 3.42:1 on its own terminal ground and lifting it
  // would mean shipping a palette that is no longer Nord. This still catches a
  // genuinely broken value.
  describe.each(THEMES.filter((t) => t.id !== "light").map((t) => [t.id, t] as const))(
    "%s",
    (id, theme) => {
      it("keeps the hued slots above AA-large on the terminal background", () => {
        const bg = resolve(theme)["color-bg-terminal"];
        const ansi = ANSI_BY_THEME[id] as unknown as Record<string, string>;
        for (const slot of HUED_SLOTS) {
          const bright = `bright${slot[0].toUpperCase()}${slot.slice(1)}`;
          expect(ratio(ansi[slot], bg), `${slot} on ${bg}`).toBeGreaterThanOrEqual(3.0);
          expect(ratio(ansi[bright], bg), `${bright} on ${bg}`).toBeGreaterThanOrEqual(3.0);
        }
      });

      it("keeps the foreground slots readable", () => {
        const bg = resolve(theme)["color-bg-terminal"];
        const ansi = ANSI_BY_THEME[id] as unknown as Record<string, string>;
        // white/brightWhite carry ordinary output on a dark theme, so unlike
        // black/brightBlack they do have to be legible.
        expect(ratio(ansi["white"], bg), `white on ${bg}`).toBeGreaterThanOrEqual(AA);
        expect(ratio(ansi["brightWhite"], bg), `brightWhite on ${bg}`).toBeGreaterThanOrEqual(AA);
        expect(GREY_SLOTS).toContain("black");
      });
    },
  );
});
