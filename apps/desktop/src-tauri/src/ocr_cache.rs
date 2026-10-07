//! OCR for suggested blurs, cached in app data only: `%APPDATA%\Amluto\Steps\ocr\<hash>.json`
//! (docs/spec/03-data-and-sharing.md#ocr-cache). Never in the library, `.amlsteps` or exports.
#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri commands receive owned values across IPC."
)]
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::recorder::CommandError;

mod closer;
use closer::{Focus, Look};

/// Unused cache files are removed after 30 days.
const KEEP_FOR: Duration = Duration::from_hours(30 * 24);
const MAX_IMAGE_BYTES: usize = 60 * 1024 * 1024;
/// The same cap the library puts on images it decodes.
const MAX_PIXELS: u64 = 100_000_000;

/// A word's box as percentages of the image, like every other position the app stores.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OcrLine {
    pub words: Vec<OcrWord>,
}

/// A blurred area, as percentages of the image.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Area {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// The most blur areas one request may carry.
const MAX_AREAS: usize = 500;

/// Text under a confirmed blur is dropped: a word whose centre is inside a blur isn't kept.
fn without_blurred(lines: Vec<OcrLine>, areas: &[Area]) -> Vec<OcrLine> {
    let hidden = |word: &OcrWord| {
        let (x, y) = (word.x + word.w / 2.0, word.y + word.h / 2.0);
        areas
            .iter()
            .any(|area| x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h)
    };
    lines
        .into_iter()
        .map(|line| OcrLine {
            words: line
                .words
                .into_iter()
                .filter(|word| !hidden(word))
                .collect(),
        })
        .filter(|line| !line.words.is_empty())
        .collect()
}

/// The click a reading looks closer round, when the request names one inside the image.
fn focus_point(request: &tauri::ipc::Request<'_>) -> Option<Focus> {
    request
        .headers()
        .get("x-focus")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| serde_json::from_str::<Focus>(value).ok())
        .filter(|Focus { x, y }| (0.0..=100.0).contains(x) && (0.0..=100.0).contains(y))
}

fn blur_areas(request: &tauri::ipc::Request<'_>) -> Vec<Area> {
    request
        .headers()
        .get("x-areas")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| serde_json::from_str::<Vec<Area>>(value).ok())
        .map(|mut areas| {
            areas.truncate(MAX_AREAS);
            areas
        })
        .unwrap_or_default()
}

/// Deletes the cached text of these screenshot files (a guide going to the Bin).
pub fn forget_images(app: &AppHandle, files: &[PathBuf]) {
    if let Some(folder) = cache_folder(app) {
        forget_in(&folder, files);
    }
}

fn forget_in(folder: &Path, files: &[PathBuf]) {
    let keys: Vec<String> = files
        .iter()
        .filter_map(|file| fs::read(file).ok())
        .filter(|bytes| bytes.len() <= MAX_IMAGE_BYTES)
        .map(|bytes| key(&bytes))
        .collect();
    if keys.is_empty() {
        return;
    }
    // The whole screenshot's entry and those of its closer looks (`<key>-at-…`).
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let of_these = keys.iter().any(|key| {
            name.strip_prefix(key.as_str())
                .is_some_and(|rest| rest == ".json" || rest.starts_with("-at-"))
        });
        if of_these {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn cache_folder(app: &AppHandle) -> Option<PathBuf> {
    crate::app_folder::app_folder(app).map(|folder| folder.join("ocr"))
}

/// A key for an image's bytes (the same screenshot is only read once). FNV-1a, which never
/// changes between Rust versions (`DefaultHasher` may, which would orphan every entry and stop a
/// guide going to the Bin from taking its cached text with it). `v2` entries record their blur.
fn key(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("v2-{hash:016x}-{}", bytes.len())
}

/// The cache file for an image's words, read with a closer look round `focus` when given: a
/// screenshot's words read round one click differ from those read round another.
fn file_name(bytes: &[u8], focus: Option<Focus>) -> String {
    match focus {
        Some(Focus { x, y }) => format!("{}-at-{x:.1}-{y:.1}.json", key(bytes)),
        None => format!("{}.json", key(bytes)),
    }
}

fn to_percent(lines: Vec<capture::platform::ocr::Line>, width: u32, height: u32) -> Vec<OcrLine> {
    #[allow(
        clippy::cast_precision_loss,
        reason = "image sides are at most a few thousand pixels"
    )]
    let (width, height) = (width as f32, height as f32);
    let round = |value: f32| (value * 100.0).round() / 100.0;
    lines
        .into_iter()
        .map(|line| OcrLine {
            words: line
                .into_iter()
                .map(|word| OcrWord {
                    text: word.text,
                    x: round(word.x / width * 100.0),
                    y: round(word.y / height * 100.0),
                    w: round(word.width / width * 100.0),
                    h: round(word.height / height * 100.0),
                })
                .collect(),
        })
        .collect()
}

