import { useState } from "react";
import { ChevronDown, ChevronRight, Server } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { sanitizeExternalWebUrl } from "../../lib/externalUrl";
import type { ChatMcpCall } from "../../lib/types";
import { AiMessageView } from "./AiMessageView";

export function McpToolCard({ call }: { call: ChatMcpCall }) {
  const [open, setOpen] = useState(call.status === "awaiting");
  const statusLabel =
    call.status === "awaiting"
      ? "Awaiting approval"
      : call.status === "running"
        ? "Running"
        : call.status === "denied"
          ? "Denied"
          : call.status === "error"
            ? "Error"
            : "Done";
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Server
          size={13}
          className={call.status === "error" ? "text-error" : "text-accent"}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-text-primary">
            {call.server_name} · {call.tool_name}
          </span>
          <span className="text-[9px] text-text-muted">{statusLabel}</span>
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border-subtle p-2">
          <p className="text-[9px] font-medium uppercase tracking-wide text-text-muted">
            Arguments
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-secondary">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {call.error && <p className="text-[10px] text-error">{call.error}</p>}
          {call.result?.content.map((block, index) => (
            <McpContent key={index} block={block} />
          ))}
          {call.result?.structured_content !== undefined && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-secondary">
              {JSON.stringify(call.result.structured_content, null, 2)}
            </pre>
          )}
          {call.result?.truncated && (
            <p className="text-[9px] text-warning">
              The model-visible result was truncated at 64 KiB. Rich content above is retained.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function McpContent({ block }: { block: unknown }) {
  if (!block || typeof block !== "object") {
    return <pre className="text-[10px] text-text-muted">{JSON.stringify(block)}</pre>;
  }
  const value = block as Record<string, unknown>;
  const type = String(value.type ?? "");
  if (type === "text") {
    return (
      <div className="text-[11px] text-text-secondary">
        <AiMessageView content={String(value.text ?? "")} />
      </div>
    );
  }
  if (type === "image" && typeof value.data === "string") {
    const mime = String(value.mimeType ?? value.mime_type ?? "image/png");
    if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime)) {
      return <p className="text-[10px] text-warning">Unsupported MCP image type: {mime}</p>;
    }
    return (
      <img
        className="max-h-64 rounded border border-border-subtle"
        src={`data:${mime};base64,${value.data}`}
        alt="MCP tool result"
      />
    );
  }
  if (type === "audio" && typeof value.data === "string") {
    const mime = String(value.mimeType ?? value.mime_type ?? "audio/mpeg");
    if (!["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm"].includes(mime)) {
      return <p className="text-[10px] text-warning">Unsupported MCP audio type: {mime}</p>;
    }
    return <audio controls src={`data:${mime};base64,${value.data}`} className="w-full" />;
  }
  if (type === "resource_link" && typeof value.uri === "string") {
    const safe = sanitizeExternalWebUrl(value.uri);
    return safe ? (
      <button
        type="button"
        className="break-all text-left text-[10px] text-accent underline"
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
      <div className="rounded bg-bg-primary p-2">
        <p className="mb-1 break-all text-[9px] text-text-muted">
          {String(resource.uri ?? "Embedded resource")}
        </p>
        {typeof resource.text === "string" ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-text-secondary">
            {resource.text}
          </pre>
        ) : (
          <p className="text-[10px] text-text-muted">Embedded binary resource</p>
        )}
      </div>
    );
  }
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
