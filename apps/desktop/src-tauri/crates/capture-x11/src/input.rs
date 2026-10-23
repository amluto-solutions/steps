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
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
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

/// What the input thread read as a click went down, as on Windows. Never made on Linux yet
/// ([`InputShared::take_press`]).
#[derive(Debug, Clone)]
pub struct Press {
    /// The windows showing, front to back.
    pub stack: Vec<crate::window::ShownWindow>,
    /// The window clicked, and its title-bar button under the pointer.
    pub pressed: Option<crate::window::Pressed>,
}

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
    /// When a mouse button last went down, any pointer input last arrived, and a key last went
    /// down (only while keys are read), as on Windows.
    last_press: Seen,
    last_mouse: Seen,
    last_key: Seen,
    /// Keys typed straight after the latest press (#97).
    press_typed: PressTyped,
}

/// The [`now_tick`] something was last seen at, or nothing yet.
#[derive(Debug, Default)]
struct Seen(AtomicU64);

impl Seen {
    /// The time in the low half, with a bit above it so that a time of 0 still counts.
    fn note(&self, tick_ms: u32) {
        self.0
            .store((1 << 32) | u64::from(tick_ms), Ordering::Relaxed);
    }

    fn get(&self) -> Option<u32> {
        let value = self.0.load(Ordering::Relaxed);
        (value != 0).then(|| u32::try_from(value & u64::from(u32::MAX)).unwrap_or(0))
    }
}

/// The latest press of the left button and where it was, and whether keys that type text went
/// down after it with nothing between that could have moved focus by key, as on Windows. A click
/// moves focus as the button goes down, and keys typed straight after it can be in the field it
/// focused before the focus news is read: the value read then isn't what the field held before
/// (#97). Never which keys.
///
/// Only text counts as typed, `AltGr`'s (`ISO_Level3_Shift`) characters included. Any other key
/// that isn't Shift, a lock key or an input method's may move focus or change the field without
/// typing, and so may a key with Ctrl, Alt or Super held, or a press of another button (a right
/// click's menu takes the keys typed after it): then the latest press isn't where focus came from
/// (#97 second review).
#[derive(Debug, Default)]
struct PressTyped(Mutex<PressTypedState>);

#[derive(Debug, Default)]
struct PressTypedState {
    press: Option<(u32, (i32, i32))>,
    /// No key that could move focus has gone down since the press.
    open: bool,
    typed: bool,
    /// Ctrl, Alt (or Meta, Hyper), Super and `AltGr` held, a bit each.
    held: u8,
}

const HELD_CTRL: u8 = 1;
const HELD_ALT: u8 = 2;
const HELD_SUPER: u8 = 4;
const HELD_ALT_GR: u8 = 8;

/// What a key, by its keysym at the layout's first level, is to [`PressTyped`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    /// Ctrl, Alt, Super or `AltGr`: held with others.
    Held(u8),
    /// A key that types text, unless a combination's.
    Text,
    /// Types nothing and moves no focus: Shift, the lock keys, an input method's mode keys.
    Neutral,
    /// Anything else, and a key with no keysym.
    Other,
}

/// What the key with `keysym` (none when the layout gives it none) is to [`PressTyped`].
fn key_kind(keysym: Option<u32>) -> KeyKind {
    let Some(keysym) = keysym else {
        return KeyKind::Other;
    };
    match keysym {
        // Control_L, Control_R; Alt_L, Alt_R, Meta_L, Meta_R; Super_L, Super_R, Hyper_L, Hyper_R.
        0xffe3 | 0xffe4 => KeyKind::Held(HELD_CTRL),
        0xffe7..=0xffea => KeyKind::Held(HELD_ALT),
        0xffeb..=0xffee => KeyKind::Held(HELD_SUPER),
        // ISO_Level3_Shift, ISO_Level5_Shift, Mode_switch: AltGr on European layouts.
        0xfe03 | 0xfe11 | 0xff7e => KeyKind::Held(HELD_ALT_GR),
        // Shift, Caps Lock, Shift Lock, Num Lock, Scroll Lock, the ISO lock and group keys, and
        // the input methods' mode keys (Kanji, Henkan, Hangul and the like).
        0xffe1 | 0xffe2 | 0xffe5 | 0xffe6 | 0xff7f | 0xff14 | 0xfe01..=0xfe0f | 0xff21..=0xff3f => {
            KeyKind::Neutral
        }
        // Printable Latin-1, every legacy script's keysyms, and Unicode keysyms; the keypad's
        // space, signs, digits and equals; dead keys, which type with the next.
        0x0020..=0x007e
        | 0x00a0..=0x00ff
        | 0x0100..=0xfdff
        | 0x0100_0000..=0x0110_ffff
        | 0xff80
        | 0xffaa..=0xffb9
        | 0xffbd
        | 0xfe50..=0xfe8f => KeyKind::Text,
        _ => KeyKind::Other,
    }
}

