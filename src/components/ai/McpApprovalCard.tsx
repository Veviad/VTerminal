import { PlugZap } from "lucide-react";

export function McpApprovalCard({
  server,
  tool,
  description,
  args,
  onRespond,
}: {
  server: string;
  tool: string;
  description?: string;
  args: unknown;
  onRespond: (decision: "allow_once" | "always_allow" | "deny") => void;
}) {
  return (
    <div className="rounded-lg border border-accent/30 bg-bg-card p-3">
      <div className="flex items-start gap-2">
        <PlugZap size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-text-primary">
            {server} wants to call {tool}
          </p>
          {description && (
            <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
              {description}
            </p>
          )}
        </div>
      </div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-primary p-2 text-[10px] text-text-secondary">
        {JSON.stringify(args, null, 2)}
      </pre>
      <p className="mt-2 text-[9px] text-text-muted">
        Tool annotations are informational. Approval is tied to this server,
        exact tool, configuration revision, and schema.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          className="rounded-md bg-accent px-2.5 py-1.5 text-[10px] font-medium text-white"
          onClick={() => onRespond("allow_once")}
        >
          Allow once
        </button>
        <button
          className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover"
          onClick={() => onRespond("always_allow")}
        >
          Always allow this tool
        </button>
        <button
          className="rounded-md border border-border-subtle px-2.5 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover"
          onClick={() => onRespond("deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
