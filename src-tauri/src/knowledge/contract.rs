//! VTerminal's versioned Qdrant collection and point contract.

use std::collections::{BTreeSet, HashMap};

use chrono::DateTime;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::embedding::EmbeddingProfile;
use super::types::{
    CollectionAccess, CollectionCompatibility, DocumentChunk, DocumentManifest, DocumentState,
    ImportedCollectionBinding, KnowledgeBucketDescriptor, KnowledgeBucketRef, PointId,
    QdrantCollectionInfo, VterminalCollectionMetadata, QDRANT_MANAGED_MIN_VERSION,
    VTERMINAL_CHUNK_PIPELINE_VERSION, VTERMINAL_CONTRACT_VERSION, VTERMINAL_PAYLOAD_SCHEMA_VERSION,
    VTERMINAL_VECTOR_NAME,
};

pub const PAYLOAD_TYPE_FIELD: &str = "_vterminal.type";
pub const PAYLOAD_DOCUMENT_ID_FIELD: &str = "_vterminal.document_id";
pub const PAYLOAD_SOURCE_ID_FIELD: &str = "_vterminal.source_id";
pub const PAYLOAD_REVISION_FIELD: &str = "_vterminal.revision";
pub const PAYLOAD_STATE_FIELD: &str = "_vterminal.state";

pub const REQUIRED_PAYLOAD_INDEXES: [&str; 5] = [
    PAYLOAD_TYPE_FIELD,
    PAYLOAD_DOCUMENT_ID_FIELD,
    PAYLOAD_SOURCE_ID_FIELD,
    PAYLOAD_REVISION_FIELD,
    PAYLOAD_STATE_FIELD,
];

/// Return every required managed payload index whose presence or schema type
/// has drifted from the VTerminal contract. Qdrant may expose an index name
/// while omitting its type; that is not sufficient for filtered managed
/// operations and is therefore treated as drift too.
pub(crate) fn required_payload_index_drift(collection: &QdrantCollectionInfo) -> Vec<String> {
    REQUIRED_PAYLOAD_INDEXES
        .iter()
        .filter_map(|field| {
            let expected = required_payload_index_type(field);
            if !collection.payload_indexes.contains(*field) {
                return Some(format!("{field} (missing; expected {expected})"));
            }

            match collection.payload_index_types.get(*field) {
                Some(actual) if actual.eq_ignore_ascii_case(expected) => None,
                Some(actual) if actual.trim().is_empty() => {
                    Some(format!("{field} (unknown; expected {expected})"))
                }
                Some(actual) => Some(format!("{field} (found {actual}; expected {expected})")),
                None => Some(format!("{field} (unknown; expected {expected})")),
            }
        })
        .collect()
}

fn required_payload_index_type(field: &str) -> &'static str {
    if field == PAYLOAD_REVISION_FIELD {
        "integer"
    } else {
        "keyword"
    }
}

pub const POINT_TYPE_MANIFEST: &str = "manifest";
pub const POINT_TYPE_CHUNK: &str = "chunk";