impl PressTyped {
    fn state(&self) -> std::sync::MutexGuard<'_, PressTypedState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A mouse button went down at `point`: the left one is where focus may come from.
    fn pressed(&self, tick_ms: u32, point: (i32, i32), left: bool) {
        let mut state = self.state();
        state.typed = false;
        state.open = left;
        if left {
            state.press = Some((tick_ms, point));
        }
    }

    /// A key read while a recording reads keys, by its keysym at the layout's first level.
    fn key(&self, keysym: Option<u32>, up: bool) {
        let mut state = self.state();
        match key_kind(keysym) {
            KeyKind::Held(bit) if up => state.held &= !bit,
            KeyKind::Held(bit) => state.held |= bit,
            _ if up => {}
            KeyKind::Neutral => {}
            KeyKind::Text if state.held == 0 || state.held == HELD_ALT_GR => state.typed = true,
            KeyKind::Text | KeyKind::Other => state.open = false,
        }
    }

    fn get(&self) -> Option<(u32, (i32, i32))> {
        let state = self.state();
        (state.open && state.typed).then_some(state.press).flatten()
    }

    /// A new recording: keys held as the last one ended are let go.
    fn clear(&self) {
        let mut state = self.state();
        state.held = 0;
        state.open = false;
    }
}

/// What became of a left press's button, as on Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeftRelease {
    /// Still down, as far as is known.
    Down,
    /// Released (time, x, y), before any other left press.
    Up(u32, i32, i32),
    /// Its release will never be known: another left press came first.
    Missed,
}

