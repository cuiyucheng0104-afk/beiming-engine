# -*- coding: utf-8 -*-
"""《北冥》10 秒概念样片：完整混音。

读 audio/cues.json（时间、声像、增益微调）→ 渲染五条总线（环境 amb / 音效 fx / 鲲鸣 kun / 眼镜提示音 ui / 配乐 music）
→ 每个元素按“目标响度”自动定电平（下面 TARGET 表，就是这部片的混音平衡）→ 空间处理 → 母带
（低频平衡、−14 LUFS、过采样真峰值限制、末尾 0.2 s 淡出）→ out/mix.wav。
另写：audio/stems/*.wav（五条总线，已乘母带电平、未过限制器，32 位浮点：超过满幅的部分原样保留，合成时可重配比）、
audio/CREDITS、audio/check/render.json。

时间全部从 cues.json 推导：镜头切点 = shots 的 t；三段环境声底层按各自镜头的长度（前后各多 0.2 s，末尾淡出）生成；
各元素的放置时刻、声像、定电平区间跟着对应 cue 的 t / t_end / pan 走。配乐例外：配乐的时间写在 audio/score.py
（cues.json 里 layer = music 的事件只是标注，apex 的 gain_db 是整条配乐的增益微调），这里会核对两边是否一致。
时间表前后矛盾（镜头首尾接不上、frame 与 t 对不上、配乐标注和 score.py 不一致）时在终端告警，并写进 render.json 的 warnings。

用法：python audio/mix.py            配乐读 audio/score_cache.npz（定稿配乐的渲染缓存）
      python audio/mix.py --score    用采样库重新渲染配乐（需要 BEIMING_SAMPLES，见 engine/audio/sampler.py；
                                     取样库：node tools/audio/fetch-samples.mjs），同时重写缓存与输入键
      python audio/mix.py --accept-stale-score   缓存与当前乐谱对不上时仍用旧配乐（记进 render.json 的 warnings）
配乐缓存的输入键在 audio/score_cache.lock.json（engine/audio/scorecache.py）：读缓存前先核对，乐谱源码改了、缓存文件被换了、
时长变了就以退出码 4 停下并说明下一步，不静默沿用旧配乐。现在这份缓存是冻结的定稿配乐（lock 的 frozen / note）。
确定性：所有随机都有固定种子，重跑结果逐样本一致。
"""
import os
import sys
import json
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [HERE, ROOT]          # 同目录的 design / score，仓库根下的 engine.audio

from engine.audio import _cli, _env  # noqa: E402

_env.utf8_stdio()                    # Windows 的 GBK 控制台与管道里打印中文不出错（只影响输出编码，不影响样本）
_env.exit_on_sigterm()               # 被 SIGTERM / Ctrl+C 时按附录 C1 以 143 / 130 退出（build.py 中断时会这样结束它）
# 参数先解析：--help 与拼错的参数在任何计算、写盘之前就结束（--help 退出 0，未知参数退出 2）
_P = _cli.ArgumentParser(prog='python audio/mix.py', add_globals=False,
                         description='《北冥》混音：读 audio/cues.json → out/mix.wav、audio/stems/、audio/check/render.json。'
                                     '一般经 node tools/audio/build.mjs（混音 + 门禁）调用。退出码：0 完成；2 用法；4 配乐缓存与输入不一致；1 运行失败')
_P.add_argument('--score', action='store_true', help='用采样库重渲配乐（需要 BEIMING_SAMPLES；取样：node tools/audio/fetch-samples.mjs），同时重写缓存与输入键')
_P.add_argument('--accept-stale-score', action='store_true', help='配乐缓存与当前乐谱对不上时仍用旧配乐（记进 render.json 的 warnings）')
try:
    ARGS = _P.parse_args()
except _cli.CliError as _e:
    print(f'错误[{_e.code}]：{_e.message}' + (f'\n提示：{_e.hint}' if _e.hint else ''), file=sys.stderr)
    sys.exit(_e.exit_code)

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from engine.audio.dsp import SR, N, smoothstep, undb, db, stereo, width, make_ir, reverb, echoes, hp, lp, shelf, fade  # noqa: E402
from engine.audio.meter import true_peak, integrated, momentary_max, band_energy, onset  # noqa: E402
from engine.audio import mixing as M, ambience as A, sampler  # noqa: E402
from engine.audio import scorecache as SC  # noqa: E402
import design as D  # noqa: E402
import score  # noqa: E402  只取配乐的时间表（CUE_TIMES / LEVEL_WIN）；--score 时才真的渲染

