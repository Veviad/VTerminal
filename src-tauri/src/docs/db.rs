//! `docs.db` — the document-bucket index, deliberately a SEPARATE database file
//! from `veviad-shell.db`.
//!
//! The split is about asymmetric value, not about size. `veviad-shell.db` holds
//! command history, saved hosts, session snapshots and archived transcripts: small,
//! and unrecreatable if lost. Everything here is large (hundreds of MB of f32
//! vectors at a realistic corpus) and fully regenerable from the source files on
//! disk. Keeping them in one file would mean every copy of the precious data drags
//! the disposable data along, `VACUUM` on the user's history becomes an expensive
//! operation, and a corrupt embedding blob shares a file with the only copy of
//! their command history. Nothing in this schema references a session row, so
//! there is no join to give up — and "forget everything I indexed" becomes one
//! `remove_file` instead of a careful multi-table delete.
//!
//! It is also opened LAZILY. `docs_enabled` defaults to false, and until a command
//! actually runs, this file does not exist: a default install pays nothing, not
//! even a migration.

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const DOCS_DB_FILE: &str = "docs.db";

/// Lazily-opened handle to `docs.db`.
///
/// `Option` is the laziness: unlike `DbState`, which is opened during `setup` and
/// is always present, this stays `None` until the first `docs_*` command runs. That
/// is what keeps a default (flag-off) install free of the file entirely.
pub struct DocsDb {
    inner: Mutex<Option<Connection>>,
    app_data_dir: PathBuf,
}

impl DocsDb {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(None),
            app_data_dir,
        }
    }

    /// Run `f` against the open connection, opening and migrating it first if this
    /// is the first call.
    ///
    /// A closure rather than a returned guard because the `Option` has to be
    /// populated under the same lock that hands out the reference, and because
    /// `&mut Connection` covers both plain queries and `conn.transaction()` — the
    /// re-index path needs the latter.
    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|_| "docs db poisoned")?;
        if guard.is_none() {
            register_sqlite_vec();
            let conn = crate::database::open_hardened(&self.app_data_dir, DOCS_DB_FILE)?;
            migrate(&conn)?;
            *guard = Some(conn);
        }
        let conn = guard.as_mut().expect("just populated");
        f(conn)
    }

    /// Whether the file exists on disk, without opening it.
    ///
    /// Used by the Settings UI to say "nothing indexed yet" honestly, and by tests
    /// asserting that a flag-off install creates nothing.
    pub fn exists(&self) -> bool {
        self.app_data_dir.join(DOCS_DB_FILE).exists()
    }

    /// Close the connection and delete the file, bucket data and all.
    ///
    /// The whole point of a separate database: this is the complete "forget my
    /// documents" operation, and it cannot touch anything the user cannot recreate.
    pub fn destroy(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|_| "docs db poisoned")?;
        *guard = None; // drop the Connection before unlinking
        let base = self.app_data_dir.join(DOCS_DB_FILE);
        for suffix in ["", "-wal", "-shm"] {
            let mut path = base.as_os_str().to_owned();
            path.push(suffix);
            let path = Path::new(&path);
            if path.exists() {
                std::fs::remove_file(path).map_err(|e| format!("remove {path:?}: {e}"))?;
            }
        }
        Ok(())
    }
}

/// Register the statically linked sqlite-vec entry point once, before opening the
/// first docs connection. `sqlite3_auto_extension` copies the function pointer and
/// invokes it for subsequent connections; the symbol lives for the process lifetime.
pub(crate) fn register_sqlite_vec() {
    static REGISTER: std::sync::Once = std::sync::Once::new();
    REGISTER.call_once(|| unsafe {
        type ExtensionEntry = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut std::os::raw::c_char,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> std::os::raw::c_int;
        let entry = std::mem::transmute::<*const (), ExtensionEntry>(
            sqlite_vec::sqlite3_vec_init as *const (),
        );
        rusqlite::ffi::sqlite3_auto_extension(Some(entry));
    });
}

