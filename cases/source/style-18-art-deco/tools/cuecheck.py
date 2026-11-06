"""拍点核对：画面事件（events.json，由页面 window.EV 导出）↔ 配乐落点（music/score.json）↔ 帧网格。
python tools/cuecheck.py；任何一项 > 0.5 ms 即退出码 1。"""
import json, os, sys
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EV = json.load(open(os.path.join(D, 'events.json')))['ev']; K = json.load(open(os.path.join(D, 'music/score.json')))['keys']
TL = json.load(open(os.path.join(D, 'timeline.json'))); FPS = TL['FPS']
pic = {}
for e in EV:
    ty = e['type']
    if ty in ('ignite', 'unfold', 'ding', 'doorsOpen', 'doorstop', 'cutoff', 'lock', 'sheen', 'final', 'cut'):
        name = {'doorstop': 'doorsStop', 'cut': 'cutDial'}.get(ty, ty); pic[name] = (e['t'], ty)
    elif ty == 'doors': pic['doorsOpen'] = (e['t'], '双门对开')
    elif ty == 'stamp': pic[f"step{e['i'] + 1}"] = (e['t'], f"第 {e['i'] + 1} 级退台落定")
    elif ty == 'ray': pic[f"ray{e['i']}"] = (e['t'], f"楼冠光芒 {e['i']}")
    elif ty == 'floor': pic[f"floor{e['i']}"] = (e['t'], f"指针到 {e['lab']}")
    elif ty == 'latch': pic[f"latch{e['i'] + 1}"] = (e['t'], f"门闩 {e['i'] + 1}")
    elif ty == 'burst': pic[f"burst{e['i'] + 1}"] = (e['t'], f"第 {e['i'] + 1} 朵烟花")
    elif ty == 'spark': pic[f"spark{e['i']}"] = (e['t'], f"万花筒棘轮 {e['i'] + 1}")
mx = 0; fr = 0; miss = []
print(f"{'cue':10s} {'配乐 s':>9s} {'画面 s':>9s} {'Δ ms':>7s} {'帧号':>7s}  事件")
for k, (t, name) in sorted(pic.items(), key=lambda kv: kv[1][0]):
    if k not in K: miss.append(k); continue
    d = (t - K[k]) * 1000; f = t * FPS; fe = abs(f - round(f)) / FPS * 1000
    mx = max(mx, abs(d)); fr = max(fr, fe)
    print(f"{k:10s} {K[k]:9.3f} {t:9.3f} {d:+7.2f} {f:7.2f}  {name}")
print(f'共 {len(pic) - len(miss)} 个拍点 · 画面↔配乐最大偏差 {mx:.2f} ms · 落点离帧网格最大 {fr:.2f} ms' + (f' · 缺配乐落点: {miss}' if miss else ''))
sys.exit(1 if mx > .5 or fr > .5 or miss else 0)
