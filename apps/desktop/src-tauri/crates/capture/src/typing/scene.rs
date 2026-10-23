//! The key worker's tests' desktop and recordings: a made-up desktop behind the `Desktop` seam,
//! and scenes of keys, clicks, focus news and what the screen shows at set times, run through
//! the real worker a turn every 10 ms as it runs on its thread. One reason to change: something
//! new a test needs to happen.

use std::sync::mpsc::channel;

use crate::screen_text::TerminalKind;
use crate::screenshot::CaptureMode;
use crate::state_machine::PauseReason;

use super::*;

// What the tests are written in, for each place's tests to take with the scenes.
pub(super) use super::FocusUpdate;
pub(super) use crate::coords::PxRect;
pub(super) use crate::facts::{ElementFacts, TypingRecord};
pub(super) use crate::platform::window::{Elevation, WindowInfo};
pub(super) use crate::screen_text::ComboBoxEdit;

pub(super) fn rect(left: i32, top: i32, right: i32, bottom: i32) -> crate::platform::Rect {
    crate::platform::Rect {
        left,
        top,
        right,
        bottom,
    }
}

/// A stretch of typing in Excel's cell B6, with the formula bar's last reading and what the
/// keys had typed when it was taken.
pub(super) fn stretch(text: &str, bar: Option<(&str, &str)>) -> Stretch {
    Stretch {
        hwnd: 1,
        excel: true,
        code: false,
        first_tick: 0,
        text: text.to_string(),
        approximate: false,
        element: None,
        cell: Some("B6".into()),
        bar: bar.map(|(reading, keys)| BarReading {
            text: reading.into(),
            keys: keys.into(),
            tick: 0,
        }),
        bar_unchecked: None,
        bar_due: None,
        shot: None,
        shot_due: None,
        focus_generation: 0,
        withheld: false,
        goes_to: None,
        packets: false,
        unconfirmed: None,
        focus_check: None,
        bar_check: false,
        remote: false,
    }
}

pub(super) const EXCEL: isize = 0x60_3000;
pub(super) const EXCEL_PID: u32 = 7_700;
/// The tick a made-up recording starts at.
pub(super) const START_TICK: u32 = 5_000_000;
/// How long Excel takes to show a key in the formula bar.
pub(super) const EXCEL_LAG_MS: u32 = 5;
/// How long after a press the click pipeline tells the key worker of the click.
pub(super) const NOTED_AFTER_MS: u32 = 3;
/// How long after a press the click's lookup has named what was clicked.
pub(super) const LOOKUP_MS: u32 = 60;
/// Where a click was, for a scene where that doesn't matter: off every window.
pub(super) const NOWHERE: (i32, i32) = (-32_000, -32_000);

pub(super) const VK_SHIFT: u16 = 0x10;
pub(super) const VK_RETURN: u16 = 0x0D;
pub(super) const VK_F2: u16 = 0x71;
pub(super) const VK_OEM_PLUS: u16 = 0xBB;
pub(super) const VK_OEM_PERIOD: u16 = 0xBE;

