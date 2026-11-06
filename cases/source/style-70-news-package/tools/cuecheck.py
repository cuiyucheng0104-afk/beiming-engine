"""卡点核对：画面事件 ↔ 音乐拍点。
1) events.json 中每个 cue 事件：t 与拍网格 T0 + k·SPB 的偏差，及是否落在整帧上（24 fps）；
2) out/hits.json（mix.py 记录的每个音乐命中）是否都有同一时刻的画面事件；
3) 成片音频（或 out/mix.wav）上，在关键拍点附近测实际起音时刻（5 ms 包络的最大上升沿）；
4) 成片画面：硬切与翻牌，逐帧差分找变化峰值所在帧，与拍点比较。
用法：$LIB/.venv/bin/python tools/cuecheck.py <工程目录> [成片.mp4]"""
import json, os, subprocess, sys
import numpy as np

HERE = os.path.abspath(sys.argv[1]); FILM = sys.argv[2] if len(sys.argv) > 2 else None
ev = json.load(open(os.path.join(HERE, 'events.json')))['ev']
meta = next(e for e in ev if e['type'] == 'meta'); FPS = meta['fps']
B = lambda k: meta['t0'] + k * 60 / meta['bpm']
cues = [e for e in ev if e.get('cue')]
worst = 0; bad = 0
print(f'== 1) 画面事件 vs 拍网格（{len(cues)} 个）')
for e in cues:
    d = (e['t'] - B(e['k'])) * 1000; fr = e['t'] * FPS; fo = abs(fr - round(fr)) / FPS * 1000
    worst = max(worst, abs(d), fo)
    if abs(d) > .5 or fo > .5: bad += 1; print(f"  ✗ {e['type']:10s} k={e['k']:<6} t={e['t']:.4f} 偏差 {d:+.2f} ms 帧外 {fo:.2f} ms")
print(f'  最大偏差 {worst:.2f} ms，不合格 {bad}')
hits = json.load(open(os.path.join(HERE, 'out/hits.json')))
vis = {round(e['t'], 4) for e in cues}
print(f'== 2) 音乐命中 vs 画面事件（{len(hits)} 个）')
miss = [h for h in hits if round(h['t'], 4) not in vis]
for h in miss: print(f"  ✗ 音乐 {h['name']} k={h['k']} 无对应画面事件")
print(f'  全部对上：{len(hits) - len(miss)}/{len(hits)}，偏差 0 ms' if not miss else f'  未对上 {len(miss)}')

# 3) 音频起音
def load_audio(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.float32)
apath = FILM or os.path.join(HERE, 'out/mix.wav'); a = load_audio(apath); SR = 48000
hop = int(.001 * SR); win = int(.004 * SR)
env = 20 * np.log10(np.sqrt(np.convolve(a.astype(np.float64) ** 2, np.ones(win) / win, 'same'))[::hop] + 1e-6)
KEY = ['slam', 'wipe', 'cut', 'row', 'tick', 'stamp', 'flip', 'delta', 'stamp2', 'end', 'name', 'cell', 'settle', 'press', 'insert', 'donetick', 'button']
print(f'== 3) 音频起音实测（{os.path.basename(apath)}：±40 ms 内包络首次比前 30 ms 中位数高 6 dB 且距窗内峰值 10 dB 以内的时刻，1 ms 分辨率）')
offs = []
for e in cues:
    if e['type'] not in KEY: continue
    i0 = int(round(e['t'] * 1000)); off = None
    for i in range(i0 - 40, i0 + 41):
        if env[i] - np.median(env[i - 35:i - 5]) > 6 and env[i] > env[i0 - 40:i0 + 41].max() - 10: off = i - i0; break
    offs.append(off if off is not None else 99)
    print(f"  {e['type']:8s} k={e['k']:<5} t={e['t']:.3f}s 起音 {'未检出' if off is None else f'{off:+d} ms'}")
ok = [o for o in offs if o != 99]
if ok: print(f'  |偏差| 中位 {np.median(np.abs(ok)):.0f} ms，最大 {max(abs(o) for o in ok)} ms（4 ms 包络窗）')

# 4) 画面：硬切 / 翻牌 的帧差峰值
if FILM and FILM.endswith(".mp4"):
    w, h = 192, 108
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', FILM, '-vf', f'scale={w}:{h}', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    dif = np.r_[0, np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))]
    print(f'== 4) 画面帧差峰值（共 {len(fr)} 帧）')
    for e in cues:
        if e['type'] not in ('cut', 'flip'): continue
        f0 = round(e['t'] * FPS); lo, hi = f0 - 3, f0 + 4
        j = lo + int(np.argmax(dif[lo:hi]))
        print(f"  {e['type']:5s} k={e['k']:<5} 拍点帧 {f0} 峰值帧 {j} → 偏差 {(j - f0) * 1000 / FPS:+.0f} ms（帧差 {dif[j]:.1f}）")
sys.exit(1 if bad or miss else 0)
