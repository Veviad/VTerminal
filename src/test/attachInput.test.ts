import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOutgoing,
  inputsFromClipboard,
  inputsFromFileList,
  ocrAvailable,
  splitFoldedBlocks,
  transcribeImages,
} from "../lib/attachInput";
import { useAppStore } from "../stores/appStore";
import * as api from "../lib/tauri";
import type { Attachment } from "../lib/types";

vi.mock("../lib/tauri", () => ({ visionDescribe: vi.fn() }));

function image(id: string, data = "QQ=="): Attachment {
  return { id, kind: "image", name: `${id}.png`, mediaType: "image/png", bytes: 4, data };
}

function text(id: string, body: string): Attachment {
  return { id, kind: "text", name: `${id}.log`, mediaType: "text/plain", bytes: body.length, text: body };
}

describe("buildOutgoing", () => {
  it("leaves a plain prompt untouched", () => {
    const out = buildOutgoing("why did that fail", []);
    expect(out.prompt).toBe("why did that fail");
    expect(out.images).toEqual([]);
  });

  it("maps images to the wire shape and keeps them out of the prompt", () => {
    const out = buildOutgoing("what is this", [image("a", "AAAA"), image("b", "BBBB")]);
    expect(out.prompt).toBe("what is this");
    expect(out.images).toEqual([
      { media_type: "image/png", data: "AAAA" },
      { media_type: "image/png", data: "BBBB" },
    ]);
  });

  /** Text is folded into the prompt rather than sent as a part, so it costs
   *  nothing special on a model that cannot see images. */
  it("folds a text file in after the prompt, fenced and labelled", () => {
    const out = buildOutgoing("what broke", [text("run", "line one\nline two")]);
    expect(out.images).toEqual([]);
    expect(out.prompt).toBe(
      "what broke\n\nAttached file — run.log:\n```\nline one\nline two\n```",
    );
  });

  /** A log containing its own fence would otherwise end the block early, after
   *  which the rest of the file reads as the user's own words. */
  it("grows the fence past any backtick run in the content", () => {
    const body = "before\n```\ninner code\n```\nafter";
    const out = buildOutgoing("look", [text("run", body)]);
    expect(out.prompt).toContain("````\nbefore");
    expect(out.prompt.endsWith("\n````")).toBe(true);
  });

  it("handles a five-backtick run", () => {
    const out = buildOutgoing("look", [text("run", "`````")]);
    expect(out.prompt).toContain("``````\n`````\n``````");
  });

  it("mixes images and text in one turn", () => {
    const out = buildOutgoing("compare these", [image("a"), text("run", "hi"), image("b")]);
    expect(out.images).toHaveLength(2);
    expect(out.prompt).toContain("Attached file — run.log:");
  });

  /** A restored transcript has metadata but no bytes; it must not become an
   *  empty image part that a provider answers with a 400. */
  it("skips an image whose bytes are not loaded", () => {
    const { data: _drop, ...noData } = image("a");
    const out = buildOutgoing("hi", [noData as Attachment]);
    expect(out.images).toEqual([]);
  });

  it("still produces a body when only a file was attached", () => {
    const out = buildOutgoing("", [text("run", "contents")]);
    expect(out.prompt).toBe("Attached file — run.log:\n```\ncontents\n```");
  });
});

describe("input extraction", () => {
  it("reads a FileList and tolerates null", () => {
    const f = new File(["x"], "notes.txt", { type: "text/plain" });
    const list = { 0: f, length: 1, item: () => f } as unknown as FileList;
    expect(inputsFromFileList(list).map((i) => i.name)).toEqual(["notes.txt"]);
    expect(inputsFromFileList(null)).toEqual([]);
  });

  /** A pasted screenshot has an empty `name`; the chip and the model both need
   *  something to refer to. */
  it("names a nameless pasted image from its media type", () => {
    const blob = new File([], "", { type: "image/png" });
    const items = [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => blob },
    ];
    const list = { ...items, length: items.length } as unknown as DataTransferItemList;
    const out = inputsFromClipboard(list);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("pasted-1.png");
  });

  it("ignores an ordinary text paste", () => {
    const items = [{ kind: "string", getAsFile: () => null }];
    const list = { ...items, length: 1 } as unknown as DataTransferItemList;
    expect(inputsFromClipboard(list)).toEqual([]);
    expect(inputsFromClipboard(null)).toEqual([]);
  });
});

