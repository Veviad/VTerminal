import * as api from "./tauri";
import { useAppStore } from "../stores/appStore";
import type { CatalogEntry, ModelState, ModelStatus } from "./types";

// Selecting a model is the one place where three things must agree: what the
// header chip says, what `aiReady` gates on, and what `resolve_provider` picks
// for the next request. Keeping this in one module is why the settings page and
// the header menu cannot drift apart.

/** Re-read the catalog and the loaded-model status together.
 *
 *  The vision sidecar rides along in the same round trip, and it has to: its
 *  `fits` is computed against the ACTIVE CHAT MODEL, so selecting a bigger chat
 *  model can make a sidecar stop fitting. Fetching them separately would leave the
 *  two views disagreeing about that. */
export async function refreshModels(): Promise<void> {
  const [catalog, status, visionCatalog, visionStatus] = await Promise.all([
    api.modelsCatalog(),
    api.modelStatus(),
    // Tolerated rather than required: a build with no local engine answers with an
    // empty list, and one failure here must not blank the chat catalog.
    api.visionCatalog().catch(() => []),
    api.visionStatus().catch(() => ({ loaded: null, state: "idle", available: false })),
  ]);
  const store = useAppStore.getState();
  store.setCatalog(catalog);
  store.setModelStatus(status.loaded, status.state, status.available);
  store.setVisionCatalog(visionCatalog);
  store.setVisionStatus(visionStatus.loaded, visionStatus.state as ModelState);
}

/** Load the vision sidecar, surfacing load errors the way `loadModel` does. */
export function loadVisionModel(modelId: string): Promise<void> {
  const store = useAppStore.getState();
  store.setVisionStatus(modelId, "loading");
  store.setVisionLoadError(null);
  return api
    .visionLoad(modelId, (e) => {
      if (e.type === "Error") useAppStore.getState().setVisionLoadError(e.message);
    })
    .then(refreshModels)
    .catch(async (err) => {
      const s = useAppStore.getState();
      if (!s.visionLoadError) s.setVisionLoadError(String(err));
      await refreshModels();
    });
}

/** Choose which sidecar transcribes images. Persisted, then reconciled: a
 *  different sidecar left resident holds gigabytes for something nothing calls. */
export async function selectVisionModel(modelId: string | null): Promise<void> {
  // Empty string is the clear sentinel — JSON null is indistinguishable from
  // "not provided" once serde sees Option over IPC.
  await api.saveSettings({ vision_model_id: modelId ?? "" });
  useAppStore.setState({ visionModelId: modelId });
  const loaded = useAppStore.getState().visionLoadedModelId;
  if (loaded && loaded !== modelId) {
    await api.visionUnload().catch(() => {});
  }
  await refreshModels();
}

/** Load an on-device model into the host, surfacing load errors. */
export function loadModel(modelId: string): Promise<void> {
  const store = useAppStore.getState();
  store.setModelStatus(modelId, "loading", true);
  store.setModelLoadError(null);
  return api
    .modelLoad(modelId, (e) => {
      if (e.type === "Error") useAppStore.getState().setModelLoadError(e.message);
    })
    .then(refreshModels)
    .catch(async (err) => {
      const s = useAppStore.getState();
      if (!s.modelLoadError) s.setModelLoadError(String(err));
      await refreshModels();
    });
}

/** Warm up the on-device models at boot, in the ONE order that works.
 *
 *  The sidecar has to WAIT for the chat model. `vision_load` refuses outright
 *  while the chat host is loading ("a chat model is loading right now"), and two
 *  concurrent Metal allocations peak at the sum plus fragmentation. Dispatching
 *  both at once — which is what boot used to do, the sequencing being only a
 *  comment — meant the refusal landed in a swallowed catch on every start where
 *  the chat model was local: a sidecar the user had chosen and used the run
 *  before came back as `imageReader() === "none"`, so dropping an image or a PDF
 *  reported no reader until they opened Settings and loaded it by hand.
 *
 *  A chat-model failure must not cancel the sidecar, and cannot: `loadModel`
 *  absorbs its own error into `modelLoadError`, so awaiting it always resolves.
 *
 *  `chatStatus.available` is the local engine's presence, so it gates BOTH — a
 *  cloud-only build would otherwise banner a `local-llm` stub error at every
 *  start over a `vision_model_id` left behind by an earlier build. */
export async function warmStart(chatStatus: ModelStatus): Promise<void> {
  const s = useAppStore.getState();
  // Only on-device models need loading; an API model is ready as soon as its key
  // is present. `idle` keeps this off a host that is already busy.
  const chat = s.activeModelId;
  if (
    s.autoLoadModelOnStart &&
    chat.startsWith("local/") &&
    chatStatus.available &&
    chatStatus.state === "idle"
  ) {
    await loadModel(chat);
  }
  // Re-read: the load above refreshed both statuses.
  const after = useAppStore.getState();
  const sidecar = after.visionModelId;
  if (
    after.visionAutoLoadOnStart &&
    sidecar &&
    chatStatus.available &&
    after.visionLoadedModelId !== sidecar
  ) {
    await loadVisionModel(sidecar);
  }
}

/**
 * Make `entry` the model that answers.
 *
 * Persisting `active_model_id` alone is not enough: an on-device model has to
 * be resident before it can reply, and a local model left loaded after you
 * switch to an API model holds gigabytes of Metal buffers for something nothing
 * will call. So "Use" also reconciles what is loaded.
 */
export async function selectModel(entry: CatalogEntry): Promise<void> {
  await api.saveSettings({ active_model_id: entry.id });
  useAppStore.setState({ activeModelId: entry.id });

  const loadedModelId = useAppStore.getState().loadedModelId;
  if (entry.local) {
    if (loadedModelId !== entry.id) await loadModel(entry.id);
  } else if (loadedModelId) {
    await api.modelUnload().catch(() => {});
    await refreshModels().catch(() => {});
  }
}

/** Whether this model can answer right now — the same rule as `aiReady`. */
export function isUsable(entry: CatalogEntry): boolean {
  const s = useAppStore.getState();
  // A build compiled without `local-llm` makes every on-device model unrunnable
  // no matter how complete the download is: `model_load` is a stub that errors,
  // and `resolve_provider` would fail on the next request anyway.
  if (entry.local) return entry.downloaded && entry.fits && !s.localEngineMissing();
  // Nothing to load and nothing to key — see `aiBlockedReason`, which this
  // mirrors branch for branch.
  if (entry.remote) return true;
  return s.hasApiKey[entry.provider] ?? entry.configured;
}
