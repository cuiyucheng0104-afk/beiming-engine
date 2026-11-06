"""方案 C《打开》全片混音：开头原有混音 + music.wav + 全部 sfx 清单 → 侧链闪避 → −14 LUFS / 真峰值 ≤ −1 dBTP → out/mix.wav
  0–20 s ：kaitou_mix.py 的原混音（out/kaitou.wav，与 C-kaitou 逐采样相同），再按 mux.sh 当年的两遍 loudnorm 处理一遍
           （out/kaitou_master.wav）——成片 0–20 s 的 AAC 音轨因此与 C-kaitou.mp4 逐位相同。
  20–180 s：music.wav（作曲）× 侧链闪避 + 共用拟音（翻页、摊平、合书、台灯，按 events.json 自动生成）+ sfx/*.json（各章）+ 房间环境；
           整体增益与限幅只作用在这一段，增益解到"全片 −14 LUFS"。
输出：out/mix.wav（48 kHz 立体声 32 位浮点，已母带处理；build.sh 直接封装、不再 loudnorm）、out/cues.json（每条音效的计划时刻与实测起音，给 tools/cuecheck.py）、
      out/mix_report.json（响度、真峰值、各章音效条数、被拒的条目）
用法：$LIB/.venv/bin/python mix.py [--events events.json] [--out out/mix.wav] [--music out/music.wav] [--stems]"""
import os, sys, json, glob, hashlib, subprocess, zlib, re
import numpy as np, soundfile as sf
from scipy.ndimage import maximum_filter1d, uniform_filter1d
from scipy.signal import lfilter, resample_poly
HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.environ.get('LIB', '@@LEMO_ROOT@@')
PY = sys.executable
sys.path.insert(0, HERE)
import sfx_kit as K
SR = 48000; FPS = 30; BPM = 120; BEAT = 60 / BPM; BAR = 4 * BEAT; T0 = 20.0     # 开头 = 0–20 s
def bt(bar, beat=1, s16=0): return (bar - 1) * BAR + (beat - 1) * BEAT + s16 * BEAT / 4
def arg(k, d):
    a = sys.argv; return a[a.index(k) + 1] if k in a else d
EVP = arg('--events', os.path.join(HERE, 'events.json'))
OUT = arg('--out', os.path.join(HERE, 'out', 'mix.wav'))
MUS = arg('--music', os.path.join(HERE, 'out', 'music.wav'))
ODIR = os.path.dirname(os.path.abspath(OUT)); os.makedirs(ODIR, exist_ok=True)
OUTD = os.path.join(HERE, 'out'); os.makedirs(OUTD, exist_ok=True)
EVJ = json.load(open(EVP)); DUR = float(EVJ['dur']); EV = EVJ['ev']; N = int(round(DUR * SR)); I0 = int(T0 * SR)
assert abs(DUR - 180) < 1e-9, f'events.json 的 dur 应为 180（现在 {DUR}）：别用 --q seg=… 导出的事件表混全片'
EVID = {e['id']: e for e in EV if 'id' in e}
REPORT = {'rejected': [], 'per_chap': {}}
def warn(msg): print('mix.py: ' + msg, file=sys.stderr); REPORT['rejected'].append(msg)

def atomic_write(path, data, sub):
    tmp = path + f'.tmp{os.getpid()}.wav'; sf.write(tmp, data, SR, subtype=sub); os.replace(tmp, path)

