import type { RemoteContext } from "./types";

// Detecting "the visible tab is no longer talking to the local shell".
//
// This matters because the shell integration lives in the app's generated
// $ZDOTDIR and therefore only runs on the LOCAL shell. The moment the user runs
// `ssh host`, OSC 7/133 stop arriving, so `sessionUi.cwd` freezes at whatever
// local directory was last reported — and sending that to the model as the
// current working directory is worse than sending nothing.
//
// Detection is command-shape based: while a nesting command's block is open, we
// are inside it. That is exactly as long as the nested session lasts, because
// the local shell cannot print its next prompt until `ssh` exits.

interface ParsedOptions {
  rest: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
  disabled: Set<string>;
}

/** Parse only supported option shapes; never guess that an option value is a target. */
function options(words: string[], valueOptions: string, booleanOptions: string, mixed = false): ParsedOptions | null {
  const valued = new Map(valueOptions.split(" ").map((option) => {
    const [name, count] = option.split(":");
    return [name, Number(count ?? 1)] as const;
  }));
  const booleans = new Set(booleanOptions.split(" "));
  const result: ParsedOptions = { rest: [], flags: new Set(), values: new Map(), disabled: new Set() };
  const setFlag = (name: string, enabled: boolean) => {
    name = booleanName(name);
    if (enabled) { result.flags.add(name); result.disabled.delete(name); }
    else { result.flags.delete(name); result.disabled.add(name); }
  };
  const addValue = (name: string, value: string) => result.values.set(name, [...(result.values.get(name) ?? []), value]);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--") { result.rest.push(...words.slice(i + 1)); return result; }
    if (!word.startsWith("-") || word === "-") {
      if (!mixed) { result.rest.push(...words.slice(i)); return result; }
      result.rest.push(word);
      continue;
    }
    if (word.startsWith("--")) {
      const equal = word.indexOf("=");
      const name = word.slice(2, equal < 0 ? undefined : equal);
      const inline = equal < 0 ? undefined : word.slice(equal + 1);
      if (valued.has(name)) {
        const value = inline ?? words[++i];
        if (value === undefined) return null;
        addValue(name, value);
        for (let part = 1; part < valued.get(name)!; part++) {
          const extra = words[++i];
          if (extra === undefined) return null;
          addValue(name, extra);
        }
      } else if (booleans.has(name) && (inline === undefined || inline === "true" || inline === "false")) {
        setFlag(name, inline !== "false");
      } else return null;
    } else {
      for (let j = 1; j < word.length; j++) {
        const name = word[j];
        if (valued.has(name)) {
          const value = word.slice(j + 1) || words[++i];
          if (value === undefined) return null;
          addValue(name, value);
          break;
        }
        if (!booleans.has(name)) return null;
        setFlag(name, true);
      }
    }
  }
  return result;
}

const SSH_VALUES = "b c D E e F I i J L l m O o p Q R S W w config";
const SSH_FLAGS = "4 6 A a C f G g K k M N n q s T t V v X x Y y";
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "ash"]);
function booleanName(name: string): string {
  if (["i", "interactive", "stdin"].includes(name)) return "stdin";
  if (["t", "tty"].includes(name)) return "tty";
  if (["d", "detach"].includes(name)) return "detach";
  return name;
}
const has = (parsed: ParsedOptions, ...names: string[]) => names.some((name) => parsed.flags.has(booleanName(name)));

