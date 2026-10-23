//! What a left press on a spreadsheet cell or a drawing canvas becomes once the button comes up
//! (docs/spec/02-capture.md#on-each-click): the click it was; cells selected by dragging to
//! another (04/10/2026); a fill from Excel's fill handle, dragged or double-clicked (08/10/2026,
//! #65); or a stroke on Paint's canvas (#73). A press on a header's filter drop-down is neither
//! (#70). One reason to change: what a press that may become a drag is, and the step a drag
//! makes. Where Excel draws its handle and drop-down is `crate::excel`'s.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crate::coords::{PxRect, point_to_pct, rect_to_pct};
use crate::draw::drawing_canvas;
use crate::excel::{DragEnd, cell_of, drag_end, fill_handle_at, filled_box, filter_button_at};
use crate::facts::{CaptureFacts, ClickRecord, ElementFacts, FillKind, Record};
use crate::platform::input::MouseButton;
use crate::platform::window::WindowInfo;
use crate::programs::window_facts;
use crate::uia::UiaClient;

use super::{Output, SWITCH_SHOT_AFTER, Stats, lookup_outcome};

/// How far the pointer must move between press and release to be a drag, in physical pixels.
const DRAG_MIN_PX: i32 = 8;

/// A release this long after the press, or never seen, ends the wait.
pub(super) const DRAG_GIVE_UP: Duration = Duration::from_secs(30);

/// How long after a double-click on a fill handle its screenshot is taken, so the filled column
/// shows: as long as an app is given to draw for its "Open" step.
pub(super) const FILL_SHOT_AFTER: Duration = SWITCH_SHOT_AFTER;

/// Ids for drag lookups and pictures, away from click ids.
static NEXT_DRAG_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 48);

/// Whether the button came up at least a drag's distance from where it went down (`from`): a
/// drag or a stroke, not a click or a dot. Where it came up doesn't matter: a stroke may leave the
/// canvas.
pub(super) fn dragged(from: (i32, i32), to: (i32, i32)) -> bool {
    (to.0 - from.0).abs() >= DRAG_MIN_PX || (to.1 - from.1).abs() >= DRAG_MIN_PX
}

/// A left click on a cell, waiting to see whether it becomes a drag.
pub(super) struct DragStart {
    pub(super) of: u64,
    pub(super) x: i32,
    pub(super) y: i32,
    /// The cell pressed on, or for a press on a fill handle, the cell whose handle it is.
    cell: String,
    /// That cell's box, when known.
    bounds: Option<PxRect>,
    /// The fill handle's place on the screen, when the press was on one.
    pub(super) fill_corner: Option<(i32, i32)>,
    window: WindowInfo,
    pub(super) at: Instant,
}

/// A left click that may become a drag: one on a spreadsheet cell, or on a cell's fill handle.
/// Not one on a header's filter drop-down, which opens the filter's menu (#70).
pub(super) fn drag_start(record: &ClickRecord, window: &WindowInfo) -> Option<DragStart> {
    let element = record.element.as_ref()?;
    let (cell, bounds, fill_corner) =
        match fill_handle_at(record.x, record.y, element, record.capture.scale) {
            Some(handle) => (handle.cell, handle.bounds, Some(handle.corner)),
            None if record.filter_button => return None,
            None => (cell_of(element)?, element.bounds, None),
        };
    Some(DragStart {
        of: record.id,
        x: record.x,
        y: record.y,
        cell,
        bounds,
        fill_corner,
        window: window.clone(),
        at: Instant::now(),
    })
}

/// The spreadsheet cell a click selected, for the typing that follows it: a left click on a
/// cell. Not a right-click (inside a selection it keeps the selection), nor a press on a fill
/// handle or a header's filter drop-down, which leave the selection as it was.
pub(super) fn cell_selected(
    record: &ClickRecord,
    window: &WindowInfo,
    button: MouseButton,
) -> Option<String> {
    if button != MouseButton::Left {
        return None;
    }
    drag_start(record, window)
        .filter(|start| start.fill_corner.is_none())
        .map(|start| start.cell)
}

/// Whether the left button went down on the filter drop-down of the spreadsheet header the
/// click's lookup found (#70): Excel draws it inside the cell, so the cell's box tells it.
pub(super) fn filter_button_pressed(record: &ClickRecord, button: MouseButton) -> bool {
    button == MouseButton::Left
        && record
            .element
            .as_ref()
            .is_some_and(|facts| filter_button_at(record.x, record.y, facts, record.capture.scale))
}

