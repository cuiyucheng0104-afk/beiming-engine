"""Build model data for the Treasure Island white model.
Inputs (material/, untrusted data, parsed only):
  ti_buildings.geojson  DataSF Building Footprints (PDDL), lon/lat, gnd_min_m NAVD88 m, hgt_median_m
  dem.tif + dem.json    USGS 3DEP topobathy DEM, UTM 10N (EPSG:32610), NAVD88 m
Outputs (data/): model.json, terrain.bin (Float32 elevation rel. MHHW), spill.bin (Float32 spill level rel. MHHW), stats.json
"""
import json, math, heapq, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAT = os.path.join(HERE, 'material'); OUT = os.path.join(HERE, 'data'); os.makedirs(OUT, exist_ok=True)

# NOAA CO-OPS station 9414290 San Francisco, datums (epoch 1983-2001) relative to station datum
NAVD88_STND = 1.804; MHHW_STND = 3.602
MHHW = MHHW_STND - NAVD88_STND          # MHHW in NAVD88 m  (= 1.798)
RISE = 1.0
LEVEL = MHHW + RISE

def utm(lon, lat, zone=10):
    a = 6378137.0; f = 1 / 298.257223563; k0 = 0.9996
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    lon0 = math.radians(-183 + 6 * zone)
    phi = math.radians(lat); lam = math.radians(lon)
    N = a / math.sqrt(1 - e2 * math.sin(phi) ** 2)
    T = math.tan(phi) ** 2; C = ep2 * math.cos(phi) ** 2; A = math.cos(phi) * (lam - lon0)
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * phi)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * phi)
             - (35 * e2 ** 3 / 3072) * math.sin(6 * phi))
    x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000
    y = k0 * (M + N * math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
                                        + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720))
    return x, y

dem = np.array(Image.open(os.path.join(MAT, 'dem.tif')), dtype=np.float64)
meta = json.load(open(os.path.join(MAT, 'dem.json')))
ex = meta['extent']; H0, W0 = dem.shape
px = (ex['xmax'] - ex['xmin']) / W0; py = (ex['ymax'] - ex['ymin']) / H0
def dem_at(E, N):  # bilinear, E/N arrays in UTM
    c = (E - ex['xmin']) / px - 0.5; r = (ex['ymax'] - N) / py - 0.5
    return ndimage.map_coordinates(dem, [r, c], order=1, mode='nearest')

# island = largest land component above MHHW
land = dem >= MHHW
lab, n = ndimage.label(land)
sizes = ndimage.sum(land, lab, range(1, n + 1)); isl = lab == (1 + int(np.argmax(sizes)))
rr, cc = np.nonzero(isl)
Es = ex['xmin'] + (cc + .5) * px; Ns = ex['ymax'] - (rr + .5) * py
cE, cN = Es.mean(), Ns.mean()
cov = np.cov(np.vstack([Es - cE, Ns - cN]))
w, v = np.linalg.eigh(cov); ax = v[:, np.argmax(w)]
ang = math.atan2(ax[1], ax[0])          # long axis angle from east, CCW
# model coords: x along long axis, z perpendicular (right-handed with y up: z = -(perp))
ca, sa = math.cos(ang), math.sin(ang)
def to_model(E, N):
    dx, dy = E - cE, N - cN
    u = dx * ca + dy * sa          # along axis
    vv = -dx * sa + dy * ca        # left of axis
    return u, -vv                  # x = u, z = -v  (rotation of x=E, z=-N)
def to_utm(x, z):
    u, vv = x, -z
    return cE + u * ca - vv * sa, cN + u * sa + vv * ca
ux, uz = to_model(Es, Ns)
MARGIN = 70.0
x0, x1 = ux.min() - MARGIN, ux.max() + MARGIN; z0, z1 = uz.min() - MARGIN, uz.max() + MARGIN
CELL = 2.0
GW = int(math.ceil((x1 - x0) / CELL)); GH = int(math.ceil((z1 - z0) / CELL))
x1 = x0 + GW * CELL; z1 = z0 + GH * CELL
SHX, SHZ = (x0 + x1) / 2, (z0 + z1) / 2          # recentre: the plate's centre is the model origin
gx = x0 + (np.arange(GW) + .5) * CELL; gz = z0 + (np.arange(GH) + .5) * CELL
GX, GZ = np.meshgrid(gx, gz)
GE, GN = to_utm(GX, GZ)
elev = dem_at(GE.ravel(), GN.ravel()).reshape(GH, GW)   # NAVD88 m

# priority flood: spill level W = lowest water level at which the cell joins the open bay
Wl = np.full(elev.shape, np.inf); done = np.zeros(elev.shape, bool); pq = []
for r in range(GH):
    for c in (0, GW - 1):
        heapq.heappush(pq, (elev[r, c], r, c))
