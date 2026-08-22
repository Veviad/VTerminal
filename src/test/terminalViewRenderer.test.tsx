import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entries: new Map<string, any>(),
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../lib/termRegistry", () => ({
  getTerm: (sessionId: string) => mocks.entries.get(sessionId),
  acquireWebgl: (entry: any) => {
    mocks.acquire(entry);
    entry.webgl = {};
  },
  releaseWebgl: (entry: any) => {
    mocks.release(entry);
    entry.webgl = null;
  },
}));

vi.mock("../lib/tauri", () => ({ ptyResize: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/aiPanel", () => ({ isPanelResizing: () => false }));

import { TerminalView } from "../components/terminal/TerminalView";

function entry() {
  return {
    disposed: false,
    container: document.createElement("div"),
    fit: { fit: vi.fn() },
    term: {
      cols: 80,
      rows: 24,
      refresh: vi.fn(),
      focus: vi.fn(),
    },
    webgl: null,
  };
}

beforeEach(() => {
  mocks.entries.clear();
  mocks.acquire.mockClear();
  mocks.release.mockClear();
  mocks.entries.set("local", entry());
  mocks.entries.set("remote", entry());
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

describe("Sidecar terminal renderer ownership", () => {
  it("keeps both visible renderers across focus switches", () => {
    const view = render(
      <>
        <TerminalView sessionId="local" active rendererActive />
        <TerminalView sessionId="remote" active={false} rendererActive />
      </>,
    );

    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();

    view.rerender(
      <>
        <TerminalView sessionId="local" active={false} rendererActive />
        <TerminalView sessionId="remote" active rendererActive />
      </>,
    );

    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.entries.get("remote").term.focus).toHaveBeenCalled();

    view.unmount();
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("releases the old renderer when an ordinary tab loses renderer ownership", () => {
    const view = render(<TerminalView sessionId="local" active rendererActive />);
    view.rerender(<TerminalView sessionId="local" active={false} rendererActive={false} />);

    expect(mocks.release).toHaveBeenCalledWith(mocks.entries.get("local"));
  });
});
