//! What the element lookups share on every platform (docs/spec/02-capture.md#on-each-click):
//! how a lookup's reply is waited for, and the rules for reading a field's value. UI Automation
//! (`uia.rs`) and AT-SPI (`atspi.rs`) each find the element; these decide what happens to it.
//!
//! Lookups are asynchronous: the pipeline sends a request, takes the screenshot, then waits for
//! the reply until a deadline. A reply that arrives after the deadline belongs to an old click id
//! and is discarded, so late results can never land on the wrong click.

use std::hash::{BuildHasher, RandomState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::facts::{AncestorFacts, ElementFacts};
use crate::platform::window::WindowInfo;
use crate::state_machine::RecorderStateMachine;

/// How the element lookup for one click ended.
#[allow(
    clippy::large_enum_variant,
    reason = "one per click; boxing buys nothing"
)]
#[derive(Debug, Clone, PartialEq)]
pub enum Lookup {
    Found {
        facts: ElementFacts,
        ms: f64,
        retried: bool,
        /// Read under the resting pointer before the click, not after it (`pre_read.rs`).
        pre_read: bool,
    },
    Failed {
        error: String,
        ms: f64,
    },
    TimedOut {
        ms: f64,
    },
}

/// Settings for field-value capture on focus-leave.
#[derive(Debug, Clone, Default)]
pub struct FocusOptions {
    /// "Record what's typed". When off, input records carry no value.
    pub record_values: bool,
    /// Where the key worker learns what has focus (only when keys are recorded).
    pub note: Option<crate::typing::SharedFocus>,
    /// Extra sensitive words from IT policy.
    pub extra_sensitive_terms: Vec<String>,
    /// The recording's state machine: fields are only read while it records, and never in an
    /// app it excludes. `None` (the prototype) reads everywhere but our own windows.
    pub machine: Option<Arc<Mutex<RecorderStateMachine>>>,
    /// Where the focus worker leaves word of an editable field gaining focus, for the pipeline to
    /// take its screenshot then, before anything is typed (04/10/2026).
    pub entered: FieldSlot,
}

/// An editable field gained focus: when, and in which window.
#[derive(Debug, Clone)]
pub struct FieldEntered {
    pub tick_ms: u32,
    pub window: WindowInfo,
}

/// The latest field to gain focus, until the pipeline takes it.
pub type FieldSlot = Arc<Mutex<Option<FieldEntered>>>;

/// Leaves word that `focused` gained focus, if it's a field whose value may be recorded.
pub(crate) fn note_entered(slot: &FieldSlot, tick_ms: u32, window: Option<&WindowInfo>) {
    if let Some(window) = window {
        *slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(FieldEntered {
            tick_ms,
            window: window.clone(),
        });
    }
}

/// The element a lookup found, and how.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answer {
    pub facts: ElementFacts,
    /// Asked a second time: Chrome's first answer was its guess.
    pub retried: bool,
    /// Read under the resting pointer before the click (`pre_read.rs`), not after it.
    pub pre_read: bool,
}

/// Why a lookup found no element under a point. A click's lookup that ends this way is
/// `Lookup::Failed`, and these words go into its journal as its `uia.error`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum LookupError {
    /// The window under the pointer as the button went down had gone from the point before it
    /// could be read: what's there now is the window behind it (F019, #48).
    #[cfg(windows)]
    #[error("the window clicked in closed before it could be read")]
    WindowClosed,
    /// UI Automation refused the question, in its own words.
    #[cfg(windows)]
    #[error("{0}")]
    Automation(String),
    /// No window at the point.
    #[cfg(target_os = "linux")]
    #[error("no window at the point")]
    NoWindow,
    /// The window at the point went before its place could be read.
    #[cfg(target_os = "linux")]
    #[error("the window has gone")]
    WindowGone,
    /// The window's app isn't on the accessibility bus.
    #[cfg(target_os = "linux")]
    #[error("the app doesn't answer AT-SPI")]
    NoAccessibility,
    /// The lookup panicked; the lookup thread carries on.
    #[cfg(target_os = "linux")]
    #[error("the lookup failed")]
    Panicked,
}

