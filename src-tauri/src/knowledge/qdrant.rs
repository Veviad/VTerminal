//! Bounded, credential-safe Qdrant REST client.

use std::fmt;
use std::time::Duration;

use reqwest::{Method, StatusCode};
use semver::Version;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use thiserror::Error;

use super::contract::{
    active_chunks_filter, active_manifests_filter, chunk_point, document_filter,
    document_manifests_filter, document_metadata_payload, manifest_point, metadata_from_config,
    metadata_value, other_revisions_filter, parse_chunk_payload, parse_manifest_payload,
    payload_indexes_from_schema, revision_filter, REQUIRED_PAYLOAD_INDEXES,
};
use super::types::VTERMINAL_VECTOR_NAME;
use super::types::{
    DocumentChunk, DocumentManifest, DocumentMetadataUpdate, DocumentPage,
    ImportedCollectionBinding, KnowledgeBucketRef, KnowledgeHit, OperationReceipt, PayloadSample,
    PointId, QdrantCollectionInfo, QdrantServerCapabilities, QdrantServerInfo, QuantizationStatus,
    TurboQuantBits, TurboQuantConfig, VectorDescriptor, QDRANT_MANAGED_MIN_VERSION,
    QDRANT_TURBO_QUANT_MIN_VERSION,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_UPSERT_POINTS: usize = 256;
const MAX_QUERY_LIMIT: usize = 100;
const MAX_SCROLL_LIMIT: usize = 200;

/// Normalized endpoint plus transport policy.  API keys are accepted separately
/// by [`QdrantClient::new`] and never become part of this serializable value.
#[derive(Clone, PartialEq, Eq)]
pub struct QdrantEndpoint {
    base_url: String,
    allow_insecure: bool,
}

impl QdrantEndpoint {
    pub fn parse(
        input: &str,
        has_api_key: bool,
        allow_insecure: bool,
    ) -> Result<Self, QdrantError> {
        let raw = input.trim();
        if raw.is_empty() {
            return Err(QdrantError::InvalidInput("a Qdrant URL is required".into()));
        }
        if raw
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(QdrantError::InvalidInput(
                "a Qdrant URL cannot contain whitespace or control characters".into(),
            ));
        }
        if !raw.contains("://") {
            return Err(QdrantError::InvalidInput(
                "include http:// or https:// in the Qdrant URL".into(),
            ));
        }
        let mut url = url::Url::parse(raw)
            .map_err(|error| QdrantError::InvalidInput(format!("invalid Qdrant URL: {error}")))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(QdrantError::InvalidInput(
                "only http:// and https:// Qdrant URLs are supported".into(),
            ));
        }
        if url.host_str().is_none() {
            return Err(QdrantError::InvalidInput(
                "the Qdrant URL has no host".into(),
            ));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(QdrantError::InvalidInput(
                "the Qdrant URL cannot contain credentials; use the API-key field".into(),
            ));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(QdrantError::InvalidInput(
                "the Qdrant URL cannot contain a query string or fragment".into(),
            ));
        }
        if url.port() == Some(0) {
            return Err(QdrantError::InvalidInput(
                "port must be between 1 and 65535".into(),
            ));
        }
        let is_loopback = url.host_str().is_some_and(is_loopback_host);
        if has_api_key && url.scheme() == "http" && !is_loopback && !allow_insecure {
            return Err(QdrantError::InsecureTransport(
                "an API key cannot be sent over non-local HTTP; use HTTPS or explicitly allow insecure transport"
                    .into(),
            ));
        }
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(&path);
        let base_url = url.to_string().trim_end_matches('/').to_string();
        Ok(Self {
            base_url,
            allow_insecure,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn allow_insecure(&self) -> bool {
        self.allow_insecure
    }

    fn url(&self, path: &str) -> String {
        if path == "/" {
            format!("{}/", self.base_url)
        } else {
            format!("{}{}", self.base_url, path)
        }
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

impl fmt::Debug for QdrantEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("QdrantEndpoint")
            .field("base_url", &self.base_url)
            .field("allow_insecure", &self.allow_insecure)
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum QdrantError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    InsecureTransport(String),
    #[error("could not reach Qdrant at {endpoint}: {detail}")]
    Transport { endpoint: String, detail: String },
    #[error("Qdrant denied this operation (HTTP {status}); check this key's collection permissions{detail}")]
    Permission { status: u16, detail: String },
    #[error("Qdrant authentication failed (HTTP {status}){detail}")]
    Authentication { status: u16, detail: String },
    #[error("Qdrant collection {collection:?} was not found")]
    CollectionNotFound { collection: String },
    #[error("Qdrant returned HTTP {status}{detail}")]
    Http { status: u16, detail: String },
    #[error("Qdrant returned an invalid response: {0}")]
    Protocol(String),
    #[error("Qdrant {installed} does not support {feature}; version {required}+ is required")]
    UnsupportedVersion {
        feature: &'static str,
        installed: Version,
        required: Version,
    },
}

/// A client owns the write-only API key.  Its Debug implementation intentionally
/// exposes only whether a key exists.
pub struct QdrantClient {
    endpoint: QdrantEndpoint,
    api_key: Option<String>,
    client: reqwest::Client,
}

impl fmt::Debug for QdrantClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("QdrantClient")
            .field("endpoint", &self.endpoint)
            .field("has_api_key", &self.api_key.is_some())
            .finish()
    }
}

impl QdrantClient {
    pub fn new(endpoint: QdrantEndpoint, api_key: Option<String>) -> Result<Self, QdrantError> {
        let api_key = api_key.and_then(|key| {
            let trimmed = key.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        });
        // Re-run the keyed transport policy so a caller cannot parse without a
        // key and add one afterwards to bypass the TLS gate.
        let endpoint = QdrantEndpoint::parse(
            endpoint.base_url(),
            api_key.is_some(),
            endpoint.allow_insecure(),
        )?;
        let client = reqwest::Client::builder()
            .user_agent(concat!("vterminal/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| QdrantError::Protocol(error.to_string()))?;
        Ok(Self {
            endpoint,
            api_key,
            client,
        })
    }

    pub fn endpoint(&self) -> &QdrantEndpoint {
        &self.endpoint
    }

    pub fn has_api_key(&self) -> bool {
        self.api_key.is_some()
    }

    pub async fn server_info(&self) -> Result<QdrantServerInfo, QdrantError> {
        let response: RootResponse = self.send(Method::GET, "/", None).await?;
        server_info_from_root(response)
    }

    /// List exactly what the supplied key is permitted to see.  No write probe
    /// follows this call.
    pub async fn list_collections(&self) -> Result<Vec<String>, QdrantError> {
        let envelope: Envelope<CollectionsResult> =
            self.send(Method::GET, "/collections", None).await?;
        ensure_ok(&envelope.status)?;
        Ok(envelope
            .result
            .collections
            .into_iter()
            .map(|collection| collection.name)
            .collect())
    }

    pub async fn collection_info(
        &self,
        collection: &str,
    ) -> Result<QdrantCollectionInfo, QdrantError> {
        validate_collection_name(collection)?;
        let path = format!("/collections/{}", encode_path_segment(collection));
        let envelope: Envelope<Value> = self.send(Method::GET, &path, None).await?;
        ensure_ok(&envelope.status)?;
        parse_collection_info(collection, envelope.result)
    }

    /// App-created collections require server-side metadata, introduced in
    /// Qdrant 1.16.  Payload indexes are created before the method returns so
    /// strict-mode filtered operations are safe immediately.
    pub async fn create_collection(
        &self,
        server_version: &Version,
        collection: &str,
        profile: &super::embedding::EmbeddingProfile,
    ) -> Result<(), QdrantError> {
        require_version(
            server_version,
            QDRANT_MANAGED_MIN_VERSION,
            "managed collection metadata",
        )?;
        validate_collection_name(collection)?;
        let spec = profile.semantic();
        let body = json!({
            "vectors": {
                VTERMINAL_VECTOR_NAME: {
                    "size": spec.dimensions,
                    "distance": "Cosine",
                    "datatype": "float32"
                }
            },
            "metadata": metadata_value(profile)
        });
        let path = format!("/collections/{}", encode_path_segment(collection));
        let envelope: Envelope<Value> = self.send(Method::PUT, &path, Some(body)).await?;
        ensure_ok(&envelope.status)?;

        for field in REQUIRED_PAYLOAD_INDEXES {
            self.create_payload_index(collection, field).await?;
        }
        Ok(())
    }

    pub async fn delete_collection(&self, collection: &str) -> Result<(), QdrantError> {
        validate_collection_name(collection)?;
        let path = format!(
            "/collections/{}?timeout=60",
            encode_path_segment(collection)
        );
        let envelope: Envelope<Value> = self.send(Method::DELETE, &path, None).await?;
        ensure_ok(&envelope.status)
    }

    pub async fn create_payload_index(
        &self,
        collection: &str,
        field: &str,
    ) -> Result<OperationReceipt, QdrantError> {
        validate_collection_name(collection)?;
        if !REQUIRED_PAYLOAD_INDEXES.contains(&field) {
            return Err(QdrantError::InvalidInput(format!(
                "{field:?} is not a managed VTerminal payload index"
            )));
        }
        let path = format!(
            "/collections/{}/index?wait=true",
            encode_path_segment(collection)
        );
        let schema = if field == super::contract::PAYLOAD_REVISION_FIELD {
            "integer"
        } else {
            "keyword"
        };
        let envelope: Envelope<Value> = self
            .send(
                Method::PUT,
                &path,
                Some(json!({ "field_name": field, "field_schema": schema })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        parse_operation_receipt(envelope.result)
    }

    pub async fn query(
        &self,
        connection_id: &str,
        collection: &str,
        vector_name: &str,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<KnowledgeHit>, QdrantError> {
        validate_collection_name(collection)?;
        validate_vector(vector)?;
        if vector_name.is_empty() {
            return Err(QdrantError::InvalidInput(
                "a named vector is required".into(),
            ));
        }
        if limit == 0 || limit > MAX_QUERY_LIMIT {
            return Err(QdrantError::InvalidInput(format!(
                "query limit must be between 1 and {MAX_QUERY_LIMIT}"
            )));
        }
        let path = format!(
            "/collections/{}/points/query",
            encode_path_segment(collection)
        );
        let envelope: Envelope<QueryResult> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "query": vector,
                    "using": vector_name,
                    "filter": active_chunks_filter(),
                    "limit": limit,
                    "with_payload": true,
                    "with_vector": false
                })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        envelope
            .result
            .points
            .into_iter()
            .map(|point| {
                let id = point.id.to_string();
                let payload = parse_chunk_payload(point.payload).map_err(QdrantError::Protocol)?;
                Ok(KnowledgeHit {
                    bucket: KnowledgeBucketRef::Qdrant {
                        connection_id: connection_id.into(),
                        collection: collection.into(),
                    },
                    document_id: payload.document_id,
                    chunk_id: format!("qdrant:{connection_id}:{collection}:{id}"),
                    title: payload.title,
                    source_uri: payload.source_uri,
                    mime_type: payload.mime_type,
                    page: payload.page,
                    heading: payload.heading,
                    revision: payload.revision,
                    text: payload.text,
                    score: point.score,
                })
            })
            .collect()
    }

    /// Search an explicitly imported external collection. Unlike managed search,
    /// this sends no VTerminal payload filter and interprets citation fields only
    /// through the user-attested local binding.
    pub async fn query_imported(
        &self,
        connection_id: &str,
        collection: &str,
        binding: &ImportedCollectionBinding,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<KnowledgeHit>, QdrantError> {
        validate_collection_name(collection)?;
        validate_vector(vector)?;
        if binding.connection_id != connection_id || binding.collection != collection {
            return Err(QdrantError::InvalidInput(
                "the imported binding does not identify this collection".into(),
            ));
        }
        if !binding.model_attested {
            return Err(QdrantError::InvalidInput(
                "the imported collection's exact embedding model was not attested".into(),
            ));
        }
        if limit == 0 || limit > MAX_QUERY_LIMIT {
            return Err(QdrantError::InvalidInput(format!(
                "query limit must be between 1 and {MAX_QUERY_LIMIT}"
            )));
        }
        let path = format!(
            "/collections/{}/points/query",
            encode_path_segment(collection)
        );
        let mut body = json!({
            "query": vector,
            "limit": limit,
            "with_payload": true,
            "with_vector": false
        });
        if !binding.vector_name.is_empty() {
            body["using"] = Value::String(binding.vector_name.clone());
        }
        let envelope: Envelope<QueryResult> = self.send(Method::POST, &path, Some(body)).await?;
        ensure_ok(&envelope.status)?;
        let mut hits = Vec::new();
        for point in envelope.result.points {
            if let Some(hit) = parse_imported_hit(connection_id, collection, binding, point)? {
                hits.push(hit);
            }
        }
        Ok(hits)
    }

    pub async fn scroll_documents(
        &self,
        collection: &str,
        cursor: Option<PointId>,
        limit: usize,
    ) -> Result<DocumentPage, QdrantError> {
        validate_collection_name(collection)?;
        if limit == 0 || limit > MAX_SCROLL_LIMIT {
            return Err(QdrantError::InvalidInput(format!(
                "document page size must be between 1 and {MAX_SCROLL_LIMIT}"
            )));
        }
        let path = format!(
            "/collections/{}/points/scroll",
            encode_path_segment(collection)
        );
        let mut body = json!({
            "filter": active_manifests_filter(),
            "limit": limit,
            "with_payload": true,
            "with_vector": false
        });
        if let Some(cursor) = cursor {
            body["offset"] = serde_json::to_value(cursor)
                .map_err(|error| QdrantError::Protocol(error.to_string()))?;
        }
        let envelope: Envelope<ScrollResult> = self.send(Method::POST, &path, Some(body)).await?;
        ensure_ok(&envelope.status)?;
        let documents = envelope
            .result
            .points
            .into_iter()
            .map(|point| {
                parse_manifest_payload(point.id, point.payload).map_err(QdrantError::Protocol)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DocumentPage {
            documents,
            next_cursor: envelope.result.next_page_offset,
        })
    }

    /// Read the highest active and highest allocated manifest revisions for one
    /// document. Staging revisions count toward the allocation head so a
    /// cancelled upload can never cause a later job to reuse point ids.
    pub async fn document_revision_head(
        &self,
        collection: &str,
        document_id: &str,
    ) -> Result<(Option<u64>, Option<u64>), QdrantError> {
        validate_collection_name(collection)?;
        if document_id.trim().is_empty() {
            return Err(QdrantError::InvalidInput("document id is required".into()));
        }
        let path = format!(
            "/collections/{}/points/scroll",
            encode_path_segment(collection)
        );
        let mut cursor: Option<PointId> = None;
        let mut active = None;
        let mut highest = None;
        loop {
            let mut body = json!({
                "filter": document_manifests_filter(document_id),
                "limit": MAX_SCROLL_LIMIT,
                "with_payload": true,
                "with_vector": false
            });
            if let Some(offset) = cursor {
                body["offset"] = serde_json::to_value(offset)
                    .map_err(|error| QdrantError::Protocol(error.to_string()))?;
            }
            let envelope: Envelope<ScrollResult> =
                self.send(Method::POST, &path, Some(body)).await?;
            ensure_ok(&envelope.status)?;
            for point in envelope.result.points {
                let summary = parse_manifest_payload(point.id, point.payload)
                    .map_err(QdrantError::Protocol)?;
                highest = Some(highest.unwrap_or(0).max(summary.manifest.revision));
                if summary.manifest.state == super::types::DocumentState::Active {
                    active = Some(active.unwrap_or(0).max(summary.manifest.revision));
                }
            }
            match envelope.result.next_page_offset {
                Some(next) => cursor = Some(next),
                None => return Ok((active, highest)),
            }
        }
    }

    pub async fn sample_payloads(
        &self,
        collection: &str,
        limit: usize,
    ) -> Result<Vec<PayloadSample>, QdrantError> {
        validate_collection_name(collection)?;
        if limit == 0 || limit > 20 {
            return Err(QdrantError::InvalidInput(
                "import sampling limit must be between 1 and 20".into(),
            ));
        }
        let path = format!(
            "/collections/{}/points/scroll",
            encode_path_segment(collection)
        );
        let envelope: Envelope<ScrollResult> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "limit": limit,
                    "with_payload": true,
                    "with_vector": false
                })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        Ok(envelope
            .result
            .points
            .into_iter()
            .map(|point| PayloadSample {
                point_id: point.id,
                payload: point.payload,
            })
            .collect())
    }

    /// Idempotently upsert one manifest plus its chunk points.  The caller owns
    /// staged-revision orchestration; deterministic ids make a retry safe.
    pub async fn upsert_document(
        &self,
        collection: &str,
        profile: &super::embedding::EmbeddingProfile,
        manifest: &DocumentManifest,
        chunks: &[DocumentChunk],
    ) -> Result<Vec<OperationReceipt>, QdrantError> {
        validate_collection_name(collection)?;
        validate_document_batch(manifest, chunks)?;
        let mut points = Vec::with_capacity(chunks.len() + 1);
        points.push(manifest_point(manifest).map_err(QdrantError::InvalidInput)?);
        for chunk in chunks {
            points.push(chunk_point(chunk, profile).map_err(QdrantError::InvalidInput)?);
        }

        let mut receipts = Vec::new();
        for batch in points.chunks(MAX_UPSERT_POINTS) {
            let path = format!(
                "/collections/{}/points?wait=true",
                encode_path_segment(collection)
            );
            let envelope: Envelope<Value> = self
                .send(Method::PUT, &path, Some(json!({ "points": batch })))
                .await?;
            ensure_ok(&envelope.status)?;
            receipts.push(parse_operation_receipt(envelope.result)?);
        }
        Ok(receipts)
    }

    pub async fn update_document_metadata(
        &self,
        collection: &str,
        document_id: &str,
        update: &DocumentMetadataUpdate,
    ) -> Result<OperationReceipt, QdrantError> {
        validate_collection_name(collection)?;
        if document_id.trim().is_empty() {
            return Err(QdrantError::InvalidInput("document id is required".into()));
        }
        chrono::DateTime::parse_from_rfc3339(&update.updated_at).map_err(|_| {
            QdrantError::InvalidInput("updated_at must be an RFC 3339 timestamp".into())
        })?;
        let path = format!(
            "/collections/{}/points/payload?wait=true",
            encode_path_segment(collection)
        );
        let envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "filter": document_filter(document_id),
                    "payload": document_metadata_payload(update)
                })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        parse_operation_receipt(envelope.result)
    }

    pub async fn set_document_revision_state(
        &self,
        collection: &str,
        document_id: &str,
        revision: u64,
        state: super::types::DocumentState,
        updated_at: &str,
    ) -> Result<OperationReceipt, QdrantError> {
        validate_collection_name(collection)?;
        chrono::DateTime::parse_from_rfc3339(updated_at).map_err(|_| {
            QdrantError::InvalidInput("updated_at must be an RFC 3339 timestamp".into())
        })?;
        let path = format!(
            "/collections/{}/points/payload?wait=true",
            encode_path_segment(collection)
        );
        let state_envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "filter": revision_filter(document_id, revision),
                    // `key` applies this patch inside the existing identity
                    // object. Sending `{ "_vterminal": { "state": ... } }`
                    // at the root would replace that object and erase the
                    // document id/revision fields used by every later filter.
                    "payload": { "state": state.as_str() },
                    "key": "_vterminal"
                })),
            )
            .await?;
        ensure_ok(&state_envelope.status)?;
        parse_operation_receipt(state_envelope.result)?;

        // A second idempotent patch keeps the presentation timestamp at the
        // payload root. Qdrant's `key` can target one JSON path per operation.
        let timestamp_envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "filter": revision_filter(document_id, revision),
                    "payload": { "updated_at": updated_at }
                })),
            )
            .await?;
        ensure_ok(&timestamp_envelope.status)?;
        parse_operation_receipt(timestamp_envelope.result)
    }

    /// Hide every superseded revision immediately after the new revision is
    /// activated. A later delete may fail transiently, but inactive leftovers
    /// cannot produce duplicate search hits or document manifests.
    pub async fn deactivate_other_document_revisions(
        &self,
        collection: &str,
        document_id: &str,
        keep_revision: u64,
        updated_at: &str,
    ) -> Result<(), QdrantError> {
        validate_collection_name(collection)?;
        chrono::DateTime::parse_from_rfc3339(updated_at).map_err(|_| {
            QdrantError::InvalidInput("updated_at must be an RFC 3339 timestamp".into())
        })?;
        let path = format!(
            "/collections/{}/points/payload?wait=true",
            encode_path_segment(collection)
        );
        let filter = other_revisions_filter(document_id, keep_revision);
        let state_envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "filter": filter,
                    "payload": { "state": super::types::DocumentState::Staging.as_str() },
                    "key": "_vterminal"
                })),
            )
            .await?;
        ensure_ok(&state_envelope.status)?;
        parse_operation_receipt(state_envelope.result)?;
        let timestamp_envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "filter": other_revisions_filter(document_id, keep_revision),
                    "payload": { "updated_at": updated_at }
                })),
            )
            .await?;
        ensure_ok(&timestamp_envelope.status)?;
        parse_operation_receipt(timestamp_envelope.result)?;
        Ok(())
    }

    pub async fn delete_document(
        &self,
        collection: &str,
        document_id: &str,
    ) -> Result<OperationReceipt, QdrantError> {
        validate_collection_name(collection)?;
        if document_id.trim().is_empty() {
            return Err(QdrantError::InvalidInput("document id is required".into()));
        }
        let path = format!(
            "/collections/{}/points/delete?wait=true",
            encode_path_segment(collection)
        );
        let envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({ "filter": document_filter(document_id) })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        parse_operation_receipt(envelope.result)
    }

    pub async fn delete_document_revision(
        &self,
        collection: &str,
        document_id: &str,
        revision: u64,
    ) -> Result<OperationReceipt, QdrantError> {
        validate_collection_name(collection)?;
        let path = format!(
            "/collections/{}/points/delete?wait=true",
            encode_path_segment(collection)
        );
        let envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({ "filter": revision_filter(document_id, revision) })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        parse_operation_receipt(envelope.result)
    }

    pub async fn delete_other_document_revisions(
        &self,
        collection: &str,
        document_id: &str,
        keep_revision: u64,
    ) -> Result<OperationReceipt, QdrantError> {
        validate_collection_name(collection)?;
        let path = format!(
            "/collections/{}/points/delete?wait=true",
            encode_path_segment(collection)
        );
        let envelope: Envelope<Value> = self
            .send(
                Method::POST,
                &path,
                Some(json!({
                    "filter": other_revisions_filter(document_id, keep_revision)
                })),
            )
            .await?;
        ensure_ok(&envelope.status)?;
        parse_operation_receipt(envelope.result)
    }

    pub async fn set_turbo_quant(
        &self,
        server_version: &Version,
        collection: &str,
        config: TurboQuantConfig,
    ) -> Result<(), QdrantError> {
        require_version(server_version, QDRANT_TURBO_QUANT_MIN_VERSION, "TurboQuant")?;
        validate_collection_name(collection)?;
        let path = format!("/collections/{}", encode_path_segment(collection));
        let envelope: Envelope<Value> = self
            .send(
                Method::PATCH,
                &path,
                Some(json!({
                    "quantization_config": {
                        "turbo": {
                            "bits": config.bits.as_str(),
                            "always_ram": config.always_ram
                        }
                    }
                })),
            )
            .await?;
        ensure_ok(&envelope.status)
    }

    pub async fn disable_quantization(&self, collection: &str) -> Result<(), QdrantError> {
        validate_collection_name(collection)?;
        let path = format!("/collections/{}", encode_path_segment(collection));
        let envelope: Envelope<Value> = self
            .send(
                Method::PATCH,
                &path,
                Some(json!({ "quantization_config": "Disabled" })),
            )
            .await?;
        ensure_ok(&envelope.status)
    }

    async fn send<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, QdrantError> {
        let url = self.endpoint.url(path);
        let mut request = self.client.request(method, &url);
        if let Some(api_key) = &self.api_key {
            request = request.header("api-key", api_key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| QdrantError::Transport {
                endpoint: self.endpoint.base_url.clone(),
                detail: short_transport_error(&error),
            })?;
        let status = response.status();
        let bytes = read_bounded(response, MAX_RESPONSE_BYTES).await?;
        if !status.is_success() {
            return Err(status_error(status, &bytes, self.api_key.is_some()));
        }
        serde_json::from_slice(&bytes).map_err(|error| {
            QdrantError::Protocol(format!(
                "HTTP {} body was not valid JSON ({error})",
                status.as_u16()
            ))
        })
    }
}

