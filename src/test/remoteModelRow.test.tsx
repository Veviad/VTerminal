import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelRow } from "../components/settings/ModelRow";
import { useAppStore } from "../stores/appStore";
import { S } from "../lib/strings";
import type { CatalogEntry } from "../lib/types";

// A remote model row is defined by what goes QUIET: four `entry.local`-keyed
// branches (size, download, load/unload, delete) plus the effort picker and the
// tier badge. Cheap to pin in one pure render, and the exact risk profile of the
// remote-server change.
//
// No IPC mock: nothing invokes Tauri during render, only in event handlers.

function remoteEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "remote/srv-1/qwen3:8b",
    provider: "remote",
    tier: "balanced",
    label: "Qwen3 8B",
    description: "Ollama · Workstation · http://10.0.0.5:11434",
    wire_model: "qwen3:8b",
    context_tokens: 40_960,
    // No rungs: EffortPicker self-hides.
    efforts: [],
    default_effort: "off",
    supports_temperature: true,
    supports_tools: true,
    native_web_search: false,
    native_web_fetch: false,
    supports_vision: false,
    local: null,
    remote: {
      server_id: "srv-1",
      server_label: "Workstation",
      kind: "ollama",
      supports_tools: true,
    },
    fits: true,
    downloaded: false,
    configured: true,
    effort: "off",
    ...over,
  };
}

describe("ModelRow for a remote model", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeModelId: "local/qwen3.5-9b",
      loadedModelId: null,
      modelState: "idle",
      modelAvailable: true,
      modelEffort: {},
      downloads: {},
      hasApiKey: {},
    });
  });

  it("offers Use, and nothing that belongs to an on-device model", () => {
    render(<ModelRow entry={remoteEntry()} />);
    const use = screen.getByRole("button", { name: S.settings.models.select });
    // Ready without a load and without a key — the whole point.
    expect(use).not.toBeDisabled();
    for (const gone of [
      S.settings.models.download,
      S.settings.models.load,
      S.settings.models.unload,
      S.settings.models.delete,
    ]) {
      expect(screen.queryByRole("button", { name: gone })).toBeNull();
    }
  });

  it("never says to add a key", () => {
    // There is no API-key field for a remote row, so that advice would name a fix
    // the user cannot perform. Also checked with `configured` deliberately wrong.
    render(<ModelRow entry={remoteEntry({ configured: false })} />);
    expect(screen.queryByText(new RegExp(S.settings.models.needsKey))).toBeNull();
  });

  it("hides the effort picker and the tier badge", () => {
    render(<ModelRow entry={remoteEntry()} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText(S.settings.models.tier.balanced)).toBeNull();
  });

  it("shows the wire model, which the label hides", () => {
    render(<ModelRow entry={remoteEntry()} />);
    expect(screen.getByText(/qwen3:8b/)).toBeTruthy();
    expect(screen.getByText(/41K/)).toBeTruthy();
  });

  it("warns when the server reported no tool calling", () => {
    render(
      <ModelRow
        entry={remoteEntry({
          remote: {
            server_id: "srv-1",
            server_label: "Workstation",
            kind: "ollama",
            supports_tools: false,
          },
        })}
      />,
    );
    expect(screen.getByText(new RegExp(S.settings.remoteServers.noToolsTag))).toBeTruthy();
  });
});
