"""cuecheck.py — 拍点核对：画面事件（events.json，来自 window.EV）↔ 节拍网格 ↔ 音乐事件（out/score.json）↔ 实际音频起音（out/mix.wav）↔ 实际画面突变（成片）。
用法：$LIB/.venv/bin/python tools/cuecheck.py   （任何一项偏差 > 0 ms / 静默不为真零 → 退出码 1）
"""
import json, os, sys, subprocess
import numpy as np, soundfile as sf

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = json.load(open(os.path.join(HERE, 'out', 'score.json')))
FPS = TL['FPS']; A, B, CUE = TL['A'], TL['B'], TL['CUE']
bad = 0

def grid(f):
    """离最近拍点的偏差（帧）与拍号"""
    if f < B['f0']:
        k = round((f - A['f0']) / A['fpb']); return f - (A['f0'] + k * A['fpb']), f'A 拍{k}'
    k = round((f - B['f0']) / B['fpb']); bar, beat = divmod(k, B['meter']); return f - (B['f0'] + k * B['fpb']), f'B {bar}:{beat}'

print('── 1. 画面事件 ↔ 节拍网格 ──')
vis = {e['cue']: e['f'] for e in EV if e.get('cue')}
for name, f in sorted(vis.items(), key=lambda kv: kv[1]):
    d, lab = grid(f); ms = d / FPS * 1000
    if f != CUE[name]: bad += 1
    if abs(ms) > 0: bad += 1
    print(f'  {name:8s} 帧 {f:3d}  {f / FPS:7.3f}s  {lab:8s}  偏差 {ms:+.1f} ms' + ('' if f == CUE[name] else '  ✗ 与 timeline 不符'))

print('── 2. 画面事件 ↔ 音乐事件（score.json）──')
mus = {m['name']: m['t'] for m in SC['music']}
PAIRS = [('stop', 'A_dominant'), ('push', 'A_push'), ('chomp', 'chomp_stinger'), ('swirl', 'swirl_fill'), ('battle', 'battle_downbeat'),
         ('cursor', 'battle_phrase2'), ('tremble', 'strip'), ('spit', 'friend_theme'), ('catch', 'item_fanfare'), ('status', 'exp_build'),
         ('levelup', 'levelup_fanfare'), ('phrase2', 'fanfare_phrase2'), ('mosaic', 'mosaic_arp'), ('final', 'final_chord')]
for v, m in PAIRS:
    tv = CUE[v] / FPS; ms = (mus[m] - tv) * 1000
    if abs(ms) > 0.01: bad += 1
    print(f'  {v:8s} ↔ {m:16s} {tv:7.3f}s  偏差 {ms:+.2f} ms')

print('── 3. 实际音频起音（mix.wav，2 ms 分辨率）──')
x, sr = sf.read(os.path.join(HERE, 'out', 'mix.wav')); m = np.abs(x).max(1)
hop = sr // 500
envl = np.array([m[i:i + hop].max() for i in range(0, len(m) - hop, hop)])
def onset(t, win=.06):
    """t 附近第一次“比前 30 ms 峰值高 6 dB 以上”的起音点"""
    i0, i1 = int((t - win) * 500), int((t + win) * 500)
    for i in range(max(15, i0), min(len(envl), i1)):
        prev = envl[i - 15:i].max() + 1e-6
        if envl[i] > 2 * prev and envl[i] > 0.02: return i / 500
    return None
for v in ['open', 'step1', 'step2', 'step3', 'stop', 'chomp', 'battle', 'cursor', 'cur1', 'cur2', 'select', 'heart', 'spit', 'catch', 'status', 'levelup', 'final']:
    tv = CUE[v] / FPS; to = onset(tv)
    if to is None: print(f'  {v:8s} {tv:7.3f}s  未检出起音（被前面的声音盖住，见 2）'); continue
    ms = (to - tv) * 1000
    if abs(ms) > 2.0: bad += 1
    print(f'  {v:8s} {tv:7.3f}s  起音 {to:7.3f}s  偏差 {ms:+.1f} ms（检测分辨率 2 ms）')

print('── 4. 静默窗口：真零（含回声尾巴）──')
for f0, f1 in TL['SILENCE']:
    seg = x[f0 * sr // FPS:f1 * sr // FPS]; mx = float(np.abs(seg).max())
    nxt = x[f1 * sr // FPS:f1 * sr // FPS + sr // 10]
    if mx != 0: bad += 1
    print(f'  {f0 / FPS:6.3f}–{f1 / FPS:6.3f}s  最大幅度 {mx:.1e}  {"真零 ✓" if mx == 0 else "✗"}   静默后第一声峰值 {20 * np.log10(np.abs(nxt).max() + 1e-12):.1f} dBFS')

film = os.path.join(HERE, '29-pixel-rpg.mp4')
if os.path.exists(film) and os.path.getmtime(film) >= os.path.getmtime(os.path.join(HERE, 'out', 'mix.wav')):
    print('── 4b. 成片（AAC 解码后）静默窗口 ──')
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', film, '-vn', '-ac', '2', '-ar', str(sr), '-f', 'f32le', '-'], capture_output=True).stdout
    y = np.abs(np.frombuffer(raw, np.float32).reshape(-1, 2)).max(1)
    for f0, f1 in TL['SILENCE']:
        a, b = f0 * sr // FPS, f1 * sr // FPS - int(.006 * sr)    # 窗口末 6 ms 留给下一声的 AAC 预回声
        mx = float(y[a:b].max()); db = 20 * np.log10(mx + 1e-12)
        nz = np.nonzero(y[a:f1 * sr // FPS])[0]; first = (a + nz[0]) / sr if len(nz) else None
        if mx > 0: bad += 1
        print(f'  {f0 / FPS:6.3f}–{f1 / FPS:6.3f}s  最大 {db:7.1f} dBFS  {"真零 ✓" if mx == 0 else "✗"}   窗口内首个非零采样 {first if first is None else f"{first:.4f}s"}')
vid = os.path.join(HERE, 'out', 'video.mp4')
src = vid if os.path.exists(vid) else None
if src:
    print('── 5. 实际画面突变（out/video.mp4，逐帧差）──')
    w, h = 320, 180
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-vf', f'scale={w}:{h}:flags=area,format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    dif = np.r_[0, np.abs(np.diff(fr, axis=0)).mean((1, 2))]
    for v in ['chomp', 'swirl', 'battle', 'tremble', 'select', 'heart', 'status', 'levelup', 'mosaic']:
        f = CUE[v]; lo, hi = f - 3, f + 4
        if v == 'mosaic': lo, hi = f - 7, f + 7
        k = lo + int(np.argmax(dif[lo:hi]))
        if v == 'mosaic':   # 马赛克峰值：块最大（画面细节最少）的帧
            det = np.array([np.abs(np.diff(fr[i], axis=1)).mean() for i in range(lo, hi)]); k = lo + int(np.argmin(det))
        d = k - f
        if v not in ('mosaic',) and d != 0: bad += 1
        print(f'  {v:8s} 帧 {f:3d}  画面变化最大帧 {k:3d}  偏差 {d / FPS * 1000:+.1f} ms')
    print(f'  帧数 {len(fr)}（应为 {TL["NFRAMES"]}）')
    if len(fr) != TL['NFRAMES']: bad += 1

print('══ 结果：', '全部 0 ms ✓' if not bad else f'{bad} 项不合格 ✗')
sys.exit(1 if bad else 0)
