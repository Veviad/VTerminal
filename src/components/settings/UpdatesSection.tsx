import { checkForUpdates, dismissUpdatePrompt, installPendingUpdate } from "../../lib/appUpdates";
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
    case "installing":
      return u.statusInstalling;
    case "error":
      return u.statusError;
  }
};

export function formatUpdateBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdatesSection() {
  const enabled = useAppStore((state) => state.autoUpdateEnabled);
  const update = useUpdateStore();
  const { save } = useSettings();
  const busy = ["checking", "downloading", "installing"].includes(update.status);
  const installDisabled = busy || !update.workspaceReady;
  const installing = update.status === "downloading" || update.status === "installing";
  const checked = update.lastCheckedAt
    ? new Date(update.lastCheckedAt).toLocaleString()
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
          disabled={installing}
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
            <span className="text-[12px] text-text-primary">{statusLabel(update.status)}</span>
          </Row>
        </div>

        {update.error && (
          <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] leading-relaxed text-error">
            {update.error}
          </p>
        )}

        <button
          onClick={() => void checkForUpdates({ manual: true })}
          disabled={busy}
          className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {update.status === "error" ? S.settings.updates.checkAgain : S.settings.updates.checkNow}
        </button>
      </section>

      {update.metadata && (
        <section className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-medium text-text-primary">
              {S.settings.updates.available(update.metadata.version)}
            </p>
            {update.metadata.prerelease && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">
                {S.settings.updates.prerelease}
              </span>
            )}
          </div>
          {update.metadata.published_at && (
            <p className="text-[10px] text-text-muted">
              {S.settings.updates.published}: {new Date(update.metadata.published_at).toLocaleString()}
            </p>
          )}
          <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
            {S.settings.updates.releaseNotes}
          </p>
          <div className="max-h-40 overflow-y-auto">
            <ReleaseNotes notes={update.metadata.notes} />
          </div>
          {installing && (
            <UpdateProgress downloaded={update.downloadedBytes} total={update.totalBytes} />
          )}
          <button
            onClick={() => void installPendingUpdate()}
            disabled={installDisabled}
            className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {S.settings.updates.install}
          </button>
        </section>
      )}
    </div>
  );
}

export function UpdateProgress({ downloaded, total }: { downloaded: number; total: number | null }) {
  const percent = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;
  return (
    <div className="space-y-1" aria-label={S.settings.updates.statusDownloading}>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className={`h-full rounded-full bg-accent transition-[width] ${percent === null ? "w-1/3 animate-pulse" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="font-mono text-[9px] text-text-muted">
        {total
          ? S.settings.updates.progress(formatUpdateBytes(downloaded), formatUpdateBytes(total))
          : formatUpdateBytes(downloaded)}
      </p>
    </div>
  );
}
