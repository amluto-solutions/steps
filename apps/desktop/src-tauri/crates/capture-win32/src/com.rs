//! COM's multithreaded apartment, kept for the life of the process (#133).
//!
//! A `WinRT` call on a thread that never set COM up runs in the multithreaded apartment while
//! any other thread has it up, and the `windows` crate then caches the class's factory for good.
//! It takes a hold on the apartment itself only when no thread had COM up. When the last thread
//! leaves, Windows tears the apartment down and can unload the DLLs it loaded, so a call under
//! way, or the cached factory later, reads freed memory: a crash seen in this crate's tests. One
//! hold, never given back, stops the apartment being torn down. In the app, `WebView2` keeps COM
//! up on the main thread anyway; this makes every caller as safe without relying on that.

use std::sync::Once;

use windows::Win32::System::Com::CoIncrementMTAUsage;

/// Keeps the multithreaded apartment for the rest of the process. Call it before any `WinRT`
/// call; only the first call does anything.
pub(crate) fn keep_multithreaded_apartment() {
    static KEPT: Once = Once::new();
    KEPT.call_once(|| {
        // SAFETY: takes a hold on the multithreaded apartment, creating it if needed. The cookie
        // that would give the hold back is dropped on purpose, so the apartment lasts as long as
        // the process. If the call fails, callers are no worse off than without it.
        drop(unsafe { CoIncrementMTAUsage() });
    });
}
