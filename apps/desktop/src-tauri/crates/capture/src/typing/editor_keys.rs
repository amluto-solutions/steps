//! Keys typed anywhere else: a document, a code editor, a dialog's box that isn't read as focus
//! leaves it (docs/spec/02-capture.md#keys). One step per stretch of typing, ended by a click, a
//! focus change, a key combination or another window; it's named by the element with focus when
//! that is an element of the window the keys went to (10/10/2026), and in Save As and Open, where
//! UI Automation can name the dialog's pane, by the File name box Windows says has the keyboard
//! (#61). In a spreadsheet's cell, Enter, Tab and the arrows put the entry in and move on, each
//! cell a step of its own (F018). One reason to change: how typing outside a terminal, Excel or
//! a field becomes a step.

use std::time::Instant;

use crate::excel::cell_name;
use crate::facts::ElementFacts;
use crate::keys::KeyAction;
use crate::platform::window::WindowInfo;
use crate::screen_text::ComboBoxEdit;

use super::focus_check::FocusCheck;
use super::stretch::Unconfirmed;
use super::{Desktop, KeysWent, SHOT_AFTER_KEYS, Worker, combo_box_in, element_in_window};

/// The common file dialog's window class: Save As and Open are dialog boxes.
pub(super) const FILE_DIALOG_CLASS: &str = "#32770";

/// The class of the common file dialog's main pane, which holds its folder view and File name box.
const FILE_DIALOG_PANE: &str = "DUIViewWndClassName";

/// Whether `facts` are the common file dialog's main pane, in a window of class `class`. UI
/// Automation can say the pane has focus while the keys go into the dialog's File name box: in
/// Paint's Save As, `Holiday` typed there was recorded as typing into an unnamed pane (#61, P42).
/// File Explorer's own windows have the pane too, but aren't dialogs.
pub(super) fn file_dialog_pane(facts: &ElementFacts, class: &str) -> bool {
    class == FILE_DIALOG_CLASS
        && facts.control_type == "Pane"
        && facts.class_name == FILE_DIALOG_PANE
}

/// The File name box as the element the keys went to, but only when it is an element of
/// `window`, the dialog they went to, as [`element_in_window`] tells (#61). A box in another
/// window says nothing about where these keys went, and one that reads as a password or
/// sensitive box is never put down as where a value went.
fn file_name_box_in(
    found: &ComboBoxEdit,
    window: &WindowInfo,
    root_at: impl FnOnce(i32, i32) -> Option<isize>,
) -> Option<ElementFacts> {
    if found.facts.sensitive || found.facts.is_password {
        return None;
    }
    combo_box_in(found, window, root_at)
}

