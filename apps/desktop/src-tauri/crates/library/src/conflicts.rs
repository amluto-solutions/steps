//! When two people edited a guide anyway (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive):
//! a sync client's conflict copies, and a step one person deleted while another edited it. Both
//! are found here and shown to someone to decide; neither is ever dropped silently.
//!
//! - **Conflict copies.** `OneDrive` keeps both versions of a file changed on two PCs, naming one
//!   after the other PC (`abc-DESKTOP-1.json`, `guide-DESKTOP-1.json`). A step file whose name
//!   isn't its id, or a `guide-*.json` beside `guide.json`, is one.
//! - **Delete against edit.** Deleting a step leaves a small note in `deleted\` (who, which
//!   session). If the step file comes back (someone else edited it before the delete reached
//!   them), the step is restored and flagged, to keep or delete.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{LibraryError, Result};
use crate::guides::{Library, read_steps};
use crate::util::{checked, is_safe_segment, now_iso, read_json, write_json_atomic};

/// Something for a person to decide about.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum Conflict {
    /// Two versions of one step: the one in the guide, and the sync client's copy.
    Step {
        /// The conflict copy's file name in `steps\`.
        file: String,
        /// The step's id.
        id: String,
        /// Where the copy came from: the part of its name after the id (usually a PC name).
        from: String,
        ours: Value,
        theirs: Value,
    },
    /// Two versions of `guide.json`.
    Guide {
        file: String,
        from: String,
        ours: Value,
        theirs: Value,
    },
    /// A step someone deleted that came back because someone else edited it.
    Restored {
        id: String,
        deleted_by: String,
        step: Value,
    },
}

/// What to do with a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    /// Keep the version in the guide (a restored step: delete it after all).
    KeepOurs,
    /// Use the other version (a restored step: keep it).
    KeepTheirs,
    /// Keep both steps, the other one right after (steps only).
    KeepBoth,
}

/// The delete note in `deleted\<step id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteNote {
    by: String,
    session: String,
    at: String,
}

