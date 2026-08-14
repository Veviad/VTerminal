import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useSettings } from "../../hooks/useSettings";
import * as api from "../../lib/tauri";
import type { BuiltInProviderId, CatalogEntry, SettingsPatch } from "../../lib/types";
import { refreshModels as refresh } from "../../lib/selectModel";
import { ModelRow } from "./ModelRow";
import { RemoteServersSection } from "./RemoteServersSection";
import { VisionSection } from "./VisionSection";
import { S } from "../../lib/strings";

/** Order providers so the on-device options lead — that is the default path.
 *  Typed to the BUILT-IN providers only: a remote server is grouped by server,
 *  not by provider, and narrowing here is what makes the compiler say so. */
const PROVIDER_ORDER: BuiltInProviderId[] = ["local", "anthropic", "openai", "mistral"];

const PROVIDER_LABELS: Record<BuiltInProviderId, string> = {
  local: "On-device",
  anthropic: "Anthropic",
  openai: "OpenAI",
  mistral: "Mistral",
};

const KEY_FIELD: Record<string, keyof SettingsPatch> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  mistral: "mistral_api_key",
};

export function ModelsSettings() {
  const catalog = useAppStore((s) => s.catalog);

  useEffect(() => {
    void refresh().catch(() => {});
    void api
      .getModelEffort()
      .then((m) => useAppStore.getState().setModelEffortMap(m))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-8">
      <CredentialStoreBanner />
      <LoadErrorBanner />
      {PROVIDER_ORDER.map((provider) => {
        const entries = catalog.filter((m) => m.provider === provider);
        if (entries.length === 0) return null;
        return (
          <div key={provider} className="space-y-8">
            <ProviderSection provider={provider} entries={entries} />
            {/* Right after the on-device lineup: the sidecar only means anything
                to someone already running models locally, and it competes with
                the chat model for the same memory budget. */}
            {provider === "local" && <VisionSection />}
          </div>
        );
      })}
      {/* Below the built-ins by decision: this is the advanced path, and the tab
          must not open with a section that is empty on a fresh install. */}
      <RemoteServersSection />
    </div>
  );
}

/// Only affects on-device downloads, so it lives in that section rather than
/// floating below the API providers as if it were global.
function HfTokenField() {
  const { save } = useSettings();
  const present = useAppStore((s) => s.hasHfToken);
  return (
    <div className="space-y-1 pt-1">
      <div className="flex gap-2">
        <input
          type="password"
          placeholder={present ? S.settings.models.apiKeyStored : S.settings.models.hfToken}
          onBlur={(e) => {
            const value = e.target.value;
            if (!value) return;
            void save({ hf_token: value });
            e.target.value = "";
          }}
          className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted"
        />
        {present && (
          <button
            type="button"
            onClick={() => void save({ hf_token: "" })}
            className="rounded-md border border-border-subtle px-2 text-[11px] text-text-muted hover:text-error"
          >
            Clear
          </button>
        )}
      </div>
      <p className="text-[10px] leading-relaxed text-text-muted">
        {S.settings.models.hfTokenHint}
      </p>
    </div>
  );
}

export function CredentialStoreBanner() {
  const status = useAppStore((s) => s.credentialStoreStatus);
  if (status === "ready") return null;
  return (
    <p className="rounded-lg bg-error-subtle px-3 py-2 text-[11px] leading-relaxed text-error">
      macOS Keychain is unavailable. Credential use is blocked until Keychain access is restored.
    </p>
  );
}

function LoadErrorBanner() {
  const modelLoadError = useAppStore((s) => s.modelLoadError);
  if (!modelLoadError) return null;
  return (
    <p className="rounded-lg bg-error-subtle px-3 py-2 text-[11px] leading-relaxed text-error">
      {modelLoadError}
    </p>
  );
}

function ProviderSection({
  provider,
  entries,
}: {
  provider: BuiltInProviderId;
  entries: CatalogEntry[];
}) {
  const isLocal = provider === "local";
  const engineMissing = useAppStore((s) => s.localEngineMissing());
  // Say it once, above the rows, instead of letting the user find out by
  // clicking Load and reading the backend's error.
  const noEngine = isLocal && engineMissing;
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        {PROVIDER_LABELS[provider]}
      </h3>
      <p className="text-[11px] text-text-muted">
        {isLocal ? S.settings.models.onDeviceHint : S.settings.models.cloudHint}
      </p>
      {noEngine && (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-warning">
          {S.settings.models.noEngine}
        </p>
      )}
      {!isLocal && <ApiKeyField provider={provider} />}
      <div className="space-y-1.5">
        {entries.map((entry) => (
          <ModelRow key={entry.id} entry={entry} />
        ))}
      </div>
      {/* The token only ever raises download rate limits, and there is nothing
          to download in a build that cannot run any of it. */}
      {isLocal && !noEngine && <HfTokenField />}
    </section>
  );
}

function ApiKeyField({ provider }: { provider: BuiltInProviderId }) {
  const { save } = useSettings();
  const present = useAppStore((s) => s.hasApiKey[provider] ?? false);
  const field = KEY_FIELD[provider];
  if (!field) return null;
  return (
    <div className="flex gap-2">
      <input
        type="password"
        // Never render the stored value — the backend only reports presence.
        placeholder={present ? S.settings.models.apiKeyStored : S.settings.models.apiKey}
        onBlur={(e) => {
          const v = e.target.value;
          if (v.length === 0) return;
          void save({ [field]: v } as never).then(() => void refresh());
          e.target.value = "";
        }}
        className="min-w-0 flex-1 rounded-md border border-border-subtle bg-bg-card px-2 py-1.5 font-mono text-[12px] text-text-primary placeholder:text-text-muted"
      />
      {present && (
        <button
          type="button"
          onClick={() =>
            void save({ [field]: "" } as never).then(() => void refresh())
          }
          className="rounded-md border border-border-subtle px-2 text-[11px] text-text-muted hover:text-error"
        >
          Clear
        </button>
      )}
    </div>
  );
}
