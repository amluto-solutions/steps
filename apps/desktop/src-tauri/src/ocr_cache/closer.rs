//! A closer look round the click (#19): the area round it is read again, enlarged three times,
//! in grey with its contrast raised and without the text caret a click in a text box leaves, and
//! its words take the place of the first reading's there.

use serde::{Deserialize, Serialize};

use super::{Area, OcrLine, OcrWord, bgra, to_percent};

/// The area round a click, made ready to read: its pixels as the OCR engines take them.
pub(super) struct Look {
    rect: Rect,
    pixels: Vec<u8>,
}

impl Look {
    /// The closer look round `focus` on `image`, or none when the click is off the image.
    pub(super) fn round(image: &image::RgbaImage, focus: Focus) -> Option<Self> {
        let (width, height) = image.dimensions();
        let rect = around(focus, width, height)?;
        let click = (pixel(focus.x, width), pixel(focus.y, height));
        Some(Self {
            rect,
            pixels: bgra(closer_look(image, rect, click)),
        })
    }

    /// Its pixels, top-down BGRA.
    pub(super) fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Its width and height in pixels, enlarged.
    pub(super) fn size(&self) -> (u32, u32) {
        (self.rect.w * ENLARGE, self.rect.h * ENLARGE)
    }

    /// The whole image's words (`whole`, in percentages of it), with the words this look read
    /// (`near`, in its own pixels) in their place round the click.
    pub(super) fn merged(
        &self,
        whole: Vec<OcrLine>,
        near: Vec<capture::platform::ocr::Line>,
        width: u32,
        height: u32,
    ) -> Vec<OcrLine> {
        closer(
            whole,
            to_percent(placed(near, self.rect), width, height),
            &to_percent_area(self.rect, width, height),
        )
    }
}

/// Whether two word boxes overlap.
fn overlap(a: &OcrWord, b: &OcrWord) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/// The words round the click, read again enlarged (`near`), take the place of the first
/// reading's in that area: small text read at screen size is where misreads like "exa4nple"
/// come from. They come first, so the click's own words are found before any left over. A line
/// touching the area's edge was cut by it, so the first reading's whole line stays instead:
/// keeping the part inside would split a label in two.
fn closer(whole: Vec<OcrLine>, near: Vec<OcrLine>, area: &Area) -> Vec<OcrLine> {
    // In percentages of the image: about 3 pixels of a 1920-pixel-wide screenshot.
    const EDGE: f32 = 0.2;
    let inside = |word: &OcrWord| {
        word.x > area.x + EDGE
            && word.x + word.w < area.x + area.w - EDGE
            && word.y > area.y + EDGE
            && word.y + word.h < area.y + area.h - EDGE
    };
    let kept: Vec<OcrLine> = near
        .into_iter()
        .filter(|line| line.words.iter().all(inside))
        .collect();
    let replaced = |word: &OcrWord| {
        kept.iter()
            .flat_map(|line| &line.words)
            .any(|better| overlap(word, better))
    };
    let rest: Vec<OcrLine> = whole
        .into_iter()
        .map(|line| OcrLine {
            words: line
                .words
                .into_iter()
                .filter(|word| !replaced(word))
                .collect(),
        })
        .filter(|line| !line.words.is_empty())
        .collect();
    kept.into_iter().chain(rest).collect()
}

/// The click, as percentages of the image: the words round it are read again, enlarged.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub(super) struct Focus {
    pub(super) x: f32,
    pub(super) y: f32,
}

/// A part of the image, in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// How much the area round the click is enlarged before it's read: Windows OCR misreads text a
/// screenshot shows at 12 to 14 pixels high, and reads it reliably at two to three times that.
const ENLARGE: u32 = 3;

/// A position given as a percentage of a side, in pixels along it.
fn pixel(percent: f32, side: u32) -> u32 {
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "image sides are at most a few thousand pixels, and the result is clamped to them"
    )]
    ((percent / 100.0 * side as f32).round().max(0.0) as u32).min(side)
}

/// The area read again round the click, in pixels, since text is as many pixels high in a small
/// window's screenshot as in a whole screen's: wide enough for a menu item's whole text or a
/// label beside an icon, tall enough for a label under one (about the reach `textAtPoint` in
/// packages/core looks in on a 1920 × 1080 screen), and kept inside the image.
fn around(focus: Focus, width: u32, height: u32) -> Option<Rect> {
    const SIDEWAYS: u32 = 320;
    const ABOVE: u32 = 48;
    const BELOW: u32 = 80;
    let (x, y) = (pixel(focus.x, width), pixel(focus.y, height));
    let left = x.saturating_sub(SIDEWAYS);
    let right = (x + SIDEWAYS).min(width);
    let top = y.saturating_sub(ABOVE);
    let bottom = (y + BELOW).min(height);
    (right > left && bottom > top).then_some(Rect {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    })
}

