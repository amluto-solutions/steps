//! What the key worker reads of the desktop and takes from it: windows, what a key types, the
//! text a terminal or Excel's formula bar shows, the combo box Windows says has the keyboard, the
//! text box watched for dictation, and screenshots. One reason to change: something new the key
//! worker asks of the desktop. The seam its tests stand in for, with keys, clicks and focus news
//! at set times (`scene.rs`).

use crate::coords::PxRect;
use crate::facts::ElementFacts;
use crate::platform::keyboard::{Modifiers, typed_text};
use crate::platform::window::{WindowInfo, window_class, window_info};
use crate::screen_text::{ComboBoxEdit, ScreenText, TerminalKind};
use crate::screenshot::{Shot, hide_excluded};

use super::KeyOptions;

/// What the key worker reads of the desktop and takes from it. Behind a trait so its tests can
/// run the real worker against a made-up desktop, with keys, clicks and focus news at set times.
pub(super) trait Desktop {
    /// A window and its class; `None` for one that has gone.
    fn window(&mut self, hwnd: isize) -> Option<(WindowInfo, String)>;
    /// What a key types with these modifiers in the window it went to.
    fn typed_text(&self, vkey: u16, scan: u16, held: Modifiers, hwnd: isize) -> Option<String>;
    /// What Excel's formula bar in this window holds now.
    fn formula_bar(&mut self, hwnd: isize) -> Option<String>;
    /// The time now, on the clock key events are timed by.
    fn tick_now(&self) -> u32;
    /// The text a terminal window shows now.
    fn terminal(&self, hwnd: isize, kind: TerminalKind) -> Option<String>;
    /// The top-level window at a screen point.
    fn root_at(&self, x: i32, y: i32) -> Option<isize>;
    /// The combo box's edit Windows says has the keyboard in the window `hwnd`, if it's one: a
    /// file dialog's File name box (#61), Excel's Name Box (#69). `extra_terms` are IT's
    /// sensitive words, for its facts.
    fn combo_box_edit(&self, hwnd: isize, extra_terms: &[String]) -> Option<ComboBoxEdit>;
    /// The window class of the control Windows says has the keyboard in the window `hwnd`
    /// (`GetGUIThreadInfo`), as of now: the Remote Desktop control's input window
    /// (`IHWindowClass`) in any program (#116). `None` when it can't say, and on Linux.
    fn keyboard_class(&self, hwnd: isize) -> Option<String>;
    /// A screenshot of a window, with `excluded` apps hidden (`Worker::shoot`).
    fn shoot(&self, window: &WindowInfo, options: &KeyOptions, excluded: &[String])
    -> Option<Shot>;
    /// Starts watching the element UI Automation says has focus now, when it is the one `facts`
    /// tell of (in process `pid`), a text box that can be typed in and doesn't read as a password
    /// or sensitive box (`extra_terms` are IT's sensitive words), and gives its text now (#91).
    /// `None`, watching nothing, when it isn't, or its text can't be read.
    fn watch_text_box(
        &mut self,
        facts: &ElementFacts,
        pid: u32,
        extra_terms: &[String],
    ) -> Option<String>;
    /// The watched text box's text now; `None` when nothing is watched or it can't be read.
    fn text_box_text(&mut self) -> Option<String>;
    /// Stops watching the text box.
    fn forget_text_box(&mut self);
    /// Whether a window of Windows' text input host shows: the voice typing panel, or the emoji
    /// panel, clipboard history or the touch keyboard, which the same program draws (#91).
    fn text_input_panel(&mut self) -> bool;
    /// Whether the element UI Automation says has focus now holds a password or a secret: it says
    /// so itself (`extra_terms` are IT's sensitive words), or a parent is a password box, as a
    /// click's lookup marks a part of one. `None` when it can't be read (#97 fourth review).
    fn focused_secret(&mut self, extra_terms: &[String]) -> Option<bool>;
}

/// The desktop the recording is of.
pub(super) struct LiveDesktop {
    text: Option<ScreenText>,
}

