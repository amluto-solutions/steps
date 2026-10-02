//! Phase 1 test driver: moves the real mouse, so keep hands off it while it runs.
//!
//! ```text
//! drive fixture --title "Amluto Steps parity fixture" --out DIR [--delay-ms 700]
//! drive burst [--title T] [--count 50] [--interval-ms 20]   (clicks the fixture's Finish button)
//! drive close [--title T]      (closes only the fixture window, through UI Automation)
//! drive place --title T --x X --y Y [--w W --h H]   (moves the fixture window, physical pixels)
//! drive tap [--title T] [--ids "a|b"]   (taps fixture elements with a synthetic finger)
//! drive probe --title T --out DIR   (what a normal process sees of a window: elevation, shot, UIA)
//! drive app --title T --names "One|Plus|Two" [--delay-ms 600]   (desktop apps, by accessible name)
//! drive name-at --title T --names "Edit|View"   (what Steps' lookup names at each control's centre; no clicks)
//! ```
//!
//! `fixture` reads the test plan the fixture page publishes in its `amluto-plan` text area (the
//! steps to perform). It writes the plan to `DIR/expected.json`, then clicks and types each step
//! through `SendInput`.

use std::path::PathBuf;
use std::time::Duration;

use capture_win32::display::{cursor_pos, enable_per_monitor_dpi_awareness};
use capture_win32::inject::{left_click_at, press, type_keys, type_text};
use serde::Deserialize;
use uiautomation::patterns::{
    UIScrollItemPattern, UITransformPattern, UIValuePattern, UIWindowPattern,
};
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

#[derive(Deserialize)]
struct Plan {
    steps: Vec<PlanStep>,
}

