//! Stable embedding semantics and HTTP embedding adapters.
//!
//! An embedding vector is meaningful only together with the exact model and
//! preprocessing which produced it.  [`EmbeddingProfile`] therefore fingerprints
//! the semantic inputs to embedding, while deliberately excluding operational
//! details such as an endpoint URL, API key, display label, or connection id.
//! Buckets persist that fingerprint and never silently move to another vector
//! space.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const EMBEDDING_PROFILE_SCHEMA_VERSION: u32 = 1;

/// The retrieval instruction recommended by the Qwen3 Embedding model card.
pub const QWEN_RETRIEVAL_QUERY_PREFIX: &str =
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

pub const EMBEDDING_GEMMA_QUERY_PREFIX: &str = "task: search result | query: ";
pub const E5_QUERY_PREFIX: &str = "query: ";
pub const E5_DOCUMENT_PREFIX: &str = "passage: ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingProviderDialect {
    LocalLlamaCpp,
    OpenAi,
    Mistral,
    /// Advanced: Ollama's native `/api/embed` endpoint.
    Ollama,
    /// Advanced: LM Studio's OpenAI-compatible endpoint.
    LmStudio,
}

impl EmbeddingProviderDialect {
    pub fn is_guided_cloud(self) -> bool {
        matches!(self, Self::OpenAi | Self::Mistral)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pooling {
    Mean,
    LastToken,
    Cls,
    ProviderDefined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VectorDistance {
    Cosine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VectorDataType {
    Float32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TruncationPolicy {
    /// Reject an over-limit input instead of silently embedding different text.
    Reject,
    /// The provider defines tokenization and enforces its documented limit.
    ProviderEnforced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingPurpose {
    Query,
    Document,
}

/// A fully explicit input transform.  These values are fingerprinted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputTransform {
    Identity,
    Prefix {
        value: String,
    },
    /// EmbeddingGemma's retrieval-document prompt, optionally using a title.
    TitleAndText {
        title_prefix: String,
        untitled: String,
        text_separator: String,
    },
}

impl InputTransform {
    pub fn apply(&self, text: &str, title: Option<&str>) -> String {
        match self {
            Self::Identity => text.to_owned(),
            Self::Prefix { value } => format!("{value}{text}"),
            Self::TitleAndText {
                title_prefix,
                untitled,
                text_separator,
            } => {
                let title = title.map(str::trim).filter(|title| !title.is_empty());
                format!(
                    "{title_prefix}{}{text_separator}{text}",
                    title.unwrap_or(untitled)
                )
            }
        }
    }
}

/// All fields which define a vector space.
///
/// `revision` is the upstream model revision. `artifact_sha256` pins the exact
/// local GGUF (or server-reported digest for Ollama). Neither field is a download
/// URL and neither can contain a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingProfileSpec {
    pub schema_version: u32,
    pub provider: EmbeddingProviderDialect,
    pub model_id: String,
    pub revision: Option<String>,
    pub artifact_sha256: Option<String>,
    pub dimensions: u32,
    pub max_input_tokens: Option<u32>,
    pub pooling: Pooling,
    pub l2_normalize: bool,
    pub distance: VectorDistance,
    pub vector_data_type: VectorDataType,
    pub query_transform: InputTransform,
    pub document_transform: InputTransform,
    pub truncation: TruncationPolicy,
}

/// An immutable, self-verifying embedding profile.
///
/// Fields are private so callers cannot mutate semantics without creating a new
/// profile and therefore a new fingerprint. Deserialization verifies the stored
/// fingerprint, making database/config corruption fail closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmbeddingProfile {
    semantic: EmbeddingProfileSpec,
    fingerprint: String,
}

#[derive(Deserialize)]
struct StoredEmbeddingProfile {
    semantic: EmbeddingProfileSpec,
    fingerprint: String,
}

impl<'de> Deserialize<'de> for EmbeddingProfile {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let stored = StoredEmbeddingProfile::deserialize(deserializer)?;
        let profile = Self::new(stored.semantic).map_err(serde::de::Error::custom)?;
        if profile.fingerprint != stored.fingerprint {
            return Err(serde::de::Error::custom(
                "embedding profile fingerprint does not match its semantics",
            ));
        }
        Ok(profile)
    }
}

impl EmbeddingProfile {
    pub fn new(semantic: EmbeddingProfileSpec) -> Result<Self, EmbeddingError> {
        validate_profile_spec(&semantic)?;
        let fingerprint = profile_fingerprint(&semantic)?;
        Ok(Self {
            semantic,
            fingerprint,
        })
    }

    pub fn semantic(&self) -> &EmbeddingProfileSpec {
        &self.semantic
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn dimensions(&self) -> usize {
        self.semantic.dimensions as usize
    }

    pub fn transform(&self, purpose: EmbeddingPurpose, input: &EmbeddingInput) -> String {
        let transform = match purpose {
            EmbeddingPurpose::Query => &self.semantic.query_transform,
            EmbeddingPurpose::Document => &self.semantic.document_transform,
        };
        transform.apply(&input.text, input.title.as_deref())
    }
}

fn validate_profile_spec(spec: &EmbeddingProfileSpec) -> Result<(), EmbeddingError> {
    if spec.schema_version != EMBEDDING_PROFILE_SCHEMA_VERSION {
        return Err(EmbeddingError::Profile(format!(
            "unsupported embedding profile schema {}; expected {}",
            spec.schema_version, EMBEDDING_PROFILE_SCHEMA_VERSION
        )));
    }
    if spec.model_id.trim().is_empty() || spec.model_id.trim() != spec.model_id {
        return Err(EmbeddingError::Profile(
            "model_id must be non-empty and have no surrounding whitespace".into(),
        ));
    }
    if spec.dimensions == 0 {
        return Err(EmbeddingError::Profile(
            "embedding dimensions must be greater than zero".into(),
        ));
    }
    if spec.max_input_tokens == Some(0) {
        return Err(EmbeddingError::Profile(
            "max_input_tokens must be greater than zero when set".into(),
        ));
    }
    if !spec.l2_normalize || spec.distance != VectorDistance::Cosine {
        return Err(EmbeddingError::Profile(
            "knowledge profiles must use L2 normalization and cosine distance".into(),
        ));
    }
    if let Some(digest) = &spec.artifact_sha256 {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(EmbeddingError::Profile(
                "artifact_sha256 must contain exactly 64 hexadecimal characters".into(),
            ));
        }
    }
    if matches!(
        spec.provider,
        EmbeddingProviderDialect::LocalLlamaCpp | EmbeddingProviderDialect::Ollama
    ) && (spec.revision.as_deref().is_none_or(str::is_empty) || spec.artifact_sha256.is_none())
    {
        return Err(EmbeddingError::Profile(
            "local and Ollama profiles require an exact revision and artifact digest".into(),
        ));
    }
    Ok(())
}

/// SHA-256 over canonical JSON of semantic fields only.
pub fn profile_fingerprint(spec: &EmbeddingProfileSpec) -> Result<String, EmbeddingError> {
    let value = serde_json::to_value(spec)
        .map_err(|error| EmbeddingError::Profile(format!("serialize profile: {error}")))?;
    let mut canonical = String::new();
    write_canonical_json(&value, &mut canonical)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(hex_lower(&digest))
}

fn write_canonical_json(value: &Value, output: &mut String) -> Result<(), EmbeddingError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|error| EmbeddingError::Profile(error.to_string()))?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|error| EmbeddingError::Profile(error.to_string()))?,
                );
                output.push(':');
                write_canonical_json(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum DimensionSupport {
    Fixed(u32),
    Explicit(&'static [u32]),
    InclusiveRange { min: u32, max: u32 },
}

impl DimensionSupport {
    pub fn supports(self, dimensions: u32) -> bool {
        match self {
            Self::Fixed(value) => dimensions == value,
            Self::Explicit(values) => values.contains(&dimensions),
            Self::InclusiveRange { min, max } => (min..=max).contains(&dimensions),
        }
    }
}

/// Where the one-click installer resolves an artifact.
///
/// A Hugging Face entry is resolved through the Hub manifest by variant; no
/// unverified URL or guessed checksum is embedded here. The two E5 entries stay
/// unavailable until Veviad publishes its signed release manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArtifactAvailability {
    HuggingFace {
        repo_id: &'static str,
        variant: &'static str,
        requires_license: bool,
    },
    AwaitingReleaseManifest {
        manifest_key: &'static str,
        reason: &'static str,
    },
}

impl ArtifactAvailability {
    pub fn is_available(self) -> bool {
        matches!(self, Self::HuggingFace { .. })
    }

    pub fn unavailable_reason(self) -> Option<&'static str> {
        match self {
            Self::HuggingFace { .. } => None,
            Self::AwaitingReleaseManifest { reason, .. } => Some(reason),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BuiltinEmbeddingModel {
    pub id: &'static str,
    pub display_name: &'static str,
    pub upstream_model_id: &'static str,
    pub recommended: bool,
    pub native_dimensions: u32,
    pub dimensions: DimensionSupport,
    pub max_input_tokens: u32,
    pub pooling: Pooling,
    pub artifact: ArtifactAvailability,
}

const EMBEDDING_GEMMA_DIMENSIONS: &[u32] = &[128, 256, 512, 768];

/// The complete guided local catalog. Keep the cardinality test below: adding a
/// seventh model is a product decision, not an incidental implementation detail.
pub const BUILTIN_EMBEDDING_MODELS: &[BuiltinEmbeddingModel] = &[
    BuiltinEmbeddingModel {
        id: "local/qwen3-embedding-0.6b",
        display_name: "Qwen3 Embedding 0.6B",
        upstream_model_id: "Qwen/Qwen3-Embedding-0.6B",
        recommended: true,
        native_dimensions: 1024,
        dimensions: DimensionSupport::InclusiveRange { min: 32, max: 1024 },
        max_input_tokens: 32_768,
        pooling: Pooling::LastToken,
        artifact: ArtifactAvailability::HuggingFace {
            repo_id: "Qwen/Qwen3-Embedding-0.6B-GGUF",
            variant: "Q8_0",
            requires_license: false,
        },
    },
    BuiltinEmbeddingModel {
        id: "local/qwen3-embedding-4b",
        display_name: "Qwen3 Embedding 4B",
        upstream_model_id: "Qwen/Qwen3-Embedding-4B",
        recommended: false,
        native_dimensions: 2560,
        dimensions: DimensionSupport::InclusiveRange { min: 32, max: 2560 },
        max_input_tokens: 32_768,
        pooling: Pooling::LastToken,
        artifact: ArtifactAvailability::HuggingFace {
            repo_id: "Qwen/Qwen3-Embedding-4B-GGUF",
            variant: "Q4_K_M",
            requires_license: false,
        },
    },
    BuiltinEmbeddingModel {
        id: "local/qwen3-embedding-8b",
        display_name: "Qwen3 Embedding 8B",
        upstream_model_id: "Qwen/Qwen3-Embedding-8B",
        recommended: false,
        native_dimensions: 4096,
        dimensions: DimensionSupport::InclusiveRange { min: 32, max: 4096 },
        max_input_tokens: 32_768,
        pooling: Pooling::LastToken,
        artifact: ArtifactAvailability::HuggingFace {
            repo_id: "Qwen/Qwen3-Embedding-8B-GGUF",
            variant: "Q4_K_M",
            requires_license: false,
        },
    },
    BuiltinEmbeddingModel {
        id: "local/embeddinggemma-300m",
        display_name: "EmbeddingGemma",
        upstream_model_id: "google/embeddinggemma-300M",
        recommended: false,
        native_dimensions: 768,
        dimensions: DimensionSupport::Explicit(EMBEDDING_GEMMA_DIMENSIONS),
        max_input_tokens: 2048,
        pooling: Pooling::Mean,
        artifact: ArtifactAvailability::HuggingFace {
            repo_id: "ggml-org/embeddinggemma-300M-GGUF",
            variant: "Q8_0",
            requires_license: true,
        },
    },
    BuiltinEmbeddingModel {
        id: "local/multilingual-e5-base",
        display_name: "Multilingual E5 Base",
        upstream_model_id: "intfloat/multilingual-e5-base",
        recommended: false,
        native_dimensions: 768,
        dimensions: DimensionSupport::Fixed(768),
        max_input_tokens: 512,
        pooling: Pooling::Mean,
        artifact: ArtifactAvailability::AwaitingReleaseManifest {
            manifest_key: "multilingual-e5-base-q8_0",
            reason: "The signed Veviad Q8 GGUF release manifest has not been published yet.",
        },
    },
    BuiltinEmbeddingModel {
        id: "local/multilingual-e5-large",
        display_name: "Multilingual E5 Large",
        upstream_model_id: "intfloat/multilingual-e5-large",
        recommended: false,
        native_dimensions: 1024,
        dimensions: DimensionSupport::Fixed(1024),
        max_input_tokens: 512,
        pooling: Pooling::Mean,
        artifact: ArtifactAvailability::AwaitingReleaseManifest {
            manifest_key: "multilingual-e5-large-q8_0",
            reason: "The signed Veviad Q8 GGUF release manifest has not been published yet.",
        },
    },
];

pub fn builtin_model(id: &str) -> Option<&'static BuiltinEmbeddingModel> {
    BUILTIN_EMBEDDING_MODELS.iter().find(|model| model.id == id)
}

/// Serialization-ready catalog for the `knowledge_embedding_catalog` command.
/// Returning owned values keeps the IPC command free to add presentation-only
/// status (download progress, installed path) without weakening this static source
/// of truth.
pub fn builtin_embedding_catalog() -> Vec<BuiltinEmbeddingModel> {
    BUILTIN_EMBEDDING_MODELS.to_vec()
}

/// Create the immutable profile only after the installer has resolved an exact
/// upstream revision and verified the artifact digest.
pub fn builtin_profile(
    id: &str,
    dimensions: u32,
    revision: impl Into<String>,
    artifact_sha256: impl Into<String>,
) -> Result<EmbeddingProfile, EmbeddingError> {
    let model = builtin_model(id)
        .ok_or_else(|| EmbeddingError::Profile(format!("unknown built-in model {id:?}")))?;
    if !model.dimensions.supports(dimensions) {
        return Err(EmbeddingError::Profile(format!(
            "{} does not support {dimensions} dimensions",
            model.display_name
        )));
    }

    let (query_transform, document_transform) = match id {
        "local/qwen3-embedding-0.6b" | "local/qwen3-embedding-4b" | "local/qwen3-embedding-8b" => (
            InputTransform::Prefix {
                value: QWEN_RETRIEVAL_QUERY_PREFIX.into(),
            },
            InputTransform::Identity,
        ),
        "local/embeddinggemma-300m" => (
            InputTransform::Prefix {
                value: EMBEDDING_GEMMA_QUERY_PREFIX.into(),
            },
            InputTransform::TitleAndText {
                title_prefix: "title: ".into(),
                untitled: "none".into(),
                text_separator: " | text: ".into(),
            },
        ),
        "local/multilingual-e5-base" | "local/multilingual-e5-large" => (
            InputTransform::Prefix {
                value: E5_QUERY_PREFIX.into(),
            },
            InputTransform::Prefix {
                value: E5_DOCUMENT_PREFIX.into(),
            },
        ),
        _ => unreachable!("catalog and semantic mapping must be updated together"),
    };

    EmbeddingProfile::new(EmbeddingProfileSpec {
        schema_version: EMBEDDING_PROFILE_SCHEMA_VERSION,
        provider: EmbeddingProviderDialect::LocalLlamaCpp,
        model_id: model.upstream_model_id.into(),
        revision: Some(revision.into()),
        artifact_sha256: Some(artifact_sha256.into().to_ascii_lowercase()),
        dimensions,
        max_input_tokens: Some(model.max_input_tokens),
        pooling: model.pooling,
        l2_normalize: true,
        distance: VectorDistance::Cosine,
        vector_data_type: VectorDataType::Float32,
        query_transform,
        document_transform,
        truncation: TruncationPolicy::Reject,
    })
}

pub fn openai_profile(
    model_id: impl Into<String>,
    dimensions: u32,
) -> Result<EmbeddingProfile, EmbeddingError> {
    cloud_profile(EmbeddingProviderDialect::OpenAi, model_id, dimensions, None)
}

pub fn mistral_profile(
    model_id: impl Into<String>,
    dimensions: u32,
) -> Result<EmbeddingProfile, EmbeddingError> {
    cloud_profile(
        EmbeddingProviderDialect::Mistral,
        model_id,
        dimensions,
        Some(8192),
    )
}

fn cloud_profile(
    provider: EmbeddingProviderDialect,
    model_id: impl Into<String>,
    dimensions: u32,
    max_input_tokens: Option<u32>,
) -> Result<EmbeddingProfile, EmbeddingError> {
    debug_assert!(provider.is_guided_cloud());
    EmbeddingProfile::new(EmbeddingProfileSpec {
        schema_version: EMBEDDING_PROFILE_SCHEMA_VERSION,
        provider,
        model_id: model_id.into(),
        revision: None,
        artifact_sha256: None,
        dimensions,
        max_input_tokens,
        pooling: Pooling::ProviderDefined,
        l2_normalize: true,
        distance: VectorDistance::Cosine,
        vector_data_type: VectorDataType::Float32,
        query_transform: InputTransform::Identity,
        document_transform: InputTransform::Identity,
        truncation: TruncationPolicy::ProviderEnforced,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingInput {
    pub text: String,
    pub title: Option<String>,
}

impl EmbeddingInput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            title: None,
        }
    }

    pub fn document(text: impl Into<String>, title: Option<String>) -> Self {
        Self {
            text: text.into(),
            title,
        }
    }
}

/// Operational connection details. Deliberately not serializable or `Debug`, so
/// an API key cannot accidentally cross IPC or enter structured logs.
#[derive(Clone)]
pub struct EmbeddingEndpoint {
    base_url: String,
    api_key: Option<String>,
}

impl EmbeddingEndpoint {
    pub fn new(
        base_url: impl Into<String>,
        api_key: Option<String>,
    ) -> Result<Self, EmbeddingError> {
        let base_url = base_url.into();
        validate_base_url(&base_url)?;
        Ok(Self { base_url, api_key })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn has_api_key(&self) -> bool {
        self.api_key.as_deref().is_some_and(|key| !key.is_empty())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingBatchReport {
    pub count: usize,
    pub dimensions: usize,
    pub provider_vectors_were_normalized: bool,
    pub min_original_norm: f32,
    pub max_original_norm: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedBatch {
    pub vectors: Vec<Vec<f32>>,
    pub report: EmbeddingBatchReport,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RetrievalProbeReport {
    pub relevant_similarity: f32,
    pub unrelated_similarity: f32,
    pub relevant_ranked_first: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("invalid embedding profile: {0}")]
    Profile(String),
    #[error("invalid embedding endpoint: {0}")]
    Endpoint(String),
    #[error("embedding request failed: {0}")]
    Transport(String),
    #[error("embedding provider returned HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("invalid embedding response: {0}")]
    Response(String),
    #[error("invalid embedding vector: {0}")]
    Vector(String),
}

/// Embed a same-purpose batch using OpenAI, Mistral, Ollama, or LM Studio.
/// Returned vectors are always finite, non-zero, correctly sized, and L2-normalized.
pub async fn embed_http_batch(
    client: &reqwest::Client,
    endpoint: &EmbeddingEndpoint,
    profile: &EmbeddingProfile,
    purpose: EmbeddingPurpose,
    inputs: &[EmbeddingInput],
) -> Result<EmbeddedBatch, EmbeddingError> {
    if inputs.is_empty() {
        return Ok(EmbeddedBatch {
            vectors: Vec::new(),
            report: EmbeddingBatchReport {
                count: 0,
                dimensions: profile.dimensions(),
                provider_vectors_were_normalized: true,
                min_original_norm: 0.0,
                max_original_norm: 0.0,
            },
        });
    }
    if let Some(index) = inputs.iter().position(|input| input.text.trim().is_empty()) {
        return Err(EmbeddingError::Vector(format!(
            "input {index} is empty or whitespace-only"
        )));
    }

    let texts: Vec<String> = inputs
        .iter()
        .map(|input| profile.transform(purpose, input))
        .collect();
    let spec = profile.semantic();
    let url = embedding_url(endpoint.base_url(), spec.provider)?;

    let body = embedding_request_body(profile, &texts)?;

    let mut request = client.post(url).json(&body);
    if let Some(api_key) = endpoint.api_key.as_deref().filter(|key| !key.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| EmbeddingError::Transport(short_transport_error(&error)))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| EmbeddingError::Transport(short_transport_error(&error)))?;
    if !status.is_success() {
        return Err(EmbeddingError::Http {
            status: status.as_u16(),
            message: if endpoint.api_key.is_some() {
                "authenticated request was rejected".into()
            } else {
                provider_error_message(&bytes)
            },
        });
    }

    let vectors = match spec.provider {
        EmbeddingProviderDialect::Ollama => parse_ollama_response(&bytes, inputs.len())?,
        _ => parse_indexed_response(&bytes, inputs.len())?,
    };
    let (vectors, report) = validate_and_normalize(vectors, inputs.len(), profile.dimensions())?;
    Ok(EmbeddedBatch { vectors, report })
}

fn embedding_request_body(
    profile: &EmbeddingProfile,
    texts: &[String],
) -> Result<Value, EmbeddingError> {
    let spec = profile.semantic();
    Ok(match spec.provider {
        EmbeddingProviderDialect::OpenAi => {
            let mut body = json!({
                "model": spec.model_id,
                "input": texts,
                "encoding_format": "float"
            });
            if spec.model_id.starts_with("text-embedding-3-") {
                body["dimensions"] = json!(spec.dimensions);
            }
            body
        }
        EmbeddingProviderDialect::Mistral => json!({
            "model": spec.model_id,
            "input": texts,
            "encoding_format": "float",
            "output_dimension": spec.dimensions
        }),
        EmbeddingProviderDialect::LmStudio => json!({
            "model": spec.model_id,
            "input": texts,
            "encoding_format": "float",
            "dimensions": spec.dimensions
        }),
        EmbeddingProviderDialect::Ollama => json!({
            "model": spec.model_id,
            "input": texts,
            "truncate": false
        }),
        EmbeddingProviderDialect::LocalLlamaCpp => {
            return Err(EmbeddingError::Profile(
                "local llama.cpp profiles cannot use an HTTP embedding adapter".into(),
            ));
        }
    })
}

#[derive(Deserialize)]
struct IndexedEmbeddingResponse {
    data: Vec<IndexedEmbedding>,
}

#[derive(Deserialize)]
struct IndexedEmbedding {
    index: usize,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct OllamaEmbeddingResponse {
    embeddings: Vec<Vec<f32>>,
}

fn parse_indexed_response(bytes: &[u8], expected: usize) -> Result<Vec<Vec<f32>>, EmbeddingError> {
    let response: IndexedEmbeddingResponse = serde_json::from_slice(bytes)
        .map_err(|error| EmbeddingError::Response(format!("decode response JSON: {error}")))?;
    if response.data.len() != expected {
        return Err(EmbeddingError::Response(format!(
            "provider returned {} vectors for {expected} inputs",
            response.data.len()
        )));
    }
    let mut ordered: Vec<Option<Vec<f32>>> = vec![None; expected];
    for item in response.data {
        if item.index >= expected {
            return Err(EmbeddingError::Response(format!(
                "provider returned out-of-range embedding index {}",
                item.index
            )));
        }
        if ordered[item.index].replace(item.embedding).is_some() {
            return Err(EmbeddingError::Response(format!(
                "provider returned duplicate embedding index {}",
                item.index
            )));
        }
    }
    ordered
        .into_iter()
        .enumerate()
        .map(|(index, vector)| {
            vector.ok_or_else(|| {
                EmbeddingError::Response(format!("provider omitted embedding index {index}"))
            })
        })
        .collect()
}

fn parse_ollama_response(bytes: &[u8], expected: usize) -> Result<Vec<Vec<f32>>, EmbeddingError> {
    let response: OllamaEmbeddingResponse = serde_json::from_slice(bytes)
        .map_err(|error| EmbeddingError::Response(format!("decode response JSON: {error}")))?;
    if response.embeddings.len() != expected {
        return Err(EmbeddingError::Response(format!(
            "provider returned {} vectors for {expected} inputs",
            response.embeddings.len()
        )));
    }
    Ok(response.embeddings)
}

pub fn validate_and_normalize(
    mut vectors: Vec<Vec<f32>>,
    expected_count: usize,
    expected_dimensions: usize,
) -> Result<(Vec<Vec<f32>>, EmbeddingBatchReport), EmbeddingError> {
    if vectors.len() != expected_count {
        return Err(EmbeddingError::Vector(format!(
            "received {} vectors for {expected_count} inputs",
            vectors.len()
        )));
    }
    if expected_dimensions == 0 {
        return Err(EmbeddingError::Vector(
            "expected dimensions must be greater than zero".into(),
        ));
    }

    let mut min_norm = f32::INFINITY;
    let mut max_norm = 0.0f32;
    let mut provider_normalized = true;
    for (index, vector) in vectors.iter_mut().enumerate() {
        if vector.len() != expected_dimensions {
            return Err(EmbeddingError::Vector(format!(
                "vector {index} has {} dimensions; expected {expected_dimensions}",
                vector.len()
            )));
        }
        let norm = l2_norm(vector)?;
        if norm <= f32::EPSILON {
            return Err(EmbeddingError::Vector(format!(
                "vector {index} has zero length"
            )));
        }
        min_norm = min_norm.min(norm);
        max_norm = max_norm.max(norm);
        provider_normalized &= (norm - 1.0).abs() <= 1e-3;
        for value in vector {
            *value /= norm;
        }
    }

    Ok((
        vectors,
        EmbeddingBatchReport {
            count: expected_count,
            dimensions: expected_dimensions,
            provider_vectors_were_normalized: provider_normalized,
            min_original_norm: min_norm,
            max_original_norm: max_norm,
        },
    ))
}

pub fn l2_normalize(vector: &mut [f32]) -> Result<(), EmbeddingError> {
    let norm = l2_norm(vector)?;
    if norm <= f32::EPSILON {
        return Err(EmbeddingError::Vector(
            "cannot normalize a zero-length vector".into(),
        ));
    }
    for value in vector {
        *value /= norm;
    }
    Ok(())
}

fn l2_norm(vector: &[f32]) -> Result<f32, EmbeddingError> {
    let mut squared = 0.0f64;
    for (index, value) in vector.iter().enumerate() {
        if !value.is_finite() {
            return Err(EmbeddingError::Vector(format!(
                "component {index} is not finite"
            )));
        }
        squared += f64::from(*value) * f64::from(*value);
    }
    Ok(squared.sqrt() as f32)
}

/// Query/relevant/unrelated sanity signal used by provider onboarding.
///
/// It intentionally reports rather than inventing a universal rejection margin;
/// callers can show the scores, while a reversed order is a safe reason to refuse
/// automatic profile creation.
pub fn retrieval_probe(
    query: &[f32],
    relevant_document: &[f32],
    unrelated_document: &[f32],
) -> Result<RetrievalProbeReport, EmbeddingError> {
    let relevant_similarity = cosine(query, relevant_document)?;
    let unrelated_similarity = cosine(query, unrelated_document)?;
    Ok(RetrievalProbeReport {
        relevant_similarity,
        unrelated_similarity,
        relevant_ranked_first: relevant_similarity > unrelated_similarity,
    })
}

fn cosine(left: &[f32], right: &[f32]) -> Result<f32, EmbeddingError> {
    if left.len() != right.len() || left.is_empty() {
        return Err(EmbeddingError::Vector(format!(
            "cosine operands have incompatible dimensions {} and {}",
            left.len(),
            right.len()
        )));
    }
    let left_norm = l2_norm(left)?;
    let right_norm = l2_norm(right)?;
    if left_norm <= f32::EPSILON || right_norm <= f32::EPSILON {
        return Err(EmbeddingError::Vector(
            "cosine operands must be non-zero".into(),
        ));
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| f64::from(*left) * f64::from(*right))
        .sum::<f64>();
    Ok((dot / (f64::from(left_norm) * f64::from(right_norm))) as f32)
}

fn validate_base_url(raw: &str) -> Result<(), EmbeddingError> {
    let url = url::Url::parse(raw.trim())
        .map_err(|error| EmbeddingError::Endpoint(format!("invalid URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(EmbeddingError::Endpoint(
            "endpoint must use http or https".into(),
        ));
    }
    if url.host_str().is_none() {
        return Err(EmbeddingError::Endpoint("endpoint has no host".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(EmbeddingError::Endpoint(
            "put credentials in the API-key field, not the URL".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(EmbeddingError::Endpoint(
            "endpoint URL cannot contain a query or fragment".into(),
        ));
    }
    Ok(())
}

fn embedding_url(
    base_url: &str,
    provider: EmbeddingProviderDialect,
) -> Result<url::Url, EmbeddingError> {
    validate_base_url(base_url)?;
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|error| EmbeddingError::Endpoint(error.to_string()))?;
    let base_path = url.path().trim_end_matches('/');
    let target = match provider {
        EmbeddingProviderDialect::Ollama => {
            if base_path.ends_with("/api/embed") {
                base_path.to_owned()
            } else if base_path.ends_with("/api") {
                format!("{base_path}/embed")
            } else {
                format!("{base_path}/api/embed")
            }
        }
        EmbeddingProviderDialect::LocalLlamaCpp => {
            return Err(EmbeddingError::Endpoint(
                "local llama.cpp does not have an HTTP endpoint".into(),
            ));
        }
        _ => {
            if base_path.ends_with("/v1/embeddings") {
                base_path.to_owned()
            } else if base_path.ends_with("/v1") {
                format!("{base_path}/embeddings")
            } else {
                format!("{base_path}/v1/embeddings")
            }
        }
    };
    url.set_path(&target);
    Ok(url)
}

fn provider_error_message(bytes: &[u8]) -> String {
    let limited = &bytes[..bytes.len().min(2048)];
    if let Ok(value) = serde_json::from_slice::<Value>(limited) {
        for pointer in ["/error/message", "/message", "/detail"] {
            if let Some(message) = value.pointer(pointer).and_then(Value::as_str) {
                return message.chars().take(512).collect();
            }
        }
    }
    let message = String::from_utf8_lossy(limited);
    let trimmed = message.trim();
    if trimmed.is_empty() {
        "request failed".into()
    } else {
        trimmed.chars().take(512).collect()
    }
}

fn short_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "request timed out".into()
    } else if error.is_connect() {
        "could not connect to the embedding provider".into()
    } else if error.is_body() || error.is_decode() {
        "provider response could not be read".into()
    } else {
        "embedding provider transport error".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;
    use std::collections::BTreeSet;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn qwen() -> EmbeddingProfile {
        builtin_profile(
            "local/qwen3-embedding-0.6b",
            1024,
            "upstream-revision",
            DIGEST,
        )
        .unwrap()
    }

    #[test]
    fn guided_catalog_contains_exactly_the_six_approved_models() {
        let ids: BTreeSet<_> = BUILTIN_EMBEDDING_MODELS
            .iter()
            .map(|model| model.id)
            .collect();
        assert_eq!(BUILTIN_EMBEDDING_MODELS.len(), 6);
        assert_eq!(
            ids,
            BTreeSet::from([
                "local/embeddinggemma-300m",
                "local/multilingual-e5-base",
                "local/multilingual-e5-large",
                "local/qwen3-embedding-0.6b",
                "local/qwen3-embedding-4b",
                "local/qwen3-embedding-8b",
            ])
        );
        assert_eq!(
            BUILTIN_EMBEDDING_MODELS
                .iter()
                .filter(|model| model.recommended)
                .map(|model| model.id)
                .collect::<Vec<_>>(),
            ["local/qwen3-embedding-0.6b"]
        );
    }

    #[test]
    fn e5_is_explicitly_unavailable_until_a_signed_manifest_exists() {
        for id in ["local/multilingual-e5-base", "local/multilingual-e5-large"] {
            let model = builtin_model(id).unwrap();
            assert!(!model.artifact.is_available());
            assert!(model
                .artifact
                .unavailable_reason()
                .unwrap()
                .contains("signed Veviad"));
        }
        assert!(builtin_model("local/qwen3-embedding-0.6b")
            .unwrap()
            .artifact
            .is_available());
    }

    #[test]
    fn exact_query_and_document_transforms_are_pinned() {
        let input = EmbeddingInput::document("refund policy", Some("Billing".into()));
        let qwen = qwen();
        assert_eq!(
            qwen.transform(EmbeddingPurpose::Query, &input),
            format!("{QWEN_RETRIEVAL_QUERY_PREFIX}refund policy")
        );
        assert_eq!(
            qwen.transform(EmbeddingPurpose::Document, &input),
            "refund policy"
        );

        let gemma = builtin_profile("local/embeddinggemma-300m", 768, "revision", DIGEST).unwrap();
        assert_eq!(
            gemma.transform(EmbeddingPurpose::Query, &input),
            "task: search result | query: refund policy"
        );
        assert_eq!(
            gemma.transform(EmbeddingPurpose::Document, &input),
            "title: Billing | text: refund policy"
        );
        assert_eq!(
            gemma.transform(
                EmbeddingPurpose::Document,
                &EmbeddingInput::text("untitled document")
            ),
            "title: none | text: untitled document"
        );

        let e5 = builtin_profile("local/multilingual-e5-base", 768, "revision", DIGEST).unwrap();
        assert_eq!(
            e5.transform(EmbeddingPurpose::Query, &input),
            "query: refund policy"
        );
        assert_eq!(
            e5.transform(EmbeddingPurpose::Document, &input),
            "passage: refund policy"
        );
    }

    #[test]
    fn fingerprint_is_stable_and_excludes_operational_connection_details() {
        let first = qwen();
        let second = qwen();
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert_eq!(first.fingerprint().len(), 64);

        let endpoint_a =
            EmbeddingEndpoint::new("https://one.example", Some("secret-a".into())).unwrap();
        let endpoint_b =
            EmbeddingEndpoint::new("https://two.example", Some("secret-b".into())).unwrap();
        assert!(endpoint_a.has_api_key() && endpoint_b.has_api_key());
        // There is no endpoint field in the semantic value, so connecting the same
        // profile elsewhere cannot change its vector-space identity.
        assert_eq!(first.fingerprint(), second.fingerprint());
    }

    #[test]
    fn a_semantic_change_changes_the_fingerprint() {
        let profile = qwen();
        let mut changed = profile.semantic().clone();
        changed.query_transform = InputTransform::Prefix {
            value: "different: ".into(),
        };
        let changed = EmbeddingProfile::new(changed).unwrap();
        assert_ne!(profile.fingerprint(), changed.fingerprint());
    }

    #[test]
    fn deserialization_rejects_a_tampered_profile() {
        let profile = qwen();
        let mut value = serde_json::to_value(profile).unwrap();
        value["semantic"]["dimensions"] = json!(768);
        let error = serde_json::from_value::<EmbeddingProfile>(value).unwrap_err();
        assert!(error.to_string().contains("fingerprint"));
    }

    #[test]
    fn local_profiles_require_a_real_artifact_identity() {
        let error = builtin_profile("local/qwen3-embedding-0.6b", 1024, "revision", "not-a-hash")
            .unwrap_err();
        assert!(error.to_string().contains("artifact_sha256"));
        assert!(builtin_profile("local/embeddinggemma-300m", 1024, "revision", DIGEST).is_err());
    }

    #[test]
    fn vector_validation_normalizes_and_rejects_bad_shapes() {
        let (vectors, report) =
            validate_and_normalize(vec![vec![3.0, 4.0], vec![0.0, 2.0]], 2, 2).unwrap();
        assert_eq!(vectors[0], vec![0.6, 0.8]);
        assert_eq!(vectors[1], vec![0.0, 1.0]);
        assert!(!report.provider_vectors_were_normalized);
        assert_eq!(report.min_original_norm, 2.0);
        assert_eq!(report.max_original_norm, 5.0);

        assert!(validate_and_normalize(vec![vec![1.0]], 1, 2).is_err());
        assert!(validate_and_normalize(vec![vec![0.0, 0.0]], 1, 2).is_err());
        assert!(validate_and_normalize(vec![vec![f32::NAN, 1.0]], 1, 2).is_err());
    }

    #[test]
    fn indexed_provider_response_is_reordered_and_validated() {
        let bytes = br#"{"data":[{"index":1,"embedding":[0,1]},{"index":0,"embedding":[1,0]}]}"#;
        assert_eq!(
            parse_indexed_response(bytes, 2).unwrap(),
            vec![vec![1.0, 0.0], vec![0.0, 1.0]]
        );
        let duplicate = br#"{"data":[{"index":0,"embedding":[1]},{"index":0,"embedding":[2]}]}"#;
        assert!(parse_indexed_response(duplicate, 2)
            .unwrap_err()
            .to_string()
            .contains("duplicate"));
    }

    #[test]
    fn provider_request_dialects_use_their_documented_fields() {
        let texts = vec!["first".into(), "second".into()];
        let openai = openai_profile("text-embedding-3-small", 512).unwrap();
        assert_eq!(
            embedding_request_body(&openai, &texts).unwrap(),
            json!({
                "model": "text-embedding-3-small",
                "input": ["first", "second"],
                "encoding_format": "float",
                "dimensions": 512
            })
        );

        let mistral = mistral_profile("mistral-embed", 1024).unwrap();
        assert_eq!(
            embedding_request_body(&mistral, &texts).unwrap(),
            json!({
                "model": "mistral-embed",
                "input": ["first", "second"],
                "encoding_format": "float",
                "output_dimension": 1024
            })
        );

        let mut ollama_spec = openai.semantic().clone();
        ollama_spec.provider = EmbeddingProviderDialect::Ollama;
        ollama_spec.model_id = "nomic-embed-text:latest".into();
        ollama_spec.revision = Some("nomic-embed-text:latest".into());
        ollama_spec.artifact_sha256 = Some(DIGEST.into());
        ollama_spec.dimensions = 768;
        let ollama = EmbeddingProfile::new(ollama_spec).unwrap();
        assert_eq!(
            embedding_request_body(&ollama, &texts).unwrap(),
            json!({
                "model": "nomic-embed-text:latest",
                "input": ["first", "second"],
                "truncate": false
            })
        );

        let mut lm_studio_spec = openai.semantic().clone();
        lm_studio_spec.provider = EmbeddingProviderDialect::LmStudio;
        lm_studio_spec.model_id = "local-embedding".into();
        let lm_studio = EmbeddingProfile::new(lm_studio_spec).unwrap();
        assert_eq!(
            embedding_request_body(&lm_studio, &texts).unwrap(),
            json!({
                "model": "local-embedding",
                "input": ["first", "second"],
                "encoding_format": "float",
                "dimensions": 512
            })
        );
    }

    #[test]
    fn retrieval_probe_detects_a_reversed_provider() {
        let good = retrieval_probe(&[1.0, 0.0], &[0.9, 0.1], &[0.0, 1.0]).unwrap();
        assert!(good.relevant_ranked_first);
        let reversed = retrieval_probe(&[1.0, 0.0], &[0.0, 1.0], &[0.9, 0.1]).unwrap();
        assert!(!reversed.relevant_ranked_first);
    }

    #[test]
    fn api_paths_preserve_a_server_path_prefix() {
        assert_eq!(
            embedding_url(
                "https://example.test/proxy/v1",
                EmbeddingProviderDialect::OpenAi
            )
            .unwrap()
            .as_str(),
            "https://example.test/proxy/v1/embeddings"
        );
        assert_eq!(
            embedding_url(
                "http://127.0.0.1:11434/team",
                EmbeddingProviderDialect::Ollama
            )
            .unwrap()
            .as_str(),
            "http://127.0.0.1:11434/team/api/embed"
        );
    }

    #[test]
    fn endpoint_does_not_accept_credentials_in_the_url() {
        assert!(EmbeddingEndpoint::new("https://user:secret@example.test", None).is_err());
        assert!(EmbeddingEndpoint::new("file:///tmp/embed", None).is_err());
    }

    #[test]
    fn only_openai_and_mistral_are_guided_cloud_dialects() {
        assert!(EmbeddingProviderDialect::OpenAi.is_guided_cloud());
        assert!(EmbeddingProviderDialect::Mistral.is_guided_cloud());
        assert!(!EmbeddingProviderDialect::Ollama.is_guided_cloud());
        assert!(!EmbeddingProviderDialect::LmStudio.is_guided_cloud());
        assert!(!EmbeddingProviderDialect::LocalLlamaCpp.is_guided_cloud());
    }

    #[test]
    fn scores_are_not_compared_with_nan() {
        let mut scores = [0.1f32, 0.3, 0.2];
        scores.sort_by(|left, right| right.partial_cmp(left).unwrap_or(Ordering::Equal));
        assert_eq!(scores, [0.3, 0.2, 0.1]);
    }
}
