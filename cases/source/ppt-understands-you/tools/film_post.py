"""《懂你的人》书桌版全片后期：字幕 + 贴合透视的 HUD / 速写本手写 + 大字 + 配乐混音 + 合成
用法：python film_post.py [audio|frames|mux|all] [--from N]"""
import os, sys, json, math, re, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

P = os.path.expanduser('~/Desktop/懂你的人/')
D = P + 'film/desk/'
LIB = os.path.expanduser('~/lemo-opuscar')
TL = json.load(open(D + 'timeline.json'))
ANC = json.load(open(D + 'anchors.json'))
FPS, W, H = TL['fps'], 1920, 1080
TOTAL = TL['total']
NF = int(round(TOTAL * FPS))
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
PEN = P + 'tools/fonts/Hanzipen.ttc'
G = (120, 255, 170)
ST = {s['sid']: s for s in TL['stations']}
LT = {l['id']: (l['t'], l['t'] + l['dur']) for s in TL['stations'] for l in s['lines']}
ZH = {l['id']: l['zh'] for s in TL['stations'] for l in s['lines']}
NOSUB = {'q05', 'c16', 'q09', 'q19', 'n25'}
_fc = {}


def ft(s, i=1, path=HIRA):
    k = (s, i, path)
    if k not in _fc:
        _fc[k] = ImageFont.truetype(path, s, index=i)
    return _fc[k]


def clamp(x, a=0., b=1.):
    return max(a, min(b, x))


