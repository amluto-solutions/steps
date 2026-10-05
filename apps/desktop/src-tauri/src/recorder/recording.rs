//! Recording itself: set-up, start, pause and resume, stop and discard, the input source, excluded
//! apps and monitors, and "Start again".

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use capture::coords::PxRect;
use capture::pipeline::{self, KeyLink, PipelineConfig, Sink};
use capture::platform::display::{input_desktop_is_default, now_tick};
use capture::platform::input::{InputCapture, InputSource};
use capture::platform::window::foreground_window;
use capture::screenshot::CaptureMode;
use capture::state_machine::{PauseReason, RecorderState};
use capture::typing::{KeyOptions, KeyWorker, SharedFocus};
use capture::uia::{FocusOptions, UiaClient};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::commands::available_monitors;
use super::files::{ensure_library_metadata, write_marker, write_new_bytes, write_restart};
use super::journal::JournalSink;
use super::preferences::{
    prepare_library, read_preferences, save_preferences, validate_preferences,
};
use super::{
    CommandError, ERROR_EVENT, FINISHED_EVENT, JournalGap, RESTART_EVENT, RecorderPreferences,
    RecorderService, RecorderSnapshot, Session, join_finished_worker, lock, not_recording,
    nothing_to_undo, publish_state, safe_executable_name, snapshot_locked,
    spawn_indicator_watchdog, storage_error, unique_id, unix_millis,
};

/// After this many capture-worker panics in one recording, it is stopped rather than restarted.
const MAX_WORKER_RESTARTS: u32 = 5;

/// How long command output must stay unchanged before it is read: Settings → Recording's range.
const MIN_OUTPUT_SETTLE_MS: u32 = 500;
const MAX_OUTPUT_SETTLE_MS: u32 = 10_000;

/// The choices on the start-a-recording dialog (docs/spec/02-capture.md#keys).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    /// "Record what's typed": keys, commands and field values.
    pub keys: bool,
    /// "Include command output". Only with `keys`.
    pub output: bool,
    /// How long command output must stay unchanged before it is read, in milliseconds.
    pub settle_ms: u32,
    /// Settings > Recording, "Add a step when you switch apps": on unless switched off.
    #[serde(default = "on")]
    pub app_switch_steps: bool,
    /// Settings > Recording, "Screenshot quality": Balanced unless Original is chosen.
    #[serde(default)]
    pub quality: library::ScreenshotQuality,
}

const fn on() -> bool {
    true
}

impl RecorderService {
    /// Creates private app-data and visible library folders. Mouse input is only registered
    /// while a recording runs (see `start`), never while the app merely sits open.
    pub fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        let mut inner = lock(&self.inner);
        if inner.app_data.is_some() {
            return Ok(());
        }
        let app_data = crate::app_folder::app_folder(app)
            .ok_or_else(|| "Windows did not provide an app-data folder".to_string())?;
        let default_library = crate::app_folder::default_library(app)?;
        let preferences = read_preferences(&app_data, default_library.clone());
        fs::create_dir_all(app_data.join("recordings")).map_err(|error| error.to_string())?;
        // A library on a drive that isn't connected today falls back to the default library for
        // this session; the saved choice is kept for next time.
        let library = match prepare_library(&preferences.library_folder) {
            Ok(()) => preferences.library_folder,
            Err(error) => {
                log::error!(
                    "The library folder {} is unavailable ({error}); using {} for now.",
                    preferences.library_folder.display(),
                    default_library.display()
                );
                prepare_library(&default_library)?;
                default_library
            }
        };

