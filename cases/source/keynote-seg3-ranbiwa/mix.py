"""片段三的配乐与音效：读 events.json（由 timeline.js 导出），每个画面事件一个主题化的声音，锁在拍上。
输出 out/mix.wav（48 kHz 立体声）与 out/cues.json（每条声音在各自分轨上的实测起音时刻，给 cuecheck）。
运行：$LIB/.venv/bin/python mix.py   （LIB 由环境变量或 build.sh 给出）"""
import os, sys, json
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S, pluck as P
from core.audio.sfx import SR, add, noise, brown, bp, lp, hp, env_exp, t_, norm, limit, whoosh
S.seed(11)
R = np.random.default_rng(23)

EVJ = json.load(open(os.path.join(HERE, 'events.json')))
DUR = EVJ['dur']; EV = EVJ['ev']
BEAT = 60 / 96
def b(n): return n * BEAT
N = int(round(DUR * SR))
bus = {k: np.zeros((N, 2), np.float32) for k in ('music', 'sfx', 'amb', 'boom')}
CUES = []   # (名字, 计划时刻, 单独分轨)

def put(name, x, at, gain=1.0, pan=0.0, busn='sfx', cue=True):
    """把单声道 x 放到 at 秒；cue=True 时记下这条声音的计划时刻，稍后测起音"""
    x = x.astype(np.float32)
    if cue:   # 卡点声音：把起音（峰值 −30 dB 处）对准拍点，而不是样本的第 0 个点
        a = np.abs(x); i = int(np.argmax(a > a.max() * 10 ** (-30 / 20))); at = at - i / SR
        CUES.append((name, at + i / SR, at, x * gain))
    add(bus[busn], x, at, gain, pan)

def fade(x, fi=.003, fo=.01):
    x = x.copy(); a, z = int(fi * SR), int(fo * SR)
    if a: x[:a] *= np.linspace(0, 1, a)
    if z: x[-z:] *= np.linspace(1, 0, z)
    return x

# ———————————————— 合成的拟音 ————————————————
def shimmer(d=.28):
    """开灯前的纸光微响：高频噪声上升，止于拍上"""
    n = bp(noise(d), 3500, 9000); e = np.linspace(0, 1, len(n)) ** 2.2
    return n * e
def click_switch(dark=False):
    d = .05; tt = t_(d)
    tr = hp(noise(d), 1500) * env_exp(d, .0018)
    body = np.sin(2 * np.pi * (900 if not dark else 520) * tt) * env_exp(d, .006) * .6 + np.sin(2 * np.pi * 180 * tt) * env_exp(d, .012) * .5
    return norm(tr + body)
def puff():
    d = .32; n = bp(noise(d), 250, 2400); e = np.minimum(1, t_(d) / .012) * env_exp(d, .07)
    return norm(n * e + lp(noise(d), 160) * env_exp(d, .05) * .6)
def crackle(d, dens=18, seed=1):
    r = np.random.default_rng(seed); out = np.zeros(int(d * SR))
    for _ in range(int(d * dens)):
        s = r.integers(0, len(out) - 900); L = r.integers(80, 700); a = r.random() ** 2
        out[s:s + L] += hp(r.standard_normal(L), 1800) * np.exp(-np.arange(L) / (L / 5)) * a
    bed = lp(brown(d), 500) * .25
    return norm(out + bed)
def paper_slide(d=.2):
    n = bp(noise(d), 1200, 6000); e = np.sin(np.pi * np.linspace(0, 1, len(n)) * .5) ** 1.5
    fl = 1 + .5 * np.sin(2 * np.pi * 37 * t_(d))
    return norm(n * e * fl)
def rustle(d=.5, seed=3):
    r = np.random.default_rng(seed); n = bp(noise(d), 1500, 7000)
    am = np.abs(lp(r.standard_normal(len(n)), 30)); am /= am.max() + 1e-9
    return norm(n * am * np.sin(np.pi * np.linspace(0, 1, len(n))))
def paper_pop():
    """纸门立起的"啵"：短的上扫正弦 + 纸张脆响 + 卡纸落定的低频"""
    d = .2; tt = t_(d); f = 260 + 900 * tt / d
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(d, .035)
    crk = hp(noise(d), 2500) * env_exp(d, .01) * .7
    thud = np.sin(2 * np.pi * 120 * tt) * env_exp(d, .03) * .7
    return norm(tone * .8 + crk + thud)