fn validate_collection_name(collection: &str) -> Result<(), QdrantError> {
    if collection.is_empty()
        || collection.len() > 255
        || collection.chars().any(|character| character.is_control())
    {
        return Err(QdrantError::InvalidInput(
            "collection name must contain 1–255 non-control characters".into(),
        ));
    }
    Ok(())
}

fn validate_vector(vector: &[f32]) -> Result<(), QdrantError> {
    if vector.is_empty() {
        return Err(QdrantError::InvalidInput("query vector is empty".into()));
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(QdrantError::InvalidInput(
            "query vector contains a non-finite value".into(),
        ));
    }
    if !vector.iter().any(|value| *value != 0.0) {
        return Err(QdrantError::InvalidInput("query vector is all zero".into()));
    }
    Ok(())
}

fn validate_document_batch(
    manifest: &DocumentManifest,
    chunks: &[DocumentChunk],
) -> Result<(), QdrantError> {
    if manifest.chunk_count as usize != chunks.len() {
        return Err(QdrantError::InvalidInput(format!(
            "manifest says {} chunks but {} were supplied",
            manifest.chunk_count,
            chunks.len()
        )));
    }
    for (expected_index, chunk) in chunks.iter().enumerate() {
        if chunk.document_id != manifest.document_id
            || chunk.revision != manifest.revision
            || chunk.state != manifest.state
            || chunk.content_sha256 != manifest.content_sha256
            || chunk.chunk_index as usize != expected_index
        {
            return Err(QdrantError::InvalidInput(format!(
                "chunk {expected_index} does not match the manifest identity/revision/order"
            )));
        }
    }
    Ok(())
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, QdrantError> {
    let mut output = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| QdrantError::Transport {
            endpoint: response.url().origin().ascii_serialization(),
            detail: short_transport_error(&error),
        })?
    {
        if output.len().saturating_add(chunk.len()) > limit {
            return Err(QdrantError::Protocol(format!(
                "response exceeded the {limit}-byte safety limit"
            )));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn short_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "request timed out".into()
    } else if error.is_connect() {
        "connection failed".into()
    } else if error.is_redirect() {
        "redirect refused".into()
    } else {
        "network request failed".into()
    }
}

fn status_error(status: StatusCode, bytes: &[u8], authenticated: bool) -> QdrantError {
    // A user-controlled endpoint can reflect the credential without labelling
    // it as a key. Never surface an authenticated response body over IPC/logs.
    let detail = if authenticated {
        String::new()
    } else {
        safe_error_detail(bytes)
    };
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    };
    match status {
        StatusCode::UNAUTHORIZED => QdrantError::Authentication {
            status: status.as_u16(),
            detail: suffix,
        },
        StatusCode::FORBIDDEN => QdrantError::Permission {
            status: status.as_u16(),
            detail: suffix,
        },
        StatusCode::NOT_FOUND => QdrantError::Http {
            status: status.as_u16(),
            detail: suffix,
        },
        _ => QdrantError::Http {
            status: status.as_u16(),
            detail: suffix,
        },
    }
}

