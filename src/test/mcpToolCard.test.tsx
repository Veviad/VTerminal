import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  McpToolCard,
  McpToolGroup,
} from "../components/ai/McpToolCard";
import type { ChatMcpCall } from "../lib/types";

function call(status: ChatMcpCall["status"]): ChatMcpCall {
  return {
    approval_id: "approval-1",
    server_id: "coolify",
    server_name: "Coolify",
    tool_name: "list_services",
    arguments: {},
    status,
    result:
      status === "done"
        ? {
            content: [
              {
                type: "text",
                text: `{"data":"${"unbroken".repeat(100)}"}`,
              },
            ],
            structured_content: null,
            is_error: false,
            truncated: false,
            model_text: "result",
          }
        : null,
    error: null,
  };
}

function calls(statuses: ChatMcpCall["status"][]): ChatMcpCall[] {
  return statuses.map((status, index) => ({
    ...call(status),
    approval_id: `approval-${index + 1}`,
    tool_name: index === 0 ? "list_services" : "get_service",
  }));
}

describe("MCP tool card", () => {
  it("collapses automatically when an approval finishes", async () => {
    const { rerender } = render(<McpToolCard call={call("awaiting")} />);
    const toggle = screen.getByRole("button", {
      name: /Coolify · list_services/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    rerender(<McpToolCard call={call("running")} />);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    rerender(<McpToolCard call={call("done")} />);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-expanded", "false"),
    );
    expect(screen.queryByText(/unbrokenunbroken/)).toBeNull();
  });

  it("keeps completed output contained and available on demand", () => {
    render(<McpToolCard call={call("done")} />);
    const toggle = screen.getByRole("button", {
      name: /Coolify · list_services/,
    });
    const card = toggle.parentElement;

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(card).toHaveClass("min-w-0", "max-w-full", "overflow-hidden");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const output = screen.getByText(/unbrokenunbroken/);
    expect(output).toBeVisible();
    expect(output).toHaveClass("max-w-full", "overflow-auto", "break-all");
    expect(screen.queryByText("null")).toBeNull();
  });

  it("renders one call directly without an extra group", () => {
    render(<McpToolGroup calls={calls(["done"])} />);

    expect(
      screen.getByRole("button", { name: /Coolify · list_services/ }),
    ).toBeVisible();
    expect(screen.queryByText(/1 tool call/)).toBeNull();
  });

  it("collapses two or more completed calls into one summary", () => {
    render(<McpToolGroup calls={calls(["done", "done", "done"])} />);

    const group = screen.getByRole("button", {
      name: "Coolify · 3 tool calls · Done",
    });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Coolify · get_service")).toBeNull();

    fireEvent.click(group);

    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Coolify · get_service")).toHaveLength(2);
  });

  it("keeps a live batch collapsed while surfacing its status", () => {
    render(<McpToolGroup calls={calls(["done", "running"])} />);

    const group = screen.getByRole("button", {
      name: "Coolify · 2 tool calls · 1 running",
    });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("1 running")).toBeVisible();
  });
});
