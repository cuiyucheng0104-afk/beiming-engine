"""《零点密码》原创配乐 + 拟音 + 混音 → out/mix.wav
60 年代间谍大乐队：D 小调，130.909 BPM（每拍 11 帧）。铜管齐奏重音 = 剪切点；冲浪吉他低音弦 + 自制弹簧混响；
走步低音提琴；邦戈 / 沙锤 / 踩镲；颤音琴动机；长笛、弱音小号点缀；片名 = 铜管长音 Dm6/9。
原创动机「D–F–E | A」（长–短–短–落），不碰最著名间谍主题的半音爬行和小大九和弦。
运行：$LIB/.venv/bin/python mix.py   （读 events.json，写 out/mix.wav、out/stems/、out/cues.json）
"""
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve
from core.audio import sampler as S
from core.audio.sfx import SR, t_, env_exp, bp, lp, hp, add, limit, whoosh as sfx_whoosh

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out'); os.makedirs(os.path.join(OUT, 'stems'), exist_ok=True)
S.seed(17); RNG = np.random.default_rng(17)
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
EV = EVJ['ev']; DUR = EVJ['dur']
BEAT = 11 / 24
def B(b): return b * BEAT
HIT = {e['name']: e['t'] for e in EV if e['type'] == 'hit'}
N = int((DUR + .05) * SR)
bus = {k: np.zeros((N, 2), np.float32) for k in ['stab', 'brass', 'guitar', 'bass', 'drums', 'perc', 'keys', 'fol', 'amb']}
REC = None   # 打点对齐：组内的声音先记下来，量出合成起音（包络半高点）再整体平移，让「听到的那一下」正好落在帧上
def half_rise(x):
    e = np.convolve(np.abs(x), np.ones(48) / 48, 'same')[:int(.15 * SR)]
    return np.argmax(e > e.max() * .5) / SR if e.max() > 0 else 0.0
def put(b, x, t, g=1.0, pan=0.0, align=True):
    if REC is not None: REC.append((b, x, t, g, pan)); return
    if align and b not in ('fol', 'amb'): t -= half_rise(x)   # 每个乐音都按「听到的那一下」落在拍上
    add(bus[b], x, t, g, pan)
CUES = []   # 每个音乐重音：名字、拍、时间（给 cuecheck）
STARTS = {}  # 每个打点组实际第一个采样的时间（片名前近静默要在它之前重新打开）
class HG:
    def __init__(self, t, name=None): self.t, self.name = t, name
    def __enter__(self):
        global REC; REC = []; return self
    def __exit__(self, *a):
        global REC; parts, REC = REC, None
        t0 = min(p[2] for p in parts); L = int((max(p[2] + len(p[1]) / SR for p in parts) - t0) * SR) + 10
        m = np.zeros(L)
        for b, x, t, g, pan in parts: i = int((t - t0) * SR); m[i:i + len(x)] += np.abs(x) * g
        env = np.convolve(m, np.ones(48) / 48, 'same'); pk = env[:int(.15 * SR)].max()
        k = np.argmax(env > pk * .5); shift = (t0 + k / SR) - self.t      # 半高点相对标称拍点
        for b, x, t, g, pan in parts: add(bus[b], x, t - shift, g, pan)
        if self.name: STARTS[self.name] = t0 - shift
        if self.name: CUES.append({'name': self.name, 't': round(self.t, 6)})

# ─────────── 铜管 ───────────
CH = {   # (长号/低音, 小号) —— 全部 D 小调家族，避开小大九
    'Dm9':   (['D2', 'D3', 'A3', 'F3'], ['A4', 'D5', 'E5', 'F5']),
    'Bb7':   (['A#1', 'A#2', 'G#3', 'D3'], ['D5', 'E5', 'G#5']),
    'A7b9':  (['A1', 'A2', 'G3', 'C#3'], ['A#4', 'C#5', 'E5', 'G5']),
    'Gm6':   (['G1', 'G2', 'D3', 'A#3'], ['E5', 'G5', 'A#4']),
    'Dm69':  (['D2', 'A2', 'F3', 'D3'], ['B4', 'E5', 'F5', 'A5']),
    'Ebmaj': (['D#2', 'D#3', 'A#3', 'G3'], ['A#4', 'D5', 'G5']),
}
PRE = 0.0   # 不再手调提前量：HG 实测对齐
def stab(t, ch, vel=.9, crash=True, name=None, dur=.17, g=1.0):
    with HG(t, name): _stab(t, ch, vel, crash, dur, g)
