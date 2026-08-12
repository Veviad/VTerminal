//! Classifies a proposed command on two ORTHOGONAL axes: does it only read, and
//! does it reach the network.
//!
//! Both answers are needed before the user ever sees an approval card, which is
//! the only reason this lives in Rust rather than beside `hardenCommand` in
//! `lib/ptyExecShell.ts`. It is NOT here for privilege: `src/` and `src-tauri/`
//! are one signed bundle, the webview is not a sandbox, and porting these tables
//! to TypeScript would change nothing about what they can prove. What Rust buys
//! is POSITION — `run.rs` decides whether to emit `CommandProposal` at all, and
//! a check anywhere downstream can only draw a card, take the click, and then
//! refuse.
//!
//! The two axes are genuinely independent, which is why there are two of them:
//!
//! | command          | read_only | network |
//! |------------------|-----------|---------|
//! | `git status`     | yes       | no      |
//! | `git pull`       | no        | yes     |
//! | `git ls-remote`  | yes       | yes     |
//! | `npm outdated`   | yes       | yes     |
//! | `curl -o f url`  | no        | yes     |
//! | `rm -rf build`   | no        | no      |
//!
//! **Opposite polarities, deliberately.** `read_only` is an ALLOWLIST and fails
//! closed, because it answers "may this skip the human?" — and the cost of
//! failing closed is one click. `network` is a DENYLIST and is best-effort,
//! because it answers "may this run at all?" — and failing closed there would
//! refuse every command, since no finite list enumerates the commands that do
//! *not* reach the network.
//!
//! # What this cannot do
//!
//! The network matcher is a backstop for a model that ignored its prompt, not a
//! sandbox. What actually enforces "no internet" for a capable model is the
//! withheld server-side tool in `provider/http/anthropic.rs`; this catches the
//! obvious residue in `run_command`. Specifically it does NOT see through:
//!
//! - **Two-step scripts.** Write `deploy.sh` in one step, run `./deploy.sh` in
//!   the next. Both steps need approval in `Ask`, so the hole only really opens
//!   under `Auto (all)` — where the user has accepted exactly that.
//! - **Obfuscation.** `$(echo Y3VybA== | base64 -d) url`, `C=curl; $C url`,
//!   `sh -c '…'`. All three fail closed here, but on shape, not comprehension.
//! - **Aliases and shell functions** from the user's own dotfiles: we see
//!   `fetch`, the shell expands `curl`.
//! - **Enumeration gaps.** `mvn`, `gradle`, `sbt`, `deno`, `helm`, `conda`, a
//!   `make` target that curls. A denylist is always incomplete.
//! - **An already-open `ssh`/`docker exec` session** — the text check applies on
//!   the remote host identically, but the session itself is a live connection
//!   this setting cannot retract.
//!
//! A command the USER edited in the approval card is deliberately not
//! re-classified. That is their own authorization on a gesture they just made,
//! which is the same line `CLAUDE.md` already draws for palette history and
//! saved-host connects.

/// What we could prove about a proposed command.
#[cfg_attr(not(feature = "local-llm"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandClass {
    /// Every segment is a KNOWN read-only command with no write redirect.
    /// False also means "could not tell" — see the polarity note above.
    pub read_only: bool,
    /// Some segment reaches the network, as far as we can tell from the text.
    pub network: bool,
}

/// Classify a command line. Never panics.
///
/// The two axes fail in OPPOSITE directions when the line cannot be parsed, and
/// that asymmetry is deliberate. `read_only` fails closed, because its question
/// is "may this skip the human?" and the cost of a wrong yes is a deleted file.
/// `network` falls back to a flat token sweep rather than a blanket yes, because
/// its question is "must this be refused?" — and refusing `cat <<EOF` with the
/// message "this command reaches the network" is a nonsense the user cannot act
/// on. An unreadable line still gets an approval card either way, so the sweep
/// is the honest floor rather than a hole.
pub fn classify(command: &str) -> CommandClass {
    let Some(segments) = split_segments(command).filter(|s| !s.is_empty()) else {
        return CommandClass { read_only: false, network: sweep_for_network(command) };
    };
    CommandClass {
        read_only: segments.iter().all(segment_is_read_only),
        network: segments.iter().any(segment_is_network),
    }
}

