"""《这条街照常过年》故事介绍片
画面：PPT 原画（推拉 + 节拍跳动）+ v1/v2 AI 视频原片；去掉 HUD 风格，只留三语字幕（普/EN/粤）。
效果：灯笼按拍熄灭/重亮、蚀光黑痕、金线中国结片头、打斗冲击（闪白/震屏/推镜/色散/速度线）。
声音：MiniMax 三语配音 + 采样器配乐（狮鼓镲锣 + 二胡），所有剪切落在小节线上，击打点配鼓和镲。
用法：python build.py [frames|audio|mux|all]   （用 ~/lemo-opuscar/.venv/bin/python）
"""
import json, math, subprocess, sys
from functools import lru_cache
from multiprocessing import Pool
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage as ndi

P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'tools'))
import stills as S
from stills import W, H, GOLD, PURPLE, LANT, F, arr, img, fit, glow, line_mask, lanterns, extinguish, knot_paths, noise

SRC = P.parent / '素材' / 'hi'
OUT = P / 'out'; (OUT / 'frames').mkdir(parents=True, exist_ok=True)
LIB = str(Path.home() / 'lemo-opuscar')
FPS = 30
BPM = 100; BEAT = 60 / BPM; BAR = BEAT * 4
LINES = {x['id']: x for x in json.load(open(P / 'lines.json'))}
DUR = json.load(open(P / 'vo' / 'dur.json'))

# —— 镜头表：(类型, 小节数, 参数, [(台词id, 镜内起点秒)])
SHOTS = [
    ('lantern', 3, {}, [('c01', .4)]),
    ('title', 2, {}, []),
    ('img', 2, dict(src='image3.jpeg', z=(1.0, 1.08), pan=(0, -.02)), [('n01', .4)]),
    ('img', 3, dict(src='image2.png', z=(1.08, 1.0), pan=(.02, 0)), [('n02', .3)]),
    ('img', 2, dict(src='image13.jpeg', z=(1.0, 1.1), pan=(0, 0)), [('n03', .3)]),
    ('img', 3, dict(src='image8.png', z=(1.0, 1.07), pan=(-.02, 0)), [('d01', .3), ('r01', 3.7)]),
    ('img', 3, dict(src='image14.jpeg', z=(1.08, 1.0), pan=(.03, 0)), [('l01', .3), ('m01', 3.1)]),
    ('img', 2, dict(src='image10.png', z=(1.0, 1.06), pan=(0, .02)), [('r02', .6)]),
    ('cards', 3, {}, [('n04', .6)]),
    ('img', 3, dict(src='image16.jpeg', z=(1.0, 1.07), pan=(-.03, 0)), [('t01', .3), ('t02', 4.5)]),
    ('img', 2, dict(src='image12.jpeg', z=(1.0, 1.06), pan=(.02, 0)), [('t03', .3)]),
    ('vid', 2, dict(v='v2', t0=0.0, speed=.36, pool=1), [('n05', .3)]),
    ('lanterns_out', 4, dict(src='image12.jpeg'), [('c02', .6), ('r03', 3.8)]),
    ('img', 2, dict(src='image9.png', z=(1.0, 1.07), pan=(0, -.02)), [('n06', .3)]),
    ('img', 2, dict(src='image16.jpeg', crop=(1190, 10, 1672, 552), z=(1.0, 1.08)), [('l02', .3)]),
    ('img', 4, dict(src='image11.png', z=(1.0, 1.12), pan=(.02, 0)), [('m02', .2), ('t04', 2.6), ('r04', 6.3), ('c03', 8.7)]),
    ('lanterns_on', 3, dict(src='image1.jpeg'), [('n07', .7), ('m03', 4.6)]),
    ('img', 2, dict(src='image15.jpeg', z=(1.0, 1.06), pan=(0, .01)), [('n08', .5)]),
    ('photo', 2, dict(src='image17.jpeg'), [('l03', .6)]),
    ('end', 3, {}, []),
]
# 分段（配乐情绪），按镜号
SECTION = {0: 'cold', 2: 'fest', 11: 'dark', 13: 'pulse', 15: 'fight', 16: 'climax', 17: 'warm'}

TL, t = [], 0.0
for i, (kind, bars, o, lines) in enumerate(SHOTS):
    d = bars * BAR
    TL.append(dict(i=i, kind=kind, a=t, b=t + d, o=o, lines=[(lid, t + off, DUR[lid]) for lid, off in lines]))
    t += d
TOTAL = t
def section(i):
    s = 'cold'
    for k in sorted(SECTION):
        if i >= k: s = SECTION[k]
    return s

# v2 击打点（帧差峰值，强度 > 55）；slow 里的是要慢放的大招
V2_HITS = [1.8, 3.17, 4.0, 4.57, 4.97, 5.8, 6.73, 7.23, 7.53, 9.63, 11.2, 12.63, 13.83, 14.9, 15.9]
FIGHT0 = next(sc for sc in TL if section(sc['i']) == 'fight')
CLIMAX0 = next(sc for sc in TL if section(sc['i']) == 'climax')

def speed_at(tv, slow):
    s_ = 1.0
    for h in slow:
        x = tv - h
        if 0 <= x < .01: return .08                      # 顿帧（约 0.12 秒）
        s_ = min(s_, 1 - .8 * math.exp(-(x / .22) ** 2))   # 前后慢放
    return max(s_, .2)

@lru_cache(maxsize=16)
def remap(i):
    """镜头内时间 → 素材时间（积分速度曲线），返回 (输出时刻数组, 素材时刻数组)"""
    sc = TL[i]; o = sc['o']; D = sc['b'] - sc['a']; dt = 1 / (FPS * 8)
    ts = np.arange(0, D + dt, dt); tv = np.empty_like(ts); x = o['t0']
    for j, t_ in enumerate(ts):
        tv[j] = x
        x += (speed_at(x, o.get('slow', ())) if o.get('slow') else o.get('speed', 1.0)) * dt
    return ts, np.minimum(tv, 16.6 if o['v'] == 'v2' else 15.0)

def src_time(sc, lt):
    ts, tv = remap(sc['i']); return float(np.interp(lt, ts, tv))

