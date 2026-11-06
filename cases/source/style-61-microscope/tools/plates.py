# Grade both eyepiece photos to one warm-white glass, write plates/ and plates/meta.json.
import json, numpy as np, sys
from PIL import Image
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from circle import fit
HERE = __file__.rsplit('/', 2)[0]
GLASS = np.array([244, 241, 236], np.float32)
SRC = {'A': ('material/cymbella_field.jpg', 100), 'B': ('material/pinnularia_field.jpg', 110)}
meta = {}
for k, (p, thr) in SRC.items():
    c = fit(f'{HERE}/{p}', thr)
    a = np.asarray(Image.open(f'{HERE}/{p}').convert('RGB')).astype(np.float32)
    H, W = a.shape[:2]; yy, xx = np.mgrid[0:H, 0:W]
    inside = np.hypot(xx-c['cx'], yy-c['cy']) < c['r']*0.85
    L = a.mean(2); sel = inside & (L > np.percentile(L[inside], 85))
    ref = np.median(a[sel], 0)                      # the glass colour in this photo
    g = a * (GLASS / ref)                           # white balance to warm glass
    lum = g.mean(2, keepdims=True)
    g = lum + (g - lum) * 1.12                      # a little chroma in the specimen
    g = 244 * (np.clip(g, 0, None) / 244) ** 1.08                    # a little density
    g = np.clip(g, 0, 255).astype(np.uint8)
    Image.fromarray(g).save(f'{HERE}/plates/{k}.jpg', quality=92)
    meta[k] = dict(src=p, glass_ref=[round(float(v), 1) for v in ref], **{kk: round(v, 2) if isinstance(v, float) else v for kk, v in c.items()})
json.dump(meta, open(f'{HERE}/plates/meta.json', 'w'), indent=1)
print(json.dumps(meta, indent=1))
