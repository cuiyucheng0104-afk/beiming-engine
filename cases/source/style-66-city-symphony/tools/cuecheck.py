"""拍点核对：画面事件（events.json，来自 window.EV）↔ 配乐（out/score.json 的音符起点 + out/music.wav 的实测起音）。
1. 乐谱层：每个剪切 / 关键动作找最近的音符起点，报偏差（毫秒）；同时检查它落在 timeline 的拍点网格上。
2. 音频层：对重音、熄灯、硬停、最后一盏，在 music.wav 里用 2 ms 能量包络找真实起音，报偏差。
用法：python tools/cuecheck.py   退出码 0 = 全部 ≤ 1 帧内且乐谱层 0 ms"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
E = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = json.load(open(os.path.join(HERE, 'out', 'score.json')))
FPS = TL['FPS']
on = np.array([o['t'] for o in SC])

# 网格：拍、八分、三连音、十六分 + 闪回最后一拍的 2 帧
grid = set()
for b in TL['BEATS']:
    for n in (1, 2, 3, 4):
        for k in range(n): grid.add(int(np.floor(b['f'] + k / n * b['len'] + .5)))
last_beat = [b for b in TL['BEATS'] if b['bar'] == 8 and b['beat'] == 4][0]
for k in range(0, last_beat['len'], 2): grid.add(last_beat['f'] + k)

KEY = ('cut', 'hit', 'title', 'quote', 'brake', 'light_off', 'stop', 'last', 'cell', 'lights_on', 'laser')
rows, worst, off_grid = [], 0.0, []
for e in E:
    if e['type'] not in KEY: continue
    j = int(np.argmin(np.abs(on - e['t']))); d = (on[j] - e['t']) * 1000
    worst = max(worst, abs(d)); rows.append((e['f'], e['type'], e.get('shot', e.get('what', '')), SC[j]['inst'], d))
    if e['f'] not in grid: off_grid.append((e['f'], e['type']))
print(f'乐谱层：{len(rows)} 个画面事件，最大偏差 {worst:.3f} ms；不在拍点网格上的：{off_grid or "无"}')
for f, ty, sh, inst, d in rows:
    if ty in ('cut', 'hit', 'brake', 'light_off', 'stop', 'last', 'title', 'quote') and ty != 'cell':
        print(f'  帧 {f:3d}  {f / FPS:6.3f}s  {ty:9s} {sh:14s} ↔ {inst:13s} {d:+.3f} ms')

# 音频层
from scipy.signal import butter, sosfilt
x, sr = sf.read(os.path.join(HERE, 'out', 'music.wav')); m = x.mean(1)
hop = int(.002 * sr)
env = np.sqrt(np.convolve(m ** 2, np.ones(hop) / hop, 'same'))[::hop]
mh = sosfilt(butter(4, 1200, 'high', fs=sr, output='sos'), m)          # 起音的高频瞬态
envh = np.sqrt(np.convolve(mh ** 2, np.ones(hop) / hop, 'same'))[::hop]
def onset(t, w=.035):
    a, b = max(1, int((t - w) * sr / hop)), int((t + w) * sr / hop)
    seg = 20 * np.log10(envh[a - 1:b] + 1e-7); d = np.diff(seg)
    k = int(np.argmax(d)); return (a + k) * hop / sr
aud = []
for e in E:
    if e['type'] in ('hit', 'light_off', 'stop', 'last') or (e['type'] == 'cut' and e.get('shot') in ('S15',)):
        if e['type'] == 'stop':   # 硬停是"切断"：找能量下跌
            a, b = int((e['t'] - .06) * sr / hop), int((e['t'] + .06) * sr / hop)
            seg = 20 * np.log10(env[a:b] + 1e-7); k = int(np.argmin(np.diff(seg))); t = (a + k + 1) * hop / sr
        else: t = onset(e['t'])
        aud.append((e['f'], e['type'], (t - e['t']) * 1000))
print('音频层（music.wav 实测，1.2 kHz 以上 2 ms 包络的最大跃升，窗口 ±35 ms）：')
for f, ty, d in aud: print(f'  帧 {f:3d} {ty:9s} {d:+6.1f} ms')
ok = worst < .5 and not off_grid and all(abs(d) <= 1000 / FPS for _, _, d in aud)
print('结论：', 'OK，全部卡拍' if ok else '有偏差，见上')
sys.exit(0 if ok else 1)
