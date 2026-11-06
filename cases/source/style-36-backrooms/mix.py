"""《交接录像》混音：带子录到的一切声音 → out/mix.wav（48 kHz 立体声）
没有配乐（STYLE §7）。"音乐"由世界里的声音按 72 BPM 网格组织：
  灯管嗡鸣（numpy）、吸顶喇叭提示音（VCSL 颤音琴真实采样）、镇流器"叮"（pluck.py 模态合成）、
  弓擦吊镲（VSCO/VCSL 真实采样，降调）、低频 drone（numpy）、低频冲击（大鼓 + 定音鼓真实采样 + 正弦下滑）、
  拟音（sfx.py 程序化）：脚步、衣料、对焦、变焦伺服、按键、呼吸。
所有时间来自 events.json（由页面 window.EV 导出，与画面同源）。同时写 out/audio_cues.json 供拍点核对。"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
import numpy as np, soundfile as sf
import soxr
from core.audio.sfx import SR, bp, lp, hp, add, limit, brown, clack as sfx_clack, whoosh, thump
from core.audio import sampler as S, pluck as P

S.seed(36)
rng = np.random.default_rng(3601)
E = json.load(open(os.path.join(HERE, 'events.json'))); DUR = E['dur']; EV = E['ev']
N = int(round(DUR * SR))
tt = np.arange(N) / SR
BEAT = 60 / 72
ev = lambda ty: [e for e in EV if e['type'] == ty]
one = lambda ty: ev(ty)[0]
sec = lambda d: int(round(d * SR))
nz = lambda n: rng.standard_normal(n)
CUES = []   # (类型, 拍, 放置时间)

def bus(): return np.zeros((N, 2))
def put(b, x, t, g=1., pan=0., cue=None, beat=None):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        i = sec(t); j = min(N, i + len(x))
        if i < N and j > i: b[i:j] += x[:j - i] * g
    else: add(b, x, t, g, pan)
    if cue: CUES.append({'type': cue, 'beat': beat, 't': sec(t) / SR})
def nrm(x): m = np.abs(x).max(); return x / m if m > 0 else x
def envexp(n, tau): return np.exp(-np.arange(n) / SR / tau)
def stereo(x, w=.0):
    return np.stack([x, x], 1)

T_TEAR = one('tear')['t']; T_IMP = one('impact')['t']; T_RESET = one('reset')['t']
T_HOLD = one('holdBreath'); FLICKS = ev('flick')

# ———————— 灯的门控曲线（与画面 gLight / lightExtra 同一套数） ————————
def gate_curve():
    g = np.ones(N)
    for f in FLICKS:
        if f['far']: continue
        d = tt - f['t']
        g[(d >= 0) & (d < .1)] = .03; g[(d >= .1) & (d < .16)] = .7; g[(d >= .16) & (d < .2)] = .05
        m = (d >= .2) & (d < .3); g[m] = .55 + .45 * (d[m] - .2) / .1
    d = tt - T_IMP
    g[(d >= 0) & (d < 2 / 24)] = 1.55; g[(d >= 2 / 24) & (d < 4 / 24)] = .35; g[(d >= 4 / 24) & (d < 6 / 24)] = 1.25; g[(d >= 6 / 24) & (d < 7 / 24)] = .6
    m = (d >= 7 / 24) & (d < .6); g[m] = 1 + .25 * np.exp(-(d[m] - 7 / 24) / .12)
    return g
G = np.convolve(gate_curve(), np.ones(96) / 96, mode='same')   # 2 ms 平滑，避免咔嗒

# ———————— 环境床：灯管嗡鸣（60 Hz 市电 → 120 Hz 嗡鸣 + 谐波 + 蜂鸣 + 镇流器啸叫） ————————
def hum(f0=120.0, buzz=.5, whine=7200., seed=0):
    r = np.random.default_rng(seed)
    x = .1 * np.sin(2 * np.pi * f0 / 2 * tt)
    for k, a in [(1, 1.0), (2, .55), (3, .32), (4, .2), (5, .12), (7, .06)]:
        x += a * np.sin(2 * np.pi * f0 * k * tt + r.random() * 6)
    pulse = np.sign(np.sin(2 * np.pi * f0 * tt)) * (np.abs(np.sin(2 * np.pi * f0 * tt)) > .96)
    x += buzz * bp(pulse + .3 * r.standard_normal(N), 900, 4200, 2) * 1.6
    x += .05 * np.sin(2 * np.pi * whine * tt) * (1 + .3 * np.sin(2 * np.pi * .7 * tt))
    x *= 1 + .06 * np.sin(2 * np.pi * .33 * tt + 1)
    return nrm(x)
amb = bus()
in1 = (tt < T_TEAR).astype(float); in2 = (tt >= T_IMP).astype(float)
h1 = hum(120.0, .45, 7200, 1); h2 = hum(120.4, .8, 6800, 2)
put(amb, stereo(h1 * G * in1), 0, .16)
put(amb, stereo(h2 * G * in2 * (1 + .25 * np.exp(-np.maximum(tt - T_IMP, 0) / .5))), 0, .19)
# 磁带底噪 + 摄像机马达
hiss = hp(lp(nz(N), 9000), 1800); motor = bp(nz(N), 250, 520, 2) * (1 + .4 * np.sin(2 * np.pi * 29 * tt))
put(amb, np.stack([hiss, np.roll(hiss, 37)], 1) * .012, 0); put(amb, stereo(motor) * .006, 0)

# ———————— 拟音 ————————
fol = bus()
def click(f=4200, v=1.):
    n = sec(.025); x = hp(nz(n), 2500) * envexp(n, .002) + np.sin(2 * np.pi * f * np.arange(n) / SR) * envexp(n, .004) * .6
    return nrm(x) * v
def af_tick(v=1.):
    n = sec(.09); t = np.arange(n) / SR
    buzzm = bp(np.sign(np.sin(2 * np.pi * 190 * t)), 700, 2600, 2) * np.sin(np.pi * np.minimum(t / .07, 1)) ** 2 * (t < .07)
    x = np.zeros(n); c1 = click(5200, 1); x[:len(c1)] += c1; c2 = click(4600, .7); o = sec(.055); x[o:o + len(c2)] += c2[:n - o]
    return nrm(x + .35 * buzzm) * v
def af_slip():
    n = sec(.32); t = np.arange(n) / SR
    m = bp(np.sign(np.sin(2 * np.pi * (170 + 60 * t / .32) * t)), 600, 2400, 2) * np.sin(np.pi * t / .32) ** 1.5
    return nrm(m + .2 * bp(nz(n), 2000, 6000) * np.sin(np.pi * t / .32))
def carpet_step(v=1.):
    n = sec(.28); t = np.arange(n) / SR
    thud = lp(nz(n), 180, 3) * envexp(n, .035) * 2.2 + np.sin(2 * np.pi * 62 * t) * envexp(n, .05) * .9
    sq = bp(nz(n), 350, 1400, 2) * np.exp(-((t - .045) / .03) ** 2) * .55
    fib = bp(nz(n), 2500, 7000, 2) * envexp(n, .02) * .18
    return nrm(thud + sq + fib) * v
def rustle(d, v=1.):
    n = sec(d); t = np.arange(n) / SR
    x = bp(nz(n), 700, 4500, 2) * (np.sin(np.pi * t / d) ** 1.4) * (1 + .6 * np.abs(np.sin(2 * np.pi * 7 * t)))
    return nrm(x) * v
def rec_button():
    a = sfx_clack(.75, 1.); n = sec(.5); x = np.zeros(n); x[:len(a)] += a
    t = np.arange(n) / SR; sp = bp(np.sin(2 * np.pi * np.cumsum(300 + 500 * np.minimum(t / .35, 1)) / SR), 300, 2400) * np.minimum(t / .1, 1) * np.exp(-t / .4)
    return nrm(x + .3 * sp)
def zoom_servo(d):
    n = sec(d); t = np.arange(n) / SR
    f = 1050 + 90 * np.sin(2 * np.pi * .4 * t)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * .6 + bp(np.sign(np.sin(2 * np.pi * 210 * t)), 800, 3000) * .4
    e = np.minimum(1, t / .25) * np.minimum(1, (d - t) / .3) * (1 + .3 * np.sin(2 * np.pi * 3.1 * t))
    return nrm(x * e)
def lamp_buzz(lock):
    d = (DUR - 17 * BEAT) if lock else .09
    n = sec(d); t = np.arange(n) / SR
    sq = np.sign(np.sin(2 * np.pi * 100 * t)) * (1 + .15 * np.sin(2 * np.pi * 3.3 * t))
    bz = bp(sq + .2 * nz(n), 300, 3200, 2)
    e = np.ones(n)
    if lock: e = .18 + .82 * np.exp(-t / .2); e[-sec(.03):] *= np.linspace(1, 0, sec(.03))
    else: e = np.minimum(1, (d - t) / .01)
    x = nrm(bz * e) * (.55 if lock else .8)
    c = click(3000, 1.); x[:len(c)] += c
    return nrm(x)
def tink(midi, v=1., far=0.):
    x = P.pluck('music_box', midi, None, vel=.8).astype(np.float64)
    x = hp(x, 1500) * v
    if far: x = lp(x, 3000)
    return x

for e in EV:
    t, ty = e['t'], e['type']
    if ty == 'recOn': put(fol, rec_button(), t, .55, .1, 'REC 按键', e['beat'])
    elif ty == 'af': put(fol, af_tick(e['v']), t, .22, .15, '对焦 tick', e['beat'])
    elif ty == 'afSlip': put(fol, af_slip(), t, .2, .15, '对焦滑脱', e['beat'])
    elif ty == 'rustle': put(fol, rustle(e['d'], e['v']), t, .16, -.2, '衣料', e['beat'])
    elif ty == 'step':
        i = int(e['beat']); put(fol, carpet_step(e['v']), t, .62, -.25 if i % 2 else .25, '脚步', e['beat'])
    elif ty == 'door':
        i = e['n']; put(fol, af_tick(.9), t, .2, .3, '门过画心', e['beat'])
        put(fol, thump(.9, 52 - 3 * i), t, .32 + .06 * i, 0)
        w = whoosh(.36, 1.); put(fol, w, t - .18, .07 + .04 * i, .4)
    elif ty == 'flick':
        if e['far']: put(fol, tink(91, .5, 1), t, .18, -.3, '远灯镇流器', e['beat'])
        else:
            put(fol, tink(94, 1.), t, .3, 0, '头顶镇流器', e['beat']); put(fol, tink(89, .6), t + .1, .18, .1); put(fol, tink(96, .7), t + .2, .2, -.1)
    elif ty == 'zoom': put(fol, zoom_servo(e['d']), t, .07, 0, '变焦伺服', e['beat'])
    elif ty == 'lamp':                                   # 红灯：断火 = 继电器咔 + 一截掐断的蜂鸣；稳定 = 咔 + 蜂鸣持续到片尾
        put(fol, lamp_buzz(e['lock']), t, .16 if e['lock'] else .12, .05, '红灯' + ('稳定' if e['lock'] else '断火'), e['beat'])

# 呼吸：基线 0.27 Hz，屏息 b9–b12 完全停止，b12 一口长呼气，数门时越来越急，冲击后一口倒吸
def breath_bed():
    x = np.zeros(N); r = np.random.default_rng(9)
    times = []
    t = 4.3
    while t < T_HOLD['t'] - .3: times.append((t, 1.0, .85)); t += 1 / .27 * .5
    rel = T_HOLD['t'] + T_HOLD['d']
    times.append((rel, 2.0, 1.25))                       # 长呼气（屏息结束）
    for b in [12.75 + k * .5 for k in range(3)]:          # 数门：越来越急的短吸
        pass
    for tb, dd in [(10.7, .32), (11.2, .28), (11.62, .22), (11.84, .18)]: times.append((tb, dd / .8, .9))
    times.append((T_IMP + .32, .7, 1.1))                 # 冲击后倒吸
    times.append((T_IMP + 2.3, 1.4, .8)); times.append((T_RESET + .9, 1.6, .7))
    for t0, dl, v in times:
        n = sec(dl * .8); tt0 = np.arange(n) / SR
        b = bp(r.standard_normal(n), 380, 2600, 2) * np.sin(np.pi * tt0 / (dl * .8)) ** 2
        b += .3 * lp(r.standard_normal(n), 300) * np.sin(np.pi * tt0 / (dl * .8)) ** 2
        i = sec(t0); j = min(N, i + n)
        if i < N: x[i:j] += nrm(b)[:j - i] * v
    return x
put(fol, stereo(breath_bed()), 0, .05)

# ———————— "配乐"声部 ————————
mus = bus()
def speaker(x, far=.4, wow=0.):
    y = bp(x, 340 + 80 * far, 3600 - 900 * far, 2); y = y + .5 * bp(y, 1000, 1600, 2)
    y = np.tanh(2.0 * y / (np.abs(y).max() + 1e-9)) / np.tanh(2.0)
    if wow:
        n = len(y); t = np.arange(n) / SR
        sp = 1 + wow * np.sin(2 * np.pi * .55 * t) + .002 * np.sin(2 * np.pi * 7.3 * t); pos = np.cumsum(sp); pos -= pos[0]
        y = np.interp(np.clip(pos, 0, n - 1), np.arange(n), y)
    st = np.stack([y, y], 1)
    pad = np.pad(st, ((0, sec(2.5)), (0, 0)))
    wet = S.room(pad.astype(np.float32), size=.6 + .25 * far, mix=1.0, damp=.6)
    out = pad * (1 - .35 * far) + wet * (.2 + .45 * far)
    return out / (np.abs(out).max() + 1e-9)
CH = [76, 69, 72]                                        # E5 A4 C5：原创三音提示
for e in ev('chime'):
    flat = e['flat']; p = CH[e['n']] - (.72 if flat else 0)
    x = S.note('vibraphone', p, 1.4 if e['n'] < 2 else 2.2, vel=.75).astype(np.float64)
    put(mus, speaker(x, .5, .007 if flat else 0), e['t'], .13 if not flat else .12, 0, '提示音' + ('（走调）' if flat else ''), e['beat'])
# 低频 drone：b5 进，b14.5 被撕裂切断；两条正弦拍频 1.5 → 6 Hz
t5 = 5 * BEAT; d0 = np.clip((tt - t5) / (T_TEAR - t5), 0, 1)
beatf = 1.5 + 4.5 * d0 ** 1.6
f1 = 49.0; ph2 = 2 * np.pi * np.cumsum(f1 + beatf) / SR
dr = np.sin(2 * np.pi * f1 * tt) + np.sin(ph2)
dr = dr + .45 * np.sin(2 * np.pi * 2 * f1 * tt) + .4 * np.sin(2 * ph2) + .25 * np.sin(3 * ph2)   # 2/3 次谐波：小喇叭也听得见
dr += .7 * lp(brown(DUR + .01)[:N], 120)
put(mus, stereo(nrm(dr) * (d0 > 0) * d0 ** 1.3 * in1), 0, .12)
# 弓擦吊镲（降八度，灯管里的金属啸）：屏息段进入
bow = S.hit('sus_cymbal', 'bow', .6).astype(np.float64)
bow = soxr.resample(bow, SR, SR * 2)                     # 降八度
bow = lp(bow, 5000)
nb = min(len(bow), sec(T_TEAR - T_HOLD['t']))
bw = bow[:nb] * np.minimum(1, np.arange(nb) / sec(1.2))
put(mus, np.stack([bw, np.roll(bw, 300)], 1), T_HOLD['t'], .11, 0, '弓擦吊镲', 9)

# ———————— 冲击（静默后第一声）与归零闷击 ————————
def sub_drop(d, f0, f1, tau):
    n = sec(d); t = np.arange(n) / SR; f = f1 + (f0 - f1) * np.exp(-t / .25)
    ph = 2 * np.pi * np.cumsum(f) / SR; x = np.sin(ph) * np.exp(-t / tau)
    return np.tanh(1.8 * x) / np.tanh(1.8)                # 饱和出 2/3 次谐波
imp = np.zeros(sec(4.0))
def mixin(dst, x, g, o=0):
    x = np.asarray(x, np.float64); j = min(len(dst), o + len(x)); dst[o:j] += x[:j - o] * g
mixin(imp, nrm(S.hit('bass_drum', None, 1.0)), .9)
mixin(imp, nrm(S.note('timpani', 'D2', 3.0, vel=1.0)), .7)
mixin(imp, nrm(S.hit('gran_cassa', 'hit', 1.0)), .6)
mixin(imp, sub_drop(4.0, 58, 31, 1.1), .9)
mixin(imp, lp(nz(sec(.6)), 900) * envexp(sec(.6), .06), .5)
put(mus, stereo(nrm(imp)), T_IMP, .95, 0, '低频冲击', 16)
# 灯管齐打火：12 个镇流器"叮" + 打火噼啪
r2 = np.random.default_rng(16)
for k in range(12):
    o = 0 if k == 0 else r2.random() * .32
    put(fol, tink(int(86 + r2.integers(0, 12)), .5 + .5 * r2.random()), T_IMP + o, .2, r2.random() * 1.4 - .7, '灯管齐打火' if k == 0 else None, 16)
crack = hp(nz(sec(.25)), 2000) * (r2.random(sec(.25)) > .985) * 4
put(fol, crack, T_IMP, .25, .2)
# 归零：摄像机咔哒 + 轻闷击（结尾的低频冲击）
rz = np.zeros(sec(2.0))
mixin(rz, nrm(S.hit('bass_drum', None, .55)), .7); mixin(rz, sub_drop(2.0, 46, 34, .6), .8)
put(mus, stereo(nrm(lp(rz, 400))), T_RESET, .55, 0, '归零闷击', 20)
put(fol, sfx_clack(.7, 1.), T_RESET, .35, .1, '归零咔哒', 20)

# ———————— 总线 ————————
mix = amb + fol + mus
silent = (tt >= T_TEAR) & (tt < T_IMP)                  # 数字零：连尾音一起切掉
mix[silent] = 0.0
k = sec(.03); mix[N - k:] *= np.linspace(1, 0, k)[:, None]
for c in range(2): mix[:, c] = limit(mix[:, c], .89)
mix[silent] = 0.0
# 母带前处理：让峰值 − 响度 ≤ 12 dB，mux.sh 的两遍 loudnorm 才能走线性增益（不压动态）
import subprocess, re, tempfile
def lufs(x):
    f = os.path.join(HERE, 'out', '_probe.wav'); sf.write(f, x.astype(np.float32), SR, subtype='FLOAT')
    o = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', f, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    os.remove(f); return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', o)[-1])
for it in range(4):
    I = lufs(mix); ceil = 10 ** ((I + 11.6) / 20)
    if np.abs(mix).max() <= ceil * 1.01: break
    for c in range(2): mix[:, c] = limit(mix[:, c], ceil, .004)
    mix[silent] = 0.0
print('pre-master I %.1f LUFS, peak %.1f dBFS' % (lufs(mix), 20 * np.log10(np.abs(mix).max())))
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')
for nm, b in [('amb', amb), ('fol', fol), ('mus', mus)]:
    b2 = b.copy(); b2[silent] = 0; sf.write(os.path.join(HERE, 'out', f'stem_{nm}.wav'), b2.astype(np.float32), SR, subtype='FLOAT')
json.dump({'silence': [T_TEAR, T_IMP], 'cues': CUES}, open(os.path.join(HERE, 'out', 'audio_cues.json'), 'w'), ensure_ascii=False, indent=0)
pk = np.abs(mix).max(); print('mix', mix.shape, 'peak dBFS %.1f' % (20 * np.log10(pk)), 'NaN', np.isnan(mix).any())
def band(x, lo, hi): return 10 * np.log10(np.mean(bp(x, lo, hi) ** 2) + 1e-12)
m0 = mix.mean(1); print('band dB  20-120: %.1f  120-2k: %.1f  2k-8k: %.1f' % (band(m0, 25, 120), band(m0, 120, 2000), band(m0, 2000, 8000)))
