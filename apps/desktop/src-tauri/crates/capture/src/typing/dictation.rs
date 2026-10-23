//! Dictation into the text box with focus (docs/spec/02-capture.md#dictation, #91): Windows voice
//! typing hands text to the app with no keys, so the box is read through UI Automation as focus
//! comes to it and when a stretch of time ends (a click, as it's heard of; a focus change; a key
//! combination such as Win+H; Pause; Stop), never per key. What was added during a stretch with
//! no key that types is a typing step, with its value only when voice typing was evidently in
//! use: Win+H began the stretch, or the voice typing panel showed as focus came, and no mouse
//! button or touch went down that could have pasted, picked from clipboard history or the emoji
//! panel, or dropped text instead; otherwise it's "Type" with no value (12/10/2026). One reason
//! to change: when the box is read, and whether what was added keeps its value. What was added
//! is found by `crate::dictation`.

use std::collections::VecDeque;
use std::time::Instant;

use crate::excel;
use crate::facts::{CaptureFacts, ElementFacts, Record, TypingRecord};
use crate::keys::Combo;
use crate::platform::input::{InputShared, KeyEvent};
use crate::platform::window::WindowInfo;
use crate::programs::{is_code_editor, window_facts};
use crate::screen_text::TerminalKind;
use crate::screenshot::Shot;
use crate::sensitive::mask_value;
use crate::state_machine::EventDecision;

use super::{Desktop, FocusNote, Worker, element_in_window};

/// How long after a mouse button or touch went down what it did can still come into a text box:
/// a paste chosen from a menu, a pick from clipboard history or the emoji panel, a drop. Text
/// added after focus came to a box this soon after one keeps no value (12/10/2026).
const PRESS_EFFECTS_MS: u32 = 1_000;

/// How soon before focus came to a text box Win+H, pressed in its window, began voice typing in
/// it: UI Automation's news of a click's focus can come after a quick Win+H.
const VOICE_KEY_LEAD_MS: u32 = 1_000;

/// How long before a click's press a touch screen reports the tap that made it.
const TAP_LEAD_MS: u32 = 100;

/// The mouse presses and touches remembered, for telling whether one came during a stretch.
const PRESSES_KEPT: usize = 64;

/// The text box with focus, watched for what dictation puts into it (#91): its text as the
/// current stretch of time began, read again when the stretch ends at a click, a focus change, a
/// key combination, Pause or Stop. What was added with no key that types is dictation when voice
/// typing was evidently in use (12/10/2026).
struct Watch {
    /// The window it's in.
    hwnd: isize,
    element: ElementFacts,
    /// Its text as the stretch began, when that was read, and the tick then.
    text: String,
    read: Instant,
    since: u32,
    /// A key that types (or a Unicode packet) came during the stretch: what changed is the keys'.
    keyed: bool,
    /// Voice typing was evidently in use as the stretch began: only then is what's added kept as
    /// the step's value (12/10/2026).
    voice: bool,
    /// A mouse button or touch going down from this tick on, before the reading that ends the
    /// stretch, may have put text in it by other means: from the Win+H that began it, or from
    /// [`PRESS_EFFECTS_MS`] before focus came.
    from: u32,
}

/// What began a stretch of time in the watched text box, which says whether what's added during
/// it can be dictation (12/10/2026).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Began {
    /// Win+H, which starts (and stops) Windows voice typing.
    VoiceKey,
    /// Focus came to the box, or the recording started or went on after a pause.
    Focus,
    /// A click, or a key combination other than Win+H.
    Other,
}

/// How a stretch of time in the watched text box ended.
#[derive(Debug, Clone, Copy)]
pub(super) enum Ended {
    /// A click pressed at `tick`. `heard`: the box was read as the click was heard of, before it
    /// could act; otherwise only once it was handled, so what it put in may be in the reading.
    Click { tick: u32, heard: bool },
    /// A key combination pressed, or focus news heard, at this tick.
    At(u32),
    /// Pause or Stop.
    Now,
}

impl Ended {
    fn tick(self) -> Option<u32> {
        match self {
            Self::Click { tick, .. } | Self::At(tick) => Some(tick),
            Self::Now => None,
        }
    }

    /// The box was read only now, not as the click was heard of.
    fn read_late(self) -> Self {
        match self {
            Self::Click { tick, .. } => Self::Click { tick, heard: false },
            other => other,
        }
    }
}

/// The watched text box, read as a stretch of time ended.
pub(super) struct Reading {
    /// `None` when it couldn't be read.
    text: Option<String>,
    at: Instant,
    /// When it was read, on the clock key events are timed by.
    tick: u32,
    /// Taken then, when something was added.
    shot: Option<Shot>,
}

/// When a mouse button and a touch screen or pen last went down, as the input thread saw them,
/// whether or not the click pipeline passed the click on (a screen the recording leaves out).
/// Never where, or which button.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Pointer {
    pub(super) press: Option<u32>,
    pub(super) touch: Option<u32>,
}

