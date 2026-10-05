//! The key worker (docs/spec/02-capture.md#keys): turns the keys of a recording with "Record
//! what's typed" ticked into commands, typing and key combinations.
//!
//! It runs on its own thread, so reading a terminal or taking a screenshot never delays a click.
//! Keys are handled 150 ms after they arrive: UI Automation's focus news can trail the first key
//! typed into a field, and which field it is decides what happens (a password field's keys are
//! dropped). Clicks and focus changes are put in time order with the keys for the same reason.
//!
//! - **Terminals** (the classic console, Windows Terminal): Enter is the signal. The command and
//!   its output are read from the screen once the output has settled, and one screenshot is taken.
//! - **Excel**: what's typed into a cell is read from the formula bar.
//! - **Fields** whose value can be read when focus leaves them (the focus handler does that): their
//!   keys make no step of their own.
//! - **Anywhere else** (a code editor, a document): one step per stretch of typing, ended by a
//!   click, a focus change, a key combination or leaving the window.
//! - **Key combinations**, except the noise list, become steps of their own.
//!
//! Keys are never kept for Steps' own windows, excluded apps, or password and sensitive
//! fields, and nothing is kept from a pause.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::platform::input::{InputShared, KeyEvent};
use crate::platform::keyboard::{Modifiers, caps_lock_on, typed_text};
use crate::platform::window::{WindowInfo, own_process_id, window_class, window_info};
use image::{Rgba, RgbaImage};

use crate::coords::PxRect;
use crate::facts::{CaptureFacts, CommandRecord, ElementFacts, KeysRecord, Record, TypingRecord};
use crate::keys::{Combo, KeyAction, KeyReader};
use crate::pipeline::window_facts;
use crate::screen_text::{EXCEL_CLASS, ScreenText, TerminalKind};
use crate::screenshot::{CaptureMode, Shot, capture, hide_excluded};
use crate::secrets::{mask_command, mask_output};
use crate::sensitive::mask_value;
use crate::state_machine::{EventDecision, RecorderStateMachine};
use crate::terminal::{Shell, current_line, fit_output, read_command, split_prompt};

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
}

pub type SharedFocus = Arc<Mutex<FocusNote>>;

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

/// Whether focus news for a browser's address bar, in the window a stretch of typing is in, came
/// within `ADDRESS_BAR_LAG_MS` of the stretch's first key: then the keys were the address.
fn address_bar_took(note: &FocusNote, hwnd: isize, first_tick: u32) -> bool {
    note.address_bar
        && note.window == hwnd
        && note.tick_ms.wrapping_sub(first_tick) < ADDRESS_BAR_LAG_MS
}

/// A record the key worker made, with its screenshot.
pub type KeyedRecord = (Record, Option<RgbaImage>);

/// How long keys wait before they are handled, so focus news can catch up.
const KEY_DELAY: Duration = Duration::from_millis(150);
/// How late a browser's address bar can report focus after the typing into it began. Chrome often
/// reports it after the first key or two, which then look like typing on the page (testing,
/// 30/09/2026: "Type "o"" before the address was typed).
const ADDRESS_BAR_LAG_MS: u32 = 1_000;
/// How long after the last key a stretch of typing is photographed.
const SHOT_AFTER_KEYS: Duration = Duration::from_millis(400);
/// How soon after a key the terminal or formula bar is read again.
const READ_AFTER_KEYS: Duration = Duration::from_millis(120);
/// How often a terminal is read while its output is still arriving.
const OUTPUT_POLL: Duration = Duration::from_millis(250);
/// The longest a command's output is waited for.
const OUTPUT_LIMIT: Duration = Duration::from_secs(60);
/// How long a window's details are reused.
const WINDOW_CACHE: Duration = Duration::from_secs(2);
/// Record ids for key records: well clear of click ids, which count up from 1.
const FIRST_ID: u64 = 1 << 48;

/// Code editors: what's typed in them is code, and their editing surfaces aren't read as fields.
const CODE_EDITORS: &[&str] = &[
    "code.exe",
    "code - insiders.exe",
    "cursor.exe",
    "windsurf.exe",
    "devenv.exe",
    "notepad++.exe",
    "sublime_text.exe",
    "powershell_ise.exe",
    "ssms.exe",
    "azuredatastudio.exe",
    "idea64.exe",
    "pycharm64.exe",
    "webstorm64.exe",
    "rider64.exe",
    "clion64.exe",
    "goland64.exe",
    "phpstorm64.exe",
    "datagrip64.exe",
    "zed.exe",
];

