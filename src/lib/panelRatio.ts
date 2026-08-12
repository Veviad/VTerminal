/**
 * AI panel width, as a SHARE of the window rather than a pixel count.
 *
 * A pixel width does not survive a window resize: the panel keeps it and the
 * terminal (`flex-1 min-w-0`) absorbs the entire loss, so shrinking a
 * near-fullscreen window used to starve the terminal while the chat held onto its
 * 720px. A ratio also round-trips — shrink to the floor and grow back and you
 * land on the proportion you dragged, which a rescale-on-every-resize scheme
 * cannot do once it has been clamped at the bottom.
 *
 * Pure, and deliberately its own module rather than part of `lib/aiPanel.ts`:
 * that one reaches for `useAppStore`, and the store needs the clamp in its own
 * setter, which would be an import cycle.
 *
 * The ratio bounds must match the Rust clamp in `commands/settings.rs`.
 */
export const PANEL_MIN_PX = 320;
export const PANEL_MIN_RATIO = 0.1;
export const PANEL_MAX_RATIO = 0.5;

/** The share a fresh install lands on — 420px, the shipped default, at ~1400px. */
export const PANEL_DEFAULT_RATIO = 0.3;

/** Sanity bound on a migrated or hand-edited value. */
export function clampPanelRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return PANEL_DEFAULT_RATIO;
  return Math.min(PANEL_MAX_RATIO, Math.max(PANEL_MIN_RATIO, ratio));
}

/**
 * CSS itself does the resizing — no JS on the window-resize path at all.
 *
 * A percentage on a flex item resolves against the flex container's content box,
 * which here is AppShell's split row: full window width, no padding, so `%` is
 * literally "share of the window". The clamp cannot invert — the window's
 * `minWidth` is 720px, so the 50% ceiling never falls below the 320px floor.
 */
export function panelWidthCss(ratio: number): string {
  const pct = (clampPanelRatio(ratio) * 100).toFixed(3);
  return `clamp(${PANEL_MIN_PX}px, ${pct}%, ${PANEL_MAX_RATIO * 100}%)`;
}

/**
 * Pointer position → stored ratio.
 *
 * Clamps in PIXELS first and only then divides, so the ratio stored is always one
 * the current window can actually render. Dragging past the 320px floor on a
 * small window therefore stores the floor's equivalent share; widening the window
 * afterwards resumes from the width the user last saw, instead of jumping to a
 * narrower share they never chose.
 */
export function ratioFromDrag(px: number, containerPx: number): number {
  // A zero-width container means the row has not been laid out; the caller has
  // no better answer than the default either.
  if (!(containerPx > 0)) return PANEL_DEFAULT_RATIO;
  const clamped = Math.min(containerPx * PANEL_MAX_RATIO, Math.max(PANEL_MIN_PX, px));
  return clampPanelRatio(clamped / containerPx);
}
