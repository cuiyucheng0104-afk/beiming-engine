"""《懂你的人》书桌版全片：站点布局 + 时间线 + 机位，输出 film/desk/timeline.json
桌面坐标（米）：x 左→右，y 前→后，桌面 z=0。四排站点蛇形走位：后排左→右，第二排右→左……"""
import os, json

P = os.path.expanduser('~/Desktop/懂你的人/')
OUT = P + 'film/desk/'
os.makedirs(OUT, exist_ok=True)
DN = json.load(open(P + '旁白/wav11/dur.json'))          # 旁白（1.1 倍速）
DQ = json.load(open(P + '旁白/wav/dur.json'))            # 球球（原速）
DUR = {k: (DQ[k] if k.startswith('q') else DN[k]) for k in list(DN) + [k for k in DQ if k.startswith('q')]}
LINES = {x['id']: x['zh'] for f in ('narr.json', 'qiu.json') for x in json.load(open(P + '旁白/' + f))}

R1, R2, R3, R4 = .38, .12, -.14, -.42
# id, 页, 类型, 物件位置(x,y), 旋转rz, 句子, 额外
ST = [
    ('S01', 1, 'title', (-.62, R1), .06, ['n01'], {}),
    ('S02', 2, 'photo', (-.40, R1), -.05, ['n02'], {}),
    ('S03', 3, 'photo', (-.18, R1), .07, ['n03'], {}),
    ('S04', 4, 'photo', (.04, R1), -.04, ['n04'], {}),
    ('S05', 5, 'lens', (.27, R1), 0, ['n05', 'q05'], {'hold': .6}),
    ('S06', 6, 'photo', (.52, R1), -.06, ['n06'], {}),
    ('S07', 7, 'phone', (.55, R2), .22, ['n07'], {}),
    ('S08', 8, 'photo', (.32, R2), .05, ['n08'], {'hud': 'S08', 'dx': -.04, 'dy': -.01}),
    ('S09', 9, 'strip', (.10, R2), -.03, ['n09', 'q09'], {}),
    ('S10', 10, 'photo', (-.12, R2), .06, ['n10', 'q10'], {}),
    ('S11', 11, 'photo', (-.34, R2), -.05, ['n11'], {}),
    ('S12', 12, 'photo', (-.56, R2), .04, ['n12'], {}),
    ('S13', 13, 'photo', (-.58, R3), -.06, ['n13'], {'hud': 'S13'}),
    ('S14', 14, 'photo', (-.36, R3), .05, ['n14'], {'hud': 'S14', 'hold': .8, 'dx': -.04, 'dy': .012}),
    ('S15', 15, 'photo', (-.14, R3), -.04, ['n15'], {}),
    ('S16', 16, 'notebook', (.13, R3), -.05, ['c16', 'n16'], {'hold': .6}),
    ('S17', 17, 'photo', (.40, R3), .05, ['n17', 'q17'], {}),
    ('S18', 18, 'photo', (.60, R3), -.05, ['n18'], {}),
    ('S19', 19, 'photo', (.56, R4), .06, ['n19', 'q19'], {'hold': .6}),
    ('S20', 20, 'photo', (.33, R4), -.04, ['n20'], {}),
    ('S21', 21, 'photo', (.10, R4), .05, ['n21'], {}),
    ('S22', 22, 'gift', (-.14, R4), 0, ['n22', 'q22'], {}),
    ('S23', 23, 'tablet', (-.38, R4), .15, [], {'fixed': 4.6}),
    ('S24', 25, 'photo', (-.60, R4), -.05, ['n24', 'q24'], {}),
    ('S25', 0, 'brand', (0, 0), 0, ['n25'], {'tail': 2.8}),
]
TRAVEL = 1.1            # 每站开头的滑行
FIRST = .55             # 旁白在滑行开始后多久进
GAP = .3


def poses(kind, x, y, k):
    """返回 (到达机位, 结束机位)，每个 = (相机位置, 看向点, 焦距)"""
    side = -.035 if k % 2 else .035
    if kind in ('photo', 'strip', 'title'):
        a = ((x + side, y - .12, .205), (x, y + .01, 0), 50)
        b = ((x + side * .4, y - .10, .178), (x, y + .01, 0), 52)
    elif kind == 'lens':                       # 眼镜立在 (x, y-.15)，照片斜靠在 (x, y)
        gx, gy = x, y - .15
        a = ((gx - .05, gy - .34, .10), (gx - .01, gy + .05, .03), 55)
        b = ((gx - .023, gy - .155, .037), (gx - .012, gy + .15, .042), 74)
    elif kind == 'phone':
        a = ((x - .08, y - .2, .17), (x, y + .01, 0), 50)
        b = ((x - .05, y - .17, .14), (x, y + .01, 0), 52)
    elif kind == 'tablet':
        a = ((x - .06, y - .25, .25), (x, y + .01, 0), 45)
        b = ((x - .04, y - .22, .22), (x, y + .01, 0), 46)
    elif kind == 'notebook':
        a = ((x - .02, y - .27, .30), (x, y - .005, 0), 46)
        b = ((x + .01, y - .22, .25), (x + .04, y - .005, 0), 48)
    elif kind == 'gift':
        a = ((x + .07, y - .27, .27), (x, y, .03), 48)
        b = ((x + .04, y - .22, .22), (x, y, .04), 50)
    elif kind == 'brand':
        a = ((0, -.92, .78), (0, .0, 0), 30)
        b = ((0, -1.0, .86), (0, .02, 0), 30)
    return a, b


t = 0.0
out = []
for k, (sid, page, kind, (x, y), rz, lines, ex) in enumerate(ST):
    t0 = t
    lead = 1.6 if kind == 'title' else FIRST
    cur, ls = t0 + lead, []
    for i, l in enumerate(lines):
        ls.append(dict(id=l, t=round(cur, 3), dur=DUR[l], zh=LINES[l]))
        cur += DUR[l] + (GAP + ex.get('hold', 0) if i < len(lines) - 1 else 0)
    t1 = t0 + ex['fixed'] if 'fixed' in ex else max(cur + .35 + ex.get('tail', 0), t0 + 3.0)
    a, b = poses(kind, x, y, k)
    if kind == 'title':
        a = ((-.05, -1.02, .72), (-.1, .05, 0), 30)
    if 'dx' in ex:
        sh = lambda p: (p[0] + ex['dx'], p[1] + ex.get('dy', 0), p[2])
        a = (sh(a[0]), sh(a[1]), a[2])
        b = (sh(b[0]), sh(b[1]), b[2])
    out.append(dict(sid=sid, page=page, kind=kind, x=x, y=y, rz=rz, lines=ls, t0=round(t0, 3), t1=round(t1, 3),
                    arrive=a, end=b, **{k2: v for k2, v in ex.items() if k2 in ('hud',)}))
    t = t1
TOTAL = round(t + .2, 3)
json.dump(dict(total=TOTAL, fps=24, travel=TRAVEL, stations=out), open(OUT + 'timeline.json', 'w'), ensure_ascii=False, indent=1)
print('total', TOTAL, 's', int(TOTAL * 24), 'frames')
for s in out:
    print(s['sid'], s['kind'], s['t0'], s['t1'], [l['id'] for l in s['lines']])
