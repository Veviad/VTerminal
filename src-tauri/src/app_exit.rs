//! Coordinated application exit.
//!
//! A normal quit must keep the webview alive long enough to run the strict
//! persistence barrier.  The backend owns the final clean marker and the
//! process-exit request so there is no JavaScript-sized gap between them.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

use crate::agent::{AiState, ApprovalState, PtyExecState, SteerState};
use crate::commands::runbooks::RunbookCommandState;
use crate::database::{workspace, DbState};
use crate::models::DownloadState;
use crate::pty::PtyManager;

pub const QUIT_EVENT: &str = "vterminal-app-quit-requested";
pub const QUIT_MENU_ID: &str = "vterminal.quit";

// The database can legitimately consume its 5s busy timeout after process
// cleanup has waited up to 10s. Keep scheduling margin while remaining bounded.
const QUIT_WATCHDOG: Duration = Duration::from_secs(20);
const PTY_CLEANUP_ATTEMPTS: usize = 2;
const PTY_CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(100);
#[cfg(target_os = "macos")]
const HARD_EXIT_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitOrigin {
    Menu,
    WindowClose,
    ExitRequested,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitTicket {
    pub token: u64,
    pub origin: QuitOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Running,
    Preparing(u64),
    Cleaning(u64),
    ExitingClean(u64),
    ExitingUnclean(u64),
}

#[derive(Debug)]
struct Inner {
    next_token: u64,
    phase: Phase,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            next_token: 0,
            phase: Phase::Running,
        }
    }
}

#[derive(Default)]
pub struct AppExitCoordinator {
    inner: Mutex<Inner>,
    // PTY verification temporarily removes sessions from the manager while it
    // owns their cleanup handles. Serializing all exit cleanup prevents a
    // watchdog/fallback from observing that transiently empty map and exiting
    // before the first verifier has finished.
    cleanup: Mutex<()>,
}

impl AppExitCoordinator {
    fn begin(&self, origin: QuitOrigin) -> Result<(QuitTicket, bool, bool), String> {
        let mut inner = self.inner.lock().map_err(|_| "exit state poisoned")?;
        let (token, is_new, should_emit) = match inner.phase {
            Phase::Running => {
                inner.next_token = inner.next_token.saturating_add(1).max(1);
                let token = inner.next_token;
                inner.phase = Phase::Preparing(token);
                (token, true, true)
            }
            Phase::Preparing(token) | Phase::Cleaning(token) => (token, false, true),
            Phase::ExitingClean(token) | Phase::ExitingUnclean(token) => (token, false, false),
        };
        Ok((QuitTicket { token, origin }, is_new, should_emit))
    }

    fn claim_cleaning(&self, token: u64) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|_| "exit state poisoned")?;
        match inner.phase {
            Phase::Preparing(active) if active == token => {
                inner.phase = Phase::Cleaning(token);
                Ok(true)
            }
            Phase::Cleaning(active)
            | Phase::ExitingClean(active)
            | Phase::ExitingUnclean(active)
                if active == token =>
            {
                Ok(false)
            }
            _ => Err("the quit ticket is stale".into()),
        }
    }

    /// Run the clean database transaction while holding the lifecycle lock.
    /// The watchdog therefore cannot win after the transaction has started and
    /// make a late clean write race an already-forced exit.
    fn finish_clean(
        &self,
        token: u64,
        operation: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|_| "exit state poisoned")?;
        match inner.phase {
            Phase::Cleaning(active) if active == token => match operation() {
                Ok(()) => {
                    inner.phase = Phase::ExitingClean(token);
                    Ok(true)
                }
                Err(error) => {
                    inner.phase = Phase::ExitingUnclean(token);
                    Err(error)
                }
            },
            Phase::ExitingClean(active) | Phase::ExitingUnclean(active) if active == token => {
                Ok(false)
            }
            _ => Err("the quit ticket is stale".into()),
        }
    }

    fn force_unclean(&self, token: u64) -> Result<bool, String> {
        let mut inner = self.inner.lock().map_err(|_| "exit state poisoned")?;
        match inner.phase {
            Phase::Preparing(active) | Phase::Cleaning(active) if active == token => {
                inner.phase = Phase::ExitingUnclean(token);
                Ok(true)
            }
            Phase::ExitingUnclean(active) if active == token => Ok(true),
            Phase::ExitingClean(active) if active == token => Ok(false),
            _ => Err("the quit ticket is stale".into()),
        }
    }

    pub fn allows_requested_exit(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            matches!(
                inner.phase,
                Phase::ExitingClean(_) | Phase::ExitingUnclean(_)
            )
        })
    }

    #[cfg(target_os = "macos")]
    fn is_exiting(&self, token: u64) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            matches!(
                inner.phase,
                Phase::ExitingClean(active) | Phase::ExitingUnclean(active) if active == token
            )
        })
    }
}

