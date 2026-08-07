from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
GLYPH = "ƒ"
CANVAS_SIZE = 1024
SUPERSAMPLE = 4


def find_brand_font() -> Path:
    candidates = (
        Path("C:/Windows/Fonts/georgiai.ttf"),
        Path("/System/Library/Fonts/Supplemental/Georgia Italic.ttf"),
        Path("/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("A supported italic serif font is required to generate the Fate UI icon.")


def render_master() -> Image.Image:
    canvas = CANVAS_SIZE * SUPERSAMPLE
    image = Image.new("RGB", (canvas, canvas), "white")
    draw = ImageDraw.Draw(image)
    font_path = find_brand_font()

    # Match the in-app Georgia function mark while retaining enough white space
    # for Windows taskbar and installer icon masks.
    font_size = int(canvas * 0.82)
    font = ImageFont.truetype(str(font_path), font_size)
    bounds = draw.textbbox((0, 0), GLYPH, font=font, stroke_width=0)
    glyph_width = bounds[2] - bounds[0]
    glyph_height = bounds[3] - bounds[1]
    target_height = canvas * 0.70
    if glyph_height > target_height:
        font_size = int(font_size * target_height / glyph_height)
        font = ImageFont.truetype(str(font_path), font_size)
        bounds = draw.textbbox((0, 0), GLYPH, font=font, stroke_width=0)
        glyph_width = bounds[2] - bounds[0]
        glyph_height = bounds[3] - bounds[1]

    position = (
        (canvas - glyph_width) / 2 - bounds[0],
        (canvas - glyph_height) / 2 - bounds[1],
    )
    draw.text(position, GLYPH, font=font, fill="black")
    return image.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS).convert("RGBA")


def render(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    icons = BUILD / "icons"
    icons.mkdir(parents=True, exist_ok=True)
    master = render_master()
    rendered = {size: render(master, size) for size in SIZES}
    rendered[1024].save(BUILD / "icon.png")
    for size, image in rendered.items():
        image.save(icons / f"{size}x{size}.png")
    rendered[256].save(BUILD / "icon.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    rendered[1024].save(BUILD / "icon.icns", format="ICNS")


if __name__ == "__main__":
    main()
