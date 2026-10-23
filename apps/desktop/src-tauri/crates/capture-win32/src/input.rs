//! The input thread: everything that needs a Windows message loop runs on it.
//!
//! - **The mouse source.** Raw Input on a message-only window (the default), or the `WH_MOUSE_LL`
//!   hook as a fallback. It can be switched, and re-registered, while running
//!   (docs/spec/02-capture.md#input-source).
//! - **Touch screens and pens** (Raw Input for digitizers). No mouse source sees a tap, so each
//!   report's contacts are read and placed on the screen (`touch`), and a tap becomes a click
//!   where it landed (`taps`). A device whose reports can't be read has them counted instead, so
//!   the recorder marks taps it couldn't record rather than losing them silently
//!   (docs/spec/02-capture.md#touch-and-pen).
//! - **Foreground-window changes**, from an out-of-context `WinEvent` hook (no DLL is loaded into
//!   other processes).
//!
//! - **The keyboard**, only for a recording where "Record what's typed" is ticked: Raw Input again,
//!   registered when that recording starts or resumes and removed at Pause and Stop. There is no
//!   keyboard hook, even as a fallback (docs/spec/02-capture.md#keys). Key events carry no text:
//!   they are turned into characters, and dropped for excluded apps and our own windows, later,
//!   off this thread. A Unicode packet (`VK_PACKET`, text another program typed) is copied
//!   without its character and counted as it arrives, so a field typed into that way keeps no
//!   value (#91).
//!
//! The callbacks copy the event into a bounded lock-free queue, bump a counter and return. No
//! UIA, file access, logging or screenshots happen here, because Windows silently removes a
//! low-level hook that exceeds `LowLevelHooksTimeout`. The one thing read as a button goes down,
//! before the app reacts, is what's under the pointer ([`Press`]): the windows showing, the window
//! clicked, and for the left button that window's hit test (a title-bar button), which a busy
//! window is given at most 30 ms to answer. Every callback catches panics.
//!
//! **Raw Input is one registration per device type per process.** Anything else in the process
//! that registers the mouse (Tauri's windowing library does by default) replaces ours without
//! telling us, so [`registration`] lets the recorder check it is still ours.
//!
//! Loss is never silent: a full queue increments `dropped`, and every mouse movement increments
//! `moves`, so the recorder can notice movement with no events (Degraded).
//!
//! The times of the latest button press, mouse input of any kind, and key press (only while keys
//! are read) are kept too, never what they were: an app that came to the front with none of them
//! just before may have come forward by itself (`capture::switches`, #67).

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{
    AtomicBool, AtomicIsize, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering,
};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_queue::ArrayQueue;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::Input::{
    GetRawInputData, GetRegisteredRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RID_HEADER, RID_INPUT, RIDEV_INPUTSINK, RIDEV_REMOVE, RIM_TYPEHID,
    RIM_TYPEKEYBOARD, RIM_TYPEMOUSE, RegisterRawInputDevices,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    EVENT_SYSTEM_FOREGROUND, GetForegroundWindow, GetMessagePos, GetMessageTime, GetMessageW,
    GetSystemMetrics, HC_ACTION, HHOOK, HWND_MESSAGE, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT,
    PostThreadMessageW, RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_LEFT_BUTTON_UP,
    RI_MOUSE_MIDDLE_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_UP,
    RegisterClassExW, SM_SWAPBUTTON, SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL,
    WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP,
    WM_INPUT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN,
    WNDCLASSEXW,
};
use windows::core::w;

use crate::taps::{Rotation, Screen, TapTracker};
use crate::touch::{Digitizer, mapping};
use crate::{Error, Result};

/// Which mouse button went down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// One mouse-button-down, as copied out of the callback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseDown {
    /// Monotonic per process; every fact about this click is keyed by it.
    pub id: u64,
    /// Windows message time (ms since boot, wrapping).
    pub tick_ms: u32,
    /// Physical screen pixels.
    pub x: i32,
    pub y: i32,
    pub button: MouseButton,
    /// Synthetic input (`SendInput`), e.g. from automation tools, the test driver, or a
    /// remote-control tool relaying a person's real clicks. Recorded, never used to drop a click.
    pub injected: bool,
}

/// A foreground-window change, from the `WinEvent` hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForegroundChange {
    /// Window handle as an integer.
    pub hwnd: isize,
    pub tick_ms: u32,
}

/// One key going down or up, as copied out of the callback. No character: that depends on the
/// keyboard layout and the modifiers, and is worked out off the input thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    /// Windows message time (ms since boot, wrapping).
    pub tick_ms: u32,
    /// Virtual-key code. Shift, Ctrl and Alt arrive as `VK_SHIFT`, `VK_CONTROL` and `VK_MENU`.
    pub vkey: u16,
    /// Scan code (make code), for the layout's character.
    pub scan: u16,
    /// The E0 prefix: the right-hand Ctrl and Alt, the arrow and editing keys, keypad Enter.
    pub extended: bool,
    pub up: bool,
    /// Synthetic input (`SendInput`), e.g. from the test driver or a remote-control tool.
    pub injected: bool,
    /// The window in front when the key arrived, as an integer handle: keys for our own windows
    /// and excluded apps are dropped by it.
    pub foreground: isize,
}

/// How clicks are observed (docs/spec/02-capture.md#input-source).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputSource {
    /// Raw Input with `RIDEV_INPUTSINK` on a message-only window. Can't time out. The default.
    RawInput,
    /// `WH_MOUSE_LL`. The fallback: Windows can remove it silently if its thread stalls.
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

/// Whether each Raw Input registration is still ours (our window, `RIDEV_INPUTSINK`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Registration {
    pub mouse: bool,
    /// Touch screens and pens.
    pub digitizers: bool,
    /// Only while a recording with "Record what's typed" is taking input.
    pub keyboard: bool,
}

/// State shared between the callbacks and the recorder.
#[derive(Debug)]
pub struct InputShared {
    queue: ArrayQueue<MouseDown>,
    foreground: ArrayQueue<ForegroundChange>,
    keys: ArrayQueue<KeyEvent>,
    /// Key events that arrived while the key queue was full. The typing they were part of is
    /// marked incomplete.
    pub keys_dropped: AtomicU64,
    next_id: AtomicU64,
    /// Button-downs that arrived while the queue was full. Shown as "N clicks missed".
    pub dropped: AtomicU64,
    /// Every mouse movement seen, for the "input is happening but nothing arrives" check.
    pub moves: AtomicU64,
    /// Raw reports from touch screens and pens. Many per tap.
    pub touch_reports: AtomicU64,
    /// Message time of the latest touch or pen report.
    pub last_touch_tick: AtomicU32,
    /// Button-downs are queued only while this is true (Recording).
    pub enabled: AtomicBool,
    source: AtomicU8,
    /// When a mouse button last went down, any mouse input last arrived, and a key last went down
    /// (only while keys are read), for telling whether an app came to the front because of what
    /// the person did ([`Seen`]).
    last_press: Seen,
    last_mouse: Seen,
    last_key: Seen,
    /// Keys typed straight after the latest press (#97).
    press_typed: PressTyped,
    /// Unicode packets (`VK_PACKET`) seen while keys are read, and when the latest came: a field
    /// another program typed into keeps no value (#91). Never what they typed.
    packets: AtomicU64,
    last_packet: Seen,
    /// What was under the pointer as each recent click went down, by click id ([`Press`]).
    presses: Mutex<VecDeque<(u64, Press)>>,
    /// The left button's recent releases, each with the press it followed, for telling a drag
    /// from a click: a selection of cells dragged in Excel (04/10/2026).
    left_ups: Mutex<LeftUps>,
}

/// What the input thread read as a click went down, before the app could react to it.
#[derive(Debug, Clone)]
pub struct Press {
    /// The windows showing, front to back. By the time the click is handled the window clicked
    /// has come to the front, but the screenshot can still show what lay over it: those windows
    /// are greyed out by this (F014).
    pub stack: Vec<crate::window::ShownWindow>,
    /// The window clicked and, for the left button, its title-bar button under the pointer. A
    /// click on a window's Close button can close it before the click is handled, and then the
    /// point shows the window behind (#48).
    pub pressed: Option<crate::window::Pressed>,
}

