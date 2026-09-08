// Markdown highlighting for the app's own prompt editors.
//
// Hand-rolled rather than reused from `react-markdown`: that parser renders
// markdown to HTML and DISCARDS the source, while a highlighting overlay has to
// reproduce the source character for character — every `#`, `*` and space the
// user typed still has to occupy its own cell behind the caret. So
// `tokenizeMarkdown` is LOSSLESS: joining the tokens back together returns the
// input byte for byte, and a test asserts that on every fixture in this file.
//
// It is also deliberately incomplete. Reference links, setext headings, HTML
// blocks and nested-bracket link labels all fall through to plain text, which
// costs a colour and never costs a character.

export type MarkdownTokenKind =
  /** Anything with no markdown meaning. */
  | "text"
  /** The markers themselves — `#`, `**`, `` ` ``, `>`, `-`, `](`. */
  | "syntax"
  | "heading"
  | "strong"
  | "em"
  | "strongEm"
  | "strike"
  /** The body of an inline code span. */
  | "code"
  /** A line inside a fenced block. */
  | "codeBlock"
  | "quote"
  /** A link label. */
  | "link"
  /** A link target. */
  | "url"
  /** A whole thematic-break line. */
  | "rule";

export interface MarkdownToken {
  text: string;
  kind: MarkdownTokenKind;
}

