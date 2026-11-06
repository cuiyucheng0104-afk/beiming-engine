# 生成可无缝平铺的暖色棉纸 paper.png（2048²，代表 1024 世界像素，放大镜头下仍有纤维细节）
# 用法：$LIB/.venv/bin/python tools/paper.py <工程目录>
import sys, os, numpy as np
from PIL import Image, ImageDraw, ImageFilter
D = sys.argv[1] if len(sys.argv) > 1 else '.'
N = 2048; rng = np.random.default_rng(20261031)
base = np.array([242, 234, 219], np.float32)
def pnoise(cut):            # 周期噪声：FFT 低通 → 天然无缝
    w = np.fft.fft2(rng.standard_normal((N, N)))
    fy = np.fft.fftfreq(N)[:, None]; fx = np.fft.fftfreq(N)[None, :]
    k = np.sqrt(fx ** 2 + fy ** 2); w *= np.exp(-(k / cut) ** 2)
    a = np.real(np.fft.ifft2(w)); a = (a - a.mean()) / (a.std() + 1e-9); return a * .25
m = pnoise(1 / 300) * .9 + pnoise(1 / 110) * .5 + pnoise(1 / 30) * .25
img = base[None, None, :] * (1 + m[..., None] * .035)
fib = Image.new('L', (N * 3, N * 3), 0); d = ImageDraw.Draw(fib)   # 3×3 画纤维再取中心块 → 边缘无缝
for _ in range(9000):
    x, y = rng.uniform(0, N), rng.uniform(0, N); a = rng.uniform(0, np.pi); L = rng.uniform(14, 70)
    pts = [(x, y)]
    for k in range(5): a += rng.normal(0, .35); x += np.cos(a) * L / 5; y += np.sin(a) * L / 5; pts.append((x, y))
    v = int(rng.uniform(40, 150)); w = 1 if rng.random() < .8 else 2
    for ox in (0, N, 2 * N):
        for oy in (0, N, 2 * N): d.line([(px + ox, py + oy) for px, py in pts], fill=v, width=w)
fib = fib.filter(ImageFilter.GaussianBlur(.7)).crop((N, N, 2 * N, 2 * N))
fib = np.maximum(np.asarray(fib, np.float32), 0) / 255
sign = np.where(pnoise(1 / 8) > 0, 1, -1)
img = img * (1 - fib[..., None] * .04 * sign[..., None])
img += rng.normal(0, 1.5, (N, N, 1))
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(os.path.join(D, 'paper.png'), optimize=True)
print('paper.png', N)
