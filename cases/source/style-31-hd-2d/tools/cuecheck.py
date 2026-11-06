"""拍点核对：画面事件（window.EV）↔ 节拍网格 ↔ 配乐落点 ↔ 实测音频起音 ↔ 实测画面跳变。
用法：python tools/cuecheck.py [成片或 video.mp4]
输出每条事件的偏差（ms），最后给出最大偏差。"""
import json, os, sys, subprocess
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = {c['name']: c['t'] for c in json.load(open(os.path.join(HERE, 'out', 'score_cues.json')))}
SPB, FPS = TL['spb'], TL['fps']
name = lambda e: f"pop{e['i']}" if e['type'] == 'pop' else e['type']

# 1) 网格与帧对齐 + 配乐落点
rows, worst = [], 0.0
for e in EV:
    grid = (e['t'] - e['beat'] * SPB) * 1000
    frame = (e['t'] * FPS - round(e['t'] * FPS)) / FPS * 1000
    sc = (e['t'] - SC[name(e)]) * 1000 if name(e) in SC else None
    worst = max(worst, abs(grid), abs(frame), abs(sc or 0))
    rows.append([name(e), e['beat'], e['t'], grid, frame, sc])

# 2) 实测音频起音：配乐分轨上，事件前后 ±40 ms 内能量上升最陡的 5 ms 窗
mus, sr = sf.read(os.path.join(HERE, 'out', 'stems', 'music.wav')); m = np.abs(mus).mean(1)
hop = int(sr * .005); env = np.sqrt(np.convolve(m ** 2, np.ones(hop) / hop, 'same'))[::hop]
hop = int(sr * .001); env = np.sqrt(np.convolve(m ** 2, np.ones(hop * 3) / (hop * 3), 'same'))[::hop]   # 1 ms 分辨率
def onset(t):   # 事件前 30–10 ms 的电平为底，之后第一次高出 6 dB 的时刻 = 听感起音
    k0 = int(t * 1000); base = env[k0 - 30:k0 - 10].mean() + 1e-6
    for k in range(k0 - 10, k0 + 60):
        if env[k] > base * 2: return k / 1000
    return float('nan')
AUD = {}
for r in rows:
    if r[0] in SC and r[0] not in ('stop',):
        AUD[r[0]] = (onset(r[2]) - r[2]) * 1000

# 3) 实测画面：成片逐帧亮度差，事件 ±3 帧内跳变最大的那一帧
VIS = {}
vid = sys.argv[1] if len(sys.argv) > 1 else None
if vid and os.path.exists(vid):
    w, h = 160, 90
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    diff = np.r_[0, np.abs(np.diff(fr, axis=0)).mean((1, 2))]   # diff[k]：第 k 帧相对 k-1 帧
    for r in rows:
        if r[0] in ('lightning', 'cut1', 'festoon', 'cut2', 'sail') or r[0].startswith('pop'):
            k0 = int(round(r[2] * FPS)); ks = range(max(1, k0 - 3), min(len(diff), k0 + 4))
            k = max(ks, key=lambda k: diff[k]); VIS[r[0]] = ((k - k0) / FPS * 1000, diff[k] / max(1e-6, np.median(diff[max(1, k0 - 20):k0 - 3])))

print(f"{'事件':<10}{'拍':>6}{'秒':>9}{'网格ms':>8}{'帧ms':>7}{'配乐ms':>8}{'起音ms':>8}{'画面ms':>8}{'跳变倍数':>9}")
for r in rows:
    v = VIS.get(r[0]); a = AUD.get(r[0])
    print(f"{r[0]:<10}{r[1]:>6}{r[2]:>9.3f}{r[3]:>8.1f}{r[4]:>7.1f}{(r[5] if r[5] is not None else float('nan')):>8.1f}{(a if a is not None else float('nan')):>8.1f}"
          f"{(v[0] if v else float('nan')):>8.1f}{(v[1] if v else float('nan')):>9.1f}")
print(f'网格/帧/配乐落点 最大偏差 {worst:.3f} ms')
if AUD: print(f'实测起音 最大偏差 {max(abs(x) for x in AUD.values()):.1f} ms（1 ms 分辨率，高出前 20 ms 底噪 6 dB 的时刻）')
if VIS: print(f'实测画面跳变 最大偏差 {max(abs(x[0]) for x in VIS.values()):.1f} ms（1 帧 = {1000 / FPS:.1f} ms）')
