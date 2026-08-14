//! CRUD over the configured remote inference servers, plus the one command that
//! actually talks to one.
//!
//! `validate` here is the real trust boundary, not the settings form. A record can
//! be hand-edited in `settings.json`, and its `base_url` becomes the host every
//! subsequent chat request is sent to — so the frontend's checks are a
//! convenience, and this is the layer that has to hold.
//!
//! Two shapes are deliberate and worth not "simplifying" later:
//!
//! - **The token has its own command, and is accepted on create only.** An update
//!   payload cannot express keep-vs-clear: JSON null is indistinguishable from
//!   "not provided" once serde sees `Option` over Tauri IPC, so an untouched
//!   password field would silently wipe a stored token. Create is the one call
//!   where "keep" cannot arise.
//! - **The probe takes an id, so a server is saved before it is tested.** That
//!   keeps one validated persistence path, and it lets the probe use the STORED
//!   token, which the UI can never read back.

use tauri::Wry;

use crate::models::remote::{self, RemoteModel, RemoteServer, ServerKind};
use crate::models::remote_probe::{self, ProbeResult};

/// Plenty for a real setup, and a bound on what a hostile server can persist.
const MAX_ENABLED_MODELS: usize = 200;
const MAX_LABEL_CHARS: usize = 64;

/// What the settings form sends. No token — see the module doc.
#[derive(Debug, serde::Deserialize)]
pub struct RemoteServerInput {
    pub kind: String,
    pub label: String,
    pub base_url: String,
}

/// A stored server as the UI sees it: the record plus whether a token exists.
#[derive(Debug, serde::Serialize)]
pub struct RemoteServerView {
    #[serde(flatten)]
    pub server: RemoteServer,
    /// Presence only. The token itself never crosses this boundary.
    pub has_api_key: bool,
}

fn has_control_chars(s: &str) -> bool {
    s.chars().any(char::is_control)
}

/// Trims, checks, and normalizes in place. Returns the parsed kind.
fn validate(input: &mut RemoteServerInput) -> Result<ServerKind, String> {
    input.label = input.label.trim().to_string();
    input.base_url = input.base_url.trim().to_string();

    if has_control_chars(&input.label) || has_control_chars(&input.base_url) {
        return Err("server fields cannot contain control characters".into());
    }
    if input.label.is_empty() {
        return Err("a label is required".into());
    }
    if input.label.chars().count() > MAX_LABEL_CHARS {
        return Err(format!(
            "the label is too long (max {MAX_LABEL_CHARS} characters)"
        ));
    }
    let kind = ServerKind::parse(&input.kind)
        .ok_or_else(|| format!("unknown server type \"{}\"", input.kind))?;
    // The same normalization the probe applies, so what is stored is exactly what
    // gets talked to — no drift between the two.
    input.base_url = remote_probe::normalize_base_url(&input.base_url, kind)?;
    Ok(kind)
}

/// Trims and bounds a model list arriving from the picker.
fn clean_models(models: Vec<RemoteModel>) -> Result<Vec<RemoteModel>, String> {
    let mut out: Vec<RemoteModel> = Vec::new();
    for mut m in models.into_iter().take(MAX_ENABLED_MODELS) {
        m.wire_model = m.wire_model.trim().to_string();
        m.label = m.label.trim().to_string();
        if m.wire_model.is_empty() {
            return Err("a model needs a name".into());
        }
        if has_control_chars(&m.wire_model) || has_control_chars(&m.label) {
            return Err("model names cannot contain control characters".into());
        }
        if m.label.is_empty() {
            m.label = m.wire_model.clone();
        }
        if m.label.chars().count() > MAX_LABEL_CHARS {
            m.label = m.label.chars().take(MAX_LABEL_CHARS).collect();
        }
        // Advisory, but a zero would render as "0K context" and a huge value
        // would claim something no server serves.
        m.context_tokens = m.context_tokens.clamp(512, 2_000_000);
        // The wire model is the identity: a duplicate would produce two rows
        // with the same model id.
        if out.iter().any(|kept| kept.wire_model == m.wire_model) {
            continue;
        }
        out.push(m);
    }
    Ok(out)
}