/// The message time something was last seen at, or nothing yet.
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
/// down after it with nothing between that could have moved focus by key. A click moves focus as
/// the button goes down, and keys typed straight after it can be in the field it focused before
/// the focus news is read: the value read then isn't what the field held before (#97). Never
/// which keys.
///
/// Only text counts as typed: letters, digits, punctuation, space, the number pad's and an input
/// method's keys, `AltGr`'s characters included. Any other key that isn't Shift, a lock key or an
/// input method's own (Tab, Enter, Escape, the arrows, Home, End, the function keys, Backspace)
/// may move focus or change the field without typing, and so may a key with Ctrl, Alt or the
/// Windows key held, or a press of another button (a right click's menu takes the keys typed
/// after it): then the latest press isn't where focus came from (#97 second review).
#[derive(Debug, Default)]
struct PressTyped(Mutex<PressTypedState>);

#[derive(Debug, Default)]
struct PressTypedState {
    press: Option<(u32, (i32, i32))>,
    /// No key that could move focus has gone down since the press.
    open: bool,
    typed: bool,
    /// Ctrl, the left Alt, the Windows key and the right Alt held, a bit each.
    held: u8,
}

const HELD_CTRL: u8 = 1;
const HELD_LEFT_ALT: u8 = 2;
const HELD_WIN: u8 = 4;
const HELD_RIGHT_ALT: u8 = 8;

/// What a key, by its Windows virtual-key code, is to [`PressTyped`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    /// Ctrl, Alt or the Windows key: held with others.
    Held(u8),
    /// A key that types text, unless a combination's.
    Text,
    /// Types nothing and moves no focus: Shift, the lock keys, an input method's mode keys.
    Neutral,
    /// Anything else.
    Other,
}

