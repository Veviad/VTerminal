use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use vterminal_lib::runbooks::definition::{
    parse_and_validate, DefinitionError, MAX_SHELL_COMMAND_CHARS,
};
use vterminal_lib::runbooks::package::{
    load_package, resolve_package_file, PackageError, DEFINITION_FILE,
};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live beneath the repository root")
        .to_path_buf()
}

fn example(name: &str) -> PathBuf {
    repository_root().join("examples/runbooks").join(name)
}

fn fixture(group: &str, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/runbooks")
        .join(group)
        .join(name)
}

fn fixture_source(group: &str, name: &str) -> String {
    let path = fixture(group, name).join(DEFINITION_FILE);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read fixture {}: {error}", path.display()))
}

#[test]
fn reusable_example_packages_load_and_create_immutable_snapshots() {
    // The baseline is at 2.0.0 because its steps changed meaning: one goal now
    // serves as both check and verify where two identical commands used to.
    let cases = [
        ("linux-server-security-baseline", "2.0.0", 2, false, true),
        ("idempotent-software-install", "1.0.0", 1, true, true),
        ("manual-server-assessment", "1.0.0", 2, false, false),
        ("linux-host-hardening", "1.0.0", 4, true, true),
    ];

    for (name, version, step_count, network, has_apply) in cases {
        let package = load_package(example(name))
            .unwrap_or_else(|error| panic!("example {name} must load: {error}"));

        assert_eq!(package.definition.metadata.id, name);
        assert_eq!(package.definition.metadata.version, version);
        assert_eq!(package.definition.spec.steps.len(), step_count);
        assert_eq!(
            package.definition.spec.declared_capabilities.network,
            network
        );
        assert_eq!(
            package
                .definition
                .spec
                .steps
                .iter()
                .any(|step| step.apply.is_some()),
            has_apply
        );
        assert!(!package.definition.uses_unavailable_executor());
        assert!(package.readme_path.is_some());
        assert_eq!(package.snapshot.source_sha256.len(), 64);
        assert_eq!(package.snapshot.canonical_sha256.len(), 64);
        assert_ne!(
            package.snapshot.source_sha256,
            package.snapshot.canonical_sha256
        );
        let canonical: serde_json::Value =
            serde_json::from_str(&package.snapshot.canonical_json).unwrap();
        assert_eq!(canonical["metadata"]["id"], name);
    }
}

/// The goal-directed example, checked for the properties that make it one.
///
/// Shipped examples are the working documentation for a feature, so this pins
/// the shape a reader is meant to copy rather than only that the file parses.
#[test]
fn the_hardening_example_is_goal_directed_and_bounded() {
    let package = load_package(example("linux-host-hardening")).expect("example must load");
    let definition = &package.definition;

    // One discovery block serves the whole run; without it the model would be
    // guessing between ufw and firewalld on every step.
    let discover = &definition
        .spec
        .context
        .as_ref()
        .expect("the example must discover its target")
        .discover;
    assert_eq!(discover.len(), 4);
    assert!(discover.iter().any(|probe| probe.name == "os_release"));

    for step in &definition.spec.steps {
        let goal = step
            .goal
            .as_ref()
            .unwrap_or_else(|| panic!("{} must state a goal", step.id));
        assert!(!goal.checks.is_empty());
        // The point of the example: no `check:` and no `verify:` of their own,
        // because the goal conditions serve as both.
        assert!(
            step.check.is_none(),
            "{} should not restate a check",
            step.id
        );
        assert!(
            step.verify.is_none(),
            "{} should not restate a verify",
            step.id
        );
        assert!(step.apply.is_some(), "{} must remediate", step.id);
    }

    // The two SSH steps edit a local file, so they declare no network. That is
    // the narrowing this feature exists for and it must survive an edit.
    let ssh_steps: Vec<_> = definition
        .spec
        .steps
        .iter()
        .filter(|step| step.id.starts_with("ssh-"))
        .collect();
    assert_eq!(ssh_steps.len(), 2);
    for step in ssh_steps {
        assert_eq!(
            step.constraints.and_then(|c| c.network),
            Some(false),
            "{} must refuse the network",
            step.id
        );
    }

    // A hardening run keeps its evidence: the operator's policy may raise this,
    // never lower it.
    assert_eq!(
        definition.declared_record_output(),
        Some(vterminal_lib::runbooks::state::EvidenceCaptureMode::Full)
    );
}

