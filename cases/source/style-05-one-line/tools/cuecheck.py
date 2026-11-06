"""拍点核对：画面事件（events.json 里路径实测的笔尖到达时刻）vs 音乐（out/notes.json 的音符起点）vs 拍点网格（timeline）。
每个事件还要落在整帧上。目标 0 ms。python tools/cuecheck.py；任何偏差 > 0.5 ms 时退出码 1。"""
import json, os, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(HERE, 'events.json')))['ev']
TL = json.load(open(os.path.join(HERE, 'out', 'timeline.json')))
NOTES = json.load(open(os.path.join(HERE, 'out', 'notes.json')))
FPS, HT = TL['FPS'], TL['HT']
note_at = {}
for t, inst, p, hit in NOTES:
    if hit: note_at.setdefault(hit, []).append(t)
rows, worst = [], 0.0
hits = {e['id']: e['t'] for e in E if e['type'] == 'hit' and not e['id'].startswith('seg:')}
seg_starts = {e['id']: (e['t'], e['beat']) for e in E if e['type'] == 'hit' and e['id'].startswith('seg:')}
for k, beat in HT.items():
    vis = hits.get(k)
    if k in ('enter', 'steam', 'wingR', 'c0', 'resume'):      # 段首事件：路径的段起点
        sid = {'enter': 'seg:cup', 'steam': 'seg:steam', 'wingR': 'seg:bird', 'c0': 'seg:city', 'resume': 'seg:face'}[k]
        vis = seg_starts[sid][0]
    mus = note_at.get(k, [None])[0]
    frame = round(beat * FPS) / FPS
    d_vis = (vis - beat) * 1000 if vis is not None else None
    d_mus = (mus - beat) * 1000 if mus is not None else None
    d_frm = (frame - beat) * 1000
    for d in (d_vis, d_mus, d_frm):
        if d is not None: worst = max(worst, abs(d))
    rows.append(f'{k:8s} 拍 {beat:8.4f}s  帧 {round(beat * FPS):4d}  画面 {d_vis:+7.2f} ms  ' + (f'音乐 {d_mus:+7.2f} ms' if d_mus is not None else '音乐   (静默)') + f'  整帧 {d_frm:+6.2f} ms')
print('\n'.join(rows))
missing = [k for k in HT if k not in note_at and k != 'stop']
print(f'事件 {len(HT)} 个；无音符的事件：{missing or "无"}；最大偏差 {worst:.3f} ms')
sys.exit(0 if worst <= 0.5 and not missing else 1)
