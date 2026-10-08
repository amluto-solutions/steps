//! A new guide built from parts of others: what Merge guides writes (docs/spec/04-editor.md#merge-guides).
//! The merged `guide.json` and steps are worked out by the UI (`packages/ui/src/library/merge.ts`,
//! the same for both editions); this writes them, with the screenshots copied from the guides they
//! came from, as one new folder renamed into place only when complete.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::error::{LibraryError, Result};
use crate::guides::{GuideSummary, Library};
use crate::media::read_image_file;
use crate::util::{check_format_version, checked, write_json_new, write_new};

/// A screenshot to copy into the guide being built, under a new id.
#[derive(Debug, Clone)]
pub struct MediaCopy {
    /// `media\<id>.webp` in the guide it comes from (any library).
    pub source: PathBuf,
    /// Its thumbnail, when it has one; otherwise one is made when first shown.
    pub thumbnail: Option<PathBuf>,
    /// The new id, as the steps refer to it.
    pub new_id: String,
}

impl Library {
    /// Where a screenshot of `guide_id` is, and its thumbnail if there is one, for copying.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `ImageNotFound`.
    pub fn media_source(&self, guide_id: &str, media_id: &str) -> Result<MediaCopy> {
        let source = self.media_path(guide_id, media_id, false)?;
        if !source.is_file() {
            return Err(LibraryError::ImageNotFound);
        }
        let thumbnail = self.media_path(guide_id, media_id, true)?;
        Ok(MediaCopy {
            source,
            thumbnail: thumbnail.is_file().then_some(thumbnail),
            new_id: media_id.to_string(),
        })
    }

    /// Builds a new guide from `guide` (its id must be free here), `steps` and the screenshots in
    /// `media`, in a staging folder renamed into place when everything is written. Anything that
    /// fails removes the staging folder, so a half-built guide never appears.
    ///
    /// # Errors
    /// `InvalidId` (guide, a step or an image), `Invalid` for a step id given twice, `NewerFormat`,
    /// `GuideExists`, `Storage` (a screenshot that can't be read, say).
    pub fn create_from_parts(
        &self,
        guide: &Value,
        steps: &[Value],
        media: &[MediaCopy],
    ) -> Result<GuideSummary> {
        let id = checked(
            guide.get("id").and_then(Value::as_str).unwrap_or_default(),
            "guide",
        )?
        .to_string();
        check_format_version(guide, "guide")?;
        if !self.id_is_free(&id) {
            return Err(LibraryError::GuideExists);
        }
        let mut seen = HashSet::new();
        for step in steps {
            let step_id = checked(
                step.get("id").and_then(Value::as_str).unwrap_or_default(),
                "step",
            )?;
            check_format_version(step, "step")?;
            if !seen.insert(step_id.to_string()) {
                return Err(LibraryError::Invalid(format!(
                    "The step {step_id} is in the guide twice."
                )));
            }
        }
        for copy in media {
            checked(&copy.new_id, "image")?;
        }

        fs::create_dir_all(self.guides_dir())?;
        let staging = self.staging_dir(&id);
        let built = (|| -> Result<()> {
            fs::create_dir_all(staging.join("steps"))?;
            fs::create_dir_all(staging.join("media"))?;
            write_json_new(&staging.join("guide.json"), guide)?;
            for step in steps {
                let step_id = step.get("id").and_then(Value::as_str).unwrap_or_default();
                write_json_new(&staging.join("steps").join(format!("{step_id}.json")), step)?;
            }
            for copy in media {
                let media = staging.join("media");
                fs::copy(&copy.source, media.join(format!("{}.webp", copy.new_id)))?;
                if let Some(thumbnail) = &copy.thumbnail {
                    // Only a convenience: a missing thumbnail is made again when first shown.
                    let _ = fs::copy(thumbnail, media.join(format!("{}.thumb.webp", copy.new_id)));
                }
            }
            let destination = self.guides_dir().join(&id);
            if destination.exists() {
                return Err(LibraryError::GuideExists);
            }
            fs::rename(&staging, destination)?;
            Ok(())
        })();
        if built.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        built?;
        self.summary(&id)
    }
}

