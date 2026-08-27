import { describe, expect, it } from "vitest";
import { collapseHome, metaLine, sessionLabel } from "../lib/sessionArchiveView";
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
    closed_at: "2026-08-01T01:00:00.000Z",
    close_reason: "closed",
    scrollback_lines: 1420,
    message_count: 0,
    agent_command_count: 0,
    history_command_count: 0,
    model: "",
    has_model_transcript: false,
    first_prompt: null,
    ...over,
  };
}

describe("collapseHome", () => {
  it("shortens a home path on macOS and Linux", () => {
    expect(collapseHome("/Users/me/Code/proj")).toBe("~/Code/proj");
    expect(collapseHome("/home/me/src")).toBe("~/src");
  });

  it("collapses the home directory itself", () => {
    expect(collapseHome("/Users/me")).toBe("~");
  });

  it("leaves anything else alone", () => {
    expect(collapseHome("/etc/nginx")).toBe("/etc/nginx");
    expect(collapseHome("/var/log")).toBe("/var/log");
  });
});

describe("sessionLabel", () => {
  it("falls back to the cwd leaf when there is no sticky title", () => {
    // Most rows arrive with title === "": a derived label is deliberately stored
    // empty so it is re-derived rather than pinned forever. That persistence rule
    // is what produced the "every tab is called maholick" bug, so this fallback
    // is not optional.
    expect(sessionLabel(row())).toBe("proj");
  });

  it("prefers a sticky title over everything", () => {
    expect(sessionLabel(row({ title: "my rename" }))).toBe("my rename");
  });

  it("uses the remote target before the local cwd", () => {
    expect(sessionLabel(row({ remote_target: "prod-01" }))).toBe("prod-01");
  });

  it("has a last resort when there is no title and no cwd", () => {
    expect(sessionLabel(row({ cwd: null }))).toBe("Untitled session");
  });
});

describe("metaLine", () => {
  it("composes the identifying facts, newest-relevant last", () => {
    const line = metaLine(
      row({ history_command_count: 12, message_count: 8, model: "anthropic/claude-opus-5" }),
      "Claude Opus 5",
    );
    expect(line).toBe("~/Code/proj · 12 cmds · 8 AI · 1420 lines · Claude Opus 5");
  });

  it("shows the remote target INSTEAD of the local cwd", () => {
    // The stored cwd describes another machine, so presenting it would be a lie —
    // the same withholding rule the AI context and the tab title already follow.
    const line = metaLine(row({ remote_kind: "ssh", remote_target: "prod-01" }), null);
    expect(line).toContain("ssh prod-01");
    expect(line).not.toContain("~/Code/proj");
  });

  it("makes the absence of a saved AI chat explicit", () => {
    expect(metaLine(row(), null)).toBe(
      "~/Code/proj · no AI chat saved · 1420 lines",
    );
  });

  it("always says when no output was saved", () => {
    // The ABSENCE of output is what the user needs to know BEFORE clicking
    // Reopen, not after the screen comes back empty.
    expect(metaLine(row({ scrollback_lines: 0 }), null)).toContain("no output saved");
  });

  it("marks a session that ended in a crash", () => {
    expect(metaLine(row({ close_reason: "crash" }), null)).toContain("after an unexpected quit");
  });

  it("names the model only when there is a transcript for it to describe", () => {
    expect(metaLine(row({ message_count: 0, model: "x" }), "Claude Opus 5")).not.toContain(
      "Claude Opus 5",
    );
    expect(metaLine(row({ message_count: 3, model: "x" }), "Claude Opus 5")).toContain(
      "Claude Opus 5",
    );
  });
});
