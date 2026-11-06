"""人物骨架（纯 numpy）：22 个姿态参数 → 14 个关节的世界坐标。拟合（fit_pose.py）和建模（build.py）共用。

身体局部坐标：x 朝人物正前方、y 朝人物左手、z 朝上，原点 = 骨盆。
姿态参数（角度单位：度）：
  0-2   骨盆世界位置 x, y, z
  3-5   身体朝向 yaw（面朝方向，从 +X 逆时针）、pitch（前倾为正）、roll（向右倒为正）
  6-7   脊柱相对骨盆的前屈、侧屈
  8-9   头相对胸的左右转（向左为正）、低头（为正）
  10-12 左肩：前抬（手臂向前举为正）、外展（向外侧举为正）、肘弯
  13-15 右肩：同上
  16-18 左髋：前屈（大腿向前抬为正）、外展、膝弯
  19-21 右髋：同上
骨长按身高约 1.80 m 的成年男性取值。"""
import math

import numpy as np

BONE = dict(spine=0.50, neck=0.10, head=0.22, sh_half=0.20, upper=0.30, fore=0.28, hip_half=0.10, thigh=0.45, shin=0.45)
NAMES = ["pelvis", "neck", "head", "sh_l", "sh_r", "el_l", "el_r", "ha_l", "ha_r", "hip_l", "hip_r", "kn_l", "kn_r", "ft_l", "ft_r",
         "nose", "eye_l", "eye_r", "ear_l", "ear_r", "mouth"]
# 五官（头部局部坐标，相对头中心）：特写里决定脸朝哪
FACE = {"nose": (0.115, 0.0, -0.015), "eye_l": (0.09, 0.035, 0.03), "eye_r": (0.09, -0.035, 0.03),
        "ear_l": (-0.005, 0.085, 0.0), "ear_r": (-0.005, -0.085, 0.0), "mouth": (0.09, 0.0, -0.07)}
N_PARAM = 22

# 常用姿态（除位置和朝向外的 16 个关节角）
POSES = {
    "stand":  [0, 0, 0, 0, 10, 8, 15, 10, 8, 15, 0, 3, 5, 0, 3, 5],
    "crouch": [35, 0, 0, 10, 35, 15, 60, 35, 15, 60, 95, 10, 120, 95, 10, 120],
    "crawl":  [10, 0, 0, -30, 80, 10, 30, 80, 10, 30, 70, 10, 100, 70, 10, 100],
    "seated": [10, 0, 0, 0, 35, 10, 70, 35, 10, 70, 85, 8, 70, 85, 8, 70],
    "drive":  [5, 0, 0, 0, 55, 5, 60, 55, 5, 60, 80, 8, 60, 80, 8, 60],
    "leap":   [20, 0, 0, -10, 70, 40, 20, 70, 40, 20, 60, 15, 80, 20, 10, 30],
    "prone":  [0, 0, 0, -40, 120, 20, 30, 120, 20, 30, 0, 5, 10, 0, 5, 10],
    "kneel":  [30, 0, 0, -10, 70, 15, 40, 70, 15, 40, 10, 8, 100, 10, 8, 100],   # 跪着、上身前倾、双手前伸（S24 压在防滚架上）
}


def _rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def _ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _limb(R, root, side, lift, abd, bend, l1, l2, down=True):
    """肢体：默认沿 -z（手臂下垂 / 腿向下），先绕 y 前抬，再绕 x 外展；肘/膝在抬起平面内弯。
    手臂肘弯向前，膝盖弯向后（bend 统一为正值）。"""
    a, b, c = (math.radians(v) for v in (lift, abd, bend))
    R1 = R @ _rx(side * b) @ _ry(-a)                     # 前抬：-z 转向 +x
    d1 = R1 @ np.array([0, 0, -1.0])
    j1 = root + l1 * d1
    sgn = 1.0 if down else -1.0                          # 腿：膝向后弯（小腿往后折）；臂：肘向前弯
    R2 = R1 @ _ry(sgn * c)
    j2 = j1 + l2 * (R2 @ np.array([0, 0, -1.0]))
    return j1, j2, R1, R2


def fk(q):
    """姿态参数 → {关节名: 世界坐标}"""
    return fk_frames(q)[0]


