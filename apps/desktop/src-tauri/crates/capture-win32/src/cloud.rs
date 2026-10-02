//! Whether a file in a `OneDrive` or `SharePoint`-synced folder is in sync, from the Windows cloud
//! files placeholder state (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive).
//! A guide's edit lock only counts as stale while its file shows as in sync: otherwise a counter
//! that stopped moving may just not have arrived yet.

use std::path::Path;

use windows::Win32::Storage::CloudFilters::{
    CF_PLACEHOLDER_STATE_IN_SYNC, CF_PLACEHOLDER_STATE_PLACEHOLDER,
    CfGetPlaceholderStateFromAttributeTag,
};
use windows::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};
use windows::core::PCWSTR;

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

/// The file's sync state, or `None` if it can't be read (it doesn't exist, say).
#[must_use]
pub fn sync_state(path: &Path) -> Option<SyncState> {
    let wide: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut data = WIN32_FIND_DATAW::default();
    // SAFETY: `wide` is NUL-terminated UTF-16 that outlives the call, and `data` is a valid
    // WIN32_FIND_DATAW for the call to fill.
    let handle = unsafe { FindFirstFileW(PCWSTR(wide.as_ptr()), &raw mut data) }.ok()?;
    // SAFETY: `handle` came from FindFirstFileW just above and is closed exactly once.
    let _ = unsafe { FindClose(handle) };
    // The reparse tag of a reparse point is in dwReserved0.
    // SAFETY: plain values in, a plain value out.
    let state =
        unsafe { CfGetPlaceholderStateFromAttributeTag(data.dwFileAttributes, data.dwReserved0) };
    Some(if state.0 & CF_PLACEHOLDER_STATE_PLACEHOLDER.0 == 0 {
        SyncState::Local
    } else if state.0 & CF_PLACEHOLDER_STATE_IN_SYNC.0 != 0 {
        SyncState::InSync
    } else {
        SyncState::Pending
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_outside_a_synced_folder_is_local() {
        let dir = std::env::temp_dir().join(format!("steps-cloud-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".lock");
        std::fs::write(&file, b"{}").unwrap();
        assert_eq!(sync_state(&file), Some(SyncState::Local));
        assert_eq!(sync_state(&dir.join("missing")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
