# Count the striae of the Pinnularia valve in plate B: intensity profile along one band, peaks = striae.
import json, numpy as np, sys
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.signal import find_peaks
HERE = __file__.rsplit('/', 2)[0]
a = np.asarray(Image.open(f'{HERE}/plates/B.jpg').convert('L')).astype(np.float32)
P0 = np.array(json.loads(sys.argv[1]) if len(sys.argv) > 1 else [700, 1680], float)
P1 = np.array(json.loads(sys.argv[2]) if len(sys.argv) > 2 else [2000, 1778], float)
d = P1 - P0; Ltot = np.hypot(*d); u = d / Ltot; n = np.array([-u[1], u[0]])
s = np.arange(0, Ltot, 0.5)
prof = np.zeros_like(s)
for o in np.arange(-6, 6.5, 1.0):
    pts = P0[None] + s[:, None]*u[None] + o*n[None]
    prof += ndi.map_coordinates(a, [pts[:, 1], pts[:, 0]], order=1)
prof /= 13
hp = prof - ndi.gaussian_filter1d(prof, 40)          # remove illumination trend
hp = ndi.gaussian_filter1d(hp, 2.0)
# striae period ≈ 10-14 px → min distance 7 px (14 samples)
pk, _ = find_peaks(hp, distance=14, prominence=np.std(hp)*0.5)
pts = [(float(P0[0]+s[i]*u[0]), float(P0[1]+s[i]*u[1])) for i in pk]
sp = np.diff(s[pk])
print(json.dumps(dict(n=len(pk), period_med=float(np.median(sp)), period_iqr=[float(np.percentile(sp, 25)), float(np.percentile(sp, 75))], p0=P0.tolist(), p1=P1.tolist())))
json.dump(dict(n=len(pk), p0=P0.tolist(), p1=P1.tolist(), pts=[[round(x, 1), round(y, 1)] for x, y in pts],
               method='plate B 灰度，沿肋纹带取 13 px 宽剖面，去 40 px 趋势，峰间距 ≥7 px，显著度 ≥0.5σ'),
          open(f'{HERE}/plates/striae.json', 'w'), indent=0)
im = Image.open(f'{HERE}/plates/B.jpg').crop((600, 1550, 2200, 1900)); dr = ImageDraw.Draw(im)
for x, y in pts: dr.ellipse((x-600-3, y-1550-3, x-600+3, y-1550+3), outline=(255, 0, 0))
dr.line((P0[0]-600, P0[1]-1550, P1[0]-600, P1[1]-1550), fill=(0, 0, 255))
im.save(sys.argv[3] if len(sys.argv) > 3 else '/tmp/striae.jpg', quality=90)
