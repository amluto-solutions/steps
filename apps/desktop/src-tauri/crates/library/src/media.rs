//! Images in a guide's `media\` folder: importing pasted or dropped pictures, thumbnails for
//! lists, and burning redactions into exported copies.
//!
//! Every decode is capped (input size, 100 megapixels, allocation), because images reach this
//! code from the clipboard, from other people's shared libraries and from imported files.

use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};

use crate::error::{LibraryError, Result};
use crate::guides::Library;
use crate::util::{checked, new_id, write_new};

/// Largest image a person can paste or drop.
pub const MAX_IMPORT_BYTES: usize = 50 * 1024 * 1024;
/// Largest image (width × height) any decode accepts.
pub const MAX_PIXELS: u64 = 100_000_000;
/// Stored screenshots are at most this long on their longest edge (Balanced quality).
pub const MAX_EDGE: u32 = 2560;
/// Thumbnails are at most this long on their longest edge.
pub const THUMBNAIL_EDGE: u32 = 480;
/// Lossy WebP quality for stored images, the same as the recorder's Balanced setting.
pub const WEBP_QUALITY: f32 = 90.0;
const THUMBNAIL_QUALITY: f32 = 80.0;
/// The ceiling on memory one decode may allocate. A 100-megapixel RGBA image is 400 MB.
const MAX_DECODE_ALLOC: u64 = 1 << 30;

/// Settings > Recording, "Screenshot quality" (docs/spec/07-settings-and-policy.md): how the
/// app's own screenshots are kept. Pictures people paste or drop are always Balanced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotQuality {
    /// Lossy WebP (quality 90) within 2560 pixels: the default.
    #[default]
    Balanced,
    /// Lossless WebP at the size the screen gave: every pixel kept, several times larger.
    Original,
}

/// A screenshot the app took, as it's stored in the chosen quality: the WebP and its size.
///
/// # Errors
/// `UnsupportedImage` when it's empty or can't be encoded.
pub fn screenshot_webp(
    image: RgbaImage,
    quality: ScreenshotQuality,
) -> Result<(Vec<u8>, u32, u32)> {
    if image.width() == 0 || image.height() == 0 {
        return Err(LibraryError::UnsupportedImage("it is empty".to_string()));
    }
    let (webp, image) = match quality {
        ScreenshotQuality::Balanced => {
            let image = fit(image, MAX_EDGE, FilterType::Lanczos3);
            (encode_webp(&image, WEBP_QUALITY)?, image)
        }
        ScreenshotQuality::Original => {
            let webp = webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height())
                .encode_lossless()
                .to_vec();
            (webp, image)
        }
    };
    Ok((webp, image.width(), image.height()))
}

/// Whether WebP bytes are lossless, as an Original screenshot is: a `VP8L` image, on its own or
/// in an extended file. Only the chunk headers are read.
pub(crate) fn is_lossless_webp(bytes: &[u8]) -> bool {
    let mut at = 12;
    // A handful of chunks come before the image (VP8X, ICCP, ANIM); give up after a few.
    for _ in 0..8 {
        let Some(header) = bytes.get(at..at + 8) else {
            return false;
        };
        match &header[0..4] {
            b"VP8L" => return true,
            b"VP8 " | b"ANMF" => return false,
            _ => {}
        }
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let Ok(size) = usize::try_from(size) else {
            return false;
        };
        // Chunks are padded to an even length.
        at = match at
            .checked_add(8)
            .and_then(|start| start.checked_add(size + (size & 1)))
        {
            Some(next) => next,
            None => return false,
        };
    }
    false
}

/// A stored image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// Its id: the file is `media\<id>.webp`.
    pub id: String,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// The image formats accepted anywhere: WebP, PNG and JPEG.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageKind {
    Png,
    Jpeg,
    WebP,
}

/// Identifies an image by its first bytes, never by its file name.
pub(crate) fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageKind::WebP)
    } else {
        None
    }
}

