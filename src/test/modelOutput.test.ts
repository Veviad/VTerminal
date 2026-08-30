import { describe, expect, it } from "vitest";

import {
  sanitizeModelMarkdown,
  unwrapFinishSummaryEnvelope,
} from "../lib/modelOutput";

const properPrefixes = (tag: string): string[] =>
  Array.from({ length: tag.length - 1 }, (_, index) => tag.slice(0, index + 1));
const OPENING_SPLITS = [
  ...properPrefixes("<finish>"),
  "<finish>",
  ...properPrefixes("<summary>").map((prefix) => `<finish>\n${prefix}`),
];
const CLOSING_SPLITS = [
  ...properPrefixes("</summary>"),
  "</summary>",
  ...properPrefixes("</finish>").map(
    (prefix) => `</summary> ${prefix}`,
  ),
];

describe("unwrapFinishSummaryEnvelope", () => {
  it("unwraps the exact model pseudo-tool envelope", () => {
    const raw = [
      "<finish>",
      "<summary>",
      "## Issue Found and Fixed",
      "",
      "The package check completed.",
      "</summary>",
      "</finish>",
    ].join("\n");

    expect(unwrapFinishSummaryEnvelope(raw)).toBe(
      "## Issue Found and Fixed\n\nThe package check completed.",
    );
  });

  it("matches the leaked screenshot shape after leading prose", () => {
    const raw = [
      "Great! The package check completed and the prompt is visible again.",
      "",
      "<finish> <summary> ## Issue Found and Fixed",
      "",
      "The command itself was already finished.",
      "</summary> </finish>",
    ].join("\n");

    expect(unwrapFinishSummaryEnvelope(raw)).toBe(
      [
        "Great! The package check completed and the prompt is visible again.",
        "",
        "## Issue Found and Fixed",
        "",
        "The command itself was already finished.",
      ].join("\n"),
    );
  });

  it("allows harmless leading blank lines and CommonMark indentation", () => {
    const raw = "\n  <finish>\n   <summary>\nDone\n   </summary>\n  </finish>\n";
    expect(unwrapFinishSummaryEnvelope(raw)).toBe("Done");
  });

  it("renders the body before closing tags have arrived", () => {
    expect(
      unwrapFinishSummaryEnvelope("<finish>\n<summary>\nThe command completed."),
    ).toBe("The command completed.");
  });

  it("preserves Markdown indentation inside the summary body", () => {
    const raw = "<finish>\n<summary>\n    indented code\n</summary>\n</finish>";
    expect(unwrapFinishSummaryEnvelope(raw)).toBe("    indented code");
  });

  it("unwraps a closing pair attached to the final prose line", () => {
    expect(
      unwrapFinishSummaryEnvelope(
        "<finish> <summary> The command completed.</summary> </finish>",
      ),
    ).toBe("The command completed.");
  });

  it.each(OPENING_SPLITS)("hides every opening-envelope split: %s", (raw) => {
    expect(unwrapFinishSummaryEnvelope(raw, { streaming: true })).toBe("");
  });

  it.each(CLOSING_SPLITS)(
    "hides every closing-envelope split on a control line: %s",
    (partial) => {
      const raw = `<finish>\n<summary>\nDone\n${partial}`;
      expect(unwrapFinishSummaryEnvelope(raw)).toBe("Done");
    },
  );

  it.each(CLOSING_SPLITS)(
    "hides every attached closing-envelope split: %s",
    (partial) => {
      const raw = `<finish> <summary> Done${partial}`;
      expect(unwrapFinishSummaryEnvelope(raw)).toBe("Done");
    },
  );

  it("cleans an exact orphan closing pair from archived model output", () => {
    expect(unwrapFinishSummaryEnvelope("Done\n</summary>\n</finish>\n")).toBe("Done");
    expect(unwrapFinishSummaryEnvelope("Done\n</summary> </finish>\n")).toBe("Done");
  });

  it("keeps lone closing tags literal without a recognized opening pair", () => {
    expect(unwrapFinishSummaryEnvelope("Done\n</summary>")).toBe("Done\n</summary>");
    expect(unwrapFinishSummaryEnvelope("Done\n</finish>")).toBe("Done\n</finish>");
  });

  it("preserves prior prose while an opening pair is still streaming", () => {
    expect(unwrapFinishSummaryEnvelope("Before the wrapper.\n\n<finish> <sum", { streaming: true })).toBe(
      "Before the wrapper.\n\n",
    );
  });

  it("leaves standalone opening-tag examples literal once output is final", () => {
    expect(unwrapFinishSummaryEnvelope("<finish>")).toBe("<finish>");
    expect(unwrapFinishSummaryEnvelope("<summary>")).toBe("<summary>");
    expect(unwrapFinishSummaryEnvelope("Before\n<finish>\n")).toBe(
      "Before\n<finish>\n",
    );
  });

  it("keeps a truncated opening pair clean after output is finalized", () => {
    expect(unwrapFinishSummaryEnvelope("Before\n<finish>\n<sum")).toBe(
      "Before\n",
    );
  });

  it.each([
    "Use <finish> and <summary> as literal examples.",
    "<finish><summary>adjacent tags are not the known envelope",
    "<FINISH>\n<SUMMARY>case-sensitive literal markup</SUMMARY>\n</FINISH>",
    '<finish mode="text">\n<summary>attributes are not accepted',
    "prefix <finish>\n<summary>\nnot at a line boundary",
    "    <finish>\n    <summary>\nindented code stays literal",
    "Done </summary> </finish>",
    "Done</summary> </finish>",
  ])("leaves non-protocol prose unchanged: %s", (raw) => {
    expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
  });

  it("protects inline code and fenced examples", () => {
    const inline = "`</summary>`\n`</finish>`";
    expect(unwrapFinishSummaryEnvelope(inline)).toBe(inline);

    const fenced = [
      "```xml",
      "<finish> <summary>",
      "literal example",
      "</summary>",
      "</finish>",
      "```",
    ].join("\n");
    expect(unwrapFinishSummaryEnvelope(fenced)).toBe(fenced);

    const wrapped = [
      "<finish>",
      "<summary>",
      "```xml",
      "</summary>",
      "</finish>",
      "```",
      "</summary>",
      "</finish>",
    ].join("\n");
    expect(unwrapFinishSummaryEnvelope(wrapped)).toBe(
      ["```xml", "</summary>", "</finish>", "```"].join("\n"),
    );

    const wrappedInline = "<finish> <summary> `Done</summary> </finish>`";
    expect(unwrapFinishSummaryEnvelope(wrappedInline)).toBe(
      "`Done</summary> </finish>`",
    );

    const multilineInline = [
      "`literal example",
      "<finish>",
      "<summary>",
      "inside code",
      "</summary>",
      "</finish>",
      "`",
    ].join("\n");
    expect(unwrapFinishSummaryEnvelope(multilineInline)).toBe(multilineInline);

    const multilineInlineWithBlankLine = [
      "`literal example",
      "",
      "<finish>",
      "<summary>",
      "inside code",
      "</summary>",
      "</finish>",
      "`",
    ].join("\n");
    expect(unwrapFinishSummaryEnvelope(multilineInlineWithBlankLine)).toBe(
      multilineInlineWithBlankLine,
    );

    const streamingMultilineInline = [
      "`literal example",
      "</summary>",
      "</finish>",
    ].join("\n");
    expect(unwrapFinishSummaryEnvelope(streamingMultilineInline)).toBe(
      streamingMultilineInline,
    );

    const wrappedStreamingInline = [
      "<finish>",
      "<summary>",
      "`literal example",
      "</summary>",
      "</finish>",
    ].join("\n");
    expect(unwrapFinishSummaryEnvelope(wrappedStreamingInline)).toBe(
      ["`literal example", "</summary>", "</finish>"].join("\n"),
    );
  });

  it("protects a directly list-nested fence until a matching-width close", () => {
    const raw = [
      "- ````xml",
      "  <finish>",
      "  <summary>",
      "  literal example",
      "  ```",
      "  ~~~~",
      "  </summary>",
      "  </finish>",
      "  ````",
      "Done",
      "</summary>",
      "</finish>",
    ].join("\n");

    expect(unwrapFinishSummaryEnvelope(raw)).toBe(
      [
        "- ````xml",
        "  <finish>",
        "  <summary>",
        "  literal example",
        "  ```",
        "  ~~~~",
        "  </summary>",
        "  </finish>",
        "  ````",
        "Done",
      ].join("\n"),
    );
  });

  it("protects a list-nested fence inside a blockquote container", () => {
    const raw = [
      "> - ````xml",
      ">   <finish>",
      ">   <summary>",
      ">   literal example",
      ">   ```",
      ">   ~~~~",
      ">   </summary>",
      ">   </finish>",
      ">   ````",
      "Done",
      "</summary>",
      "</finish>",
    ].join("\n");

    expect(unwrapFinishSummaryEnvelope(raw)).toBe(
      [
        "> - ````xml",
        ">   <finish>",
        ">   <summary>",
        ">   literal example",
        ">   ```",
        ">   ~~~~",
        ">   </summary>",
        ">   </finish>",
        ">   ````",
        "Done",
      ].join("\n"),
    );
  });

  it("protects multiline code spans using the opening delimiter width", () => {
    const raw = [
      "``literal code with a `single-backtick` example",
      "<finish>",
      "<summary>",
      "inside code",
      "</summary>",
      "</finish>",
      "``",
    ].join("\n");

    expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
  });

  it("returns a long ordinary model message unchanged", () => {
    const raw = Array.from(
      { length: 10_000 },
      (_, index) => `Ordinary model output line ${index}.`,
    ).join("\n");

    expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
  });

  it("is idempotent", () => {
    const raw = "<finish>\n<summary>\nDone\n</summary>\n</finish>";
    const once = unwrapFinishSummaryEnvelope(raw);
    expect(unwrapFinishSummaryEnvelope(once)).toBe(once);
  });
});

describe("sanitizeModelMarkdown", () => {
  it("retains citation cleanup inside a finish summary", () => {
    const raw = [
      "<finish>",
      "<summary>",
      '<cite index="1-1">The check passed.</cite>',
      "</summary>",
      "</finish>",
    ].join("\n");
    expect(sanitizeModelMarkdown(raw)).toBe("The check passed.");
  });

  it("is idempotent across both cleanup passes", () => {
    const raw = [
      "<finish>",
      "<summary>",
      'A <cite index="1-1">grounded claim</cite>.',
      "</summary>",
      "</finish>",
    ].join("\n");
    const once = sanitizeModelMarkdown(raw);
    expect(sanitizeModelMarkdown(once)).toBe(once);
  });
});
