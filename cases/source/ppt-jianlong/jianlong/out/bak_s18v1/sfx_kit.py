"""《见龙》音效库：按规范 §3 的音效类型程序合成（不依赖采样，可离线重跑，结果确定）。
用法（被 mix.py 调用）：render(event) → (n,2) float32 @48k 立体声，已乘 gain、pan、淡入淡出。
单独试听：$LIB/.venv/bin/python tools/sfx_kit.py rain_near heartbeat …  → out/sfx_preview/<type>.wav

事件字段（sfx/Sxx.json 的 events[]）：
  公共：id（画面用 api.cue(id) 取时刻）, t（段内秒）, type, gain（dB，默认 -12）, pan（-1..1）, dur（秒，持续类必填）,
        fade_in / fade_out（秒）, seed（变化用）
  各类型的专用参数见 TYPES 表右侧注释。
"""
import os, sys, numpy as np
from scipy.signal import butter, sosfilt
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
sys.path.insert(0, f'{LIB}/core/audio')
import sfx as S   # 库里的程序音效积木（click/whoosh/thump/ding…）

SR = 48000


def T(d): return np.arange(int(round(d * SR))) / SR
def rng(e): return np.random.default_rng(int(e.get('seed', 0)) * 7919 + int(round(e.get('t', 0) * 1000)) % 100003)
def bp(x, lo, hi, o=2): return sosfilt(butter(o, [lo, hi], 'band', fs=SR, output='sos'), x)
def lp(x, f, o=2): return sosfilt(butter(o, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x)
def nrm(x, p=1.0): m = np.abs(x).max(); return x * (p / m) if m > 0 else x
def env(d, a, r): t = T(d); return np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / max(r, 1e-4))
def mix(*xs):
    n = max(len(x) for x in xs); out = np.zeros(n)
    for x in xs: out[:len(x)] += x
    return out
def place(n, x, at):
    out = np.zeros(n); s = int(round(at * SR)); e = min(n, s + len(x));
    if s < n: out[s:e] += x[:e - s]
    return out


# —— 环境 ——
def rain_far(e, r):
    d = e['dur']; L = lp(hp(r.standard_normal(int(round(d * SR))), 300), 2600, 4)
    R = lp(hp(r.standard_normal(int(round(d * SR))), 300), 2600, 4)
    m = 1 + 0.15 * np.sin(2 * np.pi * 0.13 * T(d) + r.random() * 6)
    return np.stack([nrm(L * m), nrm(R * m)], 1) * 0.7


def rain_near(e, r):
    d = e['dur']; n = int(round(d * SR)); out = []
    for ch in range(2):
        bed = hp(r.standard_normal(n), 1800) * 0.25
        drops = np.zeros(n); k = int(d * 90 * e.get('density', 1))
        for i in range(k):
            s = r.integers(0, n - 800); f = r.uniform(2500, 6500); tt = np.arange(600) / SR
            drops[s:s + 600] += np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.0015) * r.uniform(0.2, 1)
        out.append(nrm(bed + drops * 0.5))
    return np.stack(out, 1) * 0.8


def car_sweep(e, r):   # 车灯扫过：远处车声滑过 + 轮胎溅水，pan 从 pan_from 到 pan_to
    d = e.get('dur', 2.6); t = T(d); n = len(t)
    hum = np.sin(2 * np.pi * (55 + 8 * t) * t) * 0.4 + lp(r.standard_normal(n), 400) * 0.6
    hiss = bp(r.standard_normal(n), 1500, 6000) * 0.5
    a = np.sin(np.pi * t / d) ** 2
    x = nrm((hum + hiss) * a)
    p = np.linspace(e.get('pan_from', -0.8), e.get('pan_to', 0.8), n)
    return np.stack([x * np.cos((p + 1) * np.pi / 4), x * np.sin((p + 1) * np.pi / 4)], 1) * 1.4


