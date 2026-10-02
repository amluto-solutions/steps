//! The list of libraries this PC knows about: `%APPDATA%\Amluto\Steps\libraries.json`.
//!
//! The registry only records where libraries are. Removing one from the list never touches its
//! folder, and the default library (where new recordings go) can't be removed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{LibraryError, Result};
use crate::util::{is_safe_segment, new_id, unix_millis, write_json_atomic, write_new};

/// The registry file's name inside the app-data folder.
pub const REGISTRY_FILE: &str = "libraries.json";
/// The name given to the library created on first run.
pub const FIRST_LIBRARY_NAME: &str = "My guides";
const MAX_NAME_CHARS: usize = 120;

/// One registered library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    /// Stable id: the folder's own `.amluto-library.json` id when that is usable.
    pub id: String,
    /// The name shown in the app.
    pub name: String,
    /// The library folder.
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    format_version: u32,
    default_id: String,
    libraries: Vec<LibraryEntry>,
}

/// The loaded registry. Every change is written to disk before it is kept in memory, so a
/// failed save never leaves the app believing something the file doesn't say.
#[derive(Debug, Clone)]
pub struct Registry {
    file: PathBuf,
    default_id: String,
    libraries: Vec<LibraryEntry>,
}

impl Registry {
    /// Loads the registry from `app_data`, or creates it with one library named "My guides" at
    /// `first_library` (the recorder's current folder). A damaged registry file is kept beside
    /// the new one as `libraries.json.damaged-<time>` rather than overwritten, so a person can
    /// still recover their list by hand.
    ///
    /// # Errors
    /// `NewerFormat` for a registry written by a newer app; `Storage` if folders can't be made.
    pub fn open_or_seed(app_data: &Path, first_library: &Path) -> Result<Self> {
        fs::create_dir_all(app_data)?;
        let file = app_data.join(REGISTRY_FILE);
        match fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<RegistryFile>(&bytes) {
                Ok(saved) if saved.format_version > 1 => Err(LibraryError::NewerFormat),
                Ok(saved)
                    if saved
                        .libraries
                        .iter()
                        .any(|entry| entry.id == saved.default_id) =>
                {
                    Ok(Self {
                        file,
                        default_id: saved.default_id,
                        libraries: saved.libraries,
                    })
                }
                _ => {
                    fs::rename(
                        &file,
                        app_data.join(format!("{REGISTRY_FILE}.damaged-{}", unix_millis())),
                    )?;
                    Self::seed(file, first_library)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Self::seed(file, first_library)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn seed(file: PathBuf, first_library: &Path) -> Result<Self> {
        let id = prepare_library_folder(first_library, FIRST_LIBRARY_NAME)?;
        let registry = Self {
            file,
            default_id: id.clone(),
            libraries: vec![LibraryEntry {
                id,
                name: FIRST_LIBRARY_NAME.to_string(),
                path: first_library.to_path_buf(),
            }],
        };
        registry.save()?;
        Ok(registry)
    }

    /// Every registered library, in the order they were added.
    #[must_use]
    pub fn libraries(&self) -> &[LibraryEntry] {
        &self.libraries
    }

    /// The id of the library new recordings go to.
    #[must_use]
    pub fn default_id(&self) -> &str {
        &self.default_id
    }

    /// Finds a library by id.
    ///
    /// # Errors
    /// `InvalidId` or `LibraryNotFound`.
    pub fn get(&self, id: &str) -> Result<&LibraryEntry> {
        if !is_safe_segment(id) {
            return Err(LibraryError::InvalidId("library"));
        }
        self.libraries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or(LibraryError::LibraryNotFound)
    }

    /// Registers `path` as a library called `name`, creating its folder structure.
    ///
    /// # Errors
    /// `Invalid` for a bad name or a path that isn't absolute and local, `LibraryExists` for a
    /// folder already registered, `Storage` if the folder can't be created.
    pub fn add(&mut self, name: &str, path: &Path) -> Result<LibraryEntry> {
        let name = validate_name(name)?;
        validate_library_path(path)?;
        if self
            .libraries
            .iter()
            .any(|entry| same_folder(&entry.path, path))
        {
            return Err(LibraryError::LibraryExists);
        }
        let folder_id = prepare_library_folder(path, &name)?;
        // A copied library folder carries the same id as its original; the copy gets its own
        // id here so the two can't be confused.
        let id = if self.libraries.iter().any(|entry| entry.id == folder_id) {
            new_id()
        } else {
            folder_id
        };
        let entry = LibraryEntry {
            id,
            name,
            path: path.to_path_buf(),
        };
        let mut next = self.clone();
        next.libraries.push(entry.clone());
        next.save()?;
        *self = next;
        Ok(entry)
    }

    /// Renames a library in this PC's list. The folder itself is not renamed.
    ///
    /// # Errors
    /// `InvalidId`, `LibraryNotFound`, `Invalid` for a bad name, `Storage`.
    pub fn rename(&mut self, id: &str, name: &str) -> Result<LibraryEntry> {
        let name = validate_name(name)?;
        self.get(id)?;
        let mut next = self.clone();
        let mut renamed = None;
        for entry in &mut next.libraries {
            if entry.id == id {
                entry.name.clone_from(&name);
                renamed = Some(entry.clone());
            }
        }
        let renamed = renamed.ok_or(LibraryError::LibraryNotFound)?;
        next.save()?;
        *self = next;
        Ok(renamed)
    }

    /// Takes a library off the list. Its folder and guides are left exactly as they are.
    ///
    /// # Errors
    /// `DefaultLibrary` for the default library, `InvalidId`, `LibraryNotFound`, `Storage`.
    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.get(id)?;
        if id == self.default_id {
            return Err(LibraryError::DefaultLibrary);
        }
        let mut next = self.clone();
        next.libraries.retain(|entry| entry.id != id);
        next.save()?;
        *self = next;
        Ok(())
    }

    /// Makes `id` the default library. The caller points the recorder at it too.
    ///
    /// # Errors
    /// `InvalidId`, `LibraryNotFound`, `Storage` (also if the folder can't be prepared, e.g. a
    /// disconnected drive).
    pub fn set_default(&mut self, id: &str) -> Result<LibraryEntry> {
        let entry = self.get(id)?.clone();
        prepare_library_folder(&entry.path, &entry.name)?;
        let mut next = self.clone();
        next.default_id.clone_from(&entry.id);
        next.save()?;
        *self = next;
        Ok(entry)
    }

    fn save(&self) -> Result<()> {
        write_json_atomic(
            &self.file,
            &RegistryFile {
                format_version: 1,
                default_id: self.default_id.clone(),
                libraries: self.libraries.clone(),
            },
        )
    }
}

fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(LibraryError::Invalid(format!(
            "Enter a library name of 1 to {MAX_NAME_CHARS} characters."
        )));
    }
    Ok(name.to_string())
}