/// Whether this command must be refused outright rather than proposed.
///
/// Its own function so the branch in `run.rs` — which has no mock-provider test
/// harness — is still covered by a unit test.
pub fn blocks_network(class: &CommandClass, web_access: bool) -> bool {
    !web_access && class.network
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/// Which subcommands qualify, for tools that are only sometimes interesting.
enum Verbs {
    /// Every invocation qualifies.
    Any,
    /// Only these first-non-flag words qualify; a bare head does not.
    Only(&'static [&'static str]),
    /// These words qualify, and so does the head with no subcommand at all.
    /// `git` alone prints help; bare `yarn` INSTALLS. Getting this backwards on
    /// the network table is how a package manager slips through.
    OnlyOrBare(&'static [&'static str]),
}

struct ReadRule {
    verbs: Verbs,
    /// Flag tokens that turn an otherwise read-only command into a mutation.
    /// Compared against the whole token and against the part before `=`.
    deny_flags: &'static [&'static str],
    /// Short-option letters that disqualify even when bundled (`sed -ni`).
    deny_short: &'static str,
}

const fn reads() -> ReadRule {
    ReadRule { verbs: Verbs::Any, deny_flags: &[], deny_short: "" }
}
const fn reads_unless(deny_flags: &'static [&'static str], deny_short: &'static str) -> ReadRule {
    ReadRule { verbs: Verbs::Any, deny_flags, deny_short }
}
const fn reads_verbs(verbs: &'static [&'static str]) -> ReadRule {
    ReadRule { verbs: Verbs::Only(verbs), deny_flags: &[], deny_short: "" }
}
const fn reads_verbs_or_bare(verbs: &'static [&'static str]) -> ReadRule {
    ReadRule { verbs: Verbs::OnlyOrBare(verbs), deny_flags: &[], deny_short: "" }
}

/// Commands that read local state and change nothing.
///
/// Deliberately NOT here, each costing only a click: `awk` (has `system()` and
/// `print > "file"`), `less`/`man`/`top` (TUIs that `prompts::AGENT` already
/// bans), `env`/`command` (`env FOO=1 rm -rf x` runs), `cargo check|build`
/// (write `target/` and run build scripts, i.e. arbitrary code), `npm run|test`
/// and `npx` (execute arbitrary package scripts), and every network tool —
/// `curl -o`/`-O`/`-T`/`-d` writes and uploads, so curl is not "read-only" in
/// any useful sense even before the network axis weighs in.
///
/// `git branch|tag|config|remote|stash|worktree` are also absent on purpose:
/// each reads with no argument and writes with one (`git branch` lists,
/// `git branch -D x` deletes), and per-subcommand shape analysis is more
/// machinery than a click is worth.
static READ_ONLY: &[(&str, ReadRule)] = &[
    // Readers and pure filters.
    ("ls", reads()), ("cat", reads()), ("head", reads()), ("tail", reads()),
    ("wc", reads()), ("file", reads()), ("stat", reads()), ("du", reads()),
    ("df", reads()), ("tree", reads()), ("pwd", reads()), ("basename", reads()),
    ("dirname", reads()), ("realpath", reads()), ("readlink", reads()),
    ("grep", reads()), ("egrep", reads()), ("fgrep", reads()), ("rg", reads()),
    ("sort", reads()), ("uniq", reads()), ("cut", reads()), ("tr", reads()),
    ("nl", reads()), ("column", reads()), ("fold", reads()), ("rev", reads()),
    ("diff", reads()), ("cmp", reads()), ("cksum", reads()), ("shasum", reads()),
    ("md5", reads()), ("sha256sum", reads()), ("xxd", reads()), ("od", reads()),
    ("strings", reads()), ("echo", reads()), ("printf", reads()),
    ("true", reads()), ("false", reads()), ("test", reads()), ("seq", reads()),
    ("date", reads()), ("uptime", reads()), ("whoami", reads()), ("id", reads()),
    ("groups", reads()), ("hostname", reads()), ("uname", reads()),
    ("printenv", reads()), ("locale", reads()), ("sw_vers", reads()),
    ("arch", reads()), ("tty", reads()), ("which", reads()), ("whereis", reads()),
    ("type", reads()), ("ps", reads()), ("lsof", reads()), ("vm_stat", reads()),
    ("netstat", reads()), ("ifconfig", reads()), ("sysctl", reads_unless(&["-w"], "")),
    // Read-only only without an in-place / mutating flag.
    ("sed", reads_unless(&[], "i")),
    ("jq", reads_unless(&["--in-place"], "i")),
    ("yq", reads_unless(&["--inplace"], "i")),
    ("find", reads_unless(
        &["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"], "")),
    ("journalctl", reads_unless(
        &["--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush", "--sync"], "")),
    // Subcommand tables.
    ("git", reads_verbs_or_bare(&[
        "status", "log", "diff", "show", "blame", "shortlog", "describe",
        "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "cat-file",
        "symbolic-ref", "reflog", "whatchanged", "grep", "count-objects", "var",
    ])),
    ("docker", reads_verbs(&[
        "ps", "images", "inspect", "logs", "version", "info", "port", "history",
        "stats", "top",
    ])),
    ("podman", reads_verbs(&[
        "ps", "images", "inspect", "logs", "version", "info", "port", "history",
        "stats", "top",
    ])),
    ("kubectl", reads_verbs(&[
        "get", "describe", "logs", "explain", "version", "api-resources",
        "api-versions", "cluster-info", "top",
    ])),
    ("oc", reads_verbs(&["get", "describe", "logs", "explain", "version", "status"])),
    ("npm", reads_verbs(&["ls", "list", "ll", "la", "outdated", "why", "explain", "root", "prefix"])),
    ("pnpm", reads_verbs(&["ls", "list", "why", "outdated", "root"])),
    ("cargo", reads_verbs(&[
        "metadata", "tree", "verify-project", "locate-project", "pkgid", "read-manifest",
    ])),
    ("brew", reads_verbs(&["list", "ls", "info", "deps", "uses", "outdated", "config", "leaves"])),
    ("pip", reads_verbs(&["list", "show", "freeze", "check"])),
    ("pip3", reads_verbs(&["list", "show", "freeze", "check"])),
    ("systemctl", reads_verbs(&[
        "status", "show", "cat", "is-active", "is-enabled", "is-failed",
        "list-units", "list-unit-files", "list-timers", "list-dependencies",
        "get-default",
    ])),
    ("defaults", reads_verbs(&["read", "read-type", "domains", "find"])),
    ("apt", reads_verbs(&["list", "show", "policy"])),
    ("apt-get", reads_verbs(&["list", "show", "policy"])),
];

