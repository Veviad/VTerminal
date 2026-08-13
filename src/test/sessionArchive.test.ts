import { beforeEach, describe, expect, it, vi } from "vitest";

const archivePutMock = vi.fn(async (_row: ArchiveSessionInput) => {});
const serializeMock = vi.fn((_id: string, lines: number) => ({ data: "SCREEN", lines }));

vi.mock("../lib/tauri", () => ({
  archivePut: (row: unknown) => archivePutMock(row as ArchiveSessionInput),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => ({ term: { cols: 120, rows: 40 } }),
  serializeSession: (id: string, lines: number) => serializeMock(id, lines),
}));

import { archiveOnClose, buildArchiveRow, toArchiveMessages } from "../lib/sessionArchive";
import { emptyAiStream, emptySessionUi, useAppStore } from "../stores/appStore";
import type { AiMessage, ArchiveSessionInput, Session } from "../lib/types";
import {
  protectRunbookTerminal,
  resetRunbookTerminalPrivacyForTests,
} from "../lib/runbookTerminalPrivacy";

function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: "/Users/me/proj",
    createdAt: "2026-08-01T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
    ...over,
  };
}

function seed(session: Session, messages: AiMessage[] = []) {
  useAppStore.setState({
    sessions: [session],
    activeSessionId: session.id,
    sessionUi: { [session.id]: emptySessionUi() },
    aiStreams: {
      [session.id]: { ...emptyAiStream(), messages, model: messages.length ? "Claude Opus 5" : null },
    },
    restoreScrollbackLines: 1000,
    scrollbackLines: 10000,
  });
}

const textMsg = (id: string, role: "user" | "assistant"): AiMessage => ({
  id,
  role,
  content: `content of ${id}`,
  createdAt: "2026-08-01T00:00:00.000Z",
});

const cardMsg = (id: string): AiMessage => ({
  id,
  role: "assistant",
  // A command card carries NO content — its payload is in `command`.
  content: "",
  createdAt: "2026-08-01T00:00:00.000Z",
  kind: "command",
  command: {
    command: "npm run build",
    output: "built ok",
    exitCode: 0,
    status: "done",
  },
});

beforeEach(() => {
  resetRunbookTerminalPrivacyForTests();
  archivePutMock.mockClear();
  archivePutMock.mockResolvedValue(undefined);
  serializeMock.mockClear();
  seed(makeSession("a"));
});

