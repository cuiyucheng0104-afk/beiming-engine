"""撞桥爆炸联合求解：S21（长焦正面）+ S23（广角侧后）两台固定机位看的是同一次爆炸。
    python3.14 fit_blast.py      → data/blast.json、data/solve/S21.json、data/solve/S23.json（覆盖相机与科尔维特）
未知量：
  两台相机各 7 个（位置、yaw/pitch/roll、hfov）；
  S21 的慢镜头流速 rate21；S23 起爆帧相对 S21 起爆的同步误差 δ（秒）；
  卡车车架抛体：起爆瞬间重心 p0、速度 v0；长轴方位 az、仰角 φ0、翻转角速度 ω；
  货厢侧板抛体：p0、v0、方位、φ0、ω（各自独立）；
  科尔维特在两个镜头里各一段匀速直线 (x0, y0, vx, vy)，速度先验 25±6 m/s（这一条把 S21 的流速钉住）。
约束：端柱（底点 + 竖直线）、近侧钢轨/车顶/下弦杆直线、地平线、碎片中心与长轴两端、科尔维特车轮与中心。
起爆时刻：S21 第 490 帧（世界时间 = t_crash + rate21·6/24）；S23 第 585 帧 = 起爆 + δ。"""
import json
import math

import numpy as np
from scipy.optimize import least_squares

import calib as cb
import cammodel as cm

G = 9.81
SIG = {"高": 3.0, "中": 6.0, "低": 12.0}
T_CRASH = (484 - 1) / cb.FPS
def _merge(shot):
    import picks_io
    return {"shot": shot, "keys": picks_io.merged(shot)}


picks = {k: _merge(k) for k in ("S21", "S23")}
old = {k: json.load(open(f"data/solve/{k}.json")) for k in ("S21", "S23")}


# S21 不是固定机位（v2 重读：背景相位相关）：相对 486 帧整幅画面的平移 (du, dv)，先摇后仰。读点先减去它，折算回 486 帧的机位
SHIFT21 = {486: (0, 0), 488: (-3.1, 1.3), 490: (-6.6, 2.8), 492: (-11.1, 4.4), 494: (-15.1, 6.3), 496: (-18.7, 7.6), 498: (-22.7, 8.8),
           500: (-26.8, 9.8), 502: (-30.6, 10.8), 504: (-35.1, 11.2), 506: (-39.6, 11.6), 508: (-44.0, 11.4), 510: (-47.7, 10.7),
           512: (-49.8, 9.9), 514: (-51.8, 10.0), 516: (-53.2, 9.4), 518: (-53.7, 9.8), 520: (-53.0, 10.5), 522: (-53.3, 12.3),
           524: (-51.9, 15.6), 526: (-49.6, 20.5), 528: (-48.1, 26.2), 530: (-45.6, 31.5), 532: (-43.3, 37.2), 534: (-42.4, 43.0),
           536: (-39.4, 47.9), 538: (-37.0, 54.4), 540: (-35.9, 60.7)}


def shift21(f):
    ks = sorted(SHIFT21)
    if f <= ks[0]:
        return np.array(SHIFT21[ks[0]])
    for a, b in zip(ks, ks[1:]):
        if f <= b:
            s = (f - a) / (b - a)
            return np.array(SHIFT21[a]) + s * (np.array(SHIFT21[b]) - np.array(SHIFT21[a]))
    return np.array(SHIFT21[ks[-1]])


# 碎片特征点：每个各走一条抛物线（起爆瞬间位置 + 速度，只受重力）。同一块碎片在两个机位里读的不是同一个点，所以分开，
# 但共用时间轴（S21 流速、S23 同步），起点先验都在端柱旁的卡车上 → 这样 S21 的慢镜头倍速由"下落加速度必须是 g"钉住
# 侧板只读到了左下角铰链：侧板一边飞一边转，角点不走抛物线，按质点拟合会把机位和流速一起带偏 → 不参与拟合
FEAT = {("S21", "tire_c"): "p21_tire", ("S21", "dbr_e1"): "p21_dbr", ("S23", "dbr_c"): "p23_dbr"}
LAY = [("c21", 7), ("c23", 7), ("rate", 1), ("rate23", 1), ("dsync", 1)] + [(v, 6) for v in FEAT.values()] + [("cv21", 4), ("cv23", 4)]
SL, n = {}, 0
for k, m in LAY:
    SL[k] = slice(n, n + m); n += m
NP = n


def t21(f, x):
    return T_CRASH + (486 - 484) / cb.FPS + x[SL["rate"]][0] * (f - 486) / cb.FPS


