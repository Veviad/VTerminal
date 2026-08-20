import { describe, expect, it } from "vitest";
import {
  collapseHome,
  cwdLabel,
  nextOrdinal,
  resolveSessionTitle,
  shortenCommand,
} from "../lib/sessionTitle";
import { emptySessionUi, type SessionUiState } from "../stores/appStore";
import type { Session } from "../lib/types";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    shell: "/bin/zsh",
    cwd: null,
    createdAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    hostId: null,
    hostLabel: null,
    userTitle: null,
    aiTitle: null,
    ordinal: 1,
    ...over,
  };
}

function ui(over: Partial<SessionUiState> = {}): SessionUiState {
  return { ...emptySessionUi(), ...over };
}

describe("collapseHome", () => {
  it("collapses the home directory itself to ~", () => {
    expect(collapseHome("/Users/maholick")).toBe("~");
  });

  it("collapses a path under home", () => {
    expect(collapseHome("/Users/maholick/Documents/x")).toBe("~/Documents/x");
  });

  it("leaves paths outside home alone", () => {
    expect(collapseHome("/var/log")).toBe("/var/log");
    expect(collapseHome("/")).toBe("/");
  });
});

describe("cwdLabel", () => {
  it("names the home directory ~ rather than after the user", () => {
    // The reported bug: basename("/Users/maholick") is the username.
    expect(cwdLabel("/Users/maholick")).toBe("~");
  });

  it("uses the leaf directory elsewhere", () => {
    expect(cwdLabel("/Users/maholick/Documents/Code Projects/veviad_shell")).toBe("veviad_shell");
    expect(cwdLabel("/var/log")).toBe("log");
  });

  it("survives a trailing slash and the filesystem root", () => {
    expect(cwdLabel("/var/log/")).toBe("log");
    expect(cwdLabel("/")).toBe("/");
  });

  it("has nothing to say without a cwd", () => {
    expect(cwdLabel(null)).toBeNull();
  });
});

describe("shortenCommand", () => {
  it("keeps a runner's subcommand", () => {
    expect(shortenCommand("npm run dev")).toBe("npm run");
    expect(shortenCommand("cargo build --release")).toBe("cargo build");
    expect(shortenCommand("git rebase -i main")).toBe("git rebase");
  });

  it("drops sudo and env assignments, which say nothing about what is running", () => {
    expect(shortenCommand("sudo npm run dev")).toBe("npm run");
    expect(shortenCommand("FOO=1 BAR=2 npm test")).toBe("npm test");
    expect(shortenCommand("sudo FOO=1 tail -f x.log")).toBe("tail");
  });

  it("reduces a path invocation to its basename", () => {
    expect(shortenCommand("./scripts/server")).toBe("server");
    expect(shortenCommand("/usr/local/bin/vim notes.md")).toBe("vim");
  });

  it("does not treat a flag as a subcommand", () => {
    expect(shortenCommand("npm --version")).toBe("npm");
  });

  it("keeps a non-runner to one word", () => {
    expect(shortenCommand("vim src/main.rs")).toBe("vim");
  });

  it("clamps a long label", () => {
    const out = shortenCommand("docker compose-with-a-very-long-subcommand-name");
    expect(out!.length).toBeLessThanOrEqual(20);
  });

  it("has nothing to say about an empty command", () => {
    expect(shortenCommand("   ")).toBeNull();
  });
});

describe("resolveSessionTitle", () => {
  it("falls back to ~ in the home directory instead of the username", () => {
    expect(resolveSessionTitle(session(), ui({ cwd: "/Users/maholick" }))).toBe("~");
  });

  it("uses the numbered placeholder when there is no cwd at all", () => {
    // The shell-integration-disabled case: no OSC 7, so no cwd ever arrives.
    expect(resolveSessionTitle(session({ ordinal: 3 }), ui())).toBe("Shell 3");
  });

  it("prefers the running command over the directory", () => {
    const title = resolveSessionTitle(
      session(),
      ui({ cwd: "/Users/maholick/proj", longRunningCommand: "npm run" }),
    );
    expect(title).toBe("npm run");
  });

  it("prefers a live remote over the running command", () => {
    const title = resolveSessionTitle(
      session(),
      ui({
        cwd: "/Users/maholick/proj",
        longRunningCommand: "ssh",
        remote: { kind: "ssh", target: "prod-01" },
      }),
    );
    expect(title).toBe("ssh prod-01");
  });

  it("prefers a saved host's label over the bare remote description", () => {
    const title = resolveSessionTitle(
      session(),
      ui({
        remote: { kind: "ssh", target: "1.2.3.4" },
        remoteHost: { id: "h1", label: "prod-01", color: null },
      }),
    );
    expect(title).toBe("prod-01");
  });

  it("lets an explicit rename beat even a live remote", () => {
    const title = resolveSessionTitle(
      session({ userTitle: "mine" }),
      ui({ remoteHost: { id: "h1", label: "prod-01", color: null } }),
    );
    expect(title).toBe("mine");
  });

  it("ranks the model's name below the host identity but above the directory", () => {
    expect(
      resolveSessionTitle(session({ aiTitle: "log triage", hostLabel: "prod-01" }), ui()),
    ).toBe("prod-01");
    expect(
      resolveSessionTitle(session({ aiTitle: "log triage" }), ui({ cwd: "/var/log" })),
    ).toBe("log triage");
  });

  it("reads the cwd off the session when no UI state exists yet", () => {
    expect(resolveSessionTitle(session({ cwd: "/var/log" }), undefined)).toBe("log");
  });
});

describe("nextOrdinal", () => {
  it("starts at 1", () => {
    expect(nextOrdinal([])).toBe(1);
  });

  it("fills the gap left by a closed tab rather than renumbering", () => {
    expect(nextOrdinal([session({ ordinal: 1 }), session({ ordinal: 3 })])).toBe(2);
  });

  it("appends when there is no gap", () => {
    expect(nextOrdinal([session({ ordinal: 1 }), session({ ordinal: 2 })])).toBe(3);
  });
});
