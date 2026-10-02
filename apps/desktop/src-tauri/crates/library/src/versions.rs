//! Saved versions of a guide: `versions\<versionId>\` holds `version.json`, a copy of
//! `guide.json` and `steps\`. Media is shared with the guide rather than copied, which is safe
//! because images are never changed or deleted by editing.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{LibraryError, Result};
use crate::guides::{GuideDocument, Library, read_steps};
use crate::util::{
    checked, copy_files, is_safe_segment, new_id, now_iso, read_json, write_json_atomic,
    write_json_new,
};

const MAX_NOTE_CHARS: usize = 1000;

/// One saved version, as `version.json` records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    /// The version id (its folder name).
    pub id: String,
    /// When it was saved (ISO 8601).
    pub created_at: String,
    /// What the person said about it.
    pub note: String,
    /// Who saved it.
    pub created_by: String,
    /// How many steps it holds.
    pub step_count: usize,
}

impl Library {
    fn versions_dir(&self, guide_id: &str) -> Result<PathBuf> {
        Ok(self.guide_dir(guide_id)?.join("versions"))
    }

    fn version_dir(&self, guide_id: &str, version_id: &str) -> Result<PathBuf> {
        let folder = self
            .versions_dir(guide_id)?
            .join(checked(version_id, "version")?);
        if folder.join("version.json").is_file() {
            Ok(folder)
        } else {
            Err(LibraryError::VersionNotFound)
        }
    }

    /// Saves the guide as it is now as a new version.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for an over-long note, `Storage`.
    pub fn save_version(&self, guide_id: &str, note: &str, author: &str) -> Result<VersionInfo> {
        let note = note.trim();
        if note.chars().count() > MAX_NOTE_CHARS {
            return Err(LibraryError::Invalid(format!(
                "Enter a note of up to {MAX_NOTE_CHARS} characters."
            )));
        }
        let guide_folder = self.guide_dir(guide_id)?;
        let versions = guide_folder.join("versions");
        fs::create_dir_all(&versions)?;
        let info = VersionInfo {
            id: new_id(),
            created_at: now_iso(),
            note: note.to_string(),
            created_by: author.to_string(),
            step_count: crate::guides::step_count(&read_steps(&guide_folder.join("steps"))),
        };
        // Built beside the others under a dotted name and renamed, so a half-copied version is
        // never listed.
        let staging = versions.join(format!(".saving-{}", info.id));
        let built = (|| -> Result<()> {
            fs::create_dir_all(&staging)?;
            fs::copy(guide_folder.join("guide.json"), staging.join("guide.json"))?;
            copy_steps(&guide_folder.join("steps"), &staging.join("steps"))?;
            write_json_new(&staging.join("version.json"), &info)?;
            fs::rename(&staging, versions.join(&info.id))?;
            Ok(())
        })();
        if let Err(error) = built {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        Ok(info)
    }

    /// Every readable version of a guide, newest first.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn list_versions(&self, guide_id: &str) -> Result<Vec<VersionInfo>> {
        let entries = match fs::read_dir(self.versions_dir(guide_id)?) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut versions: Vec<VersionInfo> = entries
            .filter_map(std::result::Result::ok)
            .filter(|entry| is_safe_segment(&entry.file_name().to_string_lossy()))
            .filter_map(|entry| {
                let bytes = fs::read(entry.path().join("version.json")).ok()?;
                let info: VersionInfo = serde_json::from_slice(&bytes).ok()?;
                (info.id == entry.file_name().to_string_lossy()).then_some(info)
            })
            .collect();
        versions.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(versions)
    }

    /// Loads a saved version as a whole guide document.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `VersionNotFound`, `Storage`, `Json`.
    pub fn load_version(&self, guide_id: &str, version_id: &str) -> Result<GuideDocument> {
        let folder = self.version_dir(guide_id, version_id)?;
        Ok(GuideDocument {
            guide: read_json(&folder.join("guide.json"))?,
            steps: read_steps(&folder.join("steps")),
        })
    }

    /// Makes a saved version the current guide. The current state is saved first as a version
    /// called "Before restoring <date>", so a restore can itself be undone.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `VersionNotFound`, `NewerFormat`, `Storage`, `Json`.
    pub fn restore_version(
        &self,
        guide_id: &str,
        version_id: &str,
        author: &str,
    ) -> Result<GuideDocument> {
        let source = self.version_dir(guide_id, version_id)?;
        let mut guide = read_json(&source.join("guide.json"))?;
        crate::util::check_format_version(&guide, "version")?;
        let stamp = chrono::Local::now().format("%d/%m/%Y %H:%M");
        self.save_version(guide_id, &format!("Before restoring {stamp}"), author)?;

        // The guide keeps its identity (a version copied from elsewhere may carry another id)
        // and the restore counts as a change, so it rises to the top of the list.
        guide["id"] = Value::String(guide_id.to_string());
        guide["updatedAt"] = Value::String(now_iso());
        guide["updatedBy"] = Value::String(author.to_string());
        let folder = self.guide_dir(guide_id)?;
        replace_steps(&folder, &source.join("steps"))?;
        write_json_atomic(&folder.join("guide.json"), &guide)?;
        self.load_guide(guide_id)
    }
}

