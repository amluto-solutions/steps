//! Windows and the processes behind them, through the window manager's EWMH properties and
//! `/proc` (docs/spec/02-capture.md#linux-x11-phase-10).
//!
//! A window is named by its client window's id (what `_NET_ACTIVE_WINDOW` and the client lists
//! hold), as an integer, like a Windows handle. Its frame includes the window manager's
//! decorations (`_NET_FRAME_EXTENTS`), as Windows' visible frame includes the title bar.

use std::path::Path;
use std::process::Command;

use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, MapState, Window};

use crate::Rect;
use crate::connection::{Display, shared};

/// Whether a process runs as root. Linux has no elevation prompt; a root process is the nearest
/// thing, and its windows are treated as Windows treats an elevated app's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Elevation {
    NotElevated,
    Elevated,
    /// The process couldn't be read.
    Unknown,
}

/// A top-level window.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    /// The client window's id, for logging and matching only.
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    /// Full path of the program (`/proc/<pid>/exe`), when it can be read.
    pub exe_path: Option<String>,
    /// Visible frame, decorations included, in screen pixels.
    pub frame: Rect,
    pub elevation: Elevation,
}

impl WindowInfo {
    /// File name of the program, e.g. `firefox`. Either separator counts, as on Windows, so a
    /// path means the same wherever it was written.
    #[must_use]
    pub fn exe_name(&self) -> Option<&str> {
        self.exe_path
            .as_deref()
            .and_then(|path| path.rsplit(['\\', '/']).next())
    }
}

/// This process's id, for ignoring clicks on the recorder's own windows.
#[must_use]
pub fn own_process_id() -> u32 {
    std::process::id()
}

/// Whether another copy of Steps is running (`/proc/<pid>/comm` is `amluto-steps`), so a shortcut
/// that couldn't be taken can be put down to it rather than to "another app".
#[must_use]
pub fn other_steps_running() -> bool {
    let own = std::process::id().to_string();
    std::fs::read_dir("/proc").is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let pid = entry.file_name().to_string_lossy().into_owned();
            pid != own
                && pid.bytes().all(|byte| byte.is_ascii_digit())
                && std::fs::read_to_string(entry.path().join("comm"))
                    .is_ok_and(|name| name.trim().starts_with("amluto-steps"))
        })
    })
}

fn to_handle(window: Window) -> isize {
    isize::try_from(window).unwrap_or(0)
}

fn from_handle(handle: isize) -> Option<Window> {
    Window::try_from(handle).ok().filter(|&window| window != 0)
}

fn property32(display: &Display, window: Window, property: u32) -> Vec<u32> {
    display
        .connection
        .get_property(false, window, property, AtomEnum::ANY, 0, 4096)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| reply.value32().map(Iterator::collect))
        .unwrap_or_default()
}

fn text_property(display: &Display, window: Window, property: u32) -> Option<String> {
    let reply = display
        .connection
        .get_property(false, window, property, AtomEnum::ANY, 0, 4096)
        .ok()?
        .reply()
        .ok()?;
    (!reply.value.is_empty()).then(|| String::from_utf8_lossy(&reply.value).into_owned())
}

fn title(display: &Display, window: Window) -> String {
    text_property(display, window, display.atoms.net_wm_name)
        .or_else(|| text_property(display, window, AtomEnum::WM_NAME.into()))
        .unwrap_or_default()
}

fn pid(display: &Display, window: Window) -> Option<u32> {
    property32(display, window, display.atoms.net_wm_pid)
        .first()
        .copied()
}

