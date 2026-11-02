import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiPanel } from "../components/ai/AiPanel";
import { emptyAiStream, emptySessionUi, useAppStore } from "../stores/appStore";
import { S } from "../lib/strings";
import * as api from "../lib/tauri";
import * as ptyExec from "../lib/ptyExec";
import type { CatalogEntry, StreamEvent } from "../lib/types";
import { makeSession, makeSidecarBinding } from "./factories";

const terminals = vi.hoisted(() => new Map<string, {
  disposed: boolean;
  term: { cols: number; rows: number };
}>());
vi.mock("../lib/termRegistry", () => ({
  getTerm: (id: string) => terminals.get(id),
  subscribeTerm: () => () => {},
}));
vi.mock("../lib/terminalSnapshot", () => ({
  readLineRange: () => "",
  readScreenTail: () => "",
}));
vi.mock("../lib/sessionNaming", () => ({ nameSession: vi.fn() }));
vi.mock("../lib/sessionPersistence", () => ({
  markTranscriptCheckpoint: vi.fn(),
  markTranscriptDirty: vi.fn(),
}));

Element.prototype.scrollTo = vi.fn();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const model: CatalogEntry = {
  id: "anthropic/test-model", provider: "anthropic", tier: "balanced", label: "Test model",
  description: "", wire_model: "test-model", context_tokens: 200_000,
  efforts: [], default_effort: "off", supports_temperature: false, supports_tools: true,
  native_web_search: false, native_web_fetch: false, supports_vision: false,
  local: null, remote: null, fits: true, downloaded: false, configured: true, effort: "off",
};

beforeEach(() => {
  terminals.clear();
  for (const id of ["s1", "s2"]) {
    terminals.set(id, { disposed: false, term: { cols: 120, rows: 40 } });
  }
  useAppStore.setState({
    settingsLoaded: true, aiPanelOpen: true, aiPanelRatio: 0.3,
    sessions: [makeSession({ id: "s1" }), makeSession({ id: "s2" })],
    activeSessionId: "s1", catalog: [model], activeModelId: model.id,
    hasApiKey: { anthropic: true }, modelEffort: {}, loadedModelId: null, modelState: "idle",
    sessionUi: {
      s1: emptySessionUi(),
      s2: {
        ...emptySessionUi(), remote: { kind: "ssh", target: "deploy@example.com" },
        nestedBlockId: "ssh-connection", runningBlockId: "ssh-connection",
        remoteHost: { id: "example-host", label: "Example", color: null },
      },
    },
    aiStreams: { s1: { ...emptyAiStream("agent") }, s2: emptyAiStream() },
    sidecars: { s1: makeSidecarBinding() }, defaultAiMode: "ask", lastAiMode: "ask",
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Sidecar Full approval release", () => {
  it.each([false, true])("requires remote-role acknowledgement and checks its current proof after waiting (proof=%s)", async (reusable) => {
    const nativeRound = deferred<Awaited<ReturnType<typeof api.agentStart>>>();
    const remoteAck = deferred<void>();
    const start = vi.spyOn(api, "agentStart").mockReturnValue(nativeRound.promise);
    const setMode = vi.spyOn(api, "agentSetPermissionMode").mockImplementation(
      (_requestId, _mode, role) => role === "remote" ? remoteAck.promise : Promise.resolve(),
    );
    const approve = vi.spyOn(api, "respondToApproval").mockResolvedValue(undefined);
    const proof = vi.spyOn(ptyExec, "hasReusableRemoteShellProof").mockReturnValue(!reusable);
    const capture = vi.spyOn(ptyExec, "captureApprovalPromptBinding");
    render(<AiPanel sessionId="s1" />);
    const box = screen.getByPlaceholderText(/Describe a goal/i);
    fireEvent.change(box, { target: { value: "Count files on the remote fixture" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const emit = start.mock.calls[0][6] as (event: StreamEvent) => void;
    act(() => emit({
      type: "CommandProposal", approval_id: "sidecar-remote-command",
      command: "sudo find /tmp/fixture -type f | wc -l", explanation: "Count remote fixture files",
      read_only: false, network: false, output_policy: "normal",
      target_role: "remote", target_session_id: "s2", ask_reason: "privileged commands require approval",
    }));
    expect(useAppStore.getState().aiStreams.s1.pendingProposal?.targetSessionId).toBe("s2");

    const selectFull = (role: "Local" | "SSH") => {
      fireEvent.click(screen.getByRole("button", { name: `${role}: ${S.aiPanel.permissionLabel}` }));
      fireEvent.click(screen.getByRole("option", { name: (name) => name.startsWith(S.aiPanel.permission.full) }));
    };
    selectFull("Local");
    await waitFor(() => expect(useAppStore.getState().sidecars.s1.permissions.local).toBe("full"));
    expect(setMode).toHaveBeenLastCalledWith(start.mock.calls[0][0], "full", "local");
    expect(useAppStore.getState().sidecars.s1.permissions.remote).toBe("ask");
    expect(screen.getByText("Command approval")).toBeVisible();
    expect(proof).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();

    selectFull("SSH");
    await waitFor(() => expect(setMode).toHaveBeenLastCalledWith(start.mock.calls[0][0], "full", "remote"));
    expect(useAppStore.getState().sidecars.s1.permissions.remote).toBe("ask");
    expect(approve).not.toHaveBeenCalled();
    proof.mockReturnValue(reusable);
    await act(async () => remoteAck.resolve());
    await waitFor(() => expect(useAppStore.getState().sidecars.s1.permissions.remote).toBe("full"));
    expect(proof).toHaveBeenCalledWith("s2");
    expect(proof).not.toHaveBeenCalledWith("s1");
    expect(capture).not.toHaveBeenCalled();
    if (reusable) {
      expect(approve).toHaveBeenCalledExactlyOnceWith("sidecar-remote-command", "run", undefined);
    } else {
      expect(approve).not.toHaveBeenCalled();
      expect(screen.getByText("SSH prompt confirmation")).toBeVisible();
      expect(screen.getByRole("button", { name: "Run on Example" })).toBeDisabled();
    }
    await act(async () => {
      emit({ type: "Done", prompt_tokens: 0, completion_tokens: 0 });
      nativeRound.resolve([]);
    });
  });
});
