"""分轨/分段电平表 + 低频占比：python tools/levels.py"""
import sys, os, json, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(H, 'events.json'))); M = next(e for e in E['ev'] if e['type'] == 'meta'); B = M['B']
db = lambda x: 20 * np.log10(max(1e-9, np.sqrt(np.mean(x ** 2))))
pk = lambda x: 20 * np.log10(max(1e-9, np.abs(x).max()))
names = ['music', 'laugh', 'foley', 'amb']
X = {n: sf.read(os.path.join(H, 'out/stems', n + '.wav'))[0].mean(1) for n in names}
X['MIX'], SR = sf.read(os.path.join(H, 'out/mix.wav')); X['MIX'] = X['MIX'].mean(1)
print('section      ' + ''.join(f'{n:>14}' for n in names + ['MIX']))
for s in M['sections']:
    a, b = int(s['b0'] * B * SR), int(min(s['b1'] * B, E['dur']) * SR)
    print(f"{s['id']:<12} " + ''.join(f"{db(X[n][a:b]):7.1f}/{pk(X[n][a:b]):5.1f}" for n in names + ['MIX']))
lo = sosfilt(butter(4, 120, 'low', fs=SR, output='sos'), X['MIX']); hi = X['MIX'] - lo
print('low(20-120Hz) vs rest dB:', round(db(lo) - db(hi), 1))
