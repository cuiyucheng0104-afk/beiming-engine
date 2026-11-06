"""对拍自检：画面事件出现的那一帧 vs 音频起音点。
用法：python tools/cuecheck.py [成片.mp4 或 wav ...]   默认同时查拟音分轨（精确）与成片（混音后）。
起音点 = 事件附近 ±60 ms 内，1.2 kHz 以上 2 ms 短时能量的陡升峰中离事件最近的一个。容差 ±33 ms（一帧）。"""
import sys, os, json, subprocess, tempfile
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS = 30
E = json.load(open(os.path.join(HERE, 'events.json')))
vis = sorted([e for e in E['ev'] if e.get('visual')], key=lambda e: e['t'])
NAMES = {'lamp': '灯管启辉', 'slide': '幻灯片入槽', 'tap': '铅笔点', 'n477': '477 落定', 'clu': '入簇+和弦', 'merge': '并组', 'outline': '画轮廓', 'sleeve': '底片套入槽'}
def load(src):
    if not src.endswith('.wav'):
        tmp = tempfile.mktemp(suffix='.wav'); subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ac', '2', '-ar', '48000', tmp], check=True); src = tmp
    x, sr = sf.read(src); return (x.mean(1) if x.ndim > 1 else x), sr
def check(src, label):
    x, sr = load(src)
    xh = sosfilt(butter(4, 1200, 'high', fs=sr, output='sos'), x)
    win = int(.002 * sr); db = 10 * np.log10(np.convolve(xh * xh, np.ones(win) / win, 'same') + 1e-12)
    rows, devs, bad = [], [], 0
    for e in vis:
        tv = e['frame'] / FPS
        a, b = max(0, int((e['t'] - .06) * sr)), int((e['t'] + .06) * sr)
        sm = np.convolve(np.diff(db[a:b]), np.ones(24), 'same')
        pk = [i for i in range(1, len(sm) - 1) if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > .5 * sm.max()]
        k = min(pk, key=lambda i: abs(a + i - e['t'] * sr)) if pk else int(np.argmax(sm))
        dt = ((a + k) / sr - tv) * 1000; ok = abs(dt) <= 33.4; bad += not ok; devs.append(dt)
        lab = NAMES.get(e['type'], e['type']) + (f" {e.get('k', e.get('i', 0)) + 1}" if e['type'] in ('lamp', 'tap', 'outline', 'sleeve') else '')
        rows.append(f"  {lab:<12} 画面帧 {e['frame']:4d} ({tv:6.3f}s)  起音 {(a + k) / sr:7.3f}s  偏差 {dt:+6.1f} ms  {'OK' if ok else '超差'}")
    print(f'【{label}】'); print('\n'.join(rows))
    d = np.abs(devs); print(f'  共 {len(rows)} 个画面事件，超差 {bad} 个；|偏差| 平均 {d.mean():.1f} ms，最大 {d.max():.1f} ms')
    return bad
srcs = sys.argv[1:] or [os.path.join(HERE, 'out', 'stems', 'foley_taps.wav'), os.path.join(HERE, 'B-kaitou.mp4')]
bad = 0
for s in srcs: bad += check(s, os.path.basename(s))
sys.exit(1 if bad else 0)
