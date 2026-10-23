//! Text read from the screen, for keystroke capture (docs/spec/02-capture.md#keys): what a
//! terminal shows, and what Excel's formula bar holds. On Windows through UI Automation (here);
//! on Linux through AT-SPI (`atspi.rs`), which GNOME Terminal and the other VTE terminals answer.
//! Also, on Windows, the common file dialog's File name box when it has the keyboard (#61), and
//! the text box with focus, read whole at the end of each stretch of time for what dictation put
//! in it (#91): only one that can be typed in, never a password or sensitive box, and none
//! longer than `dictation::MAX_TEXT_BOX`.
//!
//! It runs on the key worker's own thread with its own connection, so a slow read never holds up
//! a click's screenshot.

#[cfg(windows)]
use std::collections::HashMap;

#[cfg(windows)]
use uiautomation::patterns::{UITextPattern, UIValuePattern};
#[cfg(windows)]
use uiautomation::types::{Handle, TextAttribute, TreeScope, UIProperty};
#[cfg(windows)]
use uiautomation::variants::Variant;
#[cfg(windows)]
use uiautomation::{UIAutomation, UIElement};

#[cfg(target_os = "linux")]
pub use crate::uia::ScreenText;

/// Windows Terminal's text area. Its tab titles have text too, so it's picked by class.
#[cfg(windows)]
const TERM_CONTROL: &str = "TermControl";
/// Excel's formula bar.
#[cfg(windows)]
const FORMULA_BAR: &str = "FormulaBar";

/// How long UI Automation waits for an app to connect, and to answer each call, before the read
/// fails as any failed read does (#119): what has focus then keeps typing it checks from keeping
/// a value. A hung app had held up the key worker for seconds at each read (2 to connect, 20 an
/// answer, by default), and the keys behind it; a click's own lookup gives up after 350 ms.
#[cfg(windows)]
const UIA_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

/// The kinds of terminal whose text can be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalKind {
    /// `conhost`: Command Prompt, PowerShell and WSL in their own window.
    Console,
    WindowsTerminal,
    /// Linux terminals built on VTE: GNOME Terminal, Tilix, Terminator, the Xfce and MATE
    /// terminals. Their text is read through AT-SPI.
    Vte,
}

impl TerminalKind {
    /// From a top-level window's class name.
    #[must_use]
    pub fn from_class(class: &str) -> Option<Self> {
        match class {
            "ConsoleWindowClass" => Some(Self::Console),
            "CASCADIA_HOSTING_WINDOW_CLASS" => Some(Self::WindowsTerminal),
            // X11 `WM_CLASS` classes.
            "Gnome-terminal"
            | "gnome-terminal-server"
            | "Tilix"
            | "Terminator"
            | "Xfce4-terminal"
            | "Mate-terminal"
            | "Kgx"
            | "Ptyxis" => Some(Self::Vte),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Console => "console",
            Self::WindowsTerminal => "windowsTerminal",
            Self::Vte => "vte",
        }
    }
}

/// A combo box's edit that Windows says has the keyboard in a window: the common file dialog's
/// File name box in Save As and Open (#61), or Excel's Name Box (#69).
#[derive(Debug, Clone)]
pub struct ComboBoxEdit {
    /// The top-level window it's in.
    pub root: isize,
    /// Its process, 0 when it can't be told.
    pub pid: u32,
    /// What UI Automation says of it.
    pub facts: crate::facts::ElementFacts,
}

#[cfg(windows)]
pub struct ScreenText {
    automation: UIAutomation,
    formula_bars: HashMap<isize, UIElement>,
    /// The properties an element's facts are read from, in one call.
    facts: Option<uiautomation::core::UICacheRequest>,
    /// The text box with focus, whose text is read to find what dictation put in it (#91).
    text_box: Option<UIElement>,
}

