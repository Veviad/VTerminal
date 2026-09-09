import type { Terminal } from "@xterm/xterm";

type EchoTerminal = Pick<Terminal, "write">;

interface PendingEcho {
  line: string;
  visible: string | null;
  bytes: Uint8Array;
  acknowledgments: Array<() => void>;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new WeakMap<EchoTerminal, PendingEcho>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ECHO_BYTES = 65_536;
const ECHO_WAIT_MS = 2_000;

/** Only arm for an exact, nonce-bearing line that the executor is about to
 * write. Ordinary terminal output never goes through a protocol-text regex. */
export function expectPtyEcho(
  term: EchoTerminal,
  line: string,
  visible: string | null,
): () => void {
  cancelPtyEcho(term);
  const echo: PendingEcho = {
    line,
    visible,
    bytes: new Uint8Array(),
    acknowledgments: [],
    timer: setTimeout(() => cancelPtyEcho(term), ECHO_WAIT_MS),
  };
  pending.set(term, echo);
  return () => {
    if (pending.get(term) === echo) cancelPtyEcho(term);
  };
}

/** Fail open on timeout, failed dispatch or user input. Disposal may discard
 * the small held echo because the terminal is about to be destroyed. */
export function cancelPtyEcho(term: EchoTerminal, discard = false): void {
  const echo = pending.get(term);
  if (!echo) return;
  pending.delete(term);
  clearTimeout(echo.timer);
  if (discard) {
    // Discarded data is consumed without a parser when the terminal closes.
    for (const acknowledge of echo.acknowledgments.splice(0)) acknowledge();
  } else if (echo.bytes.length || echo.acknowledgments.length) {
    writeEcho(term, echo, echo.bytes);
  }
}

/** Feed live PTY bytes into xterm, replacing only a proven command-line echo.
 * Keep the original-byte acknowledgment callback even when the echo shrinks.
 * Held chunks remain outstanding until xterm parses their eventual write.
 * The 64 KiB echo cap stays below the backend's 256 KiB resume watermark. */
export function writePtyOutput(
  term: EchoTerminal,
  bytes: Uint8Array,
  onParsed?: () => void,
): void {
  const echo = pending.get(term);
  if (!echo) {
    term.write(bytes, onParsed);
    return;
  }
  if (onParsed) echo.acknowledgments.push(onParsed);
  const held = new Uint8Array(echo.bytes.length + bytes.length);
  held.set(echo.bytes);
  held.set(bytes, echo.bytes.length);
  echo.bytes = held;

  const newline = held.indexOf(10);
  // Only line-editor decorations may be held. OSC completion/prompt signals,
  // terminal queries and other controls must reach xterm immediately, even
  // without a newline: the shell may be waiting for xterm's response.
  const echoLength = newline < 0 ? held.length : newline + 1;
  if (hasNonEchoControl(held.subarray(0, newline < 0 ? held.length : newline)) ||
      echoLength > MAX_ECHO_BYTES) {
    pending.delete(term);
    clearTimeout(echo.timer);
    writeEcho(term, echo, held);
    return;
  }
  if (newline < 0) return;

  pending.delete(term);
  clearTimeout(echo.timer);
  const raw = decoder.decode(held.subarray(0, newline));
  const normalized = normalizeEcho(raw);
  if (!normalized || normalized.text !== echo.line) {
    // A concurrent message, an unfamiliar line editor, or no command echo.
    // Preserve every byte rather than risk eating real output.
    writeEcho(term, echo, held);
    return;
  }

  // Probe: clear the existing prompt row so the shell's next prompt replaces
  // it. Command: keep the approved/hardened text, without the private suffix.
  // Mode changes (especially bracketed paste) still belong to the real shell.
  // When ZLE erased a right prompt, clear it before drawing the shorter line.
  const replacement = encoder.encode(
    (echo.visible === null
      ? "\r\x1b[2K"
      : `${normalized.clearToEnd ? "\x1b[K" : ""}${echo.visible}\r\n`) + normalized.modes,
  );
  const output = new Uint8Array(replacement.length + held.length - newline - 1);
  output.set(replacement);
  output.set(held.subarray(newline + 1), replacement.length);
  writeEcho(term, echo, output);
}

function writeEcho(term: EchoTerminal, echo: PendingEcho, bytes: Uint8Array): void {
  const acknowledgments = echo.acknowledgments.splice(0);
  term.write(bytes, () => {
    for (const acknowledge of acknowledgments) acknowledge();
  });
}

function echoCsiKind(sequence: string): "mode" | "decoration" | null {
  // An alternate-screen transition is program output, never an input echo.
  if (/^\x1b\[\?[\d;]*\b(?:47|1047|1049)\b[\d;]*[hl]$/.test(sequence)) return null;
  if (/^\x1b\[\??[\d;]+[hl]$/.test(sequence)) return "mode";
  if (/^\x1b\[[\d;:]*m$/.test(sequence) || /^\x1b\[\d*[CDGK]$/.test(sequence)) {
    return "decoration";
  }
  return null;
}

function hasNonEchoControl(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 27) {
      const start = i;
      if (++i === bytes.length) return false; // split ESC sequence
      if (bytes[i] !== 91) return true; // OSC, DCS or another ESC control
      while (++i < bytes.length && bytes[i] >= 0x20 && bytes[i] <= 0x3f) { /* CSI parameters */ }
      if (i === bytes.length) return false;
      if (!echoCsiKind(decoder.decode(bytes.subarray(start, i + 1)))) return true;
    } else if ((byte < 32 && byte !== 8 && byte !== 13) || byte === 127) {
      return true;
    }
  }
  return false;
}

/** Readline/ZLE decorate a submitted line before its first LF. Their soft
 * wraps use CR (not LF), and ZLE repeats the margin character after erasing
 * the next row. Normalize these only for exact equality with our own line. */
function normalizeEcho(raw: string): { text: string; modes: string; clearToEnd: boolean } | null {
  let modes = "";
  let clearToEnd = false;
  let text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => {
    if (echoCsiKind(sequence) === "mode") modes += sequence;
    if (sequence.endsWith("K")) clearToEnd = true;
    return "";
  });
  // Unrecognized control sequences are not command echo we know how to edit.
  if (/[\x00-\x07\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return null;
  const characters: string[] = [];
  for (const character of text) {
    if (character === "\b") characters.pop();
    else characters.push(character);
  }
  text = characters.join("")
    .replace(/ \r/g, "")
    .replace(/([^\r])\r(?=\1)/gu, "")
    .replace(/\r+$/, "");
  return { text, modes, clearToEnd };
}
