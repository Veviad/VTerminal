import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Header } from "../components/layout/Header";
import type { CatalogEntry } from "../lib/types";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useRunbookStore } from "../stores/runbookStore";
import { useScheduleStore } from "../stores/scheduleStore";
import { S } from "../lib/strings";

vi.mock("../components/layout/TabStrip", () => ({ TabStrip: () => <div data-testid="tabs" /> }));
vi.mock("../components/layout/ModelMenu", () => ({ ModelMenu: () => null }));
vi.mock("../components/layout/VisionMenu", () => ({ VisionMenu: () => null }));
vi.mock("../components/runbooks", () => ({ RunbookStatusIndicator: () => null }));

function localModel(): CatalogEntry {
  return {
    id: "local/qwen-test",
    provider: "local",
    tier: "fast",
    label: "Qwen Test",
    description: "",
    wire_model: "qwen-test",
    context_tokens: 32_000,
    efforts: ["off", "high"],
    default_effort: "high",
    supports_temperature: true,
    supports_tools: true,
    native_web_search: false,
    native_web_fetch: false,
    supports_vision: false,
    local: {
      artifact: { repo_id: "test/qwen", filename: "qwen.gguf", size_bytes: 10 },
      mtp: {
        kind: "embedded",
        legacy: { repo_id: "test/qwen", filename: "legacy.gguf", size_bytes: 9 },
        draft_tokens: 4,
      },
      min_ram_gb: 8,
      family: "qwen",
    },
    remote: null,
    fits: true,
    downloaded: true,
    mtp: { kind: "embedded", state: "ready", download_bytes: 0, disk_delta_bytes: 0, draft_tokens: 4 },
    configured: true,
    effort: "high",
  };
}

