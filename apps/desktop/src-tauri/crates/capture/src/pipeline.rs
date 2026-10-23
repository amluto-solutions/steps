//! The worker that turns queued button-downs into records
//! (docs/spec/02-capture.md#recording-state-machine).
//!
//! Per click: filter (own windows), screenshot first, UIA lookup in parallel with a deadline,
//! then one record keyed by the event id. Loss is always visible: queue overflow becomes a
//! `Missed` record, and silent input sources put the recorder in `Degraded`. One reason to
//! change: how a click becomes a step, in order with what else the recording hears of (apps
//! coming forward, addresses, fields, the key worker's records, the input's health).
//!
//! What a press that may become a drag comes to is `pipeline/drags.rs`; what records are written
//! with, and the steps written with a window's screenshot rather than a click's, are
//! `pipeline/output.rs`. What kind of program a window is, and what a step keeps of it, is
//! `programs.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::platform::display::{
    cursor_pos, double_click_settings, input_desktop_is_default, last_input_tick, now_tick,
};
use crate::platform::input::{
    InputShared, InputSource, LeftRelease, MouseButton, MouseDown, Press, registration,
};
use crate::platform::window::{
    Elevation, Pressed, TitleBarButton, WindowInfo, foreground_window, own_process_id,
    root_window_at, window_info,
};
use image::RgbaImage;

use crate::coords::{PxRect, point_to_pct, rect_to_pct};
use crate::facts::{
    AppSwitchRecord, CaptureFacts, ClickRecord, ElementFacts, InputRecord, Record, UiaOutcome,
    WindowFacts,
};
use crate::navigation::{NavigationSettle, SETTLING_POLL, TYPED_WITHIN};
use crate::programs::{
    is_browser, is_input_panel, is_remote_input, is_remote_window, is_shell_window,
    is_steps_window, names_steps, program_key,
};
pub use crate::programs::{is_remote_client, window_facts};
use crate::screenshot::{CaptureMode, Owner, Target, capture};
use crate::state_machine::{PauseReason, RecorderState, RecorderStateMachine};
use crate::switches::{InputSeen, SwitchInput};
use crate::typing::{ClickNews, KeyedRecord, Looked};
use crate::uia::{Lookup, UiaClient};

mod drags;
mod output;

use drags::{
    DRAG_GIVE_UP, DragStart, DrawStart, FILL_SHOT_AFTER, cell_selected, drag_start, dragged,
    draw_start, filter_button_pressed, write_drag, write_draw, write_fill_down,
};
use output::Output;
pub(crate) use output::shoot_window;

/// Where records go. The prototype writes files; the app will write guide steps.
pub trait Sink {
    fn write(&mut self, record: Record, image: Option<RgbaImage>);
}

#[derive(Debug, Clone)]
pub struct PipelineConfig {
    pub mode: CaptureMode,
    /// If set, only clicks on this monitor are recorded.
    pub target_monitor: Option<PxRect>,
    pub uia_timeout: Duration,
    /// Test only: sleep this long per event to simulate a stalled worker.
    pub stall_per_event: Duration,
    /// How long input can be silent while the cursor moves before we call it Degraded.
    pub silence_limit: Duration,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            mode: CaptureMode::Window,
            target_monitor: None,
            // Room for Chrome's second look (`uia::element_at`), which can take ~200 ms.
            uia_timeout: Duration::from_millis(350),
            stall_per_event: Duration::ZERO,
            silence_limit: Duration::from_secs(2),
        }
    }
}

/// Timings and counts for the report.
#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub clicks: u64,
    pub doubles: u64,
    pub ignored_own: u64,
    /// Clicks on windows of excluded apps: never screenshotted or read.
    pub ignored_excluded: u64,
    pub missed: u64,
    pub degraded: u64,
    pub inputs: u64,
    pub uia_timeouts: u64,
    pub uia_errors: u64,
    pub uia_retries: u64,
    /// Clicks named from their pre-read, the element under the resting pointer before the click.
    pub uia_pre_reads: u64,
    pub screenshot_ms: Vec<f64>,
    pub uia_ms: Vec<f64>,
    pub queue_delay_ms: Vec<f64>,
}

fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// A title-bar button as a click record says it, and the naming in `packages/core` reads it
/// (`test-vectors/click-naming.json`).
fn title_bar_button_name(button: TitleBarButton) -> &'static str {
    match button {
        TitleBarButton::Close => "close",
        TitleBarButton::Minimise => "minimise",
        TitleBarButton::Maximise => "maximise",
        TitleBarButton::Restore => "restore",
    }
}

/// Whether a program, by the file name of its process, is kept out of the recording: an app the
/// user excluded, or, while anything is excluded, one that can't be named
/// ([`crate::exclusions::is_excluded_program`]).
pub(crate) fn is_excluded_program(
    machine: &Mutex<RecorderStateMachine>,
    name: Option<&str>,
) -> bool {
    let machine = machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    crate::exclusions::is_excluded_program(machine.excluded_apps(), name)
}

/// Whether a window belongs to an app the user excluded from recording, or, while anything is
/// excluded, to a program that can't be named ([`is_excluded_program`]).
pub fn is_excluded_window(machine: &Mutex<RecorderStateMachine>, window: &WindowInfo) -> bool {
    is_excluded_program(machine, window.exe_name())
}

/// Whether a window is owned by an excluded app's window (#103,
/// [`crate::exclusions::is_owned_by_excluded`]): a pop-up another program draws for it. `owners`
/// are the processes of the windows up its owners (`owner_processes_at`), whether or not those
/// are showing; `program_of` names a process, and is asked only for one other than the window's
/// own, which is judged by its window. Screenshots judge the pop-ups they show the same way (#110).
pub(crate) fn is_owned_by_excluded_app(
    machine: &Mutex<RecorderStateMachine>,
    window: &WindowInfo,
    owners: &[u32],
    program_of: impl Fn(u32) -> Option<String>,
) -> bool {
    crate::exclusions::is_owned_by_excluded(window.pid, owners, |pid| {
        is_excluded_program(machine, program_of(pid).as_deref())
    })
}

/// Whether a click is in an excluded app, and so makes no step, screenshot or lookup (#103): in
/// one of its windows, or in a pop-up that came from one though another program draws it
/// ([`is_owned_by_excluded_app`]). `pop_up_owner` is the window a pop-up came from, as #72 finds it
/// for its screenshot (`Pressed::owner`); `owners` count too, as that is found only while it's
/// showing, and not at all for a click whose press wasn't read.
pub(crate) fn is_excluded_click(
    machine: &Mutex<RecorderStateMachine>,
    window: &WindowInfo,
    pop_up_owner: Option<&WindowInfo>,
    owners: &[u32],
    program_of: impl Fn(u32) -> Option<String>,
) -> bool {
    is_excluded_window(machine, window)
        || pop_up_owner.is_some_and(|owner| is_excluded_window(machine, owner))
        || is_owned_by_excluded_app(machine, window, owners, program_of)
}

/// A typed value that must be dropped, never saved: from our own windows, or from an app the
/// recording excludes, named by the field's process or by the window in front (a web-view host
/// such as the new Outlook runs its fields in `msedgewebview2.exe`), or where neither app can be
/// named. The focus handler already skips such fields; this is checked again because focus often
/// leaves a field just as the exclusions or the recording change.
fn input_is_blocked(machine: Option<&Mutex<RecorderStateMachine>>, record: &InputRecord) -> bool {
    let own = crate::platform::window::own_process_id();
    if record.pid == own || record.window_pid == own {
        return true;
    }
    let Some(machine) = machine else {
        return false;
    };
    let field_exe = crate::platform::window::process_exe_name(record.pid);
    if field_exe.is_none() && record.window_exe.is_none() {
        return true;
    }
    let machine = machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    field_exe.is_some_and(|name| machine.is_app_excluded(&name))
        || record
            .window_exe
            .as_deref()
            .is_some_and(|name| machine.is_app_excluded(name))
}

/// How long after the recording starts the window in front is taken as where it began, not a
/// switch: the main window minimises then, and Windows brings another forward.
const START_SETTLE: Duration = Duration::from_millis(2000);
/// How long after a click on the taskbar or Start the app that comes forward is the one it
/// opened (a large app can take a few seconds to show its window).
const SHELL_OPENS: Duration = Duration::from_millis(5000);

/// How long after an app comes forward its "Open" step's screenshot is taken: time to draw.
const SWITCH_SHOT_AFTER: Duration = Duration::from_millis(450);
/// How often the last-input clock is read for keys (`switches`): a key shows on it only until
/// the mouse next moves.
const INPUT_CLOCK_EVERY: Duration = Duration::from_millis(20);

/// When the input thread last saw a press, any mouse input, a touch and a key.
fn input_seen(shared: &InputShared) -> InputSeen {
    InputSeen {
        press: shared.last_press(),
        mouse: shared.last_mouse(),
        touch: shared.last_touch(),
        key: shared.last_key(),
    }
}

/// What a window mode screenshot of `window` greys out of what lies over it: only notification
/// toasts over the Start menu, Search and the like, which are drawn by several shell processes, so
/// their own parts aren't someone else's window to grey out (04/10/2026); every other program's
/// window over an app's. A retake's screenshot of the window in front follows the same rule (#96).
#[must_use]
pub fn cover_for(window: &WindowInfo) -> crate::screenshot::Cover {
    if is_shell_window(window) {
        crate::screenshot::Cover::NotificationsOnly
    } else {
        crate::screenshot::Cover::Others
    }
}