def page_land():
    d = .25; tt = t_(d)
    return norm(lp(noise(d), 900) * env_exp(d, .03) + np.sin(2 * np.pi * 95 * tt) * env_exp(d, .04) * .8 + hp(noise(d), 3000) * env_exp(d, .008) * .3)
def fire_whoosh(d=2.6):
    tt = t_(d); n = lp(brown(d), 1400) + bp(noise(d), 300, 3000) * .5
    e = np.minimum(1, tt / .008) * np.exp(-tt / .9)
    return norm(n * e)
def sub_boom(d=2.2, f0=58):
    tt = t_(d); ph = 2 * np.pi * np.cumsum(f0 * (1 - .45 * np.minimum(1, tt / 1.2))) / SR
    x = np.sin(ph) + .35 * np.sin(2 * ph) + .2 * np.sin(3 * ph)
    return norm(x * np.minimum(1, tt / .004) * np.exp(-tt / .6))
def pulse_hit(d=.55, f=36.71):
    """电子低频脉冲的一拍：D1 正弦带 2、3 次谐波，泵一样的包络"""
    tt = t_(d); ph = 2 * np.pi * np.cumsum(f * (1 + .9 * np.exp(-tt / .03))) / SR
    x = np.sin(ph) + .55 * np.sin(2 * ph) + .3 * np.sin(3 * ph) + .12 * np.sin(4 * ph)
    return x * np.minimum(1, tt / .003) * np.exp(-tt / .16)
def tick(d=.04):
    return hp(noise(d), 6000) * env_exp(d, .006)

# ———————————————— A11：灯箱 ————————————————
evs = {}
for e in EV: evs.setdefault(e['type'], []).append(e)
def T(typ, i=0): return evs[typ][i]['t']

# 0–1.25：布幕后的油灯（片段二的尾巴）
d0 = T('snuff') + .25
fl = crackle(d0, 10, 5) * .25 + lp(brown(d0), 300) * .4
fl *= np.minimum(1, np.linspace(0, d0, len(fl)) * 0 + 1)
fl[int(T('snuff') * SR):] *= np.exp(-np.arange(len(fl) - int(T('snuff') * SR)) / (.05 * SR))
put('flame_bed', fade(fl, .0, .02), 0, .25, .3, 'amb', cue=False)
drone = S.note('cellos', 'D2', T('snuff') + .1, vel=.45, release=.12) + S.note('contrabass', 'D2', T('snuff') + .1, vel=.4, release=.12)
put('drone_tail', fade(drone, 0, .1), 0, .32, 0, 'music', cue=False)
put('snuff', puff(), T('snuff'), .28, .25)

# 每层亮起：开灯微响 + 钟音
for e in evs['layer']:
    put('shimmer', shimmer(), e['t'] - .28, .03, (e['n'] - 1.5) * .3, cue=False)
    put('layer_click', click_switch(), e['t'], .05, (e['n'] - 1.5) * .3)
    put('layer_chime', S.note('hand_chimes', e['note'], 3.0, vel=.75), e['t'], .30, (e['n'] - 1.5) * .35, 'music')
# 电子低频脉冲：b4 起每拍，b20 起八分，b22 起十六分（只在上拍给重音）
t0, tb = T('pulse_on'), T('silence')
k = 0
while True:
    t = t0 + k * BEAT / 4
    if t >= tb - 1e-6: break
    beatpos = k % 4
    if t >= T('pulse_16th'): on = True
    elif t >= T('pulse_8th'): on = beatpos in (0, 2)
    else: on = beatpos == 0
    if on:
        acc = 1.0 if beatpos == 0 else .55
        put('pulse', pulse_hit(), t, .2 * acc, 0, 'boom', cue=(beatpos == 0 and k % 16 == 0))
        if t >= b(12) and beatpos == 2 or t >= T('pulse_8th'): put('tick', tick(), t, .05 * acc, .4 if k % 8 else -.4, cue=False)
    k += 1
