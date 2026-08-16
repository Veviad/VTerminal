/**
 * Building an ssh command line from a saved host.
 *
 * Pure by design (no store, no xterm, no IPC) so it is testable in isolation —
 * the same split as ptyExecShell.ts (strings) vs ptyExec.ts (side effects).
 *
 * THE THREAT MODEL: this string is TYPED INTO A LIVE INTERACTIVE SHELL. `ssh`
 * itself is not the risk; the shell in front of it is. `sanitizeCommand` blocks
 * control characters — it does nothing about `;`, `$( )`, backticks or `&&`.
 * Containment therefore comes from POSIX single-quoting EVERY interpolated
 * field, on top of the grammar validation the Rust command layer enforces.
 *
 * ARGUMENT ORDER IS LOAD-BEARING, not style: flags → target → remote script, so
 * that `detectNesting` → `firstNonFlag` recovers the target and the tab keeps
 * its remote context, title, and cwd suppression. `nesting.test.ts` pins it.
 */

import { firstNonFlag, tokenizeCommand } from "./nesting";
import { isWindows } from "./platform";
import type { SshHostInput } from "./types";

/** The fields that shape a command line — accepts a full `SshHost` too. */
export type SshSpec = Pick<
  SshHostInput,
  | "hostname"
  | "username"
  | "port"
  | "identity_file"
  | "jump_host"
  | "extra_args"
  | "remote_dir"
  | "post_connect"
>;

/** Longest line we will ever type; mirrors sanitizeCommand's own limit. */
const MAX_COMMAND_LEN = 4096;

/** Characters that never need quoting in any POSIX shell. `~` is deliberately
 *  absent — it must stay outside quotes to expand. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Wrap for the shell unless provably unnecessary. Inside single quotes nothing
 *  expands, so the only escape needed is for the quote itself. */
