# -*- coding: utf-8 -*-
"""北冥引擎 · 智能剪辑、运动声像贴合与三干线乐效混音工作台（Editorial, Trajectory Coupling & Three-Stem Workstation）。

把专业电影声音剪辑师与重录混音师的「阶段 3 时值精裁与连击防疲劳 → 阶段 4 三维运动轨迹声像贴合 → 阶段 5 三干线乐效协同混音」
封装为确定性、零死循环、默认满足机器 QA 门禁的高层编排接口。

设计依据：
  · Walter Murch《In the Blink of an Eye》&《Dense Clarity》：硬切场景 55 ms 微交叉淡化消除台阶且防跨场穿帮，蒙太奇/J-L cut 显式声桥；
  · Michel Chion《Audio-Vision》：过程性音效服从画面动作生命周期（起止同帧 + 制动微瞬态），冲击余韵服从硬切边界；
  · 听觉习惯化与时域前向掩蔽（Bregman / Zwicker）：高密连击（小 IOI）自动收紧前序尾音与低频淤积，末击（Finisher）完整放尾；
  · 几何声学与瑞利双工定位：横移掠过（Fly-by）耦合景别声像上限（SHOT_PAN_CAP）、距离空气吸收、D/R 混响比、径向多普勒与中心音量峰；
  · Frostbite HDR / 三干线制式（Ambience / Hard FX & UI / Foley + Music）：音乐抒情窗温和压低次要拟音，动作焦点由 hero 自动挖负空间与频带让位。

接口：
  smart_edit_clip(wave, visual_dur, ...)       智能时值剪辑：过程性（sustained）精裁/非周期延展/制动微咔，冲击类（impulsive）切点前收尾
  schedule_action_series(hit_times, ...)       连续动作编排：ActionVariationDeck 三级防疲劳 + 相邻间隔 IOI 感知自动紧尾与末击放尾
  couple_motion_trajectory(wave, ...)          画面轨迹三维贴合：连续等功率 Pan + screen_ratio 远近纵深/高频空气吸收/D/R 混响 + 径向多普勒
  build_layered_ambience(dur, ...)             三层复合环境声合成：远景底床（Base Hum）+ 主纹理（Primary Texture）+ 间歇生机点缀（Spot Life）
  volume_curve(n, points, ...)                 推子音量包络曲线 [(t_s, gain_db), ...] → (n, 1) 余弦/线性平滑自动化（Fader Riding）
  sculpt_stem_eq(stems, ...)                   分轨互补 EQ 分槽（AMB <110Hz 高通与 800Hz 暖中频凹槽，Foley/FX 清低中频泥沼，VO 提咬字）
  carve_dialogue_pocket(stems, vo, ...)        对白共振峰动态频带挖槽（保护配乐 <350Hz 大提琴/低音底盘，仅在 800–4200Hz 让位）
  ThreeStemWorkstation / FourStemWorkstation   三/四干线乐效协同工作台：set_scenes / set_music / set_dialogue / bind_actor / add_sfx / add_foley / mixdown
"""
import math
import numpy as np
from scipy.ndimage import uniform_filter1d

from .cues import Track, Kinematics, load_kinematics
from .director import (
    POA_PRESETS,
    SHOT_PAN_CAP,
    WORLD_PROFILES,
    carve_dialogue_pocket,
    depth_gain_db,
    harmonic_freq,
    pan_trajectory,
    resolve_screen_ratio_curve,
    screen_scale_to_distance,
    sculpt_stem_eq,
    volume_curve,
    HDRMixer,
)

__all__ = [
    'smart_edit_clip',
    'schedule_action_series',
    'couple_motion_trajectory',
    'build_layered_ambience',
    'volume_curve',
    'sculpt_stem_eq',
    'carve_dialogue_pocket',
    'ThreeStemWorkstation',
    'FourStemWorkstation',
]
from .dsp import (
    SR,
    smoothstep,
    fade,
    rng,
    undb,
    lp,
    hp,
    shelf,
    svf,
    pan_lr,
    stereo,
    width as ms_width,
    space_place,
    doppler,
    make_ir,
    reverb,
)
from .foley import ActionVariationDeck, shift_material
from .library import sync_anchor
from .meter import integrated, true_peak
from .mixing import match_level


def _match_channels(wave: np.ndarray, target_ndim: int) -> np.ndarray:
    arr = np.asarray(wave, dtype=float)
    if target_ndim == 2 and arr.ndim == 1:
        return stereo(arr, 0.0)
    if target_ndim == 1 and arr.ndim == 2:
        return arr.mean(axis=1)
    return arr.copy()


def _release_envelope(n_rel: int, shape: str = 'cosine') -> np.ndarray:
    if n_rel <= 1:
        return np.zeros(max(0, n_rel), dtype=float)
    u = np.linspace(0.0, 1.0, n_rel, dtype=float)
    if shape == 'cosine':
        return np.cos(0.5 * math.pi * u) ** 2
    if shape == 'exp':
        k = 4.8
        e0 = math.exp(-k)
        env = (np.exp(-k * u) - e0) / (1.0 - e0)
        # 末尾 10% 叠微余弦收口，保证阻尼斜率自然且末样本严格归零无导数折角
        tail_taper = 1.0 - smoothstep(0.88, 1.0, u)
        return env * (0.85 + 0.15 * tail_taper) * (1.0 - (u >= 1.0 - 1e-12))
    raise ValueError(f"smart_edit_clip：未知 release_shape={shape!r}（应为 'cosine' 或 'exp'）")


def _apply_tail_damping(arr: np.ndarray, n_rel: int, shape: str = 'cosine') -> np.ndarray:
    out = arr.copy()
    m = min(len(out), max(0, int(n_rel)))
    if m <= 1:
        if len(out) > 0:
            out[-1] = 0.0
        return out
    env = _release_envelope(m, shape)
    if out.ndim == 2:
        out[-m:] *= env[:, None]
    else:
        out[-m:] *= env
    return out


