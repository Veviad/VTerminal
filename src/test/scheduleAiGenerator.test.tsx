import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), cancel: vi.fn(), readOutput: vi.fn() }));
vi.mock("../lib/schedules", async (original) => ({
  ...await original<typeof import("../lib/schedules")>(), scheduleAiGenerate: mocks.generate,
}));
vi.mock("../lib/tauri", () => ({ aiCancel: mocks.cancel }));
vi.mock("../hooks/useAiStream", () => ({ readBlockOutput: mocks.readOutput }));

import { ScheduleAiGenerator, scheduleTargetFromSession } from "../components/schedules/ScheduleAiGenerator";
import { emptyScheduleInput } from "../lib/schedules";
import { resetRunbookTerminalPrivacyForTests } from "../lib/runbookTerminalPrivacy";
import { emptySessionUi, useAppStore } from "../stores/appStore";
import type { Session } from "../lib/types";

beforeEach(() => {
  vi.clearAllMocks();
  resetRunbookTerminalPrivacyForTests();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.readOutput.mockReturnValue("48% used\nsecret-value");
  mocks.generate.mockResolvedValue({ ...emptyScheduleInput(), name: "Nightly disk check", enabled: true, permission_mode: "auto_all" });
  useAppStore.setState({
    sessions: [{ id: "s1", shell: "/bin/zsh", cwd: "/Users/op", exited: false, hostId: "old-host", hostLabel: "Old host", ordinal: 1 } as Session],
    activeSessionId: "s1",
    sendContextToAi: true,
    sessionUi: { s1: { ...emptySessionUi(), cwd: "/Users/op/work", blocks: [{
      id: "b1", sessionId: "s1", command: "df -h", state: "done", exitCode: 0,
      startLine: 0, endLine: 1, startedAt: "2026-10-26T10:00:00Z", endedAt: "2026-10-26T10:00:01Z", origin: "user",
    }] } },
  });
});

function open() {
  const onGenerated = vi.fn().mockResolvedValue(undefined);
  const view = render(<ScheduleAiGenerator onGenerated={onGenerated} />);
  fireEvent.click(screen.getByRole("button", { name: /generate with ai/i }));
  fireEvent.change(screen.getByLabelText(/what should this scheduled task do/i), { target: { value: "Check disk space nightly at 03:00" } });
  return { ...view, onGenerated };
}
const generate = () => fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));
const attach = () => fireEvent.click(screen.getByRole("checkbox", { name: /terminal session as context/i }));

describe("ScheduleAiGenerator", () => {
  it("generates an unsaved disabled draft without granting provider-suggested automatic approval", async () => {
    const { onGenerated } = open();
    generate();
    await waitFor(() => expect(onGenerated).toHaveBeenCalled());
    expect(mocks.generate.mock.calls[0][2]).toBeNull();
    expect(onGenerated.mock.calls[0][0]).toMatchObject({ name: "Nightly disk check", enabled: false, permission_mode: "ask", runbook: null });
  });

  it("includes reviewed session context and uses live remote identity for the proposed target", async () => {
    const state = useAppStore.getState();
    state.updateSessionUi("s1", { remote: { kind: "ssh", target: "deploy@prod" }, remoteHost: { id: "prod", label: "Production", color: null } });
    const { onGenerated } = open();
    attach();
    generate();
    await waitFor(() => expect(onGenerated).toHaveBeenCalled());
    expect(mocks.generate.mock.calls[0][2]).toContain("df -h");
    expect(mocks.generate.mock.calls[0][2]).toContain("deploy@prod");
    expect(onGenerated.mock.calls[0][0].target).toEqual({ kind: "ssh_host", host_id: "prod" });
  });

  it("preserves hand-redacted context after toggling command selection", async () => {
    open();
    attach();
    fireEvent.change(screen.getByLabelText(/exactly this text/i), { target: { value: "safe reviewed text" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /df -h/i }));
    generate();
    await waitFor(() => expect(mocks.generate).toHaveBeenCalled());
    expect(mocks.generate.mock.calls[0][2]).toBe("safe reviewed text");
  });

  it("honours disabling terminal context while the generator is open", async () => {
    open();
    attach();
    act(() => useAppStore.setState({ sendContextToAi: false }));
    generate();
    await waitFor(() => expect(mocks.generate).toHaveBeenCalled());
    expect(mocks.generate.mock.calls[0][2]).toBeNull();
  });

  it("ignores results after cancellation and requests provider cancellation", async () => {
    let resolve!: (value: ReturnType<typeof emptyScheduleInput>) => void;
    mocks.generate.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { onGenerated } = open();
    generate();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => { resolve(emptyScheduleInput()); });
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.generate.mock.calls[0][0]);
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it("cancels generation on unmount without opening a late draft", async () => {
    let resolve!: (value: ReturnType<typeof emptyScheduleInput>) => void;
    mocks.generate.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { onGenerated, unmount } = open();
    generate();
    unmount();
    await act(async () => { resolve(emptyScheduleInput()); });
    expect(mocks.cancel).toHaveBeenCalled();
    expect(onGenerated).not.toHaveBeenCalled();
  });
});

describe("schedule session target", () => {
  it("ignores saved SSH provenance after returning to the local shell", () => {
    expect(scheduleTargetFromSession("s1")).toEqual({ kind: "local_shell", cwd: "/Users/op/work" });
  });
  it("requires explicit target binding for an unregistered remote", () => {
    useAppStore.getState().updateSessionUi("s1", { remote: { kind: "ssh", target: "unknown" } });
    expect(scheduleTargetFromSession("s1")).toEqual({ kind: "ssh_host", host_id: "" });
  });
});