for c in range(GW):
    for r in (0, GH - 1):
        heapq.heappush(pq, (elev[r, c], r, c))
while pq:
    h, r, c = heapq.heappop(pq)
    if done[r, c]: continue
    done[r, c] = True; Wl[r, c] = h
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        rr2, cc2 = r + dr, c + dc
        if 0 <= rr2 < GH and 0 <= cc2 < GW and not done[rr2, cc2]:
            heapq.heappush(pq, (max(h, elev[rr2, cc2]), rr2, cc2))

water_now = Wl <= MHHW                       # open water at MHHW today
flood = (Wl <= LEVEL) & ~water_now           # newly flooded at +1 m
area_ha = float(flood.sum() * CELL * CELL / 1e4)
print('grid', GW, GH, 'flooded ha', round(area_ha, 2))

# ---- visual fill key (metres above MHHW). Where the ground itself sets the level (rims, slopes) the key is the
# spill level: the water arrives as the level reaches it. Where the ground lies BELOW its spill level (a bowl behind a
# sill), the bathtub model floods the whole bowl at the instant the sill is overtopped; to show that instant we spread
# the bowl's fill over the remaining centimetres up to +1 m in order of path distance from where the water enters.
sp = Wl - MHHW; el = elev - MHHW
ponded = (el < sp - 0.003) & (sp > 0) & (sp <= RISE)
key = sp.copy()
dist = np.full(elev.shape, np.inf); pq = []
for r, c in zip(*np.nonzero(ponded)):
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        r2, c2 = r + dr, c + dc
        if 0 <= r2 < GH and 0 <= c2 < GW and not ponded[r2, c2] and sp[r2, c2] <= sp[r, c] + 1e-6:
            dist[r, c] = 0.0; heapq.heappush(pq, (0.0, r, c)); break
while pq:
    d, r, c = heapq.heappop(pq)
    if d > dist[r, c]: continue
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        r2, c2 = r + dr, c + dc
        if 0 <= r2 < GH and 0 <= c2 < GW and ponded[r2, c2]:
            nd = d + CELL * (1.41421 if dr and dc else 1.0)
            if nd < dist[r2, c2]: dist[r2, c2] = nd; heapq.heappush(pq, (nd, r2, c2))
lab, npond = ndimage.label(ponded)
for i in range(1, npond + 1):
    m = lab == i; dm = dist[m]; fin = np.isfinite(dm)
    if not fin.any(): continue
    dmax = max(dm[fin].max(), CELL); s0 = sp[m]
    key[m] = s0 + (RISE - s0) * np.clip(np.where(fin, dm, dmax) / dmax, 0, 1) * 0.999
# the breach: the largest bowl fills from its sill, the rim cell(s) at the bowl's spill level that touch lower outside water
big = np.bincount(lab.ravel())[1:]; bi_ = 1 + int(np.argmax(big))
bowl = lab == bi_; breach_sp = float(sp[bowl].min())
band = (np.abs(sp - breach_sp) < 0.0015)
sill = band & (np.abs(el - sp) < 0.002)
outer = np.zeros_like(sill)
for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
    outer |= np.roll(np.roll(sp < breach_sp - 0.004, dr, 0), dc, 1)
sill &= outer
srr, scc = np.nonzero(sill)
print('sill cells', len(srr))
d2 = np.full(elev.shape, np.inf); pq = []
for r, c in zip(srr, scc): d2[r, c] = 0; heapq.heappush(pq, (0.0, r, c))
while pq:
    d, r, c = heapq.heappop(pq)
    if d > d2[r, c]: continue
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        r2, c2 = r + dr, c + dc
        if 0 <= r2 < GH and 0 <= c2 < GW and band[r2, c2]:
            nd = d + CELL * (1.41421 if dr and dc else 1.0)
            if nd < d2[r2, c2]: d2[r2, c2] = nd; heapq.heappush(pq, (nd, r2, c2))
reach = band & np.isfinite(d2)
dmax = float(d2[reach].max())
key[reach] = breach_sp + (RISE - breach_sp) * (d2[reach] / dmax) * 0.999
# the breach point shown on screen: the sill cell nearest the bowl's mass
first = reach & bowl & (d2 < 0.04 * dmax)
fr, fc = np.nonzero(first); cy, cx = fr.mean(), fc.mean()
k0 = int(np.argmin((srr - cy) ** 2 + (scc - cx) ** 2)); br_r, br_c = float(srr[k0]), float(scc[k0])
print('first-wet bowl cells', len(fr), 'breach rc', br_r, br_c)
print('ponds', npond, 'largest', int(big.max()) if npond else 0, 'cells; sill', round(breach_sp, 3), 'm')

