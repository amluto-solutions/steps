//! The prototype's test driver (`../driver.rs`). Windows only.
#![forbid(unsafe_code)]

#[cfg(windows)]
#[path = "../driver.rs"]
mod driver;

#[cfg(windows)]
fn main() {
    driver::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The prototype's test driver runs on Windows only.");
}
