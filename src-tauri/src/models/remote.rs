//! User-configured remote inference servers, and the models they serve.
//!
//! `catalog` is a compile-time allowlist; this is its runtime counterpart. A user
//! points the app at an Ollama box, an LM Studio instance, or anything else
//! speaking the chat-completions shape, ticks the models they want, and those
//! models then behave like catalog entries everywhere else in the app.
//!
//! Three things about this module are load-bearing:
//!
//! 1. **Models are handed out as `&'static CatalogModel`.** Eight sites in the
//!    backend require that lifetime — `OpenAiCompatProvider.model`, `Resolved`,
//!    `CatalogEntry`'s `#[serde(flatten)]` — and a configured model is only known
//!    at runtime. `intern` bridges the two by leaking, memoised on the whole spec
//!    so identical content is reused and an edit cannot return a stale entry.
//!    Nothing else about `CatalogModel`, `CATALOG` or the IPC wire shape changes.
//! 2. **`RemoteServer` has no token field.** The token lives in a sibling store
//!    key, so no read path can leak one by forgetting to strip it — the same
//!    stance as the write-only `has_*_api_key` booleans in `get_settings`.
//! 3. **Nothing here touches the network.** Enabled models are persisted with the
//!    metadata a probe found, so app start (and `models_catalog`) reads settings
//!    only. Discovery lives in `remote_probe`, behind an explicit user gesture.
//!
//! Tokens are stored in `settings.json`, in plaintext, in the app data directory
//! — the same file and the same exposure as `hf_token` and the three vendor API
//! keys. There is no Keychain integration; nobody should assume otherwise.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Wry;
use tauri_plugin_store::{Store, StoreExt};

use crate::commands::settings::STORE_NAME;
use crate::models::catalog::{CatalogModel, Effort, ProviderId, Tier};

/// Store key holding the server list.
const SERVERS_KEY: &str = "remote_servers";
/// Store key holding `{ "<server id>": "<token>" }`, write-only.
const TOKENS_KEY: &str = "remote_server_tokens";

/// Which product is on the other end.
///
/// This decides exactly two things: the default port offered for a bare host, and
/// which endpoint the probe asks for richer model metadata. Everything else — the
/// chat request itself — is identical across all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerKind {
    // Renamed by hand. `rename_all = "snake_case"` would emit "lm_studio" and
    // "open_ai_compatible", neither of which is what the frontend sends.
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "lmstudio")]
    LmStudio,
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible,
}

impl ServerKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ollama" => Some(ServerKind::Ollama),
            "lmstudio" => Some(ServerKind::LmStudio),
            "openai_compatible" => Some(ServerKind::OpenAiCompatible),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ServerKind::Ollama => "ollama",
            ServerKind::LmStudio => "lmstudio",
            ServerKind::OpenAiCompatible => "openai_compatible",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ServerKind::Ollama => "Ollama",
            ServerKind::LmStudio => "LM Studio",
            ServerKind::OpenAiCompatible => "OpenAI-compatible",
        }
    }

    /// Port to assume when the user typed a bare host.
    ///
    /// `None` for the generic kind on purpose: vLLM defaults to 8000, llama.cpp's
    /// server to 8080, LiteLLM to 4000. With no majority, guessing produces a
    /// connection error that looks like the server being down.
    pub fn default_port(self) -> Option<u16> {
        match self {
            ServerKind::Ollama => Some(11434),
            ServerKind::LmStudio => Some(1234),
            ServerKind::OpenAiCompatible => None,
        }
    }

    /// Context window to assume when the server does not report one.
    ///
    /// Conservative rather than optimistic. For a remote model this number is
    /// advisory — see `RemoteModel::context_tokens` — so the cost of being low is
    /// a pessimistic tooltip, while the cost of being high is a claim the server
    /// silently truncates.
    pub fn default_context(self) -> u32 {
        match self {
            ServerKind::Ollama | ServerKind::LmStudio => 4096,
            ServerKind::OpenAiCompatible => 8192,
        }
    }
}

