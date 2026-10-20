import { stripCiteTags } from "./citations";
import {
  markdownProtection,
  type MarkdownLine,
  type MarkdownProtection,
} from "./markdownProtection";

interface EnvelopeFormat {
  outerOpen: string;
  bodyOpen: string;
  bodyClose: string;
  outerClose: string;
  adjacentTags: boolean;
  completeClosePair: RegExp;
  partialOuterClose: RegExp;
}

const LEGACY_FORMAT: EnvelopeFormat = {
  outerOpen: "<finish>",
  bodyOpen: "<summary>",
  bodyClose: "</summary>",
  outerClose: "</finish>",
  adjacentTags: false,
  completeClosePair: /<\/summary>\s+<\/finish>$/u,
  partialOuterClose: /<\/summary>\s+(\S*)$/u,
};

const INVOCATION_CLOSING_FORMAT = {
  bodyClose: "</parameter>",
  outerClose: "</invoke>",
  adjacentTags: true,
  completeClosePair: /<\/parameter>\s*<\/invoke>$/u,
  partialOuterClose: /<\/parameter>\s*(\S*)$/u,
};

const ENVELOPE_FORMATS: readonly EnvelopeFormat[] = [
  LEGACY_FORMAT,
  ...['"', "'"].flatMap((outerQuote) =>
    ['"', "'"].map((bodyQuote) => ({
      ...INVOCATION_CLOSING_FORMAT,
      outerOpen: `<invoke name=${outerQuote}finish${outerQuote}>`,
      bodyOpen: `<parameter name=${bodyQuote}summary${bodyQuote}>`,
    })),
  ),
];

type TagMatch = "complete" | "partial" | "none";

function matchTagAt(content: string, offset: number, tag: string): TagMatch {
  const remaining = content.slice(offset);
  if (remaining.startsWith(tag)) return "complete";
  return remaining.length < tag.length && tag.startsWith(remaining) ? "partial" : "none";
}

function skipWhitespace(content: string, offset: number): number {
  while (offset < content.length && /\s/u.test(content[offset])) offset += 1;
  return offset;
}

/** Remove the tag's own separator without consuming indentation in its body. */
function skipOpeningSeparator(content: string, offset: number): number {
  while (offset < content.length && /[ \t]/u.test(content[offset])) offset += 1;
  if (content.startsWith("\r\n", offset)) return offset + 2;
  if (content[offset] === "\n") return offset + 1;
  return offset;
}

function lineControlToken(line: MarkdownLine): string | null {
  if (line.protectedByFence) return null;
  const match = line.text.match(/^ {0,3}(\S(?:.*\S)?)[ \t]*$/);
  return match?.[1] ?? null;
}

function unprotectedLineControlToken(
  line: MarkdownLine,
  protection: MarkdownProtection,
): string | null {
  const lineValue = lineControlToken(line);
  if (lineValue === null) return null;
  const indentation = line.text.match(/^ {0,3}/)?.[0].length ?? 0;
  return protection.isProtected(line.start + indentation) ? null : lineValue;
}

function previousNonBlankLine(lines: readonly MarkdownLine[], from: number): number {
  let index = from;
  while (index >= 0 && /^[ \t]*$/.test(lines[index].text)) index -= 1;
  return index;
}

function isProperPrefix(value: string, tag: string): boolean {
  return value.length > 0 && value.length < tag.length && tag.startsWith(value);
}

function visiblePrefix(content: string, lineStart: number): string {
  const prefix = content.slice(0, lineStart);
  return prefix.trim().length === 0 ? "" : prefix;
}

function isClosingPair(
  controlText: string,
  allowPartial: boolean,
  format: EnvelopeFormat,
): boolean {
  if (!controlText.startsWith(format.bodyClose)) return false;
  const afterSummary = controlText.slice(format.bodyClose.length);
  if (!format.adjacentTags && !/^\s/u.test(afterSummary)) return false;
  const finish = afterSummary.trimStart();
  return finish === format.outerClose || (allowPartial && isProperPrefix(finish, format.outerClose));
}

/**
 * Once the opening pair has positively identified protocol output, its closing
 * pair may be attached directly to the last prose line. Streaming can stop at any
 * prefix of either close tag, so hide that suffix until it becomes complete.
 */
function stripRecognizedTrailingSuffix(
  content: string,
  protection: MarkdownProtection,
  format: EnvelopeFormat,
): string {
  const withoutTrailingWhitespace = content.replace(/[ \t\r\n]+$/u, "");
  const stripAt = (offset: number): string | null => {
    if (protection.isProtected(offset)) return null;
    return withoutTrailingWhitespace.slice(0, offset).replace(/[ \t\r\n]+$/u, "");
  };

  const completePair = format.completeClosePair.exec(withoutTrailingWhitespace);
  if (completePair) {
    const finishOffset = completePair.index + completePair[0].lastIndexOf(format.outerClose);
    if (!protection.isProtected(finishOffset)) {
      const stripped = stripAt(completePair.index);
      if (stripped !== null) return stripped;
    }
  }

  const partialFinish = format.partialOuterClose.exec(withoutTrailingWhitespace);
  if (
    partialFinish &&
    isProperPrefix(partialFinish[1], format.outerClose)
  ) {
    const stripped = stripAt(partialFinish.index);
    if (stripped !== null) return stripped;
  }

  if (withoutTrailingWhitespace.endsWith(format.bodyClose)) {
    const offset = withoutTrailingWhitespace.length - format.bodyClose.length;
    const stripped = stripAt(offset);
    if (stripped !== null) return stripped;
  }

  for (let width = format.bodyClose.length - 1; width > 0; width -= 1) {
    const partial = format.bodyClose.slice(0, width);
    if (!withoutTrailingWhitespace.endsWith(partial)) continue;
    const offset = withoutTrailingWhitespace.length - partial.length;
    const stripped = stripAt(offset);
    if (stripped !== null) return stripped;
  }

  return content;
}

