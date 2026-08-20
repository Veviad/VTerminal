import { describe, expect, it } from "vitest";
import { matchesReserved } from "../lib/keymap";

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
