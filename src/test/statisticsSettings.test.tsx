import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { S } from "../lib/strings";
import type { TokenStatistics } from "../lib/types";

const statistics = vi.fn<() => Promise<TokenStatistics>>();

vi.mock("../lib/tauri", () => ({
  tokenStatistics: () => statistics(),
}));

const { SettingsPage } = await import("../components/settings/SettingsPage");
const { useAppStore } = await import("../stores/appStore");

const DATA: TokenStatistics = {
  total: { input_tokens: 1_000, output_tokens: 250, model_calls: 4 },
  local: { input_tokens: 600, output_tokens: 100, model_calls: 2 },
  cloud: { input_tokens: 400, output_tokens: 150, model_calls: 2 },
  by_provider: [
    {
      id: "local",
      label: "On-device",
      provider: "local",
      input_tokens: 600,
      output_tokens: 100,
      model_calls: 2,
      last_used_at: "2026-08-26T10:00:00Z",
    },
    {
      id: "openai",
      label: "OpenAI",
      provider: "openai",
      input_tokens: 400,
      output_tokens: 150,
      model_calls: 2,
      last_used_at: "2026-08-26T11:00:00Z",
    },
  ],
  by_model: [
    {
      id: "local/qwen3.5-9b",
      label: "Qwen3.5 9B",
      provider: "local",
      input_tokens: 600,
      output_tokens: 100,
      model_calls: 2,
      last_used_at: "2026-08-26T10:00:00Z",
    },
    {
      id: "openai/gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      provider: "openai",
      input_tokens: 400,
      output_tokens: 150,
      model_calls: 2,
      last_used_at: "2026-08-26T11:00:00Z",
    },
  ],
  tracking_since: "2026-08-01T10:00:00Z",
};

describe("Statistics settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statistics.mockResolvedValue(DATA);
    useAppStore.setState({ settingsTab: "statistics" });
  });

  it("is reachable and renders overall, llama.cpp, cloud, provider, and model usage", async () => {
    render(<SettingsPage />);

    expect(screen.getByRole("button", { name: S.settings.tabs.statistics })).toBeInTheDocument();
    await waitFor(() => expect(statistics).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1,250")).toBeInTheDocument();
    expect(screen.getByText(S.settings.statistics.local)).toBeInTheDocument();
    expect(screen.getByText(S.settings.statistics.cloud)).toBeInTheDocument();
    expect(screen.getByText("56.0%")).toBeInTheDocument();
    expect(screen.getByText("44.0%")).toBeInTheDocument();
    expect(screen.getByText("Qwen3.5 9B")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.6 Terra")).toBeInTheDocument();
  });

  it("appears between SSH hosts and Updates in the settings navigation", () => {
    render(<SettingsPage />);

    const labels = within(screen.getByRole("navigation"))
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual([
      S.settings.tabs.models,
      S.settings.tabs.agent,
      S.settings.tabs.instructions,
      S.settings.tabs.mcp,
      S.settings.tabs.docs,
      S.settings.tabs.runbooks,
      S.settings.tabs.appearance,
      S.settings.tabs.terminal,
      S.settings.tabs.hosts,
      S.settings.tabs.statistics,
      S.settings.tabs.updates,
      S.settings.tabs.about,
    ]);
  });

  it("refreshes the lifetime totals on demand", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(statistics).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: S.settings.statistics.refresh }));
    await waitFor(() => expect(statistics).toHaveBeenCalledTimes(2));
  });

  it("uses the wider responsive layout only for statistics", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(statistics).toHaveBeenCalledTimes(1));

    const settingsContent = screen
      .getByRole("heading", { name: S.settings.statistics.title })
      .closest(".max-w-4xl");
    expect(settingsContent).toHaveClass("w-full", "max-w-4xl");
    expect(settingsContent).not.toHaveClass("max-w-lg");

    const summaryLayout = screen.getByText(S.settings.statistics.allTime).parentElement
      ?.parentElement;
    expect(summaryLayout).toHaveClass(
      "grid",
      "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.75fr)]",
    );

    const localCard = screen.getByText(S.settings.statistics.local).closest(".rounded-lg");
    expect(localCard).toHaveClass("p-4");
    expect(localCard?.parentElement).toHaveClass("grid-cols-1", "gap-3", "sm:grid-cols-2");

    const providerBreakdown = screen.getByRole("heading", {
      name: S.settings.statistics.byProvider,
    }).nextElementSibling;
    expect(providerBreakdown).toHaveClass("p-4");

    fireEvent.click(screen.getByRole("button", { name: S.settings.tabs.appearance }));
    expect(settingsContent).toHaveClass("max-w-lg");
    expect(settingsContent).not.toHaveClass("max-w-4xl");
  });
});
