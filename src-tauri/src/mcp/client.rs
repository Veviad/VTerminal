use std::collections::{BTreeSet, HashMap};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use http::{HeaderName, HeaderValue};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientInfo, Implementation,
    ProtocolVersion, Tool,
};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{serve_client_with_lifecycle, ClientHandler, ClientLifecycleMode};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::Wry;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use super::config::{self, McpAuthMode, McpServerConfig, McpToolGrant, McpTransportConfig};

const MAX_LOG_BYTES: usize = 256 * 1024;
const MAX_STDERR_LINE_BYTES: usize = 16 * 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOOL_ALIAS_BYTES: usize = 64;
const MAX_ALIAS_TOOL_NAME_BYTES: usize = 39;
const TOOL_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default)]
struct VTerminalClient {
    tool_generation: Arc<std::sync::atomic::AtomicU64>,
}

impl ClientHandler for VTerminalClient {
    fn get_info(&self) -> ClientInfo {
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("vterminal", env!("CARGO_PKG_VERSION"))
                .with_title("VTerminal")
                .with_description("VTerminal MCP client"),
        )
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
    }

    fn on_tool_list_changed(
        &self,
        _context: rmcp::service::NotificationContext<RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        self.tool_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::future::ready(())
    }
}

type McpService = RunningService<RoleClient, VTerminalClient>;

struct Session {
    revision: u32,
    service: McpService,
    tool_cache: Option<CachedTools>,
    _sandbox_guard: Option<super::sandbox::SandboxGuard>,
}

struct CachedTools {
    generation: u64,
    stored_at: Instant,
    tools: Vec<McpToolView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    conversation_id: String,
    server_id: String,
}

#[derive(Default)]
pub struct McpManager {
    sessions: Mutex<HashMap<SessionKey, Arc<Mutex<Session>>>>,
    logs: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolView {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    pub alias: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub annotations: Option<Value>,
    pub schema_hash: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct McpToolResultView {
    pub content: Vec<Value>,
    pub structured_content: Option<Value>,
    pub is_error: bool,
    pub model_text: String,
    pub truncated: bool,
}

impl McpToolResultView {
    pub fn transcript_content(&self) -> crate::provider::StructuredToolResult {
        crate::provider::StructuredToolResult {
            content: self.content.clone(),
            structured_content: self.structured_content.clone(),
            is_error: self.is_error,
            truncated: self.truncated,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct McpServerRuntimeView {
    pub connected: bool,
    pub log_bytes: usize,
    pub tool_count: Option<usize>,
}

fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![
            ProtocolVersion::V_2026_07_28,
            ProtocolVersion::V_2025_11_25,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_03_26,
            ProtocolVersion::V_2024_11_05,
        ],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    }
}

fn is_auth_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("invalid_token")
        || lower.contains("authorization required")
}

fn uses_oauth(config: &McpServerConfig) -> bool {
    matches!(
        &config.transport,
        McpTransportConfig::StreamableHttp { auth, .. } if auth.mode == McpAuthMode::OAuth
    )
}

fn transport_boundary(config: &McpServerConfig) -> &str {
    match &config.transport {
        McpTransportConfig::StreamableHttp { url, .. } => url,
        McpTransportConfig::Stdio { .. } => "stdio",
    }
}

fn secret(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
    slot: &str,
) -> Result<Option<crate::credentials::Secret>, String> {
    let id = crate::credentials::mcp_id(&config.id, transport_boundary(config), slot)?;
    crate::credentials::state(app).get(&id)
}

fn secret_string(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
    slot: &str,
) -> Result<Option<String>, String> {
    Ok(secret(app, config, slot)?.map(|value| value.expose().to_owned()))
}

async fn read_stderr(
    server_id: String,
    stderr: tokio::process::ChildStderr,
    logs: Arc<Mutex<HashMap<String, String>>>,
    secrets: Vec<crate::credentials::Secret>,
) {
    let mut stderr = stderr;
    let mut buffer = [0u8; 4096];
    let mut line = BoundedStderrLine::default();
    loop {
        let read = match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for (bytes, truncated) in line.push(&buffer[..read]) {
            append_stderr_log(&logs, &server_id, &secrets, &bytes, truncated).await;
        }
    }
    if let Some((bytes, truncated)) = line.finish() {
        append_stderr_log(&logs, &server_id, &secrets, &bytes, truncated).await;
    }
}

#[derive(Default)]
struct BoundedStderrLine {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedStderrLine {
    fn push(&mut self, chunk: &[u8]) -> Vec<(Vec<u8>, bool)> {
        let mut complete = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                complete.push((std::mem::take(&mut self.bytes), self.truncated));
                self.truncated = false;
            } else if self.bytes.len() < MAX_STDERR_LINE_BYTES {
                self.bytes.push(byte);
            } else {
                self.truncated = true;
            }
        }
        complete
    }

    fn finish(&mut self) -> Option<(Vec<u8>, bool)> {
        if self.bytes.is_empty() && !self.truncated {
            None
        } else {
            let value = (std::mem::take(&mut self.bytes), self.truncated);
            self.truncated = false;
            Some(value)
        }
    }
}

async fn append_stderr_log(
    logs: &Mutex<HashMap<String, String>>,
    server_id: &str,
    secrets: &[crate::credentials::Secret],
    bytes: &[u8],
    truncated: bool,
) {
    let text = String::from_utf8_lossy(bytes);
    let mut clean = secrets.iter().fold(
        crate::credentials::redact_provider_text(&text, None),
        |line, secret| crate::credentials::redact_provider_text(&line, Some(secret)),
    );
    if truncated {
        clean.push_str(" [stderr line truncated]");
    }
    let mut logs = logs.lock().await;
    append_bounded_log(logs.entry(server_id.to_owned()).or_default(), &clean);
}

fn append_bounded_log(log: &mut String, message: &str) {
    log.push_str(message);
    log.push('\n');
    if log.len() > MAX_LOG_BYTES {
        let minimum = log.len() - MAX_LOG_BYTES;
        let boundary = (minimum..log.len())
            .find(|index| log.is_char_boundary(*index))
            .unwrap_or(log.len());
        log.drain(..boundary);
    }
}

impl McpManager {
    async fn append_log(&self, server_id: &str, message: impl AsRef<str>) {
        let clean = crate::credentials::redact_provider_text(message.as_ref(), None);
        let mut logs = self.logs.lock().await;
        append_bounded_log(logs.entry(server_id.to_owned()).or_default(), &clean);
    }