def t_blast(x):
    return t21(490, x)


def t23(f, x):
    return t_blast(x) + x[SL["dsync"]][0] + x[SL["rate23"]][0] * (f - 585) / cb.FPS


def body(p, t):
    """抛体刚体：p = [x0,y0,z0, vx,vy,vz, az, phi0, omega]；返回中心和长轴单位向量。"""
    c = p[0:3] + p[3:6] * t + np.array([0, 0, -0.5 * G * t * t])
    az, phi = math.radians(p[6]), math.radians(p[7] + p[8] * t)
    d = np.array([math.cos(az) * math.cos(phi), math.sin(az) * math.cos(phi), math.sin(phi)])
    return c, d


def residuals(x, detail=False):
    res, rows = [], []
    for shot, ck, tf in (("S21", "c21", t21), ("S23", "c23", t23)):
        c = x[SL[ck]]
        pos, yaw, pitch, roll, hfov = c[0:3], c[3], c[4], c[5], c[6]
        pj = lambda P: cm.project(np.atleast_2d(P), pos, yaw, pitch, roll, hfov)
        def line(A, B, uv):
            A, B = np.asarray(A, float), np.asarray(B, float)
            q = pj(A + np.linspace(0, 1, 80)[:, None] * (B - A))
            q = q[~np.isnan(q).any(1) & (np.abs(q).max(1) < 3e4)]
            if len(q) < 2:
                return np.array([60.0])
            d = q[-1] - q[0]
            nrm = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-9)
            return np.array([(np.asarray(uv) - q[0]) @ nrm])
        cvp = x[SL["cv21" if shot == "S21" else "cv23"]]
        for k in picks[shot]["keys"]:
            f = k["frame"]
            T = tf(f, x)
            tb = T - t_blast(x)
            cvx, cvy = cvp[0] + cvp[2] * (T - T_CRASH), cvp[1] + cvp[3] * (T - T_CRASH)
            cyaw = math.atan2(cvp[3], cvp[2])
            ca, sa = math.cos(cyaw), math.sin(cyaw)
            def cv(lx, ly, lz):
                return (cvx + lx * ca - ly * sa, cvy + lx * sa + ly * ca, lz)
            near = 1.0 if ((pos[0] - cvx) * -sa + (pos[1] - cvy) * ca) > 0 else -1.0
            for p in k["picks"]:
                nm, uv, sg = p["name"], np.array([p["u"], p["v"]]), SIG[p["conf"]]
                if shot == "S21":
                    uv = uv - shift21(f)
                r = None
                if nm == "portal_base":
                    r = pj((0, -cb.TRUSS_Y, 0))[0] - uv
                elif nm in ("portal_top", "post_m1", "post_m2"):
                    r = line((0, -cb.TRUSS_Y, 0), (0, -cb.TRUSS_Y, 15), uv)
                elif nm in ("bot_a", "bot_b") or nm.startswith("vbot"):
                    r = line((0, -cb.TRUSS_Y, 0.3), (cb.BRIDGE_LEN, -cb.TRUSS_Y, 0.3), uv)
                elif nm in ("roof_a", "roof_b"):
                    r = line((-600, -cb.CAR_W / 2, cb.CAR_H), (pos[0] + 600, -cb.CAR_W / 2, cb.CAR_H), uv)
                elif nm in ("hz_a", "hz_b"):
                    a = math.radians(yaw)
                    r = line(pos + 1e5 * np.array([math.cos(a - .3), math.sin(a - .3), 0]), pos + 1e5 * np.array([math.cos(a + .3), math.sin(a + .3), 0]), uv)
                    sg = max(sg, 12.0)
                elif (shot, nm) in FEAT and f >= (491 if shot == "S21" else 586) and not (nm == "dbr_e1" and f < 524):
                    q = x[SL[FEAT[(shot, nm)]]]
                    P = q[0:3] + q[3:6] * tb + np.array([0, 0, -0.5 * G * tb * tb])
                    r = pj(P)[0] - uv
                    sg *= 1.5                                    # 火光里的碎片读点本来就松
                elif nm in ("cv_fw", "cv_rw"):
                    r = pj(cv(cb.CV_WB / 2 * (1 if nm == "cv_fw" else -1), near * 0.74, 0))[0] - uv
                elif nm in ("cv_fwL", "cv_fwR"):                 # 正对镜头时：画面左/右前轮
                    a = pj(cv(cb.CV_WB / 2, 0.74, 0))[0]; b = pj(cv(cb.CV_WB / 2, -0.74, 0))[0]
                    L, R = (a, b) if a[0] < b[0] else (b, a)
                    r = (L if nm == "cv_fwL" else R) - uv
                elif nm in ("cv_nose", "cv_tail"):
                    r = pj(cv(cb.CV_LEN / 2 * (1 if nm == "cv_nose" else -1), 0, 0.55))[0] - uv
                elif nm == "cv_c":
                    r = pj(cv(0, 0, 0.6))[0] - uv
                elif nm == "cv_bar":
                    r = pj(cv(-0.75, 0, 1.25))[0] - uv
                if r is None:
                    continue
                r = np.nan_to_num(np.asarray(r, float), nan=60.0)
                res.extend(r / sg)
                rows.append((shot, f, nm, float(np.linalg.norm(r)), uv.tolist(), (uv + r).tolist() if len(r) == 2 else None))
    # 先验
    for ck in ("c21", "c23"):
        c = x[SL[ck]]
        res += [c[5] / 4.0, max(0, 0.3 - c[2]) * 10]
    for ck in ("cv21", "cv23"):
        v = x[SL[ck]]
        res += [(math.hypot(v[2], v[3]) - 25.0) / 6.0, v[3] / 6.0, (v[1] + 6.5) / 3.0, (v[0] - 0.0) / 15.0]   # 撞击时刻在端柱附近、桥旁地面
    res += [x[SL["dsync"]][0] / 0.5]
    for g in FEAT.values():
        p = x[SL[g]]
        res += [(p[0] + 2.0) / 4.0, (p[1] + 3.5) / 2.5, (p[2] - 3.0) / 2.5]  # 起爆瞬间在端柱旁的卡车上（离地 1–6 m）
        # 车架/货厢还挂在车厢上被火车拖着走（S23 实测水平速度接近车速）；侧板、备胎是被炸飞的（卡车已被端柱挡停）
        v_ref = np.array([26.0, -3.0, 4.0]) if g == "p23_dbr" else np.array([0.0, -3.0, 6.0])   # 只有 S23 的货厢是被拖着走的
        res += list((p[3:6] - v_ref) / 8.0)
    return (np.array(res), rows) if detail else np.array(res)


