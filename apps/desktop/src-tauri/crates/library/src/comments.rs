//! Review comments (docs/spec/04-editor.md#review-comments): threads on a step or on the whole
//! guide, with replies, resolved and reopened. Internal only, never exported.
//!
//! Every action is its own file in `comments\`, written once and never changed: a comment, a
//! reply, a resolve, a reopen. Two people commenting on the same step at once, or both resolving
//! a thread, write different files, so a sync client never has two versions of one file to make a
//! conflict copy of. A thread's state is its latest resolve or reopen. Comments don't need the
//! edit lock, so anyone can comment while someone else edits.

use std::fs;

use serde::{Deserialize, Serialize};

use crate::error::{LibraryError, Result};
use crate::guides::Library;
use crate::util::{checked, is_safe_segment, new_id, now_iso, read_json, write_json_new};

/// The longest comment, in characters: a review note, not a document.
pub const MAX_COMMENT: usize = 5_000;

/// What one file in `comments\` records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    Comment,
    Resolve,
    Reopen,
}

/// One file in `comments\`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    format_version: u32,
    id: String,
    action: Action,
    /// The thread's first comment, for a reply, resolve or reopen; `None` starts a thread.
    #[serde(default)]
    thread: Option<String>,
    /// The step a thread is about; `None` is the whole guide. Only on a thread's first comment.
    #[serde(default)]
    step_id: Option<String>,
    #[serde(default)]
    text: String,
    by: String,
    /// The PC it was written on: with `by`, what makes a comment yours to delete.
    #[serde(default)]
    pc: String,
    at: String,
}

/// Who is commenting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commenter {
    pub name: String,
    pub pc: String,
}

impl Entry {
    fn is_by(&self, who: &Commenter) -> bool {
        self.by == who.name && self.pc == who.pc
    }
}

/// A comment as the window shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub text: String,
    pub by: String,
    pub at: String,
    /// Written by this person on this PC, so they may delete it.
    pub mine: bool,
}

/// Who resolved a thread, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub by: String,
    pub at: String,
}

/// A thread: its first comment, the replies in order, and whether it's resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentThread {
    #[serde(flatten)]
    pub first: Comment,
    pub step_id: Option<String>,
    pub replies: Vec<Comment>,
    pub resolved: Option<Resolved>,
}

/// Every readable entry in a guide's `comments\` folder.
fn read_entries(folder: &std::path::Path) -> Vec<Entry> {
    let Ok(files) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut entries: Vec<Entry> = files
        .filter_map(std::result::Result::ok)
        .filter_map(|file| {
            let name = file.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            let entry: Entry = serde_json::from_value(read_json(&file.path()).ok()?).ok()?;
            // A file whose name isn't its id is a stray copy; its id's own file is the one.
            (entry.id == id).then_some(entry)
        })
        .collect();
    // Clocks on different PCs may disagree, so ties and near-ties only need to be stable.
    entries.sort_by(|left, right| left.at.cmp(&right.at).then_with(|| left.id.cmp(&right.id)));
    entries
}

fn as_comment(entry: &Entry, who: &Commenter) -> Comment {
    Comment {
        id: entry.id.clone(),
        text: entry.text.clone(),
        by: entry.by.clone(),
        at: entry.at.clone(),
        mine: entry.is_by(who),
    }
}

/// Builds the threads from a folder's entries, oldest first. Replies and resolutions whose
/// thread has gone (its first comment deleted on another PC) are left out.
fn threads(entries: &[Entry], who: &Commenter) -> Vec<CommentThread> {
    let mut result: Vec<CommentThread> = entries
        .iter()
        .filter(|entry| entry.action == Action::Comment && entry.thread.is_none())
        .map(|entry| CommentThread {
            first: as_comment(entry, who),
            step_id: entry.step_id.clone(),
            replies: Vec::new(),
            resolved: None,
        })
        .collect();
    for entry in entries {
        let Some(thread) = entry.thread.as_deref() else {
            continue;
        };
        let Some(found) = result.iter_mut().find(|found| found.first.id == thread) else {
            continue;
        };
        match entry.action {
            Action::Comment => found.replies.push(as_comment(entry, who)),
            Action::Resolve => {
                found.resolved = Some(Resolved {
                    by: entry.by.clone(),
                    at: entry.at.clone(),
                });
            }
            Action::Reopen => found.resolved = None,
        }
    }
    result
}

impl Library {
    /// The guide's comment threads, oldest first.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`.
    pub fn list_comments(&self, guide_id: &str, who: &Commenter) -> Result<Vec<CommentThread>> {
        let folder = self.guide_dir(guide_id)?.join("comments");
        Ok(threads(&read_entries(&folder), who))
    }

    /// How many of the guide's threads are open, for its card.
    pub(crate) fn open_comment_count(folder: &std::path::Path) -> usize {
        let nobody = Commenter {
            name: String::new(),
            pc: String::new(),
        };
        threads(&read_entries(&folder.join("comments")), &nobody)
            .iter()
            .filter(|thread| thread.resolved.is_none())
            .count()
    }

