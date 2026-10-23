//! Retake (docs/spec/04-editor.md#editing-steps): a new screenshot for a step. The main window
//! gets out of the way, a countdown gives time to bring the right window to the front, and then
//! the window in front is captured the way recordings are (just the window, or its monitor), with
//! other programs' windows over it greyed and notification toasts greyed or noted as a click's
//! screenshot has them (#96).
//!
//! Nothing is recorded: no clicks are read and no journal is written. The same rules as recording
//! apply to what may be captured: never Steps itself, never an excluded app.

use std::thread;
use std::time::Duration;

use capture::coords::{PctRect, PxRect};
use capture::facts::CaptureFacts;
use capture::pipeline;
use capture::platform::window::{
    ShownWindow, WindowInfo, foreground_window, own_process_id, shown_windows,
};
use capture::screenshot::{self, CaptureMode, Shot};
use image::RgbaImage;
use tauri::{AppHandle, Manager};

use super::{RecorderService, lock};
use crate::error::CommandError;

/// The longest countdown the editor may ask for.
pub(crate) const MAX_RETAKE_DELAY_MS: u64 = 15_000;

/// A retake's picture, readied as a click's screenshot is, and where a notification toast still
/// shows in it.
pub(crate) struct Retaken {
    pub(crate) image: RgbaImage,
    /// % of the picture; empty when none shows. They become the step's `media.notifications`.
    pub(crate) notifications: Vec<PctRect>,
}

