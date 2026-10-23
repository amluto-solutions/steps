//! The main window's close button and the tray's Quit (docs/spec/04-editor.md#leaving-the-editor).
//! Closing hides the window to the tray; Quit ends the app. While the editor has changes it
//! couldn't save, the page holds both so it can ask first, and closes or quits itself if the person
//! goes anyway.
//!
//! It also remembers whether the window was maximised (docs/spec/04-editor.md, #84), so Steps
//! opens maximised next time if it was when it last closed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Window};

/// What's kept of the main window between runs, in `window.json` in the PC's own app folder.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    maximised: bool,
}

/// Whether the main window is maximised, as last seen, and where that's kept.
#[derive(Debug, Default)]
pub struct WindowMemory {
    file: Option<PathBuf>,
    maximised: AtomicBool,
}

impl WindowMemory {
    /// What was kept in `file`. Nothing kept, or a file that can't be read, opens the window as
    /// configured; with no file at all it's remembered for this run only.
    #[must_use]
    pub fn read(file: Option<PathBuf>) -> Self {
        let maximised = file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice::<Kept>(&bytes).ok())
            .is_some_and(|kept| kept.maximised);
        Self {
            file,
            maximised: AtomicBool::new(maximised),
        }
    }

    /// Whether the window opens maximised.
    #[must_use]
    pub fn maximised(&self) -> bool {
        self.maximised.load(Ordering::SeqCst)
    }

    /// The window was resized, maximised or restored. Minimised, Windows reports it as not
    /// maximised, though it comes back maximised, so that's left as it was. Written only when it
    /// changes.
    pub fn update(&self, maximised: bool, minimised: bool) {
        if minimised || self.maximised.swap(maximised, Ordering::SeqCst) == maximised {
            return;
        }
        if let Some(file) = &self.file
            && let Err(error) = write_kept(file, &Kept { maximised })
        {
            log::warn!(
                "couldn't keep the window's state in {}: {error}",
                file.display()
            );
        }
    }
}

fn write_kept(file: &Path, kept: &Kept) -> std::io::Result<()> {
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)?;
    }
    std::fs::write(
        file,
        serde_json::to_vec(kept).map_err(std::io::Error::other)?,
    )
}

/// The main window was resized: keeps whether it's maximised for next time.
pub fn resized(window: &Window) {
    if let Some(memory) = window.try_state::<WindowMemory>()
        && let (Ok(maximised), Ok(minimised)) = (window.is_maximized(), window.is_minimized())
    {
        memory.update(maximised, minimised);
    }
}

/// Whether the page asked to be told before the main window closes.
#[derive(Debug, Default)]
pub struct CloseGuard(AtomicBool);

impl CloseGuard {
    /// Whether closing waits for the page now.
    #[must_use]
    pub fn asking(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn set(&self, asking: bool) {
        self.0.store(asking, Ordering::SeqCst);
    }
}

/// While `asking` (a save is failing in the editor), the main window's close button tells the
/// page instead of hiding the window. The page says so again at every start, so a page that
/// reloaded meanwhile lets go.
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take their arguments by value"
)]
#[tauri::command(rename_all = "camelCase")]
pub fn main_window_ask_before_close(guard: State<'_, CloseGuard>, asking: bool) {
    guard.set(asking);
}

/// The main window's close button was pressed: the window hides to the tray, or, while the page
/// asks to be told, stays for the page to ask first. It's never destroyed: the hidden recorder
/// windows keep the app running, and a destroyed main window could never be reopened.
pub fn close_requested(window: &Window) {
    if window
        .try_state::<CloseGuard>()
        .is_some_and(|guard| guard.asking())
    {
        let _ = window.emit_to("main", "steps://close-asked", ());
    } else {
        let _ = window.hide();
    }
}

/// What the tray's Quit does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnQuit {
    /// Quits now (stopping any recording first).
    Quit,
    /// Brings the main window forward for the page to ask first.
    AskFirst,
}

/// Quit asks first while the page holds the close (a save is failing in the editor), as closing
/// the window does. A recording keeps its Quit: it's stopped and kept, then the app goes.
#[must_use]
pub fn on_quit(guard: &CloseGuard, recording: bool) -> OnQuit {
    if guard.asking() && !recording {
        OnQuit::AskFirst
    } else {
        OnQuit::Quit
    }
}

/// The tray's Quit was chosen: quits, or, while a save is failing, shows the main window and lets
/// the page ask. With no main window to ask in, it quits as before rather than never quitting.
pub fn quit_requested(app: &AppHandle) {
    let recording = app
        .try_state::<crate::recorder::RecorderService>()
        .is_some_and(|service| service.is_recording_active());
    let asks = app
        .try_state::<CloseGuard>()
        .is_some_and(|guard| on_quit(&guard, recording) == OnQuit::AskFirst);
    if asks
        && app.get_webview_window("main").is_some()
        && app.emit_to("main", "steps://quit-asked", ()).is_ok()
    {
        crate::show_main_window(app);
        return;
    }
    crate::quit(app);
}

/// The person chose Quit anyway when Quit asked: quits as the tray's Quit does when nothing holds
/// it.
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands take their arguments by value"
)]
#[tauri::command]
pub fn main_window_quit(app: AppHandle) {
    crate::quit(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_maximised_when_last_seen_opens_maximised_next_time() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("Local").join("window.json");
        // Nothing kept yet (a new PC, or the first run of this version): as configured.
        assert!(!WindowMemory::read(Some(file.clone())).maximised());

        let memory = WindowMemory::read(Some(file.clone()));
        memory.update(true, false);
        assert!(memory.maximised());
        assert!(WindowMemory::read(Some(file.clone())).maximised());

        memory.update(false, false);
        assert!(!WindowMemory::read(Some(file)).maximised());
    }

    #[test]
    fn minimising_a_maximised_window_still_reopens_it_maximised() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("window.json");
        let memory = WindowMemory::read(Some(file.clone()));
        memory.update(true, false);
        // Minimised (to record, say) Windows says it isn't maximised, but it comes back so.
        memory.update(false, true);
        assert!(WindowMemory::read(Some(file)).maximised());
    }

    #[test]
    fn an_unreadable_file_opens_the_window_as_configured() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("window.json");
        std::fs::write(&file, "not json").unwrap();
        assert!(!WindowMemory::read(Some(file)).maximised());
        // With nowhere to keep it, it's remembered for this run only.
        let memory = WindowMemory::read(None);
        memory.update(true, false);
        assert!(memory.maximised());
    }

    #[test]
    fn quit_from_the_tray_asks_first_only_while_a_save_is_failing() {
        let guard = CloseGuard::default();
        // Saves working: Quit quits at once, as it always has.
        assert_eq!(on_quit(&guard, false), OnQuit::Quit);
        guard.set(true);
        assert_eq!(on_quit(&guard, false), OnQuit::AskFirst);
        // A recording keeps its Quit: stopped, kept, then the app goes.
        assert_eq!(on_quit(&guard, true), OnQuit::Quit);
        guard.set(false);
        assert_eq!(on_quit(&guard, false), OnQuit::Quit);
    }

    #[test]
    fn closing_waits_for_the_page_only_while_it_asks() {
        let guard = CloseGuard::default();
        assert!(!guard.asking());
        guard.set(true);
        assert!(guard.asking());
        guard.set(false);
        assert!(!guard.asking());
    }
}
