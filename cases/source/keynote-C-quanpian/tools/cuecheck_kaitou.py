"""开头 0–20 s 的对拍检查（原 C-kaitou/tools/cuecheck.py，只改了输入路径）：画面事件 ↔ 音频起音（目标 0 ms，容差 ±33 ms）。
全片的检查用 tools/cuecheck.py；这一份只管开头，保证开头的卡点没被全片改动带偏。
画面时刻：out/probe.json（tools/probe.mjs 用真实的 render 代码逐帧采样各元素状态）→ 每个事件"到位/起动"的第一帧。
另用成片做独立核对：台灯开（亮度跃升）、数字与标题落定（运动停下）、打字（标签区域变化）。
音频时刻：out/cues.json（mix.py 在每条卡点声音自己的分轨上测的起音，峰值 −30 dB 处）。
用法：python tools/cuecheck_kaitou.py C-quanpian.mp4   （先 node tools/probe.mjs 生成 out/probe.json）"""
import sys, os, json, subprocess
import numpy as np
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS = 30
ev = [e for e in json.load(open(os.path.join(HERE, 'events.json')))['ev'] if e.get('chap') == 'ch1']
cues = json.load(open(os.path.join(HERE, 'out', 'cues_kaitou.json')))
P = json.load(open(os.path.join(HERE, 'out', 'probe.json')))

def first(pred, f0=0):
    for f in range(f0, len(P)):
        if pred(P[f]): return f
    return None
def audio(name, t):
    c = [x for x in cues if x['name'] == name and abs(x['plan'] - t) < .02]
    return c[0]['onset'] if c else None

# 事件类型 → (画面判据, 对应声音名)
def vis_frame(e):
    t, typ, i = e['t'], e['type'], e.get('i', 0)
    f0 = max(0, int(round(t * FPS)) - 12)
    if typ == 'num': return first(lambda s: s['nums'][i] >= .9999, f0)
    if typ == 'reflow': return first(lambda s: s['reflow'] >= .9999, f0)
    if typ == 'reflow25': return first(lambda s: s['reflow25'] >= .9999, f0)
    if typ == 'title': return first(lambda s: s['title'][i] >= .9999, f0)
    if typ == 'lamp': return first(lambda s: s['lamp'] > 0, f0)
    if typ == 'cover_lift': return first(lambda s: s['cover'] > 0, f0)
    if typ == 'open': return first(lambda s: s['cover'] >= 89.999, f0)
    if typ == 'fold': return first(lambda s: s[['mtn', 'wings', 'band'][i]] >= .9999, f0)
    if typ == 'card': return first(lambda s: s['cards'][i] >= .9999, f0)
    if typ == 'label': return first(lambda s: s['label'] >= .9999, f0)
    if typ == 'type': return first(lambda s: s['typed'] >= i + 1, f0)
    if typ == 'pull': return first(lambda s: s['tab'] > 0, f0)
    if typ == 'cloud': return first(lambda s: s['clouds'][i] >= .9999, f0)
    if typ == 'part': return first(lambda s: s['part'] >= .9999, f0)
    return None
SND = {'num': 'num', 'reflow': 'reflow', 'reflow25': 'reflow25', 'title': 'title', 'lamp': 'lamp', 'cover_lift': 'cover_lift', 'open': 'open',
       'fold': 'fold', 'card': 'card', 'label': 'label', 'type': 'type', 'pull': 'pull', 'cloud': 'cloud', 'tick': 'tick', 'rule': 'rule', 'part': 'part'}
# 剧照卡片上升：第 i 个齿在 tick[i] 到位（y 走完第 i+1 个台阶）
ticks = [e for e in ev if e['type'] == 'tick']
ys = np.array([s['still'] for s in P]); y_base = ys[int(round(ticks[0]['t'] * FPS)) - 12]
STEP = .02   # 与 stage.js 的 RISE_STEP 一致

