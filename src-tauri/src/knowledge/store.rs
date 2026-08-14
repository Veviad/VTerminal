//! Persistent Qdrant connection configuration and its last successful discovery.
//!
//! Credentials live in macOS Keychain. The serializable connection record cannot
//! contain a key, so list/refresh IPC paths cannot leak one by accidentally
//! returning the stored object wholesale.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::Wry;
use tauri_plugin_store::StoreExt;
use url::{Host, Url};

use crate::commands::settings::STORE_NAME;

const CONNECTIONS_KEY: &str = "knowledge_qdrant_connections";
const MAX_CONNECTIONS: usize = 64;
const MAX_LABEL_CHARS: usize = 64;
const MAX_CACHED_COLLECTIONS: usize = 2_000;

/// Serializes metadata/key snapshots inside this process. In particular, a
/// request holding an old connection record can never pick up a replacement key
/// after that connection has moved to another origin.
static CONNECTION_CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QdrantConnectionRecord {
    pub id: String,
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub allow_insecure: bool,
    #[serde(default = "unchecked")]
    pub status: String,
    #[serde(default)]
    pub server_version: Option<String>,
    #[serde(default)]
    pub last_checked_at: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
    /// Serialized unified bucket descriptors from the last successful scan.
    /// Values keep this storage layer independent from the evolving wire view.
    #[serde(default)]
    pub collections: Vec<Value>,
}

fn unchecked() -> String {
    "unchecked".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct QdrantConnectionInput {
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub allow_insecure: bool,
}

impl QdrantConnectionInput {
    pub fn validate(mut self) -> Result<Self, String> {
        self.label = self.label.trim().to_owned();
        self.url = self.url.trim().trim_end_matches('/').to_owned();
        if self.label.is_empty() {
            return Err("a connection name is required".into());
        }
        if self.label.chars().count() > MAX_LABEL_CHARS {
            return Err(format!(
                "the connection name is too long (max {MAX_LABEL_CHARS} characters)"
            ));
        }
        if self.label.chars().any(char::is_control) || self.url.chars().any(char::is_control) {
            return Err("connection fields cannot contain control characters".into());
        }
        let parsed = Url::parse(&self.url).map_err(|_| "enter a valid Qdrant cluster URL")?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err("Qdrant URLs must use http or https".into());
        }
        if parsed.username() != "" || parsed.password().is_some() {
            return Err("put credentials in the Database API Key field, not the URL".into());
        }
        if parsed.query().is_some() || parsed.fragment().is_some() {
            return Err("a Qdrant cluster URL cannot contain a query or fragment".into());
        }
        let host = parsed
            .host()
            .ok_or_else(|| "the Qdrant URL needs a host".to_string())?;
        if parsed.scheme() == "http" && !is_loopback(host) && !self.allow_insecure {
            return Err(
                "an API key over non-loopback HTTP is blocked; use HTTPS or explicitly allow insecure HTTP under Advanced"
                    .into(),
            );
        }
        Ok(self)
    }
}

