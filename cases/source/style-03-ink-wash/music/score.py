"""《鹤出留白》原创配乐。D 羽调（D F G A C），古琴主奏（pluck.py：散音 / 按音滑音 / 吟猱 / 泛音 / 扫弦），
箫（numpy 合成气声管 + VSCO 长笛低音区采样叠层），木鱼（VCSL woodblock / VSCO log_drum lo），大鼓 gran_cassa、定音鼓 timpani、手鼓 frame_drum、锣 gong / gong2。
所有时间来自 timeline.json（由 timeline.js 导出），拍点即整数帧。
用法：$LIB/.venv/bin/python music/score.py <工程目录>   → music/score.wav、music/stems/*.wav、music/score.json（落拍记录）"""
import sys, os, json
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add

HERE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS, BEATF, ENDF = TL['fps'], TL['beatf'], TL['endf']
DUR = ENDF / FPS
N = int(round(DUR * SR)) + SR * 2          # 留出尾音，混音时截断
S.seed(3); rng = np.random.default_rng(5)


def bf(k):
    i = int(np.floor(k)); f = k - i
    if i >= len(BEATF) - 1: a = BEATF[-1]; return round(a + f * (ENDF - a))
    return round(BEATF[i] + f * (BEATF[i + 1] - BEATF[i]))


def bt(k): return bf(k) / FPS


st = {k: np.zeros((N, 2), np.float32) for k in ('guqin', 'xiao', 'perc', 'low', 'cry')}
marks = []
def mark(name, beat): marks.append({'name': name, 'beat': beat, 't': bt(beat)})


def G(beat, pitch, dur=None, vel=.7, pan=0., gain=1., dt=0., name=None, **kw):
    t = bt(beat) + dt
    add(st['guqin'], P.pluck('guqin', pitch, dur, vel, **kw).astype(np.float32), t, gain, pan)
    if name: mark(name, beat)


def H(beat, pitch, vel=.55, pan=0., gain=1., dur=1.4, name=None, **kw):
    G(beat, pitch, dur, vel, pan, gain, harmonic=True, name=name, **kw)


def sweep(beat, pitches, vel=.8, spread=.022, gain=1., pan=0., name=None, dur=3.0):
    for i, p in enumerate(pitches):
        add(st['guqin'], P.pluck('guqin', p, dur, vel * (.85 + .15 * (i % 2)), ).astype(np.float32), bt(beat) + i * spread, gain, pan + (i / len(pitches) - .5) * .4)
    if name: mark(name, beat)


def hz(m): return 440. * 2 ** ((m - 69) / 12)


def xiao_syn(curve, vel=.5, breath=.5):
    """合成箫：音高曲线（每样本 MIDI）→ 1/2/3/4 次谐波 + 跟随包络的带通气声 + 起音的"啾"。返回单声道（包络外部给）"""
    n = len(curve); f = hz(curve); ph = 2 * np.pi * np.cumsum(f) / SR
    tone = np.sin(ph) + .32 * np.sin(2 * ph + .3) + .16 * np.sin(3 * ph + 1.1) + .05 * np.sin(4 * ph)
    nz = rng.standard_normal(n)
    fc = float(np.median(f))
    air = sosfilt(butter(2, [max(200, fc * .8), min(fc * 3.2, 9000)], 'band', fs=SR, output='sos'), nz)
    hiss = sosfilt(butter(2, [1800, 6500], 'band', fs=SR, output='sos'), nz) * .35
    y = tone * .55 + air * 1.6 * breath + hiss * breath
    return sosfilt(butter(2, 5200, 'low', fs=SR, output='sos'), y) * vel


def env(n, a, r, hold_shape=None):
    e = np.ones(n); na, nr = int(a * SR), int(r * SR)
    if na: e[:na] = np.linspace(0, 1, na) ** 1.6
    if nr: e[-nr:] *= np.linspace(1, 0, nr) ** 1.4
    return e


def xiao(beat, pitch, dur, vel=.5, pan=-.18, gain=1., att=.45, rel=.6, vib=(4.8, .16, .5), sample=True, dt=0., cresc=0.):
    """箫长音：合成气声管 + 长笛低音区采样（暗化）叠层"""
    n = int((dur + rel) * SR); tt = np.arange(n) / SR
    m = S.midi(pitch) + np.where(tt > vib[2], vib[1] * np.sin(2 * np.pi * vib[0] * (tt - vib[2])) * np.minimum(1, (tt - vib[2]) / .6), 0)
    y = xiao_syn(m, 1., .55) * env(n, att, rel)
    if cresc: y *= np.linspace(1 - cresc, 1, n)
    if sample:
        x = S.note('flute', pitch, dur, min(.9, vel + .1), release=rel, attack=att).astype(np.float64)
        x = sosfilt(butter(2, 2400, 'low', fs=SR, output='sos'), x)
        L = min(len(x), n); y[:L] += x[:L] * 1.4 * (np.linspace(1 - cresc, 1, n)[:L] if cresc else 1)
    add(st['xiao'], (y * vel).astype(np.float32), bt(beat) + dt, gain, pan)