// APPEND-ONLY, for the same reason `database::migrations` is: once a migration has
// run anywhere, editing it is a no-op for every database that already recorded its
// version. Add a `migrate_vN` instead.
//
// This chain is INDEPENDENT of `veviad-shell.db`'s. Both files carry their own
// `schema_version` table, and the two version numbers are unrelated — v1 here is
// not v1 there.
pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);")
        .map_err(|e| e.to_string())?;

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    if version < 3 {
        migrate_v3(conn)?;
    }
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }

    Ok(())
}

/// Add the durable knowledge-layer state without changing existing keyword buckets.
///
/// Profiles are stored as canonical JSON rather than split over columns because the
/// fingerprint covers provider-specific semantics (pooling, prefixes, revisions and
/// normalization), and those fields do not have one useful relational shape.  The
/// searchable columns stay on `doc_buckets`; the JSON is the immutable audit record.
fn migrate_v3(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;

        ALTER TABLE doc_buckets ADD COLUMN embedding_profile_id TEXT;
        ALTER TABLE doc_buckets ADD COLUMN embedding_fingerprint TEXT;
        ALTER TABLE doc_buckets ADD COLUMN embedding_state TEXT NOT NULL DEFAULT 'keyword'
            CHECK (embedding_state IN ('keyword','pending','ready','failed'));
        ALTER TABLE doc_buckets ADD COLUMN embedding_error TEXT;

        CREATE TABLE knowledge_embedding_profiles (
            id               TEXT PRIMARY KEY,
            fingerprint      TEXT NOT NULL UNIQUE,
            profile_json     TEXT NOT NULL,
            created_at       INTEGER NOT NULL,
            last_verified_at INTEGER,
            status           TEXT NOT NULL DEFAULT 'ready'
                             CHECK (status IN ('ready','unavailable','needs_key','failed')),
            error            TEXT
        );

        -- A local binding is enough to make an existing, unmarked Qdrant collection
        -- reproducible without mutating that external collection during discovery.
        CREATE TABLE knowledge_qdrant_bindings (
            connection_id       TEXT NOT NULL,
            collection_name     TEXT NOT NULL,
            profile_id          TEXT NOT NULL,
            vector_name         TEXT,
            payload_mapping_json TEXT NOT NULL,
            ownership           TEXT NOT NULL DEFAULT 'external'
                                CHECK (ownership IN ('exclusive','external')),
            compatibility       TEXT NOT NULL DEFAULT 'attach_only',
            updated_at          INTEGER NOT NULL,
            PRIMARY KEY (connection_id, collection_name)
        );

        -- Jobs survive closing Settings or restarting the app. `payload_json` holds
        -- only resumable, non-secret inputs; credentials are resolved by id at run time.
        CREATE TABLE knowledge_jobs (
            id              TEXT PRIMARY KEY,
            kind            TEXT NOT NULL,
            target_ref_json TEXT NOT NULL,
            payload_json    TEXT NOT NULL,
            stage           TEXT NOT NULL,
            status          TEXT NOT NULL
                            CHECK (status IN ('queued','running','completed','failed','cancelled')),
            completed_items INTEGER NOT NULL DEFAULT 0,
            total_items     INTEGER,
            error           TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE INDEX idx_knowledge_jobs_status ON knowledge_jobs(status, updated_at);

        INSERT INTO schema_version (version) VALUES (3);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("docs migrate v3: {e}"))
}

