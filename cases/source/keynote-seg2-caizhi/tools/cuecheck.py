"""卡点核对：每个画面事件（timeline.VISCUES）
1) 画面：冻结镜头（?camT=t）渲染 t-3f … t+2f，逐帧差分，找"变化开始的那一帧"，与事件时刻比较；
2) 声音：在对应分轨里找起音点（包络在 1 ms 窗内突增），与事件时刻比较。
目标 0 ms，容差 ±33 ms（1 帧）。用法：python tools/cuecheck.py [--skip-video]
"""
import json, os, subprocess, sys, tempfile
import numpy as np, soundfile as sf
from PIL import Image
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS = 30
cues = TL['VISCUES']

def onset(x, sr, t, win=.06):
    a = max(0, int((t - win) * sr)); c = int((t + win) * sr)
    seg = np.abs(x[a:c]); k = int(.001 * sr)
    env = np.convolve(seg, np.ones(k) / k, 'same')
    pre = np.median(env[:int(.04 * sr)]) + 1e-6
    thr = max(pre * 8, env.max() * .12)
    i = np.argmax(env > thr)
    return (a + i) / sr

mus, sr = sf.read(os.path.join(HERE, 'out', 'stem_music.wav')); mus = mus.mean(1)
fol, _ = sf.read(os.path.join(HERE, 'out', 'stem_foley.wav')); fol = fol.mean(1)
mix, _ = sf.read(os.path.join(HERE, 'out', 'mix.wav')); mix = mix.mean(1)

rows, bad = [], 0
tmp = tempfile.mkdtemp()
for name, c in cues:
    t = c['t']
    # 声音：取两轨里更早出现明显起音的那一个
    oa = min(onset(fol, sr, t), onset(mus, sr, t))
    da = (oa - t) * 1000
    dv = None
    if '--skip-video' not in sys.argv:
        f0 = round(t * FPS)          # 事件所在帧（四分之一拍不在帧上时取最近帧）
        frames = [f0 + k for k in range(-3, 3) if f0 + k >= 0]
        ts = [f'{f / FPS:.6f}' for f in frames]
        out = os.path.join(tmp, f'c{f0}')
        subprocess.run(['node', 'core/render/still.mjs', HERE, *ts, '--q', f'camT={t:.6f}', '--out', out], cwd=LIB, check=True, capture_output=True)
        ims = [np.asarray(Image.open(os.path.join(out, f't_{x}.jpg')).convert('L'), np.float32) for x in ts]
        d = [float(np.mean(np.abs(ims[i + 1] - ims[i]) > 6)) for i in range(len(ims) - 1)]
        # 冲击类事件：差分最大的那一帧（印落、剪合、展开、灯亮……）；"完成"类事件：最后一帧有变化的帧
        if '完成' in name:
            thr = max(d) * .02 + 1e-5
            k = max((i for i, v in enumerate(d) if v > thr), default=None)
        else:
            k = int(np.argmax(d)) if max(d) > 1e-5 else None
        if k is not None:
            dv = (frames[k + 1] / FPS - t) * 1000
    ok = abs(da) <= 33.4 and (dv is None or abs(dv) <= 33.4)
    bad += not ok
    rows.append((name, c['beat'], t, da, dv, ok))
    print(f"{'OK ' if ok else 'BAD'} {name:<10} b{c['beat']:<6} t={t:7.3f}  声音 {da:+6.1f} ms  画面 {('%+6.1f ms' % dv) if dv is not None else '   -   '}", flush=True)
print(f'\n{len(rows)} 个事件，{bad} 个超出 ±33 ms')
sys.exit(1 if bad else 0)
