//! Typed MCP configuration and runtime commands.
//!
//! Secrets are write-only and live in the OS vault. Server metadata is versioned
//! in the Tauri store. A saved server is still inert until its exact trust hash
//! is confirmed, and stdio additionally needs a healthy sandbox runtime.

use std::collections::{BTreeMap, BTreeSet};

use futures::{stream, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State, Wry};

use crate::mcp::client::{McpManager, McpServerRuntimeView, McpToolResultView, McpToolView};
use crate::mcp::config::{
    self, McpAuthMode, McpSecretInput, McpServerConfig, McpToolGrant, McpTransportConfig,
};

const SETTINGS_CONNECTION_PREFIX: &str = "settings-live";
const AUTO_START_CONCURRENCY: usize = 4;

fn settings_connection_id(server_id: &str) -> String {
    format!("{SETTINGS_CONNECTION_PREFIX}-{server_id}")
}

fn auto_start_servers(servers: Vec<McpServerConfig>) -> Vec<McpServerConfig> {
    servers
        .into_iter()
        .filter(|server| server.enabled && server.auto_start)
        .collect()
}

/// Starts every selected MCP server without delaying the rest of application
/// setup. The normal connection path still enforces trust, credentials, remote
/// target validation, and the local stdio sandbox before a session is retained.
pub fn auto_start_configured_servers(app: &tauri::AppHandle<Wry>) {
    let app = app.clone();
    let servers = auto_start_servers(config::read_servers(&app));
    tauri::async_runtime::spawn(async move {
        stream::iter(servers)
            .for_each_concurrent(AUTO_START_CONCURRENCY, |server| {
                let app = app.clone();
                async move {
                    let manager = app.state::<McpManager>();
                    let connection_id = settings_connection_id(&server.id);
                    if let Err(error) = manager.list_tools(&app, &connection_id, &server).await {
                        let error = crate::credentials::redact_provider_text(&error, None);
                        manager
                            .append_log(&server.id, format!("auto-start failed: {error}"))
                            .await;
                        log::warn!(
                            "MCP auto-start failed for {} ({}): {error}",
                            server.name,
                            server.id
                        );
                    }
                }
            })
            .await;
    });
}

#[derive(Debug, Serialize)]
pub struct McpServerView {
    #[serde(flatten)]
    pub config: McpServerConfig,
    pub trusted: bool,
    pub missing_secret_slots: Vec<String>,
    pub runtime: McpServerRuntimeView,
    pub oauth: Option<crate::mcp::oauth::OAuthConnectionView>,
}

fn boundary(config: &McpServerConfig) -> &str {
    match &config.transport {
        McpTransportConfig::StreamableHttp { url, .. } => url,
        McpTransportConfig::Stdio { .. } => "stdio",
    }
}

fn secret_slots(config: &McpServerConfig) -> Vec<String> {
    match &config.transport {
        McpTransportConfig::StreamableHttp { auth, headers, .. } => {
            let mut slots = headers
                .iter()
                .map(|header| format!("header:{}", header.name))
                .collect::<Vec<_>>();
            match auth.mode {
                McpAuthMode::Bearer => slots.push("bearer".into()),
                McpAuthMode::OAuth => {
                    slots.push("oauth_access_token".into());
                    slots.push("oauth_refresh_token".into());
                    slots.push("oauth_client_secret".into());
                    slots.push("oauth_registration".into());
                    slots.push("oauth_credentials".into());
                }
                McpAuthMode::None | McpAuthMode::Headers => {}
            }
            slots
        }
        McpTransportConfig::Stdio { env, .. } => env
            .iter()
            .filter(|entry| entry.secret)
            .map(|entry| format!("env:{}", entry.name))
            .collect(),
    }
}

fn required_secret_slots(config: &McpServerConfig) -> Vec<String> {
    match &config.transport {
        McpTransportConfig::StreamableHttp { auth, headers, .. } => {
            let mut slots = headers
                .iter()
                .map(|header| format!("header:{}", header.name))
                .collect::<Vec<_>>();
            match auth.mode {
                McpAuthMode::Bearer => slots.push("bearer".into()),
                McpAuthMode::OAuth => slots.push("oauth_credentials".into()),
                McpAuthMode::None | McpAuthMode::Headers => {}
            }
            slots
        }
        McpTransportConfig::Stdio { env, .. } => env
            .iter()
            .filter(|entry| entry.secret)
            .map(|entry| format!("env:{}", entry.name))
            .collect(),
    }
}

fn credential_id(
    config: &McpServerConfig,
    slot: &str,
) -> Result<crate::credentials::CredentialId, String> {
    crate::credentials::mcp_id(&config.id, boundary(config), slot)
}

