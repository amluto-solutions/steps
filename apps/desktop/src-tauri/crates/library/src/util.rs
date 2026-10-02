//! Ids, timestamps and the file-writing primitives every other module uses.

use std::collections::hash_map::RandomState;
use std::fs::{self, OpenOptions};
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use crate::error::{LibraryError, Result};

/// True when `value` is safe as one folder or file name on every filesystem we write to:
/// `[A-Za-z0-9_-]{1,128}`. Every id from the UI or from a file passes this before it touches a
/// path, so none can climb out of its folder or name a device.
#[must_use]
pub fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Returns `value` if it is a safe segment, else an `InvalidId` error naming `what`.
pub(crate) fn checked<'a>(value: &'a str, what: &'static str) -> Result<&'a str> {
    if is_safe_segment(value) {
        Ok(value)
    } else {
        Err(LibraryError::InvalidId(what))
    }
}

/// A new 32-character hex id. The first half is the time, so ids sort roughly by creation; the
/// second half is random per process and per call, because two ids made in the same clock tick
/// (Windows' clock moves in 100 ns steps) must still differ.
#[must_use]
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos() & u128::from(u64::MAX)).unwrap_or_default()
        });
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u64(nanos);
    hasher.write_u32(std::process::id());
    format!("{nanos:016x}{:016x}", hasher.finish())
}

/// Now, as the ISO 8601 UTC string the UI writes (`2026-09-25T10:32:00.000Z`).
#[must_use]
pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parses an ISO 8601 timestamp written by us or the UI.
pub(crate) fn parse_iso(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

/// Milliseconds since 1970, for folder-name suffixes.
pub(crate) fn unix_millis() -> i64 {
    Utc::now().timestamp_millis()
}

/// Replaces `path` with `bytes` so readers only ever see the old or the new file: a uniquely
/// named sibling temp file is written, flushed and renamed over the target. The unique name lets
/// two saves of the same file race without one failing on the other's temp file, and the `.tmp`
/// ending keeps an interrupted write out of every listing.
///
/// # Errors
/// If the temporary file can't be written or renamed over `path`.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("the file has no folder"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| std::io::Error::other("the file name is not valid text"))?;
    let temporary = parent.join(format!("{name}.{}.tmp", new_id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Creates `path` (never overwriting) and fills it. A write that fails part-way removes the
/// truncated file, so a half-written image can't later be mistaken for a whole one.
pub(crate) fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let filled = file.write_all(bytes).and_then(|()| file.sync_all());
    if filled.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
    }
    filled
}

/// Writes `value` as pretty JSON with `write_atomic`.
pub(crate) fn write_json_atomic(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_atomic(path, &bytes)?;
    Ok(())
}

/// Writes `value` as pretty JSON into a new file with `write_new`.
pub(crate) fn write_json_new(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_new(path, &bytes)?;
    Ok(())
}

/// The largest JSON file read from a library. Anyone who can write to a shared library folder
/// could otherwise drop a file of gigabytes there, and every colleague's Steps would run out of
/// memory listing it, at every start. Real guide files are kilobytes.
pub(crate) const MAX_JSON_FILE: u64 = 16 * 1024 * 1024;

/// The largest screenshot file read from a library.
pub(crate) const MAX_IMAGE_FILE: u64 = 100 * 1024 * 1024;

/// Fails, as damaged, when a file is larger than `limit`, before reading any of it.
pub(crate) fn check_size(path: &Path, limit: u64) -> std::io::Result<()> {
    if fs::metadata(path)?.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file too large for a guide",
        ));
    }
    Ok(())
}

/// Reads and parses a JSON file, refusing one too large to be a guide's.
pub(crate) fn read_json(path: &Path) -> Result<Value> {
    check_size(path, MAX_JSON_FILE)?;
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

/// Copies every regular file in `from` whose name ends with one of `endings` into `to`
/// (created if needed). Temporary files from interrupted writes are never copied. A missing
/// `from` folder copies nothing: a sync client may not have delivered it yet.
pub(crate) fn copy_files(from: &Path, to: &Path, endings: &[&str]) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(text) = name.to_str() else {
            continue;
        };
        let lower = text.to_ascii_lowercase();
        let temporary = Path::new(&lower)
            .extension()
            .is_some_and(|extension| extension == "tmp");
        if temporary || !endings.iter().any(|ending| lower.ends_with(ending)) {
            continue;
        }
        fs::copy(entry.path(), to.join(&name))?;
    }
    Ok(())
}

/// Copies a folder tree, skipping symlinks and temporary files. Used for a guide's history
/// (`versions\`, `comments\`) when a guide moves between libraries.
pub(crate) fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    fs::create_dir_all(to)?;
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        if name.to_string_lossy().ends_with(".tmp") {
            continue;
        }
        if kind.is_dir() {
            copy_tree(&entry.path(), &to.join(&name))?;
        } else if kind.is_file() {
            fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

/// Reads the `formatVersion` of a guide or step and refuses one this app doesn't understand.
pub(crate) fn check_format_version(value: &Value, what: &str) -> Result<()> {
    match value.get("formatVersion").and_then(Value::as_u64) {
        Some(1) => Ok(()),
        Some(version) if version > 1 => Err(LibraryError::NewerFormat),
        _ => Err(LibraryError::Invalid(format!(
            "The {what} has no valid formatVersion."
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_json_file_too_large_to_be_a_guides_is_refused_before_it_is_read() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("guide.json");
        // Sparse: a file of 17 MB written in no time.
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_JSON_FILE + 1)
            .unwrap();
        assert!(read_json(&path).is_err());
        fs::write(&path, b"{}").unwrap();
        assert!(read_json(&path).is_ok());
    }

    #[test]
    fn ids_are_safe_and_distinct_even_in_one_clock_tick() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 1000);
        assert!(ids.iter().all(|id| is_safe_segment(id)));
    }

    #[test]
    fn unsafe_segments_are_refused() {
        for bad in [
            "",
            "..",
            "a/b",
            "a\\b",
            "C:",
            "a.b",
            "a b",
            &"x".repeat(129),
        ] {
            assert!(!is_safe_segment(bad), "{bad}");
        }
        assert!(is_safe_segment("capture-1_A"));
    }

    #[test]
    fn atomic_writes_replace_and_leave_no_temp_files() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("guide.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    #[test]
    fn timestamps_round_trip() {
        let now = now_iso();
        assert!(now.ends_with('Z'));
        assert!(parse_iso(&now).is_some());
    }
}
