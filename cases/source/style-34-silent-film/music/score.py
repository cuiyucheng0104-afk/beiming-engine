"""《追帽子》原创配乐：1920s 影院钢琴手按 cue sheet 演奏（立式钢琴 + 酒馆钢琴叠奏 + 班卓拨弦；钢琴自己做打击：低音音簇代替军鼓、高音震音代替镲）。
所有时间都从 timeline.json 的拍点算出；每个命名拍点都写一个起音，写进 out/score_onsets.json 给 cuecheck 核对。
用法：.venv/bin/python music/score.py <project>  → out/music.wav（48k 立体声）"""
import sys, os, json
import numpy as np, soundfile as sf

LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
TL = json.load(open(os.path.join(ROOT, 'timeline.json')))
SEC, HIT = TL['sec'], TL['hit']
DUR = TL['dur']
def B(sec, b=0.0): s = SEC[sec]; return s['t0'] + b * s['beat']
S.seed(34)

EV = []            # sampler events
PL = []            # pluck (banjo) events: (t, pitch, dur, vel, pan)
ON = {}            # hit name -> score onset time (for cuecheck)
def n(t, p, d=.3, v=.6, pan=0., inst='upright', g=1.0, **kw):
    e = dict(t=float(t), inst=inst, pitch=p, dur=d, vel=v, pan=pan, gain=g); e.update(kw); EV.append(e)
def ch(t, ps, d=.3, v=.6, pan=0., inst='upright', roll=0., g=1.0):
    for i, p in enumerate(ps): n(t + i * roll, p, d, v, pan, inst, g)
def mark(name, t): ON[name] = float(t)
def gliss(t0, t1, lo, hi, v=.5, pan=0., up=True):
    """白键刮奏（上行或下行），每个音一个短音"""
    whites = [m for m in range(int(round(S.midi(lo))), int(round(S.midi(hi))) + 1) if m % 12 in (0, 2, 4, 5, 7, 9, 11)]
    if not up: whites = whites[::-1]
    for i, m in enumerate(whites): n(t0 + (t1 - t0) * i / len(whites), m, .12, v * (.75 + .25 * i / len(whites)), pan)
def trem(t0, t1, ps, rate, v0, v1, pan=0.):
    """震音：在两组音之间交替；力度 v0 → v1"""
    k = 0; t = t0
    while t < t1 - 1e-6:
        u = (t - t0) / (t1 - t0); n(t, ps[k % len(ps)], 1 / rate * 1.1, v0 + (v1 - v0) * u, pan); k += 1; t += 1 / rate

# ======================= A  WALK · Allegretto rag (F 大调, 120) =======================
b = SEC['WALK']['beat']
mark('start', B('WALK', 0))
# 跨步左手：低音八度 + 中音和弦
n(B('WALK', 0), 'F2', .4, .62, -.3); n(B('WALK', 0), 'F1', .4, .45, -.3)
ch(B('WALK', 1), ['A3', 'C4', 'F4'], .2, .48, -.15)
n(B('WALK', 2), 'C2', .35, .55, -.3)
# 右手：切分的散步主题（主题 M：A–B♭–B–C–A）
for t, p, d, v in [(0, 'A5', .22, .62), (.25, 'Bb5', .1, .5), (.375, 'B5', .1, .5), (.5, 'C6', .22, .64), (.75, 'A5', .2, .55)]:
    n(B('WALK', 0) + t, p, d, v, .2)
# 致意：装饰音 + 分解和弦（结尾会原样再听到一次）
TIP_ROLL = ['F4', 'A4', 'C5', 'F5', 'A5']
def tip_figure(t, v=.6):
    n(t - .045, 'E6', .04, v * .7, .25); n(t, 'F6', .45, v, .25)
    ch(t, TIP_ROLL, .5, v * .8, .1, roll=.022)
tip_figure(B('WALK', 2)); mark('tip', B('WALK', 2))
# 风卷：上行刮奏
gliss(B('WALK', 3), B('WALK', 3) + .26, 'C5', 'C7', .48, .3); mark('gust', B('WALK', 3))
n(B('WALK', 3) + .27, 'C7', .1, .5, .3); n(B('WALK', 3) + .32, 'B6', .1, .4, .3); n(B('WALK', 3) + .37, 'C7', .1, .45, .3); n(B('WALK', 3) + .42, 'B6', .08, .35, .3)
# 帽子落地：plink…plonk + 回头的减七 sforzando
n(B('WALK', 3) + .75 * b, 'G6', .1, .45, .3)
mark('land', B('WALK', 4))
n(B('WALK', 4), 'Ab1', .4, .7, -.3); ch(B('WALK', 4), ['B2', 'D3', 'F3', 'Ab3'], .3, .72, -.1)
# 下蹲：低音半音爬行（为起跑蓄力）
for i, p in enumerate(['E2', 'F2', 'F#2', 'G2']): n(B('WALK', 4) + .5 * b + i * .0625, p, .08, .45 + i * .06, -.3)

