import { describe, expect, it } from "vitest";
import { describeRemote, detectNesting } from "../lib/nesting";

describe("detectNesting", () => {
  it("detects a plain ssh session and its host", () => {
    expect(detectNesting("ssh prod-01")).toEqual({ kind: "ssh", target: "prod-01" });
  });

  it("skips flags when finding the host", () => {
    expect(detectNesting("ssh -i ~/.ssh/id_ed25519 -p 2222 deploy@prod-01")?.target).toBe(
      "deploy@prod-01",
    );
  });

  it("handles long flags that consume a value", () => {
    expect(detectNesting("ssh --config /tmp/cfg web-3")?.target).toBe("web-3");
  });

  it("sees through env assignments and sudo", () => {
    expect(detectNesting("LC_ALL=C sudo ssh bastion")).toEqual({ kind: "ssh", target: "bastion" });
  });

  it("handles absolute paths to the binary", () => {
    expect(detectNesting("/usr/bin/ssh host")?.kind).toBe("ssh");
  });

  it("keeps quoted targets whole", () => {
    expect(detectNesting('ssh "my host"')?.target).toBe("my host");
  });

  it("detects container exec sessions", () => {
    expect(detectNesting("docker exec -it web bash")).toEqual({ kind: "docker", target: "web" });
    expect(detectNesting("kubectl exec -it pod-a -- sh")).toEqual({
      kind: "kubectl",
      target: "pod-a",
    });
  });

  // The dangerous false positive: suppressing local context for a command that
  // never left the local machine.
  it("does NOT treat non-interactive subcommands as nesting", () => {
    expect(detectNesting("docker ps")).toBeNull();
    expect(detectNesting("kubectl get pods")).toBeNull();
    expect(detectNesting("docker build .")).toBeNull();
  });

  it("ignores unrelated commands", () => {
    expect(detectNesting("ls -la")).toBeNull();
    expect(detectNesting("git push")).toBeNull();
    expect(detectNesting("")).toBeNull();
    // Substring of a nesting command, but not one.
    expect(detectNesting("sshfs remote:/ /mnt")).toBeNull();
  });

  it("handles a target-less nested session", () => {
    expect(detectNesting("nix-shell")).toEqual({ kind: "nix", target: null });
  });
});

describe("describeRemote", () => {
  it("labels host and kind", () => {
    expect(describeRemote({ kind: "ssh", target: "prod-01" })).toBe("ssh prod-01");
  });
  it("falls back to the kind alone", () => {
    expect(describeRemote({ kind: "docker", target: null })).toBe("docker");
  });
  it("passes null through", () => {
    expect(describeRemote(null)).toBeNull();
  });
});
