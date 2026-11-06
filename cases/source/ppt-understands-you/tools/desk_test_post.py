"""书桌 15 秒测试：逐帧加字幕 / 镜片 HUD，配乐 + 旁白，合成 mp4
用法：python desk_test_post.py [audio|frames|mux|all]"""
import os, sys, json, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

P = os.path.expanduser('~/Desktop/懂你的人/')
D = P + '样片/书桌15秒/'
LIB = os.path.expanduser('~/lemo-opuscar')
FPS, W, H = 24, 1920, 1080
HIRA = '/System/Library/Fonts/Hiragino Sans GB.ttc'
G = (120, 255, 170)
f = lambda s, i=1: ImageFont.truetype(HIRA, s, index=i)
DUR = json.load(open(P + '旁白/wav/dur.json'))
LINES = {x['id']: x['zh'] for fn in ('narr.json', 'qiu.json') for x in json.load(open(P + '旁白/' + fn))}
VO = [('n02', 1.2), ('n05', 9.9), ('q05', 13.8)]          # 旁白起点（秒）
SUBS = [('放学的人群里，没有人喊陈默。', 1.2, 3.9), ('他连一句“借过”，都说得很轻。', 3.9, 7.4),
        ('眼镜把急促的“咕噜”声，译成了人话。', 9.9, 13.6)]
TOTAL = 19.0


def frame(i):
    t = i / FPS
    im = Image.open(D + f'frames/f_{i:04d}.jpg').convert('RGBA')
    d = ImageDraw.Draw(im)
    if t > 10.2:                                             # 镜片里的翻译
        lay = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        k = int((t - 10.2) * 8)
        g1 = '咕噜…咕噜咕噜…'[:k]
        ld.text((470, 862), g1, font=f(26, 0), fill=(200, 255, 220, 210))
        if t > 13.2:
            ld.line((470, 878, 470 + 210 * min(1, (t - 13.2) / .4), 878), fill=(200, 255, 220, 220), width=2)
        if t > 13.8:
            q = LINES['q05']
            n = int((t - 13.8) / DUR['q05'] * len(q) * 1.25)
            ld.text((470, 900), q[:n], font=f(46), fill=G + (255,))
        im.alpha_composite(lay.filter(ImageFilter.GaussianBlur(5)))
        im.alpha_composite(lay)
        d = ImageDraw.Draw(im)
    for s, a0, a1 in SUBS:
        if a0 <= t < a1:
            al = min(1, (t - a0) / .15, (a1 - t) / .15)
            w = d.textlength(s, font=f(34))
            y = 990 if t < 9 else 60
            d.text(((W - w) / 2, y), s, font=f(34), fill=(255, 250, 240, int(255 * al)),
                   stroke_width=2, stroke_fill=(0, 0, 0, int(170 * al)))
    fo = min(1, t / .5, (TOTAL - t) / .8)
    rgb = im.convert('RGB')
    if fo < 1:
        rgb = Image.eval(rgb, lambda v: int(v * max(0, fo)))
    rgb.save(D + f'post/p_{i:04d}.jpg', quality=93)


def audio():
    sys.path.insert(0, LIB)
    import soundfile as sf, soxr
    from core.audio import sampler as S
    from core.audio.sfx import SR, add
    S.seed(5)
    N = int((TOTAL + .5) * SR)
    vo = np.zeros((N, 2), np.float32)
    for lid, t0 in VO:
        x, sr = sf.read(P + f'旁白/wav/{lid}.wav', dtype='float32')
        add(vo, soxr.resample(x if x.ndim == 1 else x.mean(1), sr, SR), t0, 1, 0)
    beat = 60 / 76
    ev = []
    prog = [('D', 'F#', 'A'), ('B', 'D', 'F#'), ('G', 'B', 'D'), ('A', 'C#', 'E')]
    for k in range(int(TOTAL / (beat * 4)) + 1):
        t0 = k * beat * 4
        c = prog[k % 4]
        pat = [c[0] + '3', c[2] + '3', c[0] + '4', c[1] + '4', c[2] + '4', c[1] + '4', c[0] + '4', c[2] + '3']
        for i, p in enumerate(pat):
            ev.append((t0 + i * beat / 2, 'piano', p, beat, .3, -.15))
        ev.append((t0, 'cellos', c[0] + '2', beat * 4, .22, .2))
        if t0 > 9:
            ev.append((t0, 'violins', c[1] + '5', beat * 4, .2, .3))
    for t, p in [(5.0, 'A5'), (5.4, 'D6'), (10.2, 'F#6'), (13.8, 'A6')]:   # 照片鼓起、进镜片、翻译出现
        ev.append((t, 'glockenspiel', p, 1.5, .32, .35))
    ev.append((TOTAL - 2.6, 'piano', 'D3', 3, .3, 0))
    mus = S.room(S.render(ev, dur=TOTAL + .5)[:N], size=.5, mix=.22)
    mus = np.pad(mus, ((0, max(0, N - len(mus))), (0, 0)))[:N]
    env = np.convolve(np.abs(vo).mean(1), np.ones(int(.25 * SR)) / int(.25 * SR), 'same')
    duck = 1 - .6 * np.clip(env / .02, 0, 1)
    duck = np.convolve(duck, np.ones(int(.4 * SR)) / int(.4 * SR), 'same')[:, None]
    t = np.arange(N) / SR
    fade = np.clip(np.minimum(t / .5, (TOTAL - t) / 1.0), 0, 1)[:, None]
    sf.write(D + 'mix.wav', ((vo + mus * .6 * duck) * fade).astype(np.float32), SR)


def mux():
    import subprocess
    out = D + '书桌方向_动态测试.mp4'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', D + 'post/p_%04d.jpg', '-i', D + 'mix.wav',
                    '-af', 'loudnorm=I=-14:TP=-1.5', '-ar', '48000', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], check=True)
    print(out)


if __name__ == '__main__':
    w = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if w in ('audio', 'all'):
        audio()
    if w in ('frames', 'all'):
        os.makedirs(D + 'post', exist_ok=True)
        from multiprocessing import Pool
        n = len([x for x in os.listdir(D + 'frames') if x.endswith('.jpg')])
        with Pool(8) as p:
            p.map(frame, range(n))
    if w in ('mux', 'all'):
        mux()