#[derive(Debug, Serialize)]
pub(crate) struct ContractPoint {
    pub id: PointId,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PointIdentity {
    #[serde(rename = "type")]
    point_type: String,
    document_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    revision: u64,
    state: DocumentState,
    content_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    chunk_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestPayload {
    #[serde(rename = "_vterminal")]
    identity: PointIdentity,
    title: String,
    source_uri: String,
    mime_type: String,
    chunk_count: u32,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChunkPayload {
    #[serde(rename = "_vterminal")]
    identity: PointIdentity,
    text: String,
    title: String,
    source_uri: String,
    mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    heading: Option<String>,
    created_at: String,
    updated_at: String,
}

/// Inputs required to decide whether a discovered collection may be attached.
/// `access` is learned from prior real operations or a key policy hint; discovery
/// itself never mutates a collection just to probe permissions.
pub struct CompatibilityContext<'a> {
    pub connection_id: &'a str,
    pub server_version: Option<&'a Version>,
    pub runnable_profiles: &'a [EmbeddingProfile],
    pub access: CollectionAccess,
    pub imported_binding: Option<&'a ImportedCollectionBinding>,
}

pub fn collection_metadata(profile: &EmbeddingProfile) -> VterminalCollectionMetadata {
    VterminalCollectionMetadata {
        contract_version: VTERMINAL_CONTRACT_VERSION,
        owner: "vterminal".into(),
        embedding_profile: profile.clone(),
        embedding_profile_fingerprint: profile.fingerprint().into(),
        vector_name: VTERMINAL_VECTOR_NAME.into(),
        payload_schema_version: VTERMINAL_PAYLOAD_SCHEMA_VERSION,
        chunk_pipeline_version: VTERMINAL_CHUNK_PIPELINE_VERSION,
    }
}

pub(crate) fn metadata_value(profile: &EmbeddingProfile) -> Value {
    json!({ "vterminal": collection_metadata(profile) })
}

/// Deterministic UUID-shaped point id for a document's one vectorless manifest.
pub fn stable_manifest_point_id(document_id: &str, revision: u64) -> PointId {
    stable_point_id(&[b"manifest", document_id.as_bytes(), &revision.to_be_bytes()])
}

/// Deterministic UUID-shaped point id for a chunk revision.  Repeating an
/// interrupted upload overwrites the same point, while a replacement revision
/// never clobbers an active old chunk.
pub fn stable_chunk_point_id(document_id: &str, revision: u64, chunk_index: u32) -> PointId {
    stable_point_id(&[
        b"chunk",
        document_id.as_bytes(),
        &revision.to_be_bytes(),
        &chunk_index.to_be_bytes(),
    ])
}

fn stable_point_id(parts: &[&[u8]]) -> PointId {
    let mut digest = Sha256::new();
    digest.update(b"vterminal:qdrant-point:v1\0");
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    let hash = digest.finalize();
    let mut id = [0_u8; 16];
    id.copy_from_slice(&hash[..16]);
    // RFC 4122 variant plus a v5 marker.  SHA-256, rather than SHA-1, supplies
    // the bytes; Qdrant only requires a syntactically valid UUID string.
    id[6] = (id[6] & 0x0f) | 0x50;
    id[8] = (id[8] & 0x3f) | 0x80;
    PointId::String(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7], id[8], id[9], id[10],
        id[11], id[12], id[13], id[14], id[15]
    ))
}

pub(crate) fn manifest_point(manifest: &DocumentManifest) -> Result<ContractPoint, String> {
    validate_manifest(manifest)?;
    let identity = PointIdentity {
        point_type: POINT_TYPE_MANIFEST.into(),
        document_id: manifest.document_id.clone(),
        source_id: manifest.source_id.clone(),
        revision: manifest.revision,
        state: manifest.state,
        content_sha256: manifest.content_sha256.to_ascii_lowercase(),
        chunk_index: None,
    };
    let payload = serde_json::to_value(ManifestPayload {
        identity,
        title: manifest.title.clone(),
        source_uri: manifest.source_uri.clone(),
        mime_type: manifest.mime_type.clone(),
        chunk_count: manifest.chunk_count,
        created_at: manifest.created_at.clone(),
        updated_at: manifest.updated_at.clone(),
    })
    .map_err(|error| error.to_string())?;
    Ok(ContractPoint {
        id: stable_manifest_point_id(&manifest.document_id, manifest.revision),
        payload,
        vector: None,
    })
}

