//! The facts the capture layer hands on. Wording is decided later, in TypeScript
//! (docs/spec/01-architecture.md#the-key-split). Serialised as camelCase JSON.

use serde::{Deserialize, Serialize};

use crate::coords::{PctPoint, PctRect, PxRect, rect_to_pct};
use crate::screenshot::{CaptureMode, Shot};

/// What UI Automation reported about the element under the click.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementFacts {
    /// UIA control type, e.g. `Button`, `Edit`, `Hyperlink`.
    pub control_type: String,
    pub localized_control_type: String,
    pub name: String,
    pub automation_id: String,
    pub help_text: String,
    pub aria_role: String,
    pub aria_properties: String,
    pub class_name: String,
    /// e.g. `Chrome`, `Win32`, `WPF`, `DirectUI`.
    pub framework_id: String,
    pub is_password: bool,
    /// Name of the element that labels this one (`LabeledBy`), if any.
    pub labeled_by: Option<String>,
    /// Physical pixels.
    pub bounds: Option<PxRect>,
    /// The element's parents, nearest first: up to four, stopping below the window or the web
    /// page (`lookup::parents`). What they say about the click is decided in TypeScript
    /// (docs/spec/02-capture.md#click-naming): a text or unnamed part of a named item is that item.
    pub ancestors: Vec<AncestorFacts>,
    /// Matches the sensitive-field rules; its value is never read.
    pub sensitive: bool,
    /// A spreadsheet cell with a filter drop-down (Excel's `HasFilterDropdown`): the cell's words,
    /// the header the filter is on (12/10/2026, #70). `None` for anything else, and left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_header: Option<String>,
    /// The class of the Document the parents stopped at (`lookup::parents`): Word's body is
    /// `_WwG`, so a page under it is part of the document's text (12/10/2026, #74). `None` when
    /// they stopped anywhere else, and left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_class: Option<String>,
}

/// One of an element's parents.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AncestorFacts {
    pub control_type: String,
    pub name: String,
}

/// The top-level window that was clicked.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowFacts {
    pub title: String,
    pub exe: Option<String>,
    pub pid: u32,
    pub frame: PxRect,
    /// `notElevated`, `elevated` or `unknown`.
    pub elevation: &'static str,
    /// The window is a remote-desktop client (RDP, Citrix, AVD): no element names inside it.
    pub remote_session: bool,
    /// The program's own name ("Microsoft Edge"), from its version details; `None` when they give
    /// none, or only the program's file name ("mspaint.exe").
    pub app_name: Option<String>,
    /// For a store app's frame (drawn by `ApplicationFrameHost.exe`: Calculator, Settings), the
    /// app it shows, by its package's display name ("Calculator"); left out for other windows and
    /// when it wasn't found. TypeScript's `appNameOf` names the window's app from these facts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_app: Option<String>,
    /// For a frame Windows draws round another program's window, that program's file
    /// (`TextInputHost.exe` for the input panel Windows 11 shows in a frame of `explorer.exe`'s,
    /// #109); left out for other windows. TypeScript's click naming knows the input panel by it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_exe: Option<String>,
    /// For a click in a pop-up (a menu, a drop-down list: a top-level window without a title bar
    /// of Windows'), the title of the window it came from, as #72 finds it as the button went down
    /// (`Pressed::owner`; "" when that has none). TypeScript's click naming names a click by it
    /// when nothing else does, before the pop-up's own title, which isn't on screen (`WinUI`'s
    /// pop-up host is "Pop-upHost" in en-GB, translated in other languages, #106). Left out for
    /// any other window, and for a pop-up of the Windows shell's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_title: Option<String>,
    /// Part of Windows itself (the taskbar, Start, search, the desktop), not an app.
    pub shell: bool,
}

/// What was captured and how it maps onto the screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFacts {
    /// `window` or `monitor`.
    pub mode: &'static str,
    /// The captured area in physical pixels; every percentage is relative to it.
    pub rect: PxRect,
    pub monitor: PxRect,
    /// Monitor scale, e.g. 1.5.
    pub scale: f32,
    pub width: u32,
    pub height: u32,
    /// Image file written next to the log, if the sink stores images.
    pub image: Option<String>,
    /// Where a notification toast shows in the picture, as percentages of it: suggested for
    /// blurring (docs/spec/08-privacy-and-security.md#suggested-blurs). Absent when none shows.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notifications: Vec<PctRect>,
}

