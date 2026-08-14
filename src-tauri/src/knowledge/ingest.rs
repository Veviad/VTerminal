//! Durable document ingestion shared by local SQLite and managed Qdrant buckets.
//!
//! The UI extracts text (and performs OCR where available); this module owns every
//! reproducibility-sensitive step after that boundary: deterministic chunking,
//! exact-profile embedding, canonical local vector writes, and staged Qdrant
//! revision activation. Job payloads intentionally contain extracted text but never
//! original binaries or credentials, which makes retry possible after an app restart.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, Wry};

use super::embedding::{
    embed_http_batch, EmbeddedBatch, EmbeddingEndpoint, EmbeddingInput, EmbeddingProfile,
    EmbeddingProviderDialect, EmbeddingPurpose,
};
use super::qdrant::{QdrantClient, QdrantEndpoint, QdrantError};
use super::store;
use super::types::{DocumentChunk, DocumentManifest, DocumentState, KnowledgeBucketRef};
use crate::docs::chunk::{self, ChunkSpec, SourcePage};
use crate::docs::{index, semantic};

const EMBEDDING_BATCH_SIZE: usize = 32;
const MAX_PAGES: usize = 20_000;
const MAX_EXTRACTED_BYTES: usize = 128 * 1024 * 1024;
const JOB_UPDATED_EVENT: &str = "knowledge-job-updated";

struct ResolvedHttpEmbedding {
    endpoint: EmbeddingEndpoint,
    client: reqwest::Client,
}

/// A credential-bearing HTTP endpoint belongs to one ingestion execution. It
/// is resolved lazily on the first batch, then both success and failure are
/// retained for the remaining batches and dropped when the job returns.
#[derive(Default)]
struct EmbeddingJobContext {
    profile_fingerprint: Option<String>,
    resolved_http: Option<Result<ResolvedHttpEmbedding, String>>,
}

impl EmbeddingJobContext {
    fn resolve_http_with(
        &mut self,
        profile: &EmbeddingProfile,
        resolve: impl FnOnce() -> Result<(String, Option<crate::credentials::Secret>), String>,
    ) -> Result<&ResolvedHttpEmbedding, String> {
        if self
            .profile_fingerprint
            .as_deref()
            .is_some_and(|fingerprint| fingerprint != profile.fingerprint())
        {
            return Err(
                "an ingestion embedding context cannot be reused for another profile".into(),
            );
        }
        if self.resolved_http.is_none() {
            self.profile_fingerprint = Some(profile.fingerprint().to_string());
            self.resolved_http = Some(resolve().and_then(|(base_url, api_key)| {
                let endpoint =
                    EmbeddingEndpoint::new(base_url, api_key).map_err(|error| error.to_string())?;
                let client = reqwest::Client::builder()
                    .connect_timeout(std::time::Duration::from_secs(8))
                    .timeout(std::time::Duration::from_secs(120))
                    .build()
                    .map_err(|error| format!("create embedding HTTP client: {error}"))?;
                Ok(ResolvedHttpEmbedding { endpoint, client })
            }));
        }
        match self
            .resolved_http
            .as_ref()
            .expect("embedding context was initialized")
        {
            Ok(resolved) => Ok(resolved),
            Err(error) => Err(error.clone()),
        }
    }
}

/// Per-application runner coordination. The operating-system writer lock still
/// serializes each desktop app with the standalone CLI, while this state prevents
/// a burst of file selections from spawning one waiter per file. Keeping it in
/// Tauri state avoids one app/runtime suppressing a different app instance in the
/// same process (notably integration tests).
#[derive(Default)]
pub struct KnowledgeJobRunnerState {
    active: AtomicBool,
}

struct JobRunnerLease {
    app: tauri::AppHandle<Wry>,
    released: bool,
}

impl JobRunnerLease {
    fn new(app: tauri::AppHandle<Wry>) -> Self {
        Self {
            app,
            released: false,
        }
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        if let Some(state) = self.app.try_state::<KnowledgeJobRunnerState>() {
            state.active.store(false, Ordering::Release);
        }
        self.released = true;
    }
}

