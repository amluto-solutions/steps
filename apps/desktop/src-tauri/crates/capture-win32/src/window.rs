//! Which top-level window and process is under a point or in front, the window a pop-up came from
//! (its owner, or for Windows' own menus what their thread says), and whether it runs elevated.
//! From a normal process, an elevated window reads as `Elevated`: the token query needs only
//! limited rights (checked in Phase 1 with Task Manager). The window under a point is the one a
//! click there goes to: a tooltip's window over it is looked through (`tooltip.rs`, #105).

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::HiDpi::PhysicalToLogicalPointForPerMonitorDPI;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, FindWindowExW, GA_PARENT, GA_ROOT, GA_ROOTOWNER, GW_OWNER,
    GWL_EXSTYLE, GWL_STYLE, GetAncestor, GetForegroundWindow, GetWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, HTCLOSE, HTMAXBUTTON, HTMINBUTTON,
    HTTRANSPARENT, IsIconic, IsWindowVisible, IsZoomed, SMTO_ABORTIFHUNG, SMTO_ERRORONEXIT,
    SendMessageTimeoutW, WM_NCHITTEST, WS_CAPTION, WS_EX_APPWINDOW, WS_EX_LAYERED,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WindowFromPoint,
};
use windows::core::{BOOL, PWSTR};

use crate::Rect;

/// Whether a process runs elevated (as administrator).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Elevation {
    NotElevated,
    Elevated,
    /// The token couldn't be read; from a normal process this usually means the target is elevated.
    Unknown,
}

/// The top-level window under a point.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    /// Window handle as an integer, for logging and matching only.
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    /// Full path of the process image, when it can be read.
    pub exe_path: Option<String>,
    /// Visible frame in physical pixels (DWM extended frame bounds: no invisible resize borders).
    pub frame: Rect,
    pub elevation: Elevation,
    /// For a frame Windows draws round another program's window (an `ApplicationFrameWindow`,
    /// whoever draws it), the file name of the program it shows: a store app's
    /// (`CalculatorApp.exe`), or the text input host's (`TextInputHost.exe`), whose input panels
    /// (the emoji panel, clipboard history) Windows 11 shows in a frame of `explorer.exe`'s
    /// (build 26300, 12/10/2026; #109). `None` for any other window, or when it can't be told.
    pub hosted_exe: Option<String>,
    /// Its window class (`CabinetWClass` for a File Explorer window, `Shell_TrayWnd` for the
    /// taskbar), read with the rest: a window read as the mouse button went down is still known
    /// for what it was once the click has closed it (#98). `None` when it couldn't be read.
    pub class: Option<String>,
}

impl WindowInfo {
    /// File name of the process image, e.g. `chrome.exe`.
    #[must_use]
    pub fn exe_name(&self) -> Option<&str> {
        self.exe_path
            .as_deref()
            .and_then(|path| path.rsplit(['\\', '/']).next())
    }
}

/// This process's id, for ignoring clicks on the recorder's own windows.
#[must_use]
pub fn own_process_id() -> u32 {
    // SAFETY: no arguments, cannot fail.
    unsafe { GetCurrentProcessId() }
}

/// The top-level window a click at a physical point goes to, a tooltip over it looked through
/// ([`clicked_at`]), or `None` over the desktop background with no window.
#[must_use]
pub fn root_window_at(x: i32, y: i32) -> Option<WindowInfo> {
    clicked_at(x, y).map(|at| info_for(at.root))
}

/// The windows a click at a physical point lands in.
struct ClickedAt {
    /// The deepest window there, which Windows asks what part of it is there.
    child: HWND,
    /// Its top-level window: the window clicked.
    root: HWND,
    /// The tooltip's window over it that was looked through, if any.
    tooltip: Option<HWND>,
}

/// The windows a click at a physical point lands in, as Windows finds them (`WindowFromPoint`),
/// except that a tooltip's window there is looked through to the window under it (#105): the
/// click goes to the control the tooltip describes, and the tooltip closes with it
/// ([`crate::tooltip`]). `None` over no window at all.
fn clicked_at(x: i32, y: i32) -> Option<ClickedAt> {
    // SAFETY: POINT by value; returns a null handle when there is no window.
    let child = unsafe { WindowFromPoint(POINT { x, y }) };
    if child.is_invalid() {
        return None;
    }
    let top = root_of(child);
    crate::tooltip::TOOLTIP_WINDOWS.forget_hidden(is_shown);
    let root = crate::tooltip::clicked_through(top, x, y, is_shown);
    Some(if root == top {
        ClickedAt {
            child,
            root,
            tooltip: None,
        }
    } else {
        ClickedAt {
            child: crate::tooltip::child_at(root, x, y),
            root,
            tooltip: Some(top),
        }
    })
}

/// Whether a tooltip's window lies over a physical point, which a click there would go through
/// ([`root_window_at`]). What UI Automation finds there is the tooltip's, not the control's under
/// it, so the resting pointer isn't read then (#105).
#[must_use]
pub fn tooltip_at(x: i32, y: i32) -> bool {
    clicked_at(x, y).is_some_and(|at| at.tooltip.is_some())
}

/// UI Automation said a tooltip of program `pid` opened, its middle at a physical point: the
/// top-level window there is noted as the tooltip's when it can be (an owned pop-up of that
/// program), and looked through while it shows (#105). XAML draws its tooltips in pop-up
/// windows as it draws its menus, so only UI Automation tells them apart. Whether it was noted.
pub fn tooltip_opened(x: i32, y: i32, pid: u32) -> bool {
    // SAFETY: POINT by value; returns a null handle when there is no window.
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    !hwnd.is_invalid() && crate::tooltip::TOOLTIP_WINDOWS.tooltip_opened(root_of(hwnd), pid)
}

/// UI Automation said a menu opened, its middle at a physical point: the top-level window there
/// is a menu's, never looked through, whatever it showed before (#105).
pub fn menu_opened_at(x: i32, y: i32) {
    // SAFETY: POINT by value; returns a null handle when there is no window.
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if !hwnd.is_invalid() {
        crate::tooltip::TOOLTIP_WINDOWS.menu_opened(root_of(hwnd));
    }
}

/// A menu was found in window `hwnd` (a XAML pop-up host that showed, #106): its top-level window
/// is a menu's, never looked through, whatever it showed before (#105).
pub fn menu_opened_in(hwnd: isize) {
    let window = HWND(hwnd as *mut c_void);
    if !window.is_invalid() {
        crate::tooltip::TOOLTIP_WINDOWS.menu_opened(root_of(window));
    }
}

/// A window's own title-bar button: the Close, Minimise and Maximise buttons at its top right.
/// On a maximised window, Maximise puts it back: Restore.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleBarButton {
    Close,
    Minimise,
    Maximise,
    Restore,
}

/// What was under the pointer as a button went down, read before the app could react to it
/// (docs/spec/02-capture.md#on-each-click): a click on a window's Close button can close it before
/// the click is handled, and then the point shows the window behind (#48).
#[derive(Debug, Clone, PartialEq)]
pub struct Pressed {
    /// The top-level window under the pointer.
    pub window: WindowInfo,
    /// The window's own title-bar button under the pointer, when its hit test said so.
    pub title_bar_button: Option<TitleBarButton>,
    /// For a press in a pop-up (a menu, a drop-down list), the window it came from
    /// ([`pop_up_owner`]), which window mode's screenshot shows round it (#72). Read now: the
    /// pop-up closes with the click.
    pub owner: Option<WindowInfo>,
    /// The processes of the windows up the window's owners ([`owner_processes`]), showing or
    /// not: a pop-up an excluded app's window owns is that app's, whoever draws it (#103).
    pub owners: Vec<u32>,
}

/// The top-level window a click at a physical point goes to (a tooltip over it looked through,
/// [`clicked_at`]) and, with `title_bar` set, the title-bar button there (`WM_NCHITTEST`, as
/// Windows itself asks the window when the button goes down), for a pop-up the window it came
/// from, and the programs up its owners. Steps' own windows aren't asked. `None` over no window
/// at all.
#[must_use]
pub fn pressed_at(x: i32, y: i32, title_bar: bool) -> Option<Pressed> {
    let ClickedAt {
        child,
        root,
        tooltip,
    } = clicked_at(x, y)?;
    let window = info_for(root);
    let own = window.pid == own_process_id();
    let title_bar_button = if title_bar && !own {
        title_bar_button_at(child, root, x, y)
    } else {
        None
    };
    let owner = if own {
        None
    } else {
        pop_up_owner(root, shown_with_area).map(info_for)
    };
    Some(Pressed {
        window,
        title_bar_button,
        owner,
        owners: owners_of(root, tooltip),
    })
}