/// One configured server. Note what is absent: the token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteServer {
    /// uuid v4, minted at create and **never rewritten**. Model ids embed it, so
    /// rewriting one would orphan `active_model_id` and every `model_effort` key.
    pub id: String,
    pub kind: ServerKind,
    pub label: String,
    /// Normalized by `remote_probe::normalize_base_url`: scheme, host, port and an
    /// optional non-API path prefix, with no trailing slash and no `/v1`.
    pub base_url: String,
    /// The models the user ticked, in display order. Empty is meaningful: the
    /// server stays configured but offers nothing.
    #[serde(default)]
    pub models: Vec<RemoteModel>,
}

/// One enabled model, with whatever the probe managed to learn about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteModel {
    /// Verbatim `/v1/models[].id` — what goes in the request body's `model`
    /// field. May contain `/` (LM Studio reports repo-qualified ids).
    pub wire_model: String,
    pub label: String,
    /// Advisory only. Nothing in the request path reads it for a remote model —
    /// the sole functional reader of `context_tokens` is the on-device load clamp
    /// in `commands::models`, which a remote model never reaches. A wrong value
    /// costs a wrong tooltip, never a failed request.
    pub context_tokens: u32,
    #[serde(default)]
    pub supports_vision: bool,
    /// Agent mode needs tool calling. Defaults to true because most servers do
    /// not say either way, and refusing on silence would block working setups.
    #[serde(default = "default_true")]
    pub supports_tools: bool,
}

fn default_true() -> bool {
    true
}

pub fn build_id(server_id: &str, wire_model: &str) -> String {
    format!("remote/{server_id}/{wire_model}")
}

/// `(server_id, wire_model)`.
///
/// `splitn(3, …)` rather than `split`: an LM Studio model id contains slashes
/// ("lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF"), so everything after
/// the second separator is the wire model, verbatim.
pub fn parse_id(id: &str) -> Option<(&str, &str)> {
    let mut parts = id.splitn(3, '/');
    match (parts.next()?, parts.next()?, parts.next()?) {
        ("remote", server, wire) if !server.is_empty() && !wire.is_empty() => Some((server, wire)),
        _ => None,
    }
}

/// The varying half of a `CatalogModel`, owned. Serialized to key the memo, so
/// every field that can differ between two configurations must appear here.
#[derive(Serialize)]
struct Spec {
    id: String,
    label: String,
    description: String,
    wire_model: String,
    context_tokens: u32,
    supports_vision: bool,
}

/// Past this many distinct configurations we stop being silent about the leak.
/// 512 × ~300 bytes is ~150 KB — a log line, not a failure.
const MAX_INTERNED: usize = 512;

