import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSystemInfo: vi.fn(),
  loadSettings: vi.fn(),
  createSession: vi.fn(),
  restoreSessions: vi.fn(),
  modelsCatalog: vi.fn(),
  getModelEffort: vi.fn(),
  modelStatus: vi.fn(),
  workspaceMarkHealthy: vi.fn(),
  appQuitForce: vi.fn(),
  startPersistence: vi.fn(),
  warmStart: vi.fn(),
  quitHandler: null as ((event: { payload: { token: number } }) => void) | null,
  unlistenQuit: vi.fn(),
}));

vi.mock("../lib/platform", () => ({
  desktopPlatform: () => "windows",
  isWindows: () => true,
  defaultShell: () => "/bin/bash",
  localOsLabel: () => "Windows 11 (WSL2)",
  shortcutGlyph: (key: string) => `Ctrl+Shift+${key}`,
}));
vi.mock("../components/layout/AppShell", () => ({
  AppShell: () => <div data-testid="app-shell" />,
}));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({ loadSettings: mocks.loadSettings }),
}));
vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({
    createSession: mocks.createSession,
    restoreSessions: mocks.restoreSessions,
  }),
}));
vi.mock("../hooks/useAutoUpdater", () => ({ useAutoUpdater: () => {} }));
vi.mock("../lib/applyTheme", () => ({ applyTheme: vi.fn() }));
vi.mock("../lib/termRegistry", () => ({ updateAllTermOptions: vi.fn() }));
vi.mock("../lib/sessionPersistence", () => ({
  startPersistence: mocks.startPersistence,
}));
vi.mock("../lib/selectModel", () => ({ warmStart: mocks.warmStart }));
vi.mock("../lib/tauri", () => ({
  getSystemInfo: mocks.getSystemInfo,
  modelsCatalog: mocks.modelsCatalog,
  getModelEffort: mocks.getModelEffort,
  modelStatus: mocks.modelStatus,
  workspaceMarkHealthy: mocks.workspaceMarkHealthy,
  appQuitForce: mocks.appQuitForce,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: { token: number } }) => void) => {
    mocks.quitHandler = handler;
    return mocks.unlistenQuit;
  }),
}));

const { default: App } = await import("../App");
const { useAppStore } = await import("../stores/appStore");
const { initialUpdateState, useUpdateStore } = await import("../stores/updateStore");

const systemInfo = (wslStatus: string) => ({
  total_ram_bytes: 16_000_000_000,
  os: "windows",
  arch: "x86_64",
  terminal_backend: "wsl_conpty",
  shell_family: "bash",
  wsl_status: wslStatus,
  wsl_distribution: wslStatus === "missing" ? null : "Ubuntu",
  local_acceleration: {
    backend: "cpu",
    device_name: "CPU",
    device_memory_bytes: null,
    fallback_reason: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateStore.setState({ ...initialUpdateState });
  useAppStore.setState({ sessions: [], settingsLoaded: false, theme: "vterminal-dark" });
  mocks.loadSettings.mockResolvedValue({ theme: "vterminal-dark" });
  mocks.restoreSessions.mockResolvedValue(0);
  mocks.createSession.mockResolvedValue("session-1");
  mocks.modelsCatalog.mockResolvedValue([]);
  mocks.getModelEffort.mockResolvedValue({});
  mocks.modelStatus.mockResolvedValue({ loaded: null, state: "idle", available: false });
  mocks.workspaceMarkHealthy.mockResolvedValue(undefined);
  mocks.appQuitForce.mockResolvedValue(undefined);
  mocks.warmStart.mockResolvedValue(undefined);
  mocks.quitHandler = null;
});

describe("Windows startup prerequisite gate", () => {
  it("does not mount AppShell or create a session while the WSL probe is pending", async () => {
    let resolveInfo: ((value: ReturnType<typeof systemInfo>) => void) | undefined;
    mocks.getSystemInfo.mockReturnValue(
      new Promise((resolve) => {
        resolveInfo = resolve;
      }),
    );

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking WSL 2 prerequisites");
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(mocks.createSession).not.toHaveBeenCalled();

    await act(async () => resolveInfo?.(systemInfo("ready")));
    await waitFor(() => expect(screen.getByTestId("app-shell")).toBeInTheDocument());
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.unlistenQuit).toHaveBeenCalledTimes(1));
  });

  it("keeps the application shell unmounted when WSL is unavailable", async () => {
    mocks.getSystemInfo.mockResolvedValue(systemInfo("missing"));
    render(<App />);

    expect(await screen.findByText("WSL 2 and Bash are required")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("acknowledges a native quit immediately while prerequisites block persistence", async () => {
    mocks.getSystemInfo.mockResolvedValue(systemInfo("missing"));
    render(<App />);
    await screen.findByText("WSL 2 and Bash are required");
    await waitFor(() => expect(mocks.quitHandler).not.toBeNull());

    act(() => mocks.quitHandler?.({ payload: { token: 41 } }));

    await waitFor(() =>
      expect(mocks.appQuitForce).toHaveBeenCalledWith(
        41,
        "Windows prerequisites are unavailable",
      ),
    );
    expect(mocks.startPersistence).not.toHaveBeenCalled();
  });
});