fn safe_error_detail(bytes: &[u8]) -> String {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return String::new(),
    };
    let raw = value
        .pointer("/status/error")
        .and_then(Value::as_str)
        .or_else(|| value.get("status").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(300)
        .collect();
    // Never reflect likely key/token material from a remote server into UI/logs.
    let lowered = cleaned.to_ascii_lowercase();
    if ["api-key", "api key", "authorization", "bearer", "token"]
        .iter()
        .any(|needle| lowered.contains(needle))
    {
        "Qdrant rejected the request".into()
    } else {
        cleaned
    }
}

fn require_version(
    installed: &Version,
    minimum: &str,
    feature: &'static str,
) -> Result<(), QdrantError> {
    let required = Version::parse(minimum).expect("constant is valid semver");
    if installed < &required {
        return Err(QdrantError::UnsupportedVersion {
            feature,
            installed: installed.clone(),
            required,
        });
    }
    Ok(())
}

#[derive(Deserialize)]
struct RootResponse {
    title: String,
    version: String,
    #[serde(default)]
    commit: Option<String>,
}

fn server_info_from_root(root: RootResponse) -> Result<QdrantServerInfo, QdrantError> {
    let version = Version::parse(&root.version).map_err(|error| {
        QdrantError::Protocol(format!(
            "Qdrant reported invalid version {:?}: {error}",
            root.version
        ))
    })?;
    let managed = Version::parse(QDRANT_MANAGED_MIN_VERSION).expect("constant is semver");
    let turbo = Version::parse(QDRANT_TURBO_QUANT_MIN_VERSION).expect("constant is semver");
    Ok(QdrantServerInfo {
        title: root.title,
        version: root.version,
        commit: root.commit,
        capabilities: QdrantServerCapabilities {
            managed_collections: version >= managed,
            turbo_quant: version >= turbo,
        },
    })
}

