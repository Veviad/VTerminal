// One card per offered model, plus the download it can start.
//
// Extracted from ModelsSettings so RemoteServersSection can render the same card
// under its own per-server heading: exporting it from there would make the two
// files import each other, and an ES cycle that happens to work in dev is not
// something to leave in the bundle.

import { Check, Download, Loader2, Square, Trash2 } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import * as api from "../../lib/tauri";
import type { CatalogEntry, DownloadEvent, Effort } from "../../lib/types";
import { EffortPicker } from "../ui/EffortPicker";
import { isUsable, loadModel, refreshModels as refresh, selectModel } from "../../lib/selectModel";
import { S } from "../../lib/strings";
import {
  formatBytes,
  InlineModelDownloadProgress,
} from "./InlineModelDownloadProgress";

export { formatBytes } from "./InlineModelDownloadProgress";

let downloadCounter = 1;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  return `${Math.round(n / 1000)}K`;
}

/** The download bookkeeping, shared by the chat catalog and the vision sidecar.
 *
 *  `invoke` is a parameter rather than a model id because the vision path pulls TWO
 *  files under one download_id and rebases their byte counts in Rust — from here
 *  the two are indistinguishable, which is the point.
 *
 *  Note it seeds a zero-progress entry BEFORE invoking, so the row flips to
 *  "downloading" on the click rather than on the first server byte.
 */
export function startDownloadWith(
  invoke: (downloadId: string, onEvent: (e: DownloadEvent) => void) => Promise<void>,
  meta: {
    kind: "chat" | "vision";
    modelId: string;
    repoId: string;
    filename: string;
  },
): string {
  const downloadId = `dl-${Date.now()}-${downloadCounter++}`;
  const store = useAppStore.getState();
  store.setDownloadError(meta.kind, meta.modelId, null);
  store.updateDownload(downloadId, { ...meta, downloaded: 0, total: null, bps: 0 });
  void invoke(downloadId, (e: DownloadEvent) => {
    const s = useAppStore.getState();
    if (e.type === "Started") {
      s.updateDownload(downloadId, {
        ...meta,
        downloaded: e.resumed_from,
        total: e.total_bytes,
        bps: 0,
      });
    } else if (e.type === "Progress") {
      s.updateDownload(downloadId, {
        ...meta,
        downloaded: e.downloaded,
        total: e.total_bytes,
        bps: e.bytes_per_sec,
      });
    } else if (e.type === "Completed" || e.type === "Cancelled" || e.type === "Error") {
      s.clearDownload(downloadId);
      void refresh();
      if (e.type === "Error") {
        s.setDownloadError(meta.kind, meta.modelId, e.message);
      } else if (e.type === "Completed") {
        s.setDownloadError(meta.kind, meta.modelId, null);
      }
    }
  }).catch((err) => {
    const s = useAppStore.getState();
    s.clearDownload(downloadId);
    s.setDownloadError(meta.kind, meta.modelId, String(err));
  });
  return downloadId;
}

export function startDownload(entry: CatalogEntry): void {
  const spec = entry.local;
  if (!spec) return;
  startDownloadWith(
    (id, onEvent) => api.modelsDownload(id, entry.id, onEvent),
    {
      kind: "chat",
      modelId: entry.id,
      repoId: spec.repo_id,
      filename: spec.filename,
    },
  );
}