T_START = time.time()
CUES = json.load(open(os.path.join(HERE, 'cues.json'), encoding='utf-8'))
DUR = float(CUES['dur'])
NT = N(DUR)
C = {c['id']: c for c in CUES['cues']}
SH = {s['id']: s for s in CUES['shots']}
CUT_AB, CUT_BC = float(SH['B']['t']), float(SH['C']['t'])
TGT_I = float(CUES['target']['integrated_lufs'])
TGT_TP = float(CUES['target']['true_peak_dbtp'])
tt = np.arange(NT) / SR
SHOT_END = {'A': CUT_AB, 'B': CUT_BC, 'C': DUR}     # 镜头 X 到哪里结束（以下一个镜头的 t 为准）
WARN = []


def warn(msg):
    WARN.append(msg)
    print('[mix 告警]', msg, file=sys.stderr)


def check_timeline():
    """时间表自洽：镜头首尾相接、frame 与 t 一致、配乐标注与 score.py 一致（只告警，不改任何时间）"""
    if not 0.0 < CUT_AB < CUT_BC < DUR:
        raise ValueError(f'audio/cues.json 的镜头切点要满足 0 < B.t < C.t < dur：现在 B.t={CUT_AB}、C.t={CUT_BC}、dur={DUR}')
    if abs(float(SH['A']['t'])) > 1e-9:
        warn(f'镜头 A 的 t 是 {SH["A"]["t"]}，环境声和画面都从 0 s 开始，按 0 处理')
    for k, end in SHOT_END.items():
        te = SH[k].get('t_end')
        if te is not None and abs(float(te) - end) > 1e-6:
            warn(f'镜头 {k} 的 t_end={te} 与下一段的起点 {end} 不一致（混音以下一段的 t 为切点）')
    fps = float(CUES.get('fps', 24))
    for c in CUES['cues']:
        for tk, fk in (('t', 'frame'), ('t_end', 'frame_end')):
            if tk in c and fk in c and abs(float(c[fk]) - float(c[tk]) * fps) > 1e-3:
                warn(f'{c["id"]} 的 {fk}={c[fk]} 与 {tk}×{fps:g}={float(c[tk]) * fps:g} 不一致')
        if c.get('layer') == 'music':
            ref = score.CUE_TIMES.get(c['id'])
            if ref is None:
                warn(f'配乐标注 {c["id"]} 在 audio/score.py 的 CUE_TIMES 里没有对应项：它不会影响声音')
                continue
            for tk, rv in zip(('t', 't_end'), ref):
                if rv is not None and tk in c and abs(float(c[tk]) - rv) > 1e-6:
                    warn(f'配乐标注 {c["id"]}.{tk}={c[tk]}，但配乐里这一处在 {rv} s：配乐的时间要改 audio/score.py 再跑 --score，'
                         f'改 cues.json 不会挪动配乐')


check_timeline()

