//! Start with Windows in the Store package: the manifest's `StartupTask`
//! (docs/spec/10-distribution.md#microsoft-store). Both commands answer `None` when the app isn't
//! running from a package; the UI then uses the Run key through `tauri-plugin-autostart`, as the
//! backup installers do.

use capture::platform::startup::{StartupState, set_startup, startup_state};

fn name(state: StartupState) -> &'static str {
    match state {
        StartupState::Enabled => "enabled",
        StartupState::Disabled => "disabled",
        StartupState::DisabledByUser => "disabledByUser",
        StartupState::ByPolicy(true) => "enabledByPolicy",
        StartupState::ByPolicy(false) => "disabledByPolicy",
    }
}

/// The startup task's state, or `None` outside a package.
#[tauri::command(async)]
#[must_use]
pub fn startup_task_state() -> Option<&'static str> {
    startup_state().map(name)
}

/// Switches the startup task and returns its new state, or `None` outside a package. Switching
/// on can't undo the user's own "off" in Windows' Startup apps page; the state says so.
#[tauri::command(async)]
#[must_use]
pub fn startup_task_set(enabled: bool) -> Option<&'static str> {
    set_startup(enabled).map(name)
}

/// The Run value Start with Windows used before the rename to Steps (0.2.7).
#[cfg(windows)]
const OLD_RUN_VALUE: &str = "Amluto Steps";

/// Outside a package, Start with Windows is a Run value named after the app. Before 0.2.7 it was
/// "Amluto Steps", pointing at the old install; if it's there, it's replaced by the new one
/// pointing at this program, so someone who had Start with Windows on keeps it.
#[cfg(windows)]
pub fn move_old_run_entry(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};

    if capture::platform::package_full_name().is_some() {
        return;
    }
    let Ok(run) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_READ | KEY_SET_VALUE,
    ) else {
        return;
    };
    if run.get_raw_value(OLD_RUN_VALUE).is_err() {
        return;
    }
    if let Err(error) = run.delete_value(OLD_RUN_VALUE) {
        log::warn!("couldn't remove the old Start with Windows entry: {error}");
        return;
    }
    match app.autolaunch().enable() {
        Ok(()) => log::info!("Start with Windows moved to the new name"),
        Err(error) => log::warn!("couldn't switch Start with Windows back on: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_a_package_the_ui_falls_back_to_the_run_key() {
        assert_eq!(startup_task_state(), None);
        assert_eq!(startup_task_set(false), None);
        assert_eq!(name(StartupState::ByPolicy(false)), "disabledByPolicy");
    }
}
