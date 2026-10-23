//! A browser's address bar, read for "Go to" steps (docs/spec/02-capture.md#events): found once
//! per window (Chromium's own edit, the combo box in Chrome 155's toolbar, Firefox's) and read
//! for its site and whether it has the keyboard, on a thread of its own so a slow search never
//! delays a click's lookup; and told as the focused element, so typing there is never a typing
//! step. One reason to change: how a browser's address bar is found or read.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use uiautomation::types::{ControlType, Handle, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use crate::facts::ElementFacts;
use crate::lookup::origin_from_address;
use crate::navigation::BarRead;

use super::{OriginReply, OriginRequest, read_value};

/// How long a window without an address bar (an installed web app) is left before it is searched
/// again: the search walks the whole page tree.
const NO_OMNIBOX_RETRY: Duration = Duration::from_secs(30);

/// What the origin thread knows about a browser window's address bar.
enum Omnibox {
    Found(UIElement),
    Missing(Instant),
}

pub(super) fn origin_worker(requests: &Receiver<OriginRequest>, replies: &Sender<OriginReply>) {
    let automation = UIAutomation::new().ok();
    let mut known: HashMap<isize, Omnibox> = HashMap::new();
    while let Ok(OriginRequest::Read { id, hwnd }) = requests.recv() {
        let read = automation
            .as_ref()
            .and_then(|automation| {
                // A panic inside UI Automation loses this reading, not the thread.
                catch_unwind(AssertUnwindSafe(|| {
                    cached_origin(automation, &mut known, hwnd)
                }))
                .ok()
            })
            .unwrap_or_default();
        let _ = replies.send(OriginReply { id, read });
    }
}

/// The address bar's origin, reusing the element found last time for this window. A stale
/// element (the window closed or rebuilt its toolbar) is searched for again.
fn cached_origin(
    automation: &UIAutomation,
    known: &mut HashMap<isize, Omnibox>,
    hwnd: isize,
) -> BarRead {
    match known.get(&hwnd) {
        Some(Omnibox::Found(element)) => {
            let read = omnibox_read(element);
            if read != BarRead::default() || element.get_bounding_rectangle().is_ok() {
                // Still there, even when the address isn't a web page (a new tab).
                return read;
            }
        }
        Some(Omnibox::Missing(since)) if since.elapsed() < NO_OMNIBOX_RETRY => {
            return BarRead::default();
        }
        _ => {}
    }
    if known.len() > 64 {
        known.clear();
    }
    if let Some(element) = find_omnibox(automation, hwnd) {
        let read = omnibox_read(&element);
        known.insert(hwnd, Omnibox::Found(element));
        read
    } else {
        known.insert(hwnd, Omnibox::Missing(Instant::now()));
        BarRead::default()
    }
}

/// Chromium's native address bar: an edit with this class. Its automation id is a generated
/// `view_NNNN` value (`view_1021` in Edge), not its localized accessible name.
const NATIVE_OMNIBOX: &str = "OmniboxViewViews";

/// Chrome 155 draws the toolbar as a web page of its own inside this native view, and the address
/// bar there is a combo box. Web pages can't make native views, so only Chrome's own toolbar has
/// this class.
const WEB_UI_TOOLBAR: &str = "WebUIToolbarWebView";

/// Firefox's address bar: a combo box with this id in its own toolbar (checked in Firefox 143,
/// 04/10/2026). A web page could give an element the same id, but a page's elements are always
/// inside its document, which the browser's own toolbar isn't.
const FIREFOX_URLBAR: &str = "urlbar-input";

fn find_omnibox(automation: &UIAutomation, hwnd: isize) -> Option<UIElement> {
    let window = automation.element_from_handle(Handle::from(hwnd)).ok()?;
    let window_bounds = window.get_bounding_rectangle().ok()?;
    let class = |name: &str| {
        automation.create_property_condition(UIProperty::ClassName, Variant::from(name), None)
    };
    // One walk of the window's tree finds whichever toolbar this browser has.
    let firefox = automation
        .create_property_condition(
            UIProperty::AutomationId,
            Variant::from(FIREFOX_URLBAR),
            None,
        )
        .ok()?;
    let condition = automation
        .create_or_condition(
            automation
                .create_or_condition(class(NATIVE_OMNIBOX).ok()?, class(WEB_UI_TOOLBAR).ok()?)
                .ok()?,
            firefox,
        )
        .ok()?;
    let found = window.find_first(TreeScope::Descendants, &condition).ok()?;
    let element = if found.get_automation_id().ok().as_deref() == Some(FIREFOX_URLBAR) {
        if !matches!(
            found.get_control_type().ok()?,
            ControlType::ComboBox | ControlType::Edit
        ) || inside_document(automation, &found)
        {
            return None;
        }
        found
    } else if found.get_classname().ok()? == WEB_UI_TOOLBAR {
        let combo = automation
            .create_property_condition(
                UIProperty::ControlType,
                Variant::from(ControlType::ComboBox as i32),
                None,
            )
            .ok()?;
        found.find_first(TreeScope::Descendants, &combo).ok()?
    } else if found.get_control_type().ok()? == ControlType::Edit {
        found
    } else {
        return None;
    };
    let bounds = element.get_bounding_rectangle().ok()?;
    let window_width = window_bounds.get_right() - window_bounds.get_left();
    let address_width = bounds.get_right() - bounds.get_left();
    // A page field could mimic the class, so require a wide edit in the browser toolbar.
    if bounds.get_top() < window_bounds.get_top()
        || bounds.get_bottom()
            > window_bounds.get_top() + (window_bounds.get_bottom() - window_bounds.get_top()) / 3
        || address_width < window_width / 4
        || !has_toolbar_ancestor(automation, &element)
    {
        return None;
    }
    Some(element)
}

