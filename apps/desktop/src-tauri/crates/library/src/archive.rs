//! `.amlsteps` files: one guide in a zip (docs/spec/03-data-and-sharing.md#exchange-files).
//!
//! ```text
//! amlsteps.json            { formatVersion: 1, kind: "guide", exportedAt, appVersion }
//! guide/guide.json
//! guide/steps/<id>.json
//! guide/media/<id>.webp
//! ```
//!
//! **Export** leaves out comments, versions, the lock and thumbnails; drops hidden typed values;
//! and, unless originals are asked for, burns redactions into new copies of the screenshots and
//! leaves the originals out.
//!
//! **Import** treats the file as hostile (docs/spec/08-privacy-and-security.md#hostile-files):
//! every entry name, size and compression ratio is checked before anything is read, sizes are
//! checked again against the bytes actually read (headers can lie), images are decoded with a
//! pixel cap, JSON is re-serialised from typed structs, and everything is built in a staging
//! folder that is renamed into the library only once it is all valid.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::{LibraryError, Result};
use crate::guides::{GuideSummary, Library};
use crate::media::{self, ImageKind, PercentRect, WEBP_QUALITY};
use crate::schema::{self, GuideV1, StepV1};
use crate::typed_value::without_typed_value;
use crate::util::{is_safe_segment, new_id, now_iso, write_json_new, write_new};

const MANIFEST: &str = "amlsteps.json";
const GUIDE_FILE: &str = "guide/guide.json";
const STEPS_PREFIX: &str = "guide/steps/";
const MEDIA_PREFIX: &str = "guide/media/";

/// The limits applied to every import. Tests shrink them to exercise each rule cheaply.
#[derive(Debug, Clone, Copy)]
pub struct ImportLimits {
    /// Most entries in one file.
    pub max_entries: usize,
    /// Most bytes all entries may expand to.
    pub max_total_bytes: u64,
    /// Most bytes one entry may expand to.
    pub max_entry_bytes: u64,
    /// Most bytes one JSON file (the manifest, the guide, a step) may expand to. Far more than any
    /// real one needs; it stops a small file putting gigabytes of step text into memory and then
    /// into the shared library.
    pub max_json_bytes: u64,
    /// Highest uncompressed:compressed ratio for one entry (zip-bomb guard).
    pub max_ratio: u64,
    /// Largest image, in pixels.
    pub max_pixels: u64,
}

