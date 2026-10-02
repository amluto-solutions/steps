//! What a key types, in the keyboard layout of the window it went to
//! (docs/spec/02-capture.md#keys).
//!
//! The input thread only copies key events. The capture worker keeps its own record of which
//! modifiers are down, and asks here for the character with that state, so nothing depends on the
//! worker thread's own (unused) keyboard state.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, GetKeyboardLayout, ToUnicodeEx, VK_CAPITAL, VK_CONTROL, VK_LCONTROL, VK_LMENU,
    VK_LSHIFT, VK_MENU, VK_RCONTROL, VK_RMENU, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

/// The modifiers held when a key went down.
#[allow(
    clippy::struct_excessive_bools,
    reason = "each is a separate key, held or not"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub left_ctrl: bool,
    pub right_ctrl: bool,
    pub left_alt: bool,
    /// On many European layouts this is `AltGr`, which types characters rather than a shortcut.
    pub right_alt: bool,
    pub win: bool,
    pub caps_lock: bool,
}

/// `ToUnicodeEx` flag: leave the keyboard state alone (Windows 10 1607 and later), so asking
/// what a key types doesn't eat a dead key the person is in the middle of.
const NO_STATE_CHANGE: u32 = 0x4;

const DOWN: u8 = 0x80;

/// The characters `vkey` types in `window`'s keyboard layout with `modifiers` held, or `None`
/// for keys that type nothing (arrows, function keys) or only control characters (Ctrl+C).
#[must_use]
pub fn typed_text(vkey: u16, scan: u16, modifiers: Modifiers, window: isize) -> Option<String> {
    let mut state = [0u8; 256];
    let mut set = |key: u16, on: bool| {
        if on {
            state[usize::from(key)] = DOWN;
        }
    };
    set(VK_SHIFT.0, modifiers.shift);
    set(VK_LSHIFT.0, modifiers.shift);
    set(VK_CONTROL.0, modifiers.left_ctrl || modifiers.right_ctrl);
    set(VK_LCONTROL.0, modifiers.left_ctrl);
    set(VK_RCONTROL.0, modifiers.right_ctrl);
    set(VK_MENU.0, modifiers.left_alt || modifiers.right_alt);
    set(VK_LMENU.0, modifiers.left_alt);
    set(VK_RMENU.0, modifiers.right_alt);
    if modifiers.caps_lock {
        state[usize::from(VK_CAPITAL.0)] = 0x01;
    }

    // SAFETY: a null process-id pointer asks only for the thread id; an invalid window gives 0,
    // and GetKeyboardLayout(0) is this thread's layout, a reasonable fallback.
    let thread = unsafe { GetWindowThreadProcessId(HWND(window as *mut _), None) };
    // SAFETY: no pointers; returns the layout handle of that thread.
    let layout = unsafe { GetKeyboardLayout(thread) };
    let mut buffer = [0u16; 8];
    // SAFETY: `state` is 256 bytes and `buffer` is a local array whose length the call is given.
    let count = unsafe {
        ToUnicodeEx(
            u32::from(vkey),
            u32::from(scan),
            &state,
            &mut buffer,
            NO_STATE_CHANGE,
            Some(layout),
        )
    };
    let count = usize::try_from(count).ok().filter(|count| *count > 0)?;
    let text: String = String::from_utf16_lossy(&buffer[..count.min(buffer.len())])
        .chars()
        .filter(|ch| !ch.is_control())
        .collect();
    (!text.is_empty()).then_some(text)
}

/// Whether Caps Lock is on now. Read when keys are first registered; the worker follows the
/// Caps Lock key itself after that.
#[must_use]
pub fn caps_lock_on() -> bool {
    // SAFETY: no pointers; the low bit is the toggle state.
    unsafe { GetKeyState(i32::from(VK_CAPITAL.0)) & 1 == 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worker's own keyboard layout (no window): US and UK layouts agree on these.
    #[test]
    fn letters_and_shifted_letters_type_themselves() {
        let a = typed_text(0x41, 0x1E, Modifiers::default(), 0);
        assert_eq!(a.as_deref(), Some("a"));
        let shifted = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        assert_eq!(typed_text(0x41, 0x1E, shifted, 0).as_deref(), Some("A"));
        let caps = Modifiers {
            caps_lock: true,
            ..Modifiers::default()
        };
        assert_eq!(typed_text(0x41, 0x1E, caps, 0).as_deref(), Some("A"));
    }

    #[test]
    fn control_combinations_and_arrows_type_nothing() {
        let ctrl = Modifiers {
            left_ctrl: true,
            ..Modifiers::default()
        };
        assert_eq!(typed_text(0x43, 0x2E, ctrl, 0), None, "Ctrl+C");
        assert_eq!(
            typed_text(0x25, 0x4B, Modifiers::default(), 0),
            None,
            "Left"
        );
        assert_eq!(typed_text(0x70, 0x3B, Modifiers::default(), 0), None, "F1");
    }
}