impl Pointer {
    pub(super) fn of(shared: &InputShared) -> Self {
        Self {
            press: shared.last_press(),
            touch: shared.last_touch(),
        }
    }
}

/// What the key worker keeps for dictation (#91): the text box it watches, and the signs of
/// whether what comes into it is voice typing: Win+H, the panels of the program that draws
/// voice typing's, and the presses and touches that could have put text in by other means.
pub(super) struct Dictation {
    /// The text box with focus, read for dictation.
    watch: Option<Watch>,
    /// The focus as the recording began or went on after a pause is still to be watched.
    pub(super) due: bool,
    /// A key combination with the Windows key other than Win+H came since the last Win+H: the
    /// text input host's window may be clipboard history's or the emoji panel's (12/10/2026).
    other_panel: bool,
    /// The last key combination, when it was Win+H: when, and the window in front.
    voice_key: Option<(u32, isize)>,
    presses: Presses,
    /// The watched box's text, read just now as a click ended typing that may have gone into it
    /// (#97 third review): the click's cut takes it rather than reading the box again.
    read_now: Option<ReadNow>,
}

/// The watched box's text as read just now: `None` when it couldn't be read.
struct ReadNow(Option<String>);

impl Dictation {
    /// Watching nothing yet, the focus as the recording began still to be watched, with
    /// `pointer` the input thread's presses before it.
    pub(super) fn new(pointer: Pointer) -> Self {
        Self {
            watch: None,
            due: true,
            other_panel: false,
            voice_key: None,
            read_now: None,
            presses: Presses {
                pointer,
                seen: VecDeque::new(),
                forgotten: None,
            },
        }
    }

    /// A key that types (or a Unicode packet) came, wherever it went: whatever it put in the
    /// watched text box is the keys', never dictation.
    pub(super) fn keyed(&mut self) {
        if let Some(watch) = self.watch.as_mut() {
            watch.keyed = true;
        }
    }

    /// Notes a key combination, wherever it went (12/10/2026): Win+H's time and window, for focus
    /// that comes to a box just after it; and whether another panel of the text input host may be
    /// showing. Win+V (clipboard history) and Win+. (the emoji panel) open panels of the program
    /// that draws the voice typing panel too, so after any Windows-key combination but Win+H its
    /// window showing is no sign of voice typing until Win+H again.
    pub(super) fn note_combination(&mut self, combo: Combo, event: &KeyEvent) {
        let voice = combo.is_voice_typing();
        if combo.win {
            self.other_panel = !voice;
        }
        self.voice_key = voice.then_some((event.tick_ms, event.foreground));
    }

    /// Notes the mouse presses and touches the input thread saw since the last turn.
    pub(super) fn note_pointer(&mut self, pointer: Pointer) {
        self.presses.note(pointer);
    }

    /// The watched box's text, read just now as typing ended, for the cut that follows.
    pub(super) fn read_now(&mut self, text: Option<String>) {
        self.read_now = Some(ReadNow(text));
    }

    /// Forgets a reading the cut about to be made didn't come from.
    pub(super) fn forget_read_now(&mut self) {
        self.read_now = None;
    }

    /// Whether the text box watched now is `element`, in the window `hwnd`.
    pub(super) fn watching(&self, hwnd: isize, element: &ElementFacts) -> bool {
        self.watch
            .as_ref()
            .is_some_and(|watch| watch.hwnd == hwnd && watch.element == *element)
    }

    /// The text box watched now in the window `hwnd`, and its text as last read: what keys a
    /// click couldn't say the place of are checked against (#97 third review).
    pub(super) fn watched_in(&self, hwnd: isize) -> Option<(ElementFacts, String)> {
        self.watch
            .as_ref()
            .filter(|watch| watch.hwnd == hwnd)
            .map(|watch| (watch.element.clone(), watch.text.clone()))
    }
}

/// The mouse presses and touches the input thread saw, for telling whether one came during a
/// stretch of time.
struct Presses {
    /// The input thread's last presses as last seen.
    pointer: Pointer,
    /// Seen since the recording began, oldest first.
    seen: VecDeque<u32>,
    /// The latest one let go of to keep within [`PRESSES_KEPT`].
    forgotten: Option<u32>,
}

impl Presses {
    /// Notes the mouse presses and touches the input thread saw since the last turn.
    fn note(&mut self, pointer: Pointer) {
        let seen = [
            (self.pointer.press, pointer.press),
            (self.pointer.touch, pointer.touch),
        ];
        self.pointer = pointer;
        for (before, now) in seen {
            if let Some(tick) = now
                && before != now
            {
                if self.seen.len() >= PRESSES_KEPT {
                    self.forgotten = self.seen.pop_front();
                }
                self.seen.push_back(tick);
            }
        }
    }

    /// Whether a mouse button or touch went down from `from` to `to`, other than the click at
    /// `click` (with the touch screen's reports of the tap that made it).
    fn between(&self, from: u32, to: u32, click: Option<u32>) -> bool {
        use crate::state_machine::tick_before_or_at as by;
        let the_click = |tick: u32| {
            click.is_some_and(|click| by(click.wrapping_sub(TAP_LEAD_MS), tick) && by(tick, click))
        };
        self.seen
            .iter()
            .any(|&tick| by(from, tick) && by(tick, to) && !the_click(tick))
            // One let go of may have been in it.
            || self.forgotten.is_some_and(|tick| by(from, tick))
    }

