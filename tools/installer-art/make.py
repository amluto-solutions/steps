"""Draws the setup .exe's side panel and header in Steps' colours (bundle.windows.nsis in
tauri.conf.json), in place of NSIS's stock artwork. Run from the repo root after the mark or the
colours change:  python tools/installer-art/make.py

NSIS wants 24-bit BMPs: the side panel 164 x 314 (welcome and finish pages), the header 150 x 57
(every other page, at the right). Drawn at 2x and scaled down so the edges stay smooth."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
TAURI = ROOT / "apps" / "desktop" / "src-tauri"
NAVY = (14, 37, 66)  # brand navy, --amluto-navy
CYAN = (59, 168, 198)  # the mark's top step
WHITE = (255, 255, 255)
FONTS = Path("C:/Windows/Fonts")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def mark(size: int) -> Image.Image:
    return Image.open(TAURI / "icons" / "icon.png").convert("RGBA").resize((size, size), Image.LANCZOS)


def sidebar() -> Image.Image:
    scale = 2
    width, height = 164 * scale, 314 * scale
    image = Image.new("RGB", (width, height), NAVY)
    draw = ImageDraw.Draw(image)
    logo = mark(72 * scale)
    image.paste(logo, ((width - logo.width) // 2, 56 * scale), logo)
    title = font("GOTHICB.TTF", 30 * scale)
    by = font("GOTHIC.TTF", 13 * scale)
    centre = width // 2
    draw.text((centre, 150 * scale), "Steps", font=title, fill=WHITE, anchor="mt")
    draw.text((centre, 190 * scale), "by Amluto", font=by, fill=CYAN, anchor="mt")
    return image.resize((164, 314), Image.LANCZOS)


def header() -> Image.Image:
    scale = 2
    width, height = 150 * scale, 57 * scale
    image = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(image)
    logo = mark(38 * scale)
    right = width - 8 * scale
    image.paste(logo, (right - logo.width, (height - logo.height) // 2), logo)
    draw.text(
        (right - logo.width - 8 * scale, height // 2),
        "Steps",
        font=font("GOTHICB.TTF", 17 * scale),
        fill=NAVY,
        anchor="rm",
    )
    return image.resize((150, 57), Image.LANCZOS)


if __name__ == "__main__":
    out = TAURI / "nsis"
    sidebar().save(out / "sidebar.bmp")
    header().save(out / "header.bmp")
    print("wrote", out / "sidebar.bmp", "and", out / "header.bmp")
