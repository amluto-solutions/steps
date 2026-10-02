//! What a key types, in the current keyboard layout (docs/spec/02-capture.md#keys).
//!
//! Keys arrive from the input thread as X key codes, carried in [`KeyEvent::scan`], with the
//! Windows virtual-key code for the same key in [`KeyEvent::vkey`], so the key reader in
//! `capture` (which knows Enter, Backspace and the modifiers by their Windows codes) works the
//! same on both platforms. The character comes from the server's keyboard mapping.
//!
//! [`KeyEvent::scan`]: crate::input::KeyEvent::scan
//! [`KeyEvent::vkey`]: crate::input::KeyEvent::vkey

use std::sync::RwLock;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::ConnectionExt as _;
use xkeysym::Keysym;

use crate::connection::shared;

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
    /// `AltGr` on most European layouts (`ISO_Level3_Shift`), which types characters.
    pub right_alt: bool,
    /// The Super ("Windows") key.
    pub win: bool,
    pub caps_lock: bool,
}

/// The server's key code → keysyms table.
#[derive(Debug, Clone)]
struct Mapping {
    min_keycode: u8,
    per_keycode: usize,
    keysyms: Vec<u32>,
}

impl Mapping {
    fn read() -> Option<Self> {
        let display = shared()?;
        let setup = display.connection.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = display
            .connection
            .get_keyboard_mapping(min, max - min + 1)
            .ok()?
            .reply()
            .ok()?;
        Some(Self {
            min_keycode: min,
            per_keycode: usize::from(reply.keysyms_per_keycode),
            keysyms: reply.keysyms,
        })
    }

    /// The keysym at `level` for `keycode`: 0 plain, 1 shifted, 4 and 5 with `AltGr` (the core
    /// protocol's view of group 1, levels 3 and 4).
    fn keysym(&self, keycode: u8, level: usize) -> Option<u32> {
        let row = usize::from(keycode.checked_sub(self.min_keycode)?);
        let at = |index: usize| {
            (index < self.per_keycode)
                .then(|| self.keysyms.get(row * self.per_keycode + index).copied())
                .flatten()
                .filter(|&keysym| keysym != 0)
        };
        // An unshifted-only key repeats its keysym for the shifted level, as Xlib does.
        at(level).or_else(|| (level == 1).then(|| at(0)).flatten())
    }
}

static MAPPING: RwLock<Option<Mapping>> = RwLock::new(None);

fn with_mapping<T>(read: impl FnOnce(&Mapping) -> Option<T>) -> Option<T> {
    if let Ok(guard) = MAPPING.read()
        && let Some(mapping) = guard.as_ref()
    {
        return read(mapping);
    }
    let mapping = Mapping::read()?;
    let result = read(&mapping);
    if let Ok(mut guard) = MAPPING.write() {
        *guard = Some(mapping);
    }
    result
}

/// Forgets the keyboard mapping, after the server says it changed (another layout chosen).
pub(crate) fn mapping_changed() {
    if let Ok(mut guard) = MAPPING.write() {
        *guard = None;
    }
}

/// The plain (unshifted) keysym of a key code.
pub(crate) fn base_keysym(keycode: u8) -> Option<u32> {
    with_mapping(|mapping| mapping.keysym(keycode, 0))
}

fn is_letter(keysym: u32) -> bool {
    Keysym::new(keysym)
        .key_char()
        .is_some_and(char::is_alphabetic)
}

/// The characters the key with X key code `scan` types with `modifiers` held, or `None` for keys
/// that type nothing (arrows, function keys) and for shortcuts (Ctrl, Alt or Super held).
/// `vkey` and `window` are unused: X has one layout for the whole screen.
#[must_use]
pub fn typed_text(_vkey: u16, scan: u16, modifiers: Modifiers, _window: isize) -> Option<String> {
    if modifiers.left_ctrl || modifiers.right_ctrl || modifiers.left_alt || modifiers.win {
        return None;
    }
    let keycode = u8::try_from(scan).ok()?;
    let character = with_mapping(|mapping| {
        let plain = mapping.keysym(keycode, 0)?;
        // Caps Lock shifts letters only, as it does on Windows.
        let shifted = modifiers.shift ^ (modifiers.caps_lock && is_letter(plain));
        let level = match (modifiers.right_alt, shifted) {
            (false, false) => 0,
            (false, true) => 1,
            (true, false) => 4,
            (true, true) => 5,
        };
        let keysym = mapping
            .keysym(keycode, level)
            .or_else(|| mapping.keysym(keycode, level % 2))?;
        Keysym::new(keysym).key_char()
    })?;
    (!character.is_control()).then(|| character.to_string())
}

/// Whether Caps Lock is on now (its keyboard light). Read when keys are first registered; the
/// key reader follows the Caps Lock key itself after that.
#[must_use]
pub fn caps_lock_on() -> bool {
    shared()
        .and_then(|display| display.connection.get_keyboard_control().ok())
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|control| control.led_mask & 1 == 1)
}

