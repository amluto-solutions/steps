//! Tooltips over the point a click goes down at (docs/spec/02-capture.md#on-each-click, #105).
//!
//! A tooltip is a top-level window of its own, shown over or beside the control it describes,
//! and `WindowFromPoint` finds it like any other window. A click there still goes to the control:
//! - Windows' own tooltip control (comctl32's `tooltips_class32`): one laid over its control (an
//!   in-place tooltip, `TTF_TRANSPARENT`) answers the hit test "see-through" (`HTTRANSPARENT`),
//!   so Windows hands the click to the window under it; any other hides at the first mouse
//!   message over it. It's known by its class, with no message to it as the button goes down.
//! - XAML (`WinUI`, as File Explorer's toolbar uses) shows a tooltip that would leave its window
//!   in a pop-up window of its own (`Microsoft.UI.Content.PopupWindowSiteBridge`, titled
//!   `PopupHost`), a little larger than the tooltip to leave room for its shadow, and hands every
//!   click on that window to its own tree, where the tooltip takes no clicks (microsoft-ui-xaml's
//!   `docs/design-notes/popup.md` and `ToolTip_Partial.cpp`). It shows its menus in windows of
//!   the same kind, so the window alone can't say which is a tooltip; UI Automation says so as
//!   one opens (its tooltip-opened event, which XAML raises), and `capture`'s `uia.rs` notes the
//!   window then ([`TOOLTIP_WINDOWS`]).
//!
//! Either way the tooltip closes with the click, so taken for the window clicked it looked like a
//! window that closed (F019) and left the click unnamed. Such a window is looked through to the
//! window under it at the point, as Windows' own hit test would find that one: the next window
//! down the z-order that shows and whose rectangle holds the point, passing over click-through
//! overlays, then its deepest showing, enabled child there. A real menu or drop-down is never
//! looked through (#72).

use std::ffi::c_void;
use std::sync::{Mutex, MutexGuard, PoisonError};

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GW_HWNDNEXT, GetWindow, GetWindowRect, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};

use crate::window::{class_name, ex_style, is_pop_up, owner_of, process_of};

/// The window class of Windows' own tooltip control (comctl32's).
const TOOLTIP_CLASS: &str = "tooltips_class32";
/// How many tooltips lying on each other are looked through.
const MAX_LOOKED_THROUGH: usize = 4;
/// How many windows down the z-order are looked at for the one under a tooltip.
const MAX_BELOW: usize = 4096;
/// How many pop-ups seen holding a tooltip are kept: tooltips show one at a time.
const MAX_NOTED: usize = 8;

/// A pop-up UI Automation saw a tooltip open in, and its program: a handle another program's
/// window takes once this one has closed isn't it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Noted {
    window: isize,
    pid: u32,
}

/// The pop-ups tooltips were seen opening in, between UI Automation's event thread and the
/// threads that read the window under a point. Held only to look and to change: never while
/// anything else is asked.
#[derive(Debug, Default)]
pub(crate) struct TooltipWindows(Mutex<Vec<Noted>>);

/// The pop-ups tooltips are showing in now, as far as UI Automation has said.
pub(crate) static TOOLTIP_WINDOWS: TooltipWindows = TooltipWindows(Mutex::new(Vec::new()));

impl TooltipWindows {
    fn list(&self) -> MutexGuard<'_, Vec<Noted>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A tooltip of program `pid` opened, and `window` is the top-level window at its middle.
    /// Noted when that can be the tooltip's own window: an owned pop-up of that program (XAML
    /// draws one round each tooltip it shows outside its window). Whether it was noted.
    pub(crate) fn tooltip_opened(&self, window: HWND, pid: u32) -> bool {
        if !may_hold_tooltip(window, pid) {
            return false;
        }
        let handle = window.0 as isize;
        let mut list = self.list();
        list.retain(|noted| noted.window != handle);
        if list.len() >= MAX_NOTED {
            list.remove(0);
        }
        list.push(Noted {
            window: handle,
            pid,
        });
        true
    }

