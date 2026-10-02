//! Tauri commands for the library and editor: the list of libraries, guides, steps, images,
//! the bin, versions and `.amlsteps` files. The file logic lives in the `library` crate; this
//! layer resolves library ids to folders, keeps the recorder pointed at the default library,
//! and turns errors into `{ code, message }`.
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use library::{
    CommentThread, Commenter, Conflict, DraftInfo, EditLock, GuideDocument, GuideSummary, Library,
    LibraryEntry, LibraryError, LockOutcome, MediaInfo, Registry, Resolution, SearchHit,
    TrashEntry, VersionInfo,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::locks::LockService;
use crate::policy::Policy;
use crate::recorder::{CommandError, RecorderService};

/// A library as the UI lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    id: String,
    name: String,
    path: PathBuf,
    is_default: bool,
    /// Set by IT policy: shown read-only, and can't be renamed or removed.
    managed: bool,
    /// In a folder the sync client uploads: other people may see the unblurred originals.
    synced: bool,
    guide_count: usize,
}

/// The registry of libraries, loaded on first use (after the recorder has found its folders).
#[derive(Debug, Clone, Default)]
pub struct LibraryService {
    registry: Arc<Mutex<Option<Registry>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Turns a library error into the UI's `{ code, message }`, logging the ones worth a look.
fn command_error(error: LibraryError) -> CommandError {
    match &error {
        LibraryError::Storage(_) | LibraryError::Json(_) | LibraryError::MoveIncomplete(_) => {
            log::error!("Library operation failed: {error}");
        }
        LibraryError::ImportRejected(_) => log::warn!("Import refused: {error}"),
        _ => {}
    }
    CommandError::new(error.code(), error.to_string())
}

fn same_path(a: &Path, b: &Path) -> bool {
    let text = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    text(a) == text(b)
}

fn is_policy_library(policy: &Policy, path: &Path) -> bool {
    policy
        .libraries
        .iter()
        .any(|library| same_path(Path::new(&library.path), path))
}

fn set_by_policy() -> CommandError {
    CommandError::new(
        "setByPolicy",
        "Your organisation manages this setting, so it can't be changed here.",
    )
}

fn refuse_managed(registry: &Registry, id: &str) -> Result<(), CommandError> {
    let entry = registry.get(id).map_err(command_error)?;
    if is_policy_library(crate::policy::current(), &entry.path) {
        return Err(set_by_policy());
    }
    Ok(())
}

/// Adds the libraries IT policy names, and makes its default library the default. A policy
/// library is only added once its folder exists (a synced team library appears when the sync
/// client has downloaded it), so the app never creates a folder inside a sync client by itself.
fn apply_policy(registry: &mut Registry, recorder: &RecorderService, policy: &Policy) {
    for (index, library) in policy.libraries.iter().enumerate() {
        let path = Path::new(&library.path);
        if registry
            .libraries()
            .iter()
            .any(|entry| same_path(&entry.path, path))
        {
            continue;
        }
        if !path.is_dir() {
            // By number: a policy folder isn't registered yet, so support bundles wouldn't redact its path.
            log::warn!("policy: library {} folder not found yet", index + 1);
            continue;
        }
        if let Err(error) = registry.add(&library.name, path) {
            log::warn!("policy: library not added: {error}");
        }
    }
    let Some(wanted) = policy.default_library.as_deref() else {
        return;
    };
    let Some(entry) = registry
        .libraries()
        .iter()
        .find(|entry| {
            entry.name.eq_ignore_ascii_case(wanted) || same_path(&entry.path, Path::new(wanted))
        })
        .cloned()
    else {
        log::warn!("policy: default library not found: {wanted}");
        return;
    };
    if entry.id == registry.default_id() {
        return;
    }
    let previous = recorder.library_folder();
    if recorder.set_library_folder(entry.path.clone()).is_err() {
        return;
    }
    if let Err(error) = registry.set_default(&entry.id) {
        log::warn!("policy: default library not set: {error}");
        if let Some(previous) = previous {
            let _ = recorder.set_library_folder(previous);
        }
    }
}

impl LibraryService {
    /// Runs `action` on the registry, loading it (or creating it around the recorder's current
    /// folder) the first time.
    fn with_registry<T>(
        &self,
        recorder: &RecorderService,
        action: impl FnOnce(&mut Registry) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let mut guard = lock(&self.registry);
        if guard.is_none() {
            let not_ready =
                || CommandError::new("notReady", "The library folder is not initialized.");
            let app_data = recorder.app_data().ok_or_else(not_ready)?;
            let first = recorder.library_folder().ok_or_else(not_ready)?;
            let mut registry = Registry::open_or_seed(&app_data, &first).map_err(command_error)?;
            apply_policy(&mut registry, recorder, crate::policy::current());
            *guard = Some(registry);
        }
        match guard.as_mut() {
            Some(registry) => action(registry),
            None => Err(CommandError::new(
                "notReady",
                "The library list is not loaded.",
            )),
        }
    }

