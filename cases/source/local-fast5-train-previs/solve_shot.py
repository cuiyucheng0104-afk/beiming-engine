"""逐镜头求解：用读点（data/picks.json）同时解相机和这个镜头里物体的位置。
    python3.14 solve_shot.py S21 [S04 ...]      → data/solve/Sxx.json + 终端残差表
模型：
  静态锚点：桥头近侧端柱（X=0, Y=-TRUSS_Y，竖直线）、近侧钢轨线、地平线（真无穷远）。
  火车：每个镜头一个相位参数 c0 = 画面最靠前那条车厢缝（tj1）在镜头首帧的 X，按全局车速 V 匀速前进；
        tjk 在 tj1 后方 (k-1)·(车厢长+缝)；车顶近侧边缘线 Y=-CAR_W/2、Z=CAR_H。
  卡车：相对 tj1 的固定纵向偏移 + 横向 Y（每镜头参数）。
  科尔维特：每个关键帧 (x, y, yaw)。
  相机：固定机位一组 (x,y,z,yaw,pitch,roll)；其余每个关键帧一组；hfov 每镜头一个。
初值见 INIT（由读点代理的文字估计换算）；做多次随机扰动重启，取代价最小的解。"""
import json
import math
import os
import sys

import numpy as np
from scipy.optimize import least_squares

import calib as cb
import cammodel as cm

V = 26.0                         # 全局车速初值（m/s），fit 后由 timeline.py 更新
PITCH = cb.CAR_LEN + cb.CAR_GAP
SIG = {"高": 3.0, "中": 6.0, "低": 12.0}
JOINT_Z = 0.9

# 初值：cam=(x,y,z,yaw,pitch,roll)，hfov，c0=tj1 首帧 X，cv=(x,y,yaw)
INIT = {
    "S01": dict(cam=(-130, -12, 5.5, 5, -2, 0), hfov=50, c0=-110, cam_early=(-140, -9, 1.6, 170, 0, 0), early_until=13),
    "S03": dict(cam=(-110, -19, 1.2, 60, 0, 0), hfov=75, c0=-80),
    "S04": dict(cam=(120, -90, 15, 153, -5, 0), hfov=23, c0=-60, cv=(-87, -12, 0)),
    "S07": dict(cam=(-120, -10, 0.4, 162, 6, 0), hfov=65, c0=-150, cv=(-150, -8, 0)),
    "S09": dict(cam=(-85, -5.5, 3.1, 5, -5, 0), hfov=63, c0=-60, cv=(-80, -7, 0)),
    "S11": dict(cam=(-60, -5.9, 4.3, 12, -4, 0), hfov=24, c0=-36),
    "S13": dict(cam=(-65, -5, 1.4, 8, -4, 0), hfov=32, c0=-30, cv=(-56, -6, 0)),
    "S15": dict(cam=(-38, -2.1, 3.67, 9, -9, 0), hfov=95, c0=-20),
    "S18": dict(cam=(-12, -2.1, 3.67, 9, -9, 0), hfov=95, c0=0),
    "S19": dict(cam=(-30, -18, 0.85, 97, -3, 0), hfov=60, c0=-20, cv=(-30, -8, 0)),
    "S20": dict(cam=(-12, -10.5, 1.5, 30, -13, 0), hfov=70, c0=0, cv=(-8, -8, 0)),
    "S21": dict(cam=(50, -15, 1.4, 174, 0, 0), hfov=15, c0=-20, cv=(8, -8, 180)),
    "S23": dict(cam=(-15, -11, 0.6, 17, 12, 0), hfov=68, c0=-10, cv=(-12, -8, 0)),
    "S25": dict(cam=(15, -9, 1.1, 25, 0, 0), hfov=68, c0=60),
}
STATIC = {"S07", "S21", "S23"}
# 车载刚性机位：位置 = 起点 + 速度·t（速度先验：卡车 = 车速，科尔维特略快），朝向逐关键帧
RIG = {"S11": (V, 1.5), "S13": (V, 1.5), "S15": (V, 1.5), "S18": (V, 1.5), "S03": (V + 3, 8.0), "S25": (V, 8.0)}
# 机位横向上限：S15/S18 挂在客车车厢侧面（车身外 0.2 m），卡车车载在车厢外 1.4 m 以外，其余在轨道右侧
YMAX = {"S15": -1.9, "S18": -1.9, "S11": -3.0, "S13": -3.0}
HZ_SIG = {"S15": 40.0, "S18": 40.0}                # 远山脚不等于视平线（v3）
FREE_V = {"S04"}                                   # 火车相对桥头的速度放开（v3：S04 实测约 17 m/s，疑似慢镜头）
YAW_BOUNDS = {("S01", f): (150, 190) for f in range(1, 14)}   # S01 开场 1–13 帧从卡车前方回头看（v3）
HFOV_FIX = {"S15": 95.0, "S18": 95.0}              # 门架宽度测距反推（v3），先验收紧
HFOV_SIG = {"S03": 0.15}                           # S03：前轮直径 129 px ≈ 1.07 m、距离约 6 m → hfov 约 75–83°（v3）


