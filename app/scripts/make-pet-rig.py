"""Cut scene drawings into full-canvas rig layers (dev-only, Python 3.12 + numpy/Pillow).

CSS moves these pieces about pivots, so removed heads must leave no ghost in the
body. Tail roots deliberately overlap; lifted paws keep their backing pixels.
All cutting, alignment and Lanczos resizing use premultiplied RGBa to avoid fringes.

Run: python app/scripts/make-pet-rig.py <id> [--preview]
Input: app/art/pet-<id>/rig/{cuts.json,<scene>.png,<scene>.face-<name>.png,<props>}
Output: app/renderer/pets/<id>/<scene>-<layer>[,@2x,@3x].png (144/288/432 px).
Preview writes only rig/_preview-<scene>.png, with masks and a recombined panel.
The check stacks the layers source-over, as the page does, and fails when the
result is see-through anywhere inside the figure (a hole or a seam).
"""
import argparse
import json
from pathlib import Path
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from pet_stabilize import _arr, _mask, best_shift

APP = Path(__file__).resolve().parents[1]
SIZE = 512


def require(ok, message):
    if not ok:
        sys.exit(f"pet rig: {message}")


def name(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]+", value),
            f"invalid name: {value!r}")
    return value


def name_file(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]+\.png", value), f"invalid file: {value!r}")
    return value


def numbers(value, count):
    require(isinstance(value, list) and len(value) == count and
            all(type(v) in (int, float) and np.isfinite(v) for v in value),
            f"expected {count} finite numbers, got {value!r}")
    return value


def box(value):
    x0, y0, x1, y1 = numbers(value, 4)
    require(all(type(v) is int for v in value) and
            0 <= x0 < x1 <= SIZE and 0 <= y0 < y1 <= SIZE, f"invalid box: {value}")
    return x0, y0, x1, y1


def amount(value):
    numbers([value], 1)
    require(0 <= value <= SIZE, f"expected a value in 0..{SIZE}, got {value}")
    return value


SCARF = None  # cuts.json "scarf": [r, g, b], the colour this pet's teal scarf is drawn in


def recolour(rgba, colour):
    """The drawings' teal scarf in another colour: each teal pixel keeps its shading (luminance relative to the
    scarf's mid tone) on the new colour; edges blend by how teal they are. Fur, eyes and props never are."""
    rgb = rgba[..., :3]
    teal = np.minimum(rgb[..., 1] - rgb[..., 0], rgb[..., 2] - rgb[..., 0])
    w = np.clip((teal - 18) / 30, 0, 1)[..., None] * (rgba[..., 3:] > 0)
    lum = rgb.mean(-1, keepdims=True)
    target = np.clip(np.asarray(colour, np.float32)[None, None] * (lum / 112.0), 0, 255)
    out = rgba.copy()
    out[..., :3] = rgb * (1 - w) + target * w
    return out


def drawn(path):
    with Image.open(path) as im:
        require(im.format == "PNG" and im.mode == "RGBA" and im.size == (SIZE, SIZE),
                f"{path}: expected {SIZE}x{SIZE} RGBA PNG, got {im.size} {im.mode}")
        rgba = np.asarray(im, np.float32)
    if SCARF is not None:
        rgba = recolour(rgba, SCARF)
    return _arr(Image.fromarray(np.clip(rgba + 0.5, 0, 255).astype(np.uint8), "RGBA").convert("RGBa"))


def image(pixels):
    return Image.fromarray(np.clip(pixels * 255 + 0.5, 0, 255).astype(np.uint8), "RGBa")


def polygon(points, feather):
    """An anti-aliased polygon mask (drawn at 4x, downsampled), softened by a Gaussian of `feather` px."""
    require(isinstance(points, list) and len(points) >= 3, "poly needs at least three points")
    points = [tuple(4 * v for v in numbers(p, 2)) for p in points]
    require(all(0 <= v <= SIZE * 4 for p in points for v in p), "poly exceeds canvas")
    mask = Image.new("L", (SIZE * 4, SIZE * 4))
    ImageDraw.Draw(mask).polygon(points, fill=255)
    mask = mask.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    mask = mask.filter(ImageFilter.GaussianBlur(amount(feather)))
    return np.asarray(mask, dtype=np.float32)[..., None] / 255


