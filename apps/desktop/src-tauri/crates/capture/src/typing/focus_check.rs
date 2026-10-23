//! UI Automation asked what has focus, for a stretch of typing whose place rests on a click that
//! couldn't say what it went to (docs/spec/02-capture.md#keys): Chrome's answer with its whole
//! page, a lookup that failed, a press nothing is known of, or something in a web page that isn't
//! a box, whose label's `for` or script can move focus (#118). The keys may have gone into a
//! password box no focus news told of (#97 fourth review), and the app can act on the click late,
//! or move focus into a password box itself (#114).
//!
//! Windows says what has focus now, not as of a key, so a read says something only of the keys
//! that had reached the worker before it, with no key that can move focus (Tab, Enter, Escape, a
//! combination, a key to another window), click, press or focus news between. Keys are handled
//! 150 ms after they're typed, and Enter often follows the last letter sooner, so focus is read as
//! keys arrive, at most every 50 ms but at once for Tab, Enter, Escape and the key after one, as
//! well as when they're handled (#117, #119): a key that moves focus then costs the value only
//! when it comes before the next read after the last letter, or before a read begun a second
//! after the click, which a busy app has acted on by then (#114). A read that
//! finds a password box drops the stretch; the reads never name anything. One reason to change:
//! when focus is read for typing, and what a read says of the keys before it.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::keys::{KeyAction, is_modifier, moves_focus};
use crate::state_machine::tick_before_or_at;

use super::{Desktop, Worker};

/// How often UI Automation is asked what has focus as keys of a stretch it checks arrive, at
/// most (#117): about every 50 ms, so a key that moves focus costs the value only when it comes
/// within that of the last letter. Not for Tab, Enter or Escape, nor the key after one, which are
/// read as they arrive (#119): a read held back by one taken just before could miss a PIN typed
/// at machine speed after Tab, and the page moving focus away after it.
const ARRIVAL_READ_EVERY: Duration = Duration::from_millis(50);

/// How often it's asked, at most, as a key no read since it arrived says anything of is handled,
/// and with no key until it has been asked a second after the click (#114).
const FOCUS_READ_EVERY: Duration = Duration::from_millis(100);

/// How often it's asked while a stretch it checks goes on, with nothing else to ask it: an app can
/// act on the click more than a second late, putting focus in the password box clicked after the
/// keys typed into it were read (#117).
const STRETCH_READ_EVERY: Duration = Duration::from_millis(250);

/// How long after the click it's asked so, at most: an app that acts on a click late does so
/// within 2 or 3 seconds, and the reads had gone on until the stretch ended, about 2,400 in ten
/// minutes left idle (#119).
const STRETCH_READS_FOR_MS: u32 = 5_000;

/// How long after the click a stretch of typing rests on UI Automation must be asked what has
/// focus before the stretch keeps a value: Chrome busy enough to answer a click with its page can
/// act on the click, putting focus in the box clicked, after the keys typed after it (#114). As
/// long as a click waits for its lookup.
const FOCUS_SETTLE_MS: u32 = 1_000;

/// How many reads are kept for the keys waiting to be handled: far more than are taken while a
/// key waits.
const READS_KEPT: usize = 128;

/// UI Automation's word on the element with focus, for a stretch of typing after a click that
/// couldn't say what it went to: the keys may have gone into a password box no focus news told of
/// (#97 fourth review). It's asked as keys arrive and as they're handled, and until it has been
/// asked a second after the click, and every 250 ms until 5 seconds after the click: the app can
/// act on the click late, or move focus itself, with no news (#114, #117, #119).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FocusCheck {
    /// To be read as the next key that types is handled, unless a read since it arrived says
    /// where it went: the first, or the first after a key that can move focus (Tab, Enter,
    /// Escape, a combination).
    Due,
    /// Not a box that holds a password or a secret, as far as the reads tell. `unchecked`: a key
    /// that types was handled that no read has said anything of yet. `settled`: a read asked a
    /// second or more after the click said so, which a busy app has acted on by then (#114, #119).
    Clear { unchecked: bool, settled: bool },
    /// It couldn't be read, or only after news since a key or with a key that can move focus
    /// before it (Windows says what has focus now), or a key that can move focus came before what
    /// was typed could be checked: the stretch keeps no value.
    Unread,
}