pub(super) fn excel_window() -> WindowInfo {
    WindowInfo {
        hwnd: EXCEL,
        pid: EXCEL_PID,
        title: "Prices.xlsx - Excel".into(),
        exe_path: Some(r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE".into()),
        frame: rect(0, 0, 1600, 900),
        elevation: Elevation::NotElevated,
        hosted_exe: None,
        class: None,
    }
}

/// A UK or US layout, enough for the tests: letters, digits, `=`, `.`, `+` and `*`.
pub(super) fn us_layout(vkey: u16, held: Modifiers) -> Option<String> {
    let shift = held.shift;
    let text = match (vkey, shift) {
        (VK_OEM_PLUS, false) => "=".to_string(),
        (VK_OEM_PLUS, true) => "+".to_string(),
        (VK_OEM_PERIOD, false) => ".".to_string(),
        (0x38, true) => "*".to_string(),
        (0x20, _) => " ".to_string(),
        _ => {
            let ch = char::from(u8::try_from(vkey).ok()?);
            if ch.is_ascii_digit() && !shift {
                ch.to_string()
            } else if ch.is_ascii_uppercase() {
                if shift { ch } else { ch.to_ascii_lowercase() }.to_string()
            } else {
                return None;
            }
        }
    };
    Some(text)
}

/// The key and whether Shift is held for a character, on that layout.
pub(super) fn key_for(ch: char) -> (u16, bool) {
    match ch {
        '\n' => (VK_RETURN, false),
        '=' => (VK_OEM_PLUS, false),
        '+' => (VK_OEM_PLUS, true),
        '.' => (VK_OEM_PERIOD, false),
        '*' => (0x38, true),
        _ => (
            u16::from(u8::try_from(ch.to_ascii_uppercase()).expect("an ASCII character")),
            ch.is_ascii_uppercase(),
        ),
    }
}

/// The desktop as the key worker sees it: the window the keys go to (Excel unless a scene
/// says otherwise) and any dialogs over it, Excel's formula bar showing, from each moment on,
/// what the cell being typed in holds, and the combo box Windows says has the keyboard.
pub(super) struct FakeDesktop {
    now: Instant,
    tick: u32,
    bar: Vec<(Instant, String)>,
    window: WindowInfo,
    class: String,
    /// Dialogs, each with its class, in front of `window`.
    dialogs: Vec<(WindowInfo, String)>,
    keyboard: Option<ComboBoxEdit>,
    /// The scene's text box, when it has one (#91).
    text_box: Option<FakeTextBox>,
    /// How many times a text box's text was read.
    text_reads: usize,
    /// Whether a window of Windows' text input host shows, from each moment on.
    panel: Vec<(Instant, bool)>,
    /// How many screenshots were taken.
    shots: std::cell::Cell<usize>,
    /// The element UI Automation says has focus, from each moment on: what focus news last told
    /// of, until the scene says otherwise; `None` when it can't be read.
    uia_focus: Vec<(Instant, Option<ElementFacts>)>,
    /// The scene has said what UI Automation says has focus: focus news heard since (stale news
    /// told late) doesn't change it.
    uia_focus_said: bool,
    /// How many times the element with focus was read.
    focus_reads: usize,
    /// How long each read of the element with focus takes, in ms: it says what had focus as it
    /// began, and the clock has moved on by this when it returns (an app slow to answer, #119).
    focus_read_ms: u32,
    /// The class of the control Windows says has the keyboard, from each moment on (#116).
    keyboard_classes: Vec<(Instant, Option<String>)>,
}

/// A text box UI Automation can read (Notepad's, Word's body): named, its text from each
/// moment on, and whether it can be typed in. It's watched once focus news names it.
#[derive(Clone)]
pub(super) struct FakeTextBox {
    name: String,
    editable: bool,
    texts: Vec<(Instant, String)>,
    watched: bool,
}

impl FakeDesktop {
    /// What Windows says has the keyboard, the formula bar, the text box or the text input
    /// host's panels change at `at`.
    fn change(&mut self, at: Instant, happening: Happening) {
        match happening {
            Happening::Keyboard(found) => self.keyboard = found.map(|found| *found),
            Happening::Bar(text) => self.bar.push((at, text)),
            Happening::Text(text) => {
                if let Some(text_box) = self.text_box.as_mut() {
                    text_box.texts.push((at, text));
                }
            }
            Happening::Panel(showing) => self.panel.push((at, showing)),
            Happening::KeyboardClass(class) => self.keyboard_classes.push((at, class)),
            Happening::UiaFocus(facts) => {
                self.uia_focus_said = true;
                self.uia_focus.push((at, facts.map(|facts| *facts)));
            }
            _ => {}
        }
    }

    fn box_text(&mut self) -> Option<String> {
        self.text_reads += 1;
        let now = self.now;
        let text_box = self.text_box.as_ref()?;
        text_box
            .texts
            .iter()
            .rev()
            .find(|(at, _)| *at <= now)
            .map(|(_, text)| text.clone())
    }
}

impl Desktop for FakeDesktop {
    fn window(&mut self, hwnd: isize) -> Option<(WindowInfo, String)> {
        if hwnd == self.window.hwnd {
            return Some((self.window.clone(), self.class.clone()));
        }
        self.dialogs
            .iter()
            .find(|(dialog, _)| dialog.hwnd == hwnd)
            .cloned()
    }

    fn typed_text(&self, vkey: u16, _: u16, held: Modifiers, _: isize) -> Option<String> {
        us_layout(vkey, held)
    }

    fn formula_bar(&mut self, _: isize) -> Option<String> {
        self.bar
            .iter()
            .rev()
            .find(|(at, _)| *at <= self.now)
            .map(|(_, text)| text.clone())
    }

    fn tick_now(&self) -> u32 {
        self.tick
    }

    fn terminal(&self, _: isize, _: TerminalKind) -> Option<String> {
        None
    }

    fn root_at(&self, x: i32, y: i32) -> Option<isize> {
        self.dialogs
            .iter()
            .map(|(dialog, _)| dialog)
            .chain([&self.window])
            .find(|window| PxRect::from(window.frame).contains(x, y))
            .map(|window| window.hwnd)
    }

    fn combo_box_edit(&self, hwnd: isize, _: &[String]) -> Option<ComboBoxEdit> {
        self.keyboard.clone().filter(|_| hwnd == self.window.hwnd)
    }

    fn shoot(&self, _: &WindowInfo, _: &KeyOptions, _: &[String]) -> Option<Shot> {
        self.shots.set(self.shots.get() + 1);
        None
    }

    fn watch_text_box(&mut self, facts: &ElementFacts, _: u32, _: &[String]) -> Option<String> {
        let found = self
            .text_box
            .as_mut()
            .filter(|text_box| text_box.name == facts.name && text_box.editable)?;
        found.watched = true;
        self.box_text()
    }

    fn text_box_text(&mut self) -> Option<String> {
        if !self.text_box.as_ref()?.watched {
            return None;
        }
        self.box_text()
    }

    fn forget_text_box(&mut self) {
        if let Some(text_box) = self.text_box.as_mut() {
            text_box.watched = false;
        }
    }

    fn text_input_panel(&mut self) -> bool {
        self.panel
            .iter()
            .rev()
            .find(|(at, _)| *at <= self.now)
            .is_some_and(|(_, showing)| *showing)
    }

    fn keyboard_class(&self, hwnd: isize) -> Option<String> {
        if hwnd != self.window.hwnd {
            return None;
        }
        self.keyboard_classes
            .iter()
            .rev()
            .find(|(at, _)| *at <= self.now)
            .and_then(|(_, class)| class.clone())
    }

    fn focused_secret(&mut self, _: &[String]) -> Option<bool> {
        self.focus_reads += 1;
        self.tick += self.focus_read_ms;
        let (_, focused) = self
            .uia_focus
            .iter()
            .rev()
            .find(|(at, _)| *at <= self.now)?;
        focused
            .as_ref()
            .map(|facts| facts.is_password || facts.sensitive)
    }
}

/// What happens in a made-up recording, at a moment in ms from its start.
#[derive(Clone)]
pub(super) enum Happening {
    /// A key that went down (or up) at `typed` reaches the key worker: in the window `to`,
    /// or the scene's.
    Key {
        vkey: u16,
        up: bool,
        typed: u32,
        to: Option<isize>,
    },
    /// Windows says this combo box's edit has the keyboard from now on, or none.
    Keyboard(Option<Box<ComboBoxEdit>>),
    /// Windows says a control of this class has the keyboard in the scene's window from now on,
    /// or can't say (#116).
    KeyboardClass(Option<String>),
    /// The click pipeline tells the key worker of a click pressed at `pressed`, at `point`.
    Click { pressed: u32, point: (i32, i32) },
    /// The click pipeline tells the key worker of a click pressed at `pressed`, at `point`, in
    /// the window `window` rather than the scene's (Windows' input panel).
    ClickIn {
        pressed: u32,
        point: (i32, i32),
        window: isize,
    },
    /// The click pipeline passes over the press at `pressed`: it makes no click (a screen the
    /// recording leaves out, the second press of a double-click).
    Passed { pressed: u32 },
    /// The click's lookup has finished: the element it found and the cell it selected, if any.
    /// No element: the lookup failed or timed out.
    Named {
        pressed: u32,
        element: Option<Box<ElementFacts>>,
        cell: Option<String>,
    },
    /// Nothing under the click was read, by design: a remote session's window, Windows' input
    /// panel.
    Unread { pressed: u32 },
    /// UI Automation's focus news, heard by the focus handler at `heard`, reaches the key
    /// worker.
    Focus {
        update: Box<FocusUpdate>,
        heard: u32,
    },
    /// The formula bar shows this from now on.
    Bar(String),
    /// The scene's text box holds this from now on.
    Text(String),
    /// A window of Windows' text input host (the voice typing panel, the emoji panel,
    /// clipboard history) shows from now on, or none does.
    Panel(bool),
    /// UI Automation says this element has focus from now on, whatever focus news the focus
    /// handler heard (Chrome told of no focus change at all); `None`: it can't be read.
    UiaFocus(Option<Box<ElementFacts>>),
    /// The input thread saw a mouse button (or a touch screen, `touch`) go down now, whether
    /// or not the click pipeline passes the click on.
    Pressed { touch: bool },
    /// The recording is paused (`true`) or goes on (`false`).
    Pause(bool),
    /// A program excludes the scene's window's app.
    Exclude(String),
}

/// A made-up recording: in Excel, unless it says which window the keys and clicks go to.
#[derive(Default)]
pub(super) struct Scene {
    happenings: Vec<(u32, Happening)>,
    window: Option<(WindowInfo, String)>,
    dialogs: Vec<(WindowInfo, String)>,
    keyboard: Option<ComboBoxEdit>,
    /// The window the keys added from here on go to; the scene's when `None`.
    key_window: Option<isize>,
    text_box: Option<FakeTextBox>,
    /// How long each read of the element with focus takes, in ms.
    focus_read_ms: u32,
}

impl Scene {
    pub(super) fn at(mut self, ms: u32, happening: Happening) -> Self {
        self.happenings.push((ms, happening));
        self
    }

    /// A text box called `name`, which holds `text` from the start (#91).
    pub(super) fn text_box(mut self, name: &str, editable: bool, text: &str) -> Self {
        self.text_box = Some(FakeTextBox {
            name: name.into(),
            editable,
            texts: Vec::new(),
            watched: false,
        });
        self.text(0, text)
    }

    /// The text box holds `text` from `ms` on: what dictation, or keys, put there.
    pub(super) fn text(self, ms: u32, text: &str) -> Self {
        self.at(ms, Happening::Text(text.into()))
    }

    /// From `ms` on, a window of Windows' text input host shows, or none does.
    pub(super) fn panel(self, ms: u32, showing: bool) -> Self {
        self.at(ms, Happening::Panel(showing))
    }

    /// From `ms` on, UI Automation says `facts` has focus, or can't be read (`None`), whatever
    /// focus news is heard.
    pub(super) fn uia_focus(self, ms: u32, facts: Option<ElementFacts>) -> Self {
        self.at(ms, Happening::UiaFocus(facts.map(Box::new)))
    }

    /// Each read of what UI Automation says has focus takes `ms`: it says what had focus as it
    /// began, and returns that much later on the clock keys are timed by (a busy app, #119).
    pub(super) fn focus_reads_take(mut self, ms: u32) -> Self {
        self.focus_read_ms = ms;
        self
    }

    /// A mouse button went down at `ms` where the click pipeline passes nothing on (another
    /// screen than the one recorded): the input thread still saw it.
    pub(super) fn pressed(self, ms: u32) -> Self {
        self.at(ms, Happening::Pressed { touch: false })
            .at(ms + NOTED_AFTER_MS, Happening::Passed { pressed: ms })
    }

    /// A mouse button went down at `ms`, and the click pipeline never reports the press.
    pub(super) fn press_unreported(self, ms: u32) -> Self {
        self.at(ms, Happening::Pressed { touch: false })
    }

    /// A touch screen or pen reported at `ms`.
    pub(super) fn touched(self, ms: u32) -> Self {
        self.at(ms, Happening::Pressed { touch: true })
    }

    /// A key combination pressed at `ms`: `modifier` held, `vkey` pressed and let go.
    pub(super) fn combo(self, ms: u32, modifier: u16, vkey: u16) -> Self {
        self.key(ms, modifier, false)
            .press(ms + 1, vkey)
            .key(ms + 4, modifier, true)
    }

    /// Keys and clicks go to this window, of this class, instead of Excel's.
    pub(super) fn in_window(mut self, window: WindowInfo, class: &str) -> Self {
        self.window = Some((window, class.into()));
        self
    }

    /// A dialog of this class in front of the scene's window, which keys can go to.
    pub(super) fn with_dialog(mut self, dialog: WindowInfo, class: &str) -> Self {
        self.dialogs.push((dialog, class.into()));
        self
    }

    /// The keys added from here on go to `window`, or back to the scene's with `None`.
    pub(super) fn keys_to(mut self, window: Option<isize>) -> Self {
        self.key_window = window;
        self
    }

    /// Windows says this combo box's edit has the keyboard in the scene's window.
    pub(super) fn keyboard_in(mut self, found: ComboBoxEdit) -> Self {
        self.keyboard = Some(found);
        self
    }

    /// From `ms` on, Windows says this combo box's edit has the keyboard, or none does.
    pub(super) fn keyboard_at(self, ms: u32, found: Option<ComboBoxEdit>) -> Self {
        self.at(ms, Happening::Keyboard(found.map(Box::new)))
    }

    /// From `ms` on, Windows says a control of this class has the keyboard in the scene's
    /// window, or can't say (#116).
    pub(super) fn keyboard_class(self, ms: u32, class: Option<&str>) -> Self {
        self.at(ms, Happening::KeyboardClass(class.map(str::to_string)))
    }

    /// Focus news for an Excel cell, heard and passed on at `ms`.
    pub(super) fn focus_cell(self, ms: u32, cell: &str) -> Self {
        self.focus_cell_heard(ms, ms, cell)
    }

    /// Any focus news, heard and passed on at `ms`.
    pub(super) fn focus(self, ms: u32, update: FocusUpdate) -> Self {
        self.at(
            ms,
            Happening::Focus {
                update: Box::new(update),
                heard: ms,
            },
        )
    }

    /// Focus news for an Excel cell heard at `heard` that reaches the key worker at `ms`.
    pub(super) fn focus_cell_heard(self, ms: u32, heard: u32, cell: &str) -> Self {
        self.at(
            ms,
            Happening::Focus {
                update: Box::new(cell_focus(cell)),
                heard,
            },
        )
    }

    /// A left click on a cell at `ms`, as the click pipeline reports it: at once, then the
    /// cell once its lookup has finished.
    pub(super) fn click(self, ms: u32, cell: &str) -> Self {
        self.click_named(ms, LOOKUP_MS, Some(cell))
    }

    /// A click at `ms` whose lookup took `lookup` ms and named `cell`.
    pub(super) fn click_named(self, ms: u32, lookup: u32, cell: Option<&str>) -> Self {
        self.click_reported(ms, ms + NOTED_AFTER_MS, NOWHERE, lookup, None)
            .at(
                ms + lookup,
                Happening::Named {
                    pressed: ms,
                    element: None,
                    cell: cell.map(str::to_string),
                },
            )
    }

    /// A click at `ms` on `point`, whose lookup found `element` 60 ms later.
    pub(super) fn click_on(self, ms: u32, point: (i32, i32), element: ElementFacts) -> Self {
        self.click_looked_up(ms, LOOKUP_MS, point, Some(element))
    }

    /// A click at `ms` on `point`, whose lookup took `lookup` ms and found `element`.
    pub(super) fn click_looked_up(
        self,
        ms: u32,
        lookup: u32,
        point: (i32, i32),
        element: Option<ElementFacts>,
    ) -> Self {
        self.click_reported(ms, ms + NOTED_AFTER_MS, point, lookup, element)
    }

    /// A click pressed at `ms` on `point` that the click pipeline reports at `reported` (when it
    /// was busy with the click before), its lookup finding `element` `lookup` ms after that.
    pub(super) fn click_reported(
        self,
        ms: u32,
        reported: u32,
        point: (i32, i32),
        lookup: u32,
        element: Option<ElementFacts>,
    ) -> Self {
        let looked_up = reported - NOTED_AFTER_MS + lookup;
        self.at(ms, Happening::Pressed { touch: false })
            .at(reported, Happening::Click { pressed: ms, point })
            .at(
                looked_up,
                Happening::Named {
                    pressed: ms,
                    element: element.map(Box::new),
                    cell: None,
                },
            )
    }

    /// A click at `ms` on `point` in a window where nothing under a click is read, by design (a
    /// remote session's), as the click pipeline reports it.
    pub(super) fn click_unread(self, ms: u32, point: (i32, i32)) -> Self {
        self.at(ms, Happening::Pressed { touch: false })
            .at(ms + NOTED_AFTER_MS, Happening::Click { pressed: ms, point })
            .at(ms + NOTED_AFTER_MS + 1, Happening::Unread { pressed: ms })
    }

    /// As [`Scene::click_unread`], in the window `window`, not the scene's: Windows' input panel,
    /// which never takes focus from the window keys go to.
    pub(super) fn click_unread_in(self, ms: u32, window: isize, point: (i32, i32)) -> Self {
        self.at(ms, Happening::Pressed { touch: false })
            .at(
                ms + NOTED_AFTER_MS,
                Happening::ClickIn {
                    pressed: ms,
                    point,
                    window,
                },
            )
            .at(ms + NOTED_AFTER_MS + 1, Happening::Unread { pressed: ms })
    }

    /// The formula bar shows `text` from `ms` on.
    pub(super) fn bar(self, ms: u32, text: &str) -> Self {
        self.at(ms, Happening::Bar(text.into()))
    }

    /// A key going down (or up) at `ms`, reaching the key worker at once.
    pub(super) fn key(self, ms: u32, vkey: u16, up: bool) -> Self {
        let to = self.key_window;
        self.at(
            ms,
            Happening::Key {
                vkey,
                up,
                typed: ms,
                to,
            },
        )
    }

    /// One key pressed and let go at `ms`.
    pub(super) fn press(self, ms: u32, vkey: u16) -> Self {
        self.key(ms, vkey, false).key(ms + 2, vkey, true)
    }

    /// One key pressed and let go at `ms` that reaches the key worker only at `reaches`.
    pub(super) fn press_reaching(self, ms: u32, reaches: u32, vkey: u16) -> Self {
        let to = self.key_window;
        self.at(
            reaches,
            Happening::Key {
                vkey,
                up: false,
                typed: ms,
                to,
            },
        )
        .at(
            reaches,
            Happening::Key {
                vkey,
                up: true,
                typed: ms + 2,
                to,
            },
        )
    }

    /// `text` typed into a new entry, a key every `gap` ms from `from` ("\n" is Enter).
    pub(super) fn type_keys(self, from: u32, gap: u32, text: &str) -> Self {
        self.type_into(from, gap, "", text)
    }

    /// `text` typed a key every `gap` ms from `from` into something other than the cell, such as
    /// a pane's box in Excel's window: the formula bar never shows it.
    pub(super) fn type_keys_unshown(mut self, from: u32, gap: u32, text: &str) -> Self {
        for (index, ch) in text.chars().enumerate() {
            let ms = from + gap * u32::try_from(index).expect("a short text");
            let (vkey, shift) = key_for(ch);
            if shift {
                self = self.key(ms, VK_SHIFT, false);
            }
            self = self.press(ms, vkey);
            if shift {
                self = self.key(ms + 3, VK_SHIFT, true);
            }
        }
        self
    }

    /// `text` typed into a cell whose entry already holds `before` (after F2), a key every
    /// `gap` ms from `from`. Excel shows each key in the formula bar a moment later; Enter puts
    /// the entry in and moves to an empty cell.
    pub(super) fn type_into(mut self, from: u32, gap: u32, before: &str, text: &str) -> Self {
        let mut entry = before.to_string();
        for (index, ch) in text.chars().enumerate() {
            let ms = from + gap * u32::try_from(index).expect("a short text");
            let (vkey, shift) = key_for(ch);
            if shift {
                self = self.key(ms, VK_SHIFT, false);
            }
            self = self.press(ms, vkey);
            if shift {
                self = self.key(ms + 3, VK_SHIFT, true);
            }
            if ch == '\n' {
                entry.clear();
            } else {
                entry.push(ch);
            }
            self = self.bar(ms + EXCEL_LAG_MS, &entry);
        }
        self
    }
}

pub(super) fn cell_focus(cell: &str) -> FocusUpdate {
    FocusUpdate {
        window: EXCEL,
        facts: ElementFacts {
            control_type: "DataItem".into(),
            class_name: "XLSpreadsheetCell".into(),
            name: cell.into(),
            bounds: Some(PxRect {
                left: 300,
                top: 200,
                right: 364,
                bottom: 220,
            }),
            ..ElementFacts::default()
        },
        field: false,
        address_bar: false,
        tick_ms: 0,
        pid: EXCEL_PID,
    }
}

/// Runs the real key worker through a scene, a turn every 10 ms as it runs on its thread,
/// and gives the typing records it made.
pub(super) fn record(scene: Scene) -> Vec<TypingRecord> {
    recorded(scene).0
}

/// As [`record`], with how many times the text box was read.
pub(super) fn recorded(scene: Scene) -> (Vec<TypingRecord>, usize) {
    let (records, reads, _) = run(scene);
    (records, reads)
}

/// As [`record`], with how many screenshots were taken.
pub(super) fn photographed(scene: Scene) -> (Vec<TypingRecord>, usize) {
    let (records, _, shots) = run(scene);
    (records, shots)
}

/// As [`record`], with how many times the element with focus was read.
pub(super) fn focus_read(scene: Scene) -> (Vec<TypingRecord>, usize) {
    let (records, _, _, reads) = run_counting(scene);
    (records, reads)
}

/// Runs the real key worker through a scene: the typing records it made, how many times the
/// text box was read and how many screenshots were taken.
fn run(scene: Scene) -> (Vec<TypingRecord>, usize, usize) {
    let (records, reads, shots, _) = run_counting(scene);
    (records, reads, shots)
}

/// As [`run`], with how many times the element with focus was read.
#[allow(
    clippy::too_many_lines,
    reason = "one arm for each thing a scene can do"
)]
fn run_counting(scene: Scene) -> (Vec<TypingRecord>, usize, usize, usize) {
    let mut happenings = scene.happenings;
    happenings.sort_by_key(|(ms, _)| *ms);
    let (window, class) = scene
        .window
        .unwrap_or_else(|| (excel_window(), excel::WINDOW_CLASS.to_string()));
    let hwnd = window.hwnd;
    let start = Instant::now();
    let at = |ms: u32| start + Duration::from_millis(u64::from(ms));
    let focus = SharedFocus::default();
    let clicks = Arc::new(ClickNews::default());
    let machine = Arc::new(Mutex::new(RecorderStateMachine::new(Vec::new())));
    machine
        .lock()
        .expect("the machine")
        .start()
        .expect("a recording starts");
    let (out, records) = channel();
    let links = Links {
        machine: Arc::clone(&machine),
        focus: Arc::clone(&focus),
        options: KeyOptions {
            output: false,
            settle: Duration::from_millis(1_500),
            extra_terms: Vec::new(),
            mode: CaptureMode::Window,
            target_monitor: None,
        },
        out,
        clicks: Arc::clone(&clicks),
    };
    let desktop = FakeDesktop {
        now: start,
        tick: START_TICK,
        bar: Vec::new(),
        window,
        class,
        dialogs: scene.dialogs,
        keyboard: scene.keyboard,
        text_box: scene.text_box,
        text_reads: 0,
        panel: Vec::new(),
        shots: std::cell::Cell::new(0),
        uia_focus: Vec::new(),
        uia_focus_said: false,
        focus_reads: 0,
        focus_read_ms: scene.focus_read_ms,
        keyboard_classes: Vec::new(),
    };
    let mut worker = Worker::new(
        desktop,
        links,
        FocusNote::default(),
        Pointer::default(),
        false,
    );
    let end = happenings.last().map_or(0, |(ms, _)| *ms) + 2_000;
    let mut next = happenings.iter().peekable();
    let mut pointer = Pointer::default();
    for ms in (0..=end).step_by(10) {
        worker.desktop.now = at(ms);
        worker.desktop.tick = START_TICK + ms;
        let mut arrived = Vec::new();
        while let Some((when, happening)) = next.next_if(|(when, _)| *when <= ms) {
            match happening.clone() {
                Happening::Key {
                    vkey,
                    up,
                    typed,
                    to,
                } => arrived.push(KeyEvent {
                    tick_ms: START_TICK + typed,
                    vkey,
                    scan: 0,
                    extended: false,
                    up,
                    injected: true,
                    foreground: to.unwrap_or(hwnd),
                }),
                report @ (Happening::Click { .. }
                | Happening::ClickIn { .. }
                | Happening::Passed { .. }
                | Happening::Named { .. }
                | Happening::Unread { .. }) => report_click(&clicks, hwnd, report),
                Happening::Focus { update, heard } => {
                    // UI Automation says it has focus, as the focus handler heard, unless the
                    // scene has said otherwise.
                    if !worker.desktop.uia_focus_said {
                        worker
                            .desktop
                            .uia_focus
                            .push((at(*when), Some(update.facts.clone())));
                    }
                    focus
                        .lock()
                        .expect("the focus note")
                        .focus_now(FocusUpdate {
                            tick_ms: START_TICK + heard,
                            ..*update
                        });
                }
                Happening::Pressed { touch: false } => pointer.press = Some(START_TICK + when),
                Happening::Pressed { touch: true } => pointer.touch = Some(START_TICK + when),
                change @ (Happening::Keyboard(_)
                | Happening::KeyboardClass(_)
                | Happening::Bar(_)
                | Happening::Text(_)
                | Happening::Panel(_)
                | Happening::UiaFocus(_)) => worker.desktop.change(at(*when), change),
                change @ (Happening::Pause(_) | Happening::Exclude(_)) => {
                    change_recording(&machine, START_TICK + when, change);
                }
            }
        }
        worker.turn(at(ms), false, arrived, 0, pointer);
    }
    worker.turn(at(end + 10), true, Vec::new(), 0, pointer);
    let (reads, shots) = (worker.desktop.text_reads, worker.desktop.shots.get());
    let focus_reads = worker.desktop.focus_reads;
    drop(worker);
    (typing_records(&records), reads, shots, focus_reads)
}

