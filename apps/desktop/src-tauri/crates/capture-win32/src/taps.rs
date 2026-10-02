//! Which touches were taps (docs/spec/02-capture.md#touch-and-pen), and where on the screen a
//! digitizer's contact is. Plain logic, tested without a touch screen; `touch.rs` feeds it the
//! contacts read from the device's reports.
//!
//! A tap is one finger (or a pen's tip) that touched and lifted without moving: it becomes a click
//! where it landed, or, held for over a second, a right-click (Windows' press-and-hold). A contact
//! that moved (a scroll or a drag) or had another beside it (a pinch or a two-finger scroll) makes
//! no step.

use std::collections::HashMap;

/// How far a contact may move and still be a tap, in physical pixels: a fingertip wobbles.
pub const TAP_SLOP: i32 = 24;
/// Held at least this long without moving: a press-and-hold, which Windows treats as a right-click.
pub const HOLD_MS: u32 = 1000;
/// A contact not heard of for this long is forgotten, with no step: a lost lift report.
pub const STALE_MS: u32 = 5000;

/// A contact as a report gives it, already placed on the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Contact {
    /// The device's id for the contact, stable from touch to lift.
    pub id: u32,
    /// Touching the screen (the tip switch), rather than lifted or a pen hovering.
    pub touching: bool,
    /// Physical screen pixels.
    pub x: i32,
    pub y: i32,
}

/// A tap: where the contact landed, and when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tap {
    pub x: i32,
    pub y: i32,
    pub tick_ms: u32,
    /// Held without moving: Windows' right-click.
    pub held: bool,
}

#[derive(Debug, Clone, Copy)]
struct Track {
    down_tick: u32,
    x: i32,
    y: i32,
    last_tick: u32,
    moved: bool,
    /// Another contact touched while this one did: a gesture, not a tap.
    gesture: bool,
}

/// The contacts touching each device, and the taps they make.
#[derive(Debug, Default)]
pub struct TapTracker {
    tracks: HashMap<(isize, u32), Track>,
}

impl TapTracker {
    /// Whether any contact is touching now.
    #[cfg(test)]
    #[must_use]
    pub fn touching(&self) -> bool {
        !self.tracks.is_empty()
    }

    /// Whether a contact touching now landed within `within` pixels of a point.
    #[must_use]
    pub fn near(&self, x: i32, y: i32, within: i32) -> bool {
        self.tracks
            .values()
            .any(|track| (track.x - x).abs() <= within && (track.y - y).abs() <= within)
    }

    /// Takes one report's contacts for a device; answers the taps that ended in it.
    pub fn update(&mut self, device: isize, contacts: &[Contact], tick_ms: u32) -> Vec<Tap> {
        let mut taps = Vec::new();
        // A contact whose lift was never reported is forgotten, without a step.
        self.tracks
            .retain(|_, track| tick_ms.wrapping_sub(track.last_tick) < STALE_MS);
        for contact in contacts {
            let key = (device, contact.id);
            if contact.touching {
                if let Some(track) = self.tracks.get_mut(&key) {
                    track.last_tick = tick_ms;
                    if (contact.x - track.x).abs() > TAP_SLOP
                        || (contact.y - track.y).abs() > TAP_SLOP
                    {
                        track.moved = true;
                    }
                } else {
                    // A second contact on the same device: everything touching is a gesture.
                    let others = self
                        .tracks
                        .iter_mut()
                        .filter(|((each, _), _)| *each == device);
                    let mut beside = false;
                    for (_, track) in others {
                        track.gesture = true;
                        beside = true;
                    }
                    self.tracks.insert(
                        key,
                        Track {
                            down_tick: tick_ms,
                            x: contact.x,
                            y: contact.y,
                            last_tick: tick_ms,
                            moved: false,
                            gesture: beside,
                        },
                    );
                }
            } else if let Some(track) = self.tracks.remove(&key) {
                // Lifted.
                if track.moved || track.gesture {
                    continue;
                }
                taps.push(Tap {
                    x: track.x,
                    y: track.y,
                    tick_ms: track.down_tick,
                    held: tick_ms.wrapping_sub(track.down_tick) >= HOLD_MS,
                });
            }
        }
        taps
    }
}

