//! The element at a point, as a click's lookup reads it after the click
//! (docs/spec/02-capture.md#on-each-click): Windows' hit test, checked and walked down from the
//! window when it's wrong (F015, F016, F070); Chrome's first answer, only its guess, asked again;
//! Excel's grid stepped across to the cell under the point (07/10/2026); then the element's
//! parents and, for an Excel header, its filter drop-down's words (#70). One reason to change:
//! how UI Automation's answer for a point is checked and corrected.

use std::time::{Duration, Instant};

use uiautomation::core::UICacheRequest;
use uiautomation::patterns::{UIGridItemPattern, UIGridPattern};
use uiautomation::types::{Point, UIProperty};
use uiautomation::{UIAutomation, UIElement};

use crate::coords::PxRect;
use crate::facts::{AncestorFacts, ElementFacts};
use crate::lookup::{LookupError, chrome_guess, fit_value};
use crate::sensitive::mask_value;

use super::{facts_from_cached, read_value};

/// Whether a physical point is inside an element's bounds.
fn contains(bounds: Option<&PxRect>, x: i32, y: i32) -> bool {
    bounds.is_some_and(|rect| {
        rect.right > rect.left
            && rect.bottom > rect.top
            && x >= rect.left
            && x < rect.right
            && y >= rect.top
            && y < rect.bottom
    })
}

/// A window, pane or similar that only holds the thing clicked.
fn is_container(facts: &ElementFacts) -> bool {
    matches!(facts.control_type.as_str(), "Window" | "Pane")
}

/// The invisible layer a XAML menu or flyout lays over its window, so a click outside it closes
/// it. A click that opens a menu is often read after the menu has opened, and then lands on this
/// layer, named "Close": Notepad's Edit menu was recorded as `Click "Close"`.
fn is_light_dismiss(automation_id: &str) -> bool {
    LIGHT_DISMISS_IDS.contains(&automation_id)
}

/// The light-dismiss layer's automation ids. The TypeScript naming takes its "Close" off by the
/// same list; `packages/core/test-vectors/click-naming.json` holds both to it.
const LIGHT_DISMISS_IDS: &[&str] = &["Light Dismiss"];

/// A UI framework's names for its own hosts, squashed as `framework_name` compares them. The
/// TypeScript naming (`uia-adapter.ts`) takes the same names off an element; the shared test
/// vector `click-naming.json` holds both lists to it, so they can't drift apart.
const FRAMEWORK_NAMES: &[&str] = &[
    "popuphost",
    "desktopwindowxamlsource",
    "xamlexplorerhostislandwindow",
    "chrome_widgetwin_0",
    "chrome_widgetwin_1",
    "chromelegacywindow",
    "intermediated3dwindow",
    "windowsuicorecorewindow",
];

/// Names that are a UI framework's, not the app's: `PopupHost`, `Pop-upHost`,
/// `DesktopWindowXamlSource`, `Chrome_WidgetWin_1`, or a name that is just the class name.
fn framework_name(name: &str, class_name: &str) -> bool {
    let squashed: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase();
    FRAMEWORK_NAMES.contains(&squashed.as_str())
        || (!name.is_empty() && name == class_name && name.contains('_'))
}

