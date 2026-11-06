"""《追帽子》混音：配乐（music/score.py）+ 影院效果鼓手的"乐器化拟音"（木鱼、滑哨、电车铃、风声机……，由 events.json 驱动）
+ 放映机环境声（灯咔嗒、爪轮马达、结尾降速）→ out/mix.wav。响度交给 mux.sh 的两遍 loudnorm（−14 LUFS）。
用法：.venv/bin/python mix.py   （先跑 events.mjs 生成 events.json）"""
import sys, os, json, subprocess
import numpy as np, soundfile as sf

LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, LIB)
from core.audio import sampler as S
from core.audio.sfx import SR, add, noise, t_, env_exp, bp, lp, hp, norm, brown, whoosh, creak, thump, click, pop, compress, limit

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EVJ = json.load(open(os.path.join(HERE, 'events.json')))
HIT, SEC, DUR = TL['hit'], TL['sec'], TL['dur']
EV = EVJ['ev']
S.seed(7)
N = int(round(DUR * SR))
SFX_LOG = []      # (t, name) 实际放进去的拟音，给 cuecheck

# ---------------- 乐器化效果（numpy 合成） ----------------
def slide(f0, f1, d, vib=6.0, depth=.02, curve=1.0):
    """滑哨：正弦滑音 + 颤音 + 一点气声"""
    tt = t_(d); u = (tt / d) ** curve
    f = f0 * (f1 / f0) ** u * (1 + depth * np.sin(2 * np.pi * vib * tt))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) + .18 * np.sin(2 * ph) + bp(noise(d), 1500, 5000) * .05
    e = np.minimum(1, tt / .02) * np.minimum(1, (d - tt) / .04)
    return (x * e * .5).astype(np.float32)
def bell(f=1180, d=1.0):
    """电车铃：非谐泛音的铜铃"""
    tt = t_(d)
    x = sum(a * np.sin(2 * np.pi * f * r * tt) * env_exp(d, tau) for r, a, tau in [(1, 1, .5), (2.76, .5, .25), (5.4, .3, .12), (1.5, .25, .3), (8.9, .12, .05)])
    x += hp(noise(d), 3000) * env_exp(d, .003) * .4
    return norm(x).astype(np.float32) * .8
def wind(d=.8):
    """风声机：帆布滚筒的嘶嘶声，带通扫频"""
    n_ = noise(d); tt = t_(d); out = np.zeros_like(n_)
    for i in range(0, len(n_), 960):
        hi = min(len(n_), i + 960); f = 500 + 1600 * np.sin(np.pi * i / len(n_)) ** 1.5
        out[i:hi] = bp(n_[max(0, i - 4000):hi], f * .6, f * 1.4)[-(hi - i):]
    return norm(out * np.sin(np.pi * tt / d) ** 1.5).astype(np.float32)
def boing(d=.45, f0=170):
    tt = t_(d); f = f0 * (1 - .35 * tt / d) * (1 + .12 * np.sin(2 * np.pi * 14 * tt) * np.exp(-tt * 4))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) + .3 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    return norm(x * env_exp(d, .15)).astype(np.float32)
def bark(f0=420, d=.16):
    """效果鼓手的"狗吠"：锯齿 + 共振峰带通 + 噪声爆破"""
    tt = t_(d); f = f0 * (1 - .4 * tt / d)
    saw = 2 * ((np.cumsum(f) / SR) % 1) - 1
    x = bp(saw, 600, 1800) * 1.2 + bp(noise(d), 800, 2500) * .6
    e = np.minimum(1, tt / .008) * np.exp(-tt / .06)
    return norm(np.tanh(x * 2) * e).astype(np.float32)
def rumble_pass(d=1.3):
    """电车驶过：低频轰隆 + 车轮压轨缝"""
    tt = t_(d); b = lp(brown(d), 160) * .8 + bp(noise(d), 200, 900) * .25
    e = np.sin(np.pi * np.clip(tt / d, 0, 1)) ** 1.2
    return norm(b * e).astype(np.float32)
def swish(d=.7):
    """幕布拉合：天鹅绒摩擦"""
    tt = t_(d); x = bp(brown(d), 300, 3500) * .7 + hp(noise(d), 4000) * .08
    return norm(x * np.sin(np.pi * tt / d) ** 2).astype(np.float32)
def card_clack():
    d = .07; return norm(bp(noise(d), 900, 4000) * env_exp(d, .006) + np.sin(2 * np.pi * 320 * t_(d)) * env_exp(d, .015) * .5).astype(np.float32)