#[derive(Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    status: Value,
    result: T,
}

fn ensure_ok(status: &Value) -> Result<(), QdrantError> {
    if status.is_null() || status == "ok" || status == "acknowledged" {
        return Ok(());
    }
    if let Some(error) = status.get("error").and_then(Value::as_str) {
        return Err(QdrantError::Protocol(format!(
            "Qdrant returned an error status: {}",
            error.chars().take(300).collect::<String>()
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
struct CollectionsResult {
    collections: Vec<CollectionName>,
}

#[derive(Deserialize)]
struct CollectionName {
    name: String,
}

#[derive(Deserialize)]
struct PointRecord {
    id: PointId,
    #[serde(default)]
    payload: Value,
}

#[derive(Deserialize)]
struct ScoredPoint {
    id: PointId,
    score: f64,
    #[serde(default)]
    payload: Value,
}

fn imported_payload_field<'a>(payload: &'a Value, field: &str) -> Option<&'a Value> {
    payload
        .as_object()
        .and_then(|object| object.get(field))
        .or_else(|| {
            let mut value = payload;
            for segment in field.split('.') {
                value = value.as_object()?.get(segment)?;
            }
            Some(value)
        })
}

fn imported_string(payload: &Value, field: Option<&str>) -> Option<String> {
    field
        .and_then(|field| imported_payload_field(payload, field))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn imported_document_id(payload: &Value, field: &str) -> Option<String> {
    let value = imported_payload_field(payload, field)?;
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|number| number.to_string()))
        .or_else(|| value.as_i64().map(|number| number.to_string()))
}

fn imported_page(payload: &Value, field: Option<&str>) -> Option<u32> {
    let value = field.and_then(|field| imported_payload_field(payload, field))?;
    value
        .as_u64()
        .and_then(|number| u32::try_from(number).ok())
        .or_else(|| value.as_str().and_then(|number| number.parse().ok()))
}

/// Missing mapped fields cause that point to be ignored: external collections may
/// contain vector-bearing records for several application roles. Incorrect values
/// cannot be promoted into citations, while healthy mapped points still contribute.
fn parse_imported_hit(
    connection_id: &str,
    collection: &str,
    binding: &ImportedCollectionBinding,
    point: ScoredPoint,
) -> Result<Option<KnowledgeHit>, QdrantError> {
    let Some(text) = imported_string(&point.payload, Some(&binding.text_field))
        .filter(|text| !text.trim().is_empty())
    else {
        return Ok(None);
    };
    let Some(document_id) = imported_document_id(&point.payload, &binding.document_id_field)
        .filter(|id| !id.trim().is_empty())
    else {
        return Ok(None);
    };
    let point_id = point.id.to_string();
    let title = imported_string(&point.payload, binding.title_field.as_deref())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| document_id.clone());
    Ok(Some(KnowledgeHit {
        bucket: KnowledgeBucketRef::Qdrant {
            connection_id: connection_id.into(),
            collection: collection.into(),
        },
        document_id,
        chunk_id: format!("qdrant:{connection_id}:{collection}:{point_id}"),
        title,
        source_uri: imported_string(&point.payload, binding.source_uri_field.as_deref())
            .unwrap_or_default(),
        mime_type: "text/plain".into(),
        page: imported_page(&point.payload, binding.page_field.as_deref()),
        heading: imported_string(&point.payload, binding.heading_field.as_deref()),
        // External collections do not carry VTerminal revision manifests. Binding
        // version one is a stable synthetic revision for citation identities.
        revision: 1,
        text,
        score: point.score,
    }))
}

#[derive(Deserialize)]
struct QueryResult {
    points: Vec<ScoredPoint>,
}

#[derive(Deserialize)]
struct ScrollResult {
    points: Vec<PointRecord>,
    #[serde(default)]
    next_page_offset: Option<PointId>,
}

fn parse_collection_info(name: &str, result: Value) -> Result<QdrantCollectionInfo, QdrantError> {
    let status = result
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let points_count = value_u64(result.get("points_count"));
    let indexed_vectors_count = value_u64(result.get("indexed_vectors_count"));
    let params = result
        .pointer("/config/params")
        .ok_or_else(|| QdrantError::Protocol("collection details omitted config.params".into()))?;
    let vectors = parse_vectors(params.get("vectors"))?;
    let payload_schema = result.get("payload_schema").and_then(Value::as_object);
    let payload_indexes = payload_indexes_from_schema(payload_schema);
    let payload_index_types = payload_schema
        .into_iter()
        .flat_map(|schema| schema.iter())
        .map(|(field, descriptor)| {
            let kind = descriptor
                .as_str()
                .or_else(|| {
                    descriptor
                        .get("data_type")
                        .or_else(|| descriptor.get("type"))
                        .and_then(Value::as_str)
                })
                .unwrap_or_default()
                .to_string();
            (field.clone(), kind)
        })
        .collect();
    let metadata = metadata_from_config(result.pointer("/config/metadata"));
    let quantization = parse_quantization(result.pointer("/config/quantization_config"));
    Ok(QdrantCollectionInfo {
        name: name.into(),
        status,
        points_count,
        indexed_vectors_count,
        vectors,
        payload_indexes,
        payload_index_types,
        metadata,
        quantization,
    })
}

fn value_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .and_then(Value::as_f64)
                .map(|number| number.max(0.0) as u64)
        })
        .unwrap_or(0)
}

