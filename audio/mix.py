# -*- coding: utf-8 -*-
"""《北冥》30 秒概念短片：完整混音。

读 audio/cues.json（时间、声像、增益微调）→ 渲染五条总线（环境 amb / 音效 fx / 鲲鸣 kun / 眼镜提示音 ui / 配乐 music）
→ 每个元素按“目标响度”自动定电平（下面 TARGET 表，就是这部片的混音平衡）→ 空间处理 → 母带
（低频平衡、−14 LUFS、过采样真峰值限制、末尾 0.3 s 淡出）→ out/mix.wav。
另写：audio/stems/*.wav（五条总线，已乘母带电平、未过限制器，合成时可重配比）、audio/CREDITS、audio/check/render.json。

用法：python audio/mix.py            配乐复用并延展 audio/score_cache.npz（无需外部采样库）
      python audio/mix.py --score    用采样库重新渲染配乐（需要 BEIMING_SAMPLES，见 engine/audio/sampler.py）
确定性：所有随机都有固定种子，重跑结果逐样本一致。
"""
import os
import sys
import json
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [HERE, ROOT]          # 同目录的 design / score，仓库根下的 engine.audio

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from engine.audio.dsp import SR, N, smoothstep, undb, db, stereo, width, make_ir, reverb, echoes, hp, lp, shelf, fade  # noqa: E402
from engine.audio.meter import true_peak, integrated, momentary_max, band_energy, onset  # noqa: E402
from engine.audio import mixing as M, ambience as A, sampler  # noqa: E402
import design as D  # noqa: E402

T_START = time.time()
CUES = json.load(open(os.path.join(HERE, 'cues.json'), encoding='utf-8'))
DUR = float(CUES['dur'])
NT = N(DUR)
C = {c['id']: c for c in CUES['cues']}
SH = {s['id']: s for s in CUES['shots']}
CUT_AB = float(SH['B']['t'])
CUT_BC = float(SH['C']['t'])
CUT_CD = float(SH['D']['t'])
CUT_DE = float(SH['E']['t'])
CUT_EF = float(SH['F']['t'])
CUT_FG = float(SH['G']['t'])
TGT_I = float(CUES['target']['integrated_lufs'])
TGT_TP = float(CUES['target']['true_peak_dbtp'])
tt = np.arange(NT) / SR

# 混音平衡：每个元素的目标（mom = 最大瞬时响度 LUFS；win = 区间积分响度 LUFS；peak = 采样峰值 dBFS）。
# 片尾 27.4 s 顶点最响（−12.5 LUFS 配乐 + 振翅 + 掠空），关灯段（15–19 s）配乐与城市底噪完全撤掉。
TARGET = {
    'amb_fog': (-26.0, 'win'), 'horn': (-20.0, 'mom'), 'pigeons': (-22.5, 'mom'), 'kun_glimpse': (-35.0, 'win'),
    'amb_close': (-24.5, 'win'), 'hair': (-29.0, 'win'), 'touch': (-17.0, 'peak'), 'wake_ping': (-35.0, 'mom'),
    'shadow': (-21.5, 'mom'),
    'open_bloom': (-24.5, 'mom'), 'amb_open': (-31.0, 'win'),
    'kun_call': (-18.0, 'mom'), 'kun_pass': (-22.0, 'mom'), 'seaweed': (-30.0, 'mom'),
    'ui_scan': (-31.0, 'mom'), 'ui_fail': (-33.0, 'mom'), 'ui_nav': (-26.5, 'mom'),
    # 10–15 s 离航
    'amb_estuary': (-29.5, 'win'), 'ui_route': (-27.5, 'mom'), 'horn_reply': (-21.5, 'mom'), 'kun_reply': (-20.0, 'mom'),
    # 15–19 s 关灯
    'amb_dark': (-36.5, 'win'), 'switch_off': (-22.5, 'mom'), 'ui_dark': (-33.5, 'mom'), 'kun_breath': (-28.5, 'win'),
    # 19–30 s 化鹏 · 扶摇
    'dawn_open': (-24.5, 'mom'), 'amb_sea': (-30.0, 'win'), 'kun_peng_call': (-17.5, 'mom'),
    'wing_flaps': (-22.5, 'mom'), 'soar_pass': (-24.5, 'mom'), 'seaweed_soar': (-32.5, 'mom'),
    'sea_birds': (-28.5, 'mom'), 'breeze': (-29.0, 'mom'),
    'music': (-12.5, 'mom'),
}


def T0(cid):
    return float(C[cid]['t'])


def G(cid):
    return undb(float(C[cid].get('gain_db', 0.0)))


def P(cid, default=0.0):
    return C[cid].get('pan', default)


def buf():
    return np.zeros((NT, 2))


def window(a, b, xf=0.012):
    """全局时间轴上的镜头窗：a 处等功率切入、b 处切出（交叉 xf 秒）"""
    return M.window(tt, a, b, xf, DUR)


