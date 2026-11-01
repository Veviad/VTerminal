import { describe, expect, it } from "vitest";
import { describeRemote, detectNesting, tokenizeCommand } from "../lib/nesting";

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

  it("detects an ssh session launched through the shell command builtin", () => {
    expect(detectNesting("command ssh deploy@host")).toEqual({ kind: "ssh", target: "deploy@host" });
    expect(detectNesting("command -v ssh")).toBeNull();
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

  it.each([
    "ssh prod-01 uptime",
    "ssh -t prod-01 sudo systemctl status app",
    "ssh prod-01 'bash -lc \"uptime\"'",
    "ssh prod-01 ''",
    "ssh -N -L 8080:localhost:80 prod-01",
    "ssh -G prod-01",
    "ssh -o RemoteCommand=uptime prod-01",
    "docker exec web pgrep app",
    "docker exec web echo -it",
    "docker exec -it web sh -c 'echo hello'",
    "docker exec -it web bash script.sh",
    "docker exec -it web psql -c 'select 1'",
    "docker run -d --name web nginx",
    "docker run -it alpine",
    "docker run -it --entrypoint /bin/echo alpine",
    "docker run -it alpine echo hello",
    "docker exec -i --interactive=false -t web sh",
    "docker exec --tty=false -i web sh",
    "docker exec --unknown-option private-value -it web sh",
    "kubectl exec pod -- cat /etc/os-release",
    "kubectl exec -it pod -- sh -c 'echo hello'",
    "kubectl exec -it pod --stdin=false -- sh",
    "oc exec -it pod -- bash script.sh",
    "nix build",
    "nix profile install nixpkgs#hello",
    "nix-shell --run 'echo hello'",
    "nix-shell -c 'echo hello'",
    "nix develop --command echo hello",
    "toolbox run echo hello",
    "distrobox enter box -- echo hello",
    "distrobox enter --name dev -- uptime",
    "distrobox enter -- uptime",
    "toolbox enter -- uptime",
    "distrobox enter -n dev -- /bin/true",
    "distrobox enter --name=dev -- uptime",
    "distrobox enter --name dev uptime",
    "toolbox enter --container dev uptime",
    "vagrant ssh web -c uptime",
    "vagrant status",
    "limactl shell default uname -a",
    "colima ssh -- uname -a",
    "ssh prod-01 && echo finished",
    "ssh 'unterminated",
  ])("keeps one-off or ambiguous commands out of ambient target tracking: %s", (command) => {
    expect(detectNesting(command)).toBeNull();
  });

  it.each([
    ["ssh -tt prod-01 bash -il", "ssh", "prod-01"],
    ["ssh prod-01 'exec /bin/bash -i'", "ssh", "prod-01"],
    ["env LC_ALL=C command -p ssh prod-01", "ssh", "prod-01"],
    ["sudo -u deploy ssh prod-01", "ssh", "prod-01"],
    ["docker --context prod exec -it -u root -w /srv web bash", "docker", "web"],
    ["docker container exec --interactive --tty web sh", "docker", "web"],
    ["podman exec -it web zsh -l", "docker", "web"],
    ["nerdctl run -it --rm alpine sh", "docker", "alpine"],
    ["docker run -it --entrypoint /bin/sh alpine", "docker", "alpine"],
    ["podman attach web", "docker", "web"],
    ["kubectl exec pod -n production -c app -it -- sh", "kubectl", "pod"],
    ["kubectl --context prod exec -it pod -- bash", "kubectl", "pod"],
    ["oc exec -it pod -- sh", "kubectl", "pod"],
    ["nix develop", "nix", null],
    ["nix shell nixpkgs#hello", "nix", "nixpkgs#hello"],
    ["nix-shell --argstr token private-value", "nix", null],
    ["toolbox enter fedora", "container", "fedora"],
    ["distrobox enter --name dev", "container", "dev"],
    ["distrobox enter --name dev --", "container", "dev"],
    ["toolbox enter --container dev", "container", "dev"],
    ["vagrant ssh web", "vagrant", "web"],
    ["vagrant ssh", "vagrant", null],
    ["limactl shell default", "container", "default"],
    ["colima ssh", "container", null],
  ])("preserves persistent interactive environments: %s", (command, kind, target) => {
    expect(detectNesting(command!)).toEqual({ kind, target });
  });

  it("recognizes the saved-host login-shell trailer without treating echo data as a shell", () => {
    expect(detectNesting(`ssh -t prod-01 'cd /srv; exec "\${SHELL:-/bin/sh}" -l'`)).toEqual({ kind: "ssh", target: "prod-01" });
    expect(detectNesting(`ssh prod-01 'echo exec "\${SHELL:-/bin/sh}" -l'`)).toBeNull();
  });

  it("preserves empty arguments and escaped quotes when tokenizing command-builder input", () => {
    expect(tokenizeCommand("ssh host ''")).toEqual(["ssh", "host", ""]);
    expect(tokenizeCommand("ssh 'deploy@host' 'a'\\''b'")).toEqual(["ssh", "deploy@host", "a'b"]);
    expect(tokenizeCommand('ssh -i ~/My\\ Keys/id host')).toEqual(["ssh", "-i", "~/My Keys/id", "host"]);
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
