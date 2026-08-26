import { createEmptyMcpHttpServer } from "../lib/mcpConfig";
import type { McpServerView } from "../lib/types";

interface MockMcpServerOptions {
  name?: string;
  defaultForNewChats?: boolean;
}

export function createMockMcpServer(
  id: string,
  options: MockMcpServerOptions = {},
): McpServerView {
  const config = createEmptyMcpHttpServer();
  return {
    ...config,
    id,
    name: options.name ?? id,
    default_for_new_chats: options.defaultForNewChats ?? true,
    transport: {
      ...config.transport,
      url: "https://example.com/mcp",
    },
    trusted: true,
    missing_secret_slots: [],
    runtime: { connected: false, log_bytes: 0, tool_count: null },
    oauth: null,
  };
}