/// The processes of the windows up `window`'s owners ([`owner_processes`]) and, when a tooltip's
/// window over it was looked through, the tooltip's own and its owners': a click through an
/// excluded app's tooltip, or one of Steps', is kept out as a click on it was (#103, #105).
fn owners_of(window: HWND, tooltip: Option<HWND>) -> Vec<u32> {
    let mut processes = owner_processes(window);
    if let Some(tooltip) = tooltip {
        for pid in std::iter::once(process_of(tooltip)).chain(owner_processes(tooltip)) {
            if pid != 0 && !processes.contains(&pid) {
                processes.push(pid);
            }
        }
    }
    processes
}

/// How many owners up the window a pop-up came from is looked for: a submenu's menu's window.
const OWNER_DEPTH: usize = 8;

/// The window a pop-up came from (docs/spec/02-capture.md#on-each-click, #72). A pop-up is a
/// top-level window without a title bar (a menu, a drop-down list); it belongs to the window that
/// owns it, or, when that's a pop-up too (a submenu's menu), to the first window up its owners
/// that isn't one, or that nothing owns. Windows' own menus (`#32768`) and a combo box's list
/// (`ComboLBox`) that nothing owns belong to the window their thread names ([`told_by_thread`]).
/// `None` for a window with a title bar (a dialog is a screenshot of its own), a pop-up nothing
/// owns, or one whose window isn't `shown` (a tray icon's menu belongs to a hidden window).
fn pop_up_owner(window: HWND, shown: impl Fn(HWND) -> bool) -> Option<HWND> {
    if !is_pop_up(window) {
        return None;
    }
    let mut owner = owner_of(window).or_else(|| thread_owner(window))?;
    for _ in 0..OWNER_DEPTH {
        if !is_pop_up(owner) {
            break;
        }
        match owner_of(owner).or_else(|| thread_owner(owner)) {
            Some(next) => owner = next,
            None => break,
        }
    }
    (owner != window && shown(owner)).then_some(owner)
}

/// Whether a top-level window has no title bar of Windows' (a menu, a drop-down list, or an app's
/// window that draws its own) and doesn't ask for a taskbar button of its own (`WS_EX_APPWINDOW`),
/// as a window opened to work in may though another owns it.
pub(crate) fn is_pop_up(window: HWND) -> bool {
    let caption = isize::try_from(WS_CAPTION.0).unwrap_or(isize::MAX);
    let app_window = isize::try_from(WS_EX_APPWINDOW.0).unwrap_or(isize::MAX);
    // SAFETY: reads a style value of a window handle; 0 for a closed window.
    let style = unsafe { GetWindowLongPtrW(window, GWL_STYLE) };
    style & caption != caption && ex_style(window) & app_window == 0
}

/// Whether a window is a top-level pop-up ([`is_pop_up`]): no title bar of Windows' and no
/// taskbar button of its own, as a menu's window is (#106).
#[must_use]
pub fn is_pop_up_window(hwnd: isize) -> bool {
    let window = HWND(hwnd as *mut c_void);
    !window.is_invalid() && root_of(window) == window && is_pop_up(window)
}

/// Whether a window is visible: shown, though perhaps cloaked or not yet given a size. `false` for
/// a hidden window, and one that has closed.
#[must_use]
pub fn is_visible(hwnd: isize) -> bool {
    let window = HWND(hwnd as *mut c_void);
    // SAFETY: takes any handle; false for a closed one.
    !window.is_invalid() && unsafe { IsWindowVisible(window) }.as_bool()
}

/// Whether a window is showing on screen: visible, not minimised or cloaked, and with an area.
#[must_use]
pub fn is_showing(hwnd: isize) -> bool {
    let window = HWND(hwnd as *mut c_void);
    !window.is_invalid() && shown_with_area(window)
}

/// The processes of the windows up a window's owners ([`owner_processes`]), from its top-level
/// window: whose a pop-up is, whoever draws it (#103).
#[must_use]
pub fn owner_processes_of(hwnd: isize) -> Vec<u32> {
    let window = HWND(hwnd as *mut c_void);
    if window.is_invalid() {
        return Vec::new();
    }
    owner_processes(root_of(window))
}

/// The window that owns a top-level window, if any.
pub(crate) fn owner_of(window: HWND) -> Option<HWND> {
    // SAFETY: takes any handle; fails for a closed window or one nothing owns.
    unsafe { GetWindow(window, GW_OWNER) }
        .ok()
        .filter(|owner| !owner.is_invalid())
}

/// What a pop-up's thread says about the window it belongs to, when nothing owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThreadSays {
    /// The window that has the menus showing (`GetGUIThreadInfo`'s menu owner).
    MenuOwner,
    /// The thread's active window, which holds the combo box whose list is open.
    Active,
}

/// Which pop-ups nothing owns are told by their thread, by window class: Windows' own menus
/// (`#32768`) and a combo box's drop-down list (`ComboLBox`), classes of Windows' own.
fn told_by_thread(class: &str) -> Option<ThreadSays> {
    if class == "#32768" {
        Some(ThreadSays::MenuOwner)
    } else if class.eq_ignore_ascii_case("ComboLBox") {
        Some(ThreadSays::Active)
    } else {
        None
    }
}

/// The top-level window a pop-up nothing owns belongs to, as its thread says ([`told_by_thread`]).
fn thread_owner(window: HWND) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{GUITHREADINFO, GetGUIThreadInfo};
    let says = told_by_thread(&class_name(window)?)?;
    // SAFETY: a stale handle gives thread 0, which is checked; no out-pointer is passed.
    let thread = unsafe { GetWindowThreadProcessId(window, None) };
    if thread == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: u32::try_from(std::mem::size_of::<GUITHREADINFO>()).ok()?,
        ..GUITHREADINFO::default()
    };
    // SAFETY: `info` is a GUITHREADINFO owned by this frame with `cbSize` set to its size, as the
    // call requires; it only writes into it.
    unsafe { GetGUIThreadInfo(thread, &raw mut info) }.ok()?;
    let found = match says {
        ThreadSays::MenuOwner => info.hwndMenuOwner,
        ThreadSays::Active => info.hwndActive,
    };
    (!found.is_invalid()).then(|| root_of(found))
}

/// Showing (as [`shown_windows`] counts it) and with an area.
fn shown_with_area(window: HWND) -> bool {
    let frame = frame_bounds(window);
    frame.right > frame.left && frame.bottom > frame.top && is_shown(window)
}

/// How long the hit test may take in all. It runs on the input thread as the button goes down, so
/// it must stay short; a window busy for longer than this simply isn't told.
const HIT_TEST_BUDGET: Duration = Duration::from_millis(30);
/// How many parents a see-through answer (`HTTRANSPARENT`) is passed up through.
const HIT_TEST_DEPTH: usize = 8;

/// The title-bar button under a point: asks the window under it, and while each answers that it's
/// see-through there (`HTTRANSPARENT`, as an app's own title-bar layer may), its parents up to
/// `root`, as Windows does when it routes the click.
fn title_bar_button_at(child: HWND, root: HWND, x: i32, y: i32) -> Option<TitleBarButton> {
    let deadline = Instant::now() + HIT_TEST_BUDGET;
    let mut hwnd = child;
    for _ in 0..HIT_TEST_DEPTH {
        let hit = hit_test(hwnd, x, y, deadline)?;
        if hit != HTTRANSPARENT as isize {
            // SAFETY: reads a window's state; false for a window that has closed.
            let maximised = unsafe { IsZoomed(root) }.as_bool();
            return title_bar_button(hit, maximised);
        }
        if hwnd == root {
            return None;
        }
        // SAFETY: GetAncestor tolerates stale handles by returning null.
        hwnd = unsafe { GetAncestor(hwnd, GA_PARENT) };
        if hwnd.is_invalid() {
            return None;
        }
    }
    None
}

/// The window's own answer to `WM_NCHITTEST` for a physical point, or `None` if it didn't answer
/// by `deadline` (busy, hung or closed).
fn hit_test(hwnd: HWND, x: i32, y: i32, deadline: Instant) -> Option<isize> {
    let left = deadline.checked_duration_since(Instant::now())?;
    let timeout = u32::try_from(left.as_millis()).unwrap_or(u32::MAX).max(1);
    // A window that isn't DPI aware works in scaled points; the recorder's are physical pixels.
    let mut point = POINT { x, y };
    // SAFETY: `point` is a local POINT the call converts in place; it returns false, leaving the
    // point as it was, for a window it can't convert for.
    if !unsafe { PhysicalToLogicalPointForPerMonitorDPI(Some(hwnd), &raw mut point) }.as_bool() {
        point = POINT { x, y };
    }
    let mut hit = 0_usize;
    // SAFETY: WM_NCHITTEST carries only the point, packed into lParam, and its answer is written
    // to a local. The call returns at the timeout, or at once for a hung or closed window, and
    // without SMTO_BLOCK this thread still answers messages sent to it while it waits.
    let sent = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_NCHITTEST,
            WPARAM(0),
            LPARAM(point_lparam(point.x, point.y)),
            SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT,
            timeout,
            Some(&raw mut hit),
        )
    };
    (sent.0 != 0).then(|| hit.cast_signed())
}

