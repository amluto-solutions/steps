//! Key events as the recorder uses them (docs/spec/02-capture.md#keys): typed text, the editing
//! keys, Enter, and key combinations. Which modifiers are down is followed here from the events
//! themselves, so it never depends on another thread's keyboard state.

use crate::platform::input::KeyEvent;
use crate::platform::keyboard::Modifiers;

/// What one key press means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    /// Characters, in the layout of the window the key went to.
    Text(String),
    Enter,
    Tab,
    Backspace,
    Delete,
    Escape,
    /// Arrows, Home, End, Page Up and Down: the caret moved, so text typed from here on may not
    /// follow on from what came before.
    Move,
    /// A key pressed with Ctrl, Alt or the Windows key held (not `AltGr` typing a character).
    Combo(Combo),
    /// A key that means nothing here (a function key alone, Caps Lock, a media key).
    Other,
}

/// A key combination. The wording ("Press Ctrl+Shift+N") is made in TypeScript from these.
#[allow(
    clippy::struct_excessive_bools,
    reason = "each is a separate modifier key, held or not"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    pub vkey: u16,
}

impl Combo {
    /// Undo, redo, Alt+Tab and Win+Tab never become steps (docs/spec/02-capture.md#keys): undo
    /// and redo are corrections, and the app a switch lands in is a step of its own. Select all,
    /// copy, cut and paste do: a guide says to press them (04/10/2026: they were left out).
    #[must_use]
    pub fn is_noise(&self) -> bool {
        let only_ctrl = self.ctrl && !self.alt && !self.win;
        let letter = |ch: u8| self.vkey == u16::from(ch);
        // Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y.
        (only_ctrl && (letter(b'Z') || (!self.shift && letter(b'Y'))))
            || (self.alt && !self.ctrl && !self.win && self.vkey == VK_TAB)
            || (self.win && !self.ctrl && !self.alt && self.vkey == VK_TAB)
    }
}

const VK_BACK: u16 = 0x08;
const VK_TAB: u16 = 0x09;
const VK_RETURN: u16 = 0x0D;
const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_CAPITAL: u16 = 0x14;
const VK_ESCAPE: u16 = 0x1B;
const VK_PRIOR: u16 = 0x21;
const VK_DOWN: u16 = 0x28;
const VK_DELETE: u16 = 0x2E;
const VK_LWIN: u16 = 0x5B;
const VK_RWIN: u16 = 0x5C;
const VK_LSHIFT: u16 = 0xA0;
const VK_RMENU: u16 = 0xA5;

/// Follows the modifiers and turns each key press into a [`KeyAction`].
#[derive(Debug, Default)]
pub struct KeyReader {
    modifiers: Modifiers,
}

impl KeyReader {
    #[must_use]
    pub fn new(caps_lock: bool) -> Self {
        Self {
            modifiers: Modifiers {
                caps_lock,
                ..Modifiers::default()
            },
        }
    }

    /// Forgets which modifiers are down: after a pause, their key-ups may have been missed.
    pub fn reset(&mut self) {
        self.modifiers = Modifiers {
            caps_lock: self.modifiers.caps_lock,
            ..Modifiers::default()
        };
    }

    /// The modifiers held now.
    #[must_use]
    pub fn modifiers(&self) -> Modifiers {
        self.modifiers
    }

    /// Reads one event. `typed` says what a key types with the given modifiers in the window it
    /// went to (`crate::platform::keyboard::typed_text`, or a stand-in for tests). Key-ups, and
    /// modifiers on their own, give `None`.
    pub fn read(
        &mut self,
        event: &KeyEvent,
        typed: impl Fn(u16, u16, Modifiers, isize) -> Option<String>,
    ) -> Option<KeyAction> {
        if self.follow_modifier(event) {
            return None;
        }
        if event.up {
            return None;
        }
        let held = self.modifiers;
        let ctrl = held.left_ctrl || held.right_ctrl;
        let alt = held.left_alt || held.right_alt;
        // AltGr is Ctrl+Alt to Windows. If the combination types a character, it is typing.
        let alt_gr = held.right_alt && !held.left_alt;
        if ctrl || alt || held.win {
            if (alt_gr || (ctrl && alt))
                && !held.win
                && let Some(text) = typed(event.vkey, event.scan, held, event.foreground)
            {
                return Some(KeyAction::Text(text));
            }
            return Some(KeyAction::Combo(Combo {
                ctrl,
                alt,
                shift: held.shift,
                win: held.win,
                vkey: event.vkey,
            }));
        }
        Some(match event.vkey {
            VK_RETURN => KeyAction::Enter,
            VK_TAB => KeyAction::Tab,
            VK_BACK => KeyAction::Backspace,
            VK_DELETE => KeyAction::Delete,
            VK_ESCAPE => KeyAction::Escape,
            VK_PRIOR..=VK_DOWN => KeyAction::Move,
            _ => typed(event.vkey, event.scan, held, event.foreground)
                .map_or(KeyAction::Other, KeyAction::Text),
        })
    }