/// The click pipeline reports a press, as a click in the window `hwnd` or passed over, or what
/// a click's lookup found.
fn report_click(clicks: &ClickNews, hwnd: isize, report: Happening) {
    match report {
        Happening::Click { pressed, point } => {
            clicks.press(START_TICK + pressed).clicked(hwnd, point);
        }
        Happening::ClickIn {
            pressed,
            point,
            window,
        } => clicks.press(START_TICK + pressed).clicked(window, point),
        Happening::Passed { pressed } => drop(clicks.press(START_TICK + pressed)),
        Happening::Named {
            pressed,
            element,
            cell,
        } => {
            let looked = element.map_or(Looked::Failed, Looked::Found);
            clicks.named(START_TICK + pressed, looked, cell);
        }
        Happening::Unread { pressed } => clicks.named(START_TICK + pressed, Looked::Unread, None),
        _ => {}
    }
}

/// The typing records the key worker sent.
pub(super) fn typing_records(
    records: &std::sync::mpsc::Receiver<KeyedRecord>,
) -> Vec<TypingRecord> {
    records
        .try_iter()
        .filter_map(|(record, _)| match record {
            Record::Typing(typing) => Some(typing),
            _ => None,
        })
        .collect()
}

/// A pause, the recording going on, or an app excluded, at `tick`.
pub(super) fn change_recording(
    machine: &Mutex<RecorderStateMachine>,
    tick: u32,
    change: Happening,
) {
    let mut machine = machine.lock().expect("the machine");
    match change {
        Happening::Pause(true) => machine.pause(PauseReason::User, tick).expect("pauses"),
        Happening::Pause(false) => machine.resume(tick).expect("goes on"),
        Happening::Exclude(exe) => {
            machine.add_excluded_app(&exe);
        }
        _ => {}
    }
}

