import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateActions = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  dismissUpdatePrompt: vi.fn(),
  installPendingUpdate: vi.fn(),
}));

vi.mock("../lib/appUpdates", () => updateActions);

import { UpdateModal } from "../components/updates/UpdateModal";
import { initialUpdateState, useUpdateStore } from "../stores/updateStore";

describe("UpdateModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateStore.setState({
      ...initialUpdateState,
      status: "available",
      promptOpen: true,
      workspaceReady: true,
      metadata: {
        current_version: "0.1.3",
        version: "0.1.4",
        published_at: "2026-08-13T00:00:00Z",
        prerelease: false,
        notes: [
          "> **Important:** Back up first.",
          "",
          "## Highlights",
          "",
          "### Cleaner reconnects",
          "",
          "- **Reconnect** becomes available when the local prompt returns.",
          "- Read the [full changelog](https://github.com/Veviad/VTerminal).",
          "",
          "```sh",
          "shasum -a 256 -c SHA256SUMS.txt",
          "```",
        ].join("\n"),
      },
    });
  });

  it("renders GitHub release Markdown as formatted content", () => {
    const { container } = render(<UpdateModal />);

    expect(screen.getByRole("heading", { name: "Highlights", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Cleaner reconnects", level: 3 })).toBeVisible();
    expect(screen.getByText("Reconnect").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "full changelog" })).toHaveAttribute(
      "href",
      "https://github.com/Veviad/VTerminal",
    );
    expect(container.querySelector("blockquote")).toHaveTextContent("Important: Back up first.");
    expect(screen.getByText("shasum -a 256 -c SHA256SUMS.txt").closest("pre")).not.toBeNull();
  });
});