    fn write_entry(&self, guide_id: &str, entry: &Entry) -> Result<()> {
        let folder = self.guide_dir(guide_id)?.join("comments");
        fs::create_dir_all(&folder)?;
        write_json_new(&folder.join(format!("{}.json", entry.id)), entry)
    }

    /// Starts a thread (`reply_to` is `None`) on a step or the whole guide, or replies to one.
    /// Returns the new comment's id.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`; `Invalid` for an empty or overlong comment, or a reply to a
    /// thread that isn't there; `Storage`.
    pub fn add_comment(
        &self,
        guide_id: &str,
        step_id: Option<&str>,
        reply_to: Option<&str>,
        text: &str,
        who: &Commenter,
    ) -> Result<String> {
        let text = text.trim();
        if text.is_empty() || text.chars().count() > MAX_COMMENT {
            return Err(LibraryError::Invalid(format!(
                "a comment has 1 to {MAX_COMMENT} characters"
            )));
        }
        if let Some(step) = step_id {
            checked(step, "step id")?;
        }
        let thread = match reply_to {
            Some(thread) => {
                self.find_thread(guide_id, thread, who)?;
                Some(thread.to_string())
            }
            None => None,
        };
        let entry = Entry {
            format_version: 1,
            id: new_id(),
            action: Action::Comment,
            // A reply belongs to its thread, which already says what it's about.
            step_id: if thread.is_some() {
                None
            } else {
                step_id.map(str::to_string)
            },
            thread,
            text: text.to_string(),
            by: who.name.clone(),
            pc: who.pc.clone(),
            at: now_iso(),
        };
        self.write_entry(guide_id, &entry)?;
        Ok(entry.id)
    }

    fn find_thread(&self, guide_id: &str, thread: &str, who: &Commenter) -> Result<CommentThread> {
        checked(thread, "comment id")?;
        self.list_comments(guide_id, who)?
            .into_iter()
            .find(|found| found.first.id == thread)
            .ok_or_else(|| LibraryError::Invalid("that comment has been deleted".to_string()))
    }

    /// Resolves or reopens a thread. Doing what's already done changes nothing.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`; `Invalid` if the thread isn't there; `Storage`.
    pub fn set_comment_resolved(
        &self,
        guide_id: &str,
        thread: &str,
        resolved: bool,
        who: &Commenter,
    ) -> Result<()> {
        let found = self.find_thread(guide_id, thread, who)?;
        if found.resolved.is_some() == resolved {
            return Ok(());
        }
        self.write_entry(
            guide_id,
            &Entry {
                format_version: 1,
                id: new_id(),
                action: if resolved {
                    Action::Resolve
                } else {
                    Action::Reopen
                },
                thread: Some(thread.to_string()),
                step_id: None,
                text: String::new(),
                by: who.name.clone(),
                pc: who.pc.clone(),
                at: now_iso(),
            },
        )
    }

    /// Deletes one of your own comments: a reply, or a thread nobody has replied to (with its
    /// resolves and reopens). A thread with replies stays, so nobody else's words go with it.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`; `Invalid` if it isn't yours, has replies, or isn't there;
    /// `Storage`.
    pub fn delete_comment(&self, guide_id: &str, comment: &str, who: &Commenter) -> Result<()> {
        checked(comment, "comment id")?;
        let folder = self.guide_dir(guide_id)?.join("comments");
        let entries = read_entries(&folder);
        let target = entries
            .iter()
            .find(|entry| entry.id == comment && entry.action == Action::Comment)
            .ok_or_else(|| LibraryError::Invalid("that comment has been deleted".to_string()))?;
        if !target.is_by(who) {
            return Err(LibraryError::Invalid(
                "only the person who wrote a comment can delete it".to_string(),
            ));
        }
        let mut remove = vec![target.id.clone()];
        if target.thread.is_none() {
            let rest: Vec<&Entry> = entries
                .iter()
                .filter(|entry| entry.thread.as_deref() == Some(comment))
                .collect();
            if rest.iter().any(|entry| entry.action == Action::Comment) {
                return Err(LibraryError::Invalid(
                    "a comment with replies can't be deleted".to_string(),
                ));
            }
            remove.extend(rest.iter().map(|entry| entry.id.clone()));
        }
        for id in remove {
            if !is_safe_segment(&id) {
                continue;
            }
            match fs::remove_file(folder.join(format!("{id}.json"))) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who(name: &str, pc: &str) -> Commenter {
        Commenter {
            name: name.to_string(),
            pc: pc.to_string(),
        }
    }

    fn guide() -> (tempfile::TempDir, Library, String) {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::new(dir.path());
        let doc = library.create_guide("Payroll", "Robin").unwrap();
        let id = doc.guide["id"].as_str().unwrap().to_string();
        (dir, library, id)
    }

    #[test]
    fn a_thread_gets_replies_and_is_resolved_and_reopened() {
        let (_dir, library, id) = guide();
        let robin = who("Robin", "PC-1");
        let sam = who("Sam", "PC-2");
        let thread = library
            .add_comment(
                &id,
                Some("s4"),
                None,
                "  Step 4 changed after the October update ",
                &robin,
            )
            .unwrap();
        library
            .add_comment(&id, None, Some(&thread), "Fixed", &sam)
            .unwrap();

        let listed = library.list_comments(&id, &sam).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].first.text,
            "Step 4 changed after the October update"
        );
        assert_eq!(listed[0].step_id.as_deref(), Some("s4"));
        assert!(!listed[0].first.mine);
        assert_eq!(listed[0].replies.len(), 1);
        assert!(listed[0].replies[0].mine);
        assert_eq!(
            Library::open_comment_count(&library.guide_dir(&id).unwrap()),
            1
        );

        library
            .set_comment_resolved(&id, &thread, true, &sam)
            .unwrap();
        // Resolving again writes nothing.
        library
            .set_comment_resolved(&id, &thread, true, &robin)
            .unwrap();
        let resolved = library.list_comments(&id, &robin).unwrap();
        assert_eq!(resolved[0].resolved.as_ref().unwrap().by, "Sam");
        assert_eq!(
            Library::open_comment_count(&library.guide_dir(&id).unwrap()),
            0
        );
        let files = fs::read_dir(library.guide_dir(&id).unwrap().join("comments"))
            .unwrap()
            .count();
        assert_eq!(files, 3);

        library
            .set_comment_resolved(&id, &thread, false, &robin)
            .unwrap();
        assert!(
            library.list_comments(&id, &robin).unwrap()[0]
                .resolved
                .is_none()
        );
    }

