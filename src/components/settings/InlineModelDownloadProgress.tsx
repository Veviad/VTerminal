import { Loader2, X } from "lucide-react";

export interface InlineModelDownloadProgressProps {
  label: string;
  phase?: string;
  downloaded: number;
  total: number | null;
  bytesPerSecond?: number;
  onCancel: () => void;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${Math.max(0, Math.round(bytes))} B`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s left`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)}m left`;
  return `${Math.ceil(seconds / 3_600)}h left`;
}

/** A compact progress surface shared by chat, vision and embedding model cards.
 *
 * Keeping this inside the card makes ownership unambiguous even when two models
 * happen to use the same repository or filename. The progressbar intentionally
 * omits `aria-valuenow` until the backend reports a total, which is the ARIA
 * representation of an indeterminate transfer.
 */
export function InlineModelDownloadProgress({
  label,
  phase = "Downloading",
  downloaded,
  total,
  bytesPerSecond = 0,
  onCancel,
}: InlineModelDownloadProgressProps) {
  const determinate = total !== null && total > 0;
  const percent = determinate
    ? Math.min(100, Math.max(0, (downloaded / total) * 100))
    : null;
  const eta =
    determinate && bytesPerSecond > 0 && downloaded < total
      ? formatEta((total - downloaded) / bytesPerSecond)
      : null;
  const transferText = [
    determinate ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : formatBytes(downloaded),
    bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : null,
    eta,
  ]
    .filter(Boolean)
    .join(" · ");
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1);

  return (
    <div className="mt-2 border-t border-border-subtle pt-2" aria-busy="true">
      <div className="flex items-center justify-between gap-2 text-[9px] text-text-muted">
        <span className="flex min-w-0 items-center gap-1">
          <Loader2 size={9} className="shrink-0 animate-spin" aria-hidden="true" />
          <span className="truncate">{phaseLabel}</span>
        </span>
        <span className="shrink-0">{percent === null ? "Starting…" : `${Math.round(percent)}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} download progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={transferText}
        className="mt-1 h-1 overflow-hidden rounded-full bg-bg-elevated"
      >
        <div
          className={`h-full rounded-full bg-accent ${percent === null ? "w-1/3 animate-pulse" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[9px] text-text-muted">{transferText}</p>
        <button
          type="button"
          onClick={onCancel}
          className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[9px] text-text-muted hover:bg-bg-hover hover:text-error"
          aria-label={`Cancel ${label} download`}
        >
          <X size={10} aria-hidden="true" /> Cancel
        </button>
      </div>
    </div>
  );
}
