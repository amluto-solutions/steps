//! Local log files: 5 MB per file, 5 files kept, nothing older than 30 days
//! (docs/spec/03-data-and-sharing.md#app-data-desktop-per-user).
//!
//! Logs never contain field values, OCR text or screenshots
//! (docs/spec/08-privacy-and-security.md#data-inventory).

use std::path::Path;
use std::time::{Duration, SystemTime};

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

const MAX_FILE_BYTES: u128 = 5 * 1024 * 1024;
const FILES_KEPT: usize = 5;
const MAX_AGE: Duration = Duration::from_hours(30 * 24);

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(match crate::app_folder::portable_root() {
            // The portable program logs beside itself, like the rest of its data.
            Some(root) => TargetKind::Folder {
                path: root.join("Logs"),
                file_name: Some("amluto-steps".into()),
            },
            None => TargetKind::LogDir {
                file_name: Some("amluto-steps".into()),
            },
        }))
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(FILES_KEPT))
        .level(log::LevelFilter::Info);

    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }

    builder.build()
}

/// Deletes log files older than 30 days. Failures are ignored: pruning must never stop the app.
pub fn prune_old_logs(app: &AppHandle) {
    if let Ok(dir) = crate::app_folder::log_folder(app) {
        let removed = prune_dir(&dir, SystemTime::now(), MAX_AGE);
        if removed > 0 {
            log::info!("removed {removed} log file(s) older than 30 days");
        }
    }
}

/// Removes files in `dir` last modified more than `max_age` before `now`. Returns how many were removed.
fn prune_dir(dir: &Path, now: SystemTime, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };

    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age > max_age)
        })
        .filter(|entry| std::fs::remove_file(entry.path()).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    use filetime::FileTime;

    #[test]
    fn removes_only_files_older_than_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.log");
        let fresh = dir.path().join("fresh.log");
        std::fs::write(&old, "old").unwrap();
        std::fs::write(&fresh, "fresh").unwrap();

        let now = SystemTime::now();
        let forty_days_ago = now - Duration::from_hours(40 * 24);
        filetime::set_file_mtime(&old, FileTime::from_system_time(forty_days_ago)).unwrap();

        assert_eq!(prune_dir(dir.path(), now, MAX_AGE), 1);
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn missing_folder_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            prune_dir(&dir.path().join("absent"), SystemTime::now(), MAX_AGE),
            0
        );
    }
}
