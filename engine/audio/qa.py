# -*- coding: utf-8 -*-
"""北冥引擎 · 声音 QA 门：读 film.json（时长、帧率、镜头切点、混音目标、交付档位），对混音文件逐项判定，写附录 C8 的报告。

  python -m engine.audio.qa --film films/<名> [--wav <混音>] [--report <报告>] [--fail-on-warn] [--json]
  python -m engine.audio.qa --wav out/mix.wav --profile web-1080p24 [--frames 240 --fps 24]

检查项（id 前缀 audio.；hard = 不达标即失败，soft = 只告警，--fail-on-warn 时 soft 也算失败）：
  audio.format      hard  48 kHz、2 声道、样本全是有限数
  audio.length      hard  样本数 = frameCount / fps × 48000，差不超过 1 帧（截短、多出都算）
  audio.overload    hard  没有样本到满幅（|x| ≥ 0.99999；浮点文件超过 1.0 也算）
  audio.loudness    hard  BS.1770 积分响度 = 混音目标 ± 容差（目标：film.json audio.targetLUFS，否则档位的 integratedLUFS；
                          容差默认 0.5 LU，不宽于档位容差。成片以最终 AAC 为准由 tools/qa 复测）
  audio.truepeak    hard  4 倍过采样真峰值 ≤ audio.truePeakDbTP（否则档位的 truePeakMaxDbTP），测量容差 0.05 dB
                          （限制器正好压在上限时，24 bit 量化后的实测会高出万分之几 dB）
  audio.dc          hard > 0.01、soft > 0.001   每个声道的直流偏移
  audio.mono        hard 相关 < −0.3 或折单声道损失 < −8 LU；soft 相关 < 0 或损失 < −4 LU   单声道兼容
  audio.edges       hard > 0.05、soft > 0.003   首尾样本（不归零会在开始 / 结束时"咔"一声）
  audio.cuts        hard 比值 > 6 且跳变 > 0.02；soft 比值 > 3   镜头切点 ±1 ms 内的样本跳变，对比切点两侧 2–30 ms 的
                          99 分位样本差（点击声的判据；有交叉淡化的切点比值约 1）
  audio.bands       soft  20–120 Hz 相对最强频段 > −2 dB（低频糊）或 8 kHz 以上 > −10 dB（刺耳）
另报（不判）：响度范围 LRA、最大瞬时 / 短时响度、频段能量、声场相关、样本峰值。
整段按 10 秒一块读盘，十分钟级的混音内存也只占几十 MB（engine/audio/stream.py 的分块测量）。

退出码（附录 C1）：0 全部通过（可有告警）；2 用法错误；3 找不到混音或作品描述；4 有硬项不达标；1 运行失败。
报告：附录 C8 / tools/qa 的同一结构（schemaVersion 1、checks[{id, status, value, expected, evidence}]、ok），默认写在混音旁边
<混音名>.qa.json，--report 指定位置。
"""
import datetime
import os
import platform
import sys

import numpy as np

from ._cli import EXIT, ArgumentParser, CliError, run, sha256_file
from . import filmspec as F
from .dsp import SR, N
from .meter import BANDS
from .stream import Loudness, TruePeak

TOOL = {'name': 'beiming-audio-qa', 'version': '1.0.0'}
FS = 0.99999
TP_TOL_DB = 0.05
NFFT, HOP = 8192, 2048


