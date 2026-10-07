"""Pack a sprite pet's frames into the strips the pet page animates (dev-only art step).

Input:  app/art/pet-<id>/frames/<anim>-<n>.png  (n = 1..4, square, transparent, bottom-centre on the baseline)
        app/art/pet-<id>/stills/<state>.png     (same canvas and alignment)
Output: app/renderer/pets/<id>/<anim>.png        4 frames side by side at 1x (FRAME px each)
        app/renderer/pets/<id>/<anim>@2x.png     the same at 2x (and @3x for the pets drawn at 512 px)
        app/renderer/pets/<id>/still-<state>.png (+ @2x, @3x) the reduced-motion stills

Karakter's frames are 384 px (baseline y=361) and were drawn by hand-picked generations; the newer pets come
from 2x2 sheets through split-pet-sheets.py at 512 px (baseline y=482). PETS below holds what differs per pet.

The page shows one FRAME x FRAME box and moves the strip with CSS steps(), so every frame has to keep one
alignment (same baseline, same scale), or a cross-fade between two animations shows two figures of different
sizes. Frames are downscaled once here with Lanczos on premultiplied alpha (no dark fringes), which looks
sharper than letting the browser shrink the 384 px originals.

Two source loops were drawn off the shared scale (measured with mask and colour fits against the frames they
meet): `working` about 8% too large and to the right, `waiting` about 13-15% too small and to the left.
NORMALISE scales them about the feet (x=192, y=361) and moves them onto the shared scale. `waiting-3` is a
different pose (arms down, the bag on the other side), so ORDER plays waiting as 1-2-4-2 and the loop never
twitches into it. Drop both entries once that art is redrawn at the shared scale.

check() guards this: it fails when a loop's first frame and the frame it meets (a transition strip's end, or
its own still) overlap clearly better at another scale than at the one they are packed at.

Run from the repo root or app/: python app/scripts/make-pet-strips.py [<id>]          (needs Pillow; id: character)
                                python app/scripts/make-pet-strips.py <id> --check  (only the scale check)
                                python app/scripts/make-pet-strips.py <id> --check --raw   (without NORMALISE)
"""
import os
import sys

from PIL import Image, ImageChops

FRAME = 144  # CSS px of one frame box in renderer/pets/skins/sprite.css
ANIMS = ["idle", "working", "reply", "waiting", "offline", "stand", "wake"]
STILLS = ["idle", "working", "reply", "waiting", "offline"]
N = 4

# Per pet. src: source canvas px; feet: the scale origin (the figure's bottom-centre on the baseline);
# normalise: anim (or one frame, "<anim>-<n>") -> (scale, dx in source px), brings an off-scale loop or frame onto
# the shared scale; order: anim ->
# which source frame fills each of the strip's four slots; scales: the strip resolutions written.
# stills "frames": each still is its loop's first frame (NORMALISE included), not a separate drawing
SPLIT = {"src": 512, "feet": (256, 482), "normalise": {}, "order": {}, "scales": (1, 2, 3), "stills": "frames"}  # split-pet-sheets.py
PETS = {
    # Karakter: waiting stops at 1.13, its "?" (waiting-2, alpha top y=43) must stay inside the frame
    "character": {"src": 384, "feet": (192, 361), "normalise": {"working": (0.92, -12), "waiting": (1.13, 11)},
                  "order": {"waiting": [1, 2, 4, 2]}, "scales": (1, 2)},
    "owl": {**SPLIT, "normalise": {"waiting": (1.12, 0)}},  # its waiting sheet came out ~12% small
    # the cats wait sitting (pets/skins/<id>.js passes poses: {waiting: "sit"} to the skin)
    # (and, like Karakter and the owl, their waiting sheets came out ~12% small: the "?" shrinks the figure)
    # Hasret's and Hayat's idle sheets came out ~5% large against their other sheets
    "leo": {**SPLIT, "poses": {"waiting": "sit"}, "normalise": {"waiting": (1.16, 0)}},
    "hasret": {**SPLIT, "poses": {"waiting": "sit"}, "normalise": {"idle": (0.94, 0), "working": (0.97, 0), "waiting": (1.11, 0), "wake-1": (0.93, 0)}},
    "hayat": {**SPLIT, "poses": {"waiting": "sit"}, "normalise": {"idle": (0.96, 0), "waiting": (1.14, 0)}},
    "philosopher": {**SPLIT, "normalise": {"waiting": (1.12, 0), "wake-1": (0.93, 0), "wake-4": (1.04, 0)}},
}
PET = "character"
SRC_PX = 384
FEET = (192, 361)
NORMALISE = {}
ORDER = {}

# (a, b): a loop's first frame and what it meets in a transition ("still:<state>": the motion-off still)
MEETS = [
    ("idle-1", "stand-1"), ("idle-1", "wake-4"), ("working-1", "stand-1"), ("working-1", "wake-4"),
    ("reply-1", "stand-4"), ("waiting-1", "stand-4"), ("waiting-1", "reply-1"), ("offline-1", "wake-1"),
    ("idle-1", "still:idle"), ("working-1", "still:working"), ("reply-1", "still:reply"),
    ("waiting-1", "still:waiting"), ("offline-1", "still:offline"),
]
SCALES = (0.88, 0.92, 0.96, 1.0, 1.04, 1.08, 1.12)
# Mask IoU another scale may gain before a pair counts as drawn at different sizes. 0.05 catches the 8% and
# 13% errors above (they gained 0.07-0.10) and lets through offline-1 ~ wake-1, which gains 0.045 at 1.04:
# wake-1 is drawn ~4% larger than the offline loop and its still, a small step inside a 120 ms cross-fade.
SLACK = 0.05

