//! What has the keyboard focus, as UI Automation's (or AT-SPI's) focus news tells the key worker,
//! and whether its element belongs to the window the keys went to (10/10/2026): the same program,
//! or another's element shown inside that window (a web view, a store app's frame), on screen
//! where the window is. A notification that took focus while the keys went on to the window in
//! front says nothing of where they went. One reason to change: what the focus news says, and
//! when its element is trusted to name typing.

use std::sync::{Arc, Mutex};

use crate::coords::PxRect;
use crate::facts::ElementFacts;
use crate::platform::window::WindowInfo;
use crate::screen_text::ComboBoxEdit;

/// What UI Automation last said has the keyboard focus. Written by the focus handler.
#[derive(Debug, Clone, Default)]
pub struct FocusNote {
    /// Goes up by one at every focus change.
    pub generation: u64,
    /// The top-level window in front when focus arrived.
    pub window: isize,
    pub facts: ElementFacts,
    /// A field whose value is read when focus leaves it: its keys make no step of their own.
    pub field: bool,
    /// Chrome's or Edge's address bar: what's typed there is the address, which the "Go to" step
    /// records (the site only), so it makes no typing step at all.
    pub address_bar: bool,
    /// When the focus handler heard of this focus, for keys that got there before the news.
    pub tick_ms: u32,
    /// The focused element's process, 0 when it can't be told. Keys are only put down to an
    /// element of the window they went to: a notification can take UI Automation's focus while the
    /// keys still go to the window in front (10/10/2026).
    pub pid: u32,
    /// Goes up by one each time a password or sensitive element gets focus. The key worker reads
    /// only the latest note, and a later focus change (a notification) can replace one for a
    /// password box before it was read: this still tells it one had focus.
    pub passwords: u64,
    /// The window in front the last time a password or sensitive element got focus.
    pub password_window: isize,
}

impl FocusNote {
    /// The focused element is a password or sensitive field.
    #[must_use]
    pub fn secret(&self) -> bool {
        self.facts.sensitive || self.facts.is_password
    }

    /// Notes a new focus, as the focus handler reads it: everything but the generation and the
    /// password count is replaced.
    pub fn focus_now(&mut self, update: FocusUpdate) {
        self.generation = self.generation.wrapping_add(1);
        self.window = update.window;
        self.facts = update.facts;
        self.field = update.field;
        self.address_bar = update.address_bar;
        self.tick_ms = update.tick_ms;
        self.pid = update.pid;
        if self.secret() {
            self.passwords = self.passwords.wrapping_add(1);
            self.password_window = self.window;
        }
    }
}

/// A focus change as the focus handler (UI Automation or AT-SPI) reads it.
#[derive(Debug, Clone, Default)]
pub struct FocusUpdate {
    /// [`FocusNote::window`].
    pub window: isize,
    /// [`FocusNote::facts`].
    pub facts: ElementFacts,
    /// [`FocusNote::field`].
    pub field: bool,
    /// [`FocusNote::address_bar`].
    pub address_bar: bool,
    /// [`FocusNote::tick_ms`].
    pub tick_ms: u32,
    /// [`FocusNote::pid`].
    pub pid: u32,
}

pub type SharedFocus = Arc<Mutex<FocusNote>>;

/// The element UI Automation says has focus, but only when it is part of the window the keys went
/// to (10/10/2026): the same process, or another process's element shown inside that window (a
/// web view such as the new Outlook's `msedgewebview2.exe`, a Store app in its frame), and on
/// screen where the window is. Anything else (a notification that took focus while the keys still
/// went to the window in front) says nothing about where the keys went: its name is never used,
/// and the typing keeps no value. `root_at` names the top-level window at a screen point.
pub(super) fn element_in_window(
    note: &FocusNote,
    window: &WindowInfo,
    root_at: impl FnOnce(i32, i32) -> Option<isize>,
) -> Option<ElementFacts> {
    if note.window != window.hwnd {
        return None;
    }
    note.facts.bounds?.intersect(&PxRect::from(window.frame))?;
    (!another_program(note, window, root_at)).then(|| note.facts.clone())
}

/// Whether the element with focus is another program's, not shown inside `window`. A process
/// that can't be told counts as another's unless the window is what's at the element's middle.
pub(super) fn another_program(
    note: &FocusNote,
    window: &WindowInfo,
    root_at: impl FnOnce(i32, i32) -> Option<isize>,
) -> bool {
    if note.pid != 0 && note.pid == window.pid {
        return false;
    }
    let Some(bounds) = note.facts.bounds else {
        return true;
    };
    let x = bounds.left + bounds.width() / 2;
    let y = bounds.top + bounds.height() / 2;
    root_at(x, y) != Some(window.hwnd)
}

/// A combo box's edit Windows says has the keyboard, as an element of `window`: only when it is
/// one, as [`element_in_window`] tells (#61, #69).
pub(super) fn combo_box_in(
    found: &ComboBoxEdit,
    window: &WindowInfo,
    root_at: impl FnOnce(i32, i32) -> Option<isize>,
) -> Option<ElementFacts> {
    let note = FocusNote {
        window: found.root,
        facts: found.facts.clone(),
        pid: found.pid,
        ..FocusNote::default()
    };
    element_in_window(&note, window, root_at)
}

/// How late a browser's address bar can report focus after the typing into it began. Chrome often
/// reports it after the first key or two, which then look like typing on the page (testing,
/// 30/09/2026: "Type "o"" before the address was typed).
const ADDRESS_BAR_LAG_MS: u32 = 1_000;

