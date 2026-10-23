//! The pre-read (docs/GLOSSARY.md, docs/spec/02-capture.md#on-each-click): the element under a
//! resting pointer, read before any click, so a click on it is named as it was before the app
//! reacted. Read after the click, Excel's Number Format drop-down had become "Close",
//! Calculator's Open Navigation "Close Navigation", and Cancel on Notepad's prompt the document
//! under the prompt it closed (P5, P13, #92).
//!
//! The reads are made on a thread of their own (`run`): the lookup thread answers one click at a
//! time, and a read on a slow app can take longer than a click's whole lookup, so a click must
//! never wait behind one. The lookup thread asks [`PreReads::for_click`] for a pre-read that fits
//! the click, and reads the element itself, after the click, when none does. What a read needs
//! from the desktop is the [`Desk`], which the tests stand in for.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::facts::ElementFacts;
use crate::lookup::{Answer, LookupError, chrome_guess};
use crate::platform::window::WindowInfo;
use crate::state_machine::RecorderStateMachine;

/// How often the pointer is looked at: as Chromium's two questions were spaced.
const LOOK_EVERY: Duration = Duration::from_millis(40);
/// While the pointer rests, its element is read again this often (ms), for a window that changes
/// under it (a menu opening), or as often as a read takes on an app slower than that.
const REREAD_MS: u32 = 250;
/// After a click, a key, the wheel or a button, how long (ms) before the element is read again,
/// so the app has reacted: a read in between could still show what the click is changing.
const SETTLE_MS: u32 = 250;
/// How old (ms) a pre-read may be when the button goes down and still name the click.
const KEPT_MS: u32 = 3_000;

/// Whether `a` comes before `b` on the input clock, which counts milliseconds and wraps.
fn before(a: u32, b: u32) -> bool {
    let gap = b.wrapping_sub(a);
    gap != 0 && gap < 1 << 31
}

/// What was read under a resting pointer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreRead {
    pub facts: ElementFacts,
    /// The top-level window under the pointer when it was read.
    pub window: isize,
    /// Where the pointer rested.
    pub at: (i32, i32),
    /// When the read began and ended, on the input clock (ms, wrapping).
    pub began: u32,
    pub ended: u32,
    /// Only a click on this very pixel is named from it: Chromium's hit test answers from what
    /// it asked before, and an element that holds others may have one of them anywhere else.
    pub exact: bool,
    /// The first input other than the pointer moving (a key, the wheel, a button) seen after
    /// the read began.
    pub disturbed: Option<u32>,
}

/// A click asking what names it: where, the window under it as the button went down, and when
/// the button went down, on the input clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClickAt {
    pub x: i32,
    pub y: i32,
    pub window: isize,
    pub pressed: u32,
}

/// Whether `read` names `click`: read before the button went down, no more than `KEPT_MS`
/// before, and after the click before it (`last_press`); nothing but the pointer moving since
/// it began; in the same window; and the click inside the element, or on the very pixel read.
pub(crate) fn names_click(read: &PreRead, click: &ClickAt, last_press: Option<u32>) -> bool {
    let in_time = before(read.ended, click.pressed)
        && click.pressed.wrapping_sub(read.ended) <= KEPT_MS
        && last_press.is_none_or(|press| before(press, read.began))
        // An input at the press's own tick is the press.
        && read.disturbed.is_none_or(|input| !before(input, click.pressed));
    let landed = (click.x, click.y) == read.at
        || (!read.exact
            && read
                .facts
                .bounds
                .is_some_and(|bounds| bounds.contains(click.x, click.y)));
    in_time && read.window == click.window && landed
}

/// The latest pre-read and the latest click, between the thread that reads and the lookup
/// thread. Held only to look and to swap: never while anything is read.
#[derive(Debug, Default)]
pub(crate) struct PreReads(Mutex<Board>);

#[derive(Debug, Default)]
struct Board {
    latest: Option<PreRead>,
    last_press: Option<u32>,
}

impl PreReads {
    fn board(&self) -> MutexGuard<'_, Board> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The element that names `click`, when the latest pre-read does. The click is noted either
    /// way, so nothing read before it names a later click: it may have changed what was read.
    pub(crate) fn for_click(&self, click: &ClickAt) -> Option<ElementFacts> {
        let mut board = self.board();
        let facts = board
            .latest
            .as_ref()
            .filter(|read| names_click(read, click, board.last_press))
            .map(|read| read.facts.clone());
        if board
            .last_press
            .is_none_or(|press| before(press, click.pressed))
        {
            board.last_press = Some(click.pressed);
        }
        facts
    }

    fn keep(&self, read: PreRead) {
        self.board().latest = Some(read);
    }

    /// Input other than the pointer moving came at `input`.
    fn disturbed(&self, input: u32) {
        if let Some(read) = self.board().latest.as_mut()
            && read.disturbed.is_none()
        {
            read.disturbed = Some(input);
        }
    }

    fn last_press(&self) -> Option<u32> {
        self.board().last_press
    }
}

/// What names a click: its pre-read, when one fits; otherwise what `read_after` finds now, after
/// the click. When that finds nothing either, the click is named from its screenshot's words
/// when the recording opens, or by its window (docs/spec/02-capture.md#click-naming).
pub(crate) fn element_for_click(
    reads: &PreReads,
    click: &ClickAt,
    read_after: impl FnOnce() -> Result<(ElementFacts, bool), LookupError>,
) -> Result<Answer, LookupError> {
    if let Some(facts) = reads.for_click(click) {
        return Ok(Answer {
            facts,
            retried: false,
            pre_read: true,
        });
    }
    read_after().map(|(facts, retried)| Answer {
        facts,
        retried,
        pre_read: false,
    })
}

/// The top-level window under the pointer, as the pre-reads see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Under {
    pub window: isize,
    /// A Chromium browser's: asked twice, and named from only on the very pixel.
    pub chromium: bool,
    /// One a click would be recorded in ([`may_read`]).
    pub allowed: bool,
    /// A tooltip's window lies over the point, looked through to `window` (#105): a click there
    /// goes to `window`, but UI Automation would read the tooltip.
    pub tooltip: bool,
}

