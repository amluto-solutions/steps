//! Screenshots at mouse-down (docs/spec/02-capture.md#on-each-click).
//!
//! The monitor under the click is captured through GDI and cropped to the clicked window's visible
//! frame (for a pop-up, the frame round it and the window it came from: [`Target`]), clipped to
//! that monitor. GDI reads the composed desktop, so GPU-drawn windows
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
    /// Where a notification toast shows in it, physical pixels ([`handle_other_windows`]): noted for
    /// the suggested blurs.
    pub notifications: Vec<PxRect>,
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

/// The window a screenshot is of, as window mode crops and greys round it
/// (docs/spec/02-capture.md#on-each-click).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    /// The program of the window clicked in (or typed in, or in front).
    pub pid: u32,
    /// That window's frame.
    pub frame: PxRect,
    /// For a click in a pop-up (a menu, a drop-down): the window it came from, which the
    /// screenshot shows with the pop-up on top (#72).
    pub owner: Option<Owner>,
}

/// The window a pop-up came from: its program and frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Owner {
    pub pid: u32,
    pub frame: PxRect,
}

impl Target {
    /// A window on its own, no pop-up's.
    #[must_use]
    pub const fn window(pid: u32, frame: PxRect) -> Self {
        Self {
            pid,
            frame,
            owner: None,
        }
    }

    /// What a window-mode screenshot of it shows, before it's kept to the monitor: the window, or
    /// for a pop-up the window it came from with the pop-up on top, the area round both. Excel's
    /// right-click menu alone (194 × 563 px, P11 of the 10/10/2026 test) didn't say where it came
    /// from.
    #[must_use]
    pub fn area(&self) -> PxRect {
        self.owner
            .map_or(self.frame, |owner| owner.frame.union(&self.frame))
    }

    /// Whether `pid` is a program the screenshot is of: the window's, or its owner's (a web view's
    /// menu is drawn by another program than the window it opened from).
    fn is_its(&self, pid: u32) -> bool {
        pid == self.pid || self.owner.is_some_and(|owner| owner.pid == pid)
    }

    /// How many of `windows`, front to back, lie in front of the window the screenshot is of: for
    /// a pop-up, the window it came from, found by its program and frame; otherwise, or when that
    /// isn't among them, the program's first window, as for any window clicked in.
    fn depth_in(&self, windows: &[StackWindow]) -> usize {
        self.owner
            .and_then(|owner| {
                windows
                    .iter()
                    .position(|window| window.pid == owner.pid && window.frame == owner.frame)
            })
            .or_else(|| windows.iter().position(|window| self.is_its(window.pid)))
            .unwrap_or(windows.len())
    }
}

/// The part of the monitor a screenshot takes: in window mode `window` (a [`Target::area`]) where
/// it's on the monitor, otherwise (or with none of it there) the whole monitor.
#[must_use]
pub fn capture_area(mode: CaptureMode, window: Option<PxRect>, monitor: PxRect) -> PxRect {
    match (mode, window) {
        (CaptureMode::Window, Some(frame)) => frame.intersect(&monitor).unwrap_or(monitor),
        _ => monitor,
    }
}

/// Captures around a physical point. In `Window` mode, `window_frame` is what's shown of the
/// clicked window ([`Target::area`]).
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

    let target = capture_area(mode, window_frame, monitor_rect);

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
        notifications: Vec::new(),
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

/// Captures around a point. In `Window` mode, `window_frame` is what's shown of the clicked
/// window ([`Target::area`]).
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
    let target = capture_area(mode, window_frame, monitor_rect);
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
        notifications: Vec::new(),
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
/// picture, and so would a pop-up its window owns, drawn by a web view (#110). `excluded` holds
/// program file names in any case. Returns how many areas were hidden.
pub fn hide_excluded(shot: &mut Shot, excluded: &[String]) -> usize {
    if excluded.is_empty() {
        return 0;
    }
    let layers = exclusion_layers(
        &crate::platform::window::shown_windows(),
        shot.rect,
        crate::platform::window::own_process_id(),
        excluded,
        crate::platform::window::process_exe_name,
        crate::platform::window::owner_processes_of,
    );
    let areas = hidden_areas(&layers);
    black_out(shot, &areas);
    areas.len()
}

/// The showing `windows`, front to back, as layers for [`hidden_areas`]: hidden when in `picture`
/// and an excluded app's, by its own program (on the `excluded` list) or by a window up its owners
/// (#110: a pop-up an excluded app's window owns, whoever draws it), judged as a click in it is
/// ([`crate::exclusions::is_owned_by_excluded`], #103), so an owner whose program can't be named
/// counts while anything is excluded. A window's own program is judged as before, only by the
/// list. Steps' own windows (`own_pid`: the bar, the highlight) are never hidden nor taken as
/// covering anything, nor make a pop-up they own an excluded app's.
///
/// Only windows in the picture are asked about: `program_of` names a process (a process query,
/// asked once a process) and `owners_of` reads the processes up a window's owners.
fn exclusion_layers(
    windows: &[crate::platform::window::ShownWindow],
    picture: PxRect,
    own_pid: u32,
    excluded: &[String],
    mut program_of: impl FnMut(u32) -> Option<String>,
    mut owners_of: impl FnMut(isize) -> Vec<u32>,
) -> Vec<Layer> {
    let mut names: std::collections::HashMap<u32, Option<String>> =
        std::collections::HashMap::new();
    let mut name_of = |pid: u32| names.entry(pid).or_insert_with(|| program_of(pid)).clone();
    windows
        .iter()
        .map(|window| {
            let frame = PxRect::from(window.frame);
            let hidden = frame.intersect(&picture).is_some()
                && window.pid != own_pid
                && (name_of(window.pid)
                    .is_some_and(|name| crate::exclusions::is_listed(excluded, &name))
                    || crate::exclusions::is_owned_by_excluded(
                        window.pid,
                        &owners_of(window.hwnd),
                        |owner| {
                            owner != own_pid
                                && crate::exclusions::is_excluded_program(
                                    excluded,
                                    name_of(owner).as_deref(),
                                )
                        },
                    ));
            Layer {
                frame,
                hidden,
                see_through: window.see_through || window.pid == own_pid,
            }
        })
        .collect()
}

/// A window showing when a screenshot was taken, as the covering and notification rules need it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StackWindow {
    pub pid: u32,
    pub frame: PxRect,
    /// Click-through or layered, so it may not cover what is behind it.
    pub see_through: bool,
    /// Click-through and layered both: a click-through overlay, never a covering window.
    pub click_through: bool,
    /// One of the shell's notification windows: a notification toast.
    pub notification: bool,
}

impl From<crate::platform::window::ShownWindow> for StackWindow {
    fn from(window: crate::platform::window::ShownWindow) -> Self {
        Self {
            pid: window.pid,
            frame: PxRect::from(window.frame),
            see_through: window.see_through,
            click_through: window.click_through,
            notification: window.notification,
        }
    }
}

