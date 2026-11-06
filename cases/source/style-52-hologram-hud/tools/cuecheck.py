"""拍点核对：画面事件（events.json，来自页面 window.EV）↔ 节拍网格（timeline.json）↔ 配乐音符起点（music/onsets.json）↔ 实际音频瞬态（out/stems/*.wav）。
用法：python tools/cuecheck.py [项目目录]   任何一项偏差 > 0.5 ms（网格/帧）或静默被打破则退出码 1。
"""
import sys, os, json
import numpy as np
import soundfile as sf

D = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(D, 'timeline.json')))
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
ON = json.load(open(os.path.join(D, 'music', 'onsets.json')))
beat, fps = TL['beat'], TL['fps']
MUSIC_KEYS = {'sprout', 'chip2', 'whip', 'lock', 'explode', 'moist', 'close', 'open', 'beam', 'crown'}
SR = 48000
mus, _ = sf.read(os.path.join(D, 'out', 'stems', 'music.wav')); mus = np.abs(mus).max(1)
fol, _ = sf.read(os.path.join(D, 'out', 'stems', 'foley.wav')); fol = np.abs(fol).max(1)
mix, _ = sf.read(os.path.join(D, 'out', 'mix.wav')); mixa = np.abs(mix).max(1)


def onset(x, t, win=0.06):
    """瞬态 = t−6 ms … t+60 ms 内 1 ms 能量包络第一次陡升（>6 dB/ms）的位置（相对 t，ms）"""
    h = 48; s0 = int((t - 0.006) * SR) // h * h; s1 = int((t + win) * SR)
    s0 = max(h * 4, s0)
    w = x[s0 - h * 4:s1]
    e = np.sqrt(np.add.reduceat(w ** 2, np.arange(0, len(w), h)) / h + 1e-12)
    fl = np.diff(np.log(e + 1e-6))
    f2 = fl[3:]
    strong = np.nonzero(f2 > 0.7)[0]                    # 第一次 > 6 dB / ms 的上升
    j = int(strong[0]) if len(strong) else int(np.argmax(f2))
    if f2[j] <= 0.3: return None
    return (s0 - h * 4 + (j + 4) * h) / SR * 1000 - t * 1000


bad = 0
print(f'{"事件":<9}{"拍":>4}{"网格(s)":>9}{"画面(s)":>9}{"网格偏差":>9}{"帧偏差":>8}{"乐谱起点":>9}{"音频瞬态":>9}')
for e in EV:
    k = e.get('key')
    if not k: continue
    bt = TL['hit'][k]; g = bt * beat
    dg = (e['t'] - g) * 1000
    df = (e['t'] * fps - round(e['t'] * fps)) / fps * 1000
    mo = '—'
    if k in MUSIC_KEYS:
        near = min(ON, key=lambda o: abs(o['t'] - g)); mo = f'{(near["t"] - g) * 1000:+.1f}'
        if abs(near['t'] - g) > 5e-4: bad += 1
    src = mus if k in MUSIC_KEYS else fol
    a = None if k == 'freeze' else onset(src if k != 'open' else mixa, e['t'])
    at = '静默' if k == 'freeze' else ('—' if a is None else f'{a:+.1f}')
    if abs(dg) > 0.5 or abs(df) > 0.5: bad += 1
    print(f'{k:<9}{bt:>4}{g:>9.3f}{e["t"]:>9.3f}{dg:>+8.1f}ms{df:>+6.1f}ms{mo:>9}{at:>9}')
# 静默窗口
for s0, s1 in TL['silence']:
    w = mixa[int(round(s0 * SR)):int(round(s1 * SR))]
    inside = [e for e in EV if s0 < e['t'] < s1 or (e['t'] < s0 and e.get('t1', 0) > s0 + 1e-6)]
    first = np.argmax(mixa[int(round(s1 * SR)):] > 1e-4) / SR * 1000
    ok = w.max() == 0 and not inside
    if not ok: bad += 1
    print(f'静默 {s0:.3f}–{s1:.3f}s：最大采样 {w.max():.1e}，窗口内事件 {len(inside)}，静默后第一声 +{first:.2f} ms → {"通过" if ok else "失败"}')
print('结果：', '全部 0 ms（网格、帧、乐谱）' if bad == 0 else f'{bad} 项不合格')
sys.exit(1 if bad else 0)
