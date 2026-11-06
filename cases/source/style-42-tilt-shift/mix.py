"""港口一日 · 原创配乐 + 拟音 + 混音 → out/mix.wav（48 kHz 立体声），out/stems/*.wav，out/audio_cues.json，CREDITS 乐器行
运行：$LIB/.venv/bin/python mix.py        （先跑 events.mjs 生成 events.json）

配乐（Reich 语法的调音打击乐，全部采样 + numpy 合成）：
  A 0–6.667   144 BPM，十六分音符 = 5/48 s。马林巴 I 的 12 音句（= 3 拍 = 岸桥一个循环）→ 马林巴 II 同句相位漂移 → 低音 →
              钟琴（由真实落箱事件门控骨架音）+ 木鱼（由锁销事件门控）→ 单簧管/颤音琴八分脉动和弦
  B 6.667–7.3 磁带刹停：整段音乐变速下坠、声部逐个掉光；真实世界声进入
  S 8.333–9.167 近静默：只留两下水声
  C 9.167–14.167 汽笛（全片最重要的声音）→ 72 BPM：弓奏颤音琴长音 + 马林巴八分 → 十六分 → 三十二分（加速）
  D 14.167–19.75 夜：每盏灯一个音，招牌一个和弦，马林巴夜版回到相位句，终止和弦
所有时间从 events.json（timeline.js 导出）取，拍点核对见 tools/cuecheck.py。
"""
import sys, os, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio import pluck as P
from core.audio.sfx import SR, add, limit, bp, lp, hp, noise, env_exp, t_, norm, brown

E = json.load(open(os.path.join(HERE, 'events.json')))
DUR = E['dur']; EV = E['ev']
N = int(round(DUR * SR))
G = {n: t for n, t in EV[0]['grid']}            # 拍点名 → 秒
VH = {e['name']: e['t'] for e in EV if e['type'] == 'vhit'}
def ev(ty): return sorted(e['t'] for e in EV if e['type'] == ty and e.get('t') is not None)
def evs(ty): return [e for e in EV if e['type'] == ty and e.get('t') is not None]

BEAT_A = 10 / 24; SIX = BEAT_A / 4; BEAT_C = 20 / 24
CUT3, REAL, STOP, HORN, RISE, CUT4 = G['A16'], G['A17'], G['A20'], G['C0'], G['C1'], G['C6']
FINAL = G['C12']
S.seed(20261101)
rng = np.random.default_rng(42)
tt = np.arange(N) / SR
def seg(t, a, b): return np.clip((t - a) / (b - a), 0, 1)

NN = N + 6 * SR    # 余量，最后裁掉
stems = {k: np.zeros((NN, 2), np.float32) for k in ['mar1', 'mar2', 'bass', 'glock', 'pulse', 'pad', 'perc', 'horn', 'sfx', 'amb']}
used = set(); CUES = []
_cache = {}
def note(inst, p, dur, vel, release=None, attack=0.0):
    k = (inst, p, round(dur, 3), round(vel, 3), release, attack)
    if k not in _cache: _cache[k] = S.note(inst, p, dur, vel, release=release, attack=attack)
    used.add(inst); return _cache[k]
def put(stem, inst, p, t, dur=.5, vel=.7, pan=0., gain=1., release=None, attack=0., cue=None):
    if t < -1e-9 or t > DUR + 2: return
    add(stems[stem], note(inst, p, dur, vel, release, attack), t, gain, pan)
    if cue: CUES.append({'name': cue, 't': t, 'src': inst})
def hitp(stem, inst, var, t, vel=.7, gain=1., pan=0., cue=None):
    x = S.hit(inst, var, vel); used.add(inst); add(stems[stem], x, t, gain, pan)
    if cue: CUES.append({'name': cue, 't': t, 'src': inst})
def sfx(x, t, gain=1., pan=0., cue=None, stem='sfx'):
    add(stems[stem], x.astype(np.float32), t, gain, pan)
    if cue: CUES.append({'name': cue, 't': t, 'src': 'sfx'})

