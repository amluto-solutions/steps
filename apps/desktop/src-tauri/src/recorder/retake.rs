//! Retake (docs/spec/04-editor.md#editing-steps): a new screenshot for a step. The main window
//! gets out of the way, a countdown gives time to bring the right window to the front, and then
//! the window in front is captured the way recordings are (just the window, or its monitor).
//!
//! Nothing is recorded: no clicks are read and no journal is written. The same rules as recording
//! apply to what may be captured: never Steps itself, never an excluded app.

use std::thread;
use std::time::Duration;

use capture::coords::PxRect;
use capture::platform::window::{foreground_window, own_process_id};
use capture::screenshot;
use image::RgbaImage;
use tauri::{AppHandle, Manager};

use super::{CommandError, RecorderService, lock};

/// The longest countdown the editor may ask for.
pub(crate) const MAX_RETAKE_DELAY_MS: u64 = 15_000;

impl RecorderService {
    /// Minimises the main window, waits `delay_ms`, captures the window in front, and brings the
    /// main window back, whether or not the capture worked.
    ///
    /// # Errors
    /// `retakeWhileRecording` while a recording runs; `retakeOwnWindow` if Steps is still in
    /// front; `excludedApp` for an app excluded by the user (`excluded`) or the organisation;
    /// `windowUnavailable` or `screenshotFailed` if nothing could be captured; `waylandSession`
    /// where screenshots can't be taken at all (Linux outside an X11 session).
    pub(crate) fn retake(
        &self,
        app: &AppHandle,
        delay_ms: u64,
        excluded: &[String],
    ) -> Result<RgbaImage, CommandError> {
        super::session_can_record()?;
        if self.is_recording_active() {
            return Err(CommandError::new(
                "retakeWhileRecording",
                "Stop the recording before retaking a screenshot.",
            ));
        }
        let (machine, mode) = {
            let inner = lock(&self.inner);
            (std::sync::Arc::clone(&inner.machine), inner.capture_mode)
        };
        let main = app.get_webview_window("main");
        if let Some(window) = &main {
            let _ = window.minimize();
        }
        thread::sleep(Duration::from_millis(delay_ms.min(MAX_RETAKE_DELAY_MS)));
        let all: Vec<String> = excluded
            .iter()
            .chain(&crate::policy::current().excluded_apps)
            .chain(lock(&machine).excluded_apps())
            .cloned()
            .collect();
        let result = capture_front(mode, &all);
        if let Some(window) = &main {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        result
    }
}

/// Whether `exe` is on the list (Windows file names, so any case).
fn is_excluded(exe: &str, excluded: &[String]) -> bool {
    excluded
        .iter()
        .any(|name| name.trim().eq_ignore_ascii_case(exe))
}

/// The window in front, captured in `mode`. The monitor is the one the window is on, not the
/// recording's chosen monitor: a retake is of this window, wherever it is.
fn capture_front(
    mode: screenshot::CaptureMode,
    excluded: &[String],
) -> Result<RgbaImage, CommandError> {
    let window = foreground_window()
        .ok_or_else(|| CommandError::new("windowUnavailable", "There is no window to capture."))?;
    if window.pid == own_process_id() {
        return Err(CommandError::new(
            "retakeOwnWindow",
            "Steps was still in front when the screenshot was due.",
        ));
    }
    if window
        .exe_name()
        .is_some_and(|exe| is_excluded(exe, excluded))
    {
        return Err(CommandError::new(
            "excludedApp",
            "This app is excluded from recording, so it can't be captured.",
        ));
    }
    let frame: PxRect = window.frame.into();
    let (x, y) = centre(&frame);
    let mut shot = screenshot::capture(mode, Some(frame), x, y, None)
        .map_err(|_| CommandError::new("screenshotFailed", "The screen could not be captured."))?;
    // Another excluded app beside or over the window is blacked out, as in a recording.
    screenshot::hide_excluded(&mut shot, excluded);
    Ok(shot.image)
}

fn centre(frame: &PxRect) -> (i32, i32) {
    (
        frame.left + (frame.right - frame.left) / 2,
        frame.top + (frame.bottom - frame.top) / 2,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_apps_match_in_any_case() {
        let excluded = vec!["Payroll.exe".to_string(), " KEEPASS.EXE ".to_string()];
        assert!(is_excluded("payroll.exe", &excluded));
        assert!(is_excluded("keepass.exe", &excluded));
        assert!(!is_excluded("excel.exe", &excluded));
    }

    #[test]
    fn the_monitor_is_found_from_the_middle_of_the_window() {
        let frame = PxRect {
            left: -1920,
            top: 100,
            right: -920,
            bottom: 700,
        };
        assert_eq!(centre(&frame), (-1420, 400));
    }
}
