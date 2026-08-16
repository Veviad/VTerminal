import { describe, expect, it } from "vitest";
import {
  bindingsForPlatform,
  matchesReserved,
  matchesReservedForPlatform,
} from "../lib/keymap";

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...init,
  });
}

describe("matchesReserved", () => {
  it("matches cmd+t as new-tab", () => {
    expect(matchesReserved(key({ key: "t", metaKey: true }))?.id).toBe("new-tab");
  });

  it("matches cmd+k as command palette", () => {
    expect(matchesReserved(key({ key: "k", metaKey: true }))?.id).toBe("command-palette");
  });

  it("matches cmd+1..9 tab jumps", () => {
    expect(matchesReserved(key({ key: "3", metaKey: true }))?.id).toBe("goto-tab-3");
    expect(matchesReserved(key({ key: "9", metaKey: true }))?.id).toBe("goto-tab-9");
  });

  it("matches cmd+shift+] as next-tab", () => {
    expect(matchesReserved(key({ key: "]", metaKey: true, shiftKey: true }))?.id).toBe("next-tab");
  });

  it("matches cmd+= and cmd+plus as font-size-up", () => {
    expect(matchesReserved(key({ key: "=", metaKey: true }))?.id).toBe("font-size-up");
  });

  it("does NOT match plain ctrl+c (shell interrupt)", () => {
    expect(matchesReserved(key({ key: "c", ctrlKey: true }))).toBeNull();
  });

  it("does NOT match plain cmd+c (copy handled separately)", () => {
    expect(matchesReserved(key({ key: "c", metaKey: true }))).toBeNull();
  });

  it("does NOT match bare letters", () => {
    expect(matchesReserved(key({ key: "t" }))).toBeNull();
  });

  it("does NOT match cmd+t with extra shift", () => {
    expect(matchesReserved(key({ key: "t", metaKey: true, shiftKey: true }))).toBeNull();
  });
});

describe("Windows bindings", () => {
  it("uses Ctrl+Shift for app actions and leaves Ctrl+C to the terminal", () => {
    const windows = bindingsForPlatform("windows");
    expect(windows.find(({ id }) => id === "new-tab")?.combo).toBe("ctrl+shift+t");
    expect(windows.find(({ id }) => id === "next-tab")?.combo).toBe("ctrl+shift+]");
    expect(windows.some(({ combo }) => combo === "ctrl+c")).toBe(false);
  });

  it("matches shifted number keys by code instead of the resulting symbol", () => {
    expect(
      matchesReservedForPlatform(
        key({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }),
        "windows",
      )?.id,
    ).toBe("goto-tab-1");
    expect(
      matchesReservedForPlatform(
        key({ key: ")", code: "Digit0", ctrlKey: true, shiftKey: true }),
        "windows",
      )?.id,
    ).toBe("font-size-reset");
  });

  it("matches shifted punctuation keys by code", () => {
    const cases = [
      ["}", "BracketRight", "next-tab"],
      ["{", "BracketLeft", "prev-tab"],
      ["+", "Equal", "font-size-up"],
      ["_", "Minus", "font-size-down"],
      ["<", "Comma", "open-settings"],
    ] as const;
    for (const [pressedKey, code, action] of cases) {
      expect(
        matchesReservedForPlatform(
          key({ key: pressedKey, code, ctrlKey: true, shiftKey: true }),
          "windows",
        )?.id,
      ).toBe(action);
    }
  });

  it("keeps plain Ctrl+C and Ctrl+V available to the terminal", () => {
    expect(matchesReservedForPlatform(key({ key: "c", ctrlKey: true }), "windows")).toBeNull();
    expect(matchesReservedForPlatform(key({ key: "v", ctrlKey: true }), "windows")).toBeNull();
  });
});

describe("session browser binding", () => {
  it("binds cmd+y", () => {
    // NOT cmd+h: no custom app menu is installed, so Tauri's default macOS menu
    // owns cmd+h as Hide Application.
    expect(matchesReserved(key({ key: "y", metaKey: true }))?.id).toBe("session-browser");
  });

  it("leaves plain y and ctrl+y to the shell", () => {
    // matchesReserved is what withholds a combo from xterm, so a false positive
    // here would silently break typing.
    expect(matchesReserved(key({ key: "y" }))).toBeNull();
    expect(matchesReserved(key({ key: "y", ctrlKey: true }))).toBeNull();
  });
});