/// Libraries live on a local drive letter (`C:\…`). Shared libraries are synced folders on such a
/// drive; a UNC share or relative path is refused, as for the recorder's folder.
#[cfg(windows)]
fn on_this_computer(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
}

/// Linux: any absolute folder outside the kernel's own (`/dev`, `/proc`, `/sys`).
#[cfg(not(windows))]
fn on_this_computer(path: &Path) -> bool {
    !["/dev", "/proc", "/sys"]
        .iter()
        .any(|root| path.starts_with(root))
}

fn validate_library_path(path: &Path) -> Result<()> {
    if on_this_computer(path) && path.is_absolute() {
        Ok(())
    } else {
        Err(LibraryError::Invalid(
            "Choose a folder on this PC (an absolute path such as C:\\Users\\you\\Documents\\Guides)."
                .to_string(),
        ))
    }
}

/// Two paths name the same folder: compared resolved when both exist, else by text ignoring
/// trailing separators, and on Windows case too (its paths are case-insensitive; Linux's aren't).
fn same_folder(left: &Path, right: &Path) -> bool {
    if let (Ok(left), Ok(right)) = (fs::canonicalize(left), fs::canonicalize(right)) {
        return left == right;
    }
    let normalise = |path: &Path| {
        let text = path.to_string_lossy();
        let text = text.trim_end_matches(['\\', '/']);
        if cfg!(windows) {
            text.replace('/', "\\").to_lowercase()
        } else {
            text.to_string()
        }
    };
    normalise(left) == normalise(right)
}

