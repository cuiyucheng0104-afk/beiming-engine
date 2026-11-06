"""主时间轴上的世界状态（纯 Python）：给主时间 T（秒）返回各物体位姿。
剪辑帧 f 属于镜头 S 时，T = (f-1)/24 + 该镜头的时间偏移 offset[S]（镜头之间可以重叠或跳时）。
参数在 data/world_params.json，由 fit_world.py 从读点拟合；这里只放运动模型。"""
import json
import math
import os

import calib as cb

HERE = os.path.dirname(os.path.abspath(__file__))
G = 9.81


def load():
    return json.load(open(os.path.join(HERE, "data/world_params.json")))


P = load()


def T_of(f, p=None):
    """剪辑帧 → 主时间。慢镜头（rate<1）里世界时间走得比剪辑慢。"""
    p = p or P
    k = cb.shot_of(f)
    a = cb.SHOTS[k][0]
    return (a - 1) / cb.FPS + p["offset"].get(k, 0.0) + p.get("rate", {}).get(k, 1.0) * (f - a) / cb.FPS


def ref_x(T, p=None):
    """参考点：卡车车头的 X（随火车匀速；撞击时刻 t_crash 为 0）。撞后火车照常前进，参考点继续随火车走。"""
    p = p or P
    return p["v_train"] * (T - p["t_crash"])


def train_front_x(T, p=None):
    p = p or P
    return ref_x(T, p) + p["truck_to_front"]


def car_span(i, T, p=None):
    """第 i 节车厢（0 = 车头）X 范围 [后, 前]。"""
    f = train_front_x(T, p) - i * (cb.CAR_LEN + cb.CAR_GAP)
    return f - cb.CAR_LEN, f


def _interp(keys, T):
    """keys: [[T, a, b, ...], ...]，按 T 线性插值，两端外推保持。"""
    if T <= keys[0][0]:
        return keys[0][1:]
    for k0, k1 in zip(keys, keys[1:]):
        if T <= k1[0]:
            s = (T - k0[0]) / (k1[0] - k0[0])
            return [a + (b - a) * s for a, b in zip(k0[1:], k1[1:])]
    return keys[-1][1:]


def _smooth(keys, T, w=0.15):
    """对线性插值做 ±w 秒的盒式平均，去掉折角（等效 C1 连续）。"""
    n = 7
    acc = None
    for k in range(n):
        v = _interp(keys, T - w + 2 * w * k / (n - 1))
        acc = v if acc is None else [a + b for a, b in zip(acc, v)]
    return [a / n for a in acc]


def corvette(T, p=None):
    """科尔维特车身中心 (x, y)、航向 yaw（度）。keys 存的是 [T, 相对卡车车头的 dx, y]。"""
    p = p or P
    dx, y = _smooth(p["cv_keys"], T)
    dt = 0.05
    dx2, y2 = _smooth(p["cv_keys"], T + dt)
    vx = p["v_train"] + (dx2 - dx) / dt
    vy = (y2 - y) / dt
    yaw = math.degrees(math.atan2(vy, max(vx, 1.0)))     # 科尔维特一直向前开：速度方向不会朝后
    return ref_x(T, p) + dx, y, max(-60.0, min(60.0, yaw))


def corvette_f(f, p=None):
    """剪辑帧 f 上的科尔维特。该镜头有逐帧实测轨迹（cv_track，来自逐镜头求解，含航向）时直接用实测——
    统一世界和它的差就是这个镜头的作弊量；没有实测轨迹时用统一世界 + 首末关键帧作弊量。"""
    p = p or P
    tr = p.get("cv_track", {}).get(cb.shot_of(f))
    if tr:
        if f <= tr[0][0]:
            return tuple(tr[0][1:])
        if f >= tr[-1][0]:
            return tuple(tr[-1][1:])
        for a, b in zip(tr, tr[1:]):
            if a[0] <= f <= b[0]:
                s = (f - a[0]) / (b[0] - a[0])
                dyaw = (b[3] - a[3] + 180) % 360 - 180
                return a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, a[3] + dyaw * s
    x, y, yaw = corvette(T_of(f, p), p)
    ch = p.get("cv_cheat", {}).get(cb.shot_of(f))
    if ch:
        (f0, dx0, dy0), (f1, dx1, dy1) = ch[0], ch[-1]
        s = 0.0 if f1 == f0 else min(1.0, max(0.0, (f - f0) / (f1 - f0)))
        x, y = x + dx0 + (dx1 - dx0) * s, y + dy0 + (dy1 - dy0) * s
    return x, y, yaw


try:
    BLAST = json.load(open(os.path.join(HERE, "data/blast.json")))
except FileNotFoundError:
    BLAST = None


