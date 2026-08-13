//! Reads and writes against `docs.db`: bucket and file CRUD, the transactional
//! re-index, and staleness detection.
//!
//! Two decisions here are worth knowing before changing anything.
//!
//! **Re-index is REPLACE, never patch, and it is one transaction.** `put_text`
//! deletes a file's chunks and inserts the new ones inside a single
//! `conn.transaction()`, so a bucket is never observed half-updated — and because
//! WAL is on, a `search_docs` call from a live agent run reads the old rows
//! throughout rather than blocking. Diffing chunk-by-chunk was considered and
//! rejected: the bookkeeping costs more than re-chunking, and the *interesting*
//! optimisation is at a different level (`doc_chunks.text_sha256`, so stage 2 can
//! re-embed only the chunks whose text actually moved).
//!
//! **The re-index decision is a hash of the EXTRACTED TEXT, not of the raw bytes.**
//! A PDF re-saved by a different producer, or a file whose mtime was touched by a
//! backup tool, has identical text and must cost nothing. Conversely a file whose
//! size and mtime happen to match but whose content changed is still caught. mtime
//! and size are stored too, but only as the cheap *screen* that decides whether it is
//! worth reading the file at all.

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::chunk::{self, ChunkSpec, SourcePage};
use super::scan::Found;

/// Per-file state. Mirrors the `CHECK` constraint in the v1 migration; the constant
/// strings are the wire format the frontend switches on.
pub mod state {
    pub const PENDING: &str = "pending";
    pub const INDEXED: &str = "indexed";
    pub const STALE: &str = "stale";
    pub const MISSING: &str = "missing";
    pub const FAILED: &str = "failed";
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BucketView {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub indexed_at: Option<i64>,
    pub embed_model_id: Option<String>,
    pub chunk_chars: u32,
    pub chunk_overlap: u32,
    pub roots: Vec<String>,
    pub file_count: u32,
    pub chunk_count: u32,
    /// Files awaiting extraction, so the UI can say "3 of 40 left" honestly.
    pub pending_count: u32,
    pub stale_count: u32,
    pub missing_count: u32,
    pub failed_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileView {
    pub id: String,
    pub bucket_id: String,
    pub path: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub mtime_ms: i64,
    pub state: String,
    pub state_reason: Option<String>,
    pub page_count: Option<u32>,
    pub chunk_count: u32,
    pub indexed_at: Option<i64>,
}

/// What a `put_text` call actually did — surfaced so the indexing UI can report
/// "38 unchanged, 2 re-indexed" rather than implying it re-read everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PutOutcome {
    /// The extracted text hashed identically and the file was already indexed.
    Unchanged,
    Indexed {
        chunks: u32,
    },
}

pub fn text_sha256(text: &str) -> String {
    use std::fmt::Write;

    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------------ bucket CRUD

pub fn create_bucket(conn: &Connection, label: &str, spec: ChunkSpec) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let label = clean_label(label)?;
    conn.execute(
        "INSERT INTO doc_buckets (id, label, created_at, chunk_chars, chunk_overlap)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            id,
            label,
            now_ms(),
            spec.target_chars as i64,
            spec.overlap_chars as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Labels are user text that ends up in a tool result the model reads, so control
/// characters are rejected outright rather than escaped — the same stance
/// `commands/remote_servers.rs` takes, and for the same reason: `docs.db` is a file
/// on disk that a determined user can hand-edit.
pub const MAX_LABEL_CHARS: usize = 64;

fn clean_label(label: &str) -> Result<String, String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("a bucket needs a name".into());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("a bucket name cannot contain control characters".into());
    }
    if trimmed.chars().count() > MAX_LABEL_CHARS {
        return Err(format!(
            "a bucket name must be {MAX_LABEL_CHARS} characters or fewer"
        ));
    }
    Ok(trimmed.to_string())
}

pub fn rename_bucket(conn: &Connection, id: &str, label: &str) -> Result<(), String> {
    let label = clean_label(label)?;
    let n = conn
        .execute(
            "UPDATE doc_buckets SET label = ?2 WHERE id = ?1",
            params![id, label],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("unknown bucket: {id}"));
    }
    Ok(())
}