# 混音平衡：每个元素的目标（mom = 最大瞬时响度 LUFS；win = 区间积分响度 LUFS；peak = 采样峰值 dBFS）。
# 设计成母带增益约等于 0：片尾顶点最响（约 −9 LUFS 瞬时），鲲鸣次之，汽笛是镜头 A 的事件，环境声一直在底下。
TARGET = {
    'amb_fog': (-26.0, 'win'), 'horn': (-20.0, 'mom'), 'pigeons': (-22.5, 'mom'), 'kun_glimpse': (-35.0, 'win'),
    'amb_close': (-24.5, 'win'), 'hair': (-29.0, 'win'), 'touch': (-17.0, 'peak'), 'wake_ping': (-35.0, 'mom'),
    'shadow': (-21.5, 'mom'),
    'open_bloom': (-24.5, 'mom'), 'amb_open': (-31.0, 'win'), 'breeze': (-28.0, 'mom'),
    'kun_call': (-18.0, 'mom'), 'kun_pass': (-22.0, 'mom'), 'seaweed': (-30.0, 'mom'),
    'ui_scan': (-31.0, 'mom'), 'ui_fail': (-33.0, 'mom'), 'ui_nav': (-26.5, 'mom'),
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
    try:
        out, cur, g = M.match_level(st, target, how, t0, DUR if t1 is None else t1)
    except ValueError as e:
        raise ValueError(f'元素 {name} 定电平失败：{e}。检查 audio/cues.json 里它的 t / t_end 是否还落在所属镜头里、'
                         f'有没有被镜头切点整段切掉') from e
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
# 三段底层按镜头长度生成：切点前多 0.2 s（给 12 ms 交叉），镜头结束后多 0.2 s 再淡出（被镜头窗切掉，听不到也不会硬断）
BED_PAD = 0.2


def bed(shot):
    """镜头 shot 的环境声底层：(放置起点, 生成时长)"""
    t0 = 0.0 if shot == 'A' else float(SH[shot]['t'])
    return max(0.0, t0 - BED_PAD), (SHOT_END[shot] - t0) + 2 * BED_PAD


def bed_tail(x):
    """底层末尾 0.1 s 淡出（只落在镜头结束之后的余量里）"""
    return fade(x, 0.0, BED_PAD / 2)


amb = buf()
A_at, A_len = bed('A')
a = A.city_hum(A_len, 11, fog=1.25) * 1.0 + A.water(A_len, 12, 'far') * 0.5 + A.wind(A_len, 13, 'far')[0] * 0.55
a = bed_tail(width(reverb(a, IR_RIVER, wet=0.12), 0.95))
a = at(a, A_at) * window(0, CUT_AB)
a = level('amb_fog', a, A_at + 0.05, CUT_AB - 0.05)
amb += a * G('amb_fog')
ELEM['amb_fog'] = a

B_at, B_len = bed('B')
bw, bgust = A.wind(B_len, 22, 'close')
b = A.city_hum(B_len, 21, fog=2.2) * 0.35 + bw * 0.85
b = at(bed_tail(width(b, 0.55)), B_at) * window(CUT_AB, CUT_BC)
b = level('amb_close', b, CUT_AB + 0.05, CUT_BC - 0.05) * DUCK
amb += b * G('amb_close')
ELEM['amb_close'] = b

C_at, C_len = bed('C')
c = A.city_hum(C_len, 31, fog=1.1) * 0.55 + A.water(C_len, 32, 'hull') * 0.32 + A.wind(C_len, 33, 'open')[0] * 0.62
c = bed_tail(width(reverb(c, IR_SKY, wet=0.10), 1.35))
c = at(c, C_at) * window(CUT_BC, DUR + 1)
c = level('amb_open', c, CUT_BC + 0.05, DUR - 0.05)
amb += c * G('amb_open')
ELEM['amb_open'] = c

ob = at(width(D.open_bloom(), 1.5), CUT_BC)
ob = (ob + reverb(ob, IR_SKY, wet=1.0, dry=0.0, cross=0.5) * 0.6) * window(CUT_BC, DUR + 1, 0.004)
ob = level('open_bloom', ob)
amb += ob * G('open')
ELEM['open_bloom'] = ob

br = at(A.breeze(DUR - T0('breeze') + 0.05, 34), T0('breeze'))
br = level('breeze', br)
amb += br * G('breeze')
ELEM['breeze'] = br

# ———————————————— 音效 fx ————————————————
fx = buf()
# 汽笛：远处（江心）→ 空气/雾吸收高频 → 江面混响 + 对岸楼群回声
h = lp(hp(D.horn(), 90, 2), 2400, 2)
hx = at(stereo(h, P('horn')), T0('horn'))
h_wet = reverb(hx, IR_RIVER, wet=1.0, dry=0.0, cross=0.4)
h_ech = echoes(hx, [(0.42, -8, 0.55, 1500), (0.78, -12, -0.45, 1200), (1.25, -16, 0.35, 1000), (1.9, -21, -0.2, 800)], seed=51)
horn = (hx * 0.75 + h_wet * 0.62 + h_ech) * tail_after(CUT_AB, 0.35)
horn = level('horn', horn)
fx += horn * G('horn')
ELEM['horn'] = horn
ELEM['horn_dry'] = hx

# 鸽群：近处干、远处多送江面混响
near, far = D.pigeons(pan=P('pigeons', [0.0, 0.7]))
pg = at(near, T0('pigeons')) + reverb(at(far, T0('pigeons')), IR_RIVER, wet=1.0, dry=0.0) * 0.5
pg = pg * tail_after(CUT_AB, 0.2)
pg = level('pigeons', pg)
fx += pg * G('pigeons')
ELEM['pigeons'] = pg

# 鲲影：时长 = cue 的 t_end − t（不超过镜头 A）；定电平只量主体（跳过开头 0.45 s 的渐起和切点前最后 0.1 s）
GL0 = T0('kun_glimpse')
GL1 = min(float(C['kun_glimpse'].get('t_end', CUT_AB)), CUT_AB)
if GL1 - GL0 < 0.7:
    raise ValueError(f'元素 kun_glimpse 在镜头 A 里只剩 {GL1 - GL0:.2f} s（t={GL0}、t_end/切点={GL1}），太短没法定电平；'
                     f'把它的 t 往前挪，或者把 t_end 和镜头 B 的 t 一起往后挪')
gx = at(stereo(D.kun_glimpse(d=GL1 - GL0), P('kun_glimpse')), GL0)
gx = (gx + reverb(gx, IR_RIVER, wet=1.0, dry=0.0) * 0.3) * window(0, CUT_AB)
gx = level('kun_glimpse', gx, GL0 + 0.45 * (GL1 - GL0) / 1.85, GL1 - 0.1)
fx += gx * G('kun_glimpse')
ELEM['kun_glimpse'] = gx

hr = at(bed_tail(width(A.hair(B_len, 23, bgust), 0.7)), B_at) * window(CUT_AB, CUT_BC)
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
ps, ppan, penv = D.kun_pass(pan=P('kun_pass', [0.65, -0.65]))
px = at(ps, t_pass)
px = px + reverb(px, IR_SKY, wet=1.0, dry=0.0) * 0.35
px = level('kun_pass', px)
fx += px * G('kun_pass')
ELEM['kun_pass'] = px

wpan = D.pass_pan(np.arange(len(penv)) / SR, P('seaweed', P('kun_pass', [0.65, -0.65])))   # 海草跟着鲲走：默认与 kun_pass 同一条声像
wd = at(D.seaweed(708, len(penv) / SR, penv, wpan), t_pass)
wd = wd + reverb(wd, IR_SKY, wet=1.0, dry=0.0) * 0.3
wd = level('seaweed', wd)
fx += wd * G('seaweed')
ELEM['seaweed'] = wd

# ———————————————— 鲲鸣 kun ————————————————
kc = hp(D.kun_call(), 55, 2)
kx = at(stereo(kc), T0('kun_call'))
k_wet = reverb(kx, IR_KUN, wet=1.0, dry=0.0, cross=0.5, hp_in=160.0)
k_ech = echoes(kx, [(0.55, -11, 0.5, 1800), (1.1, -16, -0.5, 1400), (1.75, -21, 0.25, 1100)], seed=52)
kun = kx * 0.85 + k_wet * 0.6 + hp(k_ech, 120, 2)
kun = level('kun_call', kun)
ELEM['kun_call'] = kun
ELEM['kun_dry'] = kx
kun = kun * G('kun_call')

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
for cid, notes, dd in [
        ('ui_scan', [(0, 1318.5, -2, 0.18), (0.075, 1760.0, 0, 0.24)], 1.6),
        ('ui_fail', [(0, 1760.0, 0, 0.20), (0.09, 1480.0, -1.5, 0.30)], 1.6),
        ('ui_nav', [(0, 1174.7, -1, 0.30), (0.065, 1480.0, -1, 0.32), (0.13, 1760.0, 0, 0.45)], 2.2)]:
    x = at(stereo(D.ui_seq(notes, dd, octave=0.22 if cid == 'ui_nav' else 0.0)), T0(cid))
    x = level(cid, x)
    ELEM[cid] = x
    ui_c += x * G(cid)
ui_c = ui_c + echoes(ui_c, [(0.003, -14, -0.3, 9000), (0.007, -17, 0.3, 8000)], seed=53, blur=0.002)   # 玻璃“机身”，仍是干声
ui = ui_b + ui_c
ELEM['touch'] = tc
ELEM['wake_ping'] = wp

# ———————————————— 配乐 music ————————————————
# 缓存与输入键（engine/audio/scorecache.py）：--score 渲完写缓存 + 输入键；默认读缓存前核对输入键，对不上就停下（退出码 4）
CACHE, CACHE_LOCK = os.path.join(HERE, 'score_cache.npz'), os.path.join(HERE, 'score_cache.lock.json')
SCORE_CODE = ['audio/score.py', 'engine/audio/dsp.py', 'engine/audio/sampler.py', 'engine/audio/orchestra.py']   # score.render 用到的源码
SCORE_SEED = 2026                                                                                               # score.render 的默认种子
if ARGS.score:
    import score  # noqa: E402
    mus, sections, harmony = score.render(DUR)
    USED = sorted(score.USED)
    LIB = SC.scan_library(sampler.ROOT, USED)
    if not LIB['ok']:
        warn(f'采样库与 engine/audio/samples.json 的固定版本不符（{len(LIB["problems"])} 处，例：{"；".join(LIB["problems"][:3])}）：'
             f'这次渲出的配乐不保证别的机器能复现；取固定版本用 node tools/audio/fetch-samples.mjs')
    SC.save(CACHE, CACHE_LOCK, mus, harmony, USED, SC.inputs(ROOT, SCORE_CODE, DUR, SCORE_SEED, USED, LIB),
            note=None if LIB['ok'] else '采样库与固定版本不符：' + '；'.join(LIB['problems'][:20]))
    SCORE_CACHE = {'status': 'rendered', 'changed': [], 'frozen': False, 'library_ok': LIB['ok'], 'library_files': LIB['files'],
                   'message': '用采样库重渲了配乐，并重写了缓存与输入键'}
    mus = np.asarray(mus, dtype=np.float32).astype(float)    # 与缓存里存的那份（float32）相同：重渲当次与之后读缓存的混音逐样本一致
else:
    try:
        _m, harmony, USED, SCORE_CACHE = SC.load(
            CACHE, CACHE_LOCK, NT, lambda used: SC.inputs(ROOT, SCORE_CODE, DUR, SCORE_SEED, used),
            accept_stale=ARGS.accept_stale_score)
    except SC.StaleCache as e:
        print(f'[mix] 停下：{e.message}\n[mix] 下一步：{e.hint}', file=sys.stderr)
        sys.exit(e.exit_code)
    mus, sections = _m.astype(float), {}
    if SCORE_CACHE['status'] == 'stale-accepted':
        warn(f'按 --accept-stale-score 沿用了旧配乐：{SCORE_CACHE["message"]}')
mus = level('music', mus, *score.LEVEL_WIN)
ELEM['music'] = mus
mus = mus * G('apex')

# ———————————————— 母带 ————————————————
amb = lp(shelf(amb, 3500, -3.5, 'high'), 10000, 2)     # 环境声偏暖：对标画面的暖色（参考片 2–8 kHz 很低）
fx = lp(fx, 12000, 2)                                   # 合成噪声 12 kHz 以上只剩“嘶”，去掉
BUS = {'amb': amb, 'fx': fx, 'kun': kun, 'ui': ui, 'music': mus}
mix = sum(BUS.values())
mix = hp(mix, 28, 2)

# 低频约束：20–120 Hz 相对最强频段约 −3 dB（留 0.5 dB 余量给后面的限制器）
mix, LOW_SHELF = M.tame_low(mix, '20-120', ceil=-3.5, aim=-3.8, f=115, s=0.7)
# 不再加母带压缩：试过 thr −24 / 1.5:1 的“胶水”，在顶点会压掉约 3 dB，正好把要的动态对比吃掉；峰值只交给下面的前视限制器

mix, g_total, gr = M.loudness_to(mix, TGT_I, TGT_TP, look=0.005, rel=0.12)   # 先粗调到目标，再按“限制后”的实测响度迭代修正
mix = fade(mix, 0.006, 0.0)
mix *= (np.cos(np.pi / 2 * smoothstep(T0('end_fade'), DUR, tt)) ** 2)[:, None]
mix[-1] = 0.0
mix = mix[:NT].astype(np.float32)

if mix.shape != (NT, 2) or not np.isfinite(mix).all():
    bad = [k for k, v in BUS.items() if not np.isfinite(v).all()] + [k for k, v in ELEM.items() if not np.isfinite(v).all()]
    raise RuntimeError(f'母带结果异常：形状 {mix.shape}（应为 {(NT, 2)}），含 NaN/inf 的总线或元素：{bad or "无（问题出在母带处理）"}')
os.makedirs(os.path.join(ROOT, 'out'), exist_ok=True)
sf.write(os.path.join(ROOT, 'out', 'mix.wav'), mix, SR, subtype='PCM_24')

# 分轨：乘上母带的电平（低频搁架 + 总增益），不过限制器；五轨相加 ≈ 成品（限制前）。
# 32 位浮点写盘：顶点处配乐乘上母带增益后会超过满幅，整数 PCM 会把它削掉，浮点原样保留，重配比时不带进削波
os.makedirs(os.path.join(HERE, 'stems'), exist_ok=True)
STEM_PEAK = {}
for k, v in BUS.items():
    s = hp(v, 28, 2)
    if LOW_SHELF:
        s = shelf(s, 115, LOW_SHELF, 'low', 0.7)
    s = s * undb(g_total) * (np.cos(np.pi / 2 * smoothstep(T0('end_fade'), DUR, tt)) ** 2)[:, None]
    STEM_PEAK[k] = round(float(db(np.abs(s).max())), 2)
    sf.write(os.path.join(HERE, 'stems', f'{k}.wav'), s.astype(np.float32), SR, subtype='FLOAT')

# 署名
used = USED
lines = sampler.credits(used)
with open(os.path.join(HERE, 'CREDITS'), 'w', encoding='utf-8') as f:
    f.write('《北冥》10 秒概念样片 · 声音署名\n\n')
    f.write('Music samples / 配乐采样:\n')
    for ln in lines:
        f.write(ln + '\n')
    f.write('Instruments used / 用到的采样乐器: ' + ', '.join(used) + '\n\n')
    f.write('Sound effects / 音效：环境声、汽笛、鸽群、触碰、眼镜提示音、鲲鸣、鲲掠过、海草，全部为程序化合成'
            '（numpy/scipy，本项目 audio/design.py 与 engine/audio/），未使用任何外部录音素材。\n')


# 渲染记录（元素电平、起音时间核对、各声部在顶点的响度）
chk = {}
for cid in ['horn_dry', 'pigeons', 'touch', 'wake_ping', 'kun_dry', 'ui_scan', 'ui_fail', 'ui_nav']:
    key = {'horn_dry': 'horn', 'kun_dry': 'kun_call'}.get(cid, cid)
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
    'stems': {'subtype': 'FLOAT', 'peak_dbfs': STEM_PEAK},
    'timeline': {'dur': DUR, 'cuts': [CUT_AB, CUT_BC], 'beds': {'A': [A_at, A_len], 'B': [B_at, B_len], 'C': [C_at, C_len]},
                 'music_level_win': list(score.LEVEL_WIN)},
    'warnings': WARN,
    'score_cache': SCORE_CACHE,
    'render_seconds': round(time.time() - T_START, 1),
}
os.makedirs(os.path.join(HERE, 'check'), exist_ok=True)
json.dump(rep, open(os.path.join(HERE, 'check', 'render.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
np.savez_compressed(os.path.join(HERE, 'check', 'elements.npz'),
                    **{k: v.astype(np.float32) for k, v in ELEM.items() if k in ('horn_dry', 'kun_dry')})
print(json.dumps({k: rep[k] for k in ['samples', 'integrated_lufs_internal', 'true_peak_dbtp_internal', 'master_gain_db',
                                      'low_shelf_db', 'limiter_max_gr_db', 'limiter_gr_over_1db_s', 'band_rel_db',
                                      'music_sections_apex_lufs', 'render_seconds']}, ensure_ascii=False))
print(json.dumps({k: v['gain_db'] for k, v in LEVELS.items()}, ensure_ascii=False))
print(json.dumps(chk, ensure_ascii=False))
