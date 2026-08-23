use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationRequest, AuthorizationSession, CredentialStore,
    OAuthClientConfig, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use tauri::Wry;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::config::{McpAuthMode, McpServerConfig, McpTransportConfig};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CALLBACK_BYTES: usize = 16 * 1024;

fn auth_error(error: impl ToString) -> AuthError {
    AuthError::InternalError(error.to_string())
}

fn endpoint(config: &McpServerConfig) -> Result<(&str, &super::config::McpHttpAuth), String> {
    match &config.transport {
        McpTransportConfig::StreamableHttp { url, auth, .. } if auth.mode == McpAuthMode::OAuth => {
            Ok((url, auth))
        }
        _ => Err("this MCP server is not configured for OAuth".into()),
    }
}

fn credential_id(
    config: &McpServerConfig,
    slot: &str,
) -> Result<crate::credentials::CredentialId, String> {
    let (url, _) = endpoint(config)?;
    crate::credentials::mcp_id(&config.id, url, slot)
}

fn read_secret(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
    slot: &str,
) -> Result<Option<String>, String> {
    Ok(crate::credentials::state(app)
        .get(&credential_id(config, slot)?)?
        .map(|secret| secret.expose().to_owned()))
}

fn write_secret(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
    slot: &str,
    value: String,
) -> Result<(), String> {
    crate::credentials::state(app).set_or_clear(&credential_id(config, slot)?, value)
}

#[derive(Clone)]
struct VaultCredentialStore {
    app: tauri::AppHandle<Wry>,
    id: crate::credentials::CredentialId,
}

impl VaultCredentialStore {
    fn new(app: &tauri::AppHandle<Wry>, config: &McpServerConfig) -> Result<Self, String> {
        Ok(Self {
            app: app.clone(),
            id: credential_id(config, "oauth_credentials")?,
        })
    }
}

