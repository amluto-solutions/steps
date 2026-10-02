//! Synthetic input for the Phase 1 test driver (feature `test-driver`). Never built into the app.

use std::thread::sleep;
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, SendInput,
    VIRTUAL_KEY, VkKeyScanW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SetCursorPos,
};

use windows::Win32::Foundation::{POINT, RECT};
use windows::Win32::UI::Input::Pointer::{
    InitializeTouchInjection, InjectTouchInput, POINTER_FLAG_DOWN, POINTER_FLAG_INCONTACT,
    POINTER_FLAG_INRANGE, POINTER_FLAG_UP, POINTER_TOUCH_INFO, TOUCH_FEEDBACK_DEFAULT,
};
use windows::Win32::UI::WindowsAndMessaging::{PT_TOUCH, TOUCH_MASK_CONTACTAREA};

use crate::Result;

fn send(inputs: &[INPUT]) -> u32 {
    let size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0);
    // SAFETY: `inputs` is a valid slice of initialised INPUT structs and `size` is their size.
    unsafe { SendInput(inputs, size) }
}

fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    mouse_at(flags, 0, 0)
}

fn mouse_at(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_unicode(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: KEYBD_EVENT_FLAGS(flags.0),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_virtual(vkey: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vkey),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;

/// Presses one key with modifiers held, as a keyboard does: `mods` are virtual keys.
fn chord(mods: &[u16], vkey: u16) {
    let mut inputs: Vec<INPUT> = mods.iter().map(|m| key_virtual(*m, false)).collect();
    inputs.push(key_virtual(vkey, false));
    inputs.push(key_virtual(vkey, true));
    inputs.extend(mods.iter().rev().map(|m| key_virtual(*m, true)));
    send(&inputs);
}

/// Types text with virtual keys, as a real keyboard does (the recorder reads virtual keys;
/// `type_text`'s Unicode packets carry none). Characters the layout has no key for are skipped.
pub fn type_keys(text: &str) {
    for unit in text.encode_utf16() {
        // SAFETY: a plain character code; returns -1 when the layout has no key for it.
        let scan = unsafe { VkKeyScanW(unit) };
        if scan == -1 {
            continue;
        }
        let [vkey, shift] = scan.to_le_bytes();
        let mut mods = Vec::new();
        if shift & 1 != 0 {
            mods.push(VK_SHIFT);
        }
        if shift & 2 != 0 {
            mods.push(VK_CONTROL);
        }
        if shift & 4 != 0 {
            mods.push(VK_MENU);
        }
        chord(&mods, u16::from(vkey));
        sleep(Duration::from_millis(25));
    }
}

/// Presses a combination named like "ctrl+v", "shift+tab", "enter" or "f5".
///
/// # Errors
/// If a key's name isn't known.
pub fn press(combo: &str) -> std::result::Result<(), String> {
    let mut mods = Vec::new();
    let mut key = None;
    for part in combo.split('+').map(str::trim) {
        let lower = part.to_ascii_lowercase();
        let vkey = match lower.as_str() {
            "ctrl" | "control" => {
                mods.push(VK_CONTROL);
                continue;
            }
            "shift" => {
                mods.push(VK_SHIFT);
                continue;
            }
            "alt" => {
                mods.push(VK_MENU);
                continue;
            }
            "enter" | "return" => 0x0D,
            "tab" => 0x09,
            "esc" | "escape" => 0x1B,
            "space" => 0x20,
            "backspace" => 0x08,
            "delete" | "del" => 0x2E,
            "insert" | "ins" => 0x2D,
            "up" => 0x26,
            "down" => 0x28,
            "left" => 0x25,
            "right" => 0x27,
            "home" => 0x24,
            "end" => 0x23,
            other if other.len() == 1 => {
                let c = other.as_bytes()[0];
                if c.is_ascii_alphanumeric() {
                    u16::from(c.to_ascii_uppercase())
                } else {
                    return Err(format!("unknown key {part}"));
                }
            }
            other if other.starts_with('f') => other[1..]
                .parse::<u16>()
                .ok()
                .filter(|n| (1..=24).contains(n))
                .map(|n| 0x70 + n - 1)
                .ok_or_else(|| format!("unknown key {part}"))?,
            _ => return Err(format!("unknown key {part}")),
        };
        key = Some(vkey);
    }
    let key = key.ok_or_else(|| format!("no key in {combo}"))?;
    chord(&mods, key);
    Ok(())
}

/// Moves the cursor to a physical point the way a real mouse does (so hooks see a move event),
/// then pins it to the exact pixel.
///
/// # Errors
/// If Windows refuses to move the cursor.
pub fn move_to(x: i32, y: i32) -> Result<()> {
    // SAFETY: these take no pointers and only read screen metrics.
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let dx = ((i64::from(x - left) * 65_535) / i64::from(width - 1)).clamp(0, 65_535);
    let dy = ((i64::from(y - top) * 65_535) / i64::from(height - 1)).clamp(0, 65_535);
    let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&[mouse_at(
        flags,
        i32::try_from(dx).unwrap_or(0),
        i32::try_from(dy).unwrap_or(0),
    )]);
    // SAFETY: plain coordinates; the cursor is clipped by Windows if they're off-screen.
    unsafe { SetCursorPos(x, y) }?;
    Ok(())
}

/// Moves to a physical point and left-clicks there.
///
/// # Errors
/// If the cursor can't be moved.
pub fn left_click_at(x: i32, y: i32) -> Result<()> {
    move_to(x, y)?;
    sleep(Duration::from_millis(30));
    send(&[mouse(MOUSEEVENTF_LEFTDOWN)]);
    sleep(Duration::from_millis(20));
    send(&[mouse(MOUSEEVENTF_LEFTUP)]);
    Ok(())
}

/// Types text into whatever has focus, one UTF-16 unit at a time.
pub fn type_text(text: &str) {
    for unit in text.encode_utf16() {
        send(&[key_unicode(unit, false), key_unicode(unit, true)]);
        sleep(Duration::from_millis(15));
    }
}

/// Taps a physical point with one synthetic finger, as a touchscreen would. Used to check which
/// input source notices touch (laptops such as the Surface are often tapped, not clicked).
///
/// # Errors
/// If Windows refuses touch injection.
pub fn tap_at(x: i32, y: i32) -> Result<()> {
    // SAFETY: plain values; one contact, default visual feedback.
    unsafe { InitializeTouchInjection(1, TOUCH_FEEDBACK_DEFAULT) }?;
    let mut contact = POINTER_TOUCH_INFO {
        touchMask: TOUCH_MASK_CONTACTAREA,
        rcContact: RECT {
            left: x - 2,
            top: y - 2,
            right: x + 2,
            bottom: y + 2,
        },
        ..Default::default()
    };
    contact.pointerInfo.pointerType = PT_TOUCH;
    contact.pointerInfo.ptPixelLocation = POINT { x, y };
    contact.pointerInfo.pointerFlags =
        POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT;
    // SAFETY: the slice holds one fully initialised contact.
    unsafe { InjectTouchInput(&[contact]) }?;
    sleep(Duration::from_millis(60));
    contact.pointerInfo.pointerFlags = POINTER_FLAG_UP;
    // SAFETY: as above.
    unsafe { InjectTouchInput(&[contact]) }?;
    Ok(())
}