# ———————————————— 1. 开头：原混音 + 当年的母带处理（有缓存）————————————————
def sha(b): return hashlib.sha1(b).hexdigest()
ch1 = [e for e in EV if e.get('chap') == 'ch1']
key = sha(open(os.path.join(HERE, 'kaitou_mix.py'), 'rb').read() + json.dumps(ch1, sort_keys=True).encode())
KW, KM, KK = (os.path.join(OUTD, n) for n in ('kaitou.wav', 'kaitou_master.wav', 'kaitou.key'))
if not (os.path.exists(KM) and os.path.exists(KK) and open(KK).read() == key):
    print('mix.py: 重做开头混音（kaitou_mix.py）…')
    subprocess.run([PY, os.path.join(HERE, 'kaitou_mix.py'), EVP], check=True, env={**os.environ, 'LIB': LIB, 'KAITOU_OUT': KW})
    # 与 $LIB/core/render/mux.sh 完全相同的两遍 loudnorm（C-kaitou.mp4 的音轨就是这样来的）
    m = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', KW, '-af', 'loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True).stderr
    J = json.loads(m[m.rindex('{'):m.rindex('}') + 1])
    LN = (f"loudnorm=I=-14:TP=-1.2:LRA=11:measured_I={J['input_i']}:measured_TP={J['input_tp']}:measured_LRA={J['input_lra']}"
          f":measured_thresh={J['input_thresh']}:offset={J['target_offset']}:linear=true,aresample=48000")
    tmp = KM + f'.tmp{os.getpid()}.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', KW, '-af', LN, '-c:a', 'pcm_f32le', tmp], check=True); os.replace(tmp, KM)
    open(KK, 'w').write(key)
kaitou, _ = sf.read(KM, dtype='float32')
kaitou = kaitou[:I0] if len(kaitou) >= I0 else np.pad(kaitou, ((0, I0 - len(kaitou)), (0, 0)))

# ———————————————— 2. 配乐层（作曲的 music.py）————————————————
mp = os.path.join(HERE, 'music.py')
if not os.path.exists(MUS) or os.path.getmtime(MUS) < os.path.getmtime(mp):
    print('mix.py: 重做配乐层（music.py）…'); subprocess.run([PY, mp, EVP, MUS], check=True, env={**os.environ, 'LIB': LIB})
music, msr = sf.read(MUS, dtype='float32', always_2d=True)
assert msr == SR, f'music.wav 必须是 {SR} Hz'
if music.shape[1] == 1: music = np.repeat(music, 2, 1)
music = music[:N] if len(music) >= N else np.pad(music, ((0, N - len(music)), (0, 0)))
pre = float(np.abs(music[:I0]).max()) if I0 else 0
if pre > 1e-4: warn(f'music.wav 在 20 s 之前有声音（峰值 {pre:.3f}），已清零：开头的配乐在原混音里')
music[:I0] = 0

# ———————————————— 3. 音效：共用（自动）+ 各章清单 ————————————————
sfx = np.zeros((N, 2), np.float32); CUES = []
RESERVED = {'t', 'bar', 'beat', 's16', 'ev', 'offset', 'type', 'gain', 'pan', 'duck', 'raw', 'name', 'note', 'width'}
DUCKS = []    # (时刻, 深度 dB)
def onset_index(x, db=-30):
    a = np.abs(x); return int(np.argmax(a > a.max() * 10 ** (db / 20)))
def place(chap, e, t, typ, idx):
    p = {k: v for k, v in e.items() if k not in RESERVED}
    if typ not in K.KIT: warn(f'[{chap}] 第 {idx} 条：没有音效类型 "{typ}"（python sfx_kit.py 列出全部类型）'); return
    if t < T0 - 1e-6: warn(f'[{chap}] 第 {idx} 条 {typ} @ {t:.3f}s 在 20 s 之前（开头锁定），已丢弃'); return
    if t >= DUR: warn(f'[{chap}] 第 {idx} 条 {typ} @ {t:.3f}s 超出片尾，已丢弃'); return
    snd = K.KIT[typ]
    try: x = K.render(typ, seed=zlib.crc32(f'{chap}:{typ}:{t:.4f}:{idx}'.encode()), **p)
    except TypeError as err: warn(f'[{chap}] 第 {idx} 条 {typ}：参数不对（{err}）；可用参数：{snd.params}'); return
    an = snd.anchor
    mark = onset_index(x) / SR if an == 'onset' else len(x) / SR if an == 'end' else float(an(p))
    g = snd.level * 10 ** (e.get('gain', 0) / 20); pan = float(e.get('pan', 0))
    start = int(round((t - mark) * SR)); s0, s1 = max(start, 0), min(start + len(x), N)
    if s1 <= s0: return
    l, r = np.cos((pan + 1) * np.pi / 4) * 1.414, np.sin((pan + 1) * np.pi / 4) * 1.414
    seg_ = x[s0 - start:s1 - start] * g; sfx[s0:s1, 0] += seg_ * l; sfx[s0:s1, 1] += seg_ * r
    CUES.append({'chap': chap, 'name': e.get('name', typ), 'type': typ, 'ev': e.get('ev'), 'plan': round(t, 5), 'onset': round(start / SR + mark, 5)})
    d = snd.duck + e.get('duck', 0)
    if d < 0: DUCKS.append((t, d))
    REPORT['per_chap'][chap] = REPORT['per_chap'].get(chap, 0) + 1
