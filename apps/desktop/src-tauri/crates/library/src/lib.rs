//! Library folders and the guides in them (docs/spec/03-data-and-sharing.md): the registry of
//! libraries, guide and step files, images, the bin and copying between libraries.
//!
//! Everything here is plain file-system logic with typed errors, so it is tested on temporary
//! folders. The Tauri command layer (`src/library.rs` in the app crate) only resolves library
//! ids and turns errors into `{ code, message }`.
#![forbid(unsafe_code)]

mod archive;
mod assemble;
mod cache;
mod comments;
mod conflicts;
mod drafts;
mod error;
mod guides;
mod locks;
mod media;
mod meta;
mod redact;
mod registry;
mod schema;
mod search;
mod typed_value;
mod util;
mod versions;
mod watch;

pub use archive::ImportLimits;
pub use assemble::MediaCopy;
pub use comments::{Comment, CommentThread, Commenter, MAX_COMMENT, Resolved};
pub use conflicts::{Conflict, Resolution};
pub use drafts::DraftInfo;
pub use error::{LibraryError, Result};
pub use guides::{GuideDocument, GuideSummary, Library, TRASH_DAYS, TrashEntry};
pub use locks::{EditLock, Heartbeat, LockHolder, LockOutcome};
pub use media::{
    MAX_EDGE, MAX_IMPORT_BYTES, MAX_PIXELS, MediaInfo, ScreenshotQuality, THUMBNAIL_EDGE,
    screenshot_webp,
};
pub use meta::{GuideMeta, GuideStats, LockedBy};
pub use registry::{
    FIRST_LIBRARY_NAME, LibraryEntry, REGISTRY_FILE, Registry, prepare_library_folder,
};
pub use search::{FoundIn, SearchHit};
pub use util::{is_safe_segment, new_id, now_iso, write_atomic};
pub use versions::VersionInfo;
