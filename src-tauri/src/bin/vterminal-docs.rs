//! Headless companion for VTerminal Knowledge.
//!
//! This binary shares the app's docs database, immutable profiles, model cache,
//! Qdrant collection contract, and connection credentials.  It intentionally has
//! no arbitrary model-file/provider flags: automation gets the same closed catalog
//! and compatibility rules as the UI.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use vterminal_lib::docs::chunk::{ChunkSpec, SourcePage};
use vterminal_lib::docs::db::DocsDb;
use vterminal_lib::docs::{index, semantic};
use vterminal_lib::knowledge::embedding::{
    embed_http_batch, EmbeddingEndpoint, EmbeddingInput, EmbeddingProfile,
    EmbeddingProviderDialect, EmbeddingPurpose,
};
use vterminal_lib::knowledge::local::{self, EmbeddingHost};
use vterminal_lib::knowledge::qdrant::{QdrantClient, QdrantEndpoint};
use vterminal_lib::knowledge::store::QdrantConnectionRecord;
use vterminal_lib::knowledge::types::{KnowledgeBucketRef, PointId};

#[derive(Default, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    knowledge_qdrant_connections: Vec<QdrantConnectionRecord>,
    #[serde(default)]
    models_dir: Option<String>,
}

#[derive(Serialize)]
struct CliError<'a> {
    error: &'a str,
}

struct Context {
    json: bool,
    app_data: PathBuf,
    settings: SettingsFile,
    docs: DocsDb,
}

#[tokio::main]
async fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let json = raw.iter().any(|arg| arg == "--json");
    if let Err(error) = run(raw, json).await {
        if json {
            println!(
                "{}",
                serde_json::to_string(&CliError { error: &error }).unwrap()
            );
        } else {
            eprintln!("error: {error}");
        }
        std::process::exit(1);
    }
}

async fn run(mut args: Vec<String>, json_output: bool) -> Result<(), String> {
    args.retain(|arg| arg != "--json");
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        print_help();
        return Ok(());
    }
    let app_data = app_data_dir()?;
    let settings = read_settings(&app_data);
    let docs = DocsDb::new(app_data.clone());
    // Serialize only writes. Listing, testing connections, and searching stay
    // available while either the desktop or another CLI writer is active.
    let _process_lock = is_mutating_command(&args)
        .then(|| {
            vterminal_lib::knowledge::process_lock::KnowledgeProcessLock::try_acquire(&app_data)
        })
        .transpose()?;
    let context = Context {
        json: json_output,
        app_data,
        settings,
        docs,
    };
    match args[0].as_str() {
        "profile" => profile_command(&context, &args[1..]).await,
        "connection" => connection_command(&context, &args[1..]).await,
        "bucket" => bucket_command(&context, &args[1..]).await,
        "document" => document_command(&context, &args[1..]).await,
        "search" => search_command(&context, &args[1..]).await,
        other => Err(format!(
            "unknown command {other:?}; run vterminal-docs help"
        )),
    }
}

fn is_mutating_command(args: &[String]) -> bool {
    matches!(
        args,
        [command, action, ..]
            if (command == "bucket" && matches!(action.as_str(), "create" | "delete"))
                || (command == "document"
                    && matches!(action.as_str(), "ingest" | "replace" | "delete"))
    )
}

#[cfg(test)]
mod process_lock_scope_tests {
    use super::is_mutating_command;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn durable_writes_are_serialized_but_reads_are_not() {
        for command in [
            args(&["bucket", "create", "guides"]),
            args(&["bucket", "delete", "local:id"]),
            args(&["document", "ingest", "local:id", "guide.md"]),
            args(&["document", "replace", "local:id", "doc", "guide.md"]),
            args(&["document", "delete", "local:id", "doc"]),
        ] {
            assert!(is_mutating_command(&command), "{command:?}");
        }
        for command in [
            args(&["bucket", "list"]),
            args(&["document", "list", "local:id"]),
            args(&["search", "local:id", "--query", "guide"]),
            args(&["connection", "test", "qdrant"]),
        ] {
            assert!(!is_mutating_command(&command), "{command:?}");
        }
    }
}

