//! Live refresh for shared libraries (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive).
//! A fingerprint of what's on disk, from file names, sizes and modified times only (no file is
//! opened), so the window can ask every few seconds and reload only when a synced change has
//! arrived. Polling rather than a change watcher: a sync client's writes into a placeholder folder
//! don't always raise change notifications, and a fingerprint can't miss one.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::Result;
use crate::guides::Library;

/// Adds one file or folder entry to the fingerprint: its name, size and modified time.
fn add_entry(hasher: &mut DefaultHasher, path: &Path) {
    path.file_name().hash(hasher);
    if let Ok(meta) = fs::metadata(path) {
        meta.len().hash(hasher);
        meta.is_dir().hash(hasher);
        if let Ok(modified) = meta.modified() {
            modified
                .duration_since(UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or_default()
                .hash(hasher);
        }
    }
}

/// Adds every entry directly in `folder`, in name order.
fn add_folder(hasher: &mut DefaultHasher, folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        0u8.hash(hasher);
        return;
    };
    let mut paths: Vec<_> = entries
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .collect();
    paths.sort();
    for path in paths {
        add_entry(hasher, &path);
    }
}

/// The parts of a guide whose change the window shows: every file directly in its folder
/// (`guide.json`, `.lock`, a sync client's `guide-PC.json` conflict copy) and its steps,
/// comments, drafts and delete notes. Screenshots are new files named by content, so a changed
/// step names them already.
fn add_guide(hasher: &mut DefaultHasher, folder: &Path) {
    add_folder(hasher, folder);
    for sub in ["steps", "comments", "drafts", "deleted"] {
        add_folder(hasher, &folder.join(sub));
    }
}

impl Library {
    /// A fingerprint of every guide: different whenever a guide is added, removed or changed.
    ///
    /// # Errors
    /// `Storage` if the `guides` folder can't be read.
    pub fn fingerprint(&self) -> Result<String> {
        let mut hasher = DefaultHasher::new();
        let mut folders: Vec<_> = fs::read_dir(self.guides_dir())?
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| entry.path())
            .collect();
        folders.sort();
        for folder in folders {
            folder.file_name().hash(&mut hasher);
            add_guide(&mut hasher, &folder);
        }
        Ok(format!("{:016x}", hasher.finish()))
    }

    /// A fingerprint of one guide.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn guide_fingerprint(&self, guide_id: &str) -> Result<String> {
        let mut hasher = DefaultHasher::new();
        add_guide(&mut hasher, &self.guide_dir(guide_id)?);
        Ok(format!("{:016x}", hasher.finish()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_change_anywhere_in_a_guide_changes_its_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let doc = library.create_guide("Guide", "Robin").unwrap();
        let id = doc.guide["id"].as_str().unwrap().to_string();
        let whole = library.fingerprint().unwrap();
        let one = library.guide_fingerprint(&id).unwrap();
        // Asking again without a change gives the same answer.
        assert_eq!(library.fingerprint().unwrap(), whole);
        assert_eq!(library.guide_fingerprint(&id).unwrap(), one);

        let step = json!({ "id": "s1", "formatVersion": 1 });
        library.save_step(&id, &step).unwrap();
        let after_step = library.guide_fingerprint(&id).unwrap();
        assert_ne!(after_step, one);
        assert_ne!(library.fingerprint().unwrap(), whole);

        fs::create_dir_all(dir.path().join("guides").join(&id).join("comments")).unwrap();
        fs::write(
            dir.path()
                .join("guides")
                .join(&id)
                .join("comments")
                .join("c1.json"),
            b"{}",
        )
        .unwrap();
        let after_comment = library.guide_fingerprint(&id).unwrap();
        assert_ne!(after_comment, after_step);

        // A sync client's conflict copy of guide.json counts too.
        fs::write(
            dir.path().join("guides").join(&id).join("guide-PC-2.json"),
            b"{}",
        )
        .unwrap();
        assert_ne!(library.guide_fingerprint(&id).unwrap(), after_comment);

        let before_new = library.fingerprint().unwrap();
        library.create_guide("Another", "Sam").unwrap();
        assert_ne!(library.fingerprint().unwrap(), before_new);
    }
}
