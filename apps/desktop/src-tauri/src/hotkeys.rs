//! Global shortcuts: which key combinations run which recorder actions, saved per user in
//! `%APPDATA%\Amluto\Steps\shortcuts.json` and changeable in Settings. Each combination is
//! registered with Windows through tauri-plugin-global-shortcut; no other keyboard input is read
//! (docs/spec/08-privacy-and-security.md#antivirus--edr-rules).
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::recorder::CommandError;

/// What a shortcut does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    StartRecording,
    TogglePause,
    Stop,
    CaptureNow,
    AddShortcut,
}

/// Every action, in the order Settings lists them.
pub const ACTIONS: [HotkeyAction; 5] = [
    HotkeyAction::StartRecording,
    HotkeyAction::TogglePause,
    HotkeyAction::Stop,
    HotkeyAction::CaptureNow,
    HotkeyAction::AddShortcut,
];

/// The shipped combinations. Start was added on 25/09/2026.
fn default_keys(action: HotkeyAction) -> &'static str {
    match action {
        HotkeyAction::StartRecording => "ctrl+alt+shift+n",
        HotkeyAction::TogglePause => "ctrl+alt+shift+r",
        HotkeyAction::Stop => "ctrl+alt+shift+x",
        HotkeyAction::CaptureNow => "ctrl+alt+shift+s",
        HotkeyAction::AddShortcut => "ctrl+alt+shift+k",
    }
}

/// One row in Settings → Keyboard shortcuts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyBinding {
    pub action: HotkeyAction,
    /// `ctrl+alt+shift+k` style, or `None` when switched off.
    pub keys: Option<String>,
    /// False when Windows refused the combination (another app already uses it).
    pub registered: bool,
    /// Not registered while another copy of Steps is running, which most likely holds it.
    pub held_by_steps: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredHotkeys {
    format_version: u32,
    keys: HashMap<HotkeyAction, Option<String>>,
}

/// Checks and normalises a combination: `ctrl`/`alt`/`shift` then one letter, digit or F-key,
/// joined with `+`, including Ctrl or Alt so ordinary typing is never caught.
pub fn normalise_keys(keys: &str) -> Option<String> {
    let tokens: Vec<String> = keys
        .split('+')
        .map(|token| token.trim().to_ascii_lowercase())
        .collect();
    let (key, modifiers) = tokens.split_last()?;
    let mut has = [false; 3];
    for modifier in modifiers {
        let slot = match modifier.as_str() {
            "ctrl" | "control" => 0,
            "alt" => 1,
            "shift" => 2,
            _ => return None,
        };
        if has[slot] {
            return None;
        }
        has[slot] = true;
    }
    if !has[0] && !has[1] {
        return None;
    }
    let valid_key = (key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric()))
        || key
            .strip_prefix('f')
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number));
    if !valid_key {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for (present, name) in has.iter().zip(["ctrl", "alt", "shift"]) {
        if *present {
            parts.push(name);
        }
    }
    parts.push(key);
    Some(parts.join("+"))
}

/// Start and Stop may share one combination: pressed when idle it starts, pressed while
/// recording it stops (28/09/2026). No other pair may share.
fn partner(action: HotkeyAction) -> Option<HotkeyAction> {
    match action {
        HotkeyAction::StartRecording => Some(HotkeyAction::Stop),
        HotkeyAction::Stop => Some(HotkeyAction::StartRecording),
        _ => None,
    }
}

fn parse_shortcut(keys: &str) -> Option<Shortcut> {
    keys.parse::<Shortcut>().ok()
}

#[derive(Default)]
struct Inner {
    path: Option<PathBuf>,
    keys: HashMap<HotkeyAction, Option<String>>,
    /// Shortcut id → action, for the combinations Windows accepted. A combination Start and Stop
    /// share is registered once, under whichever registered it first.
    registered: HashMap<u32, HotkeyAction>,
    /// True while Settings is reading a new combination: nothing is registered with Windows, so
    /// the keys reach the box instead of running an action.
    suspended: bool,
}

