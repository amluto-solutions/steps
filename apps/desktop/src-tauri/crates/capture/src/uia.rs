//! UI Automation on its own thread (docs/spec/02-capture.md#on-each-click). What happens to the
//! element it finds, and how the pipeline waits for it, is shared with Linux (`lookup.rs`).
//!
//! Browser address-bar reads run on a second thread (`uia/address_bar.rs`), so a slow tree search
//! in a browser window never delays the next click's lookup, and the element under a resting
//! pointer is read on a third (`pre_read.rs`), so a click never waits behind that read either. A
//! menu's items are read as it opens, on UI Automation's event thread (`menus.rs`). How the
//! element at a point is read and checked is `uia/element_at.rs`.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use uiautomation::core::UICacheRequest;
use uiautomation::events::{
    CustomEventHandlerFn, CustomFocusChangedEventHandlerFn, UIEventHandler, UIEventType,
    UIFocusChangedEventHandler,
};
use uiautomation::patterns::UIValuePattern;
use uiautomation::types::{ControlType, Handle, Point, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use crate::platform::window::WindowInfo;

use crate::coords::PxRect;
use crate::facts::{ElementFacts, InputRecord};
use crate::lookup::{
    Answer, LookupError, PacketsAtFocus, Replies, Reply, StartError, await_worker_ready,
    fingerprint, is_editable, reading_blocked, typed_before_focus, value_before_typing,
    value_on_leave,
};
pub use crate::lookup::{FocusOptions, Lookup};
use crate::menus::{self, ClickedMenu, Look, MenuItem, MenuSource, OpenMenu, OpenMenus};
use crate::navigation::BarRead;
use crate::pre_read::{self, ClickAt, PreReads, Under};
use crate::sensitive::looks_sensitive;
use crate::state_machine::RecorderStateMachine;

mod address_bar;
mod element_at;

use address_bar::{is_address_bar, origin_worker};
use element_at::{element_at, px_rect};

enum Request {
    At {
        id: u64,
        x: i32,
        y: i32,
        hwnd: isize,
        /// For a click, when its button went down (input clock): a pre-read may name it.
        pressed: Option<u32>,
    },
    Stop,
}

enum OriginRequest {
    Read { id: u64, hwnd: isize },
    Stop,
}

struct OriginReply {
    id: u64,
    read: BarRead,
}

/// Handle to the UIA worker thread.
pub struct UiaClient {
    requests: Sender<Request>,
    replies: Replies,
    origin_requests: Sender<OriginRequest>,
    origin_replies: Receiver<OriginReply>,
    cancelled: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    origin_thread: Option<JoinHandle<()>>,
    entered: crate::lookup::FieldSlot,
    /// Tells the pre-read thread to stop. It isn't waited for: a read stuck in an app that has
    /// stopped responding mustn't hold up the end of a recording.
    pre_read_stop: Arc<AtomicBool>,
    /// The menus read as they opened, while recording (#56).
    menus: Arc<OpenMenus>,
    /// Watches for XAML's pop-up hosts showing while recording, for their menus to be read
    /// (#106). Dropping it ends the watch, and with it the thread reading their menus.
    pop_ups: Option<crate::platform::pop_ups::PopUpHosts>,
}

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

impl UiaClient {
    /// Starts the worker. If `focus` is given (a recording), field values are reported through it
    /// on focus-leave, the element under a resting pointer is read before each click
    /// (`pre_read.rs`), and a menu's items as it opens (`menus.rs`), in the windows its recording
    /// records clicks in.
    ///
    /// # Errors
    /// If the worker thread can't be started, COM or UI Automation can't be initialised on it, or
    /// it isn't ready within five seconds.
    pub fn start(focus: Option<(Sender<InputRecord>, FocusOptions)>) -> Result<Self, StartError> {
        let entered = focus
            .as_ref()
            .map_or_else(crate::lookup::FieldSlot::default, |(_, options)| {
                Arc::clone(&options.entered)
            });
        let (request_tx, request_rx) = mpsc::channel();
        let (reply_tx, reply_rx) = mpsc::channel();
        let (origin_request_tx, origin_request_rx) = mpsc::channel();
        let (origin_tx, origin_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let pre_reads = Arc::new(PreReads::default());
        let worker_pre_reads = Arc::clone(&pre_reads);
        let menus = Arc::new(OpenMenus::default());
        let worker_menus = Arc::clone(&menus);
        let recording = focus.as_ref().map(|(_, options)| options.machine.clone());
        let thread = std::thread::Builder::new()
            .name("amluto-uia".into())
            .spawn(move || {
                worker(
                    &request_rx,
                    &reply_tx,
                    focus,
                    &ready_tx,
                    &worker_cancelled,
                    &worker_pre_reads,
                    worker_menus,
                );
            })?;
        await_worker_ready(&ready_rx, &cancelled, STARTUP_TIMEOUT, "UI Automation")?;
        let pre_read_stop = Arc::new(AtomicBool::new(false));
        let mut pop_ups = None;
        if let Some(machine) = recording {
            let stop = Arc::clone(&pre_read_stop);
            let pre_read_machine = machine.clone();
            // Without it, every click is read after it, as before the pre-read (#92).
            let _ = std::thread::Builder::new()
                .name("amluto-uia-pre-read".into())
                .spawn(move || pre_read_worker(pre_read_machine, &pre_reads, &stop));
            pop_ups = watch_pop_up_menus(&menus, machine, &pre_read_stop);
        }
        // Without it, navigation steps are simply not recorded; clicks still are.
        let origin_thread = std::thread::Builder::new()
            .name("amluto-uia-origin".into())
            .spawn(move || origin_worker(&origin_request_rx, &origin_tx))
            .ok();
        Ok(Self {
            entered,
            requests: request_tx,
            replies: Replies { receiver: reply_rx },
            origin_requests: origin_request_tx,
            origin_replies: origin_rx,
            cancelled,
            thread: Some(thread),
            origin_thread,
            pre_read_stop,
            menus,
            pop_ups,
        })
    }

    /// Asks for the element at a physical point in the top-level window `hwnd`, read now: for
    /// anything but a click (a drag's end, the test driver). Returns immediately.
    pub fn request(&self, id: u64, x: i32, y: i32, hwnd: isize) {
        let _ = self.requests.send(Request::At {
            id,
            x,
            y,
            hwnd,
            pressed: None,
        });
    }

    /// Asks for the element a click names, at a physical point in `hwnd`, the top-level window
    /// under it as the button went down at `pressed` (input clock): its pre-read when one fits
    /// (`pre_read::names_click`), else what's there now. Returns immediately.
    pub fn request_click(&self, id: u64, x: i32, y: i32, hwnd: isize, pressed: u32) {
        let _ = self.requests.send(Request::At {
            id,
            x,
            y,
            hwnd,
            pressed: Some(pressed),
        });
    }

    /// The open menu a click landed in, at a physical point in `hwnd`, the top-level window under
    /// it as the button went down at `pressed` (input clock): its items as UI Automation read
    /// them when the menu opened, and whether it still showed then (`OpenMenus::for_click`).
    /// `None` off a menu, and outside a recording.
    #[must_use]
    pub fn menu_for_click(&self, x: i32, y: i32, hwnd: isize, pressed: u32) -> Option<ClickedMenu> {
        self.menus.for_click(x, y, hwnd, pressed)
    }

    /// Requests the current address-bar origin from a known Chrome or Edge top-level window.
    /// The latest editable field to gain focus since this was last asked (04/10/2026).
    #[must_use]
    pub fn take_field_entered(&self) -> Option<crate::lookup::FieldEntered> {
        self.entered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    pub fn request_browser_origin(&self, id: u64, hwnd: isize) {
        let _ = self.origin_requests.send(OriginRequest::Read { id, hwnd });
    }

    /// Returns a completed result for this navigation query without waiting on UI Automation.
    #[must_use]
    pub fn take_browser_origin(&self, id: u64) -> Option<BarRead> {
        while let Ok(reply) = self.origin_replies.try_recv() {
            if reply.id == id {
                return Some(reply.read);
            }
        }
        None
    }

    /// Waits for the reply to `id` until `deadline`, discarding replies for older clicks (see
    /// `lookup::Replies::wait`).
    #[must_use]
    pub fn wait(&self, id: u64, started: Instant, deadline: Instant) -> Lookup {
        self.replies
            .wait(id, started, deadline, "UIA worker stopped")
    }
}

impl Drop for UiaClient {
    fn drop(&mut self) {
        self.pre_read_stop.store(true, Ordering::SeqCst);
        // Ends the watch; the thread reading pop-ups' menus ends with it, and isn't waited for.
        self.pop_ups = None;
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.requests.send(Request::Stop);
        let _ = self.origin_requests.send(OriginRequest::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.origin_thread.take() {
            let _ = thread.join();
        }
    }
}

fn worker(
    requests: &Receiver<Request>,
    replies: &Sender<Reply>,
    focus: Option<(Sender<InputRecord>, FocusOptions)>,
    ready: &Sender<Result<(), StartError>>,
    cancelled: &Arc<AtomicBool>,
    pre_reads: &PreReads,
    menus: Arc<OpenMenus>,
) {
    let automation = match UIAutomation::new() {
        Ok(automation) => automation,
        Err(error) => {
            let _ = ready.send(Err(StartError::Unavailable(error.to_string())));
            return;
        }
    };
    let cache = match element_cache(&automation) {
        Ok(cache) => cache,
        Err(error) => {
            let _ = ready.send(Err(StartError::CacheRequest(error.to_string())));
            return;
        }
    };

    if cancelled.load(Ordering::SeqCst) {
        return;
    }
    // Only while recording, menus are read as they open (#56) and tooltips' windows noted as they
    // open (#105). If listening fails, a click on a menu item that closed before it could be read
    // keeps the words on its screenshot, unmatched, and a click through XAML's tooltip is taken
    // for one in it.
    let events: Vec<(UIEventType, UIElement, UIEventHandler)> = focus
        .as_ref()
        .map(|(_, options)| {
            let machine = options.machine.clone();
            let menu = register_menu_handler(&automation, menus, machine, Arc::clone(cancelled))
                .map(|(root, handler)| (UIEventType::MenuOpened, root, handler));
            let tooltip = register_tooltip_handler(&automation, Arc::clone(cancelled))
                .map(|(root, handler)| (UIEventType::ToolTipOpened, root, handler));
            menu.into_iter().chain(tooltip).collect()
        })
        .unwrap_or_default();
    let focus_handler = focus.and_then(|(sender, options)| {
        register_focus_handler(&automation, &cache, sender, options, Arc::clone(cancelled))
    });
    let remove_handlers = || {
        if let Some(handler) = &focus_handler {
            let _ = automation.remove_focus_changed_event_handler(handler);
        }
        for (event, root, handler) in &events {
            let _ = automation.remove_automation_event_handler(*event, root, handler);
        }
    };
    if cancelled.load(Ordering::SeqCst) {
        remove_handlers();
        return;
    }
    let _ = ready.send(Ok(()));

    while let Ok(request) = requests.recv() {
        match request {
            Request::At {
                id,
                x,
                y,
                hwnd,
                pressed,
            } => {
                let started = Instant::now();
                // A click that closed its own window (OK on a dialog) can be read only after the
                // window has gone, when the point shows what was behind it: Steps named a
                // spreadsheet cell instead of OK (F019). Unnamed is better than wrong. `hwnd` is
                // the window under the pointer as the button went down: read when the click was
                // handled, it was already the window behind a quickly clicked X, so this never
                // caught one (#48).
                let still_there = || {
                    crate::platform::window::root_window_at(x, y).map(|window| window.hwnd)
                        == Some(hwnd)
                };
                let read_now = || {
                    if !still_there() {
                        return Err(LookupError::WindowClosed);
                    }
                    let found = element_at(&automation, &cache, x, y)?;
                    if still_there() {
                        Ok(found)
                    } else {
                        Err(LookupError::WindowClosed)
                    }
                };
                // A pre-read was made in this very window before the click, so it names the click
                // even when the click has closed the window since: never the window behind.
                let result = match pressed {
                    Some(pressed) => pre_read::element_for_click(
                        pre_reads,
                        &ClickAt {
                            x,
                            y,
                            window: hwnd,
                            pressed,
                        },
                        read_now,
                    ),
                    None => read_now().map(|(facts, retried)| Answer {
                        facts,
                        retried,
                        pre_read: false,
                    }),
                };
                let _ = replies.send(Reply {
                    id,
                    result,
                    elapsed: started.elapsed(),
                });
            }
            Request::Stop => break,
        }
    }

    remove_handlers();
}

/// What a lookup reads of an element in one call (`element_cache`), for `facts_from_cached`.
const CACHED_PROPERTIES: &[UIProperty] = &[
    UIProperty::ControlType,
    UIProperty::LocalizedControlType,
    UIProperty::Name,
    UIProperty::AutomationId,
    UIProperty::HelpText,
    UIProperty::AriaRole,
    UIProperty::AriaProperties,
    UIProperty::ClassName,
    UIProperty::FrameworkId,
    UIProperty::IsPassword,
    UIProperty::BoundingRectangle,
    UIProperty::LabeledBy,
    UIProperty::ProcessId,
];

/// Whether one of an element's parents is a password box, as a click's lookup marks a part of one
/// (`lookup::parents_marked`): the key worker's check of the element with focus (#97 fourth
/// review). `cache` is [`element_cache`]'s.
pub(crate) fn in_password_box(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    element: &UIElement,
) -> bool {
    element_at::parents_of(automation, cache, element).in_password
}

pub(crate) fn element_cache(automation: &UIAutomation) -> uiautomation::Result<UICacheRequest> {
    let cache = automation.create_cache_request()?;
    for property in CACHED_PROPERTIES {
        cache.add_property(*property)?;
    }
    cache.set_tree_scope(TreeScope::Element)?;
    Ok(cache)
}

fn cached_string(element: &UIElement, property: UIProperty) -> String {
    element
        .get_cached_property_value(property)
        .ok()
        .and_then(|value| value.get_string().ok())
        .unwrap_or_default()
}

pub(crate) fn facts_from_cached(element: &UIElement, extra_terms: &[String]) -> ElementFacts {
    let control_type = element
        .get_cached_control_type()
        .map(|control| format!("{control:?}"))
        .unwrap_or_default();
    let is_password = element
        .get_cached_property_value(UIProperty::IsPassword)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok())
        .unwrap_or(false);
    let bounds = element
        .get_cached_bounding_rectangle()
        .ok()
        .map(|rect| px_rect(&rect));
    let labeled_by = element
        .get_cached_labeled_by()
        .ok()
        .and_then(|label| label.get_name().ok())
        .filter(|name| !name.is_empty());

    let mut facts = ElementFacts {
        control_type,
        localized_control_type: element
            .get_cached_localized_control_type()
            .unwrap_or_default(),
        name: element.get_cached_name().unwrap_or_default(),
        automation_id: element.get_cached_automation_id().unwrap_or_default(),
        help_text: element.get_cached_help_text().unwrap_or_default(),
        aria_role: cached_string(element, UIProperty::AriaRole),
        aria_properties: cached_string(element, UIProperty::AriaProperties),
        class_name: element.get_cached_classname().unwrap_or_default(),
        framework_id: element.get_cached_framework_id().unwrap_or_default(),
        is_password,
        labeled_by,
        bounds,
        ancestors: Vec::new(),
        sensitive: false,
        filter_header: None,
        document_class: None,
    };
    facts.sensitive = is_password
        || looks_sensitive(
            &[
                &facts.name,
                &facts.automation_id,
                &facts.help_text,
                facts.labeled_by.as_deref().unwrap_or(""),
            ],
            extra_terms,
        );
    facts
}

/// Chrome (and Edge, Brave, Opera, Vivaldi) answers a hit test at once from what it already has:
/// the element its previous hit test found, when the point is inside that one's bounds, or else a
/// guess from the boxes in its tree that knows nothing of what's on top. It asks the page for the
/// real answer in the background. So a click got the previous click's button, the whole page, or
/// a tile under an open drop-down list (a hosting control panel, 05/10/2026). Asking after the
/// click is no cure: pages change as the button goes down, and the answer was the loading screen
/// the click brought up (the overlay test page, 06/10/2026). So the element is read before the
/// click, as in every app since #92 (`pre_read.rs`), but a Chromium window is asked twice (the
/// first question starts Chrome's real hit test, the second gets its answer), and a click is named
/// from the answer only on that very pixel.
fn is_chromium(exe_name: Option<&str>) -> bool {
    exe_name.is_some_and(|name| {
        [
            "chrome.exe",
            "msedge.exe",
            "chromium.exe",
            "brave.exe",
            "opera.exe",
            "vivaldi.exe",
        ]
        .iter()
        .any(|browser| name.eq_ignore_ascii_case(browser))
    })
}

/// The pre-reads' own UI Automation, on their thread, and the recording whose clicks they name.
struct UiaDesk {
    automation: UIAutomation,
    cache: UICacheRequest,
    machine: Option<Arc<Mutex<RecorderStateMachine>>>,
}

impl pre_read::Desk for UiaDesk {
    fn pointer(&self) -> Option<(i32, i32)> {
        crate::platform::display::cursor_pos()
    }

    fn last_input(&self) -> Option<u32> {
        crate::platform::display::last_input_tick()
    }

    fn mouse_moves(&self) -> Option<u64> {
        crate::platform::input::mouse_moves()
    }

    fn now(&self) -> u32 {
        crate::platform::display::now_tick()
    }

    fn under(&self, x: i32, y: i32) -> Option<Under> {
        let window = crate::platform::window::root_window_at(x, y)?;
        let owners = crate::platform::window::owner_processes_at(x, y);
        Some(Under {
            window: window.hwnd,
            chromium: is_chromium(window.exe_name()),
            allowed: pre_read::may_read(
                &window,
                &owners,
                self.machine.as_deref(),
                crate::platform::window::process_exe_name,
            ),
            tooltip: crate::platform::window::tooltip_at(x, y),
        })
    }

    fn ask(&mut self, x: i32, y: i32) {
        let _ = self.automation.element_from_point(Point::new(x, y));
    }

    fn read(&mut self, x: i32, y: i32) -> Result<ElementFacts, LookupError> {
        element_at(&self.automation, &self.cache, x, y).map(|(facts, _)| facts)
    }
}

/// Starts reading the menus of XAML's pop-up hosts as they show (#106), into `menus`, until the
/// returned watch is dropped or `stop` is set. Without it, a `WinUI` menu's click is named from its
/// screenshot's words alone, or by the window it came from.
fn watch_pop_up_menus(
    menus: &Arc<OpenMenus>,
    machine: Option<Arc<Mutex<RecorderStateMachine>>>,
    stop: &Arc<AtomicBool>,
) -> Option<crate::platform::pop_ups::PopUpHosts> {
    let (shown_tx, shown_rx) = mpsc::channel();
    let watch = crate::platform::pop_ups::PopUpHosts::watch(shown_tx).ok()?;
    let menus = Arc::clone(menus);
    let stop = Arc::clone(stop);
    std::thread::Builder::new()
        .name("amluto-uia-pop-ups".into())
        .spawn(move || pop_up_menu_worker(&shown_rx, &menus, machine.as_deref(), &stop))
        .ok()?;
    Some(watch)
}

/// Reads the element under a resting pointer before each click, until `stop` is set.
fn pre_read_worker(
    machine: Option<Arc<Mutex<RecorderStateMachine>>>,
    reads: &PreReads,
    stop: &AtomicBool,
) {
    let Ok(automation) = UIAutomation::new() else {
        return;
    };
    let Ok(cache) = element_cache(&automation) else {
        return;
    };
    pre_read::run(
        &mut UiaDesk {
            automation,
            cache,
            machine,
        },
        reads,
        stop,
    );
}

// ---------- focus-leave field values ----------

/// The field that currently has focus, remembered until focus moves on.
struct Focused {
    element: UIElement,
    facts: ElementFacts,
    initial: Option<String>,
    /// Without "Record what's typed": a fingerprint of the value when focus arrived, so a field
    /// left unchanged makes no step. The value itself is never kept.
    fingerprint: Option<u64>,
    /// An editable field whose value may be reported when focus leaves it.
    editable: bool,
    pid: u32,
    /// When focus arrived, so a pause while the field had focus can drop what was typed.
    since_tick_ms: u32,
    /// Unicode packets seen as focus arrived: a value another program typed is never kept (#91).
    packets: PacketsAtFocus,
    /// The top-level window in front when focus arrived: exclusions are named by it.
    window_pid: u32,
    window_exe: Option<String>,
    window: Option<WindowInfo>,
}

fn read_value(element: &UIElement) -> Option<String> {
    element
        .get_pattern::<UIValuePattern>()
        .ok()
        .and_then(|pattern| pattern.get_value().ok())
}

/// Focus moved: report the field it left (if its value changed), then remember the new one.
fn on_focus_changed(
    automation: &UIAutomation,
    element: &UIElement,
    state: &Mutex<Option<Focused>>,
    sender: &Sender<InputRecord>,
    options: &FocusOptions,
) {
    let Ok(mut current) = state.lock() else {
        return;
    };

    if let Some(previous) = current.take()
        && previous.editable
    {
        let tick_ms = crate::platform::display::now_tick();
        let (value, withheld) = if previous.facts.sensitive {
            let withheld = if previous.facts.is_password {
                "password"
            } else {
                "sensitive"
            };
            (None, Some(withheld))
        } else if !options.record_values {
            // Chrome's address bar and search boxes gain and lose focus several times a visit:
            // only a changed value (or one that can't be compared) is a typing step.
            let unchanged = previous.fingerprint.is_some_and(|before| {
                read_value(&previous.element).as_deref().map(fingerprint) == Some(before)
            });
            if unchanged {
                (None, None)
            } else {
                (None, Some("setting-off"))
            }
        } else {
            let packets = previous
                .packets
                .typed_since(crate::platform::input::unicode_packets());
            value_on_leave(
                read_value(&previous.element),
                previous.initial.as_ref(),
                packets,
            )
        };
        let record = InputRecord {
            tick_ms,
            focused_tick_ms: previous.since_tick_ms,
            pid: previous.pid,
            window_pid: previous.window_pid,
            window_exe: previous.window_exe,
            element: previous.facts,
            value,
            withheld,
            id: None,
            window: None,
            capture: None,
            element_pct: None,
        };
        // With keys recorded, a field that can't be read (Excel's cell editor, some web editors) is
        // covered by the key worker's typing step, so it makes no "Type in …" step of its own.
        let covered_by_keys = options.note.is_some() && record.withheld == Some("unreadable");
        if (record.value.is_some() || record.withheld.is_some()) && !covered_by_keys {
            let _ = sender.send(record);
        }
    }

    let focused = remember(automation, element, options);
    if focused.editable {
        crate::lookup::note_entered(
            &options.entered,
            focused.since_tick_ms,
            focused.window.as_ref(),
        );
    }
    *current = Some(focused);
}

/// The newly focused element. Sensitive fields are never read, not even here, and neither are
/// fields in our own windows, excluded apps, or while the recording isn't running.
fn remember(automation: &UIAutomation, element: &UIElement, options: &FocusOptions) -> Focused {
    let mut facts = facts_from_cached(element, &options.extra_sensitive_terms);
    let pid = element
        .get_cached_process_id()
        .ok()
        .and_then(|pid| u32::try_from(pid).ok())
        .unwrap_or(0);
    let window = crate::platform::window::foreground_window();
    // A window titled for a password ("Set Password"): its boxes are kept out even when they don't
    // say they're one (F021). The keys were already; now the value read when focus leaves is too.
    if window.as_ref().is_some_and(|window| {
        crate::sensitive::looks_sensitive(&[window.title.as_str()], &options.extra_sensitive_terms)
    }) {
        facts.sensitive = true;
    }
    let blocked = reading_blocked(options, pid, window.as_ref());
    // A code editor's editing surface can look like a field, but holds a slice of the file: what's
    // typed there is recorded from the keys instead (docs/spec/02-capture.md#keys).
    let code_editor = window
        .as_ref()
        .and_then(WindowInfo::exe_name)
        .is_some_and(crate::programs::is_code_editor);
    // The address bar is never read here: leaving it makes no typing step.
    let address_bar = is_address_bar(automation, element, &facts);
    // Nor, with keys recorded, is Excel's Name Box: the key worker says what was typed there
    // (`Go to cell "D11"`, #69). Read as focus left it, it showed the cell selected since, typed
    // there or not, and the step said that was typed in it.
    let name_box = || {
        options.note.is_some()
            && window.as_ref().is_some_and(|window| {
                crate::excel::is_name_box(
                    crate::platform::window::window_class(window.hwnd).as_deref(),
                    crate::platform::window::keyboard_focus(window.hwnd).as_ref(),
                    window.hwnd,
                )
            })
    };
    let editable = !blocked && !code_editor && !address_bar && is_editable(&facts) && !name_box();
    // Read even without "Record what's typed", but then only to fingerprint it (below).
    let readable = editable && !facts.sensitive;
    let value_now = if readable { read_value(element) } else { None };
    if let Some(note) = &options.note {
        let mut note = note
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        note.focus_now(crate::typing::FocusUpdate {
            window: window.as_ref().map_or(0, |window| window.hwnd),
            facts: facts.clone(),
            // Keys typed here make no step: the value is read when focus leaves, or, in the
            // address bar, the "Go to" step says where it went.
            field: value_now.is_some() || address_bar,
            address_bar,
            tick_ms: crate::platform::display::now_tick(),
            // Which program the element is in: keys are put down to it only when that's the
            // window they went to (10/10/2026).
            pid,
        });
    }
    // Keys typed straight after the click that moved focus here may be in the value already
    // (#97): then it isn't what the field held before, and the value as focus leaves is the
    // step's, never taken as unchanged.
    let typed_first = typed_before_focus(
        crate::platform::display::now_tick(),
        crate::platform::input::typed_after_press(),
        facts.bounds,
        window.as_ref().map(|window| window.hwnd),
        |x, y| crate::platform::window::root_window_at(x, y).map(|window| window.hwnd),
    );
    let value_now = value_before_typing(value_now, typed_first);
    let fingerprint = if options.record_values {
        None
    } else {
        value_now.as_deref().map(fingerprint)
    };
    let since_tick_ms = crate::platform::display::now_tick();
    let initial = if options.record_values {
        value_now
    } else {
        None
    };
    Focused {
        element: element.clone(),
        facts,
        initial,
        fingerprint,
        editable,
        pid,
        since_tick_ms,
        packets: PacketsAtFocus::at(since_tick_ms, crate::platform::input::unicode_packets()),
        window_pid: window.as_ref().map_or(0, |window| window.pid),
        window_exe: window
            .as_ref()
            .and_then(WindowInfo::exe_name)
            .map(str::to_string),
        window,
    }
}

fn register_focus_handler(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    sender: Sender<InputRecord>,
    options: FocusOptions,
    cancelled: Arc<AtomicBool>,
) -> Option<UIFocusChangedEventHandler> {
    let state: Mutex<Option<Focused>> = Mutex::new(None);
    let walker_source = automation.clone();

    let handler: Box<CustomFocusChangedEventHandlerFn> =
        Box::new(move |sender_element: &UIElement| {
            if cancelled.load(Ordering::SeqCst) {
                return Ok(());
            }
            // UI Automation calls this from a COM callback: a panic must never unwind into it.
            // A panic skips this one focus change; the next one starts afresh.
            let _ = catch_unwind(AssertUnwindSafe(|| {
                on_focus_changed(&walker_source, sender_element, &state, &sender, &options);
            }));
            Ok(())
        });

    let handler = UIFocusChangedEventHandler::from(handler);
    automation
        .add_focus_changed_event_handler(Some(cache), &handler)
        .ok()?;
    Some(handler)
}

// ---------- menus as they open (#56, #106) ----------

/// What reading a menu asks UI Automation for: of the menu, and of each of its items.
struct MenuCaches {
    menu: UICacheRequest,
    items: UICacheRequest,
}

impl MenuCaches {
    fn new(automation: &UIAutomation) -> Option<Self> {
        let menu = automation.create_cache_request().ok()?;
        for property in [
            UIProperty::ControlType,
            UIProperty::BoundingRectangle,
            UIProperty::ProcessId,
            UIProperty::NativeWindowHandle,
        ] {
            menu.add_property(property).ok()?;
        }
        let items = automation.create_cache_request().ok()?;
        for property in [UIProperty::Name, UIProperty::BoundingRectangle] {
            items.add_property(property).ok()?;
        }
        Some(Self { menu, items })
    }
}

/// Listens for menus opening anywhere on the desktop, keeping each one's items in `menus`
/// (`read_menu`). Returns the element it listens on and the handler, to remove them at the end.
/// Menus open a few times a minute at most, and each is read in one call.
fn register_menu_handler(
    automation: &UIAutomation,
    menus: Arc<OpenMenus>,
    machine: Option<Arc<Mutex<RecorderStateMachine>>>,
    cancelled: Arc<AtomicBool>,
) -> Option<(UIElement, UIEventHandler)> {
    let root = automation.get_root_element().ok()?;
    let caches = MenuCaches::new(automation)?;
    let menu_cache = caches.menu.clone();
    let source = automation.clone();
    let handler: Box<CustomEventHandlerFn> = Box::new(move |menu: &UIElement, _| {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        // UI Automation calls this from a COM callback: a panic must never unwind into it. A
        // panic loses this menu's items; its click is named from its screenshot's words alone.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if let Some(opened) = read_menu(&source, &caches, menu, machine.as_deref()) {
                menus.opened(opened);
            }
        }));
        Ok(())
    });
    let handler = UIEventHandler::from(handler);
    automation
        .add_automation_event_handler(
            UIEventType::MenuOpened,
            &root,
            TreeScope::Subtree,
            Some(&menu_cache),
            &handler,
        )
        .ok()?;
    Some((root, handler))
}

