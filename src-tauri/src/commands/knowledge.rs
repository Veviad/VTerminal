//! Unified Knowledge IPC: local document buckets, embedding profiles, and Qdrant.
//!
//! The wire views in this module intentionally differ from the lower-level Qdrant
//! contract.  Core types describe what the server reported; these views describe
//! what the product can safely offer to a user.  In particular, credentials have
//! no serializable field and cached discovery survives a failed refresh.

use std::collections::HashMap;

use futures::{stream, StreamExt};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State, Wry};

use crate::docs::chunk::ChunkSpec;
use crate::docs::{index, semantic};
use crate::knowledge::contract::{
    classify_collection, validate_vterminal_collection_deletable, CompatibilityContext,
};
use crate::knowledge::embedding::{
    self, EmbeddingInput, EmbeddingProfile, EmbeddingProviderDialect, EmbeddingPurpose,
};
use crate::knowledge::qdrant::{QdrantClient, QdrantEndpoint, QdrantError};
use crate::knowledge::store::{self, QdrantConnectionInput, QdrantConnectionRecord};
use crate::knowledge::types::{
    CollectionAccess, CollectionCompatibility, DocumentMetadataUpdate, DocumentPage,
    KnowledgeBucketRef, PointId, QdrantCollectionInfo, QuantizationStatus, TurboQuantConfig,
};

const DISCOVERY_CONCURRENCY: usize = 6;

fn discovery_result_is_stale(last_checked_at: Option<i64>, started_at: i64) -> bool {
    last_checked_at.is_some_and(|last_checked| last_checked >= started_at)
}

pub(crate) fn gate(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if crate::commands::settings::read_bool(app, "docs_enabled", false) {
        Ok(())
    } else {
        Err("knowledge is switched off — enable it in Settings → Knowledge".into())
    }
}

async fn knowledge_writer_lock(
    app: &tauri::AppHandle<Wry>,
) -> Result<crate::knowledge::process_lock::KnowledgeProcessLock, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    crate::knowledge::process_lock::KnowledgeProcessLock::acquire(app_data).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingProfileView {
    pub id: String,
    pub fingerprint: String,
    pub label: String,
    pub provider: String,
    pub model: String,
    pub revision: Option<String>,
    pub dimensions: u32,
    pub pooling: String,
    pub normalized: bool,
    pub query_prefix: Option<String>,
    pub document_prefix: Option<String>,
    pub max_tokens: u32,
    pub distance: String,
    pub available: bool,
}

fn provider_name(provider: EmbeddingProviderDialect) -> &'static str {
    match provider {
        EmbeddingProviderDialect::LocalLlamaCpp => "local",
        EmbeddingProviderDialect::OpenAi => "openai",
        EmbeddingProviderDialect::Mistral => "mistral",
        EmbeddingProviderDialect::Ollama => "ollama",
        EmbeddingProviderDialect::LmStudio => "lm_studio",
    }
}

fn transform_prefix(transform: &embedding::InputTransform) -> Option<String> {
    match transform {
        embedding::InputTransform::Prefix { value } => Some(value.clone()),
        _ => None,
    }
}

fn profile_view(id: impl Into<String>, profile: &EmbeddingProfile) -> EmbeddingProfileView {
    let spec = profile.semantic();
    EmbeddingProfileView {
        id: id.into(),
        fingerprint: profile.fingerprint().into(),
        label: spec.model_id.clone(),
        provider: provider_name(spec.provider).into(),
        model: spec.model_id.clone(),
        revision: spec.revision.clone(),
        dimensions: spec.dimensions,
        pooling: match spec.pooling {
            embedding::Pooling::Mean => "mean",
            embedding::Pooling::LastToken => "last_token",
            embedding::Pooling::Cls => "cls",
            embedding::Pooling::ProviderDefined => "provider",
        }
        .into(),
        normalized: spec.l2_normalize,
        query_prefix: transform_prefix(&spec.query_transform),
        document_prefix: transform_prefix(&spec.document_transform),
        max_tokens: spec.max_input_tokens.unwrap_or(0),
        distance: "cosine".into(),
        available: true,
    }
}

#[derive(Debug, Clone)]
struct AvailableProfile {
    id: String,
    profile: EmbeddingProfile,
}

fn stored_profiles(docs: &crate::docs::db::DocsDb) -> Result<Vec<AvailableProfile>, String> {
    if !docs.exists() {
        return Ok(Vec::new());
    }
    docs.with(|conn| {
        semantic::list_profiles(conn).map(|rows| {
            rows.into_iter()
                .filter(|row| row.status == "ready")
                .filter_map(|row| {
                    serde_json::from_value::<EmbeddingProfile>(row.profile)
                        .ok()
                        .filter(|profile| profile.fingerprint() == row.fingerprint)
                        .map(|profile| AvailableProfile {
                            id: row.id,
                            profile,
                        })
                })
                .collect()
        })
    })
}

fn profile_operational(
    app: &tauri::AppHandle<Wry>,
    profile: &EmbeddingProfile,
) -> Result<(), String> {
    let semantic = profile.semantic();
    match semantic.provider {
        EmbeddingProviderDialect::OpenAi => {
            if crate::credentials::state(app).has(&crate::credentials::CredentialId::OpenAi)? {
                Ok(())
            } else {
                Err("OpenAI API key is missing".into())
            }
        }
        EmbeddingProviderDialect::Mistral => {
            if crate::credentials::state(app).has(&crate::credentials::CredentialId::Mistral)? {
                Ok(())
            } else {
                Err("Mistral API key is missing".into())
            }
        }
        EmbeddingProviderDialect::LocalLlamaCpp => {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let models_dir = crate::models::registry::models_dir(
                &app_data,
                crate::commands::settings::read_string(app, "models_dir").as_deref(),
            );
            let digest = semantic
                .artifact_sha256
                .as_deref()
                .ok_or_else(|| "local profile has no pinned artifact digest".to_string())?;
            crate::knowledge::local::installed_artifacts(&models_dir)
                .into_iter()
                .find(|artifact| {
                    artifact.sha256.eq_ignore_ascii_case(digest)
                        && embedding::builtin_model(&artifact.builtin_model_id)
                            .is_some_and(|model| model.upstream_model_id == semantic.model_id)
                })
                .map(|_| ())
                .ok_or_else(|| "the exact local embedding artifact is not installed".into())
        }
        EmbeddingProviderDialect::Ollama | EmbeddingProviderDialect::LmStudio => Ok(()),
    }
}

fn available_profiles(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
) -> Result<Vec<AvailableProfile>, String> {
    Ok(stored_profiles(docs)?
        .into_iter()
        .filter(|stored| profile_operational(app, &stored.profile).is_ok())
        .collect())
}