# ———————————————————————— 主题与和声 ————————————————————————
# 马林巴相位句：12 个十六分 = 3 拍 = 岸桥一个循环（三台吊车轮流落箱）。D 大调五声 + 一个 G
PH = ['D5', 'A4', 'F#5', 'E5', 'A4', 'D5', 'B4', 'E5', 'F#5', 'A4', 'E5', 'G5']
ACC = {0: .74, 4: .66, 8: .68}           # 拍头重音
# 和声（每小节）：A 段 D – D – Bm – G；B 段刹停在 A；C 段 D Bm G Em A；D 段 D Bm G A D
CH = {'D': ('D2', ['D4', 'F#4', 'A4', 'E5']), 'Bm': ('B1', ['D4', 'F#4', 'B4', 'C#5']), 'G': ('G1', ['D4', 'G4', 'B4', 'A4']),
      'Em': ('E2', ['E4', 'G4', 'B4', 'D5']), 'A': ('A1', ['C#4', 'E4', 'A4', 'B4']), 'Asus': ('A1', ['D4', 'E4', 'A4', 'B4'])}
SKEL_G = ['D6', 'A5', 'F#6', 'E6', 'B5', 'A5', 'D6', 'F#6', 'E6', 'A6', 'F#6', 'D6']   # 钟琴骨架（落箱门控）