    async fn new_service(
        &self,
        app: &tauri::AppHandle<Wry>,
        config: &McpServerConfig,
    ) -> Result<(McpService, Option<super::sandbox::SandboxGuard>), String> {
        if !config.enabled {
            return Err("MCP server is disabled".into());
        }
        if !config::is_trusted(config) {
            return Err("MCP server must be trusted before it can start".into());
        }
        let handler = VTerminalClient::default();
        let timeout = Duration::from_millis(config.timeouts.startup_ms);
        match &config.transport {
            McpTransportConfig::StreamableHttp { url, auth, headers } => {
                tokio::time::timeout(
                    Duration::from_secs(5),
                    config::validate_resolved_http_target(url),
                )
                .await
                .map_err(|_| "MCP host resolution timed out".to_string())??;
                let mut custom_headers = HashMap::new();
                for header in headers {
                    let value = secret_string(app, config, &format!("header:{}", header.name))?
                        .ok_or_else(|| {
                            format!("HTTP header {} has no stored value", header.name)
                        })?;
                    custom_headers.insert(
                        HeaderName::from_bytes(header.name.as_bytes())
                            .map_err(|_| format!("invalid HTTP header {}", header.name))?,
                        HeaderValue::from_str(&value).map_err(|_| {
                            format!("invalid value for HTTP header {}", header.name)
                        })?,
                    );
                }
                let auth_header = match auth.mode {
                    McpAuthMode::None | McpAuthMode::Headers => None,
                    McpAuthMode::Bearer => secret_string(app, config, "bearer")?
                        .ok_or("this MCP server needs a bearer token")?
                        .into(),
                    McpAuthMode::OAuth => super::oauth::access_token(app, config).await?.into(),
                };
                let mut transport_config =
                    StreamableHttpClientTransportConfig::with_uri(url.clone())
                        .custom_headers(custom_headers)
                        .max_sse_event_size(MAX_SSE_EVENT_BYTES)
                        .reinit_on_expired_session(true);
                if let Some(token) = auth_header {
                    transport_config = transport_config.auth_header(token);
                }
                let transport = StreamableHttpClientTransport::from_config(transport_config);
                tokio::time::timeout(
                    timeout,
                    serve_client_with_lifecycle(handler, transport, lifecycle()),
                )
                .await
                .map_err(|_| "MCP HTTP startup timed out".to_string())?
                .map_err(|error| format!("MCP HTTP connection failed: {error}"))
                .map(|service| (service, None))
            }
            McpTransportConfig::Stdio {
                command,
                args,
                cwd,
                env,
                sandbox,
            } => {
                let sandbox_status = super::sandbox::status(app).await;
                if !sandbox_status.ready {
                    return Err(sandbox_status.message);
                }
                let mut resolved_env = Vec::new();
                for entry in env {
                    let stored = if entry.secret {
                        Some(
                            secret(app, config, &format!("env:{}", entry.name))?.ok_or_else(
                                || {
                                    format!(
                                        "environment variable {} has no stored value",
                                        entry.name
                                    )
                                },
                            )?,
                        )
                    } else {
                        None
                    };
                    resolved_env.push((entry.clone(), stored));
                }
                let mut launch = super::sandbox::command(
                    app,
                    &config.id,
                    command,
                    args,
                    cwd.as_deref(),
                    &resolved_env,
                    sandbox,
                )
                .await?;
                let (transport, stderr) = TokioChildProcess::builder(launch.command)
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|error| format!("could not start sandboxed MCP server: {error}"))?;
                if let Some(guard) = launch.guard.as_mut() {
                    guard.set_process_id(transport.id());
                }
                if let Some(stderr) = stderr {
                    let server_id = config.id.clone();
                    let secrets = resolved_env
                        .iter()
                        .filter_map(|(_, secret)| secret.clone())
                        .collect();
                    tokio::spawn(read_stderr(
                        server_id,
                        stderr,
                        Arc::clone(&self.logs),
                        secrets,
                    ));
                }
                tokio::time::timeout(
                    timeout,
                    serve_client_with_lifecycle(handler, transport, lifecycle()),
                )
                .await
                .map_err(|_| "MCP stdio startup timed out".to_string())?
                .map_err(|error| format!("MCP stdio connection failed: {error}"))
                .map(|service| (service, launch.guard))
            }
        }
    }

