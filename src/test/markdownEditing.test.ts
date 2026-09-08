import { describe, expect, it } from "vitest";
import { continueBlock, insertLink, toggleWrap } from "../lib/markdownEditing";

/** `a|b` marks a collapsed caret, `a[bc]d` a selection. Keeps the fixtures
 *  readable — the alternative is a pair of magic offsets per case. */
function parse(marked: string): { value: string; start: number; end: number } {
  if (marked.includes("|")) {
    const start = marked.indexOf("|");
    return { value: marked.replace("|", ""), start, end: start };
  }
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start, end };
}

/** The finished value with the resulting selection marked the same way. */
function show(marked: string, run: (v: string, s: number, e: number) => ReturnType<typeof toggleWrap> | null): string {
  const { value, start, end } = parse(marked);
  const result = run(value, start, end);
  if (!result) return "(unhandled)";
  const { value: next, selectionStart, selectionEnd } = result;
  if (selectionStart === selectionEnd) {
    return `${next.slice(0, selectionStart)}|${next.slice(selectionStart)}`;
  }
  return `${next.slice(0, selectionStart)}[${next.slice(selectionStart, selectionEnd)}]${next.slice(selectionEnd)}`;
}

const bold = (v: string, s: number, e: number) => toggleWrap(v, s, e, "**");
const italic = (v: string, s: number, e: number) => toggleWrap(v, s, e, "_");

describe("toggleWrap", () => {
  it("wraps a selection and keeps it selected", () => {
    expect(show("say [this] plainly", bold)).toBe("say **[this]** plainly");
  });

  /** Nobody selects a word before pressing ⌘B. */
  it("wraps the word under the caret when nothing is selected", () => {
    expect(show("say th|is plainly", bold)).toBe("say **[this]** plainly");
  });

  it("inserts an empty pair when the caret is not in a word", () => {
    expect(show("say | plainly", bold)).toBe("say **|** plainly");
  });

  /** Pressing ⌘B twice has to leave the text as it was found. */
  it("unwraps when the selection sits inside the markers", () => {
    expect(show("say **[this]** plainly", bold)).toBe("say [this] plainly");
  });

  it("unwraps when the selection includes the markers", () => {
    expect(show("say [**this**] plainly", bold)).toBe("say [this] plainly");
  });

  it("unwraps the word under the caret", () => {
    expect(show("say **th|is** plainly", bold)).toBe("say [this] plainly");
  });

  it("uses underscores for italic without touching bold", () => {
    expect(show("[word]", italic)).toBe("_[word]_");
    expect(show("**[word]**", italic)).toBe("**_[word]_**");
  });

  it("wraps a multi-line selection as one span", () => {
    expect(show("[one\ntwo]", bold)).toBe("**[one\ntwo]**");
  });
});

describe("insertLink", () => {
  it("makes the selection the label and waits for a target", () => {
    expect(show("read [the docs] now", insertLink)).toBe("read [the docs](|) now");
  });

  it("makes a selected URL the target and waits for a label", () => {
    expect(show("[https://example.com]", insertLink)).toBe("[|](https://example.com)");
  });

  it("leaves an empty link with the caret in the label", () => {
    expect(show("see |", insertLink)).toBe("see [|]()");
  });

  /** A URL is only a URL if the whole selection is one. */
  it("treats a sentence containing a link as a label", () => {
    expect(show("[see https://example.com]", insertLink)).toBe("[see https://example.com](|)");
  });
});

describe("continueBlock", () => {
  it("repeats a bullet", () => {
    expect(show("- one|", continueBlock)).toBe("- one\n- |");
    expect(show("* one|", continueBlock)).toBe("* one\n* |");
  });

  it("counts an ordered list up", () => {
    expect(show("1. one|", continueBlock)).toBe("1. one\n2. |");
    expect(show("9) nine|", continueBlock)).toBe("9) nine\n10) |");
  });

  it("keeps the indentation of a nested item", () => {
    expect(show("  - one|", continueBlock)).toBe("  - one\n  - |");
  });

  it("repeats a quote marker", () => {
    expect(show("> quoted|", continueBlock)).toBe("> quoted\n> |");
  });

  it("starts a task item unchecked however the one above ended", () => {
    expect(show("- [x] done|", continueBlock)).toBe("- [x] done\n- [ ] |");
  });

  /** Otherwise the only way out of a list is to delete the marker by hand. */
  it("ends the list when the item is still empty", () => {
    expect(show("- one\n- |", continueBlock)).toBe("- one\n|");
    expect(show("> |", continueBlock)).toBe("|");
  });

  it("continues from a caret in the middle of an item", () => {
    expect(show("- one| two", continueBlock)).toBe("- one\n- | two");
  });

  it("leaves plain prose to the browser", () => {
    expect(continueBlock("just a line", 11, 11)).toBeNull();
    expect(continueBlock("", 0, 0)).toBeNull();
  });

  /** With a selection, Enter means "replace this". */
  it("leaves a selection to the browser", () => {
    expect(continueBlock("- one two", 6, 9)).toBeNull();
  });

  it("does not read a dash inside a word as a bullet", () => {
    expect(continueBlock("--no-pager|".replace("|", ""), 10, 10)).toBeNull();
  });
});

describe("TextEdit", () => {
  /** The caller splices `insert` into `[from, to)` through the DOM to keep the
   *  native undo stack, and falls back to `value` when it cannot. The two
   *  descriptions of the same change have to agree, or ⌘Z would walk back
   *  through a different edit than the one that was applied. */
  const CHANGES: [string, ReturnType<typeof toggleWrap> | null][] = [
    ["say this", toggleWrap("say this", 4, 8, "**")],
    ["say **this**", toggleWrap("say **this**", 6, 10, "**")],
    ["say this", insertLink("say this", 4, 8)],
    ["- one", continueBlock("- one", 5, 5)],
    ["- one\n- ", continueBlock("- one\n- ", 8, 8)],
  ];

  it.each(CHANGES)("describes the same change twice: %j", (source, change) => {
    expect(change).not.toBeNull();
    const { value, from, to, insert } = change!;
    expect(source.slice(0, from) + insert + source.slice(to)).toBe(value);
    expect(value.length).toBeGreaterThanOrEqual(change!.selectionEnd);
  });
});
