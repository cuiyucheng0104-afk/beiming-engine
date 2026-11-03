# -*- coding: utf-8 -*-
"""《北冥》混音自检：ffmpeg 官方响度（ebur128）、模拟 engine/render/mux.sh 的两遍 loudnorm（必须走线性增益）、
TECHNIQUE §5 频段能量、音高与和声核对、切点无爆音、单声道兼容，并画图（全片总览 + 三段放大），结果写 audio/check/。

用法：python audio/check.py
"""
import os
import sys
import json
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from dsp import SR, N, loudness_curve, db, undb  # noqa: E402

OUT = os.path.join(ROOT, 'out', 'mix.wav')
CK = os.path.join(HERE, 'check')
os.makedirs(CK, exist_ok=True)
CUES = json.load(open(os.path.join(HERE, 'cues.json'), encoding='utf-8'))
REP = {}


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


# ———— 1. 文件格式 ————
x, sr = sf.read(OUT, dtype='float64', always_2d=True)
info = sf.info(OUT)
REP['format'] = {'sr': sr, 'channels': x.shape[1], 'samples': len(x), 'seconds': len(x) / sr, 'subtype': info.subtype,
                 'ok': sr == 48000 and x.shape[1] == 2 and len(x) == 480000}

# ———— 2. ffmpeg ebur128 ————
r = run(['ffmpeg', '-hide_banner', '-nostats', '-i', OUT, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
s = r.stderr[r.stderr.rfind('Summary:'):]
num = lambda pat: float(re.search(pat, s).group(1))  # noqa: E731
REP['ebur128'] = {'I_LUFS': num(r'I:\s+(-?[\d.]+) LUFS'), 'LRA_LU': num(r'LRA:\s+(-?[\d.]+) LU'),
                  'TP_dBTP': num(r'Peak:\s+(-?[\d.]+) dBFS'),
                  'LRA_low': num(r'LRA low:\s+(-?[\d.]+) LUFS'), 'LRA_high': num(r'LRA high:\s+(-?[\d.]+) LUFS')}

# ———— 3. 模拟 mux.sh：两遍 loudnorm（I=-14:TP=-1.2:LRA=11, linear=true），看是否走线性 ————
r1 = run(['ffmpeg', '-hide_banner', '-nostats', '-i', OUT, '-af', 'loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json', '-f', 'null', '-'])
j1 = json.loads(r1.stderr[r1.stderr.rfind('{'):r1.stderr.rfind('}') + 1])
ln = ('loudnorm=I=-14:TP=-1.2:LRA=11:measured_I={input_i}:measured_TP={input_tp}:measured_LRA={input_lra}:'
      'measured_thresh={input_thresh}:offset={target_offset}:linear=true:print_format=json').format(**j1)
r2 = run(['ffmpeg', '-hide_banner', '-nostats', '-i', OUT, '-af', ln, '-f', 'null', '-'])
j2 = json.loads(r2.stderr[r2.stderr.rfind('{'):r2.stderr.rfind('}') + 1])
REP['mux_loudnorm'] = {'pass1': {k: j1[k] for k in ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']},
                       'normalization_type': j2.get('normalization_type'), 'output_i': j2.get('output_i'),
                       'output_tp': j2.get('output_tp')}

# ———— 4. 频段能量（相对最强频段） ————
mono = x.mean(1)
win = np.hanning(8192)
frames = np.lib.stride_tricks.sliding_window_view(mono, 8192)[::2048] * win
Pw = (np.abs(np.fft.rfft(frames, axis=1)) ** 2).sum(0)
fq = np.fft.rfftfreq(8192, 1 / SR)
bands = {'20-120': (20, 120), '120-500': (120, 500), '500-2k': (500, 2000), '2k-8k': (2000, 8000), '8k+': (8000, 24000)}
be = {k: 10 * np.log10(Pw[(fq >= lo) & (fq < hi)].sum() + 1e-20) for k, (lo, hi) in bands.items()}
top = max(be.values())
REP['band_rel_db'] = {k: round(v - top, 2) for k, v in be.items()}
REP['band_low_ok'] = REP['band_rel_db']['20-120'] <= -3.0
REP['band_high_ok'] = REP['band_rel_db']['8k+'] <= -15.0

# ———— 5. 切点 / 首尾 / 直流 / 单声道兼容 ————
def jump_ratio(t):
    a, b = N(t - 0.02), N(t + 0.02)
    d = np.abs(np.diff(x[a:b], axis=0)).max()
    ref = np.abs(np.diff(x[N(t - 0.3):N(t - 0.05)], axis=0)).max() + 1e-9
    return round(float(d / ref), 2)


REP['edges'] = {'first_sample': float(np.abs(x[0]).max()), 'last_sample': float(np.abs(x[-1]).max()),
                'dc': [round(float(v), 6) for v in x.mean(0)],
                'cut_jump_ratio': {str(t): jump_ratio(t) for t in [3.0, 5.0]}}
corr = float(np.corrcoef(x[:, 0], x[:, 1])[0, 1])
from dsp import integrated  # noqa: E402
REP['stereo'] = {'lr_correlation': round(corr, 3),
                 'mono_minus_stereo_LU': round(integrated(np.stack([mono, mono], 1)) - integrated(x), 2)}

# ———— 5b. 眼镜提示音会不会被盖住：提示音所在频带内，ui 总线能量 vs 其他四条总线能量（起音后一小段） ————
try:
    ui_st, _ = sf.read(os.path.join(HERE, 'stems', 'ui.wav'), dtype='float64', always_2d=True)
    rest = sum(sf.read(os.path.join(HERE, 'stems', f'{k}.wav'), dtype='float64', always_2d=True)[0]
               for k in ['amb', 'fx', 'kun', 'music'])

    def band_snr(t, lo, hi, d):
        a, b = N(t), N(t + d)
        u, o = ui_st[a:b].mean(1), rest[a:b].mean(1)
        U, O = np.abs(np.fft.rfft(u * np.hanning(len(u)))) ** 2, np.abs(np.fft.rfft(o * np.hanning(len(o)))) ** 2
        fq_ = np.fft.rfftfreq(len(u), 1 / SR)
        m = (fq_ >= lo) & (fq_ < hi)
        return round(float(10 * np.log10(U[m].sum() / (O[m].sum() + 1e-20) + 1e-20)), 1)

    REP['ui_band_snr_db'] = {
        'touch_3.55': band_snr(3.55, 2000, 7000, 0.02),
        'wake_ping_3.60': band_snr(3.60, 1650, 1880, 0.3),
        'ui_scan_5.45': band_snr(5.45, 1230, 1880, 0.3),
        'ui_fail_6.25': band_snr(6.25, 1400, 1880, 0.3),
        'ui_nav_7.00': band_snr(7.00, 1100, 1880, 0.4),
    }
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
    pit = {
        'horn_tone1_A3': f0_med(h, 0.47, 0.78, 150, 400),
        'horn_tone2_D3': f0_med(h, 0.95, 1.40, 100, 300),
        'kun_hold_A2': f0_med(k, 5.70, 6.50, 60, 220),
        'kun_end_D2': f0_med(k, 7.62, 7.80, 45, 160),
    }
    refs = {'horn_tone1_A3': 220.0, 'horn_tone2_D3': 146.83, 'kun_hold_A2': 110.0, 'kun_end_D2': 73.42}
    REP['pitch'] = {kk: {'hz': None if v is None else round(v, 2), 'cents_off': cents(v, refs[kk])} for kk, v in pit.items()}
    mus, _ = sf.read(os.path.join(HERE, 'stems', 'music.wav'), dtype='float64', always_2d=True)
    mm = mus.mean(1)
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    ch = librosa.feature.chroma_cqt(y=mm, sr=SR, hop_length=512)
    tch = np.arange(ch.shape[1]) * 512 / SR
    REP['chords'] = {}
    for lab, a, b in [('D(add9)', 5.7, 6.3), ('D6', 6.9, 7.3), ('G/D', 7.75, 8.1), ('C/D', 8.5, 8.9), ('D', 9.08, 9.5)]:
        v = ch[:, (tch >= a) & (tch < b)].mean(1)
        order = np.argsort(v)[::-1][:5]
        REP['chords'][lab] = [f'{names[i]}:{v[i]:.2f}' for i in order]
except Exception as e:  # noqa: BLE001
    REP['pitch_error'] = repr(e)

# ———— 7. 画图 ————
FONT_CANDS = ['/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc']


def font(sz):
    for p in FONT_CANDS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except OSError:
                pass
    return ImageFont.load_default(sz)


ANCH = np.array([[8, 8, 24], [48, 18, 92], [120, 28, 120], [190, 55, 95], [240, 110, 60], [252, 185, 70], [252, 250, 200]], float)


def cmap(v):
    v = np.clip(v, 0, 1) * (len(ANCH) - 1)
    i = np.minimum(v.astype(int), len(ANCH) - 2)
    f = (v - i)[..., None]
    return (ANCH[i] * (1 - f) + ANCH[i + 1] * f).astype(np.uint8)


def spec_img(sig, t0, t1, w, h, fmin=30, fmax=20000, dbr=(-100, -20), nfft=4096, hop=256):
    seg = sig[N(t0):N(t1)]
    seg = seg.mean(1) if seg.ndim == 2 else seg
    seg = np.pad(seg, (nfft // 2, nfft // 2))
    fr = np.lib.stride_tricks.sliding_window_view(seg, nfft)[::hop] * np.hanning(nfft)
    S = 20 * np.log10(np.abs(np.fft.rfft(fr, axis=1)) / (nfft / 4) + 1e-12)
    fq = np.fft.rfftfreq(nfft, 1 / SR)
    ys = np.geomspace(fmin, fmax, h)[::-1]
    idx = np.clip(np.searchsorted(fq, ys), 1, len(fq) - 1)
    img = S[:, idx].T
    xs = np.linspace(0, img.shape[1] - 1, w).astype(int)
    img = img[:, xs]
    v = (img - dbr[0]) / (dbr[1] - dbr[0])
    return Image.fromarray(cmap(v)), ys


def wave_img(sig, t0, t1, w, h):
    im = Image.new('RGB', (w, h), (14, 14, 26))
    dr = ImageDraw.Draw(im)
    seg = sig[N(t0):N(t1)]
    col = [(120, 170, 255), (255, 160, 140)]
    for c in range(2):
        y0 = h * (c + 0.5) / 2
        amp = h / 4 * 0.95
        ch = seg[:, c]
        n = len(ch)
        for i in range(w):
            a, b = int(i * n / w), int((i + 1) * n / w)
            if b <= a:
                continue
            mn, mx = ch[a:b].min(), ch[a:b].max()
            dr.line([(i, y0 - mx * amp), (i, y0 - mn * amp)], fill=col[c])
        for g in (-1, 1):   # -1.7 dBTP 线
            yy = y0 - g * amp * undb(-1.7)
            dr.line([(0, yy), (w, yy)], fill=(70, 70, 90))
    return im


def curves_panel(series, t0, t1, w, h, lo=-50, hi=0, refs=(-14, -23)):
    im = Image.new('RGB', (w, h), (14, 14, 26))
    dr = ImageDraw.Draw(im)
    f = font(16)
    for v in range(lo, hi + 1, 10):
        y = h - (v - lo) / (hi - lo) * h
        dr.line([(0, y), (w, y)], fill=(40, 40, 60))
        dr.text((4, y - 18), f'{v}', fill=(110, 110, 140), font=f)
    for rv in refs:
        y = h - (rv - lo) / (hi - lo) * h
        dr.line([(0, y), (w, y)], fill=(90, 90, 60))
    for name, (tc, L, colr, wd) in series.items():
        m = (tc >= t0) & (tc <= t1)
        pts = [((t - t0) / (t1 - t0) * w, h - (np.clip(v, lo, hi) - lo) / (hi - lo) * h) for t, v in zip(tc[m], L[m])]
        if len(pts) > 1:
            dr.line(pts, fill=colr, width=wd)
    return im


def figure(path, t0, t1, title, fmax=20000, fmin=30, lanes=True, extra=None):
    W, M = 2400, 70
    f20, f16 = font(24), font(16)
    wv = wave_img(x, t0, t1, W - M, 260)
    sp, ys = spec_img(x, t0, t1, W - M, 520, fmin, fmax)
    tc_m, Lm = loudness_curve(x, 0.4, 0.02)
    tc_s, Ls = loudness_curve(x, 3.0, 0.02)
    lc = curves_panel({'m': (tc_m, Lm, (120, 220, 255), 2), 's': (tc_s, Ls, (255, 230, 120), 4)}, t0, t1, W - M, 300)
    panels = [('波形 L/R（灰线 = −1.7 dBTP）', wv), (f'频谱（对数频率 {fmin}–{fmax} Hz）', sp),
              ('响度：蓝 = 瞬时 0.4 s，黄 = 短时 3 s（参考线 −14 / −23 LUFS）', lc)]
    if lanes:
        cols = {'amb': (120, 200, 140), 'fx': (230, 150, 90), 'kun': (180, 140, 255), 'ui': (120, 230, 255), 'music': (255, 120, 170)}
        ser = {}
        for k, cc in cols.items():
            st, _ = sf.read(os.path.join(HERE, 'stems', f'{k}.wav'), dtype='float64', always_2d=True)
            tcc, LL = loudness_curve(st, 0.4, 0.02)
            ser[k] = (tcc, LL, cc, 3)
        panels.append(('五条总线的瞬时响度：绿 amb · 橙 fx · 紫 kun · 青 ui · 粉 music', curves_panel(ser, t0, t1, W - M, 300, -60, -5)))
    # 声场宽度：侧信号/中信号能量比（dB，0.2 s 窗）。单声道 → 很低；左右完全不相关 → 0 dB
    hop, wn = N(0.02), N(0.2)
    mid, side = ((x[:, 0] + x[:, 1]) / 2) ** 2, ((x[:, 0] - x[:, 1]) / 2) ** 2
    cm, cs = np.concatenate([[0], np.cumsum(mid)]), np.concatenate([[0], np.cumsum(side)])
    st_ = np.arange(0, len(x) - wn, hop)
    wdb = 10 * np.log10((cs[st_ + wn] - cs[st_] + 1e-12) / (cm[st_ + wn] - cm[st_] + 1e-12))
    panels.append(('声场宽度：S/M 能量比 dB（越高越宽；参考线 −10 / −20）',
                   curves_panel({'w': ((st_ + wn / 2) / SR, wdb, (200, 255, 160), 3)}, t0, t1, W - M, 200, -30, 0, refs=(-10, -20))))
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


figs = [figure(os.path.join(CK, 'overview.png'), 0.0, 10.0, '《北冥》10 秒混音总览 out/mix.wav'),
        figure(os.path.join(CK, 'zoom_A.png'), 0.0, 3.2, '镜头 A 雾江：汽笛 A3→D3、鸽群、鲲影', fmax=8000, lanes=False),
        figure(os.path.join(CK, 'zoom_BC.png'), 2.9, 6.6, '镜头 B→C：触碰、提示音、暗影、5.0 打开、鲲鸣起音', fmax=8000, lanes=False),
        figure(os.path.join(CK, 'zoom_C.png'), 5.0, 10.0, '镜头 C 鲲现：鲲鸣 A2→D2、掠过、导航、顶点 9.0', fmin=40, fmax=4000, lanes=False)]

# ffmpeg 自己的频谱图作旁证
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', OUT, '-lavfi',
                'showspectrumpic=s=1600x700:legend=1:scale=log:fscale=log:color=magma', os.path.join(CK, 'ffmpeg_spectrum.png')])
REP['figures'] = figs + [os.path.join(CK, 'ffmpeg_spectrum.png')]

_d = lambda o: o.item() if hasattr(o, 'item') else str(o)  # noqa: E731
json.dump(REP, open(os.path.join(CK, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=_d)
print(json.dumps(REP, ensure_ascii=False, indent=1, default=_d))
