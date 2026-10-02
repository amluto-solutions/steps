//! The shared library in `packages/core/test-vectors/library-folder`, as this crate writes one,
//! read by the desktop. Steps for Chrome reads the same folder in
//! `apps/chrome/src/folder/fixture.test.ts` and must give the same answers, which are in
//! `library-folder.expected.json`: both editions work on the same folder at once.

// Test code throughout, as `#[cfg(test)]` modules are: a failed step should stop the test.
#![allow(clippy::unwrap_used, clippy::panic)]
use std::fs;
use std::path::Path;

use library::{Commenter, Conflict, Library};
use serde_json::{Value, json};

const VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../packages/core/test-vectors"
);

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// What a conflict is, without the two versions of the file.
fn conflict_summary(conflict: &Conflict) -> Value {
    match conflict {
        Conflict::Step { file, id, from, .. } => {
            json!({ "kind": "step", "file": file, "id": id, "from": from })
        }
        Conflict::Guide { file, from, .. } => {
            json!({ "kind": "guide", "file": file, "from": from })
        }
        Conflict::Restored { id, deleted_by, .. } => {
            json!({ "kind": "restored", "id": id, "deletedBy": deleted_by })
        }
    }
}

#[test]
fn the_desktop_reads_the_shared_library_fixture() {
    let expected: Value = serde_json::from_slice(
        &fs::read(Path::new(VECTORS).join("library-folder.expected.json")).unwrap(),
    )
    .unwrap();
    // A copy, as listing the bin removes old entries and listing guides sweeps leftovers.
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&Path::new(VECTORS).join("library-folder"), dir.path());
    let library = Library::new(dir.path());
    let robin = Commenter {
        name: "Robin Hale".into(),
        pc: "ROBINS-PC".into(),
    };

    assert_eq!(json!(library.guide_count()), expected["guideCount"]);
    assert_eq!(json!(library.list_guides().unwrap()), expected["guides"]);
    let conflicts: Vec<Value> = library
        .list_conflicts("payroll")
        .unwrap()
        .iter()
        .map(conflict_summary)
        .collect();
    assert_eq!(json!(conflicts), expected["conflicts"]);
    assert_eq!(
        json!(library.list_comments("payroll", &robin).unwrap()),
        expected["commentsForRobin"]
    );
    assert_eq!(
        json!(library.list_versions("payroll").unwrap()),
        expected["versions"]
    );
    assert_eq!(
        json!(library.list_drafts("payroll").unwrap()),
        expected["drafts"]
    );
    assert_eq!(
        json!(library.read_lock("payroll").unwrap()),
        expected["lock"]
    );
    assert!(!library.may_write("payroll", "robin-session").unwrap());
    assert_eq!(json!(library.list_trash().unwrap()), expected["trash"]);
    assert_eq!(
        json!(library.search("supplier").unwrap()),
        expected["searchSupplier"]
    );
}

/// Run by `tools/chrome-e2e/shared-library.mjs` on the library Steps for Chrome has just worked
/// on in a real browser (the fixture, edited there, plus a new recording), copied to
/// `STEPS_LIBRARY_DIR`: the desktop must read it all, and export it.
#[test]
#[ignore = "run by tools/chrome-e2e/shared-library.mjs"]
fn the_desktop_reads_what_chrome_wrote() {
    let Ok(dir) = std::env::var("STEPS_LIBRARY_DIR") else {
        panic!("STEPS_LIBRARY_DIR names the folder to read");
    };
    let library = Library::new(&dir);
    let guides = library.list_guides().unwrap();
    let ids: Vec<&str> = guides.iter().map(|guide| guide.id.as_str()).collect();
    assert_eq!(guides.len(), 3, "{ids:?}");
    // Chrome took the lock over, settled every conflict (keeping both versions of step 1), and
    // let go when the editor closed.
    assert!(library.list_conflicts("payroll").unwrap().is_empty());
    assert!(library.read_lock("payroll").unwrap().is_none());
    assert_eq!(library.load_guide("payroll").unwrap().steps.len(), 3);
    // The recording, published there as the default library, with its screenshots.
    let recorded = guides
        .iter()
        .find(|guide| guide.id != "payroll" && guide.id != "expenses")
        .unwrap();
    assert!(recorded.step_count >= 2, "{recorded:?}");
    let shot = recorded.thumbnail_media_id.as_deref().unwrap();
    assert!(library.load_image(&recorded.id, shot, false).unwrap().len() > 1000);
    let out = tempfile::tempdir().unwrap();
    library
        .export_amlsteps(
            &recorded.id,
            &out.path().join("recorded.amlsteps"),
            false,
            "test",
        )
        .unwrap();
}
