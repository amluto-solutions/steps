//! Brand profiles on this PC: `%APPDATA%\Amluto\Steps\brands\<id>\profile.json`
//! (docs/spec/06-brands-and-theming.md). The UI validates the profile with the `packages/core`
//! schema; this side keeps ids safe and files small, and writes atomically.
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::AppHandle;

use crate::recorder::CommandError;

/// Room for two logos and uploaded fonts (up to four 4 MB faces, base64).
const MAX_PROFILE_BYTES: usize = 24 * 1024 * 1024;

fn brands_folder(app: &AppHandle) -> Result<PathBuf, CommandError> {
    crate::app_folder::app_folder(app)
        .map(|folder| folder.join("brands"))
        .ok_or_else(|| CommandError::new("notReady", "The app-data folder is not available."))
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

fn list(folder: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut profiles: Vec<Value> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let folder_name = entry.file_name().to_string_lossy().into_owned();
            let bytes = fs::read(entry.path().join("profile.json")).ok()?;
            let profile: Value = serde_json::from_slice(&bytes).ok()?;
            // A copied folder claiming another id is skipped, as in the library.
            (safe_id(&folder_name)
                && profile.get("id").and_then(Value::as_str) == Some(folder_name.as_str()))
            .then_some(profile)
        })
        .collect();
    profiles.sort_by(|left, right| {
        let name = |value: &Value| {
            value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_lowercase()
        };
        name(left).cmp(&name(right))
    });
    profiles
}

fn save(folder: &Path, profile: &Value) -> Result<(), CommandError> {
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| safe_id(id))
        .ok_or_else(|| CommandError::new("invalidBrand", "The brand profile has an invalid id."))?;
    let bytes = serde_json::to_vec_pretty(profile)
        .map_err(|error| CommandError::new("invalidBrand", error.to_string()))?;
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(CommandError::new(
            "tooLarge",
            "The brand profile is too large. Use a smaller logo.",
        ));
    }
    // Windows' folder names ignore case: "Contoso" would write into "contoso"'s folder, replacing
    // that brand (an organisation's included) while the list no longer shows it. Ids are one
    // brand whatever their case.
    let clash = fs::read_dir(folder).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.eq_ignore_ascii_case(id) && name != id
        })
    });
    if clash {
        return Err(CommandError::new(
            "invalidBrand",
            "Another brand already has this id with different capital letters.",
        ));
    }
    let directory = folder.join(id);
    fs::create_dir_all(&directory)
        .map_err(|error| CommandError::new("storage", error.to_string()))?;
    library::write_atomic(&directory.join("profile.json"), &bytes)
        .map_err(|error| CommandError::new("storage", error.to_string()))
}

fn delete(folder: &Path, id: &str) -> Result<(), CommandError> {
    if !safe_id(id) {
        return Err(CommandError::new(
            "invalidBrand",
            "The brand profile has an invalid id.",
        ));
    }
    match fs::remove_dir_all(folder.join(id)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(CommandError::new("storage", error.to_string()))
        }
        _ => Ok(()),
    }
}

#[tauri::command(async)]
pub fn brands_list(app: AppHandle) -> Result<Vec<Value>, CommandError> {
    Ok(list(&brands_folder(&app)?))
}