/// What a click's screenshot is of, and what it greys out over it (#72). A click in a pop-up (a
/// menu, a drop-down) shows the window it came from (`owner`, read as the button went down) with
/// the pop-up on top, greyed as that window's own screenshot would be: P11 of the 10/10/2026 test
/// had Excel's right-click menu alone, nothing of the sheet. Not a window of the Windows shell
/// (the taskbar, the desktop, Search), which other programs' windows lie over but whose
/// screenshots grey out only toasts: the pop-up stays a screenshot of its own, as before.
fn click_target(
    window: &WindowInfo,
    owner: Option<WindowInfo>,
) -> (Target, crate::screenshot::Cover) {
    let frame = PxRect::from(window.frame);
    match owner.filter(|owner| !is_shell_window(owner)) {
        Some(owner) => (
            Target {
                pid: window.pid,
                frame,
                owner: Some(Owner {
                    pid: owner.pid,
                    frame: owner.frame.into(),
                }),
            },
            cover_for(&owner),
        ),
        None => (Target::window(window.pid, frame), cover_for(window)),
    }
}

/// For a click in Windows' input panel (#109), the window it puts what's picked into, which its
/// screenshot shows with the panel on top, as a pop-up's shows the window it came from (#72): the
/// window in front (`front`), or, when that's the text input host's own (as it can be on build
/// 26300, 12/10/2026), the front-most app window that isn't the panel's program's (`behind`).
/// Never another input panel or Steps' own. Both are asked only for the panel: `None` for any
/// other window, which keeps its own screenshot.
fn input_panel_owner(
    window: &WindowInfo,
    front: impl FnOnce() -> Option<WindowInfo>,
    behind: impl FnOnce(u32) -> Option<WindowInfo>,
) -> Option<WindowInfo> {
    if !is_input_panel(window) {
        return None;
    }
    let own = crate::platform::window::own_process_id();
    let serves = |candidate: &WindowInfo| {
        candidate.hwnd != window.hwnd
            && !is_input_panel(candidate)
            && candidate.pid != own
            && !is_steps_window(candidate)
    };
    front()
        .filter(serves)
        .or_else(|| behind(window.pid).filter(serves))
}

/// For a click in a pop-up, the title of the window it came from (`owner`, read as the button went
/// down, #72), which names the click when nothing else does, before the pop-up's own title, which
/// isn't on screen: `WinUI`'s pop-up host is titled "Pop-upHost" in en-GB (#106). Not a window of
/// the Windows shell's,
/// whose titles ("Program Manager") aren't anything on screen, as its screenshot isn't shown round
/// a pop-up either.
fn owner_title(owner: Option<&WindowInfo>) -> Option<String> {
    owner
        .filter(|owner| !is_shell_window(owner))
        .map(|owner| owner.title.clone())
}

/// The window a click's screenshot shows round the one clicked in: a pop-up's, read as the button
/// went down (#72), or the one an input panel puts what's picked into (#109).
fn shown_with(window: &WindowInfo, pop_up_owner: Option<WindowInfo>) -> Option<WindowInfo> {
    pop_up_owner.or_else(|| {
        input_panel_owner(
            window,
            crate::platform::window::foreground_window,
            crate::platform::window::front_window_except,
        )
    })
}

/// Why nothing under a click in `window` is read through UI Automation, if so: a remote
/// session's window shows another computer, whose controls can't be named; in Windows' input
/// panel a clipboard history item can be named after the text it holds (#109), and the clipboard is
/// never read (04/10/2026). Its menus' items aren't taken either.
fn unread_under_click(window: &WindowInfo) -> Option<&'static str> {
    if is_remote_window(window) {
        Some("remote session")
    } else if is_input_panel(window) {
        Some("input panel")
    } else {
        None
    }
}

/// Whether a click's lookup found the Remote Desktop control's input window, in a program not on
/// the list of remote-desktop clients (#116): the click is then a remote session's, as in Remote
/// Desktop Connection's window. Its element is dropped, so only the window names it, and the
/// lookup is journalled `skipped`, "remote session". It could only be known after the lookup,
/// which reads no more than the control's own name ("Input Capture Window").
fn remote_input_clicked(element: &mut Option<ElementFacts>, outcome: &mut UiaOutcome) -> bool {
    if !element.as_ref().is_some_and(is_remote_input) {
        return false;
    }
    *element = None;
    outcome.status = "skipped";
    outcome.error = Some("remote session".into());
    outcome.pre_read = false;
    true
}

/// Watches for "the person is moving the mouse but the input source reports nothing".
///
/// The cursor moving isn't enough on its own: apps can jump it with `SetCursorPos`, which isn't
/// input. So Windows' last-input clock must also be advancing, which only real (or injected)
/// input does.
struct SilenceWatch {
    last_moves: u64,
    last_cursor: Option<(i32, i32)>,
    last_input: Option<u32>,
    silent_since: Option<Instant>,
    degraded: bool,
    next_check: Instant,
}

impl SilenceWatch {
    fn new(shared: &InputShared) -> Self {
        Self {
            last_moves: shared.moves.load(Ordering::Relaxed),
            last_cursor: cursor_pos(),
            last_input: last_input_tick(),
            silent_since: None,
            degraded: false,
            next_check: Instant::now(),
        }
    }

    /// Returns a state change to report, if any.
    fn check(&mut self, shared: &InputShared, limit: Duration) -> Option<Record> {
        let now = Instant::now();
        if now < self.next_check {
            return None;
        }
        self.next_check = now + Duration::from_millis(250);

        let moves = shared.moves.load(Ordering::Relaxed);
        let cursor = cursor_pos();
        let input = last_input_tick();
        let cursor_moved = cursor != self.last_cursor;
        let real_input = input != self.last_input;
        let events_arrived = moves != self.last_moves;
        self.last_moves = moves;
        self.last_cursor = cursor;
        self.last_input = input;

        if events_arrived {
            self.silent_since = None;
            if self.degraded {
                self.degraded = false;
                return Some(Record::State {
                    state: "recovered",
                    reason: "input events are arriving again".into(),
                    tick_ms: now_tick(),
                });
            }
        } else if cursor_moved && real_input {
            let since = *self.silent_since.get_or_insert(now);
            if !self.degraded && now.duration_since(since) >= limit {
                self.degraded = true;
                return Some(Record::State {
                    state: "degraded",
                    reason: "the cursor is moving but the input source reports nothing".into(),
                    tick_ms: now_tick(),
                });
            }
        }
        None
    }
}

/// Runs until `stop` is set, then drains the queue.
pub fn run(
    shared: &InputShared,
    uia: &UiaClient,
    inputs: Option<&Receiver<InputRecord>>,
    config: &PipelineConfig,
    stop: &AtomicBool,
    sink: &mut dyn Sink,
) -> Stats {
    run_inner(shared, uia, inputs, None, config, stop, sink, None)
}

/// The key worker's side of a recording with "Record what's typed" ticked: the records it makes,
/// and where clicks are reported to it (a click ends a stretch of typing).
pub struct KeyLink {
    pub records: Receiver<KeyedRecord>,
    pub clicks: Arc<ClickNews>,
}

/// Runs the production recording worker with timestamp-aware state filtering and lifecycle
/// monitoring. The prototype keeps using [`run`] so its harness remains independent of UI state.
#[allow(
    clippy::too_many_arguments,
    reason = "each is a separate part of the recording"
)]
pub fn run_recording(
    shared: &InputShared,
    uia: &UiaClient,
    inputs: Option<&Receiver<InputRecord>>,
    keys: Option<&KeyLink>,
    config: &PipelineConfig,
    stop: &AtomicBool,
    sink: &mut dyn Sink,
    machine: &Mutex<RecorderStateMachine>,
) -> Stats {
    run_inner(shared, uia, inputs, keys, config, stop, sink, Some(machine))
}

/// Writes the key worker's records that have arrived. Called in the recording loop, and once
/// more after the key worker has stopped, for what it finished at Stop.
pub fn write_key_records(
    records: &Receiver<KeyedRecord>,
    machine: &Mutex<RecorderStateMachine>,
    sink: &mut dyn Sink,
) {
    write_key_records_after(records, machine, sink, |_| ());
}

/// `write_key_records`, calling `before` ahead of the first record written (to write a browser
/// address still settling, so it stays in front of the typing that followed it).
fn write_key_records_after(
    records: &Receiver<KeyedRecord>,
    machine: &Mutex<RecorderStateMachine>,
    sink: &mut dyn Sink,
    mut before: impl FnMut(&mut dyn Sink),
) {
    let mut first = true;
    while let Ok((record, image)) = records.try_recv() {
        let keep = record.event_tick().is_none_or(|tick| {
            machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .should_process_event(tick)
                == crate::state_machine::EventDecision::Process
        });
        if !keep {
            continue;
        }
        machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .note_auxiliary_step();
        if first {
            first = false;
            before(sink);
        }
        sink.write(record, image);
    }
}