def _extend_nonperiodic_nd(src: np.ndarray, n_target: int, r, sr: int = SR) -> np.ndarray:
    """多声道同相随机偏移等功率交叉淡化延展（严禁定周期重复循环，消除死循环电机嗡声）。"""
    arr = np.asarray(src, dtype=float)
    if len(arr) >= n_target:
        return arr[:n_target].copy()
    if len(arr) < 32:
        reps = (n_target + max(1, len(arr)) - 1) // max(1, len(arr))
        return np.concatenate([arr] * max(1, reps), axis=0)[:n_target].copy()

    xf = min(max(12, int(round(0.016 * sr))), len(arr) // 3)
    ang = np.linspace(0.0, 0.5 * math.pi, xf, dtype=float)
    cos_w = np.cos(ang)[:, None] if arr.ndim == 2 else np.cos(ang)
    sin_w = np.sin(ang)[:, None] if arr.ndim == 2 else np.sin(ang)

    # 跳过开头起音瞬态区（前 12%），在纹理中段随机取不同偏移拼接
    min_off = min(len(arr) // 8, max(0, len(arr) - xf * 3))
    max_off = max(min_off + 1, len(arr) // 2)
    last_off = -1
    out = arr.copy()
    while len(out) < n_target:
        if len(arr) - max_off > xf * 2:
            off = int(r.integers(min_off, max_off))
            if max_off - min_off > 4 and abs(off - last_off) < max(2, (max_off - min_off) // 5):
                off = min_off + ((off - min_off + (max_off - min_off) // 2) % (max_off - min_off))
        else:
            off = 0
        last_off = off
        chunk = arr[off:]
        if xf > 0 and len(chunk) > xf and len(out) > xf:
            seam = out[-xf:] * cos_w + chunk[:xf] * sin_w
            out = np.concatenate([out[:-xf], seam, chunk[xf:]], axis=0)
        else:
            out = np.concatenate([out, chunk], axis=0)
    return out[:n_target].copy()


def smart_edit_clip(
    wave: np.ndarray,
    visual_dur: float,
    *,
    mode: str = 'sustained',
    anchor: float = None,
    next_cut_in_s: float = None,
    fade_in_s: float = 0.003,
    release_shape: str = 'cosine',
    stop_transient: np.ndarray = None,
    seed: int = 1,
    sr: int = SR,
) -> tuple:
    """智能时值剪辑器（Smart Clip Editor）：
    · mode='sustained'（摩擦、旋转、扫描、推拉等过程音效）：
      保留 anchor 前导，使锚点后有效过程严格匹配画面动作时长 visual_dur；
      原始素材过长时精裁并按 release_shape（'cosine' 或 'exp'）施加自然阻尼淡出；
      原始素材过短时自动采用随机偏移等功率交叉淡化非周期延展；
      传入 stop_transient 时在动作停止帧（anchor + visual_dur）精准锚定叠入微制动咔嗒。
    · mode='impulsive'（敲击、剑鸣、钟声等冲击余韵音效）：
      默认保留完整自然物理衰减，不按短暂接触帧强裁；
      但若传入距下一硬切场景点的时间 next_cut_in_s，则在切点前平滑收束尾音防止跨场穿帮。
    返回 (处理后波形, 新锚点秒)。"""
    if mode not in ('sustained', 'impulsive'):
        raise ValueError(f"smart_edit_clip：未知 mode={mode!r}（应为 'sustained' 或 'impulsive'）")
    _ = _release_envelope(4, release_shape)

    arr = np.asarray(wave, dtype=float)
    if len(arr) == 0:
        return arr.copy(), 0.0

    r = rng(seed)
    sr_f = float(sr)

    if mode == 'sustained':
        anc_s = 0.0 if anchor is None else max(0.0, float(anchor))
        anc_s = min(anc_s, max(0.0, (len(arr) - 1) / sr_f))
        anc_n = int(round(anc_s * sr_f))

        vis_s = max(0.015, float(visual_dur))
        if next_cut_in_s is not None:
            vis_s = min(vis_s, max(0.015, float(next_cut_in_s)))
        target_n = max(16, int(round((anc_s + vis_s) * sr_f)))

        if len(arr) >= target_n:
            out = arr[:target_n].copy()
        else:
            if anc_n > 0 and len(arr) - anc_n >= 32:
                pre_seg = arr[:anc_n].copy()
                body_ext = _extend_nonperiodic_nd(arr[anc_n:], target_n - anc_n, r, sr=sr)
                out = np.concatenate([pre_seg, body_ext], axis=0)
            else:
                out = _extend_nonperiodic_nd(arr, target_n, r, sr=sr)

        rel_s = float(np.clip(vis_s * 0.24, 0.012, 0.120))
        post_s = max(0.004, len(out) / sr_f - anc_s)
        rel_n = min(len(out), max(4, int(round(min(rel_s, post_s * 0.85) * sr_f))))
        out = _apply_tail_damping(out, rel_n, release_shape)

        fin_s = min(max(0.0, float(fade_in_s)), len(out) / sr_f * 0.15)
        if fin_s > 0.0:
            out = fade(out, fin_s, 0.0)

        if stop_transient is not None and len(stop_transient) > 0:
            st_raw = np.asarray(stop_transient, dtype=float)
            target_ndim = 2 if (out.ndim == 2 or st_raw.ndim == 2) else 1
            out = _match_channels(out, target_ndim)
            st_clip = _match_channels(st_raw, target_ndim)
            st_clip = fade(st_clip, min(0.001, len(st_clip) / sr_f * 0.15), min(0.010, len(st_clip) / sr_f * 0.35))

            st_anc = sync_anchor(st_clip, sr)
            i_stop = target_n
            i_st_anc = int(round(st_anc * sr_f))
            s0 = max(0, i_stop - i_st_anc)
            need_n = s0 + len(st_clip)
            if next_cut_in_s is not None:
                cut_cap_n = max(16, int(round((anc_s + max(0.015, float(next_cut_in_s))) * sr_f)))
                need_n = min(need_n, cut_cap_n)
            if need_n > len(out):
                pad_shape = (need_n - len(out), 2) if target_ndim == 2 else (need_n - len(out),)
                out = np.concatenate([out, np.zeros(pad_shape, dtype=float)], axis=0)
            m_add = max(0, min(len(out) - s0, len(st_clip)))
            if m_add > 0:
                out[s0:s0 + m_add] += st_clip[:m_add]
            if next_cut_in_s is not None:
                out = _apply_tail_damping(out, min(len(out), max(4, int(round(0.008 * sr_f)))), release_shape)
            pk = float(np.max(np.abs(out)))
            if pk > 0.98:
                out = out * (0.95 / pk)

        if len(out) > 0:
            out[0] = 0.0
            out[-1] = 0.0
        return out, round(float(anc_s), 6)

    # mode == 'impulsive'
    anc_s = sync_anchor(arr, sr) if anchor is None else max(0.0, float(anchor))
    anc_s = min(anc_s, max(0.0, (len(arr) - 1) / sr_f))

    if next_cut_in_s is not None:
        cut_s = max(0.015, float(next_cut_in_s))
        max_n = max(16, int(round((anc_s + cut_s) * sr_f)))
        if len(arr) > max_n:
            out = arr[:max_n].copy()
            rel_s = float(np.clip(cut_s * 0.32, 0.012, 0.140))
            avail_post = max(0.004, len(out) / sr_f - anc_s - 0.004)
            rel_n = min(len(out), max(4, int(round(min(rel_s, avail_post) * sr_f))))
            out = _apply_tail_damping(out, rel_n, release_shape)
        else:
            out = fade(arr.copy(), 0.0, min(0.012, len(arr) / sr_f * 0.12))
    else:
        out = fade(arr.copy(), 0.0, min(0.012, len(arr) / sr_f * 0.12))

    # 保护极短起音瞬态：淡入不侵入 P-Center 锚点主冲击峰
    fin_cap = anc_s * 0.5 if anc_s > 0.002 else min(0.0008, len(out) / sr_f * 0.08)
    fin_s = min(max(0.0, float(fade_in_s)), fin_cap)
    if fin_s > 0.0:
        out = fade(out, fin_s, 0.0)
    if len(out) > 0:
        out[0] = 0.0
        out[-1] = 0.0
    return out, round(float(anc_s), 6)


def schedule_action_series(
    hit_times,
    *,
    forces=None,
    takes,
    accent_takes=None,
    policy: str = 'anti_fatigue',
    min_tail_s: float = 0.06,
    seed: int = 1,
    sr: int = SR,
) -> list:
    """连续动作防疲劳与 IOI（相邻事件间隔）感知包络编排器：
    内部调用 foley.ActionVariationDeck 执行三级防听觉疲劳演化（多 Take 轮询 / 按力度叠副层 / 单样本保瞬态微移调），
    并根据相邻动作时间差 IOI 自动管理尾音：
      · 高密连击（如 IOI = 0.14 s）自动收紧前序尾音包络并抑制尾段低频淤积，防止多拳浑成一团；
      · 最后一记收招动作（isFinisher=True）完整保留自然长尾音。
    返回 [{'t_hit': t, 'wave': w, 'anchor': anc, 'meta': meta}, ...]。"""
    times = [float(t) for t in (hit_times or [])]
    n_ev = len(times)
    if n_ev == 0:
        return []

    if forces is None:
        if n_ev == 1 or policy == 'uniform':
            f_list = [0.70] * n_ev
        else:
            f_list = [0.58 + 0.24 * (i / max(1, n_ev - 1)) for i in range(n_ev - 1)] + [1.0]
    elif np.isscalar(forces):
        f_list = [float(forces)] * n_ev
    else:
        f_list = [float(f) for f in forces]
        if len(f_list) != n_ev:
            raise ValueError(f'schedule_action_series：forces 长度 ({len(f_list)}) 与 hit_times ({n_ev}) 不一致')

    deck = ActionVariationDeck(takes, accent_takes=accent_takes, policy=policy, seed=seed)
    sr_f = float(sr)
    min_tail = max(0.018, float(min_tail_s))
    results = []

    for idx, (t_hit, f_val) in enumerate(zip(times, f_list)):
        w, anc, meta = deck.trigger(force=f_val)
        w = np.asarray(w, dtype=float).copy()
        anc_n = min(len(w) - 1, max(0, int(round(anc * sr_f))))
        is_last = (idx == n_ev - 1)
        meta_out = dict(meta)

        if not is_last:
            ioi = max(0.015, times[idx + 1] - t_hit)
            post_s = max(0.0, (len(w) - anc_n) / sr_f)
            allow_tail_s = max(min_tail, ioi * 0.82) if ioi >= min_tail else max(0.018, ioi * 0.90)

            if post_s > allow_tail_s:
                keep_n = max(16, anc_n + int(round(allow_tail_s * sr_f)))
                w = w[:min(len(w), keep_n)].copy()
                # 保留冲击点后前 22 ms 刚性拳锋瞬态，仅对后续余振做快速指数阻尼收尾与低频清淤
                punch_keep = min(len(w) - anc_n, max(8, int(round(min(0.022, allow_tail_s * 0.35) * sr_f))))
                tail_start = anc_n + punch_keep
                if ioi < 0.26 and len(w) - tail_start > 24:
                    low_trim = float(np.clip(-4.5 * (0.26 - ioi) / 0.18, -5.0, -1.2))
                    tail_clean = shelf(w[tail_start:], 145.0, low_trim, 'low')
                    xf = min(16, len(tail_clean))
                    blend = np.linspace(0.0, 1.0, xf)
                    if w.ndim == 2:
                        blend = blend[:, None]
                    w[tail_start:tail_start + xf] = w[tail_start:tail_start + xf] * (1.0 - blend) + tail_clean[:xf] * blend
                    w[tail_start + xf:] = tail_clean[xf:]

                rel_n = max(4, len(w) - tail_start)
                w = _apply_tail_damping(w, rel_n, 'exp')
                tightened = True
            else:
                w = fade(w, 0.0, min(0.010, len(w) / sr_f * 0.12))
                tightened = False

            meta_out.update({
                'ioi_s': round(ioi, 4),
                'tailTightened': tightened,
                'isFinisher': False,
                'effectiveTailSec': round(max(0.0, (len(w) - anc_n) / sr_f), 4),
            })
        else:
            w = fade(w, 0.0, min(0.015, len(w) / sr_f * 0.08))
            meta_out.update({
                'ioi_s': None,
                'tailTightened': False,
                'isFinisher': True,
                'effectiveTailSec': round(max(0.0, (len(w) - anc_n) / sr_f), 4),
            })

        if len(w) > 0:
            w[-1] = 0.0
        results.append({
            't_hit': round(t_hit, 6),
            'wave': w,
            'anchor': round(anc_n / sr_f, 6),
            'meta': meta_out,
        })
    return results


def _resample_curve(seq, n: int, default: float = 0.0) -> np.ndarray:
    if seq is None:
        return np.full(n, float(default), dtype=float)
    if np.isscalar(seq):
        return np.full(n, float(seq), dtype=float)
    arr = np.asarray(seq, dtype=float).reshape(-1)
    if len(arr) == 0:
        return np.full(n, float(default), dtype=float)
    if len(arr) == 1:
        return np.full(n, float(arr[0]), dtype=float)
    if len(arr) == n:
        return arr.copy()
    return np.interp(np.linspace(0.0, 1.0, n), np.linspace(0.0, 1.0, len(arr)), arr)


def couple_motion_trajectory(
    wave: np.ndarray,
    *,
    dur: float = None,
    x_curve=None,
    depth_curve=None,
    speed_curve=None,
    screen_ratio=None,
    ref_ratio: float = 0.45,
    ref_scale: float = None,
    ref_dist_m: float = 1.8,
    pan_keyframes: list = None,
    pan_points: list = None,
    track: Track = None,
    shot_scale: str = 'full',
    poa: str = 'open_sky',
    max_speed_mps: float = 12.0,
    radial_velocity_mps=None,
    sr: int = SR,
) -> np.ndarray:
    """画面运动轨迹三维声像贴合器（Trajectory & 3D Acoustic Motion Coupling）：
    将单声道或立体声素材按物体屏幕运动轨迹（pan_keyframes/pan_points、screen_ratio 画面占比、x_curve/depth_curve/speed_curve 或 cues.Track）
    一次性合成为具备以下五维物理特征的立体声波形 (n, 2)：
      1) 受景别上限 director.SHOT_PAN_CAP[shot_scale] 约束的连续等功率声像包络；
      2) 由 screen_ratio（标量、[(t, ratio), ...] 关键帧或曲线）或 depth_curve 驱动的远近距离与空气高频吸收；
      3) 按听觉视角 POA_PRESETS[poa] 耦合的直达/混响比（近干远湿 D/R）；
      4) 逼近升调、掠过中心回落、远离降调的径向多普勒频移（dsp.doppler）；
      5) 掠过视觉中心最近点（CPA）时的自然能量隆起包络（Fly-by Envelope）。"""
    arr = np.asarray(wave, dtype=float)
    if len(arr) == 0:
        return np.zeros((0, 2), dtype=float)

    if ref_scale is not None:
        ref_ratio = float(ref_scale)

    sr_f = float(sr)
    if dur is not None:
        target_dur = max(0.02, float(dur))
        src_ed, _ = smart_edit_clip(arr, target_dur, mode='sustained', fade_in_s=0.004, release_shape='cosine', seed=1, sr=sr)
    else:
        src_ed = arr.copy()
        target_dur = len(src_ed) / sr_f

    if pan_keyframes is None and pan_points is not None:
        pts_in = [(float(p[0]), float(p[1])) for p in pan_points]
        if (
            len(pts_in) >= 2
            and abs(pts_in[0][0]) < 1e-6
            and abs(pts_in[-1][0] - 1.0) < 1e-6
            and abs(target_dur - 1.0) > 1e-3
        ):
            pan_keyframes = [(u * target_dur, v) for u, v in pts_in]
        else:
            pan_keyframes = pts_in

    n = len(src_ed)
    mono = src_ed.mean(axis=1) if src_ed.ndim == 2 else src_ed.copy()
    cap = float(SHOT_PAN_CAP.get(shot_scale, SHOT_PAN_CAP['full'])) if shot_scale is not None else 1.0
    p_cfg = POA_PRESETS.get(poa, POA_PRESETS['open_sky']) if isinstance(poa, str) else dict(poa or POA_PRESETS['open_sky'])

    # 1. 解析横向归一化偏角 lat_raw ∈ [-1, 1] 与受景别上限约束的声像曲线 pan_c ∈ [-cap, cap]
    if pan_keyframes is not None and len(pan_keyframes) > 0:
        pan_c, kf_dist = pan_trajectory(target_dur, pan_keyframes, cap=cap, sr=sr)
        lat_raw, _ = pan_trajectory(target_dur, pan_keyframes, cap=1.0, sr=sr)
    elif x_curve is not None:
        kf_dist = None
        x_arr = _resample_curve(x_curve, n, default=0.5)
        if float(np.min(x_arr)) < -0.05:
            lat_raw = np.clip(x_arr, -1.0, 1.0)
        else:
            lat_raw = np.clip(x_arr * 2.0 - 1.0, -1.0, 1.0)
        pan_c = np.clip(lat_raw * cap, -cap, cap)
    elif isinstance(track, Track):
        kf_dist = None
        lat_raw = _resample_curve(track.pan('x', spread=1.0), n, default=0.0)
        pan_c = np.clip(_resample_curve(track.pan('x', spread=cap), n, default=0.0), -cap, cap)
    else:
        kf_dist = None
        lat_raw = np.zeros(n, dtype=float)
        pan_c = np.zeros(n, dtype=float)

    # 2. 解析纵向景深 Z(t) 与三维欧氏斜距 r(t) = sqrt(Z(t)^2 + X(t)^2)
    z_near = max(0.55, min(2.2, float(p_cfg.get('dist_m', 2.0)) * 0.55))
    z_far = max(z_near + 3.5, float(p_cfg.get('dist_m', 2.0)) * 3.0)
    use_sr = screen_ratio is not None
    if use_sr:
        r_curve = resolve_screen_ratio_curve(screen_ratio, n, target_dur, default_ratio=ref_ratio, sr=sr)
        z_m = screen_scale_to_distance(r_curve, ref_ratio=ref_ratio, ref_dist_m=ref_dist_m)
        ref_d = max(0.25, float(ref_dist_m))
        x_m = lat_raw * (0.65 * z_m)
    else:
        if depth_curve is not None:
            d_norm = np.clip(_resample_curve(depth_curve, n, default=0.2), 0.0, 1.0)
            z_m = z_near + d_norm * (z_far - z_near)
        elif kf_dist is not None:
            z_m = kf_dist
        elif isinstance(track, Track) and 'depth' in track.channels:
            z_m = _resample_curve(track.dist('depth', near=z_near, far=z_far), n, default=z_near)
        else:
            z_m = np.full(n, z_near, dtype=float)
        x_m = lat_raw * (1.55 * z_near)
        ref_d = max(0.45, z_near)

    dist_m = np.sqrt(z_m * z_m + x_m * x_m)

    # 3. 径向速度 v_rad = -dr/dt 驱动物理多普勒频移（左→中心逼近升调，中心→右远离降调）
    if radial_velocity_mps is not None and not np.isscalar(radial_velocity_mps):
        v_rad_in = _resample_curve(radial_velocity_mps, n, default=0.0)
        if n > 32 and float(np.max(np.abs(v_rad_in))) > 0.05:
            mono = doppler(mono, vel_mps=v_rad_in)
        max_spd = 0.0
    elif radial_velocity_mps is not None:
        rv_val = float(radial_velocity_mps)
        max_spd = abs(rv_val) if abs(rv_val) > 0.05 else 0.0
    else:
        rv_val = None
        max_spd = max(0.0, float(max_speed_mps))

    if max_spd > 0.05 and n > 32:
        dx_dt = np.gradient(x_m) * sr_f
        dz_dt = np.gradient(z_m) * sr_f
        dr_dt = np.gradient(dist_m) * sr_f
        kin_spd = np.sqrt(dx_dt * dx_dt + dz_dt * dz_dt)
        peak_kin = float(np.max(kin_spd))

        if speed_curve is not None:
            sc_arr = np.maximum(0.0, _resample_curve(speed_curve, n, default=0.0))
            sc_max = float(np.max(sc_arr))
            v_mag = (sc_arr * max_spd) if sc_max <= 1.5 else np.minimum(sc_arr, max_spd)
        elif isinstance(track, Track) and 'speed' in track.channels:
            tr_spd = np.maximum(0.0, _resample_curve(track.arr('speed', default=0.0), n, default=0.0))
            tr_max = float(np.max(tr_spd))
            v_mag = (tr_spd / max(tr_max, 1e-6)) * (0.85 * max_spd) if tr_max > 1e-5 else np.zeros(n)
        elif peak_kin > 1e-4:
            v_mag = (kin_spd / peak_kin) * (0.85 * max_spd)
        else:
            v_mag = np.zeros(n, dtype=float)

        if peak_kin > 1e-4:
            cos_theta = np.clip(-dr_dt / np.maximum(kin_spd, 1e-6), -1.0, 1.0)
            v_rad = v_mag * cos_theta
        elif rv_val is not None:
            v_rad = np.full(n, rv_val, dtype=float)
        else:
            v_rad = np.zeros(n, dtype=float)

        smooth_w = max(3, int(round(0.024 * sr_f)))
        v_rad = uniform_filter1d(v_rad, size=min(n, smooth_w))
        if float(np.max(np.abs(v_rad))) > 0.08:
            mono = doppler(mono, vel_mps=v_rad)

    # 4. 距离空气高频吸收（近中心清亮通透，远边缘高频空气衰减）
    lp_ceil = float(p_cfg.get('lp_hz', 19000.0))
    fc_curve = np.clip(lp_ceil * ((ref_d / np.maximum(dist_m, 0.35)) ** 0.80), 1500.0, 20000.0)
    if float(np.max(fc_curve) - np.min(fc_curve)) > 180.0 or float(np.mean(fc_curve)) < 18500.0:
        mono = svf(mono, fc_curve, 0.707, 'lp')

    # 5. 掠过中心音量包络（Fly-by CPA Envelope）+ 等功率声像 + 距离耦合混响 D/R
    if use_sr:
        lat_bell = 0.75 + 0.25 * np.exp(-1.8 * (lat_raw * lat_raw))
        dist_att = undb(depth_gain_db(dist_m, ref_dist_m=ref_d))
    else:
        lat_bell = 0.40 + 0.60 * np.exp(-2.15 * (lat_raw * lat_raw))
        dist_att = (ref_d / np.maximum(dist_m, 0.35)) ** 0.92

    if speed_curve is not None:
        sc_norm = _resample_curve(speed_curve, n, default=1.0)
        sc_01 = np.clip(sc_norm / max(1.0, float(np.max(sc_norm))), 0.0, 1.0)
        kin_env = 0.72 + 0.28 * sc_01
    else:
        kin_env = 1.0

    g_dry = lat_bell * dist_att * kin_env
    l_gain, r_gain = pan_lr(pan_c)
    dry_st = np.stack([mono * g_dry * l_gain, mono * g_dry * r_gain], axis=1)

    base_wet = float(p_cfg.get('wet', 0.20))
    ir_spec = p_cfg.get('ir')
    if ir_spec and base_wet > 0.0:
        if use_sr:
            g_wet = base_wet * ((ref_d / np.maximum(dist_m, 0.35)) ** 0.32)
        else:
            g_wet = base_wet * (0.35 + 0.35 * lat_bell) * ((ref_d / np.maximum(dist_m, 0.35)) ** 0.30)
        send_st = np.stack([mono * g_wet * l_gain, mono * g_wet * r_gain], axis=1)
        ir = make_ir(**dict(ir_spec))
        wet_st = reverb(send_st, ir, wet=1.0, dry=0.0, cross=0.30, hp_in=150.0)
        out_st = dry_st + wet_st
    else:
        out_st = dry_st

    out_st = fade(out_st, min(0.008, target_dur * 0.05), min(0.015, target_dur * 0.08))
    pk = float(np.max(np.abs(out_st)))
    if pk > 0.98:
        out_st = out_st * (0.94 / pk)
    if len(out_st) > 0:
        out_st[0] = 0.0
        out_st[-1] = 0.0
    return out_st


def build_layered_ambience(
    dur: float,
    *,
    base_bed: np.ndarray = None,
    texture_bed: np.ndarray = None,
    spot_events: list = None,
    base_gain_db: float = -4.5,
    texture_gain_db: float = 0.0,
    spot_gain_db: float = -2.0,
    base_lp_hz: float = 4200.0,
    texture_lp_hz: float = 9800.0,
    stereo_width: float = 0.85,
    poa: str = 'open_sky',
    target_lufs: float = None,
    seed: int = 1,
    sr: int = SR,
) -> np.ndarray:
    """构建三层复合立体声环境音轨（Base Hum 远景底床 + Primary Texture 主环境纹理 + Spot Life 间歇生机点缀）：
    · base_bed：远景底噪（如都市海岬背景嗡鸣、远山风底），自动做空气低通滤波与温和立体声铺展；
    · texture_bed：主环境纹理（如海浪拍岸呼吸、雨打屋檐），保留中高频纹理清晰度与立体声呼吸；
    · spot_events：间歇生机元素（如海鸥啼叫、远犬、林鸟），支持传入事件字典列表
      [{'wave': w, 't': 0.8, 'pan': -0.35, 'screen_ratio': 0.08, 'gain_db': 0.0}, ...]
      或直接传入原始波形列表 [w1, w2, ...]（自动在时长内非周期错落排布方位与远近）；
    保证单声道兼容（LR 相关度 ≥ 0.45）且无单侧突发偏斜（过 audio.balance 门）。"""
    dur_f = max(0.05, float(dur))
    n = max(16, int(round(dur_f * sr)))
    r = rng(seed)
    out = np.zeros((n, 2), dtype=float)

    def _decor_bed(src_w: np.ndarray, lp_hz_val: float, hp_hz_val: float, shift_s: float, seed_off: int) -> np.ndarray:
        rk = rng(seed + seed_off)
        arr = np.asarray(src_w, dtype=float)
        if arr.ndim == 2:
            ext = _extend_nonperiodic_nd(arr, n, rk, sr=sr)
            st_b = ms_width(ext, float(np.clip(stereo_width, 0.2, 1.15)))
        else:
            ext_m = _extend_nonperiodic_nd(arr, n, rk, sr=sr)
            sh = min(max(8, int(round(shift_s * sr))), max(8, n // 5))
            ext_r = np.roll(ext_m, sh)
            w_pan = float(np.clip(0.28 * stereo_width, 0.05, 0.36))
            st_b = stereo(ext_m, -w_pan) * 0.54 + stereo(ext_r, +w_pan) * 0.54
        if n > 64:
            if hp_hz_val and hp_hz_val > 15.0:
                st_b = hp(st_b, float(hp_hz_val), 2)
            if lp_hz_val and lp_hz_val < 0.44 * sr:
                st_b = lp(st_b, float(lp_hz_val), 2)
        return st_b

    if base_bed is not None and len(base_bed) > 0:
        b_st = _decor_bed(base_bed, base_lp_hz, 35.0, 0.031, 11)
        out += b_st * float(undb(base_gain_db))

    if texture_bed is not None and len(texture_bed) > 0:
        tx_st = _decor_bed(texture_bed, texture_lp_hz, 45.0, 0.019, 23)
        out += tx_st * float(undb(texture_gain_db))

    if spot_events:
        p_cfg = POA_PRESETS.get(poa, POA_PRESETS['open_sky']) if isinstance(poa, str) else dict(poa or POA_PRESETS['open_sky'])
        ir = make_ir(**dict(p_cfg['ir'])) if p_cfg.get('ir') else None
        wet = min(0.22, float(p_cfg.get('wet', 0.18))) if ir is not None else 0.0

        normalized_spots = []
        if all(isinstance(it, dict) for it in spot_events):
            n_sp = len(spot_events)
            for idx, sp in enumerate(spot_events):
                w_sp = sp.get('wave')
                if w_sp is None or len(w_sp) == 0:
                    continue
                t_sp = sp.get('t', sp.get('t_hit'))
                if t_sp is None:
                    slot = dur_f * (0.12 + 0.76 * (idx + 0.5) / max(1, n_sp))
                    t_sp = float(np.clip(slot + float(r.uniform(-0.18, 0.18)), 0.04, max(0.05, dur_f - 0.15)))
                pan_sp = sp.get('pan')
                if pan_sp is None:
                    side = -1.0 if idx % 2 == 0 else 1.0
                    pan_sp = side * float(r.uniform(0.18, 0.44))
                sr_sp = sp.get('screen_ratio')
                if sp.get('dist_m') is not None:
                    d_sp = float(sp['dist_m'])
                elif sr_sp is not None:
                    d_sp = float(screen_scale_to_distance(float(sr_sp)))
                else:
                    d_sp = float(r.uniform(5.5, 11.0))
                g_sp = float(sp.get('gain_db', 0.0))
                normalized_spots.append((w_sp, float(t_sp), float(pan_sp), d_sp, g_sp))
        else:
            takes = [np.asarray(w, dtype=float) for w in spot_events if w is not None and len(w) > 0]
            if takes and dur_f >= 0.6:
                n_auto = max(1, int(round(dur_f / 2.6)))
                for idx in range(n_auto):
                    w_sp = takes[idx % len(takes)]
                    if idx >= len(takes) and w_sp.ndim == 1 and len(w_sp) > 64:
                        semi = float(r.uniform(-1.1, 1.1))
                        w_sp = shift_material(w_sp, semi, preserve_msi=0.6)
                    slot = dur_f * (0.14 + 0.72 * (idx + 0.5) / max(1, n_auto))
                    t_sp = float(np.clip(slot + float(r.uniform(-0.22, 0.22)), 0.04, max(0.05, dur_f - 0.18)))
                    side = -1.0 if idx % 2 == 0 else 1.0
                    pan_sp = side * float(r.uniform(0.16, 0.42))
                    d_sp = float(r.uniform(6.0, 11.5))
                    g_sp = float(r.uniform(-1.5, 1.0))
                    normalized_spots.append((w_sp, t_sp, pan_sp, d_sp, g_sp))

        spot_buf = np.zeros((n, 2), dtype=float)
        for w_sp, t_sp, pan_sp, d_sp, g_sp in normalized_spots:
            w_clean = np.asarray(w_sp, dtype=float)
            w_clean = fade(w_clean, min(0.008, len(w_clean) / float(sr) * 0.12), min(0.035, len(w_clean) / float(sr) * 0.22))
            # 以远空环境点缀基准距离 ref_dist=6.5m 放置，使海鸥/林鸟既有自然高空空气感又不至于衰减消失
            space_place(
                spot_buf,
                w_clean,
                max(0.0, t_sp),
                gain=float(undb(spot_gain_db + g_sp)),
                pan=float(np.clip(pan_sp, -0.52, 0.52)),
                dist=max(0.8, d_sp),
                ref_dist=6.5,
                ir=ir,
                wet=wet,
            )
        out += spot_buf

    if target_lufs is not None and dur_f >= 0.45 and float(np.max(np.abs(out))) > 1e-7:
        out, _, _ = match_level(out, float(target_lufs), 'win', 0.0, dur_f)

    out = fade(out, min(0.020, dur_f * 0.04), min(0.045, dur_f * 0.06))
    pk = float(np.max(np.abs(out)))
    if pk > 0.96:
        out = out * (0.92 / pk)
    if len(out) > 0:
        out[0] = 0.0
        out[-1] = 0.0
    return out


class ThreeStemWorkstation:
    """三干线乐效协同混音工作台（Ambience / Hard FX & UI / Foley + Music Score）：
    面向整片交付的声明式高层混音编排器，底层驱动 director.HDRMixer 与 WORLD_PROFILES。"""

    def __init__(
        self,
        dur: float,
        *,
        fps: float = 24.0,
        world: str = 'realistic',
        sr: int = SR,
        target_lufs: float = -14.0,
        max_tp: float = -1.5,
        murch_limit: int = 2,
        telemetry=None,
        suppress_foley: bool = None,
        music_ceiling_offset_db: float = -2.6,
        music_focus_windows: list = None,
        continuous_duck_db: float = 1.8,
        glue_eq: bool = True,
        master_glue: bool = True,
        glue_max_gr_db: float = 3.2,
    ):
        self.dur = float(dur)
        self.fps = float(fps)
        self.sr = int(sr)
        self.n = max(1, int(round(self.dur * self.sr)))
        self.world = world if world in WORLD_PROFILES else 'realistic'
        self.target_lufs = float(target_lufs)
        self.max_tp = float(max_tp)

        if telemetry is None or isinstance(telemetry, Kinematics):
            kin_obj = telemetry
        else:
            kin_obj = load_kinematics(telemetry, dur=self.dur, sr=self.sr)

        # 预留 0.08 dB 过采样真峰值安全裕量，确保 24-bit PCM 落盘后仍严格 ≤ max_tp
        self.mixer = HDRMixer(
            self.dur,
            fps=self.fps,
            sr=self.sr,
            target_lufs=self.target_lufs,
            max_tp=self.max_tp - 0.08,
            murch_limit=murch_limit,
            telemetry=kin_obj,
            world=self.world,
            music_ceiling_offset_db=music_ceiling_offset_db,
            music_focus_windows=music_focus_windows,
            continuous_duck_db=continuous_duck_db,
            glue_eq=glue_eq,
            master_glue=master_glue,
            glue_max_gr_db=glue_max_gr_db,
        )
        self.key = 'D'
        self.scale = 'pentatonic'
        self.music_focus_windows = []
        if music_focus_windows:
            self._sync_focus_windows(music_focus_windows, is_climax=True)
        self.suppress_foley = (
            (not WORLD_PROFILES[self.world]['foley_enabled'])
            if suppress_foley is None
            else bool(suppress_foley)
        )
        self._hard_cuts = []
        self._suppressed_foley = []
        self._focus_trimmed_ids = []
        self._tonal_snaps = []
        self._ledger = []

    def _sync_focus_windows(self, windows: list, *, is_climax: bool = True):
        self.mixer.set_music_focus_windows(windows, is_climax=is_climax)
        self.music_focus_windows = [
            (fw['t0'], fw['t1'], fw['sfx_trim_db'])
            for fw in self.mixer.music_focus_windows
        ]

    def set_scenes(
        self,
        scenes: list,
        hard_xfade_s: float = 0.055,
        montage_xfade_s: float = 0.85,
        *,
        target_lufs: float = None,
        curve_points: list = None,
    ):
        """登记全片场景环境音轨（amb）：硬切默认 55 ms 等功率微交叉淡化防爆音且不串场，支持 montage / j_cut / l_cut 声桥与 curve_points 音量曲线。"""
        self.mixer.beds['amb'] = np.zeros((self.n, 2), dtype=float)
        self._hard_cuts = []
        for idx, sc in enumerate(scenes or []):
            tr_out = str(sc.get('transition') or 'hard_cut')
            out_s = float(sc['out_s'])
            if idx < len(scenes) - 1 and tr_out == 'hard_cut' and 0.0 < out_s < self.dur:
                self._hard_cuts.append(out_s)
        self.mixer.add_scene_ambience(
            scenes,
            target_lufs=target_lufs,
            hard_xfade_s=hard_xfade_s,
            montage_xfade_s=montage_xfade_s,
            curve_points=curve_points,
        )
        if float(np.max(np.abs(self.mixer.beds['amb']))) > 1e-8 and self.n > 64:
            self.mixer.beds['amb'] = fade(
                hp(self.mixer.beds['amb'], 22.0, 2),
                min(0.015, self.dur * 0.03),
                min(0.040, self.dur * 0.05),
            )
        return self

    def set_music(
        self,
        wave: np.ndarray,
        *,
        key: str = 'D',
        music_focus_windows: list = None,
        mode_focus_windows: list = None,
        music_ceiling_offset_db: float = None,
        continuous_duck_db: float = None,
        target_lufs: float = -18.5,
        scale: str = 'pentatonic',
        gain_db: float = 0.0,
        curve_points: list = None,
    ):
        """登记全片配乐与调性主音 key，支持 curve_points 推子音量包络曲线与 music_focus_windows 情绪焦点窗：
        · 默认 music_ceiling_offset_db=-2.6 dB、continuous_duck_db=1.8 dB，使终混配乐稳立在 -16.0 ~ -17.5 LUFS 黄金区间；
        · 支持传入 curve_points=[(t_s, gain_db), ...] 随乐句呼吸与单点瞬态做细腻推拉避让；
        · 在 music_focus_windows 纯音乐情绪高潮/尾声段自动放开推高配乐，并温和压低非 hero 次要拟音。"""
        self.key = str(key or 'D')
        self.scale = str(scale or 'pentatonic')
        if music_ceiling_offset_db is not None:
            self.mixer.music_ceiling_offset_db = float(music_ceiling_offset_db)
        if continuous_duck_db is not None:
            self.mixer.continuous_duck_db = max(0.0, float(continuous_duck_db))

        if music_focus_windows is not None and mode_focus_windows is not None:
            self._sync_focus_windows([*mode_focus_windows, *music_focus_windows], is_climax=True)
        elif music_focus_windows is not None:
            self._sync_focus_windows(music_focus_windows, is_climax=True)
        elif mode_focus_windows is not None:
            self._sync_focus_windows(mode_focus_windows, is_climax=False)
        elif not self.mixer.music_focus_windows:
            self.music_focus_windows = []

        self.mixer.beds['music'] = np.zeros((self.n, 2), dtype=float)
        if wave is None or len(wave) == 0:
            return self

        st = np.asarray(wave, dtype=float)
        if st.ndim == 1:
            st = stereo(st, 0.0)
        if len(st) < self.n:
            r = rng(307)
            st = _extend_nonperiodic_nd(st, self.n, r, sr=self.sr)
        else:
            st = st[:self.n].copy()
        if self.n > 64:
            st = hp(st, 22.0, 2)
        st = fade(st, min(0.02, self.dur * 0.04), min(0.12, self.dur * 0.08))
        self.mixer.add_bed(
            'music',
            st,
            target_lufs=target_lufs if self.dur >= 0.45 else None,
            how='win',
            t0=0.0,
            t1=self.dur,
            gain_db=gain_db,
            curve_points=curve_points,
        )
        return self

    def set_dialogue(
        self,
        wave_or_path,
        *,
        spans=None,
        voice_json=None,
        target_lufs: float = -16.0,
        formant_duck_db: float = 4.2,
        amb_duck_db: float = 2.5,
        fx_duck_db: float = 1.8,
        gain_db: float = 0.0,
        pan: float = 0.0,
        room_wet: float = 0.04,
        curve_points=None,
    ):
        """设置四干线对白轨（VO / Dialogue）：
        自动执行 50 ms 有声窗门限响度定标（默认 -16.0 LUFS）、早期反射空间融合（room_wet=0.04）、
        互补 EQ 分槽与配乐共振峰动态挖槽（保护 <350 Hz 低音温暖底盘），并在 mixdown() 中导出 stems['vo']。"""
        self.mixer.set_dialogue(
            wave_or_path,
            spans=spans,
            voice_json=voice_json,
            target_lufs=target_lufs,
            formant_duck_db=formant_duck_db,
            amb_duck_db=amb_duck_db,
            fx_duck_db=fx_duck_db,
            gain_db=gain_db,
            pan=pan,
            room_wet=room_wet,
            curve_points=curve_points,
        )
        return self

    def _next_hard_cut_after(self, t_hit: float):
        later = [c - t_hit for c in self._hard_cuts if c > t_hit + 0.020]
        return min(later) if later else None

    def _music_focus_trim(self, t_hit: float, role: str) -> float:
        if role == 'hero':
            return 0.0
        trim = 0.0
        for t0, t1, trim_db in self.music_focus_windows:
            if t0 <= t_hit <= t1:
                trim = min(trim, float(trim_db))
        return trim

    def add_sfx(
        self,
        cue_id: str,
        wave: np.ndarray,
        t_hit: float,
        *,
        anchor: float = None,
        role: str = 'support',
        bus: str = None,
        tonal_hz: float = None,
        span_dur: float = None,
        edit_mode: str = 'sustained',
        release_shape: str = 'cosine',
        stop_transient: np.ndarray = None,
        next_cut_in_s: float = None,
        pan=None,
        screen_ratio=None,
        ref_ratio: float = 0.45,
        ref_dist_m: float = 1.8,
        trajectory: dict = None,
        shot_scale: str = 'medium',
        poa: str = None,
        gain_db: float = 0.0,
        target_lufs: float = None,
        duck_db: float = None,
        continuous_duck_db: float = None,
        curve_points: list = None,
        priority: float = None,
        negative_space: bool = None,
        vacuum_lead_frames: float = 6.0,
        vacuum_dip_db: float = -12.0,
        seed: int = 1,
        _depth_peak_db: float = None,
    ) -> dict:
        """添加硬效、设计音效或 UI 事件：支持 tonal_hz 自动吸附配乐主调、smart_edit_clip 时值/切点收尾、
        screen_ratio 视觉占比远近纵深映射、couple_motion_trajectory 轨迹贴合，以及 hero 焦点自动挖峰值前负空间。"""
        w_arr = np.asarray(wave, dtype=float).copy()
        t_val = float(t_hit)
        snapped_hz = None

        if tonal_hz is not None and float(tonal_hz) > 20.0 and len(w_arr) > 16:
            snapped_hz = harmonic_freq(float(tonal_hz), root=self.key, scale=self.scale)
            semi = 12.0 * math.log2(snapped_hz / float(tonal_hz))
            if abs(semi) > 0.02:
                if w_arr.ndim == 2:
                    w_arr = np.column_stack([
                        shift_material(w_arr[:, 0], semi, preserve_msi=0.65),
                        shift_material(w_arr[:, 1], semi, preserve_msi=0.65),
                    ])
                else:
                    w_arr = shift_material(w_arr, semi, preserve_msi=0.65)
            self._tonal_snaps.append({'id': str(cue_id), 'fromHz': round(float(tonal_hz), 2), 'toHz': snapped_hz, 'key': self.key})

        anc_val = sync_anchor(w_arr, self.sr) if anchor is None else max(0.0, float(anchor))

        eff_cut = next_cut_in_s
        if eff_cut is None and edit_mode == 'impulsive':
            auto_cut = self._next_hard_cut_after(t_val)
            if auto_cut is not None and (len(w_arr) / float(self.sr) - anc_val) > auto_cut:
                eff_cut = auto_cut

        if span_dur is not None or eff_cut is not None or stop_transient is not None:
            vis_d = float(span_dur) if span_dur is not None else max(0.02, len(w_arr) / float(self.sr) - anc_val)
            w_arr, anc_val = smart_edit_clip(
                w_arr,
                vis_d,
                mode=edit_mode,
                anchor=anc_val,
                next_cut_in_s=eff_cut,
                release_shape=release_shape,
                stop_transient=stop_transient,
                seed=seed,
                sr=self.sr,
            )

        cue_pan = pan
        cue_poa = poa
        cue_scale = shot_scale
        cue_sr = screen_ratio
        traj_depth_peak_db = _depth_peak_db
        if trajectory is not None:
            tr_kw = dict(trajectory)
            tr_scale = tr_kw.pop('shot_scale', shot_scale or 'full')
            tr_poa = tr_kw.pop('poa', poa or 'open_sky')
            eff_sr = tr_kw.pop('screen_ratio', screen_ratio)
            tr_ref_r = float(tr_kw.pop('ref_ratio', ref_ratio))
            tr_ref_d = float(tr_kw.pop('ref_dist_m', ref_dist_m))
            if eff_sr is not None and len(w_arr) > 0:
                est_dur = float(tr_kw.get('dur') or (len(w_arr) / float(self.sr)))
                est_n = max(1, int(round(est_dur * self.sr)))
                r_c = resolve_screen_ratio_curve(eff_sr, est_n, est_dur, default_ratio=tr_ref_r, sr=self.sr)
                d_c = screen_scale_to_distance(r_c, ref_ratio=tr_ref_r, ref_dist_m=tr_ref_d)
                traj_depth_peak_db = float(np.max(depth_gain_db(d_c, ref_dist_m=tr_ref_d)))
            w_arr = couple_motion_trajectory(
                w_arr,
                screen_ratio=eff_sr,
                ref_ratio=tr_ref_r,
                ref_dist_m=tr_ref_d,
                shot_scale=tr_scale,
                poa=tr_poa,
                sr=self.sr,
                **tr_kw,
            )
            anc_val = min(anc_val, max(0.0, (len(w_arr) - 1) / float(self.sr)))
            cue_pan = 0.0
            cue_poa = None
            cue_scale = None
            cue_sr = None

        focus_trim = self._music_focus_trim(t_val, role)
        eff_gain_db = float(gain_db) + focus_trim
        eff_duck_db = duck_db
        if focus_trim < -0.1:
            self._focus_trimmed_ids.append(str(cue_id))
            if eff_duck_db is None:
                eff_duck_db = 0.8
            else:
                eff_duck_db = float(eff_duck_db) * 0.35

        use_vac = (role == 'hero') if negative_space is None else bool(negative_space)
        if use_vac:
            self.mixer.add_negative_space(
                t=t_val,
                lead_frames=float(vacuum_lead_frames),
                hold_frames=1.0,
                dip_db=float(vacuum_dip_db),
                recover_sec=0.50,
            )

        self.mixer.add_cue(
            cue_id,
            w_arr,
            t_val,
            anchor=anc_val,
            role=role,
            priority=priority,
            bus=bus,
            target_lufs=target_lufs,
            gain_db=eff_gain_db,
            pan=cue_pan,
            screen_ratio=cue_sr,
            ref_ratio=ref_ratio,
            ref_dist_m=ref_dist_m,
            poa=cue_poa,
            duck_db=eff_duck_db,
            continuous_duck_db=continuous_duck_db,
            shot_scale=cue_scale,
            curve_points=curve_points,
            _depth_peak_db=traj_depth_peak_db,
        )
        entry = {
            'id': str(cue_id),
            't_hit': round(t_val, 4),
            'anchor': round(float(anc_val), 4),
            'role': role,
            'bus': bus or ('ui' if role in ('ui', 'subtle_ui') else ('foley' if role == 'foley' else 'fx')),
            'snappedHz': snapped_hz,
            'musicFocusTrimDb': round(focus_trim, 2),
            'suppressed': False,
        }
        self._ledger.append(entry)
        return entry

    def add_foley(
        self,
        cue_id: str,
        wave: np.ndarray,
        t_hit: float,
        *,
        anchor: float = None,
        span_dur: float = None,
        edit_mode: str = 'sustained',
        pan=None,
        screen_ratio=None,
        ref_ratio: float = 0.45,
        ref_dist_m: float = 1.8,
        trajectory: dict = None,
        shot_scale: str = 'medium',
        poa: str = None,
        gain_db: float = 0.0,
        target_lufs: float = None,
        duck_db: float = None,
        continuous_duck_db: float = None,
        curve_points: list = None,
        force_enable: bool = False,
        seed: int = 1,
        _depth_peak_db: float = None,
    ) -> dict:
        """添加生命体/肢体动作拟音事件（自动路由至 foley 分轨；支持 screen_ratio 远近纵深与持续让路；hitech 模式下默认静默抑制）。"""
        if self.suppress_foley and not force_enable:
            self._suppressed_foley.append(str(cue_id))
            return {'id': str(cue_id), 't_hit': round(float(t_hit), 4), 'bus': 'foley', 'suppressed': True}
        return self.add_sfx(
            cue_id,
            wave,
            t_hit,
            anchor=anchor,
            role='foley',
            bus='foley',
            span_dur=span_dur,
            edit_mode=edit_mode,
            pan=pan,
            screen_ratio=screen_ratio,
            ref_ratio=ref_ratio,
            ref_dist_m=ref_dist_m,
            trajectory=trajectory,
            shot_scale=shot_scale,
            poa=poa,
            gain_db=gain_db,
            target_lufs=target_lufs,
            duck_db=duck_db,
            continuous_duck_db=continuous_duck_db,
            curve_points=curve_points,
            negative_space=False,
            seed=seed,
            _depth_peak_db=_depth_peak_db,
        )

    def add_foley_series(
        self,
        prefix: str,
        hit_times,
        *,
        takes,
        forces=None,
        accent_takes=None,
        policy: str = 'anti_fatigue',
        min_tail_s: float = 0.06,
        pan=0.0,
        screen_ratio=None,
        ref_ratio: float = 0.45,
        ref_dist_m: float = 1.8,
        shot_scale: str = 'medium',
        poa: str = None,
        gain_db: float = 0.0,
        target_lufs: float = None,
        continuous_duck_db: float = None,
        force_enable: bool = False,
        seed: int = 1,
    ) -> list:
        """编排一整串连续拟音动作（脚步、骑车踩踏板、连拳）并写入 foley 轨：
        保留 forces 力度动态渐强起伏（不再被单次峰值归一化抹平），并支持 screen_ratio 远近纵深。"""
        times = list(hit_times or [])
        if self.suppress_foley and not force_enable:
            for k in range(len(times)):
                self._suppressed_foley.append(f'{prefix}_{k}')
            return []

        scheduled = schedule_action_series(
            times,
            forces=forces,
            takes=takes,
            accent_takes=accent_takes,
            policy=policy,
            min_tail_s=min_tail_s,
            seed=seed,
            sr=self.sr,
        )
        per_hit_pan = (
            isinstance(pan, (list, tuple))
            and len(pan) == len(scheduled)
            and all(isinstance(v, (int, float)) for v in pan)
        )
        per_hit_sr = (
            isinstance(screen_ratio, (list, tuple))
            and len(screen_ratio) == len(scheduled)
            and all(isinstance(v, (int, float)) for v in screen_ratio)
        )
        kf_sr = (
            isinstance(screen_ratio, (list, tuple))
            and len(screen_ratio) > 0
            and isinstance(screen_ratio[0], (list, tuple))
            and len(screen_ratio[0]) >= 2
        )
        if kf_sr:
            pts_sr = sorted((float(p[0]), float(p[1])) for p in screen_ratio)
            ts_sr = np.array([p[0] for p in pts_sr], dtype=float)
            vs_sr = np.array([p[1] for p in pts_sr], dtype=float)

        for idx, item in enumerate(scheduled):
            p_val = float(pan[idx]) if per_hit_pan else pan
            if per_hit_sr:
                sr_val = float(screen_ratio[idx])
            elif kf_sr:
                sr_val = float(np.interp(float(item['t_hit']), ts_sr, vs_sr))
            else:
                sr_val = screen_ratio
            # 将力度曲线映射为相对 0.72 基准力度的真实分贝起伏，杜绝坐蹬与站起猛蹬被归一化抹平
            f_hit = float(item['meta'].get('force', 0.72))
            force_dyn_db = float(np.clip(18.0 * math.log10(max(f_hit, 0.15) / 0.72), -7.5, 7.5))
            self.add_sfx(
                f'{prefix}_{idx}',
                item['wave'],
                item['t_hit'],
                anchor=item['anchor'],
                role='foley',
                bus='foley',
                pan=p_val,
                screen_ratio=sr_val,
                ref_ratio=ref_ratio,
                ref_dist_m=ref_dist_m,
                shot_scale=shot_scale,
                poa=poa,
                gain_db=float(gain_db) + force_dyn_db,
                target_lufs=target_lufs,
                continuous_duck_db=continuous_duck_db,
                negative_space=False,
                seed=seed + idx,
            )
        return scheduled

    def bind_actor(
        self,
        kin,
        actor_id: str,
        wave: np.ndarray,
        *,
        bus: str = 'fx',
        role: str = 'accent',
        shot_scale: str = 'medium',
        velocity_mps: float = 0.0,
        ref_scale: float = 0.35,
        gain_db: float = 0.0,
        loop_sustained: bool = True,
        seed: int = 0,
    ) -> list:
        """将音效/拟音素材直接绑定至视觉遥测角色轨迹（Visual Telemetry Actor Binding）：
        · 接收 cues.Kinematics（或 dict / kinematics.json 路径），查找 actor_id 轨迹并切分连续可见片段（visible > 0.5）；
        · 从 x 通道提取时间归一化声像点 pan_points，从 scale（或 depth）通道提取视觉占比曲线 screen_ratio；
        · 逐可见片段执行 smart_edit_clip + couple_motion_trajectory 三维空间运动贴合，并经 add_sfx / add_foley 排入工作台。"""
        if kin is None:
            kin_obj = self.mixer.telemetry
        elif isinstance(kin, Kinematics):
            kin_obj = kin
        else:
            kin_obj = load_kinematics(kin, dur=self.dur, sr=self.sr)

        if kin_obj is None or actor_id not in kin_obj.tracks:
            return []

        tr = kin_obj.tracks[actor_id]
        fps_k = float(tr.fps or self.fps)
        n_frames = max((len(v) for v in tr.channels.values()), default=0)
        if n_frames == 0:
            return []

        if 'visible' in tr.channels and len(tr.channels['visible']) > 0:
            vis = np.asarray(tr.channels['visible'], dtype=float) > 0.5
            edges = np.flatnonzero(np.diff(vis.astype(np.int8), prepend=0, append=0) != 0)
            seg_ranges = list(zip(edges[0::2], edges[1::2]))
        else:
            seg_ranges = [(0, n_frames)]

        x_full = tr.channels.get('x')
        scale_full = tr.channels.get('scale')
        depth_full = tr.channels.get('depth')
        edit_mode = 'sustained' if loop_sustained else 'impulsive'
        placed_list = []

        for seg_idx, (f0, f1) in enumerate(seg_ranges):
            f0_i, f1_i = int(f0), int(f1)
            if f1_i <= f0_i:
                continue
            t0 = max(0.0, f0_i / fps_k)
            t1 = min(self.dur, max(t0 + 1.0 / fps_k, f1_i / fps_k))
            if t0 >= self.dur - 1e-4 or (t1 - t0) < 0.015:
                continue
            seg_dur = t1 - t0
            m_f = f1_i - f0_i

            if x_full is not None and len(x_full) > f0_i:
                x_seg = np.asarray(x_full[f0_i:min(f1_i, len(x_full))], dtype=float)
                if float(np.max(np.abs(x_seg))) > 2.0:
                    pan_seg = np.clip((x_seg / 1920.0) * 2.0 - 1.0, -1.0, 1.0)
                else:
                    pan_seg = np.clip(x_seg, -1.0, 1.0)
            else:
                pan_seg = np.zeros(m_f, dtype=float)

            if scale_full is not None and len(scale_full) > f0_i:
                sr_seg = np.clip(np.asarray(scale_full[f0_i:min(f1_i, len(scale_full))], dtype=float), 1e-3, 1.5)
            elif depth_full is not None and len(depth_full) > f0_i:
                d_raw = np.asarray(depth_full[f0_i:min(f1_i, len(depth_full))], dtype=float)
                if float(np.max(d_raw)) <= 1.05 and float(np.min(d_raw)) >= -0.05:
                    d_m = 1.0 + np.clip(d_raw, 0.0, 1.0) * 11.0
                else:
                    d_m = np.maximum(0.25, d_raw)
                sr_seg = np.clip(float(ref_scale) * (1.8 / d_m), 1e-3, 1.5)
            else:
                sr_seg = np.full(m_f, float(ref_scale), dtype=float)

            eff_cut = self._next_hard_cut_after(t0) if not loop_sustained else None
            w_ed, anc = smart_edit_clip(
                wave,
                seg_dur,
                mode=edit_mode,
                next_cut_in_s=eff_cut,
                seed=int(seed) + seg_idx,
                sr=self.sr,
            )
            if len(w_ed) == 0:
                continue

            if not loop_sustained:
                clip_dur = len(w_ed) / float(self.sr)
                if clip_dur < seg_dur and len(pan_seg) >= 2:
                    frac = max(0.05, min(1.0, clip_dur / max(seg_dur, 1e-6)))
                    end_k = max(2, int(math.ceil(len(pan_seg) * frac)))
                    pan_seg = pan_seg[:end_k]
                    sr_seg = sr_seg[:end_k]

            u_grid = np.linspace(0.0, 1.0, len(pan_seg), dtype=float) if len(pan_seg) > 1 else np.array([0.0])
            pan_points_norm = [(round(float(u), 5), round(float(p), 5)) for u, p in zip(u_grid, pan_seg)]

            d_seg_m = screen_scale_to_distance(sr_seg, ref_ratio=float(ref_scale), ref_dist_m=1.8)
            seg_depth_peak_db = float(np.max(depth_gain_db(d_seg_m, ref_dist_m=1.8)))

            w_coupled = couple_motion_trajectory(
                w_ed,
                pan_points=pan_points_norm,
                screen_ratio=sr_seg,
                ref_scale=float(ref_scale),
                radial_velocity_mps=float(velocity_mps),
                shot_scale=shot_scale,
                sr=self.sr,
            )

            cue_id = f'{actor_id}_{seg_idx}'
            t_hit = t0 + float(anc)
            if str(bus).lower() == 'foley':
                entry = self.add_foley(
                    cue_id,
                    w_coupled,
                    t_hit,
                    anchor=anc,
                    pan=0.0,
                    shot_scale=None,
                    poa=None,
                    gain_db=gain_db,
                    seed=int(seed) + seg_idx,
                    _depth_peak_db=seg_depth_peak_db,
                )
            else:
                entry = self.add_sfx(
                    cue_id,
                    w_coupled,
                    t_hit,
                    anchor=anc,
                    role=role,
                    bus=bus,
                    pan=0.0,
                    shot_scale=None,
                    poa=None,
                    gain_db=gain_db,
                    negative_space=False,
                    seed=int(seed) + seg_idx,
                    _depth_peak_db=seg_depth_peak_db,
                )

            placed_list.append({
                'id': cue_id,
                'actor_id': str(actor_id),
                'segment': seg_idx,
                't0': round(t0, 4),
                't1': round(t1, 4),
                'dur': round(seg_dur, 4),
                'bus': entry.get('bus', bus),
                'role': entry.get('role', role),
                'shot_scale': shot_scale,
                'pan_points': pan_points_norm,
                'peak_scale': round(float(np.max(sr_seg)), 4),
                'mean_pan': round(float(np.mean(pan_seg)), 4),
                'suppressed': bool(entry.get('suppressed', False)),
            })
        return placed_list

    def mixdown(self) -> tuple:
        """执行三/四干线协同混音与母带收口：
        返回 (master_st, stems_dict, report_dict)，保证母带目标响度、真峰值 ≤ max_tp、
        直流偏移归零、首尾样本严格为 0.0，包含 'amb', 'fx', 'foley', 'ui', 'music'（设置对白时同步导出 'vo'）。"""
        master_st, raw_stems, diag = self.mixer.render()

        # 若整条混音存在极微弱残余直流偏移，平滑居中校正并守住真峰值与首尾归零
        dc_bias = master_st.mean(axis=0)
        if float(np.max(np.abs(dc_bias))) > 5e-4:
            master_st = fade(master_st - dc_bias[None, :], min(0.015, self.dur * 0.04), min(0.08, self.dur * 0.08))

        tp_lin = true_peak(master_st, os=4)
        tp_ceil_lin = float(undb(self.max_tp - 0.02))
        if tp_lin > tp_ceil_lin and tp_lin > 0.0:
            shrink = tp_ceil_lin / tp_lin
            master_st = master_st * shrink
        else:
            shrink = 1.0

        master_st[0] = 0.0
        master_st[-1] = 0.0

        stem_keys = ('amb', 'fx', 'foley', 'ui', 'music', 'vo') if 'vo' in raw_stems else ('amb', 'fx', 'foley', 'ui', 'music')
        stems_dict = {}
        stems_lufs = {}
        for k in stem_keys:
            st = np.asarray(raw_stems.get(k, np.zeros((self.n, 2), dtype=float)), dtype=float) * shrink
            if len(st) > 0:
                st = fade(st, min(0.005, self.dur * 0.02), min(0.020, self.dur * 0.04))
                st[0] = 0.0
                st[-1] = 0.0
            stems_dict[k] = st
            l_val = integrated(st) if self.dur >= 0.45 and float(np.max(np.abs(st))) > 1e-6 else -np.inf
            stems_lufs[k] = round(float(l_val), 2) if np.isfinite(l_val) else None

        out_lufs = integrated(master_st)
        out_tp_db = 20.0 * math.log10(max(true_peak(master_st, os=4), 1e-12))
        report = dict(diag)
        report.update({
            'world': self.world,
            'key': self.key,
            'integratedLufs': round(float(out_lufs), 2) if np.isfinite(out_lufs) else None,
            'truePeakDbtp': round(float(out_tp_db), 2),
            'stemsLufs': stems_lufs,
            'suppressedFoleyIds': list(self._suppressed_foley),
            'musicFocusTrimmedIds': list(self._focus_trimmed_ids),
            'tonalSnapped': list(self._tonal_snaps),
            'cueCount': len(self._ledger),
        })
        return master_st, stems_dict, report


FourStemWorkstation = ThreeStemWorkstation