    /// A menu opened in `window`: whatever it showed before, it's a menu's now.
    pub(crate) fn menu_opened(&self, window: HWND) {
        let handle = window.0 as isize;
        self.list().retain(|noted| noted.window != handle);
    }

    /// Forgets the pop-ups no longer `shown`: the tooltip in one has closed, and the pop-up may
    /// show something else when it shows again.
    pub(crate) fn forget_hidden(&self, shown: impl Fn(HWND) -> bool) {
        // Asked with the list let go: whether a window shows is a question for Windows.
        let windows: Vec<isize> = self.list().iter().map(|noted| noted.window).collect();
        let hidden: Vec<isize> = windows
            .into_iter()
            .filter(|&window| !shown(HWND(window as *mut c_void)))
            .collect();
        if !hidden.is_empty() {
            self.list().retain(|noted| !hidden.contains(&noted.window));
        }
    }

    /// Whether a tooltip was seen opening in `window`, still the same program's.
    pub(crate) fn holds(&self, window: HWND) -> bool {
        let pid = process_of(window);
        let handle = window.0 as isize;
        pid != 0
            && self
                .list()
                .iter()
                .any(|noted| noted.window == handle && noted.pid == pid)
    }
}

/// Whether `window` can be the window a tooltip of program `pid` shows in: that program's, a
/// pop-up (no title bar of Windows', no taskbar button), and owned by the window it belongs to.
/// An app's own window never is, though a tooltip may be drawn inside it.
fn may_hold_tooltip(window: HWND, pid: u32) -> bool {
    pid != 0 && process_of(window) == pid && is_pop_up(window) && owner_of(window).is_some()
}

/// Whether a top-level window is a tooltip's, which a click goes through: Windows' own tooltip
/// control, or a pop-up UI Automation saw a tooltip open in (`noted`).
fn looked_through(window: HWND, noted: &TooltipWindows) -> bool {
    class_name(window).is_some_and(|class| class.eq_ignore_ascii_case(TOOLTIP_CLASS))
        || noted.holds(window)
}

/// The window a click at a physical point goes to, from `top`, the top-level window Windows
/// finds there (`WindowFromPoint`): a tooltip's window is looked through to the first window
/// under it there that is `shown`. `top` when it isn't a tooltip's, or nothing is under it.
pub(crate) fn clicked_through(top: HWND, x: i32, y: i32, shown: impl Fn(HWND) -> bool) -> HWND {
    clicked_through_noted(top, x, y, shown, &TOOLTIP_WINDOWS)
}

/// [`clicked_through`], with the pop-ups tooltips were seen opening in.
fn clicked_through_noted(
    top: HWND,
    x: i32,
    y: i32,
    shown: impl Fn(HWND) -> bool,
    noted: &TooltipWindows,
) -> HWND {
    let mut window = top;
    for _ in 0..MAX_LOOKED_THROUGH {
        if !looked_through(window, noted) {
            return window;
        }
        match window_below(window, x, y, &shown) {
            Some(below) => window = below,
            None => return top,
        }
    }
    top
}

/// The first top-level window below `window` in the z-order that is `shown` and would take a
/// click at the point, as Windows' own hit test finds one.
fn window_below(window: HWND, x: i32, y: i32, shown: impl Fn(HWND) -> bool) -> Option<HWND> {
    let mut next = window;
    for _ in 0..MAX_BELOW {
        // SAFETY: takes any handle; fails at the bottom of the z-order or for a closed window.
        next = unsafe { GetWindow(next, GW_HWNDNEXT) }
            .ok()
            .filter(|next| !next.is_invalid())?;
        if shown(next) && takes_click_at(next, x, y) {
            return Some(next);
        }
    }
    None
}

/// How many levels of child windows are walked down for the one at a point.
const CHILD_DEPTH: usize = 16;