/// Serialize durable work per bucket/document and add an acknowledged
/// cancellation state. Rebuilding this small metadata table is required because
/// SQLite cannot extend an existing CHECK constraint in place.
fn migrate_v4(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;

        ALTER TABLE knowledge_jobs RENAME TO knowledge_jobs_v3;
        CREATE TABLE knowledge_jobs (
            id              TEXT PRIMARY KEY,
            kind            TEXT NOT NULL,
            target_ref_json TEXT NOT NULL,
            payload_json    TEXT NOT NULL,
            resource_key    TEXT,
            stage           TEXT NOT NULL,
            status          TEXT NOT NULL
                            CHECK (status IN ('queued','running','completed','failed','cancelling','cancelled')),
            completed_items INTEGER NOT NULL DEFAULT 0,
            total_items     INTEGER,
            error           TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        INSERT INTO knowledge_jobs
            (id,kind,target_ref_json,payload_json,resource_key,stage,status,
             completed_items,total_items,error,created_at,updated_at)
        SELECT id,kind,target_ref_json,payload_json,NULL,stage,
               CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,
               completed_items,total_items,
               CASE
                 WHEN status IN ('queued','running')
                 THEN 'Knowledge job storage was upgraded while this job was active. Retry the job to resume safely.'
                 ELSE error
               END,
               created_at,updated_at
          FROM knowledge_jobs_v3;
        DROP TABLE knowledge_jobs_v3;
        CREATE INDEX idx_knowledge_jobs_status ON knowledge_jobs(status, updated_at);
        CREATE UNIQUE INDEX idx_knowledge_jobs_active_resource
            ON knowledge_jobs(resource_key)
         WHERE resource_key IS NOT NULL
           AND status IN ('queued','running','cancelling');

        INSERT INTO schema_version (version) VALUES (4);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("docs migrate v4: {e}"))
}

/// Retain a small, safe label outside the resumable payload. Successful jobs can
/// then discard extracted document text while failed/cancelled jobs keep it for
/// Retry without asking the user to select the source file again.
fn migrate_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;

        ALTER TABLE knowledge_jobs ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Knowledge job';
        UPDATE knowledge_jobs
           SET display_name=CASE
             WHEN kind='document_ingest' AND json_valid(payload_json)
             THEN COALESCE(NULLIF(substr(json_extract(payload_json, '$.document.title'), 1, 512), ''), 'Knowledge job')
             WHEN kind='bucket_embed' AND json_valid(payload_json)
             THEN 'Semantic search · ' || COALESCE(NULLIF(substr(json_extract(payload_json, '$.bucket_id'), 1, 480), ''), 'Local bucket')
             ELSE 'Knowledge job'
           END;
        UPDATE knowledge_jobs SET payload_json='{}' WHERE status='completed';

        INSERT INTO schema_version (version) VALUES (5);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("docs migrate v5: {e}"))
}

