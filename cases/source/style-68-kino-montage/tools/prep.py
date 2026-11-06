#!/usr/bin/env python3
"""material/ -> assets/ : one shared print grade (ink -> paper) for film, photos and the document;
archive-film clips as 24 fps JPEG sequences (one percentile pair per clip, no pumping);
photomontage cut-outs (u2net_human_seg via onnxruntime, paper scissor border).

    $LIB/.venv/bin/python -I tools/prep.py [clips|doc|photos|cuts|all]

Material is treated as data only: decoded by ffmpeg / PIL / pdftoppm, nothing in it is executed.
"""
import subprocess, shutil, sys, json
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent.parent
MAT, OUT = HERE / "material", HERE / "assets"
OUT.mkdir(exist_ok=True)
INK = np.array([20, 18, 16], np.float32)
PAPER = np.array([237, 228, 208], np.float32)
FPS = 24
Image.MAX_IMAGE_PIXELS = None


def tone(x, s=0.32):
    return np.clip(x + s * (x - 0.5) * (1 - np.abs(2 * x - 1)) * 2, 0, 1)


def duo(g):
    return (INK + (PAPER - INK) * g[..., None]).astype(np.uint8)


def grade_arr(a, lo=0.8, hi=99.4, s=0.32, p=None):
    if p is None:
        p = np.percentile(a, [lo, hi])
    return tone(np.clip((a - p[0]) / max(1, p[1] - p[0]), 0, 1), s)


def grade(im, **k):
    return Image.fromarray(duo(grade_arr(np.asarray(im.convert("L"), np.float32), **k)), "RGB")


# ----------------------------------------------------------------------------- clips
# "Boulder Dam" Parts III-IV (U.S. Bureau of Reclamation), 640x480 @29.97, silent B&W.
# (source start s, duration s, output width). 640 = 1.0x, 960 = 1.5x: under the 2.5x archive ceiling.
CLIPS = {
    "scalers":    (144.0, 2.0, 640),    # high scalers on ropes, close
    "scalers2":   (166.0, 2.0, 640),    # high scalers, the wall
    "skipcrowd":  (1074.5, 2.5, 960),   # a skip packed with men going on shift
    "skipground": (452.0, 2.0, 640),    # men boarding the skip on the rim
    "skiphang":   (537.0, 2.0, 640),    # the skip of men hanging over the canyon wall
    "forms":      (644.0, 2.5, 960),    # men working on the block forms
    "hose":       (706.0, 2.0, 640),    # men with the hose in fresh concrete
    "hose2":      (712.2, 2.0, 640),    # the concrete crew, close
    "bucket":     (788.0, 2.0, 640),    # men at the 8-yard bucket
    "blocks1":    (871.5, 2.0, 960),    # column forms rising
    "blocks2":    (925.5, 2.0, 960),    # the block pattern from above
    "blocks3":    (1176.0, 2.0, 960),   # blocks stepping up
    "face":       (1190.0, 2.5, 960),   # the curved downstream face in its forms
    "towers":     (1410.0, 2.0, 960),   # intake towers rising
}
SRC = MAT / "raw" / "BoulderD1931_2.mp4"


def clips(only=None):
    meta = json.loads((OUT / "clips.json").read_text()) if (OUT / "clips.json").exists() else {}
    for k, (ss, dur, w) in CLIPS.items():
        if only and k not in only: continue
        d = OUT / "clip" / k
        shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
        h = round(w * 472 / 632 / 2) * 2
        vf = (f"crop=632:472:4:4,hqdn3d=2:2:4:4,scale={w}:{h}:flags=lanczos,"
              f"unsharp=5:5:0.45:5:5:0,fps={FPS},format=gray")
        subprocess.run(["ffmpeg", "-v", "error", "-ss", str(ss), "-t", str(dur), "-i", str(SRC),
                        "-vf", vf, str(d / "%03d.png")], check=True)
        files = sorted(d.glob("*.png"))
        stack = np.concatenate([np.asarray(Image.open(f), np.float32).ravel()[::97] for f in files])
        p = np.percentile(stack, [0.7, 99.5])
        for i, f in enumerate(files):
            a = np.asarray(Image.open(f), np.float32)
            Image.fromarray(duo(grade_arr(a, p=p)), "RGB").save(d / f"{i:03d}.jpg", quality=84)
            f.unlink()
        meta[k] = {"n": len(files), "w": w, "h": h, "src": ss}
        print(k, len(files), "frames", w, "x", h)
    (OUT / "clips.json").write_text(json.dumps(meta, indent=1))