APP = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SRC = OUT = None


POSE = {"idle": "sit", "working": "sit", "reply": "stand", "waiting": "stand", "offline": "lie"}  # PetLogic.POSE
# where each transition strip starts and ends (frame 1 and frame 4), as in PetLogic.STRIPS
ENDS = {"sit": ["stand-1", "wake-4"], "stand": ["stand-4"], "lie": ["wake-1"]}


def meets(poses):
    """A sheet pet's MEETS: each loop's first frame against the strip ends of its pose and its own still, plus
    loops of one pose against each other (they cross-fade)."""
    p = {**POSE, **poses}
    pairs = [(f"{a}-1", end) for a in POSE for end in ENDS[p[a]]]
    loops = list(POSE)
    pairs += [(f"{a}-1", f"{b}-1") for i, a in enumerate(loops) for b in loops[i + 1:] if p[a] == p[b]]
    return pairs + [(f"{a}-1", f"still:{a}") for a in POSE]


def use(pid):
    """Points the module-level settings at one pet from PETS."""
    global PET, SRC_PX, FEET, NORMALISE, ORDER, SRC, OUT, MEETS
    if pid not in PETS:
        sys.exit(f"unknown pet {pid!r}; known: {', '.join(PETS)}")
    c = PETS[pid]
    PET, SRC_PX, FEET, NORMALISE, ORDER = pid, c["src"], c["feet"], c["normalise"], c["order"]
    if c is not PETS["character"]:
        MEETS = meets(c.get("poses", {}))
    SRC = os.path.join(APP, "art", f"pet-{pid}")
    OUT = os.path.join(APP, "renderer", "pets", pid)


def affine(im, scale, dx=0, dy=0):
    """im scaled by `scale` about FEET and moved by (dx, dy) source px, on the same canvas."""
    if scale == 1 and not dx and not dy:
        return im
    cx, cy = FEET
    a = 1 / scale
    return im.transform(im.size, Image.AFFINE, (a, 0, cx - (cx + dx) * a, 0, a, cy - (cy + dy) * a), resample=Image.BICUBIC)


def source(name, raw=False):
    """A 384 px source frame ("<anim>-<n>" or "still:<state>") on the shared scale, as premultiplied RGBa."""
    if name.startswith("still:") and PETS[PET].get("stills") == "frames":
        name = f"{name[6:]}-1"
    still = name.startswith("still:")
    path = os.path.join(SRC, "stills", f"{name[6:]}.png") if still else os.path.join(SRC, "frames", f"{name}.png")
    im = Image.open(path).convert("RGBA")
    if im.size != (SRC_PX, SRC_PX):
        sys.exit(f"{path}: expected {SRC_PX}x{SRC_PX}, got {im.size}")
    im = im.convert("RGBa")
    if not still and not raw:
        scale, dx = NORMALISE.get(name, NORMALISE.get(name.rsplit("-", 1)[0], (1, 0)))  # "<anim>-<n>" beats "<anim>"
        im = affine(im, scale, dx)
    return im


def scaled(name, px):
    """A source frame on the shared scale at px x px, resized on premultiplied alpha."""
    return source(name).resize((px, px), Image.LANCZOS).convert("RGBA")


# ---------------------------------------------------------------- scale check
def mask(im):
    # band 3 is the alpha: "A" in RGBA, "a" in premultiplied RGBa
    return im.getchannel(3).point(lambda v: 255 if v > 96 else 0).convert("1")


def iou(a, b):
    inter = ImageChops.logical_and(a, b).histogram()[-1]
    union = ImageChops.logical_or(a, b).histogram()[-1]
    return inter / max(1, union)


def check(raw=False):
    """Fails when a MEETS pair overlaps clearly better at another scale than at the packed one."""
    bad = []
    for a, b in MEETS:
        A = source(a, raw)
        B = mask(source(b, raw))
        fits = {s: max(iou(mask(affine(A, s, dx)), B) for dx in range(-16, 17, 4)) for s in SCALES}
        best = max(fits, key=fits.get)
        line = f"  {a:>10} ~ {b:<14} iou {fits[1.0]:.3f} at 1.00, best {fits[best]:.3f} at {best:.2f}"
        print(line)
        if fits[best] - fits[1.0] > SLACK:
            bad.append(line)
    if bad:
        sys.exit("pet strips: frames drawn at different sizes (fix the art or NORMALISE):\n" + "\n".join(bad))
    print(f"pet strips: scale check passed ({len(MEETS)} pairs)")


def save(im, name):
    im.save(os.path.join(OUT, name), optimize=True)


def main():
    args = sys.argv[1:]
    names = [a for a in args if not a.startswith("--")]
    use(names[0] if names else "character")
    check(raw="--raw" in args)
    if "--check" in args:
        return
    os.makedirs(OUT, exist_ok=True)
    for scale in PETS[PET]["scales"]:
        suffix = "" if scale == 1 else f"@{scale}x"
        px = FRAME * scale
        for anim in ANIMS:
            strip = Image.new("RGBA", (px * N, px), (0, 0, 0, 0))
            for slot, n in enumerate(ORDER.get(anim, range(1, N + 1))):
                strip.alpha_composite(scaled(f"{anim}-{n}", px), (slot * px, 0))
            save(strip, f"{anim}{suffix}.png")
        for state in STILLS:
            save(scaled(f"still:{state}", px), f"still-{state}{suffix}.png")
    print(f"pet strips {PET}: {len(ANIMS)} animations x {N} frames, {len(STILLS)} stills at {PETS[PET]['scales']}x {FRAME}px -> {OUT}")


if __name__ == "__main__":
    main()
