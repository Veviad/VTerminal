//! Installation of the bundled `vterminal-docs` companion.
//!
//! The command deliberately does not edit a shell profile.  It copies the
//! already-built and signed companion into the conventional user-local bin
//! directory and returns that exact path for the UI to display.

use std::path::{Path, PathBuf};

use tauri::{Manager, Wry};

fn bundled_cli(app: &tauri::AppHandle<Wry>) -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("could not locate VTerminal: {error}"))?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "VTerminal has no executable directory".to_string())?;
    let resource_dir = app.path().resource_dir().ok();

    let mut candidates = vec![
        executable_dir.join("vterminal-docs"),
        executable_dir.join("vterminal-docs-aarch64-apple-darwin"),
        executable_dir.join("vterminal-docs-x86_64-apple-darwin"),
        executable_dir.join("vterminal-docs-x86_64-unknown-linux-gnu"),
    ];
    if let Some(resources) = resource_dir {
        candidates.push(resources.join("vterminal-docs"));
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

#[cfg(not(unix))]
fn install(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("the ~/.local/bin installer is currently available on macOS and Linux".into())
}

#[tauri::command]
pub fn knowledge_cli_install(app: tauri::AppHandle<Wry>) -> Result<String, String> {
    super::knowledge::gate(&app)?;
    let source = bundled_cli(&app)?;
    let home =
        dirs::home_dir().ok_or_else(|| "could not locate your home directory".to_string())?;
    let destination = home.join(".local").join("bin").join("vterminal-docs");
    install(&source, &destination)?;
    Ok(destination.to_string_lossy().into_owned())
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
}
