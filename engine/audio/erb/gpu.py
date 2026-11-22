# -*- coding: utf-8 -*-
"""北冥引擎 · 96 带 ERB 再合成的 GPU 执行器（nvcc + cuFFT，现场编译、ctypes 调用）。

执行的是 core.plan() 产出的同一份 Plan：CPU 版是 core._execute_numpy，这里是同目录的 erb_cuda.cu。
一批 take（同一个模型、同样的 m_base 与开关）打成一个 ErbGroup 交给 GPU，整批一起做 FFT。

两种随机数来源：
  host_noise=False（默认）：设备端 Philox，种子取自 plan.rng，同一份 Plan 每次结果逐采样相同，但与 CPU 版不是同一组数；
  host_noise=True：按 _execute_numpy 的抽取顺序在主机抽好高斯数再上传，用来与 CPU 版逐波形对照（测试用，慢）。

用法：
    from engine.audio.erb import gpu
    y = gpu.render(model, seed=3, vary=1.0, exact=8)                       # 与 core.render 同参数
    ys = gpu.render_many([(m, dict(seed=s, vary=1.0, exact=8)) for s in range(64)])
"""
from __future__ import annotations

import atexit
import ctypes
import hashlib
import math
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

from . import core
from .core import DEC, FS_BASE, SR, ERBModel, Plan

_SRC = Path(__file__).with_name("erb_cuda.cu")
_REPO = Path(__file__).resolve().parents[3]
F32, I32, F64 = np.float32, np.int32, np.float64

_INTS = ("T", "C", "NB", "M", "N", "MA", "K", "L", "OUTM", "OUTN", "KTOT", "NPEAK", "stereo_mode", "use_on", "use_grain",
         "use_reseed", "final_on", "final_post", "exact", "noise_mode")
# 指针字段的顺序必须与 erb_cuda.cu 里的 ErbGroup 完全一致（加载时会核对结构体大小与 out 的偏移）
_PTRS = ("env", "kappa", "omega", "grain", "grain_w", "prof", "ild", "sq_p", "sq_m", "sg", "turn", "hf_wt", "sigma_b", "imp_scale",
         "grp", "rwin", "bin_b0", "bin_u0", "bin_b1", "bin_u1", "bin_w0", "bin_w1", "flat_b", "flat_u", "flat_k",
         "flat_w", "band_mask", "lo_m", "hi_m", "ti", "td", "src_pos", "imp_t", "w_atk", "rs_i0", "rs_mode",
         "rs_frac", "rs_roll", "glin", "eq", "peak_pos", "peak_amp", "peak_ph", "init_phi", "on_samp", "on_slope",
         "post_slope", "pre_lo", "pre_ci", "att_prot", "pan", "seeds", "noise", "wtd", "out")


class _Group(ctypes.Structure):
    _fields_ = (
        [(n, ctypes.c_int) for n in _INTS]
        + [("kw_on", ctypes.c_int * 4), ("kw_gr", ctypes.c_int * 3), ("kw_gs", ctypes.c_int), ("pre_n", ctypes.c_int),
           ("an_n", ctypes.c_int), ("ramp_n", ctypes.c_int)]
        + [("floor2", ctypes.c_double), ("eps_proj", ctypes.c_double), ("onset_max_gain", ctypes.c_double),
           ("grain_gmin", ctypes.c_double), ("grain_gmax", ctypes.c_double), ("post_len", ctypes.c_double * 3),
           ("hold_pre", ctypes.c_double), ("hold_post", ctypes.c_double), ("hold_ramp", ctypes.c_double)]
        + [(n, ctypes.c_void_p) for n in _PTRS]
    )


class GpuError(RuntimeError):
    pass


class GpuUnavailable(GpuError):
    """这台机器上用不了 GPU 执行器（没有 nvcc、没有 NVIDIA GPU 或驱动）：available() 为 False，调用方退回 CPU。
    编译失败这类「有 nvcc 也有 GPU 却出错」是真问题，抛普通 GpuError，不当成不可用悄悄跳过。"""


class GpuOutOfMemory(GpuError):
    pass


# ———— 编译与加载 ————

def _nvcc() -> Optional[str]:
    for cand in (os.environ.get("BEIMING_NVCC"), shutil.which("nvcc"), "/opt/cuda/bin/nvcc", "/usr/local/cuda/bin/nvcc"):
        if cand and os.path.exists(cand):
            return cand
    return None


