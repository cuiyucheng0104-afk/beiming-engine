"""人物姿态拟合：把读点代理读的 2D 人体关键点（data/picks_v2.json）拟合成骨架姿态（human.py）。
    python3.14 fit_pose.py      → data/poses.json + 终端残差表
每个关键帧：已知该镜头相机（data/cams.json），优化 22 个姿态参数，使关键点投影贴合读点。
单目看不出深度，所以骨盆位置用世界模型（world.brian_f / 多姆座位）作先验（σ=0.5 m），
关节角朝该时刻的"状态姿势"（车顶蹲/腾空/趴/坐/驾驶）收拢（σ=45°），并且和上一关键帧连续（σ=20°）。
读点里左右分不清（_a/_b）时，两种对应都试，取代价小的。"""
import json
import math

import numpy as np
from scipy.optimize import least_squares

import calib as cb
import cammodel as cm
import human as hm
import world as wd

SIG = {"高": 4.0, "中": 8.0, "低": 16.0}
KP = set(hm.NAMES)
cams = json.load(open("data/cams.json"))
import picks_io  # noqa: E402
src = picks_io.all_shots()


def cam_at(f):
    k = cb.shot_of(f)
    r = next(r for r in cams[k]["keys"] if r[0] == f)
    return r[1:4], r[4], r[5], r[6], r[7]


from poses import dom_pelvis, state_of  # noqa: E402


# v3：逐镜头姿态约束。UPRIGHT：胸像特写，身体直立（俯仰/侧滚收紧）；LIMBS_FIXED：四肢不在画面里，用默认驾驶姿势
UPRIGHT = {"S12", "S14", "S16", "S24"}   # S22 是身体朝前、扭头回看，靠五官读点定头向
LIMBS_FIXED = {"S06"}
PELVIS_SIG = {"S01": 0.12, "S24": 0.3, "S12": 0.15, "S14": 0.15, "S16": 0.15}   # 胸像：骨盆钉在机位假设的位置附近；S01 开场钉在驾驶室旁（v5：不让拟合把人推进车厢）
DOM_PELVIS_SIG = 0.12                              # 多姆坐在驾驶座上，骨盆基本不动
PELVIS_ZMIN = {"S20": 1.0, "S19": 0.95}           # 趴在尾部甲板上：骨盆不低于甲板面（v5：防穿进车身）
# 开场卡车嵌在车厢里：布莱恩的躯干必须在车厢侧壁（Y=-1.6）外面。画面位置照读点，深度沿视线挪——
# 这正是拍摄时"人物位置为构图挪动"的处理方式（v5）
OUTSIDE_CAR = {"S01", "S03", "S04", "S07", "S08", "S09"}

ALIAS = {"brian": "pelvis", "brian_pelvis": "pelvis", "brian_head": "head", "dom": "pelvis", "dom_head": "head"}