REREAD = {"S03", "S07", "S21", "S23", "S25"}      # v2 重读过的几何镜头只用 v2 读点


def load(shot):
    import picks_io
    d = json.load(open("data/picks.json"))
    s = next((x for x in d["shots"] if x["shot"] == shot), {"shot": shot})
    return s, picks_io.merged(shot)


class Model:
    def __init__(self, shot, v=V):
        self.shot, self.v = shot, v
        self.s, self.keys = load(shot)
        self.a = cb.SHOTS[shot][0]
        self.static = shot in STATIC
        self.init = INIT[shot]
        names = {p["name"] for k in self.keys for p in k["picks"]}
        self.has_cv = any(n.startswith("cv_") for n in names)
        self.has_tr = any(n in ("tr_fw", "tr_rw", "tr_c") for n in names)
        self.has_train = any(n.startswith(("tj", "roof", "carbot")) for n in names)
        # 参数布局
        lay = [("hfov", 1)]
        nk = 1 if self.static else len(self.keys)
        self.rig = RIG.get(shot)
        lay.append(("cam", 4 + 3 * nk if self.rig else 6 * nk))
        if self.has_train:
            lay.append(("c0", 1))
            if shot in FREE_V:
                lay.append(("vtr", 1))
        if self.has_tr:
            lay.append(("tr", 2))
        if self.has_cv:
            lay.append(("cv", 4))
        self.lay, i = {}, 0
        for k, n in lay:
            self.lay[k] = slice(i, i + n); i += n
        self.n = i

    def x0(self):
        x = np.zeros(self.n)
        x[self.lay["hfov"]] = self.init["hfov"]
        nk = 1 if self.static else len(self.keys)
        ic = self.init["cam"]
        x[self.lay["cam"]] = np.r_[ic[:3], self.rig[0], np.tile(ic[3:], nk)] if self.rig else np.tile(ic, nk)
        if "cam_early" in self.init and not self.rig and not self.static:   # S01：前段回头看，后段朝桥
            c = x[self.lay["cam"]].reshape(-1, 6)
            for kk, kf in enumerate(self.keys):
                if kf["frame"] <= self.init["early_until"]:
                    c[kk] = self.init["cam_early"]
            x[self.lay["cam"]] = c.ravel()
        if self.has_train:
            x[self.lay["c0"]] = self.init["c0"]
            if "vtr" in self.lay:
                x[self.lay["vtr"]] = V
        if self.has_tr:
            x[self.lay["tr"]] = (10.0, -3.3)
        if self.has_cv:
            cv = self.init.get("cv", (self.init["cam"][0], -8, 0))
            x[self.lay["cv"]] = (cv[0], cv[1], V, 0.0)
        return x

    def cv_at(self, x, t):
        x0, y0, vx, vy = x[self.lay["cv"]]
        return x0 + vx * t, y0 + vy * t, math.degrees(math.atan2(vy, vx))

    def cam(self, x, ki):
        if self.rig:
            p = x[self.lay["cam"]]
            t = (self.keys[ki]["frame"] - self.a) / cb.FPS
            o = p[4:].reshape(-1, 3)[ki]
            return np.r_[p[0] + p[3] * t, p[1], p[2], o]
        c = x[self.lay["cam"]].reshape(-1, 6)
        return c[0 if self.static else ki]

    def residuals(self, x, detail=False):
        hfov = x[self.lay["hfov"]][0]
        res, rows = [], []
        for ki, k in enumerate(self.keys):
            cx, cy, cz, yaw, pitch, roll = self.cam(x, ki)
            pos = np.array([cx, cy, cz])
            t = (k["frame"] - self.a) / cb.FPS
            pj = lambda P: cm.project(np.atleast_2d(P), pos, yaw, pitch, roll, hfov)
            def line_res(A, B, uv):
                A, B = np.asarray(A, float), np.asarray(B, float)
                q = pj(A + np.linspace(0, 1, 60)[:, None] * (B - A))
                q = q[~np.isnan(q).any(1) & (np.abs(q).max(1) < 2e4)]
                if len(q) < 2:
                    return 200.0
                q = q[[0, -1]]
                d = q[1] - q[0]
                n = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-9)
                return float((np.asarray(uv) - q[0]) @ n)
            vtr = x[self.lay["vtr"]][0] if "vtr" in self.lay else self.v
            xj = x[self.lay["c0"]][0] + vtr * t if self.has_train else 0.0
            if self.has_cv:
                cvx, cvy, cvyaw = self.cv_at(x, t)
                ca, sa = math.cos(math.radians(cvyaw)), math.sin(math.radians(cvyaw))
                side = 1.0 if ((cx - cvx) * -sa + (cy - cvy) * ca) > 0 else -1.0     # 近侧 = 朝相机那侧
                def cvp(lx, ly, lz):
                    return (cvx + lx * ca - ly * sa, cvy + lx * sa + ly * ca, lz)
            for p in k["picks"]:
                nm, uv, sg = p["name"], (p["u"], p["v"]), SIG[p["conf"]]
                r = None
                if nm == "portal_base":
                    r = pj((0, -cb.TRUSS_Y, 0))[0] - uv
                elif nm == "portal_far":                         # 远侧（+Y）端柱竖线
                    r = [line_res((0, cb.TRUSS_Y, 0), (0, cb.TRUSS_Y, 10), uv)]
                elif nm in ("portal_ln1", "portal_ln2"):          # 近侧端柱中线上的点（柱底被挡时用）
                    r = [line_res((0, -cb.TRUSS_Y, 0), (0, -cb.TRUSS_Y, 10), uv)]
                elif nm == "portal_top":
                    r = [line_res((0, -cb.TRUSS_Y, 0), (0, -cb.TRUSS_Y, 10), uv)]
                elif nm in ("bot_a", "bot_b") or nm.startswith("vbot"):
                    r = [line_res((0, -cb.TRUSS_Y, 0.3), (cb.BRIDGE_LEN, -cb.TRUSS_Y, 0.3), uv)]
                elif nm in ("rail_a", "rail_b"):
                    r = [line_res((cx - 2000, -cb.RAIL_GAUGE / 2, 0.16), (cx + 2000, -cb.RAIL_GAUGE / 2, 0.16), uv)]
                elif nm in ("hz_a", "hz_b"):
                    a = math.radians(yaw)
                    far = 1e5
                    A = pos + far * np.array([math.cos(a - 0.3), math.sin(a - 0.3), 0])
                    B = pos + far * np.array([math.cos(a + 0.3), math.sin(a + 0.3), 0])
                    r = [line_res(A, B, uv)]
                    sg = max(sg, HZ_SIG.get(self.shot, 15.0))  # 地平线读点常是远山脚，放宽
                elif nm.startswith("carbot"):                    # 车体下沿线（近侧侧墙底边 Z≈0.9）
                    r = [line_res((cx - 2000, -cb.CAR_W / 2, 0.9), (cx + 2000, -cb.CAR_W / 2, 0.9), uv)]
                elif (nm in ("roof_a", "roof_b") or nm.startswith("roof_m")) and self.has_train:
                    r = [line_res((cx - 2000, -cb.CAR_W / 2, cb.CAR_H), (cx + 2000, -cb.CAR_W / 2, cb.CAR_H), uv)]
                elif nm.startswith("tj") and nm[2:].isdigit():
                    kk = int(nm[2:])
                    r = pj((xj - (kk - 1) * PITCH, -cb.CAR_W / 2, JOINT_Z))[0] - uv
                elif nm in ("tr_fw", "tr_rw", "tr_c") and self.has_tr:
                    dT, ty = x[self.lay["tr"]]
                    tcx = xj + dT
                    off = {"tr_fw": (0.35, 0), "tr_rw": (-0.35, 0), "tr_c": (0, cb.TRUCK_H / 2)}[nm]
                    r = pj((tcx + off[0] * cb.TRUCK_LEN, ty - cb.TRUCK_W / 2, off[1]))[0] - uv
                elif nm in ("cv_fw", "cv_rw"):
                    lx = cb.CV_WB / 2 * (1 if nm == "cv_fw" else -1)
                    r = pj(cvp(lx, side * 0.72, 0))[0] - uv
                elif nm in ("cv_nose", "cv_tail"):
                    r = pj(cvp(cb.CV_LEN / 2 * (1 if nm == "cv_nose" else -1), 0, 0.55))[0] - uv
                elif nm == "cv_c":
                    r = pj(cvp(0, 0, 0.6))[0] - uv
                elif nm == "cv_w":
                    cs = pj(np.array([cvp(sx * cb.CV_LEN / 2, sy * cb.CV_W / 2, 0.6) for sx in (-1, 1) for sy in (-1, 1)]))
                    r = [np.nanmax(cs[:, 0]) - np.nanmin(cs[:, 0]) - p["u"]]
                    sg *= 1.5
                if r is None:
                    continue
                r = np.nan_to_num(np.atleast_1d(np.asarray(r, float)), nan=200.0)
                res.extend(r / sg)
                rows.append((k["frame"], nm, p["conf"], float(np.linalg.norm(r)), (p["u"], p["v"]), (np.asarray(uv) + r).tolist() if len(r) == 2 else None))
        # 先验：hfov 按对数弱约束到初值；相机位置/朝向弱约束到读点代理的估计；科尔维特速度接近车速
        res.append(math.log(x[self.lay["hfov"]][0] / self.init["hfov"]) / (0.05 if self.shot in HFOV_FIX else HFOV_SIG.get(self.shot, 0.4)))
        for ki in range(1 if self.static else len(self.keys)):
            ic = np.array(self.init["cam_early"] if ("cam_early" in self.init and self.keys[ki]["frame"] <= self.init["early_until"])
                          else self.init["cam"], float)
            c = self.cam(x, ki)
            res.extend((c[:2] - ic[:2]) / 25.0)
            res.append((c[2] - ic[2]) / 2.0)
            res.append(((c[3] - ic[3] + 180) % 360 - 180) / 25.0)
            res.append((c[4] - ic[4]) / 10.0)
        if self.has_cv:
            x0, y0, vx, vy = x[self.lay["cv"]]
            res.extend([(vx - V) / 12.0, vy / 4.0, (y0 + 8) / 8.0])
        for ki in range(1 if self.static else len(self.keys)):
            c = self.cam(x, ki)
            res.append(max(0.0, 0.2 - c[2]) * 10)
            res.append(c[5] / 4.0)                          # 滚转先验：除手持/航拍外机位基本水平
        if self.rig:
            res.append((x[self.lay["cam"]][3] - self.rig[0]) / self.rig[1])
            if self.shot == "S25":                      # v3：桥远端平稳移动，偏航不该逐帧跳
                o = x[self.lay["cam"]][4:].reshape(-1, 3)
                for i in range(len(o) - 1):
                    df = self.keys[i + 1]["frame"] - self.keys[i]["frame"]
                    res.append((o[i + 1, 0] - o[i, 0]) / (2.0 * df))
        if not self.static and not self.rig and len(self.keys) > 1:          # 相邻关键帧相机连续（弱）
            c = x[self.lay["cam"]].reshape(-1, 6)
            for i in range(len(c) - 1):
                df = (self.keys[i + 1]["frame"] - self.keys[i]["frame"]) / cb.FPS
                res.extend((c[i + 1, :3] - c[i, :3]) / (30.0 * df + 1.0))
        return (np.array(res), rows) if detail else np.array(res)