/// What `vkey` is to [`PressTyped`]; `extended` (Windows' E0 prefix) tells the right Alt from
/// the left when Raw Input gives both as `VK_MENU`.
fn key_kind(vkey: u16, extended: bool) -> KeyKind {
    match vkey {
        0x11 | 0xA2 | 0xA3 => KeyKind::Held(HELD_CTRL),
        0x12 if extended => KeyKind::Held(HELD_RIGHT_ALT),
        0xA5 => KeyKind::Held(HELD_RIGHT_ALT),
        0x12 | 0xA4 => KeyKind::Held(HELD_LEFT_ALT),
        0x5B | 0x5C => KeyKind::Held(HELD_WIN),
        0x10 | 0xA0 | 0xA1 | 0x14 | 0x90 | 0x91 | 0x15..=0x1A | 0x1C..=0x1F => KeyKind::Neutral,
        // Space, digits, letters, the number pad's digits and signs, the OEM punctuation keys,
        // an input method's processed key (0xE5) and a Unicode packet (0xE7).
        0x20
        | 0x30..=0x39
        | 0x41..=0x5A
        | 0x60..=0x6F
        | 0x92..=0x96
        | 0xBA..=0xC2
        | 0xDB..=0xDF
        | 0xE1..=0xE7 => KeyKind::Text,
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

    /// A key read while a recording reads keys, by its Windows virtual-key code.
    fn key(&self, vkey: u16, extended: bool, up: bool) {
        let mut state = self.state();
        match key_kind(vkey, extended) {
            KeyKind::Held(bit) if up => state.held &= !bit,
            KeyKind::Held(bit) => state.held |= bit,
            _ if up => {}
            KeyKind::Neutral => {}
            // AltGr is Ctrl with the right Alt to Windows, which sends both: it types characters.
            KeyKind::Text if state.held == 0 || state.held == HELD_CTRL | HELD_RIGHT_ALT => {
                state.typed = true;
            }
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

/// How many clicks' presses are kept: more than can be waiting to be handled.
const PRESSES_KEPT: usize = 16;
/// How many left releases are kept: more than can come while one click is handled.
const LEFT_UPS_KEPT: usize = 16;

/// The left button's releases, paired with presses by order, never by time: a release belongs to
/// the left press just before it. Times can't pair them: a touchpad tap or an automated click
/// goes down and up within one tick of the message clock (about 15.6 ms), so its release looked
/// no later than its press and wasn't taken, and the next click's release made the first click a
/// drag (`Select "A1:B1"`, #64; the stray `Select "D2:E2"` before a fill-handle double-click, #66).
#[derive(Debug, Default)]
struct LeftUps {
    /// The latest left press: its id when it was queued, `None` when it wasn't (recording off, or
    /// the mouse copy of a touch tap). A release after it is its, and no earlier press's.
    press: Option<u64>,
    /// Recent releases, oldest first: the press each followed, then when and where.
    released: VecDeque<(Option<u64>, (u32, i32, i32))>,
}

/// What became of a left press's button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeftRelease {
    /// Still down, as far as is known: no release and no other left press since.
    Down,
    /// Released (time, x, y), before any other left press.
    Up(u32, i32, i32),
    /// Its release will never be known: another left press came first.
    Missed,
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
            presses: Mutex::new(VecDeque::new()),
            left_ups: Mutex::new(LeftUps::default()),
            last_press: Seen::default(),
            last_mouse: Seen::default(),
            last_key: Seen::default(),
            press_typed: PressTyped::default(),
            packets: AtomicU64::new(0),
            last_packet: Seen::default(),
        }
    }

    /// How many Unicode packets have come while keys were read, and the message time of the
    /// latest (#91).
    #[must_use]
    pub fn packets(&self) -> (u64, Option<u32>) {
        (self.packets.load(Ordering::Relaxed), self.last_packet.get())
    }

    /// When a mouse button last went down (message time), whether or not it was recorded.
    #[must_use]
    pub fn last_press(&self) -> Option<u32> {
        self.last_press.get()
    }

    /// When any mouse input (movement, a button, the wheel) last arrived.
    #[must_use]
    pub fn last_mouse(&self) -> Option<u32> {
        self.last_mouse.get()
    }

    /// When a touch screen or pen last reported.
    #[must_use]
    pub fn last_touch(&self) -> Option<u32> {
        (self.touch_reports.load(Ordering::Relaxed) > 0)
            .then(|| self.last_touch_tick.load(Ordering::Relaxed))
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

    fn note_mouse(&self, tick_ms: u32) {
        self.last_mouse.note(tick_ms);
    }

    /// What became of left press `press`'s button while recording: released (when, where) before
    /// any other left press, still down, or never to be known.
    #[must_use]
    pub fn left_release(&self, press: u64) -> LeftRelease {
        let ups = self.left_ups.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, up)) = ups.released.iter().find(|(of, _)| *of == Some(press)) {
            LeftRelease::Up(up.0, up.1, up.2)
        } else if ups.press == Some(press) {
            LeftRelease::Down
        } else {
            LeftRelease::Missed
        }
    }

    fn record_left_up(&self, tick_ms: u32, x: i32, y: i32) {
        if self.enabled.load(Ordering::Relaxed) {
            let mut ups = self.left_ups.lock().unwrap_or_else(PoisonError::into_inner);
            if ups.released.len() >= LEFT_UPS_KEPT {
                ups.released.pop_front();
            }
            let press = ups.press;
            ups.released.push_back((press, (tick_ms, x, y)));
        }
    }

    /// The left button went down: `press` is its id when it was queued.
    fn note_left_press(&self, press: Option<u64>) {
        self.left_ups
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .press = press;
    }

    /// What was under the pointer when click `id` went down. Taken once.
    #[must_use]
    pub fn take_press(&self, id: u64) -> Option<Press> {
        let mut presses = self.presses.lock().unwrap_or_else(PoisonError::into_inner);
        let at = presses.iter().position(|(click, _)| *click == id)?;
        presses.remove(at).map(|(_, press)| press)
    }

    /// Next queued button-down, if any.
    #[must_use]
    pub fn pop(&self) -> Option<MouseDown> {
        self.queue.pop()
    }

    /// Next foreground change, if any. Only the latest 32 are kept.
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

    /// The mouse source currently installed.
    #[must_use]
    pub fn source(&self) -> InputSource {
        InputSource::from_u8(self.source.load(Ordering::SeqCst))
    }

    /// Empties the queues, e.g. before a new recording starts.
    pub fn clear(&self) {
        self.presses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        *self.left_ups.lock().unwrap_or_else(PoisonError::into_inner) = LeftUps::default();
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
            if button == MouseButton::Left {
                self.note_left_press(None);
            }
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
        // Noted before what's under the pointer is read: its release can't be handled on this
        // thread until this press is done, so it pairs with this press by order.
        if button == MouseButton::Left {
            self.note_left_press(Some(event.id));
        }
        // Read now, before the window clicked comes to the front or reacts to the click: a
        // millisecond or two, and never more than the hit test's budget (30 ms) for a busy window.
        // Only the left button presses a title-bar button.
        let press = Press {
            stack: crate::window::shown_windows(),
            pressed: crate::window::pressed_at(x, y, button == MouseButton::Left),
        };
        {
            let mut presses = self.presses.lock().unwrap_or_else(PoisonError::into_inner);
            if presses.len() >= PRESSES_KEPT {
                presses.pop_front();
            }
            presses.push_back((event.id, press));
        }
        if self.queue.push(event).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_key(&self, event: KeyEvent) {
        // The keyboard is only registered for a recording that asked for it. Between Pause (or
        // Stop) and the registration being removed, keys are dropped here.
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        self.press_typed.key(event.vkey, event.extended, event.up);
        if !event.up {
            self.last_key.note(event.tick_ms);
            // Counted here, as it arrives: the focus handler reads a field's value the moment
            // focus leaves it, and the key worker handles keys 150 ms later.
            if event.vkey == VK_PACKET {
                self.packets.fetch_add(1, Ordering::Relaxed);
                self.last_packet.note(event.tick_ms);
            }
        }
        if self.keys.push(event).is_err() {
            self.keys_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_move(&self) {
        self.moves.fetch_add(1, Ordering::Relaxed);
    }

    fn record_touch(&self, tick_ms: u32) {
        self.last_touch_tick.store(tick_ms, Ordering::Relaxed);
        self.touch_reports.fetch_add(1, Ordering::Relaxed);
    }

    fn record_foreground(&self, change: ForegroundChange) {
        // Keep the latest: the recorder only needs to know where focus ended up.
        let _ = self.foreground.force_push(change);
    }
}

/// Queue size: far more than any human burst (docs/spec/02-capture.md#on-each-click).
pub const QUEUE_CAPACITY: usize = 256;
/// Key events (a down and an up per key): many seconds of the fastest typing.
pub const KEY_QUEUE_CAPACITY: usize = 2048;

// Window, hook and WinEvent procedures carry no user data, so the shared state is process-wide.
static SHARED: OnceLock<Arc<InputShared>> = OnceLock::new();
static CAPACITY: AtomicUsize = AtomicUsize::new(QUEUE_CAPACITY);
static RUNNING: AtomicBool = AtomicBool::new(false);
/// Our Raw Input window, for checking registrations from any thread.
static RAW_WINDOW: AtomicIsize = AtomicIsize::new(0);

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

/// How many Unicode packets (`VK_PACKET`) have come while a recording read keys, and the message
/// time of the latest: `(0, None)` before input was first registered (#91). Never what they typed.
#[must_use]
pub fn unicode_packets() -> (u64, Option<u32>) {
    SHARED.get().map_or((0, None), |shared| shared.packets())
}

/// The message time of the latest press of the left button, and where it was, when keys that type
/// text went down after it (only while a recording reads keys) and none that could move focus by
/// key: any other key but Shift, a lock key or an input method's, or one with Ctrl, Alt or the
/// Windows key held (`AltGr`'s characters aside), and no press of another button. Keys typed
/// straight after a click can be in a field before its focus news is read (#97). Never which
/// button or key.
#[must_use]
pub fn typed_after_press() -> Option<(u32, (i32, i32))> {
    SHARED.get().and_then(|shared| shared.typed_after_press())
}

/// A thread message that tells the input thread a command is waiting.
const WM_APP_COMMAND: u32 = WM_APP + 1;
/// How long a caller waits for the input thread to carry out a command.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
enum Command {
    SetSource(InputSource),
    Reregister,
    SetKeyboard(bool),
}

type CommandMessage = (Command, Sender<Result<()>>);

/// The running input thread. Stops the thread, and removes every registration, when dropped.
#[derive(Debug)]
pub struct InputCapture {
    thread: Option<JoinHandle<()>>,
    thread_id: u32,
    commands: Sender<CommandMessage>,
    shared: Arc<InputShared>,
}

impl InputCapture {
    /// Starts the input thread with its own message loop.
    ///
    /// # Errors
    /// If another input thread is already running in this process, or Windows refuses the
    /// window or the mouse source.
    pub fn start(source: InputSource) -> Result<Self> {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err(Error::AlreadyRunning);
        }
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32>>();
        let (command_tx, command_rx) = mpsc::channel::<CommandMessage>();
        let spawned = std::thread::Builder::new()
            .name("amluto-input".into())
            .spawn(move || run_input_thread(source, &command_rx, &ready_tx));
        let Ok(thread) = spawned else {
            RUNNING.store(false, Ordering::SeqCst);
            return Err(Error::InputThreadGone);
        };

        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok(Self {
                thread: Some(thread),
                thread_id,
                commands: command_tx,
                shared: Arc::clone(shared()),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                RUNNING.store(false, Ordering::SeqCst);
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                RUNNING.store(false, Ordering::SeqCst);
                Err(Error::InputThreadGone)
            }
        }
    }

    #[must_use]
    pub fn shared(&self) -> &Arc<InputShared> {
        &self.shared
    }

    /// The mouse source currently installed.
    #[must_use]
    pub fn source(&self) -> InputSource {
        self.shared.source()
    }

    /// Switches the mouse source (Raw Input ↔ hook). The old one is removed first, so a click
    /// is never counted twice.
    ///
    /// # Errors
    /// If Windows refuses the new source, or the input thread doesn't answer.
    pub fn set_source(&self, source: InputSource) -> Result<()> {
        self.command(Command::SetSource(source))
    }

    /// Registers the current source again: Raw Input registrations are renewed, the hook is
    /// reinstalled.
    ///
    /// # Errors
    /// As for [`Self::set_source`].
    pub fn reregister(&self) -> Result<()> {
        self.command(Command::Reregister)
    }

    /// Registers the keyboard (`true`) or removes it (`false`). Only a recording with "Record
    /// what's typed" ticked turns it on, and Pause and Stop turn it off again.
    ///
    /// # Errors
    /// If Windows refuses the registration, or the input thread doesn't answer.
    pub fn set_keyboard(&self, on: bool) -> Result<()> {
        self.command(Command::SetKeyboard(on))
    }

    /// Whether the input thread is still alive (it ends if its message loop fails).
    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }

    /// Stops the input thread and removes every registration and hook.
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn command(&self, command: Command) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send((command, reply_tx))
            .map_err(|_| Error::InputThreadGone)?;
        // SAFETY: posts a plain thread message to our own input thread; no pointers involved.
        unsafe { PostThreadMessageW(self.thread_id, WM_APP_COMMAND, WPARAM(0), LPARAM(0)) }?;
        reply_rx
            .recv_timeout(COMMAND_TIMEOUT)
            .map_err(|_| Error::InputThreadGone)?
    }

    fn stop_inner(&mut self) {
        self.shared.enabled.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // SAFETY: posts WM_QUIT to our own input thread's queue; no pointers involved.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = thread.join();
        }
        RUNNING.store(false, Ordering::SeqCst);
    }
}

