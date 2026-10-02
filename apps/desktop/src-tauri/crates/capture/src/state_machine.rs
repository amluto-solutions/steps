//! The recorder state machine (docs/spec/02-capture.md#recording-state-machine).
//!
//! Tracks recording lifecycle states: Idle, Recording, Paused, Degraded, and Stopping.
//! Enforces timestamp cutoffs during pause and stop races, tracks queue overflow and missed
//! clicks, detects touch activity, and manages explicit app/secure-desktop pauses.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::facts::Record;

/// Errors produced during invalid state transitions.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum StateError {
    #[error("cannot start recording from state: {0:?}")]
    InvalidStart(RecorderState),
    #[error("cannot pause from state: {0:?}")]
    InvalidPause(RecorderState),
    #[error("cannot resume from state: {0:?}")]
    InvalidResume(RecorderState),
    #[error("cannot stop from state: {0:?}")]
    InvalidStop(RecorderState),
    #[error("cannot finish stopping from state: {0:?}")]
    InvalidFinishStopping(RecorderState),
}

/// Why recording is paused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "detail", rename_all = "camelCase")]
pub enum PauseReason {
    /// Paused by the user via UI button or hotkey.
    User,
    /// Auto-paused because an excluded application came into the foreground.
    ExcludedApp(String),
    /// Auto-paused because the lock screen is active.
    LockScreen,
    /// Auto-paused because a UAC or secure desktop prompt is showing.
    Uac,
    /// Paused because input events stopped arriving or Raw Input registration was lost.
    InputStopped(String),
    /// Paused because the recorder bar stopped responding (e.g. its web view crashed), so
    /// nothing on screen would show that recording is on. Never record without the indicator.
    IndicatorLost,
}

/// Why the recorder is in a degraded state (recording continues, but events may be missed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "detail", rename_all = "camelCase")]
pub enum DegradedReason {
    /// Queue capacity was exceeded; button-downs were dropped.
    QueueOverflow { missed: u64 },
    /// Touch or pen contact reports were detected without matching mouse clicks.
    TouchTapsUnrecorded { count: u64 },
    /// The capture worker panicked and had to be restarted.
    WorkerRestarted,
    /// A captured fact or screenshot could not be persisted to the recording journal.
    StorageWriteFailed,
    /// A click could not be resolved or screenshotted by the capture worker.
    CaptureFailed { event_id: u64 },
}

/// Current state of the recorder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RecorderState {
    /// App start or after Stop has completed. Input is not captured.
    Idle,
    /// Actively capturing events.
    Recording,
    /// Temporarily paused. Events with timestamps after `paused_at` are discarded.
    Paused { reason: PauseReason, paused_at: u32 },
    /// Actively capturing events, but with warnings of possible missed input.
    Degraded { reason: DegradedReason },
    /// Stop requested; queue is draining up to `stopped_at`.
    Stopping { stopped_at: u32 },
}

/// Decision made for an incoming event based on the current state and timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventDecision {
    /// The event is accepted for screenshot and UIA processing.
    Process,
    /// The event occurred after pause or stop, or when idle, and must be discarded.
    Discard { reason: &'static str },
}

/// Helper to compare Windows tick counts taking 32-bit wrapping into account.
/// Returns true if `a` occurred before or at the same time as `b`.
#[must_use]
pub fn tick_before_or_at(a: u32, b: u32) -> bool {
    b.wrapping_sub(a).cast_signed() >= 0
}

/// A stretch of time when recording was paused.
#[derive(Debug, Clone, Copy)]
struct PausedSpan {
    start: u32,
    end: u32,
    /// Paused because an excluded app was in front: clicks in it are judged by the window they
    /// land in rather than by time (see [`RecorderStateMachine::should_process_click`]).
    excluded_app: bool,
}

impl PausedSpan {
    /// Strictly inside: an event at the very tick of a Pause or Resume is still processed.
    fn holds(&self, tick: u32) -> bool {
        tick != self.start
            && tick != self.end
            && tick_before_or_at(self.start, tick)
            && tick_before_or_at(tick, self.end)
    }
}

/// What the person chose for this recording, set as it starts and reset for the next.
#[derive(Debug, Clone, Copy)]
struct RecordingChoices {
    /// Whether this recording reads the keyboard ("Record what's typed"), shown on the bar.
    keys_recorded: bool,
    /// Whether moving to another app makes an `Open "<app>"` step (Settings > Recording).
    app_switch_steps: bool,
    /// Whether screenshots are kept lossless at full size ("Original" quality).
    original_screenshots: bool,
}

impl RecordingChoices {
    const DEFAULT: Self = Self {
        keys_recorded: false,
        app_switch_steps: true,
        original_screenshots: false,
    };
}

/// The state machine managing recording lifecycle, transitions, and filters.
#[derive(Debug, Clone)]
pub struct RecorderStateMachine {
    state: RecorderState,
    step_count: u64,
    missed_count: u64,
    /// Clicks on a screen "Monitors" leaves out: not steps, but said when the recording ends.
    other_screen_clicks: u64,
    last_processed_id: u64,
    excluded_apps: Vec<String>,
    last_touch_report_count: u64,
    /// `last_processed_id` when touch reports were last checked: a click since then means the
    /// device delivered its taps as mouse input too.
    last_touch_check_click: u64,
    /// A touch marker is already in the guide and nothing has been recorded since.
    touch_marker_open: bool,
    /// Events in these ranges happened while recording was paused and must never become steps.
    paused_intervals: Vec<PausedSpan>,
    open_pause: Option<u32>,
    /// The last "Start again", as a tick: events at or before it are discarded.
    restarted_at: Option<u32>,
    choices: RecordingChoices,
}

