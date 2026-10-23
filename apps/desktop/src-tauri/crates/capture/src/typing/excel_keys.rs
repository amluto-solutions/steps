//! Keys typed in Excel (docs/spec/02-capture.md#keys): a stretch is what's typed into one cell,
//! the cell the click before it selected or the one UI Automation's focus news names, never a
//! cell from before a click or a move (#75); its text is the keys, or the formula bar's reading
//! when that shows more (an edit after F2, auto-complete), never the two put together (#76). A
//! cell's reference typed into Go To (Ctrl+G, F5) or the Name Box and put in with Enter goes to
//! that cell (#69). One reason to change: how typing in Excel becomes steps. What Excel names
//! and draws is `crate::excel`'s.

use std::collections::HashMap;
use std::time::Instant;

use crate::excel::{self, cell_reference};
use crate::facts::ElementFacts;
use crate::keys::KeyAction;

use super::{
    Desktop, FocusNote, KeptTyping, PendingClick, READ_AFTER_KEYS, SHOT_AFTER_KEYS, Stretch,
    Worker, combo_box_in, kept_typing,
};

/// How many of the formula bar's readings taken as keys arrive are kept (`Worker::watch_bar`):
/// far more than a stretch of fast typing takes.
pub(super) const BAR_SEEN_KEPT: usize = 64;

/// Where typing goes to a cell rather than into one (#69).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GoesTo {
    /// Excel's Name Box, in the stretch's window.
    NameBox,
    /// Go To's Reference box, in a dialog over the workbook window `excel`.
    Dialog { excel: isize },
}

/// Go To, opened by Ctrl+G or F5 in the workbook window `excel` of the Excel process `pid`: the
/// next window of that process the keys go to, `dialog` once they have, is its dialog (#69).
#[derive(Debug, Clone, Copy)]
pub(super) struct GoToArm {
    pub(super) excel: isize,
    pub(super) pid: u32,
    pub(super) dialog: Option<isize>,
}

/// Which cell is selected in each Excel window, as far as the key worker can tell (#75): the cell
/// a click selected, or the one UI Automation's focus news last named. A click, or a key that
/// moves the selection, makes the cell from before it unknown at once; the news of where it went
/// comes later, and keys typed before it keep no cell rather than the cell from before. Focus
/// news comes in the order Excel gave it but late, so news from before a click can arrive after
/// it: news that disagrees with the click's cell, before news agreeing with it, leaves no cell.
#[derive(Debug, Default)]
pub(super) struct ExcelCells {
    windows: HashMap<isize, Selection>,
    /// A press nothing is known of was applied: for a window not clicked since, typing keeps its
    /// value only as the formula bar shows it (#97 fourth review).
    pressed_somewhere: bool,
}

/// What's known of one Excel window's selected cell.
#[derive(Debug, Default)]
struct Selection {
    cell: Option<String>,
    /// When the last click or move was: focus news heard before then is of the cell before.
    since: Option<u32>,
    /// The cell the last move (Enter, Tab, an arrow) left: focus news naming it came late.
    left: Option<String>,
    /// `cell` is a click's, and no focus news has agreed with it yet.
    unconfirmed: bool,
    /// A click couldn't say what it went to (its lookup failed or never finished, or gave Chrome's
    /// page answer, or named anything in a web page, #118, or a press nothing is known of), and no
    /// click since has named a cell: typing keeps its value only as the formula bar shows it, since
    /// keys sent to a pane in Excel's window (an add-in's password box) never reach it (#97 fourth
    /// review). A click that names no cell ("Show" beside the password box, Bold) leaves focus
    /// where it was, so it carries on through it (#115).
    bar_check: bool,
}

impl ExcelCells {
    pub(super) fn cell(&self, window: isize) -> Option<String> {
        self.windows.get(&window)?.cell.clone()
    }

    /// A click selected `cell` (`None`: no cell, or its lookup didn't say); `doubt` when it
    /// couldn't say what it went to (its lookup failed or never finished, or gave Chrome's page
    /// answer, or named anything in a web page, #118).
    pub(super) fn clicked(&mut self, window: isize, tick: u32, cell: Option<String>, doubt: bool) {
        let before = self.bar_check(window);
        *self.selection(window) = Selection {
            unconfirmed: cell.is_some(),
            bar_check: cell.is_none() && (doubt || before),
            cell,
            since: Some(tick),
            left: None,
        };
    }

    /// When the last click or move in the window was, as far as is known: a formula bar reading
    /// from before then may be of another cell.
    fn since(&self, window: isize) -> Option<u32> {
        self.windows.get(&window)?.since
    }

    /// A click nothing is known of, at `tick` (#97): which cell is selected isn't known in any
    /// window until focus news heard after it says, and typing keeps its value only as the
    /// formula bar shows it.
    pub(super) fn clicked_somewhere(&mut self, tick: u32) {
        self.pressed_somewhere = true;
        for selection in self.windows.values_mut() {
            *selection = Selection {
                since: Some(tick),
                bar_check: true,
                ..Selection::default()
            };
        }
    }

    /// Whether typing in the window keeps its value only as the formula bar shows it.
    pub(super) fn bar_check(&self, window: isize) -> bool {
        self.windows
            .get(&window)
            .map_or(self.pressed_somewhere, |selection| selection.bar_check)
    }

    /// A key moved the selection on from the cell it was in.
    pub(super) fn moved(&mut self, window: isize, tick: u32) {
        let selection = self.selection(window);
        *selection = Selection {
            left: selection.cell.take(),
            cell: None,
            since: Some(tick),
            unconfirmed: false,
            bar_check: selection.bar_check,
        };
    }

    /// Focus news: an Excel cell's, heard after the last click or move, says it's selected.
    /// Gives the cell when it does.
    pub(super) fn focused(&mut self, note: &FocusNote) -> Option<String> {
        if note.facts.class_name != excel::CELL_CLASS || note.facts.name.is_empty() {
            return None;
        }
        // Written as the click's lookup writes it (`cell_name`), so the two can be compared.
        let cell = note.facts.name.trim().replace('$', "");
        let selection = self.selection(note.window);
        let old = selection
            .since
            .is_some_and(|since| crate::state_machine::tick_before_or_at(note.tick_ms, since))
            || selection.left.as_ref() == Some(&cell);
        if old {
            return None;
        }
        let disagrees = selection.unconfirmed && selection.cell.as_ref() != Some(&cell);
        selection.unconfirmed = false;
        selection.left = None;
        selection.cell = (!disagrees).then_some(cell);
        selection.cell.clone()
    }

    fn selection(&mut self, window: isize) -> &mut Selection {
        if self.windows.len() > 16 && !self.windows.contains_key(&window) {
            // A window that was to be checked against the formula bar stays so.
            self.pressed_somewhere |= self.windows.values().any(|selection| selection.bar_check);
            self.windows.clear();
        }
        let bar_check = self.pressed_somewhere;
        self.windows.entry(window).or_insert_with(|| Selection {
            bar_check,
            ..Selection::default()
        })
    }
}

