//! The Linux (X11) counterpart of `capture-win32` (docs/spec/02-capture.md#linux-x11-phase-10).
//!
//! It offers the same modules, types and functions, so the capture pipeline and the app reach
//! the operating system the same way on both (`capture::platform`). Everything goes through the
//! X protocol in safe Rust (x11rb's own connection), so unlike `capture-win32` this crate needs no
//! `unsafe`:
//! - [`input`]: the input thread: clicks and (only for a recording that asked for it) keys from
//!   `XInput2`'s raw events, and changes of the active window.
//! - [`keyboard`]: what a key types in the current layout.
//! - [`window`]: windows through EWMH (`_NET_ACTIVE_WINDOW`, `_NET_CLIENT_LIST_STACKING`, …) and
//!   processes through `/proc`.
//! - [`display`]: monitors (`RandR`), the pointer, the idle time (`MIT-SCREEN-SAVER`).
//! - [`screen`]: screenshots (`GetImage` on the root window).
//! - [`ocr`]: Tesseract, when it's installed.
//! - [`mail`], [`cloud`], [`startup`]: what Linux has of these.
//!
//! Wayland sessions have no X server to ask: [`session_is_wayland`] tells the app, which says so.
#![forbid(unsafe_code)]
#![cfg(target_os = "linux")]

pub mod cloud;
mod connection;
pub mod display;
mod error;
pub mod input;
pub mod keyboard;
pub mod mail;
pub mod ocr;
pub mod screen;
pub mod startup;
pub mod window;

pub use error::{Error, Result};

/// Always `None`: Linux has no MSIX packages. Kept so callers read the same on both platforms.
#[must_use]
pub fn package_full_name() -> Option<String> {
    None
}

/// Whether this is a Wayland session, where global clicks and screenshots can't be taken
/// (docs/spec/02-capture.md#linux-x11-phase-10). An X11 app under `XWayland` still reaches an X
/// server, but only its own windows: recording needs an X11 session.
#[must_use]
pub fn session_is_wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind.eq_ignore_ascii_case("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
}

/// Whether an X server can be reached at all (`DISPLAY` set and answering).
#[must_use]
pub fn x_server_available() -> bool {
    connection::shared().is_some()
}

/// A rectangle in screen pixels. `right` and `bottom` are exclusive.
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

    #[must_use]
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}