#[cfg(windows)]
impl ScreenText {
    /// `None` if UI Automation can't start on this thread; commands and formulas are then not
    /// read, and typing still is. Its calls give up on an app after [`UIA_WAIT`].
    #[must_use]
    pub fn new() -> Option<Self> {
        // Sets up COM on this thread too, which the client that can be told how long to wait
        // needs; should that one fail, this one is used as before.
        let automation = UIAutomation::new().ok()?;
        let automation =
            crate::platform::uia::client_waiting(UIA_WAIT).map_or(automation, UIAutomation::from);
        let facts = crate::uia::element_cache(&automation).ok();
        Some(Self {
            automation,
            formula_bars: HashMap::new(),
            facts,
            text_box: None,
        })
    }

    /// Starts watching the element UI Automation says has focus now, when it is the one `facts`
    /// tell of, in process `pid`, a text box that can be typed in (its text or value isn't
    /// read-only) and doesn't read as a password or sensitive box (`extra_terms` are IT's
    /// sensitive words). Gives its text now (#91). Asked a moment after the focus handler heard
    /// of the focus, so the element is checked to be the same one.
    pub fn watch_text_box(
        &mut self,
        facts: &crate::facts::ElementFacts,
        pid: u32,
        extra_terms: &[String],
    ) -> Option<String> {
        self.text_box = None;
        let element = self
            .automation
            .get_focused_element_build_cache(self.facts.as_ref()?)
            .ok()?;
        let found_pid = element
            .get_cached_process_id()
            .ok()
            .and_then(|pid| u32::try_from(pid).ok());
        let found = crate::uia::facts_from_cached(&element, extra_terms);
        let same = found_pid == Some(pid)
            && found.control_type == facts.control_type
            && found.class_name == facts.class_name
            && found.automation_id == facts.automation_id
            && found.name == facts.name
            && found.bounds == facts.bounds;
        if !same || found.is_password || found.sensitive || !can_type_in(&element) {
            return None;
        }
        let text = read_text_box(&element)?;
        self.text_box = Some(element);
        Some(text)
    }

    /// The watched text box's text now (#91).
    pub fn text_box_text(&mut self) -> Option<String> {
        read_text_box(self.text_box.as_ref()?)
    }

    /// Stops watching the text box.
    pub fn forget_text_box(&mut self) {
        self.text_box = None;
    }

    /// Whether the element UI Automation says has focus now holds a password or a secret: it says
    /// so itself (`IsPassword`, or IT's sensitive words in `extra_terms`), or one of its parents
    /// is a password box, as a click's lookup marks a part of one (`lookup::parents_marked`).
    /// `None` when it can't be read. Asked for a stretch of typing after a click that couldn't
    /// say what it went to, before the stretch keeps a value (#97 fourth review).
    #[must_use]
    pub fn focused_secret(&self, extra_terms: &[String]) -> Option<bool> {
        let cache = self.facts.as_ref()?;
        let element = self
            .automation
            .get_focused_element_build_cache(cache)
            .ok()?;
        let facts = crate::uia::facts_from_cached(&element, extra_terms);
        Some(
            facts.is_password
                || facts.sensitive
                || crate::uia::in_password_box(&self.automation, cache, &element),
        )
    }

    /// The control Windows says has the keyboard in the top-level window `hwnd`, when it's a combo
    /// box's edit, with UI Automation's facts for it (`extra_terms` are IT's sensitive words): the
    /// common file dialog's File name box (#61), or Excel's Name Box (#69). Windows is asked
    /// rather than UI Automation, which can say the dialog's pane has focus while the keys go
    /// into the box; and asking for that one control never walks the dialog's folder view.
    #[must_use]
    pub fn combo_box_edit(&self, hwnd: isize, extra_terms: &[String]) -> Option<ComboBoxEdit> {
        let focus = crate::platform::window::keyboard_focus(hwnd)?;
        if !focus.is_combo_box_edit() {
            return None;
        }
        let element = self
            .automation
            .element_from_handle_build_cache(Handle::from(focus.hwnd), self.facts.as_ref()?)
            .ok()?;
        let pid = element
            .get_cached_process_id()
            .ok()
            .and_then(|pid| u32::try_from(pid).ok())
            .unwrap_or(0);
        Some(ComboBoxEdit {
            root: focus.root,
            pid,
            facts: crate::uia::facts_from_cached(&element, extra_terms),
        })
    }