/// The deepest element under a point, walking down from `element`'s top-level window: at each
/// level the smallest child whose bounds hold the point. A few hundred elements at most.
fn descend(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    element: &UIElement,
    x: i32,
    y: i32,
) -> Option<UIElement> {
    let walker = automation.get_control_view_walker().ok()?;
    let root = automation.get_root_element().ok()?;
    let mut top = element.clone();
    for _ in 0..40 {
        let parent = walker.get_parent(&top).ok()?;
        if automation.compare_elements(&parent, &root).unwrap_or(true) {
            break;
        }
        top = parent;
    }
    let area = |found: &UIElement| -> Option<i64> {
        let rect = found.get_bounding_rectangle().ok()?;
        let inside = x >= rect.get_left()
            && x < rect.get_right()
            && y >= rect.get_top()
            && y < rect.get_bottom();
        inside.then(|| {
            i64::from(rect.get_right() - rect.get_left())
                * i64::from(rect.get_bottom() - rect.get_top())
        })
    };
    let mut current = top;
    for _ in 0..40 {
        let mut best: Option<(i64, UIElement)> = None;
        let mut child = walker.get_first_child(&current).ok();
        let mut seen = 0;
        while let Some(candidate) = child {
            seen += 1;
            if seen > 400 {
                break;
            }
            if let Some(size) = area(&candidate)
                && size > 0
                && !is_light_dismiss(&candidate.get_automation_id().unwrap_or_default())
                && best.as_ref().is_none_or(|(smallest, _)| size <= *smallest)
            {
                best = Some((size, candidate.clone()));
            }
            child = walker.get_next_sibling(&candidate).ok();
        }
        match best {
            Some((_, next)) => current = next,
            None => break,
        }
    }
    current.build_updated_cache(cache).ok()
}

pub(super) fn element_at(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    x: i32,
    y: i32,
) -> Result<(ElementFacts, bool), LookupError> {
    let lookup = || -> uiautomation::Result<(UIElement, ElementFacts)> {
        // Some apps' hosts (Windows Settings) refuse the one-call lookup with its cached
        // properties ("The system cannot find the file specified"), which left every click there
        // unnamed (F016): the element alone, then its properties, works.
        let element = automation
            .element_from_point_build_cache(Point::new(x, y), cache)
            .or_else(|_| {
                automation
                    .element_from_point(Point::new(x, y))?
                    .build_updated_cache(cache)
            })?;
        let facts = facts_from_cached(&element, &[]);
        Ok((element, facts))
    };
    let (mut element, mut facts) = lookup()?;
    let mut retried = false;
    // The pointer wasn't resting long enough for a pre-read: one more look, kept only if it finds
    // something real under the click.
    if chrome_guess(&facts, x, y) {
        std::thread::sleep(Duration::from_millis(40));
        if let Ok(second) = lookup()
            && !chrome_guess(&second.1, x, y)
        {
            (element, facts) = second;
        }
        retried = true;
    }
    // Excel's hit test, in a sheet with a table and frozen panes, names a cell a few columns or
    // rows from the one clicked (E3 for a click in I4). Walking down from the window to find it
    // lists the table's hundreds of cells and took 250 ms, past the lookup's deadline, so those
    // clicks were named from the words on the screen (07/10/2026). Stepping across the grid from
    // the cell it named finds the right one in a few calls.
    if !contains(facts.bounds.as_ref(), x, y)
        && let Some(found) = grid_cell_at(&element, x, y)
        && let Ok(found) = found.build_updated_cache(cache)
    {
        let better = facts_from_cached(&found, &[]);
        if contains(better.bounds.as_ref(), x, y) {
            (element, facts) = (found, better);
        }
    }
    // Windows' hit test can answer with the wrong element: a click on Notepad's or File Explorer's
    // menu named "Close" (the title bar's button) (F015, F070), and in Settings only the window
    // (F016). When the answer isn't under the click, is only a window or pane, or carries a
    // framework's name, the element under the click is found by walking down from the window.
    if (!contains(facts.bounds.as_ref(), x, y)
        || is_container(&facts)
        || is_light_dismiss(&facts.automation_id)
        || framework_name(&facts.name, &facts.class_name))
        && let Some(found) = descend(automation, cache, &element, x, y)
    {
        let better = facts_from_cached(&found, &[]);
        if contains(better.bounds.as_ref(), x, y) && !is_light_dismiss(&better.automation_id) {
            (element, facts) = (found, better);
        }
    }
    // What the element is called, a framework's name or the light-dismiss layer's "Close"
    // included, is decided in TypeScript from these facts (docs/spec/02-capture.md#click-naming).
    let parents = parents_of(automation, cache, &element);
    facts.ancestors = parents.ancestors;
    facts.document_class = parents.document_class;
    // A part of a password box (a run of its text, its placeholder) is kept out as the box is:
    // the key worker takes keys typed straight after the click as typed into it (#97 third
    // review). Its value is never read either.
    facts.sensitive |= parents.in_password;
    facts.filter_header = filter_header(&element, &facts);
    Ok((facts, retried))
}

