//! UI Automation on its own thread (docs/spec/02-capture.md#on-each-click). What happens to the
//! element it finds, and how the pipeline waits for it, is shared with Linux (`lookup.rs`).
//!
//! Browser address-bar reads run on a second thread, so a slow tree search in a browser window
//! never delays the next click's lookup.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use uiautomation::core::UICacheRequest;
use uiautomation::events::{CustomFocusChangedEventHandlerFn, UIFocusChangedEventHandler};
use uiautomation::patterns::{UIGridItemPattern, UIGridPattern, UIValuePattern};
use uiautomation::types::{Handle, Point, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use crate::platform::window::WindowInfo;

use crate::coords::PxRect;
use crate::facts::{AncestorFacts, ElementFacts, InputRecord};
pub use crate::lookup::{FocusOptions, Lookup};
use crate::lookup::{
    Replies, Reply, await_worker_ready, fingerprint, fit_value, is_editable, origin_from_address,
    reading_blocked,
};
use crate::navigation::BarRead;
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
}

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

impl UiaClient {
    /// Starts the worker. If `focus` is given, field values are reported through it on focus-leave.
    ///
    /// # Errors
    /// If COM or UI Automation can't be initialised on the worker thread.
    pub fn start(focus: Option<(Sender<InputRecord>, FocusOptions)>) -> Result<Self, String> {
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
            entered,
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

    let mut warmth = Warmth::default();
    loop {
        let request = match requests.recv_timeout(CHROME_WARM_EVERY) {
            Ok(request) => request,
            Err(RecvTimeoutError::Timeout) => {
                warm_chrome(&automation, &cache, &mut warmth);
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
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
                let warmed = warmth.answer_for(x, y);
                let result = if let Some(facts) = warmed
                    && still_there()
                {
                    Ok((facts, false))
                } else if still_there() {
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
        let read = automation
            .as_ref()
            .and_then(|automation| {
                // A panic inside UI Automation loses this reading, not the thread.
                catch_unwind(AssertUnwindSafe(|| {
                    cached_origin(automation, &mut known, hwnd)
                }))
                .ok()
            })
            .unwrap_or_default();
        let _ = replies.send(OriginReply { id, read });
    }
}

/// The address bar's origin, reusing the element found last time for this window. A stale
/// element (the window closed or rebuilt its toolbar) is searched for again.
fn cached_origin(
    automation: &UIAutomation,
    known: &mut HashMap<isize, Omnibox>,
    hwnd: isize,
) -> BarRead {
    match known.get(&hwnd) {
        Some(Omnibox::Found(element)) => {
            let read = omnibox_read(element);
            if read != BarRead::default() || element.get_bounding_rectangle().is_ok() {
                // Still there, even when the address isn't a web page (a new tab).
                return read;
            }
        }
        Some(Omnibox::Missing(since)) if since.elapsed() < NO_OMNIBOX_RETRY => {
            return BarRead::default();
        }
        _ => {}
    }
    if known.len() > 64 {
        known.clear();
    }
    if let Some(element) = find_omnibox(automation, hwnd) {
        let read = omnibox_read(&element);
        known.insert(hwnd, Omnibox::Found(element));
        read
    } else {
        known.insert(hwnd, Omnibox::Missing(Instant::now()));
        BarRead::default()
    }
}

/// Chromium's native address bar: an edit with this class. Its automation id is a generated
/// `view_NNNN` value (`view_1021` in Edge), not its localized accessible name.
const NATIVE_OMNIBOX: &str = "OmniboxViewViews";
/// Chrome 155 draws the toolbar as a web page of its own inside this native view, and the address
/// bar there is a combo box. Web pages can't make native views, so only Chrome's own toolbar has
/// this class.
const WEB_UI_TOOLBAR: &str = "WebUIToolbarWebView";
/// Firefox's address bar: a combo box with this id in its own toolbar (checked in Firefox 143,
/// 04/10/2026). A web page could give an element the same id, but a page's elements are always
/// inside its document, which the browser's own toolbar isn't.
const FIREFOX_URLBAR: &str = "urlbar-input";

fn find_omnibox(automation: &UIAutomation, hwnd: isize) -> Option<UIElement> {
    use uiautomation::types::ControlType;
    let window = automation.element_from_handle(Handle::from(hwnd)).ok()?;
    let window_bounds = window.get_bounding_rectangle().ok()?;
    let class = |name: &str| {
        automation.create_property_condition(UIProperty::ClassName, Variant::from(name), None)
    };
    // One walk of the window's tree finds whichever toolbar this browser has.
    let firefox = automation
        .create_property_condition(
            UIProperty::AutomationId,
            Variant::from(FIREFOX_URLBAR),
            None,
        )
        .ok()?;
    let condition = automation
        .create_or_condition(
            automation
                .create_or_condition(class(NATIVE_OMNIBOX).ok()?, class(WEB_UI_TOOLBAR).ok()?)
                .ok()?,
            firefox,
        )
        .ok()?;
    let found = window.find_first(TreeScope::Descendants, &condition).ok()?;
    let element = if found.get_automation_id().ok().as_deref() == Some(FIREFOX_URLBAR) {
        if !matches!(
            found.get_control_type().ok()?,
            ControlType::ComboBox | ControlType::Edit
        ) || inside_document(automation, &found)
        {
            return None;
        }
        found
    } else if found.get_classname().ok()? == WEB_UI_TOOLBAR {
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

fn omnibox_read(element: &UIElement) -> BarRead {
    // While the address bar has the keyboard, what it holds may be a search being typed, not
    // the page's address; that it has the keyboard is what makes the next address a "Go to".
    let focused = element
        .get_property_value(UIProperty::HasKeyboardFocus)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok());
    match focused {
        Some(false) => BarRead {
            origin: omnibox_origin(element),
            focused: false,
        },
        Some(true) => BarRead {
            origin: None,
            focused: true,
        },
        None => BarRead::default(),
    }
}

fn omnibox_origin(element: &UIElement) -> Option<String> {
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

/// Whether an element is part of a web page (has a document above it), not the browser's own UI.
fn inside_document(automation: &UIAutomation, element: &UIElement) -> bool {
    let Ok(walker) = automation.get_control_view_walker() else {
        return true;
    };
    let mut current = element.clone();
    for _ in 0..32 {
        let Ok(parent) = walker.get_parent(&current) else {
            return false;
        };
        if parent.get_control_type().ok() == Some(uiautomation::types::ControlType::Document) {
            return true;
        }
        current = parent;
    }
    true
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
    LIGHT_DISMISS_IDS.contains(&automation_id)
}

/// The light-dismiss layer's automation ids. The TypeScript naming takes its "Close" off by the
/// same list; `packages/core/test-vectors/click-naming.json` holds both to it.
const LIGHT_DISMISS_IDS: &[&str] = &["Light Dismiss"];

/// A UI framework's names for its own hosts, squashed as `framework_name` compares them. The
/// TypeScript naming (`uia-adapter.ts`) takes the same names off an element; the shared test
/// vector `click-naming.json` holds both lists to it, so they can't drift apart.
const FRAMEWORK_NAMES: &[&str] = &[
    "popuphost",
    "desktopwindowxamlsource",
    "xamlexplorerhostislandwindow",
    "chrome_widgetwin_0",
    "chrome_widgetwin_1",
    "chromelegacywindow",
    "intermediated3dwindow",
    "windowsuicorecorewindow",
];

/// Names that are a UI framework's, not the app's: `PopupHost`, `Pop-upHost`,
/// `DesktopWindowXamlSource`, `Chrome_WidgetWin_1`, or a name that is just the class name.
fn framework_name(name: &str, class_name: &str) -> bool {
    let squashed: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase();
    FRAMEWORK_NAMES.contains(&squashed.as_str())
        || (!name.is_empty() && name == class_name && name.contains('_'))
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

/// Chrome (and Edge, Brave, Opera, Vivaldi) answers a hit test at once from what it already has:
/// the element its previous hit test found, when the point is inside that one's bounds, or else a
/// guess from the boxes in its tree that knows nothing of what's on top. It asks the page for the
/// real answer in the background. So a click got the previous click's button, the whole page, or
/// a tile under an open drop-down list (a hosting control panel, 05/10/2026). Asking after the
/// click is no cure: pages change as the button goes down, and the answer was the loading screen
/// the click brought up (the overlay test page, 06/10/2026). So the element is worked out before
/// the click: while the pointer rests over a Chromium window the worker asks twice (the first
/// question starts Chrome's real hit test, the second gets its answer), and a click on that very
/// pixel soon after is named from it (`Warmth`).
const CHROME_WARM_EVERY: Duration = Duration::from_millis(40);
/// A resting pointer's element is worked out again this often, for a page that changes under it
/// (a menu opening).
const CHROME_REWARM: Duration = Duration::from_millis(250);
/// How old the answer for a resting pointer may be and still name a click there.
const CHROME_WARM_KEPT: Duration = Duration::from_secs(3);

/// The browsers built on Chromium, whose hit test works this way.
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

/// What the worker knows about the element under a resting pointer in a Chromium window.
#[derive(Default)]
struct Warmth {
    /// Where the pointer was last asked about, and when.
    at: Option<(i32, i32)>,
    when: Option<Instant>,
    /// Chrome's settled answer there, once asked twice.
    facts: Option<(ElementFacts, Instant)>,
}

impl Warmth {
    /// The element under `(x, y)` worked out before a click there, while it's recent.
    fn answer_for(&self, x: i32, y: i32) -> Option<ElementFacts> {
        let (facts, when) = self.facts.as_ref()?;
        (self.at == Some((x, y)) && when.elapsed() < CHROME_WARM_KEPT).then(|| facts.clone())
    }
}

/// Works out the element under a resting pointer in a Chromium window, so a click there is named
/// from what it was before the click. Other apps are left alone: their hit test answers truly.
fn warm_chrome(automation: &UIAutomation, cache: &UICacheRequest, warmth: &mut Warmth) {
    let Some(point) = crate::platform::display::cursor_pos() else {
        return;
    };
    let moved = warmth.at != Some(point);
    if moved {
        warmth.facts = None;
    } else if warmth.facts.is_some()
        && warmth
            .when
            .is_some_and(|when| when.elapsed() < CHROME_REWARM)
    {
        return;
    }
    warmth.at = Some(point);
    warmth.when = Some(Instant::now());
    let chromium = crate::platform::window::root_window_at(point.0, point.1)
        .is_some_and(|window| is_chromium(window.exe_name()));
    if !chromium {
        return;
    }
    if moved {
        // The first question only starts Chrome's real hit test; its answer is a guess.
        let _ = automation.element_from_point(Point::new(point.0, point.1));
        return;
    }
    if let Ok((facts, _)) = element_at(automation, cache, point.0, point.1)
        && !chrome_guess(&facts, point.0, point.1)
    {
        warmth.facts = Some((facts, Instant::now()));
    }
}

/// A first answer from Chrome that is only its guess: the page, a pane, or nothing under the click.
fn chrome_guess(facts: &ElementFacts, x: i32, y: i32) -> bool {
    facts.framework_id == "Chrome"
        && (matches!(facts.control_type.as_str(), "Document" | "Pane")
            || (facts.name.is_empty() && facts.control_type == "Custom")
            || !contains(facts.bounds.as_ref(), x, y))
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
    // The pointer wasn't resting long enough for `warm_chrome`: one more look, kept only if it
    // finds something real under the click.
    if chrome_guess(&facts, x, y) {
        std::thread::sleep(Duration::from_millis(40));
        if let Ok(second) = lookup()
            && !chrome_guess(&second.1, x, y)
        {
            (element, facts) = second;
        }
        retried = true;
    }
    // Excel's hit test, in a sheet with a table and frozen panes, names a cell a few columns or
    // rows from the one clicked (E3 for a click in I4). Walking down from the window to find it
    // lists the table's hundreds of cells and took 250 ms, past the lookup's deadline, so those
    // clicks were named from the words on the screen (07/10/2026). Stepping across the grid from
    // the cell it named finds the right one in a few calls.
    if !contains(facts.bounds.as_ref(), x, y)
        && let Some(found) = grid_cell_at(&element, x, y)
        && let Ok(found) = found.build_updated_cache(cache)
    {
        let better = facts_from_cached(&found, &[]);
        if contains(better.bounds.as_ref(), x, y) {
            (element, facts) = (found, better);
        }
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
    // What the element is called, a framework's name or the light-dismiss layer's "Close"
    // included, is decided in TypeScript from these facts (docs/spec/02-capture.md#click-naming).
    facts.ancestors = parents_of(automation, cache, &element);
    Ok((facts, retried))
}

/// How many cells `grid_cell_at` steps across, and for how long, before it gives up: the whole
/// lookup has 350 ms, and the walk down from the window still follows if this finds nothing.
const GRID_STEPS: usize = 40;
const GRID_TIME: Duration = Duration::from_millis(120);

/// A UI Automation rectangle as the recorder's pixel rectangle.
fn px_rect(rect: &uiautomation::types::Rect) -> PxRect {
    PxRect {
        left: rect.get_left(),
        top: rect.get_top(),
        right: rect.get_right(),
        bottom: rect.get_bottom(),
    }
}

/// A cell's place in a grid, or a grid's size in cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cell {
    row: i32,
    column: i32,
}

/// The grid cell under a point, found by stepping from `cell` (a cell of the same grid, not
/// under it) towards the point (`grid_step`). `None` when `cell` isn't a grid item, or the point
/// isn't reached within `GRID_STEPS` and `GRID_TIME`.
fn grid_cell_at(cell: &UIElement, x: i32, y: i32) -> Option<UIElement> {
    let started = Instant::now();
    let item = cell.get_pattern::<UIGridItemPattern>().ok()?;
    let grid = item
        .get_containing_grid()
        .ok()?
        .get_pattern::<UIGridPattern>()
        .ok()?;
    let size = Cell {
        row: grid.get_row_count().ok()?,
        column: grid.get_column_count().ok()?,
    };
    let mut at = Cell {
        row: item.get_row().ok()?,
        column: item.get_column().ok()?,
    };
    let mut current = cell.clone();
    for _ in 0..GRID_STEPS {
        if started.elapsed() > GRID_TIME {
            return None;
        }
        let bounds = px_rect(&current.get_bounding_rectangle().ok()?);
        match grid_step(&bounds, at, size, x, y)? {
            GridStep::Here => return Some(current),
            GridStep::To(next) => {
                at = next;
                current = grid.get_item(at.row, at.column).ok()?;
            }
        }
    }
    None
}

/// Where `grid_cell_at` goes from a cell.
#[derive(Debug, PartialEq, Eq)]
enum GridStep {
    /// The point is in this cell.
    Here,
    /// The next cell to look at.
    To(Cell),
}

/// One step across a grid of `size` from the cell at `at` with `bounds`: a column and a row
/// nearer the point, or `Here` when the cell holds it. `None` when the step would leave the grid.
fn grid_step(bounds: &PxRect, at: Cell, size: Cell, x: i32, y: i32) -> Option<GridStep> {
    let toward = |point: i32, low: i32, high: i32, index: i32| {
        if point < low {
            index - 1
        } else if point >= high {
            index + 1
        } else {
            index
        }
    };
    // Excel's hit test leaves out how far the sheet is scrolled, so the cell it names can be one
    // scrolled out of view, with no bounds: the cells in view are further down and right. Which
    // of the two is out of view can't be told from an empty rectangle, so both are stepped, and
    // the steps after correct whichever was already in view.
    let next = if bounds.right <= bounds.left || bounds.bottom <= bounds.top {
        Cell {
            row: at.row + 1,
            column: at.column + 1,
        }
    } else {
        Cell {
            row: toward(y, bounds.top, bounds.bottom, at.row),
            column: toward(x, bounds.left, bounds.right, at.column),
        }
    };
    if next == at {
        return Some(GridStep::Here);
    }
    ((0..size.row).contains(&next.row) && (0..size.column).contains(&next.column))
        .then_some(GridStep::To(next))
}

/// The element's parents, nearest first, up to the window, the page or four
/// (`lookup::ancestors`), each read with its properties in one call.
fn parents_of(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    element: &UIElement,
) -> Vec<AncestorFacts> {
    let (Ok(walker), Ok(root)) = (
        automation.get_control_view_walker(),
        automation.get_root_element(),
    ) else {
        return Vec::new();
    };
    let mut current = element.clone();
    let parents = std::iter::from_fn(|| {
        let parent = walker.get_parent_build_cache(&current, cache).ok()?;
        // The desktop is above every window: never part of an app.
        if automation.compare_elements(&parent, &root).unwrap_or(true) {
            return None;
        }
        current = parent;
        Some(AncestorFacts {
            control_type: current
                .get_cached_control_type()
                .map(|control| format!("{control:?}"))
                .unwrap_or_default(),
            name: current.get_cached_name().unwrap_or_default(),
        })
    });
    crate::lookup::ancestors(parents)
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

/// Whether the focused element is a browser's address bar, the kinds `find_omnibox` finds: the
/// native omnibox edit, the combo box inside Chrome 155's own toolbar view, or Firefox's. What's
/// typed there is the address, and only its site is kept, by the "Go to" step: it's never a
/// typing step, which would keep the whole address (testing, 30/09/2026).
fn is_address_bar(automation: &UIAutomation, element: &UIElement, facts: &ElementFacts) -> bool {
    if facts.class_name == NATIVE_OMNIBOX {
        return true;
    }
    if facts.automation_id == FIREFOX_URLBAR {
        return !inside_document(automation, element);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cell_at(row: i32, column: i32) -> Cell {
        Cell { row, column }
    }

    fn cell(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn a_grid_step_moves_a_column_and_a_row_towards_the_point() {
        let e3 = cell(100, 100, 200, 150);
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 150, 120),
            Some(GridStep::Here)
        );
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 450, 170),
            Some(GridStep::To(cell_at(3, 5)))
        );
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 50, 120),
            Some(GridStep::To(cell_at(2, 3)))
        );
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 150, 99),
            Some(GridStep::To(cell_at(1, 4)))
        );
        // The right and bottom edges belong to the next cell, as the hit test has them.
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 200, 150),
            Some(GridStep::To(cell_at(3, 5)))
        );
    }

