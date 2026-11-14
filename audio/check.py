# -*- coding: utf-8 -*-
"""《北冥》30 秒混音自检：ffmpeg 官方响度（ebur128）、模拟 engine/render/mux.sh 的两遍 loudnorm（必须走线性增益）、
频段能量、音高与和声核对、切点无爆音、关灯段静音核对、单声道兼容，并画图（全片总览 + 三段放大），结果写 audio/check/。

用法：python audio/check.py
"""
import os
import sys
import json
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)          # 仓库根：engine.audio
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from engine.audio.dsp import SR, N  # noqa: E402
from engine.audio.meter import loudness_curve, integrated, band_energy, band_snr, ebur128, loudnorm_linear  # noqa: E402
from engine.audio.scope import font, spectrogram, waveform, curves, side_mid  # noqa: E402

OUT = os.path.join(ROOT, 'out', 'mix.wav')
CK = os.path.join(HERE, 'check')
os.makedirs(CK, exist_ok=True)
CUES = json.load(open(os.path.join(HERE, 'cues.json'), encoding='utf-8'))
DUR = float(CUES['dur'])
REP = {}


# ———— 1. 文件格式 ————
x, sr = sf.read(OUT, dtype='float64', always_2d=True)
info = sf.info(OUT)
REP['format'] = {'sr': sr, 'channels': x.shape[1], 'samples': len(x), 'seconds': len(x) / sr, 'subtype': info.subtype,
                 'ok': sr == 48000 and x.shape[1] == 2 and len(x) == N(DUR)}

# ———— 2. ffmpeg ebur128 ————
REP['ebur128'] = ebur128(OUT)

