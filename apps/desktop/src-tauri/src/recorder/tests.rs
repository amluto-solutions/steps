use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::json;

use super::files::{
    ensure_library_metadata, read_records, read_restart, step_sequence, write_new_bytes,
    write_new_bytes_atomic, write_new_file, write_restart,
};
use super::preferences::{read_preferences, validate_preferences};
use super::*;

/// Makes the clean-up of a recording's journal fail while it's held, as a sync client holding a
/// file does. Windows refuses to delete a file another handle has open without sharing; Linux has
/// no such lock, so the file's folder is made read-only instead (which holds for any user but
/// root).
struct CleanupBlocker {
    #[cfg(windows)]
    _handle: fs::File,
    #[cfg(not(windows))]
    folder: std::path::PathBuf,
}

fn block_cleanup(file: &Path) -> CleanupBlocker {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        CleanupBlocker {
            _handle: fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(file)
                .unwrap(),
        }
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let folder = file.parent().unwrap().to_path_buf();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        CleanupBlocker { folder }
    }
}

#[cfg(not(windows))]
impl Drop for CleanupBlocker {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&self.folder, fs::Permissions::from_mode(0o755));
    }
}

#[test]
fn manual_media_ids_are_safe_for_the_javascript_bridge() {
    let id = manual_media_id();
    assert!(id > 0);
    assert!(id <= 9_007_199_254_740_991);
}

#[test]
fn interrupted_session_can_be_reopened_for_review() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("recordings/session-1");
    fs::create_dir_all(directory.join("events")).unwrap();
    fs::write(
        directory.join("session.json"),
        br#"{"sessionId":"session-1","title":"Interrupted"}"#,
    )
    .unwrap();
    fs::write(directory.join("events/0001.json"), b"{}").unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());

    let snapshot = service.recover_session("session-1").unwrap();
    assert_eq!(snapshot.session_id.as_deref(), Some("session-1"));
    assert_eq!(snapshot.state, "idle");
    assert!(service.recover_session("session-1").is_err());
}

#[test]
fn finished_session_counts_disappear_when_guide_is_saved_or_discarded() {
    let mut state = RecorderStateMachine::new(Vec::new());
    state.start().unwrap();
    state.note_step_processed(1);
    state.stop(100).unwrap();
    state.finish_stopping().unwrap();
    let machine = Mutex::new(state);

    assert_eq!(
        snapshot_from(&machine, Some("session-1"), InputSource::RawInput).step_count,
        1
    );
    let finished = snapshot_from(&machine, None, InputSource::RawInput);
    assert_eq!(finished.step_count, 0);
    assert_eq!(finished.missed_count, 0);
}

#[test]
fn published_guide_can_finish_cleanup_after_the_whole_journal_folder_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    fs::create_dir_all(root.path().join("recordings")).unwrap();
    let guide = library.join("guides/guide-1");
    fs::create_dir_all(&guide).unwrap();
    fs::write(
        guide.join("guide.json"),
        br#"{"id":"guide-1","title":"Saved","recordingSessionId":"session-1"}"#,
    )
    .unwrap();
    lock(&service.inner).session = Some(Session {
        id: "session-1".into(),
        directory: root.path().join("recordings/session-1"),
        sequence: Arc::new(AtomicU64::new(1)),
        gap: Arc::default(),
        restart: None,
        undo_restart: None,
    });
    let pending = service.recoveries().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].saved_guide_id.as_deref(), Some("guide-1"));
    service
        .finalize("session-1", &json!({"id":"guide-1"}), None)
        .unwrap();
    assert!(lock(&service.inner).session.is_none());
    assert!(guide.join("guide.json").exists());
}