/// Creates `guides\` and `.amluto-library.json` if missing and returns the folder's id. An
/// existing marker is left alone (a shared library's marker belongs to everyone who uses it).
///
/// # Errors
/// `Storage` if the folder or marker can't be written.
pub fn prepare_library_folder(folder: &Path, name: &str) -> Result<String> {
    fs::create_dir_all(folder.join("guides"))?;
    let marker = folder.join(".amluto-library.json");
    if let Ok(bytes) = fs::read(&marker)
        && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && let Some(id) = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|id| is_safe_segment(id))
    {
        return Ok(id.to_string());
    }
    let id = new_id();
    let bytes = serde_json::to_vec_pretty(&json!({ "id": id, "name": name, "formatVersion": 1 }))?;
    match write_new(&marker, &bytes) {
        Ok(()) => Ok(id),
        // A damaged marker (or one with an unusable id) stays as it is; this PC uses its own
        // id for the library rather than rewriting a file other people may share.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(id),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let app_data = root.path().join("app");
        let first = root.path().join("Documents").join("Steps");
        (root, app_data, first)
    }

    #[test]
    fn first_run_seeds_my_guides_at_the_recorder_folder() {
        let (_root, app_data, first) = setup();
        let registry = Registry::open_or_seed(&app_data, &first).unwrap();
        assert_eq!(registry.libraries().len(), 1);
        let entry = &registry.libraries()[0];
        assert_eq!(entry.name, "My guides");
        assert_eq!(entry.path, first);
        assert_eq!(registry.default_id(), entry.id);
        assert!(first.join("guides").is_dir());
        assert!(first.join(".amluto-library.json").is_file());
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(app_data.join(REGISTRY_FILE)).unwrap()).unwrap();
        assert_eq!(saved["formatVersion"], 1);
        assert_eq!(saved["defaultId"], entry.id.as_str());
        assert_eq!(saved["libraries"][0]["name"], "My guides");
    }

    #[test]
    fn the_registry_survives_a_restart() {
        let (root, app_data, first) = setup();
        let mut registry = Registry::open_or_seed(&app_data, &first).unwrap();
        let added = registry
            .add("Team", &root.path().join("Team library"))
            .unwrap();
        registry.set_default(&added.id).unwrap();
        let reopened = Registry::open_or_seed(&app_data, &first).unwrap();
        assert_eq!(reopened.libraries().len(), 2);
        assert_eq!(reopened.default_id(), added.id);
    }

    #[test]
    fn an_existing_library_keeps_its_folder_id() {
        let (root, app_data, first) = setup();
        let shared = root.path().join("Shared");
        let existing = prepare_library_folder(&shared, "Shared").unwrap();
        let mut registry = Registry::open_or_seed(&app_data, &first).unwrap();
        assert_eq!(registry.add("Shared", &shared).unwrap().id, existing);
    }

    #[test]
    fn a_folder_already_registered_is_refused_whatever_its_case() {
        let (root, app_data, first) = setup();
        let mut registry = Registry::open_or_seed(&app_data, &first).unwrap();
        // The same folder in other letters is the same folder on Windows, not on Linux.
        #[cfg(windows)]
        {
            let upper = PathBuf::from(first.to_string_lossy().to_uppercase());
            assert!(matches!(
                registry.add("Again", &upper),
                Err(LibraryError::LibraryExists)
            ));
        }
        assert!(matches!(
            registry.add("Again", &first),
            Err(LibraryError::LibraryExists)
        ));
        assert!(matches!(
            registry.add("Relative", Path::new("relative\\folder")),
            Err(LibraryError::Invalid(_))
        ));
        assert!(matches!(
            registry.add("Share", Path::new("\\\\server\\share\\guides")),
            Err(LibraryError::Invalid(_))
        ));
        assert!(matches!(
            registry.add("  ", &root.path().join("x")),
            Err(LibraryError::Invalid(_))
        ));
    }

    #[test]
    fn removing_never_deletes_files_and_the_default_stays() {
        let (root, app_data, first) = setup();
        let mut registry = Registry::open_or_seed(&app_data, &first).unwrap();
        let default_id = registry.default_id().to_string();
        assert!(matches!(
            registry.remove(&default_id),
            Err(LibraryError::DefaultLibrary)
        ));
        let other = root.path().join("Other");
        let added = registry.add("Other", &other).unwrap();
        fs::write(other.join("guides").join("keep.txt"), b"keep").unwrap();
        registry.remove(&added.id).unwrap();
        assert!(other.join("guides").join("keep.txt").is_file());
        assert_eq!(registry.libraries().len(), 1);
        assert!(matches!(
            registry.get(&added.id),
            Err(LibraryError::LibraryNotFound)
        ));
    }

    #[test]
    fn rename_changes_only_the_listed_name() {
        let (_root, app_data, first) = setup();
        let mut registry = Registry::open_or_seed(&app_data, &first).unwrap();
        let id = registry.default_id().to_string();
        let renamed = registry.rename(&id, "  Finance guides ").unwrap();
        assert_eq!(renamed.name, "Finance guides");
        assert_eq!(renamed.path, first);
        assert!(matches!(
            registry.rename("../x", "Name"),
            Err(LibraryError::InvalidId(_))
        ));
    }

    #[test]
    fn a_damaged_registry_is_kept_aside_and_reseeded() {
        let (_root, app_data, first) = setup();
        fs::create_dir_all(&app_data).unwrap();
        fs::write(app_data.join(REGISTRY_FILE), b"{ not json").unwrap();
        let registry = Registry::open_or_seed(&app_data, &first).unwrap();
        assert_eq!(registry.libraries().len(), 1);
        let kept = fs::read_dir(&app_data)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".damaged-"));
        assert!(kept);
    }

    #[test]
    fn a_newer_registry_is_not_overwritten() {
        let (_root, app_data, first) = setup();
        fs::create_dir_all(&app_data).unwrap();
        let newer = br#"{"formatVersion":2,"defaultId":"a","libraries":[{"id":"a","name":"A","path":"C:\\A"}]}"#;
        fs::write(app_data.join(REGISTRY_FILE), newer).unwrap();
        assert!(matches!(
            Registry::open_or_seed(&app_data, &first),
            Err(LibraryError::NewerFormat)
        ));
        assert_eq!(fs::read(app_data.join(REGISTRY_FILE)).unwrap(), newer);
    }
}