fn omnibox_read(element: &UIElement) -> BarRead {
    // While the address bar has the keyboard, what it holds may be a search being typed, not
    // the page's address; that it has the keyboard is what makes the next address a "Go to".
    let focused = element
        .get_property_value(UIProperty::HasKeyboardFocus)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok());
    match focused {
        Some(false) => BarRead {
            origin: omnibox_origin(element),
            focused: false,
        },
        Some(true) => BarRead {
            origin: None,
            focused: true,
        },
        None => BarRead::default(),
    }
}

fn omnibox_origin(element: &UIElement) -> Option<String> {
    let is_password = element
        .get_property_value(UIProperty::IsPassword)
        .ok()
        .and_then(|value| TryInto::<bool>::try_into(value).ok())
        .unwrap_or(true);
    if is_password {
        return None;
    }
    origin_from_address(&read_value(element)?)
}

/// Whether an element is part of a web page (has a document above it), not the browser's own UI.
fn inside_document(automation: &UIAutomation, element: &UIElement) -> bool {
    let Ok(walker) = automation.get_control_view_walker() else {
        return true;
    };
    let mut current = element.clone();
    for _ in 0..32 {
        let Ok(parent) = walker.get_parent(&current) else {
            return false;
        };
        if parent.get_control_type().ok() == Some(uiautomation::types::ControlType::Document) {
            return true;
        }
        current = parent;
    }
    true
}

fn has_toolbar_ancestor(automation: &UIAutomation, element: &UIElement) -> bool {
    let Ok(walker) = automation.get_control_view_walker() else {
        return false;
    };
    let mut current = element.clone();
    for _ in 0..16 {
        let Ok(parent) = walker.get_parent(&current) else {
            return false;
        };
        if parent.get_control_type().ok() == Some(uiautomation::types::ControlType::ToolBar) {
            return true;
        }
        current = parent;
    }
    false
}

/// Whether the focused element is a browser's address bar, the kinds `find_omnibox` finds: the
/// native omnibox edit, the combo box inside Chrome 155's own toolbar view, or Firefox's. What's
/// typed there is the address, and only its site is kept, by the "Go to" step: it's never a
/// typing step, which would keep the whole address (testing, 30/09/2026).
pub(super) fn is_address_bar(
    automation: &UIAutomation,
    element: &UIElement,
    facts: &ElementFacts,
) -> bool {
    if facts.class_name == NATIVE_OMNIBOX {
        return true;
    }
    if facts.automation_id == FIREFOX_URLBAR {
        return !inside_document(automation, element);
    }
    if facts.control_type != "ComboBox" || facts.framework_id != "Chrome" {
        return false;
    }
    let Ok(walker) = automation.get_raw_view_walker() else {
        return false;
    };
    let mut current = element.clone();
    for _ in 0..16 {
        let Ok(parent) = walker.get_parent(&current) else {
            return false;
        };
        if parent.get_classname().ok().as_deref() == Some(WEB_UI_TOOLBAR) {
            return true;
        }
        current = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check: prints what Steps reads from the address bar of every open Firefox, Chrome and
    /// Edge window. `cargo test -p capture reads_open_browsers_address_bars -- --ignored
    /// --nocapture`, with a browser open on a web page.
    #[test]
    #[ignore = "needs browser windows open on this desktop"]
    fn reads_open_browsers_address_bars() {
        let automation = UIAutomation::new().expect("UI Automation");
        let root = automation.get_root_element().expect("root");
        let windows = automation
            .create_true_condition()
            .and_then(|all| root.find_all(TreeScope::Children, &all))
            .expect("windows");
        let mut found = 0;
        for window in windows {
            let class = window.get_classname().unwrap_or_default();
            if class != "MozillaWindowClass" && class != "Chrome_WidgetWin_1" {
                continue;
            }
            let Ok(handle) = window.get_native_window_handle() else {
                continue;
            };
            let hwnd: isize = handle.into();
            let read = cached_origin(&automation, &mut HashMap::new(), hwnd);
            println!(
                "{class} {:?}: {read:?}",
                window.get_name().unwrap_or_default()
            );
            found += usize::from(read.origin.is_some() || read.focused);
        }
        assert!(found > 0, "no browser address bar was read");
    }
}
