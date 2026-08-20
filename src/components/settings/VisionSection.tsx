import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import * as api from "../../lib/tauri";
import {
  loadVisionModel,
  refreshModels as refresh,
  selectVisionModel,
} from "../../lib/selectModel";
import { startDownloadWith } from "./ModelRow";
import {
  formatBytes,
  InlineModelDownloadProgress,
} from "./InlineModelDownloadProgress";
import { Toggle } from "../ui/Row";
import { S } from "../../lib/strings";
import type { VisionCatalogEntry } from "../../lib/types";

/** The on-device OCR / image sidecar.
 *
 *  A section rather than a tab: three rows do not justify one, and this belongs
 *  next to the lineup it works alongside. Placed after the on-device provider and
 *  before the API ones, because it is only meaningful to someone already running
 *  models locally.
 */
export function VisionSection() {
  const entries = useAppStore((s) => s.visionCatalog);
  const selected = useAppStore((s) => s.visionModelId);
  const loadError = useAppStore((s) => s.visionLoadError);

  // A build with no local engine answers `vision_catalog` with an empty list, so
  // the whole section disappears rather than offering something that cannot run.
  if (entries.length === 0) return null;

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-[13px] font-medium text-text-primary">{S.vision.title}</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">{S.vision.hint}</p>
      </div>

      {loadError && (
        <p className="rounded-lg bg-error-subtle px-3 py-2 text-[11px] text-error">{loadError}</p>
      )}

      <div className="space-y-1">
        {entries.map((entry) => (
          <VisionModelRow key={entry.id} entry={entry} />
        ))}
      </div>

      {/* Only meaningful once something is chosen — a prompt for no model is a
          setting with no effect. */}
      {selected && <VisionPromptField />}
      <VisionAutoLoadToggle />
    </section>
  );
}

/** Deliberately NOT `ModelRow`.
 *
 *  That component renders an `EffortPicker`, a tier and a "Use" button that writes
 *  `active_model_id` — meaningless for a transcriber and, in the last case, actively
 *  wrong: selecting a sidecar as the model that answers would leave the chat with a
 *  model that has no tools and no conversation. Duplicating ~70 lines of markup
 *  beats parameterising one component over two unrelated entry shapes.
 */