#[derive(Deserialize)]
struct PlanStep {
    target: String,
    action: String,
    text: Option<String>,
    /// Visible text, for elements Chrome exposes without an automation id (plain paragraphs).
    name: Option<String>,
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn find_window(automation: &UIAutomation, title: &str) -> Result<UIElement, String> {
    let root = automation.get_root_element().map_err(|e| e.to_string())?;
    let condition = automation
        .create_true_condition()
        .map_err(|e| e.to_string())?;
    let windows = root
        .find_all(TreeScope::Children, &condition)
        .map_err(|e| e.to_string())?;
    // An exact title first: "Settings" is part of other windows' titles too.
    let exact = windows
        .iter()
        .find(|window| window.get_name().is_ok_and(|name| name == title))
        .cloned();
    exact
        .or_else(|| {
            windows
                .into_iter()
                .find(|window| window.get_name().is_ok_and(|name| name.contains(title)))
        })
        .ok_or_else(|| {
            format!(
                "no window titled like \"{title}\" (open tools/parity/fixture.html in Edge first)"
            )
        })
}

/// Waits up to 10 s for the fixture window and one of its elements (a fresh window and Chrome's
/// accessibility tree take a moment to be ready).
fn wait_for(
    automation: &UIAutomation,
    title: &str,
    id: &str,
) -> Result<(UIElement, UIElement), String> {
    let mut last_error = String::new();
    for _ in 0..20 {
        match find_window(automation, title).and_then(|window| {
            let element = find_by_id(automation, &window, id)?;
            Ok((window, element))
        }) {
            Ok(found) => return Ok(found),
            Err(error) => last_error = error,
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(last_error)
}

fn find_by_id(
    automation: &UIAutomation,
    window: &UIElement,
    id: &str,
) -> Result<UIElement, String> {
    let condition = automation
        .create_property_condition(UIProperty::AutomationId, Variant::from(id), None)
        .map_err(|e| e.to_string())?;
    window
        .find_first(TreeScope::Descendants, &condition)
        .map_err(|_| format!("element #{id} not found"))
}

fn find_by_name(
    automation: &UIAutomation,
    window: &UIElement,
    name: &str,
) -> Result<UIElement, String> {
    let condition = automation
        .create_property_condition(UIProperty::Name, Variant::from(name), None)
        .map_err(|e| e.to_string())?;
    window
        .find_first(TreeScope::Descendants, &condition)
        .map_err(|_| format!("element named \"{name}\" not found"))
}

fn locate(
    automation: &UIAutomation,
    window: &UIElement,
    step: &PlanStep,
) -> Result<UIElement, String> {
    find_by_id(automation, window, &step.target).or_else(|error| match &step.name {
        Some(name) if !name.is_empty() => find_by_name(automation, window, name),
        _ => Err(error),
    })
}

fn centre(element: &UIElement) -> Result<(i32, i32), String> {
    if let Ok(pattern) = element.get_pattern::<UIScrollItemPattern>() {
        let _ = pattern.scroll_into_view();
        std::thread::sleep(Duration::from_millis(150));
    }
    let rect = element
        .get_bounding_rectangle()
        .map_err(|e| e.to_string())?;
    Ok((
        rect.get_left() + rect.get_width() / 2,
        rect.get_top() + rect.get_height() / 2,
    ))
}

fn fixture(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").unwrap_or_else(|| "Amluto Steps parity fixture".into());
    let out = PathBuf::from(arg(args, "--out").ok_or("--out is required")?);
    let delay = Duration::from_millis(
        arg(args, "--delay-ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(700),
    );

    let automation = UIAutomation::new().map_err(|e| e.to_string())?;

    // A freshly opened window (and Chrome's accessibility tree) takes a moment to be ready.
    let mut attempt = 0;
    let (window, plan_json) = loop {
        let ready = find_window(&automation, &title).and_then(|window| {
            let plan = find_by_id(&automation, &window, "amluto-plan")?
                .get_pattern::<UIValuePattern>()
                .and_then(|pattern| pattern.get_value())
                .map_err(|e| format!("could not read the plan: {e}"))?;
            if plan.is_empty() {
                return Err("the plan is empty".into());
            }
            Ok((window, plan))
        });
        match ready {
            Ok(found) => break found,
            Err(error) if attempt >= 20 => return Err(error),
            Err(_) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    };
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(400));
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    std::fs::write(out.join("expected.json"), &plan_json).map_err(|e| e.to_string())?;
    let plan: Plan = serde_json::from_str(&plan_json).map_err(|e| format!("bad plan: {e}"))?;

    println!(
        "Driving {} steps. Keep hands off the mouse.",
        plan.steps.len()
    );
    // Where each step was clicked, so the report pairs recordings by position, not by order
    // (Windows may add its own click when focusing the window).
    let mut driven = Vec::new();
    for (index, step) in plan.steps.iter().enumerate() {
        let element = locate(&automation, &window, step)?;
        let (x, y) = centre(&element)?;
        left_click_at(x, y).map_err(|e| e.to_string())?;
        driven.push(serde_json::json!({ "target": step.target, "x": x, "y": y }));
        let _ = std::fs::write(
            out.join("driven.json"),
            serde_json::Value::Array(driven.clone()).to_string(),
        );
        std::thread::sleep(Duration::from_millis(150));
        // Safety: stop if the person has taken the mouse back.
        if cursor_pos() != Some((x, y)) {
            return Err("the mouse moved: stopping so you can have it back".into());
        }
        if step.action == "type"
            && let Some(text) = &step.text
        {
            // Safety: only ever type into the fixture field we just clicked, never another app.
            let mut focused = false;
            for _ in 0..10 {
                if element.has_keyboard_focus().unwrap_or(false) {
                    focused = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if !focused {
                return Err(format!(
                    "#{} does not have keyboard focus: not typing",
                    step.target
                ));
            }
            type_text(text);
        }
        println!("  {:>2}. {} #{}", index + 1, step.action, step.target);
        std::thread::sleep(delay);
    }
    Ok(())
}

/// Clicks named elements in a desktop app window, e.g. Calculator buttons or Excel ribbon tabs.
/// The same safety checks as `fixture`: the target window must be under the cursor and the mouse
/// must not have moved.
fn app(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").ok_or("--title is required")?;
    let names: Vec<String> = arg(args, "--names")
        .ok_or("--names is required")?
        .split('|')
        .map(str::to_string)
        .collect();
    let delay = Duration::from_millis(
        arg(args, "--delay-ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(600),
    );

    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let mut window = None;
    for _ in 0..30 {
        if let Ok(found) = find_window(&automation, &title) {
            window = Some(found);
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let window = window.ok_or_else(|| format!("no window titled like \"{title}\""))?;
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(600));

    for (index, name) in names.iter().enumerate() {
        let element = find_by_name(&automation, &window, name)?;
        let (x, y) = centre(&element)?;
        let under = capture_win32::window::root_window_at(x, y);
        if !under.as_ref().is_some_and(|w| w.title.contains(&title)) {
            return Err(format!(
                "\"{name}\" is covered by another window ({}): not clicking",
                under.map(|w| w.title).unwrap_or_default()
            ));
        }
        left_click_at(x, y).map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(150));
        if cursor_pos() != Some((x, y)) {
            return Err("the mouse moved: stopping so you can have it back".into());
        }
        println!("  {:>2}. {title} → \"{name}\"", index + 1);
        std::thread::sleep(delay);
    }
    Ok(())
}

fn close(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").unwrap_or_else(|| "Amluto Steps parity fixture".into());
    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    match find_window(&automation, &title) {
        Ok(window) => window
            .get_pattern::<UIWindowPattern>()
            .and_then(|pattern| pattern.close())
            .map_err(|e| format!("could not close the fixture window: {e}")),
        Err(_) => Ok(()), // nothing to close
    }
}

/// Moves (and optionally resizes) the fixture window, so a run can target a chosen monitor. Edge
/// app windows reopen where they last were, ignoring `--window-position`. The resize comes after
/// the move because a window crossing onto a monitor with another scale resizes itself.
fn place(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").unwrap_or_else(|| "Amluto Steps parity fixture".into());
    let number = |flag: &str| arg(args, flag).and_then(|v| v.parse::<f64>().ok());
    let (Some(x), Some(y)) = (number("--x"), number("--y")) else {
        return Err("place needs --x and --y".into());
    };
    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let (window, _) = wait_for(&automation, &title, "done")?;
    let transform = window
        .get_pattern::<UITransformPattern>()
        .map_err(|e| format!("the fixture window can't be moved: {e}"))?;
    transform.move_to(x, y).map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(600));
    if let (Some(w), Some(h)) = (number("--w"), number("--h")) {
        transform.resize(w, h).map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(600));
    }
    Ok(())
}

/// Taps fixture elements with a synthetic finger, to see which input source notices touch.
/// Before every tap it checks the fixture is the window under that point.
fn tap(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").unwrap_or_else(|| "Amluto Steps parity fixture".into());
    let ids = arg(args, "--ids").unwrap_or_else(|| "btn-save|btn-settings|link-pricing".into());
    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let (window, _) = wait_for(&automation, &title, "done")?;
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(500));
    for id in ids.split('|') {
        let (x, y) = centre(&find_by_id(&automation, &window, id)?)?;
        if !capture_win32::window::root_window_at(x, y).is_some_and(|w| w.title.contains(&title)) {
            return Err(format!("the fixture isn't in front at #{id}: stopping"));
        }
        capture_win32::inject::tap_at(x, y).map_err(|e| e.to_string())?;
        println!("  tapped #{id} at ({x}, {y})");
        std::thread::sleep(Duration::from_millis(900));
    }
    Ok(())
}

/// Reports what this (normal) process can learn about a window without clicking it: its
/// elevation, a window screenshot, and UIA lookups at a few points. For the elevated-window test,
/// where clicks can't be injected (Windows blocks input from a lower integrity level).
fn probe(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").ok_or("probe needs --title")?;
    let out = PathBuf::from(arg(args, "--out").ok_or("probe needs --out")?);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let number = |flag: &str| arg(args, flag).and_then(|v| v.parse::<i32>().ok());
    // `--x --y --w --h` give the window's rectangle directly, for windows UIA doesn't list.
    let (left, top, width, height) = if let (Some(x), Some(y), Some(w), Some(h)) =
        (number("--x"), number("--y"), number("--w"), number("--h"))
    {
        (x, y, w, h)
    } else {
        let automation = UIAutomation::new().map_err(|e| e.to_string())?;
        let rect = find_window(&automation, &title)?
            .get_bounding_rectangle()
            .map_err(|e| e.to_string())?;
        (
            rect.get_left(),
            rect.get_top(),
            rect.get_width(),
            rect.get_height(),
        )
    };
    let info = capture_win32::window::root_window_at(left + width / 2, top + height / 2)
        .ok_or("no window under the probe point")?;
    println!(
        "window: '{}' exe={:?} elevation={:?}",
        info.title,
        info.exe_name(),
        info.elevation
    );

    let shot = capture::screenshot::capture(
        capture::screenshot::CaptureMode::Window,
        Some(capture::pipeline::frame_of(&info)),
        left + width / 2,
        top + height / 2,
        None,
    )?;
    let lit = shot
        .image
        .pixels()
        .filter(|p| p.0[..3].iter().any(|&c| c > 16))
        .count();
    let path = out.join("probe.png");
    shot.image.save(&path).map_err(|e| e.to_string())?;
    println!(
        "screenshot: {}x{} in {:.1} ms, {:.0}% non-black → {}",
        shot.image.width(),
        shot.image.height(),
        shot.ms,
        f64::from(u32::try_from(lit).unwrap_or(u32::MAX)) * 100.0
            / f64::from(shot.image.width() * shot.image.height()).max(1.0),
        path.display()
    );

    let client = capture::uia::UiaClient::start(None)?;
    let points = [
        (0.5, 0.5),
        (0.08, 0.25),
        (0.08, 0.45),
        (0.5, 0.03),
        (0.3, 0.2),
    ];
    for (id, (fx, fy)) in (1_u64..).zip(points) {
        #[allow(clippy::cast_possible_truncation, reason = "screen coordinates")]
        let (x, y) = (
            left + (f64::from(width) * fx) as i32,
            top + (f64::from(height) * fy) as i32,
        );
        let started = std::time::Instant::now();
        let hwnd = capture::platform::window::root_window_at(x, y).map_or(0, |window| window.hwnd);
        client.request(id, x, y, hwnd);
        let lookup = client.wait(id, started, started + Duration::from_millis(1500));
        match lookup {
            capture::uia::Lookup::Found { facts, ms, .. } => println!(
                "uia ({x},{y}): {ms:.1} ms {}",
                serde_json::to_string(&facts).unwrap_or_default()
            ),
            other => println!("uia ({x},{y}): {other:?}"),
        }
    }
    Ok(())
}

/// Clicks the fixture's "Finish" button many times, fast. Before every click it checks the
/// fixture is the window under that point and that nobody has moved the mouse.
fn burst(args: &[String]) -> Result<(), String> {
    let title = arg(args, "--title").unwrap_or_else(|| "Amluto Steps parity fixture".into());
    let count: u32 = arg(args, "--count")
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);
    let interval = Duration::from_millis(
        arg(args, "--interval-ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(20),
    );

    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let (window, done) = wait_for(&automation, &title, "done")?;
    let _ = window.set_focus();
    std::thread::sleep(Duration::from_millis(500));
    let (x, y) = centre(&done)?;

    let is_fixture_at = |x: i32, y: i32| {
        capture_win32::window::root_window_at(x, y).is_some_and(|w| w.title.contains(&title))
    };
    if !is_fixture_at(x, y) {
        return Err("the fixture isn't the front window at the target: not clicking".into());
    }
    println!("Bursting {count} clicks at ({x}, {y}). Keep hands off the mouse.");
    for index in 0..count {
        if index > 0 && cursor_pos() != Some((x, y)) {
            return Err(format!("the mouse moved after {index} clicks: stopping"));
        }
        if !is_fixture_at(x, y) {
            return Err(format!(
                "another window covered the fixture after {index} clicks: stopping"
            ));
        }
        left_click_at(x, y).map_err(|e| e.to_string())?;
        std::thread::sleep(interval);
    }
    Ok(())
}

/// For each named control in a window, what Steps' own lookup finds at its centre, without
/// clicking: checks that the element named is the one under the pointer (F015, F016, F070).
fn name_at(args: &[String]) -> Result<(), String> {
    // `--points "x,y|x,y"`: physical points, for windows whose controls a name search can't reach.
    if let Some(points) = arg(args, "--points") {
        let client = capture::uia::UiaClient::start(None)?;
        for (id, point) in (1_u64..).zip(points.split('|')) {
            let mut parts = point
                .split(',')
                .filter_map(|part| part.trim().parse::<i32>().ok());
            let (Some(x), Some(y)) = (parts.next(), parts.next()) else {
                continue;
            };
            let hwnd =
                capture::platform::window::root_window_at(x, y).map_or(0, |window| window.hwnd);
            let started = std::time::Instant::now();
            client.request(id, x, y, hwnd);
            match client.wait(id, started, started + Duration::from_millis(2000)) {
                capture::uia::Lookup::Found { facts, .. } => println!(
                    "({x},{y}): {} \"{}\" (class {}, parent {:?})",
                    facts.control_type,
                    facts.name,
                    facts.class_name,
                    facts.parent.as_ref().map(|parent| parent.name.clone())
                ),
                other => println!("({x},{y}): {other:?}"),
            }
        }
        return Ok(());
    }
    let title = arg(args, "--title").ok_or("name-at needs --title")?;
    let names = arg(args, "--names").ok_or("name-at needs --names")?;
    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let window = find_window(&automation, &title)?;
    let client = capture::uia::UiaClient::start(None)?;
    for (id, name) in (1_u64..).zip(names.split('|')) {
        let element = match find_by_name(&automation, &window, name) {
            Ok(element) => element,
            Err(error) => {
                println!("{name}: {error}");
                continue;
            }
        };
        let (x, y) = centre(&element)?;
        let hwnd = capture::platform::window::root_window_at(x, y).map_or(0, |window| window.hwnd);
        let started = std::time::Instant::now();
        client.request(id, x, y, hwnd);
        match client.wait(id, started, started + Duration::from_millis(2000)) {
            capture::uia::Lookup::Found { facts, .. } => println!(
                "{name}: found {} \"{}\" (class {}, parent {:?})",
                facts.control_type,
                facts.name,
                facts.class_name,
                facts.parent.as_ref().map(|parent| parent.name.clone())
            ),
            other => println!("{name}: {other:?}"),
        }
    }
    Ok(())
}

pub fn main() {
    let _ = enable_per_monitor_dpi_awareness();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("fixture") => fixture(&args),
        Some("burst") => burst(&args),
        Some("close") => close(&args),
        Some("app") => app(&args),
        Some("place") => place(&args),
        Some("probe") => probe(&args),
        Some("name-at") => name_at(&args),
        // `click --at "x,y|x,y" [--delay-ms N]`, and `type --text T`: plain input, for windows
        // whose controls UI Automation can't find by name (a web view before its tree is built).
        Some("click") => {
            let delay = arg(&args, "--delay-ms").and_then(|v| v.parse().ok()).unwrap_or(700);
            let points = arg(&args, "--at").unwrap_or_default();
            let mut result = Ok(());
            for point in points.split('|') {
                let mut parts = point.split(',').filter_map(|part| part.trim().parse::<i32>().ok());
                if let (Some(x), Some(y)) = (parts.next(), parts.next()) {
                    if let Err(error) = left_click_at(x, y) {
                        result = Err(error.to_string());
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(delay));
                }
            }
            result
        }
        // `type --text T [--keys]`: `--keys` types with virtual keys, as a keyboard does, which
        // the recorder reads; without it, Unicode packets, which it doesn't.
        Some("type") => {
            let text = arg(&args, "--text").unwrap_or_default();
            if args.iter().any(|a| a == "--keys") {
                type_keys(&text);
            } else {
                type_text(&text);
            }
            Ok(())
        }
        // `press --keys "ctrl+v|enter"`: combinations, one after another.
        Some("press") => arg(&args, "--keys")
            .unwrap_or_default()
            .split('|')
            .try_for_each(|combo| {
                press(combo)?;
                std::thread::sleep(Duration::from_millis(300));
                Ok(())
            }),
        // `screens`: each screen's bounds, whether it's the main one, and its monitor's name.
        Some("screens") => {
            for screen in capture_win32::display::screens() {
                println!("{:?} primary={} name={:?}", screen.rect, screen.primary, screen.name);
            }
            Ok(())
        }
        // `terminal-text --title T`: what the recorder reads from a Windows Terminal window.
        Some("terminal-text") => {
            let automation = UIAutomation::new().map_err(|e| e.to_string());
            automation.and_then(|automation| {
                let window = find_window(&automation, &arg(&args, "--title").unwrap_or_default())?;
                let hwnd: isize = window
                    .get_native_window_handle()
                    .map_err(|e| e.to_string())?
                    .into();
                let text = capture::screen_text::ScreenText::new()
                    .ok_or("UI Automation didn't start")?
                    .terminal(hwnd, capture::screen_text::TerminalKind::WindowsTerminal);
                println!("hwnd {hwnd}: {text:?}");
                Ok(())
            })
        }
        Some("raw-at") => {
            let automation = UIAutomation::new().map_err(|e| e.to_string());
            automation.and_then(|automation| {
                let x: i32 = arg(&args, "--x").and_then(|v| v.parse().ok()).unwrap_or(0);
                let y: i32 = arg(&args, "--y").and_then(|v| v.parse().ok()).unwrap_or(0);
                match automation.element_from_point(uiautomation::types::Point::new(x, y)) {
                    Ok(element) => {
                        println!(
                            "plain: name={:?} type={:?} class={:?}",
                            element.get_name(),
                            element.get_control_type(),
                            element.get_classname()
                        );
                        Ok(())
                    }
                    Err(error) => Err(format!("plain failed: {error}")),
                }
            })
        }
        Some("tap") => tap(&args),
        _ => Err("usage: drive fixture --out DIR [--title T] [--delay-ms N] | drive burst [--count N] | drive close".into()),
    };
    if let Err(error) = result {
        eprintln!("drive: {error}");
        std::process::exit(1);
    }
}
