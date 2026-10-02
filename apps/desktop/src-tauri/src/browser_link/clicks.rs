//! Clicks Steps for Chrome and Edge reported, waiting to meet the desktop's own
//! (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together). A browser's click only
//! ever rewords a click the desktop recorded itself: the same browser, the same moment and the
//! same tab. Anything else is left to expire.
use std::collections::VecDeque;

use capture::facts::PageTarget;

use super::protocol::Browser;

/// At most this many wait at once: a page can't fill the app's memory.
const MAX_WAITING: usize = 16;
/// A click not met within this long never will be.
const KEPT_MS: u32 = 2_000;
/// The most the browser's moment and the desktop's may differ for one press.
pub const MATCH_MS: u32 = 400;

/// A pointer going down in a web page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageClick {
    /// When it happened, on the app's tick clock (milliseconds, wrapping).
    pub at: u32,
    pub browser: Browser,
    /// The tab's title, to tell which window it was in.
    pub title: String,
    pub target: Option<PageTarget>,
}

/// Milliseconds between two ticks, either way round (ticks wrap every 49.7 days).
fn apart(left: u32, right: u32) -> u32 {
    left.wrapping_sub(right).min(right.wrapping_sub(left))
}

/// Runs of white space as one space, and none at either end, as browsers show titles.
fn squashed(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether a click in a tab titled `page` can be in a window titled `window`: the browser puts
/// the active tab's title first (`Invoices - Google Chrome`, `Invoices and 3 more pages - Work -
/// Microsoft Edge`). An empty title on either side says nothing either way.
fn same_tab(window: &str, page: &str) -> bool {
    let (window, page) = (squashed(window), squashed(page));
    window.is_empty() || page.is_empty() || window.starts_with(&page)
}

#[derive(Debug, Default)]
pub struct PageClicks {
    waiting: VecDeque<PageClick>,
}

impl PageClicks {
    /// Keeps a browser's click to meet the desktop's, dropping any too old to.
    pub fn add(&mut self, click: PageClick, now: u32) {
        self.expire(now);
        if self.waiting.len() == MAX_WAITING {
            self.waiting.pop_front();
        }
        self.waiting.push_back(click);
    }

    fn expire(&mut self, now: u32) {
        self.waiting
            .retain(|click| now.wrapping_sub(click.at) <= KEPT_MS);
    }

    /// Takes the browser's click that was the desktop's press at tick `pressed` in a window of
    /// `browser` titled `window_title`: the nearest in time, within [`MATCH_MS`].
    pub fn take(
        &mut self,
        browser: Browser,
        pressed: u32,
        window_title: &str,
        now: u32,
    ) -> Option<PageClick> {
        self.expire(now);
        let index = self
            .waiting
            .iter()
            .enumerate()
            .filter(|(_, click)| {
                click.browser == browser
                    && apart(click.at, pressed) <= MATCH_MS
                    && same_tab(window_title, &click.title)
            })
            .min_by_key(|(_, click)| apart(click.at, pressed))
            .map(|(index, _)| index)?;
        self.waiting.remove(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(at: u32, browser: Browser, title: &str, text: &str) -> PageClick {
        PageClick {
            at,
            browser,
            title: title.into(),
            target: Some(PageTarget {
                tag_name: Some("BUTTON".into()),
                inner_text: Some(text.into()),
                ..PageTarget::default()
            }),
        }
    }

    fn text(click: Option<PageClick>) -> Option<String> {
        click.and_then(|click| click.target?.inner_text)
    }

    #[test]
    fn a_click_meets_the_press_in_the_same_browser_moment_and_tab() {
        let mut clicks = PageClicks::default();
        clicks.add(click(1_000, Browser::Chrome, "Invoices", "Approve"), 1_020);
        // Another browser, another tab, or another moment: not this press.
        assert_eq!(
            clicks.take(Browser::Edge, 1_005, "Invoices - Microsoft Edge", 1_100),
            None
        );
        assert_eq!(
            clicks.take(Browser::Chrome, 1_005, "Payroll - Google Chrome", 1_100),
            None
        );
        assert_eq!(
            clicks.take(Browser::Chrome, 1_500, "Invoices - Google Chrome", 1_600),
            None
        );
        assert_eq!(
            text(clicks.take(Browser::Chrome, 990, "Invoices - Google Chrome", 1_100)),
            Some("Approve".into())
        );
        // Taken once only.
        assert_eq!(
            clicks.take(Browser::Chrome, 990, "Invoices - Google Chrome", 1_100),
            None
        );
    }

    #[test]
    fn the_nearest_in_time_wins() {
        let mut clicks = PageClicks::default();
        clicks.add(click(1_000, Browser::Edge, "Mail", "Reply"), 1_000);
        clicks.add(click(1_300, Browser::Edge, "Mail", "Send"), 1_300);
        assert_eq!(
            text(clicks.take(
                Browser::Edge,
                1_280,
                "Mail and 2 more pages - Work - Microsoft\u{200b} Edge",
                1_400
            )),
            Some("Send".into())
        );
        assert_eq!(
            text(clicks.take(Browser::Edge, 1_010, "Mail - Microsoft Edge", 1_400)),
            Some("Reply".into())
        );
    }

    #[test]
    fn titles_are_compared_as_shown_and_an_empty_one_doesnt_decide() {
        assert!(same_tab(
            "  Invoices   2026 - Google Chrome",
            "Invoices 2026"
        ));
        assert!(same_tab("Google Chrome", ""));
        assert!(same_tab("", "Invoices"));
        assert!(!same_tab("Invoice - Google Chrome", "Invoices"));
    }

    #[test]
    fn old_clicks_expire_and_only_sixteen_wait() {
        let mut clicks = PageClicks::default();
        clicks.add(click(1_000, Browser::Chrome, "", "Old"), 1_000);
        clicks.add(click(3_500, Browser::Chrome, "", "New"), 3_500);
        assert_eq!(clicks.waiting.len(), 1);
        for at in 0..20 {
            clicks.add(click(3_500 + at, Browser::Chrome, "", "Many"), 3_520);
        }
        assert_eq!(clicks.waiting.len(), MAX_WAITING);
    }

    #[test]
    fn ticks_that_wrap_still_meet() {
        let mut clicks = PageClicks::default();
        clicks.add(click(u32::MAX - 10, Browser::Chrome, "", "Wrapped"), 5);
        assert_eq!(
            text(clicks.take(Browser::Chrome, 20, "", 30)),
            Some("Wrapped".into())
        );
    }
}
