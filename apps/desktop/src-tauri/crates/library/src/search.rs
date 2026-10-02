//! Searching a library by what its guides say (docs/spec/04-editor.md#library-view): titles, tags
//! and owners, and also the description, intro, outro, step wording, notes and blocks, which the
//! list itself doesn't carry.
//!
//! A hidden typed value is taken out of the wording before it is searched, the same as every
//! export does, so a search can't reveal that a guide holds one.

use std::fs;

use serde::Serialize;
use serde_json::Value;

use crate::error::Result;
use crate::guides::{Library, read_steps};
use crate::typed_value::without_typed_value;
use crate::util::{is_safe_segment, read_json};

/// Longest snippet shown under a guide card, in characters.
const SNIPPET_CHARS: usize = 90;
/// Words past this many are ignored, so a pasted paragraph can't make a search slow.
const MAX_QUERY_WORDS: usize = 12;

/// A guide that matches a search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The guide's id.
    pub guide_id: String,
    /// Where the words were found, when the title, tags and owner alone don't explain the match.
    pub found_in: Option<FoundIn>,
}

/// The wording a search matched, for the line under the guide card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundIn {
    /// The step's number as the editor shows it; `None` for the description, intro, outro and
    /// blocks, which aren't numbered.
    pub step_number: Option<usize>,
    /// A short piece of the matching wording, cut at the edges with "…".
    pub snippet: String,
}

impl Library {
    /// The guides that contain every word of `query` (any case), anywhere in what they say.
    /// Unreadable guides and staging folders are skipped, as in the list.
    ///
    /// # Errors
    /// `Storage` if the `guides` folder itself can't be read.
    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>> {
        self.search_while(query, || true)
    }