    #[test]
    fn a_cell_scrolled_out_of_view_steps_down_and_right_into_it() {
        // Excel named D3, scrolled out of view, for a click in H4 (07/10/2026).
        let hidden = cell(0, 0, 0, 0);
        assert_eq!(
            grid_step(&hidden, cell_at(2, 3), cell_at(30, 17), -1251, 924),
            Some(GridStep::To(cell_at(3, 4)))
        );
    }

    #[test]
    fn a_grid_step_never_leaves_the_grid() {
        let corner = cell(100, 100, 200, 150);
        assert_eq!(
            grid_step(&corner, cell_at(0, 0), cell_at(30, 17), 50, 50),
            None
        );
        assert_eq!(
            grid_step(&cell(0, 0, 0, 0), cell_at(29, 3), cell_at(30, 17), 0, 0),
            None
        );
    }

    /// Live check: prints what Steps reads from the address bar of every open Firefox, Chrome and
    /// Edge window. `cargo test -p capture reads_open_browsers_address_bars -- --ignored
    /// --nocapture`, with a browser open on a web page.
    #[test]
    #[ignore = "needs browser windows open on this desktop"]
    fn reads_open_browsers_address_bars() {
        let automation = UIAutomation::new().expect("UI Automation");
        let root = automation.get_root_element().expect("root");
        let windows = automation
            .create_true_condition()
            .and_then(|all| root.find_all(TreeScope::Children, &all))
            .expect("windows");
        let mut found = 0;
        for window in windows {
            let class = window.get_classname().unwrap_or_default();
            if class != "MozillaWindowClass" && class != "Chrome_WidgetWin_1" {
                continue;
            }
            let Ok(handle) = window.get_native_window_handle() else {
                continue;
            };
            let hwnd: isize = handle.into();
            let read = cached_origin(&automation, &mut HashMap::new(), hwnd);
            println!(
                "{class} {:?}: {read:?}",
                window.get_name().unwrap_or_default()
            );
            found += usize::from(read.origin.is_some() || read.focused);
        }
        assert!(found > 0, "no browser address bar was read");
    }