#[allow(clippy::too_many_lines, clippy::too_many_arguments)] // Keeps event ordering and pause/stop cutoffs reviewable together.
fn run_inner(
    shared: &InputShared,
    uia: &UiaClient,
    inputs: Option<&Receiver<InputRecord>>,
    keys: Option<&KeyLink>,
    config: &PipelineConfig,
    stop: &AtomicBool,
    sink: &mut dyn Sink,
    machine: Option<&Mutex<RecorderStateMachine>>,
) -> Stats {
    let mut stats = Stats::default();
    let mut out = Output {
        config,
        machine,
        sink,
    };
    let own_pid = own_process_id();
    let (double_ms, double_width, double_height) = double_click_settings();
    let mut previous: Option<MouseDown> = None;
    let mut last_id = 0u64;
    let mut dropped_seen = shared.dropped.load(Ordering::Relaxed);
    let mut watch = SilenceWatch::new(shared);
    // Resuming re-registers the input source, so the silence check starts again: if clicks still
    // don't arrive it must be able to notice a second time.
    let mut was_active = true;
    let mut next_health_check = Instant::now();
    if let Some(machine) = machine {
        // Touch reports are counted for the whole process; this recording counts from here.
        machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .seed_touch_reports(shared.touch_reports.load(Ordering::Relaxed));
    }
    let mut last_foreground: Option<(u32, String)> = None;
    // "Open" steps are only for apps the person went to (docs/spec/02-capture.md#events): not the
    // window Windows brings forward when Steps minimises at the start, and not the app a
    // click on the taskbar or Start opens, which that click's step already says.
    let started = Instant::now();
    let mut clicked = false;
    let mut last_shell_click: Option<Instant> = None;
    let mut last_elevation: Option<(u32, bool, String)> = None;
    let mut next_browser_poll = Instant::now();
    let mut browser_request_id = 0_u64;
    let mut browser_request: Option<(u64, WindowInfo)> = None;
    let mut last_origin: Option<(u32, String)> = None;
    // A left click on a spreadsheet cell, until the button comes up: a drag to another cell
    // selects the cells between (04/10/2026).
    let mut drag_from: Option<DragStart> = None;
    // A press on a fill handle that came up where it went down: a second press makes it a
    // double-click, which fills down the column (08/10/2026).
    let mut fill_press: Option<DragStart> = None;
    // That fill, waiting for Excel to draw it before its screenshot: when, the press, and when
    // the second press came.
    let mut pending_fill: Option<(Instant, DragStart, u32)> = None;
    // A left press on a canvas a pencil or brush draws on, until the button comes up: moved, it
    // drew (#73).
    let mut stroke: Option<DrawStart> = None;
    // The screenshot of the field that has focus, taken as it arrived, and the next one's id.
    let mut field_shot: Option<(u32, crate::screenshot::Shot, WindowInfo)> = None;
    let mut next_field_id: u64 = 0;
    // When a browser's address bar was last seen with the keyboard, by process.
    let mut bar_focused: Option<(u32, Instant)> = None;
    let mut settle: NavigationSettle<WindowInfo> = NavigationSettle::default();
    let mut pending_switch: Option<(Instant, AppSwitchRecord, WindowInfo)> = None;
    // The program in front before the waiting "Open" step's.
    let mut pending_from: Option<(u32, String)> = None;
    // The input before each app that comes forward: one with none may have come forward by
    // itself, and its "Open" step needs review (#67).
    let mut switch_input = SwitchInput::default();
    let mut next_input_clock = Instant::now();

    loop {
        if let Some(machine) = machine {
            if Instant::now() >= next_input_clock {
                next_input_clock = Instant::now() + INPUT_CLOCK_EVERY;
                switch_input.note(last_input_tick(), input_seen(shared));
            }
            while let Some(change) = shared.pop_foreground() {
                let window = window_info(change.hwnd);
                let exe_name = window
                    .as_ref()
                    .and_then(|window| window.exe_name().map(str::to_string));
                let mut recorder = machine
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let previous = recorder.state().clone();
                recorder.handle_foreground_change(exe_name.as_deref(), change.tick_ms);
                let mut app_switch = None;
                // An excluded app's window isn't a place the guide went, so going back from it to
                // the window before is not a new "Open" step.
                // Nor is the taskbar, Start or the desktop: they're how the person got somewhere.
                if let Some(window) = window
                    && window.pid != own_pid
                    && !is_shell_window(&window)
                    && !window
                        .exe_name()
                        .is_some_and(|name| recorder.is_app_excluded(name))
                {
                    if is_browser(window.exe_name()) {
                        next_browser_poll = Instant::now();
                    }
                    // One "Open" per program: its own dialogs and other windows (Save As, Word's start
                    // screen then its document) aren't apps the person went to (F004, F020, F069).
                    let key = program_key(&window);
                    let uncovered_at_start = !clicked && started.elapsed() < START_SETTLE;
                    let opened_by_shell_click = last_shell_click
                        .take()
                        .is_some_and(|at| at.elapsed() < SHELL_OPENS);
                    if last_foreground.as_ref() != Some(&key)
                        && !uncovered_at_start
                        && !opened_by_shell_click
                        && recorder.is_active()
                        && recorder.app_switch_steps()
                    {
                        // A window in front for less than the wait before its screenshot only
                        // flashed past (a console opening and closing, Alt+Tab passing through):
                        // the guide never went there, and going back to the program before it is
                        // no new "Open" either. Found live: "Open "Windows Terminal Host"", then
                        // "Open "Windows Explorer"" for the window already being used.
                        let flashed = pending_switch
                            .as_ref()
                            .is_some_and(|(due, _, _)| Instant::now() < *due);
                        let back = flashed && pending_from.as_ref() == Some(&key);
                        if flashed {
                            pending_switch = None;
                            recorder.forget_auxiliary_step();
                        }
                        if !back {
                            pending_from.clone_from(&last_foreground);
                        }
                        // The clock read again now: a key just before this change (Alt+Tab) may
                        // not have been read yet.
                        let seen = input_seen(shared);
                        switch_input.note(last_input_tick(), seen);
                        let unprompted = !switch_input.prompted(change.tick_ms, seen);
                        app_switch = (!back).then(|| {
                            (
                                AppSwitchRecord {
                                    id: u64::from(change.tick_ms),
                                    tick_ms: change.tick_ms,
                                    window: window_facts(&window),
                                    capture: None,
                                    unprompted,
                                },
                                window.clone(),
                            )
                        });
                    }
                    last_foreground = Some(key);
                }
                if app_switch.is_some() {
                    recorder.note_auxiliary_step();
                }
                let changed = recorder.state() != &previous;
                let active = recorder.is_active();
                let takes_clicks = recorder.takes_clicks();
                drop(recorder);
                if let Some((record, window)) = app_switch {
                    out.write_navigation(settle.flush(), &mut last_origin);
                    // Written once the app has had a moment to draw, with its screenshot; an
                    // earlier one still waiting goes first.
                    if let Some(earlier) = pending_switch.take() {
                        out.write_switch(earlier);
                    }
                    pending_switch = Some((Instant::now() + SWITCH_SHOT_AFTER, record, window));
                }
                if changed {
                    shared.enabled.store(takes_clicks, Ordering::SeqCst);
                    out.write(
                        Record::State {
                            state: if active { "recording" } else { "paused" },
                            // Never the app's name: which apps are kept out stays out of the
                            // journal (docs/spec/08-privacy-and-security.md).
                            reason: match (exe_name, active) {
                                (Some(_), false) => "An excluded application".into(),
                                (Some(_), true) => "Back to a recorded app".into(),
                                (None, _) => "Foreground application changed".into(),
                            },
                            tick_ms: change.tick_ms,
                        },
                        None,
                    );
                }
            }

            let now = Instant::now();
            if now >= next_health_check {
                next_health_check = now + Duration::from_millis(250);
                let secure_desktop = !input_desktop_is_default();
                let input_lost = shared.source() == InputSource::RawInput && !registration().mouse;
                let current_foreground = foreground_window().filter(|window| window.pid != own_pid);
                let elevation = current_foreground.as_ref().map(|window| {
                    (
                        window.pid,
                        window.elevation == Elevation::Elevated,
                        window.title.clone(),
                    )
                });
                let mut lifecycle_records = Vec::new();
                if elevation != last_elevation {
                    if let Some((_, true, title)) = elevation.as_ref() {
                        if machine
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .is_active()
                        {
                            lifecycle_records.push(Record::State {
                                state: "elevatedWindow",
                                reason: title.clone(),
                                tick_ms: now_tick(),
                            });
                        }
                    } else if last_elevation
                        .as_ref()
                        .is_some_and(|(_, was_elevated, _)| *was_elevated)
                    {
                        lifecycle_records.push(Record::State {
                            state: "elevatedWindowCleared",
                            reason: String::new(),
                            tick_ms: now_tick(),
                        });
                    }
                    last_elevation = elevation;
                }
                let mut recorder = machine
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if secure_desktop {
                    let was_active = recorder.is_active();
                    recorder.handle_desktop_status(false, now_tick());
                    if was_active && !recorder.is_active() {
                        shared.enabled.store(false, Ordering::SeqCst);
                        lifecycle_records.push(Record::State {
                            state: "paused",
                            reason: "The secure desktop is active".into(),
                            tick_ms: now_tick(),
                        });
                    }
                } else if matches!(
                    recorder.state(),
                    RecorderState::Paused {
                        reason: PauseReason::LockScreen | PauseReason::Uac,
                        ..
                    }
                ) {
                    recorder.handle_desktop_status(true, now_tick());
                    if recorder.is_active() {
                        shared.enabled.store(true, Ordering::SeqCst);
                        lifecycle_records.push(Record::State {
                            state: "recording",
                            reason: "The secure desktop closed".into(),
                            tick_ms: now_tick(),
                        });
                    }
                } else if recorder.is_active() && input_lost {
                    let _ = recorder.pause(
                        PauseReason::InputStopped("Raw Input registration was replaced".into()),
                        now_tick(),
                    );
                    shared.enabled.store(false, Ordering::SeqCst);
                    lifecycle_records.push(Record::State {
                        state: "paused",
                        reason: "Raw Input registration was replaced. Resume to try again.".into(),
                        tick_ms: now_tick(),
                    });
                }

                let reports = shared.touch_reports.load(Ordering::Relaxed);
                if let Some(record) = recorder.handle_touch_reports(reports, now_tick(), 5) {
                    lifecycle_records.push(record);
                }
                drop(recorder);
                for record in lifecycle_records {
                    out.write(record, None);
                }
            }
        }

        if let Some(machine) = machine {
            if let Some(read) = browser_request
                .as_ref()
                .and_then(|(id, _)| uia.take_browser_origin(*id))
                && let Some((_, window)) = browser_request.take()
            {
                if read.focused {
                    bar_focused = Some((window.pid, Instant::now()));
                    // Read again soon, to catch the address it goes to.
                    next_browser_poll = next_browser_poll.min(Instant::now() + SETTLING_POLL);
                }
                let unchanged = read.origin.as_ref().is_some_and(|origin| {
                    last_origin.as_ref() == Some(&(window.pid, origin.clone()))
                });
                // Left without going anywhere (Escape, a click on the page): a link clicked
                // later isn't typed.
                if !read.focused && unchanged && !settle.is_settling() {
                    bar_focused = None;
                }
                if let Some(origin) = read.origin
                    // While an address settles every read counts, even one back where it started.
                    && (settle.is_settling() || !unchanged)
                    && machine
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .is_active()
                {
                    let tick_ms = now_tick();
                    let process = machine
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .should_process_event(tick_ms)
                        == crate::state_machine::EventDecision::Process;
                    if process {
                        let typed = bar_focused.is_some_and(|(pid, at)| {
                            pid == window.pid && at.elapsed() <= TYPED_WITHIN
                        });
                        if typed {
                            bar_focused = None;
                        }
                        let earlier =
                            settle.seen(window.pid, origin, window, tick_ms, typed, Instant::now());
                        out.write_navigation(earlier, &mut last_origin);
                    }
                }
            }
            out.write_navigation(settle.due(Instant::now()), &mut last_origin);

            let now = Instant::now();
            if now >= next_browser_poll && browser_request.is_none() {
                next_browser_poll = now
                    + if settle.is_settling() {
                        SETTLING_POLL
                    } else {
                        Duration::from_millis(1200)
                    };
                if machine
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .is_active()
                    && let Some(window) = foreground_window()
                        .filter(|window| window.pid != own_pid && is_browser(window.exe_name()))
                {
                    browser_request_id = browser_request_id.wrapping_add(1);
                    uia.request_browser_origin(browser_request_id, window.hwnd);
                    browser_request = Some((browser_request_id, window));
                }
            }
        }

        if let Some(start) = drag_from.take() {
            match shared.left_release(start.of) {
                LeftRelease::Up(tick_ms, x, y) => {
                    fill_press = write_drag(start, (tick_ms, x, y), uia, &mut out);
                }
                LeftRelease::Down if start.at.elapsed() <= DRAG_GIVE_UP => drag_from = Some(start),
                // Its release was never seen: it stays the click it was, and a later press's
                // release never makes it a drag (the 10/10/2026 test: a fill-handle double-click's
                // first release had turned a click on D2 into `Select "D2:E2"`). A press on a fill
                // handle can still be a double-click's first.
                LeftRelease::Down | LeftRelease::Missed => {
                    fill_press = start.fill_corner.is_some().then_some(start);
                }
            }
        }
        if pending_fill
            .as_ref()
            .is_some_and(|(due, _, _)| Instant::now() >= *due)
            && let Some((_, start, tick_ms)) = pending_fill.take()
        {
            write_fill_down(&start, tick_ms, &mut out);
        }
        if let Some(start) = stroke.take() {
            match shared.left_release(start.of) {
                LeftRelease::Up(tick_ms, x, y) => {
                    if dragged((start.x, start.y), (x, y)) {
                        write_draw(&start, tick_ms, &mut out);
                    }
                }
                LeftRelease::Down if start.at.elapsed() <= DRAG_GIVE_UP => stroke = Some(start),
                // Its release was never seen: it stays the click it was.
                LeftRelease::Down | LeftRelease::Missed => {}
            }
        }

        // An editable field gained focus: its screenshot now, before anything is typed, for the
        // typing step its value makes when focus leaves (04/10/2026).
        if let Some(entered) = uia.take_field_entered() {
            field_shot = out
                .shoot(&entered.window)
                .map(|shot| (entered.tick_ms, shot, entered.window));
        }

        if let Some(inputs) = inputs {
            while let Ok(mut record) = inputs.try_recv() {
                if machine.is_some_and(|shared| {
                    let current = shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    // A pause while the field had focus drops the whole value: what was typed
                    // during the pause can't be told apart from the rest.
                    current.should_process_event(record.tick_ms)
                        != crate::state_machine::EventDecision::Process
                        || current.paused_between(record.focused_tick_ms, record.tick_ms)
                        || current.before_restart(record.focused_tick_ms)
                }) {
                    continue;
                }
                if input_is_blocked(machine, &record) {
                    continue;
                }
                stats.inputs += 1;
                if let Some(machine) = machine {
                    machine
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .note_auxiliary_step();
                }
                out.write_navigation(settle.flush(), &mut last_origin);
                let image = field_shot
                    .take_if(|(tick, _, _)| *tick == record.focused_tick_ms)
                    .map(|(_, shot, window)| {
                        next_field_id += 1;
                        record.id = Some(next_field_id);
                        record.window = Some(window_facts(&window));
                        record.element_pct = record
                            .element
                            .bounds
                            .and_then(|bounds| rect_to_pct(&shot.rect, &bounds));
                        record.capture = Some(CaptureFacts::of(&shot, config.mode));
                        shot.image
                    });
                out.write(Record::Input(record), image);
            }
        }

        if let (Some(keys), Some(machine)) = (keys, machine) {
            write_key_records_after(&keys.records, machine, &mut *out.sink, |sink| {
                Output {
                    config,
                    machine: Some(machine),
                    sink,
                }
                .write_navigation(settle.flush(), &mut last_origin);
            });
        }

        let dropped = shared.dropped.load(Ordering::Relaxed);
        if dropped > dropped_seen {
            let count = dropped - dropped_seen;
            dropped_seen = dropped;
            stats.missed += count;
            let missed = machine.map_or(
                Record::Missed {
                    count,
                    after_id: last_id,
                },
                |state| {
                    state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .handle_queue_overflow(count, last_id)
                },
            );
            out.write(missed, None);
            if machine.is_some_and(|state| {
                matches!(
                    state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .state(),
                    RecorderState::Degraded { .. }
                )
            }) {
                out.write(
                    Record::State {
                        state: "degraded",
                        reason: format!("{count} clicks were missed because the queue was full"),
                        tick_ms: now_tick(),
                    },
                    None,
                );
            }
        }

        if let Some(machine) = machine {
            let active = machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_active();
            if active && !was_active {
                watch = SilenceWatch::new(shared);
            }
            was_active = active;
        }
        if let Some(change) = watch.check(shared, config.silence_limit) {
            if matches!(
                change,
                Record::State {
                    state: "degraded",
                    ..
                }
            ) {
                stats.degraded += 1;
            }
            if let (
                Some(machine),
                Record::State {
                    state: "degraded",
                    tick_ms,
                    ..
                },
            ) = (machine, &change)
            {
                let paused = {
                    let mut machine = machine
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if machine.is_active() {
                        let _ = machine.pause(
                            PauseReason::InputStopped("Mouse input stopped arriving".into()),
                            *tick_ms,
                        );
                        true
                    } else {
                        false
                    }
                };
                if paused {
                    shared.enabled.store(false, Ordering::SeqCst);
                    out.write(
                        Record::State {
                            state: "paused",
                            reason:
                                "Clicks stopped arriving. Resume to try the input source again."
                                    .into(),
                            tick_ms: *tick_ms,
                        },
                        None,
                    );
                }
            } else if machine.is_none()
                || !matches!(
                    change,
                    Record::State {
                        state: "recovered",
                        ..
                    }
                )
            {
                out.write(change, None);
            }
        }

        if pending_switch
            .as_ref()
            .is_some_and(|(due, _, _)| Instant::now() >= *due)
            && let Some(switch) = pending_switch.take()
        {
            out.write_switch(switch);
        }
        let Some(event) = shared.pop() else {
            if stop.load(Ordering::Relaxed) {
                if let Some(switch) = pending_switch.take() {
                    out.write_switch(switch);
                }
                // The double-click happened before Stop: its fill is a step, picture or not.
                if let Some((_, start, tick_ms)) = pending_fill.take() {
                    write_fill_down(&start, tick_ms, &mut out);
                }
                // An address read before Stop still counts, settled or not.
                out.write_navigation(settle.flush(), &mut last_origin);
                break;
            }
            // Missed clicks were marked where they happened; once the queue has drained with no
            // new drops, the warning clears (docs/spec/02-capture.md#on-each-click).
            if let Some(machine) = machine
                && shared.dropped.load(Ordering::Relaxed) == dropped_seen
                && machine
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .recover_after_drain()
            {
                out.write(
                    Record::State {
                        state: "recovered",
                        reason: "the click queue has drained".into(),
                        tick_ms: now_tick(),
                    },
                    None,
                );
            }
            std::thread::sleep(Duration::from_millis(4));
            continue;
        };
        last_id = event.id;
        // Every press taken from the queue is told to the key worker, which holds back the keys
        // typed after it until then (#97): as a click below, or as passed over when this goes out
        // of scope at any `continue` before that.
        let report = keys.map(|keys| keys.clicks.press(event.tick_ms));
        // What was under the pointer as the button went down, read by the input thread before the
        // app reacted: by now the click may have closed the window it was in (#48).
        let press = shared.take_press(event.id);

        let other_screen = config
            .target_monitor
            .is_some_and(|monitor| !monitor.contains(event.x, event.y));

        if machine.is_some_and(|shared_machine| {
            let mut recorder = shared_machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let process = recorder.should_process_click(event.tick_ms)
                == crate::state_machine::EventDecision::Process;
            // A recording whose every click was on a screen left out was an empty draft with no
            // word why: the count is said when it ends.
            if process && other_screen {
                recorder.note_other_screen_click();
            }
            !process
        }) {
            continue;
        }
        if other_screen {
            continue;
        }

        if !config.stall_per_event.is_zero() {
            std::thread::sleep(config.stall_per_event);
        }

        if let Some(before) = previous
            && before.button == event.button
            && event.tick_ms.wrapping_sub(before.tick_ms) <= double_ms
            && (event.x - before.x).abs() <= double_width / 2
            && (event.y - before.y).abs() <= double_height / 2
        {
            stats.doubles += 1;
            out.write(
                Record::Double {
                    of: before.id,
                    tick_ms: event.tick_ms,
                },
                None,
            );
            // A double-click on a fill handle fills down the column (08/10/2026). Its first press
            // may still be waiting for its release, or have come up already.
            if let Some(start) = drag_from
                .take_if(|start| start.of == before.id && start.fill_corner.is_some())
                .or_else(|| fill_press.take_if(|start| start.of == before.id))
            {
                pending_fill = Some((Instant::now() + FILL_SHOT_AFTER, start, event.tick_ms));
            }
            previous = None; // a third press starts a new click
            continue;
        }
        // Only a press that became a step can start a double-click: if this one is ignored or
        // fails, the next press is a click of its own.
        previous = None;

        if let Some(switch) = pending_switch.take() {
            out.write_switch(switch);
        }
        // The fill a double-click made goes before the next click, its picture taken now.
        if let Some((_, start, tick_ms)) = pending_fill.take() {
            write_fill_down(&start, tick_ms, &mut out);
        }
        let pressed = press.as_ref().and_then(|press| press.pressed.as_ref());
        let Some(window) = clicked_window(pressed, || root_window_at(event.x, event.y)) else {
            stats.missed += 1;
            out.write_capture_failure(&event);
            continue;
        };
        // The programs of the windows up its owners, as the button went down, when a pop-up
        // clicked in still showed, or as they are now if that wasn't read: a pop-up belongs to the
        // app whose window owns it, whoever draws it (#103).
        let owners = pressed.map_or_else(
            || crate::platform::window::owner_processes_at(event.x, event.y),
            |pressed| pressed.owners.clone(),
        );
        // A popup of our own windows (a WebView2 drop-down or menu) can belong to a web-view
        // process, not ours, so its owner is checked too.
        if window.pid == own_pid
            || owners.contains(&own_pid)
            || crate::platform::window::owner_process_at(event.x, event.y) == Some(own_pid)
            || is_steps_window(&window)
        {
            stats.ignored_own += 1;
            continue;
        }
        // Checked per click, before any screenshot or UIA read: the auto-pause only follows the
        // foreground change, which arrives after the first click into an excluded app. It is also
        // what keeps clicks out while paused for one (`should_process_click`). A click in a pop-up
        // an excluded app's window owns is that app's (#103).
        if machine.is_some_and(|state| {
            is_excluded_click(
                state,
                &window,
                pressed.and_then(|pressed| pressed.owner.as_ref()),
                &owners,
                crate::platform::window::process_exe_name,
            )
        }) {
            stats.ignored_excluded += 1;
            continue;
        }

        if let Some(report) = report {
            report.clicked(window.hwnd, (event.x, event.y));
        }
        let processed = process_click(&event, &window, press, uia, config, machine, &mut stats);
        // Typing straight after a click goes into the element clicked, and in Excel into the cell
        // it selected (#75, #97).
        // A click where nothing is read by design (a remote session, the input panel) is told
        // apart from one whose lookup failed: focus can't move to anything UI Automation sees
        // there (the #97 third review).
        if let Some(keys) = keys {
            let element = processed
                .as_ref()
                .and_then(|(record, _)| record.element.clone());
            // A click on the Remote Desktop control in any program is a remote session's (#116).
            let remote = processed
                .as_ref()
                .is_some_and(|(record, _)| record.window.remote_session);
            let looked = match element {
                Some(element) => Looked::Found(Box::new(element)),
                None if remote || unread_under_click(&window).is_some() => Looked::Unread,
                None => Looked::Failed,
            };
            let cell = processed
                .as_ref()
                .and_then(|(record, _)| cell_selected(record, &window, event.button));
            keys.clicks.named(event.tick_ms, looked, cell);
        }
        if let Some((record, image)) = processed {
            // Steps' own taskbar button or tray icon: how the person got back to Steps, not a step
            // of the task (F007).
            if is_shell_window(&window) && names_steps(record.element.as_ref()) {
                stats.ignored_own += 1;
                continue;
            }
            if let Some(machine) = machine {
                machine
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .note_step_processed(event.id);
            }
            clicked = true;
            if is_shell_window(&window) {
                last_shell_click = Some(Instant::now());
            }
            out.write_navigation(settle.flush(), &mut last_origin);
            drag_from = (event.button == MouseButton::Left)
                .then(|| drag_start(&record, &window))
                .flatten();
            stroke = (event.button == MouseButton::Left)
                .then(|| draw_start(&record, &window))
                .flatten();
            fill_press = None;
            out.write(Record::Click(record), Some(image));
            previous = Some(event);
            // A click on a link changes the address a moment later, not at once.
            next_browser_poll = Instant::now() + Duration::from_millis(400);
        } else {
            stats.missed += 1;
            out.write_capture_failure(&event);
        }
    }
    stats
}

