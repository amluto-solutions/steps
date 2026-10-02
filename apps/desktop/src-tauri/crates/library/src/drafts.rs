//! Unsynced drafts (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive): when
//! someone takes over a guide, the displaced editor's unsaved work is kept in the guide's
//! `drafts\` folder instead of being written over theirs. Anyone who opens the guide sees it, and
//! opens it as a copy or discards it: nothing disappears silently.

use std::fs;

use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{LibraryError, Result};
use crate::guides::{GuideSummary, Library};
use crate::util::{checked, now_iso, read_json, write_json_atomic};

/// A draft as the guide lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub id: String,
    /// Who was editing.
    pub by: String,
    /// When their work was kept (ISO 8601).
    pub at: String,
    pub step_count: usize,
}

impl Library {
    fn drafts_dir(&self, guide_id: &str) -> Result<std::path::PathBuf> {
        Ok(self.guide_dir(guide_id)?.join("drafts"))
    }

    /// Keeps a displaced editor's whole guide (`guide` and `steps`) as a draft named by their
    /// session, replacing an earlier draft of the same session.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for a draft without a guide or steps, `Storage`.
    pub fn save_draft(&self, guide_id: &str, session: &str, by: &str, draft: &Value) -> Result<()> {
        let session = checked(session, "draft")?;
        let (Some(guide), Some(steps)) = (draft.get("guide"), draft.get("steps")) else {
            return Err(LibraryError::Invalid(
                "A draft needs the guide and its steps.".to_string(),
            ));
        };
        if !guide.is_object() || !steps.is_array() {
            return Err(LibraryError::Invalid(
                "A draft needs the guide and its steps.".to_string(),
            ));
        }
        let folder = self.drafts_dir(guide_id)?;
        fs::create_dir_all(&folder)?;
        write_json_atomic(
            &folder.join(format!("{session}.json")),
            &json!({ "id": session, "by": by, "at": now_iso(), "guide": guide, "steps": steps }),
        )
    }

    /// The guide's drafts, oldest first. Unreadable files (half-synced) are skipped.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn list_drafts(&self, guide_id: &str) -> Result<Vec<DraftInfo>> {
        let folder = self.drafts_dir(guide_id)?;
        let Ok(entries) = fs::read_dir(&folder) else {
            return Ok(Vec::new());
        };
        let mut drafts: Vec<DraftInfo> = entries
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .filter_map(|entry| read_json(&entry.path()).ok())
            .filter_map(|draft| {
                Some(DraftInfo {
                    id: draft.get("id")?.as_str()?.to_string(),
                    by: draft.get("by")?.as_str()?.to_string(),
                    at: draft.get("at")?.as_str()?.to_string(),
                    step_count: draft.get("steps")?.as_array()?.len(),
                })
            })
            .collect();
        drafts.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
        Ok(drafts)
    }

    /// Deletes a draft; one already gone is fine.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn discard_draft(&self, guide_id: &str, draft_id: &str) -> Result<()> {
        let path = self
            .drafts_dir(guide_id)?
            .join(format!("{}.json", checked(draft_id, "draft")?));
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Opens a draft as a new guide beside the original, titled `title`: a duplicate (so the
    /// screenshots come too) with the draft's wording and steps. The draft is then removed.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for a bad title or draft, `Storage`.
    pub fn draft_to_copy(
        &self,
        guide_id: &str,
        draft_id: &str,
        title: &str,
    ) -> Result<GuideSummary> {
        let path = self
            .drafts_dir(guide_id)?
            .join(format!("{}.json", checked(draft_id, "draft")?));
        let draft = read_json(&path)?;
        let copy = self.duplicate_guide(guide_id, title)?;
        let folder = self.guide_dir(&copy.id)?;
        let mut guide = draft.get("guide").cloned().unwrap_or(Value::Null);
        if let Some(fields) = guide.as_object_mut() {
            let original = crate::util::read_json(&folder.join("guide.json"))?;
            // The copy keeps its own identity; the draft brings the wording.
            for key in [
                "id",
                "title",
                "createdAt",
                "createdBy",
                "recordingSessionId",
            ] {
                match original.get(key) {
                    Some(value) => fields.insert(key.to_string(), value.clone()),
                    None => fields.remove(key),
                };
            }
            fields.insert("updatedAt".to_string(), Value::String(now_iso()));
        } else {
            return Err(LibraryError::Invalid("The draft has no guide.".to_string()));
        }
        self.save_guide(&copy.id, &guide)?;
        let steps = folder.join("steps");
        for entry in fs::read_dir(&steps)?.filter_map(std::result::Result::ok) {
            fs::remove_file(entry.path())?;
        }
        for step in draft
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            self.save_step(&copy.id, step)?;
        }
        fs::remove_file(&path)?;
        self.summary(&copy.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, text: &str) -> Value {
        json!({
            "id": id, "sortKey": "a0", "kind": "step", "action": "click", "actionText": text,
            "textEdited": false, "notes": null, "altText": "", "media": null, "highlight": null,
            "annotations": [], "redactions": [], "crop": null, "zoom": null, "showValue": false,
            "textParts": {}, "context": {}, "target": null, "block": null, "code": null,
            "createdAt": "2026-09-29T10:00:00Z", "createdBy": "Robin",
            "updatedAt": "2026-09-29T10:00:00Z", "updatedBy": "Robin", "formatVersion": 1
        })
    }

    #[test]
    fn a_displaced_editors_work_is_kept_and_opens_as_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let doc = library.create_guide("Payroll run", "Robin").unwrap();
        let id = doc.guide["id"].as_str().unwrap().to_string();
        library
            .save_step(&id, &step("s1", "Click \"Run\""))
            .unwrap();

        let mut theirs = doc.guide.clone();
        theirs["description"] = json!("Robin's unsaved wording");
        let draft = json!({ "guide": theirs, "steps": [step("s1", "Click \"Run payroll\""), step("s2", "Click \"Send\"")] });
        library
            .save_draft(&id, "session-a", "Robin", &draft)
            .unwrap();

        let drafts = library.list_drafts(&id).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].by, "Robin");
        assert_eq!(drafts[0].step_count, 2);

        let copy = library
            .draft_to_copy(&id, "session-a", "Payroll run (Robin's changes)")
            .unwrap();
        assert_ne!(copy.id, id);
        let opened = library.load_guide(&copy.id).unwrap();
        assert_eq!(opened.guide["title"], "Payroll run (Robin's changes)");
        assert_eq!(opened.guide["description"], "Robin's unsaved wording");
        assert_eq!(opened.guide["id"], json!(copy.id));
        assert_eq!(opened.steps.len(), 2);
        assert!(library.list_drafts(&id).unwrap().is_empty());
        // The original is untouched.
        assert_eq!(library.load_guide(&id).unwrap().steps.len(), 1);
    }

    #[test]
    fn a_draft_can_be_discarded_and_bad_ones_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let doc = library.create_guide("Guide", "Robin").unwrap();
        let id = doc.guide["id"].as_str().unwrap().to_string();
        assert!(library.save_draft(&id, "s", "Robin", &json!({})).is_err());
        assert!(
            library
                .save_draft(
                    &id,
                    "../escape",
                    "Robin",
                    &json!({ "guide": {}, "steps": [] })
                )
                .is_err()
        );
        library
            .save_draft(
                &id,
                "s",
                "Robin",
                &json!({ "guide": doc.guide, "steps": [] }),
            )
            .unwrap();
        library.discard_draft(&id, "s").unwrap();
        library.discard_draft(&id, "s").unwrap();
        assert!(library.list_drafts(&id).unwrap().is_empty());
    }
}