function shellInvocation(words: string[]): { interactive: boolean } | null {
  while (words[0] === "exec" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words = words.slice(1);
  if (words[0] === "env") {
    const parsed = options(words.slice(1), "u unset C chdir", "i ignore-environment");
    if (!parsed) return null;
    words = parsed.rest;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words = words.slice(1);
  }
  if (!SHELLS.has(words[0]?.split("/").pop() ?? "")) return null;
  const parsed = options(words.slice(1), "", "i l f d r p s interactive login noprofile norc no-config");
  if (!parsed || parsed.rest.length !== 0) return null;
  return { interactive: has(parsed, "i", "interactive") };
}

function persistentSsh(words: string[]): RemoteContext | null {
  const parsed = options(words, SSH_VALUES, SSH_FLAGS);
  if (!parsed || parsed.rest.length === 0 || has(parsed, "N", "n", "f", "G", "V", "s") || parsed.values.has("O") || parsed.values.has("Q") || parsed.values.has("W")) return null;
  const [target, ...remote] = parsed.rest;
  if (!target.trim()) return null;
  const explicit = (parsed.values.get("o") ?? []).find((value) => /^RemoteCommand[=\s]/i.test(value));
  if ((parsed.values.get("o") ?? []).some((value) => /^SessionType[=\s]+none$/i.test(value))) return null;
  const command = remote.length ? remote.join(" ") : explicit?.replace(/^RemoteCommand[=\s]+/i, "");
  if (command === undefined) return { kind: "ssh", target };
  if (!command.trim()) return null;
  // This is the exact persistent login-shell trailer produced by buildRemoteScript.
  // Requiring a command boundary excludes data such as `echo exec "$SHELL" -l`.
  const savedShell = /(?:^|;\s*)exec "\$\{SHELL:-\/bin\/sh\}" -l\s*$/.test(command);
  const parsedCommand = splitCommand(command);
  if (savedShell || (parsedCommand.complete && !parsedCommand.compound && shellInvocation(parsedCommand.words))) return { kind: "ssh", target };
  return null;
}

function persistentContainer(words: string[], kind: string): RemoteContext | null {
  const global = options(words, "H host c context config log-level", "D debug help v version");
  if (!global || has(global, "help", "v", "version")) return null;
  let rest = global.rest;
  if (rest[0] === "container") rest = rest.slice(1);
  const sub = rest[0];
  if (sub !== "exec" && sub !== "run" && sub !== "attach") return null;
  const parsed = options(rest.slice(1),
    "u user w workdir e env env-file detach-keys entrypoint name network net p publish v volume mount platform label l hostname h security-opt cap-add cap-drop device cpus memory m shm-size restart runtime pull stop-signal stop-timeout",
    "i interactive t tty d detach privileged rm init publish-all P read-only sig-proxy no-stdin help");
  if (!parsed || has(parsed, "d", "detach", "help") || !parsed.rest[0]) return null;
  const [target, ...command] = parsed.rest;
  if (sub === "attach") return !has(parsed, "no-stdin") && command.length === 0 ? { kind, target } : null;
  const entrypoints = parsed.values.get("entrypoint");
  const entrypoint = entrypoints?.[entrypoints.length - 1];
  const shell = shellInvocation(entrypoint ? [entrypoint, ...command] : command);
  const input = has(parsed, "i", "interactive");
  const terminal = has(parsed, "t", "tty");
  // An image's default entrypoint can be a short-lived command. Only a known
  // shell invocation establishes a persistent interactive container target.
  if (input && shell && (terminal || shell.interactive)) return { kind, target };
  return null;
}

function persistentKubernetes(words: string[]): RemoteContext | null {
  const values = "n namespace c container context kubeconfig cluster user server s token certificate-authority client-certificate client-key request-timeout as as-group cache-dir pod-running-timeout";
  const flags = "i stdin t tty q quiet help insecure-skip-tls-verify";
  const global = options(words, values, flags);
  if (!global || global.rest[0] !== "exec") return null;
  const rest = global.rest.slice(1);
  const separator = rest.indexOf("--");
  let parsed: ParsedOptions | null;
  let command: string[];
  if (separator >= 0) {
    parsed = options(rest.slice(0, separator), values, flags, true);
    if (!parsed || parsed.rest.length !== 1) return null;
    command = rest.slice(separator + 1);
  } else {
    parsed = options(rest, values, flags);
    if (!parsed?.rest.length) return null;
    const afterPod = options(parsed.rest.slice(1), values, flags);
    if (!afterPod) return null;
    for (const flag of afterPod.disabled) parsed.flags.delete(flag);
    for (const flag of afterPod.flags) parsed.flags.add(flag);
    command = afterPod.rest;
  }
  const shell = shellInvocation(command);
  return !has(parsed, "help") && has(parsed, "i", "stdin") && shell && (has(parsed, "t", "tty") || shell.interactive)
    ? { kind: "kubectl", target: parsed.rest[0] } : null;
}

function persistentShellTool(head: string, words: string[]): RemoteContext | null {
  if (head === "nix-shell" || head === "nix") {
    if (words.some((word) => /^(?:-c|--run|--command)(?:=|$)/.test(word))) return null;
    if (head === "nix" && words[0] !== "shell" && words[0] !== "develop") return null;
    const parsed = options(head === "nix" ? words.slice(1) : words,
      "p packages I include file f expr E arg:2 argstr:2 option:2 attr A profile store registry inputs-from override-input:2 override-flake:2",
      "pure impure keep-going offline repair refresh no-write-lock-file ignore-environment help version");
    return parsed && !has(parsed, "help", "version") ? { kind: "nix", target: parsed.rest[0] ?? null } : null;
  }
  const global = options(words, "", "help version machine-readable v");
  if (!global || has(global, "help", "version", "v")) return null;
  const [sub, ...rest] = global.rest;
  if (head === "vagrant") {
    if (sub !== "ssh") return null;
    const parsed = options(rest, "c command", "p plain help");
    if (!parsed || parsed.values.has("c") || parsed.values.has("command") || has(parsed, "help") || parsed.rest.length > 1) return null;
    return { kind: "vagrant", target: parsed.rest[0] ?? null };
  }
  if ((head === "distrobox" || head === "toolbox") && sub === "enter") {
    const commandSeparator = rest.indexOf("--");
    if (commandSeparator >= 0 && commandSeparator < rest.length - 1) return null;
    const parsed = options(rest, "n name c container d distro r release", "root no-workdir no-tty help", true);
    if (!parsed || has(parsed, "help") || parsed.rest.length > 1) return null;
    const namedTarget = parsed.values.get("name")?.[0] ?? parsed.values.get("container")?.[0]
      ?? parsed.values.get("n")?.[0] ?? parsed.values.get("c")?.[0];
    // A named container already consumes the target. Any positional tail is
    // an explicit child command, including the words following `--`.
    if (namedTarget !== undefined && parsed.rest.length > 0) return null;
    return { kind: "container", target: namedTarget ?? parsed.rest[0] ?? null };
  }
  if (((head === "lima" || head === "limactl") && sub === "shell") || (head === "colima" && sub === "ssh")) {
    const parsed = options(rest, "p profile workdir", "help");
    if (!parsed || has(parsed, "help")) return null;
    const target = head === "colima" ? parsed.values.get("profile")?.[0] ?? parsed.values.get("p")?.[0] ?? null : parsed.rest[0] ?? null;
    const command = head === "colima" ? parsed.rest : parsed.rest.slice(1);
    return command.length === 0 || shellInvocation(command) ? { kind: "container", target } : null;
  }
  return null;
}

/** Return only a persistent interactive target, rather than a one-off child command. */
export function detectNesting(command: string): RemoteContext | null {
  const parsed = splitCommand(command);
  if (!parsed.complete || parsed.compound) return null;
  let words = parsed.words;
  while (words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === "exec") { words = words.slice(1); continue; }
    if (words[0] === "command" || words[0] === "sudo") {
      const wrapper = words[0] === "command" ? options(words.slice(1), "", "p")
        : options(words.slice(1), "u user g group h host p prompt C close-from D chdir R chroot T command-timeout", "n E H S k K b");
      if (!wrapper) return null;
      words = wrapper.rest;
      continue;
    }
    if (words[0] === "env") {
      const wrapper = options(words.slice(1), "u unset C chdir", "i ignore-environment");
      if (!wrapper) return null;
      words = wrapper.rest;
      continue;
    }
    break;
  }
  const head = words[0]?.split("/").pop() ?? "";
  const rest = words.slice(1);
  if (["ssh", "mosh", "et"].includes(head)) return persistentSsh(rest);
  if (["docker", "podman", "nerdctl"].includes(head)) return persistentContainer(rest, "docker");
  if (["kubectl", "oc"].includes(head)) return persistentKubernetes(rest);
  return persistentShellTool(head, rest);
}

