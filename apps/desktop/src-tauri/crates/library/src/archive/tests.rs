//! Export privacy rules, the round trip, and one test per hostile-file rule
//! (docs/spec/08-privacy-and-security.md#hostile-files).

use std::io::Cursor;

use image::RgbaImage;
use serde_json::json;
use zip::write::SimpleFileOptions;

use super::*;
use crate::guides::tests::library;
use crate::media::tests::png;
use crate::schema::tests::{fixture, fixture_steps};

const FIXTURE_ID: &str = "guide-v1-fixture";

/// A screenshot with fine black-on-white stripes, like text, so a burned region is easy to spot.
fn screenshot() -> RgbaImage {
    RgbaImage::from_fn(400, 200, |x, y| {
        if (x / 2 + y / 3) % 2 == 0 {
            image::Rgba([0, 0, 0, 255])
        } else {
            image::Rgba([255, 255, 255, 255])
        }
    })
}

/// A library holding the shared fixture guide, its screenshot, and the things export must
/// leave behind (versions, comments, the lock, a thumbnail).
fn fixture_library() -> (tempfile::TempDir, Library) {
    let (root, library) = library();
    let folder = library.guides_dir().join(FIXTURE_ID);
    fs::create_dir_all(folder.join("steps")).unwrap();
    fs::create_dir_all(folder.join("media")).unwrap();
    fs::write(
        folder.join("guide.json"),
        serde_json::to_vec(&fixture("guide.json")).unwrap(),
    )
    .unwrap();
    for step in fixture_steps() {
        let name = format!("{}.json", step["id"].as_str().unwrap());
        fs::write(
            folder.join("steps").join(name),
            serde_json::to_vec(&step).unwrap(),
        )
        .unwrap();
    }
    let webp = media::encode_webp(&screenshot(), 90.0).unwrap();
    fs::write(folder.join("media").join("media-1.webp"), &webp).unwrap();
    fs::write(folder.join("media").join("media-1.thumb.webp"), &webp).unwrap();
    fs::write(folder.join("media").join("unused.webp"), &webp).unwrap();
    fs::create_dir_all(folder.join("versions").join("v1")).unwrap();
    fs::create_dir_all(folder.join("comments")).unwrap();
    fs::write(folder.join("comments").join("c1.json"), b"{}").unwrap();
    fs::write(folder.join(".lock"), b"{}").unwrap();
    (root, library)
}

fn export(library: &Library, include_originals: bool) -> (tempfile::TempDir, PathBuf) {
    let out = tempfile::tempdir().unwrap();
    let destination = out.path().join("guide.amlsteps");
    library
        .export_amlsteps(FIXTURE_ID, &destination, include_originals, "0.1.0")
        .unwrap();
    (out, destination)
}

fn read_zip(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        entries.insert(entry.name().to_string(), bytes);
    }
    entries
}

fn json_entry(entries: &BTreeMap<String, Vec<u8>>, name: &str) -> Value {
    serde_json::from_slice(&entries[name]).unwrap()
}

/// The entries of a valid `.amlsteps` file for the fixture guide.
fn valid_entries() -> Vec<(String, Vec<u8>)> {
    let mut entries = vec![
        (
            MANIFEST.to_string(),
            serde_json::to_vec(&json!({
                "formatVersion": 1, "kind": "guide",
                "exportedAt": "2026-09-25T11:00:00.000Z", "appVersion": "0.1.0"
            }))
            .unwrap(),
        ),
        (
            GUIDE_FILE.to_string(),
            serde_json::to_vec(&fixture("guide.json")).unwrap(),
        ),
    ];
    for step in fixture_steps() {
        entries.push((
            format!("{STEPS_PREFIX}{}.json", step["id"].as_str().unwrap()),
            serde_json::to_vec(&step).unwrap(),
        ));
    }
    entries.push((
        format!("{MEDIA_PREFIX}media-1.webp"),
        media::encode_webp(&screenshot(), 90.0).unwrap(),
    ));
    entries
}