def global_hits():
    """所有打斗镜头里击打点在成片中的时刻，以及是否是慢放大招"""
    hs = []
    for sc in TL:
        if sc['o'].get('fight'):
            ts, tv = remap(sc['i'])
            for h in V2_HITS:
                if tv[0] <= h <= tv[-1]:
                    hs.append((sc['a'] + float(ts[np.searchsorted(tv, h)]), h in sc['o'].get('slow', ())))
    return hs

# ================= 画面工具 =================
def ease(x): x = min(max(x, 0), 1); return x * x * (3 - 2 * x)

@lru_cache(maxsize=24)
def src_img(name, crop=None, scale=1.12):
    im = Image.open(SRC / name).convert('RGB')
    if crop: im = im.crop(crop)
    s = max(W / im.width, H / im.height) * scale
    return im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)

def kb(im, z, cx=.5, cy=.5):
    """从放大底图里取 W×H 窗口：z=1 为铺满，z>1 推近"""
    bw, bh = im.size; base = max(W / bw, H / bh)
    w, h = W / (base * z) / 1, H / (base * z)
    w, h = min(w, bw), min(h, bh)
    x0 = min(max(cx * bw - w / 2, 0), bw - w); y0 = min(max(cy * bh - h / 2, 0), bh - h)
    return im.transform((W, H), Image.EXTENT, (x0, y0, x0 + w, y0 + h), Image.BILINEAR)

def beat_bump(T, on):
    if not on: return 0
    k = (T % BAR) / BEAT; ph = (T % BEAT)
    return .014 * math.exp(-ph / .12) * (1.6 if int(k) == 0 else 1)

def vignette():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    v = 1 - .38 * np.clip((np.hypot((xx - W / 2) / W, (yy - H / 2) / H) - .3) / .45, 0, 1) ** 1.5
    return v[..., None]
VIG = None

@lru_cache(maxsize=4)
def vid_frames(v):
    d = P / 'src' / v; return sorted(d.glob('*.jpg'))
@lru_cache(maxsize=64)
def _vf(v, k):
    fs = vid_frames(v); return arr(Image.open(fs[min(max(k, 0), len(fs) - 1)]))
def vid_arr(v, tv):
    fps = 24 if v == 'v1' else 30; f = tv * fps; k = int(f); r = f - k
    return _vf(v, k) * (1 - r) + _vf(v, k + 1) * r if r > .05 else _vf(v, k)
def vid_frame(v, tv): return img(vid_arr(v, tv))

