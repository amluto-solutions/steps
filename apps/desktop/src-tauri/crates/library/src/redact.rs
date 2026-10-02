//! "Apply redactions permanently" (docs/spec/03-data-and-sharing.md#redactions-and-the-original-screenshots).
//!
//! Blur is non-destructive, so the unblurred original stays in `media\` and anyone who can open a
//! shared library folder can see it. This writes a copy of every blurred screenshot with the blur
//! burned in, points every step at the copy (in the guide **and in every saved version**, which
//! share the guide's `media\`), and only then deletes the originals and their thumbnails.
//!
//! A screenshot blurred differently in different versions gets all of those areas burned in, so
//! no version can bring the hidden part back. A crash part-way leaves every step pointing at a
//! file that exists; running it again finishes the job.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{LibraryError, Result};
use crate::guides::Library;
use crate::media::{self, ImageKind, PercentRect, WEBP_QUALITY};
use crate::util::{new_id, read_json, write_atomic, write_json_atomic};

/// Step files of the guide and of all its saved versions.
fn step_files(guide_folder: &Path) -> Vec<PathBuf> {
    let mut folders = vec![guide_folder.join("steps")];
    if let Ok(versions) = fs::read_dir(guide_folder.join("versions")) {
        folders.extend(
            versions
                .filter_map(std::result::Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path().join("steps")),
        );
    }
    let mut files: Vec<PathBuf> = folders
        .iter()
        .filter_map(|folder| fs::read_dir(folder).ok())
        .flat_map(|entries| entries.filter_map(std::result::Result::ok))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
}

fn media_id(step: &Value) -> Option<&str> {
    step.get("media")?.get("id")?.as_str()
}

