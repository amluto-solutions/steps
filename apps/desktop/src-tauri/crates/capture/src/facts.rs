//! The facts the capture layer hands on. Wording is decided later, in TypeScript
//! (docs/spec/01-architecture.md#the-key-split). Serialised as camelCase JSON.

use serde::{Deserialize, Serialize};

use crate::coords::{PctPoint, PctRect, PxRect};

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
    /// Control type and name of the parent, for text nodes inside links and buttons.
    pub parent: Option<ParentFacts>,
    /// Matches the sensitive-field rules; its value is never read.
    pub sensitive: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentFacts {
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
    /// The program's own name ("Microsoft Edge"), from its version details.
    pub app_name: Option<String>,
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
}

/// A validated browser site origin change. Paths, queries and fragments are never retained.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationRecord {
    pub tick_ms: u32,
    pub origin: String,
    pub window: WindowFacts,
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
    /// Why the value wasn't read: `sensitive`, `password`, `setting-off`, `unreadable`.
    pub withheld: Option<&'static str>,
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
            Self::Command(command) => Some(command.tick_ms),
            Self::Typing(typing) => Some(typing.tick_ms),
            Self::Keys(keys) => Some(keys.tick_ms),
            Self::Double { tick_ms, .. } | Self::Touch { tick_ms, .. } => Some(*tick_ms),
            Self::Missed { .. } | Self::State { .. } => None,
        }
    }
}
