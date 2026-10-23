//! What kind of program a window belongs to, and what a step records of its window
//! (docs/spec/02-capture.md#events): Steps itself, the Windows shell, a browser whose address bar
//! is read, a code editor, a remote session, Windows' input panel, or a store app shown in its
//! frame. One reason to change: a kind of program to be told apart, by its file, class or
//! description, or a fact a step keeps of its window.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::facts::{ElementFacts, WindowFacts};
use crate::platform::window::{Elevation, WindowInfo};

/// Remote-desktop clients, by their program's file. A program here whose own windows are local
/// (a connection manager's tree, a remote-control tool's main window) is taken as remote in all
/// of them: a local window wrongly taken as remote only loses names and typed values, never a
/// password (#116). How sure each name is: docs/spec/02-capture.md, "Remote desktops".
const REMOTE_CLIENTS: &[&str] = &[
    "mstsc.exe",
    "msrdc.exe",
    "wfica32.exe",
    "cdviewer.exe",
    "vmconnect.exe",
    // Programs that show sessions in their own window with the Remote Desktop control (#116):
    // Remote Desktop Connection Manager, mRemoteNG, Devolutions Remote Desktop Manager (its
    // 64-bit, older 64-bit and old Free editions' files) and Royal TS.
    "rdcman.exe",
    "mremoteng.exe",
    "remotedesktopmanager.exe",
    "remotedesktopmanager64.exe",
    "remotedesktopmanagerfree.exe",
    "royalts.exe",
    // Remote-control tools: TeamViewer, AnyDesk and RustDesk.
    "teamviewer.exe",
    "anydesk.exe",
    "rustdesk.exe",
    // VMware: Horizon Client, its remote console process, Workstation, Workstation Player and
    // Remote Console. VirtualBox's machine window (6.0 on; the manager, VirtualBox.exe, is local).
    "vmware-view.exe",
    "vmware-remotemks.exe",
    "vmware.exe",
    "vmplayer.exe",
    "vmrc.exe",
    "virtualboxvm.exe",
    // The store's Remote Desktop app, inside ApplicationFrameHost's frame.
    "rdclient.windows.exe",
    // VNC viewers on Windows: RealVNC, UltraVNC and TigerVNC (`vncviewer.exe`, and TigerVNC's
    // standalone `vncviewer64-1.14.1.exe`, told by its start) and TightVNC.
    "vncviewer.exe",
    "tvnviewer.exe",
    // Linux: Remmina, FreeRDP, TigerVNC, virt-viewer and Citrix Workspace.
    "remmina",
    "xfreerdp",
    "xfreerdp3",
    "sdl-freerdp",
    "vncviewer",
    "xtigervncviewer",
    "remote-viewer",
    "virt-viewer",
    "wfica",
];

