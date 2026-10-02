# tauri-winres 0.3.6, patched

Upstream: https://github.com/tauri-apps/winres (MIT, see `LICENSE`), version 0.3.6 from crates.io.

**The only change:** `WindowsResource::new()` in `src/lib.rs` also sets `InternalName` and
`OriginalFilename` (the package name, plus `.exe`), which upstream leaves empty. Tauri's build
script has no way to add version-info fields, and the release checks require every field to be
set (docs/spec/10-distribution.md#release-checks).

**When upgrading Tauri:** if `cargo tree -i tauri-winres` shows a newer version, copy it here
again, reapply the change, and bump the version in the root `[patch.crates-io]` if needed. Drop
this folder if upstream starts setting the fields itself.