impl<D: Desktop> Worker<D> {
    pub(super) fn editor_key(
        &mut self,
        hwnd: isize,
        code: bool,
        action: &KeyAction,
        tick: u32,
        arrived: Instant,
        now: Instant,
    ) {
        let starts = matches!(action, KeyAction::Text(_) | KeyAction::Packet);
        if self.stretch.is_none() && starts {
            // Only an element of this window says where the keys went; with none, the step keeps
            // no value (10/10/2026).
            let note = self.current_focus();
            let news_since = self.news_since_key();
            // Straight after a click, the focus may not be where the keys went (#97).
            let went = self.keys_went(tick, hwnd);
            let known = went == KeysWent::Focus;
            let window = self.window(hwnd).filter(|_| known);
            let element = window.and_then(|(window, class)| {
                let root_at = |x, y| self.desktop.root_at(x, y);
                let element = element_in_window(&note, &window, root_at)?;
                if !file_dialog_pane(&element, &class) {
                    return Some(element);
                }
                // UI Automation names the file dialog's pane, but the keys go into its File name
                // box (#61): Windows says which control has the keyboard. It says so as of now,
                // not as of the key, so not once a click or focus change has been heard since.
                if news_since {
                    return None;
                }
                let found = self
                    .desktop
                    .combo_box_edit(hwnd, &self.options.extra_terms)?;
                file_name_box_in(&found, &window, root_at)
            });
            let cell = element.as_ref().and_then(cell_name);
            let mut stretch = self.new_stretch(hwnd, tick, false, code, cell);
            stretch.withheld = element.is_none();
            stretch.element = element;
            // Where the click couldn't say, the text box with focus may say as the stretch ends:
            // only when it's watched, and it's what UI Automation's focus news named, so not a
            // password box (#97 third review).
            if went == KeysWent::Unknown {
                stretch.unconfirmed = self.unconfirmed_box(hwnd);
            }
            // Where the click couldn't say what it went to, UI Automation says what has focus
            // before the stretch keeps a value (#97 fourth review).
            if self.keys_unproven(tick, hwnd) {
                stretch.focus_check = Some(FocusCheck::Due);
            }
            self.stretch = Some(stretch);
        }
        // Asked again at each key that types: what has focus as it arrived and as it's handled
        // (#114, #117). The app can act on the click late, or move focus into a password box
        // itself, with no news.
        if starts && self.check_key(hwnd, arrived, now) {
            return;
        }
        // In a spreadsheet's cell (LibreOffice Calc, not only Excel), Enter, Tab and the arrows put
        // the entry in and move on: each cell is a step of its own (F018).
        if self
            .stretch
            .as_ref()
            .is_some_and(|stretch| stretch.cell.is_some())
            && matches!(action, KeyAction::Enter | KeyAction::Tab | KeyAction::Move)
        {
            self.end_stretch(true);
            return;
        }
        let Some(stretch) = self.stretch.as_mut() else {
            return;
        };
        // Focus may move into a password box no news tells of: asked again at the next key.
        if matches!(
            action,
            KeyAction::Tab | KeyAction::Enter | KeyAction::Escape
        ) {
            stretch.focus_check = stretch.focus_check.map(FocusCheck::focus_key);
        }
        match action {
            KeyAction::Text(text) => stretch.text.push_str(text),
            KeyAction::Packet => stretch.packets = true,
            KeyAction::Enter => stretch.text.push('\n'),
            KeyAction::Tab if code => stretch.text.push('\t'),
            KeyAction::Backspace => {
                if stretch.text.pop().is_none() {
                    stretch.approximate = true;
                }
            }
            KeyAction::Delete | KeyAction::Move => stretch.approximate = true,
            KeyAction::Tab | KeyAction::Escape | KeyAction::Other | KeyAction::Combo(_) => return,
        }
        stretch.shot_due = Some(now + SHOT_AFTER_KEYS);
    }

    /// The text box with focus in the window `hwnd`, watched for dictation, that keys a click
    /// couldn't say the place of may have gone into, and its text as last read.
    fn unconfirmed_box(&self, hwnd: isize) -> Option<Unconfirmed> {
        let (element, before) = self.dictation.watched_in(hwnd)?;
        (self.applied.window == hwnd && self.applied.facts == element && !self.applied.secret())
            .then_some(Unconfirmed {
                element,
                before,
                after: None,
            })
    }
}

#[cfg(test)]
mod tests {
    use crate::typing::scene::*;

    const PAINT_PID: u32 = 4_120;
    const SAVE_AS: isize = 0x70_4100;
    /// The common file dialog's window class.
    const DIALOG_CLASS: &str = "#32770";

