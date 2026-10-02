//! UI Automation on its own thread (docs/spec/02-capture.md#on-each-click). What happens to the
//! element it finds, and how the pipeline waits for it, is shared with Linux (`lookup.rs`).
//!
//! Browser address-bar reads run on a second thread, so a slow tree search in a browser window
//! never delays the next click's lookup.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use uiautomation::core::UICacheRequest;
use uiautomation::events::{CustomFocusChangedEventHandlerFn, UIFocusChangedEventHandler};
use uiautomation::patterns::UIValuePattern;
use uiautomation::types::{Handle, Point, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use crate::platform::window::WindowInfo;

use crate::coords::PxRect;
use crate::facts::{ElementFacts, InputRecord, ParentFacts};
pub use crate::lookup::{FocusOptions, Lookup};
use crate::lookup::{
    Replies, Reply, await_worker_ready, fingerprint, fit_value, is_editable, origin_from_address,
    reading_blocked,
};
use crate::sensitive::{looks_sensitive, mask_value};

enum Request {
    At {
        id: u64,
        x: i32,
        y: i32,
        hwnd: isize,
    },
    Stop,
}

enum OriginRequest {
    Read { id: u64, hwnd: isize },
    Stop,
}

struct OriginReply {
    id: u64,
    origin: Option<String>,
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
}

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

impl UiaClient {
    /// Starts the worker. If `focus` is given, field values are reported through it on focus-leave.
    ///
    /// # Errors
    /// If COM or UI Automation can't be initialised on the worker thread.
    pub fn start(focus: Option<(Sender<InputRecord>, FocusOptions)>) -> Result<Self, String> {
        let (request_tx, request_rx) = mpsc::channel();
        let (reply_tx, reply_rx) = mpsc::channel();
        let (origin_request_tx, origin_request_rx) = mpsc::channel();
        let (origin_tx, origin_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let thread = std::thread::Builder::new()
            .name("amluto-uia".into())
            .spawn(move || {
                worker(&request_rx, &reply_tx, focus, &ready_tx, &worker_cancelled);
            })
            .map_err(|error| error.to_string())?;
        await_worker_ready(
            &ready_rx,
            &cancelled,
            STARTUP_TIMEOUT,
            "UI Automation did not become ready within five seconds",
        )?;
        // Without it, navigation steps are simply not recorded; clicks still are.
        let origin_thread = std::thread::Builder::new()
            .name("amluto-uia-origin".into())
            .spawn(move || origin_worker(&origin_request_rx, &origin_tx))
            .ok();
        Ok(Self {
            requests: request_tx,
            replies: Replies { receiver: reply_rx },
            origin_requests: origin_request_tx,
            origin_replies: origin_rx,
            cancelled,
            thread: Some(thread),
            origin_thread,
        })
    }

    /// Asks for the element at a physical point in the top-level window `hwnd` that was there when
    /// the click was taken. Returns immediately.
    pub fn request(&self, id: u64, x: i32, y: i32, hwnd: isize) {
        let _ = self.requests.send(Request::At { id, x, y, hwnd });
    }

    /// Requests the current address-bar origin from a known Chrome or Edge top-level window.
    pub fn request_browser_origin(&self, id: u64, hwnd: isize) {
        let _ = self.origin_requests.send(OriginRequest::Read { id, hwnd });
    }

    /// Returns a completed result for this navigation query without waiting on UI Automation.
    #[must_use]
    pub fn take_browser_origin(&self, id: u64) -> Option<Option<String>> {
        while let Ok(reply) = self.origin_replies.try_recv() {
            if reply.id == id {
                return Some(reply.origin);
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
    ready: &Sender<Result<(), String>>,
    cancelled: &Arc<AtomicBool>,
) {
    let automation = match UIAutomation::new() {
        Ok(automation) => automation,
        Err(error) => {
            let _ = ready.send(Err(format!("UI Automation unavailable: {error}")));
            return;
        }
    };
    let cache = match element_cache(&automation) {
        Ok(cache) => cache,
        Err(error) => {
            let _ = ready.send(Err(format!("UIA cache request failed: {error}")));
            return;
        }
    };

    if cancelled.load(Ordering::SeqCst) {
        return;
    }
    let focus_handler = focus.and_then(|(sender, options)| {
        register_focus_handler(&automation, &cache, sender, options, Arc::clone(cancelled))
    });
    if cancelled.load(Ordering::SeqCst) {
        if let Some(handler) = focus_handler {
            let _ = automation.remove_focus_changed_event_handler(&handler);
        }
        return;
    }
    let _ = ready.send(Ok(()));

    while let Ok(request) = requests.recv() {
        match request {
            Request::At { id, x, y, hwnd } => {
                let started = Instant::now();
                // A click that closed its own window (OK on a dialog) can be read only after the
                // window has gone, when the point shows what was behind it: Steps named a
                // spreadsheet cell instead of OK (F019). Unnamed is better than wrong.
                let still_there = || {
                    crate::platform::window::root_window_at(x, y).map(|window| window.hwnd)
                        == Some(hwnd)
                };
                let result = if still_there() {
                    element_at(&automation, &cache, x, y).and_then(|found| {
                        if still_there() {
                            Ok(found)
                        } else {
                            Err("the window clicked in closed before it could be read".into())
                        }
                    })
                } else {
                    Err("the window clicked in closed before it could be read".into())
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

    if let Some(handler) = focus_handler {
        let _ = automation.remove_focus_changed_event_handler(&handler);
    }
}

/// How long a window without an address bar (an installed web app) is left before it is searched
/// again: the search walks the whole page tree.
const NO_OMNIBOX_RETRY: Duration = Duration::from_secs(30);

/// What the origin thread knows about a browser window's address bar.
enum Omnibox {
    Found(UIElement),
    Missing(Instant),
}

fn origin_worker(requests: &Receiver<OriginRequest>, replies: &Sender<OriginReply>) {
    let automation = UIAutomation::new().ok();
    let mut known: HashMap<isize, Omnibox> = HashMap::new();
    while let Ok(OriginRequest::Read { id, hwnd }) = requests.recv() {
        let origin = automation.as_ref().and_then(|automation| {
            // A panic inside UI Automation loses this reading, not the thread.
            catch_unwind(AssertUnwindSafe(|| {
                cached_origin(automation, &mut known, hwnd)
            }))
            .ok()
            .flatten()
        });
        let _ = replies.send(OriginReply { id, origin });
    }
}

/// The address bar's origin, reusing the element found last time for this window. A stale
/// element (the window closed or rebuilt its toolbar) is searched for again.
fn cached_origin(
    automation: &UIAutomation,
    known: &mut HashMap<isize, Omnibox>,
    hwnd: isize,
) -> Option<String> {
    match known.get(&hwnd) {
        Some(Omnibox::Found(element)) => {
            if let Some(origin) = omnibox_origin(element) {
                return Some(origin);
            }
            if element.get_bounding_rectangle().is_ok() {
                // Still there: the address just isn't a web page (a new tab, a password field).
                return None;
            }
        }
        Some(Omnibox::Missing(since)) if since.elapsed() < NO_OMNIBOX_RETRY => return None,
        _ => {}
    }
    if known.len() > 64 {
        known.clear();
    }
    if let Some(element) = find_omnibox(automation, hwnd) {
        let origin = omnibox_origin(&element);
        known.insert(hwnd, Omnibox::Found(element));
        origin
    } else {
        known.insert(hwnd, Omnibox::Missing(Instant::now()));
        None
    }
}

/// Chromium's native address bar: an edit with this class. Its automation id is a generated
/// `view_NNNN` value (`view_1021` in Edge), not its localized accessible name.
const NATIVE_OMNIBOX: &str = "OmniboxViewViews";
/// Chrome 155 draws the toolbar as a web page of its own inside this native view, and the address
/// bar there is a combo box. Web pages can't make native views, so only Chrome's own toolbar has
/// this class.
const WEB_UI_TOOLBAR: &str = "WebUIToolbarWebView";

fn find_omnibox(automation: &UIAutomation, hwnd: isize) -> Option<UIElement> {
    use uiautomation::types::ControlType;
    let window = automation.element_from_handle(Handle::from(hwnd)).ok()?;
    let window_bounds = window.get_bounding_rectangle().ok()?;
    let class = |name: &str| {
        automation.create_property_condition(UIProperty::ClassName, Variant::from(name), None)
    };
    // One walk of the window's tree finds whichever toolbar this browser has.
    let condition = automation
        .create_or_condition(class(NATIVE_OMNIBOX).ok()?, class(WEB_UI_TOOLBAR).ok()?)
        .ok()?;
    let found = window.find_first(TreeScope::Descendants, &condition).ok()?;
    let element = if found.get_classname().ok()? == WEB_UI_TOOLBAR {
        let combo = automation
            .create_property_condition(
                UIProperty::ControlType,
                Variant::from(ControlType::ComboBox as i32),
                None,
            )
            .ok()?;
        found.find_first(TreeScope::Descendants, &combo).ok()?
    } else if found.get_control_type().ok()? == ControlType::Edit {
        found
    } else {
        return None;
    };
    let bounds = element.get_bounding_rectangle().ok()?;
    let window_width = window_bounds.get_right() - window_bounds.get_left();
    let address_width = bounds.get_right() - bounds.get_left();
    // A page field could mimic the class, so require a wide edit in the browser toolbar.
    if bounds.get_top() < window_bounds.get_top()
        || bounds.get_bottom()
            > window_bounds.get_top() + (window_bounds.get_bottom() - window_bounds.get_top()) / 3
        || address_width < window_width / 4
        || !has_toolbar_ancestor(automation, &element)
    {
        return None;
    }
    Some(element)
}

fn omnibox_origin(element: &UIElement) -> Option<String> {
    // While the address bar has the keyboard, what it holds may be a search being typed, not
    // the page's address.
    let typing = element
        .get_property_value(UIProperty::HasKeyboardFocus)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok())
        .unwrap_or(true);
    if typing {
        return None;
    }
    let is_password = element
        .get_property_value(UIProperty::IsPassword)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok())
        .unwrap_or(true);
    if is_password {
        return None;
    }
    origin_from_address(&read_value(element)?)
}

fn has_toolbar_ancestor(automation: &UIAutomation, element: &UIElement) -> bool {
    let Ok(walker) = automation.get_control_view_walker() else {
        return false;
    };
    let mut current = element.clone();
    for _ in 0..16 {
        let Ok(parent) = walker.get_parent(&current) else {
            return false;
        };
        if parent.get_control_type().ok() == Some(uiautomation::types::ControlType::ToolBar) {
            return true;
        }
        current = parent;
    }
    false
}

/// The site an address bar shows. A full address gives its origin (`https://example.test:8443`).
/// Edge and Chrome usually hide the scheme (`example.test/path`), and then the site is given as
/// the browser shows it, host and any port, since the scheme isn't known. Anything that isn't
/// plainly a site (a word, a search, another kind of address) gives nothing.
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

fn element_cache(automation: &UIAutomation) -> uiautomation::Result<UICacheRequest> {
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

fn facts_from_cached(element: &UIElement, extra_terms: &[String]) -> ElementFacts {
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
        .map(|rect| PxRect {
            left: rect.get_left(),
            top: rect.get_top(),
            right: rect.get_right(),
            bottom: rect.get_bottom(),
        });
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
        parent: None,
        sensitive: false,
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

/// Whether a physical point is inside an element's bounds.
fn contains(bounds: Option<&PxRect>, x: i32, y: i32) -> bool {
    bounds.is_some_and(|rect| {
        rect.right > rect.left
            && rect.bottom > rect.top
            && x >= rect.left
            && x < rect.right
            && y >= rect.top
            && y < rect.bottom
    })
}

/// A window, pane or similar that only holds the thing clicked.
fn is_container(facts: &ElementFacts) -> bool {
    matches!(facts.control_type.as_str(), "Window" | "Pane")
}

/// The invisible layer a XAML menu or flyout lays over its window, so a click outside it closes
/// it. A click that opens a menu is often read after the menu has opened, and then lands on this
/// layer, named "Close": Notepad's Edit menu was recorded as `Click "Close"`.
fn is_light_dismiss(automation_id: &str) -> bool {
    automation_id == "Light Dismiss"
}

/// Names that are a UI framework's, not the app's: `PopupHost`, `Pop-upHost`,
/// `DesktopWindowXamlSource`, `Chrome_WidgetWin_1`, or a name that is just the class name.
fn framework_name(name: &str, class_name: &str) -> bool {
    let squashed: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase();
    matches!(
        squashed.as_str(),
        "popuphost"
            | "desktopwindowxamlsource"
            | "xamlexplorerhostislandwindow"
            | "chrome_widgetwin_0"
            | "chrome_widgetwin_1"
            | "chromelegacywindow"
            | "intermediated3dwindow"
            | "windowsuicorecorewindow"
    ) || (!name.is_empty() && name == class_name && name.contains('_'))
}

/// The deepest element under a point, walking down from `element`'s top-level window: at each
/// level the smallest child whose bounds hold the point. A few hundred elements at most.
fn descend(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    element: &UIElement,
    x: i32,
    y: i32,
) -> Option<UIElement> {
    let walker = automation.get_control_view_walker().ok()?;
    let root = automation.get_root_element().ok()?;
    let mut top = element.clone();
    for _ in 0..40 {
        let parent = walker.get_parent(&top).ok()?;
        if automation.compare_elements(&parent, &root).unwrap_or(true) {
            break;
        }
        top = parent;
    }
    let area = |found: &UIElement| -> Option<i64> {
        let rect = found.get_bounding_rectangle().ok()?;
        let inside = x >= rect.get_left()
            && x < rect.get_right()
            && y >= rect.get_top()
            && y < rect.get_bottom();
        inside.then(|| {
            i64::from(rect.get_right() - rect.get_left())
                * i64::from(rect.get_bottom() - rect.get_top())
        })
    };
    let mut current = top;
    for _ in 0..40 {
        let mut best: Option<(i64, UIElement)> = None;
        let mut child = walker.get_first_child(&current).ok();
        let mut seen = 0;
        while let Some(candidate) = child {
            seen += 1;
            if seen > 400 {
                break;
            }
            if let Some(size) = area(&candidate)
                && size > 0
                && !is_light_dismiss(&candidate.get_automation_id().unwrap_or_default())
                && best.as_ref().is_none_or(|(smallest, _)| size <= *smallest)
            {
                best = Some((size, candidate.clone()));
            }
            child = walker.get_next_sibling(&candidate).ok();
        }
        match best {
            Some((_, next)) => current = next,
            None => break,
        }
    }
    current.build_updated_cache(cache).ok()
}

/// Chrome builds its accessibility tree only when asked; the first lookup can return an empty pane.
fn looks_unbuilt(facts: &ElementFacts) -> bool {
    facts.name.is_empty()
        && facts.framework_id == "Chrome"
        && matches!(
            facts.control_type.as_str(),
            "Pane" | "Document" | "Custom" | "Group"
        )
}

fn element_at(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    x: i32,
    y: i32,
) -> std::result::Result<(ElementFacts, bool), String> {
    let lookup = || -> uiautomation::Result<(UIElement, ElementFacts)> {
        // Some apps' hosts (Windows Settings) refuse the one-call lookup with its cached
        // properties ("The system cannot find the file specified"), which left every click there
        // unnamed (F016): the element alone, then its properties, works.
        let element = automation
            .element_from_point_build_cache(Point::new(x, y), cache)
            .or_else(|_| {
                automation
                    .element_from_point(Point::new(x, y))?
                    .build_updated_cache(cache)
            })?;
        let facts = facts_from_cached(&element, &[]);
        Ok((element, facts))
    };
    let (mut element, mut facts) = lookup().map_err(|error| error.to_string())?;
    let mut retried = false;
    if looks_unbuilt(&facts) {
        std::thread::sleep(Duration::from_millis(30));
        if let Ok(second) = lookup() {
            (element, facts) = second;
        }
        retried = true;
    }
    // Windows' hit test can answer with the wrong element: a click on Notepad's or File Explorer's
    // menu named "Close" (the title bar's button) (F015, F070), and in Settings only the window
    // (F016). When the answer isn't under the click, is only a window or pane, or carries a
    // framework's name, the element under the click is found by walking down from the window.
    if (!contains(facts.bounds.as_ref(), x, y)
        || is_container(&facts)
        || is_light_dismiss(&facts.automation_id)
        || framework_name(&facts.name, &facts.class_name))
        && let Some(found) = descend(automation, cache, &element, x, y)
    {
        let better = facts_from_cached(&found, &[]);
        if contains(better.bounds.as_ref(), x, y) && !is_light_dismiss(&better.automation_id) {
            (element, facts) = (found, better);
        }
    }
    // A framework's name for what was clicked says nothing to a reader: the nearest named
    // element above it speaks for it.
    if framework_name(&facts.name, &facts.class_name) || is_light_dismiss(&facts.automation_id) {
        facts.name = String::new();
    }

    if let Ok(walker) = automation.get_control_view_walker()
        && let Ok(parent) = walker.get_parent(&element)
    {
        facts.parent = Some(ParentFacts {
            control_type: parent
                .get_control_type()
                .map(|control| format!("{control:?}"))
                .unwrap_or_default(),
            name: parent.get_name().unwrap_or_default(),
        });
    }
    Ok((facts, retried))
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
    /// The top-level window in front when focus arrived: exclusions are named by it.
    window_pid: u32,
    window_exe: Option<String>,
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
            match read_value(&previous.element) {
                // Masked here, so the unmasked value never leaves the worker.
                Some(value) if Some(&value) != previous.initial.as_ref() => {
                    (Some(fit_value(mask_value(&value))), None)
                }
                Some(_) => (None, None), // unchanged: no step
                None => (None, Some("unreadable")),
            }
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
        };
        // With keys recorded, a field that can't be read (Excel's cell editor, some web editors) is
        // covered by the key worker's typing step, so it makes no "Type in …" step of its own.
        let covered_by_keys = options.note.is_some() && record.withheld == Some("unreadable");
        if (record.value.is_some() || record.withheld.is_some()) && !covered_by_keys {
            let _ = sender.send(record);
        }
    }

    *current = Some(remember(automation, element, options));
}

/// Whether the focused element is Chrome's or Edge's address bar, the two kinds `find_omnibox`
/// finds: the native omnibox edit, or the combo box inside Chrome 155's own toolbar view. What's
/// typed there is the address, and only its site is kept, by the "Go to" step: it's never a
/// typing step, which would keep the whole address (testing, 30/09/2026).
fn is_address_bar(automation: &UIAutomation, element: &UIElement, facts: &ElementFacts) -> bool {
    if facts.class_name == NATIVE_OMNIBOX {
        return true;
    }
    if facts.control_type != "ComboBox" || facts.framework_id != "Chrome" {
        return false;
    }
    let Ok(walker) = automation.get_raw_view_walker() else {
        return false;
    };
    let mut current = element.clone();
    for _ in 0..16 {
        let Ok(parent) = walker.get_parent(&current) else {
            return false;
        };
        if parent.get_classname().ok().as_deref() == Some(WEB_UI_TOOLBAR) {
            return true;
        }
        current = parent;
    }
    false
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
        .is_some_and(crate::typing::is_code_editor);
    // The address bar is never read here: leaving it makes no typing step.
    let address_bar = is_address_bar(automation, element, &facts);
    let editable = !blocked && !code_editor && !address_bar && is_editable(&facts);
    // Read even without "Record what's typed", but then only to fingerprint it (below).
    let readable = editable && !facts.sensitive;
    let value_now = if readable { read_value(element) } else { None };
    if let Some(note) = &options.note {
        let mut note = note
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        note.generation = note.generation.wrapping_add(1);
        note.window = window.as_ref().map_or(0, |window| window.hwnd);
        note.facts = facts.clone();
        // Keys typed here make no step: the value is read when focus leaves, or, in the address
        // bar, the "Go to" step says where it went.
        note.field = value_now.is_some() || address_bar;
        note.address_bar = address_bar;
        note.tick_ms = crate::platform::display::now_tick();
    }
    let fingerprint = if options.record_values {
        None
    } else {
        value_now.as_deref().map(fingerprint)
    };
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
        since_tick_ms: crate::platform::display::now_tick(),
        window_pid: window.as_ref().map_or(0, |window| window.pid),
        window_exe: window
            .as_ref()
            .and_then(WindowInfo::exe_name)
            .map(str::to_string),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_chrome_panes_look_unbuilt() {
        let facts = ElementFacts {
            control_type: "Pane".into(),
            framework_id: "Chrome".into(),
            ..ElementFacts::default()
        };
        assert!(looks_unbuilt(&facts));
        assert!(!looks_unbuilt(&ElementFacts {
            name: "Save".into(),
            ..facts.clone()
        }));
        assert!(!looks_unbuilt(&ElementFacts {
            framework_id: "Win32".into(),
            ..facts
        }));
    }

    #[test]
    fn control_type_debug_names_are_plain() {
        assert_eq!(
            format!("{:?}", uiautomation::types::ControlType::Hyperlink),
            "Hyperlink"
        );
    }
}