    /// The folder of a registered library. The registry lock is released before any guide work,
    /// so a slow thumbnail never holds up other commands.
    pub(crate) fn library(
        &self,
        recorder: &RecorderService,
        id: &str,
    ) -> Result<Library, CommandError> {
        self.with_registry(recorder, |registry| {
            registry
                .get(id)
                .map(|entry| Library::new(entry.path.clone()))
                .map_err(command_error)
        })
    }

    fn info(entry: &LibraryEntry, default_id: &str) -> LibraryInfo {
        LibraryInfo {
            id: entry.id.clone(),
            name: entry.name.clone(),
            path: entry.path.clone(),
            is_default: entry.id == default_id,
            managed: is_policy_library(crate::policy::current(), &entry.path),
            synced: crate::sync_folders::is_synced(&entry.path),
            guide_count: Library::new(entry.path.clone()).guide_count(),
        }
    }

    fn list(&self, recorder: &RecorderService) -> Result<Vec<LibraryInfo>, CommandError> {
        let (entries, default_id) = self.with_registry(recorder, |registry| {
            Ok((
                registry.libraries().to_vec(),
                registry.default_id().to_string(),
            ))
        })?;
        Ok(entries
            .iter()
            .map(|entry| Self::info(entry, &default_id))
            .collect())
    }

    fn add(
        &self,
        recorder: &RecorderService,
        name: &str,
        path: &Path,
    ) -> Result<LibraryInfo, CommandError> {
        // Counting the guides reads every guide.json, so it happens after the registry lock is
        // released; other library commands don't wait on a slow or synced folder.
        let (entry, default_id) = self.with_registry(recorder, |registry| {
            let entry = registry.add(name, path).map_err(command_error)?;
            Ok((entry, registry.default_id().to_string()))
        })?;
        Ok(Self::info(&entry, &default_id))
    }

    fn rename(
        &self,
        recorder: &RecorderService,
        id: &str,
        name: &str,
    ) -> Result<LibraryInfo, CommandError> {
        let (entry, default_id) = self.with_registry(recorder, |registry| {
            refuse_managed(registry, id)?;
            let entry = registry.rename(id, name).map_err(command_error)?;
            Ok((entry, registry.default_id().to_string()))
        })?;
        Ok(Self::info(&entry, &default_id))
    }

    fn remove(&self, recorder: &RecorderService, id: &str) -> Result<(), CommandError> {
        self.with_registry(recorder, |registry| {
            refuse_managed(registry, id)?;
            registry.remove(id).map_err(command_error)
        })
    }

