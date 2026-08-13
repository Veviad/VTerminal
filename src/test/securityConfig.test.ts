import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WebView credential boundary", () => {
  const capabilities = JSON.parse(
    readFileSync("src-tauri/capabilities/default.json", "utf8"),
  ) as { permissions: Array<string | { identifier: string }> };
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
    app: { security: { csp: Record<string, string>; devCsp: Record<string, string> } };
  };
  const settingsSource = readFileSync("src-tauri/src/commands/settings.rs", "utf8");

  it("denies raw WebView store operations", () => {
    expect(capabilities.permissions).not.toContain("store:default");
    expect(
      capabilities.permissions.some((permission) =>
        (typeof permission === "string" ? permission : permission.identifier).startsWith(
          "store:",
        ),
      ),
    ).toBe(false);
  });

  it("keeps production CSP local and gives only Vite/HMR a development exception", () => {
    const { csp, devCsp } = config.app.security;
    expect(csp["default-src"]).toContain("'self'");
    expect(csp["connect-src"]).toBe("ipc: http://ipc.localhost");
    expect(csp["object-src"]).toBe("'none'");
    expect(JSON.stringify(csp)).not.toContain("localhost:1420");
    expect(devCsp["connect-src"]).toContain("ws://localhost:1420");
    expect(devCsp["script-src"]).toContain("http://localhost:1420");
  });

  it("returns credential presence and status but no Hugging Face secret", () => {
    const outputBuilder = settingsSource.split("#[allow(clippy::too_many_arguments)]")[0];
    expect(outputBuilder).toContain('"has_hf_token"');
    expect(outputBuilder).toContain('"credential_store_status"');
    expect(outputBuilder).not.toContain('"hf_token"');
  });
});