fn migrate_v1(conn: &Connection) -> Result<(), String> {
    // Single transaction including the schema_version bump: a crash mid-way must
    // not leave half-created tables that brick every later startup.
    conn.execute_batch(
        r#"
        BEGIN;

        CREATE TABLE doc_buckets (
            id             TEXT PRIMARY KEY,
            label          TEXT NOT NULL,
            created_at     INTEGER NOT NULL,
            indexed_at     INTEGER,
            -- NULL = a keyword-only bucket. Stage 1 leaves both NULL; stage 2
            -- stamps them so a later model change is DETECTABLE. Two embedding
            -- models are two different vector spaces, and mixing them returns
            -- plausible garbage with no error anywhere.
            embed_model_id TEXT,
            embed_dim      INTEGER,
            -- Pinned per bucket at index time rather than read from a constant, so
            -- re-indexing one file years later produces chunks that line up with
            -- its neighbours instead of silently re-segmenting to a new default.
            chunk_chars    INTEGER NOT NULL,
            chunk_overlap  INTEGER NOT NULL
        );

        CREATE TABLE doc_roots (
            bucket_id TEXT NOT NULL REFERENCES doc_buckets(id) ON DELETE CASCADE,
            path      TEXT NOT NULL,
            PRIMARY KEY (bucket_id, path)
        );

        CREATE TABLE doc_files (
            id           TEXT PRIMARY KEY,
            bucket_id    TEXT NOT NULL REFERENCES doc_buckets(id) ON DELETE CASCADE,
            path         TEXT NOT NULL,
            name         TEXT NOT NULL,
            media_type   TEXT NOT NULL,
            size_bytes   INTEGER NOT NULL,
            mtime_ms     INTEGER NOT NULL,
            -- Of the EXTRACTED text, not the raw bytes: it is what decides whether
            -- a re-index has anything to do. A PDF rewritten by a different
            -- producer can have identical text and should cost nothing.
            text_sha256  TEXT,
            state        TEXT NOT NULL
                           CHECK (state IN ('pending','indexed','stale','missing','failed')),
            state_reason TEXT,
            page_count   INTEGER,
            chunk_count  INTEGER NOT NULL DEFAULT 0,
            indexed_at   INTEGER
        );
        CREATE UNIQUE INDEX idx_doc_files_path ON doc_files(bucket_id, path);
        CREATE INDEX idx_doc_files_state ON doc_files(bucket_id, state);

        CREATE TABLE doc_chunks (
            id          INTEGER PRIMARY KEY,
            file_id     TEXT NOT NULL REFERENCES doc_files(id) ON DELETE CASCADE,
            bucket_id   TEXT NOT NULL REFERENCES doc_buckets(id) ON DELETE CASCADE,
            ord         INTEGER NOT NULL,
            page        INTEGER,
            heading     TEXT,
            text        TEXT NOT NULL,
            text_sha256 TEXT NOT NULL,
            -- Little-endian f32, length = embed_dim * 4, L2-NORMALIZED at insert so
            -- cosine similarity reduces to a plain dot product at query time.
            -- NULL until stage 2 populates it.
            embedding   BLOB
        );
        CREATE UNIQUE INDEX idx_doc_chunks_ord ON doc_chunks(file_id, ord);
        CREATE INDEX idx_doc_chunks_bucket ON doc_chunks(bucket_id);

        -- External-content FTS5: the text lives once, in doc_chunks. A plain fts5
        -- table would duplicate every byte, and `content=` avoids that at the cost
        -- of needing the three triggers below to keep the index in step.
        --
        -- remove_diacritics 2 is load-bearing for German sources: without it
        -- "Ruckgangig" does not match "Rückgängig". Version 2 (not 1) also folds
        -- diacritics that Unicode encodes as separate codepoints.
        CREATE VIRTUAL TABLE doc_chunks_fts USING fts5(
            text,
            content='doc_chunks',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
            INSERT INTO doc_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
            INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text)
                VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
            INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text)
                VALUES ('delete', old.id, old.text);
            INSERT INTO doc_chunks_fts(rowid, text) VALUES (new.id, new.text);
        END;

        INSERT INTO schema_version (version) VALUES (1);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("docs migrate v1: {e}"))
}