def tq(t, raw=False): return t if raw else round(t * FPS) / FPS

# 3a. 共用层自动配声：翻页 / 摊平 / 合书 / 台灯
auto = []
for e in EV:
    if e.get('chap') != 'book': continue
    t = e['t']; ty = e['type']
    if ty == 'page_turn':
        auto += [({'type': 'creak', 'dur': .2, 'gain': -6}, t - e['swing']), ({'type': 'swish', 'dur': e['swing'] + .08}, t), ({'type': 'page_land', 'name': 'page_turn'}, t)]
    elif ty == 'book_flat':
        auto += [({'type': 'swish', 'dur': e['swing'] + .1, 'gain': 2}, t), ({'type': 'board', 'v': .8, 'name': 'book_flat'}, t), ({'type': 'page_land', 'gain': -4}, t + .3)]
    elif ty == 'book_close':
        auto += [({'type': 'swish', 'dur': e['swing'], 'gain': 3}, t), ({'type': 'book_close', 'name': 'book_close'}, t)]
    elif ty == 'lamp_dim':
        auto += [({'type': 'lamp_switch', 'frm': e['from'], 'to': e['to'], 'name': 'lamp_dim'}, t)]
    elif ty == 'lamp_swivel':
        auto += [({'type': 'swivel', 'dur': e['dur'] + .1, 'name': 'lamp_swivel'}, t)]
for i, (e, t) in enumerate(auto): place('book', e, tq(t), e['type'], i)

# 3b. 各章清单 sfx/<章>.json
LISTS = sorted(glob.glob(os.path.join(HERE, 'sfx', '*.json')))
for f in LISTS:
    chap = os.path.splitext(os.path.basename(f))[0]
    try: J = json.load(open(f))
    except Exception as err: warn(f'{f} 不是合法 JSON：{err}'); continue
    for i, e in enumerate(J.get('events', [])):
        if 'type' not in e: warn(f'[{chap}] 第 {i} 条缺 type'); continue
        if 't' in e: t = float(e['t'])
        elif 'bar' in e: t = bt(e['bar'], e.get('beat', 1), e.get('s16', 0))
        elif 'ev' in e:
            if e['ev'] not in EVID: warn(f'[{chap}] 第 {i} 条引用的事件 "{e["ev"]}" 不在 events.json（先 node core/render/events.mjs 重新导出；id 写错？）'); continue
            t = EVID[e['ev']]['t'] + float(e.get('offset', 0))
        else: warn(f'[{chap}] 第 {i} 条没有时刻（t / bar / ev 三选一）'); continue
        place(chap, e, tq(t, e.get('raw', False)), e['type'], i)