/// Whether a program is a remote-desktop client, whose window shows another computer: no
/// element names can be read inside it.
#[must_use]
pub fn is_remote_client(exe_name: &str) -> bool {
    let name = exe_name.to_ascii_lowercase();
    REMOTE_CLIENTS.contains(&name.as_str())
        || (name.starts_with("vncviewer")
            && std::path::Path::new(&name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe")))
}

/// Whether a window shows another computer: its program is a remote-desktop client, or, for a
/// store app's frame, the app it shows is (the store's Remote Desktop app, #116).
#[must_use]
pub fn is_remote_window(window: &WindowInfo) -> bool {
    window
        .exe_name()
        .into_iter()
        .chain(window.hosted_exe.as_deref())
        .any(is_remote_client)
}

/// The window class of the Remote Desktop control's input window ("Input Capture Window"),
/// where the control takes the keys and clicks for the other computer, in whatever program shows
/// it (#116). Remote Desktop Connection's, as scripts that drive it name it; that the programs
/// hosting the control (Remote Desktop Connection Manager, mRemoteNG, Royal TS) show the same is
/// still to be checked once on a real session.
const REMOTE_INPUT_CLASS: &str = "IHWindowClass";

/// Whether a window class is the Remote Desktop control's input window's.
#[must_use]
pub fn is_remote_input_class(class: &str) -> bool {
    class.eq_ignore_ascii_case(REMOTE_INPUT_CLASS)
}

/// Whether an element is the Remote Desktop control's input window: keys and clicks there go to
/// another computer, whatever program shows it (#116).
#[must_use]
pub fn is_remote_input(facts: &ElementFacts) -> bool {
    is_remote_input_class(&facts.class_name)
}

/// Browsers whose address bar is read for "Go to" steps: Chrome, Edge and the browsers built on
/// Chromium with its address bar (Chromium, Brave, Opera, Vivaldi), and Firefox (04/10/2026), by
/// their program's file name on Windows (`chrome.exe`) or Linux (`chrome`, `chromium-browser`).
pub(crate) fn is_browser(exe_name: Option<&str>) -> bool {
    exe_name.is_some_and(|name| {
        [
            "chrome.exe",
            "msedge.exe",
            "chromium.exe",
            "brave.exe",
            "opera.exe",
            "vivaldi.exe",
            "firefox.exe",
            "chrome",
            "chromium",
            "chromium-browser",
            "msedge",
            "brave",
            "brave-browser",
            "opera",
            "vivaldi-bin",
            "firefox",
            "firefox-bin",
        ]
        .iter()
        .any(|browser| name.eq_ignore_ascii_case(browser))
    })
}

/// Code editors: what's typed in them is code, and their editing surfaces aren't read as fields.
const CODE_EDITORS: &[&str] = &[
    "code.exe",
    "code - insiders.exe",
    "cursor.exe",
    "windsurf.exe",
    "devenv.exe",
    "notepad++.exe",
    "sublime_text.exe",
    "powershell_ise.exe",
    "ssms.exe",
    "azuredatastudio.exe",
    "idea64.exe",
    "pycharm64.exe",
    "webstorm64.exe",
    "rider64.exe",
    "clion64.exe",
    "goland64.exe",
    "phpstorm64.exe",
    "datagrip64.exe",
    "zed.exe",
];

/// Whether a program is a code editor (see [`CODE_EDITORS`]).
#[must_use]
pub(crate) fn is_code_editor(exe: &str) -> bool {
    CODE_EDITORS
        .iter()
        .any(|editor| editor.eq_ignore_ascii_case(exe))
}

/// Windows' own surfaces that aren't apps: going to one isn't an "Open" step.
const SHELL_HOSTS: &[&str] = &[
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "shellexperiencehost.exe",
    "shellhost.exe",
    "textinputhost.exe",
    "lockapp.exe",
];

/// The taskbar, Start, search, the desktop and the like. Explorer also draws File Explorer
/// windows (`CabinetWClass`), which are a place a guide goes, so only its other windows count.
/// Told by the class read with the window, never asked again: a click on a File Explorer window
/// is judged by the window as the button went down, which may have closed by the click's handling,
/// and then had no class to tell it from the desktop (#98).
pub(crate) fn is_shell_window(window: &WindowInfo) -> bool {
    match window.exe_name().map(str::to_ascii_lowercase).as_deref() {
        Some("explorer.exe") => window
            .class
            .as_deref()
            .is_none_or(|class| class != "CabinetWClass"),
        Some(name) => SHELL_HOSTS.contains(&name),
        None => false,
    }
}

/// Any copy of Steps (the installed one, the Store's or a portable one: every Steps program is
/// `amluto-steps…exe`), not only this process: before 1.0.0 two could run at once (F007).
pub(crate) fn is_steps_window(window: &WindowInfo) -> bool {
    window
        .exe_name()
        .is_some_and(|name| name.to_ascii_lowercase().starts_with("amluto-steps"))
}

/// A taskbar button or tray icon for Steps: its name is "Steps", or starts "Steps - " or
/// "Steps by Amluto" (the running-windows count Windows adds follows).
pub(crate) fn names_steps(element: Option<&ElementFacts>) -> bool {
    element.is_some_and(|element| {
        let name = element.name.trim();
        name == "Steps"
            || name.starts_with("Steps - ")
            || name.starts_with("Steps by Amluto")
            || name.starts_with("Steps, ")
    })
}

/// Whether a window is one of Windows' input panels (the emoji panel, clipboard history, the touch
/// keyboard, voice typing), which the text input host draws (#109): nothing under a click there is
/// read, since a clipboard history item can be named after the text it holds, and the clipboard is
/// never read (04/10/2026). Its own window, or a frame showing it: Windows 11 shows the emoji panel
/// in a frame of `explorer.exe`'s round the host's core window (build 26300, 12/10/2026).
pub(crate) fn is_input_panel(window: &WindowInfo) -> bool {
    window
        .exe_name()
        .into_iter()
        .chain(window.hosted_exe.as_deref())
        .any(crate::dictation::is_text_input_host)
}

/// The program that draws store apps' windows (Calculator, Settings) for them.
const FRAME_HOST: &str = "applicationframehost.exe";

/// What one "Open" step stands for: a program, whatever window of it is in front (its own dialogs,
/// Word's start screen then its document; F004, F020, F069). Every store app's frame belongs to one
/// `ApplicationFrameHost.exe` process, so there each frame's title tells the apps apart (#50).
pub(crate) fn program_key(window: &WindowInfo) -> (u32, String) {
    let frame_host = window
        .exe_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(FRAME_HOST));
    (
        window.pid,
        if frame_host {
            window.title.clone()
        } else {
            String::new()
        },
    )
}

/// A program's own name, read once per program (it's in the file, which doesn't change).
fn app_name(window: &WindowInfo) -> Option<String> {
    static NAMES: std::sync::OnceLock<Mutex<HashMap<String, Option<String>>>> =
        std::sync::OnceLock::new();
    let path = window.exe_path.as_ref()?;
    let mut names = NAMES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    names
        .entry(path.clone())
        .or_insert_with(|| {
            let exe = window.exe_name().unwrap_or_default();
            crate::platform::window::program_description(path)
                .and_then(|description| program_name(&description, exe))
        })
        .clone()
}

/// The name a program's description gives it, or `None` when it gives none: a description that is
/// only the program's own file name ("mspaint.exe" for Paint, "Notepad.exe" for Windows 11's
/// Notepad) says nothing the file doesn't, and the window's title names the app better
/// ("Untitled - Paint"; #50). Another file's name is a name, without ".exe" (F004).
fn program_name(description: &str, exe: &str) -> Option<String> {
    let description = description.trim();
    if description.is_empty() || description.eq_ignore_ascii_case(exe) {
        return None;
    }
    Some(
        match std::path::Path::new(description).extension() {
            Some(extension) if extension.eq_ignore_ascii_case("exe") => {
                &description[..description.len() - 4]
            }
            _ => description,
        }
        .to_string(),
    )
}

/// What a step records about the window it was in: its title, program, place, elevation, the
/// app's own name and, for a store app's frame, the app it shows.
#[must_use]
pub fn window_facts(window: &WindowInfo) -> WindowFacts {
    let exe = window.exe_name().map(str::to_string);
    let remote_session = is_remote_window(window);
    WindowFacts {
        title: window.title.clone(),
        exe,
        pid: window.pid,
        frame: window.frame.into(),
        elevation: elevation_name(window.elevation),
        remote_session,
        app_name: app_name(window),
        hosted_app: crate::platform::window::hosted_app_name(window.hwnd),
        hosted_exe: window.hosted_exe.clone(),
        owner_title: None,
        shell: is_shell_window(window),
    }
}

fn elevation_name(elevation: Elevation) -> &'static str {
    match elevation {
        Elevation::NotElevated => "notElevated",
        Elevation::Elevated => "elevated",
        Elevation::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_copy_of_steps_and_its_taskbar_button_are_never_recorded() {
        let window = |path: &str| WindowInfo {
            hwnd: 0,
            pid: 7,
            title: "Steps".into(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        assert!(is_steps_window(&window(
            r"C:\Users\Sam\Downloads\amluto-steps-1.0.0-x64-portable.exe"
        )));
        assert!(is_steps_window(&window(
            r"C:\Users\Sam\AppData\Local\Steps\amluto-steps.exe"
        )));
        assert!(!is_steps_window(&window(r"C:\Windows\notepad.exe")));
        let named = |name: &str| ElementFacts {
            name: name.into(),
            ..ElementFacts::default()
        };
        assert!(names_steps(Some(&named("Steps - 1 running window"))));
        assert!(names_steps(Some(&named("Steps"))));
        assert!(!names_steps(Some(&named("Steps Recorder"))));
        assert!(!names_steps(Some(&named("Notepad - 1 running window"))));
    }

    #[test]
    fn each_store_app_is_its_own_program_for_open_steps() {
        let window = |pid: u32, path: &str, title: &str| WindowInfo {
            hwnd: 0,
            pid,
            title: title.into(),
            exe_path: Some(path.into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        // One ApplicationFrameHost process draws every store app's frame (#50).
        let frame =
            |title: &str| window(7704, r"C:\Windows\System32\ApplicationFrameHost.exe", title);
        assert_ne!(
            program_key(&frame("Calculator")),
            program_key(&frame("Settings"))
        );
        // Any other program's windows are one program: Word's start screen, then its document.
        let word = |title: &str| {
            window(
                12,
                r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE",
                title,
            )
        };
        assert_eq!(
            program_key(&word("Word")),
            program_key(&word("Document1 - Word"))
        );
    }

    #[test]
    fn a_description_that_is_only_the_file_name_is_no_name() {
        let name = |description: &str, exe: &str| program_name(description, exe);
        // Paint describes itself as "mspaint.exe" and Windows 11's Notepad as "Notepad.exe" (F004):
        // that's the file, which the window's title names better ("Untitled - Paint", #50).
        assert_eq!(name("mspaint.exe", "mspaint.exe"), None);
        assert_eq!(name("Notepad.exe", "notepad.exe"), None);
        // Another file's name in the description is a name, without ".exe".
        assert_eq!(
            name("Notepad.exe", "notepad_new.exe").as_deref(),
            Some("Notepad")
        );
        // A real name, even one that is also the file's (Spotify.exe is "Spotify").
        assert_eq!(
            name("Microsoft Word", "WINWORD.EXE").as_deref(),
            Some("Microsoft Word")
        );
        assert_eq!(
            name("Windows Explorer", "explorer.exe").as_deref(),
            Some("Windows Explorer")
        );
        assert_eq!(name("Spotify", "Spotify.exe").as_deref(), Some("Spotify"));
        assert_eq!(name("  ", "tool.exe"), None);
    }

    #[test]
    fn remote_desktop_clients_are_flagged() {
        let window = WindowInfo {
            hwnd: 0,
            pid: 1,
            title: "Remote".into(),
            exe_path: Some(r"C:\Windows\System32\mstsc.exe".into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        assert!(window_facts(&window).remote_session);
    }

    #[test]
    fn more_remote_desktop_clients_are_flagged() {
        // Hosts of the Remote Desktop control, remote-control tools, virtual machines' consoles
        // and VNC viewers on Windows (#116), in any case.
        for exe in [
            "RDCMan.exe",
            "mRemoteNG.exe",
            "RemoteDesktopManager.exe",
            "RemoteDesktopManager64.exe",
            "RemoteDesktopManagerFree.exe",
            "RoyalTS.exe",
            "TeamViewer.exe",
            "AnyDesk.exe",
            "rustdesk.exe",
            "vmware-view.exe",
            "vmware-remotemks.exe",
            "vmware.exe",
            "vmplayer.exe",
            "vmrc.exe",
            "VirtualBoxVM.exe",
            "RdClient.Windows.exe",
            "vncviewer.exe",
            "tvnviewer.exe",
            // TigerVNC's standalone download carries its version in its name.
            "vncviewer64-1.14.1.exe",
            "vncviewer-1.14.1.exe",
        ] {
            assert!(is_remote_client(exe), "{exe}");
        }
        // VirtualBox's manager lists machines; each machine's window is VirtualBoxVM.exe's.
        for exe in [
            "VirtualBox.exe",
            "notepad.exe",
            "vncserver.exe",
            "vmware-tray.exe",
        ] {
            assert!(!is_remote_client(exe), "{exe}");
        }
    }

    #[test]
    fn the_store_remote_desktop_app_is_flagged_through_its_frame() {
        // A store app's window is ApplicationFrameHost's frame round the app's own (#116).
        let window = WindowInfo {
            hwnd: 0,
            pid: 1,
            title: "Remote Desktop".into(),
            exe_path: Some(r"C:\Windows\System32\ApplicationFrameHost.exe".into()),
            frame: crate::platform::Rect::default(),
            elevation: Elevation::NotElevated,
            hosted_exe: Some("RdClient.Windows.exe".into()),
            class: None,
        };
        assert!(is_remote_window(&window));
        assert!(window_facts(&window).remote_session);
        let calculator = WindowInfo {
            hosted_exe: Some("CalculatorApp.exe".into()),
            ..window
        };
        assert!(!is_remote_window(&calculator));
        assert!(!window_facts(&calculator).remote_session);
    }

    #[test]
    fn the_remote_desktop_controls_input_window_is_a_remote_session_in_any_program() {
        // Where the Remote Desktop control takes its keys and clicks, in whatever program shows it
        // (#116): "Input Capture Window", class `IHWindowClass`.
        let facts = |class: &str| ElementFacts {
            class_name: class.into(),
            ..ElementFacts::default()
        };
        assert!(is_remote_input(&facts("IHWindowClass")));
        assert!(is_remote_input(&facts("ihwindowclass")));
        assert!(!is_remote_input(&facts("Edit")));
        assert!(!is_remote_input(&facts("")));
        assert!(is_remote_input_class("IHWindowClass"));
        assert!(!is_remote_input_class("OPWindowClass"));
    }

    #[test]
    fn code_editors_are_known() {
        assert!(is_code_editor("Code.exe"));
        assert!(is_code_editor("devenv.exe"));
        assert!(!is_code_editor("notepad.exe"));
        assert!(!is_code_editor("chrome.exe"));
    }
}
