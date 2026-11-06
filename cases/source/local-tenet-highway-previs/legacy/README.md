# legacy：旧版方案，只留作参考，不再维护

- `build_v1_handkeyed.py`：v1 目测手调关键帧版。
- `physics_sim.py` / `fit_align.py`：v2 的 Bullet 刚体模拟 + 平移/时间偏移拟合（中位误差 20px，三维翻滚对不上原片，v3 起弃用）。

这些脚本按 30fps 时间轴写，依赖的旧接口（`ground_track` 里的标定常量和读点）已经并入 `calib.py` / `flip_keys.py`，直接运行会报错。
