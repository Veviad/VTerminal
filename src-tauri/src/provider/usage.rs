//! Transparent provider instrumentation for lifetime token statistics.
//!
//! Keeping this at the provider seam covers every generation path, including
//! chat, Agent, composer suggestions, automatic naming, and Runbooks. Callers
//! still receive the exact same event stream.

use tauri::{Manager, Wry};

use crate::database::{statistics, DbState};
use crate::models::catalog::CatalogModel;

use super::{ChatMessage, ChatParams, Provider, ProviderError, ProviderEvent, ToolDef};

pub struct UsageTrackingProvider {
    inner: Box<dyn Provider>,
    app: tauri::AppHandle<Wry>,
    model: &'static CatalogModel,
}

impl UsageTrackingProvider {
    pub fn new(
        inner: Box<dyn Provider>,
        app: tauri::AppHandle<Wry>,
        model: &'static CatalogModel,
    ) -> Self {
        Self { inner, app, model }
    }

    fn record(&self, usage: (u32, u32)) {
        let db = self.app.state::<DbState>();
        let result =
            db.0.lock()
                .map_err(|_| "token statistics database lock is poisoned".to_string())
                .and_then(|conn| statistics::record(&conn, self.model, usage.0, usage.1));
        if let Err(error) = result {
            // Statistics are observational. A locked or unavailable database
            // must never turn an otherwise successful model response into an
            // error for the user.
            log::warn!("could not record token statistics: {error}");
        }
    }
}

#[async_trait::async_trait]
impl Provider for UsageTrackingProvider {
    fn id(&self) -> &'static str {
        self.inner.id()
    }

    fn model_name(&self) -> String {
        self.inner.model_name()
    }

    async fn chat_stream(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolDef>,
        params: ChatParams,
        cancel: tokio::sync::watch::Receiver<bool>,
        tx: tokio::sync::mpsc::Sender<ProviderEvent>,
    ) -> Result<(), ProviderError> {
        // Interpose a bounded channel so usage can be observed without changing
        // the ordering or shape that existing provider consumers receive.
        let (inner_tx, mut inner_rx) = tokio::sync::mpsc::channel(64);
        let stream = self
            .inner
            .chat_stream(messages, tools, params, cancel, inner_tx);
        tokio::pin!(stream);
        let mut result = None;
        let mut usage = None;

        loop {
            if result.is_some() && inner_rx.is_closed() {
                while let Ok(event) = inner_rx.try_recv() {
                    if let ProviderEvent::Usage {
                        prompt_tokens,
                        completion_tokens,
                    } = &event
                    {
                        usage = Some((*prompt_tokens, *completion_tokens));
                    }
                    let _ = tx.send(event).await;
                }
                break;
            }
            tokio::select! {
                completed = &mut stream, if result.is_none() => result = Some(completed),
                event = inner_rx.recv(), if !inner_rx.is_closed() => {
                    if let Some(event) = event {
                        if let ProviderEvent::Usage { prompt_tokens, completion_tokens } = &event {
                            // Provider adapters emit one final usage event per call.
                            // Last-value semantics mirror provider::round and the
                            // existing one-shot chat driver.
                            usage = Some((*prompt_tokens, *completion_tokens));
                        }
                        let _ = tx.send(event).await;
                    }
                }
            }
        }

        if let Some(usage) = usage {
            self.record(usage);
        }
        result.unwrap_or(Ok(()))
    }
}
