import type { Terminal } from "@xterm/xterm";

type EchoTerminal = Pick<Terminal, "write">;

interface PendingEcho {
  line: string;
  visible: string | null;
  bytes: Uint8Array;
  acknowledgments: Array<() => void>;
  timer: ReturnType<typeof setTimeout>;
  protocol: { kind: "osc" | "dcs"; escaped: boolean; prefix: string } | null;
  forwardedBytes: number;
  probeNonce?: string;
  expiresAt?: number;
  retired: boolean;
}

const pending = new WeakMap<EchoTerminal, PendingEcho[]>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ECHO_BYTES = 65_536;
const ECHO_WAIT_MS = 2_000;
/** Retain only exact, nonce-owned setup lines after their request stops waiting.
 * Incoming printable bytes still get the ordinary short buffering deadline. */
const LATE_PROBE_ECHO_MS = 60_000;
const MAX_EXPECTATIONS = 4;

function removeEcho(term: EchoTerminal, echo: PendingEcho): void {
  clearTimeout(echo.timer);
  const queue = pending.get(term);
  if (!queue) return;
  const index = queue.indexOf(echo);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) pending.delete(term);
}

function retireEcho(term: EchoTerminal, echo: PendingEcho): void {
  if (!pending.get(term)?.includes(echo)) return;
  clearTimeout(echo.timer);
  if (echo.probeNonce && echo.expiresAt && performance.now() < echo.expiresAt && !echo.bytes.length && !echo.acknowledgments.length) {
    echo.retired = true;
    echo.timer = setTimeout(() => retireEcho(term, echo), echo.expiresAt - performance.now());
    return;
  }
  removeEcho(term, echo);
  if (echo.bytes.length || echo.acknowledgments.length) writeEcho(term, echo, echo.bytes);
}

/** Only arm for an exact line that the executor is about to write. A private
 * probe nonce may retain an empty expectation across a delayed SSH response;
 * ordinary output is never matched against a generic protocol-text regex. */
export function expectPtyEcho(
  term: EchoTerminal,
  line: string,
  visible: string | null,
  options?: { probeNonce: string },
): () => void {
  // A replacement supersedes ordinary command expectations. An older probe
  // may still be in the transport, so preserve its exact owned line briefly.
  for (const existing of [...(pending.get(term) ?? [])]) {
    if (!existing.probeNonce) {
      removeEcho(term, existing);
      if (existing.bytes.length || existing.acknowledgments.length) writeEcho(term, existing, existing.bytes);
    }
  }
  const requestedNonce = options?.probeNonce;
  const probeNonce = visible === null && requestedNonce !== undefined
    && /^[a-f0-9]{32}$/.test(requestedNonce) && line.includes(`RP;${requestedNonce};`)
    ? requestedNonce : undefined;
  const echo: PendingEcho = {
    line,
    visible,
    bytes: new Uint8Array(),
    acknowledgments: [],
    timer: setTimeout(() => retireEcho(term, echo), ECHO_WAIT_MS),
    protocol: null,
    forwardedBytes: 0,
    probeNonce,
    expiresAt: probeNonce ? performance.now() + LATE_PROBE_ECHO_MS : undefined,
    retired: false,
  };
  const queue = pending.get(term) ?? [];
  queue.push(echo);
  pending.set(term, queue);
  while (queue.length > MAX_EXPECTATIONS) {
    const oldest = queue[0];
    removeEcho(term, oldest);
    if (oldest.bytes.length || oldest.acknowledgments.length) writeEcho(term, oldest, oldest.bytes);
  }
  return () => retireEcho(term, echo);
}

/** User input/disposal invalidates all active and retired expectations. A
 * request's private cleanup callback instead retires only its owned probe. */
export function cancelPtyEcho(term: EchoTerminal, discard = false): void {
  const queue = pending.get(term);
  if (!queue) return;
  pending.delete(term);
  for (const echo of queue) {
    clearTimeout(echo.timer);
    if (discard) {
      for (const acknowledge of echo.acknowledgments.splice(0)) acknowledge();
    } else if (echo.bytes.length || echo.acknowledgments.length) {
      writeEcho(term, echo, echo.bytes);
    }
  }
}

