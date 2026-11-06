"""配乐分析：给搭片的人看"音乐在哪几秒发生了什么"，好让画面的关键动作踩在音乐上。
输出：时长、估计速度（BPM）、最大涌起、最强的若干个起音点、每秒能量；外加一张能量曲线图。
用法：.venv/bin/python tools/audio_report.py <配乐.wav> [--offset 起点秒] [--png 曲线.png]
（--offset：打算从第几秒开始截 30 秒；报告里的时间都换算成画面时间）
"""
import sys
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d, maximum_filter1d
from PIL import Image, ImageDraw


def main(a):
    f = a[0]; off = float(a[a.index('--offset') + 1]) if '--offset' in a else 0.0
    png = a[a.index('--png') + 1] if '--png' in a else None
    sr, x = wavfile.read(f); x = x.astype(np.float64)
    if x.ndim > 1: x = x.mean(1)
    x /= (np.abs(x).max() or 1); total = len(x) / sr
    fps = 100; hop = sr // fps; n = len(x) // hop
    fr = x[:n * hop].reshape(n, hop)
    rms = np.sqrt((fr ** 2).mean(1))
    # 频谱通量做起音包络
    win = np.hanning(2048); spec = []
    for i in range(n):
        s = x[i * hop:i * hop + 2048]
        if len(s) < 2048: s = np.pad(s, (0, 2048 - len(s)))
        spec.append(np.abs(np.fft.rfft(s * win))[:400])
    spec = np.log1p(np.array(spec) * 10)
    flux = np.maximum(spec[1:] - spec[:-1], 0).sum(1); flux = np.concatenate([[0], flux])
    flux = (flux - uniform_filter1d(flux, 50)).clip(0)
    peaks = np.where((flux == maximum_filter1d(flux, 25)) & (flux > np.percentile(flux, 97)))[0]
    top = sorted(peaks, key=lambda i: -flux[i])[:12]
    # 速度：起音包络的自相关
    ac = np.correlate(flux - flux.mean(), flux - flux.mean(), 'full')[n - 1:]
    lo, hi = int(fps * 60 / 160), int(fps * 60 / 50)
    bpm = 60 * fps / (lo + int(np.argmax(ac[lo:hi]))) if hi < len(ac) else 0
    env = np.sqrt(uniform_filter1d(rms ** 2, fps))
    rise = np.zeros_like(env); rise[fps:] = env[fps:] - env[:-fps]
    j = int(np.argmax(rise[6 * fps:max(6 * fps + 1, int((total - 3) * fps))])) + 6 * fps
    print(f'文件 {f}：时长 {total:.2f}s，估计速度 {bpm:.0f} BPM，截取起点 {off:.2f}s（以下时间均为画面时间）')
    print(f'最大涌起（1 秒内能量上升最多）：{j / fps - off:.2f}s')
    print('最强起音点（按强度排序）：' + '、'.join(f'{i / fps - off:.2f}s' for i in top if 0 <= i / fps - off <= 30))
    sec = [float(env[int(min(n - 1, (s + off) * fps))]) for s in range(31)]
    mx = max(sec) or 1
    print('每秒能量（0–9）：' + ' '.join(f'{s}:{int(9 * v / mx)}' for s, v in enumerate(sec)))
    if png:
        W, H = 1200, 240; im = Image.new('RGB', (W, H), (250, 248, 242)); dr = ImageDraw.Draw(im)
        for s in range(31):
            X = int(s / 30 * (W - 1)); dr.line([X, 0, X, H], fill=(225, 220, 210)); dr.text((X + 2, H - 12), str(s), fill=(120, 110, 100))
        pts = [(int((i / fps - off) / 30 * (W - 1)), int(H - 20 - (H - 40) * env[i] / (env.max() or 1))) for i in range(n) if 0 <= i / fps - off <= 30]
        if len(pts) > 1: dr.line(pts, fill=(40, 40, 60), width=2)
        for i in top:
            t = i / fps - off
            if 0 <= t <= 30: X = int(t / 30 * (W - 1)); dr.line([X, 0, X, 30], fill=(200, 60, 40), width=2)
        X = int((j / fps - off) / 30 * (W - 1)); dr.line([X, 0, X, H], fill=(40, 120, 200), width=2)
        im.save(png); print('曲线图', png, '（黑线=能量，红短线=强起音，蓝线=最大涌起）')


if __name__ == '__main__':
    main(sys.argv[1:])