def ease(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def typed(s, t, t0, cps):
    return s[:int(clamp((t - t0) * cps, 0, len(s)))]


# ---------------------------------------------------------------- 透视贴合
def homography(dst, src):
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def paste_warp(im, layer, quad, glow=True):
    """layer（任意尺寸 RGBA）按四角贴到 im 的 quad（左上、右上、右下、左下）"""
    lw, lh = layer.size
    co = homography(quad, [(0, 0), (lw, 0), (lw, lh), (0, lh)])
    wl = layer.transform((W, H), Image.PERSPECTIVE, co, Image.BICUBIC)
    if glow:
        im.alpha_composite(wl.filter(ImageFilter.GaussianBlur(5)))
    im.alpha_composite(wl)


def quad(sid, f):
    rows = ANC.get(sid, {})
    return rows.get(str(f))


# ---------------------------------------------------------------- 字幕
def chunks(text, n=19):
    parts = re.findall(r'[^，。？！：；]+[，。？！：；]?', text)
    out, cur = [], ''
    for p in parts:
        if len(cur + p) <= n:
            cur += p
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return out


SUBS = []
for lid, (a, b) in LT.items():
    if lid in NOSUB:
        continue
    cs = chunks(ZH[lid])
    tot = sum(len(c) for c in cs)
    cur = a
    for c in cs:
        d = (b - a) * len(c) / tot
        SUBS.append((c.rstrip('，；：'), cur, cur + d, lid.startswith('q')))
        cur += d


# ---------------------------------------------------------------- HUD 层（画在各自的本地坐标里）
def hud_S05(t):
    s = 1.5
    L = Image.new('RGBA', (int(1154 * s), int(144 * s)), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    n0, n1 = LT['n05']
    q0, q1 = LT['q05']
    if t > n0:
        d.text((40 * s, 14 * s), typed('咕噜…咕噜咕噜…', t, n0, 6), font=ft(int(26 * s), 0), fill=(200, 255, 220, 150))
        d.text((1044 * s, 14 * s), '翻译', font=ft(int(24 * s), 0), fill=G + (210,))
    if t > n1 - .3:
        d.line((40 * s, 31 * s, (40 + 210 * ease((t - n1 + .3) / .4)) * s, 31 * s), fill=(200, 255, 220, 170), width=3)
    if t > q0:
        d.text((40 * s, 56 * s), typed(ZH['q05'], t, q0, len(ZH['q05']) / (q1 - q0) * 1.3), font=ft(int(44 * s)), fill=G + (255,))
    return L


def hud_S08(t):
    a0 = ST['S08']['t0'] + 1.4
    L = Image.new('RGBA', (758, 384), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    d.text((140, 48), typed('识别：猫', t, a0, 10), font=ft(36), fill=G + (255,))
    d.text((60, 130), typed('问：如何温柔接近？', t, a0 + .9, 12), font=ft(32, 0), fill=(230, 255, 240, 240))
    d.text((60, 190), typed('答：先让它闻闻手。', t, a0 + 2.4, 10), font=ft(40), fill=G + (255,))
    return L


def hud_S13(t):
    a0 = ST['S13']['t0'] + 1.5
    L = Image.new('RGBA', (640, 340), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    al = ease((t - a0 + .4) / .4)
    d.rounded_rectangle((4, 4, 636, 336), radius=20, fill=(10, 40, 30, int(130 * al)), outline=G + (int(210 * al),), width=4)
    d.text((34, 30), typed('球球状态：持续衰弱', t, a0, 12), font=ft(38), fill=G + (255,))
    lvl = 1 - .78 * ease((t - a0 - 1) / 3)
    d.rectangle((34, 96, 34 + 560 * lvl, 116), fill=(255, 150, 90, 230) if lvl < .45 else G + (230,))
    d.rectangle((34, 96, 594, 116), outline=G + (160,), width=2)
    d.text((34, 150), typed('当前设备：飞船密钥', t, a0 + 1.5, 12), font=ft(34, 0), fill=(230, 255, 240, 240))
    d.text((34, 220), typed('我想回家', t, a0 + 3.0, 6), font=ft(54), fill=(255, 236, 200, 255))
    return L


def hud_S14(t):
    a0 = ST['S14']['t0'] + 1.3
    L = Image.new('RGBA', (764, 390), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    rows = [('乐奇，看一下这是什么？', 30, 0, (255, 240, 210)), ('识别：电路板', 36, 1, G), ('可见元件：电容、铜线圈', 28, 0, (230, 255, 240)),
            ('问：电容有什么作用？', 28, 0, (230, 255, 240)), ('答：储存电能，平滑电压。', 34, 1, G)]
    tt = a0
    for i, (s, sz, w, c) in enumerate(rows):
        d.text((44, 40 + i * 66), typed(s, t, tt, 22), font=ft(sz, w), fill=c + (255,))
        tt += len(s) / 22 + .12
    return L


def hud_S16(t):
    """速写本右页：他把那句话一笔一笔写大"""
    L = Image.new('RGBA', (1040, 950), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    c0, c1 = LT['c16']
    txt = ['我刚那句，', '能不能让我', '再说一遍？']
    total = sum(len(x) for x in txt)
    k = int(clamp((t - c0) / (c1 - c0) * 1.1) * total)
    for i, l in enumerate(txt):
        n = clamp(k, 0, len(l))
        k -= len(l)
        d.text((40 + i * 20, 50 + i * 230), l[:int(n)], font=ft(170 + i * 20, 2, PEN), fill=(214, 74, 36, 235))
    return L


def hud_S23(t):
    t0 = ST['S23']['t0']
    L = Image.new('RGBA', (1920, 1080), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    if t < t0 + 2.6:
        if int(t * 2) % 2 == 0:
            d.ellipse((120, 110, 160, 150), fill=(255, 70, 60, 230))
        d.text((180, 100), '第一视角', font=ft(48, 0), fill=G + (230,))
        d.text((120, 180), typed('把你记住', t, t0 + 1.0, 5), font=ft(110), fill=G + (255,))
    else:
        al = ease((t - t0 - 2.8) / .4)
        d.rounded_rectangle((100, 100, 900, 430), radius=40, fill=(10, 40, 30, int(150 * al)), outline=G + (int(220 * al),), width=6)
        d.text((160, 140), '跨星来电', font=ft(48, 0), fill=G + (int(230 * al),))
        d.text((160, 240), typed('想我没？', t, t0 + 3.2, 5), font=ft(120), fill=(255, 248, 232, 255))
    return L


HUDS = {'S05': hud_S05, 'S08': hud_S08, 'S13': hud_S13, 'S14': hud_S14, 'S16': hud_S16, 'S23': hud_S23}


# ---------------------------------------------------------------- 一帧
def frame(i):
    out = D + f'post/p_{i:04d}.jpg'
    src = D + f'frames/f_{i:04d}.jpg'
    if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(src):
        return
    t = i / FPS
    im = Image.open(src).convert('RGBA')
    for sid, fn in HUDS.items():
        q = quad(sid, i)
        if q and ST[sid]['t0'] <= t < ST[sid]['t1'] + .6:
            paste_warp(im, fn(t), [tuple(p) for p in q], glow=(sid != 'S16'))
    d = ImageDraw.Draw(im)
    # 片头
    if t < 5.0:
        a = ease((t - .6) / .8) * (1 - ease((t - 4.2) / .6))
        d.text((120, 120), '懂你的人', font=ft(120), fill=(255, 250, 238, int(255 * a)), stroke_width=3, stroke_fill=(40, 25, 10, int(110 * a)))
        d.text((126, 280), '乐奇眼镜创意品牌短片', font=ft(34, 0), fill=(255, 248, 235, int(220 * a)), stroke_width=2, stroke_fill=(40, 25, 10, int(90 * a)))
    # 大字
    q0, _ = LT['q09']
    for k, ch in enumerate('再来一根！'):
        ti = q0 + k * .32
        if ti < t < ST['S09']['t1'] + .3:
            p = clamp((t - ti) / .25)
            s = .6 + .5 * math.sin(p * math.pi * .5) + .1 * math.sin(p * math.pi)
            d.text((520 + k * 180, 90 + 18 * math.sin(k * 1.7)), ch, font=ft(int(130 * s)), fill=(255, 214, 90, 255), stroke_width=6, stroke_fill=(60, 25, 10, 255))
    q0, q1 = LT['q10']
    ti = q0 + (q1 - q0) * .52
    if ti < t < ST['S10']['t1'] + .3:
        p = ease((t - ti) / 1.4)
        d.text((110, 110), '很大声地存在。', font=ft(int(40 + 92 * p)), fill=(255, 248, 230, int(255 * clamp((t - ti) / .3))), stroke_width=4, stroke_fill=(10, 20, 60, 160))
    q0, _ = LT['q19']
    for k, ch in enumerate('必须滴！'):
        ti = q0 + k * .12
        if ti < t < ST['S19']['t1'] + .3:
            p = clamp((t - ti) / .3)
            s = .3 + .85 * math.sin(p * math.pi * .5) - .15 * math.sin(p * math.pi)
            g = Image.new('RGBA', (320, 320), (0, 0, 0, 0))
            ImageDraw.Draw(g).text((40, 20), ch, font=ft(int(190 * s)), fill=(255, 214, 90, 255), stroke_width=7, stroke_fill=(30, 40, 90, 255))
            g = g.rotate([-8, 5, -4, 10][k], resample=Image.BICUBIC)
            im.alpha_composite(g, (150 + k * 210, int(40 + 30 * math.sin(k * 1.3))))
    d = ImageDraw.Draw(im)
    # 落版
    b0 = ST['S25']['t0'] + 1.6
    if t > b0:
        a = ease((t - b0) / 1.2)
        for txt, sz, y, c in [('乐奇眼镜', 104, 400, (255, 250, 240)), ('看得见世界，更懂你想说的话。', 42, 570, (238, 232, 222))]:
            w = d.textlength(txt, font=ft(sz))
            d.text(((W - w) / 2, y), txt, font=ft(sz), fill=c + (int(255 * a),), stroke_width=3, stroke_fill=(0, 0, 0, int(120 * a)))
    # 字幕
    for txt, a0, a1, isq in SUBS:
        if a0 - .05 <= t < a1 + .15:
            al = clamp((t - a0 + .05) / .12) * clamp((a1 + .15 - t) / .12)
            y = 60 if ST['S05']['t0'] + 1.5 < t < ST['S05']['t1'] else 985
            w = d.textlength(txt, font=ft(36))
            col = (255, 222, 120) if isq else (255, 250, 240)
            d.text(((W - w) / 2, y), txt, font=ft(36), fill=col + (int(255 * al),), stroke_width=2, stroke_fill=(0, 0, 0, int(170 * al)))
    fo = clamp(min(t / .6, (TOTAL - t) / 1.2))
    rgb = im.convert('RGB')
    if fo < 1:
        rgb = Image.eval(rgb, lambda v: int(v * fo))
    rgb.save(out, quality=93)


# ---------------------------------------------------------------- 声音
def audio():
    sys.path.insert(0, LIB)
    import soundfile as sf, soxr
    from core.audio import sampler as S
    from core.audio.sfx import SR, add
    S.seed(11)
    N = int((TOTAL + 1) * SR)
    vo = np.zeros((N, 2), np.float32)
    for lid, (a, b) in LT.items():
        path = P + ('旁白/wav/' if lid.startswith('q') else '旁白/wav11/') + lid + '.wav'
        x, sr = sf.read(path, dtype='float32')
        add(vo, soxr.resample(x if x.ndim == 1 else x.mean(1), sr, SR), a, 1.0, -.08 if lid.startswith('q') else 0)
    beat = 60 / 76
    bar = beat * 4

    def mood(t):
        for s in TL['stations']:
            if s['t0'] <= t < s['t1']:
                n = int(s['sid'][1:3])
                return ('intro' if n <= 4 else 'play' if n <= 9 else 'warm' if n == 10 else 'low' if n <= 13 else
                        'build' if n <= 15 else 'peak' if n == 16 else 'tender' if n <= 20 else 'lift' if n <= 24 else 'end')
        return 'end'
    MAJ = [('D', ['D', 'F#', 'A']), ('B', ['B', 'D', 'F#']), ('G', ['G', 'B', 'D']), ('A', ['A', 'C#', 'E'])]
    MIN = [('B', ['B', 'D', 'F#']), ('G', ['G', 'B', 'D']), ('E', ['E', 'G', 'B']), ('F#', ['F#', 'A#', 'C#'])]
    ev = []
    brand_t = ST['S25']['t0']
    for k in range(int(brand_t / bar) + 1):
        t0 = k * bar
        m = mood(t0 + .01)
        root, ch = (MIN if m == 'low' else MAJ)[k % 4]
        r2, r3 = root + '2', root + '3'
        c4, c5 = [c + '4' for c in ch], [c + '5' for c in ch]
        if m in ('intro', 'tender', 'warm', 'lift'):
            pat = [ch[0] + '3', ch[2] + '3', ch[0] + '4', ch[1] + '4', ch[2] + '4', ch[1] + '4', ch[0] + '4', ch[2] + '3']
            step = beat / 2 if m != 'tender' else beat
            for i, p in enumerate(pat[:int(bar / step)]):
                ev.append((t0 + i * step, 'piano', p, step * 2.2, .30 if m == 'intro' else .34, -.15))
            ev.append((t0, 'cellos', r2, bar, .26, .25))
        if m in ('warm', 'lift', 'tender'):
            ev.append((t0, 'violins', c5[1], bar, .22, .3))
            ev.append((t0, 'violins', c5[2] if m != 'tender' else c4[2], bar, .18, .35))
        if m == 'warm':
            for i in range(4):
                ev.append((t0 + i * beat, 'celesta', [c5[0], c5[1], c5[2], c5[1]][i], beat, .32, .4))
        if m in ('play', 'lift'):
            for i in (0, 2):
                ev.append((t0 + i * beat, 'cellos_pizz', r2 if i == 0 else ch[2] + '2', beat, .45, .2))
            for i in (1, 3):
                for p in c4:
                    ev.append((t0 + i * beat, 'piano', p, beat * .5, .28, -.2))
            mel = [c5[1], c5[2], c5[0], c5[2]] if k % 2 == 0 else [c5[2], c5[1], c5[0], None]
            for i, p in enumerate(mel):
                if p:
                    ev.append((t0 + i * beat + beat / 2, 'glockenspiel', p, beat, .26, .4))
        if m == 'low':
            ev.append((t0, 'piano', r3, bar, .26, -.1))
            ev.append((t0, 'piano', ch[2] + '3', bar, .2, -.1))
            ev.append((t0 + 2 * beat, 'piano', ch[1] + '4', bar / 2, .2, -.1))
            ev.append((t0, 'cellos', r2, bar, .22, .2))
            ev.append((t0, 'vibraphone_bowed', ch[1] + '4', bar, .18, .3))
        if m == 'build':
            for i in range(8):
                ev.append((t0 + i * beat / 2, 'piano', c4[i % 3], beat * .45, .3 + .02 * (k % 4), -.2))
                ev.append((t0 + i * beat / 2, 'cellos_spic', r2, beat * .4, .3, .2))
            ev.append((t0, 'violins', c5[(k % 3)], bar, .25, .3))
        if m == 'peak':
            for i in (0, 2):
                for p in [r3] + c4:
                    ev.append((t0 + i * beat, 'piano', p, beat * 2, .46, -.15))
            ev.append((t0, 'contrabass', r2, bar, .35, 0))
            ev.append((t0, 'cellos', r3, bar, .35, .2))
            for p in c5:
                ev.append((t0, 'violins', p, bar, .32, .3))
            ev.append((t0, 'glockenspiel', c5[0], beat, .3, .4))
    for p in ['D2', 'D3', 'A3', 'D4', 'F#4', 'A4']:
        ev.append((brand_t, 'piano', p, 7, .4, -.1))
    for p in ['D4', 'F#4', 'A4', 'D5']:
        ev.append((brand_t, 'violins', p, 7, .26, .3))
    ev.append((brand_t + 1.6, 'glockenspiel', 'A5', 2, .3, .4))
    ev.append((brand_t + 2.2, 'glockenspiel', 'D6', 3, .3, .4))
    for s in TL['stations']:                       # 每张照片鼓起时一声轻钟琴
        if s['kind'] in ('photo', 'strip'):
            ev.append((s['t0'] + .9, 'glockenspiel', 'A6' if int(s['sid'][1:]) % 2 else 'F#6', 1.2, .16, .35))
    mus = S.render(ev, dur=TOTAL + 1)[:N]
    mus = S.room(mus, size=.5, mix=.22)
    mus = np.pad(mus, ((0, max(0, N - len(mus))), (0, 0)))[:N]
    sfx = np.zeros((N, 2), np.float32)
    tt = np.arange(int(.14 * SR)) / SR
    beep = (np.sin(2 * np.pi * (1500 * tt + 1800 * tt * tt)) * np.exp(-tt * 22)).astype(np.float32) * .3
    tick = (np.random.default_rng(3).normal(0, 1, int(.012 * SR)) * np.exp(-np.arange(int(.012 * SR)) / 60)).astype(np.float32) * .1
    for sid, off in [('S05', LT['n05'][0]), ('S08', ST['S08']['t0'] + 1.4), ('S13', ST['S13']['t0'] + 1.5), ('S14', ST['S14']['t0'] + 1.3), ('S23', ST['S23']['t0'] + 1.0)]:
        add(sfx, beep, off - .2, 1, 0)
        for i in range(14):
            add(sfx, tick, off + i * .11, 1, .3)
    env = np.convolve(np.abs(vo).mean(1), np.ones(int(.25 * SR)) / int(.25 * SR), 'same')
    duck = 1 - .62 * np.clip(env / .02, 0, 1)
    duck = np.convolve(duck, np.ones(int(.4 * SR)) / int(.4 * SR), 'same')[:, None]
    t = np.arange(N) / SR
    fade = np.clip(np.minimum(t / .6, (TOTAL - t) / 1.5), 0, 1)[:, None]
    mix = (vo + mus * .55 * duck + sfx * .8) * fade
    sf.write(D + 'mix.wav', mix.astype(np.float32), SR)
    open(D + 'credits_music.txt', 'w').write('\n'.join(S.credits(sorted({e[1] for e in ev}))))
    print('audio ok', round(N / SR, 1))


def srt():
    def ts(x):
        h, r = divmod(x, 3600)
        m, s = divmod(r, 60)
        return f'{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}'
    rows = []
    for k, (txt, a, b, _) in enumerate(sorted(SUBS, key=lambda r: r[1]), 1):
        rows.append(f'{k}\n{ts(a)} --> {ts(b)}\n{txt}\n')
    open(P + '懂你的人_书桌版.srt', 'w').write('\n'.join(rows))


def mux():
    out = P + '懂你的人_书桌版.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', D + 'post/p_%04d.jpg', '-i', D + 'mix.wav',
                    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], check=True)
    srt()
    print(out)


if __name__ == '__main__':
    w = sys.argv[1] if len(sys.argv) > 1 else 'all'
    os.makedirs(D + 'post', exist_ok=True)
    if w in ('audio', 'all'):
        audio()
    if w in ('frames', 'all'):
        from multiprocessing import Pool
        todo = [i for i in range(NF) if os.path.exists(D + f'frames/f_{i:04d}.jpg') and os.path.getsize(D + f'frames/f_{i:04d}.jpg') > 1000]
        if '--only' in sys.argv:
            todo = [int(x) for x in sys.argv[sys.argv.index('--only') + 1].split(',')]
        with Pool(4) as p:
            p.map(frame, todo, chunksize=8)
        print('post', len(todo))
    if w in ('mux', 'all'):
        mux()
