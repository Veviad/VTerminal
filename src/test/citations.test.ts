import { describe, expect, it } from "vitest";
import { stripCiteTags } from "../lib/citations";

/** Regression cover for output that actually reached the panel: asked to cite retrieved
 *  passages, Claude emitted `<cite index="1-1,1-2">…</cite>` and it rendered as literal
 *  angle-bracket text mid-sentence, because `AiMessageView` deliberately runs markdown
 *  without `rehype-raw`. The prompts now forbid the markup; this is the backstop for when
 *  a model does it anyway. */

describe("stripCiteTags", () => {
  it("leaves ordinary prose untouched", () => {
    const text = "The rollback command is `vv rollback --to <tag>`.\n\nSee page 12.";
    expect(stripCiteTags(text)).toBe(text);
  });

  /** The exact shape observed in the panel, indices and all. */
  it("unwraps a real cite element and keeps its words", () => {
    const raw =
      'Veviad\'s architecture was decided as four packages: <cite index="1-1,1-2">Four total: ' +
      "Starter / Growth / Professional / Enterprise, offering three public choices.</cite>";
    expect(stripCiteTags(raw)).toBe(
      "Veviad's architecture was decided as four packages: Four total: Starter / Growth / " +
        "Professional / Enterprise, offering three public choices.",
    );
  });

  it("handles several elements and varied attributes", () => {
    const raw =
      '<cite index="1-1">first claim</cite> then <CITE INDEX="2-3">second claim</CITE> then <cite>bare</cite>';
    expect(stripCiteTags(raw)).toBe("first claim then second claim then bare");
  });

  it("drops an orphan closing tag", () => {
    expect(stripCiteTags("a stray close</cite> mid sentence")).toBe(
      "a stray close mid sentence",
    );
  });

  /** Streaming renders the partial buffer on every delta, so a tag arriving one chunk at
   *  a time must never be shown in pieces. */
  it("hides a tag that is still arriving", () => {
    for (const partial of ["<ci", "<cit", "<cite", '<cite index="1-', "</cit"]) {
      const out = stripCiteTags(`The answer is grounded ${partial}`);
      expect(out).toBe("The answer is grounded ");
    }
  });

  /** The deliberate floor. `<c` is two characters and could genuinely end a sentence
   *  mid-word, so it is left alone: the cost is a two-character flash that the next
   *  streamed delta resolves, versus silently truncating the user's own text. */
  it("leaves a bare '<c' alone rather than risk truncating prose", () => {
    expect(stripCiteTags("the operator is <c")).toBe("the operator is <c");
  });

  /** Only at the very END. A `<` in the middle of a sentence is the model's own text. */
  it("does not eat a mid-sentence angle bracket", () => {
    const text = "use <cite> when writing HTML, and finish the sentence";
    // The complete tag is removed, but nothing after it is touched.
    expect(stripCiteTags(text)).toBe("use  when writing HTML, and finish the sentence");
  });

  /** Inline code needs the same protection as a fenced block: an answer explaining the
   *  HTML element writes `` `<cite>` ``, and stripping inside it would leave empty
   *  backticks. */
  it("leaves cite tags inside inline code alone", () => {
    const raw = 'the `<cite>` element is for citations, unlike <cite index="1-1">this</cite>';
    expect(stripCiteTags(raw)).toBe(
      "the `<cite>` element is for citations, unlike this",
    );
  });

  /** A model explaining HTML may legitimately put the tag in a code sample. Rewriting a
   *  code block would be a worse bug than the one this function fixes. */
  it("leaves cite tags inside a fenced code block alone", () => {
    const raw = [
      "Here is the markup:",
      "```html",
      '<cite index="1-1">quoted</cite>',
      "```",
      'and outside <cite index="2-1">stripped</cite>',
    ].join("\n");
    const out = stripCiteTags(raw);
    expect(out).toContain('<cite index="1-1">quoted</cite>');
    expect(out).toContain("and outside stripped");
  });

  it("handles tildes as a fence and an unclosed fence at the end", () => {
    const raw = ["~~~", '<cite index="1-1">kept</cite>'].join("\n");
    expect(stripCiteTags(raw)).toContain('<cite index="1-1">kept</cite>');
  });

  it("is idempotent", () => {
    const raw = 'a <cite index="1-1">b</cite> c';
    expect(stripCiteTags(stripCiteTags(raw))).toBe(stripCiteTags(raw));
  });

  it("handles an empty string and a tag-only message", () => {
    expect(stripCiteTags("")).toBe("");
    expect(stripCiteTags('<cite index="1-1"></cite>')).toBe("");
  });

});
