"""Cut a sprite pet's generated 2x2 sheets into aligned source frames (dev-only art step, before make-pet-strips.py).

Input:  <sheets>/<anim>.png   one 2x2 sheet per animation (idle, working, reply, waiting, offline, stand, wake),
                              frames in reading order (top-left, top-right, bottom-left, bottom-right), any square
                              size (the image model gives 1024 or 2048 px), transparent
Output: app/art/pet-<id>/frames/<anim>-<n>.png   n = 1..4, SRC_PX square, transparent, the figure bottom-centre
                                                 on the baseline y = BASE
(the motion-off stills are each loop's first frame: make-pet-strips.py takes them from here, NORMALISE included)

Every figure is scaled by ONE factor per pet (from the idle sheet: its first frame's figure becomes TARGET_H px
tall), so the sheets stay on the scale they were drawn at; make-pet-strips.py checks that the frames which
meet in a transition really match, and its per-pet NORMALISE fixes a sheet that was not.

Each cell is placed by its feet, not by its bounding box: the bottom of the figure goes on the baseline and the
middle of its lowest rows (feet, a book it lies on) on the centre line. A raised letter or a "?" then moves
inside the frame instead of shifting the whole figure.

The image model paints a soft semi-transparent glow around each figure even when told not to. ALPHA_LO..HI
turns it into a crisp edge: alpha below LO is cut, above HI is solid, a short ramp keeps the outline smooth.

The raw sheets are large and stay out of the repository (keep them in a local folder outside the repository, one per pet id);
the frames this script writes are what the repository keeps.

Run: python app/scripts/split-pet-sheets.py <id> <sheets-dir>        (needs Pillow)
"""
import os
import sys

from PIL import Image, ImageDraw

SRC_PX = 512
BASE = 482  # baseline y in the source canvas (Karakter: 361 of 384, the same 94%)
TARGET_H = 300  # the idle figure's height on the source canvas (Karakter's sitting idle: 235 of 384 = 61%)
ALPHA_LO, ALPHA_HI = 120, 190
FOOT_ROWS = 0.12  # the lowest share of the figure that decides its horizontal place
ANIMS = ["idle", "working", "reply", "waiting", "offline", "stand", "wake"]
MARGIN = 6  # px kept free at the canvas top and sides

APP = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def dehalo(im):
    """The model's glow halo cut into a crisp edge (see ALPHA_LO/HI)."""
    span = ALPHA_HI - ALPHA_LO
    a = im.getchannel("A").point(lambda v: 0 if v < ALPHA_LO else 255 if v > ALPHA_HI else round((v - ALPHA_LO) * 255 / span))
    out = im.copy()
    out.putalpha(a)
    return out


def cells(sheet):
    w, h = sheet.size
    cw, ch = w // 2, h // 2
    return [drop_strays(sheet.crop((x * cw, y * ch, x * cw + cw, y * ch + ch))) for y in (0, 1) for x in (0, 1)]


def drop_strays(cell, keep_share=0.15):
    """Removes small pieces that touch the cell's edge: a neighbouring frame's prop that reached over the
    grid line. A piece bigger than keep_share of the cell's drawing stays (a wing tip the model let touch it)."""
    m = cell.getchannel("A").point(lambda v: 255 if v > 0 else 0)
    total = m.histogram()[255]
    if not total:
        return cell
    w, h = m.size
    px = m.load()
    edge = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    changed = False
    for xy in edge:
        if px[xy] != 255:
            continue
        ImageDraw.floodfill(m, xy, 1)
        if m.histogram()[1] < total * keep_share:
            ImageDraw.floodfill(m, xy, 0)
            changed = True
        else:
            ImageDraw.floodfill(m, xy, 2)  # a real part of the figure: keep, and do not visit again
    if not changed:
        return cell
    a = Image.composite(cell.getchannel("A"), Image.new("L", m.size, 0), m.point(lambda v: 255 if v else 0))
    out = cell.copy()
    out.putalpha(a)
    return out


def figure(cell):
    """(bbox, foot centre x) of a cell's figure, in cell px; None when the cell is empty."""
    a = cell.getchannel("A")
    box = a.point(lambda v: 255 if v > 0 else 0).getbbox()
    if not box:
        return None
    x0, y0, x1, y1 = box
    rows = max(2, round((y1 - y0) * FOOT_ROWS))
    feet = a.crop((x0, y1 - rows, x1, y1)).point(lambda v: 255 if v > 0 else 0)
    hist = [0] * (x1 - x0)
    px = feet.load()
    for y in range(rows):
        for x in range(x1 - x0):
            if px[x, y]:
                hist[x] += 1
    total = sum(hist) or 1
    cx = x0 + sum(i * v for i, v in enumerate(hist)) / total
    return box, cx


def place(cell, scale):
    """The cell's figure scaled and set on the shared baseline and centre line of an SRC_PX canvas."""
    f = figure(cell)
    canvas = Image.new("RGBA", (SRC_PX, SRC_PX), (0, 0, 0, 0))
    if not f:
        return canvas, None
    (x0, y0, x1, y1), cx = f
    crop = cell.crop((x0, y0, x1, y1))
    w, h = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
    crop = crop.convert("RGBa").resize((w, h), Image.LANCZOS).convert("RGBA")
    left = round(SRC_PX / 2 - (cx - x0) * scale)
    top = BASE - h
    # composite on a padded canvas, then cut: a figure that overhangs the edge is clipped, never misplaced
    pad = SRC_PX
    big = Image.new("RGBA", (SRC_PX + 2 * pad, SRC_PX + 2 * pad), (0, 0, 0, 0))
    big.alpha_composite(crop, (left + pad, top + pad))
    canvas = big.crop((pad, pad, pad + SRC_PX, pad + SRC_PX))
    warn = None
    if top < MARGIN or left < MARGIN or left + w > SRC_PX - MARGIN:
        warn = f"figure touches the canvas edge (left {left}, top {top}, right {left + w})"
    return canvas, warn


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pid, src = sys.argv[1], sys.argv[2]
    sheets = {}
    for anim in ANIMS:
        p = os.path.join(src, f"{anim}.png")
        if not os.path.exists(p):
            sys.exit(f"missing sheet: {p}")
        im = Image.open(p).convert("RGBA")
        if im.size[0] != im.size[1]:
            sys.exit(f"{p}: not square {im.size}")
        sheets[anim] = dehalo(im)
    ref = sheets["idle"].size[0]
    f = figure(cells(sheets["idle"])[0])
    if not f:
        sys.exit("idle frame 1 is empty")
    base_scale = TARGET_H / (f[0][3] - f[0][1])
    out = os.path.join(APP, "art", f"pet-{pid}")
    os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    warnings = []
    for anim, sheet in sheets.items():
        scale = base_scale * ref / sheet.size[0]  # a 1k and a 2k sheet of one pet share the drawn scale
        for n, cell in enumerate(cells(sheet), 1):
            frame, warn = place(cell, scale)
            frame.save(os.path.join(out, "frames", f"{anim}-{n}.png"), optimize=True)
            if warn:
                warnings.append(f"  {anim}-{n}: {warn}")
    print(f"split {pid}: {len(ANIMS)} sheets -> {len(ANIMS) * 4} frames ({SRC_PX}px, scale {base_scale:.3f}) in {out}")
    if warnings:
        print("check these frames:\n" + "\n".join(warnings))


if __name__ == "__main__":
    main()