    /// `packages/core/test-vectors/click-naming.json`: what the TypeScript naming shares.
    fn shared_naming() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/click-naming.json"
        ))
        .unwrap()
    }

    fn strings(value: &serde_json::Value) -> Vec<&str> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect()
    }

    #[test]
    fn framework_names_and_light_dismiss_are_the_namings() {
        let shared = shared_naming();
        assert_eq!(strings(&shared["frameworkNames"]), FRAMEWORK_NAMES);
        assert_eq!(
            strings(&shared["lightDismissAutomationIds"]),
            LIGHT_DISMISS_IDS
        );
        for id in LIGHT_DISMISS_IDS {
            assert!(is_light_dismiss(id));
        }
        assert!(!is_light_dismiss("Close"));
    }

    #[test]
    fn framework_names_are_told_apart_as_the_naming_tells_them() {
        let shared = shared_naming();
        for case in shared["frameworkNameCases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let class_name = case["className"].as_str().unwrap();
            assert_eq!(
                framework_name(name, class_name),
                case["framework"].as_bool().unwrap(),
                "{name:?} (class {class_name:?})"
            );
        }
    }

    #[test]
    fn control_type_debug_names_are_plain() {
        assert_eq!(
            format!("{:?}", uiautomation::types::ControlType::Hyperlink),
            "Hyperlink"
        );
    }
}