def window_paper(e, r):   # 窗纸被风/车光震动的沙沙
    d = e.get('dur', 0.8); n = int(round(d * SR))
    cr = (r.random(n) > 0.997) * r.standard_normal(n) * 4
    x = bp(r.standard_normal(n) * 0.3 + cr, 900, 5000) * np.sin(np.pi * T(d) / d)
    return nrm(x)


# —— 镜片界面 ——
def rec_beep(e, r):
    a = np.concatenate([S.quindar(1, 1200)[:int(round(.07 * SR))], np.zeros(int(round(.05 * SR))), S.quindar(1, 1800)[:int(round(.07 * SR))]])
    return nrm(a) * 0.6


def ui_stroke(e, r):   # 描线：极轻的玻璃上划过声
    d = e.get('dur', 0.6); t = T(d); n = len(t)
    x = bp(r.standard_normal(n), 3000, 9000) * np.sin(np.pi * t / d) ** 1.5
    x += np.sin(2 * np.pi * (2400 + 1600 * t / d) * t) * 0.05 * np.sin(np.pi * t / d)
    return nrm(x) * 0.5


def ui_tick(e, r):
    d = 0.03; t = T(d); return nrm(np.sin(2 * np.pi * 3200 * t) * np.exp(-t / 0.004) + hp(r.standard_normal(len(t)), 4000) * np.exp(-t / 0.002) * 0.3) * 0.6


def ui_type(e, r):   # 打字：与 ui.label 同算法——框描出 box 秒后，第 i 个字在 box+(i+1)/cps 出现
    n_ch = len(e['text']) if 'text' in e else int(e.get('n', 4)); cps = e.get('cps', 12); box = e.get('box', 0.25)
    d = box + (n_ch + 1) / cps + 0.1; out = np.zeros(int(round(d * SR)))
    for i in range(n_ch):
        c = ui_tick({}, r) * r.uniform(0.6, 1.0); out += place(len(out), c, box + (i + 1) / cps)
    return out * 0.7


def scan_beep(e, r):   # 扫描「嘀」
    d = 0.16; t = T(d); f = e.get('freq', 2200)
    x = np.sin(2 * np.pi * f * t) * np.minimum(1, t / 0.005) * np.exp(-np.maximum(0, t - 0.09) / 0.02)
    return nrm(x) * 0.7


def glitch(e, r):   # 干扰噪声：成段的数字碎噪 + 嗡鸣
    d = e.get('dur', 0.8); n = int(round(d * SR)); x = np.zeros(n)
    hold = 1; i = 0
    while i < n:
        L = int(round(r.uniform(0.01, 0.08) * SR)); on = r.random() < 0.6
        if on:
            seg = r.standard_normal(min(L, n - i)); step = int(r.integers(8, 60)); seg = np.repeat(seg[::step], step)[:min(L, n - i)]
            x[i:i + len(seg)] = seg * r.uniform(0.3, 1)
        i += L
    x += np.sign(np.sin(2 * np.pi * 120 * T(d))) * 0.08
    return nrm(bp(x, 200, 8000))


def lens_focus(e, r):   # 对焦：机械微动 + 一点气声
    a = S.click(0.6, 1.0) * 0.6; w = S.whoosh(0.25, 0.4)
    out = np.zeros(int(round(0.35 * SR))); out[:len(w)] += w * 0.5; out[int(round(.2 * SR)):int(round(.2 * SR)) + len(a)] += a
    return nrm(out)


# —— 自然与人 ——
def mudslide(e, r):   # 泥石流低频：持续低吼 + 石块碰撞
    d = e.get('dur', 3.0); n = int(round(d * SR))
    x = lp(S.brown(d), 180) * 1.0 + lp(r.standard_normal(n), 600) * 0.3
    for k in range(int(d * 6)):
        c = S.clack(r.uniform(0.3, 0.6), r.uniform(0.2, 0.6)); x += place(n, lp(c, 1500), r.uniform(0, d - 0.1)) * 0.6
    a = np.minimum(1, T(d) / 0.5) * np.minimum(1, (d - T(d)) / 0.8)
    return nrm(x * a)


