//! The Phase 6 exit scenarios: two PCs sharing one library through a sync
//! client, where every change must either survive or be shown in a conflict banner or a draft.
//!
//! Each PC has its own library folder, and `Cloud::sync` stands in for `OneDrive`: it copies what
//! changed on one side since that PC last synced, and when a file changed on both sides it keeps
//! the cloud's version and writes the PC's as a conflict copy named after the PC
//! (`s1-PC-A.json`), as `OneDrive` does. An edit beats a delete. Real PCs on `SharePoint` are the
//! manual half of this test (docs/test-matrix.md, "Shared library on two PCs").

// Test code throughout, as `#[cfg(test)]` modules are: a failed step should stop the test.
#![allow(clippy::unwrap_used, clippy::panic)]
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use library::{
    CommentThread, Commenter, Conflict, Heartbeat, Library, LockHolder, LockOutcome, Resolution,
};
use serde_json::{Value, json};

/// The cloud copy, and what each PC's folder held when it last synced.
struct Cloud {
    dir: tempfile::TempDir,
    last_synced: HashMap<String, HashMap<PathBuf, Option<Vec<u8>>>>,
}

/// One PC: its name, its library folder and its app's session.
struct Pc {
    name: &'static str,
    _dir: tempfile::TempDir,
    library: Library,
    holder: LockHolder,
    commenter: Commenter,
}

fn pc(name: &'static str, person: &str) -> Pc {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::new(dir.path());
    Pc {
        name,
        library,
        _dir: dir,
        holder: LockHolder {
            name: person.to_string(),
            pc: name.to_string(),
            session: format!("{name}-session"),
        },
        commenter: Commenter {
            name: person.to_string(),
            pc: name.to_string(),
        },
    }
}

/// Every file under `root`, relative, skipping unfinished writes.
fn files(root: &Path) -> BTreeSet<PathBuf> {
    fn walk(root: &Path, folder: &Path, found: &mut BTreeSet<PathBuf>) {
        let Ok(entries) = fs::read_dir(folder) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, found);
            } else if path.extension().is_none_or(|extension| extension != "tmp") {
                found.insert(path.strip_prefix(root).unwrap().to_path_buf());
            }
        }
    }
    let mut found = BTreeSet::new();
    walk(root, root, &mut found);
    found
}

fn read(root: &Path, relative: &Path) -> Option<Vec<u8>> {
    fs::read(root.join(relative)).ok()
}