/// A reading of Excel's formula bar during a stretch of typing.
#[derive(Debug, Clone)]
pub(super) struct BarReading {
    pub(super) text: String,
    /// What the keys had typed when it was taken.
    pub(super) keys: String,
    /// When it was taken.
    pub(super) tick: u32,
}

/// What was typed into an Excel cell.
#[derive(Debug, PartialEq)]
pub(super) struct ExcelEntry {
    pub(super) text: String,
    /// It may not match what the cell holds: the step is flagged for review.
    pub(super) approximate: bool,
}

/// What was typed into an Excel cell, from one source, never the two put together (#76). The
/// keys, when the formula bar showed just what they had typed: typing into a cell replaces what
/// it held, so they are the whole entry. The formula bar's last reading, when it showed more
/// than the keys had typed: an edit of what the cell held (after F2), or Excel's auto-complete
/// finishing the word. Keys typed after that reading make it approximate.
pub(super) fn excel_entry(stretch: &Stretch) -> ExcelEntry {
    match &stretch.bar {
        Some(reading) if reading.text != reading.keys => ExcelEntry {
            text: reading.text.clone(),
            approximate: reading.keys != stretch.text,
        },
        _ => ExcelEntry {
            text: stretch.text.clone(),
            approximate: false,
        },
    }
}

impl<D: Desktop> Worker<D> {
    /// A click was applied: in Excel, typing straight after it goes into the cell it selected.
    /// Only one in Go To's dialog, or in another window of Excel's before it opened, leaves Go
    /// To waiting for its keys (#69).
    pub(super) fn clicked(&mut self, click: &PendingClick) {
        if let Some(arm) = self.go_to {
            let in_go_to = click.window != arm.excel
                && arm.dialog.is_none_or(|dialog| dialog == click.window)
                && self
                    .window(click.window)
                    .is_some_and(|(window, _)| window.pid == arm.pid);
            if !in_go_to {
                self.go_to = None;
            }
        }
        if !self.is_excel(click.window) {
            return;
        }
        // With Shift held it extends the selection: the cell typed into is where the selection
        // began, not the one clicked.
        let shift = self.reader.modifiers().shift;
        let cell = click.lookup.cell().filter(|_| !shift);
        // Chrome's page answer is an add-in's pane, never a cell: what's under the point, a
        // password box among them, can't be told (#115). So is anything else in a web page, which
        // can put focus in a password box the lookup didn't name (a label's `for`, #118).
        let doubt = click.lookup.couldnt_tell()
            || click.lookup.page_answer(click.point)
            || click.lookup.in_web_page();
        self.excel_cells
            .clicked(click.window, click.tick, cell, doubt);
        // What the bar shows now, before keys typed after the click, unless they came first: the
        // keys are kept only when it changes to show them (#115).
        if self.excel_cells.bar_check(click.window) {
            self.note_bar(click.window);
        }
    }

    pub(super) fn is_excel(&mut self, hwnd: isize) -> bool {
        self.window(hwnd)
            .is_some_and(|(_, class)| class == excel::WINDOW_CLASS)
    }

    pub(super) fn excel_key(&mut self, hwnd: isize, action: &KeyAction, tick: u32, now: Instant) {
        // Typing in the Name Box goes to a cell, or names one, rather than going into one (#69).
        if self.stretch.is_none()
            && matches!(action, KeyAction::Text(_) | KeyAction::Packet)
            && let Some(name_box) = self.name_box(hwnd)
        {
            let mut stretch = self.new_stretch(hwnd, tick, false, false, None);
            stretch.withheld = name_box.sensitive || name_box.is_password;
            stretch.element = Some(name_box);
            stretch.goes_to = Some(GoesTo::NameBox);
            self.stretch = Some(stretch);
        }
        if self
            .stretch
            .as_ref()
            .is_some_and(|stretch| stretch.goes_to.is_some())
        {
            self.go_to_typing(action, tick, now);
            return;
        }
        match action {
            KeyAction::Text(_) | KeyAction::Packet => {
                if self.stretch.is_none() {
                    let cell = self.excel_cells.cell(hwnd);
                    let mut stretch = self.new_stretch(hwnd, tick, true, false, cell);
                    stretch.bar_check = self.excel_cells.bar_check(hwnd);
                    self.stretch = Some(stretch);
                }
                if let Some(stretch) = self.stretch.as_mut() {
                    match action {
                        KeyAction::Text(text) => stretch.text.push_str(text),
                        _ => stretch.packets = true,
                    }
                    stretch.bar_due.get_or_insert(now + READ_AFTER_KEYS);
                    stretch.shot_due = Some(now + SHOT_AFTER_KEYS);
                }
            }
            KeyAction::Backspace | KeyAction::Delete => {
                if let Some(stretch) = self.stretch.as_mut() {
                    stretch.text.pop();
                    stretch.bar_due.get_or_insert(now + READ_AFTER_KEYS);
                    stretch.shot_due = Some(now + SHOT_AFTER_KEYS);
                }
            }
            // Enter, Tab and the arrows put what was typed into the cell, and move on.
            KeyAction::Enter | KeyAction::Tab | KeyAction::Move => {
                self.end_stretch(true);
                self.excel_cells.moved(hwnd, tick);
            }
            // Escape throws it away, in Excel as here.
            KeyAction::Escape => self.stretch = None,
            KeyAction::Other | KeyAction::Combo(_) => {}
        }
    }

    /// Excel's Name Box, when Windows says it has the keyboard in the workbook window `hwnd`: the
    /// one combo box Excel's main window has (#69). Not asked once a click or focus change has
    /// been heard since the key being handled, since Windows says where the keyboard is now.
    fn name_box(&mut self, hwnd: isize) -> Option<ElementFacts> {
        if self.news_since_key() {
            return None;
        }
        let (window, _) = self.window(hwnd)?;
        let found = self
            .desktop
            .combo_box_edit(hwnd, &self.options.extra_terms)?;
        combo_box_in(&found, &window, |x, y| self.desktop.root_at(x, y))
    }

    /// A key in Go To's dialog, opened from the workbook window `excel` (#69).
    pub(super) fn go_to_key(
        &mut self,
        dialog: isize,
        excel: isize,
        action: &KeyAction,
        tick: u32,
        now: Instant,
    ) {
        if self.stretch.is_none() && matches!(action, KeyAction::Text(_) | KeyAction::Packet) {
            let mut stretch = self.new_stretch(dialog, tick, false, false, None);
            stretch.goes_to = Some(GoesTo::Dialog { excel });
            self.stretch = Some(stretch);
        }
        if self.stretch.is_some() {
            self.go_to_typing(action, tick, now);
        } else if matches!(action, KeyAction::Enter) {
            // It went to whatever its box held before: which cell isn't known.
            self.excel_cells.moved(excel, tick);
        }
        // Enter and Escape close it: keys after them aren't its.
        if matches!(action, KeyAction::Enter | KeyAction::Escape) {
            self.go_to = None;
        }
    }