    /// The text a terminal window shows now: its visible rows, one per line.
    #[must_use]
    pub fn terminal(&self, hwnd: isize, kind: TerminalKind) -> Option<String> {
        let window = self
            .automation
            .element_from_handle(Handle::from(hwnd))
            .ok()?;
        let element = match kind {
            TerminalKind::WindowsTerminal => {
                let condition = self
                    .automation
                    .create_property_condition(
                        UIProperty::ClassName,
                        Variant::from(TERM_CONTROL),
                        None,
                    )
                    .ok()?;
                let controls = window.find_all(TreeScope::Descendants, &condition).ok()?;
                // Split panes each have one: the one with the keyboard is where Enter went.
                let focused = controls.iter().find(|control| has_focus(control)).cloned();
                focused.or_else(|| controls.into_iter().next())?
            }
            TerminalKind::Console | TerminalKind::Vte => {
                let condition = self
                    .automation
                    .create_property_condition(
                        UIProperty::IsTextPatternAvailable,
                        Variant::from(true),
                        None,
                    )
                    .ok()?;
                window.find_first(TreeScope::Descendants, &condition).ok()?
            }
        };
        let pattern = element.get_pattern::<UITextPattern>().ok()?;
        let ranges = pattern.get_visible_ranges().ok()?;
        let mut text = String::new();
        for range in ranges {
            if let Ok(part) = range.get_text(-1) {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&part);
            }
        }
        Some(text.replace("\r\n", "\n").replace('\r', "\n"))
    }

    /// What Excel's formula bar holds: the formula (or value) of the selected cell, or what is
    /// being typed into it.
    pub fn formula_bar(&mut self, hwnd: isize) -> Option<String> {
        if let Some(bar) = self.formula_bars.get(&hwnd)
            && let Some(text) = read_document(bar)
        {
            return Some(text);
        }
        if self.formula_bars.len() > 16 {
            self.formula_bars.clear();
        }
        let window = self
            .automation
            .element_from_handle(Handle::from(hwnd))
            .ok()?;
        let condition = self
            .automation
            .create_property_condition(UIProperty::AutomationId, Variant::from(FORMULA_BAR), None)
            .ok()?;
        let bar = window.find_first(TreeScope::Descendants, &condition).ok()?;
        let text = read_document(&bar);
        self.formula_bars.insert(hwnd, bar);
        text
    }
}

#[cfg(windows)]
fn has_focus(element: &UIElement) -> bool {
    element
        .get_property_value(UIProperty::HasKeyboardFocus)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok())
        .unwrap_or(false)
}

/// Whether a text box can be typed in: its text isn't read-only, or else its value isn't (#91).
/// A web page, a mail's reading pane and a log viewer say they're read-only, so a page that
/// changes after a click is never taken for dictation. One that answers neither isn't watched.
#[cfg(windows)]
fn can_type_in(element: &UIElement) -> bool {
    let text_read_only = element
        .get_pattern::<UITextPattern>()
        .ok()
        .and_then(|pattern| pattern.get_document_range().ok())
        .and_then(|range| range.get_attribute_value(TextAttribute::IsReadOnly).ok())
        // A range of mixed values answers with an object, not a bool.
        .and_then(|value| TryInto::<bool>::try_into(value).ok());
    if let Some(read_only) = text_read_only {
        return !read_only;
    }
    element
        .get_pattern::<UIValuePattern>()
        .ok()
        .and_then(|pattern| pattern.is_readonly().ok())
        == Some(false)
}

/// A text box's whole text, through its Text pattern or else its Value pattern, or `None` when
/// it's longer than [`crate::dictation::MAX_TEXT_BOX`]: it's read whole at a click or a focus
/// change, never while the person types or speaks (#91).
#[cfg(windows)]
fn read_text_box(element: &UIElement) -> Option<String> {
    let limit = crate::dictation::MAX_TEXT_BOX;
    let text = match element.get_pattern::<UITextPattern>() {
        Ok(pattern) => pattern
            .get_document_range()
            .ok()?
            .get_text(i32::try_from(limit + 1).ok()?)
            .ok()?,
        Err(_) => element
            .get_pattern::<UIValuePattern>()
            .ok()?
            .get_value()
            .ok()?,
    };
    (text.encode_utf16().count() <= limit).then_some(text)
}