/// The title-bar button a hit-test answer names, if any.
fn title_bar_button(hit: isize, maximised: bool) -> Option<TitleBarButton> {
    match u32::try_from(hit).ok()? {
        HTCLOSE => Some(TitleBarButton::Close),
        HTMINBUTTON => Some(TitleBarButton::Minimise),
        HTMAXBUTTON if maximised => Some(TitleBarButton::Restore),
        HTMAXBUTTON => Some(TitleBarButton::Maximise),
        _ => None,
    }
}

/// A screen point as `WM_NCHITTEST` reads it: signed 16-bit x in the low word, y in the high word.
fn point_lparam(x: i32, y: i32) -> isize {
    let low = u32::try_from(x & 0xFFFF).unwrap_or(0);
    let high = u32::try_from(y & 0xFFFF).unwrap_or(0);
    isize::try_from(high << 16 | low).unwrap_or(0)
}

/// The process that owns the window at a point, following owners as well as parents: a popup
/// (a drop-down list, a context menu) is its own top-level window, but belongs to the window that
/// opened it. `None` over the bare desktop.
#[must_use]
pub fn owner_process_at(x: i32, y: i32) -> Option<u32> {
    let hwnd = clicked_at(x, y)?.root;
    // SAFETY: GetAncestor tolerates stale handles by returning null.
    let owner = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    let owner = if owner.is_invalid() { hwnd } else { owner };
    let mut pid = 0u32;
    // SAFETY: out-pointer to a local.
    unsafe { GetWindowThreadProcessId(owner, Some(&raw mut pid)) };
    (pid != 0).then_some(pid)
}

/// The processes of the windows up a top-level window's owners, each once, the nearest first;
/// empty for a window nothing owns (#103). A pop-up (a drop-down list, a context menu) is a
/// top-level window of its own that another program may draw, as a web view draws an app's
/// drop-downs and menus, but it belongs to the window that opened it: an excluded app's pop-up is
/// told by these. Unlike [`pop_up_owner`], every owner counts, whether or not it's showing or a
/// pop-up itself, and the window at the top of them (`GA_ROOTOWNER`) however far up it is.
fn owner_processes(window: HWND) -> Vec<u32> {
    let mut processes = Vec::new();
    let mut add = |hwnd: HWND| {
        let pid = process_of(hwnd);
        if pid != 0 && !processes.contains(&pid) {
            processes.push(pid);
        }
    };
    let mut owner = owner_of(window);
    for _ in 0..OWNER_DEPTH {
        let Some(hwnd) = owner else { break };
        add(hwnd);
        owner = owner_of(hwnd);
    }
    // SAFETY: GetAncestor tolerates stale handles by returning null.
    let root_owner = unsafe { GetAncestor(window, GA_ROOTOWNER) };
    if !root_owner.is_invalid() && root_owner != window {
        add(root_owner);
    }
    processes
}

/// The processes of the windows up the owners of the top-level window a click at a point goes
/// to, as [`owner_processes`] finds them (a pop-up's, the app's whose window it came from), with
/// those of a tooltip's window over it ([`owners_of`]).
#[must_use]
pub fn owner_processes_at(x: i32, y: i32) -> Vec<u32> {
    clicked_at(x, y).map_or_else(Vec::new, |at| owners_of(at.root, at.tooltip))
}

/// The process a window belongs to, or 0 for a window that has closed.
pub(crate) fn process_of(window: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: out-pointer to a local.
    unsafe { GetWindowThreadProcessId(window, Some(&raw mut pid)) };
    pid
}

/// The window in front (the one receiving keyboard input), or `None` while none is, e.g. during
/// a switch.
#[must_use]
pub fn foreground_window() -> Option<WindowInfo> {
    // SAFETY: no arguments; returns a null handle when no window is in front.
    let hwnd = unsafe { GetForegroundWindow() };
    (!hwnd.is_invalid()).then(|| info_for(root_of(hwnd)))
}

/// Facts about the top-level window a handle belongs to, e.g. one from a foreground event.
/// `None` if the handle is null. The handle is taken up to its top-level window first: a web
/// view's child window (`WebView2`'s "Chrome Legacy Window") runs in the web view's own process, so
/// on its own it would name that process instead of the app it is part of.
#[must_use]
pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
    let hwnd = HWND(hwnd as *mut c_void);
    (!hwnd.is_invalid()).then(|| info_for(root_of(hwnd)))
}

fn root_of(hwnd: HWND) -> HWND {
    // SAFETY: GetAncestor tolerates stale handles by returning null.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.is_invalid() { hwnd } else { root }
}

/// Waits up to `timeout` for a process to end: the portable program's old copy, after it has
/// replaced itself. Returns at once if the process has already gone.
pub fn wait_for_exit(pid: u32, timeout: std::time::Duration) {
    use windows::Win32::System::Threading::{PROCESS_SYNCHRONIZE, WaitForSingleObject};
    // SAFETY: opens the process for waiting only; the handle is closed below.
    let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
        return;
    };
    let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
    // SAFETY: `process` is a valid handle with SYNCHRONIZE access, owned here.
    let _ = unsafe { WaitForSingleObject(process, millis) };
    // SAFETY: closes the handle opened above, once.
    let _ = unsafe { CloseHandle(process) };
}

/// File name of a process's program, e.g. `keepass.exe`, or `None` if it can't be read.
#[must_use]
pub fn process_exe_name(pid: u32) -> Option<String> {
    process_path(pid).and_then(|path| path.rsplit(['\\', '/']).next().map(str::to_string))
}

/// A program's own name from its version details (`FileDescription`), such as "Microsoft Edge"
/// for `msedge.exe`: what "Open" steps call it. `None` when the file has no such details.
#[must_use]
pub fn program_description(exe_path: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    use windows::core::PCWSTR;

    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
    let path = wide(exe_path);
    // SAFETY: `path` is NUL-terminated UTF-16 that outlives the call.
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(path.as_ptr()), None) };
    if size == 0 {
        return None;
    }
    let mut block = vec![0u8; usize::try_from(size).ok()?];
    // SAFETY: `block` holds `size` bytes, which is what the call may write.
    unsafe { GetFileVersionInfoW(PCWSTR(path.as_ptr()), None, size, block.as_mut_ptr().cast()) }
        .ok()?;

    // Returns a pointer into `block` and its length in the unit the key uses.
    let query = |key: &str| -> Option<(*const c_void, u32)> {
        let key = wide(key);
        let mut value: *mut c_void = std::ptr::null_mut();
        let mut length = 0u32;
        // SAFETY: `block` is the version resource just read and outlives the returned pointer's
        // use below; `key` is NUL-terminated.
        let found = unsafe {
            VerQueryValueW(
                block.as_ptr().cast(),
                PCWSTR(key.as_ptr()),
                &raw mut value,
                &raw mut length,
            )
        };
        (found.as_bool() && !value.is_null() && length > 0).then_some((value.cast_const(), length))
    };
    // The first language the file lists, then US English as most programs have.
    let mut languages = Vec::new();
    if let Some((table, bytes)) = query(r"\VarFileInfo\Translation")
        && bytes >= 4
    {
        // SAFETY: the translation table holds at least one pair of u16s (4 bytes, checked).
        let pair = unsafe { std::slice::from_raw_parts(table.cast::<u16>(), 2) };
        languages.push(format!("{:04x}{:04x}", pair[0], pair[1]));
    }
    languages.push("040904b0".into());
    languages.into_iter().find_map(|language| {
        let (text, units) = query(&format!(r"\StringFileInfo\{language}\FileDescription"))?;
        // SAFETY: a string value is `units` UTF-16 units (with its NUL) inside `block`.
        let text = unsafe { std::slice::from_raw_parts(text.cast::<u16>(), units as usize) };
        let name = String::from_utf16_lossy(text);
        let name = name.trim_end_matches('\0').trim();
        (!name.is_empty()).then(|| name.to_string())
    })
}

/// The window `ApplicationFrameHost.exe` draws round a store app (Calculator, Settings): the
/// top-level window is the host's, and the app's own window (a core window) sits inside it.
const FRAME_CLASS: &str = "ApplicationFrameWindow";

/// Store apps' display names by app id. A package's name doesn't change while it's installed, and
/// the lookup loads the package's details (about 20 ms the first time), so each app is looked up
/// once.
static HOSTED_APP_NAMES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::OnceLock::new();

/// For a store app's frame, the app it shows, by the name Windows lists it under: its package's
/// display name in the user's language ("Calculator"; #50). `None` for any other window, and when
/// the app can't be found: a minimised app takes its window out of the frame, and an app that sets
/// its own title can't be matched to it then.
#[must_use]
pub fn hosted_app_name(hwnd: isize) -> Option<String> {
    let frame = HWND(hwnd as *mut c_void);
    if frame.is_invalid() || class_name(frame).as_deref() != Some(FRAME_CLASS) {
        return None;
    }
    let app_id = app_user_model_id(hosted_process(frame)?)?;
    let names = HOSTED_APP_NAMES.get_or_init(std::sync::Mutex::default);
    let known = names
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&app_id)
        .cloned();
    known.or_else(|| {
        let name = app_display_name(&app_id)?;
        names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(app_id, name.clone());
        Some(name)
    })
}

