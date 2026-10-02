//! Hostile `.amlsteps` files (docs/spec/08-privacy-and-security.md#hostile-files). Whatever the
//! bytes, importing never panics, and a file that's refused leaves nothing in the library.
#![no_main]

use library::{ImportLimits, Library};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let dir = tempfile::tempdir().expect("a temporary folder");
    let file = dir.path().join("fuzzed.amlsteps");
    std::fs::write(&file, data).expect("the fuzzed file is written");
    let root = dir.path().join("library");
    std::fs::create_dir_all(&root).expect("the library folder");
    let library = Library::new(&root);
    // Small limits, so every rule is reachable from a small input.
    let limits = ImportLimits {
        max_entries: 64,
        max_total_bytes: 4 * 1024 * 1024,
        max_entry_bytes: 1024 * 1024,
        max_json_bytes: 256 * 1024,
        max_ratio: 100,
        max_pixels: 1024 * 1024,
    };
    if library.import_amlsteps_with(&file, &limits).is_err() {
        let guides = root.join("guides");
        let empty = std::fs::read_dir(&guides).map_or(true, |mut entries| entries.next().is_none());
        assert!(empty, "a refused file left something in the library");
    }
});