# 推进的上升音（b20→b24），在 b24 截断
dr = tb - T('pulse_8th'); rs = bp(noise(dr), 400, 5000) * np.linspace(0, 1, int(round(dr * SR))) ** 3
tt = t_(dr); rs += np.sin(2 * np.pi * np.cumsum(110 + 330 * (tt / dr) ** 2) / SR) * (tt / dr) ** 2 * .35
put('riser', fade(rs, .5, .004), T('pulse_8th'), .075, 0, 'sfx', cue=False)
# 和声垫：颤音琴弓奏（D–A，b12 加 F#）
for p, t1, v in [('D4', b(4), .35), ('A4', b(4), .3), ('F#4', b(12), .28), ('D5', b(16), .22)]:
    x = S.note('vibraphone_bowed', p, tb - t1, vel=v, attack=.6, release=.05)
    put('pad', fade(x, 0, .02), t1, .26, -.3 if p[0] == 'A' else .3, 'music', cue=False)

for e in evs['window_big']:
    for i, p in enumerate(e['notes']):
        put('bell', S.note('tubular_bells' if i == 0 else 'glockenspiel', p, 4.0, vel=.8), e['t'], .2 if i == 0 else .1, .1, 'music')
    put('win_boom', sub_boom(1.2, 62), e['t'], .12, 0, 'boom')
for e in evs['glyph']:
    put('glyph', S.note('glockenspiel', e['note'], 2.0, vel=.55), e['t'], .14, .45 - e['i'] * .3, 'music')
for e in evs['window_small']:
    put('win_small', S.note('vibraphone_hard', e['note'], 2.6, vel=.8), e['t'], .24, .5 - e['i'] * .33, 'music')
    put('win_small_ch', S.note('hand_chimes', e['note'], 2.0, vel=.5), e['t'], .12, .5 - e['i'] * .33, 'music', cue=False)
    put('slip_slide', paper_slide(.2), e['t'] - .2, .05, .5 - e['i'] * .33, cue=False)
for e in evs['slip']:
    if e['t'] > T('silence'): continue
    put('slip_slide', paper_slide(.2), e['t'] - .2, .09, 0, cue=False)
    put('slip_wood', S.hit('woodblock', 'a', .85 if e.get('accent') else .6), e['t'], .30 if e.get('accent') else .2, -.2)
e = evs['forest'][0]
put('forest_chime', S.note('hand_chimes', e['note'], 3, vel=.75), e['t'], .30, -.2, 'music')
put('forest_rustle', rustle(.6), e['t'] - .05, .07, -.3, cue=False)
for e in evs['glyph_title']:
    put('lls_glyph', S.note('glockenspiel', e['notes'][0], 2.4, vel=.6), e['t'], .16, .3, 'music')
    put('lls_glyph2', S.note('hand_chimes', e['notes'][1], 2.4, vel=.6), e['t'], .14, .3, 'music', cue=False)

# ———————————————— A12：燃比娃 ————————————————
tB = T('burst')
put('burst_drum', S.hit('gran_cassa', 'hit', 1.0), tB, .95, 0, 'boom')
put('burst_bd', S.hit('bass_drum', None, 1.0), tB, .6, 0, 'boom', cue=False)
put('burst_timp', S.hit('timpani', 'drum3', 1.0), tB, .5, -.15, 'boom', cue=False)
put('burst_nao', S.hit('clash', 'crash', 1.0), tB, .55, .2)
put('burst_gong', S.hit('gong', None, .9), tB, .5, 0, 'music', cue=False)
put('burst_sub', sub_boom(2.4, 55), tB, .75, 0, 'boom', cue=False)
put('burst_fire', fire_whoosh(2.8), tB, .95, -.1, cue=False)
# 火堆噼啪声床（b25 → 拉远后被关进画里）
dF = T('lamp_on') + 3.0 - tB
cr = crackle(dF, 26, 9)
cr *= np.minimum(1, t_(dF) / .05)
iL = int((T('lamp_on') - tB) * SR)
tail = cr[iL:].copy(); tail = lp(tail, 700) * np.exp(-np.arange(len(tail)) / (.9 * SR)); cr[iL:] = tail
put('fire_bed', cr, tB, .2, .15, 'amb', cue=False)
# 低 D 持续
dd = T('lamp_on') - tB + .6
x = S.note('cellos', 'D2', dd, vel=.55, attack=.05, release=.6) * .7 + S.note('contrabass', 'D2', dd, vel=.5, attack=.05, release=.6) * .7
put('rbw_drone', x, tB + .02, .42, 0, 'music', cue=False)
# 京剧点子：台 台 才
for e in evs['gong_dot']:
    if e['i'] < 2: put('xiaoluo', S.hit('gong2', 'small', .7), e['t'], .30, .3 - e['i'] * .6)
    else: put('nao_short', S.hit('clash', 'short', .75), e['t'], .32, .1)