fn print_help() {
    println!(
        "vterminal-docs [--json] <command>\n\n\
         profile list\n\
         connection list | test <id>\n\
         bucket list | create <name> [--connection <id> --profile <id>]\n\
         bucket delete <local:id|qdrant:connection:collection> [--confirm <exact-name>]\n\
         document list <bucket-ref> [--cursor <point-id>]\n\
         document ingest <bucket-ref> <path|-> [--title <title>]\n\
         document replace <bucket-ref> <document-id> <path|-> [--title <title>]\n\
         document delete <bucket-ref> <document-id>\n\
         search <bucket-ref>... --query <text>\n\n\
         Set VTERMINAL_APP_DATA_DIR to override the shared app-data directory.\n\
         Text, structured text, page JSON, and text-layer PDF inputs are supported.\n\
         OCR-required input fails with guidance to use Settings → Knowledge."
    );
}

fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("VTERMINAL_APP_DATA_DIR") {
        let path = PathBuf::from(path);
        if path.as_os_str().is_empty() {
            return Err("VTERMINAL_APP_DATA_DIR cannot be empty".into());
        }
        return Ok(path);
    }
    dirs::data_dir()
        .map(|path| path.join("com.veviad.terminal"))
        .ok_or_else(|| "could not resolve the application data directory".into())
}

fn read_settings(app_data: &Path) -> SettingsFile {
    std::fs::read(app_data.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn output<T: Serialize + std::fmt::Debug>(context: &Context, value: &T) -> Result<(), String> {
    if context.json {
        println!(
            "{}",
            serde_json::to_string(value).map_err(|error| error.to_string())?
        );
    } else {
        println!("{value:#?}");
    }
    Ok(())
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|at| args.get(at + 1))
        .cloned()
}

fn connection<'a>(context: &'a Context, id: &str) -> Result<&'a QdrantConnectionRecord, String> {
    context
        .settings
        .knowledge_qdrant_connections
        .iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| format!("unknown Qdrant connection {id:?}"))
}

fn qdrant(context: &Context, id: &str) -> Result<QdrantClient, String> {
    let record = connection(context, id)?;
    let key = vterminal_lib::credentials::headless_qdrant_get(id, &record.url)?;
    let endpoint = QdrantEndpoint::parse(&record.url, key.is_some(), record.allow_insecure)
        .map_err(|error| error.to_string())?;
    QdrantClient::new(endpoint, key).map_err(|error| error.to_string())
}

async fn profile_command(context: &Context, args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("list") => {
            let profiles = if context.docs.exists() {
                context
                    .docs
                    .with(|connection| semantic::list_profiles(connection))?
            } else {
                Vec::new()
            };
            output(context, &profiles)
        }
        _ => Err("usage: profile list".into()),
    }
}

async fn connection_command(context: &Context, args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("list") => {
            let safe: Vec<_> = context
                .settings
                .knowledge_qdrant_connections
                .iter()
                .map(|record| {
                    json!({
                        "id": record.id,
                        "label": record.label,
                        "url": record.url,
                        "has_api_key": vterminal_lib::credentials::headless_qdrant_get(
                            &record.id,
                            &record.url,
                        )
                        .map(|key| key.is_some())
                        .unwrap_or(false),
                        "status": record.status,
                        "server_version": record.server_version
                    })
                })
                .collect();
            output(context, &safe)
        }
        Some("test") => {
            let id = args.get(1).ok_or("usage: connection test <id>")?;
            let client = qdrant(context, id)?;
            let info = client
                .server_info()
                .await
                .map_err(|error| error.to_string())?;
            let collections = client
                .list_collections()
                .await
                .map_err(|error| error.to_string())?;
            output(
                context,
                &json!({ "server": info, "collections": collections }),
            )
        }
        _ => Err("usage: connection list | connection test <id>".into()),
    }
}