impl CaptureFacts {
    /// A screenshot's facts, taken in `mode`.
    #[must_use]
    pub fn of(shot: &Shot, mode: CaptureMode) -> Self {
        Self {
            mode: mode.as_str(),
            rect: shot.rect,
            monitor: shot.monitor,
            scale: shot.scale,
            width: shot.image.width(),
            height: shot.image.height(),
            image: None,
            notifications: shot
                .notifications
                .iter()
                .filter_map(|area| rect_to_pct(&shot.rect, area))
                .collect(),
        }
    }
}

/// How the UIA lookup went.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiaOutcome {
    /// `ok`, `timeout`, `error` or `skipped`.
    pub status: &'static str,
    pub ms: f64,
    pub retried: bool,
    pub error: Option<String>,
    /// The element was read under the resting pointer before the click (its pre-read), not
    /// after it (docs/spec/02-capture.md#on-each-click). Left out when it wasn't.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pre_read: bool,
}

/// A page element's step facts, as Steps for Chrome and Edge reads them from the page
/// (`StepTarget` in `packages/core`). Each is at most 2,000 characters, as in the guide format.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aria_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inner_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// A button's words (`<input type="submit" value="Send">`); never a field's contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl PageTarget {
    /// The longest any fact may be.
    pub const MAX_CHARS: usize = 2_000;

    /// Every fact within the guide format's limit.
    #[must_use]
    pub fn within_limits(&self) -> bool {
        [
            &self.tag_name,
            &self.element_type,
            &self.aria_label,
            &self.inner_text,
            &self.placeholder,
            &self.name,
            &self.label_text,
            &self.alt,
            &self.role,
            &self.value,
        ]
        .into_iter()
        .flatten()
        .all(|text| text.chars().count() <= Self::MAX_CHARS)
    }
}

/// What Steps for Chrome or Edge said about a click in a web page
/// (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together): the element's own step
/// facts, which word the step in place of UI Automation's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDetails {
    pub target: PageTarget,
}

/// One recorded click.
#[allow(
    clippy::struct_excessive_bools,
    reason = "each is a separate fact about the click, read by the journal's schema"
)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClickRecord {
    pub id: u64,
    pub tick_ms: u32,
    /// `left`, `right` or `middle`.
    pub button: &'static str,
    pub injected: bool,
    /// Physical pixels.
    pub x: i32,
    pub y: i32,
    pub window: WindowFacts,
    pub capture: CaptureFacts,
    pub click_pct: Option<PctPoint>,
    pub element: Option<ElementFacts>,
    pub element_pct: Option<PctRect>,
    pub uia: UiaOutcome,
    pub screenshot_ms: f64,
    /// Time between the button going down and the worker picking it up.
    pub queue_delay_ms: u32,
    /// Added by the app when Steps for Chrome or Edge said what this click was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<PageDetails>,
    /// The window's own title-bar button the left button went down on (`close`, `minimise`,
    /// `maximise` or `restore`), from the window's hit test before it reacted (#48).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_bar_button: Option<&'static str>,
    /// The left button went down on the filter drop-down of the spreadsheet header clicked, told
    /// from the cell's box (12/10/2026, #70). Left out when it didn't.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub filter_button: bool,
    /// The window clicked was no longer under the click once the screenshot had been taken (it
    /// closed, or moved away): the picture may show what was behind it there, so the words on it
    /// never name the click (F019, #48).
    pub window_gone: bool,
    /// The items of the open menu the click landed in, as UI Automation read them when the menu
    /// opened (`menus.rs`, #56): a name read from the screenshot is matched against them in
    /// TypeScript. Absent off a menu.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub menu_items: Vec<MenuItemFacts>,
    /// The menu `menu_items` are from still showed as the button went down: it was read in a
    /// window of its own, which was the window under the pointer then (`menus.rs`, #106). The
    /// item whose box holds the click is then the one clicked, with or without the screenshot's
    /// words. Left out otherwise.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub menu_showing: bool,
}

