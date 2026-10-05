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
//!   off this thread.
//!
//! The callbacks copy the event into a bounded lock-free queue, bump a counter and return. No
//! UIA, file access, logging or screenshots happen here, because Windows silently removes a
//! low-level hook that exceeds `LowLevelHooksTimeout`. Every callback catches panics.
//!
//! **Raw Input is one registration per device type per process.** Anything else in the process
//! that registers the mouse (Tauri's windowing library does by default) replaces ours without
//! telling us, so [`registration`] lets the recorder check it is still ours.
//!
//! Loss is never silent: a full queue increments `dropped`, and every mouse movement increments
//! `moves`, so the recorder can notice movement with no events (Degraded).

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
    HC_ACTION, HHOOK, HWND_MESSAGE, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, PostThreadMessageW,
    RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_LEFT_BUTTON_UP, RI_MOUSE_MIDDLE_BUTTON_DOWN,
    RI_MOUSE_RIGHT_BUTTON_DOWN, RegisterClassExW, SetWindowsHookExW, UnhookWindowsHookEx,
    WH_MOUSE_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    WM_APP, WM_INPUT, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MOUSEMOVE, WM_QUIT,
    WM_RBUTTONDOWN, WNDCLASSEXW,
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
    /// The windows showing, front to back, as each recent click went down, by click id. By the
    /// time the click is handled the window clicked has come to the front, but the screenshot
    /// can still show what lay over it: those windows are greyed out by this (F014).
    stacks: Mutex<VecDeque<(u64, Vec<crate::window::ShownWindow>)>>,
    /// The left button's latest release (time, position), for telling a drag from a click: a
    /// selection of cells dragged in Excel (04/10/2026).
    left_up: Mutex<Option<(u32, i32, i32)>>,
}

/// How many clicks' window stacks are kept: more than can be waiting to be handled.
const STACKS_KEPT: usize = 16;

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
            stacks: Mutex::new(VecDeque::new()),
            left_up: Mutex::new(None),
        }
    }

    /// The left button's latest release while recording: time, and where.
    #[must_use]
    pub fn last_left_up(&self) -> Option<(u32, i32, i32)> {
        *self.left_up.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn record_left_up(&self, tick_ms: u32, x: i32, y: i32) {
        if self.enabled.load(Ordering::Relaxed) {
            *self.left_up.lock().unwrap_or_else(PoisonError::into_inner) = Some((tick_ms, x, y));
        }
    }

    /// The windows that were showing, front to back, when click `id` went down.
    #[must_use]
    pub fn take_stack(&self, id: u64) -> Option<Vec<crate::window::ShownWindow>> {
        let mut stacks = self.stacks.lock().unwrap_or_else(PoisonError::into_inner);
        let at = stacks.iter().position(|(click, _)| *click == id)?;
        stacks.remove(at).map(|(_, stack)| stack)
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
        self.stacks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
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
        // Read now, before the window clicked comes to the front. A millisecond or two.
        let stack = crate::window::shown_windows();
        {
            let mut stacks = self.stacks.lock().unwrap_or_else(PoisonError::into_inner);
            if stacks.len() >= STACKS_KEPT {
                stacks.pop_front();
            }
            stacks.push_back((event.id, stack));
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

fn read_raw_keyboard(raw: &RAWINPUT, tick: u32) {
    // SAFETY: the caller checked dwType is RIM_TYPEKEYBOARD, so `keyboard` is the active member.
    let keyboard = unsafe { raw.data.keyboard };
    if keyboard.VKey == VK_FAKE || keyboard.VKey == 0 {
        return;
    }
    // SAFETY: no arguments; the window in front now, which is where this key is going.
    let foreground = unsafe { GetForegroundWindow() };
    shared().record_key(KeyEvent {
        tick_ms: tick,
        vkey: keyboard.VKey,
        scan: keyboard.MakeCode,
        extended: keyboard.Flags & RI_KEY_E0 != 0,
        up: keyboard.Flags & RI_KEY_BREAK != 0,
        injected: raw.header.hDevice.is_invalid(),
        foreground: foreground.0 as isize,
    });
}

fn read_raw_mouse(raw: &RAWINPUT, tick: u32) {
    // SAFETY: the caller checked dwType is RIM_TYPEMOUSE, so `mouse` is the active member.
    let mouse = unsafe { raw.data.mouse };
    // SAFETY: RAWMOUSE's button fields are a plain-integer union; reading the struct view is always valid.
    let flags = u32::from(unsafe { mouse.Anonymous.Anonymous.usButtonFlags });
    let shared = shared();

    if mouse.lLastX != 0 || mouse.lLastY != 0 {
        shared.record_move();
    }
    if flags & RI_MOUSE_LEFT_BUTTON_UP != 0 {
        // SAFETY: no arguments; describes the message currently being processed.
        let (x, y) = unpack_message_pos(unsafe { GetMessagePos() });
        shared.record_left_up(tick, x, y);
    }
    let button = if flags & RI_MOUSE_LEFT_BUTTON_DOWN != 0 {
        Some(MouseButton::Left)
    } else if flags & RI_MOUSE_RIGHT_BUTTON_DOWN != 0 {
        Some(MouseButton::Right)
    } else if flags & RI_MOUSE_MIDDLE_BUTTON_DOWN != 0 {
        Some(MouseButton::Middle)
    } else {
        None
    };
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
    fn message_positions_unpack_signed() {
        assert_eq!(unpack_message_pos(0x0064_00C8), (200, 100));
        // x = -1280 (0xFB00), y = -200 (0xFF38): a monitor left of and above the primary.
        assert_eq!(unpack_message_pos(0xFF38_FB00), (-1280, -200));
    }

    #[test]
    fn nothing_is_queued_while_disabled() {
        let shared = InputShared::new(4);
        shared.record_down(0, 1, 1, MouseButton::Left, false);
        assert_eq!(shared.queued(), 0);
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 0);
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