pub(crate) fn chunk_point(
    chunk: &DocumentChunk,
    profile: &EmbeddingProfile,
) -> Result<ContractPoint, String> {
    validate_chunk(chunk, profile)?;
    let identity = PointIdentity {
        point_type: POINT_TYPE_CHUNK.into(),
        document_id: chunk.document_id.clone(),
        source_id: chunk.source_id.clone(),
        revision: chunk.revision,
        state: chunk.state,
        content_sha256: chunk.content_sha256.to_ascii_lowercase(),
        chunk_index: Some(chunk.chunk_index),
    };
    let payload = serde_json::to_value(ChunkPayload {
        identity,
        text: chunk.text.clone(),
        title: chunk.title.clone(),
        source_uri: chunk.source_uri.clone(),
        mime_type: chunk.mime_type.clone(),
        page: chunk.page,
        heading: chunk.heading.clone(),
        created_at: chunk.created_at.clone(),
        updated_at: chunk.updated_at.clone(),
    })
    .map_err(|error| error.to_string())?;
    Ok(ContractPoint {
        id: stable_chunk_point_id(&chunk.document_id, chunk.revision, chunk.chunk_index),
        payload,
        vector: Some(json!({ VTERMINAL_VECTOR_NAME: chunk.vector })),
    })
}

fn validate_manifest(manifest: &DocumentManifest) -> Result<(), String> {
    validate_id("document id", &manifest.document_id)?;
    if let Some(source_id) = &manifest.source_id {
        validate_id("source id", source_id)?;
    }
    validate_sha256(&manifest.content_sha256)?;
    validate_timestamp("created_at", &manifest.created_at)?;
    validate_timestamp("updated_at", &manifest.updated_at)?;
    if manifest.title.trim().is_empty() {
        return Err("document title is required".into());
    }
    if manifest.mime_type.trim().is_empty() {
        return Err("document MIME type is required".into());
    }
    Ok(())
}

fn validate_chunk(chunk: &DocumentChunk, profile: &EmbeddingProfile) -> Result<(), String> {
    validate_id("document id", &chunk.document_id)?;
    if let Some(source_id) = &chunk.source_id {
        validate_id("source id", source_id)?;
    }
    validate_sha256(&chunk.content_sha256)?;
    validate_timestamp("created_at", &chunk.created_at)?;
    validate_timestamp("updated_at", &chunk.updated_at)?;
    if chunk.text.trim().is_empty() {
        return Err("a document chunk cannot be empty".into());
    }
    if chunk.vector.len() != profile.dimensions() {
        return Err(format!(
            "chunk {} has {} dimensions; profile requires {}",
            chunk.chunk_index,
            chunk.vector.len(),
            profile.dimensions()
        ));
    }
    if chunk.vector.iter().any(|component| !component.is_finite()) {
        return Err(format!(
            "chunk {} embedding contains a non-finite value",
            chunk.chunk_index
        ));
    }
    let norm = chunk
        .vector
        .iter()
        .map(|component| (*component as f64) * (*component as f64))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 {
        return Err(format!(
            "chunk {} embedding is a zero vector",
            chunk.chunk_index
        ));
    }
    if profile.semantic().l2_normalize && !(0.98..=1.02).contains(&norm) {
        return Err(format!(
            "chunk {} embedding has L2 norm {norm:.4}; profile requires normalized vectors",
            chunk.chunk_index
        ));
    }
    Ok(())
}

fn validate_id(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("{label} is not valid"));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("document content SHA-256 must contain 64 hexadecimal characters".into());
    }
    Ok(())
}

fn validate_timestamp(label: &str, value: &str) -> Result<(), String> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| format!("{label} must be an RFC 3339 timestamp"))
}

pub(crate) fn parse_manifest_payload(
    point_id: PointId,
    payload: Value,
) -> Result<super::types::DocumentSummary, String> {
    let payload: ManifestPayload =
        serde_json::from_value(payload).map_err(|error| format!("invalid manifest: {error}"))?;
    if payload.identity.point_type != POINT_TYPE_MANIFEST {
        return Err("point is not a document manifest".into());
    }
    let manifest = DocumentManifest {
        document_id: payload.identity.document_id,
        source_id: payload.identity.source_id,
        revision: payload.identity.revision,
        state: payload.identity.state,
        content_sha256: payload.identity.content_sha256,
        title: payload.title,
        source_uri: payload.source_uri,
        mime_type: payload.mime_type,
        chunk_count: payload.chunk_count,
        created_at: payload.created_at,
        updated_at: payload.updated_at,
    };
    validate_manifest(&manifest)?;
    Ok(super::types::DocumentSummary { point_id, manifest })
}

