//! Installation of the bundled `vterminal-docs` companion.
//!
//! The command never edits a shell profile. It copies the already-built and
//! signed companion into a conventional user-local bin directory. Windows
//! manages one exact user-PATH entry; Unix leaves PATH policy to the user.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Manager, Wry};

#[derive(Serialize)]
pub struct KnowledgeCliStatus {
    installed: bool,
    path_ready: bool,
    path: String,
}

fn managed_destination() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let destination = dirs::data_local_dir()
        .ok_or_else(|| "could not locate LOCALAPPDATA".to_string())?
        .join("Programs")
        .join("VTerminal")
        .join("bin")
        .join("vterminal-docs.exe");
    #[cfg(not(target_os = "windows"))]
    let destination = dirs::home_dir()
        .ok_or_else(|| "could not locate your home directory".to_string())?
        .join(".local")
        .join("bin")
        .join("vterminal-docs");
    Ok(destination)
}

fn bundled_cli(app: &tauri::AppHandle<Wry>) -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("could not locate VTerminal: {error}"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "VTerminal has no executable directory".to_string())?;
    let resource_dir = app.path().resource_dir().ok();

    let mut candidates = vec![
        executable_dir.join("vterminal-docs.exe"),
        executable_dir.join("vterminal-docs-x86_64-pc-windows-msvc.exe"),
        executable_dir.join("vterminal-docs"),
        executable_dir.join("vterminal-docs-aarch64-apple-darwin"),
        executable_dir.join("vterminal-docs-x86_64-apple-darwin"),
        executable_dir.join("vterminal-docs-x86_64-unknown-linux-gnu"),
    ];
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("vterminal-docs"));
        candidates.push(resources.join("vterminal-docs.exe"));
        candidates.push(resources.join("vterminal-docs-x86_64-pc-windows-msvc.exe"));
        candidates.push(resources.join("vterminal-docs-aarch64-apple-darwin"));
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "the signed vterminal-docs companion is not present in this build; install a release build that includes the Knowledge CLI"
                .into()
        })
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug)]
struct WindowsRuntimePayload {
    core: Vec<PathBuf>,
    backends: Vec<PathBuf>,
}

#[cfg(any(target_os = "windows", test))]
const WINDOWS_RUNTIME_ANCHORS: [&str; 4] =
    ["llama-common.dll", "llama.dll", "ggml.dll", "ggml-base.dll"];

#[cfg(any(target_os = "windows", test))]
fn windows_runtime_dll_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    ((name.starts_with("llama") || name.starts_with("ggml")) && name.ends_with(".dll"))
        .then_some(name)
}

