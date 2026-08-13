//! Cloud providers over HTTP + SSE.
//!
//! Two modules cover three vendors: OpenAI and Mistral both speak the OpenAI
//! Chat Completions shape and differ only in base URL and the name of their
//! reasoning parameter, so they share `openai_compat`. Anthropic's Messages API
//! is genuinely different (top-level `system`, typed content blocks,
//! `output_config.effort`) and gets its own module.

pub mod anthropic;
pub mod openai_compat;

use std::sync::OnceLock;
use std::time::Duration;

use futures::StreamExt;

use super::{ProviderError, ProviderEvent};

/// How many times a transient failure is retried before giving up.
const MAX_ATTEMPTS: u32 = 3;
/// A stream that goes this long without a single byte is treated as dead.
/// This is an IDLE timeout, not a total one: a long reasoning turn may
/// legitimately take minutes, but it does not go two minutes without a frame.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Shared client — genuinely one per process, so connections are pooled and a
/// conversation does not pay a TLS handshake per turn.
pub(crate) fn client() -> Result<&'static reqwest::Client, ProviderError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(concat!("vterminal/", env!("CARGO_PKG_VERSION")))
                // No TOTAL timeout — see IDLE_TIMEOUT. Cancellation is the
                // user's stop button, not a clock.
                .connect_timeout(Duration::from_secs(20))
                .read_timeout(IDLE_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| ProviderError::Http(e.clone()))
}

/// Statuses worth retrying: rate limits and transient server faults.
/// 529 is Anthropic's "overloaded".
fn is_transient(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504 | 529)
}

/// How long to wait before attempt `attempt` (1-based), honouring the server's
/// own `retry-after` when it sends one.
fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    // Cap a server-supplied delay: a provider asking for ten minutes should not
    // silently wedge the UI with no way to tell it is waiting.
    let capped = retry_after.map(|d| d.min(Duration::from_secs(30)));
    capped.unwrap_or_else(|| Duration::from_millis(500 * 2u64.pow(attempt.saturating_sub(1))))
}

fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// Send a request, retrying transient failures with backoff.
///
/// Only the INITIAL request is retried. Once the stream has started, partial
/// output has already reached the user and replaying the turn would duplicate
/// it — that case surfaces as an error instead.
///
/// This matters most in agent mode: `run_agent` propagates a provider error
/// with `?`, so before this a single 429 on round 7 of 10 discarded six rounds
/// of work whose commands had already run against the user's shell.
pub(crate) async fn send_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
    secret: Option<&crate::credentials::Secret>,
) -> Result<reqwest::Response, ProviderError> {
    let mut last: Option<ProviderError> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        if *cancel.borrow() {
            return Err(ProviderError::Cancelled);
        }
        match build().send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                let status = resp.status();
                // Read the headers BEFORE the body: `text()` consumes the
                // response and `retry-after` would be gone with it.
                let wait = backoff(attempt, parse_retry_after(resp.headers()));
                let err = status_error(status, resp.text().await.unwrap_or_default(), secret);
                if !is_transient(status.as_u16()) || attempt == MAX_ATTEMPTS {
                    return Err(err);
                }
                log::warn!("{status} from provider, retry {attempt}/{MAX_ATTEMPTS} in {wait:?}");
                last = Some(err);
                if wait_or_cancel(wait, cancel).await {
                    return Err(ProviderError::Cancelled);
                }
            }
            Err(e) => {
                let err = ProviderError::Http(format!("request failed: {e}"));
                if attempt == MAX_ATTEMPTS {
                    return Err(err);
                }
                let wait = backoff(attempt, None);
                log::warn!("transport error, retry {attempt}/{MAX_ATTEMPTS} in {wait:?}: {e}");
                last = Some(err);
                if wait_or_cancel(wait, cancel).await {
                    return Err(ProviderError::Cancelled);
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| ProviderError::Http("request failed".into())))
}

/// Sleep, but wake immediately if the user cancels. Returns true if cancelled.
async fn wait_or_cancel(wait: Duration, cancel: &mut tokio::sync::watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(wait) => *cancel.borrow(),
        _ = cancel.changed() => *cancel.borrow(),
    }
}