e = [x for x in evs['slip'] if x['t'] > tB][0]
put('slip_slide', paper_slide(.2), e['t'] - .2, .09, 0, cue=False)
put('slip_wood', S.hit('woodblock', 'b', .6), e['t'], .18, -.3, cue=False)
for e in evs['fire_pulse']:
    g = 1.0 if e['i'] == 0 else .8
    put('fire_drum', S.hit('gran_cassa', 'hit', .85), e['t'], .55 * g, 0, 'boom')
    put('fire_nao', S.hit('clash', 'short', .7), e['t'], .25 * g, -.2, cue=False)
    put('fire_whoosh', fire_whoosh(1.4), e['t'], .2 * g, .2, cue=False)
for n in (28, 30, 32, 34):
    put('tom', S.hit('toms', 'low_mallet', .6), b(n), .3, -.3, 'boom', cue=False)

# ———————————————— A13：揭晓 ————————————————
tl = T('lamp_on')
put('lamp_click', click_switch(dark=True), tl, .42, -.35)
dh = DUR - tl; tt = t_(dh)
hum = (np.sin(2 * np.pi * 100 * tt) + .5 * np.sin(2 * np.pi * 200 * tt) + .25 * np.sin(2 * np.pi * 300 * tt + 1) + .3 * bp(noise(dh), 90, 400)) * np.minimum(1, tt / .12)
put('hum', hum, tl, .02, -.3, 'amb', cue=False)
room = lp(brown(dh), 260) * .7 + bp(noise(dh), 400, 3000) * .05
put('room', room * np.minimum(1, tt / .25), tl, .085, .1, 'amb', cue=False)
# 弦乐暖和弦
for p, v, pan in [('D3', .4, .2), ('A3', .38, -.2), ('F#4', .3, .35)]:
    put('str', S.note('cellos' if p == 'D3' else ('violas' if p == 'A3' else 'violins'), p, b(48) - tl, vel=v, attack=1.4, release=.8), tl + .05, .28, pan, 'music', cue=False)
put('relight', S.note('hand_chimes', 'D5', 3, vel=.5), T('relight'), .26, .3, 'music')
put('relight2', S.note('hand_chimes', 'A5', 3, vel=.45), T('relight'), .22, .4, 'music', cue=False)
# 古琴主题（与片段一同一动机，96 BPM）
th = T('theme') if 'theme' in evs else b(40)
theme = [('D4', 40, 1.0, {}), ('E4', 41, .5, {}), ('F#4', 41.5, .5, {}), ('A4', 42, 2.0, {'vib': (4.6, .22, .35)}),
         ('B4', 44, 1.0, {}), ('A4', 45, .5, {}), ('F#4', 45.5, .5, {}), ('E4', 46, 1.0, {}), ('D4', 47, 1.0, {'harmonic': True})]
for p, n, L, kw in theme:
    x = P.pluck('guqin', p, max(1.2, L * BEAT + 1.4), vel=.78, **kw)
    put('guqin', x, b(n), .6 if not kw.get('harmonic') else .62, -.1, 'music', cue=n in (40, 44, 45, 46, 47))
# 翻页、落页、三道门
dl = T('leaf_land') - T('leaf_start')
put('leaf_swish', fade(whoosh(dl, 1.0) * .7 + rustle(dl, 7) * .5, .05, .02), T('leaf_start'), .12, .2, cue=False)
put('leaf_land', page_land(), T('leaf_land'), .45, .15)
for e in evs['door']:
    put('door_pop', paper_pop(), e['t'], .5, (e['i'] - 1) * .25)
# 落定：主音 D
tc = T('cadence')
put('cad_qin', P.strum('guqin', ['D2', 'D3', 'A3'], 5.0, vel=.8, spread=.03), tc, .62, -.05, 'music')
for inst, p, v in [('contrabass', 'D2', .5), ('cellos', 'D3', .5), ('violas', 'A3', .45), ('violins', 'F#4', .38), ('violins', 'D5', .3)]:
    put('cad_str', S.note(inst, p, DUR - tc - .3, vel=v, attack=.5, release=1.0), tc, .32, 0, 'music', cue=False)
