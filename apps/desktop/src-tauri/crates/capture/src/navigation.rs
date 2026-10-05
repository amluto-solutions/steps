//! Waiting for a browser's address to settle before it becomes a "Go to" step.
//!
//! A link from an email often passes through a link checker or a sign-in page before the site
//! itself, and each hop sat in the address bar long enough to be read, so one click made a
//! "Go to" step per hop (testing, 28/09/2026). A new address is now held until it has
//! stayed the same for `SETTLE`, and only the last one becomes a step. Anything else recorded
//! meanwhile (a click, typing, an app switch) writes it first, so the steps stay in order.

use std::time::{Duration, Instant};

/// How long an address must stay the same to count as where the browser went.
pub const SETTLE: Duration = Duration::from_millis(1500);
/// A page that keeps changing its address (a slideshow, a live search) is still recorded.
pub const LONGEST_WAIT: Duration = Duration::from_secs(8);
/// How often the address bar is read while an address is settling.
pub const SETTLING_POLL: Duration = Duration::from_millis(400);

/// How recently the address bar must have had the keyboard for a new address to count as typed
/// or picked there: the bar is read every 0.4 to 1.2 seconds, and a slow site may take a few
/// seconds to show its address after Enter.
pub const TYPED_WITHIN: Duration = Duration::from_secs(10);

/// One reading of a browser's address bar.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BarRead {
    /// The page's origin; none while the bar has the keyboard, since it may hold a search.
    pub origin: Option<String>,
    /// Whether the bar had the keyboard: the person is typing or picking an address there.
    pub focused: bool,
}

/// An address read from the address bar and not yet written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNavigation<W> {
    pub pid: u32,
    pub origin: String,
    pub window: W,
    /// Whether it was typed or picked in the address bar (04/10/2026: "Go to" steps only for
    /// those, not for links followed on a page, redirects, or the page a recording starts on).
    pub typed: bool,
    /// When the first address of the chain was read: the step's time.
    pub tick_ms: u32,
    first_at: Instant,
    changed_at: Instant,
}

#[derive(Debug)]
pub struct NavigationSettle<W> {
    pending: Option<PendingNavigation<W>>,
}

impl<W> Default for NavigationSettle<W> {
    fn default() -> Self {
        Self { pending: None }
    }
}

impl<W> NavigationSettle<W> {
    /// Whether an address is waiting to settle (the bar is read more often meanwhile).
    #[must_use]
    pub const fn is_settling(&self) -> bool {
        self.pending.is_some()
    }

    /// An address read from the bar. A change in the same browser replaces the waiting address
    /// and starts the wait again. An address in another browser process writes the waiting one
    /// first, which is returned.
    pub fn seen(
        &mut self,
        pid: u32,
        origin: String,
        window: W,
        tick_ms: u32,
        typed: bool,
        now: Instant,
    ) -> Option<PendingNavigation<W>> {
        match &mut self.pending {
            Some(pending) if pending.pid == pid => {
                // A typed address that redirects stays typed.
                pending.typed |= typed;
                if pending.origin != origin {
                    pending.origin = origin;
                    pending.window = window;
                    pending.changed_at = now;
                }
                None
            }
            _ => self.pending.replace(PendingNavigation {
                pid,
                origin,
                window,
                typed,
                tick_ms,
                first_at: now,
                changed_at: now,
            }),
        }
    }

    /// The waiting address, once it has settled or waited as long as it may.
    pub fn due(&mut self, now: Instant) -> Option<PendingNavigation<W>> {
        let ready = self.pending.as_ref().is_some_and(|pending| {
            now.duration_since(pending.changed_at) >= SETTLE
                || now.duration_since(pending.first_at) >= LONGEST_WAIT
        });
        if ready { self.pending.take() } else { None }
    }

    /// The waiting address, whether settled or not: something else is about to be recorded.
    pub const fn flush(&mut self) -> Option<PendingNavigation<W>> {
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn later(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn a_redirect_chain_becomes_one_step_at_the_last_address() {
        let start = Instant::now();
        let mut settle = NavigationSettle::default();
        assert!(
            settle
                .seen(7, "safelinks.test".into(), (), 100, true, start)
                .is_none()
        );
        assert!(settle.is_settling());
        assert!(settle.due(later(start, 1000)).is_none());
        settle.seen(7, "login.test".into(), (), 1100, false, later(start, 1000));
        settle.seen(7, "portal.test".into(), (), 1500, false, later(start, 1400));
        // 1.5 s after the last change, not after the first read.
        assert!(settle.due(later(start, 2600)).is_none());
        let step = settle.due(later(start, 2900)).expect("settled");
        assert_eq!(step.origin, "portal.test");
        // Typed at the start of the chain, so the address it ended at was typed too.
        assert!(step.typed);
        // The step keeps the time of the click's first address, so it sorts after the click.
        assert_eq!(step.tick_ms, 100);
        assert!(!settle.is_settling());
    }

    #[test]
    fn the_same_address_read_again_doesnt_restart_the_wait() {
        let start = Instant::now();
        let mut settle = NavigationSettle::default();
        settle.seen(7, "portal.test".into(), (), 100, false, start);
        settle.seen(7, "portal.test".into(), (), 900, false, later(start, 800));
        assert!(settle.due(later(start, 1500)).is_some());
    }

    #[test]
    fn an_address_that_never_settles_is_still_recorded() {
        let start = Instant::now();
        let mut settle = NavigationSettle::default();
        for step in 0..30_u32 {
            let at = later(start, u64::from(step) * 300);
            settle.seen(7, format!("page{step}.test"), (), step, false, at);
            if let Some(found) = settle.due(at) {
                assert!(step * 300 >= 8000);
                assert_eq!(found.tick_ms, 0);
                return;
            }
        }
        panic!("never recorded");
    }

    #[test]
    fn another_browser_or_another_step_writes_the_waiting_address_first() {
        let start = Instant::now();
        let mut settle = NavigationSettle::default();
        settle.seen(7, "a.test".into(), (), 1, false, start);
        let earlier = settle.seen(9, "b.test".into(), (), 2, false, later(start, 200));
        assert_eq!(earlier.map(|found| found.origin).as_deref(), Some("a.test"));
        assert_eq!(
            settle.flush().map(|found| found.origin).as_deref(),
            Some("b.test")
        );
        assert!(settle.flush().is_none());
    }
}
