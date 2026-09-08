import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MarkdownEditor } from "../components/ui/MarkdownEditor";

// The editor is a textarea with the markdown painted in a layer behind it, so
// these tests are about the two staying in step: what the layer renders, what
// the keys do to the value, and which shortcuts are allowed past it.
//
// jsdom implements neither `execCommand` verb, so the default environment takes
// the controlled fallback. Native-path cases install a compatible command stub.

const restoreCapabilities: (() => void)[] = [];

function stubDocumentCapability(key: "fonts" | "execCommand", value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(document, key);
  Object.defineProperty(document, key, { configurable: true, value });
  restoreCapabilities.push(() => {
    if (descriptor) Object.defineProperty(document, key, descriptor);
    else Reflect.deleteProperty(document, key);
  });
}

afterEach(() => {
  for (const restore of restoreCapabilities.splice(0).reverse()) restore();
  vi.restoreAllMocks();
});

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor value={value} onChange={setValue} ariaLabel="Prompt" />;
}

function editor(initial = ""): { box: HTMLTextAreaElement; layer: HTMLElement } {
  render(<Harness initial={initial} />);
  const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
  const layer = box.parentElement!.firstElementChild as HTMLElement;
  return { box, layer };
}

/** Type into the box and put the caret where a person would leave it. */
function type(box: HTMLTextAreaElement, value: string, start = value.length, end = start) {
  fireEvent.change(box, { target: { value } });
  box.setSelectionRange(start, end);
}