def tail_after(b, rel=0.3):
    """镜头切走后，上一镜的尾巴在 rel 秒内收掉（轻微 L-cut，不硬断混响）"""
    return M.tail_after(tt, b, rel)


def at(x, t0):
    """把一段（单声道或立体声）放到全长时间轴上"""
    return M.at(x, t0, NT)


# ———— 按目标响度定电平 ————
LEVELS = {}


def level(name, st, t0=0.0, t1=None):
    """把元素 st 调到 TARGET[name]；win 型用 (t0, t1) 区间，mom 型在 (t0, t1) 里找最大瞬时响度"""
    target, how = TARGET[name]
    out, cur, g = M.match_level(st, target, how, t0, DUR if t1 is None else t1)
    LEVELS[name] = {'how': how, 'target': target, 'measured_raw': round(cur, 2), 'gain_db': round(g, 2)}
    return out


# ———— 空间（低频衰减都比中频短，混响输入先高通，防浑） ————
IR_RIVER = make_ir(rt=2.6, pre=0.045, tone=(0.85, 1.0, 0.68, 0.38), er=12, er_span=(0.01, 0.09), er_gain=0.4, seed=41)
IR_SMALL = make_ir(rt=0.35, pre=0.004, tone=(1.0, 1.0, 0.8, 0.6), er=6, er_span=(0.002, 0.02), er_gain=0.5, seed=42)
IR_SKY = make_ir(rt=4.0, pre=0.06, tone=(0.85, 1.0, 0.72, 0.45), er=6, er_span=(0.02, 0.12), er_gain=0.25, seed=43)
IR_KUN = make_ir(rt=4.4, pre=0.085, tone=(0.75, 1.0, 0.62, 0.32), er=5, er_span=(0.04, 0.16), er_gain=0.2, seed=44)

ELEM = {}   # 元素（定电平后、进总线前）留着做时间与音高核对

# 触碰镜腿那一下给它让路：发丝和近风在 3.45–3.80 s 轻轻让开 6 dB（听不出在躲，但“嗒”能出来）
DUCK = M.duck(tt, T0('touch'), 0.5, pre=(0.10, 0.01), post=(0.06, 0.25))

# ———————————————— 环境 amb ————————————————
amb = buf()
# 镜头 A (0–3 s)
a = A.city_hum(3.4, 11, fog=1.25) * 1.0 + A.water(3.4, 12, 'far') * 0.5 + A.wind(3.4, 13, 'far')[0] * 0.55
a = width(reverb(a, IR_RIVER, wet=0.12), 0.95)
a = at(a, 0.0) * window(0, CUT_AB)
a = level('amb_fog', a, 0.05, CUT_AB - 0.05)
amb += a * G('amb_fog')
ELEM['amb_fog'] = a

# 镜头 B (3–5 s)
bw, bgust = A.wind(2.4, 22, 'close')
b = A.city_hum(2.4, 21, fog=2.2) * 0.35 + bw * 0.85
b = at(width(b, 0.55), CUT_AB - 0.2) * window(CUT_AB, CUT_BC)
b = level('amb_close', b, CUT_AB + 0.05, CUT_BC - 0.05) * DUCK
amb += b * G('amb_close')
ELEM['amb_close'] = b

# 镜头 C (5–10 s)
c = A.city_hum(5.4, 31, fog=1.1) * 0.55 + A.water(5.4, 32, 'hull') * 0.32 + A.wind(5.4, 33, 'open')[0] * 0.62
c = width(reverb(c, IR_SKY, wet=0.10), 1.35)
c = at(c, CUT_BC - 0.2) * window(CUT_BC, CUT_CD, 0.025)
c = level('amb_open', c, CUT_BC + 0.05, CUT_CD - 0.05)
amb += c * G('amb_open')
ELEM['amb_open'] = c

ob = at(width(D.open_bloom(), 1.5), CUT_BC)
ob = (ob + reverb(ob, IR_SKY, wet=1.0, dry=0.0, cross=0.5) * 0.6) * window(CUT_BC, CUT_CD, 0.004)
ob = level('open_bloom', ob)
amb += ob * G('open')
ELEM['open_bloom'] = ob

# 镜头 D (10–15 s 离航)：船舷拍水 + 开阔江风，远处城市低鸣在 13.8 s 前彻底退净
d_est = CUT_DE - CUT_CD + 0.4
t_est = np.arange(N(d_est)) / SR
city_fade = (1 - smoothstep(0.0, 3.8, t_est))[:, None]
est = A.city_hum(d_est, 41, fog=1.4) * 0.22 * city_fade + A.water(d_est, 42, 'hull') * 0.45 + A.wind(d_est, 43, 'open')[0] * 0.60
est = width(reverb(est, IR_SKY, wet=0.10), 1.35)
est = at(est, CUT_CD - 0.2) * window(CUT_CD, CUT_DE, 0.025)
est = level('amb_estuary', est, CUT_CD + 0.05, CUT_DE - 0.05)
amb += est * G('amb_estuary')
ELEM['amb_estuary'] = est