impl Library {
    /// Leaves a delete note for a step this session deleted.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn note_delete(
        &self,
        guide_id: &str,
        step_id: &str,
        by: &str,
        session: &str,
    ) -> Result<()> {
        let folder = self.guide_dir(guide_id)?.join("deleted");
        fs::create_dir_all(&folder)?;
        write_json_atomic(
            &folder.join(format!("{}.json", checked(step_id, "step")?)),
            &DeleteNote {
                by: by.to_string(),
                session: session.to_string(),
                at: now_iso(),
            },
        )
    }

    /// Forgets this session's own delete note when the step is saved again (Undo): only a step
    /// someone *else* brings back counts as restored.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Storage`.
    pub fn forget_own_delete(&self, guide_id: &str, step_id: &str, session: &str) -> Result<()> {
        let path = self
            .guide_dir(guide_id)?
            .join("deleted")
            .join(format!("{}.json", checked(step_id, "step")?));
        let ours = read_json(&path)
            .ok()
            .and_then(|note| serde_json::from_value::<DeleteNote>(note).ok())
            .is_some_and(|note| note.session == session);
        if ours {
            remove_if_there(&path)?;
        }
        Ok(())
    }

    /// Everything in the guide someone needs to decide about.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn list_conflicts(&self, guide_id: &str) -> Result<Vec<Conflict>> {
        let folder = self.guide_dir(guide_id)?;
        let mut found = Vec::new();

        let steps: Vec<Value> = read_steps(&folder.join("steps"));
        let step_by_id = |id: &str| {
            steps
                .iter()
                .find(|step| step.get("id").and_then(Value::as_str) == Some(id))
        };

        // Conflict copies of steps.
        for (file, theirs) in json_files(&folder.join("steps")) {
            let Some(id) = theirs.get("id").and_then(Value::as_str) else {
                continue;
            };
            let stem = file.trim_end_matches(".json");
            if stem == id || !is_safe_segment(id) {
                continue;
            }
            // The version in the guide; a copy of a step whose own file is gone is the step.
            let Some(ours) = step_by_id(id) else { continue };
            found.push(Conflict::Step {
                from: stem
                    .strip_prefix(id)
                    .unwrap_or(stem)
                    .trim_start_matches(['-', ' '])
                    .to_string(),
                file: file.clone(),
                id: id.to_string(),
                ours: ours.clone(),
                theirs,
            });
        }

        // Conflict copies of guide.json.
        if let Ok(ours) = read_json(&folder.join("guide.json")) {
            for (file, theirs) in json_files(&folder) {
                let stem = file.trim_end_matches(".json");
                if file == "guide.json" || !stem.starts_with("guide") {
                    continue;
                }
                if theirs.get("id") != ours.get("id") {
                    continue;
                }
                found.push(Conflict::Guide {
                    from: stem
                        .trim_start_matches("guide")
                        .trim_start_matches(['-', ' '])
                        .to_string(),
                    file,
                    ours: ours.clone(),
                    theirs,
                });
            }
        }

        // Steps deleted by one person and brought back by another's edit.
        for (file, note) in json_files(&folder.join("deleted")) {
            let id = file.trim_end_matches(".json");
            let (Some(step), Ok(note)) =
                (step_by_id(id), serde_json::from_value::<DeleteNote>(note))
            else {
                continue;
            };
            found.push(Conflict::Restored {
                id: id.to_string(),
                deleted_by: note.by,
                step: step.clone(),
            });
        }
        Ok(found)
    }

    /// Settles one conflict, named by its file (`Step`, `Guide`) or step id (`Restored`) as
    /// `list_conflicts` gave it. It is looked up in a fresh listing, so only a file the listing
    /// found can be touched; one already settled (on another PC, say) is nothing to do.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` for a choice that doesn't fit, `Storage`.
    pub fn resolve_conflict(
        &self,
        guide_id: &str,
        conflict: &str,
        choice: Resolution,
    ) -> Result<()> {
        let folder = self.guide_dir(guide_id)?;
        let Some(found) = self
            .list_conflicts(guide_id)?
            .into_iter()
            .find(|item| key_of(item) == conflict)
        else {
            return Ok(());
        };
        match found {
            Conflict::Restored { id, .. } => {
                // Keeping it forgets the delete; deleting it deletes it again.
                remove_if_there(&folder.join("deleted").join(format!("{id}.json")))?;
                if choice == Resolution::KeepOurs {
                    self.delete_step(guide_id, &id)?;
                }
            }
            Conflict::Step {
                file,
                ours,
                mut theirs,
                ..
            } => {
                match choice {
                    Resolution::KeepOurs => {}
                    Resolution::KeepTheirs => self.save_step(guide_id, &theirs)?,
                    Resolution::KeepBoth => {
                        let after = ours.get("sortKey").and_then(Value::as_str).unwrap_or("a0");
                        theirs["id"] = json!(crate::util::new_id());
                        // Straight after the version in the guide.
                        theirs["sortKey"] = json!(format!("{after}m"));
                        self.save_step(guide_id, &theirs)?;
                    }
                }
                remove_if_there(&folder.join("steps").join(file))?;
            }
            Conflict::Guide { file, theirs, .. } => {
                match choice {
                    Resolution::KeepOurs => {}
                    Resolution::KeepTheirs => self.save_guide(guide_id, &theirs)?,
                    Resolution::KeepBoth => {
                        return Err(LibraryError::Invalid(
                            "A guide's details can't be kept twice: choose one.".to_string(),
                        ));
                    }
                }
                remove_if_there(&folder.join(file))?;
            }
        }
        Ok(())
    }
}

/// How a conflict is named when settling it.
fn key_of(conflict: &Conflict) -> &str {
    match conflict {
        Conflict::Step { file, .. } | Conflict::Guide { file, .. } => file,
        Conflict::Restored { id, .. } => id,
    }
}