/// `DISPLAYCONFIG_ROTATION`: how the display the digitizer is mapped to is turned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    None,
    Quarter,
    Half,
    ThreeQuarters,
}

impl Rotation {
    /// From `POINTER_DEVICE_INFO.displayOrientation` (1 to 4; 0, as for injected touch, is none).
    #[must_use]
    pub fn from_display_config(value: u32) -> Self {
        match value {
            2 => Self::Quarter,
            3 => Self::Half,
            4 => Self::ThreeQuarters,
            _ => Self::None,
        }
    }
}

/// A report value's range, from the device's description.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub min: i32,
    pub max: i32,
}

impl Range {
    /// Where `value` sits in the range, 0 to 1.
    #[must_use]
    pub fn fraction(self, value: i32) -> f64 {
        let span = f64::from(self.max) - f64::from(self.min);
        if span <= 0.0 {
            return 0.0;
        }
        ((f64::from(value) - f64::from(self.min)) / span).clamp(0.0, 1.0)
    }
}

/// The screen rectangle a digitizer is mapped to, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Screen {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// A contact's place on the screen, from its place across the digitizer (0 to 1 each way, along
/// the digitizer's own axes). The digitizer is fixed to the panel: when the display is turned,
/// its axes turn with the panel, not with the picture on it.
#[must_use]
pub fn to_screen(screen: Screen, rotation: Rotation, across: f64, down: f64) -> (i32, i32) {
    let (sx, sy) = match rotation {
        Rotation::None => (across, down),
        // Turned a quarter clockwise: the panel's top edge is now the screen's left edge.
        Rotation::Quarter => (down, 1.0 - across),
        Rotation::Half => (1.0 - across, 1.0 - down),
        Rotation::ThreeQuarters => (1.0 - down, across),
    };
    let width = f64::from(screen.right - screen.left - 1).max(0.0);
    let height = f64::from(screen.bottom - screen.top - 1).max(0.0);
    let x = f64::from(screen.left) + (sx * width).round();
    let y = f64::from(screen.top) + (sy * height).round();
    // Within the screen's rectangle, so always within i32.
    #[allow(
        clippy::cast_possible_truncation,
        reason = "rounded and within the screen rectangle's i32 bounds"
    )]
    (x as i32, y as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: isize = 7;

    fn touch(id: u32, x: i32, y: i32) -> Contact {
        Contact {
            id,
            touching: true,
            x,
            y,
        }
    }

    fn lift(id: u32, x: i32, y: i32) -> Contact {
        Contact {
            id,
            touching: false,
            x,
            y,
        }
    }

    #[test]
    fn a_quick_touch_that_stays_put_is_a_tap_where_it_landed() {
        let mut taps = TapTracker::default();
        assert!(taps.update(DEVICE, &[touch(1, 500, 300)], 1000).is_empty());
        assert!(taps.touching());
        assert!(taps.update(DEVICE, &[touch(1, 510, 305)], 1040).is_empty());
        assert_eq!(
            taps.update(DEVICE, &[lift(1, 512, 306)], 1120),
            vec![Tap {
                x: 500,
                y: 300,
                tick_ms: 1000,
                held: false
            }]
        );
        assert!(!taps.touching());
    }

    #[test]
    fn a_touch_held_still_for_a_second_is_a_right_click() {
        let mut taps = TapTracker::default();
        taps.update(DEVICE, &[touch(1, 100, 100)], 1000);
        taps.update(DEVICE, &[touch(1, 101, 100)], 1600);
        let tap = taps.update(DEVICE, &[lift(1, 101, 100)], 2100);
        assert_eq!(tap.len(), 1);
        assert!(tap[0].held);
    }

    #[test]
    fn scrolls_drags_and_pinches_make_no_step() {
        let mut taps = TapTracker::default();
        // A scroll: the finger moves.
        taps.update(DEVICE, &[touch(1, 100, 500)], 1000);
        taps.update(DEVICE, &[touch(1, 100, 420)], 1050);
        assert!(taps.update(DEVICE, &[lift(1, 100, 300)], 1100).is_empty());
        // A pinch: a second finger joins; neither lift is a tap, even the one that stayed put.
        taps.update(DEVICE, &[touch(2, 400, 400)], 2000);
        taps.update(DEVICE, &[touch(2, 400, 400), touch(3, 600, 600)], 2020);
        assert!(
            taps.update(DEVICE, &[lift(3, 650, 650), touch(2, 400, 400)], 2100)
                .is_empty()
        );
        assert!(taps.update(DEVICE, &[lift(2, 400, 400)], 2150).is_empty());
    }

    #[test]
    fn a_lift_never_reported_is_forgotten_without_a_step() {
        let mut taps = TapTracker::default();
        taps.update(DEVICE, &[touch(1, 100, 100)], 1000);
        assert!(taps.update(DEVICE, &[], 1000 + STALE_MS).is_empty());
        assert!(!taps.touching());
        // The same id touching again later is a new contact.
        taps.update(DEVICE, &[touch(1, 200, 200)], 9000);
        assert_eq!(taps.update(DEVICE, &[lift(1, 200, 200)], 9050).len(), 1);
    }

    #[test]
    fn contacts_on_two_devices_are_kept_apart() {
        let mut taps = TapTracker::default();
        taps.update(1, &[touch(1, 100, 100)], 1000);
        // A pen on another device isn't a second finger.
        taps.update(2, &[touch(1, 800, 800)], 1010);
        assert_eq!(taps.update(1, &[lift(1, 100, 100)], 1050).len(), 1);
        assert_eq!(taps.update(2, &[lift(1, 800, 800)], 1060).len(), 1);
    }

    #[test]
    fn a_report_value_is_placed_within_its_range() {
        let range = Range { min: 0, max: 4095 };
        assert!((range.fraction(0) - 0.0).abs() < f64::EPSILON);
        assert!((range.fraction(4095) - 1.0).abs() < f64::EPSILON);
        assert!((range.fraction(5000) - 1.0).abs() < f64::EPSILON);
        assert!((Range { min: 10, max: 10 }.fraction(10)).abs() < f64::EPSILON);
    }

    #[test]
    fn the_digitizer_maps_onto_its_screen_as_the_display_is_turned() {
        // A 1920 x 1080 screen to the right of the primary.
        let screen = Screen {
            left: 1920,
            top: 0,
            right: 3840,
            bottom: 1080,
        };
        assert_eq!(to_screen(screen, Rotation::None, 0.0, 0.0), (1920, 0));
        assert_eq!(to_screen(screen, Rotation::None, 1.0, 1.0), (3839, 1079));
        assert_eq!(to_screen(screen, Rotation::None, 0.5, 0.5), (2880, 540));
        // Turned: the panel's top-left corner is where its edge now meets the screen.
        let portrait = Screen {
            left: 0,
            top: 0,
            right: 1080,
            bottom: 1920,
        };
        assert_eq!(to_screen(portrait, Rotation::Quarter, 0.0, 0.0), (0, 1919));
        assert_eq!(
            to_screen(portrait, Rotation::ThreeQuarters, 0.0, 0.0),
            (1079, 0)
        );
        assert_eq!(to_screen(screen, Rotation::Half, 0.0, 0.0), (3839, 1079));
        assert_eq!(Rotation::from_display_config(0), Rotation::None);
        assert_eq!(Rotation::from_display_config(2), Rotation::Quarter);
    }
}