def masks(spec):
    require(isinstance(spec, dict) and ("poly" in spec) != ("box" in spec),
            "each layer needs either poly or box")
    if "box" in spec:
        require(not {"keep", "lift"} & spec.keys(), "keep/lift require a polygon")
        x0, y0, x1, y1 = box(spec["box"])
        cut, ramp = amount(spec["cut"]), amount(spec["ramp"])
        m = np.zeros((SIZE, SIZE, 1), dtype=np.float32)
        fade = np.clip((cut - np.arange(SIZE, dtype=np.float32)) / max(1, ramp), 0, 1)
        m[y0:y1, x0:x1, 0] = fade[y0:y1, None]
        if "clip" in spec:  # a polygon that keeps a scarf end or a shoulder out of a wide head box
            m *= polygon(spec["clip"], 1)
        return m, m
    m = polygon(spec["poly"], spec.get("feather", 2))
    removing = m.copy()
    if "keep" in spec:
        cx, cy, radius = numbers(spec["keep"], 3)
        require(0 <= cx <= SIZE and 0 <= cy <= SIZE and 0 < radius <= SIZE, "invalid keep circle")
        y, x = np.ogrid[:SIZE, :SIZE]
        keep = np.clip((radius - np.hypot(x - cx, y - cy)) / 4, 0, 1)[..., None]
        removing *= 1 - keep
    require(type(spec.get("lift", False)) is bool, "lift must be boolean")
    if spec.get("lift", False):
        removing *= 0
    if spec.get("fill"):
        # the layer reaches a soft 3 px past the outline, over the body's own (identical) pixels there, so at
        # rest nothing shows a seam; the body under the outline itself is filled (see cut_scene)
        hard = polygon(spec["poly"], 0)
        ring = Image.fromarray((hard[..., 0] * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))
        ring = np.asarray(ring.filter(ImageFilter.GaussianBlur(1.5)), np.float32)[..., None] / 255
        m = np.maximum(hard, ring)
    if "behind" in spec and "src" not in spec:  # body pixels in front of the part (a hip, a scarf): not the part's
        front = polygon(spec["behind"], 1)
        m, removing = m * (1 - front), removing * (1 - front)
    return m, removing