def solve(shot, tries=int(os.environ.get("TRIES", 16)), seed=0):
    m = Model(shot)
    rng = np.random.default_rng(seed)
    base = m.x0()
    best = None
    for t in range(tries):
        x = base.copy()
        if t:
            if m.rig:
                p = x[m.lay["cam"]]
                p[:3] += rng.normal(0, 1, 3) * [8, 3, 0.5]
                o = p[4:].reshape(-1, 3); o[:, 0] += rng.normal(0, 15); o[:, 1] += rng.normal(0, 5)
                x[m.lay["cam"]] = p
            else:
                c = x[m.lay["cam"]].reshape(-1, 6)
                c[:, :3] += rng.normal(0, 1, (len(c), 3)) * np.maximum(np.abs(c[:, :3]) * 0.3, [5, 5, 0.5])
                c[:, 3] += rng.normal(0, 25); c[:, 4] += rng.normal(0, 6)
                x[m.lay["cam"]] = c.ravel()
            x[m.lay["hfov"]] *= math.exp(rng.normal(0, 0.35))
            if m.has_train:
                x[m.lay["c0"]] += rng.normal(0, 15)
            if m.has_cv:
                x[m.lay["cv"].start:m.lay["cv"].start + 2] += rng.normal(0, 6, 2)
        lo = np.full(m.n, -np.inf); hi = np.full(m.n, np.inf)
        lo[m.lay["hfov"]], hi[m.lay["hfov"]] = 3, 110
        # 硬约束：所有几何机位都在轨道右侧（−Y），卡车车载机位在车厢外侧（Y ≤ −3）
        ymax = YMAX.get(shot, -2.0)
        cs = m.lay["cam"].start
        if m.rig:
            hi[cs + 1] = ymax
        else:
            for kk in range(1 if m.static else len(m.keys)):
                hi[cs + 6 * kk + 1] = ymax
        if m.has_cv:                                     # 科尔维特只在卡车外侧的地面上跑（不进卡车道、不到火车另一侧）
            hi[m.lay["cv"].start + 1] = -4.6
        if m.has_tr:                                     # 卡车贴在火车右侧（v3：S01/S03 曾退化到火车另一侧）
            lo[m.lay["tr"].start + 1], hi[m.lay["tr"].start + 1] = -3.6, -3.0
        for kk, kf in enumerate(m.keys):
            b_ = YAW_BOUNDS.get((shot, kf["frame"]))
            if b_ and not m.static and not m.rig:
                lo[cs + 6 * kk + 3], hi[cs + 6 * kk + 3] = b_
        if "vtr" in m.lay:
            lo[m.lay["vtr"]], hi[m.lay["vtr"]] = 5.0, 40.0
        x = np.clip(x, lo + 1e-3, hi - 1e-3)
        x[m.lay["hfov"]] = np.clip(x[m.lay["hfov"]], 3.5, 105)
        try:
            r = least_squares(m.residuals, x, bounds=(lo, hi), loss="soft_l1", f_scale=1.5, max_nfev=600)
        except Exception:
            continue
        if best is None or r.cost < best.cost:
            best = r
    res, rows = m.residuals(best.x, detail=True)
    return m, best, rows


