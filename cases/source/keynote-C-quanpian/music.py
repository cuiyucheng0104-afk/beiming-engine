"""方案 C《打开》全片配乐层 → out/music.wav（48 kHz 立体声，180.000 s，32 位浮点，未做最终响度）。
国风电子放克，120 BPM，E 羽五声（E G A B D），全片不转调；主题 = 开头的唢呐感动机（呼 E5–G5–A5 / 应 D5–E5–B4 / 两小节主题）。
音色与混音手法沿用 C-kaitou/mix.py：同一套鼓组律动、电贝斯处理、唢呐感、二胡、琵琶反拍、筝刮奏、同样的房间混响和低频平衡。
结构见 notes/music.md（规范 §4.1）。时刻从 events.json 读（翻页、摊平、静默拍、最强拍、台灯、合书、第六章四步）。
- 0–20 s 写零（开头的配乐在原混音里，mix.py 也会清零）；20.000 s 强拍接住开头悬在 B5 上的唢呐和军鼓滚奏。
- 115.5–116.0 s：所有乐器与混响尾巴全部为零；116.0 s 全片最强。
- 176.0 s 合书：主音 E 收住，余音到 180 s 归零。
乐器：$LIB/core/audio/sampler.py（采样）、pluck.py（琴、琵琶物理建模）；辅助函数在 music_inst.py。
运行：$LIB/.venv/bin/python music.py [events.json] [out.wav]       STEMS=1 另存分轨到 out/music_stems/"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB); sys.path.insert(0, HERE)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, lp, hp, bp, limit
from music_inst import deg, ROOT, fade, suona, erhu, flute, bass, brass, scissors, riser
S.seed(5)
R = np.random.default_rng(31)

EVJ = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'events.json')))
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'out', 'music.wav')
DUR = float(EVJ['dur']); N = int(round(DUR * SR)); EV = EVJ['ev']
BPM = 120; BEAT = 60 / BPM; BAR = 4 * BEAT; E16 = BEAT / 4
def bt(bar, beat=1, s16=0): return (bar - 1) * BAR + (beat - 1) * BEAT + s16 * E16
def bs(bar, s16=0): return bt(bar) + s16 * E16
def evs(typ, chap=None): return [e for e in EV if e['type'] == typ and (chap is None or e.get('chap') == chap)]
def ev1(typ, default):
    x = evs(typ); return x[0]['t'] if x else default
def barof(t): return int(round(t / BAR)) + 1                 # 落在小节线上的时刻 → 小节号

# ———————————————— 时刻（全部来自 events.json，与画面同一个时间源）————————————————
TURNS = sorted(e['t'] for e in evs('page_turn'))             # 26 / 38 / 48 / 60 / 96
FLAT = ev1('book_flat', 122.0)                               # 122：翻页 6→7 + 摊平
SIL = next((e for e in evs('silence') if e.get('chap') == 'ch4'), {'t': bt(58, 4), 'until': bt(59)})
SIL0, SIL1 = SIL['t'], SIL.get('until', SIL['t'] + BEAT)     # 115.5–116.0 全静
PEAK = next((e['t'] for e in evs('peak') if e.get('chap') == 'ch4'), SIL1)          # 116.0 全片最强
CLOSE = ev1('book_close', 176.0)                             # 176：合书
DIMS = sorted((e['t'], e['to'], e.get('dur', .25)) for e in evs('lamp_dim'))       # 38.5 → 0.3，48 → 1
STEPS = sorted(e['t'] for e in evs('step', 'ch67')) or [146.0, 150.0, 154.0, 158.0]
FILLS = TURNS + [FLAT]                                       # 每次翻页（含摊平）前一拍鼓组加花
assert abs(DUR - 180) < 1e-9, 'events.json 应是全片（dur = 180）'

BUS = ('drums', 'bass', 'music', 'lead', 'bright', 'air')
bus = {k: np.zeros((N, 2), np.float32) for k in BUS}
def put(x, t, gain=1.0, pan=0.0, b='music'): add(bus[b], np.asarray(x, np.float32), t, gain, pan)

# ———————————————— 和声：每小节一个和弦（E 羽五声内的五个"和弦"）————————————————
# E = Em7(11) · G = G6/9 · A = A7sus4 · B = B7sus4(11) · D = D6/9 —— 只用 E G A B D 五个音，所以永远在调里
PROG = {}
def prog(first, s):
    for i, c in enumerate(s.split()): PROG[first + i] = c
prog(11, 'E E E  E E G A E D  E G A B B  E D G A E B')          # 二 主歌
prog(31, 'E E  E E D E  A G A B  E E G A  E D G B')              # 三 间奏
prog(49, 'E E E E  E G A  G A B  E E D')                         # 四 副歌
prog(62, 'G G G D E A G D A A G B')                              # 五 桥段（G 宫一侧：同一组音，最亮）
prog(74, 'E E G G A A B B D D B')                                # 六 每一步一个和弦
prog(85, 'E E E E E E')                                          # 七 主题再现 + 合书
DYAD = {'E': ['B4', 'E5'], 'G': ['D5', 'G5'], 'A': ['E5', 'A5'], 'B': ['B4', 'D5'], 'D': ['A4', 'D5']}            # 琵琶反拍
VIB = {'E': ['E3', 'B3', 'D4', 'G4', 'A4'], 'G': ['G3', 'D4', 'E4', 'A4', 'B4'], 'A': ['A3', 'D4', 'E4', 'G4', 'B4'],
       'B': ['B3', 'E4', 'A4', 'D5'], 'D': ['D4', 'A4', 'B4', 'E5']}                                               # 颤音琴 / 筝
BRASS = {'E': ['E3', 'B3', 'E4', 'G4', 'B4'], 'G': ['G3', 'D4', 'G4', 'B4', 'D5'], 'A': ['A3', 'E4', 'A4', 'D5', 'E5'],
         'B': ['B2', 'A3', 'D4', 'E4', 'A4'], 'D': ['D3', 'A3', 'D4', 'E4', 'A4']}
ARP = {'G': ['G4', 'B4', 'D5', 'E5', 'G5', 'E5', 'D5', 'B4'], 'D': ['D4', 'A4', 'B4', 'D5', 'E5', 'D5', 'B4', 'A4'],
       'E': ['E4', 'G4', 'B4', 'D5', 'E5', 'D5', 'B4', 'G4'], 'A': ['A4', 'D5', 'E5', 'G5', 'A5', 'G5', 'E5', 'D5'],
       'B': ['B4', 'D5', 'E5', 'A5', 'B5', 'A5', 'E5', 'D5']}                                                     # 马林巴十六分
ZARP = {c: v for c, v in {'E': ['E4', 'B4', 'D5', 'E5'], 'G': ['G4', 'D5', 'E5', 'G5'], 'A': ['A4', 'E5', 'G5', 'A5'],
                          'B': ['B4', 'E5', 'A5', 'B5'], 'D': ['D4', 'A4', 'B4', 'D5']}.items()}                 # 筝分解

# ———————————————— 鼓组 ————————————————
dr = []                                     # (t, inst, var, vel, pan, gain)
def D(t, v, vel, pan=0.0, inst='drum_kit', g=None):
    dr.append((t, inst, v, vel, pan, g if g is not None else {'drum_kit': .8, 'claps': 1.1}.get(inst, .7)))
def has_fill(bar): return any(abs(bs(bar + 1) - f) < 1e-6 for f in FILLS)
KICK = [0, 3, 6, 10, 11]; KICK2 = [0, 3, 6, 8, 10]; GHOST = [7, 9, 15]
def groove(bar, last=None, var=0, crash=False, open_=True):
    """开头的放克律动（第 5–10 小节）：底鼓 0 3 6 10 11、军鼓 + 拍手 2、4 拍、幽灵音、闭镲十六分、第 4 拍后半开镲"""
    last = last if last is not None else (12 if has_fill(bar) else 16)
    for s in range(last):
        t = bs(bar, s)
        if s in (KICK2 if var else KICK): D(t, 'kick_drum_left', .85 if s == 0 else .7)
        if s in (4, 12): D(t, 'snare_1', .78, .05); D(t, 'group', .5, -.1, 'claps')
        if s in GHOST: D(t, 'snare_rest_1', .22, .05)
        if s == 14 and open_: D(t, 'hi_hat_open', .42, -.25)
        elif s != 15: D(t, 'hi_hat_closed', .48 if s % 2 == 0 else .3, -.25)
    if crash: D(bs(bar), 'crash_left', .8, .3)
def half(bar, back='frame', hats=True, last=None):
    """半编制（第三章）：底鼓 0、10，第 3 拍一下"反拍"（手鼓 / 拍手 / 军鼓边），闭镲只打八分且很轻"""
    last = last if last is not None else (12 if has_fill(bar) else 16)
    for s in range(last):
        t = bs(bar, s)
        if s == 0: D(t, 'kick_drum_left', .72)
        if s == 10: D(t, 'kick_drum_left', .5)
        if s == 8:
            if back == 'frame': D(t, 'small', .55, .1, 'frame_drum', .6)
            elif back == 'frame_l': D(t, 'large', .6, -.1, 'frame_drum', .6)
            elif back == 'claps': D(t, 'group', .5, -.1, 'claps', .9)
            else: D(t, 'snare_2', .5, .05)
        if hats and s % 2 == 0 and s != 8: D(t, 'hi_hat_closed', .3 if s % 4 == 0 else .2, -.25)
def night(bar, last=None):
    """守护（台灯调暗）：只有轻底鼓、第 3 拍军鼓边、沙锤八分"""
    last = last if last is not None else (12 if has_fill(bar) else 16)
    for s in range(last):
        t = bs(bar, s)
        if s == 0: D(t, 'kick_drum_left', .6)
        if s == 10: D(t, 'kick_drum_left', .42)
        if s == 8: D(t, 'snare_rest_2', .42, .05)
        if s % 2 == 0: D(t, 'down' if s % 4 == 0 else 'up', .3, .3, 'shaker', .5)
def bright(bar, last=None, hats=True):
    """桥段（最亮）：四踩底鼓、2/4 军鼓 + 拍手、反拍开镲、十六分铃鼓"""
    last = last if last is not None else (12 if has_fill(bar) else 16)
    for s in range(last):
        t = bs(bar, s)
        if s % 4 == 0: D(t, 'kick_drum_left', .8 if s == 0 else .68)
        if s in (4, 12): D(t, 'snare_1', .7, .05); D(t, 'group', .55, -.1, 'claps')
        if hats:
            if s % 4 == 2: D(t, 'hi_hat_open', .34, -.25)
            elif s % 2 == 1: D(t, 'hi_hat_closed', .22, -.25)
        if s % 2 == 0: D(t, 0, .32 if s % 4 == 0 else .22, .35, 'tambourine', .45)
def claps_only(bar):
    """第六章：只剩拍手（2、4 拍），第 4 拍后半一个轻拍手当弱起"""
    D(bs(bar, 4), 'solo', .62, .1, 'claps', 1.0); D(bs(bar, 12), 'solo', .66, -.1, 'claps', 1.0)
    if bar % 2 == 1: D(bs(bar, 14), 'solo', .3, .2, 'claps', .8)
def fill(tland, kind='tom', crash=True):
    """翻页前一拍的加花（开头第 4 小节那一下：通通鼓十六分 + 军鼓），落定那一拍底鼓 + 镲"""
    t0 = tland - BEAT
    if kind == 'tom':
        for k, tm in enumerate(['tom_1', 'tom_2', 'tom_3', 'tom_4']): D(t0 + k * E16, tm, .62 + .08 * k, [.35, .1, -.15, -.35][k])
        D(t0 + 3 * E16, 'snare_1', .55, 0)
    elif kind == 'low':                       # 进入"守护"：低的两下，不刺耳
        D(t0, 'tom_3', .55, -.15); D(t0 + 2 * E16, 'tom_4', .62, -.35); D(t0 + 3 * E16, 'tom_4', .5, -.35)
    elif kind == 'roll':                      # 进入第四章 / 合作城：军鼓三连十六分滚奏渐强 + 通通鼓收
        for k in range(9): D(t0 + k * BEAT / 12, 'snare_1', .4 + .05 * k, 0)
        D(t0 + 9 * BEAT / 12, 'tom_2', .75, .1); D(t0 + 10 * BEAT / 12, 'tom_3', .8, -.15); D(t0 + 11 * BEAT / 12, 'tom_4', .85, -.35)
    D(tland, 'kick_drum_left', .9)
    if crash: D(tland, 'crash_left' if kind != 'low' else 'ride_bell_left', .8 if kind != 'low' else .45, .3)

# ———————————————— 贝斯 ————————————————
# 节奏型用"五声级数"写（0 = 根音，5 = 高八度），按每小节的和弦根音平移 —— 永远在调里
RA = [(0, 0, 2, .9), (3, 0, 1, .45), (4, 5, 1, .8), (6, 4, 1, .7), (7, 5, 1, .8), (10, 1, 1, .8), (11, 2, 1, .75), (12, 3, 2, .85), (14, 4, 1, .7), (15, 5, 1, .6)]   # = 开头 BA
RB = [(0, 0, 2, .9), (3, 0, 1, .45), (4, 5, 1, .8), (6, 1, 1, .7), (7, 2, 1, .8), (8, 3, 2, .8), (10, 4, 1, .75), (11, 5, 1, .8), (12, 4, 1, .7), (13, 3, 1, .7), (14, 2, 1, .7), (15, 1, 1, .7)]  # = 开头 BB
RNIGHT = [(0, 0, 10, .7), (11, 0, 1, .35), (12, 3, 2, .5), (14, 4, 2, .48)]
RHALF = [(0, 0, 5, .8), (6, 0, 1, .42), (7, 5, 1, .6), (10, 4, 2, .58), (12, 3, 2, .55), (14, 1, 2, .5)]
RBRIGHT = [(0, 0, 2, .85), (2, 5, 1, .6), (4, 0, 1, .7), (6, 5, 1, .65), (8, 0, 2, .8), (10, 5, 1, .6), (11, 4, 1, .55), (12, 0, 1, .7), (14, 5, 1, .6), (15, 3, 1, .5)]
RSTEP = [(0, 0, 3, .72), (3, 0, 1, .34), (6, 3, 2, .5), (8, 5, 2, .55), (11, 4, 1, .42), (12, 3, 2, .5), (14, 1, 2, .44)]
RDRIVE = [(s, 5 if s % 4 == 2 else 0, 1, .82 if s % 4 == 0 else .62) for s in range(0, 12, 2)]
def bassbar(bar, pat, last=None, gain=.62, root=None):
    last = last if last is not None else (12 if has_fill(bar) else 16)
    r = ROOT[root or PROG[bar]]
    for s, d_, dur, v in pat:
        if s >= last: continue
        put(bass(deg(r + d_), dur * E16 * .92, v), bs(bar, s), gain, 0, 'bass')

# ———————————————— 旋律工具 ————————————————
def line(inst, bar, notes, gain, pan=0.0, b='lead', vel=None, oct=0):
    """notes = [(十六分位置, 音高, 时值(十六分), 参数)]"""
    for s, p, d_, *kw in notes:
        kw = dict(kw[0]) if kw else {}
        m = S.midi(p) + 12 * oct; dur = d_ * E16 * .95; t = bs(bar, s)
        if inst == 'suona': x = suona(m, dur, vel or .78, **kw)
        elif inst == 'erhu': x = erhu(m, dur, vel or .55, kw.get('slide_from'))
        elif inst == 'flute': x = flute(m, dur, vel or .55, scoop=kw.get('scoop', 0))
        elif inst == 'glock': x = S.note('glockenspiel', m, dur + .6, vel or .5)
        elif inst == 'pipa_trem': x = P.pluck('pipa', m, dur, vel or .62, trem=14)
        elif inst == 'pipa': x = P.pluck('pipa', m, .9, vel or .7)
        else: raise KeyError(inst)
        put(x, t, gain, pan, b)
HU = [(0, 'E5', 2, dict(scoop=-2)), (2, 'G5', 2), (4, 'A5', 3.6, dict(fall=-1.5))]                     # 呼（开头第 2 小节）
YING = [(0, 'D5', 2), (2, 'E5', 2), (4, 'B4', 5.6, dict(fall=-1))]                                       # 应（开头第 3 小节）
TH1 = [(0, 'E5', 3, dict(slide_from=-2)), (3, 'G5', 1), (4, 'A5', 2), (6, 'G5', 1), (7, 'E5', 1), (8, 'D5', 2), (10, 'E5', 2), (12, 'B4', 4)]
TH2 = [(0, 'E5', 2), (2, 'G5', 2), (4, 'A5', 2), (6, 'B5', 2, dict(slide_from=-2)), (8, 'D6', 3, dict(slide_from=-3, slide_t=.12)), (11, 'B5', 1), (12, 'B5', 4.2, dict(swell=True))]
def theme(bar, vel=.78, gain=.15, erhu_g=.22, flute_g=0.0, last_swell=True):
    """两小节主题（开头第 9–10 小节）：唢呐感 + 二胡低八度托住（+ 可选长笛同度）"""
    th2 = TH2 if last_swell else TH2[:-1] + [(12, 'B5', 4, {})]
    line('suona', bar, TH1, gain, .12, vel=vel); line('suona', bar + 1, th2, gain, .12, vel=vel)
    for b_, ph in ((bar, TH1), (bar + 1, th2)):
        line('erhu', b_, [(s, p, d_, {'slide_from': (kw[0] if kw else {}).get('slide_from')}) for s, p, d_, *kw in ph], erhu_g, -.35, 'music', .45, oct=-1)
        if flute_g: line('flute', b_, [(s, p, d_) for s, p, d_, *kw in ph], flute_g, .3, 'lead', .5)
def pipa_off(bar, gain=.35, s_list=(2, 10), last=None):
    last = last if last is not None else (12 if has_fill(bar) else 16)
    for s in s_list:
        if s < last: put(P.strum('pipa', DYAD[PROG[bar]], .3, .5, spread=.012), bs(bar, s), gain, -.35)
def zheng_gliss(t, up=True, n=14, span=1.0, gain=.4, top='B5'):
    GL = ['E3', 'G3', 'A3', 'B3', 'D4', 'E4', 'G4', 'A4', 'B4', 'D5', 'E5', 'G5', 'A5', 'B5']
    GL = GL[:GL.index(top) + 1][-n:]
    seq = GL if up else GL[::-1]
    for k, p in enumerate(seq): put(S.note('dan_tranh', p, 1.2, .35 + .03 * k), t + k * span / len(seq), gain, -.5 + k / len(seq), 'music')

# ════════════════════════════════ 二 主歌（第 11–30 小节，20–60 s）════════════════════════════════
# 20.000：接住开头 —— 底鼓 + 双镲 + 小锣 + 贝斯 E1 + 琵琶 E 和弦 + 唢呐从 B5 往上"喊"到 E6 再落下
D(bt(11), 'crash_left', .85, .3); D(bt(11), 'crash_right', .7, -.3); D(bt(11), 'kick_drum_left', .95)
put(S.hit('gong2', 'small', .6), bt(11), .35, .4)
put(P.strum('pipa', ['E4', 'B4', 'E5'], .6, .75, spread=.01), bt(11), .45, -.3)
line('suona', 11, [(0, 'E6', 5, dict(slide_from=-5, slide_t=.07, fall=-2))], .15, .12, vel=.8)
for bar in range(11, 20):
    groove(bar, var=bar % 2)
    bassbar(bar, RA if bar % 2 else RB)
    pipa_off(bar)
D(bt(14), 'crash_right', .7, -.3)
# 2a：标签打字的两小节只留节奏组；第 12 小节二胡轻声"应"，第 13 小节长笛短花音
line('erhu', 12, [(0, 'D5', 2), (2, 'E5', 2), (4, 'B4', 7, dict(slide_from=-1.5))], .4, -.3, 'music', .5)
line('flute', 13, [(4, 'G5', 1), (5, 'A5', 1), (6, 'B5', 1), (7, 'D6', 3)], .28, .35)
# 2b 担当与协作：唢呐（右）呼、二胡（左）应，一问一答；第 18 小节两件乐器合到一起奏主题前半；第 19 小节筝下行
line('suona', 14, HU, .14, .25)
line('erhu', 15, [(0, 'D5', 2), (2, 'E5', 2), (4, 'B4', 6, dict(slide_from=-1.5))], .45, -.35, 'music', .55)
line('suona', 16, [(0, 'G5', 2), (2, 'A5', 2), (4, 'B5', 4, dict(slide_from=-2)), (10, 'A5', 2), (12, 'G5', 3.6, dict(fall=-1))], .14, .25)
line('erhu', 17, [(0, 'A5', 2), (2, 'G5', 2), (4, 'E5', 4, dict(slide_from=-2)), (8, 'D5', 2), (10, 'E5', 5)], .45, -.35, 'music', .55)
line('suona', 18, TH1[:-1] + [(12, 'B4', 3.4, dict(fall=-1))], .15, .12)
put(P.strum('pipa', ['A3', 'D4', 'A4', 'D5'], .5, .7, spread=.01), bs(19), .4, -.3)
line('erhu', 18, [(s, p, d_) for s, p, d_, *k in TH1], .3, -.35, 'music', .5, oct=-1)
for k, p in enumerate(['B5', 'A5', 'G5', 'E5', 'D5', 'B4', 'A4', 'G4']): put(S.note('dan_tranh', p, .6, .5 - .02 * k), bs(19, k), .4, .4 - .1 * k)
fill(TURNS[0] if TURNS else 26.0, 'tom', crash=False)        # 26：翻页前一拍
fill(TURNS[1] if len(TURNS) > 1 else 38.0, 'low', crash=False)   # 38：进"守护"
# 2c 守护（第 20–24 小节）：台灯真的调暗 —— 鼓组只剩轻底鼓、军鼓边、沙锤；贝斯长音；琴泛音像月光；长笛慢旋律；筝摇指铺底
for bar in range(20, 25):
    night(bar); bassbar(bar, RNIGHT, gain=.58)
    put(S.note('dan_tranh_trem', VIB[PROG[bar]][-2], 2.0, .32, attack=.4), bs(bar), .22, -.45, 'music')
    put(S.note('dan_tranh_trem', VIB[PROG[bar]][-1], 2.0, .3, attack=.5), bs(bar, 2), .2, .45, 'music')
t_dim = DIMS[0][0] if DIMS else bt(20, 2)
for bar, s, p in [(20, None, 'E5'), (21, 0, 'D5'), (22, 0, 'E5'), (23, 0, 'B4'), (24, 0, 'B5')]:
    t = t_dim if s is None else bs(bar, s)
    put(P.pluck('guqin', p, 3.0, .6, harmonic=True), t, .55, .25, 'air')
flute_moon = {20: [(4, 'B5', 8), (12, 'A5', 4)], 21: [(0, 'G5', 4), (4, 'E5', 8), (12, 'D5', 2), (14, 'E5', 2)],
              22: [(0, 'A5', 6), (6, 'G5', 2), (8, 'E5', 4), (12, 'G5', 4)], 23: [(0, 'B5', 12), (12, 'D6', 4)], 24: [(0, 'B5', 8), (8, 'A5', 3.6)]}
for bar, ns in flute_moon.items(): line('flute', bar, [(s, p, d_, {'scoop': -1 if d_ >= 6 else 0}) for s, p, d_ in ns], .34, .3, 'air', .55)
fill(TURNS[2] if len(TURNS) > 2 else 48.0, 'tom')              # 48：翻页 + 台灯恢复
# 2d 陪伴与成长（第 25–30 小节）：律动回来；二胡温暖的旋律、长笛高八度同奏；筝八分分解像转盘一格一格转；第 29–30 小节唢呐接主题
for bar in range(25, 31):
    groove(bar, var=bar % 2); bassbar(bar, RA if bar % 2 else RB); pipa_off(bar, .3)
    zl = ZARP[PROG[bar]]
    for s in range(0, 12 if has_fill(bar) else 16, 2): put(S.note('dan_tranh', zl[(s // 2) % 4], .45, .42 if s % 4 else .5), bs(bar, s), .28, .45, 'music')
warm = {25: [(0, 'B4', 2), (2, 'D5', 2), (4, 'E5', 4), (8, 'G5', 4), (12, 'E5', 2), (14, 'D5', 2)],
        26: [(0, 'E5', 4), (4, 'D5', 2), (6, 'B4', 2), (8, 'A4', 8)],
        27: [(0, 'G4', 2), (2, 'A4', 2), (4, 'B4', 4), (8, 'D5', 4), (12, 'E5', 4)],
        28: [(0, 'G5', 6), (6, 'E5', 2), (8, 'D5', 4), (12, 'E5', 4)]}
for bar, ns in warm.items():
    line('erhu', bar, [(s, p, d_, {'slide_from': -1.5 if d_ >= 4 else None}) for s, p, d_ in ns], .45, -.3, 'music', .55)
    line('flute', bar, ns, .22, .3, 'lead', .5, oct=1)
line('suona', 29, TH1, .15, .12)
line('erhu', 29, [(s, p, d_) for s, p, d_, *k in TH1], .26, -.35, 'music', .45, oct=-1)
line('suona', 30, [(0, 'E5', 2), (2, 'G5', 2), (4, 'A5', 2), (6, 'B5', 5.6, dict(slide_from=-2, swell=True))], .15, .12)
fill(TURNS[3] if len(TURNS) > 3 else 60.0, 'tom', crash=False)

# ════════════════════════════════ 三 美术语言（第 31–48 小节，60–96 s）：半编制，每档换主奏 ════════════════════════════════
D(bt(31), 'ride_bell_left', .5, .3)
zheng_gliss(bt(31), True, 14, 1.0, .36)                      # 长拉片露出来：筝五声上行（开头揭晓那一下的回声）
for bar in (31, 32):
    half(bar, 'snare', hats=bar == 32); bassbar(bar, RHALF, gain=.56)
    put(S.note('dan_tranh_trem', 'B4', 2.0, .3, attack=.5), bs(bar), .2, -.4, 'music')
line('suona', 32, [(8, 'B4', 2), (10, 'D5', 2), (12, 'E5', 3.6, dict(fall=-1))], .1, .1, vel=.62)
# ——— 水墨（33–36）：长笛 + 古琴；更大的房间（air 总线）———
for bar in range(33, 37): half(bar, 'frame', hats=False); bassbar(bar, RHALF, gain=.5)
for k in range(32): D(bt(33) + k * BEAT / 2, 'down' if k % 2 == 0 else 'up', .22, .35, 'shaker', .4)
ink_fl = {33: [(0, 'E5', 8), (8, 'G5', 4), (12, 'A5', 4)], 34: [(0, 'B5', 12), (12, 'A5', 4)],
          35: [(0, 'G5', 4), (4, 'E5', 4), (8, 'D5', 4), (12, 'E5', 4)], 36: [(0, 'B4', 14)]}
for bar, ns in ink_fl.items(): line('flute', bar, [(s, p, d_, {'scoop': -1.5 if d_ >= 8 else 0}) for s, p, d_ in ns], .4, .25, 'air', .58)
qin = [(33, 0, 'E3', 2.4, {}), (33, 8, 'A3', 2.0, dict(bend=[(0, 0), (.25, 0), (.55, 2)])), (34, 0, 'E2', 3.0, {}), (34, 6, 'B4', 2.5, dict(harmonic=True)),
       (34, 12, 'D4', 1.5, dict(vib=(4.5, .25, .3))), (35, 0, 'D3', 2.4, {}), (35, 8, 'G3', 2.0, dict(bend=[(0, 0), (.3, 0), (.6, 2)])),
       (36, 0, 'E3', 3.0, dict(vib=(4.2, .2, .5))), (36, 8, 'E5', 2.5, dict(harmonic=True)), (36, 12, 'B4', 2.0, dict(harmonic=True))]
for bar, s, p, d_, kw in qin: put(P.pluck('guqin', p, d_, .7, **kw), bs(bar, s), .6, -.25, 'air')
# ——— 壁画（37–40）：琵琶轮指主奏；手鼓 ———
for bar in range(37, 41): half(bar, 'frame_l'); bassbar(bar, RHALF, gain=.54)
mural = {37: [(0, 'A4', 4), (4, 'B4', 4), (8, 'E5', 8)], 38: [(0, 'D5', 4), (4, 'B4', 4), (8, 'A4', 4), (12, 'G4', 4)],
         39: [(0, 'A4', 2), (2, 'B4', 2), (4, 'D5', 4), (8, 'E5', 4), (12, 'G5', 4)], 40: [(0, 'E5', 12), (12, 'D5', 4)]}
for bar, ns in mural.items(): line('pipa_trem', bar, ns, .5, .2, 'lead', .62)
for bar in range(37, 41): put(P.strum('pipa', DYAD[PROG[bar]], .5, .45, spread=.015), bs(bar, 10), .25, -.4)
# ——— 剪纸（41–44）：剪刀声做成十六分音符节奏型（X 合刃重、x 合刃轻、o 张开）+ 筝的八分断奏 ———
SCI = {41: 'X..xX.o.X..xXoxo', 42: 'X.xoX.xoX.xoX.xx', 43: 'X..xX.o.X..xXoxo', 44: 'XxoxX.oxXxoxXxXx'}
for bar in range(41, 45):
    half(bar, 'claps', hats=False); bassbar(bar, RHALF, gain=.54)
    for s, c in enumerate(SCI[bar]):
        if c == '.': continue
        pt = 1.0 + .06 * ((s * 7 + bar) % 5) - .12
        put(scissors(R, c != 'o', pt), bs(bar, s), {'X': .3, 'x': .19, 'o': .16}[c], .35 if s % 2 else -.2, 'drums')
    zl = ZARP[PROG[bar]]
    for s in range(0, 16, 2): put(S.note('dan_tranh', zl[(s // 2) % 4], .22, .5 if s % 4 == 0 else .38), bs(bar, s), .3, .4, 'music')
line('suona', 44, [(8, 'B5', 2), (10, 'A5', 2), (12, 'B5', 3.6, dict(slide_from=-2))], .09, .15, vel=.6)
# ——— 木偶（45–48）：木鱼块 + 二胡 ———
WB = {0: ('a', .8), 3: ('b', .55), 6: ('b', .6), 8: ('a', .7), 10: ('c', .5), 11: ('b', .45), 12: ('a', .7), 14: ('c', .55)}
for bar in range(45, 49):
    half(bar, 'snare', hats=False); bassbar(bar, RHALF, gain=.56)
    for s, (v, vel) in WB.items():
        if s < (12 if has_fill(bar) else 16): D(bs(bar, s), v, vel, .25, 'woodblock', .5)
puppet = {45: [(0, 'E5', 3, dict(slide_from=-2)), (3, 'G5', 1), (4, 'A5', 4), (8, 'G5', 2), (10, 'E5', 2), (12, 'D5', 4)],
          46: [(0, 'E5', 2), (2, 'D5', 2), (4, 'B4', 4, dict(slide_from=-1.5)), (8, 'A4', 4), (12, 'B4', 4)],
          47: [(0, 'D5', 2), (2, 'E5', 2), (4, 'G5', 4), (8, 'A5', 4), (12, 'G5', 2), (14, 'A5', 2)],
          48: [(0, 'B5', 8, dict(slide_from=-2)), (8, 'A5', 3.6)]}
for bar, ns in puppet.items(): line('erhu', bar, ns, .55, -.15, 'lead', .62)
fill(TURNS[4] if len(TURNS) > 4 else 96.0, 'roll')           # 96：翻进第四章

# ════════════════════════════════ 四 新作品 · 副歌（第 49–61 小节，96–122 s）：最满 ════════════════════════════════
def stab(t, ch, dur=.16, vel=.75, gain=.24, pan=.15): put(brass(BRASS[ch], dur, vel), t, gain, pan, 'music')
put(S.hit('gong2', 'small', .65), bt(49), .35, .4)
zheng_gliss(bt(49), True, 14, 1.0, .42)                      # 纸塔弹起
for bar in range(49, 59):
    if bar == 58: continue
    groove(bar, var=bar % 2, crash=bar in (51, 54)); pipa_off(bar, .36)
    bassbar(bar, RA if bar % 2 else RB, gain=.64)
for bar in (49, 50):
    for s in (0, 6, 11): stab(bs(bar, s), PROG[bar], .14 if s else .2, .78 if s == 0 else .66)
theme(51, .8, .16, .24, flute_g=.18)                         # 鲸鱼剧照卡滑过塔顶：主题完整一遍
# 四扇窗（第四章导演：第 53 小节第 2、3、4 拍 + 第 54 小节第 1 拍依次打开）：铜管一窗一个和弦往上走、琵琶单音，第四扇落回主音 E
for k, (b_, s, ch) in enumerate([(53, 4, 'G'), (53, 8, 'A'), (53, 12, 'B'), (54, 0, 'E')]):
    stab(bs(b_, s), ch, .22, .7 + .05 * k, .26)
    put(P.pluck('pipa', ['G5', 'A5', 'B5', 'E6'][k], .9, .75), bs(b_, s), .45, -.3 + .2 * k)
line('suona', 54, [(0, 'E5', 2, dict(scoop=-2)), (2, 'G5', 2), (4, 'A5', 4, dict(fall=-1.5)), (8, 'B5', 2), (10, 'D6', 2), (12, 'B5', 3.6)], .15, .12)
line('erhu', 55, [(0, 'A5', 2), (2, 'G5', 2), (4, 'E5', 4, dict(slide_from=-2)), (8, 'D5', 2), (10, 'E5', 5)], .5, -.3, 'music', .58)
line('flute', 55, [(0, 'A5', 2), (2, 'G5', 2), (4, 'E5', 4), (8, 'D5', 2), (10, 'E5', 5)], .2, .3, 'lead', .5, oct=1)
for bar in (54, 55): stab(bs(bar, 6), PROG[bar], .14, .66); stab(bs(bar, 11), PROG[bar], .14, .62)
# 纸森林（56–58）：越来越密 —— 第 57 小节加军鼓八分，第 58 小节前三拍军鼓十六分渐强 + 上扫 + 唢呐长音，到 115.5 戛然而止
line('suona', 56, [(0, 'D6', 4, dict(slide_from=-2)), (4, 'B5', 4), (8, 'A5', 4), (12, 'B5', 4)], .15, .12)
line('suona', 57, [(0, 'E6', 8, dict(slide_from=-2)), (8, 'D6', 4), (12, 'E6', 4)], .15, .12)
for s in range(0, 16, 2): D(bs(57, s), 'snare_2', .3 + .02 * s, .05)
put(S.note('dan_tranh_trem', 'B4', 4.0, .4, attack=.8), bt(56), .25, -.4, 'music')
nsil = int(round((SIL0 - bt(58)) / E16))                     # 第 58 小节静默拍之前的十六分数（= 12）
for s in range(nsil):
    t = bs(58, s); D(t, 'snare_1', .4 + .5 * s / nsil, 0)
    if s % 2 == 0: D(t, 'kick_drum_left', .7 + .02 * s)
    if s % 4 == 0: D(t, 'tom_4', .5 + .03 * s, -.3)
for s, d_, _, v in RDRIVE: put(bass(deg(ROOT['B'] + d_), E16 * .9, v), bs(58, s), .66, 0, 'bass')
put(bass(deg(ROOT['B']), E16 * .9, .7), bs(58, 1), .5, 0, 'bass')
put(riser(R, SIL0 - bt(57, 3)), bt(57, 3), .16, 0, 'drums')
line('suona', 58, [(0, 'B5', nsil, dict(slide_from=-2, swell=True))], .16, .12, vel=.85)
put(S.note('erhu', 'B4', SIL0 - bt(58), .55, attack=.3), bt(58), .35, -.3, 'music')
stab(bs(58, 0), 'B', .22, .8, .26)
# ——— 116.0：全片最强的一下（台灯转向打亮燃比娃）———
tp = PEAK
for v, vel, pan in [('crash_left', 1.0, .4), ('crash_right', .95, -.4), ('china', .8, .1), ('kick_drum_left', 1.0, 0), ('snare_1', .95, 0)]: D(tp, v, vel, pan)
D(tp, 'group', .9, 0, 'claps', 1.0)
put(S.hit('gong', None, .9), tp, .55, .1, 'music')
put(S.hit('gran_cassa', 'hit', .95), tp, .8, 0, 'drums')
put(S.note('timpani', 'E3', 1.5, .95), tp, .7, -.1, 'drums')
put(brass(BRASS['E'], .42, .95), tp, .42, .1, 'music')
put(P.strum('pipa', ['E3', 'B3', 'E4', 'G4', 'B4', 'E5'], 1.2, .95, spread=.008), tp, .55, -.3)
put(bass(deg(0), .9, 1.0), tp, .72, 0, 'bass'); put(bass(deg(5), .9, .9), tp, .4, 0, 'bass')
zheng_gliss(tp + E16, False, 14, .7, .38)
put(S.note('glockenspiel', 'E6', 1.5, .7), tp, .25, .4, 'bright')
# 燃比娃（59–61）：主题最强的一遍（唢呐 + 长笛同度 + 二胡低八度 + 铜管）
for bar in (59, 60, 61):
    groove(bar, var=bar % 2, crash=bar == 60); pipa_off(bar, .38)
    bassbar(bar, RA if bar % 2 else RB, gain=.66)
theme(59, .9, .17, .26, flute_g=.2)
for bar in (59, 60):
    for s in (6, 11): stab(bs(bar, s), PROG[bar], .14, .7, .22)
line('suona', 61, [(0, 'D6', 2), (2, 'B5', 2), (4, 'A5', 4, dict(fall=-1.5)), (8, 'B5', 2), (10, 'A5', 1.6)], .15, .12)
stab(bs(61, 0), 'D', .2, .78); stab(bs(61, 6), 'D', .14, .66)
fill(FLAT, 'roll')                                          # 122：摊平前一拍

# ════════════════════════════════ 五 合作城 · 桥段（第 62–73 小节，122–146 s）：最亮 ════════════════════════════════
put(S.note('glockenspiel', 'G6', 2.0, .7), FLAT, .3, .35, 'bright'); put(S.note('glockenspiel', 'D6', 2.0, .6), FLAT, .25, -.35, 'bright')
put(P.strum('pipa', ['G3', 'D4', 'G4', 'B4', 'D5'], .8, .8, spread=.01), FLAT, .4, -.3)
for bar in range(62, 74):
    ch = PROG[bar]
    if bar < 64:                                            # 城市生长：马林巴从低到高层层弹开，鼓组只进底鼓和铃鼓
        for s in range(16):
            if s % 4 == 0: D(bs(bar, s), 'kick_drum_left', .72)
            if s % 2 == 0: D(bs(bar, s), 0, .26, .35, 'tambourine', .4)
        if bar == 63: D(bs(63, 4), 'group', .5, -.1, 'claps'); D(bs(63, 12), 'group', .55, -.1, 'claps')
    else:
        bright(bar, hats=bar < 72)
    bassbar(bar, RBRIGHT, gain=.58)
    for s in range(16):                                     # 马林巴十六分分解（生长段从低八度往上爬）
        p = ARP[ch][s % 8]; m = S.midi(p) - (12 if bar == 62 and s < 8 else 0)
        put(S.note('marimba', m, .3, .62 if s % 4 == 0 else .42), bs(bar, s), .34, .3 * np.sin(s * .8), 'bright')
for k in range(8): put(S.note('glockenspiel', ['G5', 'B5', 'D6', 'E6', 'G6', 'A6', 'B6', 'D7'][k], .8, .45 + .03 * k), bs(63, 2 * k), .22, -.4 + .1 * k, 'bright')
for bar in (64, 66, 68): put(S.note('glockenspiel', 'B6', 1.2, .6), bs(bar), .22, .45, 'bright')     # 每到一家店（小节第一拍）一声亮"叮"
bridge = {64: [(0, 'B5', 2), (2, 'D6', 2), (4, 'E6', 4), (8, 'D6', 2), (10, 'B5', 2), (12, 'A5', 4)],
          65: [(0, 'B5', 2), (2, 'A5', 2), (4, 'G5', 4), (8, 'A5', 2), (10, 'B5', 2), (12, 'D6', 4)],
          66: [(0, 'E6', 3), (3, 'D6', 1), (4, 'B5', 2), (6, 'D6', 2), (8, 'E6', 2), (10, 'G6', 2), (12, 'E6', 4)],
          67: [(0, 'D6', 2), (2, 'B5', 2), (4, 'A5', 6), (10, 'B5', 2), (12, 'A5', 2), (14, 'G5', 2)],
          68: [(0, 'B5', 2), (2, 'D6', 2), (4, 'E6', 4), (8, 'D6', 2), (10, 'B5', 2), (12, 'A5', 4)],
          69: [(0, 'B5', 2), (2, 'A5', 2), (4, 'B5', 2), (6, 'D6', 2), (8, 'E6', 4), (12, 'D6', 4)],
          70: [(0, 'E6', 4), (4, 'G6', 4), (8, 'A6', 8)], 71: [(0, 'G6', 4), (4, 'E6', 4), (8, 'D6', 8)],
          72: [(0, 'B5', 8), (8, 'A5', 8)], 73: [(0, 'B5', 12)]}
for bar, ns in bridge.items():
    line('flute', bar, ns, .3, .2, 'lead', .58)
    line('glock', bar, [(s, p, d_) for s, p, d_ in ns if d_ <= 4 or s == 0], .17, -.25, 'bright', .5)
for bar in (70, 71, 72):                                    # 三道门：pipa 在第 1、2、3 拍各拨一声（门开在拍上）
    for k in range(3): put(P.pluck('pipa', ['E5', 'A5', 'B5'][k], .8, .6), bs(bar, 4 * k), .26, -.4 + .4 * k)
for bar in (72, 73): put(S.note('vibraphone', VIB[PROG[bar]][-1], 2.0, .45), bs(bar), .3, .3, 'bright')

# ════════════════════════════════ 六 洽谈 · 尾奏前段（第 74–84 小节，146–168 s）：只剩拍手 + 贝斯，每一步一个和弦 ════════════════════════════════
for bar in range(74, 85):
    claps_only(bar); bassbar(bar, RSTEP, gain=.6)
chord_t = sorted(set([t for t in STEPS if bt(74) - 1e-6 <= t < bt(85)] + [bt(82), bt(84)]))
for t in chord_t:
    ch = PROG[int(t // BAR + 1e-9) + 1]
    vs = VIB[ch]
    for k, p in enumerate(vs): put(S.note('vibraphone', p, 3.6, .5 - .03 * k), t + k * .012, .34, -.3 + .15 * k, 'bright')
    nxt = min([u for u in chord_t if u > t + 1e-6] + [bt(85)])               # 弓奏颤音琴极轻地托住这个和弦，直到下一步（不加鼓，不抢地面印字的"嘭"）
    for k, p in enumerate(vs[1:4]): put(S.note('vibraphone_bowed', p, nxt - t - .15, .35, attack=.6, release=.3), t, .12, -.4 + .4 * k, 'bright')

# ════════════════════════════════ 七 尾声（第 85–90 小节，168–180 s）：主题完整再现，合书收在主音 ════════════════════════════════
for bar in (85, 86): half(bar, 'snare', hats=True); bassbar(bar, RA if bar % 2 else RB, gain=.6); pipa_off(bar, .3)
for bar in (87, 88): groove(bar, var=bar % 2, crash=bar == 87, last=12 if bar == 88 else 16); bassbar(bar, RA if bar % 2 else RB, gain=.62, last=12 if bar == 88 else 16); pipa_off(bar, .34, last=12 if bar == 88 else 16)
line('suona', 85, HU, .15, .12)
line('erhu', 86, [(0, 'D5', 2), (2, 'E5', 2), (4, 'B4', 6, dict(slide_from=-1.5))], .5, -.3, 'music', .58)
line('suona', 86, YING, .12, .12, vel=.7)
theme(87, .82, .16, .24, flute_g=.16)
for k in range(12): D(bt(88, 4) + k * E16 / 3, 'snare_1', .35 + .045 * k, 0)      # 第 88 小节第 4 拍：和开头最后一拍同一个军鼓滚奏
D(bt(88, 4), 'crash_left', .35, .3)
put(bass(deg(3), 1.5 * BEAT, .8), bt(88, 4), .5, 0, 'bass')
# 176.0 合书：主音 E 收住 —— 唢呐落到 E5、贝斯 E1、古琴空弦 E2 + 泛音、颤音琴 E 和弦、小锣、钟琴；余音约 2 s
tc = CLOSE
D(tc, 'kick_drum_left', .9); D(tc, 'crash_right', .55, -.3)
put(suona(S.midi('E5'), .9, .78, slide_from=-2, slide_t=.08, fall=-1.2), tc, .15, .12, 'lead')
put(bass(deg(0), 2.4, .9), tc, .62, 0, 'bass')
put(P.pluck('guqin', 'E2', 4.0, .8), tc, .55, -.2, 'air'); put(P.pluck('guqin', 'E5', 4.0, .55, harmonic=True), tc + E16, .45, .25, 'air')
for k, p in enumerate(['E3', 'B3', 'E4', 'G4', 'B4']): put(S.note('vibraphone', p, 3.5, .5), tc + k * .01, .28, -.3 + .15 * k, 'bright')
put(S.hit('gong2', 'small', .55), tc, .32, .4)
put(S.note('glockenspiel', 'E6', 3.0, .45), tc + BEAT, .18, .4, 'bright')
put(S.note('dan_tranh_trem', 'E5', 2.2, .3, attack=.25), tc, .16, -.45, 'music')

# ———————————————— 鼓组渲染 ————————————————
for t, inst, v, vel, pan, g in dr: put(S.hit(inst, v, vel), t, g, pan, 'drums')

# ════════════════════════════════ 混音（与开头同一套手法）════════════════════════════════
tt = np.arange(N) / SR
def ramp(t0, t1, a, b):
    """t0→t1 从 a 平滑到 b（升余弦），其余时间保持端点"""
    u = np.clip((tt - t0) / max(t1 - t0, 1e-6), 0, 1); return a + (b - a) * (.5 - .5 * np.cos(np.pi * u))
room = {'drums': (.25, .08), 'bass': (.2, .04), 'music': (.4, .14), 'lead': (.45, .16), 'bright': (.45, .16), 'air': (.7, .26)}
out = {k: S.room(bus[k], *room[k]) for k in BUS}
# 2c 守护：台灯调暗的同一刻，鼓、贝斯、民乐一起"变暗"（低通 1.4 kHz 混入 80%），台灯恢复时回来
if len(DIMS) >= 2:
    (t_d, _, dd), (t_u, _, du) = DIMS[0], DIMS[1]
    w = ramp(t_d, t_d + dd, 0, .8) * (1 - ramp(t_u - .02, t_u + du, 0, 1))
    for k in ('drums', 'bass', 'music'):
        dark = np.stack([lp(out[k][:, c], 1400) for c in (0, 1)], 1)
        out[k] = (out[k] * (1 - w[:, None]) + dark * w[:, None]).astype(np.float32)
mix = out['drums'] * 1.0 + out['bass'] * 1.0 + out['music'] * .95 + out['lead'] * 1.05 + out['bright'] * .9 + out['air'] * 1.0
# 能量曲线：各章整体电平（dB），在小节线上 60 ms 过渡（加花在前一小节，不受影响）
GAIN = [(11, 0), (20, -2.5), (25, 0), (31, -.5), (33, -.5), (37, 0), (45, 0), (49, 1), (59, 1.5), (62, 2), (72, 1), (74, 0), (85, 0), (89, .5)]
gdb = np.zeros(N)
for (b0, g0), (b1, g1) in zip(GAIN, GAIN[1:] + [(91, GAIN[-1][1])]):
    gdb = np.where((tt >= bt(b0) - .03) & (tt < bt(b1) - .03), g0, gdb)
from scipy.ndimage import uniform_filter1d
gdb = uniform_filter1d(gdb, int(.06 * SR))
mix *= (10 ** (gdb / 20))[:, None]
# 低频平衡（开头同款）：20–120 Hz 去掉 1/4
low = np.stack([lp(mix[:, c], 120) for c in (0, 1)], 1); mix = mix - low * .25
# 给动作音效留的"窗"：2.5–6 kHz 静态下凹约 2 dB（纸、木、金属拟音的主频段）
pres = np.stack([bp(mix[:, c], 2500, 6000) for c in (0, 1)], 1); mix = mix - pres * .2
# ——— 全静一拍：115.5–116.0 所有乐器、混响尾巴一律为零（30 ms 收，最强拍前 4 ms 才放开）———
g = np.ones(N, np.float32); a, b = int(SIL0 * SR), int(SIL1 * SR) - int(.004 * SR)
g[a:b] = 0; g[a - int(.03 * SR):a] = np.linspace(1, 0, int(.03 * SR))
mix *= g[:, None]
# ——— 片尾：合书后余音，178.0 起 2 s 余弦收到 0；20 s 之前清零（开头原混音负责）———
mix *= ramp(178.0, DUR - .002, 1, 0)[:, None]
mix[:int(20.0 * SR)] = 0
mix[-int(.005 * SR):] = 0
# 只防削波（最终响度由 mix.py 统一做）：前瞻限幅到 −1 dBFS
for _ in range(2): mix = np.stack([limit(mix[:, c], .89, .004) for c in (0, 1)], 1)
mix = mix.astype(np.float32)
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
tmp = OUT + f'.tmp{os.getpid()}.wav'; sf.write(tmp, mix, SR, subtype='FLOAT'); os.replace(tmp, OUT)
if os.environ.get('STEMS'):
    sd = os.path.join(os.path.dirname(os.path.abspath(OUT)), 'music_stems'); os.makedirs(sd, exist_ok=True)
    for k in BUS: sf.write(os.path.join(sd, k + '.wav'), out[k], SR, subtype='FLOAT')
print(f'music {OUT}  {len(mix) / SR:.3f} s  峰值 {20 * np.log10(np.abs(mix).max() + 1e-12):.2f} dBFS  鼓组 {len(dr)} 击')
