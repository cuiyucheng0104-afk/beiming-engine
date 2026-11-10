# -*- coding: utf-8 -*-
"""《北冥》混音自检：ffmpeg 官方响度（ebur128）、成片响度（真的跑一遍 engine/render/mux.sh 再测）、
频段能量、音高与和声核对、切点无爆音、环境声空洞、单声道兼容、分轨峰值，并画图（全片总览 + 三段放大），结果写 audio/check/。

所有时间都从 audio/cues.json（镜头切点、各事件的 t）和 audio/check/render.json（配乐的和声表）推导，改了时间表照样量对地方。
判定分两级：problems（成片响度偏离 cues.json 的目标超过 ±0.3 LU、真峰值高于 −1.0 dBTP、文件格式不对、mux.sh 跑不通或跑不了）
会让本脚本以退出码 1 结束；warnings（loudnorm 测量偏差、环境声空洞、分轨超满幅、频段越界等）只记录和打印。

用法：python audio/check.py
需要 ffmpeg；成片响度这一项还要用 sh 跑 engine/render/mux.sh（mux.sh 另外用到 ffprobe。macOS / Linux 的终端都有 sh，
Windows 请在 Git Bash 或 WSL 里跑）。PATH 里找不到 sh、或 mux.sh 起不来、跑不通时，这一项记进 problems，其余照常测完，报告照常写出。
"""
import os
import sys
import json
import shutil
import tempfile
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)          # 仓库根：engine.audio
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from engine.audio.dsp import SR, N, db  # noqa: E402
from engine.audio.meter import loudness_curve, integrated, band_energy, band_snr, ebur128, loudnorm_linear, true_peak  # noqa: E402
from engine.audio.scope import font, spectrogram, waveform, curves, side_mid  # noqa: E402

OUT = os.path.join(ROOT, 'out', 'mix.wav')
MUX = os.path.join(ROOT, 'engine', 'render', 'mux.sh')
CK = os.path.join(HERE, 'check')
os.makedirs(CK, exist_ok=True)
if os.path.exists(os.path.join(CK, 'report.json')):
    os.remove(os.path.join(CK, 'report.json'))      # 中途出错时不留上一次的报告冒充这一次
CUES = json.load(open(os.path.join(HERE, 'cues.json'), encoding='utf-8'))
RENDER = json.load(open(os.path.join(CK, 'render.json'), encoding='utf-8')) if os.path.exists(os.path.join(CK, 'render.json')) else {}
DUR = float(CUES['dur'])
FPS = int(CUES.get('fps', 24))
C = {c['id']: c for c in CUES['cues']}
SH = {s['id']: s for s in CUES['shots']}
CUTS = [float(SH['B']['t']), float(SH['C']['t'])]
TGT_I = float(CUES['target']['integrated_lufs'])
TOL_I, MAX_TP = 0.3, -1.0          # 成片：积分响度离目标不超过 ±0.3 LU；真峰值不高于 −1.0 dBTP（mux.sh 的上限 −1.2，给 AAC 留 0.2）
REP = {}
PROBLEMS, WARNINGS = [], []


def T0(cid):
    return float(C[cid]['t'])


def r4(v):
    return round(float(v), 4)


# ———— 1. 文件格式 ————
x, sr = sf.read(OUT, dtype='float64', always_2d=True)
info = sf.info(OUT)
REP['format'] = {'sr': sr, 'channels': x.shape[1], 'samples': len(x), 'seconds': len(x) / sr, 'subtype': info.subtype,
                 'ok': sr == int(CUES.get('sr', 48000)) and x.shape[1] == 2 and len(x) == N(DUR)}
if not REP['format']['ok']:
    PROBLEMS.append(f'out/mix.wav 格式不对：{sr} Hz、{x.shape[1]} 声道、{len(x)} 个样本（应为 {CUES.get("sr", 48000)} Hz、2 声道、{N(DUR)} 个样本）')

# ———— 2. ffmpeg ebur128 ————
REP['ebur128'] = ebur128(OUT)

