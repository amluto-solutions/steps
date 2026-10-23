//! Where keys go and the typing step they make (docs/spec/02-capture.md#keys): the place a key's
//! window and the focus put it in, the password guard that keeps a window's keys out once a
//! password box has had focus there (10/10/2026), and a stretch of typing in one place, with
//! what it keeps (masked, or withheld when where the keys went can't be trusted) and its step.
//! One reason to change: what a stretch of typing is, keeps or ends at.

use std::time::Instant;

use crate::excel::{self, cell_name};
use crate::facts::{CaptureFacts, ElementFacts, Record, TypingRecord, WindowFacts};
use crate::platform::window::WindowInfo;
use crate::programs::{
    is_code_editor, is_remote_input, is_remote_input_class, is_remote_window, window_facts,
};
use crate::screen_text::TerminalKind;
use crate::screenshot::Shot;
use crate::secrets::{blur_secrets, mask_command};
use crate::sensitive::mask_value;

use super::focus_check::FocusCheck;
use super::{
    BarReading, Desktop, FocusNote, GoesTo, Worker, address_bar_took, another_program, excel_entry,
};

/// Where a key went.
#[derive(Debug, Clone)]
pub(super) enum Place {
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
    /// Excel's Go To dialog, opened by Ctrl+G or F5 in the workbook window `excel` (#69).
    GoTo {
        dialog: isize,
        excel: isize,
    },
}

/// A window where a password or sensitive element has had focus since the last click
/// (10/10/2026). Nothing typed there is kept until a click or typing in another window, even when
/// UI Automation later names an element that isn't a password box: a notification took focus from
/// Word's "Encrypt Document" password box, and the password was recorded as typing.
#[derive(Debug, Default)]
pub(super) struct PasswordGuard {
    window: Option<isize>,
    /// [`FocusNote::passwords`] as last seen.
    seen: u64,
}

impl PasswordGuard {
    pub(super) fn starting(note: &FocusNote) -> Self {
        Self {
            window: note.secret().then_some(note.window),
            seen: note.passwords,
        }
    }

    /// A focus change was applied: a password box had focus if this one is, or if one was
    /// focused since the last note applied, even when this note replaced it.
    pub(super) fn focus_applied(&mut self, note: &FocusNote) {
        if note.passwords != self.seen {
            self.seen = note.passwords;
            self.window = Some(note.password_window);
        }
        if note.secret() {
            self.window = Some(note.window);
        }
    }

    /// A click ends the stretch the password was in, unless focus is still in a password box.
    pub(super) fn clicked(&mut self, applied: &FocusNote) {
        self.window = applied.secret().then_some(applied.window);
    }

    /// A click in `window` went into a box that says it holds a password, as its lookup found,
    /// or may have left focus in one: the window is kept out until the next click, as when a
    /// password box's focus news comes (#97 third review).
    pub(super) fn clicked_into(&mut self, window: isize) {
        self.window = Some(window);
    }

    /// The window kept out, if any.
    pub(super) fn window(&self) -> Option<isize> {
        self.window
    }

    /// Keys went to `hwnd`: whether they are kept out. Typing in another window ends the guard.
    fn typing_in(&mut self, hwnd: isize) -> bool {
        if self.window.is_some_and(|window| window != hwnd) {
            self.window = None;
        }
        self.covers(hwnd)
    }

    pub(super) fn covers(&self, hwnd: isize) -> bool {
        self.window == Some(hwnd)
    }
}

