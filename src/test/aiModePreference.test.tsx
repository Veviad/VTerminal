import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
}));

import { AgentSection } from "../components/settings/AgentSection";
import { useSettings } from "../hooks/useSettings";
import { selectAiMode } from "../lib/aiModePreference";
import { S } from "../lib/strings";
import { useAppStore } from "../stores/appStore";
import { makeSession, makeSettings } from "./factories";

const policies = [
  { defaultAiMode: "ask", lastAiMode: "agent", expected: "ask" },
  { defaultAiMode: "agent", lastAiMode: "ask", expected: "agent" },
  { defaultAiMode: "remember", lastAiMode: "ask", expected: "ask" },
  { defaultAiMode: "remember", lastAiMode: "agent", expected: "agent" },
] as const;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.getSettings.mockReset().mockResolvedValue(makeSettings());
  mocks.saveSettings.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    sidecars: {},
    mcpServers: [],
    defaultAiMode: "ask",
    lastAiMode: "ask",
    agentMaxIterations: 10,
    agentCommandTimeoutSecs: 120,
    agentCommandPolicyRules: [],
    aiWebAccess: true,
    autoCompactEnabled: true,
    autoCompactThresholdPercent: 85,
  });
});

describe.each(policies)("AI mode policy $defaultAiMode with remembered $lastAiMode", (policy) => {
  beforeEach(() => {
    useAppStore.setState({
      defaultAiMode: policy.defaultAiMode,
      lastAiMode: policy.lastAiMode,
    });
  });

  it("applies to every newly opened terminal", () => {
    useAppStore.getState().addSession(makeSession({ id: "first" }));
    useAppStore.getState().addSession(makeSession({ id: "second" }));

    for (const stream of Object.values(useAppStore.getState().aiStreams)) {
      expect(stream.mode).toBe(policy.expected);
      expect(stream.permissionMode).toBe("ask");
    }
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("applies when starting a new conversation and resets command approval", () => {
    const store = useAppStore.getState();
    store.addSession(makeSession());
    store.setAiMode("session-1", policy.expected === "ask" ? "agent" : "ask");
    store.setPermissionMode("session-1", "auto_read");

    store.newAiConversation("session-1");

    expect(useAppStore.getState().aiStreams["session-1"]).toMatchObject({
      mode: policy.expected,
      permissionMode: "ask",
      messages: [],
      modelTranscript: [],
    });
    expect(useAppStore.getState().lastAiMode).toBe(policy.lastAiMode);
  });

  it("applies to restored conversations without restoring automatic approval", () => {
    const store = useAppStore.getState();
    store.addSession(makeSession({ archivedFrom: "archived-session" }));
    store.setAiMode("session-1", policy.expected === "ask" ? "agent" : "ask");
    store.setPermissionMode("session-1", "auto_read");
    const messages = [{
      id: "old-message",
      role: "user" as const,
      content: "Check the service",
      createdAt: "2026-09-09T10:00:00Z",
    }];
    const transcript = [{ role: "user" as const, content: "Check the service" }];

    store.restoreAiTranscript("session-1", messages, transcript, "2026-09-09T11:00:00Z");

    expect(useAppStore.getState().aiStreams["session-1"]).toMatchObject({
      mode: policy.expected,
      permissionMode: "ask",
      messages,
      modelTranscript: transcript,
      restoredAt: "2026-09-09T11:00:00Z",
    });
    expect(useAppStore.getState().lastAiMode).toBe(policy.lastAiMode);
  });
});

describe("remembering explicit Ask and Agent choices", () => {
  beforeEach(() => {
    useAppStore.setState({ defaultAiMode: "remember" });
    useAppStore.getState().addSession(makeSession());
  });

  it("updates new conversations immediately while persistence is pending", async () => {
    const save = deferred();
    mocks.saveSettings.mockReturnValueOnce(save.promise);

    const selecting = selectAiMode("session-1", "agent");

    expect(useAppStore.getState().lastAiMode).toBe("agent");
    expect(useAppStore.getState().aiStreams["session-1"].mode).toBe("agent");
    useAppStore.getState().addSession(makeSession({ id: "next" }));
    expect(useAppStore.getState().aiStreams.next.mode).toBe("agent");
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({ last_ai_mode: "agent" }));

    save.resolve();
    await selecting;
  });

  it("serializes rapid choices so the last selection remains the saved default", async () => {
    const firstSave = deferred();
    const secondSave = deferred();
    mocks.saveSettings
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);

    const first = selectAiMode("session-1", "agent");
    const second = selectAiMode("session-1", "ask");

    expect(useAppStore.getState().lastAiMode).toBe("ask");
    expect(useAppStore.getState().aiStreams["session-1"].mode).toBe("ask");
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));
    expect(mocks.saveSettings).toHaveBeenNthCalledWith(1, { last_ai_mode: "agent" });

    firstSave.resolve();
    await first;
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(2));
    expect(mocks.saveSettings).toHaveBeenNthCalledWith(2, { last_ai_mode: "ask" });
    expect(useAppStore.getState().lastAiMode).toBe("ask");

    secondSave.resolve();
    await second;
    expect(useAppStore.getState().lastAiMode).toBe("ask");
  });

  it("reports persistence failure and still saves the next queued choice", async () => {
    const firstSave = deferred();
    const failure = new Error("settings disk unavailable");
    mocks.saveSettings.mockReturnValueOnce(firstSave.promise);

    const first = selectAiMode("session-1", "agent");
    const rejection = expect(first).rejects.toBe(failure);
    const second = selectAiMode("session-1", "ask");
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledTimes(1));

    firstSave.reject(failure);
    await rejection;
    await second;

    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ last_ai_mode: "ask" });
    expect(useAppStore.getState().lastAiMode).toBe("ask");
    expect(useAppStore.getState().aiStreams["session-1"].mode).toBe("ask");
  });

  it("does not remember the temporary Explain mode", async () => {
    await selectAiMode("session-1", "agent");
    mocks.saveSettings.mockClear();

    useAppStore.getState().setAiMode("session-1", "explain");

    expect(useAppStore.getState().aiStreams["session-1"].mode).toBe("explain");
    expect(useAppStore.getState().lastAiMode).toBe("agent");
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    useAppStore.getState().newAiConversation("session-1");
    expect(useAppStore.getState().aiStreams["session-1"].mode).toBe("agent");
  });

  it("ignores selections for a session that no longer exists", async () => {
    await selectAiMode("closed-session", "agent");

    expect(useAppStore.getState().lastAiMode).toBe("ask");
    expect(useAppStore.getState().aiStreams["closed-session"]).toBeUndefined();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
});

