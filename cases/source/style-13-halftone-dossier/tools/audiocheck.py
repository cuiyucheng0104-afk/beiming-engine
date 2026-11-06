"""混音体检：分段短时响度、静默段电平、最响一击的位置、低频占比。用法：python tools/audiocheck.py out/mix.wav"""
import sys, json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
x, sr = sf.read(sys.argv[1]); m = x.mean(1)
import os; tl = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1]))), 'timeline.json'))); T = tl['t']
db = lambda v: 20 * np.log10(max(v, 1e-9))
def rms(a, b): s = m[int(a * sr):int(b * sr)]; return db(np.sqrt(np.mean(s ** 2)))
for a, b, n in [(0, 3, '封面'), (3, 9, '证物'), (9, 11, '证物板前半'), (11, 13, '证物板渐强'), (13.03, 13.5, '静默①前半'), (13.5, 14, '静默①+充电'), (14, 16.667, '嫌犯照'), (16.7, T['stamp'] - .01, '静默②'), (T['stamp'], T['stamp'] + .4, '印章'), (17.8, 19.6, '收尾')]:
    print(f'{n:10s} {a:6.2f}-{b:6.2f}s  RMS {rms(a, b):6.1f} dBFS')
w = int(.4 * sr); st = [db(np.sqrt(np.mean(m[i:i + w] ** 2))) for i in range(0, len(m) - w, int(.05 * sr))]
k = int(np.argmax(st)); print(f'最响 0.4s 窗口起点 {k * .05:.2f}s（印章 {T["stamp"]:.3f}s），{st[k]:.1f} dBFS')
lo = sosfilt(butter(4, 120, 'low', fs=sr, output='sos'), m); hi = sosfilt(butter(4, 120, 'high', fs=sr, output='sos'), m)
print(f'20–120 Hz 相对其余频段: {db(np.sqrt(np.mean(lo ** 2))) - db(np.sqrt(np.mean(hi ** 2))):.1f} dB')