impl Drop for InputCapture {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

/// Which of our Raw Input registrations are still in place. Readable from any thread: Windows
/// keeps one table per process.
#[must_use]
pub fn registration() -> Registration {
    let ours = RAW_WINDOW.load(Ordering::SeqCst);
    if ours == 0 {
        return Registration::default();
    }
    let devices = registered_devices();
    let is_ours = |page: u16, usage: u16| {
        devices.iter().any(|device| {
            device.usUsagePage == page
                && device.usUsage == usage
                && device.hwndTarget.0 as isize == ours
                && device.dwFlags.0 & RIDEV_INPUTSINK.0 != 0
        })
    };
    Registration {
        mouse: is_ours(PAGE_GENERIC, USAGE_MOUSE),
        digitizers: is_ours(PAGE_DIGITIZER, USAGE_TOUCH_SCREEN)
            && is_ours(PAGE_DIGITIZER, USAGE_PEN),
        keyboard: is_ours(PAGE_GENERIC, USAGE_KEYBOARD),
    }
}

fn registered_devices() -> Vec<RAWINPUTDEVICE> {
    let size = raw_device_size();
    // The table can change between the two calls (another thread registering), so retry once.
    for _ in 0..2 {
        let mut count = 0u32;
        // SAFETY: a null buffer asks only for the number of entries, written to a local.
        unsafe { GetRegisteredRawInputDevices(None, &raw mut count, size) };
        if count == 0 {
            return Vec::new();
        }
        let mut devices = vec![RAWINPUTDEVICE::default(); usize::try_from(count).unwrap_or(0)];
        // SAFETY: `devices` holds `count` entries of `size` bytes each, as the call is told.
        let written = unsafe {
            GetRegisteredRawInputDevices(Some(devices.as_mut_ptr()), &raw mut count, size)
        };
        if written != u32::MAX {
            devices.truncate(usize::try_from(written).unwrap_or(0));
            return devices;
        }
    }
    Vec::new()
}

// ---------- the input thread ----------

const PAGE_GENERIC: u16 = 0x01;
const USAGE_MOUSE: u16 = 0x02;
const USAGE_KEYBOARD: u16 = 0x06;
const PAGE_DIGITIZER: u16 = 0x0D;
const USAGE_PEN: u16 = 0x02;
const USAGE_TOUCH_SCREEN: u16 = 0x04;

/// Everything the input thread owns. Only touched on that thread.
struct ThreadState {
    window: HWND,
    hook: Option<HHOOK>,
    foreground_hook: Option<HWINEVENTHOOK>,
    /// Whether the keyboard should be registered, so re-registering puts it back too.
    keyboard: bool,
}

fn run_input_thread(
    source: InputSource,
    commands: &Receiver<CommandMessage>,
    ready: &Sender<Result<u32>>,
) {
    // SAFETY: no arguments; returns this thread's id.
    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = shared();
    let window = match create_raw_input_window() {
        Ok(window) => window,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    RAW_WINDOW.store(window.0 as isize, Ordering::SeqCst);
    let mut state = ThreadState {
        window,
        hook: None,
        foreground_hook: None,
        keyboard: false,
    };

    if let Err(error) = state.set_source(source) {
        state.shut_down();
        let _ = ready.send(Err(error));
        return;
    }
    // Touch detection and app-switch events are best-effort: the recorder still works without
    // them, and reports the missing touch registration through `registration()`.
    let _ = state.register_digitizers();
    state.foreground_hook = install_foreground_hook();

    let _ = ready.send(Ok(thread_id));

    let mut message = MSG::default();
    loop {
        // SAFETY: `message` is a MSG owned by this frame; a null window means any message for
        // this thread, including thread messages.
        let result = unsafe { GetMessageW(&raw mut message, None, 0, 0) };
        if result.0 <= 0 {
            break;
        }
        if message.hwnd.is_invalid() && message.message == WM_APP_COMMAND {
            while let Ok((command, reply)) = commands.try_recv() {
                let _ = reply.send(state.run(command));
            }
            continue;
        }
        // SAFETY: dispatches a message we just received on this thread.
        unsafe { DispatchMessageW(&raw const message) };
    }
    state.shut_down();
}

impl ThreadState {
    fn run(&mut self, command: Command) -> Result<()> {
        match command {
            Command::SetSource(source) => self.set_source(source),
            Command::Reregister => {
                let source = shared().source();
                if source == InputSource::Hook {
                    self.remove_hook();
                }
                self.set_source(source)?;
                let _ = self.register_digitizers();
                if self.keyboard {
                    register(&[device(PAGE_GENERIC, USAGE_KEYBOARD, self.window)])?;
                }
                Ok(())
            }
            Command::SetKeyboard(on) => {
                if on {
                    register(&[device(PAGE_GENERIC, USAGE_KEYBOARD, self.window)])?;
                } else {
                    remove(PAGE_GENERIC, USAGE_KEYBOARD);
                }
                self.keyboard = on;
                Ok(())
            }
        }
    }

    fn set_source(&mut self, source: InputSource) -> Result<()> {
        match source {
            InputSource::RawInput => {
                self.remove_hook();
                register(&[device(PAGE_GENERIC, USAGE_MOUSE, self.window)])?;
            }
            InputSource::Hook => {
                remove(PAGE_GENERIC, USAGE_MOUSE);
                if self.hook.is_none() {
                    self.hook = Some(install_mouse_hook()?);
                }
            }
        }
        shared().source.store(source.to_u8(), Ordering::SeqCst);
        Ok(())
    }

    fn register_digitizers(&self) -> Result<()> {
        register(&[
            device(PAGE_DIGITIZER, USAGE_TOUCH_SCREEN, self.window),
            device(PAGE_DIGITIZER, USAGE_PEN, self.window),
        ])
    }

    fn remove_hook(&mut self) {
        if let Some(hook) = self.hook.take() {
            // SAFETY: unhooks a hook this thread installed, exactly once (it was taken out).
            let _ = unsafe { UnhookWindowsHookEx(hook) };
        }
    }

    fn shut_down(&mut self) {
        if let Some(hook) = self.foreground_hook.take() {
            // SAFETY: removes the WinEvent hook this thread installed, exactly once.
            let _ = unsafe { UnhookWinEvent(hook) };
        }
        self.remove_hook();
        remove(PAGE_GENERIC, USAGE_MOUSE);
        remove(PAGE_GENERIC, USAGE_KEYBOARD);
        remove(PAGE_DIGITIZER, USAGE_TOUCH_SCREEN);
        remove(PAGE_DIGITIZER, USAGE_PEN);
        RAW_WINDOW.store(0, Ordering::SeqCst);
        // SAFETY: destroys the message-only window this thread created, exactly once.
        let _ = unsafe { DestroyWindow(self.window) };
    }
}

fn module_instance() -> Result<HINSTANCE> {
    // SAFETY: `None` asks for this executable's own module handle, which lives for the process.
    let module = unsafe { GetModuleHandleW(None) }?;
    Ok(HINSTANCE(module.0))
}

fn raw_device_size() -> u32 {
    u32::try_from(std::mem::size_of::<RAWINPUTDEVICE>()).unwrap_or(0)
}

fn device(page: u16, usage: u16, window: HWND) -> RAWINPUTDEVICE {
    RAWINPUTDEVICE {
        usUsagePage: page,
        usUsage: usage,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: window,
    }
}

fn register(devices: &[RAWINPUTDEVICE]) -> Result<()> {
    // SAFETY: registers device structs that live on the caller's stack for the whole call.
    unsafe { RegisterRawInputDevices(devices, raw_device_size()) }?;
    Ok(())
}

fn remove(page: u16, usage: u16) {
    let device = RAWINPUTDEVICE {
        usUsagePage: page,
        usUsage: usage,
        dwFlags: RIDEV_REMOVE,
        hwndTarget: HWND::default(),
    };
    // SAFETY: as in `register`. Removing a usage that isn't registered fails harmlessly.
    let _ = unsafe { RegisterRawInputDevices(&[device], raw_device_size()) };
}

fn create_raw_input_window() -> Result<HWND> {
    let instance = module_instance()?;
    let class = WNDCLASSEXW {
        cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap_or(0),
        lpfnWndProc: Some(raw_input_window_proc),
        hInstance: instance,
        lpszClassName: w!("AmlutoStepsRawInput"),
        ..WNDCLASSEXW::default()
    };
    // SAFETY: `class` is fully initialised and its strings are static. Registering the same class
    // again (a later recording) fails harmlessly, so the result isn't checked.
    unsafe { RegisterClassExW(&raw const class) };

    // SAFETY: creates a message-only window (HWND_MESSAGE parent) of the class registered above.
    // Creating it also gives this thread the message queue that thread messages need.
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("AmlutoStepsRawInput"),
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )
    }?;
    Ok(window)
}

// ---------- WH_MOUSE_LL (fallback) ----------

