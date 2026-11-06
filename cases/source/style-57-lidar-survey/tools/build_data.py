"""points.npz (EPT subset) -> browser binaries + measurements.

Outputs in data/:
  pts.bin      per point: uint16 E, uint16 N, uint16 Z (2.14 cm / 2.14 cm / 1 cm), uint8 hag(0.1 m), uint8 class,
               uint8 intensity, uint8 seed  (10 bytes, interleaved)
  dem.bin      float32 grid GxG of ground height (m, NAVD88), 2 m cells, row 0 = north
  ao.bin       uint8 GxG baked short-radius ambient occlusion
  meta.json    frame, counts, section profile from raw ground returns, ring crest trace, readings
"""
import json, os, sys, math
import numpy as np
from scipy import ndimage
from scipy.interpolate import griddata

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
a = np.load(os.path.join(HERE, "material/ept16/points.npz"))
cx, cy, lon, lat, k = a["center"]
E = (a["x"] - cx) / k; N = (a["y"] - cy) / k; Z = a["z"]; C = a["c"]; I = a["i"].astype(np.float64); RN = a["r"]
H = 700.0
keep = (C != 7) & (C != 18) & (np.abs(E) <= H) & (np.abs(N) <= H)
E, N, Z, C, I = E[keep], N[keep], Z[keep], C[keep], I[keep]
print("after class/box filter", len(E))

# ---- DTM: 2 m cells from class 2, nearest fill, light smoothing; 1 m by bilinear upsampling ----
G1 = 1400
g = C == 2
G2 = 700
ix = np.clip(((E[g] + H) / 2).astype(int), 0, G2 - 1); iy = np.clip(((H - N[g]) / 2).astype(int), 0, G2 - 1)
s = np.zeros((G2, G2)); n = np.zeros((G2, G2))
np.add.at(s, (iy, ix), Z[g]); np.add.at(n, (iy, ix), 1)
d2 = np.where(n > 0, s / np.maximum(n, 1), np.nan)
holes = np.isnan(d2)
idx = ndimage.distance_transform_edt(holes, return_distances=False, return_indices=True)
d2 = ndimage.gaussian_filter(d2[tuple(idx)], 0.8)
print("holes filled (2 m)", holes.sum(), "of", G2 * G2)
dem1 = ndimage.zoom(d2, 2, order=1)

def dem_at(e, nn, dem=dem1, cell=1.0, G=G1):
    fx = (e + H) / cell - 0.5; fy = (H - nn) / cell - 0.5
    return ndimage.map_coordinates(dem, [fy, fx], order=1, mode="nearest")

hag = Z - dem_at(E, N)
# drop isolated low/high outliers
ok = (hag > -3) & (hag < 25)
E, N, Z, C, I, hag = E[ok], N[ok], Z[ok], C[ok], I[ok], hag[ok]

# thin: keep all ground, keep non-ground with hag>0.25 (shrubs), thin the rest
rng = np.random.default_rng(57)
r = rng.random(len(E))
sel = (C == 2) & (r < 0.17) | (C != 2) & (hag > 0.25) & (r < 0.16) | (C != 2) & (hag <= 0.25) & (r < 0.03)
E, N, Z, C, I, hag = E[sel], N[sel], Z[sel], C[sel], I[sel], hag[sel]
order = rng.permutation(len(E))
E, N, Z, C, I, hag = E[order], N[order], Z[order], C[order], I[order], hag[order]
print("browser points", len(E), "ground", (C == 2).sum())

zmin = float(np.floor(Z.min()))
p = np.zeros(len(E), dtype=[("e", "<u2"), ("n", "<u2"), ("z", "<u2"), ("h", "u1"), ("c", "u1"), ("i", "u1"), ("s", "u1")])
qe = 2 * H / 65535
p["e"] = np.round((E + H) / qe); p["n"] = np.round((N + H) / qe); p["z"] = np.round((Z - zmin) * 100)
p["h"] = np.clip(np.round(np.maximum(hag, 0) * 10), 0, 255)
p["c"] = C
lo, hi = np.percentile(I, [2, 98])
p["i"] = np.clip((I - lo) / (hi - lo) * 255, 0, 255)
p["s"] = rng.integers(0, 256, len(E))
os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
p.tofile(os.path.join(HERE, "data/pts.bin"))

# ---- 2 m surface grid + AO ----
G = 700
dem2 = d2.astype(np.float32)
dem2.tofile(os.path.join(HERE, "data/dem.bin"))
# AO: compare to blurred neighbourhoods (cavity), short radius
ao = np.zeros_like(dem2)
for rad, w in [(3, .5), (8, .35), (20, .15)]:
    ao += w * np.clip((ndimage.uniform_filter(dem2, 2 * rad + 1) - dem2) / (0.35 * rad * 2), -1, 1)