/// Top-down BGRA pixels, as the OCR engines take them.
fn bgra(image: image::RgbaImage) -> Vec<u8> {
    let mut pixels = image.into_raw();
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    pixels
}

fn read_image(bytes: &[u8], focus: Option<Focus>) -> Result<Vec<OcrLine>, CommandError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(CommandError::new(
            "tooLarge",
            "The screenshot is too large to read.",
        ));
    }
    // Capped like every other decode: a small, highly compressed file can claim a huge canvas.
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| CommandError::new("unsupportedImage", error.to_string()))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|error| CommandError::new("unsupportedImage", error.to_string()))?;
    let (width, height) = image::ImageDecoder::dimensions(&decoder);
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(CommandError::new(
            "tooLarge",
            "The screenshot is too large to read.",
        ));
    }
    let image = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| CommandError::new("unsupportedImage", error.to_string()))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    let look = focus.and_then(|focus| Look::round(&image, focus));
    let pixels = bgra(image);
    // Its own thread, so the WinRT apartment belongs to OCR alone.
    let (lines, near) = std::thread::Builder::new()
        .name("amluto-ocr".into())
        .spawn(move || {
            let lines = capture::platform::ocr::recognize(&pixels, width, height)?;
            // A closer look that can't be read leaves the first reading as it is.
            let near = look.and_then(|look| {
                let (look_width, look_height) = look.size();
                capture::platform::ocr::recognize(look.pixels(), look_width, look_height)
                    .ok()
                    .map(|near| (look, near))
            });
            Ok::<_, capture::platform::Error>((lines, near))
        })
        .map_err(|error| CommandError::new("ocrFailed", error.to_string()))?
        .join()
        .map_err(|_| CommandError::new("ocrFailed", "OCR stopped unexpectedly."))?
        .map_err(|error| CommandError::new("ocrFailed", error.to_string()))?;
    let lines = to_percent(lines, width, height);
    Ok(match near {
        Some((look, near)) => look.merged(lines, near, width, height),
        None => lines,
    })
}

/// What the cache holds for one screenshot: its words, less any under the blur areas listed.
#[derive(Debug, Serialize, Deserialize)]
struct Cached {
    lines: Vec<OcrLine>,
    trimmed_by: Vec<Area>,
}

/// The words in a screenshot, less any under `areas`. A cached entry is only used when every
/// area it was trimmed by is still blurred in this request; otherwise (say the blur was taken
/// off, or a copy of the screenshot has less blur) the screenshot is read again. So text someone
/// blurred is never kept, and text they un-blurred is never missed.
fn lines_for(
    folder: Option<&Path>,
    bytes: &[u8],
    areas: &[Area],
    focus: Option<Focus>,
    read: impl FnOnce(&[u8], Option<Focus>) -> Result<Vec<OcrLine>, CommandError>,
) -> Result<Vec<OcrLine>, CommandError> {
    let path = folder.map(|folder| folder.join(file_name(bytes, focus)));
    let reusable = path
        .as_ref()
        .and_then(|path| fs::read(path).ok())
        .and_then(|text| serde_json::from_slice::<Cached>(&text).ok())
        .filter(|entry| entry.trimmed_by.iter().all(|area| areas.contains(area)));
    let (lines, fresh) = match reusable {
        Some(entry) => {
            if let Some(path) = &path {
                // Touch it, so the 30-day clean-up counts from its last use.
                let _ = fs::File::options()
                    .append(true)
                    .open(path)
                    .and_then(|file| file.set_modified(SystemTime::now()));
            }
            (entry.lines, false)
        }
        None => (read(bytes, focus)?, true),
    };
    let kept = without_blurred(lines.clone(), areas);
    if (fresh || kept != lines)
        && let (Some(folder), Some(path)) = (folder, &path)
    {
        let _ = fs::create_dir_all(folder);
        let entry = Cached {
            lines: kept.clone(),
            trimmed_by: areas.to_vec(),
        };
        if let Ok(json) = serde_json::to_vec(&entry) {
            let _ = fs::write(path, json);
        }
    }
    Ok(kept)
}