fn install_mouse_hook() -> Result<HHOOK> {
    let instance = module_instance()?;
    // SAFETY: `mouse_hook_proc` has the HOOKPROC signature, catches its own panics and always
    // calls CallNextHookEx. It lives for the whole program.
    let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), Some(instance), 0) }?;
    Ok(hook)
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && u32::try_from(code).is_ok_and(|code| code == HC_ACTION) {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            // SAFETY: for WH_MOUSE_LL with HC_ACTION, `lparam` points to a MSLLHOOKSTRUCT that is
            // valid for the duration of this call. It is copied, never kept.
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let message = u32::try_from(wparam.0).unwrap_or(0);
            let injected = info.flags & LLMHF_INJECTED != 0;
            let button = match message {
                WM_LBUTTONDOWN => Some(MouseButton::Left),
                WM_RBUTTONDOWN => Some(MouseButton::Right),
                WM_MBUTTONDOWN => Some(MouseButton::Middle),
                _ => None,
            };
            let shared = shared();
            shared.note_mouse(info.time);
            if let Some(button) = button {
                mouse_down(info.time, info.pt.x, info.pt.y, button, injected);
            } else if message == WM_LBUTTONUP {
                shared.record_left_up(info.time, info.pt.x, info.pt.y);
            } else if message == WM_MOUSEMOVE {
                shared.record_move();
            }
        }));
    }
    // SAFETY: passes the unchanged arguments down the hook chain, as Windows requires.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

// ---------- foreground changes ----------

fn install_foreground_hook() -> Option<HWINEVENTHOOK> {
    // SAFETY: out-of-context WinEvent hook: Windows calls `foreground_proc` on this thread
    // through its message loop, and loads nothing into other processes. The procedure catches
    // its own panics and lives for the whole program.
    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    (!hook.is_invalid()).then_some(hook)
}

unsafe extern "system" fn foreground_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    window: HWND,
    object: i32,
    _child: i32,
    _thread: u32,
    time: u32,
) {
    // OBJID_WINDOW is 0: the event is about the window itself.
    if event == EVENT_SYSTEM_FOREGROUND && object == 0 && !window.is_invalid() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            shared().record_foreground(ForegroundChange {
                hwnd: window.0 as isize,
                tick_ms: time,
            });
        }));
    }
}

// ---------- Raw Input ----------

unsafe extern "system" fn raw_input_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT {
        let _ = catch_unwind(AssertUnwindSafe(|| read_raw_input(lparam)));
    }
    // SAFETY: default handling for every message, with the unchanged arguments. For WM_INPUT
    // this also frees the raw input data.
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

fn read_raw_input(lparam: LPARAM) {
    let handle = HRAWINPUT(lparam.0 as *mut std::ffi::c_void);
    let header_size = u32::try_from(std::mem::size_of::<RAWINPUTHEADER>()).unwrap_or(0);

    // The header first: touch reports can be larger than RAWINPUT, and only need counting.
    let mut header = RAWINPUTHEADER::default();
    let mut size = header_size;
    // SAFETY: `header` is a RAWINPUTHEADER-sized buffer owned by this frame and `size` says so.
    let copied = unsafe {
        GetRawInputData(
            handle,
            RID_HEADER,
            Some((&raw mut header).cast()),
            &raw mut size,
            header_size,
        )
    };
    if copied == u32::MAX {
        return;
    }
    // SAFETY: no arguments; the time of the message being processed.
    let tick = u32::try_from(unsafe { GetMessageTime() }).unwrap_or(0);

    if header.dwType == RIM_TYPEHID.0 {
        read_raw_touch(handle, &header, header_size, tick);
        return;
    }
    if header.dwType != RIM_TYPEMOUSE.0 && header.dwType != RIM_TYPEKEYBOARD.0 {
        return;
    }

    let mut raw = RAWINPUT::default();
    let mut size = u32::try_from(std::mem::size_of::<RAWINPUT>()).unwrap_or(0);
    // SAFETY: `raw` is a RAWINPUT-sized buffer owned by this frame and `size` says so. Mouse
    // packets always fit; anything larger is rejected by the call and ignored here.
    let copied = unsafe {
        GetRawInputData(
            handle,
            RID_INPUT,
            Some((&raw mut raw).cast()),
            &raw mut size,
            header_size,
        )
    };
    if copied == u32::MAX {
        return;
    }
    if raw.header.dwType == RIM_TYPEMOUSE.0 {
        read_raw_mouse(&raw, tick);
    } else if raw.header.dwType == RIM_TYPEKEYBOARD.0 {
        read_raw_keyboard(&raw, tick);
    }
}

/// `RAWKEYBOARD.Flags`: the key went up, and the E0 prefix.
const RI_KEY_BREAK: u16 = 1;
const RI_KEY_E0: u16 = 2;
/// The `VKey` of the fake key Windows sends around some keys (Pause, the E1 sequences).
const VK_FAKE: u16 = 0xFF;

/// A character another program sent as a key (`SendInput` with `KEYEVENTF_UNICODE`): a password
/// manager's auto-type, or voice typing and the touch keyboard in an app that can't take text
/// any other way. One UTF-16 unit per packet.
pub const VK_PACKET: u16 = 0xE7;

fn read_raw_keyboard(raw: &RAWINPUT, tick: u32) {
    // SAFETY: the caller checked dwType is RIM_TYPEKEYBOARD, so `keyboard` is the active member.
    let keyboard = unsafe { raw.data.keyboard };
    // SAFETY: no arguments; the window in front now, which is where this key is going.
    let foreground = unsafe { GetForegroundWindow() };
    if let Some(event) = raw_key(
        keyboard.VKey,
        keyboard.MakeCode,
        keyboard.Flags,
        raw.header.hDevice.is_invalid(),
        tick,
        foreground.0 as isize,
    ) {
        shared().record_key(event);
    }
}

/// A key event from Raw Input's fields. `injected`: it came with no device (`SendInput`). A
/// Unicode packet's character is never copied: text another program typed keeps no value
/// (decision of 11/10/2026), so it doesn't leave this thread. An injected key with no virtual
/// key is taken as a packet too, in case Windows reports packets that way.
fn raw_key(
    vkey: u16,
    make_code: u16,
    flags: u16,
    injected: bool,
    tick: u32,
    foreground: isize,
) -> Option<KeyEvent> {
    if vkey == VK_FAKE || (vkey == 0 && !injected) {
        return None;
    }
    let packet = vkey == VK_PACKET || vkey == 0;
    Some(KeyEvent {
        tick_ms: tick,
        vkey: if packet { VK_PACKET } else { vkey },
        scan: if packet { 0 } else { make_code },
        extended: flags & RI_KEY_E0 != 0,
        up: flags & RI_KEY_BREAK != 0,
        injected,
        foreground,
    })
}

fn read_raw_mouse(raw: &RAWINPUT, tick: u32) {
    // SAFETY: the caller checked dwType is RIM_TYPEMOUSE, so `mouse` is the active member.
    let mouse = unsafe { raw.data.mouse };
    // SAFETY: RAWMOUSE's button fields are a plain-integer union; reading the struct view is always valid.
    let flags = u32::from(unsafe { mouse.Anonymous.Anonymous.usButtonFlags });
    let shared = shared();
    shared.note_mouse(tick);

    if mouse.lLastX != 0 || mouse.lLastY != 0 {
        shared.record_move();
    }
    if flags & BUTTON_FLAGS == 0 {
        return;
    }
    let (left_up, button) = logical_buttons(flags, buttons_swapped());
    if left_up {
        // SAFETY: no arguments; describes the message currently being processed.
        let (x, y) = unpack_message_pos(unsafe { GetMessagePos() });
        shared.record_left_up(tick, x, y);
    }
    let Some(button) = button else {
        return;
    };

    // Raw Input carries no position. GetMessagePos is where the cursor was when this message was
    // generated; GetCursorPos would be where it is now, which drifts if the mouse keeps moving.
    // SAFETY: no arguments; describes the message currently being processed.
    let (x, y) = unpack_message_pos(unsafe { GetMessagePos() });
    // Injected input (SendInput) arrives with no device handle.
    let injected = raw.header.hDevice.is_invalid();
    mouse_down(tick, x, y, button, injected);
}

/// The Raw Input flags of the buttons [`logical_buttons`] reads.
const BUTTON_FLAGS: u32 = RI_MOUSE_LEFT_BUTTON_DOWN
    | RI_MOUSE_LEFT_BUTTON_UP
    | RI_MOUSE_RIGHT_BUTTON_DOWN
    | RI_MOUSE_RIGHT_BUTTON_UP
    | RI_MOUSE_MIDDLE_BUTTON_DOWN;

/// Whether the person has swapped the mouse's buttons (Settings > Bluetooth & devices > Mouse >
/// Primary mouse button: Right), as many left-handed people do.
fn buttons_swapped() -> bool {
    // SAFETY: no pointers; GetSystemMetrics only reads a system setting.
    unsafe { GetSystemMetrics(SM_SWAPBUTTON) != 0 }
}

