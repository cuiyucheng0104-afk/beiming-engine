"""拍点核对：画面事件（events.json，来自页面 window.EV）、配乐落点（music/score.json）、成片画面（逐帧光学检测）、混音（静默与静默后第一声）
都对照 timeline.json 的拍点网格，打印偏差（ms）。任何一项偏差 > 0.5 ms 退出码 1。
用法：python tools/cuecheck.py <工程目录> [成片.mp4]"""
import sys, os, json, subprocess
import numpy as np

D = os.path.abspath(sys.argv[1]); MP4 = sys.argv[2] if len(sys.argv) > 2 else None
TL = json.load(open(os.path.join(D, 'timeline.json'))); FPS = TL['fps']; BEATF = TL['beatf']; ENDF = TL['endf']
def bf(k):
    i = int(np.floor(k)); f = k - i
    if i >= len(BEATF) - 1: a = BEATF[-1]; return round(a + f * (ENDF - a))
    return round(BEATF[i] + f * (BEATF[i + 1] - BEATF[i]))
bt = lambda k: bf(k) / FPS
bad = 0
def row(kind, name, beat, t, ref=None):
    global bad
    ref = bt(beat) if ref is None else ref
    dev = (t - ref) * 1000
    fr = t * FPS; onf = abs(fr - round(fr)) < 1e-6
    ok = abs(dev) <= .5 and onf
    bad += 0 if ok else 1
    print(f'  {kind:6s} {name:18s} 拍 {beat:<6} 帧 {fr:7.2f}  偏差 {dev:+7.2f} ms  {"OK" if ok else "!!"}')

print('— 拍点网格：每拍都是整数帧 —')
print('  ', ' '.join(f'{b}:{f}' for b, f in enumerate(BEATF)))
print('  拍距（帧）', [BEATF[i + 1] - BEATF[i] for i in range(len(BEATF) - 1)])

ev = json.load(open(os.path.join(D, 'events.json')))['ev']
print('— 画面事件（window.EV）—')
for e in ev:
    if 'beat' in e: row('画面', e['type'], e['beat'], e['t'])
sc = json.load(open(os.path.join(D, 'music', 'score.json')))['marks']
print('— 配乐落点（score.json）—')
for m in sc: row('音乐', m['name'], m['beat'], m['t'])

print('— 画面 × 音乐 同拍配对 —')
vb = {}; [vb.setdefault(e['beat'], []).append(e) for e in ev if 'beat' in e]
mb = {}; [mb.setdefault(m['beat'], []).append(m) for m in sc]
for k, b in TL['hit'].items():
    v, m = vb.get(b, []), mb.get(b, [])
    if not v and not m: continue
    dv = [(x['t'] - y['t']) * 1000 for x in v for y in m]
    worst = max([abs(x) for x in dv], default=float('nan'))
    print(f'  {k:8s} 拍 {b:<5} 画面 {len(v)} 个 / 音乐 {len(m)} 个  最大偏差 {worst:.2f} ms' + ('' if m else '  （此拍只有拟音）'))
    if dv and worst > .5: bad += 1

# 混音：静默窗口与静默后第一声
try:
    import soundfile as sf
    x, sr = sf.read(os.path.join(D, 'out', 'mix.wav')); x = np.abs(x).max(1)
    a, b = int(round(bt(TL['hit']['hush']) * sr)), int(round(bt(TL['hit']['cry']) * sr))
    print('— 混音 —')
    print(f'  静默 {a / sr:.3f}–{b / sr:.3f} s 峰值 {20 * np.log10(x[a:b].max() + 1e-12):.1f} dBFS')
    nz = np.nonzero(x[a:] > 10 ** (-60 / 20))[0]
    first = (a + nz[0]) / sr if len(nz) else float('nan')
    print(f'  静默后第一声（鹤唳）起音 {first:.4f} s，拍 11 = {bt(11):.4f} s，偏差 {(first - bt(11)) * 1000:+.2f} ms')
    if abs(first - bt(11)) > .0015: bad += 1
except Exception as ex:
    print('  （混音未检查：', ex, ')')

# 成片画面：光学检测
if MP4:
    W, H = 480, 270
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', MP4, '-vf', f'scale={W}:{H}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    F = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3).astype(np.float32) / 255
    r, g, bl = F[..., 0], F[..., 1], F[..., 2]
    red = ((r > .45) & (r - g > .22) & (r - bl > .22)).sum((1, 2))
    lum = .3 * r + .59 * g + .11 * bl
    dark = (lum < .2).sum((1, 2))
    print(f'— 成片光学检测（{len(F)} 帧）—')
    def first(cond, start=0):
        idx = np.nonzero(cond[start:])[0]; return start + idx[0] if len(idx) else -1
    # 1 山脊笔锋入画 / 收笔：暗像素开始出现、增长停止
    f_in = first(dark > 20)
    grow = np.diff(dark[:60].astype(float)); f_end = int(f_in + np.nonzero(grow[f_in:] < 50)[0][0])   # 笔画停止增长的那一帧 = 收笔（之后的增长是墨向下渗开）
    print(f'  山脊一笔：第 {f_in} 帧入画，第 {f_end} 帧收笔（拍 1 = {bf(1)}）偏差 {(f_end - bf(1)) / FPS * 1000:+.0f} ms')
    if f_end != bf(1): bad += 1
    # 2 丹顶朱红：第一次出现红色
    f_red = first(red > 3)
    print(f'  丹顶一点朱红 第 {f_red} 帧（拍 8.5 = {bf(8.5)}）偏差 {(f_red - bf(8.5)) / FPS * 1000:+.0f} ms'); bad += f_red != bf(8.5)
    # 3 钤印：红色像素跃升
    jump = np.diff(red.astype(float)); f_seal = int(np.argmax(jump[300:]) + 301)
    print(f'  钤印 第 {f_seal} 帧（拍 22 = {bf(22)}）偏差 {(f_seal - bf(22)) / FPS * 1000:+.0f} ms'); bad += f_seal != bf(22)
    # 4 墨晕满幅：四角都进入夜色的第一帧
    # 四个角各自都已是夜景（各自与满幅后的值相差 < .02）才算满幅；只看最暗的一角会被晕前那圈深色潮线提前触发
    C = np.stack([lum[:, :12, :12].mean((1, 2)), lum[:, :12, -12:].mean((1, 2)), lum[:, -12:, :12].mean((1, 2)), lum[:, -12:, -12:].mean((1, 2))], 1)
    ref = C[bf(19) + 6]; f_full = first((np.abs(C - ref) < .02).all(1), bf(16))
    print(f'  墨晕满幅（四角入夜）第 {f_full} 帧（拍 19 = {bf(19)}）偏差 {(f_full - bf(19)) / FPS * 1000:+.0f} ms'); bad += abs(f_full - bf(19)) > 0
    # 5 静默段：画面不空（不是空白帧）
    sd = lum[bf(10):bf(11)].std((1, 2))
    print(f'  静默段画面亮度标准差最小 {sd.min():.3f}（> 0.01 即有内容，非空白帧）')
    bad += sd.min() < .01

print('—', '全部对齐，0 ms' if not bad else f'{bad} 项不对齐', '—')
sys.exit(1 if bad else 0)
