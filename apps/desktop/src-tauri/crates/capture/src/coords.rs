//! The one place screen coordinates become image percentages
//! (docs/spec/02-capture.md#coordinates-and-dpi). TypeScript never sees screen coordinates.
//!
//! Everything here is physical pixels in virtual-screen space, because the process is
//! Per-Monitor-V2 DPI aware.

use serde::{Deserialize, Serialize};

/// A physical-pixel rectangle. `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PxRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl PxRect {
    #[must_use]
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    #[must_use]
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }

    #[must_use]
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }

    /// The overlap of two rectangles, or `None` if they don't overlap.
    #[must_use]
    pub fn intersect(&self, other: &Self) -> Option<Self> {
        let rect = Self {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        };
        (!rect.is_empty()).then_some(rect)
    }
}

impl From<crate::platform::Rect> for PxRect {
    fn from(rect: crate::platform::Rect) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

/// A point as a percentage of the captured image, 0–100.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PctPoint {
    pub x: f64,
    pub y: f64,
}

/// A rectangle as percentages of the captured image, 0–100.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PctRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn pct(offset: i32, extent: i32) -> f64 {
    let value = f64::from(offset) / f64::from(extent) * 100.0;
    (value * 1000.0).round() / 1000.0
}

/// A physical point as a percentage of `capture`, or `None` if it falls outside it.
#[must_use]
pub fn point_to_pct(capture: &PxRect, x: i32, y: i32) -> Option<PctPoint> {
    if capture.is_empty() || !capture.contains(x, y) {
        return None;
    }
    Some(PctPoint {
        x: pct(x - capture.left, capture.width()),
        y: pct(y - capture.top, capture.height()),
    })
}

/// A physical rectangle as percentages of `capture`, clipped to it, or `None` if they don't overlap.
#[must_use]
pub fn rect_to_pct(capture: &PxRect, rect: &PxRect) -> Option<PctRect> {
    if capture.is_empty() {
        return None;
    }
    let clipped = capture.intersect(rect)?;
    Some(PctRect {
        x: pct(clipped.left - capture.left, capture.width()),
        y: pct(clipped.top - capture.top, capture.height()),
        w: pct(clipped.width(), capture.width()),
        h: pct(clipped.height(), capture.height()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Vectors {
        points: Vec<PointCase>,
        rects: Vec<RectCase>,
    }

    #[derive(Deserialize)]
    struct PointCase {
        name: String,
        capture: [i32; 4],
        point: [i32; 2],
        expect: Option<[f64; 2]>,
    }

    #[derive(Deserialize)]
    struct RectCase {
        name: String,
        capture: [i32; 4],
        rect: [i32; 4],
        expect: Option<[f64; 4]>,
    }

    fn rect(values: [i32; 4]) -> PxRect {
        PxRect {
            left: values[0],
            top: values[1],
            right: values[2],
            bottom: values[3],
        }
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/coords.json"
        ))
        .unwrap()
    }

    #[test]
    fn points_match_shared_vectors() {
        for case in vectors().points {
            let got =
                point_to_pct(&rect(case.capture), case.point[0], case.point[1]).map(|p| [p.x, p.y]);
            assert_eq!(got, case.expect, "{}", case.name);
        }
    }

    #[test]
    fn rects_match_shared_vectors() {
        for case in vectors().rects {
            let got =
                rect_to_pct(&rect(case.capture), &rect(case.rect)).map(|r| [r.x, r.y, r.w, r.h]);
            assert_eq!(got, case.expect, "{}", case.name);
        }
    }
}
