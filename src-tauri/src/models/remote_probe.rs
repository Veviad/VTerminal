//! Asking a configured server what it serves.
//!
//! This is the only place in the app that reaches a user-named host, and it runs
//! exclusively behind an explicit "Test" gesture — `models_catalog` and app start
//! read settings only. The result is a list of *candidates*; the user ticks what
//! they want and `remote_servers_set_models` persists it, metadata included, so
//! nothing has to be re-probed to list a model later.
//!
//! Two deliberate departures from `provider::http`:
//!
//! - **Its own client, with a total timeout and no retries.** The shared client
//!   allows 20 s to connect and `send_with_retry` tries three times with backoff,
//!   so a typo'd LAN address would spin for about a minute before saying so. A
//!   probe response is small and bounded, which is exactly the case where a total
//!   timeout is right (a chat stream is not).
//! - **Its own error text.** `http::status_error` tells a 401 to "check the API
//!   key in Settings → Models", which is the wrong field for a per-server token.

use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;

use super::remote::{RemoteModel, ServerKind};

/// A wrong address must fail fast; this is the whole point of not sharing the
/// provider client.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Total, not idle: every response here is a single small JSON document.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(8);
/// A 200-model Ollama host is real; anything above it is not worth allocating for.
const MAX_MODELS: usize = 200;
/// Beyond this we stop asking per-model questions and fall back to defaults.
const MAX_ENRICH: usize = 60;
/// Ollama needs one request per model; keep the LAN round trips overlapping.
const ENRICH_CONCURRENCY: usize = 6;
/// Guard against an endpoint that streams megabytes at us.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(concat!("vterminal/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(TOTAL_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Normalize whatever the user typed into a base the probe appends paths to.
///
/// Pure and total: no I/O, no DNS. Returns scheme + authority + an optional path
/// prefix, with no trailing slash and no `/v1` — every caller appends its own
/// full path. A non-API path prefix is PRESERVED, because LiteLLM behind a
/// reverse proxy at `/llm` is a legitimate setup.
pub fn normalize_base_url(input: &str, kind: ServerKind) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("a server address is required".into());
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("a server address cannot contain spaces or control characters".into());
    }

    // No scheme means http, NOT https: these are localhost and LAN servers, and
    // defaulting to TLS fails the common case with a handshake error rather than
    // connecting.
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };

    // Decide the default port on the authority SUBSTRING, before parsing:
    // `Url::port()` returns None both for "no port given" and for "the scheme's
    // own default", so `http://host:80` would otherwise silently become :11434.
    let with_port = match kind.default_port() {
        Some(port) if explicit_port(&with_scheme).is_none() => {
            let (head, tail) = split_authority(&with_scheme);
            format!("{head}:{port}{tail}")
        }
        _ => with_scheme,
    };

    let url = url::Url::parse(&with_port).map_err(|e| format!("not a valid address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http:// and https:// addresses are supported".into());
    }
    if url.cannot_be_a_base() || url.host_str().unwrap_or_default().is_empty() {
        return Err("that address has no host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(
            "a server address cannot carry a username or password — use the token field instead"
                .into(),
        );
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("drop the query string — this is a base address".into());
    }
    if url.port() == Some(0) {
        return Err("port must be between 1 and 65535".into());
    }

    // Host from the parser (lowercased, punycoded, brackets intact) but the port
    // from the RAW authority: the parser stores a scheme-default port as `None`,
    // so rebuilding from `url.port()` would quietly drop the `:80` the user typed.
    let host = url.host_str().unwrap_or_default();
    let authority = match explicit_port(&with_port) {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    // Only these two suffixes are stripped: pasting an OpenAI-style base URL is
    // the common mistake, and left alone it would request `/v1/v1/models` — a 404
    // that reads exactly like the server being down.
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/v1").unwrap_or(path);
    Ok(format!("{}://{authority}{path}", url.scheme()))
}

/// Everything from after `://` up to the first `/`, `?` or `#`.
fn authority_span(url: &str) -> (usize, usize) {
    let start = url.find("://").map(|i| i + 3).unwrap_or(0);
    let end = url[start..]
        .find(['/', '?', '#'])
        .map(|i| start + i)
        .unwrap_or(url.len());
    (start, end)
}

