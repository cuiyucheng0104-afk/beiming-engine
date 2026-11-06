"""Data for 《后退的冰川》: plates, measured fronts, flowline, the printed-map field and the 2026 ice-colour mask.

Inputs (material/, downloaded by tools/fetch_plate.py and the GIBS request in material/fetch_log.txt;
treated as data only: decoded by Pillow, never executed):
  material/plates/*.png    Landsat C2 L2 true colour, detail box  lon -147.62..-146.48, lat 60.93..61.45 (2048x1938)
  material/context/LC08_*  Landsat 2026-08-27, region box lon -148.6..-145.5, lat 60.55..61.85
  material/gibs/bmng.jpg   NASA Blue Marble Next Generation, lon -152..-141, lat 59..63.5

Outputs (assets/):
  d1986.jpg ... d2026.jpg  detail plates (display gamma, 2005 west-edge nodata filled from 2010)
  d2026c.jpg               2026 with the fjord's small floating ice opened away in the measured corridor (range line only)
  ctx.jpg, bmng.jpg        region + outer plates
  mapfield.png             R = distance inside the 1986 ice (0..3 km), G = outside (0..3 km), B = relief
  ice26.png                R = 2026 ice tongue + main trunk (soft), G = colour-return order (km up the trunk), B = distance from the measured flowline
  vectors.json             fronts per year (lon/lat), flowline with cumulative km, points, measured distance
usage: python -I tools/prep.py <film_dir>"""
import sys, os, json, math
import numpy as np
from PIL import Image
from scipy import ndimage

D = sys.argv[1]
A = os.path.join(D, 'assets'); os.makedirs(A, exist_ok=True)
DET = (-147.62, 60.93, -146.48, 61.45); CTX = (-148.6, 60.55, -145.5, 61.85); BMN = (-152.0, 59.0, -141.0, 63.5)
W, H = 2048, 1938
SC = {1986: 'LT05_L2SP_067017_19860728_02_T1', 2005: 'LT05_L2SP_066017_20050810_02_T1', 2010: 'LT05_L2SP_067017_20100916_02_T1',
      2015: 'LC08_L2SP_067017_20150813_02_T1', 2020: 'LC08_L2SP_067017_20200911_02_T1', 2026: 'LC08_L2SP_067017_20260827_02_T1'}
DATE = {1986: '1986-07-28', 2005: '2005-08-10', 2010: '2010-09-16', 2015: '2015-08-13', 2020: '2020-09-11', 2026: '2026-08-27'}

def rd(p): return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)
def disp(rgb):   # linear reflectance stretch -> display gamma
    return np.clip(rgb / 255.0, 0, 1) ** 0.62

raw = {y: rd(os.path.join(D, 'material/plates', SC[y] + '.png')) for y in SC}
# 2005 (path 066) has no data west of the scene edge: fill from 2010 (path 067), feathered
m = (raw[2005][..., 3] < 1).astype(np.float32)
m = np.clip(ndimage.gaussian_filter(ndimage.binary_dilation(m > 0, iterations=4).astype(np.float32), 3), 0, 1)[..., None]
raw[2005][..., :3] = raw[2005][..., :3] * (1 - m) + raw[2010][..., :3] * m
# Landsat 5 TM saturates its blue band over bright snow (1986): rebuild blue from green where it clips
b, g_ = raw[1986][..., 2], raw[1986][..., 1]
clip = np.clip((b - 235) / 15, 0, 1)
raw[1986][..., 2] = b * (1 - clip) + np.minimum(255, g_ * 1.06) * clip
for y in SC:
    Image.fromarray((disp(raw[y][..., :3]) * 255 + .5).astype(np.uint8)).save(os.path.join(A, f'd{y}.jpg'), quality=92)