describe("ocrAvailable", () => {
  beforeEach(() => {
    useAppStore.setState({ visionModelId: null, visionLoadedModelId: null });
  });

  it("is false with no sidecar chosen", () => {
    expect(ocrAvailable()).toBe(false);
  });

  /** Selected-but-not-loaded must NOT count: the transcription would fail at send
   *  time, after the user had already pressed Send. */
  it("is false when the chosen sidecar is not loaded", () => {
    useAppStore.setState({ visionModelId: "vision/paddleocr-vl-1.6", visionLoadedModelId: null });
    expect(ocrAvailable()).toBe(false);
  });

  it("is false when a DIFFERENT sidecar is loaded", () => {
    useAppStore.setState({
      visionModelId: "vision/paddleocr-vl-1.6",
      visionLoadedModelId: "vision/qwen3-vl-4b",
    });
    expect(ocrAvailable()).toBe(false);
  });

  it("is true only when the chosen one is the loaded one", () => {
    useAppStore.setState({
      visionModelId: "vision/paddleocr-vl-1.6",
      visionLoadedModelId: "vision/paddleocr-vl-1.6",
    });
    expect(ocrAvailable()).toBe(true);
  });
});

describe("transcribeImages", () => {
  beforeEach(() => {
    useAppStore.setState({ visionCatalog: [] });
    // reset, not restore: the module mock's `vi.fn()` is one instance for the whole
    // file, so call history AND any implementation set by a previous test survive
    // otherwise — which showed up as a call count of 6 instead of 2.
    vi.resetAllMocks();
  });

  it("passes a text-only turn through untouched without calling the sidecar", async () => {
    const spy = vi.spyOn(api, "visionDescribe");
    const out = await transcribeImages("req-1", "what broke", [text("run", "hi")]);
    expect(out).toBe("what broke");
    expect(spy).not.toHaveBeenCalled();
  });

  it("folds a transcript in fenced and labelled", async () => {
    vi.spyOn(api, "visionDescribe").mockResolvedValue("ERROR: build failed");
    const out = await transcribeImages("req-1", "what broke", [image("a", "QQ==")]);
    expect(out).toContain("what broke");
    // Labelled, so the user can see the chat model never saw the picture.
    expect(out).toMatch(/\[image: a\.png — transcribed on-device by .+\]/);
    expect(out).toContain("```\nERROR: build failed\n```");
  });

  /** A transcript is attacker-controllable by construction. If it contains its own
   *  fence, a fixed three-backtick wrapper would end the block early and the rest
   *  would read as the user's own words. */
  it("grows the fence when the transcript contains backticks", async () => {
    vi.spyOn(api, "visionDescribe").mockResolvedValue("see ``` here");
    const out = await transcribeImages("req-1", "read it", [image("a", "QQ==")]);
    expect(out).toContain("````\nsee ``` here\n````");
  });

  /** Returning null is what tells the caller not to send. A prompt referencing an
   *  image the model never received is worse than no send at all. */
  it("returns null when the sidecar errors", async () => {
    vi.spyOn(api, "visionDescribe").mockRejectedValue(new Error("no model loaded"));
    expect(await transcribeImages("req-1", "read it", [image("a", "QQ==")])).toBeNull();
  });

  it("returns null on an empty transcript", async () => {
    vi.spyOn(api, "visionDescribe").mockResolvedValue("   ");
    expect(await transcribeImages("req-1", "read it", [image("a", "QQ==")])).toBeNull();
  });

  it("transcribes every image, in order", async () => {
    const spy = vi
      .spyOn(api, "visionDescribe")
      .mockResolvedValueOnce("first shot")
      .mockResolvedValueOnce("second shot");
    const out = await transcribeImages("req-1", "compare", [
      image("a", "AAAA"),
      image("b", "BBBB"),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out!.indexOf("first shot")).toBeLessThan(out!.indexOf("second shot"));
  });
});

describe("splitFoldedBlocks", () => {
  /** The contract that matters: whatever `buildOutgoing` folds in, this pulls back
   *  out unchanged. Asserted against the real folder rather than a hand-written
   *  string, so the two cannot drift. */
  it("round-trips buildOutgoing's file blocks", () => {
    const body = "line one\nline two\n  indented";
    const folded = buildOutgoing("what broke", [text("run", body)]);
    const out = splitFoldedBlocks(folded.prompt);

    expect(out.prompt).toBe("what broke");
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]).toMatchObject({ kind: "file", name: "run.log", truncated: false });
    expect(out.blocks[0].body).toBe(body);
  });

  it("round-trips a transcript block and keeps the model name", async () => {
    vi.spyOn(api, "visionDescribe").mockResolvedValue("ERROR: build failed\nat line 42");
    useAppStore.setState({
      visionCatalog: [{ id: "vision/x", label: "PaddleOCR-VL 1.6", selected: true } as never],
    });
    const folded = await transcribeImages("req-1", "what broke", [image("a", "QQ==")]);
    const out = splitFoldedBlocks(folded!);

    expect(out.prompt).toBe("what broke");
    expect(out.blocks[0]).toMatchObject({
      kind: "transcript",
      name: "a.png",
      model: "PaddleOCR-VL 1.6",
    });
    expect(out.blocks[0].body).toBe("ERROR: build failed\nat line 42");
  });

  /** `fenceFor` grows the fence past any backtick run in the body, so the parser
   *  must close on the SAME run — a fixed three would end the block early and spill
   *  the rest of the file into the prompt. */
  it("closes on the grown fence, not on the first three backticks", () => {
    const body = "before\n```\ninner code\n```\nafter";
    const folded = buildOutgoing("look", [text("run", body)]);
    const out = splitFoldedBlocks(folded.prompt);

    expect(out.prompt).toBe("look");
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].body).toBe(body);
  });

  it("splits several blocks in order", () => {
    const folded = buildOutgoing("compare", [text("a", "first"), text("b", "second")]);
    const out = splitFoldedBlocks(folded.prompt);
    expect(out.blocks.map((b) => [b.name, b.body])).toEqual([
      ["a.log", "first"],
      ["b.log", "second"],
    ]);
  });

  /** The fallback that keeps today's rendering for every ordinary message. */
  it("leaves content with no folded block completely alone", () => {
    const plain = "why did `npm run build` fail?\n\n```\nsome code\n```";
    const out = splitFoldedBlocks(plain);
    expect(out.prompt).toBe(plain);
    expect(out.blocks).toEqual([]);
  });

  /** A label with no fence after it is prose, not a block. */
  it("treats a label-shaped line with no fence as prompt text", () => {
    const content = "Attached file — notes.txt:\nbut no fence follows";
    const out = splitFoldedBlocks(content);
    expect(out.blocks).toEqual([]);
    expect(out.prompt).toBe(content);
  });

  /** Reachable: the archive head()-truncates content at 16KB while a text
   *  attachment may be 128KB, so a large log returns from a reopen with its
   *  closing fence gone. Must not swallow the prompt and must not throw. */
  it("recovers a block whose closing fence was truncated away", () => {
    const content = "what broke\n\nAttached file — run.log:\n```\nline one\nline two";
    const out = splitFoldedBlocks(content);

    expect(out.prompt).toBe("what broke");
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].truncated).toBe(true);
    expect(out.blocks[0].body).toBe("line one\nline two");
  });

  it("handles a message that is nothing but a block", () => {
    const folded = buildOutgoing("", [text("run", "contents")]);
    const out = splitFoldedBlocks(folded.prompt);
    expect(out.prompt).toBe("");
    expect(out.blocks[0].body).toBe("contents");
  });
});
