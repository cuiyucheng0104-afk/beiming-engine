# -*- coding: utf-8 -*-
"""北冥 GPU 声音引擎：96 带 ERB 再合成。core.py 是 CPU 参考实现，gpu.py + erb_cuda.cu 是 GPU 执行器；用法见 README.md。"""
import warnings

from . import core, gpu  # noqa: F401
from .core import *  # noqa: F401,F403


def render_many(jobs, device: str = "auto", **kw):
    """[(模型, render 的参数字典)] → 成品列表（顺序同输入）。
    device：'auto' 有可用的 nvcc 与 GPU 就整批上 GPU，否则逐条走 CPU；'gpu' 没有 GPU 时报 GpuError；'cpu' 强制 CPU。
    GPU 与 CPU 用的随机数不是同一组（见 README），但同一个任务在同一台设备上每次结果相同。"""
    if device not in ("auto", "gpu", "cpu"):
        raise ValueError(f"device 只能是 'auto' / 'gpu' / 'cpu'，收到 {device!r}")
    if device == "gpu" and not gpu.available():
        raise gpu.GpuUnavailable("没有可用的 nvcc 或 GPU")
    if device != "cpu" and gpu.available():
        try:
            return gpu.render_many(jobs, **kw)
        except gpu.GpuOutOfMemory:  # 单条就超出显存（几十秒的长环境床）：auto 退回 CPU，gpu 照实报错
            if device == "gpu":
                raise
            warnings.warn("显存不够放下其中一条，这一批退回 CPU", RuntimeWarning, stacklevel=2)
    return [core.render(m, **a) for m, a in jobs]