# ======================= B  CHASE · Hurry (D 小调, 144) =======================
cb = SEC['CHASE']['beat']; e8 = cb / 2; s16 = cb / 4
def oompah(b0, b1, roots, chords, v=.55):
    """左手跨步：拍上低音，反拍和弦"""
    for i, bb in enumerate(np.arange(b0, b1, 1.0)):
        n(B('CHASE', bb), roots[i % len(roots)], .18, v, -.3); n(B('CHASE', bb), roots[i % len(roots)].replace('2', '1'), .18, v * .6, -.3)
        ch(B('CHASE', bb + .5), chords[i % len(chords)], .14, v * .8, -.15)
def run16(b0, notes, v=.55, inst='upright', pan=.2, g=1.0):
    for i, p in enumerate(notes): n(B('CHASE', b0) + i * s16, p, s16 * 1.2, v, pan, inst, g)
def banjo(b0, b1, chords, v=.5):
    for i, bb in enumerate(np.arange(b0, b1, 1.0)):
        for k, p in enumerate(chords[i % len(chords)]): PL.append((B('CHASE', bb + .5) + k * .012, p, .2, v, .35))
Dm, A7 = ['D4', 'F4', 'A4'], ['C#4', 'E4', 'G4', 'A4']
mark('run', B('CHASE', 0))
n(B('CHASE', 0), 'D2', .3, .8, -.3); ch(B('CHASE', 0), ['D3', 'A3', 'D4', 'F4'], .2, .7)
oompah(1, 3, ['A2', 'D2'], [Dm, A7]); banjo(0, 3, [['D4', 'F4', 'A4'], ['C#4', 'E4', 'A4']])
run16(0, ['D5', 'E5', 'F5', 'G5', 'A5', 'G5', 'F5', 'E5', 'D5', 'E5', 'F5', 'G5', 'A5', 'Bb5', 'A5', 'G5', 'F5', 'E5', 'D5', 'C#5', 'D5', 'E5', 'F5', 'A5'], .55)
# 帽子跳下路沿：低音 "boing"
mark('curb', B('CHASE', 2)); n(B('CHASE', 2), 'A1', .3, .7, -.2); n(B('CHASE', 2) + .06, 'D2', .2, .5, -.2)
# 电车铃 → 停拍，低音震音渐强（等待）
mark('tramIn', B('CHASE', 3)); ch(B('CHASE', 3), ['A2', 'E3', 'G3', 'C#4'], .2, .7, 0, g=.8)
trem(B('CHASE', 3) + e8, B('CHASE', 4), ['A1', 'A2'], 16, .35, .8, -.3)
# near-miss：减七 sforzando（全键盘）
mark('nearMiss', B('CHASE', 4))
ch(B('CHASE', 4), ['C#2', 'C#3', 'E3', 'G3', 'Bb3', 'C#4', 'E4', 'G4', 'Bb4', 'C#5'], .5, .8, 0, g=.5)
ch(B('CHASE', 4), ['C#1'], .6, .8, -.3)
trem(B('CHASE', 4) + .02, B('CHASE', 4) + .3, ['C#7', 'E7'], 28, .4, .2, .35)          # 高音震音 = 擦身而过的"镲"
# 车尾离开：一个孤零零的高音 plink（他僵在那儿）
mark('tramOut', B('CHASE', 5)); n(B('CHASE', 5), 'D7', .3, .45, .3)
# 帽子飞上墙头：上行琶音 → 落点一下
for i, p in enumerate(['D4', 'F4', 'A4', 'D5', 'F5', 'A5', 'D6']): n(B('CHASE', 5) + e8 + i * (cb * .5 / 7), p, .1, .4 + i * .04, .3)
mark('hatWall', B('CHASE', 6)); ch(B('CHASE', 6), ['F5', 'A5', 'D6'], .25, .6, .3); n(B('CHASE', 6), 'D2', .25, .6, -.3)
# 爬梯：每级一步上行（D 和声小调）
climb = [('rung1', ['D4', 'E4'], 'D2'), ('rung2', ['F4', 'G#4'], 'E2'), ('rung3', ['A4', 'B4'], 'F2')]
for i, (nm, ps, bass) in enumerate(climb):
    t = B('CHASE', 7 + i); mark(nm, t)
    n(t, ps[0], e8 * .9, .58 + i * .06, .2); n(t + e8, ps[1], e8 * .9, .52 + i * .06, .2)
    n(t, bass, .2, .55, -.3); ch(t + e8, ['A3', 'D4'], .12, .4, -.15)