function VisionModelRow({ entry }: { entry: VisionCatalogEntry }) {
  const loadedId = useAppStore((s) => s.visionLoadedModelId);
  const visionState = useAppStore((s) => s.visionState);
  const chatLabel = useAppStore(
    (s) => s.catalog.find((m) => m.id === s.activeModelId)?.label ?? null,
  );
  const downloadId = useAppStore(
    (s) =>
      Object.keys(s.downloads).find(
        (id) => s.downloads[id].kind === "vision" && s.downloads[id].modelId === entry.id,
      ) ?? null,
  );
  const download = useAppStore((s) => (downloadId ? (s.downloads[downloadId] ?? null) : null));
  const downloadError = useAppStore((s) => s.downloadErrors[`vision:${entry.id}`] ?? null);

  const isLoaded = loadedId === entry.id;
  const isLoading = visionState === "loading" && loadedId === entry.id;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] text-text-primary">{entry.label}</span>
            {entry.selected && (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[9px] font-medium text-accent">
                {S.vision.inUse}
              </span>
            )}
            {isLoaded && (
              <span className="shrink-0 text-[9px] text-text-muted">{S.vision.loaded}</span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">{entry.description}</p>
          <p className="mt-0.5 font-mono text-[10px] text-text-muted">
            {formatBytes(entry.total_bytes)}
            {/* Both files, named — the projector is nearly as large as the weights
                for the OCR model, and a single number hides that. */}
            {` (${formatBytes(entry.size_bytes)} + ${formatBytes(entry.mmproj_size_bytes)} projector)`}
            {!entry.downloaded && ` · ${S.vision.notDownloaded}`}
            {/* Names the PAIR, because that is what does not fit. "Too big" on its
                own sends the user looking for a problem with this model alone. */}
            {!entry.fits &&
              ` · ${S.vision.wontFit(entry.required_ram_gb, chatLabel ?? S.vision.yourChatModel)}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!entry.downloaded && (
            <button
              onClick={() =>
                startDownloadWith(
                  (id, onEvent) => api.visionDownload(id, entry.id, onEvent),
                  // Rust rebases the two files onto one aggregate byte stream,
                  // while this stable owner keeps the progress on this card.
                  {
                    kind: "vision",
                    modelId: entry.id,
                    repoId: entry.repo_id,
                    filename: entry.filename,
                  },
                )
              }
              disabled={!!download || !entry.fits}
              className="rounded-md bg-bg-hover px-2 py-1 text-[11px] text-text-secondary transition-colors duration-150 hover:bg-bg-elevated disabled:opacity-60"
            >
              {download ? S.vision.downloading : downloadError ? "Retry" : S.vision.download}
            </button>
          )}

          {entry.downloaded && (
            <>
              <button
                onClick={() =>
                  isLoaded
                    ? void api.visionUnload().then(() => refresh())
                    : void loadVisionModel(entry.id)
                }
                disabled={isLoading || !entry.fits}
                className="rounded-md bg-bg-hover px-2 py-1 text-[11px] text-text-secondary transition-colors duration-150 hover:bg-bg-elevated disabled:opacity-60"
              >
                {isLoading ? S.vision.loading : isLoaded ? S.vision.unload : S.vision.load}
              </button>
              <button
                onClick={() =>
                  void api.visionDelete(entry.id).then(() => refresh()).catch(() => {})
                }
                disabled={isLoaded}
                title={S.vision.delete}
                className="rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-error disabled:opacity-60"
              >
                {S.vision.delete}
              </button>
              {!entry.selected && (
                <button
                  onClick={() => void selectVisionModel(entry.id)}
                  disabled={!entry.fits}
                  className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover disabled:opacity-60"
                >
                  {S.vision.use}
                </button>
              )}
              {entry.selected && (
                <button
                  onClick={() => void selectVisionModel(null)}
                  className="rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
                >
                  {S.vision.stopUsing}
                </button>
              )}
            </>
          )}
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

/** Override for what the sidecar is asked. Blank means "use the chosen model's
 *  own default", which differs by family — an OCR specialist is told to
 *  transcribe, a general VLM to describe. */
function VisionPromptField() {
  const { save } = useSettings();
  const value = useAppStore((s) => s.visionPrompt);
  const selected = useAppStore((s) => s.visionModelId);
  const modelDefault = useAppStore(
    (s) => s.visionCatalog.find((m) => m.id === s.visionModelId)?.default_prompt ?? "",
  );
  if (!selected) return null;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2">
      <label className="text-[11px] text-text-secondary">{S.vision.promptLabel}</label>
      <textarea
        rows={2}
        defaultValue={value ?? ""}
        placeholder={modelDefault}
        // Blur, not change: one write per edit rather than per keystroke — the
        // same rule `Stepper` and the API-key fields follow.
        onBlur={(e) => void save({ vision_prompt: e.target.value.trim() })}
        className="mt-1 w-full resize-none rounded-md border border-border-subtle bg-bg-primary px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-muted"
      />
      <p className="mt-1 text-[10px] text-text-muted">{S.vision.promptHint}</p>
    </div>
  );
}

function VisionAutoLoadToggle() {
  const { save } = useSettings();
  const on = useAppStore((s) => s.visionAutoLoadOnStart);
  const selected = useAppStore((s) => s.visionModelId);
  if (!selected) return null;
  return (
    <Toggle
      label={S.vision.autoLoad}
      hint={S.vision.autoLoadHint}
      checked={on}
      onChange={(v) => void save({ vision_auto_load_on_start: v })}
    />
  );
}
