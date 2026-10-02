//! The crash-safe journal: every fact and screenshot is written as it arrives.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use capture::facts::Record;
use capture::pipeline::Sink;
use capture::platform::input::InputSource;
use capture::state_machine::RecorderStateMachine;
use image::RgbaImage;
use library::ScreenshotQuality;
use tauri::{AppHandle, Emitter};

use super::files::{write_new_bytes, write_new_bytes_atomic};
use super::{
    CommandError, ERROR_EVENT, FACT_EVENT, JournalGap, RecorderSnapshot, RecordingFact, lock,
    publish_state, snapshot_from,
};

pub(super) struct JournalSink {
    app: AppHandle,
    session_id: String,
    directory: PathBuf,
    machine: Arc<Mutex<RecorderStateMachine>>,
    sequence: Arc<AtomicU64>,
    input_source: InputSource,
    gap: Arc<JournalGap>,
    /// The state last sent to the windows and the tray, so an unchanged one isn't sent again.
    published: Option<RecorderSnapshot>,
}

impl JournalSink {
    pub(super) fn new(
        app: AppHandle,
        session_id: String,
        directory: PathBuf,
        machine: Arc<Mutex<RecorderStateMachine>>,
        sequence: Arc<AtomicU64>,
        gap: Arc<JournalGap>,
        input_source: InputSource,
    ) -> Self {
        Self {
            app,
            session_id,
            directory,
            machine,
            sequence,
            input_source,
            gap,
            published: None,
        }
    }

    fn persist_image(&self, record: &mut Record, image: RgbaImage) -> Result<(), String> {
        let (id, prefix, capture) = match record {
            Record::Click(click) => (click.id, "click", Some(&mut click.capture)),
            Record::Manual(manual) => (manual.id, "manual", Some(&mut manual.capture)),
            Record::Command(command) => (command.id, "command", command.capture.as_mut()),
            Record::Typing(typing) => (typing.id, "typing", typing.capture.as_mut()),
            Record::Keys(keys) => (keys.id, "keys", keys.capture.as_mut()),
            Record::AppSwitch(switch) => (switch.id, "app", switch.capture.as_mut()),
            _ => (0, "", None),
        };
        let capture = capture.ok_or_else(|| "This record cannot own a screenshot.".to_string())?;
        let quality = if lock(&self.machine).original_screenshots() {
            ScreenshotQuality::Original
        } else {
            ScreenshotQuality::Balanced
        };
        let (webp_bytes, width, height) = screenshot_webp(image, quality)?;
        let media_name = format!("{prefix}-{id}.webp");
        write_new_bytes(&self.directory.join("media").join(&media_name), &webp_bytes)
            .map_err(|error| error.to_string())?;
        capture.image = Some(media_name);
        capture.width = width;
        capture.height = height;
        Ok(())
    }
}

/// A screenshot as it is stored, in the recording's quality (the library's rules: Balanced is
/// lossy WebP within 2560 pixels, Original lossless at full size). Returns the bytes and the
/// stored width and height.
pub(super) fn screenshot_webp(
    image: RgbaImage,
    quality: ScreenshotQuality,
) -> Result<(Vec<u8>, u32, u32), String> {
    library::screenshot_webp(image, quality).map_err(|error| error.to_string())
}

impl JournalSink {
    /// Writes one fact to the journal. A fact exists once this succeeds.
    fn journal(&self, record: Record) -> Result<RecordingFact, String> {
        let sequence = self
            .sequence
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        let envelope = RecordingFact {
            session_id: self.session_id.clone(),
            recorded_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |duration| {
                    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
                }),
            sequence,
            record,
        };
        let event_path = self
            .directory
            .join("events")
            .join(format!("{sequence:020}.json"));
        serde_json::to_vec_pretty(&envelope)
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                write_new_bytes_atomic(&event_path, &bytes).map_err(|error| error.to_string())
            })?;
        Ok(envelope)
    }

    /// Marks, at the point it happened, any steps that were captured but couldn't be saved
    /// (e.g. a full disk). Tried before every later fact and once more at Stop.
    pub(super) fn flush_unsaved(&mut self) {
        // One flusher at a time: the capture worker and a Capture now can both get here, and
        // two would write the marker twice and subtract the count twice, wrapping it round.
        let _flushing = lock(&self.gap.flushing);
        let unsaved = self.gap.unsaved.load(Ordering::SeqCst);
        if unsaved == 0 {
            return;
        }
        let after_id = self.gap.last_record_id.load(Ordering::SeqCst);
        let marker = Record::Missed {
            count: unsaved,
            after_id,
        };
        if let Ok(fact) = self.journal(marker) {
            lock(&self.machine).note_unsaved_steps(unsaved, after_id);
            self.gap.unsaved.fetch_sub(unsaved, Ordering::SeqCst);
            let _ = self.app.emit(FACT_EVENT, fact);
        }
    }
}

impl Sink for JournalSink {
    fn write(&mut self, mut record: Record, image: Option<RgbaImage>) {
        // A click still being processed when "Start again" was pressed belongs to the part that
        // was thrown away, though it would get a later sequence than the restart point.
        if record
            .event_tick()
            .is_some_and(|tick| lock(&self.machine).before_restart(tick))
        {
            return;
        }
        let mut image_failed = false;
        if let Some(image) = image
            && let Err(error) = self.persist_image(&mut record, image)
        {
            image_failed = true;
            lock(&self.machine)
                .mark_degraded(capture::state_machine::DegradedReason::StorageWriteFailed);
            let _ = self.app.emit(
                ERROR_EVENT,
                CommandError::new(
                    "screenshotWriteFailed",
                    "A screenshot could not be saved. Recording is degraded.",
                ),
            );
            log::error!("A captured screenshot could not be saved: {error}");
        }

        self.flush_unsaved();
        // A click in Chrome or Edge takes what Steps for Chrome said about it, if it said.
        if let Record::Click(click) = &mut record {
            crate::browser_link::attach_page(&self.app, click);
        }
        let record_id = match &record {
            Record::Click(click) => click.id,
            Record::Manual(manual) => manual.id,
            _ => 0,
        };
        match self.journal(record) {
            Ok(fact) => {
                if record_id != 0 {
                    self.gap.last_record_id.store(record_id, Ordering::SeqCst);
                }
                if !image_failed && self.gap.unsaved.load(Ordering::SeqCst) == 0 {
                    lock(&self.machine).recover_from_storage_failure();
                }
                let _ = self.app.emit(FACT_EVENT, fact);
            }
            Err(error) => {
                // Not sent on as a step: a step must have its fact in the journal. The gap is
                // marked by `flush_unsaved` once saving works again.
                self.gap.unsaved.fetch_add(1, Ordering::SeqCst);
                lock(&self.machine)
                    .mark_degraded(capture::state_machine::DegradedReason::StorageWriteFailed);
                let _ = self.app.emit(
                    ERROR_EVENT,
                    CommandError::new(
                        "journalWriteFailed",
                        "A recording fact could not be saved. Recording is degraded.",
                    ),
                );
                log::error!("A recording fact could not be saved: {error}");
            }
        }
        // Each click changes the step count, but typing, navigation and state facts often change
        // nothing: those don't make every window re-render or the tray update.
        let state = snapshot_from(&self.machine, Some(&self.session_id), self.input_source);
        if self.published.as_ref() != Some(&state) {
            publish_state(&self.app, &state);
            self.published = Some(state);
        }
    }
}
