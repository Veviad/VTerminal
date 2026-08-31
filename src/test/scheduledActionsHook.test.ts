import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tab-execution driver.
 *
 * The properties pinned here are the ones that would be invisible if broken:
 * the tab is created UNFOCUSED with real dimensions, a spawn failure is caught
 * even though it does not throw, `canWrite` never consults `activeSessionId`,
 * a paused agent run stops the run rather than being continued, the armed
 * permission mode is reset on teardown, and no result is ever submitted for an
 * attempt the backend did not lease.
 */

const mocks = vi.hoisted(() => ({
  // lib/schedules
  onScheduleFire: vi.fn(),
  onScheduleRunNotice: vi.fn(),
  schedulesList: vi.fn(),
  scheduleGet: vi.fn(),
  scheduleRunGet: vi.fn(),
  scheduleRunAttach: vi.fn(),
  scheduleStepBegin: vi.fn(),
  scheduleStepFinish: vi.fn(),
  scheduleRunFinish: vi.fn(),
  scheduleRunIsActive: vi.fn(),
  // lib/tauri
  sshHostsGet: vi.fn(),
  ptyKill: vi.fn(),
  // lib/ptyExec
  runInTerminal: vi.fn(),
  // hooks
  createSession: vi.fn(),
  startAgent: vi.fn(),
  connectToHost: vi.fn(),
  getTerm: vi.fn(),
}));

vi.mock("../lib/schedules", async () => {
  const actual = await vi.importActual<typeof import("../lib/schedules")>("../lib/schedules");
  return {
    ...actual,
    onScheduleFire: mocks.onScheduleFire,
    onScheduleRunNotice: mocks.onScheduleRunNotice,
    schedulesList: mocks.schedulesList,
    scheduleGet: mocks.scheduleGet,
    scheduleRunGet: mocks.scheduleRunGet,
    scheduleRunAttach: mocks.scheduleRunAttach,
    scheduleStepBegin: mocks.scheduleStepBegin,
    scheduleStepFinish: mocks.scheduleStepFinish,
    scheduleRunFinish: mocks.scheduleRunFinish,
    scheduleRunIsActive: mocks.scheduleRunIsActive,
  };
});

vi.mock("../lib/tauri", () => ({
  sshHostsGet: mocks.sshHostsGet,
  ptyKill: mocks.ptyKill,
}));

vi.mock("../lib/ptyExec", () => ({
  runInTerminal: mocks.runInTerminal,
  abortSession: vi.fn(),
  interruptJob: vi.fn(),
}));

vi.mock("../lib/sshConnect", () => ({ connectToHost: mocks.connectToHost }));

vi.mock("../lib/termRegistry", () => ({ getTerm: mocks.getTerm }));

vi.mock("../hooks/useSessions", () => ({
  useSessions: () => ({ createSession: mocks.createSession }),
}));

vi.mock("../hooks/useAiStream", () => ({
  useAiStream: () => ({ startAgent: mocks.startAgent }),
}));

import { useScheduledActions } from "../hooks/useScheduledActions";
import { emptyScheduleInput, type ScheduleAction, type ScheduleFireEvent } from "../lib/schedules";
import {
  recallActionSession,
  resetScheduleLiveJobsForTests,
  scheduleOwnerOf,
} from "../lib/scheduleLiveJobs";
import { useAppStore } from "../stores/appStore";
import { useScheduleStore } from "../stores/scheduleStore";

type FireHandler = (fire: ScheduleFireEvent) => void;

function action(overrides: Partial<ScheduleAction> = {}): ScheduleAction {
  return {
    ...emptyScheduleInput(),
    id: "a1",
    name: "nightly",
    permission_mode: "auto_read",
    execution_mode: "tab",
    steps_sha256: "sha",
    created_at: "t",
    updated_at: "t",
    steps: [
      {
        id: "s1",
        sort_order: 0,
        title: "Step 1",
        kind: "command",
        text: "df -h",
        continue_on_failure: false,
      },
    ],
    ...overrides,
  };
}

const fire: ScheduleFireEvent = {
  run_id: "r1",
  action_id: "a1",
  action_name: "nightly",
  execution_mode: "tab",
  target_kind: "local_shell",
  target_label: "local shell",
  target_host_id: null,
  target_cwd: null,
};

function stubTerm(cols = 120, rows = 40) {
  return {
    term: { cols, rows, buffer: { active: { length: 0, getLine: () => undefined } } },
  };
}

