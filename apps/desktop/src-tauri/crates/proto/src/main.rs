//! Phase 1 capture prototype (docs/spec/02-capture.md, Phase 1): `prototype.rs`. It drives
//! Windows itself, so elsewhere it only says so.
#![forbid(unsafe_code)]

#[cfg(windows)]
mod prototype;

#[cfg(windows)]
fn main() {
    prototype::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The capture prototype runs on Windows only.");
}
