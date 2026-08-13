//! Backend-only credential storage.
//!
//! Secrets are deliberately represented by [`Secret`], which cannot be
//! serialized and whose `Debug` implementation is always redacted. The only
//! production implementation is macOS Keychain, under one stable service name.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tauri::{Manager, Wry};
use tauri_plugin_store::StoreExt;
use zeroize::Zeroizing;

use crate::commands::settings::STORE_NAME;

pub const SERVICE: &str = "com.veviad.terminal";
pub const GENERIC_ERROR: &str =
    "macOS Keychain is unavailable. Credentials are blocked until Keychain access is restored.";

const LEGACY_PROVIDER_KEYS: [(&str, CredentialId); 4] = [
    ("anthropic_api_key", CredentialId::Anthropic),
    ("openai_api_key", CredentialId::OpenAi),
    ("mistral_api_key", CredentialId::Mistral),
    ("hf_token", CredentialId::HuggingFace),
];
pub const LEGACY_REMOTE_TOKENS_KEY: &str = "remote_server_tokens";
pub const LEGACY_QDRANT_KEYS_KEY: &str = "knowledge_qdrant_api_keys";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CredentialId {
    Anthropic,
    OpenAi,
    Mistral,
    HuggingFace,
    RemoteServer(String),
    Qdrant(String),
}

impl CredentialId {
    pub fn account(&self) -> String {
        match self {
            Self::Anthropic => "provider/anthropic".into(),
            Self::OpenAi => "provider/openai".into(),
            Self::Mistral => "provider/mistral".into(),
            Self::HuggingFace => "provider/huggingface".into(),
            Self::RemoteServer(id) => format!("remote-model/{id}"),
            Self::Qdrant(id) => format!("qdrant/{id}"),
        }
    }

    pub fn from_setting(key: &str) -> Option<Self> {
        LEGACY_PROVIDER_KEYS
            .iter()
            .find_map(|(legacy, id)| (*legacy == key).then(|| id.clone()))
    }
}

/// Bind a Qdrant credential to the connection id *and network origin*. During an
/// endpoint change the new-origin account can be written before metadata changes,
/// while concurrent app/CLI readers still resolve the old-origin account. Thus a
/// key is never sent to a different scheme/host/effective-port due to a split
/// Keychain/settings update.
pub fn qdrant_id(connection_id: &str, endpoint: &str) -> Result<CredentialId, String> {
    let parsed = url::Url::parse(endpoint).map_err(|_| "invalid Qdrant credential origin")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("invalid Qdrant credential origin".into());
    }
    let port = parsed
        .port_or_known_default()
        .ok_or("invalid Qdrant credential origin")?;
    let host = parsed
        .host_str()
        .expect("host was checked")
        .to_ascii_lowercase();
    let origin = format!("{}://{host}:{port}", parsed.scheme());
    let digest = Sha256::digest(origin.as_bytes());
    let fingerprint = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(CredentialId::Qdrant(format!(
        "{connection_id}/{fingerprint}"
    )))
}

/// A secret which zeroes its backing allocation and cannot accidentally cross
/// serde/IPC or reveal itself through debug formatting.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self::new(value.to_owned())
    }
}

#[derive(Clone, Copy, Debug)]
struct VaultError;

