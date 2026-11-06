"""拍点核对：画面事件（events.json，来自 main.js）↔ 音乐网格与配乐音符起点（out/music_onsets.json，来自 mix.py）↔ 成品音轨（out/mix.wav）。
用法：python -I tools/cuecheck.py <工程目录>     偏差 > 1 ms 退出码 1。
检查四件事：
 1. 每个关键画面事件都落在整数帧上（60 fps）；
 2. 每个关键画面事件都落在 16 分音符网格上（BPM 120 → 125 ms）；
 3. 指定的"画面—音乐"配对：画面事件与它要卡的那个音乐音符起点之差；
 4. 静默之后第一声：在 mix.wav 里实测起音时刻 ↔ 巨型冰淇淋弹出那一帧。
"""
import sys, os, json
import numpy as np
import soundfile as sf
D = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(D, 'events.json')))['ev']
ON = json.load(open(os.path.join(D, 'out', 'music_onsets.json')))
G = next(e for e in E if e['type'] == 'grid'); BEAT, FPS = G['beat'], G['fps']
CUE = {e['name']: e['beat'] for e in E if e['type'] == 'cue'}
hits = [e for e in E if e.get('hit')]
worst = 0.0; rows = []
for e in hits:
    t = e['t']; f = t * FPS; df = abs(f - round(f)) / FPS * 1000
    g = BEAT / 4; dg = abs(t / g - round(t / g)) * g * 1000
    worst = max(worst, df, dg); rows.append((t, e['type'], df, dg))
print(f'关键画面事件 {len(rows)} 个：帧偏差最大 {max(r[2] for r in rows):.3f} ms，16 分网格偏差最大 {max(r[3] for r in rows):.3f} ms')

def onset(prefix, t):
    c = [o['t'] for o in ON if o['what'].startswith(prefix)]
    return min(c, key=lambda x: abs(x - t)) if c else None
PAIRS = [   # (画面事件, 拍号, 要卡的音乐音符)
    ('车刹停点头 = 乐队进', 'truckStop', 'brass_downbeat'), ('车刹停点头 = 车身蹲-弹', 'truckStop', 'sq_big'), ('第二次回弹', 'bounce2', 'sq_big'),
    ('车喇叭', 'horn', 'horn'), ('第二圈波浪', 'wave2', 'kick'),
    ('侧板外移（第一步）', 'lidOut', 'bass'), ('①奶油 callout', 'cream', 'glock_cream'), ('②甜筒 callout', 'cone', 'glock_cone'),
    ('③撒糖 callout', 'sprinkle', 'glock_sprinkle'), ('成品转向', 'finished', 'glock_finished'),
    ('侧板合上 = 全曲停', 'lidIn', 'stop_stab'), ('巨型冰淇淋弹出', 'pop', 'POP_brass'), ('弹出 = 竖琴刮奏', 'pop', 'POP_harp'),
    ('第一次回弹', 'bounce1', 'brass'), ('"今日限定"弹出', 'callout', 'glock_today'), ('收束和弦 / 画框收回', 'close', 'brass_cad'),
]
print('\n画面事件                         拍号    时刻(s)  音乐音符           偏差(ms)')
for name, k, pre in PAIRS:
    t = CUE[k] * BEAT; o = onset(pre, t)
    d = (o - t) * 1000 if o is not None else float('nan')
    worst = max(worst, abs(d) if o is not None else 1e9)
    print(f'{name:<28} b{CUE[k]:<6} {t:7.3f}  {pre:<18} {d:+8.3f}')
# 道具蹲-弹：每个道具事件都应有同一时刻的琶音音符
sq = [e['t'] for e in E if e['type'] == 'sq']
arp = {round(o['t'], 4) for o in ON if o['what'] == 'sq_arp'}
miss = [t for t in sq if round(t, 4) not in arp and t not in (CUE['truckStop'] * BEAT, CUE['bounce1'] * BEAT, CUE['bounce2'] * BEAT)]
print(f'\n道具蹲-弹 {len(sq)} 次，全部有同时刻的调音琶音：{"是" if not miss else "否，缺 " + str(miss[:5])}')
# 静默 → 第一声（在成品音轨上实测）
x, sr = sf.read(os.path.join(D, 'out', 'mix.wav')); a = np.abs(x).max(1)
T = CUE['pop'] * BEAT; s0, s1 = int((CUE['musicStop'] * BEAT + .5) * sr), int(T * sr)
pre_db = 20 * np.log10(np.sqrt((x[s0:s1] ** 2).mean()) + 1e-12)
last_db = 20 * np.log10(np.sqrt((x[int((T - .25) * sr):s1] ** 2).mean()) + 1e-12)
thr = 10 * a[s1 - int(.25 * sr):s1].max()
i = np.argmax(a[int((T - .3) * sr):] > max(thr, .05)); t_on = T - .3 + i / sr
d = (t_on - T) * 1000; worst = max(worst, abs(d))
print(f'静默段 {CUE["musicStop"] * BEAT + .5:.2f}–{T:.2f}s 均方根 {pre_db:.1f} dBFS，弹出前最后 0.25 s {last_db:.1f} dBFS')
print(f'静默后第一声实测起音 {t_on:.4f}s，弹出帧 {T:.4f}s，偏差 {d:+.2f} ms')
print(f'\n最大偏差 {worst:.3f} ms →', '通过' if worst <= 1.0 else '不通过')
sys.exit(0 if worst <= 1.0 else 1)
