//! Backend-only credential storage.
//!
//! Secrets are deliberately represented by [`Secret`], which cannot be
//! serialized and whose `Debug` implementation is always redacted. The only
//! production implementation is the operating-system credential vault, under
//! one stable service name (macOS Keychain or Windows Credential Manager).

use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tauri::{Manager, Wry};
use tauri_plugin_store::StoreExt;
use zeroize::Zeroizing;

use crate::commands::settings::STORE_NAME;

pub const SERVICE: &str = "com.veviad.terminal";
pub const GENERIC_ERROR: &str = "The system credential vault is unavailable. Credentials are blocked until operating-system credential access is restored.";
const CANCELLED_ERROR: &str =
    "Credential access was cancelled. Retry the action to ask the operating system again.";
const DENIED_ERROR: &str = "Credential access was not allowed for this item. Retry the action or review the item's access in the system credential vault.";
const ITEM_ERROR: &str =
    "The requested credential could not be accessed. Retry the action or replace it in Settings.";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VaultError {
    Unavailable,
    Cancelled,
    Denied,
    Item,
}

impl VaultError {
    fn message(self) -> &'static str {
        match self {
            Self::Unavailable => GENERIC_ERROR,
            Self::Cancelled => CANCELLED_ERROR,
            Self::Denied => DENIED_ERROR,
            Self::Item => ITEM_ERROR,
        }
    }
}