fn redactions(step: &Value) -> Vec<PercentRect> {
    step.get("redactions")
        .and_then(Value::as_array)
        .map(|areas| {
            areas
                .iter()
                .filter_map(|area| {
                    Some(PercentRect {
                        x: area.get("x")?.as_f64()?,
                        y: area.get("y")?.as_f64()?,
                        w: area.get("w")?.as_f64()?,
                        h: area.get("h")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `blur.json` in the guide folder: what "Apply blur permanently" has done and has still to do.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct BlurRecord {
    /// Originals being replaced by their blurred copy. Written before any step changes, so a
    /// run that stops part-way (a step file held open by a sync client, say) is finished by the
    /// next one; an original stays listed until it has really been deleted.
    #[serde(default)]
    pending: BTreeMap<String, String>,
    /// For each blurred copy, the areas already burned into it, so running again doesn't blur
    /// the same picture again (each re-encode loses a little quality).
    #[serde(default)]
    burned: BTreeMap<String, Vec<PercentRect>>,
}

const BLUR_RECORD: &str = "blur.json";

fn read_record(folder: &Path) -> BlurRecord {
    fs::read(folder.join(BLUR_RECORD))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_record(folder: &Path, record: &BlurRecord) -> Result<()> {
    let path = folder.join(BLUR_RECORD);
    if record.pending.is_empty() && record.burned.is_empty() {
        return match fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        };
    }
    write_json_atomic(&path, record)
}

impl Library {
    /// Burns every blur into its screenshot for good. Returns how many screenshots were changed.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `ImageNotFound` if a blurred screenshot is missing (nothing
    /// is changed then), `UnsupportedImage`, `Storage`, and `OriginalsLeft` when the blur is
    /// burned in and every step points at the copies, but some originals couldn't be deleted yet.
    pub fn apply_redactions(&self, guide_id: &str) -> Result<usize> {
        let folder = self.guide_dir(guide_id)?;
        let mut record = read_record(&folder);

        // 0. Finish an earlier run that stopped part-way.
        if !record.pending.is_empty() {
            repoint(&folder, &record.pending)?;
            self.delete_originals(guide_id, &mut record)?;
            write_record(&folder, &record)?;
        }

        let steps: Vec<Value> = step_files(&folder)
            .iter()
            .map(|path| read_json(path))
            .collect::<Result<_>>()?;

        // Every area blurred on each screenshot, across the guide and its versions, less what is
        // already burned into it.
        let mut areas: BTreeMap<String, Vec<PercentRect>> = BTreeMap::new();
        for step in &steps {
            let Some(id) = media_id(step) else {
                continue;
            };
            let done = record.burned.get(id);
            for rect in redactions(step) {
                let entry = areas.entry(id.to_string()).or_default();
                if !done.is_some_and(|done| done.contains(&rect)) && !entry.contains(&rect) {
                    entry.push(rect);
                }
            }
        }
        areas.retain(|_, rects| !rects.is_empty());
        if areas.is_empty() {
            return finish(&record, 0);
        }

        // 1. Write the blurred copies. Nothing else changes until they all exist.
        let mut replaced: BTreeMap<String, String> = BTreeMap::new();
        for (original, rects) in &areas {
            let bytes = self.load_image(guide_id, original, false)?;
            let mut image = media::decode(&bytes, ImageKind::WebP, media::MAX_PIXELS)?;
            media::burn_redactions(&mut image, rects);
            let copy = new_id();
            write_atomic(
                &self.media_path(guide_id, &copy, false)?,
                &media::encode_webp(&image, WEBP_QUALITY)?,
            )?;
            let mut burned = record.burned.remove(original).unwrap_or_default();
            burned.extend(rects.iter().copied());
            record.burned.insert(copy.clone(), burned);
            replaced.insert(original.clone(), copy);
        }

        // 2. Record the swap before any step changes, then point every step at its copy. The
        //    blur areas stay, so the editor still shows them.
        record.pending.extend(replaced.clone());
        write_record(&folder, &record)?;
        repoint(&folder, &replaced)?;

        // 3. Only now remove the originals and their thumbnails.
        self.delete_originals(guide_id, &mut record)?;
        write_record(&folder, &record)?;
        finish(&record, replaced.len())
    }

    /// Deletes every original listed as pending, and its thumbnail. One that can't be deleted
    /// yet (a sync client has it open) stays listed for the next run.
    fn delete_originals(&self, guide_id: &str, record: &mut BlurRecord) -> Result<()> {
        let mut left = BTreeMap::new();
        for (original, copy) in std::mem::take(&mut record.pending) {
            let mut deleted = true;
            for thumbnail in [false, true] {
                if let Err(error) =
                    fs::remove_file(self.media_path(guide_id, &original, thumbnail)?)
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    deleted = false;
                }
            }
            if !deleted {
                left.insert(original, copy);
            }
        }
        record.pending = left;
        Ok(())
    }
}

/// Points every step (guide and versions) that shows an original at its blurred copy.
fn repoint(folder: &Path, swaps: &BTreeMap<String, String>) -> Result<()> {
    for path in step_files(folder) {
        let mut step = read_json(&path)?;
        let Some(copy) = media_id(&step).and_then(|id| swaps.get(id)).cloned() else {
            continue;
        };
        step["media"]["id"] = Value::String(copy);
        write_json_atomic(&path, &step)?;
    }
    Ok(())
}

/// `changed`, or `OriginalsLeft` if some originals are still waiting to be deleted.
fn finish(record: &BlurRecord, changed: usize) -> Result<usize> {
    if record.pending.is_empty() {
        Ok(changed)
    } else {
        Err(LibraryError::OriginalsLeft(record.pending.len()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::guides::tests::library;
    use crate::media::tests::png;

    fn step(id: &str, media: &str, redactions: Value) -> Value {
        let mut step = crate::schema::tests::fixture_steps()[0].clone();
        step["id"] = json!(id);
        step["media"]["id"] = json!(media);
        step["redactions"] = redactions;
        step
    }

    #[test]
    fn burns_blur_into_the_guide_and_every_version_then_removes_the_originals() {
        let (_root, library) = library();
        let guide = library.create_guide("Payroll", "Robin").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let blurred = library.import_image(&guide, &png(40, 20)).unwrap().id;
        let plain = library.import_image(&guide, &png(40, 20)).unwrap().id;
        let area = json!([{ "x": 0, "y": 0, "w": 50, "h": 100, "source": "manual" }]);

        // A saved version where the screenshot had no blur yet: it must not keep the original.
        library
            .save_step(&guide, &step("s1", &blurred, json!([])))
            .unwrap();
        library
            .save_step(&guide, &step("s2", &plain, json!([])))
            .unwrap();
        library
            .save_version(&guide, "before blur", "Robin")
            .unwrap();
        library
            .save_step(&guide, &step("s1", &blurred, area))
            .unwrap();
        // A thumbnail of the original exists too.
        library.load_image(&guide, &blurred, true).unwrap();
        let original = library.load_image(&guide, &blurred, false).unwrap();

        assert_eq!(library.apply_redactions(&guide).unwrap(), 1);

        let folder = library.guide_dir(&guide).unwrap();
        let ids: Vec<String> = step_files(&folder)
            .iter()
            .map(|path| media_id(&read_json(path).unwrap()).unwrap().to_string())
            .collect();
        assert!(
            !ids.contains(&blurred),
            "a step still points at the original"
        );
        assert!(ids.contains(&plain), "an unblurred screenshot was changed");
        assert!(library.load_image(&guide, &blurred, false).is_err());
        assert!(!library.media_path(&guide, &blurred, true).unwrap().exists());

        // The copy is really blurred, and the same copy serves the version.
        let copy = ids.iter().find(|id| **id != plain).unwrap();
        assert!(ids.iter().filter(|id| *id == copy).count() >= 2);
        assert_ne!(library.load_image(&guide, copy, false).unwrap(), original);

        // Running it again changes nothing more (the steps still carry their blur areas).
        let files_before = fs::read_dir(folder.join("media")).unwrap().count();
        library.apply_redactions(&guide).unwrap();
        assert!(fs::read_dir(folder.join("media")).unwrap().count() <= files_before + 1);
    }

    fn new_guide(library: &Library) -> String {
        library.create_guide("Payroll", "Robin").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn step_media(library: &Library, guide: &str) -> Vec<String> {
        step_files(&library.guide_dir(guide).unwrap())
            .iter()
            .map(|path| media_id(&read_json(path).unwrap()).unwrap().to_string())
            .collect()
    }

    #[test]
    fn a_run_that_stopped_part_way_is_finished_next_time() {
        let (_root, library) = library();
        let guide = new_guide(&library);
        let original = library.import_image(&guide, &png(40, 20)).unwrap().id;
        let copy = library.import_image(&guide, &png(40, 20)).unwrap().id;
        let area = json!([{ "x": 0, "y": 0, "w": 50, "h": 100, "source": "manual" }]);
        // A version still shows the original with no blur; the guide's step was already moved.
        library
            .save_step(&guide, &step("s1", &original, json!([])))
            .unwrap();
        library
            .save_version(&guide, "before blur", "Robin")
            .unwrap();
        library.save_step(&guide, &step("s1", &copy, area)).unwrap();
        let folder = library.guide_dir(&guide).unwrap();
        let rect = PercentRect {
            x: 0.0,
            y: 0.0,
            w: 50.0,
            h: 100.0,
        };
        write_record(
            &folder,
            &BlurRecord {
                pending: BTreeMap::from([(original.clone(), copy.clone())]),
                burned: BTreeMap::from([(copy.clone(), vec![rect])]),
            },
        )
        .unwrap();

        // Nothing new to burn, but the swap is finished: no step shows the original any more.
        assert_eq!(library.apply_redactions(&guide).unwrap(), 0);
        assert!(step_media(&library, &guide).iter().all(|id| *id == copy));
        assert!(library.load_image(&guide, &original, false).is_err());
        assert!(read_record(&folder).pending.is_empty());
    }

    #[test]
    fn blur_already_burned_in_is_not_burned_again() {
        let (_root, library) = library();
        let guide = new_guide(&library);
        let shot = library.import_image(&guide, &png(40, 20)).unwrap().id;
        let area = json!([{ "x": 0, "y": 0, "w": 50, "h": 100, "source": "manual" }]);
        library.save_step(&guide, &step("s1", &shot, area)).unwrap();
        assert_eq!(library.apply_redactions(&guide).unwrap(), 1);
        let after_first = step_media(&library, &guide);
        assert_eq!(library.apply_redactions(&guide).unwrap(), 0);
        assert_eq!(step_media(&library, &guide), after_first);

        // A new area on the same screenshot is burned, and only that one.
        let more = json!([
            { "x": 0, "y": 0, "w": 50, "h": 100, "source": "manual" },
            { "x": 60, "y": 0, "w": 20, "h": 20, "source": "manual" }
        ]);
        library
            .save_step(&guide, &step("s1", &after_first[0], more))
            .unwrap();
        assert_eq!(library.apply_redactions(&guide).unwrap(), 1);
        let record = read_record(&library.guide_dir(&guide).unwrap());
        let newest = &step_media(&library, &guide)[0];
        assert_eq!(record.burned.get(newest).map(Vec::len), Some(2));
    }

    #[cfg(windows)]
    #[test]
    fn an_original_another_program_holds_open_is_reported_and_deleted_next_time() {
        use std::os::windows::fs::OpenOptionsExt;

        let (_root, library) = library();
        let guide = new_guide(&library);
        let shot = library.import_image(&guide, &png(40, 20)).unwrap().id;
        let area = json!([{ "x": 0, "y": 0, "w": 50, "h": 100, "source": "manual" }]);
        library.save_step(&guide, &step("s1", &shot, area)).unwrap();
        let path = library.media_path(&guide, &shot, false).unwrap();
        // Open with reading allowed but not deleting, as a sync client holds a file.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ
            .open(&path)
            .unwrap();
        assert!(matches!(
            library.apply_redactions(&guide),
            Err(LibraryError::OriginalsLeft(1))
        ));
        assert!(step_media(&library, &guide).iter().all(|id| *id != shot));
        drop(held);
        assert_eq!(library.apply_redactions(&guide).unwrap(), 0);
        assert!(!path.exists());
    }

    #[test]
    fn a_missing_screenshot_changes_nothing() {
        let (_root, library) = library();
        let guide = library.create_guide("Payroll", "Robin").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let area = json!([{ "x": 0, "y": 0, "w": 50, "h": 50, "source": "manual" }]);
        library
            .save_step(&guide, &step("s1", "not-there", area))
            .unwrap();
        assert!(library.apply_redactions(&guide).is_err());
        let step = read_json(&library.guide_dir(&guide).unwrap().join("steps/s1.json")).unwrap();
        assert_eq!(media_id(&step), Some("not-there"));
    }
}