fn is_loopback(host: Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

pub fn read_connections(app: &tauri::AppHandle<Wry>) -> Vec<QdrantConnectionRecord> {
    let _guard = CONNECTION_CREDENTIAL_LOCK.lock().ok();
    read_connections_unlocked(app)
}

fn read_connections_unlocked(app: &tauri::AppHandle<Wry>) -> Vec<QdrantConnectionRecord> {
    app.store(STORE_NAME)
        .ok()
        .and_then(|store| store.get(CONNECTIONS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn write_connections_unlocked(
    app: &tauri::AppHandle<Wry>,
    connections: &[QdrantConnectionRecord],
) -> Result<(), String> {
    if connections.len() > MAX_CONNECTIONS {
        return Err(format!(
            "at most {MAX_CONNECTIONS} Qdrant connections are supported"
        ));
    }
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    let previous = store.get(CONNECTIONS_KEY);
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| error.to_string())?,
    );
    if let Err(error) = store.save() {
        match previous {
            Some(value) => store.set(CONNECTIONS_KEY, value),
            None => {
                store.delete(CONNECTIONS_KEY);
            }
        }
        if store.save().is_err() {
            return Err("Qdrant connection storage failed and could not be restored".into());
        }
        return Err(error.to_string());
    }
    Ok(())
}

pub fn create_connection(
    app: &tauri::AppHandle<Wry>,
    record: QdrantConnectionRecord,
    api_key: Option<&str>,
) -> Result<(), String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let mut connections = read_connections_unlocked(app);
    if connections.iter().any(|current| current.id == record.id) {
        return Err("a Qdrant connection with this id already exists".into());
    }
    if connections.len() >= MAX_CONNECTIONS {
        return Err(format!(
            "at most {MAX_CONNECTIONS} Qdrant connections are supported"
        ));
    }
    let credential = crate::credentials::qdrant_id(&record.id, &record.url)?;
    let credentials = crate::credentials::state(app);
    if let Some(key) = api_key {
        credentials.set_or_clear(&credential, key.to_owned())?;
    }
    connections.push(record);
    if let Err(error) = write_connections_unlocked(app, &connections) {
        if api_key.is_some() {
            credentials.delete(&credential)?;
        }
        return Err(error);
    }
    Ok(())
}

pub fn update_connection(
    app: &tauri::AppHandle<Wry>,
    id: &str,
    input: QdrantConnectionInput,
    api_key: Option<&str>,
) -> Result<(QdrantConnectionRecord, QdrantConnectionRecord), String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let mut connections = read_connections_unlocked(app);
    let at = connections
        .iter()
        .position(|connection| connection.id == id)
        .ok_or_else(|| "no such Qdrant connection".to_string())?;
    let old = connections[at].clone();
    let old_id = crate::credentials::qdrant_id(id, &old.url)?;
    let mut new = old.clone();
    update_record(&mut new, input);
    let new_id = crate::credentials::qdrant_id(id, &new.url)?;
    let credentials = crate::credentials::state(app);
    if old_id != new_id && api_key.is_none() {
        return Err("changing the Qdrant origin requires a replacement key; pass an empty key explicitly if the new endpoint needs none".into());
    }
    let previous_new_key = if api_key.is_some() {
        credentials.get(&new_id)?
    } else {
        None
    };
    if let Some(key) = api_key {
        credentials.set_or_clear(&new_id, key.to_owned())?;
    }
    connections[at] = new.clone();
    if let Err(error) = write_connections_unlocked(app, &connections) {
        if api_key.is_some() {
            match previous_new_key {
                Some(secret) => credentials.set_or_clear(&new_id, secret.expose().to_owned())?,
                None => credentials.delete(&new_id)?,
            }
        }
        return Err(error);
    }
    if old_id != new_id {
        credentials.delete(&old_id)?;
    }
    Ok((old, new))
}

pub fn delete_connection(
    app: &tauri::AppHandle<Wry>,
    id: &str,
) -> Result<QdrantConnectionRecord, String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let mut connections = read_connections_unlocked(app);
    let at = connections
        .iter()
        .position(|connection| connection.id == id)
        .ok_or_else(|| "no such Qdrant connection".to_string())?;
    let removed = connections[at].clone();
    let credential = crate::credentials::qdrant_id(id, &removed.url)?;
    let credentials = crate::credentials::state(app);
    let previous_key = credentials.get(&credential)?;
    credentials.delete(&credential)?;
    connections.remove(at);
    if let Err(error) = write_connections_unlocked(app, &connections) {
        if let Some(secret) = previous_key {
            credentials.set_or_clear(&credential, secret.expose().to_owned())?;
        }
        return Err(error);
    }
    Ok(removed)
}

pub fn find_connection<'a>(
    connections: &'a [QdrantConnectionRecord],
    id: &str,
) -> Result<&'a QdrantConnectionRecord, String> {
    connections
        .iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| "no such Qdrant connection".to_string())
}

pub fn new_record(id: String, input: QdrantConnectionInput) -> QdrantConnectionRecord {
    QdrantConnectionRecord {
        id,
        label: input.label,
        url: input.url,
        allow_insecure: input.allow_insecure,
        status: unchecked(),
        server_version: None,
        last_checked_at: None,
        error: None,
        collections: Vec::new(),
    }
}

pub fn update_record(record: &mut QdrantConnectionRecord, input: QdrantConnectionInput) {
    let endpoint_changed = record.url != input.url || record.allow_insecure != input.allow_insecure;
    record.label = input.label;
    record.url = input.url;
    record.allow_insecure = input.allow_insecure;
    if endpoint_changed {
        record.status = "stale".into();
        record.server_version = None;
        record.last_checked_at = None;
        record.error = None;
        record.collections.clear();
    }
}

pub fn set_discovery(
    record: &mut QdrantConnectionRecord,
    server_version: String,
    collections: Vec<Value>,
    checked_at: i64,
) {
    record.status = "connected".into();
    record.server_version = Some(server_version);
    record.last_checked_at = Some(checked_at);
    record.error = None;
    record.collections = collections
        .into_iter()
        .take(MAX_CACHED_COLLECTIONS)
        .collect();
}