def section_A(stem_override=None, t_end=None, bars=range(0, 5)):
    """A 段音乐（可多写一小节给磁带刹停用）。stem_override: dict 把音写到别的缓冲"""
    global stems
    keep = stems
    if stem_override is not None: stems = stem_override
    try:
        prog = ['D', 'D', 'Bm', 'G', 'A', 'A']
        for bar in bars:
            b0 = bar * 4 * BEAT_A
            # 马林巴 I：从第 1 小节起，十六分音符
            for i in range(16):
                t = b0 + i * SIX; k = (bar * 16 + i) % 12
                if t_end is not None and t >= t_end: break
                v = ACC.get(k, .5) * (.86 if bar == 0 and i % 4 else 1)
                put('mar1', 'marimba', PH[k], t, .3, v, -.32, 1.0, cue=('mar1:A%d' % (bar * 4 + i // 4)) if i % 4 == 0 else None)
            # 马林巴 II：第 2 小节进入，同一句，每个十六分比 I 快 3.125%（三小节漂移 1.5 个十六分：相位）
            if bar >= 1:
                for i in range(16):
                    n = (bar - 1) * 16 + i; t = 4 * BEAT_A + n * SIX * (1 - .03125)
                    if t_end is not None and t >= t_end: break
                    k = n % 12
                    put('mar2', 'marimba', S.name(S.midi(PH[k]) + (12 if k in (1, 4, 9) else 0)), t, .3, .46 + .12 * (k in ACC), .38, .8)
            # 低音：第 2 小节起，拍 1、拍 3（+ 拍 4 的八分弱起）
            if bar >= 1:
                root = CH[prog[bar]][0]
                for bt in (0, 2):
                    t = b0 + bt * BEAT_A
                    if t_end is not None and t >= t_end: continue
                    put('bass', 'contrabass_pizz', root, t, .6, .78, 0, 1.0, cue='bass:A%d' % (bar * 4 + bt))
                    put('bass', 'marimba', S.name(S.midi(root) + 12), t, .5, .7, 0, .7)
                t = b0 + 3.5 * BEAT_A
                if t_end is None or t < t_end: put('bass', 'contrabass_pizz', S.name(S.midi(root) + 7), t, .3, .55, 0, .7)
            # 第 4 小节起：单簧管 + 颤音琴八分脉动和弦（Reich 的"呼吸"：每小节渐强渐弱）
            if bar >= 3:
                tones = CH[prog[bar]][1]
                for e8 in range(8):
                    t = b0 + e8 * BEAT_A / 2
                    if t_end is not None and t >= t_end: break
                    sw = .45 + .4 * np.sin(np.pi * (e8 + .5) / 8)
                    for j, q in enumerate(tones[:3]):
                        put('pulse', 'clarinet_stac', q, t, .18, .42 * sw, -.25 + .25 * j, .55)
                    put('pulse', 'vibraphone_hard', tones[3], t, .2, .38 * sw, .2, .5)
            elif bar == 2:   # 第 3 小节：单颤音琴轻轻预示
                tones = CH[prog[bar]][1]
                for e8 in (1, 3, 5, 7):
                    t = b0 + e8 * BEAT_A / 2
                    put('pulse', 'vibraphone', tones[3], t, .3, .32, .25, .5)
    finally:
        stems = keep

# ———————————————————————— A 段 ————————————————————————
section_A(bars=range(0, 4))
# 钟琴：第 3 小节（剪到顶俯）起，每个真实落箱事件弹骨架的下一个音
lands = evs('land'); gi = 0
for e in lands:
    t = e['t']
    if 3.333 - 1e-6 <= t < CUT3 - 1e-6:
        put('glock', 'glockenspiel', SKEL_G[gi % 12], t, 1.0, .5 + .1 * (gi % 3 == 0), .15 * ((gi % 3) - 1), .9, cue='glock:land')
        gi += 1
# 木鱼：锁销事件（八分反拍）门控，第 3–4 小节
for e in evs('pick'):
    if 3.333 - 1e-6 <= e['t'] < CUT3 - 1e-6:
        hitp('perc', 'woodblock', ['a', 'b', 'c'][e['crane']], e['t'], .55, .45, -.4 + .4 * e['crane'])
# 焦带滑向港口入口（第 4 小节第 3 拍）：钟琴上行四音
for j, q in enumerate(['A5', 'D6', 'E6', 'A6']):
    put('glock', 'glockenspiel', q, VH['pointer'] + j * SIX, .8, .55 + .05 * j, .3, .8, cue='pointer' if j == 0 else None)
put('glock', 'vibraphone', 'A5', VH['pointer'], 1.2, .45, .3, .6)

# ———————————————————————— B 段：磁带刹停 ————————————————————————
tape = {k: np.zeros((NN, 2), np.float32) for k in stems}
section_A(stem_override=tape, bars=range(4, 6))      # 把第 5、6 小节写出来，再变速
for j, q in enumerate(['D6', 'A5', 'F#6', 'E6']): add(tape['glock'], note('glockenspiel', q, .8, .5), CUT3 + j * BEAT_A, .8, .1)
TS0, TS1 = CUT3, CUT3 + .62
def tape_stop(x, t0, t1):
    a, b = int(t0 * SR), int(t1 * SR); n = b - a; u = np.arange(n) / n
    rate = 1 - .82 * u ** 1.25
    pos = a + np.cumsum(rate); out = np.zeros_like(x)
    for c in range(2): out[a:b, c] = np.interp(pos, np.arange(len(x)), x[:, c])
    out[a:b] *= ((1 - u) ** 1.6)[:, None]; return out
for k, drop in [('mar1', 1.0), ('mar2', .5), ('bass', .9), ('pulse', .4), ('glock', .3)]:
    y = tape_stop(tape[k], TS0, TS1)
    a, b = int(TS0 * SR), int(TS1 * SR); u = np.arange(b - a) / (b - a)
    y[a:b] *= np.clip((drop - u) / drop * 1.8, 0, 1)[:, None]
    stems[k] += y
CUES.append({'name': 'tapestop', 't': TS0, 'src': 'tape'})

# ———————————————————————— C 段：汽笛 → 72 BPM，加速 ————————————————————————
# 汽笛（合成）：三音蒸汽汽笛 D3 F#3 A3，带起音上滑、气流噪声、码头建筑回声；加真实圆号/大号/巴松托底
def ship_horn(d=1.85):
    t = t_(d); out = np.zeros_like(t)
    env = np.minimum(1, t / .025) * np.minimum(1, (d - t) / .35) ** 1.2
    scoop = 1 - .035 * np.exp(-t / .09)                     # 起音 60 ms 内略低再到位
    for f, a in ((146.83, 1.0), (185.0, .78), (220.0, .62)):
        vib = 1 + .0025 * np.sin(2 * np.pi * 5.3 * t + f)
        ph = np.cumsum(2 * np.pi * f * scoop * vib / SR)
        saw = sum(np.sin(k * ph) / k ** 1.05 for k in range(1, 22))
        out += a * saw
    out = bp(out, 110, 3200, 2) * .8 + bp(out, 500, 900, 2) * .9 + bp(out, 1300, 1900, 2) * .35   # 管体共振峰
    air = bp(noise(d), 900, 5000) * .1 * (.4 + .6 * env) + bp(noise(d), 600, 4000) * np.exp(-t / .03) * .5   # 起音时阀门的一口气
    x = norm(np.tanh((out + air) * 1.4)) * env
    return x
hrn = ship_horn()
sfx(lp(hrn, 3500), HORN, .24, .12, cue='horn', stem='horn')   # 全片最响的一声（返修：+3 dB）
for dl, g, pn in ((.31, .11, -.5), (.57, .06, .55), (.93, .028, -.2)):      # 仓库与防波堤的回声
    sfx(lp(hrn, 2200), HORN + dl, g, pn, stem='horn')
sfx(lp(noise(.5), 120) * env_exp(.5, .12) * 2.5, HORN, .25, 0, stem='horn')       # 胸腔里的低频冲击
for j, (inst, q, v, pn) in enumerate([('horn', 'D3', .8, -.3), ('horn', 'F#3', .72, -.1), ('horn', 'A3', .7, .1), ('tuba', 'D2', .78, 0), ('bassoon', 'A2', .6, .25)]):
    put('pad', inst, q, HORN + .015, 1.9, v, pn, .58, release=.6, cue='horn:brass' if j == 0 else None)
hitp('perc', 'timpani', 'drum2', HORN, .7, .55, 0)
put('bass', 'contrabass_pizz', 'D2', HORN, 1.0, .9, 0, 1.0)
# 72 BPM：弓奏颤音琴长音和弦，每小节换（3 拍一小节）
progC = [('D', 0, 2), ('Bm', 2, 3), ('G', 3, 4), ('Em', 4, 5), ('Asus', 5, 5.5), ('A', 5.5, 6)]
for ch, b0, b1 in progC:
    t0 = HORN + b0 * BEAT_C; d = (b1 - b0) * BEAT_C
    root, tones = CH[ch]
    for j, q in enumerate(tones[:3]): put('pad', 'vibraphone_bowed', q, t0, d + .2, .5, -.35 + .35 * j, .5, release=.5, attack=.15)
    if b0 >= 1: put('bass', 'contrabass_pizz', root if ch != 'Asus' else 'A1', t0, .8, .82, 0, .95, cue='bass:C%d' % int(b0))
    if b0 >= 1: put('bass', 'marimba', S.name(S.midi(root) + 12), t0, .6, .7, 0, .6)
# 马林巴重新起步：C1 起八分 → C3 起十六分 → C5 起三十二分（= A 段的十六分：速度回来了）
def chord_at(t):
    for ch, b0, b1 in progC:
        if HORN + b0 * BEAT_C - 1e-6 <= t < HORN + b1 * BEAT_C - 1e-6: return ch
    return 'A'
k = 0
for (a, b, step) in ((RISE, G['C3'], BEAT_C / 2), (G['C3'], G['C5'], BEAT_C / 4), (G['C5'], CUT4, BEAT_C / 8)):
    n = int(round((b - a) / step))
    for i in range(n):
        t = a + i * step; q = PH[k % 12]
        if chord_at(t) in ('Asus', 'A') and q in ('D5', 'G5'): q = {'D5': 'C#5', 'G5': 'E5'}[q]
        if chord_at(t) == 'Em' and q == 'F#5': q = 'G5'
        on_beat = abs(((t - HORN) / BEAT_C) - round((t - HORN) / BEAT_C)) < 1e-6
        put('mar1', 'marimba', q, t, .3, (.66 if on_beat else .5) * (.85 + .15 * seg(t, RISE, CUT4)), -.3, 1.2 + .05 * seg(t, RISE, CUT4), cue=('mar1:C%d' % round((t - HORN) / BEAT_C)) if on_beat else None)
        if t >= G['C3']: put('mar2', 'marimba', S.name(S.midi(q) + 12), t + step * .5 * seg(t, G['C3'], CUT4), .25, .4, .38, .6)   # 第二声部，相位从 0 拉开到半个格
        k += 1
put('glock', 'glockenspiel', 'D6', G['C3'], .8, .62, .2, .85, cue='mar16'); hitp('perc', 'woodblock', 'a', G['C3'], .6, .4, .3)
# 云影：前沿扫过时，颤音琴弓奏 + 吊镲弓擦的一口气
for nm, q in (('cloud1', 'B5'), ('cloud2', 'E6')):
    t = VH[nm]; put('pad', 'vibraphone_bowed', q, t, 1.4, .55, .45, .6, release=.6, attack=.25, cue=nm)
    hitp('perc', 'sus_cymbal', 'bow', t - .25, .45, .25, .3)
# 剪切前的上冲：吊镲渐强滚奏收在 C6
hitp('perc', 'sus_cymbal', 'cresc', CUT4 - 1.9, .5, .2, -.2)

# ———————————————————————— D 段：夜，长曝光 ————————————————————————
put('bass', 'contrabass_pizz', 'D2', CUT4, 1.2, .85, 0, 1.0, cue='bass:C6'); put('bass', 'marimba', 'D3', CUT4, .8, .7, 0, .6)
for j, q in enumerate(['D4', 'A4', 'E5']): put('pad', 'vibraphone_bowed', q, CUT4, 2.6, .42, -.3 + .3 * j, .45, release=.8, attack=.3)
lt = {e['grp']: e['t'] for e in evs('light')}
# 路灯一排亮：钟琴单音
put('glock', 'glockenspiel', 'A6', lt['lamps'], 1.2, .55, -.25, .8, cue='light:lamps'); put('glock', 'vibraphone', 'A5', lt['lamps'], 1.5, .5, -.2, .6)
# 吊臂灯：颤音琴和弦 Bm
for j, q in enumerate(['D5', 'F#5', 'B5']): put('glock', 'vibraphone', q, lt['boom'], 1.6, .5, .1 + .1 * j, .6, cue='light:boom' if j == 0 else None)
put('bass', 'contrabass_pizz', 'B1', lt['boom'], 1, .8, 0, .9)
# 招牌（片名）：最暖的和弦 G(add9)：圆号柔 + 颤音琴 + 马林巴滚奏
ts = ev('sign')[0]
for j, (inst, q, v) in enumerate([('horn', 'G3', .5), ('horn', 'D4', .48), ('horn', 'B3', .45), ('tuba', 'G1', .5)]):
    put('pad', inst, q, ts, 1.7, v, -.3 + .2 * j, .45, release=.6, attack=.06, cue='sign' if j == 0 else None)
for j, q in enumerate(['G4', 'B4', 'D5', 'A5']): put('glock', 'vibraphone', q, ts, 1.8, .52, -.2 + .15 * j, .6)
put('bass', 'contrabass_pizz', 'G1', ts, 1.2, .85, 0, 1.0)
# 窗灯与甲板灯：马林巴夜版相位句回来（八分，再十六分），两声部
for i in range(int(round((FINAL - lt['windows']) / (BEAT_C / 4)))):
    t = lt['windows'] + i * BEAT_C / 4; q = PH[i % 12]
    if t >= lt['lighthouse'] - 1e-6 and q in ('D5', 'G5'): q = {'D5': 'C#5', 'G5': 'E5'}[q]
    put('mar1', 'marimba', q, t, .3, .5 if i % 4 else .62, -.3, .75, cue='mar1:windows' if i == 0 else None)
    if i >= 4: put('mar2', 'kalimba', S.name(S.midi(q) - 12 if S.midi(q) > 73 else S.midi(q)), t + BEAT_C / 8 * seg(t, lt['windows'], FINAL), .4, .45, .4, .55)
put('bass', 'contrabass_pizz', 'E2', lt['windows'], 1, .8, 0, .9); put('glock', 'glockenspiel', 'B6', lt['windows'], 1.0, .5, .3, .7)
# 灯塔：管钟 + A 和弦
put('glock', 'tubular_bells', 'A4', lt['lighthouse'], 3, .6, .35, .7, cue='light:lighthouse')
put('bass', 'contrabass_pizz', 'A1', lt['lighthouse'], 1, .85, 0, 1.0)
for j, q in enumerate(['C#5', 'E5', 'A5']): put('glock', 'vibraphone', q, lt['lighthouse'], 1.2, .45, .1 * j, .5)
# 桅灯 = 终止和弦 D（马林巴 + 颤音琴 + 弓奏颤音琴 + 钟琴顶音 + 管钟 + 低音）
tf = lt['mast']
for j, q in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'E5']): put('mar1', 'marimba', q, tf, 1.5, .62, -.4 + .16 * j, .65, cue='final' if j == 0 else None)
for j, q in enumerate(['F#5', 'A5', 'D6']): put('glock', 'vibraphone', q, tf, 2.5, .55, -.2 + .2 * j, .65)
put('glock', 'glockenspiel', 'F#6', tf, 2.0, .55, .3, .8); put('glock', 'tubular_bells', 'D5', tf, 3, .55, -.3, .6)
for j, q in enumerate(['D4', 'F#4', 'A4']): put('pad', 'vibraphone_bowed', q, tf, 1.5, .45, -.3 + .3 * j, .45, attack=.05)
put('bass', 'contrabass_pizz', 'D2', tf, 1.5, .9, 0, 1.0); put('bass', 'contrabass', 'D2', tf, 1.2, .5, 0, .5)

# ———————————————————————— 拟音（全部由 events.json 驱动） ————————————————————————
def clank(v=1.):   # 40 尺箱落到车架上：锁销咔 + 钢箱体共振 + 闷响
    d = .32; t = t_(d); p = .9 + rng.random() * .2
    modes = sum(a * np.sin(2 * np.pi * f * p * t + rng.random() * 6) * env_exp(d, tau) for f, a, tau in [(410, .7, .09), (760, .55, .06), (1330, .4, .04), (2210, .25, .025)])
    th = np.sin(2 * np.pi * 85 * t * (1 - .25 * t)) * env_exp(d, .05)
    tr = hp(noise(d), 1800) * env_exp(d, .003)
    return norm(modes * .7 + th + tr * .6) * v
def latch(v=1.):   # 锁销
    d = .05; t = t_(d); return norm(hp(noise(d), 3000) * env_exp(d, .002) + np.sin(2 * np.pi * 3100 * t) * env_exp(d, .005) * .6) * v
def airbrake(v=1.):
    d = .22; return norm(bp(noise(d), 2500, 8000) * env_exp(d, .06)) * v
def relay(v=1.):   # 灯具继电器 + 镇流器嗡
    d = .5; t = t_(d)
    k = hp(noise(.03), 2000) * env_exp(.03, .003); x = np.zeros(len(t)); x[:len(k)] += k
    hum = (np.sin(2 * np.pi * 100 * t) + .5 * np.sin(2 * np.pi * 200 * t) + .3 * np.sin(2 * np.pi * 300 * t)) * np.minimum(1, t / .04) * env_exp(d, .25) * .25
    return norm(x + hum) * v
def neon(d, v=1.):   # 灯箱通电：咔哒 + 打火的两三下闪 + 持续镇流器嗡
    t = t_(d); hum = np.sin(2 * np.pi * 120 * t) + .6 * np.sin(2 * np.pi * 240 * t) + .4 * np.sign(np.sin(2 * np.pi * 120 * t)) * .3
    flick = np.ones(len(t)); fr2 = 2 / 24
    flick[int(.0 * SR):int(fr2 * SR)] = .6; flick[int(fr2 * SR):int(2 * fr2 * SR)] = .25
    hum = bp(hum, 90, 2500) * flick * np.minimum(1, (d - t) / .3)
    k = hp(noise(.04), 1500) * env_exp(.04, .004); hum[:len(k)] += k * 3
    return norm(hum) * v
def gull(v=1., far=False):   # 海鸥：下滑的嘶鸣 + 调幅
    out = np.zeros(int(.9 * SR))
    for k, (dl, f0, f1, d) in enumerate([(0, 1900, 1250, .28), (.33, 1750, 1150, .22), (.58, 1650, 1100, .25)]):
        t = t_(d); f = np.linspace(f0, f1, len(t)); ph = np.cumsum(2 * np.pi * f / SR)
        x = (np.sin(ph) + .45 * np.sin(2 * ph) + .25 * np.sin(3 * ph)) * (.6 + .4 * np.sin(2 * np.pi * 38 * t)) * np.sin(np.pi * t / d) ** .7
        x = bp(x, 700, 6000); s = int(dl * SR); out[s:s + len(x)] += x * (1 - .2 * k)
    if far: out = lp(out, 2600)
    return norm(out) * v
def lap(v=1.):   # 水拍船舷
    d = .45; t = t_(d)
    x = lp(noise(d), 900) * env_exp(d, .07) + bp(noise(d), 300, 1400) * env_exp(d, .03) * .6
    x += np.sin(2 * np.pi * 70 * t) * env_exp(d, .06) * .4
    return norm(x * np.minimum(1, t / .015)) * v
def whoosh_low(d=1.6, v=1.):   # 云影掠过：低频气流扫过
    t = t_(d); n = brown(d); x = lp(n, 500) * np.sin(np.pi * t / d) ** 2
    return norm(x) * v

for e in evs('land'):
    r = e.get('rate', 40); v = .42 if e['t'] < CUT3 else .22
    sfx(clank(), e['t'], v, -.5 + .5 * e['crane'], cue='clank' if e['t'] < CUT3 else None)
for e in evs('pick'): sfx(latch(), e['t'], .22 if e['t'] < CUT3 else .12, -.5 + .5 * e['crane'])
for t in ev('trucks'): sfx(airbrake(), t + .02, .07, .45)
CUES.append({'name': 'clank0', 't': 0.0, 'src': 'sfx'}); sfx(clank(), 0.0, .55, -.5)   # 第一帧的落箱（events 扫描从第 2 次跳帧开始）

# 延时"快放"颗粒沙沙声：每次跳帧一个颗粒（A 段 + 升起后半段 + 夜）
grain_src = bp(rng.standard_normal(NN), 700, 6000)
for t in ev('step') + ev('nstep'):
    s = int(t * SR); L = int(.19 * SR)
    if s + L > NN: continue
    w = np.sin(np.pi * np.arange(L) / L) ** 2 * (.7 + .3 * rng.random())
    lvl = .028 if t < CUT3 else (.018 if t < CUT4 else .014)
    stems['amb'][s:s + L, 0] += grain_src[s:s + L] * w * lvl; stems['amb'][s:s + L, 1] += grain_src[s + 1000:s + 1000 + L] * w * lvl
# 远处港区嗡声（A 段，高通）
hum_far = hp(lp(brown(DUR + 1), 600), 90)[:NN] if False else hp(lp(rng.standard_normal(NN), 500), 80)
lvlA = np.interp(np.arange(NN) / SR, [0, .3, CUT3, CUT3 + .4, 7.2, 8.0, CUT4, CUT4 + .4, DUR], [.0, .022, .022, .0, .0, .0, .0, .02, .02])
stems['amb'] += (hum_far * lvlA)[:, None]

# 拖船柴油机：J-cut 6.25 进入；真实速度里怠速；停船时熄到很低；汽笛后加油门离开
def diesel(n):
    t = np.arange(n) / SR
    rate_hz = np.interp(t + ENG0, [ENG0, REAL, STOP - .3, STOP, HORN + .3, HORN + 1.6, CUT4], [11.5, 10.5, 9.5, 7, 7, 15, 17])
    ph = np.cumsum(2 * np.pi * rate_hz / SR)
    pulses = np.maximum(0, np.sin(ph)) ** 6
    body = lp(rng.standard_normal(n), 260) * pulses * 3 + np.sin(ph * 4) * .25 + np.sin(ph * 2) * .35
    return lp(body, 700)
ENG0 = ev('engine')[0]; n = int((CUT4 - ENG0) * SR); eng = norm(diesel(n))
envE = np.interp(np.arange(n) / SR + ENG0, [ENG0, CUT3, REAL, STOP - .1, STOP + .25, HORN - .02, HORN + .25, HORN + 1.2, RISE + 1.5, CUT4 - .5], [0, .05, .16, .16, .0, .0, .07, .1, .04, 0])
sfx(eng * envE, ENG0, 1.0, .25, cue='engineIn')
# 船头破浪（真实速度里）
bow = lp(bp(rng.standard_normal(int(2.2 * SR)), 200, 2500), 3000) * np.interp(np.arange(int(2.2 * SR)) / SR, [0, .4, 1.0, 1.35, 2.2], [0, .6, .45, 0, 0])
sfx(norm(bow) * .09, CUT3 + .3, 1, .2)
# 海水底：真实世界进入（7.0 起），升起时随高度退场
sea = lp(rng.standard_normal(NN), 700) * (.6 + .4 * np.sin(2 * np.pi * .35 * np.arange(NN) / SR) ** 2)
lvlS = np.interp(np.arange(NN) / SR, [0, CUT3 + .2, REAL, STOP, STOP + .2, HORN, RISE, RISE + 2.5, DUR], [0, 0, .05, .05, .0038, .0038, .045, 0, 0])
stems['amb'] += (norm(sea) * lvlS)[:, None]
for t in ev('lap'): sfx(lap(), t, .056, -.2, cue='lap')   # 静默里只剩这两下水声（返修：压低，让汽笛前更空）
for t in (REAL + .32, REAL + .75): sfx(lap(), t, .16, .3)
gl = ev('gull'); sfx(gull(far=True), gl[0], .1, -.6, cue='gull')
sfx(gull(), gl[1], .13, .55, cue='gull2'); sfx(gull(far=True), gl[1] + .45, .08, .7)
# 白汽嘶声
st = hp(noise(2.2), 2000) * np.minimum(1, t_(2.2) / .03) * env_exp(2.2, .5)
sfx(norm(st) * .09, ev('steam')[0], 1, .15)
# 风：随升起的高度变大；L-cut 越过 14.167 剪切延续进夜景
wn = lp(hp(np.cumsum(rng.standard_normal(NN)) * .01, 40), 900); wn = norm(wn)
wl = np.interp(np.arange(NN) / SR, [0, RISE - .2, RISE + 1, CUT4 - .3, CUT4, CUT4 + 1.1, DUR], [0, 0, .04, .2, .2, 0, 0])
wmod = (.75 + .25 * np.sin(2 * np.pi * .6 * np.arange(NN) / SR))
stems['amb'][:, 0] += wn * wl * wmod; stems['amb'][:, 1] += np.roll(wn, 2400) * wl * wmod
CUES.append({'name': 'windLcut', 't': CUT4, 'src': 'amb'})
for nm in ('cloud1', 'cloud2'): sfx(whoosh_low(1.8), VH[nm] - .9, .2, 0)
# 夜：继电器 + 钠灯嗡；招牌通电；远处车流
for e in evs('light'):
    if e['grp'] != 'mast': sfx(relay(), e['t'], .2, .3 if e['grp'] == 'boom' else -.1, cue='relay:' + e['grp'])
sfx(relay(), lt['mast'], .2, .4, cue='relay:mast')
sfx(neon(DUR - ts + .2), ts, .07, .35, cue='neon')
# 光迹每拍变长：一声很轻的"快门拉开"（高频气声上滑），从左扫到右
def shutter(v=1.):
    d = .32; t = t_(d); x = bp(noise(d), 2500, 9000) * np.minimum(1, t / .004) * env_exp(d, .07)
    x += np.sin(2 * np.pi * (1800 + 2400 * t) * t) * env_exp(d, .05) * .25
    return norm(x) * v
for k, t in enumerate(ev('trail')): sfx(shutter(), t, .045, -.4 + .15 * k, cue='trail')
traffic = lp(bp(rng.standard_normal(NN), 120, 1500), 1600)
stems['amb'] += (norm(traffic) * np.interp(np.arange(NN) / SR, [0, CUT4, CUT4 + .6, DUR], [0, 0, .035, .04]))[:, None]

# ———————————————————————— 混音 ————————————————————————
GAIN = {'mar1': .95, 'mar2': .8, 'bass': .9, 'glock': .75, 'pulse': .7, 'pad': .75, 'perc': .75, 'horn': .9, 'sfx': .9, 'amb': 1.0}
SEC = np.interp(np.arange(NN) / SR, [0, RISE - .01, RISE, CUT4 - .01, CUT4, NN / SR], [1, 1, .9, .86, 1.0, 1.0])   # 返修：C 段的渐强不再盖过汽笛
from core.audio.sampler import room
music_keys = ['mar1', 'mar2', 'bass', 'glock', 'pulse', 'pad', 'perc']
music = sum(stems[k] * GAIN[k] for k in music_keys) * SEC[:, None]
music = music + room(music, size=.42, mix=.16) * 1.0
# 静默窗：音乐只允许磁带刹停的余尾；8.333–9.167 全静
gate = np.interp(np.arange(NN) / SR, [0, TS1, TS1 + .05, HORN - .002, HORN, NN / SR], [1, 1, 0, 0, 1, 1])
music *= gate[:, None]
fx = stems['sfx'] * GAIN['sfx'] + stems['horn'] * GAIN['horn']
fx = fx + room(fx, size=.3, mix=.08)
mix = music + fx + stems['amb']
mix = mix[:N]
# 结尾：最后 0.4 s 收尾，避免硬切
mix *= np.interp(tt, [0, DUR - .42, DUR - .02, DUR], [1, 1, 0, 0])[:, None]
for c in range(2): mix[:, c] = limit(mix[:, c], .95)
os.makedirs(os.path.join(HERE, 'out', 'stems'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR)
for k in stems: sf.write(os.path.join(HERE, 'out', 'stems', k + '.wav'), stems[k][:N] * GAIN[k], SR)
json.dump({'cues': sorted(CUES, key=lambda c: c['t'])}, open(os.path.join(HERE, 'out', 'audio_cues.json'), 'w'), ensure_ascii=False, indent=0)

# 段落电平（自查）
mono = mix.mean(1)
def rms(a, b): x = mono[int(a * SR):int(b * SR)]; return 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
for nm, a, b in [('A1', 0, 1.667), ('A2', 1.667, 3.333), ('A3', 3.333, 5), ('A4', 5, CUT3), ('tape', CUT3, TS1), ('real', TS1, STOP), ('silence', STOP, HORN), ('horn', HORN, HORN + 1.5), ('C', RISE, CUT4), ('night', CUT4, DUR)]:
    print(f'{nm:8s} {a:6.2f}-{b:6.2f}  {rms(a, b):6.1f} dBFS')
print('used instruments:', sorted(used))
with open(os.path.join(HERE, 'out', 'instrument_credits.txt'), 'w') as f: c = S.credits(sorted(used)); f.write(c if isinstance(c, str) else '\n'.join(c) + '\n')
