"""拍点核对：画面事件（events.json，来自 window.EV）↔ 音乐起音（out/score.json，来自 mix.py）↔ 节拍网格（timeline.json）。
用法：python tools/cuecheck.py   退出码 0 = 所有吸附事件都在整帧 + 十六分网格上，且关键事件都有同一时刻的音乐起音。"""
import json, os, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(HERE, 'timeline.json')))
EV = [e for e in json.load(open(os.path.join(HERE, 'events.json')))['ev'] if e['type'] != 'dotpath']
ON = json.load(open(os.path.join(HERE, 'out', 'score.json')))
FPS, E16 = TL['FPS'], TL['E16']
on_t = sorted(set(t for t, _ in ON))
KEY = {'thunk', 'block', 'knife', 'stop', 'felt', 'paper', 'stamp', 'slide', 'type', 'snick', 'tick'}   # 落定 / 剪切 / 关键动作
bad, rows, devs = 0, [], []
for e in EV:
    t = e['t']
    if not e.get('snap'):
        rows.append(f"  例外  {t:7.3f}  {e['type']:8s} 不吸附（红点接触，故意离拍）"); continue
    fr = abs(t * FPS - round(t * FPS)) * 1000 / FPS
    g16 = abs(t / E16 - round(t / E16)) * E16 * 1000
    near = min(on_t, key=lambda o: abs(o - t)); dev = abs(near - t) * 1000
    if fr > 0.01 or g16 > 0.01: bad += 1; rows.append(f"  ✗ 离网格 {t:7.3f} {e['type']} 帧偏 {fr:.2f}ms 16分偏 {g16:.2f}ms")
    if e['type'] in KEY or (e['type'] == 'clack' and e.get('big')):
        devs.append(dev)
        if dev > 1: bad += 1; rows.append(f"  ✗ 无同拍音乐 {t:7.3f} {e['type']}  最近起音 {near:.3f}（{dev:.1f} ms）")
snapped = [e for e in EV if e.get('snap')]
print(f"吸附事件 {len(snapped)} 个，全部在整帧与十六分网格上：{'是' if not any('离网格' in r for r in rows) else '否'}")
print(f"关键事件 {len(devs)} 个，与最近音乐起音的最大偏差 {max(devs):.3f} ms，平均 {sum(devs) / len(devs):.3f} ms")
print(f"音乐起音 {len(ON)} 个（{len(on_t)} 个不同时刻）")
for r in rows: print(r)
# 第 7 小节必须是真静默；14.0 必须有起音（静默后的第一声）
assert not any(12.15 < t < TL['T']['dotIn'] - 1e-6 for t in on_t), '静默小节里有音乐起音'
assert any(abs(t - TL['T']['dotIn']) < 1e-6 for t in on_t), '14.0 没有起音'
first_after = min(t for t in on_t if t > 12.15); print(f"静默后第一声：{first_after:.3f} s")
sys.exit(1 if bad else 0)