    /// `search`, stopping early (with what it has) once `keep_going` says a newer search has
    /// replaced this one, so typing doesn't leave a queue of whole-library reads behind it.
    ///
    /// # Errors
    /// As `search`.
    pub fn search_while(
        &self,
        query: &str,
        keep_going: impl Fn() -> bool,
    ) -> Result<Vec<SearchHit>> {
        let words = query_words(query);
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for entry in fs::read_dir(self.guides_dir())? {
            if !keep_going() {
                break;
            }
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_safe_segment(&name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Some(hit) = self.search_guide(&name, &words) {
                hits.push(hit);
            }
        }
        Ok(hits)
    }

    fn search_guide(&self, guide_id: &str, words: &[String]) -> Option<SearchHit> {
        let folder = self.guide_dir(guide_id).ok()?;
        let text = SEARCH_TEXT
            .get(&folder, || searchable(&folder, guide_id).ok_or(()))
            .ok()?;
        let SearchText {
            card,
            passages,
            everything,
        } = &*text;
        if !words.iter().all(|word| everything.contains(word.as_str())) {
            return None;
        }
        // Words the card already shows need no explaining; the snippet is for the rest.
        let unexplained: Vec<&String> = words
            .iter()
            .filter(|word| !card.contains(word.as_str()))
            .collect();
        let found_in = unexplained.first().and_then(|word| {
            passages.iter().find_map(|passage| {
                snippet(&passage.text, word).map(|snippet| FoundIn {
                    step_number: passage.step_number,
                    snippet,
                })
            })
        });
        Some(SearchHit {
            guide_id: guide_id.to_string(),
            found_in,
        })
    }
}

/// What a search looks through in one guide, kept while its files are unchanged (see
/// `crate::cache`).
struct SearchText {
    /// The card's title, tags and owner, lower case.
    card: String,
    passages: Vec<Passage>,
    /// The card and every passage, lower case.
    everything: String,
}

static SEARCH_TEXT: crate::cache::GuideCache<SearchText> = crate::cache::GuideCache::new();

fn searchable(folder: &std::path::Path, guide_id: &str) -> Option<SearchText> {
    let guide = read_json(&folder.join("guide.json")).ok()?;
    if guide.get("id").and_then(Value::as_str) != Some(guide_id) {
        return None;
    }
    let card = fold(&card_text(&guide));
    let passages = passages(&guide, &read_steps(&folder.join("steps")));
    let everything = passages.iter().fold(card.clone(), |all, passage| {
        all + "\n" + &fold(&passage.text)
    });
    Some(SearchText {
        card,
        passages,
        everything,
    })
}

/// One piece of a guide's wording, and the step it belongs to.
struct Passage {
    step_number: Option<usize>,
    text: String,
}

/**
 * Text as a search compares it: lower case, and each letter without its accents, so "ubersicht"
 * finds "Übersicht" and "cafe" finds "Café" (01/10/2026). One character in, one out, so a
 * match's place in the folded text is its place in the original.
 */
pub(crate) fn fold(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.chars()
        .map(|character| {
            let lower = character.to_lowercase().next().unwrap_or(character);
            lower.nfd().next().unwrap_or(lower)
        })
        .collect()
}

/// The search words: folded (`fold`), at most `MAX_QUERY_WORDS`.
fn query_words(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .take(MAX_QUERY_WORDS)
        .map(fold)
        .collect()
}

/// What the guide card shows: title, tags and owner.
fn card_text(guide: &Value) -> String {
    let text = |field: &str| guide.get(field).and_then(Value::as_str).unwrap_or_default();
    let tags = guide
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    format!("{} {tags} {}", text("title"), text("owner"))
}

/// The guide's wording in reading order: description, intro, each step (wording, notes, block
/// heading and body), outro.
fn passages(guide: &Value, steps: &[Value]) -> Vec<Passage> {
    let mut out = Vec::new();
    let mut push = |step_number: Option<usize>, text: String| {
        if !text.trim().is_empty() {
            out.push(Passage { step_number, text });
        }
    };
    push(None, string(guide, "description"));
    push(None, rich_text(guide.get("intro")));
    let mut number = 0;
    for step in steps {
        if step.get("kind").and_then(Value::as_str) == Some("interaction") {
            number += 1;
            push(Some(number), visible_wording(step));
            push(Some(number), rich_text(step.get("notes")));
            // A command or formula is found by what it says, not its output.
            push(
                Some(number),
                step.pointer("/code/text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
        } else if let Some(block) = step.get("block") {
            push(None, string(block, "heading"));
            push(None, rich_text(block.get("body")));
        }
    }
    push(None, rich_text(guide.get("outro")));
    // The words written in other languages, after the main language's so a snippet prefers it
    // (docs/spec/04-editor.md#languages): a German search finds the German.
    for (_, words) in translations(guide) {
        push(None, string(words, "title"));
        push(None, string(words, "description"));
        push(None, rich_text(words.get("intro")));
        push(None, rich_text(words.get("outro")));
    }
    let mut number = 0;
    for step in steps {
        let interaction = step.get("kind").and_then(Value::as_str) == Some("interaction");
        if interaction {
            number += 1;
        }
        let step_number = interaction.then_some(number);
        for (_, words) in translations(step) {
            // A hidden typed value is left out of every language's wording, as of the main one.
            let mut translated = step.clone();
            translated["actionText"] = Value::String(string(words, "actionText"));
            push(step_number, visible_wording(&translated));
            push(step_number, rich_text(words.get("notes")));
            push(step_number, string(words, "heading"));
            push(step_number, rich_text(words.get("body")));
        }
    }
    out
}

/// A guide's or step's words in other languages, by language code in a fixed order.
fn translations(value: &Value) -> Vec<(&String, &Value)> {
    let mut found: Vec<(&String, &Value)> = value
        .get("translations")
        .and_then(Value::as_object)
        .map(|languages| languages.iter().collect())
        .unwrap_or_default();
    found.sort_by(|a, b| a.0.cmp(b.0));
    found
}

fn string(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A step's wording, with its typed value taken out unless "Show typed value" is on.
fn visible_wording(step: &Value) -> String {
    let wording = string(step, "actionText");
    let shown = step.get("showValue").and_then(Value::as_bool) == Some(true);
    match step.pointer("/textParts/value").and_then(Value::as_str) {
        Some(value) if !shown => without_typed_value(&wording, value),
        _ => wording,
    }
}

/// The plain text of a rich-text (`TipTap` JSON) value.
fn rich_text(value: Option<&Value>) -> String {
    fn collect(value: &Value, out: &mut Vec<String>) {
        if let Some(text) = value.get("text").and_then(Value::as_str) {
            out.push(text.to_string());
        }
        if let Some(children) = value.get("content").and_then(Value::as_array) {
            for child in children {
                collect(child, out);
            }
        }
    }
    let mut parts = Vec::new();
    if let Some(value) = value {
        collect(value, &mut parts);
    }
    parts.join(" ")
}

/// Up to `SNIPPET_CHARS` of `text` around the first `word` (lower case), or `None` if it isn't
/// there.
fn snippet(text: &str, word: &str) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = fold(&flat);
    let at = lower.find(word)?;
    let chars: Vec<char> = flat.chars().collect();
    // Character position of the match (lower-casing can change byte lengths, not usually counts).
    let centre = lower[..at].chars().count().min(chars.len());
    if chars.len() <= SNIPPET_CHARS {
        return Some(flat);
    }
    let start = centre.saturating_sub(SNIPPET_CHARS / 3);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let start = end.saturating_sub(SNIPPET_CHARS);
    let mut out: String = chars[start..end].iter().collect();
    out = out.trim().to_string();
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn step(id: &str, sort: &str, text: &str) -> Value {
        json!({
            "id": id, "sortKey": sort, "kind": "interaction", "action": "click",
            "actionText": text, "textParts": { "verb": "Click", "target": "", "kind": "" },
            "showValue": false, "textEdited": false, "notes": null
        })
    }

    fn library_with(guides: &[(&str, &str, Vec<Value>)]) -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        for (id, title, steps) in guides {
            let folder = dir.path().join("guides").join(id);
            fs::create_dir_all(folder.join("steps")).unwrap();
            fs::write(
                folder.join("guide.json"),
                json!({ "id": id, "title": title, "tags": ["Finance"], "owner": "Sam",
                        "description": "", "intro": null, "outro": null })
                .to_string(),
            )
            .unwrap();
            for step in steps {
                let name = format!("{}.json", step["id"].as_str().unwrap());
                fs::write(folder.join("steps").join(name), step.to_string()).unwrap();
            }
        }
        (dir, library)
    }

    #[test]
    fn finds_guides_by_step_wording_and_says_which_step() {
        let (_dir, library) = library_with(&[
            (
                "g1",
                "Add a supplier",
                vec![
                    step("s1", "a", "Click New"),
                    step("s2", "b", "Click Save invoice"),
                ],
            ),
            ("g2", "Book a room", vec![step("s3", "a", "Click Rooms")]),
        ]);
        let hits = library.search("invoice").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].guide_id, "g1");
        let found = hits[0].found_in.as_ref().unwrap();
        assert_eq!(found.step_number, Some(2));
        assert_eq!(found.snippet, "Click Save invoice");
    }