    async fn session(
        &self,
        app: &tauri::AppHandle<Wry>,
        conversation_id: &str,
        config: &McpServerConfig,
    ) -> Result<Arc<Mutex<Session>>, String> {
        let key = SessionKey {
            conversation_id: conversation_id.to_owned(),
            server_id: config.id.clone(),
        };
        if let Some(existing) = self.sessions.lock().await.get(&key).cloned() {
            let stale = {
                let session = existing.lock().await;
                session.revision != config.revision || session.service.is_closed()
            };
            if !stale {
                return Ok(existing);
            }
            self.sessions.lock().await.remove(&key);
        }
        let connection = self.new_service(app, config).await;
        let (service, sandbox_guard) = match connection {
            Err(error) if uses_oauth(config) && is_auth_failure(&error) => {
                super::oauth::force_refresh(app, config).await?;
                self.new_service(app, config).await?
            }
            Err(error) => return Err(error),
            Ok(connection) => connection,
        };
        let session = Arc::new(Mutex::new(Session {
            revision: config.revision,
            service,
            tool_cache: None,
            _sandbox_guard: sandbox_guard,
        }));
        self.sessions.lock().await.insert(key, Arc::clone(&session));
        self.append_log(&config.id, "connected").await;
        Ok(session)
    }

    pub async fn list_tools(
        &self,
        app: &tauri::AppHandle<Wry>,
        conversation_id: &str,
        config: &McpServerConfig,
    ) -> Result<Vec<McpToolView>, String> {
        let session = self.session(app, conversation_id, config).await?;
        let mut session = session.lock().await;
        let generation = session
            .service
            .service()
            .tool_generation
            .load(std::sync::atomic::Ordering::SeqCst);
        if let Some(cache) = &session.tool_cache {
            if cache.generation == generation && cache.stored_at.elapsed() < TOOL_CACHE_TTL {
                return Ok(cache.tools.clone());
            }
        }
        let tools = tokio::time::timeout(
            Duration::from_millis(config.timeouts.list_ms),
            session.service.list_all_tools(),
        )
        .await
        .map_err(|_| "MCP tool discovery timed out".to_string())?
        .map_err(|error| format!("MCP tool discovery failed: {error}"))?;
        let tools = tools
            .into_iter()
            .filter(|tool| {
                !config
                    .disabled_tools
                    .iter()
                    .any(|name| name == tool.name.as_ref())
            })
            .filter_map(|tool| match tool_view(config, &tool) {
                Ok(view) => Some(view),
                Err(error) => {
                    log::warn!("ignoring invalid MCP tool {}: {error}", tool.name);
                    None
                }
            })
            .collect::<Vec<_>>();
        session.tool_cache = Some(CachedTools {
            generation,
            stored_at: Instant::now(),
            tools: tools.clone(),
        });
        Ok(tools)
    }