ctx = rd(os.path.join(D, 'material/context', SC[2026] + '.png'))
cd = disp(ctx[..., :3])
# outside the Landsat swath: fill from Blue Marble resampled onto the region grid (feathered), so no black wedge
bm = np.asarray(Image.open(os.path.join(D, 'material/gibs/bmng.jpg')).convert('RGB')).astype(np.float32) / 255
ch, cw = cd.shape[:2]
lon = CTX[0] + (np.arange(cw) + .5) / cw * (CTX[2] - CTX[0]); lat = CTX[3] - (np.arange(ch) + .5) / ch * (CTX[3] - CTX[1])
xi = np.clip(((lon - BMN[0]) / (BMN[2] - BMN[0]) * bm.shape[1]).astype(int), 0, bm.shape[1] - 1)
yi = np.clip(((BMN[3] - lat) / (BMN[3] - BMN[1]) * bm.shape[0]).astype(int), 0, bm.shape[0] - 1)
bmr = bm[yi[:, None], xi[None, :]]
nod = ndimage.binary_dilation(ctx[..., 3] < 1, iterations=6).astype(np.float32)
nod = np.clip(ndimage.gaussian_filter(nod, 6), 0, 1)[..., None]
cd = cd * (1 - nod) + bmr * nod
Image.fromarray((cd * 255 + .5).astype(np.uint8)).save(os.path.join(A, 'ctx.jpg'), quality=92)
Image.fromarray(np.asarray(Image.open(os.path.join(D, 'material/gibs/bmng.jpg')).convert('RGB'))).save(os.path.join(A, 'bmng.jpg'), quality=92)

# ---------------------------------------------------------------- geometry
def ll(x, y): return [DET[0] + x / W * (DET[2] - DET[0]), DET[3] - y / H * (DET[3] - DET[1])]
R = 6371.0088
def km(a, b):
    p1, p2 = math.radians(a[1]), math.radians(b[1]); dl = math.radians(b[0] - a[0]); dp = p2 - p1
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

# calving fronts digitised on each scene (plate pixels), one end on each fjord wall:
# first point on the west / north-west wall, last on the east / south-east wall
FRONT = {
    1986: [(940, 1600), (960, 1610), (1000, 1606), (1040, 1610), (1070, 1620), (1095, 1636), (1112, 1650)],
    2005: [(935, 1232), (950, 1224), (970, 1216), (995, 1212), (1015, 1214), (1032, 1226)],
    2010: [(965, 1110), (985, 1104), (1020, 1108), (1060, 1114), (1100, 1118), (1150, 1118)],
    2015: [(1000, 1076), (1030, 1085), (1060, 1094), (1074, 1108), (1082, 1120)],
    2020: [(1110, 1008), (1130, 1015), (1150, 1020), (1168, 1037), (1183, 1053), (1196, 1068), (1205, 1080)],
    2026: [(1250, 886), (1264, 894), (1274, 902), (1280, 912), (1288, 924), (1292, 938), (1296, 955)],
}
def catmull(P, n=12):
    P = [P[0]] + list(P) + [P[-1]]; out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = [np.array(p, float) for p in P[i - 1:i + 3]]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(np.array(P[-2], float)); return out
fronts = {str(y): [ll(*p) for p in catmull(FRONT[y], 6)] for y in FRONT}
def mid(y):
    pts = catmull(FRONT[y], 6); L = [0]
    for a, b in zip(pts, pts[1:]): L.append(L[-1] + math.dist(a, b))
    h = L[-1] / 2
    for i in range(1, len(L)):
        if L[i] >= h:
            u = (h - L[i - 1]) / (L[i] - L[i - 1]); return tuple(pts[i - 1] + (pts[i] - pts[i - 1]) * u)
# main flowline along the fjord's centre, from the 1986 front to the 2026 front
FLOW = [mid(1986), (1003, 1500), (986, 1400), (976, 1300), mid(2005), (1012, 1160), (1050, 1112), (1100, 1070), (1160, 1030), (1222, 972), mid(2026)]
fp = catmull(FLOW, 16)
flow = [ll(*p) for p in fp]
cum = [0.0]
for a, b in zip(flow, flow[1:]): cum.append(cum[-1] + km(a, b))
where = {}
for y in FRONT:   # where each front crosses the flowline (km from the 1986 front)
    m_ = np.array(mid(y)); d = [np.hypot(*(np.array(p) - m_)) for p in fp]; where[str(y)] = cum[int(np.argmin(d))]