pub(crate) fn parse_chunk_payload(payload: Value) -> Result<ParsedChunkPayload, String> {
    let payload: ChunkPayload =
        serde_json::from_value(payload).map_err(|error| format!("invalid chunk: {error}"))?;
    if payload.identity.point_type != POINT_TYPE_CHUNK {
        return Err("point is not a document chunk".into());
    }
    Ok(ParsedChunkPayload {
        document_id: payload.identity.document_id,
        revision: payload.identity.revision,
        text: payload.text,
        title: payload.title,
        source_uri: payload.source_uri,
        mime_type: payload.mime_type,
        page: payload.page,
        heading: payload.heading,
    })
}

pub(crate) struct ParsedChunkPayload {
    pub document_id: String,
    pub revision: u64,
    pub text: String,
    pub title: String,
    pub source_uri: String,
    pub mime_type: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
}

pub(crate) fn match_filter(key: &str, value: impl Serialize) -> Value {
    json!({ "key": key, "match": { "value": value } })
}

pub(crate) fn active_chunks_filter() -> Value {
    json!({
        "must": [
            match_filter(PAYLOAD_TYPE_FIELD, POINT_TYPE_CHUNK),
            match_filter(PAYLOAD_STATE_FIELD, DocumentState::Active.as_str())
        ]
    })
}

pub(crate) fn active_manifests_filter() -> Value {
    json!({
        "must": [
            match_filter(PAYLOAD_TYPE_FIELD, POINT_TYPE_MANIFEST),
            match_filter(PAYLOAD_STATE_FIELD, DocumentState::Active.as_str())
        ]
    })
}

pub(crate) fn document_manifests_filter(document_id: &str) -> Value {
    json!({
        "must": [
            match_filter(PAYLOAD_TYPE_FIELD, POINT_TYPE_MANIFEST),
            match_filter(PAYLOAD_DOCUMENT_ID_FIELD, document_id)
        ]
    })
}

pub(crate) fn other_revisions_filter(document_id: &str, keep_revision: u64) -> Value {
    json!({
        "must": [match_filter(PAYLOAD_DOCUMENT_ID_FIELD, document_id)],
        "must_not": [match_filter(PAYLOAD_REVISION_FIELD, keep_revision)]
    })
}

pub(crate) fn document_filter(document_id: &str) -> Value {
    json!({ "must": [match_filter(PAYLOAD_DOCUMENT_ID_FIELD, document_id)] })
}

pub(crate) fn revision_filter(document_id: &str, revision: u64) -> Value {
    json!({
        "must": [
            match_filter(PAYLOAD_DOCUMENT_ID_FIELD, document_id),
            match_filter(PAYLOAD_REVISION_FIELD, revision)
        ]
    })
}

pub(crate) fn document_metadata_payload(update: &super::types::DocumentMetadataUpdate) -> Value {
    json!({
        "title": update.title,
        "source_uri": update.source_uri,
        "mime_type": update.mime_type,
        "updated_at": update.updated_at
    })
}