struct NetRule {
    verbs: Verbs,
    /// Flags that make an otherwise-local command reach out (`pacman -S`).
    trigger_flags: &'static [&'static str],
    trigger_short: &'static str,
}

const fn net() -> NetRule {
    NetRule { verbs: Verbs::Any, trigger_flags: &[], trigger_short: "" }
}
const fn net_verbs(verbs: &'static [&'static str]) -> NetRule {
    NetRule { verbs: Verbs::Only(verbs), trigger_flags: &[], trigger_short: "" }
}
const fn net_verbs_or_bare(verbs: &'static [&'static str]) -> NetRule {
    NetRule { verbs: Verbs::OnlyOrBare(verbs), trigger_flags: &[], trigger_short: "" }
}

/// Commands that reach the network.
///
/// Scoped deliberately, because over-blocking makes the setting feel broken:
/// `kubectl` and `docker ps|exec` are NOT here — they are control-plane tools
/// usually talking to a local socket, and blocking them would turn "no
/// internet" into "no containers". Only `docker pull|push|login|build` is.
/// `python`/`node`/`ruby`/`perl`/`make` are not here either despite being able
/// to open a socket: too common, too legitimate. Shell interpreters ARE here —
/// the agent has no legitimate use for `sh -c`, and `prompts::AGENT` already
/// forbids it starting a shell.
static NETWORK: &[(&str, NetRule)] = &[
    ("curl", net()), ("wget", net()), ("wget2", net()), ("http", net()),
    ("https", net()), ("httpie", net()), ("nc", net()), ("ncat", net()),
    ("netcat", net()), ("socat", net()), ("telnet", net()), ("ftp", net()),
    ("sftp", net()), ("tftp", net()), ("ssh", net()), ("scp", net()),
    ("rsync", net()), ("rclone", net()), ("aria2c", net()), ("axel", net()),
    ("lynx", net()), ("w3m", net()), ("links", net()), ("elinks", net()),
    ("yt-dlp", net()), ("youtube-dl", net()), ("ping", net()), ("ping6", net()),
    ("traceroute", net()), ("dig", net()), ("host", net()), ("nslookup", net()),
    ("whois", net()), ("gh", net()), ("glab", net()), ("aws", net()),
    ("az", net()), ("gcloud", net()), ("npx", net()), ("bunx", net()),
    // Opaque interpreters: their whole purpose is running a string we cannot see.
    ("sh", net()), ("bash", net()), ("zsh", net()), ("dash", net()),
    ("ksh", net()), ("fish", net()), ("eval", net()),
    // Subcommand-scoped: the tool is local, these verbs are not.
    ("git", net_verbs(&["fetch", "pull", "push", "clone", "ls-remote", "submodule", "archive"])),
    ("npm", net_verbs(&[
        "install", "i", "add", "ci", "update", "up", "upgrade", "publish",
        "audit", "search", "ping", "doctor", "outdated", "view", "info",
        "whoami", "login", "adduser",
    ])),
    ("pnpm", net_verbs(&["install", "i", "add", "update", "publish", "audit", "search", "outdated"])),
    ("yarn", net_verbs_or_bare(&["install", "add", "up", "upgrade", "publish", "audit", "info"])),
    ("bun", net_verbs(&["install", "i", "add", "update", "upgrade", "publish", "pm"])),
    ("pip", net_verbs(&["install", "download", "search", "index", "wheel"])),
    ("pip3", net_verbs(&["install", "download", "search", "index", "wheel"])),
    ("uv", net_verbs(&["add", "sync", "pip", "install", "tool"])),
    ("pipx", net_verbs(&["install", "upgrade", "run", "fetch"])),
    ("brew", net_verbs(&["install", "reinstall", "upgrade", "update", "search", "fetch", "tap", "bundle"])),
    ("cargo", net_verbs(&["add", "install", "update", "publish", "search", "login", "fetch"])),
    ("go", net_verbs(&["get", "install", "mod", "download"])),
    ("gem", net_verbs(&["install", "update", "fetch", "push"])),
    ("composer", net_verbs(&["install", "update", "require", "create-project"])),
    ("apt", net_verbs(&["install", "update", "upgrade", "search", "download", "full-upgrade"])),
    ("apt-get", net_verbs(&["install", "update", "upgrade", "source", "download"])),
    ("dnf", net_verbs(&["install", "update", "upgrade", "search", "download"])),
    ("yum", net_verbs(&["install", "update", "upgrade", "search"])),
    ("apk", net_verbs(&["add", "update", "upgrade", "fetch"])),
    ("zypper", net_verbs(&["install", "update", "refresh", "search"])),
    ("pacman", NetRule { verbs: Verbs::Only(&[]), trigger_flags: &[], trigger_short: "S" }),
    ("docker", net_verbs(&["pull", "push", "login", "build"])),
    ("podman", net_verbs(&["pull", "push", "login", "build"])),
    ("nix", net()), ("nix-shell", net()), ("nix-env", net()),
    ("terraform", net_verbs(&["init", "apply", "plan", "refresh"])),
    ("openssl", net_verbs(&["s_client"])),
];