# 抓空：高音小二度刺 → plonk
mark('grab', B('CHASE', 10)); ch(B('CHASE', 10), ['C#6', 'D6'], .2, .75, .3); n(B('CHASE', 10) + e8, 'D2', .35, .6, -.3)
# 梯子晃：神经质颤音（渐强）
mark('wobble', B('CHASE', 11)); trem(B('CHASE', 11), B('CHASE', 11) + .22, ['A5', 'Bb5'], 26, .4, .65, .25)
# 弹飞 → 下行刮奏 → 前臂音簇
T_FL = B('CHASE', 11) + .3
gliss(T_FL - .05, B('CHASE', 12) - .02, 'C3', 'C7', .6, .1, up=False)
mark('fall', B('CHASE', 12))
ch(B('CHASE', 12), ['D1', 'E1', 'F1', 'G1', 'A1', 'Bb1', 'C2'], .5, .85, -.2, g=.7); ch(B('CHASE', 12), ['D2', 'D3'], .4, .7, -.2, g=.7)   # 前臂音簇（−3 dB，给揭晓让位）
trem(B('CHASE', 12) + .02, B('CHASE', 12) + .22, ['D7', 'F7'], 28, .4, .2, .35)          # 高音震音代替镲
# 狗吠：低音八度 "汪汪"
mark('bark', B('CHASE', 13)); ch(B('CHASE', 13), ['D1', 'D2'], .15, .8, -.2); ch(B('CHASE', 13) + e8, ['D1', 'D2'], .15, .75, -.2)
# undercrank：满速 Hurry，八度跑句 + 酒馆钢琴叠奏 + 小军鼓
mark('crank', B('CHASE', 14))
oompah(14, 17, ['D2', 'A2', 'D2'], [Dm, A7, Dm], .62); banjo(14, 17, [['D4', 'F4', 'A4'], ['C#4', 'E4', 'A4'], ['D4', 'F4', 'A4']], .55)
fast = ['D5', 'F5', 'A5', 'D6', 'C#6', 'A5', 'F5', 'E5', 'D5', 'F5', 'A5', 'D6', 'E6', 'F6', 'E6', 'D6', 'C#6', 'A5', 'G5', 'E5', 'C#5', 'E5', 'G5', 'A5']
run16(14, fast, .62); run16(14, [p[:-1] + str(int(p[-1]) + 1) for p in fast], .4, 'honky_tonk', -.1, .8)
mark('step2', B('CHASE', 15)); mark('step3', B('CHASE', 16))
# 军鼓改由钢琴低音区音簇担任：反拍上一记闷闷的小音簇（人和狗的脚步雷声），越跑越重
for k in range(6): ch(B('CHASE', 14.5 + k * .5), ['D2', 'Eb2', 'E2'] if k % 2 == 0 else ['A1', 'Bb1', 'B1'], .09, .34 + k * .04, -.2, g=.8)

# ======================= C  CARD1 · Misterioso (90) =======================
mark('card1', B('CARD1', 0))
ch(B('CARD1', 0), ['D2', 'D3', 'F3', 'Ab3', 'B3', 'D4'], .7, .82, 0, g=.8)     # 切卡刺音（Hurry 戛然而止）
# 低音半音爬行：每拍一个音，正好落在卡上逐字落定的那一拍（顶/帽/子）
for i, (nm, p, q) in enumerate([('c1ding', 'D2', 'D3'), ('c1mao', 'Eb2', 'Eb3'), ('c1zi', 'E2', 'E3')]):
    mark(nm, B('CARD1', 1 + i)); n(B('CARD1', 1 + i), p, .55, .5 + i * .07, -.3); n(B('CARD1', 1 + i), q, .4, .32 + i * .05, -.2)
trem(B('CARD1', 2) + .05, B('CARD1', 4) - .02, ['F3', 'Ab3', 'B3', 'D4'], 14, .16, .62, 0)        # 减七震音渐强…
# 两个「…」：两下高音点（一个一个冒出来）
mark('c1dots1', B('CARD1', 3.5)); n(B('CARD1', 3.5), 'B5', .12, .42, .3)
mark('c1dots2', B('CARD1', 3.75)); n(B('CARD1', 3.75), 'B5', .12, .46, .3)
n(B('CARD1', 2.5), 'F2', 1.0, .5, -.3, release=.08)
# …然后在 SIL 起点干净地停住（release 很短 = 制音器落下）

