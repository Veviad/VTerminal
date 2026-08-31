//! Scheduled Actions.
//!
//! # The invariant this feature widens, and how far
//!
//! CLAUDE.md's rule is that *the app never executes text the user did not
//! authorize in that moment*, with the carve-out that arming the agent's
//! `Reads`/`All` mode **is** that authorization — given per session, never
//! persisted and never inherited. `runbookStore` faced the same question and
//! refused to persist; `permissionMode.ts` says a fresh tab always starts at
//! `ask`.
//!
//! A schedule cannot avoid persisting it. So the widening is scoped, and each
//! bound is enforced here in Rust — never only in the UI:
//!
//! 1. **`PermissionMode::Full` is unavailable.** `agent::run::policy_auto_runs`
//!    returns true for `Full` before the privileged/opaque/sensitive-read checks.
//!    `'full'` is absent from the v20 CHECK constraint and
//!    `validate::clamp_for_schedule` refuses it at save and at fire time.
//! 2. **Auto-run what the mode allows; auto-SKIP everything else, immediately.**
//!    Waiting out `APPROVAL_TIMEOUT_SECS` with nobody there is a ten-minute way
//!    of saying no. The skipped command, its assessment and the reason are
//!    recorded instead.
//! 3. **MCP tools need a pre-existing persisted grant.** No approval gate is ever
//!    opened, and no grant is ever written by a scheduled run.
//! 4. **Web access is per-action, default off, intersected with the global
//!    setting** — never unioned, so a daytime research session cannot widen a
//!    schedule saved months earlier.
//! 5. **Nothing auto-continues.** A prompt step that hits the step limit records
//!    the pause as its terminal outcome; the run never starts a fresh budget.
//! 6. **The arming is bound to what was armed.** `armed_at` plus a fingerprint
//!    over the target, steps and attachments; a mismatch at fire time refuses the
//!    run rather than authorizing a different one.
//! 7. **Attachments cap the mode.** An action that can pull attacker-controllable
//!    text into the loop may not also run every command unattended.
//!
//! And one thing that is deliberately absent: there is **no tray icon, no
//! launchd agent and no background process**. The feature fires only while the
//! app window is open, which is exactly what the missed-run policy exists for. A
//! helper that executes model-authored commands with no window is a materially
//! different security product with its own signing and threat model.

pub mod context;
pub mod db;
pub mod engine;
pub mod recurrence;
pub mod runner;
pub mod scheduler;
pub mod ssh;
pub mod types;
pub mod validate;

/// The feature gate. Every `scheduled_*` command refuses while this is false, and
/// flipping it off cancels whatever is in flight.
pub const SETTING_ENABLED: &str = "scheduled_actions_enabled";

/// Tab execution gets its own switch rather than riding the feature flag: it
/// types into a real PTY with a pre-armed mode, and the webview timers that drive
/// it are throttled while the window is backgrounded.
pub const SETTING_TAB_EXECUTION: &str = "scheduled_tab_execution_enabled";