/// The Windows virtual-key code for a keysym, so shortcut names and the key reader's rules are
/// the same on both platforms. `extended` is Windows' E0 prefix: the right-hand Ctrl and Alt,
/// the arrow and editing keys, keypad Enter.
#[must_use]
pub(crate) fn virtual_key(keysym: u32) -> (u16, bool) {
    // Letters and digits: Windows uses their capital ASCII codes. Only Latin-1 keysyms: the
    // keypad's digits have keysyms of their own, and Windows codes of their own too.
    if keysym < 0x100
        && let Some(character) = Keysym::new(keysym).key_char()
    {
        if character.is_ascii_alphabetic() {
            return (u16::from(character.to_ascii_uppercase() as u8), false);
        }
        if character.is_ascii_digit() {
            return (u16::from(character as u8), false);
        }
    }
    match keysym {
        0xff08 => (0x08, false),          // BackSpace
        0xff09 | 0xfe20 => (0x09, false), // Tab, ISO_Left_Tab (Shift+Tab)
        0xff0d => (0x0D, false),          // Return
        0xff8d => (0x0D, true),           // KP_Enter
        0xff13 => (0x13, false),          // Pause
        0xffe5 => (0x14, false),          // Caps_Lock
        0xff1b => (0x1B, false),          // Escape
        0x0020 => (0x20, false),          // space
        0xff55 => (0x21, true),           // Prior (Page Up)
        0xff56 => (0x22, true),           // Next (Page Down)
        0xff57 => (0x23, true),           // End
        0xff50 => (0x24, true),           // Home
        0xff51 => (0x25, true),           // Left
        0xff52 => (0x26, true),           // Up
        0xff53 => (0x27, true),           // Right
        0xff54 => (0x28, true),           // Down
        0xff61 => (0x2C, true),           // Print
        0xff63 => (0x2D, true),           // Insert
        0xffff => (0x2E, true),           // Delete
        0xffeb => (0x5B, false),          // Super_L
        0xffec => (0x5C, true),           // Super_R
        0xff67 => (0x5D, true),           // Menu
        0xffe1 => (0xA0, false),          // Shift_L
        0xffe2 => (0xA1, false),          // Shift_R
        0xffe3 => (0xA2, false),          // Control_L
        0xffe4 => (0xA3, true),           // Control_R
        0xffe9 => (0xA4, false),          // Alt_L
        0xffea | 0xfe03 => (0xA5, true),  // Alt_R, ISO_Level3_Shift (AltGr)
        0x003b => (0xBA, false),          // semicolon
        0x003d => (0xBB, false),          // equal
        0x002c => (0xBC, false),          // comma
        0x002d => (0xBD, false),          // minus
        0x002e => (0xBE, false),          // period
        0x002f => (0xBF, false),          // slash
        0x0060 => (0xC0, false),          // grave
        0x005b => (0xDB, false),          // bracketleft
        0x005c => (0xDC, false),          // backslash
        0x005d => (0xDD, false),          // bracketright
        0x0027 => (0xDE, false),          // apostrophe
        0xffb0..=0xffb9 => (0x60 + u16::try_from(keysym - 0xffb0).unwrap_or(0), false), // KP_0–9
        0xffaa => (0x6A, false),          // KP_Multiply
        0xffab => (0x6B, false),          // KP_Add
        0xffad => (0x6D, false),          // KP_Subtract
        0xffae => (0x6E, false),          // KP_Decimal
        0xffaf => (0x6F, true),           // KP_Divide
        0xffbe..=0xffd5 => (0x70 + u16::try_from(keysym - 0xffbe).unwrap_or(0), false), // F1–F24
        _ => (0, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_carry_their_windows_codes() {
        assert_eq!(virtual_key(u32::from(b'a')), (0x41, false));
        assert_eq!(virtual_key(u32::from(b'Z')), (0x5A, false));
        assert_eq!(virtual_key(u32::from(b'7')), (0x37, false));
        assert_eq!(virtual_key(0xff0d), (0x0D, false));
        assert_eq!(virtual_key(0xffe4), (0xA3, true));
        assert_eq!(virtual_key(0xfe03), (0xA5, true));
        assert_eq!(virtual_key(0xffbe), (0x70, false)); // F1
        assert_eq!(virtual_key(0xffc9), (0x7B, false)); // F12
        assert_eq!(virtual_key(0xffb3), (0x63, false)); // KP_3
        assert_eq!(virtual_key(0x1234_5678), (0, false));
    }

    #[test]
    fn a_mapping_finds_each_level() {
        // Key code 38 types a/A, and æ/Æ with AltGr.
        let mapping = Mapping {
            min_keycode: 8,
            per_keycode: 6,
            keysyms: {
                let mut table = vec![0; 6 * 40];
                let row = (38 - 8) * 6;
                table[row..row + 6].copy_from_slice(&[0x61, 0x41, 0x61, 0x41, 0xe6, 0xc6]);
                table
            },
        };
        assert_eq!(mapping.keysym(38, 0), Some(0x61));
        assert_eq!(mapping.keysym(38, 1), Some(0x41));
        assert_eq!(mapping.keysym(38, 4), Some(0xe6));
        assert_eq!(mapping.keysym(38, 5), Some(0xc6));
        assert_eq!(mapping.keysym(7, 0), None);
        assert!(is_letter(0x61));
        assert!(!is_letter(0x31));
    }
}
