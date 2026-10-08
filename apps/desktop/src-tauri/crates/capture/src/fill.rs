//! Excel's fill handle (08/10/2026, docs/spec/02-capture.md#on-each-click): the small square
//! on the selected cell's bottom-right corner. Dragging it copies the cell down (or across) to
//! where the button comes up; double-clicking it fills down as far as the column beside it goes.
//!
//! Recordings showed why it needs its own rule. A press exactly on a cell's corner pixel belongs,
//! to UI Automation, to the cell below and right (a cell's box takes in its left and top edges,
//! not its right and bottom ones), so a double-click on H8's handle was recorded as
//! `Click "I9"`. Here the press is matched against the corners of the cell UI Automation found,
//! and the handle's cell is worked out from the cell's reference.

use crate::coords::PxRect;
use crate::facts::ElementFacts;
use crate::typing::cell_name;

/// How near a cell's bottom-right corner, either side, a press is on its fill handle, in pixels
/// at 100% scale. Excel draws the handle as a square about 6 px across centred on the corner, and
/// shows its thin cross pointer a pixel or two beyond it. Presses 7–8 px from the corner were
/// ordinary clicks in the recording this was measured on.
const HANDLE_REACH_PX: f32 = 4.0;

/// A press on a cell's fill handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FillHandle {
    /// The cell whose handle it is ("H8"), which may not be the cell UI Automation found.
    pub cell: String,
    /// That cell's box, when it was the cell found; otherwise not known.
    pub bounds: Option<PxRect>,
    /// The handle: the cell's bottom-right corner on the screen.
    pub corner: (i32, i32),
}

/// The spreadsheet cell an element is or sits in: Excel puts a link in a cell as an element of
/// its own, a `Hyperlink` whose parent is the cell and whose box is the cell's (a column of
/// datasheet links, 08/10/2026).
pub(crate) fn cell_of(facts: &ElementFacts) -> Option<String> {
    cell_name(facts).or_else(|| {
        let parent = facts.ancestors.first()?;
        (facts.control_type == "Hyperlink")
            .then(|| {
                cell_name(&ElementFacts {
                    control_type: parent.control_type.clone(),
                    name: parent.name.clone(),
                    ..ElementFacts::default()
                })
            })
            .flatten()
    })
}

/// The fill handle a press at (`x`, `y`) is on, if any, given the element UI Automation found
/// there and the screen's scale. The press can be on any of the four cells that meet at a
/// handle: just inside the cell's own corner, or just past it in the cell to the right, below,
/// or below and right, whose reference says which cell's handle it is.
pub(crate) fn fill_handle_at(
    x: i32,
    y: i32,
    facts: &ElementFacts,
    scale: f32,
) -> Option<FillHandle> {
    let cell = cell_of(facts)?;
    let bounds = facts.bounds.filter(|bounds| !bounds.is_empty())?;
    let (column, row) = split_cell(&cell)?;
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a few pixels: scales run from 1 to about 5"
    )]
    let reach = (HANDLE_REACH_PX * scale.max(1.0)).round() as i32;
    // Each corner of the cell found, with how many columns left and rows up the cell is whose
    // bottom-right corner that is.
    let corners = [
        (bounds.right, bounds.bottom, 0, 0),
        (bounds.left, bounds.bottom, 1, 0),
        (bounds.right, bounds.top, 0, 1),
        (bounds.left, bounds.top, 1, 1),
    ];
    let (corner_x, corner_y, left, up) = corners
        .into_iter()
        .filter(|&(cx, cy, ..)| (x - cx).abs() <= reach && (y - cy).abs() <= reach)
        .min_by_key(|&(cx, cy, ..)| (x - cx).abs().max((y - cy).abs()))?;
    let handle_column = column.checked_sub(left).filter(|column| *column >= 1)?;
    let handle_row = row.checked_sub(up).filter(|row| *row >= 1)?;
    Some(FillHandle {
        cell: cell_ref(handle_column, handle_row),
        bounds: (left == 0 && up == 0).then_some(bounds),
        corner: (corner_x, corner_y),
    })
}

/// What a press on a cell became once the button came up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DragEnd {
    /// It stayed a click: it didn't move far enough, or came back to the cell it began on, or
    /// (selecting) ended somewhere that isn't a cell.
    Click,
    /// Cells selected from the start to `to`.
    Select { to: String },
    /// The fill handle dragged to `to`, or to somewhere no cell was found under, which Excel's
    /// scrolling while it fills makes likely: still a fill, never dropped, but asking to be
    /// checked.
    Fill { to: Option<String> },
}

/// What a drag from `start` (the cell, or the handle's cell for a fill) came to: `moved` is
/// whether the button came up far enough away to be a drag, `release` the cell under it.
pub(crate) fn drag_end(start: &str, fill: bool, moved: bool, release: Option<String>) -> DragEnd {
    if !moved {
        return DragEnd::Click;
    }
    match (fill, release) {
        (_, Some(to)) if to == start => DragEnd::Click,
        (true, to) => DragEnd::Fill { to },
        (false, Some(to)) => DragEnd::Select { to },
        (false, None) => DragEnd::Click,
    }
}

