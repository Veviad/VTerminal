import { openUrl } from "@tauri-apps/plugin-opener";

import { sanitizeExternalWebUrl } from "../../../lib/externalUrl";
import { AiMessageView } from "../AiMessageView";

const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
];

const AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
];

function jsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Render one MCP content block consistently in Chat, Ask, and Agent. */
export function McpContent({ block }: { block: unknown }) {
  if (!block || typeof block !== "object") {
    return (
      <pre className="max-w-full overflow-auto whitespace-pre-wrap break-all text-[10px] text-text-muted">
        {JSON.stringify(block)}
      </pre>
    );
  }

  const value = block as Record<string, unknown>;
  const type = String(value.type ?? "");
  if (type === "text") {
    const text = String(value.text ?? "");
    const structured = jsonText(text);
    if (structured !== undefined) {
      return (
        <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-secondary">
          {JSON.stringify(structured, null, 2)}
        </pre>
      );
    }
    return (
      <div className="min-w-0 max-w-full overflow-hidden break-words text-[11px] text-text-secondary [overflow-wrap:anywhere]">
        <AiMessageView content={text} origin="literal" />
      </div>
    );
  }

  if (type === "image" && typeof value.data === "string") {
    const mime = String(value.mimeType ?? value.mime_type ?? "image/png");
    if (!IMAGE_TYPES.includes(mime)) {
      return (
        <p className="text-[10px] text-warning">
          Unsupported MCP image type: {mime}
        </p>
      );
    }
    return (
      <img
        className="max-h-64 max-w-full rounded border border-border-subtle"
        src={`data:${mime};base64,${value.data}`}
        alt="MCP tool result"
      />
    );
  }

  if (type === "audio" && typeof value.data === "string") {
    const mime = String(value.mimeType ?? value.mime_type ?? "audio/mpeg");
    if (!AUDIO_TYPES.includes(mime)) {
      return (
        <p className="text-[10px] text-warning">
          Unsupported MCP audio type: {mime}
        </p>
      );
    }
    return (
      <audio
        controls
        src={`data:${mime};base64,${value.data}`}
        className="w-full"
      />
    );
  }

  if (type === "resource_link" && typeof value.uri === "string") {
    const safe = sanitizeExternalWebUrl(value.uri);
    return safe ? (
      <button
        type="button"
        className="max-w-full break-all text-left text-[10px] text-accent underline"
        onClick={() => void openUrl(safe)}
      >
        {String(value.name ?? value.title ?? value.uri)}
      </button>
    ) : (
      <p className="break-all text-[10px] text-text-muted">
        {String(value.name ?? value.title ?? value.uri)}
      </p>
    );
  }

  const resource = value.resource as Record<string, unknown> | undefined;
  if (type === "resource" && resource) {
    return (
      <div className="min-w-0 max-w-full overflow-hidden rounded bg-bg-primary p-2">
        <p className="mb-1 break-all text-[9px] text-text-muted">
          {String(resource.uri ?? "Embedded resource")}
        </p>
        {typeof resource.text === "string" ? (
          <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-all text-[10px] text-text-secondary">
            {resource.text}
          </pre>
        ) : (
          <p className="text-[10px] text-text-muted">
            Embedded binary resource
          </p>
        )}
      </div>
    );
  }

  return (
    <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
