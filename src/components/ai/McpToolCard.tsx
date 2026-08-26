import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Server } from "lucide-react";

import type { ChatMcpCall } from "../../lib/types";
import { McpContent } from "./mcp/McpContent";

function statusLabel(call: ChatMcpCall): string {
  return call.status === "awaiting"
    ? "Awaiting approval"
    : call.status === "running"
      ? "Running"
      : call.status === "denied"
        ? "Denied"
        : call.status === "error"
          ? "Error"
          : "Done";
}

export function McpToolCard({ call }: { call: ChatMcpCall }) {
  const [open, setOpen] = useState(call.status === "awaiting");
  useEffect(() => {
    if (
      call.status === "done" ||
      call.status === "denied" ||
      call.status === "error"
    ) {
      setOpen(false);
    }
  }, [call.status]);
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <button
        type="button"
        className="flex min-w-0 w-full items-center gap-2 px-3 py-2 text-left"
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
          <span className="text-[9px] text-text-muted">{statusLabel(call)}</span>
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="min-w-0 max-w-full space-y-2 overflow-hidden border-t border-border-subtle p-2">
          <p className="text-[9px] font-medium uppercase tracking-wide text-text-muted">
            Arguments
          </p>
          <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-secondary">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {call.error && (
            <p className="break-words text-[10px] text-error [overflow-wrap:anywhere]">
              {call.error}
            </p>
          )}
          {call.result?.content.map((block, index) => (
            <McpContent key={index} block={block} />
          ))}
          {call.result?.structured_content != null && (
            <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary p-2 text-[10px] text-text-secondary">
              {JSON.stringify(call.result.structured_content, null, 2)}
            </pre>
          )}
          {call.result?.truncated && (
            <p className="text-[9px] text-warning">
              The model-visible result was truncated at 64 KiB. Rich content
              above is retained.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function batchStatus(calls: ChatMcpCall[]): string {
  const count = (status: ChatMcpCall["status"]) =>
    calls.filter((call) => call.status === status).length;
  const running = count("running");
  const awaiting = count("awaiting");
  const errors = count("error");
  const denied = count("denied");

  if (running) return `${running} running`;
  if (awaiting) return `${awaiting} awaiting approval`;
  if (errors) return `${errors} failed`;
  if (denied) return `${denied} denied`;
  return "Done";
}

function McpToolBatch({ calls }: { calls: ChatMcpCall[] }) {
  const [open, setOpen] = useState(false);

  const serverNames = [...new Set(calls.map((call) => call.server_name))];
  const sourceLabel =
    serverNames.length === 1 ? serverNames[0] : `${serverNames.length} servers`;
  const label = `${sourceLabel} · ${calls.length} tool calls`;
  const status = batchStatus(calls);

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <button
        type="button"
        className="flex min-w-0 w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${label} · ${status}`}
      >
        <Server
          size={13}
          className={
            calls.some((call) => call.status === "error")
              ? "text-error"
              : "text-accent"
          }
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-text-primary">
            {label}
          </span>
          <span className="text-[9px] text-text-muted">
            {status}
          </span>
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="min-w-0 max-w-full space-y-2 overflow-hidden border-t border-border-subtle p-2">
          {calls.map((call) => (
            <McpToolCard key={call.approval_id} call={call} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A lone call stays directly accessible. Repeated calls collapse into one
 *  turn-level summary so tool-heavy answers do not dominate the transcript. */
export function McpToolGroup({ calls }: { calls: ChatMcpCall[] }) {
  if (calls.length === 0) return null;
  if (calls.length === 1) return <McpToolCard call={calls[0]} />;
  return <McpToolBatch calls={calls} />;
}
