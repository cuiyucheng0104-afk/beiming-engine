"""配乐/混音体检：每 0.25 s 的 RMS、低频占比、静默段电平、关键拍附近的起音位置"""
import sys, json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
p = sys.argv[1]; x, sr = sf.read(p); m = x.mean(1) if x.ndim > 1 else x
TL = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else None
def db(v): return 20 * np.log10(max(v, 1e-9))
hop = int(.25 * sr); line = []
for i in range(0, len(m) - hop, hop): line.append(f"{i/sr:5.2f}:{db(np.sqrt((m[i:i+hop]**2).mean())):6.1f}")
print(' '.join(line))
lo = sosfilt(butter(4, 120, 'low', fs=sr, output='sos'), m); hi = sosfilt(butter(4, 120, 'high', fs=sr, output='sos'), m)
print('low(<120Hz) vs rest dB:', round(db(np.sqrt((lo**2).mean())) - db(np.sqrt((hi**2).mean())), 1))
if TL:
    F20, FC, FPS = TL['F20'], TL['FC'], TL['FPS']
    a, b = int((F20 / FPS + .12) * sr), int((FC / FPS - .02) * sr)
    print('silence window', round(F20/FPS+.12,3), '-', round(FC/FPS-.02,3), 'RMS dBFS', round(db(np.sqrt((m[a:b]**2).mean())), 1), 'peak', round(db(np.abs(m[a:b]).max()), 1))
    # 起音检测：在每个音乐拍附近 ±40 ms 找能量跳变最大的位置
    env = np.convolve(np.abs(m), np.ones(48) / 48, 'same')
    d = np.diff(env, prepend=0)
    for c in ['b8', 'b16', 'b20', 'C+0', 'C+6', 'C+7']:
        beat = [x for x in TL['BEATS'] if x['id'] == c][0]; t = beat['f'] / FPS; s = int(t * sr)
        w = d[s - int(.04 * sr): s + int(.04 * sr)]; k = np.argmax(w) - int(.04 * sr)
        print(f"onset near {c:5s} t={t:.4f}: {k/sr*1000:+.1f} ms")