#[test]
fn stopped_empty_session_is_recoverable_and_step_files_ignore_temporary_writes() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: root.path().join("library"),
        })
        .unwrap();
    let session = root.path().join("recordings/session-1");
    fs::create_dir_all(session.join("events")).unwrap();
    fs::create_dir_all(session.join("steps")).unwrap();
    fs::write(session.join("session.json"), br#"{"title":"Empty guide"}"#).unwrap();
    fs::write(session.join(".stopped"), b"").unwrap();
    fs::write(
        session.join("steps/step-2.json"),
        br#"{"id":"step-2","sortKey":"2"}"#,
    )
    .unwrap();
    fs::write(
        session.join("steps/step-1.json"),
        br#"{"id":"step-1","sortKey":"1"}"#,
    )
    .unwrap();
    fs::write(session.join("steps/step-3.json.tmp"), b"{").unwrap();
    assert_eq!(service.recoveries().unwrap()[0].title, "Empty guide");
    let steps = service.session_steps("session-1").unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0]["id"], "step-1");
    assert_eq!(steps[1]["id"], "step-2");
}

#[test]
fn save_as_publishes_to_the_chosen_library_and_keeps_the_default() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let default = root.path().join("library");
    let shared = root.path().join("shared");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: default.clone(),
        })
        .unwrap();
    let session = root.path().join("recordings/session-1");
    for child in ["events", "steps", "media"] {
        fs::create_dir_all(session.join(child)).unwrap();
    }
    fs::write(session.join("session.json"), br#"{"author":"Robin"}"#).unwrap();

    service
        .finalize(
            "session-1",
            &json!({"id":"guide-1","title":"Payroll"}),
            Some(shared.clone()),
        )
        .unwrap();
    assert!(shared.join("guides/guide-1/guide.json").is_file());
    assert!(!default.join("guides/guide-1").exists());
    assert_eq!(service.library_folder(), Some(default));
    assert!(!session.exists());
}

#[test]
fn published_guide_survives_cleanup_failure_and_retry_preserves_its_contents() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    let session = root.path().join("recordings/session-1");
    for child in ["events", "steps", "media"] {
        fs::create_dir_all(session.join(child)).unwrap();
    }
    fs::write(session.join("session.json"), br#"{"author":"Robin"}"#).unwrap();
    let event = session.join("events/1.json");
    fs::write(&event, b"{}").unwrap();
    // Cleanup fails while the journal is held (see `block_cleanup`).
    let blocker = block_cleanup(&event);
    assert!(
        service
            .finalize(
                "session-1",
                &json!({"id":"guide-1","title":"Original"}),
                None
            )
            .is_err()
    );
    let guide_path = library.join("guides/guide-1/guide.json");
    let before = fs::read(&guide_path).unwrap();
    drop(blocker);
    if session.join("session.json").exists() {
        fs::remove_file(session.join("session.json")).unwrap();
    }
    let recoveries = service.recoveries().unwrap();
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].saved_guide_id.as_deref(), Some("guide-1"));
    service
        .finalize(
            "session-1",
            &json!({"id":"guide-1","title":"Must not overwrite"}),
            None,
        )
        .unwrap();
    assert!(!session.exists());
    assert_eq!(fs::read(&guide_path).unwrap(), before);
    // A repeated command after cleanup is also harmless.
    service
        .finalize("session-1", &json!({"id":"guide-1"}), None)
        .unwrap();
    assert!(service.recoveries().unwrap().is_empty());
}

#[test]
fn retry_never_replaces_an_unrelated_guide_or_deletes_its_source_session() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    let session = root.path().join("recordings/session-1");
    fs::create_dir_all(&session).unwrap();
    fs::write(session.join("keep.json"), b"important").unwrap();
    let destination = library.join("guides/guide-1");
    fs::create_dir_all(&destination).unwrap();
    let existing = br#"{"id":"guide-1","recordingSessionId":"different-session"}"#;
    fs::write(destination.join("guide.json"), existing).unwrap();
    assert_eq!(
        service
            .finalize("session-1", &json!({"id":"guide-1"}), None)
            .unwrap_err()
            .code,
        "guideExists"
    );
    assert_eq!(fs::read(destination.join("guide.json")).unwrap(), existing);
    assert_eq!(fs::read(session.join("keep.json")).unwrap(), b"important");
}

