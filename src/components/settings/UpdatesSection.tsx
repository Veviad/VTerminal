import { Loader2 } from "lucide-react";
import {
  cancelPendingUpdate,
  checkForUpdates,
  dismissUpdatePrompt,
  installPendingUpdate,
} from "../../lib/appUpdates";
import { S } from "../../lib/strings";
import { useSettings } from "../../hooks/useSettings";
import { useAppStore } from "../../stores/appStore";
import { useUpdateStore, type UpdateStatus } from "../../stores/updateStore";
import { Row, Toggle } from "../ui/Row";
import { ReleaseNotes } from "../updates/ReleaseNotes";

const statusLabel = (status: UpdateStatus) => {
  const u = S.settings.updates;
  switch (status) {
    case "idle":
      return u.statusIdle;
    case "checking":
      return u.statusChecking;
    case "up_to_date":
      return u.statusCurrent;
    case "available":
      return u.statusAvailable;
    case "downloading":
      return u.statusDownloading;
    case "verifying":
      return u.statusVerifying;
    case "cancelling":
      return u.statusCancelling;
    case "saving":
      return u.statusSaving;
    case "installing":
      return u.statusInstalling;
    case "restarting":
      return u.statusRestarting;
    case "error":
      return u.statusError;
  }
};

export const isUpdateProcessing = (status: UpdateStatus): boolean =>
  ["downloading", "verifying", "cancelling", "saving", "installing", "restarting"].includes(status);

export const isUpdateCancellable = (status: UpdateStatus): boolean =>
  ["downloading", "verifying", "cancelling"].includes(status);

export const updateActionLabel = (status: UpdateStatus): string =>
  isUpdateProcessing(status) ? statusLabel(status) : S.settings.updates.install;

export function formatUpdateBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdatesSection() {
  const enabled = useAppStore((state) => state.autoUpdateEnabled);
  const status = useUpdateStore((state) => state.status);
  const metadata = useUpdateStore((state) => state.metadata);
  const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
  const error = useUpdateStore((state) => state.error);
  const workspaceReady = useUpdateStore((state) => state.workspaceReady);
  const { save } = useSettings();
  const processing = isUpdateProcessing(status);
  const cancellable = isUpdateCancellable(status);
  const busy = status === "checking" || processing;
  const installDisabled = busy || !workspaceReady;
  const checked = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleString()
    : S.settings.updates.never;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            {S.settings.updates.title}
          </h3>
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-warning">
            {S.settings.updates.experimental}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-text-secondary">
          {S.settings.updates.intro}
        </p>

        <Toggle
          label={S.settings.updates.automatic}
          hint={S.settings.updates.automaticHint}
          checked={enabled}
          disabled={processing}
          onChange={(value) => {
            if (!value) dismissUpdatePrompt();
            void save({ auto_update_enabled: value });
          }}
        />

        <div className="space-y-2 border-t border-border-subtle pt-3">
          <Row label={S.settings.updates.currentVersion}>
            <span className="font-mono text-[12px] text-text-primary">{__APP_VERSION__}</span>
          </Row>
          <Row label={S.settings.updates.channel}>
            <span className="text-[12px] text-text-primary">
              {S.settings.updates.channelValue}
            </span>
          </Row>
          <Row label={S.settings.updates.status} hint={`${S.settings.updates.lastChecked}: ${checked}`}>
            <span className="text-[12px] text-text-primary">{statusLabel(status)}</span>
          </Row>
        </div>

        {error && (
          <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] leading-relaxed text-error">
            {error}
          </p>
        )}

        <button
          onClick={() => void checkForUpdates({ manual: true })}
          disabled={busy}
          className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "error" ? S.settings.updates.checkAgain : S.settings.updates.checkNow}
        </button>
      </section>

      {metadata && (
        <section className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-medium text-text-primary">
              {S.settings.updates.available(metadata.version)}
            </p>
            {metadata.prerelease && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">
                {S.settings.updates.prerelease}
              </span>
            )}
          </div>
          {metadata.published_at && (
            <p className="text-[10px] text-text-muted">
              {S.settings.updates.published}: {new Date(metadata.published_at).toLocaleString()}
            </p>
          )}
          <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
            {S.settings.updates.releaseNotes}
          </p>
          <div className="max-h-40 overflow-y-auto">
            <ReleaseNotes notes={metadata.notes} />
          </div>
          {processing && <LiveUpdateProgress status={status} />}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void installPendingUpdate()}
              disabled={installDisabled}
              className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updateActionLabel(status)}
            </button>
            {cancellable && (
              <button
                onClick={() => void cancelPendingUpdate()}
                disabled={status === "cancelling"}
                className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {S.settings.updates.cancelDownload}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export function LiveUpdateProgress({ status }: { status: UpdateStatus }) {
  const downloaded = useUpdateStore((state) => state.downloadedBytes);
  const total = useUpdateStore((state) => state.totalBytes);
  return <UpdateProgress status={status} downloaded={downloaded} total={total} />;
}

export function UpdateProgress({
  status,
  downloaded,
  total,
}: {
  status: UpdateStatus;
  downloaded: number;
  total: number | null;
}) {
  if (status !== "downloading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 text-[10px] text-text-muted"
      >
        <Loader2 size={11} aria-hidden="true" className="animate-spin text-accent" />
        <span>{statusLabel(status)}</span>
      </div>
    );
  }

  const safeDownloaded = Number.isFinite(downloaded) ? Math.max(0, downloaded) : 0;
  const hasTotal =
    total !== null && Number.isFinite(total) && total > 0 && safeDownloaded <= total;
  const percent = hasTotal ? Math.min(100, (safeDownloaded / total) * 100) : null;
  const roundedPercent =
    percent === null
      ? null
      : safeDownloaded === total
        ? 100
        : Math.min(99, Math.floor(percent));
  const progressText = hasTotal
    ? S.settings.updates.progress(
        formatUpdateBytes(safeDownloaded),
        formatUpdateBytes(total),
        roundedPercent ?? 0,
      )
    : S.settings.updates.progressUnknown(formatUpdateBytes(safeDownloaded));

  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={S.settings.updates.statusDownloading}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={roundedPercent ?? undefined}
        aria-valuetext={progressText}
        className="h-1.5 overflow-hidden rounded-full bg-bg-elevated"
      >
        {percent === null ? (
          <div className="update-progress-indeterminate h-full rounded-full bg-accent" />
        ) : (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
      <p className="font-mono text-[9px] text-text-muted">
        {progressText}
      </p>
    </div>
  );
}
