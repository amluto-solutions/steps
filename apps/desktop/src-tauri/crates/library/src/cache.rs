//! In-memory copies of what the library list and search take from each guide, so a refresh or a
//! search doesn't re-read every step file each time (in a synced folder with files kept online
//! only, reading a file downloads it). A copy is used only while the guide's files
//! still have the sizes and times they had when it was made; listing a folder gives those without
//! opening, or downloading, any file.

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

/// Past this many guides the cache starts again rather than grow without end.
const MAX_ENTRIES: usize = 20_000;

/// What a guide folder's files look like from the outside: `guide.json` and every step and
/// comment file's name, size and modified time. Any write through the app (always a new file renamed into
/// place) or a sync client changes it. `None` when `guide.json` can't be seen.
pub(crate) fn fingerprint(folder: &Path) -> Option<u64> {
    let mut hasher = DefaultHasher::new();
    let guide = fs::metadata(folder.join("guide.json")).ok()?;
    (guide.len(), guide.modified().ok()).hash(&mut hasher);
    for sub in ["steps", "comments"] {
        let Ok(entries) = fs::read_dir(folder.join(sub)) else {
            sub.hash(&mut hasher);
            continue;
        };
        let mut files: Vec<(String, u64, Option<SystemTime>)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                Some((
                    entry.file_name().to_string_lossy().into_owned(),
                    metadata.len(),
                    metadata.modified().ok(),
                ))
            })
            .collect();
        files.sort();
        files.hash(&mut hasher);
    }
    Some(hasher.finish())
}

/// Each guide folder's copy, with the fingerprint it was made at.
type Entries<T> = HashMap<PathBuf, (u64, Arc<T>)>;

/// One kind of per-guide copy, keyed by the guide's folder.
pub(crate) struct GuideCache<T> {
    entries: Mutex<Option<Entries<T>>>,
}

impl<T> GuideCache<T> {
    pub(crate) const fn new() -> Self {
        Self {
            entries: Mutex::new(None),
        }
    }

    /// The copy for `folder`, made with `read` when there is none or the files have changed.
    /// The fingerprint is taken before reading, so a write during the read makes the next call
    /// read again rather than keep a half-old copy.
    pub(crate) fn get<E>(
        &self,
        folder: &Path,
        read: impl FnOnce() -> Result<T, E>,
    ) -> Result<Arc<T>, E> {
        let Some(print) = fingerprint(folder) else {
            return read().map(Arc::new);
        };
        if let Some(found) = self
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .and_then(|entries| entries.get(folder))
            .filter(|(cached, _)| *cached == print)
            .map(|(_, value)| Arc::clone(value))
        {
            return Ok(found);
        }
        let value = Arc::new(read()?);
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let entries = entries.get_or_insert_with(HashMap::new);
        if entries.len() >= MAX_ENTRIES {
            entries.clear();
        }
        entries.insert(folder.to_path_buf(), (print, Arc::clone(&value)));
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_is_reused_until_a_step_file_changes() {
        let folder = tempfile::tempdir().unwrap();
        fs::create_dir_all(folder.path().join("steps")).unwrap();
        fs::write(folder.path().join("guide.json"), b"{}").unwrap();
        fs::write(folder.path().join("steps/a.json"), b"{}").unwrap();
        let cache = GuideCache::new();
        let mut reads = 0;
        let mut read = || -> Result<u32, ()> {
            reads += 1;
            Ok(reads)
        };
        assert_eq!(*cache.get(folder.path(), &mut read).unwrap(), 1);
        assert_eq!(*cache.get(folder.path(), &mut read).unwrap(), 1);
        // A new step file (as a save renames one into place) means reading again.
        fs::write(folder.path().join("steps/b.json"), b"{}").unwrap();
        assert_eq!(*cache.get(folder.path(), &mut read).unwrap(), 2);
        // A step file rewritten with other contents too.
        fs::write(folder.path().join("steps/a.json"), b"{\"x\":1}").unwrap();
        assert_eq!(*cache.get(folder.path(), &mut read).unwrap(), 3);
        // Nothing is kept for a folder without guide.json.
        fs::remove_file(folder.path().join("guide.json")).unwrap();
        assert_eq!(*cache.get(folder.path(), &mut read).unwrap(), 4);
        assert_eq!(*cache.get(folder.path(), &mut read).unwrap(), 5);
    }
}
