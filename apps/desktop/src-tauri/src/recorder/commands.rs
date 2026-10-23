//! The recorder's Tauri commands.

use std::sync::atomic::Ordering;

use capture::coords::PxRect;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use super::recording::{RecordingSettings, StartOptions};
use super::{
    CaptureMonitor, GuideDocument, RecorderPreferences, RecorderService, RecorderSnapshot,
    RecoverySession, RetakenMedia, STEP_EVENT, publish_state, unix_millis,
};
use crate::error::CommandError;

// Every command that takes the recorder's lock is `async`: Tauri runs plain command functions on
// the main thread, and a background thread holding the lock may be waiting for the main thread
// (a window or tray call), which would freeze every window. Disk work, image encoding and
// display enumeration would freeze them too. Only the heartbeat and closing the popup stay plain.
#[tauri::command(rename_all = "camelCase")]
pub async fn recorder_start(
    app: AppHandle,
    service: State<'_, RecorderService>,
    title: String,
    options: StartOptions,
) -> Result<RecorderSnapshot, CommandError> {
    super::session_can_record()?;
    let service = service.inner().clone();
    // UIA focus-handler registration can call back into WebView2; keep its wait off the UI thread.
    tauri::async_runtime::spawn_blocking(move || service.start(&app, &title, options))
        .await
        .map_err(|error| CommandError::new("workerStartFailed", error.to_string()))?
}

#[tauri::command(async)]
pub fn recorder_get_preferences(
    service: State<'_, RecorderService>,
) -> Result<RecorderPreferences, CommandError> {
    service.preferences()
}

#[tauri::command(async)]
pub fn recorder_set_preferences(
    service: State<'_, RecorderService>,
    preferences: RecorderPreferences,
) -> Result<RecorderPreferences, CommandError> {
    service.set_preferences(preferences)
}

#[tauri::command(async)]
pub fn recorder_get_state(service: State<'_, RecorderService>) -> RecorderSnapshot {
    service.snapshot()
}