# 镜头 E (15–19 s 关灯)：无城市底噪，只剩暗海船侧拍水与极轻夜风
d_dk = CUT_EF - CUT_DE + 0.4
dk = lp(A.water(d_dk, 51, 'hull'), 2400, 2) * 0.45 + lp(A.wind(d_dk, 52, 'far')[0], 850, 2) * 0.35
dk = width(dk, 0.85)
dk = at(dk, CUT_DE - 0.2) * window(CUT_DE, CUT_EF, 0.020)
dk = level('amb_dark', dk, CUT_DE + 0.05, CUT_EF - 0.05)
amb += dk * G('amb_dark')
ELEM['amb_dark'] = dk

# 镜头 F & G (19–30 s 化鹏 · 扶摇)：破晓打开 + 东海海面开阔环境 + 27.6 s 金色海风
do = at(width(D.open_bloom(seed=617, d=2.4), 1.5), T0('dawn_open'))
do = (do + reverb(do, IR_SKY, wet=1.0, dry=0.0, cross=0.5) * 0.65) * window(CUT_EF, DUR + 1, 0.015)
do = level('dawn_open', do)
amb += do * G('dawn_open')
ELEM['dawn_open'] = do

d_sea = DUR - CUT_EF + 0.4
sea = A.water(d_sea, 61, 'hull') * 0.34 + A.wind(d_sea, 62, 'open')[0] * 0.74
sea = width(reverb(sea, IR_SKY, wet=0.14), 1.45)
sea = at(sea, CUT_EF - 0.2) * window(CUT_EF, DUR + 1, 0.025)
sea = level('amb_sea', sea, CUT_EF + 0.05, DUR - 0.05)
amb += sea * G('amb_sea')
ELEM['amb_sea'] = sea

br = at(A.breeze(DUR - T0('breeze') + 0.05, 34), T0('breeze'))
br = level('breeze', br)
amb += br * G('breeze')
ELEM['breeze'] = br

# ———————————————— 音效 fx ————————————————
fx = buf()
# 0–10 s 音效保持原平衡
h = lp(hp(D.horn(), 90, 2), 2400, 2)
hx = at(stereo(h, P('horn')), T0('horn'))
h_wet = reverb(hx, IR_RIVER, wet=1.0, dry=0.0, cross=0.4)
h_ech = echoes(hx, [(0.42, -8, 0.55, 1500), (0.78, -12, -0.45, 1200), (1.25, -16, 0.35, 1000), (1.9, -21, -0.2, 800)], seed=51)
horn = (hx * 0.75 + h_wet * 0.62 + h_ech) * tail_after(CUT_AB, 0.35)
horn = level('horn', horn)
fx += horn * G('horn')
ELEM['horn'] = horn
ELEM['horn_dry'] = hx

near, far = D.pigeons()
pg = at(near, T0('pigeons')) + reverb(at(far, T0('pigeons')), IR_RIVER, wet=1.0, dry=0.0) * 0.5
pg = pg * tail_after(CUT_AB, 0.2)
pg = level('pigeons', pg)
fx += pg * G('pigeons')
ELEM['pigeons'] = pg

gx = at(stereo(D.kun_glimpse(), P('kun_glimpse')), T0('kun_glimpse'))
gx = (gx + reverb(gx, IR_RIVER, wet=1.0, dry=0.0) * 0.3) * window(0, CUT_AB)
gx = level('kun_glimpse', gx, 1.6, 2.9)
fx += gx * G('kun_glimpse')
ELEM['kun_glimpse'] = gx

hr = at(width(A.hair(2.4, 23, bgust), 0.7), CUT_AB - 0.2) * window(CUT_AB, CUT_BC)
hr = level('hair', hr, CUT_AB + 0.05, CUT_BC - 0.05)
hr = hr * DUCK
fx += hr * G('hair')
ELEM['hair'] = hr

sw = at(stereo(D.shadow_swell(d=CUT_BC - T0('shadow') + 0.02)), T0('shadow'))
sw = (sw + reverb(sw, IR_SMALL, wet=1.0, dry=0.0) * 0.3) * window(0, CUT_BC, 0.008)
sw = level('shadow', sw)
fx += sw * G('shadow')
ELEM['shadow'] = sw

t_pass = T0('kun_pass') - 0.10
ps, ppan, penv = D.kun_pass()
px = at(ps, t_pass)
px = (px + reverb(px, IR_SKY, wet=1.0, dry=0.0) * 0.35) * tail_after(CUT_CD, 0.35)
px = level('kun_pass', px)
fx += px * G('kun_pass')
ELEM['kun_pass'] = px

