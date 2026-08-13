import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Cloud, Download, HardDrive, Loader2, X } from "lucide-react";

import { sanitizeExternalWebUrl } from "../../lib/externalUrl";
import * as api from "../../lib/tauri";
import type {
  DownloadEvent,
  EmbeddingCatalogEntry,
  EmbeddingInstallEvent,
  EmbeddingProfile,
} from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { formatBytes, formatTokens } from "./ModelRow";

export const BUILTIN_EMBEDDING_MODEL_IDS = [
  "local/qwen3-embedding-0.6b",
  "local/qwen3-embedding-4b",
  "local/qwen3-embedding-8b",
  "local/embeddinggemma-300m",
  "local/multilingual-e5-base",
  "local/multilingual-e5-large",
] as const;

const FALLBACK_MODELS: Record<(typeof BUILTIN_EMBEDDING_MODEL_IDS)[number], EmbeddingCatalogEntry> = {
  "local/qwen3-embedding-0.6b": fallback(
    "local/qwen3-embedding-0.6b",
    "Qwen3 Embedding 0.6B",
    "Fast multilingual retrieval for laptops and CPU use.",
    "Qwen/Qwen3-Embedding-0.6B",
    1024,
    32_768,
    true,
  ),
  "local/qwen3-embedding-4b": fallback(
    "local/qwen3-embedding-4b",
    "Qwen3 Embedding 4B",
    "Balanced multilingual quality and memory use for workstations.",
    "Qwen/Qwen3-Embedding-4B",
    2560,
    32_768,
  ),
  "local/qwen3-embedding-8b": fallback(
    "local/qwen3-embedding-8b",
    "Qwen3 Embedding 8B",
    "Highest-quality Qwen retrieval for servers with more memory.",
    "Qwen/Qwen3-Embedding-8B",
    4096,
    32_768,
  ),
  "local/embeddinggemma-300m": fallback(
    "local/embeddinggemma-300m",
    "EmbeddingGemma",
    "Compact Google text embeddings that run entirely on-device.",
    "google/embeddinggemma-300m",
    768,
    2048,
    false,
    "Loading signed model manifest…",
    true,
  ),
  "local/multilingual-e5-base": fallback(
    "local/multilingual-e5-base",
    "Multilingual E5 Base",
    "100-language Sentence Transformers retrieval model.",
    "intfloat/multilingual-e5-base",
    768,
    512,
    false,
    "Signed Veviad GGUF release artifact is not published yet",
  ),
  "local/multilingual-e5-large": fallback(
    "local/multilingual-e5-large",
    "Multilingual E5 Large",
    "Higher-quality 100-language Sentence Transformers retrieval model.",
    "intfloat/multilingual-e5-large",
    1024,
    512,
    false,
    "Signed Veviad GGUF release artifact is not published yet",
  ),
};

function fallback(
  id: (typeof BUILTIN_EMBEDDING_MODEL_IDS)[number],
  label: string,
  description: string,
  model: string,
  dimension: number,
  context: number,
  recommended = false,
  unavailableReason = "Loading signed model manifest…",
  requiresLicense = false,
): EmbeddingCatalogEntry {
  return {
    id,
    label,
    description,
    provider: "local",
    model,
    dimensions: [dimension],
    default_dimension: dimension,
    context_tokens: context,
    download: requiresLicense
      ? { repo_id: "", filename: "", size_bytes: 0, min_ram_gb: 1, requires_license: true }
      : null,
    installed: false,
    available: false,
    unavailable_reason: unavailableReason,
    recommended,
    privacy: "local",
  };
}

interface InstallState {
  phase: "downloading" | "verifying" | "loading";
  downloaded: number;
  total: number | null;
  error: string | null;
}