describe("AI mode settings", () => {
  it.each(policies)("hydrates $defaultAiMode and remembered $lastAiMode before opening a terminal", async (policy) => {
    mocks.getSettings.mockResolvedValue(makeSettings({
      default_ai_mode: policy.defaultAiMode,
      last_ai_mode: policy.lastAiMode,
    }));
    const { result } = renderHook(() => useSettings());

    await act(async () => { await result.current.loadSettings(); });
    act(() => { useAppStore.getState().addSession(makeSession()); });

    expect(useAppStore.getState().defaultAiMode).toBe(policy.defaultAiMode);
    expect(useAppStore.getState().lastAiMode).toBe(policy.lastAiMode);
    expect(useAppStore.getState().aiStreams["session-1"].mode).toBe(policy.expected);
  });

  it("mirrors saved preferences only after a successful settings write", async () => {
    const save = deferred();
    mocks.saveSettings.mockReturnValueOnce(save.promise);
    const { result } = renderHook(() => useSettings());
    let saving!: Promise<void>;

    act(() => {
      saving = result.current.save({ default_ai_mode: "remember", last_ai_mode: "agent" });
    });
    expect(useAppStore.getState().defaultAiMode).toBe("ask");
    expect(useAppStore.getState().lastAiMode).toBe("ask");

    await act(async () => { save.resolve(); await saving; });

    expect(useAppStore.getState().defaultAiMode).toBe("remember");
    expect(useAppStore.getState().lastAiMode).toBe("agent");
  });

  it("offers Ask, Agent, and remembering the last choice and persists changes", async () => {
    render(<AgentSection />);
    const select = screen.getByRole("combobox", { name: S.settings.agent.defaultMode });
    expect(select).toHaveValue("ask");
    expect(within(select).getAllByRole("option").map((option) => option.getAttribute("value")))
      .toEqual(["ask", "agent", "remember"]);

    fireEvent.change(select, { target: { value: "remember" } });

    await waitFor(() => expect(select).toHaveValue("remember"));
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ default_ai_mode: "remember" });

    fireEvent.change(select, { target: { value: "agent" } });

    await waitFor(() => expect(select).toHaveValue("agent"));
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ default_ai_mode: "agent" });
  });

  it("shows a failed preference save and allows retrying it", async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error("could not write settings"));
    render(<AgentSection />);
    const select = screen.getByRole("combobox", { name: S.settings.agent.defaultMode });

    fireEvent.change(select, { target: { value: "agent" } });

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(select).toHaveValue("ask");
    expect(mocks.getSettings).toHaveBeenCalledOnce();

    fireEvent.change(select, { target: { value: "agent" } });

    await waitFor(() => expect(select).toHaveValue("agent"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
