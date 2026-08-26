import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpPicker } from "../components/ai/McpPicker";
import * as api from "../lib/tauri";
import type {
  McpChatSelection,
  McpServerView,
  McpToolView,
} from "../lib/types";
import { useAppStore } from "../stores/appStore";

function server(id: string, name: string): McpServerView {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    default_for_new_chats: false,
    revision: 1,
    transport: {
      type: "streamable_http",
      url: `https://${id}.example.test/mcp`,
      auth: { mode: "none", scopes: [] },
      headers: [],
    },
    timeouts: { startup_ms: 10_000, list_ms: 30_000, call_ms: 60_000 },
    disabled_tools: [],
    trust_hash: "trusted",
    trusted: true,
    missing_secret_slots: [],
    runtime: { connected: true, log_bytes: 0, tool_count: 2 },
    oauth: null,
  };
}

function tool(
  serverId: string,
  serverName: string,
  name: string,
  title: string,
): McpToolView {
  return {
    server_id: serverId,
    server_name: serverName,
    name,
    alias: `${serverId}_${name}`,
    title,
    description: `${title} description`,
    input_schema: { type: "object", properties: {} },
    schema_hash: `${serverId}-${name}-schema`,
  };
}

const coolify = server("coolify", "Coolify");
const github = server("github", "GitHub");
const discoveredTools = [
  tool(
    coolify.id,
    coolify.name,
    "infrastructure_overview",
    "Get Infrastructure Overview",
  ),
  tool(coolify.id, coolify.name, "list_servers", "List Servers"),
  tool(github.id, github.name, "list_issues", "List Issues"),
];

const selection: McpChatSelection = {
  server_ids: [coolify.id, github.id],
  disabled_tools: { [coolify.id]: ["list_servers"] },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MCP picker", () => {
  beforeEach(() => {
    useAppStore.setState({ mcpServers: [coolify, github] });
    vi.spyOn(api, "mcpToolsList").mockResolvedValue(discoveredTools);
  });

  afterEach(() => vi.restoreAllMocks());

  it("groups tools under collapsed server summaries", async () => {
    render(
      <McpPicker
        conversationId="chat-1"
        selection={selection}
        onSelectionChange={vi.fn()}
        disabled={false}
      />,
    );

    fireEvent.click(
      screen.getByTitle("Select MCP servers and tools for this chat"),
    );

    const coolifyGroup = await screen.findByRole("group", {
      name: "Coolify MCP server",
    });
    const toolsButton = await within(coolifyGroup).findByRole("button", {
      name: "Show tools for Coolify",
    });
    expect(toolsButton).toHaveTextContent("2 tools · 1 on");
    expect(
      within(coolifyGroup).queryByText("Get Infrastructure Overview"),
    ).toBeNull();

    fireEvent.click(toolsButton);

    expect(
      within(coolifyGroup).getByText("Get Infrastructure Overview"),
    ).toBeVisible();
    expect(
      within(coolifyGroup).getByRole("button", {
        name: "Hide tools for Coolify",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("dismisses on an outside pointer or Escape, but not inside the dialog", async () => {
    render(
      <McpPicker
        conversationId="chat-1"
        selection={selection}
        onSelectionChange={vi.fn()}
        disabled={false}
      />,
    );
    const trigger = screen.getByTitle(
      "Select MCP servers and tools for this chat",
    );

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "MCP selection for this chat",
    });
    fireEvent.pointerDown(dialog);
    expect(dialog).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "MCP selection for this chat" }),
    ).toBeNull();

    fireEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", {
        name: "MCP selection for this chat",
      }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "MCP selection for this chat" }),
    ).toBeNull();
  });

  it("loads tools immediately when another server is selected", async () => {
    const onSelectionChange = vi.fn();
    const listTools = vi.mocked(api.mcpToolsList);
    const initialSelection = {
      server_ids: [coolify.id],
      disabled_tools: {},
    };
    const { rerender } = render(
      <McpPicker
        conversationId="chat-1"
        selection={initialSelection}
        onSelectionChange={onSelectionChange}
        disabled={false}
      />,
    );

    fireEvent.click(
      screen.getByTitle("Select MCP servers and tools for this chat"),
    );
    await waitFor(() =>
      expect(listTools).toHaveBeenCalledWith("chat-1", [coolify.id]),
    );
    listTools.mockClear();

    const githubGroup = screen.getByRole("group", {
      name: "GitHub MCP server",
    });
    fireEvent.click(within(githubGroup).getByRole("checkbox"));

    const nextSelection = {
      server_ids: [coolify.id, github.id],
      disabled_tools: {},
    };
    expect(onSelectionChange).toHaveBeenCalledWith(nextSelection);
    rerender(
      <McpPicker
        conversationId="chat-1"
        selection={nextSelection}
        onSelectionChange={onSelectionChange}
        disabled={false}
      />,
    );
    await waitFor(() =>
      expect(listTools).toHaveBeenCalledWith("chat-1", [
        coolify.id,
        github.id,
      ]),
    );
  });

  it("ignores stale tool discovery after the selected servers change", async () => {
    const listTools = vi.mocked(api.mcpToolsList);
    const firstRequest = deferred<McpToolView[]>();
    const secondRequest = deferred<McpToolView[]>();
    listTools.mockReset();
    listTools
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <McpPicker
        conversationId="chat-1"
        selection={{ server_ids: [coolify.id], disabled_tools: {} }}
        onSelectionChange={onSelectionChange}
        disabled={false}
      />,
    );

    fireEvent.click(
      screen.getByTitle("Select MCP servers and tools for this chat"),
    );
    await waitFor(() =>
      expect(listTools).toHaveBeenCalledWith("chat-1", [coolify.id]),
    );

    rerender(
      <McpPicker
        conversationId="chat-1"
        selection={{
          server_ids: [coolify.id, github.id],
          disabled_tools: {},
        }}
        onSelectionChange={onSelectionChange}
        disabled={false}
      />,
    );
    await waitFor(() =>
      expect(listTools).toHaveBeenCalledWith("chat-1", [
        coolify.id,
        github.id,
      ]),
    );

    await act(async () => {
      secondRequest.resolve([
        tool(github.id, github.name, "new_tool", "New GitHub Tool"),
      ]);
      await secondRequest.promise;
    });
    const githubGroup = screen.getByRole("group", {
      name: "GitHub MCP server",
    });
    expect(
      await within(githubGroup).findByRole("button", {
        name: "Show tools for GitHub",
      }),
    ).toHaveTextContent("1 tool");

    await act(async () => {
      firstRequest.resolve([
        tool(coolify.id, coolify.name, "stale_tool", "Stale Coolify Tool"),
      ]);
      await firstRequest.promise;
    });
    expect(
      within(githubGroup).getByRole("button", {
        name: "Show tools for GitHub",
      }),
    ).toHaveTextContent("1 tool");
  });
});