/// Which windows lying over the clicked one are greyed out in window mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cover {
    /// Every other program's window: the clicked window is an app's.
    Others,
    /// Only notification toasts: the clicked window is part of the Windows shell (Start, Search,
    /// the taskbar), which several shell programs draw, so their other windows are parts of it
    /// (04/10/2026: Search's own panel came out as a grey box).
    NotificationsOnly,
}

/// Whether each window, front to back, lies over the window clicked in and is greyed out: every
/// window in front of it ([`Target::depth_in`]) that is another program's. Its own windows (menus,
/// drop-downs, dialogs) are kept; the recorder's windows never cover anything.
fn covers(windows: &[StackWindow], target: &Target, own_pid: u32, cover: Cover) -> Vec<bool> {
    let depth = target.depth_in(windows);
    windows
        .iter()
        .enumerate()
        .map(|(index, window)| {
            // A notification toast is greyed out wherever it lies over the window, however it's
            // drawn: it often holds a message preview (P35, 10/10/2026).
            let counts = window.notification
                || (cover == Cover::Others
                    // A click-through overlay (a screen-share border, a game overlay, a dimmer)
                    // often spans the whole screen in front of everything, and shows nothing over
                    // the app: counted, it greyed out every window screenshot (10/10/2026).
                    && !window.click_through);
            index < depth && !target.is_its(window.pid) && window.pid != own_pid && counts
        })
        .collect()
}

/// What, front to back, lies over the window clicked in and is greyed out in window mode
/// ([`Cover`]): the parts of each covering window in view.
#[must_use]
pub fn covering_areas(
    windows: &[StackWindow],
    target: &Target,
    own_pid: u32,
    cover: Cover,
) -> Vec<PxRect> {
    let layers: Vec<Layer> = windows
        .iter()
        .zip(covers(windows, target, own_pid, cover))
        .filter_map(|(window, covering)| {
            if covering {
                Some(Layer {
                    frame: window.frame,
                    hidden: true,
                    see_through: window.see_through,
                })
            } else if target.is_its(window.pid) {
                // The program's own windows in front of a pop-up's owner (the pop-up itself) are
                // kept, so what they lie over isn't greyed: the menu over a chat over the sheet.
                Some(Layer {
                    frame: window.frame,
                    hidden: false,
                    see_through: false,
                })
            } else {
                None
            }
        })
        .collect();
    hidden_areas(&layers)
}

/// What of `area`, a pop-up's screenshot, is neither the window it came from nor the pop-up (nor
/// the program's other windows in front of that window, a submenu's menu): the corners of the area
/// round the two, where whatever lies behind them shows, another program's window or the desktop.
/// Greyed out as a covering window is (#72). Nothing for a window on its own, whose screenshot is
/// its frame. Past [`MAX_PIECES`] pieces, the rest of the windows aren't taken off: more is greyed
/// rather than less.
fn surrounding_areas(windows: &[StackWindow], target: &Target, area: PxRect) -> Vec<PxRect> {
    let Some(owner) = target.owner else {
        return Vec::new();
    };
    let kept = [owner.frame, target.frame].into_iter().chain(
        windows
            .iter()
            .take(target.depth_in(windows))
            .filter(|window| target.is_its(window.pid))
            .map(|window| window.frame),
    );
    let mut pieces = vec![area];
    for frame in kept {
        pieces = pieces
            .iter()
            .flat_map(|piece| subtract(piece, &frame))
            .collect();
        if pieces.len() > MAX_PIECES {
            break;
        }
    }
    pieces
}

/// What of `area`, a window-mode screenshot, is greyed once the window it is of has gone by the
/// time it was taken (its Close button, or OK on a dialog, closed it as the button came up): all
/// of it but where the program's windows show in `windows`, read after the picture. Its frame then
/// shows whatever was behind it, which can be another program (an email, a chat), and the windows
/// read as the button went down had that program behind the window, not over it. Another program's
/// window lying over one of the program's counts as it does over any window clicked in
/// ([`Cover::Others`], even for the shell's: the window that made it one has gone): a notification
/// toast does, a click-through overlay doesn't, and the recorder's own windows never do.
#[must_use]
pub fn gone_window_areas(
    windows: &[StackWindow],
    target: &Target,
    own_pid: u32,
    area: PxRect,
) -> Vec<PxRect> {
    let mut layers: Vec<Layer> = windows
        .iter()
        .filter(|window| window.frame.intersect(&area).is_some())
        .filter_map(|window| {
            if target.is_its(window.pid) {
                Some(Layer {
                    frame: window.frame,
                    hidden: false,
                    see_through: false,
                })
            } else if window.pid != own_pid && (window.notification || !window.click_through) {
                Some(Layer {
                    frame: window.frame,
                    hidden: true,
                    see_through: false,
                })
            } else {
                None
            }
        })
        .collect();
    // Whatever shows past the program's windows, under or beside the rest: the desktop, or no
    // window at all.
    layers.push(Layer {
        frame: area,
        hidden: true,
        see_through: false,
    });
    hidden_areas(&layers)
        .into_iter()
        .filter_map(|piece| piece.intersect(&area))
        .collect()
}

/// The most areas a screenshot's notifications are noted as; past it, one area round them all.
pub const MAX_NOTIFICATION_AREAS: usize = 50;

/// Where notification toasts show in a screenshot, for the suggested blurs (P35, 10/10/2026: a
/// chat message's preview was in a whole-monitor screenshot, unflagged): each toast's frame, less
/// what lies in front of it. Not a toast greyed out in window mode (`greyed`, the window mode's
/// [`Cover`]; `None` in monitor mode). One clicked in is flagged too, as is the notification
/// centre (#107): the shell draws every toast on screen in one window, so the toast clicked can't
/// be told from the others' message previews, and a click in one had left them all unflagged. The
/// recorder's own windows and see-through windows hide nothing. Past [`MAX_NOTIFICATION_AREAS`]
/// pieces, one area round them all.
#[must_use]
pub fn notification_areas(
    windows: &[StackWindow],
    target: &Target,
    own_pid: u32,
    greyed: Option<Cover>,
) -> Vec<PxRect> {
    let greyed = greyed.map_or_else(
        || vec![false; windows.len()],
        |cover| covers(windows, target, own_pid, cover),
    );
    let layers: Vec<Layer> = windows
        .iter()
        .zip(greyed)
        .map(|(window, greyed)| Layer {
            frame: window.frame,
            hidden: window.notification && !greyed && window.pid != own_pid,
            // A greyed-out window is painted over, so it hides what's behind it.
            see_through: !greyed && (window.see_through || window.pid == own_pid),
        })
        .collect();
    let areas = hidden_areas(&layers);
    if areas.len() <= MAX_NOTIFICATION_AREAS {
        return areas;
    }
    areas
        .into_iter()
        .reduce(|round, area| round.union(&area))
        .into_iter()
        .collect()
}

