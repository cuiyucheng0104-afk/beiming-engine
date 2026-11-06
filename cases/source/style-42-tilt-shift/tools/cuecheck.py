"""拍点核对：视觉事件（events.json 的 vhit，逐帧扫描真实画面状态得到）↔ 节拍网格 ↔ 音乐/拟音落点（out/audio_cues.json）↔ 成片音频的真实起音。
用法：python tools/cuecheck.py [film.mp4 或 mix.wav]
"""
import sys, os, json, subprocess
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(HERE, 'events.json')))['ev']
G = {n: t for n, t in E[0]['grid']}
AC = json.load(open(os.path.join(HERE, 'out', 'audio_cues.json')))['cues']
SR = 48000
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'mix.wav')
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, np.float32)
# 起音包络：2 ms 窗能量的正向差分
w = int(.002 * SR); en = np.sqrt(np.convolve(x ** 2, np.ones(w) / w, 'same') + 1e-12); db = 20 * np.log10(en)
def onset_near(t, win=.03):
    """t 附近 ±win 内的起音：5 ms 差分抬升曲线里，第一次达到最大抬升 60% 的位置"""
    a, b = int((t - win) * SR), int((t + win) * SR); L = int(.005 * SR)
    seg_ = db[a:b] - db[a - L:b - L]; m = seg_.max()
    i = int(np.nonzero(seg_ >= .6 * m)[0][0]); return (a + i - L // 2) / SR, float(m)

# 视觉事件 → 网格 → 声音
want = {   # vhit 名 → 期望的声音 cue 名
    'cut:S2': 'mar1:A8', 'cut:S3': 'tapestop', 'cut:S4': 'bass:C6', 'pointer': 'pointer', 'real': None, 'tugStop': None,
    'horn': 'horn', 'rise': 'mar1:C1', 'cloud1': 'cloud1', 'cloud2': 'cloud2',
    'light:lamps': 'light:lamps', 'light:boom': 'light:boom', 'sign': 'sign', 'light:windows': 'mar1:windows', 'light:lighthouse': 'light:lighthouse', 'light:mast': 'final',
}
rows, worst_v, worst_a = [], 0.0, 0.0
for e in E:
    if e['type'] != 'vhit': continue
    nm, tv, g = e['name'], e['t'], e['grid']; tg = G[g]; dv = (tv - tg) * 1000
    cue = want.get(nm)
    if nm.startswith('land'): cue = 'clank'
    da = None
    if cue:
        c = [a for a in AC if a['name'] == cue or (cue == 'clank' and a['name'] in ('clank', 'clank0'))]
        if c: ta = min(c, key=lambda a: abs(a['t'] - tv))['t']; da = (ta - tv) * 1000
    worst_v = max(worst_v, abs(dv)); worst_a = max(worst_a, abs(da)) if da is not None else worst_a
    rows.append((tv, nm, g, dv, cue, da))
print('%-8s %-18s %-5s %9s  %-14s %9s' % ('t(s)', '视觉事件', '拍点', '画-拍ms', '声音cue', '声-画ms'))
for tv, nm, g, dv, cue, da in sorted(rows):
    print('%-8.3f %-18s %-5s %9.1f  %-14s %9s' % (tv, nm, g, dv, cue or '-', '%.1f' % da if da is not None else '-'))
print('\n画面事件 vs 拍点网格 最大偏差 %.2f ms；声音 cue vs 画面事件 最大偏差 %.2f ms' % (worst_v, worst_a))
# 实测：在承载该 cue 的分轨里找真实起音（2 ms 包络第一次超过前 30 ms 底噪 4 倍处）
import soundfile as sf
STEM = {'land1': 'sfx', 'land4': 'sfx', 'cut:S2': 'sfx', 'land12': 'sfx', 'pointer': 'glock', 'horn': 'horn', 'light:lamps': 'sfx', 'light:boom': 'sfx',
        'sign': 'sfx', 'light:windows': 'sfx', 'light:lighthouse': 'sfx', 'light:mast': 'sfx'}   # 只量瞬态清楚的分轨（拟音咔哒、汽笛、钟琴、马林巴）
print('\n分轨实测起音：')
worst_o = 0.0
for nm, st in STEM.items():
    tv = [e['t'] for e in E if e['type'] == 'vhit' and e['name'] == nm][0]
    y, _ = sf.read(os.path.join(HERE, 'out', 'stems', st + '.wav')); y = np.abs(y).max(1)
    env = np.sqrt(np.convolve(y ** 2, np.ones(96) / 96, 'same'))
    a = int((tv - .03) * SR); pre = np.sqrt((y[int((tv - .045) * SR):a] ** 2).mean()) + 1e-5
    idx = np.nonzero(env[a:a + int(.08 * SR)] > 4 * pre)[0]
    to = (a + idx[0] - 48) / SR if len(idx) else float('nan'); d = (to - tv) * 1000; worst_o = max(worst_o, abs(d))
    print('  %-18s 分轨 %-5s 画 %.4f  声 %.4f  偏差 %+5.1f ms' % (nm, st, tv, to, d))
print('分轨实测起音最大偏差 %.1f ms（检测窗 2 ms；采样本身的起音前沿 1–7 ms）' % worst_o)
# 静默窗
def rms(a, b): y = x[int(a * SR):int(b * SR)]; return 20 * np.log10(np.sqrt((y ** 2).mean()) + 1e-12)
print('\n静默窗 %.3f–%.3f s RMS %.1f dBFS；A 段 RMS %.1f dBFS；汽笛后 1 s RMS %.1f dBFS' % (G['A20'], G['C0'], rms(G['A20'] + .05, G['C0'] - .02), rms(0, G['A16']), rms(G['C0'], G['C0'] + 1)))
