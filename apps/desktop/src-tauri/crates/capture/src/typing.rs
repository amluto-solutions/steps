//! The key worker (docs/spec/02-capture.md#keys): turns the keys of a recording with "Record
//! what's typed" ticked into commands, typing and key combinations.
//!
//! It runs on its own thread, so reading a terminal or taking a screenshot never delays a click.
//! Keys are handled 150 ms after they arrive: UI Automation's focus news can trail the first key
//! typed into a field, and which field it is decides what happens (a password field's keys are
//! dropped). Clicks and focus changes are put in time order with the keys for the same reason:
//! the worker hears of each mouse press from the input thread at once, and keys typed after it
//! wait until the click pipeline has said what it was (#97). That order, and handing each key to
//! the place it went, is this module's one reason to change; each place has a module of its own:
//!
//! - **Terminals** (`typing/terminal_keys.rs`, the classic console, Windows Terminal): Enter is
//!   the signal. The command and its output are read from the screen once the output has
//!   settled, and one screenshot is taken.
//! - **Excel** (`typing/excel_keys.rs`): a stretch is what's typed into one cell: the cell the
//!   click before it selected, or the one UI Automation names, never a cell from before a click
//!   or a move. Its text is the keys, or the formula bar's reading when that shows more (an edit
//!   after F2). A cell's reference typed into Go To or the Name Box goes to that cell.
//! - **Fields** whose value can be read when focus leaves them (the focus handler does that): their
//!   keys make no step of their own.
//! - **Anywhere else** (`typing/editor_keys.rs`, a code editor, a document): one step per stretch
//!   of typing, ended by a click, a focus change, a key combination or leaving the window. It's
//!   named by the element with focus, if it's the window's; in Save As and Open, where UI
//!   Automation can name the dialog's pane, by the File name box Windows says has the keyboard
//!   (#61).
//! - **Key combinations**, except the noise list, become steps of their own (here).
//! - **Dictation** (`typing/dictation.rs`, #91): Windows voice typing hands text to the app with
//!   no keys. The text box with focus is read when focus arrives and when a stretch of time ends,
//!   and what was added with no key that types is a typing step, with its value only when voice
//!   typing was evidently in use (12/10/2026).
//! - **Unicode packets** (`VK_PACKET`: another program typing, such as a password manager's
//!   auto-type) keep no value: a stretch with any is "Type", and a terminal line with any makes
//!   no step (decision of 11/10/2026).
//!
//! What has the focus, and whether its element is the window's, is `typing/focus.rs`; what a click
//! says of where the keys typed straight after it went, before UI Automation's news of the focus
//! it moved, is `typing/clicks.rs` (#97); where keys go, the password guard and the step a stretch
//! of typing makes are `typing/stretch.rs`; when UI Automation is asked what has focus for typing
//! after a click that couldn't say what it went to (or on a web page's text, #118), and what each
//! read says of the keys before it, is `typing/focus_check.rs` (#114, #117). What the worker reads of the desktop is behind the
//! `Desktop` seam (`typing/desktop.rs`), which the worker-level tests stand in for
//! (`typing/scene.rs`).
//!
//! Keys are never kept for Steps' own windows, excluded apps, or password and sensitive
//! fields, and nothing is kept from a pause.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::platform::input::{InputShared, KeyEvent};
use crate::platform::keyboard::{Modifiers, caps_lock_on};
use crate::platform::window::{WindowInfo, own_process_id};
use image::RgbaImage;

use crate::coords::PxRect;
use crate::excel::{self, opens_go_to};
use crate::facts::{CaptureFacts, KeysRecord, Record};
use crate::keys::{Combo, KeyAction, KeyReader};
use crate::programs::window_facts;
use crate::screenshot::{CaptureMode, Shot};
use crate::state_machine::{EventDecision, RecorderStateMachine};

mod clicks;
mod desktop;
mod dictation;
mod editor_keys;
mod excel_keys;
mod focus;
mod focus_check;
#[cfg(test)]
mod scene;
mod stretch;
mod terminal_keys;

pub use clicks::{ClickNews, Looked, PressReport};
use clicks::{KeysWent, PRESS_REPORT_WAIT, PendingClick, SinceClick, WaitingPress};
use desktop::{Desktop, LiveDesktop};
use dictation::{Began, Dictation, Ended, Pointer};
use excel_keys::{BarReading, ExcelCells, GoToArm, GoesTo, excel_entry};
pub use focus::{FocusNote, FocusUpdate, SharedFocus};
use focus::{address_bar_took, another_program, combo_box_in, element_in_window};
use focus_check::FocusReads;
use stretch::{KeptTyping, PasswordGuard, Place, Stretch, kept_typing, place_in};
use terminal_keys::TerminalSession;

