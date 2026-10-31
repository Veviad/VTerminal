import type { IDisposable, Terminal } from "@xterm/xterm";

const replying = new WeakSet<Terminal>();

/** xterm uses onData for both user input and its own protocol replies. Public
 * parser observers run synchronously before the built-in query handler. Keep
 * that distinction for this parser turn only; a keyboard/paste browser event
 * cannot interrupt it and the microtask clears the flag before the next one. */
export function isTerminalReply(term: Terminal): boolean {
  return replying.has(term);
}

export function onTerminalUserInput(term: Terminal, listener: () => void): IDisposable {
  let generation = 0;
  const observeReply = () => {
    const current = ++generation;
    replying.add(term);
    queueMicrotask(() => {
      if (generation === current) replying.delete(term);
    });
    return false; // Always let xterm process and answer the actual query.
  };
  const registrations = [
    ...[
      { final: "n" }, { prefix: "?", final: "n" },
      { final: "c" }, { prefix: ">", final: "c" }, { prefix: "=", final: "c" },
      { intermediates: "$", final: "p" }, { prefix: "?", intermediates: "$", final: "p" },
      { final: "t" },
    ].map((identifier) => term.parser.registerCsiHandler(identifier, observeReply)),
    term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, observeReply),
    ...[4, 10, 11, 12].map((identifier) => term.parser.registerOscHandler(identifier, observeReply)),
    term.onData(() => { if (!isTerminalReply(term)) listener(); }),
    term.onBinary(listener),
  ];
  return {
    dispose() {
      generation++;
      replying.delete(term);
      for (const registration of registrations) registration.dispose();
    },
  };
}
