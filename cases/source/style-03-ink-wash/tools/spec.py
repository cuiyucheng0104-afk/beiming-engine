"""把混音画成频谱图 + 拍点竖线（自查用）。用法：python tools/spec.py out/mix.wav timeline.json out.png"""
import sys, json, numpy as np, soundfile as sf
from PIL import Image, ImageDraw
x, sr = sf.read(sys.argv[1]); x = x.mean(1) if x.ndim > 1 else x
TL = json.load(open(sys.argv[2]))
hop, nf = 256, 2048; W = (len(x) - nf) // hop
win = np.hanning(nf); S = np.empty((nf // 2, W))
for i in range(W): S[:, i] = np.abs(np.fft.rfft(x[i * hop:i * hop + nf] * win))[:nf // 2]
S = 20 * np.log10(S / S.max() + 1e-9); S = np.clip((S + 85) / 85, 0, 1)
# 对数频率轴 40 Hz–12 kHz
H = 400; f = np.arange(nf // 2) * sr / nf
fy = np.geomspace(40, 12000, H)[::-1]; idx = np.searchsorted(f, fy)
img = (S[idx] * 255).astype(np.uint8)
im = Image.fromarray(img).resize((1900, H)).convert('RGB'); d = ImageDraw.Draw(im)
dur = len(x) / sr
for b in TL['beats']:
    X = int(b['t'] / dur * 1900); d.line([(X, 0), (X, 12)], fill=(255, 80, 60)); d.text((X + 2, 0), str(b['b']), fill=(255, 200, 0))
# 包络
env = np.array([np.sqrt(np.mean(x[i * hop:i * hop + nf] ** 2)) for i in range(W)])
e = 20 * np.log10(env + 1e-7); e = np.clip((e + 70) / 70, 0, 1)
pts = [(int(i / W * 1900), int(H - 1 - e[i] * 120)) for i in range(0, W, 4)]
d.line(pts, fill=(80, 220, 255), width=1)
im.save(sys.argv[3])
