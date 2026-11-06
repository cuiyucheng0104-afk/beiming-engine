"""拍点核对：画面事件（events.json 的 hit）↔ 节拍网格 ↔ 音乐重音（cues.json）↔ 实测音频起音
用法：$LIB/.venv/bin/python tools/cuecheck.py [成片或 mix.wav]
1) 每个视觉事件是否正好落在整拍、整帧上（偏差 ms）
2) 每个视觉事件是否有同名音乐拍点，时间差（ms）
3) 在 mix 里实测该处起音（包络半高点）与帧时间的偏差（ms）
4) 定格段是否数字静音（眨眼磁带咔除外）
"""
import sys, os, json, numpy as np, soundfile as sf, subprocess
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS, FPB = 24, 11; BEAT = FPB / FPS
ev = json.load(open(os.path.join(HERE, 'events.json')))
cues = json.load(open(os.path.join(HERE, 'out', 'cues.json')))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'stems', 'music.wav')   # 默认量纯音乐声部
if src.endswith('.mp4'):
    tmp = os.path.join(HERE, 'out', '_cuecheck.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '48000', tmp], check=True); src = tmp
x, sr = sf.read(src); x = x.mean(1) if x.ndim > 1 else x
env = np.convolve(np.abs(x), np.ones(48) / 48, 'same')   # 1 ms 包络
cmap = {c['name']: c['t'] for c in cues['cues']}
hits = [e for e in ev['ev'] if e['type'] == 'hit']
worst_grid = worst_cue = 0; worst_on = 0; rows = []
for h in hits:
    t, b = h['t'], h['beat']
    grid = (t - b * BEAT) * 1000; frame = t * FPS; fdev = (frame - round(frame)) / FPS * 1000
    worst_grid = max(worst_grid, abs(grid), abs(fdev))
    mt = cmap.get(h['name'])
    cd = None if mt is None else (mt - t) * 1000
    if cd is not None: worst_cue = max(worst_cue, abs(cd))
    # 实测起音：标称拍点前后窗口内，包络从底噪升到峰值一半的那一刻（= HG 对齐用的同一定义）
    i0, i1 = int((t - .05) * sr), int((t + .09) * sr); on = None
    if h['name'] not in ('blink', 'push') and i1 < len(env):
        base = np.median(env[max(0, i0 - int(.06 * sr)):max(1, i0)]) if i0 > 0 else 0.0
        seg = env[max(0, i0):i1]; pk = seg.max()
        if pk > base * 2 + 1e-4:
            k = np.argmax(seg > base + (pk - base) * .5); on = (max(0, i0) + k) / sr; worst_on = max(worst_on, abs(on - t) * 1000)
    rows.append((h['name'], b, t, grid, fdev, cd, None if on is None else (on - t) * 1000))
print(f"{'事件':10s} {'拍':>5s} {'时间s':>8s} {'网格ms':>7s} {'帧ms':>6s} {'乐谱ms':>7s} {'实测起音ms':>10s}")
for n, b, t, g, f, c, o in rows:
    print(f"{n:10s} {b:5.0f} {t:8.4f} {g:7.2f} {f:6.2f} {('—' if c is None else f'{c:7.2f}'):>7s} {('—' if o is None else f'{o:+.1f}'):>10s}")
f0, f1 = cues['freeze']
x, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav')) if len(sys.argv) < 2 else (x, sr); x = x.mean(1) if x.ndim > 1 else x
a, z = int((f0 + .01) * sr), int((f1 - .005) * sr)
fr = x[a:z].copy(); bl = int((24 * 0 + 25 * BEAT) * sr) - a; fr[max(0, bl - 200):bl + int(.08 * sr)] = 0
print(f"\n视觉事件 ↔ 节拍网格/整帧 最大偏差 {worst_grid:.3f} ms；↔ 乐谱拍点 最大偏差 {worst_cue:.3f} ms；实测起音最大偏差 {worst_on:.1f} ms")
print(f"定格 {f0:.3f}–{f1:.3f}s 峰值（除眨眼咔）= {np.abs(fr).max():.2e}  {'真静音' if np.abs(fr).max() < 1e-4 else '有残留'}")
missing = [h['name'] for h in hits if h['name'] not in cmap]
print('缺少音乐拍点的视觉事件：', missing or '无')