/// The window a click was in, as it was when the button went down (`pressed`), or, when that
/// wasn't read (more than 16 clicks waiting), the one at the point `now`. Read as the click is
/// handled instead, a click on a window's Close button was put down to the window behind it (#48).
/// It keeps what was read of it then, its class too, so a File Explorer window closed since is
/// still no click on the Windows shell (#98).
fn clicked_window(
    pressed: Option<&Pressed>,
    now: impl FnOnce() -> Option<WindowInfo>,
) -> Option<WindowInfo> {
    pressed.map(|pressed| pressed.window.clone()).or_else(now)
}

/// Turns a UIA lookup into the element (if any) and the outcome recorded with the click.
fn lookup_outcome(lookup: Lookup, stats: &mut Stats) -> (Option<ElementFacts>, UiaOutcome) {
    let outcome = |status, ms, retried, error| UiaOutcome {
        status,
        ms,
        retried,
        error,
        pre_read: false,
    };
    match lookup {
        Lookup::Found {
            facts,
            ms,
            retried,
            pre_read,
        } => {
            stats.uia_ms.push(ms);
            if retried {
                stats.uia_retries += 1;
            }
            if pre_read {
                stats.uia_pre_reads += 1;
            }
            (
                Some(facts),
                UiaOutcome {
                    pre_read,
                    ..outcome("ok", ms, retried, None)
                },
            )
        }
        Lookup::Failed { error, ms } => {
            stats.uia_errors += 1;
            (None, outcome("error", ms, false, Some(error)))
        }
        Lookup::TimedOut { ms } => {
            stats.uia_timeouts += 1;
            (None, outcome("timeout", ms, false, None))
        }
    }
}

