//! Start with Windows in the Store (MSIX) build (docs/spec/10-distribution.md#microsoft-store).
//!
//! Packaged apps can't use the Run key the backup installers use; they declare a `StartupTask`
//! in the manifest (`apps/desktop/msix/AppxManifest.xml`) and switch it with this `WinRT` API.
//! Everything here returns `None` when the app isn't running from a package, so callers fall back
//! to the Run key.

use windows::ApplicationModel::Activation::ActivationKind;
use windows::ApplicationModel::{AppInstance, StartupTask, StartupTaskState};
use windows::core::HSTRING;

use crate::package_full_name;

/// The manifest's `StartupTask` `TaskId`.
pub const STARTUP_TASK_ID: &str = "AmlutoStepsStartup";

/// Where Start with Windows stands in a packaged app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupState {
    /// On (the user or the app switched it on).
    Enabled,
    /// Off, and the app may switch it on.
    Disabled,
    /// Switched off in Windows' Startup apps page: only the user can switch it back on, there.
    DisabledByUser,
    /// Set by the organisation's policy, on or off.
    ByPolicy(bool),
}

impl StartupState {
    /// Whether the app starts with Windows.
    #[must_use]
    pub fn is_on(self) -> bool {
        matches!(self, Self::Enabled | Self::ByPolicy(true))
    }
}

fn from_winrt(state: StartupTaskState) -> StartupState {
    match state {
        StartupTaskState::Enabled => StartupState::Enabled,
        StartupTaskState::DisabledByUser => StartupState::DisabledByUser,
        StartupTaskState::EnabledByPolicy => StartupState::ByPolicy(true),
        StartupTaskState::DisabledByPolicy => StartupState::ByPolicy(false),
        _ => StartupState::Disabled,
    }
}

fn task() -> Option<StartupTask> {
    package_full_name()?;
    StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID))
        .and_then(|operation| operation.join())
        .ok()
}

/// The startup task's state, or `None` when the app isn't packaged (or the task can't be read).
#[must_use]
pub fn startup_state() -> Option<StartupState> {
    task()?.State().ok().map(from_winrt)
}

/// Switches the startup task on or off and returns its new state. Switching on can't override
/// the user's own "off" in Windows' Startup apps page or a policy; the state returned says so.
/// `None` when the app isn't packaged.
#[must_use]
pub fn set_startup(enabled: bool) -> Option<StartupState> {
    let task = task()?;
    if enabled {
        task.RequestEnableAsync()
            .and_then(|operation| operation.join())
            .ok()
            .map(from_winrt)
    } else {
        task.Disable().ok()?;
        task.State().ok().map(from_winrt)
    }
}

/// Whether Windows started this run of a packaged app through the startup task (so it should
/// start in the tray, as the Run key's `--minimized` does for the backup installers).
#[must_use]
pub fn launched_by_startup_task() -> bool {
    package_full_name().is_some()
        && AppInstance::GetActivatedEventArgs()
            .and_then(|arguments| arguments.Kind())
            .is_ok_and(|kind| kind == ActivationKind::StartupTask)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_enabled_states_start_with_windows() {
        assert!(StartupState::Enabled.is_on());
        assert!(StartupState::ByPolicy(true).is_on());
        assert!(!StartupState::Disabled.is_on());
        assert!(!StartupState::DisabledByUser.is_on());
        assert!(!StartupState::ByPolicy(false).is_on());
    }

    #[test]
    fn an_unpackaged_run_has_no_startup_task() {
        // Tests never run from a package, so every call falls back.
        assert_eq!(startup_state(), None);
        assert_eq!(set_startup(true), None);
        assert!(!launched_by_startup_task());
    }
}
