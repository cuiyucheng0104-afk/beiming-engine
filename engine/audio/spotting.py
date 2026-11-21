# -*- coding: utf-8 -*-
"""北冥引擎 · 画面自动打点与空间轨迹提取器（Visual Spotting & Spatial Trajectory Analyzer）。

连接两条输入路径到同一套声学编排管线（editorial.couple_motion_trajectory / ThreeStemWorkstation）：
  1) spot_from_kinematics(kin, ...)  解析页面遥测（kinematics.json / cues.Kinematics）：
     自动识别硬切点（cuts）、镜头分段统计（shots）、静态留白呼吸段（holds）、
     排除切点伪峰后的画面动作重音峰（motion_peaks），以及各发声角色的可见时间段（spans）、
     声像关键帧（pan_points）、画面高度占比曲线（screen_ratio）、径向多普勒速度与碰撞脉冲（impulses）。
  2) spot_from_video(video_path, ...) 对无 HTML 源码的预渲染 MP4 视频流式抽取同构的 cues.Kinematics：
     经 engine.audio._env 调用 ffprobe / ffmpeg 管道流式解码缩略灰度帧（O(1) 帧内存），
     计算逐帧亮度、对比度（p95-p05）、3×3 平滑帧差运动能量、横向视觉运动重心 x ∈ [-1, 1]、
     左/中/右三区局部活动度（left_zone / center_zone / right_zone）、硬切跳变与静止保持门限。
"""
import json
import math
import os
import subprocess

import numpy as np

from . import _env
from .cues import Kinematics, Track
from .director import screen_scale_to_distance
from .dsp import SR

__all__ = [
    'spot_from_kinematics',
    'spot_from_video',
]


def _parse_fps(rate_str) -> float:
    if isinstance(rate_str, (int, float)):
        v = float(rate_str)
        return v if math.isfinite(v) and v > 0.0 else 0.0
    s = str(rate_str or '').strip()
    if not s or s == '0/0':
        return 0.0
    if '/' in s:
        num_s, den_s = s.split('/', 1)
        try:
            num, den = float(num_s), float(den_s)
            return num / den if den > 0.0 and num > 0.0 else 0.0
        except ValueError:
            return 0.0
    try:
        v = float(s)
        return v if math.isfinite(v) and v > 0.0 else 0.0
    except ValueError:
        return 0.0


def _read_exact(stream, n_bytes: int) -> bytes:
    chunks = []
    rem = n_bytes
    while rem > 0:
        buf = stream.read(rem)
        if not buf:
            break
        chunks.append(buf)
        rem -= len(buf)
    return b''.join(chunks)


def _percentiles_05_95(frame_u8: np.ndarray, total: int) -> tuple:
    cdf = np.cumsum(np.bincount(frame_u8.ravel(), minlength=256))
    p05 = float(np.searchsorted(cdf, total * 0.05, side='left'))
    p95 = float(np.searchsorted(cdf, total * 0.95, side='left'))
    return min(255.0, p05), min(255.0, p95)


def _normalize_pan_seq(seq: np.ndarray, screen_w: float = 1920.0) -> np.ndarray:
    arr = np.asarray(seq, dtype=float).reshape(-1)
    if len(arr) == 0:
        return np.zeros(0, dtype=float)
    max_abs = float(np.max(np.abs(arr)))
    if max_abs <= 1.5:
        return np.clip(arr, -1.0, 1.0)
    return np.clip((arr / max(float(screen_w), 1.0)) * 2.0 - 1.0, -1.0, 1.0)