def _run(cmd: list[str], timeout: float = 600.0) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise GpuError(f"{' '.join(cmd[:2])} 超过 {timeout:.0f} 秒没结束") from e
    if r.returncode != 0:
        raise GpuError(f"{' '.join(cmd[:2])} 失败（退出码 {r.returncode}）：\n{(r.stderr or r.stdout).strip()}")
    return r.stdout


def build(force: bool = False) -> Path:
    """编译 erb_cuda.cu 成共享库，缓存在 <仓库>/.cache/erb/（文件名带源码、nvcc 版本与 GPU 型号的哈希）。"""
    nvcc = _nvcc()
    if nvcc is None:
        raise GpuUnavailable("找不到 nvcc（装 CUDA Toolkit，或设环境变量 BEIMING_NVCC 指向它）")
    try:
        gpu = _run(["nvidia-smi", "--query-gpu=name,compute_cap", "--format=csv,noheader"], 20.0).strip()
    except (OSError, GpuError) as e:
        raise GpuUnavailable(f"nvidia-smi 不可用，当作没有 GPU：{e}") from e
    ver = _run([nvcc, "--version"], 20.0)
    key = hashlib.sha256(_SRC.read_bytes() + ver.encode() + gpu.encode()).hexdigest()[:12]
    out_dir = Path(os.environ.get("BEIMING_ERB_CACHE") or (_REPO / ".cache" / "erb"))
    so = out_dir / f"liberb_{key}.so"
    if so.exists() and not force:
        return so
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / f".{so.name}.{os.getpid()}.tmp"  # 多进程同时首次编译：各编各的，最后原子替换（临时文件名不匹配下面清理旧版本的通配符）
    _run([nvcc, "-O3", "-std=c++17", "--shared", "-Xcompiler", "-fPIC", "-arch=native", "-DNDEBUG", str(_SRC), "-o", str(tmp), "-lcufft"])
    os.replace(tmp, so)
    for old in out_dir.glob("liberb_*.so"):  # 旧版本清掉，免得越积越多
        if old != so:
            old.unlink(missing_ok=True)
    return so


_LIB: Optional[ctypes.CDLL] = None
_UNAVAILABLE: Optional[str] = None  # 「这台机器没有 nvcc / GPU」的结论缓存下来：没有 GPU 的机器上不用每次都起一次 nvidia-smi
_LOCK = threading.Lock()  # erb_cuda.cu 的计划缓存、错误缓冲与计时表是进程级全局，一次只许一个线程进去


def _lib() -> ctypes.CDLL:
    global _LIB, _UNAVAILABLE
    if _LIB is None:
        if _UNAVAILABLE is not None:
            raise GpuUnavailable(_UNAVAILABLE)
        try:
            lib = ctypes.CDLL(str(build()))
        except GpuUnavailable as e:
            _UNAVAILABLE = str(e)
            raise
        except OSError as e:  # 装不上 libcudart / libcufft 或驱动太旧：环境问题
            _UNAVAILABLE = f"加载 GPU 内核库失败：{e}"
            raise GpuUnavailable(_UNAVAILABLE) from e
        lib.erb_render_group.argtypes = [ctypes.POINTER(_Group)]
        lib.erb_render_group.restype = ctypes.c_int
        lib.erb_last_error.restype = ctypes.c_char_p
        lib.erb_struct_size.restype = ctypes.c_int
        lib.erb_out_offset.restype = ctypes.c_int
        lib.erb_mem_info.argtypes = [ctypes.POINTER(ctypes.c_ulonglong), ctypes.POINTER(ctypes.c_ulonglong)]
        lib.erb_mem_info.restype = ctypes.c_int
        lib.erb_release.restype = None
        lib.erb_peak_bytes.restype = ctypes.c_ulonglong
        lib.erb_profile.argtypes = [ctypes.c_int]
        lib.erb_profile_report.argtypes = [ctypes.c_char_p, ctypes.c_int]
        lib.erb_profile_report.restype = ctypes.c_int
        if lib.erb_struct_size() != ctypes.sizeof(_Group) or lib.erb_out_offset() != _Group.out.offset:
            raise GpuError(f"ErbGroup 结构体与 erb_cuda.cu 对不上（C {lib.erb_struct_size()} 字节，Python {ctypes.sizeof(_Group)}）")
        _LIB = lib
        atexit.register(release)  # 退出前销毁缓存的 cuFFT 计划（此时 CUDA 上下文还在，比解释器收尾时再释放稳）
    return _LIB


