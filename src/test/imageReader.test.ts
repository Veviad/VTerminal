import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../stores/appStore";
import { ocrAvailable } from "../lib/attachInput";
import type { CatalogEntry, VisionCatalogEntry } from "../lib/types";

// `imageReader()` is the ONE definition of who reads an attached image. Three
// things consume it — the header chip, the panel's notice, and `ocrAvailable` —
// and they must never disagree, which is the whole reason it is not computed
// inline in each of them.

function chat(id: string, supportsVision: boolean): CatalogEntry {
  return {
    id,
    provider: "anthropic",
    tier: "balanced",
    label: `Chat ${id}`,
    description: "",
    wire_model: id,
    context_tokens: 1000,
    efforts: ["off"],
    default_effort: "off",
    supports_temperature: true,
    native_web_fetch: false,
    supports_vision: supportsVision,
    local: null,
    remote: null,
    fits: true,
    downloaded: false,
    configured: true,
    effort: "off",
  };
}

function sidecar(id: string, label: string): VisionCatalogEntry {
  return {
    id,
    label,
    description: "",
    repo_id: "r",
    filename: "m.gguf",
    size_bytes: 1,
    mmproj_filename: "p.gguf",
    mmproj_size_bytes: 1,
    min_ram_gb: 8,
    context_tokens: 4096,
    arch: "paddle_ocr",
    default_prompt: "x",
    total_bytes: 2,
    fits: true,
    required_ram_gb: 8,
    downloaded: true,
    selected: true,
  };
}

const reader = () => useAppStore.getState().imageReader();

beforeEach(() => {
  useAppStore.setState({
    catalog: [],
    activeModelId: "anthropic/blind",
    visionCatalog: [],
    visionModelId: null,
    visionLoadedModelId: null,
  });
});

describe("imageReader", () => {
  it("is native when the chat model reads images itself", () => {
    useAppStore.setState({
      catalog: [chat("anthropic/seeing", true)],
      activeModelId: "anthropic/seeing",
    });
    expect(reader()).toEqual({ kind: "native", label: "Chat anthropic/seeing" });
    // Native is NOT the sidecar path — nothing should route through on-device OCR.
    expect(ocrAvailable()).toBe(false);
  });

  /** Native wins even with a sidecar loaded: the images go to the chat model, and
   *  the header must not name a second model that will sit idle. */
  it("prefers native over a loaded sidecar", () => {
    useAppStore.setState({
      catalog: [chat("anthropic/seeing", true)],
      activeModelId: "anthropic/seeing",
      visionCatalog: [sidecar("vision/p", "PaddleOCR-VL 1.6")],
      visionModelId: "vision/p",
      visionLoadedModelId: "vision/p",
    });
    expect(reader().kind).toBe("native");
  });

  it("is sidecar when a blind chat model is paired with a loaded reader", () => {
    useAppStore.setState({
      catalog: [chat("anthropic/blind", false)],
      visionCatalog: [sidecar("vision/p", "PaddleOCR-VL 1.6")],
      visionModelId: "vision/p",
      visionLoadedModelId: "vision/p",
    });
    expect(reader()).toEqual({ kind: "sidecar", label: "PaddleOCR-VL 1.6" });
    expect(ocrAvailable()).toBe(true);
  });

  /** The distinction that matters: a transcription would fail at SEND time, after
   *  the user had already pressed Send. So chosen-but-not-loaded is `none`. */
  it("is none when the sidecar is chosen but not loaded", () => {
    useAppStore.setState({
      catalog: [chat("anthropic/blind", false)],
      visionCatalog: [sidecar("vision/p", "PaddleOCR-VL 1.6")],
      visionModelId: "vision/p",
      visionLoadedModelId: null,
    });
    expect(reader().kind).toBe("none");
    expect(ocrAvailable()).toBe(false);
  });

  it("is none when a DIFFERENT sidecar is the loaded one", () => {
    useAppStore.setState({
      catalog: [chat("anthropic/blind", false)],
      visionCatalog: [sidecar("vision/p", "PaddleOCR-VL 1.6")],
      visionModelId: "vision/p",
      visionLoadedModelId: "vision/other",
    });
    expect(reader().kind).toBe("none");
  });

  it("is none with a blind chat model and no sidecar at all", () => {
    useAppStore.setState({ catalog: [chat("anthropic/blind", false)] });
    expect(reader()).toEqual({ kind: "none", label: null });
  });

  /** Boot order: the panel mounts before the catalog resolves. An unknown active
   *  model must not claim native vision. */
  it("is none before the catalog has loaded", () => {
    expect(reader().kind).toBe("none");
  });

  /** Falls back to the id so the chip never renders an empty label. */
  it("labels a loaded sidecar missing from the catalog by its id", () => {
    useAppStore.setState({
      catalog: [chat("anthropic/blind", false)],
      visionModelId: "vision/p",
      visionLoadedModelId: "vision/p",
    });
    expect(reader()).toEqual({ kind: "sidecar", label: "vision/p" });
  });

  /** It returns a FRESH object each call, which is why every component selects a
   *  primitive off it rather than the object — zustand v5 compares snapshots by
   *  identity, and selecting this whole would re-render forever. Pinning the
   *  freshness makes the reason for that discipline explicit. */
  it("returns a new object each call, so selectors must take a primitive", () => {
    useAppStore.setState({ catalog: [chat("anthropic/blind", false)] });
    expect(reader()).not.toBe(reader());
    expect(reader().kind).toBe(reader().kind);
  });
});