describe("MarkdownEditor", () => {
  it("paints the same characters it hides", () => {
    const { box, layer } = editor();
    type(box, "# Title\n\n- **bold** and `code`");
    expect(layer.textContent).toBe(box.value);
    expect(layer).toHaveAttribute("aria-hidden", "true");
  });

  /** A trailing newline creates no final line box in CSS while the textarea
   *  reserves a line for the caret — so the layer gets one more of them. */
  it("pads a trailing newline so the last line still has a row", () => {
    const { box, layer } = editor();
    type(box, "one\n");
    expect(layer.textContent).toBe("one\n\n");
  });

  it("highlights the markdown it finds", () => {
    const { box, layer } = editor();
    type(box, "## Heading");
    const spans = Array.from(layer.querySelectorAll("span"));
    expect(spans.map((span) => span.textContent)).toEqual(["##", " Heading"]);
    expect(spans[1].className).toContain("font-bold");
  });

  it("wraps the selection on the bold key", () => {
    const { box } = editor();
    type(box, "be terse", 3, 8);
    fireEvent.keyDown(box, { key: "b", metaKey: true });
    expect(box).toHaveValue("be **terse**");
  });

  it.each([
    ["missing", undefined],
    ["unsupported", () => false],
    ["throwing", () => { throw new Error("Unsupported command"); }],
  ])("keeps formatting usable when execCommand is %s", (_description, command) => {
    stubDocumentCapability("execCommand", command);
    const { box } = editor("be terse");
    box.setSelectionRange(3, 8);

    fireEvent.keyDown(box, { key: "b", metaKey: true });

    expect(box).toHaveValue("be **terse**");
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 10]);
  });

  it.each([
    { initial: "terse", key: "b", command: "insertText", insert: "**terse**", expected: "**terse**" },
    { initial: "- first\n- ", key: "Enter", command: "delete", insert: "", expected: "- first\n" },
  ])("uses native $command when available", ({ initial, key, command, insert, expected }) => {
    const { box } = editor(initial);
    box.focus();
    box.setSelectionRange(key === "b" ? 0 : initial.length, initial.length);
    const execCommand = vi.fn(function (this: Document, _command: string, _showUI?: boolean, text = "") {
      expect(this).toBe(document);
      fireEvent.input(box, {
        target: {
          value: box.value.slice(0, box.selectionStart) + text + box.value.slice(box.selectionEnd),
        },
      });
      return true;
    });
    stubDocumentCapability("execCommand", execCommand);

    fireEvent.keyDown(box, { key, metaKey: key === "b" });

    expect(execCommand.mock.calls).toEqual([command === "delete" ? [command] : [command, false, insert]]);
    expect(box).toHaveValue(expected);
  });

  it("remeasures after fonts become ready", async () => {
    let ready!: () => void;
    stubDocumentCapability("fonts", { ready: new Promise<void>((resolve) => { ready = resolve; }) });
    let height = 160;
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    const { box } = editor("text");
    expect(box.style.height).toBe("160px");

    height = 220;
    await act(async () => { ready(); });

    expect(box.style.height).toBe("220px");
  });

  it("preserves a manual resize when fonts become ready", async () => {
    let ready!: () => void;
    stubDocumentCapability("fonts", { ready: new Promise<void>((resolve) => { ready = resolve; }) });
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(160);
    let renderedHeight = 160;
    vi.spyOn(HTMLTextAreaElement.prototype, "offsetHeight", "get").mockImplementation(() => renderedHeight);
    const { box } = editor("text");
    renderedHeight = 300;
    box.style.height = "300px";
    fireEvent.mouseUp(box);

    await act(async () => { ready(); });

    expect(box.style.height).toBe("300px");
  });

  it("wraps the word under the caret when nothing is selected", () => {
    const { box } = editor();
    type(box, "be terse", 5);
    fireEvent.keyDown(box, { key: "i", metaKey: true });
    expect(box).toHaveValue("be _terse_");
  });

  it("unwraps on a second press", () => {
    const { box } = editor();
    type(box, "be **terse**", 5, 10);
    fireEvent.keyDown(box, { key: "b", metaKey: true });
    expect(box).toHaveValue("be terse");
  });

  it("opens a link and leaves the target empty", () => {
    const { box } = editor();
    type(box, "read the docs", 9, 13);
    fireEvent.keyDown(box, { key: "k", metaKey: true });
    expect(box).toHaveValue("read the [docs]()");
  });

  it("continues a list on Enter", () => {
    const { box } = editor();
    type(box, "- first");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("- first\n- ");
  });

  it("ends the list when Enter lands on an empty item", () => {
    const { box } = editor();
    type(box, "- first\n- ");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("- first\n");
  });

  it("leaves Enter alone in plain prose", () => {
    const onKeyDown = vi.fn();
    render(<MarkdownEditor value="just prose" onChange={() => {}} ariaLabel="P" onKeyDown={onKeyDown} />);
    const box = screen.getByLabelText("P") as HTMLTextAreaElement;
    box.setSelectionRange(10, 10);
    fireEvent.keyDown(box, { key: "Enter" });
    // Not claimed, so it reaches the caller — and the browser inserts the
    // newline, because nothing called preventDefault.
    expect(onKeyDown).toHaveBeenCalled();
  });

  /**
   * ⌘I and ⌘K are app-reserved (AI composer, command palette) and
   * `useGlobalShortcuts` listens on `window`, above React's root container. A
   * focused prose editor keeps its own formatting keys — and nothing else.
   */
  it("keeps its formatting keys from reaching the app's global shortcuts", () => {
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    try {
      const { box } = editor("text");
      box.setSelectionRange(0, 4);
      for (const key of ["b", "i", "e", "k"]) {
        fireEvent.keyDown(box, { key, metaKey: true });
      }
      expect(onWindow).not.toHaveBeenCalled();

      // Every other shortcut still belongs to the app.
      fireEvent.keyDown(box, { key: "j", metaKey: true });
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
      expect(onWindow).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  /** On macOS Ctrl+B/E/K are the emacs bindings WebKit gives every text field,
   *  and this editor takes Cmd only. (jsdom reports neither platform, which is
   *  the non-Windows branch.) */
  it("leaves the macOS control bindings alone", () => {
    const { box } = editor("be terse");
    box.setSelectionRange(3, 8);
    for (const key of ["b", "i", "e", "k"]) {
      fireEvent.keyDown(box, { key, ctrlKey: true });
    }
    expect(box).toHaveValue("be terse");
  });

  it("hands ⌘Enter and Escape to the caller", () => {
    const onKeyDown = vi.fn();
    render(<MarkdownEditor value="" onChange={() => {}} ariaLabel="P" onKeyDown={onKeyDown} />);
    const box = screen.getByLabelText("P");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledTimes(2);
  });

  it.each(["- first", "> quoted"])(
    "hands save shortcuts to the caller within %j",
    (value) => {
      const onChange = vi.fn();
      const onKeyDown = vi.fn();
      render(
        <MarkdownEditor value={value} onChange={onChange} ariaLabel="P" onKeyDown={onKeyDown} />,
      );
      const box = screen.getByLabelText("P") as HTMLTextAreaElement;
      box.setSelectionRange(value.length, value.length);

      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        fireEvent.keyDown(box, { key: "Enter", ...modifier });
      }

      expect(onKeyDown).toHaveBeenCalledTimes(2);
      expect(onChange).not.toHaveBeenCalled();
      expect(box).toHaveValue(value);
    },
  );
});