fn put(root: &Path, relative: &Path, content: Option<&Vec<u8>>) {
    let path = root.join(relative);
    match content {
        Some(bytes) => {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

/// `s1.json` → `s1-PC-A.json`, as a sync client names the copy it keeps.
fn conflict_copy(relative: &Path, pc: &str) -> PathBuf {
    let stem = relative.file_stem().unwrap().to_string_lossy();
    let name = match relative.extension() {
        Some(extension) => format!("{stem}-{pc}.{}", extension.to_string_lossy()),
        None => format!("{stem}-{pc}"),
    };
    relative.with_file_name(name)
}

impl Cloud {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            last_synced: HashMap::new(),
        }
    }

    fn sync(&mut self, pc: &Pc) {
        let local_root = pc.library.root().to_path_buf();
        let cloud_root = self.dir.path().to_path_buf();
        let base = self.last_synced.entry(pc.name.to_string()).or_default();
        let mut paths = files(&local_root);
        paths.extend(files(&cloud_root));
        paths.extend(base.keys().cloned());
        for path in paths {
            let before = base.get(&path).cloned().flatten();
            let local = read(&local_root, &path);
            let remote = read(&cloud_root, &path);
            let settled = match (local != before, remote != before) {
                (false, false) => local,
                (true, false) => {
                    put(&cloud_root, &path, local.as_ref());
                    local
                }
                (false, true) => {
                    put(&local_root, &path, remote.as_ref());
                    remote
                }
                (true, true) if local == remote => local,
                // An edit beats a delete, on either side.
                (true, true) if local.is_none() => {
                    put(&local_root, &path, remote.as_ref());
                    remote
                }
                (true, true) if remote.is_none() => {
                    put(&cloud_root, &path, local.as_ref());
                    local
                }
                (true, true) => {
                    let copy = conflict_copy(&path, pc.name);
                    put(&cloud_root, &copy, local.as_ref());
                    put(&local_root, &copy, local.as_ref());
                    base.insert(copy, local);
                    put(&local_root, &path, remote.as_ref());
                    remote
                }
            };
            base.insert(path, settled);
        }
    }
}

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

fn texts(library: &Library, guide: &str) -> Vec<String> {
    library
        .load_guide(guide)
        .unwrap()
        .steps
        .iter()
        .map(|found| found["actionText"].as_str().unwrap().to_string())
        .collect()
}

/// A guide with two steps, made on A and synced to B.
fn shared_guide(cloud: &mut Cloud, a: &Pc, b: &Pc) -> String {
    let doc = a.library.create_guide("Payroll run", "Robin").unwrap();
    let id = doc.guide["id"].as_str().unwrap().to_string();
    a.library
        .save_step(&id, &step("s1", "a0", "Open payroll", "Robin"))
        .unwrap();
    a.library
        .save_step(&id, &step("s2", "a1", "Click Run", "Robin"))
        .unwrap();
    cloud.sync(a);
    cloud.sync(b);
    assert_eq!(texts(&b.library, &id), ["Open payroll", "Click Run"]);
    id
}

fn setup() -> (Cloud, Pc, Pc, String) {
    let mut cloud = Cloud::new();
    let a = pc("PC-A", "Robin");
    let b = pc("PC-B", "Sam");
    let id = shared_guide(&mut cloud, &a, &b);
    (cloud, a, b, id)
}

#[test]
fn both_open_the_same_guide_and_the_second_reads() {
    let (mut cloud, a, b, id) = setup();
    assert!(matches!(
        a.library.open_for_editing(&id, &a.holder, false).unwrap(),
        LockOutcome::Mine { .. }
    ));
    cloud.sync(&a);
    cloud.sync(&b);
    let LockOutcome::Theirs { lock } = b.library.open_for_editing(&id, &b.holder, false).unwrap()
    else {
        panic!("B should read while A edits");
    };
    assert_eq!(lock.name, "Robin");
    assert!(!b.library.may_write(&id, &b.holder.session).unwrap());
    assert!(a.library.may_write(&id, &a.holder.session).unwrap());
}

#[test]
fn a_takeover_while_the_editor_is_offline_loses_nothing() {
    let (mut cloud, a, b, id) = setup();
    a.library.open_for_editing(&id, &a.holder, false).unwrap();
    cloud.sync(&a);
    cloud.sync(&b);

    // A goes offline and keeps editing. B's app has watched A's counter stand still, and B
    // takes over.
    a.library
        .save_step(&id, &step("s1", "a0", "Open payroll (A)", "Robin"))
        .unwrap();
    a.library
        .save_step(&id, &step("s3", "a2", "Click Approve", "Robin"))
        .unwrap();
    a.library.heartbeat(&id, &a.holder).unwrap();
    b.library.open_for_editing(&id, &b.holder, true).unwrap();
    b.library
        .save_step(&id, &step("s1", "a0", "Open payroll (B)", "Sam"))
        .unwrap();
    cloud.sync(&b);

    // A comes back online.
    cloud.sync(&a);
    assert!(matches!(
        a.library.heartbeat(&id, &a.holder).unwrap(),
        Heartbeat::Displaced { .. }
    ));
    // From here A's writes are refused and its unsaved state becomes a draft.
    assert!(!a.library.may_write(&id, &a.holder.session).unwrap());
    let unsaved = json!({
        "guide": a.library.load_guide(&id).unwrap().guide,
        "steps": [step("s4", "a3", "Unsaved on A", "Robin")],
    });
    a.library
        .save_draft(&id, &a.holder.session, "Robin", &unsaved)
        .unwrap();
    cloud.sync(&a);
    cloud.sync(&b);

    // On B: B's wording in the guide, A's as a conflict to settle, A's new step, A's draft.
    for library in [&a.library, &b.library] {
        let steps = texts(library, &id);
        assert!(steps.contains(&"Open payroll (B)".to_string()), "{steps:?}");
        assert!(steps.contains(&"Click Approve".to_string()), "{steps:?}");
        let conflicts = library.list_conflicts(&id).unwrap();
        assert!(
            conflicts.iter().any(|conflict| matches!(
                conflict,
                Conflict::Step { theirs, .. } if theirs["actionText"] == "Open payroll (A)"
            )),
            "{conflicts:?}"
        );
        assert_eq!(library.list_drafts(&id).unwrap().len(), 1);
    }
}

#[test]
fn delayed_sync_brings_the_other_version_as_a_conflict_not_a_loss() {
    let (mut cloud, a, b, id) = setup();
    // Both change the same step before either sync arrives.
    a.library
        .save_step(&id, &step("s2", "a1", "Click Run payroll", "Robin"))
        .unwrap();
    b.library
        .save_step(&id, &step("s2", "a1", "Click Run now", "Sam"))
        .unwrap();
    cloud.sync(&a);
    cloud.sync(&b);
    cloud.sync(&a);

    for library in [&a.library, &b.library] {
        assert!(texts(library, &id).contains(&"Click Run payroll".to_string()));
        let conflicts = library.list_conflicts(&id).unwrap();
        assert_eq!(conflicts.len(), 1, "{conflicts:?}");
    }
    // Keep both: two steps, one after the other, and the copy is gone.
    let key = match &b.library.list_conflicts(&id).unwrap()[0] {
        Conflict::Step { file, .. } => file.clone(),
        other => panic!("{other:?}"),
    };
    b.library
        .resolve_conflict(&id, &key, Resolution::KeepBoth)
        .unwrap();
    cloud.sync(&b);
    cloud.sync(&a);
    for library in [&a.library, &b.library] {
        assert_eq!(
            texts(library, &id),
            ["Open payroll", "Click Run payroll", "Click Run now"]
        );
        assert!(library.list_conflicts(&id).unwrap().is_empty());
    }
}

#[test]
fn duplicate_writes_of_the_same_step_settle_to_one() {
    let (mut cloud, a, b, id) = setup();
    // The same save arrives twice (a retry), and both PCs write identical content.
    for _ in 0..2 {
        a.library
            .save_step(&id, &step("s1", "a0", "Open payroll", "Robin"))
            .unwrap();
    }
    b.library
        .save_step(&id, &step("s1", "a0", "Open payroll", "Robin"))
        .unwrap();
    cloud.sync(&a);
    cloud.sync(&b);
    assert!(b.library.list_conflicts(&id).unwrap().is_empty());
    assert_eq!(texts(&b.library, &id), ["Open payroll", "Click Run"]);
}

#[test]
fn a_step_deleted_on_one_pc_and_edited_on_the_other_comes_back_flagged() {
    let (mut cloud, a, b, id) = setup();
    a.library.delete_step(&id, "s2").unwrap();
    a.library
        .note_delete(&id, "s2", "Robin", &a.holder.session)
        .unwrap();
    b.library
        .save_step(&id, &step("s2", "a1", "Click Run payroll", "Sam"))
        .unwrap();
    cloud.sync(&a);
    cloud.sync(&b);
    cloud.sync(&a);

    for library in [&a.library, &b.library] {
        assert_eq!(texts(library, &id), ["Open payroll", "Click Run payroll"]);
        let conflicts = library.list_conflicts(&id).unwrap();
        assert!(
            matches!(
                conflicts.as_slice(),
                [Conflict::Restored { deleted_by, .. }] if deleted_by == "Robin"
            ),
            "{conflicts:?}"
        );
    }
}

#[test]
fn both_comment_on_the_same_step_at_once_and_both_comments_survive() {
    let (mut cloud, a, b, id) = setup();
    let thread = a
        .library
        .add_comment(&id, Some("s2"), None, "Is Run right?", &a.commenter)
        .unwrap();
    cloud.sync(&a);
    cloud.sync(&b);

    // At the same moment: both reply, both resolve, and each starts a thread on s2.
    for side in [&a, &b] {
        side.library
            .add_comment(&id, None, Some(&thread), "Checked", &side.commenter)
            .unwrap();
        side.library
            .add_comment(&id, Some("s2"), None, "One more thing", &side.commenter)
            .unwrap();
        side.library
            .set_comment_resolved(&id, &thread, true, &side.commenter)
            .unwrap();
    }
    cloud.sync(&a);
    cloud.sync(&b);
    cloud.sync(&a);

    let listed: Vec<CommentThread> = b.library.list_comments(&id, &b.commenter).unwrap();
    assert_eq!(listed.len(), 3);
    let first = listed
        .iter()
        .find(|found| found.first.id == thread)
        .unwrap();
    assert_eq!(first.replies.len(), 2);
    assert!(first.resolved.is_some());
    // Comments never make conflict copies.
    assert!(b.library.list_conflicts(&id).unwrap().is_empty());
}

#[test]
fn clocks_ten_minutes_apart_change_no_outcome() {
    let (mut cloud, a, b, id) = setup();
    let thread = a
        .library
        .add_comment(&id, None, None, "Guide note", &a.commenter)
        .unwrap();
    cloud.sync(&a);
    cloud.sync(&b);
    let reply = b
        .library
        .add_comment(&id, None, Some(&thread), "Reply", &b.commenter)
        .unwrap();
    // B's clock runs ten minutes behind: its reply says it was written before the thread began.
    let path = b
        .library
        .root()
        .join("guides")
        .join(&id)
        .join("comments")
        .join(format!("{reply}.json"));
    let mut written: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    written["at"] = json!("2000-01-01T00:00:00.000Z");
    fs::write(&path, serde_json::to_vec(&written).unwrap()).unwrap();
    cloud.sync(&b);
    cloud.sync(&a);

    let listed = a.library.list_comments(&id, &a.commenter).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].replies.len(),
        1,
        "the reply still belongs to its thread"
    );

    // Locks don't read clocks either: B's takeover depends only on B's own watch (the app's
    // staleness rule, tested in src/locks.rs), and A's lock stands until then.
    a.library.open_for_editing(&id, &a.holder, false).unwrap();
    cloud.sync(&a);
    cloud.sync(&b);
    assert!(matches!(
        b.library.open_for_editing(&id, &b.holder, false).unwrap(),
        LockOutcome::Theirs { .. }
    ));
}