# buildings
gj = json.load(open(os.path.join(MAT, 'ti_buildings.geojson')))
B = []; P = []
def ring_model(ring):
    pts = []
    for lon, lat in ring:
        E, N = utm(lon, lat); x, z = to_model(E, N); pts.append([round(x, 2), round(z, 2)])
    if len(pts) > 1 and pts[0] == pts[-1]: pts = pts[:-1]
    return pts
from PIL import ImageDraw
def raster(rings):
    im = Image.new('L', (GW, GH), 0); d = ImageDraw.Draw(im)
    for k, ring in enumerate(rings):
        pts = [((x - x0) / CELL - .5, (z - z0) / CELL - .5) for x, z in ring]
        if len(pts) >= 3: d.polygon(pts, fill=255 if k == 0 else 0, outline=255 if k == 0 else 0)
    return np.array(im) > 0

skipped = 0
for f in gj['features']:
    pr = f['properties']; g = f['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    try:
        gnd = float(pr.get('gnd_min_m')); hgt = float(pr.get('hgt_median_m'))
    except (TypeError, ValueError):
        skipped += 1; continue
    rings_all = [[ring_model(r) for r in poly] for poly in polys]
    xs = [p[0] for rs in rings_all for p in rs[0]]; zs = [p[1] for rs in rings_all for p in rs[0]]
    if min(xs) < x0 + 4 or max(xs) > x1 - 4 or min(zs) < z0 + 4 or max(zs) > z1 - 4:
        skipped += 1; continue
    m = np.zeros((GH, GW), bool)
    for rs in rings_all: m |= raster(rs)
    if not m.any():
        cxi = int((np.mean(xs) - x0) / CELL); czi = int((np.mean(zs) - z0) / CELL); m[czi, cxi] = True
    lb = float(Wl[m].min())                     # level at which water first reaches the footprint
    kb = float(key[m].min())                    # visual arrival key (see above)
    bi = len(B)
    base = float(el[m].min())                   # the model stands on the DEM ground under its footprint (same surface the water uses)
    B.append([round(max(base, -0.5), 2), round(max(hgt, 1.0), 2), round(lb - MHHW, 3), round(kb, 4)])
    for rs in rings_all:
        P.append([bi, [[[round(x - SHX, 2), round(z - SHZ, 2)] for x, z in r] for r in rs]])
print('buildings', len(B), 'skipped', skipped)
nflood = sum(1 for b in B if b[2] <= RISE)
print('flooded buildings', nflood)

terrain = (elev - MHHW).astype(np.float32)
keyo = np.where(sp <= 0, sp, key).astype(np.float32)
terrain.tofile(os.path.join(OUT, 'terrain.bin')); keyo.tofile(os.path.join(OUT, 'key.bin'))
json.dump({'size': [round(x1 - x0, 2), round(z1 - z0, 2)], 'origin': [round(x0 - SHX, 2), round(z0 - SHZ, 2)], 'cell': CELL,
           'grid': [GW, GH], 'b': B, 'p': P}, open(os.path.join(OUT, 'model.json'), 'w'), separators=(',', ':'))

# flood order of buildings, for the pick-out timing (level at which each building is reached)
order = sorted([(b[3], i) for i, b in enumerate(B) if b[2] <= RISE])
# land area flooded as a function of level (for the rolling counter)
levels = np.round(np.linspace(0, RISE, 1001), 4)
landk = np.sort(key[~water_now].ravel())
area_curve = [round(float(np.searchsorted(landk, l, 'right') * CELL * CELL / 1e4), 2) for l in levels]
bk = np.sort([b[3] for b in B if b[2] <= RISE])
bld_curve = [int(np.searchsorted(bk, l, 'right')) for l in levels]
land_ha = float((~water_now).sum() * CELL * CELL / 1e4)

# solar position (NOAA / Meeus), Treasure Island centroid, 2026-06-21 (PDT = UTC-7)
lat0, lon0 = None, None
# invert centroid UTM -> lon/lat numerically
def inv(E, N):
    lo, la = -122.37, 37.82
    for _ in range(30):
        e, n = utm(lo, la); d = 1e-5
        e1, n1 = utm(lo + d, la); e2, n2 = utm(lo, la + d)
        J = np.array([[(e1 - e) / d, (e2 - e) / d], [(n1 - n) / d, (n2 - n) / d]])
        dl = np.linalg.solve(J, [E - e, N - n]); lo += dl[0]; la += dl[1]
    return lo, la
lon0, lat0 = inv(cE, cN)
def sunpos(Y, Mo, D, hh_utc):
    # NOAA spreadsheet algorithm
    if Mo <= 2: Y2, M2 = Y - 1, Mo + 12
    else: Y2, M2 = Y, Mo
    A = Y2 // 100; Bb = 2 - A + A // 4
    JD = int(365.25 * (Y2 + 4716)) + int(30.6001 * (M2 + 1)) + D + Bb - 1524.5 + hh_utc / 24
    T = (JD - 2451545) / 36525
    L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
    Mg = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    C = (math.sin(math.radians(Mg)) * (1.914602 - T * (0.004817 + 0.000014 * T)) + math.sin(math.radians(2 * Mg)) * (0.019993 - 0.000101 * T) + math.sin(math.radians(3 * Mg)) * 0.000289)
    tl = L0 + C; om = 125.04 - 1934.136 * T
    lam = tl - 0.00569 - 0.00478 * math.sin(math.radians(om))
    eps0 = 23 + (26 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813)))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(math.radians(om))
    dec = math.degrees(math.asin(math.sin(math.radians(eps)) * math.sin(math.radians(lam))))
    yv = math.tan(math.radians(eps / 2)) ** 2
    eqt = 4 * math.degrees(yv * math.sin(2 * math.radians(L0)) - 2 * e * math.sin(math.radians(Mg)) + 4 * e * yv * math.sin(math.radians(Mg)) * math.cos(2 * math.radians(L0)) - 0.5 * yv * yv * math.sin(4 * math.radians(L0)) - 1.25 * e * e * math.sin(2 * math.radians(Mg)))
    tst = (hh_utc * 60 + eqt + 4 * lon0) % 1440
    ha = tst / 4 - 180 if tst / 4 >= 0 else tst / 4 + 180
    zen = math.degrees(math.acos(math.sin(math.radians(lat0)) * math.sin(math.radians(dec)) + math.cos(math.radians(lat0)) * math.cos(math.radians(dec)) * math.cos(math.radians(ha))))
    el = 90 - zen
    az = (math.degrees(math.atan2(math.sin(math.radians(ha)), math.cos(math.radians(ha)) * math.sin(math.radians(lat0)) - math.tan(math.radians(dec)) * math.cos(math.radians(lat0)))) + 180) % 360
    return az, el