// ---------- tooltips as they open (#105) ----------

/// Listens for tooltips opening anywhere on the desktop, noting the window each one shows in, so
/// a click through it goes to the window under it (`capture-win32`'s `tooltip.rs`). XAML draws
/// its tooltips in pop-up windows as it draws its menus (File Explorer's toolbar), so only UI
/// Automation says which holds a tooltip. Returns the element it listens on and the handler, to
/// remove them at the end. Each tooltip is one event with its facts cached: no further calls.
fn register_tooltip_handler(
    automation: &UIAutomation,
    cancelled: Arc<AtomicBool>,
) -> Option<(UIElement, UIEventHandler)> {
    let root = automation.get_root_element().ok()?;
    let cache = automation.create_cache_request().ok()?;
    for property in [
        UIProperty::ControlType,
        UIProperty::BoundingRectangle,
        UIProperty::ProcessId,
    ] {
        cache.add_property(property).ok()?;
    }
    let handler: Box<CustomEventHandlerFn> = Box::new(move |tooltip: &UIElement, _| {
        if cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        // UI Automation calls this from a COM callback: a panic must never unwind into it. A
        // panic loses this tooltip's window; a click through it is taken for one in it.
        let _ = catch_unwind(AssertUnwindSafe(|| note_tooltip(tooltip)));
        Ok(())
    });
    let handler = UIEventHandler::from(handler);
    automation
        .add_automation_event_handler(
            UIEventType::ToolTipOpened,
            &root,
            TreeScope::Subtree,
            Some(&cache),
            &handler,
        )
        .ok()?;
    Some((root, handler))
}