/// Decodes an image of a known kind, refusing anything over `max_pixels` before the pixels are
/// allocated.
pub(crate) fn decode(bytes: &[u8], kind: ImageKind, max_pixels: u64) -> Result<RgbaImage> {
    let format = match kind {
        ImageKind::Png => ImageFormat::Png,
        ImageKind::Jpeg => ImageFormat::Jpeg,
        ImageKind::WebP => ImageFormat::WebP,
    };
    let damaged = |error: image::ImageError| {
        LibraryError::UnsupportedImage(format!("the image is damaged ({error})"))
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(damaged)?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err(LibraryError::UnsupportedImage(
            "the image is empty".to_string(),
        ));
    }
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(LibraryError::UnsupportedImage(format!(
            "it is larger than {} megapixels",
            max_pixels / 1_000_000
        )));
    }
    Ok(DynamicImage::from_decoder(decoder)
        .map_err(damaged)?
        .to_rgba8())
}

/// Shrinks `image` so its longest edge is at most `max_edge`, keeping its shape.
pub(crate) fn fit(image: RgbaImage, max_edge: u32, filter: FilterType) -> RgbaImage {
    let longest = image.width().max(image.height());
    if longest <= max_edge {
        return image;
    }
    let scale = |value: u32| {
        let scaled =
            (u64::from(value) * u64::from(max_edge) + u64::from(longest) / 2) / u64::from(longest);
        u32::try_from(scaled).unwrap_or(1).max(1)
    };
    image::imageops::resize(&image, scale(image.width()), scale(image.height()), filter)
}

/// Encodes lossy WebP.
pub(crate) fn encode_webp(image: &RgbaImage, quality: f32) -> Result<Vec<u8>> {
    webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height())
        .encode_simple(false, quality)
        .map(|memory| memory.to_vec())
        .map_err(|error| {
            LibraryError::UnsupportedImage(format!("it could not be converted ({error:?})"))
        })
}

/// Turns image bytes of any accepted format into stored-screenshot WebP (longest edge 2560,
/// quality 90).
pub(crate) fn to_stored_webp(bytes: &[u8], max_pixels: u64) -> Result<(Vec<u8>, u32, u32)> {
    let kind = sniff(bytes).ok_or_else(|| {
        LibraryError::UnsupportedImage("only PNG, JPEG and WebP images can be used".to_string())
    })?;
    let image = fit(
        decode(bytes, kind, max_pixels)?,
        MAX_EDGE,
        FilterType::Lanczos3,
    );
    Ok((
        encode_webp(&image, WEBP_QUALITY)?,
        image.width(),
        image.height(),
    ))
}

impl Library {
    /// The path of `media\<id>.webp` (or its thumbnail) in an existing guide.
    pub(crate) fn media_path(
        &self,
        guide_id: &str,
        media_id: &str,
        thumbnail: bool,
    ) -> Result<PathBuf> {
        let media_id = checked(media_id, "image")?;
        let name = if thumbnail {
            format!("{media_id}.thumb.webp")
        } else {
            format!("{media_id}.webp")
        };
        Ok(self.guide_dir(guide_id)?.join("media").join(name))
    }

    /// Stores a pasted, dropped or chosen image as a new WebP in the guide.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `UnsupportedImage` (wrong format, over 50 MB or 100
    /// megapixels, damaged), `Storage`.
    pub fn import_image(&self, guide_id: &str, bytes: &[u8]) -> Result<MediaInfo> {
        let folder = self.guide_dir(guide_id)?.join("media");
        if bytes.len() > MAX_IMPORT_BYTES {
            return Err(LibraryError::UnsupportedImage(
                "it is larger than 50 MB".to_string(),
            ));
        }
        let (webp, width, height) = to_stored_webp(bytes, MAX_PIXELS)?;
        fs::create_dir_all(&folder)?;
        let id = new_id();
        write_new(&folder.join(format!("{id}.webp")), &webp)?;
        Ok(MediaInfo { id, width, height })
    }

