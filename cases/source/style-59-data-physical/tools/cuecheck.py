"""拍点核对：画面事件（events.json，来自页面 window.EV）↔ 节拍网格（timeline.json）↔ 配乐事件（out/cues_audio.json，mix.py 写出）。
每个关键视觉事件必须落在八分音符网格上，且与同名音乐事件 0 ms 偏差；另报告每个事件最近的视频帧带来的量化误差（24 fps 下 ≤ 20.8 ms）。
用法：python -I tools/cuecheck.py <工程目录>"""
import json, sys, os
d = sys.argv[1] if len(sys.argv) > 1 else '.'
TL = json.load(open(os.path.join(d, 'out/timeline.json')))
EV = json.load(open(os.path.join(d, 'events.json')))['ev']
AU = {k: v for k, v in json.load(open(os.path.join(d, 'out/cues_audio.json')))}
BEAT = TL['BEAT']; grid = BEAT / 2; fps = 24
rows, bad = [], 0
for e in EV:
    c = e.get('cue')
    if not c: continue
    t = e['t']; g = round(t / grid) * grid; dg = (t - g) * 1000
    da = (t - AU[c]) * 1000 if c in AU else None
    fq = (round(t * fps) / fps - t) * 1000
    ok = abs(dg) < .5 and (da is None or abs(da) < .5)
    bad += not ok
    rows.append((t, c, t / BEAT, dg, da, fq, ok))
print(f"{'时间s':>7} {'事件':<10} {'拍':>6} {'对网格ms':>8} {'对音乐ms':>8} {'帧量化ms':>8}")
for t, c, bt, dg, da, fq, ok in rows:
    print(f"{t:7.3f} {c:<10} {bt:6.2f} {dg:8.2f} {('—' if da is None else f'{da:.2f}'):>8} {fq:8.1f} {'' if ok else '  ✗'}")
# 单位段每颗珠：落在八分音符上
for e in EV:
    if e['type'] == 'bead' and e['mode'] in ('unit', 'last'):
        dg = (e['t'] - round(e['t'] / grid) * grid) * 1000
        if abs(dg) >= .5: bad += 1; print('✗ bead', e)
print(f"关键事件 {len(rows)} 个，偏差 >0.5 ms 的 {bad} 个；最大对网格偏差 {max(abs(r[3]) for r in rows):.2f} ms，"
      f"最大对音乐偏差 {max(abs(r[4]) for r in rows if r[4] is not None):.2f} ms")
sys.exit(1 if bad else 0)