def _stab(t, ch, vel, crash, dur, g):
    tb, tp = CH[ch]
    for i, p in enumerate(tb): put('stab', S.note('trombone_stac', p, dur, vel, release=.07), t - PRE, .55 * g, -.35 + i * .1)
    for i, p in enumerate(tp): put('stab', S.note('trumpet_stac', p, dur, vel, release=.07), t - PRE, .5 * g, .08 + i * .1)
    put('stab', S.note('horn_stac', tb[2], dur, vel, release=.07), t - PRE, .35 * g, -.1)
    if crash: put('drums', S.hit('clash', 'crash', vel * .9), t, .42 * g, .3)
    put('drums', S.hit('bass_drum', None, vel * .85), t, .55 * g, 0)

def long_chord(t, ch, dur, vel=.8, rel=1.1, g=.5):
    tb, tp = CH[ch]
    for i, p in enumerate(tb): put('brass', S.note('trombone', p, dur, vel, release=rel), t - PRE, g * .9, -.4 + i * .1)
    for i, p in enumerate(tp): put('brass', S.note('trumpet', p, dur, vel, release=rel), t - PRE, g * .75, .05 + i * .1)
    for p in ['D4', 'A4']: put('brass', S.note('horn', p, dur, vel * .9, release=rel), t - PRE, g * .7, -.15)
    put('brass', S.note('tuba', 'D2', dur, vel, release=rel), t - PRE, g * .8, 0)

def mel(inst, notes, t0, g=.5, pan=0, vel=.75, bus_='brass', legato=.9):
    x = t0
    for p, bt in notes:
        if p: put(bus_, S.note(inst, p, bt * BEAT * legato, vel, release=.12), x, g, pan)
        x += bt * BEAT