    #[test]
    fn every_word_must_appear_somewhere_and_card_matches_need_no_snippet() {
        let (_dir, library) =
            library_with(&[("g1", "Add a supplier", vec![step("s1", "a", "Click Save")])]);
        assert_eq!(library.search("supplier save").unwrap().len(), 1);
        assert!(library.search("supplier delete").unwrap().is_empty());
        let by_title = library.search("SUPPLIER finance").unwrap();
        assert_eq!(by_title.len(), 1);
        assert_eq!(by_title[0].found_in, None);
        assert!(library.search("   ").unwrap().is_empty());
    }

    #[test]
    fn a_replaced_search_stops_and_an_edit_is_seen_by_the_next_one() {
        let (_dir, library) =
            library_with(&[("g1", "Add a supplier", vec![step("s1", "a", "Click Save")])]);
        assert!(library.search_while("save", || false).unwrap().is_empty());
        assert_eq!(library.search("save").unwrap().len(), 1);
        // The cached wording is dropped once a step file changes.
        let path = library.guides_dir().join("g1/steps/s1.json");
        let mut edited = step("s1", "a", "Click Submit");
        edited["updatedBy"] = json!("someone else");
        fs::write(&path, serde_json::to_vec(&edited).unwrap()).unwrap();
        assert!(library.search("save").unwrap().is_empty());
        assert_eq!(library.search("submit").unwrap().len(), 1);
    }

