use std::collections::{BTreeMap, BTreeSet};

use http::header::HeaderName;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Wry;
use tauri_plugin_store::StoreExt;

use crate::commands::settings::STORE_NAME;

pub const SERVERS_KEY: &str = "mcp_servers_v1";
pub const GRANTS_KEY: &str = "mcp_tool_grants_v1";
pub const MAX_SERVERS: usize = 64;
const MAX_NAME_CHARS: usize = 64;
const MAX_ARGS: usize = 128;
const MAX_ENV: usize = 128;
const MAX_HEADERS: usize = 64;
const MAX_PATHS: usize = 128;
const MAX_DOMAINS: usize = 128;

fn default_true() -> bool {
    true
}

fn default_version() -> u32 {
    1
}

fn default_startup_timeout() -> u64 {
    10_000
}

fn default_list_timeout() -> u64 {
    30_000
}

fn default_call_timeout() -> u64 {
    60_000
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpAuthMode {
    None,
    OAuth,
    Bearer,
    Headers,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpHttpAuth {
    pub mode: McpAuthMode,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub callback_port: Option<u16>,
}

impl Default for McpHttpAuth {
    fn default() -> Self {
        Self {
            mode: McpAuthMode::None,
            scopes: Vec::new(),
            client_id: None,
            callback_port: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpHeaderConfig {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpEnvConfig {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct McpSandboxPolicy {
    #[serde(default)]
    pub allow_read: Vec<String>,
    #[serde(default)]
    pub allow_write: Vec<String>,
    #[serde(default)]
    pub allowed_domains: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpTransportConfig {
    StreamableHttp {
        url: String,
        #[serde(default)]
        auth: McpHttpAuth,
        #[serde(default)]
        headers: Vec<McpHeaderConfig>,
    },
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: Vec<McpEnvConfig>,
        #[serde(default)]
        sandbox: McpSandboxPolicy,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpTimeouts {
    #[serde(default = "default_startup_timeout")]
    pub startup_ms: u64,
    #[serde(default = "default_list_timeout")]
    pub list_ms: u64,
    #[serde(default = "default_call_timeout")]
    pub call_ms: u64,
}

impl Default for McpTimeouts {
    fn default() -> Self {
        Self {
            startup_ms: default_startup_timeout(),
            list_ms: default_list_timeout(),
            call_ms: default_call_timeout(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpServerConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub default_for_new_chats: bool,
    #[serde(default = "default_version")]
    pub revision: u32,
    pub transport: McpTransportConfig,
    #[serde(default)]
    pub timeouts: McpTimeouts,
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    #[serde(default)]
    pub trust_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct McpToolGrant {
    pub server_id: String,
    pub tool_name: String,
    pub revision: u32,
    pub schema_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct McpChatSelection {
    #[serde(default)]
    pub server_ids: Vec<String>,
    #[serde(default)]
    pub disabled_tools: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct McpSecretInput {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn clean_string_list(values: &mut Vec<String>, max: usize, label: &str) -> Result<(), String> {
    if values.len() > max {
        return Err(format!("too many {label} (max {max})"));
    }
    let mut seen = BTreeSet::new();
    let mut clean = Vec::new();
    for value in values.drain(..) {
        let value = value.trim().to_owned();
        if value.is_empty() || has_control(&value) {
            return Err(format!(
                "{label} cannot be empty or contain control characters"
            ));
        }
        if seen.insert(value.clone()) {
            clean.push(value);
        }
    }
    *values = clean;
    Ok(())
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn forbidden_ip(host: &str) -> bool {
    host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_link_local() || v4.is_broadcast() || v4.is_unspecified() || v4.is_multicast()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_unicast_link_local() || v6.is_unspecified() || v6.is_multicast()
        }
    })
}

pub async fn validate_resolved_http_target(endpoint: &str) -> Result<(), String> {
    let parsed = url::Url::parse(endpoint).map_err(|_| "MCP URL is invalid")?;
    let host = parsed.host_str().ok_or("MCP URL needs a host")?;
    let port = parsed
        .port_or_known_default()
        .ok_or("MCP URL needs a port")?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("MCP host could not be resolved: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("MCP host did not resolve to an address".into());
    }
    if addresses
        .iter()
        .any(|address| forbidden_ip(&address.ip().to_string()))
    {
        return Err(
            "MCP host resolves to a blocked link-local, metadata, or special-use address".into(),
        );
    }
    Ok(())
}

pub fn normalized_http_origin(endpoint: &str) -> Result<String, String> {
    let parsed = url::Url::parse(endpoint).map_err(|_| "MCP URL is invalid")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("MCP URL must use http or https".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("MCP URL cannot contain credentials or a fragment".into());
    }
    let host = parsed.host_str().ok_or("MCP URL needs a host")?;
    if forbidden_ip(host)
        || host == "169.254.169.254"
        || host.eq_ignore_ascii_case("metadata.google.internal")
    {
        return Err("link-local and cloud metadata endpoints are blocked".into());
    }
    if parsed.scheme() != "https" && !is_loopback(host) {
        return Err("remote MCP servers require HTTPS; HTTP is allowed only for loopback".into());
    }
    let port = parsed
        .port_or_known_default()
        .ok_or("MCP URL needs a port")?;
    Ok(format!(
        "{}://{}:{port}",
        parsed.scheme(),
        host.to_ascii_lowercase()
    ))
}

fn validate_docker(args: &[String]) -> Result<(), String> {
    let joined = args.join(" ").to_ascii_lowercase();
    let forbidden = [
        "--privileged",
        "--network=host",
        "--network host",
        "--pid=host",
        "--pid host",
        "--ipc=host",
        "--ipc host",
        "--uts=host",
        "--uts host",
        "--userns=host",
        "--userns host",
        "--cgroupns=host",
        "--cgroupns host",
        "/var/run/docker.sock",
        "//./pipe/docker_engine",
    ];
    if forbidden.iter().any(|flag| joined.contains(flag)) {
        return Err("Docker MCP configuration requests a privileged host boundary".into());
    }
    let no_network = joined.contains("--network=none")
        || joined.contains("--network none")
        || joined.contains("--net=none")
        || joined.contains("--net none");
    if !no_network {
        return Err("Docker MCP servers must use --network=none in v0.4.0".into());
    }
    Ok(())
}

pub fn validate(config: &mut McpServerConfig, creating: bool) -> Result<(), String> {
    if config.version != 1 {
        return Err("unsupported MCP configuration version".into());
    }
    if creating {
        if config.id.trim().is_empty() {
            config.id = uuid::Uuid::new_v4().to_string();
        }
        config.revision = 1;
    }
    uuid::Uuid::parse_str(&config.id).map_err(|_| "MCP server id must be a UUID")?;
    config.name = config.name.trim().to_owned();
    if config.name.is_empty()
        || config.name.chars().count() > MAX_NAME_CHARS
        || has_control(&config.name)
    {
        return Err(format!(
            "MCP server name must be 1-{MAX_NAME_CHARS} printable characters"
        ));
    }
    config.timeouts.startup_ms = config.timeouts.startup_ms.clamp(1_000, 120_000);
    config.timeouts.list_ms = config.timeouts.list_ms.clamp(1_000, 120_000);
    config.timeouts.call_ms = config.timeouts.call_ms.clamp(1_000, 600_000);
    clean_string_list(&mut config.disabled_tools, 1024, "disabled tools")?;

    match &mut config.transport {
        McpTransportConfig::StreamableHttp { url, auth, headers } => {
            *url = url.trim().to_owned();
            normalized_http_origin(url)?;
            clean_string_list(&mut auth.scopes, 128, "OAuth scopes")?;
            if headers.len() > MAX_HEADERS {
                return Err(format!("too many HTTP headers (max {MAX_HEADERS})"));
            }
            let mut names = BTreeSet::new();
            for header in headers {
                header.name = header.name.trim().to_ascii_lowercase();
                HeaderName::from_bytes(header.name.as_bytes())
                    .map_err(|_| "invalid HTTP header name")?;
                if matches!(
                    header.name.as_str(),
                    "authorization"
                        | "host"
                        | "content-length"
                        | "mcp-session-id"
                        | "mcp-protocol-version"
                ) {
                    return Err(format!(
                        "{} is managed by VTerminal and cannot be overridden",
                        header.name
                    ));
                }
                if !names.insert(header.name.clone()) {
                    return Err("duplicate HTTP header name".into());
                }
            }
        }
        McpTransportConfig::Stdio {
            command,
            args,
            cwd,
            env,
            sandbox,
        } => {
            *command = command.trim().to_owned();
            if command.is_empty() || has_control(command) {
                return Err(
                    "stdio command is required and cannot contain control characters".into(),
                );
            }
            if args.len() > MAX_ARGS || args.iter().any(|value| value.contains('\0')) {
                return Err(format!("stdio arguments are invalid or exceed {MAX_ARGS}"));
            }
            if let Some(value) = cwd {
                *value = value.trim().to_owned();
                if value.is_empty() || has_control(value) {
                    return Err("stdio working directory is invalid".into());
                }
            }
            if env.len() > MAX_ENV {
                return Err(format!("too many environment entries (max {MAX_ENV})"));
            }
            let mut env_names = BTreeSet::new();
            for entry in env {
                entry.name = entry.name.trim().to_owned();
                if entry.name.is_empty()
                    || !entry
                        .name
                        .bytes()
                        .all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
                    || entry.name.as_bytes()[0].is_ascii_digit()
                    || !env_names.insert(entry.name.clone())
                {
                    return Err("environment names must be unique shell identifiers".into());
                }
                if entry.secret {
                    entry.value.clear();
                } else if entry.value.contains('\0') {
                    return Err("environment values cannot contain NUL".into());
                }
            }
            clean_string_list(&mut sandbox.allow_read, MAX_PATHS, "sandbox read paths")?;
            clean_string_list(&mut sandbox.allow_write, MAX_PATHS, "sandbox write paths")?;
            clean_string_list(&mut sandbox.allowed_domains, MAX_DOMAINS, "sandbox domains")?;
            for domain in &mut sandbox.allowed_domains {
                *domain = domain.trim_end_matches('.').to_ascii_lowercase();
                if !domain
                    .bytes()
                    .all(|byte| byte == b'.' || byte == b'-' || byte.is_ascii_alphanumeric())
                {
                    return Err("sandbox domains must be DNS names".into());
                }
            }
            if command
                .rsplit(['/', '\\'])
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("docker"))
            {
                validate_docker(args)?;
            }
        }
    }
    Ok(())
}

pub fn trust_hash(config: &McpServerConfig) -> Result<String, String> {
    // Trust is about code/network authority, not mutable presentation metadata.
    // Renaming a card or toggling its new-chat default must not make the user
    // approve the exact same executable/URL and grants again.
    let bytes = serde_json::to_vec(&serde_json::json!({
        "transport": &config.transport,
    }))
    .map_err(|error| error.to_string())?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub fn is_trusted(config: &McpServerConfig) -> bool {
    trust_hash(config).ok().as_ref() == config.trust_hash.as_ref()
}

pub fn read_servers(app: &tauri::AppHandle<Wry>) -> Vec<McpServerConfig> {
    app.store(STORE_NAME)
        .ok()
        .and_then(|store| store.get(SERVERS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn write_servers(
    app: &tauri::AppHandle<Wry>,
    servers: &[McpServerConfig],
) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    store.set(
        SERVERS_KEY,
        serde_json::to_value(servers).map_err(|error| error.to_string())?,
    );
    store.save().map_err(|error| error.to_string())
}

pub fn read_grants(app: &tauri::AppHandle<Wry>) -> Vec<McpToolGrant> {
    app.store(STORE_NAME)
        .ok()
        .and_then(|store| store.get(GRANTS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn write_grants(app: &tauri::AppHandle<Wry>, grants: &[McpToolGrant]) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    store.set(
        GRANTS_KEY,
        serde_json::to_value(grants).map_err(|error| error.to_string())?,
    );
    store.save().map_err(|error| error.to_string())
}

pub fn find<'a>(servers: &'a [McpServerConfig], id: &str) -> Result<&'a McpServerConfig, String> {
    servers
        .iter()
        .find(|server| server.id == id)
        .ok_or_else(|| "no such MCP server".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(url: &str) -> McpServerConfig {
        McpServerConfig {
            version: 1,
            id: String::new(),
            name: "Test".into(),
            enabled: true,
            default_for_new_chats: false,
            revision: 0,
            transport: McpTransportConfig::StreamableHttp {
                url: url.into(),
                auth: McpHttpAuth::default(),
                headers: Vec::new(),
            },
            timeouts: McpTimeouts::default(),
            disabled_tools: Vec::new(),
            trust_hash: None,
        }
    }

    #[test]
    fn remote_urls_require_https_except_loopback() {
        assert!(validate(&mut http("https://mcp.example.test/api"), true).is_ok());
        assert!(validate(&mut http("http://127.0.0.1:3000/mcp"), true).is_ok());
        assert!(validate(&mut http("http://mcp.example.test/api"), true).is_err());
        assert!(validate(&mut http("http://169.254.169.254/latest"), true).is_err());
    }

    #[test]
    fn docker_host_escape_flags_are_rejected() {
        assert!(validate_docker(&["run".into(), "--privileged".into(), "image".into()]).is_err());
        assert!(validate_docker(&["run".into(), "--network=none".into(), "image".into()]).is_ok());
    }
}
