# 拍点核对：画面实测事件（film.js 逐帧求值真实状态得到的 vhit）↔ 拍网格 ↔ 声音里实际放下的拟音/音符起点。
# 用法：python cuecheck.py（读 events.json 与 out/cues_audio.json）；全部偏差 ≤ 1 ms 时退出码 0。
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(os.path.join(HERE, 'events.json')))
A = json.load(open(os.path.join(HERE, 'out', 'cues_audio.json')))
G = next(e for e in E['ev'] if e['type'] == 'grid'); BF, FPS = G['bf'], G['fps']
def BFr(b):                       # 可带小数的拍 → 帧（与 timeline.js 相同；拉长的拍按比例细分）
    n = len(BF) - 1
    if b >= n: return BF[n] + (b - n) * 16
    i = int(b); return BF[i] + (b - i) * (BF[i + 1] - BF[i])
music = [t for t, _ in A['music_onsets']]
sfx = {}
for name, t in A['sfx_cues']: sfx.setdefault(name, []).append(t)
WANT = {'layer:centre': ['tsq', 'pen'], 'layer:circles': ['compass'], 'layer:wheel': ['pen'], 'layer:w3': ['pen'], 'layer:anchor': ['pen'], 'layer:bobHatch': ['hatch'],
        'dim:wheel': ['pen'], 'dim:span': ['pen'], 'dim:L': ['pen'], 'dim:bob': ['pen'], 'balloon': ['dot'], 'ghost:go': ['whoosh'], 'symbol': ['pen'], 'fig2:label': ['flipland'], 'fig2:land': ['slap'], 'tick': ['tick'], 'sign': ['sign'], 'stamp': ['stamp']}
rows, bad = [], 0
for v in [e for e in E['ev'] if e['type'] == 'vhit']:
    name, tv, beat = v['name'], v['t'], v['beat']
    if beat is None or beat < 0: rows.append((name, beat, None, tv, None, '不在拍上')); bad += 1; continue
    tb = round(BFr(beat)) / FPS
    if name == 'cut':
        cand = music + sfx.get('tick', [])
    else:
        cand = [t for k in WANT[name] for t in sfx.get(k, [])]
    ta = min(cand, key=lambda x: abs(x - tv)) if cand else None
    dva, dvb = ((tv - ta) * 1000 if ta is not None else None), (tv - tb) * 1000
    if ta is None or abs(dva) > 1 or abs(dvb) > 1: bad += 1
    rows.append((name, beat, tb, tv, ta, dva, dvb))
print(f"{'事件':<16}{'拍':>4}{'网格s':>9}{'画面s':>9}{'声音s':>9}{'画面-声音ms':>12}{'画面-拍ms':>10}")
for r in rows:
    if r[2] is None: print(f"{r[0]:<16}{str(r[1]):>4}{'':>9}{r[3]:>9.3f}   {r[5]}"); continue
    if r[4] is None: print(f"{r[0]:<16}{r[1]:>4}{r[2]:>9.3f}{r[3]:>9.3f}   缺声音"); continue
    print(f"{r[0]:<16}{r[1]:>4}{r[2]:>9.3f}{r[3]:>9.3f}{r[4]:>9.3f}{r[5]:>12.1f}{r[6]:>10.1f}")
ok = [r for r in rows if r[2] is not None and r[4] is not None]
mx = max(max(abs(r[5]), abs(r[6])) for r in ok) if ok else 0
print(f"\n{len(rows)} 个画面事件，最大偏差 {mx:.1f} ms，超差 {bad} 个；静默段电平 {A['silence_rms_db']:.1f} dB（全片 {A['body_rms_db']:.1f} dB）")
sys.exit(1 if bad else 0)
