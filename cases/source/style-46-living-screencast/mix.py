"""《逃跑的周报》配乐 + 拟音 → out/mix.wav（并写 out/score.json 供拍点核对）
两种分辨率：高清层（真实采样：小提琴/中提琴/大提琴拨奏、爵士低音提琴、木块、钟琴、立式钢琴、鼓组、定音鼓）是「世界」；
芯片方波是卡片的声音。时间全部来自 events.json（页面的 window.EV），节拍网格 900/7 BPM，每拍 14 帧。
结构：办公室（8 分音符拨奏 + 木块）→ 拖拽（芯片入场）→ 追逐（加速：16 分 + 鼓组；踩下深色模式后整支乐队低通成夜间版）
→ 冻结（只剩一个弓奏颤音琴长音，近静默①）→ 回收站（静，只有吱呀和闷在里面的芯片声，吐出前半拍全静，近静默②）
→ 吐出（全片最响：定音鼓+镲+全乐队，浅色回来）→ 勾选完成（终止式）。"""
import sys, os, json, numpy as np, soundfile as sf
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio.sfx import SR, bp, lp, hp, add, limit, whoosh, click as sclick, creak, thump, brown, norm
from core.audio import sampler as S
SPIT_BOOST = float(os.environ.get('SPIT_BOOST', 4))

HERE = os.path.dirname(os.path.abspath(__file__))
EVJ = json.load(open(os.path.join(HERE, 'events.json'))); E = EVJ['ev']; DUR = EVJ['dur']
tempo = next(e for e in E if e['type'] == 'tempo'); FPS, FPB = tempo['fps'], tempo['fpb']
def bt(b): return round(b * FPB) / FPS             # 与 timeline.js 完全一致
B = FPB / FPS
rng = np.random.default_rng(46); S.seed(46)
NS = int((DUR + 1.0) * SR)
def tt(d): return np.arange(int(round(d * SR))) / SR
def db(x): return 10 ** (x / 20)
def evs(tp): return [e for e in E if e['type'] == tp]

# ───────── 芯片声部：带限脉冲波
def pulse(f, d, duty=.25, vol=1., att=.002, rel=.03, slide=None, vib=0):
    t = tt(d); fr = np.full(len(t), float(f)) if slide is None else f * (slide ** (t / d))
    if vib: fr = fr * (1 + vib * np.sin(2 * np.pi * 7 * t))
    ph = np.cumsum(fr) / SR; x = np.zeros(len(t))
    for k in range(1, 22):
        m = (fr * k) < 15000
        x += m * (np.sin(np.pi * k * duty) / k) * np.cos(2 * np.pi * k * (ph - duty / 2))
    e = np.minimum(1, t / att) * np.clip((d - t) / rel, 0, 1)
    return (x * e * vol * .5).astype(np.float32)
def crush(x, bits=5): q = 2 ** bits; return (np.round(x * q) / q).astype(np.float32)
def nz(d, lo, hi, vol=1., tau=None):
    x = bp(rng.standard_normal(int(round(d * SR))), lo, hi) * vol
    if tau: x *= np.exp(-tt(d)[:len(x)] / tau)
    return x.astype(np.float32)
hz = S.hz