wd = at(D.seaweed(708, len(penv) / SR, penv, ppan), t_pass)
wd = (wd + reverb(wd, IR_SKY, wet=1.0, dry=0.0) * 0.3) * tail_after(CUT_CD, 0.35)
wd = level('seaweed', wd)
fx += wd * G('seaweed')
ELEM['seaweed'] = wd

# 10–15 s 离航：汽笛呼唤（10.8 s）
hr_rep = lp(hp(D.horn(seed=102), 85, 2), 3400, 2)
hrx = at(stereo(hr_rep, P('horn_reply', -0.25)), T0('horn_reply'))
hrx_wet = reverb(hrx, IR_SKY, wet=1.0, dry=0.0, cross=0.4)
hrx_ech = echoes(hrx, [(0.48, -11, 0.45, 1600), (1.05, -16, -0.4, 1200)], seed=55)
horn_reply = (hrx * 0.78 + hrx_wet * 0.55 + hrx_ech * 0.7) * tail_after(CUT_DE, 0.25)
horn_reply = level('horn_reply', horn_reply, 10.7, 13.5)
fx += horn_reply * G('horn_reply')
ELEM['horn_reply'] = horn_reply
ELEM['horn_reply_dry'] = hrx

# 15–19 s 关灯：电闸断电（15.25 s）+ 鲲肺深呼吸（17.2–19.0 s）
sw_dry = at(stereo(D.switch_off(seed=801), P('switch_off', 0.0)), T0('switch_off'))
sw_off = sw_dry + reverb(sw_dry, IR_SMALL, wet=0.22, dry=0.0)
sw_off = level('switch_off', sw_off, 15.1, 16.2)
fx += sw_off * G('switch_off')
ELEM['switch_off'] = sw_off
ELEM['switch_off_dry'] = sw_dry

kb = at(D.kun_breath(seed=802, d=1.8), T0('kun_breath'))
kb = (kb + reverb(kb, IR_KUN, wet=0.24, dry=0.0, hp_in=140.0)) * window(CUT_DE, CUT_EF + 0.12, 0.02)
kb = level('kun_breath', kb, 17.2, 19.0)
fx += kb * G('kun_breath')
ELEM['kun_breath'] = kb

# 19–30 s 化鹏 · 扶摇：巨翼振风（19.3–28.8 s）+ 扶摇掠空（24.8–27.8 s）+ 海鸟群（25.0 s）
wf = at(D.wing_flaps(seed=803, d=9.5, period=2.6), T0('wing_flaps'))
wf = wf + reverb(wf, IR_SKY, wet=0.36, dry=0.0, hp_in=120.0)
wf = level('wing_flaps', wf, 19.3, 28.8)
fx += wf * G('wing_flaps')
ELEM['wing_flaps'] = wf

t_soar = T0('soar_pass') - 0.10
ps2, ppan2, penv2 = D.kun_pass(seed=709, d=3.1)
px2 = at(ps2, t_soar)
px2 = px2 + reverb(px2, IR_SKY, wet=1.0, dry=0.0) * 0.40
px2 = level('soar_pass', px2, 24.5, 28.5)
fx += px2 * G('soar_pass')
ELEM['soar_pass'] = px2

wd2 = at(D.seaweed(710, len(penv2) / SR, penv2, ppan2), t_soar)
wd2 = wd2 + reverb(wd2, IR_SKY, wet=1.0, dry=0.0) * 0.35
wd2 = level('seaweed_soar', wd2, 24.5, 28.5)
fx += wd2 * G('soar_pass')
ELEM['seaweed_soar'] = wd2

sb_near, sb_far = D.pigeons(seed=304, n_birds=12, d=2.8, heading=0.60)
sb = at(sb_near, T0('sea_birds')) * 0.45 + reverb(at(sb_far, T0('sea_birds')), IR_SKY, wet=1.0, dry=0.0) * 0.85
sb = level('sea_birds', sb, 25.0, 28.2)
fx += sb * G('sea_birds')
ELEM['sea_birds'] = sb

# ———————————————— 鲲鸣 / 鲲鹏清鸣 kun ————————————————
# 1) 5.3 s 鲲鸣
kc = hp(D.kun_call(), 55, 2)
kx = at(stereo(kc), T0('kun_call'))
k_wet = reverb(kx, IR_KUN, wet=1.0, dry=0.0, cross=0.5, hp_in=160.0)
k_ech = echoes(kx, [(0.55, -11, 0.5, 1800), (1.1, -16, -0.5, 1400), (1.75, -21, 0.25, 1100)], seed=52)
kun_c = (kx * 0.85 + k_wet * 0.6 + hp(k_ech, 120, 2)) * tail_after(CUT_CD, 0.35)
kun_c = level('kun_call', kun_c, 5.2, 9.5)
ELEM['kun_call'] = kun_c
ELEM['kun_dry'] = kx