fn process_click(
    event: &MouseDown,
    window: &WindowInfo,
    press: Option<Press>,
    uia: &UiaClient,
    config: &PipelineConfig,
    machine: Option<&Mutex<RecorderStateMachine>>,
    stats: &mut Stats,
) -> Option<(ClickRecord, RgbaImage)> {
    let queue_delay_ms = now_tick().wrapping_sub(event.tick_ms);
    let (stack, title_bar_button, owner) = press.map_or((None, None, None), |press| {
        let (button, owner) = press.pressed.map_or((None, None), |pressed| {
            (pressed.title_bar_button, pressed.owner)
        });
        (Some(press.stack), button, owner)
    });
    let came_from = owner_title(owner.as_ref());
    let (target, cover) = click_target(window, shown_with(window, owner));

    // UIA first (it's asynchronous), then the screenshot while UIA works. The element under the
    // resting pointer before the click names it when the click landed in it (its pre-read). The
    // window's facts come after: naming its program can read the program's file or a store app's
    // package (#50).
    let lookup_started = Instant::now();
    let unread = unread_under_click(window);
    if unread.is_none() {
        uia.request_click(event.id, event.x, event.y, window.hwnd, event.tick_ms);
    }
    let mut shot = match capture(
        config.mode,
        Some(target.area()),
        event.x,
        event.y,
        config.target_monitor,
    ) {
        Ok(shot) => shot,
        Err(error) => {
            eprintln!("screenshot failed for click {}: {error}", event.id);
            return None;
        }
    };
    stats.screenshot_ms.push(shot.ms);
    // The window clicked can be gone by now: its Close button, or OK on a dialog, closes it as the
    // button comes up. Then the screenshot shows what was behind it at the click, whose words
    // mustn't name the click (F019, #48), and whose other programs, behind the window as the
    // button went down, are greyed as the windows show now.
    let window_gone = crate::screenshot::window_gone(window.hwnd, event.x, event.y);
    crate::screenshot::handle_other_windows(
        &mut shot,
        config.mode,
        &target,
        cover,
        stack,
        window_gone,
    );
    if let Some(machine) = machine {
        let excluded = machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .excluded_apps()
            .to_vec();
        crate::screenshot::hide_excluded(&mut shot, &excluded);
    }

    let (mut element, mut uia_outcome) = if let Some(why) = unread {
        (
            None,
            UiaOutcome {
                status: "skipped",
                ms: 0.0,
                retried: false,
                error: Some(why.into()),
                pre_read: false,
            },
        )
    } else {
        let deadline = lookup_started + config.uia_timeout;
        lookup_outcome(uia.wait(event.id, lookup_started, deadline), stats)
    };
    let remote_input = remote_input_clicked(&mut element, &mut uia_outcome);

    let element_pct = element
        .as_ref()
        .and_then(|facts| facts.bounds)
        .and_then(|bounds| rect_to_pct(&shot.rect, &bounds));
    let (menu_items, menu_showing) = if unread.is_some() || remote_input {
        (Vec::new(), false)
    } else {
        clicked_menu(uia, event, window, &shot.rect)
    };
    stats.clicks += 1;
    stats.queue_delay_ms.push(f64::from(queue_delay_ms));

    let mut record = ClickRecord {
        id: event.id,
        tick_ms: event.tick_ms,
        button: button_name(event.button),
        injected: event.injected,
        x: event.x,
        y: event.y,
        window: WindowFacts {
            owner_title: came_from,
            ..window_facts(window)
        },
        capture: CaptureFacts::of(&shot, config.mode),
        click_pct: point_to_pct(&shot.rect, event.x, event.y),
        element,
        element_pct,
        uia: uia_outcome,
        screenshot_ms: shot.ms,
        queue_delay_ms,
        page: None,
        title_bar_button: title_bar_button.map(title_bar_button_name),
        filter_button: false,
        window_gone,
        menu_items,
        menu_showing,
    };
    record.filter_button = filter_button_pressed(&record, event.button);
    record.window.remote_session |= remote_input;
    Some((record, shot.image))
}