/// The client area in screen pixels.
fn client_rect(display: &Display, window: Window) -> Option<Rect> {
    let geometry = display.connection.get_geometry(window).ok()?.reply().ok()?;
    let origin = display
        .connection
        .translate_coordinates(window, display.root, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    let left = i32::from(origin.dst_x);
    let top = i32::from(origin.dst_y);
    Some(Rect {
        left,
        top,
        right: left + i32::from(geometry.width),
        bottom: top + i32::from(geometry.height),
    })
}

/// The frame: the client area grown by the decorations the window manager draws around it.
fn frame(display: &Display, window: Window) -> Option<Rect> {
    let client = client_rect(display, window)?;
    let extents = property32(display, window, display.atoms.net_frame_extents);
    let edge = |index: usize| {
        extents
            .get(index)
            .and_then(|&value| i32::try_from(value).ok())
            .unwrap_or(0)
    };
    Some(Rect {
        left: client.left - edge(0),
        right: client.right + edge(1),
        top: client.top - edge(2),
        bottom: client.bottom + edge(3),
    })
}

/// The client area of a window, for element lookups in window coordinates.
#[must_use]
pub fn client_area(hwnd: isize) -> Option<Rect> {
    let display = shared()?;
    client_rect(display, from_handle(hwnd)?)
}

fn elevation(pid: u32) -> Elevation {
    let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) else {
        return Elevation::Unknown;
    };
    let effective_uid = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|ids| ids.split_whitespace().nth(1))
        .and_then(|uid| uid.parse::<u32>().ok());
    match effective_uid {
        Some(0) => Elevation::Elevated,
        Some(_) => Elevation::NotElevated,
        None => Elevation::Unknown,
    }
}

fn exe_path(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        // A program replaced while it runs reads as "… (deleted)".
        .map(|path| path.trim_end_matches(" (deleted)").to_string())
}

fn info(display: &Display, window: Window) -> Option<WindowInfo> {
    let pid = pid(display, window).unwrap_or(0);
    Some(WindowInfo {
        hwnd: to_handle(window),
        pid,
        title: title(display, window),
        exe_path: (pid != 0).then(|| exe_path(pid)).flatten(),
        frame: frame(display, window)?,
        elevation: if pid == 0 {
            Elevation::Unknown
        } else {
            elevation(pid)
        },
    })
}

/// The window's `WM_CLASS` class (the second part, e.g. `Gnome-terminal`), for telling apps
/// apart where Windows uses a window class.
#[must_use]
pub fn window_class(hwnd: isize) -> Option<String> {
    let display = shared()?;
    let value = text_property(display, from_handle(hwnd)?, AtomEnum::WM_CLASS.into())?;
    let mut parts = value.split('\0').filter(|part| !part.is_empty());
    let instance = parts.next().map(str::to_string);
    parts.next().map(str::to_string).or(instance)
}

fn is_shown(display: &Display, window: Window) -> bool {
    let viewable = display
        .connection
        .get_window_attributes(window)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|attributes| attributes.map_state == MapState::VIEWABLE);
    viewable
        && !property32(display, window, display.atoms.net_wm_state)
            .contains(&display.atoms.net_wm_state_hidden)
}

fn is_app_window(display: &Display, window: Window) -> bool {
    let kinds = property32(display, window, display.atoms.net_wm_window_type);
    let atoms = &display.atoms;
    !kinds.iter().any(|kind| {
        [
            atoms.net_wm_window_type_dock,
            atoms.net_wm_window_type_desktop,
            atoms.net_wm_window_type_toolbar,
            atoms.net_wm_window_type_notification,
        ]
        .contains(kind)
    })
}