    /// Whether nothing but voice typing can have put text into the watched box in a stretch, as
    /// far as can be told (12/10/2026): no mouse button or touch went down in it, or just before
    /// focus came, other than the click that ended it, and that click was read as it was heard of,
    /// before what it does (a paste from a menu, a pick from a panel, a drop) could come in.
    fn nothing_but_voice(&self, watch: &Watch, reading: &Reading, ended: Ended) -> bool {
        match ended {
            Ended::Click { heard: false, .. } => false,
            Ended::Click { tick, .. } => !self.between(watch.from, tick, Some(tick)),
            Ended::At(_) | Ended::Now => !self.between(watch.from, reading.tick, None),
        }
    }
}

impl<D: Desktop> Worker<D> {
    /// Starts watching the text box that has focus as of the keys handled so far, when it's one
    /// dictation can be read from (`watchable`).
    pub(super) fn watch_focus(&mut self, now: Instant) {
        self.forget_watch();
        // Focus has moved on since: its news says where.
        if !self.pending_focus.is_empty() {
            return;
        }
        let note = self.applied.clone();
        if !self.watchable(&note) {
            return;
        }
        let Some(text) =
            self.desktop
                .watch_text_box(&note.facts, note.pid, &self.options.extra_terms)
        else {
            return;
        };
        let since = self.desktop.tick_now();
        // Win+H pressed in this window just before: UI Automation's news of a click's focus can
        // come after a quick Win+H, which then began no stretch here.
        let key = self.dictation.voice_key.and_then(|(key, hwnd)| {
            (hwnd == note.window
                && crate::state_machine::tick_before_or_at(
                    since.wrapping_sub(VOICE_KEY_LEAD_MS),
                    key,
                ))
            .then_some(key)
        });
        let (began, from) = match key {
            Some(key) => (Began::VoiceKey, key),
            None => (Began::Focus, since.wrapping_sub(PRESS_EFFECTS_MS)),
        };
        let voice = self.voice_typing(began);
        self.dictation.watch = Some(Watch {
            hwnd: note.window,
            element: note.facts,
            text,
            read: now,
            since,
            keyed: false,
            voice,
            from,
        });
    }

    /// Whether voice typing is evidently in use for a stretch begun by `began` (12/10/2026): Win+H
    /// began it, or the voice typing panel shows as focus comes to the box: the text input host's
    /// window, when no other panel of it was opened since the last Win+H.
    fn voice_typing(&mut self, began: Began) -> bool {
        match began {
            Began::VoiceKey => true,
            Began::Focus => !self.dictation.other_panel && self.desktop.text_input_panel(),
            Began::Other => false,
        }
    }

    fn forget_watch(&mut self) {
        if self.dictation.watch.take().is_some() {
            self.desktop.forget_text_box();
        }
    }

    /// Whether the element with focus is a text box whose dictation is read: an element of the
    /// window in front (10/10/2026), in a window things are kept from, never a password or
    /// sensitive box or a window a password box has had focus in, nor a field read as focus
    /// leaves it, a browser's address bar, a terminal, Excel or a code editor, whose typing is
    /// recorded their own ways.
    fn watchable(&mut self, note: &FocusNote) -> bool {
        if note.field || note.address_bar || note.secret() || !self.lock_machine().is_active() {
            return false;
        }
        let Some((window, class)) = self.window(note.window) else {
            return false;
        };
        if !self.may_keep_from(&window)
            || TerminalKind::from_class(&class).is_some()
            || class == excel::WINDOW_CLASS
            || window.exe_name().is_some_and(is_code_editor)
        {
            return false;
        }
        element_in_window(note, &window, |x, y| self.desktop.root_at(x, y)).is_some()
    }

    /// Whether what was dictated into a box in `window` may be kept: not one of Steps' own or an
    /// excluded app's windows, one a password box has had focus in since the last click, or one
    /// titled for a password.
    fn may_keep_from(&self, window: &WindowInfo) -> bool {
        !self.blocked(window)
            && !self.password.covers(window.hwnd)
            && !crate::sensitive::looks_sensitive(
                &[window.title.as_str()],
                &self.options.extra_terms,
            )
    }

    /// The watched text box read as a click at `tick` is heard of, unless keys typed before it
    /// already make what changed theirs: those still to be handled count too.
    pub(super) fn read_at_click(&mut self, tick: u32, now: Instant) -> Option<Reading> {
        let watch = self.dictation.watch.take()?;
        let keyed = watch.keyed
            || self.pending.iter().any(|(_, key)| {
                !key.up
                    && !crate::keys::is_modifier(key.vkey)
                    && crate::state_machine::tick_before_or_at(key.tick_ms, tick)
            });
        let reading = (!keyed).then(|| self.read_watched(&watch, now));
        self.dictation.watch = Some(watch);
        reading
    }

