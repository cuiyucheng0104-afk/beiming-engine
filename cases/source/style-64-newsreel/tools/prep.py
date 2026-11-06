#!/usr/bin/env python3
"""material/ -> assets/ : one base grade for every source (STYLE.md §2), archive film upscaled
(hqdn3d -> lanczos -> unsharp, ~2.26x) into 24 fps JPEG sequences with ONE level set per clip,
grid stills, the newspaper column, halftoned news photos, and the projected map.
Run with the library venv and -I (sources are untrusted data; nothing in them is executed):
  $LIB/.venv/bin/python -I tools/prep.py [--only clips|stills|paper|map]
"""
import json, math, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
RAW, PRINT, MAPD, OUT = HERE / "material/raw", HERE / "material/print", HERE / "material/map", HERE / "assets"
OUT.mkdir(exist_ok=True)
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
TL = json.loads((HERE / "timeline.json").read_text())
GW, GH = 1480, 1080
VF = "hqdn3d=4:3:6:5,scale=1480:1084:flags=lanczos,setsar=1,crop=1480:1080,unsharp=5:5:0.55"


def levels(a, lo=0.6, hi=99.6):
    return np.percentile(a, [lo, hi])


def grade_arr(a, p0, p1, black=14, white=238, gamma=1.0):
    gamma = gamma or 1.0
    x = np.clip((a - p0) / max(1, p1 - p0), 0, 1) ** gamma
    x = x + 0.18 * (x - 0.5) * (1 - np.abs(2 * x - 1))          # mild S-curve
    return (black + np.clip(x, 0, 1) * (white - black)).astype(np.uint8)


# the freeze frame is held for 2.75 s and pushed in, so it gets its own cleaner pass:
# stronger denoise at source size, then a second light spatial denoise + a firmer unsharp after the upscale
VF_FREEZE = "hqdn3d=6:5:8:6,scale=1480:1084:flags=lanczos,setsar=1,crop=1480:1080,unsharp=5:5:0.55,hqdn3d=1.5:1.5:0:0,unsharp=5:5:0.8"


def frames(src, t0, dur, fps=24, vf=VF):
    tmp = Path(tempfile.mkdtemp())
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.3f}", "-i", str(RAW / src), "-t", f"{dur:.3f}",
                    "-vf", f"fps={fps},{vf},format=gray", "-q:v", "2", str(tmp / "%04d.png")], check=True)
    fs = sorted(tmp.glob("*.png"))
    return tmp, [np.asarray(Image.open(f), np.float32) for f in fs]


def still(src, t):
    tmp, fr = frames(src, t, 1 / 24 + .001)
    shutil.rmtree(tmp)
    return fr[0]


