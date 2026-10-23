//! Excel's filter drop-down (12/10/2026, #70, docs/spec/02-capture.md#on-each-click): the small
//! button at the bottom right of each header cell of a filtered range or table, which opens the
//! filter's menu.
//!
//! Excel draws it inside the header cell and doesn't expose it as an element of its own: UI
//! Automation finds the cell there, and says the cell has one (`HasFilterDropdown`, one of Excel's
//! own UI Automation properties, read in `uia.rs`). Read as the cell, a click on it read
//! `Click "Item"` (the test of 10/10/2026, P39), and a reader clicked the cell, which opens
//! nothing. So whether the press was on the drop-down is told here from the cell's box.

use crate::facts::ElementFacts;

/// How big Excel draws the drop-down, in pixels at 100% scale: a square of about 16 px, at the
/// cell's right and bottom edges, which grows with the display's scale as Excel's grid does (a
/// 15 pt row is 20 px at 100%, 30 at 150%). Taken a pixel or two generous, and never taller or
/// wider than the row is tall: in a short row the button is squeezed into it. Not yet measured
/// against a recording.
const BUTTON_PX: f32 = 18.0;

/// Whether a press at (`x`, `y`) is on the filter drop-down of the cell UI Automation found
/// there (`facts`), on a screen at `scale`: the cell says it has one, and the press is in the
/// square at its bottom right.
pub(crate) fn filter_button_at(x: i32, y: i32, facts: &ElementFacts, scale: f32) -> bool {
    if facts.filter_header.is_none() {
        return false;
    }
    let Some(bounds) = facts.bounds.filter(|bounds| !bounds.is_empty()) else {
        return false;
    };
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a few dozen pixels: scales run from 1 to about 5"
    )]
    let size = ((BUTTON_PX * scale.max(1.0)).round() as i32).min(bounds.bottom - bounds.top);
    // A cell's box takes in its left and top edges, not its right and bottom ones.
    (bounds.right - size..bounds.right).contains(&x)
        && (bounds.bottom - size..bounds.bottom).contains(&y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::PxRect;

    /// Header cell A1 of a filtered range at 100%, its header "Item": 96 px wide, a 20 px row.
    fn header(left: i32, top: i32, right: i32, bottom: i32) -> ElementFacts {
        ElementFacts {
            control_type: "DataItem".into(),
            name: "A1".into(),
            class_name: "XLSpreadsheetCell".into(),
            bounds: Some(PxRect {
                left,
                top,
                right,
                bottom,
            }),
            filter_header: Some("Item".into()),
            ..ElementFacts::default()
        }
    }

    #[test]
    fn a_press_on_the_drop_down_is_on_the_filter_button() {
        let a1 = header(64, 200, 160, 220);
        assert!(filter_button_at(152, 212, &a1, 1.0));
        // Its corners: the square runs to the cell's right and bottom edges, which are the next
        // cells' (a cell's box takes in its left and top edges, not its right and bottom ones).
        assert!(filter_button_at(142, 202, &a1, 1.0));
        assert!(filter_button_at(159, 219, &a1, 1.0));
    }

    #[test]
    fn a_press_elsewhere_in_the_header_cell_is_on_the_cell() {
        let a1 = header(64, 200, 160, 220);
        // On its words, and just left of the drop-down.
        assert!(!filter_button_at(90, 212, &a1, 1.0));
        assert!(!filter_button_at(140, 212, &a1, 1.0));
    }

    #[test]
    fn a_cell_without_a_filter_has_no_drop_down() {
        let plain = ElementFacts {
            filter_header: None,
            ..header(64, 200, 160, 220)
        };
        assert!(!filter_button_at(152, 212, &plain, 1.0));
    }

    #[test]
    fn a_tall_header_has_its_drop_down_at_the_bottom() {
        // Wrapped words make the header row 60 px tall: the drop-down stays at the bottom right.
        let a1 = header(64, 200, 160, 260);
        assert!(filter_button_at(152, 250, &a1, 1.0));
        assert!(!filter_button_at(152, 210, &a1, 1.0));
    }

    #[test]
    fn a_short_row_squeezes_the_drop_down_into_it() {
        // A 15 px row: the square is 15 px, so a press 16 px from the right edge is on the cell.
        let a1 = header(64, 200, 160, 215);
        assert!(filter_button_at(150, 207, &a1, 1.0));
        assert!(!filter_button_at(144, 207, &a1, 1.0));
    }

    #[test]
    fn the_drop_down_grows_with_the_display_scale() {
        // At 150% the row is 30 px and the drop-down 27 px; a press 25 px in is on it.
        let a1 = header(96, 300, 240, 330);
        assert!(filter_button_at(215, 318, &a1, 1.5));
        assert!(!filter_button_at(215, 318, &a1, 1.0));
    }

    #[test]
    fn a_cell_with_no_box_has_no_drop_down_to_press() {
        let unplaced = ElementFacts {
            bounds: None,
            ..header(0, 0, 0, 0)
        };
        assert!(!filter_button_at(0, 0, &unplaced, 1.0));
    }
}