def D(beat, inst, var=None, vel=.8, gain=1., pan=0., dur=None, dt=0., name=None, stem='perc'):
    x = S.hit(inst, var, vel, dur).astype(np.float32)
    add(st[stem], x, bt(beat) + dt, gain, pan)
    if name: mark(name, beat)


def Nn(beat, inst, pitch, dur, vel=.8, gain=1., pan=0., name=None, stem='perc'):
    x = S.note(inst, pitch, dur, vel).astype(np.float32)
    add(st[stem], x, bt(beat), gain, pan)
    if name: mark(name, beat)


H_ = TL['hit']
OPEN = ['C2', 'D2', 'F2', 'G2', 'A2', 'C3', 'D3']      # 古琴正调七弦

# ───── A 山（b0–b4）72 BPM ─────
xiao(0, 'D4', 4.0, .2, att=1.6, rel=.8, sample=False, dt=.05)                        # 气声铺底，极轻
sweep(H_['stroke'], OPEN, .92, .016, 1.15, name='stroke_sweep')                       # 一笔成山：散音扫弦
D(H_['stroke'], 'gran_cassa', 'hit', .95, 1.3, 0, name='stroke_drum', stem='low')
Nn(H_['stroke'], 'timpani', 'D3', 2.5, .8, .9, -.1, stem='low')
G(H_['far'], 'A3', 1.6, .6, .1, 1., bend=[(0, -2), (.18, 0)], name='far_pluck')      # 远山：按音上滑入
G(H_['fall'], 'D4', 1.2, .62, .15, 1., glide=('G3', .55), name='fall_slide')          # 飞白成瀑：下行滑音
D(H_['moss1'], 'woodblock', 'a', .75, .9, .2, name='moss1')                           # 苔点 = 木鱼
D(H_['moss2'], 'woodblock', 'b', .6, .8, .25, name='moss2')
D(H_['moss3'], 'woodblock', 'a', .55, .7, .3, name='moss3')
G(H_['moss1'], 'F3', 1.0, .5, -.1, .8)

# ───── B 留白生鹤（b5–b9.5）无拍子感的琴 + 箫 ─────
xiao(H_['pan'], 'D4', 3.3, .5, att=.7, rel=.3, vib=(4.6, .14, .9)); mark('pan_xiao', H_['pan'])
G(H_['pan'], 'D2', 4.0, .45, -.2, .9, name='pan_low')
H(H_['wash'], 'A5', .55, .2, 1.1, name='wash_harm')
G(H_['wing1'], 'C4', 1.0, .58, .1, 1., name='wing1')
G(H_['wing2'], 'D4', 1.0, .55, .15, 1., name='wing2')
G(H_['neck'], 'G3', 1.2, .6, 0, 1., bend=[(0, 0), (.12, 0), (.3, 2)], name='neck_slide')
H(H_['crown'], 'D6', .5, .3, .9, dur=1.0, name='crown_harm')
D(H_['raise'], 'log_drum', 'lo', .6, .9, -.1, name='raise_muyu')
xiao(H_['raise'], 'F4', .82, .55, att=.15, rel=.05, vib=(5, .1, .3), cresc=.4)
G(H_['leap'], 'A2', 1.5, .7, -.1, 1., name='leap_low')
D(H_['leap'], 'gran_cassa', 'hit', .5, .6, 0, stem='low')

# ───── 静默（b10–b11）：混音里整条总线归零 ─────

# ───── C 鹤唳 + 加速（b11–b15） ─────
# 鹤唳：古琴泛音大上滑 + 箫高音滑音（合成，带气声），全片最重要的一声
t0 = bt(H_['cry']); mark('cry', H_['cry'])
H(H_['cry'], 'A5', .9, .1, 1.5, dur=2.2, bend=[(0, 0), (.06, 0), (.32, 5), (1.2, 5), (1.9, 4)], vib=(6, .25, .45))
n = int(2.4 * SR); tt = np.arange(n) / SR
curve = np.interp(tt, [0, .04, .3, .5, 1.3, 1.9, 2.4], [S.midi('A5') - 1, S.midi('A5'), S.midi('D6') + .3, S.midi('D6'), S.midi('D6') - .2, S.midi('C6'), S.midi('A5')])
curve += np.where(tt > .45, .22 * np.sin(2 * np.pi * 6.2 * (tt - .45)), 0)
cry = xiao_syn(curve, 1., .8) * env(n, .012, 1.0) * np.interp(tt, [0, .3, .5, 1.3, 2.4], [.8, 1, .85, .7, 0])
add(st['cry'], (cry * .62).astype(np.float32), t0, 1., .05)
G(H_['cry'], 'D2', 3.0, .7, 0, 1.0)                                                      # 低音空弦托底
# 加速脉冲：木鱼 + 手鼓踩拍，古琴上行音型
asc = ['D3', 'F3', 'G3', 'A3', 'C4', 'D4', 'F4']
for i, b in enumerate(range(12, 19)):
    D(b, 'woodblock', 'a' if b % 2 else 'c', .55 + .04 * i, .8, .25, name=f'pulse_wb_{b}')
    D(b, 'frame_drum', 'large', .55 + .05 * i, .9, -.15, stem='low')
    G(b, asc[i], .9, .5 + .04 * i, .05 * (i % 3 - 1), 1., name=f'pulse_qin_{b}')
