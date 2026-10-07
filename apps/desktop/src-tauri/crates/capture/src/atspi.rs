//! AT-SPI on its own threads (docs/spec/02-capture.md#linux-x11-phase-10): the Linux counterpart
//! of `uia.rs`, behind the same `UiaClient`, so the pipeline works the same on both.
//!
//! AT-SPI is the accessibility interface GTK, Qt, `LibreOffice`, Firefox and Chrome answer on
//! Linux, over its own D-Bus bus. An element's AT-SPI role is mapped to the UI Automation control
//! type that means the same (`push button` → `Button`, `entry` → `Edit`), so steps are worded by
//! the same rules as on Windows (`packages/core/src/step-text/uia-adapter.ts`), and what happens
//! to the element found is shared with Windows (`lookup.rs`).
//!
//! Chrome, and some other apps, only build their accessibility tree when an assistive tool is
//! on: `org.a11y.Status.IsEnabled` is switched on while a recording runs, and put back as it was
//! when it stops.

use std::cell::RefCell;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::coords::PxRect;
use crate::facts::{AncestorFacts, ElementFacts, InputRecord};
pub use crate::lookup::{FocusOptions, Lookup};
use crate::lookup::{
    Replies, Reply, await_worker_ready, fingerprint, fit_value, is_editable, origin_from_address,
    reading_blocked,
};
use crate::navigation::BarRead;
use crate::platform::window::WindowInfo;
use crate::screen_text::TerminalKind;
use crate::sensitive::{looks_sensitive, mask_value};

// ---------- the bus ----------

const REGISTRY: &str = "org.a11y.atspi.Registry";
const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const NULL_PATH: &str = "/org/a11y/atspi/null";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const COMPONENT: &str = "org.a11y.atspi.Component";
const TEXT: &str = "org.a11y.atspi.Text";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

/// Coordinates relative to the element's top-level window. Screen coordinates would be simpler,
/// but GTK 4 doesn't give them, and window coordinates work in every toolkit.
const WINDOW_COORDS: u32 = 1;

/// An accessible object: the app's bus name and the object's path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Element {
    bus: String,
    path: String,
}

impl Element {
    fn from_pair((bus, path): (String, OwnedObjectPath)) -> Option<Self> {
        let path = path.as_str().to_string();
        (!bus.is_empty() && path != NULL_PATH).then_some(Self { bus, path })
    }
}

/// The AT-SPI bus and the apps on it.
struct Bus {
    connection: Connection,
    /// Each app's bus name → its process id. Each bus belongs to one thread.
    apps: RefCell<HashMap<String, u32>>,
}

/// Where the session's accessibility switch was before a recording turned it on.
static ENABLED_BEFORE: Mutex<Option<bool>> = Mutex::new(None);

fn session_accessibility(session: &Connection) -> Option<bool> {
    let reply = session
        .call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some(PROPERTIES),
            "Get",
            &("org.a11y.Status", "IsEnabled"),
        )
        .ok()?;
    let value: OwnedValue = reply.body().deserialize().ok()?;
    bool::try_from(value).ok()
}

fn set_session_accessibility(session: &Connection, on: bool) {
    let _ = session.call_method(
        Some("org.a11y.Bus"),
        "/org/a11y/bus",
        Some(PROPERTIES),
        "Set",
        &("org.a11y.Status", "IsEnabled", Value::from(on)),
    );
}

/// Turns the session's accessibility on for a recording, remembering how it was.
fn switch_accessibility_on(session: &Connection) {
    let Ok(mut before) = ENABLED_BEFORE.lock() else {
        return;
    };
    if before.is_none() {
        let was = session_accessibility(session).unwrap_or(false);
        *before = Some(was);
        if !was {
            set_session_accessibility(session, true);
        }
    }
}

/// Puts the session's accessibility back as it was before the recording.
fn restore_accessibility() {
    let Ok(mut before) = ENABLED_BEFORE.lock() else {
        return;
    };
    if let Some(false) = before.take()
        && let Ok(session) = Connection::session()
    {
        set_session_accessibility(&session, false);
    }
}