fn find_profile(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    id: &str,
) -> Result<AvailableProfile, String> {
    let selected = stored_profiles(docs)?
        .into_iter()
        .find(|stored| stored.id == id || stored.profile.fingerprint() == id)
        .ok_or_else(|| format!("embedding profile {id:?} is not installed and ready"))?;
    profile_operational(app, &selected.profile)?;
    Ok(selected)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeBucketView {
    #[serde(rename = "ref")]
    pub bucket_ref: KnowledgeBucketRef,
    pub label: String,
    pub connection_label: Option<String>,
    pub profile: Option<EmbeddingProfileView>,
    pub compatibility: String,
    pub compatibility_reason: Option<String>,
    pub attachable: bool,
    /// Safe to attempt remote collection deletion based on immutable ownership
    /// markers. Qdrant can still reject the attempt for insufficient key access.
    #[serde(default)]
    pub deletable: bool,
    pub writable: bool,
    /// Discovery is intentionally read-only, so `unknown` means an explicit user
    /// upload may be attempted and its real 403/success cached afterwards.
    #[serde(default = "unknown_write_capability")]
    pub write_capability: String,
    pub manageable: bool,
    pub file_count: u64,
    pub chunk_count: u64,
    pub pending_count: u64,
    pub stale: bool,
    pub error: Option<String>,
    /// Internal capability memory. TypeScript ignores it, but retaining it in the
    /// cached value means a refresh does not forget a capability established by a
    /// real successful operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<CollectionAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantization: Option<QuantizationStatus>,
    /// True only for an unmarked external collection with an explicit local,
    /// user-attested binding. It lets Settings offer "forget mapping" without
    /// conflating ordinary read-only managed collections with imported ones.
    #[serde(default)]
    pub imported: bool,
    /// Remediation hints for valid managed collections whose immutable profile
    /// is not currently runnable on this client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_builtin_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(default)]
    pub turbo_quant_supported: bool,
}

fn compatibility_name(value: CollectionCompatibility) -> &'static str {
    match value {
        CollectionCompatibility::ManagedCompatible => "managed_compatible",
        CollectionCompatibility::AttachOnly => "attach_only",
        CollectionCompatibility::RequiresProfile => "requires_profile",
        CollectionCompatibility::Unmanaged => "unmanaged",
        CollectionCompatibility::LegacyImport => "legacy_import",
        CollectionCompatibility::UpgradeRequired => "upgrade_required",
        CollectionCompatibility::Incompatible => "incompatible",
        CollectionCompatibility::Unreadable => "unreadable",
    }
}

fn write_capability(access: CollectionAccess) -> &'static str {
    match access {
        CollectionAccess::Unknown => "unknown",
        CollectionAccess::ReadOnly => "read_only",
        CollectionAccess::PointsReadWrite | CollectionAccess::Manage => "read_write",
    }
}

fn unknown_write_capability() -> String {
    "unknown".into()
}

/// Cache only what an explicit collection-management operation proved. A 403
/// rules out manage access but says nothing about point writes, so downgrade to
/// `unknown` rather than incorrectly labelling the key read-only.
fn remember_manage_denied(
    app: &tauri::AppHandle<Wry>,
    connection_id: &str,
    collection: &str,
) -> Result<(), String> {
    let connections = store::read_connections(app);
    let snapshot = store::find_connection(&connections, connection_id)?.clone();
    store::update_connection_if_current(app, &snapshot, |connection| {
        let mut found = false;
        for value in &mut connection.collections {
            let Some(mut bucket) = cached_bucket_from_value(value) else {
                continue;
            };
            if matches!(
                &bucket.bucket_ref,
                KnowledgeBucketRef::Qdrant { collection: name, .. } if name == collection
            ) {
                found = true;
                bucket.access = Some(CollectionAccess::Unknown);
                bucket.manageable = false;
                bucket.writable = false;
                bucket.write_capability = "unknown".into();
                *value = serde_json::to_value(bucket).map_err(|error| error.to_string())?;
            }
        }
        if found {
            connection.last_checked_at = Some(
                connection
                    .last_checked_at
                    .unwrap_or(i64::MIN)
                    .max(semantic::now_ms()),
            );
            connection.status = "connected".into();
            connection.error = None;
        }
        Ok(())
    })
    .map(|_| ())
}

fn remote_bucket_view(
    raw: crate::knowledge::types::KnowledgeBucketDescriptor,
    connection_label: &str,
    profiles: &[AvailableProfile],
    stale: bool,
    error: Option<String>,
    server_version: Option<&Version>,
) -> KnowledgeBucketView {
    let imported = raw.compatibility == CollectionCompatibility::LegacyImport;
    let profile = raw.embedding_profile.as_ref().map(|profile| {
        let ready = profiles
            .iter()
            .find(|stored| stored.profile.fingerprint() == profile.fingerprint());
        let id = ready
            .map(|stored| stored.id.clone())
            .unwrap_or_else(|| profile.fingerprint().into());
        let mut view = profile_view(id, profile);
        view.available = ready.is_some();
        view
    });
    let required_builtin_model_id = (raw.compatibility == CollectionCompatibility::RequiresProfile)
        .then(|| {
            raw.embedding_profile
                .as_ref()
                .and_then(required_builtin_profile_id)
        })
        .flatten();
    let required_provider = (raw.compatibility == CollectionCompatibility::RequiresProfile)
        .then(|| {
            raw.embedding_profile
                .as_ref()
                .map(|profile| provider_name(profile.semantic().provider).to_string())
        })
        .flatten();
    let turbo_min = Version::parse(crate::knowledge::types::QDRANT_TURBO_QUANT_MIN_VERSION)
        .expect("TurboQuant minimum is valid semver");
    KnowledgeBucketView {
        bucket_ref: raw.bucket,
        label: raw.name,
        connection_label: Some(connection_label.into()),
        profile,
        compatibility: compatibility_name(raw.compatibility).into(),
        compatibility_reason: Some(raw.compatibility_reason),
        attachable: raw.attachable,
        deletable: raw.deletable,
        writable: raw.access.can_write_points(),
        write_capability: write_capability(raw.access).into(),
        manageable: raw.access.can_manage(),
        file_count: raw.active_document_count,
        chunk_count: raw.active_chunk_count,
        pending_count: raw.pending_count,
        stale,
        error,
        access: Some(raw.access),
        vector_name: raw.vector_name,
        quantization: Some(raw.quantization),
        imported,
        required_builtin_model_id,
        required_provider,
        server_version: server_version.map(ToString::to_string),
        turbo_quant_supported: server_version.is_some_and(|version| version >= &turbo_min),
    }
}

fn required_builtin_profile_id(profile: &EmbeddingProfile) -> Option<String> {
    let semantic = profile.semantic();
    if semantic.provider != EmbeddingProviderDialect::LocalLlamaCpp {
        return None;
    }
    embedding::BUILTIN_EMBEDDING_MODELS
        .iter()
        .find(|model| {
            if model.upstream_model_id != semantic.model_id {
                return false;
            }
            let (Some(revision), Some(digest)) = (
                semantic.revision.as_deref(),
                semantic.artifact_sha256.as_deref(),
            ) else {
                return false;
            };
            embedding::builtin_profile(model.id, semantic.dimensions, revision, digest)
                .is_ok_and(|expected| expected == *profile)
        })
        .map(|model| model.id.to_string())
}

