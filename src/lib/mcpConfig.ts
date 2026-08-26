import type {
  McpServerConfig,
  McpTransportConfig,
} from "./types";

type McpHttpServerConfig = Omit<McpServerConfig, "transport"> & {
  transport: Extract<McpTransportConfig, { type: "streamable_http" }>;
};

type McpStdioServerConfig = Omit<McpServerConfig, "transport"> & {
  transport: Extract<McpTransportConfig, { type: "stdio" }>;
};

export function createEmptyMcpHttpServer(): McpHttpServerConfig {
  return {
    version: 1,
    id: "",
    name: "",
    enabled: true,
    auto_start: false,
    default_for_new_chats: false,
    revision: 1,
    transport: {
      type: "streamable_http",
      url: "https://",
      auth: { mode: "none", scopes: [] },
      headers: [],
    },
    timeouts: { startup_ms: 10_000, list_ms: 30_000, call_ms: 60_000 },
    disabled_tools: [],
    trust_hash: null,
  };
}

export function createEmptyMcpStdioServer(): McpStdioServerConfig {
  return {
    ...createEmptyMcpHttpServer(),
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", ""],
      cwd: null,
      env: [],
      sandbox: { allow_read: [], allow_write: [], allowed_domains: [] },
    },
  };
}