/// The menu a click landed in, as kept when it opened: its items, boxed on the screenshot
/// (`capture`), and whether it still showed under the press. A menu closes with the click on its
/// item, often before the lookup could read it: the items go with the click, for the words on its
/// screenshot to be matched against when the recording opens (#56), or, when the menu still
/// showed, for the item under the click to name it without them (#106).
fn clicked_menu(
    uia: &UiaClient,
    event: &MouseDown,
    window: &WindowInfo,
    capture: &PxRect,
) -> (Vec<crate::facts::MenuItemFacts>, bool) {
    uia.menu_for_click(event.x, event.y, window.hwnd, event.tick_ms)
        .map_or_else(
            || (Vec::new(), false),
            |menu| {
                (
                    crate::facts::MenuItemFacts::on(capture, menu.items),
                    menu.showing,
                )
            },
        )
}

/// Percentile (0–100) of a set of timings, for reports.
#[must_use]
pub fn percentile(values: &[f64], percentile: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "index into a short, non-empty list"
    )]
    let index = ((percentile / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted.get(index.min(sorted.len() - 1)).copied()
}

/// A rectangle helper for callers that only have the window frame.
#[must_use]
pub fn frame_of(window: &WindowInfo) -> PxRect {
    window.frame.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::Cover;
    #[cfg(windows)]
    use crate::screenshot::Shot;

    fn typed(pid: u32, window_pid: u32, window_exe: Option<&str>) -> InputRecord {
        InputRecord {
            id: None,
            window: None,
            capture: None,
            element_pct: None,
            tick_ms: 2000,
            focused_tick_ms: 1000,
            pid,
            window_pid,
            window_exe: window_exe.map(str::to_string),
            element: ElementFacts::default(),
            value: Some("typed".into()),
            withheld: None,
        }
    }

    #[test]
    fn typed_values_from_our_own_windows_are_always_dropped() {
        let own = crate::platform::window::own_process_id();
        assert!(input_is_blocked(None, &typed(own, 0, Some("notepad.exe"))));
        assert!(input_is_blocked(
            None,
            &typed(0, own, Some("amluto-steps.exe"))
        ));
    }

    #[test]
    fn typed_values_are_dropped_when_the_window_in_front_is_excluded() {
        // The field's process (here unreadable) differs from the app the user excluded, as with
        // a web-view host; the window in front names it.
        let machine = Mutex::new(RecorderStateMachine::new(vec!["olk.exe".into()]));
        assert!(input_is_blocked(
            Some(&machine),
            &typed(0, 1, Some("OLK.EXE"))
        ));
        assert!(!input_is_blocked(
            Some(&machine),
            &typed(0, 1, Some("excel.exe"))
        ));
        // Neither app can be named: dropped rather than guessed.
        assert!(input_is_blocked(Some(&machine), &typed(0, 1, None)));
    }

    #[test]
    fn windows_of_excluded_apps_are_recognised_by_exe_name() {
        let machine = Mutex::new(RecorderStateMachine::new(vec!["KeePass.exe".into()]));
        let window = |path: &str| WindowInfo {
            hwnd: 0,
            pid: 1,
            title: "Vault".into(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        assert!(is_excluded_window(
            &machine,
            &window(r"C:\Apps\keepass.exe")
        ));
        assert!(!is_excluded_window(
            &machine,
            &window(r"C:\Apps\chrome.exe")
        ));
        // A program that can't be named counts as excluded while anything is excluded.
        let unnamed = WindowInfo {
            exe_path: None,
            ..window("")
        };
        assert!(is_excluded_window(&machine, &unnamed));
        assert!(!is_excluded_window(
            &Mutex::new(RecorderStateMachine::new(Vec::new())),
            &unnamed
        ));
    }

    /// A program's window, by its process and the path of its program.
    fn program_window(pid: u32, path: &str) -> WindowInfo {
        WindowInfo {
            hwnd: 0,
            pid,
            title: String::new(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    const TEAMS: &str = r"C:\Program Files\WindowsApps\MSTeams\ms-teams.exe";
    const OUTLOOK: &str = r"C:\Program Files\WindowsApps\Microsoft.OutlookForWindows\olk.exe";
    const WEB_VIEW: &str =
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe";

    /// What each test process's program is called, as Windows would say.
    fn program_of(pid: u32) -> Option<String> {
        match pid {
            5 => Some("ms-teams.exe".into()),
            6 => Some("olk.exe".into()),
            9 => Some("msedgewebview2.exe".into()),
            _ => None,
        }
    }

    #[test]
    fn a_click_in_a_pop_up_an_excluded_app_owns_makes_no_step() {
        let machine = Mutex::new(RecorderStateMachine::new(vec!["ms-teams.exe".into()]));
        // Teams' drop-down is drawn by its web view's process, and owned by Teams' window.
        let teams = program_window(5, TEAMS);
        let drop_down = program_window(9, WEB_VIEW);
        assert!(is_excluded_click(
            &machine,
            &drop_down,
            Some(&teams),
            &[5],
            program_of
        ));
        // The same pop-up from an app that isn't excluded is a step, as before.
        let outlook = program_window(6, OUTLOOK);
        assert!(!is_excluded_click(
            &machine,
            &drop_down,
            Some(&outlook),
            &[6],
            program_of
        ));
        // A click in the excluded app's own window is ignored as before, and another app's isn't.
        assert!(is_excluded_click(&machine, &teams, None, &[], program_of));
        assert!(!is_excluded_click(
            &machine,
            &outlook,
            None,
            &[],
            program_of
        ));
    }

    #[test]
    fn a_pop_up_is_an_excluded_apps_whatever_window_of_it_owns_it() {
        let machine = Mutex::new(RecorderStateMachine::new(vec!["ms-teams.exe".into()]));
        let drop_down = program_window(9, WEB_VIEW);
        // The window it came from isn't showing, so #72 found none to show round it, or the press
        // wasn't read: the programs up its owners still say whose it is.
        assert!(is_excluded_click(
            &machine,
            &drop_down,
            None,
            &[9, 5],
            program_of
        ));
        // Nor is an owner that can't be named shown not to be excluded.
        assert!(is_excluded_click(
            &machine,
            &drop_down,
            None,
            &[77],
            program_of
        ));
        assert!(!is_excluded_click(
            &Mutex::new(RecorderStateMachine::new(Vec::new())),
            &drop_down,
            None,
            &[77],
            program_of
        ));
        // Owned only by an app that isn't excluded: a step, as before.
        assert!(!is_excluded_click(
            &machine,
            &drop_down,
            None,
            &[9, 6],
            program_of
        ));
    }

    /// `packages/core/test-vectors/click-naming.json`: the title-bar buttons the naming reads.
    #[test]
    fn title_bar_buttons_are_written_as_the_naming_reads_them() {
        let shared: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/click-naming.json"
        ))
        .unwrap();
        let written: Vec<&str> = [
            TitleBarButton::Close,
            TitleBarButton::Minimise,
            TitleBarButton::Maximise,
            TitleBarButton::Restore,
        ]
        .into_iter()
        .map(title_bar_button_name)
        .collect();
        assert_eq!(shared["titleBarButtons"], serde_json::json!(written));
    }

    fn click_record(title_bar_button: Option<&'static str>, window_gone: bool) -> ClickRecord {
        let rect = PxRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1032,
        };
        ClickRecord {
            id: 13,
            tick_ms: 5_000,
            button: "left",
            injected: false,
            x: 1890,
            y: 12,
            window: WindowFacts {
                title: "Book2 - Excel".into(),
                exe: Some("EXCEL.EXE".into()),
                pid: 4242,
                frame: rect,
                elevation: "notElevated",
                remote_session: false,
                app_name: None,
                hosted_app: None,
                hosted_exe: None,
                owner_title: None,
                shell: false,
            },
            capture: CaptureFacts {
                mode: "window",
                rect,
                monitor: rect,
                scale: 1.0,
                width: 1920,
                height: 1032,
                image: None,
                notifications: Vec::new(),
            },
            click_pct: None,
            element: None,
            element_pct: None,
            uia: UiaOutcome {
                status: "error",
                ms: 2.0,
                retried: false,
                error: None,
                pre_read: false,
            },
            screenshot_ms: 18.0,
            queue_delay_ms: 3,
            page: None,
            title_bar_button,
            filter_button: false,
            window_gone,
            menu_items: Vec::new(),
            menu_showing: false,
        }
    }

    #[test]
    fn a_click_says_its_title_bar_button_and_whether_its_window_had_gone() {
        let json = serde_json::to_value(click_record(Some("close"), true)).unwrap();
        assert_eq!(json["titleBarButton"], "close");
        assert_eq!(json["windowGone"], true);
        // Anywhere else there's no button to say; the journal's schema reads it as absent.
        let json = serde_json::to_value(click_record(None, false)).unwrap();
        assert!(json.get("titleBarButton").is_none(), "{json}");
        assert_eq!(json["windowGone"], false);
    }

    /// `packages/core/src/recording.ts` reads them as `menuItems`, each a name and a box as % of
    /// the screenshot, absent off a menu (#56).
    #[test]
    fn a_click_on_a_menu_carries_its_items_boxed_on_the_screenshot() {
        let capture = PxRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1032,
        };
        let items = vec![
            crate::menus::MenuItem {
                name: "Format Cells…".into(),
                bounds: Some(PxRect {
                    left: 960,
                    top: 516,
                    right: 1152,
                    bottom: 542,
                }),
            },
            crate::menus::MenuItem {
                name: "Link".into(),
                bounds: None,
            },
        ];
        let record = ClickRecord {
            menu_items: crate::facts::MenuItemFacts::on(&capture, items),
            ..click_record(None, false)
        };
        let json = serde_json::to_value(record).unwrap();
        assert_eq!(
            json["menuItems"],
            serde_json::json!([
                { "name": "Format Cells…", "box": { "x": 50.0, "y": 50.0, "w": 10.0, "h": 2.519 } },
                { "name": "Link", "box": null }
            ])
        );
        let json = serde_json::to_value(click_record(None, false)).unwrap();
        assert!(json.get("menuItems").is_none(), "{json}");
    }

    /// `packages/core/src/recording.ts` reads it as `menuShowing`, absent unless the menu the
    /// click's items are from showed under the press, in a window of its own (#106).
    #[test]
    fn a_click_says_whether_its_menu_showed_under_the_press() {
        let record = ClickRecord {
            menu_showing: true,
            ..click_record(None, false)
        };
        assert_eq!(serde_json::to_value(record).unwrap()["menuShowing"], true);
        let json = serde_json::to_value(click_record(None, false)).unwrap();
        assert!(json.get("menuShowing").is_none(), "{json}");
    }

    /// A click in a pop-up keeps the title of the window it came from (#72's owner, read as the
    /// button went down), which names it when nothing else does: `WinUI`'s pop-up host is titled
    /// "Pop-upHost" in en-GB (#106). Not the Windows shell's, whose
    /// windows' titles ("Program Manager") aren't anything on screen.
    #[test]
    fn a_pop_up_keeps_the_title_of_the_window_it_came_from() {
        let window = |title: &str, path: &str| WindowInfo {
            hwnd: 0,
            pid: 7,
            title: title.into(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let paint = window(
            "Untitled - Paint",
            r"C:\Program Files\WindowsApps\mspaint.exe",
        );
        assert_eq!(
            owner_title(Some(&paint)).as_deref(),
            Some("Untitled - Paint")
        );
        assert_eq!(owner_title(None), None);
        let desktop = WindowInfo {
            class: Some("Progman".into()),
            ..window("Program Manager", r"C:\Windows\explorer.exe")
        };
        assert_eq!(owner_title(Some(&desktop)), None);
    }

    #[test]
    fn percentile_picks_nearest_rank() {
        let values = [10.0, 20.0, 30.0, 40.0, 50.0];
        assert_eq!(percentile(&values, 50.0), Some(30.0));
        assert_eq!(percentile(&values, 95.0), Some(50.0));
        assert_eq!(percentile(&[], 95.0), None);
    }

    #[test]
    fn a_click_in_a_pop_up_is_shown_on_the_window_it_came_from() {
        let window = |pid: u32, path: &str, frame: PxRect| WindowInfo {
            hwnd: 0,
            pid,
            title: String::new(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect {
                left: frame.left,
                top: frame.top,
                right: frame.right,
                bottom: frame.bottom,
            },
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let rect = |left, top, right, bottom| PxRect {
            left,
            top,
            right,
            bottom,
        };
        let excel_exe = r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE";
        let excel = window(7, excel_exe, rect(0, 0, 1600, 900));
        let menu = window(7, excel_exe, rect(700, 500, 894, 1063));

        // Excel's right-click menu: the sheet with the menu on top, its other programs' windows
        // over it greyed out.
        let (target, cover) = click_target(&menu, Some(excel.clone()));
        assert_eq!(
            target,
            Target {
                pid: 7,
                frame: rect(700, 500, 894, 1063),
                owner: Some(Owner {
                    pid: 7,
                    frame: rect(0, 0, 1600, 900),
                }),
            }
        );
        assert_eq!(target.area(), rect(0, 0, 1600, 1063));
        assert_eq!(cover, Cover::Others);

        // A pop-up with no window behind it to show is its own screenshot, as before.
        assert_eq!(
            click_target(&menu, None),
            (Target::window(7, rect(700, 500, 894, 1063)), Cover::Others)
        );
        assert_eq!(
            click_target(&excel, None),
            (Target::window(7, rect(0, 0, 1600, 900)), Cover::Others)
        );

        // Nor is it shown on the Windows shell's windows (the taskbar, Search), which other
        // programs' windows lie over but which grey out only toasts.
        let taskbar = WindowInfo {
            class: Some("Shell_TrayWnd".into()),
            ..window(4, r"C:\Windows\explorer.exe", rect(0, 1032, 1920, 1080))
        };
        let jump_list = window(4, r"C:\Windows\explorer.exe", rect(1500, 600, 1800, 1032));
        assert_eq!(
            click_target(&jump_list, Some(taskbar)),
            (
                Target::window(4, rect(1500, 600, 1800, 1032)),
                Cover::NotificationsOnly
            )
        );
        let search = window(
            5,
            r"C:\Windows\SystemApps\SearchHost.exe",
            rect(0, 0, 800, 900),
        );
        assert_eq!(
            click_target(&menu, Some(search)).0,
            Target::window(7, rect(700, 500, 894, 1063))
        );
    }

    fn window_of(pid: u32, path: &str, left: i32, right: i32) -> WindowInfo {
        WindowInfo {
            hwnd: isize::try_from(pid).unwrap(),
            pid,
            title: String::new(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect {
                left,
                top: 0,
                right,
                bottom: 900,
            },
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    const PANEL_EXE: &str =
        r"C:\Windows\SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe";

    #[test]
    fn nothing_under_a_click_in_windows_input_panel_is_read() {
        // Clipboard history's items can be named after the text they hold (#109): no element, no
        // parents, no menu, as for a remote session, whose window shows another computer.
        let panel = window_of(9, PANEL_EXE, 900, 1260);
        assert_eq!(unread_under_click(&panel), Some("input panel"));
        let remote = window_of(3, r"C:\Windows\System32\mstsc.exe", 0, 1600);
        assert_eq!(unread_under_click(&remote), Some("remote session"));
        let notepad = window_of(4, r"C:\Windows\System32\notepad.exe", 0, 1600);
        assert_eq!(unread_under_click(&notepad), None);
    }

    #[test]
    fn nothing_under_a_click_in_the_newly_listed_clients_is_read() {
        // As for Remote Desktop Connection (#116): their windows show another computer.
        for path in [
            r"C:\Program Files\RDCMan\RDCMan.exe",
            r"C:\Program Files\TeamViewer\TeamViewer.exe",
            r"C:\Program Files (x86)\AnyDesk\AnyDesk.exe",
            r"C:\Program Files\Oracle\VirtualBox\VirtualBoxVM.exe",
            r"C:\Program Files\TightVNC\tvnviewer.exe",
        ] {
            let window = window_of(3, path, 0, 1600);
            assert_eq!(
                unread_under_click(&window),
                Some("remote session"),
                "{path}"
            );
        }
        // The store's Remote Desktop app, shown in ApplicationFrameHost's frame.
        let store = WindowInfo {
            hosted_exe: Some("RdClient.Windows.exe".into()),
            ..window_of(5, r"C:\Windows\System32\ApplicationFrameHost.exe", 0, 1600)
        };
        assert_eq!(unread_under_click(&store), Some("remote session"));
    }

    #[test]
    fn a_click_on_the_remote_desktop_control_in_any_program_names_nothing() {
        // The lookup in a program not on the list found the Remote Desktop control's input window
        // (#116): the click is a remote session's, named by its window alone, as in Remote Desktop
        // Connection's.
        let found = |class: &str| ElementFacts {
            control_type: "Pane".into(),
            name: "Input Capture Window".into(),
            class_name: class.into(),
            ..ElementFacts::default()
        };
        let outcome = || UiaOutcome {
            status: "ok",
            ms: 12.0,
            retried: false,
            error: None,
            pre_read: true,
        };
        let mut element = Some(found("IHWindowClass"));
        let mut uia = outcome();
        assert!(remote_input_clicked(&mut element, &mut uia));
        assert_eq!(element, None);
        assert_eq!(uia.status, "skipped");
        assert_eq!(uia.error.as_deref(), Some("remote session"));
        assert!(!uia.pre_read);
        let mut element = Some(found("WindowsForms10.SysTreeView32.app.0.1"));
        let mut uia = outcome();
        assert!(!remote_input_clicked(&mut element, &mut uia));
        assert!(element.is_some());
        assert_eq!(uia.status, "ok");
        assert!(!remote_input_clicked(&mut None, &mut outcome()));
    }

    /// The emoji panel as Windows 11 shows it (build 26300, 12/10/2026): the window under the
    /// pointer is a frame of `explorer.exe`'s, untitled, round the text input host's core window.
    fn framed_panel() -> WindowInfo {
        WindowInfo {
            hwnd: 0x0005_0a2c,
            pid: 6120,
            title: String::new(),
            exe_path: Some(r"C:\Windows\explorer.exe".into()),
            frame: crate::platform::Rect {
                left: 228,
                top: 313,
                right: 588,
                bottom: 713,
            },
            elevation: Elevation::NotElevated,
            hosted_exe: Some("TextInputHost.exe".into()),
            class: None,
        }
    }

    #[test]
    fn the_input_panel_is_known_in_the_frame_windows_shows_it_in() {
        let panel = framed_panel();
        assert!(is_input_panel(&panel));
        assert_eq!(unread_under_click(&panel), Some("input panel"));
        // The step says which program the frame shows, for the naming to know it.
        assert_eq!(
            window_facts(&panel).hosted_exe.as_deref(),
            Some("TextInputHost.exe")
        );
        // Shown on Notepad in front, as a top-level panel is.
        let notepad = window_of(4, r"C:\Windows\System32\notepad.exe", 0, 1600);
        assert_eq!(
            input_panel_owner(&panel, || Some(notepad.clone()), |_| None),
            Some(notepad)
        );
        // A File Explorer window in front is another window of the frame's program: shown too.
        let explorer = WindowInfo {
            hwnd: 0x0007_0001,
            ..window_of(6120, r"C:\Windows\explorer.exe", 0, 1600)
        };
        assert_eq!(
            input_panel_owner(&panel, || Some(explorer.clone()), |_| None),
            Some(explorer)
        );
        // The panel's own frame in front, or the text input host's window (it can be, even
        // hidden: build 26300, 12/10/2026): the front-most app window behind it, not the frame's
        // program's, else the panel alone.
        let host = WindowInfo {
            hwnd: 0x0002_05dc,
            title: "Windows Input Experience".into(),
            ..window_of(9, PANEL_EXE, 0, 2560)
        };
        for front in [framed_panel(), host] {
            let mut asked = None;
            assert_eq!(
                input_panel_owner(
                    &panel,
                    || Some(front.clone()),
                    |except| {
                        asked = Some(except);
                        Some(window_of(4, r"C:\Windows\System32\notepad.exe", 0, 1600))
                    }
                )
                .map(|owner| owner.pid),
                Some(4)
            );
            assert_eq!(asked, Some(panel.pid));
            assert_eq!(input_panel_owner(&panel, || Some(front), |_| None), None);
        }
        // A store app's frame is read as before.
        let calculator = WindowInfo {
            exe_path: Some(r"C:\Windows\System32\ApplicationFrameHost.exe".into()),
            hosted_exe: Some("CalculatorApp.exe".into()),
            ..framed_panel()
        };
        assert!(!is_input_panel(&calculator));
        assert_eq!(unread_under_click(&calculator), None);
    }

    /// The check on a real desktop (#109): open clipboard history (Win+V) or the emoji panel
    /// (Win+.) over Notepad and move the pointer over it. Prints, when anything changes, the
    /// input panels' frames (greyed in every screenshot), the window under the pointer and
    /// whether a click there would be taken as one in the input panel, and the window in front,
    /// which a click in the panel is shown on. Nothing under the pointer is read.
    #[cfg(windows)]
    #[test]
    #[ignore = "watches the input panel: cargo test -p capture input_panel_probe -- --ignored --nocapture"]
    fn input_panel_probe() {
        use std::time::{Duration, Instant};
        let describe = |window: Option<WindowInfo>| {
            window.map(|window| {
                format!(
                    "{:?} (showing {:?}) {:?} {:?}{}",
                    window.exe_name(),
                    window.hosted_exe,
                    window.title,
                    window.frame,
                    if is_input_panel(&window) {
                        " (the input panel)"
                    } else {
                        ""
                    }
                )
            })
        };
        let until = Instant::now() + Duration::from_secs(30);
        let mut last = String::new();
        while Instant::now() < until {
            let under =
                crate::platform::display::cursor_pos().and_then(|(x, y)| root_window_at(x, y));
            let line = format!(
                "panels {:?}\n  under the pointer {:?}\n  in front {:?}",
                crate::dictation::text_input_panels(),
                describe(under),
                describe(crate::platform::window::foreground_window()),
            );
            if line != last {
                println!("{line}");
                last = line;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// The check on a real desktop (#109): start it, then within 30 seconds open the emoji panel
    /// (Win+.) or clipboard history (Win+V) over Notepad and leave it open. A click at the panel's
    /// middle is screenshotted as the recorder does it, in window mode and monitor mode, and the
    /// panel must be greyed in both; the windows Steps reads must see it as the input panel.
    /// Nothing is clicked and no picture is kept.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs the emoji panel or clipboard history open: cargo test -p capture a_live_input_panel -- --ignored --nocapture"]
    fn a_live_input_panel_is_greyed_in_window_and_monitor_mode() {
        use crate::screenshot::handle_other_windows;
        use std::time::{Duration, Instant};
        const GREY: [u8; 4] = [208, 213, 221, 255];

        let until = Instant::now() + Duration::from_secs(30);
        let panel = loop {
            if let Some(frame) = crate::dictation::text_input_panels().first() {
                break PxRect::from(*frame);
            }
            assert!(
                Instant::now() < until,
                "no input panel among the windows showing in 30 seconds"
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        // Let it finish appearing.
        std::thread::sleep(Duration::from_millis(700));
        let (x, y) = (
            panel.left + panel.width() / 2,
            panel.top + panel.height() / 2,
        );
        let window = root_window_at(x, y).expect("a window at the panel's middle");
        println!(
            "panel {panel:?}; under its middle {:?} (showing {:?}) {:?}",
            window.exe_name(),
            window.hosted_exe,
            window.frame
        );
        assert!(
            is_input_panel(&window),
            "the window there is the input panel"
        );
        assert_eq!(unread_under_click(&window), Some("input panel"));

        // As a click there is screenshotted: the windows read as the button goes down, then the
        // picture of what it's shown on.
        let (target, cover) = click_target(&window, shown_with(&window, None));
        let at = |shot: &Shot| {
            let pixel_x = u32::try_from(x - shot.rect.left).unwrap();
            let pixel_y = u32::try_from(y - shot.rect.top).unwrap();
            shot.image.get_pixel(pixel_x, pixel_y).0
        };
        for mode in [CaptureMode::Window, CaptureMode::Monitor] {
            let stack = crate::platform::window::shown_windows();
            let mut shot = capture(mode, Some(target.area()), x, y, None).unwrap();
            let greyed = handle_other_windows(&mut shot, mode, &target, cover, Some(stack), false);
            let grey = shot.image.pixels().filter(|pixel| pixel.0 == GREY).count();
            println!(
                "{mode:?}: shot {:?}, {greyed} areas greyed, {grey} of {} pixels grey",
                shot.rect,
                shot.image.pixels().count()
            );
            assert_eq!(at(&shot), GREY, "{mode:?}: the panel's middle is greyed");
            if mode == CaptureMode::Monitor {
                assert!(
                    grey < shot.image.pixels().count(),
                    "the rest of the monitor shows"
                );
            }
        }
    }

    #[test]
    fn a_click_in_the_input_panel_is_shown_on_the_window_in_front() {
        // The panel puts what's picked into the window in front: the screenshot shows it, with
        // the panel (greyed) on top, as a pop-up shows the window it came from (#72).
        let panel = window_of(9, PANEL_EXE, 900, 1260);
        let notepad = window_of(4, r"C:\Windows\System32\notepad.exe", 0, 1600);
        let served = input_panel_owner(&panel, || Some(notepad.clone()), |_| None);
        assert_eq!(served, Some(notepad.clone()));
        let (target, cover) = click_target(&panel, served);
        assert_eq!(
            target.area(),
            PxRect {
                left: 0,
                top: 0,
                right: 1600,
                bottom: 900
            }
        );
        assert_eq!(cover, Cover::Others);

        // The panel itself in front, or one of Steps' own windows: the panel alone.
        assert_eq!(
            input_panel_owner(&panel, || Some(panel.clone()), |_| None),
            None
        );
        let own = WindowInfo {
            pid: crate::platform::window::own_process_id(),
            ..notepad.clone()
        };
        assert_eq!(input_panel_owner(&panel, || Some(own), |_| None), None);
        assert_eq!(input_panel_owner(&panel, || None, |_| None), None);
        // Any other window keeps its own screenshot: the window in front isn't even asked.
        assert_eq!(
            input_panel_owner(
                &notepad,
                || panic!("only asked for the input panel"),
                |_| panic!("only asked for the input panel")
            ),
            None
        );
    }

    /// A press as the input thread records it as the button goes down (#48): the window under
    /// the pointer, class and all, and its title-bar button there.
    fn recorded_press(window: WindowInfo, title_bar_button: Option<TitleBarButton>) -> Press {
        Press {
            stack: Vec::new(),
            pressed: Some(Pressed {
                window,
                title_bar_button,
                owner: None,
                owners: Vec::new(),
            }),
        }
    }

    /// A window of the program at `path` with the class it had as the button went down, whose
    /// handle names no window by the time the click is handled.
    fn gone_window(pid: u32, path: &str, class: &str) -> WindowInfo {
        WindowInfo {
            hwnd: 0,
            class: Some(class.into()),
            ..window_of(pid, path, 0, 1600)
        }
    }

    #[test]
    fn a_file_explorer_window_gone_by_the_clicks_handling_is_no_shell_click() {
        // Its Close button closed it as the button came up (#98): by the time the click is
        // handled, only the press knows the window was File Explorer's, not the desktop's.
        let press = recorded_press(
            gone_window(6120, r"C:\Windows\explorer.exe", "CabinetWClass"),
            Some(TitleBarButton::Close),
        );
        let window = clicked_window(press.pressed.as_ref(), || panic!("the press was read"))
            .expect("the window pressed");
        // The app the next "Open" step is for wasn't opened by a click on the taskbar or Start.
        assert!(!is_shell_window(&window));
        // Other programs' windows over it are greyed, not only toasts, and its step isn't one in
        // Windows itself.
        assert_eq!(click_target(&window, None).1, Cover::Others);
        assert!(!window_facts(&window).shell);
    }

    #[test]
    fn clicks_on_the_taskbar_start_and_the_desktop_are_still_shell_clicks() {
        let explorer = r"C:\Windows\explorer.exe";
        for window in [
            gone_window(6120, explorer, "Shell_TrayWnd"),
            gone_window(6120, explorer, "Shell_SecondaryTrayWnd"),
            gone_window(6120, explorer, "Progman"),
            gone_window(6120, explorer, "WorkerW"),
            gone_window(
                7310,
                r"C:\Windows\SystemApps\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\StartMenuExperienceHost.exe",
                "Windows.UI.Core.CoreWindow",
            ),
            gone_window(
                7420,
                r"C:\Windows\SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\SearchHost.exe",
                "Windows.UI.Core.CoreWindow",
            ),
        ] {
            let press = recorded_press(window, None);
            let window = clicked_window(press.pressed.as_ref(), || panic!("the press was read"))
                .expect("the window pressed");
            assert!(is_shell_window(&window), "{:?}", window.class);
            assert_eq!(click_target(&window, None).1, Cover::NotificationsOnly);
            assert!(window_facts(&window).shell);
        }
    }

    #[test]
    fn a_click_whose_press_wasnt_read_is_put_down_to_the_window_there_now() {
        // More than 16 clicks waiting: the window at the point as the click is handled.
        let notepad = window_of(4, r"C:\Windows\System32\notepad.exe", 0, 1600);
        assert_eq!(
            clicked_window(None, || Some(notepad.clone())),
            Some(notepad)
        );
        assert_eq!(clicked_window(None, || None), None);
    }
}