/// Why the lookup worker (UI Automation's on Windows, AT-SPI's on Linux) couldn't be started.
/// The app shows its own words for any of them (`uiaUnavailable`); these go to its log.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// Its thread couldn't be started.
    #[error("{0}")]
    Thread(#[from] std::io::Error),
    /// It wasn't ready in the time it's given (five seconds): `lookup` names it.
    #[error("{lookup} did not become ready within five seconds")]
    TooSlow { lookup: &'static str },
    /// It stopped before it was ready.
    #[error("the lookup worker stopped before it was ready")]
    Stopped,
    /// UI Automation couldn't be started, in its own words.
    #[cfg(windows)]
    #[error("UI Automation unavailable: {0}")]
    Unavailable(String),
    /// UI Automation refused the lookups' cache request, in its own words.
    #[cfg(windows)]
    #[error("UIA cache request failed: {0}")]
    CacheRequest(String),
    /// The session bus or the accessibility bus couldn't be reached, in `Bus::connect`'s words.
    #[cfg(target_os = "linux")]
    #[error("{0}")]
    NoBus(String),
}

#[cfg(windows)]
impl From<uiautomation::Error> for LookupError {
    fn from(error: uiautomation::Error) -> Self {
        Self::Automation(error.to_string())
    }
}

/// One lookup's answer, from the worker thread.
pub(crate) struct Reply {
    pub id: u64,
    pub result: std::result::Result<Answer, LookupError>,
    pub elapsed: Duration,
}

/// The pipeline's end of the worker's replies.
pub(crate) struct Replies {
    pub receiver: Receiver<Reply>,
}

impl Replies {
    /// Waits for the reply to `id` until `deadline`, discarding replies for older clicks.
    ///
    /// The deadline limits how long the *lookup* may take, not when we look. The pipeline takes
    /// the screenshot before calling this, so a reply that finished in time may already be
    /// waiting after the deadline has passed: that one still counts.
    pub fn wait(&self, id: u64, started: Instant, deadline: Instant, stopped: &str) -> Lookup {
        let allowed = deadline.saturating_duration_since(started);
        loop {
            let now = Instant::now();
            let Some(remaining) = deadline.checked_duration_since(now) else {
                return self.take_ready(id, allowed, started);
            };
            match self.receiver.recv_timeout(remaining) {
                Ok(reply) if reply.id == id => return found(reply),
                Ok(_) => {} // a late reply for an earlier click: discard
                Err(RecvTimeoutError::Timeout) => return self.take_ready(id, allowed, started),
                Err(RecvTimeoutError::Disconnected) => {
                    return Lookup::Failed {
                        error: stopped.into(),
                        ms: millis(started.elapsed()),
                    };
                }
            }
        }
    }

    /// After the deadline: accept a reply for `id` that's already queued and took no longer than
    /// `allowed`; anything else is a timeout.
    fn take_ready(&self, id: u64, allowed: Duration, started: Instant) -> Lookup {
        while let Ok(reply) = self.receiver.try_recv() {
            if reply.id == id && reply.elapsed <= allowed {
                return found(reply);
            }
        }
        Lookup::TimedOut {
            ms: millis(started.elapsed()),
        }
    }
}

fn found(reply: Reply) -> Lookup {
    let ms = millis(reply.elapsed);
    match reply.result {
        Ok(Answer {
            facts,
            retried,
            pre_read,
        }) => Lookup::Found {
            facts,
            ms,
            retried,
            pre_read,
        },
        Err(error) => Lookup::Failed {
            error: error.to_string(),
            ms,
        },
    }
}

/// Waits for a worker thread to say it's ready. A worker that fails, or is too slow, is told to
/// stop through `cancelled`. `lookup` names it, for [`StartError::TooSlow`].
pub(crate) fn await_worker_ready(
    ready: &Receiver<Result<(), StartError>>,
    cancelled: &AtomicBool,
    timeout: Duration,
    lookup: &'static str,
) -> Result<(), StartError> {
    let result = match ready.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(StartError::TooSlow { lookup }),
        Err(RecvTimeoutError::Disconnected) => Err(StartError::Stopped),
    };
    if result.is_err() {
        cancelled.store(true, Ordering::SeqCst);
    }
    result
}