/// Classify without write probes.  Dimension alone is never sufficient: managed
/// collections need exact metadata, while imported collections require an exact
/// saved profile plus explicit model attestation.
pub fn classify_collection(
    collection: &QdrantCollectionInfo,
    context: CompatibilityContext<'_>,
) -> KnowledgeBucketDescriptor {
    let bucket = KnowledgeBucketRef::Qdrant {
        connection_id: context.connection_id.into(),
        collection: collection.name.clone(),
    };
    let profile_by_fingerprint: HashMap<&str, &EmbeddingProfile> = context
        .runnable_profiles
        .iter()
        .map(|profile| (profile.fingerprint(), profile))
        .collect();

    let decision = if let Some(metadata) = &collection.metadata {
        classify_managed(
            collection,
            metadata,
            context.server_version,
            &profile_by_fingerprint,
        )
    } else if let Some(binding) = context.imported_binding {
        classify_imported(
            collection,
            binding,
            context.connection_id,
            &profile_by_fingerprint,
        )
    } else {
        Decision::new(
            CollectionCompatibility::NeedsGuidedImport,
            "This collection has no VTerminal embedding metadata. Map its vector and payload fields in the import wizard.",
            None,
            None,
        )
    };

    let compatibility = match (decision.compatibility, context.access) {
        (
            CollectionCompatibility::ManagedCompatible,
            CollectionAccess::ReadOnly | CollectionAccess::Unknown,
        ) => CollectionCompatibility::AttachOnly,
        (compatibility, _) => compatibility,
    };
    let attachable = collection.points_count > 0
        && matches!(
            compatibility,
            CollectionCompatibility::ManagedCompatible | CollectionCompatibility::AttachOnly
        );

    KnowledgeBucketDescriptor {
        bucket,
        name: collection.name.clone(),
        points_count: collection.points_count,
        indexed_vectors_count: collection.indexed_vectors_count,
        compatibility,
        compatibility_reason: decision.reason,
        access: context.access,
        embedding_profile: decision.profile.cloned(),
        vector_name: decision.vector.map(|vector| vector.name.clone()),
        vector_size: decision.vector.map(|vector| vector.size),
        quantization: collection.quantization.clone(),
        attachable,
    }
}

struct Decision<'a> {
    compatibility: CollectionCompatibility,
    reason: String,
    profile: Option<&'a EmbeddingProfile>,
    vector: Option<&'a super::types::VectorDescriptor>,
}

impl<'a> Decision<'a> {
    fn new(
        compatibility: CollectionCompatibility,
        reason: impl Into<String>,
        profile: Option<&'a EmbeddingProfile>,
        vector: Option<&'a super::types::VectorDescriptor>,
    ) -> Self {
        Self {
            compatibility,
            reason: reason.into(),
            profile,
            vector,
        }
    }
}

fn classify_managed<'a>(
    collection: &'a QdrantCollectionInfo,
    metadata: &'a VterminalCollectionMetadata,
    server_version: Option<&Version>,
    profiles: &HashMap<&str, &'a EmbeddingProfile>,
) -> Decision<'a> {
    let managed_min = Version::parse(QDRANT_MANAGED_MIN_VERSION).expect("constant is semver");
    if server_version.is_some_and(|version| version < &managed_min) {
        return Decision::new(
            CollectionCompatibility::UpgradeRequired,
            format!("Qdrant {QDRANT_MANAGED_MIN_VERSION} or newer is required for managed collection metadata."),
            None,
            None,
        );
    }
    if metadata.owner != "vterminal" {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The collection metadata is owned by another application.",
            None,
            None,
        );
    }
    if metadata.contract_version != VTERMINAL_CONTRACT_VERSION
        || metadata.payload_schema_version != VTERMINAL_PAYLOAD_SCHEMA_VERSION
        || metadata.chunk_pipeline_version != VTERMINAL_CHUNK_PIPELINE_VERSION
    {
        return Decision::new(
            CollectionCompatibility::UpgradeRequired,
            "The collection uses a different VTerminal contract, payload, or chunk-pipeline version.",
            None,
            None,
        );
    }
    if metadata.embedding_profile_fingerprint != metadata.embedding_profile.fingerprint() {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The collection embedding profile fingerprint does not match its semantic metadata.",
            None,
            None,
        );
    }
    let Some(profile) = profiles
        .get(metadata.embedding_profile_fingerprint.as_str())
        .copied()
    else {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The exact embedding profile required to query this collection is not available.",
            None,
            None,
        );
    };
    if profile != &metadata.embedding_profile {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "A local profile has the same fingerprint but different semantic metadata.",
            None,
            None,
        );
    }
    let Some(vector) = collection
        .vectors
        .iter()
        .find(|vector| vector.name == metadata.vector_name)
    else {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            format!(
                "The required named vector {:?} does not exist.",
                metadata.vector_name
            ),
            Some(profile),
            None,
        );
    };
    if !vector_matches_profile(vector, profile) {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The collection vector size, distance, or datatype differs from its embedding profile.",
            Some(profile),
            Some(vector),
        );
    }
    let index_drift = required_payload_index_drift(collection);
    if !index_drift.is_empty() {
        return Decision::new(
            CollectionCompatibility::UpgradeRequired,
            format!(
                "Required payload indexes are missing or use the wrong schema type: {}.",
                index_drift.join(", ")
            ),
            Some(profile),
            Some(vector),
        );
    }
    Decision::new(
        CollectionCompatibility::ManagedCompatible,
        "Managed VTerminal collection with an exact runnable embedding profile.",
        Some(profile),
        Some(vector),
    )
}