trait CredentialStore: Send + Sync {
    fn available(&self) -> Result<(), VaultError>;
    fn get(&self, id: &CredentialId) -> Result<Option<Secret>, VaultError>;
    fn set(&self, id: &CredentialId, value: &Secret) -> Result<(), VaultError>;
    fn delete(&self, id: &CredentialId) -> Result<(), VaultError>;
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct SystemStore;

#[cfg(target_os = "macos")]
impl SystemStore {
    fn entry(id: &CredentialId) -> Result<keyring::v1::Entry, VaultError> {
        keyring::v1::Entry::new(SERVICE, &id.account()).map_err(|_| VaultError)
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for SystemStore {
    fn available(&self) -> Result<(), VaultError> {
        keyring::v1::Entry::store_status()
            .as_ref()
            .map(|_| ())
            .map_err(|_| VaultError)
    }

    fn get(&self, id: &CredentialId) -> Result<Option<Secret>, VaultError> {
        match Self::entry(id)?.get_password() {
            Ok(value) => Ok(Some(Secret::new(value))),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(_) => Err(VaultError),
        }
    }

    fn set(&self, id: &CredentialId, value: &Secret) -> Result<(), VaultError> {
        Self::entry(id)?
            .set_password(value.expose())
            .map_err(|_| VaultError)
    }

    fn delete(&self, id: &CredentialId) -> Result<(), VaultError> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(_) => Err(VaultError),
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
struct SystemStore;

#[cfg(not(target_os = "macos"))]
impl CredentialStore for SystemStore {
    fn available(&self) -> Result<(), VaultError> {
        Err(VaultError)
    }
    fn get(&self, _id: &CredentialId) -> Result<Option<Secret>, VaultError> {
        Err(VaultError)
    }
    fn set(&self, _id: &CredentialId, _value: &Secret) -> Result<(), VaultError> {
        Err(VaultError)
    }
    fn delete(&self, _id: &CredentialId) -> Result<(), VaultError> {
        Err(VaultError)
    }
}

pub struct CredentialStoreState {
    store: Arc<dyn CredentialStore>,
    blocked: AtomicBool,
}

impl CredentialStoreState {
    pub fn system() -> Self {
        Self {
            store: Arc::new(SystemStore),
            blocked: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    fn with_store(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            blocked: AtomicBool::new(false),
        }
    }

    pub fn is_blocked(&self) -> bool {
        self.blocked.load(Ordering::SeqCst)
    }

    fn block(&self) -> String {
        self.blocked.store(true, Ordering::SeqCst);
        GENERIC_ERROR.into()
    }

    fn ready(&self) -> Result<(), String> {
        if self.is_blocked() {
            Err(GENERIC_ERROR.into())
        } else {
            Ok(())
        }
    }

    pub fn get(&self, id: &CredentialId) -> Result<Option<Secret>, String> {
        self.ready()?;
        self.store.get(id).map_err(|_| self.block())
    }

    pub fn has(&self, id: &CredentialId) -> Result<bool, String> {
        Ok(self.get(id)?.is_some_and(|s| !s.expose().trim().is_empty()))
    }

    pub fn set_or_clear(&self, id: &CredentialId, value: String) -> Result<(), String> {
        self.ready()?;
        let result = if value.trim().is_empty() {
            self.store.delete(id)
        } else {
            self.store.set(id, &Secret::new(value))
        };
        result.map_err(|_| self.block())
    }

    pub fn delete(&self, id: &CredentialId) -> Result<(), String> {
        self.ready()?;
        self.store.delete(id).map_err(|_| self.block())
    }
}

pub fn state(app: &tauri::AppHandle<Wry>) -> tauri::State<'_, CredentialStoreState> {
    app.state::<CredentialStoreState>()
}

/// Read a credential from the system vault outside Tauri state. The standalone
/// Knowledge CLI uses this to share the exact same Keychain accounts as the app
/// without ever parsing or recreating plaintext settings fields.
pub fn headless_get(id: &CredentialId) -> Result<Option<Secret>, String> {
    let store = SystemStore;
    store.available().map_err(|_| GENERIC_ERROR.to_string())?;
    store.get(id).map_err(|_| GENERIC_ERROR.to_string())
}

pub fn headless_qdrant_get(connection_id: &str, endpoint: &str) -> Result<Option<Secret>, String> {
    headless_get(&qdrant_id(connection_id, endpoint)?)
}

#[derive(Default)]
struct LegacyCredentials {
    values: BTreeMap<CredentialId, Secret>,
}

fn collect_legacy(store: &tauri_plugin_store::Store<Wry>) -> LegacyCredentials {
    let mut legacy = LegacyCredentials::default();
    for (key, id) in LEGACY_PROVIDER_KEYS {
        if let Some(value) = store
            .get(key)
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|v| !v.trim().is_empty())
        {
            legacy.values.insert(id, Secret::new(value));
        }
    }
    if let Some(tokens) = store
        .get(LEGACY_REMOTE_TOKENS_KEY)
        .and_then(|v| v.as_object().cloned())
    {
        for (server_id, value) in tokens {
            if let Some(token) = value.as_str().filter(|v| !v.trim().is_empty()) {
                legacy
                    .values
                    .insert(CredentialId::RemoteServer(server_id), token.into());
            }
        }
    }
    if let Some(keys) = store
        .get(LEGACY_QDRANT_KEYS_KEY)
        .and_then(|value| value.as_object().cloned())
    {
        let connection_origins: BTreeMap<String, String> = store
            .get("knowledge_qdrant_connections")
            .and_then(|value| value.as_array().cloned())
            .into_iter()
            .flatten()
            .filter_map(|connection| {
                Some((
                    connection.get("id")?.as_str()?.to_owned(),
                    connection.get("url")?.as_str()?.to_owned(),
                ))
            })
            .collect();
        for (connection_id, value) in keys {
            if let Some(key) = value.as_str().filter(|value| !value.trim().is_empty()) {
                let credential = connection_origins
                    .get(&connection_id)
                    .and_then(|endpoint| qdrant_id(&connection_id, endpoint).ok())
                    // Orphaned legacy keys remain protected in Keychain even
                    // though no connection can resolve them.
                    .unwrap_or(CredentialId::Qdrant(connection_id));
                legacy.values.insert(credential, key.into());
            }
        }
    }
    legacy
}

fn write_and_verify_all(
    backend: &dyn CredentialStore,
    legacy: &LegacyCredentials,
) -> Result<(), VaultError> {
    for (id, secret) in &legacy.values {
        backend.set(id, secret)?;
        let verified = backend.get(id)?.ok_or(VaultError)?;
        if verified != *secret {
            return Err(VaultError);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn secure_permissions(path: &std::path::Path) -> Result<(), VaultError> {
    use std::os::unix::fs::PermissionsExt;
    if path.exists() {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| VaultError)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_permissions(_path: &std::path::Path) -> Result<(), VaultError> {
    Ok(())
}

/// Initialize Keychain and atomically retire legacy plaintext settings. Errors
/// never abort startup: the app remains usable, but all credential operations
/// are blocked and the UI receives only [`GENERIC_ERROR`].
pub fn initialize(app: &tauri::AppHandle<Wry>, state: &CredentialStoreState) {
    let result = (|| -> Result<(), VaultError> {
        state.store.available()?;
        let store = app.store(STORE_NAME).map_err(|_| VaultError)?;
        let legacy = collect_legacy(&store);
        write_and_verify_all(state.store.as_ref(), &legacy)?;

        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| VaultError)?
            .join(STORE_NAME);
        secure_permissions(&path)?;
        if !legacy.values.is_empty()
            || LEGACY_PROVIDER_KEYS.iter().any(|(key, _)| store.has(key))
            || store.has(LEGACY_REMOTE_TOKENS_KEY)
            || store.has(LEGACY_QDRANT_KEYS_KEY)
        {
            for (key, _) in LEGACY_PROVIDER_KEYS {
                store.delete(key);
            }
            store.delete(LEGACY_REMOTE_TOKENS_KEY);
            store.delete(LEGACY_QDRANT_KEYS_KEY);
        }
        // Create the sanitized store even on a fresh install, so the first
        // non-secret writer cannot create it with the process umask's broader
        // default. Existing files keep the mode secured above during rewrite.
        store.save().map_err(|_| VaultError)?;
        secure_permissions(&path)?;
        Ok(())
    })();
    if result.is_err() {
        state.blocked.store(true, Ordering::SeqCst);
        log::error!("credential store initialization failed; credential access is blocked");
    }
}

/// Redact exact known values and credential-shaped provider content before it
/// can reach logs, UI events, archives, or debug output.
pub fn redact_provider_text(text: &str, secret: Option<&Secret>) -> String {
    let mut out = text.to_owned();
    if let Some(secret) = secret.map(Secret::expose).filter(|s| !s.is_empty()) {
        out = out.replace(secret, "[REDACTED]");
    }
    let lower = out.to_ascii_lowercase();
    if [
        "authorization",
        "bearer ",
        "api_key",
        "api key",
        "api-key",
        "token=",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || contains_credential_shape(&out)
    {
        "provider returned a credential-related error; details were redacted".into()
    } else {
        out
    }
}

fn contains_credential_shape(text: &str) -> bool {
    ["sk-ant-", "sk-", "hf_", "ghp_", "gho_", "github_pat_"]
        .iter()
        .any(|prefix| {
            text.match_indices(prefix).any(|(at, _)| {
                text[at + prefix.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                    .take(12)
                    .count()
                    >= 12
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore {
        values: Mutex<BTreeMap<CredentialId, String>>,
        fail_after: Mutex<Option<usize>>,
        writes: Mutex<usize>,
    }

    impl MemoryStore {
        fn failing_after(n: usize) -> Self {
            Self {
                fail_after: Mutex::new(Some(n)),
                ..Self::default()
            }
        }
    }

    impl CredentialStore for MemoryStore {
        fn available(&self) -> Result<(), VaultError> {
            Ok(())
        }
        fn get(&self, id: &CredentialId) -> Result<Option<Secret>, VaultError> {
            Ok(self
                .values
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .map(Secret::new))
        }
        fn set(&self, id: &CredentialId, value: &Secret) -> Result<(), VaultError> {
            let mut writes = self.writes.lock().unwrap();
            if self
                .fail_after
                .lock()
                .unwrap()
                .is_some_and(|n| *writes >= n)
            {
                return Err(VaultError);
            }
            *writes += 1;
            self.values
                .lock()
                .unwrap()
                .insert(id.clone(), value.expose().into());
            Ok(())
        }
        fn delete(&self, id: &CredentialId) -> Result<(), VaultError> {
            self.values.lock().unwrap().remove(id);
            Ok(())
        }
    }

    #[test]
    fn memory_vault_set_get_presence_delete_and_debug_are_safe() {
        let state = CredentialStoreState::with_store(Arc::new(MemoryStore::default()));
        let id = CredentialId::OpenAi;
        state.set_or_clear(&id, "sentinel-secret".into()).unwrap();
        assert!(state.has(&id).unwrap());
        let secret = state.get(&id).unwrap().unwrap();
        assert_eq!(secret.expose(), "sentinel-secret");
        assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
        assert!(!format!("{secret:?}").contains("sentinel-secret"));
        state.delete(&id).unwrap();
        assert!(!state.has(&id).unwrap());
    }

    fn legacy() -> LegacyCredentials {
        LegacyCredentials {
            values: BTreeMap::from([
                (CredentialId::Anthropic, Secret::from("anthropic-sentinel")),
                (
                    CredentialId::RemoteServer("uuid".into()),
                    Secret::from("remote-sentinel"),
                ),
                (
                    CredentialId::Qdrant("connection-uuid".into()),
                    Secret::from("qdrant-sentinel"),
                ),
            ]),
        }
    }

    #[test]
    fn migration_writes_and_verifies_every_value_and_is_repeatable() {
        let backend = MemoryStore::default();
        write_and_verify_all(&backend, &legacy()).unwrap();
        write_and_verify_all(&backend, &legacy()).unwrap();
        assert_eq!(backend.values.lock().unwrap().len(), 3);
    }

    #[test]
    fn partial_migration_fails_without_sanitizing_the_source() {
        let source = legacy();
        let backend = MemoryStore::failing_after(1);
        assert!(write_and_verify_all(&backend, &source).is_err());
        assert_eq!(
            source.values.len(),
            3,
            "source remains available for retry/recovery"
        );
    }

    #[test]
    fn total_migration_failure_blocks_use_with_only_the_generic_error() {
        let source = legacy();
        assert!(write_and_verify_all(&MemoryStore::failing_after(0), &source).is_err());
        assert_eq!(source.values.len(), 3);

        let backend = Arc::new(MemoryStore::failing_after(0));
        let state = CredentialStoreState::with_store(backend);
        let error = state
            .set_or_clear(&CredentialId::Mistral, "sentinel-secret".into())
            .unwrap_err();
        assert_eq!(error, GENERIC_ERROR);
        assert!(state.is_blocked());
        assert!(!error.contains("sentinel-secret"));
        assert_eq!(
            state.get(&CredentialId::Mistral).unwrap_err(),
            GENERIC_ERROR
        );
    }

    #[test]
    fn sanitized_json_contains_no_legacy_secret_fields_or_values() {
        let mut json = serde_json::json!({
            "theme": "dark",
            "anthropic_api_key": "anthropic-sentinel",
            "openai_api_key": "openai-sentinel",
            "mistral_api_key": "mistral-sentinel",
            "hf_token": "hf-sentinel",
            "remote_server_tokens": {"uuid": "remote-sentinel"},
            "knowledge_qdrant_api_keys": {"connection-uuid": "qdrant-sentinel"}
        });
        let object = json.as_object_mut().unwrap();
        for (key, _) in LEGACY_PROVIDER_KEYS {
            object.remove(key);
        }
        object.remove(LEGACY_REMOTE_TOKENS_KEY);
        object.remove(LEGACY_QDRANT_KEYS_KEY);
        let serialized = serde_json::to_string(&json).unwrap();
        assert_eq!(serialized, r#"{"theme":"dark"}"#);
        assert!(!serialized.contains("sentinel"));
    }

    #[test]
    #[cfg(unix)]
    fn sanitized_settings_permissions_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "vterminal-settings-permissions-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        secure_permissions(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn provider_errors_remove_exact_and_credential_shaped_values() {
        let secret = Secret::from("sentinel-secret");
        let exact = redact_provider_text("bad sentinel-secret", Some(&secret));
        assert!(!exact.contains("sentinel-secret"));
        let shaped = redact_provider_text("Authorization: Bearer abc", None);
        assert!(!shaped.contains("abc"));
        let unknown = redact_provider_text("rejected sk-proj-abcdefghijklmnop", None);
        assert!(!unknown.contains("sk-proj-abcdefghijklmnop"));
    }

    #[test]
    fn keychain_account_names_are_stable_and_remote_tokens_use_the_uuid() {
        assert_eq!(CredentialId::Anthropic.account(), "provider/anthropic");
        assert_eq!(CredentialId::OpenAi.account(), "provider/openai");
        assert_eq!(CredentialId::Mistral.account(), "provider/mistral");
        assert_eq!(CredentialId::HuggingFace.account(), "provider/huggingface");
        assert_eq!(
            CredentialId::RemoteServer("server-uuid".into()).account(),
            "remote-model/server-uuid"
        );
        assert_eq!(
            CredentialId::Qdrant("connection-uuid".into()).account(),
            "qdrant/connection-uuid"
        );
    }

    #[test]
    fn qdrant_accounts_are_scoped_to_normalized_network_origins() {
        let base = qdrant_id("id", "https://EXAMPLE.com/one").unwrap();
        assert_eq!(
            base,
            qdrant_id("id", "https://example.com:443/two").unwrap()
        );
        assert_ne!(base, qdrant_id("id", "http://example.com").unwrap());
        assert_ne!(base, qdrant_id("id", "https://example.com:8443").unwrap());
        assert_ne!(base, qdrant_id("id", "https://other.example.com").unwrap());
        assert_ne!(base, qdrant_id("other-id", "https://example.com").unwrap());
    }
}
