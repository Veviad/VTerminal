import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  windows: true,
  windowsTerminalPrepare: vi.fn(),
  applyTheme: vi.fn(),
  initializeChat: vi.fn(),
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
  isWindows: () => mocks.windows,
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
vi.mock("../lib/applyTheme", () => ({ applyTheme: mocks.applyTheme }));
vi.mock("../stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({ initialize: mocks.initializeChat }),
    setState: vi.fn(),
  },
}));
vi.mock("../lib/termRegistry", () => ({ updateAllTermOptions: vi.fn() }));
vi.mock("../lib/sessionPersistence", () => ({
  startPersistence: mocks.startPersistence,
}));
vi.mock("../lib/selectModel", () => ({ warmStart: mocks.warmStart }));
vi.mock("../lib/tauri", () => ({
  windowsTerminalPrepare: mocks.windowsTerminalPrepare,
  mcpServersList: vi.fn(async () => []),
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
  wsl_status: wslStatus,
  wsl_distribution: wslStatus === "missing" ? null : "Ubuntu",
  message: null as string | null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows = true;
  useUpdateStore.setState({ ...initialUpdateState });
  useAppStore.setState({ sessions: [], settingsLoaded: false, theme: "vterminal-dark" });
  mocks.loadSettings.mockResolvedValue({ theme: "vterminal-dark" });
  mocks.initializeChat.mockResolvedValue(undefined);
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
    mocks.windowsTerminalPrepare.mockReturnValue(
      new Promise((resolve) => {
        resolveInfo = resolve;
      }),
    );

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Starting your terminal");
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.windowsTerminalPrepare).toHaveBeenCalledWith(false);
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.applyTheme).toHaveBeenCalledWith("vterminal-dark"));
    expect(mocks.startPersistence).not.toHaveBeenCalled();

    await act(async () => resolveInfo?.(systemInfo("ready")));
    await waitFor(() => expect(screen.getByTestId("app-shell")).toBeInTheDocument());
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.unlistenQuit).toHaveBeenCalledTimes(1));
  });

  it("keeps the application shell unmounted when WSL is unavailable", async () => {
    mocks.windowsTerminalPrepare.mockResolvedValue(systemInfo("missing"));
    render(<App />);

    expect(await screen.findByText("WSL 2 and Bash are required")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("acknowledges a native quit immediately while prerequisites block persistence", async () => {
    mocks.windowsTerminalPrepare.mockResolvedValue(systemInfo("missing"));
    render(<App />);
    await screen.findByText("WSL 2 and Bash are required");
    await waitFor(() => expect(mocks.quitHandler).not.toBeNull());

    act(() => mocks.quitHandler?.({ payload: { token: 41 } }));

    await waitFor(() =>
      expect(mocks.appQuitForce).toHaveBeenCalledWith(
        41,
        "Windows workspace startup has not completed",
      ),
    );
    expect(mocks.startPersistence).not.toHaveBeenCalled();
  });

  it("retries failed preparation and restores the workspace exactly once", async () => {
    let finishRetry: ((value: ReturnType<typeof systemInfo>) => void) | undefined;
    mocks.windowsTerminalPrepare
      .mockResolvedValueOnce({ ...systemInfo("error"), message: "WSL startup timed out." })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    mocks.restoreSessions.mockResolvedValue(3);

    render(<App />);
    expect(await screen.findByText("WSL startup timed out.")).toBeInTheDocument();
    expect(screen.getByRole("heading")).toHaveTextContent("Your terminal could not start");
    expect(mocks.restoreSessions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("status")).toHaveTextContent("Starting your terminal");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.windowsTerminalPrepare).toHaveBeenCalledWith(true));
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
    expect(mocks.restoreSessions).not.toHaveBeenCalled();

    await act(async () => finishRetry?.(systemInfo("ready")));
    await waitFor(() => expect(mocks.startPersistence).toHaveBeenCalledTimes(1));
    expect(mocks.restoreSessions).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.initializeChat).toHaveBeenCalledTimes(1);
    expect(mocks.windowsTerminalPrepare).toHaveBeenCalledTimes(2);
  });

  it("offers retry after an IPC failure", async () => {
    mocks.windowsTerminalPrepare
      .mockRejectedValueOnce(new Error("WSL could not start"))
      .mockResolvedValueOnce(systemInfo("ready"));
    render(<App />);
    expect(await screen.findByText("Error: WSL could not start")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate preparation or restoration under StrictMode", async () => {
    mocks.windowsTerminalPrepare.mockResolvedValue(systemInfo("ready"));
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(mocks.startPersistence).toHaveBeenCalledTimes(1));
    expect(mocks.windowsTerminalPrepare).toHaveBeenCalledTimes(1);
    expect(mocks.loadSettings).toHaveBeenCalledTimes(1);
    expect(mocks.restoreSessions).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("waits for settings before admitting terminal actions", async () => {
    let finishSettings: ((value: { theme: string }) => void) | undefined;
    mocks.loadSettings.mockImplementation(() => new Promise((resolve) => { finishSettings = resolve; }));
    mocks.windowsTerminalPrepare.mockResolvedValue(systemInfo("ready"));
    render(<App />);
    await act(async () => {});
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(mocks.restoreSessions).not.toHaveBeenCalled();
    await act(async () => finishSettings?.({ theme: "vterminal-dark" }));
    await waitFor(() => expect(mocks.startPersistence).toHaveBeenCalledTimes(1));
  });

  it("starts the Mac workspace without invoking Windows preparation", async () => {
    mocks.windows = false;
    render(<App />);
    await waitFor(() => expect(mocks.startPersistence).toHaveBeenCalledTimes(1));
    expect(mocks.windowsTerminalPrepare).not.toHaveBeenCalled();
    expect(mocks.restoreSessions).toHaveBeenCalledTimes(1);
    expect(mocks.warmStart).toHaveBeenCalledTimes(1);
  });

  it("keeps quit acknowledgement available while restored shells are starting", async () => {
    let finishRestore: ((value: number) => void) | undefined;
    mocks.windowsTerminalPrepare.mockResolvedValue(systemInfo("ready"));
    mocks.restoreSessions.mockImplementation(() => new Promise((resolve) => { finishRestore = resolve; }));
    render(<App />);
    await waitFor(() => expect(mocks.restoreSessions).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(mocks.unlistenQuit).not.toHaveBeenCalled();
    act(() => mocks.quitHandler?.({ payload: { token: 42 } }));
    await waitFor(() => expect(mocks.appQuitForce).toHaveBeenCalledWith(42, "Windows workspace startup has not completed"));
    await act(async () => finishRestore?.(1));
    await waitFor(() => expect(mocks.unlistenQuit).toHaveBeenCalledTimes(1));
  });
});
