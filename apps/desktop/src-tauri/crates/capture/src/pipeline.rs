//! The worker that turns queued button-downs into records
//! (docs/spec/02-capture.md#recording-state-machine).
//!
//! Per click: filter (own windows), screenshot first, UIA lookup in parallel with a deadline,
//! then one record keyed by the event id. Loss is always visible: queue overflow becomes a
//! `Missed` record, and silent input sources put the recorder in `Degraded`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::platform::display::{
    cursor_pos, double_click_settings, input_desktop_is_default, last_input_tick, now_tick,
};
use crate::platform::input::{InputShared, InputSource, MouseButton, MouseDown, registration};
use crate::platform::window::{
    Elevation, WindowInfo, foreground_window, own_process_id, root_window_at, window_info,
};
use image::RgbaImage;

use crate::coords::{PxRect, point_to_pct, rect_to_pct};
use crate::facts::{
    AppSwitchRecord, CaptureFacts, ClickRecord, ElementFacts, InputRecord, NavigationRecord,
    Record, UiaOutcome, WindowFacts,
};
use crate::navigation::{NavigationSettle, PendingNavigation, SETTLING_POLL, TYPED_WITHIN};
use crate::screenshot::{CaptureMode, capture};
use crate::state_machine::{PauseReason, RecorderState, RecorderStateMachine};
use crate::typing::{ClickNews, KeyedRecord};
use crate::uia::{Lookup, UiaClient};

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
            // Room for Chrome's second look (`uia::CHROME_SETTLE`), which can take ~200 ms.
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
    pub screenshot_ms: Vec<f64>,
    pub uia_ms: Vec<f64>,
    pub queue_delay_ms: Vec<f64>,
}

const REMOTE_CLIENTS: &[&str] = &[
    "mstsc.exe",
    "msrdc.exe",
    "wfica32.exe",
    "cdviewer.exe",
    "vmconnect.exe",
    // Linux: Remmina, FreeRDP, TigerVNC, virt-viewer and Citrix Workspace.
    "remmina",
    "xfreerdp",
    "xfreerdp3",
    "sdl-freerdp",
    "vncviewer",
    "xtigervncviewer",
    "remote-viewer",
    "virt-viewer",
    "wfica",
];

fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// Whether a window belongs to an app the user excluded from recording. A window whose program
/// can't be named (its process refused the query) can't be shown not to be excluded, so while
/// anything is excluded it is treated as excluded.
pub fn is_excluded_window(machine: &Mutex<RecorderStateMachine>, window: &WindowInfo) -> bool {
    let machine = machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    window.exe_name().map_or_else(
        || !machine.excluded_apps().is_empty(),
        |name| machine.is_app_excluded(name),
    )
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

/// Chrome and Edge: `chrome.exe` and `msedge.exe` on Windows, `chrome`, `chromium` and `msedge`
/// on Linux.
/// Browsers whose address bar is read for "Go to" steps: Chrome, Edge and the browsers built on
/// Chromium with its address bar, and Firefox (04/10/2026).
fn is_browser(exe_name: Option<&str>) -> bool {
    exe_name.is_some_and(|name| {
        [
            "chrome.exe",
            "msedge.exe",
            "chromium.exe",
            "brave.exe",
            "opera.exe",
            "vivaldi.exe",
            "firefox.exe",
            "chrome",
            "chromium",
            "chromium-browser",
            "msedge",
            "brave",
            "brave-browser",
            "opera",
            "vivaldi-bin",
            "firefox",
            "firefox-bin",
        ]
        .iter()
        .any(|browser| name.eq_ignore_ascii_case(browser))
    })
}

fn elevation_name(elevation: Elevation) -> &'static str {
    match elevation {
        Elevation::NotElevated => "notElevated",
        Elevation::Elevated => "elevated",
        Elevation::Unknown => "unknown",
    }
}

/// How long after the recording starts the window in front is taken as where it began, not a
/// switch: the main window minimises then, and Windows brings another forward.
const START_SETTLE: Duration = Duration::from_millis(2000);
/// How long after a click on the taskbar or Start the app that comes forward is the one it
/// opened (a large app can take a few seconds to show its window).
const SHELL_OPENS: Duration = Duration::from_millis(5000);

/// Windows' own surfaces that aren't apps: going to one isn't an "Open" step.
const SHELL_HOSTS: &[&str] = &[
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "shellexperiencehost.exe",
    "shellhost.exe",
    "textinputhost.exe",
    "lockapp.exe",
];