# ———— 3. 成片响度：用真的 engine/render/mux.sh 把 mix.wav 和一段同长的黑画面封装一遍，再测成片 ————
#   mux.sh 怎么归一化（两遍 loudnorm、按 ebur128 算增益……）都以它自己为准，这里只看结果是不是落在目标上。
def _tail(t, n=6):
    return '\n'.join((t or '').strip().splitlines()[-n:])


def mux_probe():
    """真的跑一遍 mux.sh，返回探针成片的测量值。跑不了时返回 {'error': 原因}，由下面记进 problems（报告照常写出、退出码 1），
    不让异常把整个自检打断：没有 mux.sh、PATH 里没有 sh（例如在 Windows 的 PowerShell / cmd 里直接跑本脚本）、
    ffmpeg 或 sh 起不来（找不到、没有执行权限、格式不对）、临时目录建不了、探针成片测不出响度，都算这一类。"""
    if not os.path.exists(MUX):
        return {'error': f'找不到 {MUX}'}
    sh = shutil.which('sh')
    if sh is None:
        return {'error': '找不到 sh：这一项要用 sh 跑 engine/render/mux.sh。请在带 sh 的终端里跑'
                         '（macOS / Linux 的终端；Windows 用 Git Bash 或 WSL），或把 sh 所在目录加进 PATH'}
    td = None
    try:
        td = tempfile.mkdtemp(prefix='beiming-mux-')
        v, o = os.path.join(td, 'black.mp4'), os.path.join(td, 'probe.mp4')
        r = subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', f'color=c=black:s=64x36:r={FPS}:d={DUR}',
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v], capture_output=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            return {'error': f'生成探针画面失败：{_tail(r.stderr)}'}
        r = subprocess.run([sh, MUX, v, OUT, o, str(FPS), '0'], capture_output=True, encoding='utf-8', errors='replace')
        if r.returncode != 0 or not os.path.exists(o):
            return {'error': f'mux.sh 退出码 {r.returncode}：{_tail(r.stderr or r.stdout)}'}
        e = ebur128(o)
        pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', o, '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True)
        a = np.frombuffer(pcm.stdout, dtype='<f4').astype(np.float64).reshape(-1, 2) if pcm.returncode == 0 else None
        res = {'I_LUFS': e['I_LUFS'], 'TP_dBTP': e['TP_dBTP'], 'LRA_LU': e['LRA_LU']}
        if a is not None and len(a):
            res['I_internal'] = round(integrated(a), 2)
            res['TP_internal'] = round(float(db(true_peak(a))), 2)
            res['seconds'] = round(len(a) / SR, 3)
        return res
    except (OSError, RuntimeError) as e:     # OSError：进程起不来、临时目录；RuntimeError：engine.audio.meter 测不出响度
        return {'error': f'mux.sh 探针跑不下去（{type(e).__name__}）：{e}'}
    finally:
        if td:
            shutil.rmtree(td, ignore_errors=True)   # 清理失败不影响结果


dl = mux_probe()
dl.update({'via': 'engine/render/mux.sh', 'target_I': TGT_I, 'tol_LU': TOL_I, 'max_TP': MAX_TP})
if 'error' in dl:
    dl['ok'] = False
    PROBLEMS.append(f'成片响度测不了：{dl["error"]}')
else:
    i_meas = dl.get('I_internal', dl['I_LUFS'])
    tp_meas = max(dl['TP_dBTP'], dl.get('TP_internal', -99.0))
    dl['ok'] = abs(i_meas - TGT_I) <= TOL_I and tp_meas <= MAX_TP
    if abs(i_meas - TGT_I) > TOL_I:
        PROBLEMS.append(f'成片（经 mux.sh）积分响度 {i_meas:.2f} LUFS，偏离目标 {TGT_I:g} 超过 ±{TOL_I} LU'
                        f'（mix.wav 自己是 {REP["ebur128"]["I_LUFS"]} LUFS：问题在 mux.sh 的归一化）')
    if tp_meas > MAX_TP:
        PROBLEMS.append(f'成片（经 mux.sh）真峰值 {tp_meas:.2f} dBTP，高于 {MAX_TP} dBTP')