/// A click in a text box leaves the text caret where it clicked: a line a pixel or two wide
/// through the word there, which Windows OCR reads as part of a letter ("example" with the caret
/// after its "a" became "exa4nple"). It's told apart from a letter's stem by its height, since it runs from above
/// the letters to below them, and painted over with the background tone round it.
fn without_caret(image: &mut image::GrayImage, x: u32, y: u32) {
    /// Columns either side of the click the caret may be in.
    const REACH: u32 = 3;
    /// Columns either side whose letters the caret is compared with.
    const AROUND: u32 = 12;
    /// How far from the background a tone is to count as ink.
    const INK: u8 = 64;
    let (width, height) = image.dimensions();
    if x >= width || y >= height {
        return;
    }
    let mut counts = [0_u32; 256];
    for column in x.saturating_sub(AROUND)..(x + AROUND + 1).min(width) {
        for row in y.saturating_sub(AROUND)..(y + AROUND + 1).min(height) {
            counts[usize::from(image.get_pixel(column, row).0[0])] += 1;
        }
    }
    let background = (0..=u8::MAX)
        .max_by_key(|tone| counts[usize::from(*tone)])
        .unwrap_or(0);
    let ink = |column: u32, row: u32| image.get_pixel(column, row).0[0].abs_diff(background) > INK;
    // The ink running through the click's row in a column, as rows from and to.
    let through = |column: u32| {
        if !ink(column, y) {
            return None;
        }
        let top = (0..y).rev().take_while(|row| ink(column, *row)).count();
        let bottom = (y + 1..height).take_while(|row| ink(column, *row)).count();
        #[allow(
            clippy::cast_possible_truncation,
            reason = "counted rows of an image no taller than u32"
        )]
        Some((y - top as u32, y + 1 + bottom as u32))
    };
    // The longest stretch of ink in a column between two rows: a letter's stem.
    let longest = |column: u32, from: u32, to: u32| {
        let mut best = 0;
        let mut length = 0;
        for row in from..to {
            length = if ink(column, row) { length + 1 } else { 0 };
            best = best.max(length);
        }
        best
    };
    let carets: Vec<(u32, u32, u32)> = (x.saturating_sub(REACH)..(x + REACH + 1).min(width))
        .filter_map(|column| {
            let (from, to) = through(column)?;
            let tall = to - from;
            let letters = (column.saturating_sub(AROUND)..(column + AROUND + 1).min(width))
                .filter(|other| other.abs_diff(column) > 1)
                .map(|other| longest(other, from, to))
                .max()
                .unwrap_or(0);
            // Taller than any letter near by, by half as much again.
            (tall >= 8 && tall * 2 >= letters * 3).then_some((column, from, to))
        })
        .collect();
    for (column, from, to) in carets {
        for row in from..to {
            image.put_pixel(column, row, image::Luma([background]));
        }
    }
}

/// The area round the click, enlarged and in grey with its contrast stretched, so the darkest
/// and lightest tones there become black and white: faint text, text on coloured backgrounds
/// and anti-aliased edges all read more clearly.
fn closer_look(image: &image::RgbaImage, rect: Rect, click: (u32, u32)) -> image::RgbaImage {
    let part = image::imageops::crop_imm(image, rect.x, rect.y, rect.w, rect.h).to_image();
    let mut grey = image::DynamicImage::ImageRgba8(part).to_luma8();
    without_caret(
        &mut grey,
        click.0.saturating_sub(rect.x),
        click.1.saturating_sub(rect.y),
    );
    let mut enlarged = image::imageops::resize(
        &grey,
        rect.w * ENLARGE,
        rect.h * ENLARGE,
        image::imageops::FilterType::CatmullRom,
    );
    let mut counts = [0_u64; 256];
    for pixel in enlarged.pixels() {
        counts[usize::from(pixel.0[0])] += 1;
    }
    // The tones 1% in from each end, so a few stray pixels don't set the range.
    let total: u64 = counts.iter().sum();
    let tone_at = |share: u64| {
        let mut seen = 0;
        (0..=u8::MAX)
            .find(|tone| {
                seen += counts[usize::from(*tone)];
                seen * 100 > total * share
            })
            .map_or(0, u32::from)
    };
    let (dark, light) = (tone_at(1), tone_at(99));
    let span = light.saturating_sub(dark).max(1);
    for pixel in enlarged.pixels_mut() {
        let stretched = (u32::from(pixel.0[0]).saturating_sub(dark) * 255 / span).min(255);
        *pixel = image::Luma([u8::try_from(stretched).unwrap_or(u8::MAX)]);
    }
    image::DynamicImage::ImageLuma8(enlarged).to_rgba8()
}

/// A closer look's words, moved back to where they are on the whole image (still in pixels).
fn placed(
    lines: Vec<capture::platform::ocr::Line>,
    rect: Rect,
) -> Vec<capture::platform::ocr::Line> {
    #[allow(
        clippy::cast_precision_loss,
        reason = "image sides are at most a few thousand pixels"
    )]
    let (left, top, scale) = (rect.x as f32, rect.y as f32, ENLARGE as f32);
    lines
        .into_iter()
        .map(|line| {
            line.into_iter()
                .map(|word| capture::platform::ocr::Word {
                    x: left + word.x / scale,
                    y: top + word.y / scale,
                    width: word.width / scale,
                    height: word.height / scale,
                    ..word
                })
                .collect()
        })
        .collect()
}