    /// Stores a screenshot taken by the app (Retake) as a new WebP in the guide, in the quality
    /// Settings chose, as the recorder keeps its screenshots.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `UnsupportedImage` (empty), `Storage`.
    pub fn store_screenshot(
        &self,
        guide_id: &str,
        image: RgbaImage,
        quality: ScreenshotQuality,
    ) -> Result<MediaInfo> {
        let folder = self.guide_dir(guide_id)?.join("media");
        let (webp, width, height) = screenshot_webp(image, quality)?;
        fs::create_dir_all(&folder)?;
        let id = new_id();
        write_new(&folder.join(format!("{id}.webp")), &webp)?;
        Ok(MediaInfo { id, width, height })
    }

    /// Reads an image's WebP bytes. For a thumbnail, `media\<id>.thumb.webp` (longest edge 480)
    /// is made and cached on first use; if it can't be cached (a read-only share), a freshly
    /// made one is returned anyway.
    ///
    /// # Errors
    /// `InvalidId`, `GuideNotFound`, `ImageNotFound`, `UnsupportedImage`, `Storage`.
    pub fn load_image(&self, guide_id: &str, media_id: &str, thumbnail: bool) -> Result<Vec<u8>> {
        let original = self.media_path(guide_id, media_id, false)?;
        if thumbnail {
            let cached = self.media_path(guide_id, media_id, true)?;
            if let Ok(bytes) = fs::read(&cached) {
                return Ok(bytes);
            }
            let source = read_image_file(&original)?;
            let image = decode(&source, ImageKind::WebP, MAX_PIXELS)?;
            let small = fit(image, THUMBNAIL_EDGE, FilterType::Triangle);
            let bytes = encode_webp(&small, THUMBNAIL_QUALITY)?;
            let _ = write_new(&cached, &bytes);
            return Ok(bytes);
        }
        read_image_file(&original)
    }
}

fn read_image_file(path: &std::path::Path) -> Result<Vec<u8>> {
    if let Err(error) = crate::util::check_size(path, crate::util::MAX_IMAGE_FILE) {
        return Err(if error.kind() == std::io::ErrorKind::NotFound {
            LibraryError::ImageNotFound
        } else {
            error.into()
        });
    }
    match fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(LibraryError::ImageNotFound)
        }
        Err(error) => Err(error.into()),
    }
}

/// A rectangle as percentages of the image (the step file's `x, y, w, h`).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct PercentRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Irreversibly obscures each rectangle: first averaged into large blocks, which throws the
/// detail away, then blurred so the blocks don't draw the eye. Pixels outside the rectangles
/// are never read or changed, so nothing from inside can leak out through the blur.
pub(crate) fn burn_redactions(image: &mut RgbaImage, rects: &[PercentRect]) {
    let block = (image.width().max(image.height()) / 64).max(12);
    for rect in rects {
        if let Some(bounds) = pixel_bounds(*rect, image.width(), image.height()) {
            pixelate(image, bounds, block);
            box_blur(image, bounds, block / 2);
        }
    }
}

/// Pixel bounds `(left, top, right, bottom)`, right and bottom exclusive, clamped to the image
/// and rounded outwards so a partly covered pixel is covered. `None` for an empty rectangle.
fn pixel_bounds(rect: PercentRect, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let span = |start: f64, size: f64, total: u32| {
        if !start.is_finite() || !size.is_finite() {
            return None;
        }
        let (low, high) = if size < 0.0 {
            (start + size, start)
        } else {
            (start, start + size)
        };
        let total_f = f64::from(total);
        let low = (low.clamp(0.0, 100.0) / 100.0 * total_f).floor();
        let high = (high.clamp(0.0, 100.0) / 100.0 * total_f).ceil();
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "Both values are clamped to 0..=total, which fits u32."
        )]
        let (low, high) = (low as u32, high as u32);
        (high > low).then_some((low, high.min(total)))
    };
    let (left, right) = span(rect.x, rect.w, width)?;
    let (top, bottom) = span(rect.y, rect.h, height)?;
    Some((left, top, right, bottom))
}