describe("toArchiveMessages", () => {
  it("maps text turns to the display shape", () => {
    const out = toArchiveMessages([textMsg("m1", "user"), textMsg("m2", "assistant")]);
    expect(out).toEqual([
      {
        role: "user",
        kind: "text",
        content: "content of m1",
        thinking: null,
        command: null,
        attachments: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      {
        role: "assistant",
        kind: "text",
        content: "content of m2",
        thinking: null,
        command: null,
        attachments: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  /** The bytes are already on disk and a text file's contents were folded into
   *  `content` at send time, so sending either here would duplicate the whole
   *  transcript inside a 500ms close budget. */
  it("archives attachment metadata and the disk path, never the bytes", () => {
    const out = toArchiveMessages([
      {
        ...textMsg("m1", "user"),
        attachments: [
          {
            id: "a1",
            kind: "image",
            name: "shot.png",
            mediaType: "image/png",
            bytes: 2048,
            data: "QQ==",
            width: 1568,
            height: 980,
            path: "/tmp/attachments/s1/a1.png",
          },
          {
            id: "a2",
            kind: "text",
            name: "run.log",
            mediaType: "text/plain",
            bytes: 12,
            text: "hello world",
          },
        ],
      },
    ]);

    expect(out[0].attachments).toEqual([
      {
        kind: "image",
        name: "shot.png",
        media_type: "image/png",
        bytes: 2048,
        path: "/tmp/attachments/s1/a1.png",
        width: 1568,
        height: 980,
      },
      {
        kind: "text",
        name: "run.log",
        media_type: "text/plain",
        bytes: 12,
        path: null,
        width: null,
        height: null,
      },
    ]);
    // The regression that would bloat the DB and blow the close budget.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("QQ==");
    expect(serialized).not.toContain("hello world");
  });

  it("keeps command cards even though their content is empty", () => {
    // Dropping empty-content messages would archive an agent run as a
    // conversation in which no commands were ever proposed.
    const out = toArchiveMessages([cardMsg("cmd-1")]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("command");
    expect(out[0].command).toEqual({
      command: "npm run build",
      output: "built ok",
      exit_code: 0,
      status: "done",
      note: null,
    });
  });

  it("keeps the TAIL of a long command output", () => {
    // The end of a command's output is what says whether it worked.
    const long = { ...cardMsg("cmd-1") };
    long.command = { ...long.command!, output: "x".repeat(9_000) + "THE-END" };
    const out = toArchiveMessages([long]);
    const stored = out[0].command!.output;
    expect(stored.endsWith("THE-END")).toBe(true);
    expect(stored.length).toBeLessThanOrEqual(8_192);
  });

  it("carries reasoning across", () => {
    const withThinking: AiMessage = { ...textMsg("m1", "assistant"), thinking: "pondering" };
    expect(toArchiveMessages([withThinking])[0].thinking).toBe("pondering");
  });
});

describe("buildArchiveRow", () => {
  it("returns null for a session that is already gone", () => {
    expect(buildArchiveRow("nope", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: true,
      withTranscript: true,
    })).toBeNull();
  });

  it("captures the buffer and the transcript on close", () => {
    seed(makeSession("a"), [textMsg("m1", "user")]);
    const row = buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: true,
      withTranscript: true,
    })!;
    expect(row.scrollback).toBe("SCREEN");
    expect(row.scrollback_lines).toBe(1000);
    expect(row.messages).toHaveLength(1);
    expect(row.is_open).toBe(false);
    expect(row.close_reason).toBe("closed");
    expect(row.opened_at).toBe("2026-08-01T00:00:00.000Z");
    expect(row.cols).toBe(120);
  });

  it("never archives raw scrollback from a runbook-bound terminal", () => {
    seed(makeSession("a"), [textMsg("m1", "user")]);
    protectRunbookTerminal("a");
    const row = buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: true,
      withTranscript: true,
    })!;
    expect(row.scrollback).toBe("");
    expect(row.scrollback_lines).toBe(0);
    expect(serializeMock).not.toHaveBeenCalled();
    expect(row.messages).toHaveLength(1);
  });

  it("sends null rather than empty for whatever it does not carry", () => {
    // null is the COALESCE signal meaning "keep what is stored". Sending an empty
    // array or string instead would wipe the other writer's work — the transcript
    // tick would erase the scrollback and vice versa.
    seed(makeSession("a"), [textMsg("m1", "user")]);
    const transcriptOnly = buildArchiveRow("a", {
      isOpen: true,
      closeReason: null,
      withScrollback: false,
      withTranscript: true,
    })!;
    expect(transcriptOnly.scrollback).toBeNull();
    expect(transcriptOnly.scrollback_lines).toBeNull();
    expect(transcriptOnly.messages).not.toBeNull();

    const blobOnly = buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: true,
      withTranscript: false,
    })!;
    expect(blobOnly.messages).toBeNull();
    expect(blobOnly.model_transcript).toBeNull();
    expect(blobOnly.model).toBeNull();
    expect(blobOnly.scrollback).toBe("SCREEN");
  });

  it("skips the buffer entirely when scrollback capture is off", () => {
    // The privacy switch has to hold on this path too, not just in Rust.
    seed(makeSession("a"));
    useAppStore.setState({ restoreScrollbackLines: 0 });
    const row = buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: true,
      withTranscript: true,
    })!;
    expect(row.scrollback).toBeNull();
    expect(serializeMock).not.toHaveBeenCalled();
  });

  it("stores only a sticky name, never a derived one", () => {
    // The rule that stops a tab opened in $HOME coming back permanently named
    // after the user.
    seed(makeSession("a", { userTitle: null, aiTitle: null, hostLabel: null }));
    expect(buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: false,
      withTranscript: false,
    })!.title).toBe("");

    seed(makeSession("a", { userTitle: "my rename" }));
    expect(buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: false,
      withTranscript: false,
    })!.title).toBe("my rename");
  });

  it("supersedes the row it was reopened from, but only once the run is over", () => {
    seed(makeSession("a", { archivedFrom: "older-run" }));
    const onClose = buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: false,
      withTranscript: false,
    })!;
    expect(onClose.supersedes).toBe("older-run");

    // On the periodic tick it must NOT: that would delete the archived original
    // while the user may still want to reopen it again.
    const onTick = buildArchiveRow("a", {
      isOpen: true,
      closeReason: null,
      withScrollback: false,
      withTranscript: true,
    })!;
    expect(onTick.supersedes).toBeNull();
  });

  it("records a remote target for the banner without claiming a live connection", () => {
    seed(makeSession("a"));
    useAppStore.setState({
      sessionUi: { a: { ...emptySessionUi(), remote: { kind: "ssh", target: "prod-01" } } },
    });
    const row = buildArchiveRow("a", {
      isOpen: false,
      closeReason: "closed",
      withScrollback: false,
      withTranscript: false,
    })!;
    expect(row.remote_kind).toBe("ssh");
    expect(row.remote_target).toBe("prod-01");
  });
});

describe("archiveOnClose", () => {
  it("writes one row with everything", async () => {
    seed(makeSession("a"), [textMsg("m1", "user"), cardMsg("cmd-1")]);
    await archiveOnClose("a");
    expect(archivePutMock).toHaveBeenCalledTimes(1);
    const row = archivePutMock.mock.calls[0][0];
    expect(row.messages).toHaveLength(2);
    expect(row.scrollback).toBe("SCREEN");
    expect(row.model).toBe("Claude Opus 5");
  });

  it("never throws when the backend fails", async () => {
    // closeSession awaits this. A rejection here would leave a tab the user
    // cannot close, with its terminal never disposed.
    archivePutMock.mockRejectedValue(new Error("db is on fire"));
    await expect(archiveOnClose("a")).resolves.toBeUndefined();
  });

  it("is a no-op for an unknown session", async () => {
    await archiveOnClose("nope");
    expect(archivePutMock).not.toHaveBeenCalled();
  });
});