/// A retake stored as an image, as the editor gets it: the image, and where a toast showed on it
/// (left out when none did), which replace the step's picture and its toasts.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetakenMedia {
    #[serde(flatten)]
    pub media: library::MediaInfo,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notifications: Vec<PctRect>,
}

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
    ) -> Result<Retaken, CommandError> {
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
fn capture_front(mode: CaptureMode, excluded: &[String]) -> Result<Retaken, CommandError> {
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
    // Asked once the picture is taken, at the window's middle, as for an "Open" step's: one that
    // went in between counts as gone too, so more is greyed rather than less.
    let gone = mode == CaptureMode::Window && screenshot::window_gone(window.hwnd, x, y);
    let notifications = ready(&mut shot, mode, &window, shown_windows(), gone);
    // Another excluded app beside or over the window is blacked out, as in a recording.
    screenshot::hide_excluded(&mut shot, excluded);
    Ok(Retaken {
        image: shot.image,
        notifications,
    })
}

/// Readies a retake's picture of `front`, the window in front, as a click's screenshot is
/// (docs/spec/04-editor.md#editing-steps, #96): in window mode, other programs' windows lying over
/// it are greyed, notification toasts among them, by the rule a click on it would have
/// ([`pipeline::cover_for`]); and if it had gone by the picture (`gone`), all but its program's
/// windows. `windows` are those showing, front to back, read as the picture was taken: nothing has
/// come to the front since, as a clicked window has. Returns where a toast still shows in it, as %
/// of it, for the suggested blurs.
fn ready(
    shot: &mut Shot,
    mode: CaptureMode,
    front: &WindowInfo,
    windows: Vec<ShownWindow>,
    gone: bool,
) -> Vec<PctRect> {
    let target = screenshot::Target::window(front.pid, front.frame.into());
    screenshot::handle_other_windows(
        shot,
        mode,
        &target,
        pipeline::cover_for(front),
        Some(windows),
        gone,
    );
    CaptureFacts::of(shot, mode).notifications
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
    use capture::platform::Rect;
    use capture::platform::window::Elevation;

    const WHITE: [u8; 4] = [255, 255, 255, 255];
    /// The grey a covering window is painted in.
    const GREY: [u8; 4] = [208, 213, 221, 255];

    const fn rect(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    const fn platform(rect: PxRect) -> Rect {
        Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    /// The window in front when the countdown ended: program `pid`'s `exe`.
    fn in_front(pid: u32, exe: &str, frame: PxRect) -> WindowInfo {
        WindowInfo {
            hwnd: 0,
            pid,
            title: String::new(),
            exe_path: Some(format!(r"C:\Program Files\{exe}")),
            frame: platform(frame),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    /// An ordinary opaque window of program `pid`, as the windows showing are read.
    const fn shown(pid: u32, frame: PxRect) -> ShownWindow {
        ShownWindow {
            hwnd: 0,
            pid,
            frame: platform(frame),
            see_through: false,
            click_through: false,
            notification: false,
            hosted_pid: None,
        }
    }

    /// A white picture of `rect`, as the screen showed it.
    fn white_shot(rect: PxRect) -> Shot {
        Shot {
            image: RgbaImage::from_pixel(
                u32::try_from(rect.width()).unwrap(),
                u32::try_from(rect.height()).unwrap(),
                image::Rgba(WHITE),
            ),
            rect,
            monitor: rect,
            scale: 1.0,
            ms: 0.0,
            notifications: Vec::new(),
        }
    }

    #[test]
    fn a_chat_over_the_window_in_front_is_greyed_in_window_mode() {
        // Excel (program 3) in front, a chat (program 7) lying over its right-hand side.
        let excel = rect(0, 0, 200, 100);
        let chat = rect(150, 0, 200, 100);
        let windows = vec![shown(7, chat), shown(3, excel)];
        let mut shot = white_shot(excel);
        let notifications = ready(
            &mut shot,
            CaptureMode::Window,
            &in_front(3, "EXCEL.EXE", excel),
            windows,
            false,
        );
        assert_eq!(shot.image.get_pixel(160, 50).0, GREY);
        assert_eq!(shot.image.get_pixel(10, 50).0, WHITE);
        assert!(notifications.is_empty());
    }

    /// A notification toast, shown by the shell's notification host (program 4).
    const fn toast(frame: PxRect) -> ShownWindow {
        ShownWindow {
            notification: true,
            ..shown(4, frame)
        }
    }

    #[test]
    fn a_toast_is_greyed_in_window_mode_and_noted_in_monitor_mode() {
        let screen = rect(0, 0, 200, 100);
        let excel = rect(0, 0, 200, 80);
        let message = rect(150, 50, 200, 90);
        let windows = || vec![toast(message), shown(3, excel)];
        let front = in_front(3, "EXCEL.EXE", excel);

        // The window in front: the toast over it is greyed, so there's nothing left to note.
        let mut shot = white_shot(excel);
        let notifications = ready(&mut shot, CaptureMode::Window, &front, windows(), false);
        assert_eq!(shot.image.get_pixel(160, 60).0, GREY);
        assert!(notifications.is_empty());

        // The whole monitor: the toast is left as it shows, and noted as a share of the picture.
        let mut shot = white_shot(screen);
        let notifications = ready(&mut shot, CaptureMode::Monitor, &front, windows(), false);
        assert_eq!(shot.image.get_pixel(160, 60).0, WHITE);
        assert_eq!(
            notifications,
            vec![PctRect {
                x: 75.0,
                y: 50.0,
                w: 25.0,
                h: 40.0
            }]
        );
    }

    #[test]
    fn over_start_or_search_only_a_toast_is_greyed() {
        // Retaken with the Start menu (program 20) in front: Search's panel (program 21) lying over
        // it is part of the shell, as for a click there; a toast over it is greyed.
        let start = rect(0, 20, 200, 100);
        let search = rect(0, 0, 200, 20);
        let message = rect(150, 60, 200, 100);
        let mut shot = white_shot(start);
        ready(
            &mut shot,
            CaptureMode::Window,
            &in_front(20, "StartMenuExperienceHost.exe", start),
            vec![toast(message), shown(21, search), shown(20, start)],
            false,
        );
        assert_eq!(shot.image.get_pixel(160, 60).0, GREY);
        assert_eq!(shot.image.get_pixel(10, 10).0, WHITE);
    }

    #[test]
    fn with_nothing_over_the_window_in_front_the_picture_is_as_taken() {
        // A chat beside the window and an email behind it, a screen-share border over everything:
        // none of them lies over the window, so nothing is greyed or noted, in either mode.
        let screen = rect(0, 0, 300, 100);
        let excel = rect(0, 0, 200, 100);
        let windows = || {
            vec![
                ShownWindow {
                    see_through: true,
                    click_through: true,
                    ..shown(5, screen)
                },
                shown(7, rect(200, 0, 300, 100)),
                shown(3, excel),
                shown(8, screen),
            ]
        };
        let front = in_front(3, "EXCEL.EXE", excel);
        for (mode, area) in [(CaptureMode::Window, excel), (CaptureMode::Monitor, screen)] {
            let mut shot = white_shot(area);
            let notifications = ready(&mut shot, mode, &front, windows(), false);
            assert!(
                shot.image.pixels().all(|pixel| pixel.0 == WHITE),
                "{mode:?}"
            );
            assert!(notifications.is_empty(), "{mode:?}");
        }
    }

    #[test]
    fn the_editor_gets_the_image_with_its_toasts_beside_it() {
        let media = library::MediaInfo {
            id: "retake-1".into(),
            width: 1280,
            height: 720,
        };
        let noted = RetakenMedia {
            media: media.clone(),
            notifications: vec![PctRect {
                x: 75.0,
                y: 50.0,
                w: 25.0,
                h: 40.0,
            }],
        };
        assert_eq!(
            serde_json::to_value(noted).unwrap(),
            serde_json::json!({
                "id": "retake-1",
                "width": 1280,
                "height": 720,
                "notifications": [{ "x": 75.0, "y": 50.0, "w": 25.0, "h": 40.0 }],
            })
        );
        // None showing: none sent, so the step's picture has none.
        let plain = RetakenMedia {
            media,
            notifications: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(plain).unwrap(),
            serde_json::json!({ "id": "retake-1", "width": 1280, "height": 720 })
        );
    }

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
