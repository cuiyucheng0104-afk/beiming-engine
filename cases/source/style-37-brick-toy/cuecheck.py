# 拍点核对：画面实测事件（main.js 逐帧求值真实状态得到的 vhit）↔ 声音里实际放下的拟音/音符起点
# 用法：python cuecheck.py   （读 events.json 与 out/cues_audio.json）；全部偏差 ≤ 1 ms 时退出码 0
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
A = json.load(open(os.path.join(HERE, 'out', 'cues_audio.json')))
grid = dict((round(b, 3), t) for b, t in next(e for e in E['ev'] if e['type'] == 'grid')['grid'])
music = [t for t, _ in A['music_onsets']]
sfx = {}
for name, t in A['sfx_cues']: sfx.setdefault(name, []).append(t)
steps = sorted(sfx.get('step', []))
rows, bad = [], 0
for v in [e for e in E['ev'] if e['type'] == 'vhit']:
    name, tv, beat = v['name'], v['t'], v['beat']
    tb = grid[round(beat, 3)]
    if name.startswith('step'): ta = steps[int(name[4:]) - 1]
    elif name.startswith('cut:'):   # 剪切点上必须有音乐起音（静默段 b16 的剪切以静默开始为准）
        ta = min(music, key=lambda x: abs(x - tv)) if beat != 16 else A['silence'][0]
    else: ta = min(sfx.get(name, [None]) or [None], key=lambda x: abs(x - tv) if x is not None else 9)
    if ta is None: rows.append((name, beat, tb, tv, None, None)); bad += 1; continue
    d = (tv - ta) * 1000; db = (tv - tb) * 1000
    if abs(d) > 1 or abs(db) > 1: bad += 1
    rows.append((name, beat, tb, tv, ta, d, db))
print(f"{'事件':<16}{'拍':>6}{'网格s':>9}{'画面s':>9}{'声音s':>9}{'画面-声音ms':>12}{'画面-拍ms':>10}")
for r in rows:
    if r[4] is None: print(f"{r[0]:<16}{r[1]:>6}{r[2]:>9.3f}{r[3]:>9.3f}   缺声音"); continue
    print(f"{r[0]:<16}{r[1]:>6}{r[2]:>9.3f}{r[3]:>9.3f}{r[4]:>9.3f}{r[5]:>12.1f}{r[6]:>10.1f}")
mx = max(abs(r[5]) for r in rows if r[4] is not None)
print(f"\n{len(rows)} 个事件，最大偏差 {mx:.1f} ms，超差 {bad} 个")
sys.exit(1 if bad else 0)