/// Collects each window handle `EnumWindows` or `EnumChildWindows` passes into the `Vec<HWND>`
/// behind `found`. A panic must never unwind into Windows: it ends the enumeration instead.
unsafe extern "system" fn collect_handles(hwnd: HWND, found: LPARAM) -> BOOL {
    catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: every caller passes a `&mut Vec<HWND>` that outlives the enumeration, which runs
        // this callback synchronously on the caller's thread.
        let list = unsafe { &mut *(found.0 as *mut Vec<HWND>) };
        list.push(hwnd);
    }))
    .map_or(BOOL(0), |()| BOOL(1))
}

/// The process of the app a store app's frame shows: the window inside the frame that another
/// process owns, or, while the app has taken its window out (as it does when minimised), a
/// top-level core window of another process with the frame's title.
fn hosted_process(frame: HWND) -> Option<u32> {
    let host = window_pid(frame);
    let mut children: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `children`, which lives until EnumChildWindows returns;
    // a frame closed since has no children to list.
    let _ = unsafe {
        EnumChildWindows(
            Some(frame),
            Some(collect_handles),
            LPARAM((&raw mut children) as isize),
        )
    };
    if let Some(pid) = children
        .into_iter()
        .map(window_pid)
        .find(|&pid| pid != 0 && pid != host)
    {
        return Some(pid);
    }
    let title = window_title(frame);
    if title.trim().is_empty() {
        return None;
    }
    let class: Vec<u16> = CORE_WINDOW_CLASS
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let mut after: Option<HWND> = None;
    for _ in 0..MAX_CORE_WINDOWS {
        // SAFETY: `class` and `title` are NUL-terminated UTF-16 that outlive the call; no parent
        // means top-level windows, and `after` is the previous handle found (or none, to start).
        let Ok(next) = (unsafe {
            FindWindowExW(
                None,
                after,
                windows::core::PCWSTR(class.as_ptr()),
                windows::core::PCWSTR(title.as_ptr()),
            )
        }) else {
            break;
        };
        let pid = window_pid(next);
        if pid != 0 && pid != host {
            return Some(pid);
        }
        after = Some(next);
    }
    None
}

/// The process that owns a window, or 0 for a window that has closed.
fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: out-pointer to a local; a stale handle leaves it at 0.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut pid)) };
    pid
}

/// The app a packaged process runs, by its app id (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`),
/// or `None` for a process that isn't a packaged app.
fn app_user_model_id(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
    let process = ProcessHandle::open(pid)?;
    // Windows caps an app's id at 130 characters (APPLICATION_USER_MODEL_ID_MAX_LENGTH).
    let mut buffer = [0u16; 256];
    let mut length = u32::try_from(buffer.len()).ok()?;
    // SAFETY: `process` is open with limited-query rights, which is what the call needs; `buffer`
    // holds `length` u16s, which is what the call was told it may write.
    let result = unsafe {
        GetApplicationUserModelId(process.0, &raw mut length, Some(PWSTR(buffer.as_mut_ptr())))
    };
    if result != ERROR_SUCCESS {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    let id = String::from_utf16_lossy(&buffer[..end]);
    (!id.is_empty()).then_some(id)
}

/// An installed app's display name in the user's language ("Calculator"), from its app id.
fn app_display_name(app_id: &str) -> Option<String> {
    if app_id.is_empty() {
        return None;
    }
    crate::com::keep_multithreaded_apartment();
    let app = windows::ApplicationModel::AppInfo::GetFromAppUserModelId(
        &windows::core::HSTRING::from(app_id),
    )
    .ok()?;
    let name = app.DisplayInfo().ok()?.DisplayName().ok()?.to_string();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Whether this process runs elevated. If it does, admin windows are visible to it.
#[must_use]
pub fn own_process_elevated() -> bool {
    // SAFETY: a pseudo-handle for this process; it needs no closing.
    token_elevation(unsafe { GetCurrentProcess() }) == Elevation::Elevated
}

/// Shows a native warning box in front of other windows and waits until it is closed. Used
/// when the app's own web views may be gone, so the message can't depend on them. Call it on a
/// thread that may block.
pub fn show_warning(title: &str, text: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
    };
    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both buffers are NUL-terminated UTF-16 that outlive the call; no owner window.
    unsafe {
        MessageBoxW(
            None,
            windows::core::PCWSTR(text.as_ptr()),
            windows::core::PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND,
        );
    }
}

/// A top-level window that is showing, for working out what a screenshot shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownWindow {
    /// Window handle as an integer: what [`owner_processes_of`] reads the owners of (#110).
    pub hwnd: isize,
    pub pid: u32,
    /// Visible frame in physical pixels.
    pub frame: Rect,
    /// Click-through or layered (drawn with transparency), so what is behind it may show through.
    pub see_through: bool,
    /// Click-through and layered both: an overlay laid over the screen (a screen-share border, a
    /// game or annotation overlay, a dimmer), not a window someone works in. Plain layered windows
    /// are common for ordinary app windows, so `see_through` alone can't say this.
    pub click_through: bool,
    /// One of the shell's notification windows (`is_notification_window`): a notification toast,
    /// greyed out over the clicked window and flagged where it shows.
    pub notification: bool,
    /// For a frame Windows draws round another program's window (an `ApplicationFrameWindow`),
    /// the process it shows ([`WindowInfo::hosted_exe`]): a store app's, or the text input host's
    /// for an input panel (#109). `None` for any other window.
    pub hosted_pid: Option<u32>,
}

/// The kind of window Windows' shell shows its notification toasts in.
const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

/// The program that draws notification toasts and the notification centre on Windows 11 (checked
/// on build 26300, 12/10/2026: the toast's view, `FlexibleToastView`, is in
/// `Windows.UI.ActionCenter.dll`, which only this program loads; Windows 10 used it too).
const NOTIFICATION_HOST: &str = "shellexperiencehost.exe";

/// Whether a top-level window is one of the shell's notification windows: a notification toast
/// (often with a message preview) or the notification centre (docs/spec/02-capture.md#on-each-click).
/// Known by its window, never by what it says: a core window of the shell experience host. A core
/// window whose program can't be named counts too, so more is greyed out and flagged rather than
/// less. Its other flyouts (the calendar, quick settings on some builds) are core windows of the
/// same program and count as well: they can't be told apart without their localised titles.
#[must_use]
pub fn is_notification_window(class: &str, exe: Option<&str>) -> bool {
    class == CORE_WINDOW_CLASS && exe.is_none_or(|exe| exe.eq_ignore_ascii_case(NOTIFICATION_HOST))
}

/// Every top-level window that is showing, front to back: visible, not minimised, not cloaked
/// (a window on another virtual desktop or a suspended store app is visible to Windows but not
/// on screen), and not empty. Two kinds of window in z-order bands of their own, above every
/// app's, which `EnumWindows` doesn't list, come first (`band_windows`): the shell's notification
/// windows, and frames Windows draws round another program's window there, as it shows the emoji
/// panel and clipboard history (#109).
#[must_use]
pub fn shown_windows() -> Vec<ShownWindow> {
    // Only core windows need their program named, which takes a process query: read as the mouse
    // button goes down, this must stay quick.
    let mut programs: std::collections::HashMap<u32, Option<String>> =
        std::collections::HashMap::new();
    let listed = shown_handles();
    let notifications: Vec<ShownWindow> = band_windows(&listed, CORE_WINDOW_CLASS)
        .into_iter()
        .filter_map(|hwnd| shown_window(hwnd, &mut programs))
        .filter(|window| window.notification)
        .collect();
    // The input panel's frame is `explorer.exe`'s, round the text input host's window (build
    // 26300, 12/10/2026): kept when it shows another program, which says what it is.
    let frames: Vec<ShownWindow> = band_windows(&listed, FRAME_CLASS)
        .into_iter()
        .filter_map(|hwnd| shown_window(hwnd, &mut programs))
        .filter(|window| window.hosted_pid.is_some())
        .collect();
    notifications
        .into_iter()
        .chain(frames)
        .chain(
            listed
                .into_iter()
                .filter_map(|hwnd| shown_window(hwnd, &mut programs)),
        )
        .collect()
}