    /// A key typed into the Name Box or Go To's Reference box (#69).
    fn go_to_typing(&mut self, action: &KeyAction, tick: u32, now: Instant) {
        match action {
            KeyAction::Enter => {
                self.finish_go_to(tick);
                return;
            }
            // Escape puts the box back, and Tab leaves it: nothing was gone to.
            KeyAction::Escape | KeyAction::Tab => {
                self.stretch = None;
                return;
            }
            _ => {}
        }
        let Some(stretch) = self.stretch.as_mut() else {
            return;
        };
        match action {
            KeyAction::Text(text) => stretch.text.push_str(text),
            KeyAction::Packet => stretch.packets = true,
            KeyAction::Backspace => {
                if stretch.text.pop().is_none() {
                    stretch.approximate = true;
                }
            }
            // The box may hold more than was typed, or the Name Box's list a name chosen.
            KeyAction::Delete | KeyAction::Move => stretch.approximate = true,
            _ => return,
        }
        stretch.shot_due = Some(now + SHOT_AFTER_KEYS);
    }

    /// Enter in the Name Box or Go To's Reference box (#69). A cell's reference goes to that cell
    /// (`Go to cell "D11"`), which typing straight after goes into, as after a click on it. Anything
    /// else typed into the Name Box (a name, a range) is typing in the Name Box; in Go To, it
    /// makes no step, since what it selected can't be told.
    fn finish_go_to(&mut self, tick: u32) {
        let Some(mut stretch) = self.stretch.take() else {
            return;
        };
        let Some(goes_to) = stretch.goes_to else {
            return;
        };
        let excel = match goes_to {
            GoesTo::NameBox => stretch.hwnd,
            GoesTo::Dialog { excel } => excel,
        };
        let cell = (!stretch.approximate && !stretch.withheld && !stretch.packets)
            .then(|| cell_reference(&stretch.text))
            .flatten();
        let Some(cell) = cell else {
            self.excel_cells.moved(excel, tick);
            if goes_to == GoesTo::NameBox
                && let Some(kept) = kept_typing(&stretch, &self.options.extra_terms)
            {
                self.write_typing(stretch, kept);
            }
            return;
        };
        self.excel_cells
            .clicked(excel, tick, Some(cell.clone()), false);
        stretch.cell = Some(cell.clone());
        let kept = KeptTyping {
            text: cell,
            secrets: Vec::new(),
            form: "goTo",
            language: "plain",
        };
        self.write_typing(stretch, kept);
    }

    /// Keys typed in the windows `typed_in` arrived this turn. In a window of Excel's where typing
    /// may keep its value only as the formula bar shows it (after a click that couldn't say what
    /// it went to, or while a click's lookup hasn't named a cell yet), the bar is read now, and
    /// again next turn, since Excel shows a key a moment after it: the keys are handled 150 ms on,
    /// by when fast typing's Enter has moved on to the next cell (#97 fourth review).
    pub(super) fn watch_bar(&mut self, typed_in: Vec<isize>) {
        let mut windows = std::mem::replace(&mut self.bar_typed_in, typed_in);
        windows.retain(|hwnd| !self.bar_typed_in.contains(hwnd));
        windows.extend(self.bar_typed_in.iter().copied());
        for hwnd in windows {
            let watched = self.excel_cells.bar_check(hwnd)
                || !self.waiting_presses.is_empty()
                || self
                    .pending_clicks
                    .iter()
                    .any(|click| click.window == hwnd && click.lookup.cell().is_none());
            if !watched || !self.is_excel(hwnd) {
                continue;
            }
            self.note_bar(hwnd);
        }
    }

    /// Reads the formula bar of the Excel window `hwnd` and keeps the reading, empty or not (an
    /// empty cell's is what typing is held up against), for `bar_showed`.
    fn note_bar(&mut self, hwnd: isize) {
        let Some(text) = self.desktop.formula_bar(hwnd) else {
            return;
        };
        // After the read: a key typed while it was being read may be in it.
        let tick = self.desktop.tick_now();
        if self.bar_seen.len() >= BAR_SEEN_KEPT {
            self.bar_seen.pop_front();
        }
        self.bar_seen.push_back((hwnd, tick, text));
    }

    /// Whether the formula bar showed all that a stretch of typing in Excel typed, in a reading
    /// taken as its keys were handled (#76) or as they arrived, from its first key on (#97 fourth
    /// review). All of it: a reading after its first key alone would match a cell that merely
    /// holds that letter, the bar showing the cell while the keys went into a pane. And changed
    /// to: a reading the same as the one before the stretch's first key (since the last click or
    /// move there), or with none, as the stretch's first reading, shows only what the selected
    /// cell already held, which can be the password typed into a pane, or text with it in (#115).
    pub(super) fn bar_showed(&self, stretch: &Stretch) -> bool {
        use crate::state_machine::tick_before_or_at;
        let typed = stretch.text.trim();
        if typed.is_empty() {
            return false;
        }
        let first = stretch.first_tick;
        let seen = self
            .bar_seen
            .iter()
            .filter(|(hwnd, _, _)| *hwnd == stretch.hwnd)
            .map(|(_, tick, text)| (*tick, text.as_str()));
        let since = self.excel_cells.since(stretch.hwnd);
        // Taken before the first key, so Excel can't have shown it yet, and after the last click
        // or move, so it's of the cell the keys went to if they went to one.
        let before = seen.clone().rfind(|(tick, _)| {
            !tick_before_or_at(first, *tick)
                && since.is_some_and(|since| tick_before_or_at(since, *tick))
        });
        let mut during = seen
            .filter(|(tick, _)| tick_before_or_at(first, *tick))
            .chain(
                [stretch.bar.as_ref(), stretch.bar_unchecked.as_ref()]
                    .into_iter()
                    .flatten()
                    .map(|reading| (reading.tick, reading.text.as_str())),
            );
        let Some((_, held)) = before.or_else(|| {
            during.clone().reduce(|earliest, reading| {
                if tick_before_or_at(earliest.0, reading.0) {
                    earliest
                } else {
                    reading
                }
            })
        }) else {
            return false;
        };
        during.any(|(_, text)| text != held && text.contains(typed))
    }

