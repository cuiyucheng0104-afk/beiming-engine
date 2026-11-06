"""爆炸碎片的刚体转动拟合（在 fit_blast.py 之后跑）：相机、流速、质点轨迹都用 fit_blast 的结果，这里只补转动。
    python3.14 fit_spin.py      → data/blast.json 里加 "rigid"，world.debris() 读它
每块碎片：位姿 = 抛体中心（只受重力）+ 朝向 yaw(t) = yaw0 + yaw_rate·t、俯仰 ry(t) = ry0 + ry_rate·t（Blender 绕局部 Y 轴）。
  车架 dbr（S21）：锚点是拟合过的驾驶室前上角，用 dbr_c / dbr_e2 拟合转动（只转，不动锚点轨迹）。
  货厢 box（S23）：中心是拟合过的货厢中心，用 dbr_e1 / dbr_e2（货厢两端）拟合转动。
  侧板 pnl（S21）：中心轨迹和转动一起拟合，读点是侧板中心、左下铰链、左侧短边上下端。"""
import json
import math

import numpy as np
from scipy.optimize import least_squares

import calib as cb
import cammodel as cm
import fit_blast as fb

G = 9.81
B = json.load(open("data/blast.json"))
SIG = {"高": 3.0, "中": 6.0, "低": 12.0}
TB = B["t_blast"]


def T21(f):
    return fb.T_CRASH + 2 / cb.FPS + B["rate21"] * (f - 486) / cb.FPS


def T23(f):
    return TB + B["dsync23"] + B["rate23"] * (f - 585) / cb.FPS


def cam(shot, f):
    c = B["cams"]["c21" if shot == "S21" else "c23"]
    yaw, pitch = c[3], c[4]
    if shot == "S21":
        fpx = 640 / math.tan(math.radians(c[6] / 2))
        du, dv = fb.shift21(f)
        yaw, pitch = yaw + math.degrees(du / fpx), pitch + math.degrees(dv / fpx)
    return c[0:3], yaw, pitch, c[5], c[6]


def rot(yaw, ry):
    a, b = math.radians(yaw), math.radians(ry)
    Rz = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    Ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    return Rz @ Ry


def ballistic(q, t):
    return np.array(q[0:3]) + np.array(q[3:6]) * t + np.array([0, 0, -0.5 * G * t * t])


picks = {k: fb._merge(k) for k in ("S21", "S23")}


def fit(name, shot, center_fn, local_of, extra=0, x_extra0=()):
    """转动参数 [yaw0, yaw_rate, ry0, ry_rate] + 可选的中心参数（extra 个）"""
    obs = []
    for k in picks[shot]["keys"]:
        f = k["frame"]
        T = T21(f) if shot == "S21" else T23(f)
        if T < TB + 0.005:
            continue
        for p in k["picks"]:
            if p["name"] in local_of:
                obs.append((f, T - TB, local_of[p["name"]], np.array([p["u"], p["v"]]), SIG[p["conf"]] * 1.5))
    if not obs:
        return None, None

    def res(x):
        r = []
        for f, t, loc, uv, sg in obs:
            c = center_fn(t, x[4:])
            P = c + rot(x[0] + x[1] * t, x[2] + x[3] * t) @ np.array(loc)
            q = cm.project([P], *cam(shot, f))[0]
            r += list(np.nan_to_num((q - uv) / sg, nan=30.0))
        r += [x[1] / 600.0, x[3] / 900.0]                  # 角速度弱先验（≤ 两三圈每秒）
        if extra:
            r += list((x[4:7] - np.array([-2.0, -4.0, 2.0])) / 3.0)
            r += list((x[7:10] - np.array([0.0, -3.0, 8.0])) / 10.0)
        return np.array(r)
    best = None
    for yaw0 in (-90, 0, 90, 180):
        for ry0 in (-60, 0, 60):
            for rr in (-300, 0, 300):
                x0 = np.r_[yaw0, 0.0, ry0, rr, list(x_extra0)]
                lo = np.full(len(x0), -np.inf)
                if extra:
                    lo[6] = 0.5                                  # 起爆瞬间侧板中心在地面以上
                    x0[6] = max(x0[6], 0.6)
                r = least_squares(res, x0, bounds=(lo, np.inf), loss="soft_l1", f_scale=1.5, max_nfev=400)
                if best is None or r.cost < best.cost:
                    best = r
    x = best.x
    errs = []
    for f, t, loc, uv, sg in obs:
        c = center_fn(t, x[4:])
        P = c + rot(x[0] + x[1] * t, x[2] + x[3] * t) @ np.array(loc)
        errs.append(float(np.linalg.norm(cm.project([P], *cam(shot, f))[0] - uv)))
    return x, errs


