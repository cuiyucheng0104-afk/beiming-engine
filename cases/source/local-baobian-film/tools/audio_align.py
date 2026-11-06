"""配乐对位：在配乐里找"最大的一次涌起"（能量包络上升最猛的地方），算出从哪一秒开始截 30 秒，
能让这次涌起正好落在画面的锚点（默认 21.0 秒 = S5 豹子起跳）。只能在 [0, 时长-30] 里平移，放不下就尽量靠近。
用法：.venv/bin/python tools/audio_align.py <配乐.wav> [--anchor 21.0] [--dur 30]   → 打印起点秒数（stdout 只有这个数）
"""
import sys
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d


def main(a):
    f = a[0]; anchor = 21.0; dur = 30.0
    if '--anchor' in a: anchor = float(a[a.index('--anchor') + 1])
    if '--dur' in a: dur = float(a[a.index('--dur') + 1])
    sr, x = wavfile.read(f)
    x = x.astype(np.float64)
    if x.ndim > 1: x = x.mean(1)
    x /= (np.abs(x).max() or 1)
    hop = sr // 20; n = len(x) // hop
    env = np.sqrt(uniform_filter1d((x[:n * hop] ** 2).reshape(n, hop).mean(1), 20))   # 1 秒平滑的 RMS 包络
    rise = np.zeros_like(env); rise[20:] = env[20:] - env[:-20]                        # 1 秒内的上升量
    total = len(x) / sr
    lo, hi = int(6 * 20), int(max(6, total - 3) * 20)                                   # 别选开头和结尾
    j = lo + int(np.argmax(rise[lo:hi])) if hi > lo else int(np.argmax(rise))
    tswell = j / 20.0
    off = min(max(tswell - anchor, 0.0), max(total - dur, 0.0))
    sys.stderr.write(f'配乐 {total:.1f}s，最大涌起在 {tswell:.2f}s，锚点 {anchor}s → 从 {off:.2f}s 开始截（涌起落在画面 {tswell - off:.2f}s）\n')
    print(f'{off:.2f}')


if __name__ == '__main__':
    main(sys.argv[1:])