/// What Raw Input's button `flags` are as Windows' messages have them: whether the primary
/// ("left") button came up, and which button went down. Raw Input reports the buttons where they
/// are on the mouse; with the buttons `swapped`, the right one is the primary button, which apps
/// get as `WM_LBUTTONDOWN`, and the left one shows the context menu (the #97 third review: for a
/// left-handed person the rules for a right click worked backwards).
fn logical_buttons(flags: u32, swapped: bool) -> (bool, Option<MouseButton>) {
    let (primary_down, primary_up, secondary_down) = if swapped {
        (
            RI_MOUSE_RIGHT_BUTTON_DOWN,
            RI_MOUSE_RIGHT_BUTTON_UP,
            RI_MOUSE_LEFT_BUTTON_DOWN,
        )
    } else {
        (
            RI_MOUSE_LEFT_BUTTON_DOWN,
            RI_MOUSE_LEFT_BUTTON_UP,
            RI_MOUSE_RIGHT_BUTTON_DOWN,
        )
    };
    let button = if flags & primary_down != 0 {
        Some(MouseButton::Left)
    } else if flags & secondary_down != 0 {
        Some(MouseButton::Right)
    } else if flags & RI_MOUSE_MIDDLE_BUTTON_DOWN != 0 {
        Some(MouseButton::Middle)
    } else {
        None
    };
    (flags & primary_up != 0, button)
}

// ---------- touch screens and pens ----------

/// A tap and a mouse click this close in place (pixels) and time (ms) are one press: kept once.
const SAME_PRESS_PX: i32 = 40;
const SAME_PRESS_MS: u32 = 400;
/// How long a device's mapping to the screen is used before it's read again (a display can be
/// turned or its resolution changed while recording).
const MAPPING_MS: u32 = 1000;

/// A digitizer this thread has seen: its description (none when its reports can't be read) and
/// where it was last mapped.
struct Known {
    digitizer: Option<Digitizer>,
    mapping: Option<(Screen, Rotation)>,
    mapped_at: u32,
}

/// What the input thread keeps about touch. Only touched on that thread.
#[derive(Default)]
struct TouchState {
    devices: HashMap<isize, Known>,
    taps: TapTracker,
    /// The latest tap and mouse click (tick, x, y), so one press isn't recorded twice.
    last_tap: Option<(u32, i32, i32)>,
    last_mouse: Option<(u32, i32, i32)>,
}

thread_local! {
    static TOUCH: RefCell<TouchState> = RefCell::new(TouchState::default());
}

const fn same_press(a: (u32, i32, i32), tick: u32, x: i32, y: i32) -> bool {
    tick.wrapping_sub(a.0) <= SAME_PRESS_MS
        && (a.1 - x).abs() <= SAME_PRESS_PX
        && (a.2 - y).abs() <= SAME_PRESS_PX
}

/// A mouse button went down: recorded, unless it is a tap that also arrived as mouse input (the
/// tap is recorded when the finger lifts). Only a recorded click is remembered, so a tap and its
/// mouse copy never cancel each other out.
fn mouse_down(tick: u32, x: i32, y: i32, button: MouseButton, injected: bool) {
    let duplicate = TOUCH.with(|touch| {
        let mut touch = touch.borrow_mut();
        let duplicate = touch.taps.near(x, y, SAME_PRESS_PX)
            || touch
                .last_tap
                .is_some_and(|tap| same_press(tap, tick, x, y));
        if !duplicate {
            touch.last_mouse = Some((tick, x, y));
        }
        duplicate
    });
    if !duplicate {
        shared().record_down(tick, x, y, button, injected);
    } else if button == MouseButton::Left {
        // The tap is the click; the release of its mouse copy is no earlier press's.
        shared().note_left_press(None);
    }
}

/// A digitizer's report: its contacts, placed on the screen, and any taps that ended in it.
fn read_raw_touch(handle: HRAWINPUT, header: &RAWINPUTHEADER, header_size: u32, tick: u32) {
    let key = header.hDevice.0 as isize;
    let mut size = 0_u32;
    // SAFETY: a null buffer asks only for the size of this input.
    let _ = unsafe { GetRawInputData(handle, RID_INPUT, None, &raw mut size, header_size) };
    let data_at = std::mem::offset_of!(RAWINPUT, data);
    let reports_at = data_at + std::mem::offset_of!(windows::Win32::UI::Input::RAWHID, bRawData);
    if (size as usize) < reports_at || size > 1 << 20 {
        shared().record_touch(tick);
        return;
    }
    // In 8-byte words, for RAWINPUT's alignment.
    let mut buffer = vec![0_u64; (size as usize).div_ceil(8)];
    // SAFETY: `buffer` holds at least `size` bytes, as `size` says.
    let copied = unsafe {
        GetRawInputData(
            handle,
            RID_INPUT,
            Some(buffer.as_mut_ptr().cast()),
            &raw mut size,
            header_size,
        )
    };
    if copied == u32::MAX || (copied as usize) < reports_at {
        shared().record_touch(tick);
        return;
    }
    // SAFETY: the first `copied` bytes of `buffer` were just written by GetRawInputData.
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast(), copied as usize) };
    let word = |at: usize| {
        bytes
            .get(at..at + 4)
            .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
            .map_or(0, u32::from_ne_bytes) as usize
    };
    // RAWHID: the size of each report, how many there are, then the reports one after another.
    let (report_size, count) = (word(data_at), word(data_at + 4));

    let taps = TOUCH.with(|touch| {
        let mut touch = touch.borrow_mut();
        let known = touch.devices.entry(key).or_insert_with(|| Known {
            digitizer: Digitizer::open(header.hDevice),
            mapping: None,
            mapped_at: 0,
        });
        if known.mapping.is_none() || tick.wrapping_sub(known.mapped_at) >= MAPPING_MS {
            known.mapping = mapping(header.hDevice);
            known.mapped_at = tick;
        }
        let (Some(digitizer), Some((screen, rotation))) = (&known.digitizer, known.mapping) else {
            return None;
        };
        let contacts: Vec<_> = (0..count.min(64))
            .filter_map(|index| {
                bytes.get(reports_at + index * report_size..reports_at + (index + 1) * report_size)
            })
            .flat_map(|report| digitizer.contacts(report, screen, rotation))
            .collect();
        let taps = touch.taps.update(key, &contacts, tick);
        let last_mouse = touch.last_mouse;
        let kept: Vec<_> = taps
            .into_iter()
            .filter(|tap| {
                !last_mouse
                    .is_some_and(|mouse| same_press(mouse, tap.tick_ms.max(mouse.0), tap.x, tap.y))
            })
            .collect();
        if let Some(tap) = kept.last() {
            touch.last_tap = Some((tick, tap.x, tap.y));
        }
        Some(kept)
    });
    match taps {
        // A device whose reports can't be read, or that isn't mapped to a screen: counted, so the
        // recorder can say taps may be missing.
        None => shared().record_touch(tick),
        Some(taps) => {
            for tap in taps {
                let button = if tap.held {
                    MouseButton::Right
                } else {
                    MouseButton::Left
                };
                shared().record_down(tap.tick_ms, tap.x, tap.y, button, false);
            }
        }
    }
}