impl RecorderStateMachine {
    /// Creates a new state machine in the Idle state with an excluded apps list.
    #[must_use]
    pub fn new(excluded_apps: Vec<String>) -> Self {
        let normalized_excluded = excluded_apps
            .into_iter()
            .map(|name| name.to_ascii_lowercase())
            .collect();
        Self {
            state: RecorderState::Idle,
            step_count: 0,
            missed_count: 0,
            other_screen_clicks: 0,
            last_processed_id: 0,
            excluded_apps: normalized_excluded,
            last_touch_report_count: 0,
            last_touch_check_click: 0,
            touch_marker_open: false,
            paused_intervals: Vec::new(),
            open_pause: None,
            restarted_at: None,
            choices: RecordingChoices::DEFAULT,
        }
    }

    /// The current state.
    #[must_use]
    pub fn state(&self) -> &RecorderState {
        &self.state
    }

    /// Number of steps successfully recorded in the current session.
    #[must_use]
    pub fn step_count(&self) -> u64 {
        self.step_count
    }

    /// Total number of clicks missed (due to queue overflow or panics).
    #[must_use]
    pub fn missed_count(&self) -> u64 {
        self.missed_count
    }

    /// Clicks left out because they were on a screen this recording doesn't take.
    #[must_use]
    pub fn other_screen_clicks(&self) -> u64 {
        self.other_screen_clicks
    }

    /// Counts a click on a screen this recording leaves out.
    pub fn note_other_screen_click(&mut self) {
        self.other_screen_clicks = self.other_screen_clicks.saturating_add(1);
    }

    /// "Start again" on the recorder bar: the counts restart from zero for the steps that follow.
    /// Returns the previous `(steps, missed)` so an undo can put them back.
    pub fn restart_counts(&mut self) -> (u64, u64) {
        let previous = (self.step_count, self.missed_count);
        self.step_count = 0;
        self.missed_count = 0;
        previous
    }

    /// Sets the "Start again" point, returning the one it replaces (for undo). An event at or
    /// before it belongs to the part that was thrown away, even if it was still being processed
    /// when the button was pressed.
    pub fn set_restart_tick(&mut self, tick: Option<u32>) -> Option<u32> {
        std::mem::replace(&mut self.restarted_at, tick)
    }

    /// Whether an event at `tick` came before the last "Start again".
    #[must_use]
    pub fn before_restart(&self, tick: u32) -> bool {
        self.restarted_at
            .is_some_and(|restart| tick_before_or_at(tick, restart))
    }

    /// Undoes [`Self::restart_counts`], adding anything counted since.
    pub fn restore_counts(&mut self, steps: u64, missed: u64) {
        self.step_count = self.step_count.saturating_add(steps);
        self.missed_count = self.missed_count.saturating_add(missed);
    }

    /// Marks this recording as one that reads the keyboard. Set just after [`Self::start`].
    pub fn set_keys_recorded(&mut self, on: bool) {
        self.choices.keys_recorded = on;
    }

    /// Whether this recording reads the keyboard.
    #[must_use]
    pub fn keys_recorded(&self) -> bool {
        self.choices.keys_recorded && self.state != RecorderState::Idle
    }

    /// Sets whether this recording makes `Open "<app>"` steps (docs/spec/07-settings-and-policy.md).
    pub fn set_app_switch_steps(&mut self, on: bool) {
        self.choices.app_switch_steps = on;
    }

    /// Whether moving to another app makes a step in this recording.
    #[must_use]
    pub fn app_switch_steps(&self) -> bool {
        self.choices.app_switch_steps
    }

    /// Sets whether this recording keeps its screenshots at "Original" quality.
    pub fn set_original_screenshots(&mut self, on: bool) {
        self.choices.original_screenshots = on;
    }

    /// Whether this recording's screenshots are lossless at full size.
    #[must_use]
    pub fn original_screenshots(&self) -> bool {
        self.choices.original_screenshots
    }

    /// Id of the last processed click event.
    #[must_use]
    pub fn last_processed_id(&self) -> u64 {
        self.last_processed_id
    }

    /// True if currently in Recording or Degraded.
    #[must_use]
    pub fn is_active(&self) -> bool {
        matches!(
            self.state,
            RecorderState::Recording | RecorderState::Degraded { .. }
        )
    }

    /// Starts recording from Idle.
    ///
    /// # Errors
    /// Returns `StateError::InvalidStart` if not currently Idle.
    pub fn start(&mut self) -> Result<(), StateError> {
        if self.state != RecorderState::Idle {
            return Err(StateError::InvalidStart(self.state.clone()));
        }
        self.state = RecorderState::Recording;
        self.step_count = 0;
        self.missed_count = 0;
        self.other_screen_clicks = 0;
        self.last_processed_id = 0;
        self.last_touch_report_count = 0;
        self.last_touch_check_click = 0;
        self.touch_marker_open = false;
        self.paused_intervals.clear();
        self.open_pause = None;
        self.restarted_at = None;
        self.choices = RecordingChoices::DEFAULT;
        Ok(())
    }