    /// Reads the formula bar for the stretch of typing in Excel, once its read is due (#76).
    pub(super) fn read_formula_bar(&mut self, now: Instant) {
        let bar_hwnd = self.stretch.as_ref().and_then(|stretch| {
            (stretch.excel && stretch.bar_due.is_some_and(|due| now >= due)).then_some(stretch.hwnd)
        });
        // The bar shows Excel as it is now, so a reading is only held up against the keys once
        // every key that has come in is handled: with keys still waiting, it already showed them,
        // and they were counted twice ("=D2*0.20.2"), or Enter had moved on and it showed the
        // next cell (#76). It's tried again next turn.
        if let Some(hwnd) = bar_hwnd
            && self.pending.is_empty()
        {
            let reading = self.desktop.formula_bar(hwnd);
            // After the read: a key typed while it was being read may be in it too.
            let tick = self.desktop.tick_now();
            if let Some(stretch) = self.stretch.as_mut() {
                stretch.bar_due = None;
                if let Some(text) = reading.filter(|reading| !reading.is_empty()) {
                    stretch.bar_unchecked = Some(BarReading {
                        text,
                        keys: stretch.text.clone(),
                        tick,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typing::scene::*;

    #[test]
    fn an_excel_entry_comes_from_one_source() {
        let entry = |text: &str, approximate| ExcelEntry {
            text: text.into(),
            approximate,
        };
        // The bar showed just what the keys had typed: the keys are the entry, however much
        // was typed after the reading, or backspaced.
        assert_eq!(
            excel_entry(&stretch("=B2*3", Some(("=B2*3", "=B2*3")))),
            entry("=B2*3", false)
        );
        assert_eq!(
            excel_entry(&stretch("=D2*0.2", Some(("=D2*", "=D2*")))),
            entry("=D2*0.2", false)
        );
        assert_eq!(
            excel_entry(&stretch("=B2", Some(("=B2*", "=B2*")))),
            entry("=B2", false)
        );
        // No reading: the keys.
        assert_eq!(
            excel_entry(&stretch("Q3 total", None)),
            entry("Q3 total", false)
        );
        // F2 on an existing formula: the bar has all of it, the keys only the change.
        assert_eq!(
            excel_entry(&stretch("+1", Some(("=SUM(B2:B3)+1", "+1")))),
            entry("=SUM(B2:B3)+1", false)
        );
        // Keys typed after that reading are never added to it: the step asks to be checked.
        assert_eq!(
            excel_entry(&stretch("+1", Some(("=SUM(B2:B3)+", "+")))),
            entry("=SUM(B2:B3)+", true)
        );
        // AutoComplete finished the word: the bar has what went in.
        assert_eq!(
            excel_entry(&stretch("Nor", Some(("North", "Nor")))),
            entry("North", false)
        );
    }

    // ---------- the worker, with keys, clicks and focus news at set times ----------

    #[test]
    fn fast_typing_after_a_click_names_the_cell_clicked() {
        // P25 (#75): F5 was selected. A click on E1, then "VAT" and Enter straight after it, a
        // key every 10 ms; Excel's focus news for E1 reached the worker only after the keys.
        let records = record(
            Scene::default()
                .focus_cell(0, "F5")
                .click(1_000, "E1")
                .type_keys(1_005, 10, "VAT\n")
                .focus_cell(1_080, "E1")
                .focus_cell(1_120, "E2"),
        );
        assert_eq!(cells(&records), [(Some("E1"), "VAT")]);
    }

    #[test]
    fn keys_after_a_click_wait_for_its_lookup() {
        // The click's lookup took 300 ms, longer than keys wait before they're handled.
        let records = record(
            Scene::default()
                .focus_cell(0, "F5")
                .click_named(1_000, 300, Some("E1"))
                .type_keys(1_005, 10, "VAT\n"),
        );
        assert_eq!(cells(&records), [(Some("E1"), "VAT")]);
    }

    #[test]
    fn a_click_that_selects_no_cell_leaves_no_cell_from_before_it() {
        // A click on the formula bar, a right-click, a lookup that gave up: F5 is no longer known
        // to be selected. So is a click whose lookup never answers.
        let named_none = Scene::default()
            .focus_cell(0, "F5")
            .click_named(1_000, 60, None)
            .type_keys(1_005, 10, "VAT\n");
        let never_named = Scene::default()
            .focus_cell(0, "F5")
            .at(
                1_003,
                Happening::Click {
                    pressed: 1_000,
                    point: NOWHERE,
                },
            )
            .type_keys(1_005, 10, "VAT\n");
        for scene in [named_none, never_named] {
            assert_eq!(cells(&record(scene)), [(None, "VAT")]);
        }
    }

    #[test]
    fn typing_straight_after_enter_never_takes_the_cell_it_left() {
        // "VAT", Enter and a formula in one go, a key every 10 ms: Enter moved on from E1, and
        // the focus news came only after all the keys.
        let records = record(
            Scene::default()
                .focus_cell(0, "F5")
                .click(1_000, "E1")
                .type_keys(1_005, 10, "VAT\n=D2*0.2\n")
                .focus_cell(1_200, "E1")
                .focus_cell(1_300, "E2")
                .focus_cell(1_400, "E3"),
        );
        assert_eq!(cells(&records), [(Some("E1"), "VAT"), (None, "=D2*0.2")]);
    }

    #[test]
    fn cell_news_after_enter_names_the_typing_already_begun() {
        // "VAT", Enter, then a formula typed fast and put in a while later. The news of E2,
        // where Enter went, came while the formula was being typed; E1's own news, heard after
        // Enter, came late.
        let records = record(
            Scene::default()
                .focus_cell(0, "F5")
                .click(1_000, "E1")
                .type_keys(1_005, 10, "VAT\n=D2*0.2")
                .focus_cell(1_080, "E1")
                .focus_cell(1_300, "E2")
                .press(2_000, VK_RETURN),
        );
        assert_eq!(
            cells(&records),
            [(Some("E1"), "VAT"), (Some("E2"), "=D2*0.2")]
        );
    }

    #[test]
    fn cell_news_heard_before_a_click_is_of_the_cell_before() {
        // F5's news, heard just before the click on E1, reached the worker with the click's.
        let records = record(
            Scene::default()
                .focus_cell_heard(1_003, 999, "F5")
                .click(1_000, "E1")
                .type_keys(
                    1_005, 10, "VAT
",
                ),
        );
        assert_eq!(cells(&records), [(Some("E1"), "VAT")]);
    }

    #[test]
    fn cell_news_that_disagrees_with_a_click_leaves_no_cell() {
        // F5's news, from before the click on E1, was heard only just after it: which cell is
        // selected can't be told, so the typing keeps none.
        let late = Scene::default()
            .focus_cell(1_004, "F5")
            .click(1_000, "E1")
            .type_keys(
                1_005, 10, "VAT
",
            );
        assert_eq!(cells(&record(late)), [(None, "VAT")]);
        // Once E1's own news has come, later news is of a later change (Go To, after F5).
        let moved_on = Scene::default()
            .click(1_000, "E1")
            .focus_cell(1_080, "E1")
            .focus_cell(3_000, "B9")
            .type_keys(
                4_000, 300, "VAT
",
            );
        assert_eq!(cells(&record(moved_on)), [(Some("B9"), "VAT")]);
    }

    #[test]
    fn keys_typed_after_a_click_wait_for_it_even_if_they_come_in_first() {
        // The click pipeline told of the click 30 ms after the press, after the first keys had
        // reached the key worker.
        let records = record(
            Scene::default()
                .focus_cell(0, "F5")
                .at(
                    1_030,
                    Happening::Click {
                        pressed: 1_000,
                        point: NOWHERE,
                    },
                )
                .at(
                    1_060,
                    Happening::Named {
                        pressed: 1_000,
                        element: None,
                        cell: Some("E1".into()),
                    },
                )
                .type_keys(1_005, 10, "VAT\n"),
        );
        assert_eq!(cells(&records), [(Some("E1"), "VAT")]);
    }

    #[test]
    fn typing_straight_after_a_key_combination_never_takes_the_cell_before() {
        // Ctrl+Down went from E1 to the column's last entry, then "x" at once; the focus news
        // came after the keys.
        const VK_CONTROL: u16 = 0x11;
        const VK_DOWN: u16 = 0x28;
        let records = record(
            Scene::default()
                .click(1_000, "E1")
                .focus_cell(1_080, "E1")
                .key(2_000, VK_CONTROL, false)
                .press(2_001, VK_DOWN)
                .key(2_004, VK_CONTROL, true)
                .type_keys(2_010, 10, "x\n")
                .focus_cell(2_100, "E20"),
        );
        assert_eq!(cells(&records), [(None, "x")]);
    }

    #[test]
    fn a_shift_click_names_no_cell() {
        // Shift+click on E9 selects E1:E9 from E1; typing goes into E1, not the cell clicked.
        let records = record(
            Scene::default()
                .click(500, "E1")
                .key(990, VK_SHIFT, false)
                .click(1_000, "E9")
                .key(1_002, VK_SHIFT, true)
                .type_keys(1_010, 10, "vat\n"),
        );
        assert_eq!(cells(&records), [(None, "vat")]);
    }

    #[test]
    fn typing_at_human_speed_after_a_click_names_the_cell_clicked() {
        let records = record(
            Scene::default()
                .focus_cell(0, "F5")
                .click(1_000, "E1")
                .focus_cell(1_080, "E1")
                .type_keys(2_500, 300, "VAT\n")
                .focus_cell(3_480, "E2"),
        );
        assert_eq!(cells(&records), [(Some("E1"), "VAT")]);
    }

    #[test]
    fn a_formula_typed_fast_is_kept_as_typed() {
        // P25 (#76): "=D2*0.2" then Enter in E2 was recorded "=D2*0.20.2". Keys 31 to 44 ms
        // apart doubled the tail: the formula bar, read 270 ms after the first key, showed the
        // whole formula while only the keys from the first 120 ms had been handled.
        for gap in [10, 40, 300] {
            let records = record(Scene::default().focus_cell(0, "E2").type_keys(
                1_000,
                gap,
                "=D2*0.2\n",
            ));
            assert_eq!(
                cells(&records),
                [(Some("E2"), "=D2*0.2")],
                "a key every {gap} ms"
            );
        }
    }

    #[test]
    fn the_next_cell_is_never_read_as_the_formula() {
        // Enter reached Excel before the worker read the formula bar, which by then showed the
        // next cell's value.
        let records = record(
            Scene::default()
                .focus_cell(0, "E2")
                .type_keys(1_000, 30, "=D2*0.2\n")
                .bar(1_215, "Total"),
        );
        assert_eq!(cells(&records), [(Some("E2"), "=D2*0.2")]);
    }

    #[test]
    fn a_reading_that_may_show_a_key_not_yet_handled_is_not_used() {
        // Enter went into Excel just before the formula bar was read, which showed the next
        // cell's value, but reached the key worker only after the reading.
        let records = record(
            Scene::default()
                .focus_cell(0, "E2")
                .type_keys(1_000, 300, "=D2*0.2")
                .press_reaching(3_065, 3_080, VK_RETURN)
                .bar(3_068, "Total"),
        );
        assert_eq!(cells(&records), [(Some("E2"), "=D2*0.2")]);
    }

    #[test]
    fn an_edit_of_a_formula_comes_from_the_formula_bar() {
        // F2 in E2, which holds "=SUM(B2:B3)", then "+1" and Enter at human speed: the keys are
        // only the change, the formula bar has all of it.
        let records = record(
            Scene::default()
                .focus_cell(0, "E2")
                .bar(0, "=SUM(B2:B3)")
                .press(1_000, VK_F2)
                .type_into(1_300, 300, "=SUM(B2:B3)", "+1\n"),
        );
        assert_eq!(cells(&records), [(Some("E2"), "=SUM(B2:B3)+1")]);
    }

    #[test]
    fn an_edit_put_in_before_the_bar_showed_its_last_key_is_approximate() {
        // F2, "+1", and Enter 100 ms after the "1": the formula bar was last read before the
        // "1". Its reading is the text, never with the "1" added, and the step asks to be checked.
        let records = record(
            Scene::default()
                .focus_cell(0, "E2")
                .bar(0, "=SUM(B2:B3)")
                .press(1_000, VK_F2)
                .type_into(1_300, 300, "=SUM(B2:B3)", "+1")
                .press(1_700, VK_RETURN),
        );
        assert_eq!(cells(&records), [(Some("E2"), "=SUM(B2:B3)+")]);
        assert!(records.iter().all(|record| record.approximate));
    }

    #[test]
    fn a_password_typed_in_excel_straight_after_a_click_is_never_kept() {
        // An add-in's sign-in pane inside Excel's window: a click on its password box, the
        // password typed at once, and the box's focus news after the first keys.
        let password_box = FocusUpdate {
            window: EXCEL,
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "Password".into(),
                is_password: true,
                sensitive: true,
                bounds: Some(PxRect {
                    left: 1_200,
                    top: 300,
                    right: 1_500,
                    bottom: 330,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: EXCEL_PID,
        };
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_named(1_000, 60, None)
                .type_keys(1_005, 10, "Tr0ub4dor3\n")
                .focus(1_030, password_box.clone()),
        );
        assert_eq!(cells(&records), []);

        // With no focus news for it at all, and no formula bar reading: the click's lookup found
        // the password box, which keeps Excel's window out as its news would, fast or at human
        // speed (the #97 third review: `Type "troubador"` in the selected cell).
        for (from, gap) in [(1_005, 10), (1_300, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_on(1_000, (1_300, 315), password_box.facts.clone())
                    .type_keys(from, gap, "troubador")
                    .click(4_000, "B2"),
            );
            assert_eq!(cells(&records), [], "keys from {from} ms");
        }
        // Its lookup took longer than keys wait for it: once it says a password box was clicked,
        // what was typed since is dropped, and what's typed after is kept out.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_looked_up(1_000, 1_500, (1_300, 315), Some(password_box.facts.clone()))
                .type_keys(2_100, 10, "trou")
                .type_keys(2_700, 150, "bador")
                .click(5_000, "B2"),
        );
        assert_eq!(cells(&records), []);
        // A cell clicked after it moves focus back to the sheet: typing there is the cell's.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_on(1_000, (1_300, 315), password_box.facts)
                .type_keys(1_005, 10, "troubador")
                .click(2_000, "B2")
                .type_keys(2_100, 150, "12\n"),
        );
        assert_eq!(cells(&records), [(Some("B2"), "12")]);
    }

    #[test]
    fn typing_after_an_excel_click_whose_lookup_failed_keeps_its_value_only_as_the_bar_shows_it() {
        // An add-in's password box in Excel's window, clicked, its lookup failed and named no
        // cell, and no focus news came: the keys went into the box, which the formula bar never
        // shows. Fast or at human speed, they keep no value, never `Type "troubador"` in the
        // selected cell (the #97 fourth review).
        for (from, gap) in [(1_005, 10), (1_300, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_named(1_000, 60, None)
                    .type_keys_unshown(from, gap, "troubador")
                    .click(4_000, "B2"),
            );
            assert_eq!(cells(&records), [(None, "")], "keys from {from} ms");
        }
        // The selected cell's own text begins as the password does, and the bar was read after
        // its first key alone (a pause, then the rest fast): the bar showing the cell is never
        // taken for the keys typed so far.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .bar(0, "troubleshooting")
                .click_named(1_000, 60, None)
                .type_keys_unshown(1_300, 10, "t")
                .type_keys_unshown(1_800, 10, "roubador\n")
                .click(6_000, "B2"),
        );
        assert_eq!(cells(&records), [(None, "")]);
        // A press the click pipeline never reports, the same.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .press_unreported(1_000)
                .type_keys_unshown(1_005, 150, "troubador")
                .click(6_000, "B2"),
        );
        assert_eq!(cells(&records), [(None, "")]);
        // Typed into the cell, the formula bar shows it: the value is kept, fast or not.
        for (from, gap) in [(1_005, 10), (1_300, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_named(1_000, 60, None)
                    .type_keys(from, gap, "VAT\n"),
            );
            assert_eq!(cells(&records), [(None, "VAT")], "keys from {from} ms");
        }
    }

    // ---------- an add-in's pane in Excel's window (#115) ----------

    /// Where the pane's password box is clicked, and its "Show" button beside it.
    const IN_PANE_PASSWORD: (i32, i32) = (1_300, 315);
    const ON_PANE_SHOW: (i32, i32) = (1_520, 315);

    /// An add-in's sign-in pane down the right of Excel's window, a web page in Edge's web view:
    /// Chrome's hit test answers with the whole page before its tree is built
    /// (`lookup::chrome_guess`), whatever is under the point.
    fn pane_page() -> ElementFacts {
        ElementFacts {
            control_type: "Document".into(),
            framework_id: "Chrome".into(),
            name: "Sign in".into(),
            bounds: Some(PxRect {
                left: 1_150,
                top: 100,
                right: 1_600,
                bottom: 900,
            }),
            ..ElementFacts::default()
        }
    }

    /// The pane's "Show" button beside its password box: a button, which takes no focus from the
    /// box.
    fn pane_show() -> ElementFacts {
        ElementFacts {
            control_type: "Button".into(),
            framework_id: "Chrome".into(),
            name: "Show".into(),
            bounds: Some(PxRect {
                left: 1_505,
                top: 300,
                right: 1_540,
                bottom: 330,
            }),
            ..ElementFacts::default()
        }
    }

    #[test]
    fn show_after_an_excel_click_whose_lookup_failed_still_checks_the_bar() {
        // The pane's password box clicked, its lookup failed and named no cell, then "Show" (its
        // lookup found the button), and the password typed with no focus news for the box: the
        // keys went into the box, which the formula bar never shows. Fast or at human speed, they
        // keep no value (#115: `Type "troubador"` in the selected cell).
        for (from, gap) in [(1_305, 10), (1_600, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_named(1_000, 60, None)
                    .click_on(1_300, ON_PANE_SHOW, pane_show())
                    .type_keys_unshown(from, gap, "troubador")
                    .click(4_000, "B2"),
            );
            assert_eq!(cells(&records), [(None, "")], "keys from {from} ms");
        }
        // A cell clicked after it moves focus back to the sheet: typing there keeps its value.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_named(1_000, 60, None)
                .click_on(1_300, ON_PANE_SHOW, pane_show())
                .type_keys_unshown(1_600, 150, "troubador")
                .click(4_000, "B2")
                .type_keys(4_300, 150, "12\n"),
        );
        assert_eq!(cells(&records), [(None, ""), (Some("B2"), "12")]);
    }

    #[test]
    fn chromes_page_answer_in_an_excel_pane_keeps_typing_only_as_the_bar_shows_it() {
        // The pane's password box clicked, and Chrome's hit test answered with the whole pane,
        // alone or followed by "Show": no focus news for the box, the password typed fast or at
        // human speed. Never `Type "troubador"` in the selected cell (#115).
        for (from, gap) in [(1_005, 10), (1_300, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_on(1_000, IN_PANE_PASSWORD, pane_page())
                    .type_keys_unshown(from, gap, "troubador")
                    .click(4_000, "B2"),
            );
            assert_eq!(cells(&records), [(None, "")], "alone, keys from {from} ms");
        }
        for (from, gap) in [(1_305, 10), (1_600, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_on(1_000, IN_PANE_PASSWORD, pane_page())
                    .click_on(1_300, ON_PANE_SHOW, pane_show())
                    .type_keys_unshown(from, gap, "troubador")
                    .click(4_000, "B2"),
            );
            assert_eq!(
                cells(&records),
                [(None, "")],
                "then Show, keys from {from} ms"
            );
        }
    }

    /// Where the pane's "Password" label, above its box, is clicked.
    const ON_PANE_LABEL: (i32, i32) = (1_250, 290);

    /// The pane's "Password" label: a line of the web view's text, whose `for` puts focus in the
    /// password box below it when it's clicked.
    fn pane_label() -> ElementFacts {
        ElementFacts {
            control_type: "Text".into(),
            framework_id: "Chrome".into(),
            name: "Password".into(),
            bounds: Some(PxRect {
                left: 1_200,
                top: 280,
                right: 1_300,
                bottom: 298,
            }),
            ..ElementFacts::default()
        }
    }

    #[test]
    fn a_click_on_a_label_in_an_excel_pane_keeps_typing_only_as_the_bar_shows_it() {
        // The pane's "Password" label clicked: its lookup names the label, and its `for` puts
        // focus in the password box, with no focus news for the box; the password typed fast or
        // at human speed, which the formula bar never shows. Anything in a web view in Excel's
        // window is an add-in's pane, never a cell: never `Type "troubador"` (#118).
        for (from, gap) in [(1_005, 10), (1_300, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .click_on(1_000, ON_PANE_LABEL, pane_label())
                    .type_keys_unshown(from, gap, "troubador")
                    .click(4_000, "B2"),
            );
            assert_eq!(cells(&records), [(None, "")], "keys from {from} ms");
        }
        // A cell clicked after it: typing there keeps its value.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_on(1_000, ON_PANE_LABEL, pane_label())
                .type_keys_unshown(1_300, 150, "troubador")
                .click(4_000, "B2")
                .type_keys(4_300, 150, "12\n"),
        );
        assert_eq!(cells(&records), [(None, ""), (Some("B2"), "12")]);
    }

    #[test]
    fn a_cell_already_holding_what_was_typed_never_shows_it_was_typed() {
        // The selected cell already holds the password, or text with it in, and the password is
        // typed into the pane's box after a click whose lookup failed: the formula bar shows the
        // cell all along, never changing, so it never shows the keys went there (#115).
        for (held, typed) in [
            ("troubador", "troubador"),
            ("Password: troubador", "troubador"),
            ("=A1234*2", "1234"),
        ] {
            for (from, gap) in [(1_005, 10), (1_300, 150)] {
                let records = record(
                    Scene::default()
                        .focus_cell(0, "E1")
                        .bar(0, held)
                        .click_named(1_000, 60, None)
                        .type_keys_unshown(from, gap, typed)
                        .click(4_000, "B2"),
                );
                assert_eq!(
                    cells(&records),
                    [(None, "")],
                    "the cell holds {held:?}, keys from {from} ms"
                );
            }
        }
    }

    #[test]
    fn typing_into_a_cell_after_a_doubtful_click_keeps_its_value() {
        // A cell clicked whose lookup failed, the cell holding other text: typed into it, the
        // formula bar changes to show the keys, fast or at human speed, a word or one digit.
        for (from, gap) in [(1_005, 10), (1_300, 150)] {
            let records = record(
                Scene::default()
                    .focus_cell(0, "E1")
                    .bar(0, "Total")
                    .click_named(1_000, 60, None)
                    .type_keys(from, gap, "VAT\n"),
            );
            assert_eq!(cells(&records), [(None, "VAT")], "keys from {from} ms");
        }
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .bar(0, "Total")
                .click_named(1_000, 60, None)
                .type_keys(1_300, 150, "5\n"),
        );
        assert_eq!(cells(&records), [(None, "5")]);
        // Then the next cell, after Enter.
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_named(1_000, 60, None)
                .type_keys(1_300, 150, "VAT\n=D2*0.2\n"),
        );
        assert_eq!(cells(&records), [(None, "VAT"), (None, "=D2*0.2")]);
        // F2 on a formula: the bar shows the edit.
        let records = record(
            Scene::default()
                .focus_cell(0, "E2")
                .bar(0, "=SUM(B2:B3)")
                .click_named(1_000, 60, None)
                .press(1_300, VK_F2)
                .type_into(1_600, 300, "=SUM(B2:B3)", "+1\n"),
        );
        assert_eq!(cells(&records), [(None, "=SUM(B2:B3)+1")]);
        // Bold on the ribbon clicked after the doubtful click, then typing into the cell: the bar
        // shows it.
        let bold = ElementFacts {
            control_type: "Button".into(),
            framework_id: "NetUI".into(),
            name: "Bold".into(),
            bounds: Some(PxRect {
                left: 90,
                top: 50,
                right: 114,
                bottom: 74,
            }),
            ..ElementFacts::default()
        };
        let records = record(
            Scene::default()
                .focus_cell(0, "E1")
                .click_named(1_000, 60, None)
                .click_on(1_300, (100, 60), bold)
                .type_keys(1_600, 150, "VAT\n"),
        );
        assert_eq!(cells(&records), [(None, "VAT")]);
    }

    // ---------- Excel's Go To and Name Box (#69) ----------

    const GO_TO: isize = 0x60_4000;
    /// The class of Excel's own dialogs, Go To among them.
    const EXCEL_DIALOG: &str = "bosa_sdm_XL9";
    const VK_CTRL: u16 = 0x11;
    const VK_ESCAPE: u16 = 0x1B;
    const VK_F5: u16 = 0x74;

    /// Excel's Go To dialog, which Ctrl+G and F5 open, in front of the workbook.
    fn go_to_dialog() -> WindowInfo {
        WindowInfo {
            hwnd: GO_TO,
            title: "Go To".into(),
            frame: rect(600, 250, 1000, 650),
            ..excel_window()
        }
    }

    /// Go To's Reference box, which has focus as the dialog opens: a box UI Automation can read.
    fn reference_box() -> FocusUpdate {
        FocusUpdate {
            window: GO_TO,
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "Reference:".into(),
                bounds: Some(PxRect {
                    left: 620,
                    top: 560,
                    right: 980,
                    bottom: 582,
                }),
                ..ElementFacts::default()
            },
            field: true,
            address_bar: false,
            tick_ms: 0,
            pid: EXCEL_PID,
        }
    }

    /// Excel's Name Box, left of the formula bar: the combo box Windows says has the keyboard.
    fn name_box() -> ComboBoxEdit {
        ComboBoxEdit {
            root: EXCEL,
            pid: EXCEL_PID,
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "Name Box".into(),
                automation_id: "1001".into(),
                class_name: "Edit".into(),
                framework_id: "Win32".into(),
                bounds: Some(PxRect {
                    left: 4,
                    top: 120,
                    right: 120,
                    bottom: 142,
                }),
                ..ElementFacts::default()
            },
        }
    }

    /// UI Automation's news of the Name Box getting focus.
    fn name_box_focus() -> FocusUpdate {
        FocusUpdate {
            window: EXCEL,
            facts: name_box().facts,
            field: true,
            address_bar: false,
            tick_ms: 0,
            pid: EXCEL_PID,
        }
    }

    /// Ctrl+G pressed in Excel at `ms`.
    fn ctrl_g(scene: Scene, ms: u32) -> Scene {
        scene
            .key(ms, VK_CTRL, false)
            .press(ms + 1, u16::from(b'G'))
            .key(ms + 4, VK_CTRL, true)
    }

    /// The cells gone to.
    fn went_to(records: &[TypingRecord]) -> Vec<&str> {
        records
            .iter()
            .filter(|record| record.form == "goTo")
            .map(|record| record.cell.as_deref().unwrap_or(""))
            .collect()
    }

    /// Each typing step's cell and text, leaving out the cells gone to.
    fn cell_typing(records: &[TypingRecord]) -> Vec<(Option<&str>, &str)> {
        records
            .iter()
            .filter(|record| record.form != "goTo")
            .map(|record| (record.cell.as_deref(), record.text.as_str()))
            .collect()
    }

    /// A1 clicked and selected, with Go To's dialog ready to open over the workbook.
    fn on_a1() -> Scene {
        Scene::default()
            .with_dialog(go_to_dialog(), EXCEL_DIALOG)
            .click(500, "A1")
            .focus_cell(580, "A1")
    }

    #[test]
    fn ctrl_g_a_reference_and_enter_go_to_the_cell() {
        // P39: Ctrl+G, `D11`, Enter recorded only Press "Ctrl + G": the Reference box was read as
        // focus left it, once the dialog had closed.
        let records = record(
            ctrl_g(on_a1(), 1_000)
                .focus(1_100, reference_box())
                .keys_to(Some(GO_TO))
                .type_keys(1_500, 150, "d11\n")
                .keys_to(None)
                .focus_cell(2_000, "D11"),
        );
        assert_eq!(went_to(&records), ["D11"]);
        assert_eq!(cell_typing(&records), []);
    }

    #[test]
    fn f5_a_reference_and_enter_go_to_the_cell() {
        let records = record(
            on_a1()
                .press(1_000, VK_F5)
                .focus(1_100, reference_box())
                .keys_to(Some(GO_TO))
                .type_keys(1_500, 150, "D11\n")
                .keys_to(None)
                .focus_cell(2_000, "D11"),
        );
        assert_eq!(went_to(&records), ["D11"]);
    }

    #[test]
    fn typing_straight_after_go_to_goes_into_the_cell_gone_to() {
        // "100" typed the moment the dialog closed, before Excel's news of D11: it's D11's, never
        // A1's, the cell selected before F5.
        let records = record(
            on_a1()
                .press(1_000, VK_F5)
                .focus(1_100, reference_box())
                .keys_to(Some(GO_TO))
                .type_keys(1_500, 150, "d11\n")
                .keys_to(None)
                .type_keys(1_970, 20, "100\n")
                .focus_cell(2_300, "D11"),
        );
        assert_eq!(went_to(&records), ["D11"]);
        assert_eq!(cell_typing(&records), [(Some("D11"), "100")]);
    }

    #[test]
    fn go_to_left_with_escape_goes_nowhere() {
        let records = record(
            ctrl_g(on_a1(), 1_000)
                .focus(1_100, reference_box())
                .keys_to(Some(GO_TO))
                .type_keys(1_500, 150, "d11")
                .press(2_200, VK_ESCAPE)
                .keys_to(None)
                .focus_cell(2_300, "A1"),
        );
        assert_eq!(went_to(&records), Vec::<&str>::new());
        assert_eq!(cell_typing(&records), []);
    }

    #[test]
    fn only_a_cell_reference_typed_in_go_to_is_a_cell_gone_to() {
        // A range or a name selects more than a cell: no step says it went to one.
        for text in ["d11:f20\n", "Totals\n"] {
            let records = record(
                ctrl_g(on_a1(), 1_000)
                    .focus(1_100, reference_box())
                    .keys_to(Some(GO_TO))
                    .type_keys(1_500, 150, text),
            );
            assert_eq!(went_to(&records), Vec::<&str>::new(), "{text:?}");
        }
    }

    #[test]
    fn a_reference_typed_in_another_excel_dialog_is_no_go_to() {
        // No Ctrl+G or F5 opened it: an Excel dialog's box is a box as before.
        let records = record(
            on_a1()
                .focus(1_100, reference_box())
                .keys_to(Some(GO_TO))
                .type_keys(1_500, 150, "d11\n"),
        );
        assert_eq!(went_to(&records), Vec::<&str>::new());
    }

    #[test]
    fn a_reference_typed_in_the_name_box_goes_to_the_cell() {
        // Clicked into the Name Box, `D11` typed and Enter: Excel goes there and the keyboard
        // goes back to the sheet. Then "100" typed into D11.
        let records = record(
            on_a1()
                .keyboard_at(1_000, Some(name_box()))
                .click_named(1_000, 60, None)
                .focus(1_050, name_box_focus())
                .type_keys(1_500, 150, "d11\n")
                .keyboard_at(1_960, None)
                .focus_cell(2_000, "D11")
                .type_keys(3_000, 150, "100\n"),
        );
        assert_eq!(went_to(&records), ["D11"]);
        assert_eq!(cell_typing(&records), [(Some("D11"), "100")]);
    }

    #[test]
    fn a_name_typed_in_the_name_box_is_typing_in_the_name_box() {
        // A name goes to, or names, more than a cell: the step says what was typed, and where.
        let records = record(
            on_a1()
                .keyboard_at(1_000, Some(name_box()))
                .click_named(1_000, 60, None)
                .focus(1_050, name_box_focus())
                .type_keys(1_500, 150, "Totals\n")
                .keyboard_at(2_460, None),
        );
        assert_eq!(went_to(&records), Vec::<&str>::new());
        assert_eq!(typed_in(&records), [(Some("Name Box"), "Totals")]);
        assert_eq!(cell_typing(&records), [(None, "Totals")]);
    }

    #[test]
    fn the_name_box_left_with_escape_or_a_click_makes_no_step() {
        // Excel puts back the cell's reference: nothing was done.
        let escaped = on_a1()
            .keyboard_at(1_000, Some(name_box()))
            .click_named(1_000, 60, None)
            .focus(1_050, name_box_focus())
            .type_keys(1_500, 150, "d11")
            .press(2_100, VK_ESCAPE)
            .keyboard_at(2_110, None);
        let clicked_away = on_a1()
            .keyboard_at(1_000, Some(name_box()))
            .click_named(1_000, 60, None)
            .focus(1_050, name_box_focus())
            .type_keys(1_500, 150, "d11")
            .keyboard_at(2_500, None)
            .click(2_500, "B2");
        for scene in [escaped, clicked_away] {
            let records = record(scene);
            assert_eq!(went_to(&records), Vec::<&str>::new());
            assert_eq!(cell_typing(&records), []);
        }
    }

    #[test]
    fn a_reference_typed_into_a_cell_is_typing_in_the_cell() {
        // Windows says the sheet has the keyboard: "D11" is what A1 holds now.
        let records = record(on_a1().type_keys(1_500, 150, "D11\n"));
        assert_eq!(went_to(&records), Vec::<&str>::new());
        assert_eq!(cell_typing(&records), [(Some("A1"), "D11")]);
    }
}
