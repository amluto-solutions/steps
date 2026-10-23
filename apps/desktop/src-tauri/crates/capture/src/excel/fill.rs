//! Excel's fill handle (08/10/2026, docs/spec/02-capture.md#on-each-click): the small square
//! on the selected cell's bottom-right corner. Dragging it copies the cell down (or across) to
//! where the button comes up; double-clicking it fills down as far as the column beside it goes.
//!
//! Recordings showed why it needs its own rule. A press exactly on a cell's corner pixel belongs,
//! to UI Automation, to the cell below and right (a cell's box takes in its left and top edges,
//! not its right and bottom ones), so a double-click on H8's handle was recorded as
//! `Click "I9"`. Here the press is matched against the corners of the cell UI Automation found,
//! and the handle's cell is worked out from the cell's reference.

use super::cells::{cell_of, cell_ref, split_cell};
use crate::coords::PxRect;
use crate::facts::ElementFacts;

/// How far into a cell from its bottom-right corner a press is on its fill handle, in pixels at
/// 100% scale; [`HANDLE_REACH_OUT_PX`] is how far past the corner, into the cells right of and
/// below it.
///
/// Measured in two recordings at 100% (08/10 and 10/10/2026), with UI Automation's corner (a
/// cell's box takes in its left and top edges, not its right and bottom ones) at 0: Excel draws
/// the handle as a 5 px square from 3 px inside the corner to 1 px past it, ringed by a 1 px white
/// line (−4 to +2), on the selection's 2 px border (−1 to 0). Excel takes presses round that ring
/// too, further out than in: a press of 10/10 more than 4 px from the corner, in the next column,
/// started a fill (it had been recorded as `Select "G2:G9"`), and the tester put Excel's grip at
/// 6–7 px, more on the outer side. Inside, presses 7–8 px from the corner were ordinary clicks, and
/// text sits near a cell's bottom (numbers at its right too), where a double-click to edit must
/// stay a click. Excel scales its grid with the display (a 15 pt row is 20 px at 100%, 25 at 125%,
/// 30 at 150%) and its handle with it (not yet measured above 100%), so both reaches grow with the
/// scale: 5 and 6 px at 100%, 6 and 8 at 125%, 8 and 9 at 150%.
const HANDLE_REACH_IN_PX: f32 = 5.0;
/// How far past a cell's bottom-right corner a press is on its fill handle, at 100% scale.
const HANDLE_REACH_OUT_PX: f32 = 6.0;

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
    let reach = |px: f32| (px * scale.max(1.0)).round() as i32;
    let (reach_in, reach_out) = (reach(HANDLE_REACH_IN_PX), reach(HANDLE_REACH_OUT_PX));
    // The handle's cell lies up and left of its corner: a press there is inside it.
    let near = |offset: i32| (-reach_in..=reach_out).contains(&offset);
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
        .filter(|&(cx, cy, ..)| near(x - cx) && near(y - cy))
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
    let to = if fill {
        release.map(|release| filled_to(start, &release).unwrap_or(release))
    } else {
        release
    };
    match (fill, to) {
        (_, Some(to)) if to == start => DragEnd::Click,
        (true, to) => DragEnd::Fill { to },
        (false, Some(to)) => DragEnd::Select { to },
        (false, None) => DragEnd::Click,
    }
}

/// The last cell a fill from `from` reached, with the button up over `release`. Excel fills along
/// one axis only, down or up `from`'s column or along its row, whichever way the pointer went
/// further (the column, when it went as far each way), so the end is in that column or row. The
/// handle is often pressed just past its corner, in the next column or row, and the pointer stays
/// there: F2's handle pressed in G2 and dragged down came up over G9, with F2:F9 filled.
fn filled_to(from: &str, release: &str) -> Option<String> {
    let (from_column, from_row) = split_cell(from)?;
    let (column, row) = split_cell(release)?;
    Some(if column.abs_diff(from_column) > row.abs_diff(from_row) {
        cell_ref(column, from_row)
    } else {
        cell_ref(from_column, row)
    })
}

