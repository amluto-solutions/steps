//! One library folder and the guides in it (docs/spec/03-data-and-sharing.md#library-folder-desktop).
//!
//! Every write is atomic (temp file + flush + rename) and every multi-file change is built in a
//! `.finalizing-` staging folder and renamed into place, so a crash or a sync client never sees
//! half a guide. Lists skip anything they can't read rather than failing, because a shared
//! library can hold a folder another PC is still syncing.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::{LibraryError, Result};
use crate::util::{
    check_format_version, checked, copy_files, copy_tree, is_safe_segment, new_id, now_iso,
    parse_iso, read_json, unix_millis, write_json_atomic, write_json_new,
};

/// The top-level fields of `guide.json` this version knows (`GuideV1`). Any other field came from
/// a newer Steps, and is kept when this one saves (`with_newer_fields`).
const GUIDE_FIELDS: &[&str] = &[
    "id",
    "title",
    "description",
    "intro",
    "outro",
    "brandProfileId",
    "tags",
    "owner",
    "reviewBy",
    "createdAt",
    "createdBy",
    "updatedAt",
    "updatedBy",
    "recordingSessionId",
    "language",
    "tone",
    "translations",
    "formatVersion",
];

/// The top-level fields of a step file this version knows (`StepV1`).
const STEP_FIELDS: &[&str] = &[
    "id",
    "sortKey",
    "kind",
    "action",
    "actionText",
    "textParts",
    "showValue",
    "textEdited",
    "notes",
    "altText",
    "context",
    "target",
    "media",
    "highlight",
    "crop",
    "redactions",
    "notPersonal",
    "annotations",
    "block",
    "code",
    "capturedAt",
    "updatedAt",
    "updatedBy",
    "formatVersion",
    "reviewRequired",
    "translations",
];

/// The most fields from a newer Steps one file carries forward, and their size together.
const MAX_NEWER_FIELDS: usize = 32;
const MAX_NEWER_BYTES: usize = 1024 * 1024;

/**
 * `value` with the fields a newer Steps wrote to the file at `path` and this version doesn't
 * know, so a colleague on this version editing a guide doesn't wipe a later feature's data
 * (docs/spec/03-data-and-sharing.md#versions-of-steps). Only top-level fields this version has
 * no name for are kept, never shown, used, exported or put in a `.amlsteps` file (those go
 * through the schema, which drops them); one this version knows is always the UI's. More than
 * `MAX_NEWER_FIELDS` or `MAX_NEWER_BYTES` of them and none are kept.
 */
fn with_newer_fields(path: &Path, value: &Value, known: &[&str]) -> Value {
    let (Ok(Value::Object(old)), Value::Object(new)) = (read_json(path), value) else {
        return value.clone();
    };
    let newer: serde_json::Map<String, Value> = old
        .into_iter()
        .filter(|(key, _)| !known.contains(&key.as_str()) && !new.contains_key(key))
        .collect();
    if newer.is_empty()
        || newer.len() > MAX_NEWER_FIELDS
        || serde_json::to_vec(&newer).map_or(true, |bytes| bytes.len() > MAX_NEWER_BYTES)
    {
        return value.clone();
    }
    let mut out = new.clone();
    out.extend(newer);
    Value::Object(out)
}

/// How many steps a guide has, as the editor counts them: recorded ones, not notes or headers
/// (F032: the library and Versions counted blocks too).
pub(crate) fn step_count(steps: &[Value]) -> usize {
    steps
        .iter()
        .filter(|step| step.get("kind").and_then(Value::as_str) != Some("block"))
        .count()
}

/// When a guide last changed: its own `updatedAt` or a step's, whichever is later. A step edited
/// after the guide was saved (a blur, new wording) changes only the step's file, and the card said
/// "Edited 9 minutes ago" a minute after Blur all. ISO times compare as text.
pub(crate) fn last_edited(guide_updated_at: String, steps: &[Value]) -> String {
    steps
        .iter()
        .filter_map(|step| step.get("updatedAt").and_then(Value::as_str))
        .fold(guide_updated_at, |latest, at| {
            if at > latest.as_str() {
                at.to_string()
            } else {
                latest
            }
        })
}

/// Prefix of staging folders; lists skip them.
pub(crate) const STAGING_PREFIX: &str = ".finalizing-";
/// Deleted guides stay in the bin this long.
pub const TRASH_DAYS: i64 = 30;
const UNTITLED: &str = "Untitled guide";
const MAX_TITLE_CHARS: usize = 300;

/// A guide as the library list shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSummary {
    /// The guide id, which is also its folder name.
    pub id: String,
    /// The guide title.
    pub title: String,
    /// When it last changed (ISO 8601).
    pub updated_at: String,
    /// How many readable step files it has.
    pub step_count: usize,
    /// Its tags.
    pub tags: Vec<String>,
    /// Who owns it.
    pub owner: String,
    /// When it is due for review, if set.
    pub review_by: Option<String>,
    /// The first step's screenshot (by sort key, then id), for the card thumbnail.
    pub thumbnail_media_id: Option<String>,
    /// How many review comment threads are open.
    pub open_comments: usize,
    /// Who locked it with a password, if anyone (04/10/2026). Left out when not locked, as
    /// Steps for Chrome's list leaves it out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<crate::meta::LockedBy>,
}

/// A whole guide: `guide.json` and its steps in order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideDocument {
    /// The contents of `guide.json`.
    pub guide: Value,
    /// Every readable step file, sorted by sort key then id.
    pub steps: Vec<Value>,
}

/// A guide in the bin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// The bin folder name, used to restore it.
    pub trash_id: String,
    /// The id the guide had (and gets back when restored).
    pub guide_id: String,
    /// Its title when deleted.
    pub title: String,
    /// When it was deleted (ISO 8601).
    pub deleted_at: String,
}

