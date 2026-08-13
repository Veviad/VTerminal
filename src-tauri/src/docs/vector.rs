//! Exact local vector retrieval over `doc_chunks.embedding`.
//!
//! The blob is canonical little-endian `f32`, L2-normalized at insertion. Exact
//! scanning is intentional for the first semantic-search implementation: it keeps
//! the existing SQLite file self-contained and makes every vector rebuildable from
//! the canonical blob. A future sqlite-vec index can accelerate candidate selection
//! without changing these validation or ranking semantics.

use rusqlite::{Connection, ToSql};
use std::collections::HashMap;

pub const MAX_EMBEDDING_DIMENSIONS: usize = 65_536;
pub const RRF_K: f64 = 60.0;
const UNIT_NORM_TOLERANCE: f64 = 1e-3;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum VectorError {
    #[error("embedding must contain at least one dimension")]
    Empty,
    #[error("embedding dimension {0} exceeds the supported limit")]
    TooLarge(usize),
    #[error("embedding component {index} is not finite")]
    NonFinite { index: usize },
    #[error("embedding is a zero vector")]
    Zero,
    #[error("embedding blob has {bytes} bytes; expected {expected}")]
    BlobLength { bytes: usize, expected: usize },
    #[error("embedding is not normalized (L2 norm {norm})")]
    NotNormalized { norm: f64 },
}

/// Normalize and encode a vector in the on-disk schema's canonical byte order.
pub fn encode_normalized_f32(vector: &[f32]) -> Result<Vec<u8>, VectorError> {
    validate_dimensions(vector.len())?;
    let norm = norm(vector)?;
    if norm <= f64::EPSILON {
        return Err(VectorError::Zero);
    }

    let mut bytes = Vec::with_capacity(std::mem::size_of_val(vector));
    for value in vector {
        bytes.extend_from_slice(&((f64::from(*value) / norm) as f32).to_le_bytes());
    }
    Ok(bytes)
}

/// Decode a canonical embedding and fail closed on corruption or profile drift.
pub fn decode_normalized_f32(blob: &[u8], dimensions: usize) -> Result<Vec<f32>, VectorError> {
    validate_dimensions(dimensions)?;
    let expected = dimensions * size_of::<f32>();
    if blob.len() != expected {
        return Err(VectorError::BlobLength {
            bytes: blob.len(),
            expected,
        });
    }

    let mut vector = Vec::with_capacity(dimensions);
    for (index, bytes) in blob.chunks_exact(size_of::<f32>()).enumerate() {
        let value = f32::from_le_bytes(bytes.try_into().expect("chunks_exact is four bytes"));
        if !value.is_finite() {
            return Err(VectorError::NonFinite { index });
        }
        vector.push(value);
    }
    let norm = norm(&vector)?;
    if norm <= f64::EPSILON {
        return Err(VectorError::Zero);
    }
    if (norm - 1.0).abs() > UNIT_NORM_TOLERANCE {
        return Err(VectorError::NotNormalized { norm });
    }
    Ok(vector)
}

fn validate_dimensions(dimensions: usize) -> Result<(), VectorError> {
    if dimensions == 0 {
        Err(VectorError::Empty)
    } else if dimensions > MAX_EMBEDDING_DIMENSIONS {
        Err(VectorError::TooLarge(dimensions))
    } else {
        Ok(())
    }
}

fn norm(vector: &[f32]) -> Result<f64, VectorError> {
    let mut squared = 0.0f64;
    for (index, value) in vector.iter().enumerate() {
        if !value.is_finite() {
            return Err(VectorError::NonFinite { index });
        }
        squared += f64::from(*value) * f64::from(*value);
    }
    Ok(squared.sqrt())
}

fn normalize_query(vector: &[f32]) -> Result<Vec<f32>, VectorError> {
    validate_dimensions(vector.len())?;
    let norm = norm(vector)?;
    if norm <= f64::EPSILON {
        return Err(VectorError::Zero);
    }
    Ok(vector
        .iter()
        .map(|value| (f64::from(*value) / norm) as f32)
        .collect())
}