/// Holds the current combinations and what is registered.
#[derive(Default)]
pub struct HotkeyService {
    inner: Mutex<Inner>,
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn read_stored(path: &Path) -> HashMap<HotkeyAction, Option<String>> {
    let stored = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoredHotkeys>(&bytes).ok())
        .filter(|stored| stored.format_version == 1);
    ACTIONS
        .iter()
        .map(|action| {
            let keys = match stored.as_ref().and_then(|stored| stored.keys.get(action)) {
                // A damaged entry falls back to the default rather than silently switching off.
                Some(Some(keys)) => {
                    normalise_keys(keys).or_else(|| Some(default_keys(*action).into()))
                }
                Some(None) => None,
                None => Some(default_keys(*action).into()),
            };
            (*action, keys)
        })
        .collect()
}

fn write_stored(path: &Path, keys: &HashMap<HotkeyAction, Option<String>>) -> std::io::Result<()> {
    let stored = StoredHotkeys {
        format_version: 1,
        keys: keys.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&stored).map_err(std::io::Error::other)?;
    library::write_atomic(path, &bytes)
}

impl HotkeyService {
    /// Reads the saved combinations and registers them. A combination another program owns is
    /// logged and shown as unavailable in Settings; it never stops the app starting.
    pub fn initialize(&self, app: &AppHandle) {
        // The same folder as the recorder settings (docs/spec/03-data-and-sharing.md#app-data-desktop-per-user).
        let path =
            crate::app_folder::app_folder(app).map(|directory| directory.join("shortcuts.json"));
        let keys = path
            .as_deref()
            .map_or_else(|| read_stored(Path::new("")), read_stored);
        let mut inner = lock(&self.inner);
        inner.path = path;
        inner.keys = keys;
        for action in ACTIONS {
            if let Some(keys) = inner.keys.get(&action).cloned().flatten() {
                register(app, &mut inner, action, &keys);
            }
        }
    }

    /// The action a pressed shortcut belongs to.
    pub fn action_for(&self, shortcut: &Shortcut) -> Option<HotkeyAction> {
        lock(&self.inner).registered.get(&shortcut.id()).copied()
    }

    /// Whether Start and Stop are one combination, which then starts or stops as needed.
    pub fn start_stop_shared(&self) -> bool {
        let inner = lock(&self.inner);
        let start = inner
            .keys
            .get(&HotkeyAction::StartRecording)
            .cloned()
            .flatten();
        start.is_some() && start == inner.keys.get(&HotkeyAction::Stop).cloned().flatten()
    }

    /// Stops or restarts every shortcut, for while Settings reads a new combination. Pressing
    /// Start's keys in the box would otherwise start a recording instead of being read.
    fn suspend(&self, app: &AppHandle, suspended: bool) -> Vec<HotkeyBinding> {
        let mut inner = lock(&self.inner);
        if inner.suspended != suspended {
            inner.suspended = suspended;
            let current: Vec<(HotkeyAction, String)> = ACTIONS
                .iter()
                .filter_map(|action| Some((*action, inner.keys.get(action).cloned().flatten()?)))
                .collect();
            for (action, keys) in current {
                if suspended {
                    unregister(app, &mut inner, &keys);
                } else {
                    register(app, &mut inner, action, &keys);
                }
            }
        }
        Self::bindings(&inner)
    }

    fn bindings(inner: &Inner) -> Vec<HotkeyBinding> {
        let mut list: Vec<HotkeyBinding> = ACTIONS
            .iter()
            .map(|action| {
                let keys = inner.keys.get(action).cloned().flatten();
                let registered = keys
                    .as_deref()
                    .and_then(parse_shortcut)
                    .is_some_and(|shortcut| {
                        inner.registered.get(&shortcut.id()).is_some_and(|owner| {
                        owner == action || Some(*owner) == partner(*action)
                    })
                    // While Settings reads keys nothing is registered, and that's not a problem.
                    || inner.suspended
                    });
                HotkeyBinding {
                    action: *action,
                    keys,
                    registered,
                    held_by_steps: false,
                }
            })
            .collect();
        // Windows doesn't say who holds a combination; another Steps (the installed one beside a
        // portable one, say) is the likely one, and the only one Steps can recognise.
        if list
            .iter()
            .any(|binding| binding.keys.is_some() && !binding.registered)
            && capture::platform::window::other_steps_running()
        {
            for binding in &mut list {
                binding.held_by_steps = binding.keys.is_some() && !binding.registered;
            }
        }
        list
    }