def _resolve_scale_seq(tr: Track, n_len: int) -> np.ndarray:
    if 'scale' in tr.channels and len(tr.channels['scale']) > 0:
        return np.clip(np.asarray(tr.channels['scale'][:n_len], dtype=float), 1e-4, 1.5)
    if 'screen_ratio' in tr.channels and len(tr.channels['screen_ratio']) > 0:
        return np.clip(np.asarray(tr.channels['screen_ratio'][:n_len], dtype=float), 1e-4, 1.5)
    if 'depth' in tr.channels and len(tr.channels['depth']) > 0:
        d_raw = np.asarray(tr.channels['depth'][:n_len], dtype=float)
        if float(np.max(d_raw)) <= 1.05 and float(np.min(d_raw)) >= -0.05:
            d_m = 0.8 + np.clip(d_raw, 0.0, 1.0) * (12.0 - 0.8)
        else:
            d_m = np.maximum(0.15, d_raw)
        inv_exp = 1.0 / 0.95
        est = 0.45 * ((1.8 / d_m) ** inv_exp)
        return np.clip(est, 0.02, 1.5)
    return np.full(n_len, 0.35, dtype=float)


def _contiguous_runs(mask: np.ndarray, split_frames: set = None) -> list:
    runs = []
    n = len(mask)
    if n == 0:
        return runs
    splits = split_frames or set()
    start = None
    for i in range(n):
        if start is not None and i in splits:
            runs.append((start, i))
            start = None
        if bool(mask[i]):
            if start is None:
                start = i
        elif start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, n))
    return runs


def _estimate_radial_velocity(pan_seg: np.ndarray, scale_seg: np.ndarray, depth_seg, fps: float) -> float:
    m = len(scale_seg)
    if m < 2 or fps <= 0.0:
        return 0.0
    if depth_seg is not None and len(depth_seg) == m and float(np.max(depth_seg)) > 1.05:
        dist_m = np.maximum(0.1, np.asarray(depth_seg, dtype=float))
    else:
        z_m = screen_scale_to_distance(scale_seg, ref_ratio=0.45, ref_dist_m=1.8)
        x_m = pan_seg * (0.65 * z_m)
        dist_m = np.sqrt(z_m * z_m + x_m * x_m)

    v_rad = -np.gradient(dist_m) * float(fps)
    abs_v = np.abs(v_rad)
    p90 = float(np.percentile(abs_v, 90.0))
    if p90 < 1e-3:
        return 0.0
    mean_v = float(np.mean(v_rad))
    signed = math.copysign(p90, mean_v) if abs(mean_v) >= 0.25 * p90 else p90
    return round(float(np.clip(signed, -35.0, 35.0)), 4)


def _coerce_kinematics_and_cuts(kin) -> tuple:
    extra_cuts = []
    if isinstance(kin, Kinematics):
        dc = getattr(kin, 'detected_cuts', None) or getattr(kin, 'detectedCuts', None)
        if dc:
            extra_cuts = [int(c) for c in dc if int(c) >= 1]
        return kin, extra_cuts

    if isinstance(kin, (str, os.PathLike)):
        p = str(kin)
        p = os.path.join(p, 'kinematics.json') if os.path.isdir(p) else p
        with open(p, encoding='utf-8') as f:
            raw = json.load(f)
    elif isinstance(kin, dict):
        raw = dict(kin)
    else:
        raise TypeError(f'spot_from_kinematics：不支持的输入类型 {type(kin).__name__}')

    dc = raw.get('detectedCuts') or raw.get('detected_cuts') or []
    extra_cuts = [int(c) for c in dc if int(c) >= 1]
    return Kinematics(raw), extra_cuts


