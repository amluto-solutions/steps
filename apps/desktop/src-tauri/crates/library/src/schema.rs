//! A typed mirror of the guide and step files, format version 1
//! (docs/spec/03-data-and-sharing.md#step-file).
//!
//! Files from outside (an `.amlsteps` import) are parsed into these structs and written back out
//! from them, so unknown fields are dropped and every value has the expected type. Rich text
//! (`TipTap` JSON) is limited to an allow-list of nodes and marks, and links to http, https and
//! mailto, so nothing a file carries can become script in the editor or an export.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use crate::util::is_safe_segment;

/// The largest `target` (the captured UI element facts) a step may carry, serialised.
pub(crate) const MAX_TARGET_BYTES: usize = 64 * 1024;

/// `guide.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuideV1 {
    pub id: String,
    pub title: String,
    pub description: String,
    pub intro: Option<RichNode>,
    pub outro: Option<RichNode>,
    pub brand_profile_id: Option<String>,
    pub tags: Vec<String>,
    pub owner: String,
    pub review_by: Option<String>,
    pub created_at: String,
    pub created_by: String,
    pub updated_at: String,
    pub updated_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording_session_id: Option<String>,
    /// The language its recorded steps are worded in; English when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// How its recorded steps are worded; one from a newer version is dropped (casual).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "known_tone"
    )]
    pub tone: Option<String>,
    /// Its title, description, intro and outro in other languages (checked by `clean_translations`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translations: Option<Value>,
    pub format_version: u32,
}

/// `steps\<id>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepV1 {
    pub id: String,
    pub sort_key: String,
    pub kind: StepKind,
    pub action: String,
    pub action_text: String,
    pub text_parts: TextParts,
    pub show_value: bool,
    pub text_edited: bool,
    pub notes: Option<RichNode>,
    pub alt_text: Option<String>,
    pub context: StepContext,
    #[serde(default)]
    pub target: Value,
    pub media: Option<Media>,
    pub highlight: Option<Highlight>,
    pub crop: Option<Crop>,
    #[serde(default)]
    pub redactions: Vec<Redaction>,
    /// Areas marked "Not personal", where blurs aren't suggested again. Absent on most steps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_personal: Vec<Area>,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    pub block: Option<Block>,
    /// A command, code or formula shown as a code block. Absent on other steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<Code>,
    pub captured_at: String,
    pub updated_at: String,
    pub updated_by: String,
    pub format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_required: Option<bool>,
    /// Its words in other languages (checked by `clean_translations`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translations: Option<Value>,
}

/// `code` on a step (`codeSchema` in packages/core/src/code.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Code {
    pub text: String,
    /// One of the core's `CODE_LANGUAGES`; anything else is read as `plain`, as the UI does.
    #[serde(deserialize_with = "known_language")]
    pub language: String,
    pub output: Option<String>,
    pub output_shortened: bool,
}

const TONES: &[&str] = &["casual", "plain", "formal"];

fn known_tone<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(deserializer)?;
    Ok(value.filter(|tone| TONES.contains(&tone.as_str())))
}

