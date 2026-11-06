"""《会用工具的海獭》配乐 + 拟音 + 自然声 → out/mix.wav（48 kHz 立体声），并写 out/cues.json（配乐实际下锤时间，供拍点核对）。
响度由 mux.sh 统一到 −14 LUFS。读：timeline.js（经 node 导出）、events.json（画面事件，events.mjs 导出）。
配乐：120 BPM（拍 0.5 s，小节 2 s）。C 小调新闻律动 → 定格处硬停进入真静默 → 答案落在 E♭ 大调铜管 + 管钟，半拍感收尾。
乐器（core/audio/sampler.py 真实采样）：MuldjordKit 鼓组、电贝斯、马林巴、颤音琴、钢片琴、小号/长号断奏、圆号、定音鼓、大鼓、
吊镲、管钟、低音提琴；core/audio/pluck.py 拨弦（闷音吉他琶音）；numpy 合成的低音脉冲、riser、水声与纸面底噪。"""
import json, os, subprocess, sys
import numpy as np, soundfile as sf
H = os.path.dirname(os.path.abspath(__file__)); D = os.path.dirname(H)
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB); sys.path.insert(0, os.path.join(LIB, 'core', 'audio'))
from core.audio import sampler as S
from core.audio import pluck as P
import sfx
from sfx import SR, t_, bp, lp, hp, noise, norm, brown

TL = json.loads(subprocess.check_output(['node', '-e', f"process.stdout.write(JSON.stringify(require({json.dumps(os.path.join(D, 'timeline.js'))})))"]))
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
DUR = TL['dur']; N = int(round(DUR * SR)); S16 = .125; HT = TL['hits']; MU = TL['music']
S.seed(63); rng = np.random.default_rng(63)
CUES = []                       # (t, 名称)：配乐里真正下锤的时间
def cue(t, name): CUES.append({'t': round(t, 4), 'name': name})

def buf(): return np.zeros((N, 2), np.float32)
def put(b, x, at, g=1.0, pan=0.0):
    i = int(round(at * SR)); x = np.asarray(x, np.float32)
    if i < 0: x = x[-i:]; i = 0
    if i >= N: return
    x = x[:max(0, N - i)]
    if x.ndim == 2: b[i:i + len(x)] += x * g; return
    l, r = np.sqrt(.5 * (1 - pan)), np.sqrt(.5 * (1 + pan))
    b[i:i + len(x), 0] += x * g * l * 1.414; b[i:i + len(x), 1] += x * g * r * 1.414

# ----------------------------------------------------------------- 和声与段落
CH = [(0.0, 2.0, 48, 'm'), (2.0, 4.0, 44, ''), (4.0, 6.0, 41, 'm'), (6.0, 7.0, 43, ''),
      (7.0, 9.0, 48, 'm'), (9.0, 10.0, 44, ''), (10.0, 11.0, 43, ''),
      (14.0, 16.0, 51, ''), (16.0, 17.0, 44, ''), (17.0, 18.0, 46, ''), (18.0, 19.5, 51, '')]
def chord_at(t):
    for a, b, r, q in CH:
        if a - 1e-6 <= t < b - 1e-6: return r, q
    return None
def tones(r, q, base=60):
    third = 3 if q == 'm' else 4
    return sorted(base + ((p - base) % 12) for p in (r, r + third, r + 7))
SIL = MU['silences']; STOP = MU['stopBeat']; BUILD = MU['build']
def section(t):
    if t < 1.0: return 'hook'
    if STOP[0] - 1e-6 <= t < 7.0 - 1e-6: return 'stop'
    if t < STOP[0]: return 'A'
    if t < BUILD[0]: return 'B'
    if t < BUILD[1]: return 'build'
    if t < SIL[0][1]: return 'sil'
    return 'V'

E = []
def n(t, inst, p, d, v, pan=0, g=1.0): E.append((t, inst, p, d, v, pan, g))
KIT = 'drum_kit'
plucks = buf(); sub = np.zeros(N, np.float32)
def subpulse(t, root, v=1.0):   # 合成“低音脉冲”：根音正弦 + 2、3 次谐波（小喇叭上也听得见），0.28 s 衰减
    d = .3; tt = t_(d); f = 440 * 2 ** ((root - 24 - 69) / 12)
    x = (np.sin(2 * np.pi * f * tt) + .45 * np.sin(4 * np.pi * f * tt) + .25 * np.sin(6 * np.pi * f * tt)) * np.exp(-tt / .09) * np.minimum(1, tt / .004)
    i = int(round(t * SR)); x = x[:max(0, N - i)]; sub[i:i + len(x)] += x.astype(np.float32) * .5 * v