#[test]
fn interrupted_setup_and_finalization_do_not_hide_recoverable_sessions() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    let recordings = root.path().join("recordings");
    fs::create_dir_all(recordings.join("incomplete-setup")).unwrap();
    fs::create_dir_all(recordings.join("temporary-only/events")).unwrap();
    fs::write(recordings.join("temporary-only/events/1.json.tmp"), b"{").unwrap();
    let session = recordings.join("recoverable");
    for child in ["events", "steps", "media"] {
        fs::create_dir_all(session.join(child)).unwrap();
    }
    fs::write(session.join("events/1.json"), b"{}").unwrap();
    fs::write(
        session.join("session.json"),
        br#"{"title":"Recover me","author":"Robin"}"#,
    )
    .unwrap();
    let abandoned = library.join("guides/.finalizing-guide-1");
    fs::create_dir_all(abandoned.join("steps")).unwrap();
    fs::write(
        abandoned.join("guide.json"),
        br#"{"id":"guide-1","title":"Incomplete"}"#,
    )
    .unwrap();
    let recoveries = service.recoveries().unwrap();
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].session_id, "recoverable");
    assert!(service.list_guides().unwrap().is_empty());
    service
        .finalize(
            "recoverable",
            &json!({"id":"guide-1","title":"Complete"}),
            None,
        )
        .unwrap();
    let guides = service.list_guides().unwrap();
    assert_eq!(guides.len(), 1);
    assert_eq!(guides[0].title, "Complete");
    assert!(abandoned.exists());
}

#[test]
fn preferences_survive_restart_and_replacement_without_moving_existing_guides() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let first = root.path().join("first-library");
    let second = root.path().join("second-library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "  Robin  ".into(),
            library_folder: first.clone(),
        })
        .unwrap();
    fs::write(first.join("guides").join("existing.txt"), b"existing guide").unwrap();
    fs::write(root.path().join("recorder-settings-abandoned.tmp"), b"{").unwrap();
    service
        .set_preferences(RecorderPreferences {
            display_name: "New author".into(),
            library_folder: second.clone(),
        })
        .unwrap();
    let loaded = read_preferences(root.path(), first.clone());
    assert_eq!(loaded.display_name, "New author");
    assert_eq!(loaded.library_folder, second);
    assert_eq!(
        fs::read(first.join("guides").join("existing.txt")).unwrap(),
        b"existing guide"
    );
}

#[test]
fn damaged_or_newer_settings_files_fall_back_instead_of_failing() {
    let root = tempfile::tempdir().unwrap();
    let default = root.path().join("default-library");
    let settings = root.path().join("recorder-settings.json");

    fs::write(&settings, b"{ not json").unwrap();
    assert_eq!(
        read_preferences(root.path(), default.clone()).library_folder,
        default
    );

    // A field from a newer version is ignored; the known ones still apply.
    let chosen = root.path().join("chosen");
    let newer = json!({
        "displayName": "Robin",
        "libraryFolder": chosen,
        "somethingNew": true
    });
    fs::write(&settings, serde_json::to_vec(&newer).unwrap()).unwrap();
    let loaded = read_preferences(root.path(), default.clone());
    assert_eq!(loaded.display_name, "Robin");
    assert_eq!(loaded.library_folder, chosen);

    // A network path isn't allowed: the default is used rather than failing.
    fs::write(&settings, br#"{"libraryFolder":"\\\\server\\share"}"#).unwrap();
    assert_eq!(
        read_preferences(root.path(), default.clone()).library_folder,
        default
    );
}

#[test]
fn invalid_paths_and_active_recordings_cannot_change_preferences() {
    for path in ["relative-folder", r"C:relative", r"\\server\share", ""] {
        assert!(
            validate_preferences(RecorderPreferences {
                display_name: "Robin".into(),
                library_folder: path.into()
            })
            .is_err()
        );
    }
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner)
        .machine
        .lock()
        .unwrap()
        .start()
        .unwrap();
    let error = service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: root.path().join("library"),
        })
        .unwrap_err();
    assert_eq!(error.code, "recordingActive");
    assert!(!root.path().join("library").exists());
}