fn spawn_watchdog(app: AppHandle<Wry>, token: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUIT_WATCHDOG).await;
        let coordinator = app.state::<AppExitCoordinator>();
        if coordinator.force_unclean(token).unwrap_or(false) {
            log::error!(
                "quit persistence did not finish within {:?}; exiting with the crash marker armed",
                QUIT_WATCHDOG
            );
            cleanup_processes_before_forced_exit(&app, "quit watchdog");
            request_process_exit(&app, token);
        }
    });
}

fn request_process_exit(app: &AppHandle<Wry>, _token: u64) {
    app.exit(0);

    // `AppHandle::exit` normally produces ExitRequested followed by Exit. If
    // the event loop itself is wedged, do not leave an unquittable application
    // behind. `_exit` also avoids the Metal static destructors.
    #[cfg(target_os = "macos")]
    {
        let hard_exit_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(HARD_EXIT_GRACE).await;
            if hard_exit_app
                .state::<AppExitCoordinator>()
                .is_exiting(_token)
            {
                unsafe { libc::_exit(0) };
            }
        });
    }
}

pub fn request_quit(app: &AppHandle<Wry>, origin: QuitOrigin) -> Result<QuitTicket, String> {
    let coordinator = app.state::<AppExitCoordinator>();
    let (ticket, is_new, should_emit) = coordinator.begin(origin)?;
    if is_new {
        spawn_watchdog(app.clone(), ticket.token);
    }
    if should_emit {
        if let Err(error) = app.emit_to("main", QUIT_EVENT, ticket.clone()) {
            log::warn!("could not notify the frontend about the quit request: {error}");
            // A missing webview cannot run the persistence barrier. Do not wait
            // for the watchdog just to perform the same unclean fallback, and
            // do not leave child terminal processes behind when the window is gone.
            if coordinator.force_unclean(ticket.token).unwrap_or(false) {
                cleanup_processes_before_forced_exit(app, "missing quit listener");
                request_process_exit(app, ticket.token);
            }
        }
    }
    Ok(ticket)
}

/// Destructive cleanup is delayed until the frontend's strict persistence
/// barrier has completed. Once this starts, failure must still end in an
/// unclean process exit because part of the live runtime may already be gone.
fn signal_runtime_cleanup(app: &AppHandle<Wry>) {
    let downloads = app.state::<DownloadState>();
    let ai_state = app.state::<AiState>();
    let approvals = app.state::<ApprovalState>();
    let pty_exec = app.state::<PtyExecState>();
    let steers = app.state::<SteerState>();
    let runbooks = app.state::<std::sync::Arc<RunbookCommandState>>();

    downloads.cancel_all();
    ai_state.cancel_all();
    approvals.drain_all();
    pty_exec.drain_all();
    steers.drain_all();
    runbooks.cancellations.cancel_all();
    runbooks.pty.cancel_all();
}

fn kill_terminals_verified(app: &AppHandle<Wry>) -> Result<(), String> {
    let manager = app.state::<PtyManager>();
    let mut failures = Vec::new();
    for attempt in 1..=PTY_CLEANUP_ATTEMPTS {
        match manager.kill_all_verified() {
            Ok(()) => return Ok(()),
            Err(error) => failures.push(format!("attempt {attempt}: {error}")),
        }
        if attempt < PTY_CLEANUP_ATTEMPTS {
            std::thread::sleep(PTY_CLEANUP_RETRY_DELAY);
        }
    }
    Err(format!(
        "terminal cleanup remained unverified after {PTY_CLEANUP_ATTEMPTS} attempts: {}",
        failures.join("; ")
    ))
}

