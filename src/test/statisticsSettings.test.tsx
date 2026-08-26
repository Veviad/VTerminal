import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

  it("refreshes the lifetime totals on demand", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(statistics).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: S.settings.statistics.refresh }));
    await waitFor(() => expect(statistics).toHaveBeenCalledTimes(2));
  });
});
