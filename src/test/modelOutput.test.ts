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

describe("finish invocation envelopes", () => {
  const invoke = '<invoke name="finish">';
  const parameter = '<parameter name="summary">';
  const closingPairs = ["</parameter></invoke>", "</parameter> </invoke>", "</parameter>\n</invoke>"];
  const openingForms = ['"', "'"].flatMap((outerQuote) =>
    ['"', "'"].flatMap((bodyQuote) => ["", " ", "\n"].map((separator) =>
      `<invoke name=${outerQuote}finish${outerQuote}>${separator}<parameter name=${bodyQuote}summary${bodyQuote}>`,
    )),
  );
  const openingPrefixes = openingForms.flatMap((opening) =>
    Array.from({ length: opening.length }, (_, index) => opening.slice(0, index + 1)),
  );
  const closingPrefixes = closingPairs.flatMap((closing) =>
    Array.from({ length: closing.length }, (_, index) => closing.slice(0, index + 1)),
  );

  it.each(openingForms)("unwraps exact quote and XML separator variants: %s", (opening) => {
    const raw = `${opening}\n## Fixed\n\nThe connection is tracked.</parameter></invoke>`;
    expect(unwrapFinishSummaryEnvelope(raw)).toBe("## Fixed\n\nThe connection is tracked.");
  });

  it.each(closingPairs)("unwraps attached and standalone closing tags: %s", (closing) => {
    expect(unwrapFinishSummaryEnvelope(`${invoke} ${parameter} Done${closing}`)).toBe("Done");
    expect(unwrapFinishSummaryEnvelope(`${invoke}\n${parameter}\nDone\n${closing}\n`)).toBe("Done");
  });

  it("preserves prior prose and the summary's Markdown indentation", () => {
    const raw = `The verification completed.\n\n  ${invoke}\n   ${parameter}\r\n    code stays indented\r\n</parameter>\r\n</invoke>`;
    expect(unwrapFinishSummaryEnvelope(raw)).toBe(
      "The verification completed.\n\n    code stays indented",
    );
  });

  it.each([...new Set(openingPrefixes)])("hides every opening character boundary while streaming: %s", (prefix) => {
    expect(unwrapFinishSummaryEnvelope(prefix, { streaming: true })).toBe("");
    expect(unwrapFinishSummaryEnvelope(`Prior prose.\n\n${prefix}`, { streaming: true }))
      .toBe("Prior prose.\n\n");
  });

  it.each([...new Set(closingPrefixes)])("hides every recognized closing character boundary: %s", (prefix) => {
    for (const streaming of [false, true]) {
      expect(unwrapFinishSummaryEnvelope(`${invoke}${parameter}Done${prefix}`, { streaming }))
        .toBe("Done");
      expect(unwrapFinishSummaryEnvelope(`${invoke}\n${parameter}\nDone\n${prefix}`, { streaming }))
        .toBe("Done");
    }
  });

  it("renders the summary as it arrives and keeps truncated recognized openers clean", () => {
    expect(unwrapFinishSummaryEnvelope(`${invoke}${parameter}Partial summary`, { streaming: true }))
      .toBe("Partial summary");
    expect(unwrapFinishSummaryEnvelope(`${invoke}\n<parameter name="summ`)).toBe("");
  });

  it.each([
    '<invoke name="finish">',
    "<invoke name='finish'>",
    '<invoke name="finish',
    '<parameter name="summary">',
    'Prior prose.\n<invoke name="finish">\n',
  ])("preserves standalone opening examples after streaming ends: %s", (raw) => {
    expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
  });

  it.each([
    "Done\n</parameter>\n</invoke>",
    "Done\n</parameter></invoke>",
    "Done</parameter> </invoke>",
    "Done\n</parameter>",
    "Done\n</invoke>",
  ])("preserves generic orphan closes without a recognized opening: %s", (raw) => {
    expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
  });

  it.each([
    '<invoke name="run_command"><parameter name="summary">Literal</parameter></invoke>',
    '<invoke name="finish"><parameter name="command">Literal</parameter></invoke>',
    '<invoke name="Finish"><parameter name="summary">Literal</parameter></invoke>',
    '<INVOKE name="finish"><parameter name="summary">Literal</parameter></INVOKE>',
    '<invoke name="finish" id="call-1"><parameter name="summary">Literal</parameter></invoke>',
    '<invoke name="finish"><parameter name="summary" type="text">Literal</parameter></invoke>',
    '<invoke name="finish" name="run_command"><parameter name="summary">Literal</parameter></invoke>',
    '<invoke name=finish><parameter name=summary>Literal</parameter></invoke>',
    '<antml:invoke name="finish"><parameter name="summary">Literal</parameter></antml:invoke>',
    'Use <invoke name="finish"><parameter name="summary"> as literal prose.',
    '    <invoke name="finish"><parameter name="summary">Indented code</parameter></invoke>',
    '&lt;invoke name="finish"&gt; literal escaped markup',
  ])("leaves unrecognized or literal invocation markup unchanged: %s", (raw) => {
    expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
    expect(unwrapFinishSummaryEnvelope(raw, { streaming: true })).toBe(raw);
  });

  it("preserves inline, multiline, indented and fenced code containing the full invocation", () => {
    const literal = `${invoke}${parameter}literal</parameter></invoke>`;
    for (const raw of [
      `\`${literal}\``,
      `\`\`multiline code with a \`single-backtick\` example\n${literal}\n\`\``,
      `\`unfinished multiline code\n${literal}`,
      `    ${literal}`,
      `\`\`\`xml\n${literal}\n\`\`\``,
      `~~~xml\n${literal}\n~~~`,
      `- \`\`\`\`xml\n  ${literal}\n  \`\`\`\n  \`\`\`\``,
      `> - \`\`\`xml\n>   ${literal}\n>   \`\`\``,
    ]) {
      expect(unwrapFinishSummaryEnvelope(raw)).toBe(raw);
      expect(unwrapFinishSummaryEnvelope(raw, { streaming: true })).toBe(raw);
    }
  });

  it("protects code-like closing tags inside a recognized summary", () => {
    const fencedBody = "```xml\n</parameter>\n</invoke>\n```";
    expect(unwrapFinishSummaryEnvelope(`${invoke}${parameter}\n${fencedBody}\n</parameter></invoke>`))
      .toBe(fencedBody);
    for (const body of [
      "`literal</parameter></invoke>`",
      "``multiline code\n</parameter>\n</invoke>\n``",
      "`unfinished code\n</parameter>\n</invoke>",
    ]) {
      expect(unwrapFinishSummaryEnvelope(`${invoke}${parameter}\n${body}`)).toBe(body);
    }
  });

  it("is idempotent and retains citation cleanup without changing its input", () => {
    const raw = `${invoke}${parameter}A <cite index="1-1">grounded claim</cite>.</parameter></invoke>`;
    const original = raw;
    const once = sanitizeModelMarkdown(raw);
    expect(once).toBe("A grounded claim.");
    expect(sanitizeModelMarkdown(once)).toBe(once);
    expect(raw).toBe(original);
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