# ---------------- 放映机（环境底） ----------------
def projector():
    out = np.zeros(N, np.float32)
    tt = np.arange(N) / SR
    # 马达：起转（0–0.4 s）与结尾降速（19.25 s 起）
    rate = np.full(N, 24.0)
    rate *= np.clip(.5 + tt / .8, .5, 1.0)
    rate *= np.clip(1 - (tt - (DUR - .65)) / .65 * .45, .55, 1.0)
    ph = np.cumsum(rate) / SR
    hum = (np.sin(2 * np.pi * ph * 2.5) * .35 + np.sin(2 * np.pi * ph * 5) * .2) * .15
    out += hum * np.clip(tt / .3, 0, 1)
    # 爪轮"嗒"：每格一下
    idx = np.where(np.diff(np.floor(ph)) > 0)[0]
    tick = hp(noise(.012), 2500) * env_exp(.012, .002)
    rng = np.random.default_rng(3)
    for i in idx:
        e = min(N, i + len(tick)); out[i:e] += tick[:e - i] * (.22 + .08 * rng.random())
    out += bp(noise(N / SR), 800, 3000) * .02
    # 开机灯咔嗒
    lamp = click(.6, 1.0) * .8; out[:len(lamp)] += lamp
    # 结尾：片尾拍打卷盘
    fl0 = int((DUR - .45) * SR)
    for k in range(10):
        s = fl0 + int(k * .045 * SR); f = hp(noise(.02), 1200) * env_exp(.02, .004) * .5
        e = min(N, s + len(f)); out[s:e] += f[:e - s]
    return out

def hitw(inst, var, vel, dur=None):
    return S.hit(inst, var, vel, dur)

def place(buf, x, t, g, pan=0., name=None):
    add(buf, x, t, g, pan)
    if name: SFX_LOG.append((round(t, 6), name))

def build_sfx():
    fx = np.zeros((N + SR, 2), np.float32)
    beat = SEC['CHASE']['beat']; e8 = beat / 2
    run_alt = 0
    for e in EV:
        t, ty = e['t'], e['type']
        if ty == 'step':
            k = e.get('kind')
            if k == 'walk': place(fx, hitw('woodblock', 'c', .35), t, .45, -.1, 'step')
            elif k == 'run': run_alt += 1; place(fx, hitw('woodblock', 'a' if run_alt % 2 else 'b', .42), t, .45, .05, 'step')
            else: run_alt += 1; place(fx, hitw('woodblock', 'b' if run_alt % 2 else 'c', .5), t, .5, .1, 'step')
        elif ty == 'paw': place(fx, hitw('woodblock', 'a', .3), t, .22, -.25, 'paw')      # 狗爪：高一点的木鱼（不用响板）
        if ty != 'hit': continue
        nm = e['name']
        if nm == 'gust': place(fx, wind(.85), t - .2, .45, .2); place(fx, slide(700, 2100, .3, curve=.6), t, .22, .3, 'gust')
        elif nm == 'tip': place(fx, slide(900, 1700, .14, curve=.5), t, .2, .25, 'tip'); place(fx, slide(1700, 1200, .12), t + .15, .16, .25)
        elif nm == 'land': place(fx, hitw('woodblock', 'a', .7), t, .6, .2, 'land')
        elif nm == 'run': place(fx, whoosh(.25), t, .25, 0, 'run')
        elif nm == 'curb': place(fx, boing(), t, .4, .1, 'curb'); place(fx, hitw('woodblock', 'a', .4), t + e8 / 2, .26, .2); place(fx, hitw('woodblock', 'a', .36), t + e8, .23, .2)
        elif nm == 'tramIn':
            place(fx, bell(), t, .36, -.35, 'tramIn'); place(fx, bell(), t + e8, .3, -.3)
            place(fx, rumble_pass(1.35), t - .15, .36, -.1)
        elif nm == 'nearMiss':
            place(fx, whoosh(.45), t - .05, .4, -.2)
            for k in range(6): place(fx, hitw('woodblock', 'c', .3), t + .08 + k * .1, .16, -.1 + k * .06)   # 车轮压轨缝
        elif nm == 'hatWall':
            flick = HIT['nearMiss'] + (1650 - 1440) / 2400
            place(fx, slide(500, 1900, t - flick, curve=.5), flick, .22, .3)
            place(fx, hitw('woodblock', 'a', .65), t, .5, .3, 'hatWall')
        elif nm in ('rung1', 'rung2', 'rung3'):
            place(fx, hitw('woodblock', 'b', .55), t, .5, .25, nm); place(fx, creak(.5), t + .03, .14, .25)
        elif nm == 'grab': place(fx, click(.7, .8), t, .3, .3, 'grab')
        elif nm == 'wobble':
            for k, dt in enumerate((0, .1, .2)): place(fx, creak(.9), t + dt, .3, .2, 'wobble' if k == 0 else None)
        elif nm == 'fall':
            place(fx, slide(1800, 300, .3, curve=1.4), t - .3, .26, .1)
            place(fx, thump(1.0, 62), t, .5, -.1, 'fall')                                  # −3 dB：落地让位给揭晓
        elif nm == 'bark':
            for dt in (0, e8): place(fx, bark(), t + dt, .5, -.3, 'bark' if dt == 0 else None)
        elif nm == 'crank':
            place(fx, whoosh(.3), t, .3, 0, 'crank')
            for b in (.5, 1.5, 2.5): place(fx, bark(480, .12), t + b * beat, .38, -.35)
        elif nm in ('card1', 'card2'): place(fx, card_clack(), t, .25, 0, nm)
        elif nm == 'twitch': place(fx, hitw('woodblock', 'c', .12), t, .08, 0, 'twitch')        # 近静默：几乎听不见的一下
        elif nm == 'reveal':
            place(fx, slide(600, 2200, .18, curve=.4), t, .45, .2, 'reveal'); place(fx, hitw('triangle', 'open', .6), t, .45, .3); place(fx, pop(.8), t, .35, 0)
        elif nm == 'look': place(fx, hitw('triangle', 'muted', .4), t, .22, .3, 'look')
        elif nm == 'settle': place(fx, hitw('woodblock', 'c', .5), t, .35, .2, 'settle')
        elif nm == 'bow': place(fx, slide(900, 1700, .14, curve=.5), t, .22, .25, 'bow'); place(fx, slide(1700, 1200, .12), t + .15, .18, .25)
        elif nm == 'irisShut': place(fx, swish(HIT['curtain'] - t + .1), t, .28, 0, 'irisShut')
        elif nm == 'curtain': place(fx, thump(.5, 80), t, .25, 0, 'curtain')
    return fx[:N]