/// A showing window's facts, or `None` when it has no area. `programs` keeps each process's
/// program name, looked up only for core windows.
fn shown_window(
    hwnd: HWND,
    programs: &mut std::collections::HashMap<u32, Option<String>>,
) -> Option<ShownWindow> {
    let frame = frame_bounds(hwnd);
    if frame.right <= frame.left || frame.bottom <= frame.top {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: out-pointer to a local.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut pid)) };
    let style = ex_style(hwnd);
    let see_through_bits =
        isize::try_from(WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0).unwrap_or(isize::MAX);
    let class = class_name(hwnd);
    let notification = class.as_deref().is_some_and(|class| {
        class == CORE_WINDOW_CLASS
            && is_notification_window(
                class,
                programs
                    .entry(pid)
                    .or_insert_with(|| process_exe_name(pid))
                    .as_deref(),
            )
    });
    // Only frames are asked what they show: a frame's own windows are few to list.
    let hosted_pid = class
        .as_deref()
        .filter(|&class| class == FRAME_CLASS)
        .and_then(|_| hosted_process(hwnd));
    Some(ShownWindow {
        hwnd: hwnd.0 as isize,
        pid,
        frame,
        // A toast is drawn translucent (acrylic), so it never counts as hiding what's behind it:
        // an excluded app there is still blacked out.
        see_through: notification || style & see_through_bits != 0,
        click_through: style & see_through_bits == see_through_bits,
        notification,
        hosted_pid,
    })
}

/// The most windows of one class looked through for those in a z-order band.
const MAX_CORE_WINDOWS: usize = 512;

/// The showing top-level windows of `class` that `EnumWindows` leaves out (12/10/2026, checked
/// live on build 26300): windows kept in a z-order band of their own above every app's, which
/// `EnumWindows`, `GetWindow` and UI Automation's root don't list, but `FindWindowExW` does, by
/// class. Notification toasts are drawn in a core window ("New notification", of
/// `ShellExperienceHost.exe`) there, always present: cloaked and of no height until a toast
/// shows, then shown and sized to the toasts on screen. The emoji panel and clipboard history are
/// shown in an untitled `ApplicationFrameWindow` of `explorer.exe`'s there (topmost, never
/// activated), round the text input host's windows (#109).
fn band_windows(listed: &[HWND], class: &str) -> Vec<HWND> {
    let class: Vec<u16> = class.encode_utf16().chain(std::iter::once(0)).collect();
    let mut found = Vec::new();
    let mut after: Option<HWND> = None;
    for _ in 0..MAX_CORE_WINDOWS {
        // SAFETY: `class` is NUL-terminated UTF-16 that outlives the call; no parent means
        // top-level windows, and `after` is the previous handle found (or none, to start).
        let Ok(next) = (unsafe {
            FindWindowExW(
                None,
                after,
                windows::core::PCWSTR(class.as_ptr()),
                windows::core::PCWSTR::null(),
            )
        }) else {
            break;
        };
        if !listed.contains(&next) && is_shown(next) {
            found.push(next);
        }
        after = Some(next);
    }
    found
}

/// Visible, not minimised and not cloaked: on screen, if it has an area.
fn is_shown(hwnd: HWND) -> bool {
    // SAFETY: both calls take any handle and tolerate a window closed since it was found.
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() };
    visible && !cloaked(hwnd)
}

/// The front-most app window that isn't `except_pid`'s: the one someone was working in before
/// they clicked a floating toolbar of ours. Tool windows and windows without a title (the
/// taskbar, the desktop) don't count.
#[must_use]
pub fn front_window_except(except_pid: u32) -> Option<WindowInfo> {
    let tool = isize::try_from(WS_EX_TOOLWINDOW.0).unwrap_or(isize::MAX);
    shown_handles()
        .into_iter()
        .filter(|&hwnd| ex_style(hwnd) & tool == 0)
        .map(info_for)
        .find(|window| {
            window.pid != except_pid
                && !window.title.trim().is_empty()
                && window.frame.right > window.frame.left
                && window.frame.bottom > window.frame.top
        })
}

pub(crate) fn ex_style(hwnd: HWND) -> isize {
    // SAFETY: reads a style value of a window handle; 0 for a closed window.
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
}

/// Whether another copy of Steps is running (the installed one, the Store's or a portable
/// one: every Steps program is `amluto-steps…exe`), so a shortcut Windows refused can be put
/// down to it rather than to "another app". Hidden windows count: Steps may be in the tray.
#[must_use]
pub fn other_steps_running() -> bool {
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `handles`, which lives until EnumWindows returns.
    let _ = unsafe { EnumWindows(Some(collect_handles), LPARAM((&raw mut handles) as isize)) };
    let own = own_process_id();
    let mut seen = std::collections::HashSet::new();
    handles.into_iter().any(|hwnd| {
        let mut pid = 0u32;
        // SAFETY: a handle from EnumWindows; a window closed since leaves `pid` at 0.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut pid)) };
        pid != 0
            && pid != own
            && seen.insert(pid)
            && process_exe_name(pid)
                .is_some_and(|name| name.to_ascii_lowercase().starts_with("amluto-steps"))
    })
}

/// Top-level windows that are showing, front to back.
fn shown_handles() -> Vec<HWND> {
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `handles`, which lives until EnumWindows returns.
    let _ = unsafe { EnumWindows(Some(collect_handles), LPARAM((&raw mut handles) as isize)) };
    handles.into_iter().filter(|&hwnd| is_shown(hwnd)).collect()
}

#[cfg(test)]
mod shown_tests {
    use super::*;

    #[test]
    fn shown_windows_have_real_frames() {
        // Whatever is open on this PC: every entry must be a window with an area.
        for window in shown_windows() {
            assert!(window.frame.right > window.frame.left);
            assert!(window.frame.bottom > window.frame.top);
        }
    }

    /// The check on a real desktop: start it, then make a notification appear (a chat message, or
    /// a reminder) within 30 seconds. It prints each notification window found and passes once one
    /// shows.
    #[test]
    #[ignore = "needs a notification toast on screen: cargo test -p capture-win32 a_toast_on_screen -- --ignored --nocapture"]
    fn a_toast_on_screen_is_a_notification_window() {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let found: Vec<ShownWindow> = shown_windows()
                .into_iter()
                .filter(|window| window.notification)
                .collect();
            if !found.is_empty() {
                for window in found {
                    println!("{window:?}");
                }
                return;
            }
            assert!(
                std::time::Instant::now() < until,
                "no notification window showed in 30 seconds"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}

fn cloaked(hwnd: HWND) -> bool {
    let mut value = 0u32;
    let size = u32::try_from(std::mem::size_of::<u32>()).unwrap_or(4);
    // SAFETY: `value` is a u32-sized buffer owned by this frame, and `size` matches it.
    let result = unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&raw mut value).cast::<c_void>(), size)
    };
    result.is_ok() && value != 0
}

fn info_for(root: HWND) -> WindowInfo {
    let mut pid = 0u32;
    // SAFETY: out-pointer to a local.
    unsafe { GetWindowThreadProcessId(root, Some(&raw mut pid)) };
    let class = class_name(root);

    WindowInfo {
        hwnd: root.0 as isize,
        pid,
        title: window_title(root),
        exe_path: process_path(pid),
        frame: frame_bounds(root),
        elevation: process_elevation(pid),
        hosted_exe: hosted_exe(root, class.as_deref()),
        class,
    }
}

/// For a frame Windows draws round another program's window, the file name of the program it
/// shows ([`WindowInfo::hosted_exe`]); `None` for any other window (by its `class`). Read as the
/// mouse button goes down too, so only a frame is asked: its own windows are few to list.
fn hosted_exe(window: HWND, class: Option<&str>) -> Option<String> {
    if class != Some(FRAME_CLASS) {
        return None;
    }
    process_exe_name(hosted_process(window)?)
}

/// The control with the keyboard in a top-level window, as Windows itself says: where that
/// window's keys go, whatever UI Automation last said had focus. The common file dialog's File
/// name box is found by it (#61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyboardFocus {
    /// The control's own window handle.
    pub hwnd: isize,
    /// The top-level window the control is in.
    pub root: isize,
    /// Its window class (`Edit`).
    pub class: String,
    /// Its parent window's class (`ComboBox`).
    pub parent_class: String,
    /// Its control id.
    pub id: i32,
}

/// The id Windows gives the edit inside a combo box that can be typed in.
const COMBO_BOX_EDIT_ID: i32 = 1001;

impl KeyboardFocus {
    /// Whether it's the edit of a combo box that can be typed in, such as the common file
    /// dialog's File name box in Save As and Open alike. UI Automation can give that box its combo
    /// box's id instead, so the window's own id is what's compared.
    #[must_use]
    pub fn is_combo_box_edit(&self) -> bool {
        self.class.eq_ignore_ascii_case("Edit")
            && self.id == COMBO_BOX_EDIT_ID
            && (self.parent_class.eq_ignore_ascii_case("ComboBox")
                || self.parent_class.eq_ignore_ascii_case("ComboBoxEx32"))
    }
}