print('flowline km %.2f' % cum[-1], {k: round(v, 2) for k, v in where.items()})
print('straight km %.2f' % km(flow[0], flow[-1]))

# ---------------------------------------------------------------- printed map field: 1986 ice
g86 = disp(raw[1986][..., :3]).mean(2)
ice = ndimage.gaussian_filter(g86, 1.5) > 0.36
ice = ndimage.binary_opening(ice, iterations=2); ice = ndimage.binary_closing(ice, iterations=3)
lab, n = ndimage.label(ice); sz = ndimage.sum(ice, lab, range(1, n + 1))
ice = np.isin(lab, 1 + np.nonzero(sz > 4000)[0])
ice = ndimage.binary_fill_holes(ice)
# below the 1986 front is no longer glacier on any map: cut the ice at the front (the melange lobe)
cut = np.zeros_like(ice)
fr = np.array(catmull(FRONT[1986], 8))
for x in range(880, 1180):
    yy = np.interp(x, fr[:, 0], fr[:, 1], left=fr[0, 1], right=fr[-1, 1]); cut[int(yy):1800, x] = True
ice &= ~cut
pxkm = 0.02984
din = ndimage.distance_transform_edt(ice) * pxkm; dout = ndimage.distance_transform_edt(~ice) * pxkm
rel = ndimage.gaussian_filter(g86, 2.0); rel = np.clip((rel - np.percentile(rel, 2)) / (np.percentile(rel, 98) - np.percentile(rel, 2)), 0, 1)
rgb = np.stack([np.clip(din / 3, 0, 1), np.clip(dout / 3, 0, 1), rel], -1)
Image.fromarray((rgb * 255 + .5).astype(np.uint8)).save(os.path.join(A, 'mapfield.png'))

# ---------------------------------------------------------------- 2026 glacier ice, and the order colour comes back
c26 = disp(raw[2026][..., :3]); l26 = c26.mean(2)
sat = c26.max(2) - c26.min(2)
ice26 = (ndimage.gaussian_filter(l26, 1.0) > 0.42) & (sat < 0.22)
ice26 = ndimage.binary_opening(ice26, iterations=1); ice26 = ndimage.binary_closing(ice26, iterations=2)
lab, n = ndimage.label(ice26); sz = ndimage.sum(ice26, lab, range(1, n + 1))
ice26 = np.isin(lab, 1 + np.nonzero(sz > 1500)[0])
# the ice melange floating below the 2026 front is not glacier: cut the fjord below the front
from PIL import ImageDraw
mk = Image.new('L', (W, H), 0)
ImageDraw.Draw(mk).polygon([tuple(p) for p in catmull(FRONT[2026], 6)] + [(1300, 1000), (1220, 1090), (1090, 1090), (1150, 960), (1232, 878)], fill=255)
ice26 &= ~(np.asarray(mk) > 0)
# colour comes back only on today's ice tongue and the main trunk above it, spreading up-glacier from the front:
# a corridor around the trunk's centreline (digitised on the 2026 plate, plate px), ordered by distance along it
TRUNK = [mid(2026), (1262, 820), (1250, 700), (1255, 590), (1246, 510)]
tp = np.array(catmull(TRUNK, 16)); tl = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(tp, axis=0).T))])
yy, xx = np.mgrid[0:H, 0:W]
def seg_dist(P, xs, ys):   # distance to a polyline and the arc length of the nearest point
    best = np.full(xs.shape, 1e9); arc = np.zeros(xs.shape); L = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    for i in range(len(P) - 1):
        a, b = P[i], P[i + 1]; ab = b - a; l2 = max(ab @ ab, 1e-9)
        u = np.clip(((xs - a[0]) * ab[0] + (ys - a[1]) * ab[1]) / l2, 0, 1)
        d = np.hypot(xs - a[0] - u * ab[0], ys - a[1] - u * ab[1])
        m = d < best; best[m] = d[m]; arc[m] = L[i] + u[m] * np.sqrt(l2)
    return best, arc