fn unreadable_bucket(
    connection: &QdrantConnectionRecord,
    collection: String,
    error: String,
) -> KnowledgeBucketView {
    KnowledgeBucketView {
        bucket_ref: KnowledgeBucketRef::Qdrant {
            connection_id: connection.id.clone(),
            collection: collection.clone(),
        },
        label: collection,
        connection_label: Some(connection.label.clone()),
        profile: None,
        compatibility: "unreadable".into(),
        compatibility_reason: Some(error.clone()),
        attachable: false,
        deletable: false,
        writable: false,
        write_capability: "unknown".into(),
        manageable: false,
        file_count: 0,
        chunk_count: 0,
        pending_count: 0,
        stale: false,
        error: Some(error),
        access: Some(CollectionAccess::Unknown),
        vector_name: None,
        quantization: None,
        imported: false,
        required_builtin_model_id: None,
        required_provider: None,
        server_version: connection.server_version.clone(),
        turbo_quant_supported: false,
    }
}

fn should_migrate_legacy_deletable(
    value: &serde_json::Value,
    imported: bool,
    compatibility: &str,
) -> bool {
    value.get("deletable").is_none()
        && !imported
        && matches!(compatibility, "managed_compatible" | "attach_only")
}

fn cached_bucket_from_value(value: &serde_json::Value) -> Option<KnowledgeBucketView> {
    let mut bucket: KnowledgeBucketView = serde_json::from_value(value.clone()).ok()?;
    if should_migrate_legacy_deletable(value, bucket.imported, &bucket.compatibility) {
        bucket.deletable = true;
    }
    Some(bucket)
}

fn cached_bucket_views(connection: &QdrantConnectionRecord) -> Vec<KnowledgeBucketView> {
    connection
        .collections
        .iter()
        .filter_map(|value| {
            let mut bucket = cached_bucket_from_value(value)?;
            bucket.stale |= connection.status == "stale";
            if connection.status == "stale" && bucket.error.is_none() {
                bucket.error = connection.error.clone();
            }
            Some(bucket)
        })
        .collect()
}

fn apply_remote_document_counts(bucket: &mut KnowledgeBucketView, counts: (u64, u64)) {
    bucket.file_count = counts.0;
    bucket.chunk_count = counts.1;
    if !bucket.imported
        && matches!(
            bucket.compatibility.as_str(),
            "managed_compatible" | "attach_only"
        )
    {
        bucket.attachable = counts.1 > 0;
    }
}