impl FocusCheck {
    /// A key that can move focus (Tab, Enter, Escape, a combination) is handled: the next key
    /// that types is checked again, since focus may have moved into a password box no news tells
    /// of. What was typed before it can't be checked any more, since what has focus from now on
    /// may be where it moved focus: keys not yet checked, or typed before the app may have acted
    /// on the click, keep no value (#114).
    pub(super) fn focus_key(self) -> Self {
        match self {
            Self::Clear {
                unchecked: false,
                settled: true,
            } => Self::Due,
            Self::Clear { .. } => Self::Unread,
            other => other,
        }
    }

    /// Whether the stretch keeps no value for it as it ends: it couldn't be read, keys were typed
    /// that no read said anything of, or it was never read a second after the click (#114).
    pub(super) fn withholds(self) -> bool {
        match self {
            Self::Unread => true,
            Self::Clear { unchecked, settled } => unchecked || !settled,
            Self::Due => false,
        }
    }
}

/// One read of the element with focus.
#[derive(Debug, Clone, Copy)]
struct FocusRead {
    /// When it was taken: it says something of the keys that reached the worker before then.
    at: Instant,
    /// The tick as it was asked, on the clock keys and clicks are timed by: what it says may be
    /// of that moment, so it's a read a second after the click only if that was (#119: a read
    /// slow to come back had counted as one).
    asked: u32,
    /// The tick as it came back: a key typed at or before then may have come before what it says.
    tick: u32,
    /// Whether the element holds a password or a secret; `None` when it couldn't be read.
    secret: Option<bool>,
}

/// The reads of the element with focus taken since the oldest key waiting to be handled reached
/// the worker, for what they say of each key as it's handled (#117).
#[derive(Debug, Default)]
pub(super) struct FocusReads {
    reads: VecDeque<FocusRead>,
    /// When the latest read was taken, for how often it's asked.
    last: Option<Instant>,
    /// The latest key to go down since the last read.
    unread_key: Option<UnreadKey>,
    /// The latest key to go down, modifiers aside, was Tab, Enter or Escape: the next is read as
    /// it arrives (#119).
    after_focus_key: bool,
}

/// The latest key to go down since the last read of the element with focus.
#[derive(Debug, Clone, Copy)]
struct UnreadKey {
    tick: u32,
    /// The window it went to.
    hwnd: isize,
    /// It, or a key before it since the last read, was Tab, Enter or Escape, or the key after one:
    /// focus is read as it arrives, however soon after the last read (#119).
    at_once: bool,
}

impl FocusReads {
    /// A key (`vkey`) went down at `tick`, in the window `hwnd`, and reached the worker.
    pub(super) fn key_arrived(&mut self, tick: u32, hwnd: isize, vkey: u16) {
        let mut at_once = self.unread_key.is_some_and(|key| key.at_once);
        if !is_modifier(vkey) {
            let focus_key = moves_focus(vkey);
            at_once |= focus_key || self.after_focus_key;
            self.after_focus_key = focus_key;
        }
        self.unread_key = Some(UnreadKey {
            tick,
            hwnd,
            at_once,
        });
    }

    /// Lets go of the reads taken before `oldest`, when the oldest key waiting to be handled
    /// reached the worker: they say nothing of it, or of any after it.
    pub(super) fn forget_before(&mut self, oldest: Option<Instant>) {
        match oldest {
            Some(oldest) => self.reads.retain(|read| read.at >= oldest),
            None => self.reads.clear(),
        }
    }

    fn since_last(&self, now: Instant) -> Duration {
        self.last
            .map_or(Duration::MAX, |last| now.saturating_duration_since(last))
    }

    fn push(&mut self, read: FocusRead) {
        if self.reads.len() >= READS_KEPT {
            self.reads.pop_front();
        }
        self.reads.push_back(read);
        self.last = Some(read.at);
        self.unread_key = None;
    }
}

/// What the reads of the element with focus say of a key that types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyWord {
    /// A read after it found a box that holds a password or a secret, before a click, a press,
    /// focus news, a combination or a key to another window: focus was there as it was typed, or
    /// Tab, Enter or Escape typed after it moved focus there, where the keys after them go.
    Secret,
    /// Reads after it, before anything that can move focus, found none; `settled`: one was a
    /// second or more after the click.
    Clear { settled: bool },
    /// No read after it, before anything that can move focus, could say.
    Unknown,
}