for b in (12.5, 13.5):                                                                    # 半拍琴音（只放在整数帧的半拍上）
    G(b, 'A3' if b < 13 else 'C4', .5, .35, .2, .8)
xiao(12, 'A4', bt(16) - bt(12), .38, att=.6, rel=.2, vib=(5.2, .12, .4), cresc=.5)

# ───── D 墨晕（b16–b19）：墨滴 + 定音鼓滚奏渐强 → 高潮 ─────
H(H_['drop'], 'D6', .7, -.15, 1.0, dur=1.6, name='drop_harm')
Nn(H_['drop'], 'glass', 'D6', 1.2, .6, .5, -.1)
t_a, t_b = bt(16), bt(19); k = 0
tr = t_a
while tr < t_b - .02:                                                                     # 滚奏：16 分音符渐快渐强
    u = (tr - t_a) / (t_b - t_a)
    x = S.note('timpani', 'D3', .3, .25 + .55 * u).astype(np.float32)
    add(st['low'], x, tr, .35 + .6 * u, (k % 2 - .5) * .2)
    tr += .11 - .05 * u; k += 1
for b in (17, 18):
    D(b, 'woodblock', 'a', .7, .8, .25, name=f'bloom_wb_{b}')
    G(b, 'C4' if b == 17 else 'D4', 1.0, .6, 0, 1., name=f'bloom_qin_{b}')
# 高潮：月出
D(H_['full'], 'gran_cassa', 'hit', 1.0, 1.4, 0, name='full_drum', stem='low')
D(H_['full'], 'gong', None, .7, .8, 0, name='full_gong')
Nn(H_['full'], 'timpani', 'D3', 3.0, .9, 1.0, 0, stem='low')
sweep(H_['full'], OPEN + ['F3', 'A3', 'D4'], .95, .02, 1.15, name='full_sweep', dur=4.0)
xiao(H_['full'], 'D5', 3.4, .5, att=.25, rel=1.2, vib=(4.8, .18, .6))

# ───── E 落枝 + 钤印（b20–b23）减速 ─────
G(H_['branch'], 'D2', 2.5, .75, -.1, 1.1, bend=[(0, 0), (.1, 0), (.45, 2)], name='branch_slide')
D(H_['land'], 'frame_drum', 'small', .6, .9, -.1, name='land_drum', stem='low')
G(H_['land'], 'A3', 1.6, .6, .1, 1., name='land_qin')
H(H_['land'], 'A4', .45, .2, .8)
G(21.5, 'F4', 1.2, .42, .2, .8, vib=(4.5, .15, .25))
D(H_['seal'], 'gong2', 'small', .7, .9, -.2, name='seal_gong')
D(H_['seal'], 'woodblock', 'c', .5, .6, -.2)
G(H_['seal'], 'D3', 2.5, .55, -.1, .9)
G(H_['turn'], 'G4', 1.4, .45, .25, .85, bend=[(0, -1), (.15, 0)], vib=(4.2, .2, .35), name='turn_qin')
H(H_['last'], 'D5', .6, -.1, 1.0, dur=3.0, name='last_harm')
H(H_['last'], 'A5', .4, .2, .7, dur=3.0)
xiao(20, 'A4', bt(23) - bt(20) + .4, .32, att=.8, rel=1.4, vib=(4.4, .15, .6))

# ───── 输出 ─────
os.makedirs(os.path.join(HERE, 'music', 'stems'), exist_ok=True)
gain = {'guqin': 1.0, 'xiao': .42, 'perc': .8, 'low': .9, 'cry': .9}
mix = sum(st[k] * g for k, g in gain.items())
for k in st: sf.write(os.path.join(HERE, 'music', 'stems', k + '.wav'), st[k], SR)
pk = np.abs(mix).max(); mix = mix / pk * .89 if pk > .89 else mix
sf.write(os.path.join(HERE, 'music', 'score.wav'), mix.astype(np.float32), SR)
json.dump({'marks': marks, 'instruments': ['flute', 'woodblock', 'log_drum', 'gran_cassa', 'timpani', 'frame_drum', 'glass', 'gong', 'gong2']}, open(os.path.join(HERE, 'music', 'score.json'), 'w'), ensure_ascii=False, indent=1)
print('score.wav', round(len(mix) / SR, 2), 's, peak', round(20 * np.log10(np.abs(mix).max()), 2), 'dBFS,', len(marks), 'marks')