    #[test]
    fn two_people_commenting_at_once_write_different_files() {
        let (_dir, library, id) = guide();
        let thread = library
            .add_comment(
                &id,
                Some("s1"),
                None,
                "Is this right?",
                &who("Robin", "PC-1"),
            )
            .unwrap();
        // Both reply and resolve at the same moment, each on their own PC.
        for (name, pc) in [("Sam", "PC-2"), ("Ana", "PC-3")] {
            library
                .add_comment(&id, None, Some(&thread), "Yes", &who(name, pc))
                .unwrap();
            library
                .add_comment(&id, Some("s1"), None, "Another point", &who(name, pc))
                .unwrap();
        }
        let listed = library.list_comments(&id, &who("Robin", "PC-1")).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].replies.len(), 2);
    }

    #[test]
    fn only_your_own_comment_without_replies_can_be_deleted() {
        let (_dir, library, id) = guide();
        let robin = who("Robin", "PC-1");
        let sam = who("Sam", "PC-2");
        let thread = library
            .add_comment(&id, None, None, "Whole guide note", &robin)
            .unwrap();
        let reply = library
            .add_comment(&id, None, Some(&thread), "Agreed", &sam)
            .unwrap();

        // Not yours, even with the same name on another PC.
        assert!(library.delete_comment(&id, &thread, &sam).is_err());
        assert!(
            library
                .delete_comment(&id, &thread, &who("Robin", "PC-9"))
                .is_err()
        );
        // Yours, but someone replied.
        assert!(library.delete_comment(&id, &thread, &robin).is_err());

        library.delete_comment(&id, &reply, &sam).unwrap();
        library
            .set_comment_resolved(&id, &thread, true, &sam)
            .unwrap();
        library.delete_comment(&id, &thread, &robin).unwrap();
        assert!(library.list_comments(&id, &robin).unwrap().is_empty());
        let left = fs::read_dir(library.guide_dir(&id).unwrap().join("comments"))
            .unwrap()
            .count();
        assert_eq!(left, 0, "the thread's resolve went with it");
    }

    #[test]
    fn empty_overlong_and_orphaned_comments_are_refused() {
        let (_dir, library, id) = guide();
        let robin = who("Robin", "PC-1");
        assert!(library.add_comment(&id, None, None, "   ", &robin).is_err());
        let long = "x".repeat(MAX_COMMENT + 1);
        assert!(library.add_comment(&id, None, None, &long, &robin).is_err());
        assert!(
            library
                .add_comment(&id, None, Some("missing"), "Hello", &robin)
                .is_err()
        );
        assert!(
            library
                .add_comment(&id, Some("../x"), None, "Hello", &robin)
                .is_err()
        );
    }

    #[test]
    fn the_window_gets_camel_case_names() {
        let (_dir, library, id) = guide();
        let robin = who("Robin", "PC-1");
        library
            .add_comment(&id, Some("s1"), None, "Hi", &robin)
            .unwrap();
        let value = serde_json::to_value(library.list_comments(&id, &robin).unwrap()).unwrap();
        let thread = &value[0];
        assert_eq!(thread["stepId"], "s1");
        assert_eq!(thread["text"], "Hi");
        assert_eq!(thread["mine"], true);
        assert!(thread["resolved"].is_null());
        assert!(thread["replies"].as_array().unwrap().is_empty());
    }
}
