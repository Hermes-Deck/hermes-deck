"""split-pet-tail.py <scene.png> <tailless edit.png> <out body.png> <out tail.png> [region json]
body = the scene with only its right-hip region taken from the tailless edit; tail = the scene's pixels that
differ from that body (the tail alone, one connected piece)."""
import json, sys, numpy as np
from PIL import Image, ImageDraw, ImageFilter
sc_p, nt_p, body_p, tail_p = sys.argv[1:5]
# the region the tail lives in (canvas px), right of the body's own outline; Leo's by default
REGION = [tuple(p) for p in json.loads(sys.argv[5])] if len(sys.argv) > 5 else     [(284, 512), (284, 300), (330, 296), (333, 250), (345, 200), (380, 150), (512, 120), (512, 512)]
sc = np.asarray(Image.open(sc_p).convert("RGBA"), np.float32)
nt = np.asarray(Image.open(nt_p).convert("RGBA"), np.float32)
m = Image.new("L", (512, 512), 0)
ImageDraw.Draw(m).polygon(REGION, fill=255)
m = np.asarray(m.filter(ImageFilter.GaussianBlur(6)), np.float32)[..., None] / 255
def pm(a): b = a.copy(); b[..., :3] *= a[..., 3:] / 255; return b
def un(o):
    a = o[..., 3:]; o = o.copy(); o[..., :3] = np.where(a > 0, o[..., :3] / np.maximum(a, 1e-6) * 255, 0); return o
body = un(pm(sc) * (1 - m) + pm(nt) * m)
# the edit sometimes leaves a faint light smear where the tail was (a blurred whisker): in the pasted region a
# light, half-transparent pixel is dropped
light = (body[..., :3].mean(-1) > 100) & (body[..., 3] < 250) & (m[..., 0] > 0.5)
body[..., 3] = np.where(light, 0, body[..., 3])
# and any faint pixel there that does not touch the solid figure (a stray hair of the edit)
solid = Image.fromarray(((body[..., 3] > 250) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
stray = (np.asarray(solid) == 0) & (m[..., 0] > 0.5)
body[..., 3] = np.where(stray, 0, body[..., 3])
Image.fromarray(np.clip(body, 0, 255).astype(np.uint8), "RGBA").save(body_p)
# the tail: where the scene is drawn and the body is not (or clearly differs), inside the region
d = (np.abs(pm(sc) - pm(body)).max(-1) > 40) & (sc[..., 3] > 30) & (m[..., 0] > 0.5)
mask = Image.fromarray((d * 255).astype(np.uint8))
mask = mask.filter(ImageFilter.MedianFilter(5))
# keep the biggest connected piece (the tail), not specks where the edit redrew a whisker
ys, xs = np.nonzero(np.asarray(mask) > 0)
seed = (int(xs[np.argmax(ys * 0 + xs)]), int(ys[np.argmax(xs)]))  # the rightmost point is the tail
lab = mask.copy(); ImageDraw.floodfill(lab, seed, 128)
keep = lab.point(lambda v: 255 if v == 128 else 0).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(1))
k = np.asarray(keep, np.float32)[..., None] / 255
# never the scarf: its teal (and its dark outline right next to teal) stays with the body
teal = ((sc[..., 1] - sc[..., 0]) > 30) & ((sc[..., 2] - sc[..., 0]) > 30) & (sc[..., 3] > 200)
teal = Image.fromarray((teal * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))  # the scarf, not stray pixels
near = np.asarray(teal.filter(ImageFilter.MaxFilter(5)), np.float32)[..., None] / 255
tail = sc.copy(); tail[..., 3:] *= k * (1 - near)
# whiskers drawn across the tail would swing with it: light thin lines take the fur around them
lum = tail[..., :3].mean(-1)
med = np.asarray(Image.fromarray(np.clip(tail[..., :3], 0, 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(7)), np.float32)
light = (lum - med.mean(-1) > 18)[..., None]
tail[..., :3] = np.where(light, med, tail[..., :3])
# the scarf's own edge pixels the tailless drawing lacks go to the body (under it, in the scene's version)
edge = pm(sc) * near * (m > 0.5)
b = pm(body); b = b + edge * (1 - b[..., 3:] / 255)
Image.fromarray(np.clip(un(b), 0, 255).astype(np.uint8), "RGBA").save(body_p)
Image.fromarray(np.clip(tail, 0, 255).astype(np.uint8), "RGBA").save(tail_p)
print(tail_p, Image.fromarray(np.clip(tail, 0, 255).astype(np.uint8), "RGBA").getbbox())
