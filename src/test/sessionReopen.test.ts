import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveGetMock = vi.fn();
const archiveScrollbackMock = vi.fn();
const archiveTranscriptMock = vi.fn();
const archivePutMock = vi.fn();
const hydrateAttachmentsMock = vi.fn(async (_sessionId: string) => {});
const focusMock = vi.fn();

vi.mock("../lib/tauri", () => ({
  archiveGet: (id: string) => archiveGetMock(id),
  archiveScrollback: (id: string) => archiveScrollbackMock(id),
  archiveTranscript: (id: string) => archiveTranscriptMock(id),
  archivePut: (row: ArchiveSessionInput) => archivePutMock(row),
}));

vi.mock("../lib/attachInput", () => ({
  hydrateAttachments: (sessionId: string) => hydrateAttachmentsMock(sessionId),
}));

vi.mock("../lib/aiPanel", () => ({
  setAiPanelOpen: vi.fn(),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: () => ({ term: { cols: 120, rows: 40, focus: focusMock } }),
  serializeSession: vi.fn(),
}));

import { reopenSession } from "../lib/sessionReopen";
import { useAppStore } from "../stores/appStore";
import type {
  ArchiveDetail,
  ArchiveSessionInput,
  LaunchSpec,
  Session,
} from "../lib/types";

const SOURCE_PATH = "/app-data/attachments/source/image.png";

const detail: ArchiveDetail = {
  summary: {
    session_id: "source",
    title: "source tab",
    shell: "/bin/zsh",
    cwd: "/Users/me/project",
    host_id: null,
    remote_kind: null,
    remote_target: null,
    opened_at: "2026-08-01T00:00:00.000Z",
    closed_at: "2026-08-01T01:00:00.000Z",
    close_reason: "closed",
    scrollback_lines: 0,
    message_count: 1,
    agent_command_count: 0,
    history_command_count: 0,
    model: "local-balanced",
    has_model_transcript: false,
    first_prompt: "look at this",
  },
  messages: [
    {
      id: "source:0",
      sort_order: 0,
      role: "user",
      kind: "text",
      content: "look at this",
      thinking: null,
      command: null,
      attachments: [
        {
          id: "source:0:0",
          kind: "image",
          name: "image.png",
          media_type: "image/png",
          bytes: 5,
          path: SOURCE_PATH,
          width: 1,
          height: 1,
        },
      ],
      created_at: "2026-08-01T00:00:01.000Z",
    },
  ],
};

let nextSession = 0;

async function createSession(spec: LaunchSpec = {}): Promise<string> {
  const id = `replacement-${++nextSession}`;
  const session: Session = {
    id,
    shell: spec.shell ?? "/bin/zsh",
    cwd: spec.cwd ?? null,
    createdAt: "2026-08-02T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: spec.hostId ?? null,
    hostLabel: null,
    userTitle: spec.userTitle ?? null,
    aiTitle: null,
    ordinal: nextSession,
    archivedFrom: spec.archivedFrom ?? null,
  };
  useAppStore.getState().addSession(session);
  return id;
}

beforeEach(() => {
  nextSession = 0;
  archiveGetMock.mockReset();
  archiveGetMock.mockResolvedValue(detail);
  archiveScrollbackMock.mockReset();
  archiveScrollbackMock.mockResolvedValue(null);
  archiveTranscriptMock.mockReset();
  archiveTranscriptMock.mockResolvedValue([]);
  archivePutMock.mockReset();
  archivePutMock.mockResolvedValue(undefined);
  hydrateAttachmentsMock.mockClear();
  focusMock.mockClear();
  useAppStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionUi: {},
    aiStreams: {},
    restoreScrollbackLines: 1_000,
    scrollbackLines: 10_000,
  });
});

describe("reopenSession attachment ownership", () => {
  it("registers both live reopens before returning either tab", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    archivePutMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        }),
    );

    let firstSettled = false;
    const firstReopen = reopenSession("source", createSession).then((id) => {
      firstSettled = true;
      return id;
    });
    await vi.waitFor(() => expect(archivePutMock).toHaveBeenCalledTimes(1));
    expect(firstSettled).toBe(false);
    expect(hydrateAttachmentsMock).not.toHaveBeenCalled();

    releaseFirstWrite?.();
    await expect(firstReopen).resolves.toBe("replacement-1");
    await expect(reopenSession("source", createSession)).resolves.toBe("replacement-2");

    expect(archivePutMock).toHaveBeenCalledTimes(2);
    const rows = archivePutMock.mock.calls.map(([row]) => row as ArchiveSessionInput);
    expect(rows.map((row) => row.session_id)).toEqual(["replacement-1", "replacement-2"]);
    for (const row of rows) {
      expect(row.is_open).toBe(true);
      expect(row.supersedes).toBeNull();
      expect(row.messages?.[0].attachments?.[0].path).toBe(SOURCE_PATH);
    }
    expect(hydrateAttachmentsMock).toHaveBeenCalledTimes(2);
  });
});

describe("reopenSession command provenance", () => {
  it("restores archived Sidecar labels without reviving an old PTY binding", async () => {
    const commandDetail: ArchiveDetail = {
      summary: {
        ...detail.summary,
        message_count: 1,
        agent_command_count: 1,
        first_prompt: null,
      },
      messages: [
        {
          id: "source:0",
          sort_order: 0,
          role: "assistant",
          kind: "command",
          content: "",
          thinking: null,
          command: {
            command: "docker compose up -d api",
            output: "Container api Started",
            exit_code: 0,
            status: "done",
            note: null,
            output_policy: "normal",
            target_role: "remote",
            target_label: "deploy@prod-01",
          },
          attachments: [],
          created_at: "2026-08-01T00:00:01.000Z",
        },
      ],
    };
    archiveGetMock.mockResolvedValueOnce(commandDetail);

    await expect(reopenSession("source", createSession)).resolves.toBe("replacement-1");

    const restored = useAppStore.getState().aiStreams["replacement-1"].messages[0].command;
    expect(restored).toMatchObject({
      outputPolicy: "normal",
      targetRole: "remote",
      targetLabel: "deploy@prod-01",
    });
    expect(restored).not.toHaveProperty("targetSessionId");

    // Reopen immediately registers a live replacement archive. Provenance must
    // survive that second serialization too, rather than disappearing after
    // one reopen/close cycle.
    const replacement = archivePutMock.mock.calls[0][0] as ArchiveSessionInput;
    expect(replacement.messages?.[0].command).toMatchObject({
      output_policy: "normal",
      target_role: "remote",
      target_label: "deploy@prod-01",
    });
  });
});