#[cfg(any(target_os = "windows", test))]
fn reconcile_windows_runtime_dlls(
    directory: &Path,
    expected: &std::collections::HashSet<String>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("could not inspect managed runtime: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("could not inspect a managed runtime entry: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("could not inspect a managed runtime file: {error}"))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        let Some(name) = windows_runtime_dll_name(&path) else {
            continue;
        };
        if !expected.contains(&name) {
            std::fs::remove_file(&path).map_err(|error| {
                format!(
                    "could not remove stale runtime DLL {}: {error}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn bundled_windows_runtime(source: &Path) -> Result<Option<WindowsRuntimePayload>, String> {
    let root = source
        .parent()
        .ok_or_else(|| "the bundled CLI has no parent directory".to_string())?;
    let mut core = Vec::new();
    for entry in std::fs::read_dir(root)
        .map_err(|error| format!("could not inspect {}: {error}", root.display()))?
    {
        let entry =
            entry.map_err(|error| format!("could not inspect a local runtime entry: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("could not inspect a local runtime file: {error}"))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        if windows_runtime_dll_name(&path).is_some() {
            core.push(path);
        }
    }
    let backend_dir = root.join("llama-backends");
    let mut backends = Vec::new();
    if backend_dir.is_dir() {
        for entry in std::fs::read_dir(&backend_dir)
            .map_err(|error| format!("could not inspect {}: {error}", backend_dir.display()))?
        {
            let entry = entry.map_err(|error| {
                format!("could not inspect an inference backend entry: {error}")
            })?;
            if !entry
                .file_type()
                .map_err(|error| format!("could not inspect a backend file: {error}"))?
                .is_file()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.ends_with(".dll") {
                continue;
            }
            if name != "ggml-vulkan.dll" && name != "ggml-cpu.dll" && !name.starts_with("ggml-cpu-")
            {
                return Err(format!(
                    "the bundled local runtime contains an unexpected backend {name}"
                ));
            }
            backends.push(entry.path());
        }
    }

    if core.is_empty() && backends.is_empty() {
        return Ok(None);
    }
    let core_names: std::collections::HashSet<_> = core
        .iter()
        .filter_map(|path| windows_runtime_dll_name(path))
        .collect();
    let missing: Vec<_> = WINDOWS_RUNTIME_ANCHORS
        .iter()
        .filter(|name| !core_names.contains(**name))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "the bundled local runtime is missing required llama/GGML DLLs: {}",
            missing.join(", ")
        ));
    }
    let has_vulkan = backends.iter().any(|path| {
        path.file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("ggml-vulkan.dll"))
    });
    let has_cpu = backends.iter().any(|path| {
        path.file_name().is_some_and(|name| {
            let name = name.to_string_lossy().to_ascii_lowercase();
            name == "ggml-cpu.dll" || (name.starts_with("ggml-cpu-") && name.ends_with(".dll"))
        })
    });
    if !has_vulkan || !has_cpu {
        return Err(
            "the bundled local runtime must include Vulkan and at least one CPU backend".into(),
        );
    }
    core.sort();
    backends.sort();
    Ok(Some(WindowsRuntimePayload { core, backends }))
}

#[cfg(unix)]
fn install(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let parent = destination
        .parent()
        .ok_or_else(|| "the CLI destination has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;

    let temporary = parent.join(format!(".vterminal-docs.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::copy(source, &temporary).map_err(|error| {
            format!(
                "could not copy the Knowledge CLI to {}: {error}",
                temporary.display()
            )
        })?;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("could not mark the Knowledge CLI executable: {error}"))?;
        std::fs::rename(&temporary, destination).map_err(|error| {
            format!(
                "could not install the Knowledge CLI at {}: {error}",
                destination.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "windows")]
fn install(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "the CLI destination has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let runtime = bundled_windows_runtime(source)?;
    let install_file = |source: &Path, destination: &Path| -> Result<(), String> {
        let name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("vterminal-runtime");
        let temporary = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            std::fs::copy(source, &temporary).map_err(|error| {
                format!(
                    "could not copy {} to {}: {error}",
                    source.display(),
                    temporary.display()
                )
            })?;
            crate::windows_fs::replace_file(&temporary, destination)
                .map_err(|error| format!("could not install {}: {error}", destination.display()))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    };

    (|| {
        let backend_destination = parent.join("llama-backends");
        if let Some(runtime) = runtime {
            std::fs::create_dir_all(&backend_destination).map_err(|error| {
                format!(
                    "could not create {}: {error}",
                    backend_destination.display()
                )
            })?;
            for source in &runtime.core {
                install_file(source, &parent.join(source.file_name().unwrap()))?;
            }
            for source in &runtime.backends {
                install_file(
                    source,
                    &backend_destination.join(source.file_name().unwrap()),
                )?;
            }
            let expected_core = runtime
                .core
                .iter()
                .filter_map(|path| windows_runtime_dll_name(path))
                .collect();
            reconcile_windows_runtime_dlls(parent, &expected_core)?;
            let expected: std::collections::HashSet<_> = runtime
                .backends
                .iter()
                .filter_map(|path| path.file_name().map(|name| name.to_ascii_lowercase()))
                .collect();
            for entry in std::fs::read_dir(&backend_destination)
                .map_err(|error| format!("could not inspect managed backends: {error}"))?
            {
                let path = entry
                    .map_err(|error| format!("could not inspect a managed backend: {error}"))?
                    .path();
                let stale = path.extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("dll")
                        && path
                            .file_name()
                            .is_some_and(|name| !expected.contains(&name.to_ascii_lowercase()))
                });
                if stale {
                    std::fs::remove_file(&path).map_err(|error| {
                        format!("could not remove stale backend {}: {error}", path.display())
                    })?;
                }
            }
        } else {
            reconcile_windows_runtime_dlls(parent, &std::collections::HashSet::new())?;
            if backend_destination.is_dir() {
                for entry in std::fs::read_dir(&backend_destination)
                    .map_err(|error| format!("could not inspect managed backends: {error}"))?
                {
                    let path = entry
                        .map_err(|error| format!("could not inspect a managed backend: {error}"))?
                        .path();
                    if path
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"))
                    {
                        std::fs::remove_file(&path).map_err(|error| {
                            format!("could not remove stale backend {}: {error}", path.display())
                        })?;
                    }
                }
                let _ = std::fs::remove_dir(&backend_destination);
            }
        }
        install_file(source, destination)?;
        add_user_path(parent)
    })()
}

#[cfg(target_os = "windows")]
fn add_user_path(directory: &Path) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let environment = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|error| format!("could not open the user environment: {error}"))?;
    let current: String = environment.get_value("Path").unwrap_or_default();
    let wanted = directory
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let present = current
        .split(';')
        .map(str::trim)
        .map(|entry| entry.trim_end_matches(['\\', '/']))
        .any(|entry| entry.eq_ignore_ascii_case(&wanted));
    if !present {
        let updated = if current.trim().is_empty() {
            wanted
        } else {
            format!("{};{}", current.trim_end_matches(';'), wanted)
        };
        environment.set_value("Path", &updated).map_err(|error| {
            format!("could not add the Knowledge CLI to your user PATH: {error}")
        })?;
        crate::windows_fs::broadcast_environment_change();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn managed_path_ready(directory: &Path) -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let Ok(environment) =
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ)
    else {
        return false;
    };
    let current: String = environment.get_value("Path").unwrap_or_default();
    let wanted = directory.to_string_lossy();
    current
        .split(';')
        .map(str::trim)
        .map(|entry| entry.trim_end_matches(['\\', '/']))
        .any(|entry| entry.eq_ignore_ascii_case(wanted.trim_end_matches(['\\', '/'])))
}