impl Bus {
    /// Connects to the AT-SPI bus (its address comes from the session bus).
    fn connect() -> Result<Self, String> {
        let session = Connection::session().map_err(|error| format!("no session bus: {error}"))?;
        switch_accessibility_on(&session);
        let reply = session
            .call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.a11y.Bus"),
                "GetAddress",
                &(),
            )
            .map_err(|error| format!("no accessibility bus: {error}"))?;
        let address: String = reply
            .body()
            .deserialize()
            .map_err(|error| error.to_string())?;
        let connection = zbus::blocking::connection::Builder::address(address.as_str())
            .and_then(zbus::blocking::connection::Builder::build)
            .map_err(|error| format!("the accessibility bus refused us: {error}"))?;
        Ok(Self {
            connection,
            apps: RefCell::new(HashMap::new()),
        })
    }

    fn call<B, R>(&self, element: &Element, interface: &str, method: &str, body: &B) -> Option<R>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
        R: for<'de> serde::Deserialize<'de> + zbus::zvariant::Type,
    {
        let reply = self
            .connection
            .call_method(
                Some(element.bus.as_str()),
                element.path.as_str(),
                Some(interface),
                method,
                body,
            )
            .ok()?;
        reply.body().deserialize().ok()
    }

    fn property(&self, element: &Element, interface: &str, name: &str) -> Option<OwnedValue> {
        self.call(element, PROPERTIES, "Get", &(interface, name))
    }

    fn string_property(&self, element: &Element, name: &str) -> String {
        self.property(element, ACCESSIBLE, name)
            .and_then(|value| String::try_from(value).ok())
            .unwrap_or_default()
    }

    fn children(&self, element: &Element) -> Vec<Element> {
        self.call::<_, Vec<(String, OwnedObjectPath)>>(element, ACCESSIBLE, "GetChildren", &())
            .unwrap_or_default()
            .into_iter()
            .filter_map(Element::from_pair)
            .collect()
    }

    fn parent(&self, element: &Element) -> Option<Element> {
        let value = self.property(element, ACCESSIBLE, "Parent")?;
        let Value::Structure(structure) = &*value else {
            return None;
        };
        match structure.fields() {
            [Value::Str(bus), Value::ObjectPath(path)] => {
                let path = path.as_str();
                (path != NULL_PATH && path != ROOT_PATH).then(|| Element {
                    bus: bus.to_string(),
                    path: path.to_string(),
                })
            }
            _ => None,
        }
    }

    fn role_name(&self, element: &Element) -> String {
        self.call(element, ACCESSIBLE, "GetRoleName", &())
            .unwrap_or_default()
    }

    fn states(&self, element: &Element) -> States {
        States(
            self.call::<_, Vec<u32>>(element, ACCESSIBLE, "GetState", &())
                .unwrap_or_default(),
        )
    }

    fn attributes(&self, element: &Element) -> HashMap<String, String> {
        self.call(element, ACCESSIBLE, "GetAttributes", &())
            .unwrap_or_default()
    }

    /// The name of the element this one is labelled by, if any.
    fn labelled_by(&self, element: &Element) -> Option<String> {
        const LABELLED_BY: u32 = 2;
        let relations: Vec<(u32, Vec<(String, OwnedObjectPath)>)> =
            self.call(element, ACCESSIBLE, "GetRelationSet", &())?;
        relations
            .into_iter()
            .filter(|(kind, _)| *kind == LABELLED_BY)
            .flat_map(|(_, targets)| targets)
            .filter_map(Element::from_pair)
            .map(|label| self.string_property(&label, "Name"))
            .find(|name| !name.trim().is_empty())
    }

    /// Extents in window coordinates.
    fn extents(&self, element: &Element) -> Option<(i32, i32, i32, i32)> {
        self.call(element, COMPONENT, "GetExtents", &(WINDOW_COORDS,))
    }

    fn child_at(&self, element: &Element, x: i32, y: i32) -> Option<Element> {
        self.call::<_, (String, OwnedObjectPath)>(
            element,
            COMPONENT,
            "GetAccessibleAtPoint",
            &(x, y, WINDOW_COORDS),
        )
        .and_then(Element::from_pair)
    }

    fn text(&self, element: &Element) -> Option<String> {
        let count = self
            .property(element, TEXT, "CharacterCount")
            .and_then(|value| i32::try_from(value).ok())?;
        self.call(element, TEXT, "GetText", &(0i32, count))
    }

    /// The toolkit an app is built with (`GTK`, `Chromium`, `Gecko`, `Qt`, `LibreOffice`).
    fn toolkit(&self, bus: &str) -> String {
        let root = Element {
            bus: bus.to_string(),
            path: ROOT_PATH.to_string(),
        };
        self.property(&root, "org.a11y.atspi.Application", "ToolkitName")
            .and_then(|value| String::try_from(value).ok())
            .unwrap_or_default()
    }

    fn pid_of(&self, bus: &str) -> Option<u32> {
        let reply = self
            .connection
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetConnectionUnixProcessID",
                &(bus,),
            )
            .ok()?;
        reply.body().deserialize().ok()
    }

    /// The accessible app for a process, asking the registry again if it isn't known yet.
    fn app_for(&self, pid: u32) -> Option<String> {
        let find = |apps: &HashMap<String, u32>| {
            apps.iter()
                .find(|(_, app_pid)| **app_pid == pid)
                .map(|(bus, _)| bus.clone())
        };
        if let Some(bus) = find(&self.apps.borrow()) {
            return Some(bus);
        }
        let root = Element {
            bus: REGISTRY.to_string(),
            path: ROOT_PATH.to_string(),
        };
        let apps: HashMap<String, u32> = self
            .children(&root)
            .into_iter()
            .filter_map(|app| Some((app.bus.clone(), self.pid_of(&app.bus)?)))
            .collect();
        let bus = find(&apps);
        *self.apps.borrow_mut() = apps;
        bus
    }

    /// The app's top-level accessible for a window: the one with the window's title, else the
    /// active one, else the first showing.
    fn top_level(&self, window: &WindowInfo) -> Option<Element> {
        let bus = self.app_for(window.pid)?;
        let root = Element {
            bus,
            path: ROOT_PATH.to_string(),
        };
        let tops = self.children(&root);
        let titled = tops
            .iter()
            .find(|top| self.string_property(top, "Name") == window.title);
        if let Some(top) = titled {
            return Some(top.clone());
        }
        let active = tops.iter().find(|top| self.states(top).has(State::Active));
        if let Some(top) = active {
            return Some(top.clone());
        }
        tops.iter()
            .find(|top| self.states(top).has(State::Showing))
            .cloned()
    }
}