aoq = np.clip(1 - np.maximum(ao, 0) * 1.4, 0.25, 1)
(aoq * 255).astype(np.uint8).tofile(os.path.join(HERE, "data/ao.bin"))

# ---- crater geometry: dome summit, ring crest ----
sm = ndimage.gaussian_filter(dem1, 3)
# dome summit: max within 300 m of the window centre
yy, xx = np.mgrid[0:G1, 0:G1]
ee = xx + 0.5 - H; nn_ = H - (yy + 0.5)
inner = (ee ** 2 + nn_ ** 2) < 300 ** 2
iy0, ix0 = np.unravel_index(np.argmax(np.where(inner, sm, -1e9)), sm.shape)
sumE, sumN = ix0 + 0.5 - H, H - (iy0 + 0.5)
print("summit (smoothed) E,N", sumE, sumN, sm[iy0, ix0])

# crater centre ~ centroid of the moat (local minima ring) -> use summit as polar origin for crest trace
crest = []
for ang in np.arange(0, 360, 4):
    th = math.radians(ang)
    rr = np.arange(150, 520, 1.0)
    pe = sumE + rr * math.sin(th); pn = sumN + rr * math.cos(th)
    zz = dem_at(pe, pn, sm)
    # moat = minimum from dome outward; crest = max after the moat
    w = (rr >= 100) & (rr <= 340)
    im = int(np.where(w)[0][np.argmin(zz[w])])
    w2 = (rr > rr[im]) & (rr < rr[im] + 200)
    j = int(np.where(w2)[0][np.argmax(zz[w2])])
    crest.append([round(float(pe[j]), 1), round(float(pn[j]), 1), round(float(zz[j]), 2), round(float(zz[im]), 2), round(float(rr[j]), 1)])

# ---- crest polyline: smooth, densify, per-vertex distance + along-parameter on the 2 m grid ----
from scipy.spatial import cKDTree
cr = np.array([[c[0], c[1]] for c in crest])
rad = np.hypot(cr[:, 0] - sumE, cr[:, 1] - sumN)
radm = ndimage.median_filter(rad, size=11, mode="wrap")
radm = ndimage.gaussian_filter1d(radm, 1.2, mode="wrap")
angs = np.radians(np.arange(0, 360, 4))
crs = np.stack([sumE + radm * np.sin(angs), sumN + radm * np.cos(angs)], 1)
# snap each smoothed point to the local maximum of the smoothed DTM along its ray (+-25 m)
for q in range(len(crs)):
    rr = radm[q] + np.arange(-25, 25.5, 1.0)
    pe = sumE + rr * np.sin(angs[q]); pn = sumN + rr * np.cos(angs[q])
    j = int(np.argmax(dem_at(pe, pn, sm))); crs[q] = [pe[j], pn[j]]
crs = (np.roll(crs, 1, 0) + 2 * crs + np.roll(crs, -1, 0)) / 4
crest = [[round(float(a_), 1), round(float(b_), 1), round(float(dem_at(np.array([a_]), np.array([b_]), sm)[0]), 2)] for a_, b_ in crs]
crs = np.vstack([crs, crs[:1]])
seglen = np.linalg.norm(np.diff(crs, axis=0), axis=1); cum = np.concatenate([[0], np.cumsum(seglen)])
dens = np.arange(0, cum[-1], 0.5)
dx = np.interp(dens, cum, crs[:, 0]); dy = np.interp(dens, cum, crs[:, 1])
# traced arc: only where the crest is clear in the data (WSW -> N -> ENE, clockwise); the east bulge and the
# south, where the dome toe meets the ring, are left out
ang0 = np.degrees(np.arctan2(dx - sumE, dy - sumN)) % 360
A0, A1 = 222.0, 70.0
rel = (ang0 - A0) % 360
arc = rel <= (A1 - A0) % 360
order_ = np.argsort(rel[arc])
ax_, ay_ = dx[arc][order_], dy[arc][order_]
alen = np.concatenate([[0], np.cumsum(np.hypot(np.diff(ax_), np.diff(ay_)))])
tree = cKDTree(np.stack([ax_, ay_], 1))
ge = (np.arange(G) * 2 + 1 - H); gn = (H - (np.arange(G) * 2 + 1))
GE, GN = np.meshgrid(ge, gn)
dist, ii = tree.query(np.stack([GE.ravel(), GN.ravel()], 1))
par = alen[ii] / alen[-1]
endcap = (ii == 0) | (ii == len(ax_) - 1)
dist = np.where(endcap & (dist > 1.0), 999, dist)
cd = np.clip(dist / 20 * 255, 0, 255).astype(np.uint8); cp = np.clip(par * 255, 0, 255).astype(np.uint8)
np.stack([cd, cp], 1).astype(np.uint8).tofile(os.path.join(HERE, "data/crest.bin"))
arc_pts = np.stack([ax_, ay_], 1)[::20].round(1).tolist()
crest_len = float(alen[-1])
print("crest length", crest_len)