pub(crate) fn millis(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

/// Whether a field's value must not be read at all: in Steps' own windows, in an excluded app
/// (by the field's process or the window in front, since a web-view host such as the new Outlook
/// runs its fields in `msedgewebview2.exe`), when neither app can be named, or while the
/// recording isn't running.
pub(crate) fn reading_blocked(
    options: &FocusOptions,
    field_pid: u32,
    window: Option<&WindowInfo>,
) -> bool {
    let own = crate::platform::window::own_process_id();
    if field_pid == own || window.is_some_and(|window| window.pid == own) {
        return true;
    }
    let Some(machine) = &options.machine else {
        return false;
    };
    let field_exe = crate::platform::window::process_exe_name(field_pid);
    let window_exe = window.and_then(WindowInfo::exe_name);
    if field_exe.is_none() && window_exe.is_none() {
        return true;
    }
    let machine = machine
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    !machine.is_active()
        || field_exe.is_some_and(|name| machine.is_app_excluded(&name))
        || window_exe.is_some_and(|name| machine.is_app_excluded(name))
}

/// Whether an element (by its UI Automation control type, which AT-SPI roles are mapped to) is a
/// field whose value can be typed.
pub(crate) fn is_editable(facts: &ElementFacts) -> bool {
    matches!(facts.control_type.as_str(), "Edit" | "ComboBox")
        || (facts.control_type == "Document"
            && facts.aria_role.eq_ignore_ascii_case("textbox")
            && !facts.aria_properties.contains("readonly=true"))
}

/// A first answer from Chrome that is only its guess: the page, a pane, or nothing under the
/// point. Chrome answers at once from what its previous hit test found, and works out the real
/// answer in the background. The click's lookup looks once more (`uia::element_at`); an answer
/// still a guess then can stand over a password box, which the key worker checks for before it
/// keeps what's typed after the click (#97 fourth review).
pub(crate) fn chrome_guess(facts: &ElementFacts, x: i32, y: i32) -> bool {
    facts.framework_id == "Chrome"
        && (matches!(facts.control_type.as_str(), "Document" | "Pane")
            || (facts.name.is_empty() && facts.control_type == "Custom")
            || !facts.bounds.is_some_and(|bounds| bounds.contains(x, y)))
}

/// Whether an element is a web page's: drawn by Chrome (Chrome, Edge, Edge's web view, an Office
/// add-in's pane, and apps it draws, such as Teams and VS Code), by Firefox, or by Internet
/// Explorer's engine (Edge's IE mode, an app's `WebBrowser` control, #119). A click on anything in
/// a page can put focus in a box other than the one clicked, with no focus news: a label's `for`,
/// or the page's own script (#118). Firefox's own framework name on Windows is unconfirmed, so its
/// window is known by its class too ([`FIREFOX_WINDOW_CLASS`]).
pub(crate) fn in_web_view(facts: &ElementFacts) -> bool {
    matches!(
        facts.framework_id.as_str(),
        "Chrome" | "Gecko" | "InternetExplorer"
    )
}

/// The class of Firefox's top-level windows: everything in one is a web page's, or Firefox's
/// own, which it draws the same way, whatever framework UI Automation names (#119).
pub(crate) const FIREFOX_WINDOW_CLASS: &str = "MozillaWindowClass";

/// How many of an element's parents a click's evidence carries (docs/spec/02-capture.md#click-naming).
pub(crate) const MAX_ANCESTORS: usize = 4;

/// What an element's parents say for a click's evidence.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Parents {
    /// Nearest first: up to four, stopping below the window or the web page, which the click's
    /// window facts already speak for. Web pages wrap an item's insides a few levels deep, so the
    /// named item can be two or three parents up.
    pub ancestors: Vec<AncestorFacts>,
    /// Word's body is a Document of Word's own class (`_WwG`): a page under it is part of the
    /// document's text, which TypeScript words as a click in the document (#74).
    pub document_class: Option<String>,
    /// One of the parents walked says it's a password box: the element is a part of one (its
    /// text, its placeholder), and is kept out as the box is (#97 third review).
    pub in_password: bool,
}

/// [`Parents`] from an element's parents, given nearest first with their class names (none on
/// Linux). `parents` is walked lazily: each parent is a cross-process call, and no more are asked
/// for than are kept; the Document that ends the walk is one of them, so its class costs nothing.
#[cfg(test)]
pub(crate) fn parents(parents: impl Iterator<Item = (AncestorFacts, String)>) -> Parents {
    parents_marked(parents.map(|(parent, class_name)| (parent, class_name, false)))
}

/// [`parents`], each parent also saying whether it's a password box: a click's lookup can find a
/// part of a password box (a run of its text, its placeholder) rather than the box, and that part
/// doesn't say it holds a password; typed straight after the click, the password went to the box
/// focused before it (#97 third review).
pub(crate) fn parents_marked(
    mut parents: impl Iterator<Item = (AncestorFacts, String, bool)>,
) -> Parents {
    let mut found = Parents::default();
    while found.ancestors.len() < MAX_ANCESTORS {
        let Some((parent, class_name, is_password)) = parents.next() else {
            break;
        };
        found.in_password |= is_password;
        match parent.control_type.as_str() {
            "Document" => {
                found.document_class = Some(class_name).filter(|class| !class.is_empty());
                break;
            }
            "Window" => break,
            _ => found.ancestors.push(parent),
        }
    }
    found
}