export function shQuote(s: string): string {
  if (s === "") return "''";
  if (SHELL_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote a path while preserving tilde expansion: `~/'My Keys/id'` is a single
 *  word that the shell still expands, where `'~/My Keys/id'` would be handed to
 *  ssh with a literal tilde. */
export function quotePath(p: string): string {
  if (p === "~") return "~";
  if (p.startsWith("~/")) return `~/${shQuote(p.slice(2))}`;
  return shQuote(p);
}

/** `deploy@prod-01`, or just `prod-01` when no user is set. */
export function sshTarget(h: SshSpec): string {
  const user = h.username?.trim();
  const host = h.hostname.trim();
  return user ? `${user}@${host}` : host;
}

/** Human label for a palette hint or settings row: `deploy@prod-01:2222`. */
export function describeSshTarget(h: SshSpec): string {
  const port = h.port != null && h.port !== 22 ? `:${h.port}` : "";
  return `${sshTarget(h)}${port}`;
}

/**
 * The script to run on the far side, or null when a bare `ssh host` will do.
 *
 * `remote_dir` is quoted for the REMOTE shell; `post_connect` goes in verbatim
 * because operators (`&&`, `||`) are the entire point of that field. The caller
 * then applies ONE more shQuote for the LOCAL shell — which is why nothing in
 * `post_connect` can ever execute on this machine.
 *
 * The trailing `exec` is what keeps the session interactive instead of ssh
 * exiting the moment the script finishes.
 */
export function buildRemoteScript(h: SshSpec): string | null {
  const parts: string[] = [];
  const dir = h.remote_dir?.trim();
  const post = h.post_connect?.trim();
  if (dir) parts.push(`cd -- ${shQuote(dir)}`);
  if (post) parts.push(post);
  if (parts.length === 0) return null;
  parts.push(`exec "\${SHELL:-/bin/sh}" -l`);
  return parts.join("; ");
}

export function buildSshCommand(h: SshSpec): string {
  const script = buildRemoteScript(h);
  const args: string[] = ["ssh"];
  // A remote command suppresses tty allocation, which would break the prompt,
  // job control, and anything interactive the user then runs.
  if (script) args.push("-t");
  if (h.port != null) args.push("-p", String(h.port));
  if (h.identity_file?.trim()) args.push("-i", quotePath(h.identity_file.trim()));
  if (h.jump_host?.trim()) args.push("-J", shQuote(h.jump_host.trim()));
  if (h.extra_args?.trim()) {
    // Tokenized with the SAME quote-aware splitter that detectNesting uses,
    // then each token re-quoted: `-o "ProxyCommand=nc -X 5 %h %p"` survives as
    // one argument, while `; rm -rf /` becomes three literal arguments that ssh
    // rejects instead of three commands the shell runs.
    for (const token of tokenizeCommand(h.extra_args)) args.push(shQuote(token));
  }
  args.push(shQuote(sshTarget(h)));
  if (script) args.push(shQuote(script));
  return args.join(" ");
}

export interface FieldError {
  field: keyof SshHostInput | "command";
  message: string;
}

export function isWslIdentityPath(path: string): boolean {
  return (
    (path.startsWith("/") || path.startsWith("~/")) &&
    !path.includes("\\") &&
    !path.split("/").some((component) => component === "..")
  );
}

/** Frontend-side validation for inline form errors. The authoritative copy of
 *  these rules lives in `commands/ssh_hosts.rs::validate` — a row can be edited
 *  in the DB or arrive from the importer, so this layer is convenience only. */
export function validateSshHost(h: SshHostInput): FieldError[] {
  const errors: FieldError[] = [];
  const controlChars = /[\x00-\x1f\x7f]/;

  const label = h.label?.trim() ?? "";
  if (!label) errors.push({ field: "label", message: "A label is required." });
  else if (label.length > 64) errors.push({ field: "label", message: "Max 64 characters." });

  const hostname = h.hostname?.trim() ?? "";
  if (!hostname) {
    errors.push({ field: "hostname", message: "A hostname or IP address is required." });
  } else if (!isValidHostname(hostname)) {
    errors.push({ field: "hostname", message: `"${hostname}" is not a valid hostname or IP.` });
  }

  const username = h.username?.trim();
  if (username && !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/.test(username)) {
    errors.push({ field: "username", message: `"${username}" is not a valid username.` });
  }

  if (h.port != null && (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535)) {
    errors.push({ field: "port", message: "Port must be between 1 and 65535." });
  }

  const identity = h.identity_file?.trim();
  if (identity && isWindows() && !isWslIdentityPath(identity)) {
    errors.push({
      field: "identity_file",
      message: "Use a Linux path inside the default WSL distribution.",
    });
  }

  const extra = h.extra_args?.trim();
  if (extra) {
    if (/(stricthostkeychecking|userknownhostsfile|checkhostip|globalknownhostsfile)/i.test(extra)) {
      errors.push({
        field: "extra_args",
        message:
          "Host-key checking options aren't allowed — they disable the warning you get when a server's identity changes.",
      });
    } else if (firstNonFlag(tokenizeCommand(extra), 0) !== null) {
      errors.push({
        field: "extra_args",
        message: "Every option must be a flag — a bare word here is read as the hostname.",
      });
    }
  }

  for (const field of [
    "identity_file",
    "jump_host",
    "extra_args",
    "remote_dir",
    "post_connect",
    "label",
    "hostname",
    "username",
  ] as const) {
    const v = h[field];
    if (typeof v === "string" && controlChars.test(v)) {
      errors.push({ field, message: "Control characters aren't allowed." });
    }
  }

  // Catch an over-long line in the form rather than at connect time.
  if (errors.length === 0 && buildSshCommand(h).length > MAX_COMMAND_LEN) {
    errors.push({
      field: "command",
      message: `The resulting command exceeds ${MAX_COMMAND_LEN} characters.`,
    });
  }

  return errors;
}

function isValidHostname(h: string): boolean {
  if (h.length > 255) return false;
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    return inner.length > 0 && /^[0-9A-Fa-f:.]+$/.test(inner);
  }
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(h);
}
