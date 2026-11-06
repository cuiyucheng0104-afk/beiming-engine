"""拍点核对：python tools/cuecheck.py [film.mp4]
1) 画面事件（events.json 里 cue=true 的）是否落在拍网格上、是否正好在帧上；
2) 画面事件 ↔ 配乐拍点（out/score_cues.json）逐条配对，比较时间；
3) 在真实音频里测起音：关键声音（静默后的第一声、哔、砸门…）的实际起音时刻 vs 画面事件时刻；
4) 硬切：配乐分轨在静默段是否真的是 0。
"""
import sys, os, json, subprocess, numpy as np, soundfile as sf
H = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = json.load(open(os.path.join(H, 'events.json'))); M = next(e for e in E['ev'] if e['type'] == 'meta')
B, FPS, HIT = M['B'], M['FPS'], M['hit']
cues = {c['name']: c for c in json.load(open(os.path.join(H, 'out/score_cues.json')))}
bad = 0
print('== 1. 画面事件：拍网格 / 帧对齐 ==')
worst = 0
for e in E['ev']:
    if not e.get('cue'): continue
    grid = abs(e['t'] - e['beat'] * B) * 1000; frame = abs(e['t'] * FPS - round(e['t'] * FPS)) / FPS * 1000
    onbeat = abs(e['beat'] - round(e['beat'])) < 1e-9
    worst = max(worst, grid, frame)
    if grid > .5 or frame > .5 or not onbeat: bad += 1; print(f"  BAD {e['type']:<14} b{e['beat']}  grid {grid:.2f} ms  frame {frame:.2f} ms")
print(f"  {sum(1 for e in E['ev'] if e.get('cue'))} 个画面拍点，最大偏差 {worst:.3f} ms（拍 = {B*1000:.3f} ms = {B*FPS:g} 帧）")
print('== 2. 画面事件 ↔ 配乐拍点 ==')
pairs = [('door_open', 7, 'stinger1'), ('door_open', 10, 'stinger2'), ('slam', 9, 'slam1'), ('slam', 12, 'slam2'), ('door_open_big', 14, 'reveal'), ('react', 16, 'react_hit'),
         ('swirl', 23, 'wipe_hit'), ('tumble', 24, 'inside'), ('freeze', 25, 'freeze'), ('spit', 26, 'spit'), ('land', 27, 'land'), ('total', 32, 'fill'), ('laugh', 32, 'laugh'),
         ('pop', 34, 'rimshot'), ('blink', 35, 'button')]
for ty, b, cn in pairs:
    ev = next((e for e in E['ev'] if e['type'] == ty and abs(e['beat'] - b) < 1e-9), None); c = cues.get(cn)
    if not ev or not c: bad += 1; print(f'  BAD 缺少 {ty}@b{b} 或 {cn}'); continue
    d = (c['t'] - ev['t']) * 1000
    if abs(d) > .5: bad += 1
    print(f"  {'OK ' if abs(d) <= .5 else 'BAD'} b{b:<3} {ty:<14} ↔ {cn:<10} {d:+.2f} ms")
print('== 3. 真实音频起音 ==')
src = sys.argv[1] if len(sys.argv) > 1 else None
if src:
    wav = os.path.join(H, 'out', '_final.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '48000', wav], check=True)
    x, SR = sf.read(wav); os.remove(wav)
else:
    x, SR = sf.read(os.path.join(H, 'out/mix.wav')); x = x.mean(1)
FO, _ = sf.read(os.path.join(H, 'out/stems/foley.wav')); FO = FO.mean(1)
def onset(t, pre=.08, post=.12, rise=12, sig=None):
    sig = x if sig is None else sig
    a, b = int((t - pre) * SR), int((t + post) * SR); seg = sig[a:b]; hop = int(.001 * SR)
    e = np.array([np.sqrt(np.mean(seg[i:i + hop] ** 2)) + 1e-9 for i in range(0, len(seg) - hop, hop)])
    base = np.median(e[:int(pre * 1000 * .6)])
    k = np.argmax(20 * np.log10(e / base) > rise)
    return (a + k * hop) / SR
# 静默后的声音在成片混音里测；乐队正在响的段落在拟音分轨里测（混音里没有“起音前的安静”可比）
for name, b, src_ in [('静默后第一声：柜子吸气', HIT['inhale'], 'mix'), ('静默后第一声：哔 #1（全片最重要）', HIT['beep1'], 'mix'), ('哔 #2', HIT['beep2'], 'mix'),
                      ('砸门 #1', HIT['slam1'], 'foley'), ('砸门 #2', HIT['slam2'], 'foley'), ('落上传送带', HIT['land'], 'foley'), ('冻结「咔」', HIT['freeze'], 'foley'), ('泡泡糖爆', HIT['pop'], 'foley'), ('眨眼 blip', HIT['blink'], 'foley')]:
    t = b * B; o = onset(t, sig=None if src_ == 'mix' else FO); d = (o - t) * 1000; name = f'{name}[{src_}]'
    ok = abs(d) <= 1000 / FPS / 2
    if not ok: bad += 1
    print(f"  {'OK ' if ok else 'BAD'} b{b:<3} {name:<18} 画面 {t:.4f}s  起音 {o:.4f}s  偏差 {d:+.1f} ms（容差 ±{1000/FPS/2:.1f} ms = 半帧）")
print('== 4. 硬切静默 ==')
mu, SR2 = sf.read(os.path.join(H, 'out/stems/music.wav')); mu = mu.mean(1)
for b0, b1 in ((HIT['cut1'], HIT['inhale']), (HIT['cut2'], HIT['beep1'])):
    a, z = int(b0 * B * SR2), int(b1 * B * SR2); pkv = np.abs(mu[a:z]).max()
    ok = pkv < 1e-6
    if not ok: bad += 1
    mx = x[int(b0 * B * SR) + int(.02 * SR):int(b1 * B * SR) - int(.01 * SR)]
    print(f"  {'OK ' if ok else 'BAD'} b{b0}–b{b1} 配乐峰值 {pkv:.1e}；整轨 RMS {20*np.log10(np.sqrt(np.mean(mx**2))+1e-9):.1f} dBFS（只剩环境声）")
print('结果:', '全部通过' if not bad else f'{bad} 项不通过'); sys.exit(1 if bad else 0)
