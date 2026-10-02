//! The input thread (docs/spec/02-capture.md#linux-x11-phase-10): clicks, and keys only for a
//! recording that asked for them, from `XInput2`'s raw events on the root window, which the server
//! sends for every device whatever window has the pointer or a grab. It only copies each event
//! into a bounded queue and goes back to waiting, as the Windows input thread does.
//!
//! Raw events carry no position, so the pointer is asked for as each button-down arrives: a
//! button press doesn't move the pointer, and the thread does nothing else in between. Clicks
//! from `XTEST` (automation tools, `xdotool`, the tests) are marked `injected` and recorded, as
//! injected clicks are on Windows.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;

use crossbeam_queue::ArrayQueue;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xinput::{self, ConnectionExt as _, XIEventMask};
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask,
    Window, WindowClass,
};
use x11rb::rust_connection::RustConnection;

use crate::connection::Display;
use crate::display::now_tick;
use crate::keyboard::{base_keysym, mapping_changed, virtual_key};
use crate::{Error, Result};

/// Which mouse button went down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// One mouse-button-down, as copied out of the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseDown {
    /// Monotonic per process; every fact about this click is keyed by it.
    pub id: u64,
    /// [`now_tick`] when the event arrived.
    pub tick_ms: u32,
    /// Screen pixels.
    pub x: i32,
    pub y: i32,
    pub button: MouseButton,
    /// Synthetic input (`XTEST`). Recorded, never used to drop a click.
    pub injected: bool,
}

/// A change of the active window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForegroundChange {
    /// The window's id as an integer.
    pub hwnd: isize,
    pub tick_ms: u32,
}

/// One key going down or up. No character: that's worked out off the input thread
/// (`keyboard::typed_text`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    pub tick_ms: u32,
    /// The Windows virtual-key code for this key (0 when it has none), so the key reader's rules
    /// are the same on both platforms.
    pub vkey: u16,
    /// The X key code, for the layout's character.
    pub scan: u16,
    /// Windows' E0 prefix, for the same keys: right Ctrl and Alt, arrows, editing keys.
    pub extended: bool,
    pub up: bool,
    /// Synthetic input (`XTEST`).
    pub injected: bool,
    /// The active window when the key arrived, as an integer.
    pub foreground: isize,
}

/// How clicks are observed. X11 has one way (`XInput2` raw events): both settings use it, and
/// they're kept so the app's Troubleshooting choice reads the same everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputSource {
    RawInput,
    Hook,
}

impl InputSource {
    fn to_u8(self) -> u8 {
        match self {
            Self::RawInput => 0,
            Self::Hook => 1,
        }
    }

    fn from_u8(value: u8) -> Self {
        if value == 1 {
            Self::Hook
        } else {
            Self::RawInput
        }
    }
}

/// Which selections are in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Registration {
    pub mouse: bool,
    /// Touch screens and pens: not watched separately on X11 (a tap arrives as a click).
    pub digitizers: bool,
    /// Only while a recording with "Record what's typed" is taking input.
    pub keyboard: bool,
}

/// State shared between the input thread and the recorder.
#[derive(Debug)]
pub struct InputShared {
    queue: ArrayQueue<MouseDown>,
    foreground: ArrayQueue<ForegroundChange>,
    keys: ArrayQueue<KeyEvent>,
    /// Key events that arrived while the key queue was full.
    pub keys_dropped: AtomicU64,
    next_id: AtomicU64,
    /// Button-downs that arrived while the queue was full. Shown as "N clicks missed".
    pub dropped: AtomicU64,
    /// Every pointer movement seen, for the "input is happening but nothing arrives" check.
    pub moves: AtomicU64,
    /// Touch and pen reports: always 0 on X11.
    pub touch_reports: AtomicU64,
    pub last_touch_tick: AtomicU32,
    /// Button-downs are queued only while this is true (Recording).
    pub enabled: AtomicBool,
    source: AtomicU8,
}

