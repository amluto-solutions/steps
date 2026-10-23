//! Steps started again while it's open (docs/spec/10-distribution.md#one-steps-at-a-time). The
//! second start exits (tauri-plugin-single-instance) and this copy decides what to do with it.

/// The argument a start with Windows passes (the autostart plugin and the setup's Run key).
const STARTED_WITH_WINDOWS: &str = "--minimized";

/// Whether a second start, with the arguments `args` it was given, brings this copy's main window
/// forward. It does, with nothing else to click (12/10/2026, #86: a notice saying Steps was
/// already open was one more click, P23). A start with Windows doesn't: it would pop the window up
/// at sign-in when two copies are both set to start with Windows.
#[must_use]
pub fn brings_window_forward(args: &[String]) -> bool {
    !args.iter().any(|argument| argument == STARTED_WITH_WINDOWS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn a_start_from_a_shortcut_brings_the_open_window_forward() {
        assert!(brings_window_forward(&args(&[
            "C:\\Program Files\\Steps\\amluto-steps.exe"
        ])));
    }

    #[test]
    fn a_start_with_windows_leaves_the_open_copy_where_it_is() {
        // Two copies both set to start with Windows (the setup's and a portable one): the second
        // one's start at sign-in shouldn't pop the first one's window up.
        assert!(!brings_window_forward(&args(&[
            "amluto-steps.exe",
            "--minimized"
        ])));
    }
}