/// The cells a fill from `from` to `to` covered on the screen: the handle's cell's box,
/// `from_box`, stretched down (or up) to the row of `release_box`, the cell the button came up
/// over, or along to its column. The release may be in the next column or row (see
/// [`drag_end`]), which isn't filled.
pub(crate) fn filled_box(from_box: PxRect, release_box: PxRect, from: &str, to: &str) -> PxRect {
    let along_column = split_cell(from)
        .zip(split_cell(to))
        .is_some_and(|((from_column, _), (to_column, _))| from_column == to_column);
    if along_column {
        PxRect {
            top: from_box.top.min(release_box.top),
            bottom: from_box.bottom.max(release_box.bottom),
            ..from_box
        }
    } else {
        PxRect {
            left: from_box.left.min(release_box.left),
            right: from_box.right.max(release_box.right),
            ..from_box
        }
    }
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

    /// The handle's cell for a press at (`x`, `y`) on `facts` at `scale`.
    fn handle_of(x: i32, y: i32, facts: &ElementFacts, scale: f32) -> Option<String> {
        fill_handle_at(x, y, facts, scale).map(|handle| handle.cell)
    }

    #[test]
    fn at_100_percent_the_handle_reaches_5_px_into_the_cell_and_6_px_out() {
        // F2 and G2 as Excel draws them at 100% (64 × 20 px cells, the test of 10/10/2026): F2's
        // corner is at (496, 398). The press of 10/10 that Excel took for F2's handle was read as
        // G2, more than 4 px from the corner.
        let f2 = cell("F2", 432, 378, 496, 398);
        let g2 = cell("G2", 496, 378, 560, 398);
        assert_eq!(handle_of(502, 395, &g2, 1.0).as_deref(), Some("F2"));
        assert_eq!(handle_of(503, 395, &g2, 1.0), None);
        assert_eq!(handle_of(491, 393, &f2, 1.0).as_deref(), Some("F2"));
        assert_eq!(handle_of(490, 393, &f2, 1.0), None);
        // Below the corner, in F3 and G3.
        let f3 = cell("F3", 432, 398, 496, 418);
        let g3 = cell("G3", 496, 398, 560, 418);
        assert_eq!(handle_of(494, 404, &f3, 1.0).as_deref(), Some("F2"));
        assert_eq!(handle_of(494, 405, &f3, 1.0), None);
        assert_eq!(handle_of(502, 404, &g3, 1.0).as_deref(), Some("F2"));
    }

    #[test]
    fn at_125_percent_the_handle_reaches_6_px_in_and_8_px_out() {
        // 80 × 25 px cells; F2's corner at (620, 498).
        let f2 = cell("F2", 540, 473, 620, 498);
        let g2 = cell("G2", 620, 473, 700, 498);
        assert_eq!(handle_of(628, 492, &g2, 1.25).as_deref(), Some("F2"));
        assert_eq!(handle_of(629, 492, &g2, 1.25), None);
        assert_eq!(handle_of(614, 492, &f2, 1.25).as_deref(), Some("F2"));
        assert_eq!(handle_of(613, 492, &f2, 1.25), None);
    }

    #[test]
    fn at_150_percent_the_handle_reaches_8_px_in_and_9_px_out() {
        // 96 × 30 px cells; F2's corner at (744, 597).
        let f2 = cell("F2", 648, 567, 744, 597);
        let g2 = cell("G2", 744, 567, 840, 597);
        assert_eq!(handle_of(753, 590, &g2, 1.5).as_deref(), Some("F2"));
        assert_eq!(handle_of(754, 590, &g2, 1.5), None);
        assert_eq!(handle_of(736, 589, &f2, 1.5).as_deref(), Some("F2"));
        assert_eq!(handle_of(735, 589, &f2, 1.5), None);
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
    fn a_fill_names_the_cells_excel_filled_in_the_handles_column_or_row() {
        // The test of 10/10/2026: F2's handle, pressed just inside G2 and dragged down to row 9,
        // came up over G9. Excel fills along one axis, so it filled down column F.
        assert_eq!(
            drag_end("F2", true, true, Some("G9".into())),
            DragEnd::Fill {
                to: Some("F9".into())
            }
        );
        // Pressed just below the corner, in F3, and dragged right along row 3: row 2 filled.
        assert_eq!(
            drag_end("F2", true, true, Some("K3".into())),
            DragEnd::Fill {
                to: Some("K2".into())
            }
        );
        // Up a column and left along a row too.
        assert_eq!(
            drag_end("F9", true, true, Some("G2".into())),
            DragEnd::Fill {
                to: Some("F2".into())
            }
        );
        assert_eq!(
            drag_end("F9", true, true, Some("B10".into())),
            DragEnd::Fill {
                to: Some("B9".into())
            }
        );
        // Pressed beside the handle and let go in the next cell along: that cell filled.
        assert_eq!(
            drag_end("F2", true, true, Some("G2".into())),
            DragEnd::Fill {
                to: Some("G2".into())
            }
        );
    }

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn the_cells_filled_are_boxed_in_the_handles_column_or_row() {
        // F2's box, and G9's, where the button came up: F2:F9 is boxed, not column G.
        let f2 = rect(432, 378, 496, 398);
        assert_eq!(
            filled_box(f2, rect(496, 518, 560, 538), "F2", "F9"),
            rect(432, 378, 496, 538)
        );
        // Along row 2 to K2, the button up over K3.
        assert_eq!(
            filled_box(f2, rect(752, 398, 816, 418), "F2", "K2"),
            rect(432, 378, 816, 398)
        );
        // Up column F from F9, the button up over G2.
        assert_eq!(
            filled_box(
                rect(432, 518, 496, 538),
                rect(496, 378, 560, 398),
                "F9",
                "F2"
            ),
            rect(432, 378, 496, 538)
        );
    }

    #[test]
    fn a_selection_drag_ends_where_the_button_came_up() {
        // Only a fill keeps to a column or row: a selection drag selects to the cell it ended on.
        assert_eq!(
            drag_end("G2", false, true, Some("G9".into())),
            DragEnd::Select { to: "G9".into() }
        );
        assert_eq!(
            drag_end("D2", false, true, Some("F9".into())),
            DragEnd::Select { to: "F9".into() }
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
                    hosted_app: None,
                    hosted_exe: None,
                    owner_title: None,
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
