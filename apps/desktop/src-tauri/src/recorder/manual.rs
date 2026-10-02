//! Manual captures: "Capture now" and the shortcut popup's steps.

use std::sync::Arc;

use capture::coords::{PxRect, point_to_pct};
use capture::facts::{CaptureFacts, ManualRecord, Record, WindowFacts};
use capture::pipeline::Sink;
use capture::platform::display::{cursor_pos, now_tick};
use capture::platform::window::{
    Elevation, foreground_window, front_window_except, own_process_id, root_window_at,
};
use capture::{pipeline, screenshot};
use tauri::{AppHandle, Manager};

use super::journal::JournalSink;
use super::{CommandError, RecorderService, lock, manual_media_id};

impl RecorderService {
    #[allow(
        clippy::too_many_lines,
        reason = "Manual capture ordering protects the hotkey screenshot."
    )]
    pub(crate) fn capture_manual(
        &self,
        app: &AppHandle,
        purpose: &'static str,
    ) -> Result<(), CommandError> {
        let (
            session_id,
            directory,
            machine,
            sequence,
            gap,
            input_source,
            capture_mode,
            target_monitor,
        ) = {
            let inner = lock(&self.inner);
            let session = inner.session.as_ref().ok_or_else(|| {
                CommandError::new("noRecording", "Start a recording before adding this step.")
            })?;
            (
                session.id.clone(),
                session.directory.clone(),
                Arc::clone(&inner.machine),
                Arc::clone(&session.sequence),
                Arc::clone(&session.gap),
                inner.input_source,
                inner.capture_mode,
                inner.target_monitor,
            )
        };
        if !lock(&machine).is_active() {
            return Err(CommandError::new(
                "recordingPaused",
                "Resume recording before adding this step.",
            ));
        }
        let (x, y) = cursor_pos().ok_or_else(|| {
            CommandError::new(
                "cursorUnavailable",
                "The current screen could not be captured.",
            )
        })?;
        if target_monitor.is_some_and(|monitor| !monitor.contains(x, y)) {
            return Err(CommandError::new(
                "outsideTargetMonitor",
                "Move the pointer onto the selected monitor before capturing a step.",
            ));
        }
        let window = root_window_at(x, y)
            .or_else(foreground_window)
            .ok_or_else(|| {
                CommandError::new("windowUnavailable", "There is no window to capture.")
            })?;
        // Chosen from the recording bar's menu, the pointer is on the bar: the step is for the
        // app behind it, the one in use before the bar was clicked.
        let window = if window.pid == own_process_id() && purpose == "shortcut" {
            front_window_except(own_process_id()).unwrap_or(window)
        } else {
            window
        };
        if window.pid == own_process_id() {
            return Err(CommandError::new(
                "ownWindow",
                "Move to the app you want to capture, then press the shortcut again.",
            ));
        }
        if pipeline::is_excluded_window(&machine, &window) {
            return Err(CommandError::new(
                "excludedApp",
                "This app is excluded from recording, so it can't be captured.",
            ));
        }
        let frame: PxRect = window.frame.into();
        let mut shot = screenshot::capture(capture_mode, Some(frame), x, y, target_monitor)
            .map_err(|_| {
                CommandError::new("screenshotFailed", "The screen could not be captured.")
            })?;
        if capture_mode == screenshot::CaptureMode::Window {
            screenshot::hide_covering(&mut shot, window.pid, None);
        }
        let excluded = lock(&machine).excluded_apps().to_vec();
        screenshot::hide_excluded(&mut shot, &excluded);
        let exe = window.exe_name().map(str::to_string);
        let remote_session = exe
            .as_deref()
            .is_some_and(capture::pipeline::is_remote_client);
        let elevation = match window.elevation {
            Elevation::NotElevated => "notElevated",
            Elevation::Elevated => "elevated",
            Elevation::Unknown => "unknown",
        };
        let tick_ms = now_tick();
        let media_id = manual_media_id();
        let record = ManualRecord {
            id: media_id,
            tick_ms,
            purpose,
            action_text: if purpose == "shortcut" {
                "Shortcut screenshot"
            } else {
                "Capture this screen"
            }
            .into(),
            window: WindowFacts {
                title: window.title,
                exe,
                pid: window.pid,
                frame,
                elevation,
                remote_session,
                // A screenshot step, not an app switch: its wording doesn't use the app's name.
                app_name: None,
                shell: false,
            },
            capture: CaptureFacts {
                mode: capture_mode.as_str(),
                rect: shot.rect,
                monitor: shot.monitor,
                scale: shot.scale,
                width: shot.image.width(),
                height: shot.image.height(),
                image: None,
            },
            click_pct: point_to_pct(&shot.rect, x, y),
        };
        if purpose == "captureNow" {
            lock(&machine).note_auxiliary_step();
        }
        let mut sink = JournalSink::new(
            app.clone(),
            session_id,
            directory,
            machine,
            sequence,
            gap,
            input_source,
        );
        sink.write(Record::Manual(record), Some(shot.image));
        Ok(())
    }

    pub(crate) fn capture_now(&self, app: &AppHandle) -> Result<(), CommandError> {
        self.capture_manual(app, "captureNow")
    }

    pub(crate) fn add_shortcut(&self, app: &AppHandle) -> Result<(), CommandError> {
        self.capture_manual(app, "shortcut")?;
        let popup = app.get_webview_window("shortcut-popup").ok_or_else(|| {
            CommandError::new(
                "shortcutPopupUnavailable",
                "The shortcut popup is unavailable.",
            )
        })?;
        popup.show().and_then(|()| popup.set_focus()).map_err(|_| {
            CommandError::new(
                "shortcutPopupUnavailable",
                "The shortcut popup could not be opened.",
            )
        })
    }
}