/// Delete a bucket. Files, roots and chunks cascade; the FTS rows go with the chunks
/// via trigger. Nothing needs rebuilding — which is the payoff of ranking by a full
/// scan rather than by a graph index.
pub fn delete_bucket(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM doc_buckets WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_buckets(conn: &Connection) -> Result<Vec<BucketView>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.label, b.created_at, b.indexed_at, b.embed_model_id,
                    b.chunk_chars, b.chunk_overlap,
                    (SELECT count(*) FROM doc_files f WHERE f.bucket_id = b.id),
                    (SELECT coalesce(sum(f.chunk_count), 0) FROM doc_files f WHERE f.bucket_id = b.id),
                    (SELECT count(*) FROM doc_files f WHERE f.bucket_id = b.id AND f.state = 'pending'),
                    (SELECT count(*) FROM doc_files f WHERE f.bucket_id = b.id AND f.state = 'stale'),
                    (SELECT count(*) FROM doc_files f WHERE f.bucket_id = b.id AND f.state = 'missing'),
                    (SELECT count(*) FROM doc_files f WHERE f.bucket_id = b.id AND f.state = 'failed')
               FROM doc_buckets b
              ORDER BY b.created_at, b.id",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok(BucketView {
                id: r.get(0)?,
                label: r.get(1)?,
                created_at: r.get(2)?,
                indexed_at: r.get(3)?,
                embed_model_id: r.get(4)?,
                chunk_chars: r.get::<_, i64>(5)? as u32,
                chunk_overlap: r.get::<_, i64>(6)? as u32,
                roots: Vec::new(),
                file_count: r.get::<_, i64>(7)? as u32,
                chunk_count: r.get::<_, i64>(8)? as u32,
                pending_count: r.get::<_, i64>(9)? as u32,
                stale_count: r.get::<_, i64>(10)? as u32,
                missing_count: r.get::<_, i64>(11)? as u32,
                failed_count: r.get::<_, i64>(12)? as u32,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut buckets = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for bucket in &mut buckets {
        bucket.roots = roots_of(conn, &bucket.id)?;
    }
    Ok(buckets)
}

pub fn roots_of(conn: &Connection, bucket_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT path FROM doc_roots WHERE bucket_id = ?1 ORDER BY path")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([bucket_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn add_root(conn: &Connection, bucket_id: &str, path: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO doc_roots (bucket_id, path) VALUES (?1, ?2)",
        params![bucket_id, path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn bucket_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM doc_buckets WHERE id = ?1", [id], |_| Ok(()))
        .map(|_| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(other.to_string()),
        })
}