# ======================= D  SIL · 静默（只有放映机） =======================
mark('silence', B('SIL', 0)); mark('twitch', B('SIL', 1))

# ======================= E  REVEAL · 揭晓 (F 大调, 90) =======================
mark('reveal', B('REVEAL', 0))
ch(B('REVEAL', 0), ['F1', 'F2', 'C3', 'F3', 'A3', 'C4', 'F4', 'A4', 'C5', 'F5', 'A5', 'C6'], 1.4, .95, 0, roll=.018, g=1.35)
ch(B('REVEAL', 0), ['F1', 'F2'], 1.2, .9, -.2, g=1.2)
ch(B('REVEAL', 0), ['F0', 'C1', 'F1', 'A2', 'C3', 'F3'], 1.6, 1.0, 0, g=1.3)
ch(B('REVEAL', 0) + .25, ['F3', 'A3', 'C4', 'F4', 'A4', 'C5'], 1.2, .8, 0, roll=.03, g=1.1)        # 第二次回响的和弦（踩着踏板再滚一遍），把揭晓撑满                  # 低八度强音和弦：揭晓要比全片任何一下都满
mark('look', B('REVEAL', 1)); n(B('REVEAL', 1) - .045, 'B5', .04, .45, .3); n(B('REVEAL', 1), 'C6', .3, .6, .3)
sb = SEC['REVEAL']['beat']; q8 = sb / 2
# 主题 M 的谐谑变奏（高八度、断奏），轻跨步伴奏
theme = [('A5', 0), ('Bb5', .5), ('B5', .75), ('C6', 1), ('A5', 1.5), ('F5', 2), ('G5', 2.5), ('A5', 3), ('C6', 3.5), ('F6', 4), ('E6', 4.5), ('D6', 5), ('C6', 5.5), ('A5', 6), ('Bb5', 6.5), ('G5', 7)]
t0 = B('REVEAL', 1.5)
for p, bb in theme:
    t = t0 + bb * sb
    if t < B('END', 0) - .05: n(t, p, q8 * .7, .5, .2)
for i, bb in enumerate(np.arange(1.5, 8.5, 1.0)):
    t = t0 + (bb - 1.5) * sb
    if t >= B('END', 0) - .05: break
    root = ['F2', 'C2', 'F2', 'C2', 'Bb1', 'C2', 'F2'][i % 7]; n(t, root, .25, .42, -.3)
    ch(t + q8, ['A3', 'C4', 'F4'] if root != 'C2' else ['G3', 'Bb3', 'E4'], .2, .34, -.15)
mark('card2', B('CARD2', 0)); n(B('CARD2', 0), 'F2', .3, .55, -.3)
mark('settle', B('CARD2', 1)); n(B('CARD2', 1), 'F6', .15, .5, .3); n(B('CARD2', 1) + .08, 'C6', .12, .35, .3)

# ======================= G  END · 回声致意 → 收束 =======================
mark('bow', B('END', 0)); tip_figure(B('END', 0), .62); n(B('END', 0), 'F2', .5, .5, -.3)
mark('irisShut', B('END', 1)); ch(B('END', 1), ['F1', 'F2', 'C3', 'F3', 'A3', 'C4'], 1.6, .7, 0, roll=.012, g=.8)
mark('curtain', B('END', 2)); n(B('END', 2), 'F6', .6, .42, .3); n(B('END', 2), 'C7', .6, .3, .3)

# ======================= 渲染 =======================
def build():
    mix = S.render(EV, dur=DUR + 2.0, master=False)
    bj = np.zeros_like(mix)
    for t, p, d, v, pan in PL: add(bj, P.pluck('banjo', p, d, vel=v), t, .32, pan)
    mix = mix + bj
    mix = S.room(mix, size=.28, mix=.14)
    return mix.astype(np.float32)

if __name__ == '__main__':
    out = os.path.join(ROOT, 'out'); os.makedirs(out, exist_ok=True)
    m = build()
    sf.write(os.path.join(out, 'music.wav'), m, SR)
    json.dump({'onsets': ON, 'notes': sorted(set(round(e['t'], 6) for e in EV))}, open(os.path.join(out, 'score_onsets.json'), 'w'), indent=1)
    used = sorted(set(e['inst'] for e in EV))
    print('music.wav', m.shape[0] / SR, 's  peak', float(np.abs(m).max()), ' instruments', used, '+ banjo (pluck)')