        inner.app_data = Some(app_data);
        inner.library = Some(library);
        inner.display_name = preferences.display_name;
        Ok(())
    }

    pub(super) fn snapshot(&self) -> RecorderSnapshot {
        let inner = lock(&self.inner);
        snapshot_locked(&inner)
    }

    /// The folder new recordings are saved to, once `initialize` has run.
    pub(crate) fn library_folder(&self) -> Option<PathBuf> {
        lock(&self.inner).library.clone()
    }

    /// The app-data folder (`%APPDATA%\Amluto\Steps`), once `initialize` has run.
    pub(crate) fn app_data(&self) -> Option<PathBuf> {
        lock(&self.inner).app_data.clone()
    }

    /// The name the user gave in settings (may be empty).
    pub(crate) fn display_name(&self) -> String {
        lock(&self.inner).display_name.clone()
    }

    /// Points new recordings at `folder` (the default library) and saves that choice. Refused
    /// while a recording is running or waiting for review, like any other settings change.
    pub(crate) fn set_library_folder(&self, folder: PathBuf) -> Result<(), CommandError> {
        let display_name = self.display_name();
        self.set_preferences(RecorderPreferences {
            display_name,
            library_folder: folder,
        })
        .map(|_| ())
    }

    pub(super) fn preferences(&self) -> Result<RecorderPreferences, CommandError> {
        let inner = lock(&self.inner);
        Ok(RecorderPreferences {
            display_name: inner.display_name.clone(),
            library_folder: inner.library.clone().ok_or_else(|| {
                CommandError::new("notReady", "The library folder is not initialized.")
            })?,
        })
    }

    pub(super) fn set_preferences(
        &self,
        preferences: RecorderPreferences,
    ) -> Result<RecorderPreferences, CommandError> {
        let preferences = validate_preferences(preferences)?;
        let mut inner = lock(&self.inner);
        if lock(&inner.machine).state() != &RecorderState::Idle || inner.session.is_some() {
            return Err(CommandError::new(
                "recordingActive",
                "Save or discard the current recording before changing these settings.",
            ));
        }
        let app_data = inner
            .app_data
            .as_ref()
            .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?;
        fs::create_dir_all(preferences.library_folder.join("guides")).map_err(storage_error)?;
        ensure_library_metadata(&preferences.library_folder).map_err(storage_error)?;
        save_preferences(app_data, &preferences)?;
        inner.library = Some(preferences.library_folder.clone());
        inner.display_name.clone_from(&preferences.display_name);
        Ok(preferences)
    }

    #[allow(
        clippy::too_many_lines,
        reason = "The start path keeps setup and rollback adjacent."
    )]
    pub(super) fn start(
        &self,
        app: &AppHandle,
        title: &str,
        options: StartOptions,
    ) -> Result<RecorderSnapshot, CommandError> {
        // IT policy can turn "Record what's typed" off (never on), and the policy's excluded apps
        // are always excluded, whatever the window asked for.
        let policy = crate::policy::current();
        let keys = options.keys && !policy.disable_keystroke_recording;
        let output = keys && options.output;
        // Locked by IT, it stays at its default: on.
        let app_switch_steps = options.app_switch_steps || policy.is_locked("AppSwitchSteps");
        let original = crate::policy::screenshot_quality(options.quality)
            == library::ScreenshotQuality::Original;
        let settle = Duration::from_millis(u64::from(
            options
                .settle_ms
                .clamp(MIN_OUTPUT_SETTLE_MS, MAX_OUTPUT_SETTLE_MS),
        ));
        let focus_note: Option<SharedFocus> = keys.then(SharedFocus::default);
        let mut inner = lock(&self.inner);
        join_finished_worker(&mut inner);
        let machine = Arc::clone(&inner.machine);
        {
            let mut machine = lock(&machine);
            for app in &policy.excluded_apps {
                machine.add_excluded_app(app);
            }
        }
        if lock(&machine).state() != &RecorderState::Idle {
            return Err(CommandError::new(
                "busy",
                "A recording is already in progress.",
            ));
        }
        if inner.session.is_some() {
            return Err(CommandError::new(
                "pendingReview",
                "Save or discard the previous recording before starting another.",
            ));
        }
        // Check the indicator before creating a session or transitioning to Recording.
        let recorder_bar = app.get_webview_window("recorder-bar").ok_or_else(|| {
            CommandError::new(
                "recorderBarUnavailable",
                "The recording indicator is unavailable.",
            )
        })?;
        let app_data = inner
            .app_data
            .as_ref()
            .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?;
        let session_id = unique_id();
        let session_dir = app_data.join("recordings").join(&session_id);
        for child in ["events", "media", "steps"] {
            fs::create_dir_all(session_dir.join(child)).map_err(storage_error)?;
        }
        let session_title = if title.trim().is_empty() {
            "Untitled guide"
        } else {
            title.trim()
        };
        let metadata = json!({
            "sessionId": session_id,
            "title": session_title,
            "author": inner.display_name,
            "startedAt": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        });
        write_new_bytes(
            &session_dir.join("session.json"),
            &serde_json::to_vec_pretty(&metadata).map_err(storage_error)?,
        )
        .map_err(storage_error)?;

        let (focus_tx, focus_rx) = std::sync::mpsc::channel();
        log::info!("recorder start: waiting for UI Automation");
        let uia = UiaClient::start(Some((
            focus_tx,
            FocusOptions {
                record_values: keys,
                note: focus_note.clone(),
                extra_sensitive_terms: policy.sensitive_field_patterns.clone(),
                machine: Some(Arc::clone(&machine)),
                entered: capture::lookup::FieldSlot::default(),
            },
        )))
        .map_err(|error| {
            log::error!("recorder start: UI Automation unavailable: {error}");
            let _ = fs::remove_dir_all(&session_dir);
            CommandError::new("uiaUnavailable", error)
        })?;
        log::info!("recorder start: UI Automation ready; showing indicator");

        {
            let mut state = lock(&machine);
            state
                .start()
                .map_err(|error| CommandError::new("invalidState", error.to_string()))?;
            state.set_keys_recorded(keys);
            state.set_app_switch_steps(app_switch_steps);
            state.set_original_screenshots(original);
        }
        // Focus goes to the bar, so a keyboard user can Tab straight to Pause and Stop.
        if let Err(error) =
            super::commands::show_bar(&recorder_bar).and_then(|()| recorder_bar.set_focus())
        {
            let mut state = lock(&machine);
            let _ = state.stop(now_tick());
            let _ = state.finish_stopping();
            let _ = fs::remove_dir_all(&session_dir);
            return Err(CommandError::new(
                "recorderBarUnavailable",
                error.to_string(),
            ));
        }
        log::info!("recorder start: indicator visible; registering mouse input");
        // Mouse input is registered only now, with the indicator showing, and released when
        // the recording finishes: the app never listens while it merely sits open.
        let input = match InputCapture::start(inner.input_source) {
            Ok(input) => input,
            Err(error) => {
                let mut state = lock(&machine);
                let _ = state.stop(now_tick());
                let _ = state.finish_stopping();
                let _ = fs::remove_dir_all(&session_dir);
                super::commands::hide_bar(&recorder_bar);
                return Err(CommandError::new("inputUnavailable", error.to_string()));
            }
        };
        let shared = Arc::clone(input.shared());
        shared.clear();
        // The keyboard only for a recording that asked for it, and never without the bar showing.
        let key_parts = if let (true, Some(note)) = (keys, focus_note) {
            let (records_tx, records_rx) = std::sync::mpsc::channel();
            let started = input
                .set_keyboard(true)
                .map_err(|error| error.to_string())
                .and_then(|()| {
                    KeyWorker::start(
                        Arc::clone(&shared),
                        Arc::clone(&machine),
                        note,
                        KeyOptions {
                            output,
                            settle,
                            extra_terms: policy.sensitive_field_patterns.clone(),
                            mode: inner.capture_mode,
                            target_monitor: inner.target_monitor,
                        },
                        records_tx,
                    )
                    .map_err(|error| error.to_string())
                });
            match started {
                Ok(worker) => {
                    let link = KeyLink {
                        records: records_rx,
                        clicks: worker.clicks(),
                    };
                    Some((worker, link))
                }
                Err(error) => {
                    input.stop();
                    let mut state = lock(&machine);
                    let _ = state.stop(now_tick());
                    let _ = state.finish_stopping();
                    let _ = fs::remove_dir_all(&session_dir);
                    super::commands::hide_bar(&recorder_bar);
                    return Err(CommandError::new("keyboardUnavailable", error));
                }
            }
        } else {
            None
        };
        inner.keys = key_parts.is_some();
        inner.input = Some(input);
        self.heartbeat.store(unix_millis(), Ordering::SeqCst);
        log::info!("recorder start: starting capture worker");
        let stop = Arc::new(AtomicBool::new(false));
        let sequence = Arc::new(AtomicU64::new(0));
        let gap = Arc::new(JournalGap::default());
        shared.enabled.store(true, Ordering::SeqCst);

        let machine_for_worker = Arc::clone(&machine);
        let stop_for_worker = Arc::clone(&stop);
        let directory_for_worker = session_dir.clone();
        let app_for_worker = app.clone();
        let session_id_for_worker = session_id.clone();
        let title_for_worker = session_title.to_string();
        let sequence_for_worker = Arc::clone(&sequence);
        let gap_for_worker = Arc::clone(&gap);
        let source_for_worker = inner.input_source;
        let capture_mode_for_worker = inner.capture_mode;
        let target_monitor_for_worker = inner.target_monitor;
        let shared_for_worker = Arc::clone(&shared);
        let service_for_worker = self.clone();
        let worker_result = std::thread::Builder::new()
            .name("amluto-capture-worker".into())
            .spawn(move || {
                let mut sink = JournalSink::new(
                    app_for_worker.clone(),
                    session_id_for_worker.clone(),
                    directory_for_worker.clone(),
                    Arc::clone(&machine_for_worker),
                    sequence_for_worker,
                    gap_for_worker,
                    source_for_worker,
                );
                let config = PipelineConfig {
                    mode: capture_mode_for_worker,
                    target_monitor: target_monitor_for_worker,
                    ..PipelineConfig::default()
                };
                let (key_worker, key_link) = key_parts.unzip();
                let mut restarts = 0_u32;
                loop {
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        pipeline::run_recording(
                            &shared_for_worker,
                            &uia,
                            Some(&focus_rx),
                            key_link.as_ref(),
                            &config,
                            &stop_for_worker,
                            &mut sink,
                            &machine_for_worker,
                        )
                    }));
                    if result.is_ok() {
                        break;
                    }
                    log::error!("The capture worker panicked; restarting its loop.");
                    let (missed, degraded) = {
                        let mut machine = lock(&machine_for_worker);
                        let records = machine.handle_worker_panic(None, now_tick());
                        shared_for_worker
                            .enabled
                            .store(machine.is_active(), Ordering::SeqCst);
                        records
                    };
                    sink.write(missed, None);
                    sink.write(degraded, None);
                    if stop_for_worker.load(Ordering::SeqCst) {
                        break;
                    }
                    // A fault that repeats would otherwise restart (and write two journal files)
                    // as fast as the loop runs, until Stop.
                    restarts += 1;
                    if restarts >= MAX_WORKER_RESTARTS {
                        log::error!("The capture worker kept failing; stopping the recording.");
                        let _ = lock(&machine_for_worker).stop(now_tick());
                        shared_for_worker.enabled.store(false, Ordering::SeqCst);
                        let _ = app_for_worker.emit(
                            ERROR_EVENT,
                            CommandError::new(
                                "workerFailed",
                                "Recording stopped because capture kept failing.",
                            ),
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100 << restarts));
                }
                shared_for_worker.enabled.store(false, Ordering::SeqCst);
                // What was being typed, and a command still waiting for its output, become
                // steps now; then they are written like the rest.
                if let Some(worker) = key_worker {
                    worker.stop();
                }
                if let Some(link) = &key_link {
                    pipeline::write_key_records(&link.records, &machine_for_worker, &mut sink);
                }
                sink.flush_unsaved();
                {
                    let mut state = lock(&machine_for_worker);
                    if matches!(state.state(), RecorderState::Stopping { .. }) {
                        let _ = state.finish_stopping();
                    }
                }
                if write_marker(&directory_for_worker.join(".stopped")).is_err() {
                    let _ = app_for_worker.emit(
                        ERROR_EVENT,
                        CommandError::new("journalWriteFailed", "Could not mark the recording as stopped."),
                    );
                }
                let (should_discard, input) = {
                    let mut inner = lock(&service_for_worker.inner);
                    let discard = inner.discard_after_stop;
                    inner.discard_after_stop = false;
                    inner.keys = false;
                    if discard {
                        inner.session = None;
                    }
                    (discard, inner.input.take())
                };
                // Release every input registration now the recording is over.
                if let Some(input) = input {
                    input.stop();
                }
                if should_discard {
                    remove_discarded(&directory_for_worker);
                }
                let snapshot = service_for_worker.snapshot();
                publish_state(&app_for_worker, &snapshot);
                let _ = app_for_worker.emit(
                    FINISHED_EVENT,
                    json!({"sessionId": session_id_for_worker, "title": title_for_worker, "snapshot": snapshot}),
                );
                if let Some(bar) = app_for_worker.get_webview_window("recorder-bar") {
                    super::commands::hide_bar(&bar);
                }
            });
        let worker = match worker_result {
            Ok(worker) => worker,
            Err(error) => {
                shared.enabled.store(false, Ordering::SeqCst);
                inner.input = None;
                inner.keys = false;
                let mut state = lock(&machine);
                let _ = state.stop(now_tick());
                let _ = state.finish_stopping();
                let _ = fs::remove_dir_all(&session_dir);
                super::commands::hide_bar(&recorder_bar);
                return Err(CommandError::new("workerStartFailed", error.to_string()));
            }
        };

        inner.worker = Some(worker);
        spawn_indicator_watchdog(
            app.clone(),
            self.clone(),
            Arc::clone(&machine),
            Arc::clone(&shared),
            Arc::clone(&stop),
        );
        inner.stop = Some(stop);
        inner.session = Some(Session {
            id: session_id,
            directory: session_dir,
            sequence,
            gap,
            restart: None,
            undo_restart: None,
        });
        inner.discard_after_stop = false;
        let snapshot = snapshot_locked(&inner);
        log::info!("recorder start: capture worker running");
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    pub(super) fn pause(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let inner = lock(&self.inner);
        let input = inner
            .input
            .as_ref()
            .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?;
        lock(&inner.machine)
            .pause(PauseReason::User, now_tick())
            .map_err(|error| CommandError::new("invalidState", error.to_string()))?;
        input.shared().enabled.store(false, Ordering::SeqCst);
        // Pause stops key capture at once: the keyboard isn't even registered while paused.
        if inner.keys
            && let Err(error) = input.set_keyboard(false)
        {
            log::error!("Pause could not remove the keyboard registration: {error}");
        }
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    pub(super) fn resume(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let inner = lock(&self.inner);
        let input = inner
            .input
            .as_ref()
            .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?;
        let state = lock(&inner.machine).state().clone();
        // An automatic pause holds while its cause does: resuming by hand must not restart
        // capture with an excluded app still in front, or on the lock screen or a UAC prompt.
        match &state {
            RecorderState::Paused {
                reason: PauseReason::ExcludedApp(app),
                ..
            } if foreground_window()
                .and_then(|window| window.exe_name().map(str::to_string))
                .is_some_and(|name| lock(&inner.machine).is_app_excluded(&name)) =>
            {
                return Err(CommandError::new(
                    "excludedAppInFront",
                    format!("Recording resumes by itself once {app} is no longer in front."),
                ));
            }
            RecorderState::Paused {
                reason: PauseReason::LockScreen | PauseReason::Uac,
                ..
            } if !input_desktop_is_default() => {
                return Err(CommandError::new(
                    "secureDesktop",
                    "Recording resumes by itself when the lock screen or permission prompt closes.",
                ));
            }
            RecorderState::Paused {
                reason: PauseReason::IndicatorLost,
                ..
            } if !self.indicator_alive() => {
                return Err(CommandError::new(
                    "indicatorLost",
                    "The recording bar isn't responding, so recording can't resume.",
                ));
            }
            RecorderState::Paused {
                reason: PauseReason::InputStopped(_),
                ..
            } => {
                input
                    .reregister()
                    .map_err(|error| CommandError::new("inputResumeFailed", error.to_string()))?;
            }
            _ => {}
        }
        if inner.keys {
            input
                .set_keyboard(true)
                .map_err(|error| CommandError::new("keyboardUnavailable", error.to_string()))?;
        }
        lock(&inner.machine)
            .resume(now_tick())
            .map_err(|error| CommandError::new("invalidState", error.to_string()))?;
        input.shared().enabled.store(true, Ordering::SeqCst);
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    /// The Pause/Resume hotkey: resumes a paused recording, pauses a running one, and does
    /// nothing when no recording is active (so the keys never start a recording).
    pub(crate) fn toggle_pause(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let state = {
            let inner = lock(&self.inner);
            lock(&inner.machine).state().clone()
        };
        match state {
            RecorderState::Paused { .. } => self.resume(app),
            RecorderState::Recording | RecorderState::Degraded { .. } => self.pause(app),
            _ => Ok(self.snapshot()),
        }
    }

    /// Whether a recording is running or still finishing (not yet back to Idle).
    pub(crate) fn is_recording_active(&self) -> bool {
        let inner = lock(&self.inner);
        lock(&inner.machine).state() != &RecorderState::Idle
    }

    /// The Stop hotkey: stops an active recording; does nothing otherwise.
    pub(crate) fn stop_if_active(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let active = {
            let inner = lock(&self.inner);
            let state = lock(&inner.machine).state().clone();
            matches!(
                state,
                RecorderState::Recording
                    | RecorderState::Degraded { .. }
                    | RecorderState::Paused { .. }
            )
        };
        if active {
            self.stop(app)
        } else {
            Ok(self.snapshot())
        }
    }

    pub(super) fn stop(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let inner = lock(&self.inner);
        let input = inner
            .input
            .as_ref()
            .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?;
        lock(&inner.machine)
            .stop(now_tick())
            .map_err(|error| CommandError::new("invalidState", error.to_string()))?;
        input.shared().enabled.store(false, Ordering::SeqCst);
        if inner.keys {
            let _ = input.set_keyboard(false);
        }
        inner
            .stop
            .as_ref()
            .ok_or_else(|| CommandError::new("notRecording", "There is no active recording."))?
            .store(true, Ordering::SeqCst);
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    pub(super) fn discard(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let mut inner = lock(&self.inner);
        let session = inner
            .session
            .as_ref()
            .ok_or_else(|| CommandError::new("noRecording", "There is no recording to discard."))?;
        let state = lock(&inner.machine).state().clone();
        if matches!(state, RecorderState::Idle) {
            let path = session.directory.clone();
            // Already gone (deleted by hand, or by a sync client) counts as discarded, rather than
            // leaving the app stuck on a review it can never clear.
            match fs::remove_dir_all(path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(storage_error(error));
                }
                _ => {}
            }
            inner.session = None;
        } else {
            lock(&inner.machine)
                .stop(now_tick())
                .map_err(|error| CommandError::new("invalidState", error.to_string()))?;
            if let Some(input) = inner.input.as_ref() {
                input.shared().enabled.store(false, Ordering::SeqCst);
                if inner.keys {
                    let _ = input.set_keyboard(false);
                }
            }
            if let Some(stop) = inner.stop.as_ref() {
                stop.store(true, Ordering::SeqCst);
            }
            inner.discard_after_stop = true;
        }
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    pub(super) fn set_source(
        &self,
        app: &AppHandle,
        source: &str,
    ) -> Result<RecorderSnapshot, CommandError> {
        let mut inner = lock(&self.inner);
        let state = lock(&inner.machine).state().clone();
        if !matches!(
            state,
            RecorderState::Idle
                | RecorderState::Paused {
                    reason: PauseReason::InputStopped(_),
                    ..
                }
        ) {
            return Err(CommandError::new(
                "recordingActive",
                "Change the input method while idle or while input is paused.",
            ));
        }
        let next = match source {
            "rawInput" => InputSource::RawInput,
            "hook" => InputSource::Hook,
            _ => {
                return Err(CommandError::new(
                    "invalidInputSource",
                    "Unknown input source.",
                ));
            }
        };
        // While idle there is no input thread: the choice applies at the next Record.
        if let Some(input) = inner.input.as_ref() {
            input
                .set_source(next)
                .map_err(|error| CommandError::new("inputSourceFailed", error.to_string()))?;
        }
        inner.input_source = next;
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    pub(super) fn exclude_app(
        &self,
        app: &AppHandle,
        exe_name: &str,
    ) -> Result<RecorderSnapshot, CommandError> {
        if !safe_executable_name(exe_name) {
            return Err(CommandError::new(
                "invalidExecutable",
                "Choose an application captured during this recording.",
            ));
        }
        let inner = lock(&self.inner);
        lock(&inner.machine).add_excluded_app(exe_name);
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    pub(super) fn set_capture_mode(&self, mode: &str) -> Result<(), CommandError> {
        let requested = match mode {
            "window" => CaptureMode::Window,
            "monitor" => CaptureMode::Monitor,
            _ => {
                return Err(CommandError::new(
                    "invalidCaptureMode",
                    "Unknown screenshot mode.",
                ));
            }
        };
        let mut inner = lock(&self.inner);
        if lock(&inner.machine).state() != &RecorderState::Idle {
            return Err(CommandError::new(
                "recordingActive",
                "Change screenshot mode after the recording has stopped.",
            ));
        }
        // A locked setting stays at its default (the window) whatever the window asks for, as
        // RecordTypedValues does: the UI hides the choice, and this holds even if it didn't.
        inner.capture_mode = if crate::policy::current().is_locked("ScreenshotMode") {
            CaptureMode::Window
        } else {
            requested
        };
        Ok(())
    }

    pub(super) fn set_target_monitor(&self, bounds: Option<PxRect>) -> Result<(), CommandError> {
        // Locked: every monitor, the default. Displays are listed before the lock is taken.
        let bounds = if crate::policy::current().is_locked("Monitors") {
            None
        } else {
            bounds
        };
        if let Some(bounds) = bounds
            && !available_monitors()?
                .iter()
                .any(|monitor| monitor.bounds == bounds)
        {
            return Err(CommandError::new(
                "monitorUnavailable",
                "That monitor is no longer available. Choose a connected monitor.",
            ));
        }
        let mut inner = lock(&self.inner);
        if lock(&inner.machine).state() != &RecorderState::Idle {
            return Err(CommandError::new(
                "recordingActive",
                "Change the monitor after the recording has stopped.",
            ));
        }
        inner.target_monitor = bounds;
        Ok(())
    }

    pub(super) fn include_app(
        &self,
        app: &AppHandle,
        exe_name: &str,
    ) -> Result<RecorderSnapshot, CommandError> {
        if !safe_executable_name(exe_name) {
            return Err(CommandError::new(
                "invalidExecutable",
                "The application name is invalid.",
            ));
        }
        if crate::policy::current()
            .excluded_apps
            .iter()
            .any(|app| app.eq_ignore_ascii_case(exe_name))
        {
            return Err(CommandError::new(
                "setByPolicy",
                "Your organisation has excluded this app from recording.",
            ));
        }
        let inner = lock(&self.inner);
        lock(&inner.machine).remove_excluded_app(exe_name);
        let snapshot = snapshot_locked(&inner);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    /// "Start again" on the recorder bar: the steps captured so far stop belonging to this
    /// recording and the counts restart. The facts stay in the private journal until the
    /// recording is saved or discarded, so the undo can bring them back; they are never published.
    pub(super) fn start_again(&self, app: &AppHandle) -> Result<RecorderSnapshot, CommandError> {
        let mut inner = lock(&self.inner);
        let machine = Arc::clone(&inner.machine);
        if matches!(
            lock(&machine).state(),
            RecorderState::Idle | RecorderState::Stopping { .. }
        ) {
            return Err(not_recording());
        }
        let session = inner.session.as_mut().ok_or_else(not_recording)?;
        let after = session.sequence.load(Ordering::SeqCst);
        write_restart(&session.directory, Some(after))?;
        let (steps, missed, previous_tick) = {
            let mut state = lock(&machine);
            let (steps, missed) = state.restart_counts();
            (steps, missed, state.set_restart_tick(Some(now_tick())))
        };
        session.undo_restart = Some((session.restart, steps, missed, previous_tick));
        session.restart = Some(after);
        let restarted = json!({ "sessionId": session.id, "afterSequence": after });
        let snapshot = snapshot_locked(&inner);
        drop(inner);
        let _ = app.emit(RESTART_EVENT, restarted);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }

    /// Undoes "Start again", but only before anything new is recorded: after that the counts
    /// and the order would no longer match what the user saw.
    pub(super) fn undo_start_again(
        &self,
        app: &AppHandle,
    ) -> Result<RecorderSnapshot, CommandError> {
        let mut inner = lock(&self.inner);
        let machine = Arc::clone(&inner.machine);
        let session = inner.session.as_mut().ok_or_else(nothing_to_undo)?;
        let Some((previous, steps, missed, previous_tick)) = session.undo_restart else {
            return Err(nothing_to_undo());
        };
        {
            let state = lock(&machine);
            if state.step_count() > 0 || state.missed_count() > 0 {
                return Err(CommandError::new(
                    "tooLate",
                    "New steps were recorded after starting again, so it can't be undone.",
                ));
            }
        }
        write_restart(&session.directory, previous)?;
        {
            let mut state = lock(&machine);
            state.restore_counts(steps, missed);
            state.set_restart_tick(previous_tick);
        }
        session.restart = previous;
        session.undo_restart = None;
        let restarted = json!({ "sessionId": session.id, "afterSequence": previous });
        let snapshot = snapshot_locked(&inner);
        drop(inner);
        let _ = app.emit(RESTART_EVENT, restarted);
        publish_state(app, &snapshot);
        Ok(snapshot)
    }
}

/// Deletes a discarded recording's folder, screenshots and all. A file held for a moment (an
/// antivirus scanning a screenshot) is tried again; one that still can't go is logged, and the
/// recording is offered back at the next start rather than left there unsaid.
fn remove_discarded(directory: &std::path::Path) {
    for attempt in 0..5 {
        match fs::remove_dir_all(directory) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) if attempt == 4 => {
                log::warn!("A discarded recording couldn't be deleted: {error}");
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(400)),
        }
    }
}
