/**
 * Accept only absolute web URLs before crossing the Tauri IPC boundary.
 * Terminal output is untrusted: it can be controlled by local commands or a
 * remote SSH host, so paths and non-web schemes must never reach an OS opener.
 */
export function sanitizeExternalWebUrl(candidate: string): string | null {
  if (!/^https?:\/\//i.test(candidate)) return null;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}