/// The control with the keyboard in the thread of the top-level window `window`
/// (`GetGUIThreadInfo`), or `None` when it has none or the window has closed.
#[must_use]
pub fn keyboard_focus(window: isize) -> Option<KeyboardFocus> {
    use windows::Win32::UI::WindowsAndMessaging::{GUITHREADINFO, GetDlgCtrlID, GetGUIThreadInfo};
    let window = HWND(window as *mut c_void);
    if window.is_invalid() {
        return None;
    }
    // SAFETY: a stale handle gives thread 0, which is checked; no out-pointer is passed.
    let thread = unsafe { GetWindowThreadProcessId(window, None) };
    if thread == 0 {
        return None;
    }
    let mut info = GUITHREADINFO {
        cbSize: u32::try_from(std::mem::size_of::<GUITHREADINFO>()).ok()?,
        ..GUITHREADINFO::default()
    };
    // SAFETY: `info` is a GUITHREADINFO owned by this frame with `cbSize` set to its size, as the
    // call requires; it only writes into it.
    unsafe { GetGUIThreadInfo(thread, &raw mut info) }.ok()?;
    let focus = info.hwndFocus;
    if focus.is_invalid() {
        return None;
    }
    // SAFETY: GetAncestor tolerates stale handles by returning null.
    let parent = unsafe { GetAncestor(focus, GA_PARENT) };
    // SAFETY: returns 0 for a stale handle or a window with no id.
    let id = unsafe { GetDlgCtrlID(focus) };
    Some(KeyboardFocus {
        hwnd: focus.0 as isize,
        root: root_of(focus).0 as isize,
        class: class_name(focus)?,
        parent_class: class_name(parent).unwrap_or_default(),
        id,
    })
}

/// A top-level window's class name (`ConsoleWindowClass`, `XLMAIN`), or `None` for a window that
/// has closed. Terminals and Excel are recognised by it.
#[must_use]
pub fn window_class(hwnd: isize) -> Option<String> {
    class_name(HWND(hwnd as *mut c_void))
}

pub(crate) fn class_name(hwnd: HWND) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buffer = [0u16; 256];
    // SAFETY: the slice is a valid writable buffer; the call writes at most its length, and
    // returns 0 for a stale handle.
    let length = unsafe { GetClassNameW(hwnd, &mut buffer) };
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    Some(String::from_utf16_lossy(
        &buffer[..length.min(buffer.len())],
    ))
}

fn window_title(hwnd: HWND) -> String {
    let mut buffer = [0u16; 512];
    // SAFETY: the slice is a valid writable buffer; the call writes at most its length.
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    let length = usize::try_from(length).unwrap_or(0).min(buffer.len());
    String::from_utf16_lossy(&buffer[..length])
}

fn frame_bounds(hwnd: HWND) -> Rect {
    let mut rect = RECT::default();
    let size = u32::try_from(std::mem::size_of::<RECT>()).unwrap_or(16);
    // SAFETY: `rect` is a RECT-sized buffer owned by this frame, and `size` matches it.
    let dwm = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast::<c_void>(),
            size,
        )
    };
    if dwm.is_err() {
        // SAFETY: out-pointer to a local RECT.
        let _ = unsafe { GetWindowRect(hwnd, &raw mut rect) };
    }
    rect.into()
}

/// Opens a process for limited queries; the handle is closed when the guard drops.
struct ProcessHandle(HANDLE);

impl ProcessHandle {
    fn open(pid: u32) -> Option<Self> {
        if pid == 0 {
            return None;
        }
        // SAFETY: requests only limited-query rights, which never allow modifying the process.
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .ok()
            .map(Self)
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by us and is closed exactly once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn process_path(pid: u32) -> Option<String> {
    let process = ProcessHandle::open(pid)?;
    // Most paths fit the first buffer; a long one (up to the 32,767-unit limit) gets a second try,
    // since an app that can't be named can't be matched against the excluded list.
    [1024, 32_768].into_iter().find_map(|capacity| {
        let mut buffer = vec![0u16; capacity];
        let mut size = u32::try_from(buffer.len()).ok()?;
        // SAFETY: `buffer` holds `size` u16s and the call writes at most that many.
        unsafe {
            QueryFullProcessImageNameW(
                process.0,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &raw mut size,
            )
        }
        .ok()?;
        let length = usize::try_from(size).ok()?.min(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..length]))
    })
}

fn process_elevation(pid: u32) -> Elevation {
    match ProcessHandle::open(pid) {
        Some(process) => token_elevation(process.0),
        None => Elevation::Unknown,
    }
}

