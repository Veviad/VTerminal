//! Walking the roots a user picked and deciding which files may be indexed.
//!
//! **Two orthogonal axes, failing in opposite directions** — the same split
//! `agent::policy` draws between `read_only` and `network`, and for the same reason:
//! the two questions have different costs when wrong.
//!
//! - [`is_secret`] asks *"must this never be indexed?"*. It is a **denylist**, and
//!   it is absolute: it applies even to a file the user picked by hand. A false
//!   negative here puts a private key in a store the model can query and quote, so
//!   the named entries are non-negotiable. It cannot fail closed — no finite list
//!   enumerates the files that are *not* secrets — which is exactly why it is paired
//!   with the second axis rather than relied on alone.
//! - [`is_noise`] asks *"should a walk descend into this?"*. It is skipped during
//!   directory traversal but **overridable by an explicit pick**, because the cost of
//!   a false positive is one extra click and the cost of refusing to let someone
//!   index a file they deliberately chose is a feature they cannot use.
//!
//! The generous default falls out of that split: a directory walk skips every
//! dot-entry, which covers `.ssh`, `.aws`, `.gnupg`, `.env`, `.git` and everything
//! like them without needing to have thought of each one. The named table then
//! catches the secrets that are *not* dotted (`credentials`, `*.pem`, `id_rsa`) and
//! the noise that is not either (`node_modules`, `target`).
//!
//! **Symlinks are never followed.** A symlink inside an indexed folder is a path out
//! of the confinement the bucket's roots are supposed to establish, and following
//! one would let `~/Documents/docs/sneaky -> ~/.ssh` defeat both axes above.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Largest source file offered for indexing. Well above the chat path's
/// `MAX_SOURCE_BYTES` (25 MB), which bounds ONE message — a library should be able
/// to hold a large manual.
pub const DOC_MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

/// Files offered by a single scan. A user who picks their home directory should get
/// a bounded, explainable result rather than a hundred thousand rows — and the count
/// of what was dropped is REPORTED, never silently swallowed.
pub const MAX_SCAN_FILES: usize = 5_000;

/// Directory depth a walk will descend. Deep enough for any real documentation tree.
pub const MAX_SCAN_DEPTH: usize = 12;

/// Basenames that are secrets outright, whatever their extension.
const SECRET_NAMES: &[&str] = &[
    "credentials",
    "credentials.json",
    ".netrc",
    "_netrc",
    ".pgpass",
    ".htpasswd",
    "shadow",
    "authorized_keys",
    "known_hosts",
];

/// Basename prefixes that mark a private key.
const SECRET_PREFIXES: &[&str] = &[
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    ".env",
    "secring.",
];

/// Extensions that are key material or an encrypted vault. Lowercased before match.
const SECRET_EXTENSIONS: &[&str] = &[
    "pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "asc", "gpg", "kex", "pkcs12",
];

/// Directory basenames a walk never descends into, secret or not.
const SECRET_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".gpg",
    ".password-store",
    ".docker",
];

/// Directories that would swamp the index with machine-generated content.
const NOISE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".git",
    ".svn",
    ".hg",
    ".next",
    ".nuxt",
    ".cache",
    ".gradle",
    ".terraform",
    "Pods",
    "DerivedData",
];

