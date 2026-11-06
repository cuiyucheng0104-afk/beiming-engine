"""素材 → 底片（plates）。读 timeline.json，给每个镜头和网格素材池生成逐帧 JPEG：
  1. 速度曲线 speed(t)（常数或关键帧，smoothstep 插值）积分成源时间；
  2. 输出帧 i 覆盖源时间窗 [pos(i), pos(i+1))，窗里有多帧就平均（上限 blend，360° 快门：车灯成线、人群成雾）；
     窗里没有整帧（慢放）就取最近帧，mix=True 时按距离交叉融合相邻两帧；
  3. 调色：部分灰世界白平衡（夜景强度 0）→ S 曲线 LUT → 暖高光冷暗部 → 饱和 0.86 → 高光泛光；
  4. S15（钠灯长街）在这里按 timeline 的拍点把路灯成组熄灭。
颗粒、暗角、遮幅、片门晃动、运镜、文字在 index.html 里做。
用法：python tools/prep.py [S1 S2 … pool:shibuya …] [-j 3]
素材是不可信数据：这里只用 ffmpeg 解码，不执行素材里的任何东西。"""
import os, sys, json, math, subprocess
from concurrent.futures import ProcessPoolExecutor
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
FPS = TL['FPS']; W, H = 1920, 1080
RAW = os.path.join(HERE, 'material', 'raw')
EXT = {'causeway': 'ogv', 'nevsky': 'ogv'}

# 网格素材池（960×540）：源、起点、裁切、速度、融合
POOL = {
    'shibuya':  dict(s0=8, crop=[0, 620, 820, 461], speed=8, blend=8, wb=.3),     # 只取路口下半，避开广告牌
    'causeway': dict(s0=8, crop=[0, 0, 1920, 1080], speed=8, blend=8, wb=.4),
    'dallas':   dict(s0=.5, crop=[960, 300, 960, 540], speed=5, blend=2, wb=.3),        # 航拍延时机位在动：少融合，免得重影
    'shibuya2': dict(src='shibuya', s0=19, crop=[840, 716, 640, 360], speed=8, blend=8, wb=.25, levels=True, contrast=.5),   # 路口另一角：斑马线 + 人流
    'causeway2': dict(src='causeway', s0=10, crop=[560, 480, 1100, 600], speed=8, blend=8, wb=.35, levels=True, contrast=.4),  # 巴士车流近景
    'kolkata':  dict(s0=11.6, crop=[480, 0, 1440, 810], speed=1.4, blend=3, wb=.3),
    'frisco':   dict(s0=.5, crop=[0, 0, 1920, 1080], speed=4, blend=2, wb=.3),        # 机位在走：少融合，免得重影
    'dallas2':  dict(src='dallas', s0=3, crop=[0, 300, 1380, 776], speed=4, blend=2, wb=.3),   # 快速路车流（取代糊成一片的进站地铁）
    'etela':    dict(s0=50, crop=[600, 500, 1800, 1012], speed=1.5, blend=4, wb=.35),
    'newcastle': dict(s0=10, crop=[0, 0, 1920, 1080], speed=6, blend=8, wb=.3),
}


def src_path(s): return os.path.join(RAW, f'{s}.{EXT.get(s, "webm")}')


def src_fps(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', path],
                       capture_output=True, text=True).stdout.strip()
    a, b = r.split('/'); return float(a) / float(b)


def speed_edges(sp, n):
    """输出帧边界处的源时间偏移（秒）：对 speed(t) 数值积分"""
    T = n / FPS; ts = np.linspace(0, T, n * 16 + 1)
    if isinstance(sp, (int, float)): v = np.full_like(ts, float(sp))
    else:
        kt = np.array([k[0] for k in sp]); kv = np.array([k[1] for k in sp]); v = np.empty_like(ts)
        for i, t in enumerate(ts):
            if t <= kt[0]: v[i] = kv[0]; continue
            if t >= kt[-1]: v[i] = kv[-1]; continue
            j = np.searchsorted(kt, t) - 1; u = (t - kt[j]) / (kt[j + 1] - kt[j]); u = u * u * (3 - 2 * u)
            v[i] = kv[j] + (kv[j + 1] - kv[j]) * u
    pos = np.concatenate([[0], np.cumsum((v[1:] + v[:-1]) / 2 * np.diff(ts))])
    return pos[::16]


# ── 调色（STYLE §3）──
def make_luts():
    x = np.linspace(0, 1, 256)
    s = 1 / (1 + np.exp(-6.2 * (x - .47))); s = (s - s[0]) / (s[-1] - s[0])
    y = .55 * s + .45 * x
    y = 7 / 255 + (250 - 7) / 255 * y
    r = np.clip(y * 1.025, 0, 1); g = np.clip(y, 0, 1); b = np.clip(y * .965 + .012 * (1 - x), 0, 1)
    return [(c * 255 + .5).astype(np.uint8) for c in (r, g, b)]


