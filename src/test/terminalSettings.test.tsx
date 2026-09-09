import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
}));

import { TerminalSection } from "../components/settings/TerminalSection";
import { useSettings } from "../hooks/useSettings";
import { S } from "../lib/strings";
import { useAppStore } from "../stores/appStore";
import { makeSettings } from "./factories";

describe("clearing the terminal for a new chat", () => {
  beforeEach(() => {
    mocks.getSettings.mockReset();
    mocks.saveSettings.mockReset();
    mocks.getSettings.mockResolvedValue(makeSettings());
    mocks.saveSettings.mockResolvedValue(undefined);
    useAppStore.setState({ clearTerminalOnNewChat: true });
  });

  it("lets the user turn the default on setting off and back on", async () => {
    render(<TerminalSection />);
    const toggle = screen.getByRole("switch", { name: S.settings.terminal.clearOnNewChat });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(S.settings.terminal.clearOnNewChatHint)).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ clear_terminal_on_new_chat: false });
    expect(useAppStore.getState().clearTerminalOnNewChat).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ clear_terminal_on_new_chat: true });
  });

  it.each([false, true])("restores the saved preference %s from the backend", async (enabled) => {
    mocks.getSettings.mockResolvedValue(makeSettings({ clear_terminal_on_new_chat: enabled }));
    useAppStore.setState({ clearTerminalOnNewChat: !enabled });
    const { result } = renderHook(() => useSettings());
    render(<TerminalSection />);

    await act(async () => { await result.current.loadSettings(); });

    expect(useAppStore.getState().clearTerminalOnNewChat).toBe(enabled);
    expect(screen.getByRole("switch", { name: S.settings.terminal.clearOnNewChat }))
      .toHaveAttribute("aria-checked", String(enabled));
  });

  it("keeps the current behavior until the preference has been saved", async () => {
    let completeSave!: () => void;
    mocks.saveSettings.mockImplementation(() => new Promise<void>((resolve) => {
      completeSave = resolve;
    }));
    const { result } = renderHook(() => useSettings());
    let saving!: Promise<void>;
    act(() => { saving = result.current.save({ clear_terminal_on_new_chat: false }); });

    expect(mocks.saveSettings).toHaveBeenCalledWith({ clear_terminal_on_new_chat: false });
    expect(useAppStore.getState().clearTerminalOnNewChat).toBe(true);

    await act(async () => { completeSave(); await saving; });
    expect(useAppStore.getState().clearTerminalOnNewChat).toBe(false);
  });

  it("uses the stored preference when a save reports failure", async () => {
    const failure = new Error("could not secure settings file");
    mocks.saveSettings.mockRejectedValue(failure);
    mocks.getSettings.mockResolvedValue(makeSettings({ clear_terminal_on_new_chat: false }));
    const { result } = renderHook(() => useSettings());

    await act(async () => {
      await expect(result.current.save({ clear_terminal_on_new_chat: false })).rejects.toBe(failure);
    });

    expect(mocks.getSettings).toHaveBeenCalledOnce();
    expect(useAppStore.getState().clearTerminalOnNewChat).toBe(false);
  });
});