impl Default for ImportLimits {
    fn default() -> Self {
        Self {
            max_entries: 5_000,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
            max_entry_bytes: 100 * 1024 * 1024,
            max_json_bytes: 4 * 1024 * 1024,
            max_ratio: 100,
            max_pixels: media::MAX_PIXELS,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    kind: String,
    exported_at: String,
    app_version: String,
}

impl Library {
    /// Writes a guide to `destination` as an `.amlsteps` file. The zip is written to a temporary
    /// file beside the destination and renamed, so a failed export leaves nothing half-written.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `Invalid` (a bad destination, or a guide whose files don't
    /// match the format or whose screenshot is missing), `UnsupportedImage`, `Storage`.
    pub fn export_amlsteps(
        &self,
        guide_id: &str,
        destination: &Path,
        include_originals: bool,
        app_version: &str,
    ) -> Result<()> {
        let destination = check_destination(destination)?;
        let document = self.load_guide(guide_id)?;
        let mut guide =
            schema::guide_from_value(document.guide).map_err(|problem| cannot_export(&problem))?;
        // The recording journal it names lives on this PC only.
        guide.recording_session_id = None;

        let mut steps = Vec::with_capacity(document.steps.len());
        let mut originals = BTreeSet::new();
        let mut burned = BTreeMap::new();
        for value in document.steps {
            let mut step =
                schema::step_from_value(value).map_err(|problem| cannot_export(&problem))?;
            // A hidden value leaves the file entirely: out of the wording and alt text as well
            // (the same safeguard every other export applies), then the value itself.
            if !step.show_value
                && let Some(value) = step.text_parts.value.take()
            {
                step.action_text = without_typed_value(&step.action_text, &value);
                step.alt_text = step
                    .alt_text
                    .as_deref()
                    .map(|alt| without_typed_value(alt, &value));
            }
            if let Some(media_id) = step.media.as_ref().and_then(|media| media.id.clone()) {
                if !include_originals && !step.redactions.is_empty() {
                    let (id, bytes) = self.burn_step_image(guide_id, &mut step, &media_id)?;
                    burned.insert(id, bytes);
                } else {
                    originals.insert(media_id);
                }
            }
            steps.push(step);
        }

        let temporary = sibling_temp(&destination)?;
        let written = (|| -> Result<()> {
            let file = File::create_new(&temporary)?;
            let mut zip = ZipWriter::new(BufWriter::new(file));
            let json = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            // WebP is already compressed; storing it keeps export fast.
            let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            let manifest = Manifest {
                format_version: 1,
                kind: "guide".to_string(),
                exported_at: now_iso(),
                app_version: app_version.to_string(),
            };
            add_entry(
                &mut zip,
                MANIFEST,
                json,
                &serde_json::to_vec_pretty(&manifest)?,
            )?;
            add_entry(
                &mut zip,
                GUIDE_FILE,
                json,
                &serde_json::to_vec_pretty(&guide)?,
            )?;
            for step in &steps {
                let name = format!("{STEPS_PREFIX}{}.json", step.id);
                add_entry(&mut zip, &name, json, &serde_json::to_vec_pretty(step)?)?;
            }
            for id in &originals {
                let path = self.media_path(guide_id, id, false)?;
                let bytes = crate::util::check_size(&path, crate::util::MAX_IMAGE_FILE)
                    .and_then(|()| fs::read(&path))
                    .map_err(|error| {
                        if error.kind() == std::io::ErrorKind::NotFound {
                            missing_screenshot()
                        } else {
                            error.into()
                        }
                    })?;
                add_entry(
                    &mut zip,
                    &format!("{MEDIA_PREFIX}{id}.webp"),
                    stored,
                    &bytes,
                )?;
            }
            for (id, bytes) in &burned {
                add_entry(&mut zip, &format!("{MEDIA_PREFIX}{id}.webp"), stored, bytes)?;
            }
            let writer = zip.finish().map_err(zip_storage_error)?;
            let file = writer
                .into_inner()
                .map_err(|error| LibraryError::Storage(error.into_error()))?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &destination)?;
            Ok(())
        })();
        if written.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        written
    }

    /// Burns a step's redactions into a new copy of its screenshot, points the step at the copy
    /// and clears the burned rectangles. Returns the new media id and its WebP bytes.
    fn burn_step_image(
        &self,
        guide_id: &str,
        step: &mut StepV1,
        media_id: &str,
    ) -> Result<(String, Vec<u8>)> {
        let path = self.media_path(guide_id, media_id, false)?;
        let bytes = match crate::util::check_size(&path, crate::util::MAX_IMAGE_FILE)
            .and_then(|()| fs::read(&path))
        {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(missing_screenshot());
            }
            Err(error) => return Err(error.into()),
        };
        let mut image = media::decode(&bytes, ImageKind::WebP, media::MAX_PIXELS)?;
        let rects: Vec<PercentRect> = step
            .redactions
            .iter()
            .filter_map(|redaction| {
                Some(PercentRect {
                    x: redaction.x.as_f64()?,
                    y: redaction.y.as_f64()?,
                    w: redaction.w.as_f64()?,
                    h: redaction.h.as_f64()?,
                })
            })
            .collect();
        media::burn_redactions(&mut image, &rects);
        let encoded = media::encode_webp(&image, WEBP_QUALITY)?;
        let id = new_id();
        if let Some(media) = step.media.as_mut() {
            media.id = Some(id.clone());
            media.width = Some(image.width().into());
            media.height = Some(image.height().into());
        }
        step.redactions.clear();
        Ok((id, encoded))
    }

    /// Imports an `.amlsteps` file as a new guide in this library, with the default limits.
    ///
    /// # Errors
    /// `ImportRejected` naming the rule that failed, `NewerFormat`, `Invalid` for a bad path,
    /// `Storage`.
    pub fn import_amlsteps(&self, source: &Path) -> Result<GuideSummary> {
        self.import_amlsteps_with(source, &ImportLimits::default())
    }

    /// Imports with explicit limits. Nothing reaches the library unless every rule passes.
    ///
    /// # Errors
    /// As `import_amlsteps`.
    pub fn import_amlsteps_with(
        &self,
        source: &Path,
        limits: &ImportLimits,
    ) -> Result<GuideSummary> {
        if !source.is_absolute() {
            return Err(LibraryError::Invalid(
                "Choose the .amlsteps file to import.".to_string(),
            ));
        }
        let file = File::open(source)?;
        // The zip reader loads the whole central directory when it opens the file, so a file
        // far bigger than anything the size rules allow is refused before that happens.
        if file.metadata()?.len() > limits.max_total_bytes.saturating_add(64 * 1024 * 1024) {
            return Err(LibraryError::rejected(format!(
                "the file is larger than {}",
                describe_bytes(limits.max_total_bytes)
            )));
        }
        let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|error| {
            LibraryError::rejected(format!("it isn't a valid .amlsteps file ({error})"))
        })?;
        let plan = plan_entries(&mut archive, limits)?;
        let mut reader = EntryReader {
            archive: &mut archive,
            limits,
            total: 0,
        };

