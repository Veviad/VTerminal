import { stripCiteTags } from "./citations";
import {
  markdownProtection,
  type MarkdownLine,
  type MarkdownProtection,
} from "./markdownProtection";

const FINISH_OPEN = "<finish>";
const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";
const FINISH_CLOSE = "</finish>";

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

function isSummaryFinishPair(
  controlText: string,
  allowPartial: boolean,
): boolean {
  if (!controlText.startsWith(SUMMARY_CLOSE)) return false;
  const afterSummary = controlText.slice(SUMMARY_CLOSE.length);
  if (!/^\s/u.test(afterSummary)) return false;
  const finish = afterSummary.trimStart();
  return finish === FINISH_CLOSE || (allowPartial && isProperPrefix(finish, FINISH_CLOSE));
}

/**
 * Once the opening pair has positively identified protocol output, its closing
 * pair may be attached directly to the last prose line. Streaming can stop at any
 * prefix of either close tag, so hide that suffix until it becomes complete.
 */
function stripRecognizedTrailingSuffix(
  content: string,
  protection: MarkdownProtection,
): string {
  const withoutTrailingWhitespace = content.replace(/[ \t\r\n]+$/u, "");
  const stripAt = (offset: number): string | null => {
    if (protection.isProtected(offset)) return null;
    return withoutTrailingWhitespace.slice(0, offset).replace(/[ \t\r\n]+$/u, "");
  };

  const completePair = /<\/summary>\s+<\/finish>$/u.exec(withoutTrailingWhitespace);
  if (completePair) {
    const finishOffset = completePair.index + completePair[0].lastIndexOf(FINISH_CLOSE);
    if (!protection.isProtected(finishOffset)) {
      const stripped = stripAt(completePair.index);
      if (stripped !== null) return stripped;
    }
  }

  const partialFinish = /<\/summary>\s+(\S*)$/u.exec(withoutTrailingWhitespace);
  if (
    partialFinish &&
    isProperPrefix(partialFinish[1], FINISH_CLOSE)
  ) {
    const stripped = stripAt(partialFinish.index);
    if (stripped !== null) return stripped;
  }

  if (withoutTrailingWhitespace.endsWith(SUMMARY_CLOSE)) {
    const offset = withoutTrailingWhitespace.length - SUMMARY_CLOSE.length;
    const stripped = stripAt(offset);
    if (stripped !== null) return stripped;
  }

  for (let width = SUMMARY_CLOSE.length - 1; width > 0; width -= 1) {
    const partial = SUMMARY_CLOSE.slice(0, width);
    if (!withoutTrailingWhitespace.endsWith(partial)) continue;
    const offset = withoutTrailingWhitespace.length - partial.length;
    const stripped = stripAt(offset);
    if (stripped !== null) return stripped;
  }

  return content;
}

/**
 * Remove only trailing, stand-alone protocol close lines. An exact orphan close
 * pair is cleaned for already archived output whose opening edge is unavailable.
 * Partial or lone closes are hidden only after this buffer proved it began with
 * the known envelope.
 */
function stripTrailingControlLines(content: string, openedEnvelope: boolean): string {
  const protection = markdownProtection(content);
  if (openedEnvelope) {
    const strippedSuffix = stripRecognizedTrailingSuffix(content, protection);
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
    isSummaryFinishPair(controlText, openedEnvelope)
  ) {
    cutoff = lines[index].start;
    removed = true;
    controlText = null;
  }

  if (!removed) {
    const finishLike =
      controlText === FINISH_CLOSE ||
      (openedEnvelope &&
        controlText !== null &&
        isProperPrefix(controlText, FINISH_CLOSE));
    if (finishLike) {
      const finishStart = lines[index].start;
      const summaryIndex = previousNonBlankLine(lines, index - 1);
      const summaryToken =
        summaryIndex >= 0
          ? unprotectedLineControlToken(lines[summaryIndex], protection)
          : null;
      const summaryLike =
        summaryToken === SUMMARY_CLOSE ||
        (openedEnvelope &&
          summaryToken !== null &&
          isProperPrefix(summaryToken, SUMMARY_CLOSE));

      if (summaryLike) {
        cutoff = lines[summaryIndex].start;
        removed = true;
      } else if (openedEnvelope) {
        cutoff = finishStart;
        removed = true;
      }
    } else if (
      openedEnvelope &&
      (controlText === SUMMARY_CLOSE ||
        (controlText !== null && isProperPrefix(controlText, SUMMARY_CLOSE)))
    ) {
      cutoff = lines[index].start;
      removed = true;
    }
  }

  if (!removed) return content;
  return content.slice(0, cutoff).replace(/[ \t\r\n]+$/u, "");
}

/**
 * Unwrap the exact pseudo-tool envelope observed in model prose:
 *
 *     <finish>
 *     <summary>
 *     ...answer...
 *     </summary>
 *     </finish>
 *
 * This is deliberately not an HTML sanitizer or a general tag stripper. The
 * opening pair must begin at an unprotected Markdown line boundary, be lowercase
 * and attribute free, and have whitespace between the two tags. The line may come
 * after ordinary prose, which is preserved. After a recognized opening pair, its
 * closing pair may occupy stand-alone lines or attach to the final prose line.
 * Literal prose and Markdown code examples remain intact.
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
    const finishMatch = matchTagAt(content, finishOffset, FINISH_OPEN);
    if (finishMatch === "partial") {
      if (streaming) return visiblePrefix(content, line.start);
      continue;
    }
    if (finishMatch === "none") continue;

    const afterFinish = finishOffset + FINISH_OPEN.length;
    const summaryOffset = skipWhitespace(content, afterFinish);
    if (summaryOffset === afterFinish) {
      if (afterFinish === content.length && streaming) {
        return visiblePrefix(content, line.start);
      }
      continue;
    }
    if (summaryOffset === content.length) {
      if (streaming) return visiblePrefix(content, line.start);
      continue;
    }

    const summaryMatch = matchTagAt(content, summaryOffset, SUMMARY_OPEN);
    if (summaryMatch === "partial") {
      // A complete finish tag followed by the beginning of summary is already
      // specific enough to identify the known envelope, including a transcript
      // truncated between provider chunks.
      return visiblePrefix(content, line.start);
    }
    if (summaryMatch === "none") continue;

    const bodyOffset = skipOpeningSeparator(content, summaryOffset + SUMMARY_OPEN.length);
    const body = stripTrailingControlLines(content.slice(bodyOffset), true);
    return visiblePrefix(content, line.start) + body;
  }

  return stripTrailingControlLines(content, false);
}

/** Apply presentation-only cleanup to model-origin Markdown. */
export function sanitizeModelMarkdown(
  content: string,
  options: { streaming?: boolean } = {},
): string {
  return unwrapFinishSummaryEnvelope(stripCiteTags(content), options);
}