#[test]
fn recovered_steps_and_guides_keep_the_original_recording_author() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Different user".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    let session = root.path().join("recordings").join("session-1");
    fs::create_dir_all(session.join("steps")).unwrap();
    fs::create_dir_all(session.join("media")).unwrap();
    fs::write(session.join("session.json"), br#"{"author":"Robin"}"#).unwrap();
    service
        .append_step("session-1", &json!({"id":"step-1","updatedBy":""}))
        .unwrap();
    service
        .finalize(
            "session-1",
            &json!({"id":"guide-1","owner":"","createdBy":"","updatedBy":""}),
            None,
        )
        .unwrap();
    let guide: Value =
        serde_json::from_slice(&fs::read(library.join("guides/guide-1/guide.json")).unwrap())
            .unwrap();
    let step: Value = serde_json::from_slice(
        &fs::read(library.join("guides/guide-1/steps/step-1.json")).unwrap(),
    )
    .unwrap();
    for field in ["owner", "createdBy", "updatedBy"] {
        assert_eq!(guide[field], "Robin");
    }
    assert_eq!(step["updatedBy"], "Robin");
}

#[test]
fn a_damaged_or_copied_guide_does_not_break_the_library_list() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    let guides = root.path().join("library/guides");
    lock(&service.inner).library = Some(root.path().join("library"));
    let guide = |folder: &str, id: &str, with_steps: bool| {
        let dir = guides.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("guide.json"),
            json!({"id": id, "title": folder}).to_string(),
        )
        .unwrap();
        if with_steps {
            fs::create_dir_all(dir.join("steps")).unwrap();
            fs::write(dir.join("steps/s1.json"), b"{}").unwrap();
        }
    };
    guide("good", "good", true);
    guide("half-synced", "half-synced", false);
    guide("copy-of-good", "good", true);
    fs::create_dir_all(guides.join("broken")).unwrap();
    fs::write(guides.join("broken/guide.json"), b"{ not json").unwrap();

    let listed = service.list_guides().unwrap();
    let ids: Vec<&str> = listed.iter().map(|guide| guide.id.as_str()).collect();
    assert_eq!(listed.len(), 2, "{ids:?}");
    assert!(ids.contains(&"good") && ids.contains(&"half-synced"));
    let half = listed
        .iter()
        .find(|guide| guide.id == "half-synced")
        .unwrap();
    assert_eq!(half.step_count, 0);
}

