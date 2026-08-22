import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyAiStream, useAppStore } from "../stores/appStore";
import { AiPanel } from "../components/ai/AiPanel";
import { S } from "../lib/strings";
import * as api from "../lib/tauri";
import type { CatalogEntry, Session } from "../lib/types";

// The AI panel is unmounted entirely when `settingsLoaded` is false, so a bug in
// the readiness selectors presents as "the chat window doesn't open" rather than
// as an error. This mounts the real panel against the real store to prove the
// selectors don't throw and the panel actually renders for BOTH model kinds.
//
// No IPC mock: nothing invokes Tauri during render, only in event handlers.

function cloudEntry(): CatalogEntry {
  return {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    tier: "balanced",
    label: "Claude Sonnet 5",
    description: "",
    wire_model: "claude-sonnet-5",
    context_tokens: 1_000_000,
    efforts: ["off", "low", "medium", "high", "max"],
    default_effort: "high",
    supports_temperature: false,
    native_web_fetch: true,
    supports_vision: true,
    local: null,
    remote: null,
    fits: true,
    downloaded: false,
    configured: true,
    effort: "high",
  };
}

function session(id: string): Session {
  return {
    id,
    shell: "/bin/zsh",
    cwd: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
  };
}

// jsdom implements no scroll geometry; the panel autoscrolls on mount.
Element.prototype.scrollTo = vi.fn();

function pasteClipboard(
  target: HTMLElement,
  text: string,
  items: Array<Pick<DataTransferItem, "kind" | "getAsFile">> = [
    { kind: "string", getAsFile: () => null },
  ],
): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: items as unknown as DataTransferItemList,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  fireEvent(target, event);
  return event;
}

