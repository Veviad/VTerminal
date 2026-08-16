//! Tauri IPC boundary for the experimental Runbooks subsystem.
//!
//! The webview is not a trust boundary. Every entry point is feature-gated and
//! validates ownership, size and state before forwarding a response to the
//! engine. Definitions are revalidated from their confined package at run
//! creation; live execution uses only the immutable snapshot committed to the
//! hardened main database.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
#[cfg(not(target_os = "windows"))]
use std::fs::OpenOptions;
#[cfg(not(target_os = "windows"))]
use std::io::Seek;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{Manager, State, Wry};

use crate::database::DbState;
use crate::pty::PtyManager;
use crate::runbooks::authoring;
use crate::runbooks::db::{
    self, ApprovalRecord, AttemptRecord, RunCreation, RunRecord, SourceKind, SourceRegistration,
    SourceRegistrationInput, StepRecord, StepSeed,
};
use crate::runbooks::definition::{ApplyAction, CheckAction, RunbookDefinition, VerifyAction};
use crate::runbooks::drafts::{
    DraftPlatform, RunbookDraft, RunbookDraftDocument, RunbookDraftPreview, RunbookDraftSummary,
};
use crate::runbooks::engine::{
    execute_runbook, resume_runbook, validate_runtime_command, EngineConfig, EngineContext,
    EngineRunSpec, OperatorDecisionResponse, RunbookDecisionState, RunbookManualIndex,
    TargetObserver,
};
use crate::runbooks::package::{
    load_package, DefinitionSnapshot, ValidatedPackage, MAX_PACKAGE_ENTRIES,
};
use crate::runbooks::redact::{redact_sensitive, sha256_hex, FULL_EVIDENCE_BYTES};
use crate::runbooks::report::RunbookReport;
use crate::runbooks::runtime::{
    ApprovalResponse, ManualOutcome, ManualResponse, ObservedPtyResult, RunCoordinator,
    RunbookApprovalState, RunbookCancellationState, RunbookEvent, RunbookManualState,
    RunbookPtyState,
};
use crate::runbooks::state::{
    ApprovalDecision, ApprovalStatus, AttemptStatus, EvidenceAvailability, EvidenceCaptureMode,
    PauseDecision, RunStatus, RunbookPhase, StepStatus, TargetBinding, VerificationAssurance,
    Waiver,
};

const RUNBOOKS_SETTING: &str = "runbooks_enabled";
const MAIN_DATABASE_FILE: &str = "veviad-shell.db";
const MAX_ID_BYTES: usize = 256;
const MAX_TARGET_FIELD_BYTES: usize = 4_096;
const MAX_OPERATOR_TEXT_BYTES: usize = 16 * 1_024;
const MAX_TERMINAL_ERROR_BYTES: usize = 8 * 1_024;
const MAX_TERMINAL_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
const HISTORY_LIMIT: u32 = 500;
const MAX_CLEANUP_ERRORS: usize = 100;
const BUILTIN_LIBRARY_DIRECTORY: &str = "runbook-library";
const BUILTIN_PACKAGES_DIRECTORY: &str = "builtins";
const AUTHORED_PACKAGES_DIRECTORY: &str = "authored";

struct BuiltinPackage {
    id: &'static str,
    order: u32,
    definition: &'static [u8],
    readme: &'static [u8],
}

const BUILTIN_PACKAGES: &[BuiltinPackage] = &[
    BuiltinPackage {
        id: "macos-security-posture",
        order: 0,
        definition: include_bytes!(
            "../../../examples/runbooks/macos-security-posture/runbook.vrun.yaml"
        ),
        readme: include_bytes!("../../../examples/runbooks/macos-security-posture/README.md"),
    },
    BuiltinPackage {
        id: "macos-developer-workstation-health",
        order: 1,
        definition: include_bytes!(
            "../../../examples/runbooks/macos-developer-workstation-health/runbook.vrun.yaml"
        ),
        readme: include_bytes!(
            "../../../examples/runbooks/macos-developer-workstation-health/README.md"
        ),
    },
    BuiltinPackage {
        id: "macos-backup-storage-readiness",
        order: 2,
        definition: include_bytes!(
            "../../../examples/runbooks/macos-backup-storage-readiness/runbook.vrun.yaml"
        ),
        readme: include_bytes!(
            "../../../examples/runbooks/macos-backup-storage-readiness/README.md"
        ),
    },
];

/// The Runbooks engine deliberately owns independent rendezvous registries. In
/// particular, ordinary AI approvals and `Auto all` cannot reach these maps.
pub struct RunbookCommandState {
    pub coordinator: RunCoordinator,
    pub approvals: RunbookApprovalState,
    pub pty: RunbookPtyState,
    pub manual: RunbookManualState,
    pub manual_index: RunbookManualIndex,
    pub decisions: RunbookDecisionState,
    pub cancellations: RunbookCancellationState,
    app_data_dir: PathBuf,
}

impl RunbookCommandState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            coordinator: RunCoordinator::default(),
            approvals: RunbookApprovalState::default(),
            pty: RunbookPtyState::default(),
            manual: RunbookManualState::default(),
            manual_index: RunbookManualIndex::default(),
            decisions: RunbookDecisionState::default(),
            cancellations: RunbookCancellationState::default(),
            app_data_dir,
        }
    }
}

pub(crate) fn initialize_builtin_sources(
    app_data_dir: &Path,
    connection: &rusqlite::Connection,
) -> Result<(), String> {
    reconcile_builtin_sources(app_data_dir, connection).map(|_| ())
}

fn reconcile_builtin_sources(
    app_data_dir: &Path,
    connection: &rusqlite::Connection,
) -> Result<Vec<SourceRegistration>, String> {
    let package_root = app_data_dir
        .join(BUILTIN_LIBRARY_DIRECTORY)
        .join(BUILTIN_PACKAGES_DIRECTORY);
    ensure_managed_directory(&package_root, "built-in runbook library")?;
    let root_metadata = fs::symlink_metadata(&package_root)
        .map_err(|error| format!("inspect built-in runbook library: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("built-in runbook library must be an ordinary directory".into());
    }
    restrict_builtin_directory(&package_root)?;

    for builtin in BUILTIN_PACKAGES {
        let package = materialize_builtin_package(&package_root, builtin)?;
        let mut input = registration_input(&package, true, None)?;
        input.source_kind = SourceKind::Builtin;
        input.hidden = false;
        input.builtin_order = Some(builtin.order);

        let existing = db::get_source_by_package_path(connection, &input.package_path)?;
        let is_current = existing.as_ref().is_some_and(|source| {
            source.definition_id == input.definition_id
                && source.definition_version == input.definition_version
                && source.title == input.title
                && source.source_sha256 == input.source_sha256
                && source.canonical_sha256 == input.canonical_sha256
                && source.valid
                && source.validation_error.is_none()
                && source.source_kind == SourceKind::Builtin
                && source.builtin_order == Some(builtin.order)
        });
        if !is_current {
            db::upsert_source(connection, &input)?;
        }
    }
    db::list_sources(connection)
}

fn materialize_builtin_package(
    package_root: &Path,
    builtin: &BuiltinPackage,
) -> Result<ValidatedPackage, String> {
    validate_export_component(builtin.id, "built-in runbook id")?;
    let destination = package_root.join(builtin.id);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(format!(
                    "built-in runbook path {} is not an ordinary directory",
                    destination.display()
                ));
            }
            #[cfg(target_os = "windows")]
            crate::windows_fs::validate_local_ntfs_path(&destination)?;
            if let Ok(package) = load_and_check_package(&destination) {
                let readme_matches = package
                    .readme_path
                    .as_ref()
                    .and_then(|path| read_managed_file(path).ok())
                    .is_some_and(|bytes| bytes == builtin.readme);
                let ansible_absent = match fs::symlink_metadata(destination.join("ansible")) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Ok(_) | Err(_) => false,
                };
                if package.snapshot.source_yaml.as_bytes() == builtin.definition
                    && package.definition.metadata.id == builtin.id
                    && readme_matches
                    && ansible_absent
                {
                    return Ok(package);
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect built-in runbook {}: {error}",
                destination.display()
            ));
        }
    }

    let suffix = uuid::Uuid::new_v4();
    let staging = package_root.join(format!(".{}.staging-{suffix}", builtin.id));
    create_managed_directory(
        package_root,
        staging
            .file_name()
            .ok_or("built-in runbook staging directory has no filename")?,
        "built-in runbook staging directory",
    )?;
    if let Err(error) = restrict_builtin_directory(&staging)
        .and_then(|()| write_builtin_file(&staging.join("runbook.vrun.yaml"), builtin.definition))
        .and_then(|()| write_builtin_file(&staging.join("README.md"), builtin.readme))
        .and_then(|()| {
            let package = load_and_check_package(&staging)?;
            if package.definition.metadata.id != builtin.id
                || package.snapshot.source_yaml.as_bytes() != builtin.definition
            {
                return Err(format!(
                    "compiled built-in runbook {} has an unexpected identity",
                    builtin.id
                ));
            }
            Ok(())
        })
    {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let backup = package_root.join(format!(".{}.backup-{suffix}", builtin.id));
    let had_destination = destination.exists();
    if had_destination {
        promote_managed_directory(&destination, &backup).map_err(|error| {
            let _ = fs::remove_dir_all(&staging);
            format!(
                "move previous built-in runbook {} aside: {error}",
                destination.display()
            )
        })?;
    }
    if let Err(error) = promote_managed_directory(&staging, &destination) {
        if had_destination {
            let _ = promote_managed_directory(&backup, &destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "publish built-in runbook {}: {error}",
            destination.display()
        ));
    }
    if had_destination {
        if let Err(error) = fs::remove_dir_all(&backup) {
            log::warn!(
                "could not remove superseded built-in runbook {}: {error}",
                backup.display()
            );
        }
    }
    sync_directory(package_root)?;
    load_and_check_package(&destination)
}

#[cfg(target_os = "windows")]
fn ensure_managed_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let mut missing = Vec::new();
    let mut existing = path;
    while !existing.exists() {
        missing.push(
            existing
                .file_name()
                .ok_or_else(|| format!("{label} has no directory name"))?
                .to_os_string(),
        );
        existing = existing
            .parent()
            .ok_or_else(|| format!("{label} has no existing parent"))?;
    }
    let mut current = crate::windows_fs::validate_local_ntfs_path(existing)?;
    for name in missing.into_iter().rev() {
        current = crate::windows_fs::create_secure_directory(&current, &name)?;
    }
    crate::windows_fs::validate_local_ntfs_path(&current)
}

#[cfg(not(target_os = "windows"))]
fn ensure_managed_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|error| format!("create {label}: {error}"))?;
    Ok(path.to_path_buf())
}

#[cfg(target_os = "windows")]
fn create_managed_directory(
    parent: &Path,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<PathBuf, String> {
    crate::windows_fs::create_secure_directory(parent, name)
        .map_err(|error| format!("create {label}: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn create_managed_directory(
    parent: &Path,
    name: &std::ffi::OsStr,
    label: &str,
) -> Result<PathBuf, String> {
    let path = parent.join(name);
    fs::create_dir(&path).map_err(|error| format!("create {label} {}: {error}", path.display()))?;
    Ok(path)
}

#[cfg(target_os = "windows")]
fn promote_managed_directory(source: &Path, destination: &Path) -> Result<(), String> {
    crate::windows_fs::promote_new_directory(source, destination)
}

#[cfg(not(target_os = "windows"))]
fn promote_managed_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn read_managed_file(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read as _;

    let mut file = crate::windows_fs::open_no_reparse(path, false)?;
    let identity = crate::windows_fs::identity(&file)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("read managed file {}: {error}", path.display()))?;
    crate::windows_fs::verify_identity(path, identity, false)?;
    Ok(bytes)
}

#[cfg(not(target_os = "windows"))]
fn read_managed_file(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("read managed file {}: {error}", path.display()))
}

fn write_builtin_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let (created_path, created_identity, mut file) = crate::windows_fs::create_secure_file(
        path.parent()
            .ok_or("built-in runbook file has no parent directory")?,
        path.file_name()
            .ok_or("built-in runbook file has no filename")?,
    )?;
    #[cfg(not(target_os = "windows"))]
    let mut file = {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        options
            .open(path)
            .map_err(|error| format!("create built-in runbook file {}: {error}", path.display()))?
    };
    file.write_all(bytes)
        .map_err(|error| format!("write built-in runbook file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync built-in runbook file {}: {error}", path.display()))?;
    #[cfg(target_os = "windows")]
    {
        if created_path != path {
            return Err("built-in runbook path changed during protected creation".into());
        }
        crate::windows_fs::verify_identity(path, created_identity, false)?;
    }
    Ok(())
}

fn restrict_builtin_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "restrict built-in runbook directory {}: {error}",
                path.display()
            )
        })?;
    }
    #[cfg(target_os = "windows")]
    crate::windows_fs::restrict_to_current_user(path)?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::windows_fs::sync_directory(path)
    }
    #[cfg(not(target_os = "windows"))]
    OpenOptions::new()
        .read(true)
        .open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync directory {}: {error}", path.display()))
}

fn validate_draft_storage(document: &RunbookDraftDocument) -> Result<(), String> {
    let json = crate::runbooks::drafts::document_json(document)?;
    reject_sensitive_text(&json, "runbook draft")
}

fn validate_draft_preview(document: &RunbookDraftDocument) -> RunbookDraftPreview {
    let mut preview = crate::runbooks::drafts::preview(document);
    let sensitive = crate::runbooks::drafts::document_json(document)
        .and_then(|json| reject_sensitive_text(&json, "runbook draft"));
    if let Err(error) = sensitive {
        preview
            .issues
            .push(crate::runbooks::definition::ValidationError {
                path: "document".into(),
                message: error,
            });
    }
    if let Some(source) = preview.source_yaml.as_deref() {
        if let Err(error) = reject_sensitive_text(source, "generated runbook definition") {
            preview
                .issues
                .push(crate::runbooks::definition::ValidationError {
                    path: "document".into(),
                    message: error,
                });
        }
    }
    preview
}

fn draft_publication_changed(
    previous_document_sha256: Option<&str>,
    previous_version: Option<&str>,
    document_sha256: &str,
    next_version: &str,
) -> Result<bool, String> {
    let changed = previous_document_sha256 != Some(document_sha256);
    if changed {
        if let Some(previous) = previous_version {
            let previous = semver::Version::parse(previous)
                .map_err(|error| format!("stored published version is invalid: {error}"))?;
            let next = semver::Version::parse(next_version)
                .map_err(|error| format!("draft version is invalid: {error}"))?;
            if next <= previous {
                return Err(format!(
                    "changed runbooks require a version greater than {previous}"
                ));
            }
        }
    }
    Ok(changed)
}

#[derive(Debug)]
struct AuthoredPublication {
    root: PathBuf,
    destination: PathBuf,
    staging: PathBuf,
    backup: Option<PathBuf>,
    committed: bool,
}

impl AuthoredPublication {
    fn commit(&mut self) {
        self.committed = true;
        if let Some(backup) = self.backup.take() {
            if let Err(error) = fs::remove_dir_all(&backup) {
                log::warn!(
                    "remove previous authored runbook {}: {error}",
                    backup.display()
                );
            }
        }
        if let Err(error) = sync_directory(&self.root) {
            log::warn!("sync authored runbook library after publication: {error}");
        }
    }
}

impl Drop for AuthoredPublication {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if self.destination.exists() {
            let _ = fs::remove_dir_all(&self.destination);
        }
        if let Some(backup) = self.backup.as_ref() {
            let _ = promote_managed_directory(backup, &self.destination);
        }
        if self.staging.exists() {
            let _ = fs::remove_dir_all(&self.staging);
        }
        let _ = sync_directory(&self.root);
    }
}