rows = []
for e in ev:
    typ = e['type']
    if typ in ('silence', 'roll', 'hum_in', 'slide', 'rule'): continue
    if typ == 'tick':
        k = e['i']; target = y_base + STEP * (k + 1) - 1e-6
        f = next((j for j in range(len(P)) if ys[j] >= target), None)
    else:
        f = vis_frame(e)
    a = audio(SND[typ], e['t'])
    tv = None if f is None else f / FPS
    rows.append({'event': typ, 'i': e.get('i'), 'plan_t': e['t'], 'visual_t': None if tv is None else round(tv, 4), 'audio_onset': a,
                 'av_ms': None if (tv is None or a is None) else round((a - tv) * 1000, 2)})

# —— 成片独立核对 ——
vid = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'C-quanpian.mp4')
W, H = 192, 108
raw = subprocess.run(['ffmpeg', '-v', 'error', '-t', '20.5', '-i', vid, '-vf', f'scale={W}:{H},format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
F = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)
md = np.r_[0, np.abs(np.diff(F, axis=0)).mean(axis=(1, 2))]
lum = F.mean(axis=(1, 2))
vrows = []
def vcheck(name, t, f_meas, a):
    vrows.append({'event': name, 'plan_t': t, 'video_t': round(f_meas / FPS, 4), 'audio_onset': a, 'av_ms': None if a is None else round((a - f_meas / FPS) * 1000, 2)})
# 台灯：亮度变化最大的帧
tl = [e['t'] for e in ev if e['type'] == 'lamp'][0]; f0 = int(round(tl * FPS))
f = f0 - 4 + int(np.argmax(np.abs(np.diff(lum[f0 - 4:f0 + 4])))) + 1; vcheck('lamp(亮度跃升)', tl, f, audio('lamp', tl))
# 数字、标题：落定 = 该帧之后画面不再变化（拍前在动，拍后静止）
for e in [x for x in ev if x['type'] in ('num', 'title')]:
    f0 = int(round(e['t'] * FPS)); win = range(f0 - 4, f0 + 4)
    f = next((j for j in win if md[j] > .02 and md[j + 1] <= .02), None)
    if f is not None: vcheck(e['type'] + '(运动停下)', e['t'], f, audio(e['type'], e['t']))
# 打字：标签变化的帧（全帧差分的局部峰）
for e in [x for x in ev if x['type'] == 'type']:
    f0 = int(round(e['t'] * FPS)); b = P[f0]['lbox']   # 标签在画面上的框（像素，1920×1080）
    x0, x1 = int(b[0] / 10), int(np.ceil(b[2] / 10)); y0, y1 = int(b[1] / 10), int(np.ceil(b[3] / 10))
    roi = [np.abs(F[j, y0:y1, x0:x1] - F[j - 1, y0:y1, x0:x1]).mean() for j in range(f0 - 1, f0 + 2)]
    f = f0 - 1 + int(np.argmax(roi))
    vcheck('type(字出现)', e['t'], f, audio('type', e['t']))

ok = [r for r in rows if r['av_ms'] is not None]
bad = [r for r in ok if abs(r['av_ms']) > 33.4]
vbad = [r for r in vrows if r['av_ms'] is not None and abs(r['av_ms']) > 33.4]
for r in rows: print(r)
print('--- 成片独立核对 ---')
for r in vrows: print(r)
mx = max(abs(r['av_ms']) for r in ok)
print(f'CHECKED {len(ok)}  max |音画差| {mx:.2f} ms  OUT_OF_TOL {len(bad)}  | 成片核对 {len(vrows)} 项 OUT_OF_TOL {len(vbad)}  max {max(abs(r["av_ms"]) for r in vrows if r["av_ms"] is not None):.2f} ms')
json.dump({'probe': rows, 'video': vrows}, open(os.path.join(HERE, 'out', 'cuecheck_kaitou.json'), 'w'), ensure_ascii=False, indent=1)
sys.exit(1 if bad or vbad else 0)