/// A part of the image as percentages of it.
fn to_percent_area(rect: Rect, width: u32, height: u32) -> Area {
    #[allow(
        clippy::cast_precision_loss,
        reason = "image sides are at most a few thousand pixels"
    )]
    let (width, height) = (width as f32 / 100.0, height as f32 / 100.0);
    #[allow(
        clippy::cast_precision_loss,
        reason = "image sides are at most a few thousand pixels"
    )]
    Area {
        x: rect.x as f32 / width,
        y: rect.y as f32 / height,
        w: rect.w as f32 / width,
        h: rect.h as f32 / height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word_at(text: &str, x: f32, y: f32, w: f32) -> OcrWord {
        OcrWord {
            text: text.into(),
            x,
            y,
            w,
            h: 2.0,
        }
    }

    const AROUND_CLICK: Area = Area {
        x: 10.0,
        y: 10.0,
        w: 30.0,
        h: 10.0,
    };

    #[test]
    fn words_read_closer_up_replace_the_first_reading_round_the_click() {
        let whole = vec![
            OcrLine {
                words: vec![word_at("exa4nple.co.uk", 14.0, 14.0, 10.0)],
            },
            OcrLine {
                words: vec![word_at("Dashboard", 60.0, 14.0, 8.0)],
            },
        ];
        let near = vec![OcrLine {
            words: vec![word_at("example.co.uk", 14.1, 14.1, 10.0)],
        }];
        assert_eq!(
            closer(whole, near, &AROUND_CLICK),
            vec![
                OcrLine {
                    words: vec![word_at("example.co.uk", 14.1, 14.1, 10.0)],
                },
                OcrLine {
                    words: vec![word_at("Dashboard", 60.0, 14.0, 8.0)],
                },
            ]
        );
    }

    #[test]
    fn a_line_cut_by_the_edge_of_the_closer_look_is_left_to_the_first_reading() {
        // "Sam Jones" starts left of the area, so the closer look saw "m Jones": keeping its
        // "Jones" would split the name across two lines.
        let whole = vec![
            OcrLine {
                words: vec![
                    word_at("Sam", 8.0, 16.0, 3.0),
                    word_at("Jones", 11.5, 16.0, 3.0),
                ],
            },
            OcrLine {
                words: vec![
                    word_at("Sign", 20.0, 12.0, 3.0),
                    word_at("in", 23.5, 12.0, 1.0),
                ],
            },
        ];
        let near = vec![
            OcrLine {
                words: vec![
                    word_at("m", 10.0, 16.0, 1.0),
                    word_at("Jones", 11.5, 16.0, 3.0),
                ],
            },
            OcrLine {
                words: vec![
                    word_at("Sign", 20.0, 12.0, 3.0),
                    word_at("in", 23.5, 12.0, 1.0),
                ],
            },
        ];
        assert_eq!(
            closer(whole, near, &AROUND_CLICK),
            vec![
                OcrLine {
                    words: vec![
                        word_at("Sign", 20.0, 12.0, 3.0),
                        word_at("in", 23.5, 12.0, 1.0)
                    ],
                },
                OcrLine {
                    words: vec![
                        word_at("Sam", 8.0, 16.0, 3.0),
                        word_at("Jones", 11.5, 16.0, 3.0)
                    ],
                },
            ]
        );
    }

    /// Grey text on a dark field, as in the `SiteGround` site switcher: letters' stems 10 pixels
    /// high at columns 10 and 14.
    fn field() -> image::GrayImage {
        let mut image = image::GrayImage::from_pixel(40, 30, image::Luma([50]));
        for column in [10, 14] {
            for row in 10..20 {
                image.put_pixel(column, row, image::Luma([230]));
            }
        }
        image
    }

    #[test]
    fn the_text_caret_a_click_leaves_between_two_letters_is_taken_out() {
        // "field|moss": the caret is taller than the letters, from above them to below.
        let mut image = field();
        for row in 6..24 {
            image.put_pixel(12, row, image::Luma([250]));
        }
        without_caret(&mut image, 12, 15);
        assert_eq!(image, field());
    }

    #[test]
    fn a_letter_clicked_without_a_caret_is_left_alone() {
        let mut image = field();
        without_caret(&mut image, 10, 15);
        assert_eq!(image, field());
    }

    #[test]
    fn the_closer_look_is_the_same_size_on_any_screenshot_and_stays_inside_it() {
        // Text is as many pixels high in a small window's screenshot as in a whole screen's.
        let screen = around(Focus { x: 50.0, y: 50.0 }, 1920, 1032).expect("area");
        let window = around(Focus { x: 50.0, y: 50.0 }, 1000, 674).expect("area");
        assert_eq!((screen.w, screen.h), (window.w, window.h));
        // A click near a small window's left edge: the area starts at the edge.
        assert_eq!(
            around(Focus { x: 10.0, y: 50.0 }, 504, 674),
            Some(Rect {
                x: 0,
                y: 337 - 48,
                w: 50 + 320,
                h: 48 + 80
            })
        );
    }
}