// ---------- roles and states ----------

/// AT-SPI states (`AtspiStateType`) this module asks about.
#[derive(Debug, Clone, Copy)]
enum State {
    Active = 1,
    Editable = 7,
    Focused = 12,
    Showing = 25,
    ReadOnly = 43,
}

/// An element's state set, as `GetState` gives it: two 32-bit words.
struct States(Vec<u32>);

impl States {
    fn has(&self, state: State) -> bool {
        let bit = state as u32;
        self.0
            .get(usize::try_from(bit / 32).unwrap_or(usize::MAX))
            .is_some_and(|word| word & (1 << (bit % 32)) != 0)
    }
}

/// The UI Automation control type for an AT-SPI role (`GetRoleName`, which isn't translated).
/// Newer AT-SPI (2.60, checked 30/09/2026) names push buttons `button`.
fn control_type(role: &str, editable: bool) -> &'static str {
    match role {
        "push button" | "button" | "toggle button" | "push button menu" => "Button",
        "check box" | "check menu item" => "CheckBox",
        "radio button" => "RadioButton",
        "link" => "Hyperlink",
        "entry" | "password text" | "spin button" | "editbar" => "Edit",
        "text" | "paragraph" | "section" if editable => "Edit",
        "combo box" => "ComboBox",
        "menu item" | "radio menu item" | "menu" | "tearoff menu item" => "MenuItem",
        "page tab" => "TabItem",
        "list item" => "ListItem",
        "tree item" => "TreeItem",
        "table row" => "DataItem",
        "table cell" | "label" | "static" | "text" | "heading" | "paragraph" | "caption"
        | "accelerator label" => "Text",
        "image" | "icon" | "image map" => "Image",
        "document web"
        | "document text"
        | "document frame"
        | "document spreadsheet"
        | "document presentation"
        | "document email"
        | "terminal" => "Document",
        "frame" | "window" | "dialog" | "alert" | "file chooser" => "Window",
        "menu bar" => "MenuBar",
        "tool bar" => "ToolBar",
        "list" | "list box" => "List",
        "tree" | "tree table" => "Tree",
        "table" => "Table",
        "slider" => "Slider",
        "scroll bar" => "ScrollBar",
        "status bar" => "StatusBar",
        "page tab list" => "Tab",
        "progress bar" | "level bar" => "ProgressBar",
        "separator" => "Separator",
        "panel" | "filler" | "grouping" | "section" | "form" | "landmark" | "article" => "Group",
        _ => "Custom",
    }
}

/// The toolkit as UI Automation's framework id names it, where the wording rules care.
fn framework(toolkit: &str) -> String {
    match toolkit {
        "Chromium" | "Chrome" => "Chrome".into(),
        other => other.to_string(),
    }
}

// ---------- element facts ----------