/// Any copy of Steps (the installed one, the Store's or a portable one: every Steps program is
/// `amluto-steps…exe`), not only this process: before 1.0.0 two could run at once (F007).
fn is_steps_window(window: &WindowInfo) -> bool {
    window
        .exe_name()
        .is_some_and(|name| name.to_ascii_lowercase().starts_with("amluto-steps"))
}

/// A taskbar button or tray icon for Steps: its name is "Steps", or starts "Steps - " or
/// "Steps by Amluto" (the running-windows count Windows adds follows).
fn names_steps(element: Option<&ElementFacts>) -> bool {
    element.is_some_and(|element| {
        let name = element.name.trim();
        name == "Steps"
            || name.starts_with("Steps - ")
            || name.starts_with("Steps by Amluto")
            || name.starts_with("Steps, ")
    })
}

/// A window's screenshot for a step without a click (a field as focus arrives in it, a page once its
/// address settles), with excluded apps hidden, as a click's would be. Not while the recording
/// isn't taking steps.
fn shoot_field(
    window: &WindowInfo,
    config: &PipelineConfig,
    machine: Option<&Mutex<RecorderStateMachine>>,
) -> Option<crate::screenshot::Shot> {
    let excluded = match machine {
        Some(machine) => {
            let machine = machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !machine.is_active() || !machine.takes_clicks() {
                return None;
            }
            machine.excluded_apps().to_vec()
        }
        None => Vec::new(),
    };
    if window
        .exe_name()
        .is_some_and(|name| excluded.iter().any(|app| app.eq_ignore_ascii_case(name)))
    {
        return None;
    }
    let frame = PxRect::from(window.frame);
    let mut shot = capture(
        config.mode,
        Some(frame),
        frame.left + (frame.right - frame.left) / 2,
        frame.top + (frame.bottom - frame.top) / 2,
        config.target_monitor,
    )
    .ok()?;
    if config.mode == CaptureMode::Window {
        // The Start menu, Search and the like are drawn by several shell processes:
        // their own parts aren't someone else's window to grey out (04/10/2026).
        if !is_shell_window(window) {
            crate::screenshot::hide_covering(&mut shot, window.pid, None);
        }
    }
    crate::screenshot::hide_excluded(&mut shot, &excluded);
    Some(shot)
}

/// How long after an app comes forward its "Open" step's screenshot is taken: time to draw.
const SWITCH_SHOT_AFTER: Duration = Duration::from_millis(450);

/// Writes an "Open" step with a screenshot of the app as it is now: with excluded apps blacked
/// out, as every other screenshot is, and not at all if the recording has stopped taking steps
/// since (the person went on to an excluded app, or paused, in the moment before the shot).
fn write_switch(
    (_, mut record, window): (Instant, AppSwitchRecord, WindowInfo),
    config: &PipelineConfig,
    machine: Option<&Mutex<RecorderStateMachine>>,
    sink: &mut dyn Sink,
) {
    let excluded = match machine {
        Some(machine) => {
            let machine = machine
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if !machine.is_active() || !machine.takes_clicks() {
                return;
            }
            machine.excluded_apps().to_vec()
        }
        None => Vec::new(),
    };
    let frame = PxRect::from(window.frame);
    let shot = capture(
        config.mode,
        Some(frame),
        frame.left + (frame.right - frame.left) / 2,
        frame.top + (frame.bottom - frame.top) / 2,
        config.target_monitor,
    )
    .ok()
    .map(|mut shot| {
        if config.mode == CaptureMode::Window {
            // The Start menu, Search and the like are drawn by several shell processes:
            // their own parts aren't someone else's window to grey out (04/10/2026).
            if !is_shell_window(&window) {
                crate::screenshot::hide_covering(&mut shot, window.pid, None);
            }
        }
        crate::screenshot::hide_excluded(&mut shot, &excluded);
        shot
    });
    record.capture = shot.as_ref().map(|shot| CaptureFacts {
        mode: config.mode.as_str(),
        rect: shot.rect,
        monitor: shot.monitor,
        scale: shot.scale,
        width: shot.image.width(),
        height: shot.image.height(),
        image: None,
    });
    sink.write(Record::AppSwitch(record), shot.map(|shot| shot.image));
}