# ———————————————— 4. 房间环境（接着开头：房间底噪 + 台灯嗡声随亮度 + 极轻的钟表）————————————————
amb = np.zeros((N, 2), np.float32); tt = np.arange(N) / SR
rng = np.random.default_rng(2026)
brown = np.cumsum(rng.standard_normal(N)); brown -= np.linspace(brown[0], brown[-1], N); brown = K.hp(brown, 20); brown /= np.abs(brown).max()
room = K.lp(brown, 300) * .05
lc = next((e for e in EV if e.get('type') == 'lamp_curve'), None)
dim = np.interp(tt, lc['t'] + np.arange(len(lc['v'])) * lc['step'], lc['v']) if lc else np.ones(N)
hum = (np.sin(2 * np.pi * 50 * tt) * .5 + np.sin(2 * np.pi * 100 * tt) * .35 + np.sin(2 * np.pi * 150 * tt) * .12) * .0075 * dim
bed = (room + hum).astype(np.float32); amb[:, 0] += bed; amb[:, 1] += bed
clock = K.lp(K.tick(np.random.default_rng(1), .5), 3000) * .5 * .03
for k in range(int(T0 / BEAT), int(DUR / BEAT)):
    s = int(k * BEAT * SR); amb[s:s + len(clock), 0] += clock[:N - s] * .45; amb[s:s + len(clock), 1] += clock[:N - s] * 1.55
amb[:I0] = 0; fi = int(.01 * SR); amb[I0:I0 + fi] *= np.linspace(0, 1, fi)[:, None]
# 全静拍（第 58 小节第 4 拍，events 里的 silence）：环境层只留一半的房间底噪，不走钟表（合成阶段加：让"全静"更静，最强一下更突出）
for e in EV:
    if e.get('type') == 'silence' and e['t'] >= T0:
        i0, i1 = int(e['t'] * SR), int(e['until'] * SR); r = int(.03 * SR)
        g = np.ones(N, np.float32); g[i0:i1] = .35; g[i0 - r:i0] = np.linspace(1, .35, r); g[i1 - r:i1] = np.linspace(.35, 1, r)
        amb[i0 - r:i1] = ((room + hum)[i0 - r:i1] * g[i0 - r:i1])[:, None]      # 床底噪 × g，这一拍里没有钟表

# ———————————————— 5. 侧链：音效压住配乐 ————————————————
# (a) 总线侧链：音效包络（2 ms 起、120 ms 释放）超过 −30 dBFS 的部分按 3:1 压配乐，最多 −8 dB
key = np.abs(sfx).max(1)
env = maximum_filter1d(key, int(.004 * SR)); a = np.exp(-1 / (.12 * SR))
env = lfilter([1 - a], [1, -a], env); env = np.maximum(env, maximum_filter1d(key, int(.002 * SR)))
lv = 20 * np.log10(np.maximum(env, 1e-6)); gr = -np.clip((lv + 30) * (1 - 1 / 3), 0, 8)
# (b) 事件侧链：每个带 duck 的音效在落点前 25 ms 让开、保持 60 ms、80 ms 回来
ev_gr = np.zeros(N)
for t, d in DUCKS:
    i0 = int((t - .025) * SR); shape = np.r_[np.linspace(0, 1, int(.004 * SR)), np.ones(int(.085 * SR)), np.linspace(1, 0, int(.08 * SR))] * d
    i1 = min(N, i0 + len(shape)); ev_gr[max(i0, 0):i1] = np.minimum(ev_gr[max(i0, 0):i1], shape[max(0, -i0):i1 - i0])
duck_db = uniform_filter1d(np.minimum(gr, ev_gr), int(.002 * SR))
music_d = music * (10 ** (duck_db / 20))[:, None].astype(np.float32)

# ———————————————— 6. 合成与母带 ————————————————
sys.path.insert(0, LIB)
from core.audio import sampler as S
sfx_r = S.room(sfx, size=.3, mix=.08).astype(np.float32)[:N] if np.abs(sfx).max() > 0 else sfx
tail = (music_d + sfx_r + amb)[I0:]
def measure(x):
    tmp = os.path.join(ODIR, f'.measure{os.getpid()}.wav'); sf.write(tmp, x, SR, subtype='FLOAT')
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', tmp, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr; os.remove(tmp)
    I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', r)[-1]); P = float(re.findall(r'Peak:\s+(-?[\d.inf]+) dBFS', r)[-1]); return I, P