/// The button came up: if it moved to another cell, the cells between were selected, or, from
/// a fill handle, filled. The cell under the release is looked up, and the window's screenshot
/// shows the selection. A press on a fill handle that didn't move is given back, since a second
/// press would make it a double-click.
pub(super) fn write_drag(
    start: DragStart,
    (tick_ms, x, y): (u32, i32, i32),
    uia: &UiaClient,
    out: &mut Output,
) -> Option<DragStart> {
    let moved = dragged((start.x, start.y), (x, y));
    let element = moved
        .then(|| element_at(uia, x, y, &start.window))
        .flatten();
    let release = element.as_ref().and_then(cell_of);
    let end_bounds = element.as_ref().and_then(|facts| facts.bounds);
    let (to, fill) = match drag_end(&start.cell, start.fill_corner.is_some(), moved, release) {
        DragEnd::Click => return (!moved && start.fill_corner.is_some()).then_some(start),
        DragEnd::Select { to } => (Some(to), None),
        DragEnd::Fill { to } => (to, Some(FillKind::Drag)),
    };
    let selection = match (&to, fill) {
        // The cells filled, in the handle's column or row; without the handle's cell's box, its
        // handle is ringed instead.
        (Some(to), Some(_)) => handle_cell_box(&start, uia)
            .zip(end_bounds)
            .map(|(from, end)| filled_box(from, end, &start.cell, to)),
        (Some(_), None) => start.bounds.zip(end_bounds).map(|(from, to)| PxRect {
            left: from.left.min(to.left),
            top: from.top.min(to.top),
            right: from.right.max(to.right),
            bottom: from.bottom.max(to.bottom),
        }),
        (None, _) => None,
    };
    write_cells(&start, tick_ms, to, fill, selection, out);
    None
}

/// What UI Automation finds at (`x`, `y`) in `window`, waiting up to 300 ms.
fn element_at(uia: &UiaClient, x: i32, y: i32, window: &WindowInfo) -> Option<ElementFacts> {
    let id = NEXT_DRAG_ID.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    uia.request(id, x, y, window.hwnd);
    let mut ignored = Stats::default();
    lookup_outcome(
        uia.wait(id, started, started + Duration::from_millis(300)),
        &mut ignored,
    )
    .0
}

/// The box of the cell whose fill handle was pressed. A press just past the corner, in the next
/// column or row, found that cell instead, so the handle's cell is looked up just inside its
/// corner.
fn handle_cell_box(start: &DragStart, uia: &UiaClient) -> Option<PxRect> {
    if start.bounds.is_some() {
        return start.bounds;
    }
    let (x, y) = start.fill_corner?;
    let facts = element_at(uia, x - 2, y - 2, &start.window)?;
    (cell_of(&facts).as_deref() == Some(start.cell.as_str()))
        .then_some(facts.bounds)
        .flatten()
        .filter(|bounds| !bounds.is_empty())
}

/// A double-click on a fill handle: Excel fills down as far as the column beside it goes, so
/// there's no end cell to name, and the screenshot shows its handle.
pub(super) fn write_fill_down(start: &DragStart, tick_ms: u32, out: &mut Output) {
    write_cells(start, tick_ms, None, Some(FillKind::Double), None, out);
}

/// Writes cells selected or filled from `start` to `to` (none for a fill down the column, or one
/// dragged to where no cell was found), with the window's screenshot as it is now.
fn write_cells(
    start: &DragStart,
    tick_ms: u32,
    to: Option<String>,
    fill: Option<FillKind>,
    selection: Option<PxRect>,
    out: &mut Output,
) {
    let shot = out.shoot(&start.window);
    let capture = shot
        .as_ref()
        .map(|shot| CaptureFacts::of(shot, out.config.mode));
    let selection_pct = shot
        .as_ref()
        .zip(selection)
        .and_then(|(shot, area)| rect_to_pct(&shot.rect, &area));
    let handle_pct = shot
        .as_ref()
        .zip(fill.and(start.fill_corner))
        .and_then(|(shot, (x, y))| point_to_pct(&shot.rect, x, y));
    out.write(
        Record::Drag(crate::facts::DragRecord {
            id: NEXT_DRAG_ID.fetch_add(1, Ordering::Relaxed),
            of: start.of,
            tick_ms,
            from: start.cell.clone(),
            to,
            fill,
            window: window_facts(&start.window),
            capture,
            selection_pct,
            handle_pct,
        }),
        shot.map(|shot| shot.image),
    );
}

/// A left press on a canvas, waiting to see whether it draws (#73).
pub(super) struct DrawStart {
    pub(super) of: u64,
    pub(super) x: i32,
    pub(super) y: i32,
    /// The canvas, as the press found it.
    element: ElementFacts,
    window: WindowInfo,
    pub(super) at: Instant,
}