    /// Makes a library the default and points the recorder at it. The recorder goes first
    /// because it refuses during a recording; if saving the registry then fails, the recorder
    /// is put back so the two never disagree.
    fn set_default(
        &self,
        recorder: &RecorderService,
        id: &str,
    ) -> Result<LibraryInfo, CommandError> {
        if crate::policy::current().default_library.is_some() {
            return Err(set_by_policy());
        }
        let (entry, default_id) = self.with_registry(recorder, |registry| {
            let entry = registry.get(id).map_err(command_error)?.clone();
            let previous = recorder.library_folder();
            recorder.set_library_folder(entry.path.clone())?;
            match registry.set_default(id) {
                Ok(entry) => Ok((entry, registry.default_id().to_string())),
                Err(error) => {
                    if let Some(previous) = previous {
                        let _ = recorder.set_library_folder(previous);
                    }
                    Err(command_error(error))
                }
            }
        })?;
        Ok(Self::info(&entry, &default_id))
    }
}

/// Runs `action` on a registered library.
fn in_library<T>(
    service: &LibraryService,
    recorder: &RecorderService,
    library_id: &str,
    action: impl FnOnce(&Library) -> library::Result<T>,
) -> Result<T, CommandError> {
    let library = service.library(recorder, library_id)?;
    action(&library).map_err(command_error)
}

/// Runs a change to a guide only while this run may write it: it holds the guide's edit lock, or
/// nobody does. A displaced editor's app is refused, so it can't overwrite the new editor's work;
/// its unsaved edits are kept as a draft instead (docs/spec/03-data-and-sharing.md).
fn in_guide_writing<T>(
    service: &LibraryService,
    recorder: &RecorderService,
    locks: &LockService,
    library_id: &str,
    guide_id: &str,
    action: impl FnOnce(&Library) -> library::Result<T>,
) -> Result<T, CommandError> {
    let library = service.library(recorder, library_id)?;
    if !library
        .may_write(guide_id, locks.session())
        .map_err(command_error)?
    {
        let who = library
            .read_lock(guide_id)
            .ok()
            .flatten()
            .map_or_else(|| "Someone else".to_string(), |lock| lock.name);
        return Err(CommandError::new(
            "lockLost",
            format!("{who} is editing this guide now, so this change wasn't saved here."),
        ));
    }
    action(&library).map_err(command_error)
}

/// Whether a guide opened for editing or read-only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Editing {
    /// This run holds the lock.
    Editing,
    /// Someone else does: the guide is read-only until they close it or their lock goes stale.
    ReadOnly { lock: EditLock },
}

// Every command touches the disk, so all are `async`: Tauri runs plain commands on the main
// thread, where a slow or disconnected drive would freeze every window.

/// Lists the registered libraries.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_libraries(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
) -> Result<Vec<LibraryInfo>, CommandError> {
    service.list(&recorder)
}

/// Registers a folder as a library, creating its folder structure.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_add_library(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    name: String,
    path: String,
) -> Result<LibraryInfo, CommandError> {
    service.add(&recorder, &name, Path::new(&path))
}

/// Renames a library in this PC's list.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_rename_library(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    name: String,
) -> Result<LibraryInfo, CommandError> {
    service.rename(&recorder, &library_id, &name)
}

/// Takes a library off the list. No files are deleted.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_remove_library(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
) -> Result<(), CommandError> {
    service.remove(&recorder, &library_id)
}

/// Makes a library the default, where new recordings are saved.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_set_default_library(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
) -> Result<LibraryInfo, CommandError> {
    service.set_default(&recorder, &library_id)
}

/// Lists a library's guides, newest change first.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_guides(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
) -> Result<Vec<GuideSummary>, CommandError> {
    in_library(&service, &recorder, &library_id, Library::list_guides)
}

/// The guides whose wording contains every word of `query`: steps, notes and blocks as well as
/// the title, tags and owner (docs/spec/04-editor.md#library-view).
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_search_guides(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    query: String,
) -> Result<Vec<SearchHit>, CommandError> {
    // Each search replaces the one before: typing a word starts several, and an older one stops
    // reading the library as soon as a newer one begins (the page ignores its answer anyway).
    static LATEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mine = LATEST.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    in_library(&service, &recorder, &library_id, |library| {
        library.search_while(&query, || {
            LATEST.load(std::sync::atomic::Ordering::SeqCst) == mine
        })
    })
}