fn facts_for(
    bus: &Bus,
    element: &Element,
    extra_terms: &[String],
    origin: (i32, i32),
) -> ElementFacts {
    let role = bus.role_name(element);
    let states = bus.states(element);
    let attributes = bus.attributes(element);
    let control = control_type(&role, states.has(State::Editable));
    let is_password = role == "password text";
    let attribute = |name: &str| attributes.get(name).cloned().unwrap_or_default();
    let description = bus.string_property(element, "Description");
    let help_text = if description.trim().is_empty() {
        attribute("placeholder-text")
    } else {
        description
    };
    let bounds = bus.extents(element).map(|(x, y, width, height)| PxRect {
        left: origin.0 + x,
        top: origin.1 + y,
        right: origin.0 + x + width,
        bottom: origin.1 + y + height,
    });
    let mut facts = ElementFacts {
        control_type: control.to_string(),
        localized_control_type: bus
            .call(element, ACCESSIBLE, "GetLocalizedRoleName", &())
            .unwrap_or_default(),
        name: bus.string_property(element, "Name"),
        automation_id: attribute("id"),
        help_text,
        aria_role: attribute("xml-roles"),
        aria_properties: if states.has(State::ReadOnly) {
            "readonly=true".into()
        } else {
            String::new()
        },
        class_name: attribute("class"),
        framework_id: framework(&bus.toolkit(&element.bus)),
        is_password,
        labeled_by: bus.labelled_by(element),
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

/// Chrome builds its accessibility tree only when asked; the first lookup can find an empty
/// document or group.
fn looks_unbuilt(facts: &ElementFacts) -> bool {
    facts.name.is_empty()
        && facts.framework_id == "Chrome"
        && matches!(
            facts.control_type.as_str(),
            "Window" | "Document" | "Custom" | "Group"
        )
}

/// The largest title bar or border believed when placing a window's coordinates.
const MAX_DECORATION: i32 = 200;

/// Where on the screen an app's AT-SPI "window" coordinates count from. Most toolkits count
/// from the window's client area, but Firefox counts from the outside of the title bar, so its
/// top-level sits at the title bar's size (1, 20 under openbox); the top-level's own position
/// says which. A toolkit that doesn't know answers -1, read as the client area.
fn window_origin(
    bus: &Bus,
    top: Option<&Element>,
    client_left: i32,
    client_top: i32,
) -> (i32, i32) {
    let (x, y) = top
        .and_then(|top| bus.extents(top))
        .map_or((0, 0), |(x, y, _, _)| (x, y));
    let believed = |value: i32| {
        if (0..=MAX_DECORATION).contains(&value) {
            value
        } else {
            0
        }
    };
    (client_left - believed(x), client_top - believed(y))
}

/// The deepest element under a window point.
fn deepest_at(bus: &Bus, top: &Element, x: i32, y: i32) -> Element {
    let mut current = top.clone();
    // Trees are rarely deeper than 30; the limit guards against a loop.
    for _ in 0..64 {
        match bus.child_at(&current, x, y) {
            Some(child) if child != current => current = child,
            _ => break,
        }
    }
    current
}

/// The pauses before looking again when a lookup finds only the window or an unbuilt tree, kept
/// well inside the lookup's 150 ms.
const RETRY_WAITS: [Duration; 2] = [Duration::from_millis(30), Duration::from_millis(50)];

fn element_at(bus: &Bus, x: i32, y: i32) -> Result<(ElementFacts, bool), String> {
    let window = crate::platform::window::root_window_at(x, y)
        .ok_or_else(|| "no window at the point".to_string())?;
    let client = crate::platform::window::client_area(window.hwnd)
        .ok_or_else(|| "the window has gone".to_string())?;
    let top = bus
        .top_level(&window)
        .ok_or_else(|| "the app doesn't answer AT-SPI".to_string())?;
    let origin = window_origin(bus, Some(&top), client.left, client.top);
    let (local_x, local_y) = (x - origin.0, y - origin.1);

    let mut element = deepest_at(bus, &top, local_x, local_y);
    let mut facts = facts_for(bus, &element, &[], origin);
    let mut retried = false;
    // Firefox answers the first hit-test after accessibility comes on with nothing, which leaves
    // the window itself, and Chrome builds its tree only once asked: a moment later, it's there.
    for wait in RETRY_WAITS {
        if element != top && !looks_unbuilt(&facts) {
            break;
        }
        std::thread::sleep(wait);
        element = deepest_at(bus, &top, local_x, local_y);
        facts = facts_for(bus, &element, &[], origin);
        retried = true;
    }
    // What the element is called is decided in TypeScript from these facts
    // (docs/spec/02-capture.md#click-naming).
    let mut current = element;
    let parents = std::iter::from_fn(|| {
        current = bus.parent(&current)?;
        Some(AncestorFacts {
            control_type: control_type(
                &bus.role_name(&current),
                bus.states(&current).has(State::Editable),
            )
            .to_string(),
            name: bus.string_property(&current, "Name"),
        })
    });
    facts.ancestors = crate::lookup::ancestors(parents);
    Ok((facts, retried))
}

// ---------- the client ----------

enum Request {
    At { id: u64, x: i32, y: i32 },
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

/// Handle to the AT-SPI worker threads.
pub struct UiaClient {
    requests: Sender<Request>,
    replies: Replies,
    origin_requests: Sender<OriginRequest>,
    origin_replies: Receiver<OriginReply>,
    cancelled: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    origin_thread: Option<JoinHandle<()>>,
    focus: Option<FocusListener>,
    entered: crate::lookup::FieldSlot,
}

const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

impl UiaClient {
    /// Starts the worker. If `focus` is given, field values are reported through it on
    /// focus-leave.
    ///
    /// # Errors
    /// If there's no session bus or accessibility bus.
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
        let thread = std::thread::Builder::new()
            .name("amluto-atspi".into())
            .spawn(move || worker(&request_rx, &reply_tx, &ready_tx))
            .map_err(|error| error.to_string())?;
        await_worker_ready(
            &ready_rx,
            &cancelled,
            STARTUP_TIMEOUT,
            "AT-SPI did not become ready within five seconds",
        )?;
        let origin_thread = std::thread::Builder::new()
            .name("amluto-atspi-origin".into())
            .spawn(move || origin_worker(&origin_request_rx, &origin_tx))
            .ok();
        let focus = focus.and_then(|(sender, options)| {
            FocusListener::start(sender, options, Arc::clone(&cancelled))
        });
        Ok(Self {
            entered,
            requests: request_tx,
            replies: Replies { receiver: reply_rx },
            origin_requests: origin_request_tx,
            origin_replies: origin_rx,
            cancelled,
            thread: Some(thread),
            origin_thread,
            focus,
        })
    }

    /// Asks for the element at a screen point. Returns immediately.
    /// `hwnd` is the window under the click when it was taken; AT-SPI reads are quick enough that
    /// Linux doesn't check it again.
    pub fn request(&self, id: u64, x: i32, y: i32, _hwnd: isize) {
        let _ = self.requests.send(Request::At { id, x, y });
    }

    /// Requests the current address-bar origin from a Chrome or Edge window.
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

    /// Returns a completed result for this navigation query without waiting.
    #[must_use]
    pub fn take_browser_origin(&self, id: u64) -> Option<BarRead> {
        while let Ok(reply) = self.origin_replies.try_recv() {
            if reply.id == id {
                return Some(reply.read);
            }
        }
        None
    }

    /// Waits for the reply to `id` until `deadline`, discarding replies for older clicks.
    #[must_use]
    pub fn wait(&self, id: u64, started: Instant, deadline: Instant) -> Lookup {
        self.replies
            .wait(id, started, deadline, "AT-SPI worker stopped")
    }
}

impl Drop for UiaClient {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let _ = self.requests.send(Request::Stop);
        let _ = self.origin_requests.send(OriginRequest::Stop);
        if let Some(focus) = self.focus.take() {
            focus.stop();
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Some(thread) = self.origin_thread.take() {
            let _ = thread.join();
        }
        restore_accessibility();
    }
}

fn worker(
    requests: &Receiver<Request>,
    replies: &Sender<Reply>,
    ready: &Sender<Result<(), String>>,
) {
    let bus = match Bus::connect() {
        Ok(bus) => bus,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    while let Ok(request) = requests.recv() {
        match request {
            Request::At { id, x, y } => {
                let started = Instant::now();
                // A panic in a lookup loses that click's name, not the thread.
                let result = catch_unwind(AssertUnwindSafe(|| element_at(&bus, x, y)))
                    .unwrap_or_else(|_| Err("the lookup failed".into()));
                let _ = replies.send(Reply {
                    id,
                    result,
                    elapsed: started.elapsed(),
                });
            }
            Request::Stop => break,
        }
    }
}

// ---------- browser address bars ----------

/// How long a window without an address bar (an installed web app) is left before it is
/// searched again.
const NO_OMNIBOX_RETRY: Duration = Duration::from_secs(30);
/// A window with nothing in it yet is searched again sooner: Chrome on Linux shows nothing of
/// itself until its accessibility comes on, which a lookup in it sets off.
const UNBUILT_RETRY: Duration = Duration::from_secs(2);

enum Omnibox {
    Found(Element),
    /// Not found at `since`; searched for again after `again`.
    Missing {
        since: Instant,
        again: Duration,
    },
}

fn origin_worker(requests: &Receiver<OriginRequest>, replies: &Sender<OriginReply>) {
    let bus = Bus::connect().ok();
    let mut known: HashMap<isize, Omnibox> = HashMap::new();
    while let Ok(OriginRequest::Read { id, hwnd }) = requests.recv() {
        let read = bus
            .as_ref()
            .and_then(|bus| {
                catch_unwind(AssertUnwindSafe(|| cached_origin(bus, &mut known, hwnd))).ok()
            })
            .unwrap_or_default();
        let _ = replies.send(OriginReply { id, read });
    }
}

/// The address bar's origin, and whether it has the keyboard: while it has, what it holds may be
/// a search being typed, and that it has is what makes the next address a "Go to".
fn omnibox_read(bus: &Bus, element: &Element) -> Option<BarRead> {
    if bus.states(element).has(State::Focused) {
        return Some(BarRead {
            origin: None,
            focused: true,
        });
    }
    let text = bus.text(element)?;
    Some(BarRead {
        origin: origin_from_address(&text),
        focused: false,
    })
}

fn cached_origin(bus: &Bus, known: &mut HashMap<isize, Omnibox>, hwnd: isize) -> BarRead {
    if let Some(Omnibox::Found(element)) = known.get(&hwnd)
        && let Some(read) = omnibox_read(bus, element)
    {
        return read;
    }
    if let Some(Omnibox::Missing { since, again }) = known.get(&hwnd)
        && since.elapsed() < *again
    {
        return BarRead::default();
    }
    if known.len() > 32 {
        known.clear();
    }
    let Some(window) = crate::platform::window::window_info(hwnd) else {
        return BarRead::default();
    };
    let Some(top) = bus.top_level(&window) else {
        return BarRead::default();
    };
    let Some(omnibox) = find_omnibox(bus, &top) else {
        let again = if bus.children(&top).is_empty() {
            UNBUILT_RETRY
        } else {
            NO_OMNIBOX_RETRY
        };
        let since = Instant::now();
        known.insert(hwnd, Omnibox::Missing { since, again });
        return BarRead::default();
    };
    let read = omnibox_read(bus, &omnibox).unwrap_or_default();
    known.insert(hwnd, Omnibox::Found(omnibox));
    read
}

/// Whether an entry is the browser's address bar, by its name or the omnibox's class, or
/// Firefox's, by its id (a combo box in Firefox 143 on Windows, 04/10/2026). Pages' own elements
/// are never searched (see `find_omnibox`), so a page can't pass for one.
fn is_omnibox(bus: &Bus, element: &Element) -> bool {
    let role = bus.role_name(element);
    if role != "entry" && role != "combo box" {
        return false;
    }
    let mut attributes = bus.attributes(element);
    if attributes.remove("id").as_deref() == Some("urlbar-input") {
        return true;
    }
    if role != "entry" {
        return false;
    }
    let name = bus.string_property(element, "Name");
    let class = attributes.remove("class").unwrap_or_default();
    name == "Address and search bar" || class.contains("Omnibox")
}

/// Chrome's and Edge's address bar: an entry in the browser's own toolbar, named "Address and
/// search bar" (in English) or carrying the omnibox's class. Pages' own entries are further down
/// the tree, inside the web document, which isn't searched.
fn find_omnibox(bus: &Bus, top: &Element) -> Option<Element> {
    let mut queue = std::collections::VecDeque::from([(top.clone(), 0usize)]);
    let mut visited = 0usize;
    while let Some((element, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 2_000 {
            return None;
        }
        let role = bus.role_name(&element);
        if role == "document web" {
            continue;
        }
        if (role == "entry" || role == "combo box") && is_omnibox(bus, &element) {
            return Some(element);
        }
        if depth < 20 {
            queue.extend(
                bus.children(&element)
                    .into_iter()
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    None
}

// ---------- focus-leave field values ----------

/// The field that currently has focus, remembered until focus moves on.
struct Focused {
    element: Element,
    facts: ElementFacts,
    initial: Option<String>,
    /// Without "Record what's typed": a fingerprint of the value when focus arrived, so a field
    /// left unchanged makes no step. The value itself is never kept.
    fingerprint: Option<u64>,
    editable: bool,
    pid: u32,
    since_tick_ms: u32,
    window_pid: u32,
    window_exe: Option<String>,
    window: Option<WindowInfo>,
}

/// Listens for focus changes on its own connection and thread.
struct FocusListener {
    connection: Connection,
    thread: JoinHandle<()>,
}

impl FocusListener {
    fn start(
        sender: Sender<InputRecord>,
        options: FocusOptions,
        cancelled: Arc<AtomicBool>,
    ) -> Option<Self> {
        let bus = Bus::connect().ok()?;
        register_focus_events(&bus);
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.a11y.atspi.Event.Object")
            .ok()?
            .member("StateChanged")
            .ok()?
            .build();
        let messages = MessageIterator::for_match_rule(rule, &bus.connection, Some(256)).ok()?;
        let connection = bus.connection.clone();
        let thread = std::thread::Builder::new()
            .name("amluto-atspi-focus".into())
            .spawn(move || {
                let mut focused: Option<Focused> = None;
                for message in messages {
                    if cancelled.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(message) = message else { break };
                    let Some(element) = focused_element(&message) else {
                        continue;
                    };
                    let _ = catch_unwind(AssertUnwindSafe(|| {
                        on_focus_changed(&bus, &element, &mut focused, &sender, &options);
                    }));
                }
            })
            .ok()?;
        Some(Self { connection, thread })
    }

    fn stop(self) {
        // Closing the connection ends the message iterator, and with it the thread.
        let _ = self.connection.close();
        let _ = self.thread.join();
    }
}

/// Asks apps to send focus changes: they only send the events some client registered for.
fn register_focus_events(bus: &Bus) {
    let registry = Element {
        bus: REGISTRY.to_string(),
        path: "/org/a11y/atspi/registry".to_string(),
    };
    let event = "object:state-changed:focused";
    // Newer registries take the properties to send with each event and an app filter.
    let newer: Option<()> = bus.call(
        &registry,
        "org.a11y.atspi.Registry",
        "RegisterEvent",
        &(event, Vec::<String>::new(), ""),
    );
    if newer.is_none() {
        let _: Option<()> = bus.call(
            &registry,
            "org.a11y.atspi.Registry",
            "RegisterEvent",
            &(event,),
        );
    }
}

/// The element a "focused" state change is about, when it gained focus.
fn focused_element(message: &zbus::Message) -> Option<Element> {
    let header = message.header();
    let body = message.body();
    // `siiva{sv}` in current AT-SPI, `siiv(so)` in older versions.
    let (kind, gained) = body
        .deserialize::<(String, i32, i32, OwnedValue, HashMap<String, OwnedValue>)>()
        .map(|(kind, gained, ..)| (kind, gained))
        .or_else(|_| {
            body.deserialize::<(String, i32, i32, OwnedValue, (String, OwnedObjectPath))>()
                .map(|(kind, gained, ..)| (kind, gained))
        })
        .ok()?;
    if kind != "focused" || gained != 1 {
        return None;
    }
    Some(Element {
        bus: header.sender()?.to_string(),
        path: header.path()?.to_string(),
    })
}

fn read_value(bus: &Bus, element: &Element) -> Option<String> {
    bus.text(element)
}

/// Focus moved: report the field it left (if its value changed), then remember the new one.
fn on_focus_changed(
    bus: &Bus,
    element: &Element,
    current: &mut Option<Focused>,
    sender: &Sender<InputRecord>,
    options: &FocusOptions,
) {
    // GTK can say twice that focus arrived in a field; focus hasn't left it in between.
    if current
        .as_ref()
        .is_some_and(|focused| focused.element == *element)
    {
        return;
    }
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
            // Only a changed value (or one that can't be compared) is a typing step.
            let unchanged = previous.fingerprint.is_some_and(|before| {
                read_value(bus, &previous.element)
                    .as_deref()
                    .map(fingerprint)
                    == Some(before)
            });
            if unchanged {
                (None, None)
            } else {
                (None, Some("setting-off"))
            }
        } else {
            match read_value(bus, &previous.element) {
                // Masked here, so the unmasked value never leaves the worker.
                Some(value) if Some(&value) != previous.initial.as_ref() => {
                    (Some(fit_value(mask_value(&value))), None)
                }
                Some(_) => (None, None),
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
        let covered_by_keys = options.note.is_some() && record.withheld == Some("unreadable");
        if (record.value.is_some() || record.withheld.is_some()) && !covered_by_keys {
            let _ = sender.send(record);
        }
    }
    let focused = remember(bus, element, options);
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
fn remember(bus: &Bus, element: &Element, options: &FocusOptions) -> Focused {
    let window = crate::platform::window::foreground_window();
    let origin = window
        .as_ref()
        .and_then(|window| {
            let client = crate::platform::window::client_area(window.hwnd)?;
            let top = bus.top_level(window);
            Some(window_origin(bus, top.as_ref(), client.left, client.top))
        })
        .unwrap_or((0, 0));
    let mut facts = facts_for(bus, element, &options.extra_sensitive_terms, origin);
    // A window titled for a password ("Set Password"): its boxes are kept out even when they don't
    // say they're one (F021). The keys were already; now the value read when focus leaves is too.
    if window.as_ref().is_some_and(|window| {
        crate::sensitive::looks_sensitive(&[window.title.as_str()], &options.extra_sensitive_terms)
    }) {
        facts.sensitive = true;
    }
    let pid = bus.pid_of(&element.bus).unwrap_or(0);
    let blocked = reading_blocked(options, pid, window.as_ref());
    let code_editor = window
        .as_ref()
        .and_then(WindowInfo::exe_name)
        .is_some_and(crate::typing::is_code_editor);
    // Chrome's and Edge's address bar, as `find_omnibox` finds it: what's typed there is the
    // address, kept only as the "Go to" step's site, never as a typing step.
    let address_bar = is_omnibox(bus, element);
    let editable = !blocked && !code_editor && !address_bar && is_editable(&facts);
    let readable = editable && !facts.sensitive;
    let value_now = if readable {
        read_value(bus, element)
    } else {
        None
    };
    if let Some(note) = &options.note {
        let mut note = note
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        note.generation = note.generation.wrapping_add(1);
        note.window = window.as_ref().map_or(0, |window| window.hwnd);
        note.facts = facts.clone();
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

// ---------- terminal text ----------

/// Text read from terminals for keystroke capture (see `screen_text.rs`): VTE terminals expose
/// their screen through AT-SPI's text interface.
pub struct ScreenText {
    bus: Bus,
}

/// The most rows of a terminal read: its visible screen and a little scrollback.
const TERMINAL_ROWS: usize = 200;

impl ScreenText {
    /// `None` if there's no accessibility bus; commands are then not read, and typing still is.
    #[must_use]
    pub fn new() -> Option<Self> {
        Some(Self {
            bus: Bus::connect().ok()?,
        })
    }

    /// The text a terminal window shows now: its last rows, one per line.
    #[must_use]
    pub fn terminal(&self, hwnd: isize, kind: TerminalKind) -> Option<String> {
        if kind != TerminalKind::Vte {
            return None;
        }
        let window = crate::platform::window::window_info(hwnd)?;
        let top = self.bus.top_level(&window)?;
        let terminal = find_terminal(&self.bus, &top)?;
        let text = self.bus.text(&terminal)?;
        let rows: Vec<&str> = text.lines().collect();
        let start = rows.len().saturating_sub(TERMINAL_ROWS);
        Some(rows[start..].join("\n"))
    }

    /// Excel's formula bar: there's no Excel on Linux.
    pub fn formula_bar(&mut self, _hwnd: isize) -> Option<String> {
        None
    }
}

/// The terminal in a window: the focused one when there are several (tabs, split panes).
fn find_terminal(bus: &Bus, top: &Element) -> Option<Element> {
    let mut queue = std::collections::VecDeque::from([(top.clone(), 0usize)]);
    let mut first = None;
    let mut visited = 0usize;
    while let Some((element, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 1_000 {
            break;
        }
        if bus.role_name(&element) == "terminal" {
            if bus.states(&element).has(State::Focused) {
                return Some(element);
            }
            first.get_or_insert(element.clone());
        }
        if depth < 25 {
            queue.extend(
                bus.children(&element)
                    .into_iter()
                    .map(|child| (child, depth + 1)),
            );
        }
    }
    first
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_read_as_ui_automation_control_types() {
        assert_eq!(control_type("push button", false), "Button");
        assert_eq!(control_type("button", false), "Button");
        assert_eq!(control_type("entry", false), "Edit");
        assert_eq!(control_type("password text", false), "Edit");
        assert_eq!(control_type("link", false), "Hyperlink");
        assert_eq!(control_type("check box", false), "CheckBox");
        assert_eq!(control_type("menu item", false), "MenuItem");
        assert_eq!(control_type("page tab", false), "TabItem");
        assert_eq!(control_type("label", false), "Text");
        // Rich text people type into is a field; the same role read-only is text.
        assert_eq!(control_type("paragraph", true), "Edit");
        assert_eq!(control_type("paragraph", false), "Text");
        assert_eq!(control_type("something new", false), "Custom");
    }

    #[test]
    fn states_are_read_from_both_words() {
        let states = States(vec![1 << 12 | 1 << 1, 1 << (43 - 32)]);
        assert!(states.has(State::Focused));
        assert!(states.has(State::Active));
        assert!(states.has(State::ReadOnly));
        assert!(!states.has(State::Editable));
        assert!(!States(Vec::new()).has(State::Showing));
    }

    #[test]
    fn chromes_toolkit_reads_as_ui_automations_framework() {
        assert_eq!(framework("Chromium"), "Chrome");
        assert_eq!(framework("GTK"), "GTK");
        assert!(looks_unbuilt(&ElementFacts {
            control_type: "Document".into(),
            framework_id: "Chrome".into(),
            ..ElementFacts::default()
        }));
    }

    #[test]
    fn the_null_object_is_no_element() {
        let null = OwnedObjectPath::try_from(NULL_PATH).unwrap();
        assert_eq!(Element::from_pair((":1.5".into(), null)), None);
        let path = OwnedObjectPath::try_from("/org/a11y/atspi/accessible/12").unwrap();
        assert!(Element::from_pair((":1.5".into(), path)).is_some());
    }
}