/** Register the session the way `createSession` does — synchronously, before its
 *  first await — because `withAiStream` no-ops for an id that is not in
 *  `state.sessions` and the driver depends on it being there. */
function addSession(id: string, exited = false) {
  useAppStore.setState((state) => ({
    sessions: [
      ...state.sessions,
      {
        id,
        shell: "/bin/zsh",
        cwd: null,
        createdAt: "t",
        exited,
        exitCode: null,
        hostId: null,
        hostLabel: null,
        userTitle: null,
        aiTitle: null,
        ordinal: 1,
        archivedFrom: null,
      },
    ],
  }));
}

let fireHandler: FireHandler | null = null;

async function mount() {
  const hook = renderHook(() => useScheduledActions());
  // The subscription is established through a promise chain.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return hook;
}

async function deliver(event: ScheduleFireEvent = fire) {
  await act(async () => {
    fireHandler?.(event);
    // Let the queued driver run to completion.
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 60; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetScheduleLiveJobsForTests();
  useScheduleStore.getState().reset();
  useAppStore.setState({
    schedulesEnabled: true,
    sessions: [],
    activeSessionId: null,
    // Reset alongside `sessions`: a leaked `sessionUi.remote` makes
    // `waitForRemote` resolve instantly, and a leaked `aiStreams` entry trips the
    // "panel already busy" guard. Both fail silently, in a later test.
    sessionUi: {},
    aiStreams: {},
  });
  fireHandler = null;

  mocks.onScheduleFire.mockImplementation(async (handler: FireHandler) => {
    fireHandler = handler;
    return () => {};
  });
  mocks.onScheduleRunNotice.mockResolvedValue(() => {});
  mocks.schedulesList.mockResolvedValue([action()]);
  mocks.scheduleGet.mockResolvedValue(action());
  mocks.scheduleRunGet.mockResolvedValue(null);
  mocks.scheduleRunAttach.mockResolvedValue(undefined);
  mocks.scheduleStepBegin.mockResolvedValue("att1");
  mocks.scheduleStepFinish.mockResolvedValue(undefined);
  mocks.scheduleRunFinish.mockResolvedValue(undefined);
  mocks.scheduleRunIsActive.mockResolvedValue(true);
  mocks.getTerm.mockReturnValue(stubTerm());
  mocks.runInTerminal.mockResolvedValue({
    exitCode: 0,
    output: "ok",
    durationMs: 12,
    mode: "integrated",
  });
  mocks.createSession.mockImplementation(async () => {
    addSession("sess-1");
    return "sess-1";
  });
  mocks.startAgent.mockResolvedValue(undefined);
  // Every mock the driver `await`s or chains `.catch()` onto must return a
  // promise. A bare `vi.fn()` returns undefined, and `undefined.catch` throws as
  // an UNHANDLED rejection — which vitest reports separately from test results,
  // so a grep for "Tests"/"FAIL" shows a green run while CI fails.
  mocks.ptyKill.mockResolvedValue(undefined);
});

describe("scheduled actions driver", () => {
  it("installs no subscription while the feature is off", async () => {
    useAppStore.setState({ schedulesEnabled: false });
    await mount();
    expect(mocks.onScheduleFire).not.toHaveBeenCalled();
    expect(mocks.schedulesList).not.toHaveBeenCalled();
  });

  it("ignores a headless fire — the backend drives that itself", async () => {
    await mount();
    await deliver({ ...fire, execution_mode: "headless" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  /** A background pane never fits, so whatever dimensions are seeded here are
   *  what every command in the run sees. 80 columns truncates `df -h` into
   *  output the model then reads as fact. */
  it("creates the tab unfocused, with the active tab's dimensions", async () => {
    useAppStore.setState({ activeSessionId: "other" });
    mocks.getTerm.mockReturnValue(stubTerm(200, 50));
    await mount();
    await deliver();
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ activate: false, dims: { cols: 200, rows: 50 } }),
    );
  });

  it("falls back to 120x40 rather than xterm's 80x24 when there is no tab to copy", async () => {
    mocks.getTerm.mockReturnValue(undefined);
    await mount();
    await deliver();
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ dims: { cols: 120, rows: 40 } }),
    );
  });

  /** `pty_spawn` failure does NOT throw: `createSession` catches it, marks the
   *  session exited and returns the id anyway. Without this check the run reports
   *  `terminal_closed` on step one for no visible reason. */
  it("detects a spawn failure that returned an already-exited session", async () => {
    mocks.createSession.mockImplementation(async () => {
      addSession("sess-1", true);
      return "sess-1";
    });
    await mount();
    await deliver();
    expect(mocks.runInTerminal).not.toHaveBeenCalled();
    expect(mocks.scheduleRunFinish).toHaveBeenCalledWith(
      "r1",
      "failed",
      expect.stringContaining("failed to start"),
    );
  });

  /** The editor exposes a per-action timeout and a headless run honours it.
   *  Ignoring it in a tab would make the same action behave differently for no
   *  stated reason — and the difference would only show up as a command cut off
   *  at two minutes. */
  it("uses the action's own command timeout, not a hardcoded one", async () => {
    mocks.schedulesList.mockResolvedValue([action({ command_timeout_secs: 600 })]);
    await mount();
    await deliver();
    expect(mocks.runInTerminal).toHaveBeenCalledWith(
      "sess-1",
      "att1",
      "df -h",
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it("runs a command step and reports its result", async () => {
    await mount();
    await deliver();
    expect(mocks.scheduleStepBegin).toHaveBeenCalledWith("r1", "s1", 0, "command", "Step 1");
    expect(mocks.runInTerminal).toHaveBeenCalledWith(
      "sess-1",
      "att1",
      "df -h",
      expect.objectContaining({ nonceCompletion: true, harden: true }),
    );
    expect(mocks.scheduleStepFinish).toHaveBeenCalledWith(
      "r1",
      "att1",
      expect.objectContaining({ status: "succeeded", exit_code: 0 }),
    );
    expect(mocks.scheduleRunFinish).toHaveBeenCalledWith("r1", "succeeded", null);
  });

  /** The Runbooks driver refuses to write unless its session is the ACTIVE tab.
   *  Copying that here would make every scheduled run fail the moment the user
   *  looked at another tab, so the guard is deliberately absent — and pinned
   *  absent, because it is exactly the kind of thing someone "fixes" later. */
  it("guards the write without ever consulting activeSessionId", async () => {
    // Evaluated DURING the dispatch: after the run settles, teardown has released
    // the session claim and `canWrite` would be false for an unrelated reason.
    const verdicts: Record<string, boolean> = {};
    mocks.runInTerminal.mockImplementation(async (_s, _a, _c, opts) => {
      useAppStore.setState({ activeSessionId: "a-completely-different-tab" });
      verdicts.otherTabFocused = opts.canWrite();
      useAppStore.setState({ schedulesEnabled: false });
      verdicts.featureOff = opts.canWrite();
      useAppStore.setState({ schedulesEnabled: true });
      useAppStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === "sess-1" ? { ...s, exited: true } : s,
        ),
      }));
      verdicts.shellExited = opts.canWrite();
      return { exitCode: 0, output: "", durationMs: 1, mode: "integrated" };
    });
    await mount();
    await deliver();
    // The user looking at another tab must NOT stop a scheduled run: that guard
    // is Runbooks policy, and copying it here would break the feature.
    expect(verdicts.otherTabFocused).toBe(true);
    expect(verdicts.featureOff).toBe(false);
    expect(verdicts.shellExited).toBe(false);
  });

  it("checks with the backend before typing, and refuses when the run is not active", async () => {
    mocks.scheduleRunIsActive.mockResolvedValue(false);
    await mount();
    await deliver();
    const opts = mocks.runInTerminal.mock.calls[0][3];
    await expect(opts.beforeWrite()).resolves.toBe(false);
  });

  it("reports a timeout as unknown and still running, never as killed", async () => {
    mocks.runInTerminal.mockResolvedValue({
      exitCode: null,
      output: "",
      durationMs: 120_000,
      mode: null,
      error: "timeout",
      note: "still running",
    });
    await mount();
    await deliver();
    expect(mocks.scheduleStepFinish).toHaveBeenCalledWith(
      "r1",
      "att1",
      expect.objectContaining({ status: "unknown" }),
    );
    const result = mocks.scheduleStepFinish.mock.calls[0][2];
    expect(result.error).toMatch(/may still be running/);
    expect(result.error).not.toMatch(/killed/);
  });

  it("stops the run on a failing step unless the step opted out", async () => {
    mocks.runInTerminal.mockResolvedValue({
      exitCode: 1,
      output: "",
      durationMs: 5,
      mode: "integrated",
    });
    mocks.schedulesList.mockResolvedValue([
      action({
        steps: [
          { id: "s1", sort_order: 0, title: "one", kind: "command", text: "false", continue_on_failure: false },
          { id: "s2", sort_order: 1, title: "two", kind: "command", text: "true", continue_on_failure: false },
        ],
      }),
    ]);
    await mount();
    await deliver();
    expect(mocks.scheduleStepBegin).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRunFinish).toHaveBeenCalledWith("r1", "failed", expect.any(String));
  });

  it("carries on past a failing step that opted out", async () => {
    mocks.runInTerminal.mockResolvedValue({
      exitCode: 1,
      output: "",
      durationMs: 5,
      mode: "integrated",
    });
    mocks.schedulesList.mockResolvedValue([
      action({
        steps: [
          { id: "s1", sort_order: 0, title: "one", kind: "command", text: "false", continue_on_failure: true },
          { id: "s2", sort_order: 1, title: "two", kind: "command", text: "true", continue_on_failure: false },
        ],
      }),
    ]);
    await mount();
    await deliver();
    expect(mocks.scheduleStepBegin).toHaveBeenCalledTimes(2);
  });

  it("seeds the armed mode on the session and resets it to ask on teardown", async () => {
    const seen: string[] = [];
    const original = useAppStore.getState().setPermissionMode;
    useAppStore.setState({
      setPermissionMode: (sessionId: string, mode: string) => {
        seen.push(mode);
        return original(sessionId, mode as never);
      },
    } as never);
    await mount();
    await deliver();
    // Seeded from the action's standing authorization, then handed back to `ask`
    // — otherwise a user clicking into the leftover tab inherits it for their own
    // next turn, with no gesture.
    expect(seen[0]).toBe("auto_read");
    expect(seen[seen.length - 1]).toBe("ask");
  });

  it("claims the session exclusively and releases it afterwards", async () => {
    await mount();
    await deliver();
    expect(scheduleOwnerOf("sess-1")).toBeNull();
    expect(recallActionSession("a1")).toBe("sess-1");
  });

  it("reuses the action's tab on the next fire", async () => {
    await mount();
    await deliver();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    mocks.getTerm.mockReturnValue(stubTerm());
    await deliver();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleStepBegin).toHaveBeenCalledTimes(2);
  });

  it("leaves the tab open and renames it with the result", async () => {
    await mount();
    await deliver();
    expect(mocks.ptyKill).not.toHaveBeenCalled();
    const session = useAppStore.getState().sessions.find((s) => s.id === "sess-1");
    expect(session?.userTitle).toContain("✓");
  });

  it("closes the tab only for a one-off action that opted in", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent | ErrorEvent) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    mocks.schedulesList.mockResolvedValue([
      action({
        close_tab_when_done: true,
        recurrence: { kind: "once", at: "2026-06-01T09:00:00+02:00" },
      }),
    ]);
    await mount();
    await deliver();
    expect(mocks.ptyKill).toHaveBeenCalledWith("sess-1");
    process.off("unhandledRejection", onRejection);
    // The teardown path chains `.catch()` on the kill, so an unhandled rejection
    // here means a promise the driver relies on was not one.
    expect(rejections).toEqual([]);
  });
});