fn copy_steps(from: &Path, to: &Path) -> std::io::Result<()> {
    copy_files(from, to, &[".json"])
}

/// Swaps the guide's `steps\` for a copy of `from`: the copy is built first, the old folder
/// renamed aside, the new one renamed in, and the old one removed. If the swap fails part-way the
/// old steps are put back.
fn replace_steps(guide_folder: &Path, from: &Path) -> Result<()> {
    let unique = new_id();
    let incoming = guide_folder.join(format!(".steps-restoring-{unique}"));
    let outgoing = guide_folder.join(format!(".steps-replaced-{unique}"));
    let current = guide_folder.join("steps");
    if let Err(error) = copy_steps(from, &incoming) {
        let _ = fs::remove_dir_all(&incoming);
        return Err(error.into());
    }
    let had_steps = current.exists();
    if had_steps && let Err(error) = fs::rename(&current, &outgoing) {
        let _ = fs::remove_dir_all(&incoming);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&incoming, &current) {
        let _ = fs::remove_dir_all(&incoming);
        // Another writer can recreate steps\ between the two renames; then the old steps can't
        // go back and must not be lost in a hidden folder without anyone being told.
        if had_steps && let Err(rollback) = fs::rename(&outgoing, &current) {
            return Err(std::io::Error::other(format!(
                "the version couldn't be restored ({error}), and the steps it replaced couldn't \
                 be put back ({rollback}); they are in {}",
                outgoing.display()
            ))
            .into());
        }
        return Err(error.into());
    }
    let _ = fs::remove_dir_all(&outgoing);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guides::tests::{library, step};
    use serde_json::json;

    #[test]
    fn versions_save_list_load_and_restore() {
        let (_root, library) = library();
        let mut guide = library.create_guide("First title", "Ann").unwrap().guide;
        let id = guide["id"].as_str().unwrap().to_string();
        library
            .save_step(&id, &step("s1", "a0", Some("m1")))
            .unwrap();
        let first = library.save_version(&id, "  First draft ", "Ann").unwrap();
        assert_eq!(first.note, "First draft");
        assert_eq!(first.step_count, 1);
        assert_eq!(first.created_by, "Ann");

        guide["title"] = json!("Second title");
        library.save_guide(&id, &guide).unwrap();
        library.save_step(&id, &step("s2", "a1", None)).unwrap();
        let second = library.save_version(&id, "", "Bob").unwrap();
        let listed = library.list_versions(&id).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, second.id);
        assert_eq!(listed[1], first);

        let old = library.load_version(&id, &first.id).unwrap();
        assert_eq!(old.guide["title"], "First title");
        assert_eq!(old.steps.len(), 1);

        let restored = library.restore_version(&id, &first.id, "Cat").unwrap();
        assert_eq!(restored.guide["title"], "First title");
        assert_eq!(restored.guide["updatedBy"], "Cat");
        assert_eq!(restored.steps.len(), 1);
        let after = library.list_versions(&id).unwrap();
        assert_eq!(after.len(), 3);
        assert!(after[0].note.starts_with("Before restoring "));
        assert_eq!(after[0].step_count, 2);
        // The "before" version really holds the pre-restore state.
        let before = library.load_version(&id, &after[0].id).unwrap();
        assert_eq!(before.guide["title"], "Second title");
        assert_eq!(before.steps.len(), 2);
        // Nothing is left over from the swap.
        let leftovers = fs::read_dir(library.guides_dir().join(&id))
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn missing_or_unsafe_versions_are_refused() {
        let (_root, library) = library();
        let id = library.create_guide("G", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(library.list_versions(&id).unwrap().is_empty());
        assert!(matches!(
            library.load_version(&id, "nope"),
            Err(LibraryError::VersionNotFound)
        ));
        assert!(matches!(
            library.restore_version(&id, "..\\..", ""),
            Err(LibraryError::InvalidId("version"))
        ));
        assert!(matches!(
            library.save_version(&id, &"x".repeat(1001), ""),
            Err(LibraryError::Invalid(_))
        ));
        // A half-saved version (no version.json) is not listed.
        fs::create_dir_all(
            library
                .guides_dir()
                .join(&id)
                .join("versions")
                .join("partial"),
        )
        .unwrap();
        assert!(library.list_versions(&id).unwrap().is_empty());
    }
}