/// Something waiting to be handled that can move focus, as a read is held up against it: when it
/// reached the worker, when it was typed or heard, and whether it can take focus out of the
/// window (a click, a press, focus news, a combination, a key to another window) rather than
/// move it within (Tab, Enter, Escape).
#[derive(Debug, Clone, Copy)]
struct Mover {
    at: Instant,
    tick: u32,
    leaves: bool,
}

impl Mover {
    /// Whether it may have come before `read`: it reached the worker first, or was typed or
    /// heard at or before its tick (a key can reach the worker after the app has acted on it).
    fn before(self, read: &FocusRead) -> bool {
        self.at <= read.at || tick_before_or_at(self.tick, read.tick)
    }
}

impl<D: Desktop> Worker<D> {
    /// Keys reached the worker this turn, or since the last read: UI Automation is asked what has
    /// focus, at most every 50 ms (#117), or at once for Tab, Enter or Escape and the key after
    /// one (#119), when they may be keys of a stretch it checks. What it says is used as each is
    /// handled (`check_key`), and a password box found while a stretch it checks goes on drops it
    /// now (`drop_if_secret`).
    pub(super) fn read_focus_as_keys_arrive(&mut self, now: Instant) {
        let Some(UnreadKey {
            tick,
            hwnd,
            at_once,
        }) = self.focus_reads.unread_key
        else {
            return;
        };
        if !at_once && self.focus_reads.since_last(now) < ARRIVAL_READ_EVERY {
            return;
        }
        if self.may_check(tick, hwnd) {
            let found = self.read_focus(now).secret;
            self.drop_if_secret(found);
        } else {
            self.focus_reads.unread_key = None;
        }
    }

    /// Whether keys typed at `tick` into the window `hwnd` may be checked against UI Automation's
    /// word on focus as they're handled: they go on a stretch it checks, they follow a click that
    /// couldn't say what it went to (`keys_unproven`), or a click or press waiting to be applied
    /// may be one. Not in Excel, where the formula bar says instead (#97 fourth review).
    fn may_check(&mut self, tick: u32, hwnd: isize) -> bool {
        if self.checked_stretch().is_some() {
            return true;
        }
        let unclear = !self.waiting_presses.is_empty()
            || self.pending_clicks.iter().any(|click| {
                click.lookup.couldnt_tell()
                    || click.lookup.page_answer(click.point)
                    || click.lookup.on_page_text(click.firefox)
            });
        (unclear || self.keys_unproven(tick, hwnd)) && !self.is_excel(hwnd)
    }

    /// The window of the stretch of typing UI Automation checks, and what it has said so far,
    /// unless it keeps no value already.
    fn checked_stretch(&self) -> Option<(isize, FocusCheck)> {
        let stretch = self.stretch.as_ref()?;
        stretch
            .focus_check
            .filter(|&check| check != FocusCheck::Unread)
            .map(|check| (stretch.hwnd, check))
    }

    /// Asks UI Automation whether the element with focus now holds a password or a secret, and
    /// keeps what it says for the keys waiting to be handled.
    fn read_focus(&mut self, now: Instant) -> FocusRead {
        let asked = self.desktop.tick_now();
        let secret = self.desktop.focused_secret(&self.options.extra_terms);
        let read = FocusRead {
            at: now,
            asked,
            tick: self.desktop.tick_now(),
            secret,
        };
        self.focus_reads.push(read);
        read
    }

    /// A read with no key to ask it found a box that holds a password or a secret (`found`) while
    /// a stretch UI Automation checks goes on: nothing of it is kept, as when a key's read does,
    /// unless a click, a press, focus news, a combination or a key to another window has come
    /// since its last key was handled, which may have taken focus there instead. Tab, Enter or
    /// Escape since may have too, but the keys after them would go into the stretch; or focus may
    /// have been there before them, as when an app acts on a click late (#117).
    fn drop_if_secret(&mut self, found: Option<bool>) {
        if found != Some(true) {
            return;
        }
        let Some((hwnd, _)) = self.checked_stretch() else {
            return;
        };
        if !self.movers_waiting(hwnd).iter().any(|mover| mover.leaves) {
            self.drop_checked(hwnd);
        }
    }

