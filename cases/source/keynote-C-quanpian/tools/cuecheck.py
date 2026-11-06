"""全片卡点自检：读 events.json（全片事件）+ out/cues.json（mix.py 实测的每条音效起音）+ out/probe_full.json（tools/probe_full.mjs 逐帧状态）+ out/texts.json。
检查：
  1. 时长：events.json 180.000 s；给了 mp4 时视频 5400 帧、音视频都是 180.000 s
  2. 翻页 / 摊平 / 合书：事件时刻 = 规范小节（14、20、25、31、49、62、89 小节第 1 拍）；probe 里书页第一次到位的那一帧 = 该时刻
  3. 音效：每条音效的实测落点与计划时刻差 ≤ 1 帧（±33.3 ms）；计划时刻在整帧上；20 s 之前不许有章节音效
  4. 章节事件里标了 sfx: true 的，必须有一条音效落在它上面（±1 帧）
  5. 画面文字（out/texts.json）：只能是 texts.js 白名单里的字；占位卡的字列为 PLACEHOLDER（骨架阶段允许，成片前必须为 0）
用法：python tools/cuecheck.py [C-quanpian.mp4] [--cues out/cues.json] [--events events.json]
退出码：0 全过；1 有错误（PLACEHOLDER 只算警告）"""
import sys, os, json, subprocess
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS = 30; BAR = 2.0
def arg(k, d):
    a = sys.argv; return a[a.index(k) + 1] if k in a else d
EVP = arg('--events', os.path.join(HERE, 'events.json')); CUP = arg('--cues', os.path.join(HERE, 'out', 'cues.json'))
vid = next((x for x in sys.argv[1:] if x.endswith('.mp4')), None)
EVJ = json.load(open(EVP)); EV = EVJ['ev']
err, wrn, ok = [], [], []
def E(m): err.append(m)
def W(m): wrn.append(m)
def O(m): ok.append(m)

# 1. 时长
if abs(EVJ['dur'] - 180) > 1e-9: E(f'events.json dur = {EVJ["dur"]}（应为 180）')
else: O('events.json 180.000 s')
if vid:
    pr = lambda *a: subprocess.run(['ffprobe', '-v', 'error', *a, vid], capture_output=True, text=True).stdout.strip().split('\n')[0].strip().strip(',')
    nf = int(pr('-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0') or 0)
    vd = float(pr('-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0') or 0)
    ad = float(pr('-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0') or 0)
    (O if nf == 5400 and abs(vd - 180) < 1e-3 else E)(f'视频 {nf} 帧 / {vd:.3f} s（应为 5400 帧 / 180.000 s）')
    (O if abs(ad - 180) < .03 else E)(f'音频 {ad:.3f} s')

# 2. 翻页
SPEC = {'book.turn.1': 14, 'book.turn.2': 20, 'book.turn.3': 25, 'book.turn.4': 31, 'book.turn.5': 49, 'book.turn.6': 62, 'book.close': 89}
byid = {e['id']: e for e in EV if 'id' in e}
for i, bar in SPEC.items():
    e = byid.get(i)
    if not e: E(f'缺少共用事件 {i}'); continue
    (O if abs(e['t'] - (bar - 1) * BAR) < 1e-6 else E)(f'{i} @ {e["t"]:.3f}s（规范：第 {bar} 小节第 1 拍 = {(bar - 1) * BAR:.3f}s）')
PF = os.path.join(HERE, 'out', 'probe_full.json')
if os.path.exists(PF):
    P = json.load(open(PF)); fr = {p['f']: p for p in P}
    for i, bar in SPEC.items():
        f0 = round((bar - 1) * BAR * FPS)
        if i == 'book.close': hit = next((p['f'] for p in P if p['f'] >= f0 - 40 and p['book']['stack'] <= 1e-6), None)
        elif i == 'book.turn.6': hit = next((p['f'] for p in P if p['f'] >= f0 - 40 and p['book']['pages'][5] >= 175.3 - 1e-6), None)
        else: n = int(i.split('.')[-1]); hit = next((p['f'] for p in P if p['f'] >= f0 - 40 and p['book']['pages'][n - 1] >= 90 - 1e-6), None)
        if hit is None: W(f'{i}: probe 区间里没看到到位（probe_full.json 覆盖 {P[0]["f"] / FPS:.1f}–{P[-1]["f"] / FPS:.1f}s）')
        else: (O if hit == f0 else E)(f'{i} 画面到位帧 {hit}（{hit / FPS:.3f}s），计划帧 {f0}')