#[async_trait]
impl CredentialStore for VaultCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let value = crate::credentials::state(&self.app)
            .get(&self.id)
            .map_err(auth_error)?;
        value
            .map(|secret| serde_json::from_str(secret.expose()).map_err(auth_error))
            .transpose()
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let json = serde_json::to_string(&credentials).map_err(auth_error)?;
        crate::credentials::state(&self.app)
            .set_or_clear(&self.id, json)
            .map_err(auth_error)
    }

    async fn clear(&self) -> Result<(), AuthError> {
        crate::credentials::state(&self.app)
            .delete(&self.id)
            .map_err(auth_error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Registration {
    client_id: String,
    redirect_uri: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthStartView {
    pub authorization_url: String,
    pub browser_opened: bool,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthConnectionView {
    pub authenticated: bool,
    pub granted_scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OAuthRevokeView {
    pub revoked_remotely: bool,
}

struct PendingOAuth {
    receiver: tokio::sync::oneshot::Receiver<Result<OAuthConnectionView, String>>,
    abort: tokio::task::AbortHandle,
}

#[derive(Default)]
pub struct McpOAuthState {
    pending: Mutex<HashMap<String, PendingOAuth>>,
}

impl McpOAuthState {
    fn replace(&self, id: String, pending: PendingOAuth) -> Result<(), String> {
        let mut map = self.pending.lock().map_err(|_| "OAuth state poisoned")?;
        if let Some(old) = map.insert(id, pending) {
            old.abort.abort();
        }
        Ok(())
    }

    pub async fn finish(&self, id: &str) -> Result<OAuthConnectionView, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "OAuth state poisoned")?
            .remove(id)
            .ok_or("no OAuth authorization is pending for this server")?;
        pending
            .receiver
            .await
            .map_err(|_| "OAuth authorization task ended unexpectedly".to_string())?
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(pending) = pending.remove(id) {
                pending.abort.abort();
            }
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, pending) in pending.drain() {
                pending.abort.abort();
            }
        }
    }
}

async fn discovered_manager(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<(AuthorizationManager, VaultCredentialStore), String> {
    let (url, _) = endpoint(config)?;
    let mut manager = AuthorizationManager::new(url)
        .await
        .map_err(|error| format!("OAuth client setup failed: {error}"))?;
    let store = VaultCredentialStore::new(app, config)?;
    manager.set_credential_store(store.clone());
    let resolution = manager
        .resolve_metadata()
        .await
        .map_err(|error| format!("OAuth metadata discovery failed: {error}"))?;
    if !resolution.source.is_discovered() {
        return Err(
            "the server did not publish OAuth protected-resource or authorization-server metadata"
                .into(),
        );
    }
    manager.set_metadata(resolution.metadata);
    Ok((manager, store))
}

pub async fn start(
    app: &tauri::AppHandle<Wry>,
    state: &McpOAuthState,
    config: &McpServerConfig,
) -> Result<OAuthStartView, String> {
    let (_, auth) = endpoint(config)?;
    let bind_port = auth.callback_port.unwrap_or(0);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, bind_port))
        .await
        .map_err(|error| format!("could not bind OAuth loopback callback: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/mcp/oauth/callback");
    let (manager, store) = discovered_manager(app, config).await?;
    let mut request = AuthorizationRequest::new(&redirect_uri)
        .with_client_name("VTerminal")
        .with_scopes(auth.scopes.clone())
        .with_application_type("native");
    let client_secret = read_secret(app, config, "oauth_client_secret")?;
    if let Some(client_id) = auth.client_id.as_deref() {
        if client_id.starts_with("https://") && client_secret.is_none() {
            request = request.with_client_metadata_url(client_id);
        } else {
            request = request.with_preregistered_client(client_id);
            if let Some(secret) = client_secret {
                request = request.with_client_secret(secret);
            }
        }
    }
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_, error)| format!("OAuth client registration failed: {error}"))?;
    let authorization_url = session.get_authorization_url().to_owned();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let app_for_task = app.clone();
    let config_for_task = config.clone();
    let redirect_for_task = redirect_uri.clone();
    let task = tokio::spawn(async move {
        let result = async {
            let (mut socket, _) = tokio::time::timeout(CALLBACK_TIMEOUT, listener.accept())
                .await
                .map_err(|_| "OAuth callback timed out".to_string())?
                .map_err(|error| format!("OAuth callback failed: {error}"))?;
            let mut request = Vec::new();
            let mut buffer = [0u8; 2048];
            loop {
                let read = socket.read(&mut buffer).await.map_err(|error| error.to_string())?;
                if read == 0 { break; }
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") { break; }
                if request.len() > MAX_CALLBACK_BYTES {
                    return Err("OAuth callback request was too large".into());
                }
            }
            let first = String::from_utf8_lossy(&request)
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned();
            let target = first
                .strip_prefix("GET ")
                .and_then(|line| line.split_whitespace().next())
                .ok_or("OAuth callback was not a GET request")?;
            let callback = url::Url::parse(&format!("http://127.0.0.1:{port}{target}"))
                .map_err(|_| "OAuth callback URL was invalid")?;
            if callback.path() != "/mcp/oauth/callback" {
                return Err("OAuth callback used an unexpected path".into());
            }
            let response = if callback.query_pairs().any(|(key, _)| key == "error") {
                "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<h1>VTerminal authorization was denied</h1><p>You can close this window.</p>"
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<h1>VTerminal is connected</h1><p>You can close this window and return to VTerminal.</p>"
            };
            socket.write_all(response.as_bytes()).await.map_err(|error| error.to_string())?;
            session
                .handle_callback_url(callback.as_str())
                .await
                .map_err(|error| format!("OAuth token exchange failed: {error}"))?;
            let access = session
                .auth_manager
                .get_access_token()
                .await
                .map_err(|error| format!("OAuth token could not be read: {error}"))?;
            write_secret(&app_for_task, &config_for_task, "oauth_access_token", access)?;
            let stored = store.load().await.map_err(|error| error.to_string())?
                .ok_or("OAuth credentials were not persisted")?;
            write_secret(
                &app_for_task,
                &config_for_task,
                "oauth_registration",
                serde_json::to_string(&Registration {
                    client_id: stored.client_id.clone(),
                    redirect_uri: redirect_for_task,
                }).map_err(|error| error.to_string())?,
            )?;
            Ok(OAuthConnectionView {
                authenticated: true,
                granted_scopes: stored.granted_scopes,
            })
        }
        .await;
        let _ = sender.send(result);
    });
    state.replace(
        config.id.clone(),
        PendingOAuth {
            receiver,
            abort: task.abort_handle(),
        },
    )?;
    let browser_opened = app
        .opener()
        .open_url(&authorization_url, None::<&str>)
        .is_ok();
    Ok(OAuthStartView {
        authorization_url,
        browser_opened,
        redirect_uri,
    })
}