/** Keep acknowledgment ownership on the final bytes of the original chunk,
 * even when several exact retired echoes arrive together after SSH resumes. */
function writeAndContinue(term: EchoTerminal, echo: PendingEcho, prefix: Uint8Array, rest: Uint8Array): void {
  if (!rest.length || !pending.get(term)?.length) {
    const output = new Uint8Array(prefix.length + rest.length);
    output.set(prefix);
    output.set(rest, prefix.length);
    writeEcho(term, echo, output);
    return;
  }
  const acknowledgments = echo.acknowledgments.splice(0);
  term.write(prefix);
  writePtyOutput(term, rest, () => {
    for (const acknowledge of acknowledgments) acknowledge();
  });
}

/** Feed live PTY bytes into xterm, replacing only a proven command-line echo.
 * The input hold remains bounded to 2 seconds/64 KiB. Empty, nonce-owned probe
 * expectations may survive longer, without holding output or acknowledgments. */
export function writePtyOutput(
  term: EchoTerminal,
  bytes: Uint8Array,
  onParsed?: () => void,
): void {
  if (!bytes.length) {
    term.write(bytes, onParsed);
    return;
  }
  for (const candidate of [...(pending.get(term) ?? [])]) {
    if (candidate.expiresAt && performance.now() >= candidate.expiresAt) retireEcho(term, candidate);
  }
  const queue = pending.get(term);
  const echo = queue?.[0];
  if (!echo || !queue) {
    term.write(bytes, onParsed);
    return;
  }
  if (echo.retired) {
    echo.retired = false;
    clearTimeout(echo.timer);
    echo.timer = setTimeout(() => retireEcho(term, echo), Math.min(ECHO_WAIT_MS, Math.max(0, (echo.expiresAt ?? performance.now()) - performance.now())));
  }
  if (onParsed) echo.acknowledgments.push(onParsed);
  let held = new Uint8Array(echo.bytes.length + bytes.length);
  held.set(echo.bytes);
  held.set(bytes, echo.bytes.length);
  echo.bytes = held;

  const prefix = leadingProtocol(echo, held, queue);
  if (prefix.length) {
    echo.forwardedBytes += prefix.length;
    if (prefix.endsExpectation || prefix.endProbeNonce) {
      const through = prefix.endProbeNonce
        ? queue.findIndex((candidate) => candidate.probeNonce === prefix.endProbeNonce)
        : 0;
      for (const candidate of queue.slice(0, through + 1)) removeEcho(term, candidate);
      writeAndContinue(term, echo, prefix.bytes, held.subarray(prefix.length));
      return;
    }
    if (echo.forwardedBytes > MAX_ECHO_BYTES) {
      pending.delete(term);
      for (const candidate of queue) clearTimeout(candidate.timer);
      writeEcho(term, echo, held);
      return;
    }
    echo.bytes = held = held.subarray(prefix.length);
    if (!held.length) {
      writeEcho(term, echo, prefix.bytes);
      return;
    }
    term.write(prefix.bytes);
  }

  const newline = held.indexOf(10);
  const echoLength = newline < 0 ? held.length : newline + 1;
  if (hasNonEchoControl(held.subarray(0, newline < 0 ? held.length : newline)) || echoLength > MAX_ECHO_BYTES) {
    pending.delete(term);
    for (const candidate of queue) clearTimeout(candidate.timer);
    writeEcho(term, echo, held);
    return;
  }
  if (newline < 0) return;

  const normalized = normalizeEcho(decoder.decode(held.subarray(0, newline)));
  const index = normalized ? queue.findIndex((candidate) => candidate.line === normalized.text) : -1;
  if (!normalized || index < 0) {
    // Unknown text invalidates the queue. Preserve genuine output instead of
    // searching later lines for something resembling our protocol.
    pending.delete(term);
    for (const candidate of queue) clearTimeout(candidate.timer);
    writeEcho(term, echo, held);
    return;
  }
  const matched = queue[index];
  for (const candidate of queue.slice(0, index + 1)) removeEcho(term, candidate);
  const replacement = encoder.encode(
    (matched.visible === null
      ? "\r\x1b[2K"
      : `${normalized.clearToEnd ? "\x1b[K" : ""}${matched.visible}\r\n`) + normalized.modes,
  );
  writeAndContinue(term, echo, replacement, held.subarray(newline + 1));
}