#[tauri::command(async)]
pub fn recorder_pause(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<RecorderSnapshot, CommandError> {
    service.pause(&app)
}

#[tauri::command(async)]
pub fn recorder_resume(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<RecorderSnapshot, CommandError> {
    service.resume(&app)
}

#[tauri::command(async)]
pub fn recorder_stop(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<RecorderSnapshot, CommandError> {
    service.stop(&app)
}

#[tauri::command(async)]
pub fn recorder_discard(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<RecorderSnapshot, CommandError> {
    service.discard(&app)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_set_input_source(
    app: AppHandle,
    service: State<'_, RecorderService>,
    source: String,
) -> Result<RecorderSnapshot, CommandError> {
    service.set_source(&app, &source)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_exclude_app(
    app: AppHandle,
    service: State<'_, RecorderService>,
    exe_name: String,
) -> Result<RecorderSnapshot, CommandError> {
    service.exclude_app(&app, &exe_name)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_include_app(
    app: AppHandle,
    service: State<'_, RecorderService>,
    exe_name: String,
) -> Result<RecorderSnapshot, CommandError> {
    service.include_app(&app, &exe_name)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_set_capture_mode(
    service: State<'_, RecorderService>,
    mode: String,
) -> Result<(), CommandError> {
    service.set_capture_mode(&mode)
}

/// "Hide the recording bar from screenshots": Windows leaves the bar out of every screen capture
/// (`WDA_EXCLUDEFROMCAPTURE`), ours and screen sharing's, so a screenshot shows what's behind it.
/// It stays on the screen. Applied at once, even mid-recording.
/// Where "Move to" puts the recording bar: along the top of its screen, where its menu has room
/// to open below it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BarPlace {
    Left,
    Centre,
    Right,
}

/// How wide a maximised window's minimise, maximise and close buttons are together, in logical
/// pixels: Windows 11 draws each 46 wide, and Office, Chrome and Edge match it. Top right stops
/// short of them (P40, 10/10/2026: the bar covered Word's).
const CAPTION_BUTTONS_WIDTH: f64 = 3.0 * 46.0;

/// The bar's top-left corner in a screen's work area (the screen less the taskbar), a small margin
/// in from the edge; at the right, a margin short of a maximised window's caption buttons. All in
/// physical pixels.
fn bar_position(
    area: (i32, i32, u32, u32),
    bar_width: u32,
    scale: f64,
    place: BarPlace,
) -> (i32, i32) {
    let (left, top, width, _) = area;
    let wide = |value: u32| i32::try_from(value).unwrap_or(i32::MAX);
    // 16 logical pixels at this screen's scale; clamped first, so the cast can't overflow.
    #[allow(clippy::cast_possible_truncation)]
    let margin = (16.0 * scale).round().clamp(0.0, 1_000.0) as i32;
    #[allow(clippy::cast_possible_truncation)]
    let caption_buttons = (CAPTION_BUTTONS_WIDTH * scale).round().clamp(0.0, 10_000.0) as i32;
    let room = wide(width).saturating_sub(wide(bar_width));
    let x = match place {
        BarPlace::Left => margin,
        BarPlace::Centre => room / 2,
        BarPlace::Right => room.saturating_sub(margin).saturating_sub(caption_buttons),
    };
    (
        left.saturating_add(x.clamp(0, room.max(0))),
        top.saturating_add(margin),
    )
}

/// Moves the recording bar along the top of the screen it's on: a way to move it without dragging
/// (WCAG 2.5.7), from the bar's own menu.
#[tauri::command(async)]
pub fn recorder_move_bar(app: AppHandle, place: BarPlace) -> Result<(), CommandError> {
    let bar = app.get_webview_window("recorder-bar").ok_or_else(|| {
        CommandError::new(
            "recorderBarUnavailable",
            "The recording indicator is unavailable.",
        )
    })?;
    place_bar(&bar, place).map_err(|error| CommandError::new("barMove", error.to_string()))
}

/// Where "Move the bar" last put the bar, and the corner it put it at.
static LAST_BAR_PLACE: std::sync::Mutex<Option<(BarPlace, (i32, i32))>> =
    std::sync::Mutex::new(None);

/// The place the bar is at now: the one it was last put at, until it's dragged from there. Its
/// width doesn't matter: the bar grows and shrinks from its top-left corner as menus open.
fn place_now(last: Option<(BarPlace, (i32, i32))>, corner: (i32, i32)) -> Option<BarPlace> {
    last.filter(|(_, placed)| *placed == corner)
        .map(|(place, _)| place)
}

/// Which of Top left, Top centre and Top right the bar is at, for its menu to mark; null once
/// it's been dragged elsewhere.
#[tauri::command(async)]
pub fn recorder_bar_place(app: AppHandle) -> Result<Option<BarPlace>, CommandError> {
    let bar = app.get_webview_window("recorder-bar").ok_or_else(|| {
        CommandError::new(
            "recorderBarUnavailable",
            "The recording indicator is unavailable.",
        )
    })?;
    let corner = bar
        .outer_position()
        .map_err(|error| CommandError::new("barMove", error.to_string()))?;
    let last = *LAST_BAR_PLACE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(place_now(last, (corner.x, corner.y)))
}

/// Puts the recording bar at `place` along the top of the screen it's on.
pub(super) fn place_bar(bar: &tauri::WebviewWindow, place: BarPlace) -> tauri::Result<()> {
    let monitor = match bar.current_monitor()? {
        Some(monitor) => monitor,
        None => match bar.primary_monitor()? {
            Some(monitor) => monitor,
            None => return Ok(()),
        },
    };
    let area = monitor.work_area();
    let size = bar.outer_size()?;
    let (x, y) = bar_position(
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
        size.width,
        monitor.scale_factor(),
        place,
    );
    bar.set_position(tauri::PhysicalPosition::new(x, y))?;
    // Read back rather than assumed: Windows can adjust where a window lands.
    let corner = bar
        .outer_position()
        .map_or((x, y), |corner| (corner.x, corner.y));
    *LAST_BAR_PLACE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((place, corner));
    Ok(())
}

/// Where the person last left the bar, for the next recording in this run of Steps.
static LAST_BAR_POSITION: std::sync::Mutex<Option<tauri::PhysicalPosition<i32>>> =
    std::sync::Mutex::new(None);

/// Shows the bar where it was last left, or at the top centre the first time: it used to open at
/// the top left, over most apps' File and Edit menus (F013).
pub(super) fn show_bar(bar: &tauri::WebviewWindow) -> tauri::Result<()> {
    let last = *LAST_BAR_POSITION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match last {
        Some(position) => bar.set_position(position)?,
        None => place_bar(bar, BarPlace::Centre)?,
    }
    bar.show()
}

/// Hides the bar, remembering where it was.
pub(super) fn hide_bar(bar: &tauri::WebviewWindow) {
    if let Ok(position) = bar.outer_position() {
        *LAST_BAR_POSITION
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(position);
    }
    let _ = bar.hide();
}

#[tauri::command(async)]
pub fn recorder_set_bar_hidden(app: AppHandle, hidden: bool) -> Result<(), CommandError> {
    let bar = app.get_webview_window("recorder-bar").ok_or_else(|| {
        CommandError::new(
            "recorderBarUnavailable",
            "The recording indicator is unavailable.",
        )
    })?;
    bar.set_content_protected(hidden)
        .map_err(|error| CommandError::new("barCapture", error.to_string()))
}

#[tauri::command(async)]
pub fn recorder_get_monitors() -> Result<Vec<CaptureMonitor>, CommandError> {
    available_monitors()
}

pub(super) fn available_monitors() -> Result<Vec<CaptureMonitor>, CommandError> {
    capture::screenshot::monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|screen| CaptureMonitor {
                    bounds: screen.rect,
                    primary: screen.primary,
                    name: screen.name,
                })
                .collect()
        })
        .map_err(|error| CommandError::new("monitorListFailed", error))
}

#[tauri::command(async)]
pub fn recorder_set_target_monitor(
    service: State<'_, RecorderService>,
    bounds: Option<PxRect>,
) -> Result<(), CommandError> {
    service.set_target_monitor(bounds)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_append_step(
    app: AppHandle,
    service: State<'_, RecorderService>,
    session_id: String,
    step: Value,
) -> Result<(), CommandError> {
    service.append_step(&session_id, &step)?;
    if step.get("action").and_then(Value::as_str) == Some("keypress") {
        publish_state(&app, &service.snapshot());
    }
    let _ = app.emit(STEP_EVENT, json!({ "sessionId": session_id, "step": step }));
    Ok(())
}

/// Publishes a stopped recording to the default library, or to `library_id` when Save as chose
/// another one (a one-off: the default stays).
#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_finalize(
    service: State<'_, RecorderService>,
    libraries: State<'_, crate::library::LibraryService>,
    session_id: String,
    guide: Value,
    library_id: Option<String>,
) -> Result<(), CommandError> {
    let target = library_id
        .map(|id| {
            libraries
                .library(&id)
                .map(|library| library.root().to_path_buf())
        })
        .transpose()?;
    service.finalize(&session_id, &guide, target)
}

/// Where a recording made into an open guide puts its screenshots
/// (docs/spec/04-editor.md#record-steps-here): the guide's own folder in a library, or an unsaved
/// recording's folder when the guide open is one of those.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MediaDestination {
    #[serde(rename_all = "camelCase")]
    Guide {
        library_id: String,
        guide_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Draft { session_id: String },
}

/// A screenshot of the recording and the id it takes where it's copied to: recordings name
/// theirs `click-12`, so the guide may already have one by that name.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRename {
    media_id: String,
    new_media_id: String,
}

/// Copies a stopped recording's screenshots, byte for byte, into the guide it was recorded into,
/// before its steps go into the open editor.
#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_copy_media(
    service: State<'_, RecorderService>,
    libraries: State<'_, crate::library::LibraryService>,
    locks: State<'_, crate::locks::LockService>,
    session_id: String,
    into: MediaDestination,
    media: Vec<MediaRename>,
) -> Result<(), CommandError> {
    match into {
        MediaDestination::Draft { session_id: draft } => {
            let pairs: Vec<(String, String)> = media
                .into_iter()
                .map(|item| (item.media_id, item.new_media_id))
                .collect();
            service.copy_media_to_draft(&session_id, &draft, &pairs)
        }
        MediaDestination::Guide {
            library_id,
            guide_id,
        } => {
            let ids: Vec<&str> = media.iter().map(|item| item.media_id.as_str()).collect();
            let sources = service.media_files(&session_id, &ids)?;
            let copies: Vec<library::MediaCopy> = sources
                .into_iter()
                .zip(media)
                .map(|(source, item)| library::MediaCopy {
                    source,
                    thumbnail: None,
                    new_id: item.new_media_id,
                })
                .collect();
            crate::library::add_recording_media(&libraries, &locks, &library_id, &guide_id, &copies)
        }
    }
}

#[tauri::command(async)]
pub fn recorder_get_recoveries(
    service: State<'_, RecorderService>,
) -> Result<Vec<RecoverySession>, CommandError> {
    service.recoveries()
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_recover_session(
    app: AppHandle,
    service: State<'_, RecorderService>,
    session_id: String,
) -> Result<RecorderSnapshot, CommandError> {
    let snapshot = service.recover_session(&session_id)?;
    publish_state(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_get_recovery_records(
    service: State<'_, RecorderService>,
    session_id: String,
) -> Result<Vec<Value>, CommandError> {
    service.recovery_records(&session_id)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_get_session_steps(
    service: State<'_, RecorderService>,
    session_id: String,
) -> Result<Vec<Value>, CommandError> {
    service.session_steps(&session_id)
}

/// Retake for an unsaved recording: a new screenshot of the window in front after the countdown,
/// stored with the recording's other screenshots, with where a toast showed on it.
#[tauri::command(rename_all = "camelCase")]
pub async fn recorder_retake_draft_image(
    app: AppHandle,
    service: State<'_, RecorderService>,
    session_id: String,
    delay_ms: u64,
    excluded: Vec<String>,
    quality: Option<library::ScreenshotQuality>,
) -> Result<RetakenMedia, CommandError> {
    let service = service.inner().clone();
    let quality = crate::policy::screenshot_quality(quality.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        let retaken = service.retake(&app, delay_ms, &excluded)?;
        Ok(RetakenMedia {
            media: service.store_draft_image(&session_id, retaken.image, quality)?,
            notifications: retaken.notifications,
        })
    })
    .await
    .map_err(|error| CommandError::new("screenshotFailed", error.to_string()))?
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_load_image(
    service: State<'_, RecorderService>,
    session_id: String,
    name: String,
) -> Result<String, CommandError> {
    service.image_data(&session_id, &name)
}

/// Closes the shortcut popup, `added` when its keys were saved as a step, so the bar stops
/// waiting for them and counts the step.
#[tauri::command]
pub fn recorder_close_shortcut_popup(
    app: AppHandle,
    service: State<'_, RecorderService>,
    added: bool,
) -> Result<(), CommandError> {
    // Not waiting any more, even when the popup can't be hidden: the keys came or were cancelled.
    service.shortcut_done(&app, added);
    let popup = app.get_webview_window("shortcut-popup").ok_or_else(|| {
        CommandError::new("shortcutPopupUnavailable", "The popup is unavailable.")
    })?;
    popup.hide().map_err(|_| {
        CommandError::new("shortcutPopupUnavailable", "The popup could not be closed.")
    })
}

#[tauri::command(async)]
pub fn recorder_capture_now(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<(), CommandError> {
    service.capture_now(&app)
}

#[tauri::command(async)]
pub fn recorder_add_shortcut(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<(), CommandError> {
    service.add_shortcut(&app)
}

/// The recorder bar says it is alive, about once a second while it is showing. If it goes
/// quiet during a recording, the recording pauses (`spawn_indicator_watchdog`).
#[tauri::command]
pub fn recorder_bar_heartbeat(service: State<'_, RecorderService>) {
    service.heartbeat.store(unix_millis(), Ordering::SeqCst);
}

#[tauri::command(async)]
pub fn recorder_start_again(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<RecorderSnapshot, CommandError> {
    service.start_again(&app)
}

#[tauri::command(async)]
pub fn recorder_undo_start_again(
    app: AppHandle,
    service: State<'_, RecorderService>,
) -> Result<RecorderSnapshot, CommandError> {
    service.undo_start_again(&app)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_get_restart_point(
    service: State<'_, RecorderService>,
    session_id: String,
) -> Result<Option<u64>, CommandError> {
    service.restart_point(&session_id)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_get_recording_settings(
    service: State<'_, RecorderService>,
    session_id: String,
) -> Result<Option<RecordingSettings>, CommandError> {
    service.recording_settings(&session_id)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_save_draft(
    service: State<'_, RecorderService>,
    session_id: String,
    guide: Value,
    steps: Vec<Value>,
) -> Result<(), CommandError> {
    service.save_draft(&session_id, &guide, &steps)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_save_draft_guide(
    service: State<'_, RecorderService>,
    session_id: String,
    guide: Value,
) -> Result<(), CommandError> {
    service.save_draft_guide(&session_id, &guide)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_save_draft_step(
    service: State<'_, RecorderService>,
    session_id: String,
    step: Value,
) -> Result<(), CommandError> {
    service.save_draft_step(&session_id, &step)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_delete_draft_step(
    service: State<'_, RecorderService>,
    session_id: String,
    step_id: String,
) -> Result<(), CommandError> {
    service.delete_draft_step(&session_id, &step_id)
}

#[tauri::command(async, rename_all = "camelCase")]
pub fn recorder_load_draft(
    service: State<'_, RecorderService>,
    session_id: String,
) -> Result<Option<GuideDocument>, CommandError> {
    service.load_draft(&session_id)
}

#[cfg(test)]
mod tests {
    use super::{BarPlace, bar_position, place_now};

    #[test]
    fn the_bar_moves_along_the_top_of_the_work_area() {
        // A 1920 x 1040 work area at (0, 0), 150% scale, a 600 px bar.
        let area = (0, 0, 1920, 1040);
        assert_eq!(bar_position(area, 600, 1.5, BarPlace::Left), (24, 24));
        assert_eq!(bar_position(area, 600, 1.5, BarPlace::Centre), (660, 24));
        // A second screen to the left, and a bar wider than it.
        assert_eq!(
            bar_position((-1280, 0, 1280, 984), 600, 1.0, BarPlace::Left),
            (-1264, 16)
        );
        assert_eq!(
            bar_position((0, 0, 500, 400), 600, 1.0, BarPlace::Right),
            (0, 16)
        );
    }

    #[test]
    fn at_top_right_the_bar_keeps_clear_of_a_maximised_windows_caption_buttons() {
        // Minimise, maximise and close are 46 logical px wide each (138 px together), along the
        // top right of a maximised window: 207 px at 150%. The bar stops a margin short of them.
        let (x, y) = bar_position((0, 0, 1920, 1040), 600, 1.5, BarPlace::Right);
        assert_eq!((x, y), (1089, 24));
        assert!(x + 600 <= 1920 - 207);
        // At 100% on a second screen to the right.
        assert_eq!(
            bar_position((1920, 0, 1280, 984), 400, 1.0, BarPlace::Right),
            (1920 + 1280 - 400 - 16 - 138, 16)
        );
    }

    #[test]
    fn the_bar_is_at_the_place_it_was_moved_to_until_it_is_dragged() {
        let moved = Some((BarPlace::Right, (1089, 24)));
        assert_eq!(place_now(moved, (1089, 24)), Some(BarPlace::Right));
        // Dragged since, even a little: no place in the menu is current.
        assert_eq!(place_now(moved, (1090, 24)), None);
        assert_eq!(place_now(None, (660, 24)), None);
    }
}