fn pixelate(image: &mut RgbaImage, (left, top, right, bottom): (u32, u32, u32, u32), block: u32) {
    let mut y = top;
    while y < bottom {
        let y_end = (y + block).min(bottom);
        let mut x = left;
        while x < right {
            let x_end = (x + block).min(right);
            let mut sum = [0_u64; 4];
            for py in y..y_end {
                for px in x..x_end {
                    for (total, channel) in sum.iter_mut().zip(image.get_pixel(px, py).0) {
                        *total += u64::from(channel);
                    }
                }
            }
            let count = u64::from(x_end - x) * u64::from(y_end - y);
            let average = sum.map(|total| u8::try_from(total / count).unwrap_or(u8::MAX));
            for py in y..y_end {
                for px in x..x_end {
                    image.put_pixel(px, py, image::Rgba(average));
                }
            }
            x = x_end;
        }
        y = y_end;
    }
}

/// A box blur confined to the rectangle: one horizontal and one vertical pass, each a running
/// sum over pixels inside the rectangle only.
fn box_blur(image: &mut RgbaImage, (left, top, right, bottom): (u32, u32, u32, u32), radius: u32) {
    if radius == 0 {
        return;
    }
    for y in top..bottom {
        let line: Vec<[u8; 4]> = (left..right).map(|x| image.get_pixel(x, y).0).collect();
        for (offset, pixel) in blur_line(&line, radius).into_iter().enumerate() {
            let x = left + u32::try_from(offset).unwrap_or(0);
            image.put_pixel(x, y, image::Rgba(pixel));
        }
    }
    for x in left..right {
        let line: Vec<[u8; 4]> = (top..bottom).map(|y| image.get_pixel(x, y).0).collect();
        for (offset, pixel) in blur_line(&line, radius).into_iter().enumerate() {
            let y = top + u32::try_from(offset).unwrap_or(0);
            image.put_pixel(x, y, image::Rgba(pixel));
        }
    }
}

