import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(() => Promise.resolve("session-1")),
  closeSession: vi.fn(() => Promise.resolve()),
  save: vi.fn(() => Promise.resolve()),
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({
    createSession: mocks.createSession,
    closeSession: mocks.closeSession,
  }),
}));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({ save: mocks.save }),
}));
vi.mock("../lib/termRegistry", () => ({ getTerm: vi.fn() }));
vi.mock("../lib/tauri", () => ({ aiCancel: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/aiPanel", () => ({ toggleAiPanel: vi.fn() }));

const { useGlobalShortcuts } = await import("../hooks/useGlobalShortcuts");
const { useAppStore } = await import("../stores/appStore");
const { initialUpdateState, useUpdateStore } = await import("../stores/updateStore");

function Harness() {
  useGlobalShortcuts();
  return null;
}

function reservedKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateStore.setState({ ...initialUpdateState });
  useAppStore.setState({ settingsOpen: false, paletteOpen: false, sessions: [] });
});

describe("global shortcut update barrier", () => {
  it("consumes reserved actions without dispatching them during save, apply, or restart", () => {
    render(<Harness />);

    for (const status of ["saving", "installing", "restarting"] as const) {
      useUpdateStore.setState({ status });
      const newTab = reservedKey("t");
      const settings = reservedKey(",");
      expect(newTab.defaultPrevented).toBe(true);
      expect(settings.defaultPrevented).toBe(true);
      expect(mocks.createSession).not.toHaveBeenCalled();
      expect(useAppStore.getState().settingsOpen).toBe(false);
    }

    useUpdateStore.setState({ status: "available" });
    reservedKey("t");
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });
});