/// The taskbar, Start, search, the desktop and the like. Explorer also draws File Explorer
/// windows (`CabinetWClass`), which are a place a guide goes, so only its other windows count.
pub(crate) fn is_shell_window(window: &WindowInfo) -> bool {
    match window.exe_name().map(str::to_ascii_lowercase).as_deref() {
        Some("explorer.exe") => crate::platform::window::window_class(window.hwnd)
            .is_none_or(|class| class != "CabinetWClass"),
        Some(name) => SHELL_HOSTS.contains(&name),
        None => false,
    }
}

/// A program's own name, read once per program (it's in the file, which doesn't change).
fn app_name(window: &WindowInfo) -> Option<String> {
    static NAMES: std::sync::OnceLock<Mutex<HashMap<String, Option<String>>>> =
        std::sync::OnceLock::new();
    let path = window.exe_path.as_ref()?;
    let mut names = NAMES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    names
        .entry(path.clone())
        .or_insert_with(|| {
            // Windows 11's Notepad describes itself as "Notepad.exe": the name, not the file (F004).
            crate::platform::window::program_description(path).map(|name| {
                match std::path::Path::new(&name).extension() {
                    Some(extension) if extension.eq_ignore_ascii_case("exe") => {
                        name[..name.len() - 4].to_string()
                    }
                    _ => name,
                }
            })
        })
        .clone()
}

/// Whether a program is a remote-desktop client, whose window shows another computer: no
/// element names can be read inside it.
#[must_use]
pub fn is_remote_client(exe_name: &str) -> bool {
    REMOTE_CLIENTS.contains(&exe_name.to_ascii_lowercase().as_str())
}

pub(crate) fn window_facts(window: &WindowInfo) -> WindowFacts {
    let exe = window.exe_name().map(str::to_string);
    let remote_session = exe.as_deref().is_some_and(is_remote_client);
    WindowFacts {
        title: window.title.clone(),
        exe,
        pid: window.pid,
        frame: window.frame.into(),
        elevation: elevation_name(window.elevation),
        remote_session,
        app_name: app_name(window),
        shell: is_shell_window(window),
    }
}

