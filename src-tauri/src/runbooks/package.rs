//! Confined local runbook packages and immutable definition snapshots.
//!
//! A package is intentionally boring: one root `runbook.vrun.yaml`, an optional
//! `README.md`, and an optional `ansible/` tree reserved for the follow-on adapter.
//! Symlinks and every other root entry are rejected, so registration cannot quietly
//! widen the set of files a later execution is allowed to inspect.

use super::definition::{
    parse_and_validate, AnsiblePlaybookAction, ApplyAction, CheckAction, DefinitionError,
    RunbookDefinition, VerifyAction, MAX_DEFINITION_BYTES,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub const DEFINITION_FILE: &str = "runbook.vrun.yaml";
pub const README_FILE: &str = "README.md";
pub const ANSIBLE_DIRECTORY: &str = "ansible";
pub const MAX_PACKAGE_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionSnapshot {
    pub source_yaml: String,
    pub canonical_json: String,
    pub source_sha256: String,
    pub canonical_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedPackage {
    pub root: PathBuf,
    pub definition_path: PathBuf,
    pub readme_path: Option<PathBuf>,
    pub definition: RunbookDefinition,
    pub snapshot: DefinitionSnapshot,
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("failed to serialize validated runbook definition: {0}")]
    Serialize(#[from] serde_json::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("cannot inspect runbook package {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("runbook package root is a symlink: {0}")]
    RootSymlink(PathBuf),
    #[error("runbook package root is not a directory: {0}")]
    NotDirectory(PathBuf),
    #[error("symlinks are not allowed in runbook packages: {0}")]
    Symlink(PathBuf),
    #[error("package entry escapes its canonical root: {0}")]
    EscapesRoot(PathBuf),
    #[error("unsupported package root entry: {0}")]
    UnsupportedRootEntry(PathBuf),
    #[error("unsupported special file in runbook package: {0}")]
    SpecialFile(PathBuf),
    #[error("runbook package contains more than {MAX_PACKAGE_ENTRIES} entries")]
    TooManyEntries,
    #[error("runbook package must contain one root {DEFINITION_FILE}")]
    MissingDefinition,
    #[error("{DEFINITION_FILE} exceeds the {MAX_DEFINITION_BYTES}-byte limit")]
    DefinitionTooLarge,
    #[error("{DEFINITION_FILE} must be UTF-8: {0}")]
    DefinitionEncoding(#[from] std::string::FromUtf8Error),
    #[error(transparent)]
    Definition(#[from] DefinitionError),
    #[error(transparent)]
    Snapshot(#[from] SnapshotError),
    #[error("package changed while it was being validated; refresh and try again")]
    ChangedDuringValidation,
    #[error("referenced package path is invalid: {0}")]
    InvalidReference(String),
    #[error("referenced package entry does not exist: {0}")]
    MissingReference(PathBuf),
    #[error("referenced playbook is not a regular file: {0}")]
    ReferenceNotFile(PathBuf),
}

/// Import or refresh a local package. Call this function again at run creation; its
/// returned snapshot is the only definition the live run should ever consult.
pub fn load_package(root: impl AsRef<Path>) -> Result<ValidatedPackage, PackageError> {
    let requested_root = root.as_ref();
    let root_metadata = symlink_metadata(requested_root)?;
    if root_metadata.file_type().is_symlink() {
        return Err(PackageError::RootSymlink(requested_root.to_path_buf()));
    }
    if !root_metadata.is_dir() {
        return Err(PackageError::NotDirectory(requested_root.to_path_buf()));
    }
    // Pin the directory before resolving or walking it. A writable ancestor can
    // otherwise be renamed after validation and make the second path-based read
    // observe a different package. Native v1 executes only the root definition,
    // which is opened relative to this handle below. The future Ansible adapter
    // must extend the same dirfd discipline to every referenced component.
    let pinned_root = PinnedPackageRoot::open(requested_root, &root_metadata)?;
    let root = canonicalize(requested_root)?;
    pinned_root.verify_named_root(&root)?;

    validate_package_tree(&root)?;
    pinned_root.verify_named_root(&root)?;
    let definition_path = root.join(DEFINITION_FILE);
    let source_bytes = pinned_root.read_definition(&definition_path)?;
    let source_yaml = String::from_utf8(source_bytes.clone())?;
    let definition = parse_and_validate(&source_yaml)?;
    validate_ansible_references(&root, &definition)?;
    pinned_root.verify_named_root(&root)?;

    // A second tree walk and read narrows package-swap races and, most importantly,
    // makes refresh/run-start revalidation deterministic. The engine still stores
    // and uses the bytes returned here rather than reopening the source mid-run.
    validate_package_tree(&root)?;
    pinned_root.verify_named_root(&root)?;
    if pinned_root.read_definition(&definition_path)? != source_bytes {
        return Err(PackageError::ChangedDuringValidation);
    }
    pinned_root.verify_named_root(&root)?;

    let snapshot = snapshot_definition(&source_yaml, &definition)?;
    let readme = root.join(README_FILE);
    let readme_path = readme.exists().then_some(readme);

    Ok(ValidatedPackage {
        root,
        definition_path,
        readme_path,
        definition,
        snapshot,
    })
}

/// An opened package-directory capability. On Unix, all executable v1 source
/// bytes are opened relative to this fd with `O_NOFOLLOW`; the path is retained
/// only for diagnostics and for validating inert optional package entries.
struct PinnedPackageRoot {
    #[cfg(unix)]
    directory: File,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl PinnedPackageRoot {
    fn open(path: &Path, inspected: &fs::Metadata) -> Result<Self, PackageError> {
        #[cfg(unix)]
        {
            let mut options = OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
            let directory = options.open(path).map_err(|source| PackageError::Io {
                path: path.to_path_buf(),
                source,
            })?;
            let opened = directory.metadata().map_err(|source| PackageError::Io {
                path: path.to_path_buf(),
                source,
            })?;
            if !opened.is_dir() {
                return Err(PackageError::NotDirectory(path.to_path_buf()));
            }
            if inspected.dev() != opened.dev() || inspected.ino() != opened.ino() {
                return Err(PackageError::ChangedDuringValidation);
            }
            Ok(Self {
                device: opened.dev(),
                inode: opened.ino(),
                directory,
            })
        }

        #[cfg(not(unix))]
        {
            let _ = (path, inspected);
            Ok(Self {})
        }
    }

    fn verify_named_root(&self, canonical_root: &Path) -> Result<(), PackageError> {
        let metadata = symlink_metadata(canonical_root)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(PackageError::ChangedDuringValidation);
        }

        #[cfg(unix)]
        if metadata.dev() != self.device || metadata.ino() != self.inode {
            return Err(PackageError::ChangedDuringValidation);
        }

        Ok(())
    }

    fn read_definition(&self, display_path: &Path) -> Result<Vec<u8>, PackageError> {
        #[cfg(unix)]
        {
            let name = CString::new(DEFINITION_FILE)
                .expect("the fixed runbook definition name contains no NUL");
            // SAFETY: `directory` is a live directory fd, `name` is a valid
            // NUL-terminated relative leaf, and ownership of a successful fd is
            // transferred immediately to `File` exactly once.
            let fd = unsafe {
                libc::openat(
                    self.directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(PackageError::Io {
                    path: display_path.to_path_buf(),
                    source: std::io::Error::last_os_error(),
                });
            }
            // SAFETY: `openat` returned a new owned fd and no other owner exists.
            let file = unsafe { File::from_raw_fd(fd) };
            validate_and_read_definition(file, display_path)
        }

        #[cfg(not(unix))]
        {
            read_definition(display_path)
        }
    }
}

/// Resolve a package-relative file without ever following a symlink or leaving the
/// canonical package root. Kept public for the future Ansible adapter; native v1
/// does not read package scripts.
pub fn resolve_package_file(
    canonical_root: &Path,
    relative: &str,
) -> Result<PathBuf, PackageError> {
    validate_relative_path(relative)?;
    let joined = canonical_root.join(relative);
    let metadata = match fs::symlink_metadata(&joined) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(PackageError::MissingReference(joined));
        }
        Err(source) => {
            return Err(PackageError::Io {
                path: joined,
                source,
            });
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(PackageError::Symlink(joined));
    }
    if !metadata.is_file() {
        return Err(PackageError::ReferenceNotFile(joined));
    }
    let resolved = canonicalize(&joined)?;
    if !resolved.starts_with(canonical_root) {
        return Err(PackageError::EscapesRoot(resolved));
    }
    Ok(resolved)
}

pub fn snapshot_definition(
    source_yaml: &str,
    definition: &RunbookDefinition,
) -> Result<DefinitionSnapshot, SnapshotError> {
    let canonical_json = canonical_json(definition)?;
    Ok(DefinitionSnapshot {
        source_yaml: source_yaml.to_owned(),
        source_sha256: sha256_hex(source_yaml.as_bytes()),
        canonical_sha256: sha256_hex(canonical_json.as_bytes()),
        canonical_json,
    })
}

/// Deterministic compact JSON: object keys are sorted recursively and strings use
/// serde_json's escaping. Definitions contain no floating-point fields, so this is
/// stable across platforms and independent of serde_json's map backend/features.
pub fn canonical_json(definition: &RunbookDefinition) -> Result<String, serde_json::Error> {
    let value = serde_json::to_value(definition)?;
    let mut output = String::new();
    write_canonical_value(&value, &mut output)?;
    Ok(output)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn write_canonical_value(value: &Value, output: &mut String) -> Result<(), serde_json::Error> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => write!(output, "{value}").expect("writing to String cannot fail"),
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_canonical_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                write_canonical_value(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn validate_package_tree(root: &Path) -> Result<(), PackageError> {
    let mut stack = vec![(root.to_path_buf(), true)];
    let mut entries = 0usize;
    let mut found_definition = false;

    while let Some((directory, is_root)) = stack.pop() {
        let iterator = fs::read_dir(&directory).map_err(|source| PackageError::Io {
            path: directory.clone(),
            source,
        })?;
        for entry in iterator {
            let entry = entry.map_err(|source| PackageError::Io {
                path: directory.clone(),
                source,
            })?;
            entries += 1;
            if entries > MAX_PACKAGE_ENTRIES {
                return Err(PackageError::TooManyEntries);
            }
            let path = entry.path();
            let metadata = symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(PackageError::Symlink(path));
            }
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(PackageError::SpecialFile(path));
            }
            let resolved = canonicalize(&path)?;
            if !resolved.starts_with(root) {
                return Err(PackageError::EscapesRoot(resolved));
            }

            if is_root {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                match name.as_ref() {
                    DEFINITION_FILE if metadata.is_file() => found_definition = true,
                    README_FILE if metadata.is_file() => {}
                    ANSIBLE_DIRECTORY if metadata.is_dir() => {
                        stack.push((path, false));
                    }
                    _ => return Err(PackageError::UnsupportedRootEntry(path)),
                }
            } else if metadata.is_dir() {
                stack.push((path, false));
            }
        }
    }

    if !found_definition {
        return Err(PackageError::MissingDefinition);
    }
    Ok(())
}

#[cfg(any(not(unix), test))]
fn read_definition(path: &Path) -> Result<Vec<u8>, PackageError> {
    // Open once without following the leaf, then validate and read that same
    // handle through a hard cap. A metadata(path) + fs::read(path) sequence can
    // otherwise be swapped to a symlink, device, or huge file between calls.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|source| PackageError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    validate_and_read_definition(file, path)
}

fn validate_and_read_definition(file: File, path: &Path) -> Result<Vec<u8>, PackageError> {
    let metadata = file.metadata().map_err(|source| PackageError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(PackageError::MissingDefinition);
    }
    if metadata.len() > MAX_DEFINITION_BYTES as u64 {
        return Err(PackageError::DefinitionTooLarge);
    }
    read_capped(file, path)
}

fn read_capped(file: File, path: &Path) -> Result<Vec<u8>, PackageError> {
    let mut bytes = Vec::with_capacity(MAX_DEFINITION_BYTES.min(64 * 1024));
    file.take(MAX_DEFINITION_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| PackageError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if bytes.len() > MAX_DEFINITION_BYTES {
        return Err(PackageError::DefinitionTooLarge);
    }
    Ok(bytes)
}

fn validate_ansible_references(
    root: &Path,
    definition: &RunbookDefinition,
) -> Result<(), PackageError> {
    for step in &definition.spec.steps {
        match &step.check {
            CheckAction::AnsiblePlaybook { action } => validate_ansible_reference(root, action)?,
            CheckAction::Shell { .. } | CheckAction::Agent { .. } | CheckAction::Manual { .. } => {}
        }
        if let Some(action) = &step.apply {
            match action {
                ApplyAction::AnsiblePlaybook { action } => {
                    validate_ansible_reference(root, action)?
                }
                ApplyAction::Shell { .. }
                | ApplyAction::Agent { .. }
                | ApplyAction::Manual { .. } => {}
            }
        }
        if let Some(action) = &step.verify {
            match action {
                VerifyAction::AnsiblePlaybook { action } => {
                    validate_ansible_reference(root, action)?
                }
                VerifyAction::Shell { .. }
                | VerifyAction::Agent { .. }
                | VerifyAction::Manual { .. } => {}
            }
        }
    }
    Ok(())
}

fn validate_ansible_reference(
    root: &Path,
    action: &AnsiblePlaybookAction,
) -> Result<(), PackageError> {
    resolve_package_file(root, &action.playbook)?;
    if let Some(inventory) = &action.inventory {
        resolve_package_file(root, inventory)?;
    }
    Ok(())
}

fn validate_relative_path(relative: &str) -> Result<(), PackageError> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.is_absolute()
        || relative.contains('\\')
        || relative.chars().any(char::is_control)
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PackageError::InvalidReference(relative.to_owned()));
    }
    Ok(())
}

fn symlink_metadata(path: &Path) -> Result<fs::Metadata, PackageError> {
    fs::symlink_metadata(path).map_err(|source| PackageError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn canonicalize(path: &Path) -> Result<PathBuf, PackageError> {
    fs::canonicalize(path).map_err(|source| PackageError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runbooks::state::EvidenceCaptureMode;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempPackage(PathBuf);

    impl TempPackage {
        fn create(source: &str) -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "vterminal-runbook-package-{}-{id}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join(DEFINITION_FILE), source).unwrap();
            Self(path)
        }
    }

    impl Drop for TempPackage {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ASSESSMENT: &str = r#"
apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: inspect-host
  version: 1.0.0
  title: Inspect host
spec:
  target:
    kind: active-terminal
  steps:
    - id: kernel-present
      title: Check the kernel
      check:
        uses: shell
        with:
          command: uname -s
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
"#;

    #[test]
    fn loads_a_confined_package_and_snapshots_both_representations() {
        let package = TempPackage::create(ASSESSMENT);
        fs::write(package.0.join(README_FILE), "# Inspect host\n").unwrap();
        let loaded = load_package(&package.0).unwrap();

        assert_eq!(loaded.definition.metadata.id, "inspect-host");
        assert_eq!(loaded.snapshot.source_yaml, ASSESSMENT);
        assert_eq!(loaded.snapshot.source_sha256.len(), 64);
        assert_eq!(loaded.snapshot.canonical_sha256.len(), 64);
        assert!(loaded.snapshot.canonical_json.starts_with('{'));
        assert!(loaded.readme_path.is_some());
    }

    #[test]
    fn canonical_json_ignores_yaml_formatting_but_source_digest_does_not() {
        let first = parse_and_validate(ASSESSMENT).unwrap();
        let reformatted = ASSESSMENT.replace("version: 1.0.0", "version: '1.0.0'");
        let second = parse_and_validate(&reformatted).unwrap();
        let first = snapshot_definition(ASSESSMENT, &first).unwrap();
        let second = snapshot_definition(&reformatted, &second).unwrap();

        assert_eq!(first.canonical_json, second.canonical_json);
        assert_eq!(first.canonical_sha256, second.canonical_sha256);
        assert_ne!(first.source_sha256, second.source_sha256);
    }

    #[test]
    fn rejects_unknown_root_entries_and_missing_definitions() {
        let package = TempPackage::create(ASSESSMENT);
        fs::write(package.0.join("install.sh"), "echo unsafe").unwrap();
        assert!(matches!(
            load_package(&package.0),
            Err(PackageError::UnsupportedRootEntry(_))
        ));

        fs::remove_file(package.0.join("install.sh")).unwrap();
        fs::remove_file(package.0.join(DEFINITION_FILE)).unwrap();
        assert!(matches!(
            load_package(&package.0),
            Err(PackageError::MissingDefinition)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_root_and_nested_symlinks() {
        use std::os::unix::fs::symlink;

        let package = TempPackage::create(ASSESSMENT);
        let linked_root = package.0.with_extension("linked");
        let _ = fs::remove_file(&linked_root);
        symlink(&package.0, &linked_root).unwrap();
        assert!(matches!(
            load_package(&linked_root),
            Err(PackageError::RootSymlink(_))
        ));
        fs::remove_file(linked_root).unwrap();

        fs::create_dir(package.0.join(ANSIBLE_DIRECTORY)).unwrap();
        symlink(
            package.0.join(DEFINITION_FILE),
            package.0.join(ANSIBLE_DIRECTORY).join("site.yml"),
        )
        .unwrap();
        assert!(matches!(
            load_package(&package.0),
            Err(PackageError::Symlink(_))
        ));
    }

    #[test]
    fn ansible_references_must_exist_beneath_the_reserved_directory() {
        let source = ASSESSMENT.replace(
            "uses: shell\n        with:\n          command: uname -s\n        outcomes:\n          compliantExitCodes: [0]\n          noncompliantExitCodes: [1]",
            "uses: ansible.playbook\n        with:\n          playbook: ansible/site.yml",
        );
        let package = TempPackage::create(&source);
        fs::create_dir(package.0.join(ANSIBLE_DIRECTORY)).unwrap();
        assert!(matches!(
            load_package(&package.0),
            Err(PackageError::MissingReference(_))
        ));

        fs::write(
            package.0.join(ANSIBLE_DIRECTORY).join("site.yml"),
            "- hosts: all\n  tasks: []\n",
        )
        .unwrap();
        let loaded = load_package(&package.0).unwrap();
        assert!(loaded.definition.uses_unavailable_executor());
    }

    #[test]
    fn relative_path_resolver_rejects_traversal() {
        let package = TempPackage::create(ASSESSMENT);
        let root = fs::canonicalize(&package.0).unwrap();
        assert!(matches!(
            resolve_package_file(&root, "../outside"),
            Err(PackageError::InvalidReference(_))
        ));
        assert!(matches!(
            resolve_package_file(&root, "/etc/passwd"),
            Err(PackageError::InvalidReference(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn definition_reader_never_follows_a_swapped_leaf_symlink() {
        use std::os::unix::fs::symlink;

        let package = TempPackage::create(ASSESSMENT);
        let definition = package.0.join(DEFINITION_FILE);
        fs::remove_file(&definition).unwrap();
        symlink("/dev/zero", &definition).unwrap();
        assert!(read_definition(&definition).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn pinned_root_rejects_a_named_directory_swap() {
        let package = TempPackage::create(ASSESSMENT);
        let inspected = symlink_metadata(&package.0).unwrap();
        let pinned = PinnedPackageRoot::open(&package.0, &inspected).unwrap();
        let canonical = canonicalize(&package.0).unwrap();
        let moved = package.0.with_extension("moved");
        let _ = fs::remove_dir_all(&moved);

        fs::rename(&package.0, &moved).unwrap();
        fs::create_dir(&package.0).unwrap();
        fs::write(package.0.join(DEFINITION_FILE), "replacement").unwrap();

        assert!(matches!(
            pinned.verify_named_root(&canonical),
            Err(PackageError::ChangedDuringValidation)
        ));
        assert_eq!(
            pinned
                .read_definition(&canonical.join(DEFINITION_FILE))
                .unwrap(),
            ASSESSMENT.as_bytes()
        );

        fs::remove_dir_all(&package.0).unwrap();
        fs::rename(moved, &package.0).unwrap();
    }

    /// Every byte a definition without optional extras canonicalises to.
    ///
    /// `canonical_sha256` is registered per source and baked into every
    /// persisted run, and `verify_snapshot_bytes` re-canonicalises a stored run
    /// and demands byte equality. So a new field that serialises when absent
    /// does not merely invalidate a registration — a refresh fixes that — it
    /// makes every run recorded by an older build permanently unresumable.
    /// Note the pre-existing `"apply":null` / `"verify":null` / `"onFailure":null`
    /// below: those fields predate the rule and show exactly what it prevents.
    /// Add `#[serde(default, skip_serializing_if = ...)]` to anything new here.
    const CANONICAL_WITHOUT_OPTIONAL_FIELDS: &str = concat!(
        r#"{"apiVersion":"runbooks.veviad.com/v1alpha1","kind":"Runbook","#,
        r#""metadata":{"description":"","id":"inspect-host","tags":[],"#,
        r#""title":"Inspect host","version":"1.0.0"},"#,
        r#""spec":{"declaredCapabilities":{"network":false,"privilege":"none","writes":[]},"#,
        r#""defaults":{"onFailure":"pause"},"inputs":{},"#,
        r#""steps":[{"apply":null,"check":{"outcomes":{"compliantExitCodes":[0],"#,
        r#""noncompliantExitCodes":[1]},"uses":"shell","#,
        r#""with":{"command":"uname -s","env":{}}},"id":"kernel-present","#,
        r#""onFailure":null,"required":true,"title":"Check the kernel","verify":null}],"#,
        r#""target":{"kind":"active-terminal"}}}"#,
    );

    #[test]
    fn an_unset_optional_field_never_reaches_canonical_json() {
        let definition = parse_and_validate(ASSESSMENT).unwrap();
        let canonical = canonical_json(&definition).unwrap();
        assert_eq!(canonical, CANONICAL_WITHOUT_OPTIONAL_FIELDS);
        assert!(definition.declared_record_output().is_none());
    }

    #[test]
    fn an_audit_request_is_carried_and_changes_only_that_definition() {
        let baseline = parse_and_validate(ASSESSMENT).unwrap();
        let requested = ASSESSMENT.replace(
            "  target:\n    kind: active-terminal\n",
            "  target:\n    kind: active-terminal\n  audit:\n    recordOutput: full\n",
        );
        let requested = parse_and_validate(&requested).unwrap();

        assert_eq!(
            requested.declared_record_output(),
            Some(EvidenceCaptureMode::Full)
        );
        let canonical = canonical_json(&requested).unwrap();
        assert!(canonical.contains(r#""audit":{"recordOutput":"full"}"#));
        assert_ne!(
            snapshot_definition(ASSESSMENT, &baseline)
                .unwrap()
                .canonical_sha256,
            snapshot_definition("", &requested)
                .unwrap()
                .canonical_sha256,
        );
    }

    #[test]
    fn an_unknown_audit_field_is_rejected() {
        let source = ASSESSMENT.replace(
            "  target:\n    kind: active-terminal\n",
            "  target:\n    kind: active-terminal\n  audit:\n    keepForever: true\n",
        );
        assert!(parse_and_validate(&source).is_err());
    }

    #[test]
    fn a_recording_policy_spelling_is_not_a_capture_mode() {
        // `runbook` is the operator policy, never something a package can ask
        // for: the package says how much to keep, the operator says the floor.
        let source = ASSESSMENT.replace(
            "  target:\n    kind: active-terminal\n",
            "  target:\n    kind: active-terminal\n  audit:\n    recordOutput: runbook\n",
        );
        assert!(parse_and_validate(&source).is_err());
    }

    #[test]
    fn definition_reader_caps_the_open_handle() {
        let package = TempPackage::create(ASSESSMENT);
        let definition = package.0.join(DEFINITION_FILE);
        fs::write(&definition, vec![b'x'; MAX_DEFINITION_BYTES + 1]).unwrap();
        assert!(matches!(
            read_definition(&definition),
            Err(PackageError::DefinitionTooLarge)
        ));
    }
}