        let manifest_index = plan
            .manifest
            .ok_or_else(|| LibraryError::rejected("it has no amlsteps.json manifest"))?;
        check_manifest(&reader.read_json(manifest_index)?)?;

        let guide_index = plan
            .guide
            .ok_or_else(|| LibraryError::rejected("it has no guide/guide.json"))?;
        let mut guide = parse_guide(reader.read_json(guide_index)?)?;
        let mut steps = Vec::with_capacity(plan.steps.len());
        for (file_id, index) in &plan.steps {
            let step = parse_step(reader.read_json(*index)?)?;
            if &step.id != file_id {
                return Err(LibraryError::rejected(format!(
                    "the step file {file_id}.json holds a step with another id"
                )));
            }
            steps.push(step);
        }
        let referenced: BTreeSet<String> = steps
            .iter()
            .filter_map(|step| step.media.as_ref().and_then(|media| media.id.clone()))
            .collect();

        guide.id = self.choose_id(&guide.id);
        // A recording journal belongs to the PC that recorded it.
        guide.recording_session_id = None;
        let staging = self.staging_dir("import");
        let built = (|| -> Result<()> {
            fs::create_dir_all(staging.join("steps"))?;
            fs::create_dir_all(staging.join("media"))?;
            for id in &referenced {
                let index = plan.media.get(id).ok_or_else(|| {
                    LibraryError::rejected(format!(
                        "a step uses the image {id}, which isn't in the file"
                    ))
                })?;
                let bytes = reader.read(*index)?;
                let webp = image_to_store(&bytes, limits.max_pixels)?;
                write_new(&staging.join("media").join(format!("{id}.webp")), &webp)?;
            }
            for step in &steps {
                write_json_new(
                    &staging.join("steps").join(format!("{}.json", step.id)),
                    step,
                )?;
            }
            write_json_new(&staging.join("guide.json"), &guide)?;
            let destination = self.guides_dir().join(&guide.id);
            if destination.exists() {
                return Err(LibraryError::GuideExists);
            }
            fs::rename(&staging, destination)?;
            Ok(())
        })();
        if let Err(error) = built {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        self.summary(&guide.id)
    }
}

fn cannot_export(problem: &str) -> LibraryError {
    LibraryError::Invalid(format!("This guide can't be exported because {problem}."))
}

fn missing_screenshot() -> LibraryError {
    LibraryError::Invalid(
        "A screenshot this guide uses is missing, so it can't be exported yet. If the library \
         is synced, wait for syncing to finish and try again."
            .to_string(),
    )
}

fn zip_storage_error(error: zip::result::ZipError) -> LibraryError {
    LibraryError::Storage(std::io::Error::other(error))
}

/// Only a `.amlsteps` file in an existing folder: the command can't be used to write anything
/// else. Replacing an existing file is left to the save dialog, which has already asked.
fn check_destination(destination: &Path) -> Result<PathBuf> {
    let valid = destination.is_absolute()
        && destination.file_name().is_some()
        && destination
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("amlsteps"))
        && destination.parent().is_some_and(Path::is_dir);
    if valid {
        Ok(destination.to_path_buf())
    } else {
        Err(LibraryError::Invalid(
            "Choose where to save the .amlsteps file.".to_string(),
        ))
    }
}

fn sibling_temp(destination: &Path) -> Result<PathBuf> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| LibraryError::Invalid("The file name must be valid text.".to_string()))?;
    Ok(destination.with_file_name(format!("{name}.{}.tmp", new_id())))
}

fn add_entry<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    options: SimpleFileOptions,
    bytes: &[u8],
) -> Result<()> {
    zip.start_file(name, options).map_err(zip_storage_error)?;
    zip.write_all(bytes)?;
    Ok(())
}

/// Where each part of the guide sits in the zip, after every entry passed the name and size
/// rules. Entries outside the layout are checked but never read.
#[derive(Debug, Default)]
struct EntryPlan {
    manifest: Option<usize>,
    guide: Option<usize>,
    steps: BTreeMap<String, usize>,
    media: BTreeMap<String, usize>,
}

