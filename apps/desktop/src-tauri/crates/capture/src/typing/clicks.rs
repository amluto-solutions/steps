//! Clicks as the key worker hears of them (docs/spec/02-capture.md#keys): each one ends a stretch
//! of typing, and says where the keys typed straight after it go. In Excel that's the cell its
//! lookup found (#75); anywhere else the element its focus news names, or the element clicked
//! (#97). One reason to change: what a click tells the key worker.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::excel::cell_name;
use crate::facts::ElementFacts;
use crate::lookup::{FIREFOX_WINDOW_CLASS, chrome_guess, in_web_view, is_editable};
use crate::state_machine::tick_before_or_at;

use super::dictation::{Began, Ended, Reading};
use super::editor_keys::{FILE_DIALOG_CLASS, file_dialog_pane};
use super::{CLICK_LOOKUP_WAIT, Desktop, FocusNote, Worker, element_in_window};

/// How many clicks the click pipeline's reports are kept for: far more than it can tell of
/// between two of the key worker's turns, or than wait there to be applied.
const CLICKS_KEPT: usize = 32;

/// Clicks, as the click pipeline reports them: every press it takes from the queue, as a click
/// (`PressReport::clicked`) or passed over when it makes none, then what the click's lookup found
/// (`named`). Each click is kept in turn, so one the key worker hasn't applied yet is never lost
/// to the next (#97).
#[derive(Debug, Default)]
pub struct ClickNews {
    reports: Mutex<Reports>,
}

/// The clicks the pipeline recorded, oldest first, and the latest press it reported.
#[derive(Debug, Default)]
struct Reports {
    clicks: VecDeque<ClickNote>,
    /// How many clicks it has recorded.
    count: u64,
    /// The latest press it has reported, as a click or passed over.
    reached: Option<u32>,
}

/// A click the pipeline recorded.
#[derive(Debug, Clone, Default)]
pub(super) struct ClickNote {
    /// Which click it is: one more than the click before it.
    pub(super) count: u64,
    pub(super) tick: u32,
    /// The top-level window clicked.
    pub(super) window: isize,
    /// Where the button went down, in physical pixels.
    pub(super) point: (i32, i32),
    pub(super) lookup: ClickLookup,
}

/// What a click's lookup says was clicked, as the click pipeline tells the key worker (#97).
#[derive(Debug, Clone)]
pub enum Looked {
    /// The element clicked.
    Found(Box<ElementFacts>),
    /// Nothing under a click there is read, by design: a remote session's window, whose controls
    /// are another computer's, and Windows' input panel (`pipeline::unread_under_click`). Focus
    /// can't move to anything UI Automation sees there, so the click leaves it where it was (the
    /// #97 third review: every click in a remote session withheld all typing after it). Typing in
    /// a remote session keeps no value anyway, whatever the clicks (#113).
    Unread,
    /// The lookup failed or timed out, or the click couldn't be processed: what was clicked
    /// can't be told.
    Failed,
}

/// What a click's lookup found.
#[derive(Debug, Clone, Default)]
pub(super) enum ClickLookup {
    /// The lookup hasn't finished.
    #[default]
    Looking,
    /// What it says was clicked, and the spreadsheet cell it selected (`None` for anything else).
    Named {
        looked: Looked,
        cell: Option<String>,
    },
}

impl ClickLookup {
    /// The spreadsheet cell the click selected.
    pub(super) fn cell(&self) -> Option<String> {
        match self {
            Self::Named { cell, .. } => cell.clone(),
            Self::Looking => None,
        }
    }

    pub(super) fn named(&self) -> bool {
        matches!(self, Self::Named { .. })
    }

    /// The lookup failed or hasn't finished: what was clicked can't be told. Not one skipped by
    /// design ([`Looked::Unread`]).
    pub(super) fn couldnt_tell(&self) -> bool {
        matches!(
            self,
            Self::Looking
                | Self::Named {
                    looked: Looked::Failed,
                    ..
                }
        )
    }

    /// The lookup's answer for a click at `(x, y)` is Chrome's page answer (`lookup::chrome_guess`):
    /// the page, not what's under the point, which can be a password box (#115).
    pub(super) fn page_answer(&self, (x, y): (i32, i32)) -> bool {
        self.element()
            .is_some_and(|clicked| chrome_guess(&clicked, x, y))
    }

    /// The lookup names something in a web page (`lookup::in_web_view`): in Excel's window, an
    /// add-in's pane, never a cell, where a click can put focus in a password box the lookup
    /// didn't name (a label's `for`), which keys sent there never show in the formula bar (#118).
    pub(super) fn in_web_page(&self) -> bool {
        self.element().is_some_and(|clicked| in_web_view(&clicked))
    }

    /// The lookup names something in a web page that isn't a box ([`page_text`]), in Firefox's
    /// window when `firefox`: the keys typed after the click are taken to go where focus was,
    /// which the click may have moved (#118).
    pub(super) fn on_page_text(&self, firefox: bool) -> bool {
        self.element()
            .is_some_and(|clicked| page_text(&clicked, firefox))
    }

    /// The element clicked, once the lookup has found it.
    fn element(&self) -> Option<ElementFacts> {
        match self {
            Self::Named { looked, .. } => match looked {
                Looked::Found(element) => Some(element.as_ref().clone()),
                Looked::Unread | Looked::Failed => None,
            },
            Self::Looking => None,
        }
    }

    /// Nothing under the click was read, by design ([`Looked::Unread`]).
    fn unread(&self) -> bool {
        matches!(
            self,
            Self::Named {
                looked: Looked::Unread,
                ..
            }
        )
    }

    /// The lookup says a box that holds a password or a secret was clicked, or a part of one.
    fn secret(&self) -> bool {
        self.element()
            .is_some_and(|clicked| clicked.is_password || clicked.sensitive)
    }

    /// The lookup says the click went to a box other than `focused` (an edit box, a combo box,
    /// a web page's text box), or selected a spreadsheet cell: focus went there, not left where
    /// it was. `false` until it says, and when it can't.
    fn moves_focus(&self, focused: &FocusNote) -> bool {
        self.cell().is_some()
            || self.element().is_some_and(|clicked| {
                is_editable(&clicked) && !same_element(&clicked, &focused.facts)
            })
    }
}

/// A press the click pipeline has taken from the queue, to be reported to the key worker: as a
/// click with [`PressReport::clicked`], or, dropped without it, as passed over (the second press
/// of a double-click, a click in Steps' own windows or an excluded app, on a screen left out, or
/// while paused). Keys typed after a press wait until then (#97).
#[must_use]
pub struct PressReport<'a> {
    news: &'a ClickNews,
    tick: u32,
    clicked: bool,
}

impl PressReport<'_> {
    /// The press is a click the pipeline records, in the top-level window `window` at `point`:
    /// called as soon as the window is known, before the click's lookup, which can take a while.
    pub fn clicked(mut self, window: isize, point: (i32, i32)) {
        self.clicked = true;
        let mut reports = self.news.lock();
        reports.count += 1;
        let count = reports.count;
        if reports.clicks.len() >= CLICKS_KEPT {
            reports.clicks.pop_front();
        }
        reports.clicks.push_back(ClickNote {
            count,
            tick: self.tick,
            window,
            point,
            lookup: ClickLookup::Looking,
        });
        reports.reached = Some(self.tick);
    }
}

impl Drop for PressReport<'_> {
    fn drop(&mut self) {
        if !self.clicked {
            self.news.lock().reached = Some(self.tick);
        }
    }
}

impl ClickNews {
    /// Called by the click pipeline for every press it takes from the queue, before deciding
    /// whether it's a click.
    pub fn press(&self, tick_ms: u32) -> PressReport<'_> {
        PressReport {
            news: self,
            tick: tick_ms,
            clicked: false,
        }
    }

    /// Called once the lookup of the click at `tick_ms` has finished, with what it says was
    /// clicked and the spreadsheet cell it selected: `None` for anything else.
    pub fn named(&self, tick_ms: u32, looked: Looked, cell: Option<String>) {
        let mut reports = self.lock();
        // The latest click pressed then: the pipeline names each click before taking the next.
        if let Some(click) = reports
            .clicks
            .iter_mut()
            .rev()
            .find(|click| click.tick == tick_ms)
        {
            click.lookup = ClickLookup::Named { looked, cell };
        }
    }

    /// The clicks after the click numbered `count`, oldest first, and the latest press reported.
    pub(super) fn since(&self, count: u64) -> (Vec<ClickNote>, Option<u32>) {
        let reports = self.lock();
        let clicks = reports
            .clicks
            .iter()
            .filter(|click| click.count > count)
            .cloned()
            .collect();
        (clicks, reports.reached)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Reports> {
        self.reports.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A click the key worker has heard of and not yet applied.
pub(super) struct PendingClick {
    /// Which click it is ([`ClickNote::count`]).
    pub(super) count: u64,
    /// When the worker heard of it: of its press, from the input thread, if that came first.
    pub(super) seen: Instant,
    /// When the pipeline reported it.
    pub(super) reported: Instant,
    pub(super) tick: u32,
    pub(super) window: isize,
    pub(super) point: (i32, i32),
    pub(super) lookup: ClickLookup,
    /// The watched text box as the worker heard of the click, before the app reacted to it
    /// (#91).
    pub(super) reading: Option<Reading>,
    /// The window clicked is Firefox's ([`FIREFOX_WINDOW_CLASS`]): what's in it is a web page's,
    /// whatever framework UI Automation names (#119).
    pub(super) firefox: bool,
}

/// How long keys typed after a mouse press wait for the click pipeline to report it: it takes
/// clicks one at a time, and a click's lookup can take a while (`PipelineConfig::uia_timeout`).
pub(super) const PRESS_REPORT_WAIT: Duration = Duration::from_secs(2);

/// A mouse press the input thread saw that the click pipeline hasn't reported yet: keys typed
/// after it, and focus news heard of since, wait for it (#97).
#[derive(Debug, Clone, Copy)]
pub(super) struct WaitingPress {
    pub(super) tick: u32,
    /// When the worker heard of it.
    pub(super) seen: Instant,
    /// Clicks the pipeline told of that were let go before the worker heard of them, from this
    /// one on: applied as a click nothing is known of as soon as its turn comes.
    pub(super) lost: bool,
}

/// How long after a click focus news can be the click's own: a click moves focus as the button
/// goes down, and UI Automation tells of it late, after keys typed straight after the click.
const CLICK_NEWS_MS: u32 = 1_000;

/// The latest click applied outside Excel (whose cells have rules of their own, #75), for where
/// the keys typed straight after it went (#97).
#[allow(
    clippy::struct_excessive_bools,
    reason = "each is a separate fact about the click, not states of one thing"
)]
pub(super) struct SinceClick {
    tick: u32,
    /// Which click it is ([`ClickNote::count`]), for its lookup finishing after it was applied;
    /// `None` for a press the click pipeline never reported.
    count: Option<u64>,
    /// The top-level window clicked, and where the button went down; `None` for a press the click
    /// pipeline never reported.
    at: Option<(isize, (i32, i32))>,
    /// A press standing for clicks the key worker never heard of: when they were is a guess, so no
    /// focus news is known to be from after them (#97 second review).
    lost: bool,
    /// The window clicked is a dialog box, as Save As and Open are.
    in_dialog: bool,
    /// The click's lookup has finished.
    looked_up: bool,
    /// Nothing under the click was read, by design ([`Looked::Unread`]).
    unread: bool,
    /// The element clicked, as its lookup found it: `None` until it has, or when it couldn't tell.
    element: Option<ElementFacts>,
    /// The window clicked is Firefox's ([`PendingClick::firefox`]).
    firefox: bool,
    /// As the button went down, focus in the window clicked may have been in a box that holds a
    /// password: one had focus there since the click before (the password guard), or that click
    /// was into one. Where this click leaves focus where it was, it's still there (the #97 third
    /// review: a click on "Show" beside a password box let the password go to a stale box).
    password_before: bool,
    /// As the button went down, where keys typed in the window `doubted` went couldn't be told:
    /// the click before, in that window (or a press nothing is known of), couldn't say. Where
    /// this click leaves focus where it was, it still can't be told (the #97 fourth review: a
    /// click on "Show" after a password box clicked whose lookup failed let the password go to
    /// the box focused before both).
    unknown_before: bool,
    /// As the button went down, where keys typed in the window `doubted` went rested on the focus
    /// from before a click that couldn't tell what it went to (Chrome's page answer, which takes
    /// focus as left where it was): where this click leaves focus where it was, it still does, and
    /// UI Automation is asked what has focus before a stretch keeps a value (#97 fourth review).
    unproven_before: bool,
    /// The window `unknown_before` and `unproven_before` are about: the window clicked, or, for a
    /// click where nothing is read in another window (Windows' input panel, which takes no focus
    /// from the window keys go to), the window the click before was in.
    doubted: Option<isize>,
    /// The first key that can move focus (Tab, Enter, Escape, a key combination) typed after the
    /// click, when it's been handled.
    focus_key: Option<u32>,
    /// The first focus news heard in the second after the click, once applied.
    news: Option<ClickNewsHeard>,
}

/// The first focus news heard in the second after a click. Whether it's the click's own is asked
/// each time, since the click's lookup can finish after it was heard (#97 second review).
struct ClickNewsHeard {
    heard: u32,
    note: FocusNote,
}

impl SinceClick {
    /// Whether the click was inside the bounds of `note`'s element, in the window clicked.
    fn inside(&self, note: &FocusNote) -> bool {
        self.at
            .is_some_and(|(window, point)| inside(note, window, point))
    }

    /// The element clicked says it holds a password or a secret.
    fn secret(&self) -> bool {
        self.element
            .as_ref()
            .is_some_and(|clicked| clicked.is_password || clicked.sensitive)
    }

    /// Whether focus news is of the element clicked: the click was inside it, in the window
    /// clicked, and it's a box (focus goes to the box clicked, or to the box a part clicked is
    /// of), or the element clicked itself, or something else at the click point that isn't what
    /// holds the element clicked. A page or a dialog holding the element clicked is never given
    /// focus by a click on a box in it, or on a part of one (a line of its text, its
    /// placeholder): news of it is from before the click (#97 reviews). Until the lookup says
    /// what was clicked, only a box there is the click's (or a document that is all text, such as
    /// Word's body, which holds no box a click could have gone into instead); when it says a
    /// password or secret box was, only news of that box, or of another that says it holds one.
    fn names_clicked(&self, note: &FocusNote) -> bool {
        if !self.inside(note) {
            return false;
        }
        let Some(clicked) = self.element.as_ref() else {
            return is_box(note) || is_text_document(&note.facts);
        };
        if self.secret() {
            return same_element(clicked, &note.facts) || note.secret();
        }
        is_box(note)
            || same_element(clicked, &note.facts)
            || (!is_editable(clicked) && !holds(note, clicked))
    }

    /// Whether focus news heard at `heard` came more than a second after the click and before
    /// keys typed at `tick`: focus moved on since (by a key, or the app), and it says where they
    /// went. Never for clicks let go unheard of, whose time is a guess. After a click that may
    /// have left focus in a password box, or that couldn't tell what it went to, only once a key
    /// that can move focus (Tab, Enter, Escape, a combination) was typed after the click and
    /// before the news: a late focus note is when Steps' handler read it, not when focus moved,
    /// so stale news told more than a second late had taken the password (the #97 third review,
    /// and the fourth: after a lookup that failed, a press nothing is known of, or Chrome's page
    /// answer, since a lookup timing out and a note read late share a cause, UI Automation busy;
    /// and #118: after a click on a web page's text, which can have put focus in a password box
    /// that gave no news).
    fn moved_on(&self, heard: u32, tick: u32) -> bool {
        !self.lost
            && !tick_before_or_at(heard, self.tick)
            && !heard_after(self.tick, heard)
            && tick_before_or_at(heard, tick)
            && (!(self.secret()
                || self.password_before
                || self.unknown_before
                || self.unproven_before
                || self.unproven())
                || self
                    .focus_key
                    .is_some_and(|key| tick_before_or_at(key, heard)))
    }

    /// Whether what was clicked can't be told: a press nothing is known of, a lookup that failed
    /// or hasn't finished (not one skipped by design, [`Looked::Unread`]), or Chrome's page answer
    /// (`lookup::chrome_guess`), which can stand over a password box (#97 fourth review).
    fn couldnt_tell(&self) -> bool {
        match (self.at, self.element.as_ref()) {
            (None, _) => true,
            (Some(_), None) => !self.unread,
            (Some((_, (x, y))), Some(clicked)) => chrome_guess(clicked, x, y),
        }
    }

