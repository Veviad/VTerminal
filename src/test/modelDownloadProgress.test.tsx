import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogEntry, DownloadEvent, VisionCatalogEntry } from "../lib/types";

const api = vi.hoisted(() => ({
  modelsCancelDownload: vi.fn<(downloadId: string) => Promise<void>>(),
  modelsCatalog: vi.fn<() => Promise<CatalogEntry[]>>(),
  modelStatus: vi.fn<() => Promise<{ loaded: null; state: "idle"; available: true }>>(),
  visionCatalog: vi.fn<() => Promise<VisionCatalogEntry[]>>(),
  visionStatus: vi.fn<() => Promise<{ loaded: null; state: "idle"; available: true }>>(),
  getModelEffort: vi.fn(() => Promise.resolve({})),
  remoteServersList: vi.fn(() => Promise.resolve([])),
  modelsDownload:
    vi.fn<
      (downloadId: string, modelId: string, onEvent: (event: DownloadEvent) => void) => Promise<void>
    >(),
  visionDownload:
    vi.fn<
      (downloadId: string, modelId: string, onEvent: (event: DownloadEvent) => void) => Promise<void>
    >(),
  setModelEffort: vi.fn(() => Promise.resolve()),
  modelUnload: vi.fn(() => Promise.resolve()),
  modelsDelete: vi.fn(() => Promise.resolve()),
  modelLoad: vi.fn(() => Promise.resolve()),
  visionUnload: vi.fn(() => Promise.resolve()),
  visionLoad: vi.fn(() => Promise.resolve()),
  visionDelete: vi.fn(() => Promise.resolve()),
  saveSettings: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/tauri", () => api);

const { InlineModelDownloadProgress } = await import(
  "../components/settings/InlineModelDownloadProgress"
);
const { ModelRow, startDownloadWith } = await import("../components/settings/ModelRow");
const { ModelsSettings } = await import("../components/settings/ModelsSettings");
const { VisionSection } = await import("../components/settings/VisionSection");
const { useAppStore } = await import("../stores/appStore");

function chatModel(id: string, label: string): CatalogEntry {
  return {
    id,
    provider: "local",
    tier: "balanced",
    label,
    description: `${label} description`,
    wire_model: id,
    context_tokens: 32_768,
    efforts: ["off"],
    default_effort: "off",
    supports_temperature: true,
    supports_tools: true,
    native_web_search: false,
    native_web_fetch: false,
    supports_vision: false,
    local: {
      artifact: {
        repo_id: "shared/repository",
        filename: "shared.gguf",
        size_bytes: 100_000_000,
      },
      mtp: {
        kind: "embedded",
        legacy: {
          repo_id: "shared/repository",
          filename: "legacy.gguf",
          size_bytes: 90_000_000,
        },
        draft_tokens: 6,
      },
      min_ram_gb: 1,
      family: "qwen",
    },
    remote: null,
    fits: true,
    downloaded: false,
    configured: true,
    effort: "off",
  };
}

function visionModel(): VisionCatalogEntry {
  return {
    id: "vision/reader",
    label: "Document Reader",
    description: "Reads text from images.",
    repo_id: "shared/repository",
    filename: "shared.gguf",
    size_bytes: 80_000_000,
    mmproj_filename: "projector.gguf",
    mmproj_size_bytes: 40_000_000,
    total_bytes: 120_000_000,
    min_ram_gb: 1,
    required_ram_gb: 1,
    context_tokens: 4096,
    arch: "qwen3_vl",
    default_prompt: "Read this image.",
    fits: true,
    downloaded: false,
    selected: false,
  };
}

describe("inline model download progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.modelsCancelDownload.mockResolvedValue(undefined);
    api.modelsCatalog.mockResolvedValue([]);
    api.modelStatus.mockResolvedValue({ loaded: null, state: "idle", available: true });
    api.visionCatalog.mockResolvedValue([]);
    api.visionStatus.mockResolvedValue({ loaded: null, state: "idle", available: true });
    useAppStore.setState({
      activeModelId: "none",
      loadedModelId: null,
      modelState: "idle",
      modelAvailable: true,
      modelEffort: {},
      downloads: {},
      downloadErrors: {},
      catalog: [],
      visionCatalog: [],
      visionLoadedModelId: null,
      visionState: "idle",
      visionLoadError: null,
      visionModelId: null,
    });
  });

  it("exposes determinate transfer details and an exact cancel action", () => {
    const cancel = vi.fn();
    render(
      <InlineModelDownloadProgress
        label="Qwen"
        downloaded={50_000_000}
        total={100_000_000}
        bytesPerSecond={10_000_000}
        onCancel={cancel}
      />,
    );

    const progress = screen.getByRole("progressbar", { name: "Qwen download progress" });
    expect(progress).toHaveAttribute("aria-valuenow", "50");
    expect(progress).toHaveAttribute("aria-valuetext", "50 MB / 100 MB · 10 MB/s · 5s left");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Qwen download" }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("uses an indeterminate progressbar until a total is known", () => {
    render(
      <InlineModelDownloadProgress
        label="Gemma"
        downloaded={0}
        total={null}
        onCancel={vi.fn()}
      />,
    );
    const progress = screen.getByRole("progressbar", { name: "Gemma download progress" });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("Starting…")).toBeTruthy();
  });

  it("keeps same-file downloads on their owning chat model cards", () => {
    useAppStore.setState({
      downloads: {
        "dl-first": {
          kind: "chat",
          modelId: "local/first",
          repoId: "shared/repository",
          filename: "shared.gguf",
          downloaded: 25,
          total: 100,
          bps: 10,
        },
        "dl-second": {
          kind: "chat",
          modelId: "local/second",
          repoId: "shared/repository",
          filename: "shared.gguf",
          downloaded: 75,
          total: 100,
          bps: 10,
        },
      },
    });

    render(
      <>
        <ModelRow entry={chatModel("local/first", "First model")} />
        <ModelRow entry={chatModel("local/second", "Second model")} />
      </>,
    );

    expect(
      screen.getByRole("progressbar", { name: "First model download progress" }),
    ).toHaveAttribute("aria-valuenow", "25");
    expect(
      screen.getByRole("progressbar", { name: "Second model download progress" }),
    ).toHaveAttribute("aria-valuenow", "75");

    fireEvent.click(screen.getByRole("button", { name: "Cancel First model download" }));
    expect(api.modelsCancelDownload).toHaveBeenCalledWith("dl-first");
    expect(api.modelsCancelDownload).not.toHaveBeenCalledWith("dl-second");
  });

  it("renders progress only inside the owning card, without a duplicate global row", async () => {
    const entry = chatModel("local/first", "First model");
    api.modelsCatalog.mockResolvedValue([entry]);
    useAppStore.setState({
      catalog: [entry],
      downloads: {
        "dl-first": {
          kind: "chat",
          modelId: entry.id,
          repoId: entry.local!.artifact.repo_id,
          filename: entry.local!.artifact.filename,
          downloaded: 25,
          total: 100,
          bps: 10,
        },
      },
    });

    render(<ModelsSettings />);
    expect(await screen.findByText("First model")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(
      screen.getByRole("progressbar", { name: "First model download progress" }),
    ).toBeTruthy();
  });

  it("keeps a failed transfer on its card and offers retry", async () => {
    await act(async () => {
      startDownloadWith(
        async (_downloadId, onEvent) => {
          onEvent({ type: "Error", message: "checksum mismatch" });
        },
        {
          kind: "chat",
          modelId: "local/first",
          repoId: "shared/repository",
          filename: "shared.gguf",
        },
      );
    });

    render(<ModelRow entry={chatModel("local/first", "First model")} />);
    expect(screen.getByText("checksum mismatch")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("offers an explicit MTP upgrade and blocks Qwen replacement while loaded", () => {
    const entry = chatModel("local/first", "First model");
    entry.downloaded = true;
    entry.mtp = {
      kind: "embedded",
      state: "upgrade_available",
      download_bytes: 2_800_000_000,
      disk_delta_bytes: 94_000_000,
      draft_tokens: 6,
    };
    useAppStore.setState({ loadedModelId: entry.id, modelState: "ready" });
    render(<ModelRow entry={entry} />);

    expect(screen.getByText(/MTP upgrade available/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade to MTP" })).toBeDisabled();
    expect(screen.getByTitle("Unload this Qwen model before replacing its weights.")).toBeTruthy();
  });

  it("renders the backend's aggregate two-file vision transfer on its card", async () => {
    let emitted: ((event: DownloadEvent) => void) | null = null;
    let exactDownloadId = "";
    api.visionDownload.mockImplementationOnce(async (downloadId, _modelId, onEvent) => {
      exactDownloadId = downloadId;
      emitted = onEvent;
    });
    useAppStore.setState({ visionCatalog: [visionModel()] });
    render(<VisionSection />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await act(async () => {
      emitted?.({
        type: "Progress",
        downloaded: 60_000_000,
        total_bytes: 120_000_000,
        bytes_per_sec: 10_000_000,
      });
    });

    const progress = screen.getByRole("progressbar", {
      name: "Document Reader download progress",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "50");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "60 MB / 120 MB · 10 MB/s · 6s left",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel Document Reader download" }));
    expect(api.modelsCancelDownload).toHaveBeenCalledWith(exactDownloadId);
  });
});
