//! Start at login. Linux has no package startup task: the app uses the autostart plugin's
//! `~/.config/autostart` entry, as the Windows backup installers use the Run key. Everything here
//! answers "no package", so callers take that path.

/// Where starting at login stands in a packaged app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupState {
    Enabled,
    Disabled,
    DisabledByUser,
    ByPolicy(bool),
}

impl StartupState {
    /// Whether the app starts at login.
    #[must_use]
    pub fn is_on(self) -> bool {
        matches!(self, Self::Enabled | Self::ByPolicy(true))
    }
}

/// Always `None`: not a package.
#[must_use]
pub fn startup_state() -> Option<StartupState> {
    None
}

/// Always `None`: not a package.
#[must_use]
pub fn set_startup(_enabled: bool) -> Option<StartupState> {
    None
}

/// Always `false`: the autostart entry passes `--minimized` itself.
#[must_use]
pub fn launched_by_startup_task() -> bool {
    false
}