def report(shot):
    m, r, rows = solve(shot)
    x = r.x
    errs = [rw[3] for rw in rows]
    out = {"shot": shot, "hfov": float(x[m.lay["hfov"]][0]), "static": m.static,
           "cams": [{"frame": k["frame"], "pose": [float(v) for v in m.cam(x, i)]} for i, k in enumerate(m.keys)],
           "c0": float(x[m.lay["c0"]][0]) if m.has_train else None,
           "vtr": float(x[m.lay["vtr"]][0]) if "vtr" in m.lay else None,
           "truck": [float(v) for v in x[m.lay["tr"]]] if m.has_tr else None,
           "cv": [{"frame": k["frame"], "xyyaw": [float(v) for v in m.cv_at(x, (k["frame"] - m.a) / cb.FPS)]} for i, k in enumerate(m.keys)] if m.has_cv else None,
           "cv_lin": [float(v) for v in x[m.lay["cv"]]] if m.has_cv else None,
           "median_px": float(np.median(errs)), "max_px": float(np.max(errs)),
           "rows": [{"frame": f, "name": n, "conf": c, "err": round(e, 1), "uv": uv, "pred": pr} for f, n, c, e, uv, pr in rows]}
    os.makedirs("data/solve", exist_ok=True)
    json.dump(out, open(f"data/solve/{shot}.json", "w"), ensure_ascii=False, indent=1)
    print(f"== {shot}  hfov {out['hfov']:.1f}°  中位 {out['median_px']:.1f}px  最大 {out['max_px']:.1f}px  点数 {len(rows)}  c0 {out['c0']}")
    for c in out["cams"][:: max(1, len(out["cams"]) // 3)]:
        print("   cam", c["frame"], [round(v, 1) for v in c["pose"]])
    if out["cv"]:
        for c in out["cv"]:
            print("   cv ", c["frame"], [round(v, 1) for v in c["xyyaw"]])
    if out["truck"]:
        print("   truck dT/Y", [round(v, 1) for v in out["truck"]])
    bad = [rw for rw in out["rows"] if rw["err"] > 15]
    if bad:
        print("   大残差:", ", ".join(f'{b["frame"]}:{b["name"]}({b["conf"]}) {b["err"]}' for b in bad))


if __name__ == "__main__":
    for s in sys.argv[1:]:
        report(s)