/// Notes the window a tooltip that just opened shows in: the top-level window at its middle,
/// when that is an owned pop-up of the tooltip's own program. Whether it was noted. Anything an
/// app says is a tooltip opening that isn't one is left alone.
fn note_tooltip(tooltip: &UIElement) -> Option<bool> {
    if tooltip.get_cached_control_type().ok()? != ControlType::ToolTip {
        return None;
    }
    let bounds = px_rect(&tooltip.get_cached_bounding_rectangle().ok()?);
    if bounds.is_empty() {
        return None;
    }
    let pid = u32::try_from(tooltip.get_cached_process_id().ok()?).ok()?;
    Some(crate::platform::window::tooltip_opened(
        bounds.left + bounds.width() / 2,
        bounds.top + bounds.height() / 2,
        pid,
    ))
}

/// How many parents up a menu its window is looked for: a XAML menu sits a few levels inside the
/// window it's drawn in.
const HOST_DEPTH: usize = 8;

/// The top-level window a menu is drawn in, by the nearest element up from it that is a window
/// of its own (UI Automation's raw view). Asked of the menu itself, not of what's at its middle:
/// XAML can say a menu opened before its window shows (#106), when what's there is the app's own
/// window.
fn host_window(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    menu: &UIElement,
) -> Option<WindowInfo> {
    let walker = automation.get_raw_view_walker().ok()?;
    let mut element = menu.clone();
    for _ in 0..HOST_DEPTH {
        let handle: isize = element
            .get_cached_native_window_handle()
            .map_or(0, Into::into);
        if handle != 0 {
            return crate::platform::window::window_info(handle);
        }
        element = walker.get_parent_build_cache(&element, cache).ok()?;
    }
    None
}

