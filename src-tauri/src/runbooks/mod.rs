//! Reusable, versioned Runbooks.
//!
//! Definitions are inert local packages. The runtime owns all mutable state,
//! approvals, visible-terminal dispatch and durable reports separately from
//! document retrieval and ordinary AI conversations.

pub mod agent_executor;
pub mod db;
pub mod definition;
pub mod engine;
pub mod package;
pub mod redact;
pub mod report;
pub mod runtime;
pub mod state;
