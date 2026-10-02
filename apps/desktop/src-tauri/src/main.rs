// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

fn main() {
    // Started by Chrome or Edge for Steps for Chrome: only pass messages on, then exit
    // (src/browser_link/host.rs).
    if amluto_steps_lib::browser_link::host::started_by_browser() {
        std::process::exit(amluto_steps_lib::browser_link::host::relay());
    }
    amluto_steps_lib::run();
}