fn cleanup_processes_before_forced_exit(app: &AppHandle<Wry>, context: &str) {
    let coordinator = app.state::<AppExitCoordinator>();
    let _cleanup = coordinator
        .cleanup
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    signal_runtime_cleanup(app);
    if let Err(error) = kill_terminals_verified(app) {
        // The crash marker stays armed. Exiting is still necessary, but this is
        // now an explicit verification failure rather than a skipped cleanup.
        log::error!("{context} terminal cleanup failed: {error}");
    }
}

/// Stop runtime work at an irreversible clean-exit boundary.
///
/// Ordinary quits call this from `app_quit_commit`; the updater restart path
/// must reuse it before requesting a restart so child PTYs and background work
/// cannot outlive a workspace that has already been marked clean.
pub(crate) fn cleanup_processes_for_exit(app: &AppHandle<Wry>) -> Result<(), String> {
    let coordinator = app.state::<AppExitCoordinator>();
    let _cleanup = coordinator
        .cleanup
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    signal_runtime_cleanup(app);
    kill_terminals_verified(app)?;

    let downloads = app.state::<DownloadState>();
    let ai_state = app.state::<AiState>();
    let runbooks = app.state::<std::sync::Arc<RunbookCommandState>>();

    let stopped = wait_for_background_cleanup(Duration::from_secs(10), || {
        ai_state.is_idle() && downloads.is_idle() && runbooks.cancellations.is_idle()
    });
    if !stopped {
        // The process boundary is the final cancellation mechanism. Persistence
        // is already durable, so a slow local generation must not turn an
        // intentional Cmd-Q into an "unexpected quit" on the next launch.
        log::warn!(
            "background AI, model download, or Runbook work did not stop before quit; exiting cleanly anyway"
        );
    }
    Ok(())
}

fn wait_for_background_cleanup(timeout: Duration, mut is_idle: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_idle() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    is_idle()
}

#[tauri::command]
pub fn app_quit_begin(app: AppHandle<Wry>, origin: QuitOrigin) -> Result<QuitTicket, String> {
    request_quit(&app, origin)
}

#[tauri::command(async)]
pub fn app_quit_commit(
    app: AppHandle<Wry>,
    coordinator: State<'_, AppExitCoordinator>,
    db: State<'_, DbState>,
    token: u64,
) -> Result<(), String> {
    if !coordinator.claim_cleaning(token)? {
        return Ok(());
    }

    if let Err(error) = cleanup_processes_for_exit(&app) {
        let _ = coordinator.force_unclean(token);
        log::error!("quit cleanup failed: {error}");
        request_process_exit(&app, token);
        return Err(error);
    }

    // Acquire the database before the lifecycle lock. If another writer holds
    // it until the watchdog fires, finish_clean observes ExitingUnclean and
    // refuses to write a late clean marker.
    let mut conn = match db.0.lock() {
        Ok(conn) => conn,
        Err(_) => {
            let error = "db poisoned while committing clean exit".to_string();
            let _ = coordinator.force_unclean(token);
            request_process_exit(&app, token);
            return Err(error);
        }
    };
    let mut removed = Vec::new();
    let retention = crate::commands::archive::retention(&app);
    let result = coordinator.finish_clean(token, || {
        removed = workspace::commit_clean_exit(&mut conn, retention)?;
        Ok(())
    });
    drop(conn);
    if result.is_ok() {
        crate::commands::archive::remove_archived_attachments(&app, removed);
    }
    request_process_exit(&app, token);
    result.map(|_| ())
}

