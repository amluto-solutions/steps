//! Screenshots at mouse-down (docs/spec/02-capture.md#on-each-click).
//!
//! The monitor under the click is captured through GDI and cropped to the clicked window's visible
//! frame, clipped to that monitor. GDI reads the composed desktop, so GPU-drawn windows
//! (browsers, Office) don't come out black, as they can with per-window capture. On Linux the X
//! server's screen is read the same way (`platform::screen`).

use std::time::Instant;

use image::RgbaImage;

use crate::coords::PxRect;

/// Whether to capture just the clicked window or its whole monitor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureMode {
    Window,
    Monitor,
}

impl CaptureMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Window => "window",
            Self::Monitor => "monitor",
        }
    }
}

/// A captured image and exactly where it came from.
pub struct Shot {
    pub image: RgbaImage,
    /// Captured area, physical pixels.
    pub rect: PxRect,
    pub monitor: PxRect,
    pub scale: f32,
    pub ms: f64,
}

/// A connected screen: where it is, whether it's the main one, and its monitor's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenInfo {
    /// Physical pixels.
    pub rect: PxRect,
    pub primary: bool,
    /// The monitor's own name ("DELL U2720Q"), when it gives one; never Windows' device name.
    pub name: Option<String>,
}

/// Connected displays, main one first, then left to right.
///
/// # Errors
/// If Windows reports no display.
#[cfg(windows)]
pub fn monitors() -> Result<Vec<ScreenInfo>, String> {
    let mut screens: Vec<ScreenInfo> = crate::platform::display::screens()
        .into_iter()
        .map(|screen| ScreenInfo {
            rect: screen.rect.into(),
            primary: screen.primary,
            name: screen.name,
        })
        .collect();
    if screens.is_empty() {
        return Err("Windows reports no display".into());
    }
    sort_screens(&mut screens);
    Ok(screens)
}

/// The main screen first, then left to right, then top to bottom: "Screen 1" is always the main
/// one, as in Windows Settings' usual numbering.
fn sort_screens(screens: &mut [ScreenInfo]) {
    screens.sort_by_key(|screen| (!screen.primary, screen.rect.left, screen.rect.top));
}