    pub async fn call_tool(
        &self,
        app: &tauri::AppHandle<Wry>,
        conversation_id: &str,
        config: &McpServerConfig,
        tool_name: &str,
        arguments: Value,
    ) -> Result<McpToolResultView, String> {
        if config.disabled_tools.iter().any(|name| name == tool_name) {
            return Err("this MCP tool is disabled".into());
        }
        let arguments = match arguments {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return Err("MCP tool arguments must be a JSON object".into()),
        };
        let call = |arguments: Map<String, Value>| {
            self.call_tool_response(app, conversation_id, config, tool_name, arguments)
        };
        let response = match call(arguments.clone()).await {
            Err(error) if uses_oauth(config) && is_auth_failure(&error) => {
                super::oauth::force_refresh(app, config).await?;
                self.disconnect(conversation_id, Some(&config.id)).await;
                call(arguments).await?
            }
            Err(error) => return Err(error),
            Ok(response) => response,
        };
        match response {
            CallToolResponse::Complete(result) => normalize_result(result),
            CallToolResponse::InputRequired(_) => Err(
                "MCP tool requested interactive input; elicitation is not supported in VTerminal 0.4.4"
                    .into(),
            ),
            CallToolResponse::Task(_) => Err(
                "MCP tool returned a background task; MCP Tasks are not supported in VTerminal 0.4.4"
                    .into(),
            ),
            _ => Err("MCP tool returned an unsupported result type".into()),
        }
    }

    async fn call_tool_response(
        &self,
        app: &tauri::AppHandle<Wry>,
        conversation_id: &str,
        config: &McpServerConfig,
        tool_name: &str,
        arguments: Map<String, Value>,
    ) -> Result<CallToolResponse, String> {
        let session = self.session(app, conversation_id, config).await?;
        let session = session.lock().await;
        let params = CallToolRequestParams::new(tool_name.to_owned()).with_arguments(arguments);
        tokio::time::timeout(
            Duration::from_millis(config.timeouts.call_ms),
            session.service.call_tool_once(params),
        )
        .await
        .map_err(|_| "MCP tool call timed out".to_string())?
        .map_err(|error| format!("MCP tool call failed: {error}"))
    }