put('harm1', P.pluck('guqin', 'D5', 2.4, vel=.6, harmonic=True), T('harmonic'), .85, .25, 'music')
put('harm2', P.pluck('guqin', 'A5', 2.4, vel=.55, harmonic=True), b(53), .7, -.25, 'music', cue=False)

# ———————————————— 混音 ————————————————
mus = S.room(bus['music'], size=.55, mix=.22)
sfxb = S.room(bus['sfx'], size=.3, mix=.12)
boom = bus['boom']
# 低频平衡：鼓与脉冲的超低频稍收
for c in range(2): boom[:, c] = boom[:, c] - .35 * lp(boom[:, c], 45)
mix = mus + sfxb + boom + bus['amb']
# 结尾余音收住：最后 0.9 s 音乐与效果淡出（房间底噪保留到底，最后 0.25 s 一起收）
tt = np.arange(N) / SR
endf = np.clip((DUR - .05 - tt) / .9, 0, 1) ** 1.5
mix = (mus + sfxb + boom) * endf[:, None] + bus['amb'] * np.clip((DUR - tt) / .25, 0, 1)[:, None]
# 燃比娃那一下：软饱和让它更"满"（峰值不变，密度上去）
w0, w1 = int(T('burst') * SR), int((T('burst') + 1.6) * SR)
seg_ = mix[w0:w1]; pk = np.abs(seg_).max() + 1e-9; sat = np.tanh(seg_ / pk * 3.0) / np.tanh(3.0) * pk
xf = np.ones(w1 - w0); xf[-int(.5 * SR):] = np.linspace(1, 0, int(.5 * SR)); mix[w0:w1] = sat * xf[:, None] + seg_ * (1 - xf[:, None])
# 刻意的静默：b24 整条总线清零
s0, s1 = int(round(T('silence') * SR)), int(round(T('burst') * SR))
f = int(.004 * SR); mix[s0 - f:s0] *= np.linspace(1, 0, f)[:, None]; mix[s0:s1] = 0
# 母带：测整体响度 → 增益到 −14 LUFS → 带前瞻与 120 ms 释放的限幅器（−1.6 dBFS）
import subprocess, tempfile, re, numba
def lufs(x):
    p = os.path.join(tempfile.gettempdir(), 'seg3_meas.wav'); sf.write(p, x.astype(np.float32), SR, subtype='FLOAT')
    o = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.findall(r'I:\s+(-?[0-9.]+) LUFS', o)[-1])
@numba.njit(cache=True)
def _rel(g, rc):
    out = np.empty_like(g); v = 1.0
    for i in range(len(g)):
        v = g[i] if g[i] < v else v + (1 - v) * rc
        if v > g[i]: v = g[i]
        out[i] = v
    return out
def limiter(x, ceil, look=.004, rel=.12):
    from scipy.ndimage import maximum_filter1d
    n = int(look * SR); pk = maximum_filter1d(np.abs(x).max(axis=1), size=2 * n + 1)
    g = np.minimum(1.0, ceil / np.maximum(pk, 1e-9))
    g = _rel(g, 1 - np.exp(-1 / (rel * SR)))
    g = np.convolve(g, np.ones(n) / n, mode='same')
    return x * np.minimum(g, 1.0)[:, None]
CEIL = 10 ** (-2.1 / 20)
for it in range(6):
    I = lufs(mix); mix = mix * 10 ** ((-14.0 - I) / 20); mix = limiter(mix, CEIL)
    mix = np.clip(mix, -CEIL, CEIL)
mix[s0:s1] = 0
print('master I', lufs(mix))
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix.astype(np.float32), SR, subtype='FLOAT')

# 每条卡点声音在自己的分轨上测起音（首个超过该声音峰值 −30 dB 的样点）
rep = []
for name, plan, at, x in CUES:
    a = np.abs(x); th = a.max() * 10 ** (-30 / 20); i = int(np.argmax(a > th)); on = at + i / SR
    rep.append({'name': name, 'plan': round(plan, 4), 'onset': round(on, 5), 'err_ms': round((on - plan) * 1000, 2)})
json.dump(rep, open(os.path.join(HERE, 'out', 'cues.json'), 'w'), ensure_ascii=False, indent=1)
print('mix', mix.shape, 'peak', float(np.abs(mix).max()), 'cues', len(rep), 'max |err| ms', max(abs(r['err_ms']) for r in rep))