/// The top-level windows, front to back: the window manager's stacking list, or, with no window
/// manager, the root's mapped children that carry a title or pid.
fn stacked(display: &Display) -> Vec<Window> {
    let mut list = property32(
        display,
        display.root,
        display.atoms.net_client_list_stacking,
    );
    if list.is_empty() {
        list = property32(display, display.root, display.atoms.net_client_list);
    }
    if list.is_empty() {
        list = display
            .connection
            .query_tree(display.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|tree| {
                tree.children
                    .into_iter()
                    .filter(|&window| {
                        pid(display, window).is_some() || !title(display, window).is_empty()
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    // Both the client list and the tree go bottom to top.
    list.reverse();
    list
}

/// The top-level window under a point: the front-most shown window whose frame holds it.
#[must_use]
pub fn root_window_at(x: i32, y: i32) -> Option<WindowInfo> {
    let display = shared()?;
    stacked(display)
        .into_iter()
        .filter(|&window| is_shown(display, window))
        .filter_map(|window| info(display, window))
        .find(|window| window.frame.contains(x, y))
}

/// The process that owns the window under a point.
#[must_use]
pub fn owner_process_at(x: i32, y: i32) -> Option<u32> {
    root_window_at(x, y).map(|window| window.pid)
}

/// The active window (`_NET_ACTIVE_WINDOW`).
#[must_use]
pub fn foreground_window() -> Option<WindowInfo> {
    let display = shared()?;
    let active = active_window(display)?;
    info(display, active)
}

pub(crate) fn active_window(display: &Display) -> Option<Window> {
    property32(display, display.root, display.atoms.net_active_window)
        .first()
        .copied()
        .filter(|&window| window != 0)
}

/// A window by its id.
#[must_use]
pub fn window_info(hwnd: isize) -> Option<WindowInfo> {
    let display = shared()?;
    info(display, from_handle(hwnd)?)
}

/// The program's file name for a process id.
#[must_use]
pub fn process_exe_name(pid: u32) -> Option<String> {
    exe_path(pid).and_then(|path| path.rsplit('/').next().map(str::to_string))
}

/// Programs whose file name differs from the app people know. Most apps are found through their
/// `.desktop` file instead.
const KNOWN_PROGRAMS: &[(&str, &str)] = &[
    ("chrome", "Google Chrome"),
    ("chromium", "Chromium"),
    ("msedge", "Microsoft Edge"),
    ("firefox", "Firefox"),
    ("firefox-bin", "Firefox"),
    ("soffice.bin", "LibreOffice"),
    ("oosplash", "LibreOffice"),
    ("nautilus", "Files"),
    ("gnome-terminal-server", "Terminal"),
    ("code", "Visual Studio Code"),
    ("thunderbird", "Thunderbird"),
];

/// The app's name as people know it (the `.desktop` file's `Name`), for "Open …" steps.
#[must_use]
pub fn program_description(exe_path: &str) -> Option<String> {
    let exe = exe_path.rsplit('/').next()?;
    if let Some((_, name)) = KNOWN_PROGRAMS.iter().find(|(program, _)| *program == exe) {
        return Some((*name).to_string());
    }
    desktop_entry_name(exe)
}

/// The `Name` of the `.desktop` file whose `Exec` or `TryExec` runs `exe`. When several do, the
/// one that runs it plainly wins: `xfce4-terminal --preferences` is the Xfce terminal's settings.
fn desktop_entry_name(exe: &str) -> Option<String> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut folders: Vec<std::path::PathBuf> = vec![
        "/usr/share/applications".into(),
        "/usr/local/share/applications".into(),
        "/var/lib/flatpak/exports/share/applications".into(),
        "/var/lib/snapd/desktop/applications".into(),
    ];
    if let Some(home) = home {
        folders.insert(0, home.join(".local/share/applications"));
    }
    folders
        .iter()
        .filter_map(|folder| std::fs::read_dir(folder).ok())
        .flatten()
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "desktop"))
        .filter_map(|entry| entry_runs(&entry.path(), exe))
        .min_by_key(|(_, distance)| *distance)
        .map(|(name, _)| name)
}

/// The entry's `Name` if it runs `exe`, with how far that is from the app itself: 0 when its
/// `Exec` is `exe` and at most file placeholders (`%U`), 1 with options, 2 more when it's kept
/// out of menus.
fn entry_runs(path: &Path, exe: &str) -> Option<(String, u8)> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut name = None;
    let mut runs = false;
    let mut plain = false;
    let mut hidden = false;
    let mut in_entry = false;
    let is_exe = |program: &str| program.rsplit('/').next() == Some(exe);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(value) = line.strip_prefix("Name=") {
            name = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("Exec=") {
            let mut words = value.split_whitespace();
            if words.next().is_some_and(is_exe) {
                runs = true;
                plain = words.all(|word| word.starts_with('%'));
            }
        } else if let Some(value) = line.strip_prefix("TryExec=") {
            runs |= is_exe(value.trim());
        } else if line == "NoDisplay=true" {
            hidden = true;
        }
    }
    let distance = u8::from(!plain) + 2 * u8::from(hidden);
    runs.then_some(name).flatten().map(|name| (name, distance))
}

/// Whether this process runs as root.
#[must_use]
pub fn own_process_elevated() -> bool {
    elevation(std::process::id()) == Elevation::Elevated
}

/// Shows a warning in a desktop dialog (`zenity` or `kdialog`, whichever is installed) and waits
/// until it's closed; with neither, writes it to standard error. Used when the app's own web
/// views may be gone. Call it on a thread that may block.
pub fn show_warning(title: &str, text: &str) {
    let shown = Command::new("zenity")
        .args(["--warning", "--title", title, "--text", text, "--no-markup"])
        .status()
        .or_else(|_| {
            Command::new("kdialog")
                .args(["--title", title, "--sorry", text])
                .status()
        })
        .is_ok();
    if !shown {
        eprintln!("{title}: {text}");
    }
}

/// A top-level window that is showing, for working out what a screenshot shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownWindow {
    pub pid: u32,
    /// Visible frame in screen pixels.
    pub frame: Rect,
    /// Drawn with transparency, so what's behind it may show through. X11 doesn't say without a
    /// compositor's help, so this is always `false`.
    pub see_through: bool,
}

