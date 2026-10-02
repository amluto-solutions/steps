//! Advisory edit locks for guides in shared libraries (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive).
//!
//! A guide being edited has a `.lock` file in its folder: who, on which PC, a random session id,
//! and a counter the editing app raises every minute. It is advisory: a sync client can be minutes
//! behind, so two people can both believe they hold it. Nothing here compares clocks. Whether a
//! lock has gone stale is decided by the app watching its counter stop moving (see the app's
//! `locks.rs`); this module only reads and writes the file.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::guides::Library;
use crate::util::{now_iso, write_atomic};

const LOCK_FILE: &str = ".lock";

/// Who is editing a guide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditLock {
    /// The editor's name from Settings.
    pub name: String,
    /// The PC they're on.
    pub pc: String,
    /// A random id for this editing session: another window on the same PC is someone else.
    pub session: String,
    /// Raised every minute while the guide is open for editing.
    pub counter: u64,
    /// When editing started (ISO 8601), shown as "since 10:32" and never used for staleness.
    pub since: String,
}

/// Who is opening a guide to edit it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockHolder {
    pub name: String,
    pub pc: String,
    pub session: String,
}

/// What opening a guide to edit found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LockOutcome {
    /// This session holds the lock now.
    Mine { lock: EditLock },
    /// Someone else does: the guide opens read-only.
    Theirs { lock: EditLock },
}

/// What a heartbeat found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Heartbeat {
    /// Still ours; the counter was raised.
    Held { counter: u64 },
    /// Someone took over editing: this session must stop writing and keep its unsaved edits as a
    /// draft.
    Displaced { lock: EditLock },
}

impl Library {
    /// The guide's `.lock` file (it may not exist).
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn lock_path(&self, guide_id: &str) -> Result<std::path::PathBuf> {
        Ok(self.guide_dir(guide_id)?.join(LOCK_FILE))
    }

    /// The guide's lock, or `None` when nobody is editing it (or the file is unreadable, which a
    /// half-synced file can be: it's then treated as absent and written again).
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn read_lock(&self, guide_id: &str) -> Result<Option<EditLock>> {
        Ok(read(&self.lock_path(guide_id)?))
    }

    /// Opens the guide for editing. The lock is taken when nobody holds it or this session
    /// already does; `take_over` takes it from someone else (after the person confirmed, or when
    /// the app has seen their lock go stale). Otherwise the guide is theirs.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn open_for_editing(
        &self,
        guide_id: &str,
        holder: &LockHolder,
        take_over: bool,
    ) -> Result<LockOutcome> {
        let path = self.lock_path(guide_id)?;
        match read(&path) {
            Some(lock) if lock.session != holder.session && !take_over => {
                Ok(LockOutcome::Theirs { lock })
            }
            Some(lock) if lock.session == holder.session => Ok(LockOutcome::Mine { lock }),
            _ => {
                let lock = EditLock {
                    name: holder.name.clone(),
                    pc: holder.pc.clone(),
                    session: holder.session.clone(),
                    counter: 0,
                    since: now_iso(),
                };
                write(&path, &lock)?;
                Ok(LockOutcome::Mine { lock })
            }
        }
    }

    /// Raises the counter of this session's lock. A lock that has gone (deleted by a sync client,
    /// say) is written again; one with another session in it means someone took over.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn heartbeat(&self, guide_id: &str, holder: &LockHolder) -> Result<Heartbeat> {
        let path = self.lock_path(guide_id)?;
        match read(&path) {
            Some(lock) if lock.session != holder.session => Ok(Heartbeat::Displaced { lock }),
            found => {
                let lock = found.map_or_else(
                    || EditLock {
                        name: holder.name.clone(),
                        pc: holder.pc.clone(),
                        session: holder.session.clone(),
                        counter: 0,
                        since: now_iso(),
                    },
                    |lock| EditLock {
                        counter: lock.counter.wrapping_add(1),
                        ..lock
                    },
                );
                write(&path, &lock)?;
                Ok(Heartbeat::Held {
                    counter: lock.counter,
                })
            }
        }
    }

    /// Lets go of the lock when the editor closes. Someone else's lock is left alone.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn release_lock(&self, guide_id: &str, session: &str) -> Result<()> {
        let path = self.lock_path(guide_id)?;
        if read(&path).is_some_and(|lock| lock.session == session) {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// Whether this session may write the guide: it holds the lock, or nobody does. Saves check
    /// this, so a displaced editor's app can't overwrite the new editor's work.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn may_write(&self, guide_id: &str, session: &str) -> Result<bool> {
        Ok(self
            .read_lock(guide_id)?
            .is_none_or(|lock| lock.session == session))
    }
}