fn parse_vectors(value: Option<&Value>) -> Result<Vec<VectorDescriptor>, QdrantError> {
    let Some(value) = value else {
        return Err(QdrantError::Protocol(
            "collection details omitted vector configuration".into(),
        ));
    };
    if let Some(config) = value.as_object().filter(|map| map.contains_key("size")) {
        return Ok(vec![parse_vector("", config)?]);
    }
    let map = value.as_object().ok_or_else(|| {
        QdrantError::Protocol("collection vector configuration is not an object".into())
    })?;
    map.iter()
        .map(|(name, value)| {
            let config = value.as_object().ok_or_else(|| {
                QdrantError::Protocol(format!("vector {name:?} configuration is not an object"))
            })?;
            parse_vector(name, config)
        })
        .collect()
}

fn parse_vector(name: &str, config: &Map<String, Value>) -> Result<VectorDescriptor, QdrantError> {
    let size = config
        .get("size")
        .and_then(Value::as_u64)
        .and_then(|size| u32::try_from(size).ok())
        .ok_or_else(|| QdrantError::Protocol(format!("vector {name:?} has no valid size")))?;
    let distance = config
        .get("distance")
        .and_then(Value::as_str)
        .ok_or_else(|| QdrantError::Protocol(format!("vector {name:?} has no distance")))?
        .to_string();
    let data_type = config
        .get("datatype")
        .or_else(|| config.get("data_type"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(VectorDescriptor {
        name: name.into(),
        size,
        distance,
        data_type,
    })
}

fn parse_quantization(value: Option<&Value>) -> QuantizationStatus {
    let Some(value) = value else {
        return QuantizationStatus::Off;
    };
    if value.is_null() || value == "Disabled" || value == "disabled" {
        return QuantizationStatus::Off;
    }
    if let Some(turbo) = value.get("turbo") {
        let bits = match turbo.get("bits").and_then(Value::as_str).unwrap_or("bits4") {
            "bits2" => TurboQuantBits::Bits2,
            "bits1_5" => TurboQuantBits::Bits1_5,
            "bits1" => TurboQuantBits::Bits1,
            _ => TurboQuantBits::Bits4,
        };
        return QuantizationStatus::Turbo {
            bits,
            always_ram: turbo
                .get("always_ram")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
    }
    let kind = value
        .as_object()
        .and_then(|map| map.keys().next())
        .cloned()
        .unwrap_or_else(|| "unknown".into());
    QuantizationStatus::Other { kind }
}

fn parse_operation_receipt(value: Value) -> Result<OperationReceipt, QdrantError> {
    if let Some(boolean) = value.as_bool() {
        return Ok(OperationReceipt {
            status: if boolean { "completed" } else { "failed" }.into(),
            operation_id: None,
        });
    }
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("acknowledged")
        .to_string();
    let operation_id = value.get("operation_id").and_then(Value::as_u64);
    Ok(OperationReceipt {
        status,
        operation_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_blocks_keyed_cleartext_except_loopback() {
        assert!(QdrantEndpoint::parse("http://localhost:6333", true, false).is_ok());
        assert!(QdrantEndpoint::parse("http://127.0.0.1:6333", true, false).is_ok());
        assert!(matches!(
            QdrantEndpoint::parse("http://qdrant.internal:6333", true, false),
            Err(QdrantError::InsecureTransport(_))
        ));
        assert!(QdrantEndpoint::parse("http://qdrant.internal:6333", true, true).is_ok());
        assert!(QdrantEndpoint::parse("https://example.cloud.qdrant.io", true, false).is_ok());
    }

    #[test]
    fn endpoint_refuses_embedded_credentials_and_non_http_schemes() {
        assert!(QdrantEndpoint::parse("https://key@example.com", false, false).is_err());
        assert!(QdrantEndpoint::parse("file:///tmp/qdrant", false, false).is_err());
        assert!(QdrantEndpoint::parse("example.com:6333", false, false).is_err());
    }

    #[test]
    fn debug_never_contains_api_key() {
        let endpoint = QdrantEndpoint::parse("https://qdrant.example", true, false).unwrap();
        let client = QdrantClient::new(endpoint, Some("super-secret-key".into())).unwrap();
        let debug = format!("{client:?}");
        assert!(!debug.contains("super-secret-key"));
        assert!(debug.contains("has_api_key: true"));
    }

    #[test]
    fn root_versions_gate_managed_metadata_and_turbo_quant() {
        let managed = server_info_from_root(RootResponse {
            title: "qdrant".into(),
            version: "1.16.4".into(),
            commit: None,
        })
        .unwrap();
        assert!(managed.capabilities.managed_collections);
        assert!(!managed.capabilities.turbo_quant);

        let turbo = server_info_from_root(RootResponse {
            title: "qdrant".into(),
            version: "1.18.0".into(),
            commit: Some("abc".into()),
        })
        .unwrap();
        assert!(turbo.capabilities.turbo_quant);
    }

    #[test]
    fn parses_named_vectors_metadata_indexes_and_turbo_quant() {
        let result = json!({
            "status": "green",
            "points_count": 12,
            "indexed_vectors_count": 11,
            "config": {
                "params": {
                    "vectors": {
                        "content": {
                            "size": 768,
                            "distance": "Cosine",
                            "datatype": "float32"
                        }
                    }
                },
                "metadata": {},
                "quantization_config": {
                    "turbo": { "bits": "bits2", "always_ram": true }
                }
            },
            "payload_schema": {
                "_vterminal.type": { "data_type": "keyword" },
                "_vterminal.document_id": { "data_type": "keyword" },
                "_vterminal.source_id": "keyword",
                "_vterminal.revision": { "type": "integer" },
                "_vterminal.state": {}
            }
        });
        let info = parse_collection_info("manuals", result).unwrap();
        assert_eq!(info.vectors[0].name, "content");
        assert_eq!(info.vectors[0].size, 768);
        assert!(info.payload_indexes.contains("_vterminal.type"));
        assert_eq!(info.payload_index_types["_vterminal.type"], "keyword");
        assert_eq!(info.payload_index_types["_vterminal.source_id"], "keyword");
        assert_eq!(info.payload_index_types["_vterminal.revision"], "integer");
        assert_eq!(info.payload_index_types["_vterminal.state"], "");
        assert_eq!(
            info.quantization,
            QuantizationStatus::Turbo {
                bits: TurboQuantBits::Bits2,
                always_ram: true
            }
        );
    }

    #[test]
    fn parses_legacy_unnamed_vector_without_claiming_compatibility() {
        let result = json!({
            "status": "green",
            "points_count": 1,
            "config": {
                "params": {
                    "vectors": { "size": 384, "distance": "Dot" }
                },
                "quantization_config": null
            },
            "payload_schema": {}
        });
        let info = parse_collection_info("legacy", result).unwrap();
        assert_eq!(info.vectors[0].name, "");
        assert_eq!(info.vectors[0].distance, "Dot");
        assert!(info.metadata.is_none());
        assert_eq!(info.quantization, QuantizationStatus::Off);
    }

    #[test]
    fn imported_hits_use_only_explicit_nested_payload_mappings() {
        let binding = ImportedCollectionBinding {
            connection_id: "c".into(),
            collection: "legacy".into(),
            vector_name: "".into(),
            embedding_profile_fingerprint: "fingerprint".into(),
            text_field: "content.text".into(),
            document_id_field: "document.id".into(),
            title_field: Some("document.title".into()),
            source_uri_field: Some("uri".into()),
            page_field: Some("page".into()),
            heading_field: None,
            model_attested: true,
        };
        let hit = parse_imported_hit(
            "c",
            "legacy",
            &binding,
            ScoredPoint {
                id: PointId::Number(7),
                score: 0.75,
                payload: json!({
                    "content": {"text": "mapped passage"},
                    "document": {"id": 42, "title": "Mapped title"},
                    "uri": "https://example.test/doc",
                    "page": "3",
                    "ignored": "not used"
                }),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(hit.document_id, "42");
        assert_eq!(hit.title, "Mapped title");
        assert_eq!(hit.text, "mapped passage");
        assert_eq!(hit.page, Some(3));
        assert_eq!(hit.chunk_id, "qdrant:c:legacy:7");
    }

    #[test]
    fn server_error_details_are_bounded_and_secret_redacted() {
        assert_eq!(
            safe_error_detail(br#"{"status":{"error":"invalid api-key secret-value"}}"#),
            "Qdrant rejected the request"
        );
        assert_eq!(
            safe_error_detail(br#"{"status":{"error":"collection missing"}}"#),
            "collection missing"
        );
        assert_eq!(safe_error_detail(b"plain proxy response"), "");
    }

    #[test]
    fn path_segments_encode_collection_names() {
        assert_eq!(encode_path_segment("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn document_batch_rejects_identity_and_order_drift() {
        let manifest = DocumentManifest {
            document_id: "doc".into(),
            source_id: None,
            revision: 1,
            state: super::super::types::DocumentState::Staging,
            content_sha256: "a".repeat(64),
            title: "Doc".into(),
            source_uri: "file:///doc".into(),
            mime_type: "text/plain".into(),
            chunk_count: 1,
            created_at: "2026-08-13T00:00:00Z".into(),
            updated_at: "2026-08-13T00:00:00Z".into(),
        };
        let chunk = DocumentChunk {
            document_id: "other".into(),
            source_id: None,
            revision: 1,
            state: manifest.state,
            content_sha256: manifest.content_sha256.clone(),
            chunk_index: 0,
            text: "hello".into(),
            title: "Doc".into(),
            source_uri: "file:///doc".into(),
            mime_type: "text/plain".into(),
            page: None,
            heading: None,
            created_at: manifest.created_at.clone(),
            updated_at: manifest.updated_at.clone(),
            vector: vec![1.0],
        };
        assert!(validate_document_batch(&manifest, &[chunk]).is_err());
    }
}