# ─────────── 冲浪吉他 + 弹簧混响 ───────────
def spring_ir(dur=2.0):
    n = int(dur * SR); ir = np.zeros(n, np.float32)
    L = int(.03 * SR); tt = np.arange(L) / SR
    f = 3600 * np.exp(-tt / .011) + 170
    ch = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / .017)
    per = int(.037 * SR); k = 0; pos = int(.01 * SR)
    while pos + L < n and k < 60:
        seg = ch * (.7 ** k)
        if k: seg = np.convolve(seg, np.ones(1 + k // 3) / (1 + k // 3), 'same')
        ir[pos:pos + L] += seg * (1 if k % 2 == 0 else -.8); pos += per + (k % 3) * 29; k += 1
    ir += (RNG.standard_normal(n) * np.exp(-np.arange(n) / SR / .5) * .07).astype(np.float32)
    ir = sosfilt(butter(2, [160, 4200], 'band', fs=SR, output='sos'), ir).astype(np.float32)
    return ir / (np.sqrt(np.sum(ir ** 2)) + 1e-9)
def trem(x, hz=7.0, depth=.6, start=.12):
    tt = np.arange(len(x)) / SR; e = 1 - depth * (.5 + .5 * np.sin(2 * np.pi * hz * np.maximum(0, tt - start))); e[tt < start] = 1
    return (x * e).astype(np.float32)
def gtr(t, p, dur=.5, vel=.85, g=.6, pan=-.2, tremolo=False, slide=None):
    x = S.note('electric_guitar', p, dur, vel, release=.2)
    if slide is not None:
        n0 = int(.05 * SR); tail = x[n0:]
        r = np.linspace(1, 2 ** (slide / 12), len(tail)); idx = np.cumsum(r); idx = idx[idx < len(tail) - 1]
        x = np.concatenate([x[:n0], np.interp(idx, np.arange(len(tail)), tail).astype(np.float32)])
    if tremolo: x = trem(x)
    put('guitar', x, t, g, pan)
    return t - half_rise(x)

# ─────────── 鼓与手鼓 ───────────
def bongo(t, hi=True, v=.7, g=.45, pan=.35):
    put('perc', S.hit('world_perc', 'bongo_high' if hi else 'bongo_low_high_velocity', v), t, g, pan if hi else pan - .15)
def shaker(t, v=.4, g=.25): put('perc', S.hit('world_perc', 'egg_shaker_fast', v), t, g, -.35)
def hat(t, v=.4, g=.22, open_=False): put('drums', S.hit('hihat', 'open' if open_ else 'closed', v), t, g, .4)
def snare(t, v=.5, g=.35, var='stick'): put('drums', S.hit('snare2', var, v), t, g, -.1)

def bass(t, p, bt=1.0, v=.8, g=.85): put('bass', S.note('jazz_bass', p, bt * BEAT * .9, v, release=.08), t, g, 0)

# ═════════════ 乐谱（按拍）═════════════
# A 坠入 0–7
stab(B(0), 'Dm9', .95, name='open', g=1.1)
gtr(B(0), 'D2', 1.8, .95, .75, tremolo=True)
for b, p in zip(range(0, 8), ['D2', 'F2', 'A2', 'C3', 'A#1', 'D2', 'A1', 'C#2']):
    if b > 0: bass(B(b), p)
for k in range(2, 14):   # 邦戈 8 分（第 1 拍起）
    bongo(B(k * .5), hi=(k % 2 == 1), v=.55 + .2 * (k % 4 == 2))
    shaker(B(k * .5) + .002)
for b in (1, 3, 5): snare(B(b), .35, .3, 'taps')
for b, ch in ((2, 'Dm9'), (4, 'Bb7'), (6, 'A7b9')):   # 着地 = 长号短音 + 低邦戈
    tb, _ = CH[ch]
    with HG(B(b), {2: 'land1', 4: 'land2', 6: 'land3'}[b]):
        for p in tb[:2]: put('stab', S.note('trombone_stac', p, .14, .8, release=.06), B(b), .45, -.3)
        bongo(B(b), hi=False, v=.9, g=.6)
with HG(B(1), 'credit'): put('stab', S.note('trumpet_stac', 'D5', .12, .75, release=.05), B(1), .35, .2); put('perc', S.hit('world_perc', 'claves', .7), B(1), .3, .3)
gtr(B(4), 'A#1', .9, .8, .5, slide=-2); gtr(B(6), 'A1', .8, .8, .5)
# B 窥镜 / 档案 7–16
stab(B(7), 'Gm6', .9, name='lens')
with HG(B(8), 'turn'): gtr(B(8), 'E2', 1.6, .9, .7, slide=-2); put('perc', S.hit('world_perc', 'bongo_muted', .7), B(8), .4, .3)
stab(B(9), 'Dm9', .92, name='match')
stab(B(10), 'Bb7', .85, crash=False, name='role', g=.85)
for b, p in zip(range(9, 16), ['D2', 'A#1', 'F2', 'A2', 'G#2', 'A2', 'A#2']): bass(B(b), p, v=.72)
MOT = [('D5', 1.5), ('F5', .5), ('E5', .5), ('A4', 1.5)]
mel('vibraphone_hard', MOT, B(11), g=.5, pan=.25, vel=.7, bus_='keys', legato=1.1)
for k in range(22, 30): shaker(B(k * .5), .35, .22)
for b in (11, 12, 13, 14): hat(B(b) + BEAT * .5, .35, .18)
with HG(B(12), 'peek'): put('keys', S.note('flute_stac', 'A5', .2, .7, release=.1), B(12), .4, .4)
with HG(B(13), 'rival'): put('brass', S.note('trumpet_mute', 'G#4', .12, .8, release=.05), B(13), .5, -.4)
put('brass', S.note('trumpet_mute', 'G4', .3, .75, release=.1), B(13.5), .45, -.4)
with HG(B(14), 'dive'): put('stab', S.note('trombone_stac', 'A2', .14, .85, release=.06), B(14), .5, -.2); bongo(B(14), False, .9, .55)
roll = S.hit('snare2', 'roll', .7)
rl = roll[:int(BEAT * 1.0 * SR)] * np.linspace(.15, 1, int(BEAT * 1.0 * SR)) if len(roll) >= int(BEAT * SR) else roll
put('drums', rl, B(15), .55, -.1, align=False); CUES.append({'name': 'push', 't': round(B(15), 6)})
put('stab', S.note('trombone', 'A2', BEAT * .9, .7, release=.05), B(15), .25, -.3)
# C 追逐 16–24（加速）
stab(B(16), 'Dm9', .95, name='chase')
RIFF = ['D2', 'D2', 'A2', 'D2', 'C3', 'D2', 'A#2', 'A2']
for k in range(16):   # 吉他 8 分 riff（b16–23）
    t = B(16 + k * .5); gtr(t, RIFF[k % 8], BEAT * .45, .8 + .1 * (k % 2 == 0), .5, pan=-.25)
for b in range(16, 20):   # 走步贝斯：四分
    bass(B(b), ['D2', 'F2', 'G2', 'G#2'][b - 16])
for k in range(8):        # b20–23：八分（加速）
    bass(B(20 + k * .5), ['A2', 'A#2', 'A2', 'G2', 'F2', 'E2', 'C#2', 'E2'][k], .5, .8)
for k in range(8): hat(B(16 + k * .5), .4 + .15 * (k % 2 == 0), .2); bongo(B(16 + k * .5) + BEAT * .25, k % 2 == 0, .55, .38)
for k in range(28): hat(B(20 + k * .25), .45 if k % 2 == 0 else .3, .2); bongo(B(20 + k * .25), k % 4 != 0, .5 + .25 * (k % 4 == 0), .42)
for b in (17, 19, 21, 23): snare(B(b), .55, .35)
mel('trumpet', [('D5', 1.5), ('F5', .5), ('E5', .5), ('A4', 1.5)], B(16), g=.42, pan=.2, vel=.78)   # 动机上铜管
stab(B(20), 'Bb7', .9, name='sw1'); stab(B(22), 'A7b9', .92, name='sw2'); stab(B(23), 'A7b9', .95, crash=False, name='sw3')
# 定格 24：最强一刀，0.12 s 后真静音（含混响尾）
stab(B(24), 'Dm9', 1.0, name='freeze', g=1.15)
FREEZE0, FREEZE1 = B(24) + .12, B(26)
CUES.append({'name': 'blink', 't': round(B(25), 6)})   # 眨眼 = 磁带咔（拟音）
# 恢复 26：邦戈花 + 贝斯 + 长号滑落（对手栽进缺口）
for k in range(1, 4): bongo(B(26) + k * BEAT / 4, k % 2 == 0, .8, .5)
with HG(B(26), 'resume'): bass(B(26), 'D2', 1, .9); put('stab', S.note('trombone_stac', 'D3', .14, .9, release=.06), B(26), .5, -.2); put('stab', S.hit('bass_drum', None, .8), B(26), .5, 0)
fall = S.note('trombone', 'A2', BEAT * .8, .75, release=.1); n0 = int(.04 * SR); tail = fall[n0:]
r = np.linspace(1, 2 ** (-7 / 12), len(tail)); idx = np.cumsum(r); idx = idx[idx < len(tail) - 1]
put('brass', np.concatenate([fall[:n0], np.interp(idx, np.arange(len(tail)), tail).astype(np.float32)]), B(26.4), .4, -.3)
# D 转盘 27–33（减速，逐渐抽空）
with HG(B(27), 'safe'): put('perc', S.hit('timpani', 'drum1', .85), B(27), .6, 0); put('stab', S.hit('bass_drum', None, .7), B(27), .45, 0)
put('brass', S.note('trombone', 'D2', B(4) - .1, .5, release=.2), B(27), .3, -.3)
for b in (27, 28, 29, 30): bass(B(b), 'D2' if b % 2 else 'A1', 1, .6, .7)
for b, p in ((28, 'A4'), (29, 'F4')):
    with HG(B(b), {28: 'click1', 29: 'click2'}[b]): put('keys', S.note('vibraphone_hard', p, BEAT * 1.6, .7, release=.6), B(b), .55, .25)
# 第 31 拍最后一咔：颤音琴、拨弦都短促收住（release ≤ 0.15 s），给片名前的近静默腾地方
with HG(B(31), 'click3'): put('keys', S.note('vibraphone_hard', 'D4', .22, .7, release=.12), B(31), .55, .25)
with HG(B(31)): put('bass', S.note('contrabass_pizz', 'D2', .22, .85, release=.12), B(31), .7, 0)
# E 片名 33：静默后第一声 —— 铜管长音 Dm6/9
with HG(B(33), 'door'):
    long_chord(B(33), 'Dm69', B(4), .88, 1.2, .62); _stab(B(33), 'Dm69', .95, True, .17, .9)
    put('perc', S.hit('gong', None, .7), B(33), .35, -.2); put('perc', S.hit('timpani', 'drum1', .95), B(33), .6, 0)
STARTS['doorGtr'] = gtr(B(33), 'D2', B(4), .95, .55, tremolo=True)
with HG(B(34), 'title'): put('perc', S.hit('timpani', 'drum1', .8), B(34), .5, 0); put('perc', S.hit('clash', 'short', .6), B(34), .25, .3)
for b, p in zip(range(37, 41), ['D2', 'F2', 'G2', 'A2']): bass(B(b), p, 1, .7)
for k in range(8): bongo(B(37 + k * .5), k % 2 == 1, .5, .35); shaker(B(37 + k * .5), .3, .18)
mel('vibraphone_hard', MOT, B(37), g=.4, pan=.25, vel=.65, bus_='keys', legato=1.0)
with HG(B(38), 'rivalIn'): put('stab', S.note('trombone_stac', 'D3', .12, .8, release=.05), B(38), .4, -.3)
sk = S.note('trombone', 'A3', BEAT * .9, .8, release=.1); n0 = int(.03 * SR); tail = sk[n0:]   # 急停：长号「哇」下滑
r = np.linspace(1, 2 ** (-5 / 12), len(tail)); idx = np.cumsum(r); idx = idx[idx < len(tail) - 1]
with HG(B(40), 'skid'): put('brass', np.concatenate([sk[:n0], np.interp(idx, np.arange(len(tail)), tail).astype(np.float32)]), B(40), .45, -.2)
# 收尾 41：短促高音小号 + 贝斯低 D + 邦戈；42：木鱼一声（帽子扣上），然后只剩混响
stab(B(41), 'Dm69', .9, crash=False, name='button', g=.85)
with HG(B(41)): bass(B(41), 'D2', 1.2, .9); bongo(B(41), False, .9, .5)
with HG(B(42), 'hatLand'): put('perc', S.hit('woodblock', 'a', .85), B(42), .55, -.1); bongo(B(42), True, .7, .35)

# ═════════════ 拟音（events.json 驱动）═════════════
def nz(d): return RNG.standard_normal(int(round(d * SR)))
def n1(x, p=1.0): m = np.abs(x).max(); return x * p / m if m > 0 else x
def env_ad(d, a, tau): tt = t_(d); return np.minimum(1, tt / max(a, 1e-4)) * np.exp(-np.maximum(0, tt - a) / tau)
def paper_cut(): d = .26; return n1(bp(nz(d), 2500, 9000) * env_ad(d, .12, .05)) * .6
def card_slide(): d = .22; return n1(bp(nz(d), 1200, 6000) * env_ad(d, .15, .04)) * .5
def card_slap():
    d = .14; tt = t_(d); return n1(np.sin(2 * np.pi * 95 * tt) * env_exp(d, .025) * .9 + bp(nz(d), 700, 4500) * env_exp(d, .012) * 1.1) * .8
def card_pop(): d = .12; tt = t_(d); f = 600 + 1800 * tt / d; return n1(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .03) * .5 + bp(nz(d), 2000, 7000) * env_exp(d, .01)) * .55
def step(): d = .08; tt = t_(d); return n1(bp(nz(d), 300, 3000) * env_exp(d, .012) + np.sin(2 * np.pi * 120 * tt) * env_exp(d, .015) * .6) * .45
def land(): x = card_slap(); y = np.zeros_like(x); s = step(); y[:len(s)] += s; return n1(x + y * .5) * .75
def tumble(): d = .5; return n1(bp(nz(d), 200, 2400) * np.sin(np.pi * t_(d) / d) ** 2) * .45
def cloth(): d = .3; return n1(bp(nz(d), 400, 3500) * env_ad(d, .08, .08)) * .35
def swish(): d = .22; return n1(bp(nz(d), 800, 5000) * np.sin(np.pi * t_(d) / d) ** 2) * .4
def whoosh(d=.4): return n1(bp(nz(d), 300, 4500) * np.sin(np.pi * t_(d) / d) ** 1.6) * .6
def paper_slide(): d = .3; return n1(bp(nz(d), 900, 7000) * env_ad(d, .03, .1)) * .6
def tape_click():
    d = .05; tt = t_(d); return n1(hp(nz(d), 1500) * env_exp(d, .002) + np.sin(2 * np.pi * 1800 * tt) * env_exp(d, .004) * .4) * .5
def padto(x, n): return np.pad(x, (0, max(0, n - len(x))))[:n]
def thump(d=.35, f=60): tt = t_(d); return n1(np.sin(2 * np.pi * f * tt * (1 - .3 * tt)) * env_exp(d, .07) + lp(nz(d), 300) * env_exp(d, .02) * .5)
def metal(d, parts, tau, noise=.6):
    tt = t_(d); x = sum(a * np.sin(2 * np.pi * f * tt + RNG.random() * 6) * env_exp(d, ta) for f, a, ta in parts)
    return n1(x + hp(nz(d), 3000) * env_exp(d, tau) * noise)
def tick(): return metal(.05, [(3100, .6, .01), (5200, .4, .006), (1900, .3, .012)], .002) * .4
def dial_stop(): return n1(metal(.18, [(1500, .7, .04), (2700, .5, .03), (420, .5, .05)], .006) + padto(thump(.18, 110), int(round(.18 * SR))) * .5) * .8
def dial_final(): return n1(metal(.5, [(820, .8, .12), (1650, .6, .08), (260, .7, .14), (3300, .3, .04)], .01) + padto(thump(.4, 70), int(round(.5 * SR))) * .8) * .95
def door_open():
    d = 1.0; tt = t_(d); f0 = 90 + 30 * np.sin(2 * np.pi * 1.3 * tt)
    creak = bp(2 * ((np.cumsum(f0) / SR) % 1) - 1, 300, 2500) * (np.abs(np.sin(2 * np.pi * 17 * tt)) ** 3) * np.exp(-tt / .35)
    latch = np.zeros_like(tt); m = metal(.25, [(700, .8, .06), (1400, .5, .05)], .01); latch[:len(m)] += m
    return n1(creak * .6 + latch + lp(nz(d), 200) * np.exp(-tt / .25) * .6) * .8
def strip_slide(): d = .6; return n1(bp(nz(d), 700, 6000) * env_ad(d, .05, .25) * (1 + .5 * np.sin(2 * np.pi * 21 * t_(d)))) * .55
def skid(): d = .4; return n1(bp(nz(d), 1200, 5000) * env_ad(d, .03, .15) + np.sin(2 * np.pi * (1400 - 600 * t_(d)) * t_(d)) * env_ad(d, .02, .12) * .3) * .5
def hat_pop(): d = .16; tt = t_(d); f = 300 + 900 * tt / d; return n1(np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .05)) * .55
def hat_land(): d = .1; tt = t_(d); return n1(np.sin(2 * np.pi * 330 * tt) * env_exp(d, .02) + bp(nz(d), 500, 3000) * env_exp(d, .008)) * .4