fn split_authority(url: &str) -> (&str, &str) {
    let (_, end) = authority_span(url);
    url.split_at(end)
}

/// The port the user actually typed, if any — ignoring the colons inside a
/// bracketed IPv6 literal, and ignoring a bare trailing colon.
fn explicit_port(url: &str) -> Option<&str> {
    let (start, end) = authority_span(url);
    let authority = &url[start..end];
    // `[::1]:1234` — a port only counts after the closing bracket.
    let colon = match authority.rfind(']') {
        Some(bracket) => authority[bracket + 1..]
            .find(':')
            .map(|i| bracket + 1 + i)?,
        None => authority.find(':')?,
    };
    Some(&authority[colon + 1..]).filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// What a server said it serves. Every candidate is returned, including ones the
/// user almost certainly does not want — see `role`.
#[derive(Debug, Clone, Serialize)]
pub struct ProbeCandidate {
    /// Verbatim `/v1/models[].id`, which is what the chat request must send.
    pub wire_model: String,
    pub label: String,
    pub context_tokens: u32,
    /// False when `context_tokens` is this kind's default rather than something
    /// the server actually reported.
    pub enriched: bool,
    pub supports_vision: bool,
    pub supports_tools: bool,
    /// "chat" | "embedding" | "rerank" | "unknown". Embedding and rerank models
    /// are FLAGGED, never filtered: dropping them server-side would make a
    /// legitimately-named chat model unselectable with no recourse. The picker
    /// pre-unchecks anything that is not "chat".
    pub role: String,
    /// LM Studio only: "loaded" | "not-loaded". Tells the user the first request
    /// will pay for a model load.
    pub state: Option<String>,
    /// Already enabled for this server — the picker pre-checks these.
    pub already_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    /// The normalized base actually talked to.
    pub base_url: String,
    /// The exact URL asked for the model list, so the UI never has to predict it.
    pub endpoint: String,
    pub models: Vec<ProbeCandidate>,
    /// Non-fatal notes: enrichment unavailable, list truncated, kind looks wrong.
    /// A hard failure is an `Err`, not a warning.
    pub warnings: Vec<String>,
}

/// Ask a server what it serves.
pub async fn probe(
    kind: ServerKind,
    base_url: &str,
    token: Option<&str>,
    already_enabled: &[RemoteModel],
) -> Result<ProbeResult, String> {
    let base = normalize_base_url(base_url, kind)?;
    let endpoint = format!("{base}/v1/models");
    let mut warnings = Vec::new();

    let body = get_json(&endpoint, token).await.map_err(|e| match e {
        ProbeError::Transport(detail) => format!(
            "could not reach {base} — check the address and that the server is running ({detail})"
        ),
        ProbeError::Status(401) | ProbeError::Status(403) => {
            format!("{base} rejected the token — add or correct it and test again")
        }
        ProbeError::Status(404) => format!(
            "{base} answered but serves no /v1/models — is this a {} server?",
            kind.label()
        ),
        ProbeError::Status(code) => format!("{base} answered HTTP {code}"),
        ProbeError::Body(detail) => format!("{base} did not answer with JSON ({detail})"),
    })?;

    let mut models = parse_v1_models(&body, kind, already_enabled);
    if models.is_empty() {
        return Ok(ProbeResult {
            base_url: base,
            endpoint,
            models,
            warnings,
        });
    }
    if models.len() > MAX_MODELS {
        warnings.push(format!(
            "this server reported {} models — showing the first {MAX_MODELS}",
            models.len()
        ));
        models.truncate(MAX_MODELS);
    }

    enrich(kind, &base, token, &mut models, &mut warnings).await;

    Ok(ProbeResult {
        base_url: base,
        endpoint,
        models,
        warnings,
    })
}

/// `/v1/models` is the one endpoint all three kinds serve, and the only source of
/// `wire_model` — that string is what goes on the wire, so it must never come
/// from a richer-but-different native listing.
pub fn parse_v1_models(
    body: &Value,
    kind: ServerKind,
    already_enabled: &[RemoteModel],
) -> Vec<ProbeCandidate> {
    let Some(list) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .map(|id| {
            let existing = already_enabled.iter().find(|m| m.wire_model == id);
            ProbeCandidate {
                wire_model: id.to_string(),
                // Keep the user's own label across a re-probe.
                label: existing.map_or_else(|| id.to_string(), |m| m.label.clone()),
                context_tokens: kind.default_context(),
                enriched: false,
                supports_vision: false,
                supports_tools: true,
                role: classify_role(id),
                state: None,
                already_enabled: existing.is_some(),
            }
        })
        .collect()
}

/// Best-effort metadata. Failure is never fatal: the candidate list is already
/// usable, it just carries this kind's defaults.
async fn enrich(
    kind: ServerKind,
    base: &str,
    token: Option<&str>,
    models: &mut [ProbeCandidate],
    warnings: &mut Vec<String>,
) {
    if models.len() > MAX_ENRICH {
        warnings.push(format!(
            "only the first {MAX_ENRICH} models were inspected in detail — the rest show \
             assumed context sizes"
        ));
    }
    match kind {
        // One request covers every model, and it is the only place LM Studio
        // reports a context length at all.
        ServerKind::LmStudio => match get_json(&format!("{base}/api/v0/models"), token).await {
            Ok(body) => apply_lmstudio_models(models, &body),
            Err(_) => warnings.push(
                "this server did not answer /api/v0/models, so context sizes below are assumed"
                    .into(),
            ),
        },
        ServerKind::Ollama => {
            let n = models.len().min(MAX_ENRICH);
            let details: Vec<(usize, Option<Value>)> = futures::stream::iter(0..n)
                .map(|i| {
                    let url = format!("{base}/api/show");
                    let name = models[i].wire_model.clone();
                    async move {
                        let body = serde_json::json!({ "model": name });
                        (i, post_json(&url, token, &body).await.ok())
                    }
                })
                .buffer_unordered(ENRICH_CONCURRENCY)
                .collect()
                .await;
            let answered = details.iter().filter(|(_, b)| b.is_some()).count();
            for (i, body) in details {
                if let Some(body) = body {
                    apply_ollama_show(&mut models[i], &body);
                }
            }
            if answered == 0 {
                // Free diagnostic for the commonest configuration mistake: the
                // list endpoint is generic, /api/show is not.
                warnings.push(format!(
                    "{base} serves /v1/models but not /api/show — if this is not Ollama, pick \
                     \"OpenAI-compatible\" instead"
                ));
            }
        }
        // Nothing to ask. Everything stays at the per-kind default, flagged.
        ServerKind::OpenAiCompatible => warnings.push(
            "an OpenAI-compatible server does not report context sizes or capabilities, so the \
             values below are assumed"
                .into(),
        ),
    }
}

/// LM Studio's native listing: `max_context_length`, `type` (llm/vlm/embeddings)
/// and `state` (loaded/not-loaded), joined on the same id `/v1/models` reported.
pub fn apply_lmstudio_models(models: &mut [ProbeCandidate], body: &Value) {
    let Some(list) = body.get("data").and_then(Value::as_array) else {
        return;
    };
    for entry in list {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(model) = models.iter_mut().find(|m| m.wire_model == id) else {
            continue;
        };
        if let Some(ctx) = entry
            .get("max_context_length")
            .and_then(Value::as_u64)
            .filter(|c| *c > 0)
        {
            // The MODEL's maximum, not the loaded context — still an upper bound,
            // which is all this field claims to be.
            model.context_tokens = ctx.min(u64::from(u32::MAX)) as u32;
            model.enriched = true;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("embeddings") => model.role = "embedding".into(),
            Some("vlm") => {
                model.role = "chat".into();
                model.supports_vision = true;
            }
            Some("llm") => model.role = "chat".into(),
            _ => {}
        }
        if let Some(state) = entry.get("state").and_then(Value::as_str) {
            model.state = Some(state.to_string());
        }
    }
}

/// Ollama's `/api/show`: `capabilities` is the authoritative answer for tools and
/// vision, and `model_info` carries the context length under an architecture-
/// prefixed key ("qwen3.context_length"), which is why we search rather than
/// guess the prefix.
pub fn apply_ollama_show(model: &mut ProbeCandidate, body: &Value) {
    if let Some(caps) = body.get("capabilities").and_then(Value::as_array) {
        let has = |name: &str| caps.iter().any(|c| c.as_str() == Some(name));
        model.supports_tools = has("tools");
        model.supports_vision = has("vision");
        // No completion capability means this is not a chat model at all.
        model.role = if has("completion") {
            "chat".into()
        } else if has("embedding") {
            "embedding".into()
        } else {
            classify_role(&model.wire_model)
        };
    }
    if let Some(info) = body.get("model_info").and_then(Value::as_object) {
        if let Some(ctx) = info
            .iter()
            .find(|(k, _)| k.ends_with(".context_length"))
            .and_then(|(_, v)| v.as_u64())
            .filter(|c| *c > 0)
        {
            model.context_tokens = ctx.min(u64::from(u32::MAX)) as u32;
            model.enriched = true;
        }
    }
}

/// Name-shape guess, used only where the server tells us nothing. A hint for the
/// picker's pre-check, never a filter.
pub fn classify_role(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    const EMBED: [&str; 8] = [
        "embed",
        "-emb",
        "bge-",
        "gte-",
        "e5-",
        "nomic-embed",
        "text-embedding",
        "all-minilm",
    ];
    const OTHER: [&str; 4] = ["rerank", "clip", "whisper", "-tts"];
    if EMBED.iter().any(|n| lower.contains(n)) {
        "embedding".into()
    } else if lower.contains("rerank") {
        "rerank".into()
    } else if OTHER.iter().any(|n| lower.contains(n)) {
        "unknown".into()
    } else {
        "chat".into()
    }
}

// ------------------------------------------------------------------ transport

enum ProbeError {
    Transport(String),
    Status(u16),
    Body(String),
}

async fn get_json(url: &str, token: Option<&str>) -> Result<Value, ProbeError> {
    let mut req = client().map_err(ProbeError::Transport)?.get(url);
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    read_json(req).await
}

async fn post_json(url: &str, token: Option<&str>, body: &Value) -> Result<Value, ProbeError> {
    let mut req = client()
        .map_err(ProbeError::Transport)?
        .post(url)
        .json(body);
    if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
        req = req.bearer_auth(t);
    }
    read_json(req).await
}