#[test]
fn a_save_that_fails_part_way_leaves_no_staging_folder() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    // No session.json: reading the author fails after staging has been created.
    let session = root.path().join("recordings").join("session-1");
    fs::create_dir_all(session.join("steps")).unwrap();
    fs::create_dir_all(session.join("media")).unwrap();

    assert!(
        service
            .finalize("session-1", &json!({"id":"guide-1"}), None)
            .is_err()
    );
    let leftovers: Vec<_> = fs::read_dir(library.join("guides"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn draft_test_service(root: &Path) -> (RecorderService, PathBuf, PathBuf) {
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.to_path_buf());
    let library = root.join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    let session = root.join("recordings").join("session-1");
    fs::create_dir_all(session.join("steps")).unwrap();
    fs::create_dir_all(session.join("media")).unwrap();
    fs::write(session.join("session.json"), br#"{"author":"Robin"}"#).unwrap();
    for id in ["click-1", "click-2", "click-3"] {
        fs::write(session.join(format!("media/{id}.webp")), b"RIFF image").unwrap();
    }
    for (step, media) in [
        ("capture-1", "click-1"),
        ("capture-2", "click-2"),
        ("capture-3", "click-3"),
    ] {
        service
            .append_step("session-1", &json!({"id": step, "media": {"id": media}}))
            .unwrap();
    }
    (service, library, session)
}

#[test]
fn a_saved_draft_is_what_gets_published() {
    let root = tempfile::tempdir().unwrap();
    let (service, library, _session) = draft_test_service(root.path());
    assert!(service.load_draft("session-1").unwrap().is_none());
    // The editor opens the recording, deletes step 2 and rewords step 3.
    service
        .save_draft(
            "session-1",
            &json!({"id": "session-1", "title": "Draft"}),
            &[
                json!({"id": "capture-1", "media": {"id": "click-1"}}),
                json!({"id": "capture-2", "media": {"id": "click-2"}}),
                json!({"id": "capture-3", "media": {"id": "click-3"}}),
            ],
        )
        .unwrap();
    service.delete_draft_step("session-1", "capture-2").unwrap();
    service
        .save_draft_step(
            "session-1",
            &json!({"id": "capture-3", "actionText": "Reworded", "media": {"id": "click-3"}}),
        )
        .unwrap();
    let draft = service.load_draft("session-1").unwrap().unwrap();
    assert_eq!(draft.steps.len(), 2);

    service
        .finalize(
            "session-1",
            &json!({"id": "session-1", "title": "Draft"}),
            None,
        )
        .unwrap();
    let guide = library.join("guides/session-1");
    assert!(!guide.join("steps/capture-2.json").exists());
    // A deleted step's screenshot never reaches the (possibly shared) library.
    assert!(!guide.join("media/click-2.webp").exists());
    let reworded: Value =
        serde_json::from_slice(&fs::read(guide.join("steps/capture-3.json")).unwrap()).unwrap();
    assert_eq!(reworded["actionText"], "Reworded");
}

#[test]
fn draft_edits_need_a_draft_and_safe_ids() {
    let root = tempfile::tempdir().unwrap();
    let (service, _library, _session) = draft_test_service(root.path());
    assert_eq!(
        service
            .save_draft_step("session-1", &json!({"id": "capture-1"}))
            .unwrap_err()
            .code,
        "noDraft"
    );
    service
        .save_draft("session-1", &json!({"id": "session-1"}), &[])
        .unwrap();
    assert_eq!(
        service
            .save_draft_step("session-1", &json!({"id": "../escape"}))
            .unwrap_err()
            .code,
        "invalidStep"
    );
    assert_eq!(
        service
            .delete_draft_step("session-1", "..\\escape")
            .unwrap_err()
            .code,
        "invalidStep"
    );
    // Saving the whole draft again replaces it rather than merging.
    service
        .save_draft(
            "session-1",
            &json!({"id": "session-1"}),
            &[json!({"id": "capture-9"})],
        )
        .unwrap();
    let draft = service.load_draft("session-1").unwrap().unwrap();
    assert_eq!(draft.steps.len(), 1);
}

#[test]
fn steps_from_before_start_again_are_not_published_without_a_draft() {
    let root = tempfile::tempdir().unwrap();
    let (service, library, session) = draft_test_service(root.path());
    write_restart(&session, Some(2)).unwrap();
    assert_eq!(read_restart(&session), Some(2));
    service
        .finalize("session-1", &json!({"id": "session-1"}), None)
        .unwrap();
    let guide = library.join("guides/session-1");
    assert!(!guide.join("steps/capture-1.json").exists());
    assert!(!guide.join("steps/capture-2.json").exists());
    assert!(guide.join("steps/capture-3.json").is_file());
    assert!(!guide.join("media/click-1.webp").exists());
    assert!(guide.join("media/click-3.webp").is_file());
}

#[test]
fn restart_points_are_written_and_cleared() {
    let root = tempfile::tempdir().unwrap();
    write_restart(root.path(), Some(7)).unwrap();
    assert_eq!(read_restart(root.path()), Some(7));
    write_restart(root.path(), None).unwrap();
    assert_eq!(read_restart(root.path()), None);
    write_restart(root.path(), None).unwrap();
    assert_eq!(step_sequence("capture-12.json"), Some(12));
    assert_eq!(step_sequence("manual-12.json"), None);
}

#[test]
fn start_again_counts_restart_and_undo_puts_them_back() {
    let mut machine = RecorderStateMachine::new(Vec::new());
    machine.start().unwrap();
    machine.restore_counts(5, 1);
    assert_eq!(machine.restart_counts(), (5, 1));
    assert_eq!(machine.step_count(), 0);
    machine.restore_counts(5, 1);
    assert_eq!((machine.step_count(), machine.missed_count()), (5, 1));
}

#[test]
fn events_from_before_start_again_are_discarded_even_when_processed_late() {
    use capture::state_machine::EventDecision;
    let mut machine = RecorderStateMachine::new(Vec::new());
    machine.start().unwrap();
    assert_eq!(machine.set_restart_tick(Some(1_000)), None);
    // A click made at 990 and still in the pipeline at 1,000 is from the part thrown away.
    assert!(machine.before_restart(990));
    assert_ne!(machine.should_process_event(990), EventDecision::Process);
    assert_eq!(machine.should_process_event(1_001), EventDecision::Process);
    // Undo puts the earlier point back.
    assert_eq!(machine.set_restart_tick(None), Some(1_000));
    assert!(!machine.before_restart(990));
    // A new recording starts with none.
    machine.set_restart_tick(Some(5));
    machine.stop(10).unwrap();
    machine.finish_stopping().unwrap();
    machine.start().unwrap();
    assert!(!machine.before_restart(1));
}

#[test]
fn a_published_recording_is_not_saved_again_after_the_default_library_changes() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let first = root.path().join("first");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: first.clone(),
        })
        .unwrap();
    let session = root.path().join("recordings/session-9");
    for child in ["events", "steps", "media"] {
        fs::create_dir_all(session.join(child)).unwrap();
    }
    fs::write(session.join("session.json"), br#"{"author":"Robin"}"#).unwrap();
    let event = session.join("events/1.json");
    fs::write(&event, b"{}").unwrap();
    // The clean-up fails (a sync client holds a file), so the journal stays behind.
    let blocker = block_cleanup(&event);
    assert!(
        service
            .finalize("session-9", &json!({"id":"guide-9","title":"Saved"}), None)
            .is_err()
    );
    drop(blocker);
    assert!(first.join("guides/guide-9/guide.json").is_file());

    // Next time, another library is the default (the first is offline, or was changed).
    let second = root.path().join("second");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: second.clone(),
        })
        .unwrap();
    let recoveries = service.recoveries().unwrap();
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].saved_guide_id.as_deref(), Some("guide-9"));
    // Finishing the clean-up doesn't publish a second copy into the new default.
    service
        .finalize("session-9", &json!({"id":"guide-9"}), None)
        .unwrap();
    assert!(!second.join("guides/guide-9").exists());
    assert!(!session.exists());
    assert!(
        !root
            .path()
            .join("recordings/session-9.published.json")
            .exists()
    );
    assert!(service.recoveries().unwrap().is_empty());
}