/// A stretch of typing in one place.
#[allow(
    clippy::struct_excessive_bools,
    reason = "each is a separate fact about the stretch, not states of one thing"
)]
pub(super) struct Stretch {
    pub(super) hwnd: isize,
    pub(super) excel: bool,
    pub(super) code: bool,
    pub(super) first_tick: u32,
    pub(super) text: String,
    pub(super) approximate: bool,
    pub(super) element: Option<ElementFacts>,
    pub(super) cell: Option<String>,
    /// The formula bar's last reading that the keys can be held up against.
    pub(super) bar: Option<BarReading>,
    /// A reading taken in the last turn, held up against the keys once the keys that came in
    /// since show none was typed before it.
    pub(super) bar_unchecked: Option<BarReading>,
    pub(super) bar_due: Option<Instant>,
    pub(super) shot: Option<Shot>,
    pub(super) shot_due: Option<Instant>,
    pub(super) focus_generation: u64,
    /// Where the keys went can't be trusted (no element of this window had focus, another
    /// program's element took focus part-way through, or a file dialog's pane had it and its
    /// File name box couldn't be confirmed, #61): the step keeps no value (10/10/2026).
    pub(super) withheld: bool,
    /// Typed into Excel's Name Box or Go To's Reference box, to go to a cell (#69).
    pub(super) goes_to: Option<GoesTo>,
    /// Another program typed some of it as Unicode packets (auto-type): the step keeps no value
    /// (11/10/2026, #91).
    pub(super) packets: bool,
    /// The click before it couldn't say where its keys went, and the text box with focus is
    /// watched for dictation: the box, whose text, read again as the stretch ends, says whether
    /// they went there (#97 third review).
    pub(super) unconfirmed: Option<Unconfirmed>,
    /// The click before it couldn't say what it went to: UI Automation's word on the element
    /// with focus as its keys arrive and are handled (#97 fourth review, #117).
    pub(super) focus_check: Option<FocusCheck>,
    /// In Excel, the click before it couldn't say what it went to (its lookup failed, or a press
    /// nothing is known of): the value is kept only when the formula bar showed what was typed,
    /// since keys sent to a pane in Excel's window never reach it (#97 fourth review).
    pub(super) bar_check: bool,
    /// Typed into a remote session's window (`programs::is_remote_window`), or into the Remote
    /// Desktop control's input window in any program (`Worker::keys_to_remote`, #116): the keys
    /// went to another computer, whose password boxes UI Automation can't see, so the step keeps
    /// no value and no field name, whatever else says where they went (12/10/2026, #113).
    pub(super) remote: bool,
}

/// The text box a stretch of typing may have gone into, when the click before it couldn't say
/// (its lookup failed, or the focus news after it wasn't its own): the box with focus, watched for
/// dictation (#91). Its text is read as the stretch ends, or before focus leaves it; only when
/// what was added to it holds what the keys typed did they go there, and the step names it and
/// keeps its value (#97 third review). Keys that went into a password box elsewhere add nothing
/// to it, whatever focus news says or when it comes.
pub(super) struct Unconfirmed {
    pub(super) element: ElementFacts,
    /// Its text as last read before the stretch began.
    pub(super) before: String,
    /// Its text read as focus left it, before the stretch ended.
    pub(super) after: Option<String>,
}

/// Whether the keys of `stretch` went into a text box whose text was `before` and is now `after`:
/// what was added to it holds all they typed. For keys that typed only Unicode packets (another
/// program's), that something was added.
fn typed_into(stretch: &Stretch, before: &str, after: Option<&str>) -> bool {
    let typed = stretch.text.trim();
    after
        .and_then(|after| crate::dictation::dictated(before, after))
        .is_some_and(|added| !added.trim().is_empty() && added.contains(typed))
}

/// What a finished stretch of typing keeps for its step.
#[derive(Debug, PartialEq)]
pub(super) struct KeptTyping {
    /// Masked; empty when the value is withheld.
    pub(super) text: String,
    /// The secrets masked in code, to blur in the screenshot.
    pub(super) secrets: Vec<String>,
    pub(super) form: &'static str,
    pub(super) language: &'static str,
}

impl KeptTyping {
    /// No text at all, not even masked: the step says "Type" with no value (10/10/2026).
    fn withheld() -> Self {
        Self {
            text: String::new(),
            secrets: Vec::new(),
            form: "text",
            language: "plain",
        }
    }
}

