"""拍点核对：每个画面事件（events.json，来自页面 window.EV）必须
1) 落在整帧上（t × fps 为整数）；2) 落在它声明的拍点上（t = 拍 × 14 帧 / 30）；
3) 关键动作在乐谱（out/score.json）里有一个音符同时起音。输出每项偏差（毫秒），超过 0.5 ms 退出码 1。"""
import json, sys, os
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = json.load(open(os.path.join(HERE, 'out', 'score.json')))['notes']
tp = next(e for e in E if e['type'] == 'tempo'); FPS, FPB = tp['fps'], tp['fpb']
onsets = sorted(set(round(n[0], 6) for n in SC))
KEY = ['title', 'press', 'break', 'land', 'bang', 'notif', 'jump', 'stomp', 'shutter', 'gulp', 'spit', 'slotland', 'check', 'end', 'step']   # 回收站的吱呀属于静默段，只核对帧与拍
bad = 0; rows = []
for e in E:
    if e['type'] in ('tempo',) or e['type'].startswith('cue_'): continue
    t, b = e['t'], e['b']
    frame_err = abs(t * FPS - round(t * FPS)) / FPS * 1000
    grid_err = abs(t - round(b * FPB) / FPS) * 1000
    note_err = min(abs(o - t) for o in onsets) * 1000
    need = e['type'] in KEY
    ok = frame_err < .5 and grid_err < .5 and (not need or note_err < .5)
    bad += not ok
    rows.append((t, b, e['type'], frame_err, grid_err, note_err if need else None, ok))
print(f"{'时间s':>7} {'拍':>5} {'事件':<10} {'帧偏差ms':>8} {'拍点偏差ms':>9} {'对音符ms':>8}")
for t, b, ty, fe, ge, ne, ok in rows:
    print(f"{t:7.3f} {b:5.1f} {ty:<10} {fe:8.2f} {ge:9.2f} {'' if ne is None else f'{ne:8.2f}':>8} {'' if ok else '  ← 不合格'}")
keys = [r for r in rows if r[5] is not None]
print(f"共 {len(rows)} 个画面事件，{len(keys)} 个关键动作对音符；最大偏差 {max(r[5] for r in keys):.2f} ms；不合格 {bad}")
sys.exit(1 if bad else 0)