def x0():
    x = np.zeros(NP)
    for ck, s in (("c21", "S21"), ("c23", "S23")):
        x[SL[ck]] = [*old[s]["cams"][0]["pose"], old[s]["hfov"]]
    x[SL["c23"]][6] = 50.0
    x[SL["rate"]] = 0.45
    x[SL["rate23"]] = 0.7
    for g in FEAT.values():
        x[SL[g]] = [-2.0, -3.5, 3.0, 26.0 if g == "p23_dbr" else 2.0, -3.0, 6.0]
    x[SL["cv21"]] = [0.0, -6.0, 25.0, 0.0]
    x[SL["cv23"]] = [-10.0, -6.0, 25.0, 0.0]
    return x


def main():
    rng = np.random.default_rng(1)
    lo, hi = np.full(NP, -np.inf), np.full(NP, np.inf)
    for ck in ("c21", "c23"):
        s = SL[ck].start
        lo[s + 6], hi[s + 6] = 3, 110
        hi[s + 1] = -2.0
    lo[SL["rate"]], hi[SL["rate"]] = 0.1, 1.2
    lo[SL["rate23"]], hi[SL["rate23"]] = 0.1, 1.2
    for g in FEAT.values():
        lo[SL[g].start + 2] = 0.5                         # 起爆瞬间在地面以上
    best = None
    for t in range(int(__import__('os').environ.get('TRIES', 12))):
        x = x0()
        if t == 0 and __import__("os").path.exists("data/blast_seed.json"):   # 第 0 次：从上一轮自洽解热启动
            sd = json.load(open("data/blast_seed.json"))
            for k_, v_ in sd.items():
                if k_ in SL:
                    x[SL[k_]] = v_
        if t:
            for ck in ("c21", "c23"):
                c = x[SL[ck]]
                c[:3] += rng.normal(0, 1, 3) * [8, 4, 0.5]; c[3] += rng.normal(0, 10); c[6] *= math.exp(rng.normal(0, 0.4))
            x[SL["rate"]] = rng.uniform(0.2, 1.0)
            x[SL["rate23"]] = rng.uniform(0.2, 1.0)
            for g in FEAT.values():
                x[SL[g]][3:6] += rng.normal(0, 4, 3)
        x = np.clip(x, lo + 1e-6, hi - 1e-6)
        r = least_squares(residuals, x, bounds=(lo, hi), loss="soft_l1", f_scale=1.5, max_nfev=1500)
        if best is None or r.cost < best.cost:
            best = r
    x = best.x
    print(f"总代价 {best.cost:.1f}")
    _, rows = residuals(x, detail=True)
    errs = {}
    for shot, f, nm, e, *_ in rows:
        errs.setdefault((shot, nm), []).append(e)
    print(f"S21 流速 = {x[SL['rate']][0]:.3f}，S23 流速 = {x[SL['rate23']][0]:.3f}（世界时间/剪辑时间），S23 同步误差 δ = {x[SL['dsync']][0]:+.3f} s")
    for ck in ("c21", "c23"):
        c = x[SL[ck]]
        print(f"  {ck} 相机 位置 ({c[0]:.1f}, {c[1]:.1f}, {c[2]:.2f})  yaw {c[3]:.1f} pitch {c[4]:.1f} roll {c[5]:.1f}  hfov {c[6]:.1f}")
    for g in FEAT.values():
        p = x[SL[g]]
        print(f"  {g} 起爆位置 ({p[0]:.1f}, {p[1]:.1f}, {p[2]:.1f})  初速 ({p[3]:.1f}, {p[4]:.1f}, {p[5]:.1f}) = {np.linalg.norm(p[3:6]):.1f} m/s  顶点高 {p[2] + max(0, p[5]) ** 2 / (2 * G):.1f} m")
    for k in ("cv21", "cv23"):
        v = x[SL[k]]
        print(f"  {k} 科尔维特 撞击时刻位置 ({v[0]:.1f}, {v[1]:.1f}) 速度 ({v[2]:.1f}, {v[3]:.1f})")
    print("  分组残差（中位/最大 px，点数）：")
    for (shot, g), e in sorted(errs.items()):
        print(f"    {shot} {g:8s} {np.median(e):6.1f} {np.max(e):6.1f}  {len(e)}")
    out = {"rate21": float(x[SL["rate"]][0]), "rate23": float(x[SL["rate23"]][0]), "dsync23": float(x[SL["dsync"]][0]), "t_blast": float(t_blast(x)),
           "feat": {g: [float(v) for v in x[SL[g]]] for g in FEAT.values()},
           "cv21": [float(v) for v in x[SL["cv21"]]], "cv23": [float(v) for v in x[SL["cv23"]]],
           "cams": {ck: [float(v) for v in x[SL[ck]]] for ck in ("c21", "c23")},
           "rows": [{"shot": s, "frame": f, "name": n, "err": round(e, 1), "uv": uv, "pred": pr} for s, f, n, e, uv, pr in rows]}
    out["feat"]["p21_pnl"] = [-2.4, -4.7, 1.5, 1.0, -3.5, 12.0]   # 侧板没有可拟合的质点读点：按画面（S21 518 帧竖在火球上方）估【推断】
    json.dump(out, open("data/blast.json", "w"), ensure_ascii=False, indent=1)
    write_back(out)


