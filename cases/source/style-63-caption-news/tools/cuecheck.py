"""拍点核对：画面事件（events.json，由 events.mjs 从 window.EV 导出）对照配乐实际下锤时间（out/cues.json，由 audio/mix.py 写出）
与 120 BPM 网格。每个画面事件先取整到 30 fps 的帧，再和它应对齐的音乐 cue 比较；输出逐项偏差（毫秒），任何偏差 > 0.5 ms 即退出 1。"""
import json, os, sys
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = json.load(open(os.path.join(D, 'events.json')))['ev']; cues = json.load(open(os.path.join(D, 'out', 'cues.json')))
FPS, BEAT = 30, .5
ct = sorted(c['t'] for c in cues)
# 应卡在配乐下锤点上的画面事件
MUST = {'cut', 'hook', 'punch', 'pop', 'paper', 'stamp', 'answer', 'shutter', 'inset'}
rows, bad = [], 0
for e in ev:
    t = e['t']; fr = round(t * FPS); tf = fr / FPS
    on_frame = abs(t - tf) * 1000
    grid = abs(tf / BEAT - round(tf / BEAT)) * BEAT * 1000   # 离半拍网格多远
    near = min(ct, key=lambda c: abs(c - tf)); dmu = (tf - near) * 1000
    need = e['type'] in MUST and not (e['type'] == 'pop' and e['t'] not in (4.6, 8.5))
    if e['type'] == 'cut' and t == 0: need = False          # 第一帧不是剪切
    if e['type'] == 'shutter': dmu = (tf - 11.0) * 1000      # 定格 = 音乐硬停点
    flag = (need and abs(dmu) > .5) or on_frame > .5
    bad += flag
    rows.append(f"{t:7.3f}s  帧{fr:4d}  {e['type']:9s} {e.get('k',''):7s} 取整偏差{on_frame:5.2f}ms  离半拍网格{grid:6.1f}ms  " + (f"对音乐cue {near:.3f}s 偏差 {dmu:+.1f}ms" if need else "（拟音，与画面同帧）") + ("  <-- 不对齐" if flag else ""))
print('\n'.join(rows))
mx = max([abs((round(e['t'] * FPS) / FPS) - min(ct, key=lambda c: abs(c - round(e['t'] * FPS) / FPS))) * 1000 for e in ev if e['type'] in MUST and e['t'] > 0 and e['type'] != 'shutter'] + [0])
print(f"\n需对齐的画面事件最大偏差：{mx:.2f} ms；不对齐 {bad} 项")
sys.exit(1 if bad else 0)
