import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "../stores/appStore";
import { S } from "../lib/strings";

// `ai_web_access` was read by the backend long before it was writable — three
// call sites in commands/ai.rs, no writer, no UI, so it was pinned at `true`.
// This pins the round-trip that closes that gap: the toggle reflects the store
// and a flip reaches `save_settings` under the key the backend already reads.
//
// One `vi.mock` covers it, per the single-chokepoint design in lib/tauri.ts.

const saveSettings = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());

vi.mock("../lib/tauri", () => ({
  saveSettings: (...a: unknown[]) => saveSettings(...a),
  getSettings: vi.fn(() => Promise.resolve({})),
}));

const { AgentSection } = await import("../components/settings/AgentSection");

describe("AgentSection — internet access", () => {
  beforeEach(() => {
    saveSettings.mockClear();
    useAppStore.setState({
      aiWebAccess: true,
      agentMaxIterations: 10,
      agentCommandTimeoutSecs: 120,
    });
  });

  it("reflects a stored `true`", () => {
    render(<AgentSection />);
    const toggle = screen.getByRole("switch", { name: S.settings.agent.webAccess });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects a stored `false`", () => {
    useAppStore.setState({ aiWebAccess: false });
    render(<AgentSection />);
    const toggle = screen.getByRole("switch", { name: S.settings.agent.webAccess });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("writes the key the backend already reads", async () => {
    render(<AgentSection />);
    fireEvent.click(screen.getByRole("switch", { name: S.settings.agent.webAccess }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ ai_web_access: false }));
  });

  /** The hint has to admit the command block is best-effort. It recognises tool
   *  NAMES; it cannot see inside a script the agent wrote in an earlier step, nor
   *  through an alias in the user's own dotfiles. Overclaiming here would be the
   *  one place the app lies about a security boundary. */
  it("keeps the best-effort caveat in the hint", () => {
    expect(S.settings.agent.webAccessHint).toMatch(/best-effort/i);
  });
});