def available() -> bool:
    """能编译、能加载、能看到 GPU。"""
    try:
        free_mem()
        return True
    except GpuUnavailable:
        return False


def free_mem() -> int:
    """当前空闲显存（字节）。"""
    f, t = ctypes.c_ulonglong(), ctypes.c_ulonglong()
    if _lib().erb_mem_info(ctypes.byref(f), ctypes.byref(t)) != 0:
        raise GpuUnavailable("读不到显存信息（没有可用的 CUDA 设备？）")
    return int(f.value)


def profile(on: bool = True) -> None:
    """打开/关闭分项计时（每个内核前后同步，只用来看耗时分布，会拖慢整体）；打开时清空已有记录。"""
    with _LOCK:
        _lib().erb_profile(int(bool(on)))


def profile_report() -> str:
    """每行「毫秒 次数 内核名」，按耗时降序。"""
    lib = _lib()
    buf = ctypes.create_string_buffer(1 << 16)
    with _LOCK:
        lib.erb_profile_report(buf, len(buf))
    return buf.value.decode("utf-8", "replace")


def last_peak_bytes() -> int:
    """最近一次渲染的设备显存峰值增量（字节；仅 profile(True) 时采样，先 release() 清空内存池再量才准）。校准 _bytes_per_take 用。"""
    return int(_lib().erb_peak_bytes())


def release() -> None:
    """释放缓存的 cuFFT 计划（它们的工作区会一直占着显存）。"""
    if _LIB is not None:
        with _LOCK:
            _LIB.erb_release()


# ———— 打包 ————

def _c(a, dt) -> np.ndarray:
    return np.ascontiguousarray(a, dtype=dt)


def _addr(a: Optional[np.ndarray]) -> Optional[int]:
    return None if a is None else a.ctypes.data


def _group_key(p: Plan) -> tuple:
    return (p.m_base, p.stereo_mode, bool(p.use_on), bool(p.use_grain), bool(p.use_reseed), int(p.exact), bool(p.use_stereo))


