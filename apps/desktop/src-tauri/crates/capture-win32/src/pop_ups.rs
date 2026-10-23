//! XAML's pop-up hosts as they show (docs/spec/02-capture.md#on-each-click, #106). XAML draws a
//! menu or flyout that may run past its app's window in a top-level window of its own: `WinUI` 3's
//! (Windows App SDK, `Microsoft.UI.Content.PopupWindowSiteBridge`, titled `PopupHost` in Windows'
//! language: en-GB's `Pop-upHost`), as Paint's File menu is, and the system XAML's
//! (`Xaml_WindowedPopupClass`). UI Automation's menu-opened event didn't name Paint's menu's items
//! (12/10/2026); Windows itself says when any window shows, so the recorder looks for a menu in
//! the host then.
//!
//! An out-of-context `WinEvent` hook on a thread of its own, with its own message loop: Windows
//! calls back on that thread, loads nothing into other programs, and leaves out this process's
//! own windows. The callback only names the window's class and passes the handle on.

use std::cell::RefCell;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EVENT_OBJECT_SHOW, EVENT_OBJECT_UNCLOAKED, GA_ROOT, GetAncestor, GetMessageW,
    MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_QUIT,
};

use crate::{Error, Result};

/// The classes of the windows XAML draws a pop-up in: `WinUI` 3's and the system XAML's.
pub const POP_UP_HOST_CLASSES: [&str; 2] = [
    "Microsoft.UI.Content.PopupWindowSiteBridge",
    "Xaml_WindowedPopupClass",
];

/// Whether a window class is one XAML draws a pop-up in.
#[must_use]
pub fn is_pop_up_host_class(class: &str) -> bool {
    POP_UP_HOST_CLASSES.contains(&class)
}

/// A pop-up host that showed (or was uncloaked): its window, and when, on the input clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PopUpShown {
    pub hwnd: isize,
    pub at: u32,
}

/// How long the watch's thread has to start.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Watches for XAML's pop-up hosts showing, until dropped.
pub struct PopUpHosts {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl PopUpHosts {
    /// Starts telling `shown` each time a pop-up host of another program shows.
    ///
    /// # Errors
    /// If the thread can't start or Windows refuses both hooks.
    pub fn watch(shown: Sender<PopUpShown>) -> Result<Self> {
        Self::watch_with(shown, true)
    }

    /// As [`Self::watch`], with this process's own windows told too when `skip_own` is off (its
    /// tests show a window of their own).
    fn watch_with(shown: Sender<PopUpShown>, skip_own: bool) -> Result<Self> {
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("amluto-pop-ups".into())
            .spawn(move || run(shown, skip_own, &ready_tx))
            .map_err(|_| Error::WatchNotStarted)?;
        match ready_rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                thread: Some(thread),
            }),
            _ => Err(Error::WatchNotStarted),
        }
    }
}

impl Drop for PopUpHosts {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            // SAFETY: posts WM_QUIT to the watch's own thread's queue; no pointers involved.
            let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = thread.join();
        }
    }
}

thread_local! {
    /// Where the hook's callback, on the watch's thread, passes what showed.
    static SHOWN: RefCell<Option<Sender<PopUpShown>>> = const { RefCell::new(None) };
}

fn run(shown: Sender<PopUpShown>, skip_own: bool, ready: &Sender<std::result::Result<u32, ()>>) {
    SHOWN.with(|slot| *slot.borrow_mut() = Some(shown));
    let mut message = MSG::default();
    // SAFETY: makes sure this thread has a message queue before its id is handed out, so WM_QUIT
    // can always be posted to it; `message` is a MSG owned by this frame.
    let _ = unsafe { PeekMessageW(&raw mut message, None, 0, 0, PM_NOREMOVE) };
    let flags = if skip_own {
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
    } else {
        WINEVENT_OUTOFCONTEXT
    };
    let hooks: Vec<HWINEVENTHOOK> = [EVENT_OBJECT_SHOW, EVENT_OBJECT_UNCLOAKED]
        .into_iter()
        .map(|event| {
            // SAFETY: an out-of-context hook for one event: Windows calls `shown_proc` on this
            // thread through its message loop below, and loads nothing into other processes. The
            // procedure catches its own panics and lives for the whole program; the hook is
            // removed on this thread before it ends.
            unsafe { SetWinEventHook(event, event, None, Some(shown_proc), 0, 0, flags) }
        })
        .filter(|hook| !hook.is_invalid())
        .collect();
    if hooks.is_empty() {
        let _ = ready.send(Err(()));
        return;
    }
    // SAFETY: no arguments; returns this thread's id.
    let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));
    loop {
        // SAFETY: `message` is a MSG owned by this frame; a null window means any message for
        // this thread, WM_QUIT included.
        let result = unsafe { GetMessageW(&raw mut message, None, 0, 0) };
        if result.0 <= 0 {
            break;
        }
        // SAFETY: dispatches a message just received on this thread.
        unsafe { DispatchMessageW(&raw const message) };
    }
    for hook in hooks {
        // SAFETY: removes a hook this thread set, once.
        let _ = unsafe { UnhookWinEvent(hook) };
    }
}