fn build_zip(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, bytes) in entries {
        zip.start_file(name.as_str(), options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn with_entry(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut entries = valid_entries();
    entries.push((name.to_string(), bytes.to_vec()));
    build_zip(&entries)
}

fn replace_entry(name: &str, bytes: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    let mut entries = valid_entries();
    if let Some(entry) = entries.iter_mut().find(|entry| entry.0 == name) {
        entry.1 = bytes;
    }
    entries
}

fn import_with(library: &Library, bytes: &[u8], limits: &ImportLimits) -> Result<GuideSummary> {
    let folder = tempfile::tempdir().unwrap();
    let source = folder.path().join("incoming.amlsteps");
    fs::write(&source, bytes).unwrap();
    library.import_amlsteps_with(&source, limits)
}

/// Imports `bytes` into an empty library, expects a refusal whose message mentions `rule`,
/// and checks nothing at all was left in the library.
fn assert_rejected(bytes: &[u8], limits: &ImportLimits, rule: &str) {
    let (_root, library) = library();
    let error = import_with(&library, bytes, limits).unwrap_err();
    let message = error.to_string();
    assert!(
        matches!(error, LibraryError::ImportRejected(_)),
        "expected a rejection for {rule}, got {error:?}"
    );
    assert!(
        message.contains(rule),
        "{message:?} doesn't mention {rule:?}"
    );
    assert_library_empty(&library);
}

fn assert_library_empty(library: &Library) {
    let left: Vec<_> = fs::read_dir(library.guides_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "left behind: {left:?}");
}

fn defaults() -> ImportLimits {
    ImportLimits::default()
}

#[test]
fn export_burns_redactions_hides_values_and_leaves_private_files_out() {
    let (_root, library) = fixture_library();
    let (out, destination) = export(&library, false);
    let entries = read_zip(&destination);

    let names: Vec<_> = entries.keys().cloned().collect();
    let media_names: Vec<_> = names
        .iter()
        .filter(|name| name.starts_with(MEDIA_PREFIX))
        .collect();
    assert_eq!(media_names.len(), 1, "{names:?}");
    assert!(
        !names.iter().any(|name| name.contains("media-1")),
        "original leaked: {names:?}"
    );
    assert!(!names.iter().any(|name| {
        name.contains("versions")
            || name.contains("comments")
            || name.contains("lock")
            || name.contains("thumb")
            || name.contains("unused")
    }));

    let manifest = json_entry(&entries, MANIFEST);
    assert_eq!(manifest["formatVersion"], 1);
    assert_eq!(manifest["kind"], "guide");
    assert_eq!(manifest["appVersion"], "0.1.0");
    let guide = json_entry(&entries, GUIDE_FILE);
    assert!(guide.get("recordingSessionId").is_none());

    let step = json_entry(&entries, "guide/steps/step-1.json");
    assert!(
        step["textParts"].get("value").is_none(),
        "hidden value exported"
    );
    assert_eq!(step["redactions"], json!([]));
    let burned_id = step["media"]["id"].as_str().unwrap();
    assert_eq!(media_names[0], &format!("{MEDIA_PREFIX}{burned_id}.webp"));
    assert_eq!(step["media"]["width"], 400);

    // Pixel check: inside the redaction (x 10–30 %, y 5–9 % of 400×200) the stripes are gone;
    // well outside it the picture is unchanged apart from WebP noise.
    let burned = media::decode(
        &entries[media_names[0].as_str()],
        ImageKind::WebP,
        MAX_TEST_PIXELS,
    )
    .unwrap();
    // Compared with the stored original, so only one extra WebP pass adds noise.
    let stored = fs::read(
        library
            .guides_dir()
            .join(FIXTURE_ID)
            .join("media")
            .join("media-1.webp"),
    )
    .unwrap();
    let original = media::decode(&stored, ImageKind::WebP, MAX_TEST_PIXELS).unwrap();
    let difference = |x0: u32, x1: u32, y0: u32, y1: u32| {
        let mut total = 0_u64;
        let mut count = 0_u64;
        for y in y0..y1 {
            for x in x0..x1 {
                let a = i32::from(burned.get_pixel(x, y).0[0]);
                let b = i32::from(original.get_pixel(x, y).0[0]);
                total += u64::from(a.abs_diff(b));
                count += 1;
            }
        }
        total / count
    };
    assert!(
        difference(40, 120, 10, 18) > 60,
        "the redaction didn't change the pixels"
    );
    assert!(
        difference(200, 400, 100, 200) < 60,
        "pixels outside the redaction changed"
    );
    let inside: Vec<u8> = (44..116)
        .flat_map(|x| (12..16).map(move |y| (x, y)))
        .map(|(x, y)| burned.get_pixel(x, y).0[0])
        .collect();
    assert!(
        inside.iter().all(|value| (40..=215).contains(value)),
        "stripe detail survived inside the redaction"
    );

    // Only the finished file is left beside the destination.
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 1);
}

const MAX_TEST_PIXELS: u64 = 1_000_000;

#[test]
fn export_with_originals_keeps_the_original_and_its_redactions_but_never_hidden_values() {
    let (_root, library) = fixture_library();
    let (_out, destination) = export(&library, true);
    let entries = read_zip(&destination);
    assert!(entries.contains_key("guide/media/media-1.webp"));
    let step = json_entry(&entries, "guide/steps/step-1.json");
    assert_eq!(step["media"]["id"], "media-1");
    assert_eq!(step["redactions"].as_array().unwrap().len(), 1);
    assert!(step["textParts"].get("value").is_none());
}

#[test]
fn a_hidden_value_is_taken_out_of_hand_edited_wording_and_alt_text_too() {
    let (_root, library) = fixture_library();
    let mut step = fixture_steps().remove(0);
    step["actionText"] = json!("Type ACME LTD as the supplier");
    step["textEdited"] = json!(true);
    step["altText"] = json!("The supplier box, filled in with Acme Ltd");
    library.save_step(FIXTURE_ID, &step).unwrap();
    let (_out, destination) = export(&library, false);
    let step = json_entry(&read_zip(&destination), "guide/steps/step-1.json");
    assert_eq!(step["actionText"], "Type … as the supplier");
    assert_eq!(step["altText"], "The supplier box, filled in with …");
    assert!(step["textParts"].get("value").is_none());
}

#[test]
fn a_shown_value_is_exported() {
    let (_root, library) = fixture_library();
    let mut step = fixture_steps().remove(0);
    step["showValue"] = json!(true);
    library.save_step(FIXTURE_ID, &step).unwrap();
    let (_out, destination) = export(&library, false);
    let step = json_entry(&read_zip(&destination), "guide/steps/step-1.json");
    assert_eq!(step["textParts"]["value"], "Acme Ltd");
}

#[test]
fn a_failed_export_leaves_nothing_behind() {
    let (_root, library) = fixture_library();
    fs::remove_file(
        library
            .guides_dir()
            .join(FIXTURE_ID)
            .join("media")
            .join("media-1.webp"),
    )
    .unwrap();
    let out = tempfile::tempdir().unwrap();
    let destination = out.path().join("guide.amlsteps");
    assert!(
        library
            .export_amlsteps(FIXTURE_ID, &destination, true, "0.1.0")
            .is_err()
    );
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 0);
    assert!(
        library
            .export_amlsteps(FIXTURE_ID, Path::new("relative.amlsteps"), true, "0.1.0")
            .is_err()
    );
}