/** Forward strings incrementally without buffering their payloads. Ordinary
 * command expectations end at shell lifecycle signals. Owned probes instead
 * retire at a matching RP nonce, so an older reply cannot disarm a newer echo
 * expectation and a disabled-echo probe cannot consume later genuine output. */
function leadingProtocol(echo: PendingEcho, bytes: Uint8Array, queue: readonly PendingEcho[]): {
  length: number; bytes: Uint8Array; endsExpectation: boolean; endProbeNonce?: string;
} {
  let i = 0;
  let endsExpectation = false;
  let endProbeNonce: string | undefined;
  while (i < bytes.length) {
    if (echo.protocol) {
      const protocol = echo.protocol;
      const byte = bytes[i++];
      if (protocol.prefix.length < 256) protocol.prefix += String.fromCharCode(byte);
      if ((protocol.kind === "osc" && byte === 7) || (protocol.escaped && byte === 92) ||
          byte === 24 || byte === 26) {
        const replyNonce = protocol.kind === "osc" ? /^6973;RP;([a-f0-9]{32});/.exec(protocol.prefix)?.[1] : undefined;
        if (replyNonce && queue.some((candidate) => candidate.probeNonce === replyNonce)) endProbeNonce = replyNonce;
        endsExpectation = !echo.probeNonce && protocol.kind === "osc" &&
          /^(?:133;[ACD](?:;|\x07|\x1b|$)|6973;)/.test(protocol.prefix);
        echo.protocol = null;
        if (endsExpectation || endProbeNonce) break;
      } else {
        protocol.escaped = byte === 27;
      }
      continue;
    }
    if (bytes[i] !== 27 || i + 1 === bytes.length) break;
    const next = bytes[i + 1];
    if (next === 93 || next === 80) {
      echo.protocol = { kind: next === 93 ? "osc" : "dcs", escaped: false, prefix: "" };
      i += 2;
      continue;
    }
    if (next !== 91) break;
    let end = i + 2;
    while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] <= 0x3f) end++;
    if (end === bytes.length) break;
    const sequence = decoder.decode(bytes.subarray(i, end + 1));
    const query = /^\x1b\[(?:\??[56]n|[>=]?\d*c|\??\d+\$p)$/.test(sequence);
    if (!query && !echoCsiKind(sequence)) break;
    i = end + 1;
  }
  return { length: i, bytes: bytes.subarray(0, i), endsExpectation, endProbeNonce };
}

function writeEcho(term: EchoTerminal, echo: PendingEcho, bytes: Uint8Array): void {
  const acknowledgments = echo.acknowledgments.splice(0);
  term.write(bytes, () => {
    for (const acknowledge of acknowledgments) acknowledge();
  });
}

function echoCsiKind(sequence: string): "mode" | "decoration" | null {
  // An alternate-screen transition is program output, never an input echo.
  if (/^\x1b\[\?(?:\d+;)*(?:47|1047|1049)(?:;\d+)*[hl]$/.test(sequence)) return null;
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
  // Bound the aggregate expansion, including the original printable text.
  // Many individually valid cursor advances must not multiply held bytes.
  let paddingBudget = Math.max(0, MAX_ECHO_BYTES - raw.length);
  let text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => {
    if (echoCsiKind(sequence) === "mode") modes += sequence;
    if (sequence.endsWith("K")) clearToEnd = true;
    // ZLE may advance over a blank with CUF instead of echoing a literal
    // space, especially when PTY reads split a redraw. Reconstruct only
    // bounded horizontal blanks, then still require exact command equality.
    if (/^\x1b\[\d*C$/.test(sequence)) {
      const count = Number(sequence.slice(2, -1)) || 1;
      if (count > paddingBudget) return "\x1b";
      paddingBudget -= count;
      return " ".repeat(count);
    }
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