async fn bucket_command(context: &Context, args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("list") => {
            let local = if context.docs.exists() {
                context
                    .docs
                    .with(|connection| index::list_buckets(connection))?
            } else {
                Vec::new()
            };
            let mut remote = Vec::new();
            for record in &context.settings.knowledge_qdrant_connections {
                match qdrant(context, &record.id) {
                    Ok(client) => match client.list_collections().await {
                        Ok(collections) => remote.push(json!({
                            "connection_id": record.id,
                            "connection": record.label,
                            "collections": collections
                        })),
                        Err(error) => remote.push(json!({
                            "connection_id": record.id,
                            "error": error.to_string()
                        })),
                    },
                    Err(error) => remote.push(json!({
                        "connection_id": record.id,
                        "error": error
                    })),
                }
            }
            output(context, &json!({ "local": local, "qdrant": remote }))
        }
        Some("create") => {
            let name = args.get(1).ok_or("usage: bucket create <name> [options]")?;
            let profile_id = option(args, "--profile");
            if let Some(connection_id) = option(args, "--connection") {
                let profile_id = profile_id.ok_or("remote bucket creation needs --profile")?;
                let profile = load_profile(context, &profile_id)?;
                let client = qdrant(context, &connection_id)?;
                let info = client
                    .server_info()
                    .await
                    .map_err(|error| error.to_string())?;
                let version = Version::parse(&info.version)
                    .map_err(|_| "Qdrant returned an invalid version")?;
                client
                    .create_collection(&version, name, &profile)
                    .await
                    .map_err(|error| error.to_string())?;
                output(
                    context,
                    &json!({"source":"qdrant","connection_id":connection_id,"collection":name}),
                )
            } else {
                let id = context.docs.with(|connection| {
                    index::create_bucket(connection, name, ChunkSpec::default())
                })?;
                if let Some(profile_id) = profile_id {
                    let profile = load_profile(context, &profile_id)?;
                    context.docs.with(|connection| {
                        semantic::assign_bucket_profile(
                            connection,
                            &id,
                            &profile_id,
                            profile.fingerprint(),
                            &profile.semantic().model_id,
                            profile.semantic().dimensions,
                        )
                    })?;
                }
                output(context, &json!({"source":"local","bucket_id":id}))
            }
        }
        Some("delete") => {
            let raw = args.get(1).ok_or("usage: bucket delete <bucket-ref>")?;
            match parse_ref(raw)? {
                KnowledgeBucketRef::Local { bucket_id } => {
                    context
                        .docs
                        .with(|connection| index::delete_bucket(connection, &bucket_id))?;
                }
                KnowledgeBucketRef::Qdrant {
                    connection_id,
                    collection,
                } => {
                    if option(args, "--confirm").as_deref() != Some(collection.as_str()) {
                        return Err(
                            "remote deletion requires --confirm <exact-collection-name>".into()
                        );
                    }
                    qdrant(context, &connection_id)?
                        .delete_collection(&collection)
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
            output(context, &json!({"deleted":raw}))
        }
        _ => Err("usage: bucket list | create | delete".into()),
    }
}

async fn document_command(context: &Context, args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("list") => {
            let bucket = parse_ref(args.get(1).ok_or("usage: document list <bucket-ref>")?)?;
            match bucket {
                KnowledgeBucketRef::Local { bucket_id } => output(
                    context,
                    &context
                        .docs
                        .with(|connection| index::list_files(connection, &bucket_id))?,
                ),
                KnowledgeBucketRef::Qdrant {
                    connection_id,
                    collection,
                } => {
                    let cursor = option(args, "--cursor").map(PointId::String);
                    let page = qdrant(context, &connection_id)?
                        .scroll_documents(&collection, cursor, 100)
                        .await
                        .map_err(|error| error.to_string())?;
                    output(context, &page)
                }
            }
        }
        Some("delete") => {
            let bucket = parse_ref(
                args.get(1)
                    .ok_or("usage: document delete <bucket-ref> <id>")?,
            )?;
            let document_id = args
                .get(2)
                .ok_or("usage: document delete <bucket-ref> <id>")?;
            match bucket {
                KnowledgeBucketRef::Local { .. } => {
                    context
                        .docs
                        .with(|connection| index::remove_file(connection, document_id))?;
                }
                KnowledgeBucketRef::Qdrant {
                    connection_id,
                    collection,
                } => {
                    qdrant(context, &connection_id)?
                        .delete_document(&collection, document_id)
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
            output(context, &json!({"deleted":document_id}))
        }
        Some("ingest") | Some("replace") => {
            // The shared ingestion function is filled in by the knowledge backend;
            // keeping extraction here makes OCR limitations explicit and testable.
            let replace = args[0] == "replace";
            let bucket_at = 1;
            let document_at = if replace { Some(2) } else { None };
            let path_at = if replace { 3 } else { 2 };
            let bucket = parse_ref(args.get(bucket_at).ok_or("missing bucket reference")?)?;
            let document_id = document_at.and_then(|at| args.get(at)).cloned();
            let source = args.get(path_at).ok_or("missing source path or -")?;
            let pages = extract_pages(source)?;
            let title = option(args, "--title").unwrap_or_else(|| source_title(source));
            let request = vterminal_lib::knowledge::ingest::IngestRequest {
                bucket,
                document_id,
                title,
                source_uri: if source == "-" {
                    "stdin:".into()
                } else {
                    source.clone()
                },
                mime_type: media_type(source).into(),
                pages,
            };
            let result = vterminal_lib::knowledge::ingest::ingest_headless(
                &context.app_data,
                &context.settings_path_values(),
                &context.docs,
                request,
            )
            .await?;
            output(context, &result)
        }
        _ => Err("usage: document list|ingest|replace|delete ...".into()),
    }
}

async fn search_command(context: &Context, args: &[String]) -> Result<(), String> {
    let query_at = args
        .iter()
        .position(|arg| arg == "--query")
        .ok_or("search requires --query <text>")?;
    let query = args.get(query_at + 1).ok_or("search requires query text")?;
    let refs = args[..query_at]
        .iter()
        .map(|raw| parse_ref(raw))
        .collect::<Result<Vec<_>, _>>()?;
    if refs.is_empty() {
        return Err("search needs at least one bucket reference".into());
    }
    let mut arms: Vec<Vec<Value>> = Vec::new();
    for bucket in refs {
        match bucket {
            KnowledgeBucketRef::Local { bucket_id } => {
                let hits = context.docs.with(|connection| {
                    vterminal_lib::docs::search::search_bm25(
                        connection,
                        std::slice::from_ref(&bucket_id),
                        query,
                        12,
                    )
                })?;
                arms.push(
                    hits.into_iter()
                        .map(|hit| {
                            json!({
                                "bucket":{"source":"local","bucket_id":bucket_id},
                                "file_name":hit.file_name,"page":hit.page,"heading":hit.heading,
                                "text":hit.text,"score":hit.score
                            })
                        })
                        .collect(),
                );
            }
            KnowledgeBucketRef::Qdrant {
                connection_id,
                collection,
            } => {
                let client = qdrant(context, &connection_id)?;
                let info = client
                    .collection_info(&collection)
                    .await
                    .map_err(|error| error.to_string())?;
                let metadata = info
                    .metadata
                    .ok_or("collection is unmarked; import it in the UI first")?;
                let vector = embed_query_cli(context, &metadata.embedding_profile, query).await?;
                let hits = client
                    .query(
                        &connection_id,
                        &collection,
                        &metadata.vector_name,
                        &vector,
                        12,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                arms.push(
                    hits.into_iter()
                        .map(|hit| serde_json::to_value(hit).unwrap())
                        .collect(),
                );
            }
        }
    }
    // Each source arm is rank-normalized; raw BM25/Qdrant scores never mix.
    let mut fused: HashMap<String, (f64, Value)> = HashMap::new();
    for arm in arms {
        for (rank, hit) in arm.into_iter().enumerate() {
            let key = hit
                .get("chunk_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:{}", hit["file_name"], rank));
            let entry = fused.entry(key).or_insert((0.0, hit));
            entry.0 += 1.0 / (60.0 + rank as f64 + 1.0);
        }
    }
    let mut hits: Vec<_> = fused
        .into_values()
        .map(|(score, mut hit)| {
            hit["score"] = json!(score);
            hit
        })
        .collect();
    hits.sort_by(|left, right| {
        right["score"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&left["score"].as_f64().unwrap_or(0.0))
    });
    hits.truncate(12);
    output(context, &hits)
}

fn parse_ref(raw: &str) -> Result<KnowledgeBucketRef, String> {
    if let Some(bucket_id) = raw.strip_prefix("local:") {
        if bucket_id.is_empty() {
            return Err("local bucket reference needs an id".into());
        }
        return Ok(KnowledgeBucketRef::Local {
            bucket_id: bucket_id.into(),
        });
    }
    if let Some(rest) = raw.strip_prefix("qdrant:") {
        let mut parts = rest.splitn(2, ':');
        let connection_id = parts.next().unwrap_or_default();
        let collection = parts.next().unwrap_or_default();
        if connection_id.is_empty() || collection.is_empty() {
            return Err("Qdrant reference must be qdrant:<connection-id>:<collection>".into());
        }
        return Ok(KnowledgeBucketRef::Qdrant {
            connection_id: connection_id.into(),
            collection: collection.into(),
        });
    }
    Err("bucket references use local:<id> or qdrant:<connection-id>:<collection>".into())
}

fn load_profile(context: &Context, id: &str) -> Result<EmbeddingProfile, String> {
    if !context.docs.exists() {
        return Err("no embedding profiles are installed".into());
    }
    context.docs.with(|connection| {
        semantic::list_profiles(connection)?
            .into_iter()
            .find(|row| row.id == id || row.fingerprint == id)
            .ok_or_else(|| format!("unknown embedding profile {id:?}"))
            .and_then(|row| serde_json::from_value(row.profile).map_err(|error| error.to_string()))
    })
}

async fn embed_query_cli(
    context: &Context,
    profile: &EmbeddingProfile,
    query: &str,
) -> Result<Vec<f32>, String> {
    if profile.semantic().provider == EmbeddingProviderDialect::LocalLlamaCpp {
        let models_dir = vterminal_lib::models::registry::models_dir(
            &context.app_data,
            context.settings.models_dir.as_deref(),
        );
        let digest = profile
            .semantic()
            .artifact_sha256
            .as_deref()
            .ok_or("local profile has no artifact hash")?;
        let installed = local::installed_artifacts(&models_dir)
            .into_iter()
            .find(|record| record.sha256.eq_ignore_ascii_case(digest))
            .ok_or("the exact local embedding artifact is not installed")?;
        #[cfg(feature = "local-llm")]
        let host = EmbeddingHost::default();
        #[cfg(not(feature = "local-llm"))]
        let host = EmbeddingHost;
        let batch = host
            .embed(
                &installed,
                profile,
                EmbeddingPurpose::Query,
                &[EmbeddingInput::text(query)],
            )
            .await
            .map_err(|error| error.to_string())?;
        return batch
            .vectors
            .into_iter()
            .next()
            .ok_or("no query vector returned".into());
    }
    let (base, key) = match profile.semantic().provider {
        EmbeddingProviderDialect::OpenAi => (
            "https://api.openai.com",
            vterminal_lib::credentials::headless_get(
                &vterminal_lib::credentials::CredentialId::OpenAi,
            )?
            .map(|secret| secret.expose().to_owned()),
        ),
        EmbeddingProviderDialect::Mistral => (
            "https://api.mistral.ai",
            vterminal_lib::credentials::headless_get(
                &vterminal_lib::credentials::CredentialId::Mistral,
            )?
            .map(|secret| secret.expose().to_owned()),
        ),
        _ => {
            return Err(
                "CLI search currently supports built-in local, OpenAI, and Mistral profiles".into(),
            )
        }
    };
    let endpoint = EmbeddingEndpoint::new(
        base,
        key.filter(|key| !key.trim().is_empty()).map(Into::into),
    )
    .map_err(|error| error.to_string())?;
    let batch = embed_http_batch(
        &reqwest::Client::new(),
        &endpoint,
        profile,
        EmbeddingPurpose::Query,
        &[EmbeddingInput::text(query)],
    )
    .await
    .map_err(|error| error.to_string())?;
    batch
        .vectors
        .into_iter()
        .next()
        .ok_or("no query vector returned".into())
}

fn extract_pages(source: &str) -> Result<Vec<SourcePage>, String> {
    let mut bytes = Vec::new();
    if source == "-" {
        io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
    } else {
        bytes = std::fs::read(source).map_err(|error| format!("read {source:?}: {error}"))?;
    }
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("source is larger than the 64 MiB ingestion limit".into());
    }
    if source.to_ascii_lowercase().ends_with(".pdf") {
        let text = pdf_extract::extract_text_from_mem(&bytes).map_err(|_| {
            "PDF has no usable text layer; ingest it through the UI for OCR".to_string()
        })?;
        if text.trim().is_empty() {
            return Err("PDF has no usable text layer; ingest it through the UI for OCR".into());
        }
        return Ok(vec![SourcePage { page: None, text }]);
    }
    if source.to_ascii_lowercase().ends_with(".json") {
        if let Ok(pages) = serde_json::from_slice::<Vec<PageJson>>(&bytes) {
            return Ok(pages
                .into_iter()
                .map(|page| SourcePage {
                    page: page.page,
                    text: page.text,
                })
                .collect());
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        "source is not UTF-8 text; use the UI for OCR or binary formats".to_string()
    })?;
    Ok(vec![SourcePage { page: None, text }])
}

#[derive(Deserialize)]
struct PageJson {
    page: Option<u32>,
    text: String,
}

fn source_title(source: &str) -> String {
    if source == "-" {
        "stdin".into()
    } else {
        Path::new(source)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(source)
            .into()
    }
}

fn media_type(source: &str) -> &'static str {
    match Path::new(source)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        _ => "text/plain",
    }
}

impl Context {
    /// Non-secret values needed by the headless ingestion core. Credentials are
    /// resolved directly from Keychain by the shared backend.
    fn settings_path_values(&self) -> Value {
        json!({
            "connections": self.settings.knowledge_qdrant_connections,
            "models_dir": self.settings.models_dir
        })
    }
}