/// Every readable `*.json` file directly in `folder`, by file name, in name order.
fn json_files(folder: &Path) -> Vec<(String, Value)> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut files: Vec<(String, Value)> = entries
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            read_json(&entry.path()).ok().map(|value| (name, value))
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

fn remove_if_there(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, key: &str, text: &str, by: &str) -> Value {
        json!({
            "id": id, "sortKey": key, "kind": "interaction", "action": "click", "actionText": text,
            "textParts": { "verb": "click", "target": text, "kind": "button" }, "showValue": false,
            "textEdited": false, "notes": null, "altText": null,
            "context": { "app": null, "windowTitle": "" }, "target": null, "media": null,
            "highlight": null, "crop": null, "redactions": [], "annotations": [], "block": null,
            "capturedAt": "2026-09-29T10:00:00.000Z", "updatedAt": "2026-09-29T10:00:00.000Z",
            "updatedBy": by, "formatVersion": 1
        })
    }

    fn guide() -> (tempfile::TempDir, Library, String) {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let doc = library.create_guide("Shared", "Robin").unwrap();
        let id = doc.guide["id"].as_str().unwrap().to_string();
        (dir, library, id)
    }

    fn write_copy(library: &Library, id: &str, name: &str, value: &Value) {
        let path = library.guide_dir(id).unwrap().join("steps").join(name);
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    #[test]
    fn a_step_conflict_copy_is_found_and_each_choice_settles_it() {
        for (choice, expect) in [
            (Resolution::KeepOurs, vec!["Mine"]),
            (Resolution::KeepTheirs, vec!["Theirs"]),
            (Resolution::KeepBoth, vec!["Mine", "Theirs"]),
        ] {
            let (_dir, library, id) = guide();
            library
                .save_step(&id, &step("s1", "a0", "Mine", "Robin"))
                .unwrap();
            library
                .save_step(&id, &step("s2", "a1", "Next", "Robin"))
                .unwrap();
            write_copy(
                &library,
                &id,
                "s1-SAMS-PC.json",
                &step("s1", "a0", "Theirs", "Sam"),
            );

            let conflicts = library.list_conflicts(&id).unwrap();
            assert_eq!(conflicts.len(), 1);
            match &conflicts[0] {
                Conflict::Step {
                    file,
                    id: step_id,
                    from,
                    ours,
                    theirs,
                } => {
                    assert_eq!(file, "s1-SAMS-PC.json");
                    assert_eq!(step_id, "s1");
                    assert_eq!(from, "SAMS-PC");
                    assert_eq!(ours["actionText"], "Mine");
                    assert_eq!(theirs["actionText"], "Theirs");
                }
                other => panic!("expected a step conflict, got {other:?}"),
            }

            library
                .resolve_conflict(&id, "s1-SAMS-PC.json", choice)
                .unwrap();
            assert!(library.list_conflicts(&id).unwrap().is_empty());
            let texts: Vec<String> = library
                .load_guide(&id)
                .unwrap()
                .steps
                .iter()
                .map(|s| s["actionText"].as_str().unwrap().to_string())
                .filter(|text| text != "Next")
                .collect();
            assert_eq!(texts, expect, "{choice:?}");
            // Keeping both puts theirs straight after mine, before the next step.
            if choice == Resolution::KeepBoth {
                let order: Vec<String> = library
                    .load_guide(&id)
                    .unwrap()
                    .steps
                    .iter()
                    .map(|s| s["actionText"].as_str().unwrap().to_string())
                    .collect();
                assert_eq!(order, ["Mine", "Theirs", "Next"]);
            }
        }
    }

    #[test]
    fn a_guide_conflict_copy_keeps_one_version() {
        let (_dir, library, id) = guide();
        let folder = library.guide_dir(&id).unwrap();
        let mut theirs = read_json(&folder.join("guide.json")).unwrap();
        theirs["title"] = json!("Sam's title");
        fs::write(
            folder.join("guide-SAMS-PC.json"),
            serde_json::to_vec(&theirs).unwrap(),
        )
        .unwrap();
        let conflicts = library.list_conflicts(&id).unwrap();
        assert!(matches!(&conflicts[..], [Conflict::Guide { from, .. }] if from == "SAMS-PC"));
        assert!(
            library
                .resolve_conflict(&id, "guide-SAMS-PC.json", Resolution::KeepBoth)
                .is_err()
        );
        library
            .resolve_conflict(&id, "guide-SAMS-PC.json", Resolution::KeepTheirs)
            .unwrap();
        assert_eq!(
            library.load_guide(&id).unwrap().guide["title"],
            "Sam's title"
        );
        assert!(library.list_conflicts(&id).unwrap().is_empty());
    }

    #[test]
    fn a_step_deleted_by_one_and_edited_by_another_comes_back_flagged() {
        let (_dir, library, id) = guide();
        library
            .save_step(&id, &step("s1", "a0", "Click Run", "Robin"))
            .unwrap();
        // Robin deletes it...
        library.delete_step(&id, "s1").unwrap();
        library
            .note_delete(&id, "s1", "Robin", "robin-session")
            .unwrap();
        assert!(library.list_conflicts(&id).unwrap().is_empty());
        // ...and Sam's edit, made before the delete reached Sam, syncs back in.
        library
            .save_step(&id, &step("s1", "a0", "Click Run payroll", "Sam"))
            .unwrap();
        let conflicts = library.list_conflicts(&id).unwrap();
        assert!(matches!(
            &conflicts[..],
            [Conflict::Restored { id, deleted_by, step }]
                if id == "s1" && deleted_by == "Robin" && step["updatedBy"] == "Sam"
        ));
        // Keeping it forgets the delete.
        library
            .resolve_conflict(&id, "s1", Resolution::KeepTheirs)
            .unwrap();
        assert!(library.list_conflicts(&id).unwrap().is_empty());
        assert_eq!(library.load_guide(&id).unwrap().steps.len(), 1);
    }

    #[test]
    fn undoing_your_own_delete_is_not_a_conflict() {
        let (_dir, library, id) = guide();
        library
            .save_step(&id, &step("s1", "a0", "Click Run", "Robin"))
            .unwrap();
        library.delete_step(&id, "s1").unwrap();
        library
            .note_delete(&id, "s1", "Robin", "robin-session")
            .unwrap();
        // Undo saves it again in the same session.
        library
            .save_step(&id, &step("s1", "a0", "Click Run", "Robin"))
            .unwrap();
        library
            .forget_own_delete(&id, "s1", "robin-session")
            .unwrap();
        assert!(library.list_conflicts(&id).unwrap().is_empty());
        // Someone else's session doesn't clear it.
        library.delete_step(&id, "s1").unwrap();
        library
            .note_delete(&id, "s1", "Robin", "robin-session")
            .unwrap();
        library
            .save_step(&id, &step("s1", "a0", "Click Run", "Sam"))
            .unwrap();
        library.forget_own_delete(&id, "s1", "sam-session").unwrap();
        assert_eq!(library.list_conflicts(&id).unwrap().len(), 1);
    }

    #[test]
    fn the_window_gets_camel_case_names() {
        let restored = Conflict::Restored {
            id: "s1".into(),
            deleted_by: "Robin".into(),
            step: json!({}),
        };
        let value = serde_json::to_value(&restored).unwrap();
        assert_eq!(value["kind"], "restored");
        assert_eq!(value["deletedBy"], "Robin");
    }

    #[test]
    fn deleting_a_restored_step_again_removes_it() {
        let (_dir, library, id) = guide();
        library
            .save_step(&id, &step("s1", "a0", "Click Run", "Sam"))
            .unwrap();
        library
            .note_delete(&id, "s1", "Robin", "robin-session")
            .unwrap();
        library
            .resolve_conflict(&id, "s1", Resolution::KeepOurs)
            .unwrap();
        assert!(library.load_guide(&id).unwrap().steps.is_empty());
        assert!(library.list_conflicts(&id).unwrap().is_empty());
    }
}