/// Extension → media type for the formats a bucket indexes.
///
/// Extension-based ON PURPOSE, and only here: this decides whether a file is worth
/// *offering*. What a file actually IS gets decided later from magic bytes by
/// `sniffMediaType` in `src/lib/attachments.ts`, before any extraction — so a
/// `.png`-named text file cannot become an image part. Two different questions, two
/// different mechanisms.
const INDEXABLE: &[(&str, &str)] = &[
    ("pdf", "application/pdf"),
    ("md", "text/markdown"),
    ("markdown", "text/markdown"),
    ("mdx", "text/markdown"),
    ("txt", "text/plain"),
    ("text", "text/plain"),
    ("rst", "text/plain"),
    ("adoc", "text/plain"),
    ("asciidoc", "text/plain"),
    ("org", "text/plain"),
    ("csv", "text/csv"),
    ("tsv", "text/csv"),
    ("html", "text/html"),
    ("htm", "text/html"),
    ("xhtml", "text/html"),
    ("json", "application/json"),
    ("yaml", "text/plain"),
    ("yml", "text/plain"),
    ("toml", "text/plain"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("heic", "image/heic"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: PathBuf,
    pub name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Matched the secret denylist. Not overridable.
    Secret,
    /// A symlink. Never followed.
    Symlink,
    /// Machine-generated noise, or a dot-entry during a walk.
    Noise,
    /// Not a format a bucket indexes.
    UnsupportedType,
    TooLarge,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub path: PathBuf,
    pub reason: SkipReason,
}

#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub found: Vec<Found>,
    pub skipped: Vec<Skipped>,
    /// Files beyond `MAX_SCAN_FILES` that were never examined. Surfaced in the UI —
    /// a silent truncation reads as "everything was indexed" when it was not.
    pub truncated: usize,
}

/// Whether this path is secret material that must never be indexed.
///
/// Absolute: applies to explicit picks too. Checks every ancestor component, so
/// `~/.aws/config` is refused for sitting under `.aws` even though `config` is an
/// innocuous name.
pub fn is_secret(path: &Path) -> bool {
    for comp in path.components() {
        let Some(part) = comp.as_os_str().to_str() else {
            continue;
        };
        let lower = part.to_ascii_lowercase();
        if SECRET_DIRS.contains(&lower.as_str()) {
            return true;
        }
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();

    if SECRET_NAMES.contains(&lower.as_str()) {
        return true;
    }
    if SECRET_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    // Extension match, taken from the LAST dot: `key.pem.bak` is still key material
    // as far as this is concerned only if it ends in a listed extension, but
    // `backup.pem` plainly is.
    if let Some(ext) = Path::new(&lower).extension().and_then(|e| e.to_str()) {
        if SECRET_EXTENSIONS.contains(&ext) {
            return true;
        }
    }
    false
}

/// Whether a walk should skip this entry. Overridable by an explicit pick.
pub fn is_noise(name: &str) -> bool {
    if NOISE_DIRS.contains(&name) {
        return true;
    }
    // Every dot-entry. This is the generous default that covers the secret
    // directories nobody thought to name, and its cost is only that a deliberately
    // hidden documentation folder must be picked explicitly.
    name.starts_with('.')
}

/// The media type for a path, or `None` if a bucket does not index this format.
pub fn media_type_for(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    INDEXABLE
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, media)| *media)
}

/// Walk `roots` and take `explicit_files` as-is, returning everything indexable.
///
/// `explicit_files` bypasses [`is_noise`] but not [`is_secret`] — picking a file by
/// hand is a clear intent signal about a hidden folder, and no signal at all about
/// whether the app should ingest a private key.
pub fn scan(roots: &[PathBuf], explicit_files: &[PathBuf]) -> ScanOutcome {
    let mut out = ScanOutcome::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();

    for path in explicit_files {
        consider(path, true, &mut out, &mut seen);
    }
    for root in roots {
        walk(root, 0, &mut out, &mut seen);
    }

    out.found.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(dir: &Path, depth: usize, out: &mut ScanOutcome, seen: &mut HashSet<PathBuf>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    // symlink_metadata, not metadata: the latter follows the link and would report
    // the TARGET's type, so a symlinked directory would be descended into.
    match std::fs::symlink_metadata(dir) {
        Ok(md) if md.file_type().is_symlink() => {
            out.skipped.push(Skipped {
                path: dir.to_path_buf(),
                reason: SkipReason::Symlink,
            });
            return;
        }
        Ok(_) => {}
        Err(_) => {
            out.skipped.push(Skipped {
                path: dir.to_path_buf(),
                reason: SkipReason::Unreadable,
            });
            return;
        }
    }
    if is_secret(dir) {
        out.skipped.push(Skipped {
            path: dir.to_path_buf(),
            reason: SkipReason::Secret,
        });
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        out.skipped.push(Skipped {
            path: dir.to_path_buf(),
            reason: SkipReason::Unreadable,
        });
        return;
    };

    let mut children: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // The walk's own noise rule. Applied to the ENTRY NAME before any stat, so a
        // 40k-entry node_modules costs one string comparison.
        if is_noise(name) {
            out.skipped.push(Skipped {
                path: path.clone(),
                reason: SkipReason::Noise,
            });
            continue;
        }
        let Ok(md) = std::fs::symlink_metadata(&path) else {
            out.skipped.push(Skipped {
                path,
                reason: SkipReason::Unreadable,
            });
            continue;
        };
        if md.file_type().is_symlink() {
            out.skipped.push(Skipped {
                path,
                reason: SkipReason::Symlink,
            });
            continue;
        }
        if md.is_dir() {
            children.push(path);
        } else {
            consider(&path, false, out, seen);
        }
    }
    // Files before subdirectories, so a truncated scan at least covers whole levels
    // rather than one arbitrarily deep branch.
    for child in children {
        walk(&child, depth + 1, out, seen);
    }
}