#[test]
fn resuming_after_the_bar_went_quiet_needs_the_bar_to_answer() {
    let service = RecorderService::default();
    assert!(!service.indicator_alive());
    service.heartbeat.store(unix_millis(), Ordering::SeqCst);
    assert!(service.indicator_alive());
}

#[test]
fn only_screenshots_used_by_a_step_are_published() {
    let root = tempfile::tempdir().unwrap();
    let service = RecorderService::default();
    lock(&service.inner).app_data = Some(root.path().to_path_buf());
    let library = root.path().join("library");
    service
        .set_preferences(RecorderPreferences {
            display_name: "Robin".into(),
            library_folder: library.clone(),
        })
        .unwrap();
    let session = root.path().join("recordings").join("session-1");
    fs::create_dir_all(session.join("steps")).unwrap();
    fs::create_dir_all(session.join("media")).unwrap();
    fs::write(session.join("session.json"), br#"{"author":"Robin"}"#).unwrap();
    fs::write(session.join("media/click-1.webp"), b"RIFF used").unwrap();
    // A cancelled Add shortcut leaves a screenshot no step refers to.
    fs::write(session.join("media/manual-9.webp"), b"RIFF cancelled").unwrap();
    service
        .append_step(
            "session-1",
            &json!({"id":"step-1","media":{"id":"click-1"}}),
        )
        .unwrap();
    service
        .finalize("session-1", &json!({"id":"guide-1"}), None)
        .unwrap();

    let media = library.join("guides/guide-1/media");
    assert!(media.join("click-1.webp").is_file());
    assert!(!media.join("manual-9.webp").exists());
}

#[test]
fn incomplete_temporary_facts_are_ignored_and_completed_facts_are_atomic() {
    let directory = tempfile::tempdir().unwrap();
    let events = directory.path().join("events");
    fs::create_dir_all(&events).unwrap();
    fs::write(
        events.join("00000000000000000001.json.tmp"),
        b"{\"record\":",
    )
    .unwrap();

    assert!(read_records(directory.path()).unwrap().is_empty());

    let final_path = events.join("00000000000000000002.json");
    let fact = json!({ "sequence": 2, "record": { "kind": "state" } });
    let bytes = serde_json::to_vec_pretty(&fact).unwrap();
    write_new_bytes_atomic(&final_path, &bytes).unwrap();

    assert_eq!(read_records(directory.path()).unwrap(), vec![fact]);
    assert!(!events.join("00000000000000000002.json.tmp").exists());
}

#[test]
fn a_write_that_fails_part_way_leaves_no_truncated_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("media/click-1.webp");
    let result = write_new_file(&path, |file| {
        file.write_all(b"RIFF half an image")?;
        Err(std::io::Error::other(
            "There is not enough space on the disk.",
        ))
    });
    assert!(result.is_err());
    assert!(!path.exists(), "the truncated file was removed");
    // The same name can be written once space is back.
    write_new_bytes(&path, b"RIFF a whole image").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"RIFF a whole image");
}