def spot_from_kinematics(
    kin,
    *,
    prominence: float = 0.16,
    min_gap_s: float = 0.12,
    min_visible_frames: int = 2,
) -> dict:
    """从 kinematics.json / cues.Kinematics 自动提取切点、镜头统计、静止呼吸窗、动作峰值与角色三维声像轨迹。"""
    kin_obj, extra_cuts = _coerce_kinematics_and_cuts(kin)
    fps = max(1e-3, float(kin_obj.fps or 24.0))

    max_ch_len = 0
    for tr in kin_obj.tracks.values():
        for seq in tr.channels.values():
            if len(seq) > max_ch_len:
                max_ch_len = len(seq)

    dur = float(kin_obj.dur) if kin_obj.dur and kin_obj.dur > 0.0 else (max_ch_len / fps if max_ch_len > 0 else 0.0)
    n_frames = max_ch_len if max_ch_len > 0 else max(0, int(round(dur * fps)))

    screen = kin_obj.tracks.get('screen') or Track({}, fps=fps, dur=dur, sr=kin_obj.sr)
    luma_arr = np.asarray(screen.channels.get('luma', []), dtype=float)
    motion_arr = np.asarray(screen.channels.get('motion', []), dtype=float)
    cut_arr = np.asarray(screen.channels.get('cut', []), dtype=float)
    hold_arr = np.asarray(screen.channels.get('hold', []), dtype=float)
    pan_screen = _normalize_pan_seq(screen.channels.get('x', []))

    cut_frame_set = set(extra_cuts)
    for idx, cv in enumerate(cut_arr):
        if idx >= 1 and float(cv) > 0.5:
            cut_frame_set.add(int(idx))
    if n_frames > 0:
        cut_frame_set = {f for f in cut_frame_set if 1 <= f < n_frames}

    sorted_cut_frames = sorted(cut_frame_set)
    cuts = [{'frame': int(f), 't': round(float(f) / fps, 6)} for f in sorted_cut_frames]

    # 1. 按切点分割镜头（shots）
    shots = []
    if n_frames > 0:
        edges = [0, *sorted_cut_frames, n_frames]
        for s_idx, (f0, f1) in enumerate(zip(edges[:-1], edges[1:])):
            t0 = round(float(f0) / fps, 6)
            t1 = round(dur if (f1 == n_frames and dur > 0.0) else (float(f1) / fps), 6)
            m_seg = motion_arr[f0:min(f1, len(motion_arr))] if len(motion_arr) > f0 else np.zeros(0)
            l_seg = luma_arr[f0:min(f1, len(luma_arr))] if len(luma_arr) > f0 else np.zeros(0)
            shots.append({
                'index': int(s_idx),
                't0': t0,
                't1': t1,
                'mean_motion': round(float(np.mean(m_seg)) if len(m_seg) > 0 else 0.0, 5),
                'mean_luma': round(float(np.mean(l_seg)) if len(l_seg) > 0 else 0.0, 5),
            })
    elif dur > 0.0:
        shots.append({'index': 0, 't0': 0.0, 't1': round(dur, 6), 'mean_motion': 0.0, 'mean_luma': 0.0})

    # 2. 提取静态呼吸留白段（holds：hold > 0.5 持续 ≥ 0.25 s，不跨越硬切点）
    holds = []
    if len(hold_arr) > 0:
        hold_mask = hold_arr > 0.5
    elif len(motion_arr) > 0:
        hold_mask = motion_arr <= 0.02
    else:
        hold_mask = np.zeros(0, dtype=bool)

    for f0, f1 in _contiguous_runs(hold_mask, split_frames=cut_frame_set):
        if (f1 - f0) / fps >= 0.25 - 1e-9:
            t0 = round(float(f0) / fps, 6)
            t1 = round(min(dur, float(f1) / fps) if dur > 0.0 else float(f1) / fps, 6)
            if t1 > t0:
                holds.append((t0, t1))

    # 3. 提取离散画面动作重音峰（motion_peaks：排除切点 ±1 帧，按局部显著度与最小间隔筛选）
    motion_peaks = []
    m_len = len(motion_arr)
    if m_len > 0:
        cut_excl = {cf + d for cf in cut_frame_set for d in (-1, 0, 1)}
        prom = max(0.0, float(prominence))
        win_rad = max(3, int(round(0.35 * fps)))

        shot_bounds = [(0, m_len)]
        if sorted_cut_frames:
            edges_m = [0, *[c for c in sorted_cut_frames if 0 < c < m_len], m_len]
            shot_bounds = list(zip(edges_m[:-1], edges_m[1:]))

        def _shot_range(fi: int) -> tuple:
            for a, b in shot_bounds:
                if a <= fi < b:
                    return a, b
            return 0, m_len

        candidates = []
        for i in range(m_len):
            if i in cut_excl:
                continue
            v = float(motion_arr[i])
            if v < prom:
                continue
            prev_v = float(motion_arr[i - 1]) if i > 0 else v
            next_v = float(motion_arr[i + 1]) if i + 1 < m_len else v
            if v < prev_v or v < next_v:
                continue
            if i > 0 and v == prev_v:
                continue
            s_a, s_b = _shot_range(i)
            w0 = max(s_a, i - win_rad)
            w1 = min(s_b, i + win_rad + 1)
            local_min = float(np.min(motion_arr[w0:w1])) if w1 > w0 else 0.0
            if (v - local_min) >= prom * 0.5:
                pan_i = float(pan_screen[i]) if i < len(pan_screen) else 0.0
                candidates.append((v, i, pan_i))

        # 按强度降序贪心去重，保证主冲击峰不被前导微抖动吞掉
        candidates.sort(key=lambda it: (-it[0], it[1]))
        kept = []
        gap_s = max(0.0, float(min_gap_s))
        for v, i, pan_i in candidates:
            t_cand = float(i) / fps
            if all(abs(t_cand - (float(k[1]) / fps)) >= gap_s - 1e-9 for k in kept):
                kept.append((v, i, pan_i))
        kept.sort(key=lambda it: it[1])
        for v, i, pan_i in kept:
            motion_peaks.append({
                't': round(float(i) / fps, 6),
                'frame': int(i),
                'intensity': round(float(np.clip(v, 0.0, 1.0)), 4),
                'pan': round(float(np.clip(pan_i, -1.0, 1.0)), 4),
            })

    # 4. 提取非 screen 角色轨迹（actors）
    actors = {}
    min_vf = max(1, int(min_visible_frames))
    for actor_id, tr in kin_obj.tracks.items():
        if actor_id == 'screen':
            continue
        m_tr = max((len(v) for v in tr.channels.values()), default=0)
        if m_tr == 0:
            actors[actor_id] = {
                'spans': [],
                'pan_points': [],
                'screen_ratio': [],
                'peak_scale': 0.0,
                'mean_pan': 0.0,
                'radial_velocity_mps': 0.0,
                'impulses': [],
                'segments': [],
            }
            continue

        pan_seq = _normalize_pan_seq(tr.channels.get('x', np.zeros(m_tr, dtype=float)))
        if len(pan_seq) < m_tr:
            pan_seq = np.pad(pan_seq, (0, m_tr - len(pan_seq)), mode='edge' if len(pan_seq) else 'constant')
        scale_seq = _resolve_scale_seq(tr, m_tr)
        if len(scale_seq) < m_tr:
            scale_seq = np.pad(scale_seq, (0, m_tr - len(scale_seq)), mode='edge')
        depth_seq = tr.channels.get('depth')

        has_vis = 'visible' in tr.channels and len(tr.channels['visible']) > 0
        if has_vis:
            vis_arr = np.asarray(tr.channels['visible'][:m_tr], dtype=float)
            vis_runs = [(f0, f1) for f0, f1 in _contiguous_runs(vis_arr > 0.5) if (f1 - f0) >= min_vf]
        else:
            vis_arr = np.ones(m_tr, dtype=float)
            vis_runs = [(0, m_tr)] if m_tr >= min_vf else []

        spans = []
        segments = []
        vis_indices = []
        seg_vels = []

        for f0, f1 in vis_runs:
            t0 = round(float(f0) / fps, 6)
            t1 = round(min(dur, float(f1) / fps) if dur > 0.0 else float(f1) / fps, 6)
            if t1 <= t0:
                continue
            spans.append((t0, t1))
            vis_indices.extend(range(f0, f1))

            p_seg = pan_seq[f0:f1]
            s_seg = scale_seq[f0:f1]
            d_seg = depth_seq[f0:f1] if depth_seq is not None and len(depth_seq) >= f1 else None
            seg_len = len(p_seg)
            seg_pan_pts = [
                (round(j / max(1, seg_len - 1), 6), round(float(p_seg[j]), 5))
                for j in range(seg_len)
            ]
            if seg_len == 1:
                seg_pan_pts = [(0.0, round(float(p_seg[0]), 5)), (1.0, round(float(p_seg[0]), 5))]
            seg_sr = [round(float(v), 5) for v in s_seg]
            seg_v = _estimate_radial_velocity(p_seg, s_seg, d_seg, fps)
            seg_vels.append(seg_v)
            segments.append({
                't0': t0,
                't1': t1,
                'pan_points': seg_pan_pts,
                'screen_ratio': seg_sr,
                'peak_scale': round(float(np.max(s_seg)), 5),
                'mean_pan': round(float(np.mean(p_seg)), 5),
                'radial_velocity_mps': seg_v,
            })

        if vis_indices:
            idx_arr = np.array(vis_indices, dtype=int)
            p_vis = pan_seq[idx_arr]
            s_vis = scale_seq[idx_arr]
            f_first = float(idx_arr[0])
            f_span = max(1.0, float(idx_arr[-1] - idx_arr[0]))
            if len(idx_arr) == 1:
                pan_points = [(0.0, round(float(p_vis[0]), 5)), (1.0, round(float(p_vis[0]), 5))]
            else:
                pan_points = [
                    (round((float(fi) - f_first) / f_span, 6), round(float(pv), 5))
                    for fi, pv in zip(idx_arr, p_vis)
                ]
            screen_ratio_list = [round(float(v), 5) for v in s_vis]
            peak_scale = round(float(np.max(s_vis)), 5)
            mean_pan = round(float(np.mean(p_vis)), 5)
            rad_vel = max(seg_vels, key=abs) if seg_vels else 0.0
        else:
            pan_points = []
            screen_ratio_list = []
            peak_scale = 0.0
            mean_pan = 0.0
            rad_vel = 0.0

        impulses = []
        for imp_key in ('impact', 'impulse', 'contact', 'hit'):
            if imp_key in tr.channels and len(tr.channels[imp_key]) > 0:
                raw_hits = tr.impulses(imp_key, thresh=0.35, min_gap_s=min_gap_s)
                for t_imp, strength in raw_hits:
                    fi = min(m_tr - 1, max(0, int(round(t_imp * fps))))
                    if not has_vis or float(vis_arr[fi]) > 0.5:
                        impulses.append((round(float(t_imp), 6), round(float(strength), 5)))
                break

        actors[actor_id] = {
            'spans': spans,
            'pan_points': pan_points,
            'screen_ratio': screen_ratio_list,
            'peak_scale': peak_scale,
            'mean_pan': mean_pan,
            'radial_velocity_mps': rad_vel,
            'impulses': impulses,
            'segments': segments,
        }

    return {
        'fps': round(fps, 6),
        'dur': round(dur, 6),
        'cuts': cuts,
        'shots': shots,
        'holds': holds,
        'motion_peaks': motion_peaks,
        'actors': actors,
    }