LUT = make_luts()


def wb_gains(img, strength):
    if strength <= 0: return np.ones(3, np.float32)
    a = img[::8, ::8].astype(np.float32) / 255; l = a.mean(2); m = (l > .12) & (l < .88)
    if m.sum() < 200: return np.ones(3, np.float32)
    mean = a[m].mean(0); g = mean.mean() / np.maximum(mean, 1e-3)
    return (g ** min(strength, .6)).astype(np.float32)


def levels_of(img):
    l = img[::4, ::4].astype(np.float32) @ np.array([.2126, .7152, .0722], np.float32)
    return float(np.percentile(l, 1)), float(np.percentile(l, 99.3))


def grade(a, gains, bloom, lv=None, contrast=0.0):
    if lv: a = (a - lv[0]) * (238 / max(lv[1] - lv[0], 20)) + 6        # 自动色阶：灰白素材拉开黑白场
    a = a * gains
    if contrast:                                                       # 额外 S 曲线（只给发灰的白天素材）
        x = np.clip(a / 255, 0, 1); a = 255 * (x + contrast * (x * x * (3 - 2 * x) - x))
    l = a @ np.array([.2126, .7152, .0722], np.float32)
    a = l[..., None] + .86 * (a - l[..., None])
    a = np.clip(a, 0, 255).astype(np.uint8)
    out = np.stack([LUT[c][a[..., c]] for c in range(3)], 2).astype(np.float32)
    h, w = out.shape[:2]
    small = Image.fromarray(out.astype(np.uint8)).resize((w // 8, h // 8), Image.BILINEAR)
    hl = np.clip(np.asarray(small).astype(np.float32) - 170, 0, None) * 1.6
    hl = np.asarray(Image.fromarray(hl.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6)).resize((w, h), Image.BILINEAR)).astype(np.float32)
    return np.clip(out + bloom * hl * np.array([1.0, .82, .62], np.float32), 0, 255).astype(np.uint8)


# ── 熄灯（S15）──
class Lights:
    """从整段的中位帧里找灯（亮且小的斑块），按 timeline 的拍点成组熄灭。
    光照模型：画面 ≈ 环境 × Σ 灯的高斯光池；熄掉的灯从分子里拿掉，比值乘回画面。"""
    def __init__(self, frames, offs, f0):
        med = np.median(np.stack(frames[::6]), 0).astype(np.float32)
        L = med @ np.array([.2126, .7152, .0722], np.float32)
        lab, n = ndimage.label(L > 205)
        idx = range(1, n + 1)
        area = ndimage.sum(np.ones_like(L), lab, idx); cy, cx = np.array(ndimage.center_of_mass(L, lab, idx)).T if n else ([], [])
        lamps = [(x, y, a) for x, y, a in zip(cx, cy, area) if 2 <= a <= 5000]
        # 最后一盏：画面下半中间最靠近 (1010, 760) 的灯
        last = min(range(len(lamps)), key=lambda k: (lamps[k][0] - 976) ** 2 + (lamps[k][1] - 767) ** 2)   # 路口那盏钠灯
        grp = []
        for k, (x, y, a) in enumerate(lamps):
            if k == last: g = 4
            elif y < 330: g = 0                     # 远处
            elif x > 1080: g = 1                    # 右侧
            elif y < 640: g = 2                     # 中段左侧
            else: g = 3                             # 近处，硬停时一起灭
            grp.append(g)
        self.lamps, self.grp, self.f0 = lamps, grp, f0
        self.off = {o['group']: o['f'] for o in offs}
        yy, xx = np.mgrid[0:H:4, 0:W:4].astype(np.float32)
        self.G = []
        for (x, y, a) in lamps:
            s = 22 + 7 * math.sqrt(a)
            self.G.append(math.sqrt(a) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s)))
        self.G = np.stack(self.G)
        self.tot = self.G.sum(0); self.amb = float(np.percentile(self.tot, 70)) + 1e-3
        print(f'  S15 灯 {len(lamps)} 盏，分组 {[grp.count(g) for g in range(5)]}，最后一盏 ({lamps[last][0]:.0f},{lamps[last][1]:.0f})', flush=True)
        self.last_xy = lamps[last][:2]
        lx, ly = self.last_xy
        self.keep = np.exp(-((xx - lx) ** 2 + ((yy - ly) * 1.3) ** 2) / (2 * 70 ** 2)).astype(np.float32)

    def weight(self, g, f):
        fo = self.off[g]
        return float(np.clip(1 - (f - fo) / 2.0, 0, 1))     # 继电器式熄灭：2 帧内

    def floor(self, f):
        st, la = self.off[3], self.off[4]
        if f < st: return .30
        if f < la: return .17
        return float(np.interp(f, [la, la + 20], [.13, .10]))

    def apply(self, img, f):
        w = np.array([self.weight(g, f) for g in self.grp], np.float32)
        if w.min() >= 1: return img
        amb = self.amb
        rem = np.tensordot(w, self.G, 1) + amb * (w[np.array(self.grp) != 4].mean() if (np.array(self.grp) != 4).any() else 0)
        r = (rem / (self.tot + amb)) ** 1.3
        r = np.maximum(r, self.weight(4, f) * self.keep)          # 最后一盏：灯和它照亮的那一小片路面保持原亮度
        r = self.floor(f) + (1 - self.floor(f)) * r               # 残余天光：街没有死，车还在动，只是暗下去（不冻结）
        r = np.asarray(Image.fromarray((r * 255).clip(0, 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 255
        return (img.astype(np.float32) * r[..., None]).astype(np.uint8)


def decode(src, s0, crop, size, nframes):
    path = src_path(src); x, y, w, h = crop
    vf = f'crop={w}:{h}:{x}:{y},scale={size[0]}:{size[1]}:flags=lanczos'
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', f'{s0:.3f}', '-i', path, '-an', '-vf', vf, '-frames:v', str(nframes),
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    out = []; n = size[0] * size[1] * 3
    while len(out) < nframes:
        b = p.stdout.read(n)
        if len(b) < n: break
        out.append(np.frombuffer(b, np.uint8).reshape(size[1], size[0], 3))
    p.stdout.close(); p.wait()
    return out


def make(job):
    kind, key = job
    if kind == 'shot':
        c = next(s for s in TL['SHOTS'] if s['id'] == key); n = c['f1'] - c['f0']; size = (W, H)
        outdir = os.path.join(HERE, 'work', 'plates', key)
    else:
        c = dict(dict(src=key, bloom=.09), **POOL[key]); n = TL['POOL_N']; size = (960, 540)
        outdir = os.path.join(HERE, 'work', 'pool', key)
    os.makedirs(outdir, exist_ok=True)
    R = src_fps(src_path(c['src']))
    edges = speed_edges(c['speed'], n)
    need = []
    for i in range(n):
        a, b = edges[i] * R, edges[i + 1] * R
        js = list(range(math.ceil(a - 1e-6), math.ceil(b - 1e-6)))
        if not js:
            m = (a + b) / 2
            if c.get('mix'):
                j0 = int(math.floor(m)); w1 = m - j0
                need.append([(j0, 1 - w1), (j0 + 1, w1)] if w1 > .02 else [(j0, 1.0)]); continue
            js = [int(round(m))]
        if len(js) > c['blend']:
            idx = np.linspace(0, len(js) - 1, c['blend']).round().astype(int); js = [js[k] for k in idx]
        need.append([(j, 1 / len(js)) for j in js])
    jmax = max(j for js in need for j, _ in js)
    frames = decode(c['src'], c['s0'], c['crop'], size, jmax + 1)
    short = jmax + 1 - len(frames)
    gains = wb_gains(frames[len(frames) // 2], c.get('wb', 0))
    lv = levels_of(frames[len(frames) // 2]) if c.get('levels') else None
    lights = Lights(frames, TL['LIGHTS_OFF'], c['f0']) if kind == 'shot' and key == 'S15' else None
    for i, js in enumerate(need):
        acc = np.zeros((size[1], size[0], 3), np.float32)
        for j, w in js: acc += frames[min(j, len(frames) - 1)].astype(np.float32) * w
        acc *= c.get('lift', 1.0)
        img = grade(acc, gains, c.get('bloom', .09), lv, c.get('contrast', 0.0))
        if lights: img = lights.apply(img, c['f0'] + i)
        Image.fromarray(img).save(os.path.join(outdir, f'{i:04d}.jpg'), quality=93)
    msg = f'{kind}:{key} {n} 帧，源 {edges[-1]:.2f} s @ {R:.2f}fps，最多融合 {max(len(j) for j in need)} 帧' + (f'，⚠ 源帧不足 {short}' if short > 0 else '')
    if lights:
        json.dump({'last': lights.last_xy}, open(os.path.join(outdir, 'lights.json'), 'w'))
    return msg


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    jobs = int(sys.argv[sys.argv.index('-j') + 1]) if '-j' in sys.argv else 3
    args = [a for a in args if not a.isdigit()]
    todo = [('shot', s['id']) for s in TL['SHOTS']] + [('pool', k) for k in POOL]
    if args: todo = [t for t in todo if t[1] in args or f'pool:{t[1]}' in args and t[0] == 'pool']
    with ProcessPoolExecutor(jobs) as ex:
        for m in ex.map(make, todo): print(m, flush=True)
