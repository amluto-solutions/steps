# Test vectors

JSON files shared by `cargo test` and Vitest for every rule that both Rust and TypeScript must agree on. Examples: coordinate conversion inputs and outputs, hostile archives, and format upgrades.

Add a vector here whenever a shared rule gains a case.

## Files

- `coords.json`: screen-to-image percentage conversion (owner: Rust `capture/coords.rs`).
- `guide-v1/`: one valid format-1 guide (`guide.json` and two step files, one interaction and one block) using every field and every allowed rich-text node and mark. The Rust `library` crate parses it with its typed mirror of the schema, requires a lossless round trip, and builds its `.amlsteps` export and import tests on it. The TypeScript guide and step schemas must accept it unchanged.
- `guide-v1-chrome.amlsteps`: the guide-v1 guide as Steps for Chrome's exporter writes it (with `media-1.webp` as its screenshot, originals kept). The Rust `library` crate must import it.
- `guide-v1-desktop.amlsteps`: the guide-v1 guide as the desktop's exporter writes it (blur burned in). Steps for Chrome must import it. Together they are the round trip between the editions.
- `media-1.webp`: a small real WebP standing in for a screenshot.
- `blur.json`: burning blur into a screenshot (owner: Rust `library/media.rs`); the Chrome edition must give the same pixels.
- `sensitive.json`: sensitive field names and masked values (owner: Rust `capture/sensitive.rs`).
- `click-naming.json`: a click naming's kinds and sources (the TypeScript `ELEMENT_KINDS` and `NAMING_SOURCES`, Rust `library/schema.rs`), and the UI frameworks' names and light-dismiss layer that the TypeScript naming takes off an element and the Windows recorder walks down past (`uia-adapter.ts`, Rust `capture/uia.rs`), with cases.
- `library-folder/`: a shared library as the desktop writes one (owner: Rust `library`): a guide being edited on another PC, with a sync client's conflict copies of a step and of `guide.json`, a step brought back after a delete, comments, a draft and a version, plus a second guide and one in the Bin. Written byte for byte as `serde_json` pretty-prints, so Prettier leaves it alone. Both editions read it and must give `library-folder.expected.json` (`crates/library/tests/library_folder.rs`, `apps/chrome/src/folder/fixture.test.ts`).
