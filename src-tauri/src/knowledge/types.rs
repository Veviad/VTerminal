use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::embedding::EmbeddingProfile;

pub const VTERMINAL_CONTRACT_VERSION: u32 = 1;
pub const VTERMINAL_PAYLOAD_SCHEMA_VERSION: u32 = 1;
pub const VTERMINAL_CHUNK_PIPELINE_VERSION: u32 = 1;
pub const VTERMINAL_VECTOR_NAME: &str = "content";
pub const QDRANT_MANAGED_MIN_VERSION: &str = "1.16.0";
pub const QDRANT_TURBO_QUANT_MIN_VERSION: &str = "1.18.0";

/// A bucket identity that cannot accidentally collide across backends.
///
/// Keep this wire shape in sync with `src/lib/types.ts`.  In particular, this is
/// internally tagged so the frontend receives `{ source: "local", bucket_id }`
/// rather than Rust's default externally-tagged enum representation.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum KnowledgeBucketRef {
    Local {
        bucket_id: String,
    },
    Qdrant {
        connection_id: String,
        collection: String,
    },
}

impl KnowledgeBucketRef {
    pub fn display_name(&self) -> &str {
        match self {
            Self::Local { bucket_id } => bucket_id,
            Self::Qdrant { collection, .. } => collection,
        }
    }
}

/// Safe, frontend-facing Qdrant connection data.  The key is intentionally not
/// representable by this type, which prevents an innocent read command from
/// leaking it over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QdrantConnection {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub has_api_key: bool,
    #[serde(default)]
    pub allow_insecure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VterminalCollectionMetadata {
    pub contract_version: u32,
    pub owner: String,
    pub embedding_profile: EmbeddingProfile,
    pub embedding_profile_fingerprint: String,
    pub vector_name: String,
    pub payload_schema_version: u32,
    pub chunk_pipeline_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionCompatibility {
    ManagedCompatible,
    AttachOnly,
    NeedsGuidedImport,
    UpgradeRequired,
    Incompatible,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionAccess {
    /// No write probe was performed and no prior operation established access.
    Unknown,
    ReadOnly,
    PointsReadWrite,
    Manage,
}

impl CollectionAccess {
    pub fn can_write_points(self) -> bool {
        matches!(self, Self::PointsReadWrite | Self::Manage)
    }

    pub fn can_manage(self) -> bool {
        matches!(self, Self::Manage)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VectorDescriptor {
    /// Empty means Qdrant's unnamed/default vector.
    pub name: String,
    pub size: u32,
    pub distance: String,
    pub data_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurboQuantBits {
    #[serde(rename = "bits4")]
    Bits4,
    #[serde(rename = "bits2")]
    Bits2,
    #[serde(rename = "bits1_5")]
    Bits1_5,
    #[serde(rename = "bits1")]
    Bits1,
}

impl TurboQuantBits {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bits4 => "bits4",
            Self::Bits2 => "bits2",
            Self::Bits1_5 => "bits1_5",
            Self::Bits1 => "bits1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurboQuantConfig {
    pub bits: TurboQuantBits,
    pub always_ram: bool,
}

impl Default for TurboQuantConfig {
    fn default() -> Self {
        Self {
            bits: TurboQuantBits::Bits4,
            always_ram: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum QuantizationStatus {
    Off,
    Turbo {
        bits: TurboQuantBits,
        always_ram: bool,
    },
    Other {
        kind: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QdrantCollectionInfo {
    pub name: String,
    pub status: String,
    pub points_count: u64,
    pub indexed_vectors_count: u64,
    pub vectors: Vec<VectorDescriptor>,
    pub payload_indexes: BTreeSet<String>,
    pub payload_index_types: BTreeMap<String, String>,
    pub metadata: Option<VterminalCollectionMetadata>,
    pub quantization: QuantizationStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeBucketDescriptor {
    pub bucket: KnowledgeBucketRef,
    pub name: String,
    pub points_count: u64,
    pub indexed_vectors_count: u64,
    pub compatibility: CollectionCompatibility,
    pub compatibility_reason: String,
    pub access: CollectionAccess,
    pub embedding_profile: Option<EmbeddingProfile>,
    pub vector_name: Option<String>,
    pub vector_size: Option<u32>,
    pub quantization: QuantizationStatus,
    /// Empty buckets may be managed but are not offered in the attachment picker.
    pub attachable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QdrantServerCapabilities {
    pub managed_collections: bool,
    pub turbo_quant: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QdrantServerInfo {
    pub title: String,
    pub version: String,
    pub commit: Option<String>,
    pub capabilities: QdrantServerCapabilities,
}

/// Qdrant point ids are either unsigned integers or strings (usually UUIDs).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PointId {
    Number(u64),
    String(String),
}

impl fmt::Display for PointId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(value) => value.fmt(formatter),
            Self::String(value) => value.fmt(formatter),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentState {
    Staging,
    Active,
}

impl DocumentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::Active => "active",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentManifest {
    pub document_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub revision: u64,
    pub state: DocumentState,
    pub content_sha256: String,
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    pub chunk_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentChunk {
    pub document_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub revision: u64,
    pub state: DocumentState,
    pub content_sha256: String,
    pub chunk_index: u32,
    pub text: String,
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentMetadataUpdate {
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentSummary {
    pub point_id: PointId,
    pub manifest: DocumentManifest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentPage {
    pub documents: Vec<DocumentSummary>,
    pub next_cursor: Option<PointId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KnowledgeHit {
    pub bucket: KnowledgeBucketRef,
    pub document_id: String,
    /// Globally qualified (`qdrant:<connection>:<collection>:<point>`).
    pub chunk_id: String,
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
    pub revision: u64,
    pub text: String,
    pub score: f64,
}

/// Result wrapper used when an endpoint returns a point operation id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationReceipt {
    pub status: String,
    pub operation_id: Option<u64>,
}

/// Payload bindings for guided import.  It is intentionally explicit: an
/// embedding model is never inferred from a vector's dimension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedCollectionBinding {
    pub connection_id: String,
    pub collection: String,
    pub vector_name: String,
    pub embedding_profile_fingerprint: String,
    pub text_field: String,
    pub document_id_field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_uri_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_field: Option<String>,
    pub model_attested: bool,
}

/// Retained for import payload samples whose user-defined fields are not known at
/// compile time.  Managed collections use typed payload structs instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PayloadSample {
    pub point_id: PointId,
    pub payload: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_ref_has_the_frontend_wire_shape() {
        assert_eq!(
            serde_json::to_value(KnowledgeBucketRef::Local {
                bucket_id: "manuals".into()
            })
            .unwrap(),
            serde_json::json!({"source": "local", "bucket_id": "manuals"})
        );
        assert_eq!(
            serde_json::to_value(KnowledgeBucketRef::Qdrant {
                connection_id: "prod".into(),
                collection: "runbooks".into()
            })
            .unwrap(),
            serde_json::json!({
                "source": "qdrant",
                "connection_id": "prod",
                "collection": "runbooks"
            })
        );
    }
}
