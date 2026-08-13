//! Persistent Qdrant connection configuration and its last successful discovery.
//!
//! Credentials deliberately live in a sibling map.  The serializable connection
//! record cannot contain a key, so list/refresh IPC paths cannot leak one by
//! accidentally returning the stored object wholesale.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::Wry;
use tauri_plugin_store::StoreExt;
use url::{Host, Url};

use crate::commands::settings::STORE_NAME;

const CONNECTIONS_KEY: &str = "knowledge_qdrant_connections";
const KEYS_KEY: &str = "knowledge_qdrant_api_keys";
const MAX_CONNECTIONS: usize = 64;
const MAX_LABEL_CHARS: usize = 64;
const MAX_CACHED_COLLECTIONS: usize = 2_000;

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
    app.store(STORE_NAME)
        .ok()
        .and_then(|store| store.get(CONNECTIONS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn write_connections(
    app: &tauri::AppHandle<Wry>,
    connections: &[QdrantConnectionRecord],
) -> Result<(), String> {
    if connections.len() > MAX_CONNECTIONS {
        return Err(format!(
            "at most {MAX_CONNECTIONS} Qdrant connections are supported"
        ));
    }
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| error.to_string())?,
    );
    store.save().map_err(|error| error.to_string())
}

/// Persist connection metadata and an optional key mutation in one store save.
/// This prevents a changed origin from ever being paired with the previous
/// origin's credential between two IPC operations.
pub fn write_connections_and_api_key(
    app: &tauri::AppHandle<Wry>,
    connections: &[QdrantConnectionRecord],
    id: &str,
    api_key: Option<&str>,
) -> Result<(), String> {
    if connections.len() > MAX_CONNECTIONS {
        return Err(format!(
            "at most {MAX_CONNECTIONS} Qdrant connections are supported"
        ));
    }
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    let mut keys = read_keys(app);
    if let Some(key) = api_key {
        if key.trim().is_empty() {
            keys.remove(id);
        } else {
            keys.insert(id.to_owned(), key.to_owned());
        }
    }
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| error.to_string())?,
    );
    store.set(
        KEYS_KEY,
        serde_json::to_value(keys).map_err(|error| error.to_string())?,
    );
    store.save().map_err(|error| error.to_string())
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

pub fn find_connection_mut<'a>(
    connections: &'a mut [QdrantConnectionRecord],
    id: &str,
) -> Result<&'a mut QdrantConnectionRecord, String> {
    connections
        .iter_mut()
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

fn read_keys(app: &tauri::AppHandle<Wry>) -> HashMap<String, String> {
    app.store(STORE_NAME)
        .ok()
        .and_then(|store| store.get(KEYS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn read_api_key(app: &tauri::AppHandle<Wry>, id: &str) -> Option<String> {
    read_keys(app)
        .remove(id)
        .filter(|key| !key.trim().is_empty())
}

pub fn has_api_key(app: &tauri::AppHandle<Wry>, id: &str) -> bool {
    read_api_key(app, id).is_some()
}

/// Empty clears. The key is never returned by any serializable view.
pub fn write_api_key(app: &tauri::AppHandle<Wry>, id: &str, api_key: &str) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|error| error.to_string())?;
    let mut keys = read_keys(app);
    if api_key.trim().is_empty() {
        keys.remove(id);
    } else {
        keys.insert(id.to_owned(), api_key.to_owned());
    }
    store.set(
        KEYS_KEY,
        serde_json::to_value(keys).map_err(|error| error.to_string())?,
    );
    store.save().map_err(|error| error.to_string())
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