t = 0.0
while t < DUR - 1e-6:
    sec = section(t); b16 = int(round(t / S16)); beat = b16 // 4; s4 = b16 % 4; bb = beat % 4; ch = chord_at(t)
    if sec == 'hook':
        if abs(t - .5) < 1e-6: subpulse(t, 48, .8); cue(t, 'sub')
    elif sec in ('A', 'B'):
        if s4 == 0: n(t, KIT, 'kick_drum_left', None, .8 if bb in (0, 2) else .66, 0, .95); cue(t, 'kick'); subpulse(t, ch[0] % 12 + 36, .9)
        if s4 == 0 and bb in (1, 3) and t >= 2.0: n(t, KIT, 'snare_1', None, .62, .05, .62)
        if s4 == 2: n(t, KIT, 'hi_hat_closed', None, .55, .25, .42)
        if sec == 'B' and s4 in (1, 3): n(t, KIT, 'hi_hat_closed', None, .28, .25, .26)
        if ch and s4 in (0, 2):   # 电贝斯八分，每两拍最后一个八分翻高八度
            m = ch[0] % 12 + 36 + (12 if (b16 // 2) % 4 == 3 else 0); n(t, 'electric_bass', m, .22, .72, 0, .9)
        if ch and sec == 'A':     # 马林巴十六分固定音型
            tn = tones(*ch, base=67); m = tn[[0, 1, 2, 1][s4]] + (12 if (beat % 2 and s4 == 2) else 0)
            n(t, 'marimba', m, .12, .44 if s4 == 0 else .3, .35, .36)
        if ch and s4 == 2 and bb in (0, 2):   # 颤音琴反拍和弦
            for m in tones(*ch, base=62): n(t, 'vibraphone', m, .35, .36, -.3, .34)
        if ch and sec == 'B':     # 拨弦琶音（pluck.py，闷音吉他）
            tn = tones(*ch, base=55); m = (tn + [tn[0] + 12])[[0, 2, 1, 3][s4]]
            x = P.pluck('acoustic_guitar', m, .16, vel=.62 if s4 == 0 else .5, damp=.7, t60=.6, bright=.75)
            put(plucks, x, t, .5, -.35 + .2 * (s4 % 2))
    elif sec == 'build':   # 加速：16 分 → 32 分军鼓 + 底鼓八分 + 定音鼓重复
        k = (t - BUILD[0]) / (BUILD[1] - BUILD[0])
        if s4 in (0, 2): n(t, KIT, 'kick_drum_left', None, .7 + .2 * k, 0, .9); subpulse(t, 43, .7); cue(t, 'kick')
        n(t, 'snare', 'on', None, .25 + .6 * k, .05, .55)
        if t >= 10.5 - 1e-6: n(t + .0625, 'snare', 'on', None, .3 + .55 * k, .05, .5)
        n(t, KIT, 'hi_hat_closed', None, .3 + .3 * k, .25, .3)
        if s4 == 0: n(t, 'timpani', 43, .4, .45 + .45 * k, 0, .7)
        if s4 in (0, 2): n(t, 'electric_bass', 31, .2, .72, 0, .9)
    elif sec == 'V':   # 半拍感：底鼓 1、3 拍，军鼓第 3 拍
        if s4 == 0 and bb in (0, 2): n(t, KIT, 'kick_drum_left', None, .78, 0, .9); cue(t, 'kick'); subpulse(t, (ch[0] % 12) + 36, .8) if ch else None
        if s4 == 0 and bb == 2 and t > 14.1: n(t, KIT, 'snare_2', None, .5, .05, .5)
        if s4 == 2 and t < 18.0: n(t, KIT, 'hi_hat_closed', None, .35, .25, .3)
        if ch and s4 == 0 and bb in (0, 2) and t < 18.0: n(t, 'electric_bass', ch[0] % 12 + 36, .95, .68, 0, .85)
        if ch and s4 == 0 and bb == 0 and t < 18.0:
            for m in tones(*ch, base=62): n(t, 'vibraphone', m, 1.8, .34, -.3, .34)
        if ch and 15.5 <= t < 18.0 and s4 in (0, 2):
            tn = tones(*ch, base=55); m = (tn + [tn[0] + 12])[(b16 // 2) % 4]
            put(plucks, P.pluck('acoustic_guitar', m, .3, vel=.45, damp=.55, t60=1.2, bright=.6), t, .38, .3)
    t = round(t + S16, 6)

def brass(t, tp, tb, v=.85, horn=None, hd=1.6):
    for m in tp: n(t, 'trumpet_stac', m, .3, v, .2, .55)
    for m in tb: n(t, 'trombone_stac', m, .35, v, -.2, .6)
    for m in (horn or ()): n(t, 'horn', m, hd, .62, 0, .45)
# 第 4 帧钩子：大鼓 + 镲 + C 小调铜管短和弦 + 定音鼓
th = HT['hook']; brass(th, (72, 75, 79), (48, 55), .9); n(th, 'bass_drum', None, None, .9, 0, .8); n(th, KIT, 'crash_left', None, .75, .3, .5); n(th, 'timpani', 43, 1.2, .9, 0, .75); cue(th, 'hook')
# 全律动进入（字幕第一块）
cue(1.0, 'groove'); n(1.0, KIT, 'crash_right', None, .5, -.3, .35)
# “工具”：铜管短刺
brass(4.0, (68, 72, 77), (41, 53), .85); cue(4.0, 'brass')
# 推近到胸口：低音 tom
n(HT['punch'], KIT, 'tom_4', None, .7, -.1, .55); cue(HT['punch'], 'tom')
# “砧板”标签：钢片琴
n(HT['label'], 'glockenspiel', 84, .5, .5, .3, .4); cue(HT['label'], 'glock')
# 停一拍后：吊镲渐强进纸页，7.0 落镲
n(STOP[0] + .02, 'sus_cymbal', 'cresc', .48, .55, .2, .5); n(HT['paper'], KIT, 'crash_left', None, .7, .3, .45); cue(HT['paper'], 'crash')
# 80% 落定：铜管 + 钢片琴
brass(HT['stamp'], (68, 72, 75), (44, 51), .9); n(HT['stamp'], 'glockenspiel', 87, .6, .6, .3, .45); cue(HT['stamp'], 'brass')
# 定格：硬停（无音乐），见下方 gate；11.0 记为 stop
cue(HT['freeze'], 'stop')
# 答案：静默后的第一声——E♭ 大调铜管 + 圆号 + 定音鼓 + 大鼓 + 镲 + 管钟
ta = HT['answer']; brass(ta, (75, 79, 82), (51, 58), .95, horn=(63, 67, 70), hd=2.0)
n(ta, 'timpani', 46, 1.5, 1.0, 0, .9); n(ta, 'bass_drum', None, None, 1.0, 0, .9); n(ta, KIT, 'crash_left', None, .9, .3, .6); n(ta, 'tubular_bells', 75, 3.0, .62, .2, .5); cue(ta, 'answer')
# 钢片琴旋律（母子镜头起）与终止和弦
for i, (dt, m) in enumerate(((15.5, 79), (16.0, 82), (16.5, 80), (17.0, 77), (17.5, 79))): n(dt, 'glockenspiel', m, .45, .48, .3, .36); cue(dt, 'glock')
tf = 18.0; brass(tf, (75, 79, 82), (51, 58), .7, horn=(63, 70), hd=1.5)
for m in (63, 67, 70, 77): n(tf, 'vibraphone', m, 1.5, .42, -.3, .36)
n(tf, 'tubular_bells', 87, 1.5, .45, .2, .4); n(tf, 'contrabass', 39, 1.5, .5, 0, .5); n(tf, 'timpani', 46, 1.4, .6, 0, .6); cue(tf, 'final')

mus = S.render(E, dur=DUR, master=False).astype(np.float32)
mus += plucks; mus += np.stack([sub, sub], 1) * .4
mus = S.room(mus, size=.3, mix=.12)
mus = mus - np.stack([lp(mus[:, c], 110) for c in (0, 1)], 1).astype(np.float32) * .3   # 低频减约 3 dB
mus = np.stack([hp(mus[:, c], 32) for c in (0, 1)], 1).astype(np.float32)
# 合成 riser：停一拍里 + 加速段
def riser(d):
    tt = t_(d); x = noise(d); y = np.zeros_like(x)
    for i in range(8):
        a, b = int(i * len(x) / 8), int((i + 1) * len(x) / 8); f = 500 * 2 ** (i * .55); y[a:b] = bp(x, f, f * 2.2)[a:b]
    return norm(y * (tt / d) ** 2) * .6
put(mus, riser(BUILD[1] - BUILD[0]), BUILD[0], .5, .1)
# 门：停一拍（只留吊镲）与真静默（硬停 12 ms）
g = np.ones(N, np.float32)
i0, i1 = int(SIL[0][0] * SR), int(SIL[0][1] * SR); r = int(.012 * SR); g[i0:i1] = 0; g[i0:i0 + r] = np.linspace(1, 0, r)
mus *= g[:, None]
j0, j1 = int(STOP[0] * SR), int(STOP[1] * SR); gs = np.ones(N, np.float32); gs[j0:j1] = .0; gs[j0:j0 + r] = np.linspace(1, 0, r)
cym = S.render([e for e in E if e[1] == 'sus_cymbal'], dur=DUR, master=False).astype(np.float32)
mus = mus * gs[:, None] + cym * (1 - gs)[:, None]
# 静默尾巴（13.5–14.0）：极轻的反向镲气声，在 14.0 前 12 ms 切断，让答案那一声干净落下
def swell(d):
    tt = t_(d); x = bp(noise(d), 3000, 12000) * .6 + bp(noise(d), 300, 1200) * .4
    return norm(x * (tt / d) ** 3) * .5
sw0, sw1 = MU['swell']; sx_ = swell(sw1 - sw0 - .012); put(mus, sx_, sw0, .16, .05)
fade = np.ones(N, np.float32); f0 = int((DUR - 1.1) * SR); fade[f0:] = np.linspace(1, 0, N - f0) ** 1.4; mus *= fade[:, None]

# ----------------------------------------------------------------- 拟音（由画面事件驱动）
fx = buf()
def tick(p=1.0, v=1.0): return sfx.click(p, v) * .6
def squeak(d):
    tt = t_(d); x = bp(noise(d), 1800, 5200) * (.6 + .4 * np.sin(2 * np.pi * 9 * tt)) * np.minimum(1, tt / .02) * np.minimum(1, (d - tt) / .03 + .01)
    return norm(x) * .5
def paper_s(d=.4): tt = t_(d); return norm(bp(noise(d), 500, 6000) * np.exp(-tt / .1) * (1 + .6 * np.sin(2 * np.pi * 23 * tt))) * .6
def crack():   # 贝壳“咔”：高频碎裂 + 短木质共鸣
    d = .12; tt = t_(d); x = hp(noise(d), 1800) * np.exp(-tt / .01) + .5 * np.sin(2 * np.pi * 1650 * tt) * np.exp(-tt / .02)
    return norm(x)
def shutter(): return norm(np.concatenate([sfx.click(.7, 1), np.zeros(int(.045 * SR)), sfx.click(.55, .8)])) * .8
def keytick(): d = .05; tt = t_(d); return norm(hp(noise(d), 2500) * np.exp(-tt / .006) + .4 * np.sin(2 * np.pi * 1900 * tt) * np.exp(-tt / .01))
for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'slam': put(fx, sfx.click(.8, .7) * .3, t, .5); put(fx, sfx.thump(.6, 90), t, .4)
    elif ty == 'type': put(fx, keytick(), t, .28, .15)
    elif ty == 'wipe': put(fx, sfx.whoosh(.12), t, .22, .2)
    elif ty == 'hook': put(fx, crack(), t, .55, -.1); put(fx, sfx.thump(1.0, 55), t, .8); put(fx, sfx.whoosh(.2), t - .17, .3)
    elif ty == 'tick': put(fx, tick(1.4, .8), t, .35, -.4)
    elif ty == 'punch': put(fx, sfx.whoosh(.25), t - .2, .5); put(fx, sfx.thump(1.0, 50), t, .6)
    elif ty == 'marker': put(fx, squeak(e.get('d', .25)), t, .42, .15)
    elif ty == 'pop': put(fx, sfx.pop(.8), t, .36, .2)
    elif ty == 'whoosh': put(fx, sfx.whoosh(.2), t - .03, .55, .4)
    elif ty == 'paper': put(fx, paper_s(), t, .55, -.1)
    elif ty == 'rattle':
        k = 0
        while k * .045 < e['d'] - 1e-6: put(fx, tick(1.2 + .3 * rng.random(), .6), t + k * .045, .2, rng.uniform(-.3, .3)); k += 1
    elif ty == 'stamp': put(fx, sfx.thump(.9, 80), t, .6); put(fx, sfx.click(.6, .8), t, .3)
    elif ty == 'shutter': put(fx, shutter(), t, .65)
    elif ty == 'brackets': put(fx, tick(1.8, .7), t, .2, -.3); put(fx, tick(1.9, .7), t + .1, .2, .3)
    elif ty == 'answer': put(fx, sfx.thump(1.0, 60), t, .6)
    elif ty == 'pullout': put(fx, sfx.whoosh(.6), t - .1, .25, -.2)
    elif ty == 'cut' and e.get('k') in ('bite', 'raft', 'wean', 'mompup', 'raftout'): put(fx, tick(.7, .5), t, .12)
    elif ty == 'fly': put(fx, sfx.whoosh(.22), t - .02, .3, -.3)                      # 数字块飞走 / 飞回
    elif ty == 'inset': put(fx, sfx.pop(.9), t, .3, .35); put(fx, sfx.whoosh(.18), t - .08, .22, .35)   # 2× 插图弹出
    elif ty == 'nudge': put(fx, tick(1.6, .6), t, .14, .2); put(fx, sfx.whoosh(.15), t, .07, .2); put(fx, sfx.thump(.35, 70), t, .12)  # 屏息里的微推：很轻

# ----------------------------------------------------------------- 自然声：合成水声（拍水 + 小浪），纸面底噪
amb = buf()
def water(d, seed):
    r = np.random.default_rng(seed); m = int(d * SR); x = r.standard_normal(m)
    lo = lp(x, 900) * .6 + bp(x, 900, 3500) * .25
    # 缓慢起伏 + 偶发拍水
    env = np.interp(np.arange(m), np.linspace(0, m, int(d * 6) + 2), .5 + .5 * r.random(int(d * 6) + 2))
    y = lo * env
    for _ in range(int(d * 2.5)):
        s = r.integers(0, max(1, m - 9000)); L = int(SR * r.uniform(.06, .14)); tt = np.arange(L) / SR
        y[s:s + L] += bp(r.standard_normal(L), 400, 2500) * np.exp(-tt / .03) * r.uniform(.8, 1.6)
    return (y / (np.sqrt(np.mean(y ** 2)) + 1e-9) * .05).astype(np.float32)
def bed(at, d, gn, seed, fi=.15, fo=.25):
    x = water(d, seed); tt = np.arange(len(x)) / SR; x *= np.minimum(1, tt / fi) * np.minimum(1, (d - tt) / fo)
    put(amb, x, at, gn, -.1); put(amb, water(d, seed + 1) * np.minimum(1, tt / fi) * np.minimum(1, (d - tt) / fo), at, gn * .7, .5)
bed(0.0, 4.0, .35, 1)                         # 钩子 → 视频：轻水声
bed(MU['jcut'][0], SIL[0][1] - MU['jcut'][0] + .15, .3, 5)   # 定格：J-cut 0.3 s 提前进，静默里唯一的声音
bed(15.5, 2.0, .3, 9)                          # 母子
bed(MU['jcut'][1], DUR - MU['jcut'][1], .45, 13, .25, 1.0)   # 结尾：J-cut 进，漂走
room = (lp(brown(3.5), 400) * .02).astype(np.float32)
put(amb, room, 7.0, .5); put(amb, room[:int(1.5 * SR)], 14.0, .5)

# ----------------------------------------------------------------- 混音
mus_r = np.sqrt(np.mean(mus[np.abs(mus[:, 0]) > 1e-4] ** 2)) + 1e-9; mus *= .07 / mus_r
mix = mus + fx * .55 + amb
mix = np.stack([sfx.limit(sfx.compress(mix[:, c], thr=.22, ratio=2.5), .58) for c in (0, 1)], 1)
os.makedirs(os.path.join(D, 'out'), exist_ok=True); os.makedirs(os.path.join(H, 'stems'), exist_ok=True)
sf.write(os.path.join(D, 'out', 'mix.wav'), mix.astype(np.float32), SR)
for nm, x in (('music', mus), ('fx', fx * .55), ('amb', amb)): sf.write(os.path.join(H, 'stems', nm + '.wav'), x.astype(np.float32), SR)
json.dump(sorted(CUES, key=lambda c: c['t']), open(os.path.join(D, 'out', 'cues.json'), 'w'), ensure_ascii=False, indent=0)
# 低频平衡：20–120 Hz 相对其余频段
def band(x, lo, hi): return 10 * np.log10(np.mean(bp(x, lo, hi) ** 2) + 1e-12)
m0 = mix[:, 0]; print('mix', DUR, 's  peak %.3f' % np.abs(mix).max(), ' events', len(E), ' low(20-120) vs mid(120-4k): %.1f dB' % (band(m0, 20, 120) - band(m0, 120, 4000)))
print(S.credits(sorted({e[1] for e in E})))
