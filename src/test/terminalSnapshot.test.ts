import { describe, expect, it } from "vitest";

import { utf8Tail } from "../lib/terminalSnapshot";

describe("utf8Tail", () => {
  it("caps UTF-8 bytes without splitting a multibyte character", () => {
    const captured = utf8Tail("alpha-€€", 5);
    expect(captured.text).toBe("€");
    expect(captured.observedBytes).toBe(12);
    expect(captured.capturedBytes).toBe(3);
    expect(captured.truncated).toBe(true);
  });

  it("reports a complete capture explicitly", () => {
    expect(utf8Tail("ok", 8)).toEqual({
      text: "ok",
      observedBytes: 2,
      capturedBytes: 2,
      truncated: false,
    });
  });
});