    /// Pauses recording with a given reason and timestamp.
    ///
    /// Events timestamped after `tick_ms` will be discarded.
    ///
    /// # Errors
    /// Returns `StateError::InvalidPause` if not in Recording or Degraded.
    pub fn pause(&mut self, reason: PauseReason, tick_ms: u32) -> Result<(), StateError> {
        match self.state {
            RecorderState::Recording | RecorderState::Degraded { .. } => {
                self.state = RecorderState::Paused {
                    reason,
                    paused_at: tick_ms,
                };
                self.open_pause = Some(tick_ms);
                Ok(())
            }
            _ => Err(StateError::InvalidPause(self.state.clone())),
        }
    }

    /// Resumes recording from Paused.
    ///
    /// # Errors
    /// Returns `StateError::InvalidResume` if not currently Paused.
    pub fn resume(&mut self, tick_ms: u32) -> Result<(), StateError> {
        match self.state {
            RecorderState::Paused { .. } => {
                self.close_pause(tick_ms);
                self.state = RecorderState::Recording;
                Ok(())
            }
            _ => Err(StateError::InvalidResume(self.state.clone())),
        }
    }

    fn close_pause(&mut self, tick_ms: u32) {
        if let Some(start) = self.open_pause.take() {
            let excluded_app = self.paused_for_excluded_app();
            self.paused_intervals.push(PausedSpan {
                start,
                end: tick_ms,
                excluded_app,
            });
        }
    }

    fn paused_for_excluded_app(&self) -> bool {
        matches!(
            self.state,
            RecorderState::Paused {
                reason: PauseReason::ExcludedApp(_),
                ..
            }
        )
    }

    /// Whether the input source should pass clicks on: while recording, and while paused for an
    /// excluded app, where each click is judged by the window it lands in.
    #[must_use]
    pub fn takes_clicks(&self) -> bool {
        self.is_active() || self.paused_for_excluded_app()
    }

    /// Requests stopping the recording session at `tick_ms`.
    ///
    /// # Errors
    /// Returns `StateError::InvalidStop` if already Idle or Stopping.
    pub fn stop(&mut self, tick_ms: u32) -> Result<(), StateError> {
        match self.state {
            RecorderState::Recording
            | RecorderState::Paused { .. }
            | RecorderState::Degraded { .. } => {
                self.close_pause(tick_ms);
                self.state = RecorderState::Stopping {
                    stopped_at: tick_ms,
                };
                Ok(())
            }
            _ => Err(StateError::InvalidStop(self.state.clone())),
        }
    }

    /// Completes stopping after the queue has drained, returning to Idle.
    ///
    /// # Errors
    /// Returns `StateError::InvalidFinishStopping` if not in Stopping.
    pub fn finish_stopping(&mut self) -> Result<(), StateError> {
        match self.state {
            RecorderState::Stopping { .. } => {
                self.state = RecorderState::Idle;
                Ok(())
            }
            _ => Err(StateError::InvalidFinishStopping(self.state.clone())),
        }
    }

    /// Moves the recorder to Degraded. Capture continues, but warnings are raised.
    pub fn mark_degraded(&mut self, reason: DegradedReason) {
        if self.is_active() {
            self.state = RecorderState::Degraded { reason };
        }
    }

    /// The process-wide touch report count when a recording's worker starts, so only this
    /// recording's reports can raise a touch marker.
    pub fn seed_touch_reports(&mut self, reports: u64) {
        self.last_touch_report_count = reports;
    }

    /// Clears Degraded caused by missed clicks (a full queue, a click that couldn't be captured,
    /// a restarted worker) once the queue has drained. Save failures clear when a save works, and
    /// touch when a click is recorded. Returns whether it cleared.
    pub fn recover_after_drain(&mut self) -> bool {
        let clears = matches!(
            self.state,
            RecorderState::Degraded {
                reason: DegradedReason::QueueOverflow { .. }
                    | DegradedReason::CaptureFailed { .. }
                    | DegradedReason::WorkerRestarted
            }
        );
        if clears {
            self.state = RecorderState::Recording;
        }
        clears
    }

    /// Checks an incoming event (a typed value, an address) against the state machine and the
    /// pause/stop timestamps.
    #[must_use]
    pub fn should_process_event(&self, event_tick: u32) -> EventDecision {
        self.decide(event_tick, false)
    }

    /// Checks a click. As [`Self::should_process_event`], except while paused for an excluded
    /// app: there the window the click lands in decides, since an excluded app's clicks are
    /// dropped before any screenshot anyway. Otherwise the click that switches back to a
    /// recorded app (and ends the pause) would be lost, as it comes just before the switch.
    #[must_use]
    pub fn should_process_click(&self, event_tick: u32) -> EventDecision {
        self.decide(event_tick, true)
    }