/// How close to a field gaining focus a Unicode packet counts as typed into it: auto-type sends a
/// field's text straight after the Tab that moved focus there, before the focus news is heard.
const PACKET_LAG_MS: u32 = 1_000;

/// Unicode packets (`VK_PACKET`, text another program typed) as a field gained focus, from the
/// input thread's count (`platform::input::unicode_packets`): a field typed into that way keeps no
/// value when focus leaves it (decision of 11/10/2026, #91).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PacketsAtFocus {
    count: u64,
    /// One came within [`PACKET_LAG_MS`] of focus arriving.
    near: bool,
}

impl PacketsAtFocus {
    /// As focus arrived at `tick`, with `seen` the count and the latest packet's time then.
    pub(crate) fn at(tick: u32, seen: (u64, Option<u32>)) -> Self {
        let near = seen.1.is_some_and(|last| {
            tick.wrapping_sub(last).min(last.wrapping_sub(tick)) < PACKET_LAG_MS
        });
        Self {
            count: seen.0,
            near,
        }
    }

    /// Whether another program typed into the field while it had focus, `seen` being the count
    /// now. Fails closed: packets near focus arriving count.
    pub(crate) fn typed_since(self, seen: (u64, Option<u32>)) -> bool {
        self.near || seen.0 != self.count
    }
}

/// What a field's value, `read` as focus left it in a recording with "Record what's typed", gives
/// its step: the value, masked here so the unmasked value never leaves the focus handler, or why
/// it isn't kept. Nothing when it's unchanged from `initial`. However it got there (keys,
/// dictation, a paste), except when another program typed into the field (`packets`): then the
/// step keeps no value (`program`, decision of 11/10/2026, #91).
pub(crate) fn value_on_leave(
    read: Option<String>,
    initial: Option<&String>,
    packets: bool,
) -> (Option<String>, Option<&'static str>) {
    match read {
        Some(value) if Some(&value) != initial => {
            if packets {
                (None, Some("program"))
            } else {
                (Some(fit_value(crate::sensitive::mask_value(&value))), None)
            }
        }
        Some(_) => (None, None),
        None => (None, Some("unreadable")),
    }
}

/// How soon after the mouse press that moved focus into a field its focus news can be read with
/// keys typed since already in the field.
const KEYS_BEFORE_FOCUS_MS: u32 = 1_000;

/// Whether keys may already be in a field's value as it's read on gaining focus at `tick`: the
/// latest press of the left button, `press` (when and where), came in the second before, keys that
/// type text went down after it with none that could move focus by key
/// (`platform::input::typed_after_press`), and the focus came from that press: the field, at
/// `bounds`, holds the point pressed, or, only when its bounds can't be read, is in the window
/// there (`window`, the window in front as focus came; `root_at` names the top-level window at a
/// point). A click moves focus as the button goes down, and UI Automation can tell of it after
/// keys typed straight after the click (a barcode scanner, a text expander, auto-type; #97). Focus
/// moved by Tab is read as it always was, and so is focus an app moved to a field elsewhere after
/// keys were typed, in another window (#97 second review) or the same one (the third: an app
/// moving on to an autofilled field): taken as typed in, an untouched field would have kept what
/// it held, autofilled or not, as typing. A click on a field's label, beside it, is read as before
/// too.
pub(crate) fn typed_before_focus(
    tick: u32,
    press: Option<(u32, (i32, i32))>,
    bounds: Option<crate::coords::PxRect>,
    window: Option<isize>,
    root_at: impl FnOnce(i32, i32) -> Option<isize>,
) -> bool {
    let Some((press, (x, y))) = press else {
        return false;
    };
    crate::state_machine::tick_before_or_at(press, tick)
        && tick.wrapping_sub(press) <= KEYS_BEFORE_FOCUS_MS
        && bounds.map_or_else(
            || window.is_some_and(|window| root_at(x, y) == Some(window)),
            |bounds| bounds.contains(x, y),
        )
}

/// What a field held before it was typed in, its `value` being read as it gained focus: nothing
/// when keys typed before that read may be in it ([`typed_before_focus`]). Taken as what it held
/// before, the value as focus left looked unchanged, and the typing made no step at all (#97).
pub(crate) fn value_before_typing(value: Option<String>, typed_first: bool) -> Option<String> {
    value.map(|value| if typed_first { String::new() } else { value })
}

