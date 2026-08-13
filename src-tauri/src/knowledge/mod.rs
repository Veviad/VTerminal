//! Unified knowledge buckets.
//!
//! This module deliberately has no Tauri dependencies.  The desktop commands and
//! the standalone `vterminal-docs` binary can therefore share the same Qdrant
//! contract and HTTP client without either transport becoming the source of
//! truth.

pub mod contract;
pub mod embedding;
pub mod ingest;
pub mod local;
pub mod process_lock;
pub mod qdrant;
pub mod search;
pub mod store;
pub mod types;

pub use contract::{
    classify_collection, collection_metadata, stable_chunk_point_id, stable_manifest_point_id,
    CompatibilityContext,
};
pub use qdrant::{QdrantClient, QdrantEndpoint, QdrantError};
pub use types::*;