def spot_from_video(
    video_path: str,
    *,
    sample_w: int = 240,
    max_fps: float = 30.0,
) -> Kinematics:
    """用 ffprobe / ffmpeg 流式读取预渲染视频缩略灰度帧，构建与页面真遥测同构的 cues.Kinematics。"""
    vpath = os.fspath(video_path)
    if not os.path.isfile(vpath):
        raise FileNotFoundError(f'spot_from_video：找不到视频文件 {vpath}')

    probe_res = _env.run([
        _env.ffprobe(), '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration',
        '-of', 'json',
        vpath,
    ], capture_output=True, timeout=30)
    if probe_res.returncode != 0:
        err_msg = (probe_res.stderr or b'').decode('utf-8', errors='replace').strip()
        raise RuntimeError(f'spot_from_video：ffprobe 探测失败（退出码 {probe_res.returncode}）：{err_msg}')

    meta = json.loads((probe_res.stdout or b'{}').decode('utf-8', errors='replace'))
    streams = meta.get('streams') or []
    if not streams:
        raise ValueError(f'spot_from_video：视频中没有视频流 {vpath}')
    st0 = streams[0]
    src_w = max(2, int(st0.get('width') or 1920))
    src_h = max(2, int(st0.get('height') or 1080))
    src_fps = _parse_fps(st0.get('avg_frame_rate')) or _parse_fps(st0.get('r_frame_rate')) or 24.0

    dur_probe = 0.0
    for cand in (st0.get('duration'), (meta.get('format') or {}).get('duration')):
        try:
            v = float(cand)
            if math.isfinite(v) and v > 0.0:
                dur_probe = v
                break
        except (TypeError, ValueError):
            pass

    cap_fps = max(1.0, float(max_fps))
    if src_fps <= cap_fps + 1e-3:
        eff_fps = src_fps
        use_fps_filter = False
    else:
        div = max(2, int(math.ceil(src_fps / cap_fps - 1e-6)))
        sub_fps = src_fps / float(div)
        eff_fps = sub_fps if sub_fps >= cap_fps * 0.65 else cap_fps
        use_fps_filter = True

    sw = max(16, int(round(float(sample_w))) & ~1)
    sh = max(16, int(round(sw * float(src_h) / float(src_w))) & ~1)
    frame_pixels = sw * sh

    vf_parts = []
    if use_fps_filter:
        vf_parts.append(f'fps={eff_fps:.6f}')
    vf_parts.append(f'scale={sw}:{sh}:flags=bilinear,format=gray')

    cmd = [
        _env.ffmpeg(), '-v', 'error', '-nostdin',
        '-i', vpath,
        '-vf', ','.join(vf_parts),
        '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ]

    x_1d = np.linspace(-1.0, 1.0, sw, dtype=np.float32)
    c1 = max(1, sw // 3)
    c2 = max(c1 + 1, (2 * sw) // 3)
    inv_255 = np.float32(1.0 / 255.0)
    inv_nine = np.float32(1.0 / 9.0)

    luma_list = []
    contrast_list = []
    raw_diff = []
    diff_frac = []
    raw_pan = []
    w_active_list = []
    raw_left = []
    raw_center = []
    raw_right = []
    area_left = []
    area_center = []
    area_right = []
    pan_left = []
    pan_center = []
    pan_right = []

    prev_blur = None
    stderr_bytes = b''
    with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        try:
            while True:
                raw_buf = _read_exact(proc.stdout, frame_pixels)
                if len(raw_buf) < frame_pixels:
                    break
                frame_u8 = np.frombuffer(raw_buf, dtype=np.uint8).reshape((sh, sw))
                p05, p95 = _percentiles_05_95(frame_u8, frame_pixels)
                contrast_list.append(round((p95 - p05) / 255.0, 4))

                f_norm = frame_u8.astype(np.float32) * inv_255
                luma_list.append(round(float(f_norm.mean()), 4))
                pad = np.pad(f_norm, 1, mode='edge')
                cur_blur = (
                    pad[:-2, :-2] + pad[:-2, 1:-1] + pad[:-2, 2:]
                    + pad[1:-1, :-2] + pad[1:-1, 1:-1] + pad[1:-1, 2:]
                    + pad[2:, :-2] + pad[2:, 1:-1] + pad[2:, 2:]
                ) * inv_nine

                if prev_blur is not None:
                    diff = np.abs(cur_blur - prev_blur)
                    col_diff = diff.sum(axis=0)
                    raw_diff.append(float(col_diff.sum()) / frame_pixels)
                    diff_frac.append(float(np.count_nonzero(diff > 0.08)) / frame_pixels)

                    act = diff > 0.018
                    w_diff = np.where(act, diff, np.float32(0.0))
                    col_w = w_diff.sum(axis=0)
                    wl = float(col_w[:c1].sum())
                    wc = float(col_w[c1:c2].sum())
                    wr = float(col_w[c2:].sum())
                    w_tot = wl + wc + wr
                    w_active_list.append(w_tot)
                    if w_tot > 0.15:
                        raw_pan.append(float(np.dot(col_w, x_1d)) / w_tot)
                    else:
                        raw_pan.append(0.0)

                    raw_left.append(float(col_diff[:c1].sum()) / (sh * c1))
                    raw_center.append(float(col_diff[c1:c2].sum()) / (sh * (c2 - c1)))
                    raw_right.append(float(col_diff[c2:].sum()) / (sh * (sw - c2)))

                    col_act = np.count_nonzero(act, axis=0)
                    area_left.append(float(col_act[:c1].sum()) / frame_pixels)
                    area_center.append(float(col_act[c1:c2].sum()) / frame_pixels)
                    area_right.append(float(col_act[c2:].sum()) / frame_pixels)

                    pan_left.append(float(np.dot(col_w[:c1], x_1d[:c1])) / wl if wl > 0.05 else -0.66667)
                    pan_center.append(float(np.dot(col_w[c1:c2], x_1d[c1:c2])) / wc if wc > 0.05 else 0.0)
                    pan_right.append(float(np.dot(col_w[c2:], x_1d[c2:])) / wr if wr > 0.05 else 0.66667)
                else:
                    raw_diff.append(0.0)
                    diff_frac.append(0.0)
                    w_active_list.append(0.0)
                    raw_pan.append(0.0)
                    raw_left.append(0.0)
                    raw_center.append(0.0)
                    raw_right.append(0.0)
                    area_left.append(0.0)
                    area_center.append(0.0)
                    area_right.append(0.0)
                    pan_left.append(-0.66667)
                    pan_center.append(0.0)
                    pan_right.append(0.66667)

                prev_blur = cur_blur

            stderr_bytes = proc.stderr.read() if proc.stderr else b''
            proc.wait(timeout=15)
        except BaseException:
            _env.kill_tree(proc)
            raise

    if proc.returncode != 0:
        err_msg = stderr_bytes.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f'spot_from_video：ffmpeg 解码失败（退出码 {proc.returncode}）：{err_msg}')

    n_frames = len(luma_list)
    eff_dur = dur_probe if (dur_probe > 0.0 and abs(dur_probe - n_frames / eff_fps) <= 2.0 / eff_fps) else (n_frames / eff_fps)

    if n_frames == 0:
        empty_kin = Kinematics({'fps': eff_fps, 'dur': 0.0, 'tracks': {'screen': {}, 'left_zone': {}, 'center_zone': {}, 'right_zone': {}}}, dur=0.0, sr=SR)
        empty_kin.detected_cuts = []
        empty_kin.sample_size = (sw, sh)
        return empty_kin

    sorted_diff = sorted(raw_diff[1:]) if n_frames > 1 else [0.01]
    med_diff = sorted_diff[len(sorted_diff) // 2] if sorted_diff else 0.01
    p92_diff = sorted_diff[min(len(sorted_diff) - 1, int(len(sorted_diff) * 0.92))] if sorted_diff else 0.05
    norm_denom = max(0.020, p92_diff * 1.35)

    cut_flags = [0] * n_frames
    hold_flags = [0] * n_frames
    motion = [0.0] * n_frames
    left_motion = [0.0] * n_frames
    center_motion = [0.0] * n_frames
    right_motion = [0.0] * n_frames
    detected_cuts = []

    for f in range(1, n_frames):
        prev_d = raw_diff[f - 1] if f > 1 else med_diff
        next_d = raw_diff[f + 1] if f + 1 < n_frames else med_diff
        local_base = max(0.010, min(prev_d, next_d))
        is_cut = (
            (raw_diff[f] > 0.055 and raw_diff[f] > local_base * 3.2 and diff_frac[f] > 0.15)
            or (raw_diff[f] > 0.12 and raw_diff[f] > local_base * 4.5)
        )
        if is_cut:
            cut_flags[f] = 1
            detected_cuts.append(f)
            motion[f] = motion[f - 1]
            left_motion[f] = left_motion[f - 1]
            center_motion[f] = center_motion[f - 1]
            right_motion[f] = right_motion[f - 1]
        else:
            motion[f] = round(min(1.0, raw_diff[f] / norm_denom), 4)
            left_motion[f] = round(min(1.0, raw_left[f] / norm_denom), 4)
            center_motion[f] = round(min(1.0, raw_center[f] / norm_denom), 4)
            right_motion[f] = round(min(1.0, raw_right[f] / norm_denom), 4)
            if raw_diff[f] < max(0.0018, med_diff * 0.18):
                hold_flags[f] = 1

    # 按镜头分段做横向视觉重心 EMA 平滑（硬切后立即锁定新镜头重心，不被上一镜残留声像拖偏）
    motion_pan = [0.0] * n_frames
    has_pan = False
    last_pan = 0.0
    for f in range(1, n_frames):
        if cut_flags[f] == 1:
            has_pan = False
            motion_pan[f] = round(last_pan, 4)
            continue
        if w_active_list[f] > 0.15:
            if not has_pan:
                last_pan = raw_pan[f]
                has_pan = True
            else:
                last_pan = last_pan * 0.35 + raw_pan[f] * 0.65
        motion_pan[f] = round(float(np.clip(last_pan, -1.0, 1.0)), 4)

    if n_frames > 1 and cut_flags[1] == 0:
        motion[0] = motion[1]
        left_motion[0] = left_motion[1]
        center_motion[0] = center_motion[1]
        right_motion[0] = right_motion[1]
        motion_pan[0] = motion_pan[1]
        hold_flags[0] = hold_flags[1]
        area_left[0] = area_left[1]
        area_center[0] = area_center[1]
        area_right[0] = area_right[1]
        pan_left[0] = pan_left[1]
        pan_center[0] = pan_center[1]
        pan_right[0] = pan_right[1]

    def _build_zone_track(z_motion, z_pan, z_area):
        vis = [1 if m_val > 0.08 else 0 for m_val in z_motion]
        sc = [round(float(np.clip(math.sqrt(max(0.0, a * 3.0)), 0.04, 1.0)), 4) for a in z_area]
        imp = [0.0] * n_frames
        for idx in range(1, n_frames):
            if cut_flags[idx] == 0:
                imp[idx] = round(max(0.0, z_motion[idx] - z_motion[idx - 1]), 4)
        return {
            'motion': z_motion,
            'x': [round(float(np.clip(p, -1.0, 1.0)), 4) for p in z_pan],
            'scale': sc,
            'visible': vis,
            'impact': imp,
        }

    raw_doc = {
        'fps': round(eff_fps, 6),
        'dur': round(eff_dur, 6),
        'sampleSize': [sw, sh],
        'detectedCuts': detected_cuts,
        'tracks': {
            'screen': {
                'luma': luma_list,
                'contrast': contrast_list,
                'motion': motion,
                'x': motion_pan,
                'left_motion': left_motion,
                'center_motion': center_motion,
                'right_motion': right_motion,
                'cut': cut_flags,
                'hold': hold_flags,
            },
            'left_zone': _build_zone_track(left_motion, pan_left, area_left),
            'center_zone': _build_zone_track(center_motion, pan_center, area_center),
            'right_zone': _build_zone_track(right_motion, pan_right, area_right),
        },
    }
    kin_out = Kinematics(raw_doc, dur=eff_dur, sr=SR)
    kin_out.detected_cuts = list(detected_cuts)
    kin_out.sample_size = (sw, sh)
    return kin_out