impl Library {
    /// Adds screenshots taken elsewhere to a guide that's already here, under their new ids: the
    /// steps of a recording made into the guide (docs/spec/04-editor.md#record-steps-here). They
    /// are copied byte for byte, as Save guide publishes a recording's, so a lossless screenshot
    /// stays lossless. Nothing here is written over; if one can't be copied, those this call
    /// copied are removed again, so a failed attempt leaves no stray pictures in a shared folder.
    ///
    /// # Errors
    /// `InvalidId` (the guide or a new id), `GuideNotFound`, `ImageNotFound` (a source that's
    /// gone), `Storage` (a new id already taken, a full disk).
    pub fn add_media(&self, guide_id: &str, media: &[MediaCopy]) -> Result<()> {
        let folder = self.guide_dir(guide_id)?.join("media");
        for copy in media {
            checked(&copy.new_id, "image")?;
        }
        fs::create_dir_all(&folder)?;
        let mut written = Vec::new();
        let mut copy_all = || -> Result<()> {
            for copy in media {
                let bytes = read_image_file(&copy.source)?;
                let target = folder.join(format!("{}.webp", copy.new_id));
                write_new(&target, &bytes)?;
                written.push(target);
            }
            Ok(())
        };
        let copied = copy_all();
        if copied.is_err() {
            for path in &written {
                let _ = fs::remove_file(path);
            }
        }
        copied
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guides::tests::{library, step};
    use crate::util::read_json;
    use serde_json::json;

    fn new_guide(id: &str) -> Value {
        json!({
            "id": id, "title": "Merged", "description": "", "intro": null, "outro": null,
            "brandProfileId": null, "tags": [], "owner": "Robin", "reviewBy": null,
            "createdAt": "2026-10-01T10:00:00Z", "createdBy": "Robin",
            "updatedAt": "2026-10-01T10:00:00Z", "updatedBy": "Robin", "formatVersion": 1
        })
    }

    #[test]
    fn builds_a_guide_from_parts_with_screenshots_from_other_libraries() {
        let (_root, from) = library();
        let (_root2, to) = library();
        let source = from.create_guide("Source", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let media = from.guides_dir().join(&source).join("media");
        fs::write(media.join("m1.webp"), b"image one").unwrap();
        fs::write(media.join("m1.thumb.webp"), b"thumb").unwrap();
        fs::write(media.join("m2.webp"), b"image two").unwrap();

        let copies = vec![
            MediaCopy {
                new_id: "n1".into(),
                ..from.media_source(&source, "m1").unwrap()
            },
            MediaCopy {
                new_id: "n2".into(),
                ..from.media_source(&source, "m2").unwrap()
            },
        ];
        assert!(copies[1].thumbnail.is_none());
        let summary = to
            .create_from_parts(
                &new_guide("merged1"),
                &[step("a", "a0", Some("n1")), step("b", "a1", Some("n2"))],
                &copies,
            )
            .unwrap();
        assert_eq!(summary.id, "merged1");
        assert_eq!(summary.step_count, 2);
        let folder = to.guides_dir().join("merged1");
        assert_eq!(
            fs::read(folder.join("media/n1.webp")).unwrap(),
            b"image one"
        );
        assert_eq!(
            fs::read(folder.join("media/n1.thumb.webp")).unwrap(),
            b"thumb"
        );
        assert_eq!(
            fs::read(folder.join("media/n2.webp")).unwrap(),
            b"image two"
        );
        assert_eq!(
            read_json(&folder.join("guide.json")).unwrap()["title"],
            "Merged"
        );
        // The source is untouched.
        assert!(media.join("m1.webp").is_file());

        assert!(matches!(
            from.media_source(&source, "missing"),
            Err(LibraryError::ImageNotFound)
        ));
    }

    #[test]
    fn refuses_bad_parts_and_leaves_nothing_behind() {
        let (_root, to) = library();
        // A step given twice.
        assert!(matches!(
            to.create_from_parts(
                &new_guide("merged2"),
                &[step("a", "a0", None), step("a", "a1", None)],
                &[],
            ),
            Err(LibraryError::Invalid(_))
        ));
        // A screenshot that can't be read.
        let missing = MediaCopy {
            source: to.root().join("nowhere.webp"),
            thumbnail: None,
            new_id: "n1".into(),
        };
        assert!(
            to.create_from_parts(
                &new_guide("merged2"),
                &[step("a", "a0", Some("n1"))],
                &[missing]
            )
            .is_err()
        );
        assert!(to.list_guides().unwrap().is_empty());
        assert!(!to.guides_dir().join("merged2").exists());
        // An id already in use.
        to.create_from_parts(&new_guide("merged3"), &[], &[])
            .unwrap();
        assert!(matches!(
            to.create_from_parts(&new_guide("merged3"), &[], &[]),
            Err(LibraryError::GuideExists)
        ));
        assert!(matches!(
            to.create_from_parts(&new_guide("../x"), &[], &[]),
            Err(LibraryError::InvalidId(_))
        ));
    }
    #[test]
    fn adds_a_recording_s_screenshots_to_a_guide_byte_for_byte_and_never_over_one() {
        let (root, to) = library();
        let guide = to.create_guide("Payroll", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string();
        let recording = root.path().join("recording");
        fs::create_dir_all(&recording).unwrap();
        fs::write(recording.join("click-1.webp"), b"first click").unwrap();
        fs::write(recording.join("click-2.webp"), b"second click").unwrap();
        let copy = |file: &str, new_id: &str| MediaCopy {
            source: recording.join(file),
            thumbnail: None,
            new_id: new_id.into(),
        };
        to.add_media(
            &guide,
            &[copy("click-1.webp", "r1"), copy("click-2.webp", "r2")],
        )
        .unwrap();
        let media = to.guides_dir().join(&guide).join("media");
        assert_eq!(fs::read(media.join("r1.webp")).unwrap(), b"first click");
        assert_eq!(fs::read(media.join("r2.webp")).unwrap(), b"second click");

        // An id taken, or a source gone: nothing from that call stays, and nothing is replaced.
        assert!(
            to.add_media(
                &guide,
                &[copy("click-2.webp", "r3"), copy("click-1.webp", "r1")]
            )
            .is_err()
        );
        assert!(!media.join("r3.webp").exists());
        assert_eq!(fs::read(media.join("r1.webp")).unwrap(), b"first click");
        assert!(matches!(
            to.add_media(&guide, &[copy("click-9.webp", "r4")]),
            Err(LibraryError::ImageNotFound)
        ));
        assert!(matches!(
            to.add_media(&guide, &[copy("click-1.webp", "../r5")]),
            Err(LibraryError::InvalidId(_))
        ));
        assert!(matches!(
            to.add_media("no-such-guide", &[copy("click-1.webp", "r6")]),
            Err(LibraryError::GuideNotFound)
        ));
    }
}