describe("Header workspace and generation controls", () => {
  beforeEach(() => {
    const model = localModel();
    useAppStore.setState({
      catalog: [model],
      activeModelId: model.id,
      loadedModelId: model.id,
      modelState: "ready",
      modelAvailable: true,
      localAcceleration: {
        backend: "metal",
        device_name: "Apple GPU",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "mtp",
        generation_fallback_reason: null,
      },
      runbooksEnabled: false,
      schedulesEnabled: false,
      settingsOpen: false,
      sessionBrowserOpen: false,
    });
    useChatStore.setState({ workspaceMode: "chat" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("places the workspace selector on the left and switches through a dropdown", () => {
    const switchWorkspace = vi
      .spyOn(useChatStore.getState(), "setWorkspaceMode")
      .mockResolvedValue(undefined);
    render(<Header />);

    const trigger = screen.getByRole("button", { name: "Workspace" });
    const header = screen.getByRole("banner");
    expect(header.children[0]?.contains(trigger)).toBe(true);
    expect(trigger).toHaveTextContent("Chat");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Terminal/ }));
    expect(switchWorkspace).toHaveBeenCalledWith("terminal");
  });

  it("keeps the header edges fixed while the terminal navigation takes remaining space", () => {
    useChatStore.setState({ workspaceMode: "terminal" });
    render(<Header />);

    const [left, center, right] = Array.from(screen.getByRole("banner").children);
    expect(left).toHaveClass("shrink-0");
    expect(center).toHaveClass("min-w-0", "flex-1");
    expect(right).toHaveClass("shrink-0");
    expect(center).toContainElement(screen.getByTestId("tabs"));
  });

  it("shows when MTP decoding is active", () => {
    render(<Header />);
    expect(screen.getByText("MTP")).toHaveAttribute(
      "title",
      "MTP speculative decoding is active.",
    );
  });

  it("distinguishes standard decoding and explains an MTP fallback", () => {
    useAppStore.setState({
      localAcceleration: {
        backend: "metal",
        device_name: "Apple GPU",
        device_memory_bytes: null,
        fallback_reason: null,
        generation_mode: "standard",
        generation_fallback_reason: "MTP initialization failed",
      },
    });
    render(<Header />);
    expect(screen.getByText("Standard")).toHaveAttribute(
      "title",
      "Standard decoding is active: MTP initialization failed",
    );
  });
});

describe("Header Scheduled Actions button", () => {
  beforeEach(() => {
    useAppStore.setState({
      catalog: [localModel()],
      activeModelId: "local/qwen-test",
      runbooksEnabled: false,
      schedulesEnabled: true,
      settingsOpen: false,
      sessionBrowserOpen: false,
    });
    useChatStore.setState({ workspaceMode: "terminal" });
    useScheduleStore.getState().reset();
    useRunbookStore.getState().setWorkspaceOpen(false);
  });

  afterEach(() => {
    useScheduleStore.getState().reset();
  });

  it("is absent while the feature is off", () => {
    useAppStore.setState({ schedulesEnabled: false });
    render(<Header />);
    expect(screen.queryByLabelText(S.schedules.open)).toBeNull();
  });

  it("sits between Runbooks and past sessions", () => {
    useAppStore.setState({ runbooksEnabled: true });
    render(<Header />);
    const schedules = screen.getByLabelText(S.schedules.open);
    const runbooks = screen.getByLabelText("Open Runbooks");
    const history = screen.getByTitle(S.header.sessions);
    const order = [...(schedules.parentElement?.children ?? [])];
    expect(order.indexOf(runbooks)).toBeLessThan(order.indexOf(schedules));
    expect(order.indexOf(schedules)).toBeLessThan(order.indexOf(history));
  });

  it("opens the panel and closes Runbooks with it", () => {
    useAppStore.setState({ runbooksEnabled: true });
    useRunbookStore.getState().setWorkspaceOpen(true);
    render(<Header />);
    fireEvent.click(screen.getByLabelText(S.schedules.open));
    expect(useScheduleStore.getState().workspaceOpen).toBe(true);
    expect(useRunbookStore.getState().workspaceOpen).toBe(false);
  });

  /** A runbook run follows a click the user just made. A scheduled run fires on
   *  a timer, so swapping this button for a wider pill would reflow the icon
   *  cluster under their cursor with no gesture — a misclick hazard. */
  it("adds a badge for a live run without changing the button's size", () => {
    const { rerender } = render(<Header />);
    const before = screen.getByLabelText(S.schedules.open);
    const beforeClasses = before.className;
    const beforeChildCount = before.parentElement?.children.length ?? 0;

    useScheduleStore.getState().upsertRun({
      id: "r1",
      action_id: "a1",
      action_name: "nightly",
      plan_sha256: "sha",
      trigger: "schedule",
      execution_mode: "headless",
      permission_mode: "auto_read",
      target_kind: "local_shell",
      target_label: "local shell",
      status: "running",
      web_access: false,
      app_version: "0.5.7",
      scheduled_for: "2026-06-02T01:00:00Z",
      created_at: "2026-06-02T01:00:00Z",
      prompt_tokens: 0,
      completion_tokens: 0,
      attempts: [],
    });
    rerender(<Header />);

    const after = screen.getByLabelText(S.schedules.open);
    // Same button, same cluster width; only the accent colour and a 6px dot.
    expect(after.tagName).toBe("BUTTON");
    expect(after.parentElement?.children.length).toBe(beforeChildCount);
    expect(after.querySelector("span")).toBeTruthy();
    expect(after.className).not.toBe(beforeClasses);
    expect(after.getAttribute("title")).toContain("nightly");
  });

  it("drops the badge once the run reaches a terminal state", () => {
    useScheduleStore.getState().upsertRun({
      id: "r1",
      action_id: "a1",
      action_name: "nightly",
      plan_sha256: "sha",
      trigger: "schedule",
      execution_mode: "headless",
      permission_mode: "auto_read",
      target_kind: "local_shell",
      target_label: "local shell",
      status: "succeeded",
      web_access: false,
      app_version: "0.5.7",
      scheduled_for: "2026-06-02T01:00:00Z",
      created_at: "2026-06-02T01:00:00Z",
      prompt_tokens: 0,
      completion_tokens: 0,
      attempts: [],
    });
    render(<Header />);
    expect(screen.getByLabelText(S.schedules.open).querySelector("span")).toBeNull();
  });
});