    /// Updates the modifiers from a modifier key's event; `true` if it was one.
    fn follow_modifier(&mut self, event: &KeyEvent) -> bool {
        let down = !event.up;
        let held = &mut self.modifiers;
        match event.vkey {
            VK_SHIFT | VK_LSHIFT | 0xA1 => held.shift = down,
            VK_CONTROL | 0xA2 | 0xA3 => {
                if event.extended || event.vkey == 0xA3 {
                    held.right_ctrl = down;
                } else {
                    held.left_ctrl = down;
                }
            }
            VK_MENU | 0xA4 | VK_RMENU => {
                if event.extended || event.vkey == VK_RMENU {
                    held.right_alt = down;
                } else {
                    held.left_alt = down;
                }
            }
            VK_LWIN | VK_RWIN => held.win = down,
            VK_CAPITAL => {
                if down {
                    held.caps_lock = !held.caps_lock;
                }
            }
            _ => return false,
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(vkey: u16, up: bool) -> KeyEvent {
        KeyEvent {
            tick_ms: 0,
            vkey,
            scan: 0,
            extended: false,
            up,
            injected: true,
            foreground: 1,
        }
    }

    fn extended(vkey: u16, up: bool) -> KeyEvent {
        KeyEvent {
            extended: true,
            ..key(vkey, up)
        }
    }

    /// A US layout, enough for the tests: letters, and AltGr+E as "€" as on a UK layout.
    fn typed(vkey: u16, _scan: u16, held: Modifiers, _window: isize) -> Option<String> {
        let ctrl = held.left_ctrl || held.right_ctrl;
        let alt = held.left_alt || held.right_alt;
        if ctrl && alt {
            return (vkey == u16::from(b'E')).then(|| "€".to_string());
        }
        if ctrl || alt {
            return None;
        }
        // Virtual-key codes for letters and digits are their upper-case ASCII codes.
        let ch = char::from(u8::try_from(vkey).ok()?);
        if !ch.is_ascii_uppercase() && !ch.is_ascii_digit() && ch != ' ' {
            return None;
        }
        let upper = held.shift != held.caps_lock;
        Some(if upper {
            ch.to_string()
        } else {
            ch.to_ascii_lowercase().to_string()
        })
    }

    fn read_all(reader: &mut KeyReader, events: &[KeyEvent]) -> Vec<KeyAction> {
        events
            .iter()
            .filter_map(|event| reader.read(event, typed))
            .collect()
    }

    #[test]
    fn letters_shift_and_caps_lock() {
        let mut reader = KeyReader::new(false);
        let actions = read_all(
            &mut reader,
            &[
                key(u16::from(b'H'), false),
                key(u16::from(b'H'), true),
                key(VK_SHIFT, false),
                key(u16::from(b'I'), false),
                key(VK_SHIFT, true),
                key(VK_CAPITAL, false),
                key(VK_CAPITAL, true),
                key(u16::from(b'J'), false),
            ],
        );
        assert_eq!(
            actions,
            [
                KeyAction::Text("h".into()),
                KeyAction::Text("I".into()),
                KeyAction::Text("J".into())
            ]
        );
    }

    #[test]
    fn combinations_carry_their_modifiers() {
        let mut reader = KeyReader::new(false);
        let actions = read_all(
            &mut reader,
            &[
                key(VK_CONTROL, false),
                key(VK_SHIFT, false),
                key(u16::from(b'N'), false),
                key(VK_SHIFT, true),
                key(VK_CONTROL, true),
                key(u16::from(b'N'), false),
            ],
        );
        assert_eq!(
            actions,
            [
                KeyAction::Combo(Combo {
                    ctrl: true,
                    alt: false,
                    shift: true,
                    win: false,
                    vkey: u16::from(b'N'),
                }),
                KeyAction::Text("n".into()),
            ]
        );
    }

    #[test]
    fn alt_gr_typing_a_character_is_typing() {
        let mut reader = KeyReader::new(false);
        // AltGr: Windows sends a left Ctrl, then the right Alt (E0).
        let actions = read_all(
            &mut reader,
            &[
                key(VK_CONTROL, false),
                extended(VK_MENU, false),
                key(u16::from(b'E'), false),
                extended(VK_MENU, true),
                key(VK_CONTROL, true),
            ],
        );
        assert_eq!(actions, [KeyAction::Text("€".into())]);
    }

    #[test]
    fn editing_keys_and_enter() {
        let mut reader = KeyReader::new(false);
        let actions = read_all(
            &mut reader,
            &[
                key(VK_RETURN, false),
                key(VK_TAB, false),
                key(VK_BACK, false),
                key(VK_DELETE, false),
                key(VK_ESCAPE, false),
                key(0x25, false),
                key(0x70, false),
            ],
        );
        assert_eq!(
            actions,
            [
                KeyAction::Enter,
                KeyAction::Tab,
                KeyAction::Backspace,
                KeyAction::Delete,
                KeyAction::Escape,
                KeyAction::Move,
                KeyAction::Other,
            ]
        );
    }

    #[test]
    fn the_noise_list() {
        let combo = |ctrl, alt, shift, win, vkey: u8| Combo {
            ctrl,
            alt,
            shift,
            win,
            vkey: u16::from(vkey),
        };
        for noise in [
            combo(true, false, false, false, b'Z'),
            combo(true, false, false, false, b'Y'),
            combo(true, false, true, false, b'Z'),
            combo(false, true, false, false, 0x09),
            combo(false, false, false, true, 0x09),
        ] {
            assert!(noise.is_noise(), "{noise:?}");
        }
        for step in [
            combo(true, false, false, false, b'A'),
            combo(true, false, false, false, b'C'),
            combo(true, false, false, false, b'X'),
            combo(true, false, false, false, b'V'),
            combo(true, false, true, false, b'N'),
            combo(true, false, false, false, b'S'),
            combo(false, true, false, false, 0x73),
            combo(false, false, false, true, b'R'),
            combo(true, true, false, false, 0x2E),
            combo(true, false, true, false, b'V'),
        ] {
            assert!(!step.is_noise(), "{step:?}");
        }
    }

    #[test]
    fn reset_forgets_held_modifiers_but_not_caps_lock() {
        let mut reader = KeyReader::new(true);
        reader.read(&key(VK_CONTROL, false), typed);
        reader.reset();
        assert_eq!(
            reader.read(&key(u16::from(b'K'), false), typed),
            Some(KeyAction::Text("K".into()))
        );
    }
}