# 2) 11.6 s 鲲在江口应答
kr = hp(D.kun_call(seed=203), 55, 2)
krx = at(stereo(kr, P('kun_reply', 0.22)), T0('kun_reply'))
kr_wet = reverb(krx, IR_KUN, wet=1.0, dry=0.0, cross=0.5, hp_in=160.0)
kr_ech = echoes(krx, [(0.55, -12, -0.45, 1600), (1.15, -17, 0.4, 1200)], seed=56)
kun_r = (krx * 0.78 + kr_wet * 0.65 + hp(kr_ech, 120, 2) * 0.7) * tail_after(CUT_DE, 0.22)
kun_r = level('kun_reply', kun_r, 11.5, 14.8)
ELEM['kun_reply'] = kun_r
ELEM['kun_reply_dry'] = krx

# 3) 19.6 s 鲲鹏清鸣（D3→A3→F#3→D3，窄共振峰 700→2200 Hz）
kp = hp(D.kun_peng_call(seed=804), 75, 2)
kpx = at(stereo(kp, P('kun_peng_call', 0.0)), T0('kun_peng_call'))
kp_wet = reverb(kpx, IR_KUN, wet=1.0, dry=0.0, cross=0.5, hp_in=160.0)
kp_ech = echoes(kpx, [(0.55, -10, 0.55, 2400), (1.15, -15, -0.55, 1900), (1.85, -20, 0.30, 1400)], seed=57)
kun_p = kpx * 0.85 + kp_wet * 0.65 + hp(kp_ech, 140, 2)
kun_p = level('kun_peng_call', kun_p, 19.5, 24.5)
ELEM['kun_peng_call'] = kun_p
ELEM['kun_peng_dry'] = kpx

kun = kun_c * G('kun_call') + kun_r * G('kun_reply') + kun_p * G('kun_peng_call')

# ———————————————— 眼镜提示音 ui ————————————————
ui_b = buf()
tc = at(stereo(D.touch_click(), P('touch')), T0('touch'))
tc = level('touch', tc)
ui_b += tc * G('touch')
wp = at(stereo(D.ui_seq([(0, 1760.0, 0, 0.26)]), P('wake_ping')), T0('wake_ping'))
wp = level('wake_ping', wp)
ui_b += wp * G('wake_ping')
ui_b = reverb(ui_b, IR_SMALL, wet=0.25, hp_in=None)          # 第三人称：一点点空气

ui_c = buf()
for cid, notes, dd, octv in [
        ('ui_scan', [(0, 1318.5, -2, 0.18), (0.075, 1760.0, 0, 0.24)], 1.6, 0.0),
        ('ui_fail', [(0, 1760.0, 0, 0.20), (0.09, 1480.0, -1.5, 0.30)], 1.6, 0.0),
        ('ui_nav', [(0, 1174.7, -1, 0.30), (0.065, 1480.0, -1, 0.32), (0.13, 1760.0, 0, 0.45)], 2.2, 0.22),
        ('ui_route', [(0, 1174.7, -2, 0.24), (0.070, 1760.0, 0, 0.36)], 1.6, 0.18),
        ('ui_dark', [(0, 1480.0, -3, 0.16), (0.080, 1174.7, 0, 0.28)], 1.5, 0.0)]:
    x = at(stereo(D.ui_seq(notes, dd, octave=octv)), T0(cid))
    x = level(cid, x, T0(cid) - 0.1, T0(cid) + 1.5)
    ELEM[cid] = x
    ui_c += x * G(cid)
ui_c = ui_c + echoes(ui_c, [(0.003, -14, -0.3, 9000), (0.007, -17, 0.3, 8000)], seed=53, blur=0.002)   # 玻璃“机身”，仍是干声
ui = ui_b + ui_c
ELEM['touch'] = tc
ELEM['wake_ping'] = wp