fn read(path: &Path) -> Option<EditLock> {
    // A lock is a few hundred bytes; anything far bigger in a shared folder isn't one.
    crate::util::check_size(path, 64 * 1024).ok()?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write(path: &Path, lock: &EditLock) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(lock)?;
    write_atomic(path, &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holder(session: &str) -> LockHolder {
        LockHolder {
            name: format!("Person {session}"),
            pc: format!("PC-{session}"),
            session: session.to_string(),
        }
    }

    fn library_with_guide() -> (tempfile::TempDir, Library, String) {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let guide = library.create_guide("Shared guide", "Robin").unwrap();
        let id = guide.guide["id"].as_str().unwrap().to_string();
        (dir, library, id)
    }

    #[test]
    fn the_first_to_open_edits_and_everyone_else_reads() {
        let (_dir, library, id) = library_with_guide();
        let a = holder("a");
        let b = holder("b");
        assert!(matches!(
            library.open_for_editing(&id, &a, false).unwrap(),
            LockOutcome::Mine { .. }
        ));
        match library.open_for_editing(&id, &b, false).unwrap() {
            LockOutcome::Theirs { lock } => assert_eq!(lock.name, "Person a"),
            other @ LockOutcome::Mine { .. } => panic!("expected theirs, got {other:?}"),
        }
        // Opening again in the same session keeps the lock.
        assert!(matches!(
            library.open_for_editing(&id, &a, false).unwrap(),
            LockOutcome::Mine { .. }
        ));
        assert!(library.may_write(&id, "a").unwrap());
        assert!(!library.may_write(&id, "b").unwrap());
    }

    #[test]
    fn the_counter_rises_and_a_takeover_displaces_the_editor() {
        let (_dir, library, id) = library_with_guide();
        let a = holder("a");
        let b = holder("b");
        library.open_for_editing(&id, &a, false).unwrap();
        assert_eq!(
            library.heartbeat(&id, &a).unwrap(),
            Heartbeat::Held { counter: 1 }
        );
        assert_eq!(
            library.heartbeat(&id, &a).unwrap(),
            Heartbeat::Held { counter: 2 }
        );

        assert!(matches!(
            library.open_for_editing(&id, &b, true).unwrap(),
            LockOutcome::Mine { .. }
        ));
        match library.heartbeat(&id, &a).unwrap() {
            Heartbeat::Displaced { lock } => assert_eq!(lock.session, "b"),
            other @ Heartbeat::Held { .. } => panic!("expected displaced, got {other:?}"),
        }
        assert!(!library.may_write(&id, "a").unwrap());
        // The displaced session can't release the new editor's lock.
        library.release_lock(&id, "a").unwrap();
        assert_eq!(library.read_lock(&id).unwrap().unwrap().session, "b");
    }

    #[test]
    fn a_missing_or_garbled_lock_is_written_again() {
        let (_dir, library, id) = library_with_guide();
        let a = holder("a");
        library.open_for_editing(&id, &a, false).unwrap();
        let path = library.lock_path(&id).unwrap();
        fs::write(&path, b"{half a file").unwrap();
        assert_eq!(library.read_lock(&id).unwrap(), None);
        assert_eq!(
            library.heartbeat(&id, &a).unwrap(),
            Heartbeat::Held { counter: 0 }
        );
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            library.heartbeat(&id, &a).unwrap(),
            Heartbeat::Held { .. }
        ));
        assert!(path.exists());
    }

    #[test]
    fn releasing_frees_the_guide() {
        let (_dir, library, id) = library_with_guide();
        let a = holder("a");
        library.open_for_editing(&id, &a, false).unwrap();
        library.release_lock(&id, "a").unwrap();
        assert_eq!(library.read_lock(&id).unwrap(), None);
        assert!(library.may_write(&id, "anyone").unwrap());
    }
}
