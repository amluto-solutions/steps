//! Screenshots from the X server (docs/spec/02-capture.md#on-each-click): `GetImage` on the root
//! window reads what's on screen, as Windows' GDI reads the composed desktop, so a window's
//! decorations and anything over it are in the picture as the person saw them.

use image::RgbaImage;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder};

use crate::connection::shared;
use crate::{Error, Rect, Result};

/// The screen inside `area`, as RGBA pixels.
///
/// # Errors
/// If there's no X server, the area is empty or off the screen, or the screen's pixel format
/// isn't 32 bits per pixel (the only one current X servers use for colour screens).
pub fn capture(area: Rect) -> Result<RgbaImage> {
    let display = shared().ok_or_else(|| Error::NoDisplay("no X server".into()))?;
    let setup = display.connection.setup();
    let screen = setup
        .roots
        .iter()
        .find(|screen| screen.root == display.root)
        .ok_or_else(|| Error::NoDisplay("the X server has no such screen".into()))?;
    let bounds = Rect {
        left: 0,
        top: 0,
        right: i32::from(screen.width_in_pixels),
        bottom: i32::from(screen.height_in_pixels),
    };
    let clipped = Rect {
        left: area.left.max(bounds.left),
        top: area.top.max(bounds.top),
        right: area.right.min(bounds.right),
        bottom: area.bottom.min(bounds.bottom),
    };
    let convert = |value: i32| i16::try_from(value).map_err(|error| Error::X11(error.to_string()));
    let size = |value: i32| u16::try_from(value).map_err(|error| Error::X11(error.to_string()));
    if clipped.width() <= 0 || clipped.height() <= 0 {
        return Err(Error::X11("the area is off the screen".into()));
    }
    let reply = display
        .connection
        .get_image(
            ImageFormat::Z_PIXMAP,
            display.root,
            convert(clipped.left)?,
            convert(clipped.top)?,
            size(clipped.width())?,
            size(clipped.height())?,
            u32::MAX,
        )?
        .reply()?;
    let bits_per_pixel = setup
        .pixmap_formats
        .iter()
        .find(|format| format.depth == reply.depth)
        .map_or(0, |format| format.bits_per_pixel);
    if bits_per_pixel != 32 {
        return Err(Error::X11(format!(
            "screens with {bits_per_pixel} bits per pixel can't be captured"
        )));
    }
    let width = u32::try_from(clipped.width()).unwrap_or(0);
    let height = u32::try_from(clipped.height()).unwrap_or(0);
    let little_endian = setup.image_byte_order == ImageOrder::LSB_FIRST;
    Ok(to_rgba(&reply.data, width, height, little_endian))
}

/// 32-bit `ZPixmap` pixels (`BGRX` in memory on a little-endian server) as RGBA.
fn to_rgba(data: &[u8], width: u32, height: u32, little_endian: bool) -> RgbaImage {
    let mut image = RgbaImage::new(width, height);
    for (pixel, &[a, b, c, d]) in image.pixels_mut().zip(data.as_chunks::<4>().0) {
        pixel.0 = if little_endian {
            [c, b, a, 255]
        } else {
            [b, c, d, 255]
        };
    }
    image
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_pixels_become_rgba() {
        // One blue pixel then one red one, as a little-endian server sends them (B, G, R, X).
        let image = to_rgba(&[255, 0, 0, 0, 0, 0, 255, 0], 2, 1, true);
        assert_eq!(image.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(image.get_pixel(1, 0).0, [255, 0, 0, 255]);
        // Big-endian: X, R, G, B.
        let image = to_rgba(&[0, 10, 20, 30], 1, 1, false);
        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }
}