def fit_frame(who, f, picks, q_prev=None):
    pos, yaw, pitch, roll, hfov = cam_at(f)
    p0, yaw0, pit0, pose0 = state_of(who, f)
    base = hm.pose_q(p0, yaw0, pose0, pitch=pit0)
    pts = [(ALIAS.get(p["name"], p["name"]), np.array([p["u"], p["v"]]), SIG[p["conf"]]) for p in picks]
    # 左右分不清的 _a/_b：枚举对应
    amb = sorted({n[:-2] for n, *_ in pts if n.endswith(("_a", "_b")) and n[:-2] + "_l" in KP})
    best = None
    for swap in range(2 ** len(amb)):
        mp = {}
        for i, b in enumerate(amb):
            s = (swap >> i) & 1
            mp[b + "_a"], mp[b + "_b"] = (b + "_l", b + "_r") if not s else (b + "_r", b + "_l")
        use = [(mp.get(n, n), uv, sg) for n, uv, sg in pts if mp.get(n, n) in KP]
        if not use:
            return None
        def res(q):
            J = hm.fk(q)
            P = np.array([J[n] for n, _, _ in use])
            uv = cm.project(P, pos, yaw, pitch, roll, hfov)
            r = [np.nan_to_num((uv[i] - u) / sg, nan=50.0) for i, (_, u, sg) in enumerate(use)]
            r = list(np.ravel(r))
            r += list((q[0:3] - p0) / (DOM_PELVIS_SIG if who == "dom" else PELVIS_SIG.get(cb.shot_of(f), 0.5)))
            if who == "brian" and cb.shot_of(f) in OUTSIDE_CAR and wd.T_of(f) < wd.P["jump"][0]:
                J_ = hm.fk(q)
                for jn in ("pelvis", "neck", "head"):
                    r.append(max(0.0, J_[jn][1] + 1.85) / 0.03)
            zmin = PELVIS_ZMIN.get(cb.shot_of(f)) if who == "brian" else None
            if zmin is not None and wd.T_of(f) > wd.P["jump"][1]:
                r.append(max(0.0, zmin - q[2]) / 0.02)
            ref = q_prev if q_prev is not None else base
            r += list((q[3:6] - ref[3:6]) / 60.0)
            r += list((q[6:] - base[6:]) / 45.0)
            if q_prev is not None:
                r += list((q[6:] - q_prev[6:]) / 25.0)
            return np.array(r)
        x0 = q_prev.copy() if q_prev is not None else base.copy()
        x0[0:3] = p0
        lo = np.r_[[-np.inf] * 3, -720, -100, -90, -30, -40, -110, -40, -60, -40, 0, -60, -40, 0, -40, -30, 0, -40, -30, 0]
        hi = np.r_[[np.inf] * 3, 720, 100, 90, 90, 40, 110, 60, 180, 120, 150, 180, 120, 150, 130, 60, 160, 130, 60, 160]
        shot = cb.shot_of(f)
        if shot in UPRIGHT:                               # 身体俯仰 ±25°、侧滚 ±10°；正脸朝镜头（±70°），避免拟合成背对
            lo[4], hi[4], lo[5], hi[5] = -10, 15, -10, 10
            lo[6], hi[6], lo[9], hi[9] = -10, 15, -20, 15    # 三个前倾角合计 ≤45°，否则拟合成埋头、镜头只看到头顶   # 胸像：脊柱前屈 ≤25°、低头 ±30°（否则会拟合成埋头，镜头只看到头顶）
            face = yaw + 180.0
            lo[3], hi[3] = face - 70, face + 70
            x0[3] = face
        if shot in LIMBS_FIXED:                           # 四肢钉在默认驾驶姿势
            lo[10:], hi[10:] = base[10:] - 1e-3, base[10:] + 1e-3
        x0 = np.clip(x0, lo + 1e-6, hi - 1e-6)
        r = least_squares(res, x0, bounds=(lo, hi), loss="soft_l1", f_scale=2.0, max_nfev=400)
        if best is None or r.cost < best[0].cost:
            best = (r, use)
    r, use = best
    J = hm.fk(r.x)
    uv = cm.project(np.array([J[n] for n, _, _ in use]), pos, yaw, pitch, roll, hfov)
    err = [float(np.linalg.norm(uv[i] - u)) for i, (_, u, _) in enumerate(use)]
    return r.x, err


def main():
    out = {"brian": [], "dom": []}
    report = []
    for s in src:
        shot = s["shot"]
        for k in s["keys"]:
            for who in ("brian", "dom"):
                ps = [p for p in k["picks"] if ALIAS.get(p["name"], p["name"]) in KP or p["name"][:-2] + "_l" in KP]
                if who == "dom" and shot not in ("S02", "S05", "S06"):
                    continue
                if who == "brian" and shot in ("S02", "S05", "S06"):
                    continue
                if len(ps) < 1:
                    continue
                prev = out[who][-1] if out[who] and cb.shot_of(out[who][-1][0]) == shot else None
                r = fit_frame(who, k["frame"], ps, np.array(prev[1:]) if prev else None)
                if r is None:
                    continue
                q, err = r
                out[who].append([k["frame"], *[round(float(v), 4) for v in q]])
                report.append((shot, k["frame"], who, len(err), float(np.median(err)), float(np.max(err))))
    for who in out:
        out[who].sort()
    json.dump(out, open("data/poses.json", "w"))
    print(" 镜头  帧   人物   点数  中位px  最大px")
    for r in report:
        print(f" {r[0]}  {r[1]:3d}  {r[2]:5s}  {r[3]:3d}  {r[4]:6.1f}  {r[5]:6.1f}")
    allm = [r[4] for r in report]
    print(f"共 {len(report)} 个关键帧，逐帧中位误差的中位 {np.nanmedian(allm):.1f}px")


if __name__ == "__main__":
    main()