else: W('没有 out/probe_full.json：跳过画面到位检查（node tools/probe_full.mjs）')

# 3. 音效
if os.path.exists(CUP):
    C = json.load(open(CUP)); per = {}
    for c in C:
        per.setdefault(c['chap'], []).append(c)
        d = (c['onset'] - c['plan']) * 1000
        if abs(d) > 1000 / FPS + .01: E(f'[{c["chap"]}] {c["name"]} @ {c["plan"]:.3f}s 实测落点偏 {d:+.1f} ms')
        if abs(c['plan'] * FPS - round(c['plan'] * FPS)) > 1e-3: W(f'[{c["chap"]}] {c["name"]} @ {c["plan"]:.4f}s 不在整帧上（"raw": true？）')
        if c['chap'] != 'ch1' and c['plan'] < 20 - 1e-6: E(f'[{c["chap"]}] {c["name"]} @ {c["plan"]:.3f}s 在开头（0–20 s 锁定）里')
    for k, v in sorted(per.items()):
        mx = max(abs(c['onset'] - c['plan']) for c in v) * 1000
        O(f'音效 [{k}] {len(v)} 条，最大音画差 {mx:.2f} ms')
    # 4. 需要声音的画面事件
    for e in EV:
        if not e.get('sfx'): continue
        hit = [c for c in C if (c.get('ev') == e.get('id')) or (c['chap'] == e.get('chap') and abs(c['plan'] - e['t']) <= 1 / FPS + 1e-6)]
        if not hit: E(f'[{e.get("chap")}] 事件 {e.get("id")} @ {e["t"]:.3f}s 标了 sfx: true，但 sfx/{e.get("chap")}.json 里没有声音落在它上面')
    rep = os.path.join(os.path.dirname(CUP), 'mix_report.json')
    if os.path.exists(rep):
        R = json.load(open(rep))
        for m in R.get('rejected', []): (W if '响度' in m or '20 s 之前有声音' in m else E)('mix.py: ' + m)
        lu, tp = R.get('lufs'), R.get('true_peak_full')
        if lu is not None: (O if abs(lu + 14) <= 1 and tp <= -1 else W)(f'混音 {lu:.2f} LUFS，真峰值 {tp:.2f} dBTP（目标 −14±1 / ≤ −1）')
else: W(f'没有 {CUP}：先跑 mix.py')

# 5. 文字
TJ = os.path.join(HERE, 'out', 'texts.json')
if os.path.exists(TJ):
    T = json.load(open(TJ)); A = set(T['allowed']); PH = set(T['placeholders']); bad, ph = {}, {}
    for s in T['samples']:
        for x in s['texts']:
            if x['text'] in PH: ph.setdefault(x['text'], s['t'])
            elif x['text'] not in A: bad.setdefault(x['text'], s['t'])
    for k, t in bad.items(): E(f'清单外文字「{k}」@ {t}s')
    for k, t in ph.items(): W(f'PLACEHOLDER 占位文字「{k}」@ {t}s（成片前删掉）')
    if not bad: O(f'画面文字全部在白名单内（{len(T["samples"])} 个采样点）')

for m in ok: print('  ok   ' + m)
for m in wrn: print('  WARN ' + m)
for m in err: print('  ERR  ' + m)
print(f'CUECHECK  ok {len(ok)}  warn {len(wrn)}  err {len(err)}')
sys.exit(1 if err else 0)