function qualifyingPaste(prefix: string): string {
  return Array.from({ length: 6 }, (_, i) => `${prefix} ${i + 1} ${"x".repeat(180)}`).join("\n");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function utf8Buffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function seedReadyPanel(over: Partial<ReturnType<typeof emptyAiStream>> = {}): void {
  useAppStore.setState({
    sessions: [session("s1")],
    catalog: [cloudEntry()],
    activeModelId: "anthropic/claude-sonnet-5",
    hasApiKey: { anthropic: true },
    aiStreams: { s1: { ...emptyAiStream(), ...over } },
  });
}

describe("AiPanel renders", () => {
  beforeEach(() => {
    useAppStore.setState({
      settingsLoaded: true,
      aiPanelOpen: true,
      aiPanelRatio: 0.3,
      catalog: [],
      hasApiKey: {},
      modelEffort: {},
      loadedModelId: null,
      modelState: "idle",
      activeModelId: "local/qwen3.5-9b",
      sessionUi: {},
      aiStreams: {},
      sidecars: {},
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("renders with an API model selected and a key present", () => {
    useAppStore.setState({
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
    });
    render(<AiPanel sessionId="s1" />);
    // Mode switcher present => the panel body rendered, not the collapsed rail.
    expect(screen.getByRole("button", { name: /agent/i })).toBeTruthy();
    // Effort picker driven by the model's own ladder. It is a dropdown in this header
    // (five rungs do not fit beside the mode tabs, the permission control and Docs), so
    // the trigger shows the current rung and the ladder is one click away.
    const effort = screen.getByRole("button", { name: S.effort.label });
    expect(effort.textContent).toContain(S.effort.high);
    fireEvent.click(effort);
    for (const rung of [S.effort.off, S.effort.medium, S.effort.max]) {
      expect(screen.getByRole("option", { name: new RegExp(rung) })).toBeTruthy();
    }
  });

  /** The permission control is agent-only: in ask mode there is nothing to
   *  approve, so offering "run everything without asking" would be meaningless. */
  it("hides the permission modes outside agent mode", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: { s1: { ...emptyAiStream(), mode: "ask" } },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.queryByRole("button", { name: S.aiPanel.permissionLabel })).toBeNull();
  });

  it("offers three permission modes in agent mode, defaulting to the safe one", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: { s1: { ...emptyAiStream(), mode: "agent" } },
    });
    render(<AiPanel sessionId="s1" />);
    // The state is visible WITHOUT opening the menu. This is the assertion that keeps a
    // safety control safe to collapse: hiding the options is fine, hiding which mode is
    // armed is not.
    const trigger = screen.getByRole("button", { name: S.aiPanel.permissionLabel });
    expect(trigger.textContent).toContain(S.aiPanel.permission.ask);

    fireEvent.click(trigger);
    for (const label of [
      S.aiPanel.permission.ask,
      S.aiPanel.permission.auto_read,
      S.aiPanel.permission.auto_all,
    ]) {
      expect(screen.getByRole("option", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(
      screen.getByRole("option", { name: new RegExp(S.aiPanel.permission.ask) })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("option", { name: new RegExp(S.aiPanel.permission.auto_all) })
        .getAttribute("aria-selected"),
    ).toBe("false");
  });

  /** THE condition on collapsing a safety control into a dropdown.
   *
   *  The permission modes moved behind a trigger because three segmented controls do not
   *  fit a 420px panel. That is only acceptable while the ARMED MODE is legible without
   *  opening anything — CLAUDE.md's stance is that arming auto-accept is a deliberate,
   *  visible act, and a control that shows "Confirm" while running everything would break
   *  it. Asserted for each mode, closed, plus the warning styling that makes `All` read
   *  differently from the other two at a glance. */
  it("shows which permission mode is armed without opening the menu", () => {
    for (const [mode, label] of [
      ["ask", S.aiPanel.permission.ask],
      ["auto_read", S.aiPanel.permission.auto_read],
      ["auto_all", S.aiPanel.permission.auto_all],
    ] as const) {
      useAppStore.setState({
        sessions: [session("s1")],
        aiStreams: { s1: { ...emptyAiStream(), mode: "agent", permissionMode: mode } },
      });
      const { unmount } = render(<AiPanel sessionId="s1" />);
      const trigger = screen.getByRole("button", { name: S.aiPanel.permissionLabel });

      expect(trigger.textContent).toContain(label);
      // Closed: the options are not in the document at all.
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      // And the one mode that runs writes unattended is the one that looks different.
      expect(trigger.className.includes("warning")).toBe(mode === "auto_all");
      unmount();
    }
  });

  /** Each auto mode states what it will do unattended, and the two banners make
   *  deliberately different promises — "reads run without asking" is not
   *  "everything runs without asking". */
  it("banners Reads mode without claiming everything auto-runs", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: { s1: { ...emptyAiStream(), mode: "agent", permissionMode: "auto_read" } },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText(/Read-only commands run without asking/i)).toBeTruthy();
    expect(screen.queryByText(/Auto-accept is ON/i)).toBeNull();
  });

  it("banners All mode with the standing warning", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: { s1: { ...emptyAiStream(), mode: "agent", permissionMode: "auto_all" } },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText(/Auto-accept is ON/i)).toBeTruthy();
  });

  /** A card standing while "Reads" is armed has to say why, or the mode reads as
   *  broken every time it correctly stops for a write. */
  it("explains a card that Reads mode declined to auto-run", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          status: "awaiting_approval",
          requestId: "req-1",
          permissionMode: "auto_read",
          pendingProposal: {
            approvalId: "ap1",
            command: "curl https://example.com",
            explanation: "fetch the page",
            readOnly: true,
            network: true,
          },
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText(/asking: this reaches the network/i)).toBeTruthy();
  });

  it("keeps local and remote destinations visible on completed command cards", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      sidecars: {},
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          messages: [
            {
              id: "cmd-local",
              role: "assistant",
              kind: "command",
              content: "",
              createdAt: "2026-08-22T00:00:00.000Z",
              command: {
                command: "gh issue view 42",
                output: "Issue 42",
                exitCode: 0,
                status: "done",
                targetRole: "local",
                targetSessionId: "s1",
                targetLabel: "~/code/project",
              },
            },
            {
              id: "cmd-remote",
              role: "assistant",
              kind: "command",
              content: "",
              createdAt: "2026-08-22T00:01:00.000Z",
              command: {
                command: "docker compose config",
                output: "valid",
                exitCode: 0,
                status: "done",
                targetRole: "remote",
                targetSessionId: "remote",
                targetLabel: "Production",
              },
            },
          ],
        },
      },
    });

    render(<AiPanel sessionId="s1" />);

    expect(
      screen.getByLabelText("Local command destination ~/code/project"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Remote command destination Production"),
    ).toBeInTheDocument();
  });

  it("renders the key hint instead of the load hint for an API model", () => {
    useAppStore.setState({
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: false },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText(/Add an API key/i)).toBeTruthy();
  });

  /** A staged image on a model that cannot see one blocks Send outright. The
   *  failure this prevents is silent: an answer about an image the model never
   *  received looks exactly like an answer about one it did. */
  it("blocks Send and warns when the active model cannot read a staged image", () => {
    const localOnly: CatalogEntry = { ...cloudEntry(), supports_vision: false };
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [localOnly],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          pendingAttachments: [
            {
              id: "a1",
              kind: "image",
              name: "shot.png",
              mediaType: "image/png",
              bytes: 10,
              data: "QQ==",
            },
          ],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);

    expect(screen.getByText(/cannot read images/i)).toBeTruthy();
    // The chip is still there — the images are never dropped behind the user's
    // back, they are held until the model changes or the user removes them.
    expect(screen.getByText("shot.png")).toBeTruthy();
  });

  it("allows a staged image on a vision model", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          pendingAttachments: [
            {
              id: "a1",
              kind: "image",
              name: "shot.png",
              mediaType: "image/png",
              bytes: 10,
              data: "QQ==",
            },
          ],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.queryByText(/cannot read images/i)).toBeNull();
    expect(screen.getByText("shot.png")).toBeTruthy();
  });

  it("leaves a short clipboard text paste to the native textarea path", () => {
    seedReadyPanel();
    render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Ask about your terminal/i);

    const event = pasteClipboard(box, "one\ntwo\nthree\nfour\nfive\n");

    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().aiStreams.s1.pendingAttachments).toEqual([]);
  });

  it("turns rapid large text pastes into distinct ordered attachments and announces success", async () => {
    seedReadyPanel();
    render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Ask about your terminal/i);
    const first = qualifyingPaste("first");
    const second = qualifyingPaste("second");

    expect(pasteClipboard(box, first).defaultPrevented).toBe(true);
    expect(pasteClipboard(box, second).defaultPrevented).toBe(true);

    await waitFor(() => {
      expect(
        useAppStore.getState().aiStreams.s1.pendingAttachments.map((attachment) => [
          attachment.name,
          attachment.text,
        ]),
      ).toEqual([
        ["pasted-text-1.txt", first],
        ["pasted-text-2.txt", second],
      ]);
    });
    expect(box).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(
      /pasted-text-2\.txt attached from pasted text, 6 lines/i,
    );
    expect(
      screen.getByRole("button", { name: "Show pasted-text-1.txt as text" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove pasted-text-1.txt" }),
    ).toBeTruthy();
  });

  it("does not announce an old session paste after the panel switches sessions", async () => {
    useAppStore.setState({
      sessions: [session("s1"), session("s2")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: { s1: emptyAiStream(), s2: emptyAiStream() },
    });
    const body = qualifyingPaste("old session");
    const ingestion = deferred<ArrayBuffer>();
    vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValueOnce(ingestion.promise);
    const view = render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Ask about your terminal/i);

    expect(pasteClipboard(box, body).defaultPrevented).toBe(true);
    view.rerender(<AiPanel sessionId="s2" />);
    const secondBox = screen.getByPlaceholderText(/Ask about your terminal/i);
    fireEvent.change(secondBox, { target: { value: "question for session two" } });
    // Session one's in-flight Blob must not disable an unrelated composer.
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);

    await act(async () => {
      ingestion.resolve(utf8Buffer(body));
      await ingestion.promise;
    });

    await waitFor(() => {
      expect(useAppStore.getState().aiStreams.s1.pendingAttachments).toHaveLength(1);
    });
    expect(useAppStore.getState().aiStreams.s2.pendingAttachments).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it.each(["ask", "agent"] as const)(
    "waits for a large pasted attachment before submitting an existing %s prompt",
    async (mode) => {
      seedReadyPanel({ mode });
      const sendSpy =
        mode === "ask"
          ? vi.spyOn(api, "aiAsk").mockResolvedValue(undefined)
          : vi.spyOn(api, "agentStart").mockResolvedValue([]);
      const body = qualifyingPaste(`${mode} deferred`);
      const ingestion = deferred<ArrayBuffer>();
      vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValueOnce(ingestion.promise);
      render(<AiPanel sessionId="s1" />);
      const box = screen.getByPlaceholderText(
        mode === "ask" ? /Ask about your terminal/i : /Describe a goal/i,
      );
      fireEvent.change(box, { target: { value: "analyze this" } });

      expect(pasteClipboard(box, body).defaultPrevented).toBe(true);
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
      fireEvent.keyDown(box, { key: "Enter" });
      expect(sendSpy).not.toHaveBeenCalled();

      await act(async () => {
        ingestion.resolve(utf8Buffer(body));
        await ingestion.promise;
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
      });

      fireEvent.keyDown(box, { key: "Enter" });
      const expected =
        `analyze this\n\nAttached file — pasted-text-1.txt:\n\`\`\`\n${body}\n\`\`\``;
      await waitFor(() => expect(sendSpy).toHaveBeenCalledOnce());
      expect(sendSpy.mock.calls[0][1]).toBe(expected);
      expect(useAppStore.getState().aiStreams.s1.messages[0]).toMatchObject({
        role: "user",
        content: expected,
      });
      expect(useAppStore.getState().aiStreams.s1.pendingAttachments).toEqual([]);
    },
  );

  it("prefers a clipboard file over its large plain-text fallback", async () => {
    seedReadyPanel();
    render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Ask about your terminal/i);
    const file = new File(["the file body"], "notes.txt", { type: "text/plain" });
    const event = pasteClipboard(
      box,
      qualifyingPaste("fallback"),
      [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => file },
      ],
    );

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(
        useAppStore.getState().aiStreams.s1.pendingAttachments.map((attachment) =>
          attachment.name,
        ),
      ).toEqual(["notes.txt"]);
    });
    expect(useAppStore.getState().aiStreams.s1.pendingAttachments[0].origin).toBeUndefined();
  });

  it("keeps a large text paste native while composing an active steer", () => {
    seedReadyPanel({ mode: "agent", status: "streaming", requestId: "req-1" });
    render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Redirect the agent/i);

    const event = pasteClipboard(box, qualifyingPaste("steer"));

    expect(event.defaultPrevented).toBe(false);
    expect(useAppStore.getState().aiStreams.s1.pendingAttachments).toEqual([]);
  });

  it("allows a non-empty text attachment to send alone but still requires text for an image", () => {
    seedReadyPanel({
      pendingAttachments: [
        {
          id: "text-1",
          kind: "text",
          name: "notes.txt",
          mediaType: "text/plain",
          bytes: 5,
          text: "hello",
        },
      ],
    });
    const first = render(<AiPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    first.unmount();

    seedReadyPanel({
      pendingAttachments: [
        {
          id: "image-1",
          kind: "image",
          name: "screen.png",
          mediaType: "image/png",
          bytes: 4,
          data: "QQ==",
        },
      ],
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("keeps attachment-only Send disabled while a sidecar target is degraded", () => {
    seedReadyPanel({
      mode: "agent",
      pendingAttachments: [
        {
          id: "text-1",
          kind: "text",
          name: "notes.txt",
          mediaType: "text/plain",
          bytes: 5,
          text: "hello",
        },
      ],
    });
    useAppStore.setState({
      sessions: [session("s1"), session("s2")],
      sidecars: {
        s1: {
          ownerSessionId: "s1",
          localSessionId: "s1",
          remoteSessionId: "s2",
          remoteIdentity: {
            kind: "ssh",
            target: "deploy@example.com",
            hostId: "example-host",
            label: "Example",
          },
          permissions: { local: "ask", remote: "ask" },
          paneOrder: ["local", "remote"],
          splitRatio: 0.5,
          splitOrientation: "horizontal",
          focusedSessionId: "s1",
          degraded: { role: "remote", reason: "remote_disconnected" },
        },
      },
    });

    render(<AiPanel sessionId="s1" />);

    expect(screen.getByRole("textbox")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("shows pasted attachment text at the last selection, removes the chip, and restores the caret", async () => {
    const body = "one\ntwo\nthree\nfour\nfive\nsix";
    seedReadyPanel({
      pendingAttachments: [
        {
          id: "paste-1",
          kind: "text",
          name: "pasted-text-1.txt",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode(body).length,
          text: body,
          origin: "pasted-text",
          lineCount: 6,
        },
      ],
    });
    render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Ask about your terminal/i) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "before TARGET after" } });
    box.focus();
    box.setSelectionRange(7, 13);
    fireEvent.select(box);

    fireEvent.click(
      screen.getByRole("button", { name: "Show pasted-text-1.txt as text" }),
    );

    await waitFor(() => expect(box).toHaveValue(`before ${body} after`));
    expect(useAppStore.getState().aiStreams.s1.pendingAttachments).toEqual([]);
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(7 + body.length);
    expect(box.selectionEnd).toBe(7 + body.length);
    expect(screen.getByRole("status")).toHaveTextContent(
      /pasted-text-1\.txt inserted into the message as text/i,
    );
  });

  /** The transcript/attached-file text is machinery the MODEL needed. It must not
   *  dominate the user's own message — collapsed by default, expandable on click. */
  it("collapses a folded transcript block and expands it on click", () => {
    const folded =
      "What is this about?\n\n[image: shot.png — transcribed on-device by Qwen3-VL 4B]\n" +
      "```\nDeployment Failed\nexit code: 1\n```";
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          messages: [
            {
              id: "m1",
              role: "user",
              content: folded,
              createdAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);

    // The user's own question is visible; the transcript body is not.
    expect(screen.getByText(/What is this about\?/)).toBeTruthy();
    expect(screen.queryByText(/Deployment Failed/)).toBeNull();

    // The section names what it is holding, collapsed.
    const toggle = screen.getByRole("button", { expanded: false, name: /shot\.png/ });
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.getByText(/Deployment Failed/)).toBeTruthy();
  });

  it("renders an ordinary message unchanged", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          messages: [
            {
              id: "m1",
              role: "user",
              content: "just a question",
              createdAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText("just a question")).toBeTruthy();
  });

  it("renders before the catalog has loaded", () => {
    // Boot order: the panel mounts as soon as settings hydrate, which is before
    // models_catalog resolves. An empty catalog must not blank the panel.
    useAppStore.setState({ catalog: [], activeModelId: "local/qwen3.5-9b" });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: /agent/i })).toBeTruthy();
    expect(screen.getByText(/Load a model/i)).toBeTruthy();
  });

  it("renders with a null session", () => {
    render(<AiPanel sessionId={null} />);
    expect(screen.getByRole("button", { name: /agent/i })).toBeTruthy();
  });

  it("offers New chat only once there is a conversation to clear", () => {
    render(<AiPanel sessionId="s1" />);
    // Present but inert on a fresh tab: nothing to archive, nothing to wipe.
    expect(screen.getByRole("button", { name: /new chat/i })).toHaveProperty("disabled", true);
  });

  it("agent mode stays typeable mid-run, with Stop AND Send both offered", () => {
    // Steering only works because the composer is live while the run is: a
    // disabled textarea is the thing this feature removes.
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: { ...emptyAiStream(), mode: "agent", status: "streaming", requestId: "req-1" },
      },
    });
    render(<AiPanel sessionId="s1" />);

    const box = screen.getByPlaceholderText(/Redirect the agent/i);
    expect(box).toHaveProperty("disabled", false);
    // Stop must never be taken away — it is the only way out of a run.
    expect(screen.getByTitle(/^Stop$/)).toBeTruthy();
    expect(screen.getByTitle(/picks this up at its next step/i)).toBeTruthy();
  });

  it("ask mode stays locked while it streams", () => {
    // One provider call, no round boundary — there is nothing to inject into,
    // and the disabled box is what teaches that difference.
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: { ...emptyAiStream(), mode: "ask", status: "streaming", requestId: "req-1" },
      },
    });
    render(<AiPanel sessionId="s1" />);

    expect(screen.getByPlaceholderText(/Ask about your terminal/i)).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByTitle(/picks this up at its next step/i)).toBeNull();
  });

  it("an approval card says a steer is waiting and offers Skip & send", () => {
    // The loop is parked on this gate, so the message genuinely cannot land
    // until the round ends. Silence here reads as the app ignoring the user.
    useAppStore.setState({
      sessions: [session("s1")],
      catalog: [cloudEntry()],
      activeModelId: "anthropic/claude-sonnet-5",
      hasApiKey: { anthropic: true },
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          status: "awaiting_approval",
          requestId: "req-1",
          pendingProposal: {
            approvalId: "ap1",
            command: "ls",
            explanation: "list",
            readOnly: true,
            network: false,
          },
          steerQueue: [{ id: "st1", text: "check the logs instead" }],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);

    expect(screen.getByText(/1 message waiting/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /skip & send/i })).toBeTruthy();
  });

  it("an undelivered steer keeps its text and offers to resend it", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          messages: [
            {
              id: "msg-steer-st1",
              role: "user",
              content: "use ripgrep instead",
              createdAt: "2026-08-01T00:00:00.000Z",
              steer: "undelivered",
            },
          ],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);

    expect(screen.getByText(/use ripgrep instead/i)).toBeTruthy();
    expect(screen.getByText(/Not delivered/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /send as a new message/i })).toBeTruthy();
  });

  it("enables New chat once the panel holds a message", () => {
    useAppStore.setState({
      sessions: [
        {
          id: "s1",
          shell: "/bin/zsh",
          cwd: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          exited: false,
          exitCode: null,
          hostId: null,
          hostLabel: null,
          userTitle: null,
          aiTitle: null,
          ordinal: 1,
        },
      ],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          messages: [
            {
              id: "m1",
              role: "user",
              content: "why is the build failing",
              createdAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: /new chat/i })).toHaveProperty("disabled", false);
  });

  /** A run stopped at the step limit is a checkpoint, not a failure: it offers a
   *  real control and deliberately avoids the red error line. */
  it("offers Continue on a paused run, without the error banner", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          status: "paused",
          pause: { reason: "step_limit", steps: 10, limit: 10 },
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(screen.getByText(/Paused after 10 steps/i)).toBeTruthy();
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  /** The reported limit must be one the user can find in Settings. A steer extends
   *  the budget up to 3x, and naming only the extended number was the original bug. */
  it("explains a step count that a mid-run steer pushed past the configured limit", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          status: "paused",
          pause: { reason: "step_limit", steps: 30, limit: 10 },
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText(/your limit is 10, extended because you sent a message mid-run/i))
      .toBeTruthy();
  });

  /** THE safety property. Arming an auto mode narrows which COMMANDS need a click;
   *  it must never resume a run that spent its budget, or the step cap becomes no
   *  cap at all, unattended. Nothing polls the paused state and the `Paused` event
   *  arm never reads `permissionMode` — this pins the outcome. */
  it("never auto-continues a paused run, even with All armed", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          status: "paused",
          permissionMode: "auto_all",
          pause: { reason: "step_limit", steps: 10, limit: 10 },
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    // Still parked, still asking. The button is the only way forward.
    expect(useAppStore.getState().aiStreams["s1"].status).toBe("paused");
    expect(useAppStore.getState().aiStreams["s1"].pause).not.toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  /** A context pause says so rather than blaming the step limit — the user's fix is
   *  a new conversation or a smaller task, not a bigger number in Settings. */
  it("names the context window when that is what ran out", () => {
    useAppStore.setState({
      sessions: [session("s1")],
      aiStreams: {
        s1: {
          ...emptyAiStream(),
          mode: "agent",
          status: "paused",
          pause: { reason: "context_limit", steps: 4, limit: 10 },
        },
      },
    });
    render(<AiPanel sessionId="s1" />);
    expect(screen.getByText(/context window/i)).toBeTruthy();
    expect(screen.queryByText(/Settings → Agent/)).toBeNull();
  });
});
