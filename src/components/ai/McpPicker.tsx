import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plug,
  Settings,
} from "lucide-react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import * as api from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import type {
  McpChatSelection,
  McpServerView,
  McpToolView,
} from "../../lib/types";

function McpServerItem(props: {
  server: McpServerView;
  tools: McpToolView[];
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  disabled: boolean;
  disabledToolNames: string[];
  onSelectedChange: (selected: boolean) => void;
  onExpandedChange: () => void;
  onToolEnabledChange: (toolName: string, enabled: boolean) => void;
}) {
  const {
    server,
    tools,
    selected,
    expanded,
    loading,
    disabled,
    disabledToolNames,
    onSelectedChange,
    onExpandedChange,
    onToolEnabledChange,
  } = props;
  const missing = server.missing_secret_slots.length > 0;
  const disabledToolCount = tools.filter((tool) =>
    disabledToolNames.includes(tool.name),
  ).length;

  return (
    <div
      role="group"
      aria-label={`${server.name} MCP server`}
      className="rounded-md border border-border-subtle bg-bg-secondary/50 p-2"
    >
      <div className="flex items-start justify-between gap-2">
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            disabled={disabled}
            checked={selected}
            onChange={(event) => onSelectedChange(event.target.checked)}
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
        {selected &&
          (loading && tools.length === 0 ? (
            <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[9px] text-text-muted">
              <Loader2
                size={10}
                className="animate-spin"
                aria-hidden="true"
              />
              Loading tools
            </span>
          ) : tools.length > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Hide" : "Show"} tools for ${server.name}`}
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[9px] text-text-muted hover:bg-bg-hover hover:text-text-secondary"
              onClick={onExpandedChange}
            >
              <span>
                {tools.length} tool{tools.length === 1 ? "" : "s"}
                {disabledToolCount > 0
                  ? ` · ${tools.length - disabledToolCount} on`
                  : ""}
              </span>
              {expanded ? (
                <ChevronDown size={10} aria-hidden="true" />
              ) : (
                <ChevronRight size={10} aria-hidden="true" />
              )}
            </button>
          ) : (
            <span className="shrink-0 pt-0.5 text-[9px] text-text-muted">
              No tools
            </span>
          ))}
      </div>
      {selected && expanded && tools.length > 0 && (
        <div className="ml-5 mt-2 border-l border-border-subtle pl-2">
          <div className="space-y-0.5 rounded-md bg-bg-primary/40 p-1">
            {tools.map((tool) => {
              const off = disabledToolNames.includes(tool.name);
              return (
                <label
                  className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1.5 text-[10px] text-text-secondary hover:bg-bg-hover"
                  key={tool.alias}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    disabled={disabled}
                    checked={!off}
                    onChange={(event) =>
                      onToolEnabledChange(tool.name, event.target.checked)
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate font-medium"
                      title={tool.title ?? tool.name}
                    >
                      {tool.title ?? tool.name}
                    </span>
                    {tool.description && (
                      <span
                        className="mt-0.5 block truncate text-[9px] text-text-muted"
                        title={tool.description}
                      >
                        {tool.description}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [expandedServerIds, setExpandedServerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pickerRef = useRef<HTMLDivElement>(null);
  const toolLoadRequestId = useRef(0);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissibleLayer(pickerRef, dismiss, open);
  const selection = props.selection ?? stream?.mcpSelection ?? {
    server_ids: [],
    disabled_tools: {},
  };
  const conversationId = props.conversationId ?? props.sessionId ?? "";
  const selected = new Set(selection.server_ids);
  const selectedServerIdsKey = selection.server_ids.join("\u0000");
  const toolsByServer = useMemo(() => {
    const grouped = new Map<string, McpToolView[]>();
    for (const tool of tools) {
      const serverTools = grouped.get(tool.server_id);
      if (serverTools) serverTools.push(tool);
      else grouped.set(tool.server_id, [tool]);
    }
    return grouped;
  }, [tools]);
  const problemCount =
    servers.filter(
      (server) =>
        selected.has(server.id) &&
        (!server.enabled || server.missing_secret_slots.length > 0),
    ).length +
    selection.server_ids.filter(
      (id) => !servers.some((server) => server.id === id),
    ).length;

  const loadTools = useCallback(
    async (serverIds: string[]) => {
      const requestId = ++toolLoadRequestId.current;
      if (serverIds.length === 0) {
        setTools([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const discovered = await api.mcpToolsList(conversationId, serverIds);
        if (requestId === toolLoadRequestId.current) setTools(discovered);
      } catch {
        if (requestId === toolLoadRequestId.current) setTools([]);
      } finally {
        if (requestId === toolLoadRequestId.current) setLoading(false);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    if (!open) {
      toolLoadRequestId.current += 1;
      setLoading(false);
      return;
    }
    const serverIds = selectedServerIdsKey
      ? selectedServerIdsKey.split("\u0000")
      : [];
    void loadTools(serverIds);
  }, [loadTools, open, selectedServerIdsKey]);

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
    if (!on) {
      setExpandedServerIds((current) => {
        if (!current.has(serverId)) return current;
        const nextExpanded = new Set(current);
        nextExpanded.delete(serverId);
        return nextExpanded;
      });
      if (conversationId && !props.onSelectionChange)
        void api.mcpDisconnect(conversationId, serverId).catch(() => {});
    }
  };

  const toggleServerTools = (serverId: string) => {
    setExpandedServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  const updateTool = (serverId: string, toolName: string, enabled: boolean) => {
    if (props.disabled) return;
    const current = selection.disabled_tools[serverId] ?? [];
    const next = enabled
      ? current.filter((name) => name !== toolName)
      : [...current, toolName].filter(
          (name, index, all) => all.indexOf(name) === index,
        );
    const nextSelection = {
      ...selection,
      disabled_tools: {
        ...selection.disabled_tools,
        [serverId]: next,
      },
    };
    if (props.onSelectionChange) props.onSelectionChange(nextSelection);
    else if (props.sessionId) setSelection(props.sessionId, nextSelection);
  };

  return (
    <div className="relative" ref={pickerRef}>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors ${selection.server_ids.length > 0 ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-bg-hover hover:text-text-secondary"} disabled:opacity-50`}
        title="Select MCP servers and tools for this chat"
        aria-expanded={open}
        aria-haspopup="dialog"
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
        <div
          role="dialog"
          aria-label="MCP selection for this chat"
          className="absolute right-0 top-8 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border-subtle bg-bg-card p-2 shadow-xl"
        >
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
            {servers.map((server) => (
              <McpServerItem
                key={server.id}
                server={server}
                tools={toolsByServer.get(server.id) ?? []}
                selected={selected.has(server.id)}
                expanded={expandedServerIds.has(server.id)}
                loading={loading}
                disabled={props.disabled}
                disabledToolNames={
                  selection.disabled_tools[server.id] ?? []
                }
                onSelectedChange={(on) => updateServers(server.id, on)}
                onExpandedChange={() => toggleServerTools(server.id)}
                onToolEnabledChange={(toolName, enabled) =>
                  updateTool(server.id, toolName, enabled)
                }
              />
            ))}
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
        </div>
      )}
    </div>
  );
}
