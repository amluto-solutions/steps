//! Edit locks while the app runs (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive):
//! this run's session id, the heartbeat for every guide open for editing, and staleness.
//!
//! **Staleness never trusts clocks.** Another person's lock counts as stale only when this PC has
//! watched its counter stay the same for ten minutes while the `.lock` file shows as in sync (or
//! the library isn't a synced folder). Their PC's clock, and ours, play no part.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use capture::platform::cloud::{SyncState, sync_state};
use library::{EditLock, Heartbeat, Library, LockHolder};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How long another person's counter must stand still (while in sync) to count as stale.
pub const STALE_AFTER: Duration = Duration::from_mins(10);
/// How often this run raises the counters of the guides it's editing.
pub const HEARTBEAT_EVERY: Duration = Duration::from_mins(1);

/// A guide this run holds the lock of.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Held {
    library_id: String,
    guide_id: String,
    root: PathBuf,
}

/// Another person's counter, as this run last saw it change.
struct Watch {
    session: String,
    counter: u64,
    since: Instant,
}

/// Emitted when someone took over a guide this run was editing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockLost {
    pub library_id: String,
    pub guide_id: String,
    pub lock: EditLock,
}

pub struct LockService {
    session: String,
    held: Mutex<HashSet<Held>>,
    watched: Mutex<HashMap<PathBuf, Watch>>,
}

impl Default for LockService {
    fn default() -> Self {
        Self {
            session: library::new_id(),
            held: Mutex::default(),
            watched: Mutex::default(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl LockService {
    /// This run's session id: the value `.lock` holds while this run edits a guide.
    pub fn session(&self) -> &str {
        &self.session
    }

    /// Who this run edits as.
    pub fn holder(&self, name: &str) -> LockHolder {
        LockHolder {
            name: if name.trim().is_empty() {
                "Someone".to_string()
            } else {
                name.trim().to_string()
            },
            pc: std::env::var("COMPUTERNAME").unwrap_or_default(),
            session: self.session.clone(),
        }
    }

    pub fn hold(&self, library_id: &str, guide_id: &str, root: &Path) {
        lock(&self.held).insert(Held {
            library_id: library_id.to_string(),
            guide_id: guide_id.to_string(),
            root: root.to_path_buf(),
        });
    }

    pub fn let_go(&self, library_id: &str, guide_id: &str) {
        lock(&self.held)
            .retain(|held| !(held.library_id == library_id && held.guide_id == guide_id));
    }

    /// Notes another person's lock as seen now, and says whether it has gone stale.
    pub fn observe(&self, lock_file: &Path, their: &EditLock) -> bool {
        let in_sync = matches!(
            sync_state(lock_file),
            Some(SyncState::Local | SyncState::InSync)
        );
        observe_at(
            &mut lock(&self.watched),
            lock_file,
            their,
            Instant::now(),
            in_sync,
        )
    }

    /// Raises the counter of every guide this run is editing; tells the window about any that
    /// someone else took over.
    pub fn beat(&self, app: &AppHandle) {
        let held: Vec<Held> = lock(&self.held).iter().cloned().collect();
        for guide in held {
            let library = Library::new(&guide.root);
            let holder = LockHolder {
                name: String::new(),
                pc: String::new(),
                session: self.session.clone(),
            };
            match library.heartbeat(&guide.guide_id, &holder) {
                Ok(Heartbeat::Held { .. }) => {}
                Ok(Heartbeat::Displaced { lock }) => {
                    self.let_go(&guide.library_id, &guide.guide_id);
                    // Not their name: the log goes into support bundles, and only the user's own name is redacted.
                    log::info!("Someone else took over editing guide {}", guide.guide_id);
                    let _ = app.emit(
                        "library:lock-lost",
                        LockLost {
                            library_id: guide.library_id,
                            guide_id: guide.guide_id,
                            lock,
                        },
                    );
                }
                // A guide that has gone (deleted, moved) or a drive that's away: tried next time.
                Err(error) => log::warn!("heartbeat for {} failed: {error}", guide.guide_id),
            }
        }
    }
}

/// The staleness rule on its own, for tests: the counter (and session) must have stayed as they
/// are for `STALE_AFTER`, and the file must be in sync now.
fn observe_at(
    watched: &mut HashMap<PathBuf, Watch>,
    lock_file: &Path,
    their: &EditLock,
    now: Instant,
    in_sync: bool,
) -> bool {
    let entry = watched
        .entry(lock_file.to_path_buf())
        .or_insert_with(|| Watch {
            session: their.session.clone(),
            counter: their.counter,
            since: now,
        });
    if entry.session != their.session || entry.counter != their.counter {
        *entry = Watch {
            session: their.session.clone(),
            counter: their.counter,
            since: now,
        };
    }
    in_sync && now.duration_since(entry.since) >= STALE_AFTER
}

/// Starts the heartbeat. The first beat is a minute in: opening a guide writes its lock.
pub fn start_heartbeat(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(HEARTBEAT_EVERY);
            if let Some(service) = tauri::Manager::try_state::<LockService>(&app) {
                service.beat(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_of(session: &str, counter: u64) -> EditLock {
        EditLock {
            name: "Sam".into(),
            pc: "PC-2".into(),
            session: session.into(),
            counter,
            since: "2026-09-29T10:00:00Z".into(),
        }
    }

    #[test]
    fn a_lock_is_stale_only_after_ten_quiet_minutes_in_sync() {
        let mut watched = HashMap::new();
        let file = Path::new(r"C:\guides\a\.lock");
        let start = Instant::now();
        assert!(!observe_at(
            &mut watched,
            file,
            &lock_of("s", 5),
            start,
            true
        ));
        let nine = start + Duration::from_mins(9);
        assert!(!observe_at(
            &mut watched,
            file,
            &lock_of("s", 5),
            nine,
            true
        ));
        let ten = start + STALE_AFTER;
        assert!(observe_at(&mut watched, file, &lock_of("s", 5), ten, true));
        // Not while the file is still syncing: the counter may be on its way.
        assert!(!observe_at(
            &mut watched,
            file,
            &lock_of("s", 5),
            ten,
            false
        ));
    }

    #[test]
    fn a_moving_counter_or_a_new_session_starts_the_wait_again() {
        let mut watched = HashMap::new();
        let file = Path::new(r"C:\guides\a\.lock");
        let start = Instant::now();
        observe_at(&mut watched, file, &lock_of("s", 5), start, true);
        let later = start + Duration::from_mins(11);
        assert!(!observe_at(
            &mut watched,
            file,
            &lock_of("s", 6),
            later,
            true
        ));
        let later_still = later + Duration::from_mins(11);
        assert!(!observe_at(
            &mut watched,
            file,
            &lock_of("t", 6),
            later_still,
            true
        ));
        assert!(observe_at(
            &mut watched,
            file,
            &lock_of("t", 6),
            later_still + STALE_AFTER,
            true
        ));
    }

    #[test]
    fn a_blank_name_still_says_who() {
        let service = LockService::default();
        assert_eq!(service.holder("  ").name, "Someone");
        assert_eq!(service.holder(" Robin ").name, "Robin");
        assert_eq!(service.holder("Robin").session, service.session());
    }
}
