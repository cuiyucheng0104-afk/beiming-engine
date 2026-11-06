"""拍点核对：画面事件（events.json，来自 index.html 的 window.EV）↔ 配乐/拟音实际落点（out/score.json）↔ 节拍网格 ↔ 帧网格。
另外在成片混音里用包络起音检测核对关键声音的实测起点。
用法：python tools/cuecheck.py [mix.wav]"""
import json, os, sys, numpy as np
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(D, 'timeline.json'))); B = TL['beat']; K = TL['K']
EV = json.load(open(os.path.join(D, 'events.json')))['ev']; SC = json.load(open(os.path.join(D, 'out', 'score.json')))
keys = SC['keys']; FPS = 24; G32 = B / 8
def ev(ty, **f):
    return [e['t'] for e in EV if e['type'] == ty and all(e.get(k) == v for k, v in f.items())]
pairs = [('pulse0', ev('pulse0'), '开场低频脉冲'), ('trace', ev('trace'), '光头出发'), ('close', ev('close'), '圆闭合'),
         ('reveal', ev('reveal'), '光带开始'), ('lit', ev('lit'), 'Lumen 全亮'), ('dot', ev('dot'), '点阵点亮（每个音符）'),
         ('gridtick', ev('gridtick'), '网格展开嘀嗒'), ('whip', ev('whip'), '一拍甩出'),
         ('snap_desk', ev('snap', view='desk'), '桌面落格'), ('snap_phone', ev('snap', view='phone'), '手机落格'), ('snap_watch', ev('snap', view='watch'), '手表落格'),
         ('crt', ev('crt'), '三窗 CRT 压扁'), ('burst', ev('burst'), '字形噪声炸开'),
         ('lock_W', ev('lock', ch='W'), 'W 锁定'), ('lock_0', ev('lock', ch='0'), '0 锁定'), ('lock_.', ev('lock', ch='.'), '. 锁定'),
         ('hit', ev('hit'), '"3" 落定（最重一拍）'), ('put', ev('put'), '数字收起 ×4'), ('name', ev('name'), '小灯展开/字标'),
         ('label', ev('label'), '"流明" 落定'), ('close2', ev('close2'), '片尾光圈闭合')]
mx = 0; nchk = 0
print(f"{'事件':12s} {'画面 s':>9s} {'声音 s':>9s} {'偏差 ms':>8s} {'帧号':>6s} {'拍位':>7s}  说明")
for k, vt, name in pairs:
    st = keys.get(k, [])
    if len(vt) != len(st): print(f'!! {k}: 画面 {len(vt)} 个 / 声音 {len(st)} 个'); mx = 1e9; continue
    for a, b in zip(vt, st):
        d = (a - b) * 1000; mx = max(mx, abs(d)); nchk += 1
        fr = a * FPS; beat = a / B
        offf = abs(fr - round(fr)) > 1e-3; offg = abs(a / G32 - round(a / G32)) > 1e-3
        if offf or offg: mx = max(mx, 1e9 if offf else mx)
        if k in ('dot', 'put', 'gridtick') and a != vt[0]: continue
        print(f"{k:12s} {a:9.4f} {b:9.4f} {d:+8.2f} {fr:6.1f} {beat:7.3f}  {name}{'  [不在帧网格]' if offf else ''}{'  [不在 32 分网格]' if offg else ''}")
print(f'核对 {nchk} 个视觉事件，画面↔声音最大偏差 {mx:.2f} ms（声音按采样落点计，1 采样 = 0.021 ms）')
# 静默段
fz, ht = K['freeze'], K['hit']
if len(sys.argv) > 1:
    import soundfile as sf
    x, sr = sf.read(sys.argv[1]); m = np.abs(x).max(1)
    sil = m[int(fz * sr) + int(.02 * sr):int(ht * sr) - int(.02 * sr)].max()
    print(f'静默段 {fz:.3f}–{ht:.3f} s 成片最大采样值 {sil:.2e}（{20*np.log10(sil+1e-12):.0f} dBFS）')
    # 静默后第一声：起音检测（1 ms 帧包络超过 -40 dBFS 的第一个点）
    env = np.array([m[i:i + sr // 1000].max() for i in range(int((ht - .02) * sr), int((ht + .05) * sr), sr // 1000)])
    on = np.argmax(env > 10 ** (-40 / 20)); t_on = ht - .02 + on / 1000
    print(f'静默后第一声实测起点 {t_on:.3f} s，与 "3" 落定画面 {ht:.3f} s 偏差 {(t_on - ht) * 1000:+.0f} ms（1 ms 分辨率）')
    win = lambda t: 10 * np.log10((x[int(t * sr):int((t + .4) * sr)].mean(1) ** 2).mean() + 1e-20)
    loud = sorted(((win(K[k]), k) for k in ('lit', 'snap', 'burst', 'lockW', 'hit', 'name')), reverse=True)
    print('400 ms 能量排序：' + ' > '.join(f'{k}({v:.1f}dB)' for v, k in loud))