/// What a stretch of typing keeps, or `None` when nothing was typed. A withheld stretch, one
/// another program typed some of, and one typed into a remote session keep no text at all.
pub(super) fn kept_typing(stretch: &Stretch, extra_terms: &[String]) -> Option<KeptTyping> {
    let text = if stretch.excel {
        excel_entry(stretch).text
    } else {
        stretch.text.trim_end().to_string()
    };
    if text.trim().is_empty() && !stretch.packets {
        return None;
    }
    if stretch.withheld || stretch.packets || stretch.remote {
        return Some(KeptTyping::withheld());
    }
    let formula = (stretch.excel || stretch.cell.is_some()) && text.starts_with('=');
    let (text, secrets) = if stretch.code || formula {
        let masked = mask_command(&text, extra_terms);
        (masked.text, masked.secrets)
    } else {
        (mask_value(&text), Vec::new())
    };
    let (form, language) = if formula {
        ("formula", "excel")
    } else if stretch.code {
        ("code", "plain")
    } else {
        ("text", "plain")
    };
    Some(KeptTyping {
        text,
        secrets,
        form,
        language,
    })
}

/// Where keys that went to `window` (of window class `class`) belong, by what has focus, once
/// Steps' own windows and excluded apps are ruled out.
pub(super) fn place_in(
    window: &WindowInfo,
    class: &str,
    note: &FocusNote,
    password: &mut PasswordGuard,
) -> Place {
    // A password box had focus in this window since the last click: whatever UI Automation says
    // has focus now, the keys may still be going into it (10/10/2026).
    if password.typing_in(window.hwnd) {
        return Place::Sensitive;
    }
    // A window or dialog titled for a password ("Set Password", "Passwort ändern"): what's
    // typed there is kept out even when the field itself doesn't say it's one, as
    // LibreOffice's password boxes don't (F021, 01/10/2026).
    if crate::sensitive::looks_sensitive(&[window.title.as_str()], &[]) {
        return Place::Sensitive;
    }
    // A password box anywhere in the window, Excel's and terminals' too (an add-in's sign-in
    // pane is inside Excel's window), before what kind of window it is. Or in the same program:
    // a dialog's box can report focus before the dialog is the window in front.
    let note_here = note.window == window.hwnd;
    if (note_here || (note.pid != 0 && note.pid == window.pid)) && note.secret() {
        return Place::Sensitive;
    }
    if let Some(kind) = TerminalKind::from_class(class) {
        return Place::Terminal(window.hwnd, kind);
    }
    if class == excel::WINDOW_CLASS {
        return Place::Excel(window.hwnd);
    }
    let code = window.exe_name().is_some_and(is_code_editor);
    if note_here && note.field && !code {
        return Place::Field;
    }
    Place::Editor(window.hwnd, code)
}

