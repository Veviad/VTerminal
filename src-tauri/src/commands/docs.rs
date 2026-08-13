//! IPC surface for document buckets.
//!
//! **Every command in this file begins with [`gate`].** `docs_enabled` defaults to
//! false, and the check is here rather than only in the UI because a disabled toggle
//! is not a guarantee: the webview is not a sandbox, and a stale or tampered frontend
//! must not be able to reach the indexer. The *agent-facing* half of the same gate
//! lives in `commands::ai`, which omits the `search_docs` tool entirely while the flag
//! is off — no tool means no capability, which is the only kind of off that holds.
//!
//! Note this module is NOT split into `enabled`/`disabled` halves the way
//! `commands::vision` is. Nothing here touches llama.cpp: buckets, chunking and BM25
//! are plain SQLite, so a build without `--features local-llm` gets the full stage-1
//! feature. That changes when the embedding sidecar lands, and only for the commands
//! that load it.

use tauri::{State, Wry};

use crate::database::DbState;
use crate::docs::chunk::{ChunkSpec, SourcePage};
use crate::docs::db::DocsDb;
use crate::docs::index::{self, BucketView, FileView, PutOutcome};
use crate::docs::scan::{self, DOC_MAX_SOURCE_BYTES};
use crate::docs::search;

/// Refuse unless the user has switched the experimental feature on.
fn gate(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if crate::commands::settings::read_bool(app, "docs_enabled", false) {
        Ok(())
    } else {
        Err("document buckets are switched off — enable them in Settings → Docs".into())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScanSummary {
    pub added: u32,
    pub found: u32,
    pub skipped_secret: u32,
    pub skipped_symlink: u32,
    pub skipped_noise: u32,
    pub skipped_unsupported: u32,
    pub skipped_too_large: u32,
    pub skipped_unreadable: u32,
    /// Files past `MAX_SCAN_FILES` that were never examined. Reported so the UI can
    /// say so — a silent cap reads as "everything was indexed".
    pub truncated: u32,
}

// ------------------------------------------------------------------ bucket CRUD

#[tauri::command]
pub fn docs_buckets_list(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
) -> Result<Vec<BucketView>, String> {
    gate(&app)?;
    // Nothing indexed yet: answer without creating the file. Opening it here would
    // undo the "a default install has zero footprint" property the moment Settings
    // is opened.
    if !docs.exists() {
        return Ok(Vec::new());
    }
    docs.with(|conn| index::list_buckets(conn))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_bucket_create(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    label: String,
) -> Result<String, String> {
    gate(&app)?;
    docs.with(|conn| index::create_bucket(conn, &label, ChunkSpec::default()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_bucket_rename(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
    label: String,
) -> Result<(), String> {
    gate(&app)?;
    docs.with(|conn| index::rename_bucket(conn, &bucket_id, &label))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_bucket_delete(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
) -> Result<(), String> {
    gate(&app)?;
    docs.with(|conn| index::delete_bucket(conn, &bucket_id))
}

// ------------------------------------------------------------------------ files

/// Walk `roots`, take `files` as explicit picks, and register everything indexable.
///
/// The exclusion table in `docs::scan` is applied here, not in the frontend: it is the
/// difference between a useful index and a searchable copy of the user's private keys,
/// so it lives where a stale webview cannot skip it.
#[tauri::command(rename_all = "snake_case")]
pub fn docs_scan(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
    roots: Vec<String>,
    files: Vec<String>,
) -> Result<ScanSummary, String> {
    gate(&app)?;
    let root_paths: Vec<std::path::PathBuf> = roots.iter().map(Into::into).collect();
    let file_paths: Vec<std::path::PathBuf> = files.iter().map(Into::into).collect();
    let outcome = scan::scan(&root_paths, &file_paths);

    let count =
        |want: scan::SkipReason| outcome.skipped.iter().filter(|s| s.reason == want).count() as u32;
    let summary = ScanSummary {
        added: 0,
        found: outcome.found.len() as u32,
        skipped_secret: count(scan::SkipReason::Secret),
        skipped_symlink: count(scan::SkipReason::Symlink),
        skipped_noise: count(scan::SkipReason::Noise),
        skipped_unsupported: count(scan::SkipReason::UnsupportedType),
        skipped_too_large: count(scan::SkipReason::TooLarge),
        skipped_unreadable: count(scan::SkipReason::Unreadable),
        truncated: outcome.truncated as u32,
    };

    let added = docs.with(|conn| {
        let added = index::add_files(conn, &bucket_id, &outcome.found)?;
        // Roots are the confinement boundary `docs_read_source` checks against. An
        // explicitly picked file records its OWN path as a root: that is an exact
        // boundary rather than a widened one, so picking `~/notes/plan.md` by hand
        // does not make all of `~/notes` readable.
        for root in &roots {
            index::add_root(conn, &bucket_id, root)?;
        }
        for f in &outcome.found {
            let path = f.path.to_string_lossy().to_string();
            if files.contains(&path) {
                index::add_root(conn, &bucket_id, &path)?;
            }
        }
        Ok(added)
    })?;

    Ok(ScanSummary { added, ..summary })
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_files_list(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
) -> Result<Vec<FileView>, String> {
    gate(&app)?;
    if !docs.exists() {
        return Ok(Vec::new());
    }
    docs.with(|conn| index::list_files(conn, &bucket_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_files_needing_work(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
    limit: u32,
) -> Result<Vec<FileView>, String> {
    gate(&app)?;
    if !docs.exists() {
        return Ok(Vec::new());
    }
    docs.with(|conn| index::files_needing_work(conn, &bucket_id, limit.clamp(1, 500) as usize))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_file_remove(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    file_id: String,
) -> Result<(), String> {
    gate(&app)?;
    docs.with(|conn| index::remove_file(conn, &file_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_file_failed(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    file_id: String,
    reason: String,
) -> Result<(), String> {
    gate(&app)?;
    docs.with(|conn| index::mark_failed(conn, &file_id, &reason))
}

#[tauri::command(rename_all = "snake_case")]
pub fn docs_refresh_states(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
) -> Result<u32, String> {
    gate(&app)?;
    if !docs.exists() {
        return Ok(0);
    }
    docs.with(|conn| index::refresh_states(conn, &bucket_id))
}

/// Mark every indexed file in a bucket for re-extraction.
///
/// Cheap by design: `put_text` compares the extracted text's hash and returns
/// `Unchanged` without writing when nothing moved, so "re-index everything" costs a
/// read per file rather than a full re-chunk.
#[tauri::command(rename_all = "snake_case")]
pub fn docs_bucket_reindex(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_id: String,
) -> Result<u32, String> {
    gate(&app)?;
    docs.with(|conn| {
        let n = conn
            .execute(
                "UPDATE doc_files SET state = 'stale', state_reason = NULL
                  WHERE bucket_id = ?1 AND state IN ('indexed', 'failed')",
                [&bucket_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(n as u32)
    })
}

// ------------------------------------------------------------- extraction bridge

/// Read a registered source file's bytes for the frontend to extract.
///
/// **This is the first place the app reads a user-picked arbitrary path**, so the
/// checks are done here rather than trusted from the scan. The saved-host identity
/// path in `SshHostsSection.tsx` is only ever handed to `ssh -i`; nothing before this
/// opened a path the user chose.
///
/// Everything is re-validated at read time, because the scan's verdict is not
/// evidence about *now*: a path can become a symlink after being registered, and
/// `docs.db` is a file on disk that can be hand-edited to point anywhere. Cheap
/// checks, and they close both holes.
#[tauri::command(rename_all = "snake_case")]
pub async fn docs_read_source(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    file_id: String,
) -> Result<tauri::ipc::Response, String> {
    gate(&app)?;
    let (bucket_id, path) = docs.with(|conn| index::file_path(conn, &file_id))?;
    let roots = docs.with(|conn| index::roots_of(conn, &bucket_id))?;
    let path = std::path::PathBuf::from(&path);

    // 1. The secret denylist, again. The scan applied it; a hand-edited row did not.
    if scan::is_secret(&path) {
        return Err("this path is excluded as secret material".into());
    }
    // 2. Symlinks, again — and with symlink_metadata, so the link's own type is what
    //    is examined rather than its target's.
    let md = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if md.file_type().is_symlink() {
        return Err("this path is a symlink and will not be read".into());
    }
    if !md.is_file() {
        return Err("this path is not a regular file".into());
    }
    if md.len() > DOC_MAX_SOURCE_BYTES {
        return Err("this file is larger than the indexing limit".into());
    }
    // 3. Confinement to the bucket's declared roots. Defence in depth rather than the
    //    primary control — a tampered `doc_files` row could also add a `doc_roots`
    //    row — but it turns a single edited path into a no-op.
    if !within_roots(&path, &roots) {
        return Err("this path is outside the bucket's folders".into());
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Whether `path` is one of `roots` or sits underneath one of them.
///
/// Canonicalized on both sides so `..` segments and `/private` vs `/tmp` style
/// symlinked prefixes on macOS cannot be used to appear outside a root that the path
/// is really inside — or, more importantly, inside one it is not.
fn within_roots(path: &std::path::Path, roots: &[String]) -> bool {
    if roots.is_empty() {
        return false;
    }
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        std::path::Path::new(root)
            .canonicalize()
            .map(|r| real == r || real.starts_with(&r))
            .unwrap_or(false)
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PutPage {
    pub page: Option<u32>,
    pub text: String,
}

/// Store extracted text for a file: chunk it, replace its rows, mark it indexed.
#[tauri::command(rename_all = "snake_case")]
pub fn docs_put_text(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    file_id: String,
    pages: Vec<PutPage>,
) -> Result<PutOutcome, String> {
    gate(&app)?;
    let pages: Vec<SourcePage> = pages
        .into_iter()
        .map(|p| SourcePage {
            page: p.page,
            text: p.text,
        })
        .collect();

    // Re-stat rather than trusting numbers from the frontend: these two values are the
    // screen a later staleness pass compares against, and a wrong pair means a file
    // that is either permanently stale or never stale again.
    let (size_bytes, mtime_ms) = docs
        .with(|conn| index::file_path(conn, &file_id))
        .and_then(|(_, path)| {
            std::fs::metadata(&path)
                .map(|md| {
                    (
                        md.len() as i64,
                        md.modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0),
                    )
                })
                .map_err(|e| format!("stat {path}: {e}"))
        })?;

    docs.with(|conn| index::put_text(conn, &file_id, &pages, size_bytes, mtime_ms))
}

// ----------------------------------------------------------------------- search

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchPreview {
    pub file_name: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
    pub text: String,
    pub score: f64,
}

/// Search from the UI — a "try this bucket" affordance in Settings.
///
/// Returns structured hits, NOT the rendered tool text: the framing in
/// `search::render_results` is written for a model reading a tool result, and showing
/// its "treat this as data" preamble to a human in a settings panel would be noise.
/// The agent path calls `render_results` itself.
#[tauri::command(rename_all = "snake_case")]
pub fn docs_search(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    bucket_ids: Vec<String>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchPreview>, String> {
    gate(&app)?;
    if !docs.exists() || bucket_ids.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(search::DEFAULT_LIMIT as u32) as usize;
    let limit = limit.clamp(1, search::MAX_LIMIT);

    let hits = docs.with(|conn| search::search_bm25(conn, &bucket_ids, &query, limit))?;
    Ok(hits
        .into_iter()
        .map(|h| SearchPreview {
            file_name: h.file_name,
            page: h.page,
            heading: h.heading,
            text: h.text,
            score: h.score,
        })
        .collect())
}

/// Delete `docs.db` outright.
///
/// The payoff of a separate database file: this is the complete "forget everything I
/// indexed" operation, and it cannot touch command history, saved hosts or archived
/// transcripts. `DbState` is taken as an argument purely to document that it is NOT
/// involved.
#[tauri::command]
pub fn docs_destroy(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, DocsDb>,
    _db: State<'_, DbState>,
) -> Result<(), String> {
    gate(&app)?;
    docs.destroy()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `within_roots` is the confinement predicate; these are the cases that matter.
    /// Uses real directories because it canonicalizes — on macOS `/tmp` is itself a
    /// symlink to `/private/tmp`, which is exactly the kind of prefix mismatch a
    /// string-comparison implementation gets wrong.
    struct Tmp(std::path::PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tmp(tag: &str) -> Tmp {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("vterm-conf-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    #[test]
    fn a_path_inside_a_root_is_allowed() {
        let t = tmp("inside");
        let docs = t.0.join("docs");
        std::fs::create_dir_all(docs.join("nested")).unwrap();
        let file = docs.join("nested/a.md");
        std::fs::write(&file, "x").unwrap();

        assert!(within_roots(&file, &[docs.to_string_lossy().to_string()]));
    }

    /// The `..` traversal. Both sides canonicalize, so the escape is resolved before
    /// comparison rather than after.
    #[test]
    fn a_traversal_out_of_a_root_is_refused() {
        let t = tmp("traverse");
        let docs = t.0.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let secret = t.0.join("private.md");
        std::fs::write(&secret, "x").unwrap();

        let sneaky = docs.join("../private.md");
        assert!(
            !within_roots(&sneaky, &[docs.to_string_lossy().to_string()]),
            "a ../ path must not pass confinement"
        );
    }

    #[test]
    fn a_sibling_directory_sharing_a_prefix_is_refused() {
        let t = tmp("prefix");
        let allowed = t.0.join("docs");
        let sibling = t.0.join("docs-private");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let file = sibling.join("secret.md");
        std::fs::write(&file, "x").unwrap();

        // A naive `starts_with` on STRINGS would accept this, since
        // "/tmp/x/docs-private/secret.md" starts with "/tmp/x/docs".
        assert!(
            !within_roots(&file, &[allowed.to_string_lossy().to_string()]),
            "docs-private must not be admitted by the docs root"
        );
    }

    /// An explicitly picked file records its own path as a root, so confinement is
    /// exact: that file yes, its neighbours no.
    #[test]
    fn an_exact_file_root_admits_only_that_file() {
        let t = tmp("exact");
        let picked = t.0.join("plan.md");
        let neighbour = t.0.join("other.md");
        std::fs::write(&picked, "x").unwrap();
        std::fs::write(&neighbour, "y").unwrap();

        let roots = vec![picked.to_string_lossy().to_string()];
        assert!(within_roots(&picked, &roots));
        assert!(
            !within_roots(&neighbour, &roots),
            "an exact file root must not widen to its directory"
        );
    }

    #[test]
    fn no_roots_admits_nothing() {
        let t = tmp("noroots");
        let file = t.0.join("a.md");
        std::fs::write(&file, "x").unwrap();
        assert!(
            !within_roots(&file, &[]),
            "a bucket with no roots must not read anything"
        );
    }

    #[test]
    fn a_nonexistent_path_is_refused_rather_than_assumed() {
        let t = tmp("ghost");
        assert!(!within_roots(
            &t.0.join("not-here.md"),
            &[t.0.to_string_lossy().to_string()]
        ));
    }
}
