//! Whether the person brought an app to the front (docs/spec/02-capture.md#events, #67).
//!
//! An app comes to the front because of a click (into its window, on the taskbar, on a link or a
//! file that opens it), a tap, or keys (Alt+Tab, Win+number, a shortcut that starts it, Enter on a
//! search result), or by itself: in the 10/10/2026 test a remote-control tool's connection
//! manager raised itself and became `Open "RustDesk Remote Desktop"`. Clicks and taps are seen as
//! they happen.
//! Keys are read only in a recording with "Record what's typed", so otherwise a key is told by
//! Windows' last-input clock (the idle time on X11) moving when no mouse or touch input did. That
//! says only when, never which key. Mouse movement alone switches nothing.

/// How long before an app came to the front the input that brought it there can be: an app a
/// click or key starts shows its first window (often a splash screen) within a second or two.
const BROUGHT_WITHIN: u32 = 3_000;
/// The input thread and the window's own activation stamp times a tick apart, either way round.
const STAMPED_LATE: u32 = 100;
/// How much later than the latest mouse or touch input the last-input clock must be to show a key:
/// the input thread can stamp a movement a little after the clock took it (X11's idle time is
/// read to within 50 ms).
const NOT_THE_MOUSE: u32 = 100;

/// Whether tick `later` is after tick `earlier`, allowing for the message clock wrapping round
/// after 49.7 days.
const fn is_after(earlier: u32, later: u32) -> bool {
    let gap = later.wrapping_sub(earlier);
    gap > 0 && gap < 1 << 31
}

/// When the input thread last saw each kind of input, as message-clock ticks (ms, wrapping).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InputSeen {
    /// The latest mouse button press.
    pub press: Option<u32>,
    /// The latest mouse event of any kind: movement, a button, the wheel.
    pub mouse: Option<u32>,
    /// The latest touch screen or pen report.
    pub touch: Option<u32>,
    /// The latest key press, only in a recording with "Record what's typed".
    pub key: Option<u32>,
}

/// What input came before each app that comes to the front.
#[derive(Debug, Default)]
pub struct SwitchInput {
    /// The latest input the last-input clock showed that no mouse or touch input accounts for: a
    /// key, or a touchpad gesture.
    key: Option<u32>,
}

impl SwitchInput {
    /// Notes the last-input clock as it is now. Called often: the next mouse movement moves the
    /// clock on, and a key it showed before then would no longer show.
    pub fn note(&mut self, last_input: Option<u32>, seen: InputSeen) {
        let Some(input) = last_input else {
            return;
        };
        let pointer = [seen.mouse, seen.press, seen.touch]
            .into_iter()
            .flatten()
            .reduce(|latest, at| if is_after(latest, at) { at } else { latest });
        let not_the_pointer =
            pointer.is_none_or(|pointer| is_after(pointer.wrapping_add(NOT_THE_MOUSE), input));
        if not_the_pointer && self.key.is_none_or(|key| is_after(key, input)) {
            self.key = Some(input);
        }
    }

    /// Whether input that can switch windows came just before an app came to the front at
    /// `tick_ms`: a mouse button, a tap or a key, in the few seconds before.
    #[must_use]
    pub fn prompted(&self, tick_ms: u32, seen: InputSeen) -> bool {
        [seen.press, seen.touch, seen.key, self.key]
            .into_iter()
            .flatten()
            .any(|at| {
                let before = tick_ms.wrapping_sub(at);
                before <= BROUGHT_WITHIN || at.wrapping_sub(tick_ms) <= STAMPED_LATE
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mouse last moved at `moved`, and its button last went down at `pressed`.
    fn mouse(moved: u32, pressed: Option<u32>) -> InputSeen {
        InputSeen {
            press: pressed,
            mouse: Some(moved),
            ..InputSeen::default()
        }
    }

    #[test]
    fn a_window_raising_itself_with_no_input_before_it_is_unprompted() {
        let mut input = SwitchInput::default();
        let seen = mouse(1_000, Some(1_000));
        input.note(Some(1_000), seen);
        assert!(!input.prompted(20_000, seen));
    }

    #[test]
    fn a_click_into_another_window_brings_it_forward() {
        let mut input = SwitchInput::default();
        let seen = mouse(10_000, Some(10_000));
        input.note(Some(10_000), seen);
        assert!(input.prompted(10_016, seen));
    }

    #[test]
    fn an_app_a_click_opens_may_take_a_moment_to_show() {
        // A taskbar button, a file double-clicked, a link: the app's first window comes later.
        let input = SwitchInput::default();
        let seen = mouse(8_000, Some(8_000));
        assert!(input.prompted(10_500, seen));
        assert!(!input.prompted(8_000 + 3_500, seen));
    }

    #[test]
    fn alt_tab_is_seen_by_the_input_clock_without_listening_to_keys() {
        // No keys are read without "Record what's typed"; the last-input clock moves with them,
        // and the mouse doesn't account for it.
        let mut input = SwitchInput::default();
        let seen = mouse(4_000, Some(1_000));
        input.note(Some(4_000), seen);
        input.note(Some(9_990), seen);
        assert!(input.prompted(10_000, seen));
    }

    #[test]
    fn a_key_stays_seen_after_the_mouse_moves_again() {
        // Win+E, then the mouse moves while File Explorer opens: the clock shows only the move.
        let mut input = SwitchInput::default();
        input.note(Some(9_000), mouse(5_000, None));
        let moved = mouse(9_500, None);
        input.note(Some(9_500), moved);
        assert!(input.prompted(9_800, moved));
    }

    #[test]
    fn moving_the_mouse_brings_nothing_forward() {
        let mut input = SwitchInput::default();
        for at in (10_000..=20_000).step_by(8) {
            input.note(Some(at), mouse(at, Some(1_000)));
        }
        // The input thread can see a movement a moment after the clock does.
        input.note(Some(20_050), mouse(20_000, Some(1_000)));
        assert!(!input.prompted(20_060, mouse(20_000, Some(1_000))));
    }

    #[test]
    fn keys_read_for_the_recording_count() {
        let input = SwitchInput::default();
        let seen = InputSeen {
            key: Some(9_950),
            ..mouse(9_990, None)
        };
        assert!(input.prompted(10_000, seen));
    }

    #[test]
    fn a_tap_on_a_touch_screen_counts() {
        let input = SwitchInput::default();
        let seen = InputSeen {
            touch: Some(9_900),
            ..InputSeen::default()
        };
        assert!(input.prompted(10_000, seen));
    }

    #[test]
    fn input_only_after_the_window_came_forward_doesnt_count() {
        let input = SwitchInput::default();
        assert!(!input.prompted(10_000, mouse(12_000, Some(12_000))));
    }

    #[test]
    fn a_press_stamped_just_after_the_change_still_counts() {
        // The two clocks tick in steps: a click and the window it activates can come out a tick
        // apart, either way round.
        let input = SwitchInput::default();
        assert!(input.prompted(10_000, mouse(10_016, Some(10_016))));
    }

    #[test]
    fn the_message_clock_wrapping_round_changes_nothing() {
        let input = SwitchInput::default();
        let pressed = u32::MAX - 100;
        assert!(input.prompted(200, mouse(pressed, Some(pressed))));
        assert!(!input.prompted(5_000, mouse(pressed, Some(pressed))));
    }
}