/// Every top-level window that is showing, front to back.
#[must_use]
pub fn shown_windows() -> Vec<ShownWindow> {
    let Some(display) = shared() else {
        return Vec::new();
    };
    stacked(display)
        .into_iter()
        .filter(|&window| is_shown(display, window))
        .filter_map(|window| {
            let frame = frame(display, window)?;
            (frame.width() > 0 && frame.height() > 0).then(|| ShownWindow {
                pid: pid(display, window).unwrap_or(0),
                frame,
                see_through: false,
            })
        })
        .collect()
}

/// The front-most app window that isn't `except_pid`'s and has a title: the one someone was
/// working in before they clicked a floating toolbar of ours. Docks, desktops, toolbars and
/// notifications don't count.
#[must_use]
pub fn front_window_except(except_pid: u32) -> Option<WindowInfo> {
    let display = shared()?;
    stacked(display)
        .into_iter()
        .filter(|&window| is_shown(display, window) && is_app_window(display, window))
        .filter_map(|window| info(display, window))
        .find(|window| window.pid != except_pid && !window.title.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_an_apps_name_in_its_desktop_file() {
        let folder = std::env::temp_dir().join(format!("steps-desktop-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("org.example.Editor.desktop");
        std::fs::write(
            &file,
            "[Desktop Entry]\nName=Text Editor\nExec=/usr/bin/example-editor %U\n\
             [Desktop Action new]\nName=New Window\nExec=example-editor --new\n",
        )
        .unwrap();
        assert_eq!(
            entry_runs(&file, "example-editor"),
            Some(("Text Editor".into(), 0))
        );
        assert_eq!(entry_runs(&file, "other"), None);

        // A settings launcher for the same program is further from the app itself.
        let settings = folder.join("xfce4-terminal-settings.desktop");
        std::fs::write(
            &settings,
            "[Desktop Entry]\nName=Xfce Terminal Settings\nExec=xfce4-terminal --preferences\n",
        )
        .unwrap();
        assert_eq!(
            entry_runs(&settings, "xfce4-terminal"),
            Some(("Xfce Terminal Settings".into(), 1))
        );
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn known_programs_keep_their_familiar_names() {
        assert_eq!(
            program_description("/opt/google/chrome/chrome"),
            Some("Google Chrome".into())
        );
        assert_eq!(
            program_description("/usr/lib/libreoffice/program/soffice.bin"),
            Some("LibreOffice".into())
        );
    }

    #[test]
    fn this_process_is_named_from_proc() {
        let name = process_exe_name(std::process::id()).unwrap();
        assert!(!name.is_empty());
        assert_ne!(elevation(std::process::id()), Elevation::Unknown);
    }
}