fn token_elevation(process: HANDLE) -> Elevation {
    let mut token = HANDLE::default();
    // SAFETY: `process` is open with at least limited-query rights (or is our pseudo-handle);
    // out-pointer to a local handle; TOKEN_QUERY only reads.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) }.is_err() {
        return Elevation::Unknown;
    }
    let token = ProcessHandle(token);

    let mut elevation = TOKEN_ELEVATION::default();
    let size = u32::try_from(std::mem::size_of::<TOKEN_ELEVATION>()).unwrap_or(4);
    let mut returned = 0u32;
    // SAFETY: the buffer is a TOKEN_ELEVATION owned by this frame and `size` matches it.
    let result = unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&raw mut elevation).cast::<c_void>()),
            size,
            &raw mut returned,
        )
    };
    match result {
        Ok(()) if elevation.TokenIsElevated != 0 => Elevation::Elevated,
        Ok(()) => Elevation::NotElevated,
        Err(_) => Elevation::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_not_elevated_in_tests_and_has_a_path() {
        let pid = own_process_id();
        assert!(process_path(pid).is_some_and(|path| path.to_lowercase().ends_with(".exe")));
        assert_ne!(process_elevation(pid), Elevation::Unknown);
        assert_eq!(
            own_process_elevated(),
            process_elevation(pid) == Elevation::Elevated
        );
    }

    #[test]
    fn a_process_is_named_by_its_program_file() {
        let name = process_exe_name(own_process_id()).expect("own process is readable");
        assert!(name.to_lowercase().ends_with(".exe"), "{name}");
        assert!(!name.contains('\\'));
        assert_eq!(process_exe_name(0), None);
    }

    #[test]
    fn a_combo_box_edit_is_known_by_its_own_window() {
        let file_name = KeyboardFocus {
            hwnd: 2,
            root: 1,
            class: "Edit".into(),
            parent_class: "ComboBox".into(),
            id: 1001,
        };
        assert!(file_name.is_combo_box_edit());
        assert!(
            KeyboardFocus {
                parent_class: "ComboBoxEx32".into(),
                ..file_name.clone()
            }
            .is_combo_box_edit()
        );
        // A plain edit (a search box), another control's id, or a list: not one.
        for other in [
            KeyboardFocus {
                parent_class: "SearchEditBoxWrapperClass".into(),
                ..file_name.clone()
            },
            KeyboardFocus {
                id: 1148,
                ..file_name.clone()
            },
            KeyboardFocus {
                class: "DirectUIHWND".into(),
                ..file_name.clone()
            },
        ] {
            assert!(!other.is_combo_box_edit(), "{other:?}");
        }
        // No window, no keyboard.
        assert_eq!(keyboard_focus(0), None);
    }

    #[test]
    fn foreground_and_handle_lookups_agree() {
        // A test runner may have no window in front (e.g. a locked session); then there is
        // nothing to compare.
        if let Some(front) = foreground_window() {
            assert_eq!(window_info(front.hwnd), Some(front));
        }
        assert_eq!(window_info(0), None);
    }

    #[test]
    fn a_program_has_its_own_description() {
        let path = process_path(own_process_id()).expect("own process is readable");
        // The test runner is a Rust binary with no version details; Windows' own programs have one.
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        assert_eq!(
            program_description(&format!(r"{system}\explorer.exe")).as_deref(),
            Some("Windows Explorer")
        );
        assert_eq!(program_description(&path), None);
        assert_eq!(
            program_description(
                r"C:
o\such\program.exe"
            ),
            None
        );
    }

    #[test]
    fn the_hit_test_tells_a_windows_title_bar_buttons() {
        assert_eq!(title_bar_button(20, false), Some(TitleBarButton::Close));
        assert_eq!(title_bar_button(8, false), Some(TitleBarButton::Minimise));
        assert_eq!(title_bar_button(9, false), Some(TitleBarButton::Maximise));
        // Maximise on a window already maximised puts it back.
        assert_eq!(title_bar_button(9, true), Some(TitleBarButton::Restore));
        // Errors, see-through, nowhere, the client area, the caption, the system menu, Help.
        for other in [-2, -1, 0, 1, 2, 3, 21] {
            assert_eq!(title_bar_button(other, false), None, "{other}");
        }
    }

    #[test]
    fn a_point_is_packed_as_the_hit_test_unpacks_it() {
        assert_eq!(point_lparam(200, 100), 0x0064_00C8);
        // A monitor left of and above the primary.
        assert_eq!(point_lparam(-1280, -200), 0xFF38_FB00);
    }

    /// A top-level window with no title bar, of the class `hidden_window` registers, never shown.
    fn hidden_pop_up(ex_style: windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE) -> HWND {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WS_POPUP};
        use windows::core::w;
        // SAFETY: this module's own handle.
        let instance = unsafe { GetModuleHandleW(None) }.expect("module handle");
        // SAFETY: a pop-up window of a class registered by `hidden_window`, created hidden.
        unsafe {
            CreateWindowExW(
                ex_style,
                w!("AmlutoStepsTitleBarTest"),
                w!("PopupHost"),
                WS_POPUP,
                100,
                100,
                320,
                400,
                None,
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("pop-up window")
    }

    #[test]
    fn a_top_level_window_without_a_title_bar_is_a_pop_up() {
        use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, WINDOW_EX_STYLE};
        let (titled, _) = hidden_window();
        let pop_up = hidden_pop_up(WINDOW_EX_STYLE(0));
        let app_window = hidden_pop_up(WS_EX_APPWINDOW);
        assert!(is_pop_up_window(pop_up.0 as isize));
        // A window with Windows' title bar, or one asking for a taskbar button of its own.
        assert!(!is_pop_up_window(titled.0 as isize));
        assert!(!is_pop_up_window(app_window.0 as isize));
        assert!(!is_pop_up_window(0));
        // Never shown.
        assert!(!is_visible(pop_up.0 as isize));
        assert!(!is_showing(pop_up.0 as isize));
        for window in [titled, pop_up, app_window] {
            // SAFETY: destroys the windows this thread created above.
            let _ = unsafe { DestroyWindow(window) };
        }
    }

    unsafe extern "system" fn plain_window_proc(
        window: HWND,
        message: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        // SAFETY: default handling, with the unchanged arguments.
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(window, message, wparam, lparam)
        }
    }

    /// A window with a standard title bar, never shown, owned by this thread, and its title-bar
    /// buttons' rectangles as Windows describes them (`WM_GETTITLEBARINFOEX`).
    fn hidden_window() -> (HWND, [RECT; 6]) {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::HiDpi::{
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, RegisterClassExW, SendMessageW, TITLEBARINFOEX, WINDOW_EX_STYLE,
            WM_GETTITLEBARINFOEX, WNDCLASSEXW, WS_OVERLAPPEDWINDOW,
        };
        use windows::core::w;
        // SAFETY: changes only this test thread's DPI awareness, so the window and its rectangles
        // are in physical pixels, as the recorder's are.
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        // SAFETY: this module's own handle.
        let instance = unsafe { GetModuleHandleW(None) }.expect("module handle");
        let class = WNDCLASSEXW {
            cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap(),
            lpfnWndProc: Some(plain_window_proc),
            hInstance: instance.into(),
            lpszClassName: w!("AmlutoStepsTitleBarTest"),
            ..WNDCLASSEXW::default()
        };
        // SAFETY: a fully initialised class with static strings; registering it twice fails
        // harmlessly.
        unsafe { RegisterClassExW(&raw const class) };
        // SAFETY: an ordinary top-level window of the class above, created hidden.
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("AmlutoStepsTitleBarTest"),
                w!("Book2 - Excel"),
                WS_OVERLAPPEDWINDOW,
                200,
                150,
                800,
                500,
                None,
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("window");
        let mut info = TITLEBARINFOEX {
            cbSize: u32::try_from(std::mem::size_of::<TITLEBARINFOEX>()).unwrap(),
            ..TITLEBARINFOEX::default()
        };
        // SAFETY: `info` outlives the call, which fills it in on this thread.
        unsafe {
            SendMessageW(
                window,
                WM_GETTITLEBARINFOEX,
                None,
                Some(LPARAM((&raw mut info) as isize)),
            )
        };
        (window, info.rgrect)
    }

    fn middle(rect: &RECT) -> (i32, i32) {
        (
            i32::midpoint(rect.left, rect.right),
            i32::midpoint(rect.top, rect.bottom),
        )
    }

    #[test]
    fn a_windows_own_title_bar_buttons_are_told_by_its_hit_test() {
        use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
        let (window, buttons) = hidden_window();
        // TITLEBARINFOEX: 5 is Close. The widths it gives the others needn't match the hit test's,
        // so they're found by walking left along the title bar from Close.
        let (x, y) = middle(&buttons[5]);
        assert_eq!(
            title_bar_button_at(window, window, x, y),
            Some(TitleBarButton::Close),
            "{buttons:?}"
        );
        let mut met: Vec<TitleBarButton> = Vec::new();
        for x in (200..x).rev() {
            if let Some(button) = title_bar_button_at(window, window, x, y)
                && met.last() != Some(&button)
            {
                met.push(button);
            }
        }
        assert_eq!(
            met,
            [
                TitleBarButton::Close,
                TitleBarButton::Maximise,
                TitleBarButton::Minimise
            ],
            "{buttons:?}"
        );
        // The middle of the window is its client area: no button there.
        assert_eq!(title_bar_button_at(window, window, 600, 400), None);
        // SAFETY: destroys the window this thread created above.
        let _ = unsafe { DestroyWindow(window) };
        // A window that has closed has no buttons to tell.
        let (x, y) = middle(&buttons[5]);
        assert_eq!(title_bar_button_at(window, window, x, y), None);
    }

    /// A window of the given style, never shown, owned by `owner` if any.
    fn hidden_with_style(
        style: windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE,
        owner: Option<HWND>,
    ) -> HWND {
        hidden_with_ex_style(
            style,
            windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(0),
            owner,
        )
    }

    /// A window of the given styles, never shown, owned by `owner` if any.
    fn hidden_with_ex_style(
        style: windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE,
        ex_style: windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE,
        owner: Option<HWND>,
    ) -> HWND {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, RegisterClassExW, WNDCLASSEXW,
        };
        use windows::core::w;
        // SAFETY: this module's own handle.
        let instance = unsafe { GetModuleHandleW(None) }.expect("module handle");
        let class = WNDCLASSEXW {
            cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap(),
            lpfnWndProc: Some(plain_window_proc),
            hInstance: instance.into(),
            lpszClassName: w!("AmlutoStepsPopUpTest"),
            ..WNDCLASSEXW::default()
        };
        // SAFETY: a fully initialised class with static strings; registering it twice fails
        // harmlessly.
        unsafe { RegisterClassExW(&raw const class) };
        // SAFETY: a top-level window of the class above, created hidden; a parent given to a
        // top-level window is its owner.
        unsafe {
            CreateWindowExW(
                ex_style,
                w!("AmlutoStepsPopUpTest"),
                w!(""),
                style,
                100,
                100,
                300,
                200,
                owner,
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("window")
    }

    #[test]
    fn a_pop_up_belongs_to_the_window_it_came_from() {
        use windows::Win32::UI::WindowsAndMessaging::{
            DestroyWindow, WS_BORDER, WS_CAPTION, WS_EX_APPWINDOW, WS_OVERLAPPEDWINDOW, WS_POPUP,
        };
        let app = hidden_with_style(WS_OVERLAPPEDWINDOW, None);
        let menu = hidden_with_style(WS_POPUP | WS_BORDER, Some(app));
        let submenu = hidden_with_style(WS_POPUP | WS_BORDER, Some(menu));
        let dialog = hidden_with_style(WS_POPUP | WS_CAPTION, Some(app));
        let alone = hidden_with_style(WS_POPUP | WS_BORDER, None);
        // An app drawing its own title bar has none of Windows': its menus still belong to it.
        let frameless = hidden_with_style(WS_POPUP, None);
        let its_menu = hidden_with_style(WS_POPUP | WS_BORDER, Some(frameless));
        // A window drawing its own title bar that asks for a taskbar button of its own (a message
        // popped out into a window of its own) is no pop-up, owned or not.
        let popped_out = hidden_with_ex_style(WS_POPUP, WS_EX_APPWINDOW, Some(app));
        // These windows are never shown, so take them as showing here.
        let showing = |_: HWND| true;

        assert_eq!(pop_up_owner(menu, showing), Some(app));
        // A submenu belongs to the window its menu came from.
        assert_eq!(pop_up_owner(submenu, showing), Some(app));
        assert_eq!(pop_up_owner(its_menu, showing), Some(frameless));
        // A dialog has a title bar: it's a window of its own, as is the app's window.
        assert_eq!(pop_up_owner(dialog, showing), None);
        assert_eq!(pop_up_owner(app, showing), None);
        // A pop-up nothing owns stays on its own.
        assert_eq!(pop_up_owner(alone, showing), None);
        assert_eq!(pop_up_owner(frameless, showing), None);
        assert_eq!(pop_up_owner(popped_out, showing), None);
        // Nor does a window that isn't showing count: a tray icon's menu is owned by a hidden one.
        assert_eq!(pop_up_owner(menu, shown_with_area), None);

        for window in [
            popped_out, its_menu, frameless, alone, dialog, submenu, menu, app,
        ] {
            // SAFETY: destroys a window this thread created above.
            let _ = unsafe { DestroyWindow(window) };
        }
        // A window that has closed belongs to nothing.
        assert_eq!(pop_up_owner(menu, showing), None);
    }

    #[test]
    fn a_windows_owners_are_followed_whether_or_not_they_show() {
        use windows::Win32::UI::WindowsAndMessaging::{
            DestroyWindow, WS_BORDER, WS_OVERLAPPEDWINDOW, WS_POPUP,
        };
        let app = hidden_with_style(WS_OVERLAPPEDWINDOW, None);
        let menu = hidden_with_style(WS_POPUP | WS_BORDER, Some(app));
        let submenu = hidden_with_style(WS_POPUP | WS_BORDER, Some(menu));
        let own = own_process_id();
        // None of them shows, so #72 finds no window for the submenu to be shown round (#103)...
        assert_eq!(pop_up_owner(submenu, shown_with_area), None);
        // ...but its owners' programs are still known: each once, the nearest first.
        assert_eq!(owner_processes(submenu), vec![own]);
        assert_eq!(owner_processes(menu), vec![own]);
        // A window nothing owns has none.
        assert_eq!(owner_processes(app), Vec::<u32>::new());

        for window in [submenu, menu, app] {
            // SAFETY: destroys a window this thread created above.
            let _ = unsafe { DestroyWindow(window) };
        }
        // Nor does a window that has closed.
        assert_eq!(owner_processes(submenu), Vec::<u32>::new());
    }

    /// The check on a real desktop (#72): run it, then within 30 seconds open a menu or a
    /// drop-down (Excel's right-click menu, Paint's File menu, a combo box's list, a browser's
    /// context menu) and rest the pointer on it. It prints each window under the pointer with the
    /// window it came from and the programs up its owners, as a press there reads them, and passes
    /// once a pop-up's window is found. A web view's drop-down (Teams', the new Outlook's) lists the
    /// app's program among its owners (#103).
    #[test]
    #[ignore = "needs a menu open under the pointer: cargo test -p capture-win32 a_menu_under_the_pointer -- --ignored --nocapture"]
    fn a_menu_under_the_pointer_belongs_to_the_window_it_came_from() {
        let _ = crate::display::enable_per_monitor_dpi_awareness();
        let until = Instant::now() + Duration::from_secs(30);
        let mut last = None;
        loop {
            if let Some((x, y)) = crate::display::cursor_pos()
                && let Some(pressed) = pressed_at(x, y, false)
            {
                let owner = pressed.owner.as_ref().map(|owner| owner.hwnd);
                if last != Some((pressed.window.hwnd, owner)) {
                    last = Some((pressed.window.hwnd, owner));
                    println!(
                        "{:?} {:?} {:?} {:?} -> {:?}, owned by {:?}",
                        class_name(HWND(pressed.window.hwnd as *mut c_void)),
                        pressed.window.exe_name(),
                        pressed.window.title,
                        pressed.window.frame,
                        pressed.owner.as_ref().map(|owner| (
                            &owner.title,
                            owner.exe_name(),
                            owner.frame
                        )),
                        pressed
                            .owners
                            .iter()
                            .map(|&pid| process_exe_name(pid))
                            .collect::<Vec<_>>(),
                    );
                }
                if owner.is_some() {
                    return;
                }
            }
            assert!(
                Instant::now() < until,
                "no pop-up's window found under the pointer in 30 seconds"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn a_system_menu_or_a_combo_boxs_list_is_found_through_its_thread() {
        assert_eq!(told_by_thread("#32768"), Some(ThreadSays::MenuOwner));
        assert_eq!(told_by_thread("ComboLBox"), Some(ThreadSays::Active));
        assert_eq!(told_by_thread("Net UI Tool Window"), None);
        assert_eq!(told_by_thread("Chrome_WidgetWin_2"), None);
    }

    #[test]
    fn notification_toasts_are_known_by_their_window() {
        let core = "Windows.UI.Core.CoreWindow";
        // Windows 11 shows its notification toasts, and the notification centre, in core
        // windows of the shell experience host.
        assert!(is_notification_window(
            core,
            Some("ShellExperienceHost.exe")
        ));
        assert!(is_notification_window(
            core,
            Some("shellexperiencehost.exe")
        ));
        // Start and Search are core windows of other shell programs.
        assert!(!is_notification_window(
            core,
            Some("StartMenuExperienceHost.exe")
        ));
        assert!(!is_notification_window(core, Some("SearchHost.exe")));
        // The taskbar, and an app's own window, whatever it shows.
        assert!(!is_notification_window(
            "Shell_TrayWnd",
            Some("explorer.exe")
        ));
        assert!(!is_notification_window(
            "Chrome_WidgetWin_1",
            Some("WhatsApp.exe")
        ));
        // The host's other kinds of window are its helpers, not notifications.
        assert!(!is_notification_window(
            "Xaml_WindowedPopupClass",
            Some("ShellExperienceHost.exe")
        ));
        // A core window whose program can't be named is taken for one: more is greyed out and
        // flagged rather than less.
        assert!(is_notification_window(core, None));
        assert!(!is_notification_window("Chrome_WidgetWin_1", None));
    }

    #[test]
    fn only_a_store_apps_frame_shows_a_hosted_app() {
        use windows::Win32::UI::WindowsAndMessaging::DestroyWindow;
        assert_eq!(hosted_app_name(0), None);
        // An ordinary window, of this test's own process.
        let (window, _) = hidden_window();
        assert_eq!(hosted_app_name(window.0 as isize), None);
        // SAFETY: destroys the window this thread created above.
        let _ = unsafe { DestroyWindow(window) };
    }

    #[test]
    fn a_packaged_app_is_named_as_windows_lists_it() {
        // The test runner isn't a packaged app.
        assert_eq!(app_user_model_id(own_process_id()), None);
        assert_eq!(app_user_model_id(0), None);
        // Settings is part of Windows 11; its name is in the user's language.
        let settings = app_display_name(
            "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
        );
        assert!(settings.is_some_and(|name| !name.trim().is_empty()));
        assert_eq!(app_display_name("Amluto.NoSuchApp_0000000000000!App"), None);
        assert_eq!(app_display_name(""), None);
    }

    #[test]
    fn com_outlasts_a_thread_that_had_it_up_while_an_app_was_named() {
        use std::sync::mpsc::channel;
        use windows::Win32::System::Com::{
            APTTYPE, APTTYPEQUALIFIER, COINIT_MULTITHREADED, CoGetApartmentType, CoInitializeEx,
            CoUninitialize,
        };
        const SETTINGS: &str =
            "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";
        // Another thread has COM's multithreaded apartment up while an app is named here (#133)...
        let (joined, in_com) = channel();
        let (leave, told_to_leave) = channel::<()>();
        let other = std::thread::spawn(move || {
            // SAFETY: sets up COM on this thread, undone below.
            let set_up = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            let _ = joined.send(());
            let _ = told_to_leave.recv();
            if set_up {
                // SAFETY: balances the call above, on the same thread, with no COM object left.
                unsafe { CoUninitialize() };
            }
        });
        in_com.recv().expect("the other thread is in COM");
        assert!(app_display_name(SETTINGS).is_some());
        leave.send(()).expect("the other thread is waiting");
        other.join().expect("the other thread leaves COM");
        // ...and when it leaves, the apartment is still there, so the WinRT factory the lookup
        // cached isn't unloaded under it.
        let mut kind = APTTYPE::default();
        let mut qualifier = APTTYPEQUALIFIER::default();
        // SAFETY: two out-parameters that live for the call.
        let alive = unsafe { CoGetApartmentType(&raw mut kind, &raw mut qualifier) }.is_ok();
        assert!(alive, "COM's multithreaded apartment was torn down");
        assert!(app_display_name(SETTINGS).is_some());
    }

    /// The check on a real desktop: open Calculator or Settings, then run it. It prints each store
    /// app's frame (on screen or not) with the app it shows, and how long that took.
    #[test]
    #[ignore = "needs a store app open: cargo test -p capture-win32 store_apps_open -- --ignored --nocapture"]
    fn store_apps_open_are_named_by_the_app_they_show() {
        let class: Vec<u16> = FRAME_CLASS
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut frames = Vec::new();
        let mut after: Option<HWND> = None;
        // SAFETY: `class` is NUL-terminated UTF-16 that outlives each call; `after` is the
        // previous frame found.
        while let Ok(next) = unsafe {
            FindWindowExW(
                None,
                after,
                windows::core::PCWSTR(class.as_ptr()),
                windows::core::PCWSTR::null(),
            )
        } {
            frames.push(next);
            after = Some(next);
        }
        let named: Vec<String> = frames
            .into_iter()
            .filter(|&frame| !window_title(frame).is_empty())
            .filter_map(|frame| {
                let started = Instant::now();
                let name = hosted_app_name(frame.0 as isize);
                println!(
                    "{:?} {:?} shown {} -> {name:?} in {:?}",
                    frame,
                    window_title(frame),
                    is_shown(frame),
                    started.elapsed()
                );
                name
            })
            .collect();
        assert!(!named.is_empty(), "no store app's frame named");
    }

    #[test]
    fn exe_name_takes_the_last_path_segment() {
        let info = WindowInfo {
            hwnd: 0,
            pid: 0,
            title: String::new(),
            exe_path: Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".into()),
            frame: Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        assert_eq!(info.exe_name(), Some("chrome.exe"));
    }
}