def main():
    out = {}
    L, W = cb.TRUCK_LEN, cb.TRUCK_W
    # 车架：锚点 = 驾驶室前上角（fit_blast 的 p21_dbr），车身中心在锚点后下方
    a = B["feat"]["p21_dbr"]
    x, e = fit("dbr", "S21", lambda t, _: ballistic(a, t),
               {"dbr_c": (-L / 2, W / 2, -1.3), "dbr_e2": (-L, W / 2, -1.3)})
    if x is not None:
        out["dbr"] = {"anchor_local": [L / 2, -W / 2, 1.3], "yaw0": x[0], "yaw_rate": x[1], "ry0": x[2], "ry_rate": x[3], "err": e}
    # 货厢：中心 = p23_dbr；两端 ±2.25 m
    bq = B["feat"]["p23_dbr"]
    x, e = fit("box", "S23", lambda t, _: ballistic(bq, t), {"dbr_e1": (2.25, 0, 0), "dbr_e2": (-2.25, 0, 0)})
    if x is not None:
        out["box"] = {"anchor_local": [0, 0, 0], "yaw0": x[0], "yaw_rate": x[1], "ry0": x[2], "ry_rate": x[3], "err": e}
    # 侧板：中心轨迹 + 转动一起拟合（板 5.0 × 2.4 m；铰链在左下角，短边在左）
    x, e = fit("pnl", "S21", lambda t, c: ballistic(c, t),
               {"pnl_c": (0, 0, 0), "pnl_latch": (-2.5, 0, -1.2), "pnl_e1": (-2.5, 0, 1.2), "pnl_e2": (-2.5, 0, -1.2)},
               extra=6, x_extra0=B["feat"]["p21_pnl"])
    if x is not None:
        B["feat"]["p21_pnl"] = [float(v) for v in x[4:10]]
        out["pnl"] = {"anchor_local": [0, 0, 0], "yaw0": x[0], "yaw_rate": x[1], "ry0": x[2], "ry_rate": x[3], "err": e}
    for k, v in out.items():
        e = sorted(v["err"])
        print(f"{k}: 朝向 yaw0 {v['yaw0']:.0f}° 打转 {v['yaw_rate']:.0f}°/s，俯仰 ry0 {v['ry0']:.0f}° 翻滚 {v['ry_rate']:.0f}°/s；"
              f"读点误差 中位 {e[len(e) // 2]:.1f}px 最大 {e[-1]:.1f}px（{len(e)} 点）")
        v["err"] = round(e[len(e) // 2], 1)
    if "pnl" in out:
        q = B["feat"]["p21_pnl"]
        print(f"侧板抛体：起爆位置 ({q[0]:.1f}, {q[1]:.1f}, {q[2]:.1f})  初速 ({q[3]:.1f}, {q[4]:.1f}, {q[5]:.1f}) m/s  顶点高 {q[2] + max(0, q[5]) ** 2 / (2 * G):.1f} m")
    B["rigid"] = {k: {kk: (float(vv) if not isinstance(vv, list) else vv) for kk, vv in v.items()} for k, v in out.items()}
    json.dump(B, open("data/blast.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