def limited(x, ceil): return np.stack([lim(x[:, c], ceil) for c in (0, 1)], 1)
def lim(x, ceil, look=.005):
    """真峰值前瞻限幅：4 倍过采样估计样点间峰值，再按 ceil（线性）压"""
    n = int(look * SR); up = np.abs(resample_poly(x, 4, 1)); tp = np.maximum(np.abs(x), up[:4 * len(x)].reshape(-1, 4).max(1))
    m = maximum_filter1d(tp, 2 * n + 1); g = np.minimum(1, ceil / np.maximum(m, 1e-9)); g = uniform_filter1d(g, n)
    return x * np.minimum(g, 1)
ceil = 10 ** (-3.0 / 20)     # 留 2 dB 给 AAC 编码的峰值过冲（合成实测：-2.2 时 AAC 解码后在 120.5 / 132.0 s 冲到 -0.9 dBTP）；开头那一段由原母带处理决定，−1.2
def master(gdb):
    tl = tail * 10 ** (gdb / 20)
    for _ in range(2): tl = limited(tl, ceil)
    tl[-int(.02 * SR):] *= np.linspace(1, 0, int(.02 * SR))[:, None]          # 片尾 20 ms 收尾防爆音
    full = np.concatenate([kaitou, tl.astype(np.float32)]); return full, measure(full)[0]
# 尾段增益：割线法解"全片 −14 LUFS"（±0.2）；占位节拍器这类极稀疏的配乐可能到不了，最多抬 +30 dB 并在报告里写明
hist = []; gdb = 0.0
for it in range(8):
    full, I = master(gdb); hist.append((gdb, I)); print(f'mix.py: 母带第 {it + 1} 轮：尾段增益 {gdb:+.2f} dB → 全片 {I:.2f} LUFS')
    if abs(I + 14) <= .2: break
    if len(hist) >= 2 and abs(hist[-1][1] - hist[-2][1]) > 1e-3: slope = (hist[-1][1] - hist[-2][1]) / (hist[-1][0] - hist[-2][0])
    else: slope = .89
    gdb = float(np.clip(gdb + (-14 - I) / max(slope, .15), -20, 30))
    if any(abs(gdb - h[0]) < 1e-3 for h in hist): break
I, P = measure(full); tp_tail = measure(np.concatenate([np.zeros((SR, 2), np.float32), full[I0:]]))[1]
if abs(I + 14) > 1: warn(f'全片响度 {I:.2f} LUFS 达不到 −14±1（配乐层太稀疏？占位节拍器时正常）')
REPORT.update({'lufs': I, 'true_peak_full': P, 'true_peak_tail': tp_tail, 'tail_gain_db': gdb, 'ceiling': 20 * np.log10(ceil), 'cues': len(CUES)})
atomic_write(OUT, full, 'FLOAT')     # 32 位浮点：开头 0–20 s 的采样不经量化，AAC 编出来与 C-kaitou.mp4 逐位相同
cp = os.path.join(ODIR, 'cues.json' if os.path.abspath(OUT) == os.path.abspath(os.path.join(OUTD, 'mix.wav')) else os.path.splitext(os.path.basename(OUT))[0] + '_cues.json')
json.dump(CUES, open(cp, 'w'), ensure_ascii=False, indent=0)
json.dump(REPORT, open(os.path.splitext(OUT)[0] + '_report.json', 'w'), ensure_ascii=False, indent=1)
if '--stems' in sys.argv:
    sd = os.path.join(ODIR, 'stems'); os.makedirs(sd, exist_ok=True)
    for k, v in {'music_ducked': music_d, 'sfx': sfx_r, 'amb': amb}.items(): sf.write(os.path.join(sd, k + '.wav'), v, SR, subtype='FLOAT')
print(f'mix.py: {OUT}  {DUR:.3f} s  全片 {I:.2f} LUFS  真峰值 {P:.2f} dBTP  音效 {len(CUES)} 条 {REPORT["per_chap"]}  被拒 {len(REPORT["rejected"])} 条')
