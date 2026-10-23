//! The menus open on screen and their items, read as each opened (docs/spec/02-capture.md#on-each-click,
//! #56). A click on a menu item often can't be read itself: the menu closes with the click, before
//! its lookup runs, and the click is named from the words on its screenshot when the recording
//! opens, which text recognition misreads ("Eormat Cells...", "Sav"). The items read as the menu
//! opened go with such a click, and the naming in TypeScript matches the words against them, or,
//! with no words to go by, takes the item whose box holds the click when the menu still showed
//! (#106).
//!
//! Two things say a menu opened (`uia.rs`, Windows only): UI Automation's menu-opened event, and a
//! XAML pop-up host showing (`WinUI` 3's, in which Paint's File menu is drawn), whose menu is looked
//! for in it then (#106). This keeps what was read, in memory, until newer menus take its place,
//! and answers which menu a click landed in. Whether a kept menu still shows is told at the click,
//! by the window under the pointer as the button went down: for a menu with a window of its own,
//! that window being there says the menu was.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::coords::PxRect;

/// The most items kept of one menu, and the longest name kept of each (`packages/core`'s click
/// facts hold a click to the same).
pub const MAX_ITEMS: usize = 64;
pub const MAX_NAME_CHARS: usize = 200;
/// How many menus are kept at once: a menu and the submenus opened from it.
const MAX_MENUS: usize = 4;

/// One of a menu's items, as UI Automation read it when the menu opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuItem {
    pub name: String,
    /// Physical pixels; `None` when it had no box on screen.
    pub bounds: Option<PxRect>,
}

/// What said a menu had opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuSource {
    /// UI Automation's menu-opened event (#56).
    Opened,
    /// A XAML pop-up host showed, and a menu was found in it (#106).
    PopUpShown,
}

/// A menu that opened, and what it held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenMenu {
    /// The top-level window the menu is drawn in: a click on it has this window under the
    /// pointer as the button goes down.
    pub window: isize,
    pub bounds: PxRect,
    /// When its items had been read, on the input clock (ms, wrapping).
    pub read: u32,
    pub items: Vec<MenuItem>,
    /// The menu has a window of its own: `window` is a pop-up the menu fills ([`fills_window`]),
    /// as Windows' own menus and `WinUI`'s pop-up host are. That window shows one menu at a time,
    /// and under the pointer as a button goes down, says the menu still showed then.
    pub own_window: bool,
    pub source: MenuSource,
}

impl OpenMenu {
    /// Laid out: placed on the screen, with at least one item boxed. A XAML menu can be found
    /// before its first layout, with no box yet.
    fn laid_out(&self) -> bool {
        !self.bounds.is_empty() && self.items.iter().any(|item| item.bounds.is_some())
    }
}

/// The menu a click landed in, as kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClickedMenu {
    pub items: Vec<MenuItem>,
    /// The menu still showed as the button went down: its own window was under the pointer then.
    pub showing: bool,
}

/// A menu's items as kept: named ones only, at most `MAX_ITEMS`, each name trimmed and cut to
/// `MAX_NAME_CHARS`.
#[must_use]
pub fn kept_items(items: impl IntoIterator<Item = MenuItem>) -> Vec<MenuItem> {
    items
        .into_iter()
        .filter_map(|item| {
            let name = item.name.trim();
            (!name.is_empty()).then(|| MenuItem {
                name: name.chars().take(MAX_NAME_CHARS).collect(),
                bounds: item.bounds,
            })
        })
        .take(MAX_ITEMS)
        .collect()
}

/// Whether a menu fills most of the window it's drawn in (at least half of it), so the window is
/// the menu's own: Windows' menus are their window, and a pop-up host may leave room round the
/// menu for a shadow. A menu drawn inside its app's window covers a small part of it.
#[must_use]
pub fn fills_window(menu: &PxRect, window: &PxRect) -> bool {
    let area = |rect: &PxRect| i64::from(rect.width()) * i64::from(rect.height());
    !window.is_empty()
        && menu
            .intersect(window)
            .is_some_and(|shared| area(&shared) * 2 >= area(window))
}