/// Readies a screenshot as far as other programs' windows go (docs/spec/02-capture.md#on-each-click).
/// In "the window you click in" mode, whatever lies over the window clicked in is greyed out
/// ([`covering_areas`]; F014, 01/10/2026: a chat or email that happened to be on top was in every
/// screenshot), in a plain grey, so it reads as "something else was here", not as part of the app.
/// For a click in a pop-up, that's whatever lies over the window it came from, and what shows round
/// the two ([`surrounding_areas`]). In either mode, where a notification toast still shows is
/// noted on the shot ([`notification_areas`]), and Windows' input panels are greyed out (#109).
/// Returns how many areas were greyed out.
///
/// `stack` is the windows showing, front to back, when the click went down, if known: by now the
/// window clicked has come to the front, but the screenshot can still show what lay over it.
/// `gone` says the window the shot is of had gone by the time it was taken ([`window_gone`]): in
/// window mode, everything but its program's windows is then greyed too, as the windows show now
/// ([`gone_window_areas`]).
pub fn handle_other_windows(
    shot: &mut Shot,
    mode: CaptureMode,
    target: &Target,
    cover: Cover,
    stack: Option<Vec<crate::platform::window::ShownWindow>>,
    gone: bool,
) -> usize {
    let own = crate::platform::window::own_process_id();
    let read_now = || -> Vec<StackWindow> {
        crate::platform::window::shown_windows()
            .into_iter()
            .map(StackWindow::from)
            .collect()
    };
    let gone = gone && mode == CaptureMode::Window;
    if let Some(stack) = stack {
        // The input panels as the windows were read: for a click, as the button went down, since
        // picking an item closes the panel before the picture.
        let panels = input_panel_areas(&stack);
        let pressed: Vec<StackWindow> = stack.into_iter().map(StackWindow::from).collect();
        let now = gone.then(read_now);
        grey_other_windows(
            shot,
            mode,
            target,
            cover,
            &pressed,
            now.as_deref(),
            own,
            &panels,
        )
    } else {
        // Read once, after the picture, it is both.
        let now = crate::platform::window::shown_windows();
        let panels = input_panel_areas(&now);
        let now: Vec<StackWindow> = now.into_iter().map(StackWindow::from).collect();
        let gone = gone.then_some(now.as_slice());
        grey_other_windows(shot, mode, target, cover, &now, gone, own, &panels)
    }
}

/// Where Windows' input panels show among `windows` (the emoji panel, clipboard history, the
/// touch keyboard, voice typing; [`crate::dictation::text_input_panels_among`]): the text input
/// host's windows, and frames showing one.
fn input_panel_areas(windows: &[crate::platform::window::ShownWindow]) -> Vec<PxRect> {
    crate::dictation::text_input_panels_among(windows, crate::platform::window::process_exe_name)
        .into_iter()
        .map(PxRect::from)
        .collect()
}

/// Whether the window `hwnd` a screenshot is of had gone from the point `(x, y)` it was taken at
/// (the click, or the window's middle), asked once the picture has been taken, so "still there"
/// means it was there while the picture was taken. Its Close button, or OK on a dialog, closes it
/// as the button comes up, and a dialog's Enter before its typing is handled: then the screenshot
/// shows what was behind it (F019, #48). Another window that came to that point since counts as
/// gone too: the window, still showing, keeps its program's place in the shot, and only another
/// program's window that came over it is greyed besides ([`gone_window_areas`]).
#[must_use]
pub fn window_gone(hwnd: isize, x: i32, y: i32) -> bool {
    crate::platform::window::root_window_at(x, y).map(|now| now.hwnd) != Some(hwnd)
}

