//! The recorder's Tauri commands.

use std::sync::atomic::Ordering;

use capture::coords::PxRect;
use library::MediaInfo;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use super::recording::StartOptions;
use super::{
    CaptureMonitor, CommandError, GuideDocument, RecorderPreferences, RecorderService,
    RecorderSnapshot, RecoverySession, STEP_EVENT, publish_state, unix_millis,
};

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BarPlace {
    Left,
    Centre,
    Right,
}

/// The bar's top-left corner in a screen's work area (the screen less the taskbar), a small margin
/// in from the edge. All in physical pixels.
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
    let room = wide(width).saturating_sub(wide(bar_width));
    let x = match place {
        BarPlace::Left => margin,
        BarPlace::Centre => room / 2,
        BarPlace::Right => room.saturating_sub(margin),
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
    bar.set_position(tauri::PhysicalPosition::new(x, y))
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
                .library(&service, &id)
                .map(|library| library.root().to_path_buf())
        })
        .transpose()?;
    service.finalize(&session_id, &guide, target)
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
/// stored with the recording's other screenshots.
#[tauri::command(rename_all = "camelCase")]
pub async fn recorder_retake_draft_image(
    app: AppHandle,
    service: State<'_, RecorderService>,
    session_id: String,
    delay_ms: u64,
    excluded: Vec<String>,
    quality: Option<library::ScreenshotQuality>,
) -> Result<MediaInfo, CommandError> {
    let service = service.inner().clone();
    let quality = crate::policy::screenshot_quality(quality.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        let image = service.retake(&app, delay_ms, &excluded)?;
        service.store_draft_image(&session_id, image, quality)
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

#[tauri::command]
pub fn recorder_close_shortcut_popup(app: AppHandle) -> Result<(), CommandError> {
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
    use super::{BarPlace, bar_position};

    #[test]
    fn the_bar_moves_along_the_top_of_the_work_area() {
        // A 1920 x 1040 work area at (0, 0), 150% scale, a 600 px bar.
        let area = (0, 0, 1920, 1040);
        assert_eq!(bar_position(area, 600, 1.5, BarPlace::Left), (24, 24));
        assert_eq!(bar_position(area, 600, 1.5, BarPlace::Centre), (660, 24));
        assert_eq!(bar_position(area, 600, 1.5, BarPlace::Right), (1296, 24));
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
}
