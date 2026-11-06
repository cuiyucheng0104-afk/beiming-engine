"""拍点核对：画面事件（timeline.json CUES）↔ 音乐拍点（BEATS）↔ 配乐实际落点（out/music_cues.json）↔ 拟音事件（events.json）
另在 out/mix.wav 上测关键拍附近的实际起音。用法：python tools/cuecheck.py <工程目录>；偏差 > 1 ms 退出码 1。"""
import sys, os, json, numpy as np, soundfile as sf
D = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(D, 'timeline.json'))); FPS = TL['FPS']
BEAT = {b['id']: b['f'] / FPS for b in TL['BEATS']}
EV = json.load(open(os.path.join(D, 'events.json')))['ev']
MC = json.load(open(os.path.join(D, 'out', 'music_cues.json')))
bad = 0
def key(beat):
    if isinstance(beat, (int, float)): return 'b%d' % beat
    return None if '-' in str(beat) else ('C+0' if beat == 'C' else beat)
print('== 画面事件 → 音乐拍 ==')
for name, c in TL['CUES'].items():
    k = key(c['beat']); tv = c['f'] / FPS
    if k is None: print(f'  {name:10s} {tv:7.3f}s  (休止中，不对拍：{c["beat"]})'); continue
    d = (tv - BEAT[k]) * 1000; bad += abs(d) > 1
    # 该帧上有没有拟音事件（每个可见动作都有声音）
    snd = [e['type'] for e in EV if abs(e['t'] - tv) < 1e-3]
    print(f'  {name:10s} {tv:7.3f}s  拍 {k:6s} {BEAT[k]:7.3f}s  偏差 {d:+.1f} ms  拟音 {",".join(snd) or "（乐队重音）"}')
print('== 配乐实际落点 → 拍 ==')
for c in MC:
    d = (c['t'] - BEAT[c['id']]) * 1000; bad += abs(d) > 1
    print(f'  {c["id"]:6s} {c["t"]:7.3f}s  {c["what"]}  偏差 {d:+.1f} ms')
p = os.path.join(D, 'out', 'mix.wav')
if os.path.exists(p):
    x, sr = sf.read(p); m = np.abs(x.mean(1) if x.ndim > 1 else x)
    env = np.convolve(m, np.ones(48) / 48, 'same'); dd = np.diff(env, prepend=0)
    print('== mix.wav 实测起音（±40 ms 内能量跳变最大处）==')
    for k in ['b6', 'b8', 'b12', 'b14', 'b16', 'b20', 'C+0', 'C+6', 'C+7', 'C+12']:
        t = BEAT[k]; s = int(t * sr); w = int(.04 * sr); o = (np.argmax(dd[s - w:s + w]) - w) / sr * 1000
        print(f'  {k:6s} {t:7.3f}s  起音 {o:+.1f} ms')
    a, b = int((BEAT['b20'] + .12) * sr), int((BEAT['C+0'] - .02) * sr)
    print('  静默窗口 RMS %.1f dBFS' % (20 * np.log10(np.sqrt((m[a:b] ** 2).mean()) + 1e-12)))
    i0 = a + int(np.argmax(m[a:] > 10 ** (-40 / 20)))
    print('  静默后第一声（首个超过 -40 dBFS 的采样）%.4f s，相对接帽拍 %+.1f ms' % (i0 / sr, (i0 / sr - BEAT['C+0']) * 1000))
print('结果：', '全部 0 ms 对齐' if not bad else f'{bad} 处偏差 > 1 ms')
sys.exit(1 if bad else 0)
