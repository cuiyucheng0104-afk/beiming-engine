"""拍点核对：画面事件（events.json，来自页面 window.EV）↔ 拍点网格 ↔ 混音里实际放下的声音（out/cues.json）↔ 解码后的音频。
用法：$LIB/.venv/bin/python tools/cuecheck.py   退出码 0 = 全部 0 ms（容差 0.5 ms）"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
CU = json.load(open(os.path.join(HERE, 'out', 'cues.json')))
FPS, B = TL['FPS'], 60 / TL['BPM']
bad = 0; rows = []

def name(e):
    ty = e['type']
    if ty in ('birth', 'bolt'): return f"{ty}{e['n']}"
    if ty in ('tick', 'label'): return f"{ty}{e['i']}"
    if ty == 'tooth': return f"tooth{e['level']}.{e['k']}"
    if ty == 'scale': return f"scale{e['level']}"
    if ty == 'write': return f"write@{e['b']}"
    return ty

cues = {}
for c in CU['cues']: cues.setdefault(c['ev'], c['t'])
silent_types = {'silence'}                                         # 静默本身没有声音
worst_grid = worst_frame = worst_audio = 0.0
for e in EV:
    t = e['t']
    grid = abs(e['b'] * B - t) * 1000                                # 事件是否在拍点网格上（1/32 音符 = 2 帧）
    sub32 = abs(e['b'] * 8 - round(e['b'] * 8)) < 1e-9
    frame = abs(t * FPS - round(t * FPS)) / FPS * 1000              # 事件是否落在整帧上
    nm = name(e)
    if e['type'] in silent_types: au = 0.0; src = '(静默)'
    elif nm in cues: au = abs(cues[nm] - t) * 1000; src = nm
    else: au = None; src = '缺声音'
    worst_grid, worst_frame = max(worst_grid, grid), max(worst_frame, frame)
    if au is not None: worst_audio = max(worst_audio, au)
    ok = grid < .5 and frame < .5 and sub32 and au is not None and au < .5
    bad += not ok
    rows.append(f"{'OK ' if ok else 'BAD'} 拍 {e['b']:>7.3f}  t={t:7.3f}s  帧 {t * FPS:6.1f}  {e['type']:<8} 网格Δ {grid:.3f} ms  帧Δ {frame:.3f} ms  声音Δ {'—' if au is None else f'{au:.3f} ms'}  {src}")

# 解码后的音频：静默段必须是数字零；静默后第一个非零样本必须正好在拍 20
x, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav'))
s0, s1 = CU['silence']; i0, i1 = int(round(s0 * sr)), int(round(s1 * sr))
zero = float(np.abs(x[i0:i1]).max())
nz = np.flatnonzero(np.abs(x[i1 - 10:]).max(1) > 0)
first = (i1 - 10 + nz[0]) if len(nz) else None
tap_ms = abs(first / sr - s1) * 1000 if first is not None else 999
# 关键音符的实际起音（能量包络在 ±5 ms 内跃升）
def onset_ms(t):
    i = int(round(t * sr)); w = int(.002 * sr)
    pre = np.sqrt((x[i - 4 * w:i - w] ** 2).mean() + 1e-20); post = np.sqrt((x[i:i + 2 * w] ** 2).mean() + 1e-20)
    return 20 * np.log10(post / pre)
keys = [e for e in EV if e['type'] in ('birth', 'tap', 'scale', 'last')]
print('\n'.join(rows))
print('--- 解码音频 ---')
print(f'静默段 [{s0:.4f}, {s1:.4f}) 最大幅度 = {zero:.1e}（必须为 0）')
print(f'静默后第一个非零样本 @ {first / sr:.6f}s，与拍 20 偏差 {tap_ms:.3f} ms')
for e in keys: print(f'  起音跃升 {name(e):<8} t={e["t"]:.3f}s  +{onset_ms(e["t"]):.1f} dB')
bad += zero != 0 or tap_ms > .5
print(f'--- 汇总：{len(EV)} 个画面事件，最大网格偏差 {worst_grid:.3f} ms，最大整帧偏差 {worst_frame:.3f} ms，最大声画偏差 {worst_audio:.3f} ms；不合格 {bad} ---')
sys.exit(1 if bad else 0)
