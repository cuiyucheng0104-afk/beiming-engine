"""拍点核对：画面事件（events.json）↔ 节拍网格（timeline.json）↔ 配乐重音（score.json）↔ 混音实测起音（out/stem_*.wav）
用法：python tools/cuecheck.py    退出码 0 = 全部 ≤ 容差"""
import json, os, sys
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = json.load(open(os.path.join(HERE, 'out', 'score.json')))
FPS = TL['fps']; beats = np.array([b['t'] for b in TL['beats']])
ON_BEAT = {'cmd', 'stamp', 'catch', 'pour', 'zip', 'dash', 'brush', 'shine', 'switch', 'cut', 'hb', 'slam', 'bonk', 'snap', 'tick', 'press',
           'crack', 'flip', 'speed', 'land', 'ring', 'leaves', 'cheer', 'crouch', 'confetti', 'claps', 'yawn', 'zzz', 'flood', 'appleFall'}
bad = 0
print('— 1. 画面事件 ↔ 节拍网格 —')
worst = 0; n = 0
for e in EV:
    if e['type'] not in ON_BEAT: continue
    d = (e['t'] - beats[np.abs(beats - e['t']).argmin()]) * 1000; n += 1
    fq = abs(e['t'] * FPS - round(e['t'] * FPS)) / FPS * 1000      # 帧量化误差
    worst = max(worst, abs(d), fq)
    if abs(d) > .5 or fq > .5: print(f"  ✗ {e['type']:<10} t={e['t']:.4f}  偏离网格 {d:+.2f} ms  帧量化 {fq:.2f} ms"); bad += 1
print(f'  {n} 个拍点事件，最大偏差 {worst:.3f} ms')
print('— 2. 配乐重音 ↔ 节拍网格 —')
mh = np.array([h[0] for h in SC['music_hits']]); worst = 0
for t, nm in SC['music_hits']:
    d = (t - beats[np.abs(beats - t).argmin()]) * 1000; worst = max(worst, abs(d))
    if abs(d) > .5: print(f'  ✗ {nm} t={t:.4f} 偏离 {d:+.2f} ms'); bad += 1
print(f'  {len(mh)} 个重音，最大偏差 {worst:.3f} ms')
print('— 3. 关键画面动作 ↔ 配乐重音 —')
KEY = {'cmd', 'stamp', 'switch', 'slam', 'catch'}
worst = 0; k = 0
for e in EV:
    if e['type'] not in KEY: continue
    if e['type'] == 'catch' and e['t'] < 5: continue        # 第 1 关接住由木琴/篮子声承担，不在铜管重音表里
    d = (e['t'] - mh[np.abs(mh - e['t']).argmin()]) * 1000; k += 1; worst = max(worst, abs(d))
    if abs(d) > .5: print(f"  ✗ {e['type']} t={e['t']:.4f} 最近重音偏 {d:+.2f} ms"); bad += 1
print(f'  {k} 个关键动作，最大偏差 {worst:.3f} ms')
print('— 4. 混音实测起音（鼓 + 铜管 + 拟音分轨，包络过阈）—')
def env(path):
    x, sr = sf.read(path); x = np.abs(x.mean(1)) if x.ndim == 2 else np.abs(x)
    w = int(.001 * sr); return np.convolve(x, np.ones(w) / w, 'same'), sr
offs = []
dr, sr = env(os.path.join(HERE, 'out', 'stem_drums.wav')); br, _ = env(os.path.join(HERE, 'out', 'stem_brass.wav')); fx, _ = env(os.path.join(HERE, 'out', 'stem_fx.wav'))
def onset(e, t, sr):
    a, b = int((t - .03) * sr), int((t + .06) * sr); seg = e[max(0, a):b]
    if len(seg) == 0 or seg.max() < 1e-4: return None
    pre = e[max(0, a - int(.05 * sr)):a]; floor = pre.mean() if len(pre) else 0
    th = floor + (seg.max() - floor) * .3; i = np.argmax(seg > th); return (max(0, a) + i) / sr - t
for t, nm in SC['music_hits']:
    cand = [o for o in (onset(dr, t, sr), onset(br, t, sr)) if o is not None]
    if cand: o = min(cand, key=abs); offs.append(o * 1000); print(f'  {nm:<6} {t:7.3f}s  起音 {o * 1000:+6.1f} ms')
for e in EV:
    if e['type'] in ('switch', 'stamp', 'catch', 'crack', 'cut', 'hb', 'slam'):
        o = onset(fx, e['t'], sr)
        if o is not None: offs.append(o * 1000); print(f"  拟音 {e['type']:<6} {e['t']:7.3f}s  起音 {o * 1000:+6.1f} ms")
offs = np.array(offs)
print(f'  实测起音：中位 {np.median(offs):+.1f} ms，最大 |偏差| {np.abs(offs).max():.1f} ms（含采样自身的起音瞬态）')
if np.abs(offs).max() > 25: bad += 1; print('  ✗ 有起音偏差 > 25 ms')
print('通过' if not bad else f'{bad} 项不通过'); sys.exit(1 if bad else 0)