/// For an Excel cell with a filter drop-down (Excel's own `HasFilterDropdown`), its words: the
/// header the filter is on (#70). Excel draws the drop-down inside the cell and exposes it only
/// as this property, so a click on it finds the cell. Asked of cells only, two calls more.
fn filter_header(element: &UIElement, facts: &ElementFacts) -> Option<String> {
    if facts.class_name != crate::excel::CELL_CLASS
        || crate::platform::excel::has_filter_dropdown(element.as_ref()) != Some(true)
    {
        return None;
    }
    let words = read_value(element).unwrap_or_default();
    Some(fit_value(mask_value(words.trim())))
}

/// How many cells `grid_cell_at` steps across, and for how long, before it gives up: the whole
/// lookup has 350 ms, and the walk down from the window still follows if this finds nothing.
const GRID_STEPS: usize = 40;
const GRID_TIME: Duration = Duration::from_millis(120);

/// A UI Automation rectangle as the recorder's pixel rectangle.
pub(super) fn px_rect(rect: &uiautomation::types::Rect) -> PxRect {
    PxRect {
        left: rect.get_left(),
        top: rect.get_top(),
        right: rect.get_right(),
        bottom: rect.get_bottom(),
    }
}

/// A cell's place in a grid, or a grid's size in cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cell {
    row: i32,
    column: i32,
}

/// The grid cell under a point, found by stepping from `cell` (a cell of the same grid, not
/// under it) towards the point (`grid_step`). `None` when `cell` isn't a grid item, or the point
/// isn't reached within `GRID_STEPS` and `GRID_TIME`.
fn grid_cell_at(cell: &UIElement, x: i32, y: i32) -> Option<UIElement> {
    let started = Instant::now();
    let item = cell.get_pattern::<UIGridItemPattern>().ok()?;
    let grid = item
        .get_containing_grid()
        .ok()?
        .get_pattern::<UIGridPattern>()
        .ok()?;
    let size = Cell {
        row: grid.get_row_count().ok()?,
        column: grid.get_column_count().ok()?,
    };
    let mut at = Cell {
        row: item.get_row().ok()?,
        column: item.get_column().ok()?,
    };
    let mut current = cell.clone();
    for _ in 0..GRID_STEPS {
        if started.elapsed() > GRID_TIME {
            return None;
        }
        let bounds = px_rect(&current.get_bounding_rectangle().ok()?);
        match grid_step(&bounds, at, size, x, y)? {
            GridStep::Here => return Some(current),
            GridStep::To(next) => {
                at = next;
                current = grid.get_item(at.row, at.column).ok()?;
            }
        }
    }
    None
}

/// Where `grid_cell_at` goes from a cell.
#[derive(Debug, PartialEq, Eq)]
enum GridStep {
    /// The point is in this cell.
    Here,
    /// The next cell to look at.
    To(Cell),
}

/// One step across a grid of `size` from the cell at `at` with `bounds`: a column and a row
/// nearer the point, or `Here` when the cell holds it. `None` when the step would leave the grid.
fn grid_step(bounds: &PxRect, at: Cell, size: Cell, x: i32, y: i32) -> Option<GridStep> {
    let toward = |point: i32, low: i32, high: i32, index: i32| {
        if point < low {
            index - 1
        } else if point >= high {
            index + 1
        } else {
            index
        }
    };
    // Excel's hit test leaves out how far the sheet is scrolled, so the cell it names can be one
    // scrolled out of view, with no bounds: the cells in view are further down and right. Which
    // of the two is out of view can't be told from an empty rectangle, so both are stepped, and
    // the steps after correct whichever was already in view.
    let next = if bounds.right <= bounds.left || bounds.bottom <= bounds.top {
        Cell {
            row: at.row + 1,
            column: at.column + 1,
        }
    } else {
        Cell {
            row: toward(y, bounds.top, bounds.bottom, at.row),
            column: toward(x, bounds.left, bounds.right, at.column),
        }
    };
    if next == at {
        return Some(GridStep::Here);
    }
    ((0..size.row).contains(&next.row) && (0..size.column).contains(&next.column))
        .then_some(GridStep::To(next))
}