FOL = {
    'paperCut': lambda e: paper_cut(), 'cardSlide': lambda e: card_slide(), 'cardSlap': lambda e: card_slap(), 'cardPop': lambda e: card_pop(),
    'tumble': lambda e: tumble(), 'land': lambda e: land(), 'swish': lambda e: swish(), 'paperSlap': lambda e: n1(card_slap() * .7 + paper_cut()[:len(card_slap())] * .5) * .9,
    'cloth': lambda e: cloth(), 'step': lambda e: step(), 'whoosh': lambda e: whoosh(e.get('d', .4)), 'paperSlide': lambda e: paper_slide(),
    'skidS': lambda e: skid() * .6, 'tapeClick': lambda e: tape_click(), 'fallThump': lambda e: thump(.4, 55) * .7, 'landHeavy': lambda e: n1(card_slap() + thump(.14, 70)[:len(card_slap())]) * .9,
    'tick': lambda e: tick(), 'dialStop': lambda e: dial_stop(), 'dialFinal': lambda e: dial_final(), 'doorOpen': lambda e: door_open(),
    'stripSlide': lambda e: strip_slide(), 'titleSlap': lambda e: n1(card_slap() * 1.2 + thump(.14, 80)[:len(card_slap())] * .5), 'skid': lambda e: skid(),
    'hatPop': lambda e: hat_pop(), 'hatLand': lambda e: hat_land(),
}
GAIN = {'tick': .55, 'step': .55, 'paperCut': .5, 'cardSlide': .5, 'whoosh': .55, 'land': .8, 'dialFinal': 1.0, 'doorOpen': .8}
for e in EV:
    if e['type'] == 'hit' or e['type'] not in FOL: continue
    if e['t'] < 0: continue
    put('fol', FOL[e['type']](e).astype(np.float32), e['t'], e.get('g', 1.0) * GAIN.get(e['type'], .7), e.get('pan', 0))
