# -*- coding: utf-8 -*-
"""北冥引擎 · 纯 CPU 运动学对冲击同步核（L3 模块 C，替代 Synchformer，目标精度 ≤ 1 帧 @24 fps）。

从页面逐帧遥测（kinematics.json，主路径 `actor` 加速度突峰 → 退化 `screen.motion`）或无遥测成品视频
（ffmpeg 流式解码灰度缩略帧差 `d1` / 正部二阶差分 `d2+`）提取视觉运动冲击包络，与音频多频带 Onset Flux
做归一化互相关（抛物线亚帧内插），内置一拍二（12 fps 重复帧）抗 12 Hz 梳状伪峰零相移守卫 [0.25, 0.5, 0.25]。

接口：
  FfmpegUnavailableError                    无可用 ffmpeg 时抛出（CLI 映射 EXIT.ENV = 3）
  load_audio_mono(path, target_sr=SR)       加载 WAV/FLAC/OGG/MP3 为单声道 float64 并重采样到 48 kHz
  load_kinematics(source)                   读取 dict / cues.Kinematics / kinematics.json 路径或目录
  detect_actor_on_twos(kin)                 检测角色遥测是否呈一拍二（12 fps 重复帧）形态
  motion_from_kinematics(kin, path='auto')  从遥测提取归一化运动冲击包络，返回 (curve, resolved_path)
  extract_video_frames(video_path, ...)     经 ffmpeg 管道抽取灰度缩略帧 [n_frames, w*h] 与 fps
  video_motion_curves(frames, n_frames)     计算帧对齐帧差 d1 与正部二阶差分 d2+
  apply_on_twos_guard(motion, ...)          检测并抑制 12 Hz 一拍二零值梳状峰（零相移 [0.25, 0.5, 0.25]）
  onset_flux(x, sr=SR, ...)                 计算音频 6 频带相对对数冲击包络（boundary='zeros' 居中帧格池化）
  xcorr_offset_frames(motion, flux, ...)    归一化互相关 + 抛物线亚帧内插求音画偏移（正值 = 音频滞后画面）
  estimate_offset_frames(motion, audio, ...) 端到端单条曲线偏移估计
  evaluate_sync(audio, ...)                 完整同步评测（含轨别标注、一拍二守卫、门限分级与结构化结果）
  python -m engine.audio.sync_kernel        独立命令行入口（退出码 0 通过、2 用法、3 缺输入或 ffmpeg、4 同步超差）
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import time

import numpy as np
from scipy.signal import resample_poly, stft

from . import _env
from ._cli import ArgumentParser, CliError, rel as _rel, run as run_cli
from .dsp import SR

DEFAULT_FPS = 24.0
ON_TWOS_KERNEL = np.array([0.25, 0.5, 0.25], dtype=np.float64)
DRIFT_FAIL_24FPS = 1.5
DRIFT_WARN_12FPS = 1.1
DRIFT_FAIL_12FPS = 1.5
MIN_PEAK_CORR = 0.10


class FfmpegUnavailableError(RuntimeError):
    """系统未安装或未配置可执行 ffmpeg 时抛出，供上层映射标准退出码 3（EXIT.ENV）。"""


def _resolve_bin(cmd: str) -> str | None:
    if not cmd:
        return None
    if os.path.sep in cmd or (os.path.altsep and os.path.altsep in cmd):
        return cmd if os.path.isfile(cmd) else None
    return shutil.which(cmd)


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


def load_audio_mono(path: str | os.PathLike, target_sr: int = SR) -> tuple[np.ndarray, int]:
    """读取音频文件并转为单声道 float64，采样率不一致时做有理数多相重采样。"""
    import soundfile as sf

    x, sr = sf.read(os.fspath(path), dtype='float64', always_2d=True)
    m = x.mean(axis=1)
    sr_i = int(sr)
    if target_sr and sr_i != int(target_sr):
        g = math.gcd(int(target_sr), sr_i)
        m = resample_poly(m, int(target_sr) // g, sr_i // g)
        sr_i = int(target_sr)
    return np.asarray(m, dtype=np.float64), sr_i


def load_kinematics(source) -> dict:
    """加载并规范化遥测字典（支持 dict、cues.Kinematics、JSON 文件路径或包含 kinematics.json 的目录）。"""
    if isinstance(source, (str, os.PathLike)):
        p = os.fspath(source)
        if os.path.isdir(p):
            p = os.path.join(p, 'kinematics.json')
        with open(p, encoding='utf-8') as f:
            raw = json.load(f)
    elif hasattr(source, 'tracks') and hasattr(source, 'fps') and not isinstance(source, dict):
        tracks = {}
        for name, tr in (getattr(source, 'tracks', None) or {}).items():
            chans = getattr(tr, 'channels', None)
            if isinstance(chans, dict):
                tracks[str(name)] = {k: np.asarray(v, dtype=np.float64) for k, v in chans.items()}
            elif isinstance(tr, dict):
                tracks[str(name)] = tr
        raw = {
            'fps': float(getattr(source, 'fps', DEFAULT_FPS) or DEFAULT_FPS),
            'dur': float(getattr(source, 'dur', 0.0) or 0.0),
            'tracks': tracks,
        }
    elif isinstance(source, dict):
        raw = dict(source)
    else:
        raise TypeError(f'不支持的遥测输入类型：{type(source).__name__}')

    if not isinstance(raw, dict):
        raise ValueError('遥测数据顶层必须是 JSON 对象')
    tracks = raw.get('tracks')
    if not isinstance(tracks, dict) or not tracks:
        raise ValueError('遥测缺少有效的 tracks 字段')
    fps = float(raw.get('fps') or DEFAULT_FPS)
    if not math.isfinite(fps) or fps <= 0.0:
        raise ValueError(f'遥测 fps 非法：{raw.get("fps")!r}')

    dur_val = raw.get('dur')
    max_len = 0
    for tr in tracks.values():
        if isinstance(tr, dict):
            for v in tr.values():
                if isinstance(v, (list, tuple, np.ndarray)) and len(v) > max_len:
                    max_len = len(v)
    if dur_val is None or float(dur_val) <= 0.0:
        if max_len <= 0:
            raise ValueError('遥测缺少有效 dur 或帧序列长度')
        dur = float(max_len) / fps
    else:
        dur = float(dur_val)
    if not math.isfinite(dur) or dur <= 0.0:
        raise ValueError(f'遥测 dur 非法：{dur_val!r}')
    return {**raw, 'fps': fps, 'dur': dur, 'tracks': tracks}


def _kin_frame_count(kin: dict) -> int:
    n = int(round(float(kin['dur']) * float(kin['fps'])))
    if n > 0:
        return n
    max_len = 0
    for tr in (kin.get('tracks') or {}).values():
        if isinstance(tr, dict):
            for v in tr.values():
                if isinstance(v, (list, tuple, np.ndarray)) and len(v) > max_len:
                    max_len = len(v)
    return max_len


def detect_actor_on_twos(kin: dict) -> bool:
    """检测角色位置/尺度遥测是否呈一拍二（12 fps 重复帧）形态，覆盖偶相与奇相。"""
    n = _kin_frame_count(kin)
    even_same, even_tot = 0, 0
    odd_same, odd_tot = 0, 0
    for name, tr in (kin.get('tracks') or {}).items():
        if name == 'screen' or not isinstance(tr, dict):
            continue
        x = np.asarray(tr.get('x', []), dtype=np.float64)[:n]
        y = np.asarray(tr.get('y', []), dtype=np.float64)[:n]
        sc = np.asarray(tr.get('scale', []), dtype=np.float64)[:n]
        if len(x) == 0 and len(y) == 0:
            continue
        if len(x) == 0:
            x = np.zeros_like(y)
        if len(y) == 0:
            y = np.zeros_like(x)
        m = min(len(x), len(y))
        if m < 6:
            continue
        if len(sc) < m:
            sc = np.zeros(m, dtype=np.float64)
        else:
            sc = sc[:m]

        ev_k = (m // 2) * 2
        if ev_k >= 4:
            x0, x1 = x[0:ev_k:2], x[1:ev_k:2]
            y0, y1 = y[0:ev_k:2], y[1:ev_k:2]
            s0, s1 = sc[0:ev_k:2], sc[1:ev_k:2]
            moving = (
                np.abs(np.diff(x0, prepend=x0[0]))
                + np.abs(np.diff(y0, prepend=y0[0]))
                + 0.5 * np.abs(np.diff(s0, prepend=s0[0]))
            ) > 1e-6
            same = (np.abs(x1 - x0) + np.abs(y1 - y0) + 0.5 * np.abs(s1 - s0)) <= 1e-6
            even_same += int(np.sum(same & moving))
            even_tot += int(np.sum(moving))

        od_k = ((m - 1) // 2) * 2
        if od_k >= 4:
            x0, x1 = x[1:1 + od_k:2], x[2:1 + od_k:2]
            y0, y1 = y[1:1 + od_k:2], y[2:1 + od_k:2]
            s0, s1 = sc[1:1 + od_k:2], sc[2:1 + od_k:2]
            moving = (
                np.abs(np.diff(x0, prepend=x0[0]))
                + np.abs(np.diff(y0, prepend=y0[0]))
                + 0.5 * np.abs(np.diff(s0, prepend=s0[0]))
            ) > 1e-6
            same = (np.abs(x1 - x0) + np.abs(y1 - y0) + 0.5 * np.abs(s1 - s0)) <= 1e-6
            odd_same += int(np.sum(same & moving))
            odd_tot += int(np.sum(moving))

    fe = (even_same / even_tot) if even_tot >= 4 else 0.0
    fo = (odd_same / odd_tot) if odd_tot >= 4 else 0.0
    return bool(max(fe, fo) >= 0.85)


def motion_from_kinematics(kin: dict, *, path: str = 'auto') -> tuple[np.ndarray, str]:
    """从遥测提取归一化运动冲击包络（主路径 actor 轨迹加速度突峰 → 退化 screen.motion）。"""
    if path not in ('auto', 'actor', 'screen'):
        raise ValueError(f"path 仅支持 'auto' / 'actor' / 'screen'，收到 {path!r}")
    kin = load_kinematics(kin)
    n = _kin_frame_count(kin)
    if n < 4:
        raise ValueError(f'遥测帧数不足（n={n}）')
    tracks = kin['tracks']

    def _compute_actor() -> np.ndarray | None:
        acc = np.zeros(n, dtype=np.float64)
        used = False
        for name, tr in tracks.items():
            if name == 'screen' or not isinstance(tr, dict):
                continue
            has_x = 'x' in tr and len(tr['x']) > 0
            has_y = 'y' in tr and len(tr['y']) > 0
            has_sc = 'scale' in tr and len(tr['scale']) > 0
            if not (has_x or has_y or has_sc):
                continue
            lens = [len(tr[k]) for k, flag in (('x', has_x), ('y', has_y), ('scale', has_sc)) if flag]
            m_len = min(n, min(lens))
            if m_len < 3:
                continue
            x = np.asarray(tr['x'][:m_len], dtype=np.float64) if has_x else np.zeros(m_len, dtype=np.float64)
            y = np.asarray(tr['y'][:m_len], dtype=np.float64) if has_y else np.zeros(m_len, dtype=np.float64)
            sc = np.asarray(tr['scale'][:m_len], dtype=np.float64) if has_sc else np.zeros(m_len, dtype=np.float64)
            vis = np.asarray(tr['visible'][:m_len], dtype=np.float64) if ('visible' in tr and len(tr['visible']) >= m_len) else np.ones(m_len, dtype=np.float64)
            a2 = np.zeros(m_len, dtype=np.float64)
            a2[1:-1] = (
                np.abs(x[2:] - 2.0 * x[1:-1] + x[:-2])
                + np.abs(y[2:] - 2.0 * y[1:-1] + y[:-2])
                + 0.5 * np.abs(sc[2:] - 2.0 * sc[1:-1] + sc[:-2])
            )
            acc[:m_len] += a2 * vis
            used = True
        if not used or float(np.max(acc)) <= 1e-12:
            return None
        return acc / (float(np.percentile(acc, 95)) + 1e-12)

    def _compute_screen() -> np.ndarray | None:
        scr = tracks.get('screen')
        if not isinstance(scr, dict) or 'motion' not in scr or len(scr['motion']) == 0:
            return None
        m = np.asarray(scr['motion'], dtype=np.float64)[:n]
        if len(m) < n:
            m = np.pad(m, (0, n - len(m)))
        if float(np.max(m)) <= 1e-12:
            return None
        return m / (float(np.percentile(m, 95)) + 1e-12)

    if path == 'actor':
        acc = _compute_actor()
        if acc is None:
            raise ValueError('遥测中缺少有效的非零 actor 位置/尺度轨道')
        return acc, 'actor'
    if path == 'screen':
        scr_m = _compute_screen()
        if scr_m is None:
            raise ValueError('遥测中缺少有效的非零 screen.motion 轨道')
        return scr_m, 'screen.motion'

    acc = _compute_actor()
    if acc is not None:
        return acc, 'actor'
    scr_m = _compute_screen()
    if scr_m is not None:
        return scr_m, 'screen.motion'
    raise ValueError('遥测中既无有效 actor 轨道也无有效 screen.motion 轨道')


def _probe_video_fps(video_path: str) -> float:
    ffp = _resolve_bin(_env.ffprobe())
    if not ffp:
        return DEFAULT_FPS
    try:
        res = _env.run([
            ffp, '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
            '-of', 'json', video_path,
        ], capture_output=True, timeout=20)
        if res.returncode != 0:
            return DEFAULT_FPS
        meta = json.loads((res.stdout or b'{}').decode('utf-8', errors='replace'))
        streams = meta.get('streams') or []
        if not streams:
            return DEFAULT_FPS
        st0 = streams[0]
        fps = _parse_fps(st0.get('avg_frame_rate')) or _parse_fps(st0.get('r_frame_rate'))
        return fps if fps > 0.0 else DEFAULT_FPS
    except Exception:
        return DEFAULT_FPS


def extract_video_frames(
    video_path: str | os.PathLike,
    *,
    n_frames: int | None = None,
    width: int = 160,
    height: int = 90,
    timeout_s: float = 120.0,
) -> tuple[np.ndarray, float]:
    """经 ffmpeg 管道解灰度缩略帧 [n_frames, width*height]，并探测帧率；无 ffmpeg 时抛 FfmpegUnavailableError。"""
    vp = os.fspath(video_path)
    if not os.path.isfile(vp):
        raise FileNotFoundError(f'找不到视频文件：{vp}')
    ff_bin = _resolve_bin(_env.ffmpeg())
    if not ff_bin:
        raise FfmpegUnavailableError(f'找不到可用 ffmpeg（当前设置：{_env.ffmpeg()!r}），无法从视频退化路径解码灰度帧')

    fps = _probe_video_fps(vp)
    w = max(16, int(width))
    h = max(16, int(height))
    cmd = [ff_bin, '-v', 'error', '-nostdin', '-i', vp]
    if n_frames is not None and int(n_frames) > 0:
        cmd.extend(['-frames:v', str(int(n_frames))])
    cmd.extend(['-vf', f'scale={w}:{h}:flags=bilinear,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])

    frame_bytes = w * h
    frames = []
    deadline = time.monotonic() + float(timeout_s)
    stderr_bytes = b''
    with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        try:
            while True:
                if time.monotonic() > deadline:
                    raise TimeoutError(f'ffmpeg 解码视频超时（>{timeout_s:.1f} s）：{vp}')
                if n_frames is not None and len(frames) >= int(n_frames):
                    break
                buf = _read_exact(proc.stdout, frame_bytes)
                if not buf or len(buf) < frame_bytes:
                    break
                frames.append(np.frombuffer(buf, dtype=np.uint8).astype(np.float64))
            stderr_bytes = proc.stderr.read() if proc.stderr else b''
            rem_t = max(1.0, deadline - time.monotonic())
            proc.wait(timeout=rem_t)
        except BaseException:
            _env.kill_tree(proc)
            raise

    if proc.returncode != 0:
        err_msg = stderr_bytes.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f'ffmpeg 解码视频失败（退出码 {proc.returncode}）：{err_msg}')
    if len(frames) < 2:
        raise RuntimeError(f'视频有效帧数不足（仅解出 {len(frames)} 帧）：{vp}')
    return np.stack(frames), fps


def video_motion_curves(frames: np.ndarray, n_frames: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    """返回帧对齐的帧间差分能量 d1[i]=|F[i]-F[i-1]| 与正部二阶变化 d2+[i]=max(0, d1[i]-d1[i-1])。"""
    arr = np.asarray(frames, dtype=np.float64)
    if arr.ndim < 2 or len(arr) < 2:
        raise ValueError(f'frames 至少需要 2 帧二维数组，收到形状 {arr.shape}')
    if arr.ndim > 2:
        arr = arr.reshape(arr.shape[0], -1)
    lim = len(arr) if n_frames is None else min(len(arr), int(n_frames))
    arr = arr[:lim]
    d1 = np.r_[0.0, np.abs(np.diff(arr, axis=0)).mean(axis=1)]
    d2p = np.r_[0.0, np.maximum(np.diff(d1), 0.0)]
    return d1 / (float(np.percentile(d1, 95)) + 1e-12), d2p / (float(np.percentile(d2p, 95)) + 1e-12)


def apply_on_twos_guard(
    motion: np.ndarray,
    *,
    force: bool = False,
    zero_frac_thr: float = 0.35,
) -> tuple[np.ndarray, bool]:
    """检测并抑制一拍二（12 fps 重复帧）造成的 12 Hz 零值梳状峰，采用零相移对称核 [0.25, 0.5, 0.25]。"""
    m = np.asarray(motion, dtype=np.float64).reshape(-1)
    pos = m[m > 0.0]
    if len(pos) == 0:
        return m.copy(), False
    zero_frac = float(np.mean(m < 1e-3 * float(np.median(pos))))
    detected = bool(zero_frac > zero_frac_thr)
    if force or detected:
        return np.convolve(m, ON_TWOS_KERNEL, mode='same'), detected
    return m.copy(), detected


def onset_flux(
    x: np.ndarray,
    sr: int = SR,
    *,
    n_bands: int = 6,
    fps: float = DEFAULT_FPS,
    n_frames: int | None = None,
) -> np.ndarray:
    """多频带 Onset Flux（boundary='zeros' + 相对参考 log1p + 居中帧格平均池化）。"""
    arr = np.asarray(x, dtype=np.float64)
    if arr.ndim == 2:
        arr = arr.mean(axis=1)
    else:
        arr = arr.reshape(-1)
    if n_frames is None:
        n_frames = max(0, int(round(len(arr) / float(sr) * float(fps))))
    if n_frames <= 0:
        return np.zeros(0, dtype=np.float64)
    if len(arr) < 16 or float(np.max(np.abs(arr))) <= 1e-12:
        return np.zeros(n_frames, dtype=np.float64)

    n_fft = min(1024, max(64, len(arr)))
    hop = max(16, int(round(sr * 0.005)))
    if hop >= n_fft:
        hop = max(1, n_fft // 4)
    f, t, Z = stft(arr, fs=sr, nperseg=n_fft, noverlap=n_fft - hop, boundary='zeros', padded=True)
    S = np.abs(Z)
    if S.shape[1] < 2:
        return np.zeros(n_frames, dtype=np.float64)
    hi_edge = min(16000.0, float(sr) / 2.0 - 1.0)
    lo_edge = min(150.0, hi_edge * 0.25)
    edges = np.geomspace(lo_edge, hi_edge, n_bands + 1)
    flux = np.zeros(S.shape[1], dtype=np.float64)
    for b in range(n_bands):
        m = (f >= edges[b]) & (f < edges[b + 1])
        if not np.any(m):
            continue
        sb = S[m].sum(axis=0)
        ref = float(np.percentile(sb, 99)) * 0.01 + 1e-9
        d = np.maximum(np.diff(np.log1p(sb / ref)), 0.0)
        flux[1:] += d

    out = np.zeros(n_frames, dtype=np.float64)
    cnt = np.zeros(n_frames, dtype=np.float64)
    idx = np.rint(t * float(fps)).astype(int)
    valid = (idx >= 0) & (idx < n_frames)
    np.add.at(out, idx[valid], flux[valid])
    np.add.at(cnt, idx[valid], 1.0)
    return out / np.maximum(cnt, 1.0)


def xcorr_offset_frames(
    motion: np.ndarray,
    audio_flux: np.ndarray,
    *,
    fps: float = DEFAULT_FPS,
    max_lag_s: float = 0.35,
) -> dict:
    """归一化互相关求音画偏移（正值 = 音频滞后画面），带抛物线亚帧内插与峰值信噪比。"""
    m_arr = np.asarray(motion, dtype=np.float64).reshape(-1)
    a_arr = np.asarray(audio_flux, dtype=np.float64).reshape(-1)
    n = min(len(m_arr), len(a_arr))
    if n < 4:
        return {'offset_frames': 0.0, 'offset_ms': 0.0, 'peak_corr': 0.0, 'peak_snr': 0.0, 'valid': False}
    m_c = m_arr[:n] - float(np.mean(m_arr[:n]))
    a_c = a_arr[:n] - float(np.mean(a_arr[:n]))
    nm = float(np.linalg.norm(m_c))
    na = float(np.linalg.norm(a_c))
    if nm < 1e-12 or na < 1e-12:
        return {'offset_frames': 0.0, 'offset_ms': 0.0, 'peak_corr': 0.0, 'peak_snr': 0.0, 'valid': False}
    M = m_c / nm
    A = a_c / na
    max_lag = max(1, min(n - 2, int(round(float(max_lag_s) * float(fps)))))
    lags = np.arange(-max_lag, max_lag + 1)
    cc = np.array([
        float(np.dot(A[L:n], M[:n - L])) if L >= 0 else float(np.dot(A[:n + L], M[-L:n]))
        for L in lags
    ], dtype=np.float64)
    k = int(np.argmax(cc))
    sub = 0.0
    if 0 < k < len(cc) - 1:
        y0, y1, y2 = float(cc[k - 1]), float(cc[k]), float(cc[k + 1])
        den = y0 - 2.0 * y1 + y2
        if abs(den) > 1e-12:
            sub = float(np.clip(0.5 * (y0 - y2) / den, -0.5, 0.5))
    off = float(lags[k] + sub)
    med = float(np.median(cc))
    mad = float(np.median(np.abs(cc - med))) * 1.4826 + 1e-12
    peak_snr = float((cc[k] - med) / mad)
    return {
        'offset_frames': round(off, 3),
        'offset_ms': round(off / float(fps) * 1000.0, 1),
        'peak_corr': round(float(cc[k]), 4),
        'peak_snr': round(peak_snr, 2),
        'valid': True,
    }


def estimate_offset_frames(
    motion: np.ndarray,
    audio: np.ndarray,
    sr: int = SR,
    *,
    fps: float = DEFAULT_FPS,
    max_lag_s: float = 0.35,
) -> dict:
    """给定运动曲线与音频波形，计算运动学-冲击互相关偏移结果。"""
    m = np.asarray(motion, dtype=np.float64).reshape(-1)
    flux = onset_flux(audio, sr, fps=fps, n_frames=len(m))
    return xcorr_offset_frames(m, flux, fps=fps, max_lag_s=max_lag_s)


def evaluate_sync(
    audio: np.ndarray,
    *,
    sr: int = SR,
    kinematics=None,
    video_path: str | os.PathLike | None = None,
    motion: np.ndarray | None = None,
    motion_path: str = 'auto',
    video_metric: str = 'd1',
    fps: float | None = None,
    fps_mode: str = 'auto',
    input_track: str = 'auto',
    max_lag_s: float = 0.35,
    warn_threshold_frames: float | None = None,
    fail_threshold_frames: float | None = None,
    min_peak_corr: float = MIN_PEAK_CORR,
) -> dict:
    """完整音画同步评测：解析路径、按帧率模式应用 12 Hz 守卫、分级判定并返回结构化 JSON 指标。"""
    if fps_mode not in ('auto', '24fps', '12fps'):
        raise ValueError(f"fps_mode 仅支持 'auto' / '24fps' / '12fps'，收到 {fps_mode!r}")
    if motion_path not in ('auto', 'actor', 'screen'):
        raise ValueError(f"motion_path 仅支持 'auto' / 'actor' / 'screen'，收到 {motion_path!r}")
    if video_metric not in ('d1', 'd2p'):
        raise ValueError(f"video_metric 仅支持 'd1' / 'd2p'，收到 {video_metric!r}")
    if input_track not in ('auto', 'sfx', 'mix', 'stem', 'audio'):
        raise ValueError(f"input_track 仅支持 'auto' / 'sfx' / 'mix' / 'stem' / 'audio'，收到 {input_track!r}")

    t0 = time.perf_counter()
    resolved_track = 'sfx' if input_track == 'stem' else ('unknown' if input_track == 'auto' else input_track)
    on_twos_detected = False
    guard_applied = False
    eff_fps = float(fps) if (fps is not None and float(fps) > 0.0) else DEFAULT_FPS

    if motion is not None:
        m_raw = np.asarray(motion, dtype=np.float64).reshape(-1)
        resolved_path = 'custom'
        if fps_mode == '24fps':
            _, on_twos_detected = apply_on_twos_guard(m_raw, force=False)
            m_use = m_raw
        else:
            m_use, on_twos_detected = apply_on_twos_guard(m_raw, force=(fps_mode == '12fps'))
            guard_applied = bool(fps_mode == '12fps' or on_twos_detected)
    elif kinematics is not None:
        kin_doc = load_kinematics(kinematics)
        eff_fps = float(fps) if (fps is not None and float(fps) > 0.0) else float(kin_doc['fps'])
        m_raw, resolved_path = motion_from_kinematics(kin_doc, path=motion_path)
        if resolved_path == 'actor':
            on_twos_detected = detect_actor_on_twos(kin_doc)
            if fps_mode == '12fps' or (fps_mode == 'auto' and on_twos_detected):
                m_use = np.convolve(m_raw, ON_TWOS_KERNEL, mode='same')
                guard_applied = True
            else:
                m_use = m_raw
        else:
            _, on_twos_detected = apply_on_twos_guard(m_raw, force=False)
            if fps_mode == '12fps' or (fps_mode == 'auto' and on_twos_detected):
                m_use = np.convolve(m_raw, ON_TWOS_KERNEL, mode='same')
                guard_applied = True
            else:
                m_use = m_raw
    elif video_path is not None:
        frames, vid_fps = extract_video_frames(video_path)
        eff_fps = float(fps) if (fps is not None and float(fps) > 0.0) else float(vid_fps)
        d1, d2p = video_motion_curves(frames)
        m_raw = d1 if video_metric == 'd1' else d2p
        resolved_path = f'video.{video_metric}'
        _, on_twos_detected = apply_on_twos_guard(m_raw, force=False)
        if fps_mode == '12fps' or (fps_mode == 'auto' and on_twos_detected):
            m_use = np.convolve(m_raw, ON_TWOS_KERNEL, mode='same')
            guard_applied = True
        else:
            m_use = m_raw
    else:
        raise ValueError('必须提供 motion、kinematics 或 video_path 之一')

    eff_fps_mode = '12fps' if (fps_mode == '12fps' or (fps_mode == 'auto' and (on_twos_detected or guard_applied))) else '24fps'
    default_fail = DRIFT_FAIL_12FPS if eff_fps_mode == '12fps' else DRIFT_FAIL_24FPS
    default_warn = DRIFT_WARN_12FPS if eff_fps_mode == '12fps' else default_fail
    fail_thr = float(fail_threshold_frames) if fail_threshold_frames is not None else default_fail
    warn_thr = float(warn_threshold_frames) if warn_threshold_frames is not None else min(default_warn, fail_thr)
    if warn_thr > fail_thr:
        warn_thr = fail_thr

    res = estimate_offset_frames(m_use, audio, sr=sr, fps=eff_fps, max_lag_s=max_lag_s)
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    warnings_list: list[str] = []
    if resolved_track == 'mix':
        if eff_fps_mode == '12fps':
            warnings_list.append(
                '当前输入为全混音且处于一拍二（12 fps）模式：偶相叠加周期配乐节拍可能诱发伪峰，'
                '建议优先使用 sfx 分轨或 24 fps 遥测复核'
            )
        else:
            warnings_list.append('当前输入为全混音（mix）：建议存在前景冲击噪声时优先传入 sfx 分轨')

    if eff_fps_mode == '12fps':
        warnings_list.append(
            f'一拍二（12 fps）零阶保持存在约 -0.5 ~ -0.8f 半帧量化相移，已启用零相移 [0.25, 0.5, 0.25] 守卫'
            f'并采用 {warn_thr:.2f}f 告警门限'
        )

    abs_off = abs(float(res['offset_frames']))
    if not res['valid'] or res['peak_corr'] < float(min_peak_corr):
        status = 'warn'
        msg = (
            f"音画相关置信度不足（peak_corr={res['peak_corr']:.4f} < {min_peak_corr:.2f}，"
            f"路径 {resolved_path} / {resolved_track}），请结合人工试听或 sfx 分轨复核"
        )
        warnings_list.append(msg)
    elif abs_off >= fail_thr:
        status = 'fail'
        msg = (
            f"音画偏移超限：{res['offset_frames']:+.3f} 帧（{res['offset_ms']:+.1f} ms，"
            f"|偏移| ≥ {fail_thr:.2f}f，路径 {resolved_path} / {eff_fps_mode}）"
        )
    elif abs_off >= warn_thr:
        status = 'warn'
        msg = (
            f"音画偏移进入一拍二紧门限告警区：{res['offset_frames']:+.3f} 帧（{res['offset_ms']:+.1f} ms，"
            f"∈ [{warn_thr:.2f}f, {fail_thr:.2f}f)，路径 {resolved_path} / {eff_fps_mode}）"
        )
        warnings_list.append(msg)
    else:
        status = 'pass'
        msg = (
            f"音画同步正常：{res['offset_frames']:+.3f} 帧（{res['offset_ms']:+.1f} ms，"
            f"peak_corr={res['peak_corr']:.4f}，路径 {resolved_path} / {eff_fps_mode}）"
        )

    return {
        'ok': status != 'fail',
        'status': status,
        'offset_frames': float(res['offset_frames']),
        'offset_ms': float(res['offset_ms']),
        'peak_corr': float(res['peak_corr']),
        'peak_snr': float(res['peak_snr']),
        'valid': bool(res['valid']),
        'path': resolved_path,
        'input_track': resolved_track,
        'fps': round(float(eff_fps), 6),
        'fps_mode_requested': fps_mode,
        'fps_mode': eff_fps_mode,
        'on_twos_detected': bool(on_twos_detected),
        'on_twos_guard_applied': bool(guard_applied),
        'warn_threshold_frames': round(warn_thr, 3),
        'fail_threshold_frames': round(fail_thr, 3),
        'min_peak_corr': float(min_peak_corr),
        'n_frames': int(len(m_use)),
        'elapsed_ms': elapsed_ms,
        'warnings': warnings_list,
        'message': msg,
    }


def make_parser():
    p = ArgumentParser(
        prog='python -m engine.audio.sync_kernel',
        description='纯 CPU 运动学对冲击同步核（L3 模块 C）：退出码 0 通过、2 用法、3 缺输入或 ffmpeg、4 同步超差',
    )
    p.add_argument('--audio', required=True, help='待测音频文件（优先传 sfx 分轨，兼容 mix 全混音）')
    p.add_argument('--kinematics', help='页面遥测 kinematics.json 文件或所在目录（主路径 actor → 退化 screen.motion）')
    p.add_argument('--video', help='无遥测时的成品视频路径（经 ffmpeg 退化帧差检测）')
    p.add_argument('--path', dest='motion_path', choices=['auto', 'actor', 'screen'], default='auto',
                   help='遥测路径选择：auto（优先 actor 退化 screen）/ actor / screen')
    p.add_argument('--video-metric', choices=['d1', 'd2p'], default='d1',
                   help='视频帧差特征：d1 一阶帧差（默认）/ d2p 正部二阶变化')
    p.add_argument('--fps', type=float, help='覆盖视频/遥测帧率')
    p.add_argument('--fps-mode', choices=['auto', '24fps', '12fps'], default='auto',
                   help='帧率模式：auto（自动识别一拍二）/ 24fps / 12fps（一拍二紧门限与 12 Hz 守卫）')
    p.add_argument('--track-type', choices=['auto', 'sfx', 'mix'], default='auto',
                   help='显式标注输入音频轨类型（auto 按文件名推断 sfx/mix）')
    p.add_argument('--warn-frames', type=float, help='告警偏移帧数门限（默认 24fps=1.5 / 12fps=1.1）')
    p.add_argument('--fail-frames', type=float, help='硬失败偏移帧数门限（默认 1.5）')
    p.add_argument('--max-lag-s', type=float, default=0.35, help='最大搜索滞后窗口秒数（默认 0.35）')
    p.add_argument('--fail-on-warn', action='store_true', help='告警也判不通过（退出码 4）')
    p.add_argument('--report', help='可选输出 JSON 报告路径')
    return p


def _infer_track_type(audio_path: str, explicit: str) -> str:
    if explicit != 'auto':
        return explicit
    stem = os.path.splitext(os.path.basename(audio_path))[0].lower()
    if stem in ('sfx', 'fx', 'foley'):
        return 'sfx'
    if stem in ('mix', 'master'):
        return 'mix'
    return 'sfx' if ('sfx' in stem or 'foley' in stem) else 'mix'


def main_cli(args, ctx):
    if not args.kinematics and not args.video:
        raise CliError('usage.missing-visual', '必须提供 --kinematics 或 --video 之一')
    if args.kinematics and args.video:
        raise CliError('usage.conflicting-visual', '--kinematics 与 --video 不能同时指定')
    audio_path = os.path.abspath(args.audio)
    if not os.path.isfile(audio_path):
        raise CliError('env.audio-missing', f'找不到音频文件：{_rel(audio_path)}')

    kin_path = None
    vid_path = None
    if args.kinematics:
        cand = os.path.abspath(args.kinematics)
        if os.path.isdir(cand):
            cand = os.path.join(cand, 'kinematics.json')
        if not os.path.isfile(cand):
            raise CliError('env.kinematics-missing', f'找不到遥测文件：{_rel(cand)}')
        kin_path = cand
    if args.video:
        vid_path = os.path.abspath(args.video)
        if not os.path.isfile(vid_path):
            raise CliError('env.video-missing', f'找不到视频文件：{_rel(vid_path)}')

    try:
        audio_sig, sr = load_audio_mono(audio_path, SR)
    except Exception as e:
        raise CliError('contract.audio-unreadable', f'读取音频失败 {_rel(audio_path)}：{e}') from None

    track_type = _infer_track_type(audio_path, args.track_type)
    try:
        res = evaluate_sync(
            audio_sig,
            sr=sr,
            kinematics=kin_path,
            video_path=vid_path,
            motion_path=args.motion_path,
            video_metric=args.video_metric,
            fps=args.fps,
            fps_mode=args.fps_mode,
            input_track=track_type,
            max_lag_s=args.max_lag_s,
            warn_threshold_frames=args.warn_frames,
            fail_threshold_frames=args.fail_frames,
        )
    except FfmpegUnavailableError as e:
        raise CliError('env.ffmpeg-missing', str(e), hint='安装 ffmpeg 或设置 FFMPEG 环境变量') from None
    except ValueError as e:
        raise CliError('contract.sync-input', str(e)) from None

    res['audio'] = _rel(audio_path)
    if kin_path:
        res['kinematics'] = _rel(kin_path)
    if vid_path:
        res['video'] = _rel(vid_path)

    if args.fail_on_warn and res['status'] == 'warn':
        res['status'] = 'fail'
        res['ok'] = False
        res['message'] = res['message'] + '（--fail-on-warn：告警算不通过）'

    outputs = []
    if args.report:
        rp = os.path.abspath(args.report)
        os.makedirs(os.path.dirname(rp), exist_ok=True)
        tmp = rp + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(res, f, ensure_ascii=False, indent=1, allow_nan=False)
            f.write('\n')
        os.replace(tmp, rp)
        from ._cli import sha256_file
        outputs.append({'path': _rel(rp), 'sha256': sha256_file(rp), 'kind': 'sync-report'})

    mark = {'pass': '✓', 'warn': '!', 'fail': '✗'}[res['status']]
    ctx.out(f"  {mark} audio.sync [{res['path']} / {res['input_track']} / {res['fps_mode']}] "
            f"{res['offset_frames']:+.3f}f ({res['offset_ms']:+.1f} ms, corr={res['peak_corr']:.4f})")
    for w in res['warnings']:
        ctx.out(f"    ! {w}")

    if not res['ok']:
        return {
            'data': res,
            'outputs': outputs,
            'error': {'code': 'contract.audio-sync', 'message': res['message'], 'hint': '检查画面切点/动作关键帧与音效摆放时刻对齐'},
        }
    return {'data': res, 'outputs': outputs}


def main(argv=None):
    return run_cli(main_cli, make_parser(), argv=argv, command='audio:sync')


if __name__ == '__main__':
    sys.exit(main())
