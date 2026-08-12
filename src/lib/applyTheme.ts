import { getThemeById } from "./themes";

export function applyTheme(themeId: string): void {
  const theme = getThemeById(themeId);
  const el = document.documentElement;

  el.setAttribute("data-theme", themeId);

  // Clear all previous theme overrides
  for (let i = el.style.length - 1; i >= 0; i--) {
    const prop = el.style[i];
    if (prop.startsWith("--color-")) {
      el.style.removeProperty(prop);
    }
  }

  // Apply new theme's variable overrides (if any)
  if (theme && Object.keys(theme.variables).length > 0) {
    for (const [key, value] of Object.entries(theme.variables)) {
      el.style.setProperty(`--${key}`, value);
    }
  }
}