/// Interpreters whose `-c`/`-e`/`-r` form runs code we cannot read. Treated as
/// networked because that is the fail-closed direction on this axis.
static INLINE_SCRIPT: &[(&str, &[&str])] = &[
    ("python", &["-c"]), ("python3", &["-c"]), ("perl", &["-e", "-E"]),
    ("ruby", &["-e"]), ("node", &["-e", "-p", "--eval"]), ("php", &["-r"]),
    ("deno", &["eval"]),
];

/// Prefixes that hide the command that actually runs.
///
/// Note `timeout`/`nice`/`stdbuf` are absent: they take a value argument, so
/// naive stripping would leave `5` as the head. A segment carrying one of these
/// is handled by the wrapper sweep instead.
static WRAPPERS: &[&str] = &[
    "sudo", "doas", "su", "pkexec", "command", "nohup", "time", "xargs", "env",
    "timeout", "nice", "stdbuf", "setsid", "script",
];

// ---------------------------------------------------------------------------
// Segment scanning
// ---------------------------------------------------------------------------

/// One command in a pipeline or list.
struct Segment {
    /// Raw text with quotes intact — tokenized to find the head.
    text: String,
    /// The same text with every QUOTED span removed, so structural checks can
    /// never trip over content. This is load-bearing: the fetch pipeline in
    /// `prompts::AGENT_WEB_CURL` contains `sed -e 's/^[^>]*>//'` and
    /// `grep -viE '^(script|style|…)'`, so a `contains('>')` or a split on `|`
    /// that ignored quotes would misread the very pipeline this app teaches.
    bare: String,
}