# ═════════ 乐谱（采样层）
SCORE = []                                   # (t, inst, pitch, dur, vel, pan, gain)
def N(b, inst, p, d, v, pan=0., g=1.): SCORE.append((bt(b) if isinstance(b, (int, float)) else b, inst, p, d, v, pan, g))
CH = {  # 每拍的和弦（低音, 和弦音）
    'F': ('F2', ['F3', 'A3', 'C4', 'F4', 'A4', 'C5', 'F5']), 'Dm7': ('D2', ['D3', 'F3', 'A3', 'C4', 'D4', 'F4', 'A4', 'C5']),
    'Bb': ('Bb1', ['Bb2', 'D3', 'F3', 'Bb3', 'D4', 'F4', 'Bb4', 'D5']), 'Gm7': ('G2', ['G3', 'Bb3', 'D4', 'F4', 'G4', 'Bb4']),
    'C7': ('C2', ['C3', 'E3', 'G3', 'Bb3', 'C4', 'E4', 'G4', 'Bb4', 'C5']), 'Db': ('Db2', ['Db3', 'F3', 'Ab3', 'Db4', 'F4', 'Ab4']),
    'C': ('C2', ['C3', 'E3', 'G3', 'C4', 'E4', 'G4', 'C5']), 'Dm': ('D2', ['D3', 'F3', 'A3', 'D4', 'F4', 'A4', 'D5']),
}
PROG = {0: 'F', 2: 'F', 4: 'Dm7', 6: 'Bb', 8: 'Gm7', 10: 'C7', 12: 'F', 14: 'Db', 15: 'C7', 16: 'Bb', 18: 'C', 20: 'Dm', 22: 'Bb', 23: 'C7',
        32: 'F', 34: 'Dm7', 36: 'Bb', 38: 'C7', 40: 'F'}
def chord(b):
    k = max(x for x in PROG if x <= b + 1e-9); return CH[PROG[k]]
def up(c, i): return c[1][i % len(c[1])]

# 1) 办公室 b0–b8：小提琴拨奏 8 分音符跳音型 + 大提琴拨奏 + 低音提琴 + 木块（反拍）
for i in range(16):
    b = i * .5; c = chord(b); hi = [up(c, 5), up(c, 3), up(c, 4), up(c, 3)][i % 4]
    N(b, 'violins_pizz', hi, .3, .42 + .1 * (i % 2 == 0), .28)
    if i % 2 == 1: N(b, 'woodblock', 'a' if i % 4 == 1 else 'b', None, .26, -.35)
for b in range(0, 8):
    c = chord(b)
    if b % 2 == 0: N(b, 'jazz_bass', c[0], .45, .62, -.05)
    else: N(b, 'cellos_pizz', up(c, 1), .3, .42, -.25); N(b, 'violas_pizz', up(c, 2), .3, .38, .1)
N(4, 'glockenspiel', 'C6', 1.6, .55, .2); N(4, 'glockenspiel', 'F6', 1.6, .38, .25)     # 标题落定
# 2) 拖拽 b8–b16：同样的拨奏，b11 半音上行（发抖），b12 挣脱全奏，b14「!」降 D 和弦，b15 小军鼓加花
for i in range(16, 24):
    b = i * .5; c = chord(b); N(b, 'violins_pizz', [up(c, 5), up(c, 3), up(c, 4), up(c, 3)][i % 4], .3, .45, .28)
    if i % 2 == 1: N(b, 'woodblock', 'a' if i % 4 == 1 else 'b', None, .28, -.35)
for k, p in enumerate(['E4', 'F4', 'F#4', 'G4']): N(11 + k * .25, 'violins_pizz', p, .2, .38 + k * .06, .3)   # 被拽住时往上爬
for b in (8, 9, 10, 11):
    c = chord(b)
    if b % 2 == 0: N(b, 'jazz_bass', c[0], .45, .62, -.05)
    else: N(b, 'cellos_pizz', up(c, 1), .3, .45, -.25)
for inst, ps, pan in [('cellos_pizz', ['F2', 'C3'], -.3), ('violas_pizz', ['A3', 'C4'], .05), ('violins_pizz', ['F4', 'A4', 'F5'], .3)]:
    for p in ps: N(12, inst, p, .4, .78, pan)
