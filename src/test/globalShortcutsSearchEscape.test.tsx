import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTerm: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({ createSession: vi.fn(), closeSession: vi.fn() }),
}));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ save: vi.fn() }) }));
vi.mock("../lib/termRegistry", () => ({ getTerm: mocks.getTerm }));
vi.mock("../lib/tauri", () => ({ aiCancel: vi.fn() }));
vi.mock("../lib/aiPanel", () => ({ toggleAiPanel: vi.fn() }));

import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";
import { useAppStore } from "../stores/appStore";

function Harness() {
  useGlobalShortcuts();
  return null;
}

let textarea: HTMLTextAreaElement;
beforeEach(() => {
  vi.clearAllMocks();
  textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  mocks.getTerm.mockReturnValue({ term: { textarea, focus: mocks.focus } });
  useAppStore.setState({
    activeSessionId: "local",
    sessions: [{ id: "local" } as never],
    sessionUi: { local: { searchOpen: true } as never },
    paletteOpen: false,
    sessionBrowserOpen: false,
  });
});
afterEach(() => textarea.remove());

describe("terminal search Escape", () => {
  it("closes search before xterm receives Escape when the terminal has focus", () => {
    render(<Harness />);
    const ptyKeydown = vi.fn();
    textarea.addEventListener("keydown", ptyKeydown);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => textarea.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(ptyKeydown).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessionUi.local.searchOpen).toBe(false);
  });

  it("still forwards Escape to terminal programs when search is closed", () => {
    useAppStore.getState().updateSessionUi("local", { searchOpen: false });
    render(<Harness />);
    const ptyKeydown = vi.fn();
    textarea.addEventListener("keydown", ptyKeydown);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => textarea.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(ptyKeydown).toHaveBeenCalledOnce();
  });

  it("consumes Escape repeats until release after closing search", () => {
    render(<Harness />);
    const ptyKeydown = vi.fn();
    textarea.addEventListener("keydown", ptyKeydown);
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    const repeat = new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true, cancelable: true });
    act(() => textarea.dispatchEvent(repeat));
    expect(repeat.defaultPrevented).toBe(true);
    expect(ptyKeydown).not.toHaveBeenCalled();
    act(() => textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true })));
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(ptyKeydown).toHaveBeenCalledOnce();
  });

  it("clears an interrupted Escape when the window loses focus", () => {
    render(<Harness />);
    const ptyKeydown = vi.fn();
    textarea.addEventListener("keydown", ptyKeydown);
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(ptyKeydown).toHaveBeenCalledOnce();
  });
});