/// Split into pipeline/list segments, quote-aware.
///
/// `None` means "cannot read this with confidence" — unbalanced quotes, a line
/// continuation, a heredoc, job control, or a substitution we cannot see into.
/// Both axes treat `None` as their conservative answer.
fn split_segments(command: &str) -> Option<Vec<Segment>> {
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.ends_with('\\') {
        return None;
    }

    let mut segments: Vec<Segment> = Vec::new();
    let mut text = String::new();
    let mut bare = String::new();
    let mut quote: Option<char> = None;
    let mut chars = trimmed.chars().peekable();

    macro_rules! boundary {
        () => {{
            segments.push(Segment { text: std::mem::take(&mut text), bare: std::mem::take(&mut bare) });
        }};
    }

    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            text.push(ch);
            // Only double quotes honour a backslash escape.
            if ch == '\\' && q == '"' {
                if let Some(next) = chars.next() {
                    text.push(next);
                }
                continue;
            }
            if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                text.push(ch);
            }
            // An escaped character is literal: keep it out of `bare` so it can
            // never be mistaken for structure (`\|` is a pipe character).
            '\\' => {
                text.push(ch);
                if let Some(next) = chars.next() {
                    text.push(next);
                }
            }
            '`' => return None,
            '$' if chars.peek() == Some(&'(') => return None,
            '<' if chars.peek() == Some(&'(') => return None,
            '>' if chars.peek() == Some(&'(') => return None,
            '<' if chars.peek() == Some(&'<') => return None,
            '&' => {
                if chars.peek() == Some(&'&') {
                    chars.next();
                    boundary!();
                } else if bare.trim_end().ends_with('>') {
                    // `2>&1` is fd plumbing, not job control.
                    text.push(ch);
                    bare.push(ch);
                } else {
                    return None;
                }
            }
            '|' => {
                if chars.peek() == Some(&'|') {
                    chars.next();
                }
                boundary!();
            }
            ';' => boundary!(),
            _ => {
                text.push(ch);
                bare.push(ch);
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    boundary!();

    segments.retain(|s| !s.text.trim().is_empty());
    Some(segments)
}

/// A `>` that could create or truncate a file. `2>&1` is fd plumbing and
/// `>/dev/null` is a bit bucket; neither is a write.
fn writes_file(bare: &str) -> bool {
    let b: Vec<char> = bare.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] != '>' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        if j < b.len() && b[j] == '>' {
            j += 1; // `>>` append is still a write
        }
        while j < b.len() && b[j] == ' ' {
            j += 1;
        }
        if j < b.len() && b[j] == '&' {
            i = j + 1; // fd-dup
            continue;
        }
        let rest: String = b[j..].iter().collect();
        if rest.starts_with("/dev/null") {
            i = j + "/dev/null".len();
            continue;
        }
        return true;
    }
    false
}

/// Split on whitespace, honouring simple quoting. Mirrors `tokenizeCommand` in
/// `lib/nesting.ts` so the two halves of the app agree on what a word is.
fn tokenize(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in segment.trim().chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

struct Head {
    /// Basename, lowercased: `/usr/bin/GIT` → `git`.
    name: String,
    /// First non-flag word after the head, or empty.
    verb: String,
    /// Every token starting with `-`.
    flags: Vec<String>,
    /// An assignment (`FOO=1 cmd`) or a wrapper (`sudo`, `xargs`, …) preceded
    /// the command that actually runs.
    wrapped: bool,
}

fn head_of(segment: &str) -> Option<Head> {
    let words = tokenize(segment);
    let mut i = 0;
    let mut wrapped = false;
    loop {
        let word = words.get(i)?;
        let base = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
        let is_assignment = word
            .split_once('=')
            .is_some_and(|(k, _)| !k.is_empty()
                && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !k.starts_with(|c: char| c.is_ascii_digit()));
        if is_assignment || WRAPPERS.contains(&base.as_str()) {
            wrapped = true;
            i += 1;
            continue;
        }
        // `$C url` — the head is a variable we cannot resolve.
        if word.starts_with('$') {
            return None;
        }
        let rest = &words[i + 1..];
        return Some(Head {
            name: base,
            verb: rest.iter().find(|w| !w.starts_with('-')).cloned().unwrap_or_default(),
            flags: rest.iter().filter(|w| w.starts_with('-')).cloned().collect(),
            wrapped,
        });
    }
}

/// Whether a flag token matches one of `names`, allowing `--flag=value`.
fn has_flag(flags: &[String], names: &[&str]) -> bool {
    flags.iter().any(|f| {
        let bare = f.split_once('=').map_or(f.as_str(), |(k, _)| k);
        names.contains(&bare)
    })
}

/// Whether any short-option cluster carries one of `letters`. Only clusters
/// (`-ni`), never long flags — `--delete` must not match on `d`.
fn has_short(flags: &[String], letters: &str) -> bool {
    if letters.is_empty() {
        return false;
    }
    flags.iter().any(|f| {
        if f.starts_with("--") || !f.starts_with('-') {
            return false;
        }
        f[1..].chars().any(|c| letters.contains(c))
    })
}

fn verbs_match(verbs: &Verbs, verb: &str) -> bool {
    match verbs {
        Verbs::Any => true,
        Verbs::Only(list) => !verb.is_empty() && list.contains(&verb),
        Verbs::OnlyOrBare(list) => verb.is_empty() || list.contains(&verb),
    }
}

fn segment_is_read_only(seg: &Segment) -> bool {
    if writes_file(&seg.bare) {
        return false;
    }
    let Some(head) = head_of(&seg.text) else {
        return false;
    };
    // An assignment prefix can be `LD_PRELOAD=evil.so ls`, and a wrapper can be
    // `sudo`. Neither is worth modelling for a click.
    if head.wrapped {
        return false;
    }
    let Some((_, rule)) = READ_ONLY.iter().find(|(name, _)| *name == head.name) else {
        return false;
    };
    if has_flag(&head.flags, rule.deny_flags) || has_short(&head.flags, rule.deny_short) {
        return false;
    }
    verbs_match(&rule.verbs, &head.verb)
}

/// A URL literal. Checked against the raw text, never the unquoted projection:
/// the fetch pipeline `prompts::AGENT_WEB_CURL` teaches single-quotes its URL.
fn mentions_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["http://", "https://", "ftp://", "ftps://", "git://", "ssh://", "rsync://", "ws://", "wss://"]
        .iter()
        .any(|scheme| lower.contains(scheme))
}