/// One of a menu's items, with its box on the click's screenshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemFacts {
    pub name: String,
    /// Percentages of the screenshot; `None` when it had no box there.
    #[serde(rename = "box")]
    pub box_pct: Option<PctRect>,
}

impl MenuItemFacts {
    /// A menu's items as a click on `capture` keeps them.
    #[must_use]
    pub fn on(capture: &PxRect, items: Vec<crate::menus::MenuItem>) -> Vec<Self> {
        items
            .into_iter()
            .map(|item| Self {
                box_pct: item.bounds.and_then(|bounds| rect_to_pct(capture, &bounds)),
                name: item.name,
            })
            .collect()
    }
}

/// A user-requested screenshot step or the screenshot attached to an Add shortcut step.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualRecord {
    pub id: u64,
    pub tick_ms: u32,
    /// `captureNow` or `shortcut`.
    pub purpose: &'static str,
    pub action_text: String,
    pub window: WindowFacts,
    pub capture: CaptureFacts,
    pub click_pct: Option<PctPoint>,
}

/// A foreground application change, used for the optional "Open <app>" guide step.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSwitchRecord {
    /// Keys its screenshot's file name; not shown.
    pub id: u64,
    pub tick_ms: u32,
    pub window: WindowFacts,
    /// The app a moment after it came forward (F004, F020: "Open" steps had no picture).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureFacts>,
    /// No click, tap or key came in the moments before the app came forward, so it may have come
    /// forward by itself and its step needs review (#67, `switches`).
    pub unprompted: bool,
}

/// A validated browser site origin change. Paths, queries and fragments are never retained.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationRecord {
    pub tick_ms: u32,
    pub origin: String,
    pub window: WindowFacts,
    /// The page arrived at, once its address settled (04/10/2026: "Go to" steps had no picture).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureFacts>,
}

/// A drag across spreadsheet cells, from the cell the left button went down on to the one it came
/// up on, with a screenshot of the selection; or a use of Excel's fill handle (08/10/2026).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragRecord {
    pub id: u64,
    /// The click the drag began with.
    pub of: u64,
    /// When the button came up, or for a double-click, when it went down the second time.
    pub tick_ms: u32,
    /// The cell pressed on; for a fill, the cell whose handle it was.
    pub from: String,
    /// The cell the button came up on. `None` only for a fill: double-clicked (it fills down as
    /// far as the column beside it goes), or dragged to where no cell was found.
    pub to: Option<String>,
    /// How the fill handle was used; absent for a selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<FillKind>,
    pub window: WindowFacts,
    pub capture: Option<CaptureFacts>,
    /// The selection: the two cells' boxes together; for a fill, the cells filled.
    pub selection_pct: Option<PctRect>,
    /// For a fill, where its handle is on the screenshot: what's shown when there's no end cell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle_pct: Option<PctPoint>,
}

/// A drag that drew on a canvas (12/10/2026, #73): the left button went down on Paint's canvas,
/// with a pencil or brush, and came up at least a drag's distance away. It replaces the click it
/// began with, as a selection does.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawRecord {
    pub id: u64,
    /// The click the drawing began with.
    pub of: u64,
    /// When the button came up.
    pub tick_ms: u32,
    /// The canvas, as the click found it (Paint names it after the tool in use).
    pub element: ElementFacts,
    pub window: WindowFacts,
    /// The window as the button came up, showing what was drawn.
    pub capture: Option<CaptureFacts>,
    /// Where the drawing began, on that screenshot.
    pub from_pct: Option<PctPoint>,
}

/// How Excel's fill handle was used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FillKind {
    /// Dragged to another cell.
    Drag,
    /// Double-clicked: Excel fills down the column.
    Double,
}

/// A field's value was read when focus left it (only when "Record typed values" is on).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRecord {
    pub tick_ms: u32,
    /// When focus arrived in the field: a pause between then and `tick_ms` drops the record,
    /// since what was typed during it can't be told apart. Never saved.
    #[serde(skip)]
    pub focused_tick_ms: u32,
    /// Process that owns the field, so values from excluded apps are dropped. Never saved.
    #[serde(skip)]
    pub pid: u32,
    /// The top-level window in front when focus arrived (its process and exe), checked against
    /// our own process and the exclusions too. Never saved.
    #[serde(skip)]
    pub window_pid: u32,
    #[serde(skip)]
    pub window_exe: Option<String>,
    pub element: ElementFacts,
    /// `None` when withheld; see `withheld`.
    pub value: Option<String>,
    /// Why the value wasn't read: `sensitive`, `password`, `setting-off`, `unreadable`, or
    /// `program` (another program typed into the field as Unicode packets, #91).
    pub withheld: Option<&'static str>,
    /// A screenshot taken as focus arrived in the field, before anything was typed, with the
    /// window and the field's place in it (04/10/2026: typing steps had no picture). Absent
    /// where none was taken.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowFacts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureFacts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element_pct: Option<PctRect>,
}