/// Checks every entry's name, type and declared sizes, and maps the guide's parts to indexes.
fn plan_entries<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    limits: &ImportLimits,
) -> Result<EntryPlan> {
    if archive.len() > limits.max_entries {
        return Err(LibraryError::rejected(format!(
            "it has more than {} entries",
            limits.max_entries
        )));
    }
    let mut plan = EntryPlan::default();
    let mut seen = HashSet::new();
    let mut declared_total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|error| LibraryError::rejected(format!("an entry is damaged ({error})")))?;
        let name = entry.name().to_string();
        check_entry_name(&name).map_err(LibraryError::rejected)?;
        if entry.is_symlink()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err(LibraryError::rejected(format!("{name} is a symbolic link")));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(LibraryError::rejected(format!(
                "two entries are named {name} (names may differ only by case)"
            )));
        }
        check_declared_size(&name, entry.size(), entry.compressed_size(), limits)?;
        if name.to_ascii_lowercase().ends_with(".json") && entry.size() > limits.max_json_bytes {
            return Err(LibraryError::rejected(format!(
                "{name} is larger than {}",
                describe_bytes(limits.max_json_bytes)
            )));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > limits.max_total_bytes {
            return Err(LibraryError::rejected(format!(
                "it expands to more than {}",
                describe_bytes(limits.max_total_bytes)
            )));
        }
        if entry.is_dir() {
            continue;
        }
        place_entry(&mut plan, &name, index)?;
    }
    Ok(plan)
}

/// Records where a guide file is. Two images with the same id (say `a.png` and `a.webp`) are
/// refused rather than one silently winning.
fn place_entry(plan: &mut EntryPlan, name: &str, index: usize) -> Result<()> {
    if name == MANIFEST {
        plan.manifest = Some(index);
    } else if name == GUIDE_FILE {
        plan.guide = Some(index);
    } else if let Some(file) = name.strip_prefix(STEPS_PREFIX) {
        if let Some(id) = file.strip_suffix(".json").filter(|id| is_safe_segment(id)) {
            plan.steps.insert(id.to_string(), index);
        }
    } else if let Some(file) = name.strip_prefix(MEDIA_PREFIX)
        && let Some((id, extension)) = file.rsplit_once('.')
        && is_safe_segment(id)
        && ["webp", "png", "jpg", "jpeg"].contains(&extension.to_ascii_lowercase().as_str())
        && plan.media.insert(id.to_string(), index).is_some()
    {
        return Err(LibraryError::rejected(format!(
            "two images share the id {id}"
        )));
    }
    Ok(())
}

