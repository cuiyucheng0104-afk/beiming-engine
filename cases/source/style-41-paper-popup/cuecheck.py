# 拍点核对：视觉事件（events.json，来自 main.js 的 window.EV）↔ 节拍网格 ↔ 帧网格 ↔ 配乐起音（out/score_onsets.json）
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
TL = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', f"import('{HERE}/timeline.js').then(m=>console.log(JSON.stringify({{SECS:m.SECS,T:m.T,CUTS:m.CUTS,HIT:m.HIT,FPS:m.FPS}})))"]))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']; ON = json.load(open(os.path.join(HERE, 'out', 'score_onsets.json')))
FPS = TL['FPS']; SEC = TL['SECS']; music = [o['t'] for o in ON['music']]; sfx = [o['t'] for o in ON['sfx']]
def grid_err(t, divs=(4, 3)):
    s = max((x for x in SEC if x['t'] <= t + 1e-9), key=lambda x: x['t']); bt = (t - s['t']) * s['bpm'] / 60
    return min(abs(bt - round(bt * d) / d) for d in divs) * 60 / s['bpm']        # 十六分或三连音网格
def near(t, L): return min((abs(t - x) for x in L), default=9)
rows, worst = [], {'grid': 0, 'frame': 0, 'sfx': 0, 'music': 0}
for k, (sec, b) in TL['HIT'].items():
    t = TL['T'][k]; g = grid_err(t); f = abs(t * FPS - round(t * FPS)) / FPS; sx = near(t, sfx); m = near(t, music)
    worst['grid'] = max(worst['grid'], g); worst['frame'] = max(worst['frame'], f); worst['sfx'] = max(worst['sfx'], sx)
    if m < .05: worst['music'] = max(worst['music'], m)
    rows.append((t, k, f'{sec}:{b}', g * 1e3, f * 1e3, sx * 1e3, m * 1e3 if m < .05 else None))
for e in EV:
    f = abs(e['t'] * FPS - round(e['t'] * FPS)) / FPS; worst['frame'] = max(worst['frame'], f); worst['grid'] = max(worst['grid'], grid_err(e['t']))
cut = max(grid_err(c, (2,)) for c in TL['CUTS']); cutf = max(abs(c * FPS - round(c * FPS)) / FPS for c in TL['CUTS'])
print(f"{'t':>7} {'事件':<11}{'段:拍':<12}{'网格ms':>7}{'帧ms':>7}{'拟音ms':>8}{'音乐ms':>8}")
for t, k, sb, g, f, sx, m in sorted(rows): print(f"{t:7.3f} {k:<11}{sb:<12}{g:7.1f}{f:7.1f}{sx:8.1f}{'' if m is None else f'{m:8.1f}':>8}")
music_hits = sum(1 for r in rows if r[6] is not None)
print(f"\n视觉关键事件 {len(rows)} 个（其中 {music_hits} 个与配乐起音重合），声音事件 {len(EV)} 个，剪切 {len(TL['CUTS'])} 个")
print(f"最大偏差：节拍网格 {worst['grid']*1e3:.2f} ms · 帧网格 {worst['frame']*1e3:.2f} ms · 视觉↔拟音 {worst['sfx']*1e3:.2f} ms · 视觉↔配乐 {worst['music']*1e3:.2f} ms · 剪切↔半拍 {cut*1e3:.2f} ms / 帧 {cutf*1e3:.2f} ms")
bad = max(worst.values()) > .0005 or cut > .0005 or cutf > .0005
print('结论：', '有偏差' if bad else '全部 0 ms'); sys.exit(1 if bad else 0)
