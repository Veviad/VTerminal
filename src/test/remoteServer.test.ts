import { describe, expect, it } from "vitest";
import {
  KIND_EXAMPLE_URL,
  normalizeBaseUrl,
  previewProbeRequest,
  REMOTE_KINDS,
  validateRemoteServer,
} from "../lib/remoteServer";
import type { RemoteServerInput, RemoteServerKind } from "../lib/types";

function server(over: Partial<RemoteServerInput> = {}): RemoteServerInput {
  return { kind: "ollama", label: "Workstation", base_url: "http://localhost:11434", ...over };
}

const fieldsWithErrors = (s: RemoteServerInput) => validateRemoteServer(s).map((e) => e.field);
const messageFor = (s: RemoteServerInput, field: keyof RemoteServerInput) =>
  validateRemoteServer(s).find((e) => e.field === field)?.message ?? "";

describe("validateRemoteServer", () => {
  it("accepts a well-formed server of every kind", () => {
    for (const kind of REMOTE_KINDS) {
      const s = server({ kind, base_url: KIND_EXAMPLE_URL[kind] });
      expect(validateRemoteServer(s), kind).toEqual([]);
    }
  });

  it("requires a label and caps its length", () => {
    expect(fieldsWithErrors(server({ label: "   " }))).toContain("label");
    expect(fieldsWithErrors(server({ label: "x".repeat(65) }))).toContain("label");
    expect(fieldsWithErrors(server({ label: "x".repeat(64) }))).toEqual([]);
  });

  it("requires an address", () => {
    expect(fieldsWithErrors(server({ base_url: "  " }))).toContain("base_url");
  });

  // `new URL("localhost:11434")` parses rather than throwing — as scheme
  // `localhost:` with pathname `11434` — so testing the scheme after parsing
  // would report a problem the user does not have.
  it("names the missing scheme, not something else", () => {
    for (const base_url of ["localhost:11434", "192.168.1.5:1234", "myhost"]) {
      expect(messageFor(server({ base_url }), "base_url"), base_url).toMatch(/http:\/\//);
    }
  });

  it("rejects schemes it cannot speak", () => {
    for (const base_url of ["ftp://host", "file:///etc/passwd", "ws://host:1234"]) {
      expect(fieldsWithErrors(server({ base_url })), base_url).toContain("base_url");
    }
  });

  it("keeps credentials out of the address", () => {
    const message = messageFor(server({ base_url: "http://user:pw@host:11434" }), "base_url");
    expect(message).toMatch(/token field/);
  });

  it("rejects a query string or fragment", () => {
    expect(fieldsWithErrors(server({ base_url: "http://host:11434?key=abc" }))).toContain(
      "base_url",
    );
    expect(fieldsWithErrors(server({ base_url: "http://host:11434#x" }))).toContain("base_url");
  });

  it("rejects an address that already carries the API path", () => {
    // The backend appends `/v1/models`, so these would request `/v1/v1/models`
    // and 404 in a way that reads exactly like the server being down.
    for (const base_url of [
      "http://host:1234/v1",
      "http://host:1234/v1/",
      "http://host:1234/v1/models",
      "http://host:1234/v1/chat/completions",
      "http://host:11434/api/tags",
    ]) {
      expect(messageFor(server({ base_url }), "base_url"), base_url).toMatch(/added automatically/);
    }
  });

  it("accepts a non-API path prefix", () => {
    // A LiteLLM behind a reverse proxy. A prefix is legitimate; only a path
    // ending in an API route is the mistake.
    expect(
      validateRemoteServer(
        server({ kind: "openai_compatible", base_url: "https://gw.example.com/llm" }),
      ),
    ).toEqual([]);
  });

  it("rejects control characters", () => {
    expect(fieldsWithErrors(server({ label: "bad\nlabel" }))).toContain("label");
    expect(fieldsWithErrors(server({ base_url: "http://host:11434" }))).toContain("base_url");
  });

  it("rejects an unknown kind", () => {
    expect(fieldsWithErrors(server({ kind: "lm_studio" as RemoteServerKind }))).toContain("kind");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes, a /v1 suffix and a default port", () => {
    expect(normalizeBaseUrl("http://host:11434/")).toBe("http://host:11434");
    expect(normalizeBaseUrl("http://host:1234/v1")).toBe("http://host:1234");
    expect(normalizeBaseUrl("  http://HOST:11434  ")).toBe("http://host:11434");
    // `url.host` drops a scheme-default port, which is the canonical spelling.
    expect(normalizeBaseUrl("http://host:80")).toBe("http://host");
    expect(normalizeBaseUrl("https://gw.example.com/llm/")).toBe("https://gw.example.com/llm");
  });

  it("returns unparseable input untouched rather than throwing", () => {
    // The form calls this while the user is still typing.
    expect(normalizeBaseUrl("localhost:11434")).toBe("localhost:11434");
    expect(normalizeBaseUrl("  ")).toBe("");
  });

  // The pairing that breaks silently when someone later tightens the validator.
  const FIXTURES = [
    "http://localhost:11434",
    "http://host:1234/v1",
    "https://gw.example.com/llm/",
    "http://host:80",
    "http://[::1]:11434",
  ];

  it.each(FIXTURES)("is idempotent for %s", (raw) => {
    const once = normalizeBaseUrl(raw);
    expect(normalizeBaseUrl(once)).toBe(once);
  });

  it.each(FIXTURES)("never turns a valid address into an invalid one: %s", (raw) => {
    const before = validateRemoteServer(server({ base_url: raw }));
    if (before.length > 0) return;
    expect(validateRemoteServer(server({ base_url: normalizeBaseUrl(raw) }))).toEqual([]);
  });
});

describe("previewProbeRequest", () => {
  it("shows the exact request Test will send", () => {
    expect(previewProbeRequest(server({ base_url: "localhost:11434" }))).toBe(
      "GET localhost:11434/v1/models",
    );
    expect(previewProbeRequest(server({ base_url: "http://host:1234/v1" }))).toBe(
      "GET http://host:1234/v1/models",
    );
  });

  it("is empty with no address, so the form shows nothing rather than a stub", () => {
    expect(previewProbeRequest(server({ base_url: "" }))).toBe("");
  });
});
