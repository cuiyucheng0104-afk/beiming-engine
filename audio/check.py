# -*- coding: utf-8 -*-
"""《北冥》混音自检：ffmpeg 官方响度（ebur128）、成片响度（真的跑一遍 engine/render/mux.sh 再测）、
频段能量、音高与和声核对、切点无爆音、环境声空洞、单声道兼容、分轨峰值，并画图（全片总览 + 三段放大），结果写 audio/check/。

所有时间都从 audio/cues.json（镜头切点、各事件的 t）和 audio/check/render.json（配乐的和声表）推导，改了时间表照样量对地方。
判定分两级：problems（成片响度偏离 cues.json 的目标超过 ±0.3 LU、真峰值高于 −1.0 dBTP、文件格式不对、mux.sh 跑不通或跑不了）
会让本脚本以退出码 1 结束；warnings（loudnorm 测量偏差、环境声空洞、分轨超满幅、频段越界等）只记录和打印。

用法：python audio/check.py              旧口径：打印 report.json，problems 非空时退出码 1（--json 只在门禁模式下可用）
      python audio/check.py --strict     门禁模式（sh audio/build.sh / python audio/build.py 默认用它）：在 report.json 之外按附录 C8 写
                                         audio/check/qa.json（engine/audio/qa.py 的通用检查 + 本片的成片响度、提示音信噪比、音高、分轨），
                                         打印逐项结论；退出码按附录 C1：硬项不达标 4，缺 ffmpeg / 没有 out/mix.wav 3，其余 0
      --report <文件>                    C8 报告换个位置；--json 时 stdout 只输出一个信封（附录 C2）
门禁的门槛写在 audio/cues.json 的 qa 段（混音积分响度容差、提示音带内信噪比下限、音高容差）；混音目标仍是 target 段。
需要 ffmpeg（环境变量 FFMPEG / FFPROBE 可指定完整路径，同 tools/env）；成片响度这一项还要用 sh 跑 engine/render/mux.sh
（mux.sh 另外用到 ffprobe）。sh 按 BEIMING_SH → PATH 里的 sh →（Windows）Git for Windows 的 Git\\bin\\sh.exe 的顺序找
（engine/audio/_env.py，同 tools/env/lib/sh.mjs）；仓库里有 Node 版封装（engine/render/lib/mux.mjs 或 engine/render/mux.mjs，P04）时优先用
node 跑它，不需要 sh。找不到 sh、或 mux.sh
起不来、跑不通时，这一项记进 problems（门禁模式下：跑不了记为「未执行」的告警，跑了但不达标才算硬项失败），其余照常测完，报告照常写出。
音高与和弦核对用 librosa（可选依赖）：没装时报告里记「未执行」，不再把导入错误当成测量结果吞掉。
外部程序都有超时（按片长给），被 SIGTERM / Ctrl+C 打断时连同起的 ffmpeg、sh 一起结束、删掉临时目录，退出码 143 / 130。
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
from engine.audio import _cli  # noqa: E402
from engine.audio import _env as E  # noqa: E402

E.utf8_stdio()
E.exit_on_sigterm()


def _usage_exit(e):
    """用法错误：说明打到 stderr；带了 --json 时 stdout 照样只有一个信封（附录 C2）"""
    print(f'错误[{e.code}]：{e.message}' + (f'\n提示：{e.hint}' if e.hint else ''), file=sys.stderr)
    if '--json' in sys.argv[1:]:
        print(json.dumps(_cli.envelope('audio:check', e.exit_code, e), ensure_ascii=False, indent=2))
    sys.exit(e.exit_code)


# 参数先解析：--help 与用法错误在任何写盘之前就结束
_P = _cli.ArgumentParser(prog='python audio/check.py', description='《北冥》混音自检；--strict 是门禁模式（附录 C8 报告 + 附录 C1 退出码）。'
                         '--json 只在门禁模式下可用（旧口径打印的是整份报告，不是信封）')
_P.add_argument('--strict', action='store_true', help='门禁模式：写 audio/check/qa.json，硬项不达标退出码 4')
_P.add_argument('--report', help='门禁报告写到哪里（默认 audio/check/qa.json；给了就按门禁模式写）')
try:
    ARGS = _P.parse_args()
except _cli.CliError as _e:
    _usage_exit(_e)
GATE = ARGS.strict or bool(ARGS.report)
if ARGS.json and not GATE:
    _usage_exit(_cli.CliError('usage.json-needs-strict', '--json 只在门禁模式下可用：旧口径会把整份报告打到 stdout，不是附录 C2 的信封',
                              hint='加 --strict（或 --report <文件>）'))

OUT = os.path.join(ROOT, 'out', 'mix.wav')
MUX = os.path.join(ROOT, 'engine', 'render', 'mux.sh')
MUX_MJS = next((p for p in (os.path.join(ROOT, 'engine', 'render', 'lib', 'mux.mjs'), os.path.join(ROOT, 'engine', 'render', 'mux.mjs'))
                if os.path.exists(p)), None)        # P04 的 Node 版封装（同样的位置参数与退出码）；有它就优先用，不需要 sh
CK = os.path.join(HERE, 'check')
QA_REPORT = os.path.abspath(ARGS.report) if ARGS.report else os.path.join(CK, 'qa.json')
os.makedirs(CK, exist_ok=True)
for _old in (os.path.join(CK, 'report.json'), QA_REPORT if GATE else None):
    if _old and os.path.exists(_old):
        os.remove(_old)                              # 中途出错时不留上一次的报告冒充这一次
if not os.path.exists(OUT):
    print('[check] 没有 out/mix.wav：先跑 python audio/mix.py（或 sh audio/build.sh）', file=sys.stderr)
    sys.exit(3 if GATE else 1)
CUES = json.load(open(os.path.join(HERE, 'cues.json'), encoding='utf-8'))
RENDER = json.load(open(os.path.join(CK, 'render.json'), encoding='utf-8')) if os.path.exists(os.path.join(CK, 'render.json')) else {}
DUR = float(CUES['dur'])
FPS = int(CUES.get('fps', 24))
TMO = 120 + 6 * DUR                 # 外部程序（ffmpeg、mux.sh）的超时：10 秒片 3 分钟；卡住时按超时收场，不无限等
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
try:
    REP['ebur128'] = ebur128(OUT)
except (OSError, RuntimeError) as _e:      # OSError：PATH 里没有 ffmpeg；RuntimeError：ffmpeg 跑了但测不出
    if not GATE:
        raise
    print(f'[check] ffmpeg 测不了响度（{type(_e).__name__}）：{_e}\n[check] 下一步：装 FFmpeg ≥ 7（带 ebur128、loudnorm）并放进 PATH',
          file=sys.stderr)
    sys.exit(3)

# ———— 3. 成片响度：用真的 engine/render/mux.sh 把 mix.wav 和一段同长的黑画面封装一遍，再测成片 ————
#   mux.sh 怎么归一化（两遍 loudnorm、按 ebur128 算增益……）都以它自己为准，这里只看结果是不是落在目标上。
def _tail(t, n=6):
    return '\n'.join((t or '').strip().splitlines()[-n:])


def mux_probe():
    """真的跑一遍 mux.sh，返回探针成片的测量值。跑不了时返回 {'error': 原因}，由下面记进 problems（报告照常写出、退出码 1），
    不让异常把整个自检打断：没有 mux.sh、PATH 里没有 sh（例如在 Windows 的 PowerShell / cmd 里直接跑本脚本）、
    ffmpeg 或 sh 起不来（找不到、没有执行权限、格式不对）、临时目录建不了、探针成片测不出响度，都算这一类。"""
    # 返回里的 kind：env = 环境里缺东西（sh、mux.sh、进程起不来），run = 真的跑了但没跑通（门禁模式据此分「未执行」与「不达标」）
    sh, why = E.find_sh()
    node = shutil.which('node')
    if node and MUX_MJS:
        cmd = [node, MUX_MJS]          # Node 版封装（Windows 的 PowerShell / cmd 里也能跑）
    elif not os.path.exists(MUX):
        return {'error': f'找不到 {MUX}', 'kind': 'env'}
    elif sh is None:
        return {'error': f'找不到 sh（{why}）：这一项要用 sh 跑 engine/render/mux.sh。{E.sh_fix()}', 'kind': 'env'}
    else:
        cmd = [sh, MUX]
    td = None
    try:
        td = tempfile.mkdtemp(prefix='beiming-mux-')
        v, o = os.path.join(td, 'black.mp4'), os.path.join(td, 'probe.mp4')
        r = E.run([E.ffmpeg(), '-y', '-v', 'error', '-f', 'lavfi', '-i', f'color=c=black:s=64x36:r={FPS}:d={DUR}',
                   '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v], capture_output=True, encoding='utf-8', errors='replace', timeout=TMO)
        if r.returncode != 0:
            return {'error': f'生成探针画面失败：{_tail(r.stderr)}', 'kind': 'env'}
        r = E.run(cmd + [v, OUT, o, str(FPS), '0'], capture_output=True, encoding='utf-8', errors='replace', timeout=TMO)
        if r.returncode != 0 or not os.path.exists(o):
            return {'error': f'{os.path.basename(cmd[-1])} 退出码 {r.returncode}：{_tail(r.stderr or r.stdout)}', 'kind': 'run'}
        e = ebur128(o)
        pcm = E.run([E.ffmpeg(), '-v', 'error', '-i', o, '-vn', '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, timeout=TMO)
        a = np.frombuffer(pcm.stdout, dtype='<f4').astype(np.float64).reshape(-1, 2) if pcm.returncode == 0 else None
        res = {'I_LUFS': e['I_LUFS'], 'TP_dBTP': e['TP_dBTP'], 'LRA_LU': e['LRA_LU']}
        if a is not None and len(a):
            res['I_internal'] = round(integrated(a), 2)
            res['TP_internal'] = round(float(db(true_peak(a))), 2)
            res['seconds'] = round(len(a) / SR, 3)
        return res
    except (OSError, RuntimeError) as e:     # OSError：进程起不来、临时目录；RuntimeError：engine.audio.meter 测不出响度
        return {'error': f'mux.sh 探针跑不下去（{type(e).__name__}）：{e}', 'kind': 'env' if isinstance(e, OSError) else 'run'}
    except subprocess.TimeoutExpired as e:  # 卡住：已连同子进程一起结束
        name = 'mux' if MUX in e.cmd or (MUX_MJS and MUX_MJS in e.cmd) else os.path.basename(str(e.cmd[0]))
        return {'error': f'{name} 超过 {TMO:.0f} 秒没有结束（已连同子进程结束）', 'kind': 'run'}
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

# ———— 6. 音高与和声（librosa 是可选依赖：没装 → 未执行；装了但测量出错 → 记成错误，门禁模式下算不通过） ————
try:
    import librosa
    REP['pitch_status'] = 'ok'
except ImportError as e:
    librosa = None
    REP['pitch_status'] = 'not-run'
    REP['pitch_error'] = f'未执行：没有安装 librosa（可选依赖，pip install librosa 后重跑）：{e}'
try:
    if librosa is None:
        raise LookupError('skip')
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
except LookupError:
    pass                                    # librosa 没装：上面已记成「未执行」
except Exception as e:  # noqa: BLE001
    REP['pitch_status'] = 'error'
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

# ffmpeg 自己的频谱图作旁证（画不出来不影响判定）
try:
    E.run([E.ffmpeg(), '-y', '-v', 'error', '-i', OUT, '-lavfi',
           'showspectrumpic=s=1600x700:legend=1:scale=log:fscale=log:color=magma', os.path.join(CK, 'ffmpeg_spectrum.png')], timeout=TMO)
except (OSError, subprocess.TimeoutExpired) as _e:
    WARNINGS.append(f'ffmpeg 频谱图没画出来：{_e}')
REP['figures'] = figs + [os.path.join(CK, 'ffmpeg_spectrum.png')]

# 混音阶段（mix.py）记下的时间表告警也并进来
WARNINGS.extend(f'mix.py：{w}' for w in RENDER.get('warnings', []))
REP['problems'], REP['warnings'], REP['ok'] = PROBLEMS, WARNINGS, not PROBLEMS

_d = lambda o: o.item() if hasattr(o, 'item') else str(o)  # noqa: E731


def gate():
    """门禁模式：engine/audio/qa.py 的通用检查 + 本片专有的几项 → 附录 C8 报告；返回报告"""
    from engine.audio import qa as AQ
    QC = CUES.get('qa', {})
    tol, snr_min, pitch_tol = float(QC.get('mix_tol_lu', 0.5)), float(QC.get('ui_band_snr_min_db', 3.0)), float(QC.get('pitch_tol_cents', 50))
    frames = int(round(DUR * FPS))
    checks, _ = AQ.analyze(OUT, fps=FPS, frames=frames, cuts=[int(round(c * FPS)) for c in CUTS], target_lufs=TGT_I, tol_lu=tol,
                           max_tp=float(CUES['target']['true_peak_dbtp']))
    chk = AQ._chk
    want = f'{TGT_I:g} ± {TOL_I} LUFS、真峰值 ≤ {MAX_TP} dBTP'
    if 'error' in dl:
        env = dl.get('kind') == 'env'
        checks.append(chk('audio.deliverable', '成片响度（真的经 engine/render/mux.sh 封装再测）', 'warn' if env else 'fail',
                          ('未执行：' if env else '没跑通：') + dl['error'], want, {'notRun': env, 'kind': dl.get('kind')},
                          '封装探针跑不了（环境里缺东西）：成片响度改由 tools/qa 在最终文件上判' if env else '封装探针没跑通',
                          hint='在有 sh 的终端里跑（macOS / Linux；Windows 用 Git Bash 或 WSL）' if env else '看 audio/check/report.json 的 deliverable.error',
                          severity='soft' if env else 'hard'))
    else:
        i_meas = dl.get('I_internal', dl['I_LUFS'])
        checks.append(chk('audio.deliverable', '成片响度（真的经 engine/render/mux.sh 封装再测）', 'pass' if dl['ok'] else 'fail',
                          f'I {i_meas} LUFS · 真峰值 {dl["TP_dBTP"]} dBTP', want, {k: v for k, v in dl.items() if k != 'ok'},
                          '' if dl['ok'] else '；'.join(p for p in PROBLEMS if p.startswith('成片')),
                          hint=None if dl['ok'] else '成片响度不对多半是封装的归一化问题（engine/render/mux.sh），混音本身看 audio.loudness'))
    snr = REP.get('ui_band_snr_db')
    if snr is None:
        checks.append(chk('audio.ui-snr', '眼镜提示音带内信噪比', 'fail', f'未执行：{REP.get("ui_snr_error")}', f'每条 ≥ {snr_min:g} dB',
                          {'notRun': True}, '没有分轨 audio/stems/，量不了提示音会不会被盖住', hint='先跑 python audio/mix.py'))
    else:
        low = {k: v for k, v in snr.items() if v < snr_min}
        checks.append(chk('audio.ui-snr', '眼镜提示音带内信噪比', 'fail' if low else 'pass', ' · '.join(f'{k} {v} dB' for k, v in snr.items()),
                          f'每条 ≥ {snr_min:g} dB（audio/cues.json qa.ui_band_snr_min_db）', {'snrDb': snr, 'minDb': snr_min},
                          '' if not low else '提示音被盖住：' + '、'.join(low),
                          hint=None if not low else '给 ui 总线让路（mixing.duck）或抬提示音的 gain_db；改完看 audio/check/zoom_BC.png'))
    st = REP.get('pitch_status')
    if st == 'not-run':
        checks.append(chk('audio.pitch', '汽笛与鲲鸣的音高', 'warn', '未执行：没有安装 librosa（可选依赖）', f'偏差 ≤ {pitch_tol:g} 音分',
                          {'notRun': True}, REP.get('pitch_error', ''), hint='pip install librosa 后重跑', severity='soft'))
    elif st == 'error':
        checks.append(chk('audio.pitch', '汽笛与鲲鸣的音高', 'fail', f'测量出错：{REP.get("pitch_error")}', f'偏差 ≤ {pitch_tol:g} 音分', {},
                          '音高核对本身出错（不是没装 librosa）', hint='设 BEIMING_DEBUG=1 后单独跑 python audio/check.py 看完整报错'))
    else:
        off = {k: v['cents_off'] for k, v in REP.get('pitch', {}).items()}
        bad = {k: c for k, c in off.items() if c is None or abs(c) > pitch_tol}
        checks.append(chk('audio.pitch', '汽笛与鲲鸣的音高', 'warn' if bad else 'pass', ' · '.join(f'{k} {c:+}' if c is not None else f'{k} 测不出'
                          for k, c in off.items()), f'偏差 ≤ {pitch_tol:g} 音分', {'centsOff': off}, '' if not bad else '音高偏离设计值：' + '、'.join(bad),
                          hint='对照 audio/design.py 的 horn / kun_call 音高曲线' if bad else None, severity='soft'))
    sp = (REP.get('stems') or {}).get('peak_dbfs', {})
    sub = (REP.get('stems') or {}).get('subtype', {})
    over = {k: v for k, v in sp.items() if v >= -0.1}
    clipped = [k for k in over if sub.get(k) not in ('FLOAT', 'DOUBLE')]
    checks.append(chk('audio.stems', '分轨不削波', 'fail' if clipped else ('warn' if over else 'pass'),
                      ' · '.join(f'{k} {v:+.2f} dBFS' for k, v in sp.items()) or '没有分轨', '整数格式的分轨峰值 < −0.1 dBFS',
                      {'peakDbfs': sp, 'subtype': sub}, ('、'.join(clipped) + ' 是整数格式且顶到满幅：已经削波') if clipped else
                      ('、'.join(over) + ' 超过满幅（浮点存储没有削波，转整数前要先降电平）' if over else ''),
                      severity='hard' if clipped else 'soft'))
    gaps = REP.get('amb_gaps') or []
    checks.append(chk('audio.amb-gaps', '环境声没有空洞', 'warn' if gaps else 'pass', f'{len(gaps)} 段 50 ms 掉到 −60 dBFS 以下', '0 段',
                      {'gaps': gaps[:50]}, '环境声在镜头内断了' if gaps else '', hint='查镜头切点与环境声底层（audio/cues.json 的 shots）' if gaps else None,
                      severity='soft'))
    tw = RENDER.get('warnings', [])
    checks.append(chk('audio.timeline', '时间表自洽（mix.py 的告警）', 'warn' if tw else 'pass', f'{len(tw)} 条告警', '0 条', {'warnings': tw},
                      '；'.join(tw[:3]), severity='soft'))
    film = {'id': 'beiming-10s', 'title': '北冥', 'route': 'a', 'file': os.path.join(HERE, 'cues.json'), 'frameCount': frames}
    rep = AQ.build_report(checks, film=film, wav=OUT, profile_id='beiming-1040p24')
    AQ._write_json(QA_REPORT, rep)
    return rep


if GATE:
    QA = gate()
    REP['gate'] = {'report': QA_REPORT, 'ok': QA['ok'], 'hardFailures': QA['summary']['hardFailures']}
json.dump(REP, open(os.path.join(CK, 'report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=_d)
if not GATE:
    print(json.dumps(REP, ensure_ascii=False, indent=1, default=_d))
    if PROBLEMS:
        print('[check] 没通过：\n  ' + '\n  '.join(PROBLEMS), file=sys.stderr)
        sys.exit(1)
else:
    _rc = 0 if QA['ok'] else 4
    _rel = os.path.relpath(QA_REPORT, ROOT).replace(os.sep, '/') if not os.path.relpath(QA_REPORT, ROOT).startswith('..') else QA_REPORT
    if ARGS.json:
        _err = None if QA['ok'] else {'code': 'contract.audio-check', 'message': '声音门禁有硬项不达标：' + '、'.join(QA['summary']['hardFailures']),
                                     'hint': '逐项原因见 ' + _rel}
        print(json.dumps(_cli.envelope('audio:check', _rc, _err, [{'path': _rel, 'sha256': _cli.sha256_file(QA_REPORT), 'kind': 'qa-report'}],
                                       None, [], {'ok': QA['ok'], 'summary': QA['summary']}), ensure_ascii=False, indent=2))
    elif not ARGS.quiet:
        _mark = {'pass': '✓', 'warn': '!', 'fail': '✗', 'waived': '~'}
        for _c in QA['checks']:
            print(f"  {_mark[_c['status']]} {_c['id']:17} {_c['value']}" + (f"  —— {_c['message']}" if _c['message'] else ''))
        print('AUDIO CHECK ' + ('OK' if QA['ok'] else 'FAIL') + f'（门禁报告 {_rel}）')
    if not QA['ok']:
        print('[check] 门禁没通过：' + '、'.join(QA['summary']['hardFailures']), file=sys.stderr)
    sys.exit(_rc)