    fn decide(&self, event_tick: u32, click: bool) -> EventDecision {
        if self.before_restart(event_tick) {
            return EventDecision::Discard {
                reason: "event came before Start again",
            };
        }
        if self
            .paused_intervals
            .iter()
            .any(|span| !(click && span.excluded_app) && span.holds(event_tick))
        {
            return EventDecision::Discard {
                reason: "event occurred while recording was paused",
            };
        }
        match &self.state {
            RecorderState::Idle => EventDecision::Discard {
                reason: "recorder is idle",
            },
            RecorderState::Recording | RecorderState::Degraded { .. } => EventDecision::Process,
            RecorderState::Paused {
                reason: PauseReason::ExcludedApp(_),
                ..
            } if click => EventDecision::Process,
            RecorderState::Paused { paused_at, .. } => {
                if tick_before_or_at(event_tick, *paused_at) {
                    EventDecision::Process
                } else {
                    EventDecision::Discard {
                        reason: "event occurred after pause",
                    }
                }
            }
            RecorderState::Stopping { stopped_at } => {
                if tick_before_or_at(event_tick, *stopped_at) {
                    EventDecision::Process
                } else {
                    EventDecision::Discard {
                        reason: "event occurred after stop",
                    }
                }
            }
        }
    }

    /// Whether recording was paused at any moment from `from` to `to`. A field's value is read
    /// when focus leaves it; if the recording was paused while the field had focus, part of the
    /// value may have been typed during the pause, so the whole value is dropped.
    #[must_use]
    pub fn paused_between(&self, from: u32, to: u32) -> bool {
        let overlaps =
            |start: u32, end: u32| tick_before_or_at(start, to) && tick_before_or_at(from, end);
        self.paused_intervals
            .iter()
            .any(|span| overlaps(span.start, span.end))
            || self
                .open_pause
                .is_some_and(|paused_at| tick_before_or_at(paused_at, to))
    }

    /// Records that a click event was successfully processed into a step.
    pub fn note_step_processed(&mut self, event_id: u64) {
        self.note_auxiliary_step();
        self.last_processed_id = event_id;
        // Something was recorded, so a later stretch of unrecorded touch gets its own marker, and
        // taps are evidently arriving as clicks again.
        self.touch_marker_open = false;
        if matches!(
            self.state,
            RecorderState::Degraded {
                reason: DegradedReason::TouchTapsUnrecorded { .. }
            }
        ) {
            self.state = RecorderState::Recording;
        }
    }

    /// Adds a non-click step, such as a field value, marker, or screenshot.
    pub fn note_auxiliary_step(&mut self) {
        self.step_count = self.step_count.saturating_add(1);
    }

    /// Takes back a step noted with `note_auxiliary_step` that was then never written.
    pub fn forget_auxiliary_step(&mut self) {
        self.step_count = self.step_count.saturating_sub(1);
    }

    /// Records a "missed here" marker for steps that were captured but could not be saved.
    /// Returns the marker record to write into the journal.
    pub fn note_unsaved_steps(&mut self, count: u64, after_id: u64) -> Record {
        self.missed_count = self.missed_count.saturating_add(count);
        self.note_auxiliary_step();
        Record::Missed { count, after_id }
    }

    /// Clears Degraded when it was caused by a failed save and saving works again. Other
    /// causes (a full queue, touch taps, a worker restart) keep their own warning.
    pub fn recover_from_storage_failure(&mut self) {
        if matches!(
            self.state,
            RecorderState::Degraded {
                reason: DegradedReason::StorageWriteFailed
            }
        ) {
            self.state = RecorderState::Recording;
        }
    }

    /// Checks if an executable name is in the excluded apps list.
    #[must_use]
    pub fn is_app_excluded(&self, exe_name: &str) -> bool {
        let name_lower = exe_name.to_ascii_lowercase();
        self.excluded_apps.iter().any(|app| app == &name_lower)
    }

    /// The excluded program names (lower case), for blacking out their windows in screenshots.
    #[must_use]
    pub fn excluded_apps(&self) -> &[String] {
        &self.excluded_apps
    }

    /// Adds an executable name to the exclusion list for this app process.
    pub fn add_excluded_app(&mut self, exe_name: &str) -> bool {
        let name = exe_name.trim().to_ascii_lowercase();
        if name.is_empty() || self.excluded_apps.iter().any(|app| app == &name) {
            return false;
        }
        self.excluded_apps.push(name);
        true
    }

    /// Removes an executable name from the user-managed exclusion list.
    pub fn remove_excluded_app(&mut self, exe_name: &str) -> bool {
        let name = exe_name.trim().to_ascii_lowercase();
        let Some(index) = self.excluded_apps.iter().position(|app| app == &name) else {
            return false;
        };
        self.excluded_apps.remove(index);
        true
    }

    /// Handles a foreground window change. If an excluded application comes into the foreground
    /// while recording, auto-pauses. If an auto-pause was caused by an excluded application and
    /// a non-excluded app takes foreground, auto-resumes.
    pub fn handle_foreground_change(&mut self, exe_name: Option<&str>, tick_ms: u32) {
        let is_excluded = exe_name.is_some_and(|name| self.is_app_excluded(name));
        match (&self.state, is_excluded) {
            (RecorderState::Recording | RecorderState::Degraded { .. }, true) => {
                let name = exe_name.unwrap_or("unknown").to_string();
                let _ = self.pause(PauseReason::ExcludedApp(name), tick_ms);
            }
            (
                RecorderState::Paused {
                    reason: PauseReason::ExcludedApp(_),
                    ..
                },
                false,
            ) if exe_name.is_some() => {
                let _ = self.resume(tick_ms);
            }
            _ => {}
        }
    }