/// Windows device names, which open a device instead of a file whatever their extension.
const DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// The path rules: no parent references, absolute paths, drive letters, UNC prefixes, device
/// names, or components Windows would silently rename. Returns the rule that failed.
pub(crate) fn check_entry_name(name: &str) -> std::result::Result<(), String> {
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err("an entry has an empty or unprintable name".to_string());
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(format!("{name} is an absolute or network (UNC) path"));
    }
    if name.contains(':') {
        return Err(format!("{name} names a drive letter or a stream"));
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    for component in trimmed.split(['/', '\\']) {
        if component == ".." {
            return Err(format!("{name} climbs out of its folder (..)"));
        }
        if component.is_empty() || component == "." {
            return Err(format!("{name} has an empty path segment"));
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(format!("{name} ends a segment with a dot or space"));
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or(component)
            .trim_end()
            .to_ascii_uppercase();
        if DEVICE_NAMES.contains(&stem.as_str()) {
            return Err(format!("{name} uses the Windows device name {stem}"));
        }
    }
    Ok(())
}

fn check_declared_size(
    name: &str,
    size: u64,
    compressed: u64,
    limits: &ImportLimits,
) -> Result<()> {
    if size > limits.max_entry_bytes {
        return Err(LibraryError::rejected(format!(
            "{name} is larger than {}",
            describe_bytes(limits.max_entry_bytes)
        )));
    }
    check_ratio(name, size, compressed, limits)
}

fn check_ratio(name: &str, size: u64, compressed: u64, limits: &ImportLimits) -> Result<()> {
    if size > 0 && size > compressed.saturating_mul(limits.max_ratio) {
        return Err(LibraryError::rejected(format!(
            "{name} is compressed more than {}:1, which is how zip bombs work",
            limits.max_ratio
        )));
    }
    Ok(())
}

fn describe_bytes(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if bytes >= 1024 * MB {
        format!("{} GB", bytes / (1024 * MB))
    } else if bytes >= MB {
        format!("{} MB", bytes / MB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Reads entries with the size rules applied to the bytes actually produced, since a zip's
/// headers can claim anything.
struct EntryReader<'a, R: Read + Seek> {
    archive: &'a mut ZipArchive<R>,
    limits: &'a ImportLimits,
    total: u64,
}

impl<R: Read + Seek> EntryReader<'_, R> {
    fn read(&mut self, index: usize) -> Result<Vec<u8>> {
        self.read_up_to(index, self.limits.max_entry_bytes)
    }

    fn read_up_to(&mut self, index: usize, limit: u64) -> Result<Vec<u8>> {
        let entry = self
            .archive
            .by_index(index)
            .map_err(|error| LibraryError::rejected(format!("an entry can't be read ({error})")))?;
        let name = entry.name().to_string();
        let declared = entry.size();
        let compressed = entry.compressed_size();
        let cap = declared.min(limit);
        let mut bytes = Vec::new();
        entry
            .take(cap.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| LibraryError::rejected(format!("{name} is damaged ({error})")))?;
        let actual = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if actual > declared || actual > limit {
            return Err(LibraryError::rejected(format!(
                "{name} is larger than its header says"
            )));
        }
        check_ratio(&name, actual, compressed, self.limits)?;
        self.total = self.total.saturating_add(actual);
        if self.total > self.limits.max_total_bytes {
            return Err(LibraryError::rejected(format!(
                "it expands to more than {}",
                describe_bytes(self.limits.max_total_bytes)
            )));
        }
        Ok(bytes)
    }

    fn read_json(&mut self, index: usize) -> Result<Value> {
        let bytes = self.read_up_to(index, self.limits.max_json_bytes)?;
        serde_json::from_slice(&bytes)
            .map_err(|error| LibraryError::rejected(format!("a JSON file is damaged ({error})")))
    }
}

fn check_manifest(value: &Value) -> Result<()> {
    if !schema::format_version_is_current(value)
        .map_err(|problem| LibraryError::rejected(format!("amlsteps.json: {problem}")))?
    {
        return Err(LibraryError::NewerFormat);
    }
    let manifest: Manifest = serde_json::from_value(value.clone())
        .map_err(|error| LibraryError::rejected(format!("amlsteps.json: {error}")))?;
    if manifest.kind != "guide" {
        return Err(LibraryError::rejected(
            "it holds something other than a guide",
        ));
    }
    Ok(())
}

fn parse_guide(value: Value) -> Result<GuideV1> {
    if !schema::format_version_is_current(&value)
        .map_err(|problem| LibraryError::rejected(format!("guide.json: {problem}")))?
    {
        return Err(LibraryError::NewerFormat);
    }
    schema::guide_from_value(value).map_err(LibraryError::rejected)
}

fn parse_step(value: Value) -> Result<StepV1> {
    if !schema::format_version_is_current(&value)
        .map_err(|problem| LibraryError::rejected(format!("a step: {problem}")))?
    {
        return Err(LibraryError::NewerFormat);
    }
    schema::step_from_value(value).map_err(LibraryError::rejected)
}

/// Decodes an imported image under the pixel cap. A WebP no bigger than a stored screenshot
/// (2560 px), or a lossless one of any size (an Original screenshot), is kept as it is, so a
/// guide passed back and forth doesn't lose quality; a larger lossy one, and PNG and JPEG, are
/// converted to stored-screenshot WebP like every other image.
fn image_to_store(bytes: &[u8], max_pixels: u64) -> Result<Vec<u8>> {
    let kind = media::sniff(bytes)
        .ok_or_else(|| LibraryError::rejected("an image isn't WebP, PNG or JPEG"))?;
    let rejected = |error: LibraryError| match error {
        LibraryError::UnsupportedImage(reason) => {
            LibraryError::rejected(format!("an image can't be used: {reason}"))
        }
        other => other,
    };
    match kind {
        ImageKind::WebP => {
            let image = media::decode(bytes, kind, max_pixels).map_err(rejected)?;
            if image.width().max(image.height()) <= media::MAX_EDGE
                || media::is_lossless_webp(bytes)
            {
                Ok(bytes.to_vec())
            } else {
                media::to_stored_webp(bytes, max_pixels)
                    .map(|(webp, _, _)| webp)
                    .map_err(rejected)
            }
        }
        ImageKind::Png | ImageKind::Jpeg => media::to_stored_webp(bytes, max_pixels)
            .map(|(webp, _, _)| webp)
            .map_err(rejected),
    }
}

#[cfg(test)]
mod tests;
