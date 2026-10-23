//! Where the click pipeline's records go, and what they're written with (#108): the recording's
//! capture settings, its state machine (none in the prototype), which says whether a step is
//! taken now and which apps are blacked out, and the sink. Also the steps written with a
//! screenshot of a window rather than a click's: an app coming forward ("Open"), an address
//! that settled ("Go to"), and a click that couldn't be captured. One reason to change: how a
//! step without a click of its own is written.

use std::sync::atomic::Ordering;
use std::sync::{Mutex, PoisonError};
use std::time::Instant;

use image::RgbaImage;

use crate::coords::PxRect;
use crate::facts::{AppSwitchRecord, CaptureFacts, NavigationRecord, Record};
use crate::navigation::PendingNavigation;
use crate::platform::input::MouseDown;
use crate::platform::window::WindowInfo;
use crate::programs::window_facts;
use crate::screenshot::{CaptureMode, Shot, Target, capture};
use crate::state_machine::RecorderStateMachine;

use super::{PipelineConfig, Sink, cover_for};

/// Ids for the pictures of "Go to" steps (`nav-<id>.webp`), unique within a run.
static NEXT_NAVIGATION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// What the pipeline writes its records with: the recording's capture settings, its state
/// machine (`None` in the prototype, which takes every step and blacks out nothing), and where
/// the records go.
pub(super) struct Output<'a> {
    pub(super) config: &'a PipelineConfig,
    pub(super) machine: Option<&'a Mutex<RecorderStateMachine>>,
    pub(super) sink: &'a mut dyn Sink,
}

impl Output<'_> {
    /// Writes a record, with its picture.
    pub(super) fn write(&mut self, record: Record, image: Option<RgbaImage>) {
        self.sink.write(record, image);
    }

    /// The apps blacked out of screenshots, or `None` while the recording takes no steps (paused,
    /// or on an excluded app).
    fn taking_steps(&self) -> Option<Vec<String>> {
        let Some(machine) = self.machine else {
            return Some(Vec::new());
        };
        let machine = machine.lock().unwrap_or_else(PoisonError::into_inner);
        (machine.is_active() && machine.takes_clicks()).then(|| machine.excluded_apps().to_vec())
    }

    /// A window's screenshot for a step without a click (a field as focus arrives in it, a page
    /// once its address settles), with excluded apps hidden, as a click's would be. Not while the
    /// recording isn't taking steps.
    pub(super) fn shoot(&self, window: &WindowInfo) -> Option<Shot> {
        let excluded = self.taking_steps()?;
        if window
            .exe_name()
            .is_some_and(|name| excluded.iter().any(|app| app.eq_ignore_ascii_case(name)))
        {
            return None;
        }
        let mut shot = shoot_window(window, self.config.mode, self.config.target_monitor).ok()?;
        crate::screenshot::hide_excluded(&mut shot, &excluded);
        Some(shot)
    }

    /// Writes an "Open" step with a screenshot of the app as it is now: with excluded apps blacked
    /// out, as every other screenshot is, and not at all if the recording has stopped taking steps
    /// since (the person went on to an excluded app, or paused, in the moment before the shot).
    pub(super) fn write_switch(
        &mut self,
        (_, mut record, window): (Instant, AppSwitchRecord, WindowInfo),
    ) {
        let Some(excluded) = self.taking_steps() else {
            return;
        };
        let shot = shoot_window(&window, self.config.mode, self.config.target_monitor)
            .ok()
            .map(|mut shot| {
                crate::screenshot::hide_excluded(&mut shot, &excluded);
                shot
            });
        record.capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.config.mode));
        self.write(Record::AppSwitch(record), shot.map(|shot| shot.image));
    }

    /// Writes a browser address that has settled as a "Go to" step, unless it's where the browser
    /// already was, or it wasn't typed or picked in the address bar: a link followed on a page, a
    /// redirect, back and forward, or the page the recording started on are left to the clicks
    /// (04/10/2026). With a screenshot of the page it went to.
    pub(super) fn write_navigation(
        &mut self,
        pending: Option<PendingNavigation<WindowInfo>>,
        last_origin: &mut Option<(u32, String)>,
    ) {
        let Some(navigation) = pending else {
            return;
        };
        let key = (navigation.pid, navigation.origin.clone());
        if last_origin.as_ref() == Some(&key) {
            return;
        }
        if !navigation.typed {
            *last_origin = Some(key);
            return;
        }
        if let Some(machine) = self.machine {
            machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .note_auxiliary_step();
        }
        *last_origin = Some(key);
        // The page it went to, now its address has settled (or just before the next step on it).
        let shot = self.shoot(&navigation.window);
        let capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.config.mode));
        self.write(
            Record::Navigation(NavigationRecord {
                tick_ms: navigation.tick_ms,
                origin: navigation.origin,
                window: window_facts(&navigation.window),
                id: capture
                    .as_ref()
                    .map(|_| NEXT_NAVIGATION_ID.fetch_add(1, Ordering::Relaxed)),
                capture,
            }),
            shot.map(|shot| shot.image),
        );
    }

    /// A click that couldn't be captured: a missed click, and the recorder's state after it.
    pub(super) fn write_capture_failure(&mut self, event: &MouseDown) {
        let (missed, state) = if let Some(machine) = self.machine {
            machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .handle_capture_failure(event.id, event.tick_ms)
        } else {
            (
                Record::Missed {
                    count: 1,
                    after_id: event.id,
                },
                Record::State {
                    state: "degraded",
                    reason: "a click could not be captured".into(),
                    tick_ms: event.tick_ms,
                },
            )
        };
        self.write(missed, None);
        self.write(state, None);
    }
}

/// A screenshot of a window read a moment before (an app that came forward, a field, an address
/// that settled, a stretch of typing or a key combination in it), with other programs' windows
/// over it greyed in window mode. The window may have gone since (a splash screen that closed, a
/// dialog its Enter closed): then everything but its program's windows is greyed too, as a
/// click's is. Excluded apps are left to the caller to hide. The click pipeline's and the key
/// worker's (`typing/desktop.rs`) one window screenshot (#112).
pub(crate) fn shoot_window(
    window: &WindowInfo,
    mode: CaptureMode,
    target_monitor: Option<PxRect>,
) -> Result<Shot, String> {
    let frame = PxRect::from(window.frame);
    let x = frame.left + (frame.right - frame.left) / 2;
    let y = frame.top + (frame.bottom - frame.top) / 2;
    let mut shot = capture(mode, Some(frame), x, y, target_monitor)?;
    let gone = mode == CaptureMode::Window && crate::screenshot::window_gone(window.hwnd, x, y);
    crate::screenshot::handle_other_windows(
        &mut shot,
        mode,
        &Target::window(window.pid, frame),
        cover_for(window),
        None,
        gone,
    );
    Ok(shot)
}