/// Captures around a physical point. In `Window` mode, `window_frame` is the clicked window.
///
/// # Errors
/// If the monitor can't be found or captured.
#[cfg(windows)]
pub fn capture(
    mode: CaptureMode,
    window_frame: Option<PxRect>,
    x: i32,
    y: i32,
    target_monitor: Option<PxRect>,
) -> Result<Shot, String> {
    let started = Instant::now();
    let monitor = if let Some(target) = target_monitor {
        xcap::Monitor::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|monitor| {
                let Ok(left) = monitor.x() else { return false };
                let Ok(top) = monitor.y() else { return false };
                let Ok(width) = monitor.width() else {
                    return false;
                };
                let Ok(height) = monitor.height() else {
                    return false;
                };
                target
                    == PxRect {
                        left,
                        top,
                        right: left.saturating_add(i32::try_from(width).unwrap_or(i32::MAX)),
                        bottom: top.saturating_add(i32::try_from(height).unwrap_or(i32::MAX)),
                    }
            })
            .ok_or_else(|| "The selected monitor is no longer available".to_string())?
    } else {
        xcap::Monitor::from_point(x, y).map_err(|error| error.to_string())?
    };
    let monitor_rect = PxRect {
        left: monitor.x().map_err(|error| error.to_string())?,
        top: monitor.y().map_err(|error| error.to_string())?,
        right: 0,
        bottom: 0,
    };
    let width = i32::try_from(monitor.width().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let height = i32::try_from(monitor.height().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let monitor_rect = PxRect {
        right: monitor_rect.left + width,
        bottom: monitor_rect.top + height,
        ..monitor_rect
    };

    let target = match (mode, window_frame) {
        (CaptureMode::Window, Some(frame)) => {
            frame.intersect(&monitor_rect).unwrap_or(monitor_rect)
        }
        _ => monitor_rect,
    };

    let to_u32 = |value: i32| u32::try_from(value).map_err(|error| error.to_string());
    let image = monitor
        .capture_region(
            to_u32(target.left - monitor_rect.left)?,
            to_u32(target.top - monitor_rect.top)?,
            to_u32(target.width())?,
            to_u32(target.height())?,
        )
        .map_err(|error| error.to_string())?;

    Ok(Shot {
        image,
        rect: target,
        monitor: monitor_rect,
        scale: monitor.scale_factor().unwrap_or(1.0),
        ms: (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0,
    })
}

/// Connected displays and their bounds, from `RandR`.
///
/// # Errors
/// If there's no X server.
#[cfg(target_os = "linux")]
pub fn monitors() -> Result<Vec<ScreenInfo>, String> {
    let monitors = crate::platform::display::monitors();
    if monitors.is_empty() {
        return Err("No X server to take screenshots from".into());
    }
    // RandR names outputs ("HDMI-1"), not monitors, and doesn't say which is the main one here.
    let mut screens: Vec<ScreenInfo> = monitors
        .into_iter()
        .map(|monitor| ScreenInfo {
            rect: PxRect::from(monitor.rect),
            primary: false,
            name: Some(monitor.name).filter(|name| !name.is_empty()),
        })
        .collect();
    sort_screens(&mut screens);
    Ok(screens)
}

/// Captures around a point. In `Window` mode, `window_frame` is the clicked window.
///
/// # Errors
/// If the monitor can't be found or captured.
#[cfg(target_os = "linux")]
pub fn capture(
    mode: CaptureMode,
    window_frame: Option<PxRect>,
    x: i32,
    y: i32,
    target_monitor: Option<PxRect>,
) -> Result<Shot, String> {
    use crate::platform::display::{monitor_at, monitors};
    let started = Instant::now();
    let monitor = match target_monitor {
        Some(target) => monitors()
            .into_iter()
            .find(|monitor| PxRect::from(monitor.rect) == target)
            .ok_or_else(|| "The selected monitor is no longer available".to_string())?,
        None => monitor_at(x, y).ok_or_else(|| "No monitor to capture".to_string())?,
    };
    let monitor_rect = PxRect::from(monitor.rect);
    let target = match (mode, window_frame) {
        (CaptureMode::Window, Some(frame)) => {
            frame.intersect(&monitor_rect).unwrap_or(monitor_rect)
        }
        _ => monitor_rect,
    };
    let image = crate::platform::screen::capture(crate::platform::Rect {
        left: target.left,
        top: target.top,
        right: target.right,
        bottom: target.bottom,
    })
    .map_err(|error| error.to_string())?;
    Ok(Shot {
        image,
        rect: target,
        monitor: monitor_rect,
        scale: monitor.scale,
        ms: (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0,
    })
}

/// A window that is showing, front to back, as `hidden_areas` needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layer {
    pub frame: PxRect,
    /// An excluded app's window: whatever of it shows is blacked out.
    pub hidden: bool,
    /// Click-through or layered, so it may not cover what is behind it.
    pub see_through: bool,
}

/// Past this many pieces an excluded window is simply hidden whole.
const MAX_PIECES: usize = 256;

/// The parts of the screen that show an excluded app: each excluded window's frame, less what an
/// opaque window in front of it covers. When unsure (a see-through window in front, or too many
/// pieces) more is hidden rather than less.
#[must_use]
pub fn hidden_areas(layers: &[Layer]) -> Vec<PxRect> {
    let mut covered: Vec<PxRect> = Vec::new();
    let mut hidden = Vec::new();
    for layer in layers {
        if layer.hidden {
            let mut pieces = vec![layer.frame];
            for cover in &covered {
                pieces = pieces
                    .iter()
                    .flat_map(|piece| subtract(piece, cover))
                    .collect();
                if pieces.len() > MAX_PIECES {
                    pieces = vec![layer.frame];
                    break;
                }
            }
            hidden.extend(pieces);
        }
        if layer.hidden || !layer.see_through {
            covered.push(layer.frame);
        }
    }
    hidden
}

/// `rect` less `cut`, as up to four rectangles.
fn subtract(rect: &PxRect, cut: &PxRect) -> Vec<PxRect> {
    let Some(overlap) = rect.intersect(cut) else {
        return vec![*rect];
    };
    [
        PxRect {
            bottom: overlap.top,
            ..*rect
        },
        PxRect {
            top: overlap.bottom,
            ..*rect
        },
        PxRect {
            top: overlap.top,
            bottom: overlap.bottom,
            right: overlap.left,
            ..*rect
        },
        PxRect {
            top: overlap.top,
            bottom: overlap.bottom,
            left: overlap.right,
            ..*rect
        },
    ]
    .into_iter()
    .filter(|piece| !piece.is_empty())
    .collect()
}

/// Paints `areas` (physical pixels) black in the shot.
pub fn black_out(shot: &mut Shot, areas: &[PxRect]) {
    fill(shot, areas, image::Rgba([0, 0, 0, 255]));
}

/// Paints `areas` (physical pixels) in `colour` in the shot.
fn fill(shot: &mut Shot, areas: &[PxRect], colour: image::Rgba<u8>) {
    let (width, height) = shot.image.dimensions();
    let rect = shot.rect;
    if rect.is_empty() {
        return;
    }
    // The image normally has exactly the rectangle's pixels; scale in case it ever doesn't.
    let to_x = |x: i32| {
        let offset = i64::from(x - rect.left) * i64::from(width) / i64::from(rect.width());
        u32::try_from(offset.clamp(0, i64::from(width))).unwrap_or(width)
    };
    let to_y = |y: i32| {
        let offset = i64::from(y - rect.top) * i64::from(height) / i64::from(rect.height());
        u32::try_from(offset.clamp(0, i64::from(height))).unwrap_or(height)
    };
    for area in areas.iter().filter_map(|area| area.intersect(&rect)) {
        for y in to_y(area.top)..to_y(area.bottom) {
            for x in to_x(area.left)..to_x(area.right) {
                shot.image.put_pixel(x, y, colour);
            }
        }
    }
}

/// Blacks out whatever the shot shows of an excluded app (docs/spec/02-capture.md#exclusions):
/// the click is on another window, but a password manager beside it would otherwise be in the
/// picture. `excluded` holds program file names in any case. Returns how many areas were hidden.
pub fn hide_excluded(shot: &mut Shot, excluded: &[String]) -> usize {
    if excluded.is_empty() {
        return 0;
    }
    let own = crate::platform::window::own_process_id();
    let mut names: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
    let layers: Vec<Layer> = crate::platform::window::shown_windows()
        .into_iter()
        .map(|window| {
            let frame = PxRect::from(window.frame);
            // Only windows in the picture need their program named, which takes a process query.
            let hidden = frame.intersect(&shot.rect).is_some()
                && window.pid != own
                && *names.entry(window.pid).or_insert_with(|| {
                    crate::platform::window::process_exe_name(window.pid).is_some_and(|name| {
                        excluded
                            .iter()
                            .any(|app| app.trim().eq_ignore_ascii_case(&name))
                    })
                });
            Layer {
                frame,
                hidden,
                // The recorder's own windows (bar, highlight) are never taken as covering anything.
                see_through: window.see_through || window.pid == own,
            }
        })
        .collect();
    let areas = hidden_areas(&layers);
    black_out(shot, &areas);
    areas.len()
}

/// What, front to back, lies over the window clicked in: every window before the first of its
/// program's own is another program's, in front of it. Its own windows (menus, drop-downs,
/// dialogs) are kept; the recorder's windows never cover anything.
#[must_use]
pub fn covering_areas(
    windows: &[(u32, PxRect, bool)],
    target_pid: u32,
    own_pid: u32,
) -> Vec<PxRect> {
    let mut layers = Vec::new();
    for &(pid, frame, see_through) in windows {
        if pid == target_pid {
            break;
        }
        if pid == own_pid {
            continue;
        }
        layers.push(Layer {
            frame,
            hidden: true,
            see_through,
        });
    }
    hidden_areas(&layers)
}

/// In "the window you click in" mode, greys out whatever another program's window covers of it
/// (F014, 01/10/2026): a chat or email that happened to be on top was in every screenshot. A plain
/// grey, so it reads as "something else was here", not as part of the app. Returns how many
/// areas were covered.
///
/// `stack` is the windows showing, front to back, when the click went down, if known: by now the
/// window clicked has come to the front, but the screenshot can still show what lay over it.
pub fn hide_covering(
    shot: &mut Shot,
    target_pid: u32,
    stack: Option<Vec<crate::platform::window::ShownWindow>>,
) -> usize {
    let own = crate::platform::window::own_process_id();
    let windows: Vec<(u32, PxRect, bool)> = stack
        .unwrap_or_else(crate::platform::window::shown_windows)
        .into_iter()
        .map(|window| (window.pid, PxRect::from(window.frame), window.see_through))
        .collect();
    let areas: Vec<PxRect> = covering_areas(&windows, target_pid, own)
        .into_iter()
        .filter(|area| area.intersect(&shot.rect).is_some())
        .collect();
    fill(shot, &areas, image::Rgba([208, 213, 221, 255]));
    areas.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_main_screen_comes_first_then_left_to_right() {
        let screen = |left: i32, primary: bool| ScreenInfo {
            rect: PxRect {
                left,
                top: 0,
                right: left + 1920,
                bottom: 1080,
            },
            primary,
            name: None,
        };
        let mut screens = vec![screen(1920, false), screen(-1920, false), screen(0, true)];
        sort_screens(&mut screens);
        let lefts: Vec<i32> = screens.iter().map(|screen| screen.rect.left).collect();
        assert_eq!(lefts, [0, -1920, 1920]);
    }

    const fn rect(left: i32, top: i32, right: i32, bottom: i32) -> PxRect {
        PxRect {
            left,
            top,
            right,
            bottom,
        }
    }

    const fn layer(frame: PxRect, hidden: bool, see_through: bool) -> Layer {
        Layer {
            frame,
            hidden,
            see_through,
        }
    }

    fn area(rects: &[PxRect]) -> i64 {
        rects
            .iter()
            .map(|piece| i64::from(piece.width()) * i64::from(piece.height()))
            .sum()
    }

    #[test]
    fn only_other_programs_windows_in_front_of_the_clicked_one_are_covered() {
        let app = rect(0, 0, 1000, 800);
        let chat = rect(700, 0, 1000, 800);
        let menu = rect(100, 100, 300, 400);
        let behind = rect(0, 0, 1920, 1080);
        // Front to back: our highlight, a chat app, the app's own menu, the app, something behind.
        let windows = [
            (1, rect(500, 500, 520, 520), true),
            (7, chat, false),
            (3, menu, false),
            (3, app, false),
            (9, behind, false),
        ];
        assert_eq!(covering_areas(&windows, 3, 1), vec![chat]);
        // Nothing of another program in front: nothing covered.
        assert!(covering_areas(&windows[2..], 3, 1).is_empty());
    }

    #[test]
    fn an_excluded_window_is_hidden_where_it_shows() {
        let keepass = rect(0, 0, 100, 100);
        // Alone, it is hidden whole.
        assert_eq!(hidden_areas(&[layer(keepass, true, false)]), vec![keepass]);
        // Half covered by a window in front: only the half that shows.
        let front = rect(50, 0, 200, 100);
        let hidden = hidden_areas(&[layer(front, false, false), layer(keepass, true, false)]);
        assert_eq!(hidden, vec![rect(0, 0, 50, 100)]);
        // A window behind it changes nothing.
        let hidden = hidden_areas(&[layer(keepass, true, false), layer(front, false, false)]);
        assert_eq!(hidden, vec![keepass]);
        // Wholly covered: nothing shows.
        let cover = rect(-10, -10, 110, 110);
        assert!(
            hidden_areas(&[layer(cover, false, false), layer(keepass, true, false)]).is_empty()
        );
    }

    #[test]
    fn a_see_through_window_in_front_covers_nothing() {
        let keepass = rect(0, 0, 100, 100);
        let overlay = rect(0, 0, 1000, 1000);
        assert_eq!(
            hidden_areas(&[layer(overlay, false, true), layer(keepass, true, false)]),
            vec![keepass]
        );
    }

    #[test]
    fn a_window_in_the_middle_leaves_a_frame_around_it() {
        let keepass = rect(0, 0, 100, 100);
        let middle = rect(25, 25, 75, 75);
        let hidden = hidden_areas(&[layer(middle, false, false), layer(keepass, true, false)]);
        assert_eq!(hidden.len(), 4);
        assert_eq!(area(&hidden), 100 * 100 - 50 * 50);
        assert!(
            hidden
                .iter()
                .all(|piece| piece.intersect(&middle).is_none())
        );
    }

    #[test]
    fn blacking_out_paints_only_the_area_inside_the_shot() {
        let mut shot = Shot {
            image: RgbaImage::from_pixel(10, 10, image::Rgba([255, 255, 255, 255])),
            rect: rect(100, 100, 110, 110),
            monitor: rect(0, 0, 1920, 1080),
            scale: 1.0,
            ms: 0.0,
        };
        black_out(&mut shot, &[rect(95, 95, 105, 102)]);
        let black = |x, y| shot.image.get_pixel(x, y).0 == [0, 0, 0, 255];
        assert!(black(0, 0) && black(4, 1));
        assert!(!black(5, 0) && !black(0, 2));
        assert_eq!(
            shot.image.pixels().filter(|pixel| pixel.0[0] == 0).count(),
            5 * 2
        );
    }
}
