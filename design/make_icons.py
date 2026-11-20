"""Turn a generated 1024 px icon concept into a rounded master, per-size PNG frames and a multi-size .ico.

Usage: python make_icons.py <concept.png> <out_dir> <name> [content_fraction]

The symbol is found by its edges (the backgrounds are smooth gradients), the tile is cropped so the
symbol fills `content_fraction` of it (never zooming out past the original canvas), and the corners
are rounded. Small frames get a light sharpen so they stay crisp in Explorer and the VS Code UI.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
RADIUS = 0.22  # corner radius as a share of the tile


def symbol_bbox(img):
    gray = img.convert("L").filter(ImageFilter.GaussianBlur(1.5))
    edges = gray.filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 12 else 0)
    w, h = img.size
    m = int(w * 0.03)  # ignore the outer border
    edges = edges.crop((m, m, w - m, h - m))
    l, t, r, b = edges.getbbox()
    return l + m, t + m, r + m, b + m


def master(src, fraction):
    img = Image.open(src).convert("RGB")
    W, H = img.size
    l, t, r, b = symbol_bbox(img)
    side = min(int(round(max(r - l, b - t) / fraction)), W, H)
    cx, cy = (l + r) / 2, (t + b) / 2
    x0 = int(round(min(max(cx - side / 2, 0), W - side)))
    y0 = int(round(min(max(cy - side / 2, 0), H - side)))
    tile = img.crop((x0, y0, x0 + side, y0 + side)).resize((1024, 1024), Image.LANCZOS)
    big = 4096
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * RADIUS), fill=255)
    tile = tile.convert("RGBA")
    tile.putalpha(mask.resize((1024, 1024), Image.LANCZOS))
    print(f"  symbol {l},{t},{r},{b} ({r - l}x{b - t}) -> crop {side}px at {x0},{y0}")
    return tile


def frame(m, s):
    im = m.resize((s, s), Image.LANCZOS)
    if s <= 48:
        rgb, a = im.convert("RGB"), im.getchannel("A")
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius=0.6, percent=70, threshold=0))
        im = rgb.convert("RGBA")
        im.putalpha(a)
    return im


if __name__ == "__main__":
    src, out, name = sys.argv[1], sys.argv[2], sys.argv[3]
    fraction = float(sys.argv[4]) if len(sys.argv) > 4 else 0.80
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    m = master(src, fraction)
    m.save(os.path.join(out, f"{name}-1024.png"))
    frames = {s: frame(m, s) for s in SIZES}
    for s, im in frames.items():
        im.save(os.path.join(out, "frames", f"{name}-{s}.png"))
    ico = os.path.join(out, f"{name}.ico")
    frames[256].save(ico, format="ICO", sizes=[(s, s) for s in SIZES],
                     append_images=[frames[s] for s in SIZES if s != 256])
    print(f"  {ico}: {os.path.getsize(ico)} bytes, sizes {sorted(Image.open(ico).info.get('sizes', []))}")
