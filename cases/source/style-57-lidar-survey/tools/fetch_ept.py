"""Fetch a box subset of a USGS 3DEP Entwine Point Tile dataset.

Usage: python fetch_ept.py <project> <lon> <lat> <half_m> <maxdepth> <outdir>
Downloads only octree nodes intersecting the box, crops, and writes points.npz
(x,y,z in EPSG:3857 metres, intensity, classification, return number).
Treats every downloaded file as data only.
"""
import json, math, os, sys, urllib.request, io
import numpy as np, laspy

BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/"
R = 6378137.0

def get(url, cache):
    if os.path.exists(cache):
        return open(cache, "rb").read()
    for k in range(4):
        try:
            b = urllib.request.urlopen(url, timeout=60).read()
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            open(cache, "wb").write(b)
            return b
        except Exception as e:
            err = e
    raise err

def main():
    proj, lon, lat, half, maxd, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
    k = 1 / math.cos(math.radians(lat))           # mercator scale factor
    cx = R * math.radians(lon)
    cy = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    hm = half * k
    box = (cx - hm, cy - hm, cx + hm, cy + hm)
    root = BASE + proj + "/"
    cdir = os.path.join(out, "cache")
    meta = json.loads(get(root + "ept.json", os.path.join(cdir, "ept.json")))
    b = meta["bounds"]
    hier = {}
    def load_h(key):
        h = json.loads(get(root + "ept-hierarchy/%s.json" % key, os.path.join(cdir, "h", key + ".json")))
        hier.update(h)
    load_h("0-0-0-0")
    nodes = []
    def walk(d, x, y, z):
        key = "%d-%d-%d-%d" % (d, x, y, z)
        if key not in hier:
            return
        if hier[key] == -1:
            load_h(key)
        w = (b[3] - b[0]) / 2 ** d
        x0 = b[0] + x * w; y0 = b[1] + y * w
        if x0 > box[2] or x0 + w < box[0] or y0 > box[3] or y0 + w < box[1]:
            return
        if hier[key] > 0:
            nodes.append(key)
        if d < maxd:
            for dx in (0, 1):
                for dy in (0, 1):
                    for dz in (0, 1):
                        walk(d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz)
    walk(0, 0, 0, 0)
    print("nodes", len(nodes), "points (upper bound)", sum(hier[n] for n in nodes))
    cols = {k: [] for k in ("x", "y", "z", "i", "c", "r", "d")}
    from concurrent.futures import ThreadPoolExecutor
    def one(key):
        raw = get(root + "ept-data/%s.laz" % key, os.path.join(cdir, "d", key + ".laz"))
        las = laspy.read(io.BytesIO(raw))
        x = np.asarray(las.x); y = np.asarray(las.y)
        m = (x >= box[0]) & (x <= box[2]) & (y >= box[1]) & (y <= box[3])
        return key, m, x[m], y[m], np.asarray(las.z)[m], np.asarray(las.intensity)[m], np.asarray(las.classification)[m], np.asarray(las.return_number)[m]
    with ThreadPoolExecutor(12) as ex:
        for n, (key, m, x, y, z, i, c, r) in enumerate(ex.map(one, nodes)):
            cols["x"].append(x); cols["y"].append(y); cols["z"].append(z); cols["i"].append(i); cols["c"].append(c); cols["r"].append(r)
            cols["d"].append(np.full(m.sum(), int(key.split("-")[0]), np.uint8))
            if n % 200 == 0:
                print(n, key, m.sum(), flush=True)
    a = {k: np.concatenate(v) for k, v in cols.items()}
    np.savez_compressed(os.path.join(out, "points.npz"), **a, center=np.array([cx, cy, lon, lat, k]))
    print("kept", len(a["x"]), "z", a["z"].min(), a["z"].max(), "classes", np.unique(a["c"], return_counts=True))

main()
