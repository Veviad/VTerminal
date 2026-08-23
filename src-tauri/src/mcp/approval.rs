use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpApprovalDecision {
    AllowOnce,
    AlwaysAllow,
    Deny,
}

#[derive(Debug)]
pub struct McpApprovalResponse {
    pub decision: McpApprovalDecision,
}

/// MCP calls use their own gate so terminal approval policy can never grant a
/// remote or local server tool implicitly. Entries are scoped to the active
/// request and drained on cancellation/app shutdown.
#[derive(Default)]
pub struct McpApprovalState {
    pending: Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<McpApprovalResponse>)>>,
}

impl McpApprovalState {
    pub fn register(
        &self,
        approval_id: &str,
        request_id: &str,
    ) -> tokio::sync::oneshot::Receiver<McpApprovalResponse> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(approval_id.to_owned(), (request_id.to_owned(), sender));
        }
        receiver
    }

    pub fn respond(&self, approval_id: &str, decision: McpApprovalDecision) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "MCP approval state poisoned")?
            .remove(approval_id)
            .map(|(_, sender)| sender)
            .ok_or_else(|| format!("no pending MCP approval {approval_id}"))?;
        sender
            .send(McpApprovalResponse { decision })
            .map_err(|_| "MCP call is no longer waiting".to_string())
    }

    pub fn drain_for_request(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, (pending_request, _)| pending_request != request_id);
        }
    }

    pub fn drain_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}