export function KnowledgeModelsSection({
  selectedProfileId,
  onSelectProfile,
  readyProfiles = [],
}: {
  selectedProfileId: string | null;
  onSelectProfile: (id: string) => void;
  /** Profiles already persisted by the backend and known to be runnable. Bucket
   * descriptors expose these without requiring another profile-list IPC command. */
  readyProfiles?: EmbeddingProfile[];
}) {
  const [catalog, setCatalog] = useState<EmbeddingCatalogEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Record<string, InstallState>>({});

  const refresh = async () => {
    try {
      setCatalog(await api.knowledgeEmbeddingModelsList());
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const byId = useMemo(() => new Map(catalog.map((entry) => [entry.id, entry])), [catalog]);
  const models = BUILTIN_EMBEDDING_MODEL_IDS.map((id) => byId.get(id) ?? FALLBACK_MODELS[id]);

  const startInstall = (model: EmbeddingCatalogEntry, licenseAccepted: boolean) => {
    setInstalls((current) => ({
      ...current,
      [model.id]: { phase: "downloading", downloaded: 0, total: null, error: null },
    }));
    void api
      .knowledgeEmbeddingModelInstall(model.id, (event) => {
        handleInstallEvent(model.id, event, setInstalls);
        if (event.type === "Ready" || event.type === "Completed") {
          onSelectProfile(event.type === "Ready" ? event.profile_id : model.id);
          void refresh();
        }
      }, licenseAccepted)
      .then(() => void refresh())
      .catch((error) => {
        setInstalls((current) => ({
          ...current,
          [model.id]: {
            phase: "downloading",
            downloaded: current[model.id]?.downloaded ?? 0,
            total: current[model.id]?.total ?? null,
            error: String(error),
          },
        }));
      });
  };

  return (
    <section className="space-y-3" aria-labelledby="embedding-models-title">
      <div>
        <h3
          id="embedding-models-title"
          className="text-[10px] font-semibold uppercase tracking-widest text-text-muted"
        >
          Embedding models
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
          Turn documents and questions into matching vectors. Local models stay on this device;
          cloud profiles send document passages and search queries to their provider.
        </p>
      </div>

      {loadError && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] text-warning">
          Model status could not be refreshed: {loadError}
        </p>
      )}

      <div className="space-y-1.5">
        {models.map((model) => (
          <EmbeddingModelCard
            key={model.id}
            model={model}
            selected={selectedProfileId === model.id}
            install={installs[model.id]}
            onInstall={(licenseAccepted) => startInstall(model, licenseAccepted)}
            onSelect={() => onSelectProfile(model.id)}
            onCancel={() => void api.knowledgeEmbeddingModelCancel(model.id)}
          />
        ))}
      </div>

      <CloudProfiles
        selectedProfileId={selectedProfileId}
        onSelectProfile={onSelectProfile}
        readyProfiles={readyProfiles}
      />
    </section>
  );
}

function EmbeddingModelCard({
  model,
  selected,
  install,
  onInstall,
  onSelect,
  onCancel,
}: {
  model: EmbeddingCatalogEntry;
  selected: boolean;
  install?: InstallState;
  onInstall: (licenseAccepted: boolean) => void;
  onSelect: () => void;
  onCancel: () => void;
}) {
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const active = install && !install.error;
  const pct = install?.total ? Math.min(100, (install.downloaded / install.total) * 100) : 0;
  return (
    <article
      className={`rounded-lg border px-3 py-2 ${
        selected ? "border-accent bg-accent-subtle" : "border-border-subtle bg-bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-text-primary">
            <HardDrive size={12} className="text-text-muted" />
            {model.label}
            {model.recommended && (
              <span className="rounded bg-accent/10 px-1 py-0.5 text-[8px] uppercase tracking-wide text-accent">
                Recommended
              </span>
            )}
            {selected && <Check size={12} className="text-accent" />}
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">
            {model.description}
          </p>
          <p className="mt-1 text-[9px] text-text-muted">
            {model.default_dimension} dimensions · {formatTokens(model.context_tokens)} context ·
            100% local
            {model.download ? ` · ${formatBytes(model.download.size_bytes)}` : ""}
            {model.download ? ` · ${model.download.min_ram_gb} GB RAM` : ""}
          </p>
          {model.download?.requires_license && !model.installed && (
            <label className="mt-1.5 flex items-start gap-1.5 text-[9px] leading-relaxed text-text-muted">
              <input
                type="checkbox"
                checked={licenseAccepted}
                onChange={(event) => setLicenseAccepted(event.target.checked)}
                aria-label={`Accept ${model.label} model license`}
              />
              <span>
                I accept the{" "}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => {
                    const safeUrl = sanitizeExternalWebUrl(
                      `https://huggingface.co/${model.model}`,
                    );
                    if (safeUrl) void openUrl(safeUrl);
                  }}
                >
                  upstream model license
                </button>
                .
              </span>
            </label>
          )}
          {!model.available && model.unavailable_reason && (
            <p className="mt-1 text-[9px] text-warning">{model.unavailable_reason}</p>
          )}
          {install?.error && <p className="mt-1 text-[9px] text-error">{install.error}</p>}
        </div>
        <div className="shrink-0">
          {!model.available ? (
            <span className="rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-muted">
              Coming soon
            </span>
          ) : active ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover"
            >
              <X size={11} /> Cancel
            </button>
          ) : model.installed ? (
            <button
              type="button"
              onClick={onSelect}
              className="rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover"
            >
              {selected ? "Selected" : "Use profile"}
            </button>
          ) : (
            <button
              type="button"
              disabled={!!model.download?.requires_license && !licenseAccepted}
              onClick={() => onInstall(licenseAccepted)}
              className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover"
            >
              <Download size={11} /> Download &amp; use
            </button>
          )}
        </div>
      </div>
      {active && install && (
        <div className="mt-2" aria-label={`${model.label} ${install.phase}`}>
          <div className="flex items-center justify-between text-[9px] text-text-muted">
            <span className="flex items-center gap-1 capitalize">
              <Loader2 size={9} className="animate-spin" /> {install.phase}
            </span>
            <span>{install.total ? `${Math.round(pct)}%` : "Starting…"}</span>
          </div>
          <div className="mt-1 h-px bg-bg-elevated">
            <div className="h-px bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
    </article>
  );
}