/// What travels when a guide is copied to a new folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyScope {
    /// guide.json, steps and media only (a duplicate is a fresh guide).
    Content,
    /// Also its saved versions and review comments (a guide moving or copied to another library
    /// keeps its history).
    WithHistory,
}

/// One library folder.
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
}

impl Library {
    /// Opens the library at `root`. Nothing is read until an operation needs it.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The library folder.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn guides_dir(&self) -> PathBuf {
        self.root.join("guides")
    }

    fn trash_dir(&self) -> PathBuf {
        self.root.join(".trash")
    }

    /// The folder of an existing guide.
    pub(crate) fn guide_dir(&self, guide_id: &str) -> Result<PathBuf> {
        let path = self.guides_dir().join(checked(guide_id, "guide")?);
        if path.join("guide.json").is_file() {
            Ok(path)
        } else {
            Err(LibraryError::GuideNotFound)
        }
    }

    /// The screenshot files of a guide (for forgetting their cached OCR text when the guide goes).
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn media_files(&self, guide_id: &str) -> Result<Vec<PathBuf>> {
        let media = self.guide_dir(guide_id)?.join("media");
        let entries = match fs::read_dir(&media) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        Ok(entries
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .collect())
    }

    /// True when `guide_id` is free in this library.
    pub(crate) fn id_is_free(&self, guide_id: &str) -> bool {
        !self.guides_dir().join(guide_id).exists()
    }

    /// A staging folder for building something that is then renamed to `guides\<id>`.
    pub(crate) fn staging_dir(&self, label: &str) -> PathBuf {
        self.guides_dir()
            .join(format!("{STAGING_PREFIX}{label}-{}", new_id()))
    }

    /// How many guides the library holds; 0 if its folder can't be read (e.g. a drive that
    /// isn't connected), so one missing library doesn't break the list of libraries.
    #[must_use]
    pub fn guide_count(&self) -> usize {
        fs::read_dir(self.guides_dir()).map_or(0, |entries| {
            entries
                .filter_map(std::result::Result::ok)
                .filter(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    is_safe_segment(&name)
                        && entry.file_type().is_ok_and(|kind| kind.is_dir())
                        && guide_id_matches(&entry.path(), &name)
                })
                .count()
        })
    }

    /// Every readable guide, newest change first. Staging folders, folders whose `guide.json`
    /// names another id (a copied folder) and unreadable guides are skipped.
    ///
    /// # Errors
    /// `Storage` if the `guides` folder itself can't be read.
    pub fn list_guides(&self) -> Result<Vec<GuideSummary>> {
        self.sweep_leftovers_once();
        let mut result = Vec::new();
        for entry in fs::read_dir(self.guides_dir())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_safe_segment(&name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Ok(summary) = self.summary(&name) {
                result.push(summary);
            }
        }
        result.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(result)
    }

    /// The list entry for one guide.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, or a read error for a damaged guide.
    pub fn summary(&self, guide_id: &str) -> Result<GuideSummary> {
        let folder = self.guide_dir(guide_id)?;
        SUMMARIES
            .get(&folder, || read_summary(&folder, guide_id))
            .map(|summary| (*summary).clone())
    }
}

/// How old an unfinished write's leftovers must be before they are removed. A save, import or
/// restore on another PC may still be writing a newer one into a synced library.
const LEFTOVER_AGE: std::time::Duration = std::time::Duration::from_hours(24);

/// A temporary file from an interrupted write (`name.<id>.tmp`).
fn is_temporary(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
}

impl Library {
    /// Removes what interrupted writes leave behind (a crash, a full disk), once per library per
    /// run: staging folders for new guides, half-built step folders from a version restore,
    /// half-saved versions and temporary files. They are hidden from every listing, but would
    /// otherwise sync to everyone forever. A `.steps-replaced-*` folder is kept: after a restore
    /// whose rollback failed it holds the only copy of the steps.
    fn sweep_leftovers_once(&self) {
        static SWEPT: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
        {
            let mut swept = SWEPT
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if swept.iter().any(|root| root == &self.root) {
                return;
            }
            swept.push(self.root.clone());
        }
        self.sweep_leftovers(LEFTOVER_AGE);
    }

    pub(crate) fn sweep_leftovers(&self, older_than: std::time::Duration) {
        let old = |path: &Path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= older_than)
        };
        let remove_old = |folder: &Path, is_leftover: &dyn Fn(&str) -> bool| {
            let Ok(entries) = fs::read_dir(folder) else {
                return;
            };
            for entry in entries.filter_map(std::result::Result::ok) {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = entry.path();
                if !is_leftover(&name) || !old(&path) {
                    continue;
                }
                let _ = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
            }
        };
        let guides = self.guides_dir();
        remove_old(&guides, &|name| {
            name.starts_with(STAGING_PREFIX) || is_temporary(name)
        });
        let Ok(entries) = fs::read_dir(&guides) else {
            return;
        };
        for guide in entries.filter_map(std::result::Result::ok) {
            let name = guide.file_name().to_string_lossy().into_owned();
            if !is_safe_segment(&name) || !guide.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let folder = guide.path();
            remove_old(&folder, &|name| {
                name.starts_with(".steps-restoring-") || is_temporary(name)
            });
            remove_old(&folder.join("steps"), &|name| is_temporary(name));
            remove_old(&folder.join("versions"), &|name| {
                name.starts_with(".saving-") || is_temporary(name)
            });
        }
    }
}

/// Guide list entries, kept while a guide's files are unchanged (see `crate::cache`).
static SUMMARIES: crate::cache::GuideCache<GuideSummary> = crate::cache::GuideCache::new();