/// Whether a program is a code editor (see [`CODE_EDITORS`]).
#[must_use]
pub fn is_code_editor(exe: &str) -> bool {
    CODE_EDITORS
        .iter()
        .any(|editor| editor.eq_ignore_ascii_case(exe))
}

/// The running key worker. Stopping it finishes what's in progress first.
pub struct KeyWorker {
    stop: Arc<AtomicBool>,
    clicks: Arc<ClickNews>,
    thread: Option<JoinHandle<()>>,
}

/// Clicks, as the click pipeline reports them: each one ends a stretch of typing.
#[derive(Debug, Default)]
pub struct ClickNews {
    count: AtomicU64,
    tick: AtomicU32,
}

impl ClickNews {
    /// Called by the click pipeline for every click it records.
    pub fn note(&self, tick_ms: u32) {
        self.tick.store(tick_ms, Ordering::SeqCst);
        self.count.fetch_add(1, Ordering::SeqCst);
    }
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
        let last_focus = applied.generation;
        let thread = std::thread::Builder::new()
            .name("amluto-keys".into())
            .spawn(move || {
                // Built here: UI Automation objects stay on the thread that made them.
                Worker {
                    shared,
                    machine,
                    focus,
                    options,
                    out,
                    stop: worker_stop,
                    clicks: worker_clicks,
                    reader: KeyReader::new(caps_lock),
                    text: ScreenText::new(),
                    windows: HashMap::new(),
                    pending: VecDeque::new(),
                    pending_click: None,
                    last_clicks: 0,
                    pending_focus: None,
                    last_focus,
                    applied,
                    excel_cells: HashMap::new(),
                    stretch: None,
                    terminal: None,
                    next_id: FIRST_ID,
                    was_active: true,
                    keys_dropped: 0,
                }
                .run();
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

/// Where a key went.
#[derive(Debug, Clone)]
enum Place {
    /// Our own windows, an excluded app, or a window that can't be named: nothing is kept.
    Blocked,
    /// A password or sensitive field: nothing is kept.
    Sensitive,
    /// A field that is read when focus leaves it.
    Field,
    Terminal(isize, TerminalKind),
    Excel(isize),
    /// Somewhere with no field to read: typing becomes a step of its own.
    Editor(isize, bool),
}

/// A stretch of typing in one place.
struct Stretch {
    hwnd: isize,
    excel: bool,
    code: bool,
    first_tick: u32,
    text: String,
    approximate: bool,
    element: Option<ElementFacts>,
    cell: Option<String>,
    /// The formula bar's last reading, and how much had been typed when it was taken.
    bar: Option<(String, usize)>,
    bar_due: Option<Instant>,
    shot: Option<Shot>,
    shot_due: Option<Instant>,
    focus_generation: u64,
}

/// Commands typed into one terminal window.
struct TerminalSession {
    hwnd: isize,
    kind: TerminalKind,
    /// The line the cursor was on with nothing typed yet.
    idle_line: Option<String>,
    /// Characters typed since the last Enter.
    typed: usize,
    /// The screen read shortly after the latest key.
    screen: Option<String>,
    read_due: Option<Instant>,
    awaiting: Option<Awaiting>,
}

/// A command whose output is being waited for.
struct Awaiting {
    enter_tick: u32,
    before: Option<String>,
    typed: usize,
    idle_line: Option<String>,
    last_screen: Option<String>,
    last_change: Instant,
    next_poll: Instant,
    started: Instant,
}

struct Worker {
    shared: Arc<InputShared>,
    machine: Arc<Mutex<RecorderStateMachine>>,
    focus: SharedFocus,
    options: KeyOptions,
    out: Sender<KeyedRecord>,
    stop: Arc<AtomicBool>,
    clicks: Arc<ClickNews>,
    reader: KeyReader,
    text: Option<ScreenText>,
    windows: HashMap<isize, (Instant, Option<(WindowInfo, String)>)>,
    pending: VecDeque<(Instant, KeyEvent)>,
    pending_click: Option<(Instant, u32)>,
    last_clicks: u64,
    pending_focus: Option<(Instant, FocusNote)>,
    last_focus: u64,
    /// Where focus was as of the keys handled so far: focus changes applied in time order with
    /// the keys. Never the latest focus, which may already have moved on: two digits of a PIN
    /// typed just before a click on a checkbox were recorded as typed into the checkbox.
    applied: FocusNote,
    excel_cells: HashMap<isize, String>,
    stretch: Option<Stretch>,
    terminal: Option<TerminalSession>,
    next_id: u64,
    was_active: bool,
    keys_dropped: u64,
}

impl Worker {
    fn run(mut self) {
        loop {
            let stopping = self.stop.load(Ordering::SeqCst);
            let now = Instant::now();
            while let Some(event) = self.shared.pop_key() {
                self.pending.push_back((now, event));
            }
            let dropped = self.shared.keys_dropped.load(Ordering::Relaxed);
            if dropped != self.keys_dropped {
                self.keys_dropped = dropped;
                if let Some(stretch) = self.stretch.as_mut() {
                    stretch.approximate = true;
                }
            }
            self.take_news(now);
            self.handle_due(now, stopping);

            let active = self.lock_machine().is_active();
            if !active && self.was_active {
                // Pause: what was typed so far is kept; nothing typed during the pause is.
                self.finish_all();
                self.reader.reset();
                self.pending.clear();
            }
            self.was_active = active;
            if stopping {
                self.finish_all();
                break;
            }
            self.tick(Instant::now());
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn lock_machine(&self) -> std::sync::MutexGuard<'_, RecorderStateMachine> {
        self.machine.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Notes new clicks and focus changes, to be applied in time order with the keys.
    fn take_news(&mut self, now: Instant) {
        let clicks = self.clicks.count.load(Ordering::SeqCst);
        if clicks != self.last_clicks {
            self.last_clicks = clicks;
            self.pending_click = Some((now, self.clicks.tick.load(Ordering::SeqCst)));
        }
        let note = self
            .focus
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if note.generation != self.last_focus {
            self.last_focus = note.generation;
            self.pending_focus = Some((now, note));
        }
    }

    /// Handles keys, clicks and focus changes that have waited long enough, oldest first.
    fn handle_due(&mut self, now: Instant, all: bool) {
        loop {
            let key_at = self.pending.front().map(|(at, _)| *at);
            let click = self.pending_click;
            let focus_at = self.pending_focus.as_ref().map(|(seen, _)| *seen);
            let due = |at: Instant| all || now.duration_since(at) >= KEY_DELAY;

            // A click ends typing: keys typed before it are handled first (by tick).
            if let Some((seen, tick)) = click {
                let key_before = self.pending.front().is_some_and(|(_, key)| {
                    crate::state_machine::tick_before_or_at(key.tick_ms, tick)
                });
                if !key_before && due(seen) {
                    self.pending_click = None;
                    self.end_stretch(true);
                    continue;
                }
            }
            if let Some(seen) = focus_at
                && key_at.is_none_or(|at| seen <= at)
                && due(seen)
            {
                if let Some((_, note)) = self.pending_focus.take() {
                    self.applied = note.clone();
                    self.focus_moved(&note);
                }
                continue;
            }
            match key_at {
                Some(at) if due(at) => {
                    if let Some((_, event)) = self.pending.pop_front() {
                        self.on_key(&event);
                    }
                }
                _ => break,
            }
        }
    }

    fn on_key(&mut self, event: &KeyEvent) {
        let Some(action) = self.reader.read(event, typed_text) else {
            return;
        };
        if self.lock_machine().should_process_event(event.tick_ms) != EventDecision::Process {
            return;
        }
        let place = self.place(event.foreground);
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
            if combo.is_noise() {
                return;
            }
            self.end_stretch(true);
            self.combo_step(*combo, event);
            return;
        }
        // Typing somewhere else ends a stretch here.
        let here = match &place {
            Place::Terminal(hwnd, _) | Place::Excel(hwnd) | Place::Editor(hwnd, _) => Some(*hwnd),
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
            Place::Terminal(hwnd, kind) => self.terminal_key(hwnd, kind, &action, event.tick_ms),
            Place::Excel(hwnd) => self.excel_key(hwnd, &action, event.tick_ms),
            Place::Editor(hwnd, code) => self.editor_key(hwnd, code, &action, event.tick_ms),
            Place::Field | Place::Blocked | Place::Sensitive => {}
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
        let found = window_info(hwnd).map(|window| {
            let class = window_class(window.hwnd).unwrap_or_default();
            (window, class)
        });
        self.windows.insert(hwnd, (now, found.clone()));
        found
    }

    fn place(&mut self, hwnd: isize) -> Place {
        let Some((window, class)) = self.window(hwnd) else {
            return Place::Blocked;
        };
        if window.pid == own_process_id() {
            return Place::Blocked;
        }
        {
            let machine = self.lock_machine();
            let excluded = match window.exe_name() {
                Some(name) => machine.is_app_excluded(name),
                None => !machine.excluded_apps().is_empty(),
            };
            if excluded {
                return Place::Blocked;
            }
        }
        // A window or dialog titled for a password ("Set Password", "Passwort ändern"): what's
        // typed there is kept out even when the field itself doesn't say it's one, as
        // LibreOffice's password boxes don't (F021, 01/10/2026).
        if crate::sensitive::looks_sensitive(&[window.title.as_str()], &[]) {
            return Place::Sensitive;
        }
        // A password box anywhere in the window, Excel's and terminals' too (an add-in's sign-in
        // pane is inside Excel's window), before what kind of window it is.
        let note = self.applied.clone();
        let note_here = note.window == window.hwnd;
        if note_here && (note.facts.sensitive || note.facts.is_password) {
            return Place::Sensitive;
        }
        if let Some(kind) = TerminalKind::from_class(&class) {
            return Place::Terminal(window.hwnd, kind);
        }
        if class == EXCEL_CLASS {
            return Place::Excel(window.hwnd);
        }
        let code = window.exe_name().is_some_and(is_code_editor);
        if note_here && note.field && !code {
            return Place::Field;
        }
        Place::Editor(window.hwnd, code)
    }

    fn focus_moved(&mut self, note: &FocusNote) {
        if note.facts.class_name == "XLSpreadsheetCell" && !note.facts.name.is_empty() {
            if self.excel_cells.len() > 16 {
                self.excel_cells.clear();
            }
            self.excel_cells
                .insert(note.window, note.facts.name.clone());
        }
        let Some(stretch) = self.stretch.as_ref() else {
            return;
        };
        // Focus went into a password field in the middle of the stretch (in Excel's window too: an
        // add-in's sign-in pane): the keys since may be the password, so none of it is kept.
        if stretch.focus_generation != note.generation
            && note.window == stretch.hwnd
            && (note.facts.sensitive || note.facts.is_password)
        {
            self.stretch = None;
            return;
        }
        // In Excel, focus moves between the cell and its editor while typing; the stretch ends at
        // Enter, Tab, a click or another window instead.
        if stretch.excel && note.window == stretch.hwnd {
            return;
        }
        if stretch.focus_generation != note.generation {
            // The address bar said it had focus only after this stretch began: its keys went there.
            if address_bar_took(note, stretch.hwnd, stretch.first_tick) {
                self.stretch = None;
                return;
            }
            self.end_stretch(true);
        }
    }

    fn current_focus(&self) -> FocusNote {
        self.applied.clone()
    }

    // ---------- terminals ----------

    fn terminal_key(&mut self, hwnd: isize, kind: TerminalKind, action: &KeyAction, tick: u32) {
        let now = Instant::now();
        let awaiting = self
            .terminal
            .get_or_insert(TerminalSession {
                hwnd,
                kind,
                idle_line: None,
                typed: 0,
                screen: None,
                read_due: Some(now),
                awaiting: None,
            })
            .awaiting
            .is_some();
        // Typing the next command means the last one's output is as complete as it will be.
        if awaiting && matches!(action, KeyAction::Text(_) | KeyAction::Enter) {
            self.finish_command();
        }
        let Some(session) = self.terminal.as_mut() else {
            return;
        };
        match action {
            KeyAction::Enter => {
                session.awaiting = Some(Awaiting {
                    enter_tick: tick,
                    before: session.screen.take(),
                    typed: session.typed,
                    idle_line: session.idle_line.clone(),
                    last_screen: None,
                    last_change: now,
                    next_poll: now + OUTPUT_POLL,
                    started: now,
                });
                session.typed = 0;
                session.read_due = None;
            }
            KeyAction::Text(text) => {
                session.typed += text.chars().count();
                session.read_due.get_or_insert(now + READ_AFTER_KEYS);
            }
            _ => {
                session.read_due.get_or_insert(now + READ_AFTER_KEYS);
            }
        }
    }

    /// Reads the terminal's screen and, while a command's output is arriving, checks whether it
    /// has settled.
    fn terminal_tick(&mut self, now: Instant) {
        let Some(session) = self.terminal.as_mut() else {
            return;
        };
        let (hwnd, kind) = (session.hwnd, session.kind);
        if session.read_due.is_some_and(|due| now >= due) {
            session.read_due = None;
            let screen = self
                .text
                .as_ref()
                .and_then(|text| text.terminal(hwnd, kind));
            if let Some(session) = self.terminal.as_mut() {
                if session.idle_line.is_none() && session.awaiting.is_none() {
                    session.idle_line = screen.as_deref().and_then(current_line);
                }
                session.screen = screen;
            }
        }
        let settle = self.options.settle;
        let Some(awaiting) = self
            .terminal
            .as_mut()
            .and_then(|session| session.awaiting.as_mut())
        else {
            return;
        };
        if now < awaiting.next_poll {
            return;
        }
        awaiting.next_poll = now + OUTPUT_POLL;
        let screen = self
            .text
            .as_ref()
            .and_then(|text| text.terminal(hwnd, kind));
        let Some(awaiting) = self
            .terminal
            .as_mut()
            .and_then(|session| session.awaiting.as_mut())
        else {
            return;
        };
        if screen != awaiting.last_screen {
            awaiting.last_screen = screen;
            awaiting.last_change = now;
        }
        let settled =
            awaiting.last_screen.is_some() && now.duration_since(awaiting.last_change) >= settle;
        if settled || now.duration_since(awaiting.started) >= OUTPUT_LIMIT {
            self.finish_command();
        }
    }

    /// Makes the step for the command being waited for, from the screen as it is now.
    fn finish_command(&mut self) {
        let Some(session) = self.terminal.as_mut() else {
            return;
        };
        let Some(awaiting) = session.awaiting.take() else {
            return;
        };
        let (hwnd, kind) = (session.hwnd, session.kind);
        let screen = self
            .text
            .as_ref()
            .and_then(|text| text.terminal(hwnd, kind))
            .or(awaiting.last_screen);
        let Some(screen) = screen else {
            return;
        };
        if let Some(session) = self.terminal.as_mut() {
            session.idle_line = current_line(&screen);
            session.screen = None;
        }
        let Some(command) = read_command(awaiting.before.as_deref(), &screen) else {
            return;
        };
        if command.command.trim().is_empty() {
            return;
        }
        // A hidden prompt (a password being typed) shows nothing of what was typed: the line
        // before Enter is the line before typing.
        let before_line = awaiting.before.as_deref().and_then(current_line);
        if awaiting.typed >= 2 && before_line.is_some() && before_line == awaiting.idle_line {
            return;
        }
        if looks_like_masked_entry(&command.command) {
            return;
        }
        let Some((window, _)) = self.window(hwnd) else {
            return;
        };
        // Enter at a line with no shell prompt answers a program ("Name: sam", "PIN: ****"): not
        // a new command. A starred answer is dropped; a visible one reads as typing.
        if let Some(line) = before_line.as_deref()
            && split_prompt(line).is_none()
        {
            // Nor one to a question about a password or key ("Enter password: hunter2", from
            // Read-Host or input()): shown on screen, but never kept as text in the guide.
            if !looks_like_masked_entry(line) && !crate::sensitive::looks_sensitive(&[line], &[]) {
                self.reply_step(&window, line, awaiting.enter_tick);
            }
            return;
        }
        let shell = match command.shell {
            Shell::Unknown if kind == TerminalKind::Console => {
                window.exe_name().map_or(Shell::Unknown, Shell::from_exe)
            }
            shell => shell,
        };
        let masked = mask_command(&command.command, &self.options.extra_terms);
        let (output, shortened) = if self.options.output {
            let (text, cut) = fit_output(&command.output);
            (
                Some(mask_output(&text, &masked.secrets)),
                cut || command.output_cut,
            )
        } else {
            (None, false)
        };
        let mut shot = self.shoot(&window);
        let check_screenshot = shot
            .as_mut()
            .is_some_and(|shot| !blur_secrets(shot, &masked.secrets));
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| capture_facts(shot, self.options.mode));
        let record = Record::Command(CommandRecord {
            id,
            tick_ms: awaiting.enter_tick,
            window: window_facts(&window),
            capture,
            terminal: kind.as_str(),
            language: shell.language(),
            command: masked.text,
            output,
            output_shortened: shortened,
            check_screenshot,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }

    /// An answer typed at a program's own prompt in a terminal, as a typing step: `Type "sam"`.
    fn reply_step(&mut self, window: &WindowInfo, line: &str, tick: u32) {
        let answer = reply_text(line);
        if answer.is_empty() {
            return;
        }
        let shot = self.shoot(window);
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| capture_facts(shot, self.options.mode));
        let record = Record::Typing(TypingRecord {
            id,
            tick_ms: tick,
            window: window_facts(window),
            capture,
            element: None,
            text: mask_value(answer),
            form: "text",
            language: "plain",
            cell: None,
            approximate: false,
            check_screenshot: false,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }

    fn end_terminal(&mut self) {
        self.finish_command();
        self.terminal = None;
    }

    // ---------- Excel ----------

    fn excel_key(&mut self, hwnd: isize, action: &KeyAction, tick: u32) {
        let now = Instant::now();
        match action {
            KeyAction::Text(text) => {
                if self.stretch.is_none() {
                    let cell = self.excel_cells.get(&hwnd).cloned();
                    self.stretch = Some(self.new_stretch(hwnd, tick, true, false, cell));
                }
                if let Some(stretch) = self.stretch.as_mut() {
                    stretch.text.push_str(text);
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
            // Enter, Tab and the arrows put what was typed into the cell.
            KeyAction::Enter | KeyAction::Tab | KeyAction::Move => self.end_stretch(true),
            // Escape throws it away, in Excel as here.
            KeyAction::Escape => self.stretch = None,
            KeyAction::Other | KeyAction::Combo(_) => {}
        }
    }

    // ---------- everywhere else ----------

    fn editor_key(&mut self, hwnd: isize, code: bool, action: &KeyAction, tick: u32) {
        let now = Instant::now();
        let starts = matches!(action, KeyAction::Text(_));
        if self.stretch.is_none() && starts {
            let element = {
                let note = self.current_focus();
                (note.window == hwnd).then_some(note.facts)
            };
            let cell = element.as_ref().and_then(cell_name);
            let mut stretch = self.new_stretch(hwnd, tick, false, code, cell);
            stretch.element = element;
            self.stretch = Some(stretch);
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
        match action {
            KeyAction::Text(text) => stretch.text.push_str(text),
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

    fn new_stretch(
        &self,
        hwnd: isize,
        tick: u32,
        excel: bool,
        code: bool,
        cell: Option<String>,
    ) -> Stretch {
        Stretch {
            hwnd,
            excel,
            code,
            first_tick: tick,
            text: String::new(),
            approximate: false,
            element: None,
            cell,
            bar: None,
            bar_due: None,
            shot: None,
            shot_due: None,
            focus_generation: self.last_focus,
        }
    }

    /// Ends the stretch of typing, making its step (`keep`) or dropping it.
    fn end_stretch(&mut self, keep: bool) {
        let Some(mut stretch) = self.stretch.take() else {
            return;
        };
        if !keep {
            return;
        }
        let text = if stretch.excel {
            excel_text(&stretch)
        } else {
            stretch.text.trim_end().to_string()
        };
        if text.trim().is_empty() {
            return;
        }
        let Some((window, _)) = self.window(stretch.hwnd) else {
            return;
        };
        let formula = (stretch.excel || stretch.cell.is_some()) && text.starts_with('=');
        let (text, secrets) = if stretch.code || formula {
            let masked = mask_command(&text, &self.options.extra_terms);
            (masked.text, masked.secrets)
        } else {
            (mask_value(&text), Vec::new())
        };
        // The photo taken after the last key, or one now.
        let taken_after_keys = stretch.shot_due.is_none();
        let mut shot = match stretch.shot.take() {
            Some(shot) if taken_after_keys => Some(shot),
            _ => self.shoot(&window),
        };
        let check_screenshot = shot
            .as_mut()
            .is_some_and(|shot| !blur_secrets(shot, &secrets));
        let (form, language) = if formula {
            ("formula", "excel")
        } else if stretch.code {
            ("code", "plain")
        } else {
            ("text", "plain")
        };
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| capture_facts(shot, self.options.mode));
        let record = Record::Typing(TypingRecord {
            id,
            tick_ms: stretch.first_tick,
            window: window_facts(&window),
            capture,
            element: stretch.element.take(),
            text,
            form,
            language,
            cell: stretch.cell.take(),
            approximate: stretch.approximate,
            check_screenshot,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }

    fn combo_step(&mut self, combo: Combo, event: &KeyEvent) {
        let Some((window, _)) = self.window(event.foreground) else {
            return;
        };
        let key = typed_text(
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
            .map(|shot| capture_facts(shot, self.options.mode));
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

    /// Timed work: formula-bar reads, photos after typing, terminal reads.
    fn tick(&mut self, now: Instant) {
        let bar_hwnd = self.stretch.as_ref().and_then(|stretch| {
            (stretch.excel && stretch.bar_due.is_some_and(|due| now >= due)).then_some(stretch.hwnd)
        });
        if let Some(hwnd) = bar_hwnd {
            let reading = self.text.as_mut().and_then(|text| text.formula_bar(hwnd));
            if let Some(stretch) = self.stretch.as_mut() {
                stretch.bar_due = None;
                if let Some(reading) = reading.filter(|reading| !reading.is_empty()) {
                    stretch.bar = Some((reading, stretch.text.chars().count()));
                }
            }
        }
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

    fn finish_all(&mut self) {
        self.handle_due(Instant::now(), true);
        self.end_stretch(true);
        self.end_terminal();
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// A screenshot of a window, as a click's would be, with excluded apps hidden. `None` when a
    /// single monitor is being recorded and the window isn't on it.
    fn shoot(&self, window: &WindowInfo) -> Option<Shot> {
        let frame = PxRect::from(window.frame);
        let x = frame.left + (frame.right - frame.left) / 2;
        let y = frame.top + (frame.bottom - frame.top) / 2;
        if self
            .options
            .target_monitor
            .is_some_and(|monitor| !monitor.contains(x, y))
        {
            return None;
        }
        let mut shot = capture(
            self.options.mode,
            Some(frame),
            x,
            y,
            self.options.target_monitor,
        )
        .ok()?;
        if self.options.mode == crate::screenshot::CaptureMode::Window {
            // The Start menu, Search and the like are drawn by several shell processes:
            // their own parts aren't someone else's window to grey out (04/10/2026).
            if !crate::pipeline::is_shell_window(window) {
                crate::screenshot::hide_covering(&mut shot, window.pid, None);
            }
        }
        let excluded = self.lock_machine().excluded_apps().to_vec();
        hide_excluded(&mut shot, &excluded);
        Some(shot)
    }
}

/// What was typed into an Excel cell: the formula bar's last reading, plus any keys typed after
/// it was taken; the keys alone if the bar couldn't be read.
/// A spreadsheet cell's reference ("B6"), when the element with focus is one.
pub(crate) fn cell_name(facts: &ElementFacts) -> Option<String> {
    let name = facts.name.trim().replace('$', "");
    let letters = name.chars().take_while(char::is_ascii_uppercase).count();
    let digits = name
        .chars()
        .skip(letters)
        .take_while(char::is_ascii_digit)
        .count();
    let cellish = matches!(
        facts.control_type.as_str(),
        "DataItem" | "ListItem" | "Edit" | "Custom" | "Text"
    );
    (cellish
        && (1..=3).contains(&letters)
        && (1..=7).contains(&digits)
        && letters + digits == name.chars().count())
    .then_some(name)
}

fn excel_text(stretch: &Stretch) -> String {
    let Some((reading, typed_then)) = &stretch.bar else {
        return stretch.text.clone();
    };
    let typed_now = stretch.text.chars().count();
    if typed_now >= *typed_then {
        let later: String = stretch.text.chars().skip(*typed_then).collect();
        format!("{reading}{later}")
    } else {
        let keep = reading
            .chars()
            .count()
            .saturating_sub(typed_then - typed_now);
        reading.chars().take(keep).collect()
    }
}

/// The answer part of a reply line: what follows the program's question (`Name: sam` → `sam`).
fn reply_text(line: &str) -> &str {
    line.rsplit_once(": ")
        .map_or(line, |(_, answer)| answer)
        .trim()
}

/// A reply to a prompt that the terminal shows only as stars (`Password: ********`).
fn looks_like_masked_entry(line: &str) -> bool {
    let entry = line.rsplit(':').next().unwrap_or(line).trim();
    !entry.is_empty() && entry.chars().all(|ch| matches!(ch, '*' | '•' | '●'))
}

fn capture_facts(shot: &Shot, mode: CaptureMode) -> CaptureFacts {
    CaptureFacts {
        mode: mode.as_str(),
        rect: shot.rect,
        monitor: shot.monitor,
        scale: shot.scale,
        width: shot.image.width(),
        height: shot.image.height(),
        image: None,
    }
}

/// Hides each secret in the screenshot where on-PC text recognition finds it. Returns `false` if
/// any secret couldn't be found (the step is then flagged "check this screenshot"). The text read
/// is used only here and forgotten.
fn blur_secrets(shot: &mut Shot, secrets: &[String]) -> bool {
    let secrets: Vec<String> = secrets
        .iter()
        .map(|secret| secret.split_whitespace().collect::<String>())
        .filter(|secret| !secret.is_empty())
        .collect();
    if secrets.is_empty() {
        return true;
    }
    let (width, height) = (shot.image.width(), shot.image.height());
    let mut bgra = shot.image.as_raw().clone();
    for pixel in bgra.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let Ok(lines) = crate::platform::ocr::recognize(&bgra, width, height) else {
        return false;
    };
    let mut all_found = true;
    for secret in &secrets {
        let mut found = false;
        for line in &lines {
            // The line's words run together, so a secret OCR splits into two words still matches.
            let mut joined = String::new();
            let mut spans = Vec::with_capacity(line.len());
            for word in line {
                let start = joined.len();
                joined.push_str(&word.text);
                spans.push((start, joined.len()));
            }
            let mut from = 0;
            while let Some(at) = joined[from..].find(secret.as_str()) {
                let start = from + at;
                let end = start + secret.len();
                for (word, (word_start, word_end)) in line.iter().zip(&spans) {
                    if *word_end > start && *word_start < end {
                        cover(&mut shot.image, word.x, word.y, word.width, word.height);
                    }
                }
                found = true;
                from = end;
            }
        }
        all_found &= found;
    }
    all_found
}

/// Covers a box (with a small margin) in its average colour: nothing of the text is left.
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "OCR boxes are small, non-negative pixel positions inside the image"
)]
fn cover(image: &mut RgbaImage, x: f32, y: f32, width: f32, height: f32) {
    const MARGIN: f32 = 3.0;
    let left = (x - MARGIN).max(0.0) as u32;
    let top = (y - MARGIN).max(0.0) as u32;
    let right = ((x + width + MARGIN) as u32).min(image.width());
    let bottom = ((y + height + MARGIN) as u32).min(image.height());
    if right <= left || bottom <= top {
        return;
    }
    let mut sum = [0u64; 3];
    let mut count = 0u64;
    for py in top..bottom {
        for px in left..right {
            let pixel = image.get_pixel(px, py);
            for (total, channel) in sum.iter_mut().zip(pixel.0) {
                *total += u64::from(channel);
            }
            count += 1;
        }
    }
    let average = |total: u64| u8::try_from(total / count.max(1)).unwrap_or(0);
    let fill = Rgba([average(sum[0]), average(sum[1]), average(sum[2]), 255]);
    for py in top..bottom {
        for px in left..right {
            image.put_pixel(px, py, fill);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stretch(text: &str, bar: Option<(&str, usize)>) -> Stretch {
        Stretch {
            hwnd: 1,
            excel: true,
            code: false,
            first_tick: 0,
            text: text.to_string(),
            approximate: false,
            element: None,
            cell: Some("B6".into()),
            bar: bar.map(|(reading, typed)| (reading.to_string(), typed)),
            bar_due: None,
            shot: None,
            shot_due: None,
            focus_generation: 0,
        }
    }

    #[test]
    fn cells_are_named_by_their_reference() {
        let cell = |control: &str, name: &str| ElementFacts {
            control_type: control.into(),
            name: name.into(),
            ..ElementFacts::default()
        };
        assert_eq!(cell_name(&cell("DataItem", "B6")), Some("B6".into()));
        assert_eq!(cell_name(&cell("Custom", "$AA$120")), Some("AA120".into()));
        assert_eq!(cell_name(&cell("Edit", "Name")), None);
        assert_eq!(cell_name(&cell("Button", "A1")), None);
        assert_eq!(cell_name(&cell("DataItem", "ABCD1")), None);
    }

    #[test]
    fn excel_text_comes_from_the_formula_bar_and_later_keys() {
        // F2 on an existing formula: the bar has all of it, the keys only the change.
        assert_eq!(
            excel_text(&stretch("+1", Some(("=SUM(B2:B3)+", 1)))),
            "=SUM(B2:B3)+1"
        );
        assert_eq!(excel_text(&stretch("=B2*3", Some(("=B2*3", 5)))), "=B2*3");
        // Backspaced after the reading.
        assert_eq!(excel_text(&stretch("=B2", Some(("=B2*", 4)))), "=B2");
        // No reading: the keys.
        assert_eq!(excel_text(&stretch("Q3 total", None)), "Q3 total");
    }

    #[test]
    fn starred_replies_are_not_commands() {
        assert!(looks_like_masked_entry("Password: ********"));
        assert!(looks_like_masked_entry("Enter PIN: ••••"));
        assert!(!looks_like_masked_entry("Get-Date"));
        assert!(!looks_like_masked_entry("Get-ChildItem *"));
        assert!(!looks_like_masked_entry("Password:"));
    }

    #[test]
    fn replies_to_a_program_keep_just_the_answer() {
        assert_eq!(reply_text("Name: sam"), "sam");
        assert_eq!(reply_text("Continue? [Y] Yes  [N] No: Y"), "Y");
        assert_eq!(reply_text("yes"), "yes");
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

    #[test]
    fn code_editors_are_known() {
        assert!(is_code_editor("Code.exe"));
        assert!(is_code_editor("devenv.exe"));
        assert!(!is_code_editor("notepad.exe"));
        assert!(!is_code_editor("chrome.exe"));
    }

    #[test]
    fn a_covered_box_keeps_nothing_of_the_text() {
        let mut image = RgbaImage::from_pixel(40, 20, Rgba([255, 255, 255, 255]));
        image.put_pixel(10, 10, Rgba([0, 0, 0, 255]));
        cover(&mut image, 8.0, 8.0, 4.0, 4.0);
        let covered = image.get_pixel(10, 10);
        assert_eq!(covered, image.get_pixel(6, 6), "one flat colour");
        assert_eq!(
            image.get_pixel(0, 0),
            &Rgba([255, 255, 255, 255]),
            "outside untouched"
        );
    }
}