pub fn chunk_spec_of(conn: &Connection, bucket_id: &str) -> Result<ChunkSpec, String> {
    conn.query_row(
        "SELECT chunk_chars, chunk_overlap FROM doc_buckets WHERE id = ?1",
        [bucket_id],
        |r| {
            Ok(ChunkSpec {
                target_chars: r.get::<_, i64>(0)? as usize,
                overlap_chars: r.get::<_, i64>(1)? as usize,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("unknown bucket: {bucket_id}"),
        other => other.to_string(),
    })
}

// -------------------------------------------------------------------- file CRUD

/// Register scanned files as `pending`.
///
/// `INSERT OR IGNORE` on the `(bucket_id, path)` unique index, so re-scanning a root
/// after adding two files does not reset the state of the thirty-eight already
/// indexed. Returns how many rows were genuinely new.
pub fn add_files(conn: &mut Connection, bucket_id: &str, found: &[Found]) -> Result<u32, String> {
    if !bucket_exists(conn, bucket_id)? {
        return Err(format!("unknown bucket: {bucket_id}"));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut added = 0u32;
    for f in found {
        let path = f.path.to_string_lossy().to_string();
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO doc_files
                   (id, bucket_id, path, name, media_type, size_bytes, mtime_ms, state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    bucket_id,
                    path,
                    f.name,
                    f.media_type,
                    f.size_bytes as i64,
                    f.mtime_ms
                ],
            )
            .map_err(|e| e.to_string())?;
        added += n as u32;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

pub fn remove_file(conn: &Connection, file_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM doc_files WHERE id = ?1", [file_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_files(conn: &Connection, bucket_id: &str) -> Result<Vec<FileView>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, bucket_id, path, name, media_type, size_bytes, mtime_ms,
                    state, state_reason, page_count, chunk_count, indexed_at
               FROM doc_files WHERE bucket_id = ?1 ORDER BY name, path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([bucket_id], |r| {
            Ok(FileView {
                id: r.get(0)?,
                bucket_id: r.get(1)?,
                path: r.get(2)?,
                name: r.get(3)?,
                media_type: r.get(4)?,
                size_bytes: r.get(5)?,
                mtime_ms: r.get(6)?,
                state: r.get(7)?,
                state_reason: r.get(8)?,
                page_count: r.get::<_, Option<i64>>(9)?.map(|v| v as u32),
                chunk_count: r.get::<_, i64>(10)? as u32,
                indexed_at: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Files the frontend still has to extract, oldest first. Drives the indexing loop.
pub fn files_needing_work(
    conn: &Connection,
    bucket_id: &str,
    limit: usize,
) -> Result<Vec<FileView>, String> {
    Ok(list_files(conn, bucket_id)?
        .into_iter()
        .filter(|f| f.state == state::PENDING || f.state == state::STALE)
        .take(limit)
        .collect())
}

pub fn file_path(conn: &Connection, file_id: &str) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT bucket_id, path FROM doc_files WHERE id = ?1",
        [file_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("unknown file: {file_id}"),
        other => other.to_string(),
    })
}

pub fn mark_failed(conn: &Connection, file_id: &str, reason: &str) -> Result<(), String> {
    // The reason is shown to the user verbatim, so it is length-capped here rather
    // than trusting every caller's error string to be short.
    let reason: String = reason.chars().take(200).collect();
    conn.execute(
        "UPDATE doc_files SET state = 'failed', state_reason = ?2 WHERE id = ?1",
        params![file_id, reason],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------------- the ingest

/// Replace a file's chunks from freshly extracted text.
///
/// Returns [`PutOutcome::Unchanged`] without writing anything when the text hashes
/// identically and the file is already indexed — which is what makes "re-index this
/// bucket" cheap enough to be a button rather than a warning.
pub fn put_text(
    conn: &mut Connection,
    file_id: &str,
    pages: &[SourcePage],
    size_bytes: i64,
    mtime_ms: i64,
) -> Result<PutOutcome, String> {
    let (bucket_id, _) = file_path(conn, file_id)?;
    let spec = chunk_spec_of(conn, &bucket_id)?;

    let joined = pages
        .iter()
        .map(|p| p.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let sha = text_sha256(&joined);

    let (prev_sha, prev_state): (Option<String>, String) = conn
        .query_row(
            "SELECT text_sha256, state FROM doc_files WHERE id = ?1",
            [file_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    if prev_state == state::INDEXED && prev_sha.as_deref() == Some(sha.as_str()) {
        // The text is identical. Refresh the cheap screen so the next staleness pass
        // stops flagging a file that only had its mtime touched.
        conn.execute(
            "UPDATE doc_files SET size_bytes = ?2, mtime_ms = ?3 WHERE id = ?1",
            params![file_id, size_bytes, mtime_ms],
        )
        .map_err(|e| e.to_string())?;
        return Ok(PutOutcome::Unchanged);
    }

    let chunks = chunk::chunk_pages(pages, spec);
    let page_count = pages.iter().filter_map(|p| p.page).max();
    let now = now_ms();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM doc_chunks WHERE file_id = ?1", [file_id])
        .map_err(|e| e.to_string())?;
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO doc_chunks
                   (file_id, bucket_id, ord, page, heading, text, text_sha256)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;
        for c in &chunks {
            insert
                .execute(params![
                    file_id,
                    bucket_id,
                    c.ord as i64,
                    c.page.map(|p| p as i64),
                    c.heading,
                    c.text,
                    text_sha256(&c.text)
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "UPDATE doc_files
            SET state = 'indexed', state_reason = NULL, text_sha256 = ?2,
                chunk_count = ?3, page_count = ?4, size_bytes = ?5, mtime_ms = ?6,
                indexed_at = ?7
          WHERE id = ?1",
        params![
            file_id,
            sha,
            chunks.len() as i64,
            page_count.map(|p| p as i64),
            size_bytes,
            mtime_ms,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE doc_buckets SET indexed_at = ?2 WHERE id = ?1",
        params![bucket_id, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    Ok(PutOutcome::Indexed {
        chunks: chunks.len() as u32,
    })
}

/// Re-stat every file in a bucket, flagging what moved or vanished.
///
/// `missing` and `stale` are ordinary states rather than errors precisely because
/// sources are referenced by path: files WILL be moved, renamed and deleted, and the
/// UI has to report that calmly instead of failing an operation the user did not
/// perform. A missing file keeps its chunks — the text is still the best answer
/// available, and deleting it on a transient unmount would be worse.
pub fn refresh_states(conn: &Connection, bucket_id: &str) -> Result<u32, String> {
    let files = list_files(conn, bucket_id)?;
    let mut changed = 0u32;
    for f in files {
        // A file the user has not indexed yet has nothing to go stale.
        if f.state == state::PENDING {
            continue;
        }
        let next = match std::fs::symlink_metadata(&f.path) {
            Err(_) => Some((state::MISSING, Some("the file is no longer at this path"))),
            Ok(md) if md.file_type().is_symlink() => {
                Some((state::MISSING, Some("this path is now a symlink")))
            }
            Ok(md) => {
                let moved = md.len() as i64 != f.size_bytes
                    || md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                        != f.mtime_ms;
                if moved && f.state != state::STALE {
                    Some((state::STALE, Some("the file changed on disk")))
                } else if !moved && (f.state == state::MISSING || f.state == state::FAILED) {
                    // It came back, or the failure was transient. Re-offer it.
                    Some((state::PENDING, None))
                } else {
                    None
                }
            }
        };
        if let Some((next_state, reason)) = next {
            if next_state != f.state {
                conn.execute(
                    "UPDATE doc_files SET state = ?2, state_reason = ?3 WHERE id = ?1",
                    params![f.id, next_state, reason],
                )
                .map_err(|e| e.to_string())?;
                changed += 1;
            }
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_sha256_is_lowercase_hex() {
        assert_eq!(
            text_sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        super::super::db::migrate(&conn).unwrap();
        conn
    }

    fn page(n: u32, text: &str) -> SourcePage {
        SourcePage {
            page: Some(n),
            text: text.into(),
        }
    }

    fn plain(text: &str) -> Vec<SourcePage> {
        vec![SourcePage {
            page: None,
            text: text.into(),
        }]
    }

    fn one_file(conn: &mut Connection) -> (String, String) {
        let bucket = create_bucket(conn, "Runbooks", ChunkSpec::default()).unwrap();
        let found = Found {
            path: "/docs/runbook.md".into(),
            name: "runbook.md".into(),
            media_type: "text/markdown".into(),
            size_bytes: 10,
            mtime_ms: 1,
        };
        add_files(conn, &bucket, &[found]).unwrap();
        let file = list_files(conn, &bucket).unwrap()[0].id.clone();
        (bucket, file)
    }

    #[test]
    fn a_bucket_round_trips_with_its_counts() {
        let mut conn = db();
        let (bucket, file) = one_file(&mut conn);

        let listed = list_buckets(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "Runbooks");
        assert_eq!(listed[0].file_count, 1);
        assert_eq!(listed[0].pending_count, 1);
        assert_eq!(listed[0].chunk_count, 0);
        assert_eq!(listed[0].indexed_at, None);

        put_text(&mut conn, &file, &plain("Some body text to index."), 10, 1).unwrap();
        let listed = list_buckets(&conn).unwrap();
        assert_eq!(listed[0].pending_count, 0);
        assert_eq!(listed[0].chunk_count, 1);
        assert!(listed[0].indexed_at.is_some());
        assert_eq!(bucket, listed[0].id);
    }

    /// The property that makes "re-index bucket" a cheap button. Without it, every
    /// re-index re-chunks and (in stage 2) re-embeds a whole corpus.
    #[test]
    fn reindexing_unchanged_text_is_a_no_op() {
        let mut conn = db();
        let (_, file) = one_file(&mut conn);
        let pages = plain("Rolling back a release is a two-step procedure.");

        let first = put_text(&mut conn, &file, &pages, 10, 1).unwrap();
        assert!(matches!(first, PutOutcome::Indexed { .. }));

        let indexed_at = list_files(&conn, &file_path(&conn, &file).unwrap().0).unwrap()[0]
            .indexed_at
            .unwrap();

        // A backup tool touched the mtime, but the text is identical.
        let second = put_text(&mut conn, &file, &pages, 10, 999).unwrap();
        assert_eq!(second, PutOutcome::Unchanged);

        let row = &list_files(&conn, &file_path(&conn, &file).unwrap().0).unwrap()[0];
        assert_eq!(row.indexed_at, Some(indexed_at), "must not be re-stamped");
        assert_eq!(row.mtime_ms, 999, "the cheap screen must still refresh");
    }

    /// Changed text replaces every chunk and leaves nothing behind — neither an orphan
    /// row nor a stale FTS entry that would keep matching the deleted text.
    #[test]
    fn changed_text_replaces_chunks_without_orphans() {
        let mut conn = db();
        let (bucket, file) = one_file(&mut conn);

        put_text(&mut conn, &file, &plain("the aardvark paragraph"), 10, 1).unwrap();
        let before: i64 = conn
            .query_row("SELECT count(*) FROM doc_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, 1);

        put_text(&mut conn, &file, &plain("the buffalo paragraph"), 11, 2).unwrap();

        let after: i64 = conn
            .query_row("SELECT count(*) FROM doc_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 1, "the old chunk must be gone, not accumulated");

        let stale =
            super::super::search::search_bm25(&conn, std::slice::from_ref(&bucket), "aardvark", 5)
                .unwrap();
        assert!(stale.is_empty(), "FTS must not still match replaced text");
        let fresh = super::super::search::search_bm25(&conn, &[bucket], "buffalo", 5).unwrap();
        assert_eq!(fresh.len(), 1);
    }

    #[test]
    fn pages_produce_page_counts_and_citable_chunks() {
        let mut conn = db();
        let (bucket, file) = one_file(&mut conn);
        // Each page carries filler PLUS one word unique to it. The filler cannot be the
        // search term: `docs::search`'s planner refuses a term present in most of the
        // corpus, so a fixture where every chunk says "rollback" is a fixture where
        // "rollback" identifies nothing.
        let pages: Vec<SourcePage> = (1..=4)
            .map(|p| {
                page(
                    p,
                    &format!(
                        "{}marker{p} closes the section.",
                        format!("Page {p} discusses the deployment procedure. ").repeat(30)
                    ),
                )
            })
            .collect();
        put_text(&mut conn, &file, &pages, 100, 1).unwrap();

        let row = &list_files(&conn, &bucket).unwrap()[0];
        assert_eq!(row.page_count, Some(4));
        assert!(row.chunk_count > 1);

        let hits = super::super::search::search_bm25(&conn, &[bucket], "marker3", 5).unwrap();
        assert!(!hits.is_empty(), "the distinctive term must be findable");
        assert!(
            hits.iter().any(|h| h.page.is_some()),
            "chunks must be citable"
        );
    }

    #[test]
    fn rescanning_does_not_reset_already_indexed_files() {
        let mut conn = db();
        let (bucket, file) = one_file(&mut conn);
        put_text(&mut conn, &file, &plain("body"), 10, 1).unwrap();

        let found = Found {
            path: "/docs/runbook.md".into(),
            name: "runbook.md".into(),
            media_type: "text/markdown".into(),
            size_bytes: 10,
            mtime_ms: 1,
        };
        let added = add_files(&mut conn, &bucket, &[found]).unwrap();
        assert_eq!(added, 0, "an existing path must not be re-added");

        let row = &list_files(&conn, &bucket).unwrap()[0];
        assert_eq!(row.state, state::INDEXED, "state must survive a re-scan");
    }

    #[test]
    fn deleting_a_file_removes_it_from_search() {
        let mut conn = db();
        let (bucket, file) = one_file(&mut conn);
        put_text(&mut conn, &file, &plain("findable content here"), 10, 1).unwrap();
        assert_eq!(
            super::super::search::search_bm25(&conn, std::slice::from_ref(&bucket), "findable", 5)
                .unwrap()
                .len(),
            1
        );

        remove_file(&conn, &file).unwrap();
        assert!(
            super::super::search::search_bm25(&conn, &[bucket], "findable", 5)
                .unwrap()
                .is_empty(),
            "a deleted file must vanish from results"
        );
    }

    #[test]
    fn labels_reject_control_characters_and_overlong_names() {
        let conn = db();
        assert!(create_bucket(&conn, "  ", ChunkSpec::default()).is_err());
        assert!(create_bucket(&conn, "bad\u{0007}name", ChunkSpec::default()).is_err());
        assert!(create_bucket(&conn, "line\nbreak", ChunkSpec::default()).is_err());
        assert!(create_bucket(&conn, &"x".repeat(65), ChunkSpec::default()).is_err());
        assert!(create_bucket(&conn, "  Trimmed  ", ChunkSpec::default()).is_ok());
        assert_eq!(list_buckets(&conn).unwrap()[0].label, "Trimmed");
    }

    #[test]
    fn a_bucket_remembers_its_chunk_spec() {
        let conn = db();
        let spec = ChunkSpec {
            target_chars: 700,
            overlap_chars: 90,
        };
        let id = create_bucket(&conn, "Custom", spec).unwrap();
        assert_eq!(chunk_spec_of(&conn, &id).unwrap(), spec);
    }

    #[test]
    fn unknown_ids_are_errors_not_silent_successes() {
        let mut conn = db();
        assert!(chunk_spec_of(&conn, "nope").is_err());
        assert!(file_path(&conn, "nope").is_err());
        assert!(rename_bucket(&conn, "nope", "x").is_err());
        assert!(add_files(&mut conn, "nope", &[]).is_err());
        assert!(!bucket_exists(&conn, "nope").unwrap());
    }

    // ---------------------------------------------------------------- staleness

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
        let dir = std::env::temp_dir().join(format!("vterm-idx-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    fn register(conn: &mut Connection, bucket: &str, path: &std::path::Path) -> String {
        let md = std::fs::metadata(path).unwrap();
        let found = Found {
            path: path.to_path_buf(),
            name: path.file_name().unwrap().to_string_lossy().to_string(),
            media_type: "text/markdown".into(),
            size_bytes: md.len(),
            mtime_ms: md
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64,
        };
        add_files(conn, bucket, &[found]).unwrap();
        list_files(conn, bucket)
            .unwrap()
            .into_iter()
            .find(|f| f.path == path.to_string_lossy())
            .unwrap()
            .id
    }

    #[test]
    fn a_deleted_source_becomes_missing_and_keeps_its_chunks() {
        let t = tmp("missing");
        let path = t.0.join("gone.md");
        std::fs::write(&path, "content that was indexed").unwrap();

        let mut conn = db();
        let bucket = create_bucket(&conn, "B", ChunkSpec::default()).unwrap();
        let file = register(&mut conn, &bucket, &path);
        put_text(&mut conn, &file, &plain("content that was indexed"), 24, 1).unwrap();

        std::fs::remove_file(&path).unwrap();
        assert_eq!(refresh_states(&conn, &bucket).unwrap(), 1);

        let row = &list_files(&conn, &bucket).unwrap()[0];
        assert_eq!(row.state, state::MISSING);
        assert!(row.state_reason.is_some(), "the user must be told why");
        assert_eq!(row.chunk_count, 1, "chunks survive a vanished source");
        assert_eq!(
            super::super::search::search_bm25(&conn, &[bucket], "indexed", 5)
                .unwrap()
                .len(),
            1,
            "the text is still the best answer available"
        );
    }

    #[test]
    fn an_edited_source_becomes_stale() {
        let t = tmp("stale");
        let path = t.0.join("edited.md");
        std::fs::write(&path, "first version").unwrap();

        let mut conn = db();
        let bucket = create_bucket(&conn, "B", ChunkSpec::default()).unwrap();
        let file = register(&mut conn, &bucket, &path);
        put_text(&mut conn, &file, &plain("first version"), 13, 1).unwrap();
        // put_text stamped the row from its arguments; re-sync to what is on disk so
        // the test measures the EDIT rather than that bookkeeping.
        let md = std::fs::metadata(&path).unwrap();
        conn.execute(
            "UPDATE doc_files SET size_bytes = ?2, mtime_ms = ?3 WHERE id = ?1",
            params![
                file,
                md.len() as i64,
                md.modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
            ],
        )
        .unwrap();
        assert_eq!(
            refresh_states(&conn, &bucket).unwrap(),
            0,
            "nothing changed yet"
        );

        std::fs::write(&path, "a materially longer second version").unwrap();
        assert_eq!(refresh_states(&conn, &bucket).unwrap(), 1);
        assert_eq!(list_files(&conn, &bucket).unwrap()[0].state, state::STALE);

        // And a stale file is what the indexing loop picks up next.
        let work = files_needing_work(&conn, &bucket, 10).unwrap();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].id, file);
    }

    #[test]
    fn a_pending_file_is_never_flagged_stale() {
        let t = tmp("pending");
        let path = t.0.join("new.md");
        std::fs::write(&path, "never indexed").unwrap();

        let mut conn = db();
        let bucket = create_bucket(&conn, "B", ChunkSpec::default()).unwrap();
        register(&mut conn, &bucket, &path);
        assert_eq!(refresh_states(&conn, &bucket).unwrap(), 0);
        assert_eq!(list_files(&conn, &bucket).unwrap()[0].state, state::PENDING);
    }

    #[test]
    fn a_failed_file_that_reappears_is_offered_again() {
        let t = tmp("recover");
        let path = t.0.join("flaky.md");
        std::fs::write(&path, "body").unwrap();

        let mut conn = db();
        let bucket = create_bucket(&conn, "B", ChunkSpec::default()).unwrap();
        let file = register(&mut conn, &bucket, &path);
        mark_failed(&conn, &file, "the PDF was locked").unwrap();
        assert_eq!(list_files(&conn, &bucket).unwrap()[0].state, state::FAILED);

        assert_eq!(refresh_states(&conn, &bucket).unwrap(), 1);
        let row = &list_files(&conn, &bucket).unwrap()[0];
        assert_eq!(row.state, state::PENDING);
        assert_eq!(row.state_reason, None, "the stale reason must be cleared");
    }

    #[test]
    fn a_failure_reason_is_length_capped() {
        let mut conn = db();
        let (bucket, file) = one_file(&mut conn);
        mark_failed(&conn, &file, &"e".repeat(5000)).unwrap();
        let reason = list_files(&conn, &bucket).unwrap()[0]
            .state_reason
            .clone()
            .unwrap();
        assert_eq!(reason.chars().count(), 200);
    }
}