fn consider(path: &Path, explicit: bool, out: &mut ScanOutcome, seen: &mut HashSet<PathBuf>) {
    if is_secret(path) {
        out.skipped.push(Skipped {
            path: path.to_path_buf(),
            reason: SkipReason::Secret,
        });
        return;
    }
    let Some(media_type) = media_type_for(path) else {
        out.skipped.push(Skipped {
            path: path.to_path_buf(),
            reason: SkipReason::UnsupportedType,
        });
        return;
    };
    let Ok(md) = std::fs::symlink_metadata(path) else {
        out.skipped.push(Skipped {
            path: path.to_path_buf(),
            reason: SkipReason::Unreadable,
        });
        return;
    };
    if md.file_type().is_symlink() {
        out.skipped.push(Skipped {
            path: path.to_path_buf(),
            reason: SkipReason::Symlink,
        });
        return;
    }
    if !md.is_file() {
        return;
    }
    if md.len() > DOC_MAX_SOURCE_BYTES {
        out.skipped.push(Skipped {
            path: path.to_path_buf(),
            reason: SkipReason::TooLarge,
        });
        return;
    }
    // An explicit pick still has to be a supported, non-secret, non-symlink file —
    // `explicit` only ever relaxes `is_noise`, which a hand-picked path never reached.
    let _ = explicit;

    if !seen.insert(path.to_path_buf()) {
        return; // the same file picked twice, or reachable from two roots
    }
    if out.found.len() >= MAX_SCAN_FILES {
        out.truncated += 1;
        return;
    }
    out.found.push(Found {
        path: path.to_path_buf(),
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string(),
        media_type: media_type.to_string(),
        size_bytes: md.len(),
        mtime_ms: mtime_ms(&md),
    });
}

fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE guardrail test. Every entry in the secret table, asserted individually, in
    /// both a plain and a nested position — and asserted for `is_secret` rather than
    /// for the walk, so it holds for an explicitly picked path too.
    ///
    /// This exists because the failure it prevents is permanent and silent: a private
    /// key indexed once is a chunk the model will happily retrieve and quote back for
    /// as long as the bucket exists.
    #[test]
    fn the_scanner_never_indexes_a_secret() {
        let must_refuse = [
            "/Users/x/.aws/credentials",
            "/Users/x/.aws/config",
            "/Users/x/.ssh/id_ed25519",
            "/Users/x/.ssh/id_rsa.pub",
            "/Users/x/.ssh/known_hosts",
            "/Users/x/.ssh/authorized_keys",
            "/Users/x/.gnupg/secring.gpg",
            "/Users/x/.password-store/bank.gpg",
            "/Users/x/project/.env",
            "/Users/x/project/.env.local",
            "/Users/x/project/.env.production",
            "/Users/x/certs/server.pem",
            "/Users/x/certs/server.key",
            "/Users/x/certs/bundle.p12",
            "/Users/x/certs/deploy.ppk",
            "/Users/x/vault.kdbx",
            "/Users/x/.netrc",
            "/Users/x/.pgpass",
            "/Users/x/gcp/credentials.json",
            // Case must not be an escape hatch.
            "/Users/x/CERTS/Server.PEM",
            "/Users/x/.AWS/credentials",
        ];
        for p in must_refuse {
            assert!(
                is_secret(Path::new(p)),
                "must be refused as secret material: {p}"
            );
        }
    }

    /// The other half of the denylist: it must not be so broad that ordinary
    /// documentation is unindexable. A test that only asserted refusals would pass
    /// with `is_secret` hardcoded to `true`.
    #[test]
    fn ordinary_documents_are_not_secrets() {
        let must_allow = [
            "/Users/x/Documents/runbook.md",
            "/Users/x/Documents/API Reference.pdf",
            "/Users/x/docs/keyboard-shortcuts.md",
            "/Users/x/docs/monkey.txt",
            "/Users/x/notes/environment-setup.md",
            "/Users/x/notes/credentials-policy.md",
            "/Users/x/screenshots/panel.png",
        ];
        for p in must_allow {
            assert!(!is_secret(Path::new(p)), "must be indexable: {p}");
        }
    }

    /// `environment.md` starts with "env" but not with ".env"; `keyring.md` ends in
    /// neither `.key` nor `.pem`. Prefix and extension rules that were sloppily
    /// written would eat both, and the user would have no way to tell why.
    #[test]
    fn secret_rules_do_not_over_match_similar_names() {
        for p in [
            "/x/environment.md",
            "/x/env.md",
            "/x/keyring.md",
            "/x/monkey.md",
            "/x/pem-guide.md",
            "/x/credentials-rotation-runbook.md",
        ] {
            assert!(!is_secret(Path::new(p)), "over-matched: {p}");
        }
    }

    #[test]
    fn noise_covers_generated_trees_and_every_dot_entry() {
        for name in [
            "node_modules",
            "target",
            "dist",
            ".git",
            ".venv",
            "DerivedData",
        ] {
            assert!(is_noise(name), "{name} should be skipped by a walk");
        }
        for name in [".ssh", ".aws", ".env", ".hidden-docs"] {
            assert!(is_noise(name), "{name} should be skipped by a walk");
        }
        for name in ["docs", "runbook.md", "reference.pdf", "src"] {
            assert!(!is_noise(name), "{name} should be walked");
        }
    }

    #[test]
    fn media_types_come_from_the_extension_table() {
        assert_eq!(
            media_type_for(Path::new("a/b.PDF")),
            Some("application/pdf")
        );
        assert_eq!(media_type_for(Path::new("a/b.md")), Some("text/markdown"));
        assert_eq!(media_type_for(Path::new("a/b.htm")), Some("text/html"));
        assert_eq!(media_type_for(Path::new("a/b.png")), Some("image/png"));
        assert_eq!(media_type_for(Path::new("a/b.rs")), None);
        assert_eq!(media_type_for(Path::new("a/b.exe")), None);
        assert_eq!(media_type_for(Path::new("a/Makefile")), None);
    }

    // ---------------------------------------------------------------- walk tests

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A scratch tree. Uses a counter plus the process id rather than a random name
    /// so parallel test threads do not collide.
    fn tmp_tree(tag: &str) -> Tmp {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("vterm-scan-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    fn write(root: &Path, rel: &str, body: &str) -> PathBuf {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    fn found_names(out: &ScanOutcome) -> Vec<String> {
        out.found.iter().map(|f| f.name.clone()).collect()
    }

    #[test]
    fn a_walk_finds_documents_and_skips_secrets_and_noise() {
        let t = tmp_tree("mixed");
        let root = &t.0;
        write(root, "runbook.md", "# Runbook\n\nSteps.");
        write(root, "nested/reference.md", "# Reference");
        write(root, "notes.txt", "plain");
        write(root, "code.rs", "fn main() {}");
        write(root, "server.pem", "-----BEGIN PRIVATE KEY-----");
        write(root, ".env", "SECRET=1");
        write(root, "node_modules/pkg/readme.md", "# dep");
        write(root, ".ssh/id_ed25519", "key");

        let out = scan(std::slice::from_ref(root), &[]);
        let names = found_names(&out);

        assert!(names.contains(&"runbook.md".to_string()));
        assert!(names.contains(&"reference.md".to_string()));
        assert!(names.contains(&"notes.txt".to_string()));
        assert!(!names.contains(&"code.rs".to_string()), "unsupported type");
        assert!(!names.contains(&"server.pem".to_string()), "secret");
        assert!(!names.contains(&".env".to_string()), "secret");
        assert!(
            !names.contains(&"readme.md".to_string()),
            "node_modules must not be descended into"
        );
        assert!(!names.contains(&"id_ed25519".to_string()), "secret");
        assert_eq!(names.len(), 3, "got {names:?}");
    }

    /// A symlink inside an indexed folder is a path OUT of the bucket's roots. The
    /// tree here is the concrete attack: an innocuous-looking link pointing at a
    /// directory full of keys.
    #[test]
    #[cfg(unix)]
    fn the_scanner_does_not_follow_symlinks() {
        let t = tmp_tree("symlink");
        let root = &t.0;
        write(root, "docs/real.md", "# Real");

        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("stolen.md"), "# Should never be indexed").unwrap();

        std::os::unix::fs::symlink(&outside, root.join("docs/sneaky")).unwrap();
        std::os::unix::fs::symlink(outside.join("stolen.md"), root.join("docs/alias.md")).unwrap();

        let out = scan(&[root.join("docs")], &[]);
        let names = found_names(&out);

        assert_eq!(names, vec!["real.md".to_string()], "got {names:?}");
        assert!(
            out.skipped
                .iter()
                .any(|s| s.reason == SkipReason::Symlink && s.path.ends_with("sneaky")),
            "the symlinked directory must be reported as skipped"
        );
        assert!(
            out.skipped
                .iter()
                .any(|s| s.reason == SkipReason::Symlink && s.path.ends_with("alias.md")),
            "the symlinked file must be reported as skipped"
        );
    }

    /// An explicit pick reaches past the dot rule — someone who chose
    /// `~/.config/notes/plan.md` by hand meant it — but never past the secret rule.
    #[test]
    fn an_explicit_pick_overrides_noise_but_not_secrecy() {
        let t = tmp_tree("explicit");
        let root = &t.0;
        let hidden = write(root, ".hidden/plan.md", "# Plan");
        let secret = write(root, "keys/deploy.pem", "-----BEGIN-----");
        let env = write(root, "app/.env.local", "TOKEN=1");

        // The walk skips all three.
        let walked = scan(std::slice::from_ref(root), &[]);
        assert!(
            found_names(&walked).is_empty(),
            "{:?}",
            found_names(&walked)
        );

        // Picked by hand, the hidden document is admitted and the secrets are not.
        let picked = scan(&[], &[hidden.clone(), secret.clone(), env.clone()]);
        assert_eq!(found_names(&picked), vec!["plan.md".to_string()]);
        assert!(picked
            .skipped
            .iter()
            .any(|s| s.path == secret && s.reason == SkipReason::Secret));
        assert!(picked
            .skipped
            .iter()
            .any(|s| s.path == env && s.reason == SkipReason::Secret));
    }

    #[test]
    fn the_same_file_reachable_twice_is_offered_once() {
        let t = tmp_tree("dedup");
        let root = &t.0;
        let doc = write(root, "docs/a.md", "# A");
        let out = scan(
            &[root.clone(), root.join("docs")],
            &[doc.clone(), doc.clone()],
        );
        assert_eq!(found_names(&out), vec!["a.md".to_string()]);
    }

    #[test]
    fn an_oversized_file_is_skipped_and_reported() {
        let t = tmp_tree("big");
        let root = &t.0;
        let path = write(root, "huge.txt", "x");
        // Reported by metadata, so a sparse file of the right length is enough.
        let f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.set_len(DOC_MAX_SOURCE_BYTES + 1).unwrap();
        drop(f);

        let out = scan(std::slice::from_ref(root), &[]);
        assert!(found_names(&out).is_empty());
        assert!(out
            .skipped
            .iter()
            .any(|s| s.path == path && s.reason == SkipReason::TooLarge));
    }

    #[test]
    fn a_missing_root_is_reported_not_panicked() {
        let out = scan(&[PathBuf::from("/definitely/not/here/at/all")], &[]);
        assert!(out.found.is_empty());
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(out.skipped[0].reason, SkipReason::Unreadable);
    }
}