    /// Whether where the keys typed after the click went rests on the focus from before it, with
    /// nothing to prove focus stayed there: the click couldn't tell what it went to, or it was on
    /// something in a web page that isn't a box ([`page_text`]), whose label's `for` or script
    /// can have moved focus into a password box with no news (#118).
    fn unproven(&self) -> bool {
        self.couldnt_tell() || self.on_page_text()
    }

    /// Whether the click was on something in a web page that isn't a box ([`page_text`]).
    fn on_page_text(&self) -> bool {
        self.element
            .as_ref()
            .is_some_and(|clicked| page_text(clicked, self.firefox))
    }

    /// Whether, as far as its lookup tells, the click left focus with `focused`, the element
    /// that had it as the button went down: unless what was clicked is a box of its own (an edit
    /// box, a combo box, a web page's text box) other than that one, which focus goes to. A click
    /// on Bold, or in the text being typed in, leaves focus where it was, and so does any click
    /// where nothing is read by design (a remote session's window, Windows' input panel). When the
    /// lookup couldn't tell what was clicked (or hasn't yet), only a click inside the element with
    /// focus does, when that's a box or a document that is all text (Word's body, Notepad's).
    fn left_focus(&self, focused: &FocusNote) -> bool {
        if self.unread {
            return true;
        }
        match self.element.as_ref() {
            Some(clicked) if !is_editable(clicked) => return true,
            Some(clicked) if same_element(clicked, &focused.facts) => return true,
            _ => {}
        }
        // On a part of the box with focus, such as a combo box's edit, or in a document that is
        // all text, which holds no box the click could have gone into instead.
        (self.inside(focused) && (is_box(focused) || is_text_document(&focused.facts)))
            // Save As or Open, whose pane UI Automation can say has focus while the keyboard is in
            // File name: where the keyboard is after the click, Windows says (#61), and the File
            // name box is checked to be the dialog's own and not a password box. Anywhere in the
            // dialog when what was clicked can't be told.
            || (self.in_dialog
                && file_dialog_pane(&focused.facts, FILE_DIALOG_CLASS)
                && (self.inside(focused)
                    || (self.element.is_none()
                        && self.at.is_some_and(|(window, _)| focused.window == window))))
    }

    /// The top-level window clicked, when the click pipeline reported the click.
    fn window(&self) -> Option<isize> {
        self.at.map(|(window, _)| window)
    }
}

/// Whether an element clicked is something in a web page that isn't a box (a line of text, a
/// heading, a link, a button such as Bold): a click on it is taken to leave focus where it was,
/// but a label's `for`, or the page's own script, can move it into a password box, with no focus
/// news (#118: a click on a password box's label let the password go to the search box focused
/// before). In Firefox's window (`firefox`), anything is a web page's (#119).
fn page_text(clicked: &ElementFacts, firefox: bool) -> bool {
    (in_web_view(clicked) || firefox) && !is_editable(clicked)
}

/// Whether an element clicked inside a box can be a part of the box itself: a line of its text, or
/// a group of its parts. Not a button, an image or a link drawn over it, such as an inline "Next"
/// arrow, whose script can move focus into a password box with no news (#119: the password went
/// to the e-mail box it was drawn in).
fn box_part(clicked: &ElementFacts) -> bool {
    matches!(clicked.control_type.as_str(), "Text" | "Group")
}

/// Whether focus news is of a box keys are typed into: an edit box, a combo box, a web page's text
/// box, or a field read as focus leaves it.
fn is_box(note: &FocusNote) -> bool {
    note.field || is_editable(&note.facts)
}

/// The classes of documents that are all text, holding no box of their own: Word's body (Outlook
/// writes mail in the same one) and Windows 11 Notepad's. A click inside one can only have gone
/// into its text, so it leaves focus there, and its focus news is the click's own, even when the
/// click's lookup timed out (the #97 third review: typing there after such a click kept no value).
/// A web page's Document isn't one: it can hold a password box.
const TEXT_DOCUMENT_CLASSES: &[&str] = &["_WwG", "RichEditD2DPT"];

/// Whether `facts` are of a document that is all text ([`TEXT_DOCUMENT_CLASSES`]).
fn is_text_document(facts: &ElementFacts) -> bool {
    facts.control_type == "Document" && TEXT_DOCUMENT_CLASSES.contains(&facts.class_name.as_str())
}

/// Whether `note`'s element may hold `clicked`: its bounds take in the element clicked's, and
/// more. With either's bounds unknown, it may.
fn holds(note: &FocusNote, clicked: &ElementFacts) -> bool {
    match (note.facts.bounds, clicked.bounds) {
        (Some(outer), Some(inner)) => {
            outer != inner && outer.intersect(&inner).is_some_and(|both| both == inner)
        }
        _ => true,
    }
}

/// Whether `clicked` and `focused` are one element, however their bounds were read: by what they
/// are, and, unless an automation id (a dialog's control id, a page's element id) tells them
/// apart, by overlapping. UI Automation can read a box's bounds as it gets focus part-way
/// through its dialog's opening animation, and a message box grows as its text wraps.
fn same_element(clicked: &ElementFacts, focused: &ElementFacts) -> bool {
    clicked.control_type == focused.control_type
        && clicked.class_name == focused.class_name
        && clicked.automation_id == focused.automation_id
        && clicked.name == focused.name
        && clicked.is_password == focused.is_password
        && (!clicked.automation_id.is_empty()
            || match (clicked.bounds, focused.bounds) {
                (Some(clicked), Some(focused)) => clicked.intersect(&focused).is_some(),
                _ => true,
            })
}

/// Where keys typed after the latest click went, as far as the click tells (#97).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum KeysWent {
    /// Where focus was as of the keys handled so far says.
    Focus,
    /// Can't be told: no field is named, and no value is kept (10/10/2026).
    Unknown,
    /// Can't be told, and the element clicked says it holds a password or a secret: they may have
    /// gone into it, so nothing is kept.
    Secret,
}

impl<D: Desktop> Worker<D> {
    /// Notes the clicks the pipeline reported since the last turn, and lookups finished since for
    /// those waiting to be applied, and the mouse press the input thread last saw (`press`), which
    /// keys typed after it wait for until the pipeline reports it.
    pub(super) fn take_click_news(&mut self, now: Instant, press: Option<u32>) {
        let oldest = self
            .pending_clicks
            .front()
            .map_or(self.last_clicks, |click| click.count.saturating_sub(1));
        // The latest click applied, while its lookup hasn't finished: it says what was clicked
        // once it has (#97 second review), in Excel too (the #97 third review).
        let unnamed = self.unnamed_click.map(|(count, _, _)| count);
        let oldest = unnamed.map_or(oldest, |count| oldest.min(count.saturating_sub(1)));
        let (clicks, reached) = self.clicks.since(oldest);
        if clicks
            .iter()
            .find(|click| click.count > self.last_clicks)
            .is_some_and(|click| click.count > self.last_clicks + 1)
        {
            self.clicks_lost(now);
        }
        for click in clicks {
            if click.count > self.last_clicks {
                self.last_clicks = click.count;
                self.click_reported(click, now);
            } else if let Some(pending) = self
                .pending_clicks
                .iter_mut()
                .find(|pending| pending.count == click.count)
            {
                // Its lookup may have finished since.
                pending.lookup = click.lookup;
            } else if Some(click.count) == unnamed && click.lookup.named() {
                self.looked_up_late(&click.lookup);
            }
        }
        let reported = |tick: u32| reached.is_some_and(|reached| tick_before_or_at(tick, reached));
        if press != self.last_press {
            self.last_press = press;
            if let Some(tick) = press
                && !reported(tick)
                && self.lock_machine().is_active()
            {
                self.waiting_presses.push_back(WaitingPress {
                    tick,
                    seen: now,
                    lost: false,
                });
            }
        }
        // Reported as a click, or passed over: the second press of a double-click, a click in
        // Steps' own windows or an excluded app, on a screen left out.
        self.waiting_presses
            .retain(|waiting| waiting.lost || !reported(waiting.tick));
    }

    /// The pipeline told of more clicks than are kept before the worker's turn (it fell far
    /// behind), so it never heard of some: from the first of them, as far as can be told, it's a
    /// click nothing is known of, which fails closed. That's just after the last click heard of
    /// (with none, the worker's start), or an earlier press still waiting.
    fn clicks_lost(&mut self, now: Instant) {
        // Never "now": keys typed after the first click let go and before now would be handled
        // before it, with the focus from before it (#97 second review).
        let earliest = self
            .heard_click
            .map_or(self.started, |tick| tick.wrapping_add(1));
        let (tick, seen) = match self.waiting_presses.front() {
            Some(waiting) if !tick_before_or_at(earliest, waiting.tick) => {
                (waiting.tick, waiting.seen)
            }
            Some(waiting) => (earliest, waiting.seen),
            None => (earliest, now),
        };
        self.waiting_presses.push_front(WaitingPress {
            tick,
            seen,
            lost: true,
        });
    }

    /// The lookup of the latest click applied finished only after it was applied: it says what
    /// was clicked from now on. When that's a box that says it holds a password or a secret, the
    /// typing begun since the click may be one, so none of it is kept (#97 second review), and
    /// the password guard keeps the window out from now on, in Excel too (the #97 third review).
    fn looked_up_late(&mut self, lookup: &ClickLookup) {
        let Some((count, tick, window)) = self.unnamed_click.take() else {
            return;
        };
        if let Some(since) = self
            .since_click
            .as_mut()
            .filter(|since| since.count == Some(count))
        {
            since.looked_up = true;
            since.unread = lookup.unread();
            since.element = lookup.element();
        }
        if !lookup.secret() {
            return;
        }
        self.password.clicked_into(window);
        if self
            .stretch
            .as_ref()
            .is_some_and(|stretch| !tick_before_or_at(stretch.first_tick, tick))
        {
            self.stretch = None;
        }
    }

    /// A click the pipeline reported: it waits to be applied in time order with the keys, after
    /// any reported before it.
    fn click_reported(&mut self, click: ClickNote, now: Instant) {
        // Its press waited too long for it, and was applied as a press nothing was known of.
        if self
            .applied_press
            .is_some_and(|applied| tick_before_or_at(click.tick, applied))
        {
            return;
        }
        // The watched text box now, before the app reacts to the click: a paste chosen from a
        // menu happens as the button comes up, and is never taken for dictation (#91).
        let reading = self.read_at_click(click.tick, now);
        self.heard_click = Some(click.tick);
        // Heard of as its press: keys and focus news since then wait for it.
        let seen = self
            .waiting_presses
            .iter()
            .find(|waiting| waiting.tick == click.tick)
            .map_or(now, |waiting| waiting.seen);
        let firefox = self
            .window(click.window)
            .is_some_and(|(_, class)| class == FIREFOX_WINDOW_CLASS);
        self.pending_clicks.push_back(PendingClick {
            count: click.count,
            seen,
            reported: now,
            tick: click.tick,
            window: click.window,
            point: click.point,
            lookup: click.lookup,
            reading,
            firefox,
        });
    }

    /// A click, all that came before it handled: it ends the stretch of typing, and in Excel names
    /// the cell typed into next.
    pub(super) fn apply_click(&mut self, mut click: PendingClick, now: Instant) {
        let reading = click.reading.take();
        let tick = click.tick;
        let password_before = self.password_before(click.window, tick);
        // Where keys typed as the button went down went couldn't be told, or rested on a click
        // that couldn't tell what it went to: a click that leaves focus where it was can't tell
        // either (the #97 fourth review).
        // A click where nothing is read, in another window (Windows' input panel), takes no focus
        // from the window the click before was in: what was in doubt there still is.
        let previous = self.since_click.as_ref().and_then(SinceClick::window);
        let doubted = match previous {
            Some(previous) if click.lookup.unread() && previous != click.window => previous,
            _ => click.window,
        };
        let before = self
            .since_click
            .as_ref()
            .is_some_and(|since| since.window() == Some(doubted) || since.at.is_none());
        let unknown_before = before && self.keys_went(tick, doubted) == KeysWent::Unknown;
        let unproven_before = before && self.keys_unproven(tick, doubted);
        // A click where nothing is read by design takes no focus from the window kept out (Windows'
        // input panel never takes it), so that window stays kept out.
        let kept_out = self.password.window().filter(|_| click.lookup.unread());
        self.password.clicked(&self.applied);
        if let Some(window) = kept_out {
            self.password.clicked_into(window);
        }
        // Focus as the button went down may have been in a password box, and this click may have
        // left it there (on a "Show" button beside it, or anywhere when what was clicked can't be
        // told): the window stays kept out until the next click, Excel's too (the #97 third
        // review). And a box the lookup says holds a password keeps it out as its focus news
        // would, Excel's too: an add-in's sign-in pane is inside Excel's window.
        if (password_before && !click.lookup.moves_focus(&self.applied)) || click.lookup.secret() {
            self.password.clicked_into(click.window);
        }
        // A reading of the watched box the typing it ends took is the click's cut's too.
        self.dictation.forget_read_now();
        self.end_stretch(true);
        let class = self.window(click.window).map(|(_, class)| class);
        let since = SinceClick {
            tick,
            count: Some(click.count),
            at: Some((click.window, click.point)),
            lost: false,
            in_dialog: class.as_deref() == Some(FILE_DIALOG_CLASS),
            looked_up: click.lookup.named(),
            unread: click.lookup.unread(),
            element: click.lookup.element(),
            firefox: click.firefox,
            password_before,
            unknown_before,
            unproven_before,
            doubted: Some(doubted),
            focus_key: None,
            news: None,
        };
        self.unnamed_click = (!click.lookup.named()).then_some((click.count, tick, click.window));
        self.since_click = (!self.is_excel(click.window)).then_some(since);
        // News heard after it may have been applied before it: it reached the worker first.
        let applied = self.applied.clone();
        self.click_heard_of(&applied);
        self.clicked(&click);
        let ended = Ended::Click { tick, heard: true };
        self.dictation_cut(reading, ended, Began::Other, now);
    }

    /// A press the click pipeline didn't report in time (`PRESS_REPORT_WAIT`), or by Pause or
    /// Stop, or clicks it told of that the worker never heard of: a click nothing is known of. It
    /// ends the stretch of typing, and the keys after it keep no field name and no value until
    /// focus news heard more than a second after it says where they went (for clicks never heard
    /// of, until the next click); the cell selected in Excel isn't known (#75).
    pub(super) fn apply_press(&mut self, press: WaitingPress) {
        self.applied_press = Some(press.tick);
        // Where the press was isn't known: a window a password box may still have focus in stays
        // kept out (the #97 third review).
        let windows = [
            self.password.window(),
            self.since_click.as_ref().and_then(SinceClick::window),
        ];
        let kept_out = windows
            .into_iter()
            .flatten()
            .find(|&window| self.password_before(window, press.tick));
        self.password.clicked(&self.applied);
        if let Some(window) = kept_out {
            self.password.clicked_into(window);
        }
        self.end_stretch(true);
        self.go_to = None;
        self.excel_cells.clicked_somewhere(press.tick);
        self.unnamed_click = None;
        self.since_click = Some(SinceClick {
            tick: press.tick,
            count: None,
            at: None,
            lost: press.lost,
            in_dialog: false,
            looked_up: false,
            unread: false,
            element: None,
            firefox: false,
            password_before: kept_out.is_some(),
            // A press nothing is known of can't tell anyway.
            unknown_before: false,
            unproven_before: false,
            doubted: None,
            focus_key: None,
            news: None,
        });
    }

    /// Whether, as a click in `window` at `tick` went down, focus there may have been in a box that
    /// holds a password: the password guard keeps the window out, or keys typed there then would
    /// have been kept out as typed into a password box clicked before (#97 third review).
    fn password_before(&self, window: isize, tick: u32) -> bool {
        self.password.covers(window)
            || (self
                .since_click
                .as_ref()
                .is_some_and(|since| since.window() == Some(window))
                && self.keys_went(tick, window) == KeysWent::Secret)
    }

    /// A key that can move focus (Tab, Enter, Escape, a key combination) typed at `tick` was
    /// handled: focus news after it can say focus moved on from a password box clicked before it
    /// (the #97 third review).
    pub(super) fn focus_key(&mut self, tick: u32) {
        if let Some(since) = self.since_click.as_mut()
            && since.focus_key.is_none()
            && !tick_before_or_at(tick, since.tick)
        {
            since.focus_key = Some(tick);
        }
    }