def pillar_of(fg_im, z=1.0):
    """竖图进 16:9：背景同图模糊压暗"""
    small = fg_im.resize((64, 96)).filter(ImageFilter.GaussianBlur(3))
    bg = small.resize((W, H), Image.BILINEAR)
    bg = img(arr(bg) * .35)
    h = int(H * z); w = round(fg_im.width * h / fg_im.height)
    fg = fg_im.resize((w, h), Image.BILINEAR)
    bg.paste(fg, ((W - w) // 2, (H - h) // 2)); return bg

def letterbox(frame):
    base = Image.new('RGB', (W, H), 'black'); base.paste(frame, (0, (H - frame.height) // 2)); return base

# —— 打斗冲击
@lru_cache(maxsize=1)
def speed_lines():
    rng = np.random.default_rng(4); m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    for _ in range(140):
        a = rng.uniform(0, 2 * math.pi); r0 = rng.uniform(300, 520); r1 = r0 + rng.uniform(300, 900)
        w = int(rng.integers(2, 6))
        d.line([(W / 2 + r0 * math.cos(a), H / 2 + r0 * math.sin(a)), (W / 2 + r1 * math.cos(a), H / 2 + r1 * math.sin(a))], fill=255, width=w)
    return np.asarray(m.filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255

def radial_blur(a, amt):
    """以画面中心做径向（推镜）模糊：几张逐级放大的图取平均"""
    im = img(a); acc = a.copy(); n = 5
    for j in range(1, n):
        z = 1 + amt * j / n; w, h = W / z, H / z
        acc += arr(im.transform((W, H), Image.EXTENT, ((W - w) / 2, (H - h) / 2, (W + w) / 2, (H + h) / 2), Image.BILINEAR))
    return acc / n

def impact(frame, T, hits):
    """T 时刻叠加最近击打的冲击：推镜、震屏、径向模糊、色散、闪白、速度线；慢放大招加倍"""
    past = [(h, big) for h, big in hits if 0 <= T - h < .45]
    if not past: return frame
    h, big = max(past); dt = T - h; k = 1.5 if big else 1.0
    z = 1 + .06 * k * math.exp(-dt / .16)
    sx = 22 * k * math.exp(-dt / .11) * math.sin(2 * math.pi * 23 * dt)
    sy = 14 * k * math.exp(-dt / .11) * math.cos(2 * math.pi * 19 * dt)
    w, hgt = W / z, H / z
    fr = frame.transform((W, H), Image.EXTENT, ((W - w) / 2 - sx, (H - hgt) / 2 - sy, (W + w) / 2 - sx, (H + hgt) / 2 - sy), Image.BILINEAR)
    a = arr(fr)
    rb = (.06 * math.exp(-dt / .12)) if big else 0     # 径向模糊只给慢放大招
    if rb > .008: a = radial_blur(a, rb)
    sh = int(12 * k * math.exp(-dt / .09))
    if sh: a[..., 0] = np.roll(a[..., 0], sh, 1); a[..., 2] = np.roll(a[..., 2], -sh, 1)
    sl = speed_lines() * ((.3 * math.exp(-dt / .14)) if big else (.12 * math.exp(-dt / .08)))
    a = a + sl[..., None] * np.array([1, .95, .85])
    a = a + .22 * k * math.exp(-dt / .04)
    return img(a)

# —— 字幕（三语）
LANG_COL = {'普': (255, 255, 255), '英': (150, 205, 255), '粤': (255, 205, 120)}
WHO_COL = {'穆清': (180, 225, 255), '沈烬': (200, 160, 255), '梁伯': (255, 205, 140), '阿棠': (255, 160, 150),
           'Rokid': (140, 235, 210), '司机': (210, 210, 210), '旁白': (255, 255, 255)}
TEAL = (110, 240, 205)
@lru_cache(maxsize=64)
def sub_layers(lid):
    """HUD 字幕：玻璃面板 + 角标 + 抬头（说话人 · 语种 · 翻译方向）+ 原文 + 中文。
    返回 (面板层, 文字层, 面板框)，动画时面板横向展开、文字从左往右扫出"""
    x = LINES[lid]; lg, who = x['lg'], x['who']
    main = x.get('sub') or x['zh']; orig = x['zh'] if lg != '普' else None
    fm, fo, fh = F(42), F(28), F(22, True)
    probe = ImageDraw.Draw(Image.new('L', (1, 1)))
    wmain = probe.textlength(main, font=fm); worig = probe.textlength(orig, font=fo) if orig else 0
    pw = int(max(wmain, worig, 420) + 96); ph = 132 + (44 if orig else 0)
    x0 = (W - pw) // 2; y1 = H - 46; y0 = y1 - ph
    pan = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(pan)
    d.rounded_rectangle((x0, y0, x0 + pw, y1), 10, fill=(4, 18, 22, 168), outline=TEAL + (150,), width=2)
    L = 26
    for cx, cy, sx, sy in [(x0, y0, 1, 1), (x0 + pw, y0, -1, 1), (x0, y1, 1, -1), (x0 + pw, y1, -1, -1)]:
        d.line([(cx, cy + sy * L), (cx, cy), (cx + sx * L, cy)], fill=TEAL + (255,), width=4)
    d.line([(x0 + 24, y0 + 50), (x0 + pw - 24, y0 + 50)], fill=TEAL + (70,), width=1)
    txt = Image.new('RGBA', (W, H), (0, 0, 0, 0)); t = ImageDraw.Draw(txt)
    hx = x0 + 28; hy = y0 + 14
    t.ellipse((hx, hy + 6, hx + 12, hy + 18), fill=WHO_COL.get(who, TEAL) + (255,))
    t.text((hx + 22, hy), who, font=fh, fill=WHO_COL.get(who, TEAL) + (255,))
    tagx = hx + 22 + t.textlength(who, font=fh) + 16
    tag = {'普': '普', '英': 'EN', '粤': '粤'}[lg]; tw = t.textlength(tag, font=F(18, True)) + 18
    t.rounded_rectangle((tagx, hy + 1, tagx + tw, hy + 27), 6, outline=LANG_COL[lg] + (255,), width=2)
    t.text((tagx + 9, hy + 3), tag, font=F(18, True), fill=LANG_COL[lg] + (255,))
    if lg != '普':
        t.text((tagx + tw + 14, hy + 2), f'实时翻译 · {tag} → 中文', font=F(18), fill=TEAL + (220,))
    elif who == '旁白':
        t.text((tagx + tw + 14, hy + 2), 'ROKID · 字幕', font=F(18), fill=TEAL + (160,))
    yy = y0 + 64
    if orig:
        t.text(((W - worig) / 2, yy), orig, font=fo, fill=LANG_COL[lg] + (255,)); yy += 44
    t.text(((W - wmain) / 2, yy), main, font=fm, fill=(255, 255, 255, 255))
    return pan, txt, (x0, y0, x0 + pw, y1)

def subs(frame, T):
    for sc in TL:
        for lid, a0, du in sc['lines']:
            if not (a0 - .12 <= T <= a0 + du + .3): continue
            pan, txt, (x0, y0, x1, y1) = sub_layers(lid)
            ti = T - (a0 - .12); out = a0 + du + .3 - T
            op = ease(ti / .16); al = min(1.0, out / .18)
            cx = (x0 + x1) / 2; hw = (x1 - x0) / 2 * (.15 + .85 * op)
            box = (int(cx - hw), y0, int(cx + hw), y1)
            pl = pan.crop(box)
            if al < 1: pl.putalpha(pl.getchannel('A').point(lambda v: int(v * al)))
            frame.paste(pl, box[:2], pl)
            wipe = ease((ti - .1) / .35)
            if wipe > 0:
                wx = int(x0 + (x1 - x0) * wipe)
                tl = txt.crop((x0, y0, wx, y1))
                if al < 1: tl.putalpha(tl.getchannel('A').point(lambda v: int(v * al)))
                frame.paste(tl, (x0, y0), tl)
                if wipe < 1:   # 扫描线
                    d = ImageDraw.Draw(frame); d.line([(wx, y0 + 8), (wx, y1 - 8)], fill=TEAL, width=3)
    return frame

# ================= 各类镜头 =================
def detect(a, maxfrac=.03):
    R, G, B = a[..., 0] * 255, a[..., 1] * 255, a[..., 2] * 255
    m = ndi.binary_fill_holes(ndi.binary_closing((R > 185) & (R > G * 1.3) & (B < 120) & (G > 35), iterations=2))
    lab, n = ndi.label(m); out = []; HW = a.shape[0] * a.shape[1]
    for i, sl in enumerate(ndi.find_objects(lab)):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start; A = (lab[sl] == i + 1).sum()
        if A < HW * .00012 or A > HW * maxfrac or A / (h * w) < .45 or not .5 < h / w < 2.4: continue
        out.append(dict(lab=i + 1, cx=(sl[1].start + sl[1].stop) / 2, cy=(sl[0].start + sl[0].stop) / 2, A=A, r=math.sqrt(A / math.pi)))
    return lab, out

def unlit(a, lab, L):
    """灯灭：灯体变成暗红纸色（保留纹理），并扣掉周围光晕"""
    m = np.isin(lab, [l['lab'] for l in L])
    md = ndi.gaussian_filter(ndi.binary_dilation(m, iterations=6).astype(np.float32), 3)
    lum = a.mean(-1, keepdims=True)
    dark = lum * np.array([.42, .10, .09]) + np.array([.025, .005, .005])
    halo = np.zeros(m.shape, np.float32)
    for l in L: halo += ndi.gaussian_filter((lab == l['lab']).astype(np.float32), l['r'] * 1.5) * 3
    halo = np.clip(halo, 0, 1)
    return (a * (1 - md[..., None]) + dark * md[..., None]) * (1 - .6 * halo[..., None])

@lru_cache(maxsize=2)
def lantern_set(name, mode):
    """mode=out：亮→灭；mode=on：灭→亮（带光晕）。返回 (A_lit, A_dark, 分组掩膜)"""
    a = arr(fit(SRC / name)); lab, L = detect(a, .12)
    L = sorted(L, key=lambda l: l['cx'] if mode == 'out' else abs(l['cx'] - 1005) + abs(l['cy'] - 392))
    dark = unlit(a, lab, L)
    lit = a if mode == 'out' else glow(a, np.isin(lab, [l['lab'] for l in L]).astype(np.float32) * .6, LANT, core=.3, s1=5, s2=22, k1=.7, k2=.6)
    n = 9; groups = [L[i::n] for i in range(n)] if mode == 'on' else [L[i * len(L) // n:(i + 1) * len(L) // n] for i in range(n)]
    masks = []
    for g in groups:
        m = np.zeros(a.shape[:2], np.float32)
        for l in g:
            one = ndi.binary_dilation(lab == l['lab'], iterations=6).astype(np.float32)
            m = np.maximum(m, np.clip(ndi.gaussian_filter(one, l['r'] * 1.2) * 3, 0, 1))
        masks.append(m)
    return lit.astype(np.float32), dark.astype(np.float32), masks

@lru_cache(maxsize=4)
def ero_field(key, src, R, seed, ymin=None):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    Rx, Ry = R
    d = np.hypot((xx - src[0]) / Rx, (yy - src[1]) / Ry)
    if ymin is not None: d = d + np.clip((ymin - yy) / 70, 0, None)
    return d - (noise((H, W), 9, seed) * .55 + noise((H, W), 2.5, seed + 1) * .25)

@lru_cache(maxsize=2)
def edge_field(seed):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    e = np.minimum.reduce([xx, W - xx, yy * 1.6, (H - yy) * 1.6]) / 400
    return e - (noise((H, W), 10, seed) * .6 + noise((H, W), 2.5, seed + 1) * .3)

def apply_ero(a, f, t, small=False):
    inside = np.clip((t - f) / .03, 0, 1); edge = np.clip(1 - np.abs(f - t) / .025, 0, 1)
    a = a * (1 - inside[..., None] * .9) + inside[..., None] * np.array([.02, .01, .03])
    if small:   # 低分辨率算发光，省时
        e2 = edge[::4, ::4]; g = (ndi.gaussian_filter(e2, 1) * 1.1 + ndi.gaussian_filter(e2, 4) * .7)
        g = np.asarray(Image.fromarray((np.clip(g, 0, 4) * 60).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 60
        return a + (edge * .9 + g)[..., None] * np.array(PURPLE) / 255
    return glow(a, edge, PURPLE, core=.9, s1=3, s2=14, k1=1.1, k2=.7)

@lru_cache(maxsize=1)
def knot_geom():
    paths = knot_paths(W / 2, 380, 84)
    segs = []
    for p in paths:
        for q0, q1 in zip(p, p[1:]): segs.append((q0, q1, math.hypot(q1[0] - q0[0], q1[1] - q0[1])))
    return segs, sum(s[2] for s in segs)

def draw_knot(frac, scale_glow=1.0):
    segs, total = knot_geom(); m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m); acc = 0
    for q0, q1, L in segs:
        if acc > frac * total: break
        if acc + L > frac * total:
            r = (frac * total - acc) / L; q1 = (q0[0] + (q1[0] - q0[0]) * r, q0[1] + (q1[1] - q0[1]) * r)
        d.line([q0, q1], fill=255, width=7); acc += L
    return np.asarray(m).astype(np.float32) / 255

def title_text(im, alpha, y=620):
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    t = '这条街照常过年'; f = F(104, True, song=True); tw = d.textlength(t, font=f)
    d.text(((W - tw) / 2, y), t, font=f, fill=(255, 226, 170, int(255 * alpha)))
    t2 = 'THE STREET KEEPS ITS NEW YEAR'; f2 = F(24); d.text(((W - d.textlength(t2, font=f2)) / 2, y + 130), t2, font=f2, fill=(210, 175, 120, int(255 * alpha)))
    im.paste(Image.alpha_composite(im.convert('RGBA'), lay).convert('RGB')); return im

CARDS = [('image4.jpeg', '穆清', '守护者 · 异能「御线」', (255, 210, 130)), ('image5.jpeg', '阿棠', '舞狮队领队 · 三语控场', (255, 160, 150)),
         ('image6.jpeg', '梁伯', '彩扎工坊主人 · 师傅', (255, 205, 140)), ('image7.jpeg', '沈烬', '来犯者 · 异能「蚀光」', (200, 160, 255))]
@lru_cache(maxsize=1)
def card_bg():
    return img(arr(fit(SRC / 'image3.jpeg').filter(ImageFilter.GaussianBlur(24))) * .28)

def render_shot(sc, T):
    k, o, lt = sc['kind'], sc['o'], T - sc['a']; dur = sc['b'] - sc['a']; pr = lt / dur
    sec = section(sc['i'])
    if k == 'img' or k == 'pillar':
        z0, z1 = o.get('z', (1, 1.06)); z = z0 + (z1 - z0) * ease(pr) 
        if k == 'img':
            pan = o.get('pan', (0, 0)); im = kb(src_img(o['src'], o.get('crop')), z, .5 + pan[0] * pr, .5 + pan[1] * pr)
        else:
            im = pillar_of(Image.open(SRC / o['src']).convert('RGB'), .92 * z)
            if o.get('dark'):
                a = arr(im) * (.85 - .25 * pr); a = apply_ero(a, edge_field(41), .05 + .2 * pr, small=True); im = img(a)
        return im
    if k == 'vid':
        if o.get('slow') or o.get('speed'):
            tv = src_time(sc, lt); spd = (speed_at(tv, o['slow']) if o.get('slow') else o['speed'])
        else:
            tv = o['t0'] + lt; spd = 1.0
        a = vid_arr(o['v'], tv)
        if spd < .45 and o.get('fight'):          # 慢放时的残影：叠前几帧（变亮混合）+ 冷调
            for back, wgt in ((.06, .35), (.12, .18)):
                a = np.maximum(a, vid_arr(o['v'], max(tv - back, 0)) * wgt + a * (1 - wgt))
            g = a.mean(-1, keepdims=True); a = (a * .7 + g * .3) * np.array([.95, 1.0, 1.08]); a = np.clip((a - .5) * 1.12 + .5, 0, 1)
        fr = img(a)
        im = pillar_of(fr) if o['v'] == 'v1' else letterbox(fr)
        if o.get('pool'):
            a = arr(im); a = apply_ero(a, ero_field('pool', (525, 685), (400, 170), 9, 571), .1 + .32 * ease(pr / .9), small=True); im = img(a)
        if o.get('fight'):
            im = impact(im, T, global_hits())
        if o.get('bloom'):
            a = arr(im); b = np.clip(a - .65, 0, 1); a = a + ndi.gaussian_filter(b[::4, ::4], (3, 3, 0)).repeat(4, 0).repeat(4, 1)[:H, :W] * np.array([1.2, .9, .5]); im = img(a)
        return im
    if k == 'lantern':
        im = Image.open(OUT / 'lone_lantern.png') if (OUT / 'lone_lantern.png').exists() else make_lone()
        a = arr(im) * min(1, lt / 1.2)
        a = apply_ero(a, edge_field(21), -.25 + .62 * ease(pr), small=True)
        return img(a)
    if k == 'title':
        a = np.zeros((H, W, 3), np.float32) + .008
        fr = ease(lt / 2.0); m = draw_knot(fr)
        a = glow(a, m, GOLD, core=1.15, s1=3, s2=26, k1=1.4, k2=1.4 + .8 * math.exp(-max(lt - 2.0, 0) / .4) * (lt > 2.0))
        im = img(a); return title_text(im, ease((lt - 2.0) / .8))
    if k == 'cards':
        j = min(int(lt / (3 * BEAT)), 3); cl = lt - j * 3 * BEAT
        src, name, role, col = CARDS[j]
        im = card_bg().copy()
        x_in = 1 - ease(cl / .28)
        por = Image.open(SRC / src).convert('RGB').resize((round(396 * 900 / 941), 900), Image.LANCZOS)
        px = int(420 + 700 * x_in); im.paste(por, (px, 90))
        if j == 3:
            a = arr(im) * np.array([.85, .8, 1.0]); a = apply_ero(a, edge_field(31), .1 + .1 * ease(cl / (3 * BEAT)), small=True); im = img(a)
        d = ImageDraw.Draw(im); al = ease((cl - .1) / .3)
        lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); dl = ImageDraw.Draw(lay)
        dl.text((980 + 80 * (1 - al), 330), name, font=F(150, True, song=True), fill=col + (int(255 * al),))
        dl.text((990 + 80 * (1 - al), 540), role, font=F(40), fill=(235, 235, 235, int(255 * al)))
        dl.line([(990, 520), (990 + 520 * al, 520)], fill=col + (int(200 * al),), width=3)
        im = Image.alpha_composite(im.convert('RGBA'), lay).convert('RGB')
        if cl < .1: im = img(arr(im) + .35 * (1 - cl / .1))
        return im
    if k in ('lanterns_out', 'lanterns_on'):
        lit, dark, masks = lantern_set(o['src'], 'out' if k == 'lanterns_out' else 'on')
        nb = int(lt / BEAT); M = np.zeros(lit.shape[:2], np.float32)
        for gi, m in enumerate(masks):
            tb = (gi + 1) * BEAT * (1 if k == 'lanterns_out' else 1)
            if lt >= tb: M = np.maximum(M, m * ease((lt - tb) / .12))
        Gf = ease(min(nb, 9) / 9)
        if k == 'lanterns_out':
            a = (lit * (1 - M[..., None]) + dark * M[..., None]) * (1 - .32 * Gf)
            a = apply_ero(a, ero_field('alley', (300, 1180), (900, 420), 13, 760), .1 + .45 * ease(pr), small=True)
            z = 1 + .05 * pr
        else:
            a = dark * (.45 + .55 * Gf) * (1 - M[..., None]) + lit * M[..., None]
            if lt > 10 * BEAT:
                kc = np.zeros((H // 4, W // 4), np.float32); kc[98, 251] = 1
                g = ndi.gaussian_filter(kc, 10) * 2000 * ease((lt - 10 * BEAT) / .5)
                g = np.asarray(Image.fromarray(np.clip(g * 255, 0, 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 255
                a = a + g[..., None] * np.array(GOLD) / 255 * .8
            z = 1.06 - .06 * pr
        im = img(a); w, h = W / z, H / z
        return im.transform((W, H), Image.EXTENT, ((W - w) / 2, (H - h) / 2, (W + w) / 2, (H + h) / 2), Image.BILINEAR)
    if k == 'photo':
        base = kb(src_img(o['src']), 1.0 + .03 * min(pr, .5))
        tf = BAR
        if lt < tf: return base
        dt = lt - tf; s = 1 - .14 * ease(dt / .5); ang = -2.5 * ease(dt / .5)
        bg = img(arr(base.filter(ImageFilter.GaussianBlur(14))) * .45)
        ph = base.resize((int(W * s), int(H * s)), Image.BILINEAR)
        frame = Image.new('RGB', (ph.width + 36, ph.height + 36), (250, 248, 240)); frame.paste(ph, (18, 18))
        fr = frame.rotate(ang, expand=True, resample=Image.BICUBIC, fillcolor=(0, 0, 0))
        mask = Image.new('L', frame.size, 255).rotate(ang, expand=True)
        bg.paste(fr, ((W - fr.width) // 2, (H - fr.height) // 2 - 10), mask)
        return img(arr(bg) + .9 * math.exp(-dt / .08))
    if k == 'end':
        a = np.zeros((H, W, 3), np.float32) + .012
        im = img(a); lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
        al1 = ease(lt / .8) * (1 - ease((lt - 3.2) / .6)); t1 = '饭还热着，年照常过。'; f1 = F(76, True, song=True)
        d.text(((W - d.textlength(t1, font=f1)) / 2, 470), t1, font=f1, fill=(255, 236, 200, int(255 * al1)))
        im = Image.alpha_composite(im.convert('RGBA'), lay).convert('RGB')
        if lt > 3.4:
            al = ease((lt - 3.4) / .8); m = draw_knot(1.0)
            a = glow(arr(im), m * al, GOLD, core=1.1, s1=3, s2=22, k1=1.2, k2=1.0)
            im = title_text(img(a), al)
            lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
            t3 = '唐人街春节异能短片  ·  乐奇眼镜 Rokid'; f3 = F(28)
            d.text(((W - d.textlength(t3, font=f3)) / 2, 900), t3, font=f3, fill=(220, 220, 220, int(255 * al)))
            im = Image.alpha_composite(im.convert('RGBA'), lay).convert('RGB')
        return im

def make_lone():
    base = arr(fit(SRC / 'image12.jpeg')); lab, L = lanterns(base)
    l = max(L, key=lambda l: l['A']); cx, cy, r = l['cx'], l['cy'], l['r']
    crop = img(base).crop((int(cx - r * 3), int(cy - r * 3), int(cx + r * 3), int(cy + r * 3))).resize((560, 560), Image.LANCZOS)
    a = np.zeros((H, W, 3), np.float32) + .008; c = arr(crop); yy, xx = np.mgrid[0:560, 0:560]
    m = np.clip(1 - (np.hypot(xx - 280, yy - 280) - 130) / 150, 0, 1)[..., None]
    a[260:820, 680:1240] = a[260:820, 680:1240] * (1 - m) + c * m
    im = img(a); im.save(OUT / 'lone_lantern.png'); return im

def frame_at(n):
    global VIG
    if VIG is None: VIG = vignette()
    T = n / FPS
    sc = next((s for s in TL if s['a'] <= T < s['b']), TL[-1])
    im = render_shot(sc, T)
    if sc['kind'] not in ('title', 'end', 'lantern'):
        im = img(arr(im) * VIG)
    # 段落交界：沈烬登场前压黑、打斗前闪白
    if sc['i'] == 11 and T - sc['a'] < .3: im = img(arr(im) * ((T - sc['a']) / .3))
    im = subs(im, T)
    im.save(OUT / 'frames' / f'{n:05d}.jpg', quality=90)
    return n

def frames(only=None):
    N = int(TOTAL * FPS) + 1
    make_lone()
    todo = [n for n in range(N) if only is None or n in only]
    with Pool(10) as p:
        for k, _ in enumerate(p.imap_unordered(frame_at, todo, chunksize=8)):
            if k % 300 == 0: print('frame', k, '/', len(todo), flush=True)

# ================= 声音 =================
def audio():
    sys.path.insert(0, LIB)
    import soundfile as sf, soxr
    from core.audio import sampler as A
    from core.audio import sfx as X
    from core.audio.sfx import SR, add
    A.seed(7)
    N = int((TOTAL + 1.5) * SR)
    vo = np.zeros((N, 2), np.float32)
    for sc in TL:
        for lid, a0, du in sc['lines']:
            x, sr = sf.read(P / 'vo' / f'{lid}.wav', dtype='float32')
            if x.ndim > 1: x = x.mean(1)
            x = soxr.resample(x, sr, SR)
            if LINES[lid]['who'] == 'Rokid':      # 眼镜里的声音：略收窄频带
                x = X.hp(x, 260) * 1.15
            add(vo, x, a0, 1.0, 0)
    ev = []
    nbar = int(math.ceil(TOTAL / BAR))
    def sec_at(t):
        sc = next((s for s in TL if s['a'] <= t + 1e-6 < s['b']), TL[-1]); return section(sc['i']), sc
    FEST = [('D', ['D', 'F#', 'A']), ('B', ['B', 'D', 'F#']), ('G', ['G', 'B', 'D']), ('A', ['A', 'C#', 'E'])]
    DARK = [('D', ['D', 'F', 'A']), ('A#', ['A#', 'D', 'F']), ('C', ['C', 'E', 'G']), ('A', ['A', 'C#', 'E'])]
    MEL = [(0, 'A4', 1), (1, 'B4', .5), (1.5, 'A4', .5), (2, 'F#4', 1), (3, 'E4', 1), (4, 'D4', 1.5), (5.5, 'E4', .5), (6, 'F#4', 1), (7, 'A4', 1),
           (8, 'B4', 1), (9, 'D5', 1), (10, 'B4', .5), (10.5, 'A4', .5), (11, 'F#4', 1), (12, 'A4', 2.5), (14.5, 'B4', .5), (15, 'A4', 1)]
    MEL2 = [(0, 'D5', 1), (1, 'E5', .5), (1.5, 'D5', .5), (2, 'B4', 1), (3, 'A4', 1), (4, 'B4', 1.5), (5.5, 'D5', .5), (6, 'E5', 1), (7, 'F#5', 1),
            (8, 'E5', 1), (9, 'D5', 1), (10, 'B4', .5), (10.5, 'A4', .5), (11, 'B4', 1), (12, 'D5', 3), (15, 'A4', 1)]
    fest_bar = 0
    for b in range(nbar):
        t0 = b * BAR; s, sc = sec_at(t0)
        if s == 'cold':
            ev.append((t0, 'timpani', 'D2', 2, .35 if b else .5, 0))
            ev.append((t0 + 2 * BEAT, 'frame_drum', 'large', None, .3, 0))
            if b == 3: ev.append((t0, 'gong', None, 6, .7, 0))
            if b == 4: ev.append((t0 + 2 * BEAT, 'sus_cymbal', 'cresc', 2 * BEAT, .5, 0))
            if b <= 2: ev.append((t0, 'cellos', 'D2', BAR, .2, .2))
        elif s in ('fest', 'climax'):
            root, ch = FEST[fest_bar % 4]; big = s == 'climax'
            for st in (0, 3, 4, 6):
                ev.append((t0 + st * BEAT / 2, 'bass_drum', None, None, .75 if st in (0, 4) else .5, 0))
            for st in (2, 5, 7):
                ev.append((t0 + st * BEAT / 2, 'toms', 'high', None, .35, -.2))
            for st in (2, 6):
                ev.append((t0 + st * BEAT / 2, 'clash', 'short', None, .45 if big else .32, .25))
            if fest_bar % 2 == 0: ev.append((t0 + BEAT * 2, 'gong2', 'small', 1.2, .3, -.3))
            if fest_bar % 4 == 3:
                for j in range(4): ev.append((t0 + 3 * BEAT + j * BEAT / 4, 'toms', 'high', None, .3 + .08 * j, -.2))
            ev.append((t0, 'cellos_pizz', root + '2', BEAT, .5, .1)); ev.append((t0 + 2 * BEAT, 'cellos_pizz', ch[2] + '2', BEAT, .45, .1))
            for j in (1, 3):
                for p in ch: ev.append((t0 + j * BEAT, 'piano', p + '4', BEAT * .5, .22, -.25))
            mel = (MEL2 if big else MEL)
            base = (fest_bar % 4) * 4
            for bt, p, dd in mel:
                if base <= bt < base + 4:
                    ev.append(dict(t=t0 + (bt - base) * BEAT, inst='erhu', pitch=p, dur=dd * BEAT * .95, vel=.42 if not big else .5, pan=.15, attack=.03))
                    if big: ev.append((t0 + (bt - base) * BEAT, 'flute', A.name(A.midi(p) + 12), dd * BEAT * .9, .28, -.2))
            if big:
                ev.append((t0, 'horn', root + '3', BAR, .3, -.1)); ev.append((t0, 'contrabass', root + '2', BAR, .35, 0))
                if fest_bar % 2 == 0: ev.append((t0, 'crash', None, None, .5, .3))
            fest_bar += 1
        elif s == 'dark':
            root, ch = DARK[b % 4]
            ev.append((t0, 'timpani', 'D2', 2, .5, 0)); ev.append((t0 + 2.5 * BEAT, 'timpani', 'D2', 1, .3, 0))
            ev.append(dict(t=t0, inst='erhu', pitch=['D4', 'F4', 'E4', 'A4'][b % 4], dur=BAR * .95, vel=.32, pan=.15, attack=.4))
            ev.append(dict(t=t0, inst='cellos', pitch=root + '2', dur=BAR, vel=.3, pan=.2, attack=.3))
            ev.append(dict(t=t0, inst='violins', pitch=ch[1] + '4', dur=BAR, vel=.15, pan=.3, attack=.6))
            if b % 2 == 0: ev.append((t0, 'gong2', 'small', 2, .25, -.3))
        elif s == 'pulse':
            root, ch = DARK[b % 4]
            for j in range(8):
                ev.append((t0 + j * BEAT / 2, 'cellos_spic', root + '2', BEAT * .4, .35 + .02 * j, .2))
                ev.append((t0 + j * BEAT / 2, 'frame_drum', 'small_muted', None, .25 + .03 * j, -.2))
            ev.append(dict(t=t0, inst='violins', pitch=ch[(b % 3)] + '4', dur=BAR, vel=.22, pan=.3, attack=.2))
            if b == int(FIGHT0['a'] / BAR) - 1: ev.append((t0 + 2 * BEAT, 'sus_cymbal', 'cresc', 2 * BEAT, .55, 0))
        elif s == 'fight':
            # 激烈段：太鼓式大鼓 + 16 分音符军鼓/通鼓 + 弦乐断奏固定音型 + 铜管重音 + 二胡尖锐短弓
            root, ch = DARK[b % 4]; fb = b - int(FIGHT0['a'] / BAR)
            for st in (0, 3, 6, 8, 10, 11, 14):
                ev.append((t0 + st * BEAT / 4, 'bass_drum', None, None, .9 if st in (0, 8) else .62, 0))
            for st in (0, 8): ev.append((t0 + st * BEAT / 4, 'gran_cassa', 'hit', None, .75, 0))
            for st in (0, 7, 10): ev.append((t0 + st * BEAT / 4, 'frame_drum', 'large', None, .6, -.15))
            for st in (4, 12): ev.append((t0 + st * BEAT / 4, 'snare2', 'on', None, .62, .1))
            for st in range(16):
                if st not in (4, 12): ev.append((t0 + st * BEAT / 4, 'snare2', 'taps', None, .16 + .04 * (st % 4 == 2), .15))
            fill = range(8, 16) if fb % 2 == 1 else range(12, 16)
            for st in fill: ev.append((t0 + st * BEAT / 4, 'toms', 'low_mallet' if st % 2 else 'high_mallet', None, .45 + .03 * (st - 8), -.25 + .05 * (st % 4)))
            riff = [root, root, ch[1], root, ch[2], root, ch[1], ch[0]]
            for j, n_ in enumerate(riff * 2):
                ev.append((t0 + j * BEAT / 4, 'cellos_spic', n_ + '2', BEAT * .22, .5, .2))
                ev.append((t0 + j * BEAT / 4, 'violins_spic', n_ + '4', BEAT * .22, .36, -.3))
            for tt, nn in ((0, root), (1.5, root), (2.5, ch[2]), (3.25, ch[1])):
                ev.append((t0 + tt * BEAT, 'trombone_stac', nn + '2', BEAT * .5, .62, -.1))
                ev.append((t0 + tt * BEAT, 'horn_stac', nn + '3', BEAT * .5, .5, .1))
            if fb % 2 == 0:
                ev.append((t0, 'crash', None, None, .55, .3))
                ev.append((t0, 'trumpet_stac', ch[2] + '4', BEAT * .5, .5, 0)); ev.append((t0 + .75 * BEAT, 'trumpet_stac', ch[2] + '4', BEAT * .4, .45, 0))
            ev.append((t0, 'contrabass', root + '1', BAR, .45, 0))
            ev.append(dict(t=t0, inst='violins_trem', pitch=ch[0] + '5', dur=BAR, vel=.22, pan=.3, attack=.05))
            for j, n_ in enumerate(['D5', 'F5', 'E5', 'D5', 'A4', 'A#4', 'A4', 'G4'] if fb % 2 == 0 else ['F5', 'G5', 'A5', 'G5', 'F5', 'E5', 'D5', 'E5']):
                ev.append(dict(t=t0 + j * BEAT / 2, inst='erhu_stac', pitch=n_, dur=BEAT * .45, vel=.5, pan=.15))
            ev.append(dict(t=t0, inst='timpani', pitch='D2', dur=1, vel=.7, pan=0))
        elif s == 'warm':
            root, ch = FEST[b % 4]
            for j, p in enumerate([ch[0] + '3', ch[2] + '3', ch[0] + '4', ch[1] + '4', ch[2] + '4', ch[1] + '4', ch[0] + '4', ch[2] + '3']):
                ev.append((t0 + j * BEAT / 2, 'piano', p, BEAT, .3, -.15))
            ev.append(dict(t=t0, inst='cellos', pitch=root + '2', dur=BAR, vel=.25, pan=.2, attack=.3))
            ev.append(dict(t=t0, inst='erhu', pitch=['F#4', 'D4', 'B4', 'A4'][b % 4], dur=BAR * .9, vel=.3, pan=.15, attack=.2))
            ev.append((t0, 'frame_drum', 'small', None, .18, 0))
    # 卡点：人物卡、灯笼明灭、拍照、片尾
    for sc in TL:
        if sc['kind'] == 'cards':
            for j in range(4):
                tj = sc['a'] + j * 3 * BEAT; ev.append((tj, 'clash', 'short', None, .5, 0)); ev.append((tj, 'bass_drum', None, None, .8, 0))
        if sc['kind'] == 'lanterns_out':
            for g in range(9): ev.append((sc['a'] + (g + 1) * BEAT, 'toms', 'low_mallet', None, .45, -.2 + .05 * g))
        if sc['kind'] == 'lanterns_on':
            for g in range(9): ev.append((sc['a'] + (g + 1) * BEAT, 'glockenspiel', ['D6', 'E6', 'F#6', 'A6', 'B6', 'D7', 'B6', 'A6', 'D7'][g], 1.2, .3, .3 - .07 * g))
            ev.append((sc['a'] + 10 * BEAT, 'gong', None, 6, .7, 0)); ev.append((sc['a'] + 10 * BEAT, 'crash', None, None, .6, 0))
        if sc['kind'] == 'title':
            ev.append((sc['a'] + 2.0, 'gong2', 'big', 5, .6, 0))
        if sc['kind'] == 'end':
            for p in ['D2', 'D3', 'A3', 'D4', 'F#4', 'A4']: ev.append((sc['a'], 'piano', p, 5, .38, -.1))
            ev.append(dict(t=sc['a'], inst='erhu', pitch='A4', dur=3.2, vel=.32, pan=.15, attack=.2))
            ev.append((sc['a'] + 3.4, 'gong2', 'small', 4, .45, 0))
            for p in ['D4', 'F#4', 'A4', 'D5']: ev.append(dict(t=sc['a'] + 3.4, inst='violins', pitch=p, dur=3.6, vel=.22, pan=.3, attack=.3))
    mus = A.render(ev, dur=TOTAL + 1.5)[:N]
    mus = A.room(mus, size=.45, mix=.18)
    # 音效：打斗击打、拍照快门、片头一盏灯的环境声
    sfx = np.zeros((N, 2), np.float32)
    for h, big in global_hits():
        if big:   # 慢放大招：反向风声 + 低频轰 + 锣 + 镲
            add(sfx, X.whoosh(.5, .7), h - .48, .9, 0); add(sfx, X.thump(1.0, 42), h, 1.2, 0); add(sfx, X.thump(1.0, 70), h, .8, 0)
            add(sfx, A.hit(A.load('gong'), None, .6), h, .5, 0); add(sfx, A.hit(A.load('crash'), None, .7), h, .7, .2)
        else:
            add(sfx, X.whoosh(.2, .5), h - .18, .8, 0); add(sfx, X.thump(1.0, 60), h, .9, 0)
            add(sfx, A.hit(A.load('clash'), 'short', .55), h, .55, .2)
    for sc in TL:
        if sc['kind'] == 'photo': add(sfx, X.click(1.0, 1.0), sc['a'] + BAR - .02, .9, 0)
        if sc['kind'] == 'img' and sc['o'].get('shake'):
            for j in range(4): add(sfx, X.thump(.8, 70), sc['a'] + j * BEAT, .6, 0)
    # 旁白下压音乐
    env = np.abs(vo).mean(1); k = int(.25 * SR)
    env = np.convolve(env, np.ones(k) / k, mode='same')
    duck = 1 - .55 * np.clip(env / .02, 0, 1)
    tt_ = np.arange(N) / SR; fz = (tt_ >= FIGHT0['a']) & (tt_ < CLIMAX0['a'])
    duck = np.where(fz, 1 - .3 * np.clip(env / .02, 0, 1), duck); duck = np.convolve(duck, np.ones(int(.4 * SR)) / int(.4 * SR), mode='same')[:, None]
    fgain = np.where(fz, .85, .62)[:, None]
    mix = vo * 1.0 + mus * fgain * duck + sfx * .75
    sf.write(OUT / 'mix_raw.wav', mix.astype(np.float32), SR)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(OUT / 'mix_raw.wav'), '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', str(OUT / 'mix.wav')], check=True)
    open(OUT / 'credits_music.txt', 'w').write('\n'.join(A.credits(sorted({(e[1] if isinstance(e, tuple) else e['inst']) for e in ev} | {'clash'}))))
    print('audio', round(N / SR, 1), 's')

def srt():
    def ts(x):
        m, s = divmod(x, 60); return f'00:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}'
    rows, k = [], 1
    for sc in TL:
        for lid, a0, du in sc['lines']:
            x = LINES[lid]; txt = (x.get('sub') or x['zh']) if x['lg'] == '普' else f"{x['zh']}\n{x['sub']}"
            who = '' if x['who'] == '旁白' else f"{x['who']}（{x['lg']}）："
            rows.append(f'{k}\n{ts(a0)} --> {ts(a0 + du + .2)}\n{who}{txt}\n'); k += 1
    open(P.parent.parent / '这条街照常过年_故事介绍.srt', 'w').write('\n'.join(rows))

def mux():
    out = P.parent.parent / '这条街照常过年_故事介绍.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', str(OUT / 'frames/%05d.jpg'), '-i', str(OUT / 'mix.wav'),
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-shortest', str(out)], check=True)
    print(out)

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    print('总长', round(TOTAL, 1), 's ·', len(TL), '镜')
    if cmd == 'test':
        ts = [float(x) for x in sys.argv[2:]]
        make_lone()
        for t in ts: frame_at(int(t * FPS)); print('ok', t)
    if cmd in ('frames', 'all'): frames()
    if cmd in ('audio', 'all'): audio(); srt()
    if cmd in ('mux', 'all'): mux()