describe("prompt steps", () => {
  const promptAction = action({
    steps: [
      {
        id: "s1",
        sort_order: 0,
        title: "Summarise",
        kind: "prompt",
        text: "summarise the disk usage",
        continue_on_failure: false,
      },
    ],
  });

  beforeEach(() => {
    mocks.schedulesList.mockResolvedValue([promptAction]);
  });

  it("awaits startAgent, which resolves only when the backend run terminates", async () => {
    mocks.startAgent.mockImplementation(async (sessionId: string) => {
      useAppStore.setState((state) => ({
        aiStreams: {
          ...state.aiStreams,
          [sessionId]: {
            ...(state.aiStreams[sessionId] ?? {}),
            status: "idle",
            messages: [{ id: "m1", role: "assistant", content: "all fine" }],
          } as never,
        },
      }));
    });
    await mount();
    await deliver();
    expect(mocks.startAgent).toHaveBeenCalledWith("sess-1", "summarise the disk usage");
    expect(mocks.scheduleStepFinish).toHaveBeenCalledWith(
      "r1",
      "att1",
      expect.objectContaining({ status: "succeeded", summary: "all fine" }),
    );
  });

  /** CLAUDE.md is explicit that Continue must stay a human click: wiring an
   *  armed mode to it would turn the step cap into no cap at all, unattended.
   *  A scheduler is the most tempting possible place to violate that. */
  it("never continues a paused run — it ends the step and stops", async () => {
    mocks.startAgent.mockImplementation(async (sessionId: string) => {
      useAppStore.setState((state) => ({
        aiStreams: {
          ...state.aiStreams,
          [sessionId]: {
            ...(state.aiStreams[sessionId] ?? {}),
            status: "paused",
            messages: [{ id: "m1", role: "assistant", content: "half done" }],
          } as never,
        },
      }));
    });
    await mount();
    await deliver();
    expect(mocks.startAgent).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleStepFinish).toHaveBeenCalledWith(
      "r1",
      "att1",
      expect.objectContaining({ status: "failed", termination: "step_limit" }),
    );
    expect(mocks.scheduleRunFinish).toHaveBeenCalledWith("r1", "failed", expect.any(String));
  });

  /** `startAgent` returns immediately, having done nothing, when the session is
   *  busy or a sidecar is unhealthy. An await on that resolves instantly and
   *  would otherwise look like a step that finished in two milliseconds. */
  it("treats a silent early return as a failure, not a success", async () => {
    mocks.startAgent.mockResolvedValue(undefined);
    await mount();
    await deliver();
    expect(mocks.scheduleStepFinish).toHaveBeenCalledWith(
      "r1",
      "att1",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("propagates a stream error", async () => {
    mocks.startAgent.mockImplementation(async (sessionId: string) => {
      useAppStore.setState((state) => ({
        aiStreams: {
          ...state.aiStreams,
          [sessionId]: {
            ...(state.aiStreams[sessionId] ?? {}),
            status: "error",
            lastError: "provider refused",
            messages: [{ id: "m1", role: "assistant", content: "" }],
          } as never,
        },
      }));
    });
    await mount();
    await deliver();
    expect(mocks.scheduleStepFinish).toHaveBeenCalledWith(
      "r1",
      "att1",
      expect.objectContaining({ status: "failed", error: "provider refused" }),
    );
  });
});

describe("ssh targets", () => {
  const remoteFire: ScheduleFireEvent = {
    ...fire,
    target_kind: "ssh_host",
    target_host_id: "h1",
    target_label: "prod-01",
  };

  beforeEach(() => {
    mocks.schedulesList.mockResolvedValue([
      action({ target: { kind: "ssh_host", host_id: "h1" } }),
    ]);
    mocks.sshHostsGet.mockResolvedValue({ id: "h1", label: "prod-01" });
    mocks.connectToHost.mockImplementation(async () => {
      addSession("sess-1");
      useAppStore.setState((state) => ({
        sessionUi: {
          ...state.sessionUi,
          "sess-1": { remote: { kind: "ssh", host_id: "h1" } } as never,
        },
      }));
      return "sess-1";
    });
  });

  it("connects through the existing saved-host path, unfocused and sized", async () => {
    await mount();
    await deliver(remoteFire);
    expect(mocks.connectToHost).toHaveBeenCalledWith(
      expect.objectContaining({ id: "h1" }),
      "new-tab",
      expect.any(Function),
      undefined,
      expect.objectContaining({ activate: false }),
    );
    expect(mocks.scheduleRunAttach).toHaveBeenCalledWith(
      "r1",
      "sess-1",
      "h1",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("fails loudly when the saved host is gone, rather than replaying a stale command", async () => {
    mocks.sshHostsGet.mockResolvedValue(null);
    await mount();
    await deliver(remoteFire);
    expect(mocks.connectToHost).not.toHaveBeenCalled();
    expect(mocks.scheduleRunFinish).toHaveBeenCalledWith(
      "r1",
      "failed",
      expect.stringContaining("no longer exists"),
    );
  });

  /** A host-key fingerprint prompt, MFA or a wrong password all land here. The
   *  tab is left open so the operator can see it, and NOTHING is typed in
   *  response — never `yes\r`. */
  it("fails without typing anything when the remote never reaches a prompt", async () => {
    mocks.connectToHost.mockImplementation(async () => {
      addSession("sess-1");
      return "sess-1";
    });
    vi.useFakeTimers();
    const hook = renderHook(() => useScheduledActions());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireHandler?.(remoteFire);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    vi.useRealTimers();
    hook.unmount();
    expect(mocks.runInTerminal).not.toHaveBeenCalled();
    expect(mocks.scheduleRunFinish).toHaveBeenCalledWith(
      "r1",
      "failed",
      expect.stringContaining("never reached a prompt"),
    );
  });
});