/// Splits a `GetMessagePos` value: signed 16-bit x in the low word, y in the high word
/// (negative on monitors left of or above the primary).
fn unpack_message_pos(packed: u32) -> (i32, i32) {
    let low = u16::try_from(packed & 0xFFFF).unwrap_or(0);
    let high = u16::try_from(packed >> 16).unwrap_or(0);
    (i32::from(low.cast_signed()), i32::from(high.cast_signed()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_queue_counts_drops_instead_of_blocking() {
        let shared = InputShared::new(2);
        shared.enabled.store(true, Ordering::Relaxed);
        for _ in 0..5 {
            shared.record_down(0, 1, 1, MouseButton::Left, false);
        }
        assert_eq!(shared.queued(), 2);
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 3);
        assert_eq!(shared.pop().map(|event| event.id), Some(1));
    }

    #[test]
    fn keys_are_dropped_while_disabled_and_counted_when_full() {
        let shared = InputShared::new(2);
        let key = KeyEvent {
            tick_ms: 0,
            vkey: 0x41,
            scan: 0x1E,
            extended: false,
            up: false,
            injected: false,
            foreground: 1,
        };
        shared.record_key(key);
        assert!(shared.pop_key().is_none());
        shared.enabled.store(true, Ordering::Relaxed);
        for _ in 0..(KEY_QUEUE_CAPACITY + 3) {
            shared.record_key(key);
        }
        assert_eq!(shared.keys_dropped.load(Ordering::Relaxed), 3);
        shared.clear();
        assert!(shared.pop_key().is_none());
    }

    #[test]
    fn unicode_packets_are_counted_never_read() {
        // Auto-type sends each UTF-16 unit as a packet, down then up: an emoji is two.
        let shared = InputShared::new(2);
        let packet = |tick_ms, up| KeyEvent {
            tick_ms,
            vkey: VK_PACKET,
            scan: 0,
            extended: false,
            up,
            injected: true,
            foreground: 1,
        };
        shared.record_key(packet(10, false));
        assert_eq!(shared.packets(), (0, None), "not while keys aren't read");
        shared.enabled.store(true, Ordering::Relaxed);
        for (tick, up) in [(20, false), (21, true), (30, false), (31, true)] {
            shared.record_key(packet(tick, up));
        }
        shared.record_key(KeyEvent {
            vkey: 0x41,
            ..packet(40, false)
        });
        assert_eq!(shared.packets(), (2, Some(30)));
    }

    /// A key going down or up at `tick_ms`, as the keyboard sends it.
    fn key(tick_ms: u32, vkey: u16, up: bool) -> KeyEvent {
        KeyEvent {
            tick_ms,
            vkey,
            scan: 0,
            extended: false,
            up,
            injected: false,
            foreground: 1,
        }
    }

    /// `button` going down at `tick` at (40, 50). Noted whether or not the press is recorded; with
    /// recording off, nothing under it is read, so the test reads no windows.
    fn press_button(shared: &InputShared, tick: u32, button: MouseButton) {
        shared.enabled.store(false, Ordering::Relaxed);
        shared.record_down(tick, 40, 50, button, false);
        shared.enabled.store(true, Ordering::Relaxed);
    }

    #[test]
    fn swapped_buttons_are_read_as_windows_has_them() {
        // Right-handed: the buttons are where they are.
        assert_eq!(
            logical_buttons(RI_MOUSE_LEFT_BUTTON_DOWN, false),
            (false, Some(MouseButton::Left))
        );
        assert_eq!(
            logical_buttons(RI_MOUSE_RIGHT_BUTTON_DOWN, false),
            (false, Some(MouseButton::Right))
        );
        assert_eq!(
            logical_buttons(RI_MOUSE_LEFT_BUTTON_UP, false),
            (true, None)
        );
        assert_eq!(
            logical_buttons(RI_MOUSE_RIGHT_BUTTON_UP, false),
            (false, None)
        );
        // Swapped: the right button is the primary one, a left click to every app; the left
        // shows the context menu.
        assert_eq!(
            logical_buttons(RI_MOUSE_RIGHT_BUTTON_DOWN, true),
            (false, Some(MouseButton::Left))
        );
        assert_eq!(
            logical_buttons(RI_MOUSE_LEFT_BUTTON_DOWN, true),
            (false, Some(MouseButton::Right))
        );
        assert_eq!(
            logical_buttons(RI_MOUSE_RIGHT_BUTTON_UP, true),
            (true, None)
        );
        assert_eq!(
            logical_buttons(RI_MOUSE_LEFT_BUTTON_UP, true),
            (false, None)
        );
        // The middle button is where it is either way.
        for swapped in [false, true] {
            assert_eq!(
                logical_buttons(RI_MOUSE_MIDDLE_BUTTON_DOWN, swapped),
                (false, Some(MouseButton::Middle))
            );
        }
    }

    #[test]
    fn keys_typed_after_a_press_are_told_until_a_key_could_move_focus() {
        // A click, then keys that type: they may be in the field the click focused before its
        // focus news is read (#97). Tab, Enter, Escape, a navigation, editing or function key, or
        // a key with Ctrl, Alt or the Windows key held may have moved focus on: the press is then
        // not where focus came from (#97 second review).
        let shared = InputShared::new(2);
        let press = |tick| press_button(&shared, tick, MouseButton::Left);
        assert_eq!(shared.typed_after_press(), None);
        press(100);
        shared.record_key(key(102, 0x10, false));
        assert_eq!(shared.typed_after_press(), None, "Shift types nothing");
        for (tick, vkey, up) in [(105, 0x48, false), (107, 0x48, true), (108, 0x10, true)] {
            shared.record_key(key(tick, vkey, up));
        }
        assert_eq!(shared.typed_after_press(), Some((100, (40, 50))));
        shared.record_key(key(115, 0x09, false));
        assert_eq!(shared.typed_after_press(), None, "Tab");
        shared.record_key(key(125, 0x49, false));
        assert_eq!(shared.typed_after_press(), None, "keys after Tab");
        // Enter, Escape, the arrows, Home, End, Page Down, Backspace, Delete, F6 and the
        // context-menu key: none types text, and any may move focus or change the field.
        for vkey in [
            0x0D, 0x1B, 0x25, 0x28, 0x24, 0x23, 0x22, 0x08, 0x2E, 0x75, 0x5D,
        ] {
            press(130);
            shared.record_key(key(131, vkey, false));
            shared.record_key(key(132, 0x41, false));
            assert_eq!(shared.typed_after_press(), None, "{vkey:#x}");
        }
        // Nor do they count as typing on their own.
        press(135);
        shared.record_key(key(136, 0x24, false));
        assert_eq!(shared.typed_after_press(), None, "Home alone");
        // Caps Lock and Num Lock type nothing and move nothing: the keys after them still count.
        press(138);
        for vkey in [0x14, 0x90] {
            shared.record_key(key(139, vkey, false));
            shared.record_key(key(139, vkey, true));
        }
        assert_eq!(shared.typed_after_press(), None, "a lock key types nothing");
        shared.record_key(key(140, 0x31, false));
        assert_eq!(
            shared.typed_after_press(),
            Some((138, (40, 50))),
            "Caps Lock, then 1"
        );
        // Punctuation, the number pad and space type.
        for vkey in [0xBE, 0x61, 0x20] {
            press(141);
            shared.record_key(key(142, vkey, false));
            assert_eq!(
                shared.typed_after_press(),
                Some((141, (40, 50))),
                "{vkey:#x}"
            );
        }
        press(140);
        shared.record_key(key(141, 0x11, false));
        shared.record_key(key(142, 0x46, false));
        shared.record_key(key(143, 0x11, true));
        shared.record_key(key(144, 0x41, false));
        assert_eq!(shared.typed_after_press(), None, "Ctrl+F");
        press(150);
        shared.record_key(key(151, 0x41, false));
        assert_eq!(
            shared.typed_after_press(),
            Some((150, (40, 50))),
            "Ctrl let go"
        );
        // Keys aren't read while recording is off.
        press(190);
        shared.enabled.store(false, Ordering::Relaxed);
        shared.record_key(key(191, 0x41, false));
        assert_eq!(shared.typed_after_press(), None);
    }

    #[test]
    fn altgr_types_and_a_right_click_ends_what_a_press_says() {
        let shared = InputShared::new(2);
        let press = |tick| press_button(&shared, tick, MouseButton::Left);
        // AltGr+E types "€" on a European layout: Windows sends the left Ctrl, then the right Alt
        // (VK_MENU with E0 from Raw Input, VK_RMENU from the hook).
        for right_alt in [
            KeyEvent {
                extended: true,
                ..key(161, 0x12, false)
            },
            key(161, 0xA5, false),
        ] {
            press(160);
            shared.record_key(key(161, 0x11, false));
            shared.record_key(right_alt);
            shared.record_key(key(162, 0x45, false));
            assert_eq!(
                shared.typed_after_press(),
                Some((160, (40, 50))),
                "AltGr+E, the right Alt as {:#x}",
                right_alt.vkey
            );
            shared.record_key(KeyEvent {
                up: true,
                ..right_alt
            });
            shared.record_key(key(163, 0x11, true));
        }
        // The left Alt with a letter is a menu's access key, and the right Alt alone (a US
        // layout's) is the same.
        for alt in [
            key(171, 0x12, false),
            key(171, 0xA4, false),
            key(171, 0xA5, false),
        ] {
            press(170);
            shared.record_key(alt);
            shared.record_key(key(172, 0x46, false));
            shared.record_key(KeyEvent { up: true, ..alt });
            shared.record_key(key(173, 0x41, false));
            assert_eq!(shared.typed_after_press(), None, "Alt as {:#x}", alt.vkey);
        }
        // A right click's menu takes the keys typed after it (its access keys): it's never where
        // focus came from, and it ends what the left press before it said.
        press(180);
        shared.record_key(key(181, 0x41, false));
        press_button(&shared, 182, MouseButton::Right);
        assert_eq!(shared.typed_after_press(), None, "a right click");
        shared.record_key(key(183, 0x50, false));
        assert_eq!(shared.typed_after_press(), None, "P, after a right click");
    }

    #[test]
    fn raw_keyboard_input_keeps_no_packets_character() {
        // Raw Input's packet carries its character in place of a scan code; it's dropped here, on
        // the input thread. An injected key with no virtual key at all is taken as a packet too.
        let raw = |vkey, make_code, injected| raw_key(vkey, make_code, 0, injected, 5, 1);
        let packet = raw(VK_PACKET, u16::from(b'x'), true).expect("a packet");
        assert_eq!((packet.vkey, packet.scan), (VK_PACKET, 0));
        let unnamed = raw(0, 0xD83D, true).expect("an injected key with no virtual key");
        assert_eq!((unnamed.vkey, unnamed.scan), (VK_PACKET, 0));
        assert_eq!(raw(0, 0x1E, false), None, "a real key with no virtual key");
        assert_eq!(raw(VK_FAKE, 0x1D, false), None);
        let a = raw(0x41, 0x1E, false).expect("a key");
        assert_eq!(
            (a.vkey, a.scan, a.up, a.extended),
            (0x41, 0x1E, false, false)
        );
        let up = raw_key(0x25, 0x4B, RI_KEY_BREAK | RI_KEY_E0, false, 5, 1).expect("Left, up");
        assert!(up.up && up.extended);
    }

    #[test]
    fn message_positions_unpack_signed() {
        assert_eq!(unpack_message_pos(0x0064_00C8), (200, 100));
        // x = -1280 (0xFB00), y = -200 (0xFF38): a monitor left of and above the primary.
        assert_eq!(unpack_message_pos(0xFF38_FB00), (-1280, -200));
    }

    #[test]
    fn what_was_under_each_press_is_kept_until_its_click_is_handled() {
        let shared = InputShared::new(QUEUE_CAPACITY);
        shared.enabled.store(true, Ordering::Relaxed);
        for _ in 0..(PRESSES_KEPT + 4) {
            shared.record_down(0, 1, 1, MouseButton::Left, false);
        }
        // Only the latest are kept: more than can be waiting to be handled.
        assert!(shared.take_press(1).is_none());
        let last = u64::try_from(PRESSES_KEPT + 4).unwrap();
        assert!(shared.take_press(last).is_some());
        // Taken once.
        assert!(shared.take_press(last).is_none());
        shared.clear();
        assert!(shared.take_press(last - 1).is_none());
    }

    #[test]
    fn nothing_is_queued_while_disabled() {
        let shared = InputShared::new(4);
        shared.record_down(0, 1, 1, MouseButton::Left, false);
        assert_eq!(shared.queued(), 0);
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 0);
    }

    /// A recording's input thread, taking clicks.
    fn recording() -> InputShared {
        let shared = InputShared::new(8);
        shared.enabled.store(true, Ordering::Relaxed);
        shared
    }

    /// Presses the left button at `tick`, returning the press's id.
    fn press(shared: &InputShared, tick: u32, x: i32, y: i32) -> u64 {
        shared.record_down(tick, x, y, MouseButton::Left, false);
        let mut last = 0;
        while let Some(event) = shared.pop() {
            last = event.id;
        }
        last
    }

    #[test]
    fn a_release_pairs_with_the_press_just_before_it_even_in_the_same_tick() {
        // A touchpad tap or an automated click goes down and up within one tick of the message
        // clock (about 15.6 ms), so both carry the same time: still that press's release (#64).
        let shared = recording();
        let click = press(&shared, 5_000, 166, 388);
        assert_eq!(shared.left_release(click), LeftRelease::Down);
        // A right-click meanwhile doesn't come between a left press and its release.
        shared.record_down(5_000, 300, 300, MouseButton::Right, false);
        shared.record_left_up(5_000, 167, 388);
        assert_eq!(shared.left_release(click), LeftRelease::Up(5_000, 167, 388));
    }

    #[test]
    fn a_release_after_another_press_is_never_an_earlier_presss() {
        // The test of 10/10/2026: a click on D2 whose release went unseen, then a double-click on
        // D2's fill handle, whose first release ended D2's "drag": Select "D2:E2".
        let shared = recording();
        let click = press(&shared, 1_000, 334, 386);
        let handle = press(&shared, 2_000, 369, 396);
        shared.record_left_up(2_000, 369, 396);
        assert_eq!(shared.left_release(click), LeftRelease::Missed);
        assert_eq!(
            shared.left_release(handle),
            LeftRelease::Up(2_000, 369, 396)
        );
        // The double-click's second press: the first press keeps its own release.
        let second = press(&shared, 2_100, 369, 396);
        shared.record_left_up(2_100, 369, 396);
        assert_eq!(
            shared.left_release(handle),
            LeftRelease::Up(2_000, 369, 396)
        );
        assert_eq!(
            shared.left_release(second),
            LeftRelease::Up(2_100, 369, 396)
        );
    }

    #[test]
    fn a_press_that_isnt_recorded_still_comes_between() {
        // Pressed again while paused: the release that follows is that press's, not the first's.
        let shared = recording();
        let click = press(&shared, 1_000, 10, 10);
        shared.enabled.store(false, Ordering::Relaxed);
        shared.record_down(1_100, 50, 50, MouseButton::Left, false);
        shared.enabled.store(true, Ordering::Relaxed);
        shared.record_left_up(1_150, 50, 50);
        assert_eq!(shared.left_release(click), LeftRelease::Missed);
        // A new recording starts with none.
        let next = press(&shared, 2_000, 10, 10);
        shared.record_left_up(2_010, 10, 10);
        shared.clear();
        assert_eq!(shared.left_release(next), LeftRelease::Missed);
    }

    #[test]
    fn foreground_queue_keeps_the_latest() {
        let shared = InputShared::new(4);
        for hwnd in 0..40 {
            shared.record_foreground(ForegroundChange { hwnd, tick_ms: 0 });
        }
        let mut last = None;
        while let Some(change) = shared.pop_foreground() {
            last = Some(change.hwnd);
        }
        assert_eq!(last, Some(39));
    }

    /// Starts the real input thread (one per process, so everything is in one test): Raw Input
    /// is registered to our window, switching to the hook removes it, a foreign registration
    /// (as Tauri's would be) is detected, and re-registering takes it back.
    #[test]
    fn registrations_follow_the_source_and_foreign_takeovers_are_detected() {
        let input = InputCapture::start(InputSource::RawInput).expect("input thread starts");
        let state = registration();
        assert!(state.mouse, "{state:?}");
        assert!(state.digitizers, "{state:?}");

        input.set_source(InputSource::Hook).expect("hook installs");
        assert_eq!(input.source(), InputSource::Hook);
        assert!(!registration().mouse);

        input
            .set_source(InputSource::RawInput)
            .expect("raw input again");
        assert!(registration().mouse);

        // Another part of the process registers the mouse to its own window.
        let other = create_raw_input_window().expect("second window");
        register(&[device(PAGE_GENERIC, USAGE_MOUSE, other)]).expect("foreign registration");
        assert!(!registration().mouse, "the takeover is visible");

        input.reregister().expect("re-register");
        assert!(registration().mouse, "ours again");
        // SAFETY: destroys the window created above on this thread.
        let _ = unsafe { DestroyWindow(other) };

        assert!(
            !registration().keyboard,
            "the keyboard is never registered by default"
        );
        input.set_keyboard(true).expect("keyboard registers");
        assert!(registration().keyboard);
        input.reregister().expect("re-register keeps the keyboard");
        assert!(registration().keyboard);
        input.set_keyboard(false).expect("keyboard removed");
        assert!(!registration().keyboard);
        input.set_keyboard(true).expect("keyboard registers again");

        input.stop();
        assert_eq!(registration(), Registration::default());
    }
}