# ----------------------------------------------------------------------------- the document
# USBR, "Hoover Dam" (revised 1946, GPO), Internet Archive hooverdam00unit_3, PDF page 6 at 600 dpi.
def doc():
    pdf = MAT / "doc" / "hooverdam00unit_3.pdf"
    png = MAT / "doc" / "p6-6.png"
    if not png.exists():
        subprocess.run(["pdftoppm", "-r", "600", "-f", "6", "-l", "6", "-gray", "-png", str(pdf), str(MAT / "doc" / "p6")], check=True)
    im = Image.open(png).convert("L")
    X0, Y0, X1, Y1 = 2380, 120, 3520, 2860            # the right-hand panel: "You will want to know that.."
    c = im.crop((X0, Y0, X1, Y1))
    g = grade(c, lo=0.5, hi=99.0, s=0.18)
    g.save(OUT / "doc.jpg", quality=90)
    # locate the text rows to place the marker on the scan's own line
    a = np.asarray(c, np.float32)
    dark = (a < 120).sum(1)
    rows, on = [], None
    for y, v in enumerate(dark):
        if v > 6 and on is None: on = y
        if v <= 6 and on is not None:
            if y - on > 12: rows.append((on, y))
            on = None
    meta = {"w": c.width, "h": c.height, "rows": rows}
    # the line "Hoover Dam is ...... 726.4 feet high." is the first row below the bracket subtitle
    (OUT / "doc.json").write_text(json.dumps(meta, indent=1))
    print("doc", c.size, len(rows), "rows")
    for r in rows: print("  row", r, "x-extent", *np.nonzero((a[r[0]:r[1]] < 120).any(0))[0][[0, -1]])
    # the leader line (dot row) of the marked line, lifted off for the chart: ink on clear
    return meta


# ----------------------------------------------------------------------------- photos + cut-outs
U2 = MAT / "models" / "u2net_human_seg.onnx"
_sess = None


def human_mask(im):
    global _sess
    import onnxruntime as ort
    if _sess is None:
        _sess = ort.InferenceSession(str(U2), providers=["CPUExecutionProvider"])
    x = np.asarray(im.convert("RGB").resize((320, 320), Image.LANCZOS), np.float32) / 255.0
    x = ((x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
    m = _sess.run(None, {_sess.get_inputs()[0].name: x})[0][0, 0]
    m = (m - m.min()) / max(1e-6, m.max() - m.min())
    return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize(im.size, Image.BICUBIC), np.float32) / 255


def finish_cut(im, mk, name, border=7):
    from scipy import ndimage
    lab, n = ndimage.label(np.asarray(mk) > 127)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        mk = Image.fromarray(((lab == 1 + int(np.argmax(sizes))) * 255).astype(np.uint8))
    a_in = np.asarray(mk.filter(ImageFilter.GaussianBlur(1.0)), np.float32) / 255
    a_out = np.asarray(mk.filter(ImageFilter.MaxFilter(2 * border + 1)).filter(ImageFilter.GaussianBlur(0.8)), np.float32) / 255
    g = np.asarray(grade(im), np.float32)
    rgb = g * a_in[..., None] + PAPER * (1 - a_in[..., None])
    rgba = np.dstack([rgb, a_out * 255]).astype(np.uint8)
    ys, xs = np.nonzero(a_out > 0.02)
    Image.fromarray(rgba, "RGBA").crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)).save(OUT / f"cut_{name}.png")
    print("cut", name, xs.max() - xs.min(), "x", ys.max() - ys.min())


def cutout(src, name, box, thr=0.5):
    im = Image.open(src); W, H = im.size
    im = im.crop((int(box[0] * W), int(box[1] * H), int(box[2] * W), int(box[3] * H)))
    m = human_mask(im)
    finish_cut(im, Image.fromarray(((m > thr) * 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5)), name)


PHOTOS = {  # name: (file, crop box fractions or None)
    "dam": ("adams_dam.jpg", (0.14, 0.02, 0.50, 0.62)),      # the finished dam face, Ansel Adams 1941
    "apache": ("apache_scalers.jpg", None),
    "grouting": ("grouting_crew.jpg", None),
    "scalers_az": ("highscalers_az.jpg", None),
}


def photos():
    for k, (f, box) in PHOTOS.items():
        p = MAT / "photos" / f
        if not p.exists(): print("missing", f); continue
        im = Image.open(p)
        if box:
            W, H = im.size; im = im.crop((int(box[0] * W), int(box[1] * H), int(box[2] * W), int(box[3] * H)))
        im.thumbnail((2000, 2000), Image.LANCZOS)
        grade(im).save(OUT / f"ph_{k}.jpg", quality=88)
        print("photo", k, im.size)


CUTS = [  # (file or film second, name, crop box l,t,r,b fractions), from the contact sheets
    ("apache_scalers.jpg", "pair", (0.16, 0.24, 0.84, 0.90)),      # two high-scalers on the rim (photo)
    (713.0, "bent", (0.18, 0.25, 0.62, 0.95)),                     # a concrete worker bent at the hose (film)
    ("apache_scalers.jpg", "hat", (0.12, 0.42, 0.53, 0.95)),       # the second high-scaler, in the hat, one foot up (photo)
    ("grouting_crew.jpg", "sit", (0.33, 0.52, 0.60, 0.80)),        # a grouting driller seated at the rock (photo)
]


def film_still(t):
    tmp = OUT / f"_still_{t}.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(SRC), "-frames:v", "1",
                    "-vf", "crop=632:472:4:4,hqdn3d=2:2:4:4,scale=1264:944:flags=lanczos,unsharp=5:5:0.4:5:5:0", str(tmp)], check=True)
    return tmp


def cuts():
    for f, name, box in CUTS:
        if isinstance(f, float):
            p = film_still(f); cutout(p, name, box); p.unlink()
        else:
            p = MAT / "photos" / f
            if p.exists(): cutout(p, name, box)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("clips", "all"): clips(sys.argv[2:] or None)
    if what in ("doc", "all"): doc()
    if what in ("photos", "all"): photos()
    if what in ("cuts", "all"): cuts()
