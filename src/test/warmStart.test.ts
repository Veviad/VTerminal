import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshModels, warmStart } from "../lib/selectModel";
import { useAppStore } from "../stores/appStore";
import * as api from "../lib/tauri";
import type { ModelStatus } from "../lib/types";

// Boot used to fire both on-device loads side by side, with only a comment
// claiming they were sequenced. `vision_load` refuses while the chat host is
// loading, and that refusal was swallowed — so the sidecar silently skipped
// startup on every launch with a local chat model, and `imageReader()` answered
// "none" for a sidecar the user had chosen and used the run before.

vi.mock("../lib/tauri", () => ({
  modelLoad: vi.fn(),
  visionLoad: vi.fn(),
  modelsCatalog: vi.fn(() => Promise.resolve([])),
  modelStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: true })),
  visionCatalog: vi.fn(() => Promise.resolve([])),
  visionStatus: vi.fn(() => Promise.resolve({ loaded: null, state: "idle", available: true })),
}));

const idle: ModelStatus = { loaded: null, state: "idle", available: true };

/** Call order across both loaders, which is the whole point of the function. */
let calls: string[] = [];

/** A load that only settles when we say so, so "did the sidecar wait?" is
 *  observable rather than a matter of microtask luck. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = () => rej(new Error("load failed"));
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  calls = [];
  vi.mocked(api.modelLoad).mockReset();
  vi.mocked(api.visionLoad).mockReset();
  vi.mocked(api.modelLoad).mockImplementation(() => {
    calls.push("chat");
    return Promise.resolve();
  });
  vi.mocked(api.visionLoad).mockImplementation(() => {
    calls.push("vision");
    return Promise.resolve();
  });
  // Re-stated rather than reset: `refreshModels` reads straight into the store,
  // so a status mock with no implementation would throw instead of failing an
  // assertion.
  vi.mocked(api.modelStatus).mockResolvedValue({ loaded: null, state: "idle", available: true });
  vi.mocked(api.visionStatus).mockResolvedValue({ loaded: null, state: "idle", available: true });
  useAppStore.setState({
    activeModelId: "local/qwen3.5-9b",
    autoLoadModelOnStart: true,
    loadedModelId: null,
    modelLoadError: null,
    visionModelId: "vision/qwen3-vl-4b",
    visionAutoLoadOnStart: true,
    visionLoadedModelId: null,
    visionAcceleration: null,
    visionLoadError: null,
  });
});

describe("warmStart", () => {
  it("retains the vision host accelerator returned by model status", async () => {
    vi.mocked(api.visionStatus).mockResolvedValue({
      loaded: "vision/qwen3-vl-4b",
      state: "ready",
      available: true,
      acceleration: {
        backend: "cpu",
        device_name: "CPU",
        device_memory_bytes: null,
        fallback_reason: "Vulkan backend failed to load",
      },
    });

    await refreshModels();

    expect(useAppStore.getState().visionAcceleration).toEqual({
      backend: "cpu",
      device_name: "CPU",
      device_memory_bytes: null,
      fallback_reason: "Vulkan backend failed to load",
    });
  });

  it("loads the sidecar only after the chat model has finished", async () => {
    const chatLoad = deferred();
    vi.mocked(api.modelLoad).mockImplementation(() => {
      calls.push("chat");
      return chatLoad.promise;
    });

    const done = warmStart(idle);
    await Promise.resolve();
    expect(calls).toEqual(["chat"]);

    chatLoad.resolve();
    await done;
    expect(calls).toEqual(["chat", "vision"]);
  });

  /** The sidecar is independent of the chat model's fate: a chat model that is
   *  gone from disk must not take image reading down with it. */
  it("still loads the sidecar when the chat model fails", async () => {
    const chatLoad = deferred();
    vi.mocked(api.modelLoad).mockImplementation(() => {
      calls.push("chat");
      return chatLoad.promise;
    });

    const done = warmStart(idle);
    chatLoad.reject();
    await done;

    expect(calls).toEqual(["chat", "vision"]);
    expect(useAppStore.getState().modelLoadError).toContain("load failed");
  });

  it("loads the sidecar on its own when the chat model is a cloud one", async () => {
    useAppStore.setState({ activeModelId: "anthropic/claude-opus-5" });
    await warmStart(idle);
    expect(calls).toEqual(["vision"]);
  });

  it("skips the chat model that is already loading, and still takes the sidecar", async () => {
    await warmStart({ loaded: "local/qwen3.5-9b", state: "loading", available: true });
    expect(calls).toEqual(["vision"]);
  });

  it("honours both auto-load toggles", async () => {
    useAppStore.setState({ autoLoadModelOnStart: false, visionAutoLoadOnStart: false });
    await warmStart(idle);
    expect(calls).toEqual([]);
  });

  /** The residency check runs against the status `loadModel` just refreshed from
   *  the backend, not against the snapshot taken before it — one line earlier is
   *  exactly where a truthful answer comes from. */
  it("does not reload a sidecar that is already resident", async () => {
    vi.mocked(api.visionStatus).mockResolvedValue({
      loaded: "vision/qwen3-vl-4b",
      state: "ready",
      available: true,
    });
    await warmStart(idle);
    expect(calls).toEqual(["chat"]);
  });

  /** A build with no `local-llm` engine answers `available: false`. Loading
   *  either half would only banner a stub error the user cannot act on. */
  it("loads nothing when the local engine is missing", async () => {
    await warmStart({ loaded: null, state: "idle", available: false });
    expect(calls).toEqual([]);
  });
});