trait CredentialStore: Send + Sync {
    fn available(&self) -> Result<(), VaultError>;
    fn get(&self, id: &CredentialId) -> Result<Option<Secret>, VaultError>;
    fn has(&self, id: &CredentialId) -> Result<bool, VaultError>;
    fn set(&self, id: &CredentialId, value: &Secret) -> Result<(), VaultError>;
    fn delete(&self, id: &CredentialId) -> Result<(), VaultError>;
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[derive(Default)]
struct SystemStore;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SystemStore {
    fn entry(id: &CredentialId) -> Result<keyring::v1::Entry, VaultError> {
        keyring::v1::Entry::new(SERVICE, &id.account()).map_err(classify_keyring_error)
    }
}

#[cfg(target_os = "macos")]
fn classify_macos_status(code: i32) -> VaultError {
    match code {
        // errSecUserCanceled
        -128 => VaultError::Cancelled,
        // errSecAuthFailed, errSecInteractionNotAllowed, errSecInteractionRequired
        -25293 | -25308 | -25315 => VaultError::Denied,
        // errSecNotAvailable, errSecNoSuchKeychain, errSecInvalidKeychain
        -25291 | -25294 | -25295 => VaultError::Unavailable,
        // A read-only Keychain and item-specific ACL/write failures do not mean
        // that every other credential is unavailable.
        -61 | -25244 | -25292 | -25309 => VaultError::Denied,
        _ => VaultError::Item,
    }
}

#[cfg(target_os = "macos")]
fn classify_platform_error(error: &(dyn std::error::Error + Send + Sync + 'static)) -> VaultError {
    error
        .downcast_ref::<security_framework::base::Error>()
        .map_or(VaultError::Item, |error| {
            classify_macos_status(error.code())
        })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn classify_keyring_error(error: keyring::v1::Error) -> VaultError {
    classify_keyring_error_ref(&error)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn classify_keyring_error_ref(error: &keyring::v1::Error) -> VaultError {
    match error {
        keyring::v1::Error::NoDefaultStore | keyring::v1::Error::BadStoreFormat(_) => {
            VaultError::Unavailable
        }
        #[cfg(target_os = "macos")]
        keyring::v1::Error::PlatformFailure(error) | keyring::v1::Error::NoStorageAccess(error) => {
            classify_platform_error(error.as_ref())
        }
        #[cfg(target_os = "windows")]
        keyring::v1::Error::NoStorageAccess(_) => VaultError::Denied,
        _ => VaultError::Item,
    }
}

#[cfg(target_os = "macos")]
fn macos_has(id: &CredentialId) -> Result<bool, VaultError> {
    use security_framework::item::{ItemClass, ItemSearchOptions};
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|error| classify_macos_status(error.code()))?;
    let keychains = [keychain];
    let mut query = ItemSearchOptions::new();
    query
        .keychains(&keychains)
        .class(ItemClass::generic_password())
        .service(SERVICE)
        .account(&id.account())
        // Return attributes so SecItemCopyMatching produces a result while
        // deliberately never requesting kSecReturnData (the secret itself).
        .load_attributes(true)
        .limit(1)
        // Presence checks must never display an authentication dialog.
        .skip_authenticated_items(true);

    match query.search() {
        Ok(matches) => Ok(!matches.is_empty()),
        Err(error) if error.code() == -25300 => Ok(false), // errSecItemNotFound
        Err(error) => Err(classify_macos_status(error.code())),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl CredentialStore for SystemStore {
    fn available(&self) -> Result<(), VaultError> {
        keyring::v1::Entry::store_status()
            .as_ref()
            .map(|_| ())
            .map_err(classify_keyring_error_ref)
    }

    fn get(&self, id: &CredentialId) -> Result<Option<Secret>, VaultError> {
        match Self::entry(id)?.get_password() {
            Ok(value) => Ok(Some(Secret::new(value))),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(error) => Err(classify_keyring_error(error)),
        }
    }

    fn has(&self, id: &CredentialId) -> Result<bool, VaultError> {
        #[cfg(target_os = "macos")]
        {
            macos_has(id)
        }
        #[cfg(target_os = "windows")]
        {
            Ok(self
                .get(id)?
                .is_some_and(|secret| !secret.expose().trim().is_empty()))
        }
    }

    fn set(&self, id: &CredentialId, value: &Secret) -> Result<(), VaultError> {
        Self::entry(id)?
            .set_password(value.expose())
            .map_err(classify_keyring_error)
    }

    fn delete(&self, id: &CredentialId) -> Result<(), VaultError> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(error) => Err(classify_keyring_error(error)),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[derive(Default)]
struct SystemStore;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl CredentialStore for SystemStore {
    fn available(&self) -> Result<(), VaultError> {
        Err(VaultError::Unavailable)
    }
    fn get(&self, _id: &CredentialId) -> Result<Option<Secret>, VaultError> {
        Err(VaultError::Unavailable)
    }
    fn has(&self, _id: &CredentialId) -> Result<bool, VaultError> {
        Err(VaultError::Unavailable)
    }
    fn set(&self, _id: &CredentialId, _value: &Secret) -> Result<(), VaultError> {
        Err(VaultError::Unavailable)
    }
    fn delete(&self, _id: &CredentialId) -> Result<(), VaultError> {
        Err(VaultError::Unavailable)
    }
}

pub struct CredentialStoreState {
    store: Arc<dyn CredentialStore>,
    /// Successful secret reads stay in zeroizing process memory until app exit.
    /// Holding the mutex across a cold Keychain read also prevents concurrent
    /// consumers from opening duplicate authorization dialogs for the same item.
    cache: Mutex<BTreeMap<CredentialId, Secret>>,
    blocked: AtomicBool,
}

impl CredentialStoreState {
    pub fn system() -> Self {
        Self {
            store: Arc::new(SystemStore),
            cache: Mutex::new(BTreeMap::new()),
            blocked: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    fn with_store(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            cache: Mutex::new(BTreeMap::new()),
            blocked: AtomicBool::new(false),
        }
    }

    pub fn is_blocked(&self) -> bool {
        self.blocked.load(Ordering::SeqCst)
    }

    fn operation_error(&self, error: VaultError) -> String {
        if error == VaultError::Unavailable {
            self.blocked.store(true, Ordering::SeqCst);
        }
        error.message().into()
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
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(secret) = cache.get(id) {
            return Ok(Some(secret.clone()));
        }
        match self.store.get(id) {
            Ok(Some(secret)) => {
                cache.insert(id.clone(), secret.clone());
                Ok(Some(secret))
            }
            // Missing values and failures stay retryable. Only an actual secret
            // needs caching to prevent another Keychain authorization prompt.
            Ok(None) => Ok(None),
            Err(error) => Err(self.operation_error(error)),
        }
    }

    pub fn has(&self, id: &CredentialId) -> Result<bool, String> {
        self.ready()?;
        self.store
            .has(id)
            .map_err(|error| self.operation_error(error))
    }

    pub fn set_or_clear(&self, id: &CredentialId, value: String) -> Result<(), String> {
        self.ready()?;
        let secret = if value.trim().is_empty() {
            None
        } else {
            Some(Secret::new(value))
        };
        match &secret {
            Some(secret) => self.store.set(id, secret),
            None => self.store.delete(id),
        }
        .map_err(|error| self.operation_error(error))?;

        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match secret {
            Some(secret) => {
                cache.insert(id.clone(), secret);
            }
            None => {
                cache.remove(id);
            }
        }
        Ok(())
    }

    pub fn delete(&self, id: &CredentialId) -> Result<(), String> {
        self.ready()?;
        self.store
            .delete(id)
            .map_err(|error| self.operation_error(error))?;
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        Ok(())
    }
}

pub fn state(app: &tauri::AppHandle<Wry>) -> tauri::State<'_, CredentialStoreState> {
    app.state::<CredentialStoreState>()
}

/// Read a credential from the system vault outside Tauri state. The standalone
/// Knowledge CLI uses this to share the exact same system-vault accounts as the app
/// without ever parsing or recreating plaintext settings fields.
pub fn headless_get(id: &CredentialId) -> Result<Option<Secret>, String> {
    let store = SystemStore;
    store
        .available()
        .map_err(|error| error.message().to_string())?;
    store.get(id).map_err(|error| error.message().to_string())
}

/// Check credential metadata without reading the secret. On macOS this uses an
/// attribute-only query with authentication UI explicitly suppressed.
pub fn headless_has(id: &CredentialId) -> Result<bool, String> {
    let store = SystemStore;
    store
        .available()
        .map_err(|error| error.message().to_string())?;
    store.has(id).map_err(|error| error.message().to_string())
}

pub fn headless_qdrant_get(connection_id: &str, endpoint: &str) -> Result<Option<Secret>, String> {
    headless_get(&qdrant_id(connection_id, endpoint)?)
}

pub fn headless_qdrant_has(connection_id: &str, endpoint: &str) -> Result<bool, String> {
    headless_has(&qdrant_id(connection_id, endpoint)?)
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
                    // Orphaned legacy keys remain protected in the system vault even
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
        let verified = backend.get(id)?.ok_or(VaultError::Item)?;
        if verified != *secret {
            return Err(VaultError::Item);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn secure_permissions(path: &std::path::Path) -> Result<(), VaultError> {
    use std::os::unix::fs::PermissionsExt;
    if path.exists() {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| VaultError::Item)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_permissions(_path: &std::path::Path) -> Result<(), VaultError> {
    Ok(())
}

/// Initialize the system credential vault and atomically retire legacy plaintext settings. Errors
/// never abort startup. Only a vault-wide availability failure blocks all later
/// operations; cancellation, access denial, and item/migration failures remain
/// retryable without affecting unrelated credentials.
pub fn initialize(app: &tauri::AppHandle<Wry>, state: &CredentialStoreState) {
    let result = (|| -> Result<(), VaultError> {
        state.store.available()?;
        let store = app.store(STORE_NAME).map_err(|_| VaultError::Item)?;
        let legacy = collect_legacy(&store);
        write_and_verify_all(state.store.as_ref(), &legacy)?;

        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| VaultError::Item)?
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
        store.save().map_err(|_| VaultError::Item)?;
        secure_permissions(&path)?;
        Ok(())
    })();
    if let Err(error) = result {
        if error == VaultError::Unavailable {
            state.blocked.store(true, Ordering::SeqCst);
            log::error!("credential vault initialization failed; credential access is blocked");
        } else {
            log::warn!(
                "credential migration or settings sanitization did not complete; it will be retried"
            );
        }
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

    #[derive(Default)]
    struct MemoryStore {
        values: Mutex<BTreeMap<CredentialId, String>>,
        fail_after: Mutex<Option<usize>>,
        read_failures: Mutex<Vec<VaultError>>,
        read_delay: std::time::Duration,
        writes: Mutex<usize>,
        reads: Mutex<usize>,
        presence_checks: Mutex<usize>,
    }

    impl MemoryStore {
        fn failing_after(n: usize) -> Self {
            Self {
                fail_after: Mutex::new(Some(n)),
                ..Self::default()
            }
        }

        fn failing_reads(errors: Vec<VaultError>) -> Self {
            Self {
                read_failures: Mutex::new(errors),
                ..Self::default()
            }
        }

        fn with_read_delay(delay: std::time::Duration) -> Self {
            Self {
                read_delay: delay,
                ..Self::default()
            }
        }
    }

    impl CredentialStore for MemoryStore {
        fn available(&self) -> Result<(), VaultError> {
            Ok(())
        }
        fn get(&self, id: &CredentialId) -> Result<Option<Secret>, VaultError> {
            *self.reads.lock().unwrap() += 1;
            if !self.read_delay.is_zero() {
                std::thread::sleep(self.read_delay);
            }
            if let Some(error) = self.read_failures.lock().unwrap().pop() {
                return Err(error);
            }
            Ok(self
                .values
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .map(Secret::new))
        }
        fn has(&self, id: &CredentialId) -> Result<bool, VaultError> {
            *self.presence_checks.lock().unwrap() += 1;
            Ok(self.values.lock().unwrap().contains_key(id))
        }
        fn set(&self, id: &CredentialId, value: &Secret) -> Result<(), VaultError> {
            let mut writes = self.writes.lock().unwrap();
            if self
                .fail_after
                .lock()
                .unwrap()
                .is_some_and(|n| *writes >= n)
            {
                return Err(VaultError::Item);
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

    struct AlwaysErrorStore(VaultError);

    impl CredentialStore for AlwaysErrorStore {
        fn available(&self) -> Result<(), VaultError> {
            Ok(())
        }
        fn get(&self, _id: &CredentialId) -> Result<Option<Secret>, VaultError> {
            Err(self.0)
        }
        fn has(&self, _id: &CredentialId) -> Result<bool, VaultError> {
            Err(self.0)
        }
        fn set(&self, _id: &CredentialId, _value: &Secret) -> Result<(), VaultError> {
            Err(self.0)
        }
        fn delete(&self, _id: &CredentialId) -> Result<(), VaultError> {
            Err(self.0)
        }
    }

    #[test]
    fn memory_vault_set_get_presence_delete_and_debug_are_safe() {
        let backend = Arc::new(MemoryStore::default());
        let state = CredentialStoreState::with_store(backend.clone());
        let id = CredentialId::OpenAi;
        state.set_or_clear(&id, "sentinel-secret".into()).unwrap();
        assert!(state.has(&id).unwrap());
        assert_eq!(*backend.presence_checks.lock().unwrap(), 1);
        assert_eq!(
            *backend.reads.lock().unwrap(),
            0,
            "presence checks must not retrieve the secret"
        );
        let secret = state.get(&id).unwrap().unwrap();
        assert_eq!(secret.expose(), "sentinel-secret");
        assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
        assert!(!format!("{secret:?}").contains("sentinel-secret"));
        state.delete(&id).unwrap();
        assert!(!state.has(&id).unwrap());
    }

    #[test]
    fn successful_reads_are_cached_for_the_app_process() {
        let backend = Arc::new(MemoryStore::default());
        let id = CredentialId::Qdrant("connection/origin".into());
        backend
            .values
            .lock()
            .unwrap()
            .insert(id.clone(), "qdrant-sentinel".into());
        let state = CredentialStoreState::with_store(backend.clone());

        for _ in 0..2 {
            assert_eq!(state.get(&id).unwrap().unwrap().expose(), "qdrant-sentinel");
        }
        assert_eq!(*backend.reads.lock().unwrap(), 1);
    }

    #[test]
    fn concurrent_consumers_share_one_successful_keychain_read() {
        let backend = Arc::new(MemoryStore::with_read_delay(
            std::time::Duration::from_millis(25),
        ));
        let id = CredentialId::Anthropic;
        backend
            .values
            .lock()
            .unwrap()
            .insert(id.clone(), "anthropic-sentinel".into());
        let state = Arc::new(CredentialStoreState::with_store(backend.clone()));

        let readers = (0..4)
            .map(|_| {
                let state = state.clone();
                let id = id.clone();
                std::thread::spawn(move || state.get(&id).unwrap().unwrap())
            })
            .collect::<Vec<_>>();
        for reader in readers {
            assert_eq!(reader.join().unwrap().expose(), "anthropic-sentinel");
        }
        assert_eq!(*backend.reads.lock().unwrap(), 1);
    }

    #[test]
    fn writes_prime_and_clears_evict_the_process_cache() {
        let backend = Arc::new(MemoryStore::default());
        let state = CredentialStoreState::with_store(backend.clone());
        let id = CredentialId::Mistral;

        state.set_or_clear(&id, "first-sentinel".into()).unwrap();
        assert_eq!(state.get(&id).unwrap().unwrap().expose(), "first-sentinel");
        assert_eq!(*backend.reads.lock().unwrap(), 0);

        state.set_or_clear(&id, "second-sentinel".into()).unwrap();
        assert_eq!(state.get(&id).unwrap().unwrap().expose(), "second-sentinel");
        assert_eq!(*backend.reads.lock().unwrap(), 0);

        state.set_or_clear(&id, "".into()).unwrap();
        assert!(state.get(&id).unwrap().is_none());
        assert_eq!(*backend.reads.lock().unwrap(), 1);
    }

    #[test]
    fn cancelled_reads_are_not_cached_and_can_be_retried() {
        let backend = Arc::new(MemoryStore::failing_reads(vec![VaultError::Cancelled]));
        let id = CredentialId::OpenAi;
        backend
            .values
            .lock()
            .unwrap()
            .insert(id.clone(), "openai-sentinel".into());
        let state = CredentialStoreState::with_store(backend.clone());

        assert_eq!(state.get(&id).unwrap_err(), CANCELLED_ERROR);
        assert_eq!(state.get(&id).unwrap().unwrap().expose(), "openai-sentinel");
        assert_eq!(state.get(&id).unwrap().unwrap().expose(), "openai-sentinel");
        assert_eq!(*backend.reads.lock().unwrap(), 2);
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
    fn item_failure_is_retryable_and_does_not_block_other_credentials() {
        let source = legacy();
        assert!(write_and_verify_all(&MemoryStore::failing_after(0), &source).is_err());
        assert_eq!(source.values.len(), 3);

        let backend = Arc::new(MemoryStore::failing_after(0));
        let state = CredentialStoreState::with_store(backend);
        let error = state
            .set_or_clear(&CredentialId::Mistral, "sentinel-secret".into())
            .unwrap_err();
        assert_eq!(error, ITEM_ERROR);
        assert!(!state.is_blocked());
        assert!(!error.contains("sentinel-secret"));
        assert!(!state.has(&CredentialId::Mistral).unwrap());
    }

    #[test]
    fn only_unavailable_errors_globally_block_credentials() {
        for error in [VaultError::Cancelled, VaultError::Denied, VaultError::Item] {
            let state = CredentialStoreState::with_store(Arc::new(AlwaysErrorStore(error)));
            assert_eq!(
                state.has(&CredentialId::OpenAi).unwrap_err(),
                error.message()
            );
            assert!(!state.is_blocked());
        }

        let state =
            CredentialStoreState::with_store(Arc::new(AlwaysErrorStore(VaultError::Unavailable)));
        assert_eq!(state.has(&CredentialId::OpenAi).unwrap_err(), GENERIC_ERROR);
        assert!(state.is_blocked());
        assert_eq!(
            state.has(&CredentialId::Mistral).unwrap_err(),
            GENERIC_ERROR
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_statuses_keep_item_denials_distinct_from_vault_unavailability() {
        assert_eq!(classify_macos_status(-128), VaultError::Cancelled);
        assert_eq!(classify_macos_status(-25293), VaultError::Denied);
        assert_eq!(classify_macos_status(-25308), VaultError::Denied);
        assert_eq!(classify_macos_status(-25315), VaultError::Denied);
        assert_eq!(classify_macos_status(-25291), VaultError::Unavailable);
        assert_eq!(classify_macos_status(-25294), VaultError::Unavailable);
        assert_eq!(classify_macos_status(-25295), VaultError::Unavailable);
        assert_eq!(classify_macos_status(-50), VaultError::Item);
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
