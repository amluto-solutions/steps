//! DPI awareness, monitors, the cursor and the last-input tick.

use std::collections::HashMap;

use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo,
    GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    MONITORINFOEXW, MonitorFromPoint,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForMonitor, MDT_EFFECTIVE_DPI,
    SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetDoubleClickTime, GetLastInputInfo, LASTINPUTINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, MONITORINFOF_PRIMARY, SM_CXDOUBLECLK, SM_CYDOUBLECLK,
};
use windows::core::BOOL;

use crate::Rect;

/// Makes the process Per-Monitor-V2 DPI aware, so the hook, UIA and screenshots all report
/// physical pixels (docs/spec/02-capture.md#coordinates-and-dpi).
///
/// Returns `false` if the awareness was already fixed (e.g. by the app manifest), which is fine
/// when that manifest already asks for Per-Monitor-V2.
#[must_use]
pub fn enable_per_monitor_dpi_awareness() -> bool {
    // SAFETY: plain call with a predefined constant; it can only fail, not corrupt state.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.is_ok()
}

/// The monitor under a point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorInfo {
    /// Whole monitor, physical pixels.
    pub rect: Rect,
    /// Effective DPI (96 = 100%).
    pub dpi: u32,
    /// `dpi / 96`, e.g. 1.5 for 150%.
    pub scale: f32,
}

/// The monitor nearest to a physical point.
#[must_use]
pub fn monitor_at(x: i32, y: i32) -> Option<MonitorInfo> {
    // SAFETY: MonitorFromPoint takes a POINT by value and a flag; with NEAREST it never returns null.
    let monitor = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };

    let mut info = MONITORINFO {
        cbSize: u32::try_from(std::mem::size_of::<MONITORINFO>()).ok()?,
        ..MONITORINFO::default()
    };
    // SAFETY: `info` is a correctly sized MONITORINFO owned by this frame.
    if !unsafe { GetMonitorInfoW(monitor, &raw mut info) }.as_bool() {
        return None;
    }

    let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
    // SAFETY: both out-pointers point at locals that outlive the call.
    let dpi =
        if unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &raw mut dpi_x, &raw mut dpi_y) }
            .is_ok()
        {
            dpi_x
        } else {
            96
        };

    #[allow(clippy::cast_precision_loss, reason = "DPI values are small integers")]
    let scale = dpi as f32 / 96.0;
    Some(MonitorInfo {
        rect: info.rcMonitor.into(),
        dpi,
        scale,
    })
}

/// A connected screen as Windows Settings names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenDetail {
    /// Physical pixels.
    pub rect: Rect,
    /// The main display, where the taskbar's clock and new windows go.
    pub primary: bool,
    /// The monitor's own name ("DELL U2720Q"), when it gives one. Windows' device name
    /// ("\\.\DISPLAY2") is never used: it means nothing to a person.
    pub name: Option<String>,
}