    pub async fn disconnect(&self, conversation_id: &str, server_id: Option<&str>) {
        let keys = self
            .sessions
            .lock()
            .await
            .keys()
            .filter(|key| {
                key.conversation_id == conversation_id
                    && server_id.is_none_or(|server| key.server_id == server)
            })
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(session) = self.sessions.lock().await.remove(&key) {
                let mut session = session.lock().await;
                let _ = session
                    .service
                    .close_with_timeout(Duration::from_secs(2))
                    .await;
            }
        }
    }

    pub async fn disconnect_server(&self, server_id: &str) {
        let keys = self
            .sessions
            .lock()
            .await
            .keys()
            .filter(|key| key.server_id == server_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(session) = self.sessions.lock().await.remove(&key) {
                let mut session = session.lock().await;
                let _ = session
                    .service
                    .close_with_timeout(Duration::from_secs(2))
                    .await;
            }
        }
    }

    pub async fn refresh_tools(&self, conversation_id: &str, server_id: &str) {
        let key = SessionKey {
            conversation_id: conversation_id.to_owned(),
            server_id: server_id.to_owned(),
        };
        if let Some(session) = self.sessions.lock().await.get(&key).cloned() {
            session.lock().await.tool_cache = None;
        }
    }

    pub async fn shutdown(&self) {
        let sessions = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in &sessions {
            let session = session.lock().await;
            session.service.cancellation_token().cancel();
        }
        let closing = async {
            for session in sessions {
                let mut session = session.lock().await;
                let _ = session
                    .service
                    .close_with_timeout(Duration::from_secs(2))
                    .await;
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(4), closing).await;
    }

    pub async fn runtime(&self, server_id: &str) -> McpServerRuntimeView {
        let matching = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(key, _)| key.server_id == server_id)
            .map(|(_, session)| Arc::clone(session))
            .collect::<Vec<_>>();
        let connected = !matching.is_empty();
        let mut tool_count = None;
        for session in matching {
            if let Some(cache) = &session.lock().await.tool_cache {
                tool_count = Some(tool_count.unwrap_or(0).max(cache.tools.len()));
            }
        }
        let log_bytes = self.logs.lock().await.get(server_id).map_or(0, String::len);
        McpServerRuntimeView {
            connected,
            log_bytes,
            tool_count,
        }
    }

    pub async fn logs(&self, server_id: &str) -> String {
        self.logs
            .lock()
            .await
            .get(server_id)
            .cloned()
            .unwrap_or_default()
    }
}

fn validate_x_mcp_headers(schema: &Value) -> Result<(), String> {
    fn visit(value: &Value, names: &mut BTreeSet<String>) -> Result<(), String> {
        match value {
            Value::Object(map) => {
                if let Some(header) = map.get("x-mcp-header") {
                    let header = header.as_str().ok_or("x-mcp-header must be a string")?;
                    HeaderName::from_bytes(header.as_bytes())
                        .map_err(|_| "invalid x-mcp-header name")?;
                    let lower = header.to_ascii_lowercase();
                    if !names.insert(lower) {
                        return Err("duplicate x-mcp-header name".into());
                    }
                    let primitive = map
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| matches!(kind, "string" | "integer" | "boolean"));
                    if !primitive {
                        return Err(
                            "x-mcp-header can annotate only string, integer, or boolean properties"
                                .into(),
                        );
                    }
                }
                for child in map.values() {
                    visit(child, names)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    visit(child, names)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(schema, &mut BTreeSet::new())
}

pub fn alias(server_id: &str, tool_name: &str) -> String {
    let prefix = server_id
        .chars()
        .filter(|char| char.is_ascii_hexdigit())
        .take(8)
        .collect::<String>();
    let clean = tool_name
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '_' {
                char
            } else {
                '_'
            }
        })
        .take(MAX_ALIAS_TOOL_NAME_BYTES)
        .collect::<String>();
    // Sanitising is not injective (`git.commit` and `git-commit` would collide),
    // so keep a short digest of the exact immutable tool identity in the alias.
    // The UUID prefix prevents collisions between servers without tying model-
    // visible names to a mutable display label.
    let digest = Sha256::digest(tool_name.as_bytes());
    let suffix = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let alias = format!("mcp__{prefix}__{clean}__{suffix}");
    debug_assert!(alias.len() <= MAX_TOOL_ALIAS_BYTES);
    alias
}

pub fn schema_hash(tool: &Tool) -> Result<String, String> {
    let bytes = serde_json::to_vec(tool).map_err(|error| error.to_string())?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn tool_view(config: &McpServerConfig, tool: &Tool) -> Result<McpToolView, String> {
    let input_schema =
        serde_json::to_value(tool.input_schema.as_ref()).map_err(|error| error.to_string())?;
    validate_x_mcp_headers(&input_schema)?;
    Ok(McpToolView {
        server_id: config.id.clone(),
        server_name: config.name.clone(),
        name: tool.name.to_string(),
        alias: alias(&config.id, &tool.name),
        title: tool.title.clone(),
        description: tool.description.as_ref().map(ToString::to_string),
        input_schema,
        output_schema: tool
            .output_schema
            .as_ref()
            .map(|schema| serde_json::to_value(schema.as_ref()))
            .transpose()
            .map_err(|error| error.to_string())?,
        annotations: tool
            .annotations
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| error.to_string())?,
        schema_hash: schema_hash(tool)?,
    })
}

fn cap_text(mut text: String) -> (String, bool) {
    if text.len() <= MAX_RESULT_BYTES {
        return (text, false);
    }
    let mut at = MAX_RESULT_BYTES;
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    text.truncate(at);
    text.push_str("\n\n[Tool result truncated by VTerminal at 64 KiB]");
    (text, true)
}

fn normalize_result(result: rmcp::model::CallToolResult) -> Result<McpToolResultView, String> {
    let content = result
        .content
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut parts = Vec::new();
    for block in &content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            Some("resource") => {
                if let Some(text) = block.pointer("/resource/text").and_then(Value::as_str) {
                    let uri = block
                        .pointer("/resource/uri")
                        .and_then(Value::as_str)
                        .unwrap_or("resource");
                    parts.push(format!("[{uri}]\n{text}"));
                } else {
                    parts.push("[MCP embedded binary resource; see the result card]".into());
                }
            }
            Some("resource_link") => {
                let uri = block
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown URI");
                parts.push(format!("[MCP resource link: {uri}]"));
            }
            Some("image") => parts.push("[MCP image result; see the result card]".into()),
            Some("audio") => parts.push("[MCP audio result; see the result card]".into()),
            _ => parts.push("[MCP result content; see the result card]".into()),
        }
    }
    if let Some(structured) = &result.structured_content {
        parts.push(
            serde_json::to_string_pretty(structured).unwrap_or_else(|_| structured.to_string()),
        );
    }
    let (model_text, truncated) = cap_text(parts.join("\n\n"));
    Ok(McpToolResultView {
        content,
        structured_content: result.structured_content,
        is_error: result.is_error.unwrap_or(false),
        model_text,
        truncated,
    })
}

