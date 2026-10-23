//! Drawing on a canvas (12/10/2026, #73, docs/spec/02-capture.md#on-each-click): a pencil or
//! brush dragged across Paint's canvas draws, so it's a drag step (`Draw on the canvas`), not the
//! click it began with. In the test of 10/10/2026 (P15) a pencil stroke was recorded as
//! `Click "Using Pencil tool on Canvas"`.
//!
//! Windows 11's Paint names its canvas after the tool in use: "Using Pencil tool on Canvas"
//! (its `CanvasToolUseText`, "Using {} tool on Canvas"), a UI Automation Group. That label is
//! Paint's English one; Paint in another language says it in its own words, which aren't known
//! yet, so there a stroke stays the click it began with until they are added here.

use crate::facts::ElementFacts;
use crate::platform::window::WindowInfo;

/// Paint's program file.
const PAINT: &str = "mspaint.exe";

/// What Paint's canvas label says before and after the tool's name.
const CANVAS_LABEL: (&str, &str) = ("Using ", " tool on Canvas");

/// Tools whose drag doesn't draw: a selection selects, the text tool makes a box to type in, and
/// fill, the colour picker and the magnifier act where the button goes down or comes up.
const NOT_DRAWING: &[&str] = &["select", "text", "fill", "picker", "magnif"];

/// Whether a left press on `element`, in `window`, is on a canvas a drag draws on: Paint's, with
/// a tool that draws (the pencil, a brush, the eraser, a shape).
pub(crate) fn drawing_canvas(element: &ElementFacts, window: &WindowInfo) -> bool {
    window
        .exe_name()
        .is_some_and(|exe| exe.eq_ignore_ascii_case(PAINT))
        && element.control_type == "Group"
        && canvas_tool(&element.name).is_some_and(|tool| {
            let tool = tool.to_lowercase();
            !NOT_DRAWING.iter().any(|word| tool.contains(word))
        })
}

/// The tool Paint's canvas label names ("Pencil" in "Using Pencil tool on Canvas").
fn canvas_tool(name: &str) -> Option<&str> {
    let (before, after) = CANVAS_LABEL;
    name.strip_prefix(before)?
        .strip_suffix(after)
        .map(str::trim)
        .filter(|tool| !tool.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::PxRect;
    use crate::platform::window::Elevation;

    fn paint() -> WindowInfo {
        WindowInfo {
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
        }
    }

    /// Paint's canvas as the test of 10/10/2026 recorded it (P15): a Group named for the tool.
    fn canvas(name: &str) -> ElementFacts {
        ElementFacts {
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
        }
    }

    #[test]
    fn a_pencil_or_brush_on_paints_canvas_draws() {
        assert!(drawing_canvas(
            &canvas("Using Pencil tool on Canvas"),
            &paint()
        ));
        assert!(drawing_canvas(
            &canvas("Using Brush tool on Canvas"),
            &paint()
        ));
        assert!(drawing_canvas(
            &canvas("Using Eraser tool on Canvas"),
            &paint()
        ));
        assert!(drawing_canvas(
            &canvas("Using Rectangle tool on Canvas"),
            &paint()
        ));
    }

    #[test]
    fn a_tool_whose_drag_doesnt_draw_is_no_drawing() {
        for tool in [
            "Rectangle selection",
            "Free-form selection",
            "Text",
            "Fill",
            "Colour picker",
            "Color picker",
            "Magnifier",
        ] {
            let name = format!("Using {tool} tool on Canvas");
            assert!(!drawing_canvas(&canvas(&name), &paint()), "{name}");
        }
    }

    #[test]
    fn only_paints_canvas_counts() {
        // Paint's toolbar, and a Group that isn't the canvas.
        let pencil = ElementFacts {
            control_type: "Button".into(),
            name: "Pencil".into(),
            ..ElementFacts::default()
        };
        assert!(!drawing_canvas(&pencil, &paint()));
        assert!(!drawing_canvas(&canvas("Tools"), &paint()));
        assert!(!drawing_canvas(&canvas("Using  tool on Canvas"), &paint()));
        // The same label in another program.
        let other = WindowInfo {
            exe_path: Some(r"C:\Tools\sketch.exe".into()),
            ..paint()
        };
        assert!(!drawing_canvas(
            &canvas("Using Pencil tool on Canvas"),
            &other
        ));
    }
}
