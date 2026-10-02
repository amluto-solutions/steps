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
pub mod facts;
pub mod keys;
pub mod lookup;
pub mod navigation;
pub mod pipeline;
pub mod screen_text;
pub mod screenshot;
pub mod secrets;
pub mod sensitive;
pub mod state_machine;
pub mod terminal;
pub mod typing;
/// Element lookups: UI Automation on Windows (`uia.rs`), AT-SPI on Linux (`atspi.rs`), behind
/// the same `UiaClient`.
#[cfg(windows)]
pub mod uia;
#[cfg(target_os = "linux")]
#[path = "atspi.rs"]
pub mod uia;