fn read_summary(folder: &Path, guide_id: &str) -> Result<GuideSummary> {
    let guide = read_json(&folder.join("guide.json"))?;
    if guide.get("id").and_then(Value::as_str) != Some(guide_id) {
        return Err(LibraryError::GuideNotFound);
    }
    let steps = read_steps(&folder.join("steps"));
    let text = |field: &str| guide.get(field).and_then(Value::as_str).map(str::to_string);
    Ok(GuideSummary {
        id: guide_id.to_string(),
        title: text("title").unwrap_or_else(|| UNTITLED.to_string()),
        updated_at: last_edited(text("updatedAt").unwrap_or_default(), &steps),
        step_count: step_count(&steps),
        tags: guide
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        owner: text("owner").unwrap_or_default(),
        review_by: text("reviewBy"),
        thumbnail_media_id: steps.iter().find_map(step_media_id).map(str::to_string),
        open_comments: Library::open_comment_count(folder),
        locked: crate::meta::locked_by(folder),
    })
}

impl Library {
    /// Loads `guide.json` and its steps (sorted by sort key, then id). Temporary and unreadable
    /// step files are skipped.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, or a read error for `guide.json`.
    pub fn load_guide(&self, guide_id: &str) -> Result<GuideDocument> {
        let folder = self.guide_dir(guide_id)?;
        Ok(GuideDocument {
            guide: read_json(&folder.join("guide.json"))?,
            steps: read_steps(&folder.join("steps")),
        })
    }