    /// The watched text box now, with a screenshot when something was added to it.
    fn read_watched(&mut self, watch: &Watch, now: Instant) -> Reading {
        let text = self.desktop.text_box_text();
        let added = text
            .as_deref()
            .and_then(|text| crate::dictation::dictated(&watch.text, text));
        let shot = added
            .and_then(|_| self.window(watch.hwnd))
            .and_then(|(window, _)| self.shoot(&window));
        Reading {
            text,
            at: now,
            // After the read: a press while it was being read may be in it too.
            tick: self.desktop.tick_now(),
            shot,
        }
    }

    /// A stretch of time `ended` with a click or a key combination, focus still in the watched
    /// text box: what was dictated during it is a step, and the next, begun by `next`, is watched
    /// from now. `reading` is the box as the click was heard of.
    pub(super) fn dictation_cut(
        &mut self,
        reading: Option<Reading>,
        ended: Ended,
        next: Began,
        now: Instant,
    ) {
        let read_now = self.dictation.read_now.take().map(|ReadNow(text)| text);
        let Some(watch) = self.dictation.watch.take() else {
            return;
        };
        let mut fresh = read_now;
        if !watch.keyed {
            // A reading from before the stretch began says nothing of it.
            let (reading, ended) =
                if let Some(reading) = reading.filter(|reading| reading.at >= watch.read) {
                    (reading, ended)
                } else {
                    let reading = self.read_watched(&watch, now);
                    fresh = Some(reading.text.clone());
                    (reading, ended.read_late())
                };
            self.write_dictation(&watch, reading, ended);
        }
        match fresh.unwrap_or_else(|| self.desktop.text_box_text()) {
            Some(text) => {
                let since = self.desktop.tick_now();
                // Presses count from Win+H on: one before it is what it was pressed after.
                let from = match (next, ended) {
                    (Began::VoiceKey, Ended::At(key)) => key,
                    _ => since,
                };
                self.dictation.watch = Some(Watch {
                    text,
                    read: now,
                    since,
                    keyed: false,
                    voice: self.voice_typing(next),
                    from,
                    ..watch
                });
            }
            None => self.desktop.forget_text_box(),
        }
    }

    /// Focus left the watched text box (`Ended::At`), or the recording paused or stopped
    /// (`Ended::Now`): what was dictated since the last read is a step, and the box is no longer
    /// watched.
    pub(super) fn end_watch(&mut self, ended: Ended, now: Instant) {
        // Typing that may have gone into the box is checked against it as it was when focus left.
        self.read_unconfirmed();
        let Some(watch) = self.dictation.watch.take() else {
            return;
        };
        if !watch.keyed {
            let reading = self.read_watched(&watch, now);
            self.write_dictation(&watch, reading, ended);
        }
        self.desktop.forget_text_box();
    }

    /// The typing step for what was added to the watched text box during a stretch of time with
    /// no keys, when there's anything: only the added text, masked as typed text is, when voice
    /// typing was evidently in use and nothing else can have put text in; otherwise "Type" with
    /// no value, as for text another program typed (12/10/2026). Never when the stretch was
    /// paused, began before Start again, or the window may keep nothing.
    fn write_dictation(&mut self, watch: &Watch, reading: Reading, ended: Ended) {
        let end = ended.tick();
        let Some(added) = reading
            .text
            .as_deref()
            .and_then(|text| crate::dictation::dictated(&watch.text, text))
        else {
            return;
        };
        {
            let machine = self.lock_machine();
            let process = |tick| machine.should_process_event(tick) == EventDecision::Process;
            if !process(watch.since)
                || end.is_some_and(|end| !process(end) || machine.paused_between(watch.since, end))
            {
                return;
            }
        }
        let Some((window, _)) = self.window(watch.hwnd) else {
            return;
        };
        if !self.may_keep_from(&window) {
            return;
        }
        let dictated = watch.voice
            && self
                .dictation
                .presses
                .nothing_but_voice(watch, &reading, ended);
        let shot = reading.shot.or_else(|| self.shoot(&window));
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.options.mode));
        let record = Record::Typing(TypingRecord {
            id,
            tick_ms: watch.since,
            window: window_facts(&window),
            capture,
            element: Some(watch.element.clone()),
            text: if dictated {
                crate::lookup::fit_value(mask_value(&added))
            } else {
                String::new()
            },
            form: "text",
            language: "plain",
            cell: None,
            approximate: false,
            check_screenshot: false,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }
}

#[cfg(test)]
mod tests {
    use crate::typing::scene::*;

    const NOTEPAD: isize = 0x80_5000;
    const NOTEPAD_PID: u32 = 6_400;
    const VK_LWIN: u16 = 0x5B;
    /// Notepad's text box, as UI Automation names it.
    const TEXT_EDITOR: &str = "Text editor";
    const SENTENCE: &str = "Thanks for your email, I'll call you on Monday.";