unsafe extern "system" fn shown_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    window: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    time: u32,
) {
    // OBJID_WINDOW and CHILDID_SELF are 0: the event is about the window itself, not a part of it
    // (the caret, the cursor).
    if object != 0 || child != 0 || window.is_invalid() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: GetAncestor tolerates stale handles by returning null.
        let top_level = unsafe { GetAncestor(window, GA_ROOT) } == window;
        if top_level
            && crate::window::window_class(window.0 as isize)
                .is_some_and(|class| is_pop_up_host_class(&class))
        {
            SHOWN.with(|slot| {
                if let Some(shown) = slot.borrow().as_ref() {
                    let _ = shown.send(PopUpShown {
                        hwnd: window.0 as isize,
                        at: time,
                    });
                }
            });
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, SW_SHOWNOACTIVATE,
        ShowWindow, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    use windows::core::{PCWSTR, w};

    #[test]
    fn only_xamls_pop_up_hosts_are_watched() {
        assert!(is_pop_up_host_class(
            "Microsoft.UI.Content.PopupWindowSiteBridge"
        ));
        assert!(is_pop_up_host_class("Xaml_WindowedPopupClass"));
        // Windows' own menus raise UI Automation's menu-opened event, as Office's do (#56).
        assert!(!is_pop_up_host_class("#32768"));
        assert!(!is_pop_up_host_class("Windows.UI.Core.CoreWindow"));
        assert!(!is_pop_up_host_class("Chrome_WidgetWin_2"));
    }

    unsafe extern "system" fn plain_window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        // SAFETY: default handling, with the unchanged arguments.
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }

    /// A pop-up window of `class`, shown far off every screen without taking the focus, so the
    /// test shows nothing anyone sees.
    fn shown_off_screen(class: PCWSTR) -> HWND {
        // SAFETY: this module's own handle.
        let instance = unsafe { GetModuleHandleW(None) }.expect("module handle");
        let registered = WNDCLASSEXW {
            cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap(),
            lpfnWndProc: Some(plain_window_proc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..WNDCLASSEXW::default()
        };
        // SAFETY: a fully initialised class with a static name; registering it twice fails
        // harmlessly.
        unsafe { RegisterClassExW(&raw const registered) };
        // SAFETY: a pop-up window of the class above, off every screen, owned by this thread.
        let window = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class,
                w!("PopupHost"),
                WS_POPUP,
                -32_000,
                -32_000,
                120,
                80,
                None,
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("window");
        // SAFETY: shows the window this thread just created, without activating it.
        let _ = unsafe { ShowWindow(window, SW_SHOWNOACTIVATE) };
        window
    }

    #[test]
    fn a_pop_up_host_showing_is_told_and_other_windows_are_not() {
        let (shown_tx, shown_rx) = mpsc::channel();
        let watch = PopUpHosts::watch_with(shown_tx, false).expect("watching");
        let other = shown_off_screen(w!("AmlutoStepsNotAPopUpHost"));
        let host = shown_off_screen(w!("Xaml_WindowedPopupClass"));
        let told = shown_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("the host's showing told");
        assert_eq!(told.hwnd, host.0 as isize);
        assert_ne!(told.hwnd, other.0 as isize);
        drop(watch);
        // SAFETY: destroys the windows this thread created above.
        let _ = unsafe { DestroyWindow(host) };
        // SAFETY: as above.
        let _ = unsafe { DestroyWindow(other) };
    }
}
