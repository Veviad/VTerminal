import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "../stores/appStore";
import { S } from "../lib/strings";

// Custom instructions are APPENDED to the built-in system prompt by
// `agent::instructions` — this file covers the frontend half of that round trip:
// the three fields write the three keys Rust reads, and the copy keeps saying
// what the feature can and cannot do.
//
// One `vi.mock` covers it, per the single-chokepoint design in lib/tauri.ts.

const saveSettings = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());

vi.mock("../lib/tauri", () => ({
  saveSettings: (...a: unknown[]) => saveSettings(...a),
  getSettings: vi.fn(() => Promise.resolve({})),
  archiveClear: vi.fn(() => Promise.resolve()),
}));

const { InstructionsSection, MAX_INSTRUCTION_CHARS } = await import(
  "../components/settings/InstructionsSection"
);

const FIELDS = [
  { label: S.settings.instructions.global, key: "custom_instructions" },
  { label: S.settings.instructions.agent, key: "agent_custom_instructions" },
  { label: S.settings.instructions.chat, key: "chat_custom_instructions" },
] as const;

describe("InstructionsSection", () => {
  beforeEach(() => {
    saveSettings.mockClear();
    saveSettings.mockImplementation(() => Promise.resolve());
    useAppStore.setState({
      customInstructions: "",
      agentCustomInstructions: "",
      chatCustomInstructions: "",
    });
  });

  it("reflects what is stored", () => {
    useAppStore.setState({
      customInstructions: "Prefer pnpm.",
      agentCustomInstructions: "Show git status.",
      chatCustomInstructions: "Answer in German.",
    });
    render(<InstructionsSection />);
    expect(screen.getByLabelText(S.settings.instructions.global)).toHaveValue("Prefer pnpm.");
    expect(screen.getByLabelText(S.settings.instructions.agent)).toHaveValue("Show git status.");
    expect(screen.getByLabelText(S.settings.instructions.chat)).toHaveValue("Answer in German.");
  });

  /** Each box must write the key `agent::instructions` reads. A mismatch here is
   *  the `ProviderId::OpenAi` failure shape: no error anywhere, the field just
   *  never reaches a model. */
  it.each(FIELDS)("writes $key on blur", async ({ label, key }) => {
    render(<InstructionsSection />);
    const box = screen.getByLabelText(label);
    fireEvent.change(box, { target: { value: "standing text" } });
    // Typing alone must not save: every commit is a Rust store write.
    expect(saveSettings).not.toHaveBeenCalled();
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ [key]: "standing text" }));
  });

  it("does not save when nothing changed", () => {
    useAppStore.setState({ customInstructions: "unchanged" });
    render(<InstructionsSection />);
    fireEvent.blur(screen.getByLabelText(S.settings.instructions.global));
    expect(saveSettings).not.toHaveBeenCalled();
  });

  /** Empty string is the clear sentinel over IPC — JSON null is indistinguishable
   *  from "not provided" once serde sees `Option`. */
  it("clears with an empty string, not null", async () => {
    useAppStore.setState({ customInstructions: "drop me" });
    render(<InstructionsSection />);
    fireEvent.click(screen.getAllByRole("button", { name: S.settings.instructions.clear })[0]);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ custom_instructions: "" }));
  });

  it("offers no Clear button for an empty field", () => {
    render(<InstructionsSection />);
    expect(screen.queryByRole("button", { name: S.settings.instructions.clear })).toBeNull();
  });

  /** Rust REJECTS over the cap rather than truncating, so the doomed request is
   *  worth stopping here — and the box has to say why rather than silently
   *  refusing to save what the user just typed. */
  it("refuses to send a value over the cap and says so", async () => {
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "x".repeat(MAX_INSTRUCTION_CHARS + 1) } });
    fireEvent.blur(box);
    expect(screen.getByText(S.settings.instructions.tooLong(MAX_INSTRUCTION_CHARS))).toBeTruthy();
    await waitFor(() => expect(saveSettings).not.toHaveBeenCalled());
  });

  it("saves a value exactly at the cap", async () => {
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    const atCap = "x".repeat(MAX_INSTRUCTION_CHARS);
    fireEvent.change(box, { target: { value: atCap } });
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ custom_instructions: atCap }));
  });

  it("counts supplementary Unicode characters the same way as Rust", async () => {
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    const text = "😀".repeat(MAX_INSTRUCTION_CHARS);
    fireEvent.change(box, { target: { value: text } });
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ custom_instructions: text }));
  });

  it("preserves typing begun while the previous blur-save is pending", async () => {
    let finish!: () => void;
    saveSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "first save" } });
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: "newer draft" } });
    await act(async () => { finish(); });
    expect(box).toHaveValue("newer draft");
    expect(screen.queryByText(S.settings.instructions.saved)).toBeNull();
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ custom_instructions: "newer draft" }));
  });

  it("orders Clear after an in-flight blur-save without restoring the old draft", async () => {
    useAppStore.setState({ customInstructions: "stored" });
    let finish!: () => void;
    saveSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "pending save" } });
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole("button", { name: S.settings.instructions.clear })[0]);
    expect(box).toHaveValue("");
    expect(saveSettings).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ custom_instructions: "" }));
    expect(box).toHaveValue("");
    expect(useAppStore.getState().customInstructions).toBe("");
  });

  it("keeps per-field save ordering when the settings section is reopened", async () => {
    let finish!: () => void;
    saveSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = render(<InstructionsSection />);
    fireEvent.change(screen.getByLabelText(S.settings.instructions.global), { target: { value: "old mount" } });
    fireEvent.blur(screen.getByLabelText(S.settings.instructions.global));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "new mount" } });
    fireEvent.blur(box);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    expect(saveSettings).toHaveBeenLastCalledWith({ custom_instructions: "new mount" });
    expect(box).toHaveValue("new mount");
    expect(useAppStore.getState().customInstructions).toBe("new mount");
  });

  it("settles only the submitted draft to the backend-normalized value", async () => {
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "  normalized\r\ntext  " } });
    fireEvent.blur(box);
    await waitFor(() => expect(box).toHaveValue("normalized\ntext"));
    expect(useAppStore.getState().customInstructions).toBe("normalized\ntext");
  });

  /** A rejected save must surface. `useSettings` re-reads the backend on failure,
   *  so a silent catch would leave the box showing text that was never stored. */
  it("shows a backend rejection instead of pretending it saved", async () => {
    saveSettings.mockImplementation(() => Promise.reject(new Error("keychain is blocked")));
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "nope" } });
    fireEvent.blur(box);
    await waitFor(() => expect(screen.getByText("keychain is blocked")).toBeTruthy());
    expect(screen.queryByText(S.settings.instructions.saved)).toBeNull();
  });

  it("keeps a failed draft retryable without blocking the next save", async () => {
    saveSettings.mockRejectedValueOnce(new Error("temporary write failure"));
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "retry me" } });
    fireEvent.blur(box);
    await waitFor(() => expect(screen.getByText("temporary write failure")).toBeTruthy());
    expect(box).toHaveValue("retry me");
    fireEvent.blur(box);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useAppStore.getState().customInstructions).toBe("retry me"));
    expect(box).toHaveValue("retry me");
  });

  /** The three fields are markdown editors now, so what a formatting key writes
   *  has to reach the same store key an ordinary keystroke does. */
  it("stores what the markdown keys wrote", async () => {
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "prefer pnpm" } });
    box.setSelectionRange(7, 11);
    fireEvent.keyDown(box, { key: "b", metaKey: true });
    fireEvent.blur(box);
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({ custom_instructions: "prefer **pnpm**" }),
    );
  });

  it("reverts the draft on Escape without saving", () => {
    useAppStore.setState({ customInstructions: "original" });
    render(<InstructionsSection />);
    const box = screen.getByLabelText(S.settings.instructions.global);
    fireEvent.change(box, { target: { value: "typo" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("original");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  /** The copy is the only place the app explains that this is ADDED to the
   *  built-in prompt and authorises nothing. Both claims are the same kind of
   *  promise as `agent.webAccessHint`'s best-effort clause, and both stay. */
  it("keeps the append-not-replace and no-authority claims in the copy", () => {
    expect(S.settings.instructions.intro).toMatch(/never replaces/i);
    expect(S.settings.instructions.limits).toMatch(/cannot grant permissions/i);
    expect(S.settings.instructions.limits).toMatch(/enforced in code/i);
    // The excluded surfaces have to be named, or a user whose tab names stop
    // obeying their instructions has no way to learn that was deliberate.
    expect(S.settings.instructions.limits).toMatch(/tab naming/i);
  });
});