# ---- section: W-E line through summit, profile from raw ground returns ----
az = float(sys.argv[1]) if len(sys.argv) > 1 else 90.0   # azimuth of section direction
th = math.radians(az)
ux, uy = math.sin(th), math.cos(th)
L = 560.0
gE, gN, gZ = (a["x"] - cx) / k, (a["y"] - cy) / k, a["z"]
gm = (a["c"] == 2)
gE, gN, gZ = gE[gm], gN[gm], gZ[gm]
along = (gE - sumE) * ux + (gN - sumN) * uy
across = -(gE - sumE) * uy + (gN - sumN) * ux
m = (np.abs(across) <= 2.0) & (np.abs(along) <= L)
al, zz = along[m], gZ[m]
bins = np.arange(-L, L + 0.01, 2.0)
prof = []
for b0 in bins[:-1]:
    mm = (al >= b0) & (al < b0 + 2)
    if mm.sum():
        prof.append([round(float(b0 + 1), 1), round(float(np.median(zz[mm])), 2), int(mm.sum())])
prof = np.array(prof)
rs = np.random.default_rng(3).permutation(int(m.sum()))[:4000]
raw_sec = np.stack([al[rs], zz[rs]], 1).round(2).tolist()
pd, pz = prof[:, 0], prof[:, 1]
iS = int(np.argmax(np.where(np.abs(pd) < 150, pz, -1e9)))
# moat floors: minima on each side between dome and ring
west = (pd < pd[iS]) & (pd > pd[iS] - 330); east = (pd > pd[iS]) & (pd < pd[iS] + 330)
iW = np.where(west)[0][np.argmin(pz[west])]; iE = np.where(east)[0][np.argmin(pz[east])]
wr = (pd < pd[iW]) & (pd > pd[iS] - 450); er = (pd > pd[iE]) & (pd < pd[iS] + 450)
iRW = np.where(wr)[0][np.argmax(pz[wr])]; iRE = np.where(er)[0][np.argmax(pz[er])]
floor = min(pz[iW], pz[iE]); iF = iW if pz[iW] <= pz[iE] else iE
meas = dict(
    summit=dict(d=pd[iS], z=pz[iS]), moatW=dict(d=pd[iW], z=pz[iW]), moatE=dict(d=pd[iE], z=pz[iE]),
    ringW=dict(d=pd[iRW], z=pz[iRW]), ringE=dict(d=pd[iRE], z=pz[iRE]),
    dome_above_floor=round(float(pz[iS] - floor), 1), floor_side="W" if iF == iW else "E",
    ring_width=round(float(pd[iRE] - pd[iRW]), 1), ringW_above_floor=round(float(pz[iRW]-floor),1), ringE_above_floor=round(float(pz[iRE]-floor),1),
)
print(json.dumps(meas, indent=1, default=float))
meta = dict(
    frame=dict(lon=float(lon), lat=float(lat), k=float(k), half=H, zmin=zmin, qe=qe, epsg="3857",
               dataset="USGS 3DEP CA_SierraNevada_13_B22 (Entwine Point Tiles)"),
    count=int(len(E)), count_raw=int(len(a["x"])), grid=G, cell=2.0,
    summit=[float(sumE), float(sumN), float(sm[iy0, ix0])],
    crest=crest, crest_len=crest_len, arc=arc_pts,
    section=dict(az=az, origin=[float(sumE), float(sumN)], L=L, halfwidth=2.0, profile=prof.tolist(),
                 n_returns=int(m.sum()), raw=raw_sec),
    meas={kk: (vv if not isinstance(vv, dict) else {a_: float(b_) for a_, b_ in vv.items()}) for kk, vv in meas.items()},
    dem_minmax=[float(dem2.min()), float(dem2.max())],
)
json.dump(meta, open(os.path.join(HERE, "data/meta.json"), "w"), default=float)
print("written", os.path.getsize(os.path.join(HERE, "data/pts.bin")) / 1e6, "MB")