    /// Creates a new, empty guide owned by `author`.
    ///
    /// # Errors
    /// `Storage` if the folder can't be written.
    pub fn create_guide(&self, title: &str, author: &str) -> Result<GuideDocument> {
        let id = new_id();
        let now = now_iso();
        let guide = serde_json::json!({
            "id": id,
            "title": clean_title(title)?,
            "description": "",
            "intro": null,
            "outro": null,
            "brandProfileId": null,
            "tags": [],
            "owner": author,
            "reviewBy": null,
            "createdAt": now,
            "createdBy": author,
            "updatedAt": now,
            "updatedBy": author,
            "formatVersion": 1
        });
        let staging = self.staging_dir(&id);
        let built = (|| -> Result<()> {
            fs::create_dir_all(staging.join("steps"))?;
            fs::create_dir_all(staging.join("media"))?;
            write_json_new(&staging.join("guide.json"), &guide)?;
            fs::rename(&staging, self.guides_dir().join(&id))?;
            Ok(())
        })();
        if let Err(error) = built {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        Ok(GuideDocument {
            guide,
            steps: Vec::new(),
        })
    }

    /// Replaces `guide.json`. The UI owns every field (including `updatedAt`); this only checks
    /// the id matches and the format is one this app writes.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for a mismatched id, `NewerFormat`, `Storage`.
    pub fn save_guide(&self, guide_id: &str, guide: &Value) -> Result<()> {
        let folder = self.guide_dir(guide_id)?;
        if guide.get("id").and_then(Value::as_str) != Some(guide_id) {
            return Err(LibraryError::Invalid(
                "The guide's id doesn't match the guide being saved.".to_string(),
            ));
        }
        check_format_version(guide, "guide")?;
        let path = folder.join("guide.json");
        write_json_atomic(&path, &with_newer_fields(&path, guide, GUIDE_FIELDS))
    }

    /// Replaces (or creates) `steps\<id>.json`.
    ///
    /// # Errors
    /// `InvalidId` (guide or step), `GuideNotFound`, `NewerFormat`, `Storage`.
    pub fn save_step(&self, guide_id: &str, step: &Value) -> Result<()> {
        let folder = self.guide_dir(guide_id)?;
        let step_id = checked(
            step.get("id").and_then(Value::as_str).unwrap_or_default(),
            "step",
        )?;
        check_format_version(step, "step")?;
        let steps = folder.join("steps");
        fs::create_dir_all(&steps)?;
        let path = steps.join(format!("{step_id}.json"));
        write_json_atomic(&path, &with_newer_fields(&path, step, STEP_FIELDS))
    }

    /// Removes a step file; a step that is already gone is fine. Its screenshot stays, because
    /// images are immutable and saved versions may still use it.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn delete_step(&self, guide_id: &str, step_id: &str) -> Result<()> {
        let folder = self.guide_dir(guide_id)?;
        let path = folder
            .join("steps")
            .join(format!("{}.json", checked(step_id, "step")?));
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Moves a guide to `.trash\<guideId>-<time>` with a `trashed.json` note.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn trash_guide(&self, guide_id: &str) -> Result<TrashEntry> {
        let folder = self.guide_dir(guide_id)?;
        let title = read_json(&folder.join("guide.json"))
            .ok()
            .and_then(|guide| {
                guide
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| UNTITLED.to_string());
        fs::create_dir_all(self.trash_dir())?;
        let mut trash_id = format!("{guide_id}-{}", unix_millis());
        // Ids are capped at 128 characters; a long guide id falls back to a fresh bin id, since
        // `trashed.json` records the guide id anyway.
        if !is_safe_segment(&trash_id) || self.trash_dir().join(&trash_id).exists() {
            trash_id = new_id();
        }
        let destination = self.trash_dir().join(&trash_id);
        fs::rename(&folder, &destination)?;
        // Binning a locked guide needs its password, and takes the lock off (04/10/2026): it
        // comes back from the Bin unlocked.
        let _ = fs::remove_file(destination.join(crate::meta::LOCK_FILE));
        let entry = TrashEntry {
            trash_id,
            guide_id: guide_id.to_string(),
            title,
            deleted_at: now_iso(),
        };
        // The guide is safely in the bin already; without the note the bin falls back to
        // guide.json and the folder's time, so a failure here isn't worth failing the delete.
        let _ = write_json_atomic(
            &destination.join("trashed.json"),
            &serde_json::json!({
                "trashId": entry.trash_id,
                "guideId": entry.guide_id,
                "title": entry.title,
                "deletedAt": entry.deleted_at,
                "formatVersion": 1
            }),
        );
        Ok(entry)
    }

    /// The bin, newest first. Entries deleted more than 30 days ago are removed for good.
    ///
    /// # Errors
    /// `Storage` if the bin exists but can't be read.
    pub fn list_trash(&self) -> Result<Vec<TrashEntry>> {
        let entries = match fs::read_dir(self.trash_dir()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let cutoff = chrono::Utc::now() - chrono::Duration::days(TRASH_DAYS);
        let mut result = Vec::new();
        for entry in entries.filter_map(std::result::Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_safe_segment(&name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let Some(trashed) = read_trash_entry(&entry.path(), &name) else {
                continue;
            };
            if parse_iso(&trashed.deleted_at).is_some_and(|deleted| deleted < cutoff) {
                // Best effort: a file a sync client holds open is retried next time.
                let _ = fs::remove_dir_all(entry.path());
                continue;
            }
            result.push(trashed);
        }
        result.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
        Ok(result)
    }

    /// Puts a guide from the bin back under its old id.
    ///
    /// # Errors
    /// `InvalidId`, `TrashNotFound`, `GuideExists` if that id is in use again, `Storage`.
    pub fn restore_guide(&self, trash_id: &str) -> Result<GuideSummary> {
        let folder = self.trash_dir().join(checked(trash_id, "bin entry")?);
        let entry = read_trash_entry(&folder, trash_id).ok_or(LibraryError::TrashNotFound)?;
        let destination = self.guides_dir().join(&entry.guide_id);
        if destination.exists() {
            return Err(LibraryError::GuideExists);
        }
        fs::create_dir_all(self.guides_dir())?;
        fs::rename(&folder, &destination)?;
        let _ = fs::remove_file(destination.join("trashed.json"));
        self.summary(&entry.guide_id)
    }

    /// Deletes a guide in the bin for good: its folder goes, screenshots and history included.
    ///
    /// # Errors
    /// `InvalidId`, `TrashNotFound`, `Storage` (a file a sync client holds open, say).
    pub fn delete_trashed(&self, trash_id: &str) -> Result<()> {
        let folder = self.trash_dir().join(checked(trash_id, "bin entry")?);
        read_trash_entry(&folder, trash_id).ok_or(LibraryError::TrashNotFound)?;
        fs::remove_dir_all(&folder)?;
        Ok(())
    }

    /// Empties the bin for good. Every entry is tried, so one file held open doesn't keep the
    /// rest; the first failure is then reported. Returns how many guides were deleted.
    ///
    /// # Errors
    /// `Storage` if the bin can't be read or an entry couldn't be deleted.
    pub fn empty_trash(&self) -> Result<usize> {
        let mut deleted = 0;
        let mut failure = None;
        for entry in self.list_trash()? {
            match self.delete_trashed(&entry.trash_id) {
                Ok(()) => deleted += 1,
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(deleted), Err)
    }

    /// Copies a guide to a new id in the same library, with a new title and fresh dates.
    /// Versions, comments and the edit lock stay behind; the recording session link is dropped.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for a bad title, `Storage`.
    pub fn duplicate_guide(&self, guide_id: &str, title: &str) -> Result<GuideSummary> {
        let title = clean_title(title)?;
        let new_id = new_id();
        let now = now_iso();
        self.copy_guide_into(self, guide_id, &new_id, CopyScope::Content, |guide| {
            guide["title"] = Value::String(title.clone());
            guide["createdAt"] = Value::String(now.clone());
            guide["updatedAt"] = Value::String(now.clone());
            drop_session_link(guide);
        })?;
        self.summary(&new_id)
    }

    /// Copies a guide into `target`, keeping its id when that is free there. A copy is what
    /// Duplicate makes (01/10/2026): the guide and its screenshots with fresh dates, while
    /// versions, comments, the edit lock and the recording-session link stay with the original.
    /// A move takes everything.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn copy_guide_to(&self, guide_id: &str, target: &Self) -> Result<GuideSummary> {
        let id = target.choose_id(guide_id);
        let now = now_iso();
        self.copy_guide_into(target, guide_id, &id, CopyScope::Content, |guide| {
            guide["createdAt"] = Value::String(now.clone());
            guide["updatedAt"] = Value::String(now.clone());
            drop_session_link(guide);
        })?;
        target.summary(&id)
    }

    /// Moves a guide into `target`: a full copy first, then the original goes to this library's
    /// bin. If the copy fails nothing changes; if only the bin step fails, both copies remain
    /// and `MoveIncomplete` says so.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`, `MoveIncomplete`.
    pub fn move_guide_to(&self, guide_id: &str, target: &Self) -> Result<GuideSummary> {
        self.guide_dir(guide_id)?;
        if same_root(self, target) {
            return self.summary(guide_id);
        }
        let id = target.choose_id(guide_id);
        self.copy_guide_into(target, guide_id, &id, CopyScope::WithHistory, |_| {})?;
        let summary = target.summary(&id)?;
        self.trash_guide(guide_id)
            .map_err(|error| LibraryError::MoveIncomplete(error.to_string()))?;
        Ok(summary)
    }

    /// `preferred` if it is free here, else a new id.
    pub(crate) fn choose_id(&self, preferred: &str) -> String {
        if is_safe_segment(preferred) && self.id_is_free(preferred) {
            preferred.to_string()
        } else {
            new_id()
        }
    }

    /// Builds a copy of `guide_id` in a staging folder in `target`, with `guide.json` rewritten
    /// by `edit` and its id set to `new_id`, then renames it into place. The staging folder is
    /// removed on any error.
    fn copy_guide_into(
        &self,
        target: &Self,
        guide_id: &str,
        new_id: &str,
        scope: CopyScope,
        edit: impl FnOnce(&mut Value),
    ) -> Result<()> {
        let source = self.guide_dir(guide_id)?;
        let mut guide = read_json(&source.join("guide.json"))?;
        check_format_version(&guide, "guide")?;
        edit(&mut guide);
        guide["id"] = Value::String(new_id.to_string());
        fs::create_dir_all(target.guides_dir())?;
        let staging = target.staging_dir(new_id);
        let built = (|| -> Result<()> {
            fs::create_dir_all(&staging)?;
            write_json_new(&staging.join("guide.json"), &guide)?;
            copy_files(&source.join("steps"), &staging.join("steps"), &[".json"])?;
            copy_files(&source.join("media"), &staging.join("media"), &[".webp"])?;
            if scope == CopyScope::WithHistory {
                copy_tree(&source.join("versions"), &staging.join("versions"))?;
                copy_tree(&source.join("comments"), &staging.join("comments"))?;
                // A moved guide keeps its password lock and history; copies leave them behind.
                for name in [crate::meta::LOCK_FILE, crate::meta::HISTORY_FILE] {
                    match fs::copy(source.join(name), staging.join(name)) {
                        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                            return Err(error.into());
                        }
                        _ => {}
                    }
                }
            }
            let destination = target.guides_dir().join(new_id);
            if destination.exists() {
                return Err(LibraryError::GuideExists);
            }
            fs::rename(&staging, destination)?;
            Ok(())
        })();
        if built.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        built
    }
}

fn same_root(left: &Library, right: &Library) -> bool {
    match (fs::canonicalize(&left.root), fs::canonicalize(&right.root)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left.root == right.root,
    }
}

fn drop_session_link(guide: &mut Value) {
    if let Some(object) = guide.as_object_mut() {
        object.remove("recordingSessionId");
    }
}

fn clean_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(LibraryError::Invalid(format!(
            "Enter a title of up to {MAX_TITLE_CHARS} characters."
        )));
    }
    Ok(if title.is_empty() { UNTITLED } else { title }.to_string())
}

fn guide_id_matches(folder: &Path, id: &str) -> bool {
    read_json(&folder.join("guide.json"))
        .is_ok_and(|guide| guide.get("id").and_then(Value::as_str) == Some(id))
}

/// The media id a step shows, if it has a usable one.
pub(crate) fn step_media_id(step: &Value) -> Option<&str> {
    step.pointer("/media/id")
        .and_then(Value::as_str)
        .filter(|id| is_safe_segment(id))
}

/// Reads every `*.json` step file in `folder`, sorted by sort key then id. Temporary files from
/// interrupted writes and files that don't parse are skipped, as is a missing folder. So is a
/// file whose name isn't its step's id: that is a sync client's conflict copy (`abc-PC.json`),
/// which would otherwise show the step twice and break an `.amlsteps` export.
pub(crate) fn read_steps(folder: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut steps: Vec<Value> = entries
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let step = read_json(&entry.path()).ok()?;
            let file_name = entry.path().file_stem()?.to_string_lossy().into_owned();
            (step.get("id").and_then(Value::as_str) == Some(file_name.as_str())).then_some(step)
        })
        .filter(Value::is_object)
        .collect();
    sort_steps(&mut steps);
    steps
}