export function ModelRow({ entry }: { entry: CatalogEntry }) {
  const activeModelId = useAppStore((s) => s.activeModelId);
  const loadedModelId = useAppStore((s) => s.loadedModelId);
  const modelState = useAppStore((s) => s.modelState);
  const storedEffort = useAppStore((s) => s.modelEffort[entry.id]);
  const downloadId = useAppStore(
    (s) =>
      Object.keys(s.downloads).find(
        (id) => s.downloads[id].kind === "chat" && s.downloads[id].modelId === entry.id,
      ) ?? null,
  );
  const download = useAppStore((s) => (downloadId ? (s.downloads[downloadId] ?? null) : null));
  const downloadError = useAppStore((s) => s.downloadErrors[`chat:${entry.id}`] ?? null);

  const engineMissing = useAppStore((s) => s.localEngineMissing());

  const effort: Effort = storedEffort ?? entry.effort;
  const isActive = activeModelId === entry.id;
  const isLoaded = loadedModelId === entry.id;
  const loading = isLoaded && modelState === "loading";
  // A model you cannot actually run should not look selectable — one rule,
  // shared with the header menu and `aiReady`.
  const usable = isUsable(entry);
  // In a build without the on-device engine every local control is dead: Load
  // only errors, and Download would fetch gigabytes nothing here can run.
  const noEngine = !!entry.local && engineMissing;

  const setEffort = (e: Effort) => {
    useAppStore.getState().setModelEffortLocal(entry.id, e);
    void api.setModelEffort(entry.id, e).catch(() => void refresh());
  };

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isActive ? "border-accent bg-accent-subtle" : "border-border-subtle bg-bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-text-primary">{entry.label}</span>
            {/* Tier ranks one model per provider per tier. A remote model was
                picked by name, so there is nothing to rank — the backend still
                has to send SOME tier for the type to hold. */}
            {!entry.remote && (
              <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-text-secondary">
                {S.settings.models.tier[entry.tier]}
              </span>
            )}
            {isActive && <Check size={12} className="text-accent" />}
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">{entry.description}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-text-muted">
            <span>
              {formatTokens(entry.context_tokens)} {S.settings.models.contextTokens}
            </span>
            {/* The one fact the label hides, and all that tells two tags of the
                same family apart. */}
            {entry.remote && <span className="font-mono">· {entry.wire_model}</span>}
            {/* Agent mode needs tool calling; without this the failure is a
                confused reply rather than an error. */}
            {entry.remote?.supports_tools === false && (
              <span className="text-warning">· {S.settings.remoteServers.noToolsTag}</span>
            )}
            {entry.local && <span>· {formatBytes(entry.local.size_bytes)}</span>}
            {entry.local && !entry.fits && (
              <span className="text-warning">
                · {S.settings.models.tooBig} ({entry.local.min_ram_gb} GB)
              </span>
            )}
            {entry.local && entry.fits && !entry.downloaded && !noEngine && (
              <span>· {S.settings.models.notDownloaded}</span>
            )}
            {noEngine && <span className="text-warning">· {S.settings.models.noEngineTag}</span>}
            {/* Never on a remote row: there is no API-key field behind that
                advice, so it would name a fix the user cannot perform. */}
            {!entry.local && !entry.remote && !entry.configured && (
              <span className="text-warning">· {S.settings.models.needsKey}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <EffortPicker value={effort} available={entry.efforts} onChange={setEffort} size="sm" />
          <div className="flex items-center gap-1">
            {entry.local && !entry.downloaded && (
              <button
                disabled={!!download || !entry.fits || noEngine}
                onClick={() => startDownload(entry)}
                className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
              >
                {download ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                {download ? "Downloading…" : downloadError ? "Retry" : S.settings.models.download}
              </button>
            )}
            {entry.local && entry.downloaded && (
              <>
                {isLoaded && !loading ? (
                  <button
                    onClick={() => void api.modelUnload().then(refresh)}
                    className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover"
                  >
                    <Square size={11} />
                    {S.settings.models.unload}
                  </button>
                ) : (
                  <button
                    disabled={loading || !entry.fits || noEngine}
                    onClick={() => void loadModel(entry.id)}
                    className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
                  >
                    {loading ? <Loader2 size={11} className="animate-spin" /> : null}
                    {loading ? "…" : S.settings.models.load}
                  </button>
                )}
                <button
                  title={S.settings.models.delete}
                  onClick={() => void api.modelsDelete(entry.id).then(refresh).catch(() => {})}
                  className="rounded-md border border-border-subtle p-1 text-text-muted hover:bg-bg-hover hover:text-error"
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}
            {!isActive && (
              <button
                disabled={!usable}
                onClick={() => void selectModel(entry)}
                className="rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-60"
              >
                {S.settings.models.select}
              </button>
            )}
          </div>
        </div>
      </div>
      {downloadError && !download && (
        <p className="mt-2 border-t border-border-subtle pt-2 text-[9px] leading-relaxed text-error">
          {downloadError}
        </p>
      )}
      {downloadId && download && (
        <InlineModelDownloadProgress
          label={entry.label}
          downloaded={download.downloaded}
          total={download.total}
          bytesPerSecond={download.bps}
          onCancel={() => void api.modelsCancelDownload(downloadId).catch(() => {})}
        />
      )}
    </div>
  );
}