fn publish_authored_package(
    authored_root: &Path,
    destination: &Path,
    source_yaml: &[u8],
    readme: &[u8],
    expected_source_sha256: Option<&str>,
    expected_readme_sha256: Option<&str>,
) -> Result<AuthoredPublication, String> {
    ensure_managed_directory(authored_root, "authored runbook library")?;
    let root_metadata = fs::symlink_metadata(authored_root)
        .map_err(|error| format!("inspect authored runbook library: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("authored runbook library must be an ordinary directory".into());
    }
    restrict_builtin_directory(authored_root)?;

    let mut backup = None;
    match fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("authored runbook package path is not an ordinary directory".into());
            }
            #[cfg(target_os = "windows")]
            crate::windows_fs::validate_local_ntfs_path(destination)?;
            let expected_source = expected_source_sha256
                .ok_or("an unexpected package already exists at this draft's app-managed path")?;
            let expected_readme = expected_readme_sha256
                .ok_or("an unexpected package already exists at this draft's app-managed path")?;
            let mut names = fs::read_dir(destination)
                .map_err(|error| format!("read authored runbook package: {error}"))?
                .map(|entry| {
                    entry
                        .map(|entry| entry.file_name())
                        .map_err(|error| format!("read authored runbook entry: {error}"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            names.sort();
            if names
                != [
                    std::ffi::OsString::from("README.md"),
                    std::ffi::OsString::from("runbook.vrun.yaml"),
                ]
            {
                return Err("authored runbook package contains unexpected files; export it before resolving the drift".into());
            }
            for name in ["runbook.vrun.yaml", "README.md"] {
                let metadata = fs::symlink_metadata(destination.join(name))
                    .map_err(|error| format!("inspect authored runbook {name}: {error}"))?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(format!("authored runbook {name} is not an ordinary file"));
                }
            }
            let current_source = read_managed_file(&destination.join("runbook.vrun.yaml"))
                .map_err(|error| format!("read authored runbook definition: {error}"))?;
            let current_readme = read_managed_file(&destination.join("README.md"))
                .map_err(|error| format!("read authored runbook README: {error}"))?;
            if sha256_hex(&current_source) != expected_source
                || sha256_hex(&current_readme) != expected_readme
            {
                return Err("authored runbook package changed outside the wizard; export it before resolving the drift".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if expected_source_sha256.is_some() || expected_readme_sha256.is_some() {
                return Err("the previously published app-managed package is missing".into());
            }
        }
        Err(error) => return Err(format!("inspect authored runbook package: {error}")),
    }

    let suffix = uuid::Uuid::new_v4();
    let staging = authored_root.join(format!(".draft-staging-{suffix}"));
    create_managed_directory(
        authored_root,
        staging
            .file_name()
            .ok_or("authored runbook staging directory has no filename")?,
        "authored runbook staging directory",
    )?;
    restrict_builtin_directory(&staging)?;
    if let Err(error) = write_builtin_file(&staging.join("runbook.vrun.yaml"), source_yaml)
        .and_then(|()| write_builtin_file(&staging.join("README.md"), readme))
        .and_then(|()| load_and_check_package(&staging).map(|_| ()))
        .and_then(|()| sync_directory(&staging))
    {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    if destination.exists() {
        let backup_path = authored_root.join(format!(".draft-backup-{suffix}"));
        promote_managed_directory(destination, &backup_path)
            .map_err(|error| format!("move previous authored runbook aside: {error}"))?;
        backup = Some(backup_path);
    }
    if let Err(error) = promote_managed_directory(&staging, destination) {
        if let Some(backup_path) = backup.as_ref() {
            let _ = promote_managed_directory(backup_path, destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("publish authored runbook package: {error}"));
    }
    let publication = AuthoredPublication {
        root: authored_root.to_path_buf(),
        destination: destination.to_path_buf(),
        staging,
        backup,
        committed: false,
    };
    sync_directory(authored_root)?;
    Ok(publication)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunbookStartRequest {
    pub source_id: String,
    pub session_id: String,
    pub target_context: TargetBinding,
    pub inputs: BTreeMap<String, Value>,
    pub evidence_mode: EvidenceCaptureMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunbookOperatorDecision {
    pub kind: PauseDecision,
    #[serde(default)]
    pub step_id: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    // Reserved for an explicit interrupted-run rebind. Normal pause decisions
    // never change the target and these fields must remain absent.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub target_context: Option<TargetBinding>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunbookTerminalResult {
    pub exit_code: Option<i32>,
    pub output_tail: String,
    #[serde(default)]
    pub output_truncated: bool,
    #[serde(default)]
    pub output_observed_bytes: u64,
    #[serde(default)]
    pub output_captured_bytes: u64,
    pub duration_ms: u64,
    pub error: Option<String>,
    #[serde(default)]
    pub execution_mode: Option<String>,
    /// Fresh frontend observation taken immediately around visible-terminal
    /// execution. Rust compares identity-bearing fields with the immutable
    /// target before accepting the result.
    pub target_context: Option<TargetBinding>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualWireOutcome {
    Passed,
    Failed,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunbookAttemptView {
    pub attempt_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub executor: String,
    pub status: AttemptStatus,
    pub proposed_command: Option<String>,
    pub executed_command: Option<String>,
    pub exit_code: Option<i32>,
    pub output_tail: Option<String>,
    pub output_observed_bytes: u64,
    pub output_captured_bytes: u64,
    pub output_truncated: bool,
    pub output_redacted: bool,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub structured_outcomes: Option<Value>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunbookStepView {
    pub id: String,
    pub status: StepStatus,
    pub title: String,
    pub required: bool,
    pub index: u32,
    pub phase: Option<RunbookPhase>,
    pub assurance: Option<VerificationAssurance>,
    pub summary: Option<String>,
    pub operator_comment: Option<String>,
    pub exception: Option<String>,
    pub attempts: Vec<RunbookAttemptView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingApprovalView {
    pub approval_id: String,
    pub run_id: String,
    pub step_id: String,
    pub phase: RunbookPhase,
    pub command: String,
    pub explanation: String,
    pub classification: CommandClassificationView,
    pub requested_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandClassificationView {
    pub read_only: bool,
    pub network: bool,
    pub privileged: bool,
    pub opaque: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingOperatorView {
    pub run_id: String,
    pub step_id: Option<String>,
    pub reason: String,
    pub choices: Vec<PauseDecision>,
    pub message: String,
    pub requested_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingManualView {
    pub run_id: String,
    pub step_id: String,
    pub title: String,
    pub phase: RunbookPhase,
    pub instructions: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunbookRunView {
    pub run_id: String,
    pub status: RunStatus,
    pub target: TargetBinding,
    pub active_step_id: Option<String>,
    pub active_phase: Option<RunbookPhase>,
    pub pending_approval_id: Option<String>,
    pub pause_reason: Option<String>,
    pub steps: Vec<RunbookStepView>,
    pub source_id: Option<String>,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_title: String,
    pub inputs: Value,
    pub evidence_mode: EvidenceCaptureMode,
    pub pending_approval: Option<PendingApprovalView>,
    pub pending_operator: Option<PendingOperatorView>,
    pub pending_manual: Option<PendingManualView>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub report_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunbookHistoryView {
    pub id: String,
    pub source_id: Option<String>,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_title: String,
    pub target_session_id: String,
    pub status: RunStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub report_ready: bool,
    pub checked_steps: u32,
    pub total_steps: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunbookExportResult {
    pub destination: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunbookEvidenceContent {
    pub evidence_id: String,
    pub available: bool,
    pub text: String,
    pub bytes: u64,
    pub redacted: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RunbookEvidenceCleanup {
    pub expected: u32,
    pub deleted: u32,
    pub missing: u32,
    pub errors: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RunbookDeleteResult {
    pub run_id: String,
    pub database_deleted: bool,
    pub evidence_cleanup: RunbookEvidenceCleanup,
}

fn gate(app: &tauri::AppHandle<Wry>) -> Result<(), String> {
    if crate::commands::settings::read_bool(app, RUNBOOKS_SETTING, false) {
        Ok(())
    } else {
        Err("runbooks are switched off — enable them in Settings → Runbooks".into())
    }
}

#[tauri::command]
pub fn runbooks_import(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    path: String,
) -> Result<SourceRegistration, String> {
    gate(&app)?;
    validate_path_argument(&path, "package path")?;
    let input = match load_and_check_package(Path::new(&path)) {
        Ok(package) => registration_input(&package, true, None)?,
        Err(error) => invalid_registration_input(Path::new(&path), &error)?,
    };
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    db::upsert_source(&connection, &input)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_refresh(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    source_id: String,
) -> Result<SourceRegistration, String> {
    gate(&app)?;
    validate_identifier(&source_id, "source id")?;
    let source = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_source(&connection, &source_id)?
            .ok_or_else(|| format!("unknown runbook source: {source_id}"))?
    };
    if source.source_kind == SourceKind::Builtin {
        return Err(
            "included runbooks are refreshed automatically from the application bundle".into(),
        );
    }
    match load_and_check_package(Path::new(&source.package_path)) {
        Ok(package) => {
            let mut input = registration_input(&package, true, None)?;
            input.source_kind = source.source_kind;
            input.hidden = source.hidden;
            input.builtin_order = source.builtin_order;
            let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
            db::upsert_source(&connection, &input)
        }
        Err(error) => {
            let input = SourceRegistrationInput {
                package_path: source.package_path.clone(),
                definition_id: source.definition_id.clone(),
                definition_version: source.definition_version.clone(),
                title: source.title.clone(),
                source_sha256: source.source_sha256.clone(),
                canonical_sha256: source.canonical_sha256.clone(),
                valid: false,
                validation_error: Some(bounded_error(&error)),
                source_kind: source.source_kind,
                hidden: source.hidden,
                builtin_order: source.builtin_order,
            };
            let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
            db::upsert_source(&connection, &input)
        }
    }
}

#[tauri::command]
pub fn runbooks_list(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
) -> Result<Vec<SourceRegistration>, String> {
    gate(&app)?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    reconcile_builtin_sources(&command_state.app_data_dir, &connection)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_remove(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    source_id: String,
) -> Result<(), String> {
    gate(&app)?;
    validate_identifier(&source_id, "source id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    if db::remove_source(&connection, &source_id)? {
        Ok(())
    } else {
        Err(format!("unknown runbook source: {source_id}"))
    }
}

#[tauri::command]
pub fn runbooks_restore_builtins(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
) -> Result<Vec<SourceRegistration>, String> {
    gate(&app)?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    reconcile_builtin_sources(&command_state.app_data_dir, &connection)?;
    db::restore_builtin_sources(&connection)
}

#[tauri::command]
pub fn runbooks_drafts_list(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
) -> Result<Vec<RunbookDraftSummary>, String> {
    gate(&app)?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    db::list_runbook_drafts(&connection)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_draft_create(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    initial: Option<RunbookDraftDocument>,
) -> Result<RunbookDraft, String> {
    gate(&app)?;
    let document = initial.unwrap_or_else(platform_default_draft_document);
    validate_draft_storage(&document)?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    Ok(db::create_runbook_draft(&connection, &document)?.draft)
}

fn default_draft_document_for_platform(windows: bool) -> RunbookDraftDocument {
    let mut document = RunbookDraftDocument::default();
    if windows {
        // Runbooks execute inside the fixed WSL2 Bash backend, so a fresh
        // Windows draft should carry the Linux target guard rather than the
        // macOS guard used by the existing desktop default.
        document.platform = DraftPlatform::Linux;
    }
    document
}

fn platform_default_draft_document() -> RunbookDraftDocument {
    default_draft_document_for_platform(cfg!(target_os = "windows"))
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_draft_get(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    draft_id: String,
) -> Result<RunbookDraft, String> {
    gate(&app)?;
    validate_identifier(&draft_id, "draft id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    Ok(db::get_runbook_draft(&connection, &draft_id)?
        .ok_or_else(|| format!("unknown runbook draft: {draft_id}"))?
        .draft)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_draft_save(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    draft_id: String,
    expected_revision: i64,
    document: RunbookDraftDocument,
) -> Result<RunbookDraft, String> {
    gate(&app)?;
    validate_identifier(&draft_id, "draft id")?;
    validate_draft_storage(&document)?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    Ok(db::save_runbook_draft(&connection, &draft_id, expected_revision, &document)?.draft)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_draft_validate(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    draft_id: String,
) -> Result<RunbookDraftPreview, String> {
    gate(&app)?;
    validate_identifier(&draft_id, "draft id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    let stored = db::get_runbook_draft(&connection, &draft_id)?
        .ok_or_else(|| format!("unknown runbook draft: {draft_id}"))?;
    Ok(validate_draft_preview(&stored.draft.document))
}

/// Author a draft with the active model. Returns the document WITHOUT storing
/// it: the frontend passes it to `runbooks_draft_create`, so a generated
/// runbook enters the wizard by exactly the path a hand-written one does and
/// there is no persistence, no publish and no run that is special-cased for AI.
///
/// Non-streaming, like `ai_name_session`: a partial JSON object is not
/// something the operator can be shown, so there is nothing to stream. It does
/// register with `AiState`, which is what makes `ai_cancel` work on it.
#[tauri::command(rename_all = "snake_case")]
pub async fn runbooks_ai_generate(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, crate::agent::AiState>,
    request_id: String,
    requirements: String,
    terminal_context: Option<String>,
) -> Result<RunbookDraftDocument, String> {
    use crate::runbooks::authoring::{MAX_CONTEXT_CHARS, MAX_REQUIREMENTS_CHARS};

    gate(&app)?;
    validate_small_text(
        &requirements,
        "runbook requirements",
        MAX_REQUIREMENTS_CHARS * 4,
        true,
    )?;
    if let Some(context) = terminal_context.as_deref() {
        validate_small_text(context, "terminal context", MAX_CONTEXT_CHARS * 4, false)?;
    }

    let model = crate::commands::ai::active_model(&app);
    let resolved = crate::commands::ai::resolve_provider_for_model(&app, model).await?;
    let cancel = ai_state.register(&request_id);
    let authored = authoring::author_draft(
        resolved.provider.as_ref(),
        &requirements,
        terminal_context.as_deref(),
        resolved.effort,
        cancel,
        &|document| validate_draft_preview(document).issues,
    )
    .await;
    ai_state.finish(&request_id);

    let authored = authored?;
    if !authored.issues.is_empty() {
        log::info!(
            "generated runbook has {} unresolved issue(s) after one repair round",
            authored.issues.len()
        );
    }
    Ok(authored.document)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_draft_discard(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    draft_id: String,
) -> Result<(), String> {
    gate(&app)?;
    validate_identifier(&draft_id, "draft id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    if db::discard_runbook_draft(&connection, &draft_id)? {
        Ok(())
    } else {
        Err(format!("unknown runbook draft: {draft_id}"))
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_draft_publish(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    draft_id: String,
    expected_revision: i64,
) -> Result<SourceRegistration, String> {
    gate(&app)?;
    validate_identifier(&draft_id, "draft id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    let stored = db::get_runbook_draft(&connection, &draft_id)?
        .ok_or_else(|| format!("unknown runbook draft: {draft_id}"))?;
    if stored.draft.revision != expected_revision {
        return Err("runbook draft changed in another window; reload it before publishing".into());
    }
    let preview = validate_draft_preview(&stored.draft.document);
    if !preview.issues.is_empty() {
        return Err(format!(
            "runbook draft is not publishable: {}",
            preview
                .issues
                .iter()
                .map(|issue| format!("{}: {}", issue.path, issue.message))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    let definition = preview
        .definition
        .ok_or("validated draft has no definition")?;
    let source_yaml = preview.source_yaml.ok_or("validated draft has no YAML")?;
    let readme = preview.readme.ok_or("validated draft has no README")?;
    let document_sha256 = sha256_hex(stored.document_json.as_bytes());

    let changed = draft_publication_changed(
        stored.last_published_document_sha256.as_deref(),
        stored.draft.last_published_version.as_deref(),
        &document_sha256,
        &definition.metadata.version,
    )?;
    if !changed {
        if let Some(source_id) = stored.draft.published_source_id.as_deref() {
            if let Some(source) = db::get_source(&connection, source_id)? {
                let package = load_and_check_package(Path::new(&source.package_path))?;
                require_registered_snapshot(&source, &package)?;
                return Ok(source);
            }
        }
    }

    let authored_root = command_state
        .app_data_dir
        .join(BUILTIN_LIBRARY_DIRECTORY)
        .join(AUTHORED_PACKAGES_DIRECTORY);
    let package_path = authored_root.join(&draft_id);
    let mut publication = publish_authored_package(
        &authored_root,
        &package_path,
        source_yaml.as_bytes(),
        readme.as_bytes(),
        stored.last_published_source_sha256.as_deref(),
        stored.last_published_readme_sha256.as_deref(),
    )?;
    let package = load_and_check_package(&package_path)?;
    let input = registration_input(&package, true, None)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("begin runbook publication transaction: {error}"))?;
    let source = db::upsert_source(&transaction, &input)?;
    db::mark_runbook_draft_published(
        &transaction,
        &draft_id,
        expected_revision,
        db::PublishedDraftHashes {
            version: &definition.metadata.version,
            document_sha256: &document_sha256,
            source_sha256: &sha256_hex(source_yaml.as_bytes()),
            readme_sha256: &sha256_hex(readme.as_bytes()),
            source_id: &source.id,
        },
    )?;
    transaction
        .commit()
        .map_err(|error| format!("commit runbook publication: {error}"))?;
    publication.commit();
    Ok(source)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_get_definition(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    source_id: String,
) -> Result<RunbookDefinition, String> {
    gate(&app)?;
    validate_identifier(&source_id, "source id")?;
    let source = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_source(&connection, &source_id)?
            .ok_or_else(|| format!("unknown runbook source: {source_id}"))?
    };
    if source.hidden {
        return Err(format!("unknown runbook source: {source_id}"));
    }
    if !source.valid {
        return Err(source
            .validation_error
            .clone()
            .unwrap_or_else(|| "the runbook package is invalid; refresh it first".into()));
    }
    let package = match load_and_check_package(Path::new(&source.package_path)) {
        Ok(package) => package,
        Err(error) => {
            mark_source_invalid(&db_state, &source, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = require_registered_snapshot(&source, &package) {
        mark_source_invalid(&db_state, &source, &error)?;
        return Err(error);
    }
    Ok(package.definition)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_start(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    pty_manager: State<'_, PtyManager>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    request: RunbookStartRequest,
    on_event: Channel<RunbookEvent>,
) -> Result<RunbookRunView, String> {
    gate(&app)?;
    validate_identifier(&request.source_id, "source id")?;
    validate_target(&request.session_id, &request.target_context, &pty_manager)?;

    let source = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_source(&connection, &request.source_id)?
            .ok_or_else(|| format!("unknown runbook source: {}", request.source_id))?
    };
    if source.hidden {
        return Err(format!("unknown runbook source: {}", request.source_id));
    }
    if !source.valid {
        return Err(source
            .validation_error
            .clone()
            .unwrap_or_else(|| "the runbook package is invalid; refresh it first".into()));
    }

    // Re-read and revalidate the full package immediately before committing the
    // immutable snapshot. A source edit never silently changes a registered run.
    let package = match load_and_check_package(Path::new(&source.package_path)) {
        Ok(package) => package,
        Err(error) => {
            mark_source_invalid(&db_state, &source, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = require_registered_snapshot(&source, &package) {
        mark_source_invalid(&db_state, &source, &error)?;
        return Err(error);
    }
    let resolved = package
        .definition
        .resolve_inputs(&request.inputs)
        .map_err(format_validation_errors)?;
    reject_sensitive_value(
        &Value::Object(resolved.clone().into_iter().collect()),
        "runbook inputs",
    )?;

    let active_model = crate::commands::ai::active_model(&app);
    let config = engine_config(&app, active_model);
    // Fail before creating durable active state if a background connection to
    // the hardened database cannot be established.
    let engine_database = open_engine_database(&command_state.app_data_dir)?;
    let creation = RunCreation {
        source_id: Some(source.id.clone()),
        definition_id: package.definition.metadata.id.clone(),
        definition_version: package.definition.metadata.version.clone(),
        definition_title: package.definition.metadata.title.clone(),
        source_yaml: package.snapshot.source_yaml.clone(),
        canonical_json: package.snapshot.canonical_json.clone(),
        source_sha256: package.snapshot.source_sha256.clone(),
        canonical_sha256: package.snapshot.canonical_sha256.clone(),
        target: request.target_context.clone(),
        inputs: Value::Object(resolved.clone().into_iter().collect()),
        evidence_mode: request.evidence_mode,
        app_version: env!("CARGO_PKG_VERSION").into(),
        model: Some(active_model.id.into()),
        steps: package
            .definition
            .spec
            .steps
            .iter()
            .map(|step| StepSeed {
                id: step.id.clone(),
                title: step.title.clone(),
                required: step.required,
            })
            .collect(),
    };
    let (record, view) = {
        let mut connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        let record = db::create_run(&mut connection, &creation)?;
        let view = run_view(&connection, &record)?;
        (record, view)
    };
    let spec = EngineRunSpec {
        run_id: record.id.clone(),
        definition: package.definition,
        definition_snapshot: package.snapshot,
        package_root: package.root,
        target: request.target_context,
        inputs: resolved,
        evidence_mode: request.evidence_mode,
        app_version: creation.app_version,
        model: creation.model,
        created_at: record.created_at,
    };
    spawn_engine(
        app,
        Arc::clone(command_state.inner()),
        engine_database,
        spec,
        config,
        active_model,
        on_event,
        false,
    );
    Ok(view)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_get(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
) -> Result<RunbookRunView, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    let run = db::get_run(&connection, &run_id)?
        .ok_or_else(|| format!("unknown runbook run: {run_id}"))?;
    run_view(&connection, &run)
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_resume(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    pty_manager: State<'_, PtyManager>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    session_id: String,
    target_context: TargetBinding,
    on_event: Channel<RunbookEvent>,
) -> Result<RunbookRunView, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_target(&session_id, &target_context, &pty_manager)?;
    let engine_database = open_engine_database(&command_state.app_data_dir)?;

    let active_model = crate::commands::ai::active_model(&app);
    let resume_app_version = env!("CARGO_PKG_VERSION");
    let resume_model = active_model.id;
    let (record, definition, inputs, package_root, view) = {
        let mut connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        let stored = db::get_run(&connection, &run_id)?
            .ok_or_else(|| format!("unknown runbook run: {run_id}"))?;
        if stored.status != RunStatus::Interrupted {
            return Err(format!(
                "run {run_id} cannot be resumed from {} (only interrupted runs can be rebound)",
                stored.status
            ));
        }
        let definition = verify_definition_snapshot(&stored)?;
        verify_run_definition_identity(&connection, &stored, &definition)?;
        let supplied_inputs = value_to_inputs(&stored.inputs)?;
        let inputs = definition
            .resolve_inputs(&supplied_inputs)
            .map_err(format_validation_errors)?;
        if Value::Object(inputs.clone().into_iter().collect()) != stored.inputs {
            return Err(
                "stored runbook inputs do not match their immutable resolved values".into(),
            );
        }
        reject_sensitive_value(&stored.inputs, "stored runbook inputs")?;
        let package_root = if definition.uses_ansible_executor() {
            let source_id = stored
                .source_id
                .as_deref()
                .ok_or("resuming an Ansible run requires its registered package source")?;
            let source = db::get_source(&connection, source_id)?
                .ok_or("the Ansible runbook package source no longer exists")?;
            let package = load_and_check_package(Path::new(&source.package_path))?;
            if package.snapshot.source_sha256 != stored.source_sha256
                || package.snapshot.canonical_sha256 != stored.canonical_sha256
            {
                return Err(
                    "the Ansible runbook package changed; the interrupted run cannot be resumed"
                        .into(),
                );
            }
            package.root
        } else {
            PathBuf::new()
        };
        let record = db::rebind_interrupted_run(
            &mut connection,
            &run_id,
            &target_context,
            true,
            resume_app_version,
            Some(resume_model),
        )?;
        let view = run_view(&connection, &record)?;
        (record, definition, inputs, package_root, view)
    };
    let config = engine_config(&app, active_model);
    let spec = EngineRunSpec {
        run_id: record.id.clone(),
        definition,
        definition_snapshot: DefinitionSnapshot {
            source_yaml: record.source_yaml,
            canonical_json: record.canonical_json,
            source_sha256: record.source_sha256,
            canonical_sha256: record.canonical_sha256,
        },
        package_root,
        target: target_context,
        inputs,
        evidence_mode: record.evidence_mode,
        app_version: resume_app_version.into(),
        model: Some(resume_model.into()),
        created_at: record.created_at,
    };
    spawn_engine(
        app,
        Arc::clone(command_state.inner()),
        engine_database,
        spec,
        config,
        active_model,
        on_event,
        true,
    );
    Ok(view)
}

fn verify_run_definition_identity(
    connection: &rusqlite::Connection,
    record: &RunRecord,
    definition: &RunbookDefinition,
) -> Result<(), String> {
    if record.definition_id != definition.metadata.id
        || record.definition_version != definition.metadata.version
        || record.definition_title != definition.metadata.title
    {
        return Err(format!(
            "stored definition metadata for run {} disagrees with its verified snapshot",
            record.id
        ));
    }
    let steps = db::list_steps(connection, &record.id)?;
    if steps.len() != definition.spec.steps.len()
        || steps
            .iter()
            .zip(&definition.spec.steps)
            .any(|(stored, expected)| {
                stored.step_id != expected.id
                    || stored.title != expected.title
                    || stored.required != expected.required
            })
    {
        return Err(format!(
            "stored step seeds for run {} disagree with its verified snapshot",
            record.id
        ));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_cancel(
    _app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
) -> Result<(), String> {
    // Cancellation remains reachable after the experimental feature is turned
    // off so a stale client can only reduce capability, never strand a run.
    validate_identifier(&run_id, "run id")?;
    let status = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_run(&connection, &run_id)?
            .ok_or_else(|| format!("unknown runbook run: {run_id}"))?
            .status
    };
    if status.is_terminal() {
        return Ok(());
    }
    command_state.cancellations.cancel(&run_id);
    // Linearize cancellation with the one-time terminal dispatch lease. Once
    // cancel returns, a delayed webview beforeWrite handler cannot claim and
    // type a mutation that was pending at cancellation time.
    command_state.pty.cancel_run(&run_id);

    // An interrupted run has no background waiter after process restart. A new
    // created/ready run does have a spawned engine task, whose sticky
    // cancellation receiver remains the sole transition/report owner.
    if status == RunStatus::Interrupted {
        let mut connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::cancel_pending_approvals_for_run(&mut connection, &run_id)?;
        db::finalize_run(
            &mut connection,
            &run_id,
            status,
            RunStatus::Cancelled,
            Some("operator cancelled the run"),
            "The run was cancelled by the operator before execution resumed.",
        )?;
        release_runtime_waiters(&command_state, &run_id);
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_respond_approval(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    approval_id: String,
    approved: bool,
    command: Option<String>,
    shell_attested: bool,
) -> Result<(), String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_identifier(&approval_id, "approval id")?;
    let (approval, target) = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        let approval = db::get_approval(&connection, &approval_id)?
            .ok_or_else(|| format!("unknown runbook approval: {approval_id}"))?;
        let target = db::get_run(&connection, &run_id)?
            .ok_or_else(|| format!("unknown runbook run: {run_id}"))?
            .target;
        (approval, target)
    };
    if approval.run_id != run_id {
        return Err("approval does not belong to the requested run".into());
    }
    if approval.status != ApprovalStatus::Pending {
        return Err(format!(
            "approval {approval_id} is already {}",
            approval.status
        ));
    }
    if !approved && command.is_some() {
        return Err("a declined approval cannot carry an edited command".into());
    }
    let model_invocation = approval
        .proposed_command
        .as_deref()
        .is_some_and(|value| value.starts_with("model://configured-agent/"));
    if approved && !model_invocation && !shell_attested {
        return Err(
            "shell approval requires operator attestation of the visible POSIX prompt and session shell state"
                .into(),
        );
    }
    if model_invocation && shell_attested {
        return Err("model approval cannot carry a shell-prompt attestation".into());
    }
    let edited_command = if approved {
        normalize_edited_command(command, approval.proposed_command.as_deref())?
    } else {
        None
    };
    let target_basis = match (&target.remote_kind, &target.remote_target, &target.cwd) {
        (Some(kind), Some(remote), _) => format!("{kind} {remote}"),
        (Some(kind), None, _) => format!("{kind} session {}", target.session_id),
        (_, _, Some(cwd)) => format!("local session {} at {cwd}", target.session_id),
        _ => format!("session {}", target.session_id),
    };
    let reason = if approved {
        if model_invocation {
            "operator allowed the configured model once".to_string()
        } else if edited_command.is_some() {
            format!(
                "operator attested that the visible POSIX shell prompt is on bound target {target_basis}, trusted the session shell, functions, aliases, and PATH, and approved an edited command"
            )
        } else {
            format!(
                "operator attested that the visible POSIX shell prompt is on bound target {target_basis}, trusted the session shell, functions, aliases, and PATH, and approved the proposed command"
            )
        }
    } else {
        "operator declined the proposed command".to_string()
    };
    command_state.approvals.respond(
        &approval_id,
        ApprovalResponse {
            decision: if approved {
                ApprovalDecision::Approve
            } else {
                ApprovalDecision::Decline
            },
            actor: "operator".into(),
            reason: Some(reason),
            edited_command,
        },
    )
}

fn normalize_edited_command(
    command: Option<String>,
    proposed_command: Option<&str>,
) -> Result<Option<String>, String> {
    command
        .map(|value| value.trim_matches(frontend_trim_character).to_string())
        .filter(|value| {
            Some(value.as_str())
                != proposed_command.map(|proposed| proposed.trim_matches(frontend_trim_character))
        })
        .map(|value| {
            validate_runtime_command(&value)?;
            reject_sensitive_text(&value, "approved command")?;
            Ok::<String, String>(value)
        })
        .transpose()
}

fn frontend_trim_character(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_decide(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    decision: RunbookOperatorDecision,
) -> Result<(), String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    if decision.session_id.is_some() || decision.target_context.is_some() {
        return Err("target rebinding is only accepted by runbooks_resume".into());
    }
    let run = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_run(&connection, &run_id)?
            .ok_or_else(|| format!("unknown runbook run: {run_id}"))?
    };
    if !matches!(run.status, RunStatus::Paused | RunStatus::WaitingOperator) {
        return Err(format!("run {run_id} is not waiting for an operator"));
    }
    let step_id = decision
        .step_id
        .or(run.active_step_id)
        .ok_or_else(|| "the paused run has no active step".to_string())?;
    validate_identifier(&step_id, "step id")?;
    let actor = sanitize_operator_text(
        decision.actor.as_deref().unwrap_or("operator"),
        "decision actor",
        true,
    )?;
    let reason = decision
        .reason
        .as_deref()
        .map(|value| sanitize_operator_text(value, "decision reason", true))
        .transpose()?;
    let waiver = if decision.kind == PauseDecision::Waive {
        Some(Waiver {
            actor,
            reason: reason
                .clone()
                .ok_or_else(|| "a waiver requires a reason".to_string())?,
            created_at: now(),
        })
    } else {
        None
    };
    command_state.decisions.respond(
        &run_id,
        &step_id,
        OperatorDecisionResponse {
            decision: decision.kind,
            waiver,
            comment: reason,
        },
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_submit_terminal_result(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    attempt_id: String,
    result: RunbookTerminalResult,
) -> Result<(), String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_identifier(&attempt_id, "attempt id")?;
    validate_terminal_capture(&result)?;
    if result.duration_ms > MAX_TERMINAL_DURATION_MS {
        return Err("terminal result duration exceeds 24 hours".into());
    }
    if let Some(mode) = result.execution_mode.as_deref() {
        validate_small_text(mode, "execution mode", 128, false)?;
    }
    let (attempt, run) = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        let attempt = db::get_attempt(&connection, &attempt_id)?
            .ok_or_else(|| format!("unknown runbook attempt: {attempt_id}"))?;
        let run = db::get_run(&connection, &run_id)?
            .ok_or_else(|| format!("unknown runbook run: {run_id}"))?;
        (attempt, run)
    };
    if attempt.run_id != run_id {
        return Err("terminal attempt does not belong to the requested run".into());
    }
    if attempt.status != AttemptStatus::Running {
        return Err(format!(
            "terminal attempt {} is {}",
            attempt.id, attempt.status
        ));
    }
    let drift_error = match result.target_context.as_ref() {
        Some(observed) => validate_observed_target(observed).err().or_else(|| {
            (!run.target.same_execution_context(observed)).then(|| {
                "the terminal target changed during command execution; outcome is unknown"
                    .to_string()
            })
        }),
        None => Some(
            "the frontend did not provide a fresh terminal target observation; outcome is unknown"
                .into(),
        ),
    };
    let reported_error = result
        .error
        .as_deref()
        .map(|value| sanitize_bounded(value, MAX_TERMINAL_ERROR_BYTES))
        .transpose()?;
    let target_drifted = drift_error.is_some();
    let error = drift_error.or(reported_error);
    command_state.pty.respond(
        &attempt_id,
        ObservedPtyResult {
            exit_code: if target_drifted {
                None
            } else {
                result.exit_code
            },
            // Keep up to the 1 MiB boundary for full evidence. The engine owns
            // the selected none/tail/full capture and redaction policy.
            output_tail: result.output_tail,
            output_truncated: result.output_truncated,
            output_observed_bytes: result.output_observed_bytes,
            output_captured_bytes: result.output_captured_bytes,
            duration_ms: result.duration_ms,
            error,
        },
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_claim_terminal_dispatch(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    attempt_id: String,
) -> Result<bool, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_identifier(&attempt_id, "attempt id")?;
    let attempt = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_attempt(&connection, &attempt_id)?
            .ok_or_else(|| format!("unknown runbook attempt: {attempt_id}"))?
    };
    validate_terminal_dispatch_attempt(&attempt, &run_id)?;
    command_state.pty.claim_dispatch(&attempt_id, &run_id)
}

fn validate_terminal_dispatch_attempt(attempt: &AttemptRecord, run_id: &str) -> Result<(), String> {
    if attempt.run_id != run_id {
        return Err("terminal attempt does not belong to the requested run".into());
    }
    if attempt.status != AttemptStatus::Running {
        return Err(format!(
            "terminal attempt {} is {}",
            attempt.id, attempt.status
        ));
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub fn runbooks_submit_manual(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    step_id: String,
    outcome: ManualWireOutcome,
    comment: String,
    evidence: Option<String>,
    target_context: TargetBinding,
) -> Result<(), String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_identifier(&step_id, "step id")?;
    validate_observed_target(&target_context)?;
    let comment = sanitize_operator_text(&comment, "manual comment", true)?;
    let phase = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        let run = db::get_run(&connection, &run_id)?
            .ok_or_else(|| format!("unknown runbook run: {run_id}"))?;
        if run.active_step_id.as_deref() != Some(&step_id) {
            return Err(format!("step {step_id} is not active for run {run_id}"));
        }
        if !run.target.same_execution_context(&target_context) {
            return Err("manual attestation target changed from the immutable run binding".into());
        }
        run.active_phase
            .ok_or_else(|| "the active step is not waiting for a manual phase".to_string())?
    };
    let outcome = manual_outcome(phase, outcome);
    let evidence = validate_manual_evidence(evidence)?;
    command_state.manual_index.respond(
        &command_state.manual,
        &run_id,
        &step_id,
        ManualResponse {
            outcome,
            actor: "operator".into(),
            comment,
            evidence,
            target: target_context,
        },
    )
}

fn validate_manual_evidence(evidence: Option<String>) -> Result<Option<String>, String> {
    evidence
        .map(|value| {
            if value.len() > FULL_EVIDENCE_BYTES {
                return Err(format!(
                    "manual evidence exceeds the {} byte IPC limit",
                    FULL_EVIDENCE_BYTES
                ));
            }
            Ok((!value.is_empty()).then_some(value))
        })
        .transpose()
        .map(Option::flatten)
}

fn manual_outcome(phase: RunbookPhase, outcome: ManualWireOutcome) -> ManualOutcome {
    match (phase, outcome) {
        (RunbookPhase::Check, ManualWireOutcome::Passed) => ManualOutcome::Compliant,
        (RunbookPhase::Check, ManualWireOutcome::Failed) => ManualOutcome::Noncompliant,
        (RunbookPhase::Apply, ManualWireOutcome::Passed) => ManualOutcome::Applied,
        (RunbookPhase::Verify, ManualWireOutcome::Passed) => ManualOutcome::Verified,
        // N/A is not silently equated with either compliance or a waiver. It
        // enters the normal failed-phase decision flow, where skip and waive
        // remain explicit, distinct, auditable operator decisions.
        (_, ManualWireOutcome::NotApplicable) | (_, ManualWireOutcome::Failed) => {
            ManualOutcome::Failed
        }
    }
}

#[tauri::command]
pub fn runbooks_history(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
) -> Result<Vec<RunbookHistoryView>, String> {
    gate(&app)?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    db::list_runs(&connection, HISTORY_LIMIT, 0)?
        .into_iter()
        .map(|summary| {
            let run = db::get_run(&connection, &summary.id)?
                .ok_or_else(|| format!("run {} disappeared", summary.id))?;
            let steps = db::list_steps(&connection, &summary.id)?;
            Ok(RunbookHistoryView {
                id: summary.id,
                source_id: run.source_id,
                definition_id: summary.definition_id,
                definition_version: summary.definition_version,
                definition_title: summary.definition_title,
                target_session_id: summary.target_session_id,
                status: summary.status,
                created_at: summary.created_at,
                started_at: summary.started_at,
                finished_at: summary.finished_at,
                report_ready: summary.report_ready,
                checked_steps: steps.iter().filter(|step| step.status.is_checked()).count() as u32,
                total_steps: steps.len() as u32,
            })
        })
        .collect()
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_delete(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    confirmed: bool,
) -> Result<RunbookDeleteResult, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    if !confirmed {
        return Err("explicit confirmation is required to delete runbook history".into());
    }
    // Keep the immutable audit metadata until every registered artifact is
    // removed or already absent. If filesystem cleanup fails, the same
    // confirmed action can be retried safely instead of creating an orphan with
    // no durable path/ownership record.
    let mut connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    let inspected = db::tombstone_evidence_for_deletion(&mut connection, &run_id)?;
    let evidence_cleanup = cleanup_evidence_artifacts(
        &command_state.app_data_dir,
        &inspected.id,
        &inspected.evidence,
    );
    if !evidence_cleanup.complete {
        return Ok(RunbookDeleteResult {
            run_id,
            database_deleted: false,
            evidence_cleanup,
        });
    }
    db::delete_terminal_run(&mut connection, &run_id)?;
    drop(connection);
    release_runtime_waiters(&command_state, &run_id);
    Ok(RunbookDeleteResult {
        run_id,
        database_deleted: true,
        evidence_cleanup,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_report(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    run_id: String,
) -> Result<RunbookReport, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    db::load_report(&connection, &run_id)?
        .ok_or_else(|| format!("report for run {run_id} is not ready"))
}

/// Read one recorded artifact back so the operator can review it in the app.
#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_evidence_read(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    evidence_id: String,
) -> Result<RunbookEvidenceContent, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_identifier(&evidence_id, "evidence id")?;
    let evidence = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::find_evidence(&connection, &run_id, &evidence_id)?
            .ok_or_else(|| format!("evidence {evidence_id} does not belong to run {run_id}"))?
    };
    let Some(bytes) = db::read_complete_evidence_artifact(&command_state.app_data_dir, &evidence)?
    else {
        return Ok(RunbookEvidenceContent {
            evidence_id,
            available: false,
            text: String::new(),
            bytes: evidence.bytes,
            redacted: evidence.redacted,
            truncated: evidence.truncated,
        });
    };
    Ok(RunbookEvidenceContent {
        evidence_id,
        available: true,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        bytes: evidence.bytes,
        redacted: evidence.redacted,
        truncated: evidence.truncated,
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_export(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    command_state: State<'_, Arc<RunbookCommandState>>,
    run_id: String,
    destination: String,
) -> Result<RunbookExportResult, String> {
    gate(&app)?;
    validate_identifier(&run_id, "run id")?;
    validate_path_argument(&destination, "export destination")?;
    let report = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::load_report(&connection, &run_id)?
            .ok_or_else(|| format!("report for run {run_id} is not ready"))?
    };
    export_report_bundle(
        &command_state.app_data_dir,
        &report,
        Path::new(&destination),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn runbooks_export_package(
    app: tauri::AppHandle<Wry>,
    db_state: State<'_, DbState>,
    source_id: String,
    destination: String,
) -> Result<RunbookExportResult, String> {
    gate(&app)?;
    validate_identifier(&source_id, "source id")?;
    validate_path_argument(&destination, "export destination")?;
    let source = {
        let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
        db::get_source(&connection, &source_id)?
            .filter(|source| !source.hidden)
            .ok_or_else(|| format!("unknown runbook source: {source_id}"))?
    };
    if !source.valid {
        return Err(source
            .validation_error
            .clone()
            .unwrap_or_else(|| "the runbook package is invalid; refresh it first".into()));
    }
    let package = match load_and_check_package(Path::new(&source.package_path)) {
        Ok(package) => package,
        Err(error) => {
            mark_source_invalid(&db_state, &source, &error)?;
            return Err(error);
        }
    };
    if let Err(error) = require_registered_snapshot(&source, &package) {
        mark_source_invalid(&db_state, &source, &error)?;
        return Err(error);
    }
    export_runbook_package(&source, &package, Path::new(&destination))
}

fn spawn_engine(
    app: tauri::AppHandle<Wry>,
    state: Arc<RunbookCommandState>,
    database: DbState,
    spec: EngineRunSpec,
    config: EngineConfig,
    selected_model: &'static crate::models::catalog::CatalogModel,
    on_event: Channel<RunbookEvent>,
    resume: bool,
) {
    tauri::async_runtime::spawn(async move {
        let run_id = spec.run_id.clone();
        // Shell/manual-only definitions with deterministic summaries have no
        // model boundary. Do not read Keychain or initialize a provider merely
        // because the app has a cloud model selected.
        let resolved = if runbook_requires_model_provider(&spec.definition, &config) {
            match crate::commands::ai::resolve_provider_for_model(&app, selected_model).await {
                Ok(resolved) => Some(resolved),
                Err(error) => {
                    log::warn!("runbook {run_id} could not resolve its recorded model; deterministic summaries will be used: {error}");
                    None
                }
            }
        } else {
            None
        };
        let observer = LiveTargetObserver {
            app: app.clone(),
            expected: spec.target.clone(),
        };
        let context = EngineContext {
            coordinator: &state.coordinator,
            approvals: &state.approvals,
            pty: &state.pty,
            manual: &state.manual,
            manual_index: &state.manual_index,
            decisions: &state.decisions,
            cancellations: &state.cancellations,
            events: &on_event,
            database: Some(&database),
            evidence_root: Some(&state.app_data_dir),
            provider: resolved
                .as_ref()
                .map(|resolved| resolved.provider.as_ref() as &dyn crate::provider::Provider),
            target_observer: &observer,
            config,
        };
        let execution = if resume {
            resume_runbook(&context, spec).await
        } else {
            execute_runbook(&context, spec).await
        };
        if let Err(error) = execution {
            // The engine owns terminal settlement, canonical report generation
            // and its single Error/ReportReady/RunFinished sequence.
            log::error!(
                "runbook {run_id} engine failed after settlement: {}",
                bounded_error(&error)
            );
        }
    });
}

fn runbook_requires_model_provider(definition: &RunbookDefinition, config: &EngineConfig) -> bool {
    config.summarize_with_model
        || definition.spec.steps.iter().any(|step| {
            matches!(&step.check, Some(CheckAction::Agent { .. }))
                || step
                    .apply
                    .as_ref()
                    .is_some_and(|action| matches!(action, ApplyAction::Agent { .. }))
                || step
                    .verify
                    .as_ref()
                    .is_some_and(|action| matches!(action, VerifyAction::Agent { .. }))
        })
}

fn open_engine_database(app_data_dir: &Path) -> Result<DbState, String> {
    crate::database::open_hardened(app_data_dir, MAIN_DATABASE_FILE)
        .map(|connection| DbState(Mutex::new(connection)))
}

/// Rust cannot infer a changed SSH/container context from PTY ownership alone;
/// shell integration reports that drift to the frontend, which returns an
/// unknown terminal result. This observer still enforces the production minimum
/// independently: the exact preflight binding is used only while its PTY session
/// remains present. Closing the terminal produces an intentionally different
/// marker and pauses before dispatch.
struct LiveTargetObserver {
    app: tauri::AppHandle<Wry>,
    expected: TargetBinding,
}

impl TargetObserver for LiveTargetObserver {
    fn observe(&self, session_id: &str) -> Result<TargetBinding, String> {
        if session_id != self.expected.session_id {
            return Err("engine requested a terminal other than its bound target".into());
        }
        let manager = self.app.state::<PtyManager>();
        if manager.list().iter().any(|id| id == session_id) {
            return Ok(self.expected.clone());
        }
        let mut closed = self.expected.clone();
        closed.context_marker = Some(format!(
            "{}#closed",
            self.expected.context_marker.as_deref().unwrap_or("runbook")
        ));
        closed.observed_at = now();
        Ok(closed)
    }
}

fn release_runtime_waiters(state: &RunbookCommandState, run_id: &str) {
    state.approvals.drain_run(run_id);
    state.pty.drain_run(run_id);
    state.manual.drain_run(run_id);
    state.manual_index.drain_run(run_id);
    state.decisions.drain_run(run_id);
    state.cancellations.finish(run_id);
}

fn cleanup_evidence_artifacts(
    app_data_dir: &Path,
    run_id: &str,
    evidence: &[db::EvidenceRecord],
) -> RunbookEvidenceCleanup {
    let mut artifacts = BTreeMap::<String, (u64, String, bool, Option<String>)>::new();
    for item in evidence {
        let Some(relative) = item.relative_path.as_deref() else {
            continue;
        };
        let staging = db::evidence_staging_relative_path(item).ok();
        match artifacts.get_mut(relative) {
            Some((bytes, sha256, conflicting, known_staging)) => {
                if *bytes != item.bytes || *sha256 != item.sha256 {
                    *conflicting = true;
                }
                if known_staging.as_deref() != staging.as_deref() {
                    *conflicting = true;
                }
            }
            None => {
                artifacts.insert(
                    relative.to_string(),
                    (item.bytes, item.sha256.clone(), false, staging),
                );
            }
        }
    }
    let expected = artifacts.len().min(u32::MAX as usize) as u32;
    let mut outcome = RunbookEvidenceCleanup {
        expected,
        deleted: 0,
        missing: 0,
        errors: Vec::new(),
        complete: false,
    };
    #[allow(unused_mut)]
    let root = {
        #[cfg(not(target_os = "windows"))]
        let root = fs::canonicalize(app_data_dir);
        #[cfg(target_os = "windows")]
        let root = crate::windows_fs::validate_local_ntfs_path(app_data_dir);
        match root {
            Ok(root) => root,
            Err(error) => {
                push_cleanup_error(
                    &mut outcome.errors,
                    format!("cannot resolve protected app data: {error}"),
                );
                return outcome;
            }
        }
    };
    let expected_directory = PathBuf::from("runbooks").join(run_id);

    for (relative, (_bytes, _sha256, conflicting, staging)) in artifacts {
        if conflicting {
            push_cleanup_error(
                &mut outcome.errors,
                format!("{relative}: conflicting evidence metadata; retained"),
            );
            continue;
        }
        let mut removed_any = false;
        let mut artifact_error = false;
        for candidate in std::iter::once(relative.as_str()).chain(staging.as_deref()) {
            match confined_evidence_file(&root, &expected_directory, candidate) {
                Ok(None) => {}
                Err(error) => {
                    artifact_error = true;
                    push_cleanup_error(&mut outcome.errors, error);
                }
                // Metadata proves this exact confined regular leaf belongs to
                // the confirmed run. Hashes protect export integrity, but a
                // crash may leave a partial staging/final file; mismatch must
                // not make explicit history deletion impossible.
                Ok(Some(path)) => match remove_evidence_artifact(&path) {
                    Ok(true) => removed_any = true,
                    Ok(false) => {}
                    Err(error) => {
                        artifact_error = true;
                        push_cleanup_error(
                            &mut outcome.errors,
                            format!("{candidate}: delete evidence artifact: {error}"),
                        );
                    }
                },
            }
        }
        if !artifact_error {
            if removed_any {
                outcome.deleted = outcome.deleted.saturating_add(1);
            } else {
                outcome.missing = outcome.missing.saturating_add(1);
            }
        }
    }

    // Never recurse. An empty, ordinary per-run directory can be removed; any
    // untracked content is retained and reported for explicit operator review.
    let run_directory = root.join(&expected_directory);
    match remove_empty_evidence_directory(&run_directory) {
        Ok(None | Some(true)) => {}
        Ok(Some(false)) => push_cleanup_error(
            &mut outcome.errors,
            "evidence run directory contains untracked content; retained".into(),
        ),
        Err(error) => push_cleanup_error(&mut outcome.errors, error),
    }
    outcome.complete = outcome.errors.is_empty();
    outcome
}

fn confined_evidence_file(
    canonical_root: &Path,
    expected_directory: &Path,
    relative: &str,
) -> Result<Option<PathBuf>, String> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative_path.parent() != Some(expected_directory)
    {
        return Err(format!(
            "{relative}: evidence path is outside the run's protected directory; retained"
        ));
    }

    let mut candidate = canonical_root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(name) = component else {
            unreachable!("validated above")
        };
        candidate.push(name);
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!("{relative}: cannot inspect artifact path: {error}"));
            }
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "{relative}: symlinked evidence paths are never deleted"
                ));
            }
            Ok(_) => {}
        }
    }
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("{relative}: cannot inspect artifact: {error}"))?;
    if !metadata.is_file() {
        return Err(format!(
            "{relative}: evidence artifact is not a regular file; retained"
        ));
    }
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("{relative}: cannot resolve artifact: {error}"))?;
    if !canonical.starts_with(canonical_root) {
        return Err(format!(
            "{relative}: resolved artifact escapes protected app data; retained"
        ));
    }
    Ok(Some(canonical))
}

#[cfg(target_os = "windows")]
fn remove_evidence_artifact(path: &Path) -> Result<bool, String> {
    crate::windows_fs::remove_file_no_reparse(path)
        .map_err(|error| format!("delete evidence artifact: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn remove_evidence_artifact(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("delete evidence artifact: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn remove_empty_evidence_directory(path: &Path) -> Result<Option<bool>, String> {
    crate::windows_fs::remove_empty_directory_no_reparse(path)
        .map_err(|error| format!("inspect or remove the evidence run directory: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn remove_empty_evidence_directory(path: &Path) -> Result<Option<bool>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "cannot inspect the evidence run directory: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(
            "evidence run directory is not an ordinary confined directory; retained".into(),
        );
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("cannot read the evidence run directory: {error}"))?;
    if entries.next().is_some() {
        return Ok(Some(false));
    }
    fs::remove_dir(path)
        .map_err(|error| format!("cannot remove the empty evidence run directory: {error}"))?;
    Ok(Some(true))
}

fn push_cleanup_error(errors: &mut Vec<String>, error: String) {
    if errors.len() < MAX_CLEANUP_ERRORS {
        errors.push(bounded_error(&error));
    } else if errors.len() == MAX_CLEANUP_ERRORS {
        errors.push("additional evidence cleanup errors were omitted".into());
    }
}

fn run_view(connection: &rusqlite::Connection, run: &RunRecord) -> Result<RunbookRunView, String> {
    let steps = db::list_steps(connection, &run.id)?;
    let attempts = db::list_attempts(connection, &run.id)?;
    let approvals = db::list_approvals(connection, &run.id)?;
    let pending_approval = approvals
        .iter()
        .rev()
        .find(|approval| approval.status == ApprovalStatus::Pending)
        .map(pending_approval_view);
    let pending_approval_id = pending_approval
        .as_ref()
        .map(|approval| approval.approval_id.clone());
    let pending_manual = pending_manual_view(run)?;
    let pending_operator = matches!(run.status, RunStatus::Paused | RunStatus::WaitingOperator)
        .then(|| PendingOperatorView {
            run_id: run.id.clone(),
            step_id: run.active_step_id.clone(),
            reason: run
                .pause_reason
                .clone()
                .unwrap_or_else(|| "operator decision required".into()),
            choices: if pending_manual.is_some() {
                Vec::new()
            } else {
                vec![
                    PauseDecision::Retry,
                    PauseDecision::Skip,
                    PauseDecision::Waive,
                    PauseDecision::Stop,
                ]
            },
            message: run
                .pause_reason
                .clone()
                .unwrap_or_else(|| "Choose how to continue this run.".into()),
            requested_at: run.updated_at.clone(),
        });
    Ok(RunbookRunView {
        run_id: run.id.clone(),
        status: run.status,
        target: run.target.clone(),
        active_step_id: run.active_step_id.clone(),
        active_phase: run.active_phase,
        pending_approval_id,
        pause_reason: run.pause_reason.clone(),
        steps: steps
            .iter()
            .map(|step| step_view(step, run, &attempts))
            .collect(),
        source_id: run.source_id.clone(),
        definition_id: run.definition_id.clone(),
        definition_version: run.definition_version.clone(),
        definition_title: run.definition_title.clone(),
        inputs: run.inputs.clone(),
        evidence_mode: run.evidence_mode,
        pending_approval,
        pending_operator,
        pending_manual,
        created_at: run.created_at.clone(),
        started_at: run.started_at.clone(),
        finished_at: run.finished_at.clone(),
        report_ready: run.report_generated_at.is_some(),
    })
}

fn pending_manual_view(run: &RunRecord) -> Result<Option<PendingManualView>, String> {
    if run.status != RunStatus::WaitingOperator {
        return Ok(None);
    }
    let (Some(step_id), Some(phase)) = (run.active_step_id.as_deref(), run.active_phase) else {
        return Ok(None);
    };
    let definition = verify_definition_snapshot(run)?;
    let Some(step) = definition.spec.steps.iter().find(|step| step.id == step_id) else {
        return Err(format!(
            "active runbook step {step_id} is missing from its snapshot"
        ));
    };
    let instructions = match (
        phase,
        &step.check,
        step.apply.as_ref(),
        step.verify.as_ref(),
    ) {
        (RunbookPhase::Check, Some(CheckAction::Manual { instructions }), _, _) => {
            Some(instructions)
        }
        (RunbookPhase::Apply, _, Some(ApplyAction::Manual { instructions }), _) => {
            Some(instructions)
        }
        (RunbookPhase::Verify, _, _, Some(VerifyAction::Manual { instructions })) => {
            Some(instructions)
        }
        _ => None,
    };
    Ok(instructions.map(|instructions| PendingManualView {
        run_id: run.id.clone(),
        step_id: step.id.clone(),
        title: step.title.clone(),
        phase,
        instructions: instructions.clone(),
    }))
}

fn step_view(step: &StepRecord, run: &RunRecord, attempts: &[AttemptRecord]) -> RunbookStepView {
    let exception = step.status.is_exception().then(|| {
        if run.active_step_id.as_deref() == Some(&step.step_id) {
            run.pause_reason
                .clone()
                .unwrap_or_else(|| format!("step is {}", step.status))
        } else {
            format!("step is {}", step.status)
        }
    });
    RunbookStepView {
        id: step.step_id.clone(),
        status: step.status,
        title: step.title.clone(),
        required: step.required,
        index: step.sort_order,
        phase: (run.active_step_id.as_deref() == Some(&step.step_id))
            .then_some(run.active_phase)
            .flatten(),
        assurance: step.assurance,
        summary: step.summary.clone(),
        operator_comment: step.operator_comment.clone(),
        exception,
        attempts: attempts
            .iter()
            .filter(|attempt| attempt.step_id == step.step_id)
            .map(attempt_view)
            .collect(),
    }
}

fn attempt_view(attempt: &AttemptRecord) -> RunbookAttemptView {
    RunbookAttemptView {
        attempt_id: attempt.id.clone(),
        step_id: attempt.step_id.clone(),
        phase: attempt.phase,
        executor: attempt.executor.clone(),
        status: attempt.status,
        proposed_command: attempt.proposed_command.clone(),
        executed_command: attempt.executed_command.clone(),
        exit_code: attempt.exit_code,
        output_tail: attempt.output_tail.clone(),
        output_observed_bytes: attempt.output_observed_bytes,
        output_captured_bytes: attempt.output_captured_bytes,
        output_truncated: attempt.output_truncated,
        output_redacted: attempt.output_redacted,
        duration_ms: attempt.duration_ms,
        error: attempt.error.clone(),
        structured_outcomes: attempt.structured_outcomes.clone(),
        started_at: attempt
            .started_at
            .clone()
            .unwrap_or_else(|| attempt.intent_at.clone()),
        finished_at: attempt.result_at.clone(),
    }
}

fn pending_approval_view(approval: &ApprovalRecord) -> PendingApprovalView {
    PendingApprovalView {
        approval_id: approval.id.clone(),
        run_id: approval.run_id.clone(),
        step_id: approval.step_id.clone(),
        phase: approval.phase,
        command: approval.proposed_command.clone().unwrap_or_default(),
        explanation: if approval.phase == RunbookPhase::Apply {
            "This apply action mutates the target and requires explicit approval.".into()
        } else {
            "This check or verification is not conclusively local and read-only.".into()
        },
        classification: CommandClassificationView {
            read_only: approval.read_only,
            network: approval.network,
            privileged: approval.privileged,
            opaque: approval.opaque,
        },
        requested_at: approval.requested_at.clone(),
    }
}

fn load_and_check_package(path: &Path) -> Result<ValidatedPackage, String> {
    let package = load_package(path).map_err(|error| error.to_string())?;
    reject_sensitive_text(&package.snapshot.source_yaml, "runbook definition")?;
    Ok(package)
}

fn registration_input(
    package: &ValidatedPackage,
    valid: bool,
    validation_error: Option<String>,
) -> Result<SourceRegistrationInput, String> {
    let package_path = package
        .root
        .to_str()
        .ok_or("runbook package path must be UTF-8")?
        .to_string();
    Ok(SourceRegistrationInput {
        package_path,
        definition_id: package.definition.metadata.id.clone(),
        definition_version: package.definition.metadata.version.clone(),
        title: package.definition.metadata.title.clone(),
        source_sha256: package.snapshot.source_sha256.clone(),
        canonical_sha256: package.snapshot.canonical_sha256.clone(),
        valid,
        validation_error,
        source_kind: SourceKind::User,
        hidden: false,
        builtin_order: None,
    })
}

/// Keep a malformed package visible in the library with its validation error,
/// but only after proving that the selected root itself is an ordinary local
/// directory. We deliberately do not read arbitrary files to manufacture
/// metadata from an invalid definition.
fn invalid_registration_input(path: &Path, error: &str) -> Result<SourceRegistrationInput, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| format!("inspect invalid runbook package: {source}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(error.to_string());
    }
    let root = fs::canonicalize(path)
        .map_err(|source| format!("resolve invalid runbook package: {source}"))?;
    let package_path = root
        .to_str()
        .ok_or("runbook package path must be UTF-8")?
        .to_string();
    let identity = sha256_hex(package_path.as_bytes());
    let folder = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Invalid runbook package");
    let folder = redact_sensitive(folder).0;
    Ok(SourceRegistrationInput {
        package_path,
        definition_id: format!("invalid-{}", &identity[..16]),
        definition_version: "0.0.0".into(),
        title: folder,
        source_sha256: identity.clone(),
        canonical_sha256: identity,
        valid: false,
        validation_error: Some(bounded_error(error)),
        source_kind: SourceKind::User,
        hidden: false,
        builtin_order: None,
    })
}

fn require_registered_snapshot(
    source: &SourceRegistration,
    package: &ValidatedPackage,
) -> Result<(), String> {
    if source.package_path
        != package
            .root
            .to_str()
            .ok_or("runbook package path must be UTF-8")?
        || source.definition_id != package.definition.metadata.id
        || source.definition_version != package.definition.metadata.version
        || source.source_sha256 != package.snapshot.source_sha256
        || source.canonical_sha256 != package.snapshot.canonical_sha256
    {
        return Err(
            "runbook package changed since its last refresh; refresh and review it before starting"
                .into(),
        );
    }
    Ok(())
}

fn mark_source_invalid(
    db_state: &DbState,
    source: &SourceRegistration,
    error: &str,
) -> Result<(), String> {
    let connection = db_state.0.lock().map_err(|_| "runbook database poisoned")?;
    db::upsert_source(
        &connection,
        &SourceRegistrationInput {
            package_path: source.package_path.clone(),
            definition_id: source.definition_id.clone(),
            definition_version: source.definition_version.clone(),
            title: source.title.clone(),
            source_sha256: source.source_sha256.clone(),
            canonical_sha256: source.canonical_sha256.clone(),
            valid: false,
            validation_error: Some(bounded_error(error)),
            source_kind: source.source_kind,
            hidden: source.hidden,
            builtin_order: source.builtin_order,
        },
    )?;
    Ok(())
}

fn validate_target(
    session_id: &str,
    target: &TargetBinding,
    pty_manager: &PtyManager,
) -> Result<(), String> {
    validate_identifier(session_id, "terminal session id")?;
    if target.kind != "active-terminal" {
        return Err("native v1 runbooks require target kind active-terminal".into());
    }
    if target.session_id != session_id {
        return Err("target context does not match the selected terminal session".into());
    }
    for (label, value) in [
        ("target shell", target.shell.as_deref()),
        ("target cwd", target.cwd.as_deref()),
        ("target remote kind", target.remote_kind.as_deref()),
        ("target remote target", target.remote_target.as_deref()),
        ("target context marker", target.context_marker.as_deref()),
    ] {
        if let Some(value) = value {
            validate_small_text(value, label, MAX_TARGET_FIELD_BYTES, false)?;
            reject_sensitive_text(value, label)?;
        }
    }
    validate_fresh_timestamp(&target.observed_at, "target observed_at")?;
    if !pty_manager.list().iter().any(|id| id == session_id) {
        return Err("the selected terminal session is no longer available".into());
    }
    Ok(())
}

fn validate_observed_target(target: &TargetBinding) -> Result<(), String> {
    validate_identifier(&target.session_id, "observed target session id")?;
    if target.kind != "active-terminal" {
        return Err("observed target kind must be active-terminal".into());
    }
    validate_fresh_timestamp(&target.observed_at, "observed target timestamp")?;
    for (label, value) in [
        ("observed target shell", target.shell.as_deref()),
        ("observed target cwd", target.cwd.as_deref()),
        ("observed target remote kind", target.remote_kind.as_deref()),
        (
            "observed target remote target",
            target.remote_target.as_deref(),
        ),
        (
            "observed target context marker",
            target.context_marker.as_deref(),
        ),
    ] {
        if let Some(value) = value {
            validate_small_text(value, label, MAX_TARGET_FIELD_BYTES, false)?;
            reject_sensitive_text(value, label)?;
        }
    }
    Ok(())
}

fn validate_fresh_timestamp(value: &str, label: &str) -> Result<(), String> {
    validate_small_text(value, label, 128, true)?;
    let observed = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|_| format!("{label} must be RFC 3339"))?
        .with_timezone(&Utc);
    if Utc::now()
        .signed_duration_since(observed)
        .num_seconds()
        .unsigned_abs()
        > 5 * 60
    {
        return Err(format!("{label} is stale or too far in the future"));
    }
    Ok(())
}

fn engine_config(
    app: &tauri::AppHandle<Wry>,
    model: &'static crate::models::catalog::CatalogModel,
) -> EngineConfig {
    EngineConfig {
        command_timeout_secs: u64::from(
            crate::commands::settings::read_u32(app, "agent_command_timeout_secs", 120)
                .clamp(5, 3_600),
        ),
        agent_max_iterations: crate::commands::settings::read_u32(app, "agent_max_iterations", 10)
            .clamp(1, 100),
        agent_temperature: crate::commands::settings::read_f64_opt(app, "temperature")
            .map(|value| value.clamp(0.0, 2.0) as f32),
        effort: crate::commands::settings::read_effort(app, model),
        model_networked: provider_invocation_is_networked(model.provider),
        ..EngineConfig::default()
    }
}

fn provider_invocation_is_networked(provider: crate::models::catalog::ProviderId) -> bool {
    provider != crate::models::catalog::ProviderId::Local
}

fn value_to_inputs(value: &Value) -> Result<BTreeMap<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or("stored runbook inputs must be a JSON object")?;
    Ok(object
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect())
}

fn verify_definition_snapshot(record: &RunRecord) -> Result<RunbookDefinition, String> {
    verify_snapshot_bytes(
        &record.id,
        &record.source_yaml,
        &record.canonical_json,
        &record.source_sha256,
        &record.canonical_sha256,
    )
}

fn verify_snapshot_bytes(
    run_id: &str,
    source_yaml: &str,
    canonical_json: &str,
    source_sha256: &str,
    canonical_sha256: &str,
) -> Result<RunbookDefinition, String> {
    if sha256_hex(source_yaml.as_bytes()) != source_sha256 {
        return Err(format!(
            "stored source YAML for run {} failed its SHA-256 check",
            run_id
        ));
    }
    if sha256_hex(canonical_json.as_bytes()) != canonical_sha256 {
        return Err(format!(
            "stored canonical definition for run {} failed its SHA-256 check",
            run_id
        ));
    }
    let definition: RunbookDefinition = serde_json::from_str(canonical_json)
        .map_err(|error| format!("stored runbook definition is invalid: {error}"))?;
    definition.validate().map_err(format_validation_errors)?;
    let canonical = crate::runbooks::package::canonical_json(&definition)
        .map_err(|error| format!("canonicalize stored runbook definition: {error}"))?;
    if canonical != canonical_json {
        return Err(format!(
            "stored canonical definition for run {} is not canonical JSON",
            run_id
        ));
    }
    // The raw YAML and canonical JSON are independent immutable witnesses. A
    // digest-consistent replacement of either one must still describe exactly
    // the same typed definition.
    let parsed_source = crate::runbooks::definition::parse_and_validate(source_yaml)
        .map_err(|error| format!("stored source YAML is invalid: {error}"))?;
    let source_canonical = crate::runbooks::package::canonical_json(&parsed_source)
        .map_err(|error| format!("canonicalize stored source YAML: {error}"))?;
    if source_canonical != canonical_json {
        return Err(format!(
            "stored source YAML and canonical definition for run {} disagree",
            run_id
        ));
    }
    Ok(definition)
}

fn reject_sensitive_value(value: &Value, label: &str) -> Result<(), String> {
    let serialized = serde_json::to_string(value).map_err(|error| error.to_string())?;
    reject_sensitive_text(&serialized, label)
}

fn reject_sensitive_text(value: &str, label: &str) -> Result<(), String> {
    let (_, changed) = redact_sensitive(value);
    if changed {
        Err(format!(
            "{label} appears to contain sensitive material; v1 accepts no embedded secrets"
        ))
    } else {
        Ok(())
    }
}

fn sanitize_operator_text(value: &str, label: &str, required: bool) -> Result<String, String> {
    validate_small_text(value, label, MAX_OPERATOR_TEXT_BYTES, required)?;
    let (value, _) = redact_sensitive(value);
    if required && value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    Ok(value)
}

fn sanitize_bounded(value: &str, max_bytes: usize) -> Result<String, String> {
    validate_small_text(value, "terminal error", max_bytes, false)?;
    Ok(redact_sensitive(value).0)
}

fn validate_small_text(
    value: &str,
    label: &str,
    max_bytes: usize,
    required: bool,
) -> Result<(), String> {
    if required && value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > max_bytes {
        return Err(format!("{label} exceeds the {max_bytes} byte limit"));
    }
    if value.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(format!("{label} contains unsupported control characters"));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    validate_small_text(value, label, MAX_ID_BYTES, true)?;
    if value
        .bytes()
        .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')))
    {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn validate_path_argument(value: &str, label: &str) -> Result<(), String> {
    validate_small_text(value, label, MAX_TARGET_FIELD_BYTES, true)?;
    reject_sensitive_text(value, label)
}

fn validate_terminal_capture(result: &RunbookTerminalResult) -> Result<(), String> {
    if result.output_tail.len() > FULL_EVIDENCE_BYTES {
        return Err(format!(
            "terminal result exceeds the {} byte IPC limit",
            FULL_EVIDENCE_BYTES
        ));
    }
    let captured_bytes = result.output_tail.len() as u64;
    if result.output_captured_bytes != captured_bytes {
        return Err(format!(
            "terminal result captured byte count does not match its UTF-8 output (reported {}, received {captured_bytes})",
            result.output_captured_bytes
        ));
    }
    if result.output_observed_bytes < result.output_captured_bytes {
        return Err("terminal result observed byte count is smaller than captured output".into());
    }
    if !result.output_truncated && result.output_observed_bytes != result.output_captured_bytes {
        return Err(
            "terminal result reports uncaptured output without marking the capture truncated"
                .into(),
        );
    }
    Ok(())
}

fn format_validation_errors(errors: Vec<crate::runbooks::definition::ValidationError>) -> String {
    errors
        .into_iter()
        .map(|error| format!("{}: {}", error.path, error.message))
        .collect::<Vec<_>>()
        .join("; ")
}

fn bounded_error(error: &str) -> String {
    let sanitized = redact_sensitive(error).0;
    if sanitized.len() <= MAX_TERMINAL_ERROR_BYTES {
        return sanitized;
    }
    let mut end = MAX_TERMINAL_ERROR_BYTES;
    while !sanitized.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &sanitized[..end])
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackageManifestEntry {
    relative_path: PathBuf,
    directory: bool,
    bytes: u64,
    sha256: String,
}

fn export_runbook_package(
    source: &SourceRegistration,
    package: &ValidatedPackage,
    destination: &Path,
) -> Result<RunbookExportResult, String> {
    let definition_id = safe_package_component(&package.definition.metadata.id);
    let definition_version = safe_package_component(&package.definition.metadata.version);
    let bundle_name = format!("runbook-{definition_id}-v{definition_version}");
    validate_export_component(&bundle_name, "runbook export directory")?;

    #[cfg(target_vendor = "apple")]
    {
        export_runbook_package_pinned(source, package, destination, &bundle_name)
    }
    #[cfg(not(target_vendor = "apple"))]
    export_runbook_package_path(source, package, destination, &bundle_name)
}

#[cfg(target_vendor = "apple")]
fn export_runbook_package_pinned(
    source: &SourceRegistration,
    package: &ValidatedPackage,
    destination: &Path,
    bundle_name: &str,
) -> Result<RunbookExportResult, String> {
    let manifest = package_manifest(&package.root, None)?;
    let mut export = PinnedPackageExport::new(destination, bundle_name)?;
    export.copy_manifest(&package.root, &manifest)?;

    // Re-open the registered source after every byte has been copied. The
    // source definition must still match its durable digests and the complete
    // README/Ansible tree must still match the first pass. The destination is
    // already byte-for-byte checked while streaming into pinned file handles.
    let reloaded = load_and_check_package(&package.root)?;
    require_registered_snapshot(source, &reloaded)?;
    let current = package_manifest(&reloaded.root, None)?;
    if current != manifest {
        return Err(
            "runbook package changed while it was being exported; refresh and try again".into(),
        );
    }
    export.sync()?;
    let output_dir = export.publish(bundle_name, &manifest)?;
    Ok(RunbookExportResult {
        destination: output_dir.to_string_lossy().into_owned(),
        files: exported_file_paths(&output_dir, manifest),
    })
}

#[cfg(not(target_vendor = "apple"))]
fn export_runbook_package_path(
    source: &SourceRegistration,
    package: &ValidatedPackage,
    destination: &Path,
    bundle_name: &str,
) -> Result<RunbookExportResult, String> {
    let destination = canonical_export_directory(destination)?;
    let output_dir = destination.join(bundle_name);
    match fs::symlink_metadata(&output_dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(format!(
                "runbook export destination {} already exists",
                output_dir.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "inspect runbook export destination {}: {error}",
                output_dir.display()
            ));
        }
    }

    let staging = destination.join(format!(".{bundle_name}.staging-{}", uuid::Uuid::new_v4()));
    create_managed_directory(
        &destination,
        staging
            .file_name()
            .ok_or("runbook export staging directory has no filename")?,
        "runbook export staging directory",
    )?;
    if let Err(error) = restrict_builtin_directory(&staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let prepared = (|| -> Result<Vec<PackageManifestEntry>, String> {
        let copied = package_manifest(&package.root, Some(&staging))?;

        // Re-open both the registered definition and the complete package tree
        // after copying. Definition drift is checked against the durable DB
        // digests; README/Ansible drift is checked against the first manifest.
        let reloaded = load_and_check_package(&package.root)?;
        require_registered_snapshot(source, &reloaded)?;
        let current = package_manifest(&reloaded.root, None)?;
        if current != copied {
            return Err(
                "runbook package changed while it was being exported; refresh and try again".into(),
            );
        }

        let staged = load_and_check_package(&staging)?;
        if staged.snapshot != reloaded.snapshot
            || staged.definition.metadata.id != reloaded.definition.metadata.id
            || staged.definition.metadata.version != reloaded.definition.metadata.version
        {
            return Err("staged runbook export does not match its validated source".into());
        }
        let staged_manifest = package_manifest(&staged.root, None)?;
        if staged_manifest != copied {
            return Err("staged runbook export failed its package integrity check".into());
        }
        for entry in copied.iter().filter(|entry| entry.directory).rev() {
            sync_directory(&staging.join(&entry.relative_path))?;
        }
        sync_directory(&staging)?;
        Ok(copied)
    })();

    let manifest = match prepared {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = publish_export_directory(&staging, &output_dir) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    sync_directory(&destination)?;

    Ok(RunbookExportResult {
        destination: output_dir.to_string_lossy().into_owned(),
        files: exported_file_paths(&output_dir, manifest),
    })
}

fn exported_file_paths(output_dir: &Path, manifest: Vec<PackageManifestEntry>) -> Vec<String> {
    manifest
        .into_iter()
        .filter(|entry| !entry.directory)
        .map(|entry| {
            output_dir
                .join(entry.relative_path)
                .to_string_lossy()
                .into_owned()
        })
        .collect()
}

#[cfg(all(not(target_vendor = "apple"), target_os = "windows"))]
fn canonical_export_directory(destination: &Path) -> Result<PathBuf, String> {
    crate::windows_fs::validate_local_ntfs_path(destination)
}

#[cfg(all(not(target_vendor = "apple"), not(target_os = "windows")))]
fn canonical_export_directory(destination: &Path) -> Result<PathBuf, String> {
    if destination
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("export destination must not contain parent traversal".into());
    }
    let absolute = if destination.is_absolute() {
        destination.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("resolve current directory for export: {error}"))?
            .join(destination)
    };
    let mut ancestors = absolute.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| {
            format!(
                "inspect export destination component {}: {error}",
                ancestor.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "export destination component {} is not an ordinary directory",
                ancestor.display()
            ));
        }
    }
    fs::canonicalize(&absolute)
        .map_err(|error| format!("resolve export destination {}: {error}", absolute.display()))
}

fn package_manifest(
    package_root: &Path,
    copy_to: Option<&Path>,
) -> Result<Vec<PackageManifestEntry>, String> {
    #[cfg(target_os = "windows")]
    let package_root = crate::windows_fs::validate_local_ntfs_path(package_root)?;
    #[cfg(not(target_os = "windows"))]
    let package_root = fs::canonicalize(package_root)
        .map_err(|error| format!("resolve runbook package for export: {error}"))?;
    let entries = collect_package_entries(&package_root)?;
    let mut manifest = Vec::with_capacity(entries.len());
    for (relative_path, directory) in entries {
        let source_path = package_root.join(&relative_path);
        if directory {
            if let Some(output_root) = copy_to {
                let output = output_root.join(&relative_path);
                create_managed_directory(
                    output
                        .parent()
                        .ok_or("exported package directory has no parent")?,
                    output
                        .file_name()
                        .ok_or("exported package directory has no filename")?,
                    "exported package directory",
                )?;
                restrict_builtin_directory(&output)?;
            }
            manifest.push(PackageManifestEntry {
                relative_path,
                directory: true,
                bytes: 0,
                sha256: String::new(),
            });
            continue;
        }
        let output = copy_to.map(|root| root.join(&relative_path));
        let (bytes, sha256) = read_package_file(&package_root, &source_path, output.as_deref())?;
        manifest.push(PackageManifestEntry {
            relative_path,
            directory: false,
            bytes,
            sha256,
        });
    }
    Ok(manifest)
}

fn collect_package_entries(package_root: &Path) -> Result<Vec<(PathBuf, bool)>, String> {
    let root_metadata = fs::symlink_metadata(package_root)
        .map_err(|error| format!("inspect runbook package root: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("runbook package root is not an ordinary directory".into());
    }
    let mut stack = vec![package_root.to_path_buf()];
    let mut entries = Vec::new();
    let mut folded_paths = std::collections::HashSet::new();
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("read runbook package directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read runbook package entry: {error}"))?;
            if entries.len() >= MAX_PACKAGE_ENTRIES {
                return Err(format!(
                    "runbook package contains more than {MAX_PACKAGE_ENTRIES} entries"
                ));
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("inspect runbook package entry: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "symlinks are not allowed in runbook packages: {}",
                    path.display()
                ));
            }
            #[cfg(target_os = "windows")]
            if crate::windows_fs::is_reparse(&metadata) {
                return Err(format!(
                    "reparse points are not allowed in runbook packages: {}",
                    path.display()
                ));
            }
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(format!(
                    "unsupported special file in runbook package: {}",
                    path.display()
                ));
            }
            #[cfg(target_os = "windows")]
            let resolved = crate::windows_fs::validate_local_ntfs_path(&path)?;
            #[cfg(not(target_os = "windows"))]
            let resolved = fs::canonicalize(&path)
                .map_err(|error| format!("resolve runbook package entry: {error}"))?;
            if !resolved.starts_with(package_root) {
                return Err(format!(
                    "runbook package entry escapes its root: {}",
                    resolved.display()
                ));
            }
            let relative = path
                .strip_prefix(package_root)
                .map_err(|_| "runbook package entry escapes its root")?
                .to_path_buf();
            for component in relative.components() {
                let Component::Normal(component) = component else {
                    return Err("runbook package contains an unsafe path component".into());
                };
                let component = component
                    .to_str()
                    .ok_or("runbook package paths must be UTF-8")?;
                validate_export_component(component, "runbook package path component")?;
            }
            let folded = relative.to_string_lossy().to_ascii_lowercase();
            if !folded_paths.insert(folded) {
                return Err("runbook package paths collide after portable normalization".into());
            }
            let is_directory = metadata.is_dir();
            if is_directory {
                stack.push(path);
            }
            entries.push((relative, is_directory));
        }
    }
    entries.sort_by(|(left_path, _), (right_path, _)| {
        left_path
            .components()
            .count()
            .cmp(&right_path.components().count())
            .then_with(|| left_path.cmp(right_path))
    });
    Ok(entries)
}

fn read_package_file(
    package_root: &Path,
    source: &Path,
    destination: Option<&Path>,
) -> Result<(u64, String), String> {
    #[cfg(target_os = "windows")]
    let (output_path, output_identity, mut output) = if let Some(destination) = destination {
        let (path, identity, file) = crate::windows_fs::create_secure_file(
            destination
                .parent()
                .ok_or("exported package file has no parent")?,
            destination
                .file_name()
                .ok_or("exported package file has no filename")?,
        )?;
        (Some(path), Some(identity), Some(file))
    } else {
        (None, None, None)
    };
    #[cfg(not(target_os = "windows"))]
    let mut output = if let Some(destination) = destination {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        Some(options.open(destination).map_err(|error| {
            format!(
                "create exported package file {}: {error}",
                destination.display()
            )
        })?)
    } else {
        None
    };
    let result = read_package_file_to_handle(package_root, source, output.as_mut())?;
    #[cfg(target_os = "windows")]
    if let (Some(path), Some(identity)) = (output_path, output_identity) {
        crate::windows_fs::verify_identity(&path, identity, false)?;
    }
    Ok(result)
}

fn read_package_file_to_handle(
    package_root: &Path,
    source: &Path,
    mut output: Option<&mut std::fs::File>,
) -> Result<(u64, String), String> {
    let named_metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("inspect runbook package file {}: {error}", source.display()))?;
    if named_metadata.file_type().is_symlink() || !named_metadata.is_file() {
        return Err(format!(
            "runbook package file {} is not an ordinary file",
            source.display()
        ));
    }
    #[cfg(target_os = "windows")]
    if crate::windows_fs::is_reparse(&named_metadata) {
        return Err(format!(
            "runbook package file {} is a reparse point",
            source.display()
        ));
    }
    #[cfg(target_os = "windows")]
    let resolved = crate::windows_fs::validate_local_ntfs_path(source)?;
    #[cfg(not(target_os = "windows"))]
    let resolved = fs::canonicalize(source)
        .map_err(|error| format!("resolve runbook package file {}: {error}", source.display()))?;
    if !resolved.starts_with(package_root) {
        return Err(format!(
            "runbook package file {} escapes its root",
            source.display()
        ));
    }
    #[cfg(target_os = "windows")]
    let mut input = crate::windows_fs::open_no_reparse(source, false)?;
    #[cfg(target_os = "windows")]
    let input_identity = crate::windows_fs::identity(&input)?;
    #[cfg(not(target_os = "windows"))]
    let mut input = {
        let mut source_options = OpenOptions::new();
        source_options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            source_options.custom_flags(libc::O_NOFOLLOW);
        }
        source_options
            .open(source)
            .map_err(|error| format!("open runbook package file {}: {error}", source.display()))?
    };
    let opened_metadata = input
        .metadata()
        .map_err(|error| format!("inspect opened runbook package file: {error}"))?;
    if !opened_metadata.is_file() {
        return Err(format!(
            "runbook package file {} is not an ordinary file",
            source.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if named_metadata.dev() != opened_metadata.dev()
            || named_metadata.ino() != opened_metadata.ino()
        {
            return Err(format!(
                "runbook package file {} changed while it was opened",
                source.display()
            ));
        }
    }

    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("read runbook package file {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or("runbook package file is too large")?;
        hasher.update(&buffer[..read]);
        if let Some(output) = output.as_deref_mut() {
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("write exported runbook package file: {error}"))?;
        }
    }
    if total != opened_metadata.len() {
        return Err(format!(
            "runbook package file {} changed while it was read",
            source.display()
        ));
    }
    #[cfg(target_os = "windows")]
    crate::windows_fs::verify_identity(source, input_identity, false)?;
    if let Some(output) = output {
        output
            .sync_all()
            .map_err(|error| format!("sync exported runbook package file: {error}"))?;
    }
    let digest = hasher.finalize();
    let mut sha256 = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(sha256, "{byte:02x}");
    }
    Ok((total, sha256))
}

#[cfg(target_vendor = "apple")]
struct CreatedExportEntry {
    relative_path: PathBuf,
    parent: PathBuf,
    name: std::ffi::CString,
    device: u64,
    inode: u64,
    directory: bool,
}

/// A package export writes only relative to retained directory handles. Even if
/// another process renames the selected folder or replaces its pathname, writes,
/// cleanup and final publication remain bound to the directory the user chose.
#[cfg(target_vendor = "apple")]
struct PinnedPackageExport {
    destination: std::fs::File,
    display_destination: PathBuf,
    staging_name: std::ffi::CString,
    staging: std::fs::File,
    directories: BTreeMap<PathBuf, std::fs::File>,
    files: BTreeMap<PathBuf, std::fs::File>,
    created: Vec<CreatedExportEntry>,
    published: bool,
}

#[cfg(target_vendor = "apple")]
impl PinnedPackageExport {
    fn new(destination: &Path, bundle_name: &str) -> Result<Self, String> {
        use std::os::unix::fs::MetadataExt;

        let destination_handle = open_pinned_export_directory(destination)?;
        let opened = destination_handle
            .metadata()
            .map_err(|error| format!("inspect pinned export destination: {error}"))?;
        let display_destination = fs::canonicalize(destination)
            .map_err(|error| format!("resolve export destination: {error}"))?;
        let named = fs::symlink_metadata(&display_destination)
            .map_err(|error| format!("inspect resolved export destination: {error}"))?;
        if named.file_type().is_symlink()
            || !named.is_dir()
            || named.dev() != opened.dev()
            || named.ino() != opened.ino()
        {
            return Err("export destination changed while it was being pinned".into());
        }

        let bundle_name = export_entry_name(bundle_name)?;
        Self::require_absent(
            &destination_handle,
            &bundle_name,
            "runbook export destination",
        )?;
        let staging_name = export_entry_name(&format!(
            ".{}.staging-{}",
            bundle_name.to_string_lossy(),
            uuid::Uuid::new_v4()
        ))?;
        let staging = create_pinned_export_directory_at(&destination_handle, &staging_name)?;
        Ok(Self {
            destination: destination_handle,
            display_destination,
            staging_name,
            staging,
            directories: BTreeMap::new(),
            files: BTreeMap::new(),
            created: Vec::new(),
            published: false,
        })
    }

    fn require_absent(
        directory: &std::fs::File,
        name: &std::ffi::CStr,
        label: &str,
    ) -> Result<(), String> {
        use std::os::fd::AsRawFd;

        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let result = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            return Err(format!("{label} {} already exists", name.to_string_lossy()));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(())
        } else {
            Err(format!("inspect {label}: {error}"))
        }
    }

    fn parent(&self, relative: &Path) -> Result<&std::fs::File, String> {
        if relative.as_os_str().is_empty() {
            Ok(&self.staging)
        } else {
            self.directories.get(relative).ok_or_else(|| {
                format!(
                    "export package parent {} was not created",
                    relative.display()
                )
            })
        }
    }

    fn relative_parts(relative: &Path) -> Result<(PathBuf, std::ffi::CString), String> {
        let parent = relative
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .to_path_buf();
        let name = relative
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("export package entry must have a UTF-8 filename")?;
        Ok((parent, export_entry_name(name)?))
    }

    fn create_directory(&mut self, relative: &Path) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;

        let (parent_path, name) = Self::relative_parts(relative)?;
        let directory = {
            let parent = self.parent(&parent_path)?;
            create_pinned_export_directory_at(parent, &name)?
        };
        let metadata = directory
            .metadata()
            .map_err(|error| format!("inspect created export directory: {error}"))?;
        self.created.push(CreatedExportEntry {
            relative_path: relative.to_path_buf(),
            parent: parent_path,
            name,
            device: metadata.dev(),
            inode: metadata.ino(),
            directory: true,
        });
        self.directories.insert(relative.to_path_buf(), directory);
        Ok(())
    }

    fn create_file(&mut self, relative: &Path) -> Result<&mut std::fs::File, String> {
        use std::os::unix::fs::MetadataExt;

        let (parent_path, name) = Self::relative_parts(relative)?;
        let file = {
            let parent = self.parent(&parent_path)?;
            create_pinned_export_file_at(parent, &name)?
        };
        let metadata = file
            .metadata()
            .map_err(|error| format!("inspect created export file: {error}"))?;
        self.created.push(CreatedExportEntry {
            relative_path: relative.to_path_buf(),
            parent: parent_path,
            name,
            device: metadata.dev(),
            inode: metadata.ino(),
            directory: false,
        });
        self.files.insert(relative.to_path_buf(), file);
        self.files
            .get_mut(relative)
            .ok_or_else(|| "created export file handle was not retained".into())
    }

    fn copy_manifest(
        &mut self,
        package_root: &Path,
        manifest: &[PackageManifestEntry],
    ) -> Result<(), String> {
        let package_root = fs::canonicalize(package_root)
            .map_err(|error| format!("resolve runbook package for export: {error}"))?;
        for entry in manifest {
            if entry.directory {
                self.create_directory(&entry.relative_path)?;
                continue;
            }
            let output = self.create_file(&entry.relative_path)?;
            let (bytes, sha256) = read_package_file_to_handle(
                &package_root,
                &package_root.join(&entry.relative_path),
                Some(output),
            )?;
            if bytes != entry.bytes || sha256 != entry.sha256 {
                return Err(format!(
                    "runbook package file {} changed while it was copied",
                    entry.relative_path.display()
                ));
            }
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), String> {
        for directory in self.directories.values() {
            directory
                .sync_all()
                .map_err(|error| format!("sync exported package directory: {error}"))?;
        }
        self.staging
            .sync_all()
            .map_err(|error| format!("sync exported package root: {error}"))
    }

    fn directory_entry_names(
        directory: &std::fs::File,
    ) -> Result<std::collections::BTreeSet<Vec<u8>>, String> {
        use std::os::fd::AsRawFd;

        let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
        if duplicate < 0 {
            return Err(format!(
                "duplicate exported package directory handle: {}",
                std::io::Error::last_os_error()
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::close(duplicate);
            }
            return Err(format!("open exported package directory stream: {error}"));
        }

        let mut names = std::collections::BTreeSet::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if !matches!(name, b"." | b"..") {
                names.insert(name.to_vec());
            }
        }
        if unsafe { libc::closedir(stream) } != 0 {
            return Err(format!(
                "close exported package directory stream: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(names)
    }

    fn verify_integrity(&mut self, manifest: &[PackageManifestEntry]) -> Result<(), String> {
        use std::io::SeekFrom;
        use std::os::unix::fs::MetadataExt;

        if self.created.len() != manifest.len() {
            return Err("staged runbook export has an unexpected number of entries".into());
        }

        let mut expected_entries = manifest
            .iter()
            .map(|entry| (entry.relative_path.clone(), entry.directory))
            .collect::<BTreeMap<_, _>>();
        let mut expected_children = BTreeMap::<PathBuf, std::collections::BTreeSet<Vec<u8>>>::new();
        expected_children.entry(PathBuf::new()).or_default();
        for entry in &self.created {
            if expected_entries.remove(&entry.relative_path) != Some(entry.directory) {
                return Err(format!(
                    "staged runbook export contains unexpected entry {}",
                    entry.relative_path.display()
                ));
            }
            let parent = self.parent(&entry.parent)?;
            if !Self::named_entry_is_owned(parent, &entry.name, entry.device, entry.inode) {
                return Err(format!(
                    "staged runbook export entry {} was replaced before publication",
                    entry.relative_path.display()
                ));
            }
            let handle_metadata = if entry.directory {
                self.directories
                    .get(&entry.relative_path)
                    .ok_or_else(|| {
                        format!(
                            "staged runbook export directory {} is not pinned",
                            entry.relative_path.display()
                        )
                    })?
                    .metadata()
            } else {
                self.files
                    .get(&entry.relative_path)
                    .ok_or_else(|| {
                        format!(
                            "staged runbook export file {} is not pinned",
                            entry.relative_path.display()
                        )
                    })?
                    .metadata()
            }
            .map_err(|error| {
                format!(
                    "inspect pinned runbook export entry {}: {error}",
                    entry.relative_path.display()
                )
            })?;
            if handle_metadata.dev() != entry.device || handle_metadata.ino() != entry.inode {
                return Err(format!(
                    "pinned runbook export entry {} changed identity",
                    entry.relative_path.display()
                ));
            }
            expected_children
                .entry(entry.parent.clone())
                .or_default()
                .insert(entry.name.to_bytes().to_vec());
            if entry.directory {
                expected_children
                    .entry(entry.relative_path.clone())
                    .or_default();
            }
        }
        if !expected_entries.is_empty() {
            return Err("staged runbook export is missing manifest entries".into());
        }

        let root_names = Self::directory_entry_names(&self.staging)?;
        if root_names
            != expected_children
                .remove(&PathBuf::new())
                .unwrap_or_default()
        {
            return Err("staged runbook export root contains unexpected entries".into());
        }
        for (relative, directory) in &self.directories {
            let actual = Self::directory_entry_names(directory)?;
            let expected = expected_children.remove(relative).unwrap_or_default();
            if actual != expected {
                return Err(format!(
                    "staged runbook export directory {} contains unexpected entries",
                    relative.display()
                ));
            }
        }
        if !expected_children.is_empty() {
            return Err("staged runbook export directory manifest is incomplete".into());
        }

        // This is deliberately the final validation before rename. Keep the
        // read/write handles alive so a pathname swap cannot redirect hashing.
        for entry in manifest.iter().filter(|entry| !entry.directory) {
            let file = self.files.get_mut(&entry.relative_path).ok_or_else(|| {
                format!(
                    "staged runbook export file {} is not pinned",
                    entry.relative_path.display()
                )
            })?;
            file.seek(SeekFrom::Start(0)).map_err(|error| {
                format!(
                    "rewind staged runbook export file {}: {error}",
                    entry.relative_path.display()
                )
            })?;
            let mut hasher = Sha256::new();
            let mut total = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(|error| {
                    format!(
                        "read staged runbook export file {}: {error}",
                        entry.relative_path.display()
                    )
                })?;
                if read == 0 {
                    break;
                }
                total = total
                    .checked_add(read as u64)
                    .ok_or("staged runbook export file is too large")?;
                hasher.update(&buffer[..read]);
            }
            let digest = hasher.finalize();
            let sha256 = digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            if total != entry.bytes || sha256 != entry.sha256 {
                return Err(format!(
                    "staged runbook export file {} failed its final integrity check",
                    entry.relative_path.display()
                ));
            }
        }
        Ok(())
    }

    fn named_entry_is_owned(
        parent: &std::fs::File,
        name: &std::ffi::CStr,
        device: u64,
        inode: u64,
    ) -> bool {
        use std::os::fd::AsRawFd;

        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return false;
        }
        let stat = unsafe { stat.assume_init() };
        stat.st_dev as u64 == device && stat.st_ino == inode
    }

    fn staging_is_owned(&self) -> bool {
        use std::os::unix::fs::MetadataExt;

        self.staging.metadata().is_ok_and(|metadata| {
            Self::named_entry_is_owned(
                &self.destination,
                &self.staging_name,
                metadata.dev(),
                metadata.ino(),
            )
        })
    }

    fn current_destination_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;

        let mut buffer = vec![0i8; libc::PATH_MAX as usize];
        if unsafe {
            libc::fcntl(
                self.destination.as_raw_fd(),
                libc::F_GETPATH,
                buffer.as_mut_ptr(),
            )
        } == 0
        {
            let path = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) };
            PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes()))
        } else {
            self.display_destination.clone()
        }
    }

    fn publish(
        &mut self,
        bundle_name: &str,
        manifest: &[PackageManifestEntry],
    ) -> Result<PathBuf, String> {
        use std::os::fd::AsRawFd;

        if !self.staging_is_owned() {
            return Err("runbook export staging directory changed before publication".into());
        }
        let bundle_name = export_entry_name(bundle_name)?;
        Self::require_absent(
            &self.destination,
            &bundle_name,
            "runbook export destination",
        )?;
        self.verify_integrity(manifest)?;
        let result = unsafe {
            libc::renameatx_np(
                self.destination.as_raw_fd(),
                self.staging_name.as_ptr(),
                self.destination.as_raw_fd(),
                bundle_name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result != 0 {
            return Err(format!(
                "publish runbook export without overwriting existing data: {}",
                std::io::Error::last_os_error()
            ));
        }
        self.published = true;
        if let Err(error) = self.destination.sync_all() {
            log::warn!("sync published runbook export directory failed: {error}");
        }
        Ok(self
            .current_destination_path()
            .join(bundle_name.to_string_lossy().as_ref()))
    }
}

#[cfg(target_vendor = "apple")]
impl Drop for PinnedPackageExport {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        if self.published {
            return;
        }
        for entry in self.created.iter().rev() {
            let Ok(parent) = self.parent(&entry.parent) else {
                continue;
            };
            if !Self::named_entry_is_owned(parent, &entry.name, entry.device, entry.inode) {
                continue;
            }
            let flags = if entry.directory {
                libc::AT_REMOVEDIR
            } else {
                0
            };
            if unsafe { libc::unlinkat(parent.as_raw_fd(), entry.name.as_ptr(), flags) } != 0 {
                log::warn!(
                    "could not clean owned runbook export entry {}: {}",
                    entry.name.to_string_lossy(),
                    std::io::Error::last_os_error()
                );
            }
        }
        if self.staging_is_owned()
            && unsafe {
                libc::unlinkat(
                    self.destination.as_raw_fd(),
                    self.staging_name.as_ptr(),
                    libc::AT_REMOVEDIR,
                )
            } != 0
        {
            log::warn!(
                "could not clean owned runbook export staging directory: {}",
                std::io::Error::last_os_error()
            );
        }
    }
}

fn safe_package_component(value: &str) -> String {
    let value = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let value = value.trim_matches(|character: char| !character.is_ascii_alphanumeric());
    if value.is_empty() {
        "runbook".into()
    } else {
        value.chars().take(80).collect()
    }
}

#[cfg(not(target_vendor = "apple"))]
fn publish_export_directory(staging: &Path, destination: &Path) -> Result<(), String> {
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(format!(
                "runbook export destination {} already exists",
                destination.display()
            ));
        }
        Err(error) => return Err(format!("inspect runbook export destination: {error}")),
    }
    #[cfg(target_os = "windows")]
    {
        crate::windows_fs::promote_new_directory(staging, destination)
            .map_err(|error| format!("atomically publish runbook export: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(staging, destination)
            .map_err(|error| format!("atomically publish runbook export: {error}"))
    }
}

fn export_report_bundle(
    app_data_dir: &Path,
    report: &RunbookReport,
    destination: &Path,
) -> Result<RunbookExportResult, String> {
    #[cfg(unix)]
    let destination = destination.to_path_buf();
    #[cfg(target_os = "windows")]
    let destination = crate::windows_fs::validate_local_ntfs_path(destination)?;
    #[cfg(not(any(unix, target_os = "windows")))]
    let destination = {
        let metadata = fs::symlink_metadata(destination)
            .map_err(|error| format!("inspect export destination: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("export destination must be an existing non-symlink directory".into());
        }
        fs::canonicalize(destination)
            .map_err(|error| format!("resolve export destination: {error}"))?
    };
    let canonical_json = report.canonical_json()?;
    let markdown = report.markdown()?;

    // Read and verify every *complete* artifact before creating output. Pending
    // and missing evidence remains explicit in report.json/report.md but has no
    // file in the bundle, so export never upgrades unavailable bytes into a
    // capture claim. A changed or escaping complete artifact fails closed.
    let canonical_app_data = fs::canonicalize(app_data_dir)
        .map_err(|error| format!("resolve app data directory: {error}"))?;
    let mut evidence_files = Vec::<(String, Vec<u8>)>::new();
    let mut export_names = std::collections::HashSet::new();
    for evidence in report.checklist.iter().flat_map(|step| &step.evidence) {
        if evidence.availability != EvidenceAvailability::Complete {
            continue;
        }
        let Some(relative) = evidence.relative_path.as_deref() else {
            continue;
        };
        validate_export_component(&report.run_id, "report run id")?;
        validate_export_component(&evidence.id, "evidence id")?;
        validate_export_component(&evidence.attempt_id, "evidence attempt id")?;
        let expected = PathBuf::from("runbooks")
            .join(&report.run_id)
            .join(format!("{}.log", evidence.attempt_id));
        let relative_path = Path::new(relative);
        if relative_path != expected {
            return Err(format!(
                "evidence {} path does not match its run and attempt",
                evidence.id
            ));
        }
        let source = canonical_app_data.join(relative_path);
        let source_metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("inspect evidence {}: {error}", evidence.id))?;
        if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
            return Err(format!("evidence {} is not a regular file", evidence.id));
        }
        let source = fs::canonicalize(&source)
            .map_err(|error| format!("resolve evidence {}: {error}", evidence.id))?;
        if !source.starts_with(&canonical_app_data) {
            return Err(format!(
                "evidence {} escapes protected app data",
                evidence.id
            ));
        }
        #[cfg(target_os = "windows")]
        let file = crate::windows_fs::open_no_reparse(&source, false)
            .map_err(|error| format!("open evidence {}: {error}", evidence.id))?;
        #[cfg(not(target_os = "windows"))]
        let file = {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            options.open(&source).map_err(|error| {
                format!("open evidence {} without symlinks: {error}", evidence.id)
            })?
        };
        let opened_metadata = file
            .metadata()
            .map_err(|error| format!("inspect opened evidence {}: {error}", evidence.id))?;
        if !opened_metadata.is_file() {
            return Err(format!("evidence {} is not an ordinary file", evidence.id));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if opened_metadata.dev() != source_metadata.dev()
                || opened_metadata.ino() != source_metadata.ino()
            {
                return Err(format!(
                    "evidence {} changed while the export was being prepared",
                    evidence.id
                ));
            }
        }
        let max_read = evidence
            .bytes
            .checked_add(1)
            .ok_or_else(|| format!("evidence {} byte count is too large", evidence.id))?;
        let mut bytes = Vec::with_capacity(evidence.bytes.min(FULL_EVIDENCE_BYTES as u64) as usize);
        file.take(max_read)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read evidence {}: {error}", evidence.id))?;
        if bytes.len() as u64 != evidence.bytes || sha256_hex(&bytes) != evidence.sha256 {
            return Err(format!(
                "evidence {} failed its size or SHA-256 check",
                evidence.id
            ));
        }
        let name = evidence_export_name(&evidence.id);
        if !export_names.insert(name.to_ascii_lowercase()) {
            return Err("evidence export filenames collide after sanitization".into());
        }
        evidence_files.push((name, bytes));
    }

    let suffix = report.run_id.chars().take(8).collect::<String>();
    let definition_id = safe_file_component(&report.definition.id);
    let bundle_name = format!("runbook-{definition_id}-{suffix}");
    let (output_dir, written) = write_export_bundle(
        &destination,
        &bundle_name,
        canonical_json.as_bytes(),
        markdown.as_bytes(),
        evidence_files,
    )?;
    Ok(RunbookExportResult {
        destination: output_dir.to_string_lossy().into_owned(),
        files: written,
    })
}

fn safe_file_component(value: &str) -> String {
    let value = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let value = value.trim_matches('-');
    if value.is_empty() {
        "runbook".into()
    } else {
        value.chars().take(80).collect()
    }
}

fn validate_export_component(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(format!("{label} is not a safe path component"))
    }
}

fn evidence_export_name(id: &str) -> String {
    // Prefixing and using only the conservative portable set avoids device
    // names on Windows and makes the output an ordinary basename everywhere.
    let component = safe_file_component(id);
    format!("evidence-{component}.txt")
}

#[cfg(unix)]
fn export_entry_name(value: &str) -> Result<std::ffi::CString, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.as_bytes().contains(&b'/')
        || value.as_bytes().contains(&0)
    {
        return Err("export filename is not a safe directory entry".into());
    }
    std::ffi::CString::new(value).map_err(|_| "export filename contains NUL".into())
}

#[cfg(unix)]
fn open_pinned_export_directory(path: &Path) -> Result<std::fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("export destination must not contain parent traversal".into());
    }

    let start = if path.is_absolute() { "/" } else { "." };
    let start = std::ffi::CString::new(start).expect("static path contains no NUL");
    let fd = unsafe {
        libc::open(
            start.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open export path root: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut directory = unsafe { std::fs::File::from_raw_fd(fd) };
    for component in path.components() {
        let component = match component {
            Component::RootDir | Component::CurDir => continue,
            Component::Normal(value) => value,
            Component::ParentDir | Component::Prefix(_) => {
                return Err("export destination must not contain parent traversal".into());
            }
        };
        let component = std::ffi::CString::new(component.as_bytes())
            .map_err(|_| "export destination contains NUL".to_string())?;
        let next = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if next < 0 {
            return Err(format!(
                "open pinned export destination component: {}",
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { std::fs::File::from_raw_fd(next) };
    }
    Ok(directory)
}

#[cfg(unix)]
fn create_pinned_export_directory_at(
    parent: &std::fs::File,
    entry: &std::ffi::CStr,
) -> Result<std::fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let created = unsafe { libc::mkdirat(parent.as_raw_fd(), entry.as_ptr(), 0o700) };
    if created != 0 {
        return Err(format!(
            "create export directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut named_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let stated = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            entry.as_ptr(),
            named_stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if stated != 0 {
        return Err(format!(
            "inspect newly created export directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let named_stat = unsafe { named_stat.assume_init() };
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            entry.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open pinned export directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let directory = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut opened_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(directory.as_raw_fd(), opened_stat.as_mut_ptr()) } != 0 {
        return Err(format!(
            "inspect opened export directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let opened_stat = unsafe { opened_stat.assume_init() };
    if named_stat.st_dev != opened_stat.st_dev || named_stat.st_ino != opened_stat.st_ino {
        return Err("new export directory was replaced before it could be pinned".into());
    }
    if opened_stat.st_uid != unsafe { libc::geteuid() }
        || opened_stat.st_mode & libc::S_IFMT != libc::S_IFDIR
        || opened_stat.st_mode & 0o077 != 0
    {
        return Err("new export directory has unsafe ownership, type, or permissions".into());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync export parent directory: {error}"))?;
    Ok(directory)
}

#[cfg(unix)]
fn create_pinned_export_file_at(
    directory: &std::fs::File,
    entry: &std::ffi::CStr,
) -> Result<std::fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            entry.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(format!(
            "create export file: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn write_pinned_export_file_at(
    directory: &std::fs::File,
    entry: &std::ffi::CStr,
    display: &Path,
    bytes: &[u8],
) -> Result<String, String> {
    let mut file = create_pinned_export_file_at(directory, entry)
        .map_err(|error| format!("{error} ({})", display.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write export file {}: {error}", display.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync export file {}: {error}", display.display()))?;
    Ok(display.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn write_export_bundle(
    destination: &Path,
    bundle_name: &str,
    canonical_json: &[u8],
    markdown: &[u8],
    evidence_files: Vec<(String, Vec<u8>)>,
) -> Result<(PathBuf, Vec<String>), String> {
    let pinned_destination = open_pinned_export_directory(destination)?;
    let bundle_entry = export_entry_name(bundle_name)?;
    let bundle = create_pinned_export_directory_at(&pinned_destination, &bundle_entry)?;
    let output_dir = destination.join(bundle_name);
    let mut written = Vec::new();
    written.push(write_pinned_export_file_at(
        &bundle,
        &export_entry_name("report.json")?,
        &output_dir.join("report.json"),
        canonical_json,
    )?);
    written.push(write_pinned_export_file_at(
        &bundle,
        &export_entry_name("report.md")?,
        &output_dir.join("report.md"),
        markdown,
    )?);
    if !evidence_files.is_empty() {
        let evidence = create_pinned_export_directory_at(&bundle, &export_entry_name("evidence")?)?;
        for (filename, bytes) in evidence_files {
            written.push(write_pinned_export_file_at(
                &evidence,
                &export_entry_name(&filename)?,
                &output_dir.join("evidence").join(filename),
                &bytes,
            )?);
        }
        evidence
            .sync_all()
            .map_err(|error| format!("sync evidence export directory: {error}"))?;
    }
    bundle
        .sync_all()
        .map_err(|error| format!("sync export bundle directory: {error}"))?;
    Ok((output_dir, written))
}

#[cfg(target_os = "windows")]
fn write_export_bundle(
    destination: &Path,
    bundle_name: &str,
    canonical_json: &[u8],
    markdown: &[u8],
    evidence_files: Vec<(String, Vec<u8>)>,
) -> Result<(PathBuf, Vec<String>), String> {
    let output_dir =
        crate::windows_fs::create_secure_directory(destination, std::ffi::OsStr::new(bundle_name))?;
    let mut written = Vec::new();
    written.push(write_new_file(&output_dir, "report.json", canonical_json)?);
    written.push(write_new_file(&output_dir, "report.md", markdown)?);
    if !evidence_files.is_empty() {
        let evidence_dir = crate::windows_fs::create_secure_directory(
            &output_dir,
            std::ffi::OsStr::new("evidence"),
        )?;
        for (name, bytes) in evidence_files {
            written.push(write_new_file(&evidence_dir, &name, &bytes)?);
        }
        crate::windows_fs::sync_directory(&evidence_dir)?;
    }
    crate::windows_fs::sync_directory(&output_dir)?;
    Ok((output_dir, written))
}

#[cfg(target_os = "windows")]
fn write_new_file(parent: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let (path, file_identity, mut file) =
        crate::windows_fs::create_secure_file(parent, std::ffi::OsStr::new(name))?;
    file.write_all(bytes)
        .map_err(|error| format!("write export file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync export file {}: {error}", path.display()))?;
    crate::windows_fs::verify_identity(&path, file_identity, false)?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn write_export_bundle(
    destination: &Path,
    bundle_name: &str,
    canonical_json: &[u8],
    markdown: &[u8],
    evidence_files: Vec<(String, Vec<u8>)>,
) -> Result<(PathBuf, Vec<String>), String> {
    let output_dir = destination.join(bundle_name);
    fs::create_dir(&output_dir).map_err(|error| {
        format!(
            "create export bundle {} (choose an empty destination if it already exists): {error}",
            output_dir.display()
        )
    })?;
    restrict_directory(&output_dir)?;
    let mut written = Vec::new();
    written.push(write_new_file(
        &output_dir.join("report.json"),
        canonical_json,
    )?);
    written.push(write_new_file(&output_dir.join("report.md"), markdown)?);
    if !evidence_files.is_empty() {
        let evidence_dir = output_dir.join("evidence");
        fs::create_dir(&evidence_dir)
            .map_err(|error| format!("create evidence export directory: {error}"))?;
        restrict_directory(&evidence_dir)?;
        for (name, bytes) in evidence_files {
            written.push(write_new_file(&evidence_dir.join(name), &bytes)?);
        }
    }
    Ok((output_dir, written))
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn write_new_file(path: &Path, bytes: &[u8]) -> Result<String, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("create export file {}: {error}", path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("write export file {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync export file {}: {error}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(all(not(unix), not(target_os = "windows")))]
fn restrict_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_drafts_use_the_terminal_platform_guard() {
        assert_eq!(
            default_draft_document_for_platform(false).platform,
            DraftPlatform::Macos13
        );
        assert_eq!(
            default_draft_document_for_platform(true).platform,
            DraftPlatform::Linux
        );
    }

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let temp_directory = fs::canonicalize(std::env::temp_dir()).unwrap();
            let path = temp_directory.join(format!(
                "vterminal-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn runbook_db() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE schema_version(version INTEGER PRIMARY KEY);",
            )
            .unwrap();
        db::migrate_v6(&connection).unwrap();
        db::migrate_v8(&connection).unwrap();
        db::migrate_v9(&connection).unwrap();
        connection
    }

    fn write_export_test_package(root: &Path) -> ValidatedPackage {
        let source = r#"apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: export-roundtrip
  version: 1.0.0
  title: Export round trip
spec:
  target:
    kind: active-terminal
  declaredCapabilities:
    network: false
    privilege: none
    writes: []
  steps:
    - id: inspect
      title: Inspect the target
      check:
        uses: shell
        with:
          command: uname -s
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
"#;
        fs::create_dir_all(root.join("ansible/group_vars")).unwrap();
        fs::write(root.join("runbook.vrun.yaml"), source).unwrap();
        fs::write(root.join("README.md"), b"# Export round trip\n").unwrap();
        fs::write(
            root.join("ansible/site.yml"),
            b"- hosts: all\n  tasks: []\n",
        )
        .unwrap();
        fs::write(
            root.join("ansible/group_vars/all.yml"),
            b"assessment_only: true\n",
        )
        .unwrap();
        load_and_check_package(root).unwrap()
    }

    fn definition_with_steps(steps: &str) -> RunbookDefinition {
        let source = format!(
            r#"apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: provider-boundary
  version: 1.0.0
  title: Provider boundary
spec:
  target:
    kind: active-terminal
  steps:
{steps}
"#
        );
        crate::runbooks::definition::parse_and_validate(&source).unwrap()
    }

    #[test]
    fn identifiers_are_bounded_and_control_free() {
        assert!(validate_identifier("run-123", "id").is_ok());
        assert!(validate_identifier("../../run", "id").is_err());
        assert!(validate_identifier("run\n123", "id").is_err());
    }

    #[test]
    fn model_phase_network_label_matches_provider_boundary() {
        use crate::models::catalog::ProviderId;

        assert!(!provider_invocation_is_networked(ProviderId::Local));
        for provider in [
            ProviderId::Anthropic,
            ProviderId::OpenAi,
            ProviderId::Mistral,
            ProviderId::Remote,
        ] {
            assert!(provider_invocation_is_networked(provider));
        }
    }

    #[test]
    fn model_provider_is_skipped_for_shell_and_manual_only_definitions() {
        let shell = definition_with_steps(
            r#"    - id: shell-check
      title: Shell check
      check:
        uses: shell
        with:
          command: "true"
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
"#,
        );
        let manual = definition_with_steps(
            r#"    - id: manual-check
      title: Manual check
      check:
        uses: manual
        instructions: Inspect the target.
"#,
        );
        let config = EngineConfig::default();

        assert!(!runbook_requires_model_provider(&shell, &config));
        assert!(!runbook_requires_model_provider(&manual, &config));
    }

    #[test]
    fn model_provider_is_required_for_each_agent_action_position() {
        let agent_check = definition_with_steps(
            r#"    - id: agent-check
      title: Agent check
      check:
        uses: agent
        instructions: Assess the target.
"#,
        );
        let agent_apply = definition_with_steps(
            r#"    - id: agent-apply
      title: Agent apply
      check:
        uses: manual
        instructions: Assess the target.
      apply:
        uses: agent
        instructions: Remediate the target.
      verify:
        uses: manual
        instructions: Verify the target.
"#,
        );
        let agent_verify = definition_with_steps(
            r#"    - id: agent-verify
      title: Agent verify
      check:
        uses: manual
        instructions: Assess the target.
      apply:
        uses: manual
        instructions: Remediate the target.
      verify:
        uses: agent
        instructions: Verify the target.
"#,
        );
        let config = EngineConfig::default();

        for definition in [&agent_check, &agent_apply, &agent_verify] {
            assert!(runbook_requires_model_provider(definition, &config));
        }
    }

    #[test]
    fn model_summaries_require_a_provider_without_agent_actions() {
        let manual = definition_with_steps(
            r#"    - id: manual-check
      title: Manual check
      check:
        uses: manual
        instructions: Inspect the target.
"#,
        );
        let config = EngineConfig {
            summarize_with_model: true,
            ..EngineConfig::default()
        };

        assert!(runbook_requires_model_provider(&manual, &config));
    }

    #[test]
    fn sensitive_boundary_values_are_rejected_or_redacted() {
        assert!(reject_sensitive_text("PASSWORD=hunter2", "input").is_err());
        let openai = ["sk", "-", "1234567890abcdefghijklmnop"].concat();
        let github = ["gh", "p_", "1234567890abcdefghijklmnop"].concat();
        let aws = ["AK", "IA", "1234567890ABCDEF"].concat();
        let jwt = [
            "eyJ",
            "hbGciOiJIUzI1NiJ9",
            ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
            ".signature123",
        ]
        .concat();
        let literals = [
            format!("instructions: use {openai}"),
            "command: curl --user operator:password https://example.invalid".into(),
            "url: https://alice:password@example.invalid/path".into(),
            format!("token: {github}"),
            format!("aws: {aws}"),
            format!("jwt: {jwt}"),
        ];
        for literal in &literals {
            assert!(
                reject_sensitive_text(literal, "runbook definition").is_err(),
                "accepted secret-like source: {literal}"
            );
        }
        for value in [
            serde_json::json!({"endpoint":"https://alice:password@example.invalid"}),
            serde_json::json!({"credential":"opaque-value"}),
            serde_json::json!({"value":openai}),
        ] {
            assert!(
                reject_sensitive_value(&value, "runbook inputs").is_err(),
                "accepted secret-like input: {value}"
            );
        }
        let sanitized = sanitize_operator_text("token=abc123", "comment", true).unwrap();
        assert!(!sanitized.contains("abc123"));
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn terminal_capture_metadata_is_utf8_byte_accurate() {
        let output = "🔒é".to_string();
        let captured_bytes = output.len() as u64;
        let mut result = RunbookTerminalResult {
            exit_code: Some(0),
            output_tail: output,
            output_truncated: false,
            output_observed_bytes: captured_bytes,
            output_captured_bytes: captured_bytes,
            duration_ms: 1,
            error: None,
            execution_mode: Some("integrated".into()),
            target_context: None,
        };
        assert!(validate_terminal_capture(&result).is_ok());

        result.output_captured_bytes = result.output_tail.chars().count() as u64;
        assert!(validate_terminal_capture(&result)
            .unwrap_err()
            .contains("UTF-8"));

        result.output_captured_bytes = captured_bytes;
        result.output_observed_bytes = captured_bytes + 10;
        assert!(validate_terminal_capture(&result)
            .unwrap_err()
            .contains("without marking"));
        result.output_truncated = true;
        assert!(validate_terminal_capture(&result).is_ok());
    }

    #[test]
    fn export_component_never_contains_path_syntax() {
        assert_eq!(
            safe_file_component("../../server baseline"),
            "server-baseline"
        );
        assert_eq!(safe_file_component("***"), "runbook");
        assert_eq!(evidence_export_name("CON"), "evidence-CON.txt");
        assert!(!evidence_export_name("a.b").contains('/'));
    }

    #[test]
    fn bundled_runbooks_seed_idempotently_hide_and_restore_in_fixed_order() {
        let app_data = TempRoot::new("builtin-runbooks");
        let connection = runbook_db();

        let first = reconcile_builtin_sources(&app_data.0, &connection).unwrap();
        assert_eq!(
            first
                .iter()
                .map(|source| source.definition_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "macos-security-posture",
                "macos-developer-workstation-health",
                "macos-backup-storage-readiness",
            ]
        );
        for (index, source) in first.iter().enumerate() {
            assert_eq!(source.source_kind, SourceKind::Builtin);
            assert_eq!(source.builtin_order, Some(index as u32));
            assert!(!source.hidden);
            let package = load_and_check_package(Path::new(&source.package_path)).unwrap();
            assert_eq!(package.definition.metadata.id, source.definition_id);
            assert_eq!(package.definition.metadata.version, "1.0.0");
            let expected_steps: &[&str] = match source.definition_id.as_str() {
                "macos-security-posture" => &[
                    "supported-macos-target",
                    "filevault-enabled",
                    "sip-enabled",
                    "gatekeeper-enabled",
                    "application-firewall-enabled",
                    "security-data-updates-enabled",
                ],
                "macos-developer-workstation-health" => &[
                    "supported-macos-target",
                    "free-space-input-in-range",
                    "xcode-command-line-tools-ready",
                    "macos-sdk-ready",
                    "git-ready",
                    "shell-running-natively",
                    "minimum-free-space-available",
                    "homebrew-available-when-required",
                ],
                "macos-backup-storage-readiness" => &[
                    "supported-macos-target",
                    "free-space-input-in-range",
                    "backup-age-input-in-range",
                    "minimum-free-space-available",
                    "time-machine-destination-configured",
                    "latest-backup-recent",
                    "root-volume-uses-apfs",
                    "local-snapshot-present-when-required",
                ],
                unexpected => panic!("unexpected built-in runbook {unexpected}"),
            };
            assert_eq!(
                package
                    .definition
                    .spec
                    .steps
                    .iter()
                    .map(|step| step.id.as_str())
                    .collect::<Vec<_>>(),
                expected_steps
            );
            assert!(!package.definition.uses_unavailable_executor());
            assert!(!package.definition.spec.declared_capabilities.network);
            assert!(package
                .definition
                .spec
                .declared_capabilities
                .writes
                .is_empty());
            assert_eq!(
                package.definition.spec.declared_capabilities.privilege,
                crate::runbooks::definition::Privilege::None
            );
            assert!(package.definition.spec.steps.iter().all(|step| matches!(
                &step.check,
                Some(CheckAction::Shell { .. })
            ) && step.apply.is_none()
                && step.verify.is_none()));
            assert_eq!(
                package.definition.spec.defaults.on_failure,
                crate::runbooks::definition::FailurePolicy::Continue
            );
            assert_eq!(
                package.definition.spec.steps[0].on_failure,
                Some(crate::runbooks::definition::FailurePolicy::Stop)
            );
        }

        let second = reconcile_builtin_sources(&app_data.0, &connection).unwrap();
        assert_eq!(
            second
                .iter()
                .map(|source| (&source.id, &source.created_at, &source.updated_at))
                .collect::<Vec<_>>(),
            first
                .iter()
                .map(|source| (&source.id, &source.created_at, &source.updated_at))
                .collect::<Vec<_>>()
        );

        let hidden_id = first[1].id.clone();
        assert!(db::remove_source(&connection, &hidden_id).unwrap());
        let visible = reconcile_builtin_sources(&app_data.0, &connection).unwrap();
        assert_eq!(visible.len(), 2);
        let hidden = db::get_source(&connection, &hidden_id).unwrap().unwrap();
        assert!(hidden.hidden);
        assert_eq!(hidden.id, hidden_id);

        // App-owned bytes are repaired from the compiled copy, without
        // resurrecting a source that the user deliberately hid.
        let hidden_package = Path::new(&hidden.package_path);
        fs::write(hidden_package.join("README.md"), b"tampered\n").unwrap();
        fs::create_dir(hidden_package.join("ansible")).unwrap();
        fs::write(
            hidden_package.join("ansible/injected.yml"),
            b"- hosts: all\n  tasks: []\n",
        )
        .unwrap();
        let reconciled = reconcile_builtin_sources(&app_data.0, &connection).unwrap();
        assert_eq!(reconciled.len(), 2);
        let repaired = db::get_source(&connection, &hidden_id).unwrap().unwrap();
        assert_eq!(repaired.id, hidden_id);
        assert!(repaired.hidden);
        assert_eq!(
            fs::read(hidden_package.join("README.md")).unwrap(),
            BUILTIN_PACKAGES[1].readme
        );
        assert!(!hidden_package.join("ansible").exists());

        let restored = db::restore_builtin_sources(&connection).unwrap();
        assert_eq!(restored.len(), 3);
        assert_eq!(restored[0].definition_id, "macos-security-posture");
        assert_eq!(restored[1].id, hidden_id);
    }

    #[test]
    fn package_export_round_trips_every_allowed_file_and_refuses_collision() {
        let root = TempRoot::new("package-export-roundtrip");
        let source_root = root.0.join("source");
        let destination = root.0.join("exports");
        fs::create_dir(&source_root).unwrap();
        fs::create_dir(&destination).unwrap();
        let package = write_export_test_package(&source_root);
        let connection = runbook_db();
        let source = db::upsert_source(
            &connection,
            &registration_input(&package, true, None).unwrap(),
        )
        .unwrap();

        let exported = export_runbook_package(&source, &package, &destination).unwrap();
        let output = destination.join("runbook-export-roundtrip-v1.0.0");
        assert_eq!(Path::new(&exported.destination), output);
        assert_eq!(exported.files.len(), 4);
        let imported = load_and_check_package(&output).unwrap();
        assert_eq!(imported.snapshot, package.snapshot);
        assert_eq!(
            fs::read(output.join("README.md")).unwrap(),
            fs::read(source_root.join("README.md")).unwrap()
        );
        assert_eq!(
            fs::read(output.join("ansible/site.yml")).unwrap(),
            fs::read(source_root.join("ansible/site.yml")).unwrap()
        );
        assert_eq!(
            fs::read(output.join("ansible/group_vars/all.yml")).unwrap(),
            fs::read(source_root.join("ansible/group_vars/all.yml")).unwrap()
        );
        assert_eq!(
            registration_input(&imported, true, None)
                .unwrap()
                .source_kind,
            SourceKind::User
        );

        let collision = export_runbook_package(&source, &package, &destination).unwrap_err();
        assert!(collision.contains("already exists"), "{collision}");
        assert!(!fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".staging-")
        }));
    }

    #[test]
    fn authored_publication_is_atomic_rollback_safe_and_drift_checked() {
        let temp = TempRoot::new("authored-publication");
        let source_root = temp.0.join("source");
        let package = write_export_test_package(&source_root);
        let source_v1 = package.snapshot.source_yaml.as_bytes().to_vec();
        let readme_v1 = fs::read(package.readme_path.unwrap()).unwrap();
        let authored_root = temp.0.join("authored");
        let destination = authored_root.join("draft-1");

        let mut first = publish_authored_package(
            &authored_root,
            &destination,
            &source_v1,
            &readme_v1,
            None,
            None,
        )
        .unwrap();
        first.commit();
        assert_eq!(
            fs::read(destination.join("runbook.vrun.yaml")).unwrap(),
            source_v1
        );

        let source_v2 = String::from_utf8(source_v1.clone())
            .unwrap()
            .replace("version: 1.0.0", "version: 1.1.0")
            .into_bytes();
        let readme_v2 = b"# Updated\n".to_vec();
        {
            let _uncommitted = publish_authored_package(
                &authored_root,
                &destination,
                &source_v2,
                &readme_v2,
                Some(&sha256_hex(&source_v1)),
                Some(&sha256_hex(&readme_v1)),
            )
            .unwrap();
            assert_eq!(
                fs::read(destination.join("runbook.vrun.yaml")).unwrap(),
                source_v2
            );
        }
        assert_eq!(
            fs::read(destination.join("runbook.vrun.yaml")).unwrap(),
            source_v1
        );

        fs::write(destination.join("unexpected.txt"), b"drift").unwrap();
        let error = publish_authored_package(
            &authored_root,
            &destination,
            &source_v2,
            &readme_v2,
            Some(&sha256_hex(&source_v1)),
            Some(&sha256_hex(&readme_v1)),
        )
        .unwrap_err();
        assert!(error.contains("unexpected files"));
        assert_eq!(
            fs::read(destination.join("unexpected.txt")).unwrap(),
            b"drift"
        );
    }

    #[test]
    fn changed_drafts_require_a_strictly_greater_semantic_version() {
        assert!(!draft_publication_changed(Some("same"), Some("1.0.0"), "same", "1.0.0").unwrap());
        assert!(draft_publication_changed(Some("old"), Some("1.0.0"), "new", "1.0.1").unwrap());
        assert!(
            draft_publication_changed(Some("old"), Some("1.0.0"), "new", "1.0.0")
                .unwrap_err()
                .contains("greater than 1.0.0")
        );
        assert!(
            draft_publication_changed(Some("old"), Some("1.0.0"), "new", "0.9.0")
                .unwrap_err()
                .contains("greater than 1.0.0")
        );
    }

    #[test]
    fn wizard_preview_rejects_secret_like_generated_content() {
        let mut document = RunbookDraftDocument {
            definition_id: "sensitive-check".into(),
            version: "1.0.0".into(),
            title: "Sensitive Check".into(),
            platform: crate::runbooks::drafts::DraftPlatform::Any,
            ..Default::default()
        };
        document.steps.push(crate::runbooks::drafts::DraftStep {
            id: "inspect".into(),
            title: "Inspect".into(),
            required: true,
            on_failure: None,
            apply: None,
            verify: None,
            check: crate::runbooks::drafts::DraftCheck::Shell {
                command: "curl -u operator:credential https://example.invalid".into(),
                env: BTreeMap::new(),
                compliant_exit_codes: vec![0],
                noncompliant_exit_codes: vec![1],
            },
        });
        let preview = validate_draft_preview(&document);
        assert!(preview.issues.iter().any(|issue| issue.path == "document"));
    }

    #[test]
    fn package_export_rejects_definition_drift_without_partial_output() {
        let root = TempRoot::new("package-export-drift");
        let source_root = root.0.join("source");
        let destination = root.0.join("exports");
        fs::create_dir(&source_root).unwrap();
        fs::create_dir(&destination).unwrap();
        let package = write_export_test_package(&source_root);
        let connection = runbook_db();
        let source = db::upsert_source(
            &connection,
            &registration_input(&package, true, None).unwrap(),
        )
        .unwrap();
        let mut definition = fs::read_to_string(source_root.join("runbook.vrun.yaml")).unwrap();
        definition.push_str("# drift\n");
        fs::write(source_root.join("runbook.vrun.yaml"), definition).unwrap();

        let error = export_runbook_package(&source, &package, &destination).unwrap_err();
        assert!(error.contains("changed since its last refresh"), "{error}");
        assert!(fs::read_dir(&destination).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn package_export_rejects_source_and_destination_symlinks_and_traversal() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new("package-export-path-safety");
        let source_root = root.0.join("source");
        let destination = root.0.join("exports");
        let real_destination = root.0.join("real-exports");
        let linked_destination = root.0.join("linked-exports");
        fs::create_dir(&source_root).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::create_dir(&real_destination).unwrap();
        let package = write_export_test_package(&source_root);
        let connection = runbook_db();
        let source = db::upsert_source(
            &connection,
            &registration_input(&package, true, None).unwrap(),
        )
        .unwrap();

        fs::remove_file(source_root.join("ansible/site.yml")).unwrap();
        symlink(
            source_root.join("README.md"),
            source_root.join("ansible/site.yml"),
        )
        .unwrap();
        let source_error = export_runbook_package(&source, &package, &destination).unwrap_err();
        assert!(
            source_error.contains("symlinks are not allowed"),
            "{source_error}"
        );
        assert!(fs::read_dir(&destination).unwrap().next().is_none());

        fs::remove_file(source_root.join("ansible/site.yml")).unwrap();
        fs::write(
            source_root.join("ansible/site.yml"),
            b"- hosts: all\n  tasks: []\n",
        )
        .unwrap();
        symlink(&real_destination, &linked_destination).unwrap();
        let destination_error =
            export_runbook_package(&source, &package, &linked_destination).unwrap_err();
        assert!(
            destination_error.contains("not an ordinary directory")
                || destination_error.contains("open pinned export destination component"),
            "{destination_error}"
        );
        let traversal_error =
            export_runbook_package(&source, &package, &destination.join("nested/..")).unwrap_err();
        assert!(
            traversal_error.contains("parent traversal"),
            "{traversal_error}"
        );
        assert!(fs::read_dir(&real_destination).unwrap().next().is_none());
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn pinned_package_export_is_not_redirected_by_destination_swap() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new("package-export-destination-swap");
        let source_root = root.0.join("source");
        let selected = root.0.join("selected");
        let moved = root.0.join("selected-moved");
        let decoy = root.0.join("decoy");
        fs::create_dir(&source_root).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::create_dir(&decoy).unwrap();
        let package = write_export_test_package(&source_root);
        let manifest = package_manifest(&package.root, None).unwrap();
        let bundle_name = "runbook-export-roundtrip-v1.0.0";
        let mut export = PinnedPackageExport::new(&selected, bundle_name).unwrap();

        // Replace the selected pathname after the destination and staging
        // handles are pinned. No later write, cleanup, or rename may follow it.
        fs::rename(&selected, &moved).unwrap();
        symlink(&decoy, &selected).unwrap();
        export.copy_manifest(&package.root, &manifest).unwrap();
        export.sync().unwrap();
        let published = export.publish(bundle_name, &manifest).unwrap();

        assert_eq!(published, moved.join(bundle_name));
        assert_eq!(
            load_and_check_package(&published).unwrap().snapshot,
            package.snapshot
        );
        assert!(fs::read_dir(&decoy).unwrap().next().is_none());
    }

    #[test]
    fn unchanged_approval_command_is_not_recorded_as_an_edit() {
        assert_eq!(
            normalize_edited_command(Some("echo ok".into()), Some("echo ok")).unwrap(),
            None
        );
        assert_eq!(
            normalize_edited_command(Some("  echo ok \t".into()), Some("echo ok")).unwrap(),
            None
        );
        assert_eq!(
            normalize_edited_command(Some("\u{feff}echo ok\u{feff}".into()), Some("echo ok"))
                .unwrap(),
            None
        );
        assert_eq!(
            normalize_edited_command(Some("echo safer".into()), Some("echo ok")).unwrap(),
            Some("echo safer".into())
        );
    }

    #[test]
    fn terminal_dispatch_claim_requires_running_attempt_owned_by_run() {
        let mut attempt = AttemptRecord {
            id: "attempt-1".into(),
            run_id: "run-1".into(),
            step_id: "step-1".into(),
            phase: RunbookPhase::Apply,
            sequence: 1,
            executor: "shell".into(),
            status: AttemptStatus::Running,
            proposed_command: Some("echo ok".into()),
            executed_command: Some("echo ok".into()),
            exit_code: None,
            duration_ms: None,
            output_tail: None,
            output_observed_bytes: 0,
            output_captured_bytes: 0,
            output_redacted: false,
            output_truncated: false,
            structured_outcomes: None,
            error: None,
            intent_at: now(),
            started_at: Some(now()),
            result_at: None,
        };
        validate_terminal_dispatch_attempt(&attempt, "run-1").unwrap();
        assert!(validate_terminal_dispatch_attempt(&attempt, "other-run")
            .unwrap_err()
            .contains("does not belong"));
        attempt.status = AttemptStatus::Intent;
        assert!(validate_terminal_dispatch_attempt(&attempt, "run-1")
            .unwrap_err()
            .contains("intent"));
    }

    #[test]
    fn manual_evidence_is_size_checked_but_not_pre_sanitized() {
        let raw = "token=do-not-pre-redact".to_string();
        assert_eq!(
            validate_manual_evidence(Some(raw.clone())).unwrap(),
            Some(raw)
        );
        assert_eq!(validate_manual_evidence(Some(String::new())).unwrap(), None);
        assert!(
            validate_manual_evidence(Some("é".repeat(FULL_EVIDENCE_BYTES / 2 + 1)))
                .unwrap_err()
                .contains("IPC limit")
        );
    }

    #[test]
    fn immutable_snapshot_verifier_rejects_tampered_bytes_and_digest_columns() {
        let source = r#"apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: snapshot-test
  version: 1.0.0
  title: Snapshot test
spec:
  target:
    kind: active-terminal
  steps:
    - id: inspect
      title: Inspect
      check:
        uses: manual
        instructions: Inspect the target.
"#;
        let definition = crate::runbooks::definition::parse_and_validate(source).unwrap();
        let canonical = crate::runbooks::package::canonical_json(&definition).unwrap();
        let source_hash = sha256_hex(source.as_bytes());
        let canonical_hash = sha256_hex(canonical.as_bytes());
        verify_snapshot_bytes("run-1", source, &canonical, &source_hash, &canonical_hash).unwrap();

        assert!(verify_snapshot_bytes(
            "run-1",
            &format!("{source}# changed\n"),
            &canonical,
            &source_hash,
            &canonical_hash,
        )
        .unwrap_err()
        .contains("source YAML"));
        assert!(verify_snapshot_bytes(
            "run-1",
            source,
            &format!(" {canonical}"),
            &source_hash,
            &canonical_hash,
        )
        .unwrap_err()
        .contains("canonical definition"));
        let pretty = serde_json::to_string_pretty(&definition).unwrap();
        assert!(verify_snapshot_bytes(
            "run-1",
            source,
            &pretty,
            &source_hash,
            &sha256_hex(pretty.as_bytes()),
        )
        .unwrap_err()
        .contains("not canonical"));
        let changed_source = source.replace("Snapshot test", "Different snapshot");
        assert!(verify_snapshot_bytes(
            "run-1",
            &changed_source,
            &canonical,
            &sha256_hex(changed_source.as_bytes()),
            &canonical_hash,
        )
        .unwrap_err()
        .contains("disagree"));
        assert!(verify_snapshot_bytes(
            "run-1",
            source,
            &canonical,
            &"0".repeat(64),
            &canonical_hash
        )
        .unwrap_err()
        .contains("source YAML"));
    }

    #[test]
    fn pending_manual_view_verifies_snapshot_before_rendering_instructions() {
        let source = r#"apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: manual-snapshot
  version: 1.0.0
  title: Manual snapshot
spec:
  target:
    kind: active-terminal
  steps:
    - id: inspect
      title: Inspect
      check:
        uses: manual
        instructions: Inspect the target.
"#;
        let definition = crate::runbooks::definition::parse_and_validate(source).unwrap();
        let canonical = crate::runbooks::package::canonical_json(&definition).unwrap();
        let mut run = RunRecord {
            id: "run-1".into(),
            source_id: None,
            definition_id: definition.metadata.id.clone(),
            definition_version: definition.metadata.version.clone(),
            definition_title: definition.metadata.title.clone(),
            source_yaml: source.into(),
            canonical_json: canonical.clone(),
            source_sha256: sha256_hex(source.as_bytes()),
            canonical_sha256: sha256_hex(canonical.as_bytes()),
            target: TargetBinding {
                kind: "active-terminal".into(),
                session_id: "session-1".into(),
                shell: Some("zsh".into()),
                cwd: Some("/srv".into()),
                remote_kind: None,
                remote_target: None,
                context_marker: Some("ctx".into()),
                observed_at: now(),
            },
            inputs: serde_json::json!({}),
            evidence_mode: EvidenceCaptureMode::Tail,
            status: RunStatus::WaitingOperator,
            active_step_id: Some("inspect".into()),
            active_phase: Some(RunbookPhase::Check),
            pause_reason: Some("manual".into()),
            app_version: "test".into(),
            model: None,
            created_at: now(),
            started_at: Some(now()),
            finished_at: None,
            updated_at: now(),
            report_sha256: None,
            report_generated_at: None,
        };
        assert_eq!(
            pending_manual_view(&run).unwrap().unwrap().instructions,
            "Inspect the target."
        );
        run.source_yaml.push_str("# tampered\n");
        assert!(pending_manual_view(&run)
            .unwrap_err()
            .contains("source YAML"));
    }

    #[test]
    fn malformed_directory_can_be_registered_as_invalid_without_reading_it() {
        let root = std::env::temp_dir().join(format!("runbook-invalid-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let input = invalid_registration_input(&root, "invalid YAML").unwrap();
        assert!(!input.valid);
        assert_eq!(input.definition_version, "0.0.0");
        assert_eq!(input.validation_error.as_deref(), Some("invalid YAML"));
        fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn target_attestations_must_be_recent() {
        let old = (Utc::now() - chrono::Duration::minutes(10)).to_rfc3339();
        assert!(validate_fresh_timestamp(&old, "observed_at").is_err());
        assert!(validate_fresh_timestamp(&now(), "observed_at").is_ok());
    }

    #[test]
    fn manual_na_enters_failure_flow_instead_of_claiming_compliance() {
        assert_eq!(
            manual_outcome(RunbookPhase::Check, ManualWireOutcome::NotApplicable),
            ManualOutcome::Failed
        );
        assert_eq!(
            manual_outcome(RunbookPhase::Check, ManualWireOutcome::Failed),
            ManualOutcome::Noncompliant
        );
        assert_eq!(
            manual_outcome(RunbookPhase::Verify, ManualWireOutcome::Passed),
            ManualOutcome::Verified
        );
    }

    #[test]
    fn evidence_cleanup_deletes_only_matching_confined_artifacts() {
        let root = std::env::temp_dir().join(format!("runbook-cleanup-{}", uuid::Uuid::new_v4()));
        let run_id = "terminal-run";
        let run_directory = root.join("runbooks").join(run_id);
        fs::create_dir_all(&run_directory).unwrap();
        let artifact = run_directory.join("attempt.log");
        fs::write(&artifact, b"captured evidence").unwrap();
        let record = db::EvidenceRecord {
            id: "evidence".into(),
            attempt_id: "attempt".into(),
            run_id: run_id.into(),
            mode: EvidenceCaptureMode::Full,
            availability: EvidenceAvailability::Complete,
            relative_path: Some(format!("runbooks/{run_id}/attempt.log")),
            bytes: b"captured evidence".len() as u64,
            sha256: sha256_hex(b"captured evidence"),
            redacted: false,
            truncated: false,
            created_at: now(),
        };

        let outcome = cleanup_evidence_artifacts(&root, run_id, &[record]);
        assert_eq!(outcome.expected, 1);
        assert_eq!(outcome.deleted, 1);
        assert_eq!(outcome.missing, 0);
        assert!(outcome.complete, "{:?}", outcome.errors);
        assert!(!artifact.exists());
        assert!(!run_directory.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn evidence_cleanup_deletes_tracked_partial_files_but_rejects_traversal() {
        let root = std::env::temp_dir().join(format!("runbook-retain-{}", uuid::Uuid::new_v4()));
        let run_id = "terminal-run";
        let run_directory = root.join("runbooks").join(run_id);
        fs::create_dir_all(&run_directory).unwrap();
        let artifact = run_directory.join("attempt.log");
        let staging = run_directory.join("attempt.log.pending");
        let outside = root.join("outside.log");
        fs::write(&artifact, b"actual bytes").unwrap();
        fs::write(&staging, b"partial staging bytes").unwrap();
        fs::write(&outside, b"outside").unwrap();
        let records = vec![
            db::EvidenceRecord {
                id: "mismatch".into(),
                attempt_id: "attempt".into(),
                run_id: run_id.into(),
                mode: EvidenceCaptureMode::Full,
                availability: EvidenceAvailability::Missing,
                relative_path: Some(format!("runbooks/{run_id}/attempt.log")),
                bytes: 5,
                sha256: sha256_hex(b"other"),
                redacted: false,
                truncated: false,
                created_at: now(),
            },
            db::EvidenceRecord {
                id: "escape".into(),
                attempt_id: "attempt-two".into(),
                run_id: run_id.into(),
                mode: EvidenceCaptureMode::Full,
                availability: EvidenceAvailability::Missing,
                relative_path: Some("outside.log".into()),
                bytes: 7,
                sha256: sha256_hex(b"outside"),
                redacted: false,
                truncated: false,
                created_at: now(),
            },
        ];

        let outcome = cleanup_evidence_artifacts(&root, run_id, &records);
        assert_eq!(outcome.expected, 2);
        assert_eq!(outcome.deleted, 1);
        assert!(!outcome.complete);
        assert!(outcome.errors.iter().any(|error| error.contains("outside")));
        assert!(!artifact.exists());
        assert!(!staging.exists());
        assert!(outside.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_symlinked_destination_components() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "runbook-export-destination-{}",
            uuid::Uuid::new_v4()
        ));
        let real = root.join("real");
        let link = root.join("link");
        fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap();
        let error =
            write_export_bundle(&link, "bundle", b"{}", b"# report", Vec::new()).unwrap_err();
        assert!(error.contains("pinned export destination component"));
        assert!(!real.join("bundle").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