fn status_error(
    status: reqwest::StatusCode,
    body: String,
    secret: Option<&crate::credentials::Secret>,
) -> ProviderError {
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/message"))
                .and_then(|m| m.as_str().map(String::from))
        })
        .unwrap_or_else(|| body.chars().take(400).collect());
    let detail = crate::credentials::redact_provider_text(&detail, secret);
    ProviderError::Http(match status.as_u16() {
        401 | 403 => format!(
            "authentication failed ({status}) — check the API key in Settings → Models: {detail}"
        ),
        429 => format!("rate limited ({status}) after {MAX_ATTEMPTS} attempts: {detail}"),
        _ => format!("HTTP {status}: {detail}"),
    })
}

/// Read an SSE body, handing each `data:` payload to `on_data`.
///
/// `on_data` cannot be async (it borrows the caller's accumulators mutably), so
/// it pushes into `out` and this loop forwards those events **before reading the
/// next frame**. That ordering is the whole point: collecting everything and
/// flushing at the end would turn a streaming provider into a blocking one, and
/// the user would stare at an empty panel until the turn finished.
///
/// Returns `Ok(true)` if cancelled, `Ok(false)` on natural end of stream.
pub(crate) async fn read_sse<F>(
    resp: reqwest::Response,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
    mut on_data: F,
) -> Result<bool, ProviderError>
where
    F: FnMut(&str, &mut Vec<ProviderEvent>) -> Result<bool, ProviderError>,
{
    let mut stream = resp.bytes_stream();
    // SSE frames split across TCP chunks routinely; buffer until a full line.
    let mut buf = String::new();
    let mut out: Vec<ProviderEvent> = Vec::new();

    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.changed() => {
                if *cancel.borrow() { return Ok(true); }
                continue;
            }
            next = stream.next() => next,
        };
        let Some(chunk) = chunk else { break };
        let bytes = chunk.map_err(|e| ProviderError::Http(format!("stream error: {e}")))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..nl + 1);
            let Some(data) = line.strip_prefix("data:") else {
                continue; // `event:` / `id:` / keep-alive comments
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let stop = on_data(data, &mut out)?;
            for event in out.drain(..) {
                emit(tx, event).await?;
            }
            if stop {
                return Ok(false);
            }
        }
        if *cancel.borrow() {
            return Ok(true);
        }
    }
    for event in out.drain(..) {
        emit(tx, event).await?;
    }
    Ok(false)
}

/// Emit an event, mapping a dropped receiver onto cancellation.
pub(crate) async fn emit(
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
    event: ProviderEvent,
) -> Result<(), ProviderError> {
    tx.send(event).await.map_err(|_| ProviderError::Cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_rate_limits_and_server_faults_retry() {
        for s in [429, 500, 502, 503, 504, 529] {
            assert!(is_transient(s), "{s} should retry");
        }
        // A bad key or a malformed request will fail identically every time;
        // retrying just delays the error the user needs to see.
        for s in [400, 401, 403, 404, 422] {
            assert!(!is_transient(s), "{s} must not retry");
        }
    }

    #[test]
    fn backoff_grows_and_respects_retry_after() {
        assert_eq!(backoff(1, None), Duration::from_millis(500));
        assert_eq!(backoff(2, None), Duration::from_millis(1000));
        assert_eq!(backoff(3, None), Duration::from_millis(2000));
        // The server's own number wins when it sends one...
        assert_eq!(
            backoff(1, Some(Duration::from_secs(7))),
            Duration::from_secs(7)
        );
        // ...but cannot wedge the UI for minutes.
        assert_eq!(
            backoff(1, Some(Duration::from_secs(600))),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn retry_after_is_parsed_from_headers() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::RETRY_AFTER, "3".parse().unwrap());
        assert_eq!(parse_retry_after(&h), Some(Duration::from_secs(3)));
        // The HTTP-date form is valid but rarer; falling back to plain backoff
        // is correct, not a silent failure.
        h.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(parse_retry_after(&h), None);
        assert_eq!(parse_retry_after(&reqwest::header::HeaderMap::new()), None);
    }

    #[test]
    fn auth_failures_name_the_setting_to_fix() {
        let e = status_error(reqwest::StatusCode::UNAUTHORIZED, String::new(), None).to_string();
        assert!(e.contains("Settings → Models"), "{e}");
    }

    #[test]
    fn provider_status_errors_never_expose_credentials() {
        let secret = crate::credentials::Secret::from("sentinel-provider-secret");
        let error = status_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"bad sentinel-provider-secret"}}"#.into(),
            Some(&secret),
        )
        .to_string();
        assert!(!error.contains("sentinel-provider-secret"), "{error}");
    }
}