/// Removes cache files unused for 30 days (all of them when `everything`).
fn purge(folder: &Path, everything: bool) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.filter_map(Result::ok) {
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > KEEP_FOR);
        if everything || old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The words in a screenshot (sent as the raw request body: PNG, JPEG or WebP). The step's blur
/// areas come in the `x-areas` header: words under them are left out of the answer and removed
/// from the cache, so text someone chose to blur isn't kept (docs/spec/03-data-and-sharing.md).
/// The step's click, when it has one, comes in `x-focus`: the words round it are read again,
/// enlarged and with their contrast raised.
#[tauri::command(async)]
pub fn privacy_ocr(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<OcrLine>, CommandError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "invalidRequest",
            "The screenshot arrived in the wrong form.",
        ));
    };
    let folder = cache_folder(&app);
    if let Some(folder) = &folder {
        purge(folder, false);
    }
    lines_for(
        folder.as_deref(),
        bytes,
        &blur_areas(&request),
        focus_point(&request),
        read_image,
    )
}

/// Settings → "Clear OCR cache".
#[tauri::command(async)]
pub fn privacy_clear_ocr_cache(app: AppHandle) {
    if let Some(folder) = cache_folder(&app) {
        purge(&folder, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_under_a_blur_is_dropped() {
        let word = |text: &str, x: f32| OcrWord {
            text: text.into(),
            x,
            y: 10.0,
            w: 8.0,
            h: 2.0,
        };
        let lines = vec![
            OcrLine {
                words: vec![word("Name:", 5.0), word("jane@acme.com", 20.0)],
            },
            OcrLine {
                words: vec![word("07700900123", 60.0)],
            },
        ];
        let kept = without_blurred(
            lines,
            &[
                Area {
                    x: 18.0,
                    y: 8.0,
                    w: 12.0,
                    h: 6.0,
                },
                Area {
                    x: 55.0,
                    y: 0.0,
                    w: 20.0,
                    h: 20.0,
                },
            ],
        );
        assert_eq!(
            kept,
            vec![OcrLine {
                words: vec![word("Name:", 5.0)]
            }]
        );
    }

    #[test]
    fn a_guide_going_to_the_bin_takes_its_cached_text_with_it() {
        let cache = tempfile::tempdir().expect("cache");
        let media = tempfile::tempdir().expect("media");
        let shot = media.path().join("media-1.webp");
        fs::write(&shot, b"screenshot bytes").expect("write");
        let other = cache.path().join(format!("{}.json", key(b"another guide")));
        let mine = cache
            .path()
            .join(format!("{}.json", key(b"screenshot bytes")));
        fs::write(&other, b"[]").expect("write");
        fs::write(&mine, b"[]").expect("write");
        forget_in(cache.path(), &[shot]);
        assert!(!mine.exists());
        assert!(other.exists());
    }

    #[test]
    fn keys_are_stable_and_differ_by_content() {
        assert_eq!(key(b"one"), key(b"one"));
        assert_ne!(key(b"one"), key(b"two"));
    }

    #[test]
    fn boxes_become_percentages() {
        let lines = to_percent(
            vec![vec![capture::platform::ocr::Word {
                text: "Hi".into(),
                x: 50.0,
                y: 25.0,
                width: 100.0,
                height: 10.0,
            }]],
            1000,
            500,
        );
        assert_eq!(
            lines[0].words[0],
            OcrWord {
                text: "Hi".into(),
                x: 5.0,
                y: 5.0,
                w: 10.0,
                h: 2.0
            }
        );
    }

    fn line(text: &str, x: f32) -> OcrLine {
        OcrLine {
            words: vec![OcrWord {
                text: text.into(),
                x,
                y: 10.0,
                w: 8.0,
                h: 2.0,
            }],
        }
    }

    const EMAIL_BLUR: Area = Area {
        x: 18.0,
        y: 8.0,
        w: 12.0,
        h: 6.0,
    };

    #[test]
    fn cached_results_are_reused_and_old_files_purged() {
        let folder = tempfile::tempdir().expect("temp dir");
        let bytes = b"not really an image";
        let stored = vec![line("Name:", 5.0)];
        let first = lines_for(Some(folder.path()), bytes, &[], None, |_, _| {
            Ok(stored.clone())
        });
        assert_eq!(first.expect("read"), stored);
        // Read once: the second answer comes from the cache.
        let second = lines_for(Some(folder.path()), bytes, &[], None, |_, _| {
            Err(CommandError::new("ocrFailed", "should not read again"))
        });
        assert_eq!(second.expect("cached"), stored);
        purge(folder.path(), true);
        assert_eq!(fs::read_dir(folder.path()).expect("dir").count(), 0);
    }

    #[test]
    fn blurred_text_is_never_kept_and_unblurred_text_is_read_again() {
        let folder = tempfile::tempdir().expect("temp dir");
        let bytes = b"a screenshot";
        let all = vec![line("Name:", 5.0), line("jane@acme.com", 20.0)];
        let blurred = lines_for(Some(folder.path()), bytes, &[EMAIL_BLUR], None, |_, _| {
            Ok(all.clone())
        })
        .expect("read");
        assert_eq!(blurred, vec![line("Name:", 5.0)]);
        let on_disk = fs::read_to_string(folder.path().join(format!("{}.json", key(bytes))))
            .expect("cache file");
        assert!(!on_disk.contains("jane@acme.com"));

        // The same screenshot with the blur taken off (or a copy with less blur): read again,
        // so the address is found rather than the trimmed answer reused.
        let unblurred = lines_for(
            Some(folder.path()),
            bytes,
            &[],
            None,
            |_, _| Ok(all.clone()),
        )
        .expect("read again");
        assert_eq!(unblurred, all);
    }

    #[test]
    fn a_reading_round_a_click_is_kept_apart_from_others_of_the_same_screenshot() {
        let folder = tempfile::tempdir().expect("temp dir");
        let bytes = b"a screenshot";
        let menu = Focus { x: 18.0, y: 14.0 };
        let plain = vec![line("exa4nple.co.uk", 5.0)];
        let closer = vec![line("example.co.uk", 5.0)];
        lines_for(Some(folder.path()), bytes, &[], None, |_, _| {
            Ok(plain.clone())
        })
        .expect("read");
        let read = lines_for(Some(folder.path()), bytes, &[], Some(menu), |_, focus| {
            assert_eq!(focus, Some(menu));
            Ok(closer.clone())
        });
        assert_eq!(read.expect("read closer"), closer);
        // Both are kept: asking again reads neither.
        let unread = |_: &[u8], _: Option<Focus>| -> Result<Vec<OcrLine>, CommandError> {
            Err(CommandError::new("ocrFailed", "should not read again"))
        };
        assert_eq!(
            lines_for(Some(folder.path()), bytes, &[], None, unread).expect("cached"),
            plain
        );
        assert_eq!(
            lines_for(Some(folder.path()), bytes, &[], Some(menu), unread).expect("cached"),
            closer
        );
        // A guide going to the Bin takes both with it.
        let shot = folder.path().join("media-1.webp");
        fs::write(&shot, bytes).expect("write");
        let cache = folder.path().join("ocr");
        fs::create_dir_all(&cache).expect("dir");
        for entry in fs::read_dir(folder.path())
            .expect("dir")
            .filter_map(Result::ok)
        {
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                fs::rename(entry.path(), cache.join(entry.file_name())).expect("move");
            }
        }
        forget_in(&cache, &[shot]);
        assert_eq!(fs::read_dir(&cache).expect("dir").count(), 0);
    }

    #[test]
    fn keys_are_stable_across_versions() {
        // FNV-1a of "abc", so a toolchain update can't change it.
        assert_eq!(key(b"abc"), "v2-e71fa2190541574b-3");
    }

    /// A live check against Windows OCR: `AMLUTO_OCR_SAMPLE=<png> cargo test -- --ignored ocr`.
    /// It prints the words as JSON after `OCR_JSON:` and the time taken after `OCR_MS:`, for
    /// measuring readings on real screenshots without committing them.
    #[test]
    #[ignore = "needs Windows OCR and a sample image"]
    fn reads_a_sample_image() {
        let path = std::env::var("AMLUTO_OCR_SAMPLE").expect("set AMLUTO_OCR_SAMPLE");
        let bytes = fs::read(path).expect("read");
        // `AMLUTO_OCR_AT=x,y` (percentages): read with a closer look round that point.
        let focus = std::env::var("AMLUTO_OCR_AT").ok().map(|at| {
            let (x, y) = at.split_once(',').expect("x,y");
            Focus {
                x: x.trim().parse().expect("x"),
                y: y.trim().parse().expect("y"),
            }
        });
        let started = std::time::Instant::now();
        let lines = read_image(&bytes, focus).expect("ocr");
        println!("OCR_MS:{}", started.elapsed().as_millis());
        println!("OCR_JSON:{}", serde_json::to_string(&lines).expect("json"));
        let text: Vec<String> = lines
            .iter()
            .map(|line| {
                line.words
                    .iter()
                    .map(|word| word.text.clone())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        println!("{text:#?}");
        assert!(!lines.is_empty());
    }
}