/// Each typing step's cell and text.
pub(super) fn cells(records: &[TypingRecord]) -> Vec<(Option<&str>, &str)> {
    records
        .iter()
        .map(|record| (record.cell.as_deref(), record.text.as_str()))
        .collect()
}

/// Each typing step's element and text.
pub(super) fn typed_in(records: &[TypingRecord]) -> Vec<(Option<&str>, &str)> {
    records
        .iter()
        .map(|record| {
            let element = record.element.as_ref().map(|facts| facts.name.as_str());
            (element, record.text.as_str())
        })
        .collect()
}

// ---------- Word's Encrypt Document dialog, and a notification taking focus (10/10/2026) ----------

pub(super) const WORD_PID: u32 = 26_180;

pub(super) const TOAST_PID: u32 = 9_000;

pub(super) const DIALOG: isize = 0x40_1000;

pub(super) const TOAST_WINDOW: isize = 0x50_2000;

/// A password, typed as in the Word case.
pub(super) const TYPED: &str = "Tr0ub4dor&3";

/// What a notification's text looked like; never a field's name.
pub(super) const TOAST_NAME: &str = "New notification from ChatApp, Sam, see you at 5";

/// Word's "Encrypt Document" dialog, the window the keys went to.
pub(super) fn encrypt_dialog() -> WindowInfo {
    WindowInfo {
        hwnd: DIALOG,
        pid: WORD_PID,
        title: "Encrypt Document".into(),
        exe_path: Some(r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE".into()),
        frame: rect(807, 404, 1113, 621),
        elevation: Elevation::NotElevated,
        hosted_exe: None,
        class: None,
    }
}

pub(super) fn password_box() -> FocusUpdate {
    FocusUpdate {
        window: DIALOG,
        facts: ElementFacts {
            control_type: "Edit".into(),
            name: "Password".into(),
            is_password: true,
            sensitive: true,
            bounds: Some(PxRect {
                left: 830,
                top: 480,
                right: 1090,
                bottom: 505,
            }),
            ..ElementFacts::default()
        },
        field: false,
        address_bar: false,
        tick_ms: 1_000,
        pid: WORD_PID,
    }
}

/// A chat app's notification: Windows' toast took UI Automation's focus, while the window in
/// front, where the keys went, was still Word's dialog.
pub(super) fn toast() -> FocusUpdate {
    FocusUpdate {
        window: DIALOG,
        facts: ElementFacts {
            control_type: "Window".into(),
            class_name: "FlexibleToastView".into(),
            automation_id: "NormalToastView".into(),
            framework_id: "XAML".into(),
            name: TOAST_NAME.into(),
            is_password: false,
            sensitive: false,
            bounds: Some(PxRect {
                left: 1540,
                top: 810,
                right: 1904,
                bottom: 1019,
            }),
            ..ElementFacts::default()
        },
        field: false,
        address_bar: false,
        tick_ms: 1_400,
        pid: TOAST_PID,
    }
}

pub(super) fn noted(updates: &[FocusUpdate]) -> FocusNote {
    let mut note = FocusNote::default();
    for update in updates {
        note.focus_now(update.clone());
    }
    note
}

/// The top-level window at a point, as the screen was: the toast in its corner.
#[allow(
    clippy::unnecessary_wraps,
    reason = "stands in for `root_at`, which finds no window over the bare desktop"
)]
pub(super) fn screen(x: i32, y: i32) -> Option<isize> {
    if PxRect::from(rect(1540, 810, 1904, 1019)).contains(x, y) {
        Some(TOAST_WINDOW)
    } else if PxRect::from(rect(807, 404, 1113, 621)).contains(x, y) {
        Some(DIALOG)
    } else {
        None
    }
}