/// A command run in a terminal (docs/spec/02-capture.md#terminals). Only recorded when "Record
/// what's typed" is ticked for the recording.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub id: u64,
    /// When Enter was pressed.
    pub tick_ms: u32,
    pub window: WindowFacts,
    /// Taken once the output settled. `None` when it couldn't be (another monitor was chosen).
    pub capture: Option<CaptureFacts>,
    /// `console` or `windowsTerminal`.
    pub terminal: &'static str,
    /// `powershell`, `cmd`, `bash` or `plain`.
    pub language: &'static str,
    /// As the terminal showed it, secrets masked.
    pub command: String,
    /// Only when "Include command output" is ticked; masked the same way.
    pub output: Option<String>,
    /// The output was longer than a step keeps, or its start had scrolled out of view.
    pub output_shortened: bool,
    /// A secret was masked but couldn't be found in the screenshot to blur.
    pub check_screenshot: bool,
}

/// A stretch of typing in one place with no field to read it from: a code editor, a document,
/// or an Excel cell (docs/spec/02-capture.md#keys).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingRecord {
    pub id: u64,
    /// The first key.
    pub tick_ms: u32,
    pub window: WindowFacts,
    pub capture: Option<CaptureFacts>,
    /// Where the typing went, when UI Automation named it.
    pub element: Option<ElementFacts>,
    /// Masked: card numbers and the like in text, secrets in code.
    pub text: String,
    /// `code` (a code block), `text` (quoted) or `formula` (an Excel formula).
    pub form: &'static str,
    /// For code: `plain` unless known. For a formula: `excel`.
    pub language: &'static str,
    /// Excel only: the cell, as Excel names it (`B6`).
    pub cell: Option<String>,
    /// The caret moved or keys were lost while typing, so the text may differ from what's there.
    pub approximate: bool,
    pub check_screenshot: bool,
}

/// A key combination, such as Ctrl+Shift+N. The wording is made from these in TypeScript.
#[allow(
    clippy::struct_excessive_bools,
    reason = "each is a separate modifier key, held or not"
)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysRecord {
    pub id: u64,
    pub tick_ms: u32,
    pub window: WindowFacts,
    pub capture: Option<CaptureFacts>,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    /// The Windows virtual-key code of the key pressed with them.
    pub vkey: u16,
    /// What that key types on its own in this keyboard layout, for keys whose name depends on it
    /// (`;`, `ß`). `None` for keys that type nothing.
    pub key: Option<String>,
}

/// Everything the pipeline emits, in order.
#[allow(
    clippy::large_enum_variant,
    reason = "a few records per second; boxing buys nothing"
)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Record {
    Click(ClickRecord),
    Manual(ManualRecord),
    AppSwitch(AppSwitchRecord),
    Navigation(NavigationRecord),
    /// The second press of a double-click; the step is `of`.
    Double {
        of: u64,
        tick_ms: u32,
    },
    Input(InputRecord),
    /// Cells selected by dragging from one to another (04/10/2026), or filled with Excel's fill
    /// handle (08/10/2026); the click it started with is `of`, which the step replaces.
    Drag(DragRecord),
    /// A pencil or brush dragged across a canvas (12/10/2026, #73); the click it started with
    /// is `of`, which the step replaces.
    Draw(DrawRecord),
    Command(CommandRecord),
    Typing(TypingRecord),
    Keys(KeysRecord),
    /// Button-downs lost because the queue was full, shown as "N clicks missed here".
    Missed {
        count: u64,
        after_id: u64,
    },
    /// Touch or pen activity that the current click source could not turn into steps.
    Touch {
        count: u64,
        tick_ms: u32,
    },
    /// Recording state changes: `degraded`, `recovered`.
    State {
        state: &'static str,
        reason: String,
        tick_ms: u32,
    },
}

