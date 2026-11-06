"""门禁判定：读 gate.sh 渲出来的静帧和日志，逐项给 PASS / FAIL，写 GATE.md 和 gate.json。
用法（由 gate.sh 调用）：gate_metrics.py <gate 目录> <版本> "<时刻列表>"
"""
import sys, os, re, json
import numpy as np
from PIL import Image

G, V, TIMES = sys.argv[1], sys.argv[2], sys.argv[3].split()


def rc(name):
    try: return int(open(os.path.join(G, name + '.rc')).read().strip() or 1)
    except Exception: return 1


def logtxt(sub):
    p = os.path.join(G, sub, 'render.log')
    return open(p, encoding='utf-8', errors='replace').read() if os.path.exists(p) else ''


def img(sub, t, size=None):
    p = os.path.join(G, sub, f's_{t}.jpg')
    if not os.path.exists(p): return None
    im = Image.open(p).convert('RGB')
    if size: im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


R = []  # (编号, 名称, 通过, 说明)
L = logtxt('main')
g0 = open(os.path.join(G, 'g0.txt'), encoding='utf-8').read().strip() if os.path.exists(os.path.join(G, 'g0.txt')) else ''
R.append(('G0', '静态检查（禁用 Math.random / Date.now / performance.now / new Date）', not g0, g0[:600] or '无命中'))

gpu = (re.search(r'GPU：(.*)', L) or [None, ''])[1].strip()
page_err = re.findall(r'\[页面错误\].*', L)
cons_err = [x for x in re.findall(r'\[页面\].*', L)]
ext = re.findall(r'\[外部请求\].*', L)
missing = [t for t in TIMES if img('main', t) is None]
ok1 = rc('main') == 0 and 'NVIDIA' in gpu and not page_err and not cons_err and not ext and not missing
R.append(('G1', '加载（5090 Chrome + NVIDIA GPU、READY、无页面报错、无控制台报错、无外部请求、静帧齐全）', ok1,
          f'退出码 {rc("main")}；GPU：{gpu or "未取到"}；页面错误 {len(page_err)}；控制台报错 {len(cons_err)}；外部请求 {len(ext)}；缺帧 {missing}'
          + (('；示例：' + ' | '.join((page_err + cons_err + ext)[:3])) if (page_err or cons_err or ext) else '')))

blank = []
for t in TIMES:
    a = img('main', t)
    if a is None: continue
    sd = float(a.mean(2).std())
    if sd < 4.0 and float(t) < 29.8: blank.append(f'{t}s(σ={sd:.1f})')
R.append(('G2', '覆盖（关键时刻静帧不是空白/纯色；29.8s 之后的淡出除外）', not blank and not missing, '空白：' + (', '.join(blank) if blank else '无')))

det = []
for t in ['5.5', '16.5', '25.0']:
    a, b = img('main', t), img('det', t)
    if a is None or b is None: det.append(f'{t}s 缺图'); continue
    mad = float(np.abs(a - b).mean())
    if mad >= 0.5: det.append(f'{t}s 平均差 {mad:.2f}')
R.append(('G3', '确定性（另起一个浏览器重渲同一时刻，逐像素平均差 < 0.5）', rc('det') == 0 and not det, '不一致：' + (', '.join(det) if det else '无')))

ms = [int(x) for x in re.findall(r's_[0-9.]+\.jpg (\d+)ms', L)]
med = float(np.median(ms)) if ms else 1e9
R.append(('G4', '性能（5090 上每帧渲染+截图的中位数 < 1500 ms）', med < 1500, f'中位数 {med:.0f} ms，最慢 {max(ms) if ms else "?"} ms，共 {len(ms)} 帧'))

k4 = []
for t in ['4.6', '16.5', '27.6']:
    a = img('main', t, (480, 260)); b = img('4k', t, (480, 260))
    if a is None or b is None: k4.append(f'{t}s 缺图'); continue
    mad = float(np.abs(a - b).mean())
    if mad >= 10: k4.append(f'{t}s 平均差 {mad:.1f}')
R.append(('G5', '4K 一致（3840×2080 缩到 480×260 后与 1080 版平均差 < 10，说明构图按 H/1040 缩放）', rc('4k') == 0 and not k4, '不一致：' + (', '.join(k4) if k4 else '无')))

dur = (re.search(r'DUR=([0-9.]+)', L) or [None, '?'])[1]
R.append(('G6', '时长（window.DUR = 30）', dur in ('30', '30.0'), f'DUR={dur}'))

allok = all(r[2] for r in R)
md = [f'# 门禁 · {V}', '', f'结论：**{"全部通过" if allok else "未通过"}**', '', '| 项 | 内容 | 结果 | 说明 |', '|---|---|---|---|']
md += [f'| {a} | {b} | {"PASS" if c else "FAIL"} | {d.replace("|", "/")} |' for a, b, c, d in R]
md += ['', '关键时刻静帧：main/sheet.jpg（5090 渲染）']
open(os.path.join(G, 'GATE.md'), 'w').write('\n'.join(md) + '\n')
json.dump({'version': V, 'pass': allok, 'items': [{'id': a, 'name': b, 'pass': c, 'detail': d} for a, b, c, d in R]},
          open(os.path.join(G, 'gate.json'), 'w'), ensure_ascii=False, indent=1)
print('\n'.join(md))
sys.exit(0 if allok else 1)