/// Settings for the key worker, from the recording's start.
#[derive(Debug, Clone)]
pub struct KeyOptions {
    /// "Include command output".
    pub output: bool,
    /// How long output must stay unchanged before it is read (Settings → Recording).
    pub settle: Duration,
    /// Extra sensitive words from IT policy.
    pub extra_terms: Vec<String>,
    pub mode: CaptureMode,
    pub target_monitor: Option<PxRect>,
}

/// A record the key worker made, with its screenshot.
pub type KeyedRecord = (Record, Option<RgbaImage>);

/// How long keys wait before they are handled, so focus news can catch up.
const KEY_DELAY: Duration = Duration::from_millis(150);
/// How long after the last key a stretch of typing is photographed.
const SHOT_AFTER_KEYS: Duration = Duration::from_millis(400);
/// How soon after a key the terminal or formula bar is read again.
const READ_AFTER_KEYS: Duration = Duration::from_millis(120);
/// How long a window's details are reused.
const WINDOW_CACHE: Duration = Duration::from_secs(2);
/// How long a click waits for its lookup to name what it clicked (in Excel, the cell it
/// selected), holding up the keys typed after it (#75, #97). The lookup gives up well before
/// (`PipelineConfig::uia_timeout`).
const CLICK_LOOKUP_WAIT: Duration = Duration::from_secs(1);
/// How much focus news can wait to be applied: far more than comes while keys wait for a click.
const FOCUS_NEWS_KEPT: usize = 64;
/// Record ids for key records: well clear of click ids, which count up from 1.
const FIRST_ID: u64 = 1 << 48;

/// The running key worker. Stopping it finishes what's in progress first.
pub struct KeyWorker {
    stop: Arc<AtomicBool>,
    clicks: Arc<ClickNews>,
    thread: Option<JoinHandle<()>>,
}