/// Positional-blind fallback: does any WORD name a tool that is networked in
/// every invocation? Used where position cannot be trusted — an unparseable
/// line, or a segment behind a wrapper whose flags we do not model.
///
/// Over-matching here costs a refusal the user undoes with one setting;
/// under-matching silently defeats the setting. Only `Verbs::Any` entries
/// participate, so `git`/`npm`/`brew` — networked for some verbs and not others
/// — never match out of position and `grep npm README` stays local.
fn sweep_for_network(text: &str) -> bool {
    if mentions_url(text) {
        return true;
    }
    tokenize(text).iter().any(|w| {
        // Trim shell punctuation before matching. The sweep only runs on lines
        // the parser already gave up on, so a word arrives welded to whatever
        // was around it: in ``echo `curl x` `` the token is `` `curl ``, and an
        // untrimmed basename compare misses it entirely.
        let word = w.trim_matches(|c: char| "`$(){};|&<>'\"".contains(c));
        let base = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
        NETWORK
            .iter()
            .any(|(name, rule)| *name == base && matches!(rule.verbs, Verbs::Any))
    })
}

fn segment_is_network(seg: &Segment) -> bool {
    if mentions_url(&seg.text) {
        return true;
    }
    let Some(head) = head_of(&seg.text) else {
        return sweep_for_network(&seg.text);
    };
    if let Some((_, flags)) = INLINE_SCRIPT.iter().find(|(name, _)| *name == head.name) {
        if has_flag(&head.flags, flags) || flags.contains(&head.verb.as_str()) {
            return true;
        }
    }
    // A wrapped segment hides the real head behind flags we do not model
    // (`sudo -u root curl x` resolves to `root`), so position is untrustworthy.
    // Check the resolved head first, then fall back to the sweep.
    let by_head = NETWORK.iter().find(|(name, _)| *name == head.name);
    if head.wrapped && by_head.is_none() {
        return sweep_for_network(&seg.text);
    }
    let Some((_, rule)) = by_head else {
        return false;
    };
    if has_flag(&head.flags, rule.trigger_flags) || has_short(&head.flags, rule.trigger_short) {
        return true;
    }
    verbs_match(&rule.verbs, &head.verb)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_only(cmd: &str) -> bool {
        classify(cmd).read_only
    }
    fn network(cmd: &str) -> bool {
        classify(cmd).network
    }

    #[test]
    fn recognises_read_only_commands() {
        for cmd in [
            "ls -la",
            "cat src/main.rs",
            "pwd",
            "git status",
            "git log --oneline | head -20",
            "git",
            "rg TODO src",
            "grep -rn foo .",
            "docker ps",
            "kubectl get pods -n prod",
            "npm ls --depth=0",
            "find . -name '*.ts'",
            "systemctl status nginx --no-pager",
            "sed -n '1,10p' f",
            "wc -l < input.txt",
            "cat a 2>&1",
            "ls > /dev/null",
            "df -h; du -sh .",
            "stat f && file f",
        ] {
            assert!(read_only(cmd), "should be read-only: {cmd}");
        }
    }

    #[test]
    fn fails_closed_on_anything_that_could_write() {
        for cmd in [
            "rm -rf build",
            "git commit -m x",
            // Reads with no argument, deletes with one — off the table entirely.
            "git branch feature",
            "git config user.name x",
            "docker rm c",
            "kubectl delete pod p",
            "npm install",
            "npm test",
            "npx foo",
            "cargo check",
            "yarn",
            "ls > out.txt",
            "ls >> out.txt",
            "echo hi > f",
            "sudo ls",
            "ls | tee f",
            "ls | xargs rm",
            "find . -delete",
            "find . -exec rm {} ;",
            "sed -i s/a/b/ f",
            "sed -ni s/a/b/ f",
            "jq --in-place . f",
            "sysctl -w x=1",
            "journalctl --vacuum-time=1d",
            "defaults write com.x y",
            "mkdir newdir",
            "touch f",
            // Opaque: shape recognition, not comprehension.
            "echo $(whoami)",
            "echo `id`",
            "sh -c ls",
            "FOO=1 ls",
            "ls &",
            "cat <<EOF",
            "ls | sh",
        ] {
            assert!(!read_only(cmd), "must not be read-only: {cmd}");
        }
    }

    #[test]
    fn recognises_network_commands() {
        for cmd in [
            "curl https://example.com",
            "wget -qO- http://x",
            "git pull",
            "git clone git@github.com:a/b",
            "npm install",
            "pip3 install requests",
            "brew update",
            "cargo add serde",
            "apt-get install -y jq",
            "ssh prod-01",
            "scp a b:/tmp",
            "docker pull alpine",
            "gh pr list",
            "sh -c 'curl x'",
            "python -c 'import urllib'",
            "pacman -Syu",
            "sudo apt-get install jq",
            "nohup curl example.com",
            "xargs curl",
            "yarn",
            "open 'https://example.com'",
        ] {
            assert!(network(cmd), "should be networked: {cmd}");
        }
    }

    #[test]
    fn leaves_local_commands_alone() {
        for cmd in [
            "ls -la",
            "git status",
            "git log -5",
            "npm ls",
            "cargo tree",
            "kubectl get pods",
            "docker ps",
            "rm -rf build",
            "cat /etc/hosts",
            "brew list",
        ] {
            assert!(!network(cmd), "should be local: {cmd}");
        }
    }

    /// The two axes are independent, and these four cases are the proof. If a
    /// future refactor collapses them into one boolean, this fails.
    #[test]
    fn the_axes_are_orthogonal() {
        assert_eq!(classify("git status"), CommandClass { read_only: true, network: false });
        assert_eq!(classify("git pull"), CommandClass { read_only: false, network: true });
        assert_eq!(classify("git ls-remote"), CommandClass { read_only: true, network: true });
        assert_eq!(classify("rm -rf build"), CommandClass { read_only: false, network: false });
    }

    /// The pipeline `AGENT_WEB_CURL` teaches verbatim. It single-quotes a `>`
    /// inside `sed -e 's/^[^>]*>//'` and a `|` inside `grep -viE '…'`, so a
    /// quote-blind scanner would call the app's own documented fetch a file
    /// write. Sourced from the prompt so the two cannot drift apart.
    #[test]
    fn the_documented_fetch_pipeline_is_read_only_and_networked() {
        let pipeline = "curl -fsSL --max-time 20 'https://x.test/p' | tr '<' '\\n' \
| grep -viE '^(script|style|/script|/style|!--|link|meta|path|svg)' \
| sed -e 's/^[^>]*>//' | tr -s '[:space:]' ' ' | head -c 3000";
        assert!(!writes_file(&split_segments(pipeline).unwrap()[3].bare),
            "a quoted `>` is not a redirect");
        assert!(network(pipeline), "the pipeline fetches");

        // The same pipeline with curl swapped out is pure local filtering, which
        // is what proves the quote handling rather than the curl entry.
        let filters = pipeline.replace("curl -fsSL --max-time 20 'https://x.test/p'", "cat page.html");
        assert!(read_only(&filters), "quoted metacharacters must not read as structure");
        assert!(!network(&filters), "no fetch left");

        // And the prompt still contains the stage this fixture is built from.
        assert!(
            super::super::prompts::AGENT_WEB_CURL.contains(r#"| sed -e 's/^[^>]*>//'"#),
            "fixture drifted from the prompt it mirrors"
        );
    }

    /// A fail-closed allowlist is only worth having if it actually clears the
    /// common case. This is a realistic read-only investigation session: if the
    /// table is so conservative that `Auto (read-only)` still asks about most of
    /// it, the mode is pointless and this test is where that shows up.
    #[test]
    fn a_realistic_investigation_session_mostly_auto_runs() {
        let session = [
            "ls -la",
            "pwd",
            "cat package.json",
            "git status",
            "git log --oneline -20",
            "git diff HEAD~1",
            "rg -n 'autoAccept' src",
            "grep -rn TODO src | head -40",
            "find . -name '*.test.ts' -not -path './node_modules/*'",
            "wc -l src/lib/*.ts",
            "cat src/main.rs | head -60",
            "ls -la target/debug 2>/dev/null",
            "du -sh node_modules",
            "npm ls --depth=0",
            "cargo tree | head -30",
            "date",
            "uname -a",
            "ps aux | grep node | head",
            "stat Cargo.toml",
            "git show --stat HEAD",
        ];
        let cleared: Vec<&str> = session.iter().copied().filter(|c| read_only(c)).collect();
        assert_eq!(
            cleared.len(),
            session.len(),
            "these should all auto-run under Auto (read-only); missing: {:?}",
            session.iter().filter(|c| !read_only(c)).collect::<Vec<_>>()
        );
        // And none of them may be mistaken for a network command, or internet-off
        // would refuse a purely local investigation.
        for cmd in session {
            assert!(!network(cmd), "purely local, must not read as networked: {cmd}");
        }
    }

    /// Unreadable input can never skip the human, whatever else is true of it.
    #[test]
    fn unreadable_input_is_never_read_only() {
        for cmd in [
            "", "   ", "'unbalanced", "ls \\", "$C url", "a & b", "cat <<EOF",
            "diff <(ls) <(ls)", "echo `id`", "(ls)",
        ] {
            assert!(!classify(cmd).read_only, "must not be read-only: {cmd:?}");
        }
        // Pathological length and depth must not panic.
        let _ = classify(&"ls ".repeat(2000));
        let _ = classify(&"(".repeat(200));
    }

    /// …but it is NOT blanket-refused as networked. A heredoc turned away with
    /// "this command reaches the network" is a message the user cannot act on,
    /// so an unparseable line falls back to a token sweep instead.
    #[test]
    fn an_unparseable_line_is_swept_rather_than_blanket_refused() {
        for local in ["cat <<EOF", "a & b", "ls \\", "'unbalanced", "", "(ls)"] {
            assert!(!classify(local).network, "should not read as networked: {local:?}");
        }
        // The sweep still catches what matters: a hidden tool or a URL.
        for reaching in ["$C https://x", "sh -c 'curl x' &", "echo `curl x`"] {
            assert!(classify(reaching).network, "sweep should catch: {reaching:?}");
        }
    }

    /// A tool that is networked in EVERY invocation must never also be
    /// allowlisted as read-only, or it could auto-run under `Auto (read-only)`
    /// on the strength of the read axis alone. Tools that are networked only for
    /// some verbs (`git`, `npm`, `brew`) legitimately appear in both tables with
    /// disjoint verb sets — `git status` vs `git pull` — and are exempt.
    #[test]
    fn no_always_networked_tool_is_on_the_read_allowlist() {
        for (name, rule) in NETWORK {
            if !matches!(rule.verbs, Verbs::Any) {
                continue;
            }
            assert!(
                !READ_ONLY.iter().any(|(r, _)| r == name),
                "`{name}` is always networked and must not be read-only allowlisted"
            );
        }
    }

    #[test]
    fn every_segment_must_pass_for_the_line_to_be_read_only() {
        assert!(read_only("git log | head -20"));
        assert!(!read_only("git log | tee log.txt"));
        assert!(!read_only("ls; rm x"));
        assert!(!read_only("ls && git commit -m x"));
    }

    #[test]
    fn blocks_only_when_web_is_off_and_the_command_reaches_out() {
        let fetch = classify("curl https://x");
        let local = classify("ls -la");
        assert!(blocks_network(&fetch, false));
        assert!(!blocks_network(&fetch, true));
        assert!(!blocks_network(&local, false));
        assert!(!blocks_network(&local, true));
    }
}