pub fn grant_matches(
    grants: &[McpToolGrant],
    config: &McpServerConfig,
    tool: &McpToolView,
) -> bool {
    grants.iter().any(|grant| {
        grant.server_id == config.id
            && grant.tool_name == tool.name
            && grant.revision == config.revision
            && grant.schema_hash == tool.schema_hash
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_are_server_scoped_and_provider_safe() {
        assert_eq!(
            alias("01234567-aaaa-bbbb-cccc-0123456789ab", "git.commit-all"),
            "mcp__01234567__git_commit_all__ae782cc4"
        );
        assert_ne!(
            alias("01234567-aaaa-bbbb-cccc-0123456789ab", "git.commit"),
            alias("01234567-aaaa-bbbb-cccc-0123456789ab", "git-commit")
        );
        assert_eq!(
            alias(
                "01234567-aaaa-bbbb-cccc-0123456789ab",
                &"tool".repeat(1_000)
            )
            .len(),
            MAX_TOOL_ALIAS_BYTES
        );
    }

    #[test]
    fn stderr_lines_are_bounded_even_without_newlines() {
        let mut line = BoundedStderrLine::default();
        assert!(line.push(&vec![b'x'; MAX_STDERR_LINE_BYTES * 4]).is_empty());
        let (bytes, truncated) = line.finish().unwrap();
        assert_eq!(bytes.len(), MAX_STDERR_LINE_BYTES);
        assert!(truncated);
    }

    #[test]
    fn invalid_header_annotations_are_rejected_per_tool() {
        assert!(validate_x_mcp_headers(&serde_json::json!({
            "type": "object",
            "properties": {"secret": {"type": "object", "x-mcp-header": "Region"}}
        }))
        .is_err());
    }

    #[test]
    fn result_text_is_bounded() {
        let (text, truncated) = cap_text("x".repeat(MAX_RESULT_BYTES + 1));
        assert!(truncated);
        assert!(text.contains("truncated"));
    }
}
