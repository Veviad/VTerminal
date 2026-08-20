import { describe, expect, it } from "vitest";
import { terminalClipboardAction } from "../lib/termRegistry";

const event = (
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("terminalClipboardAction", () => {
  it("reserves Windows Ctrl+Shift+C even when there is no selection", () => {
    expect(
      terminalClipboardAction(event("C", { ctrlKey: true, shiftKey: true }), true, false),
    ).toBe("copy");
  });

  it("uses Ctrl+Shift+V for Windows paste", () => {
    expect(
      terminalClipboardAction(event("V", { ctrlKey: true, shiftKey: true }), true, false),
    ).toBe("paste");
  });

  it("leaves Windows Ctrl+C and Ctrl+V with WSL", () => {
    expect(terminalClipboardAction(event("c", { ctrlKey: true }), true, true)).toBeNull();
    expect(terminalClipboardAction(event("v", { ctrlKey: true }), true, true)).toBeNull();
  });

  it("preserves macOS selection-copy behavior", () => {
    const commandC = event("c", { metaKey: true });
    expect(terminalClipboardAction(commandC, false, true)).toBe("copy");
    expect(terminalClipboardAction(commandC, false, false)).toBeNull();
  });
});