def main():
    subprocess.run([os.path.join(LIB, '.venv/bin/python'), os.path.join(HERE, 'music', 'score.py'), HERE], check=True)
    mu, sr = sf.read(os.path.join(OUT, 'music.wav'), dtype='float32'); assert sr == SR
    mu = mu[:N] if len(mu) >= N else np.pad(mu, ((0, N - len(mu)), (0, 0)))
    # 钢琴锤击瞬态：轻压缩
    mu = np.stack([compress(mu[:, c], thr=.22, ratio=2.5, att=.003, rel=.09) for c in (0, 1)], 1)
    # 制音器落下：Misterioso 在 SIL 起点干净地停住，揭晓前一瞬再放开（混响尾巴也一起切掉）
    tm = np.arange(N) / SR
    gate = np.clip(1 - (tm - SEC['SIL']['t0']) / .06, 0, 1) + np.clip((tm - (HIT['reveal'] - .004)) / .004, 0, 1)
    mu = mu * np.clip(gate, 0, 1)[:, None]
    # Hurry 总线 −1.5 dB（追逐段），让静默后的揭晓明显更满
    tm2 = np.arange(N) / SR
    hur = np.where((tm2 >= SEC['CHASE']['t0']) & (tm2 < SEC['CHASE']['t1']), 10 ** (-1.5 / 20), 1.0)
    hur = np.convolve(hur, np.ones(480) / 480, 'same')
    mu = mu * hur[:, None]
    fx = build_sfx()
    pj = projector()
    tt = np.arange(N) / SR
    # 静默段：放映机被推到前面（唯一的声音）
    sil = ((tt >= SEC['SIL']['t0']) & (tt < SEC['SIL']['t1'])).astype(np.float32)
    k = np.convolve(sil, np.ones(int(.05 * SR)) / int(.05 * SR), 'same')
    pj_g = .06 * (1 + 1.1 * k)
    mix = mu * 1.0 + fx * .9
    mix[:, 0] += pj * pj_g; mix[:, 1] += pj * pj_g
    # 结尾淡出最后 0.25 s
    fade = np.clip((DUR - tt) / .25, 0, 1)[:, None]; mix *= fade
    mix = np.stack([limit(mix[:, c], .95) for c in (0, 1)], 1).astype(np.float32)
    # 自己先把响度推到 ≈ −14 LUFS、样本峰值压在 −2 dBFS：这样 mux.sh 的 loudnorm 能走线性模式（只调增益），
    # 不会退回动态模式把揭晓那一声压平。限幅只削几毫秒的锤击瞬态，400 ms 瞬时响度的相对关系保持不变。
    tmp = os.path.join(OUT, '_mixtmp.wav')
    def lufs(x):
        sf.write(tmp, x, SR)
        r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', tmp, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True).stderr
        import re; return float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r)[-1])
    for _ in range(6):
        L = lufs(mix); g = 10 ** ((-14.05 - L) / 20)
        if abs(L + 14.15) < .05: break
        mix = np.stack([limit(mix[:, c] * g, .74, .003) for c in (0, 1)], 1).astype(np.float32)
    os.remove(tmp)
    print(f'预归一化：{lufs(mix) if False else L:.2f} LUFS → 目标 −14.05，样本峰值 {np.abs(mix).max():.3f}')
    sf.write(os.path.join(OUT, 'mix.wav'), mix, SR)
    sf.write(os.path.join(OUT, 'stem_music.wav'), mu, SR); sf.write(os.path.join(OUT, 'stem_sfx.wav'), fx, SR)
    json.dump(sorted(SFX_LOG), open(os.path.join(OUT, 'sfx_log.json'), 'w'))
    # 静默段电平检查
    def rms(a, b): seg = mix[int(a * SR):int(b * SR)]; return 20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9)
    print(f"mix.wav {N / SR:.3f}s  peak {np.abs(mix).max():.3f}  全片 RMS {rms(0, DUR):.1f} dBFS  静默段 RMS {rms(SEC['SIL']['t0'] + .05, SEC['SIL']['t1'] - .02):.1f} dBFS  揭晓 0.5s RMS {rms(HIT['reveal'], HIT['reveal'] + .5):.1f} dBFS")

if __name__ == '__main__':
    main()
