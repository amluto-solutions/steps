//! The clipboard's text, read when a paste is typed into a recording (docs/spec/02-capture.md#keys):
//! Ctrl+V puts text into a document as typing does, so the step says what went in.

use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::core::w;

/// The clipboard's text, at most `max_chars` of it, or `None` when it holds none (or another app
/// has it open).
#[must_use]
pub fn text(max_chars: usize) -> Option<String> {
    // Password managers (KeePass, Bitwarden, 1Password) mark what they copy as not for clipboard
    // watchers or history: a password pasted from one is never read.
    for marker in [
        w!("ExcludeClipboardContentFromMonitorProcessing"),
        w!("Clipboard Viewer Ignore"),
    ] {
        // SAFETY: a constant, NUL-terminated format name; registering only returns its id.
        let format = unsafe { RegisterClipboardFormatW(marker) };
        // SAFETY: a plain format id; works whether or not the clipboard is open.
        if format != 0 && unsafe { IsClipboardFormatAvailable(format) }.is_ok() {
            return None;
        }
    }
    // SAFETY: no owner window; closed below on every path once opened.
    unsafe { OpenClipboard(None) }.ok()?;
    let read = || -> Option<String> {
        // SAFETY: the clipboard is open; the handle belongs to the clipboard and isn't freed here.
        let handle: HANDLE = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT.0)) }.ok()?;
        let global = HGLOBAL(handle.0);
        // SAFETY: `global` is the clipboard's memory, locked for the read and unlocked after.
        let pointer = unsafe { GlobalLock(global) }.cast::<u16>();
        if pointer.is_null() {
            return None;
        }
        // SAFETY: the block holds `GlobalSize` bytes of NUL-terminated UTF-16.
        let units = unsafe { GlobalSize(global) } / 2;
        // SAFETY: `pointer` points at `units` readable u16s while locked.
        let slice = unsafe { std::slice::from_raw_parts(pointer, units) };
        let end = slice
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(slice.len());
        let text = String::from_utf16_lossy(&slice[..end]);
        // SAFETY: unlocks what GlobalLock locked.
        let _ = unsafe { GlobalUnlock(global) };
        Some(text.chars().take(max_chars).collect())
    };
    let text = read();
    // SAFETY: closes the clipboard opened above.
    let _ = unsafe { CloseClipboard() };
    text
}