fn classify_imported<'a>(
    collection: &'a QdrantCollectionInfo,
    binding: &ImportedCollectionBinding,
    connection_id: &str,
    profiles: &HashMap<&str, &'a EmbeddingProfile>,
) -> Decision<'a> {
    if binding.connection_id != connection_id
        || binding.collection != collection.name
        || !binding.model_attested
    {
        return Decision::new(
            CollectionCompatibility::NeedsGuidedImport,
            "Finish the import wizard and attest the exact embedding model and transforms.",
            None,
            None,
        );
    }
    let Some(profile) = profiles
        .get(binding.embedding_profile_fingerprint.as_str())
        .copied()
    else {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The exact attested embedding profile is not currently available.",
            None,
            None,
        );
    };
    let Some(vector) = collection
        .vectors
        .iter()
        .find(|vector| vector.name == binding.vector_name)
    else {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The vector selected during import no longer exists.",
            Some(profile),
            None,
        );
    };
    if !vector_matches_profile(vector, profile) {
        return Decision::new(
            CollectionCompatibility::Incompatible,
            "The imported vector no longer matches the attested embedding profile.",
            Some(profile),
            Some(vector),
        );
    }
    Decision::new(
        CollectionCompatibility::AttachOnly,
        "Imported collection; search uses the explicitly attested vector and payload mapping.",
        Some(profile),
        Some(vector),
    )
}

fn vector_matches_profile(
    vector: &super::types::VectorDescriptor,
    profile: &EmbeddingProfile,
) -> bool {
    vector.size == profile.semantic().dimensions
        && vector.distance.eq_ignore_ascii_case("Cosine")
        && vector
            .data_type
            .as_deref()
            .is_none_or(|data_type| data_type.eq_ignore_ascii_case("float32"))
}

