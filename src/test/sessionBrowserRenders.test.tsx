import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The browser fetches on mount, so unlike AiPanel this one DOES need the IPC
// mocked — and the mount fetch is the whole feature, so a silent failure here is
// an empty list that looks like "you have no past sessions".
const archiveListMock = vi.fn(async () => rows);
const archiveDeleteMock = vi.fn(async (_id: string) => {});
const archiveGetMock = vi.fn(async (_id: string) => null);

vi.mock("../lib/tauri", () => ({
  archiveList: () => archiveListMock(),
  archiveDelete: (id: string) => archiveDeleteMock(id),
  archiveGet: (id: string) => archiveGetMock(id),
  archiveScrollback: async () => null,
  archiveTranscript: async () => [],
  // Pulled in transitively by useSessions.
  ptyKill: async () => {},
  ptySpawn: async () => {},
  historyRecord: async () => "",
  saveSettings: async () => {},
  aiCancel: async () => {},
  archivePut: async () => {},
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => undefined,
  getOrCreateTerm: () => ({ term: { cols: 80, rows: 24 }, fit: { fit() {} }, container: {} }),
  disposeTerm: () => {},
  serializeSession: () => null,
  subscribeTerm: () => () => {},
  replayScrollback: async () => {},
  acquireWebgl: () => {},
  releaseWebgl: () => {},
  updateAllTermOptions: () => {},
}));

import { SessionBrowser } from "../components/sessions/SessionBrowser";
import { useAppStore } from "../stores/appStore";
import type { ArchiveSummary } from "../lib/types";

function row(over: Partial<ArchiveSummary> = {}): ArchiveSummary {
  return {
    session_id: "s1",
    title: "",
    shell: "/bin/zsh",
    cwd: "/Users/me/Code/proj",
    host_id: null,
    remote_kind: null,
    remote_target: null,
    opened_at: "2026-08-01T00:00:00.000Z",
    closed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    close_reason: "closed",
    scrollback_lines: 1420,
    message_count: 8,
    agent_command_count: 2,
    history_command_count: 12,
    model: "",
    has_model_transcript: true,
    first_prompt: "why is the build failing?",
    ...over,
  };
}

let rows: ArchiveSummary[] = [];

beforeEach(() => {
  rows = [row(), row({ session_id: "s2", cwd: "/Users/me/other", first_prompt: "deploy staging" })];
  archiveListMock.mockClear();
  archiveDeleteMock.mockClear();
  useAppStore.setState({
    sessionBrowserOpen: true,
    archiveMaxSessions: 50,
    archiveMaxAgeDays: 30,
    catalog: [],
    sessions: [],
    activeSessionId: null,
  });
});

describe("SessionBrowser", () => {
  it("lists archived sessions with their identifying metadata", async () => {
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    // The cwd leaf is the label, because a derived title is stored as "".
    expect(screen.getByText("other")).toBeTruthy();
    // The meta line has to say what the session was, including that output
    // exists. Both fixture rows have identical counters, so match per row.
    expect(screen.getAllByText(/12 cmds · 8 AI · 1420 lines/).length).toBe(2);
    expect(screen.getByText(/~\/Code\/proj · 12 cmds/)).toBeTruthy();
    expect(screen.getAllByText("2h ago").length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Reopen with chat" })).toHaveLength(2);
  });

  it("distinguishes chat restores from terminal-only history rows", async () => {
    rows = [row(), row({ session_id: "s2", message_count: 0, model: "" })];
    render(<SessionBrowser />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reopen terminal" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Reopen with chat" })).toBeTruthy();
  });

  it("shows a loading state, then the list — not an empty state", async () => {
    // "nothing saved" and "still loading" must never look the same.
    render(<SessionBrowser />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    expect(screen.queryByText(/No past sessions yet/)).toBeNull();
  });

  it("teaches the feature when the archive is empty", async () => {
    rows = [];
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText(/No past sessions yet/)).toBeTruthy());
  });

  it("surfaces a failed read instead of pretending the archive is empty", async () => {
    archiveListMock.mockRejectedValueOnce(new Error("db is on fire"));
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText(/db is on fire/)).toBeTruthy());
    expect(screen.queryByText(/No past sessions yet/)).toBeNull();
  });

  it("filters on everything that identifies a session, including the first prompt", async () => {
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());

    // "the session where I asked about the flaky build" is how people remember.
    fireEvent.change(screen.getByPlaceholderText("Search past sessions…"), {
      target: { value: "build failing" },
    });
    await waitFor(() => expect(screen.queryByText("other")).toBeNull());
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("says no MATCHING sessions rather than claiming the archive is empty", async () => {
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("Search past sessions…"), {
      target: { value: "zzzzz" },
    });
    await waitFor(() => expect(screen.getByText("No matching sessions")).toBeTruthy());
    expect(screen.queryByText(/No past sessions yet/)).toBeNull();
  });

  it("requires a second click to remove, and only then deletes", async () => {
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());

    await act(async () => {
      screen.getAllByTitle("Remove")[0].click();
    });
    expect(archiveDeleteMock).not.toHaveBeenCalled();
    // The row now advertises that a second click is destructive.
    await act(async () => {
      screen.getByTitle("Click again to remove").click();
    });
    await waitFor(() => expect(archiveDeleteMock).toHaveBeenCalledWith("s1"));
    // And it leaves the list without a refetch.
    await waitFor(() => expect(screen.queryByText("proj")).toBeNull());
  });

  it("states the retention policy in the footer, from live settings", async () => {
    useAppStore.setState({ archiveMaxSessions: 10, archiveMaxAgeDays: 7 });
    render(<SessionBrowser />);
    await waitFor(() =>
      expect(screen.getByText("Keeping the last 10 sessions for 7 days")).toBeTruthy(),
    );
  });

  it("marks a remote session by its target, never by the local cwd", async () => {
    rows = [row({ remote_kind: "ssh", remote_target: "prod-01" })];
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText("prod-01")).toBeTruthy());
    expect(screen.getByText(/ssh prod-01/)).toBeTruthy();
    expect(screen.queryByText(/~\/Code\/proj/)).toBeNull();
  });

  it("warns before the click that a session has no saved output", async () => {
    rows = [row({ scrollback_lines: 0 })];
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText(/no output saved/)).toBeTruthy());
  });

  it("closes on Escape without letting the keypress reach the window", async () => {
    render(<SessionBrowser />);
    await waitFor(() => expect(screen.getByText("proj")).toBeTruthy());

    const windowHandler = vi.fn();
    window.addEventListener("keydown", windowHandler);
    fireEvent.keyDown(screen.getByPlaceholderText("Search past sessions…"), { key: "Escape" });
    window.removeEventListener("keydown", windowHandler);

    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);
    // stopPropagation, so the window-level chain does not also close the NEXT
    // overlay in the same keypress.
    expect(windowHandler).not.toHaveBeenCalled();
  });
});
