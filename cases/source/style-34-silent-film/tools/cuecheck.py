"""拍点核对：每个命名拍点 →
  1) 落在整帧上（t×24 为整数）；
  2) 配乐在该时刻有起音（score_onsets.json）；
  3) 画面事件表（events.json，页面导出）里有同名事件且时间一致；
  4) 有拟音的拍点，拟音起点一致（sfx_log.json）；
  5) 成片里实测的切点（ffmpeg scdet）与 CUTS 一致。
用法：.venv/bin/python tools/cuecheck.py [成片.mp4]"""
import sys, os, json, subprocess, re
HERE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = json.load(open(os.path.join(HERE, 'events.json')))['ev']
SC = json.load(open(os.path.join(HERE, 'out', 'score_onsets.json')))
FX = json.load(open(os.path.join(HERE, 'out', 'sfx_log.json')))
fps = TL['fps']; worst = 0.0; bad = 0
vis = {e['name']: e['t'] for e in EV if e['type'] == 'hit'}
fxt = {}
for t, n in FX: fxt.setdefault(n, t)
print(f"{'拍点':<10}{'段/拍':<14}{'时间s':>9}{'帧':>7}{'画面Δms':>9}{'配乐Δms':>9}{'拟音Δms':>9}")
for name, t in TL['hit'].items():
    sec, b = TL['hits'][name]
    fr = t * fps; dfr = abs(fr - round(fr)) / fps * 1000
    dv = abs(vis[name] - t) * 1000 if name in vis else None
    ds = abs(SC['onsets'][name] - t) * 1000 if name in SC['onsets'] else None
    df = abs(fxt[name] - t) * 1000 if name in fxt else None
    for d in (dfr, dv, ds, df):
        if d is not None: worst = max(worst, d)
    if dv is None or ds is None or dfr > .5: bad += 1
    f = lambda d: '—' if d is None else f'{d:.1f}'
    print(f"{name:<10}{sec + ' ' + str(b):<14}{t:>9.3f}{round(fr):>7}{f(dv):>9}{f(ds):>9}{f(df):>9}")
print(f'\n命名拍点 {len(TL["hit"])} 个；整帧/画面/配乐/拟音 最大偏差 {worst:.2f} ms；缺项 {bad}')

if len(sys.argv) > 1:
    film = sys.argv[1]
    # 每帧的场景变化分数（scdet），在每个设计切点 ±4 帧内找分数最高的那一帧 = 实测切点
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', film, '-vf', 'scdet=threshold=0,metadata=print', '-an', '-f', 'null', '-'], capture_output=True, text=True)
    sc = {}; cur = None
    for line in r.stderr.splitlines():
        m = re.search(r'pts_time:([\d.]+)', line)
        if m: cur = float(m.group(1)); continue
        m = re.search(r'lavfi\.scd\.score=([\d.]+)', line)
        if m and cur is not None: sc[round(cur * fps)] = float(m.group(1))
    base = sorted(sc.values())[len(sc) // 2] if sc else 0
    print(f'\n成片实测切点（scdet 每帧分数，全片中位数 {base:.2f}）')
    for name in TL['cuts']:
        t = TL['hit'][name]; f0 = round(t * fps)
        win = {f: sc.get(f, 0) for f in range(f0 - 4, f0 + 5)}
        fbest = max(win, key=win.get); d = abs(fbest - f0) / fps * 1000
        print(f"  {name:<10} 设计帧 {f0}  实测峰值帧 {fbest}（分数 {win[fbest]:.1f}，邻帧最高 {max(v for f, v in win.items() if f != fbest):.1f}）  偏差 {d:.1f} ms")
        if d > 0: bad += 1
sys.exit(1 if bad else 0)