#[cfg(windows)]
fn read_document(element: &UIElement) -> Option<String> {
    let pattern = element.get_pattern::<UITextPattern>().ok()?;
    let text = pattern.get_document_range().ok()?.get_text(-1).ok()?;
    Some(text.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The check on a real desktop (#61): open a Save As or Open dialog (Paint, Notepad, Word),
    /// start this, then click into the dialog's File name box within 30 seconds. It prints what
    /// it finds and passes once the box is found in the dialog in front.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a Save As or Open dialog: cargo test -p capture a_file_dialogs_file_name_box -- --ignored --nocapture"]
    fn a_file_dialogs_file_name_box_is_found_by_the_keyboard() {
        let text = ScreenText::new().expect("UI Automation starts");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if let Some(front) = crate::platform::window::foreground_window()
                && crate::platform::window::window_class(front.hwnd).as_deref() == Some("#32770")
            {
                let keyboard = crate::platform::window::keyboard_focus(front.hwnd);
                let found = text.combo_box_edit(front.hwnd, &[]);
                println!("{:?}: {keyboard:?}\n  {found:?}", front.title);
                if let Some(found) = found {
                    assert_eq!(found.root, front.hwnd, "the box is the dialog's");
                    assert_eq!(found.facts.control_type, "Edit");
                    return;
                }
            }
            assert!(
                std::time::Instant::now() < until,
                "no File name box had the keyboard in a dialog in front in 30 seconds"
            );
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    /// The check on a real desktop (#69): open a workbook in Excel, start this, then click into
    /// the Name Box within 30 seconds. It prints what Windows and UI Automation say has the
    /// keyboard, and passes once the Name Box is found as a combo box's edit in Excel's window.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs Excel: cargo test -p capture excels_name_box -- --ignored --nocapture"]
    fn excels_name_box_is_found_by_the_keyboard() {
        let text = ScreenText::new().expect("UI Automation starts");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if let Some(front) = crate::platform::window::foreground_window()
                && crate::platform::window::window_class(front.hwnd).as_deref()
                    == Some(crate::excel::WINDOW_CLASS)
            {
                let keyboard = crate::platform::window::keyboard_focus(front.hwnd);
                let found = text.combo_box_edit(front.hwnd, &[]);
                println!("{:?}: {keyboard:?}\n  {found:?}", front.title);
                if let Some(found) = found {
                    assert_eq!(found.root, front.hwnd, "the box is the workbook window's");
                    return;
                }
            }
            assert!(
                std::time::Instant::now() < until,
                "Excel's Name Box didn't have the keyboard in a workbook in front in 30 seconds"
            );
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_key_workers_ui_automation_gives_up_on_a_hung_app() {
        // A hung app had held up the key worker for seconds at each read (#119): UI Automation
        // waited 2 seconds for it to connect and 20 for each answer.
        let text = ScreenText::new().expect("UI Automation starts");
        assert_eq!(
            crate::platform::uia::waits(text.automation.as_ref()),
            Some((UIA_WAIT, UIA_WAIT))
        );
    }

    #[test]
    fn terminals_are_known_by_window_class() {
        assert_eq!(
            TerminalKind::from_class("ConsoleWindowClass"),
            Some(TerminalKind::Console)
        );
        assert_eq!(
            TerminalKind::from_class("CASCADIA_HOSTING_WINDOW_CLASS"),
            Some(TerminalKind::WindowsTerminal)
        );
        assert_eq!(
            TerminalKind::from_class("Gnome-terminal"),
            Some(TerminalKind::Vte)
        );
        assert_eq!(TerminalKind::from_class("XLMAIN"), None);
    }
}