fn blur_line(line: &[[u8; 4]], radius: u32) -> Vec<[u8; 4]> {
    let radius = usize::try_from(radius).unwrap_or(usize::MAX);
    let mut prefix = vec![[0_u64; 4]; line.len() + 1];
    for (index, pixel) in line.iter().enumerate() {
        for channel in 0..4 {
            prefix[index + 1][channel] = prefix[index][channel] + u64::from(pixel[channel]);
        }
    }
    (0..line.len())
        .map(|index| {
            let start = index.saturating_sub(radius);
            let end = index
                .saturating_add(radius)
                .saturating_add(1)
                .min(line.len());
            let count = u64::try_from(end - start).unwrap_or(1).max(1);
            let mut pixel = [0_u8; 4];
            for (channel, value) in pixel.iter_mut().enumerate() {
                let total = prefix[end][channel] - prefix[start][channel];
                *value = u8::try_from(total / count).unwrap_or(u8::MAX);
            }
            pixel
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The Chrome edition's copy (apps/chrome/src/library/blur.ts) is checked against the same
    /// file, so both burn exactly the same pixels.
    #[test]
    fn burns_the_shared_test_vector() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../packages/core/test-vectors/blur.json"
        ))
        .unwrap();
        let width = u32::try_from(vector["width"].as_u64().unwrap()).unwrap();
        let height = u32::try_from(vector["height"].as_u64().unwrap()).unwrap();
        let mut image = RgbaImage::from_fn(width, height, |x, y| {
            let channel = |value: u32| u8::try_from(value % 256).unwrap();
            image::Rgba([
                channel(x * 7 + y * 3),
                channel(x * 5 + y * 11),
                channel(x * 13 + y * 2),
                255,
            ])
        });
        let rects: Vec<PercentRect> = vector["rects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|rect| PercentRect {
                x: rect["x"].as_f64().unwrap(),
                y: rect["y"].as_f64().unwrap(),
                w: rect["w"].as_f64().unwrap(),
                h: rect["h"].as_f64().unwrap(),
            })
            .collect();
        burn_redactions(&mut image, &rects);
        let mut hash: u32 = 0x811c_9dc5;
        for byte in image.as_raw() {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        assert_eq!(format!("{hash:08x}"), vector["fnv1a32"].as_str().unwrap());
    }
    use crate::guides::tests::library;

    pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                u8::try_from((x * 7) % 256).unwrap(),
                u8::try_from((y * 3) % 256).unwrap(),
                90,
                255,
            ])
        });
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    pub(crate) fn webp_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, image::Rgba([10, 200, 30, 255]));
        encode_webp(&image, 90.0).unwrap()
    }

    fn guide(library: &Library) -> String {
        library.create_guide("Images", "").unwrap().guide["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn formats_are_sniffed_from_bytes() {
        assert_eq!(sniff(&png(2, 2)), Some(ImageKind::Png));
        assert_eq!(sniff(&webp_bytes(2, 2)), Some(ImageKind::WebP));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageKind::Jpeg));
        assert_eq!(sniff(b"GIF89a......"), None);
        assert_eq!(sniff(b"<svg></svg>"), None);
    }

    #[test]
    fn imported_images_become_capped_webp_files() {
        let (_root, library) = library();
        let id = guide(&library);
        let info = library.import_image(&id, &png(3000, 1000)).unwrap();
        assert_eq!((info.width, info.height), (2560, 853));
        let stored = library.load_image(&id, &info.id, false).unwrap();
        assert_eq!(sniff(&stored), Some(ImageKind::WebP));
        let small = library.import_image(&id, &webp_bytes(20, 10)).unwrap();
        assert_eq!((small.width, small.height), (20, 10));
        assert_ne!(small.id, info.id);
    }

    #[test]
    fn retaken_screenshots_are_stored_like_imported_images() {
        let (_root, library) = library();
        let id = guide(&library);
        let shot = RgbaImage::from_pixel(3000, 1500, image::Rgba([20, 40, 60, 255]));
        let info = library
            .store_screenshot(&id, shot, ScreenshotQuality::Balanced)
            .unwrap();
        assert_eq!((info.width, info.height), (2560, 1280));
        let stored = library.load_image(&id, &info.id, false).unwrap();
        assert_eq!(sniff(&stored), Some(ImageKind::WebP));
        assert!(!is_lossless_webp(&stored));
        assert!(
            library
                .store_screenshot(&id, RgbaImage::new(0, 0), ScreenshotQuality::Balanced)
                .is_err()
        );
        assert!(
            library
                .store_screenshot("missing", RgbaImage::new(2, 2), ScreenshotQuality::Balanced)
                .is_err()
        );
    }

    #[test]
    fn original_screenshots_keep_every_pixel_at_their_own_size() {
        let (_root, library) = library();
        let id = guide(&library);
        // A 4K screen, with detail a lossy encoder would smudge.
        let shot = RgbaImage::from_fn(3840, 2160, |x, y| {
            let byte = |value: u32| u8::try_from(value % 256).unwrap_or(0);
            image::Rgba([byte(x % 251), byte(y % 241), byte(x ^ y), 255])
        });
        let info = library
            .store_screenshot(&id, shot.clone(), ScreenshotQuality::Original)
            .unwrap();
        assert_eq!((info.width, info.height), (3840, 2160));
        let stored = library.load_image(&id, &info.id, false).unwrap();
        assert!(is_lossless_webp(&stored));
        let decoded = decode(&stored, ImageKind::WebP, MAX_PIXELS).unwrap();
        assert_eq!(decoded, shot);
    }

    #[test]
    fn lossless_webp_is_told_from_lossy_by_its_chunks() {
        let small = RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]));
        let (lossless, _, _) = screenshot_webp(small.clone(), ScreenshotQuality::Original).unwrap();
        let (lossy, _, _) = screenshot_webp(small, ScreenshotQuality::Balanced).unwrap();
        assert!(is_lossless_webp(&lossless));
        assert!(!is_lossless_webp(&lossy));
        // An extended file: VP8X first, then the lossless image.
        let mut extended = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0".to_vec();
        extended.extend([0_u8; 10]);
        extended.extend(&lossless[12..]);
        assert!(is_lossless_webp(&extended));
        // Cut short, or chunk sizes that run off the end: not lossless, and no panic.
        assert!(!is_lossless_webp(&lossless[..14]));
        let mut runaway = b"RIFF\0\0\0\0WEBPVP8X\xff\xff\xff\xff".to_vec();
        runaway.extend([0_u8; 4]);
        assert!(!is_lossless_webp(&runaway));
    }

    #[test]
    fn wrong_formats_and_oversized_images_are_refused() {
        let (_root, library) = library();
        let id = guide(&library);
        assert!(matches!(
            library.import_image(&id, b"GIF89a-not-allowed"),
            Err(LibraryError::UnsupportedImage(_))
        ));
        assert!(matches!(
            library.import_image(&id, &vec![0_u8; MAX_IMPORT_BYTES + 1]),
            Err(LibraryError::UnsupportedImage(_))
        ));
        assert!(matches!(
            decode(&png(20, 20), ImageKind::Png, 399),
            Err(LibraryError::UnsupportedImage(_))
        ));
        let mut damaged = png(20, 20);
        damaged.truncate(40);
        assert!(matches!(
            library.import_image(&id, &damaged),
            Err(LibraryError::UnsupportedImage(_))
        ));
    }

    #[test]
    fn thumbnails_are_made_once_and_cached() {
        let (_root, library) = library();
        let id = guide(&library);
        let info = library.import_image(&id, &png(1200, 600)).unwrap();
        let thumb = library.load_image(&id, &info.id, true).unwrap();
        let decoded = decode(&thumb, ImageKind::WebP, MAX_PIXELS).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (480, 240));
        let cached = library.media_path(&id, &info.id, true).unwrap();
        assert!(cached.is_file());
        assert_eq!(library.load_image(&id, &info.id, true).unwrap(), thumb);
        assert!(matches!(
            library.load_image(&id, "missing", true),
            Err(LibraryError::ImageNotFound)
        ));
        assert!(matches!(
            library.load_image(&id, "..\\x", false),
            Err(LibraryError::InvalidId("image"))
        ));
    }

    #[test]
    fn burned_redactions_destroy_detail_and_touch_nothing_else() {
        // A one-pixel checkerboard: any surviving detail would show as black or white pixels.
        let mut image = RgbaImage::from_fn(100, 50, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgba([0, 0, 0, 255])
            } else {
                image::Rgba([255, 255, 255, 255])
            }
        });
        let original = image.clone();
        burn_redactions(
            &mut image,
            &[PercentRect {
                x: 10.0,
                y: 20.0,
                w: 50.0,
                h: 40.0,
            }],
        );
        for (x, y, pixel) in image.enumerate_pixels() {
            let inside = (10..60).contains(&x) && (10..30).contains(&y);
            if inside {
                assert!(
                    (100..=155).contains(&pixel.0[0]),
                    "detail survived at {x},{y}: {:?}",
                    pixel.0
                );
            } else {
                assert_eq!(
                    pixel,
                    original.get_pixel(x, y),
                    "changed outside at {x},{y}"
                );
            }
        }
    }

    #[test]
    fn odd_rectangles_are_clamped_or_ignored() {
        assert_eq!(
            pixel_bounds(
                PercentRect {
                    x: 90.0,
                    y: -10.0,
                    w: 50.0,
                    h: 20.0
                },
                100,
                100
            ),
            Some((90, 0, 100, 10))
        );
        assert_eq!(
            pixel_bounds(
                PercentRect {
                    x: 50.0,
                    y: 50.0,
                    w: -10.0,
                    h: -10.0
                },
                100,
                100
            ),
            Some((40, 40, 50, 50))
        );
        assert_eq!(
            pixel_bounds(
                PercentRect {
                    x: 10.0,
                    y: 10.0,
                    w: 0.0,
                    h: 5.0
                },
                100,
                100
            ),
            None
        );
        assert_eq!(
            pixel_bounds(
                PercentRect {
                    x: f64::NAN,
                    y: 0.0,
                    w: 5.0,
                    h: 5.0
                },
                100,
                100
            ),
            None
        );
    }
}