/// Mint (or reuse) a `&'static CatalogModel` for a configured model.
///
/// Leaks deliberately: `&'static` is an honest claim about leaked memory, and no
/// `unsafe` is involved. Bounded by DISTINCT SPECS SEEN THIS PROCESS, not by
/// calls — the memo is keyed on the whole spec, so re-listing the catalog reuses
/// entries, editing a label mints one, and editing a URL or token mints none
/// (neither appears in `CatalogModel`). Minting only happens inside
/// `models_catalog` and `resolve_provider`, never per keystroke.
fn intern(spec: Spec) -> &'static CatalogModel {
    static MEMO: OnceLock<Mutex<HashMap<String, &'static CatalogModel>>> = OnceLock::new();
    let key = serde_json::to_string(&spec).unwrap_or_else(|_| spec.id.clone());
    let mut map = MEMO
        .get_or_init(Default::default)
        // A poisoned cache is not corrupt data — recover rather than propagate.
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(model) = map.get(&key) {
        return model;
    }
    let model: &'static CatalogModel = Box::leak(Box::new(CatalogModel {
        id: spec.id.leak(),
        provider: ProviderId::Remote,
        // Meaningless here, and never read for a remote entry: `tier` exists so
        // the catalog can offer one model per provider per tier, and the user
        // picked this exact model. The settings UI hides the badge.
        tier: Tier::Balanced,
        label: spec.label.leak(),
        description: spec.description.leak(),
        wire_model: spec.wire_model.leak(),
        context_tokens: spec.context_tokens,
        // No rungs, so `openai_compat` omits `reasoning_effort` entirely and the
        // picker self-hides. Neither Ollama nor LM Studio accepts the field
        // reliably, and a rejected effort value is a 400, not a downgrade.
        efforts: &[],
        // The convention `catalog`'s own `default_effort_is_always_supported`
        // encodes for an empty ladder. That test cannot see this entry, so the
        // invariant is held here by hand (and by a test below).
        default_effort: Effort::Off,
        supports_temperature: true,
        // Server-side web fetch is an Anthropic Messages API feature; nothing
        // reachable over chat-completions has it. Never read from config.
        native_web_fetch: false,
        supports_vision: spec.supports_vision,
        local: None,
    }));
    if map.len() == MAX_INTERNED {
        log::warn!(
            "{MAX_INTERNED} distinct remote model configurations interned this session — \
             each one leaks a small allocation by design"
        );
    }
    map.insert(key, model);
    model
}

fn spec_for(server: &RemoteServer, model: &RemoteModel) -> Spec {
    Spec {
        id: build_id(&server.id, &model.wire_model),
        label: model.label.clone(),
        // Names the server, since the label is the bare model name and the same
        // model may be served by two of them.
        description: format!(
            "{} · {} · {}",
            server.kind.label(),
            server.label,
            server.base_url
        ),
        wire_model: model.wire_model.clone(),
        context_tokens: model.context_tokens,
        supports_vision: model.supports_vision,
    }
}

// ------------------------------------------------------------------ store access

fn read_servers_value(store: &Store<Wry>) -> Vec<RemoteServer> {
    store
        .get(SERVERS_KEY)
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default()
}

pub fn read_servers(app: &tauri::AppHandle<Wry>) -> Vec<RemoteServer> {
    app.store(STORE_NAME)
        .map(|store| read_servers_value(&store))
        .unwrap_or_default()
}

/// For callers that already hold the store and no `AppHandle` — notably
/// `settings::active_model_id`, which would otherwise have to open it twice.
pub fn read_servers_from(store: &Store<Wry>) -> Vec<RemoteServer> {
    read_servers_value(store)
}

pub fn write_servers(app: &tauri::AppHandle<Wry>, servers: &[RemoteServer]) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    store.set(
        SERVERS_KEY,
        serde_json::to_value(servers).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())
}

/// The stored token, if any. Never crosses the IPC boundary.
pub fn read_token(app: &tauri::AppHandle<Wry>, server_id: &str) -> Option<String> {
    let store = app.store(STORE_NAME).ok()?;
    store
        .get(TOKENS_KEY)?
        .get(server_id)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|t| !t.trim().is_empty())
}

pub fn has_token(app: &tauri::AppHandle<Wry>, server_id: &str) -> bool {
    read_token(app, server_id).is_some()
}

/// Write or clear one server's token. An empty string clears — the same sentinel
/// every clearable string setting uses, because JSON null is indistinguishable
/// from "not provided" once serde sees `Option` over Tauri IPC.
pub fn write_token(
    app: &tauri::AppHandle<Wry>,
    server_id: &str,
    token: &str,
) -> Result<(), String> {
    let store = app.store(STORE_NAME).map_err(|e| e.to_string())?;
    let mut map = store
        .get(TOKENS_KEY)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if token.trim().is_empty() {
        map.remove(server_id);
    } else {
        map.insert(server_id.to_string(), serde_json::json!(token));
    }
    store.set(TOKENS_KEY, serde_json::Value::Object(map));
    store.save().map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ lookup

/// Pure core of `find`, so the id scheme is testable without a Tauri app.
pub fn find_in(servers: &[RemoteServer], id: &str) -> Option<&'static CatalogModel> {
    let (server_id, wire_model) = parse_id(id)?;
    let server = servers.iter().find(|s| s.id == server_id)?;
    let model = server.models.iter().find(|m| m.wire_model == wire_model)?;
    Some(intern(spec_for(server, model)))
}