def headlamp(e, r): return nrm(mix(S.click(0.8, 1) * 0.8, np.pad(S.click(1.1, 0.5), (int(round(.05 * SR)), 0))))


def footsteps(e, r):   # 湿泥地脚步：n 步，rate 步/秒
    n_ = int(e.get('n', 6)); rate = e.get('rate', 1.8); d = n_ / rate + 0.4; out = np.zeros(int(round(d * SR)))
    for i in range(n_):
        L = int(round(0.18 * SR)); t = np.arange(L) / SR
        s = lp(r.standard_normal(L), 500) * np.exp(-t / 0.03) + bp(r.standard_normal(L), 1500, 5000) * np.exp(-t / 0.05) * 0.3
        out += place(len(out), s * r.uniform(0.7, 1), i / rate)
    return nrm(out)


def stone(e, r):   # 石头：闷敲
    return nrm(mix(S.thump(1, e.get('f', 90)) * 0.8, lp(S.clack(0.5, 1), 2500) * 0.6))


def heartbeat(e, r):   # 心跳「咚咚」：n 次，bpm；第一声对准 t
    n_ = int(e.get('n', 2)); bpm = e.get('bpm', 58); per = 60 / bpm; one = S.heartbeat(1.0)
    out = np.zeros(int(round((n_ * per + 0.6) * SR)))
    for i in range(n_): out += place(len(out), one, i * per)
    return nrm(lp(out, 300))


def assemble(e, r):   # 归位：旧物拼合的木石碰撞，n 下，均匀散在 dur 内（或 times 列表，段内秒相对 t）
    times = e.get('times') or list(np.linspace(0, e.get('dur', 2.0), int(e.get('n', 6))))
    out = np.zeros(int((max(times) + 0.6) * SR))
    for i, tt in enumerate(times):
        c = mix(S.clack(r.uniform(0.5, 0.9), 1) * 0.6, S.thump(0.6, r.uniform(80, 140)) * 0.5)
        out += place(len(out), c, tt)
    return nrm(out)


# —— 水墨与纸 ——
def paper(e, r):   # 纸：翻动/摩擦
    d = e.get('dur', 1.0); n = int(round(d * SR)); t = T(d)
    cr = (r.random(n) > 0.995) * r.standard_normal(n) * 3
    x = bp(r.standard_normal(n) * 0.4 + cr, 1200, 7000) * (np.sin(np.pi * t / d) ** 0.7)
    return nrm(x) * 0.8


def ink_bleed(e, r):   # 墨洇：湿润的慢涨，像水在纸里走
    d = e.get('dur', 2.0); n = int(round(d * SR)); t = T(d)
    x = lp(r.standard_normal(n), 900) * 0.6 + bp(r.standard_normal(n), 200, 1200) * 0.4
    bub = np.zeros(n)
    for k in range(int(d * 8)):
        L = int(round(0.04 * SR)); tt = np.arange(L) / SR; f = r.uniform(300, 700)
        bub += place(n, np.sin(2 * np.pi * f * tt * (1 + 2 * tt)) * np.exp(-tt / 0.01), r.uniform(0, d - 0.05)) * 0.3
    a = np.minimum(1, t / (d * 0.4)) * np.minimum(1, (d - t) / (d * 0.4))
    return nrm((x + bub) * a) * 0.8


def brush(e, r):   # 毛笔擦纸
    d = e.get('dur', 0.7); n = int(round(d * SR)); t = T(d)
    f0 = np.linspace(1800, 3600, n); x = np.zeros(n); src = r.standard_normal(n)
    for i in range(0, n, 960): x[i:i + 960] = bp(src[max(0, i - 2000):i + 960], f0[i] * 0.6, f0[i] * 1.4)[-len(x[i:i + 960]):]
    return nrm(x * np.sin(np.pi * t / d) ** 1.2) * 0.8


def char_thud(e, r):   # 大字落下：一声闷响 + 纸面一拍
    th = S.thump(1, 58); slap = bp(r.standard_normal(int(round(.06 * SR))), 800, 5000) * np.exp(-T(.06) / .01)
    out = np.zeros(int(round(0.5 * SR))); out[:len(th)] += th; out[:len(slap)] += slap * 0.4
    return nrm(out)


