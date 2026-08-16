import { describe, expect, it } from "vitest";
import { replayBanner, stripReplayBanners } from "../lib/replayBanner";

/** The banner is ANSI-wrapped; compare on the visible text. */
function text(banner: string): string {
  return banner.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\r\n]/g, "");
}

const when = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago

describe("replayBanner", () => {
  it("says restored, for session restore", () => {
    expect(text(replayBanner({ kind: "restored", when }, 80))).toContain("restored 3h ago");
  });

  it("says reopened FROM, for the archive", () => {
    // The one difference between the two callers, and the reason they share a
    // function: two copies would drift, and the way that reads to a user is the
    // app claiming a reopen was a restore.
    expect(text(replayBanner({ kind: "reopened", when }, 80))).toContain("reopened from 3h ago");
  });

  it("always says the shell is new", () => {
    for (const kind of ["restored", "reopened"] as const) {
      expect(text(replayBanner({ kind, when }, 80))).toContain("new shell");
    }
  });

  it("says a remote was NOT reconnected", () => {
    const out = text(
      replayBanner({ kind: "reopened", when, remoteKind: "ssh", remoteTarget: "prod-01" }, 100),
    );
    expect(out).toContain("was ssh prod-01, not reconnected");
  });

  it("mentions a restored transcript only when there was one", () => {
    expect(text(replayBanner({ kind: "reopened", when, hadTranscript: true }, 100))).toContain(
      "AI transcript restored",
    );
    expect(text(replayBanner({ kind: "reopened", when }, 100))).not.toContain("AI transcript");
  });

  it("drops the softest clause first when space runs short", () => {
    const out = text(
      replayBanner(
        {
          kind: "reopened",
          when,
          remoteKind: "ssh",
          remoteTarget: "prod-01",
          hadTranscript: true,
        },
        76,
      ),
    );
    expect(out).toContain("not reconnected");
    expect(out).not.toContain("AI transcript restored");
  });

  it("NEVER shows a half-truncated remote clause, at any width", () => {
    // This is the invariant that matters. Slicing characters instead of dropping
    // whole clauses leaves "was ssh prod-01" — which reads as though the
    // connection is live, the exact wrong assumption this banner prevents. At a
    // width too narrow for the clause it must vanish entirely.
    for (let cols = 20; cols <= 120; cols++) {
      const out = text(
        replayBanner(
          { kind: "reopened", when, remoteKind: "ssh", remoteTarget: "prod-01" },
          cols,
        ),
      );
      if (out.includes("was ssh")) {
        expect(out, `at ${cols} cols`).toContain("not reconnected");
      }
    }
  });

  it("fills the width and never exceeds it", () => {
    for (const cols of [20, 40, 80, 120, 200]) {
      const line = text(replayBanner({ kind: "reopened", when }, cols));
      expect(line.length).toBeLessThanOrEqual(Math.max(20, cols));
    }
  });

  it("opens with a reset, because a serialized payload can end mid-SGR", () => {
    expect(replayBanner({ kind: "reopened", when }, 80).startsWith("\r\n\x1b[0m")).toBe(true);
  });

  it("degrades gracefully on an unparseable timestamp", () => {
    expect(text(replayBanner({ kind: "reopened", when: "not a date" }, 80))).toContain(
      "reopened from earlier",
    );
  });
});

describe("stripReplayBanners", () => {
  const prompt = "maholick@CFWS-0225 ~ %\r\n";

  it("removes a banner the app wrote, so it is never captured", () => {
    const captured = `${prompt}${replayBanner({ kind: "restored", when }, 80)}${prompt}`;
    const out = stripReplayBanners(captured);
    expect(out).not.toContain("restored");
    expect(out).toBe(`${prompt}\r\n${prompt}`);
  });

  it("removes EVERY stacked banner, which is the reported bug", () => {
    // Restoring a tab without typing anything used to append one separator per
    // restore, each stamped from a different moment — "2m ago" above "1h ago"
    // above "just now" — reading as though the tab came back out of order.
    let captured = prompt;
    for (const kind of ["restored", "reopened", "restored"] as const) {
      captured += replayBanner({ kind, when }, 80) + prompt;
    }
    const out = stripReplayBanners(captured);
    expect(out).not.toMatch(/restored|reopened/);
    expect(out.match(/CFWS-0225/g)).toHaveLength(4);
  });

  it("matches what the SERIALIZER emits, not the bytes we wrote", () => {
    // xterm's serializer rebuilds SGR from cell attributes, so the exact
    // `\x1b[0m\x1b[2m` prefix written by replayBanner does not come back. A
    // strip keyed on those bytes would silently stop working.
    const reserialized =
      "\x1b[0;2m\x1b[2m──────────\x1b[m\x1b[2m restored 3h ago · new shell \x1b[m\x1b[2m──────────\x1b[0m\r\n";
    expect(stripReplayBanners(reserialized)).toBe("");
  });

  it("keeps the operator's own rule-drawn output", () => {
    // A ─-ruled heading is ordinary output and losing it would be data loss, so
    // both the rule shape AND one of the two leads are required to match.
    const mine = "────── my own section ──────\r\n";
    const restarted = 'echo "restored the service"\r\n';
    const kept = `${mine}${restarted}`;
    expect(stripReplayBanners(kept)).toBe(kept);
  });

  it("leaves payloads with no banner untouched and cheap", () => {
    const plain = `${prompt}total 0\r\n`;
    expect(stripReplayBanners(plain)).toBe(plain);
  });

  it("survives a banner truncated at a narrow width", () => {
    const narrow = replayBanner({ kind: "restored", when }, 20);
    expect(stripReplayBanners(`${prompt}${narrow}`)).toBe(`${prompt}\r\n`);
  });
});