/// Every connected screen, with its name and whether it's the main one.
#[must_use]
pub fn screens() -> Vec<ScreenDetail> {
    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        found: LPARAM,
    ) -> BOOL {
        // SAFETY: `found` is the `&mut Vec` passed to EnumDisplayMonitors below, which outlives
        // the enumeration; this callback runs synchronously on the same thread.
        let list = unsafe { &mut *(found.0 as *mut Vec<(Rect, bool, String)>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = u32::try_from(std::mem::size_of::<MONITORINFOEXW>()).unwrap_or(0);
        // SAFETY: `info` is a correctly sized MONITORINFOEXW owned by this frame; Windows writes
        // the extended form when cbSize says so.
        if unsafe { GetMonitorInfoW(monitor, (&raw mut info).cast::<MONITORINFO>()) }.as_bool() {
            let device = String::from_utf16_lossy(&info.szDevice);
            list.push((
                info.monitorInfo.rcMonitor.into(),
                info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                device.trim_end_matches('\0').to_string(),
            ));
        }
        BOOL(1)
    }
    let mut found: Vec<(Rect, bool, String)> = Vec::new();
    // SAFETY: the callback only pushes into `found`, which lives until the call returns.
    let _ = unsafe {
        EnumDisplayMonitors(None, None, Some(collect), LPARAM((&raw mut found) as isize))
    };
    let names = friendly_names();
    found
        .into_iter()
        .map(|(rect, primary, device)| ScreenDetail {
            rect,
            primary,
            name: names.get(&device).cloned(),
        })
        .collect()
}

/// Each active display's monitor name, by its device name (`\\.\DISPLAY2`), from the display
/// configuration Windows Settings reads.
fn friendly_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    let (mut path_count, mut mode_count) = (0u32, 0u32);
    // SAFETY: two out-pointers to locals.
    if unsafe {
        GetDisplayConfigBufferSizes(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut path_count,
            &raw mut mode_count,
        )
    } != ERROR_SUCCESS
    {
        return names;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    // SAFETY: the buffers hold exactly the counts Windows asked for, and the counts say so.
    if unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut path_count,
            paths.as_mut_ptr(),
            &raw mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
    } != ERROR_SUCCESS
    {
        return names;
    }
    paths.truncate(path_count as usize);
    for path in &paths {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: u32::try_from(std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>())
                    .unwrap_or(0),
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            },
            ..Default::default()
        };
        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                size: u32::try_from(std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>())
                    .unwrap_or(0),
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            },
            ..Default::default()
        };
        // SAFETY: each packet starts with its header, sized for the whole packet.
        let ok = unsafe {
            DisplayConfigGetDeviceInfo(&raw mut source.header) == 0
                && DisplayConfigGetDeviceInfo(&raw mut target.header) == 0
        };
        if !ok {
            continue;
        }
        let device = String::from_utf16_lossy(&source.viewGdiDeviceName);
        let name = String::from_utf16_lossy(&target.monitorFriendlyDeviceName);
        let name = name.trim_end_matches('\0').trim().to_string();
        if !name.is_empty() {
            names.insert(device.trim_end_matches('\0').to_string(), name);
        }
    }
    names
}

/// Current cursor position in physical pixels.
#[must_use]
pub fn cursor_pos() -> Option<(i32, i32)> {
    let mut point = POINT::default();
    // SAFETY: out-pointer to a local.
    unsafe { GetCursorPos(&raw mut point) }.ok()?;
    Some((point.x, point.y))
}

/// Tick count (ms since boot, wrapping) of the last keyboard or mouse input on this session.
#[must_use]
pub fn last_input_tick() -> Option<u32> {
    let mut info = LASTINPUTINFO {
        cbSize: u32::try_from(std::mem::size_of::<LASTINPUTINFO>()).ok()?,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized LASTINPUTINFO owned by this frame.
    if unsafe { GetLastInputInfo(&raw mut info) }.as_bool() {
        Some(info.dwTime)
    } else {
        None
    }
}

/// The user's double-click time (ms) and the size of the double-click rectangle (px).
#[must_use]
pub fn double_click_settings() -> (u32, i32, i32) {
    // SAFETY: these take no pointers and only read system settings.
    unsafe {
        (
            GetDoubleClickTime(),
            GetSystemMetrics(SM_CXDOUBLECLK),
            GetSystemMetrics(SM_CYDOUBLECLK),
        )
    }
}

/// Milliseconds since boot (wrapping), on the same clock as input event times.
#[must_use]
pub fn now_tick() -> u32 {
    // SAFETY: no arguments; reads the system tick count.
    unsafe { windows::Win32::System::SystemInformation::GetTickCount() }
}

/// Whether the normal desktop is the one taking input. It isn't while the lock screen, a UAC
/// prompt or Ctrl+Alt+Del is showing: those run on a separate, secure desktop that nothing can
/// capture, so the recorder pauses (docs/spec/02-capture.md#special-cases).
///
/// From a normal process, opening the secure desktop is refused, which also reads as `false`.
#[must_use]
pub fn input_desktop_is_default() -> bool {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
        OpenInputDesktop, UOI_NAME,
    };

    // SAFETY: asks only for read access; the handle is closed below on every path.
    let Ok(desktop) =
        (unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) })
    else {
        return false;
    };
    let mut name = [0u16; 64];
    let bytes = u32::try_from(std::mem::size_of_val(&name)).unwrap_or(0);
    let mut needed = 0u32;
    // SAFETY: `name` is a writable buffer of `bytes` bytes owned by this frame; `needed` is a local.
    let read = unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            bytes,
            Some(&raw mut needed),
        )
    };
    // SAFETY: closes the desktop handle opened above, exactly once.
    let _ = unsafe { CloseDesktop(desktop) };
    if read.is_err() {
        return false;
    }
    let end = name
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(name.len());
    String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_normal_desktop_is_showing_while_tests_run() {
        // Tests run from an interactive, unlocked session.
        assert!(input_desktop_is_default());
    }
}