pub(crate) fn metadata_from_config(
    config_metadata: Option<&Value>,
) -> Option<VterminalCollectionMetadata> {
    config_metadata?
        .get("vterminal")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(crate) fn payload_indexes_from_schema(schema: Option<&Map<String, Value>>) -> BTreeSet<String> {
    schema
        .into_iter()
        .flat_map(|map| map.keys().cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::embedding::{
        EmbeddingProfileSpec, EmbeddingProviderDialect, InputTransform, Pooling, TruncationPolicy,
        VectorDataType, VectorDistance, EMBEDDING_PROFILE_SCHEMA_VERSION,
    };
    use crate::knowledge::types::{QuantizationStatus, VectorDescriptor};

    fn profile() -> EmbeddingProfile {
        EmbeddingProfile::new(EmbeddingProfileSpec {
            schema_version: EMBEDDING_PROFILE_SCHEMA_VERSION,
            provider: EmbeddingProviderDialect::LocalLlamaCpp,
            model_id: "multilingual-e5-base".into(),
            revision: Some("revision-1".into()),
            artifact_sha256: Some("a".repeat(64)),
            dimensions: 3,
            max_input_tokens: Some(512),
            pooling: Pooling::Mean,
            l2_normalize: true,
            distance: VectorDistance::Cosine,
            vector_data_type: VectorDataType::Float32,
            query_transform: InputTransform::Prefix {
                value: "query: ".into(),
            },
            document_transform: InputTransform::Prefix {
                value: "passage: ".into(),
            },
            truncation: TruncationPolicy::Reject,
        })
        .unwrap()
    }

    fn collection(profile: &EmbeddingProfile) -> QdrantCollectionInfo {
        QdrantCollectionInfo {
            name: "manuals".into(),
            status: "green".into(),
            points_count: 2,
            indexed_vectors_count: 1,
            vectors: vec![VectorDescriptor {
                name: VTERMINAL_VECTOR_NAME.into(),
                size: profile.semantic().dimensions,
                distance: "Cosine".into(),
                data_type: Some("float32".into()),
            }],
            payload_indexes: REQUIRED_PAYLOAD_INDEXES
                .iter()
                .map(|field| (*field).to_string())
                .collect(),
            payload_index_types: REQUIRED_PAYLOAD_INDEXES
                .iter()
                .map(|field| {
                    (
                        (*field).to_string(),
                        if *field == PAYLOAD_REVISION_FIELD {
                            "integer"
                        } else {
                            "keyword"
                        }
                        .to_string(),
                    )
                })
                .collect(),
            metadata: Some(collection_metadata(profile)),
            quantization: QuantizationStatus::Off,
        }
    }

    fn classify(
        collection: &QdrantCollectionInfo,
        profiles: &[EmbeddingProfile],
        access: CollectionAccess,
    ) -> KnowledgeBucketDescriptor {
        let version = Version::new(1, 18, 0);
        classify_collection(
            collection,
            CompatibilityContext {
                connection_id: "prod",
                server_version: Some(&version),
                runnable_profiles: profiles,
                access,
                imported_binding: None,
            },
        )
    }

    #[test]
    fn stable_point_ids_are_repeatable_and_revision_scoped() {
        assert_eq!(
            stable_manifest_point_id("doc-a", 2),
            stable_manifest_point_id("doc-a", 2)
        );
        assert_ne!(
            stable_manifest_point_id("doc-a", 2),
            stable_manifest_point_id("doc-a", 3)
        );
        assert_eq!(
            stable_chunk_point_id("doc-a", 2, 4),
            stable_chunk_point_id("doc-a", 2, 4)
        );
        assert_ne!(
            stable_chunk_point_id("doc-a", 2, 4),
            stable_chunk_point_id("doc-a", 3, 4)
        );
    }

    #[test]
    fn vector_point_uses_named_content_vector_and_nested_identity() {
        let profile = profile();
        let chunk = DocumentChunk {
            document_id: "doc-a".into(),
            source_id: Some("file-a".into()),
            revision: 2,
            state: DocumentState::Staging,
            content_sha256: "b".repeat(64),
            chunk_index: 4,
            text: "retrievable content".into(),
            title: "Manual".into(),
            source_uri: "file:///manual.md".into(),
            mime_type: "text/markdown".into(),
            page: Some(7),
            heading: Some("Install".into()),
            created_at: "2026-08-13T10:00:00Z".into(),
            updated_at: "2026-08-13T10:00:00Z".into(),
            vector: vec![1.0, 0.0, 0.0],
        };
        let point = chunk_point(&chunk, &profile).unwrap();
        assert_eq!(point.vector, Some(json!({"content": [1.0, 0.0, 0.0]})));
        assert_eq!(point.payload["_vterminal"]["type"], "chunk");
        assert_eq!(point.payload["_vterminal"]["document_id"], "doc-a");
        assert_eq!(point.payload["page"], 7);
    }

    #[test]
    fn managed_collection_requires_an_exact_runnable_profile() {
        let profile = profile();
        let collection = collection(&profile);
        let descriptor = classify(
            &collection,
            std::slice::from_ref(&profile),
            CollectionAccess::Manage,
        );
        assert_eq!(
            descriptor.compatibility,
            CollectionCompatibility::ManagedCompatible
        );
        assert!(descriptor.attachable);

        let missing = classify(&collection, &[], CollectionAccess::ReadOnly);
        assert_eq!(missing.compatibility, CollectionCompatibility::Incompatible);
        assert!(!missing.attachable);
    }

    #[test]
    fn unmarked_collection_needs_guided_import() {
        let profile = profile();
        let mut collection = collection(&profile);
        collection.metadata = None;
        let descriptor = classify(&collection, &[profile], CollectionAccess::ReadOnly);
        assert_eq!(
            descriptor.compatibility,
            CollectionCompatibility::NeedsGuidedImport
        );
        assert!(!descriptor.attachable);
    }

    #[test]
    fn dimension_alone_never_makes_a_collection_compatible() {
        let profile = profile();
        let mut collection = collection(&profile);
        collection.metadata = None;
        collection.vectors[0].size = profile.semantic().dimensions;
        let descriptor = classify(&collection, &[profile], CollectionAccess::ReadOnly);
        assert_eq!(
            descriptor.compatibility,
            CollectionCompatibility::NeedsGuidedImport
        );
    }

    #[test]
    fn changed_vector_or_payload_index_drift_needs_attention() {
        let profile = profile();
        let mut wrong_vector = collection(&profile);
        wrong_vector.vectors[0].size += 1;
        assert_eq!(
            classify(
                &wrong_vector,
                std::slice::from_ref(&profile),
                CollectionAccess::Manage
            )
            .compatibility,
            CollectionCompatibility::Incompatible
        );

        let mut missing_index = collection(&profile);
        missing_index.payload_indexes.remove(PAYLOAD_STATE_FIELD);
        assert_eq!(
            classify(
                &missing_index,
                std::slice::from_ref(&profile),
                CollectionAccess::Manage
            )
            .compatibility,
            CollectionCompatibility::UpgradeRequired
        );

        let mut missing_type = collection(&profile);
        missing_type
            .payload_index_types
            .remove(PAYLOAD_DOCUMENT_ID_FIELD);
        let descriptor = classify(
            &missing_type,
            std::slice::from_ref(&profile),
            CollectionAccess::Manage,
        );
        assert_eq!(
            descriptor.compatibility,
            CollectionCompatibility::UpgradeRequired
        );
        assert!(descriptor
            .compatibility_reason
            .contains("unknown; expected keyword"));

        let mut wrong_revision_type = collection(&profile);
        wrong_revision_type
            .payload_index_types
            .insert(PAYLOAD_REVISION_FIELD.into(), "keyword".into());
        let descriptor = classify(
            &wrong_revision_type,
            std::slice::from_ref(&profile),
            CollectionAccess::Manage,
        );
        assert_eq!(
            descriptor.compatibility,
            CollectionCompatibility::UpgradeRequired
        );
        assert!(descriptor
            .compatibility_reason
            .contains("found keyword; expected integer"));

        let mut case_variant = collection(&profile);
        case_variant
            .payload_index_types
            .insert(PAYLOAD_REVISION_FIELD.into(), "INTEGER".into());
        assert_eq!(
            classify(
                &case_variant,
                std::slice::from_ref(&profile),
                CollectionAccess::Manage
            )
            .compatibility,
            CollectionCompatibility::ManagedCompatible
        );
    }

    #[test]
    fn persisted_profile_metadata_includes_every_semantic_field() {
        let profile = profile();
        let value = metadata_value(&profile);
        assert_eq!(value["vterminal"]["owner"], "vterminal");
        assert_eq!(value["vterminal"]["vector_name"], "content");
        assert_eq!(
            value["vterminal"]["embedding_profile"]["semantic"]["vector_data_type"],
            serde_json::to_value(VectorDataType::Float32).unwrap()
        );
        assert_eq!(
            value["vterminal"]["embedding_profile"]["semantic"]["distance"],
            serde_json::to_value(VectorDistance::Cosine).unwrap()
        );
    }
}