/// The ids of the brands IT deploys (`BrandProfiles`: `.amlbrand` files on a share). They are
/// read-only: only the start-up sync (`brands_save_managed`) may write them, so an imported or
/// restored file with the same id can't replace one. A file that can't be read names no id.
fn managed_ids(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| fs::read(path).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|file| file.get("format").and_then(Value::as_str) == Some("amlbrand"))
        .filter_map(|file| {
            file.pointer("/profile/id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn profile_id(profile: &Value) -> &str {
    profile
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn managed_brand() -> CommandError {
    CommandError::new(
        "setByPolicy",
        "Your organisation manages this brand, so it can't be changed here.",
    )
}

#[tauri::command(async)]
pub fn brands_save(app: AppHandle, profile: Value) -> Result<(), CommandError> {
    if managed_ids(&crate::policy::current().brand_profiles)
        .iter()
        .any(|id| id.eq_ignore_ascii_case(profile_id(&profile)))
    {
        return Err(managed_brand());
    }
    save(&brands_folder(&app)?, &profile)
}

/// The start-up sync of the brands IT deploys: only their ids may be written this way.
#[tauri::command(async)]
pub fn brands_save_managed(app: AppHandle, profile: Value) -> Result<(), CommandError> {
    if !managed_ids(&crate::policy::current().brand_profiles)
        .iter()
        .any(|id| id == profile_id(&profile))
    {
        return Err(CommandError::new(
            "invalidBrand",
            "Only a brand your organisation deploys is saved this way.",
        ));
    }
    save(&brands_folder(&app)?, &profile)
}

#[tauri::command(async)]
pub fn brands_delete(app: AppHandle, id: String) -> Result<(), CommandError> {
    if managed_ids(&crate::policy::current().brand_profiles).contains(&id) {
        return Err(managed_brand());
    }
    delete(&brands_folder(&app)?, &id)
}

/// Brand files (`.amlbrand`) that people send each other. The UI checks what is inside with the
/// `packages/core` schema and treats it as coming from outside (SVG logos are converted, fonts
/// are checked); this side only refuses anything that isn't a `.amlbrand` of a sensible size.
const BRAND_FILE: crate::settings_file::DataFile = crate::settings_file::DataFile {
    extension: "amlbrand",
    max_bytes: 32 * 1024 * 1024,
    code: "notBrandFile",
    wrong_file: "Choose a Steps brand file (.amlbrand).",
};

#[tauri::command(async)]
pub fn brands_read_file(path: String) -> Result<String, CommandError> {
    crate::settings_file::read(&BRAND_FILE, &path)
}

#[tauri::command(async)]
pub fn brands_write_file(path: String, contents: String) -> Result<(), CommandError> {
    crate::settings_file::write(&BRAND_FILE, &path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profiles_are_saved_listed_by_name_and_deleted() {
        let folder = tempfile::tempdir().expect("temp dir");
        save(folder.path(), &json!({"id": "client-b", "name": "Beta"})).expect("save");
        save(folder.path(), &json!({"id": "client-a", "name": "alpha"})).expect("save");
        let names: Vec<_> = list(folder.path())
            .iter()
            .map(|profile| profile["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(names, ["alpha", "Beta"]);
        delete(folder.path(), "client-a").expect("delete");
        assert_eq!(list(folder.path()).len(), 1);
        delete(folder.path(), "client-a").expect("deleting twice is fine");
    }

    #[test]
    fn a_brand_differing_only_in_capitals_never_writes_over_another() {
        let folder = tempfile::tempdir().expect("temp dir");
        save(folder.path(), &json!({"id": "contoso", "name": "Contoso"})).expect("save");
        assert!(save(folder.path(), &json!({"id": "Contoso", "name": "Fake"})).is_err());
        assert_eq!(list(folder.path())[0]["name"], "Contoso");
        // Saving the same brand again is fine.
        save(
            folder.path(),
            &json!({"id": "contoso", "name": "Contoso 2"}),
        )
        .expect("save again");
    }

    #[test]
    fn the_ids_of_deployed_brands_come_from_their_files() {
        let folder = tempfile::tempdir().expect("temp");
        let brand = folder.path().join("acme.amlbrand");
        fs::write(
            &brand,
            json!({ "format": "amlbrand", "formatVersion": 1, "profile": { "id": "acme" } })
                .to_string(),
        )
        .expect("write");
        let other = folder.path().join("notes.amlbrand");
        fs::write(
            &other,
            json!({ "format": "other", "profile": { "id": "x" } }).to_string(),
        )
        .expect("write");
        let paths = [
            brand.to_string_lossy().into_owned(),
            other.to_string_lossy().into_owned(),
            folder
                .path()
                .join("missing.amlbrand")
                .to_string_lossy()
                .into_owned(),
        ];
        assert_eq!(managed_ids(&paths), vec!["acme".to_string()]);
        assert_eq!(profile_id(&json!({ "id": "acme" })), "acme");
    }

    #[test]
    fn unsafe_ids_and_huge_profiles_are_refused() {
        let folder = tempfile::tempdir().expect("temp dir");
        for id in ["../escape", "", "a/b", r"a\b"] {
            assert_eq!(
                save(folder.path(), &json!({"id": id})).unwrap_err().code(),
                "invalidBrand"
            );
        }
        assert_eq!(
            delete(folder.path(), "..").unwrap_err().code(),
            "invalidBrand"
        );
        let huge = "x".repeat(MAX_PROFILE_BYTES);
        assert_eq!(
            save(folder.path(), &json!({"id": "big", "logo": huge}))
                .unwrap_err()
                .code(),
            "tooLarge"
        );
        // A folder whose profile names another id is not listed.
        fs::create_dir_all(folder.path().join("copy")).expect("dir");
        fs::write(
            folder.path().join("copy/profile.json"),
            br#"{"id":"other"}"#,
        )
        .expect("write");
        assert!(list(folder.path()).is_empty());
    }
}