/// One attempt, no retry. If a server 500s once, saying so immediately beats
/// three tries: the user is standing at the form waiting for an answer.
async fn read_json(req: reqwest::RequestBuilder) -> Result<Value, ProbeError> {
    let resp = req
        .send()
        .await
        .map_err(|e| ProbeError::Transport(short_transport_error(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ProbeError::Status(status.as_u16()));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| ProbeError::Body(e.to_string()))?;
    if text.len() > MAX_BODY_BYTES {
        return Err(ProbeError::Body("response too large".into()));
    }
    serde_json::from_str(&text).map_err(|e| ProbeError::Body(e.to_string()))
}

/// reqwest's Display chains every source, which for a refused connection reads
/// like a stack trace. Keep the sentence the user needs.
fn short_transport_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "timed out".into();
    }
    if e.is_connect() {
        return "connection refused".into();
    }
    e.to_string().chars().take(120).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLLAMA: ServerKind = ServerKind::Ollama;
    const LMS: ServerKind = ServerKind::LmStudio;
    const GENERIC: ServerKind = ServerKind::OpenAiCompatible;

    #[test]
    fn normalizes_every_shape_a_user_types() {
        let cases: &[(&str, ServerKind, &str)] = &[
            ("host:11434", OLLAMA, "http://host:11434"),
            ("http://host:11434", OLLAMA, "http://host:11434"),
            ("http://host:11434/", OLLAMA, "http://host:11434"),
            ("  http://host:11434  ", OLLAMA, "http://host:11434"),
            // A bare host takes the kind's own port.
            ("localhost", OLLAMA, "http://localhost:11434"),
            ("localhost", LMS, "http://localhost:1234"),
            ("192.168.1.5", LMS, "http://192.168.1.5:1234"),
            // A pasted OpenAI-style base loses only the /v1.
            ("http://host:1234/v1", LMS, "http://host:1234"),
            ("http://host:1234/v1/", LMS, "http://host:1234"),
            ("HTTP://Host:11434", OLLAMA, "http://host:11434"),
            ("http://[::1]:11434", OLLAMA, "http://[::1]:11434"),
            // Bare IPv6 literal: the colons inside the brackets are not a port.
            ("http://[::1]", OLLAMA, "http://[::1]:11434"),
            // The generic kind guesses no port, so the scheme default stands.
            (
                "https://api.example.com",
                GENERIC,
                "https://api.example.com",
            ),
            // A non-API path prefix is legitimate — a proxied LiteLLM.
            (
                "https://gw.example.com/llm/v1",
                GENERIC,
                "https://gw.example.com/llm",
            ),
        ];
        for (input, kind, want) in cases {
            assert_eq!(
                normalize_base_url(input, *kind).as_deref(),
                Ok(*want),
                "input {input:?}"
            );
        }
    }

    #[test]
    fn an_explicitly_given_default_port_is_not_replaced() {
        // `Url::port()` answers None for a scheme-default port, so deciding this
        // after parsing would turn :80 into :11434 behind the user's back.
        assert_eq!(
            normalize_base_url("http://host:80", OLLAMA).unwrap(),
            "http://host:80"
        );
        assert_eq!(
            normalize_base_url("https://host:443", LMS).unwrap(),
            "https://host:443"
        );
    }

    #[test]
    fn rejects_addresses_it_must_not_store() {
        for bad in [
            "",
            "   ",
            "ftp://host",
            "file:///etc/passwd",
            "ws://host:1234",
            // Credentials would be persisted in plaintext and sent to whatever
            // host follows them.
            "http://user:pw@host:11434",
            "http://host:11434?key=abc",
            "http://host:11434#frag",
            "http://host:11434/a b",
        ] {
            assert!(
                normalize_base_url(bad, OLLAMA).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn normalization_is_idempotent() {
        for input in [
            "localhost",
            "http://host:11434/v1",
            "https://gw.example.com/llm/v1",
            "http://[::1]",
        ] {
            let once = normalize_base_url(input, OLLAMA).unwrap();
            let twice = normalize_base_url(&once, OLLAMA).unwrap();
            assert_eq!(once, twice, "input {input:?}");
        }
    }

    fn v1_models(ids: &[&str]) -> Value {
        serde_json::json!({
            "object": "list",
            "data": ids.iter().map(|id| serde_json::json!({
                "id": id, "object": "model", "owned_by": "library"
            })).collect::<Vec<_>>(),
        })
    }

    #[test]
    fn parses_an_ollama_style_model_list() {
        let models = parse_v1_models(&v1_models(&["qwen3:8b", "gemma3:27b"]), OLLAMA, &[]);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].wire_model, "qwen3:8b");
        assert_eq!(models[0].label, "qwen3:8b");
        // Nothing is claimed until enrichment says so.
        assert!(!models[0].enriched);
        assert_eq!(models[0].context_tokens, OLLAMA.default_context());
        assert!(!models[0].already_enabled);
    }

    #[test]
    fn a_repo_qualified_id_survives_verbatim() {
        // LM Studio ids contain a slash, and this string is what the chat request
        // must send — so it must never be split or shortened.
        let id = "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF";
        let models = parse_v1_models(&v1_models(&[id]), LMS, &[]);
        assert_eq!(models[0].wire_model, id);
    }

    #[test]
    fn a_reprobe_keeps_the_users_label_and_precheck() {
        let enabled = vec![RemoteModel {
            wire_model: "qwen3:8b".into(),
            label: "The fast one".into(),
            context_tokens: 32_768,
            supports_vision: false,
            supports_tools: true,
        }];
        let models = parse_v1_models(&v1_models(&["qwen3:8b", "gemma3:27b"]), OLLAMA, &enabled);
        assert_eq!(models[0].label, "The fast one");
        assert!(models[0].already_enabled);
        assert!(!models[1].already_enabled);
    }

    #[test]
    fn a_junk_body_yields_no_candidates_rather_than_an_error() {
        for body in [
            serde_json::json!({}),
            serde_json::json!({"data": "nope"}),
            serde_json::json!({"data": [{"no_id": 1}]}),
            serde_json::json!({"data": [{"id": "  "}]}),
        ] {
            assert!(parse_v1_models(&body, OLLAMA, &[]).is_empty(), "{body}");
        }
    }

    #[test]
    fn ollama_show_supplies_capabilities_and_context() {
        let mut m = parse_v1_models(&v1_models(&["qwen3:8b"]), OLLAMA, &[]).remove(0);
        apply_ollama_show(
            &mut m,
            &serde_json::json!({
                "capabilities": ["completion", "tools", "thinking"],
                // Architecture-prefixed, hence the search for the suffix.
                "model_info": {"general.architecture": "qwen3", "qwen3.context_length": 262144},
            }),
        );
        assert_eq!(m.context_tokens, 262_144);
        assert!(m.enriched);
        assert!(m.supports_tools);
        assert!(!m.supports_vision);
        assert_eq!(m.role, "chat");
    }

    #[test]
    fn an_ollama_model_without_completion_is_not_a_chat_model() {
        let mut m = parse_v1_models(&v1_models(&["snowflake-arctic"]), OLLAMA, &[]).remove(0);
        // Name gives nothing away, so `capabilities` is the only signal.
        assert_eq!(m.role, "chat");
        apply_ollama_show(&mut m, &serde_json::json!({"capabilities": ["embedding"]}));
        assert_eq!(m.role, "embedding");
        assert!(!m.supports_tools, "no tools means agent mode cannot work");
    }

    #[test]
    fn lmstudio_metadata_supplies_context_type_and_state() {
        let mut models = parse_v1_models(
            &v1_models(&["qwen3-8b", "text-embedding-nomic", "gemma-3-vision"]),
            LMS,
            &[],
        );
        apply_lmstudio_models(
            &mut models,
            &serde_json::json!({"data": [
                {"id": "qwen3-8b", "type": "llm", "max_context_length": 40960, "state": "loaded"},
                {"id": "text-embedding-nomic", "type": "embeddings", "max_context_length": 2048},
                {"id": "gemma-3-vision", "type": "vlm", "max_context_length": 131072,
                 "state": "not-loaded"},
            ]}),
        );
        assert_eq!(models[0].context_tokens, 40_960);
        assert!(models[0].enriched);
        assert_eq!(models[0].state.as_deref(), Some("loaded"));
        assert_eq!(models[1].role, "embedding");
        assert_eq!(models[2].role, "chat");
        assert!(models[2].supports_vision);
        assert_eq!(models[2].state.as_deref(), Some("not-loaded"));
    }

    #[test]
    fn enrichment_that_says_nothing_leaves_a_marked_default() {
        let mut models = parse_v1_models(&v1_models(&["mystery"]), LMS, &[]);
        apply_lmstudio_models(&mut models, &serde_json::json!({"data": []}));
        assert_eq!(models[0].context_tokens, LMS.default_context());
        assert!(
            !models[0].enriched,
            "the UI has to be able to say this number is a guess"
        );
    }

    /// Serve canned replies on a real socket, one connection per request, until
    /// `requests` are answered. Returns the bound base URL and the paths hit.
    ///
    /// The pure parsers above are unit-tested; this exercises what they cannot —
    /// the URL join, a real GET/POST, the `Authorization` header, and whether the
    /// two-stage enrichment actually wires together.
    async fn fake_server(
        routes: Vec<(&'static str, &'static str)>,
        requests: usize,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for _ in 0..requests {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                log.lock().unwrap().push(head.clone());
                let body = routes
                    .iter()
                    .find(|(route, _)| *route == path.as_str())
                    .map(|(_, body)| *body);
                let response = match body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\
                             Connection: close\r\n\r\n"
                        .to_string(),
                };
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (base, seen)
    }

    #[tokio::test]
    async fn probing_a_real_socket_lists_and_enriches() {
        let (base, seen) = fake_server(
            vec![
                (
                    "/v1/models",
                    r#"{"data":[{"id":"qwen3:8b"},{"id":"nomic-embed-text"}]}"#,
                ),
                (
                    "/api/show",
                    r#"{"capabilities":["completion","tools"],
                        "model_info":{"qwen3.context_length":262144}}"#,
                ),
            ],
            // /v1/models, then one /api/show per model.
            3,
        )
        .await;

        let result = probe(OLLAMA, &base, Some("tok-123"), &[]).await.unwrap();

        assert_eq!(result.endpoint, format!("{base}/v1/models"));
        assert_eq!(result.models.len(), 2);
        // Enrichment reached the second endpoint and was applied.
        assert_eq!(result.models[0].context_tokens, 262_144);
        assert!(result.models[0].enriched);
        assert!(result.models[0].supports_tools);
        // A token given is a token sent — the probe is the place a wrong one is
        // meant to surface.
        let requests = seen.lock().unwrap().clone();
        assert!(
            requests.iter().all(|r| r.contains("Bearer tok-123")),
            "every probe request should carry the token: {requests:?}"
        );
    }

    #[tokio::test]
    async fn a_keyless_probe_sends_no_authorization_header() {
        let (base, seen) = fake_server(vec![("/v1/models", r#"{"data":[{"id":"m"}]}"#)], 2).await;
        probe(LMS, &base, None, &[]).await.unwrap();
        let requests = seen.lock().unwrap().clone();
        assert!(
            requests.iter().all(|r| !r.contains("Authorization")),
            "a keyless server must get no header at all: {requests:?}"
        );
    }

    #[tokio::test]
    async fn enrichment_that_404s_still_returns_a_usable_list() {
        // The failure mode that must never be fatal: the list endpoint is generic,
        // the metadata one is not, so picking the wrong kind still has to work.
        let (base, _) =
            fake_server(vec![("/v1/models", r#"{"data":[{"id":"qwen3:8b"}]}"#)], 2).await;
        let result = probe(OLLAMA, &base, None, &[]).await.unwrap();
        assert_eq!(result.models.len(), 1);
        assert!(!result.models[0].enriched);
        assert_eq!(result.models[0].context_tokens, OLLAMA.default_context());
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("OpenAI-compatible")),
            "the wrong-kind hint should be free: {:?}",
            result.warnings
        );
    }

    #[tokio::test]
    async fn an_unreachable_address_says_so_rather_than_hanging() {
        // Nothing is listening on this port. The message has to name the address
        // and the thing to check, not surface reqwest's source chain.
        let err = probe(OLLAMA, "http://127.0.0.1:1", None, &[])
            .await
            .unwrap_err();
        assert!(err.contains("could not reach"), "{err}");
        assert!(err.contains("127.0.0.1:1"), "{err}");
    }

    #[tokio::test]
    async fn a_missing_models_endpoint_names_the_kind() {
        let (base, _) = fake_server(vec![("/other", "{}")], 1).await;
        let err = probe(LMS, &base, None, &[]).await.unwrap_err();
        assert!(err.contains("LM Studio"), "{err}");
    }

    #[test]
    fn an_embedding_model_is_flagged_by_name_not_dropped() {
        let ids = [
            "nomic-embed-text",
            "bge-m3",
            "mxbai-rerank-large",
            "qwen3:8b",
        ];
        let models = parse_v1_models(&v1_models(&ids), GENERIC, &[]);
        assert_eq!(models.len(), 4, "nothing is ever filtered out");
        assert_eq!(models[0].role, "embedding");
        assert_eq!(models[1].role, "embedding");
        assert_eq!(models[2].role, "rerank");
        assert_eq!(models[3].role, "chat");
    }
}
