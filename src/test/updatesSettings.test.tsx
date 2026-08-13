import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { S } from "../lib/strings";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";

const saveSettings = vi.fn<(patch: unknown) => Promise<void>>(() => Promise.resolve());

vi.mock("../lib/tauri", () => ({
  saveSettings: (patch: unknown) => saveSettings(patch),
  getSettings: vi.fn(() => Promise.resolve({})),
  updateCheck: vi.fn(() => Promise.resolve(null)),
  updateInstall: vi.fn(() => Promise.resolve()),
  appRestart: vi.fn(() => Promise.resolve()),
  modelsCatalog: vi.fn(() => Promise.resolve([])),
  modelStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: true })),
  getModelEffort: vi.fn(() => Promise.resolve({})),
  visionCatalog: vi.fn(() => Promise.resolve([])),
  visionStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: false })),
  remoteServersList: vi.fn(() => Promise.resolve([])),
  setModelEffort: vi.fn(() => Promise.resolve()),
  modelUnload: vi.fn(() => Promise.resolve()),
  archiveClear: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

const { SettingsPage } = await import("../components/settings/SettingsPage");
const { useAppStore } = await import("../stores/appStore");

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ autoUpdateEnabled: false });
  useUpdateStore.setState({ ...initialUpdateState });
  useUpdateStore.setState({ workspaceReady: true });
});

describe("Updates settings", () => {
  it("is reachable as its own tab and visibly experimental", () => {
    render(<SettingsPage />);
    const tab = screen.getByRole("button", { name: S.settings.tabs.updates });
    fireEvent.click(tab);
    expect(screen.getByText(S.settings.updates.experimental)).toBeInTheDocument();
    expect(screen.getByText(S.settings.updates.channelValue)).toBeInTheDocument();
    expect(screen.getByText(__APP_VERSION__)).toBeInTheDocument();
  });

  it("defaults off and persists the opt-in key", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: S.settings.tabs.updates }));
    const toggle = screen.getByRole("switch", { name: S.settings.updates.automatic });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({ auto_update_enabled: true }),
    );
  });
});
