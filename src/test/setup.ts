import "@testing-library/jest-dom";

// jsdom ships no ResizeObserver and no layout engine, so a component that
// observes its own box (AiPanel measures the aside to size the composer,
// TerminalView watches for pty_resize) throws on mount rather than failing an
// assertion. A no-op stub is honest here: with no layout there is nothing to
// report, and every size-dependent behaviour is unit-tested against its pure
// function instead (see autoGrow.test.ts).
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