/// Sorts steps by sort key, then id, as every reader of a guide does.
pub(crate) fn sort_steps(steps: &mut [Value]) {
    let key = |step: &Value, field: &str| {
        step.get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    steps.sort_by(|left, right| {
        key(left, "sortKey")
            .cmp(&key(right, "sortKey"))
            .then_with(|| key(left, "id").cmp(&key(right, "id")))
    });
}

/// Reads a bin entry from its `trashed.json`, falling back to its `guide.json` and the time in
/// the folder name when the note is missing or damaged.
fn read_trash_entry(folder: &Path, trash_id: &str) -> Option<TrashEntry> {
    let note = read_json(&folder.join("trashed.json")).ok();
    let guide = read_json(&folder.join("guide.json")).ok()?;
    let guide_id = guide
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_safe_segment(id))?
        .to_string();
    let text = |value: Option<&Value>, field: &str| {
        value
            .and_then(|value| value.get(field))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let deleted_at = text(note.as_ref(), "deletedAt")
        .filter(|value| parse_iso(value).is_some())
        .or_else(|| {
            let millis = trash_id.rsplit_once('-')?.1.parse::<i64>().ok()?;
            chrono::DateTime::from_timestamp_millis(millis)
                .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        })
        .unwrap_or_default();
    Some(TrashEntry {
        trash_id: trash_id.to_string(),
        guide_id,
        title: text(note.as_ref(), "title")
            .or_else(|| text(Some(&guide), "title"))
            .unwrap_or_else(|| UNTITLED.to_string()),
        deleted_at,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn library() -> (tempfile::TempDir, Library) {
        let root = tempfile::tempdir().unwrap();
        let library = Library::new(root.path().join("Library"));
        crate::registry::prepare_library_folder(library.root(), "Test").unwrap();
        (root, library)
    }

    pub(crate) fn step(id: &str, sort_key: &str, media: Option<&str>) -> Value {
        json!({
            "id": id,
            "sortKey": sort_key,
            "kind": "interaction",
            "action": "click",
            "actionText": format!("Click {id}"),
            "textParts": { "verb": "click", "target": id, "kind": "button" },
            "showValue": false,
            "textEdited": false,
            "notes": null,
            "altText": null,
            "context": { "app": null, "windowTitle": "" },
            "target": null,
            "media": media.map(|id| json!({ "id": id, "width": 4, "height": 4, "scale": 1, "captureRect": null })),
            "highlight": null,
            "crop": null,
            "redactions": [],
            "annotations": [],
            "block": null,
            "capturedAt": "2026-09-25T10:00:00.000Z",
            "updatedAt": "2026-09-25T10:00:00.000Z",
            "updatedBy": "",
            "formatVersion": 1
        })
    }

    #[test]
    fn a_new_guide_is_listed_with_its_owner_and_loads_empty() {
        let (_root, library) = library();
        let created = library
            .create_guide("  Pay an invoice ", "Robin Hale")
            .unwrap();
        let id = created.guide["id"].as_str().unwrap().to_string();
        assert_eq!(created.guide["title"], "Pay an invoice");
        assert_eq!(created.guide["owner"], "Robin Hale");
        assert_eq!(created.guide["createdBy"], "Robin Hale");
        assert_eq!(created.guide["formatVersion"], 1);
        let list = library.list_guides().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);
        assert_eq!(list[0].owner, "Robin Hale");
        assert_eq!(list[0].step_count, 0);
        assert_eq!(library.load_guide(&id).unwrap(), created);
        assert_eq!(library.guide_count(), 1);
        let untitled = library.create_guide("", "").unwrap();
        assert_eq!(untitled.guide["title"], "Untitled guide");
    }

    #[test]
    fn steps_save_atomically_sort_and_delete() {
        let (_root, library) = library();
        let id = library.create_guide("G", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        library
            .save_step(&id, &step("b", "a1", Some("m2")))
            .unwrap();
        library
            .save_step(&id, &step("a", "a1", Some("m1")))
            .unwrap();
        library.save_step(&id, &step("c", "a0", None)).unwrap();
        let mut changed = step("c", "a0", None);
        changed["actionText"] = json!("Changed");
        library.save_step(&id, &changed).unwrap();
        let steps_dir = library.guides_dir().join(&id).join("steps");
        fs::write(steps_dir.join("x.json.123.tmp"), b"{").unwrap();
        fs::write(steps_dir.join("broken.json"), b"{").unwrap();
        // A sync client's conflict copy of step c isn't a fourth step.
        fs::copy(steps_dir.join("c.json"), steps_dir.join("c-OTHER-PC.json")).unwrap();
        let loaded = library.load_guide(&id).unwrap();
        let ids: Vec<_> = loaded
            .steps
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["c", "a", "b"]);
        assert_eq!(loaded.steps[0]["actionText"], "Changed");
        let summary = library.summary(&id).unwrap();
        assert_eq!(summary.step_count, 3);
        assert_eq!(summary.thumbnail_media_id.as_deref(), Some("m1"));
        library.delete_step(&id, "a").unwrap();
        library.delete_step(&id, "a").unwrap();
        assert_eq!(library.load_guide(&id).unwrap().steps.len(), 2);
    }

    #[test]
    fn bad_ids_and_newer_formats_are_refused() {
        let (_root, library) = library();
        let id = library.create_guide("G", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(matches!(
            library.load_guide("..\\x"),
            Err(LibraryError::InvalidId("guide"))
        ));
        assert!(matches!(
            library.load_guide("missing"),
            Err(LibraryError::GuideNotFound)
        ));
        assert!(matches!(
            library.save_step(&id, &step("../evil", "a", None)),
            Err(LibraryError::InvalidId("step"))
        ));
        let mut newer = step("n", "a", None);
        newer["formatVersion"] = json!(2);
        assert!(matches!(
            library.save_step(&id, &newer),
            Err(LibraryError::NewerFormat)
        ));
        let mut guide = library.load_guide(&id).unwrap().guide;
        guide["id"] = json!("other");
        assert!(matches!(
            library.save_guide(&id, &guide),
            Err(LibraryError::Invalid(_))
        ));
        guide["id"] = json!(id);
        guide["formatVersion"] = json!(2);
        assert!(matches!(
            library.save_guide(&id, &guide),
            Err(LibraryError::NewerFormat)
        ));
        guide["formatVersion"] = json!(1);
        guide["title"] = json!("Saved");
        library.save_guide(&id, &guide).unwrap();
        assert_eq!(library.summary(&id).unwrap().title, "Saved");
    }

    #[test]
    fn the_known_fields_are_the_ones_steps_for_chrome_uses() {
        let shared: Value = serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/known-fields.json"
        ))
        .unwrap();
        let names = |kind: &str| -> Vec<String> {
            shared[kind]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(names("guide"), GUIDE_FIELDS);
        assert_eq!(names("step"), STEP_FIELDS);
    }

    #[test]
    fn saving_keeps_fields_a_newer_steps_wrote_but_not_ones_this_version_knows() {
        let (_root, library) = library();
        let guide = library.create_guide("Payroll", "").unwrap().guide;
        let id = guide["id"].as_str().unwrap().to_string();
        let path = library.guide_dir(&id).unwrap().join("guide.json");
        let mut newer = guide.clone();
        newer["checklist"] = json!({ "items": ["Ask finance"] });
        newer["translations"] = json!({ "de": { "title": "Lohn" } });
        fs::write(&path, newer.to_string()).unwrap();

        // This version's UI never saw "checklist", and took the German title away.
        let mut edited = guide.clone();
        edited["title"] = json!("Payroll run");
        library.save_guide(&id, &edited).unwrap();
        let saved = read_json(&path).unwrap();
        assert_eq!(saved["title"], "Payroll run");
        assert_eq!(saved["checklist"], json!({ "items": ["Ask finance"] }));
        assert!(saved.get("translations").is_none());

        // Too much from elsewhere and none of it is kept.
        let mut flooded = guide.clone();
        for index in 0..=MAX_NEWER_FIELDS {
            flooded[format!("field{index}")] = json!(index);
        }
        fs::write(&path, flooded.to_string()).unwrap();
        library.save_guide(&id, &guide).unwrap();
        assert!(read_json(&path).unwrap().get("field0").is_none());

        let mut step_value = step("s", "a", None);
        library.save_step(&id, &step_value).unwrap();
        let step_path = library.guide_dir(&id).unwrap().join("steps/s.json");
        let mut on_disk = read_json(&step_path).unwrap();
        on_disk["voiceOver"] = json!("a later feature");
        fs::write(&step_path, on_disk.to_string()).unwrap();
        step_value["actionText"] = json!("Click Run");
        library.save_step(&id, &step_value).unwrap();
        let saved = read_json(&step_path).unwrap();
        assert_eq!(saved["actionText"], "Click Run");
        assert_eq!(saved["voiceOver"], "a later feature");
    }

    #[test]
    fn the_list_skips_staging_copied_and_damaged_folders_and_sorts_newest_first() {
        let (_root, library) = library();
        let older = library.create_guide("Older", "").unwrap().guide;
        let mut newer = library.create_guide("Newer", "").unwrap().guide;
        newer["updatedAt"] = json!("2099-01-01T00:00:00.000Z");
        library
            .save_guide(newer["id"].as_str().unwrap(), &newer)
            .unwrap();
        let guides = library.guides_dir();
        fs::create_dir_all(guides.join(".finalizing-x")).unwrap();
        fs::write(guides.join(".finalizing-x").join("guide.json"), b"{}").unwrap();
        fs::create_dir_all(guides.join("copied")).unwrap();
        fs::write(
            guides.join("copied").join("guide.json"),
            serde_json::to_vec(&older).unwrap(),
        )
        .unwrap();
        fs::create_dir_all(guides.join("damaged")).unwrap();
        fs::write(guides.join("damaged").join("guide.json"), b"{").unwrap();
        let titles: Vec<_> = library
            .list_guides()
            .unwrap()
            .into_iter()
            .map(|guide| guide.title)
            .collect();
        assert_eq!(titles, ["Newer", "Older"]);
        assert_eq!(library.guide_count(), 2);
    }

    #[test]
    fn trash_restore_and_the_thirty_day_purge() {
        let (_root, library) = library();
        let id = library.create_guide("Bin me", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let entry = library.trash_guide(&id).unwrap();
        assert_eq!(entry.guide_id, id);
        assert_eq!(entry.title, "Bin me");
        assert!(library.list_guides().unwrap().is_empty());
        assert_eq!(library.list_trash().unwrap(), vec![entry.clone()]);

        // A guide with the same id appearing again blocks the restore.
        fs::create_dir_all(library.guides_dir().join(&id)).unwrap();
        assert!(matches!(
            library.restore_guide(&entry.trash_id),
            Err(LibraryError::GuideExists)
        ));
        fs::remove_dir_all(library.guides_dir().join(&id)).unwrap();
        let restored = library.restore_guide(&entry.trash_id).unwrap();
        assert_eq!(restored.id, id);
        assert!(!library.guides_dir().join(&id).join("trashed.json").exists());
        assert!(library.list_trash().unwrap().is_empty());

        // Entries older than 30 days are removed for good when the bin is listed.
        let old = library.trash_guide(&id).unwrap();
        let note = library.trash_dir().join(&old.trash_id).join("trashed.json");
        let mut value = read_json(&note).unwrap();
        value["deletedAt"] = json!("2020-01-01T00:00:00.000Z");
        fs::write(&note, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(library.list_trash().unwrap().is_empty());
        assert!(!library.trash_dir().join(&old.trash_id).exists());
    }

    #[test]
    fn deleting_from_the_bin_for_good_and_emptying_it() {
        let (_root, library) = library();
        let make = |title: &str| {
            library.create_guide(title, "").unwrap().guide["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let first = library.trash_guide(&make("One")).unwrap();
        let second = library.trash_guide(&make("Two")).unwrap();
        let third = library.trash_guide(&make("Three")).unwrap();

        library.delete_trashed(&first.trash_id).unwrap();
        assert!(!library.trash_dir().join(&first.trash_id).exists());
        assert_eq!(library.list_trash().unwrap().len(), 2);
        // Gone already, or never there.
        assert!(matches!(
            library.delete_trashed(&first.trash_id),
            Err(LibraryError::TrashNotFound)
        ));
        assert!(matches!(
            library.delete_trashed("../guides"),
            Err(LibraryError::InvalidId(_))
        ));

        assert_eq!(library.empty_trash().unwrap(), 2);
        assert!(library.list_trash().unwrap().is_empty());
        assert!(!library.trash_dir().join(&second.trash_id).exists());
        assert!(!library.trash_dir().join(&third.trash_id).exists());
        assert_eq!(library.empty_trash().unwrap(), 0);
    }

    #[test]
    fn a_bin_entry_without_its_note_still_lists() {
        let (_root, library) = library();
        let id = library.create_guide("No note", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let entry = library.trash_guide(&id).unwrap();
        fs::remove_file(
            library
                .trash_dir()
                .join(&entry.trash_id)
                .join("trashed.json"),
        )
        .unwrap();
        let listed = library.list_trash().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "No note");
        assert!(parse_iso(&listed[0].deleted_at).is_some());
    }

    #[test]
    fn duplicate_copies_content_but_not_history() {
        let (_root, library) = library();
        let mut guide = library.create_guide("Original", "Ann").unwrap().guide;
        let id = guide["id"].as_str().unwrap().to_string();
        guide["recordingSessionId"] = json!("session1");
        // Made long ago, so the copy's own date can't match it by being made in the same tick.
        guide["createdAt"] = json!("2020-01-01T09:00:00Z");
        library.save_guide(&id, &guide).unwrap();
        library
            .save_step(&id, &step("s1", "a0", Some("m1")))
            .unwrap();
        let folder = library.guides_dir().join(&id);
        fs::write(folder.join("media").join("m1.webp"), b"image").unwrap();
        fs::create_dir_all(folder.join("versions").join("v1")).unwrap();
        fs::create_dir_all(folder.join("comments")).unwrap();
        fs::write(folder.join(".lock"), b"lock").unwrap();

        let copy = library.duplicate_guide(&id, "Copy").unwrap();
        assert_ne!(copy.id, id);
        assert_eq!(copy.title, "Copy");
        assert_eq!(copy.step_count, 1);
        let copied = library.guides_dir().join(&copy.id);
        assert!(copied.join("media").join("m1.webp").is_file());
        assert!(!copied.join("versions").exists());
        assert!(!copied.join("comments").exists());
        assert!(!copied.join(".lock").exists());
        let copied_guide = read_json(&copied.join("guide.json")).unwrap();
        assert_eq!(copied_guide["id"], copy.id.as_str());
        assert!(copied_guide.get("recordingSessionId").is_none());
        assert_ne!(copied_guide["createdAt"], guide["createdAt"]);
        assert_eq!(library.list_guides().unwrap().len(), 2);
    }

    #[test]
    fn copy_and_move_between_libraries_keep_ids_when_free() {
        let (_root, from) = library();
        let (_root2, to) = library();
        let id = from.create_guide("Travel", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        from.save_step(&id, &step("s1", "a0", None)).unwrap();
        let source = from.guides_dir().join(&id);
        fs::create_dir_all(source.join("versions").join("v1")).unwrap();
        fs::create_dir_all(source.join("comments")).unwrap();
        fs::write(source.join("comments").join("c1.json"), b"{}").unwrap();

        // A copy is a Duplicate: no versions or comments.
        let copied = from.copy_guide_to(&id, &to).unwrap();
        assert_eq!(copied.id, id);
        assert_eq!(copied.step_count, 1);
        assert!(!to.guides_dir().join(&id).join("versions").exists());
        assert!(!to.guides_dir().join(&id).join("comments").exists());
        // The id is taken now, so a second copy gets a new one.
        let again = from.copy_guide_to(&id, &to).unwrap();
        assert_ne!(again.id, id);

        // A move takes everything.
        let moved = from.move_guide_to(&id, &to).unwrap();
        assert_ne!(moved.id, id);
        assert_eq!(moved.step_count, 1);
        let arrived = to.guides_dir().join(&moved.id);
        assert!(arrived.join("versions").join("v1").is_dir());
        assert!(arrived.join("comments").join("c1.json").is_file());
        assert!(from.list_guides().unwrap().is_empty());
        assert_eq!(from.list_trash().unwrap().len(), 1);
        assert_eq!(to.list_guides().unwrap().len(), 3);
    }

    #[test]
    fn a_failed_copy_leaves_the_source_and_no_staging() {
        let (_root, from) = library();
        let (_root2, to) = library();
        let id = from.create_guide("Stay", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        // A file where the target's guides folder should be makes the copy fail.
        fs::remove_dir_all(to.guides_dir()).unwrap();
        fs::write(to.guides_dir(), b"not a folder").unwrap();
        assert!(from.move_guide_to(&id, &to).is_err());
        assert_eq!(from.list_guides().unwrap().len(), 1);
        assert!(from.list_trash().unwrap().is_empty());
    }

    #[test]
    fn a_failed_duplicate_removes_its_staging_folder() {
        let (_root, library) = library();
        let id = library.create_guide("Source", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        // A step folder that is a file makes copying the steps fail part-way.
        let steps = library.guides_dir().join(&id).join("steps");
        fs::remove_dir_all(&steps).unwrap();
        fs::create_dir_all(steps.join("nested.json")).unwrap();
        fs::write(steps.join("a.json"), b"{}").unwrap();
        let media = library.guides_dir().join(&id).join("media");
        fs::remove_dir_all(&media).unwrap();
        fs::write(&media, b"not a folder").unwrap();
        assert!(library.duplicate_guide(&id, "Copy").is_err());
        let leftovers = fs::read_dir(library.guides_dir())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(STAGING_PREFIX)
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn leftovers_of_interrupted_writes_are_swept_but_set_aside_steps_are_kept() {
        let (_root, library) = library();
        let id = library.create_guide("Sweep", "Ann").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let guides = library.guides_dir();
        let folder = guides.join(&id);
        for dir in [
            guides.join(".finalizing-import-1"),
            folder.join(".steps-restoring-1"),
            folder.join(".steps-replaced-1"),
            folder.join("versions").join(".saving-1"),
        ] {
            fs::create_dir_all(&dir).unwrap();
        }
        fs::create_dir_all(folder.join("steps")).unwrap();
        fs::write(folder.join("steps").join("a.json.1.tmp"), b"{").unwrap();
        // Too new to be anyone's leftover: a write on another PC may still be going.
        library.sweep_leftovers(std::time::Duration::from_secs(3600));
        assert!(guides.join(".finalizing-import-1").exists());
        library.sweep_leftovers(std::time::Duration::ZERO);
        assert!(!guides.join(".finalizing-import-1").exists());
        assert!(!folder.join(".steps-restoring-1").exists());
        assert!(!folder.join("versions").join(".saving-1").exists());
        assert!(!folder.join("steps").join("a.json.1.tmp").exists());
        assert!(folder.join(".steps-replaced-1").exists());
        assert!(folder.join("guide.json").exists());
    }
}