    /// Handles changes in desktop status (e.g. secure desktop, lock screen, UAC).
    pub fn handle_desktop_status(&mut self, is_default_desktop: bool, tick_ms: u32) {
        match (&self.state, is_default_desktop) {
            (RecorderState::Recording | RecorderState::Degraded { .. }, false) => {
                let _ = self.pause(PauseReason::LockScreen, tick_ms);
            }
            (
                RecorderState::Paused {
                    reason: PauseReason::LockScreen | PauseReason::Uac,
                    ..
                },
                true,
            ) => {
                let _ = self.resume(tick_ms);
            }
            _ => {}
        }
    }

    /// Handles queue overflow reports from the input layer.
    ///
    /// Updates counts and returns the Missed record to be written.
    pub fn handle_queue_overflow(&mut self, dropped: u64, after_id: u64) -> Record {
        self.missed_count = self.missed_count.saturating_add(dropped);
        self.note_auxiliary_step();
        self.mark_degraded(DegradedReason::QueueOverflow { missed: dropped });
        Record::Missed {
            count: dropped,
            after_id,
        }
    }

    /// Marks a click that could not be captured as missed and degrades the session.
    pub fn handle_capture_failure(&mut self, event_id: u64, tick_ms: u32) -> (Record, Record) {
        self.missed_count = self.missed_count.saturating_add(1);
        self.note_auxiliary_step();
        self.mark_degraded(DegradedReason::CaptureFailed { event_id });
        (
            Record::Missed {
                count: 1,
                after_id: event_id,
            },
            Record::State {
                state: "degraded",
                reason: "a click could not be captured".into(),
                tick_ms,
            },
        )
    }

    /// Checks if touch or pen reports arrived without matching mouse events.
    ///
    /// If touch reports have increased by at least `threshold` during active capture,
    /// transitions to Degraded and returns a visible touch marker.
    pub fn handle_touch_reports(
        &mut self,
        current_reports: u64,
        tick_ms: u32,
        threshold: u64,
    ) -> Option<Record> {
        if !self.is_active() {
            self.last_touch_report_count = current_reports;
            return None;
        }
        let diff = current_reports.saturating_sub(self.last_touch_report_count);
        self.last_touch_report_count = current_reports;
        let clicked_since = self.last_processed_id != self.last_touch_check_click;
        self.last_touch_check_click = self.last_processed_id;

        // Digitizers report continuously while a pen hovers or a finger drags, so one stretch
        // of touch gets one marker, not one per check. A click in the same interval means the
        // taps also arrived as mouse input and were recorded.
        if diff >= threshold.max(1) && !clicked_since && !self.touch_marker_open {
            self.touch_marker_open = true;
            self.note_auxiliary_step();
            self.mark_degraded(DegradedReason::TouchTapsUnrecorded { count: diff });
            Some(Record::Touch {
                count: diff,
                tick_ms,
            })
        } else {
            None
        }
    }

    /// Handles a capture worker panic.
    ///
    /// Marks the in-flight click as missed (if any), moves to Degraded, and returns
    /// the records to write to the sink.
    pub fn handle_worker_panic(
        &mut self,
        in_flight_id: Option<u64>,
        tick_ms: u32,
    ) -> (Record, Record) {
        self.missed_count = self.missed_count.saturating_add(1);
        let was_active = self.is_active();
        let was_paused = matches!(self.state, RecorderState::Paused { .. });
        let was_stopping = matches!(self.state, RecorderState::Stopping { .. });
        if was_active {
            self.mark_degraded(DegradedReason::WorkerRestarted);
        }
        let (state, reason) = if was_active {
            (
                "degraded",
                "capture worker panicked and was restarted".to_string(),
            )
        } else if was_paused {
            (
                "paused",
                "capture worker restarted; the user-paused recording remains paused".to_string(),
            )
        } else if was_stopping {
            (
                "stopping",
                "capture worker panicked while stopping".to_string(),
            )
        } else {
            ("idle", "capture worker panicked".to_string())
        };
        let missed_after = in_flight_id.unwrap_or(self.last_processed_id);
        (
            Record::Missed {
                count: 1,
                after_id: missed_after,
            },
            Record::State {
                state,
                reason,
                tick_ms,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_on_a_screen_left_out_are_counted_for_each_recording() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.note_other_screen_click();
        sm.note_other_screen_click();
        assert_eq!(sm.other_screen_clicks(), 2);
        assert_eq!(sm.step_count(), 0);
        sm.stop(1).unwrap();
        sm.finish_stopping().unwrap();
        sm.start().unwrap();
        assert_eq!(sm.other_screen_clicks(), 0);
    }

    #[test]
    fn a_save_failure_warning_clears_when_saving_works_but_others_stay() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.mark_degraded(DegradedReason::StorageWriteFailed);
        let marker = sm.note_unsaved_steps(2, 7);
        assert_eq!(
            marker,
            Record::Missed {
                count: 2,
                after_id: 7
            }
        );
        assert_eq!(sm.missed_count(), 2);
        sm.recover_from_storage_failure();
        assert_eq!(sm.state(), &RecorderState::Recording);

        sm.mark_degraded(DegradedReason::QueueOverflow { missed: 3 });
        sm.recover_from_storage_failure();
        assert!(
            matches!(sm.state(), RecorderState::Degraded { .. }),
            "queue warning stays"
        );
    }

    #[test]
    fn starts_in_idle_and_transitions_to_recording() {
        let mut sm = RecorderStateMachine::new(vec!["1password.exe".into()]);
        assert_eq!(*sm.state(), RecorderState::Idle);
        assert!(!sm.is_active());

        sm.start().unwrap();
        assert_eq!(*sm.state(), RecorderState::Recording);
        assert!(sm.is_active());
        assert_eq!(sm.step_count(), 0);
    }

    #[test]
    fn app_switch_steps_are_on_unless_a_recording_turns_them_off() {
        let mut sm = RecorderStateMachine::new(vec![]);
        assert!(sm.app_switch_steps());
        sm.start().unwrap();
        sm.set_app_switch_steps(false);
        assert!(!sm.app_switch_steps());
        sm.stop(1_000).unwrap();
        sm.finish_stopping().unwrap();
        // Each recording starts from the default; the recorder then applies its setting.
        sm.start().unwrap();
        assert!(sm.app_switch_steps());
    }

    #[test]
    fn original_screenshots_last_only_for_the_recording_that_chose_them() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        assert!(!sm.original_screenshots());
        sm.set_original_screenshots(true);
        assert!(sm.original_screenshots());
        sm.stop(1_000).unwrap();
        sm.finish_stopping().unwrap();
        sm.start().unwrap();
        assert!(!sm.original_screenshots());
    }

