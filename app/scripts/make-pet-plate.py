"""A clean plate for a rig part (dev-only art step): the scene with the part not drawn, so whatever the part
uncovers when it moves is real drawing, not a guess.

Usage: python app/scripts/make-pet-plate.py <scene.png> <edit.png> '<poly json>' <reach px> <out.png>

<edit.png> is the scene redrawn without the part (a Qwen-Image reference edit: "remove the quill"). Only the
part's own pixels (the scene inside the polygon) grown by <reach> px and feathered are taken from it; the rest stays
the scene, pixel for pixel, so faces and outlines elsewhere never change. Faint light specks the edit leaves in
that region, and pixels there that do not touch the solid figure, are dropped. make-pet-rig.py then uses the
plate as the scene's "body" and cuts the part from the scene itself ("src").
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def pm(a):
    b = a.copy()
    b[..., :3] *= a[..., 3:] / 255
    return b


def un(o):
    a = o[..., 3:]
    o = o.copy()
    o[..., :3] = np.where(a > 0, o[..., :3] / np.maximum(a, 1e-6) * 255, 0)
    return o


def main():
    scene_p, edit_p, poly, reach, out_p = sys.argv[1:6]
    poly, reach = [tuple(p) for p in json.loads(poly)], int(reach)
    scene = np.asarray(Image.open(scene_p).convert("RGBA"), np.float32)
    edit = np.asarray(Image.open(edit_p).convert("RGBA"), np.float32)
    # the part's own pixels (the scene inside its polygon), grown a little: outside them the plate never shows,
    # so the figure at rest is the scene exactly
    m = Image.new("L", (512, 512), 0)
    ImageDraw.Draw(m).polygon(poly, fill=255)
    inpoly = np.asarray(m) > 0
    part = inpoly & (scene[..., 3] > 12)
    m = Image.fromarray((part * 255).astype(np.uint8))
    m = m.filter(ImageFilter.MaxFilter(2 * reach + 1)).filter(ImageFilter.GaussianBlur(1))
    # never past the polygon: there the scene is not the part (the hair or sleeve it meets) and stays as drawn
    m = np.asarray(m, np.float32)[..., None] / 255 * inpoly[..., None]
    body = un(pm(scene) * (1 - m) + pm(edit) * m)
    inside = m[..., 0] > 0.5
    light = (body[..., :3].mean(-1) > 100) & (body[..., 3] < 250) & inside
    body[..., 3] = np.where(light, 0, body[..., 3])
    solid = Image.fromarray(((body[..., 3] > 250) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    body[..., 3] = np.where((np.asarray(solid) == 0) & inside, 0, body[..., 3])
    Image.fromarray(np.clip(body, 0, 255).astype(np.uint8), "RGBA").save(out_p)


if __name__ == "__main__":
    main()