#[test]
fn saved_screenshots_load_and_unsafe_names_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("library");
    let media = library.join("guides/guide-1/media");
    fs::create_dir_all(&media).unwrap();
    fs::write(media.join("click-1.webp"), b"RIFF").unwrap();
    let service = RecorderService::default();
    {
        let mut inner = lock(&service.inner);
        inner.app_data = Some(root.path().join("app-data"));
        inner.library = Some(library);
    }

    let data = service.image_data("guide-1", "click-1.webp").unwrap();
    assert!(data.starts_with("data:image/webp;base64,"), "{data}");
    for name in [
        "../click-1.webp",
        "click-1.png",
        "click-1",
        ".webp",
        "a/b.webp",
    ] {
        assert!(service.image_data("guide-1", name).is_err(), "{name}");
    }
    assert!(service.image_data("..", "click-1.webp").is_err());
}

#[test]
fn a_failed_library_marker_is_rewritten_next_time() {
    let library = tempfile::tempdir().unwrap();
    let marker = library.path().join(".amluto-library.json");
    let _ = write_new_file(&marker, |file| {
        file.write_all(b"{\"id\":")?;
        Err(std::io::Error::other("disk full"))
    });
    ensure_library_metadata(library.path()).unwrap();
    let written: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
    assert_eq!(written["formatVersion"], 1);
}