    #[test]
    fn cannot_start_twice() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        assert!(matches!(sm.start(), Err(StateError::InvalidStart(_))));
    }

    #[test]
    fn pause_and_resume_lifecycle() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();

        sm.pause(PauseReason::User, 1000).unwrap();
        assert_eq!(
            *sm.state(),
            RecorderState::Paused {
                reason: PauseReason::User,
                paused_at: 1000
            }
        );
        assert!(!sm.is_active());

        sm.resume(3000).unwrap();
        assert_eq!(*sm.state(), RecorderState::Recording);
        assert!(sm.is_active());
        assert_eq!(
            sm.should_process_event(2000),
            EventDecision::Discard {
                reason: "event occurred while recording was paused"
            }
        );
        assert_eq!(sm.should_process_event(3000), EventDecision::Process);
    }

    #[test]
    fn events_before_or_at_pause_are_processed_events_after_are_discarded() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.pause(PauseReason::User, 5000).unwrap();

        // Event before pause timestamp
        assert_eq!(sm.should_process_event(4999), EventDecision::Process);
        // Event exactly at pause timestamp
        assert_eq!(sm.should_process_event(5000), EventDecision::Process);
        // Event after pause timestamp
        assert_eq!(
            sm.should_process_event(5001),
            EventDecision::Discard {
                reason: "event occurred after pause"
            }
        );
    }

    #[test]
    fn tick_before_or_at_handles_wrapping() {
        // Normal progression
        assert!(tick_before_or_at(100, 200));
        assert!(tick_before_or_at(200, 200));
        assert!(!tick_before_or_at(201, 200));

        // Wrapping near u32::MAX
        let near_max = u32::MAX - 10;
        let past_wrap = 10u32;
        assert!(tick_before_or_at(near_max, past_wrap));
        assert!(!tick_before_or_at(past_wrap, near_max));
    }

    #[test]
    fn stop_and_draining() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();

        sm.stop(10000).unwrap();
        assert_eq!(*sm.state(), RecorderState::Stopping { stopped_at: 10000 });

        // Event before stop timestamp is processed (draining)
        assert_eq!(sm.should_process_event(9999), EventDecision::Process);
        assert_eq!(sm.should_process_event(10000), EventDecision::Process);
        // Event after stop timestamp is discarded
        assert_eq!(
            sm.should_process_event(10001),
            EventDecision::Discard {
                reason: "event occurred after stop"
            }
        );

        sm.finish_stopping().unwrap();
        assert_eq!(*sm.state(), RecorderState::Idle);
        assert_eq!(
            sm.should_process_event(5000),
            EventDecision::Discard {
                reason: "recorder is idle"
            }
        );
    }

    #[test]
    fn stop_while_paused_preserves_both_timestamp_cutoffs() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.pause(PauseReason::User, 5000).unwrap();
        sm.stop(8000).unwrap();

        assert_eq!(sm.should_process_event(4999), EventDecision::Process);
        assert_eq!(
            sm.should_process_event(6000),
            EventDecision::Discard {
                reason: "event occurred while recording was paused"
            }
        );
        assert_eq!(sm.should_process_event(8000), EventDecision::Process);
        assert_eq!(
            sm.should_process_event(8001),
            EventDecision::Discard {
                reason: "event occurred after stop"
            }
        );
    }

    #[test]
    fn a_field_focused_across_a_pause_counts_as_paused() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.pause(PauseReason::User, 5000).unwrap();
        sm.resume(6000).unwrap();
        // Focus arrived before the pause and left after it: the value may hold private typing.
        assert!(sm.paused_between(4000, 7000));
        // Wholly before or after the pause: fine.
        assert!(!sm.paused_between(1000, 4999));
        assert!(!sm.paused_between(6001, 9000));
        // Touching the pause counts.
        assert!(sm.paused_between(6000, 6500));
        // A pause that's still open counts from its start.
        sm.pause(PauseReason::User, 10_000).unwrap();
        assert!(sm.paused_between(9000, 12_000));
        assert!(!sm.paused_between(7000, 9999));
    }

    #[test]
    fn paused_between_survives_tick_wrap_around() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.pause(PauseReason::User, u32::MAX - 10).unwrap();
        sm.resume(20).unwrap();
        assert!(sm.paused_between(u32::MAX - 100, 50));
        assert!(!sm.paused_between(30, 60));
    }

    #[test]
    fn auto_pause_and_resume_on_excluded_app() {
        let mut sm = RecorderStateMachine::new(vec!["KeePass.exe".into()]);
        sm.start().unwrap();

        // Normal app in front
        sm.handle_foreground_change(Some("chrome.exe"), 1000);
        assert_eq!(*sm.state(), RecorderState::Recording);

        // Excluded app in front
        sm.handle_foreground_change(Some("keepass.exe"), 2000);
        assert_eq!(
            *sm.state(),
            RecorderState::Paused {
                reason: PauseReason::ExcludedApp("keepass.exe".into()),
                paused_at: 2000
            }
        );

        // Back to normal app
        sm.handle_foreground_change(Some("chrome.exe"), 3000);
        assert_eq!(*sm.state(), RecorderState::Recording);

        // But user pause does NOT auto-resume when foreground changes
        sm.pause(PauseReason::User, 4000).unwrap();
        sm.handle_foreground_change(Some("notepad.exe"), 5000);
        assert!(matches!(
            sm.state(),
            RecorderState::Paused {
                reason: PauseReason::User,
                ..
            }
        ));
    }

    #[test]
    fn clicks_during_an_excluded_app_pause_are_judged_by_window_not_time() {
        let mut sm = RecorderStateMachine::new(vec!["keepass.exe".into()]);
        sm.start().unwrap();
        sm.handle_foreground_change(Some("keepass.exe"), 2000);
        assert!(sm.takes_clicks());
        // The click back into the browser comes just before the switch that ends the pause.
        assert_eq!(sm.should_process_click(2900), EventDecision::Process);
        assert_ne!(sm.should_process_event(2900), EventDecision::Process);
        sm.handle_foreground_change(Some("chrome.exe"), 3000);
        assert_eq!(sm.should_process_click(2900), EventDecision::Process);
        // Typed values and addresses keep the pause cutoffs.
        assert_ne!(sm.should_process_event(2900), EventDecision::Process);

        // Any other pause still drops clicks by time, and takes none.
        sm.pause(PauseReason::User, 4000).unwrap();
        assert!(!sm.takes_clicks());
        assert_ne!(sm.should_process_click(4500), EventDecision::Process);
        sm.handle_foreground_change(Some("keepass.exe"), 4600);
        sm.resume(5000).unwrap();
        assert_ne!(sm.should_process_click(4500), EventDecision::Process);
    }

    #[test]
    fn stopping_during_an_excluded_app_pause_keeps_its_clicks_up_to_the_stop() {
        let mut sm = RecorderStateMachine::new(vec!["keepass.exe".into()]);
        sm.start().unwrap();
        sm.handle_foreground_change(Some("keepass.exe"), 2000);
        sm.stop(3000).unwrap();
        assert_eq!(sm.should_process_click(2500), EventDecision::Process);
        assert_ne!(sm.should_process_click(3001), EventDecision::Process);
        assert_ne!(sm.should_process_event(2500), EventDecision::Process);
    }

    #[test]
    fn newly_excluded_apps_match_case_insensitively() {
        let mut sm = RecorderStateMachine::new(vec![]);
        assert!(sm.add_excluded_app("Excel.EXE"));
        assert!(!sm.add_excluded_app("excel.exe"));
        assert!(sm.is_app_excluded("EXCEL.exe"));
        assert!(sm.remove_excluded_app("excel.exe"));
        assert!(!sm.is_app_excluded("EXCEL.exe"));
    }

    #[test]
    fn auto_pause_on_secure_desktop() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();

        // UAC / lock screen appears
        sm.handle_desktop_status(false, 1000);
        assert_eq!(
            *sm.state(),
            RecorderState::Paused {
                reason: PauseReason::LockScreen,
                paused_at: 1000
            }
        );

        // Desktop returns
        sm.handle_desktop_status(true, 2000);
        assert_eq!(*sm.state(), RecorderState::Recording);
    }

    #[test]
    fn queue_overflow_enters_degraded_and_emits_missed() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();

        let record = sm.handle_queue_overflow(5, 42);
        assert_eq!(sm.missed_count(), 5);
        assert_eq!(
            record,
            Record::Missed {
                count: 5,
                after_id: 42
            }
        );
        assert_eq!(
            *sm.state(),
            RecorderState::Degraded {
                reason: DegradedReason::QueueOverflow { missed: 5 }
            }
        );
        // Capture continues in degraded state
        assert!(sm.is_active());
        assert_eq!(sm.should_process_event(100), EventDecision::Process);

        // Once the queue drains, the warning clears.
        assert!(sm.recover_after_drain());
        assert_eq!(*sm.state(), RecorderState::Recording);
        assert!(!sm.recover_after_drain());
    }

    #[test]
    fn only_missed_click_warnings_clear_when_the_queue_drains() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.mark_degraded(DegradedReason::StorageWriteFailed);
        assert!(!sm.recover_after_drain());
        assert!(matches!(sm.state(), RecorderState::Degraded { .. }));

        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        let _ = sm.handle_capture_failure(7, 100);
        assert!(sm.recover_after_drain());

        // Touch clears when a click is recorded, not when the queue drains.
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        assert!(sm.handle_touch_reports(10, 100, 5).is_some());
        assert!(!sm.recover_after_drain());
        sm.note_step_processed(1);
        assert_eq!(*sm.state(), RecorderState::Recording);
    }

    #[test]
    fn touch_reports_from_an_earlier_recording_are_not_counted() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        // The process has already seen 500 reports; the worker seeds from that.
        sm.seed_touch_reports(500);
        assert!(sm.handle_touch_reports(502, 100, 5).is_none());
        assert_eq!(*sm.state(), RecorderState::Recording);
    }

    #[test]
    fn failed_click_capture_enters_degraded_and_emits_missed() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();

        let (missed, state) = sm.handle_capture_failure(42, 1200);
        assert_eq!(sm.missed_count(), 1);
        assert_eq!(
            missed,
            Record::Missed {
                count: 1,
                after_id: 42
            }
        );
        assert!(matches!(
            state,
            Record::State {
                state: "degraded",
                tick_ms: 1200,
                ..
            }
        ));
        assert_eq!(
            *sm.state(),
            RecorderState::Degraded {
                reason: DegradedReason::CaptureFailed { event_id: 42 }
            }
        );
    }

    #[test]
    fn touch_reports_trigger_degraded() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();

        // Few reports below threshold
        assert!(sm.handle_touch_reports(2, 1000, 5).is_none());
        assert_eq!(*sm.state(), RecorderState::Recording);

        // Sudden jump of 10 reports
        let record = sm.handle_touch_reports(12, 1200, 5);
        assert_eq!(
            record,
            Some(Record::Touch {
                count: 10,
                tick_ms: 1200
            })
        );
        assert!(matches!(
            sm.state(),
            RecorderState::Degraded {
                reason: DegradedReason::TouchTapsUnrecorded { count: 10 }
            }
        ));
    }

    #[test]
    fn a_stretch_of_touch_gets_one_marker_and_recorded_taps_get_none() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        // A 2-second pen hover: eight checks over the threshold, one marker.
        let markers = (1..=8)
            .filter_map(|check: u32| sm.handle_touch_reports(u64::from(check) * 10, check * 250, 5))
            .count();
        assert_eq!(markers, 1);

        // After a recorded click, a new stretch of unrecorded touch gets its own marker.
        sm.note_step_processed(1);
        assert!(
            sm.handle_touch_reports(90, 2300, 5).is_none(),
            "clicked in this interval"
        );
        assert!(sm.handle_touch_reports(100, 2550, 5).is_some());

        // Taps that also arrive as clicks (touch promoted to mouse) are not flagged.
        sm.note_step_processed(2);
        assert!(sm.handle_touch_reports(110, 2800, 5).is_none());
    }

    #[test]
    fn worker_panic_records_missed_and_enters_degraded() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.note_step_processed(10);

        let (missed, state) = sm.handle_worker_panic(Some(11), 3000);
        assert_eq!(
            missed,
            Record::Missed {
                count: 1,
                after_id: 11
            }
        );
        assert_eq!(
            state,
            Record::State {
                state: "degraded",
                reason: "capture worker panicked and was restarted".to_string(),
                tick_ms: 3000
            }
        );
        assert_eq!(sm.missed_count(), 1);
        assert_eq!(
            *sm.state(),
            RecorderState::Degraded {
                reason: DegradedReason::WorkerRestarted
            }
        );
    }

    #[test]
    fn worker_panic_keeps_a_user_paused_recording_paused() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.pause(PauseReason::User, 1000).unwrap();

        let (_, state) = sm.handle_worker_panic(None, 2000);
        assert!(matches!(
            state,
            Record::State {
                state: "paused",
                ..
            }
        ));
        assert!(matches!(
            sm.state(),
            RecorderState::Paused {
                reason: PauseReason::User,
                ..
            }
        ));
    }

    #[test]
    fn worker_panic_while_stopping_marks_the_in_flight_step_missed() {
        let mut sm = RecorderStateMachine::new(vec![]);
        sm.start().unwrap();
        sm.stop(1000).unwrap();

        let (missed, state) = sm.handle_worker_panic(Some(14), 1100);
        assert_eq!(
            missed,
            Record::Missed {
                count: 1,
                after_id: 14,
            }
        );
        assert!(matches!(
            state,
            Record::State {
                state: "stopping",
                ..
            }
        ));
        assert!(matches!(sm.state(), RecorderState::Stopping { .. }));
    }
}
