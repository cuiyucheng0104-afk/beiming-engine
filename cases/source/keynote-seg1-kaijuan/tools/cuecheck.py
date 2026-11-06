"""对拍自检：画面事件出现的那一帧 vs 成片音轨里的起音点。
用法：python tools/cuecheck.py <成片.mp4 或 mix.wav>  （事件表读工程里的 events.json）
起音点 = 事件附近 ±60 ms 内，高频 2 ms 短时能量（dB）的陡升峰（超过最大陡升一半的峰里离事件最近的一个）。容差 ±33 ms（一帧）。
同时检查：片头 0–2.0 s 是否真静默（< −60 dBFS）。"""
import sys, os, json, subprocess, tempfile
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'mix.wav')
if not src.endswith('.wav'):
    tmp = tempfile.mktemp(suffix='.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ac', '2', '-ar', '48000', tmp], check=True); src = tmp
x, sr = sf.read(src); x = x.mean(1) if x.ndim > 1 else x
E = json.load(open(os.path.join(HERE, 'events.json')))
FPS = 30
from scipy.signal import butter, sosfilt
xh = sosfilt(butter(4, 1200, 'high', fs=sr, output='sos'), x)      # 只看高频瞬态，避开滚奏、锣、低鼓的慢起音
win = int(.002 * sr)
e2 = np.convolve(xh * xh, np.ones(win) / win, 'same')
db = 10 * np.log10(e2 + 1e-12)
names = {'seal0': '朱印「内容资源概念发布」', 'land': '立轴落定', 'flick': '甩笔', 'seal': '印', 'num': '点数字', 'drop': '墨滴落纸', 'gong': '锣'}
rows, bad = [], 0
vis = [e for e in E['ev'] if e.get('visual')] + [dict(e, frame=round(e['t'] * FPS)) for e in E['ev'] if e['type'] in ('drop',)]
for e in sorted(vis, key=lambda e: e['t']):
    tv = e['frame'] / FPS
    a, b = int((e['t'] - .06) * sr), int((e['t'] + .06) * sr)
    seg = db[a:b]; d = np.diff(seg)
    sm = np.convolve(d, np.ones(24), 'same')
    pk = [i for i in range(1, len(sm) - 1) if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > .5 * sm.max()]
    k = min(pk, key=lambda i: abs(a + i - e['t'] * sr)) if pk else int(np.argmax(sm))   # 多个陡升时取离事件最近的一个
    onset = (a + k) / sr
    dt = (onset - tv) * 1000
    ok = abs(dt) <= 33.4
    bad += not ok
    lab = names.get(e['type'], e['type']) + (f" {e['idx'] + 1}" if 'idx' in e else '')
    rows.append(f"{lab:<22} 画面 {tv:7.3f}s(帧{e['frame']:4d})  起音 {onset:7.3f}s  偏差 {dt:+6.1f} ms  {'OK' if ok else '超差'}")
print('\n'.join(rows))
devs = [float(r.split('偏差')[1].split('ms')[0]) for r in rows]
print(f'共 {len(rows)} 个画面事件，超差 {bad} 个；|偏差| 平均 {np.mean(np.abs(devs)):.1f} ms，最大 {np.max(np.abs(devs)):.1f} ms')
sil = x[: int(2.0 * sr)]
pk = 20 * np.log10(np.abs(sil).max() + 1e-12)
print(f'片头 0–2.0 s 峰值 {pk:.1f} dBFS（要求 < −60）', 'OK' if pk < -60 else '不合格')
sys.exit(1 if bad or pk >= -60 else 0)