/// A failed refresh preserves last-known collections and labels them stale.
pub fn set_discovery_error(record: &mut QdrantConnectionRecord, error: String, checked_at: i64) {
    record.status = if record.collections.is_empty() {
        "error".into()
    } else {
        "stale".into()
    };
    record.last_checked_at = Some(checked_at);
    record.error = Some(error);
}

pub fn read_api_key(
    app: &tauri::AppHandle<Wry>,
    connection: &QdrantConnectionRecord,
) -> Result<Option<crate::credentials::Secret>, String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let current = read_connections_unlocked(app)
        .into_iter()
        .find(|candidate| candidate.id == connection.id)
        .ok_or_else(|| "the Qdrant connection no longer exists".to_string())?;
    if current.url != connection.url || current.allow_insecure != connection.allow_insecure {
        return Err("the Qdrant connection changed; retry the operation".into());
    }
    let id = crate::credentials::qdrant_id(&connection.id, &connection.url)?;
    crate::credentials::state(app).get(&id)
}

pub fn has_api_key(app: &tauri::AppHandle<Wry>, id: &str) -> Result<bool, String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let connection = read_connections_unlocked(app)
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| "the Qdrant connection no longer exists".to_string())?;
    has_api_key_for(app, &connection)
}

/// Presence check for a connection record already read by the caller. This
/// avoids re-reading the whole settings collection for every row in list views.
pub fn has_api_key_for(
    app: &tauri::AppHandle<Wry>,
    connection: &QdrantConnectionRecord,
) -> Result<bool, String> {
    let credential = crate::credentials::qdrant_id(&connection.id, &connection.url)?;
    crate::credentials::state(app).has(&credential)
}

/// Empty clears. The key is never returned by any serializable view.
pub fn write_api_key(app: &tauri::AppHandle<Wry>, id: &str, api_key: &str) -> Result<(), String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let connection = read_connections_unlocked(app)
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| "the Qdrant connection no longer exists".to_string())?;
    let credential = crate::credentials::qdrant_id(id, &connection.url)?;
    crate::credentials::state(app).set_or_clear(&credential, api_key.to_owned())
}

/// Compare-and-swap one connection record after an async Qdrant operation.
/// Callers mutate only discovery/cache fields. If the endpoint changed while the
/// request was in flight, the stale result is rejected rather than restoring an
/// old URL or overwriting unrelated connection edits.
pub fn update_connection_if_current(
    app: &tauri::AppHandle<Wry>,
    snapshot: &QdrantConnectionRecord,
    mutate: impl FnOnce(&mut QdrantConnectionRecord) -> Result<(), String>,
) -> Result<QdrantConnectionRecord, String> {
    let _guard = CONNECTION_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Qdrant connection store is unavailable".to_string())?;
    let mut connections = read_connections_unlocked(app);
    let current = connections
        .iter_mut()
        .find(|connection| connection.id == snapshot.id)
        .ok_or_else(|| "the Qdrant connection no longer exists".to_string())?;
    if current.url != snapshot.url || current.allow_insecure != snapshot.allow_insecure {
        return Err(
            "the Qdrant connection changed while the operation was running; retry it".into(),
        );
    }
    mutate(current)?;
    let result = current.clone();
    write_connections_unlocked(app, &connections)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(url: &str, allow_insecure: bool) -> QdrantConnectionInput {
        QdrantConnectionInput {
            label: "  Production  ".into(),
            url: url.into(),
            allow_insecure,
        }
    }

    #[test]
    fn validation_normalizes_and_protects_api_keys() {
        let validated = input(" https://cluster.example.com/ ", false)
            .validate()
            .unwrap();
        assert_eq!(validated.label, "Production");
        assert_eq!(validated.url, "https://cluster.example.com");
        assert!(input("http://localhost:6333", false).validate().is_ok());
        assert!(input("http://10.0.0.1:6333", false).validate().is_err());
        assert!(input("http://10.0.0.1:6333", true).validate().is_ok());
        assert!(input("https://user:secret@example.com", false)
            .validate()
            .is_err());
    }

    #[test]
    fn refresh_failure_keeps_cached_collections() {
        let mut record = new_record(
            "id".into(),
            input("https://x.example", false).validate().unwrap(),
        );
        record.collections = vec![serde_json::json!({"name":"manuals"})];
        set_discovery_error(&mut record, "timed out".into(), 12);
        assert_eq!(record.status, "stale");
        assert_eq!(record.collections.len(), 1);
    }
}