def write_back(B):
    """把联合拟合的 S21/S23 相机（S21 叠加逐帧摇/仰）和科尔维特匀速段写回 data/solve/，timeline.py 从那里取。"""
    tb = B["t_blast"]
    def t21(f):
        return T_CRASH + 2 / cb.FPS + B["rate21"] * (f - 486) / cb.FPS
    def t23(f):
        return tb + B["dsync23"] + B["rate23"] * (f - 585) / cb.FPS
    for shot, ck, cvk, tf, frames in (("S21", "c21", "cv21", t21, range(486, 541)), ("S23", "c23", "cv23", t23, range(569, 615))):
        c = B["cams"][ck]
        fpx = 640 / math.tan(math.radians(c[6] / 2))
        cams, cvs = [], []
        for f in frames:
            yaw, pitch = c[3], c[4]
            if shot == "S21":
                du, dv = shift21(f)
                yaw, pitch = yaw + math.degrees(du / fpx), pitch + math.degrees(dv / fpx)
            cams.append({"frame": f, "pose": [c[0], c[1], c[2], yaw, pitch, c[5]]})
            v, TT = B[cvk], tf(f)
            cvs.append({"frame": f, "xyyaw": [v[0] + v[2] * (TT - T_CRASH), v[1] + v[3] * (TT - T_CRASH), math.degrees(math.atan2(v[3], v[2]))]})
        sv = json.load(open(f"data/solve/{shot}.json"))
        e = sorted(r["err"] for r in B["rows"] if r["shot"] == shot)
        sv.update({"hfov": c[6], "static": False, "cams": cams, "cv": cvs, "src": "fit_blast 联合求解", "median_px": e[len(e) // 2]})
        json.dump(sv, open(f"data/solve/{shot}.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