    fn set(
        &self,
        app: &AppHandle,
        action: HotkeyAction,
        keys: Option<&str>,
    ) -> Result<Vec<HotkeyBinding>, CommandError> {
        let keys = match keys {
            Some(keys) => Some(normalise_keys(keys).ok_or_else(|| {
                CommandError::new(
                    "invalidShortcut",
                    "Use Ctrl or Alt with a letter, number or F-key.",
                )
            })?),
            None => None,
        };
        let mut inner = lock(&self.inner);
        if let Some(keys) = &keys
            && let Some((other, _)) = inner.keys.iter().find(|(other, existing)| {
                **other != action
                    && Some(**other) != partner(action)
                    && existing.as_deref() == Some(keys)
            })
        {
            return Err(CommandError::new(
                "shortcutInUse",
                format!(
                    "That combination is already used for {}.",
                    action_name(*other)
                ),
            ));
        }
        let previous = inner.keys.get(&action).cloned().flatten();
        if let Some(previous) = &previous {
            release(app, &mut inner, action, previous);
        }
        if let Some(keys) = &keys
            && !register(app, &mut inner, action, keys)
        {
            if let Some(previous) = &previous {
                register(app, &mut inner, action, previous);
            }
            return Err(CommandError::new(
                "shortcutTaken",
                "Windows or another app already uses that combination. Try a different one.",
            ));
        }
        inner.keys.insert(action, keys);
        save(&inner)?;
        Ok(Self::bindings(&inner))
    }

    fn reset(&self, app: &AppHandle) -> Result<Vec<HotkeyBinding>, CommandError> {
        let mut inner = lock(&self.inner);
        let current: Vec<String> = inner.keys.values().flatten().cloned().collect();
        for keys in current {
            unregister(app, &mut inner, &keys);
        }
        for action in ACTIONS {
            let keys = default_keys(action).to_string();
            register(app, &mut inner, action, &keys);
            inner.keys.insert(action, Some(keys));
        }
        save(&inner)?;
        Ok(Self::bindings(&inner))
    }
}

fn action_name(action: HotkeyAction) -> &'static str {
    match action {
        HotkeyAction::StartRecording => "Start a recording",
        HotkeyAction::TogglePause => "Pause or resume",
        HotkeyAction::Stop => "Stop",
        HotkeyAction::CaptureNow => "Capture now",
        HotkeyAction::AddShortcut => "Show a keyboard shortcut",
    }
}

fn register(app: &AppHandle, inner: &mut Inner, action: HotkeyAction, keys: &str) -> bool {
    let Some(shortcut) = parse_shortcut(keys) else {
        return false;
    };
    // Already ours: this action's, or Start and Stop sharing one combination.
    if let Some(owner) = inner.registered.get(&shortcut.id()) {
        return *owner == action || Some(*owner) == partner(action);
    }
    match app.global_shortcut().register(shortcut) {
        Ok(()) => {
            inner.registered.insert(shortcut.id(), action);
            true
        }
        Err(error) => {
            log::error!("The {keys} shortcut is unavailable (another app may use it): {error}");
            false
        }
    }
}

/// Lets go of an action's old combination. One Start and Stop share stays registered for the
/// other, and passes to it if this action held it.
fn release(app: &AppHandle, inner: &mut Inner, action: HotkeyAction, keys: &str) {
    let shared = partner(action)
        .filter(|other| inner.keys.get(other).cloned().flatten().as_deref() == Some(keys));
    match (shared, parse_shortcut(keys)) {
        (Some(other), Some(shortcut)) => {
            if inner.registered.get(&shortcut.id()) == Some(&action) {
                inner.registered.insert(shortcut.id(), other);
            }
        }
        _ => unregister(app, inner, keys),
    }
}