/// Loads a guide and its steps.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_load_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
) -> Result<GuideDocument, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.load_guide(&guide_id)
    })
}

/// Creates a new, empty guide owned by the user.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_create_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    title: String,
) -> Result<GuideDocument, CommandError> {
    let author = recorder.display_name();
    in_library(&service, &recorder, &library_id, |library| {
        library.create_guide(&title, &author)
    })
}

/// Opens a guide for editing: takes its edit lock when nobody holds it, or when the holder is this
/// person on this PC (an earlier run that closed without letting go), or when this PC has seen the
/// holder's lock go stale. Otherwise the guide is read-only; the window asks again every half
/// minute, and "Take over editing" passes `take_over`.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_open_for_editing(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    take_over: bool,
) -> Result<Editing, CommandError> {
    let library = service.library(&recorder, &library_id)?;
    let holder = locks.holder(&recorder.display_name());
    let mut outcome = library
        .open_for_editing(&guide_id, &holder, take_over)
        .map_err(command_error)?;
    if let LockOutcome::Theirs { lock } = &outcome {
        let mine_before = lock.name == holder.name && lock.pc == holder.pc;
        let stale = library
            .lock_path(&guide_id)
            .is_ok_and(|path| locks.observe(&path, lock));
        if mine_before || stale {
            log::info!(
                "taking over guide {guide_id} from {} ({})",
                lock.name,
                if stale {
                    "stale"
                } else {
                    "this PC's earlier run"
                }
            );
            outcome = library
                .open_for_editing(&guide_id, &holder, true)
                .map_err(command_error)?;
        }
    }
    Ok(match outcome {
        LockOutcome::Mine { .. } => {
            locks.hold(&library_id, &guide_id, library.root());
            Editing::Editing
        }
        LockOutcome::Theirs { lock } => Editing::ReadOnly { lock },
    })
}

/// Lets go of a guide's edit lock when its editor closes.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_release_lock(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
) -> Result<(), CommandError> {
    locks.let_go(&library_id, &guide_id);
    in_library(&service, &recorder, &library_id, |library| {
        library.release_lock(&guide_id, locks.session())
    })
}

/// A fingerprint of the library's guides, for live refresh: the window asks every few seconds
/// and reloads the list when it changes (a synced change arrived).
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_fingerprint(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
) -> Result<String, CommandError> {
    in_library(&service, &recorder, &library_id, Library::fingerprint)
}

/// A fingerprint of one guide, for a read-only guide following someone else's changes.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_guide_fingerprint(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
) -> Result<String, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.guide_fingerprint(&guide_id)
    })
}

/// Conflict copies and restored steps in a guide, for someone to decide about.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_conflicts(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
) -> Result<Vec<Conflict>, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.list_conflicts(&guide_id)
    })
}

/// Settles a conflict. It changes the guide, so only while this run may write it.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_resolve_conflict(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    conflict: String,
    choice: Resolution,
) -> Result<(), CommandError> {
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| library.resolve_conflict(&guide_id, &conflict, choice),
    )
}

/// Keeps a displaced editor's unsaved guide as a draft on it. Not lock-checked: this is what an
/// editor who lost the lock does with the work it can no longer save.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_save_draft(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    draft: Value,
) -> Result<(), CommandError> {
    let by = locks.holder(&recorder.display_name()).name;
    in_library(&service, &recorder, &library_id, |library| {
        library.save_draft(&guide_id, locks.session(), &by, &draft)
    })
}

