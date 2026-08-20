export type DesktopPlatform = "windows" | "macos" | "other";

export function desktopPlatform(): DesktopPlatform {
  const value = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (value.includes("windows") || value.includes("win32") || value.includes("win64")) {
    return "windows";
  }
  if (value.includes("macintosh") || value.includes("macintel") || value.includes("mac os")) {
    return "macos";
  }
  return "other";
}

export const isWindows = () => desktopPlatform() === "windows";
export const defaultShell = () => (isWindows() ? "/bin/bash" : "/bin/zsh");
export const localOsLabel = () => (isWindows() ? "Windows 11 (WSL2)" : "macOS");
export const shortcutGlyph = (key: string) => (isWindows() ? `Ctrl+Shift+${key}` : `⌘${key}`);
