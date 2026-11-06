"""拍点核对：视觉事件（out/visual_cues.json，探针二分得到的连续时间起点）与声音落点（out/audio_cues.json）对照 timeline 拍点网格。
用法：python tools/cuecheck.py <film>    —— 任何一项偏差 > 0.5 ms 退出码 1"""
import json, sys, os
D = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = json.load(open(os.path.join(D, 'events.json')))['ev']
beats = sorted(e['t'] for e in ev if e['type'] == 'beat')
grid = sorted(set([round(b, 5) for b in beats] + [round(b + .3125, 5) for b in beats[:20]] + [round(b + .15625 * k, 5) for b in beats[16:20] for k in (1, 3)]
                  + [12.825, 13.525]))
def near(t): g = min(grid, key=lambda x: abs(x - t)); return g, (t - g) * 1000
bad = 0
print('== 视觉事件（连续时间起点 vs 预定拍点 / 最近网格点）==')
for v in json.load(open(os.path.join(D, 'out/visual_cues.json'))):
    if v['got'] is None: print(f"  {v['name']:18s} 未找到起点 ✗"); bad += 1; continue
    g, dg = near(v['got']); ok = abs(v['dev_ms']) <= .5 and abs(dg) <= .5; bad += not ok
    print(f"  {v['name']:18s} 预定 {v['expect']:7.4f}s  实测 {v['got']:9.5f}s  偏差 {v['dev_ms']:+7.2f} ms  距网格 {dg:+6.2f} ms {'✓' if ok else '✗'}")
print('== 声音落点 vs 拍点网格 ==')
mx = 0; n = 0
for c in json.load(open(os.path.join(D, 'out/audio_cues.json'))):
    g, dg = near(c['t']); n += 1; mx = max(mx, abs(dg))
    if abs(dg) > .5: print(f"  ✗ {c['tag']} {c['t']} 距网格 {dg:+.2f} ms"); bad += 1
print(f"  {n} 个声音落点，最大偏差 {mx:.3f} ms")
print('结论：', '全部 0 ms（≤0.5 ms）' if not bad else f'{bad} 项超差')
sys.exit(1 if bad else 0)
