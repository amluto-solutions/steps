//! Spreadsheet cell references ("H8", "AA10"), as Excel names its cells and UI Automation
//! reports them: a cell's own (`cell_name`, a `LibreOffice` Calc cell's too), the cell a link sits
//! in (`cell_of`), a reference typed into Go To or the Name Box (`cell_reference`), and their
//! columns and rows as numbers. One reason to change: how a cell's reference is read or written.

use crate::facts::ElementFacts;

/// A spreadsheet cell's reference ("B6"), when the element with focus is one.
pub(crate) fn cell_name(facts: &ElementFacts) -> Option<String> {
    let name = facts.name.trim().replace('$', "");
    let letters = name.chars().take_while(char::is_ascii_uppercase).count();
    let digits = name
        .chars()
        .skip(letters)
        .take_while(char::is_ascii_digit)
        .count();
    let cellish = matches!(
        facts.control_type.as_str(),
        "DataItem" | "ListItem" | "Edit" | "Custom" | "Text"
    );
    (cellish
        && (1..=3).contains(&letters)
        && (1..=7).contains(&digits)
        && letters + digits == name.chars().count())
    .then_some(name)
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

/// A single cell's reference as Excel names it ("D11"), when `text` is one: `d11` and `$D$11`
/// too. A range, a name, another sheet's cell or anything past Excel's last cell (XFD1048576)
/// isn't (#69).
pub(crate) fn cell_reference(text: &str) -> Option<String> {
    let reference = text.trim().replace('$', "").to_ascii_uppercase();
    let (column, row) = split_cell(&reference)?;
    (column <= 16_384 && row <= 1_048_576).then_some(reference)
}

/// A cell reference as its column and row numbers, from 1 ("H8" → 8, 8; "AA1" → 27, 1).
pub(crate) fn split_cell(name: &str) -> Option<(u32, u32)> {
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
pub(crate) fn cell_ref(mut column: u32, row: u32) -> String {
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

    #[test]
    fn cells_are_named_by_their_reference() {
        let cell = |control: &str, name: &str| ElementFacts {
            control_type: control.into(),
            name: name.into(),
            ..ElementFacts::default()
        };
        assert_eq!(cell_name(&cell("DataItem", "B6")), Some("B6".into()));
        assert_eq!(cell_name(&cell("Custom", "$AA$120")), Some("AA120".into()));
        assert_eq!(cell_name(&cell("Edit", "Name")), None);
        assert_eq!(cell_name(&cell("Button", "A1")), None);
        assert_eq!(cell_name(&cell("DataItem", "ABCD1")), None);
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
    fn a_reference_is_a_cell_gone_to_only_when_its_one_cell() {
        assert_eq!(cell_reference(" $d$11 ").as_deref(), Some("D11"));
        assert_eq!(cell_reference("XFD1048576").as_deref(), Some("XFD1048576"));
        // A range, a name, another sheet's cell, past Excel's last column or row, or no row.
        for text in [
            "D11:F20",
            "Totals",
            "Sheet2!A1",
            "XFE1",
            "A1048577",
            "A0",
            "D",
            "R11C4",
        ] {
            assert_eq!(cell_reference(text), None, "{text}");
        }
    }
}
