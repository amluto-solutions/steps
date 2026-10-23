//! Manual captures: "Capture now" and the shortcut popup's steps.

use std::sync::Arc;

use capture::coords::{PxRect, point_to_pct};
use capture::facts::{CaptureFacts, ManualRecord, Record};
use capture::pipeline::Sink;
use capture::platform::display::{cursor_pos, now_tick};
use capture::platform::window::{
    foreground_window, front_window_except, own_process_id, root_window_at,
};
use capture::{pipeline, screenshot};
use tauri::{AppHandle, Manager};

use super::journal::JournalSink;
use super::{RecorderService, lock, manual_media_id, publish_state, snapshot_locked};
use crate::error::CommandError;

/// How long Capture now and Add shortcut wait for earlier clicks to be journalled.
const MANUAL_WAITS_FOR_CLICKS: std::time::Duration = std::time::Duration::from_secs(5);

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
            backlog,
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
                Arc::clone(&session.backlog),
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
        screenshot::handle_other_windows(
            &mut shot,
            capture_mode,
            &screenshot::Target::window(window.pid, frame),
            screenshot::Cover::Others,
            None,
            // The window was read at the pointer just before the picture.
            false,
        );
        let excluded = lock(&machine).excluded_apps().to_vec();
        screenshot::hide_excluded(&mut shot, &excluded);
        // With the app's own name, as a click has: the recording bar names "Never record" by it
        // (#85). A screenshot step's wording doesn't use it.
        let window_facts = pipeline::window_facts(&window);
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
            window: window_facts,
            capture: CaptureFacts::of(&shot, capture_mode),
            click_pct: point_to_pct(&shot.rect, x, y),
        };
        if purpose == "captureNow" {
            lock(&machine).note_auxiliary_step();
        }
        // Clicks made before this step may still be waiting for the capture worker's writer: they
        // are journalled first, so this step isn't numbered before them (07/10/2026). A writer
        // that takes longer than this still gets the step saved, a little out of place.
        let _ = backlog.wait_until_written(MANUAL_WAITS_FOR_CLICKS);
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
        })?;
        let snapshot = {
            let inner = lock(&self.inner);
            lock(&inner.machine).wait_for_shortcut();
            snapshot_locked(&inner)
        };
        publish_state(app, &snapshot);
        Ok(())
    }

    /// The shortcut popup closed, with the keys saved as a step (`added`) or cancelled: the bar
    /// stops waiting, and a saved step counts.
    pub(crate) fn shortcut_done(&self, app: &AppHandle, added: bool) {
        let snapshot = {
            let inner = lock(&self.inner);
            lock(&inner.machine).shortcut_done(added);
            snapshot_locked(&inner)
        };
        publish_state(app, &snapshot);
    }
}