pub fn find(app: &tauri::AppHandle<Wry>, id: &str) -> Option<&'static CatalogModel> {
    // Cheap guard: skip reading the store entirely for a catalog id.
    parse_id(id)?;
    find_in(&read_servers(app), id)
}

/// Which server serves a model row, denormalized for the settings UI. The list
/// there groups by server, and the model menu names it — neither can look this up
/// from a `CatalogModel`, which carries no server identity.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteRowInfo {
    pub server_id: String,
    pub server_label: String,
    pub kind: ServerKind,
    pub supports_tools: bool,
}

/// Every enabled model across every configured server, in list order, each with
/// the row info the settings UI needs.
pub fn enabled_models(app: &tauri::AppHandle<Wry>) -> Vec<(&'static CatalogModel, RemoteRowInfo)> {
    let mut out = Vec::new();
    for server in read_servers(app) {
        for model in &server.models {
            out.push((
                intern(spec_for(&server, model)),
                RemoteRowInfo {
                    server_id: server.id.clone(),
                    server_label: server.label.clone(),
                    kind: server.kind,
                    supports_tools: model.supports_tools,
                },
            ));
        }
    }
    out
}

/// Does this server serve the model currently selected?
pub fn owns_model_id(server: &RemoteServer, active_model_id: &str) -> bool {
    parse_id(active_model_id).is_some_and(|(id, _)| id == server.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(models: &[&str]) -> RemoteServer {
        RemoteServer {
            id: "3f9a-uuid".into(),
            kind: ServerKind::Ollama,
            label: "Workstation".into(),
            base_url: "http://10.0.0.5:11434".into(),
            models: models
                .iter()
                .map(|w| RemoteModel {
                    wire_model: (*w).to_string(),
                    label: (*w).to_string(),
                    context_tokens: 32_768,
                    supports_vision: false,
                    supports_tools: true,
                })
                .collect(),
        }
    }

    #[test]
    fn ids_round_trip() {
        for wire in [
            "qwen3:8b",
            // LM Studio ids carry the repo, so the wire model has its own slash.
            "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
            "library/qwen3:8b",
        ] {
            let id = build_id("3f9a-uuid", wire);
            assert_eq!(parse_id(&id), Some(("3f9a-uuid", wire)), "{id}");
        }
    }

    #[test]
    fn parse_id_rejects_anything_that_is_not_a_remote_id() {
        for junk in [
            "local/qwen3.5-9b",
            "anthropic/claude-opus-5",
            "remote",
            "remote/",
            "remote/uuid",
            "remote//model",
            "remote/uuid/",
            "",
        ] {
            assert_eq!(parse_id(junk), None, "{junk} should not parse");
        }
    }

    #[test]
    fn identical_specs_reuse_one_static() {
        let s = server(&["qwen3:8b"]);
        let a = find_in(std::slice::from_ref(&s), &build_id(&s.id, "qwen3:8b")).unwrap();
        let b = find_in(std::slice::from_ref(&s), &build_id(&s.id, "qwen3:8b")).unwrap();
        assert!(
            std::ptr::eq(a, b),
            "the memo should have returned the first"
        );
    }

    #[test]
    fn an_edited_label_mints_a_fresh_static() {
        let mut s = server(&["qwen3:8b"]);
        let id = build_id(&s.id, "qwen3:8b");
        let before = find_in(std::slice::from_ref(&s), &id).unwrap();
        s.models[0].label = "Qwen3 8B (fast)".into();
        let after = find_in(std::slice::from_ref(&s), &id).unwrap();
        assert!(!std::ptr::eq(before, after));
        // The point of keying on the whole spec: no stale read.
        assert_eq!(after.label, "Qwen3 8B (fast)");
        assert_eq!(before.label, "qwen3:8b");
    }

    #[test]
    fn editing_a_url_mints_a_fresh_static_too() {
        // The base URL reaches `description`, so it IS part of the spec. Worth
        // pinning: it means a URL edit is visible in the settings list.
        let mut s = server(&["qwen3:8b"]);
        let id = build_id(&s.id, "qwen3:8b");
        let before = find_in(std::slice::from_ref(&s), &id).unwrap();
        s.base_url = "http://10.0.0.9:11434".into();
        let after = find_in(std::slice::from_ref(&s), &id).unwrap();
        assert!(!std::ptr::eq(before, after));
        assert!(after.description.contains("10.0.0.9"));
    }

    #[test]
    fn a_remote_model_can_neither_reason_nor_fetch_nor_load() {
        let s = server(&["qwen3:8b"]);
        let m = find_in(std::slice::from_ref(&s), &build_id(&s.id, "qwen3:8b")).unwrap();
        assert!(m.efforts.is_empty(), "no rungs, so no reasoning_effort");
        // `catalog`'s default_effort_is_always_supported cannot see this entry.
        assert_eq!(m.default_effort, Effort::Off);
        assert!(!m.native_web_fetch);
        assert!(m.local.is_none());
        assert_eq!(m.provider, ProviderId::Remote);
        assert_eq!(m.wire_model, "qwen3:8b");
        // The id namespacing rule CATALOG entries are held to.
        assert!(m.id.starts_with(&format!("{}/", m.provider.as_str())));
    }

    #[test]
    fn find_in_locates_a_model_across_servers() {
        let mut a = server(&["qwen3:8b"]);
        a.id = "aaa".into();
        let mut b = server(&["gemma3:27b"]);
        b.id = "bbb".into();
        let servers = vec![a, b];
        assert!(find_in(&servers, "remote/bbb/gemma3:27b").is_some());
        // Right server, wrong model, and vice versa.
        assert!(find_in(&servers, "remote/aaa/gemma3:27b").is_none());
        assert!(find_in(&servers, "remote/ccc/qwen3:8b").is_none());
    }

    #[test]
    fn the_stored_kind_keeps_its_wire_spelling() {
        // serde's snake_case would write "lm_studio" / "open_ai_compatible", and
        // a rename here silently orphans every stored server.
        for (kind, wire) in [
            (ServerKind::Ollama, "\"ollama\""),
            (ServerKind::LmStudio, "\"lmstudio\""),
            (ServerKind::OpenAiCompatible, "\"openai_compatible\""),
        ] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), wire);
            assert_eq!(ServerKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(ServerKind::parse("lm_studio"), None);
    }

    #[test]
    fn a_record_written_before_a_field_existed_still_loads() {
        let old = serde_json::json!([{
            "id": "aaa", "kind": "lmstudio", "label": "Studio",
            "base_url": "http://localhost:1234"
            // no `models`
        }]);
        let servers: Vec<RemoteServer> = serde_json::from_value(old).unwrap();
        assert!(servers[0].models.is_empty());

        let old_model = serde_json::json!({
            "wire_model": "m", "label": "m", "context_tokens": 8192
            // no `supports_vision` / `supports_tools`
        });
        let m: RemoteModel = serde_json::from_value(old_model).unwrap();
        assert!(!m.supports_vision);
        assert!(m.supports_tools, "silence must not disable agent mode");
    }

    #[test]
    fn owns_model_id_only_matches_its_own_server() {
        let s = server(&["qwen3:8b"]);
        assert!(owns_model_id(&s, "remote/3f9a-uuid/qwen3:8b"));
        assert!(!owns_model_id(&s, "remote/other/qwen3:8b"));
        assert!(!owns_model_id(&s, "local/qwen3.5-9b"));
    }
}