    #[test]
    fn a_hidden_typed_value_is_never_searched() {
        let mut hidden = step("s1", "a", "Type \"Acme Ltd\" in Customer");
        hidden["textParts"]["value"] = json!("acme ltd");
        let mut shown = step("s2", "b", "Type \"Bravo plc\" in Customer");
        shown["textParts"]["value"] = json!("Bravo plc");
        shown["showValue"] = json!(true);
        let (_dir, library) = library_with(&[("g1", "Customers", vec![hidden, shown])]);
        assert!(library.search("acme").unwrap().is_empty());
        assert_eq!(library.search("bravo").unwrap().len(), 1);
    }

    #[test]
    fn notes_and_blocks_are_searched() {
        let mut noted = step("s1", "a", "Click Save");
        noted["notes"] = json!({ "type": "doc", "content": [{ "type": "paragraph",
            "content": [{ "type": "text", "text": "Ask finance before approving" }] }] });
        let block = json!({ "id": "b1", "sortKey": "b", "kind": "block", "action": "",
            "actionText": "", "block": { "type": "tip", "heading": "Quarter end",
            "body": null } });
        let (_dir, library) = library_with(&[("g1", "Invoices", vec![noted, block])]);
        let approving = library.search("approving").unwrap();
        assert_eq!(approving[0].found_in.as_ref().unwrap().step_number, Some(1));
        let quarter = library.search("quarter").unwrap();
        assert_eq!(quarter[0].found_in.as_ref().unwrap().step_number, None);
    }

    #[test]
    fn words_in_other_languages_are_searched_without_a_hidden_value() {
        let mut german = step("s1", "a", "Type \"Acme Ltd\" in Customer");
        german["textParts"]["value"] = json!("Acme Ltd");
        german["translations"] = json!({ "de": {
            "actionText": "„Acme Ltd“ in Kunde eingeben",
            "notes": { "type": "doc", "content": [{ "type": "paragraph",
                "content": [{ "type": "text", "text": "Vorher die Buchhaltung fragen" }] }] }
        } });
        let (dir, library) = library_with(&[("g1", "Customers", vec![german])]);
        let path = dir.path().join("guides/g1/guide.json");
        let mut guide: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        guide["translations"] = json!({ "de": { "title": "Kunden anlegen" } });
        fs::write(&path, guide.to_string()).unwrap();

        let title = library.search("kunden").unwrap();
        assert_eq!(
            title[0].found_in.as_ref().unwrap().snippet,
            "Kunden anlegen"
        );
        let notes = library.search("buchhaltung").unwrap();
        assert_eq!(notes[0].found_in.as_ref().unwrap().step_number, Some(1));
        assert_eq!(library.search("eingeben").unwrap().len(), 1);
        assert!(library.search("acme").unwrap().is_empty());
    }

    #[test]
    fn accents_and_case_are_ignored_and_any_part_of_a_word_matches() {
        let (_dir, library) = library_with(&[(
            "g1",
            "Übersicht der Rechnungen",
            vec![step("s1", "a", "Click \"Café menu\"")],
        )]);
        assert_eq!(library.search("ubersicht").unwrap().len(), 1);
        assert_eq!(library.search("CAFE").unwrap().len(), 1);
        assert_eq!(library.search("rechnung").unwrap().len(), 1);
        let found = library.search("cafe").unwrap();
        assert_eq!(
            found[0].found_in.as_ref().unwrap().snippet,
            "Click \"Café menu\""
        );
    }

    #[test]
    fn long_wording_is_cut_around_the_match() {
        let long = format!("{} needle {}", "word ".repeat(40), "tail ".repeat(40));
        let cut = snippet(&long, "needle").unwrap();
        assert!(cut.starts_with('…') && cut.ends_with('…'));
        assert!(cut.contains("needle"));
        assert!(cut.chars().count() <= SNIPPET_CHARS + 2);
    }
}