/**
 * Remove trailing protocol close lines. The legacy summary/finish pair is also
 * recognized without its opening edge; generic parameter/invoke closes require
 * a positively identified finish/summary opening pair. Partial or lone closes
 * are hidden only after recognizing an opening pair.
 */
function stripTrailingControlLines(
  content: string,
  openedEnvelope: boolean,
  format: EnvelopeFormat,
): string {
  const protection = markdownProtection(content);
  if (openedEnvelope) {
    const strippedSuffix = stripRecognizedTrailingSuffix(content, protection, format);
    if (strippedSuffix !== content) return strippedSuffix;
  }

  const lines = protection.lines;
  if (lines.length === 0) return content;

  let index = previousNonBlankLine(lines, lines.length - 1);
  let cutoff = content.length;
  let removed = false;
  let controlText =
    index >= 0 ? unprotectedLineControlToken(lines[index], protection) : null;

  if (
    controlText !== null &&
    isClosingPair(controlText, openedEnvelope, format)
  ) {
    cutoff = lines[index].start;
    removed = true;
    controlText = null;
  }

  if (!removed) {
    const finishLike =
      controlText === format.outerClose ||
      (openedEnvelope &&
        controlText !== null &&
        isProperPrefix(controlText, format.outerClose));
    if (finishLike) {
      const finishStart = lines[index].start;
      const summaryIndex = previousNonBlankLine(lines, index - 1);
      const summaryToken =
        summaryIndex >= 0
          ? unprotectedLineControlToken(lines[summaryIndex], protection)
          : null;
      const summaryLike =
        summaryToken === format.bodyClose ||
        (openedEnvelope &&
          summaryToken !== null &&
          isProperPrefix(summaryToken, format.bodyClose));

      if (summaryLike) {
        cutoff = lines[summaryIndex].start;
        removed = true;
      } else if (openedEnvelope) {
        cutoff = finishStart;
        removed = true;
      }
    } else if (
      openedEnvelope &&
      (controlText === format.bodyClose ||
        (controlText !== null && isProperPrefix(controlText, format.bodyClose)))
    ) {
      cutoff = lines[index].start;
      removed = true;
    }
  }

  if (!removed) return content;
  return content.slice(0, cutoff).replace(/[ \t\r\n]+$/u, "");
}

/**
 * Unwrap the exact finish/summary pseudo-tool envelopes observed in model prose:
 *
 *     <finish>
 *     <summary>
 *     ...answer...
 *     </summary>
 *     </finish>
 *
 *     <invoke name="finish"><parameter name="summary">
 *     ...answer...
 *     </parameter></invoke>
 *
 * This is deliberately not an HTML sanitizer or a general tag stripper. The
 * opening pair must begin at an unprotected Markdown line boundary. Names are
 * lowercase and exact; invocation attributes accept only name="finish" and
 * name="summary", with either quote style. Invocation tags may be adjacent;
 * legacy tags retain their whitespace requirement. Prior prose and Markdown
 * code examples remain intact. This function changes presentation only.
 */
export function unwrapFinishSummaryEnvelope(
  content: string,
  options: { streaming?: boolean } = {},
): string {
  const streaming = options.streaming ?? false;
  // Every protocol marker begins with "<". Avoid even the linear Markdown scan
  // for the overwhelmingly common case of ordinary model prose.
  if (!content.includes("<")) return content;
  const protection = markdownProtection(content);
  for (const line of protection.lines) {
    if (line.protectedByFence) continue;
    const indentation = line.text.match(/^ {0,3}/)?.[0].length ?? 0;
    const finishOffset = line.start + indentation;
    if (protection.isProtected(finishOffset)) continue;
    for (const format of ENVELOPE_FORMATS) {
      const finishMatch = matchTagAt(content, finishOffset, format.outerOpen);
      if (finishMatch === "partial") {
        if (streaming) return visiblePrefix(content, line.start);
        continue;
      }
      if (finishMatch === "none") continue;

      const afterFinish = finishOffset + format.outerOpen.length;
      const summaryOffset = skipWhitespace(content, afterFinish);
      if (summaryOffset === content.length) {
        if (streaming) return visiblePrefix(content, line.start);
        continue;
      }
      if (!format.adjacentTags && summaryOffset === afterFinish) continue;

      const summaryMatch = matchTagAt(content, summaryOffset, format.bodyOpen);
      if (summaryMatch === "partial") {
        // The complete known outer tag followed by a partial summary opener
        // identifies protocol output even when a transcript was truncated.
        return visiblePrefix(content, line.start);
      }
      if (summaryMatch === "none") continue;

      const bodyOffset = skipOpeningSeparator(content, summaryOffset + format.bodyOpen.length);
      const body = stripTrailingControlLines(content.slice(bodyOffset), true, format);
      return visiblePrefix(content, line.start) + body;
    }
  }

  return stripTrailingControlLines(content, false, LEGACY_FORMAT);
}

/** Apply presentation-only cleanup to model-origin Markdown. */
export function sanitizeModelMarkdown(
  content: string,
  options: { streaming?: boolean } = {},
): string {
  return unwrapFinishSummaryEnvelope(stripCiteTags(content), options);
}
