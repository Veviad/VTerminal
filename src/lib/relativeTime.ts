/**
 * Coarse "how long ago", for replay banners and archive rows.
 *
 * Deliberately coarse: `2d ago` is what people reason with when deciding which
 * session to reopen, and a precise timestamp invites the reader to trust a
 * captured screen as if it were live.
 */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "earlier";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