/// Whether `a` comes before `b` on the input clock, which counts milliseconds and wraps.
fn before(a: u32, b: u32) -> bool {
    let gap = b.wrapping_sub(a);
    gap != 0 && gap < 1 << 31
}

/// What one look in a pop-up host that showed found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Look {
    /// The window no longer shows: nothing more to find.
    Gone,
    /// No menu in it, or none that may be read: maybe not yet.
    Nothing,
    Menu(OpenMenu),
}

/// How long to wait before each look after the first in a pop-up host that showed: XAML can show
/// the window before its menu is laid out. About 0.6 seconds in all, as long as a quick click
/// takes to reach an item.
pub const LOOK_AGAIN: [Duration; 4] = [
    Duration::from_millis(40),
    Duration::from_millis(80),
    Duration::from_millis(160),
    Duration::from_millis(320),
];

/// The menu in a pop-up host that just showed (#106): looked for at once, then again after each of
/// [`LOOK_AGAIN`] until one is laid out, or the window goes. A menu found but never laid out is
/// kept as last read when it has a place on the screen (its items' names still serve the words
/// on a screenshot). `None` when no menu was found.
pub fn read_shown(
    mut look: impl FnMut() -> Look,
    mut wait: impl FnMut(Duration),
) -> Option<OpenMenu> {
    let mut found = None;
    let mut waits = LOOK_AGAIN.iter();
    loop {
        match look() {
            Look::Gone => break,
            Look::Menu(menu) if menu.laid_out() => return Some(menu),
            Look::Menu(menu) if !menu.bounds.is_empty() => found = Some(menu),
            Look::Menu(_) | Look::Nothing => {}
        }
        let Some(&next) = waits.next() else { break };
        wait(next);
    }
    found
}

/// The menus read as they opened, between UI Automation's event thread and the pipeline. Held
/// only to look and to swap: never while anything is read.
#[derive(Debug, Default)]
pub struct OpenMenus(Mutex<Vec<OpenMenu>>);

impl OpenMenus {
    fn menus(&self) -> MutexGuard<'_, Vec<OpenMenu>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A menu opened. It takes the place of one kept in the same window and place (this menu
    /// again), of any kept in its window when it has a window of its own (which shows one menu at
    /// a time), and of the oldest when `MAX_MENUS` are kept.
    pub fn opened(&self, menu: OpenMenu) {
        let mut menus = self.menus();
        menus.retain(|kept| {
            kept.window != menu.window || (!menu.own_window && kept.bounds != menu.bounds)
        });
        if menus.len() >= MAX_MENUS {
            menus.remove(0);
        }
        menus.push(menu);
    }

    /// Every menu kept, oldest first: for the live check of what's kept (`uia.rs`, Windows only).
    #[cfg(all(test, windows))]
    pub(crate) fn kept(&self) -> Vec<OpenMenu> {
        self.menus().clone()
    }

    /// A pop-up host showed again at `shown` (input clock) and no menu was found in it: what was
    /// read in it before is out of date, so it's forgotten. A menu read since it showed is kept.
    pub fn forget(&self, window: isize, shown: u32) {
        self.menus()
            .retain(|kept| kept.window != window || !before(kept.read, shown));
    }