# ------------------------------------------------------------------ archive clips
if ONLY in (None, "clips"):
    for k, c in TL["CLIPS"].items():
        tmp, fr = frames(c["src"], c["in"], c["dur"])
        stack = np.stack(fr[:: max(1, len(fr) // 12)])
        p0, p1 = levels(stack, *c.get("lv", [0.6, 99.6]))           # one level set per clip
        d = OUT / k
        shutil.rmtree(d, ignore_errors=True); d.mkdir()
        for i, a in enumerate(fr):
            Image.fromarray(grade_arr(a, p0, p1, gamma=c.get("g")), "L").save(d / f"{i:03d}.jpg", quality=88)
        shutil.rmtree(tmp)
        print(k, len(fr), "frames, levels", round(p0, 1), round(p1, 1))
        if k == "rollin":                                            # the frame shown from HIT.freeze on
            fi = int((TL["ROLL_SRC0"] + TL["HIT"]["freeze"] - TL["HIT"]["roll_cut"]) * 24 + 1e-6)
            tmp, fr2 = frames(c["src"], c["in"], c["dur"], vf=VF_FREEZE)
            Image.fromarray(grade_arr(fr2[fi], p0, p1, gamma=c.get("g")), "L").save(OUT / "freeze.jpg", quality=92)
            shutil.rmtree(tmp)
            print("freeze frame", fi)

# ------------------------------------------------------------------ grid stills (+ the flip-book's first page)
if ONLY in (None, "stills"):
    tk = TL["CLIPS"]["takeoff"]
    srcs = [("fc-fc-1956.mp4", t) for t in TL["STILLS"]] + [("fc-fc-1956.mp4", tk["in"] + TL["FLIP_SRC"][0])]
    for i, (s, t) in enumerate(srcs):
        a = still(s, t)
        p0, p1 = levels(a)
        Image.fromarray(grade_arr(a, p0, p1), "L").save(OUT / f"cell{i}.jpg", quality=88)
    print("cells", len(srcs))

# ------------------------------------------------------------------ newspaper: the AIR TOUR column only + two halftone photos
if ONLY in (None, "paper"):
    p = Image.open(PRINT / "brownsville-herald-1929-10-05-p1.jpg").convert("L")
    # the "FLIERS BEGIN 1929 AIR TOUR" column; the neighbouring stories and the front-page headline stay out
    col = p.crop((935, 2625, 1352, 3520))
    a = np.asarray(col, np.float32); p0, p1 = levels(a, .3, 99.2)
    Image.fromarray(grade_arr(a, p0, p1, black=28, white=232), "L").save(OUT / "column.jpg", quality=90)
    print("column", col.size)
    for i, t in enumerate(TL["PAPER_PHOTOS"]):
        a = still("fc-fc-1956.mp4", t)
        im = Image.fromarray(a.astype(np.uint8), "L").resize((480, 350), Image.LANCZOS)
        a = np.asarray(im, np.float32); p0, p1 = levels(a, 1, 99)
        v = np.clip((a - p0) / (p1 - p0), 0, 1)
        # newspaper halftone: 45-degree dot screen, ~5 px cell
        yy, xx = np.mgrid[0:350, 0:480].astype(np.float32)
        u, w = (xx + yy) / 5.2, (xx - yy) / 5.2
        dot = (np.cos(u * np.pi) * np.cos(w * np.pi) + 1) / 2        # 0..1 screen
        ink = (1 - v) > dot * .98
        out = np.where(ink, 34, 226).astype(np.uint8)
        Image.fromarray(out, "L").resize((480, 350), Image.BILINEAR).save(OUT / f"photo{i}.jpg", quality=90)
    print("photos", len(TL["PAPER_PHOTOS"]))

# ------------------------------------------------------------------ map (Natural Earth 1:50m, public domain): coastlines + lakes, no borders
if ONLY in (None, "map"):
    # Lambert conformal conic, parallels 33 / 45 N, centre 84 W 39 N
    p1_, p2_, l0, f0 = map(math.radians, (33, 45, -84, 39))
    n = math.log(math.cos(p1_) / math.cos(p2_)) / math.log(math.tan(math.pi / 4 + p2_ / 2) / math.tan(math.pi / 4 + p1_ / 2))
    F = math.cos(p1_) * math.tan(math.pi / 4 + p1_ / 2) ** n / n
    r0 = F / math.tan(math.pi / 4 + f0 / 2) ** n
    def proj(lon, lat):
        r = F / math.tan(math.pi / 4 + math.radians(lat) / 2) ** n; th = n * (math.radians(lon) - l0)
        return r * math.sin(th), r0 - r * math.cos(th)
    BB = (-104, 24, -60, 52)
    # frame: lon -100..-66, lat 28..48 fitted into the gate with margins
    cx = [proj(lo, la) for lo in (-99, -66) for la in (28.5, 47.5)]
    xs, ys = [q[0] for q in cx], [q[1] for q in cx]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    k = min((GW - 120) / (x1 - x0), (GH - 140) / (y1 - y0))
    ox = (GW - (x1 - x0) * k) / 2; oy = (GH - (y1 - y0) * k) / 2 + 10
    tr = lambda lon, lat: (lambda q: (round(ox + (q[0] - x0) * k, 1), round(oy + (y1 - q[1]) * k, 1)))(proj(lon, lat))

    def polys(path, keep=lambda pr: True):
        d = json.loads(path.read_text()); out = []
        for ft in d["features"]:
            if not keep(ft["properties"]):
                continue
            g = ft["geometry"]; P = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
            for poly in P:
                ring = poly[0]
                if not any(BB[0] <= lo <= BB[2] and BB[1] <= la <= BB[3] for lo, la in ring):
                    continue
                pts, last = [], None
                for lo, la in ring:
                    lo, la = max(BB[0] - 6, min(BB[2] + 6, lo)), max(BB[1] - 6, min(BB[3] + 6, la))
                    q = tr(lo, la)
                    if last is None or abs(q[0] - last[0]) + abs(q[1] - last[1]) > 1.6:
                        pts.append(q); last = q
                if len(pts) > 3:
                    out.append(pts)
        return out
    land = polys(MAPD / "ne_50m_land.geojson")
    lakes = polys(MAPD / "ne_50m_lakes.geojson", lambda pr: (pr.get("scalerank") if pr.get("scalerank") is not None else 9) <= 2)
    route = [[nm, *tr(lo, la), *(r[3:] if len(r) > 3 else [])] for r in TL["ROUTE"] for nm, lo, la in [r[:3]]]
    # graticule (period map feel), every 5 degrees
    grat = [[tr(lo, la) for la in np.arange(22, 54.1, 1)] for lo in range(-110, -54, 5)] + \
           [[tr(lo, la) for lo in np.arange(-112, -52, 1)] for la in range(25, 55, 5)]
    (OUT / "map.json").write_text(json.dumps({"land": land, "lakes": lakes, "route": route, "grat": grat}))
    print("map: land", len(land), "lakes", len(lakes), "route", len(route))
