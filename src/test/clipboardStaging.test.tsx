import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClipboardStaging } from "../hooks/useClipboardStaging";
import { MAX_ATTACHMENTS } from "../lib/attachments";
import { emptyAiStream, useAppStore } from "../stores/appStore";
import type { Attachment, Session } from "../lib/types";

const SID = "clipboard-hook";

function session(id: string): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
  };
}

function attachment(id: string): Attachment {
  return {
    id,
    kind: "text",
    name: `${id}.txt`,
    mediaType: "text/plain",
    bytes: 1,
    text: "x",
  };
}

function qualifyingPaste(prefix: string): string {
  return Array.from({ length: 6 }, (_, index) =>
    `${prefix} ${index + 1} ${"x".repeat(180)}`,
  ).join("\n");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pasteClipboard(target: HTMLElement, text: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "string", getAsFile: () => null }] as unknown as DataTransferItemList,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  fireEvent(target, event);
  return event;
}

function streamState() {
  const stream = Object.values(useAppStore.getState().aiStreams).shift();
  if (!stream) throw new Error("test session stream is missing");
  return stream;
}

function HookHarness({
  steering = false,
  pendingAttachments = [],
}: {
  steering?: boolean;
  pendingAttachments?: Attachment[];
}) {
  const clipboard = useClipboardStaging({ sessionId: SID, steering, pendingAttachments });
  return (
    <>
      <textarea
        ref={clipboard.inputRef}
        aria-label="Clipboard staging input"
        value={clipboard.input}
        onChange={clipboard.handleInputChange}
        onSelect={clipboard.handleInputSelection}
        onPaste={clipboard.handlePaste}
      />
      <button type="button" disabled={clipboard.pastedTextStaging}>
        Send
      </button>
      <span role="status">{clipboard.pasteAnnouncement}</span>
    </>
  );
}

beforeEach(() => {
  useAppStore.setState({
    sessions: [session(SID)],
    aiStreams: { [SID]: emptyAiStream() },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("useClipboardStaging", () => {
  it("fences submission until accepted pasted text is staged", async () => {
    const body = qualifyingPaste("deferred");
    const ingestion = deferred<ArrayBuffer>();
    vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValueOnce(ingestion.promise);
    render(<HookHarness />);
    const input = screen.getByRole("textbox", { name: "Clipboard staging input" });

    expect(pasteClipboard(input, body).defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await act(async () => {
      ingestion.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer);
      await ingestion.promise;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());

    const pending = streamState().pendingAttachments;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      name: "pasted-text-1.txt",
      origin: "pasted-text",
      text: body,
    });
    expect(screen.getByRole("status")).toHaveTextContent(/pasted-text-1\.txt attached/i);
  });

  it("does not announce success when the shared attachment limit rejects the paste", async () => {
    useAppStore
      .getState()
      .attachFilesToAi(
        SID,
        Array.from({ length: MAX_ATTACHMENTS }, (_, index) => attachment(`existing-${index}`)),
      );
    const pending = streamState().pendingAttachments;
    render(<HookHarness pendingAttachments={pending} />);

    pasteClipboard(
      screen.getByRole("textbox", { name: "Clipboard staging input" }),
      qualifyingPaste("over limit"),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());

    expect(streamState().pendingAttachments).toHaveLength(MAX_ATTACHMENTS);
    expect(streamState().attachError).toMatch(/not added/i);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("leaves qualifying text native while the active agent is steering", () => {
    render(<HookHarness steering />);

    const event = pasteClipboard(
      screen.getByRole("textbox", { name: "Clipboard staging input" }),
      qualifyingPaste("steer"),
    );

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(streamState().pendingAttachments).toEqual([]);
  });
});
