"""逐帧人物姿态：有拟合关键帧的镜头用拟合值（镜头内插值），其余帧按世界状态给默认姿势。build.py / verify.py 共用。"""
import json
import math
import os

import numpy as np

import calib as cb
import human as hm
import world as wd

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    KEYS = json.load(open(os.path.join(HERE, "data/poses.json")))
except FileNotFoundError:
    KEYS = {"brian": [], "dom": []}


def dom_pelvis(f):
    x, y, yaw = wd.corvette_f(f)
    a = math.radians(yaw)
    lx, ly, lz = -0.45, 0.38, 0.5
    return np.array([x + lx * math.cos(a) - ly * math.sin(a), y + lx * math.sin(a) + ly * math.cos(a), lz]), yaw


SHOT_STATE = {
    # v3：S24 他在后甲板上跪趴、双手握防滚架上沿（不在副驾座位）
    "S24": ((-1.3, -0.15, 0.95), 0.0, 25.0, "kneel"),
}


def state_of(who, f):
    """该帧默认状态：(骨盆位置, 朝向 yaw, 身体 pitch, 姿势名)"""
    shot = cb.shot_of(f)
    if who == "brian" and shot in SHOT_STATE:
        (lx, ly, lz), dyaw, pit, name = SHOT_STATE[shot]
        x, y, yaw = wd.corvette_f(f)
        a = math.radians(yaw)
        return np.array([x + lx * math.cos(a) - ly * math.sin(a), y + lx * math.sin(a) + ly * math.cos(a), lz]), yaw + dyaw, pit, name
    if who == "dom":
        p, yaw = dom_pelvis(f)
        return p, yaw, 0.0, "drive"
    T = wd.T_of(f)
    p = np.array(wd.brian_f(f))
    sl = wd.brian_shot_local(f)
    if sl:
        _, _, cvyaw0 = wd.corvette_f(f)
        return p, wd.P.get("embed_yaw", 0.0), 0.0, sl[1]
    j0, j1 = wd.P["jump"]
    _, _, cvyaw = wd.corvette_f(f)
    if T < j0 - 0.4:
        return p, (90.0 if T > wd.P["t_crash"] - 3.5 else 0.0), 0.0, "crouch"   # 车顶蹲着；临近跳车转身朝火车外侧
    if T < j0:
        return p, -90.0, 20.0, "crouch"
    if T < j1:
        return p, -60.0, 40.0, "leap"
    if T < j1 + 0.9:
        return p, cvyaw, 90.0, "prone"                                           # 趴在尾部甲板，头朝车头
    return p, cvyaw, 0.0, "seated"


def default_q(who, f):
    p, yaw, pit, name = state_of(who, f)
    if name == "crouch" and not wd.brian_shot_local(f):
        p = p + np.array([0, 0, -0.35])        # 蹲姿骨盆比"骨盆位置"先验低（分段站位里已经是骨盆高度）
    return hm.pose_q(p, yaw, name, pitch=pit)


def _base_pelvis(who, f):
    return state_of(who, f)[0]


def _smoothed(who, shot):
    """镜头内的姿态关键帧：骨盆存成相对默认位置的偏差，关节角和偏差做 1-2-1 时间平滑（v5：去拟合噪声造成的抖动）"""
    key = (who, shot)
    if key in _CACHE:
        return _CACHE[key]
    ks = sorted(r for r in KEYS.get(who, []) if cb.shot_of(r[0]) == shot)
    rows = []
    for r in ks:
        q = np.array(r[1:], float)
        q[0:3] = q[0:3] - _base_pelvis(who, r[0])
        rows.append((r[0], q))
    if len(rows) >= 3:
        sm = []
        for i, (f, q) in enumerate(rows):
            a_ = rows[max(0, i - 1)][1]; c_ = rows[min(len(rows) - 1, i + 1)][1]
            sm.append((f, 0.25 * a_ + 0.5 * q + 0.25 * c_))
        rows = sm
    _CACHE[key] = rows
    return rows


_CACHE = {}


def q_at(who, f):
    """镜头内有拟合关键帧：关节角和骨盆偏差做三次样条插值（v5），骨盆 = 当帧默认位置 + 偏差，
    这样关键帧之间、之外的帧，人也跟着卡车/科尔维特走。"""
    k = cb.shot_of(f)
    ks = _smoothed(who, k)
    if not ks:
        return default_q(who, f)
    if f <= ks[0][0]:
        q = ks[0][1].copy()
    elif f >= ks[-1][0]:
        q = ks[-1][1].copy()
    else:
        i = max(j for j in range(len(ks)) if ks[j][0] <= f)
        f1, p1 = ks[i]; f2, p2 = ks[i + 1]
        f0, p0 = ks[i - 1] if i > 0 else (f1 - (f2 - f1), 2 * p1 - p2)
        f3, p3 = ks[i + 2] if i + 2 < len(ks) else (f2 + (f2 - f1), 2 * p2 - p1)
        t = (f - f1) / (f2 - f1)
        m1 = (p2 - p0) / (f2 - f0) * (f2 - f1)
        m2 = (p3 - p1) / (f3 - f1) * (f2 - f1)
        t2, t3 = t * t, t * t * t
        q = (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2
    q = q.copy()
    q[0:3] = q[0:3] + _base_pelvis(who, f)
    return q