def _pack(model: ERBModel, plans: Sequence[Plan], host_noise: bool) -> tuple[_Group, np.ndarray, list]:
    """一批同类 Plan → (ErbGroup, 输出缓冲 (T, C, OUTN), 要保活的数组列表)。"""
    p0 = plans[0]
    T, NB, M = len(plans), model.nb, p0.m_base
    N, C, MA = M * DEC, (2 if p0.use_stereo else 1), model.m_active
    use_on, use_grain, use_reseed, sm = bool(p0.use_on), bool(p0.use_grain), bool(p0.use_reseed), p0.stereo_mode
    K = len(model.onsets) if use_on else 0
    OUTM, OUTN = max(p.out_m for p in plans), max(p.out_n for p in plans)
    bank = core.get_filterbank(M, nb=NB, sr=model.sr)
    keep: list = []

    def arr(a, dt, none_if=False):
        if none_if or a is None:
            return None
        a = _c(a, dt)
        keep.append(a)
        return a

    # 模型与滤波器组（整批共用）
    centers = np.asarray(model.centers_hz)
    octs = np.log2(np.maximum(model.centers_hz, 20.0) / 1500.0).astype(F32)
    sigma_b, imp_scale = core._impulse_sigma(bank)
    f = dict(
        env=arr(model.env, F32), kappa=arr(model.kappa, F32), omega=arr(model.omega, F32),
        grain=arr(model.grain, F32, not use_grain), grain_w=arr(model.grain_w, F32, not use_grain),
        prof=arr(model.onset_prof, F32, not use_on),
        hf_wt=arr(np.clip((octs + 0.5) / 2.5, 0.0, 1.0), F32), sigma_b=arr(sigma_b, F32), imp_scale=arr(imp_scale, F32),
        grp=arr(np.where(centers < 500.0, 0, np.where(centers < 2800.0, 1, 2)), I32),
        rwin=arr([int(np.clip(round(2.2 * FS_BASE / max(float(bank.bw_hz[b]), 50.0)), 7, 96)) for b in range(NB)], I32),
        bin_b0=arr(bank.bin_b0, I32), bin_u0=arr(bank.bin_u0, I32), bin_b1=arr(bank.bin_b1, I32), bin_u1=arr(bank.bin_u1, I32),
        bin_w0=arr(bank.bin_w0, F32), bin_w1=arr(bank.bin_w1, F32),
        flat_b=arr(bank.flat_b, I32), flat_u=arr(bank.flat_u, I32), flat_k=arr(bank.flat_k, I32), flat_w=arr(bank.flat_w, F32),
        band_mask=arr(bank.band_mask, F32),
    )
    if use_on or use_grain:
        lo_m, hi_m = core._split_masks(N)
        f["lo_m"], f["hi_m"] = arr(lo_m, F32), arr(hi_m, F32)
    if sm == 1:
        icc = np.clip(model.icc, -0.999, 0.999).astype(F32)
        c_abs = np.abs(icc)
        f["ild"] = arr(model.ild_db, F32)
        f["sq_p"] = arr(np.sqrt(0.5 * (1.0 + c_abs)), F32)
        f["sq_m"] = arr(np.sqrt(0.5 * (1.0 - c_abs)), F32)
        f["sg"] = arr(np.where(icc < 0, -1.0, 1.0), F32)
        f["turn"] = arr(np.exp(-1j * np.arccos(icc)), np.complex64)

    # 每条 take 自己的参数
    ti, td = np.zeros((T, 7), I32), np.zeros((T, 3), F64)
    src_pos, imp_t, w_atk = np.zeros((T, OUTM), F64), np.zeros((T, OUTM), F32), np.zeros((T, OUTM), F32)
    rs_i0, rs_mode = np.tile(np.arange(NB, dtype=I32), (T, 1)), np.zeros((T, NB), I32)
    rs_frac, rs_roll, glin, eq = np.zeros((T, NB), F32), np.zeros((T, NB), F32), np.zeros((T, NB), F32), np.zeros((T, 2, NB), F32)
    init_phi = np.zeros((T, NB), F32)
    on_samp, on_slope, post_slope = np.zeros((T, K), I32), np.ones((T, K), F64), np.ones((T, K), F64)
    pre_lo, pre_ci = np.zeros((T, K, NB), I32), np.zeros((T, K), I32)
    att_prot = np.zeros((T, M), F32) if use_reseed else None
    pan = np.zeros((T, M), F32) if sm == 1 else None
    seeds = np.zeros(T, np.uint64)
    peak_pos, peak_amp, peak_ph = [], [], []
    noise, wtd = [], []
    n_peak = 0
    for i, p in enumerate(plans):
        npk = 0
        if p.imp is not None and len(p.imp[0]):
            pk, ph, am = p.imp
            order = np.argsort(pk)
            peak_pos.append(np.asarray(pk, I32)[order])
            peak_amp.append(np.asarray(am, F64)[order])
            peak_ph.append(np.asarray(ph, np.complex64)[order])
            npk = len(pk)
        ti[i] = (p.out_n, p.out_m, p.pad_base, n_peak, npk, p.eq is not None, abs(p.hard) > 1e-4)
        n_peak += npk
        td[i] = (p.freq_scale, p.hard, min(1.0, p.vary))
        src_pos[i, :p.out_m], src_pos[i, p.out_m:] = p.src_pos, p.src_pos[-1]
        imp_t[i, :p.out_m] = p.imp_t
        mp = core._erb_axis_map(model.centers_erb, p.freq_scale)
        if mp is not None:
            i0, frac, valid, above, below, roll_above, roll_below = mp
            rs_i0[i], rs_frac[i] = i0, frac
            rs_mode[i] = np.where(valid, 0, np.where(above, 1, 2))
            rs_roll[i] = np.where(above, roll_above, roll_below)
        glin[i] = 10.0 ** (p.gain_db / 20.0)
        if p.eq is not None:
            eq[i, 0], eq[i, 1] = p.eq[0], p.eq[-1]
            w_atk[i, :p.out_m] = p.w_atk
        init_phi[i] = p.init_phi.reshape(NB)
        if use_on:
            on_samp[i], on_slope[i], post_slope[i] = p.on_samp, p.on_slope, p.post_slope
            pre_lo[i], pre_ci[i] = core._onset_pre_bounds(bank, p.pad_base + p.on_f, p.on_slope)
        if use_reseed:
            att_prot[i] = p.att_prot
        if sm == 1:
            pan[i] = p.pan_full
        if host_noise:  # 与 core._execute_numpy 相同的抽取顺序：先纹理重抽白噪，再噪声载波的实部、虚部
            if use_reseed:
                wtd.append(p.rng.standard_normal((C, N)).astype(F32))
            re = p.rng.standard_normal((C, NB, M)).astype(F32)
            im = p.rng.standard_normal((C, NB, M)).astype(F32)
            noise.append(np.stack([re, im]))
        else:
            seeds[i] = int(p.rng.integers(0, 2 ** 63 - 1))

    f.update(
        ti=arr(ti, I32), td=arr(td, F64), src_pos=arr(src_pos, F64), imp_t=arr(imp_t, F32), w_atk=arr(w_atk, F32),
        rs_i0=arr(rs_i0, I32), rs_mode=arr(rs_mode, I32), rs_frac=arr(rs_frac, F32), rs_roll=arr(rs_roll, F32),
        glin=arr(glin, F32), eq=arr(eq, F32), init_phi=arr(init_phi, F32),
        peak_pos=arr(np.concatenate(peak_pos), I32) if peak_pos else None,
        peak_amp=arr(np.concatenate(peak_amp), F64) if peak_pos else None,
        peak_ph=arr(np.concatenate(peak_ph), np.complex64) if peak_pos else None,
        on_samp=arr(on_samp, I32, not use_on), on_slope=arr(on_slope, F64, not use_on), post_slope=arr(post_slope, F64, not use_on),
        pre_lo=arr(pre_lo, I32, not use_on), pre_ci=arr(pre_ci, I32, not use_on),
        att_prot=arr(att_prot, F32), pan=arr(pan, F32), seeds=arr(seeds, np.uint64),
        noise=arr(np.stack(noise), F32) if host_noise else None, wtd=arr(np.stack(wtd), F32) if wtd else None,
    )
    out = np.zeros((T, C, OUTN), F32)
    f["out"] = out

    g = _Group()
    for name, v in dict(T=T, C=C, NB=NB, M=M, N=N, MA=MA, K=K, L=(model.onset_prof.shape[-1] if use_on else 0), OUTM=OUTM, OUTN=OUTN,
                        KTOT=len(bank.flat_b), NPEAK=n_peak, stereo_mode=sm, use_on=use_on, use_grain=use_grain,
                        use_reseed=use_reseed, final_on=use_on and core.FINAL_MODE != "none", final_post=core.FINAL_MODE == "both",
                        exact=int(p0.exact), noise_mode=int(host_noise)).items():
        setattr(g, name, int(v))
    ms = lambda x: max(1, int(round(x * 1e-3 * SR)))  # noqa: E731
    for j, x in enumerate(core.ONSET_ENV_MS):
        g.kw_on[j] = ms(x)
    for j, x in enumerate(core.GRAIN_ENV_MS):
        g.kw_gr[j] = ms(x)
    g.kw_gs, g.pre_n, g.an_n, g.ramp_n = ms(core.GRAIN_SMOOTH_MS), core._PRE_N, int(core.ONSET_ANCHOR_MS * 1e-3 * SR), int(0.003 * SR)
    floor_amp = float(model.top_amp * (10.0 ** (core.FLOOR_DB / 20.0)))
    g.floor2, g.eps_proj, g.onset_max_gain = floor_amp * 2.0, float(floor_amp * 4.0 + 1e-9), core.ONSET_MAX_GAIN
    g.grain_gmin, g.grain_gmax = core.GRAIN_GAIN
    for j, x in enumerate(core.ONSET_POST_MS):
        g.post_len[j] = x * 1e-3 * SR
    g.hold_pre, g.hold_post, g.hold_ramp = core.ONSET_PRE_MS * 1e-3 * SR, max(core.ONSET_POST_MS) * 1e-3 * SR, 3e-3 * SR
    for name in _PTRS:
        setattr(g, name, _addr(f.get(name)))
    keep.append(out)
    return g, out, keep