# 爆炸后各块碎片：位置用 fit_blast.py 实测抛体（S21 特征点）；翻转角速度画面里读不全，按画面估【推断】
SPIN = {"dbr": (-110.0, 60.0), "box": (-200.0, 0.0), "pnl": (-260.0, 0.0), "tire": (0.0, 400.0)}   # (绕横轴翻滚 °/s, 绕竖轴打转 °/s)
# 车架（S21：在端柱旁被炸起后落下）、货厢（S23：还挂在车厢上被火车拖着翻滚）、侧板、备胎
FEAT_OF = {"dbr": "p21_dbr", "box": "p23_dbr", "pnl": "p21_pnl", "tire": "p21_tire"}
HALF_H = {"dbr": 1.2, "box": 1.2, "pnl": 0.2, "tire": 0.35}       # 落地时中心离地高度


def _rot(yaw, ry):
    a, b = math.radians(yaw), math.radians(ry)
    return ((math.cos(a) * math.cos(b), -math.sin(a), math.cos(a) * math.sin(b)),
            (math.sin(a) * math.cos(b), math.cos(a), math.sin(a) * math.sin(b)),
            (-math.sin(b), 0.0, math.cos(b)))


def debris(name, T):
    """碎片位姿 (x, y, z, yaw, ry)，起爆前返回 None。
    锚点按 fit_blast 实测抛体运动（只受重力）；转动按 fit_spin 拟合的 yaw/ry 匀角速（没拟合的用 SPIN 估值）；
    中心 = 锚点 − R·锚点局部坐标。中心落到地面后整体停住。"""
    if not BLAST or T < BLAST["t_blast"]:
        return None
    q = BLAST["feat"][FEAT_OF[name]]
    rg = BLAST.get("rigid", {}).get(name)
    if rg:
        yaw0, yr, ry0, rr, anc = rg["yaw0"], rg["yaw_rate"], rg["ry0"], rg["ry_rate"], rg["anchor_local"]
    else:
        yaw0, yr, ry0, rr, anc = 0.0, SPIN[name][1], 0.0, SPIN[name][0], [0, 0, 0]
    def at(t):
        A = (q[0] + q[3] * t, q[1] + q[4] * t, q[2] + q[5] * t - 0.5 * G * t * t)
        yaw, ry = yaw0 + yr * t, ry0 + rr * t
        R = _rot(yaw, ry)
        c = tuple(A[i] - sum(R[i][j] * anc[j] for j in range(3)) for i in range(3))
        return c, yaw, ry
    t = T - BLAST["t_blast"]
    if t < BLAST.get("launch_dt", {}).get(name, 0.0):     # 侧板：起爆后约 0.25 s 才离开车斗（v3：铰链读点带 g 拟合）
        return None
    tl, step = None, 0.01
    k = 1
    while k * step <= t:                       # 过了最高点后中心低于离地高度 → 落地停住
        c, _, _ = at(k * step)
        if c[2] < HALF_H[name] and q[5] - G * k * step < 0:
            tl = k * step
            break
        k += 1
    c, yaw, ry = at(tl if tl is not None else t)
    return c[0], c[1], max(c[2], HALF_H[name] if tl is not None else -1e9), yaw, ry


def truck_pose(T, p=None):
    """卡车车架位姿 (x, y, z, yaw, pitch)，pitch 为车头抬起的负角。撞端柱抬头 → 起爆后按实测抛体飞出。"""
    p = p or P
    d = debris("dbr", T)
    if d:
        return d
    x, y, z, pitch = truck(T, p)
    return x, y, z, p.get("embed_yaw", EMBED_YAW), pitch


def truck_cheat_x(f, p=None):
    p = p or P
    return p.get("truck_cheat", {}).get(cb.shot_of(f), 0.0)


def panel_pose(T):
    return debris("pnl", T)


def tire_pose(T):
    return debris("tire", T)


def box_pose(T):
    return debris("box", T)


def brian_shot_local(f, p=None):
    """v4：开场几个镜头里布莱恩在卡车上的分段站位 → (局部坐标, 姿势名)；不在分段里返回 None"""
    p = p or P
    for a, b, loc, pose in p.get("brian_shot_local", {}).get(cb.shot_of(f), []):
        if a <= f <= b:
            return loc, pose
    return None


def brian_f(f, p=None):
    """剪辑帧 f 上的布莱恩：起跳后跟科尔维特同一份镜头作弊量（他跳向的是这个镜头里的车）。"""
    p = p or P
    T = T_of(f, p)
    sl = brian_shot_local(f, p)
    if sl:
        return truck_local(T, sl[0], p)
    x, y, z = brian(T, p)
    if T > p["jump"][0]:
        cx, cy, _ = corvette(T, p)
        fx, fy, _ = corvette_f(f, p)
        s = min(1.0, (T - p["jump"][0]) / (p["jump"][1] - p["jump"][0]))
        x, y = x + (fx - cx) * s, y + (fy - cy) * s
    return x, y, z


REAR_AXLE, FRONT_AXLE = -1.9, 3.0  # v4：双后轴（-0.6、-1.9）+ 前轴 3.0（局部 x，车身中心为原点），车斗板向后伸出后轮约 2.6 m
EMBED_YAW, EMBED_PITCH = 10.0, 6.0   # 嵌入姿态：车头朝火车偏 10°、抬头 6°（S03 第 95 帧侧面：前轮悬空约 0.6 m，后轮着地）