/// [`handle_other_windows`] with the windows read: `windows` as the button went down (or now), and
/// `gone`, when the window the shot is of had gone by the time it was taken, those showing after
/// it. `own` is the recorder's program. `panels` are where Windows' input panels show
/// ([`input_panel_areas`]), greyed in either mode, whichever window the shot is of: a clipboard
/// history item shows the text it holds, and the clipboard is never read (#109, 04/10/2026).
#[allow(
    clippy::too_many_arguments,
    reason = "the windows handle_other_windows reads, passed in so tests can make them up"
)]
fn grey_other_windows(
    shot: &mut Shot,
    mode: CaptureMode,
    target: &Target,
    cover: Cover,
    windows: &[StackWindow],
    gone: Option<&[StackWindow]>,
    own: u32,
    panels: &[PxRect],
) -> usize {
    let in_shot = |areas: Vec<PxRect>| -> Vec<PxRect> {
        areas
            .into_iter()
            .filter_map(|area| area.intersect(&shot.rect))
            .collect()
    };
    let greyed = (mode == CaptureMode::Window).then_some(cover);
    shot.notifications = in_shot(notification_areas(windows, target, own, greyed));
    let mut areas = in_shot(panels.to_vec());
    if let Some(cover) = greyed {
        areas.extend(in_shot(covering_areas(windows, target, own, cover)));
        areas.extend(surrounding_areas(windows, target, shot.rect));
        // On top of what lay over it, never instead: the screenshot may still show those.
        if let Some(now) = gone {
            areas.extend(gone_window_areas(now, target, own, shot.rect));
        }
    }
    fill(shot, &areas, image::Rgba([208, 213, 221, 255]));
    areas.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::CaptureFacts;
    use crate::platform::window::ShownWindow;

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

    /// An ordinary opaque window of program `pid`.
    const fn window(pid: u32, frame: PxRect) -> StackWindow {
        StackWindow {
            pid,
            frame,
            see_through: false,
            click_through: false,
            notification: false,
        }
    }

    /// A click-through overlay (click-through and layered) of program `pid`.
    const fn overlay(pid: u32, frame: PxRect) -> StackWindow {
        StackWindow {
            see_through: true,
            click_through: true,
            ..window(pid, frame)
        }
    }

    /// A notification toast, shown by the shell's notification host (program 4).
    const fn toast(frame: PxRect) -> StackWindow {
        StackWindow {
            notification: true,
            ..window(4, frame)
        }
    }

    #[test]
    fn a_click_in_a_pop_up_shows_the_window_it_came_from_with_the_pop_up_on_top() {
        // Excel's right-click menu (194 × 563 px, P11 of the 10/10/2026 test) over its sheet,
        // running past the window's bottom edge: the area round both.
        let excel = rect(0, 0, 1600, 900);
        let menu = rect(700, 500, 894, 1063);
        let clicked = Target {
            pid: 3,
            frame: menu,
            owner: Some(Owner {
                pid: 3,
                frame: excel,
            }),
        };
        assert_eq!(clicked.area(), rect(0, 0, 1600, 1063));
        // A pop-up with no owner showing is its own area, as any window clicked in is.
        assert_eq!(Target::window(3, menu).area(), menu);
        assert_eq!(Target::window(3, excel).area(), excel);
    }

    #[test]
    fn the_area_stays_on_the_monitor_clicked_and_monitor_mode_is_unchanged() {
        let monitor = rect(0, 0, 1920, 1080);
        // An owner partly on the monitor to the left, its menu running below the screen.
        let area = rect(-200, 0, 1600, 1200);
        assert_eq!(
            capture_area(CaptureMode::Window, Some(area), monitor),
            rect(0, 0, 1600, 1080)
        );
        assert_eq!(
            capture_area(CaptureMode::Monitor, Some(area), monitor),
            monitor
        );
        assert_eq!(capture_area(CaptureMode::Window, None, monitor), monitor);
        // Nothing of it on this monitor: the whole monitor, as before.
        let elsewhere = rect(2000, 0, 2500, 500);
        assert_eq!(
            capture_area(CaptureMode::Window, Some(elsewhere), monitor),
            monitor
        );
    }

    #[test]
    fn other_programs_windows_over_a_pop_ups_owner_are_still_covered() {
        let excel = rect(0, 0, 1600, 900);
        let menu = rect(700, 500, 894, 1063);
        // A chat lying over the sheet, under the menu (menus are drawn on top of everything).
        let chat = rect(600, 0, 1000, 700);
        let behind = rect(0, 0, 1920, 1080);
        let windows = [
            window(3, menu),
            window(7, chat),
            window(3, excel),
            window(9, behind),
        ];
        let owned_by = |pid: u32| Target {
            pid,
            frame: menu,
            owner: Some(Owner {
                pid: 3,
                frame: excel,
            }),
        };
        // Greyed where it shows over the sheet: not under the menu, which is kept.
        let chat_less_menu = vec![
            rect(600, 0, 1000, 500),
            rect(600, 500, 700, 700),
            rect(894, 500, 1000, 700),
        ];
        assert_eq!(
            covering_areas(&windows, &owned_by(3), 1, Cover::Others),
            chat_less_menu
        );
        // A web view's menu, drawn by another program (5) for the app's window: still kept, and
        // the chat over the window still greyed.
        let web_view = [
            window(5, menu),
            window(7, chat),
            window(3, excel),
            window(9, behind),
        ];
        assert_eq!(
            covering_areas(&web_view, &owned_by(5), 1, Cover::Others),
            chat_less_menu
        );
        // Another program's window in front of them all, over the chat beside the menu: greyed
        // whole, so the same part of the screen is greyed, none of it the menu.
        let front = rect(620, 600, 680, 650);
        let mut in_front = vec![window(8, front)];
        in_front.extend(windows);
        let covered = covering_areas(&in_front, &owned_by(3), 1, Cover::Others);
        assert_eq!(covered.first(), Some(&front));
        assert_eq!(area(&covered), area(&chat_less_menu));
        assert!(covered.iter().all(|piece| piece.intersect(&menu).is_none()));
    }

    #[test]
    fn only_other_programs_windows_in_front_of_the_clicked_one_are_covered() {
        let app = rect(0, 0, 1000, 800);
        let chat = rect(700, 0, 1000, 800);
        let menu = rect(100, 100, 300, 400);
        let behind = rect(0, 0, 1920, 1080);
        // Front to back: our highlight, a chat app, the app's own menu, the app, something behind.
        let windows = [
            overlay(1, rect(500, 500, 520, 520)),
            window(7, chat),
            window(3, menu),
            window(3, app),
            window(9, behind),
        ];
        assert_eq!(
            covering_areas(&windows, &Target::window(3, app), 1, Cover::Others),
            vec![chat]
        );
        // Nothing of another program in front: nothing covered.
        assert!(
            covering_areas(&windows[2..], &Target::window(3, app), 1, Cover::Others).is_empty()
        );
    }

    #[test]
    fn a_click_through_overlay_in_front_covers_nothing() {
        let app = rect(0, 0, 1000, 800);
        let screen = rect(0, 0, 1920, 1080);
        // Another program's full-screen click-through overlay in front of everything, as a
        // screen-share border or a game overlay is.
        let windows = [overlay(5, screen), window(3, app)];
        assert!(covering_areas(&windows, &Target::window(3, app), 1, Cover::Others).is_empty());
        // An ordinary opaque window in front, behind the overlay, is still covered.
        let chat = rect(700, 0, 1000, 800);
        let windows = [overlay(5, screen), window(7, chat), window(3, app)];
        assert_eq!(
            covering_areas(&windows, &Target::window(3, app), 1, Cover::Others),
            vec![chat]
        );
        // A plain layered window (see-through but not click-through) is still another
        // program's window lying over the app.
        let layered = StackWindow {
            see_through: true,
            ..window(7, chat)
        };
        assert_eq!(
            covering_areas(
                &[layered, window(3, app)],
                &Target::window(3, app),
                1,
                Cover::Others
            ),
            vec![chat]
        );
    }

    #[test]
    fn a_notification_toast_over_the_clicked_window_is_covered() {
        let app = rect(0, 0, 1920, 1032);
        let message = rect(1540, 810, 1904, 1019);
        assert_eq!(
            covering_areas(
                &[toast(message), window(3, app)],
                &Target::window(3, app),
                1,
                Cover::Others
            ),
            vec![message]
        );
        // Even one drawn as a click-through overlay: a toast is never taken for one.
        let see_through = StackWindow {
            see_through: true,
            click_through: true,
            ..toast(message)
        };
        assert_eq!(
            covering_areas(
                &[see_through, window(3, app)],
                &Target::window(3, app),
                1,
                Cover::Others
            ),
            vec![message]
        );
    }

    #[test]
    fn over_the_shell_only_notification_toasts_are_covered() {
        // Clicked in the Start menu (program 20): Search's panel (program 21) is part of it, and
        // stays; a toast over it is greyed out.
        let start = rect(660, 300, 1260, 1032);
        let search = rect(660, 200, 1260, 300);
        let message = rect(1100, 810, 1464, 1019);
        let windows = [toast(message), window(21, search), window(20, start)];
        assert_eq!(
            covering_areas(
                &windows,
                &Target::window(20, start),
                1,
                Cover::NotificationsOnly
            ),
            vec![message]
        );
        // Without a toast, nothing of the shell is greyed out.
        assert!(
            covering_areas(
                &windows[1..],
                &Target::window(20, start),
                1,
                Cover::NotificationsOnly
            )
            .is_empty()
        );
    }

    #[test]
    fn a_notification_toast_in_view_is_noted_where_it_shows() {
        // Monitor mode: nothing is greyed out, and a toast over the app is noted.
        let screen = rect(0, 0, 1920, 1080);
        let app = rect(0, 0, 1920, 1032);
        let message = rect(1540, 810, 1904, 1019);
        let windows = [toast(message), window(3, app)];
        assert_eq!(
            notification_areas(&windows, &Target::window(3, app), 1, None),
            vec![message]
        );
        // Less what an opaque window in front of it covers.
        let front = rect(1700, 700, 1920, 1080);
        assert_eq!(
            notification_areas(
                &[window(8, front), toast(message), window(3, app)],
                &Target::window(3, app),
                1,
                None
            ),
            vec![rect(1540, 810, 1700, 1019)]
        );
        // The recorder's own windows never hide it: they're left out of screenshots.
        assert_eq!(
            notification_areas(
                &[window(1, screen), toast(message), window(3, app)],
                &Target::window(3, app),
                1,
                None
            ),
            vec![message]
        );
        // Nor does a click-through overlay.
        assert_eq!(
            notification_areas(
                &[overlay(5, screen), toast(message), window(3, app)],
                &Target::window(3, app),
                1,
                None
            ),
            vec![message]
        );
    }

    #[test]
    fn a_toast_greyed_out_is_not_noted() {
        let app = rect(0, 0, 1920, 1032);
        let message = rect(1540, 810, 1904, 1019);
        let windows = [toast(message), window(3, app)];
        // Window mode: a toast over the clicked window is greyed out, so it shows nothing.
        assert!(
            notification_areas(&windows, &Target::window(3, app), 1, Some(Cover::Others))
                .is_empty()
        );
        assert!(
            notification_areas(
                &windows,
                &Target::window(3, app),
                1,
                Some(Cover::NotificationsOnly)
            )
            .is_empty()
        );
    }

    #[test]
    fn a_click_on_a_toast_flags_every_toast_that_one_too() {
        // The shell draws every toast on screen in one window, sized to them all (build 26300,
        // 12/10/2026), so the toast clicked can't be told from the others in it: the window is
        // flagged whole, the toast clicked included, in either mode (#107).
        let app = rect(0, 0, 1920, 1032);
        let toasts = rect(1540, 600, 1904, 1019);
        let windows = [toast(toasts), window(3, app)];
        let in_toast = Target::window(4, toasts);
        assert_eq!(
            notification_areas(&windows, &in_toast, 1, None),
            vec![toasts]
        );
        assert_eq!(
            notification_areas(&windows, &in_toast, 1, Some(Cover::NotificationsOnly)),
            vec![toasts]
        );
        // Toasts in windows of their own are flagged each, the one clicked too.
        let clicked = rect(1540, 600, 1904, 800);
        let other = rect(1540, 810, 1904, 1019);
        let windows = [toast(clicked), toast(other), window(3, app)];
        assert_eq!(
            notification_areas(&windows, &Target::window(4, clicked), 1, None),
            vec![clicked, other]
        );
    }

    #[test]
    fn a_click_in_the_notification_centre_flags_it_and_the_toasts_over_it() {
        // The notification centre is one of the shell's notification windows too, and lists
        // message previews of its own. A toast over it is flagged as well, in either mode: the
        // centre is the shell's, so window mode greys nothing of its program over it (#107).
        let app = rect(0, 0, 1920, 1032);
        let centre = rect(1500, 60, 1910, 1020);
        let message = rect(1540, 810, 1904, 1019);
        let windows = [toast(message), toast(centre), window(3, app)];
        let in_centre = Target::window(4, centre);
        for greyed in [None, Some(Cover::NotificationsOnly)] {
            let flagged = notification_areas(&windows, &in_centre, 1, greyed);
            // The toast, then the rest of the centre round it: all of the centre, nothing twice.
            assert_eq!(flagged.first(), Some(&message));
            assert_eq!(area(&flagged), area(&[centre]));
            assert!(
                flagged
                    .iter()
                    .all(|piece| piece.intersect(&centre) == Some(*piece))
            );
        }
    }

    #[test]
    fn a_click_on_an_app_window_flags_every_toast() {
        let app = rect(0, 0, 1920, 1032);
        let first = rect(1540, 600, 1904, 800);
        let second = rect(1540, 810, 1904, 1019);
        let windows = [toast(first), toast(second), window(3, app)];
        assert_eq!(
            notification_areas(&windows, &Target::window(3, app), 1, None),
            vec![first, second]
        );
    }

    #[test]
    fn a_toast_in_many_pieces_is_noted_as_one_area_round_them() {
        // Cut up by many small windows in front of it: noted as one area round all of it, so a
        // step's facts stay small and nothing is left out.
        let message = rect(0, 0, 1000, 100);
        let app = rect(0, 0, 1920, 1032);
        let mut windows: Vec<StackWindow> = (0..60)
            .map(|index| window(8, rect(10 + 15 * index, 40, 15 + 15 * index, 60)))
            .collect();
        windows.push(toast(message));
        assert_eq!(
            notification_areas(&windows, &Target::window(3, app), 1, None),
            vec![message]
        );
    }

    #[test]
    fn a_closed_windows_area_showing_another_program_is_greyed() {
        // A dialog (program 3) closed by its OK as the button came up: its frame now shows an
        // email (program 7) that lay behind it, and the desktop beside that.
        let dialog = rect(400, 300, 1000, 700);
        let email = rect(0, 0, 800, 1000);
        let desktop = rect(0, 0, 1920, 1080);
        let windows = [window(7, email), window(10, desktop)];
        let greyed = gone_window_areas(&windows, &Target::window(3, dialog), 1, dialog);
        // All of it, in pieces that don't overlap.
        assert_eq!(area(&greyed), area(&[dialog]));
        assert!(
            greyed
                .iter()
                .all(|piece| piece.intersect(&dialog) == Some(*piece))
        );
        // Nothing showing there at all: still nothing of the program's, so all of it.
        assert_eq!(
            gone_window_areas(&[], &Target::window(3, dialog), 1, dialog),
            vec![dialog]
        );
    }

    /// Whether a point is in any of `pieces`.
    fn in_any(pieces: &[PxRect], x: i32, y: i32) -> bool {
        pieces.iter().any(|piece| piece.contains(x, y))
    }

    #[test]
    fn the_same_programs_window_behind_a_closed_dialog_stays() {
        // The dialog (program 3) closed with OK; its program's main window is behind it, with the
        // dialog's right edge running past the main window's, where an email (program 7) behind
        // shows. A chat (program 8) lies over the main window.
        let dialog = rect(400, 300, 1000, 700);
        let main = rect(200, 200, 900, 800);
        let chat = rect(800, 250, 950, 350);
        let email = rect(0, 0, 1920, 1080);
        let windows = [window(8, chat), window(3, main), window(7, email)];
        let greyed = gone_window_areas(&windows, &Target::window(3, dialog), 1, dialog);
        // The main window, where nothing else lies over it, stays.
        assert!(!in_any(&greyed, 500, 500));
        assert!(!in_any(&greyed, 850, 600));
        // The chat over it is greyed, and so is the email past its edge.
        assert!(in_any(&greyed, 850, 320));
        assert!(in_any(&greyed, 950, 500));
        // Only inside the screenshot, and nothing twice: the strip past the main window
        // (100 × 400) and the chat over the main window (100 × 50).
        assert!(
            greyed
                .iter()
                .all(|piece| piece.intersect(&dialog) == Some(*piece))
        );
        assert_eq!(area(&greyed), 100 * 400 + 100 * 50);
    }

    #[test]
    fn over_what_stays_of_a_closed_windows_program_overlays_and_toasts_are_as_decided() {
        let dialog = rect(400, 300, 1000, 700);
        let main = rect(0, 0, 1920, 1032);
        let target = Target::window(3, dialog);
        // A screen-share border (a click-through overlay) and the recorder's own window over the
        // main window cover nothing: nothing is greyed.
        let windows = [
            overlay(5, rect(0, 0, 1920, 1080)),
            window(1, rect(500, 320, 700, 360)),
            window(3, main),
        ];
        assert!(gone_window_areas(&windows, &target, 1, dialog).is_empty());
        // A notification toast over it is greyed, even drawn as a click-through overlay.
        let message = StackWindow {
            see_through: true,
            click_through: true,
            ..toast(rect(800, 600, 1100, 800))
        };
        assert_eq!(
            gone_window_areas(&[message, window(3, main)], &target, 1, dialog),
            vec![rect(800, 600, 1000, 700)]
        );
    }

    #[test]
    fn a_closed_pop_ups_window_stays_and_what_it_showed_past_it_is_greyed() {
        // A web view's menu (program 5) for the app's window (program 3) closed with the click on
        // its item: the window stays, and where the menu ran past it, the email behind is greyed.
        let excel = rect(0, 0, 1600, 900);
        let menu = rect(700, 500, 894, 1063);
        let clicked = Target {
            pid: 5,
            frame: menu,
            owner: Some(Owner {
                pid: 3,
                frame: excel,
            }),
        };
        let email = rect(0, 0, 1920, 1080);
        let shown = clicked.area().intersect(&email).unwrap();
        let greyed = gone_window_areas(&[window(3, excel), window(7, email)], &clicked, 1, shown);
        assert_eq!(greyed, vec![rect(0, 900, 1600, 1063)]);
    }

    fn white_shot(rect: PxRect) -> Shot {
        Shot {
            image: RgbaImage::from_pixel(
                u32::try_from(rect.width()).unwrap(),
                u32::try_from(rect.height()).unwrap(),
                image::Rgba([255, 255, 255, 255]),
            ),
            rect,
            monitor: rect,
            scale: 1.0,
            ms: 0.0,
            notifications: Vec::new(),
        }
    }

    fn shown(pid: u32, frame: PxRect, notification: bool) -> ShownWindow {
        ShownWindow {
            hwnd: 0,
            pid,
            frame: crate::platform::Rect {
                left: frame.left,
                top: frame.top,
                right: frame.right,
                bottom: frame.bottom,
            },
            see_through: false,
            click_through: false,
            notification,
            hosted_pid: None,
        }
    }

    #[test]
    fn a_toast_is_noted_in_monitor_mode_and_greyed_out_in_window_mode() {
        let screen = rect(0, 0, 200, 100);
        let app = rect(0, 0, 200, 80);
        let message = rect(150, 50, 200, 90);
        let stack = vec![shown(4, message, true), shown(3, app, false)];

        // The whole monitor: the toast is left as it is, and noted as a share of the picture.
        let mut shot = white_shot(screen);
        let greyed = handle_other_windows(
            &mut shot,
            CaptureMode::Monitor,
            &Target::window(3, app),
            Cover::Others,
            Some(stack.clone()),
            false,
        );
        assert_eq!(greyed, 0);
        assert_eq!(shot.notifications, vec![message]);
        assert_eq!(shot.image.get_pixel(160, 60).0, [255, 255, 255, 255]);
        let facts = serde_json::to_value(CaptureFacts::of(&shot, CaptureMode::Monitor)).unwrap();
        assert_eq!(
            facts["notifications"],
            serde_json::json!([{ "x": 75.0, "y": 50.0, "w": 25.0, "h": 40.0 }])
        );

        // The window clicked in: the toast over it is greyed out, and nothing is noted.
        let mut shot = white_shot(app);
        let greyed = handle_other_windows(
            &mut shot,
            CaptureMode::Window,
            &Target::window(3, app),
            Cover::Others,
            Some(stack),
            false,
        );
        assert_eq!(greyed, 1);
        assert!(shot.notifications.is_empty());
        assert_eq!(shot.image.get_pixel(160, 60).0, [208, 213, 221, 255]);
        let facts = serde_json::to_value(CaptureFacts::of(&shot, CaptureMode::Window)).unwrap();
        assert!(facts.get("notifications").is_none());
    }

    #[test]
    fn a_click_on_the_toasts_notes_them_on_the_monitor() {
        // As the button went down: the shell's one window holding the toasts, over the app, and
        // the click in it (#107).
        let screen = rect(0, 0, 200, 100);
        let app = rect(0, 0, 200, 80);
        let toasts = rect(150, 10, 200, 90);
        let stack = vec![shown(4, toasts, true), shown(3, app, false)];
        let mut shot = white_shot(screen);
        let greyed = handle_other_windows(
            &mut shot,
            CaptureMode::Monitor,
            &Target::window(4, toasts),
            Cover::NotificationsOnly,
            Some(stack),
            false,
        );
        assert_eq!(greyed, 0);
        assert_eq!(shot.notifications, vec![toasts]);
    }

    #[test]
    fn a_closed_window_is_greyed_in_window_mode_and_monitor_mode_is_unchanged() {
        // Clicked: a dialog (program 3) over an email (program 7), as the button went down. By the
        // screenshot the dialog had closed, so its frame shows the email.
        let screen = rect(0, 0, 200, 100);
        let dialog = rect(20, 20, 120, 80);
        let email = rect(0, 0, 200, 100);
        let pressed = [window(3, dialog), window(7, email)];
        let now = [window(7, email)];
        let white = [255, 255, 255, 255];
        let grey = [208, 213, 221, 255];

        // The window clicked in: nothing of the email shows.
        let mut shot = white_shot(dialog);
        let target = Target::window(3, dialog);
        let greyed = grey_other_windows(
            &mut shot,
            CaptureMode::Window,
            &target,
            Cover::Others,
            &pressed,
            Some(&now),
            1,
            &[],
        );
        assert!(greyed > 0);
        assert!(shot.image.pixels().all(|pixel| pixel.0 == grey));

        // Not gone: as before, nothing lay over the dialog, so nothing is greyed.
        let mut shot = white_shot(dialog);
        grey_other_windows(
            &mut shot,
            CaptureMode::Window,
            &target,
            Cover::Others,
            &pressed,
            None,
            1,
            &[],
        );
        assert!(shot.image.pixels().all(|pixel| pixel.0 == white));

        // The whole monitor is the whole monitor by design: nothing greyed, gone or not.
        let mut shot = white_shot(screen);
        let greyed = grey_other_windows(
            &mut shot,
            CaptureMode::Monitor,
            &target,
            Cover::Others,
            &pressed,
            Some(&now),
            1,
            &[],
        );
        assert_eq!(greyed, 0);
        assert!(shot.image.pixels().all(|pixel| pixel.0 == white));
    }

    #[test]
    fn windows_input_panel_is_greyed_in_window_and_monitor_mode() {
        // A clipboard history item clicked (#109): the panel (program 9) over Notepad (program
        // 4), shown on Notepad as a pop-up is on the window it came from.
        let screen = rect(0, 0, 200, 100);
        let notepad = rect(0, 0, 160, 100);
        let panel = rect(120, 20, 180, 80);
        let stack = [window(9, panel), window(4, notepad)];
        let clicked = Target {
            pid: 9,
            frame: panel,
            owner: Some(Owner {
                pid: 4,
                frame: notepad,
            }),
        };
        let white = [255, 255, 255, 255];
        let grey = [208, 213, 221, 255];
        let at = |shot: &Shot, x, y| shot.image.get_pixel(x, y).0;

        let mut shot = white_shot(clicked.area());
        let greyed = grey_other_windows(
            &mut shot,
            CaptureMode::Window,
            &clicked,
            Cover::Others,
            &stack,
            None,
            1,
            &[panel],
        );
        assert!(greyed > 0);
        // All of the panel, where it lies over Notepad and past it; Notepad as it was.
        assert_eq!(at(&shot, 130, 50), grey);
        assert_eq!(at(&shot, 170, 50), grey);
        assert_eq!(at(&shot, 60, 50), white);

        let mut shot = white_shot(screen);
        let greyed = grey_other_windows(
            &mut shot,
            CaptureMode::Monitor,
            &clicked,
            Cover::Others,
            &stack,
            None,
            1,
            &[panel],
        );
        assert_eq!(greyed, 1);
        assert_eq!(at(&shot, 130, 50), grey);
        assert_eq!(at(&shot, 60, 50), white);
        assert_eq!(at(&shot, 190, 50), white);

        // Over the shell's windows too (a click on Start while the panel shows), whose
        // screenshots grey out only toasts.
        let start = rect(0, 0, 200, 100);
        let mut shot = white_shot(start);
        grey_other_windows(
            &mut shot,
            CaptureMode::Window,
            &Target::window(5, start),
            Cover::NotificationsOnly,
            &[window(9, panel), window(5, start)],
            None,
            1,
            &[panel],
        );
        assert_eq!(at(&shot, 130, 50), grey);
        assert_eq!(at(&shot, 60, 50), white);
    }

    #[test]
    fn what_shows_round_a_pop_up_and_its_owner_is_greyed_out() {
        // A menu running past its window's bottom right: the area round the two has corners that
        // are neither, showing what lies behind them (here another program's window).
        let app = rect(0, 0, 100, 80);
        let menu = rect(60, 40, 120, 100);
        let behind = rect(0, 0, 200, 200);
        let clicked = Target {
            pid: 3,
            frame: menu,
            owner: Some(Owner { pid: 3, frame: app }),
        };
        let stack = vec![
            shown(3, menu, false),
            shown(3, app, false),
            shown(9, behind, false),
        ];
        let white = [255, 255, 255, 255];
        let grey = [208, 213, 221, 255];

        let mut shot = white_shot(clicked.area());
        let greyed = handle_other_windows(
            &mut shot,
            CaptureMode::Window,
            &clicked,
            Cover::Others,
            Some(stack.clone()),
            false,
        );
        let at = |shot: &Shot, x, y| shot.image.get_pixel(x, y).0;
        // Right of the window above the menu, and below the window left of the menu.
        assert_eq!(greyed, 2);
        assert_eq!(at(&shot, 110, 10), grey);
        assert_eq!(at(&shot, 10, 90), grey);
        // The window, the menu, and the menu where it lies over the window.
        assert_eq!(at(&shot, 10, 10), white);
        assert_eq!(at(&shot, 110, 90), white);
        assert_eq!(at(&shot, 70, 50), white);

        // The whole monitor is as it was: nothing greyed.
        let mut shot = white_shot(rect(0, 0, 200, 200));
        let greyed = handle_other_windows(
            &mut shot,
            CaptureMode::Monitor,
            &clicked,
            Cover::Others,
            Some(stack),
            false,
        );
        assert_eq!(greyed, 0);
        assert!(shot.image.pixels().all(|pixel| pixel.0 == white));
    }

    /// The check on a real desktop: start it, then make a notification appear within 30 seconds,
    /// over a window. Its screenshots are taken as a recording's are: the whole monitor notes the
    /// toast and leaves it, the window behind it gets it greyed out.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a notification toast on screen: cargo test -p capture a_live_toast -- --ignored --nocapture"]
    fn a_live_toast_is_noted_on_the_monitor_and_greyed_over_the_window() {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let toast = loop {
            if let Some(found) = crate::platform::window::shown_windows()
                .into_iter()
                .find(|window| window.notification)
            {
                break PxRect::from(found.frame);
            }
            assert!(
                std::time::Instant::now() < until,
                "no notification window showed in 30 seconds"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        // Let it finish sliding in.
        std::thread::sleep(std::time::Duration::from_millis(700));
        let (x, y) = (
            toast.left + toast.width() / 2,
            toast.top + toast.height() / 2,
        );
        // The window under the toast, as if clicked beside it.
        let behind = crate::platform::window::root_window_at(toast.left - 40, y)
            .expect("a window beside the toast");
        println!(
            "toast {toast:?}, window behind: {} {:?}",
            behind.title, behind.frame
        );
        let at = |shot: &Shot| {
            let pixel_x = u32::try_from(x - shot.rect.left).unwrap();
            let pixel_y = u32::try_from(y - shot.rect.top).unwrap();
            shot.image.get_pixel(pixel_x, pixel_y).0
        };

        let mut whole = capture(CaptureMode::Monitor, None, x, y, None).unwrap();
        handle_other_windows(
            &mut whole,
            CaptureMode::Monitor,
            &Target::window(behind.pid, PxRect::from(behind.frame)),
            Cover::Others,
            None,
            false,
        );
        println!("monitor: notifications {:?}", whole.notifications);
        assert!(whole.notifications.iter().any(|area| area.contains(x, y)));
        assert_ne!(at(&whole), [208, 213, 221, 255]);

        let frame = PxRect::from(behind.frame);
        let mut window = capture(CaptureMode::Window, Some(frame), x, y, None).unwrap();
        let greyed = handle_other_windows(
            &mut window,
            CaptureMode::Window,
            &Target::window(behind.pid, PxRect::from(behind.frame)),
            Cover::Others,
            None,
            false,
        );
        println!(
            "window: {greyed} areas greyed, notifications {:?}",
            window.notifications
        );
        assert!(window.notifications.is_empty());
        assert_eq!(at(&window), [208, 213, 221, 255]);
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

    /// Steps' own process, in the exclusion tests.
    const STEPS: u32 = 1;

    /// Stand-in programs for the exclusion tests: Notepad clicked in, Teams excluded, a web view
    /// drawing pop-ups for apps, the new Outlook (not excluded), a password manager (excluded);
    /// any other process can't be named.
    fn program(pid: u32) -> Option<String> {
        match pid {
            10 => Some("notepad.exe"),
            20 => Some("ms-teams.exe"),
            30 => Some("msedgewebview2.exe"),
            40 => Some("olk.exe"),
            50 => Some("KeePass.exe"),
            _ => None,
        }
        .map(str::to_string)
    }

    fn excluded() -> Vec<String> {
        vec!["ms-teams.exe".to_string(), "keepass.exe".to_string()]
    }

    /// A showing window `hwnd` of program `pid`.
    fn shown_as(hwnd: isize, pid: u32, frame: PxRect) -> ShownWindow {
        ShownWindow {
            hwnd,
            ..shown(pid, frame, false)
        }
    }

    /// The owners of the stand-in windows: 3 is Teams' menu, 4 the new Outlook's, 5 is a pop-up
    /// of a window whose program can't be named, 6 is one of Steps' own.
    fn owners(hwnd: isize) -> Vec<u32> {
        match hwnd {
            3 => vec![20],
            4 => vec![40],
            5 => vec![99],
            6 => vec![STEPS],
            _ => Vec::new(),
        }
    }

    #[test]
    fn a_pop_up_an_excluded_app_owns_is_blacked_out_whoever_draws_it() {
        let picture = rect(0, 0, 1000, 1000);
        let teams_menu = rect(100, 100, 300, 400);
        let windows = [
            // Teams' menu, drawn by the web view, over Notepad clicked in.
            shown_as(3, 30, teams_menu),
            shown_as(1, 10, rect(0, 0, 800, 600)),
        ];
        let layers = exclusion_layers(&windows, picture, STEPS, &excluded(), program, owners);
        assert_eq!(
            layers.iter().map(|layer| layer.hidden).collect::<Vec<_>>(),
            [true, false]
        );
        assert_eq!(hidden_areas(&layers), vec![teams_menu]);
    }

    #[test]
    fn a_pop_up_of_an_app_not_excluded_is_unchanged_and_still_covers() {
        let picture = rect(0, 0, 1000, 1000);
        let outlook_menu = rect(700, 100, 900, 400);
        let keepass = rect(600, 0, 1000, 600);
        let windows = [
            shown_as(4, 30, outlook_menu),
            shown_as(1, 10, rect(0, 0, 800, 600)),
            // KeePass behind Notepad's right edge and the menu.
            shown_as(2, 50, keepass),
        ];
        let layers = exclusion_layers(&windows, picture, STEPS, &excluded(), program, owners);
        assert_eq!(layers[0], layer(outlook_menu, false, false));
        assert_eq!(layers[2], layer(keepass, true, false));
        // Only what shows of KeePass past Notepad and the menu, as before.
        let hidden = hidden_areas(&layers);
        assert_eq!(area(&hidden), 200 * 600 - 100 * 300);
        assert!(
            hidden
                .iter()
                .all(|piece| piece.intersect(&outlook_menu).is_none() && piece.left >= 800)
        );
    }

    #[test]
    fn an_owner_that_cant_be_named_counts_as_excluded_while_anything_is() {
        let picture = rect(0, 0, 1000, 1000);
        let windows = [shown_as(5, 30, rect(0, 0, 100, 100))];
        let layers = exclusion_layers(&windows, picture, STEPS, &excluded(), program, owners);
        assert!(layers[0].hidden);
        // Nothing excluded: nothing is.
        let layers = exclusion_layers(&windows, picture, STEPS, &[], program, owners);
        assert!(!layers[0].hidden);
    }

    #[test]
    fn steps_own_windows_are_never_hidden_or_covering_and_never_make_a_pop_up_excluded() {
        let picture = rect(0, 0, 1000, 1000);
        let windows = [
            // A window of Steps' that Teams owns, and a web view's pop-up Steps' window owns
            // (Steps' own process isn't named in these stand-ins, so it would count otherwise).
            shown_as(3, STEPS, rect(0, 0, 100, 100)),
            shown_as(6, 30, rect(200, 0, 300, 100)),
        ];
        let layers = exclusion_layers(&windows, picture, STEPS, &excluded(), program, owners);
        assert_eq!(layers[0], layer(rect(0, 0, 100, 100), false, true));
        assert!(!layers[1].hidden);
    }

    #[test]
    fn owners_are_read_only_for_windows_in_the_picture_and_each_process_named_once() {
        let picture = rect(0, 0, 500, 500);
        let windows = [
            shown_as(3, 30, rect(100, 100, 300, 400)),
            // Out of the picture: not asked about.
            shown_as(4, 30, rect(600, 0, 800, 200)),
            // KeePass's own window: excluded by its program, its owners not needed.
            shown_as(7, 50, rect(0, 0, 50, 50)),
            shown_as(8, 30, rect(300, 300, 400, 400)),
        ];
        let mut asked_owners = Vec::new();
        let mut named = Vec::new();
        let layers = exclusion_layers(
            &windows,
            picture,
            STEPS,
            &excluded(),
            |pid| {
                named.push(pid);
                program(pid)
            },
            |hwnd| {
                asked_owners.push(hwnd);
                owners(hwnd)
            },
        );
        assert_eq!(
            layers.iter().map(|layer| layer.hidden).collect::<Vec<_>>(),
            [true, false, true, false]
        );
        assert_eq!(asked_owners, [3, 8]);
        // The web view is named once though it draws two windows; the new Outlook, owning only
        // the window out of the picture, never.
        assert_eq!(named, [30, 20, 50]);
    }

    #[test]
    fn blacking_out_paints_only_the_area_inside_the_shot() {
        let mut shot = Shot {
            image: RgbaImage::from_pixel(10, 10, image::Rgba([255, 255, 255, 255])),
            rect: rect(100, 100, 110, 110),
            monitor: rect(0, 0, 1920, 1080),
            scale: 1.0,
            ms: 0.0,
            notifications: Vec::new(),
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