/// A left click that may draw: one on a canvas a pencil or brush draws on (`draw.rs`).
pub(super) fn draw_start(record: &ClickRecord, window: &WindowInfo) -> Option<DrawStart> {
    let element = record
        .element
        .as_ref()
        .filter(|element| drawing_canvas(element, window))?;
    Some(DrawStart {
        of: record.id,
        x: record.x,
        y: record.y,
        element: element.clone(),
        window: window.clone(),
        at: Instant::now(),
    })
}

/// A drawing on a canvas: it replaces the click it began with, and its screenshot, taken now,
/// shows what was drawn, with where it began marked.
pub(super) fn write_draw(start: &DrawStart, tick_ms: u32, out: &mut Output) {
    let shot = out.shoot(&start.window);
    let capture = shot
        .as_ref()
        .map(|shot| CaptureFacts::of(shot, out.config.mode));
    let from_pct = shot
        .as_ref()
        .and_then(|shot| point_to_pct(&shot.rect, start.x, start.y));
    out.write(
        Record::Draw(crate::facts::DrawRecord {
            id: NEXT_DRAG_ID.fetch_add(1, Ordering::Relaxed),
            of: start.of,
            tick_ms,
            element: start.element.clone(),
            window: window_facts(&start.window),
            capture,
            from_pct,
        }),
        shot.map(|shot| shot.image),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::{UiaOutcome, WindowFacts};
    use crate::platform::window::Elevation;

    /// A click on Excel's sheet at (`x`, `y`), where UI Automation found `element`.
    fn excel_click(x: i32, y: i32, element: Option<ElementFacts>) -> ClickRecord {
        let frame = PxRect {
            left: 0,
            top: 0,
            right: 1600,
            bottom: 900,
        };
        ClickRecord {
            id: 1,
            tick_ms: 1_000,
            button: "left",
            injected: false,
            x,
            y,
            window: WindowFacts {
                title: "Prices.xlsx - Excel".into(),
                exe: Some("EXCEL.EXE".into()),
                pid: 7,
                frame,
                elevation: "notElevated",
                remote_session: false,
                app_name: None,
                hosted_app: None,
                hosted_exe: None,
                owner_title: None,
                shell: false,
            },
            capture: CaptureFacts {
                mode: "window",
                rect: frame,
                monitor: frame,
                scale: 1.0,
                width: 1600,
                height: 900,
                image: None,
                notifications: Vec::new(),
            },
            click_pct: None,
            element,
            element_pct: None,
            uia: UiaOutcome {
                status: "ok",
                ms: 20.0,
                retried: false,
                error: None,
                pre_read: false,
            },
            screenshot_ms: 10.0,
            queue_delay_ms: 2,
            page: None,
            title_bar_button: None,
            filter_button: false,
            window_gone: false,
            menu_items: Vec::new(),
            menu_showing: false,
        }
    }

    #[test]
    fn a_left_click_on_a_cell_tells_typing_the_cell_it_selected() {
        let window = WindowInfo {
            hwnd: 9,
            pid: 7,
            title: "Prices.xlsx - Excel".into(),
            exe_path: Some(r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE".into()),
            frame: crate::platform::Rect {
                left: 0,
                top: 0,
                right: 1600,
                bottom: 900,
            },
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let e1 = ElementFacts {
            control_type: "DataItem".into(),
            class_name: "XLSpreadsheetCell".into(),
            name: "E1".into(),
            bounds: Some(PxRect {
                left: 300,
                top: 200,
                right: 364,
                bottom: 220,
            }),
            ..ElementFacts::default()
        };
        let selected =
            |x, y, element, button| cell_selected(&excel_click(x, y, element), &window, button);
        assert_eq!(
            selected(330, 210, Some(e1.clone()), MouseButton::Left),
            Some("E1".into())
        );
        // A right-click inside a selection keeps the selection.
        assert_eq!(
            selected(330, 210, Some(e1.clone()), MouseButton::Right),
            None
        );
        // A press on the cell's fill handle leaves the selection as it was.
        assert_eq!(selected(363, 219, Some(e1), MouseButton::Left), None);
        // Anything that isn't a cell, or a click the lookup didn't name.
        let bar = ElementFacts {
            control_type: "Edit".into(),
            name: "Formula Bar".into(),
            ..ElementFacts::default()
        };
        assert_eq!(selected(500, 100, Some(bar), MouseButton::Left), None);
        assert_eq!(selected(330, 210, None, MouseButton::Left), None);
    }

    #[test]
    fn a_press_on_a_headers_filter_drop_down_says_so_and_selects_no_cell() {
        // #70: header A1 ("Item") of a filtered range, its drop-down at its bottom right.
        let window = WindowInfo {
            hwnd: 9,
            pid: 7,
            title: "Prices.xlsx - Excel".into(),
            exe_path: Some(r"C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE".into()),
            frame: crate::platform::Rect {
                left: 0,
                top: 0,
                right: 1600,
                bottom: 900,
            },
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let a1 = ElementFacts {
            control_type: "DataItem".into(),
            class_name: "XLSpreadsheetCell".into(),
            name: "A1".into(),
            bounds: Some(PxRect {
                left: 64,
                top: 200,
                right: 160,
                bottom: 220,
            }),
            filter_header: Some("Item".into()),
            ..ElementFacts::default()
        };
        let pressed = |x, button| {
            let mut record = excel_click(x, 210, Some(a1.clone()));
            record.filter_button = filter_button_pressed(&record, button);
            record
        };
        let on_it = pressed(152, MouseButton::Left);
        assert!(on_it.filter_button);
        assert_eq!(serde_json::to_value(&on_it).unwrap()["filterButton"], true);
        // The menu opens; the selection stays where it was, and it's no drag.
        assert_eq!(cell_selected(&on_it, &window, MouseButton::Left), None);
        assert!(drag_start(&on_it, &window).is_none());
        // Elsewhere in the header, or with the right button, it's the cell as before.
        let on_cell = pressed(90, MouseButton::Left);
        assert!(!on_cell.filter_button);
        assert!(
            serde_json::to_value(&on_cell)
                .unwrap()
                .get("filterButton")
                .is_none()
        );
        assert_eq!(
            cell_selected(&on_cell, &window, MouseButton::Left),
            Some("A1".into())
        );
        assert!(!pressed(152, MouseButton::Right).filter_button);
    }

    /// Paint's window and a press on its canvas, as the test of 10/10/2026 recorded them (P15):
    /// the canvas is a Group named for the tool.
    fn paint_press(x: i32, y: i32, name: &str) -> (WindowInfo, ClickRecord) {
        let window = WindowInfo {
            hwnd: 0x6_0100,
            pid: 31_000,
            title: "Untitled - Paint".into(),
            exe_path: Some(
                r"C:\Program Files\WindowsApps\Microsoft.Paint_11.2508.361.0_x64__8wekyb3d8bbwe\PaintApp\mspaint.exe"
                    .into(),
            ),
            frame: crate::platform::Rect {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1032,
            },
            elevation: Elevation::NotElevated,
            hosted_exe: None,
            class: None,
        };
        let canvas = ElementFacts {
            control_type: "Group".into(),
            localized_control_type: "group".into(),
            name: name.into(),
            framework_id: "XAML".into(),
            bounds: Some(PxRect {
                left: 180,
                top: 240,
                right: 1740,
                bottom: 960,
            }),
            ..ElementFacts::default()
        };
        let mut record = excel_click(x, y, Some(canvas));
        record.window = window_facts(&window);
        (window, record)
    }

    #[test]
    fn a_pencil_stroke_on_paints_canvas_draws_and_a_click_there_stays_a_click() {
        // #73: the stroke of 10/10/2026 went down at (300, 652).
        let (window, press) = paint_press(300, 652, "Using Pencil tool on Canvas");
        let start = draw_start(&press, &window);
        assert!(start.is_some());
        let Some(start) = start else { return };
        // Let go across the canvas: a drawing. Let go where it went down, or a few pixels off
        // (a hand on the mouse): the click it was.
        assert!(dragged((start.x, start.y), (520, 610)));
        assert!(dragged((start.x, start.y), (300, 660)));
        assert!(!dragged((start.x, start.y), (300, 652)));
        assert!(!dragged((start.x, start.y), (305, 656)));
        // A selection's drag selects; and anything that isn't Paint's canvas is no drawing.
        let (window, press) = paint_press(300, 652, "Using Rectangle selection tool on Canvas");
        assert!(draw_start(&press, &window).is_none());
        assert!(draw_start(&excel_click(300, 652, None), &window).is_none());
    }

    #[test]
    fn a_drawing_is_journalled_as_the_app_reads_it() {
        // packages/core/src/recording.ts reads it as a `draw` fact replacing the click `of`.
        let (window, press) = paint_press(300, 652, "Using Pencil tool on Canvas");
        let record = Record::Draw(crate::facts::DrawRecord {
            id: 1 << 48,
            of: press.id,
            tick_ms: 2_400,
            element: press.element.clone().unwrap_or_default(),
            window: window_facts(&window),
            capture: None,
            from_pct: Some(crate::coords::PctPoint {
                x: 15.625,
                y: 63.178,
            }),
        });
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["kind"], "draw");
        assert_eq!(json["of"], 1);
        assert_eq!(json["element"]["name"], "Using Pencil tool on Canvas");
        assert_eq!(json["fromPct"]["x"], 15.625);
        assert_eq!(record.event_tick(), Some(2_400));
    }
}
