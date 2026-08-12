pub mod session;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

use session::PtySession;

/// Lifecycle events on the JSON side-channel; the data plane is the separate
/// raw-bytes channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum PtyEvent {
    Spawned { pid: u32 },
    Exit { exit_code: Option<i32> },
    #[allow(dead_code)] // part of the wire contract; frontend handles it
    Error { message: String },
}

#[derive(Default)]
pub struct PtyManager {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn remove(&self, session_id: &str) -> Option<PtySession> {
        self.sessions.lock().ok()?.remove(session_id)
    }

    pub fn list(&self) -> Vec<String> {
        self.sessions
            .lock()
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default()
    }
}