fn dot(left: &[f32], right: &[f32]) -> f64 {
    left.iter()
        .zip(right)
        .map(|(left, right)| f64::from(*left) * f64::from(*right))
        .sum()
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorSearchHit {
    pub chunk_id: i64,
    pub file_name: String,
    pub path: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
    pub text: String,
    pub score: f64,
}

/// Brute-force cosine top-k over the selected buckets.
///
/// A corrupt blob fails this source rather than being silently omitted. The unified
/// search layer can then return other local/remote sources with a visible partial-
/// search warning, instead of presenting incomplete retrieval as complete.
pub fn search_cosine(
    conn: &Connection,
    bucket_ids: &[String],
    query: &[f32],
    limit: usize,
) -> Result<Vec<VectorSearchHit>, String> {
    if bucket_ids.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let query = normalize_query(query).map_err(|error| error.to_string())?;
    let sql = format!(
        "SELECT c.id, f.name, f.path, c.page, c.heading, c.text, c.embedding
           FROM doc_chunks c
           JOIN doc_files f ON f.id = c.file_id
          WHERE c.embedding IS NOT NULL
            AND c.bucket_id IN ({})",
        placeholders(bucket_ids.len())
    );
    let params: Vec<&dyn ToSql> = bucket_ids.iter().map(|id| id as &dyn ToSql).collect();
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params.as_slice(), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Vec<u8>>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut hits = Vec::new();
    for row in rows {
        let (chunk_id, file_name, path, page, heading, text, blob) =
            row.map_err(|error| error.to_string())?;
        let vector = decode_normalized_f32(&blob, query.len())
            .map_err(|error| format!("invalid embedding for chunk {chunk_id}: {error}"))?;
        hits.push(VectorSearchHit {
            chunk_id,
            file_name,
            path,
            page: page.map(|page| page as u32),
            heading,
            text,
            score: dot(&query, &vector),
        });
    }

    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then(left.chunk_id.cmp(&right.chunk_id))
    });
    hits.truncate(limit);
    Ok(hits)
}

fn placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FusedRank {
    pub chunk_id: i64,
    pub score: f64,
}