# ———— 3. 模拟 mux.sh：两遍 loudnorm（I=-14:TP=-1.2:LRA=11, linear=true），看是否走线性 ————
j1, j2 = loudnorm_linear(OUT, I=-14, TP=-1.2, LRA=11)
REP['mux_loudnorm'] = {'pass1': {k: j1[k] for k in ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']},
                       'normalization_type': j2.get('normalization_type'), 'output_i': j2.get('output_i'),
                       'output_tp': j2.get('output_tp')}

# ———— 4. 频段能量（相对最强频段） ————
REP['band_rel_db'] = band_energy(x)
REP['band_low_ok'] = REP['band_rel_db']['20-120'] <= -3.0
REP['band_high_ok'] = REP['band_rel_db']['8k+'] <= -15.0

# ———— 5. 切点 / 首尾 / 直流 / 单声道兼容 / 关灯段配乐静音 ————
def jump_ratio(t):
    a, b = N(t - 0.02), N(t + 0.02)
    d = np.abs(np.diff(x[a:b], axis=0)).max()
    ref = np.abs(np.diff(x[N(t - 0.3):N(t - 0.05)], axis=0)).max() + 1e-9
    return round(float(d / ref), 2)


cuts = [float(s['t']) for s in CUES['shots'] if float(s['t']) > 0]
REP['edges'] = {'first_sample': float(np.abs(x[0]).max()), 'last_sample': float(np.abs(x[-1]).max()),
                'dc': [round(float(v), 6) for v in x.mean(0)],
                'cut_jump_ratio': {str(t): jump_ratio(t) for t in cuts}}
corr = float(np.corrcoef(x[:, 0], x[:, 1])[0, 1])
mono = x.mean(1)
REP['stereo'] = {'lr_correlation': round(corr, 3),
                 'mono_minus_stereo_LU': round(integrated(np.stack([mono, mono], 1)) - integrated(x), 2)}

try:
    mus_st, _ = sf.read(os.path.join(HERE, 'stems', 'music.wav'), dtype='float64', always_2d=True)
    e_seg = mus_st[N(15.0):N(19.0)]
    REP['shot_e_music_max_abs'] = float(np.abs(e_seg).max())
    REP['shot_e_music_silent_ok'] = float(np.abs(e_seg).max()) < 1e-6
except Exception as e:  # noqa: BLE001
    REP['shot_e_check_error'] = repr(e)

# ———— 5b. 眼镜提示音会不会被盖住：提示音所在频带内，ui 总线能量 vs 其他四条总线能量（起音后一小段） ————
try:
    ui_st, _ = sf.read(os.path.join(HERE, 'stems', 'ui.wav'), dtype='float64', always_2d=True)
    rest = sum(sf.read(os.path.join(HERE, 'stems', f'{k}.wav'), dtype='float64', always_2d=True)[0]
               for k in ['amb', 'fx', 'kun', 'music'])

    REP['ui_band_snr_db'] = {
        'touch_3.55': band_snr(ui_st, rest, 3.55, 2000, 7000, 0.02),
        'wake_ping_3.60': band_snr(ui_st, rest, 3.60, 1650, 1880, 0.3),
        'ui_scan_5.45': band_snr(ui_st, rest, 5.45, 1230, 1880, 0.3),
        'ui_fail_6.25': band_snr(ui_st, rest, 6.25, 1400, 1880, 0.3),
        'ui_nav_7.00': band_snr(ui_st, rest, 7.00, 1100, 1880, 0.4),
        'ui_route_10.45': band_snr(ui_st, rest, 10.45, 1100, 1880, 0.35),
        'ui_dark_15.40': band_snr(ui_st, rest, 15.40, 1100, 1550, 0.30),
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
    if 'kun_peng_dry' in el:
        kp = el['kun_peng_dry']
        pit['peng_crest_A3'] = f0_med(kp, 20.60, 21.10, 140, 320)
        refs['peng_crest_A3'] = 220.0
    REP['pitch'] = {kk: {'hz': None if v is None else round(v, 2), 'cents_off': cents(v, refs[kk])} for kk, v in pit.items()}
    mus, _ = sf.read(os.path.join(HERE, 'stems', 'music.wav'), dtype='float64', always_2d=True)
    mm = mus.mean(1)
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    ch = librosa.feature.chroma_cqt(y=mm, sr=SR, hop_length=512)
    tch = np.arange(ch.shape[1]) * 512 / SR
    REP['chords'] = {}
    for lab, a, b in [('C_D(add9)', 5.7, 6.3), ('C_D6', 6.9, 7.3), ('C_G/D', 7.75, 8.1), ('C_C/D', 8.2, 8.5),
                      ('F_D(add9)', 20.0, 21.4), ('F_D6', 22.3, 23.6), ('G_G/D', 24.6, 25.6), ('G_C/D', 26.2, 26.9),
                      ('G_D_apex', 27.45, 27.9)]:
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
    step = 1.0 if t1 - t0 > 12 else (0.5 if t1 - t0 > 4 else 0.25)
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
        dr.text((xx + 3, tops[0][0] + 4 + (k % 8) * 20), cu['id'], fill=(255, 255, 255), font=f16)
        k += 1
    if extra:
        extra(dr, M, W, tops, t0, t1)
    im.save(path)
    return path


for old in ['zoom_A.png', 'zoom_BC.png', 'zoom_C.png']:
    p = os.path.join(CK, old)
    if os.path.exists(p):
        os.remove(p)

figs = [figure(os.path.join(CK, 'overview.png'), 0.0, DUR, '《北冥》30 秒混音总览 out/mix.wav'),
        figure(os.path.join(CK, 'zoom_0_10.png'), 0.0, 10.0, '前段 0–10 s（雾江 · 她 · 鲲现）：汽笛、触碰、鲲鸣 A2→D2', fmax=8000, lanes=False),
        figure(os.path.join(CK, 'zoom_10_19.png'), 10.0, 19.0, '中段 10–19 s（离航 · 关灯）：汽笛鲲鸣应答、15.25 断电、鲲深呼吸', fmax=8000, lanes=False),
        figure(os.path.join(CK, 'zoom_19_30.png'), 19.0, DUR, '后段 19–30 s（化鹏 · 扶摇）：鲲鹏清鸣、振翅、27.4 顶点、空气收尾', fmin=40, fmax=8000, lanes=False)]

# ffmpeg 自己的频谱图作旁证
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', OUT, '-lavfi',
                'showspectrumpic=s=1600x700:legend=1:scale=log:fscale=log:color=magma', os.path.join(CK, 'ffmpeg_spectrum.png')])
REP['figures'] = figs + [os.path.join(CK, 'ffmpeg_spectrum.png')]

_d = lambda o: o.item() if hasattr(o, 'item') else str(o)  # noqa: E731
json.dump(REP, open(os.path.join(CK, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=_d)
print(json.dumps(REP, ensure_ascii=False, indent=1, default=_d))