def _truck_R(yaw, pitch_up):
    """卡车局部 → 世界的旋转：先抬头（绕局部 y 轴，车头向上为正），再偏航"""
    a, b = math.radians(yaw), math.radians(-pitch_up)
    ca, sa, cb_, sb = math.cos(a), math.sin(a), math.cos(b), math.sin(b)
    Rz = ((ca, -sa, 0.0), (sa, ca, 0.0), (0.0, 0.0, 1.0))
    Ry = ((cb_, 0.0, sb), (0.0, 1.0, 0.0), (-sb, 0.0, cb_))
    return tuple(tuple(sum(Rz[i][k] * Ry[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def truck_embed(T, p=None):
    """撞桥前：大货车车头歪着插进车厢侧面（v4：原片开场就是嵌在车厢里被拖着走）。
    车头 X = 参考点（随火车匀速）；车身中心 Y = truck_y；后轮着地、车头抬起 EMBED_PITCH、偏 EMBED_YAW 朝火车。
    返回车身中心 (x, y, z, yaw, pitch_up)。"""
    p = p or P
    half, zc = cb.TRUCK_LEN / 2, cb.TRUCK_H / 2
    yaw, pu = p.get("embed_yaw", EMBED_YAW), p.get("embed_pitch", EMBED_PITCH)
    R = _truck_R(yaw, pu)
    # 后轮着地点（局部 (-0.35L, ·, -H/2)）在地面：解中心高度
    rear = (REAR_AXLE, 0.0, -zc)
    z = -sum(R[2][j] * rear[j] for j in range(3))
    x = ref_x(T, p) - sum(R[0][j] * (half, 0.0, 0.0)[j] for j in range(3))
    return x, p["truck_y"], z, yaw, pu


def truck(T, p=None):
    """卡车车身中心 (x, y, z) 与俯仰 pitch（度，车头抬起为负）。撞前：嵌在车厢里随火车走；
    撞上端柱后：车头被端柱挡住，绕后轮继续抬头（crash_lift 秒内再抬到 crash_pitch）。起爆后见 truck_pose()/debris()。"""
    p = p or P
    if T <= p["t_crash"]:
        x, y, z, _, pu = truck_embed(T, p)
        return x, y, z, -pu
    t = T - p["t_crash"]
    x0, y0, z0, yaw, pu0 = truck_embed(p["t_crash"], p)
    th = pu0 + (p["crash_pitch"] - pu0) * min(1.0, t / p["crash_lift"])
    half, zc = cb.TRUCK_LEN / 2, cb.TRUCK_H / 2
    a = math.radians(th)
    rx = REAR_AXLE                                   # 绕后轮着地点抬头
    front_x = ref_x(p["t_crash"], p)                   # 车头被端柱挡住
    cx = front_x - (half * math.cos(a)) * math.cos(math.radians(yaw))
    cz = zc * math.cos(a) + (-rx) * math.sin(a)
    return cx, y0, cz, -th


def truck_local(T, local, p=None):
    """卡车局部坐标 → 世界（含嵌入的偏航和抬头），给布莱恩站位用"""
    p = p or P
    x, y, z, pitch = truck(min(T, p["t_crash"]), p)
    R = _truck_R(p.get("embed_yaw", EMBED_YAW), -pitch)
    return tuple((x, y, z)[i] + sum(R[i][j] * local[j] for j in range(3)) for i in range(3))


def brian(T, p=None):
    """布莱恩骨盆位置。卡车驾驶室顶 → 抛物线跳（jump=[起跳, 落车]）→ 科尔维特上按 brian_cv_keys（局部坐标）挪到副驾。"""
    p = p or P
    j0, j1 = p["jump"]
    def on_truck(TT):
        # 开场站在驾驶室顶的笼架上（S01 第 1–7 帧；驾驶室顶局部 z≈1.75，骨盆再高约 0.95）；
        # S08 爬出驾驶室后移到车斗右侧笼架（S10/S11）
        loc = p.get("brian_on_cab", [3.0, -0.5, 2.7]) if TT < p.get("brian_to_cage", 16.6) else p["brian_on_truck"]
        return truck_local(TT, loc, p)
    def on_cv(TT):
        x, y, yaw = corvette(TT, p)
        a = math.radians(yaw)
        lx, ly, lz = _interp(p["brian_cv_keys"], TT)
        return x + lx * math.cos(a) - ly * math.sin(a), y + lx * math.sin(a) + ly * math.cos(a), lz
    if T <= j0:
        return on_truck(T)
    if T >= j1:
        return on_cv(T)
    A, B = on_truck(j0), on_cv(j1)
    D = j1 - j0
    tt = T - j0
    s = tt / D
    vz = (B[2] - A[2] + 0.5 * G * D * D) / D       # 两端点固定、只受重力的抛物线
    return A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, A[2] + vz * tt - 0.5 * G * tt * tt
