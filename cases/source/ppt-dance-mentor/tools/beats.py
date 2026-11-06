"""估 BPM 与拍相位：谱通量 → 自相关取速度 → 梳状对齐取相位 → 低频能量定一拍
用法：beats.py a.wav [b.wav ...]  输出 音乐/beats.json"""
import sys, json, subprocess, numpy as np
from scipy.signal import stft
SR = 22050
def rd(fn):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', fn, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)
def analyse(fn):
    x = rd(fn); hop = 256
    f, t, Z = stft(x, SR, nperseg=1024, noverlap=1024 - hop); M = np.log1p(np.abs(Z) * 50)
    flux = np.maximum(np.diff(M, axis=1), 0)
    on = flux.sum(0); low = flux[f < 150].sum(0)
    on = on - np.convolve(on, np.ones(32) / 32, 'same'); on = np.maximum(on, 0)
    fr = SR / hop
    ac = np.correlate(on, on, 'full')[len(on) - 1:]
    best = None
    for bpm in np.arange(70, 115, 0.05):
        lag = 60 / bpm * fr
        s = sum(np.interp(lag * k, np.arange(len(ac)), ac) for k in (1, 2, 4)) / (1 + .002 * abs(bpm - 90))
        if best is None or s > best[0]: best = (s, bpm)
    bpm = best[1]; per = 60 / bpm * fr
    # 相位：在 0..per 里找让脉冲列能量最大的偏移
    n = int((len(on) - 1) / per)
    sc = [(np.interp(ph + per * np.arange(n), np.arange(len(on)), on).sum(), ph) for ph in np.arange(0, per, .25)]
    ph = max(sc)[1]
    # 一拍：4 个候选里低频（底鼓）最强的那个
    lb = [np.interp(ph + per * (np.arange(k, n, 4)), np.arange(len(low)), low).mean() for k in range(4)]
    k1 = int(np.argmax(lb))
    first = (ph + per * k1) / fr
    return dict(bpm=round(float(bpm), 3), first_downbeat=round(float(first), 4), dur=round(len(x) / SR, 3), lowbeat=[round(float(v), 2) for v in lb])
J = {}
for fn in sys.argv[1:]:
    J[fn.split('/')[-1]] = analyse(fn); print(fn.split('/')[-1], J[fn.split('/')[-1]])
json.dump(J, open(sys.argv[1].rsplit('/', 1)[0] + '/beats.json', 'w'), indent=1)