/** ssh/scp short options that take a separate value (`-i key`, `-p 22`). Getting
 *  this wrong makes the key file look like the hostname. */
const VALUE_FLAGS = /^-[bcDEeFIiJLlmOopQRSWw]$/;

/** First bare argument after the subcommand, ignoring flags and their values.
 *
 *  Exported so `lib/ssh.ts` can validate a saved host's extra args with the
 *  SAME parser that will later read the assembled command line — "what we
 *  accept" and "what detectNesting understands" must not drift apart. */
export function firstNonFlag(words: string[], skipWords: number): string | null {
  let skipped = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      // `--user=root` carries its own value; `--user root` and `-i key` eat the
      // next word. Bundled short flags (`-it`) never do.
      const takesValue = w.includes("=")
        ? false
        : /^--/.test(w) || VALUE_FLAGS.test(w);
      if (takesValue && i + 1 < words.length) i++;
      continue;
    }
    if (skipped < skipWords) {
      skipped++;
      continue;
    }
    return w;
  }
  return null;
}

interface SplitCommand { words: string[]; complete: boolean; compound: boolean }

/** Decode POSIX quoting without executing substitutions; retain empty arguments. */
function splitCommand(command: string): SplitCommand {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  let compound = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null; else current += char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === undefined) return { words, complete: false, compound };
      if (quote === null || '$`"\\\n'.includes(next)) {
        if (next !== "\n") current += next;
        started = true;
        i++;
        continue;
      }
      current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null; else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = ""; started = false;
      continue;
    }
    if (';&|<>()`'.includes(char) || (char === "#" && !started)) compound = true;
    current += char; started = true;
  }
  if (started) words.push(current);
  return { words, complete: quote === null, compound };
}

/** Split shell words for command builders; parsing never executes shell input. */
export function tokenizeCommand(command: string): string[] {
  return splitCommand(command).words;
}

/** Human label for the approval card / status bar, e.g. `ssh prod-01`. */
export function describeRemote(remote: RemoteContext | null): string | null {
  if (!remote) return null;
  return remote.target ? `${remote.kind} ${remote.target}` : remote.kind;
}
