import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
import { isUsable } from "../lib/selectModel";
import type { CatalogEntry } from "../lib/types";

// Regression tests for a bug that disabled the ENTIRE AI surface for anyone
// using an API model: readiness was gated on `modelState`, which only tracks the
// on-device ModelHost and is therefore permanently "idle" for a cloud model. The
// panel demanded "Load a model in Settings" for a configured Claude key.

function localEntry(id: string): CatalogEntry {
  return {
    id,
    provider: "local",
    tier: "balanced",
    label: id,
    description: "",
    wire_model: "x.gguf",
    context_tokens: 262_144,
    efforts: ["off", "low", "medium", "high"],
    default_effort: "medium",
    supports_temperature: true,
    supports_tools: true,
    native_web_search: false,
    native_web_fetch: false,
    supports_vision: false,
    local: {
      artifact: { repo_id: "r", filename: "x.gguf", size_bytes: 1 },
      mtp: {
        kind: "embedded",
        legacy: { repo_id: "r", filename: "legacy.gguf", size_bytes: 1 },
        draft_tokens: 6,
      },
      min_ram_gb: 8,
      family: "qwen",
    },
    mtp: null,
    remote: null,
    fits: true,
    downloaded: true,
    configured: true,
    effort: "medium",
  };
}

function cloudEntry(id: string, provider: CatalogEntry["provider"]): CatalogEntry {
  return {
    ...localEntry(id),
    provider,
    local: null,
    downloaded: false,
    configured: false,
  };
}

/** A model on a server the user configured. Note `efforts: []` — a remote model
 *  declares no rungs, so the picker self-hides. */
function remoteEntry(id: string, serverId = "srv-1"): CatalogEntry {
  return {
    ...cloudEntry(id, "remote"),
    efforts: [],
    default_effort: "off",
    effort: "off",
    configured: true,
    remote: {
      server_id: serverId,
      server_label: "Workstation",
      kind: "ollama",
      supports_tools: true,
    },
  };
}

describe("aiReady / aiBlockedReason", () => {
  beforeEach(() => {
    useAppStore.setState({
      catalog: [],
      hasApiKey: {},
      loadedModelId: null,
      modelState: "idle",
      modelAvailable: true,
      activeModelId: "local/qwen3.5-9b",
    });
  });

  it("an API model with a key is ready with nothing loaded", () => {
    // The actual bug: modelState stays "idle" forever for a cloud model.
    useAppStore.setState({
      catalog: [cloudEntry("anthropic/claude-sonnet-5", "anthropic")],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      modelState: "idle",
      loadedModelId: null,
    });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
    expect(useAppStore.getState().aiReady()).toBe(true);
  });

  it("an API model without a key asks for a key, not for a model load", () => {
    useAppStore.setState({
      catalog: [cloudEntry("openai/gpt-5.6-terra", "openai")],
      activeModelId: "openai/gpt-5.6-terra",
      hasApiKey: { openai: false },
    });
    expect(useAppStore.getState().aiBlockedReason()).toBe("key");
  });

  it("a freshly saved key flips readiness without re-fetching the catalog", () => {
    // hasApiKey updates on save; entry.configured only on a catalog refresh.
    const stale = { ...cloudEntry("mistral/mistral-large-latest", "mistral"), configured: false };
    useAppStore.setState({
      catalog: [stale],
      activeModelId: "mistral/mistral-large-latest",
      hasApiKey: {},
    });
    expect(useAppStore.getState().aiReady()).toBe(false);
    useAppStore.getState().setHasApiKey("mistral", true);
    expect(useAppStore.getState().aiReady()).toBe(true);
  });

  it("an on-device model still requires an actual load", () => {
    useAppStore.setState({
      catalog: [localEntry("local/qwen3.5-9b")],
      activeModelId: "local/qwen3.5-9b",
      loadedModelId: null,
      modelState: "idle",
    });
    expect(useAppStore.getState().aiBlockedReason()).toBe("load");

    useAppStore.setState({ loadedModelId: "local/qwen3.5-9b", modelState: "ready" });
    expect(useAppStore.getState().aiReady()).toBe(true);
  });

  it("a DIFFERENT on-device model being loaded does not count as ready", () => {
    // Selecting 9B while 4B is resident must not silently answer from 4B.
    useAppStore.setState({
      catalog: [localEntry("local/qwen3.5-9b"), localEntry("local/qwen3.5-4b")],
      activeModelId: "local/qwen3.5-9b",
      loadedModelId: "local/qwen3.5-4b",
      modelState: "ready",
    });
    expect(useAppStore.getState().aiBlockedReason()).toBe("load");
  });

  it("falls back to the on-device signal before the catalog has loaded", () => {
    // At boot the catalog is empty; a local-first user must not be told to add
    // an API key they do not need.
    useAppStore.setState({ catalog: [], modelState: "idle" });
    expect(useAppStore.getState().aiBlockedReason()).toBe("load");
    useAppStore.setState({ modelState: "ready" });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
  });

  it("a keyless remote server is ready with nothing loaded and no key", () => {
    // The normal case: an Ollama box on the LAN. Neither of the two things the
    // other branches gate on — a resident GGUF, a stored key — exists here.
    useAppStore.setState({
      catalog: [remoteEntry("remote/srv-1/qwen3:8b")],
      activeModelId: "remote/srv-1/qwen3:8b",
      hasApiKey: {},
      modelState: "idle",
      loadedModelId: null,
    });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
    expect(useAppStore.getState().aiReady()).toBe(true);
    expect(isUsable(remoteEntry("remote/srv-1/qwen3:8b"))).toBe(true);
  });

  it("does not consult hasApiKey for a remote model", () => {
    // The regression this exists for: `hasApiKey` is keyed by PROVIDER string, so
    // without its own branch one token-bearing server would gate every keyless
    // one — and every remote model shares the provider "remote".
    useAppStore.setState({
      catalog: [remoteEntry("remote/srv-1/qwen3:8b")],
      activeModelId: "remote/srv-1/qwen3:8b",
      hasApiKey: { remote: false },
    });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
  });

  it("stays ready even if the backend calls it unconfigured", () => {
    // Readiness must not lean on a field the frontend does not control: "key"
    // would point at an API-key box that does not exist for a remote row.
    const entry = { ...remoteEntry("remote/srv-1/qwen3:8b"), configured: false };
    useAppStore.setState({ catalog: [entry], activeModelId: entry.id });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
    expect(isUsable(entry)).toBe(true);
  });

  it("a wire model containing a slash resolves like any other", () => {
    // LM Studio ids are repo-qualified, so the id has four segments. Nothing in
    // the readiness path may parse it.
    const id = "remote/srv-1/lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF";
    useAppStore.setState({ catalog: [remoteEntry(id)], activeModelId: id });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
  });
});