N(12, 'jazz_bass', 'F1', .6, .8, 0); N(12, 'drum_kit', 'kick_drum_left', None, .7, 0)
for b in (12.5, 13, 13.5): N(b, 'violins_pizz', up(chord(b), [4, 5, 3][int((b - 12.5) * 2)]), .25, .42, .28)
N(13, 'jazz_bass', 'C2', .4, .55, 0)
for p in ['Db3', 'Ab3', 'F4', 'Db5']: N(14, 'violins_pizz' if p[-1] in '45' else 'cellos_pizz', p, .35, .7, .1)
N(14, 'jazz_bass', 'Db2', .45, .7, 0); N(14, 'glockenspiel', 'Ab6', .6, .4, .3)
N(15, 'jazz_bass', 'C2', .4, .65, 0); N(15, 'cellos_pizz', 'E3', .3, .5, -.2); N(15, 'violas_pizz', 'Bb3', .3, .5, .1)
for k in range(4): N(15 + k * .25, 'drum_kit', 'snare_1', None, .3 + k * .13, .05)
# 3) 追逐 b16–b24：加速。鼓组、16 分音符拨奏琶音、低音提琴走 8 分
for k in range(32):
    b = 16 + k * .25
    N(b, 'drum_kit', 'hi_hat_closed', None, .42 if k % 2 == 0 else .24, .32)
    c = chord(b); N(b, 'violins_pizz', up(c, [3, 4, 5, 4][k % 4] + (k // 8) % 2), .18, .36 + .12 * (k % 4 == 0), .3)
for b in (16, 17.5, 18, 19.5, 20, 21.5, 22): N(b, 'drum_kit', 'kick_drum_left', None, .66, 0)
for b in (17, 19, 21): N(b, 'drum_kit', 'snare_1', None, .6, .05)
for k in range(16):
    b = 16 + k * .5; c = chord(b); bassn = c[0]
    m = S.midi(bassn) + [0, 7, 12, 7][k % 4]; N(b, 'jazz_bass', m, .26, .62, -.05)
    if k % 2 == 1: N(b, 'cellos_pizz', up(c, 1), .2, .42, -.3)
for k in range(8): N(23 + k * .125, 'drum_kit', 'snare_1', None, .25 + k * .07, .05)    # b23 军鼓滚奏推进冻结
N(16, 'drum_kit', 'crash_left', None, .45, -.3)
# 4) 冻结 b24–b28：只剩一个长音垫
N(24, 'vibraphone_bowed', 'A4', bt(28) - bt(24) - .1, .42, -.15)
N(24, 'vibraphone_bowed', 'E5', bt(28) - bt(24) - .1, .3, .2)
# 5) 回收站 b28–b32：静（只有拟音；芯片声在 chip 段落）
N(29, 'contrabass_pizz', 'F1', .5, .55, 0)          # 咕咚：吞下去的低音
# 6) 吐出 b32：全片最响
N(32, 'timpani', 'F2', 1.5, .95, 0); N(32, 'drum_kit', 'crash_right', None, .85, .25); N(32, 'drum_kit', 'kick_drum_left', None, .95, 0)
N(32, 'gran_cassa', 'hit', None, .7, 0)
for inst, ps, pan in [('cellos_pizz', ['F2', 'C3'], -.3), ('violas_pizz', ['A3', 'C4'], .05), ('violins_pizz', ['F4', 'A4', 'C5', 'F5'], .3)]:
    for p in ps: N(32, inst, p, .45, .85, pan)
for p in ['F2', 'C3', 'F3', 'A3', 'C4', 'F4']: N(32, 'upright', p, 1.2, .72, -.1)
N(32, 'jazz_bass', 'F1', .7, .9, 0)
for k, p in enumerate(['C6', 'F6', 'A6', 'C7']): N(32 + k * .125, 'glockenspiel', p, .8, .5, .25)
for i in range(8):
    b = 32.5 + i * .5
    if b >= 36: break
    c = chord(b); N(b, 'violins_pizz', [up(c, 5), up(c, 3), up(c, 4), up(c, 3)][i % 4], .3, .48, .28)
    N(b, 'drum_kit', 'hi_hat_closed', None, .3, .32)
for b in (33, 35): N(b, 'drum_kit', 'snare_1', None, .45, .05)
for b in (33, 34, 35): c = chord(b); N(b, 'jazz_bass', c[0] if b % 2 == 0 else S.midi(c[0]) + 7, .4, .65, 0)
N(34, 'drum_kit', 'kick_drum_left', None, .6, 0); N(34, 'cellos_pizz', 'D3', .3, .55, -.25); N(34, 'violas_pizz', 'A3', .3, .5, .1)
# 7) 勾选完成 b36–b40：终止式
N(36, 'glockenspiel', 'D6', 1.4, .62, .2); N(36, 'glockenspiel', 'F6', 1.4, .5, .25)
for p in ['Bb2', 'F3', 'D4', 'C5']: N(36, 'upright', p, 1.6, .5, -.1)
N(36, 'jazz_bass', 'Bb1', .6, .7, 0); N(36, 'drum_kit', 'kick_drum_left', None, .5, 0)
for i in range(7):
    b = 36.5 + i * .5; c = chord(b); N(b, 'violins_pizz', [up(c, 4), up(c, 3), up(c, 5), up(c, 3)][i % 4], .3, .4 - i * .025, .28)
    if i % 2 == 1: N(b, 'woodblock', 'a', None, .2, -.35)
N(38, 'jazz_bass', 'C2', .6, .6, 0); N(38, 'cellos_pizz', 'E3', .3, .45, -.25); N(38, 'violas_pizz', 'Bb3', .3, .42, .1)
for p in ['C3', 'G3', 'Bb3', 'E4']: N(38, 'upright', p, 1.2, .4, -.1)
# b40 主和弦
for inst, ps, pan in [('cellos_pizz', ['F2', 'C3'], -.3), ('violas_pizz', ['A3', 'C4'], .05), ('violins_pizz', ['F4', 'A4', 'F5'], .3)]:
    for p in ps: N(40, inst, p, .6, .62, pan)
for p in ['F2', 'C3', 'A3', 'C4', 'F4', 'A4']: N(40, 'upright', p, 2.0, .5, -.1)
N(40, 'jazz_bass', 'F1', .9, .7, 0); N(40, 'glockenspiel', 'A6', 1.6, .45, .25); N(40, 'glockenspiel', 'F6', 1.6, .4, .2)
N(40, 'drum_kit', 'ride_bell_left', None, .35, .3)

SPIT_T = bt(32)
is_spit = lambda e: abs(e[0] - SPIT_T) < 1e-6     # 吐出那一下的全部音符单独成一条母线
band = S.render([e for e in SCORE if not is_spit(e)], dur=NS / SR, master=False).astype(np.float32)
spitband = S.render([e for e in SCORE if is_spit(e)], dur=NS / SR, master=False).astype(np.float32)[:NS]
if spitband.shape[0] < NS: spitband = np.pad(spitband, ((0, NS - spitband.shape[0]), (0, 0)))
spitband = S.room(spitband, size=.3, mix=.13)
if band.shape[0] < NS: band = np.pad(band, ((0, NS - band.shape[0]), (0, 0)))
band = band[:NS]
# 夜间版：b21 踩下深色模式后整支乐队低通，b32 吐出瞬间恢复
night = np.stack([lp(band[:, ch], 620, 2) for ch in range(2)], 1).astype(np.float32) * 1.5
w = np.zeros(NS, np.float32); t = np.arange(NS) / SR
w = np.clip((t - bt(21)) / .25, 0, 1) * (t < bt(32))
band = band * (1 - w)[:, None] + night * w[:, None]
band = S.room(band, size=.3, mix=.13)
# 近静默：保证冻结长音之外、回收站段落里乐队完全收住（吐出前半拍全静）
gate = np.ones(NS, np.float32)
gate[(t >= bt(28)) & (t < bt(32))] = 0
fadeA = (t >= bt(27.6)) & (t < bt(28)); gate[fadeA] = 1 - (t[fadeA] - bt(27.6)) / (bt(28) - bt(27.6))
# 冻结段：前面的余响 0.15 s 内收掉，只留长音
fr = (t >= bt(24)) & (t < bt(28)); pad_only = S.render([e for e in SCORE if e[1] == 'vibraphone_bowed'], dur=NS / SR, master=False)[:NS]
pad_only = S.room(pad_only.astype(np.float32), size=.5, mix=.25)
k = np.clip((t - bt(24)) / .06, 0, 1)
band[fr] = band[fr] * (1 - k[fr])[:, None] + pad_only[fr] * k[fr][:, None]
# 回收站里的低音「咕咚」要留着：单独加回
gulp_bass = S.render([e for e in SCORE if e[1] == 'contrabass_pizz'], dur=NS / SR, master=False)[:NS]
band = band * gate[:, None] + gulp_bass * (1 - gate)[:, None] * ((t < bt(31.4)))[:, None]

# ═════════ 芯片声部（卡片的声音）
chip = np.zeros((NS, 2), np.float32)
def C(b, p, d, v=.5, pan=.15, **kw): add(chip, pulse(hz(p), d, vol=v, **kw), bt(b) if isinstance(b, (int, float)) else b, 1, pan)
CHIPLOG = []
def CL(b, p, d, v=.5, pan=.15, **kw): CHIPLOG.append((bt(b), 'chip', p)); C(b, p, d, v, pan, **kw)
# b12 挣脱：上行琶音
for k, p in enumerate(['F5', 'A5', 'C6', 'F6', 'A6']): CL(12 + k * .125, p, .1, .55, .1, duty=.125)
CL(13, 'C5', .08, .5, slide=.6)                    # 落地
CL(14, 'Ab5', .07, .5); CL(14.25, 'Db6', .14, .55)   # 「!」
# 追逐：芯片 16 分音符旋律（卡片在跑）
MEL = {16: ['D6', 'F6', 'Bb5', 'F6', 'D6', 'F6', 'Bb5', 'C6'], 18: ['E6', 'G6', 'C6', 'G6', 'E6', 'G6', 'C6', 'D6'],
       20: ['F6', 'A6', 'D6', 'A6', 'F6', 'A6', 'D6', 'E6'], 22: ['D6', 'F6', 'Bb5', 'D6', 'E6', 'G6', 'Bb6', 'C7']}
for b0, ps in MEL.items():
    for k, p in enumerate(ps): CL(b0 + k * .25, p, .1, .34 + .1 * (k % 4 == 0), .2, duty=.25)
# 回收站里闷着的芯片声
def muffled(b, p, d, v):
    x = pulse(hz(p), d, vol=v, duty=.5); x = lp(x, 500).astype(np.float32); add(chip, x, bt(b), 1, 0); CHIPLOG.append((bt(b), 'chip', p))
muffled(29, 'C5', .35, .4)
muffled(30, 'G4', .12, .2); muffled(30.25, 'C5', .12, .2)
muffled(31, 'Ab4', .1, .22); muffled(31.15, 'Ab4', .1, .22)
# b32 吐出：「噗」—— 大滑音
CHIPLOG.append((bt(32), 'chip', 'spit'))
spitchip = np.zeros((NS, 2), np.float32)
add(spitchip, pulse(hz('C7'), .5, vol=.7, duty=.25, slide=.25, rel=.1), bt(32), 1, 0)
add(spitchip, crush(pulse(hz('C4'), .35, vol=.5, duty=.5, slide=3.5)), bt(32), 1, 0)
for k, p in enumerate(['F6', 'E6', 'D6', 'C6']): CL(33 + k * .25, p, .1, .32, .2)
CL(34, 'A5', .1, .45, slide=.7)                    # 落回原位
CL(35, 'F5', .08, .35); CL(35.5, 'G5', .08, .35)   # 抬眼
CL(36, 'C6', .12, .45); CL(36.5, 'A5', .12, .36); CL(37, 'F5', .4, .3, vib=.01)   # 叹气（被勾掉了）
for e in evs('zzz'): CL(e['b'], 'F4', .25, .25, duty=.5); CL(e['b'] + .125, 'C4', .18, .16, duty=.5)    # zzz（+5 dB，两声一组，听得见）
CL(40, 'F6', .3, .3)

# ═════════ 拟音
fx = np.zeros((NS, 2), np.float32); spitfx = np.zeros((NS, 2), np.float32)
def F(x, t0, g=1., pan=0.): add(fx, np.asarray(x, np.float32), t0, g, pan)
def tap(v=1.):        # 触控板点击
    d = .05; return (norm(hp(rng.standard_normal(int(d * SR)), 1800) * np.exp(-tt(d) / .002)) * .7 + np.sin(2 * np.pi * 900 * tt(d)) * np.exp(-tt(d) / .006) * .4) * v
def bit_jump(): return pulse(300, .09, vol=.6, duty=.5, slide=3.2)
def bit_land(v=1.): return pulse(180, .09, vol=.7 * v, duty=.5, slide=.45)
def bit_step(v=.5, hi=False): return crush(pulse(900 if hi else 720, .035, vol=v, duty=.5, slide=.7))
for e in E:
    tp, t0 = e['type'], e['t']
    if tp == 'cursorIn': F(whoosh(.3), t0, .22, .4); F(nz(.04, 2500, 9000, 1., .008), t0, .3, .4)   # 光标滑入：轻嗖 + 起音（+5 dB）
    elif tp == 'press': F(tap(), t0, .5, .1)
    elif tp == 'click': F(tap(), t0, .55, .3)
    elif tp == 'drag': x = nz(e['d'], 700, 4200, .5) * np.sin(np.pi * tt(e['d'])[:int(round(e['d'] * SR))] / e['d']) ** .5; F(x, t0, .12, 0)
    elif tp == 'shake': d = e['d']; x = nz(d, 150, 900, 1.) * (.5 + .5 * np.sign(np.sin(2 * np.pi * 32 * tt(d)[:int(round(d * SR))]))) * np.linspace(.3, 1, int(round(d * SR))); F(x, t0, .18, 0)
    elif tp == 'break': F(sclick(.8), t0, .45, 0); F(nz(.25, 800, 6000, 1., .05), t0, .25, 0)
    elif tp == 'jump': F(bit_jump(), t0, .35, .1)
    elif tp == 'land': F(bit_land(), t0, .45, .1); F(nz(.12, 400, 2500, 1., .03), t0, .12, 0)
    elif tp == 'slotland': F(bit_land(1.2), t0, .5, -.1); F(sclick(.6), t0, .35, -.1)
    elif tp == 'stomp': F(bit_land(1.3), t0, .5, .2); F(sclick(1.1), t0, .5, .2); F(thump(1, 90), t0, .35, .2)
    elif tp == 'step': F(bit_step(e.get('v', .5), int(round(t0 * 4)) % 2 == 0), t0, .3, .15)
    elif tp == 'miss': F(whoosh(.22), t0, .22, -.2); F(tap(), t0, .4, -.2)
    elif tp == 'notif':   # 提醒提示音：两个玻璃般的正弦
        d = .8; x = sum(a * np.sin(2 * np.pi * f * tt(d)) * np.exp(-tt(d) / tau) for f, a, tau in [(1318.5, 1, .35), (2637, .3, .2)])
        y = sum(a * np.sin(2 * np.pi * f * tt(d)) * np.exp(-tt(d) / .3) for f, a in [(1975.5, 1), (3951, .25)])
        F(x, t0, .2, .5); F(y, t0 + bt(.25), .16, .5)
    elif tp == 'toastOut': F(whoosh(.3), t0, .2, .6)
    elif tp == 'winDrag': F(whoosh(e['d']), t0, .25, -.1)
    elif tp == 'dark':    # 下沉扫频
        d = 1.0; f = 900 * (.08 ** (tt(d) / d)); x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt(d) / .45); F(x, t0 + .02, .22, 0); F(lp(brown(1.2), 220) * np.exp(-tt(1.2) / .4), t0, .3, 0)
    elif tp == 'lunge': F(whoosh(.28), t0, .3, -.3)
    elif tp == 'shutter':  # 截屏快门：两声机械咔嚓
        for dt_, g in [(0, .55), (.075, .4)]: F(nz(.05, 1800, 7000, 1., .008), t0 + dt_, g, 0); F(sclick(.5), t0 + dt_, g * .5, 0)
    elif tp == 'unfreeze': F(whoosh(.25), t0, .18, 0)
    elif tp == 'gulp': F(pulse(220, .28, vol=.7, duty=.5, slide=.3), t0, .4, 0); F(thump(1, 60), t0, .35, 0); F(sclick(.45), t0 + .07, .2, 0)   # 盖子
    elif tp == 'creak':
        v = e.get('v', 1)
        if v < 1: F(creak(), t0, .06 * v, 0); F(thump(.6, 48), t0, .1 * v, 0)
        else: F(creak() * np.exp(-tt(.22) / .05), t0, .06, 0)      # 第三鼓：几乎无声，留给吐出
    elif tp == 'spit': add(spitfx, nz(.5, 300, 6000, 1., .12), t0, .55, 0); add(spitfx, thump(1, 55), t0, .7, 0); add(spitfx, whoosh(.45), t0 + .1, .3, -.3)
    elif tp == 'check': F(tap(1.1), t0, .55, -.1); F(sclick(1.3), t0 + .01, .25, -.1)
    elif tp == 'poof': F(nz(.3, 1500, 7000, 1., .07), t0, .12, 0)

# 房间底噪（全程，近静默里也在）
room = (lp(brown(NS / SR), 260) * .9 + hp(rng.standard_normal(NS), 6000) * .02).astype(np.float32)
amb = np.stack([room, np.roll(room, 2400)], 1) * db(-46)
quiet = ((t >= bt(24)) & (t < bt(32))).astype(np.float32)
amb *= (1 + quiet * 1.2)[:, None]

# ═════════ 混音
def rms(x): return float(np.sqrt(np.mean(x ** 2)) + 1e-12)
band *= .55; chip *= .42; fx *= .9
# 追逐段压低一点，留出吐出那一声的余量
chase = ((t >= bt(16)) & (t < bt(24))).astype(np.float32); band *= (1 - .3 * chase)[:, None]; chip *= (1 - .25 * chase)[:, None]
def win(a, b_, fade=.03): return np.clip((t - a) / fade, 0, 1) * np.clip((b_ - t) / fade, 0, 1)
# 追逐入场那一拍（b16 的镲、大鼓、通知）再压 3 dB；深色段 b21–b24 整体再压 2 dB —— 都是给吐出让路
band *= (1 - (1 - db(-3)) * win(bt(15) - .02, bt(17)))[:, None]; ent = (1 - (1 - db(-2)) * win(bt(15.5) - .02, bt(17)))[:, None]; chip *= ent; fx *= ent
band *= (1 - (1 - db(-1.5)) * win(bt(12) - .02, bt(13)))[:, None]   # 挣脱那一下也让 1.5 dB
dark = (1 - (1 - db(-2)) * win(bt(21) - .02, bt(24)))[:, None]; band *= dark; chip *= dark; fx *= dark
# 吐出母线：+2 dB，单独限幅（更长的前瞻 = 更慢的起控），不被整体限幅压扁
spit = (spitband * .55 + spitchip * .42 + spitfx * .9) * db(SPIT_BOOST)
mix = band + chip + fx + amb
g = db(-15.5 - 20 * np.log10(rms((mix + spit)[:int(DUR * SR)])))
mix *= g; spit *= g
for ch in range(2): mix[:, ch] = limit(mix[:, ch], .7, look=.004); spit[:, ch] = limit(spit[:, ch], .8, look=.012)
mix = (mix + spit)[:int(DUR * SR)]
# 母带：按 BS.1770 自己量响度，直接做到 −14 LUFS、样本峰值 ≤ −2.1 dBFS，mux 的 loudnorm 只需近 0 增益的线性校正
def kweight(x):
    from scipy.signal import lfilter
    y = lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, .73248077421585], x, axis=0)
    return lfilter([1, -2, 1], [1, -1.99004745483398, .99007225036621], y, axis=0)