impl<D: Desktop> Worker<D> {
    pub(super) fn focus_moved(&mut self, note: &FocusNote) {
        // Typing begun in Excel before the news of where a click or a move went takes that cell:
        // the keys came after it, and a click or a move ends the stretch it was in.
        if let Some(cell) = self.excel_cells.focused(note)
            && let Some(stretch) = self.stretch.as_mut()
            && stretch.excel
            && stretch.hwnd == note.window
            && stretch.cell.is_none()
        {
            stretch.cell = Some(cell);
        }
        // The click's news, after keys typed straight after it: it put focus in the Remote
        // Desktop control's input window, so the keys went to the other computer (#116), even
        // after a click whose lookup named nothing, which says focus didn't move.
        if is_remote_input(&note.facts)
            && self.click_news_after_stretch(note)
            && let Some(stretch) = self.stretch.as_mut()
        {
            stretch.remote = true;
        }
        let Some(stretch) = self.stretch.as_ref() else {
            return;
        };
        let hwnd = stretch.hwnd;
        // Focus went into a password field in the middle of the stretch (in Excel's window too: an
        // add-in's sign-in pane): the keys since may be the password, so none of it is kept. The
        // guard also knows of a password box whose focus news a later focus change replaced, and
        // of one whose news came after the stretch's first key.
        if (stretch.focus_generation != note.generation && note.window == hwnd && note.secret())
            || self.password.covers(hwnd)
        {
            self.stretch = None;
            return;
        }
        // Another program's element took focus while the keys went on to this window (a
        // notification, 10/10/2026): where they went can't be told, so the stretch keeps no value.
        // The window's own elements moving focus (Excel's cell and its editor) don't count.
        if note.window == hwnd {
            let foreign = self.window(hwnd).is_none_or(|(window, _)| {
                another_program(note, &window, |x, y| self.desktop.root_at(x, y))
            });
            if foreign && let Some(stretch) = self.stretch.as_mut() {
                stretch.withheld = true;
                stretch.unconfirmed = None;
            }
        }
        let Some(stretch) = self.stretch.as_ref() else {
            return;
        };
        // In Excel, focus moves between the cell and its editor while typing; the stretch ends at
        // Enter, Tab, a click or another window instead. So does typing in its Name Box or Go To.
        if (stretch.excel || stretch.goes_to.is_some()) && note.window == stretch.hwnd {
            return;
        }
        // The click's own news, after the keys typed straight after it: they went where it says
        // (#97).
        if stretch.focus_generation < note.generation && self.click_news_names_stretch(note) {
            return;
        }
        let Some(stretch) = self.stretch.as_ref() else {
            return;
        };
        // News heard of before the stretch began is of a focus from before it.
        if stretch.focus_generation < note.generation {
            // The address bar said it had focus only after this stretch began: its keys went there.
            if address_bar_took(note, stretch.hwnd, stretch.first_tick) {
                self.stretch = None;
                return;
            }
            self.end_stretch(true);
        }
    }