    /// Paint's Save As dialog, the window the keys went to.
    fn save_as() -> WindowInfo {
        WindowInfo {
            hwnd: SAVE_AS,
            pid: PAINT_PID,
            title: "Save As".into(),
            exe_path: Some(
                r"C:\Program Files\WindowsApps\Microsoft.Paint_11.2508.361.0_x64__8wekyb3d8bbwe\PaintApp\mspaint.exe"
                    .into(),
            ),
            frame: rect(400, 200, 1360, 860),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    /// The dialog's main pane, which UI Automation said had focus while `Holiday` went into the
    /// File name box (P42).
    fn dialog_pane(window: &WindowInfo) -> FocusUpdate {
        FocusUpdate {
            window: window.hwnd,
            facts: ElementFacts {
                control_type: "Pane".into(),
                class_name: "DUIViewWndClassName".into(),
                bounds: Some(PxRect {
                    left: 408,
                    top: 240,
                    right: 1352,
                    bottom: 800,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: window.pid,
        }
    }

    /// The File name box of the dialog `root`, as Windows and UI Automation tell of it.
    fn file_name_box(root: &WindowInfo) -> ComboBoxEdit {
        ComboBoxEdit {
            root: root.hwnd,
            pid: root.pid,
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "File name:".into(),
                automation_id: "1001".into(),
                class_name: "Edit".into(),
                framework_id: "Win32".into(),
                bounds: Some(PxRect {
                    left: 520,
                    top: 760,
                    right: 1340,
                    bottom: 782,
                }),
                ..ElementFacts::default()
            },
        }
    }

    #[test]
    fn typing_a_file_name_in_save_as_is_put_down_to_the_file_name_box() {
        // P42: Paint > File > Save as, `Holiday` typed at human speed, then Save clicked. UI
        // Automation said the dialog's pane had focus, while the keys went into File name.
        let dialog = save_as();
        let records = record(
            Scene::default()
                .in_window(dialog.clone(), DIALOG_CLASS)
                .keyboard_in(file_name_box(&dialog))
                .focus(500, dialog_pane(&dialog))
                .type_keys(1_000, 150, "Holiday")
                .click_named(2_500, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("File name:"), "Holiday")]);
    }

    #[test]
    fn typing_a_file_name_in_open_is_put_down_to_the_file_name_box() {
        // Notepad > File > Open is the same dialog. UI Automation may give its box the combo box's
        // id rather than 1001: the box is the control Windows says has the keyboard, whatever its
        // automation id.
        let dialog = WindowInfo {
            hwnd: 0x70_5100,
            pid: 8_800,
            title: "Open".into(),
            exe_path: Some(
                r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2508.38.0_x64__8wekyb3d8bbwe\Notepad\Notepad.exe"
                    .into(),
            ),
            ..save_as()
        };
        let mut found = file_name_box(&dialog);
        found.facts.automation_id = "1148".into();
        let records = record(
            Scene::default()
                .in_window(dialog.clone(), DIALOG_CLASS)
                .keyboard_in(found)
                .focus(500, dialog_pane(&dialog))
                .type_keys(1_000, 150, "Holiday")
                .click_named(2_500, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("File name:"), "Holiday")]);
    }

    #[test]
    fn typing_in_the_dialogs_search_box_is_put_down_to_the_search_box() {
        // The search box is an element of its own, outside the pane: focus on it names the typing,
        // whatever else the dialog holds.
        let dialog = save_as();
        let search = FocusUpdate {
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "Search Pictures".into(),
                class_name: "SearchEditBox".into(),
                bounds: Some(PxRect {
                    left: 1_100,
                    top: 208,
                    right: 1_350,
                    bottom: 234,
                }),
                ..ElementFacts::default()
            },
            ..dialog_pane(&dialog)
        };
        let records = record(
            Scene::default()
                .in_window(dialog.clone(), DIALOG_CLASS)
                .keyboard_in(file_name_box(&dialog))
                .focus(500, search)
                .type_keys(1_000, 150, "holiday")
                .click_named(2_500, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Search Pictures"), "holiday")]);
    }

    #[test]
    fn a_file_name_box_that_isnt_the_dialogs_keeps_no_value() {
        // A box in another window (a second Save As, Paint's own window), one nowhere near the
        // dialog, or none Windows can point to: where the keys went can't be told (10/10/2026).
        let dialog = save_as();
        let other_window = ComboBoxEdit {
            root: SAVE_AS + 1,
            ..file_name_box(&dialog)
        };
        let mut elsewhere = file_name_box(&dialog);
        elsewhere.facts.bounds = Some(PxRect {
            left: 2_000,
            top: 760,
            right: 2_800,
            bottom: 782,
        });
        for found in [Some(other_window), Some(elsewhere), None] {
            let scene = Scene::default()
                .in_window(dialog.clone(), DIALOG_CLASS)
                .focus(500, dialog_pane(&dialog))
                .type_keys(1_000, 150, "Holiday")
                .click_named(2_500, 60, None);
            let scene = match found {
                Some(found) => scene.keyboard_in(found),
                None => scene,
            };
            let records = record(scene);
            assert_eq!(typed_in(&records), [(None, "")]);
        }
    }

    #[test]
    fn a_file_name_box_that_reads_as_sensitive_keeps_no_value() {
        // IT's sensitive words can match a box's name ("name", for user names): it's then kept
        // out like any sensitive box, never shown.
        let dialog = save_as();
        let mut found = file_name_box(&dialog);
        found.facts.sensitive = true;
        let records = record(
            Scene::default()
                .in_window(dialog.clone(), DIALOG_CLASS)
                .keyboard_in(found)
                .focus(500, dialog_pane(&dialog))
                .type_keys(1_000, 150, "Holiday")
                .click_named(2_500, 60, None),
        );
        assert!(
            records
                .iter()
                .all(|record| record.text.is_empty() && record.element.is_none()),
            "{:?}",
            typed_in(&records)
        );
    }

    /// Where the File name box is clicked.
    const IN_FILE_NAME: (i32, i32) = (700, 771);

    #[test]
    fn clicking_into_the_file_name_box_and_typing_keeps_its_value() {
        // UI Automation says the dialog's pane has focus while the keyboard is in File name. A
        // click into File name moves no focus, so no focus news follows: fast or at human speed,
        // the keys are the box's, named as usual (#97 review: they had kept no value until focus
        // next moved).
        let dialog = save_as();
        for gap in [10, 150] {
            let records = record(
                Scene::default()
                    .in_window(dialog.clone(), DIALOG_CLASS)
                    .keyboard_in(file_name_box(&dialog))
                    .focus(500, dialog_pane(&dialog))
                    .click_on(1_000, IN_FILE_NAME, file_name_box(&dialog).facts)
                    .type_keys(1_005, gap, "Holiday")
                    .click_named(3_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [(Some("File name:"), "Holiday")],
                "a key every {gap} ms"
            );
        }
    }

    #[test]
    fn clicking_into_the_focused_file_name_box_leaves_its_value_to_it() {
        // UI Automation said File name itself had focus, as the dialog opened, and read its bounds
        // part-way through the dialog's opening animation. A click into it moves no focus: the
        // keys are its value, read as focus leaves it, so they make no step of their own, and no
        // "Type" with no value besides (#97 review).
        let dialog = save_as();
        let mut opening = file_name_box(&dialog).facts;
        opening.bounds = Some(PxRect {
            left: 540,
            top: 720,
            right: 1_320,
            bottom: 742,
        });
        let focused = FocusUpdate {
            facts: opening,
            field: true,
            ..dialog_pane(&dialog)
        };
        for gap in [10, 150] {
            let records = record(
                Scene::default()
                    .in_window(dialog.clone(), DIALOG_CLASS)
                    .focus(500, focused.clone())
                    .click_on(1_000, IN_FILE_NAME, file_name_box(&dialog).facts)
                    .type_keys(1_005, gap, "Holiday")
                    .click_named(3_000, 60, None),
            );
            assert_eq!(typed_in(&records), [], "a key every {gap} ms");
        }
    }

    #[test]
    fn the_keyboard_is_not_asked_once_a_click_after_the_keys_is_heard() {
        // Keys are handled 150 ms late, and Windows says where the keyboard is now: with a click
        // heard since the first key, it may be where the click put it. "H" and a click 40 ms
        // later: the "H" keeps no value; "oliday", typed after the click, is the box's.
        let dialog = save_as();
        let records = record(
            Scene::default()
                .in_window(dialog.clone(), DIALOG_CLASS)
                .keyboard_in(file_name_box(&dialog))
                .focus(500, dialog_pane(&dialog))
                .type_keys(1_000, 150, "H")
                .click_named(1_040, 60, None)
                .type_keys(1_500, 150, "oliday")
                .click_named(3_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [(None, ""), (Some("File name:"), "oliday")]
        );
    }
}