/// What the pre-reads need from the desktop.
pub(crate) trait Desk {
    /// Where the pointer is.
    fn pointer(&self) -> Option<(i32, i32)>;
    /// When the latest input of any kind came: the pointer moving, a key, a button, the wheel.
    fn last_input(&self) -> Option<u32>;
    /// How many times the mouse has reported moving, whether or not the pointer moved a pixel.
    fn mouse_moves(&self) -> Option<u64>;
    /// The input clock now (ms, wrapping).
    fn now(&self) -> u32;
    /// The top-level window at a point.
    fn under(&self, x: i32, y: i32) -> Option<Under>;
    /// Chromium's first question: its answer is a guess, but it starts Chrome's real hit test,
    /// which the next question gets.
    fn ask(&mut self, x: i32, y: i32);
    /// The element at a point, as a click's own lookup finds it.
    fn read(&mut self, x: i32, y: i32) -> Result<ElementFacts, LookupError>;
}

/// Whether a window may be pre-read, or a menu in it have its items kept: only one a click would
/// be recorded in. Never one of Steps' own, an excluded app's (or one whose program can't be named
/// while anything is excluded), a remote session's (nothing in it can be named), Windows' input
/// panel (a clipboard history item can be named after the text it holds, #109), nor while the
/// recording takes no clicks. `owners` are the processes of the windows up its owners
/// (`owner_processes_at`), and a pop-up any of them is Steps' or an excluded app's is theirs, though
/// another program draws it: a web view's drop-down or menu (#103); one the text input host draws or
/// owns is the input panel's. `program_of` names a process.
pub(crate) fn may_read(
    window: &WindowInfo,
    owners: &[u32],
    machine: Option<&Mutex<RecorderStateMachine>>,
    program_of: impl Fn(u32) -> Option<String>,
) -> bool {
    let own = crate::platform::window::own_process_id();
    if window.pid == own
        || owners.contains(&own)
        || crate::programs::is_steps_window(window)
        || crate::programs::is_remote_window(window)
        || crate::programs::is_input_panel(window)
        || owners.iter().any(|&pid| {
            program_of(pid).is_some_and(|name| crate::dictation::is_text_input_host(&name))
        })
    {
        return false;
    }
    machine.is_none_or(|machine| {
        let takes_clicks = machine
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .takes_clicks();
        takes_clicks
            && !crate::pipeline::is_excluded_window(machine, window)
            && !crate::pipeline::is_owned_by_excluded_app(machine, window, owners, program_of)
    })
}

/// Control types that hold other controls: a click elsewhere in one may be on something inside
/// it, so only a click on the pixel read is named from it.
const HOLDERS: &[&str] = &[
    "Window",
    "Pane",
    "Group",
    "Document",
    "Custom",
    "ToolBar",
    "List",
    "Tree",
    "Table",
    "DataGrid",
    "Tab",
    "MenuBar",
    "Menu",
    "StatusBar",
    "TitleBar",
    "ScrollBar",
    "Calendar",
    "Header",
    "SemanticZoom",
    "AppBar",
];

/// Whether a read is worth keeping: a window alone names nothing, so the click is better read
/// after; nor is Chrome's guess, in a browser or anything else Chrome draws (a web view, an
/// Electron app's window).
fn worth_keeping(facts: &ElementFacts, (x, y): (i32, i32)) -> bool {
    facts.control_type != "Window" && !chrome_guess(facts, x, y)
}

/// The pre-read thread's view of the pointer, from one look to the next.
#[derive(Debug, Default)]
pub(crate) struct Watch {
    pointer: Option<(i32, i32)>,
    input: Option<u32>,
    mouse_moves: Option<u64>,
    press: Option<u32>,
    /// No read before this: the app is still reacting to a click, a key or the wheel.
    settling: Option<u32>,
    /// The next read again of a resting pointer's element.
    next_read: Option<u32>,
}

impl Watch {
    /// One look at the pointer. It is read only while it rests: where it was at the last look,
    /// with no other input since. Over a Chromium window it is asked about as it arrives too.
    pub(crate) fn look(&mut self, desk: &mut impl Desk, reads: &PreReads) {
        let Some(point) = desk.pointer() else {
            return;
        };
        let now = desk.now();
        let input = desk.last_input();
        let mouse_moves = desk.mouse_moves();
        let press = reads.last_press();
        let moved = self.pointer != Some(point);
        // Input while the mouse reported no movement is a key, a button or the wheel: it may
        // change what's under the pointer. A hand on the mouse reports movement that doesn't
        // move the pointer a pixel; where movement can't be counted, any input with the pointer
        // still counts.
        let other_input = !moved
            && input != self.input
            && (mouse_moves.is_none() || mouse_moves == self.mouse_moves);
        if press != self.press || other_input {
            self.settling = Some(now.wrapping_add(SETTLE_MS));
        }
        if other_input && let Some(input) = input {
            reads.disturbed(input);
        }
        self.pointer = Some(point);
        self.input = input;
        self.mouse_moves = mouse_moves;
        self.press = press;
        if moved {
            self.next_read = None;
            if let Some(under) = desk.under(point.0, point.1)
                && under.allowed
                && under.chromium
            {
                desk.ask(point.0, point.1);
            }
            return;
        }
        // Waits that are over are forgotten: the clock wraps, and in 25 days an old one would
        // seem to lie ahead again.
        self.settling = self.settling.filter(|until| before(now, *until));
        self.next_read = self.next_read.filter(|until| before(now, *until));
        if other_input || self.settling.is_some() || self.next_read.is_some() {
            return;
        }
        // UI Automation finds a tooltip over the point, not what's under it: nothing is read, and
        // the read before it names a click there, which goes through the tooltip (#105).
        let Some(under) = desk
            .under(point.0, point.1)
            .filter(|under| under.allowed && !under.tooltip)
        else {
            self.next_read = Some(now.wrapping_add(REREAD_MS));
            return;
        };
        let began = desk.now();
        let read = desk.read(point.0, point.1);
        let ended = desk.now();
        self.next_read = Some(ended.wrapping_add(REREAD_MS.max(ended.wrapping_sub(began))));
        // A window that came or went while it was read (a tooltip too): what was read may be
        // either's.
        let same_window = desk
            .under(point.0, point.1)
            .is_some_and(|after| after.window == under.window && !after.tooltip);
        if let Ok(facts) = read
            && same_window
            && worth_keeping(&facts, point)
        {
            // Bounds that don't hold the pixel read say nothing about what else is under them.
            let exact = under.chromium
                || HOLDERS.contains(&facts.control_type.as_str())
                || !facts
                    .bounds
                    .is_some_and(|bounds| bounds.contains(point.0, point.1));
            reads.keep(PreRead {
                exact,
                facts,
                window: under.window,
                at: point,
                began,
                ended,
                disturbed: None,
            });
        }
    }
}