/// A menu that just opened, with its items, when a click on it would be recorded (`menu_in`).
/// `None` for what an app says is a menu opening but isn't one, and for one not yet placed on the
/// screen.
fn read_menu(
    automation: &UIAutomation,
    caches: &MenuCaches,
    menu: &UIElement,
    machine: Option<&Mutex<RecorderStateMachine>>,
) -> Option<OpenMenu> {
    let bounds = px_rect(&menu.get_cached_bounding_rectangle().ok()?);
    if bounds.is_empty() {
        return None;
    }
    let (x, y) = (
        bounds.left + bounds.width() / 2,
        bounds.top + bounds.height() / 2,
    );
    // A pop-up a tooltip showed in before shows a menu now: it's the window clicked in (#105).
    crate::platform::window::menu_opened_at(x, y);
    let window = host_window(automation, &caches.menu, menu)
        .or_else(|| crate::platform::window::root_window_at(x, y))?;
    let owners = crate::platform::window::owner_processes_of(window.hwnd);
    menu_in(
        automation,
        &caches.items,
        menu,
        &window,
        owners,
        machine,
        MenuSource::Opened,
    )
}

/// A menu and its items, read in `window`, when a click on it would be recorded: never one in
/// Steps' own windows or an excluded app's (by the window it's drawn in, the windows that own
/// that, `owners`, #103, and its own program), nor while the recording takes no clicks
/// (`pre_read::may_read`). `None` for anything that isn't a menu, or holds no named item. Its box
/// may still be empty: XAML can be asked before its first layout (`menus::read_shown`).
fn menu_in(
    automation: &UIAutomation,
    item_cache: &UICacheRequest,
    menu: &UIElement,
    window: &WindowInfo,
    mut owners: Vec<u32>,
    machine: Option<&Mutex<RecorderStateMachine>>,
    source: MenuSource,
) -> Option<OpenMenu> {
    if menu.get_cached_control_type().ok()? != ControlType::Menu {
        return None;
    }
    // Its window shows a menu now, whatever tooltip it showed before: never looked through (#105).
    crate::platform::window::menu_opened_in(window.hwnd);
    let bounds = px_rect(&menu.get_cached_bounding_rectangle().ok()?);
    let pid = menu
        .get_cached_process_id()
        .ok()
        .and_then(|pid| u32::try_from(pid).ok())?;
    // The menu's own program, as UI Automation names it, is judged as an owner is.
    owners.push(pid);
    if !pre_read::may_read(
        window,
        &owners,
        machine,
        crate::platform::window::process_exe_name,
    ) {
        return None;
    }
    let item = automation
        .create_property_condition(
            UIProperty::ControlType,
            Variant::from(ControlType::MenuItem as i32),
            None,
        )
        .ok()?;
    let mut found = menu
        .find_all_build_cache(TreeScope::Children, &item, item_cache)
        .unwrap_or_default();
    if found.is_empty() {
        // Office's and XAML's menus can hold their items in groups.
        found = menu
            .find_all_build_cache(TreeScope::Descendants, &item, item_cache)
            .ok()?;
    }
    let items = menus::kept_items(found.iter().map(|item| {
        MenuItem {
            name: item.get_cached_name().unwrap_or_default(),
            bounds: item
                .get_cached_bounding_rectangle()
                .ok()
                .map(|rect| px_rect(&rect))
                .filter(|rect| !rect.is_empty()),
        }
    }));
    (!items.is_empty()).then(|| OpenMenu {
        window: window.hwnd,
        bounds,
        read: crate::platform::display::now_tick(),
        items,
        own_window: crate::platform::window::is_pop_up_window(window.hwnd)
            && menus::fills_window(&bounds, &PxRect::from(window.frame)),
        source,
    })
}