impl KeyWorker {
    /// Starts the worker thread.
    ///
    /// # Errors
    /// If the thread can't be started.
    pub fn start(
        shared: Arc<InputShared>,
        machine: Arc<Mutex<RecorderStateMachine>>,
        focus: SharedFocus,
        options: KeyOptions,
        out: Sender<KeyedRecord>,
    ) -> std::io::Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let clicks = Arc::new(ClickNews::default());
        let (worker_stop, worker_clicks) = (Arc::clone(&stop), Arc::clone(&clicks));
        let caps_lock = caps_lock_on();
        let applied = focus.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let thread = std::thread::Builder::new()
            .name("amluto-keys".into())
            .spawn(move || {
                // Built here: UI Automation objects stay on the thread that made them.
                let desktop = LiveDesktop::new();
                let links = Links {
                    machine,
                    focus,
                    options,
                    out,
                    clicks: worker_clicks,
                };
                let pointer = Pointer::of(&shared);
                Worker::new(desktop, links, applied, pointer, caps_lock).run(&shared, &worker_stop);
            })?;
        Ok(Self {
            stop,
            clicks,
            thread: Some(thread),
        })
    }

    /// Where the click pipeline reports clicks.
    #[must_use]
    pub fn clicks(&self) -> Arc<ClickNews> {
        Arc::clone(&self.clicks)
    }

    /// Finishes what's in progress, sends it, and stops.
    pub fn stop(mut self) {
        self.stop_inner();
    }

    fn stop_inner(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for KeyWorker {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

/// What the key worker is connected to.
struct Links {
    machine: Arc<Mutex<RecorderStateMachine>>,
    focus: SharedFocus,
    options: KeyOptions,
    out: Sender<KeyedRecord>,
    clicks: Arc<ClickNews>,
}

struct Worker<D: Desktop> {
    desktop: D,
    machine: Arc<Mutex<RecorderStateMachine>>,
    focus: SharedFocus,
    options: KeyOptions,
    out: Sender<KeyedRecord>,
    clicks: Arc<ClickNews>,
    reader: KeyReader,
    windows: HashMap<isize, (Instant, Option<(WindowInfo, String)>)>,
    pending: VecDeque<(Instant, KeyEvent)>,
    /// Clicks reported and not yet applied, oldest first (#97).
    pending_clicks: VecDeque<PendingClick>,
    last_clicks: u64,
    /// The latest click the worker heard of the pipeline recording.
    heard_click: Option<u32>,
    /// The mouse presses the input thread saw that the click pipeline hasn't reported yet,
    /// oldest first (#97).
    waiting_presses: VecDeque<WaitingPress>,
    /// The input thread's last mouse press as last seen.
    last_press: Option<u32>,
    /// The latest press applied as a click nothing was known of, which the pipeline reported too
    /// late.
    applied_press: Option<u32>,
    /// When the worker started: the earliest a click it never heard of can have been (#97).
    started: u32,
    /// The latest click applied outside Excel, for where the keys typed straight after it went
    /// (#97).
    since_click: Option<SinceClick>,
    /// The latest click applied, in Excel too, while its lookup hasn't finished: which click it
    /// is, when it was pressed and the window clicked, for what the lookup says once it has.
    unnamed_click: Option<(u64, u32, isize)>,
    /// UI Automation's word on the element with focus, read as keys arrive and as they're handled,
    /// for a stretch of typing after a click that couldn't say what it went to (#117).
    focus_reads: FocusReads,
    /// Focus news heard of and not yet applied, oldest first, each with when it was heard of.
    /// Kept, not replaced by the next, while it waits behind a click or press: the first news
    /// after a click says where the keys typed straight after it went (#97).
    pending_focus: VecDeque<(Instant, FocusNote)>,
    last_focus: u64,
    /// Where focus was as of the keys handled so far: focus changes applied in time order with
    /// the keys. Never the latest focus, which may already have moved on: two digits of a PIN
    /// typed just before a click on a checkbox were recorded as typed into the checkbox.
    applied: FocusNote,
    password: PasswordGuard,
    excel_cells: ExcelCells,
    /// Go To, opened and waiting for its keys (#69).
    go_to: Option<GoToArm>,
    /// Excel's formula bar as keys arrived after a click that couldn't say what it went to:
    /// the window, when it was read and what it showed, oldest first (#97 fourth review).
    bar_seen: VecDeque<(isize, u32, String)>,
    /// The windows keys went to in the last turn, whose formula bar is read again this turn.
    bar_typed_in: Vec<isize>,
    stretch: Option<Stretch>,
    terminal: Option<TerminalSession>,
    /// The text box watched for dictation, and the signs of voice typing (#91).
    dictation: Dictation,
    next_id: u64,
    /// Whether the recording was taking steps as of the last turn: what's finished at a pause
    /// or Stop is from before it.
    was_active: bool,
    keys_dropped: u64,
}

impl<D: Desktop> Worker<D> {
    /// A worker that starts from `applied`, where focus was as the recording began, and
    /// `pointer`, the presses before it.
    fn new(
        desktop: D,
        links: Links,
        applied: FocusNote,
        pointer: Pointer,
        caps_lock: bool,
    ) -> Self {
        let Links {
            machine,
            focus,
            options,
            out,
            clicks,
        } = links;
        let started = desktop.tick_now();
        Self {
            desktop,
            machine,
            focus,
            options,
            out,
            clicks,
            reader: KeyReader::new(caps_lock),
            windows: HashMap::new(),
            pending: VecDeque::new(),
            pending_clicks: VecDeque::new(),
            last_clicks: 0,
            heard_click: None,
            waiting_presses: VecDeque::new(),
            last_press: pointer.press,
            applied_press: None,
            started,
            since_click: None,
            unnamed_click: None,
            focus_reads: FocusReads::default(),
            pending_focus: VecDeque::new(),
            last_focus: applied.generation,
            password: PasswordGuard::starting(&applied),
            applied,
            excel_cells: ExcelCells::default(),
            go_to: None,
            bar_seen: VecDeque::new(),
            bar_typed_in: Vec::new(),
            stretch: None,
            terminal: None,
            dictation: Dictation::new(pointer),
            next_id: FIRST_ID,
            was_active: true,
            keys_dropped: 0,
        }
    }

    fn run(mut self, shared: &InputShared, stop: &AtomicBool) {
        loop {
            let stopping = stop.load(Ordering::SeqCst);
            let arrived = std::iter::from_fn(|| shared.pop_key());
            let dropped = shared.keys_dropped.load(Ordering::Relaxed);
            let pointer = Pointer::of(shared);
            if self.turn(Instant::now(), stopping, arrived, dropped, pointer) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// One turn of the worker's loop at `now`: the keys that `arrived` since the last turn, the
    /// count of keys lost so far and the input thread's last presses, then whatever has waited
    /// long enough, then timed work. `true` once stopping has finished everything.
    fn turn(
        &mut self,
        now: Instant,
        stopping: bool,
        arrived: impl IntoIterator<Item = KeyEvent>,
        dropped: u64,
        pointer: Pointer,
    ) -> bool {
        self.dictation.note_pointer(pointer);
        // A key typed before the last formula-bar reading that only now came in may be in that
        // reading, so it isn't used (#76).
        let unchecked = self
            .stretch
            .as_mut()
            .and_then(|stretch| stretch.bar_unchecked.take());
        let mut shown = false;
        // The windows keys went to, for Excel's formula bar (`watch_bar`).
        let mut typed_in = Vec::new();
        // Reads of focus taken before the oldest key waiting say nothing of it (#117).
        self.focus_reads
            .forget_before(self.pending.front().map(|(at, _)| *at));
        for event in arrived {
            shown |= unchecked.as_ref().is_some_and(|reading| {
                crate::state_machine::tick_before_or_at(event.tick_ms, reading.tick)
            });
            if !event.up {
                self.focus_reads
                    .key_arrived(event.tick_ms, event.foreground, event.vkey);
                if !typed_in.contains(&event.foreground) {
                    typed_in.push(event.foreground);
                }
            }
            self.pending.push_back((now, event));
        }
        if let Some(reading) = unchecked
            && !shown
            && let Some(stretch) = self.stretch.as_mut()
        {
            stretch.bar = Some(reading);
        }
        if dropped != self.keys_dropped {
            self.keys_dropped = dropped;
            if let Some(stretch) = self.stretch.as_mut() {
                stretch.approximate = true;
            }
        }
        self.take_news(now, pointer.press);
        // What has focus as the keys arrive, for a stretch UI Automation checks: as they're
        // handled, 150 ms on, a key that moves focus may have come since (#117).
        self.read_focus_as_keys_arrive(now);
        self.watch_bar(typed_in);
        self.handle_due(now, stopping);

        let active = self.lock_machine().is_active();
        if !active && self.was_active {
            // Pause: what was typed so far is kept; nothing typed during the pause is.
            self.finish_all(now);
            self.reader.reset();
            self.pending.clear();
            self.dictation.due = true;
        }
        self.was_active = active;
        if stopping {
            self.finish_all(now);
            return true;
        }
        // The text box with focus as the recording began, or went on after a pause (#91). Focus
        // news still to be applied says where focus is instead.
        if active && self.dictation.due && self.pending_focus.is_empty() {
            self.dictation.due = false;
            self.watch_focus(now);
        }
        self.tick(now);
        false
    }

    fn lock_machine(&self) -> std::sync::MutexGuard<'_, RecorderStateMachine> {
        self.machine.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Notes new clicks and focus changes, to be applied in time order with the keys, and the
    /// mouse press the input thread last saw (`press`).
    fn take_news(&mut self, now: Instant, press: Option<u32>) {
        self.take_click_news(now, press);
        let note = self
            .focus
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if note.generation != self.last_focus {
            self.last_focus = note.generation;
            // Each note counts the password boxes focused before it, so letting go of the oldest
            // never loses one (10/10/2026).
            if self.pending_focus.len() >= FOCUS_NEWS_KEPT {
                self.pending_focus.pop_front();
            }
            self.pending_focus.push_back((now, note));
        }
    }

    /// Handles keys, clicks and focus changes that have waited long enough, oldest first.
    fn handle_due(&mut self, now: Instant, all: bool) {
        loop {
            let key = self.pending.front().map(|(at, key)| (*at, key.tick_ms));
            let key_at = key.map(|(at, _)| at);
            let focus_at = self.pending_focus.front().map(|(seen, _)| *seen);
            let due = |at: Instant| all || now.duration_since(at) >= KEY_DELAY;

            // A click ends typing: keys typed before it (by tick) and focus news heard before it
            // are handled first, and nothing that came after it is handled before it.
            if let Some((seen, tick)) = self
                .pending_clicks
                .front()
                .map(|click| (click.seen, click.tick))
            {
                let key_before = key.is_some_and(|(_, key_tick)| {
                    crate::state_machine::tick_before_or_at(key_tick, tick)
                });
                let focus_before = focus_at.is_some_and(|at| at < seen);
                // A press before it still to be applied: clicks let go unheard of.
                let press_before = self.waiting_presses.front().is_some_and(|waiting| {
                    crate::state_machine::tick_before_or_at(waiting.tick, tick)
                });
                // Keys typed after it wait for it, even one that reached the worker first.
                if !key_before && !focus_before && !press_before {
                    if !due(seen) {
                        break;
                    }
                    if !all && self.click_waits_for_lookup(now) {
                        break;
                    }
                    if let Some(click) = self.pending_clicks.pop_front() {
                        self.apply_click(click, now);
                    }
                    continue;
                }
            }
            // A press the click pipeline hasn't reported yet: keys typed after it, and focus news
            // heard of since, wait for its report, or for so long that it's a click nothing is
            // known of (#97).
            if let Some(&waiting) = self.waiting_presses.front() {
                let key_before = key.is_some_and(|(_, key_tick)| {
                    crate::state_machine::tick_before_or_at(key_tick, waiting.tick)
                });
                let focus_before = focus_at.is_some_and(|at| at < waiting.seen);
                if !key_before && !focus_before {
                    if !all && !waiting.lost && now.duration_since(waiting.seen) < PRESS_REPORT_WAIT
                    {
                        break;
                    }
                    self.waiting_presses.pop_front();
                    self.apply_press(waiting);
                    continue;
                }
            }
            // The click's own focus news, heard after it, goes before the keys typed straight after
            // the click, which reached the worker first (#97).
            let click_news = self.click_news_waiting();
            if let Some(seen) = focus_at
                && (click_news || (key_at.is_none_or(|at| seen <= at) && due(seen)))
            {
                if let Some((_, note)) = self.pending_focus.pop_front() {
                    self.apply_focus(&note, now);
                }
                continue;
            }
            match key_at {
                Some(at) if due(at) => {
                    if let Some((arrived, event)) = self.pending.pop_front() {
                        self.on_key(&event, arrived, now);
                    }
                }
                _ => break,
            }
        }
    }

    /// Applies focus news, in time order with the keys.
    fn apply_focus(&mut self, note: &FocusNote, now: Instant) {
        // What was dictated into the text box focus left is read before anything else.
        self.end_watch(Ended::At(note.tick_ms), now);
        self.applied = note.clone();
        self.password.focus_applied(note);
        self.focus_moved(note);
        self.click_heard_of(note);
        self.watch_focus(now);
    }

    /// Handles a key that reached the worker at `arrived`.
    fn on_key(&mut self, event: &KeyEvent, arrived: Instant, now: Instant) {
        let desktop = &self.desktop;
        let Some(action) = self.reader.read(event, |vkey, scan, held, hwnd| {
            desktop.typed_text(vkey, scan, held, hwnd)
        }) else {
            return;
        };
        if self.lock_machine().should_process_event(event.tick_ms) != EventDecision::Process {
            return;
        }
        // A key that can move focus, wherever it went: focus news after it can say focus moved on
        // from a password box clicked before it (#97 third review).
        if matches!(
            action,
            KeyAction::Tab | KeyAction::Enter | KeyAction::Escape | KeyAction::Combo(_)
        ) {
            self.focus_key(event.tick_ms);
        }
        // Whatever these keys put in the watched text box is theirs, never dictation, wherever
        // they went (#91).
        if action.may_type() {
            self.dictation.keyed();
        }
        // Which of the text input host's panels may be showing, wherever the keys went.
        if let KeyAction::Combo(combo) = &action {
            self.dictation.note_combination(*combo, event);
        }
        let place = self.place(event.foreground, event.tick_ms);
        // Ctrl+G or F5 in a workbook opens Go To, whose Reference box the next keys go to (#69).
        // Keys anywhere else mean Go To has closed, or never opened.
        let opens_go_to = matches!(place, Place::Excel(_))
            && opens_go_to(&action, event.vkey, self.reader.modifiers());
        if !opens_go_to && !matches!(place, Place::GoTo { .. }) {
            self.go_to = None;
        }
        if let Place::Excel(hwnd) = place
            && opens_go_to
        {
            self.go_to = self.window(hwnd).map(|(window, _)| GoToArm {
                excel: hwnd,
                pid: window.pid,
                dialog: None,
            });
        }
        match place {
            Place::Blocked => {
                self.end_stretch(true);
                self.end_terminal();
                return;
            }
            Place::Sensitive => return,
            _ => {}
        }
        // A paste is a "Press Ctrl + V" step, as copy is (04/10/2026: a paste into Notepad++
        // made a "Type this code" step of the clipboard). It had been recorded as typing (F003,
        // F025); the clipboard is no longer read at all.
        if let KeyAction::Combo(combo) = &action {
            // Many move Excel's selection (Ctrl+arrows, Ctrl+Home, undo, Go To): which cell is
            // selected isn't known until the focus news says (#75).
            if let Place::Excel(hwnd) = place {
                self.excel_cells.moved(hwnd, event.tick_ms);
            }
            // Win+H starts and stops voice typing: what was dictated before it is read now (#91),
            // and what's added after it is dictation. Any other combination can put text in by
            // other means (Win+V's clipboard history, the emoji panel, a paste).
            let next = if combo.is_voice_typing() {
                Began::VoiceKey
            } else {
                Began::Other
            };
            self.dictation.forget_read_now();
            self.dictation_cut(None, Ended::At(event.tick_ms), next, now);
            if combo.is_noise() {
                // Alt+Tab and the like leave the stretch going, but focus may have moved (#114).
                self.focus_key_for_check();
                return;
            }
            self.end_stretch(true);
            self.combo_step(*combo, event);
            return;
        }
        // Typing somewhere else ends a stretch here.
        let here = match &place {
            Place::Terminal(hwnd, _)
            | Place::Excel(hwnd)
            | Place::Editor(hwnd, _)
            | Place::GoTo { dialog: hwnd, .. } => Some(*hwnd),
            _ => None,
        };
        if self.stretch.as_ref().is_some_and(|stretch| {
            Some(stretch.hwnd) != here || matches!(place, Place::Terminal(..))
        }) {
            self.end_stretch(true);
        }
        if self.terminal.as_ref().is_some_and(
            |session| !matches!(place, Place::Terminal(hwnd, _) if hwnd == session.hwnd),
        ) {
            self.end_terminal();
        }
        match place {
            Place::Terminal(hwnd, kind) => {
                self.terminal_key(hwnd, kind, &action, event.tick_ms, now);
            }
            Place::Excel(hwnd) => self.excel_key(hwnd, &action, event.tick_ms, now),
            Place::Editor(hwnd, code) => {
                self.editor_key(hwnd, code, &action, event.tick_ms, arrived, now);
            }
            Place::GoTo { dialog, excel } => {
                self.go_to_key(dialog, excel, &action, event.tick_ms, now);
            }
            Place::Field | Place::Blocked | Place::Sensitive => {}
        }
        self.mark_remote(event.foreground);
    }

    /// Keys that went to another computer, in a remote session's window or to the Remote Desktop
    /// control in any program, make a stretch that keeps no value (#113, #116): the stretch in
    /// `hwnd` is marked so when this key went there, though the ones before it didn't.
    fn mark_remote(&mut self, hwnd: isize) {
        let open = self
            .stretch
            .as_ref()
            .is_some_and(|stretch| stretch.hwnd == hwnd && !stretch.remote);
        if open
            && self.keys_to_remote(hwnd)
            && let Some(stretch) = self.stretch.as_mut()
        {
            stretch.remote = true;
        }
    }

    /// The window a key went to, named, with its class; `None` for one that has gone.
    fn window(&mut self, hwnd: isize) -> Option<(WindowInfo, String)> {
        let now = Instant::now();
        if let Some((at, known)) = self.windows.get(&hwnd)
            && now.duration_since(*at) < WINDOW_CACHE
        {
            return known.clone();
        }
        if self.windows.len() > 64 {
            self.windows.clear();
        }
        let found = self.desktop.window(hwnd);
        self.windows.insert(hwnd, (now, found.clone()));
        found
    }

    /// Where a key typed at `tick` into the window `hwnd` went.
    fn place(&mut self, hwnd: isize, tick: u32) -> Place {
        let Some((window, class)) = self.window(hwnd) else {
            // Go To closes as its Enter goes in, and keys are handled 150 ms on (#69).
            return match self.go_to {
                Some(arm) if arm.dialog == Some(hwnd) => Place::GoTo {
                    dialog: hwnd,
                    excel: arm.excel,
                },
                _ => Place::Blocked,
            };
        };
        if self.blocked(&window) {
            return Place::Blocked;
        }
        let found = match (
            place_in(&window, &class, &self.applied, &mut self.password),
            self.keys_went(tick, hwnd),
        ) {
            // The field with focus may not be where keys typed straight after a click went (#97):
            // they make a step of their own, with no value.
            (Place::Field, KeysWent::Unknown) => Place::Editor(window.hwnd, false),
            (_, KeysWent::Secret) => Place::Sensitive,
            (found, _) => found,
        };
        // After Ctrl+G or F5, the next window of Excel's that the keys go to is Go To (#69),
        // whose Reference box UI Automation may read as a field or not at all.
        if matches!(found, Place::Field | Place::Editor(..))
            && class != excel::WINDOW_CLASS
            && let Some(arm) = self.go_to.as_mut()
            && arm.pid == window.pid
            && window.hwnd != arm.excel
            && arm.dialog.is_none_or(|dialog| dialog == window.hwnd)
        {
            arm.dialog = Some(window.hwnd);
            return Place::GoTo {
                dialog: window.hwnd,
                excel: arm.excel,
            };
        }
        found
    }

    /// Whether nothing is kept from a window: one of Steps' own, an excluded app's, or one whose
    /// program can't be named while anything is excluded.
    fn blocked(&self, window: &WindowInfo) -> bool {
        window.pid == own_process_id() || crate::pipeline::is_excluded_window(&self.machine, window)
    }

    fn current_focus(&self) -> FocusNote {
        self.applied.clone()
    }

    /// Whether a click, a mouse press or focus news has been heard of since the key being
    /// handled: anything still waiting was heard after it. Windows says where the keyboard is
    /// now, not as of the key, so it isn't asked then (#61, #69).
    fn news_since_key(&self) -> bool {
        !self.pending_clicks.is_empty()
            || !self.waiting_presses.is_empty()
            || !self.pending_focus.is_empty()
    }

    fn combo_step(&mut self, combo: Combo, event: &KeyEvent) {
        let Some((window, _)) = self.window(event.foreground) else {
            return;
        };
        let key = self
            .desktop
            .typed_text(
                event.vkey,
                event.scan,
                Modifiers::default(),
                event.foreground,
            )
            .filter(|key| !key.trim().is_empty());
        let shot = self.shoot(&window);
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.options.mode));
        let record = Record::Keys(KeysRecord {
            id,
            tick_ms: event.tick_ms,
            window: window_facts(&window),
            capture,
            ctrl: combo.ctrl,
            alt: combo.alt,
            shift: combo.shift,
            win: combo.win,
            vkey: combo.vkey,
            key,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }

    /// Timed work: what has focus after fast typing and as a checked stretch goes on (#114, #117),
    /// formula-bar reads, photos after typing, terminal reads.
    fn tick(&mut self, now: Instant) {
        self.check_focus_after_keys(now);
        self.read_formula_bar(now);
        let shot_hwnd = self.stretch.as_ref().and_then(|stretch| {
            stretch
                .shot_due
                .is_some_and(|due| now >= due)
                .then_some(stretch.hwnd)
        });
        if let Some(hwnd) = shot_hwnd {
            let shot = self
                .window(hwnd)
                .and_then(|(window, _)| self.shoot(&window));
            if let Some(stretch) = self.stretch.as_mut() {
                stretch.shot_due = None;
                stretch.shot = shot;
            }
        }
        self.terminal_tick(now);
    }

    fn finish_all(&mut self, now: Instant) {
        self.handle_due(now, true);
        self.end_stretch(true);
        self.end_terminal();
        self.end_watch(Ended::Now, now);
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// A screenshot of a window, as a click's would be, with excluded apps hidden. `None` when a
    /// single monitor is being recorded and the window isn't on it, and while the recording isn't
    /// taking steps, as a click's is (`Output::shoot`, #112). Keys typed during a pause are
    /// dropped as they're handled, but a key typed just before one can reach the worker after
    /// it has noticed the pause, and its step's picture would be taken well into it. What was
    /// typed before a pause or Stop and is finished in the turn that notices it is shot while
    /// `was_active` still says the recording was taking steps: its step keeps its picture.
    fn shoot(&self, window: &WindowInfo) -> Option<Shot> {
        if !self.was_active {
            return None;
        }
        let excluded = self.lock_machine().excluded_apps().to_vec();
        self.desktop.shoot(window, &self.options, &excluded)
    }
}