#[cfg(not(target_os = "windows"))]
fn managed_path_ready(directory: &Path) -> bool {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|entry| entry == directory)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn install(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("the Knowledge CLI installer is unavailable on this platform".into())
}

#[tauri::command]
pub fn knowledge_cli_install(app: tauri::AppHandle<Wry>) -> Result<String, String> {
    super::knowledge::gate(&app)?;
    let source = bundled_cli(&app)?;
    let destination = managed_destination()?;
    install(&source, &destination)?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn knowledge_cli_status(app: tauri::AppHandle<Wry>) -> Result<KnowledgeCliStatus, String> {
    super::knowledge::gate(&app)?;
    let destination = managed_destination()?;
    let parent = destination
        .parent()
        .ok_or_else(|| "the CLI destination has no parent directory".to_string())?;
    #[cfg(all(target_os = "windows", feature = "local-llm"))]
    let installed =
        destination.is_file() && matches!(bundled_windows_runtime(&destination), Ok(Some(_)));
    #[cfg(not(all(target_os = "windows", feature = "local-llm")))]
    let installed = destination.is_file();
    Ok(KnowledgeCliStatus {
        installed,
        path_ready: managed_path_ready(parent),
        path: destination.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_never_edits_a_shell_profile() {
        let destination = Path::new("/Users/example")
            .join(".local")
            .join("bin")
            .join("vterminal-docs");
        assert_eq!(
            destination,
            Path::new("/Users/example/.local/bin/vterminal-docs")
        );
    }

    #[test]
    fn windows_runtime_payload_is_complete_or_feature_off() {
        let root = std::env::temp_dir().join(format!(
            "vterminal-cli-runtime-test-{}",
            uuid::Uuid::new_v4()
        ));
        let backends = root.join("llama-backends");
        std::fs::create_dir_all(&backends).unwrap();
        let cli = root.join("vterminal-docs.exe");
        std::fs::write(&cli, b"exe").unwrap();

        assert!(bundled_windows_runtime(&cli).unwrap().is_none());
        for name in ["llama.dll", "ggml.dll", "ggml-base.dll"] {
            std::fs::write(root.join(name), b"dll").unwrap();
        }
        std::fs::write(backends.join("ggml-cpu-x64.dll"), b"cpu").unwrap();
        std::fs::write(backends.join("ggml-vulkan.dll"), b"vulkan").unwrap();
        let error = bundled_windows_runtime(&cli).unwrap_err();
        assert!(error.contains("llama-common.dll"));

        std::fs::write(root.join("llama-common.dll"), b"common").unwrap();
        std::fs::write(root.join("ggml-future.dll"), b"future").unwrap();
        std::fs::write(root.join("unrelated.dll"), b"other").unwrap();
        let payload = bundled_windows_runtime(&cli).unwrap().unwrap();
        let core_names: Vec<_> = payload
            .core
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            core_names,
            [
                "ggml-base.dll",
                "ggml-future.dll",
                "ggml.dll",
                "llama-common.dll",
                "llama.dll"
            ]
        );
        assert_eq!(payload.backends.len(), 2);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_runtime_reconciliation_removes_only_stale_managed_dlls() {
        let root = std::env::temp_dir().join(format!(
            "vterminal-cli-runtime-reconcile-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("ggml-directory.dll")).unwrap();
        for name in [
            "llama.dll",
            "llama-old.dll",
            "GGML-OLD.DLL",
            "unrelated.dll",
        ] {
            std::fs::write(root.join(name), b"dll").unwrap();
        }

        reconcile_windows_runtime_dlls(
            &root,
            &std::collections::HashSet::from(["llama.dll".into()]),
        )
        .unwrap();

        assert!(root.join("llama.dll").is_file());
        assert!(!root.join("llama-old.dll").exists());
        assert!(!root.join("GGML-OLD.DLL").exists());
        assert!(root.join("unrelated.dll").is_file());
        assert!(root.join("ggml-directory.dll").is_dir());

        std::fs::remove_dir_all(root).unwrap();
    }
}