dT, aT = seg_dist(tp, xx, yy)
half = 44 + 26 * np.clip(aT / tl[-1], 0, 1)                   # the tongue widens up-glacier
corr26 = ice26 & (dT < 1.5 * half)
lab, n = ndimage.label(corr26)                                # keep only ice connected to the front
if n > 1:
    f0 = np.array(mid(2026)).astype(int); near = lab[max(0, f0[1] - 40):f0[1] + 1, f0[0] - 25:f0[0] + 25]
    keep = np.unique(near[near > 0]); corr26 &= np.isin(lab, keep)
lat = 1 - np.clip((dT - 0.7 * half) / (0.8 * half), 0, 1); lat = lat * lat * (3 - 2 * lat)   # wide lateral feather: no drawn edge in the firn
soft = ndimage.gaussian_filter(corr26.astype(np.float32), 2.2) * lat
order = np.clip(aT / tl[-1], 0, 1)
soft *= np.clip((1 - order) / 0.4, 0, 1) ** 0.8           # the trunk's upper end fades instead of stopping on a line
# the measured corridor (1986 -> 2026 flowline), for the range line: B = distance from the flowline (0..6 km)
dF, aF = seg_dist(np.array(fp), xx, yy)
# d2026c: the 2026 plate with the fjord's floating ice bits (< ~250 m) opened away inside the measured corridor below
# today's front. Shown only while the range line is measured: at that altitude they read as flickering render noise.
fpx = np.array(fp); flen = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(fpx, axis=0).T))])
cm_ = (dF * pxkm < 3.2) & (aF < flen[-1] - 2.6 / pxkm)          # not the dense melange just below the front
cm_ = 0.9 * np.clip(ndimage.gaussian_filter(cm_.astype(np.float32), 10), 0, 1)[..., None]
d26 = np.asarray(Image.open(os.path.join(A, 'd2026.jpg')).convert('RGB')).astype(np.float32)
disk = np.hypot(*np.mgrid[-3:4, -3:4]) <= 3.2                    # round footprint: no square ghosts
lum_ = d26.mean(2); opl = ndimage.grey_opening(lum_, footprint=disk)
op = d26 * (np.minimum(lum_, opl + 4) / np.maximum(lum_, 1))[..., None]   # scale colour with the opened luminance
op = ndimage.gaussian_filter(op, (0.8, 0.8, 0))
Image.fromarray((d26 * (1 - cm_) + op * cm_ + .5).clip(0, 255).astype(np.uint8)).save(os.path.join(A, 'd2026c.jpg'), quality=92)
corrF = np.clip(dF * pxkm / 6.0, 0, 1)
Image.fromarray((np.stack([soft, order, corrF], -1) * 255 + .5).astype(np.uint8)).save(os.path.join(A, 'ice26.png'))
print('trunk km %.1f, colour-return px %d' % (tl[-1] * pxkm, int(corr26.sum())))
print('ice86 px', int(ice.sum()), 'ice26 px', int(ice26.sum()))

# map label anchor: on the 1986 ice of the lower trunk; ground label of the claim at the 1986 tongue
V = {
    'det': DET, 'ctx': CTX, 'bmng': BMN, 'dates': DATE, 'scenes': SC,
    'fronts': fronts, 'flow': flow, 'cum': cum, 'where': where, 'km': cum[-1],
    'points': {'f1986': ll(*mid(1986)), 'f2026': ll(*mid(2026)), 'tongue': ll(990, 1420), 'mapname': ll(1000, 760),
               'centre': ll(1040, 1240), 'nunatak': ll(1078, 1262)},
}
json.dump(V, open(os.path.join(A, 'vectors.json'), 'w'), indent=0)