#[tauri::command]
pub fn app_quit_force(
    app: AppHandle<Wry>,
    coordinator: State<'_, AppExitCoordinator>,
    token: u64,
    reason: Option<String>,
) -> Result<(), String> {
    let should_exit = coordinator.force_unclean(token)?;
    if should_exit {
        log::error!(
            "forcing an unclean quit after the persistence barrier failed: {}",
            reason.as_deref().unwrap_or("unknown error")
        );
        cleanup_processes_before_forced_exit(&app, "unclean quit fallback");
        request_process_exit(&app, token);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn macos_menu(app: &AppHandle<Wry>) -> tauri::Result<tauri::menu::Menu<Wry>> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind};

    let menu = Menu::default(app)?;
    let app_menu = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
        .ok_or_else(|| std::io::Error::other("the macOS application menu is missing"))?;
    let items = app_menu.items()?;
    let quit_index = items
        .iter()
        .rposition(|item| {
            item.as_predefined_menuitem().is_some_and(|predefined| {
                predefined
                    .text()
                    .is_ok_and(|text| text.starts_with("Quit "))
            })
        })
        .ok_or_else(|| std::io::Error::other("the default macOS Quit item is missing"))?;

    app_menu.remove_at(quit_index)?;
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {}", app.package_info().name))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    app_menu.insert(&quit, quit_index)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_requests_share_one_generation() {
        let coordinator = AppExitCoordinator::default();
        let (first, is_new, should_emit) = coordinator.begin(QuitOrigin::Menu).unwrap();
        assert!(is_new);
        assert!(should_emit);

        let (second, is_new, should_emit) = coordinator.begin(QuitOrigin::WindowClose).unwrap();
        assert_eq!(second.token, first.token);
        assert!(!is_new);
        assert!(should_emit);
    }

    #[test]
    fn stale_completion_cannot_commit_or_force() {
        let coordinator = AppExitCoordinator::default();
        let (ticket, _, _) = coordinator.begin(QuitOrigin::Menu).unwrap();
        assert!(coordinator.claim_cleaning(ticket.token).unwrap());
        assert!(coordinator.claim_cleaning(ticket.token + 1).is_err());
        assert!(coordinator.force_unclean(ticket.token + 1).is_err());
    }

    #[test]
    fn clean_commit_is_one_shot_and_allows_the_requested_exit() {
        let coordinator = AppExitCoordinator::default();
        let (ticket, _, _) = coordinator.begin(QuitOrigin::Menu).unwrap();
        assert!(coordinator.claim_cleaning(ticket.token).unwrap());
        let mut calls = 0;
        assert!(coordinator
            .finish_clean(ticket.token, || {
                calls += 1;
                Ok(())
            })
            .unwrap());
        assert_eq!(calls, 1);
        assert!(coordinator.allows_requested_exit());
        assert!(!coordinator.force_unclean(ticket.token).unwrap());
    }

    #[test]
    fn failed_commit_stays_unclean_and_cannot_be_reopened() {
        let coordinator = AppExitCoordinator::default();
        let (ticket, _, _) = coordinator.begin(QuitOrigin::ExitRequested).unwrap();
        assert!(coordinator.claim_cleaning(ticket.token).unwrap());
        assert_eq!(
            coordinator
                .finish_clean(ticket.token, || Err("sqlite unavailable".into()))
                .unwrap_err(),
            "sqlite unavailable"
        );
        assert!(coordinator.allows_requested_exit());
        assert!(!coordinator.claim_cleaning(ticket.token).unwrap());
    }

    #[test]
    fn watchdog_transition_is_idempotent() {
        let coordinator = AppExitCoordinator::default();
        let (ticket, _, _) = coordinator.begin(QuitOrigin::Menu).unwrap();
        assert!(coordinator.force_unclean(ticket.token).unwrap());
        assert!(coordinator.force_unclean(ticket.token).unwrap());
        assert!(coordinator.allows_requested_exit());
    }

    #[test]
    fn slow_background_cancellation_does_not_block_a_clean_commit() {
        assert!(!wait_for_background_cleanup(Duration::ZERO, || false));

        let coordinator = AppExitCoordinator::default();
        let (ticket, _, _) = coordinator.begin(QuitOrigin::Menu).unwrap();
        assert!(coordinator.claim_cleaning(ticket.token).unwrap());
        assert!(coordinator.finish_clean(ticket.token, || Ok(())).unwrap());
        assert!(coordinator.allows_requested_exit());
    }
}
