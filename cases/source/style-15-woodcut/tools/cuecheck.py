"""拍点核对：画面事件 (events.json) ↔ 时间源 (timeline.json) ↔ 音频实际落位 (out/cues_audio.json) ↔ 混音实测。
用法：python tools/cuecheck.py [film.mp4]   （给成片时还核对画面切点的帧差峰值）"""
import json, os, sys, subprocess
import numpy as np, soundfile as sf
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(f'{H}/timeline.json')); EV = json.load(open(f'{H}/events.json'))['ev']; PL = json.load(open(f'{H}/out/cues_audio.json'))
K, fps = TL['K'], TL['fps']
def expect(key):
    a, _, i = key.partition('.')
    alias = {'red': 'boat_lit', 'caption': 'caption'}
    v = K[alias.get(a, a)]
    return v[int(i)] if isinstance(v, list) else v
rows, worst = [], 0.0
for e in EV:
    k = e.get('key')
    if not k: continue
    te, tv = expect(k), e['t']
    fr = abs(tv * fps - round(tv * fps)) * 1000 / fps
    fa = PL.get('f.' + k); ma = PL.get('m.' + k)
    d = [abs(tv - te) * 1000, fr] + ([abs(fa - tv) * 1000] if fa is not None else []) + ([abs(ma - tv) * 1000] if ma is not None else [])
    worst = max(worst, max(d)); rows.append((k, tv, round(tv * fps), fa, ma, max(d)))
print(f'{"cue":12s} {"t画面":>8s} {"帧":>4s} {"拟音":>8s} {"音乐":>8s} {"偏差ms":>7s}')
for k, tv, f, fa, ma, d in rows: print(f'{k:12s} {tv:8.4f} {f:4d} {fa if fa is None else round(fa,4)!s:>8s} {ma if ma is None else round(ma,4)!s:>8s} {d:7.2f}')
# 音乐拍点（没有对应画面事件的也必须在帧格上）
mus = [(k, v) for k, v in PL.items() if k.startswith('m.')]
mw = max(abs(v * fps - round(v * fps)) * 1000 / fps for _, v in mus)
print(f'\n画面事件 {len(rows)} 个，最大偏差 {worst:.3f} ms；音乐落点 {len(mus)} 个，离帧格最大 {mw:.3f} ms')
# 混音实测：静默窗口 + 静默后第一声
x, sr = sf.read(f'{H}/out/mix.wav'); m = x.mean(1)
b0, b1 = TL['KB']['silence']; T = lambda b: np.floor(b * TL['fpb'] + .5) / fps
s0, s1 = int(round(T(b0) * sr)), int(round(T(b1) * sr))
rms = 20 * np.log10(np.sqrt((m[s0:s1] ** 2).mean()) + 1e-12)
pk_after = 20 * np.log10(np.abs(m[s1:s1 + int(.3 * sr)]).max() + 1e-12); pk_all = 20 * np.log10(np.abs(m).max())
on = s1 + int(np.argmax(np.abs(m[s1:s1 + int(.1 * sr)]) > 10 ** (-40 / 20)))
print(f'静默 {T(b0):.3f}–{T(b1):.3f}s：RMS {rms:.1f} dBFS；静默后第一声起点 {(on - s1) / sr * 1000:.2f} ms 后，峰值 {pk_after:.1f} dBFS（全片峰值 {pk_all:.1f}）')
# 关键点音频起音实测（包络越过前 50 ms 底噪 +12 dB 的时刻）
env = np.abs(m)
def onset(t):
    s = int(round(t * sr)); base = np.sqrt((m[s - int(.05 * sr):s - int(.005 * sr)] ** 2).mean()) + 1e-6
    w = env[s - int(.01 * sr):s + int(.06 * sr)]; i = int(np.argmax(w > base * 4)); return (i - int(.01 * sr)) / sr * 1000
for k in ['cut2', 'wave.0', 'wave.1', 'ignite', 'beam.0', 'beam.1', 'beam.2', 'boat_lit', 'dock', 'peel']:
    print(f'  起音实测 {k:9s} {onset(expect(k)):+6.2f} ms')
ok = worst < 0.5 and mw < 0.5 and rms < -90
# 成片：切点帧差
if len(sys.argv) > 1:
    W, Hh = 192, 108
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', sys.argv[1], '-vf', f'scale={W}:{Hh},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, Hh, W).astype(np.float32); dif = np.abs(np.diff(fr, axis=0)).mean((1, 2))
    print('\n画面切点（帧差峰值应正好在切点帧）：')
    for k in ['cut2', 'cut3', 'ignite', 'cut4', 'boat_lit']:
        f = round(expect(k) * fps); lo = max(1, f - 3); pk = lo + int(np.argmax(dif[lo - 1:f + 3])) ; print(f'  {k:9s} 预期帧 {f:4d}  帧差峰值帧 {pk:4d}  差 {pk - f:+d} 帧  (帧差 {dif[pk - 1]:.1f} vs 前一帧 {dif[pk - 2]:.1f})'); ok &= pk == f
print('\nRESULT', 'PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