pub async fn access_token(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<String, String> {
    let (manager, _) = configured_manager(app, config).await?;
    let token = manager
        .get_access_token()
        .await
        .map_err(|error| format!("OAuth token refresh failed: {error}"))?;
    write_secret(app, config, "oauth_access_token", token.clone())?;
    Ok(token)
}

async fn configured_manager(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<(AuthorizationManager, VaultCredentialStore), String> {
    let (_, auth) = endpoint(config)?;
    let (mut manager, store) = discovered_manager(app, config).await?;
    let stored = store
        .load()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("this MCP server needs OAuth authentication")?;
    let registration = read_secret(app, config, "oauth_registration")?
        .and_then(|raw| serde_json::from_str::<Registration>(&raw).ok());
    let redirect = registration
        .as_ref()
        .map(|registration| registration.redirect_uri.clone())
        .unwrap_or_else(|| "http://127.0.0.1/mcp/oauth/callback".into());
    let client_id = auth
        .client_id
        .clone()
        .or_else(|| registration.map(|registration| registration.client_id))
        .unwrap_or(stored.client_id);
    let mut client = OAuthClientConfig::new(client_id, redirect).with_scopes(auth.scopes.clone());
    if let Some(secret) = read_secret(app, config, "oauth_client_secret")? {
        client = client.with_client_secret(secret);
    }
    manager
        .configure_client(client)
        .map_err(|error| format!("OAuth client configuration failed: {error}"))?;
    Ok((manager, store))
}

pub async fn force_refresh(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<String, String> {
    let (manager, _) = configured_manager(app, config).await?;
    manager
        .refresh_token()
        .await
        .map_err(|error| format!("OAuth refresh was rejected; reconnect this server: {error}"))?;
    let token = manager
        .get_access_token()
        .await
        .map_err(|error| format!("refreshed OAuth token could not be read: {error}"))?;
    write_secret(app, config, "oauth_access_token", token.clone())?;
    Ok(token)
}

pub async fn status(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<OAuthConnectionView, String> {
    let store = VaultCredentialStore::new(app, config)?;
    let stored = store.load().await.map_err(|error| error.to_string())?;
    Ok(OAuthConnectionView {
        authenticated: stored
            .as_ref()
            .and_then(|item| item.token_response.as_ref())
            .is_some(),
        granted_scopes: stored.map(|item| item.granted_scopes).unwrap_or_default(),
    })
}

pub async fn revoke(
    app: &tauri::AppHandle<Wry>,
    config: &McpServerConfig,
) -> Result<OAuthRevokeView, String> {
    let store = VaultCredentialStore::new(app, config)?;
    let stored = store.load().await.map_err(|error| error.to_string())?;
    let mut revoked_remotely = false;
    if let (Some(stored), Ok((manager, _))) = (&stored, discovered_manager(app, config).await) {
        if let Some(token) = &stored.token_response {
            let token_json = serde_json::to_value(token).unwrap_or_default();
            if let Ok(resolution) = manager.resolve_metadata().await {
                if let Some(revoke_url) = resolution
                    .metadata
                    .additional_fields
                    .get("revocation_endpoint")
                    .and_then(serde_json::Value::as_str)
                {
                    let value = token_json
                        .get("refresh_token")
                        .or_else(|| token_json.get("access_token"))
                        .and_then(serde_json::Value::as_str);
                    if let Some(value) = value {
                        let client = reqwest::Client::builder()
                            .redirect(reqwest::redirect::Policy::none())
                            .timeout(Duration::from_secs(15))
                            .build()
                            .map_err(|error| error.to_string())?;
                        let mut form = vec![
                            ("token", value.to_owned()),
                            ("client_id", stored.client_id.clone()),
                        ];
                        if let Some(secret) = read_secret(app, config, "oauth_client_secret")? {
                            form.push(("client_secret", secret));
                        }
                        if let Ok(response) = client.post(revoke_url).form(&form).send().await {
                            revoked_remotely = response.status().is_success();
                        }
                    }
                }
            }
        }
    }
    store.clear().await.map_err(|error| error.to_string())?;
    for slot in [
        "oauth_access_token",
        "oauth_refresh_token",
        "oauth_registration",
    ] {
        crate::credentials::state(app).delete(&credential_id(config, slot)?)?;
    }
    Ok(OAuthRevokeView { revoked_remotely })
}