    fn notepad() -> WindowInfo {
        WindowInfo {
            hwnd: NOTEPAD,
            pid: NOTEPAD_PID,
            title: "Untitled - Notepad".into(),
            exe_path: Some(
                r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2508.38.0_x64__8wekyb3d8bbwe\Notepad\Notepad.exe"
                    .into(),
            ),
            frame: rect(100, 100, 1100, 800),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    /// UI Automation's news of Notepad's text box getting focus: a document, not a field whose
    /// value is read when focus leaves it.
    fn text_editor_focus() -> FocusUpdate {
        FocusUpdate {
            window: NOTEPAD,
            facts: ElementFacts {
                control_type: "Document".into(),
                name: TEXT_EDITOR.into(),
                class_name: "RichEditD2DPT".into(),
                bounds: Some(PxRect {
                    left: 110,
                    top: 180,
                    right: 1090,
                    bottom: 760,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: NOTEPAD_PID,
        }
    }

    /// Notepad with its text box holding `text`, clicked into and with focus.
    fn in_notepad(text: &str) -> Scene {
        Scene::default()
            .in_window(notepad(), "Notepad")
            .text_box(TEXT_EDITOR, true, text)
            .click_named(400, 60, None)
            .focus(450, text_editor_focus())
    }

    /// Win+H, which starts and stops Windows voice typing, pressed at `ms`.
    fn win_h(scene: Scene, ms: u32) -> Scene {
        scene.combo(ms, VK_LWIN, u16::from(b'H'))
    }

    #[test]
    fn a_sentence_dictated_into_notepad_is_typing_in_its_text_box() {
        // Win+H and a sentence spoken: Windows hands the text to Notepad, and no key comes. Only
        // what the dictation added is the step's, not what the box held before.
        let records = record(
            win_h(in_notepad("Dear Sam,\n"), 1_000)
                .text(2_500, &format!("Dear Sam,\n{SENTENCE}"))
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), SENTENCE)]);
    }

    #[test]
    fn text_put_in_with_no_keys_and_no_sign_of_voice_typing_keeps_no_value() {
        // No Win+H and no voice typing panel: the text could have come from anywhere (12/10/2026).
        // The step says only that something was typed there.
        let records = record(
            in_notepad("Dear Sam,\n")
                .text(2_500, &format!("Dear Sam,\n{SENTENCE}"))
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "")]);
    }

    /// Notepad with its text box holding `text`, focus coming to it with no click (Tab, or the
    /// recording started there).
    fn notepad_focused(text: &str) -> Scene {
        Scene::default()
            .in_window(notepad(), "Notepad")
            .text_box(TEXT_EDITOR, true, text)
            .focus(450, text_editor_focus())
    }