sun = []
for i in range(0, 24 * 12 + 1):
    hl = i / 12; az, el = sunpos(2026, 6, 21, hl + 7)
    sun.append([round(hl, 4), round(az, 2), round(el, 2)])
rise = next(s[0] for s in sun if s[2] > -0.833); setv = next(s[0] for s in reversed(sun) if s[2] > -0.833)
stats = {
    'mhhw_navd88': round(MHHW, 3), 'level_navd88': round(LEVEL, 3), 'rise_m': RISE,
    'flooded_ha': round(area_ha, 1), 'flooded_buildings': nflood, 'buildings': len(B), 'land_ha': round(land_ha, 1),
    'levels': levels.tolist(), 'area_curve': area_curve, 'bld_curve': bld_curve,
    'axis_deg_from_east': round(math.degrees(ang), 2), 'north_in_model': list(map(lambda v: round(v, 4), to_model(cE, cN + 1) if False else (0, 0))),
    'centroid_lonlat': [round(lon0, 5), round(lat0, 5)], 'sun_date': '2026-06-21', 'sun_tz': 'PDT (UTC-7)',
    'sunrise_h': rise, 'sunset_h': setv, 'sun': sun,
    'flood_order': [[round(l, 4), i] for l, i in order],
    'sill_m': round(breach_sp, 3), 'breach': [round(x0 + (br_c + .5) * CELL - SHX, 1), round(z0 + (br_r + .5) * CELL - SHZ, 1)],
    'below_mhhw_footprints': int(sum(1 for b in B if b[2] <= 0)),
}
# north direction in model coords
nx, nz = to_model(cE, cN + 100.0); stats['north_in_model'] = [round(nx / 100, 4), round(nz / 100, 4)]
ex_, ez_ = to_model(cE + 100.0, cN); stats['east_in_model'] = [round(ex_ / 100, 4), round(ez_ / 100, 4)]
json.dump(stats, open(os.path.join(OUT, 'stats.json'), 'w'), separators=(',', ':'))
print({k: stats[k] for k in ('mhhw_navd88', 'level_navd88', 'flooded_ha', 'flooded_buildings', 'buildings', 'land_ha', 'axis_deg_from_east', 'centroid_lonlat', 'sunrise_h', 'sunset_h', 'north_in_model', 'east_in_model')})
print('model size', stats and json.load(open(os.path.join(OUT, 'model.json')))['size'])
