import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateActions = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  cancelPendingUpdate: vi.fn(),
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

  it("renders determinate download bytes and accessible percentage", () => {
    useUpdateStore.setState({
      status: "downloading",
      downloadedBytes: 25,
      totalBytes: 100,
    });
    render(<UpdateModal />);

    const progress = screen.getByRole("progressbar", { name: "Downloading update…" });
    expect(progress).toHaveAttribute("aria-valuemin", "0");
    expect(progress).toHaveAttribute("aria-valuemax", "100");
    expect(progress).toHaveAttribute("aria-valuenow", "25");
    expect(progress).toHaveAttribute("aria-valuetext", "25 B of 100 B · 25%");
    const progressText = screen.getByText("25 B of 100 B · 25%");
    expect(progressText).toBeVisible();
    expect(progressText).not.toHaveAttribute("aria-live");
  });

  it("uses an honest indeterminate bar when no reliable total is available", () => {
    useUpdateStore.setState({
      status: "downloading",
      downloadedBytes: 25,
      totalBytes: null,
    });
    const { container } = render(<UpdateModal />);

    const progress = screen.getByRole("progressbar", { name: "Downloading update…" });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).toHaveAttribute("aria-valuetext", "25 B downloaded");
    expect(container.querySelector(".update-progress-indeterminate")).not.toBeNull();
  });

  it("does not claim 100 percent when received bytes exceed the advisory total", () => {
    useUpdateStore.setState({
      status: "downloading",
      downloadedBytes: 101,
      totalBytes: 100,
    });
    render(<UpdateModal />);

    const progress = screen.getByRole("progressbar", { name: "Downloading update…" });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).toHaveAttribute("aria-valuetext", "101 B downloaded");
  });

  it("does not round an incomplete transfer up to 100 percent", () => {
    useUpdateStore.setState({
      status: "downloading",
      downloadedBytes: 999,
      totalBytes: 1_000,
    });
    render(<UpdateModal />);

    const progress = screen.getByRole("progressbar", { name: "Downloading update…" });
    expect(progress).toHaveAttribute("aria-valuenow", "99");
    expect(progress).toHaveAttribute("aria-valuetext", "999 B of 1000 B · 99%");
  });

  it.each([
    ["verifying", "Verifying download…"],
    ["saving", "Saving workspace…"],
    ["installing", "Installing update…"],
    ["restarting", "Restarting VTerminal…"],
  ] as const)("renders %s as a non-numeric phase", (status, label) => {
    useUpdateStore.setState({ status });
    render(<UpdateModal />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
  });

  it("offers cancellation during transfer and disables it while cancellation settles", () => {
    useUpdateStore.setState({ status: "downloading" });
    const { rerender } = render(<UpdateModal />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(updateActions.cancelPendingUpdate).toHaveBeenCalledTimes(1);

    useUpdateStore.setState({ status: "cancelling" });
    rerender(<UpdateModal />);
    expect(screen.getByRole("button", { name: "Cancel download" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling download…");
  });
});
