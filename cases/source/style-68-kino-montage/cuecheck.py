#!/usr/bin/env python3
"""拍点核对：视觉事件（events.json，来自 index.html 的 window.EV）↔ 音乐网格 ↔ 实际混音 ↔ 实际画面。

    $LIB/.venv/bin/python cuecheck.py            (需要 events.json、out/score.json、out/mix.wav；有 out/video.mp4 时也查画面)

1. 网格：每个事件到最近 16 分音符（0.125 s）的偏差，和到最近整帧（1/24 s）的偏差。
2. 配乐锚点：mix.py 记录的每个音乐重音（out/score.json）与对应视觉事件的时间差。
3. 混音实测：在 mix.wav 上做起音检测（谱通量，hop 2.5 ms），每个重音事件找最近的起音。
4. 画面实测：每个剪切类事件，检查该帧相对前一帧的画面突变是否落在这一帧。
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent
EV = json.load(open(HERE / "events.json"))["ev"]
SC = json.load(open(HERE / "out" / "score.json"))
FPS, G = 24, 0.125
fail = 0

print("== 1. 网格（16 分音符 0.125 s = 3 帧）")
worst_g = worst_f = 0
for e in EV:
    t = e["t"]; dg = abs(t - round(t / G) * G) * 1000; df = abs(t * FPS - round(t * FPS)) / FPS * 1000
    worst_g = max(worst_g, dg); worst_f = max(worst_f, df)
    if dg > .5: print(f"  ! {e['type']:8s} {t:7.3f}s 偏离网格 {dg:.1f} ms"); fail += 1
print(f"  {len(EV)} 个事件，最大网格偏差 {worst_g:.2f} ms，最大整帧偏差 {worst_f:.2f} ms")

print("== 2. 配乐锚点 ↔ 视觉事件")
MAP = {"land": "land", "stamp": "stamp", "jump": "jump", "turn": "turn", "bar0": "bar", "bar1": "bar", "num2": "stamp", "tilt": "tilt",
       "window": "window", "cellTitle": "cell", "count": "count", "hit": "hit", "numH": "stamp", "restamp": "restamp", "restamp2": "restamp", "end": "end"}
worst = 0
for a in SC["anchors"]:
    l, t = a["label"], a["t"]
    ty = MAP.get(l) or ("cell" if l.startswith("cell") else "floor" if l.startswith("floor") else None)
    cand = [e["t"] for e in EV if e["type"] == ty]
    d = min(abs(t - c) for c in cand) * 1000 if cand else 1e9
    worst = max(worst, d)
    if d > .5: print(f"  ! {l:10s} {t:7.3f}s 无对应视觉事件 (最近 {d:.1f} ms)"); fail += 1
print(f"  {len(SC['anchors'])} 个音乐锚点，最大偏差 {worst:.2f} ms")

print("== 3. 混音实测起音")
x, sr = sf.read(HERE / "out" / "mix.wav"); x = x.mean(1)
hop, win = int(sr * .0025), 1024
frames = np.lib.stride_tricks.sliding_window_view(np.pad(x, (win, win)), win)[::hop] * np.hanning(win)
mag = np.abs(np.fft.rfft(frames, axis=1))
flux = np.maximum(0, np.diff(np.log1p(mag * 50), axis=0)).sum(1)
flux = np.concatenate([[0], flux]); ft = np.arange(len(flux)) * hop / sr - win / sr + win / 2 / sr
HITS = {"land", "stamp", "jump", "turn", "count", "floor", "hit", "restamp", "cell", "window", "tilt", "end"}
devs = []
for e in EV:
    if e["type"] not in HITS: continue
    m = (ft > e["t"] - .03) & (ft < e["t"] + .05)
    if not m.any(): continue
    fm, tm = flux[m], ft[m]
    pk = [j for j in range(1, len(fm) - 1) if fm[j] >= fm[j - 1] and fm[j] >= fm[j + 1] and fm[j] >= .5 * fm.max()]
    tp = tm[min(pk, key=lambda j: abs(tm[j] - e["t"]))] if pk else tm[np.argmax(fm)]
    devs.append((tp - e["t"]) * 1000)
devs = np.array(devs)
off0 = np.median(devs)
print(f"  {len(devs)} 个重音事件：起音 − 事件 = 中位 {off0:+.1f} ms（分析窗的固定偏移），扣除后最大 |偏差| {np.abs(devs - off0).max():.1f} ms，hop 分辨率 2.5 ms")
s0, s1 = SC["silence"]
sil = x[int((s0 + .01) * sr):int((s1 - .01) * sr)]
print(f"  静默 {s0}–{s1}s：RMS {20*np.log10(np.sqrt(np.mean(sil**2))+1e-12):.1f} dBFS；静默后第一声 {s1}s 峰值 {20*np.log10(np.abs(x[int(s1*sr):int((s1+.3)*sr)]).max()):.1f} dBFS")

vid = HERE / "out" / "video.mp4"
if vid.exists():
    print("== 4. 画面实测剪切")
    w, h = 192, 108
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(vid), "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    v = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    diff = np.concatenate([[0], np.abs(np.diff(v, axis=0)).mean((1, 2))])
    CUTS = [e for e in EV if e["type"] in ("turn", "cell", "count", "floor", "silence", "hit", "jump")]   # slams (stamp, restamp, end) travel into the beat and are checked by sound
    off = []
    for e in CUTS:
        f = int(round(e["t"] * FPS))
        lo, hi = max(1, f - 2), min(len(diff) - 1, f + 2)
        k = lo + int(np.argmax(diff[lo:hi + 1]))
        off.append(k - f)
        if k != f: print(f"  ~ {e['type']:7s} {e['t']:7.3f}s 最大画面突变在第 {k} 帧（事件帧 {f}）")
    off = np.array(off)
    print(f"  {len(off)} 个剪切/落版事件：画面突变正好落在事件帧的 {np.sum(off == 0)} 个，最大偏差 {np.abs(off).max()} 帧")
print("结果:", "通过" if fail == 0 else f"{fail} 处问题")
sys.exit(1 if fail else 0)