    /// A key that types, which reached the worker at `arrived`, of a stretch in the window `hwnd`
    /// that UI Automation checks, handled at `now`. When no read since it arrived says where it
    /// went, it's asked now (#114): at the stretch's first key and the first after a key that can
    /// move focus, otherwise at most every 100 ms, a key not asked about then being asked about
    /// by the next read. `true` when a read found a box that holds a password or a secret: the
    /// stretch is dropped, and the window kept out until the next click, as that box's focus news
    /// would (#97 fourth review).
    pub(super) fn check_key(&mut self, hwnd: isize, arrived: Instant, now: Instant) -> bool {
        let Some((_, check)) = self.checked_stretch() else {
            return false;
        };
        let (unchecked, settled) = match check {
            FocusCheck::Clear { unchecked, settled } => (unchecked, settled),
            FocusCheck::Due | FocusCheck::Unread => (false, false),
        };
        let mut word = self.key_word(arrived, hwnd);
        let due = word == KeyWord::Unknown
            && (check == FocusCheck::Due || self.focus_reads.since_last(now) >= FOCUS_READ_EVERY);
        // Windows says what has focus now: once a click, a press or focus news has been heard
        // since the key, or a key that can move focus waits to be handled, it says nothing of
        // where the key went (#114: a PIN and Tab typed before the PIN's first key was handled had
        // been put down to the box focus was in before the click).
        let mut read_now = None;
        if due && self.movers_waiting(hwnd).is_empty() {
            read_now = self.read_focus(now).secret;
            word = self.key_word(arrived, hwnd);
        }
        let next = match word {
            KeyWord::Secret => {
                self.drop_checked(hwnd);
                return true;
            }
            // Read now with nothing waiting that can move focus: it says where every key handled
            // so far went.
            KeyWord::Clear { settled: now } => FocusCheck::Clear {
                unchecked: unchecked && read_now.is_none(),
                settled: settled || now,
            },
            KeyWord::Unknown if due => FocusCheck::Unread,
            KeyWord::Unknown => FocusCheck::Clear {
                unchecked: true,
                settled,
            },
        };
        self.set_focus_check(next);
        false
    }

    /// What the reads say of a key that reached the worker at `arrived`, of a stretch in the
    /// window `hwnd`: those taken after it, up to the first that something that can move focus
    /// may have come before. All of those wait to be handled, since they came after the key; one
    /// that reached the worker after a read, but was typed or heard at or before its tick, counts
    /// too. A read after Tab, Enter or Escape says nothing of where the key went, but a password
    /// box it finds still drops the stretch: focus was there as the key was typed, or the keys
    /// after them go there (#117).
    fn key_word(&self, arrived: Instant, hwnd: isize) -> KeyWord {
        let movers = self.movers_waiting(hwnd);
        let pressed = self.click_pressed();
        let mut word = KeyWord::Unknown;
        for read in self
            .focus_reads
            .reads
            .iter()
            .filter(|read| read.at >= arrived)
        {
            let moved = movers.iter().any(|mover| mover.before(read));
            if movers
                .iter()
                .any(|mover| mover.leaves && mover.before(read))
            {
                break;
            }
            match read.secret {
                Some(true) => return KeyWord::Secret,
                Some(false) if !moved => {
                    let settled = matches!(word, KeyWord::Clear { settled: true })
                        || pressed.is_none_or(|pressed| {
                            read.asked.wrapping_sub(pressed) >= FOCUS_SETTLE_MS
                        });
                    word = KeyWord::Clear { settled };
                }
                _ => {}
            }
        }
        word
    }