fn unregister(app: &AppHandle, inner: &mut Inner, keys: &str) {
    if let Some(shortcut) = parse_shortcut(keys) {
        let _ = app.global_shortcut().unregister(shortcut);
        inner.registered.remove(&shortcut.id());
    }
}

fn save(inner: &Inner) -> Result<(), CommandError> {
    let Some(path) = &inner.path else {
        return Err(CommandError::new(
            "notReady",
            "Shortcut settings are not available yet.",
        ));
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| CommandError::new("storage", error.to_string()))?;
    }
    write_stored(path, &inner.keys).map_err(|error| CommandError::new("storage", error.to_string()))
}

#[tauri::command]
pub fn hotkeys_get(service: State<'_, HotkeyService>) -> Vec<HotkeyBinding> {
    HotkeyService::bindings(&lock(&service.inner))
}

#[tauri::command(rename_all = "camelCase")]
pub fn hotkeys_set(
    app: AppHandle,
    service: State<'_, HotkeyService>,
    action: HotkeyAction,
    keys: Option<String>,
) -> Result<Vec<HotkeyBinding>, CommandError> {
    service.set(&app, action, keys.as_deref())
}

/// Settings calls this with `true` while its box waits for keys, and `false` when it closes.
#[tauri::command]
pub fn hotkeys_suspend(
    app: AppHandle,
    service: State<'_, HotkeyService>,
    suspended: bool,
) -> Vec<HotkeyBinding> {
    service.suspend(&app, suspended)
}

#[tauri::command]
pub fn hotkeys_reset(
    app: AppHandle,
    service: State<'_, HotkeyService>,
) -> Result<Vec<HotkeyBinding>, CommandError> {
    service.reset(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combinations_are_normalised_and_must_use_ctrl_or_alt() {
        assert_eq!(
            normalise_keys("Shift + Ctrl + Alt + K").as_deref(),
            Some("ctrl+alt+shift+k")
        );
        assert_eq!(normalise_keys("ctrl+f12").as_deref(), Some("ctrl+f12"));
        assert_eq!(normalise_keys("alt+7").as_deref(), Some("alt+7"));
        assert_eq!(normalise_keys("shift+k"), None);
        assert_eq!(normalise_keys("k"), None);
        assert_eq!(normalise_keys("ctrl+ctrl+k"), None);
        assert_eq!(normalise_keys("ctrl+win+k"), None);
        assert_eq!(normalise_keys("ctrl+enter"), None);
        assert_eq!(normalise_keys("ctrl+f25"), None);
    }

    #[test]
    fn every_default_is_valid_and_parses_as_a_shortcut() {
        for action in ACTIONS {
            let keys = default_keys(action);
            assert_eq!(normalise_keys(keys).as_deref(), Some(keys));
            assert!(parse_shortcut(keys).is_some());
        }
    }

    #[test]
    fn saved_choices_survive_and_damaged_entries_fall_back() {
        let folder = tempfile::tempdir().expect("temp dir");
        let path = folder.path().join("shortcuts.json");
        let mut keys = read_stored(&path);
        assert_eq!(
            keys.get(&HotkeyAction::StartRecording)
                .cloned()
                .flatten()
                .as_deref(),
            Some("ctrl+alt+shift+n")
        );
        keys.insert(HotkeyAction::Stop, None);
        keys.insert(HotkeyAction::CaptureNow, Some("not a shortcut".into()));
        write_stored(&path, &keys).expect("write");
        let read = read_stored(&path);
        assert_eq!(read.get(&HotkeyAction::Stop), Some(&None));
        assert_eq!(
            read.get(&HotkeyAction::CaptureNow)
                .cloned()
                .flatten()
                .as_deref(),
            Some("ctrl+alt+shift+s")
        );
        fs::write(&path, b"{ broken").expect("write");
        assert_eq!(read_stored(&path).len(), ACTIONS.len());
    }
}