/// The element's parents, nearest first, up to the window, the page or four, the class of the
/// Document they stopped at, and whether one is a password box (`lookup::parents_marked`), each
/// read with its properties in one call.
pub(super) fn parents_of(
    automation: &UIAutomation,
    cache: &UICacheRequest,
    element: &UIElement,
) -> crate::lookup::Parents {
    let (Ok(walker), Ok(root)) = (
        automation.get_control_view_walker(),
        automation.get_root_element(),
    ) else {
        return crate::lookup::Parents::default();
    };
    let mut current = element.clone();
    let parents = std::iter::from_fn(|| {
        let parent = walker.get_parent_build_cache(&current, cache).ok()?;
        // The desktop is above every window: never part of an app.
        if automation.compare_elements(&parent, &root).unwrap_or(true) {
            return None;
        }
        current = parent;
        Some((
            AncestorFacts {
                control_type: current
                    .get_cached_control_type()
                    .map(|control| format!("{control:?}"))
                    .unwrap_or_default(),
                name: current.get_cached_name().unwrap_or_default(),
            },
            current.get_cached_classname().unwrap_or_default(),
            current
                .get_cached_property_value(UIProperty::IsPassword)
                .ok()
                .and_then(|value| TryInto::<bool>::try_into(value).ok())
                .unwrap_or(false),
        ))
    });
    crate::lookup::parents_marked(parents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uia::element_cache;

    fn cell_at(row: i32, column: i32) -> Cell {
        Cell { row, column }
    }

    fn cell(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn a_grid_step_moves_a_column_and_a_row_towards_the_point() {
        let e3 = cell(100, 100, 200, 150);
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 150, 120),
            Some(GridStep::Here)
        );
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 450, 170),
            Some(GridStep::To(cell_at(3, 5)))
        );
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 50, 120),
            Some(GridStep::To(cell_at(2, 3)))
        );
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 150, 99),
            Some(GridStep::To(cell_at(1, 4)))
        );
        // The right and bottom edges belong to the next cell, as the hit test has them.
        assert_eq!(
            grid_step(&e3, cell_at(2, 4), cell_at(30, 17), 200, 150),
            Some(GridStep::To(cell_at(3, 5)))
        );
    }

    #[test]
    fn a_cell_scrolled_out_of_view_steps_down_and_right_into_it() {
        // Excel named D3, scrolled out of view, for a click in H4 (07/10/2026).
        let hidden = cell(0, 0, 0, 0);
        assert_eq!(
            grid_step(&hidden, cell_at(2, 3), cell_at(30, 17), -1251, 924),
            Some(GridStep::To(cell_at(3, 4)))
        );
    }

    #[test]
    fn a_grid_step_never_leaves_the_grid() {
        let corner = cell(100, 100, 200, 150);
        assert_eq!(
            grid_step(&corner, cell_at(0, 0), cell_at(30, 17), 50, 50),
            None
        );
        assert_eq!(
            grid_step(&cell(0, 0, 0, 0), cell_at(29, 3), cell_at(30, 17), 0, 0),
            None
        );
    }

    /// The check on a real desktop (#70): open a workbook with a filter on its headers (Data >
    /// Filter, or a table), start this, and rest the pointer on a header's filter drop-down within
    /// 30 seconds, then on the header's words. It prints what the lookup reads under the pointer
    /// every half second, and passes once a drop-down has been found and the words were read as
    /// the cell.
    #[test]
    #[ignore = "needs Excel with a filter: cargo test -p capture excel_filter_drop_downs -- --ignored --nocapture"]
    fn excel_filter_drop_downs_are_told_from_their_header_cell() {
        let automation = UIAutomation::new().expect("UI Automation");
        let cache = element_cache(&automation).expect("a cache request");
        let until = Instant::now() + Duration::from_secs(30);
        let (mut drop_down, mut cell) = (false, false);
        while !(drop_down && cell) {
            if let Some((x, y)) = crate::platform::display::cursor_pos()
                && let Ok((facts, _)) = element_at(&automation, &cache, x, y)
            {
                let scale = crate::platform::display::monitor_at(x, y).map_or(1.0, |m| m.scale);
                let on = crate::excel::filter_button_at(x, y, &facts, scale);
                println!(
                    "({x}, {y}) {} {:?} {:?} box {:?}: header {:?}, on its drop-down: {on}",
                    facts.control_type,
                    facts.name,
                    facts.class_name,
                    facts.bounds,
                    facts.filter_header,
                );
                drop_down |= on;
                cell |= facts.filter_header.is_some() && !on;
            }
            assert!(
                Instant::now() < until,
                "no header's drop-down and words were rested on in 30 seconds"
            );
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// The check on a real desktop for #73 and #74: start this and, within 30 seconds, rest the
    /// pointer on what's to be checked (Paint's canvas with the pencil, a page of a Word
    /// document, Excel's File tab, the back arrow in Excel's Backstage). Every half second it
    /// prints what the lookup reads there, as a click's evidence carries it: the element's control
    /// type, name, automation id, class, framework and box, its parents, and the class of the
    /// Document they stopped at.
    #[test]
    #[ignore = "reads what's under the pointer: cargo test -p capture under_the_pointer -- --ignored --nocapture"]
    fn what_the_lookup_reads_under_the_pointer() {
        let automation = UIAutomation::new().expect("UI Automation");
        let cache = element_cache(&automation).expect("a cache request");
        let until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < until {
            if let Some((x, y)) = crate::platform::display::cursor_pos()
                && let Ok((facts, _)) = element_at(&automation, &cache, x, y)
            {
                let parents: Vec<String> = facts
                    .ancestors
                    .iter()
                    .map(|parent| format!("{} {:?}", parent.control_type, parent.name))
                    .collect();
                println!(
                    "({x}, {y}) {} {:?} id {:?} class {:?} framework {:?} box {:?}; parents [{}]; document {:?}",
                    facts.control_type,
                    facts.name,
                    facts.automation_id,
                    facts.class_name,
                    facts.framework_id,
                    facts.bounds,
                    parents.join(", "),
                    facts.document_class,
                );
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// `packages/core/test-vectors/click-naming.json`: what the TypeScript naming shares.
    fn shared_naming() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../../../../packages/core/test-vectors/click-naming.json"
        ))
        .unwrap()
    }

    fn strings(value: &serde_json::Value) -> Vec<&str> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect()
    }

    #[test]
    fn framework_names_and_light_dismiss_are_the_namings() {
        let shared = shared_naming();
        assert_eq!(strings(&shared["frameworkNames"]), FRAMEWORK_NAMES);
        assert_eq!(
            strings(&shared["lightDismissAutomationIds"]),
            LIGHT_DISMISS_IDS
        );
        for id in LIGHT_DISMISS_IDS {
            assert!(is_light_dismiss(id));
        }
        assert!(!is_light_dismiss("Close"));
    }

    #[test]
    fn framework_names_are_told_apart_as_the_naming_tells_them() {
        let shared = shared_naming();
        for case in shared["frameworkNameCases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let class_name = case["className"].as_str().unwrap();
            assert_eq!(
                framework_name(name, class_name),
                case["framework"].as_bool().unwrap(),
                "{name:?} (class {class_name:?})"
            );
        }
    }
}