#[test]
fn an_exported_guide_imports_and_gets_a_new_id_when_its_own_is_taken() {
    let (_root, source) = fixture_library();
    let (_out, destination) = export(&source, false);
    let (_root2, target) = library();
    let first = target.import_amlsteps(&destination).unwrap();
    assert_eq!(first.id, FIXTURE_ID);
    assert_eq!(first.title, "Pay a supplier invoice");
    assert_eq!(first.step_count, 1); // a step and a note: the note isn't counted
    let second = target.import_amlsteps(&destination).unwrap();
    assert_ne!(second.id, FIXTURE_ID);
    let document = target.load_guide(&second.id).unwrap();
    assert_eq!(document.guide["id"], second.id.as_str());
    let media_id = document.steps[0]["media"]["id"].as_str().unwrap();
    let stored = target.load_image(&second.id, media_id, false).unwrap();
    assert_eq!(media::sniff(&stored), Some(ImageKind::WebP));
}

#[test]
fn a_valid_file_imports_with_unknown_fields_dropped_and_png_converted() {
    let (_root, library) = library();
    let mut guide = fixture("guide.json");
    guide["surprise"] = json!("<script>alert(1)</script>");
    let mut step = fixture_steps().remove(0);
    step["onClick"] = json!("steal()");
    let mut entries = replace_entry(GUIDE_FILE, serde_json::to_vec(&guide).unwrap());
    for entry in &mut entries {
        if entry.0 == "guide/steps/step-1.json" {
            entry.1 = serde_json::to_vec(&step).unwrap();
        }
    }
    entries.retain(|entry| !entry.0.starts_with(MEDIA_PREFIX));
    entries.push((format!("{MEDIA_PREFIX}media-1.png"), png(64, 32)));
    let summary = import_with(&library, &build_zip(&entries), &defaults()).unwrap();
    let folder = library.guides_dir().join(&summary.id);
    let stored_guide = crate::util::read_json(&folder.join("guide.json")).unwrap();
    assert!(stored_guide.get("surprise").is_none());
    assert!(stored_guide.get("recordingSessionId").is_none());
    let stored_step = crate::util::read_json(&folder.join("steps").join("step-1.json")).unwrap();
    assert!(stored_step.get("onClick").is_none());
    let image = fs::read(folder.join("media").join("media-1.webp")).unwrap();
    assert_eq!(media::sniff(&image), Some(ImageKind::WebP));
}