impl LiveDesktop {
    /// The desktop as seen from the thread that calls this: UI Automation's objects stay on the
    /// thread that made them.
    pub(super) fn new() -> Self {
        Self {
            text: ScreenText::new(),
        }
    }
}

impl Desktop for LiveDesktop {
    fn window(&mut self, hwnd: isize) -> Option<(WindowInfo, String)> {
        window_info(hwnd).map(|window| {
            let class = window_class(window.hwnd).unwrap_or_default();
            (window, class)
        })
    }

    fn typed_text(&self, vkey: u16, scan: u16, held: Modifiers, hwnd: isize) -> Option<String> {
        typed_text(vkey, scan, held, hwnd)
    }

    fn formula_bar(&mut self, hwnd: isize) -> Option<String> {
        self.text.as_mut().and_then(|text| text.formula_bar(hwnd))
    }

    fn tick_now(&self) -> u32 {
        crate::platform::display::now_tick()
    }

    fn terminal(&self, hwnd: isize, kind: TerminalKind) -> Option<String> {
        self.text
            .as_ref()
            .and_then(|text| text.terminal(hwnd, kind))
    }

    fn root_at(&self, x: i32, y: i32) -> Option<isize> {
        root_at(x, y)
    }

    fn combo_box_edit(&self, hwnd: isize, extra_terms: &[String]) -> Option<ComboBoxEdit> {
        self.text
            .as_ref()
            .and_then(|text| text.combo_box_edit(hwnd, extra_terms))
    }

    #[cfg(windows)]
    fn keyboard_class(&self, hwnd: isize) -> Option<String> {
        crate::platform::window::keyboard_focus(hwnd).map(|focus| focus.class)
    }

    // X11 has no window per control; the Linux clients are told by their program.
    #[cfg(not(windows))]
    fn keyboard_class(&self, _: isize) -> Option<String> {
        None
    }

    fn shoot(
        &self,
        window: &WindowInfo,
        options: &KeyOptions,
        excluded: &[String],
    ) -> Option<Shot> {
        // Only a window on the monitor being recorded, when it's one: a click's screenshot is of
        // the monitor it was on, and keys have none.
        let frame = PxRect::from(window.frame);
        let x = frame.left + (frame.right - frame.left) / 2;
        let y = frame.top + (frame.bottom - frame.top) / 2;
        if options
            .target_monitor
            .is_some_and(|monitor| !monitor.contains(x, y))
        {
            return None;
        }
        // Keys are handled 150 ms late, and the window is remembered for 2 seconds: a dialog its
        // Enter closed, or a window closed since, has left its frame showing what was behind it,
        // which `shoot_window` greys as it does a window gone before its "Open" step's shot.
        let mut shot =
            crate::pipeline::shoot_window(window, options.mode, options.target_monitor).ok()?;
        hide_excluded(&mut shot, excluded);
        Some(shot)
    }

    fn watch_text_box(
        &mut self,
        facts: &ElementFacts,
        pid: u32,
        extra_terms: &[String],
    ) -> Option<String> {
        self.text
            .as_mut()
            .and_then(|text| text.watch_text_box(facts, pid, extra_terms))
    }

    fn text_box_text(&mut self) -> Option<String> {
        self.text.as_mut().and_then(ScreenText::text_box_text)
    }

    fn forget_text_box(&mut self) {
        if let Some(text) = self.text.as_mut() {
            text.forget_text_box();
        }
    }

    fn text_input_panel(&mut self) -> bool {
        !crate::dictation::text_input_panels().is_empty()
    }

    fn focused_secret(&mut self, extra_terms: &[String]) -> Option<bool> {
        self.text
            .as_ref()
            .and_then(|text| text.focused_secret(extra_terms))
    }
}

/// The top-level window at a screen point, for [`element_in_window`].
fn root_at(x: i32, y: i32) -> Option<isize> {
    crate::platform::window::root_window_at(x, y).map(|window| window.hwnd)
}
