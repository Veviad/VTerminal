import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({ save: vi.fn(() => Promise.resolve()) }),
}));

const { VisionSection } = await import("../components/settings/VisionSection");
const { accelerationStatusText } = await import("../components/settings/AccelerationStatus");
const { useAppStore } = await import("../stores/appStore");

beforeEach(() => {
  useAppStore.setState({
    visionCatalog: [
      {
        id: "vision/qwen3-vl-4b",
        label: "Qwen Vision",
        description: "Local image reader",
        repo_id: "veviad/vision",
        filename: "vision.gguf",
        size_bytes: 2_000_000_000,
        mmproj_filename: "mmproj.gguf",
        mmproj_size_bytes: 1_000_000_000,
        min_ram_gb: 6,
        context_tokens: 4096,
        arch: "qwen3_vl",
        default_prompt: "Describe the image",
        total_bytes: 3_000_000_000,
        fits: true,
        required_ram_gb: 6,
        downloaded: true,
        selected: true,
      },
    ],
    visionModelId: "vision/qwen3-vl-4b",
    visionLoadedModelId: "vision/qwen3-vl-4b",
    visionState: "ready",
    visionLoadError: null,
    visionAcceleration: {
      backend: "cpu",
      device_name: "Core Ultra",
      device_memory_bytes: 4_000_000_000,
      fallback_reason: "Vulkan model allocation failed",
    },
    downloads: {},
    catalog: [],
  });
});

describe("vision accelerator status", () => {
  it("shows the vision host device, memory, and degraded CPU fallback", () => {
    render(<VisionSection />);

    expect(
      screen.getByText(
        "Vision inference: CPU · Core Ultra · 4.0 GB device memory. Vulkan model allocation failed",
      ),
    ).toBeInTheDocument();
  });

  it("distinguishes active MTP from a standard-decoding fallback", () => {
    expect(
      accelerationStatusText("Chat inference", {
        backend: "metal",
        device_name: null,
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "mtp",
        generation_fallback_reason: null,
      }),
    ).toBe("Chat inference: METAL · MTP active");
    expect(
      accelerationStatusText("Chat inference", {
        backend: "vulkan",
        device_name: "RTX",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "standard",
        generation_fallback_reason: "MTP drafter could not load",
      }),
    ).toBe("Chat inference: VULKAN · RTX · standard decoding. MTP drafter could not load");
  });
});
