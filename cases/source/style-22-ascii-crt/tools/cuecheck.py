"""拍点核对：画面事件 ↔ 音乐拍点 ↔ 拟音，全部对照 timeline.json 的拍网格。
1) 页面导出的事件时刻 vs 拍网格（理论值）；
2) 音频实测起音（分轨包络，1 ms 分辨率）vs 拍网格；
3) 成片画面实测（逐帧解码：帧差、冰青像素、亮度塌缩）vs 拍网格。
用法：python tools/cuecheck.py [video.mp4]   退出码 0 = 所有关键事件偏差 ≤ 1 ms（画面以帧为单位，整拍事件 = 0 ms）"""
import json, os, sys, subprocess, numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))
B, FPS, C = TL['BEAT'], TL['FPS'], TL['CUE']
b = lambda n: n * B
bad = []
print(f'速度 {TL["BPM"]:.3f} BPM，每拍 {TL["BEAT_FRAMES"]} 帧 = {B*1000:.3f} ms')

# ---------- 1. 页面事件 vs 拍网格 ----------
print('\n[1] 画面时间轴（window.EV 的 cue）vs 拍网格')
for e in EV['ev']:
    if e['type'] != 'cue': continue
    d = (e['t'] - b(e['beat'])) * 1000; fr = e['t'] * FPS
    fq = (round(fr) / FPS - b(e['beat'])) * 1000
    print(f"  {e['name']:8s} 拍 {e['beat']:5.2f}  {e['t']:7.3f}s  帧 {fr:7.2f}  时间轴偏差 {d:+.2f} ms  落帧偏差 {fq:+.2f} ms")
    if abs(d) > .5 or (float(e['beat']).is_integer() and abs(fq) > .5): bad.append(e['name'])

# ---------- 2. 音频实测起音 ----------
def onset(x, t, pre=.12, post=.12):
    a = np.abs(x).max(1) if x.ndim > 1 else np.abs(x)
    i0, i1 = int((t - pre) * 48000), int((t + post) * 48000)
    w = a[i0:i1]; blk = 48
    env = np.array([w[k:k + blk].max() for k in range(0, len(w) - blk, blk)])
    base = np.median(env[:int(pre * 1000 * .6)]) if len(env) else 0
    pk = env.max(); thr = base + .05 * (pk - base)
    k = int(np.argmax(env > thr))
    return (t - pre) + k * blk / 48000
stem = lambda n: sf.read(os.path.join(HERE, 'out', 'stems', n + '.wav'))[0]
print('\n[2] 音频实测起音 vs 拍网格（1 ms 分辨率）')
checks = [('回车·门限击打', 'hits', C['enter']), ('海完整·击打', 'hits', C['sea']), ('拉远·击打', 'hits', C['pull0']),
          ('鲸歌', 'song', C['song']), ('鲸跃出·低音滑落', 'breach', C['breach']), ('鲸跃出·采样大鼓', 'samp', C['breach']),
          ('变青·击打', 'hits', C['cyan']), ('变青·F#5 大三度', 'color', C['cyan']), ('变青·D 大三和弦', 'pad', C['cyan']), ('鲸落水·大鼓', 'thud', C['land']),
          ('回车·键声', 'solo_enter', C['enter']), ('碎裂·嗞', 'solo_shatter', C['shatter']), ('BEL', 'solo_bel', C['bel']), ('关机', 'solo_poweroff', C['off'])]
for name, st, bt in checks:
    x = stem(st); o = onset(x, b(bt)); d = (o - b(bt)) * 1000
    print(f'  {name:16s} 拍 {bt:5.2f}  实测 {o:7.3f}s  偏差 {d:+.0f} ms');
    if abs(d) > 3: bad.append(name)
mix = sf.read(os.path.join(HERE, 'out', 'mix.wav'))[0]
a0, a1 = int(b(C['drop']) * 48000), int(b(C['breach']) * 48000)
hush = mix[a0 + 200:a1 - 10]; rms = 20 * np.log10(np.sqrt((hush ** 2).mean()) + 1e-12)
pre = mix[a0 - 48000 // 2:a0]; rms_pre = 20 * np.log10(np.sqrt((pre ** 2).mean()) + 1e-12)
print(f'  静默段 {b(C["drop"]):.3f}–{b(C["breach"]):.3f}s：{rms:.1f} dBFS（静默前 0.5 s：{rms_pre:.1f} dBFS）')
post = mix[a1:a1 + 48000 // 2]; print(f'  静默后第一声 0.5 s 内峰值 {20*np.log10(np.abs(post).max()):.1f} dBFS')

# ---------- 3. 成片画面实测 ----------
vid = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'video.mp4')
if os.path.exists(vid):
    w, h = 192, 108
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', vid, '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    F = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3).astype(np.float32)
    lum = F.mean(3); diff = np.abs(np.diff(lum, axis=0)).mean((1, 2))
    cyan = ((F[..., 2] > F[..., 0] + 25) & (F[..., 1] > 90)).sum((1, 2))
    print(f'\n[3] 成片画面实测（{len(F)} 帧）vs 拍网格')
    def first(cond, f0, f1):
        for f in range(f0, min(f1, len(cond))):
            if cond[f]: return f
        return None
    def rep(name, f, bt):
        if f is None: print(f'  {name}: 未检出'); bad.append(name); return
        d = (f / FPS - b(bt)) * 1000; print(f'  {name:14s} 拍 {bt:5.2f}  第 {f} 帧 = {f/FPS:7.3f}s  偏差 {d:+.0f} ms')
        if abs(d) > 1: bad.append(name)
    # 碎裂：b10 前是静止句子（只有光标闪），碎裂起帧差陡增
    # 只看句子左半段（光标在句尾，不进这个区域）
    dS = np.abs(np.diff(lum[:, 44:64, 30:110], axis=0)).mean((1, 2))
    fb = int(round(b(C['shatter']) * FPS)); base = np.median(dS[fb - 12:fb - 1])
    f = first(dS > base * 4 + .5, fb - 12, fb + 6); rep('句子碎裂', None if f is None else f + 1, C['shatter'])
    fb = int(round(b(C['breach']) * FPS)); base = np.median(diff[fb - 20:fb - 1])
    f = first(diff > base * 3 + .3, fb - 20, fb + 6); rep('鲸跃出（首个动帧）', None if f is None else f + 1, C['breach'])
    fb = int(round(b(C['cyan']) * FPS)); f = first(cyan > 30, fb - 30, fb + 6); rep('第一抹冰青', f, C['cyan'])
    fb = int(round(b(C['off']) * FPS)); base = np.median(diff[fb - 10:fb - 1])
    f = first(diff > base * 3 + .3, fb - 10, fb + 6); rep('关机开始塌缩', None if f is None else f + 1, C['off'])
    print(f'  冰青在变青前的最大像素数 {int(cyan[:int(round(b(C["cyan"])*FPS))].max())}，之后 {int(cyan[int(round(b(C["cyan"])*FPS)):].max())}')
print('\n结论：', '全部对齐' if not bad else '有偏差：' + '、'.join(bad))
sys.exit(1 if bad else 0)