#[test]
fn an_original_screenshot_bigger_than_a_balanced_one_is_kept_as_it_is() {
    let (_root, library) = library();
    let wide = RgbaImage::from_pixel(3_000, 20, image::Rgba([10, 20, 30, 255]));
    let (lossless, _, _) =
        media::screenshot_webp(wide, media::ScreenshotQuality::Original).unwrap();
    let mut entries = valid_entries();
    entries.retain(|entry| !entry.0.starts_with(MEDIA_PREFIX));
    entries.push((format!("{MEDIA_PREFIX}media-1.webp"), lossless.clone()));
    let summary = import_with(&library, &build_zip(&entries), &defaults()).unwrap();
    let stored = fs::read(
        library
            .guides_dir()
            .join(&summary.id)
            .join("media")
            .join("media-1.webp"),
    )
    .unwrap();
    assert_eq!(stored, lossless);
}

#[test]
fn a_webp_bigger_than_a_stored_screenshot_is_scaled_down_and_a_normal_one_kept() {
    let (_root, library) = library();
    let wide = RgbaImage::from_pixel(3_000, 20, image::Rgba([10, 20, 30, 255]));
    let mut entries = valid_entries();
    entries.retain(|entry| !entry.0.starts_with(MEDIA_PREFIX));
    entries.push((
        format!("{MEDIA_PREFIX}media-1.webp"),
        media::encode_webp(&wide, 90.0).unwrap(),
    ));
    let summary = import_with(&library, &build_zip(&entries), &defaults()).unwrap();
    let stored = fs::read(
        library
            .guides_dir()
            .join(&summary.id)
            .join("media")
            .join("media-1.webp"),
    )
    .unwrap();
    let image = media::decode(&stored, ImageKind::WebP, media::MAX_PIXELS).unwrap();
    assert_eq!(image.width(), media::MAX_EDGE);

    // One already the right size comes through byte for byte.
    let (_other_root, second) = crate::guides::tests::library();
    let original = media::encode_webp(&screenshot(), 90.0).unwrap();
    let summary = import_with(&second, &build_zip(&valid_entries()), &defaults()).unwrap();
    let stored = fs::read(
        second
            .guides_dir()
            .join(&summary.id)
            .join("media")
            .join("media-1.webp"),
    )
    .unwrap();
    assert_eq!(stored, original);
}

