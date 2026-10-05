//! The only crate in the workspace allowed `unsafe` (docs/engineering.md#rust).
//!
//! It wraps the Win32 calls the recorder needs in small safe functions:
//! - [`input`]: the input thread: the mouse source (Raw Input, or the hook as a fallback),
//!   touch screens and pens (their taps, from the digitizer's reports: `touch` and `taps`),
//!   foreground changes and (only for a recording that asked for it) the keyboard, feeding
//!   bounded queues. The callbacks only copy the event and return
//!   (docs/spec/02-capture.md#on-each-click).
//! - [`keyboard`]: what a key types in the layout of the window it went to.
//! - [`window`]: which top-level window and process is under a point or in front, whether it's
//!   elevated, and which windows are showing (so excluded apps can be blacked out).
//! - [`display`]: DPI awareness, monitor bounds and scale, cursor position, last-input tick,
//!   and whether the normal desktop is showing (not the lock screen or a UAC prompt).
//! - [`pipe`]: the named pipe between Steps for Chrome and Edge and the app, open to this person's
//!   own account only.
//! - [`startup`]: Start with Windows in the Store package (the `WinRT` `StartupTask`; no `unsafe`).
//! - `inject` (feature `test-driver` only): synthetic input for the Phase 1 test driver.
//!
//! Every `unsafe` block carries a `// SAFETY:` comment. Every callback catches panics so none
//! can cross into Windows. Changes here go through the FFI review checklist.
//!
//! Linux has `capture-x11` in its place; this crate is empty there.
#![cfg(windows)]

pub mod cloud;
pub mod display;
mod error;
pub mod input;
pub mod keyboard;
pub mod mail;
pub mod ocr;
pub mod pipe;
pub mod startup;
mod taps;
mod touch;
pub mod window;

#[cfg(feature = "test-driver")]
pub mod inject;

pub use error::{Error, Result};

/// The MSIX package this process runs in (e.g. from the Microsoft Store), or `None` when it
/// runs unpackaged (backup installers, development builds).
#[must_use]
pub fn package_full_name() -> Option<String> {
    let mut length = 0u32;
    // SAFETY: a null buffer asks only for the required length, written to a local.
    let _ = unsafe {
        windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName(&raw mut length, None)
    };
    if length == 0 {
        return None;
    }
    let mut buffer = vec![0u16; usize::try_from(length).ok()?];
    // SAFETY: `buffer` holds `length` u16s, which is what the call was told it may write.
    let result = unsafe {
        windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName(
            &raw mut length,
            Some(windows::core::PWSTR(buffer.as_mut_ptr())),
        )
    };
    if result.is_err() {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// A rectangle in physical screen pixels (virtual-screen space). `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    #[must_use]
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    #[must_use]
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

impl From<windows::Win32::Foundation::RECT> for Rect {
    fn from(rect: windows::Win32::Foundation::RECT) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}
