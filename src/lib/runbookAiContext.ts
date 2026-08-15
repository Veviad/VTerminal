/**
 * The terminal session, as material for authoring a Runbook.
 *
 * This is NOT `buildTerminalContext` (hooks/useAiStream.ts). That one answers
 * "what is this tab doing right now?" for a chat turn and is capped at three
 * blocks. Authoring asks the opposite question — "what did the operator do over
 * the last hour?" — so it walks the whole session, oldest first, and spends its
 * budget on breadth.
 *
 * Everything here is shown to the operator before it is sent. The picker is not
 * decoration: a terminal session is the single richest source of secrets a user
 * has, and the model is being asked to read all of it.
 */

import { useAppStore, type SessionUiState } from "../stores/appStore";
import { readBlockOutput } from "../hooks/useAiStream";
import { isRunbookTerminalProtected } from "./runbookTerminalPrivacy";
import type { Block } from "./types";

/** Per block. Enough for a package manager's summary or a config dump. */
export const BLOCK_OUTPUT_LIMIT = 4096;

/** Whole payload. Mirrors `MAX_CONTEXT_CHARS` in runbooks/authoring.rs, which
 *  trims again server-side; keeping the frontend under it means the operator
 *  sees what is actually sent. */
export const CONTEXT_BUDGET = 24_000;

export interface RunbookContextBlock {
  id: string;
  command: string;
  exitCode: number | null;
  output: string;
  /** Output was captured but is no longer in the buffer. Shown, not hidden:
   *  "this command's output is gone" is information the operator needs when
   *  deciding whether the model has enough to work with. */
  outputUnavailable: boolean;
}

export type ContextAvailability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Why the terminal cannot be attached, if it cannot.
 *
 * `sendContextToAi` is the operator's standing answer to this exact question
 * and is honoured without asking again. The runbook-protected case is narrow —
 * a tab that has executed a Runbook line suppresses its scrollback for the rest
 * of its life so redacted evidence cannot be recovered from a raw capture — but
 * this path must not be the hole in that boundary.
 *
 * The flag is a PARAMETER rather than a store read so a caller can subscribe to
 * it: read through `getState()` this would not re-render when the operator
 * changed the setting with the panel open.
 */
export function contextAvailability(
  sessionId: string | null,
  sendContextToAi: boolean,
): ContextAvailability {
  if (!sendContextToAi) {
    return {
      available: false,
      reason: "Terminal context is switched off in Settings → AI.",
    };
  }
  if (sessionId && isRunbookTerminalProtected(sessionId)) {
    return {
      available: false,
      reason: "This tab has run a Runbook, so its output is not readable here.",
    };
  }
  return { available: true };
}

/**
 * One session's blocks, looked up without a variable bracket index.
 *
 * `sessionUi[sessionId]` reads as an object-injection sink to static analysis,
 * and the tab count is small enough that scanning the entries costs nothing.
 * Also the dependency the generator's memo watches: output is scraped from the
 * live xterm buffer, so this list is what says a new command has landed.
 */
export function blocksOf(
  sessionUi: Record<string, SessionUiState>,
  sessionId: string | null,
): Block[] {
  if (!sessionId) return NO_BLOCKS;
  return Object.entries(sessionUi).find(([id]) => id === sessionId)?.[1].blocks ?? NO_BLOCKS;
}

/** A stable reference, so a session with no entry does not hand a caller's memo
 *  a fresh array on every render. */
const NO_BLOCKS: Block[] = [];

/**
 * Every finished command in one session, oldest first.
 *
 * Agent-run blocks are excluded for the same reason `buildTerminalContext`
 * excludes them: they are the model's own past output, and authoring from them
 * would launder a previous suggestion into a runbook as though the operator had
 * chosen it.
 */
export function collectSessionBlocks(sessionId: string): RunbookContextBlock[] {
  const state = useAppStore.getState();
  if (!contextAvailability(sessionId, state.sendContextToAi).available) return [];
  return blocksOf(state.sessionUi, sessionId)
    .filter((b: Block) => b.state === "done" && b.command.trim() && b.origin !== "agent")
    .map((b: Block) => {
      const output = readBlockOutput(sessionId, b, BLOCK_OUTPUT_LIMIT);
      return {
        id: b.id,
        command: b.command,
        exitCode: b.exitCode,
        output,
        // Output lives in the xterm buffer, not the store, so a block whose
        // rows have been trimmed out of scrollback keeps its command and loses
        // its output.
        outputUnavailable: output === "" && b.state === "done",
      };
    });
}

/**
 * Render the chosen blocks as the transcript the model reads.
 *
 * Drops the OLDEST blocks when over budget: the operator's most recent work is
 * what the runbook is usually about, and the tail of a session is where the
 * thing finally worked. Says so in the payload rather than silently shortening
 * it, because a model that cannot see the beginning should not assume there was
 * none.
 */
export function renderContext(
  blocks: RunbookContextBlock[],
  budget = CONTEXT_BUDGET,
): string {
  const rendered: string[] = [];
  let used = 0;
  let dropped = 0;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = renderBlock(blocks[i]);
    if (used + text.length > budget && rendered.length > 0) {
      dropped = i + 1;
      break;
    }
    rendered.unshift(text);
    used += text.length;
  }

  if (dropped > 0) {
    rendered.unshift(`[${dropped} earlier command${dropped === 1 ? "" : "s"} omitted]\n`);
  }
  return rendered.join("\n");
}

function renderBlock(block: RunbookContextBlock): string {
  const status = block.exitCode === null ? "" : ` (exit ${block.exitCode})`;
  const body = block.outputUnavailable
    ? "[output no longer in scrollback]"
    : block.output || "[no output]";
  return `$ ${block.command}${status}\n${body}\n`;
}
