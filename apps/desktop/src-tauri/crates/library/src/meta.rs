//! A guide's password lock and history (docs/spec/03-data-and-sharing.md#password-locks,
//! 04/10/2026): `password-lock.json` and `history.json` beside `guide.json`.
//!
//! The library only keeps the two files: checking a password and deciding what a lock allows is
//! the app's (`packages/core/src/guide-lock.ts`, `packages/ui/src/library/guide-locks.ts`), the
//! same for the desktop and the browser extension. Neither file is copied with the guide
//! (Duplicate, Copy to, Merge, `.amlsteps`): a copy is a new, unlocked guide. A move takes both,
//! and the Bin takes the lock off.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::error::{LibraryError, Result};
use crate::guides::Library;
use crate::util::{check_size, write_json_atomic};

pub(crate) const LOCK_FILE: &str = "password-lock.json";
pub(crate) const HISTORY_FILE: &str = "history.json";

/// Real lock and history files are a few kilobytes; anything far larger isn't one.
const MAX_META_FILE: u64 = 256 * 1024;

/// A guide's lock and history files as stored, unparsed (`null` where there's none).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GuideMeta {
    pub lock: Value,
    pub history: Value,
}

/// Who locked a guide and when, for its card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LockedBy {
    pub by: String,
    pub at: String,
}

/// Pictures and bytes on disk, for Properties.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GuideStats {
    pub pictures: usize,
    pub bytes: u64,
}

fn read_meta_file(path: &Path) -> Value {
    if check_size(path, MAX_META_FILE).is_err() {
        return Value::Null;
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

/// Who locked the guide in `folder`, if it is locked.
pub(crate) fn locked_by(folder: &Path) -> Option<LockedBy> {
    let lock = read_meta_file(&folder.join(LOCK_FILE));
    let locked = lock.get("locked")?;
    let text = |field: &str| {
        locked
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    Some(LockedBy {
        by: text("by")?,
        at: text("at").unwrap_or_default(),
    })
}

fn folder_bytes(folder: &Path) -> u64 {
    fs::read_dir(folder).map_or(0, |entries| {
        entries
            .filter_map(std::result::Result::ok)
            .map(|entry| match entry.file_type() {
                Ok(kind) if kind.is_dir() => folder_bytes(&entry.path()),
                Ok(_) => entry.metadata().map_or(0, |metadata| metadata.len()),
                Err(_) => 0,
            })
            .sum()
    })
}

impl Library {
    /// The guide's lock and history files.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn guide_meta(&self, guide_id: &str) -> Result<GuideMeta> {
        let folder = self.guide_dir(guide_id)?;
        Ok(GuideMeta {
            lock: read_meta_file(&folder.join(LOCK_FILE)),
            history: read_meta_file(&folder.join(HISTORY_FILE)),
        })
    }

    /// Writes the guide's lock, or removes it (`None`).
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for something that isn't a lock, `Storage`.
    pub fn write_guide_lock(&self, guide_id: &str, lock: Option<&Value>) -> Result<()> {
        let path = self.guide_dir(guide_id)?.join(LOCK_FILE);
        match lock {
            Some(lock) => {
                if !lock.is_object() || lock.get("password").and_then(Value::as_str).is_none() {
                    return Err(LibraryError::Invalid("That isn't a guide lock.".into()));
                }
                write_json_atomic(&path, lock)
            }
            None => match fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            },
        }
    }

    /// Writes the guide's history.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for something that isn't one, `Storage`.
    pub fn write_guide_history(&self, guide_id: &str, history: &Value) -> Result<()> {
        if !history.is_object() {
            return Err(LibraryError::Invalid("That isn't a guide history.".into()));
        }
        let path = self.guide_dir(guide_id)?.join(HISTORY_FILE);
        write_json_atomic(&path, history)
    }

    /// How many pictures the guide has, and what its folder takes on disk.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn guide_stats(&self, guide_id: &str) -> Result<GuideStats> {
        let folder = self.guide_dir(guide_id)?;
        let pictures = fs::read_dir(folder.join("media")).map_or(0, |entries| {
            entries
                .filter_map(std::result::Result::ok)
                .filter(|entry| {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    let path = Path::new(&name);
                    path.extension()
                        .is_some_and(|extension| extension == "webp")
                        && !path
                            .file_stem()
                            .is_some_and(|stem| stem.to_string_lossy().ends_with(".thumb"))
                })
                .count()
        });
        Ok(GuideStats {
            pictures,
            bytes: folder_bytes(&folder),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lock() -> Value {
        json!({
            "formatVersion": 1,
            "locked": { "by": "Robin Hale", "login": "robin", "pc": "PC-1", "at": "2026-10-04T10:00:00Z" },
            "password": "pbkdf2-sha256$1000$AAAA$AAAA"
        })
    }

    #[test]
    fn a_lock_shows_on_the_card_and_stays_with_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let id = library.create_guide("Locked", "Robin").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(library.summary(&id).unwrap().locked.is_none());
        library.write_guide_lock(&id, Some(&lock())).unwrap();
        library
            .write_guide_history(&id, &json!({ "formatVersion": 1, "saves": 3 }))
            .unwrap();
        let locked = library.summary(&id).unwrap().locked.unwrap();
        assert_eq!(
            (locked.by.as_str(), locked.at.as_str()),
            ("Robin Hale", "2026-10-04T10:00:00Z")
        );
        assert_eq!(library.guide_meta(&id).unwrap().history["saves"], 3);

        // Copies are new, unlocked guides with no history.
        let copy = library.duplicate_guide(&id, "Copy").unwrap();
        assert!(copy.locked.is_none());
        assert_eq!(library.guide_meta(&copy.id).unwrap().history, Value::Null);

        // A move takes both.
        let other = tempfile::tempdir().unwrap();
        let target = Library::new(other.path());
        let moved = library.move_guide_to(&id, &target).unwrap();
        assert!(moved.locked.is_some());
        assert_eq!(target.guide_meta(&moved.id).unwrap().history["saves"], 3);

        // The Bin takes the lock off, and a guide restored from it is unlocked.
        let entry = target.trash_guide(&moved.id).unwrap();
        let restored = target.restore_guide(&entry.trash_id).unwrap();
        assert!(restored.locked.is_none());
        assert_eq!(target.guide_meta(&moved.id).unwrap().history["saves"], 3);

        target.write_guide_lock(&moved.id, Some(&lock())).unwrap();
        target.write_guide_lock(&moved.id, None).unwrap();
        target.write_guide_lock(&moved.id, None).unwrap();
        assert!(target.summary(&moved.id).unwrap().locked.is_none());
        assert!(
            target
                .write_guide_lock(&moved.id, Some(&json!("x")))
                .is_err()
        );
    }

    #[test]
    fn counts_pictures_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let id = library.create_guide("Stats", "Robin").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let media = dir.path().join("guides").join(&id).join("media");
        fs::create_dir_all(&media).unwrap();
        fs::write(media.join("a.webp"), [0_u8; 100]).unwrap();
        fs::write(media.join("b.webp"), [0_u8; 50]).unwrap();
        let stats = library.guide_stats(&id).unwrap();
        assert_eq!(stats.pictures, 2);
        assert!(stats.bytes >= 150);
    }
}
