"""Visual events (as scheduled by the engine, read back from events.json) vs. the music cues actually placed in the score
(out/score.json, written by mix.py). Prints the offset of every pair in ms, whether the visual lands on a whole frame and on
the 16th grid, and whether keywords land on a strong beat (beat 1 or 3). Exit 1 if any offset is > 0.5 ms."""
import json, os, sys
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev = json.load(open(os.path.join(H, 'events.json')))['ev']; sc = json.load(open(os.path.join(H, 'out/score.json')))
tle = next(e for e in ev if e['type'] == 'timeline'); TL, LAND = tle['TL'], tle['LAND']; FPS, S16 = TL['FPS'], TL['S16']
vis = []                                                  # (name, visual time, score tag, keyword?)
for k in ['天', '蓝(题)', '白光', '空气分子', '蓝光', '波长短', '最容易被', '散射']: vis.append((k + ' 落定', LAND[k], k, True))
for k in ['？', '太阳', '白光箭头', '红箭头', '圈蓝']: vis.append((k + ' 落定', LAND[k], k, False))
for i, e in enumerate([e for e in ev if e['type'] == 'wave']): vis.append((f'第{i+1}条波 起笔', e['t'], f'wave{i}', False))
for i, e in enumerate([e for e in ev if e['type'] == 'dot']): vis.append((f'分子点{i+1} 落笔', e['t'], f'dot{i}', False))
for i, t in enumerate(LAND['蓝弹']): vis.append((f'蓝箭头撞分子{i+1}', t, f'bounce{i}', False))
for i, e in enumerate([e for e in ev if e['type'] == 'spray']): vis.append((f'蓝喷射{i+1} 起笔', e['t'], f'spray{i}', False))
vis.append(('红箭头 起笔', next(e['t'] for e in ev if e['type'] == 'stroke' and e['pen'] == 'R' and e['t'] > 9), '红箭头起', False))
vis.append(('板擦倒带 开始', next(e['t'] for e in ev if e['type'] == 'erase'), 'rewind', False))
for i, e in enumerate(sorted([e for e in ev if e['type'] == 'unwrite' and e['kind'] == 'bounce'], key=lambda e: -e['t'])[:7]): vis.append((f'倒带:蓝弹{i+1}开始退回', e['t'], f'rw_bounce{i}', False))
for i, e in enumerate(sorted([e for e in ev if e['type'] == 'unwrite' and e['kind'] == 'spray'], key=lambda e: -e['t'])): vis.append((f'倒带:喷射{i+1}退回完', e['t'] + e['dur'], f'rw_spray{i}', False))
vis.append(('全板视图 落定', LAND['全板'], '全板', False))
m = next(e['t'] for e in ev if e['type'] == 'magnet')
vis.append(('磁贴 拍上(音乐)', m, '磁贴', True)); vis.append(('磁贴 拍上(拟音)', m, '磁贴拟音', True))
bad = 0; worst = 0
print(f"{'事件':<16}{'画面 s':>9}{'音乐 s':>9}{'偏差 ms':>9}  帧对齐 16分网格 强拍")
for name, t, tag, kw in sorted(vis, key=lambda v: v[1]):
    cand = [s['t'] for s in sc if s['tag'] == tag]
    if not cand: print(f'{name:<16}{t:9.3f}   (乐谱中无 {tag})'); bad += 1; continue
    mt = min(cand, key=lambda x: abs(x - t)); d = (mt - t) * 1000; worst = max(worst, abs(d))
    fr = abs(t * FPS - round(t * FPS)) < 1e-6; g16 = abs(t / S16 - round(t / S16)) < 1e-6; strong = abs(t - round(t)) < 1e-6
    sub = name.startswith('倒带')                 # rewind runs at 2×: its 32nd-note points fall between frames (continuous motion, sampled)
    if abs(d) > .5 or (not fr and not sub): bad += 1
    print(f"{name:<16}{t:9.3f}{mt:9.3f}{d:9.2f}  {'✓' if fr else ('½' if sub else '✗'):>4} {'✓' if g16 else '✗':>6} {('✓' if strong else '✗') if kw else '-':>4}")
print(f'共 {len(vis)} 个卡点，最大偏差 {worst:.2f} ms，问题 {bad} 个')
sys.exit(1 if bad else 0)