    /// The menu a click landed in: one read before the button went down at `pressed`, in the
    /// window under the pointer then, whose box holds the click; the latest opened when several do
    /// (a submenu over its menu, or a menu opened again where one was). `None` when none does.
    #[must_use]
    pub fn for_click(&self, x: i32, y: i32, window: isize, pressed: u32) -> Option<ClickedMenu> {
        self.menus()
            .iter()
            .rev()
            .find(|menu| {
                menu.window == window && menu.bounds.contains(x, y) && before(menu.read, pressed)
            })
            .map(|menu| ClickedMenu {
                items: menu.items.clone(),
                showing: menu.own_window,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXCEL_MENU: isize = 0x6_0100;
    const PAINT: isize = 0x7_0200;
    /// `WinUI`'s pop-up host, the window Paint's File menu is drawn in (#106).
    const PAINT_POP_UP: isize = 0x7_0300;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn item(name: &str, row: i32) -> MenuItem {
        MenuItem {
            name: name.into(),
            bounds: Some(rect(800, 500 + row * 24, 1080, 524 + row * 24)),
        }
    }

    /// Excel's right-click menu, read as it opened at 1 000 ms on the input clock: a window of
    /// Windows' own menu class, which the menu fills.
    fn excel_menu() -> OpenMenu {
        OpenMenu {
            window: EXCEL_MENU,
            bounds: rect(796, 496, 1084, 628),
            read: 1_000,
            items: vec![
                item("Insert…", 0),
                item("Delete…", 1),
                item("Clear Contents", 2),
                item("Format Cells…", 3),
                item("Define Name…", 4),
            ],
            own_window: true,
            source: MenuSource::Opened,
        }
    }

    /// Paint's File menu in `WinUI`'s pop-up host, read once the host showed.
    fn paint_file_menu(read: u32) -> OpenMenu {
        OpenMenu {
            window: PAINT_POP_UP,
            bounds: rect(8, 82, 328, 642),
            read,
            items: vec![
                MenuItem {
                    name: "Save".into(),
                    bounds: Some(rect(12, 300, 324, 340)),
                },
                MenuItem {
                    name: "Save as".into(),
                    bounds: Some(rect(12, 340, 324, 380)),
                },
            ],
            own_window: true,
            source: MenuSource::PopUpShown,
        }
    }

    fn names(menu: Option<ClickedMenu>) -> Vec<String> {
        menu.map(|menu| menu.items.into_iter().map(|item| item.name).collect())
            .unwrap_or_default()
    }

    #[test]
    fn a_click_in_a_menu_read_before_it_gets_the_menus_items() {
        let menus = OpenMenus::default();
        menus.opened(excel_menu());
        assert_eq!(
            names(menus.for_click(900, 585, EXCEL_MENU, 2_400)),
            [
                "Insert…",
                "Delete…",
                "Clear Contents",
                "Format Cells…",
                "Define Name…"
            ]
        );
    }

    #[test]
    fn a_click_outside_the_menu_or_in_another_window_gets_none() {
        let menus = OpenMenus::default();
        menus.opened(excel_menu());
        // Just past its right edge, which belongs to what's next to it.
        assert!(menus.for_click(1084, 585, EXCEL_MENU, 2_400).is_none());
        // The same place, but another window was under the pointer as the button went down: the
        // menu had closed, or something opened over it.
        assert!(menus.for_click(900, 585, PAINT, 2_400).is_none());
    }

    #[test]
    fn a_menu_read_once_the_button_was_down_names_nothing() {
        let menus = OpenMenus::default();
        menus.opened(excel_menu());
        assert!(menus.for_click(900, 585, EXCEL_MENU, 1_000).is_none());
        assert!(menus.for_click(900, 585, EXCEL_MENU, 990).is_none());
        assert!(menus.for_click(900, 585, EXCEL_MENU, 1_001).is_some());
    }

    #[test]
    fn a_menu_opened_again_in_its_window_takes_the_old_ones_place() {
        let menus = OpenMenus::default();
        menus.opened(excel_menu());
        // Windows reuses a menu's window for the next menu in the same place, here a shorter one.
        menus.opened(OpenMenu {
            bounds: rect(796, 496, 1084, 548),
            read: 5_000,
            items: vec![item("Copy", 0), item("Paste", 1)],
            ..excel_menu()
        });
        assert_eq!(
            names(menus.for_click(900, 510, EXCEL_MENU, 6_000)),
            ["Copy", "Paste"]
        );
        // The longer one's rows below it went with it: the window shows one menu at a time.
        assert!(menus.for_click(900, 600, EXCEL_MENU, 6_000).is_none());
    }

    #[test]
    fn a_click_in_a_submenu_gets_the_submenus_items() {
        let menus = OpenMenus::default();
        // A menu and its submenu drawn inside the app's own window, not in windows of their own.
        let file = OpenMenu {
            window: PAINT,
            bounds: rect(0, 40, 300, 600),
            read: 1_000,
            items: vec![item("Save", 0), item("Save as", 1)],
            own_window: false,
            source: MenuSource::Opened,
        };
        let formats = OpenMenu {
            window: PAINT,
            bounds: rect(290, 100, 500, 260),
            read: 1_500,
            items: vec![item("PNG picture", 0), item("JPEG picture", 1)],
            own_window: false,
            source: MenuSource::Opened,
        };
        menus.opened(file);
        menus.opened(formats);
        assert_eq!(
            names(menus.for_click(295, 150, PAINT, 2_000)),
            ["PNG picture", "JPEG picture"]
        );
        assert_eq!(
            names(menus.for_click(100, 150, PAINT, 2_000)),
            ["Save", "Save as"]
        );
    }

    #[test]
    fn only_a_menu_in_a_window_of_its_own_says_it_showed_under_the_press() {
        let menus = OpenMenus::default();
        menus.opened(excel_menu());
        menus.opened(OpenMenu {
            window: PAINT,
            bounds: rect(0, 40, 300, 600),
            read: 1_000,
            items: vec![item("Save", 0)],
            own_window: false,
            source: MenuSource::Opened,
        });
        // The window under the press was the menu's own: the menu was there.
        assert!(
            menus
                .for_click(900, 585, EXCEL_MENU, 2_400)
                .is_some_and(|menu| menu.showing)
        );
        // A menu drawn in the app's window may have closed with the window still there.
        assert!(
            menus
                .for_click(100, 150, PAINT, 2_000)
                .is_some_and(|menu| !menu.showing)
        );
    }

    #[test]
    fn a_menu_in_a_window_of_its_own_takes_the_place_of_any_kept_for_it() {
        let menus = OpenMenus::default();
        menus.opened(paint_file_menu(1_000));
        // WinUI shows the same pop-up host again, sized to what it shows now.
        menus.opened(OpenMenu {
            bounds: rect(8, 82, 328, 300),
            items: vec![MenuItem {
                name: "New".into(),
                bounds: Some(rect(12, 90, 324, 130)),
            }],
            ..paint_file_menu(3_000)
        });
        assert_eq!(
            names(menus.for_click(100, 100, PAINT_POP_UP, 4_000)),
            ["New"]
        );
        assert!(menus.for_click(100, 500, PAINT_POP_UP, 4_000).is_none());
    }

    #[test]
    fn a_pop_up_host_showing_again_forgets_what_was_read_before() {
        let menus = OpenMenus::default();
        menus.opened(paint_file_menu(1_000));
        menus.opened(excel_menu());
        // Shown again at 5 000 ms, and no menu read in it since: what it shows isn't known.
        menus.forget(PAINT_POP_UP, 5_000);
        assert!(menus.for_click(100, 320, PAINT_POP_UP, 6_000).is_none());
        assert!(menus.for_click(900, 585, EXCEL_MENU, 6_000).is_some());
        // One read after it showed is kept.
        menus.opened(paint_file_menu(5_200));
        menus.forget(PAINT_POP_UP, 5_000);
        assert!(menus.for_click(100, 320, PAINT_POP_UP, 6_000).is_some());
    }

    #[test]
    fn a_menu_has_a_window_of_its_own_when_it_fills_most_of_it() {
        // Windows' own menus are their window.
        assert!(fills_window(
            &rect(796, 496, 1084, 628),
            &rect(796, 496, 1084, 628)
        ));
        // A pop-up host may leave room round the menu for its shadow.
        assert!(fills_window(&rect(8, 82, 328, 642), &rect(0, 74, 336, 650)));
        // A menu drawn inside the app's window.
        assert!(!fills_window(
            &rect(8, 82, 328, 642),
            &rect(0, 0, 1280, 900)
        ));
        assert!(!fills_window(&rect(8, 82, 328, 642), &PxRect::default()));
    }

    #[test]
    fn only_the_latest_few_menus_are_kept() {
        let menus = OpenMenus::default();
        for (index, left) in (0..6).map(|index| (index, index * 400)).collect::<Vec<_>>() {
            menus.opened(OpenMenu {
                window: PAINT + isize::try_from(index).unwrap(),
                bounds: rect(left, 0, left + 300, 300),
                read: 1_000,
                items: vec![item("New", 0)],
                own_window: true,
                source: MenuSource::Opened,
            });
        }
        assert!(menus.for_click(10, 10, PAINT, 2_000).is_none());
        assert!(menus.for_click(2010, 10, PAINT + 5, 2_000).is_some());
        assert!(menus.for_click(810, 10, PAINT + 2, 2_000).is_some());
    }

    #[test]
    fn a_menu_keeps_its_named_items_within_limits() {
        let long = "x".repeat(MAX_NAME_CHARS + 20);
        let items = kept_items(
            [item("  Save as  ", 0), item("", 1), item(&long, 2)]
                .into_iter()
                .chain((0..100).map(|row| item("Recent", row))),
        );
        assert_eq!(items.len(), MAX_ITEMS);
        assert_eq!(items[0].name, "Save as");
        assert_eq!(items[1].name.chars().count(), MAX_NAME_CHARS);
    }

    /// What a pop-up host's reader finds at each look, in turn; gone once they run out.
    fn looks(found: Vec<Look>) -> impl FnMut() -> Look {
        let mut found = found.into_iter();
        move || found.next().unwrap_or(Look::Gone)
    }

    #[test]
    fn a_pop_up_hosts_menu_is_looked_for_again_until_it_is_laid_out() {
        let unplaced = OpenMenu {
            bounds: PxRect::default(),
            ..paint_file_menu(1_000)
        };
        let unboxed = OpenMenu {
            items: vec![MenuItem {
                name: "Save".into(),
                bounds: None,
            }],
            ..paint_file_menu(1_040)
        };
        let mut waited = Vec::new();
        let read = read_shown(
            looks(vec![
                Look::Nothing,
                Look::Menu(unplaced),
                Look::Menu(unboxed),
                Look::Menu(paint_file_menu(1_120)),
                Look::Menu(paint_file_menu(1_500)),
            ]),
            |wait| waited.push(wait),
        );
        assert_eq!(read, Some(paint_file_menu(1_120)));
        assert_eq!(waited, &LOOK_AGAIN[..3]);
    }

    #[test]
    fn a_menu_whose_items_never_get_boxes_is_kept_as_last_read() {
        let unboxed = OpenMenu {
            items: vec![MenuItem {
                name: "Save".into(),
                bounds: None,
            }],
            ..paint_file_menu(1_000)
        };
        let read = read_shown(
            looks(std::iter::repeat_n(Look::Menu(unboxed.clone()), 10).collect()),
            |_| {},
        );
        assert_eq!(read, Some(unboxed));
    }

    #[test]
    fn a_pop_up_host_that_shows_no_menu_or_goes_gives_none() {
        let mut waited = 0;
        assert_eq!(
            read_shown(looks(vec![Look::Nothing; 10]), |_| waited += 1),
            None
        );
        assert_eq!(waited, LOOK_AGAIN.len());
        // Gone before its menu was laid out: nothing to keep, and no more looks.
        let mut waited = 0;
        assert_eq!(
            read_shown(looks(vec![Look::Nothing, Look::Gone]), |_| waited += 1),
            None
        );
        assert_eq!(waited, 1);
    }
}
