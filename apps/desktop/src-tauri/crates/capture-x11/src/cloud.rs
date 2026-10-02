//! Whether a file in a synced folder is in sync. Linux sync clients (the `OneDrive` client,
//! rclone, Nextcloud) don't say, so every file reads as local: a guide's edit lock then goes stale
//! on its own clock, as it does in any folder that isn't synced.

use std::path::Path;

/// A file's sync state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncState {
    /// Not in a cloud-synced folder: what's on disk is all there is.
    Local,
    /// Synced, and the sync client says this copy is up to date.
    InSync,
    /// Synced, but changes are still going up or coming down.
    Pending,
}

/// The file's sync state, or `None` if it doesn't exist.
#[must_use]
pub fn sync_state(path: &Path) -> Option<SyncState> {
    path.exists().then_some(SyncState::Local)
}
