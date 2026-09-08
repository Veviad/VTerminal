import { describe, expect, it } from "vitest";
import { tokenizeMarkdown, type MarkdownTokenKind } from "../lib/markdownHighlight";
import { MARKDOWN_KIND_CLASS } from "../components/ui/MarkdownEditor";

/** What the overlay would render for a kind, as one string. */
const of = (source: string, kind: MarkdownTokenKind): string =>
  tokenizeMarkdown(source)
    .filter((token) => token.kind === kind)
    .map((token) => token.text)
    .join("");

const kinds = (source: string): MarkdownTokenKind[] =>
  tokenizeMarkdown(source).map((token) => token.kind);

/** Every fixture in this file, plus the awkward ones, run through the one
 *  invariant that matters: the overlay reproduces the source exactly. */
const FIXTURES = [
  "",
  "\n",
  "plain prose",
  "# Heading\n\nBody **bold** and _italic_ and `code`.",
  "```bash\ngit status --porcelain\n```\ntail",
  "- one\n- two\n  - nested\n\n1. first\n2. second",
  "> quoted **strongly**\n> still quoted",
  "- [ ] todo\n- [x] done",
  "See [the docs](https://example.com/a_b) for `--no-pager`.",
  "Set max_tokens and snake_case_name, not *emphasis*.",
  "unbalanced ** and _ and ` and [link](",
  "***everything***\n~~gone~~\n---\n",
  "trailing spaces   \n\ttab indented\n",
  "\\*not emphasis\\* and \\`not code\\`",
  "`` a ` b ``",
  "```\nunclosed fence\nstill code",
  "#hashtag is not a heading\n#### deep\n####### seven hashes",
  "*",
  "**",
  "text with ! and [ and ~ alone",
];

describe("tokenizeMarkdown", () => {
  /** The whole reason this is not `react-markdown`: a dropped or duplicated
   *  character shifts every glyph after it out from under the caret. */
  it.each(FIXTURES)("reproduces the source exactly: %j", (source) => {
    expect(tokenizeMarkdown(source).map((token) => token.text).join("")).toBe(source);
  });

  it("marks a heading's hashes as syntax and its text as a heading", () => {
    expect(of("## Title", "syntax")).toBe("##");
    expect(of("## Title", "heading")).toBe(" Title");
  });

  it("leaves a hashtag alone", () => {
    expect(kinds("#hashtag")).not.toContain("heading");
  });

  it("highlights every heading level and nothing deeper", () => {
    expect(of("###### six", "syntax")).toBe("######");
    // Seven is not a heading in markdown either, so it must not read as one.
    expect(of("####### seven", "heading")).toBe("");
  });

  it("dims the markers around bold, italic and strikethrough", () => {
    // Both delimiters of each span, in source order.
    expect(of("**b** _i_ ~~s~~", "syntax")).toBe("****__~~~~");
    expect(of("**b** _i_ ~~s~~", "strong")).toBe("b");
    expect(of("**b** _i_ ~~s~~", "em")).toBe("i");
    expect(of("**b** _i_ ~~s~~", "strike")).toBe("s");
  });

  it("keeps both when emphasis nests", () => {
    expect(of("**bold _and_ italic**", "strongEm")).toBe("and");
    expect(of("***both***", "strongEm")).toBe("both");
  });

  /** A prompt about shell flags is full of these, and italicising half a line
   *  from an underscore in `max_tokens` looks like the field is broken. */
  it("never starts emphasis inside a word", () => {
    expect(kinds("max_tokens and snake_case_name")).toEqual(["text"]);
    expect(of("call _really_ carefully", "em")).toBe("really");
  });

  it("does not read a list marker as emphasis", () => {
    expect(of("* item", "syntax")).toBe("* ");
    expect(of("* item", "em")).toBe("");
  });

  it("separates a link's label from its target", () => {
    expect(of("[docs](https://example.com)", "link")).toBe("docs");
    expect(of("[docs](https://example.com)", "url")).toBe("https://example.com");
    expect(of("![alt](a.png)", "syntax")).toBe("![](" + ")");
  });

  it("holds inline code together, backticks and all", () => {
    expect(of("run `git log --oneline` now", "code")).toBe("git log --oneline");
    // A doubled fence is how a literal backtick is written.
    expect(of("`` a ` b ``", "code")).toBe(" a ` b ");
  });

  it("treats an unclosed backtick as prose", () => {
    expect(of("a ` b", "code")).toBe("");
    expect(kinds("a ` b")).toEqual(["text"]);
  });

  it("carries a fenced block from its opening line to its closing one", () => {
    const source = "```bash\ngit status\n```\nafter";
    expect(of(source, "codeBlock")).toBe("\ngit status\n");
    expect(of(source, "code")).toBe("bash");
    expect(of(source, "text")).toBe("\nafter");
  });

  it("keeps an unclosed fence open to the end", () => {
    expect(of("```\nstill\ncode", "codeBlock")).toBe("\nstill\ncode");
  });

  /** Emphasis is per line, so an unclosed marker cannot bleed into the rest of
   *  the field — this is what stops one stray `**` recolouring everything. */
  it("does not carry emphasis across a newline", () => {
    expect(of("**open\nnext line", "strong")).toBe("");
  });

  it("marks list, task and quote prefixes as syntax", () => {
    expect(of("- [x] done", "syntax")).toBe("- [x] ");
    expect(of("1. first", "syntax")).toBe("1. ");
    expect(of("> quoted", "syntax")).toBe("> ");
    expect(of("> quoted", "quote")).toBe("quoted");
  });

  it("marks a thematic break as one span", () => {
    expect(of("---", "rule")).toBe("---");
    // Two dashes are an em dash someone typed, not a rule.
    expect(of("--", "rule")).toBe("");
  });

  it("does not let a backslash escape open a construct", () => {
    expect(of("\\*text\\*", "em")).toBe("");
    expect(of("\\*text\\*", "syntax")).toBe("\\\\");
  });

  it("indents without losing the indent", () => {
    expect(of("  - nested", "syntax")).toBe("- ");
    // The indent leads, so the marker is still highlighted in the right column.
    expect(tokenizeMarkdown("  - nested")[0]).toEqual({ text: "  ", kind: "text" });
  });
});

describe("markdown token styles", () => {
  /**
   * The overlay wraps at the same column as the textarea in front of it only
   * while every character advances by the same width in both layers. Colour,
   * background, weight, slant and decoration are safe in a monospace family;
   * a font size, a family, letter-spacing or padding is not, and the drift it
   * causes is invisible until a line wraps.
   */
  it("no markdown style changes glyph metrics", () => {
    const unsafe = /(^|\s)(text-\[|text-(xs|sm|base|lg|xl)|tracking-|font-(mono|sans|serif)|p-|px-|py-|pl-|pr-|ps-|pe-|indent-)/;
    for (const [kind, className] of Object.entries(MARKDOWN_KIND_CLASS)) {
      expect(className, kind).not.toMatch(unsafe);
    }
  });

  it("styles every kind the tokenizer can emit", () => {
    const emitted = new Set(
      kinds(FIXTURES.join("\n")).concat(kinds("![a](b.png)"), kinds("***x***")),
    );
    for (const kind of emitted) {
      expect(MARKDOWN_KIND_CLASS, kind).toHaveProperty(kind);
    }
  });
});
