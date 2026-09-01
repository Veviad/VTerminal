import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduleValidate: vi.fn(),
  schedulePreview: vi.fn(),
  sshHostsList: vi.fn(),
}));

vi.mock("../lib/schedules", async () => {
  const actual = await vi.importActual<typeof import("../lib/schedules")>("../lib/schedules");
  return {
    ...actual,
    scheduleValidate: mocks.scheduleValidate,
    schedulePreview: mocks.schedulePreview,
    schedulesList: vi.fn(async () => []),
    scheduleRunsList: vi.fn(async () => []),
  };
});

vi.mock("../lib/tauri", () => ({ sshHostsList: mocks.sshHostsList }));

import { ScheduleEditor } from "../components/schedules/ScheduleEditor";
import { S } from "../lib/strings";
import { useAppStore } from "../stores/appStore";
import { useScheduleStore } from "../stores/scheduleStore";

const HOST = {
  id: "h1",
  label: "prod-01",
  hostname: "prod-01.example.test",
  username: "deploy",
  port: 2222,
  identity_file: null,
  jump_host: null,
  extra_args: null,
  remote_dir: null,
  post_connect: null,
  tag: null,
  color: null,
  source: "manual" as const,
  config_alias: null,
  use_count: 0,
  last_used_at: null,
  created_at: "t",
  updated_at: "t",
  has_password: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useScheduleStore.getState().reset();
  useAppStore.setState({
    schedulesEnabled: true,
    schedulesTabExecutionEnabled: true,
    docsEnabled: false,
  });
  mocks.scheduleValidate.mockResolvedValue([]);
  mocks.schedulePreview.mockResolvedValue([]);
  mocks.sshHostsList.mockResolvedValue([HOST]);
});

async function mountEditor() {
  useScheduleStore.getState().beginDraft(null);
  const view = render(<ScheduleEditor />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe("ScheduleEditor", () => {
  it("prompts for an action when there is no draft", async () => {
    render(<ScheduleEditor />);
    expect(screen.getByText(S.schedules.emptyHint)).toBeTruthy();
  });

  it("switches the target and clears the host binding", async () => {
    await mountEditor();
    await act(async () => {
      screen.getByText(S.schedules.targetHost).click();
    });
    expect(useScheduleStore.getState().draft?.input.target).toEqual({
      kind: "ssh_host",
      host_id: "h1",
    });
    await act(async () => {
      screen.getByText(S.schedules.targetLocal).click();
    });
    expect(useScheduleStore.getState().draft?.input.target).toEqual({
      kind: "local_shell",
      cwd: null,
    });
  });

  /** The user is pre-authorizing a connect they will not witness, so the exact
   *  line has to be visible before they save. */
  it("shows the exact ssh command that will be typed", async () => {
    await mountEditor();
    await act(async () => {
      screen.getByText(S.schedules.targetHost).click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const preview = screen.getByText(/^ssh /);
    // Exactly what `buildSshCommand` produces, including the port — this is the
    // line that gets typed, so the preview must not paraphrase it.
    expect(preview.textContent).toContain("deploy@prod-01.example.test");
    expect(preview.textContent).toContain("-p 2222");
  });

  /** The highest-value validation in the editor: `sanitizeCommand` is the same
   *  gate the terminal applies, so a rejected line becomes a red note while you
   *  type instead of a run that silently did nothing at 3am. */
  it("surfaces the sanitizeCommand reason for a control character inline", async () => {
    await mountEditor();
    const textarea = screen.getByLabelText("Step 1 command");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "echo hi\rrm -rf /" } });
    });
    expect(screen.getByText(/control characters/i)).toBeTruthy();
  });

  it("does not offer the Full permission mode", async () => {
    await mountEditor();
    expect(screen.queryByText(/^Full$/)).toBeNull();
    expect(screen.getByText(S.schedules.permissionOptions.ask)).toBeTruthy();
  });

  it("warns that saving re-arms once the mode has been raised", async () => {
    await mountEditor();
    expect(screen.queryByText(S.schedules.permissionReArm)).toBeNull();
    await act(async () => {
      useScheduleStore.getState().patchDraft({ permission_mode: "auto_all" });
    });
    expect(screen.getByText(S.schedules.permissionReArm)).toBeTruthy();
  });

  it("says so when tab execution is switched off", async () => {
    useAppStore.setState({ schedulesTabExecutionEnabled: false });
    await mountEditor();
    await act(async () => {
      useScheduleStore.getState().patchDraft({ execution_mode: "tab" });
    });
    expect(screen.getAllByText(S.schedules.tabExecutionOff).length).toBeGreaterThan(0);
  });

  it("adds, reorders and removes steps while keeping their content", async () => {
    await mountEditor();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Step 1 command"), {
        target: { value: "df -h" },
      });
    });
    await act(async () => {
      screen.getByText(S.schedules.addPrompt).click();
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Step 2 prompt"), {
        target: { value: "summarise it" },
      });
    });
    await act(async () => {
      screen.getAllByLabelText(S.schedules.moveDown)[0].click();
    });
    const steps = useScheduleStore.getState().draft!.input.steps;
    expect(steps.map((s) => s.text)).toEqual(["summarise it", "df -h"]);
    await act(async () => {
      screen.getAllByLabelText(S.schedules.removeStep)[0].click();
    });
    expect(useScheduleStore.getState().draft!.input.steps.map((s) => s.text)).toEqual([
      "df -h",
    ]);
  });

  it("blocks Save while a blocking issue stands", async () => {
    mocks.scheduleValidate.mockResolvedValue([
      { field: "name", message: "Give the action a name.", blocking: true },
    ]);
    await mountEditor();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const save = screen.getByText(S.schedules.save) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Once beside the field, once in the blocking summary at the bottom.
    expect(screen.getAllByText("Give the action a name.").length).toBeGreaterThan(0);
  });

  it("shows an advisory without blocking Save", async () => {
    mocks.scheduleValidate.mockResolvedValue([
      { field: "web_access", message: "fetched pages can influence commands", blocking: false },
    ]);
    await mountEditor();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.getByText("fetched pages can influence commands")).toBeTruthy();
    expect((screen.getByText(S.schedules.save) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clamps an interval to at least one minute", async () => {
    await mountEditor();
    await act(async () => {
      screen.getByText(S.schedules.recurrenceOptions.interval).click();
    });
    const field = screen.getByLabelText(S.schedules.everyMinutes);
    await act(async () => {
      fireEvent.change(field, { target: { value: "0" } });
    });
    expect(useScheduleStore.getState().draft?.input.recurrence).toEqual({
      kind: "interval",
      every_minutes: 1,
    });
  });
});