    /// Whether the click waiting to be applied next waits for its lookup, which says where the
    /// keys typed straight after it went, for a while: in Excel the cell it selected (#75);
    /// anywhere else the element clicked (#97). No focus news ends the wait: news even of where
    /// the click was can be of the page round a password box clicked, from before the click
    /// (#97 second review). The pipeline gives its lookup up well within the wait.
    pub(super) fn click_waits_for_lookup(&self, now: Instant) -> bool {
        self.pending_clicks.front().is_some_and(|click| {
            !click.lookup.named() && now.duration_since(click.reported) < CLICK_LOOKUP_WAIT
        })
    }

    /// Whether the focus news waiting to be applied is the latest click's own: the first heard
    /// after it, soon enough after it, and before any click or press after it. It says where the
    /// keys typed straight after the click went, though they reached the worker first.
    pub(super) fn click_news_waiting(&self) -> bool {
        let Some(since) = self
            .since_click
            .as_ref()
            .filter(|since| since.news.is_none())
        else {
            return false;
        };
        let next = self
            .pending_clicks
            .front()
            .map(|click| click.tick)
            .or(self.waiting_presses.front().map(|waiting| waiting.tick));
        self.pending_focus.front().is_some_and(|(_, note)| {
            heard_after(since.tick, note.tick_ms)
                && next.is_none_or(|next| tick_before_or_at(note.tick_ms, next))
        })
    }

    /// Focus news reached the worker after keys typed straight after the latest click began a
    /// stretch of typing in the window clicked: when it's the click's own, of the element clicked,
    /// the keys went there, and the stretch goes on there (#97). Keys typed into a field are its
    /// value, read as focus leaves it, so they make no stretch. `true` when it did either.
    pub(super) fn click_news_names_stretch(&mut self, note: &FocusNote) -> bool {
        if !self.click_news_after_stretch(note) {
            return false;
        }
        let (Some(since), Some(hwnd)) = (
            self.since_click.as_ref(),
            self.stretch.as_ref().map(|stretch| stretch.hwnd),
        ) else {
            return false;
        };
        if !since.names_clicked(note) {
            // Other news in the click's second, after keys typed straight after the click: they
            // may have gone where it says, not where they were put down to (a click on a line of
            // text, whose page took focus), so they keep no field name and no value (#97 second
            // review).
            if let Some(stretch) = self.stretch.as_mut() {
                stretch.element = None;
                stretch.cell = None;
                stretch.withheld = true;
                stretch.unconfirmed = None;
            }
            return false;
        }
        if note.field || note.address_bar {
            self.stretch = None;
            return true;
        }
        let element = self.window(hwnd).and_then(|(window, _)| {
            element_in_window(note, &window, |x, y| self.desktop.root_at(x, y))
        });
        if let Some(stretch) = self.stretch.as_mut() {
            stretch.focus_generation = note.generation;
            // An element that isn't the window's can't confirm where the keys went: no name and
            // no value, never the element the stretch was put down to before (10/10/2026).
            stretch.cell = element.as_ref().and_then(cell_name);
            stretch.withheld = element.is_none();
            stretch.element = element;
            stretch.unconfirmed = None;
        }
        true
    }

    /// Whether focus news is the first heard in the second after the latest click, heard after
    /// keys typed straight after the click began a stretch in the window clicked: news of where the
    /// click put focus, which the keys may have gone to (#97, #116).
    pub(super) fn click_news_after_stretch(&self, note: &FocusNote) -> bool {
        let Some(since) = self
            .since_click
            .as_ref()
            .filter(|since| since.news.is_none() && heard_after(since.tick, note.tick_ms))
        else {
            return false;
        };
        self.stretch.as_ref().is_some_and(|stretch| {
            stretch.hwnd == note.window
                && !tick_before_or_at(stretch.first_tick, since.tick)
                && !tick_before_or_at(note.tick_ms, stretch.first_tick)
        })
    }

    /// Focus news was applied: the first heard in the second after the latest click says, when
    /// it's the click's own, where the keys typed after the click went, even those typed before it
    /// was heard.
    pub(super) fn click_heard_of(&mut self, note: &FocusNote) {
        if let Some(since) = self.since_click.as_mut()
            && since.news.is_none()
            && heard_after(since.tick, note.tick_ms)
        {
            since.news = Some(ClickNewsHeard {
                heard: note.tick_ms,
                note: note.clone(),
            });
        }
    }

    /// Where keys typed at `tick` into the window `hwnd` went, as far as the latest click tells
    /// (#97). Failing closed: the focus as of the keys says only when the click's own news does,
    /// when focus moved on after the click's second, or when the click's lookup says it left
    /// focus where it was; otherwise no field name and no value, and nothing at all when the box
    /// clicked says it holds a password or a secret, whatever other news arrives, in whatever
    /// order (#97 second review), or when focus may have stayed in one clicked before; no value
    /// either where focus stayed after a click that couldn't tell (the fourth).
    pub(super) fn keys_went(&self, tick: u32, hwnd: isize) -> KeysWent {
        let Some(since) = self.since_click.as_ref() else {
            return KeysWent::Focus;
        };
        if tick_before_or_at(tick, since.tick) {
            return KeysWent::Focus;
        }
        // The click's own news: the keys went where it put focus, though UI Automation told of it
        // after them.
        if since
            .news
            .as_ref()
            .is_some_and(|news| since.names_clicked(&news.note))
        {
            return KeysWent::Focus;
        }
        if since.moved_on(self.applied.tick_ms, tick) {
            return KeysWent::Focus;
        }
        // A press nothing is known of: the focus from before it says nothing.
        if since.at.is_none() {
            return KeysWent::Unknown;
        }
        // A box that says it holds a password, clicked: the keys went into it, whatever news of
        // other elements says (another box's, from before the click, told late), until its own
        // does or focus moves on.
        if since.secret() {
            return KeysWent::Secret;
        }
        // News in the click's second heard only after the keys, not the click's own: where they
        // went can't be told.
        if since
            .news
            .as_ref()
            .is_some_and(|news| !tick_before_or_at(news.heard, tick))
        {
            return KeysWent::Unknown;
        }
        // Focus stayed where it was, which may be a password box clicked before, in this window
        // (#97 third review), or where a click before couldn't tell (the fourth).
        let stayed = if since.password_before && since.window() == Some(hwnd) {
            KeysWent::Secret
        } else if since.unknown_before && since.doubted == Some(hwnd) {
            KeysWent::Unknown
        } else {
            KeysWent::Focus
        };
        if since.left_focus(&self.applied) {
            return stayed;
        }
        // A box clicked, and no focus news at all in the second after: it didn't take focus (read
        // only, or disabled), or UI Automation never said. Keys typed after that second go where
        // focus was, as before #97; the box clicked isn't a password box, so nothing secret goes
        // with them, unless focus was in one as the button went down.
        if since.looked_up
            && since.element.is_some()
            && since.news.is_none()
            && !heard_after(since.tick, tick)
        {
            return stayed;
        }
        KeysWent::Unknown
    }

    /// Whether keys typed at `tick` into the window `hwnd` follow a click there that couldn't tell
    /// what it went to (a lookup that failed, Chrome's page answer) or a press nothing is known
    /// of, or a click on something in a web page that isn't a box, outside the box with focus
    /// (#118), or a click after any of these in its window whose own focus news hasn't said where
    /// they went, with no focus news since that says focus moved on: where they went may rest on
    /// the focus from before that click. UI Automation is then asked what has focus before a
    /// stretch of them keeps a value (#97 fourth review).
    pub(super) fn keys_unproven(&self, tick: u32, hwnd: isize) -> bool {
        self.since_click.as_ref().is_some_and(|since| {
            let own_news = since
                .news
                .as_ref()
                .is_some_and(|news| since.names_clicked(&news.note));
            let here = since.window().is_none_or(|window| window == hwnd);
            let doubted = since.doubted == Some(hwnd)
                && (since.unknown_before || since.unproven_before)
                && !own_news;
            // A web page's text clicked, unless it was a part of the box with focus (a line of the
            // message being typed, or of the box the click's own news names): a label is outside
            // the box its `for` puts focus in. A button or link that takes focus as it's pressed
            // can still move it on with its script, so its own news proves nothing (#118); nor
            // does a button or image drawn inside the box, such as an inline "Next" arrow (#119).
            let on_text = since.on_page_text()
                && !(since.inside(&self.applied)
                    && is_box(&self.applied)
                    && since.element.as_ref().is_some_and(box_part));
            !tick_before_or_at(tick, since.tick)
                && !since.moved_on(self.applied.tick_ms, tick)
                && ((here && (since.couldnt_tell() || on_text)) || doubted)
        })
    }

    /// When the latest click applied (or press nothing is known of) went down: what a stretch of
    /// typing after it that UI Automation checks rests on (#114).
    pub(super) fn click_pressed(&self) -> Option<u32> {
        self.since_click.as_ref().map(|since| since.tick)
    }
}

/// Whether `note`'s element is in the window `window` and holds the point `(x, y)`.
fn inside(note: &FocusNote, window: isize, (x, y): (i32, i32)) -> bool {
    note.window == window
        && note
            .facts
            .bounds
            .is_some_and(|bounds| bounds.contains(x, y))
}

/// Whether focus news heard at `heard` came after the click at `click`, soon enough to be its own.
fn heard_after(click: u32, heard: u32) -> bool {
    !tick_before_or_at(heard, click) && heard.wrapping_sub(click) <= CLICK_NEWS_MS
}

#[cfg(test)]
mod tests {
    use crate::typing::scene::*;

    const CHAT: isize = 0x90_6000;
    const CHAT_PID: u32 = 5_500;

