"""旁白响度包络（给镜片录音波形用）：每句 30 fps 的 RMS，归一化到 0..1。产出 data/vo_env.json {nXX: [..]}"""
import json, os, numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WAV = '@@WORKSPACE_ROOT@@/Desktop/见龙/旁白v2/wav'   # 第二版旁白（2026-11-03，音色 Chinese (Mandarin)_Sincere_Adult）；旧版在 旁白/wav
out = {}
for n in range(1, 19):
    x, sr = sf.read(f'{WAV}/n{n:02d}.wav', dtype='float32')
    if x.ndim > 1: x = x.mean(1)
    hop = sr // 30; m = len(x) // hop
    r = np.sqrt((x[:m * hop].reshape(m, hop) ** 2).mean(1)); r = np.clip(r / (np.percentile(r, 98) + 1e-9), 0, 1)
    out[f'n{n:02d}'] = [round(float(v), 3) for v in r]
json.dump(out, open(f'{HERE}/data/vo_env.json', 'w'))
print('ok', {k: len(v) for k, v in list(out.items())[:3]})
