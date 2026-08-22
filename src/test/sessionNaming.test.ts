import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetNamingForTests,
  nameSession,
  renameSessionWithAi,
} from "../lib/sessionNaming";
import { useAppStore } from "../stores/appStore";
import type { Session } from "../lib/types";
import { makeSession } from "./factories";

const { aiNameSessionMock } = vi.hoisted(() => ({
  aiNameSessionMock: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  aiNameSession: aiNameSessionMock,
}));

beforeEach(() => {
  vi.useRealTimers();
  aiNameSessionMock.mockReset();
  __resetNamingForTests();
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    sidecars: {},
    aiSessionNaming: true,
    catalog: [],
    activeModelId: "local/qwen3.5-9b",
    loadedModelId: "local/qwen3.5-9b",
    modelState: "ready",
    modelAvailable: true,
  });
});

function addNamedContext(overrides: Partial<Session> = {}): void {
  useAppStore.getState().addSession(makeSession({ id: "tab-1", ...overrides }));
  useAppStore.getState().updateSessionUi("tab-1", { cwd: "/var/log" });
}

describe("explicit AI tab rename", () => {
  it("replaces the visible manual/SSH title even when automatic naming is disabled", async () => {
    useAppStore.setState({ aiSessionNaming: false });
    addNamedContext({
      hostId: "host-1",
      hostLabel: "production",
      userTitle: "manual name",
      aiTitle: "old suggestion",
    });
    aiNameSessionMock.mockResolvedValue("incident triage");

    await renameSessionWithAi("tab-1");

    expect(useAppStore.getState().sessions[0]).toMatchObject({
      userTitle: "incident triage",
      aiTitle: null,
    });
  });

  it("keeps a newer manual edit made while generation is in flight", async () => {
    addNamedContext({ userTitle: "before" });
    let finish!: (value: string) => void;
    aiNameSessionMock.mockImplementation(
      () => new Promise<string>((resolve) => { finish = resolve; }),
    );

    const rename = renameSessionWithAi("tab-1");
    useAppStore.getState().updateSession("tab-1", { userTitle: "typed later" });
    finish("model answer");

    await expect(rename).rejects.toThrow(/newer name was kept/i);
    expect(useAppStore.getState().sessions[0].userTitle).toBe("typed later");
  });

  it("reports missing context instead of silently doing nothing", async () => {
    useAppStore.getState().addSession(makeSession({ id: "tab-1" }));

    await expect(renameSessionWithAi("tab-1")).rejects.toThrow(/enough context/i);
    expect(aiNameSessionMock).not.toHaveBeenCalled();
  });

  it("reports a busy visible generation instead of queueing behind it", async () => {
    addNamedContext();
    useAppStore.getState().initAiStream("tab-1", "agent", "request-1");

    await expect(renameSessionWithAi("tab-1")).rejects.toThrow(/current AI response/i);
    expect(aiNameSessionMock).not.toHaveBeenCalled();
  });

  it("still lets the automatic-naming preference disable only automatic calls", async () => {
    vi.useFakeTimers();
    useAppStore.setState({ aiSessionNaming: false });
    addNamedContext();

    nameSession("tab-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(aiNameSessionMock).not.toHaveBeenCalled();
  });
});