function CloudProfiles({
  selectedProfileId,
  onSelectProfile,
  readyProfiles,
}: {
  selectedProfileId: string | null;
  onSelectProfile: (id: string) => void;
  readyProfiles: EmbeddingProfile[];
}) {
  const hasOpenAi = useAppStore((state) => state.hasApiKey.openai ?? false);
  const hasMistral = useAppStore((state) => state.hasApiKey.mistral ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = [
    {
      profileId: "openai/text-embedding-3-small/1536",
      provider: "openai" as const,
      label: "OpenAI",
      model: "text-embedding-3-small",
      dimension: 1536,
      configured: hasOpenAi,
    },
    {
      profileId: "mistral/mistral-embed/1024",
      provider: "mistral" as const,
      label: "Mistral",
      model: "mistral-embed",
      dimension: 1024,
      configured: hasMistral,
    },
  ];

  const useCloud = async (provider: (typeof providers)[number]) => {
    // eslint-disable-next-line no-alert
    if (
      !window.confirm(
        `Use ${provider.label} for this embedding profile? Extracted document passages will be sent during ingestion, and future search queries will be sent when this bucket is searched.`,
      )
    ) {
      return;
    }
    setBusy(provider.profileId);
    setError(null);
    try {
      const profileId = await api.knowledgeEmbeddingProfileCreateCloud(
        provider.provider,
        provider.model,
        provider.dimension,
      );
      onSelectProfile(profileId || provider.profileId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5 border-t border-border-subtle pt-3">
      <p className="text-[10px] font-medium text-text-secondary">Cloud profiles</p>
      <p className="text-[10px] leading-relaxed text-warning">
        Cloud embedding sends extracted passages during ingestion and your search queries later.
      </p>
      {providers.map((provider) => {
        // The persisted profile id is the source of truth. Cloud profile ids include
        // their output dimension (for example
        // `openai/text-embedding-3-small/1536`), because changing the dimension is an
        // incompatible profile rather than a setting on the same profile. Keep the
        // actual id returned by the backend instead of reconstructing or shortening it
        // when a Settings view is reopened.
        const readyProfile = readyProfiles.find(
          (profile) => profile.available && profile.id === provider.profileId,
        );
        const activeProfileId = readyProfile?.id ?? provider.profileId;
        const selected = selectedProfileId === activeProfileId;
        return (
          <article
            key={provider.profileId}
            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
              selected ? "border-accent bg-accent-subtle" : "border-border-subtle bg-bg-card"
            }`}
          >
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-primary">
                <Cloud size={12} className="text-text-muted" /> {provider.label}
                {selected && <Check size={12} className="text-accent" />}
              </p>
              <p className="truncate font-mono text-[9px] text-text-muted">{provider.model}</p>
              {!provider.configured && (
                <p className="text-[9px] text-warning">Add the API key under Settings → Models.</p>
              )}
            </div>
            <button
              type="button"
              disabled={!provider.configured || busy !== null}
              onClick={() => {
                if (readyProfile) {
                  onSelectProfile(readyProfile.id);
                } else {
                  void useCloud(provider);
                }
              }}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary hover:bg-bg-hover disabled:opacity-50"
            >
              {busy === provider.profileId && <Loader2 size={10} className="animate-spin" />}
              {selected ? "Selected" : "Use profile"}
            </button>
          </article>
        );
      })}
      {error && <p className="text-[9px] text-error">{error}</p>}
    </div>
  );
}

function handleInstallEvent(
  modelId: string,
  event: EmbeddingInstallEvent | DownloadEvent,
  setInstalls: React.Dispatch<React.SetStateAction<Record<string, InstallState>>>,
) {
  setInstalls((current) => {
    const previous = current[modelId] ?? {
      phase: "downloading" as const,
      downloaded: 0,
      total: null,
      error: null,
    };
    if (event.type === "Started") {
      return {
        ...current,
        [modelId]: {
          ...previous,
          phase: "downloading",
          downloaded: event.resumed_from,
          total: event.total_bytes,
        },
      };
    }
    if (event.type === "Progress") {
      return {
        ...current,
        [modelId]: {
          ...previous,
          phase: "downloading",
          downloaded: event.downloaded,
          total: event.total_bytes,
        },
      };
    }
    if (event.type === "Phase") {
      return { ...current, [modelId]: { ...previous, phase: event.phase } };
    }
    if (event.type === "Error") {
      return { ...current, [modelId]: { ...previous, error: event.message } };
    }
    if (event.type === "Cancelled" || event.type === "Ready" || event.type === "Completed") {
      const next = { ...current };
      delete next[modelId];
      return next;
    }
    return current;
  });
}
