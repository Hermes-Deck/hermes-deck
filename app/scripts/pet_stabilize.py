"""Steady frames for the sprite pets (dev-only art step, used by make-pet-strips.py).

The sheet pets' frames were each drawn from scratch, so between two frames of one loop the scarf, the bag and
the body outline all change a little. Played at 4-6 fps that reads as the figure "boiling". A steady frame is
the loop's base frame with only the parts that should move pasted in from the drawn frame: the eyes for a
blink, the wing and quill for a stroke, the head for a tilt. Everything outside those patches is the base
frame pixel for pixel, so it cannot move.

A patch: {"box": (x0, y0, x1, y1), "feather": px, "align": True, "shape": "rect" | "ellipse"} in source px.
  box      the region taken from the drawn frame;
  feather  how soft its edge is (a Gaussian blur of the mask, in px), so the seam does not show;
  align    first move the drawn region onto the base by the shift (within +-ALIGN_PX) where they match best,
           so an eye lands where the base's eye is. Leave it off when the motion IS the shift (a head tilt).
Compositing runs on premultiplied alpha, like the rest of make-pet-strips.py, so edges get no dark fringe.
Needs numpy and Pillow.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ALIGN_PX = 12


def _arr(im):
    """An RGBa (premultiplied) image as a float array, 0..1."""
    return np.asarray(im, dtype=np.float32) / 255.0


def best_shift(base, frame, box, reach=ALIGN_PX):
    """(dx, dy) that moves `frame`'s pixels in `box` onto `base` with the least squared difference."""
    x0, y0, x1, y1 = box
    ref = base[y0:y1, x0:x1]
    h, w = base.shape[:2]
    best, arg = None, (0, 0)
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            sx0, sy0, sx1, sy1 = x0 - dx, y0 - dy, x1 - dx, y1 - dy
            if sx0 < 0 or sy0 < 0 or sx1 > w or sy1 > h:
                continue
            err = float(np.mean((frame[sy0:sy1, sx0:sx1] - ref) ** 2))
            if best is None or err < best:
                best, arg = err, (dx, dy)
    return arg


def _mask(size, box, feather, shape):
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    # shrink by the feather so the soft edge stays inside the box (nothing outside it can change)
    f = feather
    rect = (box[0] + f, box[1] + f, box[2] - f, box[3] - f)
    (d.ellipse if shape == "ellipse" else d.rectangle)(rect, fill=255)
    if f:
        m = m.filter(ImageFilter.GaussianBlur(f / 2))
    return np.asarray(m, dtype=np.float32)[..., None] / 255.0


def tilt(base, p):
    """The base frame with its head turned: everything in p["box"] above p["cut"] rotated by p["rotate"] degrees
    (positive = counter-clockwise on screen) about p["pivot"]. Inside the box the old head is dropped, so no ghost
    of an ear stays behind; over the last p["feather"] px above the cut the turned head fades into the base, which
    hides the seam under the scarf or the chin."""
    x0, y0, x1, y1 = p["box"]
    cut, f = p["cut"], p.get("feather", 10)
    turned = _arr(base.rotate(p["rotate"], resample=Image.BICUBIC, center=tuple(p["pivot"])))
    m = np.zeros(base.size[::-1] + (1,), dtype=np.float32)
    ramp = np.clip((cut - np.arange(m.shape[0], dtype=np.float32)) / max(1, f), 0, 1)
    m[y0:y1, x0:x1, 0] = ramp[y0:y1, None]
    b = _arr(base)
    return Image.fromarray(np.clip((turned * m + b * (1 - m)) * 255 + 0.5, 0, 255).astype(np.uint8), "RGBa")


def steady(base, frame, patches):
    """`base` with each patch of `frame` pasted in (a patch with "rotate" turns the head instead, see tilt()).
    Both are RGBa images of one size; returns RGBa."""
    for p in patches:
        if "rotate" in p:
            base = tilt(base, p)
    patches = [p for p in patches if "rotate" not in p]
    b = _arr(base)
    f = _arr(frame)
    out = b.copy()
    for p in patches:
        box = tuple(p["box"])
        piece = f
        if p.get("align", True):
            dx, dy = best_shift(b, f, box)
            piece = np.roll(f, (dy, dx), axis=(0, 1))
        m = _mask(base.size, box, p.get("feather", 8), p.get("shape", "rect"))
        out = out * (1 - m) + piece * m
    return Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8), "RGBa")
