//! Where Steps keeps its own files: `%APPDATA%\Amluto\Steps` (settings, brands, shortcuts,
//! unfinished recordings and the OCR cache), beside the `Software\Policies\Amluto\Steps` key.
//! Before the rename to Steps (0.2.7) it was `%APPDATA%\Amluto Steps`; that folder is moved
//! once, the first time this version asks. If it can't be moved (a file held open), the old one
//! goes on being used, so nothing is left behind.
//!
//! The portable program (the loose `amluto-steps.exe` from a release, never installed) keeps
//! everything in a `Steps data` folder beside itself instead, so it can run from a USB stick:
//! settings, brands and recordings there directly, and `Local`, `Logs`, `WebView` and `Guides`
//! folders inside it. If that folder can't be written (the program copied into Program Files),
//! the usual per-user folders are used.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// The portable program's `Steps data` folder, or `None` for an installed copy, a development
/// build, or when it can't be written. Worked out once; needs no `AppHandle`, because the log
/// and the windows are set up before there is one.
pub fn portable_root() -> Option<PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        // Whatever the update policy: a portable copy with its checks switched off still keeps
        // its data beside itself.
        if !crate::updates::is_portable() {
            return None;
        }
        let program = std::env::current_exe().ok()?;
        writable(program.parent()?.join("Steps data"))
    })
    .clone()
}

/// The folder, if it exists or can be made and a file can be written in it.
fn writable(folder: PathBuf) -> Option<PathBuf> {
    std::fs::create_dir_all(&folder).ok()?;
    let probe = folder.join(".write-check");
    std::fs::write(&probe, b"").ok()?;
    let _ = std::fs::remove_file(&probe);
    Some(folder)
}

/// Tauri's local app data (`%LOCALAPPDATA%\com.amluto.steps`): previews and support files.
pub fn local_folder(app: &AppHandle) -> Result<PathBuf, String> {
    match portable_root() {
        Some(root) => Ok(root.join("Local")),
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string()),
    }
}

/// Where the logs go (`%LOCALAPPDATA%\com.amluto.steps\logs`).
pub fn log_folder(app: &AppHandle) -> Result<PathBuf, String> {
    match portable_root() {
        Some(root) => Ok(root.join("Logs")),
        None => app.path().app_log_dir().map_err(|error| error.to_string()),
    }
}

/// The library new recordings go to until the person picks one (`Documents\Steps`).
pub fn default_library(app: &AppHandle) -> Result<PathBuf, String> {
    match portable_root() {
        Some(root) => Ok(root.join("Guides")),
        None => app
            .path()
            .document_dir()
            .or_else(|error| home_folder(app, "Documents").ok_or(error))
            .map(|documents| documents.join("Steps"))
            .map_err(|error| error.to_string()),
    }
}

/// A folder in the home folder, made if it isn't there, for when the desktop hasn't named its
/// own. On Linux the Documents and Downloads folders come from `user-dirs.dirs`, which a fresh or
/// minimal desktop may not have; the home folder is always there.
pub fn home_folder(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let folder = app.path().home_dir().ok()?.join(name);
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder)
}

/// The web view's own data (its local storage holds some preferences), for the portable
/// program only; installed copies use Tauri's default.
pub fn webview_folder() -> Option<PathBuf> {
    portable_root().map(|root| root.join("WebView"))
}

/// The folder, worked out once per run (every caller must agree on it).
pub fn app_folder(app: &AppHandle) -> Option<PathBuf> {
    static FOLDER: OnceLock<Option<PathBuf>> = OnceLock::new();
    if let Some(root) = portable_root() {
        return Some(root);
    }
    FOLDER
        .get_or_init(|| match std::env::var_os("APPDATA") {
            Some(roaming) => Some(choose(Path::new(&roaming))),
            None => app.path().app_data_dir().ok(),
        })
        .clone()
}

/// The new folder, after moving the old one into it if only the old one exists.
fn choose(roaming: &Path) -> PathBuf {
    let current = roaming.join("Amluto").join("Steps");
    let old = roaming.join("Amluto Steps");
    if current.exists() || !old.is_dir() {
        return current;
    }
    let moved = std::fs::create_dir_all(roaming.join("Amluto"))
        .and_then(|()| std::fs::rename(&old, &current));
    match moved {
        Ok(()) => {
            log::info!("moved {} to {}", old.display(), current.display());
            current
        }
        Err(error) => {
            log::warn!(
                "couldn't move {} to {} ({error}); using it where it is",
                old.display(),
                current.display()
            );
            old
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_old_folder_moves_once_with_its_files() {
        let roaming = tempfile::tempdir().unwrap();
        let old = roaming.path().join("Amluto Steps");
        std::fs::create_dir_all(old.join("brands")).unwrap();
        std::fs::write(old.join("shortcuts.json"), "{}").unwrap();

        let folder = choose(roaming.path());
        assert_eq!(folder, roaming.path().join("Amluto").join("Steps"));
        assert!(folder.join("shortcuts.json").exists());
        assert!(folder.join("brands").is_dir());
        assert!(!old.exists());
        // Asked again, it's simply the new folder.
        assert_eq!(choose(roaming.path()), folder);
    }

    #[test]
    fn the_portable_folder_is_used_only_when_it_can_be_written() {
        let beside = tempfile::tempdir().unwrap();
        let folder = beside.path().join("Steps data");
        assert_eq!(writable(folder.clone()), Some(folder.clone()));
        assert!(folder.is_dir());
        assert!(!folder.join(".write-check").exists());
        // A path under a file can't be a folder.
        std::fs::write(beside.path().join("file"), b"x").unwrap();
        assert_eq!(
            writable(beside.path().join("file").join("Steps data")),
            None
        );
    }

    #[test]
    fn a_new_pc_gets_the_new_folder() {
        let roaming = tempfile::tempdir().unwrap();
        assert_eq!(
            choose(roaming.path()),
            roaming.path().join("Amluto").join("Steps")
        );
    }

    #[test]
    fn when_both_exist_the_new_one_wins_and_the_old_is_left() {
        let roaming = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(roaming.path().join("Amluto Steps")).unwrap();
        std::fs::create_dir_all(roaming.path().join("Amluto").join("Steps")).unwrap();
        assert_eq!(
            choose(roaming.path()),
            roaming.path().join("Amluto").join("Steps")
        );
        assert!(roaming.path().join("Amluto Steps").exists());
    }
}
