"""拍点核对：画面事件（逐帧 PROBE 判定）↔ 节拍网格 ↔ 配乐实际下音（score_events.json）↔ 音频起音（stem_music.wav 实测）
用法：python cuecheck.py   （先跑 events.mjs、probe.mjs、mix.py）"""
import json, os, sys
import numpy as np, soundfile as sf
H = os.path.dirname(os.path.abspath(__file__))
E = json.load(open(f'{H}/events.json')); PR = json.load(open(f'{H}/out/probe.json')); SC = json.load(open(f'{H}/out/score_events.json'))
fps = PR['fps']; FR = PR['frames']; meta = next(e for e in E['ev'] if e['type'] == 'meta'); BEAT = meta['beat']; T = meta['T']
x, sr = sf.read(f'{H}/out/stem_music.wav'); x = np.abs(x).mean(1)
def first(pred):
    for f, p in enumerate(FR):
        if pred(f, p): return f
    return None
vis = []   # (名称, 画面帧, 期望拍, 配乐角色)
vis.append(('晨光/叶片起转', first(lambda f, p: f + 1 < len(FR) and p['ang'] == 0 and FR[f + 1]['ang'] > 0), 1, 'sunhit'))
vis.append(('转台启动', first(lambda f, p: f > 0 and abs(p['az'] - 40) < 1e-9 and f + 1 < len(FR) and FR[f + 1]['az'] > p['az']), 4, None))
vis.append(('转台停住', first(lambda f, p: p['az'] >= 400 - 1e-9), 16, None))
for i in range(len(FR[0]['wins'])):
    vis.append((f'窗{i + 1}', first(lambda f, p, i=i: p['wins'][i] > 0), None, 'win0_chime' if i == 0 else 'win'))
vis.append(('顶灯/硬切', first(lambda f, p: p['lamp'] > 0), 24, 'lamp_bell'))
cut = first(lambda f, p: p['shot'] == 'lamp')
for i in range(len(FR[0]['stars'])): vis.append((f'亮星{i + 1}', first(lambda f, p, i=i: p['stars'][i] > 0), None, 'star'))
for i in range(len(FR[0]['letters'])): vis.append((f'字{i + 1}', first(lambda f, p, i=i: p['letters'][i] is not None and p['letters'][i] <= 0), None, 'letter'))
ev_by = {}
for e in E['ev']:
    if e['type'] in ('win', 'star', 'letter'): ev_by.setdefault(e['type'], []).append(e)
def expected_beat(name):
    if name.startswith('窗'): return ev_by['win'][int(name[1:]) - 1]['beat']
    if name.startswith('亮星'): return ev_by['star'][int(name[2:]) - 1]['beat']
    if name.startswith('字'): return ev_by['letter'][int(name[1:]) - 1]['beat']
from scipy.signal import butter, sosfilt
xh = np.abs(sosfilt(butter(2, 1500, 'high', fs=sr, output='sos'), sf.read(f'{H}/out/stem_music.wav')[0].mean(1)))
def onset(t):
    """采样起音：高通包络（2 ms 平滑）在 [t-20ms, t+40ms] 内正向变化最大的位置"""
    a, b_ = int((t - .02) * sr), int((t + .04) * sr); k = int(.002 * sr)
    env = np.convolve(xh[a - k:b_ + k], np.ones(k) / k, 'same')[k:-k]; d = np.diff(env, prepend=env[0])
    return (a + int(np.argmax(d))) / sr
rows, worst_grid, worst_score = [], 0, 0
for name, f, beat, role in vis:
    beat = beat if beat is not None else expected_beat(name)
    tv = f / fps; tg = beat * BEAT; d_grid = (tv - tg) * 1000
    note = None
    if role:
        c = [s for s in SC if s['role'] == role and abs(s['t'] - tv) < .1]
        note = min(c, key=lambda s: abs(s['t'] - tv))['t'] if c else None
    d_score = (note - tv) * 1000 if note is not None else None
    on = onset(note) if note is not None else None
    rows.append((name, f, tv, beat, d_grid, d_score, (on - note) * 1000 if on is not None else None))
    worst_grid = max(worst_grid, abs(d_grid)); worst_score = max(worst_score, abs(d_score) if d_score is not None else 0)
print(f'{"事件":8s} {"帧":>4s} {"画面秒":>8s} {"拍":>7s} {"画面−拍点":>9s} {"配乐−画面":>9s} {"采样起音":>8s}')
for name, f, tv, beat, dg, ds, do in rows:
    print(f'{name:8s} {f:4d} {tv:8.4f} {beat:7.3f} {dg:8.1f}ms {("%8.1fms" % ds) if ds is not None else "      —  "} {("%6.1fms" % do) if do is not None else "    —"}')
print(f'硬切帧 {cut}（{cut / fps:.4f}s，应为第 24 拍 {24 * BEAT:.4f}s）')
# 静默段核对
mix, _ = sf.read(f'{H}/out/mix.wav'); m = mix.mean(1)
def rms(a, b_): s = m[int(a * sr):int(b_ * sr)]; return 20 * np.log10(np.sqrt((s ** 2).mean()) + 1e-12)
mus_full, _ = sf.read(f'{H}/out/stem_music.wav')
def mrms(a, b_): s = mus_full[int(a * sr):int(b_ * sr)].mean(1); return 20 * np.log10(np.sqrt((s ** 2).mean()) + 1e-12)
print(f'静默 {T["stop"] + .3:.2f}–{T["win0"]:.2f}s：总混音 {rms(T["stop"] + .3, T["win0"] - .01):.1f} dBFS，音乐总线 {mrms(T["stop"] + .02, T["win0"] - .01):.1f} dBFS；静默后第一声 {T["win0"]:.2f}–{T["win0"] + .6:.2f}s：{rms(T["win0"], T["win0"] + .6):.1f} dBFS')
print(f'屏息 {T["breath"]:.3f}–{T["lamp"]:.3f}s：总混音 {rms(T["breath"], T["lamp"] - .01):.1f} dBFS；顶灯后 0.6 s：{rms(T["lamp"], T["lamp"] + .6):.1f} dBFS')
print(f'最大偏差：画面↔拍点 {worst_grid:.1f} ms；配乐↔画面 {worst_score:.1f} ms')
sys.exit(0 if worst_grid < .5 and worst_score < .5 and cut / fps == 24 * BEAT else 1)