class Analyzer:
    """一遍读完文件：响度（立体声与折单声道）、真峰值、直流、相关、首尾、满幅样本、频段能量、切点附近的样本"""

    def __init__(self, cuts_samples, sr=SR):
        self.sr = sr
        self.L, self.Lm, self.tp = Loudness(), Loudness(), TruePeak(4)
        self.n = 0
        self.s1 = np.zeros(2)
        self.s2 = np.zeros(2)
        self.slr = 0.0
        self.first = self.last = None
        self.full = 0
        self.over1 = 0
        self.nonfinite = 0
        self.sp = 0.0
        self.pw = np.zeros(NFFT // 2 + 1)
        self._spec_rest = np.zeros(0)
        self._win = np.hanning(NFFT)
        w = N(0.032)
        self.cuts = {c: [c - w, c + w, []] for c in cuts_samples}

    def feed(self, x):
        if not len(x):
            return
        bad = ~np.isfinite(x)
        if bad.any():
            self.nonfinite += int(bad.sum())
            x = np.where(bad, 0.0, x)
        a = np.abs(x)
        self.sp = max(self.sp, float(a.max()))
        self.full += int((a >= FS).any(axis=1).sum())
        self.over1 += int((a > 1.0).any(axis=1).sum())
        if self.first is None:
            self.first = float(a[0].max())
        self.last = float(a[-1].max())
        self.L.feed(x)
        mono = x.mean(axis=1)
        self.Lm.feed(np.stack([mono, mono], 1))
        self.tp.feed(x)
        self.s1 += x.sum(axis=0)
        self.s2 += (x ** 2).sum(axis=0)
        self.slr += float((x[:, 0] * x[:, 1]).sum())
        # 频段：与 meter.band_energy 同一取帧（声道平均、汉宁窗、8192 点、步长 2048）
        buf = np.concatenate([self._spec_rest, mono])
        k = (len(buf) - NFFT) // HOP + 1 if len(buf) >= NFFT else 0
        if k > 0:
            fr = np.lib.stride_tricks.sliding_window_view(buf, NFFT)[::HOP][:k] * self._win
            self.pw += (np.abs(np.fft.rfft(fr, axis=1)) ** 2).sum(0)
        self._spec_rest = buf[k * HOP:]
        # 切点附近的样本
        a0, b0 = self.n, self.n + len(x)
        for c, (lo, hi, parts) in self.cuts.items():
            s, e = max(lo, a0), min(hi, b0)
            if e > s:
                parts.append(x[s - a0:e - a0])
        self.n = b0

    def finish(self):
        self.tp.finish()


def _bands(pw):
    f = np.fft.rfftfreq(NFFT, 1 / SR)
    e = {k: 10 * np.log10(pw[(f >= lo) & (f < hi)].sum() + 1e-20) for k, (lo, hi) in BANDS.items()}
    top = max(e.values())
    return {k: round(v - top, 2) for k, v in e.items()}


def _cut_ratio(seg, c_off):
    """seg 是切点前后 32 ms 的样本，c_off 是切点在 seg 里的下标 → (比值, ±1 ms 内的最大样本差)"""
    if len(seg) < 4:
        return None, None
    d = np.abs(np.diff(seg, axis=0)).max(axis=1)
    m1, m2 = N(0.001), N(0.002)
    near = d[max(0, c_off - m1):c_off + m1]
    left, right = d[:max(0, c_off - m2)], d[c_off + m2:]
    refs = [float(np.percentile(r, 99)) for r in (left, right) if len(r) > 16]
    if not len(near) or not refs:
        return None, None
    jump = float(near.max())
    return round(jump / (max(refs) + 1e-9), 2), round(jump, 4)


def _chk(id_, title, status, value, expected, evidence=None, message='', hint=None, severity='hard'):
    c = {'id': id_, 'group': 'audio', 'title': title, 'severity': severity, 'status': status, 'value': value,
         'expected': expected, 'evidence': evidence or {}, 'message': message}
    if hint:
        c['hint'] = hint
    return c


def _grade(value, soft_bad, hard_bad):
    return 'fail' if hard_bad else ('warn' if soft_bad else 'pass')


def analyze(wav, *, fps=None, frames=None, cuts=(), target_lufs=-14.0, tol_lu=0.5, max_tp=-1.0, chunk_s=10.0):
    """→ (checks, info)。cuts 是切点帧号。"""
    import soundfile as sf
    info = sf.info(wav)
    checks = []
    fmt_ok = info.samplerate == SR and info.channels == 2
    if info.channels not in (1, 2):
        raise CliError('contract.audio-channels', f'{wav} 是 {info.channels} 声道：只支持单声道和立体声的分析', hint='交付要立体声 48 kHz')
    cut_samples = [int(round(c / fps * info.samplerate)) for c in cuts] if fps else []
    A = Analyzer(cut_samples, info.samplerate)
    for blk in sf.blocks(wav, blocksize=N(chunk_s), dtype='float64', always_2d=True):
        if blk.shape[1] == 1:
            blk = np.repeat(blk, 2, axis=1)
        A.feed(blk)
    A.finish()

    checks.append(_chk('audio.format', '格式：48 kHz 立体声、全是有限数', 'pass' if fmt_ok and not A.nonfinite else 'fail',
                       f'{info.samplerate} Hz · {info.channels} 声道 · {info.subtype}' + (f' · {A.nonfinite} 个 NaN/inf' if A.nonfinite else ''),
                       '48000 Hz · 2 声道 · 没有 NaN/inf', {'sampleRate': info.samplerate, 'channels': info.channels, 'subtype': info.subtype,
                                                         'nonFinite': A.nonfinite},
                       '' if fmt_ok else '交付要 48 kHz 立体声：单声道会被当成两边相同、采样率不对会被重采样',
                       hint=None if fmt_ok else '在声音脚本里按 engine.audio.dsp.SR（48000）合成，写 (样本数, 2) 的数组'))

    if frames and fps:
        want = int(round(frames / fps * info.samplerate))
        diff = A.n - want
        tol = int(round(info.samplerate / fps))
        checks.append(_chk('audio.length', '长度 = 画面帧数 / fps', 'pass' if abs(diff) <= tol else 'fail',
                           f'{A.n} 个样本（{A.n / info.samplerate:.3f} 秒，差 {diff:+d}）', f'{want} 个样本 ±{tol}（1 帧）',
                           {'samples': A.n, 'expected': want, 'diffSamples': diff, 'diffFrames': round(diff / tol, 2)},
                           '' if abs(diff) <= tol else ('混音比画面短：结尾会补静音或被截断' if diff < 0 else '混音比画面长：结尾会被截掉'),
                           hint=None if abs(diff) <= tol else '声音脚本的时长读 film.json（frameCount / fps）或环境变量 BEIMING_DUR，别写死'))

    overs = A.full
    checks.append(_chk('audio.overload', '没有满幅样本（削波 / 过载）', 'fail' if overs else 'pass',
                       f'{overs} 个样本到满幅' + (f'（{A.over1} 个超过 1.0）' if A.over1 else ''), '0 个',
                       {'fullScaleSamples': overs, 'overOne': A.over1, 'samplePeak': round(A.sp, 6)},
                       '混音里有样本顶到满幅：整数格式已经削波，浮点格式封装时会削波' if overs else '',
                       hint='母带用 engine.audio.mixing.loudness_to / stream.loudness_to 收口（总增益 + 前视真峰值限制）' if overs else None))

    I = A.L.integrated()
    li = {'integrated': None if not np.isfinite(I) else round(I, 2), 'momentaryMax': round(A.L.momentary_max(), 2),
          'shortTermMax': round(A.L.short_term_max(), 2), 'lra': round(A.L.lra(), 2)}
    if not np.isfinite(I) or I <= -70:
        checks.append(_chk('audio.loudness', '积分响度', 'fail', '静音（没有块高于 −70 LUFS）', f'{target_lufs:g} ± {tol_lu:g} LUFS', li,
                           '混音是静音', hint='检查声音脚本有没有写进东西，或 film.json 的 audio.mode 应为 none'))
    else:
        ok = abs(I - target_lufs) <= tol_lu + 1e-9
        checks.append(_chk('audio.loudness', '积分响度（BS.1770）', 'pass' if ok else 'fail', f'{I:.2f} LUFS', f'{target_lufs:g} ± {tol_lu:g} LUFS', li,
                           '' if ok else f'积分响度 {I:.2f} LUFS，离目标 {target_lufs:g} 差 {I - target_lufs:+.2f} LU',
                           hint=None if ok else '在声音脚本末尾按 film.json 的 audio.targetLUFS / truePeakDbTP 收口（mixing.loudness_to；长片 stream.loudness_to），'
                                                '别指望封装时再归一化'))
    tpd = float(20 * np.log10(A.tp.value)) if A.tp.value > 0 else -np.inf
    ok = tpd <= max_tp + TP_TOL_DB
    checks.append(_chk('audio.truepeak', '真峰值（4 倍过采样）', 'pass' if ok else 'fail', f'{tpd:.2f} dBTP', f'≤ {max_tp:g} dBTP（测量容差 {TP_TOL_DB} dB）',
                       {'truePeakDbTP': round(tpd, 4), 'samplePeak': round(A.sp, 6), 'toleranceDb': TP_TOL_DB},
                       '' if ok else f'真峰值 {tpd:.2f} dBTP 高于上限 {max_tp:g}：AAC 编码后会过载失真',
                       hint=None if ok else '母带限制器的上限设到 audio.truePeakDbTP 以下（loudness_to 的 tp 参数）'))

    n = max(A.n, 1)
    dc = (A.s1 / n).tolist()
    worst = max(abs(v) for v in dc)
    checks.append(_chk('audio.dc', '直流偏移', _grade(worst, worst > 1e-3, worst > 1e-2), f'{worst:.2e}', '≤ 1e-3（> 1e-2 不通过）',
                       {'dc': [round(v, 7) for v in dc]}, '' if worst <= 1e-3 else '有直流偏移：浪费余量，剪接处会咔嗒',
                       hint=None if worst <= 1e-3 else '母带前过 20–30 Hz 高通（engine.audio.dsp.hp）'))

    var = A.s2 / n - (A.s1 / n) ** 2
    cov = A.slr / n - (A.s1[0] / n) * (A.s1[1] / n)
    corr = float(cov / np.sqrt(max(var[0] * var[1], 1e-30))) if var.min() > 1e-20 else 1.0
    Im = A.Lm.integrated()
    loss = (Im - I) if np.isfinite(I) and np.isfinite(Im) else (-np.inf if np.isfinite(I) else 0.0)
    checks.append(_chk('audio.mono', '单声道兼容', _grade(None, corr < 0 or loss < -4, corr < -0.3 or loss < -8),
                       f'相关 {corr:.2f} · 折单声道 {loss:+.2f} LU', '相关 ≥ 0、损失 ≥ −4 LU（相关 < −0.3 或损失 < −8 LU 不通过）',
                       {'lrCorrelation': round(corr, 3), 'monoMinusStereoLU': round(loss, 2) if np.isfinite(loss) else None},
                       '' if corr >= 0 and loss >= -4 else '左右有明显反相：手机外放、单声道音箱上会抵消',
                       hint=None if corr >= 0 and loss >= -4 else '查加宽（dsp.width > 1.5）、反相的去相关噪声、左右相减的效果'))

    e = max(A.first or 0.0, A.last or 0.0)
    checks.append(_chk('audio.edges', '首尾样本归零', _grade(e, e > 0.003, e > 0.05), f'首 {A.first:.4f} · 尾 {A.last:.4f}', '≤ 0.003（> 0.05 不通过）',
                       {'first': A.first, 'last': A.last}, '' if e <= 0.003 else '开头或结尾没有归零：播放开始 / 结束时会咔一声',
                       hint=None if e <= 0.003 else '首尾各做几毫秒淡入淡出（engine.audio.dsp.fade），最后一个样本置 0'))

    rows, worst_st = [], 'pass'
    for c, (lo, hi, parts) in A.cuts.items():
        seg = np.concatenate(parts) if parts else np.zeros((0, 2))
        ratio, jump = _cut_ratio(seg, c - max(lo, 0))
        st = 'pass' if ratio is None else _grade(ratio, ratio > 3, ratio > 6 and jump > 0.02)
        rows.append({'frame': int(round(c / info.samplerate * fps)) if fps else None, 'seconds': round(c / info.samplerate, 4),
                     'ratio': ratio, 'jump': jump, 'status': st})
        worst_st = 'fail' if 'fail' in (worst_st, st) else ('warn' if 'warn' in (worst_st, st) else 'pass')
    if cut_samples:
        bad = [r for r in rows if r['status'] != 'pass']
        checks.append(_chk('audio.cuts', '切点没有爆音', worst_st,
                           '、'.join(f'第 {r["frame"]} 帧 {r["ratio"]}' for r in rows), '比值 ≤ 3（> 6 且跳变 > 0.02 不通过）', {'cuts': rows},
                           '' if not bad else '切点处有样本跳变（点击声）：' + '、'.join(f'第 {r["frame"]} 帧' for r in bad),
                           hint=None if not bad else '切点处做 5–12 ms 的等功率交叉（engine.audio.mixing.window 的 xf）', severity='hard'))

    be = _bands(A.pw) if A.pw.any() else None
    if be:
        lo_bad, hi_bad = be['20-120'] > -2.0, be['8k+'] > -10.0
        checks.append(_chk('audio.bands', '频段平衡（风格相关，只告警）', 'warn' if lo_bad or hi_bad else 'pass',
                           f'20–120 Hz {be["20-120"]} dB · 8 kHz+ {be["8k+"]} dB（相对最强频段）', '20–120 Hz ≤ −2 dB、8 kHz+ ≤ −10 dB', {'bandRelDb': be},
                           ('低频压过了中频，小音箱上会糊；' if lo_bad else '') + ('高频偏多，听感刺耳' if hi_bad else ''),
                           hint='用 engine.audio.mixing.tame_low 压低频，或给亮的总线加高搁架' if lo_bad or hi_bad else None, severity='soft'))
    for c in checks:
        if c['id'] in ('audio.dc', 'audio.mono', 'audio.edges') and c['status'] == 'warn':
            c['severity'] = 'soft'
    return checks, {'samples': A.n, 'seconds': A.n / info.samplerate, 'subtype': info.subtype}


def _env():
    out = {'python': platform.python_version(), 'platform': f'{platform.system()}-{platform.machine()}', 'numpy': np.__version__}
    for m in ('scipy', 'soundfile'):
        try:
            out[m] = __import__(m).__version__
        except Exception:
            out[m] = None
    return out


def _rel(p):
    try:
        r = os.path.relpath(p, F.ROOT)
        return p if r.startswith('..') else r.replace(os.sep, '/')
    except ValueError:      # Windows 上跨盘符
        return p


def build_report(checks, *, film=None, wav=None, profile_id=None, fail_on_warn=False):
    if fail_on_warn:
        for c in checks:
            if c['status'] == 'warn':
                c['status'], c['message'] = 'fail', (c['message'] + '（--fail-on-warn：告警算不通过）').strip()
    ok = not any(c['status'] == 'fail' for c in checks)
    cnt = {s: sum(1 for c in checks if c['status'] == s) for s in ('pass', 'fail', 'warn', 'waived')}
    return {
        'schemaVersion': 1, 'tool': TOOL,
        'film': {'id': film['id'], 'title': film['title'], 'route': film['route'], 'file': _rel(film['file']), 'frameCount': film['frameCount']} if film else None,
        'input': {'path': _rel(wav), 'sha256': sha256_file(wav), 'bytes': os.path.getsize(wav)} if wav else None,
        'profile': {'id': profile_id, 'source': 'engine/production/profiles.json' if os.path.exists(F.PROFILES) else '决策 D07 兜底表（engine/audio/filmspec.py）'},
        'groups': ['audio'], 'skipped': [], 'checks': checks,
        'summary': dict(cnt, hardFailures=[c['id'] for c in checks if c['status'] == 'fail']),
        'ok': ok, 'verdict': '声音机器检查通过（代理检查通过，不等于人工认可）' if ok else '声音机器检查不通过',
        'failOnWarn': fail_on_warn, 'warnings': [], 'env': _env(),
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
    }


def find_wav(film):
    a = film['audio'] or {}
    cands = []
    if a.get('mode') == 'wav' and a.get('wav'):
        cands.append(F.resolve(film, a['wav']))
    latest = os.path.join(film['filmDir'], 'out', 'latest')
    if os.path.isfile(latest):
        with open(latest, encoding='utf-8') as f:
            rid = f.read().strip()
        if rid:
            cands.append(os.path.join(film['filmDir'], 'out', rid, 'audio', 'mix.wav'))
    cands += [os.path.join(film['filmDir'], 'out', 'mix.wav'), os.path.join(film['dir'], 'out', 'mix.wav'),
              os.path.join(film['filmDir'], 'media', 'mix.wav')]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def _write_json(path, obj):
    import json
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
    os.replace(tmp, path)


def make_parser():
    p = ArgumentParser(prog='python -m engine.audio.qa', description='声音 QA 门：按 film.json 与交付档位逐项判定混音，写附录 C8 的报告。'
                       '退出码：0 通过；2 用法；3 找不到输入；4 有硬项不达标；1 运行失败。')
    p.add_argument('--film', help='作品目录或 film.json（给出时长、帧率、镜头切点、混音目标与档位）')
    p.add_argument('--wav', help='要查的混音（默认按作品找：audio.wav、out/latest 指向的运行目录、out/mix.wav、media/mix.wav）')
    p.add_argument('--profile', help='交付档位（默认 film.json 的 output.profile，再缺省 web-1080p24）')
    p.add_argument('--frames', type=int, help='画面帧数（没有 film.json 时用来查长度）')
    p.add_argument('--fps', type=int, help='帧率（与 --frames 一起用）')
    p.add_argument('--target-lufs', type=float, help='混音目标积分响度（默认 film.json audio.targetLUFS，再缺省档位）')
    p.add_argument('--tol-lu', type=float, default=0.5, help='积分响度容差（默认 0.5 LU，不会宽于档位）')
    p.add_argument('--max-tp', type=float, help='真峰值上限 dBTP（默认 film.json audio.truePeakDbTP，再缺省档位）')
    p.add_argument('--report', help='报告写到哪里（默认混音旁边的 <名>.qa.json）')
    p.add_argument('--no-report', action='store_true', help='不写报告文件（只打印 / --json）')
    p.add_argument('--fail-on-warn', action='store_true', help='告警也算不通过')
    return p


def main(args, ctx):
    if not args.film and not args.wav:
        raise CliError('usage.missing-input', '要给 --film 或 --wav', hint='例：python -m engine.audio.qa --film films/demo')
    if (args.frames is None) != (args.fps is None):
        raise CliError('usage.frames-fps', '--frames 和 --fps 要一起给')
    film = None
    try:
        film = F.load(args.film) if args.film else None
        prof = F.profile(args.profile or (film and film['profile']))
    except F.FilmSpecError as e:
        raise CliError(e.code, e.message, hint=e.hint) from None
    wav = os.path.abspath(args.wav) if args.wav else find_wav(film)
    if not wav or not os.path.exists(wav):
        raise CliError('env.mix-missing', f'找不到混音：{args.wav or "（按作品找了 audio.wav、out/latest、out/mix.wav、media/mix.wav）"}',
                       hint='先出声音（node tools/film/cli.mjs build <作品> --to mix，或跑作品的声音脚本），或用 --wav 指定')
    pa = prof['audio']
    fa = (film or {}).get('audio') or {}
    target = args.target_lufs if args.target_lufs is not None else fa.get('targetLUFS', pa['loudness']['integratedLUFS'])
    tol = min(args.tol_lu, float(pa['loudness'].get('toleranceLU', args.tol_lu)))
    max_tp = args.max_tp if args.max_tp is not None else fa.get('truePeakDbTP', pa['truePeakMaxDbTP'])
    fps = film['fps'] if film else args.fps
    frames = film['frameCount'] if film else args.frames
    ctx.log(f'声音 QA：{_rel(wav)}（档位 {prof["id"]}，目标 {target:g} ± {tol:g} LUFS、真峰值 ≤ {max_tp:g} dBTP）')
    checks, _ = analyze(wav, fps=fps, frames=frames, cuts=film['cuts'] if film else (), target_lufs=float(target), tol_lu=tol, max_tp=float(max_tp))
    rep = build_report(checks, film=film, wav=wav, profile_id=prof['id'], fail_on_warn=args.fail_on_warn)
    outputs = []
    if not args.no_report:
        rp = os.path.abspath(args.report) if args.report else os.path.splitext(wav)[0] + '.qa.json'
        _write_json(rp, rep)
        outputs.append({'path': _rel(rp), 'sha256': sha256_file(rp), 'kind': 'qa-report'})
    mark = {'pass': '✓', 'warn': '!', 'fail': '✗', 'waived': '~'}
    for c in checks:
        ctx.out(f"  {mark[c['status']]} {c['id']:15} {c['value']}" + (f"  —— {c['message']}" if c['message'] else ''))
    ctx.out('AUDIO QA ' + ('OK' if rep['ok'] else 'FAIL') + (f'（报告 {outputs[0]["path"]}）' if outputs else ''))
    data = {'ok': rep['ok'], 'summary': rep['summary'], 'checks': [{k: c[k] for k in ('id', 'status', 'value', 'expected')} for c in checks]}
    if not rep['ok']:
        return {'data': data, 'outputs': outputs, 'error': {'code': 'contract.audio-qa', 'message': '声音 QA 有硬项不达标：' + '、'.join(rep['summary']['hardFailures']),
                                                           'hint': '逐项原因与下一步见报告的 checks[].message / hint'}}
    return {'data': data, 'outputs': outputs}


if __name__ == '__main__':
    sys.exit(run(main, make_parser(), command='audio:qa'))
