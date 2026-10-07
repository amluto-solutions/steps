//! Stopped recordings: drafts, recovery after a crash, and publishing to the library.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use base64::Engine;
use capture::state_machine::RecorderState;
use image::RgbaImage;
use library::MediaInfo;
use serde_json::Value;

#[cfg(test)]
use super::GuideSummary;
use super::files::{
    read_recording_settings, read_records, read_restart, read_steps, step_sequence,
    write_json_atomic, write_json_new, write_new_bytes,
};
use super::journal::screenshot_webp;
use super::recording::RecordingSettings;
use super::{
    CommandError, GuideDocument, Inner, RecorderService, RecorderSnapshot, RecoverySession,
    Session, lock, manual_media_id, safe_segment, session_directory, snapshot_locked,
    storage_error, unique_id,
};

impl RecorderService {
    /// Stores a retaken screenshot in an unsaved recording's own folder, where its other
    /// screenshots are; Save guide copies it into the library with them.
    pub(crate) fn store_draft_image(
        &self,
        session_id: &str,
        image: RgbaImage,
        quality: library::ScreenshotQuality,
    ) -> Result<MediaInfo, CommandError> {
        let directory = {
            let inner = lock(&self.inner);
            draft_session_directory(&inner, session_id)?
        };
        let (bytes, width, height) = screenshot_webp(image, quality).map_err(storage_error)?;
        let id = format!("retake-{}", manual_media_id());
        write_new_bytes(&directory.join("media").join(format!("{id}.webp")), &bytes)
            .map_err(storage_error)?;
        Ok(MediaInfo { id, width, height })
    }

    /// The "Start again" point of a recording, for rebuilding its steps after a restart.
    pub(super) fn restart_point(&self, session_id: &str) -> Result<Option<u64>, CommandError> {
        let inner = lock(&self.inner);
        Ok(read_restart(&session_directory(&inner, session_id)?))
    }

    /// The settings a recording started with, for building its steps again; None for one made
    /// before they were kept.
    pub(super) fn recording_settings(
        &self,
        session_id: &str,
    ) -> Result<Option<RecordingSettings>, CommandError> {
        let inner = lock(&self.inner);
        Ok(read_recording_settings(&session_directory(
            &inner, session_id,
        )?))
    }

    /// Saves the whole draft of a stopped recording (the editor's copy before it is published),
    /// replacing any earlier draft in one rename. Edits after this go file by file.
    pub(super) fn save_draft(
        &self,
        session_id: &str,
        guide: &Value,
        steps: &[Value],
    ) -> Result<(), CommandError> {
        let inner = lock(&self.inner);
        let directory = draft_session_directory(&inner, session_id)?;
        let staging = directory.join(format!(".draft-{}", unique_id()));
        let result = write_whole_draft(&directory, &staging, guide, steps);
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub(super) fn save_draft_guide(
        &self,
        session_id: &str,
        guide: &Value,
    ) -> Result<(), CommandError> {
        let inner = lock(&self.inner);
        let draft = draft_session_directory(&inner, session_id)?.join("draft");
        require_draft(&draft)?;
        write_json_atomic(&draft.join("guide.json"), guide)
    }

    pub(super) fn save_draft_step(
        &self,
        session_id: &str,
        step: &Value,
    ) -> Result<(), CommandError> {
        let inner = lock(&self.inner);
        let draft = draft_session_directory(&inner, session_id)?.join("draft");
        require_draft(&draft)?;
        let id = draft_step_id(step)?;
        write_json_atomic(&draft.join("steps").join(format!("{id}.json")), step)
    }

    pub(super) fn delete_draft_step(
        &self,
        session_id: &str,
        step_id: &str,
    ) -> Result<(), CommandError> {
        if !safe_segment(step_id) {
            return Err(CommandError::new(
                "invalidStep",
                "The step has an invalid id.",
            ));
        }
        let inner = lock(&self.inner);
        let draft = draft_session_directory(&inner, session_id)?.join("draft");
        require_draft(&draft)?;
        match fs::remove_file(draft.join("steps").join(format!("{step_id}.json"))) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(storage_error(error)),
            _ => Ok(()),
        }
    }

