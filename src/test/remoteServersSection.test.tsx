import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RemoteProbeResult, RemoteServer } from "../lib/types";
import { S } from "../lib/strings";

// The add → probe → pick sequence, which nothing else covers: the pure validator
// has its own tests and ModelRow has its own, but the wiring between them only
// exists here.
//
// This is the first test in the repo to mock the IPC layer. It has to: unlike
// AiPanel, this component calls `remote_servers_list` from a mount effect. The
// single-chokepoint design in lib/tauri.ts is what makes it one `vi.mock`.

const listed = vi.fn<() => Promise<RemoteServer[]>>();
const created = vi.fn<(...a: unknown[]) => Promise<string>>();
const probed = vi.fn<(id: string) => Promise<RemoteProbeResult>>();
const setModels = vi.fn<(...a: unknown[]) => Promise<void>>();

vi.mock("../lib/tauri", () => ({
  remoteServersList: () => listed(),
  remoteServersCreate: (...a: unknown[]) => created(...a),
  remoteServersUpdate: vi.fn(() => Promise.resolve()),
  remoteServersDelete: vi.fn(() => Promise.resolve()),
  remoteServersSetApiKey: vi.fn(() => Promise.resolve()),
  remoteServersProbe: (id: string) => probed(id),
  remoteServersSetModels: (...a: unknown[]) => setModels(...a),
  // Reached through selectModel.refreshModels after every mutation.
  modelsCatalog: vi.fn(() => Promise.resolve([])),
  modelStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: true })),
  getSettings: vi.fn(() => Promise.resolve({ active_model_id: "local/qwen3.5-9b" })),
  setModelEffort: vi.fn(() => Promise.resolve()),
  modelsDownload: vi.fn(() => Promise.resolve()),
  modelUnload: vi.fn(() => Promise.resolve()),
  modelsDelete: vi.fn(() => Promise.resolve()),
  saveSettings: vi.fn(() => Promise.resolve()),
  modelLoad: vi.fn(() => Promise.resolve()),
}));

const { RemoteServersSection } = await import("../components/settings/RemoteServersSection");

const server: RemoteServer = {
  id: "srv-1",
  kind: "ollama",
  label: "Workstation",
  base_url: "http://10.0.0.5:11434",
  has_api_key: false,
  models: [],
};

function probeResult(over: Partial<RemoteProbeResult> = {}): RemoteProbeResult {
  return {
    base_url: server.base_url,
    endpoint: `${server.base_url}/v1/models`,
    models: [
      {
        wire_model: "qwen3:8b",
        label: "qwen3:8b",
        context_tokens: 262_144,
        supports_vision: false,
        supports_tools: true,
        enriched: true,
        role: "chat",
        state: null,
        already_enabled: false,
      },
      {
        wire_model: "nomic-embed-text",
        label: "nomic-embed-text",
        context_tokens: 4096,
        supports_vision: false,
        supports_tools: false,
        enriched: false,
        role: "embedding",
        state: null,
        already_enabled: false,
      },
    ],
    warnings: [],
    ...over,
  };
}

describe("RemoteServersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listed.mockResolvedValue([]);
  });

  it("shows the empty state before anything is configured", async () => {
    render(<RemoteServersSection />);
    expect(await screen.findByText(S.settings.remoteServers.empty)).toBeTruthy();
    // Nothing is contacted until Test — the mount must not probe.
    expect(probed).not.toHaveBeenCalled();
  });

  it("refuses to save an address with no scheme, then saves once fixed", async () => {
    created.mockResolvedValue("srv-2");
    render(<RemoteServersSection />);
    fireEvent.click(await screen.findByText(S.settings.remoteServers.add));

    fireEvent.change(screen.getByPlaceholderText("Workstation"), {
      target: { value: "Studio" },
    });
    const url = screen.getByPlaceholderText("http://localhost:11434");
    fireEvent.change(url, { target: { value: "localhost:11434" } });
    fireEvent.click(screen.getByText(S.settings.remoteServers.save));

    // The half-parsing input: an inline error naming the real problem, no write.
    expect(await screen.findByText(/http:\/\//)).toBeTruthy();
    expect(created).not.toHaveBeenCalled();

    fireEvent.change(url, { target: { value: "http://localhost:11434/" } });
    fireEvent.click(screen.getByText(S.settings.remoteServers.save));
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    // Normalized before sending, so the stored value matches the preview.
    expect(created).toHaveBeenCalledWith(
      { kind: "ollama", label: "Studio", base_url: "http://localhost:11434" },
      null,
    );
  });

  it("surfaces a probe failure beside the server and clears the spinner", async () => {
    listed.mockResolvedValue([server]);
    probed.mockRejectedValue("could not reach http://10.0.0.5:11434 — check the address");
    render(<RemoteServersSection />);
    fireEvent.click(await screen.findByText(S.settings.remoteServers.test));

    expect(await screen.findByText(/could not reach/)).toBeTruthy();
    // Still the list, not a half-open picker.
    expect(screen.getByText(S.settings.remoteServers.test)).toBeTruthy();
  });

  it("pre-checks the chat model, leaves the embedder alone, and saves what is ticked", async () => {
    listed.mockResolvedValue([server]);
    probed.mockResolvedValue(probeResult());
    setModels.mockResolvedValue(undefined);
    render(<RemoteServersSection />);
    fireEvent.click(await screen.findByText(S.settings.remoteServers.test));

    // A regex, not the exact string: the count line is one <p> reading
    // "2 reported · 1 enabled", so an exact match tests the whole element.
    await screen.findByText(/1 enabled/);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);

    fireEvent.click(screen.getByText(S.settings.remoteServers.pickSave));
    await waitFor(() => expect(setModels).toHaveBeenCalledTimes(1));
    // Probe-only fields are stripped: what is stored is a RemoteModel.
    expect(setModels).toHaveBeenCalledWith("srv-1", [
      {
        wire_model: "qwen3:8b",
        label: "qwen3:8b",
        context_tokens: 262_144,
        supports_vision: false,
        supports_tools: true,
      },
    ]);
  });

  it("lets an empty selection through, so a server can be turned off", async () => {
    // Unticking everything is the ONLY way to disable a server without removing
    // it, which is why Save is not disabled at zero.
    listed.mockResolvedValue([server]);
    probed.mockResolvedValue(probeResult());
    setModels.mockResolvedValue(undefined);
    render(<RemoteServersSection />);
    fireEvent.click(await screen.findByText(S.settings.remoteServers.test));

    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByText(S.settings.remoteServers.pickSave));
    await waitFor(() => expect(setModels).toHaveBeenCalledWith("srv-1", []));
  });

  it("shows a probe's warnings without hiding the list", async () => {
    listed.mockResolvedValue([server]);
    probed.mockResolvedValue(
      probeResult({ warnings: ["this server did not answer /api/v0/models"] }),
    );
    render(<RemoteServersSection />);
    fireEvent.click(await screen.findByText(S.settings.remoteServers.test));
    expect(await screen.findByText(/did not answer/)).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});
