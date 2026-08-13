import { describe, expect, it } from "vitest";
import { sanitizeExternalWebUrl } from "../lib/externalUrl";

describe("sanitizeExternalWebUrl", () => {
  it.each([
    ["https://example.com/docs?q=terminal#links", "https://example.com/docs?q=terminal#links"],
    ["HTTP://EXAMPLE.COM", "http://example.com/"],
  ])("allows an absolute HTTP(S) URL", (candidate, expected) => {
    expect(sanitizeExternalWebUrl(candidate)).toBe(expected);
  });

  it.each([
    "/etc/passwd",
    "../../secrets.txt",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,secret",
    "mailto:user@example.com",
    "tel:+123456789",
    "//example.com/path",
    "https://",
    "not a URL",
  ])("rejects a path, unsafe scheme, or malformed URL: %s", (candidate) => {
    expect(sanitizeExternalWebUrl(candidate)).toBeNull();
  });
});