/// The deepest child window of `root` at a physical point that is showing and enabled, as
/// Windows' own hit test finds it under a top-level window, or `root` itself: the window under a
/// tooltip is asked what part of it is there, as any window clicked is.
pub(crate) fn child_at(root: HWND, x: i32, y: i32) -> HWND {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::WindowsAndMessaging::{
        CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, ChildWindowFromPointEx,
    };
    let mut window = root;
    for _ in 0..CHILD_DEPTH {
        let mut point = POINT { x, y };
        // SAFETY: `point` is a local POINT the call converts in place; false for a closed window.
        if !unsafe { ScreenToClient(window, &raw mut point) }.as_bool() {
            break;
        }
        // SAFETY: takes any handle and a point by value; null when the point is outside it.
        let child = unsafe {
            ChildWindowFromPointEx(
                window,
                point,
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
            )
        };
        if child.is_invalid() || child == window {
            break;
        }
        window = child;
    }
    window
}

/// Whether a click at the point lands in a window: inside its rectangle (its invisible resize
/// borders included, as Windows' hit test has them), and not a click-through overlay (layered
/// and click-through both, which Windows' hit test passes over).
fn takes_click_at(window: HWND, x: i32, y: i32) -> bool {
    let mut rect = RECT::default();
    // SAFETY: out-pointer to a local RECT; fails for a closed window.
    if unsafe { GetWindowRect(window, &raw mut rect) }.is_err() {
        return false;
    }
    let click_through =
        isize::try_from(WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0).unwrap_or(isize::MAX);
    (rect.left..rect.right).contains(&x)
        && (rect.top..rect.bottom).contains(&y)
        && ex_style(window) & click_through != click_through
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, WINDOW_EX_STYLE, WINDOW_STYLE, WS_OVERLAPPEDWINDOW,
    };

    unsafe extern "system" fn plain_window_proc(
        window: HWND,
        message: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        // SAFETY: default handling, with the unchanged arguments.
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(window, message, wparam, lparam)
        }
    }

    /// Where a test window goes: left, top, width, height, in physical pixels.
    type Place = (i32, i32, i32, i32);

    /// A window of this test's own class and the given styles at `place`, never shown, owned by
    /// `owner` if any.
    fn hidden(style: WINDOW_STYLE, owner: Option<HWND>, place: Place) -> HWND {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, RegisterClassExW, WNDCLASSEXW,
        };
        use windows::core::w;
        // SAFETY: this module's own handle.
        let instance = unsafe { GetModuleHandleW(None) }.expect("module handle");
        let class = WNDCLASSEXW {
            cbSize: u32::try_from(std::mem::size_of::<WNDCLASSEXW>()).unwrap(),
            lpfnWndProc: Some(plain_window_proc),
            hInstance: instance.into(),
            lpszClassName: w!("AmlutoStepsTooltipTest"),
            ..WNDCLASSEXW::default()
        };
        // SAFETY: a fully initialised class with static strings; registering it twice fails
        // harmlessly.
        unsafe { RegisterClassExW(&raw const class) };
        let (left, top, width, height) = place;
        // SAFETY: a top-level window of the class above, created hidden; a parent given to a
        // top-level window is its owner.
        unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("AmlutoStepsTooltipTest"),
                w!(""),
                style,
                left,
                top,
                width,
                height,
                owner,
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("window")
    }

    /// A tooltip control of Windows' own (comctl32's `tooltips_class32`) at `place`, never shown,
    /// owned by `owner`, as an app makes one for its toolbar's buttons.
    fn hidden_tooltip(owner: HWND, place: Place) -> HWND {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::Controls::{
            ICC_BAR_CLASSES, INITCOMMONCONTROLSEX, InitCommonControlsEx, TOOLTIPS_CLASSW,
            TTS_ALWAYSTIP,
        };
        use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WS_EX_TOPMOST, WS_POPUP};
        use windows::core::w;
        let controls = INITCOMMONCONTROLSEX {
            dwSize: u32::try_from(std::mem::size_of::<INITCOMMONCONTROLSEX>()).unwrap(),
            dwICC: ICC_BAR_CLASSES,
        };
        // SAFETY: a fully initialised structure that outlives the call; it registers comctl32's
        // window classes, the tooltip's among them, once per process.
        assert!(unsafe { InitCommonControlsEx(&raw const controls) }.as_bool());
        // SAFETY: this module's own handle.
        let instance = unsafe { GetModuleHandleW(None) }.expect("module handle");
        let (left, top, width, height) = place;
        // SAFETY: a tooltip control of the class comctl32 registered above, created hidden and
        // owned by `owner`, as comctl32's documentation creates one.
        unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST,
                TOOLTIPS_CLASSW,
                w!(""),
                WS_POPUP | WINDOW_STYLE(TTS_ALWAYSTIP),
                left,
                top,
                width,
                height,
                Some(owner),
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("tooltip")
    }

    fn destroy(windows: &[HWND]) {
        for &window in windows.iter().rev() {
            // SAFETY: destroys a window this thread created.
            let _ = unsafe { DestroyWindow(window) };
        }
    }

    #[test]
    fn a_click_on_a_tooltip_goes_to_the_window_under_it() {
        // File Explorer's window, and its toolbar button's tooltip over it, just below the
        // pointer and reaching up over it.
        let explorer = hidden(WS_OVERLAPPEDWINDOW, None, (100, 100, 800, 500));
        let tooltip = hidden_tooltip(explorer, (600, 180, 160, 40));
        // These windows are never shown, so only they are taken as showing here: the walk passes
        // over whatever else this desktop has open.
        let ours = [explorer, tooltip];
        let showing = |window: HWND| ours.contains(&window);

        assert_eq!(clicked_through(tooltip, 620, 190, showing), explorer);
        destroy(&ours);
    }

    #[test]
    fn a_menu_under_the_pointer_is_still_the_window_clicked() {
        use windows::Win32::UI::WindowsAndMessaging::{WS_BORDER, WS_POPUP};
        let explorer = hidden(WS_OVERLAPPEDWINDOW, None, (100, 100, 800, 500));
        // A drop-down menu from the toolbar (#72), and a menu item's tooltip over it.
        let menu = hidden(WS_POPUP | WS_BORDER, Some(explorer), (500, 200, 200, 300));
        let tooltip = hidden_tooltip(menu, (520, 260, 160, 40));
        let ours = [explorer, menu, tooltip];
        let showing = |window: HWND| ours.contains(&window);

        assert_eq!(clicked_through(menu, 550, 230, showing), menu);
        assert_eq!(clicked_through(tooltip, 550, 270, showing), menu);
        // The menu's own window, as Windows finds it, is a menu's whatever lies under it.
        assert_eq!(clicked_through(explorer, 150, 150, showing), explorer);
        destroy(&ours);
    }

    #[test]
    fn a_tooltip_with_no_window_under_it_stays_the_window_clicked() {
        let explorer = hidden(WS_OVERLAPPEDWINDOW, None, (100, 100, 800, 500));
        // Past the window's right edge.
        let tooltip = hidden_tooltip(explorer, (860, 180, 160, 40));
        let ours = [explorer, tooltip];
        let showing = |window: HWND| ours.contains(&window);

        assert_eq!(clicked_through(tooltip, 1000, 190, showing), tooltip);
        // A window not showing isn't under it either.
        assert_eq!(
            clicked_through(tooltip, 870, 190, |window| window == tooltip),
            tooltip
        );
        destroy(&ours);
    }

    #[test]
    fn the_window_under_a_tooltip_is_asked_at_its_deepest_child_there() {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, WS_CHILD, WS_VISIBLE};
        let explorer = hidden(WS_OVERLAPPEDWINDOW, None, (100, 100, 800, 500));
        // Its title bar drawn by a child window of its own (as File Explorer's is), holding a
        // part of its own.
        let title_bar = hidden(WS_CHILD | WS_VISIBLE, Some(explorer), (0, 0, 600, 40));
        let part = hidden(WS_CHILD | WS_VISIBLE, Some(title_bar), (500, 0, 100, 40));
        let mut rect = RECT::default();
        // SAFETY: out-pointer to a local RECT.
        unsafe { GetWindowRect(part, &raw mut rect) }.expect("rect");
        let (x, y) = (rect.left + 10, rect.top + 10);

        assert_eq!(child_at(explorer, x, y), part);
        assert_eq!(child_at(explorer, x - 100, y), title_bar);
        // Below the title bar there is only the window itself.
        assert_eq!(child_at(explorer, x, y + 200), explorer);
        // A disabled part takes no click: its parent does.
        // SAFETY: changes a window this thread created.
        let _ = unsafe { windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow(part, false) };
        assert_eq!(child_at(explorer, x, y), title_bar);
        destroy(&[explorer, title_bar, part]);
    }

    #[test]
    fn a_pop_up_a_tooltip_opened_in_is_looked_through_until_it_hides_or_a_menu_opens_in_it() {
        use windows::Win32::UI::WindowsAndMessaging::WS_POPUP;
        let explorer = hidden(WS_OVERLAPPEDWINDOW, None, (100, 100, 800, 500));
        // WinUI draws a toolbar button's tooltip in a pop-up window of its own, as it draws its
        // menus (`Microsoft.UI.Content.PopupWindowSiteBridge`, `PopupHost`), a little larger than
        // the tooltip for its shadow: only UI Automation says which holds a tooltip.
        let pop_up = hidden(WS_POPUP, Some(explorer), (590, 170, 200, 80));
        let ours = [explorer, pop_up];
        let showing = |window: HWND| ours.contains(&window);
        let noted = TooltipWindows::default();
        let own = crate::window::own_process_id();

        // As far as anyone knows, a menu's.
        assert_eq!(
            clicked_through_noted(pop_up, 620, 190, showing, &noted),
            pop_up
        );
        assert!(noted.tooltip_opened(pop_up, own));
        assert_eq!(
            clicked_through_noted(pop_up, 620, 190, showing, &noted),
            explorer
        );
        // Once it has hidden, it's forgotten: the pop-up may show a menu next.
        noted.forget_hidden(|window| window == explorer);
        assert_eq!(
            clicked_through_noted(pop_up, 620, 190, showing, &noted),
            pop_up
        );
        // And so it is when a menu opens in it.
        assert!(noted.tooltip_opened(pop_up, own));
        noted.menu_opened(pop_up);
        assert_eq!(
            clicked_through_noted(pop_up, 620, 190, showing, &noted),
            pop_up
        );
        destroy(&ours);
    }

    #[test]
    fn only_an_owned_pop_up_of_the_tooltips_own_program_is_taken_for_its_window() {
        use windows::Win32::UI::WindowsAndMessaging::{WS_CAPTION, WS_POPUP};
        let explorer = hidden(WS_OVERLAPPEDWINDOW, None, (100, 100, 800, 500));
        let pop_up = hidden(WS_POPUP, Some(explorer), (590, 170, 200, 80));
        let alone = hidden(WS_POPUP, None, (590, 170, 200, 80));
        let dialog = hidden(WS_POPUP | WS_CAPTION, Some(explorer), (300, 200, 400, 300));
        let noted = TooltipWindows::default();
        let own = crate::window::own_process_id();

        // A tooltip drawn inside an app's own window (an inline one) leaves the window alone, and
        // so does one whose window can't be told: nothing owns it, or it has a title bar.
        for window in [explorer, alone, dialog] {
            assert!(!noted.tooltip_opened(window, own));
            assert!(!noted.holds(window));
        }
        // Nor is another program's window taken for it.
        assert!(!noted.tooltip_opened(pop_up, own + 1));
        assert!(noted.tooltip_opened(pop_up, own));
        assert!(noted.holds(pop_up));
        destroy(&[explorer, pop_up, alone, dialog]);
        // A window that has closed is no tooltip's.
        assert!(!noted.holds(pop_up));
    }
}
