//! Atomic and create-new file writes, and the journal's records and steps on disk.

use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use serde_json::{Value, json};

use super::{CommandError, storage_error, unique_id};

pub(super) fn write_marker(path: &Path) -> std::io::Result<()> {
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.sync_all()
}

/// `restart.json` in the session folder: facts up to `afterSequence` were dropped by "Start
/// again". A missing or unreadable file means nothing was dropped.
pub(super) fn read_restart(directory: &Path) -> Option<u64> {
    let bytes = fs::read(directory.join("restart.json")).ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()?
        .get("afterSequence")
        .and_then(Value::as_u64)
}

pub(super) fn write_restart(directory: &Path, after: Option<u64>) -> Result<(), CommandError> {
    let path = directory.join("restart.json");
    match after {
        Some(after) => write_json_atomic(
            &path,
            &json!({ "formatVersion": 1, "afterSequence": after }),
        ),
        None => match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(storage_error(error)),
            _ => Ok(()),
        },
    }
}

/// The capture sequence a recorded step came from (`capture-<sequence>`), if it has one.
pub(super) fn step_sequence(step_file_name: &str) -> Option<u64> {
    step_file_name
        .strip_prefix("capture-")?
        .strip_suffix(".json")?
        .parse()
        .ok()
}

/// Replaces a file with new JSON through a flushed temporary file and a rename, so a crash
/// leaves either the old or the new version, never half of one.
pub(super) fn write_json_atomic(path: &Path, value: &Value) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(storage_error)?;
    let temporary = path.with_extension(format!("{}.tmp", unique_id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(storage_error)
}

pub(super) fn write_json_new(path: &Path, value: &Value) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(storage_error)?;
    write_new_bytes_atomic(path, &bytes).map_err(storage_error)
}

pub(super) fn write_new_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_new_file(path, |file| {
        file.write_all(bytes)?;
        file.sync_all()
    })
}

/// Creates `path` (never overwriting) and fills it. If filling fails, e.g. the disk fills
/// part-way, the truncated file is removed: a half screenshot is junk, and a half
/// `.amluto-library.json` would stop the app ever writing a good one (it only writes when the
/// file is missing).
pub(super) fn write_new_file(
    path: &Path,
    write_contents: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let filled = write_contents(&mut file);
    if filled.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
    }
    filled
}

pub(super) fn write_new_bytes_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("data");
    let temporary = path.with_extension(format!("{extension}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn ensure_library_metadata(library: &Path) -> Result<(), String> {
    let path = library.join(".amluto-library.json");
    if path.exists() {
        return Ok(());
    }
    let bytes = serde_json::to_vec_pretty(&json!({
        "id": unique_id(),
        "name": "Steps",
        "formatVersion": 1
    }))
    .map_err(|error| error.to_string())?;
    write_new_bytes(&path, &bytes).map_err(|error| error.to_string())
}

pub(super) fn read_records(directory: &Path) -> Result<Vec<Value>, CommandError> {
    let events = directory.join("events");
    let mut paths = fs::read_dir(events)
        .map_err(storage_error)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            serde_json::from_slice(&fs::read(path).map_err(storage_error)?).map_err(storage_error)
        })
        .collect()
}

pub(super) fn read_steps(directory: &Path) -> Result<Vec<Value>, CommandError> {
    let mut steps = Vec::new();
    for entry in fs::read_dir(directory).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let value = serde_json::from_slice(&fs::read(entry.path()).map_err(storage_error)?)
                .map_err(storage_error)?;
            steps.push(value);
        }
    }
    steps.sort_by(|left: &Value, right: &Value| {
        left.get("sortKey")
            .and_then(Value::as_str)
            .cmp(&right.get("sortKey").and_then(Value::as_str))
    });
    Ok(steps)
}