/// The longest typed value a step holds (`textParts.value` in packages/core/src/guide.ts).
pub(crate) const MAX_VALUE_CHARS: usize = 2_000;

/// A value cut to what a step can hold. Masking runs first, on the whole value.
pub(crate) fn fit_value(value: String) -> String {
    if value.chars().count() <= MAX_VALUE_CHARS {
        value
    } else {
        value.chars().take(MAX_VALUE_CHARS).collect()
    }
}

/// A one-way fingerprint of a field's value, keyed afresh each run, so an unchanged field can be
/// told from a typed-in one without keeping what it holds.
pub(crate) fn fingerprint(value: &str) -> u64 {
    static KEY: std::sync::OnceLock<RandomState> = std::sync::OnceLock::new();
    KEY.get_or_init(RandomState::new).hash_one(value)
}

/// The origin in a browser's address bar, and nothing else of it: never the path or query. A
/// full address gives its origin (`https://example.test:8443`). Edge and Chrome usually hide the
/// scheme (`example.test/path`), and then the site is given as the browser shows it, host and any
/// port, since the scheme isn't known. Anything that isn't plainly a site (a word, a search,
/// another kind of address) gives nothing.
pub(crate) fn origin_from_address(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() || address.chars().any(char::is_whitespace) {
        return None;
    }
    if address.contains("://") {
        let url = url::Url::parse(address).ok()?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return None;
        }
        return Some(url.origin().ascii_serialization());
    }
    let url = url::Url::parse(&format!("https://{address}")).ok()?;
    let host = match url.host()? {
        url::Host::Domain(domain) if domain == "localhost" || domain.contains('.') => {
            domain.to_string()
        }
        url::Host::Domain(_) => return None,
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => format!("[{ip}]"),
    };
    // A bare word before a colon is some other kind of address ("mailto:…"), not host:port.
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Sender};

    use super::*;

    /// The parents kept of `chain`, given without class names.
    fn ancestors(chain: impl Iterator<Item = AncestorFacts>) -> Vec<AncestorFacts> {
        parents(chain.map(|parent| (parent, String::new()))).ancestors
    }

    fn parent(control_type: &str, name: &str) -> AncestorFacts {
        AncestorFacts {
            control_type: control_type.into(),
            name: name.into(),
        }
    }

    #[test]
    fn an_element_carries_up_to_four_parents_nearest_first() {
        let chain = [
            parent("Group", ""),
            parent("Group", ""),
            parent("ListItem", "Forwarders"),
            parent("List", ""),
            parent("Group", "Site Tools"),
        ];
        assert_eq!(ancestors(chain.iter().cloned()), chain[..4].to_vec());
        assert_eq!(ancestors(std::iter::empty()), Vec::new());
    }

    #[test]
    fn the_parents_stop_below_the_window_or_the_page() {
        let in_page = [
            parent("Group", ""),
            parent("Document", "Site Tools"),
            parent("Pane", "Google Chrome"),
        ];
        assert_eq!(ancestors(in_page.into_iter()), vec![parent("Group", "")]);
        let in_window = [parent("Window", "Untitled - Notepad"), parent("Pane", "")];
        assert_eq!(ancestors(in_window.into_iter()), Vec::new());
    }

    #[test]
    fn the_parents_say_the_class_of_the_document_they_stopped_at() {
        // A click on Word's "Page 1" (the test of 10/10/2026, P38, #74): its parent is Word's
        // body, a Document of Word's own window class.
        let in_word = [
            (parent("Document", "Document3"), "_WwG".to_string()),
            (parent("Pane", ""), "_WwF".to_string()),
        ];
        assert_eq!(
            parents(in_word.into_iter()),
            Parents {
                ancestors: Vec::new(),
                document_class: Some("_WwG".into()),
                in_password: false,
            }
        );
        // A part of a web page, a level down.
        let in_page = [
            (parent("Group", ""), String::new()),
            (
                parent("Document", "Site Tools"),
                "Chrome_RenderWidgetHostHWND".to_string(),
            ),
        ];
        assert_eq!(
            parents(in_page.into_iter()).document_class.as_deref(),
            Some("Chrome_RenderWidgetHostHWND")
        );
        // Stopped at a window, at none, or four parents up before any Document: none said.
        let in_window = [(
            parent("Window", "Untitled - Notepad"),
            "Notepad".to_string(),
        )];
        assert_eq!(parents(in_window.into_iter()).document_class, None);
        let deep = std::iter::repeat_n((parent("Group", ""), String::new()), 4)
            .chain([(parent("Document", "Document3"), "_WwG".to_string())]);
        assert_eq!(parents(deep).document_class, None);
        let unnamed_class = [(parent("Document", "Document3"), String::new())];
        assert_eq!(parents(unnamed_class.into_iter()).document_class, None);
    }

    #[test]
    fn a_part_of_a_password_box_is_kept_out_as_the_box_is() {
        // A click on a password box's placeholder, or a run of its text: the lookup finds the
        // text, whose parent is the box. The parents say so, and the element clicked is then
        // taken as secret (#97 third review: typed straight after the click, the password went to
        // the box focused before it).
        let in_box = [
            (parent("Edit", "Password"), String::new(), true),
            (parent("Group", "Sign in"), String::new(), false),
            (parent("Document", "Contoso"), String::new(), false),
        ];
        let found = parents_marked(in_box.into_iter());
        assert!(found.in_password);
        assert_eq!(
            found.ancestors,
            vec![parent("Edit", "Password"), parent("Group", "Sign in")]
        );
        // Text in an ordinary box, or anywhere else, isn't.
        let in_search = [
            (parent("Edit", "Search"), String::new(), false),
            (parent("Document", "Contoso"), String::new(), false),
        ];
        assert!(!parents_marked(in_search.into_iter()).in_password);
        assert!(!parents(std::iter::once((parent("Edit", "Password"), String::new()))).in_password);
    }

    #[test]
    fn no_more_parents_are_asked_for_than_are_kept() {
        let asked = std::cell::Cell::new(0);
        let endless = std::iter::repeat_with(|| {
            asked.set(asked.get() + 1);
            parent("Group", "")
        });
        assert_eq!(ancestors(endless).len(), MAX_ANCESTORS);
        assert_eq!(asked.get(), MAX_ANCESTORS);
    }

    #[test]
    fn a_field_another_program_typed_into_is_told() {
        // No packets at all: dictation or keys put the value there.
        let none = PacketsAtFocus::at(5_000, (0, None));
        assert!(!none.typed_since((0, None)));
        // Auto-type while the field had focus.
        let before = PacketsAtFocus::at(5_000, (3, Some(100)));
        assert!(before.typed_since((9, Some(5_400))));
        // Packets long before focus came: another field's.
        assert!(!before.typed_since((3, Some(100))));
        // Auto-type sends the next field's text straight after the Tab that moves focus there,
        // before the focus news is heard: packets counted just before focus count for it too,
        // and so do any timed just after it but already counted.
        assert!(PacketsAtFocus::at(5_000, (7, Some(4_950))).typed_since((7, Some(4_950))));
        assert!(PacketsAtFocus::at(5_000, (8, Some(5_010))).typed_since((8, Some(5_010))));
        // The clock wraps.
        assert!(PacketsAtFocus::at(20, (1, Some(u32::MAX - 30))).typed_since((1, None)));
    }

    /// A form's window, on the left half of the screen; another program's is on the right.
    const FORM: isize = 0x40;
    /// A field in the form.
    const FIELD: crate::coords::PxRect = crate::coords::PxRect {
        left: 100,
        top: 200,
        right: 500,
        bottom: 230,
    };

    #[allow(
        clippy::unnecessary_wraps,
        reason = "stands in for `root_window_at`, which finds no window over the bare desktop"
    )]
    fn screen(x: i32, _: i32) -> Option<isize> {
        Some(if x < 1_000 { FORM } else { FORM + 1 })
    }

    /// Whether the field's value read at `tick` may hold keys typed after `press`.
    fn typed_first(tick: u32, press: Option<(u32, (i32, i32))>) -> bool {
        typed_before_focus(tick, press, Some(FIELD), Some(FORM), screen)
    }

    /// The step a field makes as focus leaves it holding `left`, its value read as focus came
    /// being `read`.
    fn on_leave(
        read: &str,
        left: &str,
        typed_first: bool,
    ) -> (Option<String>, Option<&'static str>) {
        let before = value_before_typing(Some(read.into()), typed_first);
        value_on_leave(Some(left.into()), before.as_ref(), false)
    }

    #[test]
    fn keys_typed_straight_after_the_click_into_a_field_are_its_value() {
        // A click into a form field at 1000, "Hello" a key every 10 ms from 1005 (a barcode
        // scanner, a text expander), and UI Automation's news of the field's focus read its value
        // at 1080, keys and all. That isn't what it held before: the value as focus leaves is
        // the step's, not taken as unchanged (#97 review: it made no step at all).
        let typed = typed_first(1_080, Some((1_000, (300, 215))));
        assert!(typed);
        assert_eq!(
            on_leave("Hello", "Hello", typed),
            (Some("Hello".to_string()), None)
        );
        // A box that can't be read stays so.
        assert_eq!(value_before_typing(None, typed), None);
        // Its bounds unread, the press in the window it's in is all there is to go on.
        assert!(typed_before_focus(
            1_080,
            Some((1_000, (300, 600))),
            None,
            Some(FORM),
            screen
        ));
        // At human speed the news comes first, and what the field held before is known: left
        // unchanged, it makes no step.
        assert!(!typed_first(1_080, None));
        assert_eq!(on_leave("Sam", "Sam", false), (None, None));
        // A press long before, or after the value was read, says nothing of it.
        assert!(!typed_first(9_080, Some((1_000, (300, 215)))));
        assert!(!typed_first(1_080, Some((1_090, (300, 215)))));
        // The clock wraps.
        assert!(typed_first(40, Some((u32::MAX - 30, (300, 215)))));
    }

    #[test]
    fn a_field_an_app_moves_focus_to_in_the_window_clicked_is_read_as_before() {
        // A click into the form's search box at 1000, a name typed, and within the second the app
        // moved focus on to a field of the same window that it had autofilled: its value read as
        // focus came is what it held, so left as it was it makes no step, never `Type "Sam
        // Hale"` (#97 third review: a field in the window pressed in was taken as typed in). A
        // click on a field's label, beside it, is read so too: only a press inside the field says
        // the keys may be in it.
        let typed = typed_first(1_080, Some((1_000, (300, 600))));
        assert!(!typed);
        assert_eq!(on_leave("Sam Hale", "Sam Hale", typed), (None, None));
    }

    #[test]
    fn an_untouched_prefilled_field_focused_after_keys_elsewhere_makes_no_step() {
        // A field holding "Sam Hale" (autofilled) that the app gave focus, not the click: keys
        // were typed after a click in another program's window (its search box), then focus came
        // to the form. Its value read as focus came is what it held: left as it was, it makes no
        // step, never `Type "Sam Hale"` (#97 second review).
        for point in [(1_500, 215), (1_500, 600)] {
            let typed = typed_first(1_080, Some((1_000, point)));
            assert!(!typed, "a press at {point:?}");
            assert_eq!(on_leave("Sam Hale", "Sam Hale", typed), (None, None));
        }
        // With no bounds to say, nor any window in front, it isn't taken as typed in either.
        assert!(!typed_before_focus(
            1_080,
            Some((1_000, (300, 215))),
            None,
            None,
            screen
        ));
        // Taken as typed in, its untouched value would have been a step: the reason for the rule.
        assert_eq!(
            on_leave("Sam Hale", "Sam Hale", true),
            (Some("Sam Hale".to_string()), None)
        );
    }

    #[test]
    fn a_fields_value_is_kept_as_focus_leaves_unless_another_program_typed_it() {
        let initial = Some(String::new());
        // Dictated, or typed: the field's value, masked.
        assert_eq!(
            value_on_leave(Some("Sam Hale".into()), initial.as_ref(), false),
            (Some("Sam Hale".to_string()), None)
        );
        assert_eq!(
            value_on_leave(Some("4111 1111 1111 1111".into()), initial.as_ref(), false),
            (Some("••••1111".to_string()), None)
        );
        // Auto-typed by a password manager into the user name box: the step keeps no value.
        assert_eq!(
            value_on_leave(Some("sam.hale".into()), initial.as_ref(), true),
            (None, Some("program"))
        );
        // Unchanged: no step, whoever typed.
        let same = Some("sam.hale".to_string());
        assert_eq!(
            value_on_leave(same.clone(), same.as_ref(), true),
            (None, None)
        );
        assert_eq!(
            value_on_leave(None, initial.as_ref(), false),
            (None, Some("unreadable"))
        );
    }

    #[test]
    fn fingerprints_tell_changed_values_apart() {
        assert_eq!(
            fingerprint("https://www.google.com/"),
            fingerprint("https://www.google.com/")
        );
        assert_ne!(
            fingerprint("https://www.google.com/"),
            fingerprint("amluto steps")
        );
        assert_ne!(fingerprint(""), fingerprint("a"));
    }

    #[test]
    fn a_very_long_value_is_cut_to_what_a_step_holds() {
        let long = "é".repeat(MAX_VALUE_CHARS + 50);
        assert_eq!(fit_value(long).chars().count(), MAX_VALUE_CHARS);
        assert_eq!(fit_value("short".into()), "short");
    }

    #[test]
    fn late_worker_reply_is_discarded_after_startup_timeout() {
        let (ready_tx, ready_rx) = mpsc::channel();
        let cancelled = AtomicBool::new(false);
        assert!(matches!(
            await_worker_ready(&ready_rx, &cancelled, Duration::from_millis(1), "a lookup"),
            Err(StartError::TooSlow { lookup: "a lookup" })
        ));
        assert!(cancelled.load(Ordering::SeqCst));
        drop(ready_rx);
        assert!(ready_tx.send(Ok(())).is_err());
    }

    /// Canned replies. The sender is returned so the channel stays open, like a live worker's.
    fn replies_with(replies: Vec<Reply>) -> (Replies, Sender<Reply>) {
        let (reply_tx, reply_rx) = mpsc::channel();
        for reply in replies {
            reply_tx.send(reply).unwrap();
        }
        (Replies { receiver: reply_rx }, reply_tx)
    }

    fn reply(id: u64, elapsed_ms: u64) -> Reply {
        Reply {
            id,
            result: Ok(Answer {
                facts: ElementFacts::default(),
                retried: false,
                pre_read: false,
            }),
            elapsed: Duration::from_millis(elapsed_ms),
        }
    }

    #[test]
    fn a_fast_reply_read_after_the_deadline_still_counts() {
        // The screenshot took 200 ms; the lookup itself finished in 10 ms.
        let (replies, _sender) = replies_with(vec![reply(5, 10)]);
        let started = Instant::now()
            .checked_sub(Duration::from_millis(200))
            .unwrap();
        let lookup = replies.wait(5, started, started + Duration::from_millis(150), "gone");
        assert!(matches!(lookup, Lookup::Found { .. }), "{lookup:?}");
    }

    #[test]
    fn a_slow_lookup_is_a_timeout_even_if_it_is_queued() {
        let (replies, _sender) = replies_with(vec![reply(5, 400)]);
        let started = Instant::now()
            .checked_sub(Duration::from_millis(500))
            .unwrap();
        let lookup = replies.wait(5, started, started + Duration::from_millis(150), "gone");
        assert!(matches!(lookup, Lookup::TimedOut { .. }), "{lookup:?}");
    }

    #[test]
    fn replies_for_earlier_clicks_are_discarded() {
        let (replies, _sender) = replies_with(vec![reply(3, 5), reply(4, 5)]);
        let started = Instant::now();
        let lookup = replies.wait(5, started, started + Duration::from_millis(30), "gone");
        assert!(matches!(lookup, Lookup::TimedOut { .. }), "{lookup:?}");
    }

    #[test]
    fn only_text_like_controls_are_editable() {
        let facts = |control_type: &str, aria_role: &str, aria_properties: &str| ElementFacts {
            control_type: control_type.into(),
            aria_role: aria_role.into(),
            aria_properties: aria_properties.into(),
            ..ElementFacts::default()
        };
        assert!(is_editable(&facts("Edit", "", "")));
        assert!(is_editable(&facts("ComboBox", "", "")));
        assert!(is_editable(&facts("Document", "textbox", "readonly=false")));
        assert!(!is_editable(&facts(
            "Document",
            "document",
            "readonly=true"
        )));
        assert!(!is_editable(&facts("Document", "textbox", "readonly=true")));
        assert!(!is_editable(&facts("Button", "", "")));
    }

    #[test]
    fn navigation_facts_keep_only_a_valid_http_origin() {
        assert_eq!(
            origin_from_address("https://user:secret@example.test:8443/path?q=secret#part"),
            Some("https://example.test:8443".into())
        );
        assert_eq!(
            origin_from_address("https://example.test:8443/path?q=secret#part"),
            Some("https://example.test:8443".into())
        );
        assert_eq!(origin_from_address("file:///C:/private.docx"), None);
        assert_eq!(origin_from_address("javascript:alert(1)"), None);
        // What Edge and Chrome actually show: the scheme hidden.
        assert_eq!(
            origin_from_address("127.0.0.1:8124/b.html"),
            Some("127.0.0.1:8124".into())
        );
        assert_eq!(
            origin_from_address("www.example.test/path?q=secret"),
            Some("www.example.test".into())
        );
        assert_eq!(
            origin_from_address("localhost:3000"),
            Some("localhost:3000".into())
        );
        // Searches and other text are never taken for a site.
        for text in [
            "holiday request form",
            "payroll",
            "mailto:a@b.test",
            "user@example.test",
            "",
        ] {
            assert_eq!(origin_from_address(text), None, "{text}");
        }
    }
}