/// Reads the menu in each XAML pop-up host that shows (`PopUpHosts`, #106), on a thread of its own
/// with its own UI Automation, until the watch stops or `stop` is set: `WinUI` 3's menus (Paint's
/// File menu) weren't kept by UI Automation's menu-opened event. A host whose menu isn't laid out
/// yet is looked at again (`menus::read_shown`); one showing no menu has what was kept for it
/// forgotten, as it shows something else now.
fn pop_up_menu_worker(
    shown: &Receiver<crate::platform::pop_ups::PopUpShown>,
    menus: &OpenMenus,
    machine: Option<&Mutex<RecorderStateMachine>>,
    stop: &AtomicBool,
) {
    let Ok(automation) = UIAutomation::new() else {
        return;
    };
    let Some(caches) = MenuCaches::new(&automation) else {
        return;
    };
    while let Ok(host) = shown.recv() {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let read = menus::read_shown(
            || look_in_pop_up(&automation, &caches, host.hwnd, machine),
            |wait| {
                if !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(wait);
                }
            },
        );
        match read {
            Some(menu) => menus.opened(menu),
            None => menus.forget(host.hwnd, host.at),
        }
    }
}

/// One look for the menu in a pop-up host that showed: gone once the window is hidden or closed,
/// or when a click there wouldn't be recorded (`pre_read::may_read`), so it isn't looked at
/// again; nothing yet while it's cloaked or has no size, or no menu is found in it.
fn look_in_pop_up(
    automation: &UIAutomation,
    caches: &MenuCaches,
    hwnd: isize,
    machine: Option<&Mutex<RecorderStateMachine>>,
) -> Look {
    use crate::platform::window;
    if !window::is_visible(hwnd) {
        return Look::Gone;
    }
    let Some(host) = window::window_info(hwnd) else {
        return Look::Gone;
    };
    let owners = window::owner_processes_of(hwnd);
    if !pre_read::may_read(&host, &owners, machine, window::process_exe_name) {
        return Look::Gone;
    }
    if !window::is_showing(hwnd) {
        return Look::Nothing;
    }
    menu_in_window(automation, &caches.menu, hwnd, &PxRect::from(host.frame))
        .and_then(|menu| {
            menu_in(
                automation,
                &caches.items,
                &menu,
                &host,
                owners,
                machine,
                MenuSource::PopUpShown,
            )
        })
        .map_or(Look::Nothing, Look::Menu)
}

