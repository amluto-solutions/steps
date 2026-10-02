//! Settings files (`.amlsettings`): copy a setup to another PC or hand the same setup to a team
//! (Settings → General, and the first-run screen). The UI validates the JSON with the
//! `packages/core` schema; this side only refuses anything that isn't a small `.amlsettings` file,
//! so the commands can't be used to read or write other files.
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
use std::fs;
use std::path::Path;

use crate::recorder::CommandError;

/// A kind of small JSON file the user picks: its extension, the most it may hold, and what to
/// call it when refusing something else. Brand files (`.amlbrand`) use the same rules.
pub struct DataFile {
    pub extension: &'static str,
    pub max_bytes: u64,
    pub code: &'static str,
    pub wrong_file: &'static str,
}

/// Far more than a settings file needs; anything bigger is not one.
const SETTINGS: DataFile = DataFile {
    extension: "amlsettings",
    max_bytes: 256 * 1024,
    code: "notSettingsFile",
    wrong_file: "Choose a Steps settings file (.amlsettings).",
};

fn checked_path<'a>(kind: &DataFile, path: &'a str) -> Result<&'a Path, CommandError> {
    let path = Path::new(path);
    let right_kind = path.is_absolute()
        && crate::export_files::ordinary_path(path)
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(kind.extension));
    if right_kind {
        Ok(path)
    } else {
        Err(CommandError::new(kind.code, kind.wrong_file))
    }
}

/// Reads a file of this kind, refusing any other file and anything too large.
pub fn read(kind: &DataFile, path: &str) -> Result<String, CommandError> {
    let path = checked_path(kind, path)?;
    let size = fs::metadata(path)
        .map_err(|error| CommandError::new("storage", error.to_string()))?
        .len();
    if size > kind.max_bytes {
        return Err(CommandError::new(kind.code, kind.wrong_file));
    }
    fs::read_to_string(path).map_err(|error| CommandError::new("storage", error.to_string()))
}

/// Writes a file of this kind through a flushed temporary file, so a failure leaves nothing
/// half-written.
pub fn write(kind: &DataFile, path: &str, contents: &str) -> Result<(), CommandError> {
    let path = checked_path(kind, path)?;
    if contents.len() as u64 > kind.max_bytes {
        return Err(CommandError::new(kind.code, "That is too large to save."));
    }
    library::write_atomic(path, contents.as_bytes())
        .map_err(|error| CommandError::new("storage", error.to_string()))
}

/// "Back up all": settings, brands (with their logos and fonts) and the list of libraries.
const BACKUP: DataFile = DataFile {
    extension: "amlbackup",
    max_bytes: 256 * 1024 * 1024,
    code: "notBackupFile",
    wrong_file: "Choose a Steps backup file (.amlbackup).",
};

#[tauri::command(async)]
pub fn backup_read_file(path: String) -> Result<String, CommandError> {
    read(&BACKUP, &path)
}

#[tauri::command(async)]
pub fn backup_write_file(path: String, contents: String) -> Result<(), CommandError> {
    write(&BACKUP, &path, &contents)
}

#[tauri::command(async)]
pub fn settings_read_file(path: String) -> Result<String, CommandError> {
    read(&SETTINGS, &path)
}

#[tauri::command(async)]
pub fn settings_write_file(path: String, contents: String) -> Result<(), CommandError> {
    write(&SETTINGS, &path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_small_settings_files_are_read_or_written() {
        let folder = tempfile::tempdir().expect("temp dir");
        let file = folder.path().join("team.amlsettings");
        let name = file.to_string_lossy().into_owned();
        write(&SETTINGS, &name, r#"{"formatVersion":1}"#).expect("write");
        assert_eq!(
            read(&SETTINGS, &name).expect("read"),
            r#"{"formatVersion":1}"#
        );

        let other = folder.path().join("notes.txt");
        fs::write(&other, "secret").expect("write");
        assert_eq!(
            read(&SETTINGS, &other.to_string_lossy())
                .unwrap_err()
                .code(),
            "notSettingsFile"
        );
        assert_eq!(
            write(&SETTINGS, "relative.amlsettings", "{}")
                .unwrap_err()
                .code(),
            "notSettingsFile"
        );
        let big = folder.path().join("big.amlsettings");
        fs::write(&big, vec![b' '; 300 * 1024]).expect("write");
        assert_eq!(
            read(&SETTINGS, &big.to_string_lossy()).unwrap_err().code(),
            "notSettingsFile"
        );
    }
}