def grow(layer, region, steps=28, source=None):
    """Extends a part under what covers it: inside `region` (where the body lies on top), transparent pixels
    take the average of their opaque neighbours, step by step, so a tail continues as fur behind a hip or a
    scarf. Hidden while the part is at rest; when it swings, this is what shows instead of a gap."""
    out = layer.copy()
    inside = region[..., 0] > 0.5
    for _ in range(steps):
        solid = out[..., 3] > 0.9
        if source is not None:  # only these pixels (and what grew from them) may seed the fill
            solid &= source
            source = source | inside
        total = np.zeros_like(out)
        count = np.zeros(solid.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            total += np.roll(out * solid[..., None], (dy, dx), (0, 1))
            count += np.roll(solid, (dy, dx), (0, 1))
        new = inside & ~solid & (count > 0)
        if not new.any():
            break
        fill = total[new] / count[new][:, None]
        fill[:, :3] /= np.maximum(fill[:, 3:], 1e-6)
        fill[:, 3] = 1
        out[new] = fill
    return out


def underfill(base, body, spec):
    """Gives the body something under a head's lower edge: in each column of the head box, the body's top rows
    below the cut are mirrored upward for spec["underfill"] px, but only inside the drawing's silhouette. A
    head that tilts lifts one cheek; this is the scarf (or neck) the lifted cheek shows instead of a gap.
    Hidden by the head while it is level."""
    n = int(amount(spec["underfill"]))
    x0, _, x1, _ = box(spec["box"])
    out = body.copy()
    for x in range(x0, x1):
        col = body[:, x, 3]
        solid = np.nonzero(col >= 0.9)[0]
        solid = solid[solid >= spec["cut"] - spec["ramp"] - 2]
        if not len(solid):
            continue
        r = int(solid[0])
        for i in range(n):
            y, src = r - 1 - i, r + i
            if y < 0 or src >= SIZE or base[y, x, 3] < 0.5 or body[src, x, 3] < 0.9:
                break
            if out[y, x, 3] < 0.9:
                out[y, x] = body[src, x]
    return out


def cut_scene(base, specs, load, body_base=None):
    """base: the scene drawing. body_base: the scene drawn without its free parts (a cat with no tail), when
    there is one; the body is cut from it, so whatever a moving part uncovers is real drawing, not a guess.
    A layer with "src" is cut from its own drawing (a tail alone) and takes nothing from the body."""
    require(isinstance(specs, dict), "layers must be an object")
    body_base = base if body_base is None else body_base
    layers, outlines = {}, {}
    body = np.ones((SIZE, SIZE, 1), dtype=np.float32)
    restored = np.zeros_like(base)
    for key, spec in specs.items():
        name(key)
        require(key != "body" and not key.startswith("face-"), f"reserved layer name: {key}")
        m, removing = masks(spec)
        # the body gives up what the cut layer covers. A head's soft neck band stays in the body too (two
        # half-transparent layers stacked source-over let the desktop show through); a polygon's edge is cut
        # at its middle, or the body would keep a thin copy of the part's outline that shows when it moves
        removing = (removing >= (0.995 if "box" in spec else 0.5)).astype(np.float32)
        m = np.maximum(m, removing)  # what the body gives up, the layer holds fully: no half-alpha seam
        own = load(spec["src"]) if "src" in spec else None
        if own is not None:
            removing = removing * 0
        # a part of the body itself (a head, a paw) comes from the body drawing: never a sliver of a tail
        part = (body_base if own is None else own) * m
        if "behind" in spec:
            # only where the body is drawn: the hidden fur must never stick out past the figure
            part = grow(part, polygon(spec["behind"], 0) * (body_base[..., 3:] > 0.9))
        layers[key], outlines[key] = image(part), m
        body *= 1 - removing
        restored = restored * (1 - _arr(layers[key])[..., 3:]) + _arr(layers[key])  # source-over, like the page
    under = body_base * body
    for spec in specs.values():
        if spec.get("underfill"):
            under = underfill(body_base, under, spec)
        if spec.get("fill"):
            # a part that moves over the body (a paw tapping keys): the body under it is not a copy of the part
            # (its outline would show doubled) but the fur and keyboard around it, grown inward
            # only where the drawing is solid: a gap of background beside the paw stays background
            # (its soft outline too, or a faint copy of the outline stays behind when the part moves)
            hole = (polygon(spec["poly"], 0) > 0.5) & (body_base[..., 3:] > 0.02)
            if "fillin" in spec:  # where the body really lies behind the part; the rest of the hole stays clear
                region = hole & (polygon(spec["fillin"], 0) > 0.5)
            else:
                region = hole
            under = under.copy()
            under[hole[..., 0]] = 0
            # grown from fur only: an outline or the keyboard would smear dark into what a press uncovers
            rgb = body_base[..., :3] / np.maximum(body_base[..., 3:], 1e-6)
            lum = rgb.mean(-1)
            fur = np.median(lum[hole[..., 0]])
            # "fill": true fills the whole hole (a paw on the body); a number fills only that many px in from
            # the body (a wing up in the air: past the body there is nothing behind it, so nothing is drawn)
            steps = 60 if spec["fill"] is True else int(spec["fill"])
            under = grow(under, region.astype(np.float32), steps=steps, source=lum >= 0.8 * fur)
    layers = {"body": image(under), **layers}
    outlines = {"body": body, **outlines}
    restored = _arr(layers["body"]) * (1 - restored[..., 3:]) + restored  # the body sits under the cut layers
    # inside the figure the stack must be solid (a hole or a see-through seam shows the desktop); on its
    # anti-aliased outline a soft cut edge over the kept body only thickens the line a little
    # the figure the stack should make: the body drawing with the parts drawn on their own (a tail) behind it
    want = body_base[..., 3].copy()
    # what each separate drawing gives: the parts cut from it (tail1 and tail2 of one tail drawing count once)
    given = {}
    for spec in specs.values():
        if "src" in spec:
            m = polygon(spec["poly"], 0)[..., 0] if "poly" in spec else 1
            given[spec["src"]] = np.maximum(given.get(spec["src"], 0), load(spec["src"])[..., 3] * m)
    for a in given.values():
        want = want + a * (1 - want)
    inside = want > 0.98
    error = float(np.max(np.abs(restored[..., 3] - want)[inside], initial=0))
    require(error <= 0.03, f"max abs alpha error {error:.6f} > 0.03 inside the figure; a cut leaves a hole")
    return layers, outlines, restored, error


def faces(src, scene, base, spec, layers, outlines):
    region = box(spec["box"])
    feather = amount(spec.get("feather", 10))
    require(2 * feather < min(region[2] - region[0], region[3] - region[1]),
            "face feather leaves no inner rectangle")
    require(spec["parent"] in layers, "face parent must name a body/cut layer")
    names = spec["names"]
    require(isinstance(names, list), "face names must be a list")
    names = [name(n) for n in names]
    require("open" not in names and len(names) == len(set(names)), "duplicate/reserved face name")
    m = _mask((SIZE, SIZE), region, feather, "rect")
    for key in ["open", *names]:
        variant = base
        if key != "open":
            variant = drawn(src / f"{scene}.face-{key}.png")
            dx, dy = best_shift(base, variant, region, reach=12)
            # Paste onto transparent canvas: unlike roll(), pixels never wrap at an edge.
            shifted = Image.new("RGBa", (SIZE, SIZE))
            shifted.paste(image(variant), (dx, dy))
            variant = _arr(shifted)
        layers[f"face-{key}"], outlines[f"face-{key}"] = image(variant * m), m


def preview(path, layers, outlines, restored):
    panels = [*layers.items(), ("recombined", image(restored))]
    sheet = Image.new("RGB", (SIZE * len(panels), SIZE + 24), "#e6e6e6")
    draw = ImageDraw.Draw(sheet)
    for i, (key, im) in enumerate(panels):
        rgba = im.convert("RGBA")
        sheet.paste(rgba, (i * SIZE, 24), rgba)
        draw.text((i * SIZE + 8, 5), key, fill="black")
        if key in outlines:
            binary = Image.fromarray((outlines[key][..., 0] >= 0.5).astype(np.uint8) * 255)
            edge = np.asarray(binary) != np.asarray(binary.filter(ImageFilter.MinFilter(3)))
            sheet.paste("red", (i * SIZE, 24, (i + 1) * SIZE, SIZE + 24),
                        Image.fromarray(edge.astype(np.uint8) * 255))
    sheet.save(path, optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("id")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    src = APP / "art" / f"pet-{name(args.id)}" / "rig"
    out = APP / "renderer" / "pets" / args.id
    context = str(src / "cuts.json")
    try:
        config = json.loads((src / "cuts.json").read_text(encoding="utf-8"))
        require(config["canvas"] == SIZE, f"canvas must be {SIZE}")
        global SCARF
        SCARF = numbers(config["scarf"], 3) if "scarf" in config else None
        scenes = config["scenes"]
        require(isinstance(scenes, dict) and scenes, "scenes must be a non-empty object")
        outputs = set()
        for scene, spec in scenes.items():
            context = f"{src}: scene {name(scene)}"
            base = drawn(src / f"{scene}.png")
            load = lambda file: drawn(src / name_file(file))
            body_base = load(spec["body"]) if "body" in spec else None
            layers, outlines, restored, error = cut_scene(base, spec["layers"], load, body_base)
            if "faces" in spec:
                faces(src, scene, base, spec["faces"], layers, outlines)
            # props: separate drawings on the same canvas (a "?" that bobs), copied as layers unchanged
            for key, file in spec.get("props", {}).items():
                require(name(key) not in layers, f"prop {key} collides with a layer")
                layers[key] = image(drawn(src / file))
            stems = {f"{scene}-{key}" for key in layers}
            require(not outputs & stems, "scene/layer names collide in output filenames")
            outputs.update(stems)
            if args.preview:
                preview(src / f"_preview-{scene}.png", layers, outlines, restored)
            else:
                out.mkdir(parents=True, exist_ok=True)
                for key, im in layers.items():
                    for scale in (1, 2, 3):
                        suffix = "" if scale == 1 else f"@{scale}x"
                        resized = im.resize((144 * scale, 144 * scale), Image.Resampling.LANCZOS)
                        resized.convert("RGBA").save(out / f"{scene}-{key}{suffix}.png", optimize=True)
            print(f"{scene}: {len(layers)} layers; max abs alpha error {error:.6f}; "
                  f"{'preview' if args.preview else '144/288/432 px'}")
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError) as exc:
        sys.exit(f"pet rig: {context}: {exc}")


if __name__ == "__main__":
    main()