#[test]
fn checked_in_invalid_definitions_fail_closed_by_error_class() {
    for name in [
        "unknown-field",
        "unknown-action",
        "duplicate-field",
        // The goal block widens what the parser accepts, so it needs the same
        // closed-deserialization guarantee as everything that came before it.
        "unknown-goal-field",
    ] {
        let error = parse_and_validate(&fixture_source("invalid", name)).unwrap_err();
        assert!(
            matches!(error, DefinitionError::Yaml(_)),
            "{name} should be a closed deserialization error, got {error}"
        );
    }

    for (name, expected) in [
        ("duplicate-step-id", "duplicate step ID"),
        ("invalid-semver", "semantic version"),
        ("goal-without-conditions", "at least one check"),
    ] {
        let error = parse_and_validate(&fixture_source("invalid", name)).unwrap_err();
        assert!(
            matches!(error, DefinitionError::Validation(_)),
            "{name} should fail semantic validation, got {error}"
        );
        assert!(
            error.to_string().contains(expected),
            "{name} did not report {expected:?}: {error}"
        );
    }
}

#[test]
fn yaml_extensions_and_multiple_documents_are_rejected_before_deserialization() {
    for name in ["yaml-alias", "yaml-tag", "yaml-merge", "yaml-multidoc"] {
        let error = parse_and_validate(&fixture_source("malicious", name)).unwrap_err();
        assert!(
            matches!(error, DefinitionError::UnsafeYaml { .. }),
            "{name} should fail YAML preflight, got {error}"
        );
    }
}

#[test]
fn unsafe_shell_and_ansible_paths_never_become_actions() {
    for (name, expected) in [
        ("shell-newline", "exactly one line"),
        ("shell-heredoc", "heredoc"),
        ("ansible-traversal", "beneath ansible/"),
    ] {
        let error = parse_and_validate(&fixture_source("malicious", name)).unwrap_err();
        assert!(
            matches!(error, DefinitionError::Validation(_)),
            "{name} should fail semantic validation, got {error}"
        );
        assert!(
            error.to_string().contains(expected),
            "{name} did not report {expected:?}: {error}"
        );
    }

    let oversized = format!(
        r#"apiVersion: runbooks.veviad.com/v1alpha1
kind: Runbook
metadata:
  id: oversized-shell-command
  version: 1.0.0
  title: Oversized command fixture
spec:
  target:
    kind: active-terminal
  steps:
    - id: oversized-command
      title: Reject an oversized command
      check:
        uses: shell
        with:
          command: "{}"
        outcomes:
          compliantExitCodes: [0]
          noncompliantExitCodes: [1]
"#,
        "x".repeat(MAX_SHELL_COMMAND_CHARS + 1)
    );
    let error = parse_and_validate(&oversized).unwrap_err();
    assert!(matches!(error, DefinitionError::Validation(_)));
    assert!(error.to_string().contains("4096"), "{error}");
}

#[test]
fn the_public_package_loader_rejects_invalid_and_extra_content() {
    for (group, name) in [
        ("invalid", "unknown-field"),
        ("malicious", "yaml-alias"),
        ("malicious", "ansible-traversal"),
    ] {
        let error = load_package(fixture(group, name)).unwrap_err();
        assert!(
            matches!(error, PackageError::Definition(_)),
            "{group}/{name} reached the package registry: {error}"
        );
    }

    let error = load_package(fixture("malicious", "unsupported-root-entry")).unwrap_err();
    assert!(
        matches!(error, PackageError::UnsupportedRootEntry(_)),
        "unexpected root payload was accepted: {error}"
    );
}

#[cfg(unix)]
#[test]
fn package_symlinks_and_resolver_traversal_are_rejected() {
    use std::os::unix::fs::symlink;

    static NEXT: AtomicU32 = AtomicU32::new(0);
    let suffix = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "vterminal-runbook-fixture-{}-{suffix}",
        std::process::id()
    ));
    let root_link = root.with_extension("root-link");
    let _ = fs::remove_file(&root_link);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("ansible")).unwrap();
    fs::copy(
        example("manual-server-assessment").join(DEFINITION_FILE),
        root.join(DEFINITION_FILE),
    )
    .unwrap();

    symlink(&root, &root_link).unwrap();
    let root_link_result = load_package(&root_link);
    fs::remove_file(&root_link).unwrap();

    symlink(root.join(DEFINITION_FILE), root.join("ansible/linked.yml")).unwrap();
    let nested_link_result = load_package(&root);
    let canonical_root = fs::canonicalize(&root).unwrap();
    let traversal_result = resolve_package_file(&canonical_root, "../outside.yml");

    fs::remove_dir_all(&root).unwrap();

    assert!(matches!(
        root_link_result,
        Err(PackageError::RootSymlink(_))
    ));
    assert!(matches!(nested_link_result, Err(PackageError::Symlink(_))));
    assert!(matches!(
        traversal_result,
        Err(PackageError::InvalidReference(_))
    ));
}