#[test]
fn rule_json_files_are_capped() {
    let limits = ImportLimits {
        max_json_bytes: 200,
        ..defaults()
    };
    assert_rejected(&build_zip(&valid_entries()), &limits, "is larger than");
}

#[test]
fn rule_steps_the_editor_would_refuse_are_rejected() {
    let mut step = fixture_steps().remove(0);
    step["actionText"] = json!("x".repeat(2_001));
    let mut entries = valid_entries();
    for entry in &mut entries {
        if entry.0 == "guide/steps/step-1.json" {
            entry.1 = serde_json::to_vec(&step).unwrap();
        }
    }
    assert_rejected(&build_zip(&entries), &defaults(), "longer than 2000");
}

#[test]
fn rule_parent_references_are_rejected() {
    assert_rejected(
        &with_entry("guide/../../evil.json", b"{}"),
        &defaults(),
        "..",
    );
    assert_rejected(&with_entry("../evil.json", b"{}"), &defaults(), "..");
}

#[test]
fn rule_absolute_paths_are_rejected() {
    assert_rejected(
        &with_entry("/etc/evil.json", b"{}"),
        &defaults(),
        "absolute",
    );
}

#[test]
fn rule_drive_letters_are_rejected() {
    assert_rejected(
        &with_entry("C:/Windows/evil.dll", b"x"),
        &defaults(),
        "drive letter",
    );
    assert_rejected(&with_entry("C:evil.dll", b"x"), &defaults(), "drive letter");
}

#[test]
fn rule_unc_prefixes_are_rejected() {
    assert_rejected(
        &with_entry("\\\\server\\share\\evil.dll", b"x"),
        &defaults(),
        "UNC",
    );
    assert_rejected(
        &with_entry("//server/share/evil.dll", b"x"),
        &defaults(),
        "UNC",
    );
}

#[test]
fn rule_device_names_are_rejected_with_or_without_an_extension() {
    for name in [
        "guide/CON",
        "guide/media/nul.webp",
        "COM1.json",
        "guide/steps/lpt9.json",
        "aux",
    ] {
        assert_rejected(&with_entry(name, b"x"), &defaults(), "device name");
    }
}