def _bytes_per_take(p: Plan, nb: int, c: int, host_noise: bool = False) -> int:
    """每条 take 的显存估计（按实测峰值留约 1.3 倍余量；估不准没关系，分配失败会自动减半重试）。"""
    per = (72 if p.use_reseed else 52) + (44 if host_noise else 34) * c
    return int(nb * p.m_base * per)


def _run_chunk(model: ERBModel, plans: Sequence[Plan], host_noise: bool) -> list[np.ndarray]:
    g, out, keep = _pack(model, plans, host_noise)
    with _LOCK:
        rc = _lib().erb_render_group(ctypes.byref(g))
        msg = (_lib().erb_last_error() or b"").decode("utf-8", "replace") if rc != 0 else ""
    if rc != 0:
        raise (GpuOutOfMemory if rc == -2 else GpuError)(msg)
    del keep
    res = []
    for i, p in enumerate(plans):
        res.append(core._finish(out[i, :, :p.out_n].copy(), p.out_n, model.sr, p.use_stereo))
    return res


def execute(model: ERBModel, plans: Sequence[Plan], *, host_noise: bool = False, max_chunk: Optional[int] = None) -> list[np.ndarray]:
    """同一个模型的一批 Plan → 成品（形状同 core._execute_numpy）。内部按 m_base 与开关分组，显存不够时自动分块。"""
    groups: dict[tuple, list[int]] = {}
    for i, p in enumerate(plans):
        groups.setdefault(_group_key(p), []).append(i)
    res: list = [None] * len(plans)
    for idxs in groups.values():
        sub = [plans[i] for i in idxs]
        c = 2 if sub[0].use_stereo else 1
        est = _bytes_per_take(sub[0], model.nb, c, host_noise=host_noise)
        avail = max(0, free_mem() - (64 << 20))  # 预留 ~64 MB 给 CUDA / cuFFT 固定开销
        chunk = min(len(sub), max_chunk or len(sub), max(1, int(0.75 * avail / est)))
        done = 0
        while done < len(sub):
            n = min(chunk, len(sub) - done)
            try:
                ys = _run_chunk(model, sub[done:done + n], host_noise)
            except GpuOutOfMemory:
                if n == 1:
                    raise
                chunk = max(1, n // 2)
                release()
                continue
            for j, y in enumerate(ys):
                res[idxs[done + j]] = y
            done += n
    return res


def plan(model: ERBModel, **kw) -> Plan:
    """GPU 用的规划：同 core.plan，但带时长抖动（vary > 0 且没给 eq_db）的任务把 m_base 定在「抖动 +2σ 的上界」。
    这样同一批 take 共用一个 FFT 点数，整批只有一组；m_floor 只取决于这个任务自己的参数，不取决于同批的其他任务，
    所以同一个任务单条跑与整批跑结果一致。多出来的是静音补零，不改变声音。"""
    vary = float(kw.get("vary", 0.0))
    if vary > 0.0 and kw.get("eq_db") is None and kw.get("m_floor") is None:
        dur_hi = float(kw.get("dur", 1.0)) * math.exp(2.0 * core.VARY_DUR * vary)  # 抖动的标准正态夹在 ±2
        n_hi = max(DEC * 8, int(round(model.n_orig * dur_hi)))
        kw["m_floor"] = core._choose_m_base(n_hi, pad_ms=kw.get("pad_ms", 40.0), sr=model.sr)[0]
    return core.plan(model, **kw)


def render(model: ERBModel, *, host_noise: bool = False, **kw) -> np.ndarray:
    """core.render 的 GPU 版（参数相同）。"""
    return execute(model, [plan(model, **kw)], host_noise=host_noise)[0]


def render_many(jobs: Sequence[tuple[ERBModel, dict]], *, host_noise: bool = False, max_chunk: Optional[int] = None) -> list[np.ndarray]:
    """[(模型, plan 参数)] → 成品列表（顺序同输入）。同一个模型的 take 一起上 GPU，不同模型各自成组。"""
    plans = [(m, plan(m, **kw)) for m, kw in jobs]
    by_model: dict[int, list[int]] = {}
    for i, (m, _) in enumerate(plans):
        by_model.setdefault(id(m), []).append(i)
    res: list = [None] * len(plans)
    for idxs in by_model.values():
        ys = execute(plans[idxs[0]][0], [plans[i][1] for i in idxs], host_noise=host_noise, max_chunk=max_chunk)
        for i, y in zip(idxs, ys):
            res[i] = y
    return res


if __name__ == "__main__":
    print("nvcc:", _nvcc())
    so = build(force="--force" in sys.argv)
    print("库:", so)
    print("GPU 空闲显存 MB:", free_mem() // (1 << 20))
