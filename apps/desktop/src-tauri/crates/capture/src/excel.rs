//! Excel's own rules (docs/spec/02-capture.md#keys, #on-each-click): how it names its window and
//! its cells, where on its grid a press is on a cell's fill handle or a header's filter
//! drop-down, which box is its Name Box and which keys open Go To. The click pipeline, the key
//! worker and UI Automation's lookups all go by these. One reason to change: Excel drawing,
//! naming or answering differently, or being measured again.
//!
//! - `cells.rs`: cell references (`H8`), a cell's own and the one a link sits in.
//! - `fill.rs`: the fill handle, and what a drag from a cell or its handle came to.
//! - `filter.rs`: the filter drop-down in a filtered column's header cell.
//!
//! What happens with them lives with what they're for: typing in Excel (its cells, the formula
//! bar, Go To and the Name Box) in the key worker (`typing/excel_keys.rs`), drags across cells
//! and fills in the click pipeline (`pipeline/drags.rs`), the formula bar's read in
//! `screen_text.rs`, Excel's grid's hit test in `uia.rs`, and the `HasFilterDropdown` property
//! Excel registers with UI Automation in `capture-win32`'s `excel.rs`.

mod cells;
mod fill;
mod filter;

pub(crate) use cells::{cell_name, cell_of, cell_reference};
pub(crate) use fill::{DragEnd, drag_end, fill_handle_at, filled_box};
pub(crate) use filter::filter_button_at;

use crate::keys::KeyAction;
use crate::platform::keyboard::Modifiers;

/// Excel's main window's class: its workbook window, where the sheet, the formula bar and the
/// Name Box are.
pub(crate) const WINDOW_CLASS: &str = "XLMAIN";

/// The class UI Automation gives Excel's cells.
pub(crate) const CELL_CLASS: &str = "XLSpreadsheetCell";

/// Whether the keyboard is in Excel's Name Box: the edit of a combo box in Excel's main window
/// (class `class`, handle `window`), the one combo box it has (#69). The ribbon's boxes are drawn
/// by Office itself and have no window of their own.
#[cfg(windows)]
pub(crate) fn is_name_box(
    class: Option<&str>,
    focus: Option<&crate::platform::window::KeyboardFocus>,
    window: isize,
) -> bool {
    class == Some(WINDOW_CLASS)
        && focus.is_some_and(|focus| focus.is_combo_box_edit() && focus.root == window)
}

/// F5 alone, or Ctrl+G: the keys that open Excel's Go To. Shift+F5 is Find, and Ctrl+Shift+G
/// isn't Go To.
pub(crate) fn opens_go_to(action: &KeyAction, vkey: u16, held: Modifiers) -> bool {
    const VK_F5: u16 = 0x74;
    match action {
        KeyAction::Combo(combo) => {
            combo.ctrl && !combo.alt && !combo.shift && !combo.win && combo.vkey == u16::from(b'G')
        }
        KeyAction::Other => vkey == VK_F5 && !held.shift,
        _ => false,
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn the_name_box_is_the_combo_box_with_the_keyboard_in_excels_window() {
        let name_box = crate::platform::window::KeyboardFocus {
            hwnd: 0x60_3100,
            root: 0x60_3000,
            class: "Edit".into(),
            parent_class: "ComboBox".into(),
            id: 1001,
        };
        assert!(is_name_box(Some("XLMAIN"), Some(&name_box), 0x60_3000));
        // A combo box in another app's window, or in another window, isn't Excel's Name Box.
        assert!(!is_name_box(Some("Notepad"), Some(&name_box), 0x60_3000));
        assert!(!is_name_box(Some("XLMAIN"), Some(&name_box), 0x60_5000));
        // Nor is the sheet, or anything that isn't a combo box's edit.
        let sheet = crate::platform::window::KeyboardFocus {
            class: "EXCEL7".into(),
            parent_class: "XLDESK".into(),
            id: 0,
            ..name_box
        };
        assert!(!is_name_box(Some("XLMAIN"), Some(&sheet), 0x60_3000));
        assert!(!is_name_box(Some("XLMAIN"), None, 0x60_3000));
    }
}