/// Whether focus news for a browser's address bar, in the window a stretch of typing is in, came
/// within `ADDRESS_BAR_LAG_MS` of the stretch's first key: then the keys were the address.
pub(super) fn address_bar_took(note: &FocusNote, hwnd: isize, first_tick: u32) -> bool {
    note.address_bar
        && note.window == hwnd
        && note.tick_ms.wrapping_sub(first_tick) < ADDRESS_BAR_LAG_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typing::scene::*;

    #[test]
    fn a_notification_that_takes_focus_is_not_where_the_keys_went() {
        let dialog = encrypt_dialog();
        // Another program's element, outside the dialog: never the field.
        assert_eq!(
            element_in_window(&noted(&[password_box(), toast()]), &dialog, screen),
            None
        );
        // Even over the dialog, another program's element drawn by its own window isn't.
        let over = FocusUpdate {
            facts: ElementFacts {
                bounds: Some(PxRect {
                    left: 900,
                    top: 500,
                    right: 1100,
                    bottom: 600,
                }),
                ..toast().facts
            },
            ..toast()
        };
        assert_eq!(
            element_in_window(&noted(&[over]), &dialog, |_, _| Some(TOAST_WINDOW)),
            None
        );
        // Mid-stretch, the toast is another program's element; the dialog's own elements never
        // are, even without bounds (Excel's cell editor moving focus while typing).
        assert!(another_program(&noted(&[toast()]), &dialog, screen));
        let unplaced = FocusUpdate {
            facts: ElementFacts {
                bounds: None,
                ..password_box().facts
            },
            ..password_box()
        };
        assert!(!another_program(&noted(&[unplaced]), &dialog, |_, _| None));
        // The dialog's own box is.
        assert_eq!(
            element_in_window(&noted(&[password_box()]), &dialog, screen).map(|facts| facts.name),
            Some("Password".to_string())
        );
    }

    #[test]
    fn an_element_must_be_on_screen_where_its_window_is() {
        let dialog = encrypt_dialog();
        // Its own program's, but nowhere near the window, or with no bounds: not trusted.
        let elsewhere = FocusUpdate {
            pid: WORD_PID,
            ..toast()
        };
        assert_eq!(
            element_in_window(&noted(&[elsewhere]), &dialog, screen),
            None
        );
        let unplaced = FocusUpdate {
            facts: ElementFacts {
                bounds: None,
                ..password_box().facts
            },
            ..password_box()
        };
        assert_eq!(
            element_in_window(&noted(&[unplaced]), &dialog, screen),
            None
        );
        // Focus news for another window says nothing about this one.
        let other_window = FocusUpdate {
            window: DIALOG + 1,
            ..password_box()
        };
        assert_eq!(
            element_in_window(&noted(&[other_window]), &dialog, screen),
            None
        );
        // Program unknown: only when the window is what's there.
        let unknown = FocusUpdate {
            pid: 0,
            ..password_box()
        };
        assert!(
            element_in_window(&noted(std::slice::from_ref(&unknown)), &dialog, screen).is_some()
        );
        assert_eq!(
            element_in_window(&noted(&[unknown]), &dialog, |_, _| None),
            None
        );
    }

    #[test]
    fn a_web_view_inside_the_window_is_part_of_it() {
        // The new Outlook: the window is olk.exe's, the message body msedgewebview2.exe's.
        let outlook = WindowInfo {
            hwnd: 77,
            pid: 100,
            title: "Mail - Outlook".into(),
            exe_path: Some(r"C:\Program Files\WindowsApps\olk.exe".into()),
            frame: rect(0, 0, 1200, 900),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let body = FocusUpdate {
            window: 77,
            facts: ElementFacts {
                control_type: "Document".into(),
                name: "Message body".into(),
                bounds: Some(PxRect {
                    left: 300,
                    top: 200,
                    right: 1100,
                    bottom: 800,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: 200,
        };
        assert!(
            element_in_window(&noted(std::slice::from_ref(&body)), &outlook, |_, _| Some(
                77
            ))
            .is_some()
        );
        assert_eq!(
            element_in_window(&noted(&[body]), &outlook, |_, _| Some(78)),
            None
        );
    }

    #[test]
    fn focus_news_counts_password_boxes_a_later_focus_replaced() {
        let note = noted(&[password_box(), toast()]);
        assert_eq!(note.generation, 2);
        assert_eq!(note.passwords, 1);
        assert_eq!(note.password_window, DIALOG);
        assert!(!note.secret(), "the note itself is the toast's now");
        assert_eq!(note.pid, TOAST_PID);
    }

    #[test]
    fn keys_just_before_the_address_bar_says_it_has_focus_were_the_address() {
        let note = FocusNote {
            window: 7,
            address_bar: true,
            tick_ms: 10_400,
            ..FocusNote::default()
        };
        // Chrome reported the address bar 400 ms after the first key: "o" was typed into it.
        assert!(address_bar_took(&note, 7, 10_000));
        // Typing on the page a while before, or in another window, stays typing.
        assert!(!address_bar_took(&note, 7, 8_000));
        assert!(!address_bar_took(&note, 8, 10_000));
        let page = FocusNote {
            address_bar: false,
            ..note.clone()
        };
        assert!(!address_bar_took(&page, 7, 10_000));
        // Ticks wrap around after 49 days; a stretch that began just before still counts.
        let wrapped = FocusNote {
            tick_ms: 200,
            ..note
        };
        assert!(address_bar_took(&wrapped, 7, u32::MAX - 100));
    }
}
