import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CatalogEntry } from "../lib/types";
import { S } from "../lib/strings";

// The settings page groups its rows by the provider STRING the backend sends, and
// a group whose filter matches nothing renders as `null` — no heading, no API-key
// field, no rows, no error. That is how the whole OpenAI section went missing:
// `ProviderId` derived `rename_all = "snake_case"`, which spells `OpenAi` as
// "open_ai", while `BuiltInProviderId` says "openai".
//
// So this renders the real component against a BACKEND-SHAPED catalog and asserts
// every built-in provider surfaces. The Rust side of the contract is pinned by
// `every_provider_serializes_as_its_own_str` in models/catalog.rs — only that test
// can see the wire spelling; only this one can see what the wrong spelling costs.

const catalog = vi.fn<() => Promise<CatalogEntry[]>>();
const saved = vi.fn<(patch: unknown) => Promise<void>>();

vi.mock("../lib/tauri", () => ({
  modelsCatalog: () => catalog(),
  saveSettings: (patch: unknown) => saved(patch),
  modelStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: true })),
  getModelEffort: vi.fn(() => Promise.resolve({})),
  // Tolerated by `refreshModels`, and the section below it lists nothing.
  visionCatalog: vi.fn(() => Promise.resolve([])),
  visionStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: false })),
  remoteServersList: vi.fn(() => Promise.resolve([])),
  setModelEffort: vi.fn(() => Promise.resolve()),
  modelUnload: vi.fn(() => Promise.resolve()),
  archiveClear: vi.fn(() => Promise.resolve()),
}));

const { ModelsSettings } = await import("../components/settings/ModelsSettings");
const { useAppStore } = await import("../stores/appStore");

/** One cloud row, shaped exactly as `models_catalog` serializes it. */
function cloudEntry(provider: string, id: string, label: string, wireModel: string): CatalogEntry {
  return {
    id,
    provider,
    tier: provider === "mistral" ? "fast" : "balanced",
    label,
    description: `${label} description`,
    wire_model: wireModel,
    context_tokens: provider === "openai" ? 1_050_000 : provider === "mistral" ? 256_000 : 1_000_000,
    efforts: provider === "openai"
      ? ["low", "medium", "high", "max"]
      : provider === "mistral"
        ? ["off", "high"]
        : ["off", "low", "medium", "high", "max"],
    default_effort: provider === "anthropic" ? "high" : provider === "mistral" ? "off" : "medium",
    supports_temperature: provider === "mistral",
    supports_tools: true,
    native_web_search: provider === "anthropic",
    native_web_fetch: provider === "anthropic",
    supports_vision: true,
    local: null,
    remote: null,
    fits: true,
    downloaded: false,
    configured: false,
    effort: provider === "anthropic" ? "high" : provider === "mistral" ? "off" : "medium",
  } as CatalogEntry;
}

const CLOUD = [
  ["anthropic", "anthropic/claude-sonnet-5", "Claude Sonnet 5.5", "claude-sonnet-5-5"],
  ["openai", "openai/gpt-5.6-terra", "GPT-6.1 Sol", "gpt-6.1-sol"],
  ["mistral", "mistral/mistral-small-latest", "Mistral Small 4", "mistral-small-2603"],
] as const;

describe("ModelsSettings provider sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalog.mockResolvedValue(CLOUD.map(([p, id, label, wire]) => cloudEntry(p, id, label, wire)));
    saved.mockResolvedValue(undefined);
    useAppStore.setState({
      activeModelId: "local/qwen3.5-9b",
      loadedModelId: null,
      modelState: "idle",
      modelAvailable: true,
      modelEffort: {},
      downloads: {},
      hasApiKey: {},
      modelLoadError: null,
    });
  });

  it("renders a section for every built-in cloud provider", async () => {
    render(<ModelsSettings />);
    // The heading is what vanishes first, and the model row with it.
    for (const [, , label] of CLOUD) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("Mistral")).toBeTruthy();
  });

  it("shows chat accelerator device memory and fallback state", async () => {
    render(<ModelsSettings />);
    await screen.findByText("GPT-6.1 Sol");

    act(() => {
      useAppStore.setState({
        modelState: "ready",
        localAcceleration: {
          backend: "vulkan",
          device_name: "Radeon 780M",
          device_memory_bytes: 8_000_000_000,
          fallback_reason: null,
        },
      });
    });

    expect(
      screen.getByText("Chat inference: VULKAN · Radeon 780M · 8.0 GB device memory"),
    ).toBeInTheDocument();
  });

  it("gives OpenAI a reachable API-key field", async () => {
    render(<ModelsSettings />);
    await screen.findByText("GPT-6.1 Sol");
    // Three cloud providers, three key fields. Before the fix OpenAI's row set
    // rendered as null, so the ONLY input that can write `openai_api_key` did not
    // exist — the backend accepted a key nothing could send it.
    const fields = screen.getAllByPlaceholderText(S.settings.models.apiKey);
    expect(fields).toHaveLength(3);

    fireEvent.blur(fields[1], { target: { value: "sk-test-key" } });
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ openai_api_key: "sk-test-key" }));
  });

  it("selects GPT-6.1 Terra independently of the existing Sol model", async () => {
    const terra = cloudEntry("openai", "openai/gpt-6.1-terra", "GPT-6.1 Terra", "gpt-6.1-terra");
    terra.efforts = ["off", "low", "medium", "high", "max"];
    catalog.mockResolvedValue([
      ...CLOUD.map(([p, id, label, wire]) => cloudEntry(p, id, label, wire)),
      terra,
    ]);
    useAppStore.setState({ hasApiKey: { openai: true }, activeModelId: "openai/gpt-5.6-terra" });
    render(<ModelsSettings />);

    const row = (await screen.findByText("GPT-6.1 Terra")).closest(".rounded-lg");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(S.effort.off)).toBeInTheDocument();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: S.settings.models.select }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ active_model_id: "openai/gpt-6.1-terra" }));
    expect(useAppStore.getState().activeModelId).toBe("openai/gpt-6.1-terra");
    expect(screen.getByText("GPT-6.1 Sol")).toBeInTheDocument();
  });

  it("reads OpenAI's stored-key flag under the same string the wire sends", async () => {
    // `hasApiKey` is keyed by provider string too (`useSettings` mirrors
    // `has_openai_api_key` as `openai`), and `isUsable`/`aiBlockedReason` read it
    // with `entry.provider`. A drift here makes a keyed model look unusable.
    useAppStore.setState({ hasApiKey: { openai: true } });
    render(<ModelsSettings />);
    await screen.findByText("GPT-6.1 Sol");
    // Exactly one field says "stored", and it is OpenAI's.
    expect(screen.getAllByPlaceholderText(S.settings.models.apiKeyStored)).toHaveLength(1);
    expect(screen.getAllByPlaceholderText(S.settings.models.apiKey)).toHaveLength(2);
    // And only OpenAI's model is selectable: `isUsable` falls back to the stale
    // `configured` flag (false here) whenever the key lookup misses, so an enabled
    // Use button on that row and only that row is the lookup landing.
    const use = screen.getAllByRole("button", { name: S.settings.models.select });
    expect(use.map((b) => !(b as HTMLButtonElement).disabled)).toEqual([false, true, false]);
  });
});
