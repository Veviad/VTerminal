//! Durable semantic-search state for local document buckets.
//!
//! `doc_chunks.embedding` is canonical. sqlite-vec tables are derived indexes and
//! may be dropped/rebuilt without losing anything, just like the FTS5 table.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::knowledge::types::ImportedCollectionBinding;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredEmbeddingProfile {
    pub id: String,
    pub fingerprint: String,
    pub profile: serde_json::Value,
    pub created_at: i64,
    pub last_verified_at: Option<i64>,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingChunk {
    pub chunk_id: i64,
    pub bucket_id: String,
    pub file_id: String,
    pub ordinal: u32,
    pub text: String,
    pub title: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SemanticHit {
    pub chunk_id: i64,
    pub file_name: String,
    pub path: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
    pub text: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KnowledgeJob {
    pub id: String,
    pub kind: String,
    pub target_ref: serde_json::Value,
    pub payload: serde_json::Value,
    pub resource_key: Option<String>,
    pub stage: String,
    pub status: String,
    pub completed_items: u32,
    pub total_items: Option<u32>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A user-attested binding for an existing, unmarked Qdrant collection.
///
/// `profile_id` is the local, user-facing profile identity. The serialized binding
/// also carries the immutable fingerprint used for compatibility checks, so a
/// renamed or corrupted profile record cannot silently change the vector space.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredQdrantBinding {
    pub profile_id: String,
    pub binding: ImportedCollectionBinding,
    pub updated_at: i64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Insert an immutable profile, or return the existing identical record.
pub fn put_profile(
    conn: &Connection,
    id: &str,
    fingerprint: &str,
    profile: &serde_json::Value,
    status: &str,
) -> Result<(), String> {
    if !["ready", "unavailable", "needs_key", "failed"].contains(&status) {
        return Err("invalid embedding profile status".into());
    }
    let canonical = serde_json::to_string(profile).map_err(|e| e.to_string())?;
    let existing: Option<(String, String)> = conn
        .query_row(
            "SELECT fingerprint, profile_json FROM knowledge_embedding_profiles WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((old_fingerprint, old_json)) = existing {
        if old_fingerprint != fingerprint || old_json != canonical {
            return Err("embedding profiles are immutable; create a new profile instead".into());
        }
        return Ok(());
    }
    conn.execute(
        "INSERT INTO knowledge_embedding_profiles
           (id, fingerprint, profile_json, created_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, fingerprint, canonical, now_ms(), status],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_profiles(conn: &Connection) -> Result<Vec<StoredEmbeddingProfile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, fingerprint, profile_json, created_at, last_verified_at, status, error
               FROM knowledge_embedding_profiles ORDER BY created_at, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let json: String = r.get(2)?;
            Ok(StoredEmbeddingProfile {
                id: r.get(0)?,
                fingerprint: r.get(1)?,
                profile: serde_json::from_str(&json).unwrap_or(serde_json::Value::Null),
                created_at: r.get(3)?,
                last_verified_at: r.get(4)?,
                status: r.get(5)?,
                error: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Save or update the local interpretation of an external Qdrant collection.
/// This function only writes `docs.db`; callers deliberately perform no metadata,
/// index, or payload mutation against Qdrant as part of guided import.
pub fn put_qdrant_binding(
    conn: &Connection,
    profile_id: &str,
    binding: &ImportedCollectionBinding,
) -> Result<(), String> {
    if profile_id.trim().is_empty() {
        return Err("an imported collection binding needs a profile id".into());
    }
    if !binding.model_attested {
        return Err("the exact original embedding model must be attested".into());
    }
    let profile: Option<(String, String)> = conn
        .query_row(
            "SELECT fingerprint,status FROM knowledge_embedding_profiles WHERE id=?1",
            [profile_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match profile {
        Some((fingerprint, status))
            if fingerprint == binding.embedding_profile_fingerprint && status == "ready" => {}
        Some((fingerprint, _)) if fingerprint != binding.embedding_profile_fingerprint => {
            return Err(
                "the binding fingerprint does not match the selected embedding profile".into(),
            )
        }
        Some(_) => return Err("the selected embedding profile is not ready".into()),
        None => return Err("the selected embedding profile does not exist".into()),
    }
    let mapping = serde_json::to_string(binding).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO knowledge_qdrant_bindings
           (connection_id,collection_name,profile_id,vector_name,payload_mapping_json,
            ownership,compatibility,updated_at)
         VALUES (?1,?2,?3,?4,?5,'external','attach_only',?6)
         ON CONFLICT(connection_id,collection_name) DO UPDATE SET
           profile_id=excluded.profile_id,
           vector_name=excluded.vector_name,
           payload_mapping_json=excluded.payload_mapping_json,
           ownership='external', compatibility='attach_only', updated_at=excluded.updated_at",
        params![
            binding.connection_id,
            binding.collection,
            profile_id,
            binding.vector_name,
            mapping,
            now_ms()
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_qdrant_binding(
    conn: &Connection,
    connection_id: &str,
    collection: &str,
) -> Result<Option<StoredQdrantBinding>, String> {
    conn.query_row(
        "SELECT profile_id,payload_mapping_json,updated_at
           FROM knowledge_qdrant_bindings
          WHERE connection_id=?1 AND collection_name=?2",
        params![connection_id, collection],
        |row| {
            let profile_id: String = row.get(0)?;
            let mapping: String = row.get(1)?;
            let binding = serde_json::from_str(&mapping).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    mapping.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(StoredQdrantBinding {
                profile_id,
                binding,
                updated_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn list_qdrant_bindings(
    conn: &Connection,
    connection_id: Option<&str>,
) -> Result<Vec<StoredQdrantBinding>, String> {
    let (sql, parameter) = match connection_id {
        Some(id) => (
            "SELECT profile_id,payload_mapping_json,updated_at
               FROM knowledge_qdrant_bindings
              WHERE connection_id=?1 ORDER BY collection_name",
            Some(id),
        ),
        None => (
            "SELECT profile_id,payload_mapping_json,updated_at
               FROM knowledge_qdrant_bindings ORDER BY connection_id,collection_name",
            None,
        ),
    };
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<StoredQdrantBinding> {
        let mapping: String = row.get(1)?;
        let binding = serde_json::from_str(&mapping).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                mapping.len(),
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok(StoredQdrantBinding {
            profile_id: row.get(0)?,
            binding,
            updated_at: row.get(2)?,
        })
    };
    let rows = match parameter {
        Some(id) => statement.query_map([id], read),
        None => statement.query_map([], read),
    }
    .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

pub fn delete_qdrant_binding(
    conn: &Connection,
    connection_id: &str,
    collection: &str,
) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM knowledge_qdrant_bindings
          WHERE connection_id=?1 AND collection_name=?2",
        params![connection_id, collection],
    )
    .map(|changed| changed > 0)
    .map_err(|error| error.to_string())
}

pub fn delete_qdrant_bindings_for_connection(
    conn: &Connection,
    connection_id: &str,
) -> Result<u32, String> {
    conn.execute(
        "DELETE FROM knowledge_qdrant_bindings WHERE connection_id=?1",
        [connection_id],
    )
    .map(|changed| changed as u32)
    .map_err(|error| error.to_string())
}

/// Pin a profile to a keyword bucket. Reassigning it to another vector space is
/// deliberately refused; callers must make a new bucket and re-ingest.
pub fn assign_bucket_profile(
    conn: &Connection,
    bucket_id: &str,
    profile_id: &str,
    fingerprint: &str,
    model_id: &str,
    dimension: u32,
) -> Result<(), String> {
    if dimension == 0 || dimension > 65_536 {
        return Err("invalid embedding dimension".into());
    }
    let existing: (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT embedding_profile_id, embedding_fingerprint FROM doc_buckets WHERE id = ?1",
            [bucket_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("unknown bucket: {bucket_id}"),
            other => other.to_string(),
        })?;
    if existing.0.as_deref().is_some_and(|id| id != profile_id)
        || existing.1.as_deref().is_some_and(|fp| fp != fingerprint)
    {
        return Err("this bucket is pinned to a different embedding profile".into());
    }
    conn.execute(
        "UPDATE doc_buckets
            SET embedding_profile_id=?2, embedding_fingerprint=?3,
                embed_model_id=?4, embed_dim=?5, embedding_state='pending',
                embedding_error=NULL
          WHERE id=?1",
        params![bucket_id, profile_id, fingerprint, model_id, dimension],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn pending_chunks(
    conn: &Connection,
    bucket_id: &str,
    limit: usize,
) -> Result<Vec<PendingChunk>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.bucket_id, c.file_id, c.ord, c.text, f.name, c.page, c.heading
               FROM doc_chunks c JOIN doc_files f ON f.id=c.file_id
              WHERE c.bucket_id=?1 AND c.embedding IS NULL
              ORDER BY f.id, c.ord LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![bucket_id, limit.clamp(1, 2048) as i64], |r| {
            Ok(PendingChunk {
                chunk_id: r.get(0)?,
                bucket_id: r.get(1)?,
                file_id: r.get(2)?,
                ordinal: r.get::<_, i64>(3)? as u32,
                text: r.get(4)?,
                title: r.get(5)?,
                page: r.get::<_, Option<i64>>(6)?.map(|v| v as u32),
                heading: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn encode_f32(values: &[f32]) -> Result<Vec<u8>, String> {
    if values.is_empty() || values.iter().any(|v| !v.is_finite()) {
        return Err("an embedding must contain finite values".into());
    }
    let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return Err("an embedding cannot be zero".into());
    }
    let mut out = Vec::with_capacity(values.len() * 4);
    for value in values {
        out.extend_from_slice(&(value / norm).to_le_bytes());
    }
    Ok(out)
}

pub fn decode_f32(blob: &[u8], dimension: usize) -> Result<Vec<f32>, String> {
    if blob.len() != dimension.saturating_mul(4) {
        return Err(format!(
            "embedding has {} bytes; expected {}",
            blob.len(),
            dimension.saturating_mul(4)
        ));
    }
    let values = blob
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect::<Vec<_>>();
    if values.iter().any(|v| !v.is_finite()) {
        return Err("embedding contains a non-finite value".into());
    }
    Ok(values)
}

fn vec_table(dimension: u32) -> Result<String, String> {
    if dimension == 0 || dimension > 65_536 {
        return Err("invalid embedding dimension".into());
    }
    Ok(format!("doc_chunks_vec_{dimension}"))
}

pub fn ensure_vector_index(conn: &Connection, dimension: u32) -> Result<String, String> {
    super::db::register_sqlite_vec();
    let table = vec_table(dimension)?;
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS {table} USING vec0(
             chunk_id INTEGER PRIMARY KEY,
             embedding float[{dimension}],
             profile_fingerprint TEXT PARTITION KEY
         );"
    ))
    .map_err(|e| format!("create sqlite-vec index: {e}"))?;
    Ok(table)
}

/// Remove derived vector rows whose canonical chunk was replaced or deleted.
///
/// vec0 virtual tables cannot participate in the `doc_chunks` foreign-key
/// cascade. Enumerating only our dimension-scoped table prefix keeps this safe
/// across mixed profiles, and failure is non-fatal to the canonical SQLite data.
pub fn prune_vector_indexes(conn: &Connection) -> Result<u32, String> {
    let mut statement = conn
        .prepare(
            "SELECT name FROM sqlite_master
              WHERE type='table' AND name GLOB 'doc_chunks_vec_[0-9]*'",
        )
        .map_err(|error| error.to_string())?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let mut removed = 0u32;
    for table in tables {
        // Names came from sqlite_master and must still match the strict prefix
        // plus decimal dimension before they may be interpolated as identifiers.
        let Some(dimension) = table.strip_prefix("doc_chunks_vec_") else {
            continue;
        };
        if dimension.is_empty() || !dimension.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        removed = removed.saturating_add(
            conn.execute(
                &format!(
                    "DELETE FROM {table}
                      WHERE chunk_id NOT IN (SELECT id FROM doc_chunks)"
                ),
                [],
            )
            .map_err(|error| format!("prune {table}: {error}"))? as u32,
        );
    }
    Ok(removed)
}

/// Write canonical blobs and their derived sqlite-vec rows atomically.
pub fn put_embeddings(
    conn: &mut Connection,
    bucket_id: &str,
    fingerprint: &str,
    dimension: u32,
    rows: &[(i64, Vec<f32>)],
) -> Result<(), String> {
    let table = ensure_vector_index(conn, dimension)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (chunk_id, values) in rows {
        if values.len() != dimension as usize {
            return Err(format!(
                "chunk {chunk_id} returned {} dimensions; expected {dimension}",
                values.len()
            ));
        }
        let blob = encode_f32(values)?;
        let changed = tx
            .execute(
                "UPDATE doc_chunks SET embedding=?3 WHERE id=?1 AND bucket_id=?2",
                params![chunk_id, bucket_id, blob],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("chunk {chunk_id} is not in bucket {bucket_id}"));
        }
        tx.execute(
            &format!("DELETE FROM {table} WHERE chunk_id=?1"),
            [chunk_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            &format!(
                "INSERT INTO {table} (chunk_id, embedding, profile_fingerprint)
                 VALUES (?1, ?2, ?3)"
            ),
            params![chunk_id, blob, fingerprint],
        )
        .map_err(|e| e.to_string())?;
    }
    let pending: i64 = tx
        .query_row(
            "SELECT count(*) FROM doc_chunks WHERE bucket_id=?1 AND embedding IS NULL",
            [bucket_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE doc_buckets SET embedding_state=?2, embedding_error=NULL WHERE id=?1",
        params![bucket_id, if pending == 0 { "ready" } else { "pending" }],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn rebuild_vector_index(
    conn: &Connection,
    fingerprint: &str,
    dimension: u32,
) -> Result<u32, String> {
    let table = ensure_vector_index(conn, dimension)?;
    conn.execute(
        &format!("DELETE FROM {table} WHERE profile_fingerprint=?1"),
        [fingerprint],
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.embedding FROM doc_chunks c
               JOIN doc_buckets b ON b.id=c.bucket_id
              WHERE b.embedding_fingerprint=?1 AND b.embed_dim=?2
                AND c.embedding IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![fingerprint, dimension], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for (chunk_id, blob) in &rows {
        decode_f32(blob, dimension as usize)?;
        conn.execute(
            &format!(
                "INSERT INTO {table} (chunk_id, embedding, profile_fingerprint)
                 VALUES (?1, ?2, ?3)"
            ),
            params![chunk_id, blob, fingerprint],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(rows.len() as u32)
}

pub fn search_cosine(
    conn: &Connection,
    bucket_ids: &[String],
    fingerprint: &str,
    dimension: u32,
    query: &[f32],
    limit: usize,
) -> Result<Vec<SemanticHit>, String> {
    if bucket_ids.is_empty() {
        return Ok(Vec::new());
    }
    if query.len() != dimension as usize {
        return Err("query embedding dimension does not match the bucket profile".into());
    }
    let table = ensure_vector_index(conn, dimension)?;
    let blob = encode_f32(query)?;
    let placeholders = (0..bucket_ids.len())
        .map(|i| format!("?{}", i + 4))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT v.chunk_id, f.name, f.path, c.page, c.heading, c.text, v.distance
           FROM {table} v
           JOIN doc_chunks c ON c.id=v.chunk_id
           JOIN doc_files f ON f.id=c.file_id
          WHERE v.embedding MATCH ?1 AND k=?2
            AND v.profile_fingerprint=?3
            AND c.bucket_id IN ({placeholders})
          ORDER BY v.distance"
    );
    let k = (limit.clamp(1, 100) * 4).min(400) as i64;
    let mut values: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Blob(blob),
        rusqlite::types::Value::Integer(k),
        rusqlite::types::Value::Text(fingerprint.to_string()),
    ];
    values.extend(bucket_ids.iter().cloned().map(rusqlite::types::Value::Text));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values), |r| {
            let distance: f64 = r.get(6)?;
            Ok(SemanticHit {
                chunk_id: r.get(0)?,
                file_name: r.get(1)?,
                path: r.get(2)?,
                page: r.get::<_, Option<i64>>(3)?.map(|v| v as u32),
                heading: r.get(4)?,
                text: r.get(5)?,
                score: 1.0 - distance,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut hits = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    // vec0 requires distance to be the sole ORDER BY expression in a KNN
    // query. Resolve exact-distance ties after retrieval so mixed-source rank
    // fusion remains deterministic without violating that constraint.
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.chunk_id.cmp(&right.chunk_id))
    });
    hits.truncate(limit.clamp(1, 100));
    Ok(hits)
}

pub fn put_job(conn: &Connection, job: &KnowledgeJob) -> Result<(), String> {
    conn.execute(
        "INSERT INTO knowledge_jobs
           (id,kind,target_ref_json,payload_json,resource_key,stage,status,completed_items,
            total_items,error,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,
           resource_key=excluded.resource_key,stage=excluded.stage,
           status=CASE
             WHEN knowledge_jobs.status IN ('cancelling','cancelled')
              AND excluded.status <> 'queued'
             THEN knowledge_jobs.status
             ELSE excluded.status
           END,
           completed_items=excluded.completed_items,total_items=excluded.total_items,
           error=excluded.error,updated_at=excluded.updated_at",
        params![
            job.id,
            job.kind,
            job.target_ref.to_string(),
            job.payload.to_string(),
            job.resource_key,
            job.stage,
            job.status,
            job.completed_items,
            job.total_items,
            job.error,
            job.created_at,
            job.updated_at
        ],
    )
    .map_err(|e| {
        let message = e.to_string();
        if message.contains("knowledge_jobs.resource_key") {
            "another ingestion job is already active for this bucket or document".into()
        } else {
            message
        }
    })?;
    Ok(())
}

pub fn list_jobs(conn: &Connection) -> Result<Vec<KnowledgeJob>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,kind,target_ref_json,payload_json,resource_key,stage,status,
                    completed_items,total_items,error,created_at,updated_at
               FROM knowledge_jobs ORDER BY updated_at DESC, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let target: String = r.get(2)?;
            let payload: String = r.get(3)?;
            Ok(KnowledgeJob {
                id: r.get(0)?,
                kind: r.get(1)?,
                target_ref: serde_json::from_str(&target).unwrap_or_default(),
                payload: serde_json::from_str(&payload).unwrap_or_default(),
                resource_key: r.get(4)?,
                stage: r.get(5)?,
                status: r.get(6)?,
                completed_items: r.get::<_, i64>(7)? as u32,
                total_items: r.get::<_, Option<i64>>(8)?.map(|v| v as u32),
                error: r.get(9)?,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        super::super::db::register_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        super::super::db::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn encoding_normalizes_and_rejects_bad_values() {
        let blob = encode_f32(&[3.0, 4.0]).unwrap();
        let values = decode_f32(&blob, 2).unwrap();
        assert!((values[0] - 0.6).abs() < 1e-6);
        assert!((values[1] - 0.8).abs() < 1e-6);
        assert!(encode_f32(&[0.0, 0.0]).is_err());
        assert!(encode_f32(&[f32::NAN]).is_err());
    }

    #[test]
    fn profiles_are_immutable() {
        let conn = db();
        let a = serde_json::json!({"model":"a"});
        put_profile(&conn, "p", "f", &a, "ready").unwrap();
        put_profile(&conn, "p", "f", &a, "ready").unwrap();
        assert!(put_profile(&conn, "p", "other", &a, "ready").is_err());
        assert_eq!(list_profiles(&conn).unwrap().len(), 1);
    }

    #[test]
    fn imported_qdrant_bindings_round_trip_and_can_be_replaced_locally() {
        let conn = db();
        put_profile(
            &conn,
            "profile-a",
            "sha256:exact",
            &serde_json::json!({"semantic": "fixture"}),
            "ready",
        )
        .unwrap();
        let mut binding = ImportedCollectionBinding {
            connection_id: "cluster-a".into(),
            collection: "existing-docs".into(),
            vector_name: "dense".into(),
            embedding_profile_fingerprint: "sha256:exact".into(),
            text_field: "body.text".into(),
            document_id_field: "document.id".into(),
            title_field: Some("title".into()),
            source_uri_field: None,
            page_field: Some("page".into()),
            heading_field: None,
            model_attested: true,
        };
        put_qdrant_binding(&conn, "profile-a", &binding).unwrap();
        let stored = get_qdrant_binding(&conn, "cluster-a", "existing-docs")
            .unwrap()
            .unwrap();
        assert_eq!(stored.profile_id, "profile-a");
        assert_eq!(stored.binding, binding);

        binding.heading_field = Some("section.heading".into());
        put_qdrant_binding(&conn, "profile-a", &binding).unwrap();
        assert_eq!(
            list_qdrant_bindings(&conn, Some("cluster-a")).unwrap()[0]
                .binding
                .heading_field
                .as_deref(),
            Some("section.heading")
        );
        assert!(delete_qdrant_binding(&conn, "cluster-a", "existing-docs").unwrap());
        assert!(get_qdrant_binding(&conn, "cluster-a", "existing-docs")
            .unwrap()
            .is_none());
    }

    #[test]
    fn sqlite_vec_index_is_rebuildable_and_scoped() {
        let mut conn = db();
        conn.execute(
            "INSERT INTO doc_buckets
               (id,label,created_at,chunk_chars,chunk_overlap,embedding_profile_id,
                embedding_fingerprint,embedding_state,embed_dim)
             VALUES ('b','B',0,1000,150,'p','fp','pending',2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO doc_files
               (id,bucket_id,path,name,media_type,size_bytes,mtime_ms,state)
             VALUES ('f','b','/x','x','text/plain',1,0,'indexed')",
            [],
        )
        .unwrap();
        for (ord, text) in [(0, "north"), (1, "east")] {
            conn.execute(
                "INSERT INTO doc_chunks(file_id,bucket_id,ord,text,text_sha256)
                 VALUES ('f','b',?1,?2,'h')",
                params![ord, text],
            )
            .unwrap();
        }
        let ids = conn
            .prepare("SELECT id FROM doc_chunks ORDER BY ord")
            .unwrap()
            .query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        put_embeddings(
            &mut conn,
            "b",
            "fp",
            2,
            &[(ids[0], vec![1.0, 0.0]), (ids[1], vec![0.0, 1.0])],
        )
        .unwrap();
        let hits = search_cosine(&conn, &["b".into()], "fp", 2, &[1.0, 0.0], 2).unwrap();
        assert_eq!(hits[0].text, "north");
        assert_eq!(rebuild_vector_index(&conn, "fp", 2).unwrap(), 2);
    }
}