fn write_secrets(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
    secrets: McpSecretInput,
) -> Result<(), String> {
    let allowed = secret_slots(config).into_iter().collect::<BTreeSet<_>>();
    for (slot, value) in secrets.values {
        let slot = normalize_secret_slot(slot);
        if !allowed.contains(&slot) {
            return Err(format!(
                "secret slot {slot} is not declared by this MCP server"
            ));
        }
        crate::credentials::state(app).set_or_clear(&credential_id(config, &slot)?, value)?;
    }
    Ok(())
}

fn normalize_secret_slot(slot: String) -> String {
    if let Some(name) = slot.strip_prefix("header:") {
        format!("header:{}", name.trim().to_ascii_lowercase())
    } else if let Some(name) = slot.strip_prefix("env:") {
        format!("env:{}", name.trim())
    } else {
        slot
    }
}

fn clear_secrets(app: &tauri::AppHandle<Wry>, config: &McpServerConfig) -> Result<(), String> {
    for slot in secret_slots(config) {
        crate::credentials::state(app).delete(&credential_id(config, &slot)?)?;
    }
    Ok(())
}

fn missing_secrets(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<Vec<String>, String> {
    required_secret_slots(config)
        .into_iter()
        .filter_map(|slot| {
            match crate::credentials::state(app).has(&credential_id(config, &slot).ok()?) {
                Ok(true) => None,
                Ok(false) => Some(Ok(slot)),
                Err(error) => Some(Err(error)),
            }
        })
        .collect()
}

fn find_index(servers: &[McpServerConfig], id: &str) -> Result<usize, String> {
    servers
        .iter()
        .position(|server| server.id == id)
        .ok_or_else(|| "no such MCP server".into())
}

#[tauri::command]
pub async fn mcp_servers_list(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
) -> Result<Vec<McpServerView>, String> {
    let mut views = Vec::new();
    for config in config::read_servers(&app) {
        let oauth = match &config.transport {
            McpTransportConfig::StreamableHttp { auth, .. } if auth.mode == McpAuthMode::OAuth => {
                Some(crate::mcp::oauth::status(&app, &config).await?)
            }
            _ => None,
        };
        views.push(McpServerView {
            trusted: config::is_trusted(&config),
            missing_secret_slots: missing_secrets(&app, &config)?,
            runtime: manager.runtime(&config.id).await,
            oauth,
            config,
        });
    }
    Ok(views)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_servers_upsert(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    server: McpServerConfig,
    secrets: McpSecretInput,
) -> Result<String, String> {
    let mut servers = config::read_servers(&app);
    let creating = server.id.trim().is_empty();
    if creating && servers.len() >= config::MAX_SERVERS {
        return Err(format!(
            "too many MCP servers (max {})",
            config::MAX_SERVERS
        ));
    }
    let mut clean = server;
    config::validate(&mut clean, creating)?;
    if creating {
        if servers
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&clean.name))
        {
            return Err("an MCP server with that name already exists".into());
        }
        write_secrets(&app, &clean, secrets)?;
        clean.trust_hash = None;
        let id = clean.id.clone();
        servers.push(clean);
        if let Err(error) = config::write_servers(&app, &servers) {
            let _ = clear_secrets(&app, servers.last().expect("just pushed"));
            return Err(error);
        }
        return Ok(id);
    }

    let at = find_index(&servers, &clean.id)?;
    if servers
        .iter()
        .enumerate()
        .any(|(index, existing)| index != at && existing.name.eq_ignore_ascii_case(&clean.name))
    {
        return Err("an MCP server with that name already exists".into());
    }
    let old = servers[at].clone();
    clean.id = old.id.clone();
    let runtime_changed = old.transport != clean.transport
        || old.timeouts != clean.timeouts
        || old.disabled_tools != clean.disabled_tools;
    clean.revision = if runtime_changed {
        old.revision.saturating_add(1)
    } else {
        old.revision
    };
    clean.trust_hash = if config::trust_hash(&old)? == config::trust_hash(&clean)? {
        old.trust_hash.clone()
    } else {
        None
    };
    let boundary_changed = boundary(&old) != boundary(&clean);
    let secrets_changed = !secrets.values.is_empty();
    if boundary_changed {
        clear_secrets(&app, &old)?;
    }
    write_secrets(&app, &clean, secrets)?;
    if !boundary_changed {
        let next_slots = secret_slots(&clean).into_iter().collect::<BTreeSet<_>>();
        for removed in secret_slots(&old)
            .into_iter()
            .filter(|slot| !next_slots.contains(slot))
        {
            crate::credentials::state(&app).delete(&credential_id(&old, &removed)?)?;
        }
    }
    servers[at] = clean.clone();
    config::write_servers(&app, &servers)?;
    if runtime_changed || old.enabled != clean.enabled || secrets_changed {
        manager.disconnect_server(&clean.id).await;
    }
    if runtime_changed {
        let mut grants = config::read_grants(&app);
        grants.retain(|grant| grant.server_id != clean.id);
        config::write_grants(&app, &grants)?;
    }
    Ok(clean.id)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_servers_delete(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    id: String,
) -> Result<(), String> {
    let mut servers = config::read_servers(&app);
    let removed = servers.remove(find_index(&servers, &id)?);
    clear_secrets(&app, &removed)?;
    config::write_servers(&app, &servers)?;
    let mut grants = config::read_grants(&app);
    grants.retain(|grant| grant.server_id != id);
    config::write_grants(&app, &grants)?;
    manager.disconnect_server(&id).await;
    app.state::<crate::mcp::oauth::McpOAuthState>().cancel(&id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_start(
    app: tauri::AppHandle<Wry>,
    oauth: State<'_, crate::mcp::oauth::McpOAuthState>,
    id: String,
) -> Result<crate::mcp::oauth::OAuthStartView, String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &id)?.clone();
    if !server.enabled {
        return Err("MCP server is disabled".into());
    }
    if !config::is_trusted(&server) {
        return Err("review and trust this MCP server before starting OAuth".into());
    }
    crate::mcp::oauth::start(&app, &oauth, &server).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_finish(
    oauth: State<'_, crate::mcp::oauth::McpOAuthState>,
    id: String,
) -> Result<crate::mcp::oauth::OAuthConnectionView, String> {
    oauth.finish(&id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_revoke(
    app: tauri::AppHandle<Wry>,
    oauth: State<'_, crate::mcp::oauth::McpOAuthState>,
    manager: State<'_, McpManager>,
    id: String,
) -> Result<crate::mcp::oauth::OAuthRevokeView, String> {
    oauth.cancel(&id);
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &id)?.clone();
    manager.disconnect_server(&id).await;
    crate::mcp::oauth::revoke(&app, &server).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_servers_set_secret(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    id: String,
    slot: String,
    value: String,
) -> Result<(), String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &id)?;
    let slot = normalize_secret_slot(slot);
    if !secret_slots(server).contains(&slot) {
        return Err("secret slot is not declared by this MCP server".into());
    }
    crate::credentials::state(&app).set_or_clear(&credential_id(server, &slot)?, value)?;
    manager.disconnect_server(&id).await;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn mcp_servers_trust(app: tauri::AppHandle<Wry>, id: String) -> Result<(), String> {
    let mut servers = config::read_servers(&app);
    let at = find_index(&servers, &id)?;
    servers[at].trust_hash = Some(config::trust_hash(&servers[at])?);
    config::write_servers(&app, &servers)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_servers_test(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    id: String,
) -> Result<Vec<McpToolView>, String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &id)?.clone();
    let conversation = format!("settings-test-{}", uuid::Uuid::new_v4());
    let result = manager.list_tools(&app, &conversation, &server).await;
    manager.disconnect(&conversation, None).await;
    result
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_server_connect(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    id: String,
) -> Result<Vec<McpToolView>, String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &id)?.clone();
    manager
        .list_tools(&app, &settings_connection_id(&id), &server)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_server_disconnect(
    manager: State<'_, McpManager>,
    id: String,
) -> Result<(), String> {
    manager.disconnect_server(&id).await;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_tools_list(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    conversation_id: String,
    server_ids: Vec<String>,
) -> Result<Vec<McpToolView>, String> {
    let servers = config::read_servers(&app);
    let mut tools = Vec::new();
    for id in server_ids {
        let server = config::find(&servers, &id)?;
        tools.extend(manager.list_tools(&app, &conversation_id, server).await?);
    }
    Ok(tools)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_tools_refresh(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    conversation_id: String,
    server_id: String,
) -> Result<Vec<McpToolView>, String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &server_id)?.clone();
    manager.refresh_tools(&conversation_id, &server_id).await;
    manager.list_tools(&app, &conversation_id, &server).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_tools_call(
    app: tauri::AppHandle<Wry>,
    manager: State<'_, McpManager>,
    conversation_id: String,
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<McpToolResultView, String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &server_id)?.clone();
    manager
        .call_tool(&app, &conversation_id, &server, &tool_name, arguments)
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_disconnect(
    manager: State<'_, McpManager>,
    conversation_id: String,
    server_id: Option<String>,
) -> Result<(), String> {
    manager
        .disconnect(&conversation_id, server_id.as_deref())
        .await;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_logs(manager: State<'_, McpManager>, server_id: String) -> Result<String, String> {
    Ok(manager.logs(&server_id).await)
}

#[tauri::command]
pub async fn mcp_sandbox_status(
    app: tauri::AppHandle<Wry>,
) -> Result<crate::mcp::sandbox::SandboxStatus, String> {
    Ok(crate::mcp::sandbox::status(&app).await)
}

#[tauri::command]
pub fn mcp_default_server_ids(app: tauri::AppHandle<Wry>) -> Result<Vec<String>, String> {
    Ok(config::read_servers(&app)
        .into_iter()
        .filter(|server| server.enabled && server.default_for_new_chats)
        .map(|server| server.id)
        .collect())
}

#[tauri::command(rename_all = "snake_case")]
pub fn mcp_remember_tool(app: tauri::AppHandle<Wry>, grant: McpToolGrant) -> Result<(), String> {
    let servers = config::read_servers(&app);
    let server = config::find(&servers, &grant.server_id)?;
    if grant.revision != server.revision
        || grant.tool_name.is_empty()
        || grant.schema_hash.len() != 64
    {
        return Err("stale or invalid MCP tool approval".into());
    }
    let mut grants = config::read_grants(&app);
    grants.retain(|existing| {
        existing.server_id != grant.server_id || existing.tool_name != grant.tool_name
    });
    grants.push(grant);
    config::write_grants(&app, &grants)
}

#[tauri::command(rename_all = "snake_case")]
pub fn respond_to_mcp_approval(
    approvals: State<'_, crate::mcp::approval::McpApprovalState>,
    approval_id: String,
    decision: crate::mcp::approval::McpApprovalDecision,
) -> Result<(), String> {
    approvals.respond(&approval_id, decision)
}

#[tauri::command(rename_all = "snake_case")]
pub fn mcp_forget_approvals(
    app: tauri::AppHandle<Wry>,
    server_id: Option<String>,
) -> Result<(), String> {
    let mut grants = config::read_grants(&app);
    if let Some(server_id) = server_id {
        grants.retain(|grant| grant.server_id != server_id);
    } else {
        grants.clear();
    }
    config::write_grants(&app, &grants)
}

#[tauri::command]
pub fn mcp_export_redacted(app: tauri::AppHandle<Wry>) -> Result<Value, String> {
    let servers = config::read_servers(&app);
    let map = servers
        .into_iter()
        .map(|server| {
            (
                server.name.clone(),
                serde_json::to_value(server).unwrap_or(Value::Null),
            )
        })
        .collect::<BTreeMap<_, _>>();
    Ok(serde_json::json!({"mcpServers": map, "secrets": "[REDACTED]"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_only_requires_an_access_token_to_connect() {
        let mut server = McpServerConfig {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            name: "oauth".into(),
            enabled: true,
            auto_start: false,
            default_for_new_chats: false,
            revision: 1,
            transport: McpTransportConfig::StreamableHttp {
                url: "https://example.test/mcp".into(),
                auth: crate::mcp::config::McpHttpAuth {
                    mode: McpAuthMode::OAuth,
                    ..Default::default()
                },
                headers: vec![],
            },
            timeouts: Default::default(),
            disabled_tools: vec![],
            trust_hash: None,
        };
        config::validate(&mut server, false).unwrap();
        assert_eq!(required_secret_slots(&server), vec!["oauth_credentials"]);
    }

    #[test]
    fn auto_start_only_selects_enabled_opted_in_servers() {
        let selected = McpServerConfig {
            version: 1,
            id: "selected".into(),
            name: "selected".into(),
            enabled: true,
            auto_start: true,
            default_for_new_chats: false,
            revision: 1,
            transport: McpTransportConfig::StreamableHttp {
                url: "https://example.test/mcp".into(),
                auth: Default::default(),
                headers: vec![],
            },
            timeouts: Default::default(),
            disabled_tools: vec![],
            trust_hash: None,
        };
        let mut disabled = selected.clone();
        disabled.id = "disabled".into();
        disabled.enabled = false;
        let mut manual = selected.clone();
        manual.id = "manual".into();
        manual.auto_start = false;
        let mut local = selected.clone();
        local.id = "local".into();
        local.transport = McpTransportConfig::Stdio {
            command: "mcp-server".into(),
            args: vec![],
            cwd: None,
            env: vec![],
            sandbox: Default::default(),
        };

        let ids = auto_start_servers(vec![manual, disabled, selected, local])
            .into_iter()
            .map(|server| server.id)
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["selected", "local"]);
    }
}
