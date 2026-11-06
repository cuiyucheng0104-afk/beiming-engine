"""拍点核对：画面关键事件（events.json 里带 vis 标签的）↔ 配乐关键音（music/score.json）↔ 实际音频起音（out/mix.wav）。
1) 每个画面事件是否落在整帧上、落在节拍网格（1/2 拍或三连音 1/3 拍）上；
2) 与对应配乐音的时间差（目标 0 ms）；
3) 在混音里实测起音（短时能量突增）与事件时间的差。
用法（在 LIB 下）：.venv/bin/python <film>/tools/cuecheck.py   退出码 0 = 全部 ≤ 容差
"""
import os, sys, json
import numpy as np, soundfile as sf
FILM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = json.load(open(os.path.join(FILM, 'events.json')))['ev']
sc = json.load(open(os.path.join(FILM, 'music/score.json')))
FPS, BPM = 24, sc['bpm']; BEAT = 60 / BPM
cues = {}
for t, lab in sc['cues']: cues.setdefault(lab, t)
PAIR = {'flare': 'flare', 'beam': 'beam', 'cut_macro': 'cut_macro', 'focusLand': 'pluck', 'cut_caustic': 'ring0',
        'cut_lensA': 'cut_lensA', 'cut_lensB': 'cut_lensB', 'cut_stop': 'stop_tone', 'snap': 'snap', 'title': 'title', 'sub': 'sub', 'last': 'last'}
PAIR.update({f'ray{k}': f'ray{k}' for k in range(7)}); PAIR.update({f'ring{k}': f'ring{k}' for k in range(4)})
x, sr = sf.read(os.path.join(FILM, 'out/mix.wav')); mono = np.abs(x).mean(1)
hop = int(.001 * sr); e = np.sqrt(np.convolve(mono ** 2, np.ones(hop) / hop, 'same'))

def onset(t):
    """事件附近 ±60 ms 内能量突增最大的位置（与前 20 ms 平均比）"""
    i0, i1 = int((t - .06) * sr), int((t + .06) * sr); best, bi = 0, None
    for i in range(max(i0, int(.02 * sr)), min(i1, len(e)), hop // 2):
        r = e[i] / (e[i - int(.02 * sr):i].mean() + 1e-5)
        if r > best: best, bi = r, i
    return (bi / sr if bi is not None else None), best

worst = 0; rows = []
for v in ev:
    lab = v.get('vis')
    if not lab: continue
    t = v.get('mid', v['t']); fr = abs(t * FPS - round(t * FPS)) / FPS * 1000
    g = min(abs(t / BEAT * 2 - round(t / BEAT * 2)) * BEAT / 2, abs(t / BEAT * 3 - round(t / BEAT * 3)) * BEAT / 3) * 1000
    m = PAIR.get(lab); dm = (abs(cues[m] - t) * 1000) if m in cues else None
    on, r = onset(t) if m in cues else (None, 0)
    do = (on - t) * 1000 if on is not None and r > 3 else None
    worst = max(worst, fr, g, dm or 0)
    rows.append((t, lab, fr, g, m or '-', dm, do, r))
print(f'{"秒":>8}  {"画面事件":<12} {"整帧偏差":>8} {"网格偏差":>8}  {"配乐音":<10} {"配乐偏差":>8} {"实测起音":>8}')
for t, lab, fr, g, m, dm, do, r in rows:
    print(f'{t:8.3f}  {lab:<12} {fr:7.1f}ms {g:7.1f}ms  {m:<10} {("%.1fms" % dm) if dm is not None else "   -":>8} {("%+.0fms" % do) if do is not None else "   -":>8}')
# 静默核对：14.375–15.0 内除反向嘶声外应近零；15.0 的合盖应是全片峰值附近
s0, s1 = sc['silence']; seg = x[int(s0 * sr) + 50:int((s1 - .01) * sr)]
print(f'静默区 {s0}–{s1}s 峰值 {np.abs(seg).max():.3f}（只有反向嘶声）；合盖后 0.1s 峰值 {np.abs(x[int(s1 * sr):int((s1 + .1) * sr)]).max():.3f}，全片峰值 {np.abs(x).max():.3f}')
print(f'最大偏差（整帧/网格/配乐）{worst:.2f} ms')
sys.exit(0 if worst < 1 else 1)