def fk_frames(q):
    """姿态参数 → ({关节名: 世界坐标}, {部位名: 3×3 朝向矩阵})。部位局部坐标：x 朝人物前方、y 朝人物左手、z 沿骨头（四肢 z 指向关节上端）。"""
    q = np.asarray(q, float)
    P = q[0:3]
    yaw, pitch, roll = (math.radians(v) for v in q[3:6])
    R0 = _rz(yaw) @ _ry(pitch) @ _rx(roll)               # 骨盆朝向
    Rs = R0 @ _ry(math.radians(q[6])) @ _rx(math.radians(q[7]))   # 胸
    neck = P + BONE["spine"] * (Rs @ np.array([0, 0, 1.0]))
    Rh = Rs @ _rz(math.radians(q[8])) @ _ry(math.radians(q[9]))
    head = neck + (BONE["neck"] + BONE["head"] / 2) * (Rh @ np.array([0, 0, 1.0]))
    J = {"pelvis": P, "neck": neck, "head": head}
    for k_, off in FACE.items():
        J[k_] = head + Rh @ np.array(off)
    F = {"pelvis": R0, "chest": Rs, "head": Rh}
    for side, nm, i in ((1, "l", 10), (-1, "r", 13)):
        sh = neck + Rs @ np.array([0, side * BONE["sh_half"], -0.05])
        el, ha, R1, R2 = _limb(Rs, sh, side, q[i], q[i + 1], q[i + 2], BONE["upper"], BONE["fore"], down=False)
        J[f"sh_{nm}"], J[f"el_{nm}"], J[f"ha_{nm}"] = sh, el, ha
        F[f"upper_{nm}"], F[f"fore_{nm}"] = R1, R2
    for side, nm, i in ((1, "l", 16), (-1, "r", 19)):
        hip = P + R0 @ np.array([0, side * BONE["hip_half"], -0.05])
        kn, ft, R1, R2 = _limb(R0, hip, side, q[i], q[i + 1], q[i + 2], BONE["thigh"], BONE["shin"], down=True)
        J[f"hip_{nm}"], J[f"kn_{nm}"], J[f"ft_{nm}"] = hip, kn, ft
        F[f"thigh_{nm}"], F[f"shin_{nm}"] = R1, R2
    return J, F


# 人体形体（白模用，取代方块）：(部位名, 朝向矩阵, 锚点关节, 局部偏移, 椭球三轴全长 (前后, 左右, 上下), 材质槽)
# 四肢的朝向矩阵 z 轴指向关节上端（骨头沿局部 -z），所以偏移的 z 取负的半骨长
def _limbs():
    out = []
    for s_ in ("l", "r"):
        out += [
            (f"delt_{s_}", "chest", f"sh_{s_}", (0, 0, 0), (0.13, 0.14, 0.13), "shirt"),
            (f"upper_{s_}", f"upper_{s_}", f"sh_{s_}", (0, 0, -BONE["upper"] / 2), (0.105, 0.105, BONE["upper"] + 0.08), "shirt"),
            (f"fore_{s_}", f"fore_{s_}", f"el_{s_}", (0, 0, -BONE["fore"] / 2), (0.085, 0.08, BONE["fore"] + 0.06), "skin"),
            (f"hand_{s_}", f"fore_{s_}", f"ha_{s_}", (0, 0, -0.07), (0.05, 0.095, 0.17), "skin"),
            (f"thigh_{s_}", f"thigh_{s_}", f"hip_{s_}", (0, 0, -BONE["thigh"] / 2), (0.16, 0.15, BONE["thigh"] + 0.1), "pants"),
            (f"shin_{s_}", f"shin_{s_}", f"kn_{s_}", (0, 0, -BONE["shin"] / 2), (0.115, 0.11, BONE["shin"] + 0.06), "pants"),
            (f"foot_{s_}", f"shin_{s_}", f"ft_{s_}", (0.07, 0, -0.05), (0.27, 0.105, 0.09), "shoes"),
        ]
    return out


BODY = [
    ("pelvis", "pelvis", "pelvis", (0, 0, -0.03), (0.23, 0.35, 0.22), "pants"),
    ("abdomen", "chest", "pelvis", (0.01, 0, 0.17), (0.21, 0.31, 0.26), "shirt"),
    ("chest", "chest", "pelvis", (0.01, 0, 0.37), (0.25, 0.43, 0.33), "shirt"),
    ("neck", "head", "neck", (0, 0, 0.05), (0.11, 0.11, 0.14), "skin"),
    ("head", "head", "head", (0.005, 0, 0), (0.21, 0.165, 0.24), "skin"),
    ("nose", "head", "head", (0.105, 0, -0.015), (0.04, 0.03, 0.05), "skin"),
    ("ear_l", "head", "head", (-0.005, 0.085, 0.0), (0.05, 0.02, 0.06), "skin"),
    ("ear_r", "head", "head", (-0.005, -0.085, 0.0), (0.05, 0.02, 0.06), "skin"),
] + _limbs()


# 旧版方块骨段：(名字, 起点关节, 终点关节, 粗细)
SEGMENTS = [
    ("torso", "pelvis", "neck", 0.34), ("upper_l", "sh_l", "el_l", 0.11), ("upper_r", "sh_r", "el_r", 0.11),
    ("fore_l", "el_l", "ha_l", 0.09), ("fore_r", "el_r", "ha_r", 0.09), ("thigh_l", "hip_l", "kn_l", 0.15),
    ("thigh_r", "hip_r", "kn_r", 0.15), ("shin_l", "kn_l", "ft_l", 0.12), ("shin_r", "kn_r", "ft_r", 0.12),
    ("shoulders", "sh_l", "sh_r", 0.12),
]


def pose_q(pos, yaw, name, pitch=0.0, roll=0.0):
    return np.r_[pos, yaw, pitch, roll, POSES[name]]
