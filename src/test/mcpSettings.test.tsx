import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyMcpHttpServer } from "../lib/mcpConfig";
import type { McpServerView, McpToolView } from "../lib/types";
import { useAppStore } from "../stores/appStore";

const listed = vi.fn<() => Promise<McpServerView[]>>();
const tested = vi.fn<(id: string) => Promise<McpToolView[]>>();

vi.mock("../lib/tauri", () => ({
  mcpServersList: () => listed(),
  mcpSandboxStatus: vi.fn(() =>
    Promise.resolve({
      supported: true,
      ready: true,
      backend: "seatbelt",
      message: "Seatbelt is ready.",
      network_domain_filtering: true,
    }),
  ),
  mcpServerTest: (id: string) => tested(id),
  mcpForgetApprovals: vi.fn(() => Promise.resolve()),
}));

const { McpSettings } = await import("../components/settings/McpSettings");

const emptyServer = createEmptyMcpHttpServer();
const server: McpServerView = {
  ...emptyServer,
  id: "mcp-coolify",
  name: "Coolify",
  transport: {
    ...emptyServer.transport,
    url: "https://coolify.example.test/mcp",
  },
  trust_hash: "trusted",
  trusted: true,
  missing_secret_slots: [],
  runtime: { connected: true, log_bytes: 0, tool_count: 1 },
  oauth: null,
};

const tool: McpToolView = {
  server_id: server.id,
  server_name: server.name,
  name: "list_projects",
  alias: "mcp_coolify_list_projects",
  description: "List projects",
  input_schema: { type: "object", properties: {} },
  schema_hash: "schema-1",
};

describe("MCP settings server test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ mcpServers: [] });
    listed.mockResolvedValue([server]);
  });

  it("shows progress and the successful result inside the server card", async () => {
    let finish!: (tools: McpToolView[]) => void;
    tested.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<McpSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Testing connection and discovering tools…",
    );

    finish([tool]);

    expect(
      await screen.findByText("Test passed. 1 valid tool discovered."),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Test" })).toBeEnabled(),
    );
    expect(tested).toHaveBeenCalledWith(server.id);
  });

  it("shows a failed test beside the affected server", async () => {
    tested.mockRejectedValue(new Error("server returned 401 Unauthorized"));
    render(<McpSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Test failed. server returned 401 Unauthorized",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Test" })).toBeEnabled(),
    );
  });

  it("keeps unrelated page notices while a server test runs", async () => {
    tested.mockResolvedValue([tool]);
    render(<McpSettings />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Forget approvals" }),
    );
    expect(
      await screen.findByText("Forgot approvals for Coolify."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(screen.getByText("Forgot approvals for Coolify.")).toBeVisible();
    expect(
      await screen.findByText("Test passed. 1 valid tool discovered."),
    ).toBeVisible();
  });
});
