//! Windows OCR (`Windows.Media.Ocr`), offline and built into Windows, for suggested blurs
//! (docs/spec/08-privacy-and-security.md#suggested-blurs). It reads the app's own screenshots
//! only; nothing is sent anywhere. The engine uses the languages in the user's Windows profile.

use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

use crate::{Error, Result};

/// One word OCR read, with its box in pixels of the image.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// A line of words, in reading order.
pub type Line = Vec<Word>;

/// Reads the text in an image given as top-down BGRA8 pixels.
///
/// # Errors
/// Returns an error when Windows has no OCR language installed, or the image is larger than the
/// engine accepts, or the recognition fails.
pub fn recognize(bgra: &[u8], width: u32, height: u32) -> Result<Vec<Line>> {
    // WinRT needs the thread in an apartment; an already-initialised thread keeps its own.
    // SAFETY: no reserved pointer is passed, and the matching uninitialise is skipped on
    // purpose so an apartment another part of the thread relies on is never torn down.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let limit = OcrEngine::MaxImageDimension()?;
    if width > limit || height > limit {
        return Err(Error::Ocr(format!(
            "the image is larger than OCR accepts ({limit} px)"
        )));
    }
    let expected = usize::try_from(u64::from(width) * u64::from(height) * 4)
        .map_err(|error| Error::Ocr(error.to_string()))?;
    if bgra.len() != expected {
        return Err(Error::Ocr(
            "the pixel buffer does not match the image size".into(),
        ));
    }
    let writer = DataWriter::new()?;
    writer.WriteBytes(bgra)?;
    let buffer = writer.DetachBuffer()?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        i32::try_from(width).map_err(|error| Error::Ocr(error.to_string()))?,
        i32::try_from(height).map_err(|error| Error::Ocr(error.to_string()))?,
    )?;
    let result = engine.RecognizeAsync(&bitmap)?.join()?;
    let mut lines = Vec::new();
    for line in result.Lines()? {
        let mut words = Vec::new();
        for word in line.Words()? {
            let rect = word.BoundingRect()?;
            words.push(Word {
                text: word.Text()?.to_string_lossy(),
                x: rect.X,
                y: rect.Y,
                width: rect.Width,
                height: rect.Height,
            });
        }
        if !words.is_empty() {
            lines.push(words);
        }
    }
    Ok(lines)
}
