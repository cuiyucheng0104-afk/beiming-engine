"""Textures from the two public-domain scans in material/ (see CREDITS).
usage: python -I tools/prep.py <project_dir>
  tex/p1.jpg        first-flight plate, positive, 4000 px wide (world unit = 1 px of this texture)
  tex/p1_mask.png   emulsion mask (white scan margin / broken glass connected to the border = no glass)
  tex/p1_bg.jpg     plate with the Flyer and Wilbur lifted out and filled (photograph space)
  tex/p1_fly.png    Flyer layer (grey premultiplied + alpha), cropped to its box
  tex/p1_wil.png    Wilbur layer
  tex/tg.jpg        telegram, mat trimmed, 2400 px wide
  tex/crop_fly.jpg, tex/crop_tg.jpg   crops for the two reading cards
  tex/layers.json   boxes, horizon
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
Image.MAX_IMAGE_PIXELS = None
D = sys.argv[1]; M = os.path.join(D, 'material'); O = os.path.join(D, 'tex'); os.makedirs(O, exist_ok=True)

def soft(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)

def fill(val, known):
    """membrane fill of unknown pixels (push-pull pyramid)"""
    if known.all(): return val.copy()
    h, w = val.shape
    if min(h, w) < 4:
        out = val.copy(); out[~known] = val[known].mean() if known.any() else .5; return out
    h2, w2 = (h + 1) // 2, (w + 1) // 2
    pv = np.zeros((h2 * 2, w2 * 2)); pk = np.zeros((h2 * 2, w2 * 2))
    pv[:h, :w] = val * known; pk[:h, :w] = known
    sv = pv.reshape(h2, 2, w2, 2).sum((1, 3)); sk = pk.reshape(h2, 2, w2, 2).sum((1, 3))
    coarse = fill(np.where(sk > 0, sv / np.maximum(sk, 1e-9), 0), sk > 0)
    up = np.asarray(Image.fromarray(coarse.astype(np.float32)).resize((w2 * 2, h2 * 2), Image.BILINEAR))[:h, :w]
    out = val.copy(); out[~known] = up[~known]; return out

def gray(a, p, q=92):
    Image.fromarray(np.clip(a * 255 + .5, 0, 255).astype(np.uint8)).save(p, quality=q, subsampling=0)

# ---- plate
src = Image.open(os.path.join(M, 'wrightflyer_highres.jpg')).convert('L')
p1 = src.resize((4000, round(4000 * src.size[1] / src.size[0])), Image.LANCZOS)
p1.save(os.path.join(O, 'p1.jpg'), quality=92, subsampling=0)
W, H = p1.size
s = 4
small = np.asarray(p1.resize((W // s, H // s), Image.BILINEAR)).astype(np.float32)
white = small > 226
white[:2, :] = white[-2:, :] = True; white[:, :2] = white[:, -2:] = True
lab, _ = ndi.label(white)
border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
outside = np.isin(lab, list(border))
Image.fromarray(np.where(outside, 0, 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.0)).save(os.path.join(O, 'p1_mask.png'))

A = np.asarray(p1).astype(np.float64) / 255
rng = np.random.default_rng(11)
HZ = 1232
fx0, fy0, fx1, fy1 = 1248, 880, 3296, 1440
sub = A[fy0:fy1, fx0:fx1]
ys = np.arange(fy0, fy1)[:, None] * np.ones((1, fx1 - fx0)); xs = np.arange(fx0, fx1)[None, :] * np.ones((fy1 - fy0, 1))
# sky: membrane b under the haze. ground: marks against a local smooth background
med = ndi.median_filter(A[fy0 - 60:fy1 + 60:2, fx0 - 60:fx1 + 60:2], size=41)
med = np.asarray(Image.fromarray(med.astype(np.float32)).resize((fx1 - fx0 + 120, fy1 - fy0 + 120), Image.BILINEAR))[60:-60, 60:-60]
dg = sub - med
strong0 = ndi.binary_dilation(np.abs(dg) > 0.03, iterations=18)
b = ndi.gaussian_filter(fill(sub, ~strong0), 14)
d = sub - b
bn = ndi.gaussian_filter(fill(sub, ~ndi.binary_dilation(np.abs(dg) > 0.05, iterations=10)), 14)
dn = sub - bn
def hull(x, y):
    top = 964 + (868 - 964) * (x - 1272) / (3280 - 1272)
    bot = 1440 + (1312 - 1440) * (x - 1272) / (3280 - 1272)
    return soft(np.minimum(x - 1268, 3284 - x), 0, 20) * soft(y - top, 0, 20) * soft(bot + 32 - y, 0, 20)
hl = hull(xs, ys)
a_sky = np.where(d < 0, np.clip(-d / np.maximum(b, .05), 0, 1), np.clip(d / np.maximum(1 - b, .05), 0, 1))
c_sky = np.where(d < 0, 0.0, 1.0)
vline = ndi.gaussian_filter(dn, (8, 0.8)) < -0.035
strong = ndi.binary_closing((np.abs(dn) > 0.06) | vline, iterations=3)
lab, n = ndi.label(strong); sz = ndi.sum(strong, lab, range(1, n + 1))
strong = np.isin(lab, [k + 1 for k, z in enumerate(sz) if z > 60])
a_gnd = ndi.gaussian_filter(ndi.binary_dilation(strong, iterations=2).astype(np.float64), 1.0)
wsky = 1 - soft(ys, HZ - 10, HZ + 10)
alpha = hl * (wsky * a_sky + (1 - wsky) * a_gnd)
color = wsky * c_sky + (1 - wsky) * sub
g = ndi.gaussian_filter(rng.normal(0, 1, A.shape), .7); g *= 0.014 / g.std(); gs = g[fy0:fy1, fx0:fx1]
hole = a_gnd > .02
gnd_fill = np.where(hole, fill(sub, ~hole) + gs, sub)
bgsub = wsky * (b + gs * soft(alpha, .3, .7)) + (1 - wsky) * gnd_fill
bg = A.copy(); bg[fy0:fy1, fx0:fx1] = hl * bgsub + (1 - hl) * sub
la = np.stack([np.clip(color * alpha * 255 + .5, 0, 255), np.clip(alpha * 255 + .5, 0, 255)], -1).astype(np.uint8)
Image.fromarray(la, 'LA').save(os.path.join(O, 'p1_fly.png'))
# Wilbur
wx0, wy0, wx1, wy1 = 3400, 1150, 3640, 1536
ws = A[wy0:wy1, wx0:wx1]
wb = ndi.gaussian_filter(fill(ws, ws > .5), 16)
wm = ndi.binary_fill_holes(ndi.binary_closing((wb - ws) > .12, iterations=3))
lab, n = ndi.label(wm); sz = ndi.sum(wm, lab, range(1, n + 1)); wm = lab == (1 + int(np.argmax(sz)))
wa = ndi.gaussian_filter(ndi.binary_dilation(wm, iterations=3).astype(np.float64), 1.1)
Image.fromarray(np.stack([np.clip(ws * wa * 255 + .5, 0, 255), np.clip(wa * 255 + .5, 0, 255)], -1).astype(np.uint8), 'LA').save(os.path.join(O, 'p1_wil.png'))
wh = np.zeros_like(A, bool); wh[wy0:wy1, wx0:wx1] = ndi.binary_dilation(wm, iterations=7)
bg = np.where(wh, fill(bg, ~wh) + g, bg)
gray(bg, os.path.join(O, 'p1_bg.jpg'))
print('flyer alpha mean', float(alpha[hl > .5].mean()), 'wilbur px', int(wm.sum()))

# ---- telegram
tg = Image.open(os.path.join(M, 'telegram_1903.jpg')).convert('RGB')
tg = tg.crop((40, 30, tg.size[0] - 40, tg.size[1] - 30))
tg = tg.resize((2400, round(2400 * tg.size[1] / tg.size[0])), Image.LANCZOS)
tg.save(os.path.join(O, 'tg.jpg'), quality=91)
# card crops
# telegram line "Success four flights" for card B: the scan is a faded carbon on buff paper (grey 131..180 of 255),
# so the crop gets a black/white point stretch (a light normalisation of the positive, no filter look)
tc = np.asarray(tg.crop((30, 1117, 710, 1245)).convert('L')).astype(np.float64)
lo_, hi_ = np.percentile(tc, 0.8), np.percentile(tc, 97.5)
v = np.clip((tc - lo_) / (hi_ - lo_), 0, 1) ** 1.15
paper_, ink_ = np.array([0.97, 0.945, 0.885]), np.array([0.10, 0.09, 0.08])
rgb = ink_ + (paper_ - ink_) * v[..., None]
Image.fromarray(np.clip(rgb * 255 + .5, 0, 255).astype(np.uint8)).save(os.path.join(O, 'crop_tg.jpg'), quality=92)
p1.crop((1180, 820, 3700, 1600)).convert('RGB').save(os.path.join(O, 'crop_fly.jpg'), quality=90)
json.dump({'p1': [W, H], 'tg': list(tg.size), 'fly': [fx0, fy0, fx1, fy1], 'wil': [wx0, wy0, wx1, wy1], 'horizon': HZ}, open(os.path.join(O, 'layers.json'), 'w'))
print('sizes', p1.size, tg.size)
