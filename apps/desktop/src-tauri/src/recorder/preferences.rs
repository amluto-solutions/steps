//! The recorder's preferences file: the name and the default library folder.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::files::{ensure_library_metadata, write_new_bytes};
use super::{CommandError, RecorderPreferences, storage_error, unique_id};

pub(super) fn validate_preferences(
    mut preferences: RecorderPreferences,
) -> Result<RecorderPreferences, CommandError> {
    preferences.display_name = preferences.display_name.trim().to_string();
    if preferences.display_name.chars().count() > 120
        || !crate::export_files::local_drive(&preferences.library_folder)
        || !preferences.library_folder.is_absolute()
    {
        return Err(CommandError::new(
            "invalidPreferences",
            "Enter a name of up to 120 characters and an absolute local library folder.",
        ));
    }
    Ok(preferences)
}

/// Reads saved settings leniently: a missing or damaged file, a field from a newer version or an
/// invalid value falls back to the default, so the settings file can never stop the app opening.
pub(super) fn read_preferences(app_data: &Path, default_library: PathBuf) -> RecorderPreferences {
    let saved: Value = match fs::read(app_data.join("recorder-settings.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::error!("Recording settings are unreadable; using defaults: {error}");
            Value::Null
        }),
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::error!("Recording settings could not be read; using defaults: {error}");
            }
            Value::Null
        }
    };
    let preferences = RecorderPreferences {
        display_name: saved
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        library_folder: saved
            .get("libraryFolder")
            .and_then(Value::as_str)
            .map_or_else(|| default_library.clone(), PathBuf::from),
    };
    validate_preferences(preferences).unwrap_or_else(|_| RecorderPreferences {
        display_name: String::new(),
        library_folder: default_library,
    })
}

/// Makes sure a library folder exists and is marked as one.
pub(super) fn prepare_library(library: &Path) -> Result<(), String> {
    fs::create_dir_all(library.join("guides")).map_err(|error| error.to_string())?;
    ensure_library_metadata(library)
}

pub(super) fn save_preferences(
    app_data: &Path,
    preferences: &RecorderPreferences,
) -> Result<(), CommandError> {
    // A unique temporary name lets a later save succeed after an interrupted earlier save.
    let temporary = app_data.join(format!("recorder-settings-{}.tmp", unique_id()));
    let bytes = serde_json::to_vec_pretty(preferences).map_err(storage_error)?;
    let result = write_new_bytes(&temporary, &bytes)
        .and_then(|()| fs::rename(&temporary, app_data.join("recorder-settings.json")));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(storage_error)
}
