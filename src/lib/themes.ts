export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  preview: { bg: string; accent: string; text: string };
  variables: Record<string, string>;
}

export const DEFAULT_THEME_ID = "veviad-developer";

export const THEMES: ThemeDefinition[] = [
  {
    id: "veviad-developer",
    name: "Veviad Developer UI",
    description: "Dark theme with emerald accents",
    preview: { bg: "#09090b", accent: "#10b981", text: "#fafafa" },
    variables: {}, // Default — uses @theme values from app.css
  },
  {
    id: "veviad-ui",
    name: "Veviad UI",
    description: "Brand purple from veviad.com",
    preview: { bg: "#100f1a", accent: "#a78bfa", text: "#ededf0" },
    variables: {
      "color-bg-primary": "#100f1a",
      "color-bg-secondary": "#161525",
      "color-bg-card": "#1c1b2e",
      "color-bg-hover": "#232238",
      "color-bg-elevated": "#2a2942",
      "color-accent": "#a78bfa",
      "color-accent-hover": "#8b6ff2",
      "color-accent-subtle": "rgba(167, 139, 250, 0.08)",
      "color-text-primary": "#ededf0",
      "color-text-secondary": "#9896a8",
      "color-text-muted": "#868499",
      "color-border": "#2a2942",
      "color-border-subtle": "#1e1d30",
      "color-error": "#f04a4a",
      "color-warning": "#f59e0b",
      "color-success": "#10b981",
      "color-selection": "rgba(167, 139, 250, 0.18)",
      "color-bg-terminal": "#0c0b14",
      "color-focus-ring": "rgba(167, 139, 250, 0.4)",
      "color-error-subtle": "rgba(240, 74, 74, 0.08)",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep blue with indigo accents",
    preview: { bg: "#0b0d1a", accent: "#7c7ff3", text: "#e2e8f0" },
    variables: {
      "color-bg-primary": "#0b0d1a",
      "color-bg-secondary": "#0f1225",
      "color-bg-card": "#161a30",
      "color-bg-hover": "#1c2040",
      "color-bg-elevated": "#242950",
      // Indigo lightened one step: #6366f1 read 3.84:1 as text on bg-card and
      // 4.33:1 as a fill behind text-bg-primary. accent-hover takes the old
      // accent so hover stays a small step down, not a jump to #4f46e5.
      "color-accent": "#7c7ff3",
      "color-accent-hover": "#6366f1",
      "color-accent-subtle": "rgba(124, 127, 243, 0.1)",
      "color-text-primary": "#e2e8f0",
      "color-text-secondary": "#94a3b8",
      "color-text-muted": "#7486a0",
      "color-border": "#1e293b",
      "color-border-subtle": "#172033",
      "color-error": "#f04a4a",
      "color-warning": "#f59e0b",
      "color-success": "#22c55e",
      "color-selection": "rgba(124, 127, 243, 0.25)",
      "color-bg-terminal": "#080a14",
      "color-focus-ring": "rgba(124, 127, 243, 0.5)",
      "color-error-subtle": "rgba(240, 74, 74, 0.1)",
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "Arctic polar night, frost blue",
    preview: { bg: "#2e3440", accent: "#92c6d4", text: "#eceff4" },
    variables: {
      "color-bg-primary": "#2e3440",
      "color-bg-secondary": "#3b4252",
      "color-bg-card": "#434c5e",
      "color-bg-hover": "#4c566a",
      "color-bg-elevated": "#545e72",
      "color-accent": "#92c6d4",
      "color-accent-hover": "#81a1c1",
      "color-accent-subtle": "rgba(146, 198, 212, 0.1)",
      "color-text-primary": "#eceff4",
      "color-text-secondary": "#d8dee9",
      "color-text-muted": "#b7becc",
      "color-border": "#4c566a",
      "color-border-subtle": "#3b4252",
      // Nord's surfaces are light for a dark theme (bg-card is nord2 #434c5e),
      // so aurora red cannot clear 4.5:1 there without washing out of the
      // palette. Lightened to 3.54:1 (from 2.11) and held to a documented 3:1
      // floor in themeContrast.test.ts rather than leaving Nord.
      "color-error": "#e0909a",
      "color-warning": "#ebcb8b",
      "color-success": "#a3be8c",
      "color-selection": "rgba(146, 198, 212, 0.25)",
      "color-bg-terminal": "#272c36",
      "color-focus-ring": "rgba(146, 198, 212, 0.5)",
      "color-error-subtle": "rgba(224, 144, 154, 0.1)",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Warm dark with cyan accents",
    preview: { bg: "#002b36", accent: "#30b7ad", text: "#fdf6e3" },
    variables: {
      "color-bg-primary": "#002b36",
      "color-bg-secondary": "#073642",
      "color-bg-card": "#0a3f4c",
      "color-bg-hover": "#0e4957",
      "color-bg-elevated": "#125362",
      "color-accent": "#30b7ad",
      "color-accent-hover": "#268bd2",
      "color-accent-subtle": "rgba(48, 183, 173, 0.1)",
      "color-text-primary": "#fdf6e3",
      // This theme's background ramp climbs to #125362 while secondary stayed
      // at solarized base1 — 3.22:1 on bg-elevated. Raised one step; it is the
      // only theme where secondary needed moving.
      "color-text-secondary": "#b6c0c0",
      "color-text-muted": "#93a8ae",
      "color-border": "#0e4957",
      "color-border-subtle": "#073642",
      "color-error": "#f48578",
      "color-warning": "#ce9d00",
      "color-success": "#859900",
      "color-selection": "rgba(48, 183, 173, 0.25)",
      "color-bg-terminal": "#001e27",
      "color-focus-ring": "rgba(48, 183, 173, 0.5)",
      "color-error-subtle": "rgba(244, 133, 120, 0.1)",
    },
  },
  {
    id: "light",
    name: "Light",
    description: "Clean light with emerald accents",
    preview: { bg: "#f8f9fa", accent: "#047857", text: "#1a1a2e" },
    variables: {
      "color-bg-primary": "#f8f9fa",
      "color-bg-secondary": "#eef0f2",
      "color-bg-card": "#ffffff",
      "color-bg-hover": "#e9ecef",
      "color-bg-elevated": "#dee2e6",
      // Emerald darkened one step: #059669 was 3.57:1 both as text and as a
      // fill behind text-bg-primary, and 3.18:1 on its own 10% tint (a tint
      // over near-white leaves the accent carrying all the contrast). The old
      // accent-hover #047857 becomes the accent, so hover moves down too.
      "color-accent": "#047857",
      "color-accent-hover": "#065f46",
      "color-accent-subtle": "rgba(4, 120, 87, 0.08)",
      "color-text-primary": "#1a1a2e",
      "color-text-secondary": "#495057",
      "color-text-muted": "#666c74",
      "color-border": "#ced4da",
      "color-border-subtle": "#dee2e6",
      "color-error": "#dc2323",
      "color-warning": "#b45309",
      "color-success": "#047857",
      "color-selection": "rgba(4, 120, 87, 0.15)",
      "color-bg-terminal": "#eef0f2",
      "color-focus-ring": "rgba(4, 120, 87, 0.4)",
      "color-error-subtle": "rgba(220, 35, 35, 0.06)",
    },
  },
];

export function getThemeById(id: string): ThemeDefinition | undefined {
  return THEMES.find((t) => t.id === id);
}