/// The menu in a window: the first in its part of UI Automation's tree, or, where an app puts a
/// pop-up's contents elsewhere in the tree, the menu the element at the window's middle is part
/// of (a pop-up host's menu fills it).
fn menu_in_window(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    hwnd: isize,
    frame: &PxRect,
) -> Option<UIElement> {
    let is_menu = automation
        .create_property_condition(
            UIProperty::ControlType,
            Variant::from(ControlType::Menu as i32),
            None,
        )
        .ok()?;
    if let Ok(menu) = automation
        .element_from_handle(Handle::from(hwnd))
        .and_then(|element| element.find_first_build_cache(TreeScope::Subtree, &is_menu, cache))
    {
        return Some(menu);
    }
    let walker = automation.get_raw_view_walker().ok()?;
    let middle = Point::new(
        frame.left + frame.width() / 2,
        frame.top + frame.height() / 2,
    );
    let mut element = automation
        .element_from_point_build_cache(middle, cache)
        .ok()?;
    for _ in 0..HOST_DEPTH {
        if element.get_cached_control_type().ok()? == ControlType::Menu {
            return Some(element);
        }
        element = walker.get_parent_build_cache(&element, cache).ok()?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One line about a window, for the live probe: its program, class and title.
    fn described(hwnd: isize) -> String {
        let window = crate::platform::window::window_info(hwnd);
        format!(
            "{} {:?} {:?}{}",
            window
                .as_ref()
                .and_then(WindowInfo::exe_name)
                .unwrap_or("?"),
            crate::platform::window::window_class(hwnd).unwrap_or_default(),
            window
                .as_ref()
                .map(|window| window.title.as_str())
                .unwrap_or_default(),
            if crate::platform::window::is_pop_up_window(hwnd) {
                " (a pop-up)"
            } else {
                ""
            },
        )
    }

    /// Live check, read-only: for 45 seconds, prints what says a menu opened and what the
    /// recorder keeps of it (#56, #106). Open menus by hand while it runs (Paint's File menu, then
    /// Excel's right-click menu or Notepad's Edit menu) and rest the pointer on their items. It
    /// prints, as they come:
    /// - `[menu-opened]`: each UI Automation menu-opened event, kept or not;
    /// - `[pop-up host]`: each XAML pop-up host that showed (`WinUI`'s, Paint's);
    /// - `[focus]`: focus moving to a menu or a menu item;
    /// - `[kept]`: each menu the recorder kept, by which of the first two, with its window, whether
    ///   it has a window of its own, and its items;
    /// - `[click]`: what a click under the pointer would carry (its items, and `showing`, which lets
    ///   the item under the click name it without the screenshot's words).
    ///
    /// `cargo test -p capture menus_read_as_they_open -- --ignored --nocapture`
    #[test]
    #[ignore = "needs menus opened by hand on this desktop"]
    fn menus_read_as_they_open() {
        let automation = UIAutomation::new().expect("UI Automation");
        let menus = Arc::new(OpenMenus::default());
        let stop = Arc::new(AtomicBool::new(false));
        // What the recorder runs while recording.
        let (root, handler) =
            register_menu_handler(&automation, Arc::clone(&menus), None, Arc::clone(&stop))
                .expect("listening for menus");
        let watch = watch_pop_up_menus(&menus, None, &stop).expect("watching pop-up hosts");
        // What says a menu opened, kept or not.
        let (opened, focused) = print_menu_signals(&automation, &root);
        let (shown_tx, shown_rx) = mpsc::channel();
        let shown = crate::platform::pop_ups::PopUpHosts::watch(shown_tx).expect("watching");

        let started = Instant::now();
        let mut kept: Vec<OpenMenu> = Vec::new();
        let mut last: Option<ClickedMenu> = None;
        while started.elapsed() < Duration::from_secs(45) {
            std::thread::sleep(Duration::from_millis(100));
            while let Ok(host) = shown_rx.try_recv() {
                println!("[pop-up host] {}", described(host.hwnd));
            }
            print_kept(&menus, &mut kept, &mut last);
        }
        stop.store(true, Ordering::SeqCst);
        drop(shown);
        drop(watch);
        let _ = automation.remove_focus_changed_event_handler(&focused);
        let _ = automation.remove_automation_event_handler(UIEventType::MenuOpened, &root, &opened);
        let _ =
            automation.remove_automation_event_handler(UIEventType::MenuOpened, &root, &handler);
        assert!(!kept.is_empty(), "no menu was kept");
    }

    /// For the live check: prints each menu-opened event, kept or not, and focus moving to a menu
    /// or a menu item. Returns the handlers, to remove them at the end.
    fn print_menu_signals(
        automation: &UIAutomation,
        root: &UIElement,
    ) -> (UIEventHandler, UIFocusChangedEventHandler) {
        let caches = MenuCaches::new(automation).expect("cache requests");
        let opened_cache = caches.menu.clone();
        let walker_automation = automation.clone();
        let opened: Box<CustomEventHandlerFn> = Box::new(move |menu: &UIElement, _| {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                let bounds = menu
                    .get_cached_bounding_rectangle()
                    .map(|rect| px_rect(&rect));
                let host = host_window(&walker_automation, &caches.menu, menu);
                println!(
                    "[menu-opened] {:?} box {bounds:?}, in {}",
                    menu.get_cached_control_type(),
                    host.map_or_else(|| "no window".into(), |window| described(window.hwnd)),
                );
            }));
            Ok(())
        });
        let opened = UIEventHandler::from(opened);
        automation
            .add_automation_event_handler(
                UIEventType::MenuOpened,
                root,
                TreeScope::Subtree,
                Some(&opened_cache),
                &opened,
            )
            .expect("listening for menus");
        let focus_cache = element_cache(automation).expect("cache request");
        let focused: Box<CustomFocusChangedEventHandlerFn> =
            Box::new(move |element: &UIElement| {
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    if let Ok(kind @ (ControlType::Menu | ControlType::MenuItem)) =
                        element.get_cached_control_type()
                    {
                        println!(
                            "[focus] {kind:?} {:?}",
                            element.get_cached_name().unwrap_or_default()
                        );
                    }
                }));
                Ok(())
            });
        let focused = UIFocusChangedEventHandler::from(focused);
        let _ = automation.add_focus_changed_event_handler(Some(&focus_cache), &focused);
        (opened, focused)
    }

    /// For the live check: prints each menu kept since the last look, and what a click under the
    /// pointer would carry when that changes.
    fn print_kept(menus: &OpenMenus, kept: &mut Vec<OpenMenu>, last: &mut Option<ClickedMenu>) {
        for menu in menus.kept() {
            if kept.contains(&menu) {
                continue;
            }
            let names: Vec<&str> = menu.items.iter().map(|item| item.name.as_str()).collect();
            let boxed = menu
                .items
                .iter()
                .filter(|item| item.bounds.is_some())
                .count();
            println!(
                "[kept] by {:?}: {}, box {:?}, own window {}: {} items, {boxed} boxed: {names:?}",
                menu.source,
                described(menu.window),
                menu.bounds,
                menu.own_window,
                menu.items.len(),
            );
            kept.push(menu);
        }
        let Some((x, y)) = crate::platform::display::cursor_pos() else {
            return;
        };
        let Some(window) = crate::platform::window::root_window_at(x, y) else {
            return;
        };
        let clicked = menus.for_click(x, y, window.hwnd, crate::platform::display::now_tick());
        if clicked.is_none() || clicked == *last {
            return;
        }
        if let Some(menu) = &clicked {
            let under = menu
                .items
                .iter()
                .filter(|item| item.bounds.is_some_and(|bounds| bounds.contains(x, y)))
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>();
            println!(
                "[click] at ({x}, {y}) in {}: {} items, showing {}, under the click {under:?}",
                described(window.hwnd),
                menu.items.len(),
                menu.showing,
            );
        }
        *last = clicked;
    }

    /// Live check, read-only (#105): for 30 seconds, prints each tooltip UI Automation says opened
    /// (its box, its program, and whether its window was noted), and the window a click under the
    /// pointer would go to, with whether a tooltip lies over it. Rest the pointer on a toolbar
    /// button until its tooltip shows (File Explorer's Details button). It passes once a click
    /// under the pointer would go through a tooltip.
    /// `cargo test -p capture tooltips_under_the_pointer -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a tooltip shown by hand on this desktop"]
    fn tooltips_under_the_pointer_are_looked_through() {
        let _ = crate::platform::display::enable_per_monitor_dpi_awareness();
        let automation = UIAutomation::new().expect("UI Automation");
        let root = automation.get_root_element().expect("root");
        let cache = automation.create_cache_request().expect("cache");
        for property in [
            UIProperty::ControlType,
            UIProperty::BoundingRectangle,
            UIProperty::ProcessId,
            UIProperty::Name,
        ] {
            cache.add_property(property).expect("property");
        }
        let handler: Box<CustomEventHandlerFn> = Box::new(|tooltip: &UIElement, _| {
            let noted = note_tooltip(tooltip);
            println!(
                "tooltip opened: {:?} {:?} {:?} pid {:?} -> noted {noted:?}",
                tooltip.get_cached_control_type(),
                tooltip.get_cached_name(),
                tooltip
                    .get_cached_bounding_rectangle()
                    .map(|rect| px_rect(&rect)),
                tooltip.get_cached_process_id(),
            );
            Ok(())
        });
        let handler = UIEventHandler::from(handler);
        automation
            .add_automation_event_handler(
                UIEventType::ToolTipOpened,
                &root,
                TreeScope::Subtree,
                Some(&cache),
                &handler,
            )
            .expect("listening for tooltips");
        let started = Instant::now();
        let mut last = None;
        let mut through = false;
        while started.elapsed() < Duration::from_secs(30) && !through {
            std::thread::sleep(Duration::from_millis(100));
            let Some((x, y)) = crate::platform::display::cursor_pos() else {
                continue;
            };
            let Some(pressed) = crate::platform::window::pressed_at(x, y, false) else {
                continue;
            };
            through = crate::platform::window::tooltip_at(x, y);
            let now = (pressed.window.hwnd, through);
            if last != Some(now) {
                last = Some(now);
                println!(
                    "at ({x}, {y}): tooltip over it {through}; a click goes to {:?} {:?} {:?} {:?}",
                    crate::platform::window::window_class(pressed.window.hwnd),
                    pressed.window.title,
                    pressed.window.exe_name(),
                    pressed.window.frame,
                );
            }
        }
        let _ =
            automation.remove_automation_event_handler(UIEventType::ToolTipOpened, &root, &handler);
        assert!(through, "no tooltip under the pointer was looked through");
    }

    #[test]
    fn control_type_debug_names_are_plain() {
        assert_eq!(
            format!("{:?}", uiautomation::types::ControlType::Hyperlink),
            "Hyperlink"
        );
    }

    /// The pre-reads' desk with the pointer held still at one point, so a live test needn't move
    /// the real one.
    struct Resting {
        desk: UiaDesk,
        at: (i32, i32),
    }

    impl pre_read::Desk for Resting {
        fn pointer(&self) -> Option<(i32, i32)> {
            Some(self.at)
        }
        fn last_input(&self) -> Option<u32> {
            Some(0)
        }
        fn mouse_moves(&self) -> Option<u64> {
            Some(0)
        }
        fn now(&self) -> u32 {
            self.desk.now()
        }
        fn under(&self, x: i32, y: i32) -> Option<Under> {
            self.desk.under(x, y)
        }
        fn ask(&mut self, x: i32, y: i32) {
            self.desk.ask(x, y);
        }
        fn read(&mut self, x: i32, y: i32) -> Result<ElementFacts, LookupError> {
            self.desk.read(x, y)
        }
    }

    fn uia_desk() -> UiaDesk {
        let automation = UIAutomation::new().expect("UI Automation");
        let cache = element_cache(&automation).expect("cache request");
        UiaDesk {
            automation,
            cache,
            machine: None,
        }
    }

    fn median_and_max(mut values: Vec<f64>) -> String {
        values.sort_by(f64::total_cmp);
        match (values.get(values.len() / 2), values.last()) {
            (Some(median), Some(max)) => format!("{median:>6.1} / {max:>6.1}"),
            _ => format!("{:>15}", "-"),
        }
    }

    /// Up to 24 points in the windows on screen, three in each, with the program each is in.
    fn points_on_screen() -> Vec<(i32, i32, isize, String)> {
        use crate::platform::window::{root_window_at, shown_windows};
        let own = crate::platform::window::own_process_id();
        let mut points: Vec<(i32, i32, isize, String)> = Vec::new();

        for shown in shown_windows() {
            let frame = shown.frame;
            if shown.pid == own
                || shown.see_through
                || shown.notification
                || frame.right - frame.left < 300
                || frame.bottom - frame.top < 200
            {
                continue;
            }
            let width = frame.right - frame.left;
            let height = frame.bottom - frame.top;
            for (x, y) in [
                (frame.left + width / 2, frame.top + height / 2),
                (frame.left + width / 4, frame.top + 60),
                (frame.left + width * 3 / 4, frame.top + height * 3 / 4),
            ] {
                if let Some(window) = root_window_at(x, y)
                    && window.pid != own
                    && points.len() < 24
                {
                    let exe = window.exe_name().unwrap_or("?").to_string();
                    points.push((x, y, window.hwnd, exe));
                }
            }
        }
        points
    }

    /// A lookup thread answering from `reads`, as `UiaClient`'s does.
    fn lookup_thread(reads: &Arc<PreReads>) -> (Sender<Request>, Replies, JoinHandle<()>) {
        let (request_tx, request_rx) = mpsc::channel();
        let (reply_tx, reply_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let reads = Arc::clone(reads);
        let thread = std::thread::spawn(move || {
            let cancelled = Arc::new(AtomicBool::new(false));
            worker(
                &request_rx,
                &reply_tx,
                None,
                &ready_tx,
                &cancelled,
                &reads,
                Arc::default(),
            );
        });
        ready_rx
            .recv_timeout(STARTUP_TIMEOUT)
            .expect("worker started")
            .expect("worker ready");
        (request_tx, Replies { receiver: reply_rx }, thread)
    }

    /// Live timings, read-only: no input is sent and the pointer isn't moved. For points in the
    /// windows on screen, how long the lookup thread takes to answer a click (the pipeline's
    /// `uia_ms`): read after the click (every click outside Chromium before #92, and a click now
    /// with no pre-read that fits), named from its pre-read, and read after the click while
    /// another thread reads the same window without a pause (worse than the pre-reads, which
    /// read a resting pointer's element at most every 250 ms). Prints programs, control types and
    /// times, never names. `cargo test -p capture pre_read_timings -- --ignored --nocapture`
    #[test]
    #[ignore = "reads the windows on this desktop"]
    fn pre_read_timings() {
        let points = points_on_screen();
        assert!(!points.is_empty(), "no window on screen to read");

        let reads = Arc::new(PreReads::default());
        let (request_tx, replies, worker_thread) = lookup_thread(&reads);
        let mut next_id = 0_u64;
        let mut ask = |x: i32, y: i32, hwnd: isize, pressed: Option<u32>| {
            next_id += 1;
            let started = Instant::now();
            request_tx
                .send(Request::At {
                    id: next_id,
                    x,
                    y,
                    hwnd,
                    pressed,
                })
                .expect("worker running");
            replies.wait(
                next_id,
                started,
                started + Duration::from_secs(3),
                "stopped",
            )
        };

        println!(
            "{:<24} {:<12} {:>15} {:>15} {:>15}",
            "program", "control", "after ms", "pre-read ms", "busy ms"
        );
        let mut all = [Vec::new(), Vec::new(), Vec::new()];
        for (x, y, hwnd, exe) in &points {
            let (x, y, hwnd) = (*x, *y, *hwnd);
            let mut timings = [Vec::new(), Vec::new(), Vec::new()];
            let mut control = String::new();
            for _ in 0..5 {
                // Read after the click.
                if let Lookup::Found { ms, facts, .. } = ask(x, y, hwnd, None) {
                    timings[0].push(ms);
                    control = facts.control_type;
                }
                // Named from its pre-read: the pointer rested there, then the button went down.
                let mut resting = Resting {
                    desk: uia_desk(),
                    at: (x, y),
                };
                let mut watch = pre_read::Watch::default();
                // The click before was a press: the next read waits for the app to react.
                watch.look(&mut resting, &reads);
                std::thread::sleep(Duration::from_millis(300));
                watch.look(&mut resting, &reads);
                std::thread::sleep(Duration::from_millis(32));
                let pressed = crate::platform::display::now_tick();
                if let Lookup::Found {
                    ms, pre_read: true, ..
                } = ask(x, y, hwnd, Some(pressed))
                {
                    timings[1].push(ms);
                }
            }
            // Read after the click while another thread reads the same window without a pause.
            let busy = Arc::new(AtomicBool::new(true));
            let reader = {
                let busy = Arc::clone(&busy);
                std::thread::spawn(move || {
                    let mut desk = uia_desk();
                    while busy.load(Ordering::SeqCst) {
                        let _ = pre_read::Desk::read(&mut desk, x + 7, y + 5);
                    }
                })
            };
            for _ in 0..5 {
                if let Lookup::Found { ms, .. } = ask(x, y, hwnd, None) {
                    timings[2].push(ms);
                }
            }
            busy.store(false, Ordering::SeqCst);
            reader.join().expect("reader");
            println!(
                "{exe:<24} {control:<12} {} {} {}",
                median_and_max(timings[0].clone()),
                median_and_max(timings[1].clone()),
                median_and_max(timings[2].clone())
            );
            for (total, these) in all.iter_mut().zip(timings) {
                total.extend(these);
            }
        }
        let [after, named, busy] = all;
        println!(
            "{:<37} {} {} {}",
            "all (median / max)",
            median_and_max(after),
            median_and_max(named),
            median_and_max(busy)
        );
        drop(request_tx);
        worker_thread.join().expect("worker");
    }
}