# ———————————————— 配乐 music（基于 audio/score_cache.npz 延展编排） ————————————————
def _stretch_sustain(seg, target_len, xf_s=0.28, search_s=0.03, loop_seg=None):
    """相位对齐的等功率交叉淡化延展：无音高偏移、无相位抵消凹陷，保留 VSCO 弦乐厅堂质感。
    若提供 loop_seg，则首段 seg 原样播放到底，再反复用 loop_seg 做等功率交叉淡化接续，避免拼接跳变。"""
    if len(seg) >= target_len:
        return seg[:target_len].copy()
    lp_seg = seg if loop_seg is None else loop_seg
    xf = min(int(xf_s * SR), len(seg) // 3, len(lp_seg) // 3)
    search = min(int(search_s * SR), len(lp_seg) // 4)
    out = seg.copy()
    while len(out) < target_len:
        tail = out[-xf:]
        tail_m = tail.mean(1)
        t_norm = np.sqrt(np.sum(tail_m ** 2)) + 1e-12
        best_d, best_score = 0, -1e18
        for d in range(0, search, 4):
            cand = lp_seg[d:d + xf].mean(1)
            score = np.dot(tail_m, cand) / (t_norm * (np.sqrt(np.sum(cand ** 2)) + 1e-12))
            if score > best_score:
                best_score, best_d = score, d
        ang = np.linspace(0, np.pi / 2, xf)[:, None]
        out[-xf:] = out[-xf:] * np.cos(ang) + lp_seg[best_d:best_d + xf] * np.sin(ang)
        out = np.concatenate([out, lp_seg[best_d + xf:]])
    return out[:target_len]


def _place_xfade(dst, src, t0, xf_in=0.25, xf_out=0.25):
    """把 src 放到 dst 的 t0 秒处，并在首尾做等功率交叉淡化，避免接缝冲击"""
    s = N(t0)
    e = min(len(dst), s + len(src))
    seg = src[:e - s].copy()
    if xf_in > 0:
        k = min(len(seg), N(xf_in))
        seg[:k] *= np.sin(np.linspace(0, np.pi / 2, k))[:, None]
    if xf_out > 0:
        k = min(len(seg), N(xf_out))
        seg[-k:] *= np.cos(np.linspace(0, np.pi / 2, k))[:, None]
    dst[s:e] += seg


def build_score_30s(mus_10):
    """将 10 s 管弦缓存 score_cache.npz 延展编排为 30 s 全片配乐：
      · 0–5.0 s：静音
      · 5.0–8.55 s：保留原镜头 C 的 D(add9)→D6→G/D→C/D
      · 8.55–14.80 s：温和舒缓回落进镜头 D 离航（D6/D(add9) 弦乐延留），在 15.0 s 关灯前完全淡出
      · 14.85–19.00 s：严格静音（关灯段完全撤掉）
      · 19.00–26.98 s：镜头 F/G 破晓重新进入并延展递进（D(add9)→D6→G/D→C/D）
      · 26.98–27.95 s：原缓存 8.58–9.55 s 竖琴滑奏 + 27.40 s D 大三和弦顶点精确对齐「北冥」落笔
      · 27.80–30.00 s：弓奏颤音琴 A5/E6 + 高音小提琴 D6 空气感延展并融进天空混响余韵"""
    out = np.zeros((NT, 2))

    # —— 第一段：5.0–14.80 s（镜头 C 进 → 镜头 D 温和淡出）——
    seg_c = mus_10[N(4.90):N(8.60)].copy()
    _place_xfade(out, seg_c, 4.90, xf_in=0.02, xf_out=0.25)

    seg_gd = _stretch_sustain(mus_10[N(7.55):N(8.10)], N(1.50), xf_s=0.22)
    _place_xfade(out, seg_gd * 0.72, 8.35, xf_in=0.25, xf_out=0.35)

    seg_d6 = _stretch_sustain(mus_10[N(6.55):N(7.25)], N(2.40), xf_s=0.28)
    _place_xfade(out, seg_d6 * 0.62, 9.50, xf_in=0.35, xf_out=0.45)

    seg_d9 = _stretch_sustain(mus_10[N(5.45):N(6.25)], N(3.40), xf_s=0.28)
    _place_xfade(out, lp(seg_d9, 3000, 2) * 0.56, 11.45, xf_in=0.45, xf_out=0.10)

    # 镜头 C 柔和回落、镜头 D 渐隐至 14.80 s 完全静音
    env1 = (1.0 - 0.52 * smoothstep(8.6, 10.4, tt)) * (1.0 - smoothstep(12.2, 14.80, tt)) ** 1.4
    out[:N(14.90)] *= env1[:N(14.90), None]
    out[N(14.85):N(19.00)] = 0.0

    # —— 第二段：19.00–30.00 s（破晓重燃 → 27.40 s D 大三和弦顶点 → 空气收尾）——
    f1_d9 = _stretch_sustain(mus_10[N(4.95):N(6.25)], N(3.05), xf_s=0.28, loop_seg=mus_10[N(5.55):N(6.25)])
    _place_xfade(out, f1_d9, 19.00, xf_in=0.22, xf_out=0.32)

    f2_d6 = _stretch_sustain(mus_10[N(6.25):N(7.25)], N(2.65), xf_s=0.28, loop_seg=mus_10[N(6.55):N(7.25)])
    _place_xfade(out, f2_d6, 21.73, xf_in=0.32, xf_out=0.32)

    f3_gd = _stretch_sustain(mus_10[N(7.25):N(8.10)], N(2.15), xf_s=0.24, loop_seg=mus_10[N(7.55):N(8.10)])
    _place_xfade(out, f3_gd, 24.06, xf_in=0.32, xf_out=0.28)

    f4_cd = _stretch_sustain(mus_10[N(8.10):N(8.58)], N(1.23), xf_s=0.14, loop_seg=mus_10[N(8.28):N(8.58)])
    _place_xfade(out, f4_cd, 25.93, xf_in=0.28, xf_out=0.16)

    # 8.50–9.55 s 原音轨精确平移 +18.40 s → 9.00 s 顶点正好落在 27.40 s
    f5_apex = mus_10[N(8.50):N(9.55)].copy()
    _place_xfade(out, f5_apex, 26.90, xf_in=0.16, xf_out=0.18)

    # 9.45–9.98 s 弓奏颤音琴与高音小提琴空气尾音延展并送入天空混响
    f6_air = _stretch_sustain(mus_10[N(9.45):N(9.98)], N(2.15), xf_s=0.22)
    air_buf = np.zeros((NT, 2))
    _place_xfade(air_buf, f6_air, 27.78, xf_in=0.18, xf_out=0.20)
    air_decay = (1.0 - 0.65 * smoothstep(28.2, 29.8, tt))[:, None]
    air_buf = air_buf * air_decay * 0.78 + reverb(air_buf, IR_SKY, wet=1.0, dry=0.0, cross=0.45, hp_in=140.0) * 0.45
    out[N(27.70):] += air_buf[N(27.70):]

    out[:N(4.90)] = 0.0
    out[N(14.85):N(19.00)] = 0.0
    return out


if '--score' in sys.argv:
    import score  # noqa: E402
    mus_10, sections, _ = score.render(10.0)
    USED = sorted(score.USED)
else:
    _c = np.load(os.path.join(HERE, 'score_cache.npz'))
    mus_10, sections = _c['mus'].astype(float), {}
    USED = json.loads(str(_c['used']))

mus = build_score_30s(mus_10)
mus = level('music', mus, 27.3, 28.0)
ELEM['music'] = mus
mus = mus * G('apex')

harmony = [
    {'t': 5.0, 'chord': 'D(add9)', 'notes': ['D3', 'A3', 'E4', 'A4']},
    {'t': 6.4, 'chord': 'D6', 'notes': ['D3', 'B3', 'F#4', 'B4']},
    {'t': 7.4, 'chord': 'G/D', 'notes': ['D3', 'B3', 'G4', 'D5']},
    {'t': 8.2, 'chord': 'C/D', 'notes': ['D3', 'C4', 'G4', 'E5', '圆号 C4 E4 G4']},
    {'t': 9.0, 'chord': 'G/D→D6→D(add9)', 'notes': ['镜头 C 释放并渐隐入离航弦乐延留，14.85 s 前归零']},
    {'t': 15.0, 'chord': '静音', 'notes': ['关灯段配乐完全撤掉']},
    {'t': 19.0, 'chord': 'D(add9)', 'notes': ['D3', 'A3', 'E4', 'A4']},
    {'t': 21.8, 'chord': 'D6', 'notes': ['D3', 'B3', 'F#4', 'B4']},
    {'t': 24.1, 'chord': 'G/D', 'notes': ['D3', 'B3', 'G4', 'D5']},
    {'t': 26.0, 'chord': 'C/D', 'notes': ['D3', 'C4', 'G4', 'E5', '圆号 C4 E4 G4']},
    {'t': 26.98, 'chord': '竖琴滑奏', 'notes': ['D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6']},
    {'t': 27.4, 'chord': 'D', 'notes': ['D2', 'D3', 'A3', 'D4', 'F#4', 'A4', 'D5', 'F#5', 'A5', '圆号 D4 F#4 A4', '钟琴 A6 D7']},
    {'t': 29.2, 'chord': '空气感', 'notes': ['颤音琴(弓奏) A5 E6', '小提琴 D6 弱奏']},
]

# ———————————————— 母带 ————————————————
amb = lp(shelf(amb, 3500, -3.5, 'high'), 10000, 2)     # 环境声偏暖：对标画面的暖色
fx = lp(fx, 12000, 2)                                   # 合成噪声 12 kHz 以上只剩“嘶”，去掉
BUS = {'amb': amb, 'fx': fx, 'kun': kun, 'ui': ui, 'music': mus}
mix = sum(BUS.values())
mix = hp(mix, 28, 2)

# 低频约束：20–120 Hz 相对最强频段约 −3 dB（留 0.5 dB 余量给后面的限制器）
mix, LOW_SHELF = M.tame_low(mix, '20-120', ceil=-3.5, aim=-3.8, f=115, s=0.7)

mix, g_total, gr = M.loudness_to(mix, TGT_I, TGT_TP, look=0.005, rel=0.12)
mix = fade(mix, 0.006, 0.0)
mix *= (np.cos(np.pi / 2 * smoothstep(T0('end_fade'), DUR, tt)) ** 2)[:, None]
mix[-1] = 0.0
mix = mix[:NT].astype(np.float32)

assert mix.shape == (NT, 2) and np.isfinite(mix).all()
os.makedirs(os.path.join(ROOT, 'out'), exist_ok=True)
sf.write(os.path.join(ROOT, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')

# 分轨：乘上母带的电平（低频搁架 + 总增益），不过压缩和限制器；五轨相加 ≈ 成品
os.makedirs(os.path.join(HERE, 'stems'), exist_ok=True)
for k, v in BUS.items():
    s = hp(v, 28, 2)
    if LOW_SHELF:
        s = shelf(s, 115, LOW_SHELF, 'low', 0.7)
    s = s * undb(g_total) * (np.cos(np.pi / 2 * smoothstep(T0('end_fade'), DUR, tt)) ** 2)[:, None]
    sf.write(os.path.join(HERE, 'stems', f'{k}.wav'), s.astype(np.float32), SR, subtype='PCM_24')

# 署名
used = USED
lines = sampler.credits(used)
with open(os.path.join(HERE, 'CREDITS'), 'w', encoding='utf-8') as f:
    f.write('《北冥》30 秒概念短片 · 声音署名\n\n')
    f.write('Music samples / 配乐采样:\n')
    for ln in lines:
        f.write(ln + '\n')
    f.write('Instruments used / 用到的采样乐器: ' + ', '.join(used) + '\n\n')
    f.write('Sound effects / 音效：环境声、汽笛、鸽群、海鸟、触碰、开关断电、眼镜提示音、鲲鸣、鲲呼吸、鲲鹏清鸣、巨翼振风、鲲掠过、海草，'
            '全部为程序化合成（numpy/scipy，本项目 audio/design.py 与 engine/audio/），未使用任何外部录音素材。\n')


# 渲染记录（元素电平、起音时间核对、各声部在顶点的响度）
chk = {}
for cid, key in [
    ('horn_dry', 'horn'), ('pigeons', 'pigeons'), ('touch', 'touch'),
    ('wake_ping', 'wake_ping'), ('kun_dry', 'kun_call'),
    ('ui_scan', 'ui_scan'), ('ui_fail', 'ui_fail'), ('ui_nav', 'ui_nav'),
    ('ui_route', 'ui_route'), ('horn_reply_dry', 'horn_reply'), ('kun_reply_dry', 'kun_reply'),
    ('switch_off_dry', 'switch_off'), ('ui_dark', 'ui_dark'),
    ('kun_peng_dry', 'kun_peng_call'), ('sea_birds', 'sea_birds'),
]:
    o = onset(ELEM[cid], T0(key))
    chk[key] = {'cue_t': T0(key), 'onset_t': o, 'err_ms': None if o is None else round((o - T0(key)) * 1000, 1)}

sec_lufs = {}
for k, v in sections.items():
    if np.abs(v).max() > 0:
        sec_lufs[k] = round(momentary_max(v * undb(LEVELS['music']['gain_db'] + g_total), 8.9, 9.6), 1)

rep = {
    'out': os.path.join(ROOT, 'out', 'mix.wav'),
    'samples': int(len(mix)), 'seconds': len(mix) / SR,
    'integrated_lufs_internal': round(integrated(mix.astype(float)), 2),
    'true_peak_dbtp_internal': round(float(db(true_peak(mix.astype(float)))), 2),
    'master_gain_db': round(g_total, 2), 'low_shelf_db': round(LOW_SHELF, 2),
    'limiter_max_gr_db': round(float(-db(gr.min())), 2),
    'limiter_gr_over_1db_s': round(float((gr < undb(-1)).sum() / SR), 3),
    'limiter_gr_curve_db_50ms': {f'{i * 0.05:.2f}': round(float(-db(gr[N(i * 0.05):N(i * 0.05 + 0.05)].min())), 2)
                                 for i in range(int(DUR / 0.05)) if gr[N(i * 0.05):N(i * 0.05 + 0.05)].min() < undb(-0.3)},
    'band_rel_db': band_energy(mix.astype(float)),
    'levels': LEVELS, 'onsets': chk, 'music_sections_apex_lufs': sec_lufs, 'harmony': harmony,
    'render_seconds': round(time.time() - T_START, 1),
}
os.makedirs(os.path.join(HERE, 'check'), exist_ok=True)
json.dump(rep, open(os.path.join(HERE, 'check', 'render.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
np.savez_compressed(os.path.join(HERE, 'check', 'elements.npz'),
                    **{k: v.astype(np.float32) for k, v in ELEM.items()
                       if k in ('horn_dry', 'kun_dry', 'horn_reply_dry', 'kun_reply_dry', 'kun_peng_dry')})
print(json.dumps({k: rep[k] for k in ['samples', 'integrated_lufs_internal', 'true_peak_dbtp_internal', 'master_gain_db',
                                      'low_shelf_db', 'limiter_max_gr_db', 'limiter_gr_over_1db_s', 'band_rel_db',
                                      'music_sections_apex_lufs', 'render_seconds']}, ensure_ascii=False))
print(json.dumps({k: v['gain_db'] for k, v in LEVELS.items()}, ensure_ascii=False))
print(json.dumps(chk, ensure_ascii=False))