fn write_capture_failure(
    sink: &mut dyn Sink,
    machine: Option<&Mutex<RecorderStateMachine>>,
    event: &MouseDown,
) {
    let (missed, state) = if let Some(machine) = machine {
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
    sink.write(missed, None);
    sink.write(state, None);
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

/// Ids for the pictures of "Go to" steps (`nav-<id>.webp`), unique within a run.
static NEXT_NAVIGATION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Writes a browser address that has settled as a "Go to" step, unless it's where the browser
/// already was, or it wasn't typed or picked in the address bar: a link followed on a page, a
/// redirect, back and forward, or the page the recording started on are left to the clicks
/// (04/10/2026). With a screenshot of the page it went to.
fn write_navigation(
    pending: Option<PendingNavigation<WindowInfo>>,
    last_origin: &mut Option<(u32, String)>,
    machine: Option<&Mutex<RecorderStateMachine>>,
    config: &PipelineConfig,
    sink: &mut dyn Sink,
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
    if let Some(machine) = machine {
        machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .note_auxiliary_step();
    }
    *last_origin = Some(key);
    // The page it went to, now its address has settled (or just before the next step on it).
    let shot = shoot_field(&navigation.window, config, machine);
    let capture = shot.as_ref().map(|shot| CaptureFacts {
        mode: config.mode.as_str(),
        rect: shot.rect,
        monitor: shot.monitor,
        scale: shot.scale,
        width: shot.image.width(),
        height: shot.image.height(),
        image: None,
    });
    sink.write(
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
    // The screenshot of the field that has focus, taken as it arrived, and the next one's id.
    let mut field_shot: Option<(u32, crate::screenshot::Shot, WindowInfo)> = None;
    let mut next_field_id: u64 = 0;
    // When a browser's address bar was last seen with the keyboard, by process.
    let mut bar_focused: Option<(u32, Instant)> = None;
    let mut settle: NavigationSettle<WindowInfo> = NavigationSettle::default();
    let mut pending_switch: Option<(Instant, AppSwitchRecord, WindowInfo)> = None;
    // The program in front before the waiting "Open" step's.
    let mut pending_from: Option<(u32, String)> = None;

    loop {
        if let Some(machine) = machine {
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
                    let key = (window.pid, String::new());
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
                        app_switch = (!back).then(|| {
                            (
                                AppSwitchRecord {
                                    id: u64::from(change.tick_ms),
                                    tick_ms: change.tick_ms,
                                    window: window_facts(&window),
                                    capture: None,
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
                    write_navigation(
                        settle.flush(),
                        &mut last_origin,
                        Some(machine),
                        config,
                        sink,
                    );
                    // Written once the app has had a moment to draw, with its screenshot; an
                    // earlier one still waiting goes first.
                    if let Some(earlier) = pending_switch.take() {
                        write_switch(earlier, config, Some(machine), sink);
                    }
                    pending_switch = Some((Instant::now() + SWITCH_SHOT_AFTER, record, window));
                }
                if changed {
                    shared.enabled.store(takes_clicks, Ordering::SeqCst);
                    sink.write(
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
                    sink.write(record, None);
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
                        write_navigation(earlier, &mut last_origin, Some(machine), config, sink);
                    }
                }
            }
            write_navigation(
                settle.due(Instant::now()),
                &mut last_origin,
                Some(machine),
                config,
                sink,
            );

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

        if let Some(start) = drag_from.take_if(|start| {
            shared.last_left_up().is_some_and(|(tick, _, _)| {
                tick.wrapping_sub(start.tick_ms) < 1 << 31 && tick != start.tick_ms
            }) || start.at.elapsed() > DRAG_GIVE_UP
        }) && let Some(up) = shared.last_left_up()
        {
            write_drag(start, up, uia, config, machine, sink);
        }

        // An editable field gained focus: its screenshot now, before anything is typed, for the
        // typing step its value makes when focus leaves (04/10/2026).
        if let Some(entered) = uia.take_field_entered() {
            field_shot = shoot_field(&entered.window, config, machine)
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
                write_navigation(settle.flush(), &mut last_origin, machine, config, sink);
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
                        record.capture = Some(CaptureFacts {
                            mode: config.mode.as_str(),
                            rect: shot.rect,
                            monitor: shot.monitor,
                            scale: shot.scale,
                            width: shot.image.width(),
                            height: shot.image.height(),
                            image: None,
                        });
                        shot.image
                    });
                sink.write(Record::Input(record), image);
            }
        }

        if let (Some(keys), Some(machine)) = (keys, machine) {
            write_key_records_after(&keys.records, machine, sink, |sink| {
                write_navigation(
                    settle.flush(),
                    &mut last_origin,
                    Some(machine),
                    config,
                    sink,
                );
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
            sink.write(missed, None);
            if machine.is_some_and(|state| {
                matches!(
                    state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .state(),
                    RecorderState::Degraded { .. }
                )
            }) {
                sink.write(
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
                    sink.write(
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
                sink.write(change, None);
            }
        }

        if pending_switch
            .as_ref()
            .is_some_and(|(due, _, _)| Instant::now() >= *due)
            && let Some(switch) = pending_switch.take()
        {
            write_switch(switch, config, machine, sink);
        }
        let Some(event) = shared.pop() else {
            if stop.load(Ordering::Relaxed) {
                if let Some(switch) = pending_switch.take() {
                    write_switch(switch, config, machine, sink);
                }
                // An address read before Stop still counts, settled or not.
                write_navigation(settle.flush(), &mut last_origin, machine, config, sink);
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
                sink.write(
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
            sink.write(
                Record::Double {
                    of: before.id,
                    tick_ms: event.tick_ms,
                },
                None,
            );
            previous = None; // a third press starts a new click
            continue;
        }
        // Only a press that became a step can start a double-click: if this one is ignored or
        // fails, the next press is a click of its own.
        previous = None;

        if let Some(switch) = pending_switch.take() {
            write_switch(switch, config, machine, sink);
        }
        let Some(window) = root_window_at(event.x, event.y) else {
            stats.missed += 1;
            write_capture_failure(sink, machine, &event);
            continue;
        };
        // A popup of our own windows (a WebView2 drop-down or menu) can belong to a web-view
        // process, not ours, so its owner is checked too.
        if window.pid == own_pid
            || crate::platform::window::owner_process_at(event.x, event.y) == Some(own_pid)
            || is_steps_window(&window)
        {
            stats.ignored_own += 1;
            continue;
        }
        // Checked per click, before any screenshot or UIA read: the auto-pause only follows the
        // foreground change, which arrives after the first click into an excluded app. It is also
        // what keeps clicks out while paused for one (`should_process_click`).
        if machine.is_some_and(|state| is_excluded_window(state, &window)) {
            stats.ignored_excluded += 1;
            continue;
        }

        if let Some(keys) = keys {
            keys.clicks.note(event.tick_ms);
        }
        if let Some((record, image)) = process_click(
            &event,
            &window,
            shared.take_stack(event.id),
            uia,
            config,
            machine,
            &mut stats,
        ) {
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
            write_navigation(settle.flush(), &mut last_origin, machine, config, sink);
            drag_from = (event.button == MouseButton::Left)
                .then(|| {
                    let cell = record.element.as_ref().and_then(crate::typing::cell_name)?;
                    Some(DragStart {
                        of: record.id,
                        tick_ms: event.tick_ms,
                        x: event.x,
                        y: event.y,
                        cell,
                        bounds: record.element.as_ref().and_then(|facts| facts.bounds),
                        window: window.clone(),
                        at: Instant::now(),
                    })
                })
                .flatten();
            sink.write(Record::Click(record), Some(image));
            previous = Some(event);
            // A click on a link changes the address a moment later, not at once.
            next_browser_poll = Instant::now() + Duration::from_millis(400);
        } else {
            stats.missed += 1;
            write_capture_failure(sink, machine, &event);
        }
    }
    stats
}

/// A left click on a cell, waiting to see whether it becomes a drag.
struct DragStart {
    of: u64,
    tick_ms: u32,
    x: i32,
    y: i32,
    cell: String,
    bounds: Option<PxRect>,
    window: WindowInfo,
    at: Instant,
}

/// How far the pointer must move between press and release to be a drag, in physical pixels.
const DRAG_MIN_PX: i32 = 8;
/// A release this long after the press, or never seen, ends the wait.
const DRAG_GIVE_UP: Duration = Duration::from_secs(30);
/// Ids for drag lookups and pictures, away from click ids.
static NEXT_DRAG_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 48);

/// The button came up: if it moved to another cell, the cells between were selected. The cell
/// under the release is looked up, and the window's screenshot shows the selection.
fn write_drag(
    start: DragStart,
    (tick_ms, x, y): (u32, i32, i32),
    uia: &UiaClient,
    config: &PipelineConfig,
    machine: Option<&Mutex<RecorderStateMachine>>,
    sink: &mut dyn Sink,
) {
    if (x - start.x).abs() < DRAG_MIN_PX && (y - start.y).abs() < DRAG_MIN_PX {
        return;
    }
    let id = NEXT_DRAG_ID.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    uia.request(id, x, y, start.window.hwnd);
    let mut ignored = Stats::default();
    let (element, _) = lookup_outcome(
        uia.wait(id, started, started + Duration::from_millis(300)),
        &mut ignored,
    );
    let Some(to) = element.as_ref().and_then(crate::typing::cell_name) else {
        return;
    };
    if to == start.cell {
        return;
    }
    let shot = shoot_field(&start.window, config, machine);
    let selection = match (
        start.bounds,
        element.as_ref().and_then(|facts| facts.bounds),
    ) {
        (Some(from), Some(to)) => Some(PxRect {
            left: from.left.min(to.left),
            top: from.top.min(to.top),
            right: from.right.max(to.right),
            bottom: from.bottom.max(to.bottom),
        }),
        _ => None,
    };
    let capture = shot.as_ref().map(|shot| CaptureFacts {
        mode: config.mode.as_str(),
        rect: shot.rect,
        monitor: shot.monitor,
        scale: shot.scale,
        width: shot.image.width(),
        height: shot.image.height(),
        image: None,
    });
    let selection_pct = shot
        .as_ref()
        .zip(selection)
        .and_then(|(shot, area)| rect_to_pct(&shot.rect, &area));
    sink.write(
        Record::Drag(crate::facts::DragRecord {
            id,
            of: start.of,
            tick_ms,
            from: start.cell,
            to,
            window: window_facts(&start.window),
            capture,
            selection_pct,
        }),
        shot.map(|shot| shot.image),
    );
}

/// Turns a UIA lookup into the element (if any) and the outcome recorded with the click.
fn lookup_outcome(lookup: Lookup, stats: &mut Stats) -> (Option<ElementFacts>, UiaOutcome) {
    let outcome = |status, ms, retried, error| UiaOutcome {
        status,
        ms,
        retried,
        error,
    };
    match lookup {
        Lookup::Found { facts, ms, retried } => {
            stats.uia_ms.push(ms);
            if retried {
                stats.uia_retries += 1;
            }
            (Some(facts), outcome("ok", ms, retried, None))
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
    stack: Option<Vec<crate::platform::window::ShownWindow>>,
    uia: &UiaClient,
    config: &PipelineConfig,
    machine: Option<&Mutex<RecorderStateMachine>>,
    stats: &mut Stats,
) -> Option<(ClickRecord, RgbaImage)> {
    let queue_delay_ms = now_tick().wrapping_sub(event.tick_ms);
    let facts_window = window_facts(window);

    // UIA first (it's asynchronous), then the screenshot while UIA works.
    let lookup_started = Instant::now();
    let skip_uia = facts_window.remote_session;
    if !skip_uia {
        uia.request(event.id, event.x, event.y, window.hwnd);
    }
    let mut shot = match capture(
        config.mode,
        Some(window.frame.into()),
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
    if config.mode == CaptureMode::Window {
        // The Start menu, Search and the like are drawn by several shell processes:
        // their own parts aren't someone else's window to grey out (04/10/2026).
        if !is_shell_window(window) {
            crate::screenshot::hide_covering(&mut shot, window.pid, stack);
        }
    }
    if let Some(machine) = machine {
        let excluded = machine
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .excluded_apps()
            .to_vec();
        crate::screenshot::hide_excluded(&mut shot, &excluded);
    }

    let (element, uia_outcome) = if skip_uia {
        (
            None,
            UiaOutcome {
                status: "skipped",
                ms: 0.0,
                retried: false,
                error: Some("remote session".into()),
            },
        )
    } else {
        let deadline = lookup_started + config.uia_timeout;
        lookup_outcome(uia.wait(event.id, lookup_started, deadline), stats)
    };

    let element_pct = element
        .as_ref()
        .and_then(|facts| facts.bounds)
        .and_then(|bounds| rect_to_pct(&shot.rect, &bounds));
    stats.clicks += 1;
    stats.queue_delay_ms.push(f64::from(queue_delay_ms));

    let record = ClickRecord {
        id: event.id,
        tick_ms: event.tick_ms,
        button: button_name(event.button),
        injected: event.injected,
        x: event.x,
        y: event.y,
        window: facts_window,
        capture: CaptureFacts {
            mode: config.mode.as_str(),
            rect: shot.rect,
            monitor: shot.monitor,
            scale: shot.scale,
            width: shot.image.width(),
            height: shot.image.height(),
            image: None,
        },
        click_pct: point_to_pct(&shot.rect, event.x, event.y),
        element,
        element_pct,
        uia: uia_outcome,
        screenshot_ms: shot.ms,
        queue_delay_ms,
        page: None,
    };
    Some((record, shot.image))
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
    fn any_copy_of_steps_and_its_taskbar_button_are_never_recorded() {
        let window = |path: &str| WindowInfo {
            hwnd: 0,
            pid: 7,
            title: "Steps".into(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
        };
        assert!(is_steps_window(&window(
            r"C:\Users\Sam\Downloads\amluto-steps-1.0.0-x64-portable.exe"
        )));
        assert!(is_steps_window(&window(
            r"C:\Users\Sam\AppData\Local\Steps\amluto-steps.exe"
        )));
        assert!(!is_steps_window(&window(r"C:\Windows\notepad.exe")));
        let named = |name: &str| ElementFacts {
            name: name.into(),
            ..ElementFacts::default()
        };
        assert!(names_steps(Some(&named("Steps - 1 running window"))));
        assert!(names_steps(Some(&named("Steps"))));
        assert!(!names_steps(Some(&named("Steps Recorder"))));
        assert!(!names_steps(Some(&named("Notepad - 1 running window"))));
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

    #[test]
    fn percentile_picks_nearest_rank() {
        let values = [10.0, 20.0, 30.0, 40.0, 50.0];
        assert_eq!(percentile(&values, 50.0), Some(30.0));
        assert_eq!(percentile(&values, 95.0), Some(50.0));
        assert_eq!(percentile(&[], 95.0), None);
    }

    #[test]
    fn remote_desktop_clients_are_flagged() {
        let window = WindowInfo {
            hwnd: 0,
            pid: 1,
            title: "Remote".into(),
            exe_path: Some(r"C:\Windows\System32\mstsc.exe".into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
        };
        assert!(window_facts(&window).remote_session);
    }
}
