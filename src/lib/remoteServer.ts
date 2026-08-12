/** Remote inference server form rules, as pure functions.
 *
 *  The authoritative copy lives in `commands/remote_servers.rs::validate` and
 *  `models/remote_probe.rs::normalize_base_url` — a record can be hand-edited in
 *  settings.json, and its base URL becomes the host every chat request is sent
 *  to, so this layer is inline-error convenience only.
 */

import type { RemoteServerInput, RemoteServerKind } from "./types";

export const REMOTE_KINDS: RemoteServerKind[] = ["ollama", "lmstudio", "openai_compatible"];

export const KIND_LABELS: Record<RemoteServerKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openai_compatible: "OpenAI-compatible",
};

/** Placeholder and hint only, never a prefilled value. Ports: Ollama 11434, LM
 *  Studio 1234, and vLLM's `--port` default for the generic kind — which the
 *  backend does NOT assume, since llama.cpp-server uses 8080 and LiteLLM 4000. */
export const KIND_EXAMPLE_URL: Record<RemoteServerKind, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  openai_compatible: "http://localhost:8000",
};

export interface RemoteFieldError {
  field: keyof RemoteServerInput;
  message: string;
}

export function validateRemoteServer(s: RemoteServerInput): RemoteFieldError[] {
  const errors: RemoteFieldError[] = [];
  const controlChars = /[\x00-\x1f\x7f]/;

  const label = s.label?.trim() ?? "";
  if (!label) errors.push({ field: "label", message: "A label is required." });
  else if (label.length > 64) errors.push({ field: "label", message: "Max 64 characters." });

  if (!REMOTE_KINDS.includes(s.kind)) {
    errors.push({ field: "kind", message: "Pick a server kind." });
  }

  const raw = s.base_url?.trim() ?? "";
  if (!raw) errors.push({ field: "base_url", message: "A server address is required." });
  else if (raw.length > 512) errors.push({ field: "base_url", message: "Max 512 characters." });
  else errors.push(...validateBaseUrl(raw));

  for (const field of ["label", "base_url"] as const) {
    if (controlChars.test(s[field] ?? "")) {
      errors.push({ field, message: "Control characters aren't allowed." });
    }
  }
  return errors;
}

function validateBaseUrl(raw: string): RemoteFieldError[] {
  // FIRST, before `new URL`. `new URL("localhost:11434")` does NOT throw — it
  // parses as scheme `localhost:` with pathname `11434`, so leaving this test
  // until after would produce a message about the wrong problem entirely.
  if (!/^https?:\/\//i.test(raw)) {
    return [
      {
        field: "base_url",
        message: 'Start with http:// or https:// — for example "http://localhost:11434".',
      },
    ];
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [{ field: "base_url", message: "That is not a valid address." }];
  }

  if (!url.hostname) return [{ field: "base_url", message: "That address has no host." }];
  // `new URL` accepts credentials happily; they would then ride in every request
  // URL and land in logs. Tokens have their own field.
  if (url.username || url.password) {
    return [
      { field: "base_url", message: "Put a token in the token field, not in the address." },
    ];
  }
  if (url.search || url.hash) {
    return [{ field: "base_url", message: "Drop the query string — this is a base address." }];
  }
  if (url.port && !isValidPort(url.port)) {
    return [{ field: "base_url", message: "Port must be between 1 and 65535." }];
  }

  // The commonest paste is the OpenAI-style endpoint, complete with the path the
  // backend appends itself. Left alone it requests `/v1/v1/models` and returns a
  // 404 that reads exactly like the server being down.
  //
  // Note what is NOT rejected: a non-API path prefix (`https://gw.example.com/llm`,
  // a LiteLLM behind a reverse proxy). Only a path ENDING in an API route is the
  // duplication bug.
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/v\d+$/i.test(path) || /\/(v\d+\/)?(chat\/completions|models|api\/tags|api\/chat)$/i.test(path)) {
    return [
      {
        field: "base_url",
        message: "Enter the server address only — the API path is added automatically.",
      },
    ];
  }
  return [];
}

function isValidPort(port: string): boolean {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Canonical stored form: scheme, host, port, non-API path prefix, no trailing
 *  slash and no `/v1`. Idempotent, and a mirror of the Rust normalizer so what
 *  the form previews is what gets stored. `url.host` carries the port and drops a
 *  scheme-default one. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  // The same trap as in `validateBaseUrl`, and it bites harder here: `new URL`
  // reads "localhost:11434" as scheme `localhost:` with pathname `11434`, which
  // this function would then reassemble into "localhost://11434" and preview as a
  // request nobody will ever send. An address the validator rejects is returned
  // untouched instead.
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return trimmed;
  }
}

/** What the form's preview shows: the exact request Test will send. One line, not
 *  two — previewing the chat endpoint as well would mean predicting a path no
 *  button hits. */
export function previewProbeRequest(s: RemoteServerInput): string {
  const base = normalizeBaseUrl(s.base_url ?? "");
  return base ? `GET ${base}/v1/models` : "";
}
