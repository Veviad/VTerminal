import { useState } from "react";
import { AlertTriangle, ChevronDown, Settings, Plug } from "lucide-react";
import * as api from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import type { McpChatSelection, McpToolView } from "../../lib/types";

export function McpPicker(props: {
  sessionId?: string;
  conversationId?: string;
  selection?: McpChatSelection;
  onSelectionChange?: (selection: McpChatSelection) => void;
  disabled: boolean;
}) {
  const servers = useAppStore((state) => state.mcpServers);
  const stream = useAppStore((state) =>
    props.sessionId ? state.aiStreams[props.sessionId] : undefined,
  );
  const setSelection = useAppStore((state) => state.setMcpSelection);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpToolView[]>([]);
  const [loading, setLoading] = useState(false);
  const selection = props.selection ?? stream?.mcpSelection ?? {
    server_ids: [],
    disabled_tools: {},
  };
  const conversationId = props.conversationId ?? props.sessionId ?? "";
  const selected = new Set(selection.server_ids);
  const problemCount =
    servers.filter(
      (server) =>
        selected.has(server.id) &&
        (!server.enabled || server.missing_secret_slots.length > 0),
    ).length +
    selection.server_ids.filter(
      (id) => !servers.some((server) => server.id === id),
    ).length;

  const updateServers = (serverId: string, on: boolean) => {
    if (props.disabled) return;
    const server_ids = on
      ? [...selection.server_ids, serverId].filter(
          (id, index, all) => all.indexOf(id) === index,
        )
      : selection.server_ids.filter((id) => id !== serverId);
    const disabled_tools = { ...selection.disabled_tools };
    if (!on) delete disabled_tools[serverId];
    const next = { server_ids, disabled_tools };
    if (props.onSelectionChange) props.onSelectionChange(next);
    else if (props.sessionId) setSelection(props.sessionId, next);
    if (!on && conversationId && !props.onSelectionChange)
      void api.mcpDisconnect(conversationId, serverId).catch(() => {});
  };

  const loadTools = async () => {
    if (selection.server_ids.length === 0) return;
    setLoading(true);
    try {
      setTools(await api.mcpToolsList(conversationId, selection.server_ids));
    } catch {
      setTools([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void loadTools();
        }}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors ${selection.server_ids.length > 0 ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"} disabled:opacity-50`}
        title="Select MCP servers and tools for this chat"
        aria-expanded={open}
      >
        {problemCount > 0 ? (
          <AlertTriangle size={11} className="text-warning" />
        ) : (
          <Plug size={11} />
        )}
        MCP {selection.server_ids.length > 0 ? selection.server_ids.length : ""}
        <ChevronDown size={10} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border-subtle bg-bg-card p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between px-1">
            <div>
              <p className="text-[11px] font-medium text-text-primary">
                MCP for this chat
              </p>
              <p className="text-[10px] text-text-muted">
                Selection changes are locked during a run.
              </p>
            </div>
            <button
              className="rounded p-1 text-text-muted hover:bg-bg-hover"
              onClick={() => {
                setSettingsTab("mcp");
                setSettingsOpen(true);
                setOpen(false);
              }}
              title="Open MCP settings"
            >
              <Settings size={13} />
            </button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {servers.length === 0 && (
              <p className="p-2 text-[11px] text-text-muted">
                Add a server in MCP settings.
              </p>
            )}
            {servers.map((server) => {
              const on = selected.has(server.id);
              const serverTools = tools.filter(
                (tool) => tool.server_id === server.id,
              );
              const missing = server.missing_secret_slots.length > 0;
              return (
                <div
                  key={server.id}
                  className="rounded-md border border-border-subtle p-2"
                >
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      disabled={props.disabled}
                      checked={on}
                      onChange={(event) =>
                        updateServers(server.id, event.target.checked)
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium text-text-primary">
                        {server.name}
                      </span>
                      <span
                        className={`block text-[9px] ${missing || !server.enabled ? "text-warning" : "text-text-muted"}`}
                      >
                        {!server.enabled
                          ? "Disabled"
                          : missing
                            ? "Authentication needed"
                            : server.runtime.connected
                              ? "Connected"
                              : server.transport.type === "stdio"
                                ? "Sandboxed local"
                                : "Remote HTTP"}
                      </span>
                    </span>
                  </label>
                  {on && serverTools.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-border-subtle pt-2">
                      {serverTools.map((tool) => {
                        const off =
                          selection.disabled_tools[server.id]?.includes(
                            tool.name,
                          ) ?? false;
                        return (
                          <label
                            className="flex items-start gap-2 text-[10px] text-text-secondary"
                            key={tool.alias}
                          >
                            <input
                              type="checkbox"
                              disabled={props.disabled}
                              checked={!off}
                              onChange={(event) => {
                                const current =
                                  selection.disabled_tools[server.id] ?? [];
                                const next = event.target.checked
                                  ? current.filter((name) => name !== tool.name)
                                  : [...current, tool.name];
                                const nextSelection = {
                                  ...selection,
                                  disabled_tools: {
                                    ...selection.disabled_tools,
                                    [server.id]: next,
                                  },
                                };
                                if (props.onSelectionChange)
                                  props.onSelectionChange(nextSelection);
                                else if (props.sessionId)
                                  setSelection(props.sessionId, nextSelection);
                              }}
                            />
                            <span>
                              <span className="font-medium">
                                {tool.title ?? tool.name}
                              </span>
                              {tool.description && (
                                <span className="mt-0.5 block line-clamp-2 text-text-muted">
                                  {tool.description}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            {selection.server_ids
              .filter((id) => !servers.some((server) => server.id === id))
              .map((id) => (
                <div
                  key={id}
                  className="flex items-center justify-between rounded-md border border-warning/30 p-2 text-[10px] text-warning"
                >
                  <span>Unavailable server · {id.slice(0, 8)}</span>
                  <button
                    disabled={props.disabled}
                    onClick={() => updateServers(id, false)}
                  >
                    Remove
                  </button>
                </div>
              ))}
          </div>
          {loading && (
            <p className="mt-2 text-[10px] text-text-muted">
              Loading tool definitions…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