/// Who is commenting: the name in Settings and this PC.
fn commenter(recorder: &RecorderService, locks: &LockService) -> Commenter {
    let holder = locks.holder(&recorder.display_name());
    Commenter {
        name: holder.name,
        pc: holder.pc,
    }
}

/// The guide's review comment threads.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_comments(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
) -> Result<Vec<CommentThread>, CommandError> {
    let who = commenter(&recorder, &locks);
    in_library(&service, &recorder, &library_id, |library| {
        library.list_comments(&guide_id, &who)
    })
}

/// Starts a comment thread or replies to one. Comments are separate files that never change the
/// guide, so they don't need the edit lock: anyone can comment while someone else edits.
#[tauri::command(async, rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub fn library_add_comment(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    step_id: Option<String>,
    reply_to: Option<String>,
    text: String,
) -> Result<String, CommandError> {
    let who = commenter(&recorder, &locks);
    in_library(&service, &recorder, &library_id, |library| {
        library.add_comment(
            &guide_id,
            step_id.as_deref(),
            reply_to.as_deref(),
            &text,
            &who,
        )
    })
}

/// Resolves or reopens a comment thread (no edit lock needed).
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_resolve_comment(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    thread: String,
    resolved: bool,
) -> Result<(), CommandError> {
    let who = commenter(&recorder, &locks);
    in_library(&service, &recorder, &library_id, |library| {
        library.set_comment_resolved(&guide_id, &thread, resolved, &who)
    })
}

/// Deletes one of your own comments (no edit lock needed).
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_delete_comment(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    comment: String,
) -> Result<(), CommandError> {
    let who = commenter(&recorder, &locks);
    in_library(&service, &recorder, &library_id, |library| {
        library.delete_comment(&guide_id, &comment, &who)
    })
}

/// The guide's unsynced drafts.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_drafts(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
) -> Result<Vec<DraftInfo>, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.list_drafts(&guide_id)
    })
}

/// Deletes an unsynced draft.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_discard_draft(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    draft_id: String,
) -> Result<(), CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.discard_draft(&guide_id, &draft_id)
    })
}

/// Opens an unsynced draft as a new guide beside the original.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_draft_to_copy(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    draft_id: String,
    title: String,
) -> Result<GuideSummary, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.draft_to_copy(&guide_id, &draft_id, &title)
    })
}

/// Replaces a guide's `guide.json`.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_save_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    guide: Value,
) -> Result<(), CommandError> {
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| library.save_guide(&guide_id, &guide),
    )
}

/// Replaces or creates one step file.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_save_step(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    step: Value,
) -> Result<(), CommandError> {
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| {
            library.save_step(&guide_id, &step)?;
            // Saving a step this session deleted (Undo) isn't someone bringing it back.
            if let Some(step_id) = step.get("id").and_then(Value::as_str) {
                library.forget_own_delete(&guide_id, step_id, locks.session())?;
            }
            Ok(())
        },
    )
}

/// Deletes one step file (its screenshot stays).
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_delete_step(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    step_id: String,
) -> Result<(), CommandError> {
    let by = locks.holder(&recorder.display_name()).name;
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| {
            library.delete_step(&guide_id, &step_id)?;
            // So an edit someone else made meanwhile comes back flagged, not silently.
            library.note_delete(&guide_id, &step_id, &by, locks.session())
        },
    )
}

/// Stores a pasted, dropped or chosen image (PNG, JPEG or WebP) in a guide. The image is the
/// raw request body, with the library and guide ids in `x-library` and `x-guide`: sent as a
/// JSON array of numbers, a 50 MB image became about 200 MB of JSON before the size check.
#[tauri::command(async)]
pub fn library_import_image(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    request: tauri::ipc::Request<'_>,
) -> Result<MediaInfo, CommandError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "invalidRequest",
            "The image arrived in the wrong form.",
        ));
    };
    let id = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| CommandError::new("invalidRequest", "The image has no guide."))
    };
    let (library_id, guide_id) = (id("x-library")?, id("x-guide")?);
    in_library(&service, &recorder, &library_id, |library| {
        library.import_image(&guide_id, bytes)
    })
}