/// A language code as guides key their translations by: `de`, `pt-BR`, `sr-Latn`, `zh-Hant`.
fn is_language_code(code: &str) -> bool {
    let mut parts = code.split('-');
    let first_ok = parts.next().is_some_and(|base| {
        (2..=3).contains(&base.len()) && base.bytes().all(|b| b.is_ascii_alphabetic())
    });
    let rest: Vec<&str> = parts.collect();
    first_ok
        && rest.len() <= 2
        && rest.iter().all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// What one translated field may hold.
#[derive(Clone, Copy)]
enum TextField {
    /// Plain text up to this many characters.
    Plain(usize),
    /// Plain text up to this many characters, or null.
    PlainOrNull(usize),
    /// Rich text, or null.
    Rich,
}

const GUIDE_TEXT: &[(&str, TextField)] = &[
    ("title", TextField::Plain(300)),
    ("description", TextField::Plain(5_000)),
    ("intro", TextField::Rich),
    ("outro", TextField::Rich),
];

const STEP_TEXT: &[(&str, TextField)] = &[
    ("actionText", TextField::Plain(2_000)),
    ("notes", TextField::Rich),
    ("altText", TextField::PlainOrNull(2_000)),
    ("heading", TextField::Plain(500)),
    ("body", TextField::Rich),
];

/// The most languages a guide or step may hold words in.
const MAX_LANGUAGES: usize = 64;

/**
 * Translations as packages/core/src/guide.ts allows them (`translations`), rebuilt from scratch:
 * known language codes only, at most 64, each holding only the known fields, with their limits,
 * and rich text through the same allow-list as everywhere else.
 */
fn clean_translations(value: &Value, fields: &[(&str, TextField)]) -> Result<Value, Problem> {
    let Some(languages) = value.as_object() else {
        return Err("has translations that aren't a list of languages".to_string());
    };
    if languages.len() > MAX_LANGUAGES {
        return Err(format!("has words in more than {MAX_LANGUAGES} languages"));
    }
    let mut cleaned = serde_json::Map::new();
    for (code, text) in languages {
        if !is_language_code(code) {
            return Err("has translations under an invalid language code".to_string());
        }
        let Some(text) = text.as_object() else {
            return Err(format!("has {code} words that aren't a list of texts"));
        };
        let mut kept = serde_json::Map::new();
        for &(name, kind) in fields {
            let Some(field) = text.get(name) else {
                continue;
            };
            let label = format!("its {code} {name}");
            let field = match (kind, field) {
                (TextField::Plain(max) | TextField::PlainOrNull(max), Value::String(words)) => {
                    check_text(&label, words, max)?;
                    field.clone()
                }
                (TextField::PlainOrNull(_) | TextField::Rich, Value::Null) => Value::Null,
                (TextField::Rich, _) => {
                    let rich: RichNode = serde_json::from_value(field.clone())
                        .map_err(|error| format!("{label}: {error}"))?;
                    check_rich(&rich).map_err(|problem| format!("{label} {problem}"))?;
                    serde_json::to_value(rich).map_err(|error| format!("{label}: {error}"))?
                }
                _ => return Err(format!("{label} has the wrong type")),
            };
            kept.insert(name.to_string(), field);
        }
        cleaned.insert(code.clone(), Value::Object(kept));
    }
    Ok(Value::Object(cleaned))
}

const CODE_LANGUAGES: &[&str] = &[
    "powershell",
    "cmd",
    "bash",
    "excel",
    "python",
    "javascript",
    "sql",
    "json",
    "xml",
    "plain",
];

fn known_language<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    Ok(if CODE_LANGUAGES.contains(&value.as_str()) {
        value
    } else {
        "plain".to_string()
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StepKind {
    Interaction,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextParts {
    pub verb: String,
    pub target: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepContext {
    pub app: Option<String>,
    pub window_title: String,
}

/// The recorder writes nullable fields here (a capture whose screenshot failed), so all are
/// optional.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Media {
    pub id: Option<String>,
    pub width: Option<Number>,
    pub height: Option<Number>,
    pub scale: Option<Number>,
    pub capture_rect: Option<[Number; 4]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Highlight {
    pub shape: HighlightShape,
    pub x: Number,
    pub y: Number,
    pub w: Number,
    pub h: Number,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HighlightShape {
    Circle,
    Box,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Crop {
    pub x: Number,
    pub y: Number,
    pub w: Number,
    pub h: Number,
    pub source: CropSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CropSource {
    Auto,
    Manual,
}

/// A box on the screenshot, as percentages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Area {
    pub x: Number,
    pub y: Number,
    pub w: Number,
    pub h: Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Redaction {
    pub x: Number,
    pub y: Number,
    pub w: Number,
    pub h: Number,
    pub source: RedactionSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RedactionSource {
    Manual,
    Suggested,
}

/// A colour this version doesn't know (from a newer one) is read as the accent, as the UI does,
/// rather than refusing the step.
fn known_colour<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MarkColour>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// A mark's colour when it isn't the brand's accent (the default, which isn't stored).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MarkColour {
    Red,
    Amber,
    Green,
    Black,
    White,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Annotation {
    Arrow {
        from: [Number; 2],
        to: [Number; 2],
        #[serde(
            default,
            deserialize_with = "known_colour",
            skip_serializing_if = "Option::is_none"
        )]
        colour: Option<MarkColour>,
    },
    Label {
        x: Number,
        y: Number,
        text: String,
        #[serde(
            default,
            deserialize_with = "known_colour",
            skip_serializing_if = "Option::is_none"
        )]
        colour: Option<MarkColour>,
    },
    #[serde(rename = "box")]
    Rect {
        x: Number,
        y: Number,
        w: Number,
        h: Number,
        #[serde(
            default,
            deserialize_with = "known_colour",
            skip_serializing_if = "Option::is_none"
        )]
        colour: Option<MarkColour>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Block {
    #[serde(rename = "type")]
    pub kind: BlockType,
    pub heading: String,
    pub body: Option<RichNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BlockType {
    Header,
    Text,
    Tip,
    Callout,
    Warning,
    Alert,
}

/// One `TipTap` node. Only the allow-listed node types parse at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RichNode {
    #[serde(rename = "type")]
    pub node_type: NodeType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<NodeAttrs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<RichNode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marks: Option<Vec<Mark>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NodeType {
    Doc,
    Paragraph,
    Text,
    Heading,
    BulletList,
    OrderedList,
    ListItem,
    HardBreak,
    /// A coloured box in notes (note, tip, warning or important).
    Callout,
}

/// Which coloured box a callout is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CalloutKind {
    Note,
    Tip,
    Warning,
    Important,
}

/// A kind from a newer version reads as a note, as the UI reads it, rather than refusing the file.
fn known_callout<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<CalloutKind>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.map(|value| serde_json::from_value(value).unwrap_or(CalloutKind::Note)))
}

/// The only node attributes kept: a heading's level, an ordered list's first number and a
/// callout's kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    #[serde(
        default,
        deserialize_with = "known_callout",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<CalloutKind>,
}

/// Struct variants (not unit ones) so extra keys such as `attrs: {}` on bold are dropped rather
/// than refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Mark {
    Bold {},
    Italic {},
    Link { attrs: LinkAttrs },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkAttrs {
    pub href: String,
}

/// Why a file doesn't match the format, in words for the import error.
pub(crate) type Problem = String;

/// The `formatVersion` of a raw file: `Ok(true)` for version 1, `Ok(false)` for a newer one.
pub(crate) fn format_version_is_current(value: &Value) -> Result<bool, Problem> {
    match value.get("formatVersion").and_then(Value::as_u64) {
        Some(1) => Ok(true),
        Some(version) if version > 1 => Ok(false),
        _ => Err("it has no valid formatVersion".to_string()),
    }
}

/// Text lengths as the UI's schema counts them (UTF-16 code units), so a file the library takes
/// in is one the editor can open: a step the UI refuses would be dropped from view while search
/// and exports still used it.
fn too_long(text: &str, max: usize) -> bool {
    text.len() > max && text.encode_utf16().count() > max
}

fn check_text(label: &str, text: &str, max: usize) -> Result<(), Problem> {
    if too_long(text, max) {
        Err(format!("{label} is longer than {max} characters"))
    } else {
        Ok(())
    }
}

/// The limits in packages/core/src/guide.ts (guideSchema), which this mirrors.
fn check_guide_limits(guide: &GuideV1) -> Result<(), Problem> {
    check_text("the title", &guide.title, 300)?;
    check_text("the description", &guide.description, 5_000)?;
    if guide.tags.len() > 50 {
        return Err("it has more than 50 tags".to_string());
    }
    for tag in &guide.tags {
        check_text("a tag", tag, 60)?;
    }
    for (label, text) in [
        ("the owner", &guide.owner),
        ("createdBy", &guide.created_by),
        ("updatedBy", &guide.updated_by),
    ] {
        check_text(label, text, 200)?;
    }
    if guide
        .recording_session_id
        .as_deref()
        .is_some_and(|id| !is_safe_segment(id))
    {
        return Err("it has an invalid recording id".to_string());
    }
    if guide
        .language
        .as_deref()
        .is_some_and(|code| !is_language_code(code))
    {
        return Err("it has an invalid language".to_string());
    }
    Ok(())
}

/// The limits in packages/core/src/guide.ts (guideStepSchema), which this mirrors.
fn check_step_limits(step: &StepV1) -> Result<(), Problem> {
    if step.sort_key.is_empty()
        || step.sort_key.len() > 200
        || !step
            .sort_key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
    {
        return Err("has an invalid sort key".to_string());
    }
    check_text("its action", &step.action, 40)?;
    check_text("its wording", &step.action_text, 2_000)?;
    check_text("its verb", &step.text_parts.verb, 200)?;
    check_text("its target name", &step.text_parts.target, 2_000)?;
    check_text("its control type", &step.text_parts.kind, 200)?;
    if let Some(value) = &step.text_parts.value {
        check_text("its typed value", value, 2_000)?;
    }
    if let Some(alt) = &step.alt_text {
        check_text("its alt text", alt, 2_000)?;
    }
    if let Some(app) = &step.context.app {
        check_text("its app name", app, 260)?;
    }
    check_text("its window title", &step.context.window_title, 2_000)?;
    check_text("updatedBy", &step.updated_by, 200)?;
    if step.redactions.len() > 500 {
        return Err("has more than 500 blurred areas".to_string());
    }
    if step.not_personal.len() > 200 {
        return Err("has more than 200 areas marked not personal".to_string());
    }
    if step.annotations.len() > 200 {
        return Err("has more than 200 annotations".to_string());
    }
    for annotation in &step.annotations {
        if let Annotation::Label { text, .. } = annotation {
            check_text("a label", text, 500)?;
        }
    }
    if let Some(block) = &step.block {
        check_text("its heading", &block.heading, 500)?;
    }
    if let Some(code) = &step.code {
        check_text("its code", &code.text, 20_000)?;
        if let Some(output) = &code.output {
            check_text("its command output", output, 16_384)?;
        }
    }
    Ok(())
}

/// Parses and checks a guide.
pub(crate) fn guide_from_value(value: Value) -> Result<GuideV1, Problem> {
    let mut guide: GuideV1 =
        serde_json::from_value(value).map_err(|error| format!("guide.json: {error}"))?;
    if let Some(translations) = &guide.translations {
        guide.translations = Some(
            clean_translations(translations, GUIDE_TEXT)
                .map_err(|problem| format!("guide.json {problem}"))?,
        );
    }
    if !is_safe_segment(&guide.id) {
        return Err("guide.json has an invalid id".to_string());
    }
    check_guide_limits(&guide).map_err(|problem| format!("guide.json: {problem}"))?;
    for (name, rich) in [("intro", &guide.intro), ("outro", &guide.outro)] {
        if let Some(rich) = rich {
            check_rich(rich).map_err(|problem| format!("the guide {name} {problem}"))?;
        }
    }
    Ok(guide)
}

/// Parses and checks a step.
pub(crate) fn step_from_value(value: Value) -> Result<StepV1, Problem> {
    let mut step: StepV1 =
        serde_json::from_value(value).map_err(|error| format!("a step: {error}"))?;
    if !is_safe_segment(&step.id) {
        return Err("a step has an invalid id".to_string());
    }
    let label = format!("step {}", step.id);
    if let Some(translations) = &step.translations {
        step.translations = Some(
            clean_translations(translations, STEP_TEXT)
                .map_err(|problem| format!("{label} {problem}"))?,
        );
    }
    check_step_limits(&step).map_err(|problem| format!("{label} {problem}"))?;
    let target_size = serde_json::to_vec(&step.target)
        .map_err(|error| format!("{label}: {error}"))?
        .len();
    if target_size > MAX_TARGET_BYTES {
        return Err(format!(
            "{label} has more than 64 KB of captured element details"
        ));
    }
    if let Some(id) = step.media.as_ref().and_then(|media| media.id.as_deref())
        && !is_safe_segment(id)
    {
        return Err(format!("{label} names an invalid image"));
    }
    if let Some(notes) = &step.notes {
        check_rich(notes).map_err(|problem| format!("{label} notes {problem}"))?;
    }
    if let Some(body) = step.block.as_ref().and_then(|block| block.body.as_ref()) {
        check_rich(body).map_err(|problem| format!("{label} text {problem}"))?;
    }
    Ok(step)
}

/// Checks a rich-text document's structure beyond what parsing already enforces.
fn check_rich(root: &RichNode) -> Result<(), Problem> {
    if root.node_type != NodeType::Doc {
        return Err("don't start with a document node".to_string());
    }
    check_node(root, true)
}

fn check_node(node: &RichNode, is_root: bool) -> Result<(), Problem> {
    if node.node_type == NodeType::Doc && !is_root {
        return Err("contain a nested document".to_string());
    }
    if node.node_type == NodeType::Text {
        if node.text.is_none() || node.content.is_some() {
            return Err("contain a text node without text".to_string());
        }
    } else if node.text.is_some() || node.marks.is_some() {
        return Err("put text or formatting on a non-text node".to_string());
    }
    if node.node_type == NodeType::Heading
        && !node
            .attrs
            .as_ref()
            .and_then(|attrs| attrs.level)
            .is_some_and(|level| (1..=3).contains(&level))
    {
        return Err("contain a heading without a level from 1 to 3".to_string());
    }
    if node
        .text
        .as_deref()
        .is_some_and(|text| too_long(text, 20_000))
    {
        return Err("contain a run of text longer than 20,000 characters".to_string());
    }
    if node.marks.as_ref().is_some_and(|marks| marks.len() > 10) {
        return Err("put more than 10 kinds of formatting on one run of text".to_string());
    }
    if node
        .content
        .as_ref()
        .is_some_and(|content| content.len() > 2_000)
    {
        return Err("put more than 2,000 items in one place".to_string());
    }
    for mark in node.marks.iter().flatten() {
        if let Mark::Link { attrs } = mark
            && (!safe_href(&attrs.href) || too_long(&attrs.href, 2_048))
        {
            return Err("contain a link that isn't http, https or mailto".to_string());
        }
    }
    // The editor only makes boxes of paragraphs and lists; one inside another is a crafted file.
    if node.node_type == NodeType::Callout
        && node
            .content
            .iter()
            .flatten()
            .any(|child| matches!(child.node_type, NodeType::Callout | NodeType::Heading))
    {
        return Err("put a box or heading inside a coloured box".to_string());
    }
    for child in node.content.iter().flatten() {
        check_node(child, false)?;
    }
    Ok(())
}

/// Links may only be web or email addresses: never `javascript:`, `file:` or `data:`.
pub(crate) fn safe_href(href: &str) -> bool {
    let lower = href.to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
        && !href.chars().any(char::is_control)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE_DIR: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../packages/core/test-vectors/guide-v1"
    );

    pub(crate) fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(FIXTURE_DIR).join(name);
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap()
    }

    pub(crate) fn fixture_steps() -> Vec<Value> {
        let steps = std::path::Path::new(FIXTURE_DIR).join("steps");
        let mut names: Vec<_> = std::fs::read_dir(steps)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
            .iter()
            .map(|name| fixture(&format!("steps/{name}")))
            .collect()
    }

    #[test]
    fn the_shared_fixture_parses_and_round_trips_unchanged() {
        let guide = fixture("guide.json");
        let typed = guide_from_value(guide.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), guide);
        let steps = fixture_steps();
        assert_eq!(steps.len(), 2);
        for step in steps {
            let typed = step_from_value(step.clone()).unwrap();
            assert_eq!(serde_json::to_value(&typed).unwrap(), step);
        }
    }

    #[test]
    fn a_code_step_round_trips_and_its_limits_hold() {
        let mut step = fixture_steps().remove(1);
        step["action"] = json!("command");
        step["code"] = json!({
            "text": "Get-Mailbox -Identity sales",
            "language": "powershell",
            "output": "Name  Alias\nsales sales",
            "outputShortened": false
        });
        let typed = step_from_value(step.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), step);

        let mut unknown = step.clone();
        unknown["code"]["language"] = json!("cobol");
        let typed = serde_json::to_value(step_from_value(unknown).unwrap()).unwrap();
        assert_eq!(
            typed["code"]["language"], "plain",
            "read as the UI reads it"
        );

        let mut long = step.clone();
        long["code"]["text"] = json!("x".repeat(20_001));
        assert!(step_from_value(long).unwrap_err().contains("its code"));
        let mut long_output = step;
        long_output["code"]["output"] = json!("y".repeat(16_385));
        assert!(
            step_from_value(long_output)
                .unwrap_err()
                .contains("command output")
        );
    }

    #[test]
    fn a_marks_colour_round_trips_and_the_accent_isnt_stored() {
        let mut step = fixture_steps().remove(1);
        step["annotations"] = json!([
            { "type": "arrow", "from": [1, 2], "to": [3, 4], "colour": "red" },
            { "type": "box", "x": 1, "y": 2, "w": 3, "h": 4 },
            { "type": "label", "x": 1, "y": 2, "text": "Here", "colour": "white" }
        ]);
        let typed = step_from_value(step.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), step);
        // A colour from a newer version is read as the accent, as the UI reads it.
        step["annotations"][0]["colour"] = json!("purple");
        let typed = serde_json::to_value(step_from_value(step).unwrap()).unwrap();
        assert!(typed["annotations"][0].get("colour").is_none());
    }

    #[test]
    fn coloured_boxes_round_trip_in_notes_and_as_blocks() {
        let mut step = fixture_steps().remove(0);
        step["notes"] = json!({ "type": "doc", "content": [
            { "type": "callout", "attrs": { "kind": "warning" }, "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Save first." }] }
            ] }
        ] });
        let typed = step_from_value(step.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), step);

        // A kind from a newer version reads as a note; a box in a box is refused.
        let mut newer = step.clone();
        newer["notes"]["content"][0]["attrs"]["kind"] = json!("danger");
        let typed = serde_json::to_value(step_from_value(newer).unwrap()).unwrap();
        assert_eq!(typed["notes"]["content"][0]["attrs"]["kind"], "note");
        let mut nested = step;
        nested["notes"]["content"][0]["content"] = json!([
            { "type": "callout", "attrs": { "kind": "tip" }, "content": [] }
        ]);
        assert!(
            step_from_value(nested)
                .unwrap_err()
                .contains("coloured box")
        );
    }

    #[test]
    fn languages_and_translations_round_trip_checked() {
        let mut guide = fixture("guide.json");
        guide["language"] = json!("de");
        guide["tone"] = json!("formal");
        guide["translations"] = json!({
            "fr": { "title": "Ajouter", "intro": null, "unknown": "dropped" },
            "pt-BR": { "description": "Adicionar" }
        });
        let typed = serde_json::to_value(guide_from_value(guide.clone()).unwrap()).unwrap();
        assert_eq!(typed["language"], "de");
        assert_eq!(typed["tone"], "formal");
        assert_eq!(
            typed["translations"],
            json!({ "fr": { "title": "Ajouter", "intro": null }, "pt-BR": { "description": "Adicionar" } })
        );
        // A tone from a newer version is dropped, not fatal.
        guide["tone"] = json!("poetic");
        assert!(
            serde_json::to_value(guide_from_value(guide.clone()).unwrap()).unwrap()["tone"]
                .is_null()
        );
        guide["language"] = json!("../x");
        assert!(guide_from_value(guide.clone()).is_err());

        let mut step = fixture_steps().remove(0);
        step["translations"] = json!({
            "sr-Latn": {
                "actionText": "Kliknite",
                "altText": null,
                "notes": { "type": "doc", "content": [{ "type": "paragraph", "content": [
                    { "type": "text", "text": "Napomena" }
                ] }] }
            }
        });
        let typed = serde_json::to_value(step_from_value(step.clone()).unwrap()).unwrap();
        assert_eq!(typed["translations"]["sr-Latn"]["actionText"], "Kliknite");
        assert!(typed["translations"]["sr-Latn"]["altText"].is_null());
        // Rich text in a translation goes through the same allow-list.
        step["translations"]["sr-Latn"]["notes"]["content"][0] =
            json!({ "type": "image", "attrs": { "src": "x" } });
        assert!(step_from_value(step.clone()).is_err());
        step["translations"] = json!({ "de": { "actionText": "x".repeat(2_001) } });
        assert!(step_from_value(step.clone()).is_err());
        step["translations"] = json!({ "javascript:x": {} });
        assert!(step_from_value(step).is_err());
    }

    #[test]
    fn unknown_fields_are_dropped() {
        let mut guide = fixture("guide.json");
        guide["surprise"] = json!("<script>");
        guide["stepCount"] = json!(3);
        let typed = serde_json::to_value(guide_from_value(guide).unwrap()).unwrap();
        assert!(typed.get("surprise").is_none());
        assert!(typed.get("stepCount").is_none());
        let mut step = fixture_steps().remove(0);
        step["context"]["url"] = json!("https://example.com/secret?q=1");
        step["notes"]["content"][0]["attrs"] = json!({ "textAlign": "left", "onclick": "x" });
        let typed = serde_json::to_value(step_from_value(step).unwrap()).unwrap();
        assert!(typed["context"].get("url").is_none());
        assert_eq!(typed["notes"]["content"][0]["attrs"], json!({}));
    }

    #[test]
    fn disallowed_rich_text_fails() {
        let base = fixture_steps().remove(0);
        let mut image = base.clone();
        image["notes"]["content"][0] = json!({ "type": "image", "attrs": { "src": "x" } });
        assert!(step_from_value(image).is_err());
        let mut underline = base.clone();
        underline["notes"]["content"][0]["content"][0]["marks"] = json!([{ "type": "underline" }]);
        assert!(step_from_value(underline).is_err());
        let mut script = base.clone();
        script["notes"]["content"][0]["content"][0]["marks"] =
            json!([{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }]);
        assert!(step_from_value(script).unwrap_err().contains("link"));
        let mut not_doc = base;
        not_doc["notes"] = json!({ "type": "paragraph" });
        assert!(step_from_value(not_doc).is_err());
    }

    #[test]
    fn oversized_targets_and_bad_ids_fail() {
        let base = fixture_steps().remove(0);
        let mut big = base.clone();
        big["target"] = json!({ "name": "x".repeat(MAX_TARGET_BYTES) });
        assert!(step_from_value(big).unwrap_err().contains("64 KB"));
        let mut bad_media = base.clone();
        bad_media["media"]["id"] = json!("../../evil");
        assert!(step_from_value(bad_media).is_err());
        let mut bad_id = base;
        bad_id["id"] = json!("a/b");
        assert!(step_from_value(bad_id).is_err());
    }

    #[test]
    fn the_ui_schema_limits_are_enforced() {
        let base = fixture_steps().remove(0);
        let cases = [
            ("/actionText", json!("x".repeat(2_001)), "wording"),
            ("/sortKey", json!("A1"), "sort key"),
            ("/altText", json!("x".repeat(2_001)), "alt text"),
            ("/context/app", json!("x".repeat(261)), "app name"),
        ];
        for (pointer, value, expected) in cases {
            let mut step = base.clone();
            *step.pointer_mut(pointer).unwrap() = value;
            assert!(
                step_from_value(step).unwrap_err().contains(expected),
                "{pointer}"
            );
        }
        let mut many = base.clone();
        many["redactions"] = json!(vec![
            json!({ "x": 1, "y": 1, "w": 1, "h": 1, "source": "manual" });
            501
        ]);
        assert!(step_from_value(many).unwrap_err().contains("500"));
        // Areas marked not personal are kept as they are, up to 200.
        let mut marked = base.clone();
        marked["notPersonal"] = json!([{ "x": 1.5, "y": 2, "w": 3, "h": 4 }]);
        let kept = serde_json::to_value(step_from_value(marked).unwrap()).unwrap();
        assert_eq!(
            kept["notPersonal"],
            json!([{ "x": 1.5, "y": 2, "w": 3, "h": 4 }])
        );
        assert!(
            serde_json::to_value(step_from_value(base.clone()).unwrap()).unwrap()["notPersonal"]
                .is_null()
        );
        let mut too_many = base.clone();
        too_many["notPersonal"] = json!(vec![json!({ "x": 1, "y": 1, "w": 1, "h": 1 }); 201]);
        assert!(step_from_value(too_many).unwrap_err().contains("200"));
        // Counted as the UI counts: 2,000 characters of accented text pass.
        let mut accented = base.clone();
        accented["actionText"] = json!("é".repeat(2_000));
        step_from_value(accented).unwrap();
        let mut heading = base;
        heading["notes"] = json!({ "type": "doc", "content": [
            { "type": "heading", "attrs": { "level": 4 }, "content": [{ "type": "text", "text": "x" }] }
        ] });
        assert!(step_from_value(heading).unwrap_err().contains("1 to 3"));
        let mut guide = fixture("guide.json");
        guide["title"] = json!("x".repeat(301));
        assert!(guide_from_value(guide).unwrap_err().contains("title"));
    }

    #[test]
    fn recorder_nulls_are_accepted() {
        let mut step = fixture_steps().remove(0);
        step["media"] = json!({ "id": null, "width": null, "height": null, "scale": null, "captureRect": null });
        step_from_value(step).unwrap();
    }

    #[test]
    fn hrefs_are_limited_to_web_and_email() {
        assert!(safe_href("https://amluto.com"));
        assert!(safe_href("HTTP://x"));
        assert!(safe_href("mailto:a@b.c"));
        for bad in [
            "javascript:x",
            " javascript:x",
            "file:///c:/x",
            "data:text/html,x",
            "https://x\n",
        ] {
            assert!(!safe_href(bad), "{bad}");
        }
    }
}