impl Record {
    /// When the user did what this records, for records that come from something they did.
    /// Markers and state changes have none.
    #[must_use]
    pub fn event_tick(&self) -> Option<u32> {
        match self {
            Self::Click(click) => Some(click.tick_ms),
            Self::Manual(manual) => Some(manual.tick_ms),
            Self::AppSwitch(switch) => Some(switch.tick_ms),
            Self::Navigation(navigation) => Some(navigation.tick_ms),
            Self::Input(input) => Some(input.tick_ms),
            Self::Drag(drag) => Some(drag.tick_ms),
            Self::Draw(draw) => Some(draw.tick_ms),
            Self::Command(command) => Some(command.tick_ms),
            Self::Typing(typing) => Some(typing.tick_ms),
            Self::Keys(keys) => Some(keys.tick_ms),
            Self::Double { tick_ms, .. } | Self::Touch { tick_ms, .. } => Some(*tick_ms),
            Self::Missed { .. } | Self::State { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(hosted_app: Option<&str>) -> WindowFacts {
        WindowFacts {
            title: "Calculator".into(),
            exe: Some("ApplicationFrameHost.exe".into()),
            pid: 7,
            frame: PxRect::default(),
            elevation: "notElevated",
            remote_session: false,
            app_name: Some("Application Frame Host".into()),
            hosted_app: hosted_app.map(str::to_string),
            hosted_exe: None,
            owner_title: None,
            shell: false,
        }
    }

    /// `packages/core/src/recording.ts` reads it as `documentClass`, absent unless the parents
    /// stopped at a Document (#74).
    #[test]
    fn an_element_says_the_class_of_the_document_it_is_in() {
        let page = ElementFacts {
            control_type: "Custom".into(),
            name: "Page 1".into(),
            document_class: Some("_WwG".into()),
            ..ElementFacts::default()
        };
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(json["documentClass"], "_WwG");
        let json = serde_json::to_value(ElementFacts::default()).unwrap();
        assert!(json.get("documentClass").is_none(), "{json}");
    }

    /// `packages/core/src/recording.ts` reads it as `hostedApp`, absent for other windows (#50).
    #[test]
    fn a_store_apps_frame_says_which_app_it_shows() {
        let json = serde_json::to_value(window(Some("Calculator"))).unwrap();
        assert_eq!(json["hostedApp"], "Calculator");
        assert_eq!(json["appName"], "Application Frame Host");
        let json = serde_json::to_value(window(None)).unwrap();
        assert!(json.get("hostedApp").is_none(), "{json}");
    }

    /// `packages/core/src/recording.ts` reads it as `hostedExe`, absent for other windows (#109).
    #[test]
    fn a_frame_says_which_program_it_shows() {
        let panel = WindowFacts {
            exe: Some("explorer.exe".into()),
            hosted_exe: Some("TextInputHost.exe".into()),
            ..window(None)
        };
        let json = serde_json::to_value(panel).unwrap();
        assert_eq!(json["hostedExe"], "TextInputHost.exe");
        let json = serde_json::to_value(window(None)).unwrap();
        assert!(json.get("hostedExe").is_none(), "{json}");
    }

    /// `packages/core/src/recording.ts` reads it as `ownerTitle`, absent for other windows (#106).
    #[test]
    fn a_pop_up_says_the_title_of_the_window_it_came_from() {
        let host = WindowFacts {
            title: "Pop-upHost".into(),
            exe: Some("mspaint.exe".into()),
            owner_title: Some("Untitled - Paint".into()),
            ..window(None)
        };
        let json = serde_json::to_value(host).unwrap();
        assert_eq!(json["ownerTitle"], "Untitled - Paint");
        // A window it came from with no title still says the window clicked is a pop-up.
        let untitled = WindowFacts {
            owner_title: Some(String::new()),
            ..window(None)
        };
        assert_eq!(serde_json::to_value(untitled).unwrap()["ownerTitle"], "");
        let json = serde_json::to_value(window(None)).unwrap();
        assert!(json.get("ownerTitle").is_none(), "{json}");
    }
}
