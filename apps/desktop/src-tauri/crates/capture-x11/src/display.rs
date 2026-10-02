//! Monitors, the pointer, the scale and the last-input tick.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::screensaver::{ConnectionExt as _, State};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};

use crate::Rect;
use crate::connection::{Display, shared};

/// Nothing to do on X11: the server works in physical pixels already. Kept so callers read the
/// same on both platforms.
#[must_use]
pub fn enable_per_monitor_dpi_awareness() -> bool {
    true
}

/// A monitor.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    /// Whole monitor, physical pixels.
    pub rect: Rect,
    /// Effective DPI (96 = 100%).
    pub dpi: u32,
    /// `dpi / 96`, e.g. 1.5 for 150%.
    pub scale: f32,
    /// The output's name (`HDMI-1`), for the monitor list.
    pub name: String,
}

/// Every monitor, from `RandR` (1.5's monitors), or the whole screen when it has none.
#[must_use]
pub fn monitors() -> Vec<MonitorInfo> {
    let Some(display) = shared() else {
        return Vec::new();
    };
    let (dpi, scale) = dpi_and_scale(display);
    let from_randr = display
        .connection
        .randr_get_monitors(display.root, true)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| {
            reply
                .monitors
                .iter()
                .map(|monitor| MonitorInfo {
                    rect: Rect {
                        left: i32::from(monitor.x),
                        top: i32::from(monitor.y),
                        right: i32::from(monitor.x) + i32::from(monitor.width),
                        bottom: i32::from(monitor.y) + i32::from(monitor.height),
                    },
                    dpi,
                    scale,
                    name: atom_name(display, monitor.name).unwrap_or_else(|| "Monitor".into()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !from_randr.is_empty() {
        return from_randr;
    }
    display
        .connection
        .setup()
        .roots
        .iter()
        .find(|screen| screen.root == display.root)
        .map(|screen| MonitorInfo {
            rect: Rect {
                left: 0,
                top: 0,
                right: i32::from(screen.width_in_pixels),
                bottom: i32::from(screen.height_in_pixels),
            },
            dpi,
            scale,
            name: "Screen".into(),
        })
        .into_iter()
        .collect()
}

fn atom_name(display: &Display, atom: u32) -> Option<String> {
    let reply = display.connection.get_atom_name(atom).ok()?.reply().ok()?;
    String::from_utf8(reply.name).ok()
}

/// The desktop's scale: `Xft.dpi` from the X resources (what GNOME and KDE set for scaling),
/// else 96, i.e. 100%.
fn dpi_and_scale(display: &Display) -> (u32, f32) {
    let dpi = display
        .connection
        .get_property(
            false,
            display.root,
            display.atoms.resource_manager,
            AtomEnum::STRING,
            0,
            1 << 20,
        )
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|reply| xft_dpi(&String::from_utf8_lossy(&reply.value)))
        .unwrap_or(96);
    #[allow(clippy::cast_precision_loss, reason = "DPI values are small integers")]
    let scale = dpi as f32 / 96.0;
    (dpi, scale)
}

/// `Xft.dpi` in an X resources string.
fn xft_dpi(resources: &str) -> Option<u32> {
    resources.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim() != "Xft.dpi" {
            return None;
        }
        let dpi: f64 = value.trim().parse().ok()?;
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked to be a plausible DPI first"
        )]
        (48.0..=480.0).contains(&dpi).then(|| dpi.round() as u32)
    })
}

/// The monitor nearest to a point.
#[must_use]
pub fn monitor_at(x: i32, y: i32) -> Option<MonitorInfo> {
    let all = monitors();
    let distance = |rect: &Rect| {
        let dx = if x < rect.left {
            rect.left - x
        } else if x >= rect.right {
            x - rect.right + 1
        } else {
            0
        };
        let dy = if y < rect.top {
            rect.top - y
        } else if y >= rect.bottom {
            y - rect.bottom + 1
        } else {
            0
        };
        i64::from(dx) * i64::from(dx) + i64::from(dy) * i64::from(dy)
    };
    all.into_iter()
        .min_by_key(|monitor| distance(&monitor.rect))
}

/// Current pointer position in screen pixels.
#[must_use]
pub fn cursor_pos() -> Option<(i32, i32)> {
    let display = shared()?;
    let reply = display
        .connection
        .query_pointer(display.root)
        .ok()?
        .reply()
        .ok()?;
    Some((i32::from(reply.root_x), i32::from(reply.root_y)))
}

/// Tick ([`now_tick`]'s clock) of the last keyboard or mouse input, from the X server's idle
/// time.
#[must_use]
pub fn last_input_tick() -> Option<u32> {
    static LAST: AtomicU32 = AtomicU32::new(0);
    let display = shared()?;
    let info = display
        .connection
        .screensaver_query_info(display.root)
        .ok()?
        .reply()
        .ok()?;
    let tick = now_tick().wrapping_sub(info.ms_since_user_input);
    // The idle time and this process's clock are read a moment apart, so the same input can come
    // out a few ms different: within the jitter it's the same input, and the tick stays put.
    let previous = LAST.load(Ordering::Relaxed);
    if previous != 0 && (tick.wrapping_sub(previous) < 50 || previous.wrapping_sub(tick) < 50) {
        return Some(previous);
    }
    LAST.store(tick, Ordering::Relaxed);
    Some(tick)
}

/// The double-click time (ms) and the size of the double-click rectangle (px): GTK's defaults,
/// which most Linux desktops keep.
#[must_use]
pub fn double_click_settings() -> (u32, i32, i32) {
    (400, 5, 5)
}

/// Milliseconds on this process's clock (wrapping), which the input thread stamps events with.
/// X server timestamps aren't used: they're on the server's clock, which may be another machine's.
#[must_use]
pub fn now_tick() -> u32 {
    static START: OnceLock<Instant> = OnceLock::new();
    let elapsed = START.get_or_init(Instant::now).elapsed().as_millis();
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the tick wraps, as Windows' does"
    )]
    let tick = elapsed as u32;
    tick
}

/// Whether the desktop is taking input: `false` while the screen saver (the lock screen, on
/// most desktops) is showing, when nothing on screen can be recorded.
#[must_use]
pub fn input_desktop_is_default() -> bool {
    let Some(display) = shared() else {
        return false;
    };
    display
        .connection
        .screensaver_query_info(display.root)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_none_or(|info| info.state != u8::from(State::ON))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_desktops_scale_from_the_x_resources() {
        assert_eq!(xft_dpi("Xft.antialias:\t1\nXft.dpi:\t144\n"), Some(144));
        assert_eq!(xft_dpi("Xft.dpi: 96.0"), Some(96));
        assert_eq!(xft_dpi("Xcursor.size: 24"), None);
        assert_eq!(xft_dpi("Xft.dpi: 0"), None);
    }

    #[test]
    fn the_tick_moves_forward() {
        let first = now_tick();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(now_tick().wrapping_sub(first) >= 5);
    }
}
