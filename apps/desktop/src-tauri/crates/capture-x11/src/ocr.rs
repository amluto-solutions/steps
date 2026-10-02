//! Tesseract, for suggested blurs (docs/spec/02-capture.md#linux-x11-phase-10), when it's
//! installed (`tesseract-ocr` on Debian and Ubuntu). It runs on this computer and reads the app's
//! own screenshots only; nothing is sent anywhere. Without it, suggestions are off and the review
//! panel says so.

use std::io::Write;
use std::process::{Command, Stdio};

use image::{ImageBuffer, ImageFormat, Rgba};

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

/// Whether Tesseract can be run.
#[must_use]
pub fn available() -> bool {
    Command::new("tesseract")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Reads the text in an image given as top-down BGRA8 pixels.
///
/// # Errors
/// If Tesseract isn't installed or fails.
pub fn recognize(bgra: &[u8], width: u32, height: u32) -> Result<Vec<Line>> {
    let mut rgba = bgra.to_vec();
    for pixel in rgba.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgba)
        .ok_or_else(|| Error::Ocr("the pixels don't match the size".into()))?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|error| Error::Ocr(error.to_string()))?;

    let mut child = Command::new("tesseract")
        .args(["stdin", "stdout", "--psm", "11", "tsv"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| Error::Ocr(format!("Tesseract isn't installed: {error}")))?;
    if let Some(mut input) = child.stdin.take() {
        input
            .write_all(png.get_ref())
            .map_err(|error| Error::Ocr(error.to_string()))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| Error::Ocr(error.to_string()))?;
    if !output.status.success() {
        return Err(Error::Ocr("Tesseract couldn't read the image".into()));
    }
    Ok(parse_tsv(&String::from_utf8_lossy(&output.stdout)))
}

/// Tesseract's TSV: one row per word (level 5), with the block, paragraph and line it's in.
fn parse_tsv(tsv: &str) -> Vec<Line> {
    let mut lines: Vec<((u32, u32, u32), Line)> = Vec::new();
    for row in tsv.lines().skip(1) {
        let columns: Vec<&str> = row.split('\t').collect();
        if columns.len() < 12 || columns[0] != "5" {
            continue;
        }
        let text = columns[11].trim();
        let confidence: f32 = columns[10].parse().unwrap_or(-1.0);
        if text.is_empty() || confidence < 0.0 {
            continue;
        }
        let number = |index: usize| columns[index].parse::<u32>().unwrap_or(0);
        #[allow(clippy::cast_precision_loss, reason = "pixel sizes are small")]
        let word = Word {
            text: text.to_string(),
            x: number(6) as f32,
            y: number(7) as f32,
            width: number(8) as f32,
            height: number(9) as f32,
        };
        let key = (number(2), number(3), number(4));
        match lines.last_mut() {
            Some((last, words)) if *last == key => words.push(word),
            _ => lines.push((key, vec![word])),
        }
    }
    lines.into_iter().map(|(_, words)| words).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_grouped_into_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
            1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t\n\
            5\t1\t1\t1\t1\t1\t10\t20\t50\t12\t96.5\tEmail\n\
            5\t1\t1\t1\t1\t2\t65\t20\t120\t12\t91.0\tsam@example.com\n\
            5\t1\t1\t1\t2\t1\t10\t40\t40\t12\t88.0\tTotal\n\
            5\t1\t1\t1\t2\t2\t60\t40\t10\t12\t-1\t \n";
        let lines = parse_tsv(tsv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 2);
        assert_eq!(lines[0][1].text, "sam@example.com");
        assert!((lines[0][1].x - 65.0).abs() < f32::EPSILON);
        assert_eq!(lines[1][0].text, "Total");
    }
}
