"""拍点核对：python tools/cuecheck.py [film.mp4]
1) 网格：每个事件都在十六分网格上、落在整帧上（120 BPM × 24 fps）。
2) 页面 EV 与 timeline 一致；每个画面事件在 music_cues.json 里有同一时刻放下的声音（理论偏差）。
3) 实测：在 mix.wav 上找每个关键事件附近的起音点；在成片画面上找每个剪切/弹出开始变化的那一帧。"""
import json, os, sys, subprocess
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
CUE = json.load(open(os.path.join(HERE, 'out', 'music_cues.json')))
FPS, BEAT = TL['FPS'], TL['BEAT']
bad = 0

# 1) 网格
off = [(e['t'], e['type']) for e in EV if abs(e['t'] * FPS - round(e['t'] * FPS)) > 1e-6 or abs(e['t'] / (BEAT / 4) - round(e['t'] / (BEAT / 4))) > 1e-6]
print(f'[网格] {len(EV)} 个事件，不在十六分/整帧上的: {len(off)}', off[:5]); bad += len(off)
# 2) 页面 vs timeline，画面事件 vs 放下的声音
same = len(EV) == len(TL['EV']) and all(abs(a['t'] - b['t']) < 1e-9 and a['type'] == b['type'] for a, b in zip(EV, TL['EV']))
print(f'[一致] 页面 EV 与 timeline.mjs 一致: {same}'); bad += (not same)
ct = np.array([c['t'] for c in CUE]); devs = []
for e in EV:
    d = np.min(np.abs(ct - e['t'])) * 1000; devs.append(d)
    if d > .5: print('   没有对上声音:', e['t'], e['type'], f'{d:.1f} ms'); bad += 1
print(f'[理论] 画面事件 → 声音起点 最大偏差 {max(devs):.2f} ms，平均 {np.mean(devs):.2f} ms')
# 3a) 实测：音频起音
x, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav')); m = np.abs(x).mean(1)
hop = int(.002 * sr); envl = np.sqrt(np.convolve(m ** 2, np.ones(hop * 2) / (hop * 2), 'same'))[::hop]
def onset(t, w=.06):
    i0, i1 = int((t - w) * sr / hop), int((t + w) * sr / hop); seg = np.log(envl[i0:i1] + 1e-5); dif = np.diff(seg)
    return (i0 + np.argmax(dif) + 1) * hop / sr
KEY = ['flash', 'call', 'stamp', 'land', 'rattle', 'lock', 'judge', 'check', 'grade', 'button', 'clap', 'resp', 'shout']
rows = []
for e in EV:
    if e['type'] not in KEY: continue
    o = onset(e['t']); rows.append((e['type'], e['t'], (o - e['t']) * 1000))
by = {}
for ty, t, d in rows: by.setdefault(ty, []).append(d)
print('[实测·音频] 起音点 − 事件时刻（ms；2 ms 分辨率；喊声辅音按设计提前 25–35 ms）')
for ty, ds in by.items(): print(f'   {ty:7s} n={len(ds):2d}  中位 {np.median(ds):+6.1f}  最大绝对 {np.max(np.abs(ds)):5.1f}')
# 3b) 实测：画面（成片）
film = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'video.mp4')
if os.path.exists(film):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', film, '-vf', 'scale=192:108,format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, 108, 192).astype(np.float32); diff = np.r_[0, np.abs(np.diff(fr, axis=0)).mean((1, 2))]
    print(f'[实测·画面] {len(fr)} 帧；每个事件：变化开始帧 − 事件帧')
    vis = {}
    for e in EV:
        f = int(round(e['t'] * FPS))
        if f <= 0 or f >= len(fr) - 2: continue
        win = diff[f - 2:f + 3]; first = f - 2 + int(np.argmax(win > max(0.6, diff[f - 3:f - 1].mean() * 1.8))) if (win > max(0.6, diff[f - 3:f - 1].mean() * 1.8)).any() else None
        vis.setdefault(e['type'], []).append(None if first is None else first - f)
    for ty, ds in vis.items():
        ok = [d for d in ds if d is not None]
        print(f'   {ty:8s} n={len(ds):2d}  帧偏差 {sorted(set(ok))}  未检出 {ds.count(None)}')
    for c in TL['CUTS']:
        f = int(round(c * FPS)); w = diff[f - 3:f + 4]; print(f'   硬切 {c:5.2f}s：最大变化在第 {f - 3 + int(np.argmax(w))} 帧（应为 {f}）')
print('结果:', 'OK' if bad == 0 else f'{bad} 处问题')
sys.exit(1 if bad else 0)