def lufs_blocks(x, win_s=.4, hop=.1):
    y = kweight(x) ** 2; n, h = int(win_s * SR), int(hop * SR); cs = np.cumsum(np.r_[np.zeros((1, 2)), y], 0)
    st = np.arange(0, len(y) - n, h); e = (cs[st + n] - cs[st]).sum(1) / n
    return st / SR, -.691 + 10 * np.log10(e + 1e-12)
def integrated(x):
    _, L = lufs_blocks(x); L = L[L > -70]; rel = -.691 + 10 * np.log10(np.mean(10 ** ((L + .691) / 10))) - 10
    L = L[L > rel]; return -.691 + 10 * np.log10(np.mean(10 ** ((L + .691) / 10)))
for _ in range(4):
    mix *= db(-14 - integrated(mix))
    for ch in range(2): mix[:, ch] = limit(mix[:, ch], db(-2.1), look=.003)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')
# 乐谱导出（拍点核对用）
json.dump({'notes': sorted([[float(e[0]), e[1], str(e[2])] for e in SCORE] + [[float(a), b_, str(c)] for a, b_, c in CHIPLOG]), 'bpm': 60 / B},
          open(os.path.join(HERE, 'out', 'score.json'), 'w'))
# 报告：近静默段落的电平
def seg_db(a, b_): s = mix[int(a * SR):int(b_ * SR)]; return 20 * np.log10(rms(s))
print(f"整片 RMS {seg_db(0, DUR):.1f} dBFS | 追逐 {seg_db(bt(16), bt(24)):.1f} | 冻结 {seg_db(bt(24.3), bt(28)):.1f} | 回收站(吞下后) {seg_db(bt(29.6), bt(31.5)):.1f} | 吐出前半拍 {seg_db(bt(31.5), bt(32)):.1f} | 吐出 {seg_db(bt(32), bt(33)):.1f}")
st_, Lm = lufs_blocks(mix, .4, .01)
def mmax(a, b_): m = (st_ + .4 > a) & (st_ < b_); return Lm[m].max()
REP = {'吐出 b32': mmax(bt(32), bt(33)), '追逐入场 b16': mmax(bt(16), bt(17)), '追逐 b16-21': mmax(bt(16), bt(21)), '深色 b21-24': mmax(bt(21), bt(24)), '咕咚 b29': mmax(bt(28.8), bt(30)), '拖拽 b8-16': mmax(bt(8), bt(16)), '结尾 b36-': mmax(bt(36), DUR)}
print(f"整合响度 {integrated(mix):.2f} LUFS | 样本峰值 {20*np.log10(np.abs(mix).max()):.2f} dBFS | 瞬时响度最大值: " + ' | '.join(f'{k} {v:.1f}' for k, v in REP.items()))
print(f"吐出领先其它段落 {REP['吐出 b32'] - max(v for k, v in REP.items() if k != '吐出 b32'):.1f} LU")
print('instruments:', sorted(set(e[1] for e in SCORE)))
if os.environ.get('DEBUG'):
    for nm, x in [('band', band), ('chip', chip), ('fx', fx), ('amb', amb)]:
        r = lambda a, b_: 20 * np.log10(rms(x[int(a * SR):int(b_ * SR)]))
        print(nm, f"trash {r(bt(28.5), bt(31.5)):.1f} pre {r(bt(31.5), bt(32)):.1f} freeze {r(bt(24.3), bt(28)):.1f}")
if os.environ.get('DEBUG_M'):
    for a in np.arange(0, DUR - .4, .1):
        m = (st_ >= a) & (st_ < a + .1); print(f"{a + .4:5.1f}:{Lm[m].max():6.1f}", end='  ' if round(a * 10) % 8 != 7 else '\n')