REP['deliverable'] = dl

# 旁证：ffmpeg loudnorm 两遍（老版 mux.sh 的做法）。第一遍的测量和 BS.1770 差得多，说明 loudnorm 不能拿来算线性增益
j1, j2 = loudnorm_linear(OUT, I=-14, TP=-1.2, LRA=11)
REP['mux_loudnorm'] = {'pass1': {k: j1[k] for k in ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']},
                       'normalization_type': j2.get('normalization_type'), 'output_i': j2.get('output_i'),
                       'output_tp': j2.get('output_tp'),
                       'pass1_vs_ebur128_LU': round(float(j1['input_i']) - REP['ebur128']['I_LUFS'], 2)}
#   只在探针真的测出成片不达标时拿它作解释；探针没跑成（'error'，例如找不到 sh）时这条解释不成立，不报
if abs(REP['mux_loudnorm']['pass1_vs_ebur128_LU']) > 0.3 and not dl['ok'] and 'error' not in dl:
    WARNINGS.append(f'loudnorm 第一遍测得 {j1["input_i"]} LUFS，比 ebur128 的 {REP["ebur128"]["I_LUFS"]} 偏了 '
                    f'{REP["mux_loudnorm"]["pass1_vs_ebur128_LU"]:+.2f} LU：mux.sh 若按它做线性归一化，成片就会落在 '
                    f'{j2.get("output_i")} LUFS（应改成按 ebur128 / BS.1770 的测量算增益）')

# ———— 4. 频段能量（相对最强频段） ————
REP['band_rel_db'] = band_energy(x)
REP['band_low_ok'] = REP['band_rel_db']['20-120'] <= -3.0
REP['band_high_ok'] = REP['band_rel_db']['8k+'] <= -15.0
if not REP['band_low_ok']:
    WARNINGS.append(f'20–120 Hz 相对最强频段 {REP["band_rel_db"]["20-120"]} dB，高于 −3 dB')
if not REP['band_high_ok']:
    WARNINGS.append(f'8 kHz 以上相对最强频段 {REP["band_rel_db"]["8k+"]} dB，高于 −15 dB')

# ———— 5. 切点 / 首尾 / 直流 / 单声道兼容 ————
def jump_ratio(t):
    a, b = N(t - 0.02), N(t + 0.02)
    d = np.abs(np.diff(x[a:b], axis=0)).max()
    ref = np.abs(np.diff(x[N(t - 0.3):N(t - 0.05)], axis=0)).max() + 1e-9
    return round(float(d / ref), 2)


REP['edges'] = {'first_sample': float(np.abs(x[0]).max()), 'last_sample': float(np.abs(x[-1]).max()),
                'dc': [round(float(v), 6) for v in x.mean(0)],
                'cut_jump_ratio': {str(t): jump_ratio(t) for t in CUTS}}
corr = float(np.corrcoef(x[:, 0], x[:, 1])[0, 1])
mono = x.mean(1)
REP['stereo'] = {'lr_correlation': round(corr, 3),
                 'mono_minus_stereo_LU': round(integrated(np.stack([mono, mono], 1)) - integrated(x), 2)}

# ———— 5b. 分轨：峰值与环境声空洞 ————
STEM = {}
for k in ['amb', 'fx', 'kun', 'ui', 'music']:
    pth = os.path.join(HERE, 'stems', f'{k}.wav')
    if os.path.exists(pth):
        STEM[k] = sf.read(pth, dtype='float64', always_2d=True)[0]
if STEM:
    sub = {k: sf.info(os.path.join(HERE, 'stems', f'{k}.wav')).subtype for k in STEM}
    pk = {k: round(float(db(np.abs(v).max())), 2) for k, v in STEM.items()}
    REP['stems'] = {'subtype': sub, 'peak_dbfs': pk}
    for k, v in pk.items():
        if v >= -0.1:
            if sub[k] in ('FLOAT', 'DOUBLE'):
                WARNINGS.append(f'{k} 分轨峰值 {v:+.2f} dBFS：浮点存储没有削波，但要转成整数 PCM 先整体降 {v + 0.1:.2f} dB 以上')
            else:
                PROBLEMS.append(f'{k} 分轨峰值 {v:+.2f} dBFS、却是 {sub[k]} 整数格式：超出满幅的部分已经被削掉')
if 'amb' in STEM:
    # 镜头内（避开片头 0.05 s、片尾淡出和切点 ±0.03 s）每 50 ms 的环境声电平；掉到 −60 dBFS 以下算空洞
    e_fade = float(C['end_fade']['t']) if 'end_fade' in C else DUR
    st = STEM['amb']
    hop = N(0.05)
    gaps = []
    for i in range(N(0.05), min(len(st), N(e_fade)) - hop, hop):
        tc = i / SR
        if any(abs(tc - c) < 0.03 or abs(tc + 0.05 - c) < 0.03 for c in CUTS):
            continue
        lv = 10 * np.log10(np.mean(st[i:i + hop] ** 2) + 1e-20)
        if lv < -60:
            gaps.append([r4(tc), round(float(lv), 1)])
    REP['amb_gaps'] = gaps
    if gaps:
        WARNINGS.append(f'环境声在 {gaps[0][0]:.2f}–{gaps[-1][0] + 0.05:.2f} s 有 {len(gaps)} 段 50 ms 掉到 −60 dBFS 以下（空洞），'
                        f'先查镜头切点和环境声底层')

# ———— 5c. 眼镜提示音会不会被盖住：提示音所在频带内，ui 总线能量 vs 其他四条总线能量（起音后一小段） ————
UI_SNR = [('touch', 2000, 7000, 0.02), ('wake_ping', 1650, 1880, 0.3), ('ui_scan', 1230, 1880, 0.3),
          ('ui_fail', 1400, 1880, 0.3), ('ui_nav', 1100, 1880, 0.4)]
try:
    ui_st = STEM['ui']
    rest = sum(STEM[k] for k in ['amb', 'fx', 'kun', 'music'])
    REP['ui_band_snr_db'] = {f'{cid}_{T0(cid):.2f}': band_snr(ui_st, rest, T0(cid), lo, hi, d) for cid, lo, hi, d in UI_SNR}
except Exception as e:  # noqa: BLE001
    REP['ui_snr_error'] = repr(e)

# ———— 6. 音高与和声 ————
try:
    import librosa
    el = np.load(os.path.join(CK, 'elements.npz'))

    def f0_med(sig, t0, t1, fmin, fmax):
        seg = sig[N(t0):N(t1)].mean(1) if sig.ndim == 2 else sig[N(t0):N(t1)]
        f0, vf, _ = librosa.pyin(seg.astype(np.float64), fmin=fmin, fmax=fmax, sr=SR, frame_length=4096, hop_length=256)
        f0 = f0[vf]
        return float(np.median(f0)) if len(f0) else None

    def cents(f, ref):
        return None if f is None else round(1200 * np.log2(f / ref), 1)

    h = el['horn_dry']
    k = el['kun_dry']
    # 测音高的窗口相对各自 cue 的 t（汽笛、鲲鸣的音高曲线见 audio/design.py 的 horn / kun_call）。
    # kun_end_D2 只量 D2 的平台（相对 2.30–2.36 s）：2.34 s 起“尾音再沉 2.5 个半音”是设计好的下沉，不算跑调
    th, tk = T0('horn'), T0('kun_call')
    pit = {
        'horn_tone1_A3': f0_med(h, r4(th + 0.07), r4(th + 0.38), 150, 400),
        'horn_tone2_D3': f0_med(h, r4(th + 0.55), r4(th + 1.00), 100, 300),
        'kun_hold_A2': f0_med(k, r4(tk + 0.40), r4(tk + 1.20), 60, 220),
        'kun_end_D2': f0_med(k, r4(tk + 2.30), r4(tk + 2.36), 45, 160),
    }
    refs = {'horn_tone1_A3': 220.0, 'horn_tone2_D3': 146.83, 'kun_hold_A2': 110.0, 'kun_end_D2': 73.42}
    REP['pitch'] = {kk: {'hz': None if v is None else round(v, 2), 'cents_off': cents(v, refs[kk])} for kk, v in pit.items()}
    mus, _ = sf.read(os.path.join(HERE, 'stems', 'music.wav'), dtype='float64', always_2d=True)
    mm = mus.mean(1)
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    ch = librosa.feature.chroma_cqt(y=mm, sr=SR, hop_length=512)
    tch = np.arange(ch.shape[1]) * 512 / SR
    REP['chords'] = {}
    # 和弦窗口相对配乐和声表里各和弦的时刻（mix.py 写进 render.json 的 harmony；配乐的时间以 audio/score.py 为准）
    CHORD_WIN = {'D(add9)': (0.70, 1.30), 'D6': (0.50, 0.90), 'G/D': (0.35, 0.70), 'C/D': (0.30, 0.70), 'D': (0.08, 0.50)}
    HT = {hm['chord']: float(hm['t']) for hm in RENDER.get('harmony', [])}
    if not HT:
        WARNINGS.append('audio/check/render.json 里没有配乐和声表，和弦核对跳过（先跑 audio/mix.py）')
    for lab, (oa, ob) in CHORD_WIN.items():
        if lab not in HT:
            continue
        a, b = r4(HT[lab] + oa), r4(HT[lab] + ob)
        v = ch[:, (tch >= a) & (tch < b)].mean(1)
        order = np.argsort(v)[::-1][:5]
        REP['chords'][lab] = [f'{names[i]}:{v[i]:.2f}' for i in order]
except Exception as e:  # noqa: BLE001
    REP['pitch_error'] = repr(e)

# ———— 7. 画图 ————
def figure(path, t0, t1, title, fmax=20000, fmin=30, lanes=True, extra=None):
    W, M = 2400, 70
    f20, f16 = font(24), font(16)
    wv = waveform(x, t0, t1, W - M, 260, ref_db=-1.7)
    sp, ys = spectrogram(x, t0, t1, W - M, 520, fmin, fmax)
    tc_m, Lm = loudness_curve(x, 0.4, 0.02)
    tc_s, Ls = loudness_curve(x, 3.0, 0.02)
    lc = curves({'m': (tc_m, Lm, (120, 220, 255), 2), 's': (tc_s, Ls, (255, 230, 120), 4)}, t0, t1, W - M, 300, refs=(-14, -23))
    panels = [('波形 L/R（灰线 = −1.7 dBTP）', wv), (f'频谱（对数频率 {fmin}–{fmax} Hz）', sp),
              ('响度：蓝 = 瞬时 0.4 s，黄 = 短时 3 s（参考线 −14 / −23 LUFS）', lc)]
    if lanes:
        cols = {'amb': (120, 200, 140), 'fx': (230, 150, 90), 'kun': (180, 140, 255), 'ui': (120, 230, 255), 'music': (255, 120, 170)}
        ser = {}
        for k, cc in cols.items():
            st, _ = sf.read(os.path.join(HERE, 'stems', f'{k}.wav'), dtype='float64', always_2d=True)
            tcc, LL = loudness_curve(st, 0.4, 0.02)
            ser[k] = (tcc, LL, cc, 3)
        panels.append(('五条总线的瞬时响度：绿 amb · 橙 fx · 紫 kun · 青 ui · 粉 music', curves(ser, t0, t1, W - M, 300, -60, -5, refs=(-14, -23))))
    # 声场宽度：侧信号/中信号能量比（dB，0.2 s 窗）。单声道 → 很低；左右完全不相关 → 0 dB
    tw, wdb = side_mid(x, 0.2, 0.02)
    panels.append(('声场宽度：S/M 能量比 dB（越高越宽；参考线 −10 / −20）',
                   curves({'w': (tw, wdb, (200, 255, 160), 3)}, t0, t1, W - M, 200, -30, 0, refs=(-10, -20))))
    H = 60 + sum(p.size[1] + 40 for _, p in panels) + 60
    im = Image.new('RGB', (W, H), (6, 6, 14))
    dr = ImageDraw.Draw(im)
    dr.text((M, 16), title, fill=(235, 235, 245), font=f20)
    y = 60
    tops = []
    for lab, p in panels:
        dr.text((M, y + 6), lab, fill=(170, 170, 200), font=f16)
        y += 32
        im.paste(p, (M, y))
        tops.append((y, p.size[1]))
        y += p.size[1] + 8
    # 频谱的频率刻度
    sy0 = tops[1][0]
    for fv in [50, 100, 200, 500, 1000, 2000, 5000, 10000]:
        if fmin <= fv <= fmax:
            yy = sy0 + np.argmin(np.abs(ys - fv))
            dr.text((4, yy - 8), f'{fv if fv < 1000 else str(fv // 1000) + "k"}', fill=(160, 160, 190), font=f16)
    # 时间刻度与事件标记
    step = 0.5 if t1 - t0 > 4 else 0.25
    for tv in np.arange(np.ceil(t0 / step) * step, t1 + 1e-6, step):
        xx = M + (tv - t0) / (t1 - t0) * (W - M)
        dr.line([(xx, y), (xx, y + 8)], fill=(200, 200, 220))
        dr.text((xx - 14, y + 10), f'{tv:.2f}' if step < 0.5 else f'{tv:.1f}', fill=(200, 200, 220), font=f16)
    k = 0
    for cu in CUES['cues']:
        tv = float(cu['t'])
        if not (t0 <= tv <= t1):
            continue
        xx = M + (tv - t0) / (t1 - t0) * (W - M)
        for (yy, hh) in tops:
            for z in range(int(yy), int(yy + hh), 10):
                dr.line([(xx, z), (xx, z + 5)], fill=(255, 255, 255))
        dr.text((xx + 3, tops[0][0] + 4 + (k % 6) * 20), cu['id'], fill=(255, 255, 255), font=f16)
        k += 1
    if extra:
        extra(dr, M, W, tops, t0, t1)
    im.save(path)
    return path


AB, BC = CUTS
APEX = next((float(hm['t']) for hm in RENDER.get('harmony', []) if hm.get('chord') == 'D'), T0('apex'))
figs = [figure(os.path.join(CK, 'overview.png'), 0.0, DUR, f'《北冥》{DUR:g} 秒混音总览 out/mix.wav'),
        figure(os.path.join(CK, 'zoom_A.png'), 0.0, r4(AB + 0.2), '镜头 A 雾江：汽笛 A3→D3、鸽群、鲲影', fmax=8000, lanes=False),
        figure(os.path.join(CK, 'zoom_BC.png'), r4(AB - 0.1), r4(min(DUR, BC + 1.6)),
               f'镜头 B→C：触碰、提示音、暗影、{BC:.1f} 打开、鲲鸣起音', fmax=8000, lanes=False),
        figure(os.path.join(CK, 'zoom_C.png'), BC, DUR, f'镜头 C 鲲现：鲲鸣 A2→D2、掠过、导航、顶点 {APEX:.1f}', fmin=40, fmax=4000, lanes=False)]

# ffmpeg 自己的频谱图作旁证
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', OUT, '-lavfi',
                'showspectrumpic=s=1600x700:legend=1:scale=log:fscale=log:color=magma', os.path.join(CK, 'ffmpeg_spectrum.png')])
REP['figures'] = figs + [os.path.join(CK, 'ffmpeg_spectrum.png')]

# 混音阶段（mix.py）记下的时间表告警也并进来
WARNINGS.extend(f'mix.py：{w}' for w in RENDER.get('warnings', []))
REP['problems'], REP['warnings'], REP['ok'] = PROBLEMS, WARNINGS, not PROBLEMS

_d = lambda o: o.item() if hasattr(o, 'item') else str(o)  # noqa: E731
json.dump(REP, open(os.path.join(CK, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=_d)
print(json.dumps(REP, ensure_ascii=False, indent=1, default=_d))
if PROBLEMS:
    print('[check] 没通过：\n  ' + '\n  '.join(PROBLEMS), file=sys.stderr)
    sys.exit(1)