impl InputShared {
    /// What became of left press `press`'s button: releases aren't read on X11 yet, so it stays
    /// down and drags stay clicks there.
    #[must_use]
    pub const fn left_release(&self, _press: u64) -> LeftRelease {
        LeftRelease::Down
    }

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
            last_press: Seen::default(),
            last_mouse: Seen::default(),
            last_key: Seen::default(),
            press_typed: PressTyped::default(),
        }
    }

    /// When a mouse button last went down, whether or not it was recorded.
    #[must_use]
    pub fn last_press(&self) -> Option<u32> {
        self.last_press.get()
    }

    /// When any pointer input (movement, a button, the wheel) last arrived.
    #[must_use]
    pub fn last_mouse(&self) -> Option<u32> {
        self.last_mouse.get()
    }

    /// Touch and pen aren't watched separately on X11: a tap arrives as a click.
    #[must_use]
    pub const fn last_touch(&self) -> Option<u32> {
        None
    }

    /// When a key last went down; only known while a recording reads keys. Never which key.
    #[must_use]
    pub fn last_key(&self) -> Option<u32> {
        self.last_key.get()
    }

    /// The latest press of the left button, when and where, when keys that type text went down
    /// after it and none that could move focus by key ([`PressTyped`], #97).
    #[must_use]
    pub fn typed_after_press(&self) -> Option<(u32, (i32, i32))> {
        self.press_typed.get()
    }

    /// Next queued button-down, if any.
    #[must_use]
    pub fn pop(&self) -> Option<MouseDown> {
        self.queue.pop()
    }

    /// What was under the pointer when a click went down. Not kept on Linux yet: the window and
    /// the stack are read when the click is handled, and the window manager draws title bars, so
    /// there is no title-bar button to tell.
    #[must_use]
    pub const fn take_press(&self, _id: u64) -> Option<Press> {
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
        self.press_typed.clear();
    }

    fn record_down(&self, tick_ms: u32, x: i32, y: i32, button: MouseButton, injected: bool) {
        self.last_press.note(tick_ms);
        self.press_typed
            .pressed(tick_ms, (x, y), button == MouseButton::Left);
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

    /// A key going down or up, with its keysym at the layout's first level.
    fn record_key(&self, event: KeyEvent, keysym: Option<u32>) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        self.press_typed.key(keysym, event.up);
        if !event.up {
            self.last_key.note(event.tick_ms);
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

/// How many times the mouse has reported moving since input was first registered, whether or not
/// the pointer moved a pixel: what tells the pointer moving from other input (a key, a button,
/// the wheel) where only the time of the last input is known. `None` before then.
#[must_use]
pub fn mouse_moves() -> Option<u64> {
    SHARED
        .get()
        .map(|shared| shared.moves.load(Ordering::Relaxed))
}

/// Unicode packets seen, as on Windows (`capture_win32::input::unicode_packets`): X has no such
/// input, since a program types through `XTEST` with key codes, so there are none.
#[must_use]
pub fn unicode_packets() -> (u64, Option<u32>) {
    (0, None)
}

/// The time of the latest press of the left button, and where it was, when keys that type text
/// went down after it (only while a recording reads keys) and none that could move focus by key:
/// any other key but Shift, a lock key or an input method's, or one with Ctrl, Alt or Super held
/// (`AltGr`'s characters aside), and no press of another button. Keys typed straight after a click
/// can be in a field before its focus news is read (#97). Never which button or key.
#[must_use]
pub fn typed_after_press() -> Option<(u32, (i32, i32))> {
    SHARED.get().and_then(|shared| shared.typed_after_press())
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
                shared.last_mouse.note(now_tick());
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
            Event::XinputRawMotion(_) => {
                shared.last_mouse.note(now_tick());
                shared.record_move();
            }
            Event::XinputRawKeyPress(key) => {
                let (event, keysym) =
                    key_event(key.detail, false, &synthetic, key.sourceid, foreground);
                shared.record_key(event, keysym);
            }
            Event::XinputRawKeyRelease(key) => {
                let (event, keysym) =
                    key_event(key.detail, true, &synthetic, key.sourceid, foreground);
                shared.record_key(event, keysym);
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

/// A key event for the X key code `keycode`, and its keysym at the layout's first level.
fn key_event(
    keycode: u32,
    up: bool,
    synthetic: &HashSet<u16>,
    source: u16,
    foreground: isize,
) -> (KeyEvent, Option<u32>) {
    let code = u8::try_from(keycode).unwrap_or(0);
    let keysym = base_keysym(code);
    let (vkey, extended) = keysym.map_or((0, false), virtual_key);
    let event = KeyEvent {
        tick_ms: now_tick(),
        vkey,
        scan: u16::from(code),
        extended,
        up,
        injected: synthetic.contains(&source),
        foreground,
    };
    (event, keysym)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_typed_after_a_press_are_told_until_a_key_could_move_focus() {
        // As on Windows (#97 second review): only keys that type text count, AltGr's included;
        // any other key that may move focus or change the field, a key with Ctrl, Alt or Super
        // held, or a press of another button, ends it.
        let typed = PressTyped::default();
        let key = |keysym: u32, up| typed.key(Some(keysym), up);
        let press = |tick| typed.pressed(tick, (40, 50), true);
        assert_eq!(typed.get(), None);
        press(100);
        key(0xffe1, false);
        assert_eq!(typed.get(), None, "Shift types nothing");
        key(u32::from(b'h'), false);
        key(u32::from(b'h'), true);
        key(0xffe1, true);
        assert_eq!(typed.get(), Some((100, (40, 50))));
        // Tab, Return, Escape, Left, Home, Page Down, BackSpace, Delete, F6, Menu, and a key with
        // no keysym.
        for keysym in [
            0xff09, 0xff0d, 0xff1b, 0xff51, 0xff50, 0xff56, 0xff08, 0xffff, 0xffc3, 0xff67,
        ] {
            press(110);
            key(keysym, false);
            key(u32::from(b'a'), false);
            assert_eq!(typed.get(), None, "{keysym:#x}");
        }
        press(115);
        typed.key(None, false);
        key(u32::from(b'a'), false);
        assert_eq!(typed.get(), None, "a key with no keysym");
        // Caps Lock and Num Lock: still open.
        press(120);
        key(0xffe5, false);
        key(0xff7f, false);
        assert_eq!(typed.get(), None, "a lock key types nothing");
        key(u32::from(b'1'), false);
        assert_eq!(typed.get(), Some((120, (40, 50))));
        // A Cyrillic letter, a Unicode keysym, the keypad's 5 and a dead key type.
        for keysym in [0x06c1, 0x0100_20ac, 0xffb5, 0xfe51] {
            press(125);
            key(keysym, false);
            assert_eq!(typed.get(), Some((125, (40, 50))), "{keysym:#x}");
        }
        // Ctrl+F; then Ctrl let go.
        press(130);
        key(0xffe3, false);
        key(u32::from(b'f'), false);
        key(0xffe3, true);
        key(u32::from(b'a'), false);
        assert_eq!(typed.get(), None, "Ctrl+F");
        press(140);
        key(u32::from(b'a'), false);
        assert_eq!(typed.get(), Some((140, (40, 50))), "Ctrl let go");
        // AltGr+E types "€" on a European layout; Alt_R with a letter (a US layout's) is a
        // menu's access key.
        press(150);
        key(0xfe03, false);
        key(u32::from(b'e'), false);
        assert_eq!(typed.get(), Some((150, (40, 50))), "AltGr+E");
        key(0xfe03, true);
        press(160);
        key(0xffea, false);
        key(u32::from(b'f'), false);
        key(0xffea, true);
        assert_eq!(typed.get(), None, "Alt+F");
        // A right click's menu takes the keys typed after it.
        press(170);
        key(u32::from(b'a'), false);
        typed.pressed(171, (40, 50), false);
        assert_eq!(typed.get(), None, "a right click");
        key(u32::from(b'p'), false);
        assert_eq!(typed.get(), None, "P, after a right click");
    }
}