fn cache_remote_document_counts(
    app: &tauri::AppHandle<Wry>,
    connection_id: &str,
    collection: &str,
    counts: (u64, u64),
) -> Result<(), String> {
    let connections = store::read_connections(app);
    let snapshot = store::find_connection(&connections, connection_id)?.clone();
    store::update_connection_if_current(app, &snapshot, |connection| {
        for value in &mut connection.collections {
            let Some(mut bucket) = cached_bucket_from_value(value) else {
                continue;
            };
            if matches!(
                &bucket.bucket_ref,
                KnowledgeBucketRef::Qdrant {
                    connection_id: id,
                    collection: name,
                } if id == connection_id && name == collection
            ) {
                apply_remote_document_counts(&mut bucket, counts);
                *value = serde_json::to_value(bucket).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    })
    .map(|_| ())
}

#[derive(Debug, Clone, Serialize)]
pub struct QdrantConnectionView {
    pub id: String,
    pub label: String,
    pub url: String,
    pub has_api_key: bool,
    pub allow_insecure: bool,
    pub status: String,
    pub server_version: Option<String>,
    pub last_checked_at: Option<i64>,
    pub error: Option<String>,
    pub collections: Vec<KnowledgeBucketView>,
    pub hidden_unmanaged_count: usize,
}

fn connection_view(
    app: &tauri::AppHandle<Wry>,
    connection: &QdrantConnectionRecord,
) -> Result<QdrantConnectionView, String> {
    let cached = cached_bucket_views(connection);
    let hidden_unmanaged_count = cached
        .iter()
        .filter(|bucket| bucket.compatibility == "unmanaged")
        .count();
    Ok(QdrantConnectionView {
        id: connection.id.clone(),
        label: connection.label.clone(),
        url: connection.url.clone(),
        has_api_key: store::has_api_key(app, &connection.id)?,
        allow_insecure: connection.allow_insecure,
        status: connection.status.clone(),
        server_version: connection.server_version.clone(),
        last_checked_at: connection.last_checked_at,
        error: connection.error.clone(),
        collections: cached
            .into_iter()
            .filter(|bucket| bucket.compatibility != "unmanaged")
            .collect(),
        hidden_unmanaged_count,
    })
}

fn qdrant_client(
    app: &tauri::AppHandle<Wry>,
    connection: &QdrantConnectionRecord,
) -> Result<QdrantClient, String> {
    let key = store::read_api_key(app, connection)?;
    let endpoint = QdrantEndpoint::parse(&connection.url, key.is_some(), connection.allow_insecure)
        .map_err(|error| error.to_string())?;
    QdrantClient::new(endpoint, key).map_err(|error| error.to_string())
}

async fn resolve_managed_collection(
    app: &tauri::AppHandle<Wry>,
    docs: &crate::docs::db::DocsDb,
    connection_id: &str,
    collection: &str,
) -> Result<(QdrantClient, QdrantCollectionInfo, Version), String> {
    let connections = store::read_connections(app);
    let connection = store::find_connection(&connections, connection_id)?;
    let client = qdrant_client(app, connection)?;
    let server = client
        .server_info()
        .await
        .map_err(|error| error.to_string())?;
    let version = Version::parse(&server.version)
        .map_err(|_| "Qdrant returned an invalid server version".to_string())?;
    let info = client
        .collection_info(collection)
        .await
        .map_err(|error| error.to_string())?;
    let profiles = available_profiles(app, docs)?
        .into_iter()
        .map(|stored| stored.profile)
        .collect::<Vec<_>>();
    let descriptor = classify_collection(
        &info,
        CompatibilityContext {
            connection_id,
            server_version: Some(&version),
            runnable_profiles: &profiles,
            access: CollectionAccess::Manage,
            imported_binding: None,
        },
    );
    if descriptor.compatibility != CollectionCompatibility::ManagedCompatible {
        return Err(format!(
            "refusing to manage a collection without the exact VTerminal contract: {}",
            descriptor.compatibility_reason
        ));
    }
    Ok((client, info, version))
}

async fn resolve_deletable_collection(
    app: &tauri::AppHandle<Wry>,
    connection_id: &str,
    collection: &str,
) -> Result<QdrantClient, String> {
    let connections = store::read_connections(app);
    let connection = store::find_connection(&connections, connection_id)?;
    let client = qdrant_client(app, connection)?;
    let info = client
        .collection_info(collection)
        .await
        .map_err(|error| error.to_string())?;
    validate_vterminal_collection_deletable(&info)
        .map_err(|reason| format!("refusing to delete an unowned Qdrant collection: {reason}"))?;
    Ok(client)
}

fn imported_bindings(
    docs: &crate::docs::db::DocsDb,
    connection_id: &str,
) -> Result<HashMap<String, semantic::StoredQdrantBinding>, String> {
    if !docs.exists() {
        return Ok(HashMap::new());
    }
    docs.with(|connection| semantic::list_qdrant_bindings(connection, Some(connection_id)))
        .map(|rows| {
            rows.into_iter()
                .filter(|stored| stored.binding.connection_id == connection_id)
                .map(|stored| (stored.binding.collection.clone(), stored))
                .collect()
        })
}

#[tauri::command]
pub fn knowledge_connections_list(
    app: tauri::AppHandle<Wry>,
) -> Result<Vec<QdrantConnectionView>, String> {
    gate(&app)?;
    store::read_connections(&app)
        .iter()
        .map(|connection| connection_view(&app, connection))
        .collect::<Result<Vec<_>, _>>()
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_connections_create(
    app: tauri::AppHandle<Wry>,
    connection: QdrantConnectionInput,
    api_key: Option<String>,
) -> Result<String, String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let input = connection.validate()?;
    let id = uuid::Uuid::new_v4().to_string();
    store::create_connection(
        &app,
        store::new_record(id.clone(), input),
        api_key.as_deref(),
    )?;
    Ok(id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_connections_update(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    id: String,
    connection: QdrantConnectionInput,
    api_key: Option<String>,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let input = connection.validate()?;
    let connections = store::read_connections(&app);
    let record = store::find_connection(&connections, &id)?;
    let endpoint_changed = record.url != input.url;
    let credential_origin_changed = crate::credentials::qdrant_id(&id, &record.url)?
        != crate::credentials::qdrant_id(&id, &input.url)?;
    if credential_origin_changed && api_key.is_none() {
        return Err("changing the Qdrant origin requires a replacement key; pass an empty key explicitly if the new endpoint needs none".into());
    }

    // A binding and a resumable job describe one concrete vector space. Once
    // the connection points at a different endpoint (including a different
    // path prefix on the same host), retaining either
    // could apply the old cluster's contract or content to a same-named
    // collection on the new cluster. The writer lock ensures no ingest/import
    // can race this invalidation. Do it before changing settings so any later
    // failure is fail-closed (the user may need to re-import, but data cannot be
    // sent to the wrong origin).
    if endpoint_changed && docs.exists() {
        docs.with(|database| {
            semantic::delete_qdrant_bindings_for_connection(database, &id)?;
            database
                .execute(
                    "UPDATE knowledge_jobs
                        SET status='failed',
                            error='Qdrant connection endpoint changed; start a new ingestion job',
                            updated_at=?2
                      WHERE json_extract(target_ref_json,'$.source')='qdrant'
                        AND json_extract(target_ref_json,'$.connection_id')=?1
                        AND status!='completed'",
                    rusqlite::params![id, semantic::now_ms()],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        })?;
    }
    store::update_connection(&app, &id, input, api_key.as_deref())?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_connections_set_api_key(
    app: tauri::AppHandle<Wry>,
    id: String,
    api_key: String,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    store::find_connection(&store::read_connections(&app), &id)?;
    store::write_api_key(&app, &id, &api_key)
}

/// Forgetting a connection never sends a network request.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_connections_delete(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    id: String,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    store::find_connection(&store::read_connections(&app), &id)?;
    if docs.exists() {
        docs.with(|database| {
            semantic::delete_qdrant_bindings_for_connection(database, &id)?;
            database
                .execute(
                    "UPDATE knowledge_jobs
                        SET status='failed',
                            error='Qdrant connection was removed; start a new ingestion job',
                            updated_at=?2
                      WHERE json_extract(target_ref_json,'$.source')='qdrant'
                        AND json_extract(target_ref_json,'$.connection_id')=?1
                        AND status!='completed'",
                    rusqlite::params![id, semantic::now_ms()],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        })?;
    }
    store::delete_connection(&app, &id)?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_connections_refresh(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    id: String,
) -> Result<QdrantConnectionView, String> {
    gate(&app)?;
    let connections = store::read_connections(&app);
    let at = connections
        .iter()
        .position(|connection| connection.id == id)
        .ok_or_else(|| "no such Qdrant connection".to_string())?;
    let snapshot = connections[at].clone();
    let checked_at = semantic::now_ms();
    let profiles = available_profiles(&app, &docs)?;
    let bindings = imported_bindings(&docs, &snapshot.id)?;
    let runnable: Vec<EmbeddingProfile> = profiles
        .iter()
        .map(|stored| stored.profile.clone())
        .collect();
    let prior_access: HashMap<String, CollectionAccess> = cached_bucket_views(&snapshot)
        .into_iter()
        .filter_map(|bucket| match bucket.bucket_ref {
            KnowledgeBucketRef::Qdrant { collection, .. } => Some((
                collection,
                bucket.access.unwrap_or(CollectionAccess::Unknown),
            )),
            _ => None,
        })
        .collect();

    let refresh = async {
        let client = qdrant_client(&app, &snapshot)?;
        let info = client
            .server_info()
            .await
            .map_err(|error| error.to_string())?;
        let version = Version::parse(&info.version).map_err(|_| {
            format!(
                "Qdrant returned an invalid server version {:?}",
                info.version
            )
        })?;
        let names = client
            .list_collections()
            .await
            .map_err(|error| error.to_string())?;
        let inspected = stream::iter(names.into_iter().map(|name| {
            let client = &client;
            async move {
                let result: Result<QdrantCollectionInfo, crate::knowledge::qdrant::QdrantError> =
                    async {
                        let mut collection = client.collection_info(&name).await?;
                        client
                            .populate_contract_counts(&name, &mut collection)
                            .await?;
                        Ok(collection)
                    }
                    .await;
                (name, result)
            }
        }))
        .buffer_unordered(DISCOVERY_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

        let mut buckets = Vec::with_capacity(inspected.len());
        for (name, result) in inspected {
            match result {
                Ok(collection) => {
                    let access = prior_access
                        .get(&name)
                        .copied()
                        .unwrap_or(CollectionAccess::Unknown);
                    let raw = classify_collection(
                        &collection,
                        CompatibilityContext {
                            connection_id: &snapshot.id,
                            server_version: Some(&version),
                            runnable_profiles: &runnable,
                            access,
                            imported_binding: bindings.get(&name).map(|stored| &stored.binding),
                        },
                    );
                    buckets.push(remote_bucket_view(
                        raw,
                        &snapshot.label,
                        &profiles,
                        false,
                        None,
                        Some(&version),
                    ));
                }
                Err(error) => buckets.push(unreadable_bucket(&snapshot, name, error.to_string())),
            }
        }
        buckets.sort_by_key(|bucket| bucket.label.to_lowercase());
        Ok::<_, String>((info.version, buckets))
    }
    .await;

    let updated = match refresh {
        Ok((version, buckets)) => {
            let values = buckets
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            store::update_connection_if_current(&app, &snapshot, move |current| {
                if discovery_result_is_stale(current.last_checked_at, checked_at) {
                    return Ok(());
                }
                store::set_discovery(current, version, values, checked_at);
                Ok(())
            })?
        }
        Err(error) => store::update_connection_if_current(&app, &snapshot, move |current| {
            if discovery_result_is_stale(current.last_checked_at, checked_at) {
                return Ok(());
            }
            store::set_discovery_error(current, error, checked_at);
            Ok(())
        })?,
    };
    connection_view(&app, &updated)
}

#[tauri::command]
pub fn knowledge_buckets_list(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
) -> Result<Vec<KnowledgeBucketView>, String> {
    gate(&app)?;
    let profiles = available_profiles(&app, &docs)?;
    let mut buckets = if docs.exists() {
        docs.with(|conn| index::list_buckets(conn))?
            .into_iter()
            .map(|bucket| {
                let profile = bucket.embedding_profile_id.as_ref().and_then(|id| {
                    profiles
                        .iter()
                        .find(|stored| &stored.id == id)
                        .map(|stored| profile_view(stored.id.clone(), &stored.profile))
                });
                KnowledgeBucketView {
                    bucket_ref: KnowledgeBucketRef::Local {
                        bucket_id: bucket.id,
                    },
                    label: bucket.label,
                    connection_label: None,
                    profile,
                    compatibility: "managed_compatible".into(),
                    compatibility_reason: None,
                    attachable: bucket.chunk_count > 0,
                    deletable: false,
                    writable: true,
                    write_capability: "read_write".into(),
                    manageable: true,
                    file_count: u64::from(bucket.file_count),
                    chunk_count: u64::from(bucket.chunk_count),
                    pending_count: u64::from(bucket.pending_count + bucket.stale_count),
                    stale: false,
                    error: bucket.embedding_error,
                    access: Some(CollectionAccess::Manage),
                    vector_name: bucket.embedding_profile_id.map(|_| "embedding".into()),
                    quantization: None,
                    imported: false,
                    required_builtin_model_id: None,
                    required_provider: None,
                    server_version: None,
                    turbo_quant_supported: false,
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    for connection in store::read_connections(&app) {
        buckets.extend(
            cached_bucket_views(&connection)
                .into_iter()
                .filter(|bucket| bucket.compatibility != "unmanaged"),
        );
    }
    Ok(buckets)
}

/// Ask-mode retrieval uses the same asynchronous service as the Agent tool.
/// The array return shape stays compatible with the existing prompt-folding UI;
/// Agent mode additionally renders partial-source warnings in its tool result.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_search(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    buckets: Vec<KnowledgeBucketRef>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<crate::knowledge::search::KnowledgeSearchHit>, String> {
    gate(&app)?;
    Ok(crate::knowledge::search::search_knowledge(
        &app,
        &docs,
        &buckets,
        &query,
        limit.unwrap_or(crate::docs::search::DEFAULT_LIMIT),
    )
    .await?
    .hits)
}

/// Detailed Ask-mode retrieval preserves per-source failures so the UI can
/// explain when an answer was grounded by only a subset of attached buckets.
/// The legacy array command above remains for older frontend callers.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_search_detailed(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    buckets: Vec<KnowledgeBucketRef>,
    query: String,
    limit: Option<usize>,
) -> Result<crate::knowledge::search::SearchResponse, String> {
    gate(&app)?;
    crate::knowledge::search::search_knowledge(
        &app,
        &docs,
        &buckets,
        &query,
        limit.unwrap_or(crate::docs::search::DEFAULT_LIMIT),
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_buckets_create(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    name: String,
    connection_id: Option<String>,
    profile_id: Option<String>,
) -> Result<KnowledgeBucketView, String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let selected = match profile_id.as_deref() {
        Some(id) => Some(find_profile(&app, &docs, id)?),
        None => None,
    };
    let Some(connection_id) = connection_id else {
        let id = docs.with(|conn| index::create_bucket(conn, &name, ChunkSpec::default()))?;
        if let Some(stored) = &selected {
            let spec = stored.profile.semantic();
            docs.with(|conn| {
                semantic::assign_bucket_profile(
                    conn,
                    &id,
                    &stored.id,
                    stored.profile.fingerprint(),
                    &spec.model_id,
                    spec.dimensions,
                )
            })?;
        }
        return knowledge_buckets_list(app, docs)?
            .into_iter()
            .find(|bucket| {
                bucket.bucket_ref
                    == KnowledgeBucketRef::Local {
                        bucket_id: id.clone(),
                    }
            })
            .ok_or_else(|| "new local bucket was not found".into());
    };

    let selected = selected.ok_or("a remote bucket requires an embedding profile")?;
    let connections = store::read_connections(&app);
    let at = connections
        .iter()
        .position(|connection| connection.id == connection_id)
        .ok_or_else(|| "no such Qdrant connection".to_string())?;
    let snapshot = connections[at].clone();
    let client = qdrant_client(&app, &snapshot)?;
    let server = client
        .server_info()
        .await
        .map_err(|error| error.to_string())?;
    let version =
        Version::parse(&server.version).map_err(|_| "Qdrant returned an invalid version")?;
    client
        .create_collection(&version, &name, &selected.profile)
        .await
        .map_err(|error| error.to_string())?;
    let mut info = client
        .collection_info(&name)
        .await
        .map_err(|error| error.to_string())?;
    client
        .populate_contract_counts(&name, &mut info)
        .await
        .map_err(|error| error.to_string())?;
    let raw = classify_collection(
        &info,
        CompatibilityContext {
            connection_id: &connection_id,
            server_version: Some(&version),
            runnable_profiles: std::slice::from_ref(&selected.profile),
            access: CollectionAccess::Manage,
            imported_binding: None,
        },
    );
    let view = remote_bucket_view(
        raw,
        &snapshot.label,
        std::slice::from_ref(&selected),
        false,
        None,
        Some(&version),
    );
    let return_view = view.clone();
    store::update_connection_if_current(&app, &snapshot, move |current| {
        let mut current_cached = cached_bucket_views(current);
        current_cached.retain(|bucket| bucket.label != name);
        current_cached.push(view.clone());
        let values = current_cached
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        store::set_discovery(current, server.version, values, semantic::now_ms());
        Ok(())
    })?;
    Ok(return_view)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_buckets_delete(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
    confirmation: Option<String>,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    match bucket {
        KnowledgeBucketRef::Local { bucket_id } => {
            docs.with(|conn| index::delete_bucket(conn, &bucket_id))
        }
        KnowledgeBucketRef::Qdrant {
            connection_id,
            collection,
        } => {
            if confirmation.as_deref() != Some(collection.as_str()) {
                return Err("type the exact collection name to confirm remote deletion".into());
            }
            let client = resolve_deletable_collection(&app, &connection_id, &collection).await?;
            match client.delete_collection(&collection).await {
                Ok(()) => {}
                Err(error @ QdrantError::Permission { .. }) => {
                    if let Err(cache_error) =
                        remember_manage_denied(&app, &connection_id, &collection)
                    {
                        log::warn!("remember Qdrant manage denial failed: {cache_error}");
                    }
                    return Err(error.to_string());
                }
                Err(error) => return Err(error.to_string()),
            }
            if docs.exists() {
                docs.with(|database| {
                    crate::knowledge::ingest::forget_deleted_remote_collection(
                        database,
                        &connection_id,
                        &collection,
                    )
                })?;
            }
            let connections = store::read_connections(&app);
            let snapshot = store::find_connection(&connections, &connection_id)?.clone();
            store::update_connection_if_current(&app, &snapshot, |current| {
                current.collections.retain(|value| {
                    cached_bucket_from_value(value).is_none_or(|bucket| bucket.label != collection)
                });
                Ok(())
            })
            .map(|_| ())
        }
    }
}

#[tauri::command]
pub fn knowledge_embedding_catalog(app: tauri::AppHandle<Wry>) -> Result<Vec<Value>, String> {
    gate(&app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let models_dir = crate::models::registry::models_dir(
        &app_data,
        crate::commands::settings::read_string(&app, "models_dir").as_deref(),
    );
    Ok(embedding::builtin_embedding_catalog()
        .into_iter()
        .map(|model| {
            let (download, available, reason) = embedding_download_metadata(model.id);
            let installed =
                crate::knowledge::local::installed_artifact(&models_dir, model.id).is_some();
            serde_json::json!({
                "id": model.id,
                "label": model.display_name,
                "description": embedding_model_description(model.id),
                "provider": "local",
                "model": model.upstream_model_id,
                "dimensions": dimension_values(model.dimensions, model.native_dimensions),
                "default_dimension": model.native_dimensions,
                "context_tokens": model.max_input_tokens,
                "download": download,
                "installed": installed,
                "available": available,
                "unavailable_reason": reason,
                "recommended": model.recommended,
                "privacy": "local"
            })
        })
        .collect())
}

fn dimension_values(support: embedding::DimensionSupport, native: u32) -> Vec<u32> {
    match support {
        embedding::DimensionSupport::Fixed(value) => vec![value],
        embedding::DimensionSupport::Explicit(values) => values.to_vec(),
        // Do not render thousands of choices; native is the guided default and a
        // compact MRL set is offered under Advanced.
        embedding::DimensionSupport::InclusiveRange { min, max } => {
            [min, 128, 256, 512, 768, 1024, native]
                .into_iter()
                .filter(|value| *value >= min && *value <= max)
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        }
    }
}

fn embedding_model_description(id: &str) -> &'static str {
    match id {
        "local/qwen3-embedding-0.6b" => "Fast multilingual retrieval for laptops and CPU use.",
        "local/qwen3-embedding-4b" => {
            "Balanced multilingual quality and memory use for workstations."
        }
        "local/qwen3-embedding-8b" => {
            "Highest-quality Qwen retrieval for servers with more memory."
        }
        "local/embeddinggemma-300m" => {
            "Compact Google text embeddings that run entirely on-device."
        }
        "local/multilingual-e5-base" => "100-language Sentence Transformers retrieval model.",
        "local/multilingual-e5-large" => {
            "Higher-quality multilingual Sentence Transformers retrieval model."
        }
        _ => "Local embedding model.",
    }
}

fn embedding_download_metadata(id: &str) -> (Option<Value>, bool, Option<&'static str>) {
    let row = match id {
        "local/qwen3-embedding-0.6b" => Some((
            "Qwen/Qwen3-Embedding-0.6B-GGUF",
            "Qwen3-Embedding-0.6B-Q8_0.gguf",
            639_150_592_u64,
            2_u64,
            false,
        )),
        "local/qwen3-embedding-4b" => Some((
            "Qwen/Qwen3-Embedding-4B-GGUF",
            "Qwen3-Embedding-4B-Q4_K_M.gguf",
            2_496_703_776,
            6,
            false,
        )),
        "local/qwen3-embedding-8b" => Some((
            "Qwen/Qwen3-Embedding-8B-GGUF",
            "Qwen3-Embedding-8B-Q4_K_M.gguf",
            4_676_804_928,
            10,
            false,
        )),
        "local/embeddinggemma-300m" => Some((
            "ggml-org/embeddinggemma-300M-GGUF",
            "embeddinggemma-300M-Q8_0.gguf",
            333_590_944,
            1,
            true,
        )),
        _ => None,
    };
    match row {
        Some((repo, filename, size, ram, requires_license)) => (
            Some(serde_json::json!({
                "repo_id": repo,
                "filename": filename,
                "size_bytes": size,
                "min_ram_gb": ram,
                "requires_license": requires_license
            })),
            true,
            None,
        ),
        None => (
            None,
            false,
            Some("The signed Veviad Q8 GGUF release manifest has not been published yet."),
        ),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_embedding_profile_create_cloud(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    provider: String,
    model: String,
    dimensions: Option<u32>,
) -> Result<String, String> {
    gate(&app)?;
    let (profile, credential_id, base_url, id) = match provider.as_str() {
        "openai" => {
            let max = match model.as_str() {
                "text-embedding-3-small" => 1536,
                "text-embedding-3-large" => 3072,
                _ => return Err("unsupported OpenAI embedding model".into()),
            };
            let dimensions = dimensions.unwrap_or(max);
            if dimensions == 0 || dimensions > max {
                return Err(format!("{model} supports at most {max} dimensions"));
            }
            (
                embedding::openai_profile(model.clone(), dimensions)
                    .map_err(|error| error.to_string())?,
                crate::credentials::CredentialId::OpenAi,
                "https://api.openai.com",
                format!("openai/{model}/{dimensions}"),
            )
        }
        "mistral" => {
            let max = match model.as_str() {
                "mistral-embed" => 1024,
                "codestral-embed" => 3072,
                _ => return Err("unsupported Mistral embedding model".into()),
            };
            let dimensions = dimensions.unwrap_or(max);
            if dimensions == 0 || dimensions > max {
                return Err(format!("{model} supports at most {max} dimensions"));
            }
            (
                embedding::mistral_profile(model.clone(), dimensions)
                    .map_err(|error| error.to_string())?,
                crate::credentials::CredentialId::Mistral,
                "https://api.mistral.ai",
                format!("mistral/{model}/{dimensions}"),
            )
        }
        _ => return Err("only OpenAI and Mistral cloud embeddings are supported".into()),
    };
    let key = crate::commands::settings::read_credential(&app, credential_id)?
        .ok_or_else(|| format!("add the {provider} API key in Settings first"))?;
    let endpoint = embedding::EmbeddingEndpoint::new(base_url, Some(key))
        .map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    // Real requests verify both retrieval roles instead of trusting a model-list
    // label.  These short strings also keep the first-use privacy/cost tiny.
    let query = embedding::embed_http_batch(
        &client,
        &endpoint,
        &profile,
        EmbeddingPurpose::Query,
        &[EmbeddingInput::text("How do I reset an account password?")],
    )
    .await
    .map_err(|error| error.to_string())?;
    let documents = embedding::embed_http_batch(
        &client,
        &endpoint,
        &profile,
        EmbeddingPurpose::Document,
        &[
            EmbeddingInput::document("Steps for resetting an account password.", None),
            EmbeddingInput::document("A recipe for tomato soup.", None),
        ],
    )
    .await
    .map_err(|error| error.to_string())?;
    let probe = embedding::retrieval_probe(
        &query.vectors[0],
        &documents.vectors[0],
        &documents.vectors[1],
    )
    .map_err(|error| error.to_string())?;
    if !probe.relevant_ranked_first {
        return Err("the embedding preflight did not rank the relevant document first".into());
    }
    let value = serde_json::to_value(&profile).map_err(|error| error.to_string())?;
    docs.with(|conn| semantic::put_profile(conn, &id, profile.fingerprint(), &value, "ready"))?;
    Ok(id)
}

/// Forget only VTerminal's local interpretation. The remote collection and every
/// point in it remain untouched.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_qdrant_import_remove(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let KnowledgeBucketRef::Qdrant {
        connection_id,
        collection,
    } = bucket
    else {
        return Err("guided import applies only to a Qdrant collection".into());
    };
    if docs.exists() {
        docs.with(|database| {
            semantic::delete_qdrant_binding(database, &connection_id, &collection).map(|_| ())
        })?;
    }
    let connections = store::read_connections(&app);
    if let Some(snapshot) = connections
        .iter()
        .find(|connection| connection.id == connection_id)
        .cloned()
    {
        store::update_connection_if_current(&app, &snapshot, move |connection| {
            for value in &mut connection.collections {
                let Some(mut bucket) = cached_bucket_from_value(value) else {
                    continue;
                };
                if bucket.label != collection {
                    continue;
                }
                bucket.profile = None;
                bucket.compatibility = "unmanaged".into();
                bucket.compatibility_reason = Some(
                    "This is not a VTerminal-managed collection and is hidden from Knowledge buckets."
                        .into(),
                );
                bucket.attachable = false;
                bucket.deletable = false;
                bucket.vector_name = None;
                bucket.imported = false;
                bucket.required_builtin_model_id = None;
                bucket.required_provider = None;
                *value = serde_json::to_value(bucket).map_err(|error| error.to_string())?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_documents_list(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
    cursor: Option<PointId>,
    limit: Option<usize>,
) -> Result<DocumentPage, String> {
    gate(&app)?;
    let KnowledgeBucketRef::Qdrant {
        connection_id,
        collection,
    } = bucket
    else {
        return Err("local documents use docs_files_list".into());
    };
    let (client, _, _) =
        resolve_managed_collection(&app, &docs, &connection_id, &collection).await?;
    let page_size = limit.unwrap_or(50).clamp(1, 200);
    if cursor.is_none() {
        let (page, counts) = tokio::join!(
            client.scroll_documents(&collection, cursor, page_size),
            client.active_document_counts(&collection),
        );
        let mut page = page.map_err(|error| error.to_string())?;
        // The document page remains useful if supplemental counting fails. A
        // successful count is returned for immediate UI reconciliation and also
        // persisted so later cached reads stay correct.
        if let Ok(counts) = counts {
            page.file_count = Some(counts.0);
            page.chunk_count = Some(counts.1);
            let _ = cache_remote_document_counts(&app, &connection_id, &collection, counts);
        }
        Ok(page)
    } else {
        client
            .scroll_documents(&collection, cursor, page_size)
            .await
            .map_err(|error| error.to_string())
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_document_delete(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
    document_id: String,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let KnowledgeBucketRef::Qdrant {
        connection_id,
        collection,
    } = bucket
    else {
        return Err("local documents use docs_file_remove".into());
    };
    crate::knowledge::ingest::ensure_remote_document_idle(
        &docs,
        &connection_id,
        &collection,
        &document_id,
    )?;
    let (client, _, _) =
        resolve_managed_collection(&app, &docs, &connection_id, &collection).await?;
    match client.delete_document(&collection, &document_id).await {
        Ok(_) => {}
        Err(error @ QdrantError::Permission { .. }) => {
            if let Err(cache_error) = crate::knowledge::ingest::remember_point_access(
                &app,
                &connection_id,
                &collection,
                false,
            ) {
                log::warn!("remember Qdrant read-only access failed: {cache_error}");
            }
            return Err(error.to_string());
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_document_update(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
    document_id: String,
    update: DocumentMetadataUpdate,
) -> Result<(), String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let KnowledgeBucketRef::Qdrant {
        connection_id,
        collection,
    } = bucket
    else {
        return Err("local source metadata comes from the source file".into());
    };
    crate::knowledge::ingest::ensure_remote_document_idle(
        &docs,
        &connection_id,
        &collection,
        &document_id,
    )?;
    let (client, _, _) =
        resolve_managed_collection(&app, &docs, &connection_id, &collection).await?;
    match client
        .update_document_metadata(&collection, &document_id, &update)
        .await
    {
        Ok(_) => {}
        Err(error @ QdrantError::Permission { .. }) => {
            if let Err(cache_error) = crate::knowledge::ingest::remember_point_access(
                &app,
                &connection_id,
                &collection,
                false,
            ) {
                log::warn!("remember Qdrant read-only access failed: {cache_error}");
            }
            return Err(error.to_string());
        }
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_qdrant_turbo_quant_set(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
    config: Option<TurboQuantConfig>,
) -> Result<KnowledgeBucketView, String> {
    gate(&app)?;
    let _process_lock = knowledge_writer_lock(&app).await?;
    let KnowledgeBucketRef::Qdrant {
        connection_id,
        collection,
    } = bucket
    else {
        return Err("TurboQuant applies only to Qdrant collections".into());
    };
    let connections = store::read_connections(&app);
    let snapshot = store::find_connection(&connections, &connection_id)?.clone();
    let (client, current, version) =
        resolve_managed_collection(&app, &docs, &connection_id, &collection).await?;
    let expected = config.map_or(QuantizationStatus::Off, |config| {
        QuantizationStatus::Turbo {
            bits: config.bits,
            always_ram: config.always_ram,
        }
    });
    let changed = current.quantization != expected;
    if changed {
        if let QuantizationStatus::Other { kind } = &current.quantization {
            return Err(format!(
                "this collection uses {kind} quantization; VTerminal will not replace a non-TurboQuant configuration"
            ));
        }
        if let Some(config) = config {
            if let Err(error) = client.set_turbo_quant(&version, &collection, config).await {
                if matches!(&error, QdrantError::Permission { .. }) {
                    if let Err(cache_error) =
                        remember_manage_denied(&app, &connection_id, &collection)
                    {
                        log::warn!("remember Qdrant manage denial failed: {cache_error}");
                    }
                }
                return Err(error.to_string());
            }
        } else {
            if let Err(error) = client.disable_quantization(&collection).await {
                if matches!(&error, QdrantError::Permission { .. }) {
                    if let Err(cache_error) =
                        remember_manage_denied(&app, &connection_id, &collection)
                    {
                        log::warn!("remember Qdrant manage denial failed: {cache_error}");
                    }
                }
                return Err(error.to_string());
            }
        }
    } else if matches!(current.quantization, QuantizationStatus::Other { .. }) {
        return Err("VTerminal cannot manage this collection's non-TurboQuant quantization".into());
    }

    let mut confirmed = client.collection_info(&collection).await.map_err(|error| {
        turbo_confirm_error(changed, format!("read the updated collection: {error}"))
    })?;
    client
        .populate_contract_counts(&collection, &mut confirmed)
        .await
        .map_err(|error| turbo_confirm_error(changed, format!("refresh exact counts: {error}")))?;
    if confirmed.quantization != expected {
        return Err(turbo_confirm_error(
            changed,
            format!(
                "Qdrant reports {:?}, expected {:?}",
                confirmed.quantization, expected
            ),
        ));
    }

    let profiles = available_profiles(&app, &docs)?;
    let runnable = profiles
        .iter()
        .map(|stored| stored.profile.clone())
        .collect::<Vec<_>>();
    let access = cached_bucket_views(&snapshot)
        .into_iter()
        .find(|bucket| bucket.label == collection)
        .and_then(|bucket| bucket.access)
        .unwrap_or(CollectionAccess::Manage);
    let descriptor = classify_collection(
        &confirmed,
        CompatibilityContext {
            connection_id: &connection_id,
            server_version: Some(&version),
            runnable_profiles: &runnable,
            access,
            imported_binding: None,
        },
    );
    let view = remote_bucket_view(
        descriptor,
        &snapshot.label,
        &profiles,
        false,
        None,
        Some(&version),
    );
    let cached_value = serde_json::to_value(&view).map_err(|error| error.to_string())?;
    store::update_connection_if_current(&app, &snapshot, |connection| {
        let entry = connection
            .collections
            .iter_mut()
            .find(|value| {
                cached_bucket_from_value(value)
                    .is_some_and(|bucket| bucket.bucket_ref == view.bucket_ref)
            })
            .ok_or_else(|| {
                "the collection is not in the current discovery cache; refresh the connection"
                    .to_string()
            })?;
        *entry = cached_value;
        connection.status = "connected".into();
        connection.error = None;
        connection.last_checked_at = Some(semantic::now_ms());
        Ok(())
    })
    .map_err(|error| {
        if changed {
            format!(
                "TurboQuant was saved and confirmed in Qdrant, but VTerminal could not update its local cache: {error}. Refresh the connection."
            )
        } else {
            error
        }
    })?;
    Ok(view)
}

fn turbo_confirm_error(changed: bool, detail: String) -> String {
    if changed {
        format!(
            "Qdrant accepted the TurboQuant update, but VTerminal could not confirm the resulting configuration ({detail}). Refresh the connection before retrying."
        )
    } else {
        detail
    }
}

/// Queue extracted text for durable local/Qdrant ingestion. Extraction and OCR
/// stay UI-owned; neither this command nor its job payload stores original bytes.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_document_ingest(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket: KnowledgeBucketRef,
    mut document: crate::knowledge::ingest::IngestDocument,
    pages: Vec<crate::knowledge::ingest::IngestPage>,
) -> Result<crate::knowledge::ingest::JobView, String> {
    gate(&app)?;
    crate::knowledge::ingest::validate_document(&mut document, &pages)?;
    let job = crate::knowledge::ingest::new_ingest_job(&bucket, document, pages)?;
    docs.with(|connection| semantic::put_job(connection, &job))?;
    let view = crate::knowledge::ingest::job_view(&docs, &job.id)?;
    crate::knowledge::ingest::notify_job_changed(&app, &docs, &job.id);
    crate::knowledge::ingest::wake_job_runner(&app)?;
    Ok(view)
}

/// Embed every pending chunk in an already-indexed local semantic bucket. This is
/// the bridge from the established `docs_put_text` extraction flow to sqlite-vec.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_bucket_embed(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket_id: String,
) -> Result<crate::knowledge::ingest::JobView, String> {
    gate(&app)?;
    // Fail before queuing if the bucket/profile is not usable.
    docs.with(|connection| {
        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM doc_buckets b
                   JOIN knowledge_embedding_profiles p ON p.id=b.embedding_profile_id
                  WHERE b.id=?1 AND p.status='ready'",
                [&bucket_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Err("this local bucket has no ready embedding profile".into());
        }
        Ok(())
    })?;
    let job = crate::knowledge::ingest::new_local_backfill_job(bucket_id)?;
    docs.with(|connection| semantic::put_job(connection, &job))?;
    let view = crate::knowledge::ingest::job_view(&docs, &job.id)?;
    crate::knowledge::ingest::notify_job_changed(&app, &docs, &job.id);
    crate::knowledge::ingest::wake_job_runner(&app)?;
    Ok(view)
}

/// Upgrade a keyword-only local bucket to one immutable semantic profile and
/// immediately queue embedding of all existing chunks.
#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_bucket_semantic_enable(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    bucket_id: String,
    profile_id: String,
) -> Result<crate::knowledge::ingest::JobView, String> {
    gate(&app)?;
    let selected = find_profile(&app, &docs, &profile_id)?;
    let profile = selected.profile.semantic();
    docs.with(|connection| {
        semantic::assign_bucket_profile(
            connection,
            &bucket_id,
            &selected.id,
            selected.profile.fingerprint(),
            &profile.model_id,
            profile.dimensions,
        )
    })?;
    let job = crate::knowledge::ingest::new_local_backfill_job(bucket_id)?;
    docs.with(|connection| semantic::put_job(connection, &job))?;
    let view = crate::knowledge::ingest::job_view(&docs, &job.id)?;
    crate::knowledge::ingest::notify_job_changed(&app, &docs, &job.id);
    crate::knowledge::ingest::wake_job_runner(&app)?;
    Ok(view)
}

#[tauri::command]
pub fn knowledge_jobs_list(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
) -> Result<Vec<crate::knowledge::ingest::JobView>, String> {
    gate(&app)?;
    if !docs.exists() {
        return Ok(Vec::new());
    }
    docs.with(|conn| semantic::list_jobs(conn))
        .map(crate::knowledge::ingest::job_views)
}

#[tauri::command(rename_all = "snake_case")]
pub fn knowledge_jobs_cancel(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    id: String,
) -> Result<crate::knowledge::ingest::JobView, String> {
    gate(&app)?;
    let job = crate::knowledge::ingest::cancel_job(&docs, &id)?;
    crate::knowledge::ingest::notify_job_changed(&app, &docs, &id);
    Ok(job.into())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn knowledge_jobs_retry(
    app: tauri::AppHandle<Wry>,
    docs: State<'_, crate::docs::db::DocsDb>,
    id: String,
) -> Result<crate::knowledge::ingest::JobView, String> {
    gate(&app)?;
    let job = crate::knowledge::ingest::prepare_retry(&docs, &id)?;
    let view = crate::knowledge::ingest::job_view(&docs, &job.id)?;
    crate::knowledge::ingest::notify_job_changed(&app, &docs, &job.id);
    crate::knowledge::ingest::wake_job_runner(&app)?;
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_wire_names_match_the_frontend() {
        assert_eq!(
            compatibility_name(CollectionCompatibility::ManagedCompatible),
            "managed_compatible"
        );
        assert_eq!(
            compatibility_name(CollectionCompatibility::RequiresProfile),
            "requires_profile"
        );
        assert_eq!(
            compatibility_name(CollectionCompatibility::Unmanaged),
            "unmanaged"
        );
        assert_eq!(
            compatibility_name(CollectionCompatibility::LegacyImport),
            "legacy_import"
        );
    }

    #[test]
    fn older_discovery_results_cannot_overwrite_a_confirmed_target_update() {
        assert!(!discovery_result_is_stale(None, 10));
        assert!(!discovery_result_is_stale(Some(9), 10));
        assert!(discovery_result_is_stale(Some(10), 10));
        assert!(discovery_result_is_stale(Some(11), 10));
    }

    #[test]
    fn only_a_missing_legacy_deletable_field_is_migrated() {
        let legacy = serde_json::json!({ "compatibility": "managed_compatible" });
        assert!(should_migrate_legacy_deletable(
            &legacy,
            false,
            "managed_compatible"
        ));

        let current = serde_json::json!({ "deletable": false });
        assert!(!should_migrate_legacy_deletable(
            &current,
            false,
            "managed_compatible"
        ));
        assert!(!should_migrate_legacy_deletable(
            &legacy,
            true,
            "managed_compatible"
        ));
        assert!(!should_migrate_legacy_deletable(
            &legacy,
            false,
            "unmanaged"
        ));
    }

    #[test]
    fn catalog_is_exactly_six_and_only_four_have_published_artifacts() {
        let models = embedding::builtin_embedding_catalog();
        assert_eq!(models.len(), 6);
        assert_eq!(
            models
                .iter()
                .filter(|model| embedding_download_metadata(model.id).1)
                .count(),
            4
        );
    }
}
