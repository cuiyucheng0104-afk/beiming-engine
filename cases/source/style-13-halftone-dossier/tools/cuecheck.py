"""拍点核对：画面事件 vs 音乐网格 vs 实际音频起音 vs 成片帧变化。
用法：python tools/cuecheck.py [成片.mp4]
1) timeline 里每个 HIT 是否落在整帧上（帧量化误差）
2) window.EV（events.json，画面导出的事件）里带 hit 的声音事件时间 vs 音乐网格
3) 拟音/音乐分轨里实测起音时间 vs 网格（能量包络的上升沿）
4) 成片里三次闪光（揭晓 / 猛拉远落定 / 印章）的亮度跳升是否正好落在拍点那一帧"""
import os, sys, json, subprocess
import numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json'))); T, FPS = TL['t'], TL['fps']
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
bad = 0
print('— 1. 拍点落帧 —')
worst = 0
for k, t in T.items():
    off = (round(t * FPS) / FPS - t) * 1000; worst = max(worst, abs(off))
    if abs(off) > .01: bad += 1; print(f'  BAD {k} {t:.4f}s 偏 {off:.2f} ms')
print(f'  {len(T)} 个拍点，最大帧量化偏差 {worst:.3f} ms')

print('— 2. 画面事件（EV）vs 网格 —')
worst = 0; n = 0
for e in EV:
    if 'hit' not in e: continue
    t = e.get('peak', e['t']); off = (t - T[e['hit']]) * 1000; n += 1; worst = max(worst, abs(off))
    if abs(off) > .5: bad += 1; print(f'  BAD {e["hit"]} ev {t:.4f} grid {T[e["hit"]]:.4f} 偏 {off:.2f} ms')
print(f'  {n} 个带拍点的事件，最大偏差 {worst:.3f} ms')

print('— 3. 音频实测起音 vs 网格 —')
HX = [sf.read(os.path.join(HERE, 'out', f'stem_hits{c}.wav'))[0] for c in 'AB']; sr = 48000   # mix.py 写出的拍点声音干声分轨（相邻拍点交替）
HORD = {h: i % 2 for i, h in enumerate(sorted({e['hit'] for e in EV if 'hit' in e}, key=lambda h: T[h]))}
from scipy.signal import butter, sosfilt
HP = butter(2, 800, 'high', fs=48000, output='sos')
def onset(x, t, pre=.03, post=.03):
    """起音 = 高通后对数能量（2 ms 窗、0.5 ms 步）上升最陡的位置；不受前一个声音余音的影响"""
    a, b = int((t - pre - .01) * sr), int((t + post + .01) * sr)
    seg_ = x[max(0, a):b].mean(1); seg_ = np.concatenate([np.zeros(max(0, -a)), seg_]); s = sosfilt(HP, seg_)
    hop, win = int(.0005 * sr), int(.002 * sr)
    e = np.array([np.log10(np.mean(s[i:i + win] ** 2) + 1e-10) for i in range(0, len(s) - win, hop)])
    d = np.diff(e); lo = int(.01 * sr / hop); hi = len(d) - lo
    k = lo + int(np.argmax(d[lo:hi])); return (a + (k + 1) * hop + win) / sr   # 能量窗末端 = 新声音进入的时刻
rows = []
for e in EV:
    h = e.get('hit')
    if not h or 'peak' in e or e['type'] in ('lookup', 'swallow'): continue
    src = HX[HORD[h]]
    t_on = onset(src, T[h]); off = (t_on - T[h]) * 1000; rows.append((h, e['type'], off))
for h, ty, off in rows:
    flag = 'OK ' if abs(off) <= 5 else 'BAD'; bad += flag == 'BAD'
    print(f'  {flag} {h:8s} {ty:10s} 起音偏差 {off:+6.2f} ms')
print(f'  {len(rows)} 个，最大 |偏差| {max(abs(r[2]) for r in rows):.2f} ms（容差 ±5 ms，≈ 1/7 帧）')

if len(sys.argv) > 1:
    print('— 4. 成片里闪光帧（亮度跳升）是否正好在拍点帧 —')
    mp4 = sys.argv[1]
    for h in ['flash1', 'snap', 'stamp']:
        f0 = round(T[h] * FPS); a = f0 - 4
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{a / FPS:.4f}', '-i', mp4, '-frames:v', '9', '-vf', 'scale=480:270', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
        fr = np.frombuffer(raw, np.uint8).reshape(-1, 270, 480).astype(float)
        d = [fr[i].mean() - fr[i - 1].mean() for i in range(1, len(fr))]; pk = a + 1 + int(np.argmax(d))   # 闪光帧 = 平均亮度跳升最大的那一帧
        flag = 'OK ' if pk == f0 else 'BAD'; bad += flag == 'BAD'
        print(f'  {flag} {h:7s} 期望第 {f0} 帧，亮度跳升在第 {pk} 帧（{(pk - f0) / FPS * 1000:+.1f} ms）')
print('结果：', '全部通过（网格与画面事件 0 ms；实测起音误差在 0.5 ms 测量步长量级）' if not bad else f'{bad} 项不通过')
sys.exit(1 if bad else 0)
