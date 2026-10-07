//! Tauri commands for user-controlled recording and the crash-safe local journal.
#![allow(clippy::module_name_repetitions)]
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use capture::coords::PxRect;
use capture::facts::Record;
use capture::platform::display::now_tick;
use capture::platform::input::{InputCapture, InputShared, InputSource};
use capture::screenshot::CaptureMode;
use capture::state_machine::{PauseReason, RecorderState, RecorderStateMachine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

// The recorder in parts: the Tauri commands; recording itself (start, pause, stop, "Start
// again"); manual captures; the crash-safe journal; stopped recordings (drafts, recovery,
// publishing); the recorder's files on disk; and its preferences. The types and small helpers
// they share are here.
pub mod commands;
mod files;
mod journal;
mod manual;
mod preferences;
mod recording;
mod retake;
mod sessions;
#[cfg(test)]
mod tests;

const FACT_EVENT: &str = "recorder:fact";
const STATE_EVENT: &str = "recorder:state";
const FINISHED_EVENT: &str = "recorder:finished";
const ERROR_EVENT: &str = "recorder:error";
const STEP_EVENT: &str = "recorder:step-added";
/// Sent when "Start again" (or its undo) changes which captured steps belong to the recording.
const RESTART_EVENT: &str = "recorder:restarted";
/// Sent to the recorder bar every second while recording; it answers with a heartbeat.
const HEARTBEAT_REQUEST_EVENT: &str = "recorder:heartbeat-request";
/// How long the recorder bar may go quiet before recording pauses. Generous, because a busy PC
/// can delay a timer by a second or two.
const INDICATOR_TIMEOUT_MS: u64 = 8_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecorderPreferences {
    display_name: String,
    library_folder: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The error code, for tests in other modules.
    #[cfg(test)]
    pub(crate) fn code(&self) -> &str {
        self.code
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderSnapshot {
    state: &'static str,
    reason: Option<String>,
    session_id: Option<String>,
    step_count: u64,
    missed_count: u64,
    /// Clicks on a screen Settings > Recording > Monitors leaves out.
    other_screen_clicks: u64,
    input_source: &'static str,
    /// The recording reads the keyboard ("Record what's typed"): the bar and tray say so.
    keys_recorded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingFact {
    session_id: String,
    recorded_at: u64,
    sequence: u64,
    record: Record,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySession {
    session_id: String,
    title: String,
    event_count: usize,
    stopped: bool,
    saved_guide_id: Option<String>,
}

/// Saved guides as the recorder wrote them; only the tests read them back this way now (the app
/// goes through the library).
#[cfg(test)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSummary {
    id: String,
    title: String,
    updated_at: String,
    step_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideDocument {
    guide: Value,
    steps: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMonitor {
    pub bounds: PxRect,
    /// The main screen. The settings name it "Screen 1 (main)".
    pub primary: bool,
    /// The monitor's own name ("DELL U2720Q"), when it gives one.
    pub name: Option<String>,
}

#[derive(Debug)]
struct Session {
    id: String,
    directory: PathBuf,
    sequence: Arc<AtomicU64>,
    gap: Arc<JournalGap>,
    /// Steps the capture worker has handed to its writer and that aren't journalled yet.
    backlog: Arc<capture::queued_sink::Backlog>,
    /// Facts up to this sequence were dropped by "Start again" (restart.json keeps it on disk).
    restart: Option<u64>,
    /// What an undo of the last "Start again" puts back: the earlier restart point, counts and
    /// restart tick.
    undo_restart: Option<(Option<u64>, u64, u64, Option<u32>)>,
}

/// Facts captured but not saved (e.g. a full disk), shared by every journal writer of one
/// recording, so the "missed here" marker is written once saving works again.
#[derive(Debug, Default)]
struct JournalGap {
    unsaved: AtomicU64,
    /// Held while a marker is written, so only one writer flushes the count.
    flushing: Mutex<()>,
    /// The last click or screenshot saved, so the marker sits in the right place.
    last_record_id: AtomicU64,
}

#[derive(Debug)]
struct Inner {
    input: Option<InputCapture>,
    machine: Arc<Mutex<RecorderStateMachine>>,
    worker: Option<JoinHandle<()>>,
    stop: Option<Arc<AtomicBool>>,
    library: Option<PathBuf>,
    display_name: String,
    app_data: Option<PathBuf>,
    session: Option<Session>,
    discard_after_stop: bool,
    input_source: InputSource,
    capture_mode: CaptureMode,
    target_monitor: Option<PxRect>,
    /// The running recording registered the keyboard, so Pause and Resume switch it too.
    keys: bool,
}

/// App-managed input registration, recorder state and worker lifetime.
#[derive(Debug, Clone)]
pub struct RecorderService {
    inner: Arc<Mutex<Inner>>,
    /// When the recorder bar last said it is alive (ms since 1970).
    heartbeat: Arc<AtomicU64>,
}

impl Default for RecorderService {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                input: None,
                machine: Arc::new(Mutex::new(RecorderStateMachine::new(Vec::new()))),
                worker: None,
                stop: None,
                library: None,
                display_name: String::new(),
                app_data: None,
                session: None,
                discard_after_stop: false,
                input_source: InputSource::RawInput,
                capture_mode: CaptureMode::Window,
                target_monitor: None,
                keys: false,
            })),
            heartbeat: Arc::new(AtomicU64::new(0)),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn session_directory(inner: &Inner, session_id: &str) -> Result<PathBuf, CommandError> {
    if !safe_segment(session_id) {
        return Err(CommandError::new(
            "invalidSession",
            "The recording id is invalid.",
        ));
    }
    if let Some(session) = inner
        .session
        .as_ref()
        .filter(|session| session.id == session_id)
    {
        return Ok(session.directory.clone());
    }
    let directory = inner
        .app_data
        .as_ref()
        .ok_or_else(|| CommandError::new("notReady", "The recorder is not initialized."))?
        .join("recordings")
        .join(session_id);
    if !directory.is_dir() {
        return Err(CommandError::new(
            "sessionNotFound",
            "The recording session was not found.",
        ));
    }
    Ok(directory)
}

fn snapshot_locked(inner: &Inner) -> RecorderSnapshot {
    snapshot_from(
        &inner.machine,
        inner.session.as_ref().map(|session| session.id.as_str()),
        inner.input_source,
    )
}

fn snapshot_from(
    machine: &Mutex<RecorderStateMachine>,
    session_id: Option<&str>,
    source: InputSource,
) -> RecorderSnapshot {
    let machine = lock(machine);
    let (state, reason) = match machine.state() {
        RecorderState::Idle => ("idle", None),
        RecorderState::Recording => ("recording", None),
        RecorderState::Paused { reason, .. } => ("paused", Some(format!("{reason:?}"))),
        RecorderState::Degraded { reason } => ("degraded", Some(format!("{reason:?}"))),
        RecorderState::Stopping { .. } => ("stopping", None),
    };
    RecorderSnapshot {
        state,
        reason,
        session_id: session_id.map(str::to_string),
        step_count: if session_id.is_some() {
            machine.step_count()
        } else {
            0
        },
        missed_count: if session_id.is_some() {
            machine.missed_count()
        } else {
            0
        },
        other_screen_clicks: if session_id.is_some() {
            machine.other_screen_clicks()
        } else {
            0
        },
        input_source: match source {
            InputSource::RawInput => "rawInput",
            InputSource::Hook => "hook",
        },
        keys_recorded: machine.keys_recorded(),
    }
}

impl RecorderService {
    /// Whether the recorder bar has answered recently, so a recording can be seen.
    fn indicator_alive(&self) -> bool {
        unix_millis().saturating_sub(self.heartbeat.load(Ordering::SeqCst)) <= INDICATOR_TIMEOUT_MS
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Pauses recording if the recorder bar stops answering (e.g. its web view crashed), so nothing
/// is ever recorded without a visible indicator. The warning is a native box, because the web
/// views may be the thing that failed. Resuming stays the user's choice.
fn spawn_indicator_watchdog(
    app: AppHandle,
    service: RecorderService,
    machine: Arc<Mutex<RecorderStateMachine>>,
    shared: Arc<InputShared>,
    stop: Arc<AtomicBool>,
) {
    let spawned = std::thread::Builder::new()
        .name("amluto-indicator-watchdog".into())
        .spawn(move || {
            let mut warned = false;
            while !stop.load(Ordering::SeqCst) {
                // Ask the bar to answer. Page timers are throttled when the bar is covered (e.g.
                // by a full-screen app), but an incoming event still runs its handler, so a live
                // bar keeps answering; only a dead one goes quiet.
                let _ = app.emit_to("recorder-bar", HEARTBEAT_REQUEST_EVENT, ());
                std::thread::sleep(std::time::Duration::from_secs(1));
                let silent_for =
                    unix_millis().saturating_sub(service.heartbeat.load(Ordering::SeqCst));
                if silent_for <= INDICATOR_TIMEOUT_MS {
                    warned = false;
                    continue;
                }
                let paused = {
                    let mut state = lock(&machine);
                    state.is_active() && state.pause(PauseReason::IndicatorLost, now_tick()).is_ok()
                };
                if !paused {
                    continue;
                }
                shared.enabled.store(false, Ordering::SeqCst);
                publish_state(&app, &service.snapshot());
                log::error!(
                    "The recorder bar stopped responding for {silent_for} ms; recording paused."
                );
                if !warned {
                    warned = true;
                    let _ = std::thread::Builder::new()
                        .name("amluto-indicator-warning".into())
                        .spawn(|| {
                            capture::platform::window::show_warning(
                                "Steps: recording paused",
                                "The recording bar stopped responding, so Steps paused \
                                 the recording. It never records without showing that it is \
                                 recording.\n\nThe steps so far are saved. Close and reopen \
                                 Steps to review them.",
                            );
                        });
                }
            }
        });
    if let Err(error) = spawned {
        log::error!("Could not start the recording indicator watchdog: {error}");
    }
}

fn publish_state(app: &AppHandle, snapshot: &RecorderSnapshot) {
    let _ = app.emit(STATE_EVENT, snapshot);
    crate::browser_link::recording_changed(app, snapshot.state);
    let indicator_lost = snapshot
        .reason
        .as_deref()
        .is_some_and(|reason| reason.starts_with("IndicatorLost"));
    let status = match snapshot.state {
        "recording" => "Recording",
        "paused" if indicator_lost => "Paused: the recording bar stopped responding",
        "paused" => "Paused",
        "degraded" => "Recording may be missing clicks",
        "stopping" => "Finishing recording",
        _ => "Ready to record",
    };
    // While what's typed is read, the tray says so too (docs/spec/02-capture.md#keys).
    let keys = if snapshot.keys_recorded && snapshot.state != "idle" {
        ", keys recorded"
    } else {
        ""
    };
    set_tray_tooltip(app, format!("Steps — {status}{keys}"));
}

/// The tray's tooltip, set on the main thread without waiting for it: the callers often hold the
/// recorder's lock, and waiting for the main thread while a main-thread command waits for the
/// lock would freeze the app. Only a changed text is sent, since every recorded fact publishes.
fn set_tray_tooltip(app: &AppHandle, text: String) {
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    {
        let mut last = lock(&LAST);
        if last.as_deref() == Some(text.as_str()) {
            return;
        }
        *last = Some(text.clone());
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(tray) = handle.tray_by_id("main") {
            let _ = tray.set_tooltip(Some(&text));
        }
    });
}

fn join_finished_worker(inner: &mut Inner) {
    if inner.worker.as_ref().is_some_and(JoinHandle::is_finished)
        && let Some(worker) = inner.worker.take()
    {
        let _ = worker.join();
        inner.stop = None;
    }
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A program's file name, as exclusions name it: `KeePass.exe` on Windows, `keepassxc` on Linux.
fn safe_executable_name(value: &str) -> bool {
    let named = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+'));
    if cfg!(windows) {
        named && value.to_ascii_lowercase().ends_with(".exe")
    } else {
        named && !value.starts_with('.')
    }
}

/// Recording needs somewhere global clicks and screenshots can be taken: on Linux, an X11 session
/// (docs/spec/02-capture.md#linux-x11-phase-10). Always fine on Windows.
#[cfg_attr(
    windows,
    allow(
        clippy::unnecessary_wraps,
        reason = "always fine on Windows; Linux can refuse"
    )
)]
pub(crate) fn session_can_record() -> Result<(), CommandError> {
    #[cfg(target_os = "linux")]
    if capture::platform::session_is_wayland() || !capture::platform::x_server_available() {
        return Err(CommandError::new(
            "waylandSession",
            "Steps can only record in an X11 session. Sign out, choose one at the sign-in screen \
             (such as \"Ubuntu on Xorg\"), and sign in again, or use Steps for Chrome.",
        ));
    }
    Ok(())
}

fn unique_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    format!("{:032x}", nanos ^ u128::from(std::process::id()))
}

fn manual_media_id() -> u64 {
    // This id crosses the Tauri JSON bridge as a JavaScript number. Nanoseconds since the epoch
    // exceed Number.MAX_SAFE_INTEGER; microseconds are precise for the lifetime of this format.
    const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_micros());
    u64::try_from(micros.min(u128::from(MAX_JS_SAFE_INTEGER))).unwrap_or(MAX_JS_SAFE_INTEGER)
}

fn storage_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("storageError", error.to_string())
}

fn not_recording() -> CommandError {
    CommandError::new(
        "notRecording",
        "Start again works while a recording is running.",
    )
}

fn nothing_to_undo() -> CommandError {
    CommandError::new("nothingToUndo", "There is nothing to undo.")
}
