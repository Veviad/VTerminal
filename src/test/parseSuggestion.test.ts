import { describe, expect, it } from "vitest";
import { parseSuggestion } from "../hooks/useAiStream";

describe("parseSuggestion", () => {
  it("extracts command from a fenced block with language tag", () => {
    const r = parseSuggestion("```bash\nfind . -size +100M\n```\nFinds big files.");
    expect(r.command).toBe("find . -size +100M");
    expect(r.explanation).toBe("Finds big files.");
  });

  it("extracts from a plain fence", () => {
    const r = parseSuggestion("```\nls -la\n```");
    expect(r.command).toBe("ls -la");
  });

  it("handles unterminated fences (mid-stream)", () => {
    const r = parseSuggestion("```bash\ngit status");
    expect(r.command).toBe("git status");
  });

  it("returns empty command when no fence exists", () => {
    const r = parseSuggestion("I cannot help with that.");
    expect(r.command).toBe("");
  });

  it("takes only the first line of a multi-line fence", () => {
    const r = parseSuggestion("```bash\necho one\necho two\n```");
    expect(r.command).toBe("echo one");
  });
});
