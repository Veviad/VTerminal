import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Header } from "../components/layout/Header";
import type { CatalogEntry } from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";

vi.mock("../components/layout/TabStrip", () => ({ TabStrip: () => <div data-testid="tabs" /> }));
vi.mock("../components/layout/ModelMenu", () => ({ ModelMenu: () => null }));
vi.mock("../components/layout/VisionMenu", () => ({ VisionMenu: () => null }));
vi.mock("../components/runbooks", () => ({ RunbookStatusIndicator: () => null }));

function localModel(): CatalogEntry {
  return {
    id: "local/qwen-test",
    provider: "local",
    tier: "fast",
    label: "Qwen Test",
    description: "",
    wire_model: "qwen-test",
    context_tokens: 32_000,
    efforts: ["off", "high"],
    default_effort: "high",
    supports_temperature: true,
    supports_tools: true,
    native_web_search: false,
    native_web_fetch: false,
    supports_vision: false,
    local: {
      artifact: { repo_id: "test/qwen", filename: "qwen.gguf", size_bytes: 10 },
      mtp: {
        kind: "embedded",
        legacy: { repo_id: "test/qwen", filename: "legacy.gguf", size_bytes: 9 },
        draft_tokens: 4,
      },
      min_ram_gb: 8,
      family: "qwen",
    },
    remote: null,
    fits: true,
    downloaded: true,
    mtp: { kind: "embedded", state: "ready", download_bytes: 0, disk_delta_bytes: 0, draft_tokens: 4 },
    configured: true,
    effort: "high",
  };
}

describe("Header workspace and generation controls", () => {
  beforeEach(() => {
    const model = localModel();
    useAppStore.setState({
      catalog: [model],
      activeModelId: model.id,
      loadedModelId: model.id,
      modelState: "ready",
      modelAvailable: true,
      localAcceleration: {
        backend: "metal",
        device_name: "Apple GPU",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "mtp",
        generation_fallback_reason: null,
      },
      runbooksEnabled: false,
      settingsOpen: false,
      sessionBrowserOpen: false,
    });
    useChatStore.setState({ workspaceMode: "chat" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("places the workspace selector on the left and switches through a dropdown", () => {
    const switchWorkspace = vi
      .spyOn(useChatStore.getState(), "setWorkspaceMode")
      .mockResolvedValue(undefined);
    render(<Header />);

    const trigger = screen.getByRole("button", { name: "Workspace" });
    const header = screen.getByRole("banner");
    expect(header.children[0]?.contains(trigger)).toBe(true);
    expect(trigger).toHaveTextContent("Chat");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Terminal/ }));
    expect(switchWorkspace).toHaveBeenCalledWith("terminal");
  });

  it("shows when MTP decoding is active", () => {
    render(<Header />);
    expect(screen.getByText("MTP")).toHaveAttribute(
      "title",
      "MTP speculative decoding is active.",
    );
  });

  it("distinguishes standard decoding and explains an MTP fallback", () => {
    useAppStore.setState({
      localAcceleration: {
        backend: "metal",
        device_name: "Apple GPU",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "standard",
        generation_fallback_reason: "MTP initialization failed",
      },
    });
    render(<Header />);
    expect(screen.getByText("Standard")).toHaveAttribute(
      "title",
      "Standard decoding is active: MTP initialization failed",
    );
  });
});
