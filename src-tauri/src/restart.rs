use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Relaunch the executable named by the app bundle that is on disk now.
///
/// The updater may replace both the executable and `Info.plist`, so deriving
/// the new path from the current binary's filename can strand an update that
/// renamed its `CFBundleExecutable`.
pub fn relaunch_updated_app() -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("locate the current executable: {error}"))?;
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    relaunch_with(&current_exe, &args, |executable, args| {
        Command::new(executable)
            .args(args)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("spawn {}: {error}", executable.display()))
    })
}

fn relaunch_with<F>(current_exe: &Path, args: &[OsString], spawn: F) -> Result<(), String>
where
    F: FnOnce(&Path, &[OsString]) -> Result<(), String>,
{
    let executable = resolve_bundle_executable(current_exe)?;
    spawn(&executable, args)
}

fn resolve_bundle_executable(current_exe: &Path) -> Result<PathBuf, String> {
    let macos_dir = current_exe
        .parent()
        .filter(|path| path.file_name() == Some(OsStr::new("MacOS")))
        .ok_or_else(|| {
            format!(
                "current executable is not inside an app bundle's Contents/MacOS directory: {}",
                current_exe.display()
            )
        })?;
    let contents_dir = macos_dir.parent().ok_or_else(|| {
        format!(
            "current executable has no app bundle Contents directory: {}",
            current_exe.display()
        )
    })?;
    let info_path = contents_dir.join("Info.plist");
    let plist = plist::Value::from_file(&info_path)
        .map_err(|error| format!("read {}: {error}", info_path.display()))?;
    let executable_name = plist
        .as_dictionary()
        .and_then(|dictionary| dictionary.get("CFBundleExecutable"))
        .and_then(plist::Value::as_string)
        .ok_or_else(|| format!("{} has no string CFBundleExecutable", info_path.display()))?;

    let name_path = Path::new(executable_name);
    let mut components = name_path.components();
    let valid_basename =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !valid_basename {
        return Err(format!(
            "{} has an invalid CFBundleExecutable: {executable_name:?}",
            info_path.display()
        ));
    }

    let executable = macos_dir.join(name_path);
    if !executable.is_file() {
        return Err(format!(
            "bundle executable does not exist: {}",
            executable.display()
        ));
    }
    Ok(executable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    struct TestBundle {
        root: PathBuf,
        current_exe: PathBuf,
    }

    impl TestBundle {
        fn new(plist: &str, executables: &[&str]) -> Self {
            let root = std::env::temp_dir().join(format!(
                "vterminal-restart-test-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            let contents = root.join("VTerminal.app/Contents");
            let macos = contents.join("MacOS");
            std::fs::create_dir_all(&macos).unwrap();
            std::fs::write(contents.join("Info.plist"), plist).unwrap();
            for executable in executables {
                std::fs::write(macos.join(executable), b"test executable").unwrap();
            }
            Self {
                root,
                current_exe: macos.join("VTerminal"),
            }
        }
    }

    impl Drop for TestBundle {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn xml_plist(executable: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>{executable}</string></dict></plist>"#
        )
    }

    #[test]
    fn resolves_the_updated_plist_name_and_forwards_arguments() {
        let bundle = TestBundle::new(&xml_plist("VTerminal Next"), &["VTerminal Next"]);
        let args = vec![
            OsString::from("--opened-after-update"),
            OsString::from("two"),
        ];
        let mut spawned = None;

        relaunch_with(&bundle.current_exe, &args, |executable, received_args| {
            spawned = Some((executable.to_owned(), received_args.to_vec()));
            Ok(())
        })
        .unwrap();

        let (executable, received_args) = spawned.unwrap();
        assert_eq!(
            executable,
            bundle.current_exe.parent().unwrap().join("VTerminal Next")
        );
        assert_eq!(received_args, args);
    }

    #[test]
    fn rejects_a_plist_path_that_escapes_the_macos_directory() {
        let bundle = TestBundle::new(&xml_plist("../Resources/other"), &[]);
        let error = resolve_bundle_executable(&bundle.current_exe).unwrap_err();
        assert!(error.contains("invalid CFBundleExecutable"));
    }

    #[test]
    fn rejects_a_missing_bundle_executable() {
        let bundle = TestBundle::new(&xml_plist("VTerminal"), &[]);
        let error = resolve_bundle_executable(&bundle.current_exe).unwrap_err();
        assert!(error.contains("does not exist"));
    }

    #[test]
    fn rejects_a_non_bundle_current_executable() {
        let error = resolve_bundle_executable(Path::new("/tmp/VTerminal")).unwrap_err();
        assert!(error.contains("Contents/MacOS"));
    }
}
