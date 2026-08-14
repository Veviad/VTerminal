import {
  cancelPendingUpdate,
  dismissUpdatePrompt,
  installPendingUpdate,
} from "../../lib/appUpdates";
import { S } from "../../lib/strings";
import { useUpdateStore } from "../../stores/updateStore";
import {
  isUpdateCancellable,
  isUpdateProcessing,
  LiveUpdateProgress,
  updateActionLabel,
} from "../settings/UpdatesSection";
import { ReleaseNotes } from "./ReleaseNotes";

export function UpdateModal() {
  const promptOpen = useUpdateStore((state) => state.promptOpen);
  const metadata = useUpdateStore((state) => state.metadata);
  const status = useUpdateStore((state) => state.status);
  const workspaceReady = useUpdateStore((state) => state.workspaceReady);
  const error = useUpdateStore((state) => state.error);
  if (!promptOpen || !metadata) return null;

  const busy = isUpdateProcessing(status);
  const cancellable = isUpdateCancellable(status);
  const installDisabled = busy || !workspaceReady;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 px-4 pt-20"
      onMouseDown={() => {
        if (!busy) dismissUpdatePrompt();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        className="w-full max-w-lg space-y-4 rounded-lg border border-border-subtle bg-bg-card p-4 shadow-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 id="update-dialog-title" className="text-[14px] font-medium text-text-primary">
              {S.settings.updates.available(metadata.version)}
            </h2>
            {metadata.prerelease && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">
                {S.settings.updates.prerelease}
              </span>
            )}
          </div>
          <p className="font-mono text-[10px] text-text-muted">
            {metadata.current_version} → {metadata.version}
          </p>
          {metadata.published_at && (
            <p className="text-[10px] text-text-muted">
              {S.settings.updates.published}: {new Date(metadata.published_at).toLocaleString()}
            </p>
          )}
        </div>

        <div className="max-h-52 overflow-y-auto rounded-md bg-bg-secondary p-2.5">
          <p className="mb-1 text-[9px] font-medium uppercase tracking-wide text-text-muted">
            {S.settings.updates.releaseNotes}
          </p>
          <ReleaseNotes notes={metadata.notes} />
        </div>

        <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-warning">
          {S.settings.updates.restartWarning}
        </p>

        {busy && <LiveUpdateProgress status={status} />}
        {error && (
          <p className="rounded-md border border-error/30 bg-error/10 px-2 py-1.5 text-[11px] text-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={cancellable ? () => void cancelPendingUpdate() : dismissUpdatePrompt}
            disabled={(busy && !cancellable) || status === "cancelling"}
            className="rounded-md px-2.5 py-1.5 text-[11px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            {cancellable ? S.settings.updates.cancelDownload : S.settings.updates.later}
          </button>
          <button
            onClick={() => void installPendingUpdate()}
            disabled={installDisabled}
            className="rounded-md bg-accent px-2.5 py-1.5 text-[11px] font-medium text-bg-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {updateActionLabel(status)}
          </button>
        </div>
      </div>
    </div>
  );
}
