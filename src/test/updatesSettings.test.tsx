import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { S } from "../lib/strings";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";

const saveSettings = vi.fn<(patch: unknown) => Promise<void>>(() => Promise.resolve());

vi.mock("../lib/tauri", () => ({
  saveSettings: (patch: unknown) => saveSettings(patch),
  getSettings: vi.fn(() => Promise.resolve({})),
  updateCheck: vi.fn(() => Promise.resolve(null)),
  updateDownload: vi.fn(() => Promise.resolve("download-1")),
  updateCancel: vi.fn(() => Promise.resolve()),
  updateApply: vi.fn(() => Promise.resolve()),
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

  it("does not duplicate the update details while the update modal is open", () => {
    const metadata = {
      current_version: "0.4.2",
      version: "0.4.3",
      published_at: "2026-08-24T16:51:09Z",
      prerelease: false,
      notes: "## What's Changed\n\n- Fix update presentation.",
    };
    useUpdateStore.setState({ status: "available", metadata, promptOpen: true });

    const { rerender } = render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: S.settings.tabs.updates }));
    expect(screen.queryByText(S.settings.updates.available(metadata.version))).not.toBeInTheDocument();
    expect(screen.queryByText("What's Changed")).not.toBeInTheDocument();

    useUpdateStore.setState({ promptOpen: false });
    rerender(<SettingsPage />);
    expect(screen.getByText(S.settings.updates.available(metadata.version))).toBeVisible();
    expect(screen.getByRole("heading", { name: "What's Changed", level: 2 })).toBeVisible();
  });
});