    /// The saved draft, if the editor has opened this recording before.
    pub(super) fn load_draft(
        &self,
        session_id: &str,
    ) -> Result<Option<GuideDocument>, CommandError> {
        let inner = lock(&self.inner);
        let draft = session_directory(&inner, session_id)?.join("draft");
        if !draft.join("guide.json").is_file() {
            return Ok(None);
        }
        let guide =
            serde_json::from_slice(&fs::read(draft.join("guide.json")).map_err(storage_error)?)
                .map_err(storage_error)?;
        let steps = read_steps(&draft.join("steps"))?;
        Ok(Some(GuideDocument { guide, steps }))
    }

    pub(super) fn append_step(&self, session_id: &str, step: &Value) -> Result<(), CommandError> {
        let inner = lock(&self.inner);
        let directory = session_directory(&inner, session_id)?;
        let id = step
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| safe_segment(id))
            .ok_or_else(|| CommandError::new("invalidStep", "The step has an invalid id."))?;
        let path = directory.join("steps").join(format!("{id}.json"));
        if path.exists() {
            return Ok(());
        }
        let mut step = step.clone();
        step["updatedBy"] = Value::String(session_author(&directory)?);
        write_json_new(&path, &step)
    }

    /// Publishes a stopped recording to the default library, or to `target` (Save as). The
    /// recorder lock is held only to read where things are and to forget the session afterwards:
    /// copying the screenshots to a synced folder can take a while, and every other recorder
    /// command would wait for it.
    pub(super) fn finalize(
        &self,
        session_id: &str,
        guide: &Value,
        target: Option<PathBuf>,
    ) -> Result<(), CommandError> {
        // One publish at a time, so a double-clicked Save can't race itself.
        let _publishing = lock(&PUBLISHING);
        let (library, root) = {
            let inner = lock(&self.inner);
            if lock(&inner.machine).state() != &RecorderState::Idle {
                return Err(CommandError::new(
                    "stillRecording",
                    "Wait for recording to finish before saving the guide.",
                ));
            }
            let library = target.or_else(|| inner.library.clone()).ok_or_else(|| {
                CommandError::new("notReady", "The library folder is not initialized.")
            })?;
            (library, recordings_root(&inner)?)
        };
        let guide_id = guide
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| safe_segment(id))
            .ok_or_else(|| CommandError::new("invalidGuide", "The guide has an invalid id."))?;
        // Already published (perhaps to a library that isn't the default any more, or is offline
        // now): only the clean-up is left.
        if read_published(&root, session_id).is_some() {
            return self.forget_published(session_id);
        }
        let staging = library
            .join("guides")
            .join(format!(".finalizing-{guide_id}-{}", unique_id()));
        let destination = library.join("guides").join(guide_id);
        if destination.exists() {
            let published: Value = serde_json::from_slice(
                &fs::read(destination.join("guide.json")).map_err(storage_error)?,
            )
            .map_err(storage_error)?;
            if published.get("id").and_then(Value::as_str) == Some(guide_id)
                && published.get("recordingSessionId").and_then(Value::as_str) == Some(session_id)
            {
                let _ = write_published(&root, session_id, guide_id, &library);
                return self.forget_published(session_id);
            }
            return Err(CommandError::new(
                "guideExists",
                "A guide with this id already exists.",
            ));
        }
        let session_directory = {
            let inner = lock(&self.inner);
            session_directory(&inner, session_id)?
        };
        // Anything that fails part-way removes the staging folder: otherwise each failed save
        // (a full disk, a file a sync client holds) leaves a partial copy in the library, where
        // it syncs to everyone and is never listed or cleaned up.
        if let Err(error) = stage_and_publish(
            &session_directory,
            session_id,
            guide,
            &staging,
            &destination,
        ) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        // If the clean-up below fails, this is how the next start knows the guide is saved,
        // whichever library is the default by then.
        let _ = write_published(&root, session_id, guide_id, &library);
        self.forget_published(session_id)
    }

    /// Removes a published recording's journal and forgets it as the current session. The
    /// folder is removed without the recorder lock held.
    fn forget_published(&self, session_id: &str) -> Result<(), CommandError> {
        let root = {
            let inner = lock(&self.inner);
            recordings_root(&inner)?
        };
        remove_session_folder(&root, session_id)?;
        let mut inner = lock(&self.inner);
        if inner
            .session
            .as_ref()
            .is_some_and(|session| session.id == session_id)
        {
            inner.session = None;
        }
        Ok(())
    }

    /// Recordings left in app data: unsaved ones (after a crash, or stopped but not yet saved)
    /// and published ones whose clean-up didn't finish. The folders are read without the
    /// recorder lock held; a library in a synced folder may download each file it reads.
    pub(super) fn recoveries(&self) -> Result<Vec<RecoverySession>, CommandError> {
        let (root, library, active) = {
            let inner = lock(&self.inner);
            (
                recordings_root(&inner)?,
                inner.library.clone(),
                inner.session.as_ref().map(|session| session.id.clone()),
            )
        };
        let mut sessions = Vec::new();
        // Reading every guide in the library is only needed for a recording without a marker
        // (one published before markers existed, or whose marker couldn't be written).
        let mut scanned: Option<std::collections::HashMap<String, (String, String)>> = None;
        let mut published_in_library =
            |session_id: &str| -> Result<Option<(String, String)>, CommandError> {
                if scanned.is_none() {
                    scanned = Some(published_sessions(library.as_deref())?);
                }
                Ok(scanned
                    .as_ref()
                    .and_then(|published| published.get(session_id).cloned()))
            };
        for entry in fs::read_dir(&root).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            let directory = entry.path();
            if !directory.is_dir() {
                continue;
            }
            let Some(session_id) = directory.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !safe_segment(session_id) {
                continue;
            }
            let title = fs::read(directory.join("session.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|session| {
                    session
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "Recovered guide".into());
            let published = match read_published(&root, session_id) {
                Some(guide_id) => Some((guide_id, title.clone())),
                None => published_in_library(session_id)?,
            };
            if let Some((guide_id, title)) = published {
                sessions.push(RecoverySession {
                    session_id: session_id.to_string(),
                    title,
                    event_count: 0,
                    stopped: true,
                    saved_guide_id: Some(guide_id),
                });
                continue;
            }
            // A kill during session setup may leave no events directory at all.
            let events = match fs::read_dir(directory.join("events")) {
                Ok(events) => events,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(storage_error(error)),
            };
            let event_count = events
                .filter_map(Result::ok)
                .filter(|record| record.path().extension().is_some_and(|ext| ext == "json"))
                .count();
            if event_count == 0
                && !directory.join(".stopped").exists()
                && active.as_deref() != Some(session_id)
            {
                continue;
            }
            sessions.push(RecoverySession {
                session_id: session_id.to_string(),
                title,
                event_count,
                stopped: directory.join(".stopped").exists(),
                saved_guide_id: None,
            });
        }
        if let Some(active) = &active
            && !sessions.iter().any(|session| &session.session_id == active)
            && let Some((guide_id, title)) = published_in_library(active)?
        {
            sessions.push(RecoverySession {
                session_id: active.clone(),
                title,
                event_count: 0,
                stopped: true,
                saved_guide_id: Some(guide_id),
            });
        }
        sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Ok(sessions)
    }

    pub(super) fn recover_session(
        &self,
        session_id: &str,
    ) -> Result<RecorderSnapshot, CommandError> {
        let mut inner = lock(&self.inner);
        // Only a recording still being made stops another opening. One opened earlier and set
        // aside (04/10/2026: "A recording is already in progress" for the second of two unsaved
        // recordings) is let go: it's all on disk, and stays in the list.
        if lock(&inner.machine).state() != &RecorderState::Idle {
            return Err(CommandError::new(
                "busy",
                "Save or discard the current recording before recovering another.",
            ));
        }
        let directory = session_directory(&inner, session_id)?;
        let metadata: Value = serde_json::from_slice(
            &fs::read(directory.join("session.json")).map_err(storage_error)?,
        )
        .map_err(storage_error)?;
        if metadata.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            return Err(CommandError::new(
                "invalidSession",
                "The recording metadata does not match its id.",
            ));
        }
        let has_events = fs::read_dir(directory.join("events"))
            .map_err(storage_error)?
            .filter_map(Result::ok)
            .any(|entry| entry.path().extension().is_some_and(|ext| ext == "json"));
        if !has_events && !directory.join(".stopped").exists() {
            return Err(CommandError::new(
                "incompleteSession",
                "This recording stopped before capture began.",
            ));
        }
        let restart = read_restart(&directory);
        inner.session = Some(Session {
            id: session_id.to_string(),
            directory,
            sequence: Arc::new(AtomicU64::new(0)),
            gap: Arc::default(),
            backlog: Arc::default(),
            restart,
            undo_restart: None,
        });
        Ok(snapshot_locked(&inner))
    }

    pub(super) fn recovery_records(&self, session_id: &str) -> Result<Vec<Value>, CommandError> {
        let inner = lock(&self.inner);
        let directory = session_directory(&inner, session_id)?;
        read_records(&directory)
    }

    pub(super) fn session_steps(&self, session_id: &str) -> Result<Vec<Value>, CommandError> {
        let inner = lock(&self.inner);
        let directory = session_directory(&inner, session_id)?;
        read_steps(&directory.join("steps"))
    }

    #[cfg(test)]
    pub(super) fn list_guides(&self) -> Result<Vec<GuideSummary>, CommandError> {
        let inner = lock(&self.inner);
        let guides = inner
            .library
            .as_ref()
            .ok_or_else(|| CommandError::new("notReady", "The library folder is not initialized."))?
            .join("guides");
        let mut result = Vec::new();
        for entry in fs::read_dir(guides).map_err(storage_error)? {
            let entry = entry.map_err(storage_error)?;
            // Staging may already contain guide.json while screenshots are still being copied.
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".finalizing-")
            {
                continue;
            }
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            // The folder name is the id `load_guide` opens. A guide.json claiming another id (a
            // copied folder) or an unreadable one is skipped, not allowed to break the list.
            let folder = entry.file_name().to_string_lossy().into_owned();
            if !safe_segment(&folder) {
                continue;
            }
            let guide_path = entry.path().join("guide.json");
            let Ok(bytes) = fs::read(guide_path) else {
                continue;
            };
            let Ok(guide) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let id = folder.as_str();
            if guide.get("id").and_then(Value::as_str) != Some(id) {
                continue;
            }
            let title = guide
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled guide");
            let updated_at = guide
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // A steps folder a sync client hasn't delivered yet counts as empty.
            let step_count = fs::read_dir(entry.path().join("steps")).map_or(0, |steps| {
                steps
                    .filter_map(Result::ok)
                    .filter(|step| step.path().extension().is_some_and(|ext| ext == "json"))
                    .count()
            });
            result.push(GuideSummary {
                id: id.to_string(),
                title: title.to_string(),
                updated_at: updated_at.to_string(),
                step_count,
            });
        }
        result.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(result)
    }

    pub(super) fn image_data(&self, session_id: &str, name: &str) -> Result<String, CommandError> {
        // The stem is checked, not the whole name: `safe_segment` refuses the dot in
        // `click-1.webp`, which once refused every screenshot.
        let valid_name = name.rsplit_once('.').is_some_and(|(stem, extension)| {
            safe_segment(stem) && extension.eq_ignore_ascii_case("webp")
        });
        if !safe_segment(session_id) || !valid_name {
            return Err(CommandError::new(
                "invalidImage",
                "The image reference is invalid.",
            ));
        }
        let inner = lock(&self.inner);
        let recording_path = session_directory(&inner, session_id)
            .ok()
            .map(|directory| directory.join("media").join(name));
        let guide_path = inner.library.as_ref().map(|library| {
            library
                .join("guides")
                .join(session_id)
                .join("media")
                .join(name)
        });
        let path = recording_path
            .filter(|path| path.is_file())
            .or_else(|| guide_path.filter(|path| path.is_file()))
            .ok_or_else(|| CommandError::new("imageNotFound", "The screenshot was not found."))?;
        let bytes = fs::read(path).map_err(storage_error)?;
        Ok(format!(
            "data:image/webp;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}

/// Builds the guide in `staging` (guide.json, the recording's steps, the screenshots they use)
/// and renames it to `destination` in one step. The caller removes `staging` on error.
pub(super) fn stage_and_publish(
    session_directory: &Path,
    session_id: &str,
    guide: &Value,
    staging: &Path,
    destination: &Path,
) -> Result<(), CommandError> {
    fs::create_dir_all(staging.join("steps")).map_err(storage_error)?;
    fs::create_dir_all(staging.join("media")).map_err(storage_error)?;
    let mut guide = guide.clone();
    guide["recordingSessionId"] = Value::String(session_id.to_string());
    let author = session_author(session_directory)?;
    for field in ["owner", "createdBy", "updatedBy"] {
        guide[field] = Value::String(author.clone());
    }
    let guide_file = serde_json::to_vec_pretty(&guide).map_err(storage_error)?;
    write_new_bytes(&staging.join("guide.json"), &guide_file).map_err(storage_error)?;

    // The editor's draft is what the user reviewed, so it is published when there is one.
    // Without a draft, steps from before a "Start again" are left out.
    let from_draft = session_directory.join("draft").join("guide.json").is_file();
    let session_steps = if from_draft {
        session_directory.join("draft").join("steps")
    } else {
        session_directory.join("steps")
    };
    let restart = if from_draft {
        None
    } else {
        read_restart(session_directory)
    };
    let mut referenced_media = std::collections::BTreeSet::new();
    for entry in fs::read_dir(&session_steps).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let name = entry.file_name();
            if let (Some(after), Some(sequence)) = (restart, step_sequence(&name.to_string_lossy()))
                && sequence <= after
            {
                continue;
            }
            let bytes = fs::read(entry.path()).map_err(storage_error)?;
            if let Some(media_id) = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .as_ref()
                .and_then(|step| step.pointer("/media/id"))
                .and_then(Value::as_str)
                .filter(|id| safe_segment(id))
            {
                referenced_media.insert(format!("{media_id}.webp"));
            }
            write_new_bytes(&staging.join("steps").join(name), &bytes).map_err(storage_error)?;
        }
    }
    // Only screenshots a step uses are published. Others (a cancelled Add shortcut, a
    // capture whose fact couldn't be saved) must never reach a possibly shared library.
    let media_source = session_directory.join("media");
    for name in &referenced_media {
        let source = media_source.join(name);
        if source.is_file() {
            fs::copy(&source, staging.join("media").join(name)).map_err(storage_error)?;
        }
    }
    fs::rename(staging, destination).map_err(storage_error)
}

/// Serialises publishing (see `RecorderService::finalize`).
static PUBLISHING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn recordings_root(inner: &Inner) -> Result<PathBuf, CommandError> {
    Ok(inner
        .app_data
        .as_ref()
        .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?
        .join("recordings"))
}

/// Removes `<root>/<session_id>`, refusing a folder that resolves anywhere else.
pub(super) fn remove_session_folder(root: &Path, session_id: &str) -> Result<(), CommandError> {
    if !safe_segment(session_id) {
        return Err(CommandError::new(
            "invalidSession",
            "The recording id is invalid.",
        ));
    }
    let directory = root.join(session_id);
    match fs::canonicalize(&directory) {
        Ok(resolved) => {
            let expected = fs::canonicalize(root)
                .map_err(storage_error)?
                .join(session_id);
            if resolved != expected {
                return Err(CommandError::new(
                    "invalidSession",
                    "The recording folder points outside its expected location.",
                ));
            }
            fs::remove_dir_all(&resolved).map_err(storage_error)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(storage_error(error)),
    }
    // The marker goes last: while any of the folder is left, it says the guide is saved.
    match fs::remove_file(published_marker(root, session_id)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(storage_error(error)),
        _ => Ok(()),
    }
}

/// `<session>.published.json` beside a recording's folder: written once its guide is in a
/// library, so a clean-up that failed is finished later, even if that library is offline or no
/// longer the default by then, instead of the recording being offered for saving a second time.
/// It sits outside the folder so a delete that stops part-way can't remove it first.
fn published_marker(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{session_id}.published.json"))
}

fn write_published(
    root: &Path,
    session_id: &str,
    guide_id: &str,
    library: &Path,
) -> Result<(), CommandError> {
    write_json_atomic(
        &published_marker(root, session_id),
        &serde_json::json!({ "guideId": guide_id, "library": library.to_string_lossy() }),
    )
}

/// The guide id a recording was published as, if its marker says so.
pub(super) fn read_published(root: &Path, session_id: &str) -> Option<String> {
    let bytes = fs::read(published_marker(root, session_id)).ok()?;
    let marker: Value = serde_json::from_slice(&bytes).ok()?;
    marker
        .get("guideId")
        .and_then(Value::as_str)
        .filter(|id| safe_segment(id))
        .map(str::to_string)
}

pub(super) fn published_sessions(
    library: Option<&Path>,
) -> Result<std::collections::HashMap<String, (String, String)>, CommandError> {
    let mut result = std::collections::HashMap::new();
    let Some(library) = library else {
        return Ok(result);
    };
    for entry in fs::read_dir(library.join("guides")).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !safe_segment(&name) {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path().join("guide.json")) else {
            continue;
        };
        let Ok(guide) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if guide.get("id").and_then(Value::as_str) != Some(name.as_str()) {
            continue;
        }
        let Some(session_id) = guide
            .get("recordingSessionId")
            .and_then(Value::as_str)
            .filter(|id| safe_segment(id))
        else {
            continue;
        };
        let title = guide
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Recovered guide")
            .to_string();
        result.insert(session_id.to_string(), (name, title));
    }
    Ok(result)
}

pub(super) fn draft_step_id(step: &Value) -> Result<&str, CommandError> {
    step.get("id")
        .and_then(Value::as_str)
        .filter(|id| safe_segment(id))
        .ok_or_else(|| CommandError::new("invalidStep", "The step has an invalid id."))
}

pub(super) fn require_draft(draft: &Path) -> Result<(), CommandError> {
    if draft.join("guide.json").is_file() {
        Ok(())
    } else {
        Err(CommandError::new(
            "noDraft",
            "This recording has no draft to edit yet.",
        ))
    }
}

/// Drafts are edited only once recording has stopped, so the journal is complete.
pub(super) fn draft_session_directory(
    inner: &Inner,
    session_id: &str,
) -> Result<PathBuf, CommandError> {
    if lock(&inner.machine).state() != &RecorderState::Idle {
        return Err(CommandError::new(
            "stillRecording",
            "Wait for recording to finish before editing the guide.",
        ));
    }
    session_directory(inner, session_id)
}

pub(super) fn write_whole_draft(
    directory: &Path,
    staging: &Path,
    guide: &Value,
    steps: &[Value],
) -> Result<(), CommandError> {
    fs::create_dir_all(staging.join("steps")).map_err(storage_error)?;
    write_json_atomic(&staging.join("guide.json"), guide)?;
    for step in steps {
        let id = draft_step_id(step)?;
        write_json_atomic(&staging.join("steps").join(format!("{id}.json")), step)?;
    }
    let draft = directory.join("draft");
    if draft.exists() {
        fs::remove_dir_all(&draft).map_err(storage_error)?;
    }
    fs::rename(staging, &draft).map_err(storage_error)
}

pub(super) fn session_author(directory: &Path) -> Result<String, CommandError> {
    let metadata: Value =
        serde_json::from_slice(&fs::read(directory.join("session.json")).map_err(storage_error)?)
            .map_err(storage_error)?;
    Ok(metadata
        .get("author")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}