def seal(e, r):   # 印章压纸：按下的闷声 + 纸面摩擦 + 抬起
    out = np.zeros(int(round(0.7 * SR))); th = S.thump(0.9, 110); out[:len(th)] += th * 0.8
    fr = bp(r.standard_normal(int(round(.25 * SR))), 1000, 4000) * np.sin(np.pi * T(.25) / .25); out[int(round(.02 * SR)):int(round(.02 * SR)) + len(fr)] += fr * 0.25
    up = S.click(0.5, 0.3); out[int(round(.5 * SR)):int(round(.5 * SR)) + len(up)] += up
    return nrm(out)


def title_cut(e, r):   # 片名刻出：刀划纸 + 低沉一击
    d = 0.5; n = int(round(d * SR)); t = T(d)
    scr = hp(r.standard_normal(n), 2500) * np.exp(-t / 0.25) * (0.6 + 0.4 * np.sin(2 * np.pi * 37 * t))
    th = S.thump(1, 50); out = scr * 0.5; out[:len(th)] += th
    return nrm(out)


def whoosh(e, r): return nrm(S.whoosh(e.get('dur', 0.6), 1))


TYPES = dict(
    rain_far=rain_far,        # 远雨层（持续，dur）
    rain_near=rain_near,      # 近雨层（持续，dur；density）
    car_sweep=car_sweep,      # 车灯扫过（dur, pan_from, pan_to）
    window_paper=window_paper,  # 窗纸（dur）
    rec_beep=rec_beep,        # 录音器提示音
    ui_stroke=ui_stroke,      # 界面描线（dur，很轻）
    ui_tick=ui_tick,          # 界面小咔（角标落位）
    ui_type=ui_type,          # 打字（text 或 n, cps, box=0.25；与 ui.label 同算法）
    scan_beep=scan_beep,      # 扫描「嘀」（freq）
    glitch=glitch,            # 干扰噪声（dur）
    lens_focus=lens_focus,    # 镜片对焦
    mudslide=mudslide,        # 泥石流低频（dur）
    headlamp=headlamp,        # 头灯开关
    footsteps=footsteps,      # 脚步（n, rate）
    stone=stone,              # 石头（f）
    heartbeat=heartbeat,      # 心跳「咚咚」（n, bpm）
    assemble=assemble,        # 归位木石碰撞（n, dur 或 times）
    paper=paper,              # 纸（dur）
    ink_bleed=ink_bleed,      # 墨洇（dur）
    brush=brush,              # 毛笔擦纸（dur）
    char_thud=char_thud,      # 大字落下闷响
    seal=seal,                # 印章压纸
    title_cut=title_cut,      # 片名刀刻
    whoosh=whoosh,            # 穿越过渡（dur）
)


def render(e):
    if e['type'] not in TYPES: raise ValueError(f"未知音效类型 {e['type']}（可用：{', '.join(TYPES)}）")
    x = TYPES[e['type']](e, rng(e)).astype(np.float32)
    if x.ndim == 1:
        p = e.get('pan', 0.0); x = np.stack([x * np.cos((p + 1) * np.pi / 4), x * np.sin((p + 1) * np.pi / 4)], 1) * 1.414
    n = len(x); fi, fo = int(round(e.get('fade_in', 0) * SR)), int(round(e.get('fade_out', 0.02 if 'dur' in e else 0) * SR))
    if fi: x[:fi] *= np.linspace(0, 1, fi)[:, None]
    if fo: x[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return x * 10 ** (e.get('gain', -12) / 20)


if __name__ == '__main__':
    import soundfile as sf
    HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); od = f'{HERE}/out/sfx_preview'; os.makedirs(od, exist_ok=True)
    for ty in sys.argv[1:] or TYPES:
        e = dict(type=ty, t=0, dur=2.0, gain=-6, text='鹿影', n=4)
        sf.write(f'{od}/{ty}.wav', render(e), SR); print(ty)