// A build without `--features local-llm` answers model_status with
// available: false. Every local affordance is dead there — `model_load` is a
// stub that errors — so the UI must stop offering them instead of letting that
// error be the discovery.
describe("a build without the on-device engine", () => {
  beforeEach(() => {
    useAppStore.setState({
      catalog: [localEntry("local/qwen3.5-9b")],
      hasApiKey: {},
      loadedModelId: null,
      modelState: "idle",
      modelAvailable: false,
      activeModelId: "local/qwen3.5-9b",
    });
  });

  it("names the build, not a load the user cannot perform", () => {
    expect(useAppStore.getState().aiBlockedReason()).toBe("engine");
    expect(useAppStore.getState().aiReady()).toBe(false);
  });

  it("reports engine-missing even before the catalog lands", () => {
    // The id prefix is the only signal at that point.
    useAppStore.setState({ catalog: [] });
    expect(useAppStore.getState().aiBlockedReason()).toBe("engine");
  });

  it("leaves an API model alone", () => {
    useAppStore.setState({
      catalog: [cloudEntry("anthropic/claude-sonnet-5", "anthropic")],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
    });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
  });

  it("marks a downloaded local model unusable, so nothing offers it", () => {
    // Downloaded and it fits, but this build still cannot run it.
    expect(isUsable(localEntry("local/qwen3.5-9b"))).toBe(false);
    useAppStore.setState({ modelAvailable: true });
    expect(isUsable(localEntry("local/qwen3.5-9b"))).toBe(true);
  });

  it("leaves a remote model alone", () => {
    // Nothing about a build without the on-device engine touches a server the
    // user configured — the weights are not on this machine either way.
    useAppStore.setState({
      catalog: [remoteEntry("remote/srv-1/qwen3:8b")],
      activeModelId: "remote/srv-1/qwen3:8b",
    });
    expect(useAppStore.getState().aiBlockedReason()).toBeNull();
    expect(isUsable(remoteEntry("remote/srv-1/qwen3:8b"))).toBe(true);
  });

  it("treats a not-yet-probed status as engine present", () => {
    // modelAvailable is null until model_status answers. Reading that as
    // "missing" would flash the warning over every local-llm launch.
    useAppStore.setState({ modelAvailable: null });
    expect(useAppStore.getState().localEngineMissing()).toBe(false);
    expect(useAppStore.getState().aiBlockedReason()).toBe("load");
    expect(isUsable(localEntry("local/qwen3.5-9b"))).toBe(true);
  });
});
