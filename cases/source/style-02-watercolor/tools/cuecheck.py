# 拍点核对：画面事件（events.json，来自页面的 window.EV）↔ 音乐拍点（out/score_cues.json，来自 mix.py）↔ 节拍网格（timeline.json）
# 另外在 out/music.wav 上做实测起音检测（能量通量峰值），报告实测偏差。
# 用法：$LIB/.venv/bin/python tools/cuecheck.py <工程目录>
import sys, os, json, numpy as np, soundfile as sf
D = sys.argv[1] if len(sys.argv) > 1 else '.'
TL = json.load(open(os.path.join(D, 'timeline.json'))); EV = json.load(open(os.path.join(D, 'events.json')))['ev']
SCU = json.load(open(os.path.join(D, 'out', 'score_cues.json')))['cues']
FPS = TL['FPS']; grid = TL['T']
vis = {}
for e in EV:
    if e.get('hit'): vis.setdefault(e['hit'], e['t'])
x, sr = sf.read(os.path.join(D, 'out', 'music.wav')); x = x.mean(1)
hop = int(sr * .002); n = len(x) // hop
en = np.sqrt(np.add.reduceat(x[:n * hop] ** 2, np.arange(0, n * hop, hop)) / hop + 1e-12)
db = 20 * np.log10(en); flux = np.maximum(0, np.diff(db, prepend=db[0]))
def measured(t):
    i0, i1 = int((t - .012) / .002), int((t + .03) / .002)
    w = flux[i0:i1]
    return (i0 + int(np.argmax(w))) * .002 - t if len(w) else None
rows, worst, worst_frame = [], 0.0, 0.0
print(f"{'拍点':<9}{'网格 s':>8}{'画面 s':>9}{'音乐 s':>9}{'画面-音乐 ms':>13}{'帧量化 ms':>11}{'实测起音 ms':>12}")
for k, g in grid.items():
    v, m = vis.get(k), SCU.get(k)
    if v is None and m is None: continue
    dvm = (v - m) * 1000 if (v is not None and m is not None) else float('nan')
    fq = abs(round(g * FPS) / FPS - g) * 1000
    me = measured(m) if m is not None else None
    if v is not None and m is not None: worst = max(worst, abs(dvm))
    worst_frame = max(worst_frame, fq)
    print(f"{k:<10}{g:>8.3f}{(v if v is not None else float('nan')):>9.3f}{(m if m is not None else float('nan')):>9.3f}{dvm:>13.1f}{fq:>11.2f}{(me * 1000 if me is not None else float('nan')):>12.1f}")
missing_v = [k for k in grid if k not in vis]; missing_m = [k for k in grid if k not in SCU]
print(f"\n画面↔音乐最大偏差 {worst:.1f} ms；拍点帧量化最大偏差 {worst_frame:.2f} ms（{FPS} fps）")
if missing_v: print('无画面事件的拍点：', missing_v)
if missing_m: print('无音乐落点的拍点：', missing_m)
# 摆尾（每一下都应在拍上）
fl = [e['t'] for e in EV if e['type'] == 'flick']
fd = max(abs(f - g) for f, g in zip(fl, TL['FLICKS'])) * 1000
print(f"摆尾 {len(fl)} 次，与 TL.FLICKS 最大偏差 {fd:.1f} ms")
sys.exit(0 if worst < 0.5 and worst_frame < 0.5 else 1)
