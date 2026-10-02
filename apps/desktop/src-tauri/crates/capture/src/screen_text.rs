//! Text read from the screen, for keystroke capture (docs/spec/02-capture.md#keys): what a
//! terminal shows, and what Excel's formula bar holds. On Windows through UI Automation (here);
//! on Linux through AT-SPI (`atspi.rs`), which GNOME Terminal and the other VTE terminals answer.
//!
//! It runs on the key worker's own thread with its own connection, so a slow read never holds up
//! a click's screenshot.

#[cfg(windows)]
use std::collections::HashMap;

#[cfg(windows)]
use uiautomation::patterns::UITextPattern;
#[cfg(windows)]
use uiautomation::types::{Handle, TreeScope, UIProperty};
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

/// Excel's main window.
pub const EXCEL_CLASS: &str = "XLMAIN";

#[cfg(windows)]
pub struct ScreenText {
    automation: UIAutomation,
    formula_bars: HashMap<isize, UIElement>,
}

#[cfg(windows)]
impl ScreenText {
    /// `None` if UI Automation can't start on this thread; commands and formulas are then not
    /// read, and typing still is.
    #[must_use]
    pub fn new() -> Option<Self> {
        Some(Self {
            automation: UIAutomation::new().ok()?,
            formula_bars: HashMap::new(),
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

#[cfg(windows)]
fn read_document(element: &UIElement) -> Option<String> {
    let pattern = element.get_pattern::<UITextPattern>().ok()?;
    let text = pattern.get_document_range().ok()?.get_text(-1).ok()?;
    Some(text.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