/// A cell reference as its column and row numbers, from 1 ("H8" → 8, 8; "AA1" → 27, 1).
fn split_cell(name: &str) -> Option<(u32, u32)> {
    let letters = name.chars().take_while(char::is_ascii_uppercase).count();
    let (column_letters, row) = name.split_at(letters);
    let column = column_letters
        .bytes()
        .try_fold(0_u32, |sum, letter| {
            sum.checked_mul(26)?
                .checked_add(u32::from(letter - b'A') + 1)
        })
        .filter(|column| *column >= 1)?;
    let row = row.parse::<u32>().ok().filter(|row| *row >= 1)?;
    Some((column, row))
}

/// The reference of a cell by column and row numbers, from 1.
fn cell_ref(mut column: u32, row: u32) -> String {
    let mut letters = Vec::new();
    while column > 0 {
        let letter = u8::try_from((column - 1) % 26).unwrap_or(0);
        letters.push(char::from(b'A' + letter));
        column = (column - 1) / 26;
    }
    letters.iter().rev().collect::<String>() + &row.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::AncestorFacts;

    fn cell(name: &str, left: i32, top: i32, right: i32, bottom: i32) -> ElementFacts {
        ElementFacts {
            control_type: "DataItem".into(),
            name: name.into(),
            class_name: "XLSpreadsheetCell".into(),
            bounds: Some(PxRect {
                left,
                top,
                right,
                bottom,
            }),
            ..ElementFacts::default()
        }
    }

    /// H8's box in the Excel recording of 08/10/2026 (one monitor at 100%, left of the main one).
    const H8: (i32, i32, i32, i32) = (-680, 920, -342, 935);

    #[test]
    fn a_double_click_on_the_corner_pixel_is_h8s_handle_not_a_click_on_i9() {
        // Click #68: pressed at H8's bottom-right corner, where UI Automation found I9.
        let i9 = cell("I9", -342, 935, -292, 950);
        let handle = fill_handle_at(-342, 935, &i9, 1.0);
        assert_eq!(
            handle,
            Some(FillHandle {
                cell: "H8".into(),
                bounds: None,
                corner: (-342, 935),
            })
        );
    }

    #[test]
    fn a_press_a_pixel_past_g8s_corner_in_the_link_below_is_g8s_handle() {
        // Click #62: 1 px left of G8's right edge and 1 px below it, on the datasheet link that
        // fills G9.
        let g9_link = ElementFacts {
            control_type: "Hyperlink".into(),
            name: "Hyperlink https://example.test/datasheet.pdf".into(),
            bounds: Some(PxRect {
                left: -1071,
                top: 935,
                right: -680,
                bottom: 950,
            }),
            ancestors: vec![AncestorFacts {
                control_type: "DataItem".into(),
                name: "G9".into(),
            }],
            ..ElementFacts::default()
        };
        let handle = fill_handle_at(-681, 936, &g9_link, 1.0).map(|handle| handle.cell);
        assert_eq!(handle.as_deref(), Some("G8"));
    }

    #[test]
    fn a_press_seven_pixels_inside_the_corner_is_an_ordinary_click() {
        // Click #67: 7 px left of and 8 px above H8's corner.
        let (left, top, right, bottom) = H8;
        let h8 = cell("H8", left, top, right, bottom);
        assert_eq!(fill_handle_at(-349, 927, &h8, 1.0), None);
        // Click #109, a double-click in the middle of H8 to edit it.
        assert_eq!(fill_handle_at(-546, 927, &h8, 1.0), None);
    }

    #[test]
    fn a_press_just_inside_the_cells_own_corner_keeps_its_box() {
        let (left, top, right, bottom) = H8;
        let h8 = cell("H8", left, top, right, bottom);
        let handle = fill_handle_at(-344, 933, &h8, 1.0);
        assert_eq!(
            handle.as_ref().map(|handle| handle.cell.as_str()),
            Some("H8")
        );
        assert_eq!(handle.and_then(|handle| handle.bounds), h8.bounds);
    }

    #[test]
    fn presses_just_past_the_corner_name_the_cell_up_or_left() {
        // Below H8's corner, in H9; right of it, in I8.
        let h9 = cell("H9", -680, 935, -342, 950);
        assert_eq!(
            fill_handle_at(-344, 937, &h9, 1.0)
                .map(|h| h.cell)
                .as_deref(),
            Some("H8")
        );
        let i8 = cell("I8", -342, 920, -292, 935);
        assert_eq!(
            fill_handle_at(-340, 933, &i8, 1.0)
                .map(|h| h.cell)
                .as_deref(),
            Some("H8")
        );
    }

    #[test]
    fn the_reach_grows_with_the_screens_scale() {
        let i9 = cell("I9", -342, 935, -292, 950);
        assert_eq!(fill_handle_at(-336, 941, &i9, 1.0), None);
        assert_eq!(
            fill_handle_at(-336, 941, &i9, 1.5)
                .map(|h| h.cell)
                .as_deref(),
            Some("H8")
        );
    }

    #[test]
    fn the_first_row_and_column_have_no_cell_up_or_left() {
        let a1 = cell("A1", 0, 0, 64, 20);
        assert_eq!(fill_handle_at(1, 1, &a1, 1.0), None);
        assert_eq!(
            fill_handle_at(63, 19, &a1, 1.0).map(|h| h.cell).as_deref(),
            Some("A1")
        );
    }

    #[test]
    fn only_cells_and_links_in_cells_have_handles() {
        let button = ElementFacts {
            control_type: "Button".into(),
            name: "OK".into(),
            bounds: Some(PxRect {
                left: 0,
                top: 0,
                right: 80,
                bottom: 24,
            }),
            ..ElementFacts::default()
        };
        assert_eq!(fill_handle_at(80, 24, &button, 1.0), None);
        let mut header = cell("H", -680, 668, -342, 684);
        header.class_name = "XLGridColumnHeader".into();
        assert_eq!(fill_handle_at(-342, 684, &header, 1.0), None);
    }

    #[test]
    fn references_count_columns_past_z() {
        assert_eq!(split_cell("H8"), Some((8, 8)));
        assert_eq!(split_cell("AA10"), Some((27, 10)));
        assert_eq!(split_cell("XFD1048576"), Some((16_384, 1_048_576)));
        assert_eq!(cell_ref(26, 3), "Z3");
        assert_eq!(cell_ref(27, 3), "AA3");
        assert_eq!(cell_ref(16_384, 1), "XFD1");
        let i9 = cell("AA2", 0, 0, 64, 20);
        assert_eq!(
            fill_handle_at(0, 0, &i9, 1.0).map(|h| h.cell).as_deref(),
            Some("Z1")
        );
    }

    #[test]
    fn a_fill_handle_drag_is_always_a_step() {
        // Dragged down to H250.
        assert_eq!(
            drag_end("H8", true, true, Some("H250".into())),
            DragEnd::Fill {
                to: Some("H250".into())
            }
        );
        // Released where no cell was found (Excel had scrolled): still a fill, with no end.
        assert_eq!(drag_end("H8", true, true, None), DragEnd::Fill { to: None });
        // A double-click's first press doesn't move: a click until the second press arrives.
        assert_eq!(drag_end("H8", true, false, None), DragEnd::Click);
        // Dragged back onto its own cell: Excel fills nothing.
        assert_eq!(
            drag_end("H8", true, true, Some("H8".into())),
            DragEnd::Click
        );
    }

    #[test]
    fn a_selection_drag_needs_another_cell() {
        assert_eq!(
            drag_end("D38", false, true, Some("F42".into())),
            DragEnd::Select { to: "F42".into() }
        );
        assert_eq!(drag_end("D38", false, true, None), DragEnd::Click);
        assert_eq!(
            drag_end("D38", false, false, Some("F42".into())),
            DragEnd::Click
        );
        assert_eq!(
            drag_end("D38", false, true, Some("D38".into())),
            DragEnd::Click
        );
    }

    #[test]
    fn a_link_in_a_cell_names_the_cell() {
        let link = ElementFacts {
            control_type: "Hyperlink".into(),
            name: "Hyperlink https://example.test".into(),
            ancestors: vec![AncestorFacts {
                control_type: "DataItem".into(),
                name: "G9".into(),
            }],
            ..ElementFacts::default()
        };
        assert_eq!(cell_of(&link).as_deref(), Some("G9"));
        let text = ElementFacts {
            control_type: "Text".into(),
            name: "Total".into(),
            ancestors: link.ancestors.clone(),
            ..ElementFacts::default()
        };
        assert_eq!(cell_of(&text), None);
    }

    #[test]
    fn a_fill_is_journalled_as_a_drag_the_app_reads() {
        // packages/core/src/recording.ts reads these: a selection as before, a fill with `fill`
        // and, double-clicked, a null `to`.
        use crate::facts::{DragRecord, FillKind, Record, WindowFacts};
        let record = |to: Option<&str>, fill| {
            serde_json::to_value(Record::Drag(DragRecord {
                id: 1 << 48,
                of: 68,
                tick_ms: 165_400_890,
                from: "H8".into(),
                to: to.map(str::to_string),
                fill,
                window: WindowFacts {
                    title: "Book1 - Excel".into(),
                    exe: Some("EXCEL.EXE".into()),
                    pid: 1,
                    frame: PxRect::default(),
                    elevation: "notElevated",
                    remote_session: false,
                    app_name: None,
                    shell: false,
                },
                capture: None,
                selection_pct: None,
                handle_pct: None,
            }))
            .ok()
        };
        let double = record(None, Some(FillKind::Double));
        assert_eq!(
            double.as_ref().map(|json| &json["kind"]),
            Some(&"drag".into())
        );
        assert_eq!(
            double.as_ref().map(|json| &json["fill"]),
            Some(&"double".into())
        );
        assert_eq!(double.as_ref().map(|json| json["to"].is_null()), Some(true));
        let selection = record(Some("F42"), None);
        assert_eq!(
            selection.as_ref().map(|json| &json["to"]),
            Some(&"F42".into())
        );
        assert_eq!(selection.and_then(|json| json.get("fill").cloned()), None);
    }
}