    /// A chat app's window: a search box along the top, the box a message is written in along the
    /// bottom. Neither is a field whose value is read as focus leaves it: what's typed in them is
    /// a step from the keys.
    fn chat() -> WindowInfo {
        WindowInfo {
            hwnd: CHAT,
            pid: CHAT_PID,
            title: "Team chat".into(),
            exe_path: Some(r"C:\Program Files\Contoso\Chat\chat.exe".into()),
            frame: rect(0, 0, 1200, 900),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    /// A box in the chat app's window called `name`, at `bounds`.
    fn chat_box(name: &str, bounds: PxRect) -> ElementFacts {
        ElementFacts {
            control_type: "Edit".into(),
            name: name.into(),
            bounds: Some(bounds),
            ..ElementFacts::default()
        }
    }

    fn search_box() -> ElementFacts {
        chat_box(
            "Search",
            PxRect {
                left: 300,
                top: 10,
                right: 900,
                bottom: 40,
            },
        )
    }

    fn message_box() -> ElementFacts {
        chat_box(
            "Type a message",
            PxRect {
                left: 300,
                top: 800,
                right: 1180,
                bottom: 880,
            },
        )
    }

    /// Where the message box is clicked.
    const IN_MESSAGE_BOX: (i32, i32) = (600, 840);

    /// UI Automation's news of `facts` getting focus in the chat app.
    fn focus_on(facts: ElementFacts) -> FocusUpdate {
        FocusUpdate {
            window: CHAT,
            facts,
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: CHAT_PID,
        }
    }

    /// The chat app, its search box focused (typed in a while ago).
    fn in_chat() -> Scene {
        Scene::default()
            .in_window(chat(), "Chrome_WidgetWin_1")
            .focus(100, focus_on(search_box()))
    }

    #[test]
    fn fast_typing_straight_after_a_click_names_the_box_clicked() {
        // A click into the message box, then "Hello" a key every 10 ms from 5 ms after it (a text
        // expander, a barcode scanner): UI Automation's news of the box's focus came after the
        // keys, which went into it, never into the search box focused before the click.
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .type_keys(1_005, 10, "Hello")
                .focus(1_080, focus_on(message_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }

    #[test]
    fn news_of_another_box_after_fast_typing_names_none() {
        // The first focus news after the click, heard only after the keys, is of the search box,
        // not the box clicked (news from before the click, told late): where the keys went can't
        // be told, so the step keeps no field name and no value (10/10/2026).
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .type_keys(1_005, 10, "Hello")
                .focus(1_080, focus_on(search_box()))
                .focus(1_300, focus_on(message_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    /// Where the search box is clicked.
    const IN_SEARCH_BOX: (i32, i32) = (600, 25);

    #[test]
    fn a_click_reported_late_still_names_the_keys_typed_after_it() {
        // A click on the search box, whose lookup took 400 ms; meanwhile a click into the message
        // box, which the click pipeline could only tell of once that lookup was done, and "Hello"
        // straight after it. The keys waited for it: they're the message box's, never the search
        // box's.
        let records = record(
            Scene::default()
                .in_window(chat(), "Chrome_WidgetWin_1")
                .click_looked_up(1_000, 400, IN_SEARCH_BOX, Some(search_box()))
                .focus(1_050, focus_on(search_box()))
                .click_reported(1_100, 1_410, IN_MESSAGE_BOX, LOOKUP_MS, Some(message_box()))
                .type_keys(1_105, 10, "Hello")
                .focus(1_180, focus_on(message_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }

    #[test]
    fn keys_between_two_clicks_reported_late_go_where_the_first_put_focus() {
        // While the pipeline looked up a click on the search box, two more clicks: into the
        // message box, "Hi" typed, then back on the search box, "x" typed. Each click is told of
        // late, and the keys after each wait for it.
        let records = record(
            Scene::default()
                .in_window(chat(), "Chrome_WidgetWin_1")
                .click_looked_up(1_000, 400, IN_SEARCH_BOX, Some(search_box()))
                .focus(1_050, focus_on(search_box()))
                .click_reported(1_100, 1_410, IN_MESSAGE_BOX, LOOKUP_MS, Some(message_box()))
                .type_keys(1_105, 10, "Hi")
                .focus(1_130, focus_on(message_box()))
                .click_reported(1_150, 1_480, IN_SEARCH_BOX, LOOKUP_MS, Some(search_box()))
                .type_keys(1_155, 10, "x")
                .focus(1_200, focus_on(search_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [(Some("Type a message"), "Hi"), (Some("Search"), "x")]
        );
    }

    #[test]
    fn two_clicks_told_of_in_one_turn_each_keep_their_keys() {
        // The click pipeline, behind, tells of two clicks one straight after the other, both
        // before the key worker's next turn: the first is never lost to the second, and each
        // click's keys go where it put focus (#97 review: "Hi" had gone to the search box focused
        // before both).
        let records = record(
            in_chat()
                .click_reported(1_000, 1_401, IN_MESSAGE_BOX, 5, Some(message_box()))
                .type_keys(1_005, 10, "Hi")
                .focus(1_030, focus_on(message_box()))
                .click_reported(1_100, 1_405, IN_SEARCH_BOX, 5, Some(search_box()))
                .type_keys(1_105, 10, "x")
                .focus(1_130, focus_on(search_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [(Some("Type a message"), "Hi"), (Some("Search"), "x")]
        );
    }

    #[test]
    fn clicks_let_go_unheard_of_put_the_keys_after_them_nowhere() {
        // The key worker fell far behind: more clicks were told of before its turn than are kept,
        // so it never hears of the first. That is a click nothing is known of: "Hi", typed after
        // it, never goes to the search box focused before it, and keeps no value, with focus news
        // after it or none (#97 second review: with none, "Hi" went to the search box).
        let kept = u32::try_from(super::CLICKS_KEPT).expect("a few");
        for news in [true, false] {
            let mut scene = in_chat()
                .click_reported(1_000, 1_401, IN_MESSAGE_BOX, 5, Some(message_box()))
                .type_keys(1_005, 10, "Hi");
            if news {
                scene = scene.focus(1_030, focus_on(message_box()));
            }
            for n in 0..kept {
                scene = scene.click_reported(1_100 + n, 1_402, NOWHERE, 5, None);
            }
            let records = record(scene.click_named(3_000, 60, None));
            assert_eq!(typed_in(&records), [(None, "")], "focus news: {news}");
        }
    }

    #[test]
    fn keys_typed_after_clicks_never_heard_of_wait_for_them_from_the_start() {
        // Before the key worker heard of any click or press, the pipeline told of more clicks than
        // are kept: the first, at 1000, is never heard of, and "Hello" was typed after it. The
        // click nothing is known of is put at the worker's start, not at the turn that found it
        // lost, so the keys typed before that turn never go to the search box focused before the
        // click (#97 second review).
        let kept = u32::try_from(super::CLICKS_KEPT).expect("a few");
        let mut scene = in_chat().type_keys(1_005, 10, "Hello").at(
            1_150,
            Happening::Click {
                pressed: 1_000,
                point: IN_MESSAGE_BOX,
            },
        );
        for n in 0..kept {
            scene = scene
                .at(
                    1_150,
                    Happening::Click {
                        pressed: 1_100 + n,
                        point: NOWHERE,
                    },
                )
                .at(
                    1_160,
                    Happening::Named {
                        pressed: 1_100 + n,
                        element: None,
                        cell: None,
                    },
                );
        }
        let records = record(scene.click_named(3_000, 60, None));
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn a_click_told_of_while_the_one_before_waits_takes_nothing_from_it() {
        // A click into the message box, "Hi", then 40 ms later a click on the search box, "x".
        // The pipeline tells of the second as soon as the first's lookup is done, while the first
        // still waits its 150 ms to be applied: each keeps its own keys (#97 review).
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .type_keys(1_005, 10, "Hi")
                .focus(1_030, focus_on(message_box()))
                .click_reported(1_040, 1_063, IN_SEARCH_BOX, LOOKUP_MS, Some(search_box()))
                .type_keys(1_045, 10, "x")
                .focus(1_070, focus_on(search_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [(Some("Type a message"), "Hi"), (Some("Search"), "x")]
        );
    }

    #[test]
    fn news_of_the_page_holding_the_box_clicked_is_not_the_clicks_own() {
        // The first focus news after a click into the message box, heard after the keys, is of
        // the chat's page, which holds the box (news from before the click, told late): it isn't
        // where the keys went, so they keep no field name and no value, never the page's name
        // (#97 review). However long the click's lookup takes: the page's news is no reason to
        // stop waiting for it (#97 second review: with a 300 ms lookup, "Hello" was the page's).
        for lookup in [LOOKUP_MS, 300] {
            let records = record(
                in_chat()
                    .click_looked_up(1_000, lookup, IN_MESSAGE_BOX, Some(message_box()))
                    .type_keys(1_005, 10, "Hello")
                    .focus(1_080, focus_on(page()))
                    .focus(1_300, focus_on(message_box()))
                    .click_named(3_000, 60, None),
            );
            assert_eq!(typed_in(&records), [(None, "")], "a lookup of {lookup} ms");
        }
    }

    /// The chat's web page, which holds both boxes.
    fn page() -> ElementFacts {
        ElementFacts {
            control_type: "Document".into(),
            name: "Team chat".into(),
            bounds: Some(PxRect {
                left: 0,
                top: 0,
                right: 1_200,
                bottom: 900,
            }),
            ..ElementFacts::default()
        }
    }

    #[test]
    fn news_of_the_page_round_a_line_of_text_clicked_in_a_box_is_not_the_clicks_own() {
        // A click on the message box's placeholder: its lookup found the line of text, not the box
        // (a web page's box often reads so). The page's news, heard after the keys, holds the line
        // clicked: a click on a box's text never gives the page focus, so it isn't the click's
        // own, and the keys keep no name and no value, never the page's (#97 second review).
        let placeholder = ElementFacts {
            control_type: "Text".into(),
            name: "Type a message".into(),
            bounds: Some(PxRect {
                left: 310,
                top: 830,
                right: 700,
                bottom: 850,
            }),
            ..ElementFacts::default()
        };
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, placeholder)
                .type_keys(1_005, 10, "Hello")
                .focus(1_080, focus_on(page()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn a_slow_lookup_of_a_box_clicked_never_lets_the_keys_go_to_the_box_before() {
        // A click into the message box whose lookup took 300 ms, and no focus news came of it:
        // the box clicked, not the search box focused before, is where the keys went. With no
        // news to say so, the step names no field and keeps no value (10/10/2026).
        let records = record(
            in_chat()
                .click_looked_up(1_000, 300, IN_MESSAGE_BOX, Some(message_box()))
                .type_keys(1_005, 10, "Hello")
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn the_clicks_own_news_after_the_keys_names_them() {
        // As above, and UI Automation told of the message box's focus 400 ms after the click, once
        // the keys were typed: they went where the click put focus.
        let records = record(
            in_chat()
                .click_looked_up(1_000, 300, IN_MESSAGE_BOX, Some(message_box()))
                .type_keys(1_005, 10, "Hello")
                .focus(1_400, focus_on(message_box()))
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }

    #[test]
    fn focus_news_long_after_a_click_names_the_keys_typed_after_it() {
        // The message box clicked, and UI Automation never told of its focus; seconds later it
        // told of the search box's (the app moved focus there): keys typed after that are the
        // search box's.
        let records = record(
            in_chat()
                .click_looked_up(1_000, LOOKUP_MS, IN_MESSAGE_BOX, Some(message_box()))
                .focus(4_000, focus_on(search_box()))
                .type_keys(5_000, 150, "Hello")
                .click_named(7_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Search"), "Hello")]);
    }

    #[test]
    fn typing_at_human_speed_after_a_click_is_unchanged() {
        // The box's news came before the first key, as it does when people type.
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .focus(1_080, focus_on(message_box()))
                .type_keys(1_600, 150, "Hello")
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }

    #[test]
    fn a_click_in_the_box_being_typed_in_keeps_it() {
        // A click to put the caret elsewhere in the message box, which already had focus: no focus
        // news follows, fast typing or not.
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .focus(500, focus_on(message_box()))
                    .click_on(1_000, IN_MESSAGE_BOX, message_box())
                    .type_keys(1_005, gap, "Hello")
                    .click_named(3_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [(Some("Type a message"), "Hello")],
                "a key every {gap} ms"
            );
        }
    }

    #[test]
    fn a_click_in_the_box_being_typed_in_keeps_it_once_it_has_grown() {
        // The message box grew a line as the message wrapped: UI Automation read its bounds as
        // it got focus, and the click's lookup reads them as they are now. The click on its new
        // top line is still inside the box being typed in (#97 review).
        let grown = chat_box(
            "Type a message",
            PxRect {
                left: 300,
                top: 760,
                right: 1180,
                bottom: 880,
            },
        );
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .focus(500, focus_on(message_box()))
                    .click_on(1_000, (600, 775), grown.clone())
                    .type_keys(1_005, gap, "Hello")
                    .click_named(3_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [(Some("Type a message"), "Hello")],
                "a key every {gap} ms"
            );
        }
    }

    #[test]
    fn a_click_on_a_button_that_keeps_focus_where_it_was_keeps_the_box() {
        // A formatting button beside the message box (Bold), which doesn't take focus: the keys
        // after it still go into the message box, and no news says otherwise.
        let bold = ElementFacts {
            control_type: "Button".into(),
            name: "Bold".into(),
            bounds: Some(PxRect {
                left: 300,
                top: 760,
                right: 330,
                bottom: 790,
            }),
            ..ElementFacts::default()
        };
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .focus(500, focus_on(message_box()))
                    .click_on(1_000, (315, 775), bold.clone())
                    .type_keys(1_005, gap, "Hello")
                    .click_named(3_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [(Some("Type a message"), "Hello")],
                "a key every {gap} ms"
            );
        }
    }

    #[test]
    fn a_double_click_waits_for_nothing_more() {
        // The second press of a double-click makes no click of its own: the pipeline passes it
        // over, and the keys after it go where the first press put focus.
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .focus(1_080, focus_on(message_box()))
                .pressed(1_200)
                .type_keys(1_205, 10, "Hello")
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }

    #[test]
    fn fast_typing_into_a_field_clicked_is_its_value_not_a_step() {
        // A box whose value is read as focus leaves it: the keys make no step of their own, even
        // straight after the click, before UI Automation's news of it.
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .type_keys(1_005, 10, "Hello")
                .focus(
                    1_080,
                    FocusUpdate {
                        field: true,
                        ..focus_on(message_box())
                    },
                )
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    /// Where the password box is clicked.
    const IN_PASSWORD: (i32, i32) = (600, 415);

    /// The chat app's sign-in box, which says it holds a password.
    fn password_box() -> ElementFacts {
        ElementFacts {
            is_password: true,
            sensitive: true,
            ..chat_box(
                "Password",
                PxRect {
                    left: 300,
                    top: 400,
                    right: 900,
                    bottom: 430,
                },
            )
        }
    }

    #[test]
    fn a_password_typed_straight_after_a_click_is_never_kept() {
        // A password manager's auto-type, or a fast typist: the keys come before UI Automation
        // tells of the password box's focus, or with no news at all. The box clicked says it holds
        // a password: nothing is kept, not even a step with no value.
        let news_late = in_chat()
            .click_on(1_000, IN_PASSWORD, password_box())
            .type_keys(1_005, 10, "Tr0ub4dor3")
            .focus(1_200, focus_on(password_box()))
            .click_named(3_000, 60, None);
        let no_news = in_chat()
            .click_looked_up(1_000, 300, IN_PASSWORD, Some(password_box()))
            .type_keys(1_005, 10, "Tr0ub4dor3")
            .click_named(3_000, 60, None);
        for scene in [news_late, no_news] {
            assert_eq!(typed_in(&record(scene)), []);
        }
    }

    #[test]
    fn the_clicks_own_news_of_an_element_not_the_windows_keeps_no_value() {
        // A click on a line of text in a panel another program draws over the chat (its lookup
        // found only the text), "Hello" straight after, put down for now to the message box that
        // had focus. The click's own news then says focus went to the panel's element, which isn't
        // the chat window's: where the keys went can't be confirmed, so no name and no value
        // (10/10/2026), never the message box's.
        let label = ElementFacts {
            control_type: "Text".into(),
            name: "Pinned".into(),
            bounds: Some(PxRect {
                left: 560,
                top: 40,
                right: 640,
                bottom: 60,
            }),
            ..ElementFacts::default()
        };
        let panel = FocusUpdate {
            pid: CHAT_PID + 1,
            ..focus_on(ElementFacts {
                control_type: "Pane".into(),
                name: "Pinned items".into(),
                bounds: Some(PxRect {
                    left: 500,
                    top: 0,
                    right: 2_900,
                    bottom: 100,
                }),
                ..ElementFacts::default()
            })
        };
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 50), label)
                .type_keys(1_005, 10, "Hello")
                .focus(1_300, panel)
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn stale_news_of_another_box_never_takes_a_password_typed_after_a_click() {
        // A click into the password box; the first focus news after it is the search box's, from
        // before the click and told late, heard before the keys; the password box's own news
        // never comes before the next click. The password went into the box clicked, which says
        // it holds one: nothing is kept, never a "Type" in "Search" with the password. Its lookup
        // is slow too: the stale news doesn't stop the keys waiting for it.
        // Typed more than a second after the click too, at human speed: the stale news still says
        // nothing (#97 second review: "Tr0ub4dor3" went to "Search").
        for (lookup, from, gap) in [
            (LOOKUP_MS, 1_100, 10),
            (400, 1_100, 10),
            (LOOKUP_MS, 2_100, 150),
        ] {
            let records = record(
                in_chat()
                    .click_looked_up(1_000, lookup, IN_PASSWORD, Some(password_box()))
                    .focus(1_050, focus_on(search_box()))
                    .type_keys(from, gap, "Tr0ub4dor3")
                    .click_named(4_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [],
                "a lookup of {lookup} ms, keys from {from} ms"
            );
        }
    }

    #[test]
    fn stale_news_of_another_box_never_names_keys_typed_into_the_box_clicked() {
        // As above, into the message box: the search box's stale news is no word that the keys
        // went there, fast or at human speed; the box clicked is where they went, with no news to
        // say so, so the step keeps no name and no value (#97 second review).
        for (from, gap) in [(1_100, 10), (2_100, 150)] {
            let records = record(
                in_chat()
                    .click_on(1_000, IN_MESSAGE_BOX, message_box())
                    .focus(1_050, focus_on(search_box()))
                    .type_keys(from, gap, "Hello")
                    .click_named(4_000, 60, None),
            );
            assert_eq!(typed_in(&records), [(None, "")], "keys from {from} ms");
        }
    }

    #[test]
    fn news_of_the_page_round_a_password_box_never_lets_the_password_be_kept() {
        // A click into the password box whose lookup took 300 ms, and the chat page's news at
        // 1080 (the page round the box, from before the click, told late): the password typed
        // straight after the click, or just after the news. The page's news doesn't end the wait
        // for the lookup, which says a password box was clicked: nothing is kept (#97 second
        // review: "Tr0ub4dor3" in "Team chat").
        for from in [1_005, 1_100] {
            let records = record(
                in_chat()
                    .click_looked_up(1_000, 300, IN_PASSWORD, Some(password_box()))
                    .focus(1_080, focus_on(page()))
                    .type_keys(from, 10, "Tr0ub4dor3")
                    .click_named(3_000, 60, None),
            );
            assert_eq!(typed_in(&records), [], "keys from {from} ms");
        }
    }

    #[test]
    fn a_lookup_that_finishes_after_its_click_was_applied_still_says_what_was_clicked() {
        // A click into the password box whose lookup took 1.5 s, longer than the keys wait for
        // it: the click was applied not knowing what was clicked, so "Tr0ub", typed then, keeps no
        // name and no value. The lookup then says a password box was clicked: that typing is
        // dropped, and "4dor3", typed after at human speed with no focus news, is kept out too
        // (#97 second review).
        let records = record(
            in_chat()
                .click_looked_up(1_000, 1_500, IN_PASSWORD, Some(password_box()))
                .type_keys(2_100, 10, "Tr0ub")
                .type_keys(3_000, 150, "4dor3")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn typing_after_a_click_on_a_box_that_takes_no_focus_goes_where_focus_was() {
        // The message box is read only: a click on it takes no focus, and no focus news comes.
        // Keys typed more than a second after the click go to the search box, which kept focus,
        // as before #97; typed within the second, where they went can't be told yet, and they
        // keep no name and no value (#97 second review).
        let read_only = |from, gap| {
            record(
                in_chat()
                    .click_on(1_000, IN_MESSAGE_BOX, message_box())
                    .type_keys(from, gap, "Hello")
                    .click_named(4_000, 60, None),
            )
        };
        assert_eq!(
            typed_in(&read_only(2_200, 150)),
            [(Some("Search"), "Hello")]
        );
        assert_eq!(typed_in(&read_only(1_300, 150)), [(None, "")]);
        // Never after a click on a box that says it holds a password.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, password_box())
                .type_keys(2_200, 150, "Tr0ub4dor3")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn two_boxes_alike_but_for_where_they_are_are_kept_apart() {
        // A form's two blank lines: unnamed boxes of one class, with no automation id. Focus in
        // the first, a click into the second and fast typing before its news: the box clicked
        // isn't the one with focus, so the keys are never put down to the first.
        let line = |top| ElementFacts {
            class_name: "Edit".into(),
            ..chat_box(
                "",
                PxRect {
                    left: 300,
                    top,
                    right: 900,
                    bottom: top + 30,
                },
            )
        };
        let records = record(
            Scene::default()
                .in_window(chat(), "Chrome_WidgetWin_1")
                .focus(100, focus_on(line(200)))
                .click_on(1_000, (600, 315), line(300))
                .type_keys(1_005, 10, "Hello")
                .click_named(3_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
        // Alike but for one thing they are, or for where they are with no automation id to say,
        // they're two boxes; one box read in two places is one box.
        let first = line(200);
        let apart = [
            ElementFacts {
                name: "Line 2".into(),
                ..first.clone()
            },
            ElementFacts {
                automation_id: "line2".into(),
                ..first.clone()
            },
            ElementFacts {
                class_name: "RichEdit".into(),
                ..first.clone()
            },
            ElementFacts {
                is_password: true,
                ..first.clone()
            },
            line(300),
        ];
        for other in apart {
            assert!(!super::same_element(&first, &other), "{other:?}");
        }
        let with_id = |top| ElementFacts {
            automation_id: "line1".into(),
            ..line(top)
        };
        assert!(super::same_element(&with_id(200), &with_id(600)));
        assert!(super::same_element(&line(200), &line(210)));
    }

    #[test]
    fn a_press_never_reported_puts_nothing_down_to_the_box_before_it() {
        // The click pipeline never reports a press (it fell behind by more than two seconds): the
        // keys after it wait, then keep no name and no value, whatever focus news says in the
        // second after the press, or with none (#97 second review: with none, "Hello" went to the
        // search box focused before the press). Where the press was isn't known, so no news can
        // be told to be its own.
        for (news, gap) in [(true, 10), (false, 10), (true, 150), (false, 150)] {
            let mut scene = in_chat()
                .press_unreported(2_000)
                .type_keys(2_005, gap, "Hello");
            if news {
                scene = scene.focus(2_080, focus_on(message_box()));
            }
            let records = record(scene.click_named(6_000, 60, None));
            assert_eq!(
                typed_in(&records),
                [(None, "")],
                "focus news: {news}, a key every {gap} ms"
            );
        }
    }

    #[test]
    fn focus_news_long_after_a_press_never_reported_names_the_keys_after_it() {
        // As above, then focus moved (Tab) more than a second after the press: keys typed after
        // that go where it says. Only after a key that can move focus: news more than a second
        // late with none before it can be stale (the #97 fourth review), so the scene presses
        // Tab, as it says.
        let records = record(
            in_chat()
                .press_unreported(2_000)
                .press(3_400, VK_TAB)
                .focus(3_500, focus_on(message_box()))
                .type_keys(4_000, 150, "Hello")
                .click_named(6_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }

    // ---------- the #97 third review ----------

    const VK_TAB: u16 = 0x09;

    /// The "Show" button beside the password box, which shows what it holds and leaves focus in it.
    fn show_button() -> ElementFacts {
        ElementFacts {
            control_type: "Button".into(),
            name: "Show".into(),
            bounds: Some(PxRect {
                left: 905,
                top: 400,
                right: 960,
                bottom: 430,
            }),
            ..ElementFacts::default()
        }
    }

    /// Where the "Show" button is clicked.
    const ON_SHOW: (i32, i32) = (930, 415);

    #[test]
    fn a_click_beside_a_password_box_never_lets_the_password_out() {
        // A click into the password box, whose own focus news never comes, then a click on "Show"
        // beside it, which leaves focus in the box: the password typed after that went into the
        // box, not into the search box focused before both clicks (the #97 third review: it was
        // kept as `Type "Tr0ub4dor3" in "Search"`). Straight after, or at human speed; the second
        // click soon after the first, or later.
        for (second, gap) in [(1_100, 10), (1_100, 150), (1_500, 10), (1_500, 150)] {
            let records = record(
                in_chat()
                    .click_on(1_000, IN_PASSWORD, password_box())
                    .click_on(second, ON_SHOW, show_button())
                    .type_keys(second + 5, gap, "Tr0ub4dor3")
                    .click_named(5_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [],
                "second click at {second}, a key every {gap} ms"
            );
        }
    }

    #[test]
    fn whatever_clicks_follow_a_password_click_that_leave_focus_there_keep_it_out() {
        // "Show" clicked twice, or a click whose lookup couldn't tell what it was: focus may still
        // be in the password box, so what's typed after is kept out.
        let twice = in_chat()
            .click_on(1_000, IN_PASSWORD, password_box())
            .click_on(1_300, ON_SHOW, show_button())
            .click_on(1_600, ON_SHOW, show_button())
            .type_keys(1_605, 150, "Tr0ub4dor3")
            .click_named(5_000, 60, None);
        let unknown = in_chat()
            .click_on(1_000, IN_PASSWORD, password_box())
            .click_looked_up(1_300, 400, ON_SHOW, None)
            .type_keys(1_305, 150, "Tr0ub4dor3")
            .click_named(5_000, 60, None);
        for scene in [twice, unknown] {
            assert_eq!(typed_in(&record(scene)), []);
        }
        // Three quick clicks: the message box, the password box, then "Show".
        let records = record(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .click_on(1_040, IN_PASSWORD, password_box())
                .click_on(1_080, ON_SHOW, show_button())
                .type_keys(1_085, 10, "Tr0ub4dor3")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn after_a_password_click_a_click_into_another_box_names_what_is_typed_there() {
        // The password typed after a click on "Show", then Tab, then a click into the message box,
        // whose own news comes: what's typed there is the message box's as usual. The password
        // is never kept.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, password_box())
                .click_on(1_300, ON_SHOW, show_button())
                .type_keys(1_305, 10, "Tr0ub4dor3")
                .press(1_500, VK_TAB)
                .click_on(3_000, IN_MESSAGE_BOX, message_box())
                .focus(3_080, focus_on(message_box()))
                .type_keys(3_200, 150, "Hello")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        // That box takes no focus (read only): focus stayed where it was, maybe the password box,
        // so what's typed after the second is kept out, never put down to the search box.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, password_box())
                .click_on(1_300, ON_SHOW, show_button())
                .click_on(3_000, IN_MESSAGE_BOX, message_box())
                .type_keys(4_200, 150, "Tr0ub4dor3")
                .click_named(7_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn a_part_of_a_password_box_clicked_keeps_the_keys_out() {
        // The lookup found a run of the password box's text (its placeholder), which the lookup
        // marks as secret since its parent is a password box (`lookup::parents_marked`): the keys
        // typed after it, fast or at human speed, are kept out, never put down to the search box.
        let placeholder = ElementFacts {
            control_type: "Text".into(),
            name: "Password".into(),
            sensitive: true,
            bounds: Some(PxRect {
                left: 310,
                top: 405,
                right: 400,
                bottom: 425,
            }),
            ..ElementFacts::default()
        };
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .click_on(1_000, (350, 415), placeholder.clone())
                    .type_keys(1_005, gap, "Tr0ub4dor3")
                    .click_named(4_000, 60, None),
            );
            assert_eq!(typed_in(&records), [], "a key every {gap} ms");
        }
    }

    #[test]
    fn stale_news_long_after_a_password_click_never_takes_the_password() {
        // A click into the password box, whose own news never comes; more than a second later,
        // focus news of the search box, or of the page (a focus note's time is when Steps' handler
        // read it, not when focus moved: news from before the click, told late), then the password
        // at human speed. No key that could move focus came after the click: the keys went into
        // the box clicked, and are kept out (the #97 third review: `Type "Tr0ub4dor3" in
        // "Search"`, and in "Team chat").
        for stale in [search_box(), page()] {
            let records = record(
                in_chat()
                    .click_on(1_000, IN_PASSWORD, password_box())
                    .focus(2_050, focus_on(stale.clone()))
                    .type_keys(2_100, 150, "Tr0ub4dor3")
                    .click_named(5_000, 60, None),
            );
            assert_eq!(typed_in(&records), [], "news of {}", stale.name);
        }
    }

    #[test]
    fn hi_tab_x_is_two_stretches() {
        // "Hi", Tab, "x", 30 ms apart: the news of the box Tab moved to was heard after "Hi" came
        // in but before it was handled. It's of focus after "Hi", so it ends that stretch, and "x"
        // is the search box's (the #97 third review: "Hix" had been one step in the message box).
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .type_keys(1_000, 30, "Hi")
                .press(1_060, VK_TAB)
                .focus(1_080, focus_on(search_box()))
                .type_keys(1_090, 30, "x")
                .click_named(3_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [(Some("Type a message"), "Hi"), (Some("Search"), "x")]
        );
    }

    const REMOTE: isize = 0x91_7000;
    const REMOTE_PID: u32 = 8_100;

    /// A Remote Desktop Connection window, the session's pane focused: the click pipeline reads
    /// nothing under a click there, since it shows another computer.
    fn in_remote_session() -> Scene {
        let window = WindowInfo {
            hwnd: REMOTE,
            pid: REMOTE_PID,
            title: "Work PC - Remote Desktop Connection".into(),
            exe_path: Some(r"C:\Windows\System32\mstsc.exe".into()),
            frame: rect(0, 0, 1600, 900),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let pane = FocusUpdate {
            window: REMOTE,
            facts: ElementFacts {
                control_type: "Pane".into(),
                name: "Input Capture Window".into(),
                class_name: "IHWindowClass".into(),
                bounds: Some(PxRect {
                    left: 0,
                    top: 30,
                    right: 1_600,
                    bottom: 900,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: REMOTE_PID,
        };
        Scene::default()
            .in_window(window, "TscShellContainerClass")
            .focus(100, pane)
    }

    #[test]
    fn typing_in_a_remote_session_after_a_click_keeps_no_value() {
        // Nothing under a click in a remote session is read, by design, and UI Automation can't
        // see the other computer's controls, so a password box there (its sign-in, a UAC prompt, a
        // web login) can't be told: typing after the click, at human speed or straight after,
        // keeps no value and no field name, only the window (12/10/2026, #113). It had kept
        // "Hello" in "Input Capture Window", as 1.0.0 did and the #97 third review restored.
        for (from, gap) in [(1_600, 150), (1_005, 10)] {
            let records = record(
                in_remote_session()
                    .click_unread(1_000, (800, 400))
                    .type_keys(from, gap, "Hello")
                    .click_unread(4_000, (800, 400)),
            );
            assert_eq!(typed_in(&records), [(None, "")], "keys from {from} ms");
            assert_eq!(
                records[0].window.title, "Work PC - Remote Desktop Connection",
                "keys from {from} ms"
            );
        }
    }

    #[test]
    fn typing_in_a_remote_session_with_no_click_keeps_no_value() {
        // Keyboard focus alone took the keys to the session (Alt+Tab, or it was in front from the
        // start): no click before them, at human speed or fast, and a click in the session ends the
        // stretch. A password typed there keeps no value either (#113).
        for (text, gap) in [("Hello", 150), ("Hello", 10), ("Tr0ub4dor3", 150)] {
            let records = record(
                in_remote_session()
                    .type_keys(1_000, gap, text)
                    .click_unread(4_000, (800, 400)),
            );
            assert_eq!(
                typed_in(&records),
                [(None, "")],
                "{text}, a key every {gap} ms"
            );
            assert!(
                records.iter().all(|record| record.element.is_none()),
                "{text}, a key every {gap} ms"
            );
        }
    }

    #[test]
    fn a_remote_sessions_typing_keeps_no_value_whatever_the_focus_news_says() {
        // Focus news of a box in the session's window at the click point (a client that passes a
        // remote app's box through), as the click's own news would be, or long after the click:
        // none of it can say the keys didn't go to the other computer, so the typing keeps no value
        // and no field name (#113).
        let user_name = FocusUpdate {
            window: REMOTE,
            facts: ElementFacts {
                control_type: "Edit".into(),
                name: "User name".into(),
                bounds: Some(PxRect {
                    left: 700,
                    top: 380,
                    right: 900,
                    bottom: 420,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: REMOTE_PID,
        };
        for (news, from, gap) in [(1_080, 1_005, 10), (1_080, 1_600, 150), (2_500, 3_000, 150)] {
            let records = record(
                in_remote_session()
                    .click_unread(1_000, (800, 400))
                    .focus(news, user_name.clone())
                    .type_keys(from, gap, "Hello")
                    .click_unread(6_000, (800, 400)),
            );
            assert_eq!(typed_in(&records), [(None, "")], "news at {news} ms");
        }
    }

    #[test]
    fn typing_in_a_local_window_after_a_remote_session_keeps_its_value() {
        // Typing in the session keeps no value; typing in a local window after it, as before (#113).
        let records = record(
            in_remote_session()
                .with_dialog(chat(), "Chrome_WidgetWin_1")
                .type_keys(1_000, 150, "Hello")
                .focus(2_500, focus_on(message_box()))
                .keys_to(Some(CHAT))
                .type_keys(3_000, 150, "Hi Sam")
                .keys_to(None)
                .click_unread(6_000, (800, 400)),
        );
        assert_eq!(
            typed_in(&records),
            [(None, ""), (Some("Type a message"), "Hi Sam")]
        );
    }

    #[test]
    fn typing_in_the_newly_listed_clients_keeps_no_value() {
        // Remote Desktop Connection Manager, TeamViewer and VNC Viewer are remote-desktop clients
        // too (#116): typing in their windows keeps no value, as in Remote Desktop's.
        for exe in [
            r"C:\Program Files\RDCMan\RDCMan.exe",
            r"C:\Program Files\TeamViewer\TeamViewer.exe",
            r"C:\Program Files\RealVNC\VNC Viewer\vncviewer.exe",
        ] {
            let mut window = embedded_host();
            window.exe_path = Some(exe.into());
            let records = record(
                Scene::default()
                    .in_window(window, HOST_CLASS)
                    .focus(100, host_focus(servers_tree()))
                    .type_keys(1_000, 150, "Hello")
                    .click_unread(4_000, (800, 400)),
            );
            assert_eq!(typed_in(&records), [(None, "")], "{exe}");
            assert!(records[0].window.remote_session, "{exe}");
        }
    }

    const HOST: isize = 0x92_8000;
    const HOST_PID: u32 = 8_300;
    const HOST_CLASS: &str = "WindowsForms10.Window.8.app.0.141b42a_r6_ad1";

    /// A program not on the list of remote-desktop clients that shows a Remote Desktop session
    /// inside its own window, with the Remote Desktop control (an in-house admin console): a tree
    /// of servers down the left, the session to the right of it.
    fn embedded_host() -> WindowInfo {
        WindowInfo {
            hwnd: HOST,
            pid: HOST_PID,
            title: "Servers - Admin Console".into(),
            exe_path: Some(r"C:\Program Files\Contoso\AdminConsole.exe".into()),
            frame: rect(0, 0, 1600, 900),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    /// The Remote Desktop control's input window, where its keys go: "Input Capture Window", of
    /// class `IHWindowClass`.
    fn input_capture_window() -> ElementFacts {
        ElementFacts {
            control_type: "Pane".into(),
            name: "Input Capture Window".into(),
            class_name: "IHWindowClass".into(),
            bounds: Some(PxRect {
                left: 300,
                top: 30,
                right: 1_600,
                bottom: 900,
            }),
            ..ElementFacts::default()
        }
    }

    /// The host's own tree of servers.
    fn servers_tree() -> ElementFacts {
        ElementFacts {
            control_type: "Tree".into(),
            name: "Servers".into(),
            class_name: "WindowsForms10.SysTreeView32.app.0.141b42a_r6_ad1".into(),
            bounds: Some(PxRect {
                left: 0,
                top: 30,
                right: 300,
                bottom: 900,
            }),
            ..ElementFacts::default()
        }
    }

    /// The host's own search box, over its tree.
    fn host_search_box() -> ElementFacts {
        ElementFacts {
            control_type: "Edit".into(),
            name: "Find a server".into(),
            class_name: "WindowsForms10.EDIT.app.0.141b42a_r6_ad1".into(),
            bounds: Some(PxRect {
                left: 0,
                top: 30,
                right: 300,
                bottom: 60,
            }),
            ..ElementFacts::default()
        }
    }

    fn host_focus(facts: ElementFacts) -> FocusUpdate {
        FocusUpdate {
            window: HOST,
            facts,
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: HOST_PID,
        }
    }

    /// The admin console, its tree of servers focused.
    fn in_embedded_host() -> Scene {
        Scene::default()
            .in_window(embedded_host(), HOST_CLASS)
            .focus(100, host_focus(servers_tree()))
    }

    #[test]
    fn typing_into_the_remote_desktop_control_in_any_program_keeps_no_value() {
        // The Remote Desktop control's input window in a program not on the list of clients (RDCMan,
        // mRemoteNG and Royal TS embed it, and so can anything): its keys go to the other computer,
        // as Remote Desktop Connection's do, so typing there keeps no value and no field name, after
        // a click into the session at human or fast speed, or with the keyboard alone (#116).
        let click_then = |from: u32, gap: u32| {
            in_embedded_host()
                .click_on(1_000, (800, 400), input_capture_window())
                .focus(1_080, host_focus(input_capture_window()))
                .type_keys(from, gap, "Hello")
                .click_on(4_000, (100, 400), servers_tree())
        };
        // As the click pipeline reports it: nothing named under the click (#116).
        let unread_then = |from: u32, gap: u32| {
            in_embedded_host()
                .click_unread(1_000, (800, 400))
                .focus(1_080, host_focus(input_capture_window()))
                .type_keys(from, gap, "Hello")
                .click_on(4_000, (100, 400), servers_tree())
        };
        let keyboard_alone = in_embedded_host()
            .focus(500, host_focus(input_capture_window()))
            .type_keys(1_000, 150, "Tr0ub4dor3")
            .click_on(4_000, (100, 400), servers_tree());
        for (scene, says) in [
            (click_then(1_600, 150), "after a click"),
            (click_then(1_005, 10), "fast, after a click"),
            (unread_then(1_600, 150), "after a click named nothing"),
            (unread_then(1_005, 10), "fast, after a click named nothing"),
            (keyboard_alone, "with the keyboard alone"),
        ] {
            let records = record(scene);
            assert_eq!(typed_in(&records), [(None, "")], "{says}");
            assert!(records[0].window.remote_session, "{says}");
        }
    }

    #[test]
    fn windows_saying_the_remote_desktop_control_has_the_keyboard_makes_typing_remote() {
        // UI Automation told of no focus in the session (its news still names the tree), but
        // Windows says the control's input window has the keyboard: the keys went to the other
        // computer, and keep no value (#116).
        let records = record(
            in_embedded_host()
                .keyboard_class(0, Some("IHWindowClass"))
                .type_keys(1_000, 150, "Hello")
                .click_on(4_000, (100, 400), servers_tree()),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn typing_in_a_hosts_own_box_keeps_its_value() {
        // The host's own search box is a local control: typing there keeps its value, before and
        // after typing in the session it shows (#116).
        let records = record(
            in_embedded_host()
                .focus(500, host_focus(host_search_box()))
                .keyboard_class(500, Some("WindowsForms10.EDIT.app.0.141b42a_r6_ad1"))
                .type_keys(1_000, 150, "web01")
                .focus(2_500, host_focus(input_capture_window()))
                .keyboard_class(2_500, Some("IHWindowClass"))
                .type_keys(3_000, 150, "Hello")
                .focus(4_500, host_focus(host_search_box()))
                .keyboard_class(4_500, Some("WindowsForms10.EDIT.app.0.141b42a_r6_ad1"))
                .type_keys(5_000, 150, "db02")
                .click_on(7_000, (100, 400), servers_tree()),
        );
        assert_eq!(
            typed_in(&records),
            [
                (Some("Find a server"), "web01"),
                (None, ""),
                (Some("Find a server"), "db02")
            ]
        );
        assert!(!records[0].window.remote_session);
        assert!(records[1].window.remote_session);
    }

    #[test]
    fn a_click_where_nothing_is_read_leaves_a_window_kept_out_so() {
        // The password box had focus (its news came), then a notification took UI Automation's
        // focus: the window is kept out (10/10/2026). A click where nothing is read by design
        // (Windows' input panel, which never takes focus) leaves it so: the password typed after
        // is kept out, never put down to the notification or anything else.
        let toast = FocusUpdate {
            pid: CHAT_PID + 7,
            ..focus_on(ElementFacts {
                control_type: "Window".into(),
                name: "New notification".into(),
                bounds: Some(PxRect {
                    left: 1_540,
                    top: 810,
                    right: 1_904,
                    bottom: 1_019,
                }),
                ..ElementFacts::default()
            })
        };
        // In the chat's window, or the input panel's own, over it.
        let in_window = in_chat()
            .focus(500, focus_on(password_box()))
            .focus(600, toast.clone())
            .click_unread(1_000, (600, 600));
        let in_panel = in_chat()
            .focus(500, focus_on(password_box()))
            .focus(600, toast)
            .click_unread_in(1_000, CHAT + 0x10, (1_300, 600));
        for scene in [in_window, in_panel] {
            let records = record(
                scene
                    .type_keys(1_600, 150, "Tr0ub4dor3")
                    .click_named(4_000, 60, None),
            );
            assert_eq!(typed_in(&records), []);
        }
    }

    /// A program window of `exe` and `class` whose text document (of `document_class`, called
    /// `name`) can have focus, a ribbon or menu button above it.
    struct TextEditor {
        window: WindowInfo,
        class: &'static str,
        document: FocusUpdate,
        button: FocusUpdate,
    }

    const EDITOR: isize = 0x92_8000;
    const EDITOR_PID: u32 = 8_300;
    /// Where the document is clicked.
    const IN_DOCUMENT: (i32, i32) = (600, 500);

    fn editor(exe: &str, class: &'static str, document_class: &str, name: &str) -> TextEditor {
        let focus = |facts| FocusUpdate {
            window: EDITOR,
            facts,
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: EDITOR_PID,
        };
        TextEditor {
            window: WindowInfo {
                hwnd: EDITOR,
                pid: EDITOR_PID,
                title: "Club news - Editor".into(),
                exe_path: Some(exe.into()),
                frame: rect(0, 0, 1200, 900),
                elevation: Elevation::NotElevated,
                hosted_exe: None,
                class: None,
            },
            class,
            document: focus(ElementFacts {
                control_type: "Document".into(),
                class_name: document_class.into(),
                name: name.into(),
                bounds: Some(PxRect {
                    left: 50,
                    top: 200,
                    right: 1_150,
                    bottom: 880,
                }),
                ..ElementFacts::default()
            }),
            button: focus(ElementFacts {
                control_type: "Button".into(),
                name: "Bold".into(),
                bounds: Some(PxRect {
                    left: 50,
                    top: 100,
                    right: 80,
                    bottom: 130,
                }),
                ..ElementFacts::default()
            }),
        }
    }

    /// Word's body (`_WwG`, named after the file), and Windows 11 Notepad's (`RichEditD2DPT`).
    fn editors() -> [TextEditor; 2] {
        [
            editor(
                r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
                "OpusApp",
                "_WwG",
                "Club news",
            ),
            editor(
                r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2508.38.0_x64__8wekyb3d8bbwe\Notepad\Notepad.exe",
                "Notepad",
                "RichEditD2DPT",
                "Text editor",
            ),
        ]
    }

    #[test]
    fn typing_after_a_click_in_a_document_whose_lookup_timed_out_keeps_its_value() {
        // Word's body or Notepad's had focus, and a click in it whose lookup timed out: the
        // document is all text, holding no box the click could have gone into instead, so focus
        // stayed in it, and typing after, at human speed or straight after, keeps its value (the
        // #97 third review: `Type` with no value).
        for editor in editors() {
            let name = editor.document.facts.name.clone();
            for (from, gap) in [(1_600, 150), (1_005, 10)] {
                let records = record(
                    Scene::default()
                        .in_window(editor.window.clone(), editor.class)
                        .focus(500, editor.document.clone())
                        .click_looked_up(1_000, 400, IN_DOCUMENT, None)
                        .type_keys(from, gap, "Club news")
                        .click_named(4_000, 60, None),
                );
                assert_eq!(
                    typed_in(&records),
                    [(Some(name.as_str()), "Club news")],
                    "{name}, keys from {from} ms"
                );
            }
        }
    }

    #[test]
    fn a_documents_own_news_after_a_click_whose_lookup_timed_out_names_the_typing() {
        // Bold had focus; a click into the document, whose lookup timed out, and its own focus news
        // (the click was inside it, and it's all text) before or after the keys: they're its.
        for editor in editors() {
            let name = editor.document.facts.name.clone();
            for (from, gap) in [(1_600, 150), (1_005, 10)] {
                let records = record(
                    Scene::default()
                        .in_window(editor.window.clone(), editor.class)
                        .focus(500, editor.button.clone())
                        .click_looked_up(1_000, 400, IN_DOCUMENT, None)
                        .focus(1_080, editor.document.clone())
                        .type_keys(from, gap, "Club news")
                        .click_named(4_000, 60, None),
                );
                assert_eq!(
                    typed_in(&records),
                    [(Some(name.as_str()), "Club news")],
                    "{name}, keys from {from} ms"
                );
            }
        }
    }

    #[test]
    fn a_click_whose_lookup_failed_on_a_web_page_still_names_nothing() {
        // A web page is a Document too, but can hold a password box: with its news after a click
        // whose lookup failed, or with it focused before, where the keys went can't be told.
        let records = record(
            in_chat()
                .focus(500, focus_on(page()))
                .click_looked_up(1_000, 400, IN_PASSWORD, None)
                .type_keys(1_600, 150, "Tr0ub4dor3")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
        let records = record(
            in_chat()
                .click_looked_up(1_000, 400, IN_PASSWORD, None)
                .focus(1_080, focus_on(page()))
                .type_keys(1_600, 150, "Tr0ub4dor3")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    // ---------- the #97 fourth review ----------

    #[test]
    fn a_click_that_leaves_focus_after_one_that_couldnt_tell_cant_tell_either() {
        // A click into the password box whose lookup failed, its own news never coming, then a
        // click on "Show", which leaves focus where it was: where the keys went can't be told
        // after "Show" either, so the password typed after it keeps no value, never put down to
        // the search box focused before both (the #97 fourth review: `Type "Tr0ub4dor3" in
        // "Search"`). "Show" soon after, or later; the password straight after, or at human speed.
        for (second, gap) in [(1_500, 150), (1_500, 10), (2_500, 150)] {
            let records = record(
                in_chat()
                    .click_looked_up(1_000, 400, IN_PASSWORD, None)
                    .click_on(second, ON_SHOW, show_button())
                    .type_keys(second + 5, gap, "Tr0ub4dor3")
                    .click_named(6_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [(None, "")],
                "\"Show\" at {second}, a key every {gap} ms"
            );
        }
        // A press the click pipeline never reports, then "Show".
        let records = record(
            in_chat()
                .press_unreported(1_000)
                .click_on(3_500, ON_SHOW, show_button())
                .type_keys(3_505, 150, "Tr0ub4dor3")
                .click_named(7_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
        // The password box (its lookup found it), a box that takes no focus, then "Show", all
        // within a second.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, password_box())
                .click_on(1_300, IN_MESSAGE_BOX, message_box())
                .click_on(1_600, ON_SHOW, show_button())
                .type_keys(1_605, 150, "Tr0ub4dor3")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
        // A click in Windows' input panel, a window of its own that takes no focus, after the
        // password box's failed lookup, or after Chrome's page answer over it (UI Automation
        // saying the box has focus): still in doubt, never "Search".
        let failed = in_chat()
            .click_looked_up(1_000, 400, IN_PASSWORD, None)
            .click_unread_in(1_500, CHAT + 0x10, (1_300, 600))
            .type_keys(1_600, 150, "Tr0ub4dor3")
            .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(failed)), [(None, "")]);
        let page = in_chat()
            .click_on(1_000, IN_PASSWORD, chrome_page())
            .uia_focus(1_000, Some(password_box()))
            .click_unread_in(1_500, CHAT + 0x10, (1_300, 600))
            .type_keys(1_600, 150, "Tr0ub4dor3")
            .click_named(5_000, 60, None);
        assert_eq!(typed_in(&record(page)), []);
        // No password: a box whose lookup failed, then Bold. "Hello" went into the box clicked,
        // not the search box, so it's never put down to "Search".
        let records = record(
            in_chat()
                .click_looked_up(1_000, 400, IN_MESSAGE_BOX, None)
                .click_on(1_500, ON_SHOW, show_button())
                .type_keys(1_505, 150, "Hello")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn stale_news_long_after_a_click_that_couldnt_tell_never_names_the_keys() {
        // A click whose lookup failed, or a press the click pipeline never reports; more than a
        // second later, the search box's news, from before the click and read late (a lookup
        // timing out and a focus note read late share a cause: UI Automation is busy); then the
        // password at human speed. No key that could move focus came after the click, so the news
        // says nothing of where the keys went (the #97 fourth review: `Type "Tr0ub4dor3" in
        // "Search"`).
        let failed = in_chat()
            .click_looked_up(1_000, 400, IN_PASSWORD, None)
            .focus(2_050, focus_on(search_box()))
            .type_keys(2_100, 150, "Tr0ub4dor3")
            .click_named(6_000, 60, None);
        let press = in_chat()
            .press_unreported(1_000)
            .focus(2_050, focus_on(search_box()))
            .type_keys(2_100, 150, "Tr0ub4dor3")
            .click_named(7_000, 60, None);
        for (what, scene) in [("failed lookup", failed), ("press", press)] {
            assert_eq!(typed_in(&record(scene)), [(None, "")], "{what}");
        }
        // Chrome answering with its page over the password box, UI Automation saying the box has
        // focus: nothing is kept.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, chrome_page())
                .uia_focus(1_000, Some(password_box()))
                .focus(2_050, focus_on(search_box()))
                .type_keys(2_100, 150, "Tr0ub4dor3")
                .click_named(6_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
        // After Tab, news more than a second on says where focus went, as before.
        let records = record(
            in_chat()
                .click_looked_up(1_000, 400, IN_MESSAGE_BOX, None)
                .press(2_000, VK_TAB)
                .focus(2_050, focus_on(search_box()))
                .type_keys(2_100, 150, "Hello")
                .click_named(6_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Search"), "Hello")]);
    }

    /// The chat's web page as Chrome's hit test answers before its tree is built: its guess,
    /// whatever is under the point (`lookup::chrome_guess`).
    fn chrome_page() -> ElementFacts {
        ElementFacts {
            framework_id: "Chrome".into(),
            ..page()
        }
    }

    #[test]
    fn chromes_page_answer_over_a_password_box_never_lets_the_password_out() {
        // Chrome's hit test answered with the whole page for a click on the password box (a busy
        // or new page), and no focus news came for the box at all; UI Automation, asked as the
        // keys are handled, says the password box has focus. Search focused before, or the page
        // (a sign-in page just loaded): fast or at human speed, nothing is kept (the #97 fourth
        // review: `Type "Tr0ub4dor3" in "Search"`, and in "Team chat").
        for page_focused in [false, true] {
            for gap in [10, 150] {
                let mut scene = in_chat();
                if page_focused {
                    scene = scene.focus(500, focus_on(page()));
                }
                let records = record(
                    scene
                        .click_on(1_000, IN_PASSWORD, chrome_page())
                        .uia_focus(1_000, Some(password_box()))
                        .type_keys(1_005, gap, "Tr0ub4dor3")
                        .click_named(4_000, 60, None),
                );
                assert_eq!(
                    typed_in(&records),
                    [],
                    "page focused before: {page_focused}, a key every {gap} ms"
                );
            }
        }
        // Then a click on "Show", or on a box that takes no focus (typed more than a second on),
        // which leaves focus in the password box: the keys rest on the page answer still, and UI
        // Automation is asked.
        let show = in_chat()
            .click_on(1_000, IN_PASSWORD, chrome_page())
            .uia_focus(1_000, Some(password_box()))
            .click_on(1_300, ON_SHOW, show_button())
            .type_keys(1_305, 150, "Tr0ub4dor3")
            .click_named(5_000, 60, None);
        let read_only = in_chat()
            .click_on(1_000, IN_PASSWORD, chrome_page())
            .uia_focus(1_000, Some(password_box()))
            .click_on(1_300, IN_MESSAGE_BOX, message_box())
            .type_keys(2_400, 150, "Tr0ub4dor3")
            .click_named(6_000, 60, None);
        for (what, scene) in [("Show", show), ("a box that takes no focus", read_only)] {
            assert_eq!(typed_in(&record(scene)), [], "{what}");
        }
        // A part of the box (its text, unmarked), the read finding the box through its parent:
        // the lookup's own marking, so the focused element says it's one.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, chrome_page())
                .uia_focus(
                    1_000,
                    Some(ElementFacts {
                        control_type: "Text".into(),
                        sensitive: true,
                        ..ElementFacts::default()
                    }),
                )
                .type_keys(1_005, 150, "Tr0ub4dor3")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    #[test]
    fn typing_after_a_click_on_a_blank_part_of_a_chrome_app_keeps_its_value() {
        // Teams or VS Code, drawn by Chrome: a click on a blank part of the window (Chrome's page
        // answer) leaves focus in the message box. UI Automation, asked at each key, says so: the
        // value is kept. Asked as each of the five keys arrives, a key every 150 ms (#117: as each
        // was handled, #114), twice more between them, every 100 ms until it has been asked a
        // second after the click, then every 250 ms until the click that ends the stretch, seven
        // times, for an app that acts on the click later still (#117: 6 reads before).
        let (records, reads) = focus_read(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .type_keys(1_600, 150, "Hello")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        assert_eq!(reads, 14);
        // Then Bold, which leaves focus there too: asked again, the value is kept.
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .click_on(1_300, ON_SHOW, show_button())
                .type_keys(1_600, 150, "Hello")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        // UI Automation can't be read: the step keeps no value.
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .uia_focus(1_000, None)
                .type_keys(1_600, 150, "Hello")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
        // A click its lookup named is never checked.
        let (records, reads) = focus_read(
            in_chat()
                .click_on(1_000, IN_MESSAGE_BOX, message_box())
                .focus(1_080, focus_on(message_box()))
                .type_keys(1_600, 150, "Hello")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        assert_eq!(reads, 0);
    }

    #[test]
    fn tab_into_a_password_box_after_a_page_answer_is_checked_again() {
        // Chrome's page answer for a click in the user name box, which it never told of, nor of
        // the password box Tab moved to: the name, Tab, the password, one stretch of typing. UI
        // Automation is asked again after Tab, and says the password box has focus: nothing of the
        // stretch is kept.
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .type_keys(1_600, 150, "sam")
                .press(2_200, VK_TAB)
                .uia_focus(2_210, Some(password_box()))
                .type_keys(2_400, 150, "Tr0ub4dor3")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), []);
    }

    // ---------- #114: focus that reaches a password box after UI Automation was asked ----------

    const VK_ESCAPE: u16 = 0x1B;
    const VK_MENU: u16 = 0x12;

    /// Something that happens in a scene at a time, or after what the scene already holds.
    type ThenAt = fn(Scene, u32) -> Scene;
    type Then = fn(Scene) -> Scene;

    #[test]
    fn a_click_chrome_applies_late_never_lets_the_password_out() {
        // Chrome answered with its page for a click on the password box and applied the click
        // late: UI Automation still said the search box had focus as the first key was handled,
        // and the password box only from 1,200 ms, with no focus news for it at all. Fast or at
        // human speed, nothing is kept (#114: `Type "Tr0ub4dor3" in "Search"`).
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .click_on(1_000, IN_PASSWORD, chrome_page())
                    .uia_focus(1_200, Some(password_box()))
                    .type_keys(1_005, gap, "Tr0ub4dor3")
                    .click_named(4_000, 60, None),
            );
            assert_eq!(typed_in(&records), [], "a key every {gap} ms");
        }
        // Later still, 600 ms after the click, and Tab pressed 300 ms after the password, before
        // or after UI Automation catches up: no value is kept, whatever the timing, since it's
        // asked until it has been a second after the click.
        for gap in [10, 150] {
            let last = 1_005 + gap * 9;
            let records = record(
                in_chat()
                    .click_on(1_000, IN_PASSWORD, chrome_page())
                    .uia_focus(1_600, Some(password_box()))
                    .type_keys(1_005, gap, "Tr0ub4dor3")
                    .press(last + 300, VK_TAB)
                    .uia_focus(last + 305, Some(show_button()))
                    .click_named(5_000, 60, None),
            );
            assert!(
                records
                    .iter()
                    .all(|record| record.text.is_empty() && record.element.is_none()),
                "a key every {gap} ms: {:?}",
                typed_in(&records)
            );
        }
    }

    #[test]
    fn focus_the_app_moves_into_a_password_box_mid_stretch_never_lets_the_password_out() {
        // A blank part of the chat clicked (Chrome's page answer), the user name typed, then the
        // page moves focus into the password box itself, with no key and no focus news: the
        // password typed there is never kept with the name (#114: `Type "samTr0ub4dor3" in "Type
        // a message"`). Fast or at human speed.
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .focus(500, focus_on(message_box()))
                    .click_on(1_000, (600, 600), chrome_page())
                    .type_keys(1_600, gap, "sam")
                    .uia_focus(2_100, Some(password_box()))
                    .type_keys(2_200, gap, "Tr0ub4dor3")
                    .click_named(5_000, 60, None),
            );
            assert_eq!(typed_in(&records), [], "a key every {gap} ms");
        }
    }

    #[test]
    fn a_key_that_moves_focus_waiting_as_ui_automation_is_asked_keeps_no_value() {
        // A PIN typed into the password box Chrome answered with its page for (UI Automation says
        // the box has focus), 30 ms a key, then Tab, Enter, Escape or a combination before the
        // first key is handled, or while the click's lookup is slow: as UI Automation is asked
        // then, focus has moved on, to "Show" (#114: `Type "1234" in "Search"`). The key that
        // moved it was typed after the PIN, so what has focus then says nothing of where the PIN
        // went. Asked as the PIN arrives, it says the password box: nothing is kept (#117: until
        // then, "Type" with no value). When it can't be read as the keys arrive, they keep no
        // value, as before.
        let moves: [(&str, ThenAt); 4] = [
            ("Tab", |scene, ms| scene.press(ms, VK_TAB)),
            ("Enter", |scene, ms| scene.press(ms, VK_RETURN)),
            ("Escape", |scene, ms| scene.press(ms, VK_ESCAPE)),
            ("Alt+N", |scene, ms| {
                scene.combo(ms, VK_MENU, u16::from(b'N'))
            }),
        ];
        for (key, then) in moves {
            for lookup in [60, 400] {
                for readable in [true, false] {
                    let box_focused = readable.then(password_box);
                    let scene = in_chat()
                        .click_looked_up(1_000, lookup, IN_PASSWORD, Some(chrome_page()))
                        .uia_focus(1_000, box_focused)
                        .type_keys(1_005, 30, "1234");
                    let records = record(
                        then(scene, 1_125)
                            .uia_focus(1_130, Some(show_button()))
                            .click_named(4_000, 60, None),
                    );
                    let kept: &[(Option<&str>, &str)] = if readable { &[] } else { &[(None, "")] };
                    assert_eq!(
                        typed_in(&records),
                        kept,
                        "{key}, a lookup of {lookup} ms, read as the keys arrive: {readable}"
                    );
                }
            }
        }
    }

    #[test]
    fn typing_in_a_chrome_app_after_a_blank_click_keeps_its_value_with_reads_kept_down() {
        // Teams after a click on a blank part of its window (Chrome's page answer): fast typing
        // keeps its value, and UI Automation is asked at most every 50 ms as the keys arrive,
        // three times for eleven keys (#117), then every 100 ms until it has been asked a second
        // after the click, three times, not once a key (#114); then every 250 ms until the click
        // that ends the stretch, seven times, for an app that acts on the click later still
        // (#117: 4 reads before).
        let (records, reads) = focus_read(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .type_keys(1_600, 10, "Hello there")
                .click_named(4_000, 60, None),
        );
        assert_eq!(
            typed_in(&records),
            [(Some("Type a message"), "Hello there")]
        );
        assert_eq!(reads, 13);
        // At human speed, sent with Enter: the value is kept, Enter and all.
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .type_keys(1_600, 150, "Hello")
                .press(2_400, VK_RETURN)
                .type_keys(3_000, 150, "Bye")
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello\nBye")]);
        // And with Enter 100 ms after the last key, before that key was handled: it was asked
        // about as it arrived, before Enter (#117: it kept no value, Enter coming before the read
        // as the key was handled).
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .type_keys(1_600, 150, "Hello")
                .press(2_300, VK_RETURN)
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        // Failing closed, as for the PIN above, the step keeps no value when UI Automation can't
        // be asked about every key before a key that can move focus or a click: typed fast, Enter
        // 5 ms after the last key, before the next read as keys arrive (at most every 50 ms); or
        // Enter, or a click, less than a second after the click on the blank part, before it has
        // been asked once Chrome, if busy, has surely acted on that click.
        let scenes: [(&str, u32, Then); 3] = [
            ("Enter 5 ms on, typed fast", 10, |scene: Scene| {
                scene.type_keys(3_000, 10, "Bye").press(3_025, VK_RETURN)
            }),
            ("Enter within the second", 10, |scene: Scene| {
                scene.press(1_900, VK_RETURN)
            }),
            ("a click within the second", 10, |scene: Scene| {
                scene.click_on(1_900, ON_SHOW, show_button())
            }),
        ];
        for (what, gap, then) in scenes {
            let records = record(
                then(
                    in_chat()
                        .focus(500, focus_on(message_box()))
                        .click_on(1_000, (600, 600), chrome_page())
                        .type_keys(1_600, gap, "Hello"),
                )
                .click_named(5_000, 60, None),
            );
            assert_eq!(typed_in(&records), [(None, "")], "{what}");
        }
    }

    // ---------- #117: focus read as keys arrive, not only as they're handled ----------

    /// VS Code, drawn by Chrome as Teams is: a code editor, where Tab indents.
    fn code_window() -> WindowInfo {
        WindowInfo {
            exe_path: Some(
                r"C:\Users\sam\AppData\Local\Programs\Microsoft VS Code\Code.exe".into(),
            ),
            title: "main.py - Visual Studio Code".into(),
            ..chat()
        }
    }

    /// Whether a typing step kept any of the password or the PIN typed in a scene.
    fn kept_a_secret(records: &[TypingRecord]) -> bool {
        records
            .iter()
            .any(|record| record.text.contains("Tr0ub") || record.text.contains("1234"))
    }

    #[test]
    fn a_message_sent_with_enter_soon_after_its_last_letter_keeps_its_value() {
        // Teams after a click on a blank part of its window (Chrome's page answer): "Hello there"
        // at 60 to 200 ms a key, sent with Enter 40 to 120 ms after the last letter, then "Bye".
        // Enter came before the last letter was handled, 150 ms after it was typed, so UI
        // Automation, asked then, may have said where Enter moved focus: the step kept no value
        // (#117). Read as each letter arrives, it says the message box had focus as the last
        // letter was typed, before Enter: the value is kept.
        for start in [1_600, 3_000] {
            for gap in [60, 100, 150, 200] {
                for enter in [40, 80, 120] {
                    let last = start + gap * 10;
                    let records = record(
                        in_chat()
                            .focus(500, focus_on(message_box()))
                            .click_on(1_000, (600, 600), chrome_page())
                            .type_keys(start, gap, "Hello there")
                            .press(last + enter, VK_RETURN)
                            .type_keys(last + enter + 800, gap, "Bye")
                            .click_named(9_000, 60, None),
                    );
                    assert_eq!(
                        typed_in(&records),
                        [(Some("Type a message"), "Hello there\nBye")],
                        "from {start} ms, a key every {gap} ms, Enter {enter} ms after the last"
                    );
                }
            }
        }
        // VS Code: "return x", Enter 60 to 160 ms after it, Tab to indent, then "pass".
        for gap in [80, 150] {
            for enter in [60, 120, 160] {
                let last = 3_000 + gap * 7;
                let records = record(
                    Scene::default()
                        .in_window(code_window(), "Chrome_WidgetWin_1")
                        .focus(100, focus_on(search_box()))
                        .focus(500, focus_on(message_box()))
                        .click_on(1_000, (600, 600), chrome_page())
                        .type_keys(3_000, gap, "return x")
                        .press(last + enter, VK_RETURN)
                        .press(last + enter + 300, VK_TAB)
                        .type_keys(last + enter + 600, gap, "pass")
                        .click_named(9_000, 60, None),
                );
                assert_eq!(
                    typed_in(&records),
                    [(Some("Type a message"), "return x\n\tpass")],
                    "a key every {gap} ms, Enter {enter} ms after the last"
                );
            }
        }
    }

    #[test]
    fn a_pin_typed_at_machine_speed_into_a_box_that_moves_focus_itself_is_never_kept() {
        // Chrome's page answer for a click on a PIN box (UI Automation says the box has focus),
        // the PIN typed at 10 to 30 ms a key, straight away or a second and a half on, and the
        // page moving focus away by itself 20 to 80 ms after the last digit: no key, no news.
        // Asked only as each key was handled, 150 ms after it was typed, UI Automation already
        // said the message box had focus: `Type "1234" in "Search"` (#117). Read as the keys
        // arrive, it says the PIN box had focus: nothing is kept.
        for wait in [0, 1_500] {
            for gap in [10, 30] {
                for moves in [20, 50, 80] {
                    let from = 1_005 + wait;
                    let last = from + gap * 3;
                    let records = record(
                        in_chat()
                            .click_on(1_000, IN_PASSWORD, chrome_page())
                            .uia_focus(1_000, Some(password_box()))
                            .type_keys(from, gap, "1234")
                            .uia_focus(last + moves, Some(message_box()))
                            .click_named(6_000, 60, None),
                    );
                    assert!(
                        !kept_a_secret(&records),
                        "{wait} ms on, a key every {gap} ms, focus moving {moves} ms after the \
                         last: {:?}",
                        typed_in(&records)
                    );
                }
            }
        }
    }

    #[test]
    fn a_password_typed_before_chrome_acts_on_the_click_over_a_second_late_is_never_kept() {
        // Chrome answered with its page for a click on the password box, and acted on the click
        // only 2.1 to 2.6 seconds on, with no focus news at all; the password typed straight after
        // the click, fast or at human speed, and the stretch ended by a click at 6 seconds. UI
        // Automation, asked last a second after the click, said the search box had focus:
        // `Type "Tr0ub4dor3" in "Search"` (#117). Asked again as the stretch goes on, it says the
        // password box has focus once Chrome has acted: nothing is kept.
        for acts in [2_100, 2_600] {
            for gap in [10, 100, 150] {
                let records = record(
                    in_chat()
                        .click_on(1_000, IN_PASSWORD, chrome_page())
                        .uia_focus(1_000, Some(search_box()))
                        .uia_focus(acts, Some(password_box()))
                        .type_keys(1_005, gap, "Tr0ub4dor3")
                        .click_named(6_000, 60, None),
                );
                assert!(
                    !kept_a_secret(&records),
                    "Chrome acting at {acts} ms, a key every {gap} ms: {:?}",
                    typed_in(&records)
                );
            }
        }
        // Enter 30 ms after Chrome acts, moving focus on before the stretch is next asked about
        // with no key: asked as Enter arrives, UI Automation says the password box had focus, and
        // a password box found after Tab, Enter or Escape still drops the stretch.
        for acts in [2_100, 2_600] {
            let records = record(
                in_chat()
                    .click_on(1_000, IN_PASSWORD, chrome_page())
                    .uia_focus(1_000, Some(search_box()))
                    .uia_focus(acts, Some(password_box()))
                    .type_keys(1_005, 10, "Tr0ub4dor3")
                    .press(acts + 30, VK_RETURN)
                    .uia_focus(acts + 35, Some(message_box()))
                    .click_named(6_000, 60, None),
            );
            assert!(
                !kept_a_secret(&records),
                "Chrome acting at {acts} ms, then Enter: {:?}",
                typed_in(&records)
            );
        }
    }

    // ---------- #118: a click on something in a web page that isn't a box ----------

    /// Where the sign-in form's "Password" label, above its box, is clicked.
    const ON_PASSWORD_LABEL: (i32, i32) = (350, 390);

    /// The sign-in form's "Password" label in a web page drawn by `framework` ("Chrome" for
    /// Chrome, Edge and the apps it draws, "Gecko" for Firefox): a line of the page's text, whose
    /// `for` puts focus in the password box when it's clicked.
    fn password_label(framework: &str) -> ElementFacts {
        ElementFacts {
            control_type: "Text".into(),
            framework_id: framework.into(),
            name: "Password".into(),
            bounds: Some(PxRect {
                left: 300,
                top: 380,
                right: 400,
                bottom: 398,
            }),
            ..ElementFacts::default()
        }
    }

    #[test]
    fn a_click_on_a_password_boxs_label_in_a_web_page_never_lets_the_password_out() {
        // The "Password" label clicked: its lookup names the label, not the box its `for` puts
        // focus in, and no focus news comes for the box; UI Automation says the box has focus.
        // In Chrome or Firefox, typed straight after the click or 300 ms on, fast or at human
        // speed: nothing is kept (#118: `Type "Tr0ub4dor3" in "Search"`).
        for framework in ["Chrome", "Gecko"] {
            for from in [1_005, 1_300] {
                for gap in [10, 150] {
                    let records = record(
                        in_chat()
                            .click_on(1_000, ON_PASSWORD_LABEL, password_label(framework))
                            .uia_focus(1_000, Some(password_box()))
                            .type_keys(from, gap, "Tr0ub4dor3")
                            .click_named(5_000, 60, None),
                    );
                    assert_eq!(
                        typed_in(&records),
                        [],
                        "{framework}, keys from {from} ms, a key every {gap} ms"
                    );
                }
            }
        }
        // A busy page acting on the click late, UI Automation saying the search box had focus
        // until then; "Show" clicked after the label, which leaves focus in the box; or the search
        // box's news from before the click told more than a second late, with no key between that
        // can move focus, which says nothing of where focus is now.
        // A "Use a password instead" button, which takes focus as it's pressed (its own news) and
        // whose script then moves focus into the password box, with no news for the box.
        let use_password = ElementFacts {
            control_type: "Button".into(),
            framework_id: "Chrome".into(),
            name: "Use a password instead".into(),
            bounds: Some(PxRect {
                left: 300,
                top: 440,
                right: 500,
                bottom: 470,
            }),
            ..ElementFacts::default()
        };
        for gap in [10, 150] {
            let records = record(
                in_chat()
                    .click_on(1_000, (400, 455), use_password.clone())
                    .focus(1_050, focus_on(use_password.clone()))
                    .uia_focus(1_100, Some(password_box()))
                    .type_keys(1_300, gap, "Tr0ub4dor3")
                    .click_named(5_000, 60, None),
            );
            assert!(
                !kept_a_secret(&records),
                "a button's script, a key every {gap} ms: {:?}",
                typed_in(&records)
            );
        }
        for gap in [10, 150] {
            let stale = in_chat()
                .click_on(1_000, ON_PASSWORD_LABEL, password_label("Chrome"))
                .uia_focus(1_000, Some(password_box()))
                .focus(2_100, focus_on(search_box()))
                .type_keys(2_200, gap, "Tr0ub4dor3")
                .click_named(6_000, 60, None);
            let records = record(stale);
            assert!(
                !kept_a_secret(&records),
                "stale news, a key every {gap} ms: {:?}",
                typed_in(&records)
            );
            let late = in_chat()
                .click_on(1_000, ON_PASSWORD_LABEL, password_label("Chrome"))
                .uia_focus(1_000, Some(search_box()))
                .uia_focus(1_400, Some(password_box()))
                .type_keys(1_005, gap, "Tr0ub4dor3")
                .click_named(5_000, 60, None);
            let show = in_chat()
                .click_on(1_000, ON_PASSWORD_LABEL, password_label("Chrome"))
                .uia_focus(1_000, Some(password_box()))
                .click_on(1_300, ON_SHOW, show_button())
                .type_keys(1_305, gap, "Tr0ub4dor3")
                .click_named(5_000, 60, None);
            for (what, scene) in [("acting late", late), ("then Show", show)] {
                let records = record(scene);
                assert!(
                    !kept_a_secret(&records),
                    "{what}, a key every {gap} ms: {:?}",
                    typed_in(&records)
                );
            }
        }
    }

    /// Bold, a heading, a link and the message box's own label in the chat's page, drawn by
    /// `framework` ("" for none: a native app's): none is a box, and a click on any leaves focus
    /// in the message box (or, the label, puts it there).
    fn ordinary_text(framework: &str) -> [(&'static str, (i32, i32), ElementFacts); 4] {
        let element = |control_type: &str, name: &str, left: i32, top: i32| ElementFacts {
            control_type: control_type.into(),
            framework_id: framework.into(),
            name: name.into(),
            bounds: Some(PxRect {
                left,
                top,
                right: left + 100,
                bottom: top + 20,
            }),
            ..ElementFacts::default()
        };
        [
            ("Bold", (310, 770), element("Button", "Bold", 300, 760)),
            (
                "a heading",
                (410, 110),
                element("Text", "Weekly update", 400, 100),
            ),
            (
                "a link",
                (410, 210),
                element("Hyperlink", "Open the agenda", 400, 200),
            ),
            (
                "the message box's label",
                (310, 790),
                element("Text", "Message", 300, 780),
            ),
        ]
    }

    #[test]
    fn typing_after_a_click_on_ordinary_text_in_a_web_page_keeps_its_value() {
        // Bold, a heading, a link or the message box's label clicked in the chat's page, the
        // message box focused: "Hello" typed fast or at human speed, sent with Enter 80 ms after
        // the last letter and more than a second after the click, then "Bye". UI Automation,
        // asked as the keys arrive and a second after the click, says the message box has focus:
        // the value is kept, as before #118, in Chrome and Firefox.
        for framework in ["Chrome", "Gecko"] {
            for (what, point, element) in ordinary_text(framework) {
                for gap in [10, 150] {
                    let last = 1_600 + gap * 4;
                    let records = record(
                        in_chat()
                            .focus(500, focus_on(message_box()))
                            .click_on(1_000, point, element.clone())
                            .type_keys(1_600, gap, "Hello")
                            .press(last.max(2_100) + 80, VK_RETURN)
                            .type_keys(2_800, gap, "Bye")
                            .click_named(5_000, 60, None),
                    );
                    assert_eq!(
                        typed_in(&records),
                        [(Some("Type a message"), "Hello\nBye")],
                        "{what} in {framework}, a key every {gap} ms"
                    );
                }
            }
        }
        // Failing closed, as after Chrome's page answer: sent with Enter, or ended by a click,
        // less than a second after the click, before UI Automation has been asked once a busy
        // page has surely acted on it, the step keeps no value (#118: it kept "Hello").
        for (what, point, element) in ordinary_text("Chrome") {
            let enter = in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, point, element.clone())
                .type_keys(1_300, 150, "Hello")
                .press(1_980, VK_RETURN)
                .click_named(5_000, 60, None);
            let click = in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, point, element)
                .type_keys(1_300, 10, "Hello")
                .click_named(1_600, 60, None);
            for (end, scene) in [("Enter", enter), ("a click", click)] {
                assert_eq!(
                    typed_in(&record(scene)),
                    [(None, "")],
                    "{what}, then {end} within the second"
                );
            }
        }
        // Not a line of text inside the message box, which has focus (moving the caret in the
        // message), nor one whose own focus news names the box it's in (its placeholder, the
        // search box focused before): neither is a label's `for` or a script moving focus, and
        // Enter within the second keeps the value.
        let line = ElementFacts {
            control_type: "Text".into(),
            framework_id: "Chrome".into(),
            name: "Hello".into(),
            bounds: Some(PxRect {
                left: 310,
                top: 830,
                right: 400,
                bottom: 850,
            }),
            ..ElementFacts::default()
        };
        let inside = in_chat()
            .focus(500, focus_on(message_box()))
            .click_on(1_000, (350, 840), line.clone())
            .type_keys(1_300, 150, "Hi")
            .press(1_700, VK_RETURN)
            .click_named(4_000, 60, None);
        let own_news = in_chat()
            .click_on(1_000, (350, 840), line)
            .focus(1_080, focus_on(message_box()))
            .type_keys(1_300, 150, "Hi")
            .press(1_700, VK_RETURN)
            .click_named(4_000, 60, None);
        for (what, scene) in [("inside the box", inside), ("its own news", own_news)] {
            assert_eq!(
                typed_in(&record(scene)),
                [(Some("Type a message"), "Hi")],
                "{what}"
            );
        }
        // The same clicks outside a web page (Bold on Word's ribbon, a WPF app's text): never
        // checked, and Enter within the second keeps the value, as before.
        for (what, point, element) in ordinary_text("") {
            let (records, reads) = focus_read(
                in_chat()
                    .focus(500, focus_on(message_box()))
                    .click_on(1_000, point, element)
                    .type_keys(1_100, 150, "Hello")
                    .press(1_800, VK_RETURN)
                    .click_named(4_000, 60, None),
            );
            assert_eq!(
                typed_in(&records),
                [(Some("Type a message"), "Hello")],
                "{what}"
            );
            assert_eq!(reads, 0, "{what}");
        }
    }

    // ---------- #119: the focus check's throttle, its exemption, web engines and its reads ----------

    /// The sign-in form's user name box, above its password box.
    fn user_name_box() -> ElementFacts {
        chat_box(
            "User name",
            PxRect {
                left: 300,
                top: 340,
                right: 900,
                bottom: 370,
            },
        )
    }

    #[test]
    fn tab_then_a_pin_typed_at_machine_speed_is_read_in_the_pin_box() {
        // Chrome's page answer for a click in the user name box, which it never told of, nor of
        // the PIN box Tab moved to: "sam", Tab, then a PIN at 3 to 10 ms a key (a password
        // manager), the page moving focus to the message box by itself 2 to 20 ms after the last
        // digit, with no key and no news. The read as Tab arrived held the next one back for
        // 50 ms, and the PIN came and went in them (#119: `Type "sam1234" in "Search"`). Tab and
        // the key after it are read as they arrive.
        for tab_to_pin in [5, 10, 20, 30] {
            for gap in [3, 5, 10] {
                for moves in [2, 5, 10, 20] {
                    let tab = 3_000;
                    let from = tab + tab_to_pin;
                    let last = from + gap * 3;
                    let records = record(
                        in_chat()
                            .click_on(1_000, (600, 355), chrome_page())
                            .uia_focus(1_000, Some(user_name_box()))
                            .type_keys(2_500, 100, "sam")
                            .press(tab, VK_TAB)
                            .uia_focus(tab + 5, Some(password_box()))
                            .type_keys(from, gap, "1234")
                            .uia_focus(last + moves, Some(message_box()))
                            .click_named(6_000, 60, None),
                    );
                    assert!(
                        !kept_a_secret(&records),
                        "the PIN {tab_to_pin} ms after Tab, a key every {gap} ms, focus moving \
                         {moves} ms after it: {:?}",
                        typed_in(&records)
                    );
                }
            }
        }
    }

    #[test]
    fn enter_after_chrome_acts_late_is_read_as_it_arrives() {
        // Chrome's page answer for a click on the password box, which it acts on 2 seconds or
        // more late, with no news; the password typed straight after the click, then Enter 5 or
        // 10 ms after Chrome acts, the page moving focus to the message box 2 to 15 ms after
        // Enter. The read as Enter arrived waited for 50 ms to pass since the one before, and
        // focus had moved on by then (#119: `Type "Tr0ub4dor3" in "Search"`). Enter is read as it
        // arrives; Enter and the move both within one of the key worker's turns, 10 ms apart,
        // still can't be caught.
        for acts in [2_020, 2_100, 2_200] {
            for (enter_after, lag) in [(10, 2), (10, 5), (5, 15)] {
                let enter = acts + enter_after;
                let records = record(
                    in_chat()
                        .click_on(1_000, IN_PASSWORD, chrome_page())
                        .uia_focus(1_000, Some(search_box()))
                        .uia_focus(acts, Some(password_box()))
                        .type_keys(1_005, 10, "Tr0ub4dor3")
                        .press(enter, VK_RETURN)
                        .uia_focus(enter + lag, Some(message_box()))
                        .click_named(enter + 2_000, 60, None),
                );
                assert!(
                    !kept_a_secret(&records),
                    "Chrome acting at {acts} ms, Enter {enter_after} ms on, focus moving {lag} ms \
                     after it: {:?}",
                    typed_in(&records)
                );
            }
        }
    }

    /// The sign-in form's e-mail box in its web page, above the password box.
    fn email_box() -> ElementFacts {
        ElementFacts {
            framework_id: "Chrome".into(),
            ..chat_box(
                "Email",
                PxRect {
                    left: 300,
                    top: 340,
                    right: 900,
                    bottom: 370,
                },
            )
        }
    }

    #[test]
    fn a_click_on_a_button_inside_the_box_with_focus_is_checked() {
        // An inline "Next" arrow (a button, or an image) drawn inside the focused e-mail box,
        // whose script moves focus into the password box, with no news for the arrow or the box:
        // a click inside the box with focus counted as moving its caret, and was never checked
        // (#119: `Type "Tr0ub4dor3" in "Email"`). Only a line of its text, or a group of its
        // parts, is the box's own.
        for control_type in ["Button", "Image"] {
            for (from, gap) in [(1_005, 10), (1_300, 150), (2_200, 150)] {
                let arrow = ElementFacts {
                    control_type: control_type.into(),
                    framework_id: "Chrome".into(),
                    name: "Next".into(),
                    bounds: Some(PxRect {
                        left: 860,
                        top: 345,
                        right: 895,
                        bottom: 365,
                    }),
                    ..ElementFacts::default()
                };
                let records = record(
                    in_chat()
                        .focus(500, focus_on(email_box()))
                        .click_on(1_000, (880, 355), arrow)
                        .uia_focus(1_000, Some(email_box()))
                        .uia_focus(1_050, Some(password_box()))
                        .type_keys(from, gap, "Tr0ub4dor3")
                        .click_named(5_000, 60, None),
                );
                assert!(
                    !kept_a_secret(&records),
                    "{control_type}, keys from {from} ms, a key every {gap} ms: {:?}",
                    typed_in(&records)
                );
            }
        }
    }

    /// The chat app in Firefox's window, whose elements UI Automation may name no framework for:
    /// its search box focused.
    fn in_firefox() -> Scene {
        Scene::default()
            .in_window(chat(), "MozillaWindowClass")
            .focus(100, focus_on(search_box()))
    }

    #[test]
    fn a_click_on_a_password_boxs_label_in_edges_ie_mode_or_firefox_is_checked() {
        // The "Password" label clicked in Edge's IE mode or a WebBrowser control (UI Automation's
        // framework `InternetExplorer`), or in Firefox's window with no framework named, then the
        // password: only Chrome's and Gecko's pages were checked (#119: `Type "Tr0ub4dor3" in
        // "Search"`).
        for (what, scene, framework) in [
            ("IE mode", in_chat as fn() -> Scene, "InternetExplorer"),
            ("Firefox's window", in_firefox, ""),
        ] {
            for from in [1_005, 1_300] {
                for gap in [10, 150] {
                    let records = record(
                        scene()
                            .click_on(1_000, ON_PASSWORD_LABEL, password_label(framework))
                            .uia_focus(1_000, Some(password_box()))
                            .type_keys(from, gap, "Tr0ub4dor3")
                            .click_named(5_000, 60, None),
                    );
                    assert_eq!(
                        typed_in(&records),
                        [],
                        "{what}, keys from {from} ms, a key every {gap} ms"
                    );
                }
            }
            // Ordinary text there keeps its value once the stretch goes on a second, as in
            // Chrome's pages.
            for (text, point, element) in ordinary_text(framework) {
                let records = record(
                    scene()
                        .focus(500, focus_on(message_box()))
                        .click_on(1_000, point, element)
                        .type_keys(1_600, 150, "Hello")
                        .press(2_300, VK_RETURN)
                        .click_named(5_000, 60, None),
                );
                assert_eq!(
                    typed_in(&records),
                    [(Some("Type a message"), "Hello")],
                    "{text} in {what}"
                );
            }
        }
    }

    #[test]
    fn reads_with_nothing_typed_stop_five_seconds_after_the_click() {
        // "Hello" typed after a click on Bold in a web page, then nothing until a click: UI
        // Automation was asked every 250 ms until that click, 2,400 times in ten minutes (#119).
        // The app acting on the click late, which those reads are for, does so within 2 or 3
        // seconds: they stop 5 seconds after the click, and the value is kept.
        let (_, point, bold) = ordinary_text("Chrome")[0].clone();
        let scene = |click: u32| {
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, point, bold.clone())
                .type_keys(1_500, 150, "Hello")
                .click_named(click, 60, None)
        };
        let (records, soon) = focus_read(scene(8_000));
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        let (records, later) = focus_read(scene(600_000));
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
        assert_eq!(later, soon);
        // Chrome acting on a click on the password box 3.5 seconds late, with no news: still
        // caught.
        let records = record(
            in_chat()
                .click_on(1_000, IN_PASSWORD, chrome_page())
                .uia_focus(1_000, Some(search_box()))
                .uia_focus(4_500, Some(password_box()))
                .type_keys(1_005, 10, "Tr0ub4dor3")
                .click_named(60_000, 60, None),
        );
        assert!(!kept_a_secret(&records), "{:?}", typed_in(&records));
    }

    #[test]
    fn a_read_that_times_out_keeps_no_value() {
        // A hung app: UI Automation gives up on it (`ScreenText`'s timeouts) and the read says
        // nothing, from the read a second after the click on. Typing after Chrome's page answer
        // keeps no value, as when focus can't be read at all (#119).
        let records = record(
            in_chat()
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .uia_focus(1_000, Some(message_box()))
                .uia_focus(1_900, None)
                .type_keys(1_600, 150, "Hello")
                .press(2_500, VK_RETURN)
                .click_named(5_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(None, "")]);
    }

    #[test]
    fn a_slow_read_begun_within_the_second_after_the_click_never_settles_it() {
        // Each read takes 300 ms (a busy page): one begun 750 ms after Chrome's page answer for a
        // click on the password box returned more than a second after it, and counted as a read
        // a second after the click, which a busy Chrome has acted on by then. It hadn't, and the
        // password typed straight after the click, the stretch ended by a click 990 ms on, kept
        // `Type "Tr0ub4dor3" in "Search"` (#119). It counts from when it began.
        for gap in [10, 30] {
            let records = record(
                in_chat()
                    .focus_reads_take(300)
                    .click_on(1_000, IN_PASSWORD, chrome_page())
                    .uia_focus(1_000, Some(search_box()))
                    .type_keys(1_005, gap, "Tr0ub4dor3")
                    .click_named(1_990, 60, None),
            );
            assert_eq!(typed_in(&records), [(None, "")], "a key every {gap} ms");
        }
        // Begun a second after the click, it does: typing after a click on a blank part of Teams
        // keeps its value.
        let records = record(
            in_chat()
                .focus_reads_take(300)
                .focus(500, focus_on(message_box()))
                .click_on(1_000, (600, 600), chrome_page())
                .type_keys(1_600, 150, "Hello")
                .click_named(4_000, 60, None),
        );
        assert_eq!(typed_in(&records), [(Some("Type a message"), "Hello")]);
    }
}