#[test]
fn rule_symlinks_are_rejected() {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in valid_entries() {
        zip.start_file(name.as_str(), SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.add_symlink(
        "guide/media/link.webp",
        "C:/Windows/System32",
        SimpleFileOptions::default(),
    )
    .unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    assert_rejected(&bytes, &defaults(), "symbolic link");
}

#[test]
fn rule_names_differing_only_by_case_are_rejected() {
    let step = serde_json::to_vec(&fixture_steps().remove(0)).unwrap();
    assert_rejected(
        &with_entry("guide/steps/STEP-1.json", &step),
        &defaults(),
        "only by case",
    );
}

#[test]
fn rule_at_most_5000_entries() {
    let mut entries = valid_entries();
    for index in 0..=5_000 {
        entries.push((format!("extra/{index}.txt"), Vec::new()));
    }
    assert_rejected(&build_zip(&entries), &defaults(), "more than 5000 entries");
}

#[test]
fn rule_total_uncompressed_size_is_capped() {
    // The 2 GB cap, shrunk so the test doesn't have to write 2 GB.
    let limits = ImportLimits {
        max_total_bytes: 1_000,
        ..defaults()
    };
    assert_rejected(
        &build_zip(&valid_entries()),
        &limits,
        "expands to more than",
    );
}

#[test]
fn rule_each_entry_size_is_capped() {
    let limits = ImportLimits {
        max_entry_bytes: 500,
        ..defaults()
    };
    assert_rejected(&build_zip(&valid_entries()), &limits, "is larger than");
}

#[test]
fn rule_compression_ratio_over_100_to_1_is_rejected() {
    // A megabyte of zeros deflates to about a kilobyte: a small zip bomb.
    assert_rejected(
        &with_entry("guide/padding.bin", &vec![0; 1024 * 1024]),
        &defaults(),
        "zip bombs",
    );
}

#[test]
fn rule_sizes_are_checked_against_the_bytes_actually_read() {
    let step = serde_json::to_vec(&fixture_steps().remove(1)).unwrap();
    let name = "guide/steps/step-2.json";
    let mut entries = valid_entries();
    entries.retain(|entry| entry.0 != name);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (entry_name, bytes) in &entries {
        zip.start_file(entry_name.as_str(), SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.start_file(
        name,
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    zip.write_all(&step).unwrap();
    let mut bytes = zip.finish().unwrap().into_inner();
    // The headers now claim the step is 10 bytes long.
    patch_uncompressed_size(&mut bytes, name, 10);
    let (_root, library) = library();
    let error = import_with(&library, &bytes, &defaults()).unwrap_err();
    assert!(
        matches!(error, LibraryError::ImportRejected(_)),
        "{error:?}"
    );
    assert_library_empty(&library);
}

/// Rewrites the uncompressed size of `name` in its local header and central-directory record.
fn patch_uncompressed_size(bytes: &mut [u8], name: &str, size: u32) {
    let name = name.as_bytes();
    let mut patched = 0;
    for position in 0..bytes.len().saturating_sub(46 + name.len()) {
        let local = bytes[position..].starts_with(b"PK\x03\x04")
            && bytes[position + 30..].starts_with(name);
        let central = bytes[position..].starts_with(b"PK\x01\x02")
            && bytes[position + 46..].starts_with(name);
        let offset = if local {
            22
        } else if central {
            24
        } else {
            continue;
        };
        bytes[position + offset..position + offset + 4].copy_from_slice(&size.to_le_bytes());
        patched += 1;
    }
    assert_eq!(patched, 2);
}

#[test]
fn rule_only_webp_png_and_jpeg_images() {
    let entries = replace_entry(
        &format!("{MEDIA_PREFIX}media-1.webp"),
        b"GIF89a\x01\x00\x01\x00\x00\x00\x00;".to_vec(),
    );
    assert_rejected(&build_zip(&entries), &defaults(), "isn't WebP, PNG or JPEG");
    let svg = replace_entry(
        &format!("{MEDIA_PREFIX}media-1.webp"),
        b"<svg onload=alert(1)>".to_vec(),
    );
    assert_rejected(&build_zip(&svg), &defaults(), "isn't WebP, PNG or JPEG");
}

#[test]
fn rule_images_are_decoded_with_a_pixel_cap() {
    // The 100-megapixel cap, shrunk: the fixture screenshot is 400 × 200.
    let limits = ImportLimits {
        max_pixels: 10_000,
        ..defaults()
    };
    assert_rejected(&build_zip(&valid_entries()), &limits, "megapixels");
}

#[test]
fn rule_damaged_images_are_rejected() {
    let mut webp = media::encode_webp(&screenshot(), 90.0).unwrap();
    webp.truncate(40);
    let entries = replace_entry(&format!("{MEDIA_PREFIX}media-1.webp"), webp);
    assert_rejected(&build_zip(&entries), &defaults(), "can't be used");
}

#[test]
fn rule_newer_format_versions_are_refused_with_the_newer_version_message() {
    let mut guide = fixture("guide.json");
    guide["formatVersion"] = json!(2);
    let mut step = fixture_steps().remove(0);
    step["formatVersion"] = json!(2);
    let manifest =
        json!({ "formatVersion": 2, "kind": "guide", "exportedAt": "", "appVersion": "9" });
    for (name, value) in [
        (GUIDE_FILE, guide),
        ("guide/steps/step-1.json", step),
        (MANIFEST, manifest),
    ] {
        let (_root, library) = library();
        let bytes = build_zip(&replace_entry(name, serde_json::to_vec(&value).unwrap()));
        let error = import_with(&library, &bytes, &defaults()).unwrap_err();
        assert!(
            matches!(error, LibraryError::NewerFormat),
            "{name}: {error:?}"
        );
        assert_eq!(
            error.to_string(),
            "This guide was made by a newer version of Steps."
        );
        assert_library_empty(&library);
    }
}

#[test]
fn rule_json_must_match_the_schema() {
    let mut script = fixture_steps().remove(0);
    script["notes"]["content"][0]["content"][1]["marks"] =
        json!([{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }]);
    let bytes = build_zip(&replace_entry(
        "guide/steps/step-1.json",
        serde_json::to_vec(&script).unwrap(),
    ));
    assert_rejected(&bytes, &defaults(), "link");

    let mut wrong_type = fixture("guide.json");
    wrong_type["tags"] = json!("not a list");
    let bytes = build_zip(&replace_entry(
        GUIDE_FILE,
        serde_json::to_vec(&wrong_type).unwrap(),
    ));
    assert_rejected(&bytes, &defaults(), "guide.json");

    assert_rejected(
        &with_entry(
            "guide/steps/other.json",
            &serde_json::to_vec(&fixture_steps().remove(0)).unwrap(),
        ),
        &defaults(),
        "another id",
    );
    assert_rejected(
        &build_zip(&replace_entry(GUIDE_FILE, b"{ not json".to_vec())),
        &defaults(),
        "damaged",
    );
}

#[test]
fn rule_missing_parts_are_rejected() {
    let mut no_image = valid_entries();
    no_image.retain(|entry| !entry.0.starts_with(MEDIA_PREFIX));
    assert_rejected(&build_zip(&no_image), &defaults(), "isn't in the file");
    let mut no_manifest = valid_entries();
    no_manifest.retain(|entry| entry.0 != MANIFEST);
    assert_rejected(&build_zip(&no_manifest), &defaults(), "manifest");
    assert_rejected(
        b"this is not a zip file",
        &defaults(),
        "isn't a valid .amlsteps file",
    );
}

#[test]
fn entry_name_rules() {
    for good in [
        "amlsteps.json",
        "guide/",
        "guide/steps/step-1.json",
        "guide/media/a.b.webp",
    ] {
        assert!(check_entry_name(good).is_ok(), "{good}");
    }
    for bad in [
        "",
        "..",
        "a/../b",
        "a\\..\\b",
        "/a",
        "\\a",
        "\\\\?\\C:\\a",
        "C:a",
        "a:stream",
        "a//b",
        "./a",
        "CON",
        "con.txt",
        "a/Prn.json",
        "COM9",
        "lpt1.webp",
        "a./b",
        "a /b",
        "a\u{0}b",
    ] {
        assert!(check_entry_name(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn export_only_writes_amlsteps_files() {
    let (_root, library) = fixture_library();
    let out = tempfile::tempdir().unwrap();
    for name in ["guide.exe", "guide.amlsteps.bat", "guide"] {
        let destination = out.path().join(name);
        assert!(
            library
                .export_amlsteps(FIXTURE_ID, &destination, false, "0.1.0")
                .is_err(),
            "{name} was accepted"
        );
    }
    assert_eq!(fs::read_dir(out.path()).unwrap().count(), 0);
    library
        .export_amlsteps(
            FIXTURE_ID,
            &out.path().join("Guide.AMLSTEPS"),
            false,
            "0.1.0",
        )
        .unwrap();
}

/// A guide file made by Steps for Chrome's exporter (apps/chrome/src/library/archive.ts) from the
/// shared guide-v1 vector: the desktop must read what the Chrome edition writes.
#[test]
fn imports_a_guide_file_made_by_the_chrome_edition() {
    let (_dir, library) = library();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../../packages/core/test-vectors/guide-v1-chrome.amlsteps");
    let source = source.canonicalize().unwrap();
    let summary = library.import_amlsteps(&source).unwrap();
    assert_eq!(summary.id, FIXTURE_ID);
    assert_eq!(summary.title, "Pay a supplier invoice");
    assert_eq!(summary.step_count, 1); // a step and a note: the note isn't counted
    let doc = library.load_guide(FIXTURE_ID).unwrap();
    let media_id = doc.steps[0]["media"]["id"].as_str().unwrap();
    assert!(library.media_files(FIXTURE_ID).unwrap().iter().any(|path| {
        path.file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(media_id))
    }));
}