/// Add Porter stemming to the full-text index.
///
/// Measured against a real 25-page document: asked *"what discounts are available for
/// longer commitments"*, the plain `unicode61` index returned filler while the passage
/// that actually answers it — "the annual discount is approximately 17%" — never surfaced.
/// Stemming `discounts → discount` puts it first. (A stopword-removal hypothesis was
/// tested first and disproved: BM25's IDF already discounts common words, and results were
/// byte-identical.)
///
/// A new migration rather than an edit to v1, because v1 has already run — the same
/// append-only rule `database::migrations` documents. The FTS table is dropped and rebuilt
/// from `doc_chunks`, which is cheap and needs no re-extraction: `content='doc_chunks'`
/// means the index never held the text in the first place. The three triggers live on
/// `doc_chunks` and refer to the FTS table by name, so they survive the swap untouched.
///
/// **Porter stems English only.** It is a no-op on German text rather than a hazard, so
/// this is an improvement for English sources and neutral for others. Genuine
/// multilingual stemming is not something FTS5 offers.
fn migrate_v2(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;

        DROP TABLE IF EXISTS doc_chunks_fts;
        CREATE VIRTUAL TABLE doc_chunks_fts USING fts5(
            text,
            content='doc_chunks',
            content_rowid='id',
            tokenize='porter unicode61 remove_diacritics 2'
        );
        INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES ('rebuild');

        INSERT INTO schema_version (version) VALUES (2);
        COMMIT;
        "#,
    )
    .map_err(|e| format!("docs migrate v2: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The head version, asserted so adding a migration forces this to be updated
    /// alongside it.
    const HEAD: i64 = 5;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        migrate(&conn).expect("migrate");
        conn
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn bucket(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO doc_buckets (id, label, created_at, chunk_chars, chunk_overlap)
             VALUES (?1, 'B', 0, 1000, 150)",
            [id],
        )
        .unwrap();
    }

    fn file(conn: &Connection, id: &str, bucket_id: &str, path: &str) {
        conn.execute(
            "INSERT INTO doc_files
               (id, bucket_id, path, name, media_type, size_bytes, mtime_ms, state)
             VALUES (?1, ?2, ?3, 'n', 'text/plain', 1, 0, 'indexed')",
            [id, bucket_id, path],
        )
        .unwrap();
    }

    fn chunk(conn: &Connection, file_id: &str, bucket_id: &str, ord: i64, text: &str) {
        conn.execute(
            "INSERT INTO doc_chunks (file_id, bucket_id, ord, text, text_sha256)
             VALUES (?1, ?2, ?3, ?4, 'h')",
            rusqlite::params![file_id, bucket_id, ord, text],
        )
        .unwrap();
    }

    fn fts_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM doc_chunks_fts", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn migrate_reaches_head_and_is_idempotent() {
        let conn = mem();
        assert_eq!(version(&conn), HEAD);
        migrate(&conn).expect("second run");
        migrate(&conn).expect("third run");
        assert_eq!(version(&conn), HEAD);
    }

    #[test]
    fn v4_marks_legacy_active_jobs_failed_instead_of_resuming_them_unlocked() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE schema_version (version INTEGER PRIMARY KEY);",
        )
        .unwrap();
        migrate_v1(&conn).unwrap();
        migrate_v2(&conn).unwrap();
        migrate_v3(&conn).unwrap();
        conn.execute(
            "INSERT INTO knowledge_jobs
               (id,kind,target_ref_json,payload_json,stage,status,created_at,updated_at)
             VALUES (?1,'document_ingest','{}','{}','embed',?2,1,1)",
            rusqlite::params!["running-job", "running"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO knowledge_jobs
               (id,kind,target_ref_json,payload_json,stage,status,created_at,updated_at)
             VALUES (?1,'document_ingest','{}','{}','done',?2,1,1)",
            rusqlite::params!["completed-job", "completed"],
        )
        .unwrap();

        migrate_v4(&conn).unwrap();

        let (status, error, resource_key): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT status,error,resource_key FROM knowledge_jobs WHERE id='running-job'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert!(error.unwrap().contains("Retry"));
        assert!(resource_key.is_none());
        let completed: String = conn
            .query_row(
                "SELECT status FROM knowledge_jobs WHERE id='completed-job'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(completed, "completed");
    }

    #[test]
    fn v5_retains_a_safe_name_and_compacts_completed_payloads() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE schema_version (version INTEGER PRIMARY KEY);",
        )
        .unwrap();
        migrate_v1(&conn).unwrap();
        migrate_v2(&conn).unwrap();
        migrate_v3(&conn).unwrap();
        migrate_v4(&conn).unwrap();
        conn.execute(
            "INSERT INTO knowledge_jobs
               (id,kind,target_ref_json,payload_json,stage,status,created_at,updated_at)
             VALUES ('done','document_ingest','{}',?1,'upload','completed',1,1)",
            [r#"{"document":{"title":"Guide"},"pages":[{"text":"private text"}]}"#],
        )
        .unwrap();

        migrate_v5(&conn).unwrap();
        let (name, payload): (String, String) = conn
            .query_row(
                "SELECT display_name,payload_json FROM knowledge_jobs WHERE id='done'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Guide");
        assert_eq!(payload, "{}");
    }

    /// The whole delete story. Chunks cascade from the file, and the FTS rows go
    /// with them via the trigger — nothing here needs an index rebuild, which is
    /// the reason brute-force cosine was chosen over an HNSW store in the first
    /// place. If the trigger were missing, the FTS table would keep returning
    /// rowids whose content row no longer exists.
    #[test]
    fn deleting_a_file_cascades_to_chunks_and_fts() {
        let conn = mem();
        bucket(&conn, "b1");
        file(&conn, "f1", "b1", "/tmp/a.md");
        chunk(&conn, "f1", "b1", 0, "rolling back a release");
        chunk(&conn, "f1", "b1", 1, "reverting a deploy");
        assert_eq!(fts_count(&conn), 2);

        conn.execute("DELETE FROM doc_files WHERE id = 'f1'", [])
            .unwrap();

        let chunks: i64 = conn
            .query_row("SELECT count(*) FROM doc_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chunks, 0, "chunks must cascade from the file");
        assert_eq!(fts_count(&conn), 0, "FTS rows must go with the chunks");
    }

    #[test]
    fn deleting_a_bucket_cascades_to_files_roots_and_chunks() {
        let conn = mem();
        bucket(&conn, "b1");
        conn.execute(
            "INSERT INTO doc_roots (bucket_id, path) VALUES ('b1', '/tmp/docs')",
            [],
        )
        .unwrap();
        file(&conn, "f1", "b1", "/tmp/a.md");
        chunk(&conn, "f1", "b1", 0, "text");

        conn.execute("DELETE FROM doc_buckets WHERE id = 'b1'", [])
            .unwrap();

        for (table, sql) in [
            ("doc_files", "SELECT count(*) FROM doc_files"),
            ("doc_chunks", "SELECT count(*) FROM doc_chunks"),
            ("doc_roots", "SELECT count(*) FROM doc_roots"),
        ] {
            let n: i64 = conn.query_row(sql, [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0, "{table} must cascade from the bucket");
        }
        assert_eq!(fts_count(&conn), 0);
    }

    /// The v2 payoff, in the form the real document exposed: a query in the plural must
    /// find text in the singular. Without stemming this returns nothing at all.
    #[test]
    fn fts_matches_across_word_forms() {
        let conn = mem();
        bucket(&conn, "b1");
        file(&conn, "f1", "b1", "/docs/pricing.md");
        chunk(
            &conn,
            "f1",
            "b1",
            0,
            "The annual discount is approximately 17% below paying monthly.",
        );

        // Regular inflections only. Porter is a suffix stemmer, not a lemmatizer: it maps
        // "paying" to "pai" and "paid" to "paid", so irregular verbs do NOT unify. Worth
        // knowing before promising more than stemming delivers.
        for query in ["discounts", "discounting", "approximate", "monthly"] {
            let hits: i64 = conn
                .query_row(
                    "SELECT count(*) FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?1",
                    [query],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(hits, 1, "{query:?} should stem onto the indexed text");
        }
    }

    /// Stemming must not turn the index into a thesaurus: two words that merely share a
    /// prefix have different stems and must stay distinct, or every query starts matching
    /// everything and BM25 has nothing left to rank on.
    #[test]
    fn stemming_does_not_collapse_unrelated_words() {
        let conn = mem();
        bucket(&conn, "b1");
        file(&conn, "f1", "b1", "/docs/a.md");
        chunk(
            &conn,
            "f1",
            "b1",
            0,
            "the discount applies to annual billing",
        );

        for query in ["discourse", "disco", "annals"] {
            let hits: i64 = conn
                .query_row(
                    "SELECT count(*) FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?1",
                    [query],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(hits, 0, "{query:?} must not match");
        }
    }

    /// The upgrade path that actually matters: a database already at v1 with rows in it —
    /// which is what every install that enabled the feature before v2 has on disk. The
    /// index must be rebuilt from `doc_chunks` (so nothing needs re-extracting) and the
    /// triggers must survive the table swap, since they live on `doc_chunks` and refer to
    /// the FTS table by name.
    #[test]
    fn upgrading_a_populated_v1_database_rebuilds_and_keeps_triggers() {
        let conn = Connection::open_in_memory().unwrap();
        // `migrate` owns the version table, so standing a v1-only database up by hand
        // means creating it first — the migrations themselves only append their row.
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
        )
        .unwrap();
        migrate_v1(&conn).expect("v1");
        assert_eq!(version(&conn), 1);

        bucket(&conn, "b1");
        file(&conn, "f1", "b1", "/docs/a.md");
        chunk(&conn, "f1", "b1", 0, "annual discount of 17 percent");
        // v1's tokenizer cannot stem, so the plural finds nothing yet.
        let before: i64 = conn
            .query_row(
                "SELECT count(*) FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'discounts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, 0, "v1 should not match across word forms");

        migrate(&conn).expect("upgrade to head");
        assert_eq!(version(&conn), HEAD);

        // Rebuilt from the existing rows — no re-extraction, and now stemming.
        assert_eq!(fts_count(&conn), 1);
        let after: i64 = conn
            .query_row(
                "SELECT count(*) FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'discounts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 1, "v2 must match across word forms");

        // The triggers still maintain the NEW table: insert and delete after the swap.
        chunk(&conn, "f1", "b1", 1, "rollback procedure for a release");
        assert_eq!(
            fts_count(&conn),
            2,
            "AFTER INSERT trigger survived the swap"
        );
        conn.execute("DELETE FROM doc_chunks WHERE ord = 1", [])
            .unwrap();
        assert_eq!(
            fts_count(&conn),
            1,
            "AFTER DELETE trigger survived the swap"
        );

        conn.execute_batch("INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('integrity-check');")
            .expect("index must agree with its content table after the swap");
    }

    /// FTS5 search works through the external-content join, and the German case
    /// the `remove_diacritics 2` tokenizer option exists for.
    #[test]
    fn fts_matches_across_diacritics() {
        let conn = mem();
        bucket(&conn, "b1");
        file(&conn, "f1", "b1", "/tmp/de.md");
        chunk(
            &conn,
            "f1",
            "b1",
            0,
            "Rückgängig machen einer Bereitstellung",
        );

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'ruckgangig'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "an unaccented query must match accented text");
    }

    /// A re-index replaces a file's chunks wholesale. Asserting no orphans is what
    /// catches a future refactor that deletes by `bucket_id` and forgets `ord`
    /// uniqueness, or that leaves the FTS index describing the old text.
    #[test]
    fn reindex_replaces_chunks_without_orphans() {
        let conn = mem();
        bucket(&conn, "b1");
        file(&conn, "f1", "b1", "/tmp/a.md");
        chunk(&conn, "f1", "b1", 0, "the old paragraph");

        conn.execute("DELETE FROM doc_chunks WHERE file_id = 'f1'", [])
            .unwrap();
        chunk(&conn, "f1", "b1", 0, "the new paragraph");

        let n: i64 = conn
            .query_row("SELECT count(*) FROM doc_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert_eq!(fts_count(&conn), 1, "the stale FTS row must be gone");

        let stale: i64 = conn
            .query_row(
                "SELECT count(*) FROM doc_chunks_fts WHERE doc_chunks_fts MATCH 'old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "FTS must not still describe the replaced text");
    }

    #[test]
    fn state_is_constrained_to_the_known_set() {
        let conn = mem();
        bucket(&conn, "b1");
        let bad = conn.execute(
            "INSERT INTO doc_files
               (id, bucket_id, path, name, media_type, size_bytes, mtime_ms, state)
             VALUES ('f9', 'b1', '/tmp/x', 'x', 'text/plain', 1, 0, 'indexing')",
            [],
        );
        assert!(
            bad.is_err(),
            "an unknown state must be rejected by the CHECK"
        );
    }

    /// One file cannot be in one bucket twice, but the same file MAY be in two
    /// buckets — a runbook that belongs to both "infra" and "onboarding" should not
    /// force a copy.
    #[test]
    fn a_path_is_unique_per_bucket_not_globally() {
        let conn = mem();
        bucket(&conn, "b1");
        bucket(&conn, "b2");
        file(&conn, "f1", "b1", "/tmp/shared.md");
        file(&conn, "f2", "b2", "/tmp/shared.md");

        let dup = conn.execute(
            "INSERT INTO doc_files
               (id, bucket_id, path, name, media_type, size_bytes, mtime_ms, state)
             VALUES ('f3', 'b1', '/tmp/shared.md', 'n', 'text/plain', 1, 0, 'pending')",
            [],
        );
        assert!(
            dup.is_err(),
            "the same path twice in one bucket must be rejected"
        );
    }
}