/// Retake for a saved guide: a new screenshot of the window in front after the countdown, stored
/// in the guide like any other image (docs/spec/04-editor.md#editing-steps), in the quality
/// Settings chose.
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri passes each argument by name."
)]
#[tauri::command(rename_all = "camelCase")]
pub async fn library_retake_image(
    app: AppHandle,
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    delay_ms: u64,
    excluded: Vec<String>,
    quality: Option<library::ScreenshotQuality>,
) -> Result<MediaInfo, CommandError> {
    let (service, recorder) = (service.inner().clone(), recorder.inner().clone());
    let quality = crate::policy::screenshot_quality(quality.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        let image = recorder.retake(&app, delay_ms, &excluded)?;
        in_library(&service, &recorder, &library_id, |library| {
            library.store_screenshot(&guide_id, image, quality)
        })
    })
    .await
    .map_err(|error| CommandError::new("screenshotFailed", error.to_string()))?
}

/// Returns an image, or its cached thumbnail, as a `data:image/webp;base64,…` URL.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_load_image(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    media_id: String,
    thumbnail: bool,
) -> Result<String, CommandError> {
    let bytes = in_library(&service, &recorder, &library_id, |library| {
        library.load_image(&guide_id, &media_id, thumbnail)
    })?;
    Ok(format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Moves a guide to the library's bin.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_trash_guide(
    app: tauri::AppHandle,
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
) -> Result<TrashEntry, CommandError> {
    // Not while someone else is editing it.
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| {
            // Text read from its screenshots goes with it (docs/spec/03-data-and-sharing.md#ocr-cache).
            if let Ok(files) = library.media_files(&guide_id) {
                crate::ocr_cache::forget_images(&app, &files);
            }
            library.trash_guide(&guide_id)
        },
    )
}

/// Lists the bin, emptying entries older than 30 days.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_trash(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
) -> Result<Vec<TrashEntry>, CommandError> {
    in_library(&service, &recorder, &library_id, Library::list_trash)
}

/// Restores a guide from the bin.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_restore_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    trash_id: String,
) -> Result<GuideSummary, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.restore_guide(&trash_id)
    })
}

/// Deletes a guide in the bin for good (asked for first in the UI: it can't be undone).
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_delete_trashed(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    trash_id: String,
) -> Result<(), CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.delete_trashed(&trash_id)
    })
}

/// Empties the bin for good; returns how many guides were deleted.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_empty_trash(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
) -> Result<usize, CommandError> {
    in_library(&service, &recorder, &library_id, Library::empty_trash)
}

/// A screenshot for a guide built from parts, and where it comes from.
#[derive(Debug, Deserialize)]
pub struct MediaFrom {
    #[serde(rename = "fromLibraryId")]
    library: String,
    #[serde(rename = "fromGuideId")]
    guide: String,
    #[serde(rename = "mediaId")]
    media: String,
    #[serde(rename = "newMediaId")]
    new_id: String,
}

/// Merge guides: writes a new guide worked out by the UI from parts of others (any libraries),
/// with their screenshots copied under new ids (docs/spec/04-editor.md#merge-guides). The
/// guides it came from are only read.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_create_from_parts(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide: Value,
    steps: Vec<Value>,
    media: Vec<MediaFrom>,
) -> Result<GuideSummary, CommandError> {
    let mut sources: std::collections::HashMap<String, Library> = std::collections::HashMap::new();
    let mut copies = Vec::with_capacity(media.len());
    for item in media {
        if !sources.contains_key(&item.library) {
            let source = service.library(&recorder, &item.library)?;
            sources.insert(item.library.clone(), source);
        }
        let source = sources
            .get(&item.library)
            .ok_or_else(|| CommandError::new("libraryNotFound", "That library isn't listed."))?;
        let copy = source
            .media_source(&item.guide, &item.media)
            .map_err(command_error)?;
        copies.push(library::MediaCopy {
            new_id: item.new_id,
            ..copy
        });
    }
    in_library(&service, &recorder, &library_id, |library| {
        library.create_from_parts(&guide, &steps, &copies)
    })
}