    #[test]
    fn with_the_voice_typing_panel_showing_a_sentence_is_kept() {
        // Voice typing was started before (the panel's microphone, or Win+H before the recording):
        // its panel shows as focus comes to the box, and the sentence spoken is the step's.
        let records = record(
            notepad_focused("Dear Sam,\n")
                .panel(0, true)
                .text(2_500, &format!("Dear Sam,\n{SENTENCE}")),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), SENTENCE)]);
    }

    const TEXT_INPUT_HOST_PID: u32 = 7_100;
    const COPIED: &str = "Account 12345678, sort code 01-02-03";

    /// UI Automation's focus on an element of a text input host panel (clipboard history's list,
    /// the emoji panel's grid): another program's window, over Notepad's.
    fn panel_focus(name: &str) -> FocusUpdate {
        FocusUpdate {
            window: NOTEPAD,
            facts: ElementFacts {
                control_type: "ListItem".into(),
                name: name.into(),
                bounds: Some(PxRect {
                    left: 1_200,
                    top: 300,
                    right: 1_500,
                    bottom: 340,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: TEXT_INPUT_HOST_PID,
        }
    }

    #[test]
    fn a_pick_from_clipboard_history_keeps_no_value() {
        // Win+V, then an item clicked: clipboard history pastes it with no key. The same program
        // draws clipboard history and the voice typing panel, so its window showing is no sign of
        // dictation here. The clipboard is never read (04/10/2026), so neither is what it pastes.
        let clicked = notepad_focused("Dear Sam,\n")
            .combo(1_000, VK_LWIN, u16::from(b'V'))
            .panel(1_100, true)
            .click_named(2_000, 60, None)
            .text(2_300, &format!("Dear Sam,\n{COPIED}"))
            .panel(2_400, false);
        assert_eq!(typed_in(&record(clicked)), [(Some(TEXT_EDITOR), "")]);

        // UI Automation's focus went into the list and came back to the box after the pick, while
        // the panel was still closing.
        let focus_came_back = notepad_focused("Dear Sam,\n")
            .combo(1_000, VK_LWIN, u16::from(b'V'))
            .panel(1_100, true)
            .focus(1_200, panel_focus(COPIED))
            .click_named(2_000, 60, None)
            .focus(2_100, text_editor_focus())
            .text(2_400, &format!("Dear Sam,\n{COPIED}"))
            .panel(2_500, false);
        assert_eq!(
            typed_in(&record(focus_came_back)),
            [(Some(TEXT_EDITOR), "")]
        );
    }

    #[test]
    fn win_v_counts_wherever_it_was_pressed() {
        // Win+V pressed while a window nothing is kept from was in front (Steps' own, an excluded
        // app's), then focus came to Notepad's box: the panel showing is clipboard history's.
        let records = record(
            Scene::default()
                .in_window(notepad(), "Notepad")
                .text_box(TEXT_EDITOR, true, "Dear Sam,\n")
                .panel(0, true)
                .keys_to(Some(0x99_0000))
                .combo(300, VK_LWIN, u16::from(b'V'))
                .keys_to(None)
                .focus(450, text_editor_focus())
                .text(2_500, &format!("Dear Sam,\n{COPIED}")),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "")]);
    }

    #[test]
    fn an_emoji_picked_from_the_emoji_panel_keeps_no_value() {
        // Win+., then an emoji clicked: the panel stays open, and it puts the emoji in with no key.
        let picked = notepad_focused("Dear Sam")
            .combo(1_000, VK_LWIN, VK_OEM_PERIOD)
            .panel(1_100, true)
            .click_named(2_000, 60, None)
            .text(2_300, "Dear Sam 👍");
        assert_eq!(typed_in(&record(picked)), [(Some(TEXT_EDITOR), "")]);

        // The app tells UI Automation of the box's focus again after the click.
        let focus_again = notepad_focused("Dear Sam")
            .combo(1_000, VK_LWIN, VK_OEM_PERIOD)
            .panel(1_100, true)
            .click_named(2_000, 60, None)
            .focus(2_050, text_editor_focus())
            .text(2_400, "Dear Sam 👍");
        assert_eq!(typed_in(&record(focus_again)), [(Some(TEXT_EDITOR), "")]);
    }

    #[test]
    fn a_paste_from_a_menu_while_voice_typing_keeps_no_value() {
        // The voice typing panel shows; Paste is chosen from the box's right-click menu, focus
        // comes back to the box, and the paste goes in a moment later.
        let paste = FocusUpdate {
            facts: ElementFacts {
                control_type: "MenuItem".into(),
                name: "Paste".into(),
                ..text_editor_focus().facts
            },
            ..text_editor_focus()
        };
        let records = record(
            notepad_focused("Dear Sam,\n")
                .panel(0, true)
                .click_named(2_000, 60, None)
                .focus(2_020, paste)
                .click_named(2_500, 60, None)
                .focus(2_550, text_editor_focus())
                .text(2_900, &format!("Dear Sam,\n{COPIED}")),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "")]);
    }

    #[test]
    fn a_press_the_recording_doesnt_take_ends_what_dictation_keeps() {
        // Win+H and a sentence, then text dragged in from a window on a screen the recording
        // leaves out (its click is never passed on): the stretch keeps no value at all.
        let dragged = win_h(in_notepad(""), 1_000)
            .text(2_500, SENTENCE)
            .pressed(3_000)
            .text(3_300, &format!("{SENTENCE} {COPIED}"))
            .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(dragged)), [(Some(TEXT_EDITOR), "")]);

        // A tap on a touch screen too.
        let tapped = win_h(in_notepad(""), 1_000)
            .text(2_500, SENTENCE)
            .touched(3_000)
            .text(3_300, &format!("{SENTENCE} {COPIED}"))
            .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(tapped)), [(Some(TEXT_EDITOR), "")]);
    }

    #[test]
    fn what_a_click_straight_after_win_h_puts_in_keeps_no_value() {
        // The click came before Win+H was handled, so the box couldn't be read as it was heard
        // of: what's added before the click is handled may be the click's.
        let records = record(
            win_h(in_notepad(""), 1_000)
                .click_named(1_050, 60, None)
                .text(1_180, COPIED),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "")]);
    }

    #[test]
    fn win_h_pressed_just_before_focus_came_to_the_box_is_dictation_there() {
        // A click into Notepad and Win+H straight after it, before UI Automation's news of the
        // box's focus came: the sentence is what voice typing put in.
        let records = record(
            win_h(
                Scene::default()
                    .in_window(notepad(), "Notepad")
                    .text_box(TEXT_EDITOR, true, "")
                    .click_named(400, 60, None),
                420,
            )
            .focus(450, text_editor_focus())
            .text(2_500, SENTENCE)
            .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), SENTENCE)]);
    }

    #[test]
    fn after_a_click_text_keeps_no_value_until_win_h_again() {
        // A click, even in the box, can paste or drop as it comes up: what's added after it isn't
        // known to be dictation, panel or not, until Win+H is pressed again.
        let records = record(
            win_h(notepad_focused("").panel(0, true), 1_000)
                .text(2_000, "Dear Sam,")
                .click_named(3_000, 60, None)
                .text(4_000, &format!("Dear Sam, {SENTENCE}"))
                .combo(5_000, VK_LWIN, u16::from(b'H'))
                .text(6_000, &format!("Dear Sam, {SENTENCE} Best wishes"))
                .click_named(7_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [
                (Some(TEXT_EDITOR), "Dear Sam,"),
                (Some(TEXT_EDITOR), ""),
                (Some(TEXT_EDITOR), "Best wishes")
            ]
        );
    }

    #[test]
    fn typing_in_notepad_is_one_step_from_the_keys() {
        // What the keys put in the box is theirs: it isn't read from the box a second time.
        let records = record(
            in_notepad("")
                .type_keys(1_000, 150, "Dear Sam")
                .text(2_100, "Dear Sam")
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "Dear Sam")]);
    }

    #[test]
    fn typing_the_box_gained_after_a_click_that_couldnt_say_names_it_as_focus_leaves() {
        // The click's lookup couldn't say what was clicked, nor where (`in_notepad`), so the
        // text editor's news isn't known to be the click's own; but the box gained what the keys
        // typed, read as focus left it for the Settings button: they went there (#97 third
        // review).
        let settings = FocusUpdate {
            facts: ElementFacts {
                control_type: "Button".into(),
                name: "Settings".into(),
                bounds: Some(PxRect {
                    left: 1_040,
                    top: 110,
                    right: 1_090,
                    bottom: 150,
                }),
                ..ElementFacts::default()
            },
            ..text_editor_focus()
        };
        let records = record(
            in_notepad("")
                .type_keys(1_000, 150, "Dear Sam")
                .text(2_100, "Dear Sam")
                .focus(3_000, settings),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "Dear Sam")]);
    }

    #[test]
    fn a_password_typed_after_a_click_that_couldnt_say_never_takes_the_watched_box() {
        // Notepad's text editor watched, a click on a plug-in's password box above it whose
        // lookup failed, the editor's news from before the click told late, and the password's own
        // never comes: the editor gained nothing, so the keys keep no name and no value, at human
        // speed or straight after (#97 third review).
        for (from, gap) in [(1_600, 150), (1_005, 10)] {
            let records = record(
                Scene::default()
                    .in_window(notepad(), "Notepad")
                    .text_box(TEXT_EDITOR, true, "Dear Sam,")
                    .focus(100, text_editor_focus())
                    .click_looked_up(1_000, 400, (900, 150), None)
                    .focus(1_050, text_editor_focus())
                    .type_keys(from, gap, "Tr0ub4dor3")
                    .click_named(4_000, 60, None),
            );
            assert_eq!(typed_in(&records), [(None, "")], "keys from {from} ms");
        }
    }

    #[test]
    fn typing_then_dictating_into_one_box_makes_a_step_of_each() {
        // "Dear Sam", then Win+H and the sentence spoken, with no click between: Win+H ends the
        // typing, and the box is read again from there.
        let records = record(
            win_h(
                in_notepad("")
                    .type_keys(1_000, 150, "Dear Sam")
                    .text(2_100, "Dear Sam"),
                2_500,
            )
            .text(4_000, &format!("Dear Sam {SENTENCE}"))
            .click_named(6_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [
                (Some(TEXT_EDITOR), "Dear Sam"),
                (Some(TEXT_EDITOR), SENTENCE)
            ]
        );
    }

    /// A box in Notepad's window that says it holds a password (a plug-in's sign-in pane).
    fn password_focus() -> FocusUpdate {
        FocusUpdate {
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "Password".into(),
                is_password: true,
                sensitive: true,
                ..text_editor_focus().facts
            },
            ..text_editor_focus()
        }
    }

    #[test]
    fn nothing_dictated_into_a_password_box_is_kept() {
        // UI Automation never gives a password box's value; and it's never read for dictation.
        let in_password_box = win_h(
            Scene::default()
                .in_window(notepad(), "Notepad")
                .text_box("Password", true, "")
                .focus(450, password_focus()),
            1_000,
        )
        .text(2_500, "correct horse battery staple")
        .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(in_password_box)), []);

        // Focus left a password box for another box of the same window with no click (a
        // notification can do that to UI Automation's focus): the window keeps nothing until the
        // next click (10/10/2026).
        let after_password_box = win_h(
            Scene::default()
                .in_window(notepad(), "Notepad")
                .text_box(TEXT_EDITOR, true, "")
                .focus(450, password_focus())
                .focus(700, text_editor_focus()),
            1_000,
        )
        .text(2_500, "correct horse battery staple")
        .press(5_000, VK_LWIN);
        assert_eq!(typed_in(&record(after_password_box)), []);

        // A window titled for a password ("Set Password") whose box doesn't say it's one (F021).
        let titled = notepad();
        let titled = WindowInfo {
            title: "Set Password".into(),
            ..titled
        };
        let in_titled_window = win_h(
            Scene::default()
                .in_window(titled, "#32770")
                .text_box(TEXT_EDITOR, true, "")
                .focus(450, text_editor_focus()),
            1_000,
        )
        .text(2_500, "correct horse battery staple")
        .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(in_titled_window)), []);
    }

    /// `text` sent by another program as Unicode packets from `from`, one UTF-16 unit every 20 ms,
    /// as a password manager's auto-type sends it: an emoji is two packets, its surrogate pair.
    fn packets(mut scene: Scene, from: u32, text: &str) -> Scene {
        for (index, _) in text.encode_utf16().enumerate() {
            let ms = from + 20 * u32::try_from(index).expect("a short text");
            scene = scene.press(ms, crate::keys::VK_PACKET);
        }
        scene
    }

    #[test]
    fn text_another_program_types_keeps_no_value() {
        // Auto-type into Notepad: the step says only that something was typed there, and what the
        // box shows afterwards isn't taken for dictation (decision of 11/10/2026).
        let auto_typed = packets(in_notepad(""), 1_000, "s3cret 😀").text(1_300, "s3cret 😀");
        let records = record(auto_typed.click_named(3_000, 60, None));
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "")]);

        // Keys typed with packets among them keep no value either.
        let mixed = packets(
            in_notepad("").type_keys(1_000, 150, "Dear Sam"),
            2_200,
            "😀",
        )
        .text(2_300, "Dear Sam😀")
        .click_named(3_000, 60, None);
        assert_eq!(typed_in(&record(mixed)), [(Some(TEXT_EDITOR), "")]);

        // In Excel too: the cell, never what went in it.
        let in_excel = packets(Scene::default().focus_cell(0, "B2"), 1_000, "s3cret")
            .bar(1_200, "s3cret")
            .press(2_000, VK_RETURN);
        assert_eq!(cells(&record(in_excel)), [(Some("B2"), "")]);
    }

    #[test]
    fn dictation_is_read_when_focus_leaves_the_box() {
        // A sentence spoken, then the person goes to another app: focus leaves Notepad's box.
        let elsewhere = FocusUpdate {
            window: NOTEPAD,
            facts: ElementFacts {
                control_type: "Button".into(),
                name: "Settings".into(),
                ..text_editor_focus().facts
            },
            ..text_editor_focus()
        };
        let records = record(
            win_h(in_notepad(""), 1_000)
                .text(2_500, SENTENCE)
                .focus(4_000, elsewhere)
                .text(4_500, &format!("{SENTENCE} Something else")),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), SENTENCE)]);
    }

    #[test]
    fn a_form_field_is_left_to_its_value() {
        // A box whose value is read as focus leaves it makes its own step, with what was
        // dictated into it: it's never read for dictation as well.
        let field = FocusUpdate {
            field: true,
            ..text_editor_focus()
        };
        let records = record(
            win_h(
                Scene::default()
                    .in_window(notepad(), "Notepad")
                    .text_box(TEXT_EDITOR, true, "")
                    .focus(450, field),
                1_000,
            )
            .text(2_500, SENTENCE)
            .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn a_page_that_cant_be_typed_in_is_not_read_for_dictation() {
        // A web page or a mail's reading pane says its text is read-only: text it gains after a
        // click (more results loading) is never dictation.
        let records = record(
            Scene::default()
                .in_window(notepad(), "Notepad")
                .text_box(TEXT_EDITOR, false, "Results")
                .focus(450, text_editor_focus())
                .text(2_500, "Results\nMore results")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn nothing_is_kept_from_an_excluded_app() {
        let excluded = win_h(in_notepad(""), 1_000)
            .at(0, Happening::Exclude("Notepad.exe".into()))
            .text(2_500, SENTENCE)
            .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(excluded)), []);
        // Excluded while the box was watched.
        let excluded_since = win_h(in_notepad(""), 1_000)
            .text(2_500, SENTENCE)
            .at(3_000, Happening::Exclude("notepad.exe".into()))
            .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(excluded_since)), []);
    }

    #[test]
    fn what_was_dictated_before_a_pause_is_kept_and_nothing_during_it() {
        let records = record(
            win_h(in_notepad(""), 1_000)
                .text(2_500, "Dear Sam,")
                .at(3_000, Happening::Pause(true))
                .text(3_500, &format!("Dear Sam, {SENTENCE}"))
                .at(4_000, Happening::Pause(false))
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some(TEXT_EDITOR), "Dear Sam,")]);
    }

    #[test]
    fn the_box_is_read_only_when_a_stretch_of_time_ends() {
        // Typing reads nothing per key: the box is read when focus arrives, and at a click, a
        // focus change or a key combination with no typing before it.
        let (records, reads) = recorded(
            in_notepad("")
                .type_keys(1_000, 100, "Dear Sam see you on Monday")
                .text(3_700, "Dear Sam see you on Monday")
                .click_named(5_000, 60, None),
        );
        assert_eq!(records.len(), 1);
        assert!(reads <= 3, "{reads} reads");
    }

    #[test]
    fn what_a_click_puts_in_the_box_is_not_dictation() {
        // Edit > Paste: the menu item's click pastes as the button comes up, 50 ms after it went
        // down. The box was read as the click was heard of, and again once it was handled.
        let records = record(
            in_notepad("Dear Sam,\n")
                .click_named(3_000, 60, None)
                .text(3_050, "Dear Sam,\nPasted text")
                .click_named(6_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }
}