/// Looks at the pointer every `LOOK_EVERY` until `stop` is set, keeping what it reads in `reads`.
pub(crate) fn run(desk: &mut impl Desk, reads: &PreReads, stop: &AtomicBool) {
    let mut watch = Watch::default();
    while !stop.load(Ordering::SeqCst) {
        // A panic inside UI Automation loses this look, not the thread.
        let _ = catch_unwind(AssertUnwindSafe(|| watch.look(desk, reads)));
        std::thread::sleep(LOOK_EVERY);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Instant;

    use super::*;
    use crate::coords::PxRect;
    use crate::facts::AncestorFacts;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn element(
        control_type: &str,
        name: &str,
        bounds: PxRect,
        parent: Option<(&str, &str)>,
    ) -> ElementFacts {
        ElementFacts {
            control_type: control_type.into(),
            localized_control_type: control_type.to_lowercase(),
            name: name.into(),
            bounds: Some(bounds),
            ancestors: parent
                .map(|(control_type, name)| AncestorFacts {
                    control_type: control_type.into(),
                    name: name.into(),
                })
                .into_iter()
                .collect(),
            ..ElementFacts::default()
        }
    }

    const NOTEPAD: isize = 0x2_0400;
    const EXCEL: isize = 0x3_0100;
    const CALCULATOR: isize = 0x4_0200;
    const CHROME: isize = 0x5_0300;

    /// A pre-read of `facts` in `window`, the pointer resting at `at`, read at 1 000 ms on the
    /// input clock.
    fn read_of(facts: ElementFacts, window: isize, at: (i32, i32)) -> PreRead {
        PreRead {
            facts,
            window,
            at,
            began: 1_000,
            ended: 1_016,
            exact: false,
            disturbed: None,
        }
    }

    /// Notepad's "Save as Markdown?" prompt, its Cancel button read as the pointer rested on it
    /// (P13, 10/10/2026: read after the click, the prompt had gone and the click read
    /// `Click "Text editor"`).
    fn cancel() -> PreRead {
        read_of(
            element(
                "Button",
                "Cancel",
                rect(900, 600, 1000, 632),
                Some(("Pane", "")),
            ),
            NOTEPAD,
            (930, 615),
        )
    }

    fn click(x: i32, y: i32, window: isize, pressed: u32) -> ClickAt {
        ClickAt {
            x,
            y,
            window,
            pressed,
        }
    }

    #[test]
    fn a_click_inside_the_element_read_in_the_same_window_is_named_from_it() {
        assert!(names_click(
            &cancel(),
            &click(930, 615, NOTEPAD, 1_400),
            None
        ));
        // Anywhere inside its bounds, not only where the pointer rested.
        assert!(names_click(
            &cancel(),
            &click(999, 631, NOTEPAD, 1_400),
            None
        ));
    }

    #[test]
    fn a_click_outside_the_element_or_in_another_window_is_not() {
        // Just past its right and bottom edges, which belong to what's next to it.
        assert!(!names_click(
            &cancel(),
            &click(1000, 615, NOTEPAD, 1_400),
            None
        ));
        assert!(!names_click(
            &cancel(),
            &click(930, 632, NOTEPAD, 1_400),
            None
        ));
        // The same place, but the window under it as the button went down was another: the
        // prompt's window had closed, or one opened over it.
        assert!(!names_click(
            &cancel(),
            &click(930, 615, EXCEL, 1_400),
            None
        ));
    }

    #[test]
    fn chromium_and_elements_holding_others_name_only_a_click_on_the_pixel_read() {
        let page_button = PreRead {
            exact: true,
            ..read_of(
                ElementFacts {
                    framework_id: "Chrome".into(),
                    ..element("Button", "Pay now", rect(400, 300, 520, 340), None)
                },
                CHROME,
                (450, 320),
            )
        };
        assert!(names_click(
            &page_button,
            &click(450, 320, CHROME, 1_400),
            None
        ));
        assert!(!names_click(
            &page_button,
            &click(451, 320, CHROME, 1_400),
            None
        ));
    }

    #[test]
    fn only_a_read_finished_before_the_button_went_down_names_the_click() {
        // Ended on the press's own tick: it may have been read as the app took the click.
        assert!(!names_click(
            &cancel(),
            &click(930, 615, NOTEPAD, 1_016),
            None
        ));
        assert!(!names_click(
            &cancel(),
            &click(930, 615, NOTEPAD, 1_010),
            None
        ));
        assert!(names_click(
            &cancel(),
            &click(930, 615, NOTEPAD, 1_017),
            None
        ));
    }

    #[test]
    fn a_read_more_than_three_seconds_old_names_nothing() {
        assert!(names_click(
            &cancel(),
            &click(930, 615, NOTEPAD, 4_016),
            None
        ));
        assert!(!names_click(
            &cancel(),
            &click(930, 615, NOTEPAD, 4_017),
            None
        ));
    }

    #[test]
    fn a_read_from_before_the_last_click_names_nothing() {
        // Calculator's menu button: clicked once it opened the menu and became "Close
        // Navigation"; a second click there is named from a read made after the first.
        let open = read_of(
            element(
                "Button",
                "Open Navigation",
                rect(0, 32, 48, 72),
                Some(("Window", "Calculator")),
            ),
            CALCULATOR,
            (24, 52),
        );
        assert!(!names_click(
            &open,
            &click(24, 52, CALCULATOR, 2_000),
            Some(1_200)
        ));
        assert!(!names_click(
            &open,
            &click(24, 52, CALCULATOR, 2_000),
            Some(1_000)
        ));
        assert!(names_click(
            &open,
            &click(24, 52, CALCULATOR, 2_000),
            Some(999)
        ));
    }

    #[test]
    fn a_key_the_wheel_or_a_button_after_the_read_stops_it_naming_a_later_click() {
        let scrolled = PreRead {
            disturbed: Some(1_300),
            ..cancel()
        };
        assert!(!names_click(
            &scrolled,
            &click(930, 615, NOTEPAD, 1_400),
            None
        ));
        // Input seen on the press's own tick is the press itself.
        assert!(names_click(
            &scrolled,
            &click(930, 615, NOTEPAD, 1_300),
            None
        ));
    }

    #[test]
    fn the_input_clock_wraps() {
        let late = PreRead {
            began: u32::MAX - 40,
            ended: u32::MAX - 20,
            ..cancel()
        };
        assert!(names_click(&late, &click(930, 615, NOTEPAD, 100), None));
        assert!(names_click(
            &late,
            &click(930, 615, NOTEPAD, 100),
            Some(u32::MAX - 100)
        ));
        assert!(!names_click(
            &late,
            &click(930, 615, NOTEPAD, 100),
            Some(50)
        ));
    }

    /// A click's recorded reads: the element under the resting pointer before it, and what
    /// was under the click once the app had reacted (P5, P13, 10/10/2026). The reads after the
    /// click are as the test recorded them; the ones before are as the controls were on screen.
    struct Example {
        before: PreRead,
        click: ClickAt,
        after: ElementFacts,
    }

    fn examples() -> Vec<(&'static str, Example)> {
        let drop_down = rect(1310, 96, 1330, 118);
        let heading = rect(260, 88, 330, 120);
        vec![
            (
                "Excel's Number Format drop-down",
                Example {
                    before: read_of(
                        element(
                            "Button",
                            "Open",
                            drop_down,
                            Some(("ComboBox", "Number Format")),
                        ),
                        EXCEL,
                        (1320, 107),
                    ),
                    click: click(1318, 108, EXCEL, 1_500),
                    after: element(
                        "Button",
                        "Close",
                        drop_down,
                        Some(("ComboBox", "Number Format")),
                    ),
                },
            ),
            (
                "Calculator's Open Navigation",
                Example {
                    before: read_of(
                        element(
                            "Button",
                            "Open Navigation",
                            rect(0, 32, 48, 72),
                            Some(("Window", "Calculator")),
                        ),
                        CALCULATOR,
                        (24, 52),
                    ),
                    click: click(25, 50, CALCULATOR, 1_500),
                    after: element(
                        "Button",
                        "Close Navigation",
                        rect(0, 32, 48, 72),
                        Some(("Window", "Calculator")),
                    ),
                },
            ),
            (
                "Notepad's heading drop-down",
                Example {
                    before: read_of(
                        element("Button", "Heading", heading, Some(("ToolBar", ""))),
                        NOTEPAD,
                        (290, 104),
                    ),
                    click: click(292, 104, NOTEPAD, 1_500),
                    after: element(
                        "MenuItem",
                        "Title",
                        rect(262, 122, 480, 154),
                        Some(("Menu", "")),
                    ),
                },
            ),
            (
                "Cancel on Notepad's prompt",
                Example {
                    before: cancel(),
                    click: click(931, 616, NOTEPAD, 1_500),
                    after: element(
                        "Document",
                        "Text editor",
                        rect(0, 120, 1600, 900),
                        Some(("Pane", "")),
                    ),
                },
            ),
        ]
    }

    #[test]
    fn each_example_is_named_from_its_pre_read_not_from_what_the_click_opened() {
        for (name, example) in examples() {
            let reads = PreReads::default();
            reads.keep(example.before.clone());
            let answer = element_for_click(&reads, &example.click, || {
                panic!("{name}: read after the click although its pre-read names it")
            });
            assert_eq!(
                answer,
                Ok(Answer {
                    facts: example.before.facts,
                    retried: false,
                    pre_read: true,
                }),
                "{name}"
            );
        }
    }

    #[test]
    fn without_a_pre_read_that_fits_the_click_is_read_after_it() {
        for (name, example) in examples() {
            let reads = PreReads::default();
            // The pointer was still moving when the button went down: nothing read before it.
            let answer = element_for_click(&reads, &example.click, || {
                Ok((example.after.clone(), false))
            });
            assert_eq!(
                answer,
                Ok(Answer {
                    facts: example.after,
                    retried: false,
                    pre_read: false,
                }),
                "{name}"
            );
        }
        // Nor when it was read in another window: Excel's, then a click on Notepad's prompt.
        let reads = PreReads::default();
        reads.keep(examples().remove(0).1.before);
        let answer = element_for_click(&reads, &click(930, 615, NOTEPAD, 1_500), || {
            Ok((cancel().facts, true))
        });
        assert_eq!(
            answer.map(|answer| (answer.facts.name, answer.retried, answer.pre_read)),
            Ok(("Cancel".into(), true, false))
        );
    }

    #[test]
    fn a_click_nothing_names_now_is_left_to_its_screenshot() {
        let reads = PreReads::default();
        let answer = element_for_click(&reads, &click(930, 615, NOTEPAD, 1_500), || {
            Err(LookupError::WindowClosed)
        });
        assert_eq!(
            answer.map_err(|error| error.to_string()),
            Err("the window clicked in closed before it could be read".into())
        );
    }

    /// Excel's File tab and its Backstage's back arrow, clicked in the test of 10/10/2026 (P9,
    /// #74) in a window at (85, 78): read after the click, the File tab's lookup timed out (352 ms,
    /// Backstage opening) and the back arrow's found an unnamed Pane (Backstage gone), so both
    /// read `Click in "Book1 - Excel"`. The pre-read reads each before the click. Their names here
    /// are what Excel's accessibility says of them, not recorded: `cargo test -p capture
    /// under_the_pointer -- --ignored --nocapture` prints what they are on a real desktop.
    #[test]
    fn excels_file_tab_and_backstage_back_arrow_are_named_from_their_pre_reads() {
        let file_tab = read_of(
            element(
                "Button",
                "File Tab",
                rect(109, 124, 166, 154),
                Some(("Pane", "")),
            ),
            EXCEL,
            (140, 140),
        );
        let back = read_of(
            element(
                "Button",
                "Back",
                rect(93, 130, 125, 162),
                Some(("Pane", "")),
            ),
            EXCEL,
            (108, 147),
        );
        for (name, read, click_at, after) in [
            (
                "the File tab",
                file_tab,
                click(141, 141, EXCEL, 1_500),
                Err(LookupError::Automation(
                    "UI Automation timed out after 352 ms".into(),
                )),
            ),
            (
                "the back arrow",
                back,
                click(109, 148, EXCEL, 1_500),
                Ok((element("Pane", "", rect(85, 108, 1511, 820), None), false)),
            ),
        ] {
            // Read after the click, as on 10/10/2026: nothing names it.
            let after_only = element_for_click(&PreReads::default(), &click_at, || after.clone());
            if let Ok(answer) = &after_only {
                assert!(answer.facts.name.is_empty(), "{name}");
            }
            // Read before it, under the resting pointer: the control itself.
            let reads = PreReads::default();
            reads.keep(read.clone());
            let answer = element_for_click(&reads, &click_at, || {
                panic!("{name}: read after the click although its pre-read names it")
            });
            assert_eq!(
                answer,
                Ok(Answer {
                    facts: read.facts,
                    retried: false,
                    pre_read: true,
                }),
                "{name}"
            );
        }
    }

    #[test]
    fn a_pre_read_names_one_click_only() {
        // Calculator's menu button clicked twice without the pointer moving: the second click,
        // once the menu had opened, isn't "Open Navigation" again.
        let (_, calculator) = examples().remove(1);
        let reads = PreReads::default();
        reads.keep(calculator.before.clone());
        assert!(reads.for_click(&calculator.click).is_some());
        let again = ClickAt {
            pressed: calculator.click.pressed + 600,
            ..calculator.click
        };
        assert_eq!(reads.for_click(&again), None);
    }

    /// A desktop the tests set up: one window everywhere, an element under the pointer, and a
    /// clock they move on.
    struct FakeDesk {
        pointer: Option<(i32, i32)>,
        input: Option<u32>,
        moves: Option<u64>,
        now: u32,
        under: Option<Under>,
        /// What a read finds, and how long it takes (ms).
        element: Result<ElementFacts, LookupError>,
        read_takes: u32,
        /// The window under the pointer once a read has been made, when it changed during it.
        under_after_read: Option<Under>,
        asked: Vec<(i32, i32)>,
        reads: Vec<(i32, i32)>,
    }

    impl Desk for FakeDesk {
        fn pointer(&self) -> Option<(i32, i32)> {
            self.pointer
        }
        fn last_input(&self) -> Option<u32> {
            self.input
        }
        fn mouse_moves(&self) -> Option<u64> {
            self.moves
        }
        fn now(&self) -> u32 {
            self.now
        }
        fn under(&self, _x: i32, _y: i32) -> Option<Under> {
            match self.under_after_read {
                Some(after) if !self.reads.is_empty() => Some(after),
                _ => self.under,
            }
        }
        fn ask(&mut self, x: i32, y: i32) {
            self.asked.push((x, y));
        }
        fn read(&mut self, x: i32, y: i32) -> Result<ElementFacts, LookupError> {
            self.reads.push((x, y));
            self.now += self.read_takes;
            self.element.clone()
        }
    }

    fn notepad_desk() -> FakeDesk {
        FakeDesk {
            pointer: Some((930, 615)),
            input: Some(0),
            moves: Some(0),
            now: 0,
            under: Some(Under {
                window: NOTEPAD,
                chromium: false,
                allowed: true,
                tooltip: false,
            }),
            element: Ok(cancel().facts),
            read_takes: 0,
            under_after_read: None,
            asked: Vec::new(),
            reads: Vec::new(),
        }
    }

    fn latest(reads: &PreReads) -> Option<PreRead> {
        reads.board().latest.clone()
    }

    /// Looks at the desk at `at` ms, the pointer at `pointer` (input of any kind moving it on).
    fn look_at(
        watch: &mut Watch,
        desk: &mut FakeDesk,
        reads: &PreReads,
        at: u32,
        pointer: (i32, i32),
    ) {
        if desk.pointer != Some(pointer) {
            desk.input = Some(at);
            desk.moves = desk.moves.map(|moves| moves + 1);
        }
        desk.pointer = Some(pointer);
        desk.now = at;
        watch.look(desk, reads);
    }

    #[test]
    fn the_element_is_read_only_once_the_pointer_rests() {
        let (mut watch, mut desk, reads) = (Watch::default(), notepad_desk(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (700, 500));
        look_at(&mut watch, &mut desk, &reads, 40, (850, 580));
        look_at(&mut watch, &mut desk, &reads, 80, (930, 615));
        assert!(desk.reads.is_empty(), "read while moving: {:?}", desk.reads);
        look_at(&mut watch, &mut desk, &reads, 120, (930, 615));
        assert_eq!(desk.reads, vec![(930, 615)]);
        let latest = latest(&reads);
        assert_eq!(
            latest.map(|read| (
                read.facts.name,
                read.window,
                read.at,
                read.began,
                read.exact
            )),
            Some(("Cancel".into(), NOTEPAD, (930, 615), 120, false))
        );
        // Not asked about as it arrived: that's only for Chromium.
        assert!(desk.asked.is_empty());
    }

    #[test]
    fn nothing_is_read_over_a_window_whose_clicks_are_not_recorded() {
        let mut desk = FakeDesk {
            under: Some(Under {
                window: CHROME,
                chromium: true,
                allowed: false,
                tooltip: false,
            }),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        for (at, x) in (0..2_000).step_by(40).zip((0..).step_by(40)) {
            look_at(&mut watch, &mut desk, &reads, at, (x.min(400), 300));
        }
        assert!(desk.reads.is_empty() && desk.asked.is_empty());
        assert_eq!(latest(&reads), None);
    }

    #[test]
    fn chromium_is_asked_as_the_pointer_arrives_and_read_once_it_rests() {
        let page_button = ElementFacts {
            framework_id: "Chrome".into(),
            ..element("Button", "Pay now", rect(400, 300, 520, 340), None)
        };
        let mut desk = FakeDesk {
            under: Some(Under {
                window: CHROME,
                chromium: true,
                allowed: true,
                tooltip: false,
            }),
            element: Ok(page_button),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (450, 320));
        assert_eq!(
            (desk.asked.clone(), desk.reads.len()),
            (vec![(450, 320)], 0)
        );
        look_at(&mut watch, &mut desk, &reads, 40, (450, 320));
        assert_eq!(desk.reads, vec![(450, 320)]);
        assert_eq!(latest(&reads).map(|read| read.exact), Some(true));
    }

    #[test]
    fn chromes_guess_and_a_bare_window_are_not_kept() {
        let guess = ElementFacts {
            framework_id: "Chrome".into(),
            ..element("Document", "Checkout", rect(0, 80, 1600, 900), None)
        };
        let mut desk = FakeDesk {
            under: Some(Under {
                window: CHROME,
                chromium: true,
                allowed: true,
                tooltip: false,
            }),
            element: Ok(guess),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (450, 320));
        look_at(&mut watch, &mut desk, &reads, 40, (450, 320));
        assert_eq!((desk.reads.len(), latest(&reads)), (1, None));

        // Chrome draws web views and Electron apps' windows too (the new Outlook, Teams), and
        // guesses there the same way, though they aren't browsers.
        let mut desk = FakeDesk {
            element: Ok(ElementFacts {
                framework_id: "Chrome".into(),
                ..element("Pane", "", rect(0, 80, 1600, 900), None)
            }),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        assert_eq!((desk.reads.len(), latest(&reads)), (1, None));

        let mut desk = FakeDesk {
            element: Ok(element(
                "Window",
                "Untitled - Notepad",
                rect(0, 0, 1600, 900),
                None,
            )),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        assert_eq!((desk.reads.len(), latest(&reads)), (1, None));
    }

    #[test]
    fn a_resting_pointer_is_read_again_every_quarter_second_or_as_long_as_a_read_takes() {
        let (mut watch, mut desk, reads) = (Watch::default(), notepad_desk(), PreReads::default());
        for at in (0..=600).step_by(40) {
            look_at(&mut watch, &mut desk, &reads, at, (930, 615));
        }
        // Read at 40 ms, then at the first look 250 ms after each read: 320 and 600.
        assert_eq!(desk.reads.len(), 3);
        assert_eq!(latest(&reads).map(|read| read.began), Some(600));

        // An app that takes 400 ms to answer is asked no more often than that.
        let mut desk = FakeDesk {
            read_takes: 400,
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        for at in (0..=1_200).step_by(40) {
            let at = at.max(desk.now);
            look_at(&mut watch, &mut desk, &reads, at, (930, 615));
        }
        // Read from 40 to 440 ms, then not before 840: 400 ms after it ended.
        let latest = latest(&reads);
        assert_eq!(
            latest.map(|read| (read.began, read.ended)),
            Some((840, 1_240))
        );
        assert_eq!(desk.reads.len(), 2);
    }

    #[test]
    fn after_a_click_the_element_is_read_again_once_the_app_has_reacted() {
        let (mut watch, mut desk, reads) = (Watch::default(), notepad_desk(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        assert_eq!(desk.reads.len(), 1);
        // The button goes down at 100 ms, and the lookup thread asks for its pre-read.
        desk.input = Some(100);
        assert!(reads.for_click(&click(930, 615, NOTEPAD, 100)).is_some());
        for at in (120..=360).step_by(40) {
            look_at(&mut watch, &mut desk, &reads, at, (930, 615));
        }
        assert_eq!(desk.reads.len(), 1, "read while the app was still reacting");
        look_at(&mut watch, &mut desk, &reads, 400, (930, 615));
        assert_eq!(desk.reads.len(), 2);
        // That read names the next click there.
        assert!(reads.for_click(&click(930, 615, NOTEPAD, 600)).is_some());
    }

    #[test]
    fn a_key_or_the_wheel_while_the_pointer_rests_stops_the_read_naming_the_next_click() {
        let (mut watch, mut desk, reads) = (Watch::default(), notepad_desk(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        // The wheel turns at 60 ms with the pointer still: the list under it scrolled.
        desk.input = Some(60);
        look_at(&mut watch, &mut desk, &reads, 80, (930, 615));
        let scrolled = latest(&reads).unwrap();
        assert_eq!(scrolled.disturbed, Some(60));
        assert!(!names_click(
            &scrolled,
            &click(930, 615, NOTEPAD, 100),
            None
        ));
        // Read again once it has settled, and that read names the next click.
        for at in (120..=320).step_by(40) {
            look_at(&mut watch, &mut desk, &reads, at, (930, 615));
        }
        assert_eq!(desk.reads.len(), 1);
        look_at(&mut watch, &mut desk, &reads, 360, (930, 615));
        assert_eq!(desk.reads.len(), 2);
        assert!(reads.for_click(&click(930, 615, NOTEPAD, 400)).is_some());
    }

    #[test]
    fn a_mouse_moving_less_than_a_pixel_is_not_taken_for_a_key_or_the_wheel() {
        let (mut watch, mut desk, reads) = (Watch::default(), notepad_desk(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        // A hand on the mouse: it reports movement, but not enough to move the pointer.
        for at in (80..=320).step_by(40) {
            desk.input = Some(at - 10);
            desk.moves = desk.moves.map(|moves| moves + 3);
            look_at(&mut watch, &mut desk, &reads, at, (930, 615));
        }
        assert_eq!(
            desk.reads.len(),
            2,
            "read again at 320 ms, as for a still mouse"
        );
        assert!(reads.for_click(&click(950, 620, NOTEPAD, 400)).is_some());

        // Where the moves can't be counted (before the input thread first starts), input with
        // the pointer still is taken for something else, to be safe.
        let mut desk = FakeDesk {
            moves: None,
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        desk.input = Some(70);
        look_at(&mut watch, &mut desk, &reads, 80, (930, 615));
        assert_eq!(reads.for_click(&click(950, 620, NOTEPAD, 100)), None);
    }

    #[test]
    fn an_element_not_under_the_pixel_read_names_only_a_click_on_that_pixel() {
        // A hit test that answered with an element beside the pointer: its bounds say nothing
        // about what else is under them.
        let mut desk = FakeDesk {
            element: Ok(element("Button", "Save", rect(10, 10, 60, 40), None)),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        assert_eq!(latest(&reads).map(|read| read.exact), Some(true));
    }

    const EXPLORER: isize = 0x8_0400;

    /// File Explorer's Details button, its tooltip over the resting pointer from 400 ms (#105):
    /// XAML shows it in a pop-up window of its own, reaching up over the pointer.
    fn explorer_desk() -> FakeDesk {
        FakeDesk {
            pointer: Some((1840, 120)),
            under: Some(Under {
                window: EXPLORER,
                chromium: false,
                allowed: true,
                tooltip: false,
            }),
            element: Ok(element(
                "Button",
                "Details",
                rect(1800, 100, 1880, 140),
                Some(("ToolBar", "")),
            )),
            ..notepad_desk()
        }
    }

    #[test]
    fn a_tooltip_over_the_resting_pointer_is_not_read_and_the_read_before_it_names_the_click() {
        let (mut watch, mut desk, reads) = (Watch::default(), explorer_desk(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (1840, 120));
        look_at(&mut watch, &mut desk, &reads, 40, (1840, 120));
        assert_eq!(desk.reads.len(), 1);
        // The tooltip shows: the window clicked is still Explorer's, but what UI Automation finds
        // at the pointer is the tooltip.
        desk.under = desk.under.map(|under| Under {
            tooltip: true,
            ..under
        });
        desk.element = Ok(element(
            "ToolTip",
            "Details (Alt+Shift+P)",
            rect(1790, 150, 1960, 182),
            None,
        ));
        for at in (80..=1_000).step_by(40) {
            look_at(&mut watch, &mut desk, &reads, at, (1840, 120));
        }
        assert_eq!(desk.reads.len(), 1, "read under the tooltip");
        let named = reads.for_click(&click(1840, 120, EXPLORER, 1_020));
        assert_eq!(named.map(|facts| facts.name), Some("Details".into()));
    }

    #[test]
    fn a_read_while_a_tooltip_came_is_not_kept() {
        let mut desk = FakeDesk {
            under_after_read: Some(Under {
                window: EXPLORER,
                chromium: false,
                allowed: true,
                tooltip: true,
            }),
            ..explorer_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (1840, 120));
        look_at(&mut watch, &mut desk, &reads, 40, (1840, 120));
        assert_eq!((desk.reads.len(), latest(&reads)), (1, None));
    }

    #[test]
    fn a_read_while_a_window_came_or_went_is_not_kept() {
        let mut desk = FakeDesk {
            under_after_read: Some(Under {
                window: EXCEL,
                chromium: false,
                allowed: true,
                tooltip: false,
            }),
            ..notepad_desk()
        };
        let (mut watch, reads) = (Watch::default(), PreReads::default());
        look_at(&mut watch, &mut desk, &reads, 0, (930, 615));
        look_at(&mut watch, &mut desk, &reads, 40, (930, 615));
        assert_eq!((desk.reads.len(), latest(&reads)), (1, None));
    }

    /// A desktop whose element takes until the test lets it go to read: an app that is slow to
    /// answer UI Automation.
    struct SlowDesk {
        started: Instant,
        began: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Desk for SlowDesk {
        fn pointer(&self) -> Option<(i32, i32)> {
            Some((930, 615))
        }
        fn last_input(&self) -> Option<u32> {
            Some(0)
        }
        fn mouse_moves(&self) -> Option<u64> {
            Some(0)
        }
        fn now(&self) -> u32 {
            u32::try_from(self.started.elapsed().as_millis()).unwrap_or(u32::MAX)
        }
        fn under(&self, _x: i32, _y: i32) -> Option<Under> {
            Some(Under {
                window: NOTEPAD,
                chromium: false,
                allowed: true,
                tooltip: false,
            })
        }
        fn ask(&mut self, _x: i32, _y: i32) {}
        fn read(&mut self, _x: i32, _y: i32) -> Result<ElementFacts, LookupError> {
            let _ = self.began.send(());
            let _ = self.release.recv_timeout(Duration::from_secs(5));
            Ok(cancel().facts)
        }
    }

    #[test]
    fn a_click_is_not_held_up_by_a_pre_read_still_being_made() {
        let (began_tx, began) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let reads = Arc::new(PreReads::default());
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (reads, stop) = (Arc::clone(&reads), Arc::clone(&stop));
            let mut desk = SlowDesk {
                started: Instant::now(),
                began: began_tx,
                release: release_rx,
            };
            std::thread::spawn(move || run(&mut desk, &reads, &stop))
        };
        began
            .recv_timeout(Duration::from_secs(2))
            .expect("the resting pointer's element is being read");

        let asked = Instant::now();
        let answer = element_for_click(&reads, &click(930, 615, NOTEPAD, 1), || {
            Ok((
                element("Button", "OK", rect(800, 600, 890, 632), None),
                false,
            ))
        });
        let waited = asked.elapsed();
        assert!(waited < Duration::from_millis(50), "waited {waited:?}");
        assert_eq!(answer.map(|answer| answer.facts.name), Ok("OK".into()));

        stop.store(true, Ordering::SeqCst);
        release.send(()).unwrap();
        thread.join().unwrap();
        // Finished after the button went down, it names no click.
        assert!(latest(&reads).is_some());
        assert_eq!(reads.for_click(&click(930, 615, NOTEPAD, 2)), None);
    }

    fn window(exe: &str, pid: u32) -> WindowInfo {
        WindowInfo {
            hwnd: 7,
            pid,
            title: "A window".into(),
            exe_path: Some(format!(r"C:\Apps\{exe}")),
            frame: crate::platform::Rect::default(),
            elevation: crate::platform::window::Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        }
    }

    fn recording(excluded: &[&str]) -> Mutex<RecorderStateMachine> {
        let mut machine =
            RecorderStateMachine::new(excluded.iter().map(|app| (*app).into()).collect());
        machine.start().unwrap();
        Mutex::new(machine)
    }

    /// What each test process's program is called, as Windows would say.
    fn program_of(pid: u32) -> Option<String> {
        match pid {
            5 => Some("ms-teams.exe".into()),
            6 => Some("olk.exe".into()),
            46 => Some("TextInputHost.exe".into()),
            47 => Some("explorer.exe".into()),
            _ => None,
        }
    }

    #[test]
    fn only_a_window_whose_clicks_are_recorded_is_pre_read() {
        let machine = recording(&["KeePass.exe"]);
        assert!(may_read(
            &window("EXCEL.EXE", 40),
            &[],
            Some(&machine),
            program_of
        ));
        assert!(!may_read(
            &window("keepass.exe", 41),
            &[],
            Some(&machine),
            program_of
        ));
        // A program that can't be named, while anything is excluded.
        let unnamed = WindowInfo {
            exe_path: None,
            ..window("", 42)
        };
        assert!(!may_read(&unnamed, &[], Some(&machine), program_of));
        assert!(may_read(&unnamed, &[], Some(&recording(&[])), program_of));
        // Steps' own windows, and their drop-downs in a web-view process.
        let own = crate::platform::window::own_process_id();
        assert!(!may_read(
            &window("EXCEL.EXE", own),
            &[],
            Some(&machine),
            program_of
        ));
        assert!(!may_read(
            &window("msedgewebview2.exe", 43),
            &[own],
            Some(&machine),
            program_of
        ));
        assert!(!may_read(
            &window("amluto-steps.exe", 44),
            &[],
            None,
            program_of
        ));
        // A remote session: nothing in it has a name to read.
        assert!(!may_read(&window("mstsc.exe", 45), &[], None, program_of));
    }

    /// The rule a menu's items are read by too, with the menu's own program among its owners.
    #[test]
    fn an_excluded_apps_pop_up_is_never_pre_read_nor_its_menu_kept() {
        let machine = recording(&["ms-teams.exe"]);
        // Teams' drop-down or menu, drawn by its web view's process in a window Teams' owns.
        let pop_up = window("msedgewebview2.exe", 9);
        assert!(!may_read(&pop_up, &[5], Some(&machine), program_of));
        assert!(!may_read(&pop_up, &[9, 5], Some(&machine), program_of));
        // An owner that can't be named, while anything is excluded.
        assert!(!may_read(&pop_up, &[77], Some(&machine), program_of));
        // The new Outlook's is read as before.
        assert!(may_read(&pop_up, &[6], Some(&machine), program_of));
        assert!(may_read(&pop_up, &[9, 6], Some(&machine), program_of));
    }

    #[test]
    fn nothing_in_windows_input_panel_is_pre_read() {
        // Clipboard history's items can be named after the text they hold (#109), and its menus
        // (read through the same rule) belong to it.
        let machine = recording(&[]);
        assert!(!may_read(
            &window("TextInputHost.exe", 46),
            &[46],
            Some(&machine),
            program_of
        ));
        assert!(!may_read(
            &window("textinputhost.exe", 46),
            &[],
            None,
            program_of
        ));
        // As Windows 11 shows the emoji panel: in a frame of explorer.exe's round the text input
        // host's window (build 26300, 12/10/2026).
        let framed = WindowInfo {
            hosted_exe: Some("TextInputHost.exe".into()),
            ..window("explorer.exe", 47)
        };
        assert!(!may_read(&framed, &[47], Some(&machine), program_of));
        // A menu the text input host draws, judged with its own program among the owners.
        assert!(!may_read(
            &window("explorer.exe", 47),
            &[47, 46],
            Some(&machine),
            program_of
        ));
        // A store app's frame is read as before.
        let calculator = WindowInfo {
            hosted_exe: Some("CalculatorApp.exe".into()),
            ..window("ApplicationFrameHost.exe", 48)
        };
        assert!(may_read(&calculator, &[48], Some(&machine), program_of));
    }

    #[test]
    fn nothing_is_pre_read_while_the_recording_takes_no_clicks() {
        let machine = recording(&[]);
        machine
            .lock()
            .unwrap()
            .pause(crate::state_machine::PauseReason::User, 10)
            .unwrap();
        assert!(!may_read(
            &window("EXCEL.EXE", 40),
            &[],
            Some(&machine),
            program_of
        ));
        let idle = Mutex::new(RecorderStateMachine::new(Vec::new()));
        assert!(!may_read(
            &window("EXCEL.EXE", 40),
            &[],
            Some(&idle),
            program_of
        ));
    }
}