/// Copies a guide within its library under a new title.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_duplicate_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    title: String,
) -> Result<GuideSummary, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.duplicate_guide(&guide_id, &title)
    })
}

/// Copies a guide to another library.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_copy_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    from_library_id: String,
    guide_id: String,
    to_library_id: String,
) -> Result<GuideSummary, CommandError> {
    let target = service.library(&recorder, &to_library_id)?;
    in_library(&service, &recorder, &from_library_id, |library| {
        library.copy_guide_to(&guide_id, &target)
    })
}

/// Moves a guide to another library (copy, then the original goes to the bin). Not while
/// someone else is editing it: the move would take the guide from under them.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_move_guide(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    from_library_id: String,
    guide_id: String,
    to_library_id: String,
) -> Result<GuideSummary, CommandError> {
    let target = service.library(&recorder, &to_library_id)?;
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &from_library_id,
        &guide_id,
        |library| library.move_guide_to(&guide_id, &target),
    )
}

/// "Apply blur permanently": burns every blur into its screenshot, in the guide and its saved
/// versions, and deletes the unblurred originals. Returns how many screenshots changed.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_apply_redactions(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
) -> Result<usize, CommandError> {
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| library.apply_redactions(&guide_id),
    )
}

/// Saves the guide as it is now as a named version.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_save_version(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    note: String,
) -> Result<VersionInfo, CommandError> {
    let author = recorder.display_name();
    in_library(&service, &recorder, &library_id, |library| {
        library.save_version(&guide_id, &note, &author)
    })
}

/// Lists a guide's saved versions, newest first.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_list_versions(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
) -> Result<Vec<VersionInfo>, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.list_versions(&guide_id)
    })
}

/// Loads a saved version for viewing.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_load_version(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    version_id: String,
) -> Result<GuideDocument, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.load_version(&guide_id, &version_id)
    })
}

/// Restores a saved version, saving the current state as a version first.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_restore_version(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    locks: State<'_, LockService>,
    library_id: String,
    guide_id: String,
    version_id: String,
) -> Result<GuideDocument, CommandError> {
    let author = recorder.display_name();
    in_guide_writing(
        &service,
        &recorder,
        &locks,
        &library_id,
        &guide_id,
        |library| library.restore_version(&guide_id, &version_id, &author),
    )
}

/// Saves a guide as an `.amlsteps` file. Redactions are burned in and originals left out unless
/// `include_originals` is set; hidden typed values are always left out.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_export_amlsteps(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    guide_id: String,
    destination: String,
    include_originals: bool,
) -> Result<(), CommandError> {
    // IT can lock originals out of .amlsteps files; the UI hides the choice, and this holds even
    // if it didn't.
    if include_originals && crate::policy::current().is_locked("IncludeOriginals") {
        return Err(set_by_policy());
    }
    in_library(&service, &recorder, &library_id, |library| {
        library.export_amlsteps(
            &guide_id,
            Path::new(&destination),
            include_originals,
            env!("CARGO_PKG_VERSION"),
        )
    })
}

/// Imports an `.amlsteps` file as a new guide, applying every hostile-file rule. On any
/// failure nothing is imported and the error names the rule.
#[tauri::command(async, rename_all = "camelCase")]
pub fn library_import_amlsteps(
    service: State<'_, LibraryService>,
    recorder: State<'_, RecorderService>,
    library_id: String,
    source: String,
) -> Result<GuideSummary, CommandError> {
    in_library(&service, &recorder, &library_id, |library| {
        library.import_amlsteps(Path::new(&source))
    })
}