impl InputShared {
    fn new(capacity: usize) -> Self {
        Self {
            queue: ArrayQueue::new(capacity),
            foreground: ArrayQueue::new(32),
            keys: ArrayQueue::new(KEY_QUEUE_CAPACITY),
            keys_dropped: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            dropped: AtomicU64::new(0),
            moves: AtomicU64::new(0),
            touch_reports: AtomicU64::new(0),
            last_touch_tick: AtomicU32::new(0),
            enabled: AtomicBool::new(false),
            source: AtomicU8::new(InputSource::RawInput.to_u8()),
        }
    }

    /// Next queued button-down, if any.
    #[must_use]
    pub fn pop(&self) -> Option<MouseDown> {
        self.queue.pop()
    }

    /// The windows showing when a click went down. Not kept on Linux yet: the stack is read when
    /// the click is handled.
    #[must_use]
    pub fn take_stack(&self, _id: u64) -> Option<Vec<crate::window::ShownWindow>> {
        None
    }

    /// Next active-window change, if any. Only the latest 32 are kept.
    #[must_use]
    pub fn pop_foreground(&self) -> Option<ForegroundChange> {
        self.foreground.pop()
    }

    /// Next key event, if any.
    #[must_use]
    pub fn pop_key(&self) -> Option<KeyEvent> {
        self.keys.pop()
    }

    /// Number of button-downs waiting.
    #[must_use]
    pub fn queued(&self) -> usize {
        self.queue.len()
    }

    #[must_use]
    pub fn capacity(&self) -> usize {
        self.queue.capacity()
    }

    /// The source chosen (both are the same on X11).
    #[must_use]
    pub fn source(&self) -> InputSource {
        InputSource::from_u8(self.source.load(Ordering::SeqCst))
    }

    /// Empties the queues, e.g. before a new recording starts.
    pub fn clear(&self) {
        while self.queue.pop().is_some() {}
        while self.foreground.pop().is_some() {}
        while self.keys.pop().is_some() {}
    }

    fn record_down(&self, tick_ms: u32, x: i32, y: i32, button: MouseButton, injected: bool) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let event = MouseDown {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            tick_ms,
            x,
            y,
            button,
            injected,
        };
        if self.queue.push(event).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_key(&self, event: KeyEvent) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        if self.keys.push(event).is_err() {
            self.keys_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_move(&self) {
        self.moves.fetch_add(1, Ordering::Relaxed);
    }

    fn record_foreground(&self, change: ForegroundChange) {
        let _ = self.foreground.force_push(change);
    }
}

/// Queue size: far more than any human burst.
pub const QUEUE_CAPACITY: usize = 256;
/// Key events (a down and an up per key): many seconds of the fastest typing.
pub const KEY_QUEUE_CAPACITY: usize = 2048;

static SHARED: OnceLock<Arc<InputShared>> = OnceLock::new();
static CAPACITY: AtomicUsize = AtomicUsize::new(QUEUE_CAPACITY);
static RUNNING: AtomicBool = AtomicBool::new(false);
static MOUSE_SELECTED: AtomicBool = AtomicBool::new(false);
static KEYBOARD_SELECTED: AtomicBool = AtomicBool::new(false);

/// Test only: a smaller queue, to prove overflow is reported. Takes effect only before the first
/// input thread starts; returns `false` if it's too late.
pub fn set_queue_capacity_before_start(capacity: usize) -> bool {
    if SHARED.get().is_some() || capacity == 0 {
        return false;
    }
    CAPACITY.store(capacity, Ordering::SeqCst);
    true
}

fn shared() -> &'static Arc<InputShared> {
    SHARED.get_or_init(|| Arc::new(InputShared::new(CAPACITY.load(Ordering::SeqCst))))
}

/// The input thread's connection and what it selected.
struct Listener {
    display: Display,
    /// An unmapped window the thread is woken through, to stop.
    wake: Window,
}

impl Listener {
    fn open() -> Result<Self> {
        let display = Display::open()?;
        let connection = &display.connection;
        connection
            .xinput_xi_query_version(2, 2)
            .map_err(|_| Error::MissingExtension("XInput2"))?
            .reply()
            .map_err(|_| Error::MissingExtension("XInput2"))?;
        let wake = connection.generate_id()?;
        connection.create_window(
            0,
            wake,
            display.root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new(),
        )?;
        // Changes of the active window arrive as property changes on the root.
        connection.change_window_attributes(
            display.root,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )?;
        connection.flush()?;
        Ok(Self { display, wake })
    }