/// Fuse independently ranked BM25/vector/Qdrant lists without comparing raw scores.
///
/// Duplicate ids inside one arm count once at their first rank. This makes the
/// helper robust to a provider briefly returning duplicate points during a staged
/// document revision.
pub fn reciprocal_rank_fusion_ids(lists: &[Vec<i64>], limit: usize) -> Vec<FusedRank> {
    use std::collections::HashSet;

    let mut scores: HashMap<i64, f64> = HashMap::new();
    for list in lists {
        let mut seen = HashSet::new();
        for (rank, chunk_id) in list.iter().copied().enumerate() {
            if seen.insert(chunk_id) {
                *scores.entry(chunk_id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64 + 1.0);
            }
        }
    }
    let mut fused: Vec<FusedRank> = scores
        .into_iter()
        .map(|(chunk_id, score)| FusedRank { chunk_id, score })
        .collect();
    fused.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then(left.chunk_id.cmp(&right.chunk_id))
    });
    fused.truncate(limit);
    fused
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE doc_files (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL
             );
             CREATE TABLE doc_chunks (
                id INTEGER PRIMARY KEY,
                file_id TEXT NOT NULL,
                bucket_id TEXT NOT NULL,
                page INTEGER,
                heading TEXT,
                text TEXT NOT NULL,
                embedding BLOB
             );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, chunk_id: i64, bucket: &str, text: &str, vector: Option<&[f32]>) {
        let file = format!("file-{chunk_id}");
        conn.execute(
            "INSERT INTO doc_files (id, name, path) VALUES (?1, ?2, ?3)",
            rusqlite::params![file, format!("{file}.md"), format!("/tmp/{file}.md")],
        )
        .unwrap();
        let blob = vector.map(|vector| encode_normalized_f32(vector).unwrap());
        conn.execute(
            "INSERT INTO doc_chunks
                (id, file_id, bucket_id, page, heading, text, embedding)
             VALUES (?1, ?2, ?3, 2, 'Heading', ?4, ?5)",
            rusqlite::params![chunk_id, file, bucket, text, blob],
        )
        .unwrap();
    }

    #[test]
    fn blob_round_trip_is_little_endian_and_normalized() {
        let blob = encode_normalized_f32(&[3.0, 4.0]).unwrap();
        assert_eq!(&blob[..4], &0.6f32.to_le_bytes());
        assert_eq!(&blob[4..], &0.8f32.to_le_bytes());
        assert_eq!(decode_normalized_f32(&blob, 2).unwrap(), [0.6, 0.8]);
    }

    #[test]
    fn blobs_fail_closed_on_corruption_or_profile_mismatch() {
        assert_eq!(
            decode_normalized_f32(&[0; 7], 2),
            Err(VectorError::BlobLength {
                bytes: 7,
                expected: 8
            })
        );
        assert!(
            decode_normalized_f32(&[1.0f32.to_le_bytes(), 0.0f32.to_le_bytes()].concat(), 2)
                .is_ok()
        );
        assert!(matches!(
            decode_normalized_f32(&[2.0f32.to_le_bytes(), 0.0f32.to_le_bytes()].concat(), 2),
            Err(VectorError::NotNormalized { .. })
        ));
        assert!(encode_normalized_f32(&[f32::NAN]).is_err());
        assert!(encode_normalized_f32(&[0.0, 0.0]).is_err());
    }

    #[test]
    fn exact_cosine_filters_buckets_and_has_deterministic_ties() {
        let conn = db();
        insert(&conn, 10, "wanted", "exact", Some(&[1.0, 0.0]));
        insert(&conn, 11, "wanted", "near", Some(&[0.8, 0.2]));
        insert(&conn, 12, "wanted", "opposite", Some(&[-1.0, 0.0]));
        insert(&conn, 8, "wanted", "tie first by id", Some(&[0.0, 1.0]));
        insert(&conn, 9, "wanted", "tie second by id", Some(&[0.0, 1.0]));
        insert(&conn, 1, "other", "excluded", Some(&[1.0, 0.0]));
        insert(&conn, 20, "wanted", "keyword only", None);

        let hits = search_cosine(&conn, &["wanted".into()], &[5.0, 0.0], 5).unwrap();
        assert_eq!(
            hits.iter().map(|hit| hit.chunk_id).collect::<Vec<_>>(),
            [10, 11, 8, 9, 12]
        );
        assert!((hits[0].score - 1.0).abs() < 1e-6);
        assert!((hits[4].score + 1.0).abs() < 1e-6);
    }

    #[test]
    fn exact_cosine_surfaces_a_corrupt_chunk() {
        let conn = db();
        insert(&conn, 1, "bucket", "valid", Some(&[1.0, 0.0]));
        insert(&conn, 2, "bucket", "corrupt", Some(&[1.0, 0.0]));
        conn.execute("UPDATE doc_chunks SET embedding = x'0000' WHERE id = 2", [])
            .unwrap();
        let error = search_cosine(&conn, &["bucket".into()], &[1.0, 0.0], 5).unwrap_err();
        assert!(error.contains("chunk 2"));
    }

    #[test]
    fn rrf_rewards_cross_arm_agreement_without_score_comparison() {
        let fused = reciprocal_rank_fusion_ids(&[vec![1, 2, 3], vec![3, 2, 4]], 4);
        assert_eq!(
            fused.iter().map(|hit| hit.chunk_id).collect::<Vec<_>>(),
            [3, 2, 1, 4]
        );
        assert!(fused[0].score > fused[2].score);
    }

    #[test]
    fn rrf_counts_a_duplicate_once_and_breaks_ties_by_id() {
        let fused = reciprocal_rank_fusion_ids(&[vec![7, 7, 9], vec![8]], 10);
        assert_eq!(
            fused.iter().map(|hit| hit.chunk_id).collect::<Vec<_>>(),
            [7, 8, 9]
        );
        assert_eq!(fused[0].score, fused[1].score);
    }
}
