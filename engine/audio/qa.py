# -*- coding: utf-8 -*-
"""北冥引擎 · 声音 QA 门：读 film.json（时长、帧率、镜头切点、混音目标、交付档位），对混音文件逐项判定，写附录 C8 的报告。

  python -m engine.audio.qa --film films/<名> [--wav <混音>] [--report <报告>] [--fail-on-warn] [--json]
  python -m engine.audio.qa --wav out/mix.wav --profile web-1080p24 [--frames 240 --fps 24]

检查项（id 前缀 audio.；hard = 不达标即失败，soft = 只告警，--fail-on-warn 时 soft 也算失败）：
  audio.format      hard  48 kHz、2 声道、样本全是有限数
  audio.length      hard  样本数 = frameCount / fps × 48000，差不超过 1 帧（截短、多出都算）
  audio.overload    hard  没有样本到满幅（|x| ≥ 0.99999；浮点文件超过 1.0 也算）
  响度在哪一步定（--loudness-at，默认自动：命令行给了 --target-lufs 或 film.json 的 audio 写了 targetLUFS → mix，
  有作品描述但没写 → deliver；只给 --wav → mix）：
  mix（声音脚本自己母带到目标）：
  audio.loudness    hard  BS.1770 积分响度 = 混音目标 ± 容差（目标：film.json audio.targetLUFS，否则档位的 audio.loudness.integrated；
                          容差默认 0.5 LU，不宽于档位容差。成片以最终 AAC 为准由 tools/qa 复测）
  audio.truepeak    hard  4 倍过采样真峰值 ≤ audio.truePeakDbTP（否则档位的 audio.loudness.truePeak），测量容差 0.05 dB
                          （限制器正好压在上限时，24 bit 量化后的实测会高出万分之几 dB）
  deliver（封装时 engine/render/mux.sh 整段乘一个增益到目标，真峰值超限才加限幅）：响度只记录；改判峰值余量——
  audio.headroom    hard > 3 dB、soft > 0   线性增益到目标后的真峰值 = 真峰值 + (目标 − 积分响度)，超出上限多少 dB 就要被限幅削多少
  audio.dc          hard > 0.01、soft > 0.001   每个声道的直流偏移
  audio.mono        hard 相关 < −0.3 或折单声道损失 < −8 LU；soft 相关 < 0 或损失 < −4 LU   单声道兼容
  audio.balance     soft 连续 ≥2 个 100 ms 有声窗（> −26 dBFS）|L−R| > 6 dB   逐窗左右平衡（捕捉全片 audio.mono 掩盖的短促单侧底噪爆发）
  audio.edges       hard > 0.05、soft > 0.003   首尾样本（不归零会在开始 / 结束时"咔"一声）
  audio.cuts        hard 比值 > 6 且跳变 > 0.02；soft 比值 > 3   镜头切点 ±1 ms 内的样本跳变，对比切点两侧 2–30 ms 的
                          99 分位样本差（点击声的判据；有交叉淡化的切点比值约 1）
  audio.bands       soft  20–120 Hz 相对最强频段 > −2 dB（低频糊）或 8 kHz 以上 > −10 dB（刺耳）
  audio.masking     hard < −12 dB（hero < −8 dB）、soft < −5 dB（hero < −1 dB），另查双向乐效平衡守卫：
                          music_dominance（配乐高于 fx+foley > +9 dB 告警）与 music_buried（有配乐但终混比总母带低 > 8.5 LU 告警）
                          有分轨 stems/*.wav 时核对前景事件在主能量临界频带的听觉窥视信噪比与双向乐效能量配比
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

from ._cli import ArgumentParser, CliError, run, sha256_file
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
        self._bal_w = max(64, int(round(0.100 * sr)))
        self._bal_rest = np.zeros((0, 2))
        self._bal_idx = 0
        self._bal_run = 0
        self.bal_worst_db = 0.0
        self.bal_worst_sec = 0.0
        self.bal_warn_wins = 0
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
        # 逐 100 ms 有声窗左右声道能量偏斜核对（捕捉局部单侧噪声爆发，弥补全片 audio.mono 掩盖短促偏斜）
        bbuf = np.vstack([self._bal_rest, x]) if len(self._bal_rest) else x
        bw = self._bal_w
        nb = len(bbuf) // bw
        if nb > 0:
            wins = bbuf[:nb * bw].reshape(nb, bw, 2)
            l_rms = np.sqrt(np.mean(wins[:, :, 0] ** 2, axis=1) + 1e-24)
            r_rms = np.sqrt(np.mean(wins[:, :, 1] ** 2, axis=1) + 1e-24)
            for j in range(nb):
                mx = max(float(l_rms[j]), float(r_rms[j]))
                if mx > 10.0 ** (-26.0 / 20.0):
                    skew = abs(20.0 * np.log10((float(l_rms[j]) + 1e-12) / (float(r_rms[j]) + 1e-12)))
                    if skew > 6.0:
                        self._bal_run += 1
                        if self._bal_run >= 2:
                            self.bal_warn_wins += 1
                            if skew > self.bal_worst_db:
                                self.bal_worst_db = float(skew)
                                self.bal_worst_sec = round((self._bal_idx + j) * 0.100, 2)
                    else:
                        self._bal_run = 0
                else:
                    self._bal_run = 0
            self._bal_idx += nb
        self._bal_rest = bbuf[nb * bw:]
        # 切点附近的样本
        a0, b0 = self.n, self.n + len(x)
        for _c, (lo, hi, parts) in self.cuts.items():
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


_MASK_BANDS = (
    ('80-250', 80.0, 250.0),
    ('250-600', 250.0, 600.0),
    ('600-1.5k', 600.0, 1500.0),
    ('1.5k-3.5k', 1500.0, 3500.0),
    ('3.5k-7.5k', 3500.0, 7500.0),
    ('7.5k-14k', 7500.0, 14000.0),
)
_BED_STEMS = {'amb', 'ambience', 'music', 'bgm', 'bed', 'master', 'mix'}
MASK_SOFT_DB = -5.0
MASK_HARD_DB = -12.0
MASK_HERO_SOFT_DB = -1.0
MASK_HERO_HARD_DB = -8.0
MUSIC_DOMINANCE_WARN_DB = 9.0
MUSIC_BURIED_WARN_LU = 8.5


def _measure_music_buried(stem_map, master_lufs):
    """测量存在非静音 music 分轨（原轨有音乐）时，终混配乐积分响度是否比总母带低超过 8.5 LU（触发 music_buried 告警）。"""
    import soundfile as sf
    mus_keys = [k for k in stem_map if k.lower() in ('music', 'bgm')]
    if not mus_keys or master_lufs is None or not np.isfinite(master_lufs) or master_lufs <= -65.0:
        return None
    blk_n = N(10.0)
    L_mus = Loudness()
    L_sum = Loudness()
    mus_pk = 0.0
    handles = {}
    try:
        for k, p in stem_map.items():
            handles[k] = sf.SoundFile(p)
        while True:
            chunks_k = {}
            max_len = 0
            for k, f in handles.items():
                seg = f.read(blk_n, dtype='float64', always_2d=True)
                if len(seg) > 0:
                    if seg.shape[1] == 1:
                        seg = np.repeat(seg, 2, axis=1)
                    elif seg.shape[1] > 2:
                        seg = seg[:, :2]
                    chunks_k[k] = seg
                    if len(seg) > max_len:
                        max_len = len(seg)
            if max_len == 0:
                break
            sum_blk = np.zeros((max_len, 2), dtype=float)
            mus_blk = np.zeros((max_len, 2), dtype=float)
            for k, seg in chunks_k.items():
                sum_blk[:len(seg)] += seg
                if k in mus_keys:
                    mus_blk[:len(seg)] += seg
            mus_pk = max(mus_pk, float(np.max(np.abs(mus_blk))))
            L_mus.feed(mus_blk)
            L_sum.feed(sum_blk)
    except Exception:
        return None
    finally:
        for f in handles.values():
            try:
                f.close()
            except Exception:
                pass
    mus_lufs = L_mus.integrated()
    if mus_pk < 1e-4 or not np.isfinite(mus_lufs) or mus_lufs <= -55.0:
        return None
    sum_lufs = L_sum.integrated()
    ref_lufs = float(master_lufs) if (not np.isfinite(sum_lufs) or abs(sum_lufs - float(master_lufs)) <= 1.5) else float(sum_lufs)
    below_lu = round(float(ref_lufs - mus_lufs), 2)
    return {
        'warn': bool(below_lu > MUSIC_BURIED_WARN_LU),
        'musicLufs': round(float(mus_lufs), 2),
        'referenceLufs': round(float(ref_lufs), 2),
        'belowMasterLu': below_lu,
        'thresholdLu': MUSIC_BURIED_WARN_LU,
    }


def _measure_music_dominance(stem_map, sr):
    """测量存在前景 fx/foley 分轨时，music 能量相对 fx+foley 活跃段总和是否过热（> +9 dB 触发 music_dominance 告警）。"""
    import soundfile as sf
    mus_paths = [p for k, p in stem_map.items() if k.lower() in ('music', 'bgm')]
    fg_paths = [p for k, p in stem_map.items() if k.lower() in ('fx', 'sfx', 'foley')]
    if not mus_paths or not fg_paths:
        return None
    bw = max(64, int(round(0.100 * sr)))

    def _win_powers(paths):
        acc = None
        for p in paths:
            try:
                wins_e = []
                rest = np.zeros(0)
                for blk in sf.blocks(p, blocksize=bw * 50, dtype='float64', always_2d=True):
                    m = blk.mean(axis=1)
                    buf = np.concatenate([rest, m]) if len(rest) else m
                    nb = len(buf) // bw
                    if nb > 0:
                        w = buf[:nb * bw].reshape(nb, bw)
                        wins_e.append(np.mean(w * w, axis=1))
                    rest = buf[nb * bw:]
                if not wins_e:
                    continue
                arr = np.concatenate(wins_e)
                if acc is None:
                    acc = arr
                else:
                    L = min(len(acc), len(arr))
                    acc = acc[:L] + arr[:L]
            except Exception:
                continue
        return acc

    e_mus = _win_powers(mus_paths)
    e_fg = _win_powers(fg_paths)
    if e_mus is None or e_fg is None or not len(e_mus) or not len(e_fg):
        return None
    L = min(len(e_mus), len(e_fg))
    e_mus, e_fg = e_mus[:L], e_fg[:L]
    pk_fg = float(np.max(e_fg))
    pk_mus = float(np.max(e_mus))
    if pk_fg <= 1e-10 or pk_mus <= 1e-10:
        return None
    # 在前景 fx+foley 有声窗（≥ -60 dBFS；若整条前景极弱则取峰值 5% 门限）统计同期配乐与前景能量比
    act = e_fg >= 1e-6
    if not np.any(act):
        act = e_fg >= (0.05 * pk_fg)
    n_act = int(np.sum(act))
    if n_act == 0:
        return None
    diff_db = round(float(10.0 * np.log10((float(e_mus[act].sum()) + 1e-24) / (float(e_fg[act].sum()) + 1e-24))), 2)
    return {
        'warn': bool(diff_db > MUSIC_DOMINANCE_WARN_DB),
        'musicMinusFgDb': diff_db,
        'thresholdDb': MUSIC_DOMINANCE_WARN_DB,
        'activeWindows': n_act,
    }


def _check_masking(wav, film, sr, n_total, master_lufs=None):
    """分轨临界频带听觉窥视掩蔽与双向乐效平衡守卫（Auditory Glimpse SNR & Music Dominance / Music Buried）：
    仅在混音旁（或作品声明处）存在 stems/*.wav（≥ 2 条分轨）时执行。"""
    import json
    import soundfile as sf
    if not film or not film.get('fps'):
        return None
    fa = film.get('audio') or {}
    cand_dirs = []
    if fa.get('stems'):
        cand_dirs.append(F.resolve(film, fa['stems']))
    cand_dirs.append(os.path.join(os.path.dirname(os.path.abspath(wav)), 'stems'))
    if fa.get('cues'):
        cand_dirs.append(os.path.join(os.path.dirname(F.resolve(film, fa['cues'])), 'stems'))
    stem_map = None
    stem_dir = None
    for d in cand_dirs:
        if not os.path.isdir(d):
            continue
        found = {}
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith('.wav'):
                continue
            k = os.path.splitext(fn)[0]
            if k.lower() in ('mix', 'master'):
                continue
            found[k] = os.path.join(d, fn)
        if len(found) >= 2:
            stem_map, stem_dir = found, d
            break
    if not stem_map:
        return None
    fg_stems = [k for k in stem_map if k.lower() not in _BED_STEMS]
    if not fg_stems:
        return None

    if master_lufs is None:
        L_m = Loudness()
        try:
            for blk in sf.blocks(wav, blocksize=N(10.0), dtype='float64', always_2d=True):
                L_m.feed(np.repeat(blk, 2, axis=1) if blk.shape[1] == 1 else blk)
            master_lufs = L_m.integrated()
        except Exception:
            master_lufs = None

    dom_info = _measure_music_dominance(stem_map, sr)
    dom_warn = bool(dom_info and dom_info['warn'])
    buried_info = _measure_music_buried(stem_map, master_lufs)
    buried_warn = bool(buried_info and buried_info['warn'])
    if not film.get('events') and not dom_warn and not buried_warn:
        return None

    cue_tab = {}
    if fa.get('cues'):
        cp = F.resolve(film, fa['cues'])
        if os.path.isfile(cp):
            try:
                with open(cp, encoding='utf-8') as f:
                    cue_tab = {c['id']: c for c in (json.load(f).get('cues') or []) if isinstance(c, dict) and 'id' in c}
            except Exception:
                cue_tab = {}

    def read_mono(path, a, b):
        try:
            with sf.SoundFile(path) as f:
                if a >= len(f) or b <= a:
                    return np.zeros(max(0, b - a))
                f.seek(a)
                seg = f.read(min(b, len(f)) - a, dtype='float64', always_2d=True)
            m = seg.mean(axis=1)
            if len(m) < b - a:
                m = np.pad(m, (0, (b - a) - len(m)))
            return m
        except Exception:
            return np.zeros(max(0, b - a))

    fps = film['fps']
    items, worst_st = [], ('warn' if (dom_warn or buried_warn) else 'pass')
    for e in film.get('events') or []:
        frame = e.get('frame')
        if not isinstance(frame, int) or isinstance(frame, bool):
            continue
        ref = e.get('audio')
        sync = e.get('sync')
        if not ref or sync == 'none' or e.get('domain') in ('amb', 'music', 'mix'):
            continue
        cue = cue_tab.get(str(ref), {})
        dom = str(e.get('domain') or '')
        dom_bus = 'fx' if dom == 'sfx' and 'fx' in stem_map else (dom if dom in stem_map else None)
        bus = e.get('bus') or cue.get('bus') or cue.get('layer') or (str(ref) if str(ref) in stem_map else dom_bus)
        if bus and str(bus).lower() in _BED_STEMS:
            continue
        t = float(cue['t']) if cue.get('t') is not None else frame / float(fps)
        end_f = e.get('end')
        if isinstance(end_f, int) and not isinstance(end_f, bool) and end_f > frame:
            ev_dur = min(1.50, max(0.220, (end_f - frame) / float(fps)))
        elif cue.get('dur') is not None:
            ev_dur = min(1.50, max(0.220, float(cue['dur'])))
        else:
            ev_dur = 0.220
        a = max(0, int(round((t - 0.015) * sr)))
        b = min(n_total, int(round((t + ev_dur) * sr)))
        if b - a < 256:
            continue

        slices = {k: read_mono(p, a, b) for k, p in stem_map.items()}
        if not bus or bus not in slices:
            bus = max(fg_stems, key=lambda k: float(np.mean(slices[k] ** 2)))
        u = slices[bus]
        other = np.zeros_like(u)
        for k, s in slices.items():
            if k != bus:
                other += s

        u_rms = float(np.sqrt(np.mean(u * u) + 1e-24))
        soft_ev = (sync == 'soft')
        ev_role = str(e.get('role') or cue.get('role') or '').strip().lower()
        is_hero = (ev_role == 'hero')
        if u_rms < 3.16e-4:
            best_snr, best_band = -99.0, 'silent'
        else:
            win = np.hanning(len(u))
            U = np.abs(np.fft.rfft(u * win)) ** 2
            O = np.abs(np.fft.rfft(other * win)) ** 2
            fq = np.fft.rfftfreq(len(u), 1.0 / sr)
            band_u = [(bn, lo, hi, float(U[(fq >= lo) & (fq < hi)].sum())) for bn, lo, hi in _MASK_BANDS]
            tot_u = sum(v for _, _, _, v in band_u) + 1e-24
            tot_o = float(O[(fq >= 80.0) & (fq < 14000.0)].sum())
            # 7.5k–14k 极高频仅在其本身占音效主能量 ≥28%（如镭射走线/星芒）时才允许作为主窥视带，防中频音效借合成乐极高频空洞作弊
            dom_bands = [
                (bn, lo, hi, v)
                for bn, lo, hi, v in band_u
                if v / tot_u >= (0.28 if bn == '7.5k-14k' else 0.14)
            ]
            if not dom_bands:
                dom_bands = [max(band_u, key=lambda it: it[3])]
            if tot_o < 1e-18:
                best_snr, best_band = 60.0, dom_bands[0][0]
            else:
                best_snr, best_band = -99.0, dom_bands[0][0]
                # 引入 Zwicker 向上掩蔽扩散底限（-25 dB 总背景能量），防止强中低频配乐下的空高频桶虚报超高 SNR
                upward_mask_floor = tot_o * 0.003
                for bn, lo, hi, vu in dom_bands:
                    vo = max(float(O[(fq >= lo) & (fq < hi)].sum()), upward_mask_floor if bn == '7.5k-14k' else 0.0)
                    snr = 10.0 * np.log10((vu + 1e-24) / (vo + 1e-24))
                    if snr > best_snr:
                        best_snr, best_band = snr, bn
            best_snr = round(float(best_snr), 2)

        soft_thr = MASK_HERO_SOFT_DB if is_hero else MASK_SOFT_DB
        hard_thr = MASK_HERO_HARD_DB if is_hero else MASK_HARD_DB
        st = _grade(best_snr, best_snr < soft_thr, (best_snr < hard_thr) and not soft_ev)
        if soft_ev and st == 'fail':
            st = 'warn'
        items.append({
            'id': e.get('id') or str(ref), 'frame': frame, 'seconds': round(t, 4), 'stem': bus,
            'role': ev_role or 'support', 'bestBand': best_band, 'bestBandSnrDb': best_snr, 'status': st,
        })
        worst_st = 'fail' if 'fail' in (worst_st, st) else ('warn' if 'warn' in (worst_st, st) else 'pass')

    if not items and not dom_warn and not buried_warn:
        return None

    bad = [it for it in items if it['status'] != 'pass']
    msgs = []
    if bad:
        msgs.append('前景音效被背景分轨掩蔽：' + '、'.join(
            f"{it['id']}（{it['stem']} @ {it['bestBand']} {it['bestBandSnrDb']:+.1f} dB）" for it in bad[:5]))
    if dom_warn:
        msgs.append(
            f"music_dominance：配乐能量高于前景 fx+foley 总和 {dom_info['musicMinusFgDb']:+.1f} dB"
            f"（> +{MUSIC_DOMINANCE_WARN_DB:g} dB），吞噬音效净空"
        )
    if buried_warn:
        msgs.append(
            f"music_buried：配乐分轨（{buried_info['musicLufs']:.2f} LUFS）比总母带低 {buried_info['belowMasterLu']:.2f} LU"
            f"（> {MUSIC_BURIED_WARN_LU:g} LU），配乐被过度压制，请用互补 EQ 与局部音量曲线替代全局死压"
        )

    if items:
        worst_item = min(items, key=lambda it: it['bestBandSnrDb'])
        val_str = f"{len(items)} 个前景事件，最低带内余量 {worst_item['bestBandSnrDb']:+.1f} dB（{worst_item['id']} @ {worst_item['bestBand']}）"
    else:
        val_str = '无离散事件声明'
    if dom_info is not None:
        val_str += f" · 配乐相对 fx+foley {dom_info['musicMinusFgDb']:+.1f} dB"
    if buried_info is not None:
        val_str += f" · 配乐低于母带 {buried_info['belowMasterLu']:.2f} LU"

    evidence = {'stemsDir': _rel(stem_dir), 'items': items}
    if dom_info is not None:
        evidence['musicDominance'] = dom_info
    if buried_info is not None:
        evidence['musicBuried'] = buried_info

    hint_msg = None
    if buried_warn:
        hint_msg = (
            '配乐被过度压制：请调回 music_ceiling_offset_db（建议 -2.6 dB）与温和 continuous_duck_db（1.8 dB），'
            '用互补 EQ（sculpt_stem_eq）与局部推子音量曲线（volume_curve）替代全局死压'
        )
    elif bad or dom_warn:
        hint_msg = (
            '启用 ThreeStemWorkstation / HDRMixer 的互补 EQ（sculpt_stem_eq）与局部音量曲线，'
            '或补强前景音效 1.5–7.5 kHz 切口'
        )

    return _chk(
        'audio.masking', '关键音效带内掩蔽余量与双向乐效平衡（分轨）', worst_st,
        val_str,
        f'普通事件最佳频带 SNR ≥ {MASK_SOFT_DB:g} dB（hero ≥ {MASK_HERO_SOFT_DB:g} dB，< {MASK_HARD_DB:g} dB 不通过）；'
        f'配乐相对 fx+foley ≤ +{MUSIC_DOMINANCE_WARN_DB:g} dB 且终混配乐不低于母带 {MUSIC_BURIED_WARN_LU:g} LU',
        evidence,
        '；'.join(msgs),
        hint=hint_msg,
        severity='hard' if worst_st == 'fail' else 'soft',
    )


def analyze(wav, *, fps=None, frames=None, cuts=(), target_lufs=-14.0, tol_lu=0.5, max_tp=-1.0, chunk_s=10.0, loudness_at='mix', film=None):
    """→ (checks, info)。cuts 是切点帧号；loudness_at 见文件头（mix / deliver）。"""
    import soundfile as sf
    try:
        info = sf.info(wav)
    except Exception as e:      # 不是音频、写到一半被打断的文件：说清楚是哪个文件、怎么办，而不是「内部错误」
        raise CliError('contract.audio-unreadable', f'读不了混音 {_rel(wav)}：{e}',
                       hint='要 libsndfile 能读的音频（WAV / FLAC；MP3 先转 WAV）；文件可能没写完——重跑声音脚本') from None
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
    if A.n == 0:                # 空文件：长度与响度直接判失败，后面的统计量都没有意义
        want = int(round(frames / fps * info.samplerate)) if frames and fps else None
        checks.append(_chk('audio.length', '长度 = 画面帧数 / fps', 'fail', '0 个样本（空文件）', f'{want} 个样本' if want else '至少 1 个样本',
                           {'samples': 0, 'expected': want}, '混音是空的：声音脚本没写进样本，或写到一半被打断', hint='重跑声音脚本，看它的日志有没有报错'))
        checks.append(_chk('audio.loudness', '积分响度', 'fail', '没有样本', f'{target_lufs:g} ± {tol_lu:g} LUFS', {'loudnessAt': loudness_at}, '混音是空的'))
        return checks, {'samples': 0, 'seconds': 0.0, 'subtype': info.subtype}

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

    I, M, S, lra = A.L.integrated(), A.L.momentary_max(), A.L.short_term_max(), A.L.lra()
    li = {'integrated': None if not np.isfinite(I) else round(I, 2),
          'momentaryMax': None if not np.isfinite(M) else round(M, 2),
          'shortTermMax': None if not np.isfinite(S) else round(S, 2),
          'lra': None if not np.isfinite(lra) else round(lra, 2),
          'loudnessAt': loudness_at}
    tpd = float(20 * np.log10(A.tp.value)) if A.tp.value > 0 else -np.inf
    tpd_json = round(tpd, 4) if np.isfinite(tpd) else None
    if not np.isfinite(I) or I <= -70:
        checks.append(_chk('audio.loudness', '积分响度', 'fail', '静音（没有块高于 −70 LUFS）', f'{target_lufs:g} ± {tol_lu:g} LUFS', li,
                           '混音是静音', hint='检查声音脚本有没有写进东西，或 film.json 的 audio.mode 应为 none'))
    elif loudness_at == 'deliver':
        checks.append(_chk('audio.loudness', '积分响度（封装时整段线性增益到目标，这里只记录）', 'pass', f'{I:.2f} LUFS',
                           f'封装到 {target_lufs:g} LUFS（engine/render/mux.sh）', dict(li, gainToTargetDb=round(target_lufs - I, 2)), '', severity='soft'))
        after = tpd + (target_lufs - I)
        over = after - max_tp
        st = 'fail' if over > 3.0 else ('warn' if over > TP_TOL_DB else 'pass')
        checks.append(_chk('audio.headroom', '峰值余量（线性增益到目标后的真峰值）', st, f'{after:.2f} dBTP（增益 {target_lufs - I:+.2f} dB）',
                           f'≤ {max_tp:g} dBTP（超出 3 dB 以内只告警）', {'truePeakDbTP': round(tpd, 4), 'gainToTargetDb': round(target_lufs - I, 3),
                                                                     'truePeakAfterGainDbTP': round(after, 3), 'overDb': round(over, 3)},
                           '' if st == 'pass' else f'整段增益到 {target_lufs:g} LUFS 后真峰值 {after:.2f} dBTP：封装时的限幅要削掉约 {over:.1f} dB 的峰'
                           + ('，瞬态会被压扁' if st == 'fail' else ''),
                           hint=None if st == 'pass' else '在声音脚本里母带：mixing.loudness_to(mix, 目标, 真峰值上限)（长片 stream.loudness_to），'
                                                          '并在 film.json 的 audio 写 targetLUFS / truePeakDbTP',
                           severity='hard' if st == 'fail' else 'soft'))
    else:
        ok = abs(I - target_lufs) <= tol_lu + 1e-9
        checks.append(_chk('audio.loudness', '积分响度（BS.1770）', 'pass' if ok else 'fail', f'{I:.2f} LUFS', f'{target_lufs:g} ± {tol_lu:g} LUFS', li,
                           '' if ok else f'积分响度 {I:.2f} LUFS，离目标 {target_lufs:g} 差 {I - target_lufs:+.2f} LU',
                           hint=None if ok else '在声音脚本末尾按 film.json 的 audio.targetLUFS / truePeakDbTP 收口（mixing.loudness_to；长片 stream.loudness_to），'
                                                '别指望封装时再归一化'))
    if loudness_at != 'deliver':
        ok = tpd <= max_tp + TP_TOL_DB
        checks.append(_chk('audio.truepeak', '真峰值（4 倍过采样）', 'pass' if ok else 'fail', f'{tpd:.2f} dBTP', f'≤ {max_tp:g} dBTP（测量容差 {TP_TOL_DB} dB）',
                           {'truePeakDbTP': tpd_json, 'samplePeak': round(A.sp, 6), 'toleranceDb': TP_TOL_DB},
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

    bal_bad = A.bal_warn_wins > 0
    checks.append(_chk('audio.balance', '逐窗左右平衡（100 ms 有声窗）', 'warn' if bal_bad else 'pass',
                       f'最大连续偏斜 {A.bal_worst_db:.2f} dB' + (f'（@ {A.bal_worst_sec:.2f} s，共 {A.bal_warn_wins} 窗）' if bal_bad else ''),
                       '连续 ≥2 个 100 ms 有声窗（> −26 dBFS）|L−R| ≤ 6 dB',
                       {'maxSustainedSkewDb': round(A.bal_worst_db, 2), 'worstAtSec': A.bal_worst_sec if bal_bad else None,
                        'skewWindows': A.bal_warn_wins},
                       '' if not bal_bad else f'{A.bal_worst_sec:.2f} s 附近出现连续单侧偏重（|L−R| = {A.bal_worst_db:.1f} dB）',
                       hint=None if not bal_bad else '排查微距斜拍声像是否未按景别收束（SHOT_PAN_CAP），或单侧低幅切片归一化放大了底噪（library.load_slice）',
                       severity='soft'))

    e = max(A.first or 0.0, A.last or 0.0)
    checks.append(_chk('audio.edges', '首尾样本归零', _grade(e, e > 0.003, e > 0.05), f'首 {A.first:.4f} · 尾 {A.last:.4f}', '≤ 0.003（> 0.05 不通过）',
                       {'first': A.first, 'last': A.last}, '' if e <= 0.003 else '开头或结尾没有归零：播放开始 / 结束时会咔一声',
                       hint=None if e <= 0.003 else '首尾各做几毫秒淡入淡出（engine.audio.dsp.fade），最后一个样本置 0'))

    rows, worst_st = [], 'pass'
    for c, (lo, _hi, parts) in A.cuts.items():
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
    mc = _check_masking(wav, film, info.samplerate, A.n, master_lufs=I)
    if mc is not None:
        checks.append(mc)
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
    p.add_argument('--loudness-at', choices=['mix', 'deliver'], help='响度在哪一步定：mix 声音脚本自己母带到目标（查响度与真峰值）；'
                   'deliver 封装时线性增益到目标（查峰值余量）。默认自动，见文件头')
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
                       hint='先跑作品的声音脚本出混音（或整片出片），或用 --wav 指定混音文件')
    p_lufs, p_tol, p_tp = F.loudness_targets(prof)
    fa = (film or {}).get('audio') or {}
    target = F.pick(args.target_lufs, fa.get('targetLUFS'), p_lufs)
    max_tp = F.pick(args.max_tp, fa.get('truePeakDbTP'), p_tp)
    if target is None or max_tp is None:
        raise CliError('contract.profile-audio', f'交付档位 {prof["id"]} 没写{"积分响度目标" if target is None else "真峰值上限"}，作品描述里也没有',
                       hint='engine/production/profiles.json 的 audio.loudness.{integrated, truePeak}，或 film.json 的 audio.targetLUFS / truePeakDbTP；'
                            '也可以用 --target-lufs / --max-tp 直接给')
    tol = min(args.tol_lu, float(p_tol)) if p_tol is not None else args.tol_lu
    fps = film['fps'] if film else args.fps
    frames = film['frameCount'] if film else args.frames
    at = args.loudness_at or ('mix' if (args.target_lufs is not None or 'targetLUFS' in fa or not film) else 'deliver')
    ctx.log(f'声音 QA：{_rel(wav)}（档位 {prof["id"]}，目标 {target:g} ± {tol:g} LUFS、真峰值 ≤ {max_tp:g} dBTP；响度在 {at} 定）')
    checks, _ = analyze(wav, fps=fps, frames=frames, cuts=film['cuts'] if film else (), target_lufs=float(target), tol_lu=tol, max_tp=float(max_tp),
                        loudness_at=at, film=film)
    rep = build_report(checks, film=film, wav=wav, profile_id=prof['id'], fail_on_warn=args.fail_on_warn)
    rep['loudnessAt'] = at
    outputs = []
    if not args.no_report:
        rp = os.path.abspath(args.report) if args.report else os.path.splitext(wav)[0] + '.qa.json'
        _write_json(rp, rep)
        outputs.append({'path': _rel(rp), 'sha256': sha256_file(rp), 'kind': 'qa-report'})
    mark = {'pass': '✓', 'warn': '!', 'fail': '✗', 'waived': '~'}
    for c in checks:
        ctx.out(f"  {mark[c['status']]} {c['id']:15} {c['value']}" + (f"  —— {c['message']}" if c['message'] else ''))
    ctx.out('AUDIO QA ' + ('OK' if rep['ok'] else 'FAIL') + (f'（报告 {outputs[0]["path"]}）' if outputs else ''))
    data = {'ok': rep['ok'], 'summary': rep['summary'], 'loudnessAt': at,
            'checks': [{k: c[k] for k in ('id', 'status', 'value', 'expected')} for c in checks]}
    if not rep['ok']:
        return {'data': data, 'outputs': outputs, 'error': {'code': 'contract.audio-qa', 'message': '声音 QA 有硬项不达标：' + '、'.join(rep['summary']['hardFailures']),
                                                           'hint': '逐项原因与下一步见报告的 checks[].message / hint'}}
    return {'data': data, 'outputs': outputs}


if __name__ == '__main__':
    sys.exit(run(main, make_parser(), command='audio:qa'))