impl Drop for JobRunnerLease {
    fn drop(&mut self) {
        self.release();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestPage {
    pub page: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestDocument {
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    #[serde(default)]
    pub mtime_ms: Option<i64>,
}

/// Transport-neutral request used by the bundled CLI. The desktop IPC keeps the
/// more explicit `(bucket, document, pages)` envelope, while both converge on the
/// same durable job and ingestion contract.
#[derive(Debug, Clone)]
pub struct IngestRequest {
    pub bucket: KnowledgeBucketRef,
    pub document_id: Option<String>,
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    pub pages: Vec<SourcePage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct HeadlessSettings {
    #[serde(default)]
    connections: Vec<store::QdrantConnectionRecord>,
    models_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestJobPayload {
    pub document: IngestDocument,
    pub pages: Vec<IngestPage>,
    /// Filled before the first remote upload and retained across retries so the
    /// same job always targets the same deterministic Qdrant point ids.
    #[serde(default)]
    resolved_document_id: Option<String>,
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    prior_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalBackfillPayload {
    bucket_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JobView {
    pub id: String,
    pub kind: String,
    pub target_ref: serde_json::Value,
    pub stage: String,
    pub status: String,
    pub completed_items: u32,
    pub total_items: Option<u32>,
    pub error: Option<String>,
    pub display_name: String,
    pub queue_position: Option<u32>,
    pub waiting_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<semantic::KnowledgeJob> for JobView {
    fn from(job: semantic::KnowledgeJob) -> Self {
        let display_name = job_display_name(&job);
        let waiting_reason =
            (job.status == "queued").then(|| "Waiting for the knowledge worker".into());
        Self {
            id: job.id,
            kind: job.kind,
            target_ref: job.target_ref,
            stage: job.stage,
            status: job.status,
            completed_items: job.completed_items,
            total_items: job.total_items,
            error: job.error,
            display_name,
            queue_position: None,
            waiting_reason,
            created_at: job.created_at,
            updated_at: job.updated_at,
        }
    }
}

fn job_display_name(job: &semantic::KnowledgeJob) -> String {
    let value = job.display_name.trim();
    if value.is_empty() {
        "Knowledge job".into()
    } else {
        value.chars().take(512).collect()
    }
}

pub fn job_views(jobs: Vec<semantic::KnowledgeJob>) -> Vec<JobView> {
    let mut queued = jobs
        .iter()
        .filter(|job| job.status == "queued")
        .map(|job| (job.created_at, job.id.clone()))
        .collect::<Vec<_>>();
    queued.sort();
    let positions = queued
        .into_iter()
        .enumerate()
        .map(|(index, (_, id))| (id, (index + 1) as u32))
        .collect::<std::collections::HashMap<_, _>>();
    jobs.into_iter()
        .map(|job| {
            let mut view: JobView = job.into();
            view.queue_position = positions.get(&view.id).copied();
            view
        })
        .collect()
}

fn current_job_view(docs: &crate::docs::db::DocsDb, id: &str) -> Result<Option<JobView>, String> {
    docs.with(|connection| semantic::list_jobs(connection))
        .map(|jobs| {
            job_views(jobs)
                .into_iter()
                .find(|candidate| candidate.id == id)
        })
}

pub fn job_view(docs: &crate::docs::db::DocsDb, id: &str) -> Result<JobView, String> {
    current_job_view(docs, id)?.ok_or_else(|| "no such knowledge job".into())
}

pub fn notify_job_changed(app: &tauri::AppHandle<Wry>, docs: &crate::docs::db::DocsDb, id: &str) {
    match current_job_view(docs, id) {
        Ok(Some(view)) => {
            if let Err(error) = app.emit(JOB_UPDATED_EVENT, view) {
                log::warn!("emit knowledge job update failed: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => log::warn!("load knowledge job update failed: {error}"),
    }
}

pub fn validate_document(
    document: &mut IngestDocument,
    pages: &[IngestPage],
) -> Result<(), String> {
    document.title = clean_text_field(&document.title, "title", 512)?;
    document.source_uri = clean_text_field(&document.source_uri, "source URI", 4096)?;
    document.mime_type = clean_text_field(&document.mime_type, "MIME type", 255)?;
    document.document_id = clean_optional_id(document.document_id.take(), "document id")?;
    document.source_id = clean_optional_id(document.source_id.take(), "source id")?;
    if pages.is_empty() {
        return Err("at least one extracted page is required".into());
    }
    if pages.len() > MAX_PAGES {
        return Err(format!(
            "a document can contain at most {MAX_PAGES} extracted pages"
        ));
    }
    let bytes = pages.iter().try_fold(0usize, |total, page| {
        if page.text.chars().any(|character| character == '\0') {
            return Err("extracted text cannot contain NUL characters".to_string());
        }
        total
            .checked_add(page.text.len())
            .ok_or_else(|| "extracted document is too large".to_string())
    })?;
    if bytes == 0 || pages.iter().all(|page| page.text.trim().is_empty()) {
        return Err("the extracted document contains no text".into());
    }
    if bytes > MAX_EXTRACTED_BYTES {
        return Err(format!(
            "extracted text is {bytes} bytes; the limit is {MAX_EXTRACTED_BYTES}"
        ));
    }
    Ok(())
}

fn clean_text_field(value: &str, name: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{name} is required"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{name} cannot contain control characters"));
    }
    if value.chars().count() > max {
        return Err(format!("{name} must contain at most {max} characters"));
    }
    Ok(value.to_owned())
}

fn clean_optional_id(value: Option<String>, name: &str) -> Result<Option<String>, String> {
    value
        .map(|value| clean_text_field(&value, name, 512))
        .transpose()
}

pub fn new_ingest_job(
    bucket: &KnowledgeBucketRef,
    document: IngestDocument,
    pages: Vec<IngestPage>,
) -> Result<semantic::KnowledgeJob, String> {
    let now = semantic::now_ms();
    let resource_key = match bucket {
        KnowledgeBucketRef::Local { bucket_id } => format!("local:{bucket_id}"),
        KnowledgeBucketRef::Qdrant {
            connection_id,
            collection,
        } => {
            let source_identity = document
                .source_id
                .as_deref()
                .unwrap_or(&document.source_uri);
            let document_id = document.document_id.clone().unwrap_or_else(|| {
                stable_remote_document_id(connection_id, collection, source_identity)
            });
            remote_document_resource_key(connection_id, collection, &document_id)
        }
    };
    let display_name = document.title.clone();
    let target_ref = serde_json::to_value(bucket).map_err(|error| error.to_string())?;
    let payload = serde_json::to_value(IngestJobPayload {
        document,
        pages,
        resolved_document_id: None,
        revision: None,
        prior_revision: None,
    })
    .map_err(|error| error.to_string())?;
    Ok(semantic::KnowledgeJob {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "document_ingest".into(),
        display_name,
        target_ref,
        payload,
        resource_key: Some(resource_key),
        stage: "chunk".into(),
        status: "queued".into(),
        completed_items: 0,
        total_items: None,
        error: None,
        created_at: now,
        updated_at: now,
    })
}

/// Canonical serialization key shared by remote ingestion and document CRUD.
/// Keeping this in one helper prevents a replace and a metadata/delete operation
/// from accidentally using different lock identities for the same document.
pub fn remote_document_resource_key(
    connection_id: &str,
    collection: &str,
    document_id: &str,
) -> String {
    format!("qdrant:{connection_id}:{collection}:{document_id}")
}

/// Refuse an immediate remote document mutation while an ingestion/replacement
/// job owns that document. The caller performs no remote write when this fails.
pub fn ensure_remote_document_idle(
    docs: &crate::docs::db::DocsDb,
    connection_id: &str,
    collection: &str,
    document_id: &str,
) -> Result<(), String> {
    let resource_key = remote_document_resource_key(connection_id, collection, document_id);
    let active = docs.with(|connection| {
        connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM knowledge_jobs
                     WHERE resource_key=?1
                       AND status IN ('queued','running','cancelling')
                 )",
                [&resource_key],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())
    })?;
    if active {
        Err("this document has an active ingestion or replacement job; wait for it to finish or cancel it first".into())
    } else {
        Ok(())
    }
}

/// Retire local state which can no longer be valid after a remote collection is
/// deleted. The binding and resumable jobs are changed in one transaction so a
/// later collection with the same name cannot inherit either one.
pub fn forget_deleted_remote_collection(
    connection: &mut rusqlite::Connection,
    connection_id: &str,
    collection: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    semantic::delete_qdrant_binding(&transaction, connection_id, collection)?;
    transaction
        .execute(
            "UPDATE knowledge_jobs
                SET status='failed',
                    error='Qdrant collection was deleted; start a new ingestion job',
                    updated_at=?3
              WHERE json_extract(target_ref_json,'$.source')='qdrant'
                AND json_extract(target_ref_json,'$.connection_id')=?1
                AND json_extract(target_ref_json,'$.collection')=?2
                AND status!='completed'",
            rusqlite::params![connection_id, collection, semantic::now_ms()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn new_local_backfill_job(bucket_id: String) -> Result<semantic::KnowledgeJob, String> {
    let now = semantic::now_ms();
    let resource_key = format!("local:{bucket_id}");
    let bucket = KnowledgeBucketRef::Local {
        bucket_id: bucket_id.clone(),
    };
    Ok(semantic::KnowledgeJob {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "bucket_embed".into(),
        display_name: format!("Semantic search · {bucket_id}"),
        target_ref: serde_json::to_value(bucket).map_err(|error| error.to_string())?,
        payload: serde_json::to_value(LocalBackfillPayload { bucket_id })
            .map_err(|error| error.to_string())?,
        resource_key: Some(resource_key),
        stage: "embed".into(),
        status: "queued".into(),
        completed_items: 0,
        total_items: None,
        error: None,
        created_at: now,
        updated_at: now,
    })
}

fn persist_job(docs: &crate::docs::db::DocsDb, job: &semantic::KnowledgeJob) -> Result<(), String> {
    docs.with(|connection| semantic::put_job(connection, job))
}

fn persist_progress(
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    stage: &str,
    completed: u32,
    total: Option<u32>,
) -> Result<(), String> {
    job.stage = stage.into();
    job.status = "running".into();
    job.completed_items = completed;
    job.total_items = total;
    job.error = None;
    job.updated_at = semantic::now_ms();
    persist_job(docs, job)
}

fn persist_progress_and_notify(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    stage: &str,
    completed: u32,
    total: Option<u32>,
) -> Result<(), String> {
    persist_progress(docs, job, stage, completed, total)?;
    notify_job_changed(app, docs, &job.id);
    Ok(())
}

fn is_cancelled(docs: &crate::docs::db::DocsDb, id: &str) -> Result<bool, String> {
    docs.with(|connection| {
        let status: String = connection
            .query_row(
                "SELECT status FROM knowledge_jobs WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(matches!(status.as_str(), "cancelling" | "cancelled"))
    })
}

fn ensure_knowledge_enabled(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if crate::commands::settings::read_bool(app, "docs_enabled", false) {
        Ok(())
    } else {
        Err("knowledge is disabled; enable it in Settings and retry the job".into())
    }
}

fn claim_job(docs: &crate::docs::db::DocsDb, id: &str) -> Result<(), String> {
    docs.with(|connection| {
        let changed = connection
            .execute(
                "UPDATE knowledge_jobs SET status='running',updated_at=?2
                  WHERE id=?1 AND status='queued'",
                rusqlite::params![id, semantic::now_ms()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 1 {
            return Ok(());
        }
        let status: String = connection
            .query_row(
                "SELECT status FROM knowledge_jobs WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if status == "cancelling" {
            connection
                .execute(
                    "UPDATE knowledge_jobs SET status='cancelled',updated_at=?2 WHERE id=?1",
                    rusqlite::params![id, semantic::now_ms()],
                )
                .map_err(|error| error.to_string())?;
            Err("job cancelled before it started".into())
        } else {
            Err(format!("job is not queued (current status: {status})"))
        }
    })
}

fn finalize_job(
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    succeeded: bool,
    error: Option<&str>,
) -> Result<(), String> {
    let next_status = if succeeded { "completed" } else { "failed" };
    let next_completed = if succeeded {
        job.total_items.unwrap_or(job.completed_items)
    } else {
        job.completed_items
    };
    let next_error = error.map(|value| value.chars().take(1_000).collect::<String>());
    docs.with(|connection| {
        let changed = connection
            .execute(
                "UPDATE knowledge_jobs
                    SET status=CASE
                          WHEN status IN ('cancelling','cancelled') THEN 'cancelled'
                          WHEN status='running' THEN ?2
                          ELSE status
                        END,
                        completed_items=CASE
                          WHEN status='running' AND ?2='completed' THEN ?3
                          ELSE completed_items
                        END,
                        error=CASE
                          WHEN status IN ('cancelling','cancelled') THEN NULL
                          WHEN status='running' THEN ?4
                          ELSE error
                        END,
                        payload_json=CASE
                          WHEN status='running' AND ?2='completed' THEN '{}'
                          ELSE payload_json
                        END,
                        updated_at=?5
                  WHERE id=?1
                    AND status IN ('running','cancelling','cancelled')",
                rusqlite::params![
                    &job.id,
                    next_status,
                    next_completed,
                    next_error,
                    semantic::now_ms()
                ],
            )
            .map_err(|e| e.to_string())?;
        if changed == 1 {
            return Ok(());
        }
        let status: String = connection
            .query_row(
                "SELECT status FROM knowledge_jobs WHERE id=?1",
                [&job.id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => "no such knowledge job".into(),
                other => other.to_string(),
            })?;
        if matches!(status.as_str(), "completed" | "failed") {
            // A stale worker must never overwrite an existing terminal outcome.
            Ok(())
        } else {
            Err(format!("job cannot be finalized from status {status:?}"))
        }
    })
}

async fn run_job_locked(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
) -> Result<(), String> {
    claim_job(docs, &job.id)?;
    job.status = "running".into();
    notify_job_changed(app, docs, &job.id);
    let result = match ensure_knowledge_enabled(app) {
        Ok(()) => match job.kind.as_str() {
            "document_ingest" => run_document_ingest(app, docs, job).await,
            "bucket_embed" => run_local_backfill(app, docs, job).await,
            _ => Err(format!("unknown knowledge job kind {:?}", job.kind)),
        },
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => {
            finalize_job(docs, job, true, None)?;
            notify_job_changed(app, docs, &job.id);
            Ok(())
        }
        Err(error) => {
            // Turning Knowledge off pauses durable work. Keep the extracted text
            // queued so enabling it again can resume without asking for the file.
            if error.starts_with("knowledge is disabled;") {
                requeue_paused_job(docs, job)?;
                notify_job_changed(app, docs, &job.id);
                return Err(error);
            }
            finalize_job(docs, job, false, Some(&error))?;
            notify_job_changed(app, docs, &job.id);
            Err(error)
        }
    }
}

fn requeue_paused_job(
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
) -> Result<(), String> {
    docs.with(|connection| {
        connection
            .execute(
                "UPDATE knowledge_jobs
                    SET status=CASE WHEN status='cancelling' THEN 'cancelled' ELSE 'queued' END,
                        error=NULL,updated_at=?2
                  WHERE id=?1 AND status IN ('running','cancelling')",
                rusqlite::params![&job.id, semantic::now_ms()],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

/// Resume work which was queued or interrupted by process shutdown. Failed and
/// cancelled jobs remain user-controlled. Qdrant revision identity is already
/// persisted in the job before its first upload, so replay cannot create a second
/// active revision for the same job.
pub fn resume_pending_jobs(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if !crate::commands::settings::read_bool(app, "docs_enabled", false) {
        return Ok(());
    }
    wake_job_runner(app)
}

/// Wake the durable desktop runner after an enqueue, retry, app start, or
/// Knowledge being re-enabled. This returns before waiting for the process lock.
pub fn wake_job_runner(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if !crate::commands::settings::read_bool(app, "docs_enabled", false) {
        return Ok(());
    }
    let state = app
        .try_state::<KnowledgeJobRunnerState>()
        .ok_or_else(|| "knowledge job runner state is unavailable".to_string())?;
    if state.active.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let run_app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The lease resets `active` even if draining unwinds unexpectedly.
        let mut lease = JobRunnerLease::new(run_app.clone());
        let drained = drain_pending_jobs(&run_app).await;
        if let Err(error) = &drained {
            log::warn!("drain knowledge jobs failed: {error}");
        }
        lease.release();

        // Close the enqueue-vs-exit race: an insert can observe ACTIVE=true just
        // after the runner's final empty query. Recheck after publishing false.
        if drained.is_ok()
            && crate::commands::settings::read_bool(&run_app, "docs_enabled", false)
            && has_queued_jobs(&run_app).unwrap_or(false)
        {
            let _ = wake_job_runner(&run_app);
        }
    });
    Ok(())
}

fn has_queued_jobs(app: &tauri::AppHandle<Wry>) -> Result<bool, String> {
    let Some(docs) = app.try_state::<crate::docs::db::DocsDb>() else {
        return Ok(false);
    };
    if !docs.exists() {
        return Ok(false);
    }
    docs.with(|connection| {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM knowledge_jobs WHERE status='queued')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    })
}

/// Release durable resource keys left in `running` by an interrupted standalone
/// CLI process. The caller must already own
/// [`KnowledgeProcessLock`](super::process_lock::KnowledgeProcessLock), which is
/// what proves these rows have no live writer. Desktop startup takes a different
/// path and requeues the same rows because it has a background worker available;
/// a one-shot CLI invocation instead fails them explicitly so the requested new
/// mutation can proceed without an unrecoverable active-resource conflict.
pub fn fail_interrupted_headless_jobs(
    docs: &crate::docs::db::DocsDb,
) -> Result<Vec<String>, String> {
    docs.with(|connection| {
        let ids = {
            let mut statement = connection
                .prepare("SELECT id FROM knowledge_jobs WHERE status IN ('running','cancelling')")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        connection
            .execute(
                "UPDATE knowledge_jobs
                    SET status=CASE WHEN status='cancelling' THEN 'cancelled' ELSE 'failed' END,
                        error=CASE
                          WHEN status='cancelling' THEN NULL
                          ELSE 'The standalone CLI stopped before this job finished; run the command again to resume safely'
                        END,
                        updated_at=?1
                  WHERE status IN ('running','cancelling')",
                [semantic::now_ms()],
            )
            .map_err(|error| error.to_string())?;
        Ok(ids)
    })
}

async fn drain_pending_jobs(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    // Waiting happens only here, after IPC has returned its durable queued row.
    // Once acquired, retain ownership through recovery and the whole queue.
    let process_lock = super::process_lock::KnowledgeProcessLock::acquire(app_data).await?;
    let Some(docs) = app.try_state::<crate::docs::db::DocsDb>() else {
        drop(process_lock);
        return Ok(());
    };
    if !docs.exists() {
        drop(process_lock);
        return Ok(());
    }
    let recovered = docs.with(|connection| {
        let ids = {
            let mut statement = connection
                .prepare("SELECT id FROM knowledge_jobs WHERE status IN ('running','cancelling')")
                .map_err(|error| error.to_string())?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?;
            ids
        };
        connection
            .execute(
                "UPDATE knowledge_jobs
                    SET status=CASE WHEN status='cancelling' THEN 'cancelled' ELSE 'queued' END,
                        updated_at=?1
                  WHERE status IN ('running','cancelling')",
                [semantic::now_ms()],
            )
            .map_err(|error| error.to_string())?;
        Ok(ids)
    })?;
    for id in recovered {
        notify_job_changed(app, &docs, &id);
    }

    loop {
        if !crate::commands::settings::read_bool(app, "docs_enabled", false) {
            break;
        }
        let next = docs.with(|connection| {
            let mut queued = semantic::list_jobs(connection)?
                .into_iter()
                .filter(|job| job.status == "queued")
                .collect::<Vec<_>>();
            queued.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then_with(|| left.id.cmp(&right.id))
            });
            Ok(queued.into_iter().next())
        })?;
        let Some(mut job) = next else { break };
        if let Err(error) = run_job_locked(app, &docs, &mut job).await {
            log::warn!("knowledge job {} failed: {error}", job.id);
        }
    }
    drop(process_lock);
    Ok(())
}

async fn run_document_ingest(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
) -> Result<(), String> {
    let bucket: KnowledgeBucketRef = serde_json::from_value(job.target_ref.clone())
        .map_err(|error| format!("invalid job target: {error}"))?;
    let mut payload: IngestJobPayload = serde_json::from_value(job.payload.clone())
        .map_err(|error| format!("invalid job payload: {error}"))?;
    validate_document(&mut payload.document, &payload.pages)?;
    if is_cancelled(docs, &job.id)? {
        return Err("job cancelled".into());
    }

    match bucket {
        KnowledgeBucketRef::Local { bucket_id } => {
            ingest_local(app, docs, job, &bucket_id, payload).await
        }
        KnowledgeBucketRef::Qdrant {
            connection_id,
            collection,
        } => ingest_qdrant(app, docs, job, &connection_id, &collection, payload).await,
    }
}

async fn ingest_local(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    bucket_id: &str,
    payload: IngestJobPayload,
) -> Result<(), String> {
    persist_progress_and_notify(app, docs, job, "chunk", 0, None)?;
    let document_id = payload
        .document
        .document_id
        .clone()
        .unwrap_or_else(|| stable_local_document_id(bucket_id, &payload.document.source_uri));
    let pages = source_pages(&payload.pages);
    let chunks = docs.with(|connection| {
        if !index::bucket_exists(connection, bucket_id)? {
            return Err(format!("unknown bucket: {bucket_id}"));
        }
        let existing = index::list_files(connection, bucket_id)?
            .into_iter()
            .find(|file| file.id == document_id);
        let joined = pages
            .iter()
            .map(|page| page.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let next_sha = index::text_sha256(&joined);
        let must_reembed = if let Some(file) = &existing {
            let prior_sha: Option<String> = connection
                .query_row(
                    "SELECT text_sha256 FROM doc_files WHERE id=?1",
                    [&document_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            file.name != payload.document.title || prior_sha.as_deref() != Some(&next_sha)
        } else {
            false
        };
        if must_reembed {
            invalidate_local_document_embeddings(connection, bucket_id, &document_id)?;
        }
        if existing.is_none() {
            connection
                .execute(
                    "INSERT INTO doc_files
                       (id,bucket_id,path,name,media_type,size_bytes,mtime_ms,state)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')",
                    rusqlite::params![
                        &document_id,
                        bucket_id,
                        &payload.document.source_uri,
                        &payload.document.title,
                        &payload.document.mime_type,
                        payload.document.size_bytes.unwrap_or(0),
                        payload.document.mtime_ms.unwrap_or(0),
                    ],
                )
                .map_err(|error| error.to_string())?;
        } else {
            connection
                .execute(
                    "UPDATE doc_files SET path=?2,name=?3,media_type=?4 WHERE id=?1 AND bucket_id=?5",
                    rusqlite::params![
                        &document_id,
                        &payload.document.source_uri,
                        &payload.document.title,
                        &payload.document.mime_type,
                        bucket_id,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        index::put_text(
            connection,
            &document_id,
            &pages,
            payload.document.size_bytes.unwrap_or(0),
            payload.document.mtime_ms.unwrap_or(0),
        )?;
        Ok(index::list_files(connection, bucket_id)?
            .into_iter()
            .find(|file| file.id == document_id)
            .map(|file| file.chunk_count)
            .unwrap_or(0))
    })?;
    persist_progress_and_notify(app, docs, job, "embed", 0, Some(chunks))?;
    embed_pending_local(app, docs, job, bucket_id).await
}

async fn run_local_backfill(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
) -> Result<(), String> {
    let payload: LocalBackfillPayload = serde_json::from_value(job.payload.clone())
        .map_err(|error| format!("invalid job payload: {error}"))?;
    embed_pending_local(app, docs, job, &payload.bucket_id).await
}

async fn embed_pending_local(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    bucket_id: &str,
) -> Result<(), String> {
    let profile = local_bucket_profile(docs, bucket_id)?;
    let mut embedding = EmbeddingJobContext::default();
    let total = docs.with(|connection| {
        connection
            .query_row(
                "SELECT count(*) FROM doc_chunks WHERE bucket_id=?1 AND embedding IS NULL",
                [bucket_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u32)
            .map_err(|error| error.to_string())
    })?;
    persist_progress_and_notify(app, docs, job, "embed", 0, Some(total))?;
    let mut completed = 0u32;
    loop {
        ensure_knowledge_enabled(app)?;
        if is_cancelled(docs, &job.id)? {
            return Err("job cancelled".into());
        }
        let pending = docs.with(|connection| {
            semantic::pending_chunks(connection, bucket_id, EMBEDDING_BATCH_SIZE)
        })?;
        if pending.is_empty() {
            break;
        }
        let inputs = pending
            .iter()
            .map(|chunk| EmbeddingInput::document(&chunk.text, Some(chunk.title.clone())))
            .collect::<Vec<_>>();
        let vectors = embed_documents(app, &mut embedding, &profile, &inputs)
            .await?
            .vectors;
        let rows = pending
            .iter()
            .zip(vectors)
            .map(|(chunk, vector)| (chunk.chunk_id, vector))
            .collect::<Vec<_>>();
        docs.with(|connection| {
            semantic::put_embeddings(
                connection,
                bucket_id,
                profile.fingerprint(),
                profile.semantic().dimensions,
                &rows,
            )
        })?;
        completed = completed.saturating_add(rows.len() as u32);
        persist_progress_and_notify(app, docs, job, "embed", completed, Some(total))?;
    }
    Ok(())
}

async fn ingest_qdrant(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    connection_id: &str,
    collection: &str,
    mut payload: IngestJobPayload,
) -> Result<(), String> {
    let (client, profile) = managed_qdrant_target(app, connection_id, collection).await?;
    let mut embedding = EmbeddingJobContext::default();
    persist_progress_and_notify(app, docs, job, "chunk", 0, None)?;
    let spec = ChunkSpec::default();
    let source_pages = source_pages(&payload.pages);
    let chunks = chunk::chunk_pages(&source_pages, spec);
    if chunks.is_empty() {
        return Err("the extracted document produced no non-empty chunks".into());
    }
    let total = chunks.len() as u32;
    persist_progress_and_notify(app, docs, job, "embed", 0, Some(total))?;

    let (document_id, _old_revision, revision) =
        resolve_remote_revision(docs, job, &client, connection_id, collection, &mut payload)
            .await?;
    let already_active =
        remote_revision_already_active(&client, collection, &document_id, revision).await?;
    let content_sha256 = content_sha256(&payload.pages);
    let now = chrono::Utc::now().to_rfc3339();
    let mut embedded_chunks = Vec::with_capacity(chunks.len());
    for batch in chunks.chunks(EMBEDDING_BATCH_SIZE) {
        ensure_knowledge_enabled(app)?;
        if is_cancelled(docs, &job.id)? {
            return Err("job cancelled".into());
        }
        let inputs = batch
            .iter()
            .map(|chunk| {
                EmbeddingInput::document(&chunk.text, Some(payload.document.title.clone()))
            })
            .collect::<Vec<_>>();
        let vectors = embed_documents(app, &mut embedding, &profile, &inputs)
            .await?
            .vectors;
        for (chunk, vector) in batch.iter().zip(vectors) {
            embedded_chunks.push(DocumentChunk {
                document_id: document_id.clone(),
                source_id: payload.document.source_id.clone(),
                revision,
                state: DocumentState::Staging,
                content_sha256: content_sha256.clone(),
                chunk_index: chunk.ord,
                text: chunk.text.clone(),
                title: payload.document.title.clone(),
                source_uri: payload.document.source_uri.clone(),
                mime_type: payload.document.mime_type.clone(),
                page: chunk.page,
                heading: chunk.heading.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
                vector,
            });
        }
        persist_progress_and_notify(
            app,
            docs,
            job,
            "embed",
            embedded_chunks.len() as u32,
            Some(total),
        )?;
    }

    let manifest = DocumentManifest {
        document_id: document_id.clone(),
        source_id: payload.document.source_id,
        revision,
        state: DocumentState::Staging,
        content_sha256,
        title: payload.document.title,
        source_uri: payload.document.source_uri,
        mime_type: payload.document.mime_type,
        chunk_count: total,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    persist_progress_and_notify(app, docs, job, "upload", 0, Some(total))?;
    ensure_knowledge_enabled(app)?;
    if !already_active {
        match client
            .upsert_document(collection, &profile, &manifest, &embedded_chunks)
            .await
        {
            Ok(_) => {
                if let Err(error) = remember_point_access(app, connection_id, collection, true) {
                    log::warn!("remember Qdrant point-write access failed: {error}");
                }
            }
            Err(error @ QdrantError::Permission { .. }) => {
                if let Err(cache_error) =
                    remember_point_access(app, connection_id, collection, false)
                {
                    log::warn!("remember Qdrant read-only access failed: {cache_error}");
                }
                return Err(error.to_string());
            }
            Err(error) => {
                return Err(format!(
                    "upload the document manifest and chunks through Qdrant REST: {error}"
                ))
            }
        }
    }
    persist_progress_and_notify(app, docs, job, "upload", total, Some(total))?;

    // Activation is the commit point. Repeating every operation is safe because
    // point ids and revision filters are deterministic and Qdrant upserts replace.
    if is_cancelled(docs, &job.id)? {
        return Err("job cancelled after staging; retry will activate the same revision".into());
    }
    ensure_knowledge_enabled(app)?;
    if !already_active {
        // Another client can stage and activate while this client is embedding.
        // Re-read immediately before the commit point so an older job cannot
        // overwrite or clean up a newer revision.
        if remote_revision_already_active(&client, collection, &document_id, revision).await? {
            return Ok(());
        }
        client
            .set_document_revision_state(
                collection,
                &document_id,
                revision,
                DocumentState::Active,
                &chrono::Utc::now().to_rfc3339(),
            )
            .await
            .map_err(|error| format!("activate the document revision in Qdrant: {error}"))?;
    }
    retire_revision_if_superseded(&client, collection, &document_id, revision).await?;
    let committed_at = chrono::Utc::now().to_rfc3339();
    client
        .deactivate_other_document_revisions(collection, &document_id, revision, &committed_at)
        .await
        .map_err(|error| format!("hide lower document revisions in Qdrant: {error}"))?;
    client
        .delete_other_document_revisions(collection, &document_id, revision)
        .await
        .map_err(|error| format!("delete lower document revisions from Qdrant: {error}"))?;
    Ok(())
}

fn source_pages(pages: &[IngestPage]) -> Vec<SourcePage> {
    pages
        .iter()
        .map(|page| SourcePage {
            page: page.page,
            text: page.text.clone(),
        })
        .collect()
}

fn content_sha256(pages: &[IngestPage]) -> String {
    use std::fmt::Write;

    let mut digest = Sha256::new();
    for (index, page) in pages.iter().enumerate() {
        if index != 0 {
            digest.update(b"\n\n");
        }
        digest.update(page.text.as_bytes());
    }
    let digest = digest.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn stable_local_document_id(bucket: &str, source_uri: &str) -> String {
    stable_uuid(format!("vterminal:local:{bucket}:{source_uri}").as_bytes())
}

fn stable_remote_document_id(_connection: &str, collection: &str, source_identity: &str) -> String {
    let source = normalized_source_identity(source_identity);
    stable_uuid(format!("vterminal:qdrant:{collection}:{source}").as_bytes())
}

/// Normalize the identity fields which are safe to normalize without changing
/// what resource a URI addresses. Most importantly, the local connection id is
/// not part of a shared Qdrant document id, so two clients connected to the same
/// collection converge on the same manifest.
fn normalized_source_identity(source_uri: &str) -> String {
    let source_uri = source_uri.trim();
    let Ok(mut url) = url::Url::parse(source_uri) else {
        return source_uri.to_owned();
    };
    url.set_fragment(None);
    let default_port = matches!(
        (url.scheme(), url.port()),
        ("http", Some(80)) | ("https", Some(443))
    );
    if default_port {
        let _ = url.set_port(None);
    }
    if url.scheme() == "file" && url.host_str() == Some("localhost") {
        let _ = url.set_host(None);
    }
    url.to_string()
}

/// Deterministic RFC 4122-shaped identifier derived from SHA-256. Setting the
/// custom version nibble keeps it distinct from random v4 ids without pulling a
/// second digest algorithm into the signed application binary.
fn stable_uuid(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; // application-defined version 8
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn local_bucket_profile(
    docs: &crate::docs::db::DocsDb,
    bucket_id: &str,
) -> Result<EmbeddingProfile, String> {
    docs.with(|connection| {
        let profile_json: String = connection
            .query_row(
                "SELECT p.profile_json
                   FROM doc_buckets b JOIN knowledge_embedding_profiles p
                     ON p.id=b.embedding_profile_id
                  WHERE b.id=?1 AND p.status='ready'",
                [bucket_id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    "this bucket has no ready semantic embedding profile".into()
                }
                other => other.to_string(),
            })?;
        serde_json::from_str(&profile_json)
            .map_err(|error| format!("stored embedding profile is invalid: {error}"))
    })
}

async fn managed_qdrant_target(
    app: &tauri::AppHandle<Wry>,
    connection_id: &str,
    collection: &str,
) -> Result<(QdrantClient, EmbeddingProfile), String> {
    let connections = store::read_connections(app);
    let connection = store::find_connection(&connections, connection_id)?;
    let key = store::read_api_key(app, connection)?;
    let endpoint = QdrantEndpoint::parse(&connection.url, key.is_some(), connection.allow_insecure)
        .map_err(|error| error.to_string())?;
    let client = QdrantClient::new(endpoint, key).map_err(|error| error.to_string())?;
    let info = client
        .collection_info(collection)
        .await
        .map_err(|error| error.to_string())?;
    let payload_index_drift = super::contract::required_payload_index_drift(&info);
    let metadata = info.metadata.into_valid().ok_or_else(|| {
        "upload requires a managed VTerminal collection with exact embedding metadata".to_string()
    })?;
    let profile = metadata.embedding_profile;
    let expected = super::contract::collection_metadata(&profile);
    if metadata.owner != "vterminal"
        || metadata.contract_version != expected.contract_version
        || metadata.payload_schema_version != expected.payload_schema_version
        || metadata.chunk_pipeline_version != expected.chunk_pipeline_version
        || metadata.embedding_profile_fingerprint != profile.fingerprint()
        || !payload_index_drift.is_empty()
    {
        return Err("collection no longer satisfies the managed VTerminal contract".into());
    }
    if !info.vectors.iter().any(|vector| {
        vector.name == metadata.vector_name
            && vector.size == profile.semantic().dimensions
            && vector.distance.eq_ignore_ascii_case("cosine")
            && vector
                .data_type
                .as_deref()
                .is_none_or(|kind| kind.eq_ignore_ascii_case("float32"))
    }) {
        return Err("collection vector no longer matches its immutable profile".into());
    }
    Ok((client, profile))
}

async fn resolve_remote_revision(
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    client: &QdrantClient,
    connection_id: &str,
    collection: &str,
    payload: &mut IngestJobPayload,
) -> Result<(String, Option<u64>, u64), String> {
    if let (Some(document_id), Some(revision)) =
        (payload.resolved_document_id.clone(), payload.revision)
    {
        return Ok((document_id, payload.prior_revision, revision));
    }
    let document_id = payload.document.document_id.clone().unwrap_or_else(|| {
        stable_remote_document_id(
            connection_id,
            collection,
            payload
                .document
                .source_id
                .as_deref()
                .unwrap_or(&payload.document.source_uri),
        )
    });
    let (prior, highest) = client
        .document_revision_head(collection, &document_id)
        .await
        .map_err(|error| error.to_string())?;
    let revision = allocate_remote_revision(highest)?;
    payload.resolved_document_id = Some(document_id.clone());
    payload.prior_revision = prior;
    payload.revision = Some(revision);
    job.payload = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    job.updated_at = semantic::now_ms();
    persist_job(docs, job)?;
    Ok((document_id, prior, revision))
}

/// Generate a JSON-safe, microsecond-sortable revision. Using the full Unix
/// microsecond timestamp makes a collision between independent clients much less
/// likely than splitting a millisecond into a small random suffix, while still
/// preserving exact integer values over JSON/TypeScript for centuries. The
/// remote head still wins when a clock moved backwards.
fn allocate_remote_revision(highest: Option<u64>) -> Result<u64, String> {
    const MAX_JSON_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
    let clock_revision = u64::try_from(chrono::Utc::now().timestamp_micros())
        .map_err(|_| "the system clock cannot allocate a document revision")?;
    let head_revision = highest
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| "the collection exhausted its document revision range".to_string())?;
    let revision = clock_revision.max(head_revision).max(1);
    if revision > MAX_JSON_SAFE_INTEGER {
        return Err("the collection document revision exceeds the JSON-safe integer range".into());
    }
    Ok(revision)
}

async fn remote_revision_already_active(
    client: &QdrantClient,
    collection: &str,
    document_id: &str,
    saved_revision: u64,
) -> Result<bool, String> {
    let (active_revision, _) = client
        .document_revision_head(collection, document_id)
        .await
        .map_err(|error| error.to_string())?;
    saved_revision_is_current(active_revision, saved_revision)
}

fn saved_revision_is_current(
    active_revision: Option<u64>,
    saved_revision: u64,
) -> Result<bool, String> {
    // A higher staging manifest is not a committed replacement. It may belong
    // to a cancelled or crashed client, so it must not suppress the last active
    // revision. If that client later activates, the post-commit check below will
    // deterministically retire this lower revision.
    if let Some(newer) = active_revision.filter(|revision| *revision > saved_revision) {
        return Err(format!(
            "this job's saved document revision {saved_revision} was superseded by newer revision {newer}; start a new replacement instead"
        ));
    }
    Ok(active_revision == Some(saved_revision))
}

fn superseding_revision(active_revision: Option<u64>, saved_revision: u64) -> Option<u64> {
    active_revision.filter(|revision| *revision > saved_revision)
}

/// Close the final activation race without ever touching a newer revision. If
/// another client activated a newer manifest between our pre-commit read and
/// activation, retire exactly this saved revision and let the newer job win.
async fn retire_revision_if_superseded(
    client: &QdrantClient,
    collection: &str,
    document_id: &str,
    saved_revision: u64,
) -> Result<(), String> {
    let (active_revision, _) = client
        .document_revision_head(collection, document_id)
        .await
        .map_err(|error| format!("confirm the activated Qdrant revision: {error}"))?;
    let Some(newer) = superseding_revision(active_revision, saved_revision) else {
        return Ok(());
    };

    let demote = client
        .set_document_revision_state(
            collection,
            document_id,
            saved_revision,
            DocumentState::Staging,
            &chrono::Utc::now().to_rfc3339(),
        )
        .await;
    let delete = client
        .delete_document_revision(collection, document_id, saved_revision)
        .await;
    if demote.is_err() && delete.is_err() {
        return Err(format!(
            "document revision {saved_revision} was superseded by newer revision {newer}, but Qdrant could neither hide nor delete the older active revision"
        ));
    }
    Err(format!(
        "document revision {saved_revision} was superseded by newer revision {newer}; the older revision was retired"
    ))
}

async fn embed_documents(
    app: &tauri::AppHandle<Wry>,
    context: &mut EmbeddingJobContext,
    profile: &EmbeddingProfile,
    inputs: &[EmbeddingInput],
) -> Result<EmbeddedBatch, String> {
    match profile.semantic().provider {
        EmbeddingProviderDialect::LocalLlamaCpp => {
            embed_local_documents(app, profile, inputs).await
        }
        provider => {
            let resolved = context
                .resolve_http_with(profile, || embedding_endpoint(app, profile, provider))?;
            embed_http_batch(
                &resolved.client,
                &resolved.endpoint,
                profile,
                EmbeddingPurpose::Document,
                inputs,
            )
            .await
            .map_err(|error| error.to_string())
        }
    }
}

async fn embed_local_documents(
    app: &tauri::AppHandle<Wry>,
    profile: &EmbeddingProfile,
    inputs: &[EmbeddingInput],
) -> Result<EmbeddedBatch, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let models_dir = crate::models::registry::models_dir(
        &app_data,
        crate::commands::settings::read_string(app, "models_dir").as_deref(),
    );
    let semantic = profile.semantic();
    let digest = semantic
        .artifact_sha256
        .as_deref()
        .ok_or_else(|| "local embedding profile has no artifact digest".to_string())?;
    let installed = super::local::installed_artifacts(&models_dir)
        .into_iter()
        .find(|artifact| {
            artifact.sha256.eq_ignore_ascii_case(digest)
                && super::embedding::builtin_model(&artifact.builtin_model_id)
                    .is_some_and(|model| model.upstream_model_id == semantic.model_id)
        })
        .ok_or_else(|| "the exact local embedding artifact is not installed".to_string())?;
    app.state::<super::local::EmbeddingHost>()
        .embed(&installed, profile, EmbeddingPurpose::Document, inputs)
        .await
        .map_err(|error| error.to_string())
}

fn embedding_endpoint(
    app: &tauri::AppHandle<Wry>,
    profile: &EmbeddingProfile,
    provider: EmbeddingProviderDialect,
) -> Result<(String, Option<crate::credentials::Secret>), String> {
    match provider {
        EmbeddingProviderDialect::OpenAi => Ok((
            "https://api.openai.com".into(),
            Some(required_credential(
                app,
                crate::credentials::CredentialId::OpenAi,
                "OpenAI",
            )?),
        )),
        EmbeddingProviderDialect::Mistral => Ok((
            "https://api.mistral.ai".into(),
            Some(required_credential(
                app,
                crate::credentials::CredentialId::Mistral,
                "Mistral",
            )?),
        )),
        EmbeddingProviderDialect::Ollama | EmbeddingProviderDialect::LmStudio => {
            advanced_embedding_endpoint(app, profile)
        }
        EmbeddingProviderDialect::LocalLlamaCpp => unreachable!(),
    }
}

fn required_credential(
    app: &tauri::AppHandle<Wry>,
    id: crate::credentials::CredentialId,
    provider: &str,
) -> Result<crate::credentials::Secret, String> {
    required_credential_with(id, provider, |id| crate::credentials::state(app).get(id))
}

fn required_credential_with(
    id: crate::credentials::CredentialId,
    provider: &str,
    read: impl FnOnce(
        &crate::credentials::CredentialId,
    ) -> Result<Option<crate::credentials::Secret>, String>,
) -> Result<crate::credentials::Secret, String> {
    read(&id)?.ok_or_else(|| format!("{provider} API key is missing; add it in Settings first"))
}

fn advanced_embedding_endpoint(
    app: &tauri::AppHandle<Wry>,
    profile: &EmbeddingProfile,
) -> Result<(String, Option<crate::credentials::Secret>), String> {
    let servers = crate::models::remote::read_servers(app);
    advanced_embedding_endpoint_with(profile, &servers, |server_id| {
        crate::models::remote::read_token(app, server_id)
    })
}

fn advanced_embedding_endpoint_with(
    profile: &EmbeddingProfile,
    servers: &[crate::models::remote::RemoteServer],
    read_token: impl FnOnce(&str) -> Result<Option<crate::credentials::Secret>, String>,
) -> Result<(String, Option<crate::credentials::Secret>), String> {
    use crate::models::remote::ServerKind;
    let kind = match profile.semantic().provider {
        EmbeddingProviderDialect::Ollama => ServerKind::Ollama,
        EmbeddingProviderDialect::LmStudio => ServerKind::LmStudio,
        _ => return Err("not an advanced embedding provider".into()),
    };
    let matches = servers
        .iter()
        .filter(|server| {
            server.kind == kind
                && server
                    .models
                    .iter()
                    .any(|model| model.wire_model == profile.semantic().model_id)
        })
        .collect::<Vec<_>>();
    let server = match matches.as_slice() {
        [server] => server,
        [] => {
            return Err(format!(
                "no tested {} server exposes this embedding model",
                kind.label()
            ))
        }
        _ => {
            return Err(format!(
                "more than one {} server exposes this embedding model",
                kind.label()
            ))
        }
    };
    Ok((server.base_url.clone(), read_token(&server.id)?))
}

/// Run one ingestion to completion without a Tauri application. This is the
/// shared backend for `vterminal-docs`; `settings_value` is constructed from the
/// private settings file inside that process and is never printed or persisted in
/// the job. The job itself contains only extracted text and reproducible metadata.
pub async fn ingest_headless(
    app_data: &std::path::Path,
    settings_value: &serde_json::Value,
    docs: &crate::docs::db::DocsDb,
    request: IngestRequest,
) -> Result<JobView, String> {
    let settings: HeadlessSettings = serde_json::from_value(settings_value.clone())
        .map_err(|error| format!("read shared knowledge settings: {error}"))?;
    let pages = request
        .pages
        .into_iter()
        .map(|page| IngestPage {
            page: page.page,
            text: page.text,
        })
        .collect::<Vec<_>>();
    let mut document = IngestDocument {
        document_id: request.document_id,
        source_id: None,
        title: request.title,
        source_uri: request.source_uri,
        mime_type: request.mime_type,
        size_bytes: Some(pages.iter().map(|page| page.text.len() as i64).sum()),
        mtime_ms: Some(0),
    };
    validate_document(&mut document, &pages)?;
    let mut job = new_ingest_job(&request.bucket, document, pages)?;
    persist_job(docs, &job)?;
    claim_job(docs, &job.id)?;
    job.status = "running".into();
    let result = run_headless_document(app_data, &settings, docs, &mut job).await;
    match result {
        Ok(()) => finalize_job(docs, &mut job, true, None)?,
        Err(error) => {
            finalize_job(docs, &mut job, false, Some(&error))?;
            return Err(error);
        }
    }
    let stored = docs.with(|connection| load_job(connection, &job.id))?;
    Ok(stored.into())
}

async fn run_headless_document(
    app_data: &std::path::Path,
    settings: &HeadlessSettings,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
) -> Result<(), String> {
    let bucket: KnowledgeBucketRef = serde_json::from_value(job.target_ref.clone())
        .map_err(|error| format!("invalid job target: {error}"))?;
    let mut payload: IngestJobPayload = serde_json::from_value(job.payload.clone())
        .map_err(|error| format!("invalid job payload: {error}"))?;
    validate_document(&mut payload.document, &payload.pages)?;
    match bucket {
        KnowledgeBucketRef::Local { bucket_id } => {
            persist_progress(docs, job, "chunk", 0, None)?;
            let document_id = payload.document.document_id.clone().unwrap_or_else(|| {
                stable_local_document_id(&bucket_id, &payload.document.source_uri)
            });
            let pages = source_pages(&payload.pages);
            let count = write_local_document(docs, &bucket_id, &document_id, &payload, &pages)?;
            persist_progress(docs, job, "embed", 0, Some(count))?;
            embed_pending_local_headless(app_data, settings, docs, job, &bucket_id).await
        }
        KnowledgeBucketRef::Qdrant {
            connection_id,
            collection,
        } => {
            ingest_qdrant_headless(
                app_data,
                settings,
                docs,
                job,
                &connection_id,
                &collection,
                payload,
            )
            .await
        }
    }
}

fn write_local_document(
    docs: &crate::docs::db::DocsDb,
    bucket_id: &str,
    document_id: &str,
    payload: &IngestJobPayload,
    pages: &[SourcePage],
) -> Result<u32, String> {
    docs.with(|connection| {
        if !index::bucket_exists(connection, bucket_id)? {
            return Err(format!("unknown bucket: {bucket_id}"));
        }
        let existing = index::list_files(connection, bucket_id)?
            .into_iter()
            .find(|file| file.id == document_id);
        let joined = pages
            .iter()
            .map(|page| page.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let next_sha = index::text_sha256(&joined);
        let must_reembed = if let Some(file) = &existing {
            let prior_sha: Option<String> = connection
                .query_row(
                    "SELECT text_sha256 FROM doc_files WHERE id=?1",
                    [document_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            file.name != payload.document.title || prior_sha.as_deref() != Some(&next_sha)
        } else {
            false
        };
        if must_reembed {
            invalidate_local_document_embeddings(connection, bucket_id, document_id)?;
        }
        if existing.is_none() {
            connection
                .execute(
                    "INSERT INTO doc_files
                       (id,bucket_id,path,name,media_type,size_bytes,mtime_ms,state)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')",
                    rusqlite::params![
                        document_id,
                        bucket_id,
                        &payload.document.source_uri,
                        &payload.document.title,
                        &payload.document.mime_type,
                        payload.document.size_bytes.unwrap_or(0),
                        payload.document.mtime_ms.unwrap_or(0),
                    ],
                )
                .map_err(|error| error.to_string())?;
        } else {
            connection
                .execute(
                    "UPDATE doc_files SET path=?2,name=?3,media_type=?4
                      WHERE id=?1 AND bucket_id=?5",
                    rusqlite::params![
                        document_id,
                        &payload.document.source_uri,
                        &payload.document.title,
                        &payload.document.mime_type,
                        bucket_id,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        index::put_text(
            connection,
            document_id,
            pages,
            payload.document.size_bytes.unwrap_or(0),
            payload.document.mtime_ms.unwrap_or(0),
        )?;
        Ok(index::list_files(connection, bucket_id)?
            .into_iter()
            .find(|file| file.id == document_id)
            .map(|file| file.chunk_count)
            .unwrap_or(0))
    })
}

fn invalidate_local_document_embeddings(
    connection: &mut rusqlite::Connection,
    bucket_id: &str,
    document_id: &str,
) -> Result<(), String> {
    let dimension: Option<i64> = connection
        .query_row(
            "SELECT embed_dim FROM doc_buckets WHERE id=?1",
            [bucket_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let ids = {
        let mut statement = connection
            .prepare("SELECT id FROM doc_chunks WHERE file_id=?1 AND bucket_id=?2")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params![document_id, bucket_id], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    connection
        .execute(
            "UPDATE doc_chunks SET embedding=NULL WHERE file_id=?1 AND bucket_id=?2",
            rusqlite::params![document_id, bucket_id],
        )
        .map_err(|error| error.to_string())?;
    if let Some(dimension) = dimension.filter(|dimension| *dimension > 0) {
        let table = semantic::ensure_vector_index(connection, dimension as u32)?;
        for id in ids {
            connection
                .execute(&format!("DELETE FROM {table} WHERE chunk_id=?1"), [id])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn embed_pending_local_headless(
    app_data: &std::path::Path,
    settings: &HeadlessSettings,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    bucket_id: &str,
) -> Result<(), String> {
    let profile = local_bucket_profile(docs, bucket_id)?;
    let mut embedding = EmbeddingJobContext::default();
    let total = docs.with(|connection| {
        connection
            .query_row(
                "SELECT count(*) FROM doc_chunks WHERE bucket_id=?1 AND embedding IS NULL",
                [bucket_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as u32)
            .map_err(|error| error.to_string())
    })?;
    persist_progress(docs, job, "embed", 0, Some(total))?;
    let mut completed = 0;
    loop {
        let pending = docs.with(|connection| {
            semantic::pending_chunks(connection, bucket_id, EMBEDDING_BATCH_SIZE)
        })?;
        if pending.is_empty() {
            break;
        }
        let inputs = pending
            .iter()
            .map(|chunk| EmbeddingInput::document(&chunk.text, Some(chunk.title.clone())))
            .collect::<Vec<_>>();
        let vectors =
            embed_documents_headless(app_data, settings, &mut embedding, &profile, &inputs)
                .await?
                .vectors;
        let rows = pending
            .iter()
            .zip(vectors)
            .map(|(chunk, vector)| (chunk.chunk_id, vector))
            .collect::<Vec<_>>();
        docs.with(|connection| {
            semantic::put_embeddings(
                connection,
                bucket_id,
                profile.fingerprint(),
                profile.semantic().dimensions,
                &rows,
            )
        })?;
        completed += rows.len() as u32;
        persist_progress(docs, job, "embed", completed, Some(total))?;
    }
    Ok(())
}

async fn ingest_qdrant_headless(
    app_data: &std::path::Path,
    settings: &HeadlessSettings,
    docs: &crate::docs::db::DocsDb,
    job: &mut semantic::KnowledgeJob,
    connection_id: &str,
    collection: &str,
    mut payload: IngestJobPayload,
) -> Result<(), String> {
    let client = qdrant_headless(settings, connection_id)?;
    let info = client
        .collection_info(collection)
        .await
        .map_err(|error| error.to_string())?;
    let metadata = info.metadata.into_valid().ok_or_else(|| {
        "upload requires a managed VTerminal collection with exact embedding metadata".to_string()
    })?;
    let profile = metadata.embedding_profile;
    let mut embedding = EmbeddingJobContext::default();
    if metadata.embedding_profile_fingerprint != profile.fingerprint() {
        return Err("collection metadata has a mismatched embedding fingerprint".into());
    }
    persist_progress(docs, job, "chunk", 0, None)?;
    let chunks = chunk::chunk_pages(&source_pages(&payload.pages), ChunkSpec::default());
    if chunks.is_empty() {
        return Err("the extracted document produced no non-empty chunks".into());
    }
    let total = chunks.len() as u32;
    persist_progress(docs, job, "embed", 0, Some(total))?;
    let (document_id, _old_revision, revision) =
        resolve_remote_revision(docs, job, &client, connection_id, collection, &mut payload)
            .await?;
    let already_active =
        remote_revision_already_active(&client, collection, &document_id, revision).await?;
    let digest = content_sha256(&payload.pages);
    let now = chrono::Utc::now().to_rfc3339();
    let mut document_chunks = Vec::with_capacity(chunks.len());
    for batch in chunks.chunks(EMBEDDING_BATCH_SIZE) {
        let inputs = batch
            .iter()
            .map(|chunk| {
                EmbeddingInput::document(&chunk.text, Some(payload.document.title.clone()))
            })
            .collect::<Vec<_>>();
        let vectors =
            embed_documents_headless(app_data, settings, &mut embedding, &profile, &inputs)
                .await?
                .vectors;
        for (chunk, vector) in batch.iter().zip(vectors) {
            document_chunks.push(DocumentChunk {
                document_id: document_id.clone(),
                source_id: payload.document.source_id.clone(),
                revision,
                state: DocumentState::Staging,
                content_sha256: digest.clone(),
                chunk_index: chunk.ord,
                text: chunk.text.clone(),
                title: payload.document.title.clone(),
                source_uri: payload.document.source_uri.clone(),
                mime_type: payload.document.mime_type.clone(),
                page: chunk.page,
                heading: chunk.heading.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
                vector,
            });
        }
        persist_progress(
            docs,
            job,
            "embed",
            document_chunks.len() as u32,
            Some(total),
        )?;
    }
    let manifest = DocumentManifest {
        document_id: document_id.clone(),
        source_id: payload.document.source_id,
        revision,
        state: DocumentState::Staging,
        content_sha256: digest,
        title: payload.document.title,
        source_uri: payload.document.source_uri,
        mime_type: payload.document.mime_type,
        chunk_count: total,
        created_at: now.clone(),
        updated_at: now,
    };
    persist_progress(docs, job, "upload", 0, Some(total))?;
    if !already_active {
        client
            .upsert_document(collection, &profile, &manifest, &document_chunks)
            .await
            .map_err(|error| {
                format!("upload the document manifest and chunks through Qdrant REST: {error}")
            })?;
        if remote_revision_already_active(&client, collection, &document_id, revision).await? {
            persist_progress(docs, job, "upload", total, Some(total))?;
            return Ok(());
        }
        client
            .set_document_revision_state(
                collection,
                &document_id,
                revision,
                DocumentState::Active,
                &chrono::Utc::now().to_rfc3339(),
            )
            .await
            .map_err(|error| format!("activate the document revision in Qdrant: {error}"))?;
    }
    retire_revision_if_superseded(&client, collection, &document_id, revision).await?;
    let committed_at = chrono::Utc::now().to_rfc3339();
    client
        .deactivate_other_document_revisions(collection, &document_id, revision, &committed_at)
        .await
        .map_err(|error| format!("hide lower document revisions in Qdrant: {error}"))?;
    client
        .delete_other_document_revisions(collection, &document_id, revision)
        .await
        .map_err(|error| format!("delete lower document revisions from Qdrant: {error}"))?;
    persist_progress(docs, job, "upload", total, Some(total))
}

fn qdrant_headless(
    settings: &HeadlessSettings,
    connection_id: &str,
) -> Result<QdrantClient, String> {
    let connection = settings
        .connections
        .iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| format!("unknown Qdrant connection {connection_id:?}"))?;
    let key = crate::credentials::headless_qdrant_get(connection_id, &connection.url)?;
    let endpoint = QdrantEndpoint::parse(&connection.url, key.is_some(), connection.allow_insecure)
        .map_err(|error| error.to_string())?;
    QdrantClient::new(endpoint, key).map_err(|error| error.to_string())
}

fn headless_embedding_endpoint(
    profile: &EmbeddingProfile,
) -> Result<(String, Option<crate::credentials::Secret>), String> {
    headless_embedding_endpoint_with(profile, crate::credentials::headless_get)
}

fn headless_embedding_endpoint_with(
    profile: &EmbeddingProfile,
    read: impl FnOnce(
        &crate::credentials::CredentialId,
    ) -> Result<Option<crate::credentials::Secret>, String>,
) -> Result<(String, Option<crate::credentials::Secret>), String> {
    let (base_url, credential_id) = match profile.semantic().provider {
        EmbeddingProviderDialect::OpenAi => (
            "https://api.openai.com",
            crate::credentials::CredentialId::OpenAi,
        ),
        EmbeddingProviderDialect::Mistral => (
            "https://api.mistral.ai",
            crate::credentials::CredentialId::Mistral,
        ),
        _ => {
            return Err(
                "headless ingestion supports built-in local, OpenAI, and Mistral profiles".into(),
            )
        }
    };
    let key = read(&credential_id)?
        .filter(|secret| !secret.expose().trim().is_empty())
        .ok_or_else(|| "the embedding provider API key is missing".to_string())?;
    Ok((base_url.into(), Some(key)))
}

async fn embed_documents_headless(
    app_data: &std::path::Path,
    settings: &HeadlessSettings,
    context: &mut EmbeddingJobContext,
    profile: &EmbeddingProfile,
    inputs: &[EmbeddingInput],
) -> Result<EmbeddedBatch, String> {
    if profile.semantic().provider == EmbeddingProviderDialect::LocalLlamaCpp {
        let models_dir =
            crate::models::registry::models_dir(app_data, settings.models_dir.as_deref());
        let digest = profile
            .semantic()
            .artifact_sha256
            .as_deref()
            .ok_or_else(|| "local embedding profile has no artifact digest".to_string())?;
        let installed = super::local::installed_artifacts(&models_dir)
            .into_iter()
            .find(|artifact| artifact.sha256.eq_ignore_ascii_case(digest))
            .ok_or_else(|| "the exact local embedding artifact is not installed".to_string())?;
        #[cfg(feature = "local-llm")]
        let host = super::local::EmbeddingHost::default();
        #[cfg(not(feature = "local-llm"))]
        let host = super::local::EmbeddingHost;
        return host
            .embed(&installed, profile, EmbeddingPurpose::Document, inputs)
            .await
            .map_err(|error| error.to_string());
    }
    let resolved = context.resolve_http_with(profile, || headless_embedding_endpoint(profile))?;
    embed_http_batch(
        &resolved.client,
        &resolved.endpoint,
        profile,
        EmbeddingPurpose::Document,
        inputs,
    )
    .await
    .map_err(|error| error.to_string())
}

/// Remember only a capability learned through the user's explicit upload action.
/// Discovery itself remains read-only and never sends a probe point.
pub(crate) fn remember_point_access(
    app: &tauri::AppHandle<Wry>,
    connection_id: &str,
    collection: &str,
    writable: bool,
) -> Result<(), String> {
    let connections = store::read_connections(app);
    let snapshot = store::find_connection(&connections, connection_id)?.clone();
    store::update_connection_if_current(app, &snapshot, |connection| {
        let observed_at = semantic::now_ms();
        let mut found = false;
        for value in &mut connection.collections {
            let Ok(mut bucket) = serde_json::from_value::<
                crate::commands::knowledge::KnowledgeBucketView,
            >(value.clone()) else {
                continue;
            };
            if matches!(
                &bucket.bucket_ref,
                KnowledgeBucketRef::Qdrant { collection: name, .. } if name == collection
            ) {
                found = true;
                bucket.access = Some(if writable {
                    match bucket.access {
                        Some(super::types::CollectionAccess::Manage) => {
                            super::types::CollectionAccess::Manage
                        }
                        _ => super::types::CollectionAccess::PointsReadWrite,
                    }
                } else {
                    super::types::CollectionAccess::ReadOnly
                });
                bucket.writable = writable;
                bucket.write_capability = if writable {
                    "read_write".into()
                } else {
                    "read_only".into()
                };
                *value = serde_json::to_value(bucket).map_err(|error| error.to_string())?;
            }
        }
        if found {
            // This explicit operation reached the current endpoint after any
            // refresh that was already in flight. Advancing the cache observation
            // timestamp prevents that older refresh from restoring `unknown`
            // access over the result learned from the user's upload.
            connection.last_checked_at = Some(
                connection
                    .last_checked_at
                    .unwrap_or(i64::MIN)
                    .max(observed_at),
            );
            connection.status = "connected".into();
            connection.error = None;
        }
        Ok(())
    })
    .map(|_| ())
}

pub fn cancel_job(
    docs: &crate::docs::db::DocsDb,
    id: &str,
) -> Result<semantic::KnowledgeJob, String> {
    docs.with(|connection| {
        let changed = connection
            .execute(
                "UPDATE knowledge_jobs
                    SET status=CASE
                          WHEN status='running' THEN 'cancelling'
                          ELSE 'cancelled'
                        END,
                        updated_at=?2
                  WHERE id=?1 AND status IN ('queued','running','failed')",
                rusqlite::params![id, semantic::now_ms()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            let status: String = connection
                .query_row(
                    "SELECT status FROM knowledge_jobs WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => "no such knowledge job".into(),
                    other => other.to_string(),
                })?;
            return Err(match status.as_str() {
                "completed" => "a completed job cannot be cancelled".into(),
                "cancelling" => "this job is already stopping".into(),
                "cancelled" => "this job is already cancelled".into(),
                _ => format!("job cannot be cancelled from status {status:?}"),
            });
        }
        load_job(connection, id)
    })
}

pub fn prepare_retry(
    docs: &crate::docs::db::DocsDb,
    id: &str,
) -> Result<semantic::KnowledgeJob, String> {
    docs.with(|connection| {
        let existing = load_job(connection, id)?;
        if !matches!(existing.status.as_str(), "failed" | "cancelled") {
            return Err("only a failed or cancelled job can be retried".into());
        }
        if existing.error.as_deref().is_some_and(|error| {
            error.starts_with("Qdrant connection origin changed")
                || error.starts_with("Qdrant connection endpoint changed")
                || error.starts_with("Qdrant connection was removed")
                || error.starts_with("Qdrant collection was deleted")
        }) {
            return Err(
                "this job's Qdrant target changed or was removed; start a new ingestion job".into(),
            );
        }
        let resource_key = existing
            .resource_key
            .clone()
            .map(Ok)
            .unwrap_or_else(|| derive_job_resource_key(&existing))?;
        let changed = connection
            .execute(
                "UPDATE knowledge_jobs
                    SET status='queued',resource_key=?3,error=NULL,updated_at=?2
                  WHERE id=?1 AND status IN ('failed','cancelled')",
                rusqlite::params![id, semantic::now_ms(), resource_key],
            )
            .map_err(|error| {
                let message = error.to_string();
                if message.contains("knowledge_jobs.resource_key") {
                    "another ingestion job is already active for this bucket or document".into()
                } else {
                    message
                }
            })?;
        if changed == 0 {
            return Err("only a failed or cancelled job can be retried".into());
        }
        load_job(connection, id)
    })
}

fn derive_job_resource_key(job: &semantic::KnowledgeJob) -> Result<String, String> {
    let bucket: KnowledgeBucketRef = serde_json::from_value(job.target_ref.clone())
        .map_err(|error| format!("legacy job has an invalid target: {error}"))?;
    match bucket {
        KnowledgeBucketRef::Local { bucket_id } => Ok(format!("local:{bucket_id}")),
        KnowledgeBucketRef::Qdrant {
            connection_id,
            collection,
        } => {
            if job.kind != "document_ingest" {
                return Err(format!(
                    "cannot derive a resource key for legacy job kind {:?}",
                    job.kind
                ));
            }
            let payload: IngestJobPayload = serde_json::from_value(job.payload.clone())
                .map_err(|error| format!("legacy job has an invalid payload: {error}"))?;
            let document_id = payload
                .resolved_document_id
                .or(payload.document.document_id)
                .unwrap_or_else(|| {
                    stable_remote_document_id(
                        &connection_id,
                        &collection,
                        payload
                            .document
                            .source_id
                            .as_deref()
                            .unwrap_or(&payload.document.source_uri),
                    )
                });
            Ok(remote_document_resource_key(
                &connection_id,
                &collection,
                &document_id,
            ))
        }
    }
}

pub fn load_job(
    connection: &rusqlite::Connection,
    id: &str,
) -> Result<semantic::KnowledgeJob, String> {
    semantic::list_jobs(connection)?
        .into_iter()
        .find(|job| job.id == id)
        .ok_or_else(|| "no such knowledge job".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_state_is_isolated_per_application_instance() {
        let first = KnowledgeJobRunnerState::default();
        let second = KnowledgeJobRunnerState::default();
        first.active.store(true, Ordering::Release);
        assert!(first.active.load(Ordering::Acquire));
        assert!(!second.active.load(Ordering::Acquire));
    }

    fn test_docs() -> (std::path::PathBuf, crate::docs::db::DocsDb) {
        let dir =
            std::env::temp_dir().join(format!("vterminal-ingest-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let docs = crate::docs::db::DocsDb::new(dir.clone());
        (dir, docs)
    }

    fn remote_job(document_id: &str) -> semantic::KnowledgeJob {
        remote_job_for("connection", "docs", document_id)
    }

    fn remote_job_for(
        connection_id: &str,
        collection: &str,
        document_id: &str,
    ) -> semantic::KnowledgeJob {
        new_ingest_job(
            &KnowledgeBucketRef::Qdrant {
                connection_id: connection_id.into(),
                collection: collection.into(),
            },
            IngestDocument {
                document_id: Some(document_id.into()),
                source_id: None,
                title: "Guide".into(),
                source_uri: "file:///guide.pdf".into(),
                mime_type: "application/pdf".into(),
                size_bytes: Some(42),
                mtime_ms: None,
            },
            vec![IngestPage {
                page: Some(1),
                text: "extracted".into(),
            }],
        )
        .unwrap()
    }

    fn imported_binding(collection: &str) -> super::super::types::ImportedCollectionBinding {
        super::super::types::ImportedCollectionBinding {
            connection_id: "connection".into(),
            collection: collection.into(),
            vector_name: "dense".into(),
            embedding_profile_fingerprint: "sha256:exact".into(),
            text_field: "text".into(),
            document_id_field: "document_id".into(),
            title_field: None,
            source_uri_field: None,
            page_field: None,
            heading_field: None,
            model_attested: true,
        }
    }

    #[test]
    fn stable_ids_are_collection_scoped_across_qdrant_connections() {
        let local = stable_local_document_id("a", "file:///guide.md");
        assert_eq!(local, stable_local_document_id("a", "file:///guide.md"));
        assert_ne!(local, stable_local_document_id("b", "file:///guide.md"));
        let remote = stable_remote_document_id("c", "docs", "file:///guide.md");
        assert_ne!(local, remote);
        assert_eq!(
            remote,
            stable_remote_document_id("another-client", "docs", "file://localhost/guide.md#page=1")
        );
        assert_ne!(
            remote,
            stable_remote_document_id("c", "another-collection", "file:///guide.md")
        );
        assert_eq!(uuid::Uuid::parse_str(&remote).unwrap().get_version_num(), 8);
    }

    #[test]
    fn explicit_source_id_controls_shared_remote_identity() {
        let mut first = remote_job_for("client-a", "docs", "temporary-id");
        let mut second = remote_job_for("client-b", "docs", "temporary-id");
        for job in [&mut first, &mut second] {
            let mut payload: IngestJobPayload =
                serde_json::from_value(job.payload.clone()).unwrap();
            payload.document.document_id = None;
            payload.document.source_id = Some("shared-source".into());
            payload.document.source_uri = format!("file:///client/{}/guide.pdf", job.id);
            job.payload = serde_json::to_value(payload).unwrap();
        }
        let first_payload: IngestJobPayload = serde_json::from_value(first.payload).unwrap();
        let second_payload: IngestJobPayload = serde_json::from_value(second.payload).unwrap();
        assert_eq!(
            stable_remote_document_id(
                "client-a",
                "docs",
                first_payload.document.source_id.as_deref().unwrap()
            ),
            stable_remote_document_id(
                "client-b",
                "docs",
                second_payload.document.source_id.as_deref().unwrap()
            )
        );
    }

    #[test]
    fn extracted_text_hash_is_page_separator_stable() {
        let pages = vec![
            IngestPage {
                page: Some(1),
                text: "one".into(),
            },
            IngestPage {
                page: Some(2),
                text: "two".into(),
            },
        ];
        assert_eq!(content_sha256(&pages), index::text_sha256("one\n\ntwo"));
    }

    #[test]
    fn jobs_never_serialize_original_binary_data() {
        let job = new_ingest_job(
            &KnowledgeBucketRef::Qdrant {
                connection_id: "connection".into(),
                collection: "docs".into(),
            },
            IngestDocument {
                document_id: None,
                source_id: None,
                title: "Guide".into(),
                source_uri: "file:///guide.pdf".into(),
                mime_type: "application/pdf".into(),
                size_bytes: Some(42),
                mtime_ms: None,
            },
            vec![IngestPage {
                page: Some(1),
                text: "extracted".into(),
            }],
        )
        .unwrap();
        let json = serde_json::to_string(&job).unwrap();
        assert!(json.contains("extracted"));
        assert!(!json.contains("binary"));
        assert!(!json.contains("api_key"));
    }

    #[test]
    fn job_views_expose_safe_names_and_fifo_queue_positions() {
        let mut later = remote_job("later");
        later.id = "b".into();
        later.created_at = 20;
        let mut earlier = remote_job("earlier");
        earlier.id = "a".into();
        earlier.created_at = 10;
        let views = job_views(vec![later, earlier]);
        let first = views.iter().find(|view| view.id == "a").unwrap();
        let second = views.iter().find(|view| view.id == "b").unwrap();
        assert_eq!(first.queue_position, Some(1));
        assert_eq!(second.queue_position, Some(2));
        assert_eq!(first.display_name, "Guide");
        assert_eq!(
            first.waiting_reason.as_deref(),
            Some("Waiting for the knowledge worker")
        );
        assert!(!serde_json::to_string(first).unwrap().contains("extracted"));
    }

    #[test]
    fn cancelling_a_queued_job_is_terminal_immediately() {
        let (dir, docs) = test_docs();
        let job = remote_job("queued-cancel");
        docs.with(|connection| semantic::put_job(connection, &job))
            .unwrap();
        assert_eq!(cancel_job(&docs, &job.id).unwrap().status, "cancelled");
        assert!(prepare_retry(&docs, &job.id).is_ok());
        docs.destroy().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_headless_jobs_release_their_resource_keys_safely() {
        let (dir, docs) = test_docs();
        let mut running = remote_job("interrupted");
        running.status = "running".into();
        docs.with(|connection| semantic::put_job(connection, &running))
            .unwrap();

        assert_eq!(
            fail_interrupted_headless_jobs(&docs).unwrap(),
            vec![running.id.clone()]
        );
        let stored = docs
            .with(|connection| load_job(connection, &running.id))
            .unwrap();
        assert_eq!(stored.status, "failed");
        assert!(stored
            .error
            .as_deref()
            .is_some_and(|error| error.contains("standalone CLI stopped")));

        // The partial job remains available for UI Retry, but its partial unique
        // index no longer blocks the user's next CLI attempt for that document.
        let replacement = remote_job("interrupted");
        docs.with(|connection| semantic::put_job(connection, &replacement))
            .unwrap();

        docs.destroy().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_retry_derives_and_persists_the_exact_document_resource_key() {
        let (dir, docs) = test_docs();
        let mut job = remote_job("document-1");
        job.status = "failed".into();
        job.resource_key = None;
        docs.with(|connection| semantic::put_job(connection, &job))
            .unwrap();

        let retried = prepare_retry(&docs, &job.id).unwrap();
        assert_eq!(retried.status, "queued");
        assert_eq!(
            retried.resource_key.as_deref(),
            Some("qdrant:connection:docs:document-1")
        );

        docs.destroy().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_document_idle_guard_tracks_active_job_statuses() {
        let (dir, docs) = test_docs();
        let job = remote_job("document-2");
        docs.with(|connection| semantic::put_job(connection, &job))
            .unwrap();
        assert!(ensure_remote_document_idle(&docs, "connection", "docs", "document-2").is_err());

        docs.with(|connection| {
            connection
                .execute(
                    "UPDATE knowledge_jobs SET status='completed' WHERE id=?1",
                    [&job.id],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .unwrap();
        ensure_remote_document_idle(&docs, "connection", "docs", "document-2").unwrap();

        docs.destroy().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deleted_collection_cleanup_is_exact_and_terminal_for_pending_jobs() {
        let (dir, docs) = test_docs();
        let target = remote_job_for("connection", "docs", "pending");
        let mut completed = remote_job_for("connection", "docs", "completed");
        completed.status = "completed".into();
        let other = remote_job_for("connection", "other", "pending");

        docs.with(|connection| {
            semantic::put_profile(
                connection,
                "profile-a",
                "sha256:exact",
                &serde_json::json!({"semantic":"fixture"}),
                "ready",
            )?;
            semantic::put_qdrant_binding(connection, "profile-a", &imported_binding("docs"))?;
            semantic::put_qdrant_binding(connection, "profile-a", &imported_binding("other"))?;
            for job in [&target, &completed, &other] {
                semantic::put_job(connection, job)?;
            }
            forget_deleted_remote_collection(connection, "connection", "docs")
        })
        .unwrap();

        docs.with(|connection| {
            assert!(semantic::get_qdrant_binding(connection, "connection", "docs")?.is_none());
            assert!(semantic::get_qdrant_binding(connection, "connection", "other")?.is_some());
            assert_eq!(load_job(connection, &target.id)?.status, "failed");
            assert_eq!(load_job(connection, &completed.id)?.status, "completed");
            assert_eq!(load_job(connection, &other.id)?.status, "queued");
            Ok(())
        })
        .unwrap();
        assert!(prepare_retry(&docs, &target.id)
            .unwrap_err()
            .contains("target changed or was removed"));

        docs.destroy().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finalization_acknowledges_cancellation_and_preserves_terminal_rows() {
        let (dir, docs) = test_docs();
        let mut cancelled = remote_job("document-3");
        cancelled.status = "running".into();
        docs.with(|connection| semantic::put_job(connection, &cancelled))
            .unwrap();
        cancel_job(&docs, &cancelled.id).unwrap();
        finalize_job(&docs, &mut cancelled, true, None).unwrap();
        let stored = docs
            .with(|connection| load_job(connection, &cancelled.id))
            .unwrap();
        assert_eq!(stored.status, "cancelled");

        let mut completed = remote_job("document-4");
        completed.status = "completed".into();
        completed.error = Some("original terminal value".into());
        docs.with(|connection| semantic::put_job(connection, &completed))
            .unwrap();
        finalize_job(&docs, &mut completed, false, Some("stale worker failure")).unwrap();
        let stored = docs
            .with(|connection| load_job(connection, &completed.id))
            .unwrap();
        assert_eq!(stored.status, "completed");
        assert_eq!(stored.error.as_deref(), Some("original terminal value"));

        let mut succeeded = remote_job("document-5");
        succeeded.status = "running".into();
        docs.with(|connection| semantic::put_job(connection, &succeeded))
            .unwrap();
        finalize_job(&docs, &mut succeeded, true, None).unwrap();
        let stored = docs
            .with(|connection| load_job(connection, &succeeded.id))
            .unwrap();
        assert_eq!(stored.status, "completed");
        assert_eq!(stored.display_name, "Guide");
        assert_eq!(stored.payload, serde_json::json!({}));

        let mut failed = remote_job("document-6");
        failed.status = "running".into();
        docs.with(|connection| semantic::put_job(connection, &failed))
            .unwrap();
        finalize_job(&docs, &mut failed, false, Some("temporary failure")).unwrap();
        let stored = docs
            .with(|connection| load_job(connection, &failed.id))
            .unwrap();
        assert_eq!(stored.status, "failed");
        assert!(stored.payload.to_string().contains("extracted"));
        assert_eq!(prepare_retry(&docs, &failed.id).unwrap().status, "queued");

        docs.destroy().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_saved_revision_cannot_replace_a_newer_active_revision() {
        assert!(saved_revision_is_current(Some(4), 3)
            .unwrap_err()
            .contains("superseded"));
        assert!(saved_revision_is_current(Some(3), 3).unwrap());
        assert!(!saved_revision_is_current(Some(2), 3).unwrap());
        assert!(!saved_revision_is_current(None, 3).unwrap());
        assert_eq!(superseding_revision(Some(4), 3), Some(4));
        assert_eq!(superseding_revision(Some(3), 3), None);
        assert_eq!(superseding_revision(None, 3), None);
        let allocated = allocate_remote_revision(Some(10)).unwrap();
        assert!(allocated > 10);
        assert!(allocated < (1_u64 << 53));
    }

    #[test]
    fn app_ingestion_reads_a_provider_credential_once_across_batches() {
        let profile =
            super::super::embedding::openai_profile("text-embedding-3-small", 1_536).unwrap();
        let reads = std::cell::Cell::new(0);
        let mut context = EmbeddingJobContext::default();

        for _ in 0..3 {
            let resolved = context
                .resolve_http_with(&profile, || {
                    let key = required_credential_with(
                        crate::credentials::CredentialId::OpenAi,
                        "OpenAI",
                        |id| {
                            reads.set(reads.get() + 1);
                            assert_eq!(id, &crate::credentials::CredentialId::OpenAi);
                            Ok(Some(crate::credentials::Secret::from("app-secret")))
                        },
                    )?;
                    Ok(("https://api.openai.com".into(), Some(key)))
                })
                .unwrap();
            assert_eq!(resolved.endpoint.base_url(), "https://api.openai.com");
            assert!(resolved.endpoint.has_api_key());
        }

        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn app_ingestion_reads_an_advanced_server_token_once_across_batches() {
        let mut semantic = super::super::embedding::openai_profile("fixture", 768)
            .unwrap()
            .semantic()
            .clone();
        semantic.provider = EmbeddingProviderDialect::LmStudio;
        semantic.model_id = "local-embedding".into();
        let profile = EmbeddingProfile::new(semantic).unwrap();
        let servers = vec![crate::models::remote::RemoteServer {
            id: "server-one".into(),
            kind: crate::models::remote::ServerKind::LmStudio,
            label: "Local embeddings".into(),
            base_url: "http://127.0.0.1:1234".into(),
            models: vec![crate::models::remote::RemoteModel {
                wire_model: "local-embedding".into(),
                label: "Local embedding".into(),
                context_tokens: 4_096,
                supports_vision: false,
                supports_tools: false,
            }],
        }];
        let reads = std::cell::Cell::new(0);
        let mut context = EmbeddingJobContext::default();

        for _ in 0..3 {
            let resolved = context
                .resolve_http_with(&profile, || {
                    advanced_embedding_endpoint_with(&profile, &servers, |server_id| {
                        reads.set(reads.get() + 1);
                        assert_eq!(server_id, "server-one");
                        Ok(Some(crate::credentials::Secret::from("remote-token")))
                    })
                })
                .unwrap();
            assert_eq!(resolved.endpoint.base_url(), "http://127.0.0.1:1234");
            assert!(resolved.endpoint.has_api_key());
        }

        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn headless_ingestion_reads_a_provider_credential_once_across_batches() {
        let profile = super::super::embedding::mistral_profile("mistral-embed", 1_024).unwrap();
        let reads = std::cell::Cell::new(0);
        let mut context = EmbeddingJobContext::default();

        for _ in 0..3 {
            let resolved = context
                .resolve_http_with(&profile, || {
                    headless_embedding_endpoint_with(&profile, |id| {
                        reads.set(reads.get() + 1);
                        assert_eq!(id, &crate::credentials::CredentialId::Mistral);
                        Ok(Some(crate::credentials::Secret::from("headless-secret")))
                    })
                })
                .unwrap();
            assert_eq!(resolved.endpoint.base_url(), "https://api.mistral.ai");
            assert!(resolved.endpoint.has_api_key());
        }

        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn ingestion_caches_credential_errors_for_the_rest_of_the_job() {
        let profile =
            super::super::embedding::openai_profile("text-embedding-3-small", 1_536).unwrap();
        let reads = std::cell::Cell::new(0);
        let mut context = EmbeddingJobContext::default();

        for _ in 0..3 {
            let result = context.resolve_http_with(&profile, || {
                reads.set(reads.get() + 1);
                Err("credential access denied".into())
            });
            match result {
                Err(error) => assert_eq!(error, "credential access denied"),
                Ok(_) => panic!("a denied credential must not resolve"),
            }
        }

        assert_eq!(reads.get(), 1);
    }
}