    /// Selects raw clicks and motion, and keys when `keys` is on.
    fn select(connection: &RustConnection, root: Window, keys: bool) -> Result<()> {
        let mut mask = XIEventMask::RAW_BUTTON_PRESS | XIEventMask::RAW_MOTION;
        if keys {
            mask = mask | XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE;
        }
        connection
            .xinput_xi_select_events(
                root,
                &[xinput::EventMask {
                    deviceid: xinput::Device::ALL_MASTER.into(),
                    mask: vec![mask],
                }],
            )?
            .check()?;
        MOUSE_SELECTED.store(true, Ordering::SeqCst);
        KEYBOARD_SELECTED.store(keys, Ordering::SeqCst);
        Ok(())
    }
}

/// The `XTEST` devices, whose events are synthetic.
fn xtest_devices(connection: &RustConnection) -> HashSet<u16> {
    connection
        .xinput_xi_query_device(xinput::Device::ALL)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| {
            reply
                .infos
                .iter()
                .filter(|info| String::from_utf8_lossy(&info.name).contains("XTEST"))
                .map(|info| info.deviceid)
                .collect()
        })
        .unwrap_or_default()
}

/// The running input thread. Stops the thread, and removes its selections, when dropped.
pub struct InputCapture {
    thread: Option<JoinHandle<()>>,
    connection: Arc<RustConnection>,
    root: Window,
    wake: Window,
    stop: Arc<AtomicBool>,
    shared: Arc<InputShared>,
}

impl std::fmt::Debug for InputCapture {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InputCapture")
            .field("alive", &self.is_alive())
            .finish_non_exhaustive()
    }
}

impl InputCapture {
    /// Starts the input thread.
    ///
    /// # Errors
    /// If another input thread is already running in this process, there's no X server, or it
    /// has no `XInput2`.
    pub fn start(source: InputSource) -> Result<Self> {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err(Error::AlreadyRunning);
        }
        let started = (|| {
            let listener = Listener::open()?;
            Listener::select(&listener.display.connection, listener.display.root, false)?;
            Ok::<_, Error>(listener)
        })();
        let listener = match started {
            Ok(listener) => listener,
            Err(error) => {
                RUNNING.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        let shared = Arc::clone(shared());
        shared.source.store(source.to_u8(), Ordering::SeqCst);
        let root = listener.display.root;
        let wake = listener.wake;
        let active_atom = listener.display.atoms.net_active_window;
        let connection = Arc::new(listener.display.connection);
        let stop = Arc::new(AtomicBool::new(false));

        let thread_connection = Arc::clone(&connection);
        let thread_stop = Arc::clone(&stop);
        let thread_shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("amluto-input".into())
            .spawn(move || {
                run(
                    &thread_connection,
                    root,
                    active_atom,
                    &thread_stop,
                    &thread_shared,
                );
            });
        let Ok(thread) = spawned else {
            RUNNING.store(false, Ordering::SeqCst);
            return Err(Error::InputThreadGone);
        };
        Ok(Self {
            thread: Some(thread),
            connection,
            root,
            wake,
            stop,
            shared,
        })
    }

    #[must_use]
    pub fn shared(&self) -> &Arc<InputShared> {
        &self.shared
    }

    #[must_use]
    pub fn source(&self) -> InputSource {
        self.shared.source()
    }

    /// Records the choice; X11 has only the one source.
    ///
    /// # Errors
    /// Never, on X11.
    pub fn set_source(&self, source: InputSource) -> Result<()> {
        self.shared.source.store(source.to_u8(), Ordering::SeqCst);
        Ok(())
    }

    /// Selects the events again.
    ///
    /// # Errors
    /// If the X server refuses the selection.
    pub fn reregister(&self) -> Result<()> {
        Listener::select(
            &self.connection,
            self.root,
            KEYBOARD_SELECTED.load(Ordering::SeqCst),
        )
    }

    /// Selects the keyboard's events (`true`) or stops them (`false`). Only a recording with
    /// "Record what's typed" ticked turns it on, and Pause and Stop turn it off again.
    ///
    /// # Errors
    /// If the X server refuses the selection.
    pub fn set_keyboard(&self, on: bool) -> Result<()> {
        Listener::select(&self.connection, self.root, on)
    }

    /// Whether the input thread is still running (it ends if the X connection breaks).
    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }

    /// Stops the input thread.
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.shared.enabled.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            self.stop.store(true, Ordering::SeqCst);
            // Wakes the thread from waiting for an event.
            let event = ClientMessageEvent::new(32, self.wake, 0u32, [0u32; 5]);
            let _ = self
                .connection
                .send_event(false, self.wake, EventMask::NO_EVENT, event);
            let _ = self.connection.flush();
            let _ = thread.join();
        }
        MOUSE_SELECTED.store(false, Ordering::SeqCst);
        KEYBOARD_SELECTED.store(false, Ordering::SeqCst);
        RUNNING.store(false, Ordering::SeqCst);
    }
}

impl Drop for InputCapture {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

fn run(
    connection: &RustConnection,
    root: Window,
    active_atom: u32,
    stop: &AtomicBool,
    shared: &InputShared,
) {
    let synthetic = xtest_devices(connection);
    let active_window = |connection: &RustConnection| -> isize {
        connection
            .get_property(
                false,
                root,
                active_atom,
                x11rb::protocol::xproto::AtomEnum::WINDOW,
                0,
                1,
            )
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().and_then(|mut values| values.next()))
            .and_then(|window| isize::try_from(window).ok())
            .unwrap_or(0)
    };
    let mut foreground = active_window(connection);
    while !stop.load(Ordering::SeqCst) {
        let Ok(event) = connection.wait_for_event() else {
            break;
        };
        match event {
            Event::XinputRawButtonPress(press) => {
                let button = match press.detail {
                    1 => MouseButton::Left,
                    2 => MouseButton::Middle,
                    3 => MouseButton::Right,
                    // 4–7 are the scroll wheel; 8 and 9 back and forward.
                    _ => continue,
                };
                let tick_ms = now_tick();
                let Some((x, y)) = connection
                    .query_pointer(root)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .map(|pointer| (i32::from(pointer.root_x), i32::from(pointer.root_y)))
                else {
                    continue;
                };
                shared.record_down(tick_ms, x, y, button, synthetic.contains(&press.sourceid));
            }
            Event::XinputRawMotion(_) => shared.record_move(),
            Event::XinputRawKeyPress(key) => {
                shared.record_key(key_event(
                    key.detail,
                    false,
                    &synthetic,
                    key.sourceid,
                    foreground,
                ));
            }
            Event::XinputRawKeyRelease(key) => {
                shared.record_key(key_event(
                    key.detail,
                    true,
                    &synthetic,
                    key.sourceid,
                    foreground,
                ));
            }
            Event::PropertyNotify(change) if change.atom == active_atom => {
                foreground = active_window(connection);
                shared.record_foreground(ForegroundChange {
                    hwnd: foreground,
                    tick_ms: now_tick(),
                });
            }
            Event::MappingNotify(_) => mapping_changed(),
            _ => {}
        }
    }
}

fn key_event(
    keycode: u32,
    up: bool,
    synthetic: &HashSet<u16>,
    source: u16,
    foreground: isize,
) -> KeyEvent {
    let code = u8::try_from(keycode).unwrap_or(0);
    let (vkey, extended) = base_keysym(code).map_or((0, false), virtual_key);
    KeyEvent {
        tick_ms: now_tick(),
        vkey,
        scan: u16::from(code),
        extended,
        up,
        injected: synthetic.contains(&source),
        foreground,
    }
}

/// Which selections are in place.
#[must_use]
pub fn registration() -> Registration {
    Registration {
        mouse: MOUSE_SELECTED.load(Ordering::SeqCst),
        digitizers: false,
        keyboard: KEYBOARD_SELECTED.load(Ordering::SeqCst),
    }
}