# 环境床：纸面 / 磁带底噪（定格段真零）
hiss = hp(RNG.standard_normal(N), 2500) * .004
put('amb', hiss, 0, 1, -.3); put('amb', np.roll(hiss, 4321), 0, 1, .3)
wind = lp(np.cumsum(RNG.standard_normal(int(B(8) * SR))) * .002, 600); wind -= np.linspace(wind[0], wind[-1], len(wind))
wind = n1(hp(wind, 60)) * np.sin(np.pi * np.arange(len(wind)) / len(wind)) ** 2 * .05
put('amb', wind, B(16), 1, .2)

# ═════════════ 混音 ═════════════
def room(x, size=.35, mix=.18): return S.room(x, size=size, mix=mix)
stems = {
    'stab': room(bus['stab'], .3, .14) * 1.0,
    'brass': room(bus['brass'], .45, .2) * .95,
    'guitar': None, 'bass': bus['bass'] * .68, 'drums': room(bus['drums'], .25, .1) * .8,
    'perc': room(bus['perc'], .2, .1) * .8, 'keys': room(bus['keys'], .4, .2) * .9,
    'fol': bus['fol'] * 1.0, 'amb': bus['amb'],
}
ir = spring_ir()
gw = np.stack([fftconvolve(bus['guitar'][:, c], ir)[:N] for c in range(2)], 1).astype(np.float32)
stems['guitar'] = bus['guitar'] * .85 + gw * .35
# 低频平衡：贝斯加 2、3 次谐波，在小喇叭上也听得见
stems['bass'] = stems['bass'] + np.tanh(stems['bass'] * 3) * .15
mus = sum(stems[k] for k in ['stab', 'brass', 'guitar', 'bass', 'drums', 'perc', 'keys'])
# 片名前近静默：第 31 拍最后一咔之后 0.2 s，所有乐器与拟音 20 ms 收掉，只剩压低的磁带底噪；
# 在第 33 拍长音组的第一个采样前 3 ms 重新打开（长音 = 静默后第一声，全片最重要的声音）
tt = np.arange(N) / SR
G0, G1 = B(31) + .2, min(STARTS['door'], STARTS['doorGtr']) - .003
g2 = np.ones(N, np.float32); g2[(tt >= G0) & (tt < G1)] = 0
r20 = int(.02 * SR); i0 = int(G0 * SR); g2[i0 - r20:i0] = np.linspace(1, 0, r20)
r3 = int(.003 * SR); i1 = int(G1 * SR); g2[i1:i1 + r3] = np.linspace(0, 1, r3)
ga = (.25 + .75 * g2).astype(np.float32)
mix = (mus + stems['fol']) * g2[:, None] + stems['amb'] * ga[:, None]
stems['music'] = mus
# 定格：真静音（含混响尾）；眨眼的磁带咔单独放回
tt = np.arange(N) / SR
gate = np.ones(N, np.float32)
f0, f1 = FREEZE0, FREEZE1
gate[(tt >= f0) & (tt < f1)] = 0
ramp = int(.004 * SR); i0 = int(f0 * SR); gate[i0 - ramp:i0] = np.linspace(1, 0, ramp)
mix *= gate[:, None]
blink = [e for e in EV if e['type'] == 'tapeClick']
for e in blink: add(mix, tape_click().astype(np.float32), e['t'], .25, 0)
# D→E 近静默：第 31 拍最后一咔之后到第 33 拍，音乐自然收住，只留底噪（上面已排好）
for k in stems: sf.write(os.path.join(OUT, 'stems', k + '.wav'), np.clip(stems[k], -1, 1), SR, subtype='FLOAT')
# 母带前：轻压 + 限幅（给 loudnorm 留空间）
pk = np.abs(mix).max(); mix = mix / pk * .95
mix = np.stack([limit(mix[:, c] * 2.6, .72) for c in range(2)], 1)
sf.write(os.path.join(OUT, 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
json.dump({'beat': BEAT, 'cues': CUES, 'freeze': [f0, f1], 'hush': [G0, G1]}, open(os.path.join(OUT, 'cues.json'), 'w'), ensure_ascii=False, indent=1)
print('mix', mix.shape[0] / SR, 's  cues', len(CUES))