    pub(super) fn new_stretch(
        &mut self,
        hwnd: isize,
        tick: u32,
        excel: bool,
        code: bool,
        cell: Option<String>,
    ) -> Stretch {
        let remote = self
            .window(hwnd)
            .is_some_and(|(window, _)| is_remote_window(&window));
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
            bar_unchecked: None,
            bar_due: None,
            shot: None,
            shot_due: None,
            // The focus applied as of its first key, not the latest news heard: news heard after
            // that key arrived, though before it was handled, is of focus after it, and ends the
            // stretch when it's applied ("Hi", Tab, "x" had been one stretch, #97 third review).
            focus_generation: self.applied.generation,
            withheld: false,
            goes_to: None,
            packets: false,
            unconfirmed: None,
            focus_check: None,
            bar_check: false,
            remote,
        }
    }

    /// Whether keys that went to the window `hwnd` went to another computer (#116): it's a remote
    /// session's window (`programs::is_remote_window`), or the Remote Desktop control's input
    /// window has the keyboard in it, in whatever program shows it (a connection manager, an
    /// in-house console). UI Automation's latest focus news may say so, or Windows, asked now:
    /// keys are handled 150 ms late, so a key typed in a local box just before a click into the
    /// session can be taken as the session's, which only loses its value.
    pub(super) fn keys_to_remote(&mut self, hwnd: isize) -> bool {
        if self
            .window(hwnd)
            .is_some_and(|(window, _)| is_remote_window(&window))
        {
            return true;
        }
        if self.applied.window == hwnd && is_remote_input(&self.applied.facts) {
            return true;
        }
        self.desktop
            .keyboard_class(hwnd)
            .is_some_and(|class| is_remote_input_class(&class))
    }

    /// Ends the stretch of typing, making its step (`keep`) or dropping it. Typing in the Name
    /// Box or Go To does something only at Enter (`finish_go_to`): anything else ending it leaves
    /// the box, which Excel puts back (#69).
    pub(super) fn end_stretch(&mut self, keep: bool) {
        let Some(mut stretch) = self.stretch.take() else {
            return;
        };
        if !keep || stretch.goes_to.is_some() {
            return;
        }
        self.confirm_typing(&mut stretch);
        self.unproven_typing(&mut stretch);
        let Some(kept) = kept_typing(&stretch, &self.options.extra_terms) else {
            return;
        };
        self.write_typing(stretch, kept);
    }

    /// A stretch after a click that couldn't say what it went to, ending: it keeps no field name
    /// and no value when UI Automation couldn't say what had focus as its keys were typed (or
    /// wasn't asked since the last of them, #114, #117), or, in Excel, when the formula bar never
    /// showed what was typed (#97 fourth review).
    fn unproven_typing(&self, stretch: &mut Stretch) {
        let unread = stretch.focus_check.is_some_and(FocusCheck::withholds);
        let unshown = stretch.excel && stretch.bar_check && !self.bar_showed(stretch);
        if unread || unshown {
            stretch.withheld = true;
            stretch.element = None;
            stretch.cell = None;
        }
    }

    /// A stretch whose click couldn't say where its keys went, ending: when the text box with
    /// focus, watched for dictation, gained all they typed, they went there, and the step names
    /// it and keeps its value; otherwise it stays withheld (#97 third review).
    fn confirm_typing(&mut self, stretch: &mut Stretch) {
        let Some(unconfirmed) = stretch.unconfirmed.take() else {
            return;
        };
        let after = if self.dictation.watching(stretch.hwnd, &unconfirmed.element) {
            let text = self.desktop.text_box_text();
            self.dictation.read_now(text.clone());
            text
        } else {
            unconfirmed.after.clone()
        };
        if stretch.element.is_none() && typed_into(stretch, &unconfirmed.before, after.as_deref()) {
            stretch.cell = cell_name(&unconfirmed.element);
            stretch.element = Some(unconfirmed.element);
            stretch.withheld = false;
        }
    }

    /// Focus is leaving the watched text box while a stretch that may have gone into it goes on:
    /// its text now, for the stretch to be checked against as it ends (#97 third review).
    pub(super) fn read_unconfirmed(&mut self) {
        let Some(stretch) = self.stretch.as_ref() else {
            return;
        };
        let Some(unconfirmed) = stretch.unconfirmed.as_ref() else {
            return;
        };
        if !self.dictation.watching(stretch.hwnd, &unconfirmed.element) {
            return;
        }
        let text = self.desktop.text_box_text();
        if let Some(unconfirmed) = self
            .stretch
            .as_mut()
            .and_then(|stretch| stretch.unconfirmed.as_mut())
        {
            unconfirmed.after = text;
        }
    }

    /// Writes a stretch's typing step, with the photo taken after its last key or one now.
    pub(super) fn write_typing(&mut self, mut stretch: Stretch, kept: KeptTyping) {
        // Go To has closed by its Enter: the step is the workbook's, where the cell is.
        let hwnd = match stretch.goes_to {
            Some(GoesTo::Dialog { excel }) => excel,
            _ => stretch.hwnd,
        };
        let Some((window, _)) = self.window(hwnd) else {
            return;
        };
        // Keys that went to a remote session keep no value and no field name, however the step
        // came to be made (#113): only the session's window names it. So do keys put down to the
        // Remote Desktop control's input window, in any program (#116).
        let remote = stretch.remote || stretch.element.as_ref().is_some_and(is_remote_input);
        let kept = if remote {
            stretch.element = None;
            stretch.cell = None;
            KeptTyping::withheld()
        } else {
            kept
        };
        let KeptTyping {
            text,
            secrets,
            form,
            language,
        } = kept;
        // The photo taken after the last key, or one now.
        let taken_after_keys = stretch.shot_due.is_none();
        let mut shot = match stretch.shot.take() {
            Some(shot) if taken_after_keys => Some(shot),
            _ => self.shoot(&window),
        };
        let check_screenshot = shot
            .as_mut()
            .is_some_and(|shot| !blur_secrets(shot, &secrets));
        let id = self.next_id();
        let capture = shot
            .as_ref()
            .map(|shot| CaptureFacts::of(shot, self.options.mode));
        let facts = window_facts(&window);
        let record = Record::Typing(TypingRecord {
            id,
            tick_ms: stretch.first_tick,
            window: WindowFacts {
                remote_session: facts.remote_session || remote,
                ..facts
            },
            capture,
            element: stretch.element.take(),
            text,
            form,
            language,
            cell: stretch.cell.take(),
            approximate: stretch.approximate
                || (stretch.excel && excel_entry(&stretch).approximate),
            check_screenshot,
        });
        let _ = self.out.send((record, shot.map(|shot| shot.image)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typing::scene::*;
    use crate::typing::{FIRST_ID, element_in_window};

    fn typed(text: &str, element: Option<ElementFacts>, withheld: bool) -> Stretch {
        Stretch {
            excel: false,
            cell: None,
            element,
            withheld,
            ..stretch(text, None)
        }
    }

    /// The typing record as the journal would hold it.
    fn journaled(stretch: &Stretch, kept: KeptTyping) -> String {
        let record = TypingRecord {
            id: FIRST_ID,
            tick_ms: 1_500,
            window: window_facts(&encrypt_dialog()),
            capture: None,
            element: stretch.element.clone(),
            text: kept.text,
            form: kept.form,
            language: kept.language,
            cell: stretch.cell.clone(),
            approximate: false,
            check_screenshot: false,
        };
        serde_json::to_string(&Record::Typing(record)).expect("a record serialises")
    }

    #[test]
    fn a_password_typed_while_a_notification_has_focus_is_never_kept() {
        let dialog = encrypt_dialog();
        let class = "bosa_sdm_msword";
        // The worker read the password box's news, then the toast's.
        let mut guard = PasswordGuard::default();
        let first = noted(&[password_box()]);
        guard.focus_applied(&first);
        assert!(matches!(
            place_in(&dialog, class, &first, &mut guard),
            Place::Sensitive
        ));
        let then = noted(&[password_box(), toast()]);
        guard.focus_applied(&then);
        assert!(matches!(
            place_in(&dialog, class, &then, &mut guard),
            Place::Sensitive
        ));

        // The toast's news replaced the password box's before the worker read it: the count
        // still tells.
        let mut guard = PasswordGuard::default();
        guard.focus_applied(&then);
        assert!(matches!(
            place_in(&dialog, class, &then, &mut guard),
            Place::Sensitive
        ));

        // Had nothing told of the password box, the toast still isn't where the keys went: the
        // stretch has no element, keeps no value, and never takes the toast's name.
        let mut guard = PasswordGuard::starting(&then);
        assert!(matches!(
            place_in(&dialog, class, &then, &mut guard),
            Place::Editor(DIALOG, false)
        ));
        let element = element_in_window(&then, &dialog, screen);
        assert_eq!(element, None);
        let stretch = typed(TYPED, element.clone(), element.is_none());
        let kept = kept_typing(&stretch, &[]).expect("something was typed");
        assert_eq!(
            kept,
            KeptTyping {
                text: String::new(),
                secrets: Vec::new(),
                form: "text",
                language: "plain",
            }
        );
        let json = journaled(&stretch, kept);
        assert!(!json.contains(TYPED), "{json}");
        assert!(!json.contains("ChatApp"), "{json}");
        assert!(!json.contains("FlexibleToastView"), "{json}");
        assert!(json.contains(r#""text":"""#), "{json}");
    }

    #[test]
    fn a_password_box_keeps_its_window_out_until_a_click() {
        let dialog = encrypt_dialog();
        let class = "bosa_sdm_msword";
        let mut guard = PasswordGuard::default();
        let mut note = noted(&[password_box(), toast()]);
        guard.focus_applied(&note);
        // Focus moving on in the same window, to something that isn't a password box, doesn't
        // end it.
        note.focus_now(FocusUpdate {
            facts: ElementFacts {
                control_type: "Button".into(),
                name: "OK".into(),
                is_password: false,
                sensitive: false,
                ..password_box().facts
            },
            ..password_box()
        });
        guard.focus_applied(&note);
        assert!(guard.covers(DIALOG));
        assert!(matches!(
            place_in(&dialog, class, &note, &mut guard),
            Place::Sensitive
        ));
        // A click does, unless focus is still in a password box.
        guard.clicked(&noted(&[password_box()]));
        assert!(guard.covers(DIALOG));
        guard.clicked(&note);
        assert!(!guard.covers(DIALOG));
        assert!(!matches!(
            place_in(&dialog, class, &note, &mut guard),
            Place::Sensitive
        ));
        // So does typing in another window.
        guard.focus_applied(&noted(&[password_box()]));
        assert!(guard.typing_in(DIALOG));
        assert!(!guard.typing_in(DIALOG + 1));
        assert!(!guard.covers(DIALOG));
    }

    #[test]
    fn a_password_box_counts_before_its_dialog_is_in_front() {
        // Word's box reported focus while Word's main window was still the one in front.
        let mut guard = PasswordGuard::default();
        let early = noted(&[FocusUpdate {
            window: DIALOG - 1,
            ..password_box()
        }]);
        guard.focus_applied(&early);
        assert!(matches!(
            place_in(&encrypt_dialog(), "bosa_sdm_msword", &early, &mut guard),
            Place::Sensitive
        ));
    }

    #[test]
    fn ordinary_typing_keeps_its_value() {
        let notepad = WindowInfo {
            hwnd: 5,
            pid: 42,
            title: "Untitled - Notepad".into(),
            exe_path: Some(r"C:\Windows\notepad.exe".into()),
            frame: rect(0, 0, 800, 600),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let note = noted(&[FocusUpdate {
            window: 5,
            facts: ElementFacts {
                control_type: "Document".into(),
                name: "Text editor".into(),
                bounds: Some(PxRect {
                    left: 10,
                    top: 60,
                    right: 790,
                    bottom: 590,
                }),
                ..ElementFacts::default()
            },
            field: false,
            address_bar: false,
            tick_ms: 0,
            pid: 42,
        }]);
        let mut guard = PasswordGuard::starting(&note);
        assert!(matches!(
            place_in(&notepad, "Notepad", &note, &mut guard),
            Place::Editor(5, false)
        ));
        let element = element_in_window(&note, &notepad, |_, _| None);
        assert_eq!(
            element.as_ref().map(|facts| facts.name.as_str()),
            Some("Text editor")
        );
        let stretch = typed("Dear Sam", element.clone(), element.is_none());
        assert_eq!(
            kept_typing(&stretch, &[]),
            Some(KeptTyping {
                text: "Dear Sam".into(),
                secrets: Vec::new(),
                form: "text",
                language: "plain",
            })
        );
        // Nothing typed, nothing kept, withheld or not.
        assert_eq!(kept_typing(&typed("  ", None, true), &[]), None);
    }

    #[test]
    fn typing_into_a_remote_session_keeps_no_text() {
        // Even with an element and nothing withholding it, keys that went to a remote session keep
        // no text, not even masked (#113); with nothing typed there's still no step.
        let element = ElementFacts {
            control_type: "Pane".into(),
            name: "Input Capture Window".into(),
            ..ElementFacts::default()
        };
        let remote = Stretch {
            remote: true,
            ..typed("Tr0ub4dor3", Some(element), false)
        };
        assert_eq!(
            kept_typing(&remote, &[]),
            Some(KeptTyping {
                text: String::new(),
                secrets: Vec::new(),
                form: "text",
                language: "plain",
            })
        );
        let nothing = Stretch {
            remote: true,
            ..typed(" ", None, false)
        };
        assert_eq!(kept_typing(&nothing, &[]), None);
    }

    #[test]
    fn no_screenshot_is_taken_while_the_recording_is_paused() {
        // "12" typed, then a pause before its picture was due: its step is finished as the pause
        // is noticed, with a picture. "3", typed just before the pause, reached the worker only
        // after it had noticed: its step is kept, but its picture would be taken well into the
        // pause, so it has none, as a click's step wouldn't (#112).
        let (records, shots) = photographed(
            Scene::default()
                .click(0, "B2")
                .type_keys(100, 50, "12")
                .at(300, Happening::Pause(true))
                .press_reaching(295, 320, u16::from(b'3'))
                .bar(300, "123"),
        );
        assert_eq!(cells(&records), [(Some("B2"), "12"), (Some("B2"), "123")]);
        assert_eq!(shots, 1);
    }
}
