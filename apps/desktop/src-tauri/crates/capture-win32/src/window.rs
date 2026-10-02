//! Which top-level window and process is under a point or in front, and whether it runs
//! elevated. From a normal process, an elevated window reads as `Elevated`: the token query needs
//! only limited rights (checked in Phase 1 with Task Manager).

use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GA_ROOT, GA_ROOTOWNER, GWL_EXSTYLE, GetAncestor, GetForegroundWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WindowFromPoint,
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

/// The top-level window at a physical point, or `None` over the desktop background with no window.
#[must_use]
pub fn root_window_at(x: i32, y: i32) -> Option<WindowInfo> {
    // SAFETY: POINT by value; returns a null handle when there is no window.
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.is_invalid() {
        return None;
    }
    // SAFETY: `hwnd` came from WindowFromPoint; GetAncestor tolerates stale handles by returning null.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let root = if root.is_invalid() { hwnd } else { root };
    Some(info_for(root))
}

/// The process that owns the window at a point, following owners as well as parents: a popup
/// (a drop-down list, a context menu) is its own top-level window, but belongs to the window that
/// opened it. `None` over the bare desktop.
#[must_use]
pub fn owner_process_at(x: i32, y: i32) -> Option<u32> {
    // SAFETY: POINT by value; returns a null handle when there is no window.
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
    if hwnd.is_invalid() {
        return None;
    }
    // SAFETY: `hwnd` came from WindowFromPoint; GetAncestor tolerates stale handles by returning null.
    let owner = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    let owner = if owner.is_invalid() { hwnd } else { owner };
    let mut pid = 0u32;
    // SAFETY: out-pointer to a local.
    unsafe { GetWindowThreadProcessId(owner, Some(&raw mut pid)) };
    (pid != 0).then_some(pid)
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
    pub pid: u32,
    /// Visible frame in physical pixels.
    pub frame: Rect,
    /// Click-through or layered (drawn with transparency), so what is behind it may show through.
    pub see_through: bool,
}

/// Every top-level window that is showing, front to back: visible, not minimised, not cloaked
/// (a window on another virtual desktop or a suspended store app is visible to Windows but not
/// on screen), and not empty.
#[must_use]
pub fn shown_windows() -> Vec<ShownWindow> {
    shown_handles()
        .into_iter()
        .filter_map(|hwnd| {
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
            Some(ShownWindow {
                pid,
                frame,
                see_through: style & see_through_bits != 0,
            })
        })
        .collect()
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

fn ex_style(hwnd: HWND) -> isize {
    // SAFETY: reads a style value of a window handle; 0 for a closed window.
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
}

/// Whether another copy of Steps is running (the installed one, the Store's or a portable
/// one: every Steps program is `amluto-steps…exe`), so a shortcut Windows refused can be put
/// down to it rather than to "another app". Hidden windows count: Steps may be in the tray.
#[must_use]
pub fn other_steps_running() -> bool {
    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        // SAFETY: `found` is the `&mut Vec<HWND>` passed to EnumWindows below, which outlives the
        // enumeration; this callback runs synchronously on the same thread.
        let list = unsafe { &mut *(found.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL(1)
    }
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `handles`, which lives until EnumWindows returns.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM((&raw mut handles) as isize)) };
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
    unsafe extern "system" fn collect(hwnd: HWND, found: LPARAM) -> BOOL {
        // SAFETY: `found` is the `&mut Vec<HWND>` passed to EnumWindows below, which outlives the
        // enumeration; this callback runs synchronously on the same thread.
        let list = unsafe { &mut *(found.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL(1)
    }
    let mut handles: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `handles`, which lives until EnumWindows returns.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM((&raw mut handles) as isize)) };
    handles
        .into_iter()
        .filter(|&hwnd| {
            // SAFETY: handles from EnumWindows; both calls tolerate a window closed since.
            unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() }
        })
        .filter(|&hwnd| !cloaked(hwnd))
        .collect()
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

    WindowInfo {
        hwnd: root.0 as isize,
        pid,
        title: window_title(root),
        exe_path: process_path(pid),
        frame: frame_bounds(root),
        elevation: process_elevation(pid),
    }
}

/// A top-level window's class name (`ConsoleWindowClass`, `XLMAIN`), or `None` for a window that
/// has closed. Terminals and Excel are recognised by it.
#[must_use]
pub fn window_class(hwnd: isize) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buffer = [0u16; 256];
    // SAFETY: the slice is a valid writable buffer; the call writes at most its length, and
    // returns 0 for a stale handle.
    let length = unsafe { GetClassNameW(HWND(hwnd as *mut c_void), &mut buffer) };
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
    fn exe_name_takes_the_last_path_segment() {
        let info = WindowInfo {
            hwnd: 0,
            pid: 0,
            title: String::new(),
            exe_path: Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".into()),
            frame: Rect::default(),
            elevation: Elevation::NotElevated,
        };
        assert_eq!(info.exe_name(), Some("chrome.exe"));
    }
}