/** Up to three leading spaces still open a fence or a rule, per CommonMark. */
const FENCE_LINE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const RULE_LINE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^#{1,6}(?=\s|$)/;
const QUOTE_PREFIX = /^(?:>\s?)+/;
/** A marker needs its trailing space, or `*bold*` would read as a bullet. */
const BULLET = /^(?:[-*+]|\d{1,9}[.)])\s+/;
const TASK_BOX = /^\[[ xX]\]\s+/;
/** Everything that cannot start a construct, consumed in one run. */
const PLAIN_RUN = /^[^\\`[*_~!]+/;

const EMPHASIS: { marker: string; kind: MarkdownTokenKind }[] = [
  // Longest first: `**` must not be read as an empty `*` pair.
  { marker: "***", kind: "strongEm" },
  { marker: "___", kind: "strongEm" },
  { marker: "**", kind: "strong" },
  { marker: "__", kind: "strong" },
  { marker: "~~", kind: "strike" },
  { marker: "*", kind: "em" },
  { marker: "_", kind: "em" },
];

interface Sink {
  push(text: string, kind: MarkdownTokenKind): void;
  readonly tokens: MarkdownToken[];
}

/** Adjacent tokens of the same kind are merged, so a paragraph of prose is one
 *  span rather than one per character the scanner happened to consume alone. */
function createSink(): Sink {
  const tokens: MarkdownToken[] = [];
  return {
    tokens,
    push(text, kind) {
      if (!text) return;
      const last = tokens[tokens.length - 1];
      if (last && last.kind === kind) last.text += text;
      else tokens.push({ text, kind });
    },
  };
}

/** Emphasis inside emphasis keeps both, which is the one nesting that shows. */
function combine(outer: MarkdownTokenKind, inner: MarkdownTokenKind): MarkdownTokenKind {
  const both =
    (outer === "strong" && inner === "em") || (outer === "em" && inner === "strong");
  return both ? "strongEm" : inner;
}

/** The index of the backtick run that closes a span opened by `n` backticks.
 *  CommonMark requires the closing run to be exactly as long, which is what lets
 *  ``` `` a ` b `` ``` hold a literal backtick. */
function closingTicks(rest: string, n: number): number {
  for (let j = n; j < rest.length; j++) {
    if (rest[j] !== "`") continue;
    let k = j;
    while (k < rest.length && rest[k] === "`") k++;
    if (k - j === n) return j;
    j = k - 1;
  }
  return -1;
}

/** The index of the delimiter that closes an emphasis span, or -1. */
function closingDelimiter(rest: string, marker: string): number {
  const from = marker.length;
  // `* ` is a bullet and `_ ` is prose; emphasis never opens on whitespace.
  if (from >= rest.length || /\s/.test(rest[from])) return -1;
  for (let j = rest.indexOf(marker, from + 1); j !== -1; j = rest.indexOf(marker, j + 1)) {
    if (/\s/.test(rest[j - 1])) continue;
    // The closer of an underscore span may not sit inside a word either, or
    // `_a_b_` would leave `b` emphasised and the trailing `_` orphaned.
    if (marker[0] === "_" && /\w/.test(rest[j + marker.length] ?? "")) continue;
    return j;
  }
  return -1;
}

function scanInline(source: string, base: MarkdownTokenKind, out: Sink): void {
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    // A backslash escape is one unit — without it `\*` would open emphasis.
    if (rest[0] === "\\" && rest.length > 1) {
      out.push("\\", "syntax");
      out.push(rest[1], base);
      i += 2;
      continue;
    }

    if (rest[0] === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = closingTicks(rest, run.length);
      if (close !== -1) {
        out.push(run, "syntax");
        out.push(rest.slice(run.length, close), "code");
        out.push(rest.slice(close, close + run.length), "syntax");
        i += close + run.length;
        continue;
      }
      out.push(run, base);
      i += run.length;
      continue;
    }

    // Inline links and images. A nested `[` in the label is not supported; it
    // falls through and costs a colour, never a character.
    const link = /^(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/.exec(rest);
    if (link) {
      out.push(`${link[1]}[`, "syntax");
      scanInline(link[2], "link", out);
      out.push("](", "syntax");
      out.push(link[3], "url");
      out.push(")", "syntax");
      i += link[0].length;
      continue;
    }

    const prev = i > 0 ? source[i - 1] : "";
    let matched = false;
    for (const { marker, kind } of EMPHASIS) {
      if (!rest.startsWith(marker)) continue;
      // Underscores must not fire inside a word: `max_tokens` and
      // `--no-pager --snake_case` are ordinary prose in a prompt about shells.
      if (marker[0] === "_" && /\w/.test(prev)) continue;
      const close = closingDelimiter(rest, marker);
      if (close === -1) continue;
      out.push(marker, "syntax");
      scanInline(rest.slice(marker.length, close), combine(base, kind), out);
      out.push(marker, "syntax");
      i += close + marker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    const run = PLAIN_RUN.exec(rest);
    if (run) {
      out.push(run[0], base);
      i += run[0].length;
      continue;
    }
    // A construct character that opened nothing: emit it and move on.
    out.push(rest[0], base);
    i += 1;
  }
}

function scanLine(line: string, out: Sink): void {
  if (RULE_LINE.test(line)) {
    out.push(line, "rule");
    return;
  }

  const indent = /^\s*/.exec(line)![0];
  out.push(indent, "text");
  let rest = line.slice(indent.length);

  const heading = HEADING.exec(rest);
  if (heading) {
    out.push(heading[0], "syntax");
    scanInline(rest.slice(heading[0].length), "heading", out);
    return;
  }

  let base: MarkdownTokenKind = "text";
  const quote = QUOTE_PREFIX.exec(rest);
  if (quote) {
    out.push(quote[0], "syntax");
    rest = rest.slice(quote[0].length);
    base = "quote";
  }

  const bullet = BULLET.exec(rest);
  if (bullet) {
    out.push(bullet[0], "syntax");
    rest = rest.slice(bullet[0].length);
    const task = TASK_BOX.exec(rest);
    if (task) {
      out.push(task[0], "syntax");
      rest = rest.slice(task[0].length);
    }
  }

  scanInline(rest, base, out);
}

/**
 * Split markdown source into coloured spans.
 *
 * LOSSLESS: `tokenizeMarkdown(s).map(t => t.text).join("") === s` for every `s`.
 * The overlay this feeds sits behind a transparent textarea, so a single dropped
 * or duplicated character shifts every glyph after it out from under the caret.
 */
export function tokenizeMarkdown(source: string): MarkdownToken[] {
  const out = createSink();
  let fence: string | null = null;
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    // The separator carries the kind of the block it sits in, so a fenced block
    // stays one span instead of being cut in two per line.
    if (i > 0) out.push("\n", fence ? "codeBlock" : "text");

    const line = lines[i];
    const fenceLine = FENCE_LINE.exec(line);

    if (fence) {
      const closes =
        fenceLine !== null &&
        fenceLine[2][0] === fence[0] &&
        fenceLine[2].length >= fence.length &&
        fenceLine[3].trim() === "";
      if (closes) {
        out.push(line, "syntax");
        fence = null;
      } else {
        out.push(line, "codeBlock");
      }
      continue;
    }

    if (fenceLine) {
      fence = fenceLine[2];
      out.push(fenceLine[1] + fenceLine[2], "syntax");
      out.push(fenceLine[3], "code");
      continue;
    }

    scanLine(line, out);
  }

  return out.tokens;
}