    /// UI Automation asked again with no key to ask it (#114, #117): every 100 ms while keys of the
    /// stretch were handled that no read has said anything of, as no key that types may come to,
    /// or until it has been asked a second after the click, since a busy app can act on the click
    /// after the keys typed after it; then every 250 ms until 5 seconds after the click, for an
    /// app that acts on it later still (#119). With something that can move focus waiting to be handled,
    /// what it says is of no key handled so far: keys not yet asked about then keep no value, and
    /// whether the rest waited long enough is for that key's handling, or the stretch's end, to
    /// say. It's asked even so with Tab, Enter or Escape waiting, for a password box
    /// (`drop_if_secret`). Until the stretch is proven, one that can't be read keeps no value.
    pub(super) fn check_focus_after_keys(&mut self, now: Instant) {
        let Some((hwnd, check)) = self.checked_stretch() else {
            return;
        };
        let (proving, unchecked, settled) = match check {
            FocusCheck::Clear { unchecked, settled } => (unchecked || !settled, unchecked, settled),
            FocusCheck::Due | FocusCheck::Unread => (false, false, true),
        };
        let every = if proving {
            FOCUS_READ_EVERY
        } else {
            STRETCH_READ_EVERY
        };
        if !proving
            && self.click_pressed().is_none_or(|pressed| {
                self.desktop.tick_now().wrapping_sub(pressed) >= STRETCH_READS_FOR_MS
            })
        {
            return;
        }
        if self.focus_reads.since_last(now) < every {
            return;
        }
        let movers = self.movers_waiting(hwnd);
        if movers.iter().any(|mover| mover.leaves) {
            if unchecked {
                self.set_focus_check(FocusCheck::Unread);
            }
            return;
        }
        let read = self.read_focus(now);
        self.drop_if_secret(read.secret);
        if !proving || self.checked_stretch().is_none() {
            return;
        }
        let settled_now = self
            .click_pressed()
            .is_none_or(|pressed| read.asked.wrapping_sub(pressed) >= FOCUS_SETTLE_MS);
        let next = match read.secret {
            None => FocusCheck::Unread,
            Some(_) if movers.is_empty() => FocusCheck::Clear {
                unchecked: false,
                settled: settled || settled_now,
            },
            Some(_) if unchecked => FocusCheck::Unread,
            Some(_) => check,
        };
        self.set_focus_check(next);
    }

    /// A key that can move focus (Tab, Enter, Escape, a key combination) was handled for the
    /// stretch that UI Automation checks: see [`FocusCheck::focus_key`] (#114).
    pub(super) fn focus_key_for_check(&mut self) {
        if let Some(stretch) = self.stretch.as_mut() {
            stretch.focus_check = stretch.focus_check.map(FocusCheck::focus_key);
        }
    }

    /// What waits to be handled that can move focus, all of it after the key being handled, for
    /// a stretch in the window `hwnd`: Tab, Enter, Escape, a key combination or a key to another
    /// window, read with a copy of the key reader, which knows which modifiers are held (#114);
    /// and clicks, presses and focus news.
    fn movers_waiting(&self, hwnd: isize) -> Vec<Mover> {
        let mut reader = self.reader.clone();
        let desktop = &self.desktop;
        let keys = self.pending.iter().filter_map(|(at, event)| {
            let action = reader.read(event, |vkey, scan, held, window| {
                desktop.typed_text(vkey, scan, held, window)
            });
            let leaves = (!event.up && event.foreground != hwnd)
                || matches!(action, Some(KeyAction::Combo(_)));
            let within = matches!(
                action,
                Some(KeyAction::Tab | KeyAction::Enter | KeyAction::Escape)
            );
            (leaves || within).then_some(Mover {
                at: *at,
                tick: event.tick_ms,
                leaves,
            })
        });
        let news = |at: Instant, tick: u32| Mover {
            at,
            tick,
            leaves: true,
        };
        let clicks = self
            .pending_clicks
            .iter()
            .map(|click| news(click.seen, click.tick));
        let presses = self
            .waiting_presses
            .iter()
            .map(|waiting| news(waiting.seen, waiting.tick));
        let focus = self
            .pending_focus
            .iter()
            .map(|(seen, note)| news(*seen, note.tick_ms));
        keys.chain(clicks).chain(presses).chain(focus).collect()
    }

    /// A read found a box that holds a password or a secret: nothing of the stretch in `hwnd` is
    /// kept, and the window is kept out until the next click (#97 fourth review).
    fn drop_checked(&mut self, hwnd: isize) {
        self.stretch = None;
        self.password.clicked_into(hwnd);
    }

    fn set_focus_check(&mut self, check: FocusCheck) {
        if let Some(stretch) = self.stretch.as_mut() {
            stretch.focus_check = Some(check);
        }
    }
}
