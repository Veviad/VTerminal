import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/appStore";

vi.mock("../lib/tauri", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
  archiveClear: vi.fn().mockResolvedValue(undefined),
}));

const { useSettings } = await import("../hooks/useSettings");

describe("write-only credential frontend state", () => {
  beforeEach(() => {
    useAppStore.setState({
      hasHfToken: false,
      hasApiKey: {},
      credentialStoreStatus: "ready",
    });
  });

  it("retains only presence after credential saves", async () => {
    const sentinel = "sentinel-frontend-secret";
    const { result } = renderHook(() => useSettings());
    await act(async () => {
      await result.current.save({
        hf_token: sentinel,
        anthropic_api_key: sentinel,
        openai_api_key: sentinel,
        mistral_api_key: sentinel,
      });
    });

    const state = useAppStore.getState() as unknown as Record<string, unknown>;
    expect(state.hasHfToken).toBe(true);
    expect(state.hasApiKey).toEqual({ anthropic: true, openai: true, mistral: true });
    expect("hfToken" in state).toBe(false);
    expect(JSON.stringify(state)).not.toContain(sentinel);
  });
});
