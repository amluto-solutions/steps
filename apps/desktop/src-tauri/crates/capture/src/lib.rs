//! Click pipeline, element lookups, screenshots and screen-to-image coordinate conversion
//! (docs/spec/02-capture.md). Operating system calls live in the platform crate, reached as
//! [`platform`]: `capture-win32` on Windows, `capture-x11` on Linux. This crate is safe Rust.
#![forbid(unsafe_code)]

/// The operating system layer: the same modules and functions on each platform.
#[cfg(windows)]
pub use capture_win32 as platform;
/// The operating system layer: the same modules and functions on each platform.
#[cfg(target_os = "linux")]
pub use capture_x11 as platform;

pub mod coords;
/// Text dictated into a text box, found by reading it (#91).
mod dictation;
mod draw;
mod excel;
/// Which programs and windows are an excluded app's, for clicks and screenshots alike.
mod exclusions;
pub mod facts;
pub mod keys;
pub mod lookup;
/// The menus open on screen and their items, read as each opened (Windows only, for now).
pub mod menus;
pub mod navigation;
pub mod pipeline;
/// The element under a resting pointer, read before the click (Windows only, for now).
#[cfg(windows)]
mod pre_read;
mod programs;
pub mod queued_sink;
pub mod screen_text;
pub mod screenshot;
pub mod secrets;
pub mod sensitive;
pub mod state_machine;
pub mod switches;
pub mod terminal;
pub mod typing;
/// Element lookups: UI Automation on Windows (`uia.rs`), AT-SPI on Linux (`atspi.rs`), behind
/// the same `UiaClient`.
#[cfg(windows)]
pub mod uia;
#[cfg(target_os = "linux")]
#[path = "atspi.rs"]
pub mod uia;