fn find_index(servers: &[RemoteServer], id: &str) -> Result<usize, String> {
    servers
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| "no such server".to_string())
}

fn server_views_with_presence(
    servers: Vec<RemoteServer>,
    mut has: impl FnMut(&str) -> Result<bool, String>,
) -> Result<Vec<RemoteServerView>, String> {
    servers
        .into_iter()
        .map(|server| {
            Ok(RemoteServerView {
                has_api_key: has(&server.id)?,
                server,
            })
        })
        .collect()
}

fn server_with_token<'a>(
    servers: &'a [RemoteServer],
    id: &str,
    mut read: impl FnMut(&str) -> Result<Option<crate::credentials::Secret>, String>,
) -> Result<(&'a RemoteServer, Option<crate::credentials::Secret>), String> {
    let server = &servers[find_index(servers, id)?];
    let token = read(&server.id)?;
    Ok((server, token))
}

#[tauri::command]
pub fn remote_servers_list(app: tauri::AppHandle<Wry>) -> Result<Vec<RemoteServerView>, String> {
    server_views_with_presence(remote::read_servers(&app), |id| remote::has_token(&app, id))
}

/// Returns the new server's id.
#[tauri::command(rename_all = "snake_case")]
pub fn remote_servers_create(
    app: tauri::AppHandle<Wry>,
    server: RemoteServerInput,
    api_key: Option<String>,
) -> Result<String, String> {
    let mut input = server;
    let kind = validate(&mut input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let api_key = api_key.filter(|key| !key.trim().is_empty());
    remote_probe::ensure_credential_transport(&input.base_url, api_key.is_some())?;

    let mut servers = remote::read_servers(&app);
    servers.push(RemoteServer {
        id: id.clone(),
        kind,
        label: input.label,
        base_url: input.base_url,
        models: Vec::new(),
    });
    if let Some(key) = api_key.as_deref() {
        remote::write_token(&app, &id, key)?;
    }
    if let Err(error) = remote::write_servers(&app, &servers) {
        let _ = remote::write_token(&app, &id, "");
        return Err(error);
    }
    Ok(id)
}

/// Edit a server's kind, label or address.
///
/// Deliberately cannot set `models` or a token: both have their own commands.
/// Moving to a different origin clears the old origin's token before persistence;
/// the stable id still keeps `active_model_id` and per-model effort intact.
#[tauri::command(rename_all = "snake_case")]
pub fn remote_servers_update(
    app: tauri::AppHandle<Wry>,
    id: String,
    server: RemoteServerInput,
) -> Result<(), String> {
    let mut input = server;
    let kind = validate(&mut input)?;
    let mut servers = remote::read_servers(&app);
    let at = find_index(&servers, &id)?;
    let origin_changed = !remote_probe::same_origin(&servers[at].base_url, &input.base_url);
    if origin_changed {
        // A credential belongs to the old trust boundary. Delete it before the
        // new origin can be persisted, even when both origins use HTTPS.
        remote::write_token(&app, &id, "")?;
    } else {
        remote_probe::ensure_credential_transport(&input.base_url, remote::has_token(&app, &id)?)?;
    }
    servers[at].kind = kind;
    servers[at].label = input.label;
    servers[at].base_url = input.base_url;
    remote::write_servers(&app, &servers)
}

/// Forget a server, its token, and its selection.
///
/// Resetting `active_model_id` is not tidiness: `models_catalog` would stop
/// returning the row, `catalog.find` in the frontend would miss it, and the
/// readiness check falls back to the on-device signal — which reports READY when
/// a local model happens to be loaded, for a model that cannot answer.
#[tauri::command(rename_all = "snake_case")]
pub fn remote_servers_delete(app: tauri::AppHandle<Wry>, id: String) -> Result<(), String> {
    let mut servers = remote::read_servers(&app);
    let at = find_index(&servers, &id)?;
    let removed = servers.remove(at);
    remote::write_token(&app, &id, "")?;
    remote::write_servers(&app, &servers)?;

    let active =
        crate::commands::settings::read_string(&app, "active_model_id").unwrap_or_default();
    if remote::owns_model_id(&removed, &active) {
        crate::commands::settings::write_active_model_id(
            &app,
            crate::models::catalog::DEFAULT_MODEL_ID,
        )?;
    }
    Ok(())
}

/// Write-only, like every secret in this app: an EMPTY STRING clears, and the
/// stored value is never readable back.
#[tauri::command(rename_all = "snake_case")]
pub fn remote_servers_set_api_key(
    app: tauri::AppHandle<Wry>,
    id: String,
    api_key: String,
) -> Result<(), String> {
    let servers = remote::read_servers(&app);
    let at = find_index(&servers, &id)?;
    remote_probe::ensure_credential_transport(&servers[at].base_url, !api_key.trim().is_empty())?;
    remote::write_token(&app, &id, &api_key)
}

/// Replace one server's enabled set, whole.
///
/// Not per-model toggles: the picker is a checkbox list behind one Save, and N
/// toggles would be N read-modify-writes for a single gesture. The probe's
/// enriched values come back verbatim, so enabling costs no second round trip.
#[tauri::command(rename_all = "snake_case")]
pub fn remote_servers_set_models(
    app: tauri::AppHandle<Wry>,
    id: String,
    models: Vec<RemoteModel>,
) -> Result<(), String> {
    let cleaned = clean_models(models)?;
    let mut servers = remote::read_servers(&app);
    let at = find_index(&servers, &id)?;

    // Unticking the selected model orphans it the same way deleting the server
    // does, so it gets the same reset.
    let active =
        crate::commands::settings::read_string(&app, "active_model_id").unwrap_or_default();
    let dropped = remote::parse_id(&active).is_some_and(|(server_id, wire_model)| {
        server_id == servers[at].id && !cleaned.iter().any(|m| m.wire_model == wire_model)
    });

    servers[at].models = cleaned;
    remote::write_servers(&app, &servers)?;
    if dropped {
        crate::commands::settings::write_active_model_id(
            &app,
            crate::models::catalog::DEFAULT_MODEL_ID,
        )?;
    }
    Ok(())
}

/// Ask a saved server what it serves. The only command here that reaches the
/// network, and it only runs when the user presses Test.
#[tauri::command(rename_all = "snake_case")]
pub async fn remote_servers_probe(
    app: tauri::AppHandle<Wry>,
    id: String,
) -> Result<ProbeResult, String> {
    let servers = remote::read_servers(&app);
    let (server, token) = server_with_token(&servers, &id, |server_id| {
        remote::read_token(&app, server_id)
    })?;
    remote_probe::probe(
        server.kind,
        &server.base_url,
        token.as_ref().map(crate::credentials::Secret::expose),
        &server.models,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: &str, label: &str, base_url: &str) -> RemoteServerInput {
        RemoteServerInput {
            kind: kind.into(),
            label: label.into(),
            base_url: base_url.into(),
        }
    }

    fn saved_server(id: &str) -> RemoteServer {
        RemoteServer {
            id: id.into(),
            kind: ServerKind::Ollama,
            label: format!("Server {id}"),
            base_url: "http://localhost:11434".into(),
            models: Vec::new(),
        }
    }

    #[test]
    fn remote_lists_use_presence_and_probe_setup_reads_one_token() {
        let servers = vec![saved_server("one"), saved_server("two")];
        let mut presence_calls = Vec::new();
        let views = server_views_with_presence(servers.clone(), |id| {
            presence_calls.push(id.to_owned());
            Ok(id == "one")
        })
        .unwrap();
        assert_eq!(presence_calls, vec!["one", "two"]);
        assert!(views[0].has_api_key);
        assert!(!views[1].has_api_key);

        let error = server_views_with_presence(servers.clone(), |_| Err("presence denied".into()))
            .unwrap_err();
        assert_eq!(error, "presence denied");

        let mut reads = 0;
        let (selected, token) = server_with_token(&servers, "two", |id| {
            reads += 1;
            assert_eq!(id, "two");
            Ok(Some(crate::credentials::Secret::from("remote-secret")))
        })
        .unwrap();
        assert_eq!(reads, 1);
        assert_eq!(selected.id, "two");
        assert_eq!(token.unwrap().expose(), "remote-secret");
    }

    #[test]
    fn validate_trims_and_normalizes() {
        let mut i = input("ollama", "  Workstation  ", "  localhost  ");
        assert_eq!(validate(&mut i).unwrap(), ServerKind::Ollama);
        assert_eq!(i.label, "Workstation");
        // The stored address is the one the probe will use — no drift.
        assert_eq!(i.base_url, "http://localhost:11434");
    }

    #[test]
    fn validate_rejects_what_must_never_be_stored() {
        let cases = [
            input("ollama", "", "localhost"),
            input("ollama", "ok", ""),
            input("lm_studio", "ok", "localhost"),
            input("", "ok", "localhost"),
            input("ollama", "bad\nlabel", "localhost"),
            input("ollama", "ok", "http://user:pw@host:11434"),
            input("ollama", "ok", "ftp://host"),
            input("ollama", &"x".repeat(MAX_LABEL_CHARS + 1), "localhost"),
        ];
        for mut case in cases {
            let described = format!("{case:?}");
            assert!(
                validate(&mut case).is_err(),
                "{described} should be rejected"
            );
        }
    }

    #[test]
    fn changing_server_origin_requires_the_existing_token_to_be_removed() {
        assert!(!remote_probe::same_origin(
            "https://old.example.test/v1",
            "https://new.example.test/v1"
        ));
        assert!(!remote_probe::same_origin(
            "http://localhost:11434",
            "https://localhost:11434"
        ));
        assert!(remote_probe::same_origin(
            "https://same.example.test/one",
            "https://same.example.test/two"
        ));
    }

    fn model(wire: &str, ctx: u32) -> RemoteModel {
        RemoteModel {
            wire_model: wire.into(),
            label: String::new(),
            context_tokens: ctx,
            supports_vision: false,
            supports_tools: true,
        }
    }

    #[test]
    fn clean_models_fills_a_missing_label_and_clamps_context() {
        let out = clean_models(vec![model("qwen3:8b", 0)]).unwrap();
        assert_eq!(
            out[0].label, "qwen3:8b",
            "a row with no label is unreadable"
        );
        assert_eq!(out[0].context_tokens, 512);
        let out = clean_models(vec![model("m", u32::MAX)]).unwrap();
        assert_eq!(out[0].context_tokens, 2_000_000);
    }

    #[test]
    fn clean_models_drops_duplicates_and_caps_the_list() {
        let out = clean_models(vec![model("a", 4096), model("a", 8192), model("b", 4096)]).unwrap();
        // The wire model is the identity — two rows would mint the same model id.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].context_tokens, 4096, "first wins");

        let many: Vec<RemoteModel> = (0..MAX_ENABLED_MODELS + 20)
            .map(|i| model(&format!("m{i}"), 4096))
            .collect();
        assert_eq!(clean_models(many).unwrap().len(), MAX_ENABLED_MODELS);
    }

    #[test]
    fn clean_models_rejects_a_nameless_or_control_char_model() {
        assert!(clean_models(vec![model("   ", 4096)]).is_err());
        assert!(clean_models(vec![model("a\rb", 4096)]).is_err());
    }
}
